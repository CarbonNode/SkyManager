#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "json.hpp"

// SPID Gear — the F7 card's "container → SPID mod" pipeline (Rober, 2026-08-09:
// "a new button that opens a container, anything I put in that container then
// gets created into a SPID mod, on reload applies to their inventory").
//
// Shape: the deck opens an INBOX chest (a session-placed vanilla UnownedChest,
// parked out of sight). Whatever the player puts in is recorded as a per-NPC
// grant — (item plugin, local id, count, chance%) keyed by the NPC's ActorBase
// durable identity — and every physical item is handed straight back to the
// player: the chest holds nothing between uses, so there is no chest state to
// corrupt. The grant list is then serialised as real SPID lines into
// Data/HotkeyDeckGear_DISTR.ini, which lands in MO2's Overwrite and is read by
// Spell Perk Item Distributor on the NEXT game launch. Additive by
// construction: SPID Item lines only ever ADD to an NPC's inventory.
//
// SPID line grammar (po3's documented 7-field form):
//   Item = 0x<local>~<ItemPlugin>|NONE|0x<local>~<NpcPlugin>|NONE|NONE|<count>|<chance>
namespace SpidGear
{
	struct Item
	{
		std::string   plugin;      // item's defining plugin
		std::uint32_t localId = 0; // item's local form id in that plugin
		std::string   name;        // display name at record time (for the card)
		int           count = 1;
		int           chance = 100; // SPID per-line chance, 1..100
		std::string   when;         // date the grant was recorded ("2026-08-09") — the
		                            // manager modal's history column
		// Off = kept in the list but NOT written into the ini, so the grant
		// stops distributing without being forgotten (Rober, 2026-08-11:
		// "easily trackable… enable or disable etc"). Removal is the
		// destructive verb; this is the reversible one.
		bool          enabled = true;

		bool valid() const { return !plugin.empty() && localId != 0 && count > 0; }
	};

	struct Npc
	{
		std::string   plugin;      // ActorBase defining plugin
		std::uint32_t localId = 0; // ActorBase local form id
		std::string   name;        // display name at record time
		std::vector<Item> items;
		// Her master switch — off suppresses every line in her block without
		// touching the per-item flags, so turning her back on restores exactly
		// what was on before.
		bool          enabled = true;

		bool valid() const { return !plugin.empty() && localId != 0; }
	};

	struct Config
	{
		std::vector<Npc> npcs;
	};

	// Registers the ContainerMenu close sink. `onHarvest` is invoked (via
	// AddTask, so main-thread) when the inbox menu closes with a harvest
	// pending — main.cpp locks its config mutex, calls Harvest(), persists and
	// pushes the results from there.
	void Init(std::function<void()> onHarvest);

	// kPostLoadGame: forget the session chest (a dynamic 0xFF id is remapped
	// across loads and could resolve to something unrelated) and disarm.
	void OnPostLoadGame();

	// Config slice ("spidGear") round-trip.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Grants for the NPC behind a runtime form id (the F7 card's subject).
	// Reply for the sgState receiver. Main thread.
	std::string StateJson(const Config& c, std::uint32_t runtimeFormId);

	// EVERY grant, all NPCs — the manager modal's roster (sgAllState reply).
	std::string AllJson(const Config& c);

	// Open the inbox chest aimed at this NPC. Resolves durable identity, places/
	// re-uses the session chest, raises the transfer menu, arms the harvest.
	// Main thread; the palette must already be closed. Returns a result json.
	std::string OpenInbox(std::uint32_t runtimeFormId);

	// Read the chest, merge its contents into the pending NPC's grant list,
	// hand every item back to the player, re-park the chest. Main thread,
	// caller holds the config lock. Returns a result json for sgResult.
	std::string Harvest(Config& cfg);
	bool        HarvestPending();

	// Runtime form id of the NPC the LAST harvest/open was about — the card
	// asks for fresh state with it after a harvest lands.
	std::uint32_t PendingRuntimeId();

	// Grant mutations from the card. Caller holds the config lock.
	std::string RemoveGrant(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal);
	std::string SetChance(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal, int chance);

	// Reversible on/off — the Wardrobe tab's SPID segment. A disabled grant
	// keeps its row (name, count, chance, date) and simply stops being written
	// into the ini. Caller holds the config lock.
	std::string SetItemEnabled(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal, bool on);
	std::string SetNpcEnabled(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		bool on);

	// Forget every grant for one NPC (the segment's armed ✕). Caller holds the
	// config lock.
	std::string RemoveNpc(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal);

	// Serialise the whole config as SPID lines. Call OUTSIDE the config lock
	// with a snapshot copy (file IO). Always writes — an emptied list must
	// overwrite yesterday's ini or removals silently keep distributing.
	bool WriteIni(const Config& c);
}
