#pragma once

#include <functional>
#include <string>

namespace RE
{
	class Actor;
}

// WRITE side for Nether's Follower Framework, plus the "show me what they are
// actually wearing" read that goes with it.
//
// Same split as the MHiYH pair: nff_bridge.* READS NFF's conclusions off the
// engine and refuses to write; this file asks NFF to CHANGE them, through the
// exact entry points its own dialogue uses. Nothing here reimplements
// recruitment.
//
// ------------------------------------------------------------------ why ----
// The obvious implementation of "recruit" — SetPlayerTeammate(true) plus a
// shove into the follower faction — is WRONG, and produces a follower NFF does
// not know it has: no alias slot, no framework tweaks, no sandbox package, no
// history entry, and a permanently wrong follower count. NFF's own decompiled
// RecruitAction (nwsFollowerControllerScript.psc:354, decompiled) does
// fourteen distinct things in order — ForceRefTo an alias, optional protect
// alias, relationship rank, DismissedFac/CommentFaction, SetPlayerTeammate,
// IgnoreFriendlyHits, CurrFollowerFac + PlayerFollowerFac ranks, CheckSteward,
// 3DNPC handling, SetTweaks, SetDmgMult, AddToHistory, GetFollowerCount,
// SetSandbox, EvaluatePackage, then followeraliasscript::CheckFollower. Half of
// that reads private state we cannot see from here.
//
// So recruitment is ONE call into NFF's own controller:
//
//     (nwsFF as nwsFollowerControllerScript).RecruitFollower(actor)
//
// which is verbatim what vanilla's DialogueFollowerScript::SetFollower does in
// NFF's own override of it (DialogueFollowerScript.psc:39-42) — i.e. exactly
// what "Follow me, I need your help" runs. RecruitFollower itself only
// null-checks, dead-checks, then defers to NFF's update loop
// (doAction = 2; RegisterForSingleUpdate(0.2)), so it is cheap and asynchronous
// and NFF owns every gate: "already in your group", "too many followers", slot
// assignment and the notifications for all three.
//
// NFF FIRST, ALWAYS. When nwsFollowerFramework.esp is absent we fall back to
// vanilla's DialogueFollower quest (Skyrim.esm 0x000750BA) SetFollower, which
// is the same shape one layer down. The reply says which one ran, so a recruit
// can never quietly go through the wrong framework.
//
// -------------------------------------------------------- equipped items ----
// "Open their inventory" is Actor.OpenInventory(abForceOpen) — a Papyrus
// function with no C++ native, so it dispatches like every other call here.
// We pass abForceOpen = TRUE: that is the full-container mode NFF itself uses
// when it wants complete access (nwsFollowerSetsScript.psc:218,
// nwsFollowerUILIBScript.psc:293), as against the polite trade view its
// GuardTrade topic opens with False.
//
// Force-open is necessary but NOT sufficient for "show me everything they have
// on". The ContainerMenu still hides or locks items that belong to the actor's
// default OUTFIT — and on this rig three separate systems (SOES-NG, NFF's own
// outfit sets, Tailor) dress people by owning that outfit form. So the deck
// does not rely on the container to tell the truth: EquippedJson() reads the
// worn set straight off the engine, and flags which pieces are outfit-owned so
// a locked row in the container is explained rather than mysterious.
//
// The read walks the INVENTORY and tests InventoryEntryData::IsWorn(), not the
// biped slots. Wardrobe::WornJson does the latter, which is right for armour
// and only armour; "all equipped items" has to include the weapons, ammo and
// torch that hang off no biped slot at all.
//
// -------------------------------------------------------------- threading ---
// MAIN THREAD ONLY, like every other RE:: path in this plugin — schedule via
// SKSE::GetTaskInterface()->AddTask. The Papyrus call is ASYNCHRONOUS: Apply()
// returns as soon as the stack is queued, and the real result arrives later on
// `done` (already hopped back to the main thread for you).
namespace NffControl
{
	// Called with the *final* result envelope, on the main thread. May never
	// fire if the VM never runs the stack (no save loaded); callers must treat
	// the immediate return of Apply() as the only guaranteed reply.
	using Done = std::function<void(const std::string&)>;

	// True when NFF's controller quest could be resolved this session. False =
	// the mod is absent (recruit still works, via the vanilla fallback).
	bool Available();

