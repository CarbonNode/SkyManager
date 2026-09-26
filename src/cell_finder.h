#pragma once

#include <string>

/*
 * Cell Finder — the Finder's third roster (Rober, 2026-09-20: "any idea if we
 * can add a new pill for 'cells' and look for cells?").
 *
 * The NPC Finder's structural twin, one rung simpler: one in-memory index over
 * interiors, named exterior cells and map markers, one search bar over it, and
 * one verb — travel.
 *
 * Three facts make this cheap, and they are the reason this module exists at
 * all rather than a "places" database:
 *
 *  - TESDataHandler::interiorCells is the WHOLE list, at boot, with nothing
 *    loaded. Exterior cells are NOT in it (they live per-worldspace in
 *    TESWorldSpace::cellMap). Named exterior cells come from the editor-ID
 *    map; map markers come from each worldspace's persistent references.
 *    Unnamed exterior grid squares are not searchable destinations.
 *  - A cell keeps BOTH its full name and its EDITOR ID at runtime
 *    (TESObjectCELL overrides GetFormEditorID) — which matters because most
 *    modded dungeon cells have no full name at all, and the editor id is the
 *    only handle a player can search them by. Both are indexed.
 *  - `coc <EditorID>` is the engine's own travel-to-a-cell, and it is the ONLY
 *    thing that works for a cell we have never visited: MoveTo needs a
 *    destination reference, and an unloaded interior has no position we could
 *    aim one at (the Domains recall marker can only re-aim at a place already
 *    marked). So travel dispatches through ConsoleActions::Fire — the deck's
 *    play-proven console verb — and a cell with NO editor id honestly refuses
 *    rather than pretending. Map markers already supply a destination
 *    reference, so they use player.moveto instead of inventing a cell ID.
 *
 * Threading contract, exactly NpcFinder's: every function here touches engine
 * structures (the cell array, names, the console script factory) and must be
 * called from an SKSE task on the main thread. No locks of its own.
 */
namespace CellFinder
{
	// {"phase":"ready","count":N,"pageSize":N,"plugins":[{n,c,k,l}]} — first call
	// builds the index (logged with timing). `pageSize` is the persisted page
	// size (1..100) the view restores; an old view ignores it.
	std::string StateJson();

	// {"q","type":"all|coc|markers|named|unnamed","plugin","seq","offset","limit"} ->
	// {"seq","total","offset","items":[{id,n,e,p,loc,pub,wt,tv,wn,ext?,mk?,mt?,vis?,dis?}]}
	//   ext = a named EXTERIOR cell (loc = its worldspace); mk = a MAP MARKER
	//   (2026-09-21: Bannermist Tower has no interior, only a marker — travel is
	//   player.moveto the marker ref, mt its kind, vis discovered, dis not enabled)
	//   id  = "Plugin.esp|HEX6"  (durable identity, the deck idiom)
	//   n   = full name, "" for the many interiors that have none
	//   e   = cell editor id (empty cells cannot COC; markers travel by ref)
	//   loc = owning location's name, "" when the cell declares none
	//   pub/wt/tv/wn = public area / has water / can fast-travel out of /
	//                  warns you to leave (the four DATA flags worth showing)
	//
	// DETAIL PATH (the NpcFinder idiom): a request carrying
	// "detail":"Plugin.esp|HEX6" is answered NOT as a page but as a per-cell
	// block through the SAME cxResultData reply — {seq, detail:"<id>", info} —
	// so no extra main.cpp listener exists. info carries the LIVE facts the
	// index walk deliberately does not touch for 20,000 cells: owner, whether
	// the cell is attached right now, and whether you are standing in it.
	std::string QueryJson(const std::string& req);

	// {"act":"go","id":"Plugin.esp|HEX6"} -> {ok,msg,act,found}
	// Like NpcFinder's goto this only RESOLVES: found=true means the caller
	// (main.cpp) should close the palette and call ExecuteTravel; found=false
	// carries the honest refusal for the still-open pane.
	std::string ActJson(const std::string& req);

	// The physical half of "go", called after ClosePalette(). Re-resolves
	// (cheap) and runs coc or player.moveto; returns the notification text.
	std::string ExecuteTravel(const std::string& req);

	// {"pageSize"?} -> {ok, pageSize}. Persists the page size to the module's
	// own sidecar (Data/SKSE/Plugins/HotkeyDeck/cell-finder.json) — the
	// ItemExplorer / NpcFinder precedent, deliberately NOT a hotkeys.json
	// slice. Unknown keys already in the sidecar survive. Bridge: cxSave ->
	// cxSaved.
	std::string SaveJson(const std::string& req);
}
