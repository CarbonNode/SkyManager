// Player Tune — see player_tune.h for the contract.
//
// Design notes that are load-bearing:
//  - Writes are SetBaseActorValue: they raise/lower the PERMANENT value the
//    way PROTEUS's editor does, they persist in the save, and damage/fortify
//    modifiers ride on top untouched. GetBaseActorValue is what every row
//    shows, so the modal round-trips its own truth.
//  - Skills are clamped 0..500 (engine-legal beyond 100 via fortify-style
//    play, and PROTEUS allows it too); pools and carry weight 0..100000;
//    resistances -1000..100 DISPLAY units are wrong — resist AVs are plain
//    percentages the engine caps at 85 in combat math, but the AV itself can
//    hold more, so we clamp -100..1000 and say nothing further.
//  - SpeedMult: the engine only re-derives movement speed when SOME AV mod
//    lands afterwards — the well-known CarryWeight +0.01/-0.01 nudge.

#include "player_tune.h"

#include "pch.h"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

namespace PlayerTune
{
	namespace
	{
		using json = nlohmann::json;
		using AV = RE::ActorValue;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		struct Field
		{
			const char* key;
			const char* label;
			AV          av;
			float       lo;
			float       hi;
		};

		// Wire key -> AV. The view renders these in the order given.
		const Field kAttrs[] = {
			{ "health", "Health", AV::kHealth, 1.0f, 100000.0f },
			{ "magicka", "Magicka", AV::kMagicka, 1.0f, 100000.0f },
			{ "stamina", "Stamina", AV::kStamina, 1.0f, 100000.0f },
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
			{ "smithing", "Smithing", AV::kSmithing, 0.0f, 500.0f },
			{ "heavyarmor", "Heavy Armor", AV::kHeavyArmor, 0.0f, 500.0f },
			{ "lightarmor", "Light Armor", AV::kLightArmor, 0.0f, 500.0f },
			{ "pickpocket", "Pickpocket", AV::kPickpocket, 0.0f, 500.0f },
			{ "lockpicking", "Lockpicking", AV::kLockpicking, 0.0f, 500.0f },
			{ "sneak", "Sneak", AV::kSneak, 0.0f, 500.0f },
			{ "alchemy", "Alchemy", AV::kAlchemy, 0.0f, 500.0f },
			{ "speech", "Speech", AV::kSpeech, 0.0f, 500.0f },
			{ "alteration", "Alteration", AV::kAlteration, 0.0f, 500.0f },
			{ "conjuration", "Conjuration", AV::kConjuration, 0.0f, 500.0f },
			{ "destruction", "Destruction", AV::kDestruction, 0.0f, 500.0f },
			{ "illusion", "Illusion", AV::kIllusion, 0.0f, 500.0f },
			{ "restoration", "Restoration", AV::kRestoration, 0.0f, 500.0f },
			{ "enchanting", "Enchanting", AV::kEnchanting, 0.0f, 500.0f },
		};

		const Field* FindField(const std::string& key)
		{
			for (const auto& f : kAttrs)
				if (key == f.key)
					return &f;
			for (const auto& f : kRegen)
				if (key == f.key)
					return &f;
			for (const auto& f : kResists)
				if (key == f.key)
					return &f;
			for (const auto& f : kSkills)
				if (key == f.key)
					return &f;
			return nullptr;
		}

		float Base(RE::PlayerCharacter* p, AV av)
		{
			auto* avo = p->AsActorValueOwner();
			return avo ? avo->GetBaseActorValue(av) : 0.0f;
		}

		json GroupJson(RE::PlayerCharacter* p, const Field* fields, std::size_t n)
		{
			json out = json::array();
			for (std::size_t i = 0; i < n; ++i)
				out.push_back(json{ { "key", fields[i].key }, { "label", fields[i].label },
					{ "base", std::round(Base(p, fields[i].av) * 100.0f) / 100.0f } });
			return out;
		}

		json StateJson(RE::PlayerCharacter* p)
		{
			json out;
			out["ok"] = true;
			out["level"] = p->GetLevel();
			out["perkPoints"] = static_cast<int>(p->GetGameStatsData().perkCount);
			out["dragonSouls"] = static_cast<int>(Base(p, AV::kDragonSouls));
			out["attrs"] = GroupJson(p, kAttrs, std::size(kAttrs));
			out["regen"] = GroupJson(p, kRegen, std::size(kRegen));
			out["resists"] = GroupJson(p, kResists, std::size(kResists));
			out["skills"] = GroupJson(p, kSkills, std::size(kSkills));
			return out;
		}
	}

	// ================================================================ API ==

	std::string GetJson()
	{
		auto* p = RE::PlayerCharacter::GetSingleton();
		if (!p)
			return Dump(json{ { "ok", false }, { "msg", "No game loaded" } });
		return Dump(StateJson(p));
	}

	std::string ApplyJson(const std::string& req)
	{
		auto* p = RE::PlayerCharacter::GetSingleton();
		auto* avo = p ? p->AsActorValueOwner() : nullptr;
		if (!p || !avo)
			return Dump(json{ { "ok", false }, { "msg", "No game loaded" } });

		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (!in.contains("set") || !in["set"].is_object())
			return Dump(json{ { "ok", false }, { "msg", "Nothing to change" } });

		int  applied = 0;
		bool speedTouched = false;
		for (auto it = in["set"].begin(); it != in["set"].end(); ++it) {
			if (!it.value().is_number())
				continue;
			const std::string key = it.key();
			const double      v = it.value().get<double>();
			if (key == "perkPoints") {
				p->GetGameStatsData().perkCount =
					static_cast<std::int8_t>(std::clamp(v, 0.0, 127.0));
				++applied;
				continue;
			}
			if (key == "dragonSouls") {
				avo->SetBaseActorValue(AV::kDragonSouls,
					static_cast<float>(std::clamp(v, 0.0, 10000.0)));
				++applied;
				continue;
			}
			const Field* f = FindField(key);
			if (!f)
				continue;
			avo->SetBaseActorValue(f->av,
				static_cast<float>(std::clamp(v, static_cast<double>(f->lo), static_cast<double>(f->hi))));
			if (f->av == AV::kSpeedMult)
				speedTouched = true;
			++applied;
		}
		if (speedTouched) {
			// The engine re-derives movement speed on the next AV mod — the
			// proven CarryWeight nudge makes a SpeedMult change land NOW.
			avo->ModActorValue(AV::kCarryWeight, 0.01f);
			avo->ModActorValue(AV::kCarryWeight, -0.01f);
		}
		if (!applied)
			return Dump(json{ { "ok", false }, { "msg", "No recognized field in that request" } });

		logger::info("player-tune: applied {} field(s)", applied);
		json out = StateJson(p);
		out["msg"] = "Changed - lives in your save from here on";
		return Dump(out);
	}
}
