#pragma once

#include <string>

namespace Wardrobe
{
	// No engine references: a bed visit is one continuous sleeping/waking state.
	// Changing a rule in bed applies it once; standing, clearing or disabling
	// releases the slot. Unloaded actors are not observations of standing up.
	enum class BedAction { none, apply, clear };
	struct BedState
	{
		bool initialized = false;
		bool active = false;
		bool inBed = false;
		std::string revision;

		BedAction Observe(bool enabled, bool sleeping, const std::string& rule)
		{
			const bool changed = !initialized || active != enabled || revision != rule;
			const bool entered = sleeping && !inBed;
			const bool left = !sleeping && inBed;
			initialized = true;
			active = enabled;
			inBed = sleeping;
			revision = rule;
			if (enabled && sleeping && (changed || entered))
				return BedAction::apply;
			if (changed || left)
				return BedAction::clear;
			return BedAction::none;
		}
	};
}
