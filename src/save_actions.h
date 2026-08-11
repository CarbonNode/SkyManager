#pragma once

#include <string>

// A FULL save from the deck — the thing the pause menu's "Save" does, not a
// quicksave. Exists so the Mod Arch save key can go away: bind a deck entry to
// whatever key you like and it makes a real, numbered-in-time save file rather
// than overwriting one slot.
//
// ------------------------------------------------------------------ how ----
// One call: `BGSSaveLoadManager::GetSingleton()->Save(name)`. That is the same
// path the console's `save <name>` command ends in, and calling it directly
// rather than through RE::Script::CompileAndRun is deliberate:
//
//   * The console takes ONE parsed token. A save named for where you are
//     standing routinely contains spaces and apostrophes — "Warmaiden's",
//     "Jorrvaskr Living Quarters" — and a parsed command either truncates at
//     the first space or breaks on the quote. The direct call takes the string
//     verbatim.
//   * It is one function instead of a parser, so there is nothing to escape and
//     nothing to get wrong at runtime.
//
// It is a genuine manual save (SaveType kSave), so it appears in the Load menu
// beside the rest and does not clobber the quicksave slot.
//
// ------------------------------------------------------- the frame delay ----
// THE non-obvious part, and the reason this owns its own timing instead of
// riding the ordinary action path: Skyrim grabs the save's THUMBNAIL from the
// frame it saves on. Fire the save on the same frame the palette closes and the
// screenshot is a picture of the Hotkey Deck. So the deck hides, a few frames
// are allowed to render the world again, and only then does the save go in —
// exactly the reasoning PortraitCapture uses, for exactly the same reason.
//
// For the same reason the caller must NOT reopen the palette afterwards: the
// deck painting itself back over the world is the thing the delay exists to
// avoid, and a reopen would race it.
//
// MAIN THREAD ONLY for the save itself — Fire() schedules that for you.
namespace SaveActions
{
	// True if `action` is one this module owns. Currently just "full-save".
	bool IsAction(const std::string& action);

	// Hide-then-save. Returns immediately; the save lands a few frames later.
	// Safe to call with no game loaded — it says so rather than doing nothing.
	void Fire();

	// The name the next save would get, for tests and for logging:
	//   "Save 2026-07-31 22.41.05 - the player - Whiterun"
	// Sortable by name as well as by date, says who and where, and cannot
	// collide with an existing file (the seconds field is the tiebreak).
	// Illegal filename characters are stripped, never substituted, so the
	// result is always something Windows will actually accept.
	std::string BuildSaveName();
}
