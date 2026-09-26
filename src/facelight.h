#pragma once

#include <string>

// Better FaceLight Redux (ENB) bridge — "Better Face Lighting - ENB Light.esp",
// Nexus 69397. Reads the TRUE per-NPC facelight state straight off the actor
// (the SPID-distributed applicator ability + the 0..6 light-level abilities its
// script adds) and offers native on / off / re-light. Re-light is the fix for
// the mod's known flakiness: a cell change strips magic-effect FX art, so the
// ability stays "on" while the ENB light mesh is gone — removing and re-adding
// the applicator re-runs its OnEffectStart and re-attaches the light.
namespace Facelight
{
	struct Snapshot { std::uint32_t levels = 0; bool applicator = false; };
	// Runtime-only scene undo, captured natively, never accepted from the wire.
	bool Capture(std::uint32_t formId, Snapshot& out);
	bool Restore(std::uint32_t formId, const Snapshot& before);
	// Is the ESP in the load order (load-order presence, not file existence)?
	bool Present();

	// Per-actor state as JSON (reply "bflState"). formId is the runtime id the
	// quick card snapshotted. Main thread only.
	std::string StateJson(std::uint32_t formId);

	// op: "on" | "off" | "relight". Main thread only. Returns a {ok,msg,...}
	// reply ("bflResult"). "relight" schedules its re-add ~1.2 s later and the
	// view re-asks for state after that beat.
	std::string Apply(std::uint32_t formId, const std::string& op);
}
