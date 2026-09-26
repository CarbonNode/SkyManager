#pragma once

#include <string>

/*
 * MCM Settings browser — every MCM Helper setting in the load order, read, and
 * the ones that are GLOBALS writable.
 *
 * Rober, 2026-09-14: "What about capturing mcm settings as well in a config
 * settings popout?" → then "get it all in".
 *
 * ── Where the data comes from ────────────────────────────────────────────
 * The same three files the Keys tab already parses for keymaps (keys_scan.cpp),
 * read here for CONTROLS instead:
 *
 *   Data/MCM/Config/<mod>/config.json      the menu definition: pages, and per
 *                                          control a `valueOptions.sourceType`
 *   Data/MCM/Config/<mod>/settings.ini     the mod's shipped defaults
 *   Data/MCM/Settings/<mod>.ini            the player's saved values (these win)
 *   Data/Interface/Translations/<mod>_ENGLISH.txt   the $labels
 *
 * ── What is readable, and what is WRITABLE — the honest split ────────────
 * MCM Helper backs a control with one of several source types, and they are
 * emphatically not equivalent:
 *
 *   GlobalValue      → a TESGlobal. Read live from the engine, and WRITABLE:
 *                      setting it is exactly what the MCM itself does.
 *   ModSettingBool/  → MCM Helper's own ini-backed store. Read from the ini
 *   Int/Float          overlay. NOT written here: the value lives in a file the
 *                      running game has already cached, so a write would look
 *                      like it took and would not be seen by the mod until a
 *                      reload — worse than refusing.
 *   PropertyValue*   → a live Papyrus property on the mod's own script. Neither
 *                      read nor written: reaching it means a VM call per control
 *                      on a 100-MCM load order, and a wrong guess about the
 *                      property's owner writes into someone else's script.
 *
 * Anything not readable is reported with `readable:false` and a reason, so the
 * popout can show the control greyed with an explanation instead of inventing a
 * value or hiding the setting.
 *
 * Threading, and why it is split in two: Scan() parses ~100 config.json + ini
 * + translation files on a busy load order and touches NO engine state, so it
 * runs on a worker thread. StateJson()/ValuesJson()/Set() read or write engine
 * globals and MUST be on the main thread (the SKSE task contract every other
 * module here follows). Calling StateJson without a prior Scan still works —
 * it scans inline — but that is the hitching path and main.cpp does not use it.
 */
namespace McmSettings
{
	// Parse every MCM config from disk into the cache. Filesystem only —
	// safe (and intended) to call from a worker thread.
	void Scan(bool force);

	// {"mods":[{"id","name","pages":[{"name","rows":[
	//    {"i",            index, stable within this scan
	//     "label","type","source","setting",
	//     "readable":bool,"writable":bool,"why":"...",
	//     "value":num|bool,"min","max","step","options":[...]}
	//  ]}]}], "count":N}
	// First call builds the index; `force` re-reads it from disk.
	std::string StateJson(bool force);

	// Fresh values only, for a repaint without re-parsing every config.
	std::string ValuesJson();

	// {"act":"set","mod":"<id>","i":N,"value":num} -> {ok,msg,value}
	// Refuses anything that is not a GlobalValue, with the reason.
	std::string Set(const std::string& req);
}
