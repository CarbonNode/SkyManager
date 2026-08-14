#include "item_icons.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp, logger and
// Windows.h (via PrismaUI_API.h). SEH (__try) needs no extra include.

#include <atomic>
#include <cctype>
#include <cmath>
#include <chrono>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>
#include <unordered_set>
#include <vector>

namespace ItemIcons
{
	namespace
	{
		/* ── tunables — inherited from portraits.cpp's measured numbers ────── */

		// An item icon is a 44px row face and at most a card thumbnail; 512 is
		// already generous (portraits.cpp measured ~6s per 512 render).
		constexpr std::uint32_t kSize = 512;

		// Each in-flight mesh costs a full offscreen scene render per frame.
		// A 41-piece inventory is a background trickle, not a burst.
		constexpr std::size_t kMaxInFlight = 2;
		constexpr std::size_t kMaxQueued   = 512;

		// The framework renders nothing while one of ITS OWN four skip-menus is
		// open (see FrameworkBlocked); past this we free the mesh (an un-drawn
		// mesh re-renders every frame forever) and allow a later retry. The
		// clock is PAUSED while the framework is blocked — a 30 s wall-clock
		// leash that ticks while the framework is deliberately idle measures
		// the player, not the render.
		constexpr auto kRenderTimeout = std::chrono::seconds(30);

		/* A safety net for the texture swap, not a diagnosis — the diagnosis lives
		 * in ApplySwaps, which explains what the framework actually does.
		 *
		 * The swap and the plain render now go through the SAME framework call
		 * (IMesh_CreateByNifPath, which has never failed to draw), so a swapped
		 * piece that renders nothing means something about painting the live model
		 * broke, not that the route is wrong. Two strikes with nothing to show and
		 * swaps are abandoned for the session; ONE success and they are trusted
		 * for good. Either way the piece is re-armed as the plain mesh, so the
		 * worst outcome stays a picture rather than a placeholder. */
		constexpr std::size_t kSwapStrikes = 2;

		/* ── the turntable ──────────────────────────────────────────────────
		 * The drag-to-orbit lightbox: FOUR frames, 90° apart (front / side /
		 * back / side), so a piece can be turned around. Kept deliberately low
		 * — each frame is a full offscreen render (~6 s, and a possible hitch),
		 * so a turntable is only THREE extra renders beyond frame 0, and even
		 * those are baked lazily (the view only asks once you actually start
		 * dragging — merely opening a piece to look costs nothing). Angle 0
		 * keeps the ordinary filename and is never re-rendered. Skyrim is Z-up,
		 * so the spin is about Z — the piece turning on a pedestal. Bump
		 * kSpinStep down (e.g. 45 → 8 frames) if a smoother turn is wanted; the
		 * view reads the same two numbers so they stay in lockstep. */
		constexpr std::uint32_t kSpinStep   = 90;
		constexpr std::uint32_t kSpinFrames = 360 / kSpinStep;   // 4

		// How long the watcher will keep pumping a batch. 600 ticks (~7 min) cut
		// the 2026-08-02 batch off mid-flight: four pieces armed at 21:22:35 were
		// only retired at 21:24:32, when an unrelated EnsureIcons() happened to
		// pump. A batch that keeps making progress must be allowed to finish; the
		// loop still exits the instant the queue and the in-flight list are both
		// empty, so this cap only bounds a batch that is genuinely stuck.
		constexpr int kWatchTicks = 5000;   // ~58 min at 700 ms

