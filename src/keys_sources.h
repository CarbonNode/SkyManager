#pragma once

// Keys tab, file-based sources: the hotkeys that live in FILES rather than in
// MCM or the engine's ControlMap. keys_scan.cpp owns the census, the async
// sweep and the cache; this module owns "read a config off disk and say what
// key it claims", which is pure filesystem work with no engine or VM state.
//
// Two sources, both cheap enough to be "instant" (rebuilt on every scan):
//
//   overlays - the three renderer overlays that sit OUTSIDE the mod list and
//              are therefore invisible to every other source, yet fight over
//              real keys: ENB (enblocal.ini / enbseries.ini [INPUT]), ReShade
//              (ReShade.ini [INPUT], "vk,ctrl,shift,alt" tuples) and Community
//              Shaders (its SKSE json's *Key fields).
//   plugin   - the generic sweep of Data/SKSE/Plugins/**: modern DLL mods bind
//              their keys in their OWN ini/json/toml and never register an MCM,
//              so before this they were a hole in the census.
//
// ⚠ CODE SPACE is the whole difficulty here, and the reason Row carries
// `guessed`. The census speaks DirectInput scancodes (DIK, mouse = 256+button,
// the space ControlMap and SkyUI use). The overlays speak Windows virtual-key
// codes, which we convert exactly. A generic plugin config states neither: a
// mod reading CommonLib ButtonEvents stores a DIK code, a mod polling
// GetAsyncKeyState stores a VK code, and "68" is a legal value in both (D vs
// F10). Where the setting's own name doesn't say, we assume DIK -- the
// majority convention for SKSE plugins -- and mark the row `guessed` so the
// pane can show it as an ASSUMPTION and refuse to escalate it to a hard
// conflict. Reporting a confident collision between two codes that may not be
// in the same space would be worse than reporting nothing.

//
// ── NAMING (2026-10-11) ─────────────────────────────────────────────────────
// A config that belongs to a DLL registering SKSE Menu Framework pages is
// owned by that mod's SMF SECTION ("Wayfarer.ini" <-> Wayfarer.dll -> "Walk
// With Me"): the name the player sees in the mod's own menu, not its file
// stem. The stem stays on the row as `alias` (searchable, shown in the
// detail line). Matched on the file stem or the first folder under
// SKSE/Plugins against the page DLL's stem, case-insensitively. The map comes
// from SmfIndex on the MAIN thread (KeysScan::Start) and is only read here.
//
// ── WRITING (2026-10-11, keys_write.cpp) ────────────────────────────────────
// Every row carries a `Write`: either the handle SkyManager needs to rewrite
// that one setting in place, or the reason it may not. A row is writable only
// when its code space is KNOWN to be DIK (stated by the setting's name, the
// file's own documentation, or a verified per-mod spec -- never a `guessed`
// row), it is a scalar on one line of an .ini/.toml or a scalar in a .json,
// and the setting appears exactly once in the file. The modifier half is
// writable only when a verified spec names its setting and encoding.

#include <cstdint>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

namespace KeysSources
{
	struct Write
	{
		bool        ok = false;  // SkyManager may rewrite this binding in place
		std::string why;         // when !ok: the reason the pane shows, dimmed
		std::string file;        // the config as the scan spelled it (UTF-8)
		std::string format;      // "ini" (ini/toml line) | "json"
		std::string field;       // ini: "<section lowercased>\x1f<name>"; json: a JSON pointer
		std::string modField;    // the modifier setting, same shape; "" = none known
		std::string modKind;     // "" | "mask" (1 Shift, 2 Ctrl, 4 Alt) | "cm-enum"
		std::string clearValue;  // how the file spells "no key"; "" = it never says
		std::string apply;       // "wwm-reload" | "ppa-reload" | "ppa-self" | "cm-next-launch" | "next-launch"
		std::string stamp;       // fingerprint of the file's bytes when it was read
	};

	struct Row
	{
		std::string   src;      // overlay: enb | reshade | shaders -- generic: plugin
		std::string   mod;      // display name of the owner
		std::string   control;  // what the key does
		std::uint32_t code;     // census space: DIK 1..255, mouse 256+button; 0 = unbound
		std::string   modsText; // "" or "Ctrl+Shift" -- display only
		bool          guessed;  // true when the code space was assumed, not stated
		std::string   detail;   // provenance: file + setting, shown as the row's title
		bool          unbound = false;  // listed with nothing bound (verified specs only)
		std::string   alias;            // the file/folder name when `mod` came from SMF
		Write         write;
		// Structured provenance of a generic `plugin` row (2026-10-11, the Keys
		// tab's "Add to Hotkeys"): the config relative to Data/SKSE/Plugins with
		// '/' separators, the section as the census read it (lowercased; for a
		// json config the trail of parent names joined by " · "), the setting
		// name as written, and the code space used ("dik" / "vk" -- stated only
		// when !guessed). Empty for every other source, and `file` is empty for
		// a json bind found inside an array (no unique address). ReadSetting()
		// below reads exactly this triple back.
		std::string   file = {};
		std::string   section = {};
		std::string   field = {};
		std::string   space = {};
	};

	// Read ONE setting live, with the same parse the census uses, so a row and
	// a later read of it can never disagree. `relFile` is under
	// Data/SKSE/Plugins ('/' or '\\' separators; no "..", no absolute path).
	// False when the file, the section or the setting is not there, or the
	// value is not a whole number. Also false -- with *ambiguous set -- when the
	// setting is there more than once (twice in one ini section, or inside a
	// json array), because which copy the mod obeys is not ours to guess.
	// File IO: call it off the main thread.
	bool ReadSetting(const std::string& relFile, const std::string& section,
		const std::string& field, long& out, bool* ambiguous = nullptr);

	// A raw config value in `space` ("dik" | "vk") as a census code: DIK 1..255,
	// mouse 256+button. 0 = unbound (0 / -1 / 255) or not placeable. `field`
	// is the setting name ("MouseButton = 1" is a mouse index, not a key).
	std::uint32_t CensusCode(long value, const std::string& space, const std::string& field);

	// ENB / ReShade / Community Shaders. Missing files are simply "not
	// installed" -- never an error.
	std::vector<Row> ScanOverlays();

	// Every recognisable hotkey setting under Data/SKSE/Plugins. Bounded (see
	// the caps in the .cpp) and best-effort: an unreadable or unparsable file is
	// skipped, never fatal.
	std::vector<Row> ScanPluginConfigs();

	// The same reading for ONE config (after a write re-reads it). Returns
	// nothing for a file the sweep itself would not read (wrong folder,
	// extension, skipped directory). Any thread.
	std::vector<Row> ScanFile(const std::filesystem::path& file);

	// See NAMING above. Set from the main thread before a scan.
	void SetSmfOwners(std::unordered_map<std::string, std::string> byDllStem);

	// Fingerprint of a config's bytes (size + FNV-1a 64, hex). Shared by the
	// scan and the writer so "changed since the scan" is one definition.
	std::string Stamp(const std::string& bytes);

	// The root every plugin config lives under, as the sweep spells it.
	std::filesystem::path PluginRoot();
}
