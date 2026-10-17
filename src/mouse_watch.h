#pragma once

#include <functional>
#include <string>

// MouseWatch (2026-10-15, marker mouse-watch) — says WHY the mouse stopped.
//
// Rober: "type in field box in skymanager, mouse stops reacting to movement
// till i hit escape or close and open menu". The Omni warm-burst pacing
// (2ef27e9) and the focus-menu keeper (cursor_keeper.cpp) were both live for
// the 2026-10-15 morning session and the report came back, with no
// cursor-keeper line in the log. So the next occurrence has to explain
// itself.
//
// PrismaUI's wiring (read from its vendored source, 2026-10-15): keys reach
// the view through a WndProc subclass; mouse moves reach it through the game's
// input sink, carrying the position of the game's own MenuCursor, which the
// engine's "Cursor Menu" updates; the cursor sprite is drawn at that same
// position. So "typing works, the mouse does not" means one of two things:
//   A. MenuCursor stopped moving (the engine's Cursor Menu is gone, or
//      something upstream swallowed the move) — the sprite freezes;
//   B. MenuCursor moves but the view is starved of mouse events (an input
//      sink registered before PrismaUI's returned kStop) — the sprite moves,
//      nothing under it reacts.
//
// The watch compares, once a second while the deck is open and focused:
//   * raw mouse-move events seen by OUR input sink (every batch, before the
//     button early-out — the engine dispatches them to every sink);
//   * the MenuCursor position;
//   * the last time the VIEW itself saw a mousemove (hdMouseBeat, one call
//     per 1.5 s while the pointer moves).
// Raw motion with a still cursor for two ticks = A: one log line with the
// whole engine state (open menus, cursor counts, text-entry count, control
// flags, remap mode, pause, gamepad, the deck's capture state, the menus that
// moved in the last 3 s), then the Cursor Menu is reopened if it is the thing
// that went missing (CursorKeeper::EnsureCursorMenu). Raw motion, cursor
// moving, no view beat for 3 s = B, logged the same way. When the cursor moves
// again the watch logs how long it was still and which key came just before.
//
// SkyManager.ini `MouseWatchRefocus=1` adds one more remedy for A: after four
// still seconds, drop and retake PrismaUI focus (what close + reopen does).
// Off by default: it is a visible flicker, and the log line is the point.
namespace MouseWatch
{
	struct Hooks
	{
		std::function<bool()>        paletteOpen;      // a palette is open and not mid open/close
		std::function<bool()>        mainDeckFocused;  // the main deck view holds PrismaUI focus (cached)
		std::function<bool()>        anyDeckFocused;   // either palette view holds it (cached)
		std::function<std::string()> recentMenus;      // CursorKeeper::RecentMenus
		std::function<std::string()> deckState;        // capture / text-entry raises, for the dump
		std::function<void()>        refocus;          // optional: drop + retake focus
	};

	void Install(Hooks hooks);

	// Game thread, every input batch, before any early-out. Counts raw mouse
	// moves and remembers the last keyboard press.
	void NoteInputBatch(RE::InputEvent* const* a_events);

	// hdMouseBeat from the view (Ultralight thread). An atomic store.
	void NoteViewMouse();

	// 1 s tick from the desync watchdog. Main thread.
	void Tick();
}
