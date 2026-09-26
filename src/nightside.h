#pragma once

#include <string>

/*
 * Nightside — the three curses (Rober, 2026-09-14: "new pages / tabs that
 * appear only if you are a werewolf, lich, vampire … You can be all 3 i think
 * (with mods) so allow all 3").
 *
 * ONE deck tab that exists only when the player actually carries at least one
 * of the three conditions, and inside it one lane per condition held:
 *
 *   Blood — vampirism            (vanilla / Dawnguard Vampire Lord / Sacrosanct)
 *   Moon  — lycanthropy          (vanilla Beast Form + the three howls)
 *   Bone  — lichdom              (Undeath — Classical Lichdom)
 *
 * All three can be held at once (that is the whole reason the page is a
 * triptych and not a single state readout), and the tab vanishes entirely
 * when none is held — the `requiresState` gate, the live twin of SYS_TABS'
 * `requires` mod gate.
 *
 * ── Identity is VERIFIED, never guessed ──────────────────────────────────
 * Every FormID below was read out of the real plugins on the rig with
 * tools/dump_records.py on 2026-09-14 (the same never-invent-editor-ids rule
 * the Rooms ring learned the hard way). The table lives in one place,
 * kFormTable in the .cpp, so a wrong id is one line and not a hunt.
 *
 * ── The verbs are the deck's OWN, not new ones ───────────────────────────
 * Transforming is CASTING A POWER — Beast Form, Vampire Lord and Undeath's
 * Lich Transformation are all voice-slot powers — so every button here
 * dispatches through SpellActions::Cast, which already does the voice-slot
 * road correctly (select into the power slot, press the game's own mapped
 * Shout key, so cooldown/animation/perks all run for real). This module
 * resolves and reports; it never reimplements a transformation. Same law as
 * the party-order actions and the Mounts tab.
 *
 * ── Honesty rules baked in ───────────────────────────────────────────────
 *  · A condition whose backing plugin is absent is simply not a lane — never
 *    a lane full of dead buttons.
 *  · A power the player does not know is reported `known:false` and drawn
 *    dimmed with the reason, never silently dropped (the kit is also a map of
 *    what you have yet to earn).
 *  · Anything the engine cannot tell us (vanilla's once-a-day Beast Form
 *    counter lives in a Papyrus quest variable) is reported as unknown rather
 *    than invented.
 *
 * Threading: every function here reads live engine state (player actor, race,
 * active effect list, calendar, sky) and MUST be called from an SKSE task on
 * the main thread — the NpcFinder/Mounts contract. Nothing here is cached
 * across calls on purpose: which curses you hold is exactly the kind of fact
 * that changes mid-session.
 */
namespace Nightside
{
	// Cheap gate, rebuilt on EVERY hdOpen (never cached — you can be bitten
	// between two presses of F7):
	//   {"any":bool,"vampire":bool,"werewolf":bool,"lich":bool,
	//    "awake":["vampire",...]}
	// `any` is what hides or shows the tab.
	std::string GateJson();

	// The whole triptych — one entry per condition HELD, plus the shared
	// world facts the lanes read from (sun, moon, hour):
	//   {"any":bool,"sun":{...},"forms":[{id,name,lane,held,awake,source,
	//    race,state,stage:{n,of,label}|null,vitals:[{k,v,tone}],
	//    primary:{...}|null,revert:{...}|null,
	//    kit:[{name,plugin,localId,formId,slot,known,fxRem,fxDur,note}]}]}
	std::string StateJson();

	// {"act":"cast","plugin":"...","localId":N,"formId":N}  -> {ok,found,msg}
	// Resolve only: found=true means main.cpp closes the palette and calls
	// ExecuteAction, exactly like the Mounts tab's ride/goto.
	std::string ActJson(const std::string& req);

	// The physical half (the cast), after ClosePalette(). Returns the
	// notification text, or "" when it notified on its own.
	std::string ExecuteAction(const std::string& req);
}
