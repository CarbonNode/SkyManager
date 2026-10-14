#pragma once

#include <string>

/*
 * GripSwitch — a deck button for Dynamic Grip (bosnThs, Nexus 110031; source
 * github.com/bosnThs/dynamicGrip). Rober, 2026-10-10: "if you have the change
 * grip mod can it be smart and show a change grip button? doesnt have to hook
 * to hotkey but innately changes grip so i can free the hotkey".
 *
 * Dynamic Grip has no API: no Papyrus natives, no exports, no messaging. Its
 * whole switch runs inside its hook on ShoutHandler::CanProcess (vtable slot 1),
 * which fires when the event is EITHER its ini key released OR a released
 * ButtonEvent whose user event is "GripSwitch", with the weapon drawn (0.4.9
 * XSEPlugin.cpp CanProcessShout; still true at upstream 34504fd). So the deck
 * hands that event to the player's shout handler directly — no key is pressed,
 * nothing goes through the input queue — and Dynamic Grip does everything else
 * itself: the left-hand unequip/re-equip, the GripSwitchEvent animation, the
 * damage/speed effects, its sound. The deck implements none of it.
 *
 * Vanilla ShoutHandler::CanProcess answers false for a "GripSwitch" event, so
 * the call can never shout. The result is read back from the graph variable
 * Dynamic Grip itself writes: iDynamicGripMode (0 default, 1 two-handed grip on
 * a one-hander, 2 one-handed grip on a two-hander, 3 dual wield).
 */
namespace GripSwitch
{
	// dynamicGrip.dll is loaded in this process.
	bool Loaded();

	// MAIN THREAD. Runs Dynamic Grip's own switch on the player. Returns a
	// one-line log/notification text; `ok` says whether the grip changed.
	std::string Toggle(bool& ok);
}
