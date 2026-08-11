#pragma once

#include <string>

/*
 * WheelMenu — the engine half of the radial palette (Ctrl+F7).
 *
 * The wheel itself is entirely view-side (view/HotkeyDeck/hd-wheel.js): it
 * stores OMNI PINS and re-resolves them against each pane's live index, so
 * every follower, outfit, spell, place and hotkey it can hold already had a
 * bridge. Exactly one class of thing it was asked to hold did NOT:
 *
 *     "weapons, armor, individual usables, misc"  — Rober, 2026-08-11
 *
 * That is what lives here. Two calls, no state, no config of its own (the
 * wheel's layout is a raw json blob on Config, owned by the view):
 *
 *   InventoryJson()  what the player is CARRYING, classified and named.
 *   Use()            equip / drink / read one of them, by durable identity.
 *
 * Scoped to the player's own inventory on purpose. A wheel wedge for an item
 * you do not own is a dead button, and minting one out of the load order is
 * AddItemMenu's job — the deck already has actions for that.
 *
 * MAIN THREAD ONLY, both of them: they walk inventories and touch the equip
 * manager.
 */
namespace WheelMenu
{
	// {"ok":true,"items":[{formId,plugin,name,kind,count,value,weight,
	//                      equipped,favorite,slot,dmg,armor}]}
	// `formId` is the DURABLE plugin-local id in the deck's usual "0X…"
	// spelling and `plugin` its defining file — never a runtime FormID, which
	// on this rig's 4,000-odd light plugins moves whenever the load order does
	// (see actor_identity.h). Unnamed forms are skipped: they are FakeItem and
	// script-plumbing rows, and a wedge you cannot read is not a wedge.
	std::string InventoryJson();

	// Request: {"op":"use","formId":"0X…","plugin":"x.esp","kind":"weapon"}
	// Reply:   {"ok":bool,"msg":"…","equipped":bool}
	// Equipping is a TOGGLE for the wearable kinds — clicking the sword you
	// already hold sheathes it, which is what a weapon wheel is for. `kind` is
	// only a hint from the view; the real decision is made from the resolved
	// form, so a stale pin cannot talk us into the wrong verb.
	std::string Use(const std::string& reqJson);
}
