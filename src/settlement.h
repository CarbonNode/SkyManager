#pragma once

// Settlement tab — the world-object placer (Rober's ask: place statics,
// furniture, camp gear from a searchable palette; camp integration for
// Campfire / Tentapalooza and hotkey auto-seeding for Campfire + Hunterborn).
//
// The Items tab's structural cousin: one in-memory index over every named,
// placeable world object the load order ships (STAT / MSTT / FURN / CONT /
// ACTI / TREE / FLOR / DOOR / decorative LIGH), one Google-style bar over it,
// per-row Place / Move / Remove, a "My placements" roster for the current
// save, user catalogs (export/import), and a dedicated Campfire category. The
// view owns the bar, pills, catalog rail and Campfire tree; this module owns
// the walk, the matching, the physical placement and the sidecar.
//
// THREADING CONTRACT: every entry point touches engine structures; main.cpp
// calls them from SKSE tasks only — one thread, no locks.
//
// Bridge (registered in main.cpp): requests stState/stQuery/stAct/stSpin/
// stSave/stCat/stPlaced; replies stStateResult/stResultData/stActResult/
// stSaved/stCatResult/stPlacedResult (stSpin pushes no reply). Icon requests
// REUSE the item bridge (whIcons -> hd-item-icons DOM event, icons/items/).

#include <string>

namespace Settlement
{
	// {phase, count, pageSize, plugins:[{n,c,k,l}], campfire:{present,unleashed,
	// tentapalooza}, hunterborn:{present}, catalogs:[{id,name,count}], cats:[…]}.
	// phase is "building" until the index is done, then "ready"; while building
	// it also carries {progress: 0..1, stage: "furniture"} for the view's bar.
	[[nodiscard]] std::string StateJson();

	// The index build, ONE stage per call — returns true when it is finished.
	// The walk is ~3 s on a big load order and runs on the main thread, so doing
	// it in one go froze the game solid the first time the tab opened ("thought
	// i crashed", 2026-08-15). main.cpp pumps this from successive SKSE tasks
	// instead, pushing a fresh StateJson between stages, so the palette stays
	// alive and honest. Callers that need the whole index NOW (a query racing
	// the pump) still get it: StateJson/QueryJson block on the same steps.
	bool BuildIndexStep();

	// True once the index is complete — main.cpp's pump uses it to decide
	// whether a state request can be answered immediately.
	[[nodiscard]] bool IndexReady();

	// {q, type, plugin, cat, seq, offset, limit} -> {seq, total, offset, items:[
	// {id:"Plugin.esp|0AB12C", n, t, p, e, cat}]}. `limit` clamped 1..100
	// (missing -> 60, so DLL and view deploy independently). `e` = edidOnly flag
	// (the row was named by its EditorID, not a FULL name); `t` = kind key.
	[[nodiscard]] std::string QueryJson(const std::string& req);

	// {id, op, mode?} where op ∈ {place, campplace, move, remove, jumpto}. This
	// call RESOLVES only and returns {ok, msg, op, close}. When close=true the
	// caller (main.cpp) closes the palette and runs the PHYSICAL half via
	// ExecuteAct with the world unpaused (the party-orders law). remove is fast
	// but is treated as physical for uniformity.
	[[nodiscard]] std::string ActJson(const std::string& req);

	// The physical half of a place/campplace/move/remove/jumpto, called after
	// ClosePalette() with the world unpaused. Returns the notification text.
	[[nodiscard]] std::string ExecuteAct(const std::string& req);

	// {id} — bake the turntable for one object's render (ItemIcons::CaptureAngles).
	// No reply; the view derives the -aNNN sibling URLs and probes them.
	void Spin(const std::string& req);

	// {pageSize?} -> {ok, pageSize}. Persists to the module's own sidecar
	// (Data/SKSE/Plugins/HotkeyDeck/settlement.json) — NOT a hotkeys.json slice.
	[[nodiscard]] std::string Save(const std::string& req);

	// {op, …} where op ∈ {add, rename, del, reorder, file, unfile, export,
	// import, importscan} -> {ok, …}. Catalogs are named collections of
	// {plugin, local} object identities (durable, never a runtime formId);
	// export/import round-trips a standalone shareable JSON in catalogs/.
	[[nodiscard]] std::string Cat(const std::string& req);

	// "My placements" roster query for the current save. -> {ok, items:[…]}.
	[[nodiscard]] std::string Placed(const std::string& req);

	// At kPostLoadGame: re-resolve every stored placement's ref against the LIVE
	// save and prune anything that belonged to a different save (roster is
	// save-scoped; there is no co-save serializer). MAIN THREAD ONLY.
	void OnPostLoadGame();
}
