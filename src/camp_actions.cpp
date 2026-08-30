#include "camp_actions.h"

#include "pch.h"

#include <cstdint>
#include <string>

namespace CampActions
{
	namespace
	{
		struct Verb
		{
			const char*   action;   // the deck action key
			const char*   plugin;   // owning mod
			const char*   edid;     // spell/power EditorID (po3-first)
			std::uint32_t local;    // fallback local id inside `plugin`
			const char*   label;    // for the refusal notification
		};

		// The full Campfire + Hunterborn seed registry (contract §2.6). Resolved
		// edid-first with a local-id fallback so a mod update that shifts a
		// FormID does not silently mis-fire (the loot_highlight palette precedent).
		constexpr Verb kVerbs[] = {
			// ── Campfire (Campfire.esm) ─────────────────────────────────────
			{ "camp-build",       "Campfire.esm", "_Camp_CampfireSpell",         0x025BD5, "Build Campfire" },
			{ "camp-instincts",   "Campfire.esm", "_Camp_SurvivalVisionPower",   0x035411, "Instincts" },
			{ "camp-harvestwood", "Campfire.esm", "_Camp_HarvestWoodSpell",      0x025647, "Harvest Wood" },
			{ "camp-createitem",  "Campfire.esm", "_Camp_CreateItemSpell",       0x02306B, "Create Item" },
			{ "camp-options",     "Campfire.esm", "_Camp_LegacyConfig_Spell",    0x0359AA, "Options: Campfire" },
			// ── Hunterborn (Hunterborn.esp) ─────────────────────────────────
			{ "hb-fielddress",    "Hunterborn.esp", "_DS_SPEL_Hotkey_FieldDress", 0x044EC6, "Field Dress" },
			{ "hb-skin",          "Hunterborn.esp", "_DS_SPEL_Hotkey_Skin",       0x044EC9, "Skin" },
			{ "hb-harvest",       "Hunterborn.esp", "_DS_SPEL_Hotkey_Harvest",    0x044ECB, "Harvest" },
			{ "hb-butcher",       "Hunterborn.esp", "_DS_SPEL_Hotkey_Butcher",    0x044ECD, "Butcher" },
			{ "hb-process",       "Hunterborn.esp", "_DS_SPEL_Hotkey_Process",    0x044ECF, "Process" },
			{ "hb-forage",        "Hunterborn.esp", "_DS_SPEL_Forage",            0x014225, "Forage" },
			{ "hb-taxonomy",      "Hunterborn.esp", "_DS_SPEL_Taxonomy",          0x0215DA, "Taxonomy" },
			{ "hb-scrimshaw",     "Hunterborn.esp", "_DS_SPEL_Scrimshaw",         0x025C0C, "Scrimshaw" },
			{ "hb-sensedir",      "Hunterborn.esp", "_DS_SPEL_SenseDirection",    0x044ED1, "Sense Direction" },
			{ "hb-tracking",      "Hunterborn.esp", "_DS_SPEL_Pathfinding",       0x0D925B, "Tracking" },
			{ "hb-primcook",      "Hunterborn.esp", "_DS_SPEL_PrimitiveCooking",  0x073D95, "Primitive Cooking" },
			{ "hb-options",       "Hunterborn.esp", "_DS_SPEL_Config",            0x1B2F4B, "Options: Hunterborn" },
		};

		const Verb* Find(const std::string& a)
		{
			for (const auto& v : kVerbs)
				if (a == v.action)
					return &v;
			return nullptr;
		}

		// Resolve the spell edid-first, then by local id inside the plugin.
		RE::SpellItem* ResolveSpell(const Verb& v)
		{
			if (v.edid && *v.edid) {
				if (auto* f = RE::TESForm::LookupByEditorID(v.edid))
					if (auto* s = f->As<RE::SpellItem>())
						return s;
			}
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				return dh->LookupForm<RE::SpellItem>(v.local, v.plugin);
			return nullptr;
		}
	}

	bool IsAction(const std::string& a)
	{
		return Find(a) != nullptr;
	}

	void Fire(const std::string& a)
	{
		const Verb* v = Find(a);
		if (!v)
			return;
		auto* spell = ResolveSpell(*v);
		if (!spell) {
			logger::warn("camp: '{}' spell not found ({} / edid {}) - mod missing or updated",
				v->label, v->plugin, v->edid ? v->edid : "");
			RE::DebugNotification((std::string(v->label) + " is unavailable - its mod isn't loaded").c_str());
			return;
		}
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* caster = player ? player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant) : nullptr;
		if (!caster) {
			RE::DebugNotification((std::string(v->label) + ": caster unavailable").c_str());
			return;
		}
		// Self-cast the mod's own spell; its magic-effect Papyrus flow runs from
		// here, exactly as if the mod's own hotkey had been pressed.
		caster->CastSpellImmediate(spell, false, player, 1.0f, false, 0.0f, player);
		logger::info("camp: cast '{}' ({})", v->label, v->plugin);
	}
}
