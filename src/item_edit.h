#pragma once

#include <string>

// Item Edit — the Finder's "Modify" sheet: PROTEUS-class base-record editing
// (see modding/guides/proteus_item_modification.md for the teardown this is
// built from).
//
// The contract:
//  - Edits are runtime patches on the BASE record: every instance in the world
//    changes, nothing is written to any plugin, and the engine forgets them on
//    relaunch — so the module persists them in its OWN sidecar
//    (Data/SKSE/Plugins/HotkeyDeck/item-edits.json, the item-explorer.json
//    precedent: never a hotkeys.json slice, immune to the OnJsSave
//    wholesale-replace trap) and re-applies at kDataLoaded, once per launch
//    (base records do not reset on a save load, so kPostLoadGame is not
//    needed).
//  - Identity is ALWAYS "Plugin.esp|LOCALHEX" with the file-width-masked local
//    id (the item_explorer idiom, never GetLocalFormID()).
//  - ORIGINAL values are captured at the first edit of each field and kept in
//    the sidecar, so revert is live — no relaunch, unlike PROTEUS.
//  - Threading law is item_explorer's verbatim: every entry point below runs
//    on the SKSE task thread only (main.cpp AddTasks each call); ReapplyAll
//    runs on the main thread inside kDataLoaded. No locks, no concurrency.
//
// Bridge (wired in main.cpp): requests ieGet/ieApply/ieRevert/ieList/ieEnch;
// replies ieGetResult/ieApplyResult/ieRevertResult/ieListResult/ieEnchResult.
namespace ItemEdit
{
	// {id} -> {ok, id, kind, n, plugin, fields:{current display units},
	//          ench:{id,n,charge}|null, orig:{...}|null, edited:[keys]}
	std::string GetJson(const std::string& req);

	// {id, set:{name?,value?,weight?,damage?,crit?,speed?,reach?,stagger?,
	//           armor?,charge?,ench?("Plugin|HEX"|"none")}} — applies to the
	// live form, captures originals, persists, answers like GetJson + msg.
	std::string ApplyJson(const std::string& req);

	// {id} -> restores every captured original, drops the entry, persists.
	std::string RevertJson(const std::string& req);

	// -> {edits:[{id,n,p,fields}], count} — for the pane's edited-set chip.
	std::string ListJson();

	// {q, kind:"weap"|"armo"|""} -> {ench:[{id,n,eff}]} — named, resolvable
	// enchantments from the load order for the swap picker.
	std::string EnchSearchJson(const std::string& req);

	// Re-apply every persisted edit. Called once per launch at kDataLoaded.
	void ReapplyAll();
}
