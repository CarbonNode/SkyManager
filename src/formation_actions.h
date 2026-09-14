#pragma once

#include <string>

// The deck's Formation modal — now a ROUTER over one provider per installed
// formation mod, not a single-mod bridge.
//
// Providers (ids are the wire values the view sends as `provider`):
//   "fwf" — Formation with Followers (Nexus 66759), below.
//   "wwm" — Walk With Me (Nexus 191283), formation_wwm.h.
//
// Rober's call (2026-09-10) on Walk With Me landing: "No swap, just support
// for both." So nothing here is retired — the FWF provider is unchanged and
// the router only picks which one a request lands on. The router also reports
// `conflict` when both mods are live at once, because two systems rewriting
// the same followers' travel packages is the one way "both installed" hurts.
//
// ------------------------------------------------------------------------
// Provider: Formation with Followers (Nexus 66759).
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
	// ---- Provider: Formation with Followers -------------------------------
	namespace Fwf
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

	// ---- Router -----------------------------------------------------------
	//
	// Every entry point below takes the SAME request the provider does, plus
	// an optional `provider` key ("fwf" | "wwm"). With it absent the router
	// uses the last provider the view acted on, else the only installed one,
	// else FWF. main.cpp's fm* listeners are unchanged: they still call these
	// four names, so adding a provider never touches the bridge.

	// fmGet -> fmOpen. The reply carries the ACTIVE provider's own state at
	// the top level (so an old view that knows nothing about providers keeps
	// working against FWF), plus:
	//   providers: [ { id, label, installed, present, running } ]
	//   provider:  the active id
	//   conflict:  true when two providers are live at once
	std::string StateJson(const std::string& reqJson);

	// fmApply / fmReg / fmRescue -> fmResult, routed to `provider`.
	std::string Apply(const std::string& reqJson);
	std::string Reg(const std::string& reqJson);
	std::string Rescue(const std::string& reqJson);
}
