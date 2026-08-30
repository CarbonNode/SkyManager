#pragma once

#include <string>

// Player Tune — the Character sheet's "⚒ Tune" modal: PROTEUS's player editor
// (skills, attributes, regen, resistances, carry weight, speed, unarmed
// damage, perk points, dragon souls) rebuilt on direct ActorValue writes.
//
// The contract:
//  - Everything here is a BASE ActorValue write on the player. Base AVs
//    persist in the SAVE, so unlike item/spell edits there is NO sidecar and
//    no replay: the savegame is the store. The one non-AV field is perk
//    points (PlayerCharacter::GetGameStatsData().perkCount).
//  - SpeedMult only takes effect after the engine re-derives movement speed;
//    the proven nudge is a tiny CarryWeight mod +/- right after the write.
//  - Threading law is item_explorer's: both entry points run on the SKSE
//    task thread only (main.cpp AddTasks each call).
//
// Bridge (wired in main.cpp): requests psTuneGet/psTuneSet; replies
// psTuneData/psTuneResult (the char sheet's ps* family).
namespace PlayerTune
{
	// -> {ok, level, perkPoints, dragonSouls, attrs:{...}, regen:{...},
	//     resists:{...}, skills:[{key,label,base}]}
	std::string GetJson();

	// {set:{<key>:number,...}} — applies every recognized key, answers a
	// fresh GetJson payload + msg. Keys are the wire names GetJson emits.
	std::string ApplyJson(const std::string& req);
}
