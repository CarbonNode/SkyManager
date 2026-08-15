#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

// 🎨 Skins — SkinShift integration for the F7 quick-card Effects modal.
// SkinShift (Nexus 176804) is an SKSE DLL loaded in-process beside us, with NO
// exports and NO Papyrus — we drive its INTERNAL functions by RVA, behind a
// mandatory version gate (five prologue AOB checks; any mismatch disables the
// whole integration with an honest reason). Everything here MUST run on the
// game main thread (the fx* bridge handlers in main.cpp already AddTask us
// there); SkinShift has no internal locking.
namespace SkinShiftActions
{
	// SkinShift.dll loaded AND all five call-site prologues verified (cached
	// after the first probe). On false, *whyNot carries the honest reason for
	// the view ("not loaded" vs "version isn't the one SkyManager knows").
	bool Available(std::string* whyNot = nullptr);

	// The `skins` block EffectsActions::StateJson rides on fxState:
	//   { present, available, reason?, unknown, current, currentName,
	//     presets:[{ key, name, files }] }
	// `present`  = SkinShift.dll is loaded (the view shows the tab at all)
	// `available`= the AOB gate passed (false -> tab shows `reason` instead)
	// `current`  = the stored base preset name for this actor (null = her own
	//              skin), read via a SEH-guarded walk of SkinShift's own
	//              assignment store; `unknown:true` when the walk tripped.
	nlohmann::json SkinsJson(std::uint32_t formId);

	// Apply preset `presetKey` (folder key like "Preset07", or a name.txt
	// display name — SkinShift's resolver accepts both) to the actor. Returns
	// the effects reply shape { ok, msg, id:"skinshift:<key>", on:true }.
	std::string Apply(std::uint32_t formId, const std::string& presetKey);

	// Remove the stored assignment (back to her own skin) and queue
	// SkinShift's rescan so the visual reverts without a reload. Returns
	// { ok, msg, id:"skinshift:clear", on:false }.
	std::string Clear(std::uint32_t formId);
}
