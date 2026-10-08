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
 *
 * A FIFTH wedge, Tarnished (id 4, Rober 2026-10-07: "what about a new stance?
 * With elden ring as an icon"), appears when TarnishedStance.esp is loaded. It
 * is not a Stances NG stance — that DLL knows three — but it is the same shape:
 * an ability on the player (TarnishedStance.esp 0x801, effect 0x800), entered
 * from Stances NG's Neutral, which its own Neutral key reaches when bound. Its
 * Elden Ring movesets are the OAR mod "Stances NG - Tarnished"
 * (modding/tarnished-stance/, scripts/rig/elden-stance/build_tarnished.py).
 * A Stances NG key pressed while in Tarnished wins, and the leftover ability is
 * dropped the next time the wheel reads state.
 *
 * Stance state is never persisted. The wheel's own two settings (how much
 * time slows while it is up, and how big it draws) live in the module's own
 * sidecar, Data/SKSE/Plugins/HotkeyDeck/stance-wheel.json — not a hotkeys.json
 * slice, so OnJsSave's wholesale replace cannot eat them.
 */
namespace StanceWheel
{
	// True when StancesNG.esp is loaded and its CurrentStance global resolves.
	// `why` gets a one-line, player-facing reason when it is not.
	bool Available(std::string& why);

	// True when TarnishedStance.esp is loaded (its ability resolves).
	bool TarnishedAvailable();

	// MAIN THREAD. {"ok":bool,"size":vh,"slow":mult,"current":0-4|-1,"stances":[{id,name,key}],
	//               "tarnished":bool,"cycling":bool,"expansion":bool,
	//               "icons":{bear,wolf,hawk,tarnished},
	//               "hand":"melee"|"ranged"|"magic","msg":"…"}
	// `key` is the stance's binding as Stances NG will match it ("Shift + X"),
	// or "" when that stance has no key (Neutral is optional in Stances NG).
	std::string StateJson();

	// MAIN THREAD. Switch to `stance` (0-3) by pressing Stances NG's own key on
	// a worker thread, then verify ~0.4 s later against the CurrentStance
	// global and say so only when it did NOT take. Call it AFTER the wheel has
	// released focus and restored time — the key must land in a running world
	// with no menu in the way. 4 = Tarnished: Neutral first (its key, or Stances
	// NG's own three Neutral steps when that key is unbound), then the ability.
	// Leaving Tarnished removes the ability before any key. Returns a log line.
	std::string Pick(int stance);

	// Copy Combat Expansion's own bear/wolf/hawk PNGs into the deck view's
	// icons/sh/ folder (stance-ngce-*.png), and Tarnished's glyph from its own
	// mod (stance-tarnished.png), so the wheel can show them. Pure
	// file I/O on a detached thread; call once at kDataLoaded. icons/sh is
	// where runtime-derived third-party art lives: it exists at install time
	// (the MO2 VFS law) and every release EXCLUDES it, so this art is never
	// redistributed.
	void MirrorIconsAsync();

	// ---- settings (2026-10-08, Rober: "in UI elements, no stance bar options?
	// configuration?") --------------------------------------------------------
	// slow   = the world time multiplier while the wheel is up. Clamped to
	//          0.05 .. 1.0 and NEVER zero: anything waiting on game time must
	//          keep ticking (the smooth-pause lesson, main.cpp kFrozenMult).
	// sizeVh = the wheel's diameter in vh, 40 .. 80. The view caps it in px.
	struct Options
	{
		float slow = 0.2f;
		int   sizeVh = 64;
	};
	// Cached; reads the sidecar on first use. Any thread.
	Options GetOptions();
	// Merge {"slow":number,"size":number} (either may be absent; {"reset":true}
	// restores both defaults), clamp, persist, and return OptionsJson().
	std::string SetOptions(const std::string& requestJson);
	// {"slow":0.2,"size":64,"defSlow":0.2,"defSize":64,"minSlow":0.05,
	//  "maxSlow":1.0,"minSize":40,"maxSize":80}
	std::string OptionsJson();
}
