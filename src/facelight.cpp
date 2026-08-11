#include "facelight.h"

// pch (force-included) provides RE::/SKSE:: and nlohmann json (<json.hpp>).

namespace Facelight
{
	namespace
	{
		constexpr const char* kPlugin = "Better Face Lighting - ENB Light.esp";

		// Local FormIDs read out of the ESP's bytes (tools note in the README:
		// dumped with bfl_dump.py on 2026-08-06, mod v3.30). The plugin is a
		// FULL esp, so locals are the low 24 bits.
		constexpr RE::FormID kApplicatorSpell = 0x000D74;  // _BFLLightApplicatorSPL (SPID hands this to every NPC)
		constexpr RE::FormID kApplicatorMgef = 0x000815;   // _BFLLightApplicatorMGEF (the script host)
		constexpr RE::FormID kExcludedFaction = 0x000813;  // BFLExcludedNPCFACT
		constexpr RE::FormID kForcedFaction = 0x000812;    // BFLManualNPCSupportedFACT
		constexpr RE::FormID kModEnableGlobal = 0x00080C;  // _BFLModEnable (the MCM master switch)
		constexpr RE::FormID kConfigQuest = 0x000819;      // _BFLConfigMenuInstance (holds the MCM config)

		// The seven light-level ability spells the applicator script adds
		// (which subset depends on the MCM's enabled levels). An NPC is LIT
		// exactly when she carries at least one of these.
		struct LevelSpell
		{
			const char* edid;
			RE::FormID  id;
		};
		constexpr LevelSpell kLightSpells[] = {
			{ "_BFLLightEffect0SPL", 0x000D79 },
			{ "_BFLLightEffect1SPL", 0x000D77 },
			{ "_BFLLightEffect2SPL", 0x000817 },
			{ "_BFLLightEffect3SPL", 0x000D73 },
			{ "_BFLLightEffect4SPL", 0x000818 },
			{ "_BFLLightEffect5SPL", 0x000842 },
			{ "_BFLLightEffect6SPL", 0x000857 },
		};

		// Editor id first (po3 Tweaks' cache is on this load order), FormID +
		// plugin as the fallback — the quick_light.cpp idiom.
		template <class T>
		T* Resolve(const char* edid, RE::FormID localId)
		{
			if (edid && *edid)
				if (auto* f = RE::TESForm::LookupByEditorID<T>(edid))
					return f;
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				return dh->LookupForm<T>(localId, kPlugin);
			return nullptr;
		}

		RE::SpellItem* Applicator() { return Resolve<RE::SpellItem>("_BFLLightApplicatorSPL", kApplicatorSpell); }

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			if (!formId)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(formId);
		}

		// Which light-level abilities she carries. Returns a bitmask of levels
		// 0..6; "lit" is mask != 0.
		std::uint32_t LevelMask(RE::Actor* a)
		{
			std::uint32_t mask = 0;
			for (std::size_t i = 0; i < std::size(kLightSpells); ++i)
				if (auto* sp = Resolve<RE::SpellItem>(kLightSpells[i].edid, kLightSpells[i].id))
					if (a->HasSpell(sp))
						mask |= (1u << i);
			return mask;
		}

		void RemoveAllLights(RE::Actor* a)
		{
			for (const auto& ls : kLightSpells)
				if (auto* sp = Resolve<RE::SpellItem>(ls.edid, ls.id))
					a->RemoveSpell(sp);  // harmless no-op when she never had it
		}

		RE::SpellItem* LevelSpell(std::size_t i)
		{
			if (i >= std::size(kLightSpells))
				return nullptr;
			return Resolve<RE::SpellItem>(kLightSpells[i].edid, kLightSpells[i].id);
		}

		// The exact levels the mod itself would apply, read straight off the MCM
		// config quest's `bool[] b_BFLLightEffectEnable` property — the same array
		// the applicator script reads. 0 when it can't be read (mod not init yet,
		// property empty, or the class renamed). Cheap enough to read per-call;
		// the config quest is always resident.
		std::uint32_t EnabledLevelMask()
		{
			auto* quest = Resolve<RE::TESQuest>("_BFLConfigMenuInstance", kConfigQuest);
			if (!quest)
				return 0;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return 0;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return 0;
			const auto handle = policy->GetHandleForObject(quest->GetFormType(), quest);
			if (handle == policy->EmptyHandle())
				return 0;
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			if (!vm->FindBoundObject(handle, "BFLReduxENBConfigMenu", obj) || !obj)
				return 0;
			auto* var = obj->GetProperty("b_BFLLightEffectEnable");
			if (!var || !var->IsArray())
				return 0;
			auto arr = var->GetArray();
			if (!arr)
				return 0;
			std::uint32_t mask = 0;
			const std::uint32_t n = arr->size();
			for (std::uint32_t i = 0; i < n && i < 7; ++i)
				if ((*arr)[i].GetBool())
					mask |= (1u << i);
			return mask;
		}

		// Remembered from any actor we ever saw NATURALLY lit by the mod — a
		// last-ditch source of "the levels the MCM wants" if the property read
		// ever fails. Main-thread only (every caller runs on the task queue).
		std::uint32_t g_lastGoodMask = 0;

		// Which levels WE apply when lighting someone: the MCM's own set, else the
		// last set we saw the mod use, else a single mid brightness so a light
		// always shows (the user can retune it in the MCM).
		std::uint32_t TargetLevelMask()
		{
			if (const auto m = EnabledLevelMask())
				return m;
			if (g_lastGoodMask)
				return g_lastGoodMask;
			return (1u << 3);  // level 3 — a visible mid light
		}

