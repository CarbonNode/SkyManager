#pragma once

#include <string>

// Walk With Me — Follower and Companion Pathing System (Nexus 191283,
// hashhbbrown, plugin `Wayfarer.esp`) — the deck's SECOND formation provider.
//
// It is NOT a replacement for Formation with Followers here: Rober's call
// (2026-09-10) is "no swap, just support for both", so the Formation modal
// hosts one provider per installed mod and the router in formation_actions.cpp
// picks between them. Running BOTH at once is the real footgun — two systems
// rewriting the same followers' travel packages — so the router reports a
// `conflict` when both are live and the modal offers to stand one down.
//
// TWO SURFACES, and which one owns what matters:
//
//   • `Data/SKSE/Plugins/Wayfarer.ini` — every tunable, every safety switch,
//     the excluded-plugin list, and the per-slot Side/Forward offsets for all
//     four formations. The mod's own menu writes it immediately (its header
//     comment says so), so it is the durable truth and we edit it IN PLACE,
//     preserving comments, section order and unknown keys.
//   • The mod's own Papyrus natives, declared in the `Wayfarer.psc` it ships
//     as SOURCE — `SetEnabled` / `GetEnabled` / `SetFormationMode` /
//     `GetFormationMode` / `RegisterFollower` / `UnregisterFollower` /
//     `ExcludeFollower` / `IncludeFollower` / `IsManaged` / `GetManagedCount`
//     / `ReloadSettings`. So this bridge never re-implements pathing: it
//     writes the ini, then makes the mod re-read it, exactly as its own menu
//     does. `ReloadSettings()` IS the live-apply hook.
//
// ⚠ The DLL also exports a C entry point (`Wayfarer_GetInterface`), which
// would be the synchronous route — but the author has published no source and
// no SDK header (checked 2026-09-10), so its struct layout is unknown and
// guessing an ABI is how you crash someone's game. The documented Papyrus API
// is the contract the mod actually ships; use it.
//
// Reads that only the engine can answer (is she managed, how many are in the
// party) come back through the VM asynchronously, so they are CACHED and the
// modal's existing ~700ms re-push after every mutation lands the fresh value —
// the same settle idiom the Items and Finder tabs use. A cold cache reports
// `warming: true` rather than a confident zero.
namespace FormationWwm
{
	// `Wayfarer.esp` present in the load order.
	bool Installed();

	// Order ids, matching the mod's own FormationMode enum and its order wheel:
	// 0 "Find your own pace" (Natural) · 1 "Take the road ahead" (Lead)
	// 2 "Stay by my side" (Companion) · 3 "Watch our backs" (Rear)
	// 4 "Make yourselves at home" (Relax). The wheel's sixth entry, "Return to
	// follower AI", is not a mode — it is SetEnabled(false).
	int ModeCount();

	// Same contracts as the FWF provider — see formation_actions.h.
	std::string StateJson(const std::string& reqJson);
	std::string Apply(const std::string& reqJson);
	std::string Reg(const std::string& reqJson);
	std::string Rescue();
}
