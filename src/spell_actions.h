#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Spell Deck backend — the magic-organizer counterpart to npc_actions.
//
// All functions here touch live game state (the player actor, the equip
// manager, the magic caster) and therefore MUST be called on the main game
// thread. main.cpp wraps every call in SKSE::GetTaskInterface()->AddTask,
// exactly like it does for NpcActions.
//
// Durable spell identity is carried as (plugin, localId) with a raw formId
// fallback — the same scheme quest_tools uses for quests, so a saved deck
// keeps working across load-order shuffles.
namespace SpellActions
{
	void Init();

	// JSON array of the player's currently-known, castable spells (spell /
	// power / lesser-power / voice-power), deduped and name-sorted:
	//   [{plugin, localId, formId, name, type, delivery, casting, slot,
	//     school, element, archetype, tier}]
	// `slot` is "hand" (L/R-equippable) or "voice" (power slot) — a UI hint.
	// `tier` is novice..master (from the costliest effect's minimum skill);
	// "" for powers/shouts — the view uses it to pick the right generic icon.
	std::string KnownSpellsJson();

	// Ground-truth equip state, read fresh from the engine. Used on menu-open
	// to reconcile the badges the view drew optimistically:
	//   {"left":"0xID"|"", "right":"0xID"|"", "voice":["0xID", ...]}
	std::string EquipStateJson();

	// Cast the spell now. Hand spells: self-delivery self-casts, everything
	// else targets the crosshair actor snapshotted at menu-open (NpcActions),
	// or fires forward. VOICE-SLOT items (greater/lesser powers, shouts) go a
	// different road entirely — the instant caster can't fire them reliably —
	// they are selected into the voice slot and the game's own mapped Shout
	// key is pressed (real engine cast: cooldown, animation, perks). `onDone`
	// (optional) runs on the main thread once the cast has actually happened:
	// immediately for hand spells, AFTER the delayed key press for voice items
	// — hang the palette reopen there so it can't pause the world mid-use.
	// Returns {"ok":bool, "msg":"..."}
	std::string Cast(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		std::function<void()> onDone = nullptr);

	// Durable identity of one combo member — same resolve scheme as everywhere
	// else: (plugin, localId) first, raw formId fallback.
	struct SpellRef
	{
		std::string   plugin;
		std::uint32_t localId = 0;
		std::uint32_t formId = 0;
	};

	// Cast a whole combo: refs in order, `staggerMs` apart, one "⚡ name"
	// notification up front instead of a per-spell spam. Must be entered on the
	// main game thread (the first cast happens inline); the remaining casts are
	// paced by a detached timer thread that posts each one back onto the main
	// thread via the SKSE task interface. `onDone` (optional) runs on the main
	// thread after the LAST cast — the palette reopen hook lives there so a
	// pause-on-open palette can't freeze the tail of its own barrage. Re-entry
	// while a sequence is still casting is refused (notification), then onDone
	// still runs so the palette flow stays consistent.
	void CastSequence(const std::string& name, std::vector<SpellRef> refs,
		std::uint32_t staggerMs, std::function<void()> onDone);

	// Toggle-equip the spell. Hand spells honour `hand` ("left"|"right"|"both")
	// with true engine equip state; powers ignore `hand` and use the voice
	// slot. Returns the spell's NEW intended state so the view can update its
	// badge instantly (the async Papyrus unequip is reconciled on next open):
	//   {"ok":bool, "msg":"...", "formId":"0xID", "left":bool, "right":bool, "voice":bool}
	std::string EquipToggle(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		const std::string& hand);

	// Remove the spell from the player's spellbook (engine RemoveSpell). Spells
	// and POWERS alike — RemoveSpell handles any learned SpellItem, and the
	// race/perk/quest-granted ones it can't touch get an honest refusal. Only
	// shouts are gated out (a TESShout has no spellbook entry to pull).
	// Non-destructive: the spell FORM stays in the load order, so
	// RestoreToSpellbook (AddSpell) always brings it back. Returns the metadata the
	// view needs to keep it in the restorable "Removed" list — a removed spell drops
	// out of KnownSpellsJson, so its icon data must travel with the result:
	//   {ok, msg, formId, plugin, localId, name, type, school, element, archetype, tier}
	// formId/localId are NUMBERS (as in KnownSpellsJson), not hex strings.
	// `notify=false` skips the on-screen toast (the capture-hotkey flow composes
	// its own combined notification).
	std::string RemoveFromSpellbook(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		bool notify = true);

	// Re-learn a previously removed spell (engine AddSpell). Idempotent — a spell
	// the player already knows is reported ok. Returns {ok, msg, formId(number)}.
	std::string RestoreToSpellbook(const std::string& plugin, std::uint32_t localId, std::uint32_t formId);

	// The spell's auto-generated description ("Target takes <mag> points of
	// damage…"), composed per visible effect from EffectSetting's
	// magicItemDescription with <mag>/<dur>/<area> tags filled in — the same
	// text the vanilla item card shows. Returns {ok, formId(number), name, text};
	// text is "" when no effect carries a description.
	std::string DescriptionJson(const std::string& plugin, std::uint32_t localId, std::uint32_t formId);

	// Snapshot of the spell highlighted in the vanilla Magic Menu (read from the
	// menu's item card), falling back to the equipped right- then left-hand spell
	// when the card read fails. Powers the add-from-spellbook capture hotkey:
	//   {ok, src:"menu"|"hand", plugin, localId, formId(number), name, type,
	//    slot, school, element, archetype, tier}
	// {ok:false, msg} when nothing is highlighted or equipped.
	std::string HighlightedSpellJson();
}
