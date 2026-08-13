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
// view polls kcState while phase != done.
//
// PERSISTENT CACHE (2026-08-13). The classic MCM sweep is the expensive source:
// a Papyrus GetCustomControl call per key code (1..263) for every registered
// config -- ~28,000 VM calls on a 107-MCM load order. To keep the tab instantly
// useful, each config's sweep result is cached to a save-INDEPENDENT disk
// sidecar (Data/SKSE/Plugins/HotkeyDeck/keys-cache.json) keyed by mod name +
// script-class identity. On Start() we:
//   1. publish the instant sources (ControlMap, MCM Helper, Chord, deck) AND the
//      cached MCM rows immediately -- phase goes to "done" from cache;
//   2. re-sweep every config in the BACKGROUND ("refreshing" phase), replacing a
//      config's cached rows the moment its fresh answer differs -- so an in-game
//      rebind (which lives in the SAVE, not on disk) self-heals within one pass.
// A "Rescan all" (force=true) ignores the cache and does the full blocking sweep.
// Configs that don't answer are remembered as dead and skipped until a forced
// rescan, with an honest "didn't answer" row so they never silently vanish.

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

	// Start a scan. Returns false if one is already running.
	//   force=false : cache-first -- the instant sources plus any cached MCM rows
	//                 are published at once, then a lazy background re-sweep
	//                 refreshes each config in place.
	//   force=true  : "Rescan all" -- ignore the cache, full blocking sweep, and
	//                 re-try dead configs.
	bool Start(bool force = false);

	// Progress + (when done) the full registry, as the JS payload for kcState.
	// includeBindings=false while polling keeps the packet small.
	[[nodiscard]] std::string StateJson(bool includeBindings);
}
