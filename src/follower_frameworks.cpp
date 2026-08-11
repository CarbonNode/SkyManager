#include "follower_frameworks.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and `using namespace std::literals`.

namespace FollowerFrameworks
{
	namespace
	{
		// ------------------------------------------------------------ table --

		// How the framework's wait/resume entry point wants to be called. Every
		// one of these was read out of the mod's OWN dialogue fragment, not
		// guessed — see the per-entry citation on each spec.
		enum class Args
		{
			None,        // fn()
			Actor,       // fn(akActor)
			ActorInt,    // fn(akActor, 1)
			ActorIntInt  // fn(akActor, 1, 0)
		};

		struct Spec
		{
			const char* plugin;       // the plugin that identifies this framework
			const char* label;        // what the player is told it is
			const char* scriptClass;  // Papyrus class bound to the controller QUEST
			const char* waitFn;
			Args        waitArgs;
			const char* resumeFn;
			Args        resumeArgs;
			// Match when the ACTOR's own base/reference comes from `plugin`.
			// Only safe for a one-companion mod whose controller quest acts on
			// its single alias.
			bool matchByActorPlugin;
			// Match when a quest whose alias the actor fills comes from
			// `plugin`. Safe for a general framework whose entry point takes
			// the actor explicitly.
			bool matchByAliasPlugin;
		};

		// ORDER MATTERS. A companion mod that has handed its follower to a
		// general framework matches BOTH its own entry and the framework's, and
		// its own entry is the better call — the mod's function knows which
		// backend it chose. So the specific mods come first and the first hit
		// wins.
		constexpr Spec kSpecs[] = {
			// Nether's Amaniri. nwsDENiri_Follower.DoWait(Actor) /
			// .DoFollow(Actor); decompiled from
			// mods\Nether's Amaniri\Scripts\nwsDENiri_Follower.pex. The script
			// itself branches on its controller's `compMode`: standalone it
			// sets WaitingForPlayer, otherwise it forwards to Nether's Follower
			// Framework. One call therefore covers both, which is exactly why
			// we call HER function rather than reimplementing either branch.
			{ "NWS_Amaniri.esp", "Nether's Amaniri", "nwsDENiri_Follower",
				"DoWait", Args::Actor, "DoFollow", Args::Actor, true, true },

			// Vayne Remastered. CSV_Vayne_Follower_Script.FollowerWait() /
			// .FollowerFollow(); decompiled from her mod's Scripts folder and
			// confirmed to be what her own CSV_Vayne_Wait1 /
			// Vayne_CSVP_FollowAgain1 dialogue fragments call. No actor
			// argument: the quest acts on its single FollowerAlias — which is
			// why this spec is deliberately restricted to Vayne herself.
			{ "CSV_Vayne.esp", "Vayne Remastered", "CSV_Vayne_Follower_Script",
				"FollowerWait", Args::None, "FollowerFollow", Args::None, true, true },

			// Nether's Follower Framework — the general case, and the backend
			// most of this playthrough's retinue actually runs on.
			// nwsFollowerControllerScript.FollowerWaitHere(actor, 1, 0) /
			// .FollowerFollowMe(actor, 1); the same two entry points the deck's
			// Followers tab already drives (see nff_control.cpp). Actor-taking,
			// so alias matching alone is enough to be precise.
			{ "nwsFollowerFramework.esp", "Nether's Follower Framework", "nwsFollowerControllerScript",
				"FollowerWaitHere", Args::ActorIntInt, "FollowerFollowMe", Args::ActorInt, false, true },
		};

		constexpr int kSpecCount = static_cast<int>(std::size(kSpecs));

		// ----------------------------------------------------------- helpers --

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		// The plugin a form was DEFINED in (index 0), not the last one to touch
		// it — an override in a patch must not rename the framework.
		std::string DefiningFile(const RE::TESForm* form)
		{
			if (!form)
				return {};
			const auto* file = form->GetFile(0);
			if (!file)
				return {};
			return Lower(file->GetFilename());
		}

