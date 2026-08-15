#pragma once

#include <cstdint>
#include <string>

// The Effects modal on the F7 quick card (fx* bridge): visual effects OTHER
// mods implement as ability spells, applied to / removed from the person the
// card is about. First tenant: Oily Skin - Lightweight Wet Function
// (Nexus 141131). The registry lives in the .cpp — adding an effect is one
// table entry, the modal draws itself from StateJson.
namespace EffectsActions
{
	// Every registered effect with present/active state for this actor:
	// { ok, formId, name, dead, effects:[{ id, label, glyph, detail,
	//   present, active, reason }], skins:{...} }
	// (`skins` is SkinShiftActions::SkinsJson — the modal's 🎨 Skins tab.)
	std::string StateJson(std::uint32_t formId);

	// Apply (on=true) or remove one effect on the actor. Returns
	// { ok, msg, id, on } for fxResult. Ids starting "skinshift:" route to
	// SkinShiftActions (":clear" / on=false clears; anything else is the
	// preset key to apply).
	std::string Apply(std::uint32_t formId, const std::string& id, bool on);
}
