#include "combat_tools.h"

#include "smf_index.h"

#include <cctype>

// <Windows.h> arrives without NOMINMAX: GetObject would rename
// BSScript::Variable::GetObject (the cross-module trap in CLAUDE.md).
#ifdef GetObject
#	undef GetObject
#endif

namespace CombatTools
{
	namespace
	{
		using json = nlohmann::json;

		// FightWithMe.dll's plain C export (its include/FightWithMeAPI.h):
		// opens the battle plan, returns whether SMF's window was available.
		using OpenBattlePlanFn = bool (*)();

		OpenBattlePlanFn BattlePlanFn()
		{
			const HMODULE module = GetModuleHandleW(L"FightWithMe.dll");
			if (!module)
				return nullptr;
			return reinterpret_cast<OpenBattlePlanFn>(GetProcAddress(module, "FightWithMe_OpenBattlePlan"));
		}

		std::string OpenBattlePlan()
		{
			std::string why;
			const auto  open = BattlePlanFn();
			if (!open) {
				BattlePlanAvailable(why);
				RE::DebugNotification(why.c_str());
				return "combat-tools: battle plan refused - " + why;
			}
			// false = Fight With Me's own SMF window is missing; it already put
			// its own HUD message up ("the battle plan needs SKSE Menu Framework 3").
			const bool ok = open();
			logger::info("combat-tools: battle plan opened (FightWithMe_OpenBattlePlan -> {})", ok);   // marker: combat-tools-battle-plan
			return ok ? "combat-tools: battle plan open" : "combat-tools: Fight With Me has no battle plan window (SKSE Menu Framework 3 missing?)";
		}

		// ---- NFF ------------------------------------------------------------
		using Object = RE::BSTSmartPointer<RE::BSScript::Object>;
		constexpr const char* kNffPlugin = "nwsFollowerFramework.esp";
		constexpr const char* kNffMcm = "nwsFollowerMCMScript";
		RE::FormID            g_nffMcmQuest = 0;   // cached once found

		Object Bind(RE::TESForm* form, const char* script)
		{
			Object obj;
			auto*  vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto*  policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!form || !policy)
				return obj;
			const auto h = policy->GetHandleForObject(form->GetFormType(), form);
			if (h == policy->EmptyHandle())
				return obj;
			if (!vm->FindBoundObject(h, script, obj)) {
				std::string lower(script);
				for (auto& ch : lower)
					ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
				vm->FindBoundObject(h, lower.c_str(), obj);
			}
			return obj;
		}

