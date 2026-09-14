#pragma once

#include <string>

// court-status: the deck's marriage + pregnancy knowledge, written to disk so
// CHIM can read it. (Rober, 2026-09-14: "skymanager hooks to marriage and
// pregnancy — maybe we expose an api from that".)
//
// The DLL is the only thing that can see Fertility Mode's pregnancy state and
// M.A.R.A.S's marriage state: both live in script properties / faction ranks
// inside the running game, not in any file. This module walks the Follower
// Organizer roster the same way fertility_bridge.cpp does, asks the two bridges
// about each actor, and writes ONE small JSON file:
//
//   Data/SKSE/Plugins/HotkeyDeck/court-status.json
//   { "version":1, "written":<unix>, "fertility":bool, "maras":bool,
//     "actors": { "<name>": { "formId", "categories":[..],
//                             "fertility": { pregnant, day, termDays, trimester, percent, daysLeft, father | cycleDay, ovulating },
//                             "maras":     { spouse, status, hierarchy, affection, affectionWord } } } }
//
// Under MO2 that path lands in Overwrite (or the mod folder if the file already
// exists there); the CHIM-side reader (roleplay/chim-prompts/ext/court) checks
// both and takes the newer. Reading only — nothing here changes game state.
// Same soft posture as the bridges: no FM or no MARAS just means those keys are
// absent; no save loaded means an empty actors map.
namespace CourtStatus
{
	// Build the payload from a FollowerDeck::StateJson() roster and write it
	// atomically (tmp + rename). Skips the disk entirely when nothing changed
	// since the last write. Main thread only (it resolves actors).
	bool Write(const std::string& foStateJson);
}
