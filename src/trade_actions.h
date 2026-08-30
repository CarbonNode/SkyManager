#pragma once

#include <string>

namespace RE
{
	class Actor;
}

// ---------------------------------------------------------------------------
// TRADE — open the barter menu (or the pack) on whoever you are looking at.
//
// Rober's ask, 2026-08-17: "new f7 ability, a open merchant / trade button when
// hitting f7 on an npc", modelled on Skyrim QuickTrade (Nexus SSE 31335), which
// he already plays with. QuickTrade's rule, kept verbatim and APPROVED, so do
// not re-litigate it:
//
//     non-hostile, at least neutral   -> the BARTER menu (vanilla trading)
//     a companion or a spouse         -> her INVENTORY (humanoid or animal)
//     an explicit override            -> force the inventory either way
//
// WHY THIS IS NOT ONE ENGINE CALL
// -------------------------------
// Neither menu has a C++ native in CommonLibSSE-NG. Both are Papyrus natives on
// Actor — ShowBarterMenu() and OpenInventory(bool) — so both go through the VM
// (modding/skyrim-script-headers/Actor.psc:650 and :463). Two consequences the
// next session must not "fix":
//
//   * PAPYRUS DOES NOT RUN WHILE THE PALETTE HOLDS THE GAME PAUSED. The caller
//     closes the palette FIRST and never reopens it — a reopened (paused)
//     palette would sit on the dispatched stack until the next close, and would
//     also be painted on top of the menu we just asked for. Same law the party
//     orders already live under (main.cpp, 2026-08-14).
//   * The dispatch is ASYNCHRONOUS. Nothing here can report that the menu
//     actually opened; the reply promises what was ASKED, which is the only
//     honest claim. See nff_control.h for the same contract in longer form.
//
// THE INVENTORY HALF IS DELEGATED, ON PURPOSE
// -------------------------------------------
// NffControl::Apply({op:"inventory"}) already opens a pack, and it carries the
// broken-inventory guard that exists because a dead entry left by an
// uninstalled mod HARD-FREEZES the game when RemoveItem touches it (Rober,
// 2026-08-08, a cloak on Amaniri). Re-implementing OpenInventory here would
// re-open that freeze on a new button. So: barter is ours, inventory is NFF's
// one implementation.
//
// IDENTITY / THREADING: MAIN THREAD ONLY, like every RE:: path in this plugin.
// The target is the crosshair actor snapshotted at palette-open
// (NpcActions::TargetFormID) unless the caller names someone explicitly — the
// F7 card can be pointed at a party member you are not looking at.
// ---------------------------------------------------------------------------
namespace TradeActions
{
	// True for EVERY spelling of the two verbs this file owns — the seeded
	// action ids ("trade", "trade-inventory") and the fdNpc bridge ops
	// ("trade", "tradeInventory"). One predicate on purpose: main.cpp asks the
	// same question from both doors, and a second predicate is how the two
	// drift apart.
	bool IsAction(const std::string& idOrOp);

	// Fire a seeded action entry against the crosshair snapshot. Main thread.
	// Says its own result on screen (the palette is already shut by the caller,
	// so a returned envelope would be said nowhere).
	void Fire(const std::string& action);

	// The fdNpc bridge route: { "op":"trade"|"tradeInventory",
	//                           "formId":"0x…"?, "plugin":"…"? }
	// Returns the same envelope shape every other card verb answers with:
	//   { "ok":false, "phase":"refused", "msg":"…" }
	//   { "ok":true,  "phase":"sent", "op":…, "mode":"barter"|"inventory",
	//     "name":"…", "msg":"…" }
	// Main thread only.
	std::string Apply(const std::string& reqJson);
}
