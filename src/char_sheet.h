#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

// Character Sheet tab for the Hotkey Deck — the player's own live stats and a
// freeform RP identity, on the deck AND the phone portal.
//
// WHAT IT SHOWS (all engine-level off RE::PlayerCharacter, so a custom race,
// an ESL-added spell effect, anything the load order added just works):
//
//   * name / race        player->GetName(), race->GetFullName(). The race's
//                        EditorID rides along (raceEditorId) so a custom race
//                        with a duplicate display name is still identifiable.
//   * level              player->GetLevel().
//   * hp / mag / sta     the three pools, cur = GetActorValue, max =
//                        GetPermanentActorValue (base + permanent modifiers —
//                        the number the bar is drawn against), exactly the
//                        cur/max split follower_tune.cpp reads on a follower.
//   * carry / inventory  carry = kCarryWeight pool; gold, four potion groups
//                        and lockpicks are summed off the inventory-changes
//                        list, the crash-safe way
//                        Finance::ReadGold does it (a full GetInventory<>()
//                        walk faulted inside our DLL on a 4k-plugin order).
//   * souls / bounty     dragon souls = kDragonSouls AV; bounty = the crime
//                        gold owed to the player's most-recent crime faction
//                        (best-effort — 0, never faked, when none is reachable).
//   * beast              "" | "Vampire" | "Werewolf", probed best-effort from
//                        the race EditorID (VampireRace / WerewolfBeastRace
//                        substrings) and the vanilla PlayerVampire / Lycanthrope
//                        factions. A miss is "", not a wrong guess.
//   * skills             all 18 skill actor values in canonical order.
//   * effects            player->AsMagicTarget()->GetActiveEffectList(): each
//                        active effect's name, source spell + plugin, magnitude,
//                        total + remaining seconds, harmful flag, and a
//                        safe/confirm/locked removal mode.
//
// FREEFORM META (class, alignment, title, appearance details, homeland, patron,
// background, history and portrait) is user-typed and lives in the config
// slice, NOT read from the game — round-tripped through hotkeys.json under the
// root key "charsheet". It is the RP half of the sheet: what the numbers can't
// say.
//
// THREADING: BuildSheetJson touches the player and the magic-target list, so it
// is MAIN THREAD ONLY, like every RE:: path in this plugin (schedule via
// SKSE::GetTaskInterface()->AddTask). RemoveEffect is likewise main-thread —
// ActiveEffect::Dispel runs the effect-end script.
namespace CharSheet
{
	// The freeform RP identity — the "charsheet" config slice. These are story
	// fields, deliberately independent of the live actor record: a custom race
	// or appearance overhaul does not need an integration for the player to
	// describe the character they are actually role-playing. Portrait is a
	// view-relative path under portraits/.
	struct Meta
	{
		std::string charClass;   // e.g. "Nightblade", "Warden of the Ashen March"
		std::string alignment;   // e.g. "Lawful Evil" (freeform; D&D names are suggestions)
		std::string title;       // epithet, rank, style of address
		std::string eyeColor;
		std::string height;      // freeform so "6'2\"" and "1.88 m" both work
		std::string age;
		std::string homeland;
		std::string deity;
		std::string background;  // where they came from
		std::string history;     // the long story
		std::string portrait;    // "portraits/<file>" (view-relative) or ""

		// Portrait DISPLAY crop — the same {z,x,y} model the follower roster uses
		// (portrait_capture.cpp cannot re-cut pixels: no PNG decoder). z = display
		// zoom (1 = whole cover-fitted frame), x/y = pan in fractions of the frame.
		// The view applies these as a CSS transform on the portrait <img>, so the
		// in-game "frame it" editor (the followers' crop popout) and the drawn
		// portrait agree. Identity (1,0,0) = draw the photo as shot.
		float portraitZoom = 1.0f;
		float portraitX    = 0.0f;
		float portraitY    = 0.0f;
	};

	// Per-field byte caps. Keep these in lock-step with portal/server.js so a
	// value accepted on the phone is never silently reshaped by the plugin.
	// Unknown keys return 0 and are not accepted by either caller.
	constexpr std::size_t MetaTextCap(std::string_view key) noexcept
	{
		if (key == "charClass" || key == "title")
			return 120;
		if (key == "alignment" || key == "eyeColor" || key == "height" || key == "age")
			return 80;
		if (key == "homeland" || key == "deity")
			return 160;
		if (key == "background")
			return 2000;
		if (key == "history")
			return 8000;
		if (key == "portrait")
			return 260;
		return 0;
	}

	// Portrait path guard — the same spirit as main.cpp's ValidViewIconPath, but
	// keyed to portraits/ (where follower faces already live) instead of icons/.
	// Rewrites backslashes to '/', accepts "" (clears the portrait), and refuses
    // anything that could walk out of the view dir (a "..", a leading '/', a
	// drive letter). Mutates p in place and returns whether it is acceptable.
	bool ValidPortraitPath(std::string& p);

	// Apply a partial meta edit (any subset of the RP fields present in the
	// object). Returns { ok, msg } as a JSON string; on ok the caller persists
	// and re-pushes. Fields absent from the patch are left untouched; a present
	// field set to "" clears it. `editJson` is the psSetMeta payload (or the
	// portal-sheet-edits.json object — the same shape).
	//
	// Pure data work: no game access, so it is safe on any thread. The caller
	// holds the config lock and owns the Meta it mutates.
	std::string ApplyMeta(Meta& meta, const std::string& editJson);

	// The full psData payload as a JSON string. `meta` is the persisted RP slice
	// (snapshotted under the config lock by the caller and passed in, so this
	// function itself takes no lock and touches only the game). MAIN THREAD ONLY.
	//
	// Never throws: a missing player / null pointers degrade to zeros and empty
	// lists so the tab renders "no save loaded" instead of crashing.
	std::string BuildSheetJson(const Meta& meta);

	// Per-potion detail for ONE Pack Check category, for the chip-click modal:
	// every potion the player carries that falls in `category`, as
	// { category, label, items:[{name, count, magnitude, effect}] } (JSON string).
	//
	// `category` is one of "health" | "magicka" | "stamina" | "other" — the same
	// four cards the Pack Check strip shows, using the SAME PotionPoolMask
	// bucketing BuildSheetJson counts with, so a modal opened from a chip lists
	// exactly the potions that chip counted. `magnitude` is the largest restore/
	// effect magnitude on the potion (0 when none), `effect` its primary effect's
	// display name (best-effort, "" when unknown). Uses the same crash-safe
	// inventory-changes walk as the count read (a full GetInventory<>() faulted on
	// the 4k-plugin profile). MAIN THREAD ONLY. Never throws — a missing player or
	// an unknown category returns an empty item list, not an error.
	std::string BuildPackListJson(const std::string& category);

	// Dispel one active effect by the per-instance key emitted in effects[].
	// `usUniqueID` is NOT unique in practice (the live profile has scores of
	// effects with id 0), so the key is the live ActiveEffect address rendered
	// as hex and is matched only against the current active list before use.
	// `force` is required for a permanent non-racial ability: those are engine-
	// dispellable but may be a mod controller, so the view gives them a stronger
	// "Remove anyway?" confirmation. Race-inherited effects stay hard-locked.
	// MAIN THREAD ONLY.
	std::string RemoveEffect(const std::string& key, bool force);
}
