#pragma once

#include <string>

// Un-wedge disabled player controls and menus — the "Tab does nothing and
// Quests/General are red in the Esc menu" state (hit live 2026-08-03).
//
// ------------------------------------------------------------ the wedge ----
// A quest scene, CHIM director push, or mod script calls
// Game.DisablePlayerControls(...) / Game.SetInChargen(...) and then dies (or
// its re-enable path never runs). Nothing re-enables, and the disable LIVES IN
// THE SAVE — reloading does not clear it. The visible symptoms map to layers:
//
//   * Tab dead / no Tween menu ............ ControlMap UEFlag::kMenu cleared
//   * Quests/General red in the Esc menu .. the script-side journal-tabs lock
//                                           (DisablePlayerControls' 8th arg —
//                                           NOT readable via ControlMap)
//   * Save red / "You cannot save now" .... SetInChargen saving lock, and/or
//                                           PlayerCharacter byCharGenFlag
//   * keys silently eaten ................. a stuck AllowTextInput count, or
//                                           ignoreKeyboardMouse left set
//
// ---------------------------------------------------------------- the fix --
// One user-fired action (never automatic — same standing rule as Animation
// Resolver: the click is the consent). It clears EVERY layer, because the
// layers are set together and half a fix leaves half the symptoms:
//
//   1. engine: ControlMap::ToggleControls(all 12 UEFlags, enable), drain
//      textEntryCount via AllowTextInput(false), clear ignoreKeyboardMouse,
//      and zero PlayerCharacter's byCharGenFlag.
//   2. script: DispatchStaticCall Game.EnablePlayerControls(true x8, 0) +
//      Game.SetInChargen(false,false,false) — the ONLY way to reach the
//      journal-tabs and chargen locks, which have no engine-side accessor.
//
// Deliberately NOT touched: fast travel (EnableFastTravel) — mods disable it
// on purpose (city interiors, survival), so clearing it would be a silent
// gameplay change, exactly what the deck never does uninvited.
//
// Every fire logs the full before-state (flags, counts, chargen byte) so the
// pattern across fires eventually names the culprit mod — the Animation
// Resolver philosophy: fix now, but make the wedge tell us who set it.
//
// MAIN THREAD ONLY (ControlMap + VM dispatch); FireAction's AddTask does that.
namespace ControlsFix
{
	// True if `action` is this module's verb ("fix-controls").
	bool IsAction(const std::string& action);

	// Snapshot, clear every layer, notify with what was actually wedged.
	// Safe with no game loaded — it says so instead of doing nothing.
	void Fire();
}
