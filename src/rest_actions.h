#pragma once

#include <string>

// Rest — "eat your fill, drink your fill, sleep" (Rober, 2026-10-14, at his
// own laid table with SunHelm reading Ravenous / Severely Dehydrated /
// Slightly Tired: "a hotkey that opens a menu like drink your fill, or eat
// your fill, for roleplaying when in home ... hooks to our time menu, allows
// you to quickly progress time (but say its sleep) and get sunhelm food,
// drink, sleep of your choosing").
//
// WHAT IT IS: the Time Dial's second mode. The seeded `rest` action opens the
// dial with three choices on it; the ring picks how long you sleep. Confirm
// closes the dial and this module does the rest.
//
// IT IMPLEMENTS NO NEED MATHS. Every change to a need goes through SunHelm's
// own Papyrus on its own quests (script names verified out of
// SunHelmSurvival.bsa's sources, quest EditorIDs out of SunHelmSurvival.esp,
// 2026-10-14):
//   _SHFatigueQuest / _SHFatigueSystem — DetectSleepStart(float) BEFORE the
//       clock moves (the same call its OnSleepStart makes: the fatigue tick
//       then skips the night instead of adding it. Its Hunger/ThirstWasSleeping
//       flags land on the FATIGUE instance only — SunHelm's own quirk, so a
//       bed does not slow hunger either; a need you do not fill grows as usual),
//       then DecreaseFatigueLevel(hours x _SHFatigueSleepRestoreAmount) once
//       the clock has settled — DetectSleepStop's own formula, fed the hours
//       we slept instead of a GameDaysPassed difference we did not watch.
//       Its perk bonus, Well Rested and the spouse/adoption bonuses all come
//       from SunHelm's stage code exactly as after a bed.
//   _SHHungerQuest / _SHHungerSystem — SetTimeStamps() then
//       DecreaseHungerLevel(big): the level clamps to 0 inside SunHelm, and
//       the fresh time stamp stops an update still pending from the jump
//       adding the night back on top of the meal.
//   _SHThirstQuest / _SHThirstSystem — the same for thirst.
// The clock jump is TimeActions::Jump, the Time tab's and the dial's.
//
// THREADING: Check/Run/StateJson are MAIN THREAD. The chain then waits for
// the calendar to settle on unpaused frames (Papyrus runs unpaused only), so
// the caller must have released any pausing Focus before Run.

namespace RestActions
{
	struct Plan
	{
		bool eat = false;
		bool drink = false;
		bool sleep = false;
		int  hours = 0;   // sleep length, 1-24 when sleep is on
	};

	// {sunhelm:<Widgets::SunHelmNeedsJson or null>, on, bound:{hunger,thirst,
	//  fatigue}, sleep:{restorePerHour, hoursToRested}, home:{inHome, place}}
	[[nodiscard]] std::string StateJson();

	// Parse {eat,drink,sleep,hours} and refuse honestly (combat, a wait still
	// settling, SunHelm missing or a need switched off in its MCM). Nothing is
	// touched. err is player-facing.
	[[nodiscard]] bool Check(const std::string& req, Plan& plan, std::string& err);

	// Start the chain for a Plan that passed Check. Reports to the player
	// through notifications; the dial is already closed.
	void Run(const Plan& plan);
}
