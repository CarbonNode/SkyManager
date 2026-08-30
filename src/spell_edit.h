#pragma once

#include <string>

// Spell Edit — the Spell Crafting tab's "Modify" sub-tab: PROTEUS's spell
// editor (per-effect magnitude / duration / area on any existing spell)
// rebuilt on item_edit.cpp's architecture. Where Spellcraft MAKES spells,
// this REWRITES the ones the load order already ships.
//
// The contract (item_edit's, adapted to per-effect edits):
//  - Edits mutate the spell's OWN Effect items (effectItem.magnitude/
//    duration/area) — never the shared MagicEffect — so only the edited
//    spell changes; other spells using the same base effect are untouched.
//    Exactly PROTEUS's SetNthEffect* semantics.
//  - Base records forget edits on relaunch, so they persist in the module's
//    OWN sidecar (Data/SKSE/Plugins/HotkeyDeck/spell-edits.json), keyed
//    "Plugin.esp|LOCALHEX" (file-width mask), per-effect keys "e<idx>",
//    ORIGINALS captured at first edit -> live revert, replayed once per
//    launch at kDataLoaded.
//  - Threading law is item_explorer's verbatim: every entry point runs on
//    the SKSE task thread only; ReapplyAll runs inside kDataLoaded.
//
// Bridge (wired in main.cpp): requests sxQuery/sxGet/sxApply/sxRevert/sxList;
// replies sxResultData/sxGetResult/sxApplyResult/sxRevertResult/sxListResult.
namespace SpellEdit
{
	// {q, seq} -> {seq, total, spells:[{id,n,type,school,p,effs}]} — search
	// every named, plugin-resolvable spell/power/shout-word the order ships.
	std::string QueryJson(const std::string& req);

	// {id} -> {ok, id, n, plugin, type, cost, effects:[{i,n,mag,dur,area,
	//          school,harm}], orig:{"e0":{...}}|absent, edited:[keys]}
	std::string GetJson(const std::string& req);

	// {id, set:{"e0":{mag?,dur?,area?}, ...}} — applies, captures originals,
	// persists, answers like GetJson + msg.
	std::string ApplyJson(const std::string& req);

	// {id} -> restores every captured original, drops the entry, persists.
	std::string RevertJson(const std::string& req);

	// -> {edits:[{id,n,p,fields}], count} — the edited-set for ✎ chips.
	std::string ListJson();

	// Re-apply every persisted edit. Called once per launch at kDataLoaded.
	void ReapplyAll();
}