	// ------------------------------------------------- the half-recruit ----
	// THE BUG THIS EXISTS FOR (proved on Amaniri, 2026-08-10).
	//
	// Recruitment is not one flag, it is a FACTION state plus a teammate
	// flag, written by a fourteen-step Papyrus routine. Interrupt it — two
	// recruits racing, or a recruit and a dismiss crossing — and an actor is
	// left in CurrentFollowerFaction rank 0 while IsPlayerTeammate() is
	// false. Both halves of her dialogue then vanish:
	//
	//   "Follow me, I need your help"  is conditioned on NOT being a current
	//                                  follower  -> hidden, she already is one
	//   "Wait here" / "Time to part"   are conditioned on IsPlayerTeammate
	//                                  -> hidden, she is not
	//
	// leaving only the handful of generic greetings — the "I only have four
	// dialogue options and none of them are follower ones" report. The state
	// is invisible everywhere else in the game, which is why it reads as
	// random. Amaniri measured in that state: CurrentFollower 0,
	// PlayerFollower 0, DismissedFollower -1, teammate false — beside Vayne,
	// a working follower, at CurrentFollower 0 + teammate TRUE.
	//
	// True when the factions say "current follower" and the engine says "not
	// a teammate". Read-only, main thread only.
	bool IsWedgedFollower(RE::Actor* actor);

	// True when NFF has IMPORTED her — "Add to Framework" in its own dialogue
	// ($FF_SayImport). Import is NOT recruitment and the two must never be
	// conflated: RecruitAction sets SetPlayerTeammate + the vanilla follower
	// factions, ImportAction sets none of them. It only parks her in a follower
	// alias so she can, in NFF's words, "borrow features of NFF" — her own
	// follow package keeps running, and NFF "cannot affect their recruitment or
	// dismissal" ($FF_HireCostDS). That is what makes it the right tool for a
	// companion who has her own follower mod, and why Dismiss is not the way
	// back — Export is.
	//
	// Measured by membership of nwsFF_ImportFac, which ImportAction adds and
	// ExportAction removes. Read-only, main thread only.
	bool IsImported(RE::Actor* actor);

	// True when she is in Skyrim.esm's PotentialFollowerFaction — i.e. the game
	// will let you ask her to follow at all. A THIRD independent state: most
	// NPCs are not in it, which is what NFF's MCM "Force Follower" changes.
	// Read-only, main thread only.
	bool CanBeFollower(RE::Actor* actor);

	// True when she carries the fingerprint "Make recruitable" leaves — a
	// potential follower who is in CurrentFollowerFaction at rank -1 and is not
	// actually following. Distinguishes someone you FORCED into the follower
	// pool from a natural follower like Lydia, so the undo is only ever offered
	// where it is safe. Read-only, main thread only.
	bool WasForcedFollower(RE::Actor* actor);

