#pragma once

#include <string>

#include "json.hpp"   // same as pch.h's copy; the include guard makes it a no-op

namespace RE
{
	class Actor;
}

// Fertility Mode bridge — pregnancy / cycle state for an actor.
//
// Reads Fertility Mode v3's own storage directly. FM keeps everything in plain
// Papyrus properties on a quest script (`_JSW_BB_Storage Extends Quest`), as
// parallel arrays indexed by the actor's slot in `TrackedActors` — no
// StorageUtil, no JContainers, nothing to call. So this is a synchronous read
// of script properties, the same shape as the NFF bridge, with no Papyrus
// dispatch and no callbacks.
//
// The rules below are FM's own, lifted from its MCM (`_JSW_SUB_ConfigQuestScript`)
// so the deck can never disagree with what FM shows:
//
//     index      = TrackedActors.find(actor)      (-1 = not tracked)
//     pregnant   = LastConception[index] != 0.0
//     day        = int(GameDaysPassed - LastConception[index])
//     father     = CurrentFatherForm[index] -> display name
//
// Everything degrades quietly: no FM installed, FM not yet initialised, an
// untracked actor, or a male all return a Status with `available`/`tracked`
// false rather than failing.
namespace FertilityBridge
{
	struct Status
	{
		bool available = false;  // Fertility Mode found and readable
		bool tracked = false;    // this actor has a slot in TrackedActors
		bool blocked = false;    // on FM's ActorBlackList
		bool pregnant = false;

		int         index = -1;
		int         pregnancyDay = 0;   // days since conception
		int         termDays = 0;       // FM's PregnancyDuration (MCM, default 30)
		int         percent = 0;        // progress through the term, 0-100
		int         trimester = 0;      // 1-3, 0 when the term is unknown
		std::string father;             // display name, empty if unknown
		int         cycleDay = 0;
		int         spermCount = 0;
		int         timesDelivered = 0;
		int         lastBirthDay = 0;   // 0 = never given birth
		bool        ovulating = false;
	};

	// Status for one actor. Cheap enough to call per follower row.
	Status For(RE::Actor* actor);

	// The same, as the object the Followers pane consumes.
	nlohmann::json ToJson(const Status& status);

	// Convenience: For() + ToJson().
	nlohmann::json JsonFor(RE::Actor* actor);

	// Drop the cached quest handle. Call on save load — a bound object from the
	// previous session is not valid in the next one.
	void Invalidate();

	// Whether Fertility Mode is present at all, for a one-off capability check.
	bool Available();

	// Statuses for every member in Follower Organizer's state, keyed by the same
	// formId string FO uses — the shape the Followers pane already consumes for
	// NffBridge. Pushed to the view as its own side channel (`fdFertility`)
	// rather than merged into FO's state, so FO stays the sole owner of its JSON.
	//
	// MAIN THREAD ONLY, like every other RE:: path here.
	std::string StateJson(const std::string& foStateJson);

	// Convenience: fetches Follower Organizer's state itself. Use the overload
	// above when the caller already has it — one FO build serves both.
	std::string StateJson();
}
