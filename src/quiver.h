#pragma once

#include <string>

// Quiver — the ammo radial (Rober, 2026-08-15: "fully customizable, sortable
// and searchable element, inherits from the wheel menu but its own cool
// visual identity, populates with arrows and bolts automatically, favorites /
// categories show damage. Poisons, effects on arrows").
//
// The C++ half is deliberately thin: enumerate every arrow and bolt the
// player carries (damage, count, poison, enchant description, explosion),
// equip one, and round-trip the view-owned prefs blob. All the identity —
// the ring, the hub, the search — lives in view/HotkeyDeck/hd-quiver.js.
//
// THREADING: ListJson and UseJson read the ENGINE (inventory walk, equip
// manager) — main thread only; the bridge handlers in main.cpp AddTask, the
// same contract as the Potion Browser's pb* trio.
namespace Quiver
{
	// {rows:[…], launcher:{…}, prefs:{…}} — every arrow/bolt carried, the
	// equipped bow/crossbow (and ITS poison — that is where vanilla poison
	// actually lives), and the persisted browser prefs.
	//
	// Every row carries `icon` — "icons/items/<file>.png" when that ammo's
	// mesh render ALREADY exists on disk, else "". That is the fdWorn
	// first-paint idiom, and it is what makes the renders feel remembered:
	// ItemIcons keeps them render-once-keep-forever across sessions, so an
	// arrow rendered last week must paint on the FIRST frame of the ring
	// rather than after a 650 ms settle plus a wdItemIcons round-trip (Rober,
	// 2026-08-16: "it just takes time to load... It needs to be persistent").
	//
	// `iconItemsOut`, when non-null, receives {items:[{formId,plugin,name},…]}
	// for every carried ammo with a plugin identity — hand it straight to
	// ItemIcons::EnsureIconsForList so the renders the ring is still missing
	// start queueing the instant the quiver opens, not when the view asks.
	// Empty string when there is nothing to render.
	std::string ListJson(std::string* iconItemsOut = nullptr);

	// {plugin, formId, rt} -> equip that ammo (toggle if it is the one
	// already nocked). Answers {ok, msg, plugin, formId, equipped}.
	std::string UseJson(const std::string& payload);

	// Merge the view's prefs blob ({sort, cat, ring, favs[…]} today — the
	// view owns the schema) into Data/SKSE/Plugins/HotkeyDeck/quiver.json.
	std::string SaveJson(const std::string& payload);
}
