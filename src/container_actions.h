#pragma once

#include <cstdint>
#include <string>

// Containers tab backend — Mark a container you're looking at, then remote-open
// its transfer menu from anywhere ("portable storage").
//
// Every function here touches live game state (the crosshair ref, the player,
// cells, the summon marker, the container's own 3D) and therefore MUST be called
// on the main game thread. main.cpp wraps each call in
// SKSE::GetTaskInterface()->AddTask, exactly as it does for PlaceActions /
// NpcActions / SpellActions.
//
// A marked container's durable identity is the (plugin, localFormID) of its
// world reference — the ESL-safe pair, masked and re-resolved through
// TESDataHandler on every load, never a raw runtime FormID (which the engine
// remaps). Its home cell + position + angle are captured too, so a container
// that has to be SUMMONED (its cell isn't loaded, so a direct open can't reach
// it) can be moved to the player, opened, and moved back to exactly where it
// stood. Dynamic (0xFF……) references cannot be persisted and are refused at
// mark time.
namespace ContainerActions
{
	// Register the crosshair sink; resolve nothing else. Call once at kDataLoaded.
	void Init();

	// Snapshot whatever container the crosshair is on RIGHT NOW, caching its
	// identity for TargetJson()/the mark bridge. Called at palette open, the same
	// beat NpcActions::SnapshotTarget() runs — the palette pauses the game, so the
	// crosshair ref is frozen and this is the reliable moment to read it.
	void SnapshotTarget();

	// The container the player was looking at when the palette opened, as the view
	// wants it for the "Mark this container" card and to store on a new mark:
	//   { ok, found, msg?, name, plugin, localId, formId, cellName, cellId,
	//     cellEdid, worldspaceId, worldspaceName, interior, x, y, z, angleZ }
	// found=false (with msg) when the crosshair wasn't on an openable container.
	std::string TargetJson();

	// True when SnapshotTarget() captured an openable, persistent container.
	bool HasTarget();

	// Remote-open a stored container's transfer menu. `markJson` is one mark
	// object in the shape the view holds it (plugin / localId + home cellId /
	// cellEdid / x / y / z / angleZ). Adaptive:
	//   1. resolve the ref through (plugin, localId); a ref whose plugin left the
	//      load order, or that is no longer a container, is a friendly {ok:false}.
	//   2. InitInventoryIfRequired() + OpenContainer(kLoot) in place — no move.
	//   3. one frame later, if no ContainerMenu opened (the ref's cell wasn't
	//      loaded), SUMMON it: MoveTo a marker at the player, open it there, and
	//      move it home the instant the menu closes.
	// Returns {ok, msg}. The caller closes the palette first — the menu has to
	// raise over the live, unpaused world (a paused palette would hold it hostage,
	// the same law NFF's ContainerMenu opens obey).
	std::string OpenContainer(const std::string& markJson);
}
