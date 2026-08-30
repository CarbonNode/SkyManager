#pragma once

#include <string>

/*
 * NPC Finder — the NPCs tab (Rober, 2026-08-13: "i was wondering if we could
 * build a fast npc finder. Curious too if its possible to use the mesh
 * framework to show an npcs face as the icon?").
 *
 * The Items tab's structural twin: one in-memory index over every NAMED,
 * plugin-resolvable TESNPC in the load order, one Google-style bar over it,
 * and per-row actions that answer honestly. Faces come from the FaceGen head
 * NIF every non-templated NPC ships (meshes/actors/character/facegendata/
 * facegeom/<origin plugin>/<8-hex formid>.nif) rendered through the same
 * Mesh Rendering Framework route the item renders use — see ItemIcons::
 * EnsureFaceIcons. A templated NPC has no face file; the row keeps its glyph.
 *
 * Threading contract, exactly ItemExplorer's: every function here touches
 * engine structures (form arrays, names, ProcessLists, MoveTo) and must be
 * called from an SKSE task on the main thread. No locks of its own.
 */
namespace NpcFinder
{
	// {"phase":"ready","count":N,"mrf":bool,"pageSize":N,"plugins":[{n,c,k,l}]} —
	// first call builds the index (logged with timing). `pageSize` is the persisted
	// Finder page size (1..100) the view restores; an old view ignores it.
	std::string StateJson();

	// {"q","type":"all|uniq|fem|male","plugin","seq","offset","limit"} ->
	// {"seq","total","offset","items":[{id,n,p,r,s,u,e,t,fc,bd}]}
	// `limit` is the view's page size (clamped 1..100); a request WITHOUT it
	// defaults to 60 (pre-pagination behaviour), so an old view keeps working.
	//   id = "Plugin.esp|HEX6"  (durable identity, the deck idiom)
	//   r  = race name, s = "f"|"m", u/e/t = unique/essential/uses-traits-template
	//   fc = "FacePlugin.esp|HEX8" — the FACE-ROOT identity whose facegen file
	//        names the render; "" when the face owner is dynamic/unresolvable
	//        OR when the facegen NIF does not exist on disk (a CREATURE, or a
	//        humanoid whose author never exported a head) — in that case the
	//        head render can never land, so it is blanked and instead:
	//   bd = "SkinPlugin.esp|HEX6" — the SKIN-SOURCE identity (usually the race)
	//        whose body render pictures this CREATURE, "" when no body NIF
	//        resolves AND always "" for a FaceGen-Head (humanoid) race: her
	//        body is the race's naked skin, keyed by the race, so it would be
	//        one shared picture for every facegen-less person of that race —
	//        the pair-of-bare-feet portrait of 2026-08-30. Keyed by skin source
	//        so same-race creatures share one render. Its render is QUEUED as a
	//        side effect of the query (only for the drawn page) and arrives
	//        through the shared icon index.
	//
	// DETAIL PATH (2026-08-15): a request carrying "detail":"Plugin.esp|HEX6"
	// is answered NOT as a page but as a lazy per-NPC detail block through the
	// SAME nxResultData reply — {seq, detail:"<id>", info:{...}} — so no new
	// main.cpp listener is needed. info carries level, race, class, sex,
	// essential/protected/unique, base health/magicka/stamina, the top base
	// skills, combat style, voice type, and factions (name + rank). Read off
	// TESNPC on the main thread only; every access is null-guarded.
	std::string QueryJson(const std::string& req);

	// {"act":"spawn"|"goto"|"bring","id":"Plugin.esp|HEX6"[,"force":bool]}
	//   -> {ok,msg,act,found}
	// "spawn" places a copy at the player and leaves the palette open.
	//
	// SPAWN GUARD (2026-08-18): a UNIQUE NPC whose baked FaceGen file exists on
	// disk cannot be copied faithfully — the sculpt lives in
	// facegeom/<plugin>/<8-hex>.nif keyed to the ORIGINAL record, and a placed
	// copy assembles its head at runtime with nothing to read that from (Rober:
	// Argos came out "a weird headless ghost"). So spawn REFUSES first and
	// answers {ok:false, warn:"faceless", msg, id, name, canBring, face} — the
	// pane turns that into a card offering Bring / Go to. "force":true is the
	// card's "Spawn anyway" and is the only way past it. A non-unique actor
	// (bandit, guard, creature) is never probed and never warns; an
	// inconclusive probe spawns anyway with a caution in the notification —
	// a failed lookup must never make the button useless.
	// "goto"/"bring" only RESOLVE here: found=true means the caller (main.cpp)
	// should close the palette and call ExecuteMove; found=false carries the
	// honest refusal for the still-open pane.
	std::string ActJson(const std::string& req);

	// The physical half of goto/bring, called after ClosePalette(). Re-resolves
	// (cheap) and moves; returns the notification text.
	std::string ExecuteMove(const std::string& req);

	// {"pageSize"?} -> {ok, pageSize}. Persists the Finder page size to the
	// module's own sidecar (Data/SKSE/Plugins/HotkeyDeck/npc-finder.json) — the
	// ItemExplorer::Save twin, deliberately NOT a hotkeys.json slice. Unknown keys
	// already in the sidecar survive (read-only parse). Bridge: nxSave -> nxSaved.
	std::string SaveJson(const std::string& req);

	// The NPC whose facegen files this NPC actually wears: walks the kTraits
	// template chain, then the faceNPC ("face template") chain, bounded.
	// Exported for the Followers tab's default-portrait fallback, so both
	// features name the same PNG for the same face. Never null for a non-null
	// input (an untemplated NPC owns her own face).
	RE::TESNPC* FaceOwnerOf(RE::TESNPC* npc);

	// A creature's BODY render source — the same skin-ARMA biped resolution the
	// Finder uses (Mounts route). Exported so the Followers tab can fall a
	// creature companion back to a body silhouette when no facegen head exists.
	// `outNif` gets the biped model path; the return string is the SKIN-SOURCE
	// identity "Plugin.esp|HEX6" (usually the race, so same-race creatures share
	// one render) or "" when no body model resolves (a humanoid, or a broken
	// skin). MAIN THREAD ONLY.
	std::string BodyRenderFor(RE::TESNPC* npc, std::string& outNif);
}
