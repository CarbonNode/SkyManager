#include "aim_actions.h"

// pch (force-included) provides RE::/SKSE:: and logger.

namespace AimActions
{
	namespace
	{
		constexpr const char* kPlugin = "AddItemMenuSE.esp";

		// Local FormIDs inside AddItemMenuSE.esp (same in the original and the
		// ESL-patched plugin on this rig): the mod's own lesser powers, whose
		// magic effect script runs the whole menu flow.
		constexpr std::uint32_t kPowerList   = 0x801;  // AIM_Power       -> mod-list popup
		constexpr std::uint32_t kPowerSearch = 0x81B;  // AIM_PowerSearch -> name search first

		void Notify(const std::string& msg)
		{
			RE::DebugNotification(msg.c_str());
		}
	}

	bool IsAction(const std::string& a)
	{
		return a == "additem-menu" || a == "additem-search";
	}

	void Fire(const std::string& a)
	{
		const bool search = (a == "additem-search");
		const auto localId = search ? kPowerSearch : kPowerList;

		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* spell = dh ? dh->LookupForm<RE::SpellItem>(localId, kPlugin) : nullptr;
		if (!spell) {
			logger::warn("aim: power {:#x} not found in {} — mod missing or plugin disabled", localId, kPlugin);
			Notify("AddItemMenu is not installed or its plugin is disabled.");
			return;
		}

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* caster = player ? player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant) : nullptr;
		if (!caster) {
			Notify("AddItemMenu: caster unavailable.");
			return;
		}

		// Self-cast the power; AddItemMenuSEMagicEffect.OnEffectStart takes it
		// from here (UIExtensions list popup, or text search for the Search
		// power). Same mechanism the Spell Deck's DoCast has proven in-game.
		caster->CastSpellImmediate(spell, false, player, 1.0f, false, 0.0f, player);
		logger::info("aim: cast AddItemMenu power '{}'", search ? "search" : "list");
	}
}