		bool IsFollowish(const RE::TESPackage* pkg)
		{
			if (!pkg)
				return false;
			switch (pkg->packData.packType.get()) {
			case RE::PACKAGE_TYPE::kFollow:
			case RE::PACKAGE_TYPE::kEscort:
			case RE::PACKAGE_TYPE::kAccompany:
				return true;
			default:
				break;
			}
			switch (pkg->procedureType.get()) {
			case RE::PACKAGE_PROCEDURE_TYPE::kFollowWithEscort:
			case RE::PACKAGE_PROCEDURE_TYPE::kFollowWithoutEscort:
			case RE::PACKAGE_PROCEDURE_TYPE::kAccompany:
			case RE::PACKAGE_PROCEDURE_TYPE::kEscortActor:
			case RE::PACKAGE_PROCEDURE_TYPE::kKeepAnEyeOn:
				return true;
			default:
				return false;
			}
		}

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		// Does `form` carry `cls`? Papyrus is case-insensitive but the VM's
		// bound-object table is keyed by the name as registered, so try the
		// spelling we were given and then its lowercase form.
		bool HasScript(RE::TESForm* form, const char* cls)
		{
			auto* vm = Vm();
			if (!form || !cls || !vm)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(form->GetFormType(), form);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			if (vm->FindBoundObject(handle, cls, obj) && obj)
				return true;
			obj.reset();
			const auto lower = Lower(cls);
			if (lower != cls && vm->FindBoundObject(handle, lower.c_str(), obj) && obj)
				return true;
			return false;
		}

		// ------------------------------------------------ controller lookup --

		// Cache per spec. We store the FormID rather than the pointer and
		// re-resolve on every use: a static quest's pointer is stable for the
		// process, but re-resolving costs a hash lookup and cannot outlive the
		// form it names.
		struct QuestCache
		{
			bool       tried = false;
			RE::FormID id = 0;
		};

		std::array<QuestCache, static_cast<std::size_t>(kSpecCount)> g_questCache{};

		// Find the quest in `spec.plugin` that carries `spec.scriptClass`.
		// Candidate quests the actor is already aliased into are tried first —
		// that is both cheaper and more precise than a full-array scan — then
		// the plugin's whole quest list as a fallback.
		RE::TESQuest* ControllerQuest(int specIndex, const std::vector<RE::TESQuest*>& aliasQuests)
		{
			if (specIndex < 0 || specIndex >= kSpecCount)
				return nullptr;
			const Spec& sp = kSpecs[specIndex];

			auto& cache = g_questCache[static_cast<std::size_t>(specIndex)];
			if (cache.tried) {
				if (cache.id == 0)
					return nullptr;
				if (auto* form = RE::TESForm::LookupByID(cache.id))
					return form->As<RE::TESQuest>();
				// The cached form vanished (plugin unloaded between saves) —
				// fall through and look again rather than lie.
				cache.tried = false;
			}

			const std::string want = Lower(sp.plugin);

			auto accept = [&](RE::TESQuest* q) -> RE::TESQuest* {
				if (!q || DefiningFile(q) != want)
					return nullptr;
				if (!HasScript(q, sp.scriptClass))
					return nullptr;
				return q;
			};

			RE::TESQuest* found = nullptr;
			for (auto* q : aliasQuests) {
				if ((found = accept(q)) != nullptr)
					break;
			}
			if (!found) {
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
						if ((found = accept(q)) != nullptr)
							break;
					}
				}
			}