		/* ── the framework's IMesh, mirrored ────────────────────────────────
		 * Field-for-field mirror of MeshRenderingFrameworkAPI's IMesh, layout
		 * fixed by THIS file and the asserts — not by a header that could
		 * re-pad a type. Identical to portraits.cpp; see there for the field
		 * provenance. */
		struct IMeshAbi
		{
			std::uint64_t id;               // 0x00
			float         rotation[9];      // 0x08
			float         position[3];      // 0x2C
			float         boundMin[3];      // 0x38
			float         boundMax[3];      // 0x44
			float         scale;            // 0x50
			std::uint32_t width;            // 0x54
			std::uint32_t height;           // 0x58
			void*         texture;          // 0x60
			void*         SRV;              // 0x68
			bool          saveNextFrame;    // 0x70
			bool          deleteAfterSave;  // 0x71
			const char*   savePath;         // 0x78
			bool          mustUpdate;       // 0x80
			bool          alwaysUpdate;     // 0x81
		};
		static_assert(offsetof(IMeshAbi, scale) == 0x50, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, width) == 0x54, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, height) == 0x58, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, texture) == 0x60, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, SRV) == 0x68, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, saveNextFrame) == 0x70, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, deleteAfterSave) == 0x71, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, savePath) == 0x78, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, mustUpdate) == 0x80, "IMesh mirror drifted");
		static_assert(offsetof(IMeshAbi, alwaysUpdate) == 0x81, "IMesh mirror drifted");
		static_assert(sizeof(IMeshAbi) == 0x88, "IMesh mirror drifted");

		/* ── binding (soft, like the FollowerOrganizer bridge) ─────────────── */

		using CreateByNifFn     = void* (*)(const char*, std::uint32_t, std::uint32_t);
		using DeleteFn          = void (*)(void*);

		CreateByNifFn     g_createByNif     = nullptr;
		DeleteFn          g_delete          = nullptr;

		bool g_resolved = false;
		bool g_abiOk    = true;   // cleared for the session if the layout probe fails

		/* ── state ──────────────────────────────────────────────────────────── */

		/* One entry of the model's texture swap, resolved — the reason the Yeti
		 * Cap rendered GREEN: retexture variants reuse a mesh and dress it with
		 * an alternate texture set, so the bare NIF is the WRONG picture. Same
		 * shape and rules as portraits.cpp's AltTex (the 66-identical-portraits
		 * lesson). */
		struct AltTex
		{
			RE::BGSTextureSet* set{ nullptr };
			std::uint32_t      index3D{ 0 };
			std::string        name3D;
		};

		struct Request
		{
			std::string         outPath;   // where the framework writes (game-root-relative)
			std::string         key;       // "0XABCD|plugin.esp" — the index key
			std::string         nifPath;   // the armour's world model
			std::string         label;     // item name, for the log
			std::vector<AltTex> swaps;     // empty = plain mesh (the common case)
			// Turntable frame, degrees, 0..359 and always a multiple of
			// kSpinStep. 0 = the ordinary icon at the ordinary filename; a
			// non-zero angle spins the mesh and writes the <file>-a045.png
			// sibling the view's spin lightbox derives and probes.
			std::uint32_t       angle{ 0 };
		};

		struct InFlight
		{
			void*                                 mesh{};
			std::string                           outPath;
			std::string                           key;
			std::string                           label;
			// Kept so a swap-route failure can be re-armed as the bare mesh
			// without re-deriving the look from the form.
			std::string                           nifPath;
			bool                                  swapped{ false };
			std::uint32_t                         angle{ 0 };   // turntable frame; 0 = frame 0
			std::chrono::steady_clock::time_point armed{};
			// No node is kept alive here any more: the framework clones the model
			// synchronously inside the create call (see ApplySwaps), so nothing of
			// ours has to outlive it.
		};

		std::mutex                      g_mutex;
		std::deque<Request>             g_queue;
		std::vector<InFlight>           g_inFlight;
		std::unordered_set<std::string> g_asked;   // key -> queued/failed this session
		std::atomic<bool>               g_watching{ false };
		std::size_t                     g_done = 0, g_failed = 0;

		// Swap-route verdict (see kSwapStrikes). g_swapProven latches on the
		// first swapped render that actually lands and can never be un-latched;
		// g_swapDisabled latches the other way and sends every later request
		// down the bare-NIF route.
		bool        g_swapProven   = false;
		bool        g_swapDisabled = false;
		std::size_t g_swapStrikes  = 0;

		// Icons that landed since the view was last told. Pump() runs with
		// g_mutex held and the notify path re-enters IndexJson(), which takes
		// the same lock — so Pump only COUNTS, and the caller pushes after it
		// has let go.
		std::size_t g_landed = 0;

		// Last time Pump() looked. Used to advance every in-flight job's clock
		// by exactly the interval the framework spent refusing to draw.
		std::chrono::steady_clock::time_point g_lastPump{};

		// The framework keeps our savePath pointer and reads it a frame later;
		// a deque never invalidates references to existing elements.
		std::deque<std::string> g_savePaths;

		std::function<void()> g_onBatchDone;

		/* ── SEH-guarded calls (POD-only wrappers, C2712) ──────────────────── */

		void* CallCreateByNif(CreateByNifFn a_fn, const char* a_nif, std::uint32_t a_w, std::uint32_t a_h) noexcept
		{
			__try {
				return a_fn(a_nif, a_w, a_h);
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return nullptr;
			}
		}

		bool CallDelete(DeleteFn a_fn, void* a_mesh) noexcept
		{
			__try {
				a_fn(a_mesh);
				return true;
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		void* SafeCreateByNif(const std::string& nifPath)
		{
			if (!g_createByNif || nifPath.empty())
				return nullptr;
			try {
				return CallCreateByNif(g_createByNif, nifPath.c_str(), kSize, kSize);
			} catch (...) {
				logger::warn("item icons: IMesh_CreateByNifPath threw — skipping '{}'", nifPath);
				return nullptr;
			}
		}

		void SafeDelete(void* mesh)
		{
			if (!g_delete || !mesh)
				return;
			try {
				if (!CallDelete(g_delete, mesh))
					logger::warn("item icons: IMesh_Delete faulted — leaking one mesh rather than crashing");
			} catch (...) {
			}
		}

		bool Ready() { return g_createByNif && g_delete && g_abiOk; }

		/* The framework's OWN skip-list, not a guess about what "pauses the game".
		 *
		 * MeshRenderingFramework.dll v3.0.0 carries exactly four menu names in its
		 * string table — "Main Menu", "Mist Menu", "MapMenu", "Book Menu" — beside
		 * RenderManager::CopyRenderTargetToMesh. They are the menus that commandeer
		 * the render target it copies out of, so while one is up it draws nothing.
		 * The deck is NOT one of them (proven above: renders failed just as dead
		 * with the deck closed), so this gate deliberately does not care whether
		 * the palette is open — it only stops us from burning the render leash
		 * against a wall the framework put up on purpose.
		 *
		 * MAIN THREAD ONLY (UI menu map). Pump() is the only caller and it always
		 * runs inside an SKSE task. */
		bool FrameworkBlocked()
		{
			auto* ui = RE::UI::GetSingleton();
			if (!ui)
				return false;
			return ui->IsMenuOpen("Main Menu") || ui->IsMenuOpen("Mist Menu") ||
			       ui->IsMenuOpen("MapMenu") || ui->IsMenuOpen("Book Menu");
		}

		/* ── names and places ──────────────────────────────────────────────── */

		std::filesystem::path IconDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "items";
		}

		// The portal's normalisation, exactly: UPPERCASE hex, lowercase plugin.
		std::string KeyOf(std::string fid, std::string plugin)
		{
			for (auto& c : fid)
				c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
			for (auto& c : plugin)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return fid + "|" + plugin;
		}

		// Filesystem-safe stem for 4,700 third-party plugin names.
		std::string Slug(const std::string& s)
		{
			std::string out;
			out.reserve(s.size());
			bool dash = false;
			for (const char raw : s) {
				const auto c = static_cast<unsigned char>(raw);
				if (std::isalnum(c)) {
					out += static_cast<char>(std::tolower(c));
					dash = false;
				} else if (!dash && !out.empty()) {
					out += '-';
					dash = true;
				}
			}
			while (!out.empty() && out.back() == '-')
				out.pop_back();
			return out.empty() ? "x" : out;
		}

		/* Retexture variants get their OWN filename generation, and that is not
		 * decoration — it is the only way to replace an icon at all.
		 *
		 * Ultralight memory-maps every image the deck has drawn and holds it for
		 * the session, so a PNG the Wardrobe tab has already shown can NEVER be
		 * overwritten in place (ERROR_USER_MAPPED_FILE — see the deck's own
		 * lesson from the portrait work). The renderer is also "render once, keep
		 * forever": FileExists() is what marks a job done, so an icon left on
		 * disk is never reconsidered.
		 *
		 * Both of those together mean the untextured icons the swap-less fallback
		 * wrote on 2026-08-02 would be permanent. So a piece that HAS a texture
		 * swap renders to '<slug>-<hex>-s2.png' instead, and the index prefers
		 * that file when it exists. The old name is simply left alone: nothing
		 * reads it once the new one lands, and it cannot be deleted while the
		 * view has it mapped anyway. Bump the suffix again if the swap renderer
		 * ever changes in a way that invalidates what it already wrote. */
		std::string FileFor(const std::string& fid, const std::string& plugin, bool swapped = false)
		{
			std::string hex = fid;
			if (hex.rfind("0x", 0) == 0 || hex.rfind("0X", 0) == 0)
				hex = hex.substr(2);
			for (auto& c : hex)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return Slug(plugin) + "-" + hex + (swapped ? "-s2" : "") + ".png";
		}

		bool FileExists(const std::string& p)
		{
			std::error_code ec;
			return std::filesystem::exists(p, ec);
		}

		/* THE TURNTABLE FILENAME CONTRACT (ported verbatim from portraits.cpp).
		 * The view's spin lightbox computes these names independently off the
		 * frame-0 URL, so it is stated once, here:
		 *
		 *     angle 0    ->  <file>                 the icon, byte for byte
		 *     angle 45   ->  <file minus .png>-a045.png
		 *     …
		 *     angle 315  ->  <file minus .png>-a315.png
		 *
		 * Angle 0 keeping the ORIGINAL name is load-bearing: every icon already
		 * rendered stays exactly where it is and is never re-rendered. Three
		 * zero-padded digits so "-a45" can never be confused with "-a450". */
		std::string AngleFile(const std::string& file, std::uint32_t angle)
		{
			if (angle % 360u == 0)
				return file;   // frame 0 is the ordinary filename, untouched
			// Case-insensitive ".png" check, inline — LowerS is defined further
			// down this file, and a helper cannot call it from up here.
			const bool hasPng = file.size() > 4 && file[file.size() - 4] == '.' &&
				std::tolower(static_cast<unsigned char>(file[file.size() - 3])) == 'p' &&
				std::tolower(static_cast<unsigned char>(file[file.size() - 2])) == 'n' &&
				std::tolower(static_cast<unsigned char>(file[file.size() - 1])) == 'g';
			const std::string stem = hasPng ? file.substr(0, file.size() - 4) : file;
			char buf[8]{};
			std::snprintf(buf, sizeof(buf), "-a%03u", static_cast<unsigned>(angle % 360u));
			return stem + buf + ".png";
		}

		/* Post-multiply the framework's chosen frame-0 orientation by a rotation
		 * of `angle` degrees about `axis`, in place. Ported from portraits.cpp:
		 * Z is Skyrim's up-axis and the default, so the piece turns on a pedestal
		 * rather than tumbling. A zero angle is left untouched (frame 0). A
		 * degenerate all-zero matrix is reset to identity first so a spun frame
		 * can never render as a black square. */
		void ApplySpin(float m[9], std::uint32_t angle, char axis)
		{
			if (angle % 360u == 0)
				return;

			bool anyNonZero = false;
			for (int i = 0; i < 9 && !anyNonZero; ++i)
				anyNonZero = (m[i] != 0.0f);
			if (!anyNonZero) {
				for (int i = 0; i < 9; ++i)
					m[i] = 0.0f;
				m[0] = m[4] = m[8] = 1.0f;
			}

			constexpr double kPi = 3.14159265358979323846;
			const double     rad = static_cast<double>(angle % 360u) * kPi / 180.0;
			const float      c   = static_cast<float>(std::cos(rad));
			const float      s   = static_cast<float>(std::sin(rad));

			float r[9]{};
			switch (axis) {
				case 'x':
				case 'X':
					r[0] = 1.f; r[1] = 0.f; r[2] = 0.f;
					r[3] = 0.f; r[4] = c;   r[5] = -s;
					r[6] = 0.f; r[7] = s;   r[8] = c;
					break;
				case 'y':
				case 'Y':
					r[0] = c;   r[1] = 0.f; r[2] = s;
					r[3] = 0.f; r[4] = 1.f; r[5] = 0.f;
					r[6] = -s;  r[7] = 0.f; r[8] = c;
					break;
				default:   // 'z' — Skyrim's up axis, and the default
					r[0] = c;   r[1] = -s;  r[2] = 0.f;
					r[3] = s;   r[4] = c;   r[5] = 0.f;
					r[6] = 0.f; r[7] = 0.f; r[8] = 1.f;
					break;
			}

			float out[9]{};
			for (int row = 0; row < 3; ++row)
				for (int col = 0; col < 3; ++col)
					out[row * 3 + col] = r[row * 3 + 0] * m[0 * 3 + col] +
										 r[row * 3 + 1] * m[1 * 3 + col] +
										 r[row * 3 + 2] * m[2 * 3 + col];
			for (int i = 0; i < 9; ++i)
				m[i] = out[i];
		}

		/* ── texture-swap machinery, ported from portraits.cpp ─────────────── */

		std::string LowerS(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		// The model's alternate-texture list, copied out. Bounded: the count is
		// a uint32 read out of a third-party plugin.
		std::vector<AltTex> SwapsOf(const RE::TESModelTextureSwap* model)
		{
			std::vector<AltTex> out;
			if (!model || !model->alternateTextures || model->numAlternateTextures == 0)
				return out;
			const std::uint32_t n = model->numAlternateTextures > 256u ? 256u : model->numAlternateTextures;
			out.reserve(n);
			for (std::uint32_t i = 0; i < n; ++i) {
				const auto& alt = model->alternateTextures[i];
				if (!alt.textureSet)
					continue;
				AltTex t;
				t.set     = alt.textureSet;
				t.index3D = alt.index3D;
				if (const char* nm = alt.name3D.c_str(); nm && nm[0])
					t.name3D = nm;
				out.push_back(std::move(t));
			}
			return out;
		}

		/* Demand the model under the EXACT string the framework will use.
		 *
		 * This is not fussiness. The whole swap now depends on our node and the
		 * framework's node being the SAME cached object, and BSModelDB is keyed by
		 * the path it is handed. IMesh_CreateByNifPath passes our string through
		 * to BSModelDB::Demand verbatim (disassembly: the exported thunk moves the
		 * caller's pointer straight into the Demand call), so demanding
		 * "meshes\x.nif" while the framework demands "x.nif" could hand us a
		 * different entry and the swap would land on a model nobody renders. The
		 * framework's own route is proven to resolve these paths — 27 of 27
		 * rendered on 2026-08-02 — so the verbatim spelling is the right one and
		 * the only one we use. */
		bool DemandExact(const std::string& nifPath, RE::NiPointer<RE::NiNode>& out)
		{
			out.reset();
			if (nifPath.empty())
				return false;
			RE::BSModelDB::DBTraits::ArgsType args{};
			if (RE::BSModelDB::Demand(nifPath.c_str(), out, args) == RE::BSResource::ErrorCode::kNone && out)
				return true;
			out.reset();
			return false;
		}

		std::vector<RE::BSGeometry*> GeometriesOf(RE::NiAVObject* root)
		{
			std::vector<RE::BSGeometry*> out;
			if (!root)
				return out;
			RE::BSVisit::TraverseScenegraphGeometries(root,
				[&out](RE::BSGeometry* a_geo) -> RE::BSVisit::BSVisitControl {
					out.push_back(a_geo);
					return RE::BSVisit::BSVisitControl::kContinue;
				});
			return out;
		}

		// A geometry whose material we replaced, plus our own private copy of what
		// it was wearing beforehand. `saved` is heap memory WE own (Create() +
		// CopyMembers), destroyed by RestoreSwaps.
		struct SavedMat
		{
			RE::BSLightingShaderProperty*     shader{ nullptr };
			RE::BSGeometry*                   geo{ nullptr };
			RE::BSLightingShaderMaterialBase* saved{ nullptr };
		};

		// POD-only (__try, C2712). Takes a private copy of the CURRENT material
		// into a_out->saved, then dresses the geometry in a_set. SetMaterial(.,
		// true) copies, so the temporary we build is destroyed immediately and
		// the property owns its own.
		bool CallSwapMaterial(RE::BSLightingShaderProperty* a_shader, RE::BSGeometry* a_geo,
			RE::BGSTextureSet* a_set, SavedMat* a_out) noexcept
		{
			__try {
				auto* base = static_cast<RE::BSLightingShaderMaterialBase*>(a_shader->material);
				if (!base)
					return false;
				auto* keep = static_cast<RE::BSLightingShaderMaterialBase*>(base->Create());
				if (!keep)
					return false;
				keep->CopyMembers(base);   // what the game's model was wearing
				auto* fresh = static_cast<RE::BSLightingShaderMaterialBase*>(base->Create());
				if (!fresh) {
					keep->~BSLightingShaderMaterialBase();
					RE::free(keep);
					return false;
				}
				fresh->CopyMembers(base);
				fresh->ClearTextures();
				fresh->OnLoadTextureSet(0, a_set);
				a_shader->SetMaterial(fresh, true);
				a_shader->SetupGeometry(a_geo);
				a_shader->FinishSetupGeometry(a_geo);
				fresh->~BSLightingShaderMaterialBase();
				RE::free(fresh);
				a_out->shader = a_shader;
				a_out->geo    = a_geo;
				a_out->saved  = keep;
				return true;
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		// The exact inverse. Always runs, even if the render call threw.
		bool CallRestoreMaterial(const SavedMat& a_m) noexcept
		{
			__try {
				a_m.shader->SetMaterial(a_m.saved, true);
				a_m.shader->SetupGeometry(a_m.geo);
				a_m.shader->FinishSetupGeometry(a_m.geo);
				a_m.saved->~BSLightingShaderMaterialBase();
				RE::free(a_m.saved);
				return true;
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		/* ── the texture swap, applied where the framework will actually SEE it ──
		 *
		 * The first cut of this cloned the model, repainted the clone, and handed
		 * the clone to IMesh_CreateByNiAVObjectList. It rendered NOTHING, ever —
		 * 53 armed renders on 2026-08-02, zero files, while the bare-NIF route
		 * did 27 in 40 seconds. Disassembling MeshRenderingFramework.dll v3.0.0
		 * says why, and it is a trap worth writing down:
		 *
		 *     IMesh_CreateByNiAVObjectList(objs, n, w, h):
		 *         holder = new NiNode;  attached = 0
		 *         for each obj:
		 *             c = obj->Clone()            // RELOCATION_ID(68835, 70187)
		 *             if (!c) continue            // <-- silently dropped
		 *             holder->AttachChild(c, false); ++attached
		 *         if (attached) setup(mesh, holder, holder, w, h)   // <-- SKIPPED
		 *         return mesh                     // ...and still returns a mesh
		 *
		 * So the framework re-Clones whatever you give it, and if that clone comes
		 * back null it hands you a fully-formed IMesh that was never wired to
		 * anything. It passes our layout probe, accepts a savePath, and is drawn
		 * exactly never. Our detached, hand-repainted clone hit that branch every
		 * single time.
		 *
		 * The route that DOES work is the framework's own:
		 *
		 *     IMesh_CreateByNifPath(path, w, h):
		 *         BSModelDB::Demand(path, &node)  // RELOCATION_ID(74040, 75782)
		 *         nif->node = node->Clone()       // ...same Clone, on the CACHED
		 *                                         //    model, which never fails
		 *         nif->node->SetMotionType(4, true, false, true)
		 *         setup(mesh, nif->node, nif->node, w, h)
		 *
		 * — it clones the BSModelDB-cached node, SYNCHRONOUSLY, inside the call.
		 *
		 * Which gives the fix its shape: paint the swap onto the cached model
		 * itself, call the path route so the framework's own clone is taken while
		 * the paint is wet, and put the model back the moment it returns. The
		 * game's shared model is altered for the duration of ONE function call on
		 * the main thread and no longer.
		 *
		 * Why that is acceptable, stated plainly rather than waved past: the
		 * render thread is not the main thread, so an NPC wearing this exact mesh
		 * could in principle show the icon's texture for a single frame during a
		 * bake. Weighed against the alternative — the mod's real textures never
		 * appearing at all, which is what "Slips and Bra" and the Yeti Cap looked
		 * like: flat white and flat green, no texture whatsoever — that is the
		 * right trade, and it is bounded to the handful of retexture variants that
		 * have a swap at all. Every failure below restores and falls through to
		 * the plain mesh, so the worst case is still today's picture.
		 */
		std::vector<SavedMat> ApplySwaps(RE::NiNode* src, const std::vector<AltTex>& swaps,
			const std::string& label)
		{
			std::vector<SavedMat> saved;
			const auto            geo = GeometriesOf(src);
			if (geo.empty())
				return saved;
			std::vector<std::string> names;
			names.reserve(geo.size());
			for (auto* g : geo) {
				const char* nm = g ? g->name.c_str() : nullptr;
				names.push_back(nm ? LowerS(nm) : std::string{});
			}
			for (const auto& swap : swaps) {
				if (!swap.set)
					continue;
				RE::BSGeometry* target = nullptr;
				if (!swap.name3D.empty()) {
					const std::string want = LowerS(swap.name3D);
					for (std::size_t i = 0; i < names.size(); ++i)
						if (names[i] == want) {
							target = geo[i];
							break;
						}
				}
				if (!target && swap.index3D < geo.size())
					target = geo[swap.index3D];
				if (!target)
					continue;
				auto* prop = target->GetGeometryRuntimeData()
								 .properties[RE::BSGeometry::States::kEffect].get();
				auto* shader = netimmerse_cast<RE::BSLightingShaderProperty*>(prop);
				if (!shader)
					continue;
				SavedMat m;
				if (CallSwapMaterial(shader, target, swap.set, &m))
					saved.push_back(m);
			}
			if (!saved.empty())
				logger::info("item icons: '{}' — {} of {} texture-swap entries applied to the live model",
					label, saved.size(), swaps.size());
			return saved;
		}

		// Undo, unconditionally, in reverse. Never leaves the game's model
		// wearing an icon's textures.
		void RestoreSwaps(std::vector<SavedMat>& saved, const std::string& label)
		{
			std::size_t failed = 0;
			for (auto it = saved.rbegin(); it != saved.rend(); ++it)
				if (it->shader && it->saved && !CallRestoreMaterial(*it))
					++failed;
			if (failed)
				logger::error("item icons: '{}' — {} shape(s) could NOT be restored to their original "
							  "material; that mesh may wear the icon's texture until the cell reloads",
					label, failed);
			saved.clear();
		}

		/* ── the armour's picture source ────────────────────────────────────
		 * The GROUND model — what an inventory icon shows — AND its texture
		 * swap: retexture variants (the green Yeti Cap) are a mesh plus an
		 * alternate texture set, so the swap travels with the path. worldModels
		 * first, armor-addon biped model as fallback. */
		struct Look
		{
			std::string         nif;
			std::vector<AltTex> swaps;
		};
		Look LookOf(const std::string& fid, const std::string& plugin)
		{
			Look          look;
			std::uint32_t local = 0;
			try {
				local = static_cast<std::uint32_t>(std::stoul(
					fid.rfind("0x", 0) == 0 || fid.rfind("0X", 0) == 0 ? fid.substr(2) : fid, nullptr, 16));
			} catch (...) {
				return look;
			}
			if (!local)
				return look;
			RE::TESForm* form = nullptr;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				form = dh->LookupForm(local, plugin);
			if (!form)
				return look;
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				for (const auto& wm : armo->worldModels) {
					const char* m = wm.GetModel();
					if (m && *m) {
						look.nif   = m;
						look.swaps = SwapsOf(&wm);
						return look;
					}
				}
				for (auto* addon : armo->armorAddons) {
					if (!addon)
						continue;
					for (const auto& bm : addon->bipedModels) {
						const char* m = bm.GetModel();
						if (m && *m) {
							look.nif   = m;
							look.swaps = SwapsOf(&bm);
							return look;
						}
					}
				}
				return look;
			}
			/* Worn is not only armour: the equipped read hands us swords, torches
			 * and quivers too. Every one of those carries its world model on a
			 * TESModelTextureSwap base (weapon, light, ammo all inherit it) — the
			 * same render route and the same swap rules as an armour piece, so
			 * one generic branch covers them all. ARMO is handled above and never
			 * reaches here, so there is no ambiguity with its biped models. */
			if (auto* mts = form->As<RE::TESModelTextureSwap>()) {
				if (const char* m = mts->GetModel(); m && *m) {
					look.nif   = m;
					look.swaps = SwapsOf(mts);
				}
				return look;
			}
			return look;
		}

		/* ── the render handshake (portraits.cpp, verbatim in spirit) ──────── */

		bool ProbeLayout(const IMeshAbi* m)
		{
			if (!m)
				return false;
			if (m->width != kSize || m->height != kSize)
				return false;
			if (m->saveNextFrame || m->deleteAfterSave || m->alwaysUpdate)
				return false;
			if (m->savePath != nullptr)
				return false;
			return true;
		}

		// We never call IMesh_Save: it dereferences mesh->SRV with no null
		// check and a fresh mesh has none. Arm the deferred save and let their
		// render loop write; the mesh is freed in Pump() once the file lands.
		bool ArmSave(void* mesh, const InFlight& job)
		{
			auto* abi = static_cast<IMeshAbi*>(mesh);
			if (!ProbeLayout(abi)) {
				logger::error("item icons: IMesh layout probe FAILED — Mesh Rendering Framework "
							  "changed its struct; item icons are disabled for this session.");
				g_abiOk = false;
				return false;
			}
			// Turntable: spin the framework's chosen frame-0 orientation to this
			// frame's angle before the save is armed. A no-op for angle 0 (the
			// ordinary icon), so the common path is unchanged.
			ApplySpin(abi->rotation, job.angle, 'z');
			std::error_code ec;
			std::filesystem::create_directories(std::filesystem::path(job.outPath).parent_path(), ec);
			if (ec)
				return false;
			g_savePaths.push_back(job.outPath);
			abi->savePath        = g_savePaths.back().c_str();
			abi->saveNextFrame   = true;
			abi->deleteAfterSave = false;
			abi->mustUpdate      = true;
			return true;
		}

		// g_mutex held.
		bool Start(const Request& r)
		{
			if (!Ready())
				return false;
			void* mesh    = nullptr;
			bool  swapped = false;
			// A retexture variant is painted onto the CACHED model, rendered
			// through the framework's own path route while the paint is wet, and
			// put back the instant that call returns — see ApplySwaps for the
			// disassembly this is built on. Every failure restores and falls
			// through to the plain mesh, so it can only make the picture better.
			if (!r.swaps.empty() && !g_swapDisabled) {
				RE::NiPointer<RE::NiNode> src;
				if (!DemandExact(r.nifPath, src) || !src) {
					logger::warn("item icons: '{}' — the framework's own model path would not load here, "
								 "so its texture swap cannot be applied; plain mesh",
						r.label);
				} else {
					auto saved = ApplySwaps(src.get(), r.swaps, r.label);
					if (!saved.empty()) {
						mesh    = SafeCreateByNif(r.nifPath);   // clones the model NOW
						swapped = mesh != nullptr;
						RestoreSwaps(saved, r.label);           // ...and it is wet no longer
					}
				}
			}
			if (!mesh)
				mesh = SafeCreateByNif(r.nifPath);
			if (!mesh) {
				++g_failed;
				return false;
			}
			InFlight job;
			job.mesh    = mesh;
			job.outPath = r.outPath;
			job.key     = r.key;
			job.label   = r.label;
			job.nifPath = r.nifPath;
			job.swapped = swapped;
			job.angle   = r.angle;
			job.armed   = std::chrono::steady_clock::now();
			if (!ArmSave(mesh, job)) {
				SafeDelete(mesh);
				++g_failed;
				return false;
			}
			logger::info("item icons: rendering '{}' -> {}", r.label, r.outPath);
			g_inFlight.push_back(std::move(job));
			return true;
		}

		// Retire finished / stuck renders, then start queued ones. g_mutex held.
		void Pump()
		{
			const auto now     = std::chrono::steady_clock::now();
			const bool blocked = FrameworkBlocked();

			// Pause every in-flight leash for exactly the interval the framework
			// spent refusing to draw. Without this, opening the map for a minute
			// silently kills whatever was mid-render — and the log would blame
			// the mesh.
			if (blocked && g_lastPump != std::chrono::steady_clock::time_point{}) {
				const auto stalled = now - g_lastPump;
				for (auto& job : g_inFlight)
					job.armed += stalled;
			}
			g_lastPump = now;

			for (std::size_t i = 0; i < g_inFlight.size();) {
				const bool done = FileExists(g_inFlight[i].outPath);
				const bool late = (now - g_inFlight[i].armed) > kRenderTimeout;
				if (!done && !late) {
					++i;
					continue;
				}
				SafeDelete(g_inFlight[i].mesh);
				if (done) {
					++g_done;
					++g_landed;   // the view is told after the lock is released
					if (g_inFlight[i].swapped && !g_swapProven) {
						g_swapProven  = true;
						g_swapStrikes = 0;
						logger::info("item icons: the texture-swap route DOES render on this setup "
									 "('{}') — keeping it", g_inFlight[i].label);
					}
					logger::info("item icons: '{}' saved ({} done, {} failed)", g_inFlight[i].label, g_done, g_failed);
				} else if (g_inFlight[i].swapped && !g_inFlight[i].nifPath.empty()) {
					// The convicted route (see kSwapStrikes). Do NOT release the
					// key: re-arm this exact piece as the bare mesh ourselves, at
					// the FRONT of the queue, so the retry is the one thing that
					// has never failed rather than the same failure again.
					++g_failed;
					if (!g_swapProven && !g_swapDisabled && ++g_swapStrikes >= kSwapStrikes) {
						g_swapDisabled = true;
						logger::error("item icons: painting the live model for a texture swap has produced "
									  "NOTHING in {} attempts — plain mesh only for the rest of the session. "
									  "Retexture variants will wear their base texture, which is a picture "
									  "instead of a placeholder.",
							g_swapStrikes);
					}
					Request again;
					again.outPath = g_inFlight[i].outPath;
					again.key     = g_inFlight[i].key;
					again.nifPath = g_inFlight[i].nifPath;
					again.label   = g_inFlight[i].label;
					again.angle   = g_inFlight[i].angle;   // same turntable frame
					// swaps deliberately empty — that IS the retry.
					g_queue.push_front(std::move(again));
					logger::warn("item icons: '{}' drew nothing through its texture swap in {}s — "
								 "retrying as the bare mesh",
						g_inFlight[i].label, static_cast<long long>(kRenderTimeout.count()));
				} else {
					++g_failed;
					g_asked.erase(g_inFlight[i].key);   // a later call may retry
					logger::warn("item icons: '{}' did not render within {}s — mesh freed. (The framework "
								 "declines to draw while its Main/Mist/Map/Book menus are open; that time "
								 "is not counted.)",
						g_inFlight[i].label, static_cast<long long>(kRenderTimeout.count()));
				}
				g_inFlight.erase(g_inFlight.begin() + static_cast<std::ptrdiff_t>(i));
			}
			// Starting a render the framework has already said it will not draw
			// just burns a mesh; hold the queue until it is willing again.
			while (!blocked && !g_queue.empty() && g_inFlight.size() < kMaxInFlight) {
				Request r = std::move(g_queue.front());
				g_queue.pop_front();
				if (!Start(r))
					g_asked.erase(r.key);
			}
		}

		// The portal cannot call IndexJson(), so the same map is dropped beside
		// the other exports whenever a batch lands. Declared here, defined after
		// IndexJson() (it reuses it).
		void WriteIndexFile();

		// Queue one item if it needs rendering. g_mutex held. Returns true if queued.
		bool EnqueueLocked(const std::string& fid, const std::string& plugin, const std::string& name)
		{
			if (fid.empty() || plugin.empty() || g_queue.size() >= kMaxQueued)
				return false;
			const auto key = KeyOf(fid, plugin);
			if (g_asked.count(key))
				return false;
			// The look has to be derived FIRST now, because whether this piece has
			// a texture swap decides which filename it renders to — and therefore
			// whether the icon already sitting on disk is one of ours or one of
			// the untextured ones the swap-less fallback wrote (see FileFor).
			auto look = LookOf(fid, plugin);
			if (look.nif.empty()) {
				g_asked.insert(key);   // nothing to render; don't re-derive every call
				return false;
			}
			/* With swaps latched off (new-architecture MRF, or two strikes) a
			 * retexture variant renders as the BARE mesh — that picture must land
			 * under the PLAIN name, never under "-s2" (the name the index prefers,
			 * reserved for renders that really carried the variant's textures). */
			const bool hasSwaps = !look.swaps.empty();
			const bool wantSwap = hasSwaps && !g_swapDisabled;
			const auto out = (IconDir() / FileFor(fid, plugin, wantSwap)).string();
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				return false;
			}
			if (hasSwaps && !wantSwap &&
				FileExists((IconDir() / FileFor(fid, plugin, true)).string())) {
				// a good swap-rendered icon from an earlier session still wins the
				// index — don't burn a render on a bare duplicate beside it
				g_asked.insert(key);
				return false;
			}
			Request r;
			r.outPath = out;
			r.key     = key;
			r.nifPath = std::move(look.nif);
			r.swaps   = wantSwap ? std::move(look.swaps) : std::vector<AltTex>{};
			r.label   = name.empty() ? key : name;
			g_queue.push_back(std::move(r));
			g_asked.insert(key);
			return true;
		}

		// Pull {formId,plugin,name} triples out of one of the deck's export files.
		std::size_t EnqueueFromFile(const std::filesystem::path& file, bool nested)
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open())
				return 0;
			auto j = nlohmann::json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return 0;
			std::size_t queued = 0;
			std::lock_guard l(g_mutex);
			if (!nested) {   // wardrobe-inventory.json: {items:[{formId,plugin,name}]}
				if (j.contains("items") && j["items"].is_array())
					for (const auto& it : j["items"])
						if (it.is_object() &&
							EnqueueLocked(it.value("formId", std::string("")),
								it.value("plugin", std::string("")), it.value("name", std::string(""))))
							++queued;
			} else {   // wardrobe-catalogue.json: {outfits:[{items:[...]}]}
				if (j.contains("outfits") && j["outfits"].is_array())
					for (const auto& o : j["outfits"])
						if (o.is_object() && o.contains("items") && o["items"].is_array())
							for (const auto& it : o["items"])
								if (it.is_object() &&
									EnqueueLocked(it.value("formId", std::string("")),
										it.value("plugin", std::string("")), it.value("name", std::string(""))))
									++queued;
			}
			return queued;
		}

		// One watcher pumps until the batch drains, then hands the main thread
		// the "index changed" callback. Single-shot tasks from our own thread —
		// never a task that re-posts itself (skse-task-self-repost-freezes).
		void StartWatcher()
		{
			if (g_watching.exchange(true))
				return;
			std::thread([]() {
				using namespace std::chrono_literals;
				for (int i = 0; i < kWatchTicks; ++i) {
					std::this_thread::sleep_for(700ms);
					bool busy = false;
					// Pump under the lock, then notify OUTSIDE it: the callback
					// re-enters IndexJson(), which takes the same mutex.
					SKSE::GetTaskInterface()->AddTask([]() {
						bool landed = false;
						{
							std::lock_guard l(g_mutex);
							Pump();
							landed   = g_landed > 0;
							g_landed = 0;
						}
						// Each icon that lands is pushed as it lands, so the tab
						// fills in under the player instead of waiting for the
						// whole batch (or a reopen) to reveal any of it.
						if (landed) {
							WriteIndexFile();
							if (g_onBatchDone)
								g_onBatchDone();
						}
					});
					{
						std::lock_guard l(g_mutex);
						busy = !g_queue.empty() || !g_inFlight.empty();
					}
					if (!busy)
						break;
				}
				g_watching = false;
				SKSE::GetTaskInterface()->AddTask([]() {
					WriteIndexFile();
					if (g_onBatchDone)
						g_onBatchDone();
				});
			}).detach();
		}
	}

	void Init()
	{
		if (g_resolved)
			return;
		g_resolved = true;
		auto mod = GetModuleHandleA("MeshRenderingFramework.dll");
		if (!mod)
			mod = GetModuleHandleA("MeshRenderingFramework");
		if (!mod) {
			logger::info("item icons: Mesh Rendering Framework is not installed — item icons are "
						 "skipped and the views keep their glyphs (a supported setup, not an error)");
			return;
		}
		g_createByNif     = reinterpret_cast<CreateByNifFn>(GetProcAddress(mod, "IMesh_CreateByNifPath"));
		// IMesh_CreateByNiAVObjectList is deliberately NOT bound: it re-Clones
		// whatever it is handed, drops any object whose clone comes back null, and
		// then skips its own setup while still returning a mesh - which is exactly
		// how 53 icon renders produced nothing on 2026-08-02. See ApplySwaps.
		g_delete          = reinterpret_cast<DeleteFn>(GetProcAddress(mod, "IMesh_Delete"));
		if (!g_createByNif || !g_delete) {
			logger::warn("item icons: MeshRenderingFramework.dll loaded but exports did not resolve — "
						 "a newer or different API; item icons stay off");
			g_createByNif = nullptr;
			g_delete      = nullptr;
			return;
		}
		/* The 2026-08 MRF rewrite (nifly + its own D3D11 pipeline) parses the NIF
		 * from the game's resources itself — it never touches BSModelDB, so the
		 * wet-paint texture swap (ApplySwaps on the cached node) silently paints a
		 * model the renderer never reads, and a "-s2" file would bake the WRONG
		 * (base) textures under the preferred filename, permanently. The rewrite
		 * is detectable by an export the old architecture never had; when it is
		 * present, latch the existing swap-disable so retexture variants render
		 * as the bare mesh under the plain filename (existing good -s2 icons on
		 * disk keep winning the index). The trade is deliberate: the rewrite is
		 * what renders FaceGen heads (skin posing + facetint) — the NPC Finder's
		 * portraits — which the old architecture drew as a black square. */
		if (GetProcAddress(mod, "IMesh_SetTextureSet")) {
			g_swapDisabled = true;
			logger::info("item icons: new-architecture Mesh Rendering Framework detected — "
						 "texture swaps off (bare-mesh renders), FaceGen head renders on");
		}
		logger::info("item icons: Mesh Rendering Framework bound — armour renders at {}px", kSize);
	}

	bool Available() { return Ready(); }

	void EnsureIcons()
	{
		if (!Ready())
			return;
		const auto viewDir = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck";
		std::size_t queued  = 0;
		queued += EnqueueFromFile(viewDir / "wardrobe-inventory.json", false);
		queued += EnqueueFromFile(viewDir / "wardrobe-catalogue.json", true);
		// Even with nothing to render, the walk above just learned which icons
		// already exist — put that on disk for the portal.
		WriteIndexFile();
		if (!queued)
			return;
		logger::info("item icons: {} armour render(s) queued", queued);
		{
			std::lock_guard l(g_mutex);
			Pump();   // start the first kMaxInFlight immediately
		}
		StartWatcher();
	}

	void EnsureIconsForWorn(const std::string& wornReplyJson)
	{
		// Its own line, not just a forward: the shared body can no longer say
		// "worn" (the Wheel Menu passes pinned items through it), and WHICH
		// caller asked is the useful half of that log. It is also this path's
		// build marker (item-icons-worn) — the deploy script fingerprints the
		// DLL by these literals, so folding two callers onto one string would
		// have made the worn path invisible to it.
		logger::info("item icons: worn set requested");
		EnsureIconsForList(wornReplyJson);
	}

	void EnsureIconsForList(const std::string& wornReplyJson)
	{
		if (!Ready())
			return;
		auto j = nlohmann::json::parse(wornReplyJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return;
		std::size_t queued = 0;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				if (EnqueueLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string())))
					++queued;
			}
		}
		// Even with nothing new to render, the walk above registered the worn
		// keys — the index now names every piece that already has a PNG, which
		// is what the quick card needs on a session where the Wardrobe tab
		// never opened (IndexJson only reports keys asked THIS session).
		WriteIndexFile();
		if (!queued)
			return;
		logger::info("item icons: {} listed render(s) queued", queued);
		{
			std::lock_guard l(g_mutex);
			Pump();
		}
		StartWatcher();
	}

	/* ── NPC faces (the NPC Finder's icons) ─────────────────────────────────
	 * Not a form-derived model at all: the NIF is the CK's baked FaceGen head,
	 * named by the face owner's origin plugin + 8-hex formid. Everything else
	 * — queue, in-flight budget, deferred save, render-once-keep-forever — is
	 * the machinery above, untouched. */
	namespace
	{
		std::filesystem::path FaceDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "npcs";
		}

		// g_mutex held. Returns true if a render was queued.
		bool EnqueueFaceLocked(const std::string& fid, const std::string& plugin, const std::string& name)
		{
			if (fid.empty() || plugin.empty() || g_queue.size() >= kMaxQueued)
				return false;
			// Distinct asked-key namespace: IndexJson skips any key with '@',
			// and Pump's failure-erase works on this key unchanged.
			const auto key = KeyOf(fid, plugin) + "@face";
			if (g_asked.count(key))
				return false;
			// The CK's file name: 8 hex digits, lowercase, zero-padded.
			std::string hex = fid;
			if (hex.rfind("0x", 0) == 0 || hex.rfind("0X", 0) == 0)
				hex = hex.substr(2);
			for (auto& c : hex)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			if (hex.empty() || hex.size() > 8)
				return false;
			while (hex.size() < 8)
				hex.insert(hex.begin(), '0');
			const std::string rel =
				"actors\\character\\facegendata\\facegeom\\" + plugin + "\\" + hex + ".nif";
			// Probe through the game's own resource stack (loose files AND
			// BSAs, MO2 VFS applied) BEFORE queueing: a templated NPC has no
			// face file, and the framework must never burn a mesh finding
			// that out. The mark makes the miss permanent for the session.
			RE::BSResourceNiBinaryStream probe(("meshes\\" + rel).c_str());
			if (!probe.good()) {
				g_asked.insert(key);
				return false;
			}
			const auto out = (FaceDir() / FileFor(fid, plugin, false)).string();
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				return false;
			}
			std::error_code ec;
			std::filesystem::create_directories(FaceDir(), ec);
			Request r;
			r.outPath = out;
			r.key     = key;
			r.nifPath = rel;      // swaps deliberately empty: the head is self-contained
			r.label   = name.empty() ? key : name;
			g_queue.push_back(std::move(r));
			g_asked.insert(key);
			return true;
		}
	}

	void EnsureFaceIcons(const std::string& itemsJson)
	{
		if (!Ready())
			return;
		auto j = nlohmann::json::parse(itemsJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return;
		std::size_t queued = 0;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				if (EnqueueFaceLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string())))
					++queued;
			}
		}
		if (!queued)
			return;
		logger::info("item icons: {} npc face render(s) queued", queued);
		{
			std::lock_guard l(g_mutex);
			Pump();
		}
		StartWatcher();
	}

	std::string FaceIndexJson()
	{
		nlohmann::json icons = nlohmann::json::object();
		std::lock_guard l(g_mutex);
		static const std::string suffix = "@face";
		for (const auto& key : g_asked) {
			if (key.size() <= suffix.size() ||
				key.compare(key.size() - suffix.size(), suffix.size(), suffix) != 0)
				continue;
			const auto base = key.substr(0, key.size() - suffix.size());
			const auto bar = base.find('|');
			if (bar == std::string::npos)
				continue;
			const auto file = FileFor(base.substr(0, bar), base.substr(bar + 1), false);
			if (FileExists((FaceDir() / file).string()))
				icons[base] = "icons/npcs/" + file;
		}
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void CaptureAngles(const std::string& fid, const std::string& plugin)
	{
		if (!Ready() || fid.empty() || plugin.empty())
			return;
		// The frame-0 look decides the base filename the view derives its angle
		// URLs from, so the angles MUST come off the same mesh + swap decision
		// as frame 0 — otherwise the spin would mix one piece with another's
		// texture. An unrenderable form (no world model — e.g. a bow with only
		// a first-person model, an abstract light) simply has no turntable.
		auto look = LookOf(fid, plugin);
		if (look.nif.empty())
			return;
		bool swapped = !look.swaps.empty();
		if (swapped && g_swapDisabled) {
			/* Bare frames cannot match a swap-rendered frame 0. If the view's
			 * frame 0 is the "-s2" file (index preference), baking bare angles
			 * would either mix textures or land under names never probed — so
			 * no turntable at all for this piece. With only a plain frame 0,
			 * bare angles under plain names are consistent and fine. */
			if (FileExists((IconDir() / FileFor(fid, plugin, true)).string()))
				return;
			swapped = false;
		}
		const auto  baseFile = FileFor(fid, plugin, swapped);
		std::size_t queued   = 0;
		{
			std::lock_guard l(g_mutex);
			for (std::uint32_t f = 1; f < kSpinFrames; ++f) {
				const std::uint32_t angle = f * kSpinStep;
				// A DISTINCT asked-key namespace ("<key>@045") so a frame that
				// is queued/rendered is not re-derived every open, and so the
				// frame-0 index in IndexJson never sees these (it skips '@').
				const std::string akey = KeyOf(fid, plugin) + "@" + std::to_string(angle);
				if (g_asked.count(akey))
					continue;
				const auto out = (IconDir() / AngleFile(baseFile, angle)).string();
				if (FileExists(out)) {   // baked already — keep forever
					g_asked.insert(akey);
					continue;
				}
				if (g_queue.size() >= kMaxQueued)
					break;
				Request r;
				r.outPath = out;
				r.key     = akey;
				r.nifPath = look.nif;
				r.swaps   = swapped ? look.swaps : std::vector<AltTex>{};
				r.label   = fid + "|" + plugin + " @" + std::to_string(angle) + "deg";
				r.angle   = angle;
				g_queue.push_back(std::move(r));
				g_asked.insert(akey);
				++queued;
			}
			if (queued)
				Pump();
		}
		if (queued) {
			logger::info("item icons: {} turntable frame(s) queued for {}|{}", queued, fid, plugin);
			StartWatcher();
		}
	}

	std::string IndexJson()
	{
		nlohmann::json icons = nlohmann::json::object();
		std::error_code ec;
		// The filename alone cannot be mapped back to a key (slug is lossy), so
		// the index is rebuilt from what we KNOW plus what is on disk: every key
		// in g_asked whose file exists, plus nothing else. Keys survive for the
		// session; across sessions the view re-asks via EnsureIcons anyway.
		std::lock_guard l(g_mutex);
		for (const auto& key : g_asked) {
			const auto bar = key.find('|');
			if (bar == std::string::npos)
				continue;
			// Turntable frame keys ("<key>@045") are NOT frame-0 icons: the view
			// derives and probes their URLs itself off the frame-0 entry, so
			// they must never appear here (they would map a bogus "plugin@045"
			// slug to a file that does not exist).
			if (key.find('@') != std::string::npos)
				continue;
			// Newest wins, without needing a form lookup from this thread: the
			// swap-rendered name is preferred whenever it exists, and the plain
			// one is the fallback. That is also what quietly retires the
			// untextured icons — nothing points at them any more.
			const auto swapped = FileFor(key.substr(0, bar), key.substr(bar + 1), true);
			const auto plain   = FileFor(key.substr(0, bar), key.substr(bar + 1), false);
			if (FileExists((IconDir() / swapped).string()))
				icons[key] = "icons/items/" + swapped;
			else if (FileExists((IconDir() / plain).string()))
				icons[key] = "icons/items/" + plain;
		}
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void SetOnBatchDone(std::function<void()> cb)
	{
		g_onBatchDone = std::move(cb);
	}

	namespace
	{
		void WriteIndexFile()
		{
			const auto file = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "item-icons.json";
			std::error_code ec;
			std::filesystem::create_directories(file.parent_path(), ec);
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << IndexJson();
		}
	}
}
