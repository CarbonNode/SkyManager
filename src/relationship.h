#pragma once

#include <string>

namespace RE
{
	class Actor;
}

// ---------------------------------------------------------------------------
// The player's RELATIONSHIP RANK with an NPC — read it, and change it.
//
// Skyrim's rank is the nine-step scale the Creation Kit calls a RELA record:
//
//     +4 Lover  +3 Ally  +2 Confidant  +1 Friend   0 Acquaintance
//     -1 Rival  -2 Foe   -3 Enemy      -4 Archnemesis
//
// It is not cosmetic. Vanilla dialogue, most follower frameworks, marriage and
// a great deal of mod content gate on GetRelationshipRank, so this is the one
// number that decides whether someone will talk to you like a stranger or like
// family — and until now the deck could neither show it nor set it.
//
// TWO DIFFERENT APIS, ON PURPOSE
// ------------------------------
// READ is a plain engine lookup: BGSRelationship::GetRelationship(npc1, npc2)
// walks the base NPC's own relationship array and hands back the record. It is
// synchronous and cannot fail slowly, which is what lets the rank ride along in
// the Followers card's existing `about` dossier instead of costing a round trip.
//
// WRITE goes through the Papyrus VM — Actor.SetRelationshipRank(other, rank).
// That is deliberate and it is NOT laziness:
//   * The rank lives in a RELA form, and when no relationship exists between
//     the two NPCs the engine CREATES one. That allocation, its registration
//     and its save bookkeeping are all inside the native; poking `level` on an
//     existing record would work for the easy half of the cases and silently do
//     nothing for the other half (a stranger you have never had a relationship
//     record with — which is most of Skyrim).
//   * Writing `level` by hand also skips the change-flag the engine sets
//     (BGSRelationship::ChangeFlags::kRelationshipData), so the edit would look
//     right in the session and be gone after a save/load.
// Dispatching the native by the same door Papyrus uses gets all of that for
// free. The cost is that the write is ASYNCHRONOUS: the VM runs the stack when
// it likes, so nothing here can return the new rank. The bridge answers with
// what was REQUESTED and the view re-reads a moment later — see relationship.cpp.
//
// IDENTITY IS THE BASE NPC, NOT THE REFERENCE. A relationship is between two
// TESNPCs, so it means the PERSON: every copy of a levelled bandit shares one
// rank, and a follower keeps hers across a cell reset. Same rule the Rooms tab
// ignore list uses, for the same reason.
// ---------------------------------------------------------------------------
namespace Relationship
{
	// The rank scale, at both ends. Callers clamp to this — SetRelationshipRank
	// takes a raw Int and the engine does not police it, so an out-of-range
	// value would be written and then read back as a level nothing recognises.
	inline constexpr int kMinRank = -4;
	inline constexpr int kMaxRank = 4;

	struct Status
	{
		// A RELA record actually exists between the player and this NPC.
		// FALSE IS NOT THE SAME AS RANK 0: "no record" means the game has never
		// had an opinion, while a real Acquaintance record is an opinion that
		// happens to be neutral. Some mods branch on the difference, so the card
		// says which one it is looking at rather than flattening both to zero.
		bool has = false;

		// -4 … +4. Meaningless unless `has`, in which case it is 0.
		int rank = 0;
	};

	// The player's rank with `actor`, read straight off the engine.
	// Safe on nullptr, on an actor with no base, and before a save is loaded.
	Status Of(RE::Actor* actor);

	// "Lover", "Friend", "Acquaintance"… — the Creation Kit's own words, so the
	// card's label matches what the player sees anywhere else in Skyrim.
	// Anything outside -4…+4 answers "Unknown" rather than indexing off the end.
	const char* LabelOf(int rank);

	// ---- the deck bridge ------------------------------------------------
	//
	// Request `fdRank`, reply pushed as `fdRankInfo`. The two names are
	// DISJOINT on purpose: a name used for both directions silently unplugs the
	// control — see [[prismaui-one-name-per-direction]], which cost four
	// features before it was written down.
	//
	// Request:
	//   { }                              read the crosshair target
	//   { "formId":"0x…", "plugin":"…" } read that actor instead
	//   { …, "rank": 2 }                 SET it to +2 (and read back)
	//
	// Reply:
	//   { "ok":true, "who":"Lydia", "formId":"0x…",
	//     "has":true, "rank":1, "label":"Friend",
	//     "wrote":true, "msg":"Lydia is now a Confidant" }
	//   { "ok":false, "msg":"They aren't loaded right now" }
	//
	// `wrote:true` means the SetRelationshipRank stack was queued, not that it
	// has run — `rank` in that reply is the requested value, and the authority
	// on what actually landed is the next read. MAIN THREAD ONLY (the VM
	// dispatch and the engine lookup both require it).
	std::string Handle(const std::string& reqJson);
}
