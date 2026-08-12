#include "char_sheet.h"

#include "actor_identity.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <optional>
#include <utility>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace CharSheet
{
	namespace
	{
		// The Windows max() macro leaks through the SKSE headers and mangles a
		// std::max on '::' into a C2589 — the same trap follower_tune.cpp and
		// room_guard.cpp hit. A tiny local clamp-to-zero sidesteps it.
		inline float Floor0(float v) { return v > 0.0f ? v : 0.0f; }

		// Read a pool as {cur, max}. cur is the live value (drains in combat),
		// max is the permanent value the bar is drawn against — base plus every
		// permanent modifier (enchantments, blessings), which is exactly what
		// GetPermanentActorValue returns and what follower_tune reads.
		json Pool(RE::ActorValueOwner* avo, RE::ActorValue av)
		{
			if (!avo)
				return json{ { "cur", 0 }, { "max", 0 } };
			// Kept as numbers (may be fractional mid-regen); the view rounds.
			const double cur = Floor0(avo->GetActorValue(av));
			const double mx  = Floor0(avo->GetPermanentActorValue(av));
			return json{ { "cur", cur }, { "max", mx } };
		}

		// The 18 skills, in the canonical actor-value order the vanilla skills
		// menu uses. Names are the human labels, not the enum spellings.
		const std::array<std::pair<RE::ActorValue, const char*>, 18>& SkillTable()
		{
			using AV = RE::ActorValue;
			static const std::array<std::pair<AV, const char*>, 18> t{ {
				{ AV::kOneHanded, "One-Handed" },
				{ AV::kTwoHanded, "Two-Handed" },
				{ AV::kArchery, "Archery" },
				{ AV::kBlock, "Block" },
				{ AV::kSmithing, "Smithing" },
				{ AV::kHeavyArmor, "Heavy Armor" },
				{ AV::kLightArmor, "Light Armor" },
				{ AV::kPickpocket, "Pickpocket" },
				{ AV::kLockpicking, "Lockpicking" },
				{ AV::kSneak, "Sneak" },
				{ AV::kAlchemy, "Alchemy" },
				{ AV::kSpeech, "Speech" },
				{ AV::kAlteration, "Alteration" },
				{ AV::kConjuration, "Conjuration" },
				{ AV::kDestruction, "Destruction" },
				{ AV::kIllusion, "Illusion" },
				{ AV::kRestoration, "Restoration" },
				{ AV::kEnchanting, "Enchanting" },
			} };
			return t;
		}

		// Gold001 summed off the inventory-changes entry list, guarded with SEH
		// exactly as Finance::ReadGold does — a full GetInventory<>() rebuild
		// faulted inside this DLL on a 4000-plugin order, and the sheet must not
		// be the tab that crashes. No C++ objects live in the __try body (C2712),
		// so the SEH is legal. Returns -1 on fault; the caller shows 0.
		__declspec(noinline) std::int64_t ReadGoldRaw(RE::PlayerCharacter* p)
		{
			std::int64_t total   = 0;
			auto*        changes = p ? p->GetInventoryChanges() : nullptr;
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object && entry->object->GetFormID() == 0x0000000F)
						total += entry->countDelta;
				}
			}
			return total;
		}
		std::int64_t ReadGold(RE::PlayerCharacter* p)
		{
			__try {
				return ReadGoldRaw(p);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return -1;
			}
		}

		// Beast state, best-effort — "" | "Vampire" | "Werewolf". Two cheap signals
		// off the race, then the vanilla factions as a backstop, and a miss returns
		// "" (never a wrong guess). The race probes cover the overwhelming majority
		// of modded setups where the transformed race carries the word in its
		// EditorID (needs po3 Tweaks' keep-editor-ids to be non-empty) OR its
		// display name (custom vampire overhauls name the race, e.g. "Nord
		// Vampire"). The faction check is the fallback for a race that hides it; the
		// FormIDs are the vanilla PlayerVampireFaction / Werewolf faction and, being
		// probed by LookupByID + IsInFaction, can only ever ADD a true match — a
		// wrong id simply never matches, so it cannot produce a false positive.
		std::string BeastOf(RE::PlayerCharacter* p)
		{
			if (!p)
				return "";
			auto scan = [](const char* s) -> std::string {
				if (!s || !*s)
					return "";
				std::string lo = s;
				std::transform(lo.begin(), lo.end(), lo.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (lo.find("vampire") != std::string::npos)
					return "Vampire";
				if (lo.find("werewolf") != std::string::npos || lo.find("werebeast") != std::string::npos)
					return "Werewolf";
				return "";
			};
			if (auto* race = p->GetRace()) {
				if (auto hit = scan(race->GetFormEditorID()); !hit.empty())
					return hit;
				if (auto hit = scan(race->GetFullName()); !hit.empty())
					return hit;
			}
			// Vanilla backstop: PlayerVampireFaction 0x0000FEA5, Werewolf faction
			// 0x0002816C. Wrong-id-safe as noted above.
			if (auto* vf = RE::TESForm::LookupByID<RE::TESFaction>(0x0000FEA5); vf && p->IsInFaction(vf))
				return "Vampire";
			if (auto* wf = RE::TESForm::LookupByID<RE::TESFaction>(0x0002816C); wf && p->IsInFaction(wf))
				return "Werewolf";
			return "";
		}

		// Total bounty across crime factions. This is the one field the spec says
		// to keep HONEST rather than clever: the engine has no cheap "total bounty"
		// getter, and the per-faction crime-gold accessor could not be verified
		// against the vendored headers from this checkout (no header access off the
		// rig, and nothing in the codebase reads crime gold to copy). Guessing a
		// method name that may not exist would fail the WHOLE feature at link time,
		// so v1 reports 0 — never a faked number — and the payload keys still carry
		// bounty so a later build can fill it (walk actor->VisitFactions and sum
		// RE::TESFaction crime gold, SEH-guarded like the gold read) without any
		// contract change. See the return notes: this is the one deliberate stub.
		int ReadBounty(RE::PlayerCharacter* p)
		{
			(void)p;
			return 0;
		}

		// Is dispelling this source safe? Abilities, race powers, diseases and
		// addictions are PASSIVE / permanent — a racial resistance, a standing-
		// stone blessing, a vampire/werewolf timer. Dispelling one strips the
		// character of something they can't get back by re-casting, so the sheet
		// offers no remove button for it. Spells, powers actively cast, poisons,
		// enchant procs and the like are fair game.
		bool DispelSafe(RE::MagicItem* src)
		{
			if (!src)
				return true;  // no known source: let the player dispel it
			using T = RE::MagicSystem::SpellType;
			// GetSpellType lives on MagicItem in NG (SpellItem overrides it), so a
			// scroll/potion/ingredient source answers its own type without a cast.
			switch (src->GetSpellType()) {
			case T::kAbility:
			case T::kDisease:
			case T::kAddiction:
			case T::kLesserPower:
			case T::kPower:
			case T::kVoicePower:
				return false;
			default:
				return true;
			}
		}

		// One active effect -> a row, or nullopt when it is inactive / dispelled /
		// has no base setting (a half-built effect we should not list).
		std::optional<json> EffectRow(RE::ActiveEffect* ae)
		{
			if (!ae)
				return std::nullopt;
			// Skip effects already on their way out — dispelled/inactive ones
			// still sit in the list for a frame and would flicker in the UI.
			if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
				ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
				return std::nullopt;

			auto* eff  = ae->effect;                                   // RE::Effect*
			auto* base = eff ? eff->baseEffect : nullptr;             // RE::EffectSetting*
			if (!base)
				return std::nullopt;

			std::string name;
			if (const char* n = base->GetFullName(); n && *n)
				name = n;
			if (name.empty())
				name = "Effect";

			// Source spell/item + its defining plugin, both best-effort.
			RE::MagicItem* src = ae->spell;
			std::string    source;
			std::string    plugin;
			if (src) {
				if (const char* sn = src->GetFullName(); sn && *sn)
					source = sn;
				std::string fid;  // unused — DurableOf gives us the plugin name
				ActorIdentity::DurableOf(src, fid, plugin);
			}

			// duration is the effect's total seconds; elapsedSeconds counts up.
			// A 0 duration means constant/ability — no timer to show.
			const double durSec    = ae->duration > 0.0f ? static_cast<double>(ae->duration) : 0.0;
			const double remainSec = durSec > 0.0
				? Floor0(ae->duration - ae->elapsedSeconds)
				: 0.0;

			const bool harmful = base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kDetrimental);

			return json{
				{ "id", static_cast<int>(ae->usUniqueID) },
				{ "name", std::move(name) },
				{ "source", std::move(source) },
				{ "plugin", std::move(plugin) },
				{ "magnitude", static_cast<double>(ae->magnitude) },
				{ "durSec", durSec },
				{ "remainSec", remainSec },
				{ "harmful", harmful },
				{ "wantsRemove", DispelSafe(src) },
			};
		}
	}

	bool ValidPortraitPath(std::string& p)
	{
		std::replace(p.begin(), p.end(), '\\', '/');
		if (p.empty())
			return true;  // clearing the portrait always works
		if (p.find("..") != std::string::npos || p.front() == '/' || p.find(':') != std::string::npos)
			return false;
		return p.compare(0, 10, "portraits/") == 0;
	}

	std::string ApplyMeta(Meta& meta, const std::string& editJson)
	{
		const auto j = json::parse(editJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return json{ { "ok", false }, { "msg", "bad request" } }.dump();

		// Each field: present -> validate + set (capped, trimmed of oversize),
		// absent -> untouched, "" -> cleared. Only text length and the portrait
		// path are enforced here; everything else is free-form RP prose.
		auto setText = [&](const char* key, std::string& dst) {
			if (!j.contains(key) || !j[key].is_string())
				return;
			std::string v = j[key].get<std::string>();
			if (v.size() > kTextCap)
				v.resize(kTextCap);  // hard cap; hotkeys.json must not bloat
			dst = std::move(v);
		};
		setText("charClass", meta.charClass);
		setText("background", meta.background);
		setText("history", meta.history);

		if (j.contains("portrait") && j["portrait"].is_string()) {
			std::string v = j["portrait"].get<std::string>();
			if (v.size() > kTextCap)
				v.resize(kTextCap);
			if (!ValidPortraitPath(v))
				return json{ { "ok", false }, { "msg", "portrait must be a path under portraits/" } }.dump();
			meta.portrait = std::move(v);
		}

		return json{ { "ok", true }, { "msg", "saved" } }.dump();
	}

	std::string BuildSheetJson(const Meta& meta)
	{
		json out;

		auto* p = RE::PlayerCharacter::GetSingleton();
		if (!p) {
			// No save loaded / no player: a well-formed empty sheet so the tab
			// renders its "no save" state instead of choking on a missing key.
			out["name"]         = "";
			out["race"]         = "";
			out["raceEditorId"] = "";
			out["level"]        = 0;
			for (const char* k : { "hp", "mag", "sta", "carry" })
				out[k] = json{ { "cur", 0 }, { "max", 0 } };
			out["gold"]    = 0;
			out["souls"]   = json{ { "dragon", 0 } };
			out["bounty"]  = 0;
			out["beast"]   = "";
			out["skills"]  = json::array();
			out["effects"] = json::array();
			out["meta"]    = json{
				{ "charClass", meta.charClass },
				{ "background", meta.background },
				{ "history", meta.history },
				{ "portrait", meta.portrait },
			};
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (const char* n = p->GetName(); n && *n)
			out["name"] = n;
		else
			out["name"] = "";

		std::string race, raceEid;
		if (auto* r = p->GetRace()) {
			if (const char* rn = r->GetFullName(); rn && *rn)
				race = rn;
			if (const char* re = r->GetFormEditorID(); re && *re)
				raceEid = re;
		}
		out["race"]         = std::move(race);
		out["raceEditorId"] = std::move(raceEid);
		out["level"]        = static_cast<int>(p->GetLevel());

		auto* avo = p->AsActorValueOwner();
		out["hp"]    = Pool(avo, RE::ActorValue::kHealth);
		out["mag"]   = Pool(avo, RE::ActorValue::kMagicka);
		out["sta"]   = Pool(avo, RE::ActorValue::kStamina);
		out["carry"] = Pool(avo, RE::ActorValue::kCarryWeight);

		const auto gold = ReadGold(p);
		out["gold"] = gold < 0 ? 0 : static_cast<int>(gold);

		int dragon = 0;
		if (avo)
			dragon = static_cast<int>(Floor0(avo->GetActorValue(RE::ActorValue::kDragonSouls)));
		out["souls"]  = json{ { "dragon", dragon } };
		out["bounty"] = ReadBounty(p);
		out["beast"]  = BeastOf(p);

		json skills = json::array();
		if (avo) {
			for (const auto& [av, label] : SkillTable())
				skills.push_back(json{ { "name", label },
					{ "level", static_cast<double>(Floor0(avo->GetActorValue(av))) } });
		}
		out["skills"] = std::move(skills);

		json effects = json::array();
		if (auto* mt = p->AsMagicTarget()) {
			if (auto* list = mt->GetActiveEffectList()) {
				for (auto* ae : *list) {
					if (auto row = EffectRow(ae))
						effects.push_back(std::move(*row));
				}
			}
		}
		out["effects"] = std::move(effects);

		out["meta"] = json{
			{ "charClass", meta.charClass },
			{ "background", meta.background },
			{ "history", meta.history },
			{ "portrait", meta.portrait },
		};

		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RemoveEffect(std::uint32_t id)
	{
		auto* p = RE::PlayerCharacter::GetSingleton();
		if (!p)
			return json{ { "ok", false }, { "msg", "no save loaded" } }.dump();
		auto* mt = p->AsMagicTarget();
		if (!mt)
			return json{ { "ok", false }, { "msg", "no magic target" } }.dump();
		auto* list = mt->GetActiveEffectList();
		if (!list)
			return json{ { "ok", false }, { "msg", "no active effects" } }.dump();

		for (auto* ae : *list) {
			if (!ae || static_cast<std::uint32_t>(ae->usUniqueID) != id)
				continue;
			// Re-check the safety gate on the LIVE effect — the view greys the
			// button, but a stale phone payload or a hand call must not strip a
			// racial passive. This is the load-bearing guard, not the UI.
			if (!DispelSafe(ae->spell))
				return json{ { "ok", false }, { "msg", "that effect is an ability or power — dispelling it would break your character" } }.dump();

			std::string name = "effect";
			if (ae->effect && ae->effect->baseEffect)
				if (const char* n = ae->effect->baseEffect->GetFullName(); n && *n)
					name = n;

			ae->Dispel(false);
			// "charsheet: dispelled" — hd-markers.json fingerprint for this feature.
			logger::info("charsheet: dispelled effect '{}' (uniqueID {})", name, id);
			return json{ { "ok", true }, { "msg", "removed " + name } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		return json{ { "ok", false }, { "msg", "that effect is no longer active" } }.dump();
	}
}
