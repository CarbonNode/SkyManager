#include "broom_cleanup.h"
#include "ostim_deck.h"

#include <atomic>

namespace BroomCleanup
{
	namespace
	{
		// Verified from the installed 0.5.2 ESP's QUST/VMAD and shipped PSCs.
		// No runtime load-order indices: the quest is local 0x800, and Broom01
		// is the vanilla form explicitly assigned to the player alias property.
		constexpr const char* kPlugin = "sweepingOrganizesStuff.esp";
		constexpr const char* kQuest = "sweepingOrganizesStuffQuest";
		constexpr const char* kScript = "sweepingOrganizesStuffAliasScript";
		constexpr RE::FormID kQuestId = 0x800;
		constexpr RE::FormID kBroomId = 0x6717F;
		std::atomic<std::uint64_t> g_serial{ 0 };
		std::atomic<std::uint64_t> g_active{ 0 };

		void Refuse(const char* reason)
		{
			logger::info("broom-cleanup: refused - {}", reason);
			RE::DebugNotification(reason);
		}

		// The VM completes on its own thread. Only atomics/logging here, never
		// engine calls. A stale callback must not unlock a NEW save's sweep.
		class Done final : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit Done(std::uint64_t ticket) : ticket_(ticket) {}
			~Done() override { Release(); }
			void operator()(RE::BSScript::Variable) override
			{
				if (Release()) logger::info("broom-cleanup: mod sweep returned");
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}
		private:
			bool Release()
			{
				auto expected = ticket_;
				return g_active.compare_exchange_strong(expected, 0);
			}
			std::uint64_t ticket_;
		};
	}

	bool IsAction(const std::string& action) { return action == "broom-cleanup"; }

	void Reset()
	{
		++g_serial;
		g_active = 0;
	}

	void Fire()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!player || !dh || !player->GetParentCell()) return Refuse("Load a game before sweeping");
		if (g_active.load()) return Refuse("Already sweeping - wait for it to finish");
		if (player->IsInCombat()) return Refuse("Finish combat before sweeping");
		if (player->IsDead() || player->IsOnMount() || player->IsInKillMove() ||
			player->GetCurrentScene() || OstimDeck::ActorInScene(player->GetFormID()))
			return Refuse("Finish the current scene or animation before sweeping");
		if (auto* s = player->AsActorState(); s &&
			(s->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal || s->IsSwimming() || s->IsFlying()))
			return Refuse("Stand on the ground before sweeping");
		if (auto* controls = RE::ControlMap::GetSingleton(); !controls ||
			!controls->IsMovementControlsEnabled() || !controls->IsActivateControlsEnabled())
			return Refuse("Wait until player controls are available before sweeping");

		auto* quest = dh->LookupForm<RE::TESQuest>(kQuestId, kPlugin);
		if (!quest) return Refuse("Sweeping Organizes Stuff is not loaded");
		if (!quest->IsRunning()) return Refuse("The broom cleanup quest is not running");
		auto* broom = dh->LookupForm<RE::TESObjectMISC>(kBroomId, "Skyrim.esm");
		if (!broom) return Refuse("The broom could not be found");
		const auto inventory = player->GetInventoryCounts([broom](RE::TESBoundObject& item) { return &item == broom; });
		const auto held = inventory.find(broom);
		if (held == inventory.end() || held->second <= 0) return Refuse("Carry a broom in your inventory to clean up");

		RE::BGSRefAlias* alias = nullptr;
		for (auto* a : quest->aliases) {
			if (a && a->aliasName == "playerAlias" && a->GetVMTypeID() == RE::BGSRefAlias::VMTYPEID) {
				alias = static_cast<RE::BGSRefAlias*>(a);
				break;
			}
		}
		if (!alias || alias->GetReference() != player) return Refuse("The broom mod's player alias is not ready");
		auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
		auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
		if (!policy) return Refuse("The scripting engine is not ready");
		const auto handle = policy->GetHandleForObject(alias->GetVMTypeID(), alias);
		RE::BSTSmartPointer<RE::BSScript::Object> script;
		if (handle == policy->EmptyHandle() || !vm->FindBoundObject(handle, kScript, script) || !script)
			return Refuse("The broom mod's cleanup script is not ready");

		const auto ticket = ++g_serial;
		g_active = ticket;
		RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> callback(new Done(ticket));
		RE::TESForm* item = broom;
		RE::TESObjectREFR* reference = nullptr;
		auto* args = RE::MakeFunctionArguments(std::move(item), std::move(reference));
		// The original inventory-use event, on the original alias. In particular
		// we NEVER enumerate/move clutter, start its worker quests, or enable
		// player controls ourselves. The mod retains those responsibilities.
		const bool accepted = vm->DispatchMethodCall(handle, kScript, "OnObjectEquipped", args, callback);
		logger::info("broom-cleanup: dispatched original broom event accepted={} quest={}", accepted, kQuest);
		if (!accepted) {
			auto expected = ticket;
			g_active.compare_exchange_strong(expected, 0);
			return Refuse("Could not start the broom cleanup script");
		}
		RE::DebugNotification("Sweeping - restoring scattered objects");
	}
}
