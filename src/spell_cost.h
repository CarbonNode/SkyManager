#pragma once

#include <cmath>
#include <optional>

namespace SpellCost
{
	// CalculateMagickaCost enters perk conditions, including EPMagic_SpellHasSkill.
	// On SE that condition dereferences GetCostliestEffectItem(kTotal, false)
	// without checking its result. Even a nonempty effect list can return null
	// (the observed Wyrmstooth Reanimate (Self) crash). Check the SAME selector
	// before entering the engine; no exception swallowing or guessed zero cost.
	// Kept independent of CommonLib so the no-engine-call cases are testable.
	template <class Spell, class Actor>
	std::optional<float> Read(Spell* spell, Actor* caster)
	{
		if (!spell || !caster || spell->effects.empty())
			return std::nullopt;
		for (const auto* effect : spell->effects)
			if (!effect || !effect->baseEffect)
				return std::nullopt;
		const auto* costliest = spell->GetCostliestEffectItem();
		if (!costliest || !costliest->baseEffect)
			return std::nullopt;

		const float cost = spell->CalculateMagickaCost(caster);
		if (!std::isfinite(cost) || cost < 0)
			return std::nullopt;
		return cost;
	}
}