		// NFF's MCM quest: the nwsFollowerFramework.esp quest carrying
		// nwsFollowerMCMScript (the party_recall.cpp lookup, same reasons).
		Object NffMcm()
		{
			if (g_nffMcmQuest)
				if (auto obj = Bind(RE::TESForm::LookupByID(g_nffMcmQuest), kNffMcm))
					return obj;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !dh->LookupModByName(kNffPlugin))
				return {};
			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				const auto* file = q ? q->GetFile(0) : nullptr;
				if (!file || _stricmp(std::string(file->GetFilename()).c_str(), kNffPlugin) != 0)
					continue;
				if (auto obj = Bind(q, kNffMcm)) {
					g_nffMcmQuest = q->GetFormID();
					return obj;
				}
			}
			return {};
		}

		const RE::BSScript::Variable* Prop(const Object& obj, const char* key)
		{
			if (!obj)
				return nullptr;
			if (auto* v = obj->GetProperty(key))
				return v;
			return obj->GetVariable("::"s + key + "_var");
		}

		std::string OpenNffMenu()
		{
			std::string why;
			auto        mcm = NffMcm();   // non-const: DispatchMethodCall takes the smart pointer by reference
			if (!mcm) {
				NffMenuAvailable(why);
				RE::DebugNotification(why.c_str());
				return "combat-tools: NFF menu refused - " + why;
			}
			// controlScript.nwsKeyCmd: whatever NFF holds, bound or not (-1).
			// OnKeyDown's first branch compares against exactly this value.
			const auto* ctlVar = Prop(mcm, "controlScript");
			Object      ctl = ctlVar && ctlVar->IsObject() ? ctlVar->GetObject() : Object{};
			const auto* keyVar = Prop(ctl, "nwsKeyCmd");
			if (!keyVar || !keyVar->IsInt()) {
				RE::DebugNotification("NFF's command menu could not be reached (nwsKeyCmd missing)");
				return "combat-tools: NFF menu refused - controlScript.nwsKeyCmd not found";
			}
			const int key = keyVar->GetSInt();
			auto*     vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (!vm || !vm->DispatchMethodCall(mcm, "OnKeyDown", RE::MakeFunctionArguments(int(key)), cb)) {
				RE::DebugNotification("NFF's command menu did not start");
				return "combat-tools: NFF menu refused - OnKeyDown dispatch failed";
			}
			logger::info("combat-tools: NFF command menu opened (OnKeyDown {})", key);   // marker: combat-tools-nff-menu
			return "combat-tools: NFF command menu";
		}

		std::string OpenWwmMenu()
		{
			const auto res = SmfIndex::Open(kWwmPage);
			const auto j = json::parse(res, nullptr, false);
			if (!j.is_discarded() && j.value("ok", false)) {
				logger::info("combat-tools: Walk With Me menu opened ({})", kWwmPage);   // marker: combat-tools-wwm-menu
				return "combat-tools: Walk With Me menu open";
			}
			std::string why;
			if (!WwmMenuAvailable(why))
				why = why.empty() ? std::string("Walk With Me's menu is not available") : why;
			else
				why = j.is_discarded() ? std::string("SKSE Menu Framework refused the page") : j.value("msg", std::string(""));
			RE::DebugNotification(why.c_str());
			return "combat-tools: Walk With Me menu refused - " + why;
		}
	}

	bool BattlePlanAvailable(std::string& why)
	{
		if (!GetModuleHandleW(L"FightWithMe.dll")) {
			why = "Fight With Me is not installed (FightWithMe.dll is not loaded)";
			return false;
		}
		if (!BattlePlanFn()) {
			why = "This Fight With Me build has no FightWithMe_OpenBattlePlan export - update it";
			return false;
		}
		return true;
	}

	bool WwmMenuAvailable(std::string& why)
	{
		if (!GetModuleHandleW(L"Wayfarer.dll")) {
			why = "Walk With Me is not installed (Wayfarer.dll is not loaded)";
			return false;
		}
		if (!GetModuleHandleW(L"SKSEMenuFramework.dll")) {
			why = "Walk With Me's menu needs SKSE Menu Framework";
			return false;
		}
		if (!SmfIndex::HasPage(kWwmPage)) {
			why = "Walk With Me's Party page is not in SKSE Menu Framework";
			return false;
		}
		return true;
	}

	bool NffMenuAvailable(std::string& why)
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh || !dh->LookupModByName(kNffPlugin)) {
			why = "Nether's Follower Framework is not installed (nwsFollowerFramework.esp is not loaded)";
			return false;
		}
		if (!NffMcm()) {
			why = "NFF's menu script is not running yet - load a save first";
			return false;
		}
		return true;
	}

	std::string ListJson()
	{
		json        list = json::array();
		std::string why;
		bool        ok = BattlePlanAvailable(why);
		list.push_back({ { "id", kBattlePlan }, { "name", "Battle Plan" },
			{ "desc", "Fight With Me: roles, focus and positions for every follower. Time slows in a fight; outside one it is your party screen." },
			{ "ok", ok }, { "why", ok ? "" : why } });
		why.clear();
		ok = WwmMenuAvailable(why);
		list.push_back({ { "id", kWwmMenu }, { "name", "Walk With Me" },
			{ "desc", "Walk With Me's party menu: who travels with you, formation, rest and orders." },
			{ "ok", ok }, { "why", ok ? "" : why } });
		why.clear();
		ok = NffMenuAvailable(why);
		list.push_back({ { "id", kNffMenu }, { "name", "NFF" },
			{ "desc", "Nether's Follower Framework's command menu - the one its main key opens." },
			{ "ok", ok }, { "why", ok ? "" : why } });
		list.push_back({ { "id", kSicEm }, { "name", "Sic 'em" },
			{ "desc", "Fire the bolt down your crosshair: every follower attacks whoever it lands on." },
			{ "ok", true }, { "why", "" } });
		list.push_back({ { "id", kCommandRing }, { "name", "Command Ring" },
			{ "desc", "Order your band from a ring: Orders, Camp, Homes and Battle." },
			{ "ok", true }, { "why", "" } });
		return list.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Open(const std::string& id)
	{
		if (id == kBattlePlan)
			return OpenBattlePlan();
		if (id == kWwmMenu)
			return OpenWwmMenu();
		if (id == kNffMenu)
			return OpenNffMenu();
		return "combat-tools: unknown tool '" + id + "'";
	}
}
