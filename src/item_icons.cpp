#include "item_icons.h"
#include "item_icon_paths.h"
#include "facegen_resolver.h"
#include "npc_finder.h"

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
#include <unordered_map>
#include <unordered_set>
#include <vector>

/* Mesh Rendering Framework's OWN public API header, vendored (2026-08-20).
 *
 * Generated from upstream's `MeshRenderingFrameworkAPI.h` by
 * modding/tools/gen_mrf_header.py — the one way this repo obtains MRF's API,
 * shared with Preset Director (modding/preset-director/src/director.cpp is the
 * in-repo precedent). It is COMMITTED here rather than generated at build time
 * because the build door copies `src/*` into the xmake workspace and builds —
 * there is no step in that path that could run python first, so a generated-but-
 * uncommitted header would simply be missing. The generator's docstring says the
 * same thing from the other side, and README.md has the regenerate command.
 *
 * WHY IT REPLACED THE OLD ARRANGEMENT. This file used to hand-type MRF's export
 * signatures and hand-mirror its IMesh struct, on the strength of a comment
 * claiming the framework "only exports four C functions". That was true of
 * v3.0.0 and is not true today, and the mirror had already drifted: upstream's
 * IMesh grew `bodyTintColor[3]` + `useBodyTint` (MeshRenderingFrameworkAPI.h
 * :43-44), so the real struct is 0x98 bytes and our mirror still static_asserted
 * 0x88 — an assert that only ever checked the mirror against ITSELF. Nothing was
 * corrupted by that (we never read or write past 0x81), but the drift was
 * invisible, which is the actual defect. Below, every offset is now checked
 * against upstream's real type by the compiler.
 *
 * `--core-only`: the generated header keeps the IMesh ABI, GetFunction and every
 * IMesh_* soft-bind wrapper (verbatim upstream text) and drops MRF's
 * NPC-composition helper layer. We call none of that layer — the face path here
 * composes head + wig itself and is deliberately frozen — and it is a wall of
 * non-template inline functions reaching deep into CommonLibSSE-NG, which would
 * be compiled whether called or not. See the generator for the full list.
 *
 * NOT vendored, and still hand-declared below: `IMesh_SetShapeTextureSet`. That
 * export is OURS (mrf-build patch zz-shape-textureset.patch), so it is absent
 * from upstream's header by definition. */
#include "mrf_api.h"

