#pragma once

#include <string>

// Nether's Follower Framework — HOME BASES, as a deck surface.
//
// NFF lets you register bases ("home bases of operation"): a place a follower
// goes when you dismiss her, optionally with a WORK spot and a RELAX spot she
// uses between the configured hours. Stock NFF exposes all of it only through
// its MCM's Bases page — a single-selection form where the base, the resident
// and the destination base are three separate dropdowns you cycle through.
// This module is the read/write half of the deck's Bases section, so the same
// operations can be done from the Domains tab against a real list.
//
// It is a BRIDGE, never a re-implementation. Every mutation is either
//
//   * NFF's own Papyrus function, dispatched through the VM
//     (SetBaseLocation / ClearBaseLocation / SetFollowerHome on
//     nwsFollowerHomeScript) — so NFF's markers, faction ranks, quest aliases
//     and notifications all happen exactly as they do from its own menu, or
//   * a write to one of its Auto properties (a base's name, a location's
//     label, the "own the cell" switches, the work/relax hour globals) — the
//     same variables its MCM writes.
//
// Reads never call Papyrus: they bind the quest's script object and read the
// property variables synchronously, the posture nff_bridge.cpp established and
// documents at length.
//
// CAPACITY IS READ, NEVER ASSUMED. Stock NFF ships 10 bases; the ESP's
// `maxBases` property is what actually bounds them, and a plugin that raises
// the cap (Rober runs one that takes it to 64) does it by changing that
// property and growing the arrays. So every loop here is bounded by what the
// script reports, and the view renders whatever it is handed.
//
// ⚠ ONE STOCK-SCRIPT BUG THIS FILE ROUTES AROUND. A base's WORK and RELAX "is
// it set" flags are not an array — stock nwsFollowerHomeScript keeps twenty
// scalar properties (nwsWorkLocSet_00..19 / nwsPlayLocSet_00..19) and its
// SetMarkerFlag is an if-chain over them whose FINAL `Else` writes slot 00. So
// asking SetBaseLocation to register a work spot for base 20+ does the right
// MoveTo and then tells NFF that base 1 has one.
//
// Those flags are read by NFF's own MCM page and by NOTHING else — verified
// across its whole script set; what actually drives the follower is the
// MARKER. So above WorkFlagLimit() (which probes how far the installed
// script's properties really go) this file does the half that works — move the
// marker, write the label — and skips the flag write entirely, rather than
// either corrupting another base or refusing a feature that functions. Reads
// follow the same split: below the limit the flag is the truth, above it the
// label array is (NFF writes it on set, blanks it to "None" on clear).
//
// Home locations are unaffected either way: nwsHomeLocSet is a real array, so
// NFF's own functions are correct for every index and are always used.
//
// MAIN THREAD ONLY, like every RE:: path in this plugin.

namespace NffBases
{
	// nbGet -> nbOpen. The whole Bases model: capacity, every registered base
	// with its three locations and its residents, the followers you could
	// assign right now, and the shared tweaks (cell ownership, the work/relax/
	// sleep hour windows).
	//
	//   {
	//     "ok": true, "nff": true,
	//     "maxBases": 64, "maxHomeSlots": 100,
	//     "used": 3, "residents": 11,
	//     "workFlagLimit": 20,        // bases below this may set work/relax
	//     "allowOwner": 1,
	//     "times": { "workStart": 8, "workEnd": 18, "relaxStart": 18,
	//                "relaxEnd": 22, "sleepStart": 22, "sleepEnd": 7 },
	//     "bases": [ { "i": 0, "name": "Pinewatch Lodge",
	//                  "home":  { "set": true,  "label": "Pinewatch Lodge",
	//                             "place": "Pinewatch Lodge", "placed": true },
	//                  "work":  { "set": false, "label": "", "place": "" },
	//                  "relax": { "set": false, "label": "", "place": "" },
	//                  "residents": [ { "formId": "0001A6A1", "name": "Lydia",
	//                                   "dead": false, "following": true } ] } ],
	//     "candidates": [ { "formId": "...", "name": "...", "base": 2 } ],
	//     "target": { "formId": "...", "name": "..." } | null
	//   }
	//
	// `nff:false` (with an empty model) is the honest answer when the mod is
	// absent or no save is loaded — the view shows that, it does not guess.
	std::string StateJson(const std::string& reqJson);

	// nbOp -> nbResult { ok, msg }. One operation per call; `op` selects it:
	//
	//   setLoc   { base, kind:0|1|2, own?:bool, ownBeds?:bool }
	//        Register the player's current spot as this base's home (0), work
	//        (1) or relax (2) location — NFF's own SetBaseLocation, so the
	//        marker moves and its notification fires. `own` claims the cell for
	//        the player and `ownBeds` its beds, the two switches NFF's menu
	//        offers alongside; both are one-shot, exactly as NFF treats them.
	//   clearLoc { base, kind }      kind 0 tears the whole base down
	//                                (NFF's own ClearBaseLocation also unfiles
	//                                every resident of that base).
	//   rename   { base, name }      the base's name.
	//   label    { base, kind, name } that location's label.
	//   assign   { base, formId }    file a follower at a base (also used to
	//                                MOVE a resident: NFF clears the old filing
	//                                first inside SetFollowerHome).
	//   unassign { formId }          send her back to having no base.
	//   visit    { base, kind }      travel the PLAYER to that location.
	//   owner    { on:bool }         NFF's "may bases own things" switch.
	//   time     { which, value }    workStart|workEnd|relaxStart|relaxEnd|
	//                                sleepStart|sleepEnd, 0-23.
	//
	// A refusal is a sentence the view shows verbatim, never a silent no-op:
	// this whole module's failure modes (mod absent, base not set up, work flag
	// out of range, follower not resolvable) are things the player can act on.
	std::string Apply(const std::string& reqJson);

	// True when NFF's home-base script bound this session. Cheap after the
	// first call; the quest scan is cached, the binding is not.
	bool Available();

	// Deck Portal (phone) parity. StateJson() also writes its payload to
	// Data/PrismaUI/views/HotkeyDeck/portal-bases.json (deck -> phone snapshot).
	// ApplyPortalOps() drains portal-bases-ops.json (phone -> deck), replaying
	// each op through Apply(); the main-thread poller calls it once a second,
	// gated on a loaded save. Returns true when anything was applied.
	bool ApplyPortalOps();
}
