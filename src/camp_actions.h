#pragma once

// Camp/Hunterborn action entries — the "auto-populate camping hotkeys" half of
// the Settlement feature (Rober: hotkey auto-seeding for Campfire + Hunterborn).
//
// Each seeded action self-casts the owning mod's OWN hotkey spell/power so its
// Papyrus flow runs exactly as shipped — the AddItemMenu (aim_actions.cpp)
// precedent. Every spell is resolved edid-first with a fallback local id (the
// loot_highlight palette precedent), so a mod update that shifts a FormID does
// not silently mis-fire. A missing/disabled plugin is an honest notification.
//
// MAIN THREAD ONLY (magic caster + Papyrus).

#include <string>

namespace CampActions
{
	// True for a camp-* / hb-* action verb this module owns.
	bool IsAction(const std::string& a);

	// Self-cast the owning mod's spell for this verb. No palette reopen (the
	// Papyrus flow runs unpaused, like AddItemMenu).
	void Fire(const std::string& a);
}
