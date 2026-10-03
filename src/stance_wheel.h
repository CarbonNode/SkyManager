#pragma once

#include <string>

/*
 * StanceWheel — the engine half of the Stance Wheel (Rober, 2026-10-03: "a
 * popout ui button that slows time shows the stances with their icons as a
 * selector wheel then you select and it closes"), for Stances NG
 * (Nexus 117986) and Stances NG - Combat Expansion (Nexus 193844).
 *
 * The wheel itself is view/HotkeyDeck/hud-stance.js on the HUD view; the
 * open/close/slow-time/Focus runtime lives in main.cpp with the other HUD-view
 * claimants (Sw* beside Td* and Ag*). This module owns only what is about
 * Stances NG itself, and borrows every mechanic from it:
 *
 *   - the CURRENT stance is Stances NG's own CurrentStance global
 *     (StancesNG.esp 0x917: 0 Neutral, 1 Bear, 2 Wolf, 3 Hawk — read out of
 *     its source, mod-data.h / stance-manager.h, Styyx1/StancesSKSE);
 *   - a pick PRESSES STANCES NG'S OWN KEY for that stance, read live from
 *     Data/SKSE/Plugins/StancesNG.toml with StancesNG_custom.toml on top (the
 *     same two files, in the same order, its REX::TOML store loads). The deck
 *     never adds or removes the stance spells itself: Combat Expansion's
 *     hotkey rules ("Keep Neutral while reverted") would be bypassed, and the
 *     deck implements no mechanics it can borrow.
 *
 * Nothing here is persisted; there is no config slice.
 */
namespace StanceWheel
{
	// True when StancesNG.esp is loaded and its CurrentStance global resolves.
	// `why` gets a one-line, player-facing reason when it is not.
	bool Available(std::string& why);

	// MAIN THREAD. {"ok":bool,"current":0-3|-1,"stances":[{id,name,key}],
	//               "cycling":bool,"expansion":bool,"icons":{bear,wolf,hawk},
	//               "hand":"melee"|"ranged"|"magic","msg":"…"}
	// `key` is the stance's binding as Stances NG will match it ("Shift + X"),
	// or "" when that stance has no key (Neutral is optional in Stances NG).
	std::string StateJson();

	// MAIN THREAD. Switch to `stance` (0-3) by pressing Stances NG's own key on
	// a worker thread, then verify ~0.4 s later against the CurrentStance
	// global and say so only when it did NOT take. Call it AFTER the wheel has
	// released focus and restored time — the key must land in a running world
	// with no menu in the way. Returns a log line.
	std::string Pick(int stance);

	// Copy Combat Expansion's own bear/wolf/hawk PNGs into the deck view's
	// icons/sh/ folder (stance-ngce-*.png) so the wheel can show them. Pure
	// file I/O on a detached thread; call once at kDataLoaded. icons/sh is
	// where runtime-derived third-party art lives: it exists at install time
	// (the MO2 VFS law) and every release EXCLUDES it, so this art is never
	// redistributed.
	void MirrorIconsAsync();
}
