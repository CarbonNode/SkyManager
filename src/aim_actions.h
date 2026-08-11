#pragma once

#include <string>

// AddItemMenu from the deck — click or hotkey, no inventory digging.
//
// AddItemMenuSE (Towawot) is opened in-game by "using" one of its misc items
// in the inventory, or by casting one of its two lesser powers; both routes
// run the same Papyrus flow (AddItemMenuSEMagicEffect / AddItemMenuSEObject):
// UIExtensions mod-list popup, or a text-entry name search first.
//
// The deck casts the mod's OWN powers on the player — AIM_Power (mod-list
// popup) and AIM_PowerSearch (search first) — so the mod's script runs exactly
// as shipped: no inventory juggling, no keystroke to synthesize, and the two
// entries behave identically from a palette click or a bound trigger key.

namespace AimActions
{
	bool IsAction(const std::string& a);  // "additem-menu" / "additem-search"
	void Fire(const std::string& a);      // main thread (call from an SKSE task)
}
