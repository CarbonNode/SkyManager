#pragma once

#include <string>

/*
 * Places — the searchable teleport (Rober, 2026-09-14: "a quick teleport
 * hotkeyable function … i type in name of area like crystaldrift and it says
 * ok i think you mean coc ______ and then i can teleport to it, needs to work
 * with all cells (and be fast) from mods etc. a searchable cells menu").
 *
 * One in-memory index over EVERY teleportable place the load order ships,
 * built once per session on first use (a few hundred ms, logged), then a
 * per-keystroke query the Omni's `places` provider (hd-places.js) rides as a
 * lazy source — the quests idiom, so the view never holds the whole list:
 *
 *   cells    every TESObjectCELL that kept an editor ID — the game's own
 *            editor-ID map, i.e. exactly what `coc` resolves against, so if a
 *            row is listed `coc` can reach it. Interiors always keep theirs
 *            (mod-added included, ESL included); named exterior cells too.
 *            interiorCells is walked as a belt-and-braces second pass.
 *   markers  every map marker (ExtraMapMarker on a persistent ref) in every
 *            worldspace — Whiterun, Bleak Falls Barrow, a mod's new town. The
 *            exterior answer, since exterior cells rarely carry an editor ID.
 *            Undiscovered and not-yet-enabled markers are listed and flagged,
 *            never hidden: the point is to get there.
 *
 * Teleport is the console's own road, through the same Script runner the
 * console-command entries use: `coc <EditorID>` for a cell, `player.moveto
 * <refid>` for a marker — the row SAYS which, so "I think you mean coc X" is
 * literally what the player reads before Enter.
 *
 * Threading: every function touches engine structures — MAIN THREAD ONLY
 * (call from an SKSE task). No locks of its own beyond the editor-ID map's.
 */
namespace Places
{
	// Drop the index (kDataLoaded / a new game). Rebuilt lazily on next query.
	void Reset();

	// {"q":"crystal","seq":N,"limit":40}
	//   -> {"seq":N,"q":"crystal","total":M,"count":ALL,"rows":[
	//        {"k":"c","e":"CrystaldriftCave01","n":"Crystaldrift Cave","p":"Skyrim.esm"},
	//        {"k":"m","id":"0001B2C3","n":"Crystaldrift Cave","w":"Skyrim","t":"cave","v":true,"d":false} ]}
	// An empty q builds the index and answers with no rows (the warm call).
	std::string QueryJson(const std::string& req);

	// {"kind":"cell","edid":"..."} | {"kind":"marker","id":"HEX8"}
	// Runs the teleport. Call AFTER ClosePalette() — the jump lands in the live
	// world. Returns the HUD line ("" = nothing ran; the reason is logged).
	std::string Go(const std::string& req);
}
