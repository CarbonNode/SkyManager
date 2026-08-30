#pragma once

#include <string>

// NPC Tune — the F7 quick card's "⚒ Tune" modal (PROTEUS's NPC editor,
// rebuilt): level, attributes, regen, resistances, skills, size, the AI
// temperament dials (aggression / confidence / assistance / morality) and
// the essential / protected / killable tri-state, on whoever the card holds.
//
// The contract — two persistence tiers, stated in the UI:
//  - ACTOR-side writes (every ActorValue, and scale via a targeted console
//    `setscale`) land on the REFERENCE and persist in the save on their own.
//    No sidecar, no revert file — the player Tune modal's law.
//  - BASE-record writes (level + the protection tri-state) mutate TESNPC in
//    memory and are forgotten on relaunch, so they persist in the module's
//    OWN sidecar (Data/SKSE/Plugins/HotkeyDeck/npc-edits.json), keyed by the
//    BASE's "Plugin.esp|LOCALHEX" (file-width mask), originals captured →
//    live revert, replayed once per launch at kDataLoaded (item_edit's law).
//    A dynamic base (no source file) applies live but cannot persist — the
//    reply says so (`durable:false`) and the modal repeats it.
//  - Setting level CLEARS kPCLevelMult: a number you typed should mean
//    itself, not a multiplier — the modal says she stops scaling with you.
//  - Protection touches BOTH the base flags and the live actor's boolFlags,
//    so the change bites now and survives the base->actor resync on load.
//  - Threading law is item_explorer's: every entry point runs on the SKSE
//    task thread only; ReapplyAll runs inside kDataLoaded.
//
// Bridge (wired in main.cpp): requests ntGet/ntApply/ntRevert; replies
// ntGetResult/ntApplyResult/ntRevertResult.
namespace NpcTune
{
	// {formId:"<runtime hex>"} -> the full tune state (see npc_tune.cpp's
	// StateFor for the exact shape).
	std::string GetJson(const std::string& req);

	// {formId, set:{...}} — AV keys / scale / level / protection; applies,
	// persists the base tier, answers a fresh state + msg.
	std::string ApplyJson(const std::string& req);

	// {formId} -> restores the BASE originals (level/protection), drops the
	// sidecar entry. Actor-side values live in the save and are not touched.
	std::string RevertJson(const std::string& req);

	// Re-apply every persisted base edit. Called once per launch at kDataLoaded.
	void ReapplyAll();
}
