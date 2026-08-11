#pragma once

#include <cstdint>
#include <string>

// Domains tab backend — Mark & Recall.
//
// Both functions touch live game state (the player actor, cells, the recall
// marker) and therefore MUST be called on the main game thread. main.cpp wraps
// every call in SKSE::GetTaskInterface()->AddTask, exactly like it does for
// NpcActions / SpellActions.
//
// A mark's durable identity is its parent CELL — carried as a raw FormID with
// an editor-id fallback, since cells are addressed through the engine's own
// form table rather than by (plugin, localId) like spells and quests. Position
// and angle are plain floats; the worldspace is display metadata only, because
// MoveTo derives the worldspace from the cell it is handed.
namespace PlaceActions
{
	// Resolve the XMarker base and drop any stale marker handle. Call once at
	// kDataLoaded.
	void Init();

	// Where the player is standing right now:
	//   {ok, msg?, interior, cellId, cellEdid, cellName, worldspaceId,
	//    worldspaceName, x, y, z, angleZ, suggested}
	// `suggested` is the default name for a new mark: the cell's own name, else
	// the worldspace plus its cell-grid coordinates, else the editor id.
	std::string CurrentLocationJson();

	// Teleport the player to a stored mark. `markJson` is one mark object in the
	// shape the view holds it (name / cellId / cellEdid / x / y / z / angleZ).
	// Returns {ok, msg}: an unresolvable cell (its plugin left the load order)
	// is a friendly message, never a crash. The caller closes the palette first
	// — the jump has to land in the live, unpaused world.
	std::string Recall(const std::string& markJson);

	// The "Summon NPC here" roster: current followers first, then nearby loaded
	// actors (within ~8000 units), de-duped, capped at 200. Returns
	//   { "npcs": [ { key, name, follower, dist }, … ] }
	// where `key` is the actor REFERENCE FormID as "0x%08X", `name` is the
	// actor's display name, `follower` is a bool, and `dist` is the integer
	// distance from the player in game units.
	std::string NpcListJson();

	// Move an actor to a stored mark, reusing the one persistent recall marker
	// (so the engine performs the cell attach / worldspace transition). `npcKey`
	// is the actor reference FormID as "0x…"; `markJson` is one mark object in the
	// same shape Recall takes. Returns {ok, name, msg}: a missing/unloaded actor
	// or an unresolvable cell is a friendly {ok:false,…}, never a crash.
	std::string MoveNpcTo(const std::string& npcKey, const std::string& markJson);
}
