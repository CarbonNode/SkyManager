#include "quick_light.h"

// pch (force-included) provides RE::/SKSE:: and nlohmann json (<json.hpp>).

namespace QuickLight
{
	namespace
	{
		constexpr const char* kPlugin = "QuickLight.esp";

		// Resolved by editor id first (po3 Tweaks' cache is on this load order),
		// FormID + plugin as the fallback so it still works if that cache is
		// off. Local FormIDs read out of QuickLight.esp's bytes.
		constexpr const char* kQuestEdid = "aaaQLQuest";
		constexpr RE::FormID  kQuestId = 0x000D62;

		constexpr const char* kAliasName = "Player";
		constexpr const char* kAliasScript = "aaaQLPlayerAliasScript";

		// The four brightness-variant self effects. The player carries exactly
		// one while the light is on; which one depends on the MCM brightness.
		struct FormRef
		{
			const char*  edid;
			RE::FormID   id;
		};
		constexpr FormRef kEffects[] = {
			{ "aaaQLLightSelf", 0x000800 },
			{ "aaaQLLightSelfSlightlyBright", 0x00080D },
			{ "aaaQLLightSelfBright", 0x000808 },
			{ "aaaQLLightSelfWide", 0x000809 },
		};

		template <class T>
		T* Resolve(const char* edid, RE::FormID localId)
		{
			if (auto* f = RE::TESForm::LookupByEditorID<T>(edid))
				return f;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				return dh->LookupForm<T>(localId, kPlugin);
			return nullptr;
		}

		RE::TESQuest* Quest()
		{
			return Resolve<RE::TESQuest>(kQuestEdid, kQuestId);
		}

		// True iff the player currently carries any Quick Light self effect —
		// the mod's own definition of "the light is on".
		bool LightOn()
		{
			auto* pc = RE::PlayerCharacter::GetSingleton();
			if (!pc)
				return false;
			auto* mt = pc->AsMagicTarget();
			if (!mt)
				return false;
			for (const auto& fr : kEffects) {
				if (auto* eff = Resolve<RE::EffectSetting>(fr.edid, fr.id))
					if (mt->HasMagicEffect(eff))
						return true;
			}
			return false;
		}

		RE::BGSBaseAlias* PlayerAlias(RE::TESQuest* quest)
		{
			if (!quest)
				return nullptr;
			for (auto* a : quest->aliases) {
				if (a && a->aliasName == kAliasName)
					return a;
			}
			return nullptr;
		}

		// Dispatch a no-arg method on the Quick Light player alias's script
		// through the Papyrus VM. Handle comes from the alias object + its
		// VMTypeID (140 for a ref alias) — the standard alias-handle path, the
		// same GetHandleForObject/DispatchMethodCall shape follower_frameworks
		// uses on a quest handle.
		bool CallAlias(const char* fn)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			auto* alias = PlayerAlias(Quest());
			if (!alias)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(alias->GetVMTypeID(), alias);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchMethodCall(handle, kAliasScript, fn, args, cb);
		}

		std::string Reply(bool ok, bool on, const char* msg)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["on"] = on;
			j["msg"] = msg ? msg : "";
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	std::string StateJson()
	{
		auto*      quest = Quest();
		const bool installed = quest != nullptr;
		const bool running = installed && quest->IsRunning();
		const bool on = running && LightOn();

		// Reached on every qlGet (each Light-tab open + poll): the marker.
		logger::info("quick-light state: installed={} running={} on={}", installed, running, on);

		nlohmann::json j;
		j["ok"] = true;
		j["installed"] = installed;
		j["running"] = running;
		j["on"] = on;
		return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string TurnOn()
	{
		auto* quest = Quest();
		if (!quest)
			return Reply(false, false, "Quick Light isn't installed");
		if (!quest->IsRunning())
			return Reply(false, false, "Quick Light is turned off in its MCM");
		if (LightOn())
			return Reply(true, true, "already on");
		const bool ok = CallAlias("CastLight");  // toggles OFF -> ON, mod's own brightness
		return Reply(ok, ok, ok ? "light on" : "couldn't reach Quick Light");
	}

	std::string TurnOff()
	{
		auto* quest = Quest();
		if (!quest)
			return Reply(false, false, "Quick Light isn't installed");
		if (!quest->IsRunning())
			return Reply(false, false, "Quick Light is turned off in its MCM");
		if (!LightOn())
			return Reply(true, false, "already off");
		const bool ok = CallAlias("RemoveLight");  // explicit off
		return Reply(ok, ok ? false : true, ok ? "light off" : "couldn't reach Quick Light");
	}

	std::string Toggle()
	{
		auto* quest = Quest();
		if (!quest)
			return Reply(false, false, "Quick Light isn't installed");
		if (!quest->IsRunning())
			return Reply(false, false, "Quick Light is turned off in its MCM");
		const bool was = LightOn();
		const bool ok = CallAlias("CastLight");
		return Reply(ok, ok ? !was : was,
			ok ? (was ? "light off" : "light on") : "couldn't reach Quick Light");
	}

	bool IsAction(const std::string& a)
	{
		return a == "quick-light";
	}
}
