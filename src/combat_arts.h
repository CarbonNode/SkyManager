#pragma once

#include <functional>
#include <string>

// Combat Arts tab — integration with "Ashes of War Weapon Art Via Additional
// Attack" (Nexus SE 100174, "Ashes of War Additional Attack v Items.esp").
//
// The mod ships 74 ARMO "ash" items ("Ashes NN: <Art Name>"), all on the same
// biped slot mask (0x2000000) so the engine auto-swaps: WEARING one ash IS
// having that weapon art (DAR/OAR conditions read the worn keyword). Loot drops
// them via a SPID-injected leveled list — which would silt the player's
// inventory with misc armour pieces. This module keeps the inventory clean:
// an ash that lands in the player's bag is INTERCEPTED (removed + recorded in
// the module's own sidecar, Data/SKSE/Plugins/HotkeyDeck/combat-arts.json),
// and the deck tab is the collection — equip/unequip from there. At any moment
// at most ONE ash item exists in the inventory: the equipped, worn one.
//
// THREADING CONTRACT: StateJson/Act/Save/OnPostLoadGame touch engine
// structures (form arrays, the player's inventory, the equip manager) and this
// module's own state, so main.cpp calls them from SKSE tasks only — one
// thread, no locks. The container-change SINK runs on whatever thread the
// engine fires it from: it does minimal work against a mutex-guarded formId
// set (+ the expected-add suppression counters) and queues an SKSE task for
// the actual remove/notify. PollTick runs on the portal poll worker thread:
// one stat() gate, then a queued task — never an engine call in place.
//
// Bridge (registered in main.cpp): requests caState/caAct/caSave; replies
// caStateResult/caActResult/caSaved — names disjoint per the deck law.

namespace CombatArts
{
	// Build the art index (all 74 ARMOs enumerated from the plugin at runtime —
	// no hardcoded FormIDs), load the sidecar, seed the portal icon bridge
	// file, and register the container-change sink. The sink is registered
	// ONLY when the plugin is present; a missing/disabled plugin stands the
	// whole module down honestly (StateJson reports present:false). Call from
	// kDataLoaded, after LoadConfig.
	void InstallSink();

	// After an intercept/queue-consume lands while the game runs, the module
	// pushes a fresh caStateResult through this hook so an open tab updates
	// live. main.cpp wires it to PushToView("caStateResult", …), which is safe
	// whether or not the deck is open (it no-ops closed). Called on the main
	// thread only.
	void SetStatePush(std::function<void(const std::string&)> push);

	// The adoption sweep: any ash in the player's inventory NOT currently worn
	// is removed + marked collected; a WORN ash is marked collected + recorded
	// as the equipped art and left in place. Reconciles `equipped` against the
	// just-loaded save's truth. Call from kPostLoadGame (main thread); also
	// runs defensively on the first caState of a session.
	void OnPostLoadGame();

	// Full pane state (builds the index on first call if kDataLoaded hasn't):
	// {present, reason?, equipped:"<artId>"|null, collected:int, arts:[{id,
	// num, name, full, owned, count, icon, equipped}]} — ALL arts always
	// listed (owned:false for undiscovered), sorted by num. Also consumes any
	// pending portal icon queue first, so the state it answers is current.
	[[nodiscard]] std::string StateJson();

	// {"op":"equip"|"unequip","id":"<artId>"} -> {ok, msg, id,
	// equipped:"<artId>"|null}. Equip silently adds + force-equips the ash
	// (armor equip works under the paused deck — wardrobe precedent) and
	// removes the previously equipped art back out of the inventory. Refusals
	// are honest sentences ("You haven't found that art yet").
	[[nodiscard]] std::string Act(const std::string& req);

	// {"icons":{"<artId>":"icons/custom/x.png"|null}} — partial, only present
	// keys change (null/"" clears). Persisted into the sidecar's icons map.
	// Reply: {"ok":true,"icons":{…full current map…}}.
	[[nodiscard]] std::string Save(const std::string& req);

	// 1 Hz, from the portal poll worker thread: consume the phone's icon queue
	// (PrismaUI/views/HotkeyDeck/portal-combat-art-icons.json) only when its
	// SIZE differs from the canonical empty queue — one stat(), no parse, no
	// engine call; real work hops to the main thread. Truncate-never-delete,
	// the spell-cat-icons law.
	void PollTick();
}