			cache.tried = true;
			cache.id = found ? found->GetFormID() : 0;
			if (!found)
				logger::warn("NpcActions: {} is loaded but no quest in it carries {}",
					sp.plugin, sp.scriptClass);
			return found;
		}

		// ------------------------------------------------------- dispatching --

		bool CallOn(RE::TESQuest* quest, const Spec& sp, const char* fn, Args shape, RE::Actor* actor)
		{
			auto* vm = Vm();
			if (!vm || !quest || !fn)
				return false;
			if (shape != Args::None && !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			switch (shape) {
			case Args::None: {
				auto args = RE::MakeFunctionArguments();
				return vm->DispatchMethodCall(handle, sp.scriptClass, fn, args, cb);
			}
			case Args::Actor: {
				auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
				return vm->DispatchMethodCall(handle, sp.scriptClass, fn, args, cb);
			}
			case Args::ActorInt: {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(static_cast<std::int32_t>(1)));  // iMessage: let it notify
				return vm->DispatchMethodCall(handle, sp.scriptClass, fn, args, cb);
			}
			case Args::ActorIntInt: {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(static_cast<std::int32_t>(1)),   // iMessage: let it notify
					std::move(static_cast<std::int32_t>(0)));  // not a permanent post
				return vm->DispatchMethodCall(handle, sp.scriptClass, fn, args, cb);
			}
			}
			return false;
		}
	}

	// ------------------------------------------------------------- probing --

	Detection Probe(RE::Actor* actor)
	{
		Detection d;
		if (!actor)
			return d;

		// (a) Which quests' aliases is this actor currently filling, and are any
		//     of those aliases running a follow-shaped package? An alias
		//     instance is the engine's own record of "this ref fills that
		//     quest's alias", so this is its conclusion, not our guess.
		std::vector<RE::TESQuest*> aliasQuests;
		std::vector<std::string>   aliasPlugins;

		if (auto* arr = actor->extraList.GetByType<RE::ExtraAliasInstanceArray>()) {
			RE::BSReadLockGuard locker(arr->lock);
			for (auto* inst : arr->aliases) {
				if (!inst || !inst->quest)
					continue;
				d.aliasDriven = true;
				if (std::find(aliasQuests.begin(), aliasQuests.end(), inst->quest) == aliasQuests.end()) {
					aliasQuests.push_back(inst->quest);
					aliasPlugins.push_back(DefiningFile(inst->quest));
				}
				if (!d.followPackage && inst->instancedPackages) {
					for (auto* pkg : *inst->instancedPackages) {
						if (IsFollowish(pkg)) {
							d.followPackage = true;
							break;
						}
					}
				}
			}
		}

		// (b) The package actually in force right now. CheckForCurrentAliasPackage
		//     is the engine answering "is what you are running an ALIAS package",
		//     which is precisely the thing that outranks our actor-level hold.
		if (auto* aliasPkg = actor->CheckForCurrentAliasPackage()) {
			d.aliasDriven = true;
			if (IsFollowish(aliasPkg))
				d.followPackage = true;
			if (auto* owner = aliasPkg->ownerQuest) {
				if (std::find(aliasQuests.begin(), aliasQuests.end(), owner) == aliasQuests.end()) {
					aliasQuests.push_back(owner);
					aliasPlugins.push_back(DefiningFile(owner));
				}
			}
		} else if (auto* cur = actor->GetCurrentPackage()) {
			if (cur->ownerQuest && IsFollowish(cur)) {
				d.aliasDriven = true;
				d.followPackage = true;
				if (std::find(aliasQuests.begin(), aliasQuests.end(), cur->ownerQuest) == aliasQuests.end()) {
					aliasQuests.push_back(cur->ownerQuest);
					aliasPlugins.push_back(DefiningFile(cur->ownerQuest));
				}
			}
		}

		// (c) A teammate held in an alias is a follower even when we caught her
		//     mid-combat or mid-dialogue, i.e. running a package that is not
		//     itself a follow. Without this the warning would go quiet in
		//     exactly the moments the hold matters most.
		if (d.aliasDriven && actor->IsPlayerTeammate())
			d.followPackage = true;

		// (d) Which framework is it? The actor's OWN plugin is checked first
		//     because a one-companion mod is identified by its NPC, and it is
		//     still the right answer when that mod has handed her to a general
		//     framework whose alias she also fills.
		const std::string basePlugin = DefiningFile(actor->GetActorBase());
		const std::string refPlugin = DefiningFile(actor);

		// Guard: an NPC who fills no alias and is not on the player's team is
		// nobody's follower, whatever plugin she came out of. Without this, a
		// shopkeeper shipped inside a companion mod would be "detected" and
		// handed a wait order she has no use for.
		const bool couldBeFollowing = d.aliasDriven || actor->IsPlayerTeammate();

		for (int i = 0; couldBeFollowing && i < kSpecCount; ++i) {
			const Spec&       sp = kSpecs[i];
			const std::string want = Lower(sp.plugin);
			bool              hit = false;

			if (sp.matchByActorPlugin && (basePlugin == want || refPlugin == want))
				hit = true;
			if (!hit && sp.matchByAliasPlugin &&
				std::find(aliasPlugins.begin(), aliasPlugins.end(), want) != aliasPlugins.end())
				hit = true;
			if (!hit)
				continue;

			// A name in the table is not a capability — prove the controller
			// quest is really there before promising the caller anything.
			if (!ControllerQuest(i, aliasQuests))
				continue;

			d.known = true;
			d.spec = i;
			d.label = sp.label;
			d.plugin = sp.plugin;
			// Something is holding her in an alias, whatever the package
			// happened to be at this instant.
			d.aliasDriven = true;
			d.followPackage = true;
			break;
		}

		// Unknown framework: report the alias plugin that is NOT the game or a
		// DLC, so the message can at least name the culprit.
		if (!d.known && d.aliasDriven && d.plugin.empty()) {
			static const std::array<std::string_view, 4> kStock = {
				"skyrim.esm"sv, "update.esm"sv, "dawnguard.esm"sv, "dragonborn.esm"sv
			};
			for (const auto& p : aliasPlugins) {
				if (p.empty())
					continue;
				if (std::find(kStock.begin(), kStock.end(), std::string_view(p)) != kStock.end())
					continue;
				d.plugin = p;
				break;
			}
			if (d.plugin.empty() && !aliasPlugins.empty())
				d.plugin = aliasPlugins.front();
		}

		return d;
	}

	int OwningCompanionSpec(RE::Actor* actor)
	{
		if (!actor)
			return -1;
		const std::string basePlugin = DefiningFile(actor->GetActorBase());
		const std::string refPlugin = DefiningFile(actor);
		for (int i = 0; i < kSpecCount; ++i) {
			const Spec& sp = kSpecs[i];
			if (!sp.matchByActorPlugin)
				continue;
			const std::string want = Lower(sp.plugin);
			if (basePlugin == want || refPlugin == want)
				return i;
		}
		return -1;
	}

	// ------------------------------------------------------------- ordering --

	bool AlreadyWaiting(RE::Actor* actor)
	{
		if (!actor)
			return false;
		auto* avo = actor->AsActorValueOwner();
		if (!avo)
			return false;
		// Every framework in the table — and vanilla — parks a follower by
		// raising this actor value; it is the one piece of state they all
		// agree on, so it is what we read to avoid resuming someone who was
		// deliberately left behind.
		return avo->GetActorValue(RE::ActorValue::kWaitingForPlayer) >= 0.5f;
	}

	bool SendWait(RE::Actor* actor, const Detection& detection)
	{
		if (!actor || !detection.known || detection.spec < 0 || detection.spec >= kSpecCount)
			return false;
		const Spec& sp = kSpecs[detection.spec];
		auto*       quest = ControllerQuest(detection.spec, {});
		if (!quest)
			return false;
		const bool sent = CallOn(quest, sp, sp.waitFn, sp.waitArgs, actor);
		logger::info("NpcActions: framework wait {} via {}.{} ({})",
			sent ? "sent" : "REFUSED", sp.scriptClass, sp.waitFn, sp.label);
		return sent;
	}

	bool SendResume(RE::Actor* actor, int spec)
	{
		if (!actor || spec < 0 || spec >= kSpecCount)
			return false;
		const Spec& sp = kSpecs[spec];
		auto*       quest = ControllerQuest(spec, {});
		if (!quest)
			return false;
		const bool sent = CallOn(quest, sp, sp.resumeFn, sp.resumeArgs, actor);
		logger::info("NpcActions: framework resume {} via {}.{} ({})",
			sent ? "sent" : "REFUSED", sp.scriptClass, sp.resumeFn, sp.label);
		return sent;
	}

	const char* Label(int spec)
	{
		if (spec < 0 || spec >= kSpecCount)
			return "";
		return kSpecs[spec].label;
	}

	std::string Summarise(const Detection& d)
	{
		std::string out;
		out += d.aliasDriven ? "alias-driven" : "not alias-driven";
		if (d.followPackage)
			out += ", follow pkg";
		if (d.known)
			out += ", framework=" + d.label;
		else if (!d.plugin.empty())
			out += ", unknown framework from " + d.plugin;
		return out;
	}
}
