#pragma once

// Keys tab: one registry of every hotkey the load order claims, and who claims
// it. Five sources, merged:
//
//   vanilla  - the LIVE ControlMap (user remaps included), gameplay context
//   deck     - SkyManager's own entry triggers / open keys (provider injected
//              by main.cpp, where the config lives)
//   chord    - Chord Keys chords.json (base+modifiers -> virtual key)
//   helper   - MCM Helper mods: Data/MCM/Config/*/config.json keymaps, values
//              from Config/<mod>/settings.ini overlaid by Settings/<mod>.ini,
//              labels resolved via Interface/Translations/<mod>_ENGLISH.txt
//   mcm      - classic SkyUI MCMs, swept LIVE through SkyUI's own conflict
//              surface: SKI_ConfigManager's registered configs are each asked
//              GetCustomControl(k) for every key/mouse code -- the exact API
//              SkyUI itself uses for its "already used by X" prompt, so the
//              answer matches what MCM believes, display names included.
//
// The sweep is async (Papyrus dispatches, callbacks on the VM thread); the
// view polls kcState while phase != done. Results are cached until the next
// kcScan.

#include <cstdint>
#include <functional>
#include <string>

namespace KeysScan
{
	// One extra binding from the host (deck entries, open keys, hotbar keys).
	struct OwnBinding
	{
		std::string  control;  // display label
		std::uint32_t code;    // DIK scancode
		std::string  modsText; // "" or "Shift+Ctrl" -- display only
	};

	// main.cpp installs this at startup; called at scan time under its own
	// config lock so the registry always reflects the deck's live state.
	void SetOwnKeysProvider(std::function<std::vector<OwnBinding>()> provider);

	// Start a full rescan. Returns false if one is already running.
	bool Start();

	// Progress + (when done) the full registry, as the JS payload for kcState.
	// includeBindings=false while polling keeps the packet small.
	[[nodiscard]] std::string StateJson(bool includeBindings);
}
