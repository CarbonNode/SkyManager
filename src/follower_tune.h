#pragma once

#include <string>
#include <vector>

#include "json.hpp"

// Her stats, and REMEMBERING them.
//
// "id like more control over followers on the followers tab, set essential,
// set health or hp, share spells (all persistent and remembered)" — Rober,
// 2026-08-03. The parenthesis is the whole design brief.
//
// WHY REMEMBERING IS THE HARD PART. Every one of these writes lands in the
// save on its own — that is what the console equivalents do — but a follower
// is not a static thing:
//
//   * a leveled actor RECALCULATES her actor values when the player levels,
//     which quietly undoes a base-health change;
//   * follower frameworks re-apply their own template on recruit/dismiss;
//   * an actor whose cell resets can be rebuilt from her base record;
//   * and a mod update, a save reload after a crash, or a "clean save" pass
//     puts her back the way her plugin describes her.
//
// So the deck stores the INTENT — "she is essential, her health is 750, she
// knows these three spells" — and re-applies it: on every game load, and
// whenever the Followers tab asks about her. Applying is idempotent, so a
// re-apply that was not needed costs a comparison.
//
// IDENTITY is the durable pair (local FormID + defining plugin) that
// ActorIdentity defines, never a runtime id — see actor_identity.h for the
// light-plugin trap that makes a stored runtime id point at a stranger.
//
// WHAT IS DELIBERATELY NOT HERE. Nothing that needs Papyrus, and nothing that
// spawns or destroys a form: every op is a synchronous engine write on an
// actor that is already loaded, so an op either happens now or is refused now.
namespace FollowerTune
{
	struct SpellRef
	{
		std::string formId;   // "0x81A" — local id, per ActorIdentity
		std::string plugin;
		std::string name;     // last known, for the list when she is unloaded
	};

	struct Record
	{
		std::string formId;
		std::string plugin;
		std::string name;                 // last known display name, for the UI

		// Tri-state on purpose: "leave it alone" is not the same as "off".
		// Setting essential OFF is a real instruction the deck must remember and
		// re-apply, or the actor's own base flag would win on the next load.
		int   essential = -1;             // -1 unset · 0 off · 1 on
		int   protectedFlag = -1;

		// The three pools, each 0 = unset. All three and not just health,
		// because a follower you gave 2000 hit points and left with a mage's
		// stamina is not "tougher", she is a punching bag that cannot sprint
		// (Rober, 2026-08-03).
		float health = 0.0f;              // BASE value, not current
		float magicka = 0.0f;
		float stamina = 0.0f;

		std::vector<SpellRef> spells;
		std::vector<SpellRef> perks;      // same shape: a durable form reference

		bool empty() const
		{
			return essential < 0 && protectedFlag < 0 && health <= 0.0f &&
				magicka <= 0.0f && stamina <= 0.0f && spells.empty() && perks.empty();
		}
	};

	struct Config
	{
		std::vector<Record> rows;
	};

	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& c);

	// What the card renders for ONE actor: the live engine truth AND what we
	// have remembered, kept apart, because "she is essential right now" and
	// "the deck will keep her essential" are different facts and a UI that
	// conflates them cannot show a re-apply failing.
	nlohmann::json StateFor(const Config& c, RE::Actor* actor);

	// One op from the view. `req` is the parsed fdTune payload; `changed` is
	// set when the config needs persisting. Returns the reply envelope.
	nlohmann::json Apply(Config& c, const nlohmann::json& req, bool& changed);

	// Re-apply every remembered record whose actor resolves right now. Called
	// on game load and when the Followers tab opens. Returns how many actors
	// were touched, for the log.
	int Reapply(const Config& c);

	// The player's spellbook, as the "share a spell" picker's source. A thin
	// wrapper over the Spell Deck's own enumeration so there is one definition
	// of "a spell you know".
	nlohmann::json PlayerSpellsJson();

	// Every named perk in the load order, for the grant picker. Big (vanilla
	// alone is ~700), so the view filters — the same bargain the spell picker
	// makes. Sorted by name so the list is scannable before you type.
	nlohmann::json AllPerksJson();
}
