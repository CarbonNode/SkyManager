#pragma once

#include <cstdint>
#include <functional>

// CursorKeeper (2026-10-14, marker cursor-keeper) — the deck never loses its cursor.
//
// Rober: "sometimes when i type in search bars across skymanager my mouse stops
// moving, i have to close and open". PrismaUI's focus menu ("PrismaUI_FocusMenu")
// IS the cursor: it is the menu that carries kUsesCursor, so the engine moves
// MenuCursor only while it is open, and PrismaUI draws its cursor at that
// position. Keys reach the view through PrismaUI's window hook, not through that
// menu. So if anything closes the focus menu while the deck keeps PrismaUI focus,
// the cursor freezes, typing still works, and only a close + reopen (which opens
// the menu again) brings it back: exactly the report.
//
// Things that close it under a focused view: PrismaUI's Unfocus/Hide of a view
// whose Ultralight view still reports focus (it closes the menu without checking
// which view is current), and its "view not ready" branches. Which one happened
// to Rober is not known, so the keeper also logs the menus that opened and
// closed in the 3 s before.
//
// When the focus menu closes while one of our palettes is open and its view
// still has PrismaUI focus, the keeper shows the menu again at once. The 1 s
// watchdog tick does the same if the close event was missed. Never during a
// loading screen, never while an open/close of ours is in flight, and at most
// three times in five seconds, so it cannot fight another mod forever.
namespace CursorKeeper
{
	// kDataLoaded. Both callbacks run on the main thread.
	//   paletteOpen:  one of our palettes is open and not mid open/close.
	//   holdsKeyboard: one of our palette views has PrismaUI focus (may block
	//                  briefly; it is asked only after the focus menu has gone).
	void Install(std::function<bool()> paletteOpen, std::function<bool()> holdsKeyboard);

	// 1 s backstop from the desync watchdog. Main thread.
	void Tick();

	// 2026-10-15 (marker cursor-menu-keeper): the focus menu is not the cursor
	// after all — it only keeps the engine's own "Cursor Menu" open, and THAT
	// menu is what moves MenuCursor (PrismaUI draws its sprite at that position
	// and hands the view the same coordinates). The first keeper watched the
	// wrong menu, and the 2026-10-15 report arrived with no keeper line at all.
	// So the keeper now also watches the engine's Cursor Menu: a close event or
	// a 1 s check that finds it gone while our focus menu is open and we hold
	// the keyboard reopens it — only while the engine's own showCursorCount
	// says it should be visible (a bare show against a zero count would leave
	// the count negative and the NEXT game menu cursorless). Same burst limit.
	//   how: who asked ("close event", "1 s check", "mouse-watch").
	// Returns true when a show was queued. Main thread.
	bool EnsureCursorMenu(const char* how);

	// The menus that opened or closed in the last windowMs, for other modules' logs.
	std::string RecentMenus(std::int64_t windowMs = 3000);
}
