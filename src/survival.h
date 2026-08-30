#pragma once

// Survival — the camp-and-needs popout (Rober, 2026-08-15: "a tent menu popup
// (tentapalooza) and campfire, maybe extended even more but some sort of like
// survival menu - with like submenus for tents, waterskins, other stuff from
// campfire / tentapalooza, searchable, nice").
//
// WHAT IT IS: one searchable list of the survival gear you are ACTUALLY
// CARRYING, grouped into sections — Camp (tents / fire / cooking / shelter /
// light, from the Campfire family), Water, Food, Drink — with one obvious verb
// per row. It is the inventory-side twin of the Settlement tab: that tab
// browses every placeable the LOAD ORDER ships, this one is what is in your
// pack right now, which is what you want when it is dark and snowing.
//
// IT IMPLEMENTS NO MECHANICS, by design and by law (the Hotbar precedent):
//   * camp gear places through Settlement::ExecuteAct's "campplace" — i.e.
//     Campfire's OWN equip flow, so its placement controls, its perks and its
//     survival integrations all behave exactly as the mod intends;
//   * water / food / drink are consumed with the same EquipObject the wheel and
//     the smart buttons use, so SunHelm's own OnEquipped hooks run.
// Nothing here re-implements a mod's rules; it only finds and fires.
//
// SECTIONS ARE DERIVED, NOT CONFIGURED: membership comes from the shared
// classifier (Hotbar::ClassifyConsumable, which already knows SunHelm's water
// forms) and from the Campfire-family plugin list + subcategory buckets the
// Settlement tab already maintains. A new camp mod added to that list appears
// here the same day, with no edit to this file.
//
// THREADING: every entry point reads/mutates engine state, so main.cpp calls
// them from SKSE tasks only — one thread, no locks.
//
// Bridge (registered in main.cpp): requests svState/svAct; replies
// svStateResult/svActResult. Renders reuse the shared whIcons route.

#include <string>

namespace Survival
{
	// {ok, camp:{present,tentapalooza,unleashed,hunterborn}, water:{present},
	//  sections:[{id, label, hint, rows:[{id,name,count,kind,sub,verb,detail}]}]}
	//
	// `id` is the durable "Plugin.esp|0AB12C" the whole deck uses, so the view
	// can ask the icon route for art with the same key every other tile uses.
	// `verb` is what the row's button does: "camp" (place through Campfire) or
	// "use" (eat / drink). A section with no rows is still returned, carrying
	// the honest hint that says why it is empty.
	[[nodiscard]] std::string StateJson();

	// The Survival TAB's card arrangement — which cards are on, their order and
	// their size. Stored in its OWN sidecar (Data/SKSE/Plugins/HotkeyDeck/
	// survival.json, the item-explorer precedent) rather than a hotkeys.json
	// slice, so it can never be eaten by the whole-config round-trip that has
	// now swallowed two slices. The payload is OPAQUE to C++: the view owns the
	// schema, C++ owns the file.
	[[nodiscard]] std::string LayoutJson();
	[[nodiscard]] std::string SaveLayout(const std::string& req);

	// {id, verb} -> {ok, msg, close}. `close` asks the view to shut the popout
	// after the act: placing camp gear hands control to Campfire's own placement
	// UI, which cannot work under a paused menu.
	[[nodiscard]] std::string ActJson(const std::string& req);
}
