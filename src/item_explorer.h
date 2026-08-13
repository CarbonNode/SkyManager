#pragma once

// Items tab — the inline item explorer (Rober, 2026-08-13: "think additemmenu
// but you can just straight up type in a esp or esl name, a mod item name …
// even have it be like set a price for this item - and it takes money").
//
// One in-memory index over every named, obtainable item the load order ships
// (weapons, armour, potions, food, ingredients, books, scrolls, misc, soul
// gems, ammo, keys, carryable lights), each row remembering its owning plugin.
// The view owns the Google-style bar, the pills and merchant mode; this module
// owns the walk, the matching, the add and the gold.
//
// THREADING CONTRACT: every entry point touches engine structures (form
// arrays, names, the player's inventory) and this module's own index, so
// main.cpp calls all of them from SKSE tasks only — one thread, no locks.
//
// Bridge (registered in main.cpp): requests ixState/ixQuery/ixAdd/ixSave;
// replies ixStateResult/ixResultData/ixAddResult/ixSaved — names disjoint per
// the deck law (one name per direction).

#include <string>

namespace ItemExplorer
{
	// Full state for the pane: {phase, count, gold, pay, mult, plugins:[{n,c,k,l}]}.
	// First call walks the load order and builds the index (game is paused under
	// the deck, so the one-time walk is invisible); after that it is a cheap read.
	[[nodiscard]] std::string StateJson();

	// {q, type, plugin, limit, offset, seq} -> {seq, total, offset, items:[
	// {id:"Plugin.esp|0004C4", n, t, v, w, p}]}. Empty q + a plugin = browse
	// that plugin's whole catalogue; tokens must ALL match (name first, owning
	// plugin as a fallback), ranked prefix > word start > substring.
	[[nodiscard]] std::string QueryJson(const std::string& req);

	// {id, count, pay, price} -> {ok, msg, gold}. pay=true checks the player's
	// REAL gold (Gold001) first and refuses honestly when it does not cover the
	// price; the deduction and the add are one task, so no half-bought item.
	[[nodiscard]] std::string Add(const std::string& req);

	// {pay, mult} -> {ok, pay, mult}. Persisted to the module's own sidecar
	// (Data/SKSE/Plugins/HotkeyDeck/item-explorer.json) — deliberately NOT a
	// hotkeys.json slice, so no shared save path is touched (keys-cache.json
	// precedent).
	[[nodiscard]] std::string Save(const std::string& req);
}
