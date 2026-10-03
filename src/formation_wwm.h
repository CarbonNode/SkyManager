#pragma once

#include <string>

// Walk With Me — Follower and Companion Pathing System (Nexus 191283,
// hashhbbrown, plugin `Wayfarer.esp`). Current support targets 0.2.2.
//
// Rober explicitly chose WWM to replace FWF on 2026-09-25. The router retains
// the legacy provider for other installations; the rig's opt-in migration
// uses FWF's own rescue before allowing WWM to control travel.
//
// TWO SURFACES, and which one owns what matters:
//
//   • `Data/SKSE/Plugins/Wayfarer.ini` — every tunable, every safety switch,
//     the excluded-plugin list. Legacy 0.15 also exposes per-slot offsets;
//     0.2.2 chooses slots itself. The mod's own menu writes it immediately (its header
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
// The author now publishes Wayfarer_GetInterface's SDK. The verified public
// interface supplies synchronous reads for 0.2.2+. Settings and persistent
// enrollment use the owner's Papyrus natives and close the deck to unpause.
//
// Legacy reads that only the engine can answer (is she managed, how many are in the
// party) come back through the VM asynchronously, so they are CACHED and the
// modal's existing ~700ms re-push after every mutation lands the fresh value —
// the same settle idiom the Items and Finder tabs use. A cold cache reports
// `warming: true` rather than a confident zero.
namespace FormationWwm
{
	// `Wayfarer.esp` present in the load order.
	bool Installed();
	bool SupportsModern();
	// Main-thread only; temporary migration interlock, never writes preferences.
	bool SetRuntimeEnabled(bool enabled);

	// Main-thread only, after a save has loaded. Re-asserts the companions WE
	// enrolled through the public API — Walk With Me's revert callback clears
	// them and no save callback writes them, so without this the walking party
	// empties on every load. Returns how many were re-enrolled.
	int RestoreParty();

	// Order ids, matching the mod's own FormationMode enum and its order wheel:
	// 0 "Find your own pace" (Natural) · 1 "Take the road ahead" (Lead)
	// 2 "Stay by my side" (Companion) · 3 "Watch our backs" (Rear)
	// 4 "Make yourselves at home" (Relax); 0.2.2 adds mode 5 (normal follower AI).
	int ModeCount();

	// Same contracts as the FWF provider — see formation_actions.h.
	std::string StateJson(const std::string& reqJson);
	std::string Apply(const std::string& reqJson);
	std::string Reg(const std::string& reqJson);
	std::string Rescue();
}
