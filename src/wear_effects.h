#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

// ---------------------------------------------------------------------------
// Wear effects — cosmetic mods the Effects modal drives by EQUIPPING ARMOUR,
// as opposed to effects_actions.cpp's registry, which drives them by carrying
// an ABILITY SPELL.
//
// THE ASK (Rober, 2026-08-17): add [Predator] Liquid Pack v2 to the skin
// effects "same as the oil mod one", and — the part that shapes this file —
// "we could support other mods with restraints or other oil / skin mods that
// need to be separated by mod".
//
// WHY IT IS A SEPARATE MECHANISM. Oily Skin is an ability spell: carrying it
// IS the effect, so AddSpell/RemoveSpell is the whole story and the mod's own
// magic-effect script owns persistence. Liquid Pack is not that at all — it is
// ten ARMO records (Torso / Bottom / Face, each Base and Dye, plus SMP
// "dripping" variants) on non-conflicting biped slots, so they stack, and a
// NiOverride TintData XML dyes them. Toggling one means equipping or
// unequipping a piece of armour. Pretending both were the same mechanism was
// never an option; what they SHARE is the shape of the answer, so both land in
// the same `effects` array with a `mod` field and the view groups by it.
//
// TABLE-DRIVEN, RUNTIME-ENUMERATED. A mod is one row here — plugin, display
// name, glyph. Its wearable pieces are NOT listed: they are enumerated from
// TESDataHandler at runtime by walking that plugin's ARMO records, so a mod
// update that adds, removes or renumbers a piece is picked up with no code
// change (the same reason the Pubes tab reads OPubes' own catalogue rather
// than tabling it). Adding "some other oil mod" is one row.
//
// ⚠ Slot conflicts are the mod author's business, not ours: two pieces on the
// same biped slot simply replace each other, which is exactly what the engine
// does and what the user expects. We report what is WORN, we do not predict.
//
// Everything here touches engine state — MAIN THREAD ONLY. The fx* bridge
// handlers already AddTask us there.
// ---------------------------------------------------------------------------
namespace WearEffects
{
	// Every registered wear-mod's pieces, with worn state for this actor:
	//   [ { id:"wear:<plugin>|<localhex>", label, glyph, detail, mod,
	//       kind:"wear", present, active, reason? }, … ]
	// Returned as a plain ARRAY so EffectsActions::StateJson can splice it into
	// the same `effects` list the spell registry fills — one list, grouped by
	// `mod` in the view, rather than two lists the view has to reconcile.
	//
	// A registered mod that is not in the load order contributes NOTHING (no
	// "not installed" rows): unlike the spell registry, whose one row per mod
	// is worth showing as unavailable, a wear-mod would otherwise contribute a
	// whole absent category. `ModsJson` reports those honestly instead.
	nlohmann::json PiecesJson(std::uint32_t formId);

	// The per-mod detection report: [ { mod, plugin, present, count } ].
	// Lets the modal say "Liquid Pack: not installed" once, rather than in ten
	// dead rows.
	nlohmann::json ModsJson();

	// True if at least one registered wear-mod is in the load order — feeds
	// `anyPresent` so the ✨ button is not drawn for a rig that has none.
	bool AnyPresent();

	// Toggle one piece. `id` is the full "wear:<plugin>|<localhex>" form the
	// view sends back. Returns the effects reply shape { ok, msg, id, on }.
	std::string Apply(std::uint32_t formId, const std::string& id, bool on);
}
