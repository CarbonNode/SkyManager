#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace RE
{
	class Actor;
}
namespace SKSE { class SerializationInterface; }

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

	// Temporary conversation movement guard, independent of quest/follower AI.
	// Explicit reference + matching name required; never falls back to crosshair.
	// Main thread only. Repeated start refreshes, release is idempotent.
	std::string ConversationControl(const std::string& request);
	bool HasPoseHold(std::uint32_t id); // Freeze, furniture or Grab owns this actor
	void TickConversations(bool gameReady, bool paused);
	void ReleaseConversation(std::uint32_t id, const char* reason); // 0 = all
	void SaveConversations(SKSE::SerializationInterface* s);
	bool LoadConversations(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t length);
	void RevertConversations();
	void RestoreConversationsAfterLoad();

	// "Sic 'em" against a SUBSET of the loaded followers. `allow` decides who
	// joins the charge; a null `allow` means every loaded follower, which is
	// what the bindable "attack-target" action fires. `who` names the subset in
	// the refusal when none of them is nearby ("Dragon Guard"), so a group
	// order cannot report the party's answer. Target designation, the longshot
	// ray and the nearby-hostile wake-up are identical either way.
	//
	// Every press fires the bolt down the crosshair (sic_em_feedback.h). If the
	// crosshair or the longshot already names a target the order goes NOW;
	// otherwise the order is given when the bolt LANDS — asynchronously, on
	// the main thread — so `allow` is COPIED and must not capture anything by
	// reference (loadouts.cpp captures its key set by value for this reason).
	// Returns true when the order was given or the bolt is in the air and will
	// give it; false when nothing could be ordered (reason already on screen).
	// Main thread only.
	bool SicEm(const std::function<bool(RE::Actor*)>& allow, const std::string& who);

	// ONE actor charges — the F7 card's per-person Attack. formId 0 = the
	// crosshair snapshot. The target is chosen exactly as SicEm chooses it,
	// minus her: the crosshair (unless that is her or a teammate), the
	// longshot along your aim, whoever the bolt lands on, then the nearest
	// enemy already fighting you.
	// Releases a deck hold (freeze/sit/bed) on her first. Not limited to
	// teammates. outMsg is the line already put on screen — or, when the bolt
	// is still flying, what the caller may show while it decides. Main thread only.
	bool SicEmOne(std::uint32_t formId, std::string& outMsg);

	// Seat an actor on an EXPLICIT furniture reference through the alias engine
	// (SitTarget package at the paired chair alias) — the ZaZ segment's
	// "use this cross/pillory" verb. Main thread only. On failure returns false
	// with the honest reason in outMsg; on success outMsg is the HUD line
	// already shown ("<name> -> <furniture> (walking over)").
	bool SeatOn(std::uint32_t actorFormId, std::uint32_t furnRefId, std::string& outMsg);

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
