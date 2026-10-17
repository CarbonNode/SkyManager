#include "sanguines_trade.h"

#include "actor_identity.h"

#include <algorithm>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace SanguinesTrade
{
	namespace
	{
		// Local FormIDs inside kPlugin, dumped from the ESP's own groups
		// (2026-10-14): BOOK ST_LedgerBook, QUST ST_PrismaLedgerQuest.
		constexpr std::uint32_t kBookLedger  = 0x0B09CD;
		constexpr std::uint32_t kQuestLedger = 0x2961C8;

		// The script on kQuestLedger (its VMAD) and the function the mod's own
		// ST_LedgerPowerEffect calls. No arguments.
		constexpr const char* kScriptLedger = "ST_PrismaLedger";
		constexpr const char* kFnToggle     = "TogglePrismaLedger";

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		std::string Reply(bool ok, const std::string& msg)
		{
			return json{ { "ok", ok }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		bool EqualsNoCase(const std::string& a, const char* b)
		{
			const std::string bb = b;
			return a.size() == bb.size() &&
			       std::equal(a.begin(), a.end(), bb.begin(), [](unsigned char x, unsigned char y) {
				       return std::tolower(x) == std::tolower(y);
			       });
		}
	}

	bool Present()
	{
		static int cached = -1;
		if (cached < 0) {
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return false;
			cached = dh->LookupModByName(kPlugin) ? 1 : 0;
		}
		return cached == 1;
	}

	bool IsLedgerItem(const std::string& formIdHex, const std::string& plugin)
	{
		if (!EqualsNoCase(plugin, kPlugin))
			return false;
		return (ActorIdentity::ParseHex(formIdHex) & 0x00FFFFFF) == kBookLedger;
	}

	std::string ToggleLedgerJson()
	{
		if (!Present())
			return Reply(false, "Sanguine's Trade is not in the load order.");

		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* quest = dh ? dh->LookupForm<RE::TESQuest>(kQuestLedger, kPlugin) : nullptr;
		if (!quest) {
			logger::warn("sanguines-trade: ST_PrismaLedgerQuest ({:06X}) not found in {}", kQuestLedger, kPlugin);
			return Reply(false, "The Ledger's quest could not be found.");
		}
		if (!quest->IsRunning())
			return Reply(false, "The Ledger isn't running yet - start a game with Sanguine's Trade first.");

		auto* vm = Vm();
		auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
		if (!policy)
			return Reply(false, "The script engine isn't ready.");
		const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
		if (handle == policy->EmptyHandle())
			return Reply(false, "The Ledger's script isn't attached yet.");

		auto*                                                    args = RE::MakeFunctionArguments();
		RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
		if (!vm->DispatchMethodCall(handle, kScriptLedger, kFnToggle, args, cb)) {
			logger::warn("sanguines-trade: dispatch into {}.{} refused", kScriptLedger, kFnToggle);
			return Reply(false, "The Ledger didn't answer - its script refused the call.");
		}
		logger::info("sanguines-trade: Ledger toggle dispatched ({}.{})", kScriptLedger, kFnToggle);  // marker: sanguines-trade-toggle
		return Reply(true, "");
	}
}
