#pragma once

#include <string>

// High King tab — the Become High King of Skyrim TNG (BHKoS) integration.
//
// WHAT THIS IS. BHKoS TNG runs a whole kingdom simulation server-side in
// Papyrus: weekly tax collection per hold (KingdomTaxManager), a 0-100 economy
// score with vendor-gold tiers (AAEconomySystemScript), per-city approval and
// faith with deltas and tiers, a rebellion system per hold, a 12-seat royal
// council found through "Finding the ..." quests, 12 passive King Stone
// abilities, and a treasury global mirrored into a physical gold pile. All of
// that state lives in ~536 GlobalVariables — this module reads them and the
// deck draws the kingdom dashboard nothing in the mod itself surfaces in one
// place. Verbs go THROUGH the mod's own scripts (never reimplemented):
//
//   collect  ->  KingdomTaxManager.CollectAllHoldTaxes(now)   (quest found by
//                attached script class — the faith.cpp/follower_frameworks law)
//   ledger   ->  AAKingBookofCouncilScript.PushLedgerSnapshot() on quest
//                0x26F325 (the council book quest)
//   tax rate ->  writes AATax_Rate_<hold> — the exact global the mod's own
//                court dialogue writes via SetTaxRateForSelectedHold; rates
//                are the mod's own tier steps {0,5,10,15,20,25}.
//
// IDENTITY LAW: everything resolves by (localId, "BecomeKingofSkyrimTNG.esp")
// via TESDataHandler::LookupForm — NEVER by EditorID and NEVER by CK property
// name: the mod's script properties routinely carry names that match no real
// global (KingdomTaxManager's "AAApproval_Whiterun" property vs the real
// global "AAApprovalWhiterun"), so a name lookup would silently read nothing.
// Every localId below was dumped from the ESP's own GLOB/QUST/SPEL groups
// (research: C:\Dev\bhk-research on the rig, 2026-08-18).
//
// THREADING: every entry point touches engine state — main.cpp calls them
// from SKSE tasks only (main thread, no locks).
namespace HighKing
{
	// The mod's plugin file. Detection (tab gate, seeds, DetectedModsJson flag
	// "highking") keys on this exact name.
	inline constexpr const char* kPlugin = "BecomeKingofSkyrimTNG.esp";

	// TESDataHandler::LookupModByName(kPlugin) != nullptr, cached after the
	// first call (the load order cannot change mid-session).
	[[nodiscard]] bool Present();

	// The whole dashboard, one payload:
	//   {present, king:{isKing, reigning, pathStage, supporters, goldCounted,
	//    goldNeeded}, treasury:{total, lastCollectionDay, daysNow,
	//    daysSinceCollection, daysUntilCollection, projected, projectedRaw,
	//    coinStone, lawgiverStone, mineLast}, economy:{score, tier, tierName,
	//    lastApproval, difficulty, tariffs}, skyrim:{approval, approvalDelta,
	//    faith}, counts:{citizens, nobles, heroes, rangers, detainees},
	//    expenses:{guards, castles, infrastructure, lighting, water, priests,
	//    total}, rebellion:{enabled, any},
	//    holds:[{id, name, city, rate, base, head, revenue, projected,
	//            approval, approvalDelta, approvalTier, faith, faithTier,
	//            econScore, rebel, bribed, hasRebel}],
	//    stones:[{key, name, active, note}],
	//    council:[{name, state:"filled"|"seeking"|"vacant"}],
	//    powers:[{plugin, localId, formId, name, group, known, cost}]}
	// present:false ships alone when the plugin is absent.
	[[nodiscard]] std::string StateJson();

	// Fire a verb through the mod's own scripts. op: "collect" | "ledger" |
	// "start". Returns {ok, msg} — msg is the honest refusal when the backing
	// quest is not running yet (pre-coronation), the road to the throne was
	// already begun, or the dispatch fails.
	//
	// "start" replicates TIF__05089BE8::Fragment_0 — the dialogue fragment a
	// background NPC's radiant "have you heard of Highreach?" line fires: it
	// hands the player Surgus's Note (BOOK 0x077598), flips
	// AAKingHasHeardofHighreach (GLOB 0x0F7E57), and advances the path quest
	// (already running, Start Game Enabled, sitting at stage 0) to stage 1
	// via the native "Quest" script's own SetStage — same trigger the mod
	// itself uses, just without waiting to overhear it (research: 2026-08-19,
	// C:\Dev\bhk-research, decompiled TIF__05089BE8 + AABecomeKingQuestTracker).
	[[nodiscard]] std::string ActJson(const std::string& op);

	// Set one hold's tax rate global. holdId is the row id from StateJson
	// ("whiterun".."highreach"); rate must be one of the mod's own dialogue
	// steps {0,5,10,15,20,25} — anything else is refused, not clamped, so a
	// UI bug can never invent a rate the mod's approval table has no row for.
	// Returns {ok, msg, hold, rate}.
	[[nodiscard]] std::string SetTaxRateJson(const std::string& holdId, double rate);
}
