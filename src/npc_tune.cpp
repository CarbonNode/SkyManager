// NPC Tune — see npc_tune.h for the contract and the two persistence tiers.
//
// Design notes that are load-bearing:
//  - The AV field table mirrors player_tune.cpp's (same wire keys, same
//    clamps) plus the four temperament dials, which are plain ActorValues
//    (kAggression 0-3, kConfidence 0-4, kAssistance 0-2, kMorality 0-3) —
//    the engine reads them from the ACTOR, so a per-reference base write is
//    exactly how the CK's own dials land at runtime.
//  - Scale goes through a targeted console `setscale` (fix_actions'
//    RunConsole idiom): the console command owns the 3D refresh, and the
//    scale persists in the save like any console setscale.
//  - Base identity is the TESNPC's file-width-masked local id — NEVER
//    GetLocalFormID() (the 2026-08-03 actor_identity CTD).

#include "npc_tune.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>

namespace NpcTune
{
	namespace
	{
		using json = nlohmann::json;
		using AV = RE::ActorValue;
		using BaseFlag = RE::ACTOR_BASE_DATA::Flag;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ---------------------------------------------------------- identity --
		RE::Actor* ResolveActor(const std::string& hex)
		{
			const auto id = static_cast<RE::FormID>(std::strtoul(hex.c_str(), nullptr, 16));
			if (!id)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(id);
		}

