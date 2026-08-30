#pragma once

#include <string>

// ============================================================================
//  PARTY SHEET — the whole retinue's gear, vitals and status in ONE payload.
// ============================================================================
//
// Rober, 2026-08-17: "keep polishing adding features we missed from the
// reference mod". The reference is Skyrim Party Sheet (Nexus SSE 167538) and
// the feature it is NAMED after is the one the deck never had: an overview of
// the WHOLE party at once, instead of one follower at a time.
//
// It matters more here than for most players. This playthrough runs a very
// large retinue, and the Followers tab is a ROSTER — it answers "who exists
// and where is she filed". It cannot answer the questions that actually cost
// you a fight:
//
//     who is hurt · who has no weapon · who is wearing nothing ·
//     who is over-encumbered and therefore not keeping up ·
//     who is carrying no arrows for the bow she is holding ·
//     who is parked in an inn three holds away
//
// Those are COMPARISONS. They need every member side by side, which needs one
// snapshot taken at one instant — not twelve card opens, each reading a
// different moment.
//
// ---------------------------------------------------------------- SCOPE ----
// This file is a READER. It changes nothing, ever. Every verb the party sheet
// offers (recruit, dismiss, wait, follow, trade, dress, inspect) already exists
// elsewhere in the deck and is dispatched by the VIEW through the surface that
// owns it — followers-pane's quick card, NffControl, MhiyhControl. A second
// implementation of any of those is the failure mode, not a feature.
//
// ------------------------------------------------------ WHO IS "THE PARTY" --
// The same net main.cpp's HudFollowersJson() casts, and deliberately so: one
// definition of "following you" across the HUD strip, the party bar and this
// sheet, or the three disagree in front of the player.
//
//   IsPlayerTeammate()                     — the engine flag vanilla and NFF set
//   OR in CurrentFollowerFaction 0x0005C84E — what framework-driven companions
//                                             (Nether's Niri, CSV Vayne, CHIM
//                                             soft-follow) set instead; several
//                                             never touch the teammate flag at
//                                             all, and without this half of the
//                                             net they would be invisible here
//                                             while plainly walking behind you.
//
// walked over ProcessLists::highActorHandles, de-duplicated by FormID. The
// caller may also pass explicit runtime FormIDs (`ids`) — the Followers tab
// sends the roster members it believes are following, so somebody the two
// faction tests miss but Follower Organizer knows about is still measured
// rather than silently dropped.
//
// A follower who is NOT LOADED (different worldspace, unattached cell) has no
// actor to read, so she cannot appear. That is reported as a COUNT, never as a
// gap: `unloaded` in the envelope, so the view can say "4 others are too far
// away to read" instead of quietly showing eight people out of twelve.
//
// ------------------------------------------------------------- THE FACTS ----
// Every number below is an engine read. Nothing is remembered, nothing is
// cached across calls, and no value is ever invented — a read that cannot be
// made is absent or flagged, never faked. Notably:
//
//   * hp / mag / sta   cur = GetActorValue, max = GetPermanentActorValue. The
//                      same split follower_tune.cpp and char_sheet.cpp use, so
//                      a wounded follower reads as WOUNDED rather than as
//                      someone with a small pool. ⚠ "Permanent" excludes a
//                      TEMPORARY fortify, so `hp` can exceed `hpMax`; the view
//                      draws the bar against max(cur, max) rather than this
//                      file inventing a total from a modifier read no other
//                      module in the deck has exercised.
//   * armor / phys     `armor` is the raw kDamageResist rating; `phys` is what
//                      that rating BUYS — clamp(rating*0.12 + 3*pieces, 0, 80),
//                      Skyrim's own armour formula. `pieces` counts ONLY worn,
//                      non-clothing head/body/hands/feet, capped at 4, which is
//                      what the engine's +3-per-piece bonus applies to; a
//                      shield, an amulet and two rings would inflate the
//                      percentage by twelve points of a number the player
//                      checks against the vanilla UI. Identical maths to
//                      CharSheet's ResistJson by intent (see the note at the
//                      bottom of this header).
//   * damage           an ESTIMATE, and it says so (`est: true` on the tile).
//                      ⛔ Actor has NO GetDamage()/GetEquippedEntryData() —
//                      both are PlayerCharacter methods, which is exactly why
//                      CharSheet can ask the engine for the player's real
//                      number and this file cannot ask it for a follower. So
//                      the tile carries the game's own published arithmetic,
//                      base * (1 + skill/200) * (1 + fortify/100), with the
//                      nocked arrow folded into `base` for a bow. What it
//                      cannot see is the TEMPER on that particular sword, so a
//                      tempered blade reads low — stated, not silent. An empty
//                      hand is not zero damage either: `unarmed` is flagged and
//                      `unarmedDamage` carries kUnarmedDamage.
//   * ammo             the worn TESAmmo out of the inventory-changes walk.
//                      Actor has no GetCurrentAmmo() (PlayerCharacter again),
//                      and the worn entry is the only answer for a follower —
//                      which is convenient, because the guarded walk is already
//                      standing in front of it.
//   * load / carry     load = GetWeightInContainer() (the engine's own cached
//                      figure, the number the vanilla HUD bar draws); carry =
//                      the kCarryWeight actor value, buffs included. No walk.
//   * waiting          kWaitingForPlayer >= 0.5, which is what
//                      follower_frameworks.cpp reads to decide whether a "wait"
//                      order would be a no-op. Someone told to wait is still
//                      `following` as far as the engine is concerned, so
//                      without this the person at your back and the one parked
//                      in an inn look identical.
//
// ------------------------------------------------- WHAT IS NOT DECIDED HERE --
// ⛔ NO VERDICTS. This file never says "she is under-geared" or "that is a
// problem". It ships facts; followers-pane.js turns them into the issue chips.
// That split is deliberate and load-bearing: a threshold ("hurt below 50%",
// "no potions is worth a warning") is a JUDGEMENT that Rober will want to
// retune, and a judgement baked into the DLL costs a rebuild + a game exit to
// change. In the view it is a text edit.
//
// Two consequences worth stating, because they look like omissions:
//   * a SUMMON is FLAGGED (`summon`), never dropped. A conjured familiar is a
//     teammate, and grading one for owning no boots is nonsense — but which way
//     that should go is a preference, so the view hides them by default and can
//     offer them back without a rebuild.
//   * there is no "downed" flag. ActorState::IsBleedingOut() is the right call
//     and the reference mod uses it, but nothing in this plugin has ever
//     compiled against it and this change cannot be built here, so it is left
//     out rather than guessed at. The view infers a critical state from the
//     health fraction instead — honest, and only slightly coarser. Adding the
//     real flag later is one line beside the existing `drawn` read.
//
// ------------------------------------------------------------- THREADING ----
// MAIN THREAD ONLY, like every RE:: path in this plugin — schedule via
// SKSE::GetTaskInterface()->AddTask. It walks live actors and their inventory
// changes; neither is safe off the main thread.
//
// Never throws. A missing player, a null ProcessLists, an actor that vanished
// between the handle and the read: all degrade to an honest `ok:false` envelope
// or a missing row, so the tab renders "nobody is with you" instead of taking
// the game down.
//
// ------------------------------------------------------ CRASH DISCIPLINE ----
// The per-actor inventory walk uses the inventory-CHANGES entry list, never
// CommonLib's GetInventory<>() rebuild — the same rule Finance::ReadGold and
// CharSheet's InventoryCounts follow, for the same measured reason (a full
// rebuild faulted inside this DLL on the 4,780-mod profile). It is additionally
// SEH-guarded per actor, so one bad follower costs her own numbers and not the
// scan: her row comes back with `invOk:false` and the view says so.
//
// ---------------------------------------------- DUPLICATED MATHS, ON PURPOSE --
// `phys`, the regen derivation and the equipped-hand read are the same formulas
// CharSheet computes for the PLAYER. They are re-implemented here rather than
// called because char_sheet.cpp keeps all of it in an anonymous namespace — it
// exports only BuildSheetJson/BuildPackListJson/RemoveEffect/ApplyMeta, none of
// which take an arbitrary actor. Extracting them into a shared `stat_math.h`
// is the right refactor and is left as one: it touches char_sheet.cpp, which
// this change deliberately does not. ⚠ If you change a formula in one file,
// change it in the other — the player's sheet and the party sheet disagreeing
// about what an armour rating is worth is a bug the player WILL notice.
namespace PartySheet
{
	// The whole snapshot, as the `ptyData` payload. `reqJson` is the ptyScan
	// request: an object which may carry
	//
	//   { "ids": [ <runtime FormID number>, ... ] }   extra actors to include
	//   { "skills": true }                            include the 18 skill values
	//
	// Both optional; an empty object is a valid request and gives the plain
	// scan without skills (the roster grid does not draw them, so the default
	// keeps 20 members x 18 numbers off the wire until something asks).
	//
	// Shape of the reply — every key always present, so the view never has to
	// distinguish "absent" from "zero":
	//
	//   { ok, msg, count, unloaded, skillNames:[…], members:[ … ] }
	//
	// `unloaded` counts requested `ids` that no live actor answered to.
	// See the .cpp for the per-member key list; it is documented at the one
	// place that writes it.
	//
	// MAIN THREAD ONLY. Never throws.
	std::string BuildPartyJson(const std::string& reqJson);
}
