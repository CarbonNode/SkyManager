#include "relationship.h"

#include "actor_identity.h"
#include "npc_actions.h"   // TargetFormID: the crosshair snapshot taken at palette-open

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>

// pch (force-included) provides RE::/SKSE::, nlohmann/json and
// `using namespace std::literals` — same as nff_control.cpp / mhiyh_control.cpp,
// which likewise do not include the json header themselves.

using json = nlohmann::json;

namespace Relationship
{
	namespace
	{
		// ------------------------------------------------------------ ids ----
		// Local copies of the same four helpers nff_control.cpp keeps in its own
		// anonymous namespace. Deliberate: they are four lines each, and every
		// module in this plugin owning its own has kept the id conventions from
		// drifting into a shared header nobody dares change.

		std::uint32_t ParseHex(const std::string& s)
		{
			if (s.empty())
				return 0;
			try {
				return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		// One implementation, in ActorIdentity — three byte-identical private
		// copies of this used to exist, and none of them were the one the crash
		// sites called. Same contract as before: the durable local id, falling
		// back to the runtime id for a dynamic form. Now also null-form-safe.
		std::uint32_t LocalIdOf(const RE::TESForm* form)
		{
			return ActorIdentity::BestIdOf(form);
		}

		std::string HexOf(std::uint32_t id)
		{
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "0x%08X", id);
			return buf;
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (actor) {
				if (auto* base = actor->GetActorBase()) {
					if (const char* n = base->GetFullName(); n && *n)
						return n;
				}
			}
			return "They";
		}

		// A named actor, or the crosshair snapshot when nothing was named — the
		// same contract NffControl::TargetOf implements, so "the person on the
		// card" means one thing across every bridge the card uses.
		RE::Actor* TargetOf(const json& j)
		{
			const auto fid = j.value("formId", std::string(""));
			if (!fid.empty()) {
				const auto local = ParseHex(fid);
				if (!local)
					return nullptr;
				const auto plugin = j.value("plugin", std::string(""));
				if (!plugin.empty()) {
					if (auto* dh = RE::TESDataHandler::GetSingleton()) {
						if (auto* f = dh->LookupForm(local, plugin))
							return f->As<RE::Actor>();
					}
				}
				if (auto* f = RE::TESForm::LookupByID(local))
					return f->As<RE::Actor>();
				return nullptr;
			}
			if (const auto id = NpcActions::TargetFormID())
				return RE::TESForm::LookupByID<RE::Actor>(id);
			return nullptr;
		}

		// ------------------------------------------------------- the scale ---
		//
		// RELATIONSHIP_LEVEL counts DOWNWARDS from the friendliest: kLover is 0
		// and kArchnemesis is 8, while the rank everybody quotes (the console's
		// setrelationshiprank, Papyrus, every condition function) counts UPWARDS
		// from -4 to +4. So rank = 4 - level, and getting that backwards turns
		// your wife into your archnemesis with no error anywhere.
		int RankOfLevel(std::uint8_t level)
		{
			return 4 - static_cast<int>(level);
		}
	}

	const char* LabelOf(int rank)
	{
		switch (rank) {
		case 4:  return "Lover";
		case 3:  return "Ally";
		case 2:  return "Confidant";
		case 1:  return "Friend";
		case 0:  return "Acquaintance";
		case -1: return "Rival";
		case -2: return "Foe";
		case -3: return "Enemy";
		case -4: return "Archnemesis";
		default: return "Unknown";
		}
	}

	Status Of(RE::Actor* actor)
	{
		Status st;
		if (!actor)
			return st;

		auto* base = actor->GetActorBase();
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* playerBase = player ? player->GetActorBase() : nullptr;
		if (!base || !playerBase || base == playerBase)
			return st;

		// Asked BOTH WAYS ROUND on purpose. A RELA record names an npc1 and an
		// npc2 and the pair is ordered — a record authored as (Lydia, Player) is
		// not obviously found by a search for (Player, Lydia), and which way
		// round any given record was authored is the plugin author's choice, not
		// ours. The second lookup costs one call and removes the entire class of
		// "the deck says Acquaintance, the console says Lover" bug.
		auto* rel = RE::BGSRelationship::GetRelationship(base, playerBase);
		if (!rel)
			rel = RE::BGSRelationship::GetRelationship(playerBase, base);
		if (!rel)
			return st;

		st.has = true;
		st.rank = RankOfLevel(rel->level.underlying());
		return st;
	}

	std::string Handle(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		const json req = (j.is_discarded() || !j.is_object()) ? json::object() : j;

		auto* actor = TargetOf(req);
		if (!actor)
			return json{ { "ok", false },
				{ "msg", "They aren't loaded right now" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto who = NameOf(actor);

		// ---- the write half, when a rank came with the request --------------
		bool wrote = false;
		int  want = 0;
		if (req.contains("rank") && req["rank"].is_number()) {
			want = std::clamp(req["rank"].get<int>(), kMinRank, kMaxRank);

			// The player has no relationship with himself, and asking the engine
			// to make one is how you get an unanswerable record.
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || actor == player) {
				return json{ { "ok", false }, { "who", who },
					{ "msg", "That is you" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm) {
				return json{ { "ok", false }, { "who", who },
					{ "msg", "The script engine isn't up yet" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			auto* policy = vm->GetObjectHandlePolicy();
			const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle()) {
				return json{ { "ok", false }, { "who", who },
					{ "msg", who + " has no script handle — Papyrus can't reach them" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Actor.SetRelationshipRank(Actor akOther, Int aiRank), dispatched on
			// HER handle with the player as the other party. No callback: the
			// native returns None, and the truthful answer to "did it land" is
			// the next read, not a boolean from the VM.
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(player)),
				std::move(static_cast<std::int32_t>(want)));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", "SetRelationshipRank", args, cb);
			wrote = true;
			logger::info("relationship: set {} to {} ({})", who, want, LabelOf(want));
		}

		// ---- the read half, always ------------------------------------------
		//
		// After a write this is still the PRE-write value: the stack we just
		// queued has not run. Reporting the requested rank instead would be a
		// lie in the one case that matters (the VM refusing), so the reply says
		// `wrote` and lets the view re-ask a beat later for the truth.
		const auto st = Of(actor);
		const int  shown = wrote ? want : st.rank;

		return json{
			{ "ok", true },
			{ "who", who },
			{ "formId", HexOf(LocalIdOf(actor)) },
			{ "has", wrote ? true : st.has },
			{ "rank", shown },
			{ "label", LabelOf(shown) },
			{ "wrote", wrote },
			{ "msg", wrote ? (who + " is now " + std::string(LabelOf(want)) + " to you")
			               : std::string("") },
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
