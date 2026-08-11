#pragma once

#include <string>

// Instant wait — the fix for the months-long "slow sleep/wait" saga.
//
// The vanilla Sleep/Wait menu advances one game hour per REAL simulation frame
// at best, and this rig's frame-generation pipeline both halves real frame
// rate and sleeps the main thread to pace fake frames — so the menu crawls no
// matter what Engine Fixes' fSleepWaitTimeModifier says, at any displayed FPS.
// (Proven 2026-08-02 by stack-sampling live waits; the FG toggle-key guard in
// fg_guard.cpp was attempt #1 and the upscaler ignored the synthesized key.)
//
// So: stop making ticks faster and stop ticking. These actions jump the game
// clock in ONE step — Calendar's GameHour global gets the hours added, the
// engine wraps hour->day itself and mods' game-time handlers catch up in a
// single hitch. Same mechanism Super Fast Wait Menu SE uses from Papyrus
// (GameHour.Mod), without spending a plugin slot. Frame rate is irrelevant.
//
// Deliberately NOT wired to the Sleep/Wait menu: these are palette actions
// ("Wait 1/6/12/24 Hours" on the NPC-actions model), seeded unbound into a
// "Time" tab. Searchable from Omni by name the day they land.

namespace TimeActions
{
	bool IsAction(const std::string& a);  // "wait-1" / "wait-6" / "wait-12" / "wait-24"
	void Fire(const std::string& a);      // main thread (call from an SKSE task)

	// Time-pane bridge. Both main thread.
	std::string InfoJson();                          // {hour,day,month,year,daysPassed} or "null"
	bool        Jump(float hours, std::string& err); // arbitrary-hours jump; err set on refusal
}
