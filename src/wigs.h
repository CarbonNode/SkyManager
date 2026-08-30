#pragma once

// Wigs tab — register a wig mod BY PLUGIN NAME and the tab populates with
// every wig it ships (Rober, 2026-08-15, the Tailor-mod wig flow). A "wig" is
// an ARMO record occupying the hair biped slots — slot 31 (kHair) or slot 41
// (kLongHair) — unless the registered mod's "all" flag is set, in which case
// every named playable ARMO from it counts (some wig packs use odd slots).
//
// Registered mods live in the module's OWN sidecar
// (Data/SKSE/Plugins/HotkeyDeck/wigs.json — item-explorer precedent, NOT a
// hotkeys.json slice, so nothing here can be eaten by the OnJsSave wholesale
// replace). The sidecar's "view" object is an opaque blob owned by the view:
// C++ round-trips it VERBATIM (echoed in wvStateResult, replaced wholesale on
// wvSave) and never reads inside it.
//
// Row identity is the deck's durable ESL-safe form: "Plugin.esp|" + uppercase
// hex of the FILE-WIDTH-MASKED local form id (never GetLocalFormID() — its
// missing null check is the 2026-08-03 CTD; see actor_identity.cpp), resolved
// back via TESDataHandler::LookupForm(local, plugin).
//
// THREADING CONTRACT (item_explorer.h precedent): every entry point touches
// engine structures (form arrays, names, inventories, the equip manager) and
// this module's own index/sidecar state, so main.cpp calls all of them from
// SKSE tasks only — one thread, no locks.
//
// Bridge (registered in main.cpp): requests wvState/wvMods/wvQuery/wvUse/
// wvSave; replies wvStateResult/wvModsData/wvResultData/wvUseResult/wvSaved —
// names disjoint per the deck law (one name per direction).

#include <string>

namespace Wigs
{
	// {} -> { ready:true, mods:[{plugin, present, all, count}], view:<blob> }.
	// One entry per REGISTERED mod, in sidecar order; present=false when the
	// plugin isn't in the load order (the entry is kept, never dropped — a
	// disabled wig pack comes back with its registration intact). count = wigs
	// indexed for that plugin this session (0 when absent). First call builds
	// the index lazily; after that it is a cheap read.
	[[nodiscard]] std::string StateJson();

	// {q?} -> { mods:[{plugin, count, added}] } — every plugin in the load
	// order that ships >=1 named playable hair-slot ARMO, with its wig count
	// (census computed once lazily across the whole ARMO array, cached for the
	// session). q filters case-insensitively on the plugin name. added=true
	// when the plugin is already registered. Feeds the "Add a wig mod" picker.
	[[nodiscard]] std::string ModsJson(const std::string& req);

	// {q?, mod?, ids?:[id], limit?, offset?} -> { total, offset, rows:[{id,
	// plugin, formId:"0x...", name, slot, val, wt}] }. Default: rows across
	// ALL registered mods (name-filtered by q, case-insensitive substring),
	// sorted name asc; mod given: only that plugin. ids given: resolve exactly
	// that list IN ORDER — an unresolvable id (plugin gone / form gone) yields
	// {id, missing:true, name:"", plugin:"..."}, never a silent drop (the
	// favorites/custom-tab law). limit clamped 1..100, default 24.
	[[nodiscard]] std::string QueryJson(const std::string& req);

	// {id, op:"wear"|"strip"|"take", target:"me"|"look"} -> {ok, msg, id, op}.
	// "look" acts on the crosshair NPC snapshotted at palette-open
	// (NpcActions::TargetFormID — the same snapshot every crosshair pane verb
	// uses) and refuses honestly when there is no one there or they are dead.
	// wear: ensure the actor carries >=1 (AddObjectToContainer from the base
	// when they have none), then ActorEquipManager::EquipObject with the
	// wardrobe/zaz-proven flags. strip: UnequipObject. take: +1 to the
	// PLAYER's inventory, no equip.
	[[nodiscard]] std::string UseJson(const std::string& req);

	// {mods:[{plugin, all?}], view:{...}} -> {ok:true}. Replaces the sidecar
	// doc wholesale (mods validated, view blob taken verbatim), persists it,
	// and invalidates the wig index so the next wvState/wvQuery rebuilds
	// against the new registration list.
	[[nodiscard]] std::string SaveJson(const std::string& req);
}
