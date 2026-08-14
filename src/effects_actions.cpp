#include "effects_actions.h"

// pch (force-included) provides RE::/SKSE::, logger and nlohmann json (<json.hpp>).

namespace EffectsActions
{
	namespace
	{
		// One row of the registry: a visual effect another mod implements as an
		// ABILITY spell — carrying the spell IS the effect being on, AddSpell
		// applies it (the spell's magic-effect script runs OnEffectStart),
		// RemoveSpell takes it off (OnEffectFinish does the mod's own cleanup).
		// Driving the mod's own ability beats reimplementing it: its script owns
		// persistence across saves and the honest teardown.
		struct EffectDef
		{
			const char* id;        // stable key the view sends back in fxSet
			const char* label;
			const char* glyph;     // emoji for the modal row
			const char* detail;    // one-line description under the label
			const char* modName;   // human name for the "not installed" reason
			const char* plugin;    // owning plugin file
			const char* npcEdid;   // ability used on NPCs (editor id first — po3 cache)
			RE::FormID  npcId;
			const char* selfEdid;  // ability used on the player (nullptr = npc one)
			RE::FormID  selfId;
		};

		// Oily Skin - Lightweight Wet Function (Nexus 141131, "Oily Skin.esp"):
		// two ability spells whose AverozeOilySkin script applies NiOverride
		// gloss/specular skin overrides. The Follower spell is what the mod's own
		// "Applicable Massage Oil" staff toggles on NPCs; the Self one is what its
		// potion/personal staff toggle on the player. Locals dumped from the
		// plugin's bytes 2026-08-14 (MGEFs 0x89F/0x8A0, toggles 0x8A1/0x8A7).
		constexpr EffectDef kEffects[] = {
			{ "skin-oil", "Skin oil", "💧",
			  "Oiled, glossy skin — the wet look, until it is wiped off",
			  "Oily Skin - Lightweight Wet Function", "Oily Skin.esp",
			  "AveOilySkinSpellFollower", 0x0008A6,
			  "AveOilySkinSpell", 0x0008A2 },
		};

		// Editor id first (po3 Tweaks' cache is on this load order), FormID +
		// plugin as the fallback — the facelight.cpp idiom.
		template <class T>
		T* Resolve(const char* edid, RE::FormID localId, const char* plugin)
		{
			if (edid && *edid)
				if (auto* f = RE::TESForm::LookupByEditorID<T>(edid))
					return f;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				return dh->LookupForm<T>(localId, plugin);
			return nullptr;
		}

		bool PluginPresent(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(plugin) != nullptr ||
							 dh->LookupLoadedLightModByName(plugin) != nullptr);
		}

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			if (!formId)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(formId);
		}

		// The ability that means "on" for THIS actor: the player gets the mod's
		// self spell (it carries the OnPlayerLoadGame re-apply), everyone else
		// the follower one. Falls back across the pair so a state read never
		// misses an oil applied the other way (e.g. by the mod's own staff).
		RE::SpellItem* SpellFor(const EffectDef& def, bool isPlayer)
		{
			const bool self = isPlayer && def.selfEdid;
			return self ? Resolve<RE::SpellItem>(def.selfEdid, def.selfId, def.plugin)
						: Resolve<RE::SpellItem>(def.npcEdid, def.npcId, def.plugin);
		}

		RE::SpellItem* OtherSpellFor(const EffectDef& def, bool isPlayer)
		{
			const bool self = isPlayer && def.selfEdid;
			return self ? Resolve<RE::SpellItem>(def.npcEdid, def.npcId, def.plugin)
						: (def.selfEdid ? Resolve<RE::SpellItem>(def.selfEdid, def.selfId, def.plugin) : nullptr);
		}

		const EffectDef* DefById(const std::string& id)
		{
			for (const auto& d : kEffects)
				if (id == d.id)
					return &d;
			return nullptr;
		}

		std::string Dump(const nlohmann::json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::string Reply(bool ok, const std::string& msg, const char* id, bool on)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id ? id : "";
			j["on"] = on;
			return Dump(j);
		}
	}

	std::string StateJson(std::uint32_t formId)
	{
		nlohmann::json j;
		j["ok"] = true;
		j["formId"] = formId;

		auto* a = ActorFor(formId);
		if (!a) {
			j["ok"] = false;
			j["msg"] = "that NPC isn't loaded any more";
			return Dump(j);
		}
		const bool isPlayer = a->IsPlayerRef();
		j["name"] = a->GetDisplayFullName() ? a->GetDisplayFullName() : "";
		j["dead"] = a->IsDead();

		auto effects = nlohmann::json::array();
		bool anyPresent = false;
		for (const auto& def : kEffects) {
			nlohmann::json e;
			e["id"] = def.id;
			e["label"] = def.label;
			e["glyph"] = def.glyph;
			e["detail"] = def.detail;
			const bool present = PluginPresent(def.plugin);
			e["present"] = present;
			bool active = false;
			if (!present) {
				e["reason"] = std::string(def.modName) + " isn't in the load order";
			} else if (auto* sp = SpellFor(def, isPlayer)) {
				active = a->HasSpell(sp);
				// The mod's other delivery (its own staff/potion) may have used
				// the sibling spell — either one carried means the effect is on.
				if (!active)
					if (auto* other = OtherSpellFor(def, isPlayer))
						active = a->HasSpell(other);
				anyPresent = true;
			} else {
				e["present"] = false;
				e["reason"] = std::string("couldn't resolve ") + def.modName + "'s spells — mod updated?";
			}
			e["active"] = active;
			effects.push_back(e);
		}
		j["effects"] = effects;
		j["anyPresent"] = anyPresent;

		// Build marker (hd-markers.json: "effects-modal") — reached on every
		// fxGet, i.e. each time the quick card looks at someone.
		logger::info("effects: state {:08X} anyPresent={}", formId, anyPresent);
		return Dump(j);
	}

	std::string Apply(std::uint32_t formId, const std::string& id, bool on)
	{
		const auto* def = DefById(id);
		if (!def)
			return Reply(false, "unknown effect", id.c_str(), on);
		if (!PluginPresent(def->plugin))
			return Reply(false, std::string(def->modName) + " isn't in the load order", def->id, on);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", def->id, on);
		const bool isPlayer = a->IsPlayerRef();

		auto* sp = SpellFor(*def, isPlayer);
		if (!sp)
			return Reply(false, std::string("couldn't resolve ") + def->modName + "'s spells — mod updated?", def->id, on);

		const char* rawName = a->GetDisplayFullName();
		const std::string name = (rawName && *rawName) ? rawName : "them";

		if (on) {
			a->AddSpell(sp);  // no-op when already carried; the effect script applies the look
			logger::info("effects: apply '{}' to {:08X}", def->id, formId);
			return Reply(true, std::string(def->label) + " applied — " + name, def->id, true);
		}

		// Take BOTH delivery spells off, so an oil applied by the mod's own
		// staff/potion comes off too. RemoveSpell is a harmless no-op for a
		// spell never carried; OnEffectFinish runs the mod's own cleanup.
		a->RemoveSpell(sp);
		if (auto* other = OtherSpellFor(*def, isPlayer))
			a->RemoveSpell(other);
		logger::info("effects: remove '{}' from {:08X}", def->id, formId);
		return Reply(true, std::string(def->label) + " removed — " + name, def->id, false);
	}
}
