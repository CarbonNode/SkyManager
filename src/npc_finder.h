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
	// {"phase":"ready","count":N,"mrf":bool,"plugins":[{n,c,k,l}]} — first call
	// builds the index (logged with timing).
	std::string StateJson();

	// {"q","type":"all|uniq|fem|male","plugin","seq","offset","limit"} ->
	// {"seq","total","offset","items":[{id,n,p,r,s,u,e,t,fc}]}
	//   id = "Plugin.esp|HEX6"  (durable identity, the deck idiom)
	//   r  = race name, s = "f"|"m", u/e/t = unique/essential/uses-traits-template
	//   fc = "FacePlugin.esp|HEX8" — the FACE-ROOT identity whose facegen file
	//        names the render, "" when the face owner is dynamic/unresolvable.
	std::string QueryJson(const std::string& req);

	// {"act":"spawn"|"goto"|"bring","id":"Plugin.esp|HEX6"} -> {ok,msg,act,found}
	// "spawn" places a copy at the player and leaves the palette open.
	// "goto"/"bring" only RESOLVE here: found=true means the caller (main.cpp)
	// should close the palette and call ExecuteMove; found=false carries the
	// honest refusal for the still-open pane.
	std::string ActJson(const std::string& req);

	// The physical half of goto/bring, called after ClosePalette(). Re-resolves
	// (cheap) and moves; returns the notification text.
	std::string ExecuteMove(const std::string& req);
}
