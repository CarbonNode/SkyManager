#pragma once

#include <string>

// "Fixes / Unstuck" — one-click rescues for common heavily-modded-game jank,
// exposed to the Hotkey Deck as fireable "action" entries (device == "action").
// Console-backed: each verb runs a stable console command on the crosshair NPC
// snapshot (NpcActions::TargetFormID) or, for noclip, on the player.
//
// Verbs: "fix-recycle" (recycleactor - rebuild 3D/AI: T-pose/invisible/stuck),
//        "fix-resetai" (re-evaluate AI packages), "fix-calm" (stopcombat +
//        aggression 0), "fix-resurrect" (resurrect 1, keep inventory),
//        "fix-noclip" (tcl - toggle player collision to walk out of geometry).
namespace FixActions
{
	bool IsAction(const std::string& action);
	void Fire(const std::string& action);   // main thread only
}
