#include "grip_switch.h"

#include "pch.h"

#include <memory>

namespace
{
	// ButtonEvent::Create allocates on the game heap (vkey_bridge.cpp's rule).
	struct ButtonEventDeleter
	{
		void operator()(RE::ButtonEvent* e) const
		{
			if (!e)
				return;
			e->~ButtonEvent();
			RE::free(e);
		}
	};

	int Mode(RE::Actor* a)
	{
		std::int32_t m = -1;
		if (!a || !a->GetGraphVariableInt("iDynamicGripMode", m))
			return -1;
		return m;
	}

	const char* ModeName(int m)
	{
		switch (m) {
		case 0: return "default grip";
		case 1: return "two-handed grip";
		case 2: return "one-handed grip";
		case 3: return "dual wield";
		default: return "unknown grip";
		}
	}

	// Dynamic Grip 0.4.9 canSwitch(): one-handed sword/dagger/axe/mace and
	// two-handed sword/axe (WEAPON_TYPE kTwoHandAxe covers warhammers too).
	bool Switchable(RE::TESForm* f)
	{
		auto* w = f ? f->As<RE::TESObjectWEAP>() : nullptr;
		if (!w)
			return false;
		return w->IsOneHandedSword() || w->IsOneHandedDagger() || w->IsOneHandedAxe() ||
		       w->IsOneHandedMace() || w->IsTwoHandedSword() || w->IsTwoHandedAxe();
	}
}

namespace GripSwitch
{
	bool Loaded()
	{
		return GetModuleHandleW(L"dynamicGrip.dll") != nullptr;
	}

	std::string Toggle(bool& ok)
	{
		ok = false;
		if (!Loaded())
			return "Change Grip needs Dynamic Grip (dynamicGrip.dll is not loaded)";
		auto* pc = RE::PlayerCharacter::GetSingleton();
		auto* controls = RE::PlayerControls::GetSingleton();
		if (!pc || !controls || !controls->shoutHandler)
			return "Change Grip: the player is not ready";
		if (!pc->AsActorState()->IsWeaponDrawn())
			return "Draw your weapon to change grip";
		if (!Switchable(pc->GetEquippedObject(false)))
			return "This weapon has no other grip";
		if (pc->AsActorState()->actorState1.meleeAttackState != RE::ATTACK_STATE_ENUM::kNone)
			return "Change Grip: wait for the swing to finish";

		std::unique_ptr<RE::ButtonEvent, ButtonEventDeleter> ev{
			RE::ButtonEvent::Create(RE::INPUT_DEVICE::kNone, RE::BSFixedString("GripSwitch"), 0, 0.0f, 0.1f)
		};
		if (!ev)
			return "Change Grip: event allocation failed";

		const int before = Mode(pc);
		// Released (value 0, held > 0): the shape Dynamic Grip's hook waits for.
		// Its hook returns false after a switch, vanilla returns false for a
		// user event that is not "Shout" — either way nothing else happens.
		static_cast<RE::PlayerInputHandler*>(controls->shoutHandler)->CanProcess(ev.get());
		const int after = Mode(pc);

		if (after == before) {
			// A perk requirement in dynamicGrip.ini is the remaining refusal.
			return "Change Grip: Dynamic Grip did not switch (a perk it requires? see dynamicGrip.ini)";
		}
		ok = true;
		return std::string("grip-switch: ") + ModeName(before) + " -> " + ModeName(after);   // marker: grip-switch-dg
	}
}