	// One op. `cmdJson`:
	//
	//   { "op":"recruit",   "formId":"0x…", "plugin":"x.esp", "name":"…",
	//     "force":false }
	//   { "op":"dismiss",   "formId":"…", … }
	//   { "op":"unwedge",   "formId":"…", … }   repair the half-recruit above
	//   { "op":"wait",      "formId":"…", … }   FollowerWaitHere(actor, 1, 0)
	//   { "op":"follow",    "formId":"…", … }   FollowerFollowMe(actor, 1)
	//   { "op":"inventory", "formId":"…", … }
	//   { "op":"removeItem", "formId":"…", "item":"0x…", "itemPlugin":"x.esp",
	//     "count":1 }
	//
	// PARTY orders take no formId at all — they are what the quick card offers
	// when the crosshair is empty:
	//
	//   { "op":"allSummon"  }   teleport every follower to you
	//   { "op":"allRelax"   }   the group starts sandboxing now
	//   { "op":"allUnrelax" }   stop sandboxing, everyone back to you
	//   { "op":"allFollow"  }   every loaded follower follows again
	//   { "op":"allWait"    }   every loaded follower waits here
	//   { "op":"chestOpen"  }   open NFF's shared PLAYER CHEST from anywhere
	//   { "op":"chestPlace" }   move that chest to a spot beside you
	//
	// The player chest is the third storage tier and the one the deck could not
	// reach: her satchel and her spare inventory are per-follower, but every
	// cleared outfit set and every dismissed follower's leftovers DRAIN into the
	// player chest. Both ops are zero-argument calls on nwsFollowerStorageScript
	// (RemoteOpen / PlaceChest). PlaceChest polices itself — it refuses in a
	// dungeon and charges a ~4-game-hour cooldown away from a town or one of
	// NFF's home markers, saying so on screen — so the deck asks and reports the
	// ASK, never a success it did not witness.
	//
	// The first three go through NFF's own group script (nwsFollowerSandboxScript
	// — DoTaskAll / StartSandbox / ResetSandboxVars) and therefore reach even
	// UNLOADED followers, because that script walks NFF's alias array rather
	// than the high-process actor list. There is no per-follower sandbox order
	// in NFF to expose: relaxing is group-wide by design.
	//
	// allFollow/allWait are instead a loop of the SAME per-actor call the
	// single-person buttons make, over the loaded teammates — which is the
	// honest set, since those orders mean nothing for an actor not in the high
	// process. They reply once, phase "done", stating what was ORDERED; NFF
	// answers per actor and an aggregate "3 of 4 worked" would need a barrier
	// for no real gain.
	//
	// removeItem DESTROYS the item (kRemove, no destination) rather than moving
	// it to the player — its reason for existing is the "<Missing Name>" junk a
	// long-lived follower accumulates from uninstalled mods, and relocating
	// broken junk into your own pack is not solving the problem. The view arms
	// it behind a second click, which is where that safety belongs. It replies
	// once, with phase "done": nothing is dispatched to Papyrus.
	//
	// wait/follow are NFF's own order verbs, with the exact arguments its
	// dialogue passes, and both refuse anyone who is not already following —
	// NFF would otherwise notify "$FF_WarnInvalid" and silently do nothing.
	//
	// `formId` may be omitted entirely, in which case the actor is the one
	// snapshotted under the crosshair when the palette opened
	// (NpcActions::TargetFormID) — that is what makes these "quick".
	//
	// `force` only defeats the guarded-NPC refusal (below). It does not defeat
	// dead / not-loaded / already-following, which are facts rather than policy.
	//
	// Returns immediately, always:
	//
	//   { "ok":false, "phase":"refused", "msg":"…", "guarded":bool,
	//     "following":bool }                              nothing dispatched
	//   { "ok":true,  "phase":"sent", "op":…, "via":"nff"|"vanilla",
	//     "formId":"…", "name":"…", "msg":"…" }            queued in the VM
	//
	// and later, on `done`:
	//
	//   { "ok":bool, "phase":"done", "op":…, "via":…, "formId":"…", "msg":"…" }
	//
	// A refusal is a complete answer — `done` will not fire.
	std::string Apply(const std::string& cmdJson, Done done);

	// Every item the actor currently has EQUIPPED — armour, weapons, ammo,
	// torch, everything IsWorn() reports — read off the engine so the answer
	// cannot be filtered by whatever the ContainerMenu chooses to show.
	//
	//   { "ok":true, "who":"Example Follower", "formId":"0x…",
	//     "following":true, "dead":false,
	//     "about":{ "level":12, "race":"Nord", "female":true, "unique":true,
	//               "essential":false, "protected":true, "ghost":false,
	//               "health":184, "healthMax":220,
	//               "relHas":true, "rank":1, "rankLabel":"Friend",
	//               "maras":{ "on":true, "spouse":true, … } },
	//     "outfit":"Merchant Clothes"|null,
	//     "items":[ { "formId":"0x…", "plugin":"x.esp", "name":"Steel Sword",
	//                 "kind":"weapon", "count":1, "outfit":false,
	//                 "favorite":false } ] }
	//
	// `outfit:true` on an item means it belongs to the actor's default outfit,
	// which is why the container may refuse to hand it over.
	//
	// `about` rides along on the SAME call rather than a second one: the card
	// wants the dossier and the worn set at the same moment, and two round
	// trips to one actor is only a second chance to disagree. Health is current
	// vs PERMANENT, so a wounded follower reads as wounded instead of as
	// someone with a small pool.
	//
	// `rank` is the engine RELA rank (-4…+4) and `relHas` says whether a record
	// exists at all — see relationship.h for why those are two facts, not one.
	// `maras` is M.A.R.A.S's marriage state when that mod is installed — see
	// maras.h; absent entirely when it is not.
	//
	// MAIN THREAD ONLY. `reqJson` takes the same optional formId/plugin as
	// Apply, and defaults to the crosshair target the same way.
	std::string EquippedJson(const std::string& reqJson);
}
