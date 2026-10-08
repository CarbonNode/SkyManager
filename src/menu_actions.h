#pragma once

#include <string>

// Open another mod's settings menu from the deck — a click, or a bound trigger
// key — WITHOUT dedicating a keyboard hotkey to each mod.
//
// None of the three targets exposes a clean programmatic "open" call:
//   * Prisma MCM Redux  — opened by its own PrismaInputHandler catching a DIK
//                          scancode (PrismaCore.ini [Core] Hotkey, default 43 = '\').
//   * SKSE Menu Framework — opened by its own input hook on a named key
//                          (SKSEMenuFramework.ini ToggleKey/ToggleMode, default
//                          F1 / DoublePress). Its DLL license forbids
//                          reverse-engineering, so we do NOT poke its internals.
//   * Community Shaders   — opened by its own toggle key (default End).
//
// So the legitimate, drift-proof wire is to synthesize EXACTLY the input each mod
// is configured to listen for — read live from that mod's own config so a rebind
// there stays honored — via the same OS-level SendInput the deck already uses for
// keystroke entries. The deck presses the key; Rober presses nothing but the
// palette button. Each opener runs on a detached worker thread after the palette
// has closed (the menu owns the screen; there is no reopen).
//
// NPA - NPC Preset Applier (Nexus 193575, 2026-10-04) joined the list. It is
// closed source and its licence forbids redistribution, so the deck can only
// open it, never ship it. It registers a standalone SKSE Menu Framework WINDOW
// (AddWindow, no AddSectionItem), so the Omni's "Mod menus" walk cannot list
// it; its own open key (NPA.ini [UI] Hotkey, default Shift+N) is the door it
// ships for exactly this, and it preselects the NPC under the crosshair.
//
// The Manipulator 9001 (Nexus 194259, 2026-10-08): an in-game Creation-Kit
// style placer (move / rotate / scale any object, per-cell JSON saves,
// which mod supplies a mesh). GPL source. Its edit mode is toggled by ONE
// key, Home, which in v.2 is a constexpr in its Settings.h (the author says a
// JSON settings file comes later): there is no config to read yet, so the
// opener presses Home and says so in the log. Its Menu Framework page
// (Object Manipulator > Main) is an ordinary section item the Omni's "Mod
// menus" walk already lists; this row is the edit mode itself, which only
// that key reaches.

namespace MenuActions
{
	// "open-prisma-mcm" / "open-smf" / "open-community-shaders" / "open-ied" /
	// "open-npa" / "open-manipulator"
	bool IsAction(const std::string& a);

	// NPA.dll is loaded in this game (seed gate + an honest refusal).
	bool NpaLoaded();

	// ObjectManipulator.dll (The Manipulator 9001) is loaded in this game.
	bool ManipulatorLoaded();

	// How SKSE Menu Framework's own ini says its panel is opened, as words for
	// a sentence: "F1 twice", "F1", "hold F1". Empty when its key is off.
	std::string SmfToggleHint();

	// Spawns a worker thread and returns immediately. Call AFTER ClosePalette().
	void Fire(const std::string& a);
}
