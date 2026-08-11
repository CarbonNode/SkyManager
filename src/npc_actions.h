#pragma once

#include <cstdint>
#include <string>

// Native NPC-command actions ported from the CommandNPC plugin, exposed to the
// Hotkey Deck as fireable "action" entries (device == "action"). No keypress is
// synthesized — the deck calls these directly.
//
// Actions: "freeze" (toggle hold-in-place), "sit" (nearest chair/ground),
//          "bed" (nearest bed/ground), "release-all",
//          "grab" (Groovatron-style carry: the NPC rides the camera's look
//          vector until dropped — toggle; sitting/sleeping NPCs are stood up
//          first, and a frozen NPC stays frozen at the new spot).
//
// Freeze / release are pure (Papyrus SetRestrained/SetDontMove + speed 0).
// Sit / bed reuse CommandNPC.esp's CS_FurnQuest Papyrus script when present,
// falling back to a ground-sit if the quest or furniture isn't found.
//
// ⚠ All of the above act on the ACTOR, and an alias-instanced package outranks
// every one of them — which is why a companion driven by her own follower
// framework used to ignore the hold entirely and keep following. Since
// v0.14.1 every hold first runs FollowerFrameworks::Probe() and, when the
// framework is one we know, sends that framework's OWN "wait here" through the
// Papyrus VM; an unrecognised framework gets an on-screen notice instead of a
// fake success. See follower_frameworks.h.
namespace NpcActions
{
	// Register the crosshair-ref event sink. Call once at kDataLoaded.
	void Init();

	// Snapshot the actor currently under the crosshair. Call the instant the
	// palette opens (before the game pauses / cursor menu steals the target),
	// so a later Run() acts on who the player was looking at.
	void SnapshotTarget();

	// FormID of the actor snapshotted by the last SnapshotTarget() (0 = none).
	// Shared with the Quests tab, which reports on whoever you were looking at.
	std::uint32_t TargetFormID();

	// FormID of the NON-actor reference under the crosshair at the last
	// SnapshotTarget() (0 = none) — the dropped sword / book / clutter the
	// player was looking at when the deck opened. Actors never land here (they
	// go to TargetFormID); the item-source banner reads this. Unlike the actor
	// snapshot this takes only the SKSE crosshair ref verbatim — no raycast
	// fallback, because "what mod is THIS from" must never guess at a
	// neighbouring object.
	std::uint32_t ItemRefFormID();

	// Run an action against the snapshotted target. Main thread only.
	// Returns false for an unknown action id.
	bool Run(const std::string& action);

	// The F7 card's 🔍 Debug reveal (Rober's ask, 2026-08-10): the raw truth
	// about one loaded actor — identity + plugins, engine flags (teammate,
	// essential, …), EVERY faction with rank, the follower-framework probe,
	// the quests holding her in aliases, and the package in force. Read-only,
	// main thread only. Built so a wedged follower state (e.g. stuck in NFF's
	// "Disallow Player Interaction" import faction) is readable in-game
	// instead of needing an out-of-game faction dump.
	std::string DebugJson(std::uint32_t formId);

	// True if id is one of our action verbs.
	bool IsAction(const std::string& action);

	// ---- grab drag ("grab" action) --------------------------------------
	// While a drag is active the input sink in main.cpp watches for the drop
	// keys (click / E / Esc / the deck open key) and the wheel, and a poll
	// thread posts one-shot main-thread ticks that keep the carried NPC on
	// the camera's look vector.

	// Is an NPC being carried right now? Safe from any thread.
	bool DragActive();

	// End the drag: release the carry pin, settle the actor with a real
	// MoveTo (engine cell attach), re-evaluate their AI. Main thread only.
	// `reason` is for the log. No-op when no drag is active.
	void DropDrag(const char* reason);

	// Wheel while carrying: pull the NPC closer / push them away.
	// Main thread only.
	void NudgeDragDistance(bool closer);

	// A save load remaps dynamic FormIDs — a drag must never survive one.
	// Clears the drag state without touching any actor. Main thread only.
	void OnPostLoadGame();

	// ---- OMO-delegated grab ("grab" action, v3) -------------------------
	// The carry itself belongs to Object Manipulation Overhaul; the deck only
	// tracks whether a grab IT handed over is presumably still live, so the
	// deck key can double as Cancel ("hitting F7 again should cancel grab").

	// True while a Grab we delegated is (as far as we know) still dragging.
	bool OmoGrabActive();

	// The input that ends an OMO drag was seen (left = place, right = put
	// back) — clear the flag; OMO acts on that same click itself.
	void OmoGrabEnded(const char* how);

	// The deck key fired mid-grab: clear the flag and tell the player. The
	// caller synthesizes OMO's own Cancel input (a right-click) — input
	// synthesis lives in main.cpp. Returns true when a grab was active.
	bool CancelOmoGrab();
}
