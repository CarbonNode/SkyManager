#pragma once

#include <string>

#include "json.hpp"   // same as pch.h's copy; the include guard makes it a no-op

// Wintersun — Faiths of Skyrim, read for the Character sheet's Faith card.
//
// WHAT THIS IS. Wintersun keeps the whole of a character's religion inside ONE
// Papyrus quest script, WSN_TrackerQuest_Quest:
//
//   WorshipID              Int, -1 when you follow nobody. The index into every
//                          per-deity array below. It lives in the SAVE (a quest
//                          script variable), not in a global — which is why the
//                          deity cannot be read the way survival.cpp reads
//                          SunHelm's needs.
//   WSN_DeityName[]        String[] — the mod's OWN display name for each god.
//   WSN_DivineType[]       String[] — "Divine", "Daedric Prince", …
//   WSN_Boon1[] / [2]      Spell[] — the follower power, and the one that only
//                          arrives once you are Favoured.
//   WSN_Tenet[]            Spell[] — the ability whose description IS the tenets
//                          (how this god's favour is won and lost).
//   WSN_Blessing[]         Spell[] — what their altar gives you.
//   WSN_ThresholdFavored   Float — favour at which Boon 2 is granted.
//   WSN_FavoredDiminishTarget  Float — favour at which gains stop entirely.
//   WSN_Favor_Global       the live favour, as a GlobalVariable.
//
// So the deity, the numbers AND the bonus text all come from Wintersun itself:
// nothing here hardcodes a god, a FormID, a threshold or a description. A
// Wintersun update that adds a god is supported the day it lands, and an
// unreadable property degrades to an omitted field rather than an invented one.
//
// GATING IS BY RESOLUTION, the same law survival.cpp follows: the quest is found
// by its attached SCRIPT CLASS (never by plugin name or FormID — the patches in
// this load order prove the plugin set is not fixed), and when nothing binds,
// `present` is false and the view draws no card at all.
//
// THREADING: everything here touches the VM's bound objects and the player, so
// it is MAIN THREAD ONLY — it is called from CharSheet::BuildSheetJson, which
// already carries that contract.
namespace Faith
{
	// Drop the cached quest pointer + bound object. A handle from the outgoing
	// session is not valid in the next one, so main.cpp calls this on
	// kPreLoadGame / kPostLoadGame exactly as it does for FertilityBridge.
	void Invalidate();

	// The Faith payload, as a JSON object (never null, never throws):
	//
	//   { present, active, deity, pantheon, favor, threshold, target, favored,
	//     raceFavored, raceMult, drainPerDay, prayerGain, apostasyAt,
	//     entries:[{slot,label,name,text,have,note}], prayer:{name,have} }
	//
	// `present:false` means Wintersun is not in this load order (or its quest
	// has never started): the card is hidden. `active:false` means it IS there
	// and you follow no god — a real, showable state.
	nlohmann::json BuildJson();
}
