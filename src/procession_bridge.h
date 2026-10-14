// Bridge to Royal Procession (palanquins + lockstep bearers) and Royal Retinue
// (escort squads) — our two separate SKSE plugins, modding/royal-procession and
// modding/royal-retinue. Rober, 2026-10-11: "Standalone + deck"; "the army stuff
// make sure to be a separate plugin from the wagon and pole thing".
//
// Same in-process pattern as AnimResolverBridge / FormationWwm: both DLLs are
// already loaded by SKSE, so every call is a GetModuleHandle + GetProcAddress
// away. Each mod is a SOFT dependency on its own: the Procession modal shows a
// section per installed mod and says plainly which one is missing.
//
// Both mods POST their writes to the main thread and answer `true` for
// "queued"; the truth is the next read. So every mutation here is followed by
// a fresh rpxOpen push from main.cpp ~700 ms later, the Formation contract —
// a refused summon shows up as nothing having changed, never as a silent lie.
//
// Sic 'em ("Group N attack!", Rober 2026-10-11): Retinue soldiers are neither
// teammates nor Loadouts members, so they are ordered through
// NpcActions::SicEmActors with the squad's member list, after
// RoyalRetinue_ReleaseSquad (their formation tick would otherwise hold them).
// When an order ends — Disengage / Calm (CancelOrder) or a standing order
// dropping — NpcActions' order-end hook calls RoyalRetinue_RejoinActor, the
// documented contract (modding/royal-retinue/README.md, "Deck-side contract").
//
// Wagons (Royal Procession api 3, 2026-10-12): the lead wagon, its five seats
// (driver's bench + four passengers) and a convoy of up to three. Bound apart
// from the palanquin exports, so an api-2 DLL keeps its palanquin and the
// Wagons tab says it needs updating. The seat picker's people are
// PartyRecall::Roster()'s following rows (its Policy::Basis), cached 5 s.
// RP v3 has no per-wagon unhitch: a follower wagon leaves with ConvoyRemove,
// the lead only with DismissWagons (or by hitching another horse).

#pragma once

#include <string>

namespace ProcessionBridge
{
	// After kDataLoaded: installs the Sic 'em order-end hook. Idempotent.
	void Init();

	bool ProcessionInstalled();
	bool RetinueInstalled();

	// {ok, rp:{installed,api,types,state,wagon:{supported,state},people},
	//  rr:{installed,api,presets,squads}, crosshair:{id,name,horse}|null}.
	// Main thread (both mods' reads are thread-safe snapshots, but the Sic 'em
	// order table this also reports is main-thread only).
	std::string StateJson();

	// One verb: {op:..., ...} -> {ok,msg}. Main thread only. Every id off the
	// wire is validated (slot ranges, preset ids, squad ids from ListSquads,
	// the crosshair actor is loaded) before it reaches either mod.
	std::string Act(const std::string& reqJson);
}