		std::string BaseIdOf(RE::TESNPC* base)
		{
			if (!base)
				return {};
			auto* file = base->GetFile(0);
			if (!file)
				return {};  // dynamic base — appliable, not durable
			const std::uint32_t local =
				base->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%06X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		RE::TESNPC* ResolveBase(const std::string& id)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::TESNPC>(
				static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16)),
				id.substr(0, bar)) : nullptr;
		}

		// --------------------------------------------------------- console ---
		// fix_actions' RunConsole idiom, local so this module stays standalone.
		void RunConsole(const std::string& cmd, RE::TESObjectREFR* target)
		{
			auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
			auto* script = factory ? factory->Create() : nullptr;
			if (!script)
				return;
			script->SetCommand(cmd);
			script->CompileAndRun(target);
			delete script;
		}

		// ------------------------------------------------------------ fields --
		struct Field
		{
			const char* key;
			const char* label;
			AV          av;
			float       lo;
			float       hi;
		};

		const Field kAttrs[] = {
			{ "health", "Health", AV::kHealth, 1.0f, 100000.0f },
			{ "magicka", "Magicka", AV::kMagicka, 0.0f, 100000.0f },
			{ "stamina", "Stamina", AV::kStamina, 0.0f, 100000.0f },
			{ "carryweight", "Carry weight", AV::kCarryWeight, 0.0f, 100000.0f },
			{ "speedmult", "Speed %", AV::kSpeedMult, 1.0f, 1000.0f },
			{ "unarmed", "Unarmed damage", AV::kUnarmedDamage, 0.0f, 10000.0f },
		};
		const Field kRegen[] = {
			{ "healrate", "Health regen", AV::kHealRate, 0.0f, 10000.0f },
			{ "magickarate", "Magicka regen", AV::kMagickaRate, 0.0f, 10000.0f },
			{ "staminarate", "Stamina regen", AV::kStaminaRate, 0.0f, 10000.0f },
		};
		const Field kResists[] = {
			{ "resistfire", "Fire", AV::kResistFire, -100.0f, 1000.0f },
			{ "resistfrost", "Frost", AV::kResistFrost, -100.0f, 1000.0f },
			{ "resistshock", "Shock", AV::kResistShock, -100.0f, 1000.0f },
			{ "resistmagic", "Magic", AV::kResistMagic, -100.0f, 1000.0f },
			{ "resistpoison", "Poison", AV::kPoisonResist, -100.0f, 1000.0f },
			{ "resistdisease", "Disease", AV::kResistDisease, -100.0f, 1000.0f },
		};
		const Field kSkills[] = {
			{ "onehanded", "One-Handed", AV::kOneHanded, 0.0f, 500.0f },
			{ "twohanded", "Two-Handed", AV::kTwoHanded, 0.0f, 500.0f },
			{ "archery", "Archery", AV::kArchery, 0.0f, 500.0f },
			{ "block", "Block", AV::kBlock, 0.0f, 500.0f },
			{ "heavyarmor", "Heavy Armor", AV::kHeavyArmor, 0.0f, 500.0f },
			{ "lightarmor", "Light Armor", AV::kLightArmor, 0.0f, 500.0f },
			{ "sneak", "Sneak", AV::kSneak, 0.0f, 500.0f },
			{ "alteration", "Alteration", AV::kAlteration, 0.0f, 500.0f },
			{ "conjuration", "Conjuration", AV::kConjuration, 0.0f, 500.0f },
			{ "destruction", "Destruction", AV::kDestruction, 0.0f, 500.0f },
			{ "illusion", "Illusion", AV::kIllusion, 0.0f, 500.0f },
			{ "restoration", "Restoration", AV::kRestoration, 0.0f, 500.0f },
		};
		// The temperament dials — discrete AVs, rendered as segmented rows.
		const Field kTemper[] = {
			{ "aggression", "Aggression", AV::kAggression, 0.0f, 3.0f },
			{ "confidence", "Confidence", AV::kConfidence, 0.0f, 4.0f },
			{ "assistance", "Assistance", AV::kAssistance, 0.0f, 2.0f },
			{ "morality", "Morality", AV::kMorality, 0.0f, 3.0f },
		};

		const Field* FindField(const std::string& key)
		{
			for (const auto& f : kAttrs)
				if (key == f.key) return &f;
			for (const auto& f : kRegen)
				if (key == f.key) return &f;
			for (const auto& f : kResists)
				if (key == f.key) return &f;
			for (const auto& f : kSkills)
				if (key == f.key) return &f;
			for (const auto& f : kTemper)
				if (key == f.key) return &f;
			return nullptr;
		}

		float Base(RE::Actor* a, AV av)
		{
			auto* avo = a->AsActorValueOwner();
			return avo ? avo->GetBaseActorValue(av) : 0.0f;
		}

		json GroupJson(RE::Actor* a, const Field* fields, std::size_t n)
		{
			json out = json::array();
			for (std::size_t i = 0; i < n; ++i)
				out.push_back(json{ { "key", fields[i].key }, { "label", fields[i].label },
					{ "base", std::round(Base(a, fields[i].av) * 100.0f) / 100.0f } });
			return out;
		}

		// ------------------------------------------------------------- store --
		json g_edits = json::object();
		bool g_loaded = false;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "npc-edits.json";
		}

		void LoadStore()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object() && j.value("v", 0) == 1 && j["edits"].is_object()) {
					g_edits = j["edits"];
					logger::info("npc-tune: sidecar loaded - {} edited npc(s)", g_edits.size());
				}
			} catch (...) {
				logger::warn("npc-tune: sidecar unreadable - starting empty (file kept)");
			}
		}

		void SaveStore()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("npc-tune: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(json{ { "v", 1 }, { "edits", g_edits } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("npc-tune: sidecar rename failed: {}", ec.message());
		}

		// ------------------------------------------------------ base fields --
		std::string ProtectionOf(RE::TESNPC* base)
		{
			if (base->actorData.actorBaseFlags.all(BaseFlag::kEssential))
				return "essential";
			if (base->actorData.actorBaseFlags.all(BaseFlag::kProtected))
				return "protected";
			return "none";
		}

		// Apply the protection tri-state to the BASE, and to the live actor's
		// boolFlags when one is handed in (nullptr during the kDataLoaded
		// replay — actors resync from the base as they load).
		void ApplyProtection(RE::TESNPC* base, RE::Actor* actor, const std::string& p)
		{
			auto& flags = base->actorData.actorBaseFlags;
			flags.reset(BaseFlag::kEssential);
			flags.reset(BaseFlag::kProtected);
			if (p == "essential")
				flags.set(BaseFlag::kEssential);
			else if (p == "protected")
				flags.set(BaseFlag::kProtected);
			if (actor) {
				auto& bf = actor->GetActorRuntimeData().boolFlags;
				bf.reset(RE::Actor::BOOL_FLAGS::kEssential);
				bf.reset(RE::Actor::BOOL_FLAGS::kProtected);
				if (p == "essential")
					bf.set(RE::Actor::BOOL_FLAGS::kEssential);
				else if (p == "protected")
					bf.set(RE::Actor::BOOL_FLAGS::kProtected);
			}
		}

		// Apply one persisted base-edit blob {level?, protection?}. Returns
		// fields applied.
		int ApplyBaseSet(RE::TESNPC* base, RE::Actor* actor, const json& set)
		{
			int n = 0;
			if (set.contains("level") && set["level"].is_number()) {
				base->actorData.level = static_cast<std::uint16_t>(
					std::clamp(set["level"].get<double>(), 1.0, 1000.0));
				base->actorData.actorBaseFlags.reset(BaseFlag::kPCLevelMult);
				++n;
			}
			if (set.contains("protection") && set["protection"].is_string()) {
				ApplyProtection(base, actor, set["protection"].get<std::string>());
				++n;
			}
			return n;
		}

		json ReadBase(RE::TESNPC* base, const char* key)
		{
			if (std::string(key) == "level")
				return json{ { "level", base->actorData.level },
					{ "pcMult", base->actorData.actorBaseFlags.all(BaseFlag::kPCLevelMult) } };
			return json(ProtectionOf(base));
		}

		// ------------------------------------------------------------- state --
		json StateFor(RE::Actor* a, const std::string& formIdHex)
		{
			LoadStore();
			auto* base = a->GetActorBase();
			const std::string baseId = BaseIdOf(base);

			json out;
			out["ok"] = true;
			out["formId"] = formIdHex;
			const char* nm = a->GetName();
			out["n"] = std::string(nm && *nm ? nm : "this one");
			if (base) {
				out["level"] = a->GetLevel();
				out["pcMult"] = base->actorData.actorBaseFlags.all(BaseFlag::kPCLevelMult);
				out["unique"] = base->actorData.actorBaseFlags.all(BaseFlag::kUnique);
				out["protection"] = ProtectionOf(base);
				out["female"] = base->actorData.actorBaseFlags.all(BaseFlag::kFemale);
				if (auto* race = base->GetRace()) {
					const char* rn = race->GetName();
					if (rn && *rn)
						out["race"] = rn;
				}
			}
			out["dead"] = a->IsDead();
			out["scale"] = std::round(a->GetScale() * 100.0f) / 100.0f;
			out["baseId"] = baseId;
			out["durable"] = !baseId.empty();
			out["attrs"] = GroupJson(a, kAttrs, std::size(kAttrs));
			out["regen"] = GroupJson(a, kRegen, std::size(kRegen));
			out["resists"] = GroupJson(a, kResists, std::size(kResists));
			out["skills"] = GroupJson(a, kSkills, std::size(kSkills));
			json temper = json::object();
			for (const auto& f : kTemper)
				temper[f.key] = static_cast<int>(std::lround(Base(a, f.av)));
			out["temper"] = std::move(temper);
			json edited = json::array();
			if (!baseId.empty() && g_edits.contains(baseId) && g_edits[baseId].is_object() &&
				g_edits[baseId].contains("set") && g_edits[baseId]["set"].is_object()) {
				for (auto it = g_edits[baseId]["set"].begin(); it != g_edits[baseId]["set"].end(); ++it)
					edited.push_back(it.key());
			}
			out["edited"] = std::move(edited);
			return out;
		}

		json Fail(const std::string& msg)
		{
			return json{ { "ok", false }, { "msg", msg } };
		}
	}

	// ================================================================ API ==

	std::string GetJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string hex = in.value("formId", std::string(""));
		auto*             a = ResolveActor(hex);
		if (!a)
			return Dump(Fail("They are not in the loaded world any more"));
		return Dump(StateFor(a, hex));
	}

	std::string ApplyJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string hex = in.value("formId", std::string(""));
		auto*             a = ResolveActor(hex);
		if (!a)
			return Dump(Fail("They are not in the loaded world any more"));
		if (!in.contains("set") || !in["set"].is_object())
			return Dump(Fail("Nothing to change"));
		auto* avo = a->AsActorValueOwner();
		auto* base = a->GetActorBase();

		int  applied = 0;
		bool speedTouched = false;

		// ---- base tier (level / protection): captured, applied, persisted --
		const std::string baseId = BaseIdOf(base);
		json              baseSet = json::object();
		if (base && in["set"].contains("level") && in["set"]["level"].is_number())
			baseSet["level"] = in["set"]["level"];
		if (base && in["set"].contains("protection") && in["set"]["protection"].is_string())
			baseSet["protection"] = in["set"]["protection"];
		if (!baseSet.empty()) {
			if (!baseId.empty()) {
				json& entry = g_edits[baseId];
				if (!entry.is_object())
					entry = json::object();
				if (!entry.contains("set") || !entry["set"].is_object())
					entry["set"] = json::object();
				if (!entry.contains("orig") || !entry["orig"].is_object())
					entry["orig"] = json::object();
				for (auto it = baseSet.begin(); it != baseSet.end(); ++it)
					if (!entry["orig"].contains(it.key()))
						entry["orig"][it.key()] = ReadBase(base, it.key().c_str());
				const char* nm = base->GetName();
				entry["n"] = std::string(nm ? nm : "");
			}
			applied += ApplyBaseSet(base, a, baseSet);
			if (!baseId.empty()) {
				for (auto it = baseSet.begin(); it != baseSet.end(); ++it)
					g_edits[baseId]["set"][it.key()] = it.value();
				SaveStore();
			}
		}

		// ---- actor tier (AVs + scale): save-persisted on their own --------
		for (auto it = in["set"].begin(); it != in["set"].end(); ++it) {
			const std::string key = it.key();
			if (key == "level" || key == "protection")
				continue;
			if (key == "scale") {
				if (!it.value().is_number())
					continue;
				const double s = std::clamp(it.value().get<double>(), 0.1, 10.0);
				char cmd[48];
				std::snprintf(cmd, sizeof(cmd), "setscale %.2f", s);
				RunConsole(cmd, a);
				++applied;
				continue;
			}
			if (!it.value().is_number() || !avo)
				continue;
			const Field* f = FindField(key);
			if (!f)
				continue;
			avo->SetBaseActorValue(f->av, static_cast<float>(
				std::clamp(it.value().get<double>(),
					static_cast<double>(f->lo), static_cast<double>(f->hi))));
			if (f->av == AV::kSpeedMult)
				speedTouched = true;
			++applied;
		}
		if (speedTouched && avo) {
			// player_tune's lesson: movement speed re-derives on the next AV mod.
			avo->ModActorValue(AV::kCarryWeight, 0.01f);
			avo->ModActorValue(AV::kCarryWeight, -0.01f);
		}

		if (!applied)
			return Dump(Fail("No recognized field in that request"));
		logger::info("npc-tune: applied {} field(s) to '{}'", applied, hex);

		json out = StateFor(a, hex);
		out["msg"] = baseSet.empty()
			? std::string("Changed - lives in your save")
			: (baseId.empty()
				? std::string("Changed - but this one cannot persist past a relaunch (dynamic NPC)")
				: std::string("Changed - stats live in your save; level/protection kept across launches"));
		return Dump(out);
	}

	std::string RevertJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string hex = in.value("formId", std::string(""));
		auto*             a = ResolveActor(hex);
		auto*             base = a ? a->GetActorBase() : nullptr;
		const std::string baseId = BaseIdOf(base);
		if (baseId.empty() || !g_edits.contains(baseId))
			return Dump(Fail("No level/protection edits to revert"));
		int n = 0;
		if (g_edits[baseId].contains("orig") && g_edits[baseId]["orig"].is_object()) {
			const auto& orig = g_edits[baseId]["orig"];
			if (orig.contains("level") && orig["level"].is_object()) {
				base->actorData.level = static_cast<std::uint16_t>(
					std::clamp(orig["level"].value("level", 1.0), 1.0, 10000.0));
				if (orig["level"].value("pcMult", false))
					base->actorData.actorBaseFlags.set(BaseFlag::kPCLevelMult);
				else
					base->actorData.actorBaseFlags.reset(BaseFlag::kPCLevelMult);
				++n;
			}
			if (orig.contains("protection") && orig["protection"].is_string()) {
				ApplyProtection(base, a, orig["protection"].get<std::string>());
				++n;
			}
		}
		g_edits.erase(baseId);
		SaveStore();
		logger::info("npc-tune: reverted {} base field(s) on '{}'", n, baseId);
		json out = StateFor(a, hex);
		out["msg"] = "Level and protection restored - stat edits stay (they live in the save)";
		return Dump(out);
	}

	void ReapplyAll()
	{
		LoadStore();
		if (g_edits.empty())
			return;
		int npcs = 0, fields = 0, missing = 0;
		for (auto it = g_edits.begin(); it != g_edits.end(); ++it) {
			const auto& e = it.value();
			if (!e.is_object() || !e.contains("set") || !e["set"].is_object())
				continue;
			auto* base = ResolveBase(it.key());
			if (!base) {
				++missing;
				continue;
			}
			const int n = ApplyBaseSet(base, nullptr, e["set"]);
			if (n) {
				fields += n;
				++npcs;
			}
		}
		logger::info("npc-tune: reapplied {} field(s) on {} npc(s){}", fields, npcs,
			missing ? " (" + std::to_string(missing) + " missing from the load order, kept)" : "");
	}
}
