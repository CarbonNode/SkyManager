#include "trade_actions.h"

#include "actor_identity.h"
#include "maras.h"
#include "nff_control.h"
#include "npc_actions.h"
#include "relationship.h"

#include <cstdio>
#include <string>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace TradeActions
{
	namespace
	{
		using json = nlohmann::json;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Refuse(const std::string& msg)
		{
			return Dump(json{ { "ok", false }, { "phase", "refused" }, { "msg", msg } });
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (!actor)
				return "They";
			if (const char* n = actor->GetDisplayFullName(); n && *n)
				return n;
			return "They";
		}

		// Actor.ShowBarterMenu() — a Papyrus native with no C++ twin, so it goes
		// through the VM on the ACTOR's own handle, exactly like
		// nff_control.cpp's CallOpenInventory does for OpenInventory.
		//
		// No callback, deliberately: ShowBarterMenu is a plain `Function`
		// returning None (see the Callback note in nff_control.cpp), so reaching
		// a callback would prove only that the stack RAN — and by then the
		// palette is shut and there is no card left to tell. The empty
		// BSTSmartPointer is the same shape npc_actions.cpp and quick_light.cpp
		// already use for fire-and-forget dispatches.
		bool CallShowBarterMenu(RE::Actor* actor)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return false;

			auto args = RE::MakeFunctionArguments();
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return vm->DispatchMethodCall(handle, "Actor", "ShowBarterMenu", args, cb);
		}

		// Is the player mid-conversation with THIS actor? Same read room_guard
		// uses before it moves anybody — pulling the menu out from under a
		// running dialogue scene is how a quest breaks.
		bool TalkingToUs(RE::Actor* actor)
		{
			if (auto* mtm = RE::MenuTopicManager::GetSingleton()) {
				auto speaker = mtm->speaker.get();
				if (speaker && speaker.get() == static_cast<RE::TESObjectREFR*>(actor))
					return true;
			}
			return false;
		}

		// ------------------------------------------------------ the rules ----
		//
		// "Companion or spouse" (QuickTrade's own wording) resolved from what the
		// deck ALREADY knows, never a new heuristic:
		//
		//   * IsPlayerTeammate() is the engine flag every follower framework
		//     sets and the one nff_control's IsFollowing() and LoadedTeammates()
		//     already read. It is also why ANIMAL companions need no special
		//     case — a pet follower is a teammate like anyone else, which is the
		//     behaviour QuickTrade has.
		//   * Marriage: M.A.R.A.S when it is installed (maras.h — the faction
		//     rank mirror, rank 2 exactly), else the engine RELA rank of Lover,
		//     which is what a vanilla wedding writes. Deliberately NOT a
		//     hardcoded spouse-faction FormID: none was verifiable here, and a
		//     guessed id resolves to somebody else's record.
		//     Known, accepted miss: a non-spouse the player has set to Lover
		//     gets her pack instead of a barter window. Harmless, and the button
		//     says which one it will do before you press it.
		bool IsCompanionOrSpouse(RE::Actor* actor)
		{
			if (!actor)
				return false;
			if (actor->IsPlayerTeammate())
				return true;
			if (Maras::Of(actor).spouse)
				return true;
			const auto rel = Relationship::Of(actor);
			return rel.has && rel.rank >= Relationship::kMaxRank;   // +4 Lover
		}

		// The whole verb: decide, refuse honestly, or dispatch.
		// `forceInventory` is the "Trade: inventory" override — QuickTrade's MCM
		// "force inventory" setting, as a second bindable action rather than a
		// setting, because the deck has no MCM and a key is what Rober asked for.
		std::string Open(RE::Actor* actor, bool forceInventory, bool named)
		{
			if (!actor)
				return Refuse(named ? "They aren't loaded right now"
									: "Look at someone first, then fire Trade");
			if (actor->IsPlayerRef())
				return Refuse("That's you");

			const std::string name = NameOf(actor);

			if (actor->IsDead())
				return Refuse(name + " is dead - loot them in the world instead");
			if (!actor->Is3DLoaded())
				return Refuse(name + " isn't loaded right now - get closer first");
			if (TalkingToUs(actor))
				return Refuse(name + " is mid-conversation - finish talking first");
			if (actor->IsInKillMove())
				return Refuse(name + " is in a kill move - wait for it to finish");

			// QuickTrade's first rule, and the one that matters most: a hostile
			// NPC never trades. Applies to BOTH modes — a hostile actor's pack is
			// a pickpocket window, not a trade, and opening it mid-fight is jank
			// rather than a feature.
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (player && actor->IsHostileToActor(player))
				return Refuse(name + " is hostile - nobody trades with a drawn blade");

			const bool inventory = forceInventory || IsCompanionOrSpouse(actor);

			// BARTER-ONLY gates. They do not apply to the pack, on purpose: the
			// card's existing "Inventory" button has never had them either, and
			// handing a follower a potion mid-fight is the case people actually
			// want. Making the new button stricter than the one beside it would
			// read as broken.
			if (!inventory) {
				if (actor->IsInCombat())
					return Refuse(name + " is fighting - trade when it's over");

				// QuickTrade's "at least neutral disposition". The engine's
				// readable stand-in is the RELA rank (relationship.h). NO RECORD
				// IS NOT A NEGATIVE RECORD: most of Skyrim has never had an
				// opinion of you, and refusing everyone without a record would
				// refuse almost every merchant in the game. So only a rank that
				// EXISTS and is below Acquaintance refuses.
				const auto rel = Relationship::Of(actor);
				if (rel.has && rel.rank < 0)
					return Refuse(name + " thinks of you as " +
						std::string(Relationship::LabelOf(rel.rank)) +
						" - below the neutral footing trading needs");
			}

			// Build marker (hd-markers.json: "trade-actions").
			logger::info("trade-action: opening the {} for '{}' ({:08X})",
				inventory ? "pack" : "barter menu", name, actor->GetFormID());

			if (inventory) {
				// ONE implementation of "open a pack" — NFF's, with its
				// broken-inventory freeze guard. See the header for why this is
				// delegated rather than re-dispatched here.
				//
				// The runtime FormID with no plugin is exactly what
				// NffControl's own resolver falls back to (LookupByID), and it
				// is the same "0x%08X" shape main.cpp already hands MhiyhControl.
				char buf[16]{};
				std::snprintf(buf, sizeof(buf), "0x%08X", actor->GetFormID());
				return NffControl::Apply(
					Dump(json{ { "op", "inventory" }, { "formId", std::string(buf) } }),
					nullptr);
			}

			if (!CallShowBarterMenu(actor))
				return Refuse("Could not reach the barter menu - no save loaded?");

			return Dump(json{
				{ "ok", true }, { "phase", "sent" }, { "op", "trade" },
				{ "via", "engine" }, { "mode", "barter" }, { "name", name },
				{ "msg", "Trading with " + name } });
		}

		void Say(const std::string& env)
		{
			const auto d = json::parse(env, nullptr, false);
			if (!d.is_object())
				return;
			const std::string msg = d.value("msg", std::string());
			if (!msg.empty())
				RE::DebugNotification(msg.c_str());
		}
	}

	bool IsAction(const std::string& idOrOp)
	{
		return idOrOp == "trade" || idOrOp == "trade-inventory" || idOrOp == "tradeInventory";
	}

	void Fire(const std::string& action)
	{
		auto* actor = RE::TESForm::LookupByID<RE::Actor>(NpcActions::TargetFormID());
		Say(Open(actor, action == "trade-inventory" || action == "tradeInventory",
			/*named*/ false));
	}

	std::string Apply(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("Trade: bad request");

		const std::string op  = j.value("op", std::string());
		const std::string fid = j.value("formId", std::string());

		// An explicit formId means the card is pointed at somebody you are not
		// necessarily looking at (the party strip pick). Empty means "whoever was
		// under the crosshair when the palette opened" — and the two need
		// different words when nobody resolves, which is why `named` is passed
		// down rather than recomputed from a null actor.
		RE::Actor* actor = nullptr;
		if (!fid.empty())
			actor = ActorIdentity::ResolveActor(fid, j.value("plugin", std::string()));
		else if (const auto id = NpcActions::TargetFormID())
			actor = RE::TESForm::LookupByID<RE::Actor>(id);

		return Open(actor, op == "tradeInventory" || op == "trade-inventory", !fid.empty());
	}
}
