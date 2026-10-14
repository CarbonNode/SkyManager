#pragma once

// The player camera's aim, ONE definition for every feature that needs it.
//
// The camera root is a NiNode like any other: the columns of its world
// rotation are its axes in world space — X right, Y FORWARD, Z up
// (NiMatrix3::GetVectorY; elden-gate/skse/src/gate.cpp reads them the same
// way). Until 2026-10-12 SkyManager used MINUS Z as "forward" — the camera's
// DOWN — in seven places, copied from CommandNPC. Rober caught it through the
// Sic 'em bolt: "shooting spell visual out from back of character", and its
// log said "crosshair at 92-206 units" on every press — the floor under the
// camera, not what he was looking at. The same vector fed Hotbar cast-at-
// crosshair, Room Guard's "can the player see her" cone, the crosshair
// fallback, the longshot and the grab drag.
//
// pch (force-included) provides RE::.
namespace CameraAxes
{
	inline RE::NiPoint3 Forward(const RE::NiTransform& world)
	{
		return { world.rotate.entry[0][1], world.rotate.entry[1][1], world.rotate.entry[2][1] };
	}
}
