#pragma once

#include <cstdint>
#include <string>

// Quest inspector / repair tools for the Hotkey Deck "Quests" tab.
//
// Point at an NPC, open the deck: this finds every quest that NPC is involved
// in, lists that quest's stages with the current one marked, and lets you fire
// a stage to unstick a broken quest.
//
// How the data is sourced (all engine-level — works with ANY mod-added quest,
// ESL included; nothing is hardcoded to vanilla):
//
//   * quest list      TESDataHandler::GetFormArray<TESQuest>() — every quest
//                     from every loaded plugin.
//   * NPC -> quests   two passes, because neither alone is sufficient:
//                       (a) RUNNING quests whose BGSRefAlias currently resolves
//                           to the target ref. Aliases only fill while a quest
//                           runs, so this finds live involvement only.
//                       (b) a STATIC index built once from alias fill data
//                           (Unique Actor / Forced Ref), which also catches
//                           quests that have not started yet — and, crucially,
//                           quests whose alias FAILED to fill, which is the most
//                           common way a quest ends up broken.
//   * stages          TESQuest::waitingStages. Despite the CommonLibSSE-NG
//                     name this is NOT a runtime queue: it is the quest's
//                     complete static stage list off the QUST record, present
//                     even for quests that have never started. Verified against
//                     the live game 2026-07-27 (MQ101 at stage 1000 still lists
//                     all 125 stages; a never-started bounty lists all 5).
//                     `executedStages` is NOT an execution history — it returns
//                     the same two junk entries for every quest. Do not use it.
//   * setstage        Papyrus Quest.SetStage via the VM, so stage FRAGMENTS run.
//                     Writing currentStage directly would change the number and
//                     repair nothing.
namespace QuestTools
{
	// Reset cached state. Call at kDataLoaded; the static alias index itself is
	// built lazily on first use (it walks every quest in the load order, so it is
	// kept out of the startup path).
	void Init();

	// JSON: { hasTarget, npc:{name,formId,baseId,plugin}, quests:[ ... ] }
	// Quests the snapshotted crosshair NPC is involved in.
	std::string QuestsForTarget();

	// Same answer for an EXPLICIT actor, rather than whoever the crosshair
	// snapshot named. The F7 card's 📜 Quests modal needs this: its subject is a
	// picked party member whenever you clicked a face on the party strip, so the
	// crosshair would be the wrong person. 0 / an unresolvable id answers
	// { hasTarget:false }, exactly like no crosshair target.
	std::string QuestsForActor(std::uint32_t actorFormID);

	// JSON: { quests:[ ... ] } — free-text search over every quest by display
	// name, EditorID, FormID or plugin. This is the fallback that matters when an
	// alias never filled: the NPC lookup cannot see that quest, but you can still
	// find it by name.
	std::string SearchQuests(const std::string& query);

	// JSON: full detail for one quest — stages, current stage, objectives,
	// aliases with fill state.
	std::string QuestDetail(std::uint32_t formID);

	// Fire a stage through Papyrus. JSON: { ok, message, detail:{...} }
	std::string SetStage(std::uint32_t formID, std::uint32_t stage);

	// verb: "reset" | "start" | "stop" | "complete".
	// JSON: { ok, message, detail:{...} }
	std::string RunAction(std::uint32_t formID, const std::string& verb);

	// "Go to target" — the console `movetoqt` teleport, split in two so main.cpp
	// can close the palette between validation and the jump:
	//
	//   CheckQuestTarget    pure pre-flight. movetoqt fails SILENTLY (console-only
	//                       error) when a quest has no live target, so we say WHY
	//                       first: not running / no displayed objective / objective
	//                       has no map target / target alias is empty (the classic
	//                       broken-quest case this tab exists for).
	//   MoveToQuestTarget   fires `movetoqt <editorId>` through the console script
	//                       compiler. The engine's own target resolution (alias ->
	//                       ref -> worldspace load) is battle-tested; not cloned.
	//
	// Both return { ok, message }.
	std::string CheckQuestTarget(std::uint32_t formID);
	std::string MoveToQuestTarget(std::uint32_t formID);
}
