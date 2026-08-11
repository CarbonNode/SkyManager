#pragma once

#include <string>

// Formation with Followers (Nexus 66759) — the deck's Formation modal.
//
// The mod is pure Papyrus: every setting is an Auto property on FWF_scrCore
// (quest FWF_qstCore 0x800 in FormationWithFollowers.esp), per-follower
// offsets are Auto properties on the FWF_scrFollowerAlias scripts bound to
// its 64 `Follower##` reference aliases, and the apply step is the mod's own
// EvaluateAllFormation(). So this bridge never re-implements formation — it
// reads/writes those properties and dispatches the mod's own functions
// through the Papyrus VM, exactly like follower_frameworks.cpp does for the
// follower mods' wait/follow. Missing plugin = an honest {present:false}.
//
// ⚠ The ORIGINAL v1.2 scripts are a confirmed save-poisoner (repeating
// RegisterForUpdate + a GotoState("Busy") wedge that persists in the save →
// Papyrus latency >6s → infinite-load saves; the author pulled the mod over
// it). Our patched fork ("Formation with Followers - Fixed" in MO2) marks
// itself with `booDeckFixed` on FWF_scrCore; StateJson reports `fixed` so
// the modal can warn instead of silently driving the broken version.
namespace FormationActions
{
	// fmGet -> fmOpen. Request may carry {formId,plugin} for the card's
	// subject; empty formId falls back to the palette-open crosshair snapshot.
	std::string StateJson(const std::string& reqJson);

	// fmApply -> fmResult. Sets only the keys present in the request:
	//   { formId?, plugin?,
	//     global: { enabled?, interval?, defaultX?, defaultY?,
	//               walkingArea?, stopArea?, habitation?, dungeon? },
	//     offsets: { enabled?, followX?, followY?, sneakX?, sneakY?,
	//                combatX?, combatY? } }        (offsets act on the subject)
	// then re-evaluates the whole formation through the mod's own function.
	std::string Apply(const std::string& reqJson);

	// fmReg -> fmResult. { op: "register"|"unregister", formId?, plugin? } —
	// the mod's own SetAlias/ClearAlias on the subject actor.
	std::string Reg(const std::string& reqJson);

	// fmRescue -> fmResult. Full stand-down: the patched FWF_Rescue() when the
	// fixed scripts are live, else the manual sweep that is safe on the
	// UNPATCHED scripts (per-alias UnregisterKeepOffset, then ClearAlias per
	// actor, then Termination) — the order matters: Termination's raw Clear()
	// loop leaks live update registrations if anything is still registered.
	std::string Rescue();
}
