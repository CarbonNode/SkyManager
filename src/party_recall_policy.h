#pragma once

// Engine-independent eligibility. Proven 2026-09-26, when Rober's F17 press
// summoned Vilja, Windy and Katana, none of whom he had ever met:
//   * IsPlayerTeammate() ALONE is not "following". Vilja's plugin flags her and
//     her "Outfit configuration" dummy at startup; a pet mod flags a parked fox
//     in its wait room; a slave with a sandbox package keeps a stale flag.
//   * CurrentFollowerFaction rank 0 ALONE is not "following" either. Katana's
//     ESP lists all four vanilla follower factions statically.
// Following therefore needs ONE of:
//   * a verified custom-framework adapter saying so;
//   * the engine's own recruit contract, BOTH halves at once (teammate AND
//     current-follower rank >= 0: vanilla and NFF set and clear them together);
//   * a follower alias on NFF's / vanilla's DialogueFollower quest, backed by
//     either half (the alias is cleared on dismiss; the half rules out a
//     non-follower alias such as a horse or a holding slot);
//   * a CUSTOM follower system (Vayne, Amaniri, Vilja once recruited, any
//     one-companion mod): the actor is a teammate AND the package her AI is
//     running RIGHT NOW is a follow / escort / accompany. A recruited custom
//     companion runs her mod's follow package; the same NPC parked in a
//     tavern runs a sandbox, whatever flags her plugin left on her. The
//     teammate half keeps quest escorts of other NPCs out. (Rober,
//     2026-09-26: "or custom follower system?")
//   * the REGISTER (Rober, 2026-09-26: "a page of current follows and
//     register or deregister"): "always" is proof by decree for the mod whose
//     following the engine cannot read; "never" is a veto that beats every
//     other basis. Kept in party-recall.json as (local id + plugin).
// A roster entry (Follower Organizer) or a world-sweep hit is a candidate,
// never proof. A negative faction rank is dismissed.
namespace PartyRecall::Policy
{
	enum class Decision { Ignore, Waiting, Busy, Recall };
	struct Evidence
	{
		bool teammate = false;
		bool currentFaction = false;
		int factionRank = -1;
		bool frameworkFollowing = false;
		bool alias = false;
		bool followPackage = false; // the CURRENT package is follow-shaped, not "has one somewhere"
		bool registered = false;    // register says "always"
		bool blocked = false;       // register says "never"
		bool unavailable = false;
		bool waiting = false;
		bool busy = false;
	};
	constexpr bool FactionFollowing(const Evidence& e) { return e.currentFaction && e.factionRank >= 0; }
	// Which evidence proves the actor is following; nullptr when nothing does.
	constexpr const char* Basis(const Evidence& e)
	{
		if (e.blocked) return nullptr;
		if (e.registered) return "registered";
		if (e.frameworkFollowing) return "framework";
		if (e.teammate && FactionFollowing(e)) return "engine";
		if (e.alias && (e.teammate || FactionFollowing(e))) return "alias";
		if (e.teammate && e.followPackage) return "package";
		return nullptr;
	}
	// One half of the recruit contract without its partner: a flag some mod set
	// on an NPC the player never recruited. Counted and named, never summoned.
	constexpr bool FlaggedOnly(const Evidence& e)
	{
		return !Basis(e) && !e.blocked && (e.teammate || FactionFollowing(e));
	}
	constexpr Decision Decide(const Evidence& e)
	{
		if (e.unavailable || !Basis(e)) return Decision::Ignore;
		if (e.waiting) return Decision::Waiting;
		if (e.busy) return Decision::Busy;
		return Decision::Recall;
	}
	constexpr bool KeyValid(int key) { return key > 1 && key < 256; }
	// -2 = unavailable script; -1 = NFF's documented unassigned value.
	constexpr bool CanClaim(int savedKey, int nffKey)
	{
		return KeyValid(savedKey) && (nffKey == -1 || nffKey == savedKey);
	}
}
