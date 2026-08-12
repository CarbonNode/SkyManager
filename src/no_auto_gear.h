#pragma once

#include <cstdint>
#include <string>
#include <vector>

// No Auto-Gear backend for the Hotkey Deck.
//
// The peeve: SPID/SkyPatcher distributor mods hand out cloaks, hoods and
// underwear to NPCs on every save load. On Robere's people this is noise —
// a wife suddenly in a hood, a courtesan in a distributed cloak, sometimes on
// top of an outfit he set. There are two delivery paths and neither has a
// per-NPC "leave this one alone":
//   * SPID   `Item = ...|isHuman+isRegionCold`  — runtime, per actor.
//   * SkyPatcher `filterByOutfits=...formsToAdd=<cloak LL>` — bakes the cloak
//     leveled-list into the vanilla OUTFIT record, so anyone wearing that
//     outfit wears the cloak. A per-NPC SPID keyword cannot touch an outfit edit.
//
// The one lever that beats BOTH paths is at the far end, after the item is
// already worn: a cloak/hood/underwear is just an equipped ARMO whose defining
// plugin is one of the distributor mods. So this subsystem is a watchdog that,
// for each protected NPC in range, strips any worn item whose source plugin is
// on the distributor list. Source-agnostic: it does not care how the piece got
// there.
//
// Why it is safe with OStim + wardrobe cycling (Rober's hard constraints):
//   * It only removes items whose DEFINING PLUGIN is a known gear DISTRIBUTOR.
//     A wardrobe/SOES-NG/NFF outfit piece, or anything OStim equips, is authored
//     by a different plugin, so it is never a target.
//   * Mid-OStim the actor is undressed, so there is nothing to strip.
//   * It never adds, forces or locks an outfit — that stays the Wardrobe's job.
//
// Ownership: the VIEW owns the protected roster, the distributor-plugin list and
// the settings (sent whole via ngSave -> MergeViewSlice). C++ owns nothing
// durable here — the sweep is stateless — so there is no C++-only bookkeeping to
// carry across a merge. Mirrors room_guard / loot_highlight. See ng* bridge in
// main.cpp.
namespace NoAutoGear
{
	// Durable base-form identity — (plugin, local id) resolved through
	// TESDataHandler::LookupForm, ESL-safe via ActorIdentity::LocalIdOf. The base
	// form is the right key: "protect Lydia" means the person, not one reference.
	struct NpcRef
	{
		std::string   plugin;
		std::uint32_t localId = 0;
		std::string   name;  // display only, for the pane

		bool valid() const { return !plugin.empty() && localId != 0; }
	};

	struct Config
	{
		// The protected roster (view-owned). An NPC on this list has distributor
		// gear stripped whenever loaded near the player.
		std::vector<NpcRef> npcs;

		// Which plugins' worn items count as "auto-gear" to strip (view-owned,
		// seeded with the three live distributors on this load order). Matched
		// case-insensitively against a worn item's DEFINING plugin (GetFile(0)).
		std::vector<std::string> plugins = {
			"NPC Underwear Engine.esp",  // NUDE — underwear
			"Cloaks.esp",                // Cloaks of Skyrim — cloaks
			"1nivWICCloaks.esp",         // Winter is Coming — cloaks + hoods
		};

		bool enabled = true;  // master switch
		bool notify  = false; // corner message when a piece is stripped (default off — noisy)

		std::uint32_t tickMs = 5000;  // sweep cadence while the roster is non-empty
	};

	void Init();

	// Persisted slice. ToJson returns a json OBJECT dropped under "noAutoGear";
	// FromJson is what LoadConfig reads back (defensive: clamps, re-seeds an empty
	// plugin list so a stale/blank config still strips the three defaults).
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Apply a VIEW ngSave payload (npcs / plugins / settings). Returns false on an
	// unparseable payload.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg);

	// Payloads pushed to the view.
	std::string OpenJson(const Config& c);   // ngOpen(cfg)
	std::string StateJson(const Config& c);  // ngState({lookingAt, protected?, count})

	// ---- operations (MAIN THREAD ONLY) ----

	// Add / remove the crosshair NPC on the protected roster (toggles). Replies
	// {ok,msg,protected,name}. Strips her gear immediately on protect.
	std::string ToggleCrosshair(Config& cfg);

	// Protect every current teammate/follower in one tap. Replies {ok,msg,added}.
	std::string ProtectParty(Config& cfg);

	// Sweep NOW: strip distributor gear from every protected NPC in range.
	// roomId-less; returns count stripped. Used by the pane's "Sweep now" button.
	std::string SweepNow(Config& cfg);

	// The watchdog. Cheap: early-outs unless enabled with a non-empty roster, then
	// throttles on tickMs internally. Scans loaded actors in range, and for each
	// whose base identity is on the roster, strips worn items from a distributor
	// plugin. Returns false (never mutates cfg — the sweep is stateless). Call on
	// the main thread; caller holds the config lock.
	bool Tick(Config& cfg);

	// Reconcile on save load: one immediate sweep so distributor gear a load just
	// applied is gone before it is seen. Call from kPostLoadGame.
	void OnPostLoadGame(Config& cfg);
}
