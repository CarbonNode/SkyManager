#pragma once

#include <string>

// ---------------------------------------------------------------------------
// INI-configured SKSE mods in the Mod settings popout (hd-mcm.js).
//
// Rober, 2026-10-12, linking github.com/Kexodus/iharvest-ng: "add support for
// this with skymanager detects add a customization menu" -> option A: a
// settings page that applies on the next launch.
//
// Some DLL-only mods keep their whole configuration in ONE ini under
// Data/SKSE/Plugins/ and offer their own in-game page only through SKSE Menu
// Framework. MCM Helper and SkyUI cannot see them. This module is the third
// source the Mod settings popout lists (src:"ini"), next to MCM Helper
// (mcm_settings) and SkyUI (skyui_mcm): a table of KNOWN mods, each with the
// DLL that proves it is loaded and every key with its own range, so a mod
// appears ONLY when its DLL is in the process. To add another mod, add one
// table entry.
//
// ⚠ NEXT LAUNCH, NOT LIVE. These mods read their ini once at startup and
// export nothing a second plugin could call. IHarvest NG (v1.0.8) applies
// live only from its own SMF page, inside its own DLL. So a write here edits
// the file in place, keeping comments and the order of keys, and the change
// takes effect next launch. Every row carries the value the file held at
// kDataLoaded ("launch"), and the view marks a row whose file value differs as
// changed since this game started. That claim is literally true; "pending"
// would not be, because the mod's own menu may already have applied it live.
//
// A build that re-reads its ini live says so with an export (Mod::liveExport;
// our IHarvest NG build, modding/iharvest-ng, exports IHNG_LiveSettings). Then
// the page drops the launch values, says "live", and also lists the keys only
// that build understands (Key::liveOnly), such as bStopWhenOverEncumbered.
//
// ⚠ IHarvest NG's own menu, when CLOSED after an edit there, rewrites the
// WHOLE ini from its in-memory values (Settings::Save, CSimpleIni). That
// discards any edit made here in the same session. The mod's note says so.
// ---------------------------------------------------------------------------

namespace IniMods
{
	// kDataLoaded: record what each present mod's ini held when the game
	// started. Cheap (a few small files). Safe to call more than once; only
	// the first call counts.
	void SnapshotAtLaunch();

	// -> { ok, mods:[{ id, name, src:"ini", path, dll, smf, smfPage, note, live,
	//      pages:[{ name, rows:[{ i, setting, label, info, type, value,
	//      launch, def, min, max, step, options, writable, why }] }] }] }
	// Only mods whose DLL is loaded are listed. File IO only, no engine
	// calls, so any thread may call it.
	std::string StateJson();

	// { mod, i, value } -> { ok, msg, mod, i, value, launch }
	// value is a number (a toggle sends 0/1, an enum its index). It is clamped
	// to the mod's own range and written in the file's own spelling.
	std::string Set(const std::string& request);
}
