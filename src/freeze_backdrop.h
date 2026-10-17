#pragma once

#include <cstdint>
#include <string>

// FreezeBackdrop (2026-10-09, marker freeze-backdrop) — stop the game redrawing the
// world behind a PAUSED deck, the way the vanilla inventory does.
//
// Why: with the classic menu pause the world is still rendered every frame under the
// deck's 60% dim. On this rig that measured 60 ms per frame (frame-diag(view), 17 fps)
// while the deck's own work was 0-4 ms, and the cursor moves once per frame, so it
// floats. The inventory feels smooth because its menu carries kFreezeFrameBackground:
// the engine keeps one captured frame and stops drawing the world behind it.
//
// How: one invisible engine menu ("SkyManager Backdrop") with no movie of its own
// (the DetailedMiniMap LocalMenu shape: kCustomRendering, no-op AdvanceMovie /
// PostDisplay), carrying kFreezeFrameBackground and nothing that takes input, the
// cursor or a pause. It is opened while one of our views holds a CLASSIC (menu)
// pause and closed before that focus is released. PrismaUI's focus menu, which
// draws the cursor, is also given kSkipRenderDuringFreezeFrameScreenshot while we
// hold it, so the cursor is never baked into the captured frame (Magelight UI does
// the same for its overlay, PR #5).
//
// Never while the world must stay live: a live (unpaused) deck, smooth pause, and
// the person page's live view all release it.
//
// ⛔ DISABLED (2026-10-09 17:50): the first in-game open with this on HUNG THE
// MAIN THREAD — no first paint, no 1 s tick, a queued live-api close-view task
// never ran, SkyrimSE had to be killed. Off by default and out of Settings; only
// SkyManager.ini FreezeBackdrop=1 turns it on, and only with a dump ready.
//
// 2026-10-14, backdrop-inventory-recipe: that menu carried kFreezeFrameBackground
// + kCustomRendering. The vanilla inventory on this rig carries kCustomRendering +
// kPausesGame and NO freeze-frame (flags 0x0000A4C5), and ran at 66 fps real on
// 7 ms of game thread. The backdrop now copies that pair, and SkyManager.ini's
// FreezeBackdrop / BackdropFlags / BackdropMovie are read live, so it can be
// tried and varied while the game runs. Still off by default.
namespace FreezeBackdrop
{
	enum Owner : std::uint32_t
	{
		kDeck  = 1u << 0,
		kMagic = 1u << 1,
	};

	// kDataLoaded: register the menu and the open/close sink. Idempotent.
	void Install();

	// The user setting. Turning it off releases at once.
	void SetEnabled(bool on);
	bool Enabled();

	// An owner's paused focus is up (want=true) or is about to go (want=false).
	// Call want=false BEFORE Unfocus. Main thread.
	void Want(Owner who, bool want);
	void ReleaseAll(const char* why);

	// The 1 s reconcile: hides a backdrop nobody wants, shows one that is wanted
	// but missing (a menu that refused to open the first time). Main thread.
	void Tick(bool anyPaletteOpen);

	// PrismaUI's focus menu name as learned from the menu stack ("" until a
	// PrismaUI menu has opened this session). Main thread.
	std::string PrismaFocusMenu();
}
