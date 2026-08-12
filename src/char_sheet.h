#pragma once

#include <cstdint>
#include <string>

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
//   * carry / gold       carry = kCarryWeight pool; gold = Gold001 summed off
//                        the inventory-changes list, the crash-safe way
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
//                        wantsRemove gate (see WantsRemove below).
//
// FREEFORM META (charClass / background / history / portrait) is user-typed and
// lives in the config slice, NOT read from the game — round-tripped through
// hotkeys.json under the root key "charsheet". It is the RP half of the sheet:
// what the numbers can't say.
//
// THREADING: BuildSheetJson touches the player and the magic-target list, so it
// is MAIN THREAD ONLY, like every RE:: path in this plugin (schedule via
// SKSE::GetTaskInterface()->AddTask). RemoveEffect is likewise main-thread —
// ActiveEffect::Dispel runs the effect-end script.
namespace CharSheet
{
	// The freeform RP identity — the "charsheet" config slice. Four capped
	// free-text fields; portrait is a view-relative path under portraits/.
	struct Meta
	{
		std::string charClass;   // e.g. "Nightblade", "Warlord of the Southern Pass"
		std::string background;  // where he came from
		std::string history;     // the long story
		std::string portrait;    // "portraits/<file>" (view-relative) or ""
	};

	// The per-field free-text cap (bytes). A pasted novel must not bloat
	// hotkeys.json; the view keeps well under this.
	constexpr std::size_t kTextCap = 8192;

	// Portrait path guard — the same spirit as main.cpp's ValidViewIconPath, but
	// keyed to portraits/ (where follower faces already live) instead of icons/.
	// Rewrites backslashes to '/', accepts "" (clears the portrait), and refuses
    // anything that could walk out of the view dir (a "..", a leading '/', a
	// drive letter). Mutates p in place and returns whether it is acceptable.
	bool ValidPortraitPath(std::string& p);

	// Apply a partial meta edit (any subset of the four fields present in the
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

	// Dispel one active effect by its ActiveEffect uniqueID (the "id" every
	// effects[] row carries). Returns { ok, msg } as a JSON string. Refuses —
	// with a reason — an effect whose source is an ability / race power / disease
	// (the ones WantsRemove marks false), because dispelling those is how you
	// break a character (loses a racial passive, a standing-stone blessing, a
	// werewolf's timer). MAIN THREAD ONLY. `id` is the uniqueID, not a FormID.
	std::string RemoveEffect(std::uint32_t id);
}
