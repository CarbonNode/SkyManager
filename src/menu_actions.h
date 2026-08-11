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

namespace MenuActions
{
	// "open-prisma-mcm" / "open-smf" / "open-community-shaders"
	bool IsAction(const std::string& a);

	// Spawns a worker thread and returns immediately. Call AFTER ClosePalette().
	void Fire(const std::string& a);
}
