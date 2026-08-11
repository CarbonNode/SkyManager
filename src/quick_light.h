#pragma once

#include <string>

// Quick Light control — the deck's "Light" tab backend (Rober, 2026-08-05).
//
// The ask: hook the deck to Quick Light SE (SforzinDaJungla / "SJG", Nexus
// 62466 — the carried portable light) and give a STATE-AWARE On/Off toggle in
// the deck, with a live indicator, rather than just re-emitting its hotkey.
//
// How Quick Light actually works (decompiled from its own scripts —
// aaaQLPlayerAliasScript.pex / aaaQLMCMScript.pex, not guessed):
//
//   - A quest `aaaQLQuest` (QuickLight.esp 0x000D62) runs a ReferenceAlias
//     named "Player", scripted by `aaaQLPlayerAliasScript`.
//   - The light is ON iff the player carries one of the mod's four self
//     magic effects — aaaQLLightSelf / …SlightlyBright / …Bright / …Wide —
//     one per MCM brightness. That HasMagicEffect check is exactly the mod's
//     own test (CastLight: `if player.HasMagicEffect(BrightnessEffect)`), so
//     we read the truth, not a proxy.
//   - The alias script exposes `CastLight()` (toggle, with the mod's Facelight
//     interplay) and `RemoveLight()` (explicit off). We DISPATCH those through
//     the Papyrus VM — the same proven path the Followers tab uses to call a
//     framework's own wait function — so turning on uses the player's chosen
//     brightness / light-source and never desyncs the script's own state.
//     Reimplementing add/remove in C++ can't know the selected brightness when
//     the light is off, so it would add the wrong variant; calling the mod's
//     function sidesteps that entirely.
//   - `aaaQLQuest.IsRunning()` is the mod's master switch (its MCM "Activate
//     Mod" toggle Start/Stop's the quest). Off = the deck reports it honestly
//     instead of firing into a stopped quest.
//
// Nothing here persists: the light state lives in the save (an ability spell on
// the player), so there is no config slice — StateJson reads live truth on
// every poll and the actions dispatch and re-read. All of it is MAIN-THREAD
// only (form lookup + VM dispatch + HasMagicEffect); the main.cpp handlers hop
// to the task thread before calling in.
namespace QuickLight
{
	// {"ok":true,"installed":bool,"running":bool,"on":bool}
	// installed = QuickLight.esp present; running = its quest active (MCM on);
	// on = the player currently carries a Quick Light effect.
	std::string StateJson();

	// Each returns {"ok":bool,"on":bool,"msg":str}. `on` is the PREDICTED state
	// after the (async) VM dispatch — the pane's poll reconciles it with truth
	// a beat later. A refusal (not installed / MCM-off / VM unreachable) comes
	// back ok:false with a sentence the pane shows.
	std::string TurnOn();   // no-op if already on; else CastLight()
	std::string TurnOff();  // no-op if already off; else RemoveLight()
	std::string Toggle();   // always CastLight()

	// Seeded native action "quick-light" (bindable in F2, e.g. to a Scimitar
	// button) — toggles, same as the pill.
	bool IsAction(const std::string& a);
}
