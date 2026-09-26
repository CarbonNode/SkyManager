#pragma once

#include <string>

// ---------------------------------------------------------------------------
// ReLight, natively in SkyManager.
//
// Rober, 2026-09-21: "open relight doesnt work, its doing a hotkey or
// something, lets build relight into a SkyManager menu."
//
// He was right about the cause. The deck's old "Open ReLight editor" button
// did not open ReLight at all — it fired the SKSE MENU FRAMEWORK hotkey
// (MenuActions::Fire("open-smf")) and hoped, because ReLight's own UI is an
// SMF page. If that key is unbound or the menu does not take, nothing happens
// and there is nothing on screen to say why.
//
// ⚠ WHAT RELIGHT ACTUALLY IS — the old button was also in the wrong PLACE.
// ReLight is a WORLD lighting overhaul: it merges and repairs the game's own
// light sources (candles, sconces, lanterns, chandeliers) and can exclude
// specific ones. It is NOT a scene light editor, and it does nothing for the
// lighting of an OStim scene — that is Better FaceLight and Quick Light, which
// the Lighting segment already drives. The button sat there promising
// something it could never deliver.
//
// ── The wire ────────────────────────────────────────────────────────────────
// ReLight is a DLL-only SKSE plugin (Relight.dll) whose entire configuration
// is ONE file: Data/SKSE/Plugins/ReLight.ini. Its in-game menu writes the same
// file — the section is literally named "[Refs Excluded Using in Game Menu]".
// So we read and write that file directly, line-surgically, preserving its
// comments, and skip the menu entirely.
//
// ⚠ NO RELOAD. Unlike PPA there is no reload hotkey and no reload export in
// the DLL (verified: the strings "Reload"/"reload"/"Hotkey" appear ZERO times
// in Relight.dll). ReLight reads the ini at load, so every change here applies
// on the NEXT GAME START. The page says so; it must never imply otherwise.
// ---------------------------------------------------------------------------

namespace RelightConfig
{
	// { ok, installed, path, smf, rows:[{key,label,type,value,step,detail}],
	//   excluded:[{line,id,plugin,label}], msg }
	std::string StateJson();

	// { op:"set",     key, value }              a scalar in the ini
	// { op:"exclude" }                          add the crosshair's ref
	// { op:"include", line }                    remove an excluded ref
	// -> the new StateJson with { ok, msg } replaced.  MAIN THREAD.
	std::string Apply(const std::string& request);
}
