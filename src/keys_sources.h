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

#include <cstdint>
#include <string>
#include <vector>

namespace KeysSources
{
	struct Row
	{
		std::string   src;      // overlay: enb | reshade | shaders -- generic: plugin
		std::string   mod;      // display name of the owner
		std::string   control;  // what the key does
		std::uint32_t code;     // census space: DIK 1..255, mouse 256+button
		std::string   modsText; // "" or "Ctrl+Shift" -- display only
		bool          guessed;  // true when the code space was assumed, not stated
		std::string   detail;   // provenance: file + setting, shown as the row's title
	};

	// ENB / ReShade / Community Shaders. Missing files are simply "not
	// installed" -- never an error.
	std::vector<Row> ScanOverlays();

	// Every recognisable hotkey setting under Data/SKSE/Plugins. Bounded (see
	// the caps in the .cpp) and best-effort: an unreadable or unparsable file is
	// skipped, never fatal.
	std::vector<Row> ScanPluginConfigs();
}
