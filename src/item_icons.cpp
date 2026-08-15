#include "item_icons.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp, logger and
// Windows.h (via PrismaUI_API.h). SEH (__try) needs no extra include.

#include <algorithm>
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
		// NPC face renders only — see Request::px.
		constexpr std::uint32_t kFaceSize = 1024;

		// Each in-flight mesh costs a full offscreen scene render per frame.
		// A 41-piece inventory is a background trickle, not a burst.
		constexpr std::size_t kMaxInFlight = 2;
		constexpr std::size_t kMaxQueued   = 512;
		// Idle-tier ceiling (render warm-start). Small on purpose: the warm-start
		// set is a curated handful (the follower roster + party), not a catalogue,
		// and it must never eat the user queue's headroom.
		constexpr std::size_t kMaxIdleQueued = 64;

		// The framework renders nothing while one of ITS OWN four skip-menus is
		// open (see FrameworkBlocked); past this we free the mesh (an un-drawn
		// mesh re-renders every frame forever) and allow a later retry. The
		// clock is PAUSED while the framework is blocked — a 30 s wall-clock
		// leash that ticks while the framework is deliberately idle measures
		// the player, not the render.
		constexpr auto kRenderTimeout = std::chrono::seconds(30);

		/* ── render pacing WHILE THE GAME IS LIVE ───────────────────────────
		 * An MRF render runs on the game's own D3D11 device, so a burst of them
		 * back-to-back contends with the game drawing the world and reads as a
		 * multi-second HITCH: Rober hit F7 on an NPC whose 7 worn pieces rendered
		 * one after another (~0.5 s each) and the game froze for the duration
		 * (2026-08-14). So while the game is UNPAUSED we put a minimum GAP between
		 * render STARTS — the renders still happen, just spread out so no single
		 * frame stalls. While the game is PAUSED (the deck palette pauses it — see
		 * GameIsPaused) or a framework skip-menu is up there is no world being
		 * drawn to contend with, so we pace nothing: browsing the Finder with the
		 * palette open stays full-speed, and only the hitchy case (renders still
		 * draining after the palette closes, or a HUD-triggered ask) is spread.
		 *
		 * User-tier (a page/card the player is looking at) gets the short gap so
		 * its pictures still arrive promptly; idle-tier (the boot warm-start) gets
		 * a longer one because nobody is waiting on it. The pump ticks every 700 ms
		 * (> the user gap), so a live user batch settles to ~one render per pump —
		 * gentle — while a paused batch starts kMaxInFlight at once as before.
		 *
		 * ── the boot re-bake burst (2026-08-15) ─────────────────────────────
		 * A from-source MRF rebuild or a hand-purge of the render caches forces a
		 * one-time re-bake: EVERY roster face (32) plus the wardrobe/worn items
		 * re-render on the next load, and the warm-start fires them 5 s after
		 * kPostLoadGame — i.e. right as the player finishes loading in and the
		 * world starts streaming/drawing. Each render is a synchronous MRF
		 * offscreen pass on the game's OWN D3D11 device (~0.5-0.7 s wall), so even
		 * one-at-a-time they read as a string of micro-hitches for the ~40 s the
		 * burst takes (confirmed in HotkeyDeck.log 2026-08-14 21:47:14..21:47:56:
		 * 32 faces, one every ~0.7-1.3 s, all while the player was in-world with a
		 * follower). The one-time nature is real — the .render-gen stamp now
		 * persists and matches the live MRF fingerprint, so the NEXT load does NOT
		 * re-purge — but "one bad boot per MRF update" is still a bad boot. So the
		 * IDLE tier (which is exactly the warm-start burst) is paced FAR more
		 * gently while the game is live: a long gap AND a settle delay after the
		 * player first loads in, so the burst spreads over minutes in the
		 * background instead of racing the world draw. User-tier (a page the
		 * player is actively looking at) is untouched — it still arrives promptly.
		 */
		constexpr auto kPaceGapUser = std::chrono::milliseconds(400);
		// Idle-tier live gap widened 1 s -> 3 s: the warm-start re-bake is pure
		// background work, so a face landing every few seconds is invisible where a
		// burst is a stutter. Paused (deck open / load screen up — no world drawn)
		// still ignores this entirely, so opening the Finder stays full-speed.
		constexpr auto kPaceGapIdle = std::chrono::milliseconds(3000);

		// After the first load of a session settles, hold the IDLE tier off the
		// D3D device entirely for this long while the game is LIVE — the window
		// where the cell is streaming in and every stolen frame is felt hardest.
		// The warm-start's whole point is "the first MINUTES show real faces", so
		// starting a minute in costs nothing it promised and spares the load-in.
		// Paused time (deck/menus/load screen) does not count against it — see
		// GamePaused in Pump. User renders are never delayed by this.
		constexpr auto kIdleSettleDelay = std::chrono::seconds(45);

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
			// Render canvas edge. Items keep kSize (a 44px row face never needs
			// more); NPC FACES render at kFaceSize because the face-fit zoom
			// magnifies a WINDOW of the canvas — a 512 render leaves ~40-160px
			// of actual face and the tiles came out visibly pixelated
			// (Rober, 2026-08-14). px*px scales render cost; faces are few.
			std::uint32_t       px{ kSize };
			// Re-fit the framework's sphere fit to a box fit so small clutter
			// (potions) fills the frame — see FitClutter. Only the frame-0 ITEM
			// renders set this; faces/bodies (own downstream framing) and
			// turntable frames (must match frame 0) leave it false.
			bool                refit{ false };
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
			std::uint32_t                         px{ kSize };  // the canvas this mesh was created at
			bool                                  refit{ false }; // FitClutter this frame-0 item render
			std::chrono::steady_clock::time_point armed{};
			// No node is kept alive here any more: the framework clones the model
			// synchronously inside the create call (see ApplySwaps), so nothing of
			// ours has to outlive it.
		};

		std::mutex                      g_mutex;
		std::deque<Request>             g_queue;
		// IDLE tier (render warm-start): proactively-queued renders that must NEVER
		// delay a user-requested one. Pump() drains g_queue (user work + swap
		// retries) completely-per-budget first and only pulls from here when g_queue
		// is empty and the in-flight budget still has room — so a page the player
		// actually opens always jumps ahead of the warm-start set. Same Request
		// shape, same in-flight machinery, same render-once dedup; only the ORDER of
		// starting differs. Capped separately (kMaxIdleQueued) so a warm-start can
		// never crowd out the user queue's headroom.
		std::deque<Request>             g_idleQueue;
		std::vector<InFlight>           g_inFlight;
		std::unordered_set<std::string> g_asked;   // key -> queued/failed this session

		/* Item-icon keys known to have a render on disk, loaded from the
		 * persisted item-icons.json at Init and kept current as batches land.
		 *
		 * g_asked only remembers what was asked THIS session, so IndexJson() —
		 * and the item-icons.json it writes — used to FORGET every icon rendered
		 * in a previous session (or an earlier query this session that has since
		 * been evicted), even though the PNG is right there on disk. That is the
		 * "pack/item icons vanish after a few tab switches" bug: the view re-asks,
		 * C++ answers from g_asked, misses the older keys, and the tile falls back
		 * to a glyph although the render exists. This set is the durable on-disk
		 * truth; IndexJson() reports the UNION of it and g_asked (each verified to
		 * still exist), so a rendered icon is named for good. Faces/bodies keep
		 * their own '@'-suffixed keys and are never added here. */
		std::unordered_set<std::string> g_diskIndex;

		/* Face/body render keys ('@face' / '@body' suffixed) known to be on disk,
		 * loaded from the persisted npc-icons.json at Init and kept current as
		 * batches land. The exact twin of g_diskIndex, for the NPC Finder.
		 *
		 * Root cause of "faces aren't saved — always has to load again"
		 * (2026-08-14): FaceIndexJson()/BodyIndexJson() iterated g_asked, which
		 * only remembers what was asked THIS session — so on a fresh launch the
		 * DLL could not name a single face until the view re-asked for it, even
		 * though 68 PNGs were sitting in icons/npcs. The generation stamp proved
		 * the renders were NOT being wiped (it fired once, then matched); the DLL
		 * simply forgot them. This set is the durable on-disk truth: StateJson()
		 * can now hand the whole index to the view at nxState so a previously
		 * rendered face shows on the FIRST paint of a query — no round-trip, no
		 * shimmer, no re-decode. The filename slug (Slug(plugin)) is lossy, so we
		 * cannot rebuild a key from a directory walk; the persisted key→file map
		 * is how the exact plugin identity survives a restart. */
		std::unordered_set<std::string> g_faceDiskIndex;

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

		// Last time a render was actually STARTED (a Start() that returned true).
		// The pacing gate (see kPaceGapUser/kPaceGapIdle) measures against this so
		// live renders spread out instead of bursting. Main thread only (Pump).
		std::chrono::steady_clock::time_point g_lastStart{};

		// Once-per-burst pacing log: set true when the gate first HOLDS a start
		// back this burst so the log line is emitted once, cleared whenever a burst
		// ends (queues + in-flight all empty) so the next live burst logs afresh.
		bool g_paceLogged = false;

		// Accumulated LIVE (game-unpaused, framework-unblocked) wall time since the
		// first pump, used to hold the idle/warm-start tier off the shared D3D
		// device for kIdleSettleDelay right after the player loads in. Counting
		// only live time means the settle window is real play time — the deck being
		// open or a load screen up does not "use it up", which would let the burst
		// fire the instant the player closes the deck mid-load. Main thread only
		// (Pump). See kIdleSettleDelay. */
		std::chrono::steady_clock::duration g_liveElapsed{ 0 };
		// Once-per-session log: the idle tier's first release after the settle hold.
		bool g_idleSettleLogged = false;

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

		void* SafeCreateByNif(const std::string& nifPath, std::uint32_t px = kSize)
		{
			if (!g_createByNif || nifPath.empty())
				return nullptr;
			try {
				return CallCreateByNif(g_createByNif, nifPath.c_str(), px, px);
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

		/* ── the facegen render GENERATION ──────────────────────────────────
		 * Faces and creature bodies are baked by MRF's nifly skinning path,
		 * which the framework's own version + our facegen patch decide; item
		 * renders are plain model art the posing never touches. Because a
		 * render is kept forever once it lands, a torn head from an old MRF
		 * survives every fix until someone deletes the PNG by hand — which is
		 * exactly what stranded Rober's torn Jenassa/Lydia faces through a v2
		 * MRF that no longer tears (2026-08-14).
		 *
		 * So the facegen caches carry a GENERATION token = the bound MRF DLL's
		 * identity (size+mtime, the same cheap fingerprint the deploy scripts
		 * use) plus a manual epoch bumped whenever WE change what a good render
		 * looks like. Init writes it to icons/npcs/.render-gen; on a mismatch
		 * it purges icons/npcs and icons/mounts ONCE, so the next in-game ask
		 * re-bakes every face/body through the current framework. Bump kFaceGenEpoch
		 * to force a one-time re-bake without an MRF change. */
		constexpr int kFaceGenEpoch = 2;   // 2026-08-14: MRF facegen convention-aware patch

		/* ── the ITEM render GENERATION ─────────────────────────────────────
		 * Item renders (icons/items) are model art the facegen posing never
		 * touches, so they are deliberately LEFT ALONE by the facegen epoch
		 * above. But they carry their OWN look decisions that a deck change can
		 * invalidate exactly the same way: the 2026-08-14 clutter framing fix
		 * (FitClutter) makes small meshes — potions especially — fill the frame
		 * instead of sitting as a 3%-tall speck (a "Grand Potion of Health"
		 * rendered into a 19x46px subject inside a 512x512 frame; measured).
		 * Because a render is kept forever once it lands, those loosely-framed
		 * PNGs would survive the fix. So icons/items carries the same kind of
		 * generation stamp, keyed ONLY on a manual epoch (the framing math is
		 * ours, not the framework's — an MRF change does not invalidate it, and
		 * folding MRF identity in would needlessly re-bake thousands of item
		 * icons on every framework bump). Bump this to force a one-time re-bake
		 * of every item render after a look-affecting change to this file. */
		constexpr int kItemRenderEpoch = 1;   // 2026-08-14: clutter framing fill fix (FitClutter)

		std::string MrfIdentity()
		{
			// size|mtime of the loaded MeshRenderingFramework.dll — enough to
			// tell one build from another without hashing a 2.4 MB file. A
			// module we could not locate on disk still yields a stable string
			// (the epoch alone), so the stamp is never empty.
			HMODULE mod = GetModuleHandleA("MeshRenderingFramework.dll");
			if (!mod)
				mod = GetModuleHandleA("MeshRenderingFramework");
			if (!mod)
				return {};
			char path[MAX_PATH]{};
			if (!GetModuleFileNameA(mod, path, MAX_PATH))
				return {};
			std::error_code ec;
			const std::filesystem::path p(path);
			const auto sz = std::filesystem::file_size(p, ec);
			const auto sizeStr = ec ? std::string("?") : std::to_string(static_cast<std::uint64_t>(sz));
			std::error_code ec2;
			const auto wt = std::filesystem::last_write_time(p, ec2);
			const auto wtStr = ec2 ? std::string("?")
			                       : std::to_string(static_cast<long long>(wt.time_since_epoch().count()));
			return sizeStr + "|" + wtStr;
		}

		// The generation token the facegen caches must match to be kept.
		std::string FaceGenToken()
		{
			return "epoch=" + std::to_string(kFaceGenEpoch) + ";mrf=" + MrfIdentity();
		}

		// The facegen render dirs, spelled out here so the generation check
		// (which runs inside Init, before the FaceDir()/BodyDir() helpers in
		// the later namespace blocks are in scope) needs no forward decls.
		std::filesystem::path FaceGeomDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "npcs";
		}
		std::filesystem::path MountGeomDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "mounts";
		}

		// The persisted face/body index — WriteNpcIndexFile()'s output, the NPC
		// Finder's durable on-disk truth. Keys carry their '@face'/'@body' suffix
		// and are stored verbatim; paths are re-resolved against disk on read.
		// Spelled out here (before ReconcileFaceGenGeneration, which deletes it on
		// a generation change) so no forward decl is needed.
		std::filesystem::path NpcIndexFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "npc-icons.json";
		}

		void DeletePngsIn(const std::filesystem::path& dir)
		{
			std::error_code ec;
			if (!std::filesystem::exists(dir, ec))
				return;
			std::size_t n = 0;
			for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
				if (!it->is_regular_file(ec))
					continue;
				auto ext = it->path().extension().string();
				for (auto& c : ext)
					c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
				if (ext != ".png")
					continue;
				std::error_code del;
				std::filesystem::remove(it->path(), del);
				if (!del)
					++n;
			}
			if (n)
				logger::info("item icons: purged {} stale render(s) from {}", n, dir.string());
		}

		/* Compare the on-disk facegen render generation to the current token;
		 * on a mismatch, purge icons/npcs + icons/mounts once and rewrite the
		 * stamp. Called from Init AFTER binding (so MrfIdentity can read the
		 * module) and only when the framework is actually present — with no MRF
		 * nothing renders faces, so there is nothing to invalidate. The stamp
		 * lives beside the face renders; a wrong or missing stamp with renders
		 * present means they are from an unknown/older generation and go. */
		void ReconcileFaceGenGeneration()
		{
			const auto want = FaceGenToken();
			const auto stamp = FaceGeomDir() / ".render-gen";
			std::string have;
			{
				std::ifstream in(stamp, std::ios::binary);
				if (in.is_open())
					std::getline(in, have);
			}
			if (have == want)
				return;   // renders match the live framework — keep them

			DeletePngsIn(FaceGeomDir());
			DeletePngsIn(MountGeomDir());

			// The PNGs are gone; the persisted face/body index must forget them too,
			// or the first FaceIndexJson() would name renders that no longer exist.
			g_faceDiskIndex.clear();
			std::error_code npcec;
			std::filesystem::remove(NpcIndexFile(), npcec);

			std::error_code ec;
			std::filesystem::create_directories(FaceGeomDir(), ec);
			std::ofstream out(stamp, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << want << "\n";
			logger::info("item icons: facegen render generation changed ('{}' -> '{}') - faces and "
			             "creature bodies will re-render through the current Mesh Rendering Framework",
				have.empty() ? std::string("<none>") : have, want);
		}

		// The persisted item-icons.json — WriteIndexFile()'s output, the durable
		// on-disk truth the portal also reads. Spelled out here (before the
		// WriteIndexFile helper's own namespace block) so Init can seed g_diskIndex
		// from it and the generation check can wipe it.
		std::filesystem::path ItemIndexFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "item-icons.json";
		}

		// Seed g_diskIndex from the persisted item-icons.json so the very first
		// IndexJson() of a session names every icon a PRIOR session rendered — not
		// just the ones re-asked yet. Keys are taken verbatim (already normalised
		// "HEX|plugin"); the paths in the file are ignored because IndexJson()
		// re-resolves each key against what is actually on disk (so a since-deleted
		// or since-swapped file can never be reported stale). Best-effort: a
		// missing or malformed file just leaves the set empty. g_mutex NOT held —
		// called from Init before any watcher exists.
		void LoadDiskIndex()
		{
			std::ifstream in(ItemIndexFile(), std::ios::binary);
			if (!in.is_open())
				return;
			auto j = nlohmann::json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object() || !j.contains("icons") || !j["icons"].is_object())
				return;
			std::size_t n = 0;
			for (auto it = j["icons"].begin(); it != j["icons"].end(); ++it) {
				const std::string& key = it.key();
				if (key.find('|') == std::string::npos || key.find('@') != std::string::npos)
					continue;   // only frame-0 item keys belong here
				g_diskIndex.insert(key);
				++n;
			}
			if (n)
				logger::info("item icons: loaded {} known item render(s) from item-icons.json", n);
		}

		// Seed g_faceDiskIndex from npc-icons.json so the very first FaceIndexJson()
		// / BodyIndexJson() of a session names every face/body a PRIOR session
		// rendered — the "faces always reload" fix. Only '@'-suffixed keys belong
		// here (a plain item key in this file would be a corruption); paths are
		// ignored (FaceIndexJson re-resolves each key against disk). Best-effort.
		// g_mutex NOT held — called from Init before any watcher exists.
		void LoadFaceDiskIndex()
		{
			std::ifstream in(NpcIndexFile(), std::ios::binary);
			if (!in.is_open())
				return;
			auto j = nlohmann::json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object() || !j.contains("icons") || !j["icons"].is_object())
				return;
			std::size_t n = 0;
			for (auto it = j["icons"].begin(); it != j["icons"].end(); ++it) {
				const std::string& key = it.key();
				if (key.find('@') == std::string::npos || key.find('|') == std::string::npos)
					continue;   // only '@face'/'@body' keys belong here
				g_faceDiskIndex.insert(key);
				++n;
			}
			if (n)
				logger::info("item icons: loaded {} known face/body render(s) from npc-icons.json", n);
		}

		/* Item-render generation: purge item icons ONCE after a look-affecting
		 * change to this file (kItemRenderEpoch). The stamp lives beside the item
		 * renders (icons/items/.render-gen). Unlike the facegen check this keys on
		 * the epoch ALONE — item framing is our math, not the framework's, so an
		 * MRF build change must not needlessly re-bake thousands of item icons.
		 *
		 * Only PLAIN-name renders are purged. The old "-s2" swap renders (baked by
		 * the OLD game-renderer architecture, textures and lighting intact) are the
		 * best pictures we have for those variants and the new nifly renderer
		 * cannot reproduce them (its IMesh_SetTextureSet is skin/facetint-only —
		 * proven from MRF source, so swaps stay latched off); keeping them means
		 * the index still prefers them. Everything purged re-bakes lazily on the
		 * next ask, now through FitClutter. g_diskIndex is cleared to match so a
		 * purged key is not falsely reported until it re-renders. */
		void ReconcileItemGeneration()
		{
			const auto want  = std::string("item-epoch=") + std::to_string(kItemRenderEpoch);
			const auto stamp = IconDir() / ".render-gen";
			std::string have;
			{
				std::ifstream in(stamp, std::ios::binary);
				if (in.is_open())
					std::getline(in, have);
			}
			if (have == want)
				return;   // generation matches — the index Init loaded is trusted

			// Purge only the plain-name item PNGs; keep every "-s2" swap render.
			std::error_code ec;
			std::size_t purged = 0;
			if (std::filesystem::exists(IconDir(), ec)) {
				for (std::filesystem::directory_iterator it(IconDir(), ec), end; !ec && it != end; it.increment(ec)) {
					if (!it->is_regular_file(ec))
						continue;
					const auto stem = it->path().stem().string();   // no extension
					auto ext = it->path().extension().string();
					for (auto& c : ext)
						c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
					if (ext != ".png")
						continue;
					// Keep swap renders ("-s2") and turntable frames ("-aNNN"):
					// FitClutter reframes only the plain frame-0 renders, and a
					// spun frame is re-derived off frame 0 anyway.
					if (stem.size() >= 3 && stem.compare(stem.size() - 3, 3, "-s2") == 0)
						continue;
					if (stem.size() >= 5 && stem[stem.size() - 5] == '-' && stem[stem.size() - 4] == 'a')
						continue;   // "-a045" etc.
					std::error_code del;
					std::filesystem::remove(it->path(), del);
					if (!del)
						++purged;
				}
			}
			g_diskIndex.clear();
			LoadDiskIndex();   // re-seed from whatever survived (the -s2 keys)

			std::filesystem::create_directories(IconDir(), ec);
			std::ofstream out(stamp, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << want << "\n";
			logger::info("item icons: item render generation changed ('{}' -> '{}') - purged {} plain "
			             "render(s); items re-render through the clutter-fill framing on next ask",
				have.empty() ? std::string("<none>") : have, want, purged);
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

		/* ── clutter framing: fill the frame like the old gear renders did ──
		 *
		 * The new-architecture (nifly) MRF fits the mesh's bounding SPHERE to the
		 * frame: Mesh::Fit sets mesh->scale = fittedRadius / boundingRadius, where
		 * boundingRadius is the max distance of ANY vertex from the model centre.
		 * That fills the frame for a compact object (an armour piece renders at
		 * ~98% of the canvas — measured), but for a mesh with one far-flung shape
		 * — a potion's transparent glass envelope, an off-origin sub-mesh — the
		 * sphere balloons while the VISIBLE geometry stays small, and the icon
		 * comes out a speck: a "Grand Potion of Health" measured at a 19x46 px
		 * subject dead-centre in a 512x512 frame (3.7% x 9% fill), versus the old
		 * game-renderer gear icons Rober remembers filling the tile.
		 *
		 * We cannot see which vertices are transparent from here, but the ABI hands
		 * us the axis-aligned box (boundMin/boundMax) MRF already computed over the
		 * real geometry, in the SAME centred model space the sphere fit used. The
		 * fixed camera maps model-X to a +/-130 unit half-span and model-Z (Skyrim
		 * is Z-up; the camera looks down -Y) to +/-130/aspect, at a subject plane
		 * 820 units from the eye; model-Y is DEPTH and never touches the on-screen
		 * footprint. So the largest scale that fits the box's on-screen extent is a
		 * pure request-side number — write it into abi->scale exactly as ApplySpin
		 * writes abi->rotation.
		 *
		 * This box-fit is SAFE in every case and STRICTLY BETTER in the common one:
		 *   - it can NEVER clip. scale = min(fillX, fillZ), so whichever screen axis
		 *     needs the smaller scale lands exactly at kFillTarget (< 1) and the
		 *     other stays under it — the whole box is inside the canvas.
		 *   - it does NOT harm compact armour, which fills the frame today (~98%):
		 *     its box-fit lands at kFillTarget, a hair off the very edge, still a
		 *     full tile, never clipped (measured armour: 98.6% x 98%).
		 *   - it RECOVERS clutter whose fit was inflated ALONG DEPTH (model-Y): the
		 *     bounding SPHERE the framework fit is sqrt(x^2+y^2+z^2), so a shape
		 *     offset in Y (a common potion EditorMarker / attach node) balloons the
		 *     sphere — shrinking everything — while the X/Z box stays the visible
		 *     bottle. Fitting X/Z instead of the sphere gives the bottle the frame.
		 *
		 * It is NEVER worse than today: the box fits inside the sphere, so fitting
		 * the box needs an equal-or-larger scale (boxScale >= sphereScale always) —
		 * clutter can only grow or stay, never shrink. HONEST LIMIT: if the
		 * inflation is along a SCREEN axis (model-X or -Z) it is in the box too, so
		 * box-fit recovers less than the depth case (though still >= the sphere).
		 * Fully fixing that is an MRF-side change — the bounds loop should ignore
		 * fully-transparent / marker shapes — and belongs in Mesh::Fit, not here.
		 * The diagnostic log prints the box and both scales so the first play-test
		 * says which case each item is; where box-fit is not enough, the MRF bounds
		 * fix is the follow-up.
		 *
		 * FACES and creature BODIES are deliberately EXEMPT: their framing is owned
		 * downstream (hd-facefit's layout crop) and their bounds include hair/limbs
		 * that a box-fit would mis-frame — only item renders (px == kSize, angle 0)
		 * are re-fit. Turntable frames (angle != 0) are left to the same scale the
		 * framework chose so a spun frame matches frame 0. */
		void FitClutter(IMeshAbi* abi, const std::string& label)
		{
			if (!abi)
				return;
			// The fixed camera, mirrored from RenderManager::RenderLocked. If MRF
			// ever changes these the worst case is a slightly loose fit, never a
			// crash or a clip — the target below is unconditional and < 1.
			constexpr float kHorizHalfSpan = 130.0f;    // model-X maps here
			constexpr float kFillTarget    = 0.90f;     // fraction of the frame to fill
			const float aspect = abi->height > 0 ? static_cast<float>(abi->width) /
			                                       static_cast<float>(abi->height)
			                                     : 1.0f;
			const float vertHalfSpan = aspect > 0.0001f ? kHorizHalfSpan / aspect : kHorizHalfSpan;

			// Centred model-space half-extents. Skyrim is Z-up and the camera looks
			// down -Y, so screen-X <- model-X and screen-Y <- model-Z; model-Y is
			// depth and does not affect the on-screen footprint.
			const float halfX = std::fabs(abi->boundMax[0] - abi->boundMin[0]) * 0.5f;
			const float halfZ = std::fabs(abi->boundMax[2] - abi->boundMin[2]) * 0.5f;
			if (halfX < 0.0001f && halfZ < 0.0001f)
				return;   // degenerate box — leave the framework's fit alone

			const float sphereScale = abi->scale;

			// Scale that lands the LIMITING axis at kFillTarget and keeps the other
			// under it: min over the two per-axis fills. Never clips (target < 1).
			const float scaleX = halfX > 0.0001f ? (kFillTarget * kHorizHalfSpan) / halfX : 1.0e9f;
			const float scaleZ = halfZ > 0.0001f ? (kFillTarget * vertHalfSpan) / halfZ : 1.0e9f;
			const float boxScale = (std::min)(scaleX, scaleZ);
			if (boxScale <= 0.0f || boxScale >= 1.0e8f)
				return;   // no usable extent — leave the framework's fit alone

			abi->scale = boxScale;
			// Log when it meaningfully enlarges the fit (boxScale >= sphereScale
			// always; a potion jumps many-fold, compact armour barely moves), so a
			// play-test reveals the real bounds and both scales — the evidence that
			// says whether a still-small item was inflated along depth (recovered)
			// or along a screen axis (needs the MRF-side bounds fix).
			if (boxScale > sphereScale * 1.15f)
				logger::info("item icons: '{}' box-fit — box[x={:.1f} z={:.1f}] "
				             "sphereScale={:.4f} -> boxScale={:.4f} ({:.1f}x)",
					label, halfX * 2.0f, halfZ * 2.0f, sphereScale, boxScale,
					sphereScale > 0.0001f ? boxScale / sphereScale : 0.0f);
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

		bool ProbeLayout(const IMeshAbi* m, std::uint32_t px)
		{
			if (!m)
				return false;
			// Validated against the size THIS mesh was created at — faces render
			// at kFaceSize, items at kSize, and hardcoding kSize here killed the
			// whole pipeline the moment the first 1024px face landed (the probe
			// "failed", g_abiOk latched false, and neither faces nor items
			// rendered for the session — Rober, 2026-08-14).
			if (m->width != px || m->height != px)
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
			if (!ProbeLayout(abi, job.px)) {
				logger::error("item icons: IMesh layout probe FAILED — Mesh Rendering Framework "
							  "changed its struct; item icons are disabled for this session.");
				g_abiOk = false;
				return false;
			}
			// Turntable: spin the framework's chosen frame-0 orientation to this
			// frame's angle before the save is armed. A no-op for angle 0 (the
			// ordinary icon), so the common path is unchanged.
			ApplySpin(abi->rotation, job.angle, 'z');
			// Clutter framing: enlarge the sphere fit to a box fit so a potion
			// fills the frame instead of sitting as a speck. Frame-0 item renders
			// only (job.refit); never shrinks and never clips (see FitClutter).
			if (job.refit && job.angle % 360u == 0)
				FitClutter(abi, job.label);
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
						mesh    = SafeCreateByNif(r.nifPath, r.px);   // clones the model NOW
						swapped = mesh != nullptr;
						RestoreSwaps(saved, r.label);                 // ...and it is wet no longer
					}
				}
			}
			if (!mesh)
				mesh = SafeCreateByNif(r.nifPath, r.px);
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
			job.px      = r.px;
			job.refit   = r.refit;
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

		// Is the game paused right now? MAIN THREAD ONLY (RE::UI) — Pump is always
		// called inside an SKSE task, the same place FrameworkBlocked() reads the
		// menu map. GameIsPaused() is true for the deck palette, inventory, map,
		// magic and the console — every state where the world is NOT being drawn,
		// so an MRF render there contends with nothing and needs no pacing.
		bool GamePaused()
		{
			auto* ui = RE::UI::GetSingleton();
			return ui && ui->GameIsPaused();
		}

		// Retire finished / stuck renders, then start queued ones. g_mutex held.
		void Pump()
		{
			const auto now     = std::chrono::steady_clock::now();
			const bool blocked = FrameworkBlocked();
			// Pace render STARTS only while the game is LIVE (unpaused): a render on
			// the game's D3D11 device contends with the world draw and hitches. When
			// the world is not being drawn (paused / a framework skip-menu is up) we
			// start at full speed — the deck palette pauses the game, so the Finder
			// stays fast. See kPaceGapUser/kPaceGapIdle.
			const bool paced = !blocked && !GamePaused();

			// Pause every in-flight leash for exactly the interval the framework
			// spent refusing to draw. Without this, opening the map for a minute
			// silently kills whatever was mid-render — and the log would blame
			// the mesh.
			if (blocked && g_lastPump != std::chrono::steady_clock::time_point{}) {
				const auto stalled = now - g_lastPump;
				for (auto& job : g_inFlight)
					job.armed += stalled;
			}
			// Accumulate LIVE wall time (the interval since the last pump, but only
			// when the game was drawing the world) so the idle-tier settle hold below
			// measures real play time, not time spent paused in the deck or a load
			// screen. `paced` is exactly "game live" (unblocked + unpaused).
			if (paced && g_lastPump != std::chrono::steady_clock::time_point{})
				g_liveElapsed += (now - g_lastPump);
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
					// Remember this render as on-disk truth so it is named in every
					// later IndexJson() even after g_asked is a fresh session's set
					// (the vanishing-icon fix). Frame-0 item keys go to g_diskIndex;
					// '@face'/'@body' keys go to g_faceDiskIndex so the NPC Finder
					// names them across sessions too (the "faces reload" fix).
					// Turntable frames ('@a…'/'@b…') persist nowhere — the view
					// derives them off frame 0 and probes disk directly.
					{
						const auto& lk = g_inFlight[i].key;
						if (lk.find('@') == std::string::npos)
							g_diskIndex.insert(lk);
						else if (lk.size() >= 5 &&
								 (lk.compare(lk.size() - 5, 5, "@face") == 0 ||
								  lk.compare(lk.size() - 5, 5, "@body") == 0))
							g_faceDiskIndex.insert(lk);
					}
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
			// The pacing gate. `gap` is the minimum wall-clock between render
			// STARTS for this tier while the game is live; returns whether a start
			// is allowed RIGHT NOW. When it holds one back it logs the pacing line
			// once per burst (g_paceLogged), then stays quiet until the burst ends.
			// When not `paced` (paused / menu-blocked) it always allows — full
			// speed. The first start of a live burst (g_lastStart in the distant
			// past, or unset) always passes, so pacing spreads a burst without ever
			// blocking its opening render.
			auto paceOk = [&](std::chrono::milliseconds gap) -> bool {
				if (!paced)
					return true;
				if (g_lastStart != std::chrono::steady_clock::time_point{} &&
					(now - g_lastStart) < gap) {
					if (!g_paceLogged) {
						g_paceLogged = true;
						logger::info("item icons: pacing renders (game unpaused)");
					}
					return false;
				}
				return true;
			};

			// Starting a render the framework has already said it will not draw
			// just burns a mesh; hold the queue until it is willing again. While the
			// game is live the USER tier gets the short gap (kPaceGapUser) — its
			// pictures still arrive promptly, one render per pump, no burst. This
			// loop is checked BEFORE the idle tier and with the shorter gap, so a
			// page the player is looking at is never starved behind the warm-start.
			while (!blocked && !g_queue.empty() && g_inFlight.size() < kMaxInFlight &&
				paceOk(kPaceGapUser)) {
				Request r = std::move(g_queue.front());
				g_queue.pop_front();
				if (Start(r))
					g_lastStart = now;
				else
					g_asked.erase(r.key);
			}
			// IDLE tier LAST: only when the user queue is empty and there is still
			// in-flight room. A user request that arrives later push_back()s onto
			// g_queue and is taken on the NEXT pump before any of these, so the
			// warm-start never delays a page the player opened. Live, the idle tier
			// gets the LONGER gap (kPaceGapIdle) — nobody is waiting on it, so it
			// spreads even more gently.
			//
			// And while the game is LIVE, hold the idle tier off entirely for the
			// first kIdleSettleDelay of live play: that is the boot re-bake burst's
			// window and the load-in period where a stolen D3D frame hitches worst.
			// The warm-start promises "the first minutes show real faces", so
			// starting ~45 s of play in still keeps that promise while sparing the
			// load-in. When PAUSED (deck open / load screen) there is no world to
			// contend with, so `idleSettled` is forced true — a player who opens the
			// Finder right after boot still gets warm-start faces immediately.
			// Also capped to ONE idle render in flight at a time while live, so the
			// background burst can never run two offscreen passes at once against the
			// world draw (kMaxInFlight applies to the shared list; this narrows the
			// idle tier's share of it).
			const bool idleSettled = !paced || g_liveElapsed >= kIdleSettleDelay;
			if (paced && idleSettled && !g_idleSettleLogged &&
				g_liveElapsed >= kIdleSettleDelay && !g_idleQueue.empty()) {
				g_idleSettleLogged = true;
				logger::info("render warm-start: settle window passed ({} s live) — idle re-bake now trickling",
					static_cast<long long>(
						std::chrono::duration_cast<std::chrono::seconds>(g_liveElapsed).count()));
			}
			const std::size_t idleInFlightCap = paced ? std::size_t{ 1 } : kMaxInFlight;
			while (!blocked && idleSettled && g_queue.empty() && !g_idleQueue.empty() &&
				g_inFlight.size() < idleInFlightCap && paceOk(kPaceGapIdle)) {
				Request r = std::move(g_idleQueue.front());
				g_idleQueue.pop_front();
				if (Start(r))
					g_lastStart = now;
				else
					g_asked.erase(r.key);
			}

			// Burst boundary: once nothing is queued or in flight, re-arm the
			// once-per-burst pacing log so the NEXT live burst says so afresh.
			if (g_queue.empty() && g_idleQueue.empty() && g_inFlight.empty())
				g_paceLogged = false;
		}

		// The portal cannot call IndexJson(), so the same map is dropped beside
		// the other exports whenever a batch lands. Declared here, defined after
		// IndexJson() (it reuses it).
		void WriteIndexFile();

		// The NPC Finder's twin: persist the face/body render index (suffixed
		// keys) so a rendered face survives a restart. Defined near the bottom
		// (it uses FaceDir()/BodyDir()); declared here so the watcher can call it.
		void WriteNpcIndexFile();

		// Register one item's key in the durable index IF (and only if) a PNG for
		// it already exists on disk — WITHOUT queueing a render. g_mutex held.
		//
		// This is the cheap half of EnqueueLocked, split out for the eager worn
		// path (EnsureIconsForWorn): the F7 quick card must name the pieces that
		// are already rendered so their tiles paint instantly, but must NOT start
		// an MRF render for the ones that aren't — that render burst on the F7
		// frame was the stutter (Rober, 2026-08-14). A piece with no PNG is left
		// completely untouched (not marked g_asked), so the LAZY request the view
		// sends when the equipped grid is on screen (whIcons → EnsureIconsForList)
		// can still render it through the shared paced queue.
		void RegisterExistingLocked(const std::string& fid, const std::string& plugin)
		{
			if (fid.empty() || plugin.empty())
				return;
			const auto key = KeyOf(fid, plugin);
			if (g_asked.count(key) || g_diskIndex.count(key))
				return;   // already named in the index
			// A retexture variant renders under "-s2"; the swap-less fallback
			// renders under the plain name. Either on disk means "we have it".
			if (FileExists((IconDir() / FileFor(fid, plugin, true)).string()) ||
				FileExists((IconDir() / FileFor(fid, plugin, false)).string()))
				g_diskIndex.insert(key);
		}

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
			r.refit   = true;   // frame-0 item render: box-fit so clutter fills the frame
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
							WriteNpcIndexFile();   // persist any face/body that just landed
							if (g_onBatchDone)
								g_onBatchDone();
						}
					});
					{
						std::lock_guard l(g_mutex);
						busy = !g_queue.empty() || !g_idleQueue.empty() || !g_inFlight.empty();
					}
					if (!busy)
						break;
				}
				g_watching = false;
				SKSE::GetTaskInterface()->AddTask([]() {
					WriteIndexFile();
					WriteNpcIndexFile();
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
		// Seed the on-disk index unconditionally: icons a PRIOR session rendered
		// stay valid to SHOW even on a session with no framework to render new
		// ones, and IndexJson() must name them from the first ask (the vanishing-
		// icon fix). The generation PURGE below is gated on MRF being present —
		// purging when nothing can re-bake would just blank the tiles this session.
		LoadDiskIndex();
		LoadFaceDiskIndex();   // the NPC Finder's on-disk face/body truth (the "faces reload" fix)
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
		// A new MRF build (or a bumped epoch) invalidates every kept face/body
		// render — do the one-time purge now, before anything asks for one.
		ReconcileFaceGenGeneration();
		// A bumped item epoch (a look-affecting change to this file, e.g. the
		// 2026-08-14 clutter-fill framing) purges the plain item renders once so
		// they re-bake framed correctly; the good old "-s2" swap renders survive.
		ReconcileItemGeneration();
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

		// REGISTER-ONLY, deliberately (Rober, 2026-08-14: F7-on-an-NPC stutter).
		// This runs on the fdEquipped reply — i.e. the instant the quick card
		// opens — so it must NOT start any MRF renders: bursting a render for a
		// fresh NPC's whole kit hitched the very frame you pressed F7 on. It only
		// names the pieces that ALREADY have a PNG (so their tiles paint at once)
		// and leaves the rest untouched. The actual renders are requested lazily
		// by the view once the equipped grid is on screen (whIcons →
		// EnsureIconsForList), through the same paced/deduped queue — so nothing
		// bursts and nothing renders twice. The index push in OnJsFolEquipped
		// still hands the view the (now index-complete) map.
		if (!Ready())
			return;
		auto j = nlohmann::json::parse(wornReplyJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				RegisterExistingLocked(it.value("formId", std::string()),
					it.value("plugin", std::string()));
			}
		}
		WriteIndexFile();
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

		// If `key` is still parked (not yet started) in the IDLE queue, splice it to
		// the BACK of the USER queue so it renders at user priority. g_mutex held.
		// Called when a page requests a face the boot warm-start already idle-queued:
		// without this the render would stay idle-tier and could be DELAYED behind the
		// warm-start set — the exact priority inversion the two-tier design must not
		// have. Returns true if it moved one.
		bool PromoteIdleToUser(const std::string& key)
		{
			for (auto it = g_idleQueue.begin(); it != g_idleQueue.end(); ++it) {
				if (it->key == key) {
					g_queue.push_back(std::move(*it));
					g_idleQueue.erase(it);
					return true;
				}
			}
			return false;
		}

		// g_mutex held. Returns true if a NEW render was queued. idle=true parks it on
		// the idle tier (render warm-start) instead of the user queue — same dedup,
		// same probe, same file; only WHICH deque and WHICH ceiling differ.
		bool EnqueueFaceLocked(const std::string& fid, const std::string& plugin, const std::string& name,
			bool idle = false)
		{
			if (fid.empty() || plugin.empty())
				return false;
			if ((idle ? g_idleQueue.size() : g_queue.size()) >= (idle ? kMaxIdleQueued : kMaxQueued))
				return false;
			// Distinct asked-key namespace: IndexJson skips any key with '@',
			// and Pump's failure-erase works on this key unchanged.
			const auto key = KeyOf(fid, plugin) + "@face";
			if (g_asked.count(key)) {
				// Already asked this session. If a USER request finds it still waiting
				// on the idle tier (boot warm-start queued it), promote it so the page
				// the player opened is not stuck behind the warm-start set.
				if (!idle)
					PromoteIdleToUser(key);
				return false;
			}
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
			r.px      = kFaceSize;   // face-fit zooms a WINDOW of this canvas; density is the fix for pixelated tiles

			(idle ? g_idleQueue : g_queue).push_back(std::move(r));
			g_asked.insert(key);
			return true;
		}
	}

	std::size_t EnsureFaceIcons(const std::string& itemsJson)
	{
		if (!Ready())
			return 0;
		auto j = nlohmann::json::parse(itemsJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return 0;
		std::size_t queued = 0;
		bool        any    = false;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				any = true;
				if (EnqueueFaceLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string())))
					++queued;
			}
			// Pump under the same lock: a user request that only PROMOTED an
			// already-idle-queued face (queued stays 0, but EnqueueFaceLocked moved
			// it onto g_queue) must still start now, not wait for the next watcher
			// tick — otherwise the promotion wouldn't actually beat the warm-start
			// set to the render slot.
			if (any)
				Pump();
		}
		if (queued)
			logger::info("item icons: {} npc face render(s) queued at {}px", queued, kFaceSize);  // marker: face-render-density
		if (any)
			StartWatcher();
		return queued;
	}

	// Render warm-start (item 3): proactively queue the follower roster's face
	// renders at IDLE priority so the first minutes after a boot (especially the
	// first after a generation purge, when everything must re-bake) show real faces
	// instead of glyphs — WITHOUT the lazy architecture changing. `itemsJson` is the
	// exact {items:[{formId,plugin,name}]} shape EnsureFaceIcons takes, where
	// formId/plugin are the FACE OWNER's identity (resolved caller-side by the same
	// FaceOwnerOf path the fdFaceIcons handler uses). At most `cap` NEW renders are
	// enqueued this call; the rest are dropped (the roster is small, but a bad caller
	// can't flood the queue). Dedup is the SAME as every other lane — a face already
	// on disk, already asked, or with no facegen file costs nothing extra — so this
	// is safe to call on every boot. Idle-tier: Pump() starts these only when the
	// user queue is empty, so a page the player opens is never delayed. Returns how
	// many were actually queued.
	std::size_t WarmStartFaces(const std::string& itemsJson, std::size_t cap)
	{
		if (!Ready() || cap == 0)
			return 0;
		auto j = nlohmann::json::parse(itemsJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return 0;
		std::size_t queued = 0;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (queued >= cap)
					break;
				if (!it.is_object())
					continue;
				if (EnqueueFaceLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string()),
						/*idle=*/true))
					++queued;
			}
		}
		if (!queued)
			return 0;   // every roster face was already on disk or has no facegen file
		logger::info("render warm-start: {} roster faces queued at idle", queued);  // marker: render-warm-start
		{
			std::lock_guard l(g_mutex);
			Pump();   // kicks the idle tier only if the user queue is empty right now
		}
		StartWatcher();
		return queued;
	}

	/* ── NPC bodies (the Mounts tab's previews) ─────────────────────────────
	 * The third lane through the same queue: an explicit NIF per item (the
	 * caller resolved the race-skin ARMA biped model — see mounts.cpp
	 * BodyNifOf), rendered into icons/mounts/ under the NPC base's identity.
	 * Everything else — in-flight budget, deferred save, render-once-keep-
	 * forever, the '@' index skip — is the machinery above, untouched. */
	namespace
	{
		constexpr std::uint32_t kBodySpinStep = 45;   // 8 frames — one BIG image earns it

		std::filesystem::path BodyDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "mounts";
		}

		// A record's model path is Data\meshes-relative WITHOUT the "meshes\"
		// prefix; BSResource wants it WITH. Normalise for the probe only — the
		// framework gets the record's own spelling, the route items proved.
		std::string ProbePathOf(const std::string& nif)
		{
			std::string low = LowerS(nif);
			for (auto& c : low)
				if (c == '/')
					c = '\\';
			if (low.rfind("meshes\\", 0) == 0)
				return nif;
			return "meshes\\" + nif;
		}

		// g_mutex held. Returns true if a render was queued.
		bool EnqueueBodyLocked(const std::string& fid, const std::string& plugin,
			const std::string& name, const std::string& nif)
		{
			if (fid.empty() || plugin.empty() || nif.empty() || g_queue.size() >= kMaxQueued)
				return false;
			const auto key = KeyOf(fid, plugin) + "@body";
			if (g_asked.count(key))
				return false;
			// Probe through the game's resource stack (loose + BSA, MO2 VFS)
			// before burning a mesh — a mod can ship a record whose model file
			// never made it into the archive.
			RE::BSResourceNiBinaryStream probe(ProbePathOf(nif).c_str());
			if (!probe.good()) {
				g_asked.insert(key);
				logger::warn("item icons: mount body '{}' — model '{}' is not in the load order", name, nif);
				return false;
			}
			const auto out = (BodyDir() / FileFor(fid, plugin, false)).string();
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				return false;
			}
			std::error_code ec;
			std::filesystem::create_directories(BodyDir(), ec);
			Request r;
			r.outPath = out;
			r.key     = key;
			r.nifPath = nif;      // swaps deliberately empty (new-arch MRF ignores them anyway)
			r.label   = name.empty() ? key : name;
			g_queue.push_back(std::move(r));
			g_asked.insert(key);
			return true;
		}
	}

	std::size_t EnsureBodyIcons(const std::string& itemsJson)
	{
		if (!Ready())
			return 0;
		auto j = nlohmann::json::parse(itemsJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return 0;
		std::size_t queued = 0;
		{
			std::lock_guard l(g_mutex);
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				if (EnqueueBodyLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string()),
						it.value("nif", std::string())))
					++queued;
			}
		}
		if (!queued)
			return 0;
		logger::info("item icons: {} mount body render(s) queued", queued);
		{
			std::lock_guard l(g_mutex);
			Pump();
		}
		StartWatcher();
		return queued;
	}

	std::string BodyIndexJson()
	{
		nlohmann::json icons = nlohmann::json::object();
		std::lock_guard l(g_mutex);
		static const std::string suffix = "@body";
		// Union of this-session asks and the persisted on-disk truth, each
		// verified against disk — so a body rendered in a PRIOR session is named
		// on the first ask (the "faces/bodies reload" fix). A key present in both
		// sets is emitted once (icons is keyed by `base`).
		const auto emit = [&](const std::string& key) {
			if (key.size() <= suffix.size() ||
				key.compare(key.size() - suffix.size(), suffix.size(), suffix) != 0)
				return;
			const auto base = key.substr(0, key.size() - suffix.size());
			if (icons.contains(base))
				return;
			const auto bar = base.find('|');
			if (bar == std::string::npos)
				return;
			const auto file = FileFor(base.substr(0, bar), base.substr(bar + 1), false);
			if (FileExists((BodyDir() / file).string()))
				icons[base] = "icons/mounts/" + file;
		};
		for (const auto& key : g_asked)
			emit(key);
		for (const auto& key : g_faceDiskIndex)
			emit(key);
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string BodyPathFor(const std::string& fid, const std::string& plugin)
	{
		if (fid.empty() || plugin.empty())
			return {};
		const auto file = FileFor(fid, plugin, false);
		if (!FileExists((BodyDir() / file).string()))
			return {};
		return "icons/mounts/" + file;
	}

	std::string NpcIconsJson()
	{
		// Fold the two on-disk indexes into one for the Finder's single icon
		// map. Built by merging their JSON rather than re-walking g_asked so it
		// never has to hold g_mutex across two lock-taking calls. Faces win the
		// (impossible) tie: a face render is always the better picture of a
		// person than a body one, and only a mislabelled record could produce
		// both keys for the same identity.
		nlohmann::json icons = nlohmann::json::object();
		auto merge = [&icons](const std::string& src, bool overwrite) {
			auto j = nlohmann::json::parse(src, nullptr, false);
			if (j.is_discarded() || !j.is_object() || !j.contains("icons") || !j["icons"].is_object())
				return;
			for (auto it = j["icons"].begin(); it != j["icons"].end(); ++it) {
				if (overwrite || !icons.contains(it.key()))
					icons[it.key()] = it.value();
			}
		};
		merge(BodyIndexJson(), true);    // bodies first
		merge(FaceIndexJson(), true);    // faces overwrite on the impossible key clash
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void CaptureBodyAngles(const std::string& fid, const std::string& plugin,
		const std::string& nif)
	{
		if (!Ready() || fid.empty() || plugin.empty() || nif.empty())
			return;
		const auto  baseFile = FileFor(fid, plugin, false);
		std::size_t queued   = 0;
		{
			std::lock_guard l(g_mutex);
			for (std::uint32_t angle = kBodySpinStep; angle < 360u; angle += kBodySpinStep) {
				// Distinct asked-key namespace ("<key>@b045"): never re-derived
				// per open, and never seen by any frame-0 index ('@' skip).
				char akeybuf[8]{};
				std::snprintf(akeybuf, sizeof(akeybuf), "@b%03u", static_cast<unsigned>(angle));
				const std::string akey = KeyOf(fid, plugin) + akeybuf;
				if (g_asked.count(akey))
					continue;
				const auto out = (BodyDir() / AngleFile(baseFile, angle)).string();
				if (FileExists(out)) {   // baked already — keep forever
					g_asked.insert(akey);
					continue;
				}
				if (g_queue.size() >= kMaxQueued)
					break;
				Request r;
				r.outPath = out;
				r.key     = akey;
				r.nifPath = nif;
				r.label   = fid + "|" + plugin + " body @" + std::to_string(angle) + "deg";
				r.angle   = angle;
				g_queue.push_back(std::move(r));
				g_asked.insert(akey);
				++queued;
			}
			if (queued)
				Pump();
		}
		if (queued) {
			logger::info("item icons: {} mount turntable frame(s) queued for {}|{}", queued, fid, plugin);
			StartWatcher();
		}
	}

	std::string FaceIndexJson()
	{
		nlohmann::json icons = nlohmann::json::object();
		std::lock_guard l(g_mutex);
		static const std::string suffix = "@face";
		// Union of this-session asks and the persisted on-disk truth, each
		// verified against disk — so a face rendered in a PRIOR session is named
		// on the first ask instead of forcing a re-ask/reload (the 2026-08-14
		// "faces aren't saved" fix). Emitted once per identity.
		const auto emit = [&](const std::string& key) {
			if (key.size() <= suffix.size() ||
				key.compare(key.size() - suffix.size(), suffix.size(), suffix) != 0)
				return;
			const auto base = key.substr(0, key.size() - suffix.size());
			if (icons.contains(base))
				return;
			const auto bar = base.find('|');
			if (bar == std::string::npos)
				return;
			const auto file = FileFor(base.substr(0, bar), base.substr(bar + 1), false);
			if (FileExists((FaceDir() / file).string()))
				icons[base] = "icons/npcs/" + file;
		};
		for (const auto& key : g_asked)
			emit(key);
		for (const auto& key : g_faceDiskIndex)
			emit(key);
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string FacePathFor(const std::string& fid, const std::string& plugin)
	{
		// The Followers tab's default-portrait lookup: the render that already
		// exists answers instantly (view-relative path), anything else is "".
		// Same FileFor naming as the render queue, so the two can never drift.
		if (fid.empty() || plugin.empty())
			return {};
		const auto file = FileFor(fid, plugin, false);
		if (!FileExists((FaceDir() / file).string()))
			return {};
		return "icons/npcs/" + file;
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
		std::lock_guard l(g_mutex);
		// Resolve one item key to its on-disk file (newest wins: the swap-rendered
		// "-s2" name is preferred whenever it exists, the plain one is the
		// fallback — which is also what quietly retires the untextured icons).
		// Returns "" when neither file exists, so a purged/never-rendered key is
		// simply omitted. Reused for both key sources below.
		auto resolve = [&](const std::string& key) -> std::string {
			const auto bar = key.find('|');
			if (bar == std::string::npos)
				return {};
			const auto swapped = FileFor(key.substr(0, bar), key.substr(bar + 1), true);
			const auto plain   = FileFor(key.substr(0, bar), key.substr(bar + 1), false);
			if (FileExists((IconDir() / swapped).string()))
				return "icons/items/" + swapped;
			if (FileExists((IconDir() / plain).string()))
				return "icons/items/" + plain;
			return {};
		};
		// The index is the UNION of what was asked this session and what a prior
		// session left on disk (g_diskIndex), each re-verified to still exist.
		// g_asked first so a freshly-rendered icon is named the instant it lands;
		// g_diskIndex fills in every older icon the current session never re-asked
		// (the vanishing-icon bug). Turntable frame keys ("<key>@045") are NOT
		// frame-0 icons — the view derives their URLs itself off the frame-0
		// entry — so any '@' key is skipped.
		for (const auto& key : g_asked) {
			if (key.find('@') != std::string::npos || icons.contains(key))
				continue;
			const auto rel = resolve(key);
			if (!rel.empty())
				icons[key] = rel;
		}
		for (const auto& key : g_diskIndex) {
			if (icons.contains(key))
				continue;
			const auto rel = resolve(key);
			if (!rel.empty())
				icons[key] = rel;
		}
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string IconPathIfRendered(const std::string& fid, const std::string& plugin)
	{
		// The single-item twin of IndexJson()'s resolve lambda — same swap-first
		// order (the "-s2" name wins whenever it exists, plain is the fallback),
		// so the path stamped into fdWorn can never disagree with the wdItemIcons
		// map for the same piece. NO queue, NO g_asked mutation: a piece with no
		// PNG yet returns "" and is left for the view's lazy whIcons request. Two
		// FileExists() probes; the g_mutex is not needed (FileFor is pure, disk
		// reads are their own truth), but taking it keeps us consistent with the
		// other read-only exports and cheap enough on the equipped read path.
		if (fid.empty() || plugin.empty())
			return {};
		std::lock_guard l(g_mutex);
		const auto swapped = FileFor(fid, plugin, true);
		const auto plain   = FileFor(fid, plugin, false);
		if (FileExists((IconDir() / swapped).string()))
			return "icons/items/" + swapped;
		if (FileExists((IconDir() / plain).string()))
			return "icons/items/" + plain;
		return {};
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

		/* Persist the face/body render index so a rendered face survives a game
		 * restart in the DLL's memory (the "faces always reload" fix). Unlike
		 * item-icons.json this stores the SUFFIXED keys ('...@face'/'...@body')
		 * verbatim, so LoadFaceDiskIndex round-trips them straight back into
		 * g_faceDiskIndex. Paths are included for the portal / a human reader but
		 * are re-resolved against disk on read. Union of the persisted set and
		 * this session's asks; a since-deleted PNG is dropped. g_mutex NOT held
		 * on entry — takes it briefly to snapshot the keys. */
		void WriteNpcIndexFile()
		{
			nlohmann::json icons = nlohmann::json::object();
			{
				std::lock_guard l(g_mutex);
				const auto add = [&](const std::string& key) {
					const bool face = key.size() >= 5 && key.compare(key.size() - 5, 5, "@face") == 0;
					const bool body = key.size() >= 5 && key.compare(key.size() - 5, 5, "@body") == 0;
					if (!face && !body)
						return;
					if (icons.contains(key))
						return;
					const auto base = key.substr(0, key.size() - 5);
					const auto bar = base.find('|');
					if (bar == std::string::npos)
						return;
					const auto file = FileFor(base.substr(0, bar), base.substr(bar + 1), false);
					const auto dir = face ? FaceDir() : BodyDir();
					if (FileExists((dir / file).string()))
						icons[key] = (face ? "icons/npcs/" : "icons/mounts/") + file;
				};
				for (const auto& key : g_faceDiskIndex)
					add(key);
				for (const auto& key : g_asked)
					add(key);
			}
			const auto path = NpcIndexFile();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			std::ofstream out(path, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) } }
						.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}
}
