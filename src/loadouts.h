#pragma once

#include <string>

/*
 * Follower Loadouts — named groups of followers you switch between with one
 * press, and gear CLASSES you stamp onto them (Rober, 2026-09-14: "a way to
 * setup a group of followers, and easily switch between them … set unique
 * sets of armor and apply to a Class … be able to easily teleport them all to
 * me and recruit all to party in one button go").
 *
 * TWO THINGS, kept apart on purpose:
 *
 *   LOADOUT  a named list of people ("Dragon Guard"), each member carrying the
 *            CLASS she plays in THIS group. The same woman can be an archer in
 *            one loadout and a spellsword in another — the class rides on the
 *            membership, not on her.
 *   CLASS    a named kit ("Dragon Warrior"): a gear list (real items, by
 *            durable identity), an optional COMBAT STYLE, and a "replace what
 *            she wears" switch. Dressing an actor with a class hands her every
 *            piece she lacks and force-equips it (the wigs/wardrobe idiom), then
 *            sets her combat style.
 *
 * THE VERBS (all physical ones close the palette first, main.cpp's job):
 *
 *   deploy   bring every member to you (Enable + MoveTo, so an unloaded
 *            persistent ref in another hold still arrives) and RECRUIT the
 *            ones not already following, through NffControl — the same door
 *            the F7 card uses, so NFF owns every gate. mode "swap" first
 *            DISMISSES every current follower who is not in the group.
 *   summon   the teleport half only.
 *   dismiss  NFF dismiss for every member who is following.
 *   dress    apply each member's class (gear + combat style) to the LOADED
 *            members; deploy does this too, after the recruits land.
 *
 * ⚠ RECRUITS AND DISMISSES ARE SERIALISED. NFF's RecruitFollower/RemoveFollower
 * do not act: they store `actActor` + `doAction` on ONE controller script and
 * RegisterForSingleUpdate(0.2) — a second call inside that window overwrites
 * the first, which is exactly the "half-recruit" nff_control.h documents. So
 * the job runs one NFF call at a time, waits for its `done` (or a 3 s timeout —
 * the VM may never run the stack), pauses a beat, then sends the next. A
 * twelve-person deploy takes a few seconds and says so on screen.
 *
 * COMBAT STYLES. Two sources, one list: NFF's own twelve (the FormList
 * nwsFFcombatStyles on nwsFollowerVariableScript, named exactly as its MCM
 * names them — Mercenary, Defender, Berserker, Archer …) FIRST, then every
 * TESCombatStyle in the load order by EditorID. Applying one is what NFF's own
 * SetCombatST does: ActorBase.SetCombatStyle. For an NFF style we ALSO stamp
 * nwsFF_CSFac at that rank, so NFF's MCM agrees and NFF's own on-load reapply
 * keeps it; for any other style we take her OUT of that faction (else NFF
 * would overwrite ours on the next load) and re-apply it ourselves on
 * kPostLoadGame from the `applied` memory below. ⚠ A NON-UNIQUE base shares its
 * combat style with every spawn of that template — reported in the reply,
 * never silently.
 *
 * ⛔ ONE ACTOR, ONE DRESSING BACKEND (nff_outfits.h). A SOES-tracked actor is
 * re-dressed by SOES within its 2 s poll, so force-equipping her is a visible
 * lie. Dress REFUSES her with "assign the outfit in Wardrobe instead" and
 * still applies the combat style, which dresses nobody.
 *
 * Storage: loadouts.json BESIDE hotkeys.json, this module's own file (atomic
 * write + .bak) — NOT a hotkeys.json slice, for the mounts.cpp reason: a
 * slice is silently dropped by any older DLL's save, and DLLs from parallel
 * sessions rotate on this rig.
 *
 * Threading: everything except the file helpers touches engine state and must
 * run on the main thread (SKSE task). Own mutex for the file-backed state only.
 *
 * Marker: "loadouts: deploy" (deploy log line), "loadouts: dressed" (dress).
 */
namespace Loadouts
{
	// {"ok","ready","nff",
	//  "loadouts":[{id,name,note,icon,members:[{formId,plugin,name,original,cls}]}],
	//  "classes":[{id,name,note,icon,replace,style:{plugin,formId,name,nff}|null,
	//              gear:[{plugin,formId,name,count,kind}]}],
	//  "roster":[{formId,plugin,name,original,cat,fc,following,inWorld,dead,
	//             guarded,unique,key}],     every Follower Organizer member that resolves
	//  "party":["<key>",…],                  durable keys of everyone with you now
	//  "styles":[{plugin,formId,name,nff}]}  NFF's twelve first, then the load order
	// First call loads loadouts.json. MAIN THREAD.
	std::string StateJson();

	// One request. Administrative acts mutate + save + reply {ok,act,msg,id?};
	// physical acts (deploy/summon/dismiss/dress/dressOne) only VALIDATE here
	// and reply {ok,act,physical:true,…} — the caller closes the palette and
	// calls Execute. MAIN THREAD.
	std::string ActJson(const std::string& req);

	// True for an act that must run in the live, unpaused world.
	bool IsPhysical(const std::string& act);

	// Run a physical act. Asynchronous (a chain of main-thread tasks); reports
	// its summary as an on-screen notification and in HotkeyDeck.log. `onDone`
	// is invoked on the main thread with the summary json when the chain ends.
	// Refuses (notifies) if a job is already running.
	void Execute(const std::string& req);

	// Fire one group order from a BOUND KEY, with no pane open and therefore no
	// selection: the target is the group the player ★-pinned (Config.activeId,
	// persisted), or the only group when there is exactly one. With several
	// groups and no pin it refuses on screen rather than guessing which squad to
	// send. `what` is one of the group acts: "deploy", "groupFollow",
	// "groupWait", "groupSic", "groupDisengage". Main thread only.
	bool FireActiveOrder(const std::string& what);

	// Who is in which group, keyed by the follower's ORIGINAL name — the join
	// the Followers tab can actually make, since a runtime FormID is not the
	// identity Follower Organizer files people under. Shape:
	//   { "ok":true, "byOriginal": { "Lydia":[{"group":"Dragon Guard",
	//                                          "id":"l1","cls":"Dragon Warrior"}] } }
	std::string GroupsByOriginalJson();

	// Re-apply every combat style this module has set, for actors that resolve
	// now. Call from kPostLoadGame, deferred a beat (actors are still attaching
	// as it fires). Returns how many were touched.
	int OnPostLoadGame();
}