		// Add the light-level abilities for `mask` DIRECTLY — exactly what the
		// applicator's Papyrus script does, but instant and without depending on
		// that script (which is what wedges). `refresh` removes-then-re-adds each,
		// so a light whose FX mesh was stripped on a cell change reattaches — an
		// AddSpell for an ability the actor already has is a no-op, so the remove
		// is the load-bearing half of Re-light.
		void ApplyLights(RE::Actor* a, std::uint32_t mask, bool refresh)
		{
			for (std::size_t i = 0; i < std::size(kLightSpells); ++i) {
				if (!(mask & (1u << i)))
					continue;
				auto* sp = LevelSpell(i);
				if (!sp)
					continue;
				if (refresh && a->HasSpell(sp))
					a->RemoveSpell(sp);
				a->AddSpell(sp);
			}
		}

		std::string Reply(bool ok, const char* msg, const char* op = "")
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg ? msg : "";
			j["op"] = op ? op : "";
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	bool Present()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		return dh && (dh->LookupLoadedModByName(kPlugin) != nullptr ||
						 dh->LookupLoadedLightModByName(kPlugin) != nullptr);
	}

	std::string StateJson(std::uint32_t formId)
	{
		nlohmann::json j;
		j["ok"] = true;
		j["present"] = Present();
		j["formId"] = formId;
		if (!j["present"].get<bool>())
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* a = ActorFor(formId);
		if (!a) {
			j["ok"] = false;
			j["msg"] = "that NPC isn't loaded any more";
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		j["name"] = a->GetDisplayFullName() ? a->GetDisplayFullName() : "";
		j["dead"] = a->IsDead();

		auto* applicator = Applicator();
		const bool hasApplicator = applicator && a->HasSpell(applicator);
		j["applicator"] = hasApplicator;

		// The applicator ability actually RUNNING (its script instance alive) —
		// distinct from merely knowing the spell: an ability can sit wedged.
		bool running = false;
		if (auto* mt = a->AsMagicTarget())
			if (auto* mg = Resolve<RE::EffectSetting>("_BFLLightApplicatorMGEF", kApplicatorMgef))
				running = mt->HasMagicEffect(mg);
		j["running"] = running;

		const std::uint32_t mask = LevelMask(a);
		j["lit"] = mask != 0;
		auto levels = nlohmann::json::array();
		for (int i = 0; i < 7; ++i)
			if (mask & (1u << i))
				levels.push_back(i);
		j["levels"] = levels;

		// Learn the MCM's chosen level set from anyone the mod lit on its own, as
		// a fallback for direct lighting if the config property ever reads empty.
		if (mask != 0)
			g_lastGoodMask = mask;

		// The mod's own opt-outs, so the card can say WHY someone is dark.
		bool excluded = false, forced = false;
		if (auto* f = Resolve<RE::TESFaction>("BFLExcludedNPCFACT", kExcludedFaction))
			excluded = a->IsInFaction(f);
		if (auto* f = Resolve<RE::TESFaction>("BFLManualNPCSupportedFACT", kForcedFaction))
			forced = a->IsInFaction(f);
		j["excluded"] = excluded;
		j["forced"] = forced;

		bool modEnabled = true;
		if (auto* g = Resolve<RE::TESGlobal>("_BFLModEnable", kModEnableGlobal))
			modEnabled = g->value != 0.0f;
		j["modEnabled"] = modEnabled;

		// Build marker (hd-markers.json: "facelight-bfl") — reached on every
		// bflGet, i.e. each time the quick card looks at someone.
		logger::info("facelight: state {:08X} applicator={} running={} mask={:#x} excluded={}",
			formId, hasApplicator, running, mask, excluded);
		return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Apply(std::uint32_t formId, const std::string& op)
	{
		if (!Present())
			return Reply(false, "Better FaceLight isn't in the load order", op.c_str());
		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", op.c_str());
		// One resolvable level spell proves the plugin's forms resolve on this
		// load order; on/relight need only these, not the (flaky) applicator.
		if (!LevelSpell(0))
			return Reply(false, "couldn't resolve the FaceLight spells — mod updated?", op.c_str());

		const char* name = a->GetDisplayFullName() ? a->GetDisplayFullName() : "her";

		if (op == "off") {
			// Strip the light abilities AND the applicator, so the mod's own
			// script can't re-add them on its next tick. SPID re-hands the
			// applicator on the next game load, so "off" lasts the session.
			RemoveAllLights(a);
			if (auto* applicator = Applicator())
				a->RemoveSpell(applicator);
			logger::info("facelight: off {:08X}", formId);
			return Reply(true, (std::string("Facelight off — ") + name +
								   " (back on next game load)").c_str(), "off");
		}

		const std::uint32_t mask = TargetLevelMask();

		if (op == "on") {
			// Add the light-level abilities DIRECTLY — instant, and it bypasses
			// the applicator's Papyrus script (the part that wedges: on Elana it
			// sat applicator=true running=false, having added zero lights).
			ApplyLights(a, mask, false);
			logger::info("facelight: on {:08X} mask={:#x}", formId, mask);
			return Reply(true, (std::string("Facelight on — ") + name).c_str(), "on");
		}

		if (op == "relight") {
			// The reliability fix, now instant: remove-then-re-add each wanted
			// level so a light whose FX mesh was stripped on a cell change
			// reattaches. No Papyrus wait, no detached timer.
			ApplyLights(a, mask, true);
			logger::info("facelight: relight {:08X} mask={:#x}", formId, mask);
			return Reply(true, (std::string("Re-lit ") + name).c_str(), "relight");
		}

		return Reply(false, "unknown facelight op", op.c_str());
	}
}