// mrf_api.h brings <d3d11.h>, which re-pulls windows.h — and windows.h defines
// min/max as MACROS unless NOMINMAX was set before it, swallowing every
// std::min/std::max in the translation unit behind useless diagnostics
// ("illegal token on right side of '::'" then a cascade of unmatched braces).
// portrait_capture.cpp, keys_scan.cpp and spellcraft_actions.cpp all pay this
// tax already; undef here rather than fight the include order. (This file's one
// use is written `(std::min)(…)`, which is immune on its own — the guard is so
// that ADDING a plain std::min later cannot resurrect the failure.)
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

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

		// THE MIRROR (2026-10-03) — the person page's full-body figure. Square on
		// purpose: MRF fits a bounding SPHERE into the canvas, and a standing body's
		// sphere is as wide as it is tall, so a square canvas is the one aspect we
		// know the framework draws undistorted. The view crops the empty sides by
		// LAYOUT (Ultralight rasterises an <img> at its layout size). 24 frames, 15°
		// apart, so a drag reads as a turn rather than a slideshow.
		constexpr std::uint32_t kMirrorSize  = 1024;   // ~1:1 with a ~950px stage; 24 frames stay cheap
		constexpr std::uint32_t kMirrorStep  = 15;
		// Bump to re-bake every mirror figure after a look-affecting change here.
		constexpr std::uint32_t kMirrorEpoch = 1;

		/* THE ITEM INSPECTOR (2026-10-04, Rober on SeverActions' Catalog: "also
		 * interesting.... (toggable maybe)"). The lightbox's own turntable is 4
		 * frames at 512px, kept cheap on purpose; "Turn in 3D" is the opt-in big
		 * one: the Mirror's 24 frames 15° apart, at the Mirror's 1024px, through
		 * the SAME item route frame 0 takes (look, texture swaps, box fit). Its
		 * frames live in their own folder so the two lanes never share a name. */
		constexpr std::uint32_t kInspectSize = 1024;
		constexpr std::uint32_t kInspectStep = 15;

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

		/* ⛔ A PAUSED GAME IS NOT AN IDLE GPU. The pacing below used to stop
		 * entirely whenever the world was not being drawn — "nothing to protect".
		 * Half true: the world is not drawn, but the MENU is, and on this rig it
		 * is composited through the upscaler. Measured 2026-08-17 from three deck
		 * opens in one session: the one that coincided with 26 queued renders
		 * took `paint 1572 ms`, against 105 ms and 46 ms for the opens either
		 * side of it. Rober's words for that session were "intense lag ...
		 * opening menu" and "basically unplayable".
		 *
		 * So a menu now gets two things. A GRACE window where nothing starts at
		 * all, so the palette's first paint is never raced — that is the one the
		 * player feels — and a modest gap between starts afterwards, so browsing
		 * stays smooth. Both are far shorter than the live-play gaps: a paused
		 * game really can afford more render work, just not unbounded work. */
		constexpr auto kMenuOpenGrace = std::chrono::milliseconds(900);
		constexpr auto kPaceGapMenu   = std::chrono::milliseconds(160);

		// After the first load of a session settles, hold the IDLE tier off the
		// D3D device entirely for this long while the game is LIVE — the window
		// where the cell is streaming in and every stolen frame is felt hardest.
		// The warm-start's whole point is "the first MINUTES show real faces", so
		// starting a minute in costs nothing it promised and spares the load-in.
		// Paused time (deck/menus/load screen) does not count against it — see
		// GamePaused in Pump. User renders are never delayed by this.
		constexpr auto kIdleSettleDelay = std::chrono::seconds(45);

		// ...and hold it off for this long after a LOAD SCREEN closes, regardless
		// of whether the game is paused (2026-08-16). kIdleSettleDelay above is
		// bypassed whenever the world is not being drawn — deliberately, so that
		// opening the Finder right after boot still fills with faces. But the
		// player opening the deck ten seconds after a load would then release the
		// whole warm-start burst at paused full-speed while the cell is STILL
		// streaming behind the paused palette, which is the tail of the same
		// startup stutter. This is the "no loading menu for N seconds" gate: it
		// narrows the IDLE tier only — a page the player actually opened renders
		// immediately, always.
		constexpr auto kPostLoadIdleHold = std::chrono::seconds(12);

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

		// How long the watcher will keep pumping a batch. A 600-tick budget (~7 min)
		// cut the 2026-08-02 batch off mid-flight: four pieces armed at 21:22:35
		// were only retired at 21:24:32, when an unrelated EnsureIcons() happened to
		// pump. A batch that keeps making progress must be allowed to finish; the
		// loop still exits the instant the queues and the in-flight list are all
		// empty, so this cap only bounds a batch that is genuinely stuck. Wall-clock
		// rather than a tick count, because the tick is now adaptive (below).
		constexpr auto kWatchMax = std::chrono::minutes(58);

		/* How often the watcher looks. The pump is the ONLY place a render is
		 * started and the only place a finished one is retired, so the tick is a
		 * hard ceiling on throughput for whatever the player is waiting on. The
		 * flat 700 ms was well under the render cost while the world was being
		 * drawn, but far over it with the deck open (renders measured ~250-700 ms
		 * on 2026-08-19, started 700 ms apart) — so a user batch crawled at the
		 * watcher's speed, not the framework's. It now ticks fast while any USER
		 * work is queued or in flight and drops back to the quiet tick otherwise.
		 * kTickUser stays comfortably above kPaceGapMenu so the menu-paint pacing,
		 * not the watcher, remains the thing that spaces starts. */
		constexpr auto kTickIdle = std::chrono::milliseconds(700);
		constexpr auto kTickUser = std::chrono::milliseconds(250);

		// MRF's real types, from its real header. Everything below that used to be
		// hand-typed is now derived from these.
		namespace MRF = MeshRenderingFrameworkAPI;
		using MrfMesh  = MRF::Internal::IMesh;

		/* ── the framework's IMesh, as a flat-float VIEW ─────────────────────
		 * `MrfMesh` above IS the framework's struct now — this is not a second
		 * definition of it, it is a same-layout view that spells the vector
		 * fields as plain float arrays.
		 *
		 * WHY THE VIEW SURVIVES the header adoption, since a view is exactly the
		 * kind of thing this change exists to delete: the clutter fit reads the
		 * bounds as `abi->boundMax[0]` and lives inside the machine-guarded
		 * ⛔ RENDER-GEOMETRY region (scripts/guarded-regions.py). Upstream spells
		 * those fields RE::NiPoint3, so using MrfMesh directly there would mean
		 * editing fenced lines — and a commit touching that region owes an in-game
		 * A/B trailer, which a no-visual-change refactor has no business spending.
		 * The fit is what makes a potion fill its frame and what keeps its bottom
		 * half out of the near plane; it is not a refactor target. So the view
		 * stays, and the asserts below make it impossible for it to drift.
		 *
		 * That is the real change here. The old asserts checked this struct's
		 * offsets against HARDCODED NUMBERS — i.e. against itself — which is why
		 * nobody noticed upstream growing `bodyTintColor` + `useBodyTint` past the
		 * asserted 0x88 size. Every offset is now ALSO compared to the same field
		 * of the framework's own type, so a future upstream re-pad is a build
		 * error in this file instead of a silent misread at runtime.
		 *
		 * The absolute numbers are kept beside the cross-checks on purpose: they
		 * are the layout the deployed DLL was disassembled at, so if the two ever
		 * disagree the failing assert says WHICH side moved. */
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

		/* ── and the same offsets against the FRAMEWORK'S OWN TYPE ───────────
		 * The view may only ever be read through fields that land in the same
		 * place upstream puts them. `sizeof` is deliberately `<=`, not `==`:
		 * upstream's struct legitimately carries two more fields after
		 * `alwaysUpdate` (bodyTintColor, useBodyTint) that this view has no
		 * business knowing about — it must never be the LARGER of the two, which
		 * is the only version of that comparison that could hurt anyone. */
		static_assert(offsetof(MrfMesh, id) == offsetof(IMeshAbi, id), "IMesh view drifted from MRF: id");
		static_assert(offsetof(MrfMesh, rotation) == offsetof(IMeshAbi, rotation), "IMesh view drifted from MRF: rotation");
		static_assert(offsetof(MrfMesh, position) == offsetof(IMeshAbi, position), "IMesh view drifted from MRF: position");
		static_assert(offsetof(MrfMesh, boundMin) == offsetof(IMeshAbi, boundMin), "IMesh view drifted from MRF: boundMin");
		static_assert(offsetof(MrfMesh, boundMax) == offsetof(IMeshAbi, boundMax), "IMesh view drifted from MRF: boundMax");
		static_assert(offsetof(MrfMesh, scale) == offsetof(IMeshAbi, scale), "IMesh view drifted from MRF: scale");
		static_assert(offsetof(MrfMesh, width) == offsetof(IMeshAbi, width), "IMesh view drifted from MRF: width");
		static_assert(offsetof(MrfMesh, height) == offsetof(IMeshAbi, height), "IMesh view drifted from MRF: height");
		static_assert(offsetof(MrfMesh, texture) == offsetof(IMeshAbi, texture), "IMesh view drifted from MRF: texture");
		static_assert(offsetof(MrfMesh, SRV) == offsetof(IMeshAbi, SRV), "IMesh view drifted from MRF: SRV");
		static_assert(offsetof(MrfMesh, saveNextFrame) == offsetof(IMeshAbi, saveNextFrame), "IMesh view drifted from MRF: saveNextFrame");
		static_assert(offsetof(MrfMesh, deleteAfterSave) == offsetof(IMeshAbi, deleteAfterSave), "IMesh view drifted from MRF: deleteAfterSave");
		static_assert(offsetof(MrfMesh, savePath) == offsetof(IMeshAbi, savePath), "IMesh view drifted from MRF: savePath");
		static_assert(offsetof(MrfMesh, mustUpdate) == offsetof(IMeshAbi, mustUpdate), "IMesh view drifted from MRF: mustUpdate");
		static_assert(offsetof(MrfMesh, alwaysUpdate) == offsetof(IMeshAbi, alwaysUpdate), "IMesh view drifted from MRF: alwaysUpdate");
		static_assert(sizeof(IMeshAbi) <= sizeof(MrfMesh), "IMesh view is larger than MRF's own struct");
		static_assert(sizeof(float[9]) == sizeof(MrfMesh::rotation), "IMesh view: rotation is not a 3x3 float block");
		static_assert(sizeof(float[3]) == sizeof(MrfMesh::boundMin), "IMesh view: boundMin is not a float triple");

		/* ── binding (soft, like the FollowerOrganizer bridge) ───────────────
		 * The SIGNATURES are upstream's, taken off its own declarations — never
		 * hand-typed here again. `decltype(&…)` of an inline wrapper yields the
		 * exact function-pointer type the export has, calling convention
		 * included, so a signature change upstream is a compile error rather than
		 * a stack corruption.
		 *
		 * We still resolve and CALL through raw pointers instead of using the
		 * header's inline wrappers directly, for one reason: every call into the
		 * framework goes through an SEH shim below (`Call*`, __try/__except on
		 * ACCESS_VIOLATION), and those shims must stay POD-only bodies calling a
		 * plain pointer. Upstream's wrapper adds a function-local static module
		 * handle; putting that inside a __try is a compile risk for no gain, and
		 * this file's whole reason for existing is that MRF has faulted on us. */

		using CreateByNifFn     = decltype(&MRF::Internal::IMesh_CreateByNifPath);
		using DeleteFn          = decltype(&MRF::Internal::IMesh_Delete);
		// Our own MRF patch (zz-shape-textureset.patch, from-source build): a
		// per-shape texture-set override with NO skin gate — the export the
		// new-architecture framework needs before a retexture VARIANT (the
		// yeti-cap lesson) can render true. Absent on stock/older MRF builds,
		// in which case swaps stay latched off exactly as before.
		//
		// The ONE signature still written out by hand, and necessarily so: this
		// export does not exist upstream, so upstream's header cannot declare it.
		// Its shape is fixed by our own patch (include/API.h in the patch), and
		// the mesh parameter stays `void*` rather than MrfMesh* so the call site
		// in ApplySwapViaApi needs no cast — upstream declares it IMesh*, which is
		// the same pointer.
		using SetShapeTexFn     = bool (*)(void*, const char*, std::uint32_t,
			const char* const*, std::uint32_t);
		// Compose ONE render out of several NIFs — the export MRF's own
		// CreateWholeNpc uses to bolt head parts onto a body. We use it for
		// exactly one thing: a facegen head plus the WIG that head cannot
		// contain (see HairNifsForFace). Soft-bound like everything else here:
		// if it does not resolve, faces render bare-facegen exactly as before.
		using CreateBySetFn     = decltype(&MRF::Internal::IMesh_CreateByNifPathSet);

		CreateByNifFn     g_createByNif     = nullptr;
		DeleteFn          g_delete          = nullptr;
		SetShapeTexFn     g_setShapeTex     = nullptr;
		CreateBySetFn     g_createBySet     = nullptr;
		// The mirror's skin-texture overrides (upstream export, CreateWholeNpc's
		// own call). Optional: without it a body renders in its NIF's textures.
		using SetTexSetFn       = decltype(&MRF::Internal::IMesh_SetTextureSet);
		SetTexSetFn       g_setTexSet       = nullptr;

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

		/* ── render priority tiers ──────────────────────────────────────────
		 * Rober, 2026-08-19: "needs to prioritize if i hit f7 to load quickly,
		 * efficiently". He pressed F7 on Scarlett at 22:50:23 and her equipped
		 * tiles were glyphs for ~45 s. The log says exactly why: 260 ms BEFORE
		 * the card's own ask, the wardrobe's speculative catalogue sweep
		 * (EnsureIcons — "59 armour render(s) queued") had appended 59 renders
		 * to the SAME deque, and the card's three landed behind all of them in
		 * a strict FIFO ('Whiterun Heavy Gauntlets' rendered at 22:51:06). The
		 * two-tier design was sound and simply had the wrong things in the
		 * front tier: everything that was not the boot warm-start counted as
		 * "user".
		 *
		 * So a sweep is no longer a user ask:
		 *   User — a surface the player is looking at RIGHT NOW: the F7 quick
		 *          card's worn tiles, a Finder/Items/NPCs query, the wardrobe
		 *          rows on screen, follower faces on an open tab, the wheel /
		 *          hotbar / Potion Browser / Quiver popouts, a turntable being
		 *          dragged. Drains completely before anything else STARTS.
		 *   Bulk — speculative catalogue work nobody is waiting on this frame
		 *          (EnsureIcons' walk of wardrobe-inventory/catalogue). Runs
		 *          promptly when the user tier is empty, is preempted by the
		 *          next user ask, and never occupies the reserved slot.
		 *   Idle — the boot warm-start and the resumed backlog: also gated by
		 *          the settle/post-load holds, so it is the quietest lane.
		 */
		enum class Tier : std::uint8_t
		{
			User = 0,
			Bulk = 1,
			Idle = 2,
		};

		const char* TierName(Tier t)
		{
			return t == Tier::User ? "user" : (t == Tier::Bulk ? "bulk" : "idle");
		}

		/* One texture-set override for a whole-body render: the skin texture set
		 * an exposed body/hands/feet piece must wear (a follower's custom skin), the
		 * exact shape upstream's CreateWholeNpc hands IMesh_SetTextureSet. */
		struct WholeTex
		{
			std::string              nifPath;
			std::vector<std::string> paths;   // one per BSTextureSet slot, "" = keep the NIF's own
			bool                     modelSpaceNormals{ false };
			bool                     includeBodyShape{ false };
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
			// This request is the ONE retry allowed after the renderer refused the
			// picture it made (see the rejection marker in Pump). It re-renders on
			// the framework's own bounding-sphere fit — the most conservative framing
			// there is — and, whatever it produces, is never retried again: a second
			// refusal goes to the failure ledger and the tile keeps its glyph. Renders
			// are keep-forever, so "never write a bad one" outranks any repair path.
			bool                fallback{ false };
			// Extra NIFs composed onto nifPath in ONE mesh (IMesh_CreateByNifPathSet).
			// FACE renders only, and only ever the NPC's wig — see HairNifsForFace.
			// Empty (the common case) keeps the plain single-NIF create untouched.
			std::vector<std::string> extraNifs;
			// Which lane this came from — see Tier. Carried into InFlight so a
			// swap-retry is re-armed at its OWN priority (a bulk piece that has
			// to fall back to the bare mesh must not jump the user queue) and so
			// the watcher can tell whether anyone is waiting on the render.
			Tier                tier{ Tier::User };
			// THE MIRROR: a whole dressed body (worn gear + skin + facegen head)
			// composed from nifPath + extraNifs. Never retried as the bare base nif
			// on a refusal — the base is one armour piece, not a picture of anyone.
			bool                  whole{ false };
			// The surface that asked ("finder"), or "" for everyone else. A tagged
			// ask may REPLACE its own earlier asks still waiting in the user queue:
			// see the supersede step in EnsureIconsForList.
			std::string           owner;
			std::vector<WholeTex> tex;
			float                 tint[3]{ 1.0f, 1.0f, 1.0f };
			bool                  useTint{ false };
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
			bool                                  refit{ false }; // FitClutter this item render
			bool                                  fallback{ false }; // the one conservative retry
			// Built as head + wig (extraNifs). A refused COMPOSED face is retried
			// once as the bare facegen head — see the refusal branch in Pump.
			bool                                  composed{ false };
			Tier                                  tier{ Tier::User };   // the lane it started from
			std::chrono::steady_clock::time_point armed{};
			// No node is kept alive here any more: the framework clones the model
			// synchronously inside the create call (see ApplySwaps), so nothing of
			// ours has to outlive it.
		};

		std::mutex                      g_mutex;
		// USER tier — a surface the player is looking at right now. Pump() drains
		// this completely (per budget) before anything else STARTS, and the newest
		// batch is rotated to its FRONT (FrontLoadUserBatch), so pressing F7 beats
		// the Finder page you scrolled past a minute ago.
		std::deque<Request>             g_queue;
		// BULK tier — the wardrobe's speculative catalogue sweep. Nobody is waiting
		// on these THIS frame (every row actually on screen asks through
		// EnsureIconsForList, which is user tier), so they must never sit in front
		// of a user ask. Same Request shape, same in-flight machinery, same
		// render-once dedup; only the ORDER of starting differs.
		std::deque<Request>             g_bulkQueue;
		// IDLE tier (render warm-start + the resumed backlog): proactively-queued
		// renders that must NEVER delay a user-requested one, and that additionally
		// respect the settle / post-load holds. Capped separately (kMaxIdleQueued)
		// so a warm-start can never crowd out the user queue's headroom.
		std::deque<Request>             g_idleQueue;
		std::vector<InFlight>           g_inFlight;
		std::unordered_set<std::string> g_asked;   // key -> queued/failed this session

		// The one place that maps a tier to its deque and its ceiling, so a new
		// lane can never be half-wired.
		std::deque<Request>& QueueFor(Tier t)
		{
			return t == Tier::User ? g_queue : (t == Tier::Bulk ? g_bulkQueue : g_idleQueue);
		}
		std::size_t CapFor(Tier t) { return t == Tier::Idle ? kMaxIdleQueued : kMaxQueued; }

		// How many renders are in flight for lanes NOBODY is waiting on. g_mutex held.
		std::size_t BackgroundInFlight()
		{
			std::size_t n = 0;
			for (const auto& job : g_inFlight)
				if (job.tier != Tier::User)
					++n;
			return n;
		}

		/* The newest user ask goes to the FRONT of the user queue. g_mutex held.
		 *
		 * Within one tier a plain FIFO still gets the ordering wrong for the
		 * thing Rober actually asked for: open the Finder (20 tiles queued),
		 * then press F7 on someone — the card's tiles would be 21st. The
		 * surface on screen NOW is the one being waited on, so each public
		 * entry point records the queue length before its walk and rotates
		 * whatever it appended (its own new asks AND anything it promoted out
		 * of bulk/idle) to the front, order within the batch preserved. The
		 * older batch is not dropped — it renders straight after. */
		void FrontLoadUserBatch(std::size_t before)
		{
			if (before < g_queue.size())
				std::rotate(g_queue.begin(),
					g_queue.begin() + static_cast<std::ptrdiff_t>(before), g_queue.end());
		}

		/* The line that makes the next "slow tiles" report diagnosable: what a
		 * user ask found in front of it, per tier. Without it the 2026-08-19
		 * diagnosis needed a 1,000-line log read to discover that 59 bulk
		 * renders had been queued 260 ms earlier. g_mutex held.
		 * Build marker (hd-markers.json: "render-priority-user-first"). */
		void LogUserAskDepth(const char* who, std::size_t added, std::size_t promoted)
		{
			logger::info("item icons: render-priority — {} ask (+{} new, {} promoted) is now FIRST; "
						 "waiting: user {} / bulk {} / idle {}, in flight {} ({} background)",
				who, added, promoted, g_queue.size(), g_bulkQueue.size(), g_idleQueue.size(),
				g_inFlight.size(), BackgroundInFlight());
		}

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

		// Landing pushes and index-file writes are coalesced (see the watcher).
		// Main thread only: read and written inside the watcher's SKSE tasks.
		constexpr auto kNotifyGap    = std::chrono::milliseconds(750);
		constexpr auto kIndexFileGap = std::chrono::seconds(10);
		bool                                  g_notifyPending    = false;
		bool                                  g_indexFilePending = false;
		std::chrono::steady_clock::time_point g_lastNotify{};
		std::chrono::steady_clock::time_point g_lastIndexFile{};

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

		// Once-per-burst too: a user ask that could not START because the in-flight
		// budget was full. That is the ONLY thing that can still delay a user ask
		// once the tiers and the reserved slot are in place, so it must be visible
		// in the log rather than inferred — see the user-loop tail in Pump().
		bool g_userWaitLogged = false;

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
		// When a load screen was last seen up (see LoadingNow). Default-constructed
		// means "never", which makes the post-load hold below a no-op until the
		// first real load — a session that never loads is never held. Main thread
		// only (Pump).
		std::chrono::steady_clock::time_point g_lastLoadingSeen{};
		bool                                  g_loadHoldLogged = false;

		// The framework keeps our savePath pointer and reads it a frame later;
		// a deque never invalidates references to existing elements.
		std::deque<std::string> g_savePaths;

		std::function<void()> g_onBatchDone;

		// The render-folder listings the index builders read (defined beside
		// FileExists). Declared here so the purge helpers above them can drop them.
		void InvalidateListings();

		/* ── SEH-guarded calls (POD-only wrappers, C2712) ──────────────────── */

		MrfMesh* CallCreateByNif(CreateByNifFn a_fn, const char* a_nif, std::uint32_t a_w, std::uint32_t a_h) noexcept
		{
			__try {
				return a_fn(a_nif, a_w, a_h);
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return nullptr;
			}
		}

		MrfMesh* CallCreateBySet(CreateBySetFn a_fn, const char* const* a_base, std::uint32_t a_baseCount,
			const char* const* a_attach, std::uint32_t a_attachCount,
			std::uint32_t a_w, std::uint32_t a_h) noexcept
		{
			__try {
				return a_fn(a_base, a_baseCount, a_attach, a_attachCount, a_w, a_h);
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return nullptr;
			}
		}

		bool CallDelete(DeleteFn a_fn, void* a_mesh) noexcept
		{
			__try {
				// The cast is the same pointer: `a_mesh` is only ever an IMesh* the
				// framework itself handed back. It is spelled void* through this
				// file's plumbing (InFlight::mesh) so no caller needs the type.
				a_fn(static_cast<MrfMesh*>(a_mesh));
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

		// One BASE nif (the facegen head) + N attachments (the wig), composed by
		// the framework into a single mesh. Returns null for every "not possible"
		// case so the caller can simply fall through to the bare-head create —
		// a missing wig must never cost a face its render.
		void* SafeCreateByNifSet(const std::string& basePath,
			const std::vector<std::string>& extras, std::uint32_t px)
		{
			if (!g_createBySet || basePath.empty() || extras.empty())
				return nullptr;
			std::vector<const char*> attach;
			attach.reserve(extras.size());
			for (const auto& e : extras)
				if (!e.empty())
					attach.push_back(e.c_str());
			if (attach.empty())
				return nullptr;
			const char* base[1] = { basePath.c_str() };
			try {
				return CallCreateBySet(g_createBySet, base, 1u, attach.data(),
					static_cast<std::uint32_t>(attach.size()), px, px);
			} catch (...) {
				logger::warn("item icons: IMesh_CreateByNifPathSet threw — bare head for '{}'", basePath);
				return nullptr;
			}
		}

		bool CallSetTexSet(SetTexSetFn a_fn, void* a_mesh, const char* a_nif, const char* const* a_paths,
			std::uint32_t a_count, bool a_msn, bool a_body) noexcept
		{
			__try {
				return a_fn(static_cast<MrfMesh*>(a_mesh), a_nif, a_paths, a_count, a_msn, a_body);
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		// Dress a freshly composed mirror mesh: skin texture sets + body tint, the
		// two things upstream's CreateWholeNpc does after its create call. Every
		// step is best-effort — a body in its NIF's own textures is still a body.
		void ApplyWholeLook(void* mesh, const Request& r)
		{
			std::size_t applied = 0;
			if (g_setTexSet) {
				for (const auto& t : r.tex) {
					std::vector<const char*> paths;
					paths.reserve(t.paths.size());
					for (const auto& p : t.paths)
						paths.push_back(p.c_str());
					if (CallSetTexSet(g_setTexSet, mesh, t.nifPath.c_str(), paths.data(),
							static_cast<std::uint32_t>(paths.size()), t.modelSpaceNormals, t.includeBodyShape))
						++applied;
				}
			}
			if (r.useTint) {
				auto* m = static_cast<MrfMesh*>(mesh);
				m->bodyTintColor[0] = r.tint[0];
				m->bodyTintColor[1] = r.tint[1];
				m->bodyTintColor[2] = r.tint[2];
				m->useBodyTint      = true;
			}
			logger::info("mirror: '{}' composed - {} skin texture set(s) of {}, tint {}",
				r.label, applied, r.tex.size(), r.useTint ? "on" : "off");   // marker: mirror-compose
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
		 * ⚠ KEPT ON PURPOSE — it is NOT a duplicate of anything upstream, whatever
		 * a reading of MRF's source suggests at a glance (checked 2026-08-20 against
		 * master @afc369a + our 16-patch stack). MRF does carry a `Menu::IsOpen()`
		 * — include/Menu.h, `IsApplicationMenuOpen || IsItemMenuOpen ||
		 * IsModalMenuOpen || GameIsPaused` — and it is DEAD CODE: nothing in
		 * src/*.cpp or include/*.h calls it, so the framework does not skip a
		 * render for any menu. It is also a different question (four broad UI
		 * predicates, one of which is "the game is paused" — the deck pauses the
		 * game, so adopting it would stop every render the palette asks for).
		 * Deleting this in favour of "MRF's own skip logic" would be deleting a
		 * gate and adopting nothing. Don't.
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

		// The item inspector's frames (kInspectSize renders, -aNNN at kInspectStep).
		std::filesystem::path InspectDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "inspect";
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
		constexpr int kFaceGenEpoch = 4;   // 2026-08-19: hair-only head-part filter (`.any(kHair)` leaked eyes/brows as attachments -> default eyeball drew over the real eyes)

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
		constexpr int kSwapRenderEpoch = 1;   // 2026-08-20: the PARTIAL-override fix (a BGSTextureSet names only the slots the variant changes, but the framework's per-shape override wrote all 8 — so every slot the record left empty CLEARED the texture the NIF had, and a missing map renders as solid white; every "-s2" render baked through the swap route since the new architecture went live can be washed out)
		constexpr int kItemRenderEpoch = 2;   // 2026-08-19: swept-cylinder fit (the X/Z box-fit ignored model-Y, so deep meshes rendered with the camera inside them and every turntable angle was framed differently)

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
				auto ext = PathU8(it->path().extension());
				for (auto& c : ext)
					c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
				if (ext != ".png")
					continue;
				std::error_code del;
				std::filesystem::remove(it->path(), del);
				if (!del)
					++n;
			}
			if (n) {
				InvalidateListings();
				logger::info("item icons: purged {} stale render(s) from {}", n, PathU8(dir));
			}
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
			DeletePngsIn(FaceGeomDir().parent_path() / "bodies");   // the mirror's figures

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
		std::unordered_map<std::string, std::uint64_t> g_itemRevisions;

		void LoadDiskIndex()
		{
			std::ifstream in(ItemIndexFile(), std::ios::binary);
			if (!in.is_open())
				return;
			auto j = nlohmann::json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object() || !j.contains("icons") || !j["icons"].is_object())
				return;
			// Persisted separately from the PNG list: a failed/pending regeneration
			// must not resurrect its old picture after a restart.
			if (j.contains("revisions") && j["revisions"].is_object()) {
				for (auto it = j["revisions"].begin(); it != j["revisions"].end(); ++it)
					if (it.value().is_number_unsigned() && it.key().find('|') != std::string::npos &&
						it.key().find('@') == std::string::npos) {
						g_itemRevisions[it.key()] = it.value().get<std::uint64_t>();
						g_diskIndex.insert(it.key());
					}
			}
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

		/* ── The unfinished-render backlog (icon-backlog.json) ────────────────
		 * The queues are memory-only, so a render still WAITING when the game
		 * exits used to be silently dropped — it came back only if the same
		 * pane re-asked next session. That is the one place a "thumbnail"
		 * was not remembered across a reload (Rober, 2026-08-19: anywhere
		 * thumbnails generate must persist and be remembered on reload). So:
		 * every accepted ask is written here as {formId, plugin, name, kind
		 * [,nif]}, dropped the moment its PNG lands (or the miss is proven
		 * permanent: no world model / no facegen file), and REPLAYED at the
		 * next Init through the exact same enqueue doors — idle tier, so a
		 * resumed backlog can never delay a page the player actually opens.
		 * Entries the idle ceiling refuses stay in the file and resume on a
		 * later boot; nothing is ever lost, only deferred. Saves are cheap
		 * (one small json) and happen after every ask burst plus every
		 * watcher tick while work is pending. */
		std::unordered_map<std::string, nlohmann::json> g_backlog;
		bool                                            g_backlogDirty = false;
		constexpr std::size_t                           kMaxBacklog = 1024;

		std::filesystem::path BacklogFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icon-backlog.json";
		}

		// g_mutex held.
		void BacklogAdd(const std::string& key, const std::string& fid, const std::string& plugin,
			const std::string& name, const char* kind, const std::string& nif = std::string())
		{
			if (g_backlog.size() >= kMaxBacklog && !g_backlog.count(key))
				return;   // a runaway caller cannot grow the file without bound
			nlohmann::json e{ { "formId", fid }, { "plugin", plugin }, { "name", name }, { "kind", kind } };
			if (!nif.empty())
				e["nif"] = nif;
			g_backlog[key] = std::move(e);
			g_backlogDirty = true;
		}

		// g_mutex held.
		void BacklogDrop(const std::string& key)
		{
			if (g_backlog.erase(key))
				g_backlogDirty = true;
		}

		// Snapshot under the lock, write outside it (the write is file IO).
		void BacklogSaveIfDirty()
		{
			std::string out;
			{
				std::lock_guard l(g_mutex);
				if (!g_backlogDirty)
					return;
				g_backlogDirty = false;
				nlohmann::json pending = nlohmann::json::object();
				for (const auto& [k, v] : g_backlog)
					pending[k] = v;
				out = nlohmann::json{ { "v", 1 }, { "pending", std::move(pending) } }
				          .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			std::error_code ec;
			std::filesystem::create_directories(BacklogFile().parent_path(), ec);
			std::ofstream f(BacklogFile(), std::ios::binary | std::ios::trunc);
			if (f.is_open())
				f << out;
		}

		/* Is this render's stem a SWAP render ("<slug>-<hex>-s2")? A turntable frame
		 * carries its angle AFTER the swap marker ("…-s2-a090"), so a bare "ends with
		 * -s2" test files the spun frames as PLAIN renders and a set gets purged in
		 * half — frame 0 kept, the spins deleted — which is exactly the self-
		 * disagreement epoch 2 set out to end. Strip a trailing "-aNNN" first. */
		bool IsSwapRenderStem(std::string stem)
		{
			if (stem.size() >= 5) {
				const std::size_t at = stem.size() - 5;
				if (stem[at] == '-' && stem[at + 1] == 'a' &&
					std::isdigit(static_cast<unsigned char>(stem[at + 2])) &&
					std::isdigit(static_cast<unsigned char>(stem[at + 3])) &&
					std::isdigit(static_cast<unsigned char>(stem[at + 4])))
					stem.erase(at);
			}
			return stem.size() >= 3 && stem.compare(stem.size() - 3, 3, "-s2") == 0;
		}

		/* Item-render generation: purge item icons ONCE after a look-affecting
		 * change to this file (kItemRenderEpoch). The stamp lives beside the item
		 * renders (icons/items/.render-gen). Unlike the facegen check this keys on
		 * the epoch ALONE — item framing is our math, not the framework's, so an
		 * MRF build change must not needlessly re-bake thousands of item icons.
		 *
		 * TWO generations, because two independent things can spoil a picture and
		 * each must be able to invalidate only its own. kItemRenderEpoch is OUR
		 * framing maths and governs the PLAIN-name renders. kSwapRenderEpoch is the
		 * texture-swap ROUTE and governs the "-s2" renders.
		 *
		 * Until 2026-08-20 there was only the first, and "-s2" renders were kept
		 * unconditionally: they were baked by the OLD game-renderer architecture
		 * with textures and lighting intact, a nifly renderer WITHOUT our
		 * IMesh_SetShapeTextureSet patch cannot reproduce them (its own
		 * IMesh_SetTextureSet is skin/facetint-only — proven from MRF source, so
		 * swaps latch off there), and the index prefers "-s2". That reasoning
		 * expired the day the patched framework started BAKING "-s2" files itself:
		 * a variant washed white by the whole-set override bug then survived every
		 * epoch bump there was, because nothing in this file could ever invalidate it.
		 * A fix to the swap route that cannot be seen is not a fix, so bumping
		 * kSwapRenderEpoch is now the lever for exactly that.
		 *
		 * Everything purged re-bakes lazily on the next ask. g_diskIndex is cleared
		 * to match so a purged key is not falsely reported until it re-renders. */
		void ReconcileItemGeneration()
		{
			const auto wantItem = std::string("item-epoch=") + std::to_string(kItemRenderEpoch);
			const auto wantSwap = std::string("swap-epoch=") + std::to_string(kSwapRenderEpoch);
			const auto stamp    = IconDir() / ".render-gen";
			std::string haveItem;
			std::string haveSwap;
			{
				std::ifstream in(stamp, std::ios::binary);
				if (in.is_open()) {
					std::getline(in, haveItem);
					std::getline(in, haveSwap);   // absent in a pre-2026-08-20 stamp
				}
			}
			const bool itemStale = haveItem != wantItem;
			const bool swapStale = haveSwap != wantSwap;
			if (!itemStale && !swapStale)
				return;   // both generations match — the index Init loaded is trusted

			// Purge the PNGs whose own generation went stale — plain renders on an
			// item-epoch bump, "-s2" swap renders on a swap-epoch bump, both when both.
			std::error_code ec;
			std::size_t purged = 0;
			if (std::filesystem::exists(IconDir(), ec)) {
				for (std::filesystem::directory_iterator it(IconDir(), ec), end; !ec && it != end; it.increment(ec)) {
					if (!it->is_regular_file(ec))
						continue;
					const auto stem = PathU8(it->path().stem());   // no extension
					auto ext = PathU8(it->path().extension());
					for (auto& c : ext)
						c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
					if (ext != ".png")
						continue;
					// Swap renders ("-s2") answer to their OWN generation, because the
					// thing that can spoil them is the swap ROUTE, not our framing — and
					// nothing could invalidate them until 2026-08-20, which is why a
					// white-washed variant icon survived every epoch bump.
					const bool swapRender = IsSwapRenderStem(stem);
					if (swapRender ? !swapStale : !itemStale)
						continue;
					// Turntable frames ("-aNNN") are PURGED with their frame 0 as of
					// epoch 2. They used to be kept, on the reasoning that only frame
					// 0 was re-framed — which stopped being true, and then the framing
					// bug lived almost entirely in the spun frames: they are the ones
					// that showed a weapon end-on at a scale chosen for its broadside.
					// A set must re-bake as a SET or it goes back to disagreeing with
					// itself, which is the whole defect.
					std::error_code del;
					std::filesystem::remove(it->path(), del);
					if (!del)
						++purged;
				}
			}
			// The inspector's frames come off the same framing and the same swap
			// route, so either generation going stale spoils them too. They are
			// never indexed, so the whole folder simply goes and re-bakes on ask.
			std::size_t inspectPurged = 0;
			if (std::filesystem::exists(InspectDir(), ec)) {
				for (std::filesystem::directory_iterator it(InspectDir(), ec), end; !ec && it != end; it.increment(ec)) {
					std::error_code del;
					if (it->is_regular_file(del) && std::filesystem::remove(it->path(), del) && !del)
						++inspectPurged;
				}
			}
			if (inspectPurged)
				logger::info("item icons: purged {} item-inspector frame(s) with the item render generation", inspectPurged);

			g_diskIndex.clear();
			InvalidateListings();
			LoadDiskIndex();   // re-seed from whatever survived (the -s2 keys)

			std::filesystem::create_directories(IconDir(), ec);
			std::ofstream out(stamp, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << wantItem << "\n" << wantSwap << "\n";
			logger::info("item icons: item render generation changed (item '{}'->'{}', swap '{}'->'{}') - "
			             "purged {} render(s); they re-bake on the next ask",
				haveItem.empty() ? std::string("<none>") : haveItem, wantItem,
				haveSwap.empty() ? std::string("<none>") : haveSwap, wantSwap, purged);
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
		 * view has it mapped anyway.
		 *
		 * ⚠ SUPERSEDED (2026-08-20): "bump the suffix again if the swap renderer
		 * changes in a way that invalidates what it already wrote" was the old
		 * remedy, and it would mean touching "-s2" in a dozen places and leaving
		 * the bad pictures on disk forever. Bump kSwapRenderEpoch instead — it
		 * purges exactly the "-s2" renders, once, from Init (before the view has
		 * mapped anything, so the deletes actually succeed), and it leaves the
		 * filenames alone. */
		std::string FileFor(const std::string& fid, const std::string& plugin, bool swapped = false)
		{
			std::string hex = fid;
			if (hex.rfind("0x", 0) == 0 || hex.rfind("0X", 0) == 0)
				hex = hex.substr(2);
			for (auto& c : hex)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return Slug(plugin) + "-" + hex + (swapped ? "-s2" : "") + ".png";
		}

		// g_mutex held. Only ITEM callers use these revisions; face/body filenames
		// retain their existing generation contract. Ultralight locks displayed
		// PNGs, so a retry writes a new name instead of deleting a mapped file.
		std::string ItemFileFor(const std::string& fid, const std::string& plugin, bool swapped = false)
		{
			const auto it = g_itemRevisions.find(KeyOf(fid, plugin));
			return ItemIconPaths::Versioned(FileFor(fid, plugin, swapped),
				it == g_itemRevisions.end() ? 0 : it->second);
		}

		bool SupersededItemRender(const std::string& key, const std::string& path)
		{
			const auto baseKey = key.substr(0, key.find('@'));
			if (!g_itemRevisions.count(baseKey))
				return false;
			const auto bar = baseKey.find('|');
			if (bar == std::string::npos)
				return false;
			const auto file = PathU8(std::filesystem::path(path).filename());
			return !ItemIconPaths::SameGeneration(file,
				ItemFileFor(baseKey.substr(0, bar), baseKey.substr(bar + 1)));
		}

		/* Takes a PATH, not a string: a caller must never have to convert, because
		 * path::string() throws on any name the ANSI code page cannot hold (see
		 * PathU8 in pch.h). std::string callers still bind — string converts to
		 * path implicitly — so this is a widening, not a break. */
		bool FileExists(const std::filesystem::path& p)
		{
			std::error_code ec;
			return std::filesystem::exists(p, ec);
		}

		/* ── one directory read instead of a thousand probes (2026-10-07) ────
		 * Rober, picking a mod in the Finder: "it started generating visuals but
		 * lagged super hard". The renders were not the cost. Every landing ran
		 * IndexJson() twice (the index file + the view push), the NPC index twice
		 * and the body index once, and each of those re-proved EVERY known key
		 * with FileExists — two probes per item (swap name, then plain), through
		 * MO2's usvfs hook, on the main thread: ~2,000 probes per landed picture
		 * with ~500 renders on disk, landing three or four times a second. The
		 * Finder's 2.5 s poll paid the same again.
		 *
		 * So an index build now asks a per-folder listing: ONE enumeration of
		 * icons/items (or npcs/, mounts/), then a hash lookup per key. The listing
		 * is dropped the moment a render lands (Pump marks it stale) or a purge
		 * deletes files, and it never outlives kListingMaxAge, so a PNG removed by
		 * hand drops out of the index within seconds. Names are compared
		 * lower-case: Windows names are case-blind and FileExists was too.
		 * Only the INDEX builders use it. The render-once gate in EnqueueLocked
		 * keeps its direct probe, because a stale "missing" there would bake a
		 * duplicate render. g_mutex held by every caller.
		 * Build marker (hd-markers.json: "item-icons-dir-listing"). */
		constexpr auto kListingMaxAge = std::chrono::seconds(10);

		struct DirListing
		{
			std::unordered_set<std::string>       names;   // lower-case file names
			std::chrono::steady_clock::time_point at{};
			bool                                  valid{ false };
		};
		DirListing g_listItems, g_listFaces, g_listBodies;

		void InvalidateListings()
		{
			g_listItems.valid = g_listFaces.valid = g_listBodies.valid = false;
		}

		std::string LowerName(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		bool Listed(DirListing& list, const std::filesystem::path& dir, const std::string& file)
		{
			const auto now = std::chrono::steady_clock::now();
			if (!list.valid || now - list.at > kListingMaxAge) {
				list.names.clear();
				std::error_code ec;
				for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
					list.names.insert(LowerName(PathU8(it->path().filename())));
				list.at    = now;
				list.valid = true;
				static bool logged = false;
				if (!logged) {
					logged = true;
					const auto us = std::chrono::duration_cast<std::chrono::microseconds>(
						std::chrono::steady_clock::now() - now).count();
					logger::info("item-icons-dir-listing: {} file(s) in {} listed in {} us",
						list.names.size(), PathU8(dir), us);
				}
			}
			return list.names.count(LowerName(file)) > 0;
		}

		/* ── the renderer's refusal channel ──────────────────────────────────
		 *
		 * A render is written once and kept forever, so the one thing that must
		 * never happen is a BAD picture landing at a good filename. The framework
		 * is the only party that ever sees the pixels — it has the CPU-side image
		 * in hand a line before it writes the PNG — so that is where the check
		 * lives (mrf-build/patches/…-render-validate.patch). When it refuses, it
		 * writes NOTHING at outPath and drops "<outPath>.rejected" holding the
		 * reason instead.
		 *
		 * A sidecar file rather than a new ABI field on purpose: the deck mirrors
		 * MRF's IMesh struct byte-for-byte and static_asserts its size, so growing
		 * that struct couples the two builds into a matched pair for all time,
		 * while a file the deck already polls for costs nothing and degrades
		 * perfectly — an OLD framework simply never writes one and every path here
		 * stays dormant. */
		std::filesystem::path RejectMarkerFor(const std::filesystem::path& out)
		{
			std::filesystem::path m = out;
			m += ".rejected";
			return m;
		}

		// Reads the reason and removes the marker, so a later retry of the same
		// item starts clean rather than inheriting an old verdict. Bounded read:
		// the framework writes one short line, and a huge file here would be a
		// bug in it, not a reason to load it.
		std::string TakeRejectReason(const std::filesystem::path& out)
		{
			const auto    marker = RejectMarkerFor(out);
			std::string   why;
			std::error_code ec;
			{
				std::ifstream in(marker, std::ios::binary);
				if (in) {
					char buf[512]{};
					in.read(buf, sizeof(buf) - 1);
					why.assign(buf, static_cast<std::size_t>(in.gcount()));
				}
			}
			std::filesystem::remove(marker, ec);
			while (!why.empty() && (why.back() == '\n' || why.back() == '\r' || why.back() == ' '))
				why.pop_back();
			if (why.empty())
				why = "no reason given";
			return why;
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
		 * ── WHY THE FIRST BOX-FIT WAS WRONG (2026-08-19, Rober: "mesh rendering
		 * really need to be smarter in general, so we dont have issues like this") ──
		 *
		 * The paragraph above says "model-Y is DEPTH and never touches the on-screen
		 * footprint". BOTH halves of that are false, and each one shipped a visible
		 * bug:
		 *
		 *  1. DEPTH IS NOT FREE. The camera is PERSPECTIVE (fov = 2*atan(halfSpan /
		 *     820)), so 130 units is the half-span AT THE SUBJECT PLANE only. Geometry
		 *     in front of that plane projects LARGER. Fitting X/Z as if the object
		 *     were flat therefore hands out a scale that shoves the near end of a
		 *     deep mesh toward — and past — the eye. Proven from the rig's own log,
		 *     no screenshots needed: Akatosh Mace (OBR2SSE - Weapons.esp 0x000804)
		 *     logged box[x=46.4 z=7.9] sphereScale=2.0240 -> boxScale=4.7651. MRF's
		 *     sphere fit is fittedRadius/boundingRadius with fittedRadius =
		 *     0.9*130*820/(820+0.9*130) = 102.39, so its boundingRadius was 50.6 —
		 *     which with halfX 23.2 and halfZ 3.95 puts the mace's model-Y half-extent
		 *     at ~44.8. The object is 89.6 units long ALONG THE ONE AXIS THE FIT NEVER
		 *     LOOKED AT. At 4.7651x that is +/-213 units of depth: the nearest
		 *     geometry sits 607 units from an eye that is 820 from the plane, and
		 *     projects 1.35x bigger than the fit assumed. That is the "camera inside
		 *     the mesh" tile — a full-frame magnified surface instead of a weapon.
		 *
		 *  2. MODEL-Y BECOMES SCREEN-X THE MOMENT THE TURNTABLE TURNS. ApplySpin
		 *     rotates about model-Z, so X and Y trade places. The same mace at 90 deg
		 *     puts that 89.6-unit length across the screen: half-width 213.4 against a
		 *     130 half-span = 164% of the frame. One fixed number, two silhouettes
		 *     1.93x apart — which is exactly Rober's screenshot of one frame centred
		 *     and filling the plate and the next one framed completely differently.
		 *     (Daedric Warhammer 0x000870: 174.9 vs 130, same shape of failure.)
		 *
		 * ── WHAT REPLACES IT: fit the OBJECT once, not the frame ──
		 *
		 * The turntable spins about model-Z, so the only horizontal extent that is
		 * INVARIANT under the spin is the radius of the cylinder X and Y sweep,
		 * r = hypot(halfX, halfY). Model-Z is the spin axis and is perpendicular to
		 * the view direction, so it contributes exactly zero depth. Therefore r is
		 * simultaneously (a) the worst-case on-screen half-width at ANY angle and
		 * (b) the worst-case half-depth at any angle. Fit r horizontally and halfZ
		 * vertically, at the nearest depth, and the result is one number that is a
		 * pure function of the mesh — so frame 0 and every -aNNN sibling get
		 * identical framing BY CONSTRUCTION, and the object turns inside a fixed
		 * frame instead of the frame being re-chosen per angle.
		 *
		 * It is still a strict improvement on the framework's own fit, which is what
		 * the potion case needed: the sphere folds all three axes into one radius and
		 * fits it to the LIMITING half-span, while this fits width and height
		 * separately and only folds the two axes the rotation actually mixes. A tall
		 * thin bottle keeps its recovery; a long weapon stops being lied about.
		 *
		 * And it CANNOT put the camera inside the mesh, for any mesh: the horizontal
		 * solution bounds r*scale at kFillTarget*130*820/(820+kFillTarget*130) ~= 97,
		 * so the nearest geometry is always >= 723 units from the eye. That is not a
		 * heuristic, it is the closed form.
		 *
		 * FACES and creature BODIES are deliberately EXEMPT: their framing is owned
		 * downstream (hd-facefit's layout crop) and their bounds include hair/limbs
		 * that this would mis-frame — only item renders (px == kSize) are re-fit. */
		// ⛔ RENDER-GEOMETRY BEGIN — do not change without an in-game A/B.
		//
		// Everything between this line and the closing fence below is what makes a
		// rendered item look RIGHT rather than merely appear: the fixed camera
		// mirrored from MRF's own RenderManager, the fill target, and the
		// object-fit that makes a tiny mesh — a potion above all — fill its frame
		// instead of sitting as a speck in the middle of it. It took a long time
		// and several play-tests to get here, and it cannot be verified from a
		// harness: the only test is rendering something and LOOKING at it.
		//
		// The commit hook refuses a diff that touches this region unless the
		// message carries a RENDER-GEOMETRY: line saying what you compared
		// in-game. That is not bureaucracy — twice this year the renderer
		// shipped visibly broken (all-black faces, then heads torn from their
		// hair) and both times a human eye found it weeks later, because
		// nothing else can.

		// One fit per OBJECT, in one struct, so nothing downstream can recompute a
		// different one for a different frame. `scale` is what goes on the mesh; the
		// rest exists so the log can say WHY without anyone taking a screenshot.
		struct ClutterFit
		{
			float scale{ 0.0f };          // what we wrote to abi->scale
			float sweptRadius{ 0.0f };    // hypot(halfX, halfY) — invariant under the spin
			float halfZ{ 0.0f };
			float halfX{ 0.0f }, halfY{ 0.0f };
			float sphereScale{ 0.0f };    // what the framework had chosen
			float nearestDepth{ 0.0f };   // camera-to-nearest-geometry, units
			bool  usable{ false };
			bool  cappedBySphere{ false };  // the framework's own fit was the larger one
			const char* limit{ "none" };    // which axis decided: "width" | "height"
		};

		// Pure function of the mesh's bounds — no angle, no filename, no state. That
		// purity is the whole point: every turntable sibling of an item is a fresh
		// mesh built from the SAME nif, so it lands on the same numbers here, and the
		// set cannot drift. (Pump also cross-checks it per set; see g_fitBySource.)
		ClutterFit ComputeClutterFit(const IMeshAbi* abi)
		{
			ClutterFit f;
			if (!abi)
				return f;
			// The fixed camera, mirrored from RenderManager::RenderLocked. If MRF
			// ever changes these the worst case is a slightly loose fit, never a
			// crash or a clip — the target below is unconditional and < 1.
			constexpr float kHorizHalfSpan  = 130.0f;   // half-span AT THE SUBJECT PLANE
			constexpr float kCameraDistance = 820.0f;   // eye y=+320 -> subject plane y=-500
			constexpr float kFillTarget     = 0.85f;    // fraction of the frame to fill
			const float aspect = abi->height > 0 ? static_cast<float>(abi->width) /
			                                       static_cast<float>(abi->height)
			                                     : 1.0f;
			const float vertHalfSpan = aspect > 0.0001f ? kHorizHalfSpan / aspect : kHorizHalfSpan;

			// Centred model-space half-extents, all THREE of them. Skyrim is Z-up and
			// the camera looks down -Y with +Z as screen-up, so model-Z is the spin
			// axis AND the screen-vertical axis, and model-X/model-Y are the pair the
			// turntable rotates into each other.
			f.halfX = std::fabs(abi->boundMax[0] - abi->boundMin[0]) * 0.5f;
			f.halfY = std::fabs(abi->boundMax[1] - abi->boundMin[1]) * 0.5f;
			f.halfZ = std::fabs(abi->boundMax[2] - abi->boundMin[2]) * 0.5f;
			f.sphereScale = abi->scale;
			f.sweptRadius = std::sqrt(f.halfX * f.halfX + f.halfY * f.halfY);
			if (f.sweptRadius < 0.0001f && f.halfZ < 0.0001f)
				return f;   // degenerate box — leave the framework's fit alone

			const float d  = kCameraDistance;
			const float th = kFillTarget * kHorizHalfSpan;
			const float tv = kFillTarget * vertHalfSpan;

			// Perspective, not orthographic. Requiring the swept silhouette to stay
			// inside the frame AT ITS NEAREST DEPTH (d - sweptRadius*s) gives a closed
			// form — the same one MRF's own Mesh::Fit uses for the bounding sphere,
			// generalised to a cylinder so height is fitted independently of width:
			//     horizontal:  sweptRadius*s / (d - sweptRadius*s)  <=  th/d
			//     vertical:          halfZ*s / (d - sweptRadius*s)  <=  tv/d
			const float denomH = f.sweptRadius * (d + th);
			const float denomV = f.halfZ * d + tv * f.sweptRadius;
			const float scaleH = denomH > 0.0001f ? (th * d) / denomH : 1.0e9f;
			const float scaleV = denomV > 0.0001f ? (tv * d) / denomV : 1.0e9f;
			float fit = (std::min)(scaleH, scaleV);
			f.limit = scaleH <= scaleV ? "width" : "height";
			if (!(fit > 0.0f) || fit >= 1.0e8f)
				return f;   // no usable extent — leave the framework's fit alone

			// Floor at the framework's own choice. Its sphere fit lands the bounding
			// sphere at exactly 0.9 of the half-span after perspective (substitute
			// fittedRadius back into r*d/(d-r) and the d's cancel), so it is provably
			// clip-free too; where kFillTarget's 0.85 would render SMALLER than what
			// MRF already does, take MRF's. Keeps the old promise that this never
			// shrinks an icon, without keeping the old promise's arithmetic.
			if (fit < f.sphereScale) {
				fit = f.sphereScale;
				f.cappedBySphere = true;
			}
			f.scale        = fit;
			f.nearestDepth = d - f.sweptRadius * fit;
			f.usable       = true;
			return f;
		}
		// ⛔ RENDER-GEOMETRY END

		/* ── one fit per turntable SET, and a tripwire that proves it ────────
		 *
		 * ComputeClutterFit is a pure function of the mesh bounds, so every frame of
		 * a turntable — built from the same nif at the same px — already lands on the
		 * same number. That is the design. This map turns "already true" into
		 * "enforced and audible": the first frame of a source records its scale, every
		 * later frame is compared against it, and a disagreement is a WARNING plus the
		 * first frame's number, not a silently different picture.
		 *
		 * It exists because the failure it guards is invisible: a spun frame framed
		 * differently from frame 0 looks like a bad render, never like a bad rule, and
		 * that is precisely how the per-angle box-fit survived a play-test. Keyed by
		 * "<nif>|<px>" because that pair is exactly what decides the geometry.
		 * Bounded: cleared wholesale past a few hundred entries — it is a
		 * within-a-session consistency check, not a cache anything depends on. */
		std::unordered_map<std::string, float> g_fitBySource;

		void FitClutter(IMeshAbi* abi, const std::string& label,
			const std::string& nifPath, std::uint32_t px, std::uint32_t angle)
		{
			if (!abi)
				return;
			const ClutterFit f = ComputeClutterFit(abi);
			if (!f.usable) {
				logger::info("item icons: '{}' fit — extents from MRF vertex bounds "
				             "[x={:.1f} y={:.1f} z={:.1f}]; no usable extent, keeping the "
				             "framework's own fit {:.4f}",
					label, f.halfX * 2.0f, f.halfY * 2.0f, f.halfZ * 2.0f, f.sphereScale);
				return;
			}

			float scale = f.scale;
			if (!nifPath.empty()) {
				if (g_fitBySource.size() > 512)
					g_fitBySource.clear();
				const std::string srcKey = nifPath + "|" + std::to_string(px);
				const auto        seen   = g_fitBySource.find(srcKey);
				if (seen == g_fitBySource.end()) {
					g_fitBySource.emplace(srcKey, scale);
				} else if (std::fabs(seen->second - scale) > seen->second * 0.001f) {
					// Marker: item-icons-fit-desync.
					logger::warn("item icons: '{}' fit DESYNC — this frame computed {:.4f} but the "
					             "set's first frame used {:.4f}; using the set's. The framing math "
					             "is supposed to be angle-independent, so this means the mesh's "
					             "bounds changed under us.",
						label, scale, seen->second);
					scale = seen->second;
				}
			}

			abi->scale = scale;
			// Unconditional, one line per item render, because the LAST time this was
			// conditional the log printed x and z and not the y that caused the bug.
			// Marker: item-icons-fit.
			logger::info("item icons: '{}' fit — extents from MRF vertex bounds "
			             "[x={:.1f} y={:.1f} z={:.1f}] swept r={:.1f} -> scale {:.4f} "
			             "(framework {:.4f}{}), {}-limited, nearest geometry {:.0f} units "
			             "from the eye, angle {}",
				label, f.halfX * 2.0f, f.halfY * 2.0f, f.halfZ * 2.0f, f.sweptRadius,
				scale, f.sphereScale, f.cappedBySphere ? ", kept" : "", f.limit,
				f.nearestDepth, angle);
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

		/* ── the texture swap as DATA (new-architecture MRF) ─────────────────
		 * The nifly rewrite parses the NIF itself, so painting the game's cached
		 * model (ApplySwaps below) shows it nothing. Our MRF patch adds
		 * IMesh_SetShapeTextureSet — the swap is handed over as data instead:
		 * same (name3D, index3D) target the AlternateTexture record carries,
		 * texture paths in the renderer's NIF slot order. A BGSTextureSet
		 * stores the ESP TX order, so glow/height/environment/env-mask remap
		 * here (TX03→NIF2, TX04→NIF3, TX05→NIF4, TX02→NIF5). */

		// POD-only (__try, C2712). Collects the 8 paths in NIF slot order.
		bool CallCollectTexPaths(RE::BSTextureSet* a_set, const char** a_out8) noexcept
		{
			__try {
				using TS  = RE::BSTextureSet::Texture;
				a_out8[0] = a_set->GetTexturePath(TS::kDiffuse);
				a_out8[1] = a_set->GetTexturePath(TS::kNormal);
				a_out8[2] = a_set->GetTexturePath(TS::kGlowMap);
				a_out8[3] = a_set->GetTexturePath(TS::kHeight);
				a_out8[4] = a_set->GetTexturePath(TS::kEnvironment);
				a_out8[5] = a_set->GetTexturePath(TS::kEnvironmentMask);
				a_out8[6] = a_set->GetTexturePath(TS::kMultilayer);
				a_out8[7] = a_set->GetTexturePath(TS::kBacklightMask);
				return true;
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		// POD-only (__try, C2712).
		bool CallSetShapeTex(void* a_mesh, const char* a_name, std::uint32_t a_index,
			const char* const* a_paths, std::uint32_t a_count) noexcept
		{
			__try {
				return g_setShapeTex(a_mesh, a_name, a_index, a_paths, a_count);
			} __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER
																		 : EXCEPTION_CONTINUE_SEARCH) {
				return false;
			}
		}

		bool ApplySwapViaApi(void* mesh, const AltTex& swap)
		{
			if (!g_setShapeTex || !mesh || !swap.set)
				return false;
			const char* raw[8] = {};
			if (!CallCollectTexPaths(swap.set, raw))
				return false;
			const char* paths[8];
			for (int i = 0; i < 8; ++i)
				paths[i] = raw[i] ? raw[i] : "";
			/* An EMPTY slot means "this variant does not change this map" — a
			 * BGSTextureSet is a PARTIAL override and names only what it changes.
			 * The framework honours that on every one of the eight slots (mrf-build
			 * patch zz-…-override-white-flood, 2026-08-20): an empty entry keeps the
			 * shape's own texture. Before it did, the override replaced the whole
			 * set, so each empty slot CLEARED a texture the NIF had and a missing
			 * map renders white — the pale "Practical Pirate Boots - Dark".
			 *
			 * A texture set with no DIFFUSE at all is the loud case and it is a
			 * plugin data bug: the picture comes out in the mesh's BASE colour
			 * wearing the variant's other maps, which is a variant in the wrong
			 * colour rather than a white silhouette. Say so here — nothing else in
			 * this log can explain the wrong colour, and the fault is not ours. */
			if (!paths[0][0])
				logger::warn("item icons: texture-swap set for shape '{}' carries no diffuse — "
				             "the render will wear the mesh's own base colour",
					swap.name3D.empty() ? "<by index>" : swap.name3D.c_str());
			return CallSetShapeTex(mesh, swap.name3D.c_str(), swap.index3D, paths, 8);
		}

		/* "<slug>-<hex>-s2[-aNNN].png" → the same name without its "-s2".
		 * Where a swap was asked but nothing applied, the bare picture must land
		 * under the PLAIN name — "-s2" is the name the index prefers, reserved
		 * for renders that really wore the variant's textures. */
		std::string PlainNameOf(std::string path)
		{
			// Only the FILENAME suffix forms "-s2.png" / "-s2-aNNN.png" — a
			// plugin slug that happens to contain "-s2" is left alone.
			const auto pos = path.rfind("-s2");
			if (pos != std::string::npos &&
				(path.compare(pos, 7, "-s2.png") == 0 || path.compare(pos, 5, "-s2-a") == 0))
				path.erase(pos, 3);
			return path;
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
		 * The WORN GARMENT — the armour addon's biped model — AND its texture
		 * swap: retexture variants (the green Yeti Cap) are a mesh plus an
		 * alternate texture set, so the swap travels with the path. Biped model
		 * first, the ground model as fallback.
		 *
		 * ⚠ THIS ORDER WAS THE OTHER WAY ROUND UNTIL 2026-09-20, and the ground
		 * model is a trap (Rober, with a screenshot of four identical tiles:
		 * "rendering as inventory art not actual 3d object?"). An ARMO's
		 * worldModels entry is the prop it becomes when DROPPED, and nothing
		 * makes that prop unique per item: Neo's Slave Leia Renewal points all
		 * four of its pieces — bangle, body, boots, chain — at one shared
		 * meshes\Neo\LeiaN\NeoGND.nif, a decorative "Neo's Gift" plaque. So
		 * four different worn items rendered four byte-identical pictures of a
		 * signboard (verified: same SHA256), and any outfit mod shipping one GND
		 * prop for a whole set does the same. The biped model IS the garment,
		 * which is what a "what is she wearing" grid is asking about.
		 *
		 * Weapons, torches and ammo are unaffected — their world model IS the
		 * object, and they take the TESModelTextureSwap branch below.
		 *
		 * ⚠ SEX ORDER IS NOT "first non-empty" — that was wrong, and the real
		 * records prove it. bipedModels is indexed [male, female], and these
		 * outfit mods fill the MALE slot with a borrowed vanilla placeholder
		 * while the garment itself lives in the FEMALE slot. Neo's, verbatim:
		 *
		 *   000810 chain   male Armor\AmuletsandRings\SilverAmulet_1.nif
		 *                female NEO\LeiaN\LeiaChainG_1.nif
		 *   000820 bangle  male Armor\Elven\M\Gauntlets_1.nif
		 *                female NEO\LeiaN\LeiaBangleG_1.nif
		 *   000829 body    male Armor\Elven\M\Cuirass_1.nif
		 *                female NEO\LeiaN\LeiaBody0_1.nif
		 *   00082A boots   male Armor\Elven\M\Boots_1.nif
		 *                female NEO\LeiaN\LeiaBoots0_1.nif
		 *
		 * Taking the first non-empty would have rendered elven gauntlets and a
		 * silver amulet — four DIFFERENT pictures, so it would have looked fixed
		 * while being wrong, which is the worst failure available here.
		 *
		 * So: FEMALE first, male as the fallback. This is a property of the
		 * RECORD, not of the wearer, and it has to be — a render is cached once
		 * per item (fid+plugin), not per actor, and neither caller even has an
		 * actor. For vanilla armour both slots are the same garment, so the
		 * choice is free there; for a male-only piece the female slot is empty
		 * and it falls through. A mesh that renders badly is caught by the
		 * blank-render guard and keeps its glyph rather than showing a lie. */
		struct Look
		{
			std::string         nif;
			std::vector<AltTex> swaps;
			std::string missing;
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
			auto readable = [&](const char* model) {
				std::string path = model;
				if (LowerS(path).rfind("meshes\\", 0) != 0 && LowerS(path).rfind("meshes/", 0) != 0)
					path = "meshes\\" + path;
				RE::BSResourceNiBinaryStream probe(path.c_str());
				if (probe.good()) return true;
				if (look.missing.empty()) look.missing = path;
				logger::debug("item icons: missing model candidate {}", path);
				return false;
			};
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				using Sex = RE::SEXES::SEX;
				for (auto* addon : armo->armorAddons) {
					if (!addon)
						continue;
					// Female first — see the block comment above for why.
					for (const auto sex : { Sex::kFemale, Sex::kMale }) {
						const auto& bm = addon->bipedModels[sex];
						const char* m  = bm.GetModel();
						if (m && *m && readable(m)) {
							look.nif   = m;
							look.swaps = SwapsOf(&bm);
							logger::debug("item icons: {}|{} -> worn garment '{}' ({})",  // marker: item-icons-worn-model
								fid, plugin, m, sex == Sex::kFemale ? "female" : "male");
							return look;
						}
					}
				}
				/* No readable biped model (including a missing loose/BSA resource):
				 * the ground prop is better than nothing, and the shared-mesh
				 * problem above cannot be worse than an empty tile. */
				for (const auto& wm : armo->worldModels) {
					const char* m = wm.GetModel();
					if (m && *m && readable(m)) {
						look.nif   = m;
						look.swaps = SwapsOf(&wm);
						return look;
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

		/* We never call IMesh_Save: it dereferences mesh->SRV with no null
		 * check and a fresh mesh has none. Arm the deferred save and let their
		 * render loop write; the mesh is freed in Pump() once the file lands.
		 *
		 * ⚠ AND WE DO NOT CALL upstream's `Mesh::Save()` wrapper either
		 * (MeshRenderingFrameworkAPI.h:612-621), even though its not-ready branch
		 * — `savePath = strdup(filePath); saveNextFrame = true;` — is the same two
		 * writes this function ends with. Checked from source 2026-08-20; three
		 * reasons, any one of which is enough:
		 *
		 *   1. It is a method of upstream's `Mesh` CLASS, which owns the IMesh and
		 *      deletes it in its destructor. We hold the raw IMesh* (InFlight::mesh)
		 *      and free it ourselves in Pump() once the PNG lands. Adopting the
		 *      wrapper means adopting the ownership, i.e. rewriting the queue.
		 *   2. It `strdup`s the path and MRF never frees it (RenderManager.cpp
		 *      :1461 just nulls the pointer) — one small leak per render, thousands
		 *      of renders. Our g_savePaths deque hands over a stable pointer with
		 *      no allocation per save.
		 *   3. It writes ONLY those two fields. Everything else here is load-
		 *      bearing and has no upstream equivalent: the layout probe that
		 *      latches the session off if the ABI moved, the turntable spin, the
		 *      clutter fit, `deleteAfterSave=false` (upstream's static Render()
		 *      sets it TRUE — the framework would free the mesh behind our back
		 *      while Pump still holds the pointer), `mustUpdate=true`, the output
		 *      directory, and clearing a stale reject marker.
		 *
		 * So this is not a re-implementation of Save(); Save() is a two-line
		 * subset of it, on a different ownership model. */
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
			// Clutter framing: replace the framework's bounding-SPHERE fit with the
			// swept-cylinder fit so a potion fills its frame without a long weapon
			// being driven through the camera (see ComputeClutterFit). Applies to
			// every ITEM render that asked (job.refit) — frame 0 and every turntable
			// angle alike, and by construction they all get the SAME number, so the
			// object turns inside a fixed frame.
			//
			// job.fallback is the one way out: a render this framing already produced
			// and the validator REFUSED is re-armed with the framework's own fit,
			// which is the most conservative framing available (full bounding sphere,
			// 0.9 of the frame). One retry, then the failure ledger — a keep-forever
			// file is never written on a guess.
			if (job.refit && !job.fallback)
				FitClutter(abi, job.label, job.nifPath, job.px, job.angle);
			else if (job.fallback)
				logger::info("item icons: '{}' re-armed on the framework's own bounding-sphere "
				             "fit ({:.4f}) after its first picture was refused",
					job.label, abi->scale);   // marker: item-icons-fit-fallback
			std::error_code ec;
			std::filesystem::create_directories(std::filesystem::path(job.outPath).parent_path(), ec);
			if (ec)
				return false;
			// Clear any refusal marker left at this path — normally we consume it in
			// Pump, but a crash between the framework writing one and us reading it
			// would otherwise make the NEXT attempt read as refused before it had
			// even rendered. The marker means "the render that just ran was bad", so
			// it must never outlive that render.
			{
				std::error_code rm;
				std::filesystem::remove(RejectMarkerFor(job.outPath), rm);
			}
			g_savePaths.push_back(job.outPath);
			abi->savePath        = g_savePaths.back().c_str();
			abi->saveNextFrame   = true;
			abi->deleteAfterSave = false;
			abi->mustUpdate      = true;
			return true;
		}

		void MarkFailed(const std::string& key, std::string why);

		// g_mutex held.
		bool Start(const Request& r)
		{
			if (!Ready())
				return false;
			void*       mesh    = nullptr;
			bool        swapped = false;
			std::string outPath = r.outPath;
			if (!r.swaps.empty() && !g_swapDisabled) {
				if (g_setShapeTex) {
					// New architecture with our patch: the framework parses the
					// NIF itself, so the swap is handed over as per-shape data
					// (ApplySwapViaApi) instead of painted onto a model it never
					// reads. Zero entries taking means this mesh wears its BASE
					// textures — that picture must land under the PLAIN name,
					// never "-s2" (the name the index prefers for good).
					mesh = SafeCreateByNif(r.nifPath, r.px);
					if (mesh) {
						std::size_t applied = 0;
						for (const auto& swap : r.swaps)
							if (ApplySwapViaApi(mesh, swap))
								++applied;
						if (applied) {
							swapped = true;
							logger::info("item icons: '{}' — {} of {} texture-swap entries applied via the framework API",
								r.label, applied, r.swaps.size());
						} else {
							outPath = PlainNameOf(outPath);
							logger::warn("item icons: '{}' — no texture-swap entry matched a shape; rendering "
										 "bare under the plain name",
								r.label);
						}
					}
				} else {
					// Old architecture: the variant is painted onto the CACHED
					// model, rendered through the framework's own path route
					// while the paint is wet, and put back the instant that call
					// returns — see ApplySwaps for the disassembly this is built
					// on. Every failure restores and falls through to the plain
					// mesh, so it can only make the picture better.
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
			}
			// A face whose hair lives in a WIG: compose head + wig into one mesh.
			// Falls through to the bare head on ANY failure — a composed render is
			// better than a bald one, but a bald one is far better than none.
			bool composed = false;
			if (!mesh && !r.extraNifs.empty()) {
				mesh     = SafeCreateByNifSet(r.nifPath, r.extraNifs, r.px);
				composed = mesh != nullptr && !r.whole;
				if (mesh && r.whole)
					ApplyWholeLook(mesh, r);
				else if (mesh)
					logger::info("item icons: '{}' — head composed with {} wig nif(s)",
						r.label, r.extraNifs.size());   // marker: face-wig-compose
				else
					logger::warn("item icons: '{}' — wig composition did not build a mesh; bare head",
						r.label);
			}
			if (!mesh && !r.whole)
				mesh = SafeCreateByNif(r.nifPath, r.px);
			if (!mesh) {
				++g_failed;
				++g_landed;   // publish a failure just as promptly as a finished picture
				BacklogDrop(r.key);
				MarkFailed(r.key, "could not load the item mesh: " + r.nifPath);
				logger::warn("item icons: mesh load failed for '{}' ({})", r.label, r.nifPath);
				return false;
			}
			InFlight job;
			job.mesh    = mesh;
			job.outPath = std::move(outPath);
			job.key     = r.key;
			job.label   = r.label;
			job.nifPath = r.nifPath;
			job.swapped = swapped;
			job.angle   = r.angle;
			job.px      = r.px;
			job.refit   = r.refit;
			job.fallback = r.fallback;
			job.composed = composed;
			job.tier    = r.tier;   // a swap-retry re-arms in the lane it came from
			job.armed   = std::chrono::steady_clock::now();
			if (!ArmSave(mesh, job)) {
				SafeDelete(mesh);
				++g_failed;
				++g_landed;
				BacklogDrop(r.key);
				MarkFailed(r.key, "the renderer could not start saving the picture");
				return false;
			}
			// The lane is part of the line now: "which tier is holding the GPU"
			// was the question the 2026-08-19 slow-tiles report could not answer
			// from the log. (marker item-icons-render matches the prefix.)
			logger::info("item icons: rendering '{}' [{}] -> {}", r.label, TierName(r.tier), r.outPath);
			g_inFlight.push_back(std::move(job));
			return true;
		}

		// Is the game paused right now? MAIN THREAD ONLY (RE::UI) — Pump is always
		// called inside an SKSE task, the same place FrameworkBlocked() reads the
		// menu map. GameIsPaused() is true for the deck palette, inventory, map,
		// magic and the console — every state where the world is NOT being drawn,
		// so an MRF render there contends with nothing and needs no pacing.
		// ---- the failure ledger ------------------------------------------
		//
		// Rober, 2026-08-15: "the wig and the face def got stuck i sat there
		// waiting for some time...". They had not stuck — they had FAILED, and
		// nothing said so. A render that never lands leaves the tile on its
		// placeholder forever, indistinguishable from one still in the queue,
		// because the view only ever hears about SUCCESSES (icons appearing in
		// IndexJson). Every dead end now writes a reason here, IndexJson ships
		// it, and the tile can wear an honest x with that reason and a retry.
		//
		// Keyed exactly like g_asked, so the view's own lookup key finds it.
		std::unordered_map<std::string, std::string> g_failedWhy;

		void MarkFailed(const std::string& key, std::string why)
		{
			if (key.empty())
				return;
			g_failedWhy[key] = std::move(why);
		}

		// An explicit retry clears the verdict so the tile can go back to
		// "rendering" rather than staying condemned by a stale reason.
		void ClearFailed(const std::string& key) { g_failedWhy.erase(key); }


		std::function<bool()> g_paletteProbe;

		bool GamePaused()
		{
			auto* ui = RE::UI::GetSingleton();
			return ui && ui->GameIsPaused();
		}

		/* A LOAD SCREEN is the worst moment to render, and it looks like the best
		 * one (2026-08-16).
		 *
		 * WorldIdle() below treats "the engine is paused" as "there is no world
		 * being drawn, so hammer away" — true for the deck palette, the
		 * inventory, the map. It is FALSE for the loading menu: the engine is
		 * paused AND it is streaming the cell, decompressing archives and
		 * building the scene, and the load screen itself runs an animated 3D
		 * model, so there is very much a draw loop to contend with. The
		 * framework's own skip-list (FrameworkBlocked) does not include it
		 * either, so MRF happily renders straight through a load.
		 *
		 * Result before this: the boot warm-start queued 5 s after kPostLoadGame
		 * would find paced == false, skip the settle hold entirely (idleSettled
		 * is forced true when not paced), and start kMaxInFlight offscreen passes
		 * with NO gap, right in the middle of load-in. That is the "intense
		 * microstuttering on startup" — the pacing gate was working exactly as
		 * designed and simply did not consider a load screen dangerous.
		 *
		 * So loading counts as BLOCKED, not as free time: it starts nothing and
		 * it pauses the in-flight leashes, which is precisely the behaviour we
		 * want and is machinery that is already proven.
		 */
		bool LoadingNow()
		{
			auto* ui = RE::UI::GetSingleton();
			if (!ui)
				return false;
			// String literals to match FrameworkBlocked's style. "Mist Menu" is
			// already treated as a framework skip-menu; these two are the real
			// load screens.
			return ui->IsMenuOpen("Loading Menu") || ui->IsMenuOpen("LoadWaitSpinner");
		}

		// The world is not being drawn for the player in either case: engine
		// pause, or one of our palettes up (smooth pause freezes the world at
		// sgtm 0 without setting the engine's paused flag). Both mean "nothing
		// to protect from a render".
		bool                                  g_paletteFastLogged = false;
		// When the current not-drawing-the-world stretch began. Pump holds every
		// start for kMenuOpenGrace after it, so a palette paints before any
		// render competes with it.
		std::chrono::steady_clock::time_point g_idleSince{};

		bool WorldIdle()
		{
			const bool paused = GamePaused();
			bool       palette = false;
			if (!paused && g_paletteProbe) {
				try {
					palette = g_paletteProbe();
				} catch (...) {}
			}
			if (paused || palette) {
				if (!g_paletteFastLogged) {
					g_paletteFastLogged = true;
					g_idleSince = std::chrono::steady_clock::now();
					logger::info("item icons: menu up - renders paced for the UI paint");  // marker: render-menu-pace
				}
				return true;
			}
			g_paletteFastLogged = false;
			g_idleSince = {};
			return false;
		}

		// Retire finished / stuck renders, then start queued ones. g_mutex held.
		void Pump()
		{
			const auto now = std::chrono::steady_clock::now();
			// Loading is blocked, not idle — see LoadingNow(). Folded in here
			// rather than into FrameworkBlocked() because that function means
			// "MRF itself refuses to draw", and this is our own policy.
			const bool loading = LoadingNow();
			if (loading) {
				g_lastLoadingSeen = now;
				if (!g_loadHoldLogged) {
					g_loadHoldLogged = true;
					logger::info("item icons: load screen up - renders held (streaming the cell)");  // marker: render-load-hold
				}
			} else if (g_loadHoldLogged) {
				g_loadHoldLogged = false;
			}
			const bool blocked = FrameworkBlocked() || loading;
			// Pace render STARTS only while the game is LIVE (unpaused): a render on
			// the game's D3D11 device contends with the world draw and hitches. When
			// the world is not being drawn (paused / a framework skip-menu is up) we
			// start at full speed — the deck palette pauses the game, so the Finder
			// stays fast. See kPaceGapUser/kPaceGapIdle.
			const bool paced = !blocked && !WorldIdle();

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
				// The framework looked at what it drew and refused to keep it. This
				// is checked BEFORE `late` so a refusal is instant feedback rather
				// than a 30-second timeout wearing the wrong reason.
				const bool refused = !done && FileExists(RejectMarkerFor(g_inFlight[i].outPath));
				const bool late = (now - g_inFlight[i].armed) > kRenderTimeout;
				if (!done && !refused && !late) {
					++i;
					continue;
				}
				SafeDelete(g_inFlight[i].mesh);
				// An already-armed old generation is allowed to finish safely, but
				// cannot clear the new generation's failure or requeue stale angles.
				if (SupersededItemRender(g_inFlight[i].key, g_inFlight[i].outPath)) {
					g_inFlight.erase(g_inFlight.begin() + static_cast<std::ptrdiff_t>(i));
					continue;
				}
				if (refused) {
					const std::string why = TakeRejectReason(g_inFlight[i].outPath);
					if (!g_inFlight[i].fallback && g_inFlight[i].composed &&
						!g_inFlight[i].nifPath.empty()) {
						/* A COMPOSED face (head + wig) came out blank. Retry ONCE as
						 * the bare facegen head. 2026-09-23: Willow, Vaelina and Adney
						 * Swordhand all went blank this way (0.23-0.94% ink) and were
						 * condemned after a single try, although their bare heads
						 * render fine. A bald face beats initials; the wig is the part
						 * that failed, so drop it rather than the whole portrait. */
						++g_failed;
						Request again;
						again.outPath  = g_inFlight[i].outPath;
						again.key      = g_inFlight[i].key;
						again.nifPath  = g_inFlight[i].nifPath;
						again.label    = g_inFlight[i].label;
						again.angle    = g_inFlight[i].angle;
						again.px       = g_inFlight[i].px;
						again.fallback = true;   // extraNifs left EMPTY: the bare head
						again.tier     = g_inFlight[i].tier;
						QueueFor(again.tier).push_front(std::move(again));
						logger::warn("item icons: '{}' — the head+wig composite came out blank ({}). "
						             "Retrying once as the bare facegen head.",
							g_inFlight[i].label, why);   // marker: face-wig-refused-bare-retry
					} else if (!g_inFlight[i].fallback && g_inFlight[i].refit &&
						!g_inFlight[i].nifPath.empty()) {
						// ONE retry, on the framework's own bounding-sphere fit. If
						// our framing is what made the picture unusable, this is the
						// framing that cannot: it is the fit MRF ships, and it lands
						// the whole sphere at 0.9 of the frame.
						++g_failed;
						Request again;
						// The retry carries no swap entries, so it wears the BASE
						// textures — and a base-texture picture must never land under
						// the "-s2" name the index prefers for true swap renders.
						again.outPath  = g_inFlight[i].swapped
							? PlainNameOf(g_inFlight[i].outPath)
							: g_inFlight[i].outPath;
						again.key      = g_inFlight[i].key;
						again.nifPath  = g_inFlight[i].nifPath;
						again.label    = g_inFlight[i].label;
						again.angle    = g_inFlight[i].angle;
						again.px       = g_inFlight[i].px;
						again.refit    = g_inFlight[i].refit;
						again.fallback = true;   // ...and never again after this one
						again.tier     = g_inFlight[i].tier;
						QueueFor(again.tier).push_front(std::move(again));
						// Marker: item-icons-render-refused.
						logger::warn("item icons: '{}' — the renderer REFUSED the picture it made "
						             "({}). Nothing was written. Retrying once on the framework's "
						             "own bounding-sphere fit.",
							g_inFlight[i].label, why);
					} else {
						// Second refusal (or a render we never framed). Do NOT write a
						// keep-forever file on a guess: condemn it honestly and let the
						// tile wear its glyph with a reason instead of a broken picture.
						//
						// ⚠ AND KEEP THE KEY IN g_asked. It used to be erased here "so a
						// later ask can retry", which turned a deterministic refusal into
						// an infinite loop: a blank render is a property of the MESH, so
						// the retry produces the identical blank, and every face poll and
						// every deck open re-queued it. Measured 2026-09-17 on Rober's
						// rig: Willow (0.36% ink) and Vaelina (0.49%) re-rendered and were
						// refused every ~5 seconds for the whole session, two MRF renders
						// a tick, and the log contained nothing else.
						//
						// Nothing is lost by keeping it: g_asked is per-session, so a
						// relaunch re-tries on its own, and the EXPLICIT retry
						// (whIconRetry -> RetryIcons) erases the key AND clears the
						// verdict itself, so the tile's retry button still works.
						// Marker: item-icons-refused-sticky.
						++g_failed;
						BacklogDrop(g_inFlight[i].key);
						MarkFailed(g_inFlight[i].key,
							"the renderer refused the picture it made (" + why + ")");
						// Marker: item-icons-render-refused-twice.
						// "AGAIN" only when there WAS a first try — a face or body is
						// never refit, so its first refusal lands here directly, and
						// the old wording claimed a retry that never happened.
						logger::error("item icons: '{}' — refused {}({}). No file kept; the tile "
						              "keeps its glyph.",
							g_inFlight[i].label, g_inFlight[i].fallback ? "AGAIN on the retry " : "",
							why);
					}
				} else if (done) {
					++g_done;
					++g_landed;   // the view is told after the lock is released
					InvalidateListings();   // the new PNG must be in the next index
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
					ClearFailed(g_inFlight[i].key);   // it arrived after all
					BacklogDrop(g_inFlight[i].key);  // landed — nothing left to remember
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
					// The bare retry lands under the PLAIN name — "-s2" stays
					// reserved for renders that really wore the variant.
					again.outPath = PlainNameOf(g_inFlight[i].outPath);
					again.key     = g_inFlight[i].key;
					again.nifPath = g_inFlight[i].nifPath;
					again.label   = g_inFlight[i].label;
					again.angle   = g_inFlight[i].angle;   // same turntable frame
					again.refit   = g_inFlight[i].refit;   // ...and the SAME framing — a
					// bare retry that dropped the box-fit baked a permanently
					// mis-framed icon under the plain name (2026-08-19 swarm find)
					again.tier    = g_inFlight[i].tier;    // ...and its own lane
					// swaps deliberately empty — that IS the retry.
					QueueFor(again.tier).push_front(std::move(again));
					logger::warn("item icons: '{}' drew nothing through its texture swap in {}s — "
								 "retrying as the bare mesh",
						g_inFlight[i].label, static_cast<long long>(kRenderTimeout.count()));
				} else {
					++g_failed;
					g_asked.erase(g_inFlight[i].key);   // a later call may retry
					// A timeout is not resumed across sessions either — replaying a
					// render the framework already refused once per boot would grind
					// the same dead end forever. A fresh USER ask (or Retry) still
					// re-queues it, and that ask re-enters the backlog.
					BacklogDrop(g_inFlight[i].key);
					MarkFailed(g_inFlight[i].key,
						"the renderer never produced a picture for it (timed out)");
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
			// A menu is up: hold everything for the grace window, then use the
			// short menu gap rather than no gap at all. See kMenuOpenGrace.
			const bool inMenuGrace = !paced && g_idleSince != std::chrono::steady_clock::time_point{} &&
			                         (now - g_idleSince) < kMenuOpenGrace;
			auto paceOk = [&](std::chrono::milliseconds gap) -> bool {
				if (inMenuGrace)
					return false;
				const auto eff = paced ? gap : kPaceGapMenu;
				if (g_lastStart != std::chrono::steady_clock::time_point{} &&
					(now - g_lastStart) < eff) {
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

			/* ── the reserved slot ──────────────────────────────────────────
			 * Draining the user queue first is only half of "user asks are
			 * strictly first": if both in-flight slots were already carrying
			 * background renders, the next user ask still had to wait for one
			 * of them to finish. MRF gives us no way to cancel a render that is
			 * already armed (the framework writes the file from its own render
			 * loop), so the fix is to never let the background fill the budget:
			 * at most kMaxBgInFlight of the kMaxInFlight slots may hold work
			 * nobody is waiting on. A user ask therefore always finds a free
			 * slot and starts on the next pump — no in-flight render is ever
			 * preempted, and none has to be.
			 *
			 * The other half: while ANY user work is queued, the background
			 * lanes start nothing at all, even into a free slot. */
			constexpr std::size_t kMaxBgInFlight = 1;
			static_assert(kMaxBgInFlight < kMaxInFlight, "no slot left reserved for user asks");
			const bool  userPending = !g_queue.empty();
			std::size_t bgInFlight  = BackgroundInFlight();

			// The one residual delay, said out loud: the budget was full when a user
			// ask wanted a slot. Nothing is cancelled mid-render (the framework
			// writes the PNG from its own render loop and has no cancel), so the ask
			// starts as soon as one of these retires — worst case one render.
			// Build marker (hd-markers.json: "render-priority-wait").
			if (!blocked && userPending && g_inFlight.size() >= kMaxInFlight) {
				if (!g_userWaitLogged) {
					g_userWaitLogged = true;
					logger::info("item icons: render-priority hold — {} user render(s) waiting on {} in flight "
								 "({} background); the next free slot is theirs",
						g_queue.size(), g_inFlight.size(), bgInFlight);
				}
			}

			/* BULK tier: the wardrobe's catalogue sweep. It runs as soon as the
			 * user tier is quiet — these ARE the pictures the tab wants — but it
			 * is preempted by the next user ask, it can hold only the
			 * non-reserved slot, and while the game is live it takes the long
			 * background gap (nobody is waiting on it, so it must not race the
			 * world draw). Unlike the idle tier it is NOT subject to the
			 * warm-start settle / post-load holds: a sweep asked for by an open
			 * tab should not wait 45 s of play. */
			while (!blocked && !userPending && !g_bulkQueue.empty() &&
				g_inFlight.size() < kMaxInFlight && bgInFlight < kMaxBgInFlight &&
				paceOk(kPaceGapIdle)) {
				Request r = std::move(g_bulkQueue.front());
				g_bulkQueue.pop_front();
				if (Start(r)) {
					g_lastStart = now;
					++bgInFlight;
				} else {
					g_asked.erase(r.key);
				}
			}
			// IDLE tier LAST: only when the user AND bulk queues are empty and there
			// is still in-flight room (minus the reserved slot). A user request that
			// arrives later is rotated to the FRONT of g_queue and is taken on the
			// NEXT pump before any of these, so the warm-start never delays a page
			// the player opened. Live, the idle tier gets the LONGER gap
			// (kPaceGapIdle) — nobody is waiting on it, so it spreads even more
			// gently.
			//
			// And while the game is LIVE, hold the idle tier off entirely for the
			// first kIdleSettleDelay of live play: that is the boot re-bake burst's
			// window and the load-in period where a stolen D3D frame hitches worst.
			// The warm-start promises "the first minutes show real faces", so
			// starting ~45 s of play in still keeps that promise while sparing the
			// load-in. When PAUSED (deck open / load screen) there is no world to
			// contend with, so `idleSettled` is forced true — a player who opens the
			// Finder right after boot still gets warm-start faces immediately.
			// Background lanes are capped at kMaxBgInFlight (see the reserved slot
			// above) whether the game is live or paused: one offscreen pass at a
			// time against the world draw, and always a free slot for the next user
			// ask. Warm-start throughput with the deck open is halved by that on
			// purpose — a fast warm-start that can make the F7 card wait is exactly
			// the trade Rober rejected.
			const bool idleSettled = !paced || g_liveElapsed >= kIdleSettleDelay;
			if (paced && idleSettled && !g_idleSettleLogged &&
				g_liveElapsed >= kIdleSettleDelay && !g_idleQueue.empty()) {
				g_idleSettleLogged = true;
				logger::info("render warm-start: settle window passed ({} s live) — idle re-bake now trickling",
					static_cast<long long>(
						std::chrono::duration_cast<std::chrono::seconds>(g_liveElapsed).count()));
			}
			// The post-load hold (see kPostLoadIdleHold): applies whether or not the
			// game is paused, because "paused" right after a load usually means the
			// player opened the deck while the cell is still streaming.
			const bool postLoadHold =
				g_lastLoadingSeen != std::chrono::steady_clock::time_point{} &&
				(now - g_lastLoadingSeen) < kPostLoadIdleHold;
			while (!blocked && idleSettled && !postLoadHold && !userPending && g_bulkQueue.empty() &&
				!g_idleQueue.empty() && g_inFlight.size() < kMaxInFlight &&
				bgInFlight < kMaxBgInFlight && paceOk(kPaceGapIdle)) {
				Request r = std::move(g_idleQueue.front());
				g_idleQueue.pop_front();
				if (Start(r)) {
					g_lastStart = now;
					++bgInFlight;
				} else {
					g_asked.erase(r.key);
				}
			}

			// Burst boundary: once nothing is queued or in flight, re-arm the
			// once-per-burst pacing log so the NEXT live burst says so afresh.
			if (g_queue.empty() && g_bulkQueue.empty() && g_idleQueue.empty() && g_inFlight.empty()) {
				g_paceLogged     = false;
				g_userWaitLogged = false;
			}
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
			if (FileExists(IconDir() / ItemFileFor(fid, plugin, true)) ||
				FileExists(IconDir() / ItemFileFor(fid, plugin, false)))
				g_diskIndex.insert(key);
		}

		// Declared with the face machinery below; used here so a user ask can lift
		// a bulk- or backlog-queued item into the user lane the same way it lifts
		// a face. Returns true if it moved one.
		bool PromoteToUser(const std::string& key);

		// Counts what the current public entry point promoted out of the background
		// lanes, so its log line can say so. Only ever touched under g_mutex, and
		// only by the public entry points that reset it before their walk.
		std::size_t g_promotedThisAsk = 0;

		// The owner tag the current public entry point stamps on what it queues
		// (EnsureIconsForList only). Same idiom and the same lock as above.
		std::string g_ownerThisAsk;

		// Queue one item if it needs rendering. g_mutex held. Returns true if queued.
		// `tier` parks it on the user, bulk or idle deque — same dedup, same
		// derivation, same file; only WHICH deque and WHICH ceiling differ.
		bool EnqueueLocked(const std::string& fid, const std::string& plugin, const std::string& name,
			Tier tier = Tier::User)
		{
			if (fid.empty() || plugin.empty() || QueueFor(tier).size() >= CapFor(tier))
				return false;
			const auto key = KeyOf(fid, plugin);
			if (g_asked.count(key)) {
				// Already asked this session. A USER ask finding it parked on a
				// background lane (the wardrobe sweep or a backlog replay queued
				// it) promotes it, so the page the player opened is never stuck
				// behind work nobody is waiting on.
				if (tier == Tier::User && PromoteToUser(key))
					++g_promotedThisAsk;
				// Waiting under ANOTHER surface's tag: two surfaces want it now, so
				// it is nobody's to take back (see the supersede step).
				if (tier == Tier::User)
					for (auto& r : g_queue)
						if (r.key == key && !r.owner.empty() && r.owner != g_ownerThisAsk)
							r.owner.clear();
				return false;
			}
			if (g_failedWhy.count(key)) return false;  // only an explicit Retry clears a dead end
			// The look has to be derived FIRST now, because whether this piece has
			// a texture swap decides which filename it renders to — and therefore
			// whether the icon already sitting on disk is one of ours or one of
			// the untextured ones the swap-less fallback wrote (see FileFor).
			auto look = LookOf(fid, plugin);
			if (look.nif.empty()) {
				g_asked.insert(key);   // nothing to render; don't re-derive every call
				BacklogDrop(key);      // a permanent miss never resumes across sessions
				// THE silent case: a form with no world model can never render, and
				// until now the tile just waited. Say so once, out loud and on the
				// tile (the wig that "got stuck" on 2026-08-15).
				MarkFailed(key, look.missing.empty()
					? "this record ships no world model, so there is nothing to render"
					: "mesh file is missing: " + look.missing);
				logger::info("item icons: '{}' has no readable model ({}) — {}",
					name.empty() ? key : name, key, look.missing);
				return false;
			}
			/* With swaps latched off (new-architecture MRF, or two strikes) a
			 * retexture variant renders as the BARE mesh — that picture must land
			 * under the PLAIN name, never under "-s2" (the name the index prefers,
			 * reserved for renders that really carried the variant's textures). */
			const bool hasSwaps = !look.swaps.empty();
			const bool wantSwap = hasSwaps && !g_swapDisabled;
			const auto out = PathU8((IconDir() / ItemFileFor(fid, plugin, wantSwap)));
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				BacklogDrop(key);
				return false;
			}
			if (hasSwaps && !wantSwap &&
				FileExists(IconDir() / ItemFileFor(fid, plugin, true))) {
				// a good swap-rendered icon from an earlier session still wins the
				// index — don't burn a render on a bare duplicate beside it
				g_asked.insert(key);
				BacklogDrop(key);
				return false;
			}
			Request r;
			r.outPath = out;
			r.key     = key;
			r.nifPath = std::move(look.nif);
			r.swaps   = wantSwap ? std::move(look.swaps) : std::vector<AltTex>{};
			r.label   = name.empty() ? key : name;
			r.refit   = true;   // frame-0 item render: box-fit so clutter fills the frame
			r.tier    = tier;
			if (tier == Tier::User)
				r.owner = g_ownerThisAsk;
			QueueFor(tier).push_back(std::move(r));
			g_asked.insert(key);
			BacklogAdd(key, fid, plugin, name, "item");
			return true;
		}

		// Pull {formId,plugin,name} triples out of one of the deck's export files.
		std::size_t EnqueueFromFile(const std::filesystem::path& file, bool nested, Tier tier)
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
								it.value("plugin", std::string("")), it.value("name", std::string("")),
								tier))
							++queued;
			} else {   // wardrobe-catalogue.json: {outfits:[{items:[...]}]}
				if (j.contains("outfits") && j["outfits"].is_array())
					for (const auto& o : j["outfits"])
						if (o.is_object() && o.contains("items") && o["items"].is_array())
							for (const auto& it : o["items"])
								if (it.is_object() &&
									EnqueueLocked(it.value("formId", std::string("")),
										it.value("plugin", std::string("")),
										it.value("name", std::string("")), tier))
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
				const auto deadline = std::chrono::steady_clock::now() + kWatchMax;
				auto       tick     = kTickIdle;
				while (std::chrono::steady_clock::now() < deadline) {
					std::this_thread::sleep_for(tick);
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
						// Landings are pushed WHILE the batch runs, so the tab fills
						// in under the player instead of waiting for the whole batch
						// (or a reopen) to reveal any of it. But not one push per
						// landing: each push re-serialises three whole indexes into
						// the view, and the Finder lands three or four pictures a
						// second (2026-10-07, "lagged super hard"). Landings are
						// gathered and pushed at most every kNotifyGap; the two index
						// FILES (for the portal and the next launch) are written at
						// most every kIndexFileGap. The batch-end task below always
						// does both, so nothing is ever left unsaid or unsaved.
						// Build marker (hd-markers.json: "item-icons-notify-coalesced").
						if (landed) {
							g_notifyPending = true;
							g_indexFilePending = true;
							static bool said = false;
							if (!said) {
								said = true;
								logger::info("item-icons-notify-coalesced: landings pushed to the views at most every {} ms, "
								             "index files saved at most every {} s",
									kNotifyGap.count(),
									std::chrono::duration_cast<std::chrono::seconds>(kIndexFileGap).count());
							}
						}
						const auto now = std::chrono::steady_clock::now();
						if (g_notifyPending && now - g_lastNotify >= kNotifyGap) {
							g_notifyPending = false;
							g_lastNotify    = now;
							if (g_onBatchDone)
								g_onBatchDone();
						}
						if (g_indexFilePending && now - g_lastIndexFile >= kIndexFileGap) {
							g_indexFilePending = false;
							g_lastIndexFile    = now;
							WriteIndexFile();
							WriteNpcIndexFile();   // persist any face/body that just landed
						}
						// Keep the unfinished-render backlog current while work is
						// pending, so a crash or quit mid-batch forgets nothing.
						BacklogSaveIfDirty();
					});
					{
						std::lock_guard l(g_mutex);
						busy = !g_queue.empty() || !g_bulkQueue.empty() || !g_idleQueue.empty() ||
							!g_inFlight.empty();
						// The tick IS the throughput ceiling for anything the player
						// is waiting on: nothing starts and nothing is retired
						// between pumps, so at 700 ms a user batch could never
						// exceed ~1.4 renders/s no matter how idle the GPU was
						// (measured 2026-08-19: starts 700 ms apart for renders that
						// each finished in ~250 ms). While a user ask is queued or
						// rendering, look far more often — the pacing gaps
						// (kPaceGapUser / kPaceGapMenu, and the menu grace window)
						// still decide when a render may START, so this only stops
						// the watcher from being the slower of the two limits. (Covered
						// by the render-priority-* markers: same file, same change.)
						const bool userBusy = !g_queue.empty() ||
							g_inFlight.size() > BackgroundInFlight();
						tick = userBusy ? kTickUser : kTickIdle;
					}
					if (!busy)
						break;
				}
				g_watching = false;
				SKSE::GetTaskInterface()->AddTask([]() {
					g_notifyPending = g_indexFilePending = false;
					g_lastNotify = g_lastIndexFile = std::chrono::steady_clock::now();
					WriteIndexFile();
					WriteNpcIndexFile();
					if (g_onBatchDone)
						g_onBatchDone();
				});
			}).detach();
		}
	}

	// Defined after the face/body enqueue machinery below; declared here so Init
	// can replay the persisted unfinished-render backlog once binding is done.
	void ResumeBacklog();

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
		// Optional: composes a facegen head with a worn wig in ONE mesh. Absent on
		// an old framework, in which case faces render bare-facegen (bald wig NPCs)
		// exactly as they did before 2026-08-16 — never an error.
		g_createBySet     = reinterpret_cast<CreateBySetFn>(GetProcAddress(mod, "IMesh_CreateByNifPathSet"));
		g_setTexSet       = reinterpret_cast<SetTexSetFn>(GetProcAddress(mod, "IMesh_SetTextureSet"));
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
		 * is detectable by an export the old architecture never had.
		 *
		 * Our from-source MRF build (zz-shape-textureset.patch, 2026-08-15) adds
		 * IMesh_SetShapeTextureSet — a per-shape texture-set override with no
		 * skin gate — so on that build the swap goes through the framework API
		 * (ApplySwapViaApi) and retexture variants render TRUE again. On a
		 * rewrite WITHOUT the patch (stock Nexus build), latch the swap-disable
		 * as before: bare mesh under the plain filename, existing good -s2 icons
		 * keep winning the index. Either way the rewrite is what renders FaceGen
		 * heads (skin posing + facetint) — the NPC Finder's portraits — which
		 * the old architecture drew as a black square. */
		if (GetProcAddress(mod, "IMesh_SetTextureSet")) {
			g_setShapeTex = reinterpret_cast<SetShapeTexFn>(GetProcAddress(mod, "IMesh_SetShapeTextureSet"));
			if (g_setShapeTex) {
				logger::info("item icons: new-architecture Mesh Rendering Framework with per-shape "
							 "texture sets — swaps go through the framework API (variants render true)");
			} else {
				g_swapDisabled = true;
				logger::info("item icons: new-architecture Mesh Rendering Framework detected — "
							 "texture swaps off (bare-mesh renders), FaceGen head renders on");
			}
		}
		// A new MRF build (or a bumped epoch) invalidates every kept face/body
		// render — do the one-time purge now, before anything asks for one.
		ReconcileFaceGenGeneration();
		// A bumped item epoch (a look-affecting change to this file, e.g. the
		// 2026-08-14 clutter-fill framing) purges the plain item renders once so
		// they re-bake framed correctly; a bumped SWAP epoch does the same for the
		// "-s2" renders when the swap route itself changes. Each generation only
		// ever purges its own renders.
		ReconcileItemGeneration();
		logger::info("item icons: Mesh Rendering Framework bound — armour renders at {}px", kSize);
		// Renders still queued when the last session ended resume now, at idle
		// priority — the "remembered on reload" half of render-once-keep-forever.
		ResumeBacklog();
	}

	bool Available() { return Ready(); }

	void EnsureIcons()
	{
		if (!Ready())
			return;
		const auto viewDir = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck";
		std::size_t queued  = 0;
		/* BULK, not user (2026-08-19). This is a speculative sweep of the two
		 * wardrobe exports — every piece the player owns plus every catalogued
		 * outfit — and it fires on a tab open, a catalogue export or a portal
		 * inventory refresh. On 2026-08-19 it put 59 renders into the shared user
		 * queue 260 ms before Rober pressed F7 on an NPC, and his quick card's
		 * three worn tiles rendered 41 s later, dead last. The rows actually ON
		 * SCREEN never depended on this walk: they ask through EnsureIconsForList
		 * (user tier) as they are drawn. So the sweep runs in the lane that yields
		 * to a real ask. */
		queued += EnqueueFromFile(viewDir / "wardrobe-inventory.json", false, Tier::Bulk);
		queued += EnqueueFromFile(viewDir / "wardrobe-catalogue.json", true, Tier::Bulk);
		// Even with nothing to render, the walk above just learned which icons
		// already exist — put that on disk for the portal.
		WriteIndexFile();
		BacklogSaveIfDirty();
		if (!queued)
			return;
		logger::info("item icons: {} armour render(s) queued at bulk priority (yields to anything asked for on screen)",
			queued);   // marker: render-priority-bulk-sweep
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
		/* SUPERSEDE (2026-10-07). A tagged ask with "replace":true takes back that
		 * owner's earlier asks still WAITING in the user queue that this list no
		 * longer names. The Finder asks one page at a time, and flipping through
		 * a mod's weapons queued every page behind the next: 67 renders in seven
		 * seconds, still landing half a minute after the deck closed, each one a
		 * stall the player felt. Now the queue holds the page on screen and
		 * nothing else; leaving the tab sends an empty replace that clears it.
		 * Renders already in flight finish (they are a frame or two from done).
		 * A dropped key leaves g_asked and the backlog, so asking for it again
		 * later queues it afresh. Build marker (hd-markers.json:
		 * "item-icons-supersede"). */
		const std::string owner   = j.value("owner", std::string());
		const bool        replace = !owner.empty() && j.value("replace", false);
		std::size_t queued = 0, promoted = 0, dropped = 0;
		{
			std::lock_guard l(g_mutex);
			if (replace) {
				std::unordered_set<std::string> keep;
				for (const auto& it : j["items"])
					if (it.is_object())
						keep.insert(KeyOf(it.value("formId", std::string()), it.value("plugin", std::string())));
				for (auto r = g_queue.begin(); r != g_queue.end();) {
					if (r->owner == owner && !keep.count(r->key)) {
						g_asked.erase(r->key);
						BacklogDrop(r->key);
						r = g_queue.erase(r);
						++dropped;
					} else {
						++r;
					}
				}
				if (dropped)
					logger::info("item-icons-supersede: {} waiting '{}' render(s) dropped for the newer ask "
					             "({} in the user queue now)", dropped, owner, g_queue.size());
			}
			// Everything appended (or promoted out of bulk/idle) by this walk is
			// rotated to the FRONT of the user queue: this list is a surface the
			// player is looking at RIGHT NOW — the F7 quick card's worn tiles, a
			// Finder page, the Potion Browser / Quiver / wheel popout, wardrobe
			// rows — and it must beat both the background lanes and any older
			// user batch. See FrontLoadUserBatch.
			const std::size_t before = g_queue.size();
			g_promotedThisAsk        = 0;
			g_ownerThisAsk           = owner;
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				if (EnqueueLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string())))
					++queued;
			}
			g_ownerThisAsk.clear();
			promoted = g_promotedThisAsk;
			FrontLoadUserBatch(before);
			if (queued || promoted) {
				LogUserAskDepth("listed", queued, promoted);
				Pump();   // and start it NOW rather than on the next watcher tick
			}
		}
		// Even with nothing new to render, the walk above registered the worn
		// keys — the index now names every piece that already has a PNG, which
		// is what the quick card needs on a session where the Wardrobe tab
		// never opened (IndexJson only reports keys asked THIS session).
		// An EMPTY list is a view's poll ("anything new on disk?") and registered
		// nothing, so it does not rewrite the file — the panes poll every few
		// seconds and the watcher already saves what lands.
		if (!j["items"].empty() || dropped)
			WriteIndexFile();
		BacklogSaveIfDirty();
		if (!queued && !promoted)
			return;
		if (queued)
			logger::info("item icons: {} listed render(s) queued", queued);
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

		/* A WIG is never in the facegen file — the "bald Frau Peach" fix.
		 *
		 * The CK bakes every HEAD PART into <plugin>\<8hex>.nif, so a facegen
		 * render normally carries hair, brows, lashes and eyes with the head.
		 * It can NEVER carry a WIG: HDT-SMP hair has to be a worn ARMO (head
		 * parts get no physics), so a follower whose hair is a wig renders BALD
		 * from her facegen alone. Proven on the rig 2026-08-16: Frau Peach's
		 * facegen holds 9 shapes — head, mouth, lashes, eyes, two lens dummies,
		 * two eye overlays, brows — and not one hair shape, which is exactly
		 * what Rober photographed ("rendering without hair or eyes ... it has to
		 * be smarter than this").
		 *
		 * So hand the framework the wig as an ATTACHMENT nif beside the head —
		 * the same composition MRF's own CreateWholeNpc performs. Hair slots
		 * only (31 kHair / 41 kLongHair, wigs.cpp's rule): this is a FACE tile,
		 * so no body, no outfit, nothing else.
		 *
		 * TRAP: this must stay best-effort and silent. Every miss (no such NPC,
		 * no outfit, no hair armour, file absent) returns empty and the face
		 * renders exactly as it did before.
		 */
		std::vector<std::string> HairNifsForFace(const std::string& fid, const std::string& plugin)
		{
			std::vector<std::string> out;
			std::uint32_t            local = 0;
			try {
				local = static_cast<std::uint32_t>(std::stoul(
					fid.rfind("0x", 0) == 0 || fid.rfind("0X", 0) == 0 ? fid.substr(2) : fid, nullptr, 16));
			} catch (...) {
				return out;
			}
			if (!local)
				return out;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return out;
			RE::TESForm* form = dh->LookupForm(local, plugin);
			auto*        npc  = form ? form->As<RE::TESNPC>() : nullptr;
			if (!npc || !npc->race)
				return out;
			auto*     race = npc->race;
			const int sex =
				npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kFemale) ? 1 : 0;
			// Same gate the head itself passes: probe the game's own resource
			// stack (loose + BSA, MO2 VFS applied) so a missing file costs the
			// framework nothing. Cap + dedupe shared by every source below.
			auto addModel = [&](const std::string& model) {
				if (model.empty() || out.size() >= 4)
					return;   // a head wears one hairdo; a runaway list is a bug, not a hairstyle
				RE::BSResourceNiBinaryStream probe(("meshes\\" + model).c_str());
				if (!probe.good())
					return;
				if (std::find(out.begin(), out.end(), model) == out.end())
					out.push_back(model);
			};
			// GetSlotMask() hands back the raw bit-flag enum, not an EnumSet —
			// test the bits (wigs.cpp's hard-won note).
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			const std::uint32_t hairMask = static_cast<std::uint32_t>(Slot::kHair) |
										   static_cast<std::uint32_t>(Slot::kLongHair);
			const std::uint32_t headMask = static_cast<std::uint32_t>(Slot::kHead);
			auto addWig = [&](RE::TESObjectARMO* armo) {
				if (!armo || (static_cast<std::uint32_t>(armo->GetSlotMask()) & hairMask) == 0)
					return;
				/* A HELMET IS NOT A WIG (Adney Swordhand, 2026-09-23). Helmets,
				 * hoods and hats claim the hair slot too — to hide the hair under
				 * them — so the hair-mask test alone composed his outfit's Wolf
				 * Helmet onto the face. The render came out 0.94% ink, MRF refused
				 * it, and the tile sat on initials. A face tile is the FACE: head
				 * gear is never composed. A real wig claims hair only; anything
				 * that also claims the HEAD slot, or is keyworded as head gear,
				 * is dropped here. */
				if ((static_cast<std::uint32_t>(armo->GetSlotMask()) & headMask) != 0 ||
					armo->HasKeywordID(0x0006C0EE) /* ArmorHelmet */ || armo->HasKeywordID(0x0010CD11) /* ClothingHead */) {
					logger::debug("item icons: '{}' is head gear, not a wig - not composed onto face {}|{}",
						armo->GetName() ? armo->GetName() : "", fid, plugin);  // marker: face-wig-not-helmet
					return;
				}
				// Per-ADDON, not per-armour: a multi-slot ARMO (a follower's
				// custom SKIN, a full outfit) matches the hair mask at the
				// armour level while its first addon is the TORSO - composing
				// that onto a head would be worse than staying bald. Only ARMAs
				// whose OWN slots are hair contribute their model.
				//
				// And only the addon for THE NPC'S RACE: an armour ships one ARMA per
				// race family (human / Khajiit / Argonian / Orc), all claiming the
				// same slots, so the old loop stacked all four race variants onto
				// one head. Addons valid for the NPC's race win; if none is (a
				// custom race the author never listed), the FIRST hair addon alone
				// stands in — never the whole set.
				auto hairModel = [&](RE::TESObjectARMA* arma) -> const char* {
					if (!arma || (static_cast<std::uint32_t>(arma->GetSlotMask()) & hairMask) == 0)
						return nullptr;
					const char* m = arma->bipedModels[sex].GetModel();
					if (!m || !*m)
						m = arma->bipedModels[sex ? 0 : 1].GetModel();   // some wigs fill only one sex slot
					return (m && *m) ? m : nullptr;
				};
				bool        added     = false;
				const char* firstHair = nullptr;
				for (auto* arma : armo->armorAddons) {
					const char* m = hairModel(arma);
					if (!m)
						continue;
					if (!firstHair)
						firstHair = m;
					if (!arma->IsValidRace(race))
						continue;   // marker: face-wig-race-addon
					addModel(m);
					added = true;
				}
				if (!added && firstHair) {
					addModel(firstHair);
					added = true;
				}
				// A wig authored with slots only at the ARMO level still gets
				// its race addon, exactly like before.
				if (!added) {
					std::string model;
					if (auto* arma = armo->GetArmorAddon(race)) {
						if (const char* m = arma->bipedModels[sex].GetModel(); m && *m)
							model = m;
						else if (const char* m2 = arma->bipedModels[sex ? 0 : 1].GetModel(); m2 && *m2)
							model = m2;
					}
					addModel(model);
				}
			};

			// 1. The outfit wig — the original source.
			if (npc->defaultOutfit)
				for (auto* item : npc->defaultOutfit->outfitItems)
					addWig(item ? item->As<RE::TESObjectARMO>() : nullptr);

			// 2. HEAD-PART hair (the Frau Peach case): custom-race followers
			// (UBE and kin) keep hair as a real head part their facegen bake
			// never includes, so the bare facegen renders BALD. Vanilla-style
			// NPCs bake hair INTO the facegen — MRF's composite skips an
			// attached hair shape when the base already carries substantial
			// hair, which is what makes passing it unconditionally safe for
			// both. Ships as a matched set with the MRF flags-additive-hair
			// patch; an older MRF simply ignores the attachment.
			for (std::int8_t i = 0; i < npc->numHeadParts; ++i) {
				auto* hp = npc->headParts ? npc->headParts[i] : nullptr;
				/* EQUALITY, not .any(): HeadPartType is a plain sequential enum
				 * (kEyes=2, kHair=3, kEyebrows=6), so the bitwise .any(kHair)
				 * test also matched eyes (2&3) and brows (6&3). Those leaked in
				 * as attachments, and the composite dedupe only knows how to
				 * drop duplicate HAIR — so a default un-morphed EyesMale.nif
				 * drew OVER the facegen's real eyes: Rober's 2026-08-19 "he has
				 * no eyes" blank-white-orbs report, proven from the MRF draw
				 * log (both 'maleeyeshumanhazelbrown' AND 'eyesmale' drawn). */
				if (!hp || hp->type.get() != RE::BGSHeadPart::HeadPartType::kHair) {
					if (hp && hp->GetModel() && *hp->GetModel())
						logger::debug("item icons: head part '{}' is not hair - not composed (hair-only head-part filter)", hp->GetModel());  // marker: face-hair-strict
					continue;
				}
				if (const char* m = hp->GetModel(); m && *m) {
					logger::info("item icons: hair from head part '{}' for face {}|{}", m, fid, plugin);  // marker: face-hair-headparts
					addModel(m);
				}
				for (auto* extra : hp->extraParts) {
					if (!extra)
						continue;
					if (const char* em = extra->GetModel(); em && *em)
						addModel(em);
				}
			}

			// 3. WORN-ARMOR (WNAM skin) hair addons - Frau Peach's ACTUAL
			// setup, read out of her ESP: no hair head part, empty inventory,
			// no outfit - her skin ARMO carries a dedicated hair ARMA
			// (slots kHair|kLongHair, model !UBE\...\Hair.nif) beside the
			// body/hands/feet addons. addWig's per-addon rule keeps the body
			// parts out.
			{
				const std::size_t before = out.size();
				addWig(npc->skin);
				if (out.size() > before)
					logger::info("item icons: hair from worn-armor skin for face {}|{}", fid, plugin);  // marker: face-hair-wornskin
			}

			// 4. INVENTORY wigs: plenty of followers carry the wig as a plain
			// carried item they equip at runtime, never listed in the outfit.
			if (auto* container = npc->As<RE::TESContainer>()) {
				for (std::uint32_t i = 0; i < container->numContainerObjects; ++i) {
					auto* entry = container->containerObjects ? container->containerObjects[i] : nullptr;
					addWig(entry && entry->obj ? entry->obj->As<RE::TESObjectARMO>() : nullptr);
				}
			}
			return out;
		}

		/* If `key` is still parked (not yet started) in a BACKGROUND queue, splice
		 * it onto the tail of the USER queue — where its caller's
		 * FrontLoadUserBatch will then rotate it to the front with the rest of
		 * that ask. g_mutex held. Returns true if it moved one.
		 *
		 * Called when a page requests something a background lane already queued:
		 * the boot warm-start's roster faces, the resumed backlog, or (since
		 * 2026-08-19) the wardrobe's bulk sweep — which is how Rober's F7 card
		 * ended up behind 59 catalogue renders. Without this the render would
		 * stay in the background lane and could be delayed behind the whole set,
		 * the exact priority inversion the tiers exist to prevent. Bulk is
		 * scanned first: it is the lane most likely to hold what a page wants. */
		bool PromoteToUser(const std::string& key)
		{
			for (auto* q : { &g_bulkQueue, &g_idleQueue }) {
				for (auto it = q->begin(); it != q->end(); ++it) {
					if (it->key == key) {
						it->tier = Tier::User;
						g_queue.push_back(std::move(*it));
						q->erase(it);
						return true;
					}
				}
			}
			return false;
		}

		// g_mutex held. Returns true if a NEW render was queued. `tier` parks it on
		// the user, bulk or idle deque (the warm-start and the resumed backlog are
		// idle) — same dedup, same probe, same file; only WHICH deque and WHICH
		// ceiling differ.
		bool EnqueueFaceLocked(const std::string& fid, const std::string& plugin, const std::string& name,
			Tier tier = Tier::User)
		{
			if (fid.empty() || plugin.empty())
				return false;
			if (QueueFor(tier).size() >= CapFor(tier))
				return false;
			// Distinct asked-key namespace: IndexJson skips any key with '@',
			// and Pump's failure-erase works on this key unchanged.
			const auto key = KeyOf(fid, plugin) + "@face";
			if (g_asked.count(key)) {
				// Already asked this session. If a USER request finds it still waiting
				// on a background lane (boot warm-start or the backlog queued it),
				// promote it so the page the player opened is not stuck behind that set.
				if (tier == Tier::User && PromoteToUser(key))
					++g_promotedThisAsk;
				return false;
			}
			// Shared VFS lookup includes verified old-ID recovery. Keep the
			// output key/filename and wig owner on the CURRENT actor identity.
			const auto rel = FaceGenResolver::Resolve(fid, plugin);
			if (rel.empty()) {
				g_asked.insert(key);
				BacklogDrop(key);   // no facegen file — a permanent miss never resumes
				return false;
			}
			const auto out = PathU8((FaceDir() / FileFor(fid, plugin, false)));
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				BacklogDrop(key);
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
			// Hair the facegen file cannot hold (a worn wig). Resolved here, at
			// queue time, so Start() stays a pure consumer of the Request.
			if (g_createBySet)
				r.extraNifs = HairNifsForFace(fid, plugin);
			r.tier = tier;

			QueueFor(tier).push_back(std::move(r));
			g_asked.insert(key);
			BacklogAdd(key, fid, plugin, name, "face");
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
		std::size_t queued = 0, promoted = 0;
		bool        any    = false;
		{
			std::lock_guard l(g_mutex);
			const std::size_t before = g_queue.size();
			g_promotedThisAsk        = 0;
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				any = true;
				if (EnqueueFaceLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string())))
					++queued;
			}
			promoted = g_promotedThisAsk;
			// Faces asked for by an OPEN tab (the Finder's rows, the followers
			// roster) are the surface on screen — front of the user queue, ahead of
			// any older user batch as well as the background lanes.
			FrontLoadUserBatch(before);
			if (queued || promoted)
				LogUserAskDepth("face", queued, promoted);
			// Pump under the same lock: a user request that only PROMOTED an
			// already-background-queued face (queued stays 0, but EnqueueFaceLocked
			// moved it onto g_queue) must still start now, not wait for the next
			// watcher tick — otherwise the promotion wouldn't actually beat the
			// warm-start set to the render slot.
			if (any)
				Pump();
		}
		if (queued)
			logger::info("item icons: {} npc face render(s) queued at {}px", queued, kFaceSize);  // marker: face-render-density
		BacklogSaveIfDirty();
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
						Tier::Idle))
					++queued;
			}
		}
		if (!queued)
			return 0;   // every roster face was already on disk or has no facegen file
		logger::info("render warm-start: {} roster faces queued at idle", queued);  // marker: render-warm-start
		BacklogSaveIfDirty();
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

		// g_mutex held. Returns true if a render was queued. `tier` parks it on the
		// user, bulk or idle deque (the backlog replay is idle) — same dedup, probe
		// and file.
		bool EnqueueBodyLocked(const std::string& fid, const std::string& plugin,
			const std::string& name, const std::string& nif, Tier tier = Tier::User)
		{
			if (fid.empty() || plugin.empty() || nif.empty() ||
				QueueFor(tier).size() >= CapFor(tier))
				return false;
			const auto key = KeyOf(fid, plugin) + "@body";
			if (g_asked.count(key)) {
				if (tier == Tier::User && PromoteToUser(key))
					++g_promotedThisAsk;
				return false;
			}
			// Probe through the game's resource stack (loose + BSA, MO2 VFS)
			// before burning a mesh — a mod can ship a record whose model file
			// never made it into the archive.
			RE::BSResourceNiBinaryStream probe(ProbePathOf(nif).c_str());
			if (!probe.good()) {
				g_asked.insert(key);
				BacklogDrop(key);   // the model is not in the load order — permanent
				logger::warn("item icons: mount body '{}' — model '{}' is not in the load order", name, nif);
				return false;
			}
			const auto out = PathU8((BodyDir() / FileFor(fid, plugin, false)));
			if (FileExists(out)) {   // render once, keep forever
				g_asked.insert(key);
				BacklogDrop(key);
				return false;
			}
			std::error_code ec;
			std::filesystem::create_directories(BodyDir(), ec);
			Request r;
			r.outPath = out;
			r.key     = key;
			r.nifPath = nif;      // swaps deliberately empty (new-arch MRF ignores them anyway)
			r.label   = name.empty() ? key : name;
			r.tier    = tier;
			QueueFor(tier).push_back(std::move(r));
			g_asked.insert(key);
			BacklogAdd(key, fid, plugin, name, "body", nif);
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
		std::size_t queued = 0, promoted = 0;
		{
			std::lock_guard l(g_mutex);
			const std::size_t before = g_queue.size();
			g_promotedThisAsk        = 0;
			for (const auto& it : j["items"]) {
				if (!it.is_object())
					continue;
				if (EnqueueBodyLocked(it.value("formId", std::string()),
						it.value("plugin", std::string()),
						it.value("name", std::string()),
						it.value("nif", std::string())))
					++queued;
			}
			promoted = g_promotedThisAsk;
			FrontLoadUserBatch(before);   // the Mounts tab / Finder rows on screen now
			if (queued || promoted) {
				LogUserAskDepth("body", queued, promoted);
				Pump();
			}
		}
		BacklogSaveIfDirty();
		if (!queued && !promoted)
			return 0;
		if (queued)
			logger::info("item icons: {} mount body render(s) queued", queued);
		StartWatcher();
		return queued;
	}

	/* Replay the persisted unfinished-render backlog (icon-backlog.json) through
	 * the same enqueue doors it was written by — at IDLE priority, so resumed
	 * background work can never delay a page the player opens. Entries already
	 * on disk or provably dead are pruned by the enqueues themselves; entries
	 * the idle ceiling refuses stay in the file untouched and resume on a later
	 * boot. Called once from Init (kDataLoaded: forms and the resource stack are
	 * both up, and the pacing gate keeps any actual render out of the load). */
	void ResumeBacklog()
	{
		nlohmann::json j;
		{
			std::ifstream in(BacklogFile(), std::ios::binary);
			if (!in.is_open())
				return;
			j = nlohmann::json::parse(in, nullptr, false);
		}
		if (j.is_discarded() || !j.is_object() || !j.contains("pending") || !j["pending"].is_object())
			return;
		std::size_t resumed = 0, kept = 0;
		{
			std::lock_guard l(g_mutex);
			// Seed the in-memory backlog with EVERYTHING first: an entry the idle
			// ceiling refuses below must survive into the next save untouched.
			for (auto it = j["pending"].begin(); it != j["pending"].end(); ++it)
				if (it.value().is_object() && g_backlog.size() < kMaxBacklog)
					g_backlog[it.key()] = it.value();
			for (const auto& [key, e] : j["pending"].items()) {
				if (!e.is_object())
					continue;
				const auto fid    = e.value("formId", std::string());
				const auto plugin = e.value("plugin", std::string());
				const auto name   = e.value("name", std::string());
				const auto kind   = e.value("kind", std::string("item"));
				bool queued = false;
				if (kind == "face")
					queued = EnqueueFaceLocked(fid, plugin, name, Tier::Idle);
				else if (kind == "body")
					queued = EnqueueBodyLocked(fid, plugin, name, e.value("nif", std::string()), Tier::Idle);
				else
					queued = EnqueueLocked(fid, plugin, name, Tier::Idle);
				if (queued)
					++resumed;
			}
			kept = g_backlog.size();
			g_backlogDirty = true;   // persist whatever the enqueues just pruned
		}
		BacklogSaveIfDirty();
		if (!resumed)
			return;
		// Build marker (hd-markers.json: "render-backlog-resume").
		logger::info("item icons: {} unfinished render(s) remembered from last session — resumed at idle priority ({} still backlogged)",
			resumed, kept);
		{
			std::lock_guard l(g_mutex);
			Pump();
		}
		StartWatcher();
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
			if (Listed(g_listBodies, BodyDir(), file))
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
		if (!FileExists(BodyDir() / file))
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
				const auto out = PathU8((BodyDir() / AngleFile(baseFile, angle)));
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
			if (Listed(g_listFaces, FaceDir(), file))
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
		if (!FileExists(FaceDir() / file))
			return {};
		return "icons/npcs/" + file;
	}

	void CaptureFaceAngles(const std::string& fid, const std::string& plugin)
	{
		if (!Ready() || fid.empty() || plugin.empty())
			return;
		// The same facegen NIF derivation EnqueueFaceLocked uses — the angles
		// MUST spin the exact mesh set frame 0 rendered (head + composed wig),
		// or the turn would swap one face for another mid-drag.
		const auto rel = FaceGenResolver::Resolve(fid, plugin);
		if (rel.empty())
			return;   // templated NPC — no facegen file, no turntable
		const auto  baseFile = FileFor(fid, plugin, false);
		const auto  wigs     = g_createBySet ? HairNifsForFace(fid, plugin) : std::vector<std::string>{};
		std::size_t queued   = 0;
		{
			std::lock_guard l(g_mutex);
			for (std::uint32_t f = 1; f < kSpinFrames; ++f) {
				const std::uint32_t angle = f * kSpinStep;
				// Distinct asked-key namespace ("<key>@f090"): never re-derived
				// per open, never seen by any index ('@' skip).
				char akeybuf[8]{};
				std::snprintf(akeybuf, sizeof(akeybuf), "@f%03u", static_cast<unsigned>(angle));
				const std::string akey = KeyOf(fid, plugin) + akeybuf;
				if (g_asked.count(akey))
					continue;
				const auto out = PathU8((FaceDir() / AngleFile(baseFile, angle)));
				if (FileExists(out)) {   // baked already — keep forever
					g_asked.insert(akey);
					continue;
				}
				if (g_queue.size() >= kMaxQueued)
					break;
				Request r;
				r.outPath   = out;
				r.key       = akey;
				r.nifPath   = rel;
				r.label     = fid + "|" + plugin + " face @" + std::to_string(angle) + "deg";
				r.angle     = angle;
				r.px        = kFaceSize;   // matches frame 0 — a lightbox zooms this canvas
				r.extraNifs = wigs;
				g_queue.push_back(std::move(r));
				g_asked.insert(akey);
				++queued;
			}
			if (queued)
				Pump();
		}
		if (queued) {
			// Build marker (hd-markers.json: "face-turntable").
			logger::info("item icons: {} face turntable frame(s) queued for {}|{}", queued, fid, plugin);
			StartWatcher();
		}
	}

	std::string SpinStateJson(const std::string& fid, const std::string& plugin,
		const std::string& kind)
	{
		std::lock_guard l(g_mutex);
		nlohmann::json        frames = nlohmann::json::object();
		std::filesystem::path dir;
		std::string           dirRel;
		std::uint32_t         step = kSpinStep;
		std::string           baseFile;
		if (kind == "face") {
			dir = FaceDir();
			dirRel = "icons/npcs/";
			baseFile = FileFor(fid, plugin, false);
		} else if (kind == "body") {
			dir = BodyDir();
			dirRel = "icons/mounts/";
			baseFile = FileFor(fid, plugin, false);
			step = kBodySpinStep;
		} else {
			dir = IconDir();
			dirRel = "icons/items/";
			// The angles live beside whichever base CaptureAngles chose — the
			// "-s2" name whenever a swap-rendered frame 0 (or any of its angle
			// frames) exists, the plain name otherwise. Check the swapped base
			// first so the reply can never point a spin at mixed textures.
			const auto s2 = ItemFileFor(fid, plugin, true);
			bool useS2 = FileExists(dir / s2);
			if (!useS2)
				for (std::uint32_t a = step; !useS2 && a < 360u; a += step)
					useS2 = FileExists(dir / AngleFile(s2, a));
			baseFile = useS2 ? s2 : ItemFileFor(fid, plugin, false);
		}
		if (!fid.empty() && !plugin.empty()) {
			if (FileExists(dir / baseFile))
				frames["0"] = dirRel + baseFile;
			for (std::uint32_t a = step; a < 360u; a += step) {
				const auto f = AngleFile(baseFile, a);
				if (FileExists(dir / f))
					frames[std::to_string(a)] = dirRel + f;
			}
		}
		return nlohmann::json{ { "kind", kind }, { "formId", fid }, { "plugin", plugin },
			{ "step", step }, { "count", 360u / step }, { "frames", std::move(frames) } }
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
		std::size_t queued   = 0;
		{
			std::lock_guard l(g_mutex);
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
				if (FileExists(IconDir() / ItemFileFor(fid, plugin, true)))
					return;
				swapped = false;
			}
			const auto  baseFile = ItemFileFor(fid, plugin, swapped);

			for (std::uint32_t f = 1; f < kSpinFrames; ++f) {
				const std::uint32_t angle = f * kSpinStep;
				// A DISTINCT asked-key namespace ("<key>@045") so a frame that
				// is queued/rendered is not re-derived every open, and so the
				// frame-0 index in IndexJson never sees these (it skips '@').
				const std::string akey = KeyOf(fid, plugin) + "@" + std::to_string(angle);
				if (g_asked.count(akey))
					continue;
				const auto out = PathU8((IconDir() / AngleFile(baseFile, angle)));
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
				// Frame 0 of an ITEM render box-fits (FitClutter) — the angles
				// must too, or the piece visibly SHRINKS the moment a drag
				// leaves frame 0 (2026-08-19 verification-swarm find; the old
				// "must match frame 0" comment said the right thing and did
				// the opposite).
				r.refit   = true;
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
			const auto swapped = ItemFileFor(key.substr(0, bar), key.substr(bar + 1), true);
			const auto plain   = ItemFileFor(key.substr(0, bar), key.substr(bar + 1), false);
			if (Listed(g_listItems, IconDir(), swapped))
				return "icons/items/" + swapped;
			if (Listed(g_listItems, IconDir(), plain))
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
		// Dead ends ride along, keyed the same way, so a tile can say WHY it has
		// no picture instead of sitting on a placeholder forever. A key that has
		// since rendered is never in here (the landing clears it), and one that
		// somehow has both is treated as rendered — `icons` wins in the view.
		nlohmann::json failed = nlohmann::json::object();
		for (const auto& [key, why] : g_failedWhy)
			if (!icons.contains(key))
				failed[key] = why;
		return nlohmann::json{ { "version", 1 }, { "icons", std::move(icons) },
			{ "failed", std::move(failed) }, { "revisions", g_itemRevisions } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void RetryIcons(const std::string& listJson)
	{
		auto j = nlohmann::json::parse(listJson, nullptr, false);
		if (j.is_discarded() || !j.is_object() || !j.contains("items") || !j["items"].is_array())
			return;
		const bool force = j.value("force", false);
		{
			std::lock_guard l(g_mutex);
			std::size_t n = 0;
			for (const auto& it : j["items"]) {
				if (!it.is_object()) continue;
				const std::string fid = it.value("formId", std::string());
				const std::string plugin = it.value("plugin", std::string());
				if (fid.empty() || plugin.empty()) continue;
				const auto key = KeyOf(fid, plugin);
				if (force) {
					// Fresh filename: displayed PNGs are memory-mapped by Ultralight.
					// Keep that file intact; the new index replaces it only when ready.
					auto& revision = g_itemRevisions[key];
					const auto now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
						std::chrono::system_clock::now().time_since_epoch()).count());
					revision = std::max(revision + 1, now);
					auto belongs = [&](const auto& k) { return k == key || k.rfind(key + "@", 0) == 0; };
					for (auto* queue : { &g_queue, &g_bulkQueue, &g_idleQueue })
						queue->erase(std::remove_if(queue->begin(), queue->end(),
							[&](const Request& r) { return belongs(r.key); }), queue->end());
					for (auto asked = g_asked.begin(); asked != g_asked.end(); )
						if (belongs(*asked)) asked = g_asked.erase(asked); else ++asked;
					for (auto failed = g_failedWhy.begin(); failed != g_failedWhy.end(); )
						if (belongs(failed->first)) failed = g_failedWhy.erase(failed); else ++failed;
					g_diskIndex.erase(key);
					logger::info("item icons: re-render forced for {} (fresh revision {})", key, revision);
					logger::info("item-icons-rerender-fresh: {}", ItemFileFor(fid, plugin));
				}
				g_asked.erase(key);
				ClearFailed(key);
				++n;
			}
			if (n) logger::info("item icons: retry requested for {} item(s)", n);
		}
		// Persist before queueing, outside g_mutex (IndexJson takes it).
		WriteIndexFile();
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
		const auto swapped = ItemFileFor(fid, plugin, true);
		const auto plain   = ItemFileFor(fid, plugin, false);
		if (FileExists(IconDir() / swapped))
			return "icons/items/" + swapped;
		if (FileExists(IconDir() / plain))
			return "icons/items/" + plain;
		return {};
	}

	void SetOnBatchDone(std::function<void()> cb)
	{
		g_onBatchDone = std::move(cb);
	}

	void SetPaletteOpenProbe(std::function<bool()> probe)
	{
		std::lock_guard l(g_mutex);
		g_paletteProbe = std::move(probe);
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
					if (face ? Listed(g_listFaces, FaceDir(), file) : Listed(g_listBodies, BodyDir(), file))
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

	/* ── THE MIRROR (2026-10-03) — a full-body figure of a LIVE actor ──────────
	 * Rober saw SeverActions' live mannequin and asked for it in SkyManager. The
	 * pieces were already here: MRF composes several NIFs into one mesh (the face
	 * lane's wig composition), takes skin texture sets, and the turntable spins a
	 * mesh about Z. So a figure is a COMPOSED render of exactly what the actor is
	 * wearing right now — every worn ARMO's addon for her race, the skin parts
	 * the gear leaves bare, her baked FaceGen head (the proven face route, not
	 * raw head parts) and, when no hair-slot gear is worn, her hair — baked at
	 * kMirrorStep angles into icons/bodies/<slug>-<hex>-<sig>[-aNNN].png.
	 *
	 * <sig> hashes the whole composition, so a change of clothes is a new set of
	 * files (Ultralight maps every PNG it has drawn, so a shown file can never be
	 * overwritten — new names are the only way to replace a picture). Older sigs
	 * of the same actor are deleted best-effort; a still-mapped one is simply
	 * left for the generation purge.
	 *
	 * Honest limits, said in the reply rather than hidden: NIFs come off disk, so
	 * runtime body morphs (OBody / RaceMenu sliders) do not apply — the figure has
	 * the BodySlide-built shape; RaceMenu overlays are not composited; the pose is
	 * the meshes' bind pose. */
	namespace
	{
		std::filesystem::path MirrorDir()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "bodies";
		}

		struct WholeSet
		{
			std::vector<std::string> nifs;   // [0] is the base, the rest attach
			std::vector<WholeTex>    tex;
			float                    tint[3]{ 1.0f, 1.0f, 1.0f };
			bool                     useTint{ false };
			std::string              fid;    // durable identity: the BASE npc, "0x<local>"
			std::string              plugin;
			std::size_t              pieces{ 0 };   // distinct worn armour forms
			std::string              head;   // "facegen" | "headparts" | ""
		};

		void AddUniqueNif(std::vector<std::string>& v, const char* path)
		{
			if (!path || !*path)
				return;
			std::string p{ path };
			if (std::find(v.begin(), v.end(), p) == v.end())
				v.push_back(std::move(p));
		}

		void AddTex(std::vector<WholeTex>& out, const char* nif, RE::BGSTextureSet* set, bool includeBodyShape)
		{
			if (!nif || !*nif || !set)
				return;
			WholeTex t;
			t.nifPath           = nif;
			t.modelSpaceNormals = set->flags.any(RE::BGSTextureSet::Flag::kHasModelSpaceNormalMap);
			t.includeBodyShape  = includeBodyShape;
			const auto n = static_cast<std::size_t>(RE::BSTextureSet::Textures::kUsedTotal);
			t.paths.resize(n);
			for (std::size_t i = 0; i < n; ++i)
				if (const char* tp = set->GetTexturePath(static_cast<RE::BSTextureSet::Texture>(i)))
					t.paths[i] = tp;
			out.push_back(std::move(t));
		}

		// Upstream's GetNpcSkinTextureSet: the skin texture set an exposed piece
		// of this slot wears (the NPC's own skin first, then the race's).
		RE::BGSTextureSet* SkinTexFor(RE::TESNPC* npc, RE::TESRace* race, RE::SEX sex, std::uint32_t slots)
		{
			auto fromArmor = [&](RE::TESObjectARMO* skin) -> RE::BGSTextureSet* {
				if (!skin)
					return nullptr;
				for (auto* arma : skin->armorAddons) {
					if (!arma || !arma->IsValidRace(race))
						continue;
					const auto a = static_cast<std::uint32_t>(*arma->bipedModelData.bipedObjectSlots);
					if ((a & slots) != 0 && arma->skinTextures[sex])
						return arma->skinTextures[sex];
				}
				return nullptr;
			};
			RE::BGSTextureSet* t = npc ? fromArmor(npc->skin) : nullptr;
			if (!t && race)
				t = fromArmor(race->skin);
			if (!t && npc)
				t = fromArmor(npc->farSkin);
			return t;
		}

		std::uint32_t SkinCoverage(std::uint32_t addonSlots)
		{
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			for (auto s : { Slot::kBody, Slot::kHands, Slot::kFeet, Slot::kTail }) {
				const auto m = static_cast<std::uint32_t>(s);
				if ((addonSlots & m) != 0)
					return m;
			}
			return addonSlots;
		}

		// Upstream's AppendArmorModelPaths, ported: the addons of `armor` valid for
		// the race, minus slots already covered. Returns the slots it added.
		std::uint32_t AddArmor(WholeSet& w, RE::TESObjectARMO* armor, RE::TESRace* race, RE::SEX sex,
			std::uint32_t excluded, bool excludeOnAnyOverlap, bool isSkin, RE::TESNPC* skinNpc)
		{
			if (!armor || !race)
				return 0;
			std::uint32_t added = 0;
			for (auto* arma : armor->armorAddons) {
				if (!arma || !arma->IsValidRace(race))
					continue;
				const auto slots    = static_cast<std::uint32_t>(*arma->bipedModelData.bipedObjectSlots);
				const auto coverage = isSkin ? SkinCoverage(slots) : slots;
				const auto overlap  = coverage & excluded;
				if ((excludeOnAnyOverlap && overlap != 0) || (!excludeOnAnyOverlap && (coverage & ~excluded) == 0))
					continue;
				const char* model = arma->bipedModels[sex].GetModel();
				if (!model || !*model)
					continue;
				RE::BSResourceNiBinaryStream probe((std::string("meshes\\") + model).c_str());
				if (!probe.good())
					continue;   // a missing NIF must not cost the whole figure
				AddUniqueNif(w.nifs, model);
				RE::BGSTextureSet* tex = arma->skinTextures[sex];
				if (skinNpc)
					if (auto* own = SkinTexFor(skinNpc, race, sex, slots))
						tex = own;   // exposed skin inside an outfit wears HER skin
				AddTex(w.tex, model, tex, isSkin);
				added |= slots;
			}
			return added;
		}

		// MAIN THREAD ONLY (worn-armour reads, form lookups, BSResource probes).
		bool BuildWhole(RE::Actor* actor, WholeSet& w, std::string& why)
		{
			auto* npc  = actor ? actor->GetActorBase() : nullptr;
			auto* race = actor ? actor->GetRace() : nullptr;
			if (!npc || !race) {
				why = "not an actor with a race";
				return false;
			}
			auto* file = npc->GetFile(0);
			if (!file) {
				why = "a dynamic actor with no plugin of her own";
				return false;
			}
			{
				const std::uint32_t local = npc->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				char hex[16];
				std::snprintf(hex, sizeof(hex), "0x%x", local);
				w.fid    = hex;
				w.plugin = std::string(file->GetFilename());
			}
			const auto sex = npc->GetSex();

			// 1. Everything she is WEARING, one entry per distinct ARMO.
			std::vector<RE::TESObjectARMO*> worn;
			std::uint32_t                    outfitSlots = 0;
			for (std::uint32_t i = 0; i < 32; ++i) {
				const auto slot = static_cast<RE::BGSBipedObjectForm::BipedObjectSlot>(std::uint32_t{ 1 } << i);
				auto*      armo = actor->GetWornArmor(slot);
				if (!armo || std::find(worn.begin(), worn.end(), armo) != worn.end())
					continue;
				worn.push_back(armo);
				outfitSlots |= AddArmor(w, armo, race, sex, 0, false, false, npc);
			}
			w.pieces = worn.size();

			// 2. Skin for whatever the gear leaves bare (her own skin, then the race's).
			std::uint32_t covered = outfitSlots;
			covered |= AddArmor(w, npc->skin, race, sex, covered, true, true, nullptr);
			covered |= AddArmor(w, race->skin, race, sex, covered, true, true, nullptr);
			covered |= AddArmor(w, npc->farSkin, race, sex, covered, true, true, nullptr);

			// 3. The head: the baked FaceGen NIF of her face owner (the route every
			// deck portrait already proves), hair added only when no worn piece
			// claims the hair slots (a worn wig or helmet already IS her head).
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			const std::uint32_t hairMask = static_cast<std::uint32_t>(Slot::kHair) |
			                               static_cast<std::uint32_t>(Slot::kLongHair);
			if (auto* owner = NpcFinder::FaceOwnerOf(npc); owner && owner->GetFile(0)) {
				auto*               of    = owner->GetFile(0);
				const std::uint32_t local = owner->GetFormID() & (of->IsLight() ? 0xFFFu : 0xFFFFFFu);
				char                hex[16];
				std::snprintf(hex, sizeof(hex), "0x%x", local);
				const std::string oplugin{ of->GetFilename() };
				if (const auto rel = FaceGenResolver::Resolve(hex, oplugin); !rel.empty()) {
					AddUniqueNif(w.nifs, rel.c_str());
					w.head = "facegen";
					if ((outfitSlots & hairMask) == 0)
						for (const auto& h : HairNifsForFace(hex, oplugin))
							AddUniqueNif(w.nifs, h.c_str());
				}
			}
			if (w.head.empty() && npc->headParts) {
				for (std::int8_t i = 0; i < npc->numHeadParts; ++i)
					if (auto* hp = npc->headParts[i])
						AddUniqueNif(w.nifs, hp->GetModel());
				if (npc->numHeadParts > 0)
					w.head = "headparts";
			}

			// 4. Body tint (upstream: fall back to the face root when unset).
			RE::TESNPC* tintNpc = npc;
			if (!tintNpc->bodyTintColor.red && !tintNpc->bodyTintColor.green && !tintNpc->bodyTintColor.blue)
				if (auto* root = npc->GetRootFaceNPC())
					tintNpc = root;
			const auto& bt = tintNpc->bodyTintColor;
			if (bt.red || bt.green || bt.blue) {
				w.tint[0] = bt.red / 255.0f;
				w.tint[1] = bt.green / 255.0f;
				w.tint[2] = bt.blue / 255.0f;
				w.useTint = true;
			}

			if (w.nifs.size() < 2) {
				why = w.nifs.empty() ? "no body, gear or head mesh found for her race"
				                     : "only one mesh found - nothing to compose a figure from";
				return false;
			}
			return true;
		}

		std::string SigOf(const WholeSet& w)
		{
			std::uint32_t h = 2166136261u;
			auto mix = [&](const std::string& s) {
				for (const unsigned char c : s) {
					h ^= c;
					h *= 16777619u;
				}
				h ^= 0x1Fu;
				h *= 16777619u;
			};
			mix(std::to_string(kMirrorEpoch) + "/" + std::to_string(kMirrorSize));
			for (const auto& n : w.nifs)
				mix(n);
			for (const auto& t : w.tex) {
				mix(t.nifPath);
				for (const auto& p : t.paths)
					mix(p);
			}
			if (w.useTint)
				mix(std::to_string(w.tint[0]) + "," + std::to_string(w.tint[1]) + "," + std::to_string(w.tint[2]));
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08x", h);
			return buf;
		}

		// Mirror frame order: front, back, the two profiles, then fill in — so a
		// drag that starts while the set is still baking already turns.
		std::vector<std::uint32_t> MirrorOrder()
		{
			std::vector<std::uint32_t> out{ 0, 180, 90, 270 };
			for (std::uint32_t a = 0; a < 360; a += kMirrorStep)
				if (std::find(out.begin(), out.end(), a) == out.end())
					out.push_back(a);
			return out;
		}
	}

	std::string MirrorJson(RE::Actor* actor, bool queue)
	{
		nlohmann::json out = { { "ok", false }, { "step", kMirrorStep }, { "size", kMirrorSize } };
		if (!actor) {
			out["why"] = "not loaded right now - open her page while she is nearby";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		out["name"] = actor->GetName() ? actor->GetName() : "";
		if (!Ready() || !g_createBySet) {
			out["why"] = "Mesh Rendering Framework is not installed (or too old to compose a figure)";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		WholeSet    w;
		std::string why;
		if (!BuildWhole(actor, w, why)) {
			out["why"] = why;
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const std::string sig  = SigOf(w);
		std::string       stem = FileFor(w.fid, w.plugin, false);
		stem                   = stem.substr(0, stem.size() - 4) + "-" + sig;
		const std::string file = stem + ".png";
		const auto        dir  = MirrorDir();

		nlohmann::json frames = nlohmann::json::object();
		std::size_t    queued = 0;
		std::string    failed;
		{
			std::lock_guard l(g_mutex);
			const std::size_t before = g_queue.size();
			for (const auto a : MirrorOrder()) {
				const auto name = AngleFile(file, a);
				if (FileExists(dir / name)) {
					frames[std::to_string(a)] = "icons/bodies/" + name;
					continue;
				}
				char ak[8];
				std::snprintf(ak, sizeof(ak), "a%03u", a);
				const auto key = KeyOf(w.fid, w.plugin) + "@w" + sig + ak;
				if (auto f = g_failedWhy.find(key); f != g_failedWhy.end()) {
					if (a == 0)
						failed = f->second;
					continue;
				}
				if (!queue || g_asked.count(key) || g_queue.size() >= kMaxQueued)
					continue;
				Request r;
				r.outPath   = PathU8(dir / name);
				r.key       = key;
				r.nifPath   = w.nifs.front();
				r.extraNifs.assign(w.nifs.begin() + 1, w.nifs.end());
				r.label     = std::string(actor->GetName() ? actor->GetName() : "figure") + " (mirror " + std::to_string(a) + ")";
				r.px        = kMirrorSize;
				r.angle     = a;
				r.whole     = true;
				r.tex       = w.tex;
				r.useTint   = w.useTint;
				std::copy(std::begin(w.tint), std::end(w.tint), std::begin(r.tint));
				r.tier      = Tier::User;
				g_queue.push_back(std::move(r));
				g_asked.insert(key);
				++queued;
			}
			if (queued) {
				FrontLoadUserBatch(before);
				LogUserAskDepth("mirror", queued, 0);
				Pump();
			}
		}
		if (queued) {
			std::error_code ec;
			std::filesystem::create_directories(dir, ec);
			// A change of clothes made every older figure of hers stale. Best
			// effort: a file the view still has mapped refuses, and is left.
			const std::string prefix = stem.substr(0, stem.size() - sig.size());
			std::size_t       gone   = 0;
			for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
				const auto n = PathU8(it->path().filename());
				if (n.rfind(prefix, 0) == 0 && n.rfind(stem, 0) != 0) {
					std::error_code del;
					if (std::filesystem::remove(it->path(), del) && !del)
						++gone;
				}
			}
			logger::info("mirror: '{}' - {} frame(s) queued at {}px (sig {}, {} nif(s), {} worn piece(s), head {}, {} stale removed)",
				actor->GetName() ? actor->GetName() : "", queued, kMirrorSize, sig, w.nifs.size(), w.pieces,
				w.head.empty() ? "none" : w.head, gone);   // marker: mirror-queue
			StartWatcher();
		}
		out["ok"]     = true;
		out["sig"]    = sig;
		out["frames"] = std::move(frames);
		out["total"]  = 360 / kMirrorStep;
		out["queued"] = queued;
		out["pieces"] = w.pieces;
		out["head"]   = w.head;
		out["meshes"] = w.nifs.size();
		if (!failed.empty())
			out["failed"] = failed;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	/* ── THE ITEM INSPECTOR ─────────────────────────────────────────────────
	 * One piece as a 24-frame turntable, the Mirror's lane for an item. Every
	 * frame — frame 0 included, at the big size — goes through the ordinary
	 * item route (LookOf's mesh + texture swaps, the swept-cylinder box fit that
	 * holds the scale still across angles), so the turn is one piece in a fixed
	 * frame, never a slideshow of differently framed pictures. Frames land in
	 * icons/inspect/<item file>[-aNNN].png, the item's own (revisioned) name,
	 * so a retried icon generation never mixes with an older set. Front, back
	 * and the two profiles bake first, so a drag works while the rest arrive.
	 * Re-asking is free: on-disk frames are listed, queued ones are not
	 * re-queued (g_asked), and a refused one is reported, never retried. */
	std::string InspectJson(const std::string& fid, const std::string& plugin, bool queue)
	{
		nlohmann::json out = { { "ok", false }, { "formId", fid }, { "plugin", plugin },
			{ "step", kInspectStep }, { "size", kInspectSize }, { "total", 360 / kInspectStep } };
		if (fid.empty() || plugin.empty()) {
			out["why"] = "this piece has no plugin identity to render";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		if (!Ready()) {
			out["why"] = "Mesh Rendering Framework is not installed";
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		nlohmann::json frames = nlohmann::json::object();
		std::size_t    queued = 0;
		std::size_t    refused = 0;
		std::string    failed;
		std::string    baseFile;
		{
			std::lock_guard l(g_mutex);
			auto look = LookOf(fid, plugin);
			if (look.nif.empty()) {
				out["why"] = look.missing.empty() ? std::string("this piece has no world model to turn")
				                                  : "its model is missing from the load order: " + look.missing;
				return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			// The swap route is all-or-nothing per SET: with swaps switched off
			// for this session every frame is the bare mesh, which is still one
			// consistent piece.
			const bool swapped = !look.swaps.empty() && !g_swapDisabled;
			baseFile           = ItemFileFor(fid, plugin, swapped);
			const auto dir     = InspectDir();
			const std::size_t before = g_queue.size();
			std::vector<std::uint32_t> order{ 0, 180, 90, 270 };
			for (std::uint32_t a = 0; a < 360; a += kInspectStep)
				if (std::find(order.begin(), order.end(), a) == order.end())
					order.push_back(a);
			for (const auto a : order) {
				const auto name = AngleFile(baseFile, a);
				if (FileExists(dir / name)) {
					frames[std::to_string(a)] = "icons/inspect/" + name;
					continue;
				}
				char ak[8];
				std::snprintf(ak, sizeof(ak), "i%03u", a);
				const std::string key = KeyOf(fid, plugin) + "@" + ak;
				if (auto f = g_failedWhy.find(key); f != g_failedWhy.end()) {
					++refused;
					if (failed.empty())
						failed = f->second;
					continue;
				}
				if (!queue || g_asked.count(key) || g_queue.size() >= kMaxQueued)
					continue;
				Request r;
				r.outPath = PathU8(dir / name);
				r.key     = key;
				r.nifPath = look.nif;
				r.swaps   = swapped ? look.swaps : std::vector<AltTex>{};
				r.label   = fid + "|" + plugin + " (inspect " + std::to_string(a) + ")";
				r.px      = kInspectSize;
				r.refit   = true;   // the same box fit as frame 0, so the piece holds still
				r.angle   = a;
				r.tier    = Tier::User;
				g_queue.push_back(std::move(r));
				g_asked.insert(key);
				++queued;
			}
			if (queued) {
				FrontLoadUserBatch(before);
				LogUserAskDepth("inspect", queued, 0);
				Pump();
			}
		}
		if (queued) {
			std::error_code ec;
			std::filesystem::create_directories(InspectDir(), ec);
			logger::info("item inspect: '{}|{}' - {} frame(s) queued at {}px ({} on disk, {} refused)",
				fid, plugin, queued, kInspectSize, frames.size(), refused);   // marker: item-inspect
			StartWatcher();
		}
		out["ok"]      = true;
		out["frames"]  = std::move(frames);
		out["queued"]  = queued;
		out["refused"] = refused;
		if (!failed.empty())
			out["failed"] = failed;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
