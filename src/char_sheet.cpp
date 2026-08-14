#include "char_sheet.h"

#include "actor_identity.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <iomanip>
#include <optional>
#include <sstream>
#include <utility>
#include <vector>

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

		// One deliberately narrow inventory snapshot. A full GetInventory<>()
		// rebuild faulted inside this DLL on the 4k-plugin live profile; the
		// inventory-changes list is the proven safe path Finance already uses.
		// Keep this POD so the wrapper can SEH-guard the call without C2712.
		struct InventoryCounts
		{
			std::int64_t gold = 0;
			std::int64_t health = 0;
			std::int64_t magicka = 0;
			std::int64_t stamina = 0;
			std::int64_t other = 0;
			std::int64_t lockpicks = 0;
			bool ok = true;
		};

		// A potion belongs to exactly one card. Multi-pool concoctions go to
		// Other instead of being double-counted, so the four card counts always
		// add up to the actual number of non-food, non-poison potions carried.
		int PotionPoolMask(const RE::AlchemyItem* alch)
		{
			if (!alch)
				return 0;
			int mask = 0;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				for (const auto av : { base->data.primaryAV, base->data.secondaryAV }) {
					if (av == RE::ActorValue::kHealth)       mask |= 1;
					else if (av == RE::ActorValue::kMagicka) mask |= 2;
					else if (av == RE::ActorValue::kStamina) mask |= 4;
				}
			}
			return mask;
		}

		__declspec(noinline) InventoryCounts ReadInventoryRaw(RE::PlayerCharacter* p)
		{
			InventoryCounts out;
			auto*        changes = p ? p->GetInventoryChanges() : nullptr;
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (!entry || !entry->object || entry->countDelta <= 0)
						continue;
					auto* obj = entry->object;
					const std::int64_t count = entry->countDelta;
					if (obj->GetFormID() == 0x0000000F) {
						out.gold += count;
						continue;
					}
					if (obj->GetFormID() == 0x0000000A) {
						out.lockpicks += count;
						continue;
					}
					if (obj->GetFormType() != RE::FormType::AlchemyItem)
						continue;
					auto* alch = obj->As<RE::AlchemyItem>();
					if (!alch || alch->IsFood() || alch->IsPoison())
						continue;
					switch (PotionPoolMask(alch)) {
					case 1: out.health += count; break;
					case 2: out.magicka += count; break;
					case 4: out.stamina += count; break;
					default: out.other += count; break;
					}
				}
			}
			return out;
		}

		InventoryCounts ReadInventory(RE::PlayerCharacter* p)
		{
			__try {
				return ReadInventoryRaw(p);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				InventoryCounts out;
				out.ok = false;
				return out;
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

		// Clamp a portrait crop to the SAME invariant followers-pane.js enforces:
		// z in [1,4]; a pan beyond (z-1)/2 would show the frame's empty backing,
		// so |x|,|y| are held to that. Mirrored on both sides so a value that
		// survives the round trip compares equal to the one the editor sent.
		void ClampPortraitCrop(float& z, float& x, float& y)
		{
			if (!std::isfinite(z)) z = 1.0f;
			if (!std::isfinite(x)) x = 0.0f;
			if (!std::isfinite(y)) y = 0.0f;
			z = std::clamp(z, 1.0f, 4.0f);
			const float lim = (z - 1.0f) * 0.5f;
			x = std::clamp(x, -lim, lim);
			y = std::clamp(y, -lim, lim);
		}

		enum class RemoveMode { kSafe, kConfirm, kLocked };

		bool IsRaceEffect(RE::PlayerCharacter* player, RE::MagicItem* src)
		{
			auto* race = player ? player->GetRace() : nullptr;
			auto* data = race ? race->actorEffects : nullptr;
			if (!src || !data || !data->spells)
				return false;
			for (std::uint32_t i = 0; i < data->numSpells; ++i) {
				if (static_cast<RE::MagicItem*>(data->spells[i]) == src)
					return true;
			}
			return false;
		}

		// GetSpellType is a RECORD CLASSIFICATION, not an engine CanDispel query.
		// The first version treated six whole classes as "not dispellable", which
		// is why diseases, powers and almost every controller effect on the live
		// profile showed a false lock. Skyrim exposes ActiveEffect::Dispel for all
		// of them. We hard-lock only the race's own inherited spell list; permanent
		// abilities/powers get a stronger confirmation because they may be a mod
		// controller; timed effects, debuffs, diseases and potions are normal.
		RemoveMode DispelMode(RE::PlayerCharacter* player, RE::ActiveEffect* ae)
		{
			if (!ae)
				return RemoveMode::kLocked;
			auto* src = ae->spell;
			if (IsRaceEffect(player, src))
				return RemoveMode::kLocked;
			auto* base = ae->effect ? ae->effect->baseEffect : nullptr;
			if (ae->duration > 0.0f || (base && base->IsDetrimental()) || !src)
				return RemoveMode::kSafe;
			using T = RE::MagicSystem::SpellType;
			switch (src->GetSpellType()) {
			case T::kDisease:
			case T::kAddiction:
			case T::kAlchemy:
				return RemoveMode::kSafe;
			case T::kAbility:
			case T::kLesserPower:
			case T::kPower:
			case T::kVoicePower:
				return RemoveMode::kConfirm;
			default:
				return RemoveMode::kSafe;
			}
		}

		std::string EffectKey(const RE::ActiveEffect* ae)
		{
			if (!ae)
				return {};
			std::ostringstream out;
			out << std::uppercase << std::hex << std::setw(16) << std::setfill('0')
				<< reinterpret_cast<std::uintptr_t>(ae);
			return out.str();
		}

		// One active effect -> a row, or nullopt when it is inactive / dispelled /
		// has no base setting (a half-built effect we should not list).
		std::optional<json> EffectRow(RE::PlayerCharacter* player, RE::ActiveEffect* ae)
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

			const bool       harmful = base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kDetrimental);
			const RemoveMode remove  = DispelMode(player, ae);
			const char* removeName = remove == RemoveMode::kSafe ? "safe" :
				(remove == RemoveMode::kConfirm ? "confirm" : "locked");

			return json{
				{ "key", EffectKey(ae) },
				{ "id", static_cast<int>(ae->usUniqueID) },
				{ "name", std::move(name) },
				{ "source", std::move(source) },
				{ "plugin", std::move(plugin) },
				{ "magnitude", static_cast<double>(ae->magnitude) },
				{ "durSec", durSec },
				{ "remainSec", remainSec },
				{ "harmful", harmful },
				{ "removeMode", removeName },
				{ "wantsRemove", remove != RemoveMode::kLocked },
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
			const auto cap = MetaTextCap(key);
			if (v.size() > cap)
				v.resize(cap);  // hard cap; hotkeys.json must not bloat
			dst = std::move(v);
		};
		setText("charClass", meta.charClass);
		setText("alignment", meta.alignment);
		setText("title", meta.title);
		setText("eyeColor", meta.eyeColor);
		setText("height", meta.height);
		setText("age", meta.age);
		setText("homeland", meta.homeland);
		setText("deity", meta.deity);
		setText("background", meta.background);
		setText("history", meta.history);

		if (j.contains("portrait") && j["portrait"].is_string()) {
			std::string v = j["portrait"].get<std::string>();
			if (v.size() > MetaTextCap("portrait"))
				v.resize(MetaTextCap("portrait"));
			if (!ValidPortraitPath(v))
				return json{ { "ok", false }, { "msg", "portrait must be a path under portraits/" } }.dump();
			meta.portrait = std::move(v);
			// A NEW portrait supersedes any crop meant for the old one (the frame
			// changed underneath it). Reset to identity unless this same patch
			// also carries a crop, which the block below then applies.
			meta.portraitZoom = 1.0f;
			meta.portraitX    = 0.0f;
			meta.portraitY    = 0.0f;
		}

		// Portrait display crop. Accept a flat {portraitZoom,portraitX,portraitY}
		// (any subset), clamped to the shared invariant. A patch that sends only
		// the crop re-frames the current photo; z=1 resets to "as shot".
		{
			bool  haveCrop = false;
			float z = meta.portraitZoom, x = meta.portraitX, y = meta.portraitY;
			if (j.contains("portraitZoom") && j["portraitZoom"].is_number()) { z = j["portraitZoom"].get<float>(); haveCrop = true; }
			if (j.contains("portraitX") && j["portraitX"].is_number())       { x = j["portraitX"].get<float>();    haveCrop = true; }
			if (j.contains("portraitY") && j["portraitY"].is_number())       { y = j["portraitY"].get<float>();    haveCrop = true; }
			if (haveCrop) {
				ClampPortraitCrop(z, x, y);
				meta.portraitZoom = z;
				meta.portraitX    = x;
				meta.portraitY    = y;
			}
		}

		return json{ { "ok", true }, { "msg", "saved" } }.dump();
	}

	// One serializer for both the no-save/main-menu sheet and the normal
	// loaded-player sheet. These paths used to spell the same object twice; the
	// loaded-player copy then missed portraitCrop, so a successful psSetMeta
	// persisted the crop but the authoritative psData immediately erased it from
	// the view. Keeping the crop beside the rest of its metadata structurally
	// prevents the two responses from drifting again.
	static json MetaJson(const Meta& meta)
	{
		return json{
			{ "charClass", meta.charClass },
			{ "alignment", meta.alignment },
			{ "title", meta.title },
			{ "eyeColor", meta.eyeColor },
			{ "height", meta.height },
			{ "age", meta.age },
			{ "homeland", meta.homeland },
			{ "deity", meta.deity },
			{ "background", meta.background },
			{ "history", meta.history },
			{ "portrait", meta.portrait },
			{ "portraitCrop", json{
				{ "z", meta.portraitZoom },
				{ "x", meta.portraitX },
				{ "y", meta.portraitY },
			} },
		};
	}

	std::string BuildSheetJson(const Meta& meta)
	{
		json out;
		static bool cropRoundTripSaid = false;
		if (!cropRoundTripSaid) {
			cropRoundTripSaid = true;
			logger::info("charsheet: portrait crop round-trip enabled");
		}

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
			out["inventory"] = json{
				{ "potions", json{ { "health", 0 }, { "magicka", 0 }, { "stamina", 0 }, { "other", 0 }, { "total", 0 } } },
				{ "lockpicks", 0 },
			};
			out["souls"]   = json{ { "dragon", 0 } };
			out["bounty"]  = 0;
			out["beast"]   = "";
			out["skills"]  = json::array();
			out["effects"] = json::array();
			out["meta"]    = MetaJson(meta);
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

		const auto inv = ReadInventory(p);
		// Reached once per plugin lifetime: protects the dynamic inventory seam in
		// the deploy marker registry without spamming the 5 s portal ticker.
		static bool inventorySaid = false;
		if (!inventorySaid) {
			inventorySaid = true;
			logger::info("charsheet inventory: potion groups + lockpicks ready");
		}
		out["gold"] = inv.ok ? static_cast<int>(inv.gold) : 0;
		out["inventory"] = json{
			{ "potions", json{
				{ "health", inv.ok ? inv.health : 0 },
				{ "magicka", inv.ok ? inv.magicka : 0 },
				{ "stamina", inv.ok ? inv.stamina : 0 },
				{ "other", inv.ok ? inv.other : 0 },
				{ "total", inv.ok ? inv.health + inv.magicka + inv.stamina + inv.other : 0 },
			} },
			{ "lockpicks", inv.ok ? inv.lockpicks : 0 },
		};

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
		static bool effectPolicySaid = false;
		if (!effectPolicySaid) {
			effectPolicySaid = true;
			logger::info("charsheet effect policy: race lock + controller confirmation");
		}
		if (auto* mt = p->AsMagicTarget()) {
			if (auto* list = mt->GetActiveEffectList()) {
				for (auto* ae : *list) {
					if (auto row = EffectRow(p, ae))
						effects.push_back(std::move(*row));
				}
			}
		}
		out["effects"] = std::move(effects);

		out["meta"] = MetaJson(meta);

		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	namespace
	{
		// "health"|"magicka"|"stamina"|"other" -> the PotionPoolMask value a potion
		// must EXACTLY match to belong to that card. "other" is the catch-all: any
		// mask the three single-pool cards don't claim (0, or a multi-pool combo).
		// Returns -1 for an unknown category name.
		int CategoryMask(const std::string& category)
		{
			if (category == "health")  return 1;
			if (category == "magicka") return 2;
			if (category == "stamina") return 4;
			if (category == "other")   return -2;  // sentinel: "not 1/2/4"
			return -1;
		}

		bool PotionInCategory(const RE::AlchemyItem* alch, int wantMask)
		{
			const int mask = PotionPoolMask(alch);
			if (wantMask == -2)                       // "other"
				return mask != 1 && mask != 2 && mask != 4;
			return mask == wantMask;
		}

		// One potion -> its best label + magnitude + primary effect name. Magnitude
		// is the LARGEST magnitude across the potion's effects (a restore potion's
		// headline number); effect is the first effect's display name. Both are
		// best-effort and default to 0 / "".
		void DescribePotion(const RE::AlchemyItem* alch, double& magOut, std::string& effOut)
		{
			magOut = 0.0;
			effOut.clear();
			if (!alch)
				return;
			for (auto* effect : alch->effects) {
				if (!effect)
					continue;
				const double m = static_cast<double>(effect->effectItem.magnitude);
				if (m > magOut)
					magOut = m;
				if (effOut.empty() && effect->baseEffect)
					if (const char* n = effect->baseEffect->GetFullName(); n && *n)
						effOut = n;
			}
		}

		// Raw walk, SEH-guarded by the wrapper below (same seam as ReadInventory).
		// Collects the matching potions as {name,count,magnitude,effect}. Kept POD-
		// free of C++ objects that need unwinding across __try (json is built AFTER).
		struct PotionRow
		{
			std::string name;
			std::int64_t count = 0;
			double magnitude = 0.0;
			std::string effect;
			// Item identity for the mesh-render pipeline (the Items tab's pair:
			// origin plugin + file-width-masked local id). Empty for a dynamic
			// (0xFF…) potion — no render, the row keeps its glyph.
			std::string formId;
			std::string plugin;
		};

		__declspec(noinline) void ReadPackRaw(RE::PlayerCharacter* p, int wantMask,
			std::vector<PotionRow>& out, bool& ok)
		{
			ok = true;
			auto* changes = p ? p->GetInventoryChanges() : nullptr;
			if (!changes || !changes->entryList)
				return;
			for (auto* entry : *changes->entryList) {
				if (!entry || !entry->object || entry->countDelta <= 0)
					continue;
				auto* obj = entry->object;
				if (obj->GetFormType() != RE::FormType::AlchemyItem)
					continue;
				auto* alch = obj->As<RE::AlchemyItem>();
				if (!alch || alch->IsFood() || alch->IsPoison())
					continue;
				if (!PotionInCategory(alch, wantMask))
					continue;
				PotionRow row;
				if (const char* n = alch->GetFullName(); n && *n)
					row.name = n;
				if (row.name.empty())
					row.name = "Potion";
				row.count = entry->countDelta;
				DescribePotion(alch, row.magnitude, row.effect);
				if (auto* file = alch->GetFile(0)) {
					const std::uint32_t local =
						alch->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
					char buf[16];
					std::snprintf(buf, sizeof(buf), "0x%06X", local);
					row.formId = buf;
					row.plugin = std::string(file->GetFilename());
				}
				out.push_back(std::move(row));
			}
		}

		// The SEH frame must hold NO objects that need unwinding (C2712) — the
		// vector lives in the CALLER and comes in by reference; this frame is
		// PODs only, exactly the finance.cpp ReadGold seam.
		bool ReadPackSeh(RE::PlayerCharacter* p, int wantMask, std::vector<PotionRow>& out)
		{
			__try {
				bool ok = true;
				ReadPackRaw(p, wantMask, out, ok);
				return ok;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		const char* CategoryLabel(const std::string& category)
		{
			if (category == "health")  return "Health";
			if (category == "magicka") return "Magicka";
			if (category == "stamina") return "Stamina";
			return "Other";
		}
	}

	std::string BuildPackListJson(const std::string& category)
	{
		json out;
		out["category"] = category;
		out["label"]    = CategoryLabel(category);
		out["items"]    = json::array();

		const int wantMask = CategoryMask(category);
		auto*     p        = RE::PlayerCharacter::GetSingleton();
		if (wantMask == -1 || !p) {
			out["ok"] = (wantMask != -1);   // unknown category is the only "not ok"
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::vector<PotionRow> rows;
		const bool ok = ReadPackSeh(p, wantMask, rows);
		if (!ok)
			rows.clear();
		out["ok"] = ok;

		// Marker: "charsheet pack list" — hd-markers.json fingerprint.
		static bool packSaid = false;
		if (!packSaid) {
			packSaid = true;
			logger::info("charsheet pack list: per-category potion detail ready");
			logger::info("charsheet pack icons: row identity attached");  // marker: charsheet-pack-icons
		}

		// Alphabetical so the modal is stable across polls and easy to scan.
		std::sort(rows.begin(), rows.end(), [](const PotionRow& a, const PotionRow& b) {
			return a.name < b.name;
		});
		std::int64_t total = 0;
		for (const auto& r : rows) {
			total += r.count;
			out["items"].push_back(json{
				{ "name", r.name },
				{ "count", r.count },
				{ "magnitude", r.magnitude },
				{ "effect", r.effect },
				{ "formId", r.formId },
				{ "plugin", r.plugin },
			});
		}
		out["total"] = total;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RemoveEffect(const std::string& key, bool force)
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

		if (key.empty())
			return json{ { "ok", false }, { "msg", "missing effect identity — refresh the sheet" } }.dump();

		for (auto* ae : *list) {
			if (!ae || EffectKey(ae) != key)
				continue;
			// Re-check the LIVE effect. The view's shield/lock is explanation; this
			// is the security boundary against a stale or hand-written request.
			const auto mode = DispelMode(p, ae);
			if (mode == RemoveMode::kLocked)
				return json{ { "ok", false }, { "msg", "that effect is inherited from your race and stays protected" } }.dump();
			if (mode == RemoveMode::kConfirm && !force)
				return json{ { "ok", false }, { "msg", "that permanent ability may be a mod controller — confirm Remove anyway" } }.dump();

			std::string name = "effect";
			if (ae->effect && ae->effect->baseEffect)
				if (const char* n = ae->effect->baseEffect->GetFullName(); n && *n)
					name = n;

			ae->Dispel(false);
			// "charsheet: dispelled" — hd-markers.json fingerprint for this feature.
			logger::info("charsheet: dispelled effect '{}' (instance {}, uniqueID {})",
				name, key, static_cast<std::uint32_t>(ae->usUniqueID));
			return json{ { "ok", true }, { "msg", "removed " + name } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		return json{ { "ok", false }, { "msg", "that effect is no longer active" } }.dump();
	}
}
