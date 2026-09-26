#pragma once

#include <string>

// "Fixes / Unstuck" — one-click rescues for common heavily-modded-game jank.
//
// TWO doors, deliberately:
//
//  1. Fire(action) — the PALETTE door. Each verb is a fireable deck entry
//     (device == "action") acting on the crosshair NPC snapshot
//     (NpcActions::TargetFormID) or, for noclip, on the player.
//     Verbs: "fix-recycle" (recycleactor — rebuild 3D/AI: T-pose/invisible/
//            stuck), "fix-resetai" (re-evaluate AI packages), "fix-calm"
//            (stopcombat + aggression 0), "fix-resurrect" (resurrect 1, keep
//            inventory), "fix-noclip" (tcl — walk out of geometry).
//
//  2. Probe/Apply — the F7 CARD door (the 🔧 flyout). Same verbs, but aimed at
//     a NAMED formId rather than at whatever the crosshair happened to be, and
//     they answer with JSON instead of a notification, so the card can show
//     what it found and what it changed.
//
// ---- the one that is not a console one-liner: "unfollow" -------------------
//
// Rober, 2026-09-20: "sometimes npcs get stuck following me, but are not
// followers". That is not one bug, it is four, and they want different
// answers — which is why Probe() exists and Apply() refuses rather than
// guessing:
//
//   a) A LEAKED ACTOR FLAG. She is IsPlayerTeammate(), and/or sits in
//      CurrentFollowerFaction / PlayerFollowerFaction, with nothing driving
//      it. Left behind by a mod that recruited her and died, a save-game
//      reload mid-dialogue, a dismissed follower whose script never ran.
//      THIS is the one we can actually fix: clear the flag, take her out of
//      the follower factions, re-evaluate. Safe, reversible, hers alone.
//
//   b) A QUEST ALIAS holds her with a follow/escort/accompany package. The
//      package is instanced ON THE ALIAS, which outranks anything we set on
//      the actor — the deck already learned this the hard way with
//      freeze/sit/bed (see follower_frameworks.h). Clearing her flags would
//      change nothing and would LOOK like it worked. So we name the quest and
//      say so instead.
//
//   c) A KNOWN FRAMEWORK owns her (NFF, MHiYH, a companion mod's own system).
//      Ripping the flags out from under it leaves the framework still
//      believing it has her — the next EvaluatePackage puts her right back,
//      and its own dismiss may then refuse. Name it and send you to its
//      dismiss.
//
//   d) Nothing at all is set and she still walks after you. That is a stale
//      package the engine has not re-evaluated; "reset AI" is the fix, and
//      Probe says so rather than reporting "nothing wrong".
//
// Apply("unfollow") therefore does only (a), reports (b)/(c) as blocked with
// the name of whatever is holding her, and always finishes with an
// EvaluatePackage so the change takes effect without waiting for the engine.
// `force` overrides the (c) refusal for the case where the framework is the
// thing that is broken — it still cannot beat (b), and says so.
namespace FixActions
{
	// --- palette door ---
	bool IsAction(const std::string& action);
	void Fire(const std::string& action);   // main thread only

	// --- F7 card door --- (main thread only; both return JSON)
	// { ok, name, following, why:[…], fixable, blocked, framework, aliases:[…] }
	std::string Probe(const std::string& requestJson);
	// { ok, msg, changed:[…], blocked } — request: { formId, fix, force }
	std::string Apply(const std::string& requestJson);
}
