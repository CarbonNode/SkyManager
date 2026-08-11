#include "controls_fix.h"

// pch (force-included) provides RE::/SKSE:: and the logger.

namespace ControlsFix
{
	namespace
	{
		using UEFlag = RE::UserEvents::USER_EVENT_FLAG;

		// The 12 real control groups. kAll would also set kInvalid and every
		// undefined bit — enabling flags the engine never defined is asking a
		// future runtime to misread them, so the mask is built from the named
		// flags only.
		struct FlagName
		{
			UEFlag      flag;
			const char* name;
		};
		constexpr FlagName kFlags[] = {
			{ UEFlag::kMovement, "Movement" },
			{ UEFlag::kLooking, "Looking" },
			{ UEFlag::kActivate, "Activate" },
			{ UEFlag::kMenu, "Menu(Tab)" },
			{ UEFlag::kConsole, "Console" },
			{ UEFlag::kPOVSwitch, "POV" },
			{ UEFlag::kFighting, "Fighting" },
			{ UEFlag::kSneaking, "Sneaking" },
			{ UEFlag::kMainFour, "Hotkeys" },
			{ UEFlag::kWheelZoom, "WheelZoom" },
			{ UEFlag::kJumping, "Jumping" },
			{ UEFlag::kVATS, "VATS" },
		};

		// Fire-and-forget static calls into Game.psc. A null callback is the
		// established pattern here (follower_frameworks does the same): the
		// natives return void and the VM accepts an empty smart pointer.
		bool CallGame(const char* fn, RE::BSScript::IFunctionArguments* args)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			return vm->DispatchStaticCall("Game", fn, args, cb);
		}
	}

	bool IsAction(const std::string& action)
	{
		return action == "fix-controls";
	}

	void Fire()
	{
		auto* cm = RE::ControlMap::GetSingleton();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!cm || !player) {
			RE::DebugNotification("No game loaded - nothing to unstick");
			return;
		}

		// ------------------------------------------------- snapshot first --
		// The whole point of logging before touching anything: across fires,
		// the recurring shape of the wedge is what names the culprit mod.
		auto&      rd = cm->GetRuntimeData();
		const auto before = rd.enabledControls.underlying();
		const auto layered = rd.unk11C.underlying();
		const auto textEntry = rd.textEntryCount;
		const bool ignoreKbm = rd.ignoreKeyboardMouse;
		auto&      gsd = player->GetGameStatsData();
		const auto chargen = gsd.byCharGenFlag.underlying();

		std::uint32_t allMask = 0;
		std::string   disabledNames;
		for (const auto& f : kFlags) {
			allMask |= static_cast<std::uint32_t>(f.flag);
			if (!(before & static_cast<std::uint32_t>(f.flag))) {
				if (!disabledNames.empty())
					disabledNames += ", ";
				disabledNames += f.name;
			}
		}

		logger::info(
			"controls-fix: engine enabledControls=0x{:08X} layered=0x{:08X} textEntry={} ignoreKbm={} byCharGen=0x{:02X} disabled=[{}]",
			before, layered, textEntry, ignoreKbm, chargen,
			disabledNames.empty() ? "none" : disabledNames);

		// ------------------------------------------------ engine layer -----
		if ((before & allMask) != allMask)
			cm->ToggleControls(static_cast<UEFlag>(allMask), true);

		// AllowTextInput is a counter; a text field that never released leaves
		// it pinned above zero, silently eating keys. Drain, capped: a count
		// past 16 means the field is corrupt, not deep, and looping on it
		// forever would be worse than leaving it.
		int guard = 0;
		while (rd.textEntryCount > 0 && guard++ < 16)
			cm->AllowTextInput(false);

		if (rd.ignoreKeyboardMouse)
			rd.ignoreKeyboardMouse = false;

		if (chargen != 0)
			gsd.byCharGenFlag = RE::PlayerCharacter::ByCharGenFlag::kNone;

		// ------------------------------------------------ script layer -----
		// The journal-tabs lock (red Quests/General) and the chargen
		// saving/waiting lock live behind these natives and NOWHERE the engine
		// exposes for reading — so they are always fired, not conditionally.
		// EnablePlayerControls' full signature: 8 group bools + aiDisablePOVType.
		const bool epc = CallGame("EnablePlayerControls",
			RE::MakeFunctionArguments(true, true, true, true, true, true, true, true,
				static_cast<std::int32_t>(0)));
		const bool sic = CallGame("SetInChargen",
			RE::MakeFunctionArguments(false, false, false));
		logger::info("controls-fix: papyrus EnablePlayerControls={} SetInChargen={}", epc, sic);

		// ------------------------------------------------ tell the user ----
		std::string note;
		if (!disabledNames.empty())
			note = "Unstuck: " + disabledNames;
		if (textEntry > 0)
			note += (note.empty() ? "Unstuck: " : ", ") + std::string("text-entry x") + std::to_string(textEntry);
		if (ignoreKbm)
			note += (note.empty() ? "Unstuck: " : ", ") + std::string("kb/m ignored");
		if (chargen != 0)
			note += (note.empty() ? "Unstuck: " : ", ") + std::string("chargen lock");
		if (note.empty())
			// The engine side looked clean — but the journal/saving locks are
			// script-side and unreadable, so "cleared anyway" is the honest
			// phrasing, not "nothing was wrong".
			note = "Controls looked fine - cleared script locks (journal/saving) anyway";
		RE::DebugNotification(note.c_str());
	}
}
