#include "char_sheet.h"

#include "actor_identity.h"
#include "faith.h"   // Wintersun's own tracker quest — the Faith card
#include "hotbar.h"  // ClassifyConsumable / WaterDrinks — the ONE shared classifier

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
			// Consumables (2026-08-15). The four potion cards above stay
			// disjoint and keep summing to `total`; these four are their own
			// row: poison/food count items, `drink` counts BOTTLES and
			// includes water (the Drink category includes water everywhere),
			// `water` counts DRINKS (a full waterskin is three of them).
			std::int64_t poison = 0;
			std::int64_t food = 0;
			std::int64_t drink = 0;
			std::int64_t water = 0;
			// Resistances + equipment (2026-08-17, Rober's "bring the sheet up to
			// Party Sheet" ask). Both ride the ONE existing walk on purpose: the
			// brief forbids a second inventory pass, and both answers are already
			// in front of us here.
			//   armorPieces — WORN, non-clothing armour. Skyrim's physical damage
			//     reduction is armourRating*0.12 + 3 per worn piece (capped 80),
			//     so the piece COUNT is half the formula; without it the number
			//     would be wrong, and a wrong number is worse than none.
			//   ammoCount   — how many of the currently-nocked arrow/bolt you
			//     carry. Deliberately NOT GetItemCount(ammo): that runs its own
			//     inventory query, which is the exact call shape that faulted in
			//     this DLL on the 4k-plugin profile.
			std::int64_t armorPieces = 0;
			std::int64_t ammoCount = 0;
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

		// `nocked` is the currently-drawn ammo (may be null). Passed IN rather than
		// fetched here so the SEH frame stays free of anything that needs a call
		// into the engine before the walk it is guarding.
		__declspec(noinline) InventoryCounts ReadInventoryRaw(RE::PlayerCharacter* p, RE::TESAmmo* nocked)
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
					// Nocked ammo: the quiver count the equipment tile shows.
					if (nocked && obj == static_cast<RE::TESBoundObject*>(nocked)) {
						out.ammoCount += count;
						continue;
					}
					// Worn armour census for the damage-reduction formula. Clothing
					// is excluded because it carries no armour rating and the
					// engine's per-piece bonus does not apply to it.
					if (obj->GetFormType() == RE::FormType::Armor) {
						if (entry->IsWorn()) {
							auto* armo = obj->As<RE::TESObjectARMO>();
							if (armo && armo->GetArmorType() != RE::TESObjectARMO::ArmorType::kClothing)
								++out.armorPieces;
						}
						continue;
					}
					if (obj->GetFormType() != RE::FormType::AlchemyItem)
						continue;
					auto* alch = obj->As<RE::AlchemyItem>();
					if (!alch)
						continue;
					using CK = Hotbar::ConsumableKind;
					switch (Hotbar::ClassifyConsumable(alch)) {
					case CK::kPoison:
						out.poison += count;
						continue;
					case CK::kFood:
						out.food += count;
						continue;
					case CK::kDrink:
						out.drink += count;
						continue;
					case CK::kWater:
						out.drink += count;
						out.water += count * Hotbar::WaterDrinks(alch);
						continue;
					default:
						break;  // a plain potion — the four pool cards below
					}
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

		InventoryCounts ReadInventory(RE::PlayerCharacter* p, RE::TESAmmo* nocked)
		{
			__try {
				return ReadInventoryRaw(p, nocked);
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

		// ============================================================ 2026-08-17 ==
		// Rober saw Skyrim Party Sheet and asked for our equivalent surfaces at
		// that bar: "the visuals of this is super nice… we could grab a lot of the
		// features… active effects", then, on gear: "look at the equipment has
		// +20, damage and count for arrows, a red number for swords, +x on
		// trinkets". Everything below is the DATA half of that — the presentation
		// is entirely charsheet-pane.{js,css}'s, per his constraint ("do not
		// obviously copy… can take all the inspiration and flare").
		//
		// The engine plumbing (which actor value, which formula) was checked
		// against Skyrim Party Sheet's MIT-licensed source, which builds on the
		// same CommonLibSSE-NG we do — so every call spelled here is proven to
		// compile and to be the right answer. Those are facts about Skyrim, not
		// their expression; nothing below is copied text. See the session report
		// for the attribution note.

		// What one actor value is CALLED on a badge. Deliberately partial: it
		// covers what an enchantment can plausibly fortify, and answers "" for
		// anything else so the caller can fall back to a generic mark rather than
		// print a made-up label.
		const char* AvLabel(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kHealth: return "Health";
			case AV::kMagicka: return "Magicka";
			case AV::kStamina: return "Stamina";
			case AV::kCarryWeight: return "Carry";
			case AV::kHealRate: case AV::kHealRateMult: return "Health regen";
			case AV::kMagickaRate: case AV::kMagickaRateMult: return "Magicka regen";
			case AV::kStaminaRate: case AV::kStaminaRateMult: return "Stamina regen";
			case AV::kDamageResist: return "Armour";
			case AV::kResistFire: return "Fire resist";
			case AV::kResistFrost: return "Frost resist";
			case AV::kResistShock: return "Shock resist";
			case AV::kResistMagic: return "Magic resist";
			case AV::kPoisonResist: return "Poison resist";
			case AV::kResistDisease: return "Disease resist";
			case AV::kSpeedMult: return "Speed";
			case AV::kUnarmedDamage: return "Unarmed";
			case AV::kOneHanded: case AV::kOneHandedModifier: return "One-Handed";
			case AV::kTwoHanded: case AV::kTwoHandedModifier: return "Two-Handed";
			case AV::kArchery: case AV::kMarksmanModifier: return "Archery";
			case AV::kBlock: case AV::kBlockModifier: return "Block";
			case AV::kSmithing: case AV::kSmithingModifier: return "Smithing";
			case AV::kHeavyArmor: case AV::kHeavyArmorModifier: return "Heavy Armor";
			case AV::kLightArmor: case AV::kLightArmorModifier: return "Light Armor";
			case AV::kPickpocket: case AV::kPickpocketModifier: return "Pickpocket";
			case AV::kLockpicking: case AV::kLockpickingModifier: return "Lockpicking";
			case AV::kSneak: case AV::kSneakingModifier: return "Sneak";
			case AV::kAlchemy: case AV::kAlchemyModifier: return "Alchemy";
			case AV::kSpeech: case AV::kSpeechcraftModifier: return "Speech";
			case AV::kAlteration: case AV::kAlterationModifier: return "Alteration";
			case AV::kConjuration: case AV::kConjurationModifier: return "Conjuration";
			case AV::kDestruction: case AV::kDestructionModifier: return "Destruction";
			case AV::kIllusion: case AV::kIllusionModifier: return "Illusion";
			case AV::kRestoration: case AV::kRestorationModifier: return "Restoration";
			case AV::kEnchanting: case AV::kEnchantingModifier: return "Enchanting";
			default: return "";
			}
		}

		// Is this actor value expressed as a PERCENTAGE on an enchantment (so the
		// badge reads "25%") rather than as flat points ("+25")? Resists and the
		// *Modifier / *Rate variants are percentages; the pools and the base
		// skills are points. Getting this wrong is how a +25 Health amulet would
		// claim "25% Health".
		bool AvIsPercent(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kResistFire: case AV::kResistFrost: case AV::kResistShock:
			case AV::kResistMagic: case AV::kPoisonResist: case AV::kResistDisease:
			case AV::kHealRate: case AV::kMagickaRate: case AV::kStaminaRate:
			case AV::kHealRateMult: case AV::kMagickaRateMult: case AV::kStaminaRateMult:
			case AV::kSpeedMult:
			case AV::kOneHandedModifier: case AV::kTwoHandedModifier:
			case AV::kMarksmanModifier: case AV::kBlockModifier:
			case AV::kSmithingModifier: case AV::kHeavyArmorModifier:
			case AV::kLightArmorModifier: case AV::kPickpocketModifier:
			case AV::kLockpickingModifier: case AV::kSneakingModifier:
			case AV::kAlchemyModifier: case AV::kSpeechcraftModifier:
			case AV::kAlterationModifier: case AV::kConjurationModifier:
			case AV::kDestructionModifier: case AV::kIllusionModifier:
			case AV::kRestorationModifier: case AV::kEnchantingModifier:
				return true;
			default:
				return false;
			}
		}

		// Item identity for the deck's mesh-render pipeline: origin plugin + the
		// FILE-WIDTH-masked local id (never GetLocalFormID() — the actor_identity
		// null-deref lesson). Writes nothing for a dynamic (0xFF…) form, so the
		// view keeps a glyph instead of asking for a render that cannot exist.
		void PutIdentity(json& row, RE::TESForm* f)
		{
			if (!f)
				return;
			auto* file = f->GetFile(0);
			if (!file)
				return;
			const std::uint32_t local = f->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%06X", local);
			row["formId"] = buf;
			row["plugin"] = std::string(file->GetFilename());
		}

		// The "+N" / "25%" cluster on an equipment tile — Rober's "+x on trinkets".
		// Read off the form's OWN enchantment record.
		//
		// ⚠ KNOWN GAP, deliberate: a PLAYER-made enchantment does not live on the
		// base form (it rides ExtraEnchantment on the inventory entry), so a
		// self-enchanted ring shows no badge here. That is a false NEGATIVE — the
		// tile simply says nothing — which is the acceptable failure. Inventing a
		// number would not be.
		json EnchantBadges(RE::TESForm* form)
		{
			json badges = json::array();
			auto* ench = form ? form->As<RE::TESEnchantableForm>() : nullptr;
			auto* item = ench ? ench->formEnchanting : nullptr;
			if (!item)
				return badges;
			int n = 0;
			for (auto* effect : item->effects) {
				if (n >= 3)   // three is all a tile can carry without clipping
					break;
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				const double mag = static_cast<double>(effect->effectItem.magnitude);
				if (mag <= 0.0)
					continue;
				const auto  av = base->data.primaryAV;
				const char* label = AvLabel(av);
				std::string text;
				char        buf[24];
				if (AvIsPercent(av))
					std::snprintf(buf, sizeof(buf), "%.0f%%", mag);
				else
					std::snprintf(buf, sizeof(buf), "+%.0f", mag);
				text = buf;
				badges.push_back(json{
					{ "text", text },
					{ "av", label && *label ? label : "" },
				});
				++n;
			}
			// An enchantment whose every effect is scripted / zero-magnitude still
			// makes the piece enchanted — say so with a bare mark rather than
			// leaving the tile looking mundane.
			if (badges.empty()) {
				std::string nm;
				if (const char* en = item->GetFullName(); en && *en)
					nm = en;
				badges.push_back(json{ { "text", "\xE2\x9C\xA6" }, { "av", nm } });   // ✦
			}
			return badges;
		}

		// One worn-armour tile. `armo` may be null — an EMPTY slot is still a tile
		// (the grid must not reflow as you swap gear), it just carries no numbers.
		json ArmorTile(const char* key, const char* label, RE::TESObjectARMO* armo)
		{
			json t{
				{ "slot", key },
				{ "label", label },
				{ "kind", "armor" },
				{ "name", "" },
			};
			if (!armo)
				return t;
			if (const char* nm = armo->GetFullName(); nm && *nm)
				t["name"] = nm;
			t["armor"] = static_cast<int>(armo->GetArmorRating());
			t["badges"] = EnchantBadges(armo);
			PutIdentity(t, armo);
			return t;
		}

		// One hand. A hand can hold a weapon (damage, speed, reach), a shield or
		// other armour, a spell, or a torch — so the tile says what it actually
		// is instead of pretending everything is a sword.
		//
		// Damage: ask the ENGINE via GetDamage(entryData), which already folds in
		// skill, fortify effects, the smithing temper and the weapon's own
		// enchantment scaling. Deriving it by hand from base × (1 + skill/200)
		// gets a number that is close and wrong; only the fallback (no entry data)
		// does that, and it says so with `damageEstimated`.
		json HandTile(RE::PlayerCharacter* p, bool left)
		{
			json t{
				{ "slot", left ? "left" : "right" },
				{ "label", left ? "Left hand" : "Right hand" },
				{ "kind", "empty" },
				{ "name", "" },
			};
			auto* form = p ? p->GetEquippedObject(left) : nullptr;
			if (!form)
				return t;
			PutIdentity(t, form);
			// The name is read off the CONCRETE record in each branch below.
			// GetEquippedObject hands back a bare TESForm*, and asking a bare
			// TESForm for a display name is the kind of "probably fine" call that
			// only fails once the build is on Rober's rig.

			if (auto* weap = form->As<RE::TESObjectWEAP>()) {
				if (const char* nm = weap->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"]  = "weapon";
				t["speed"] = static_cast<double>(weap->GetSpeed());
				t["reach"] = static_cast<double>(weap->GetReach());
				double dmg = static_cast<double>(weap->GetAttackDamage());
				bool   est = true;
				if (auto* entry = p->GetEquippedEntryData(left)) {
					dmg = static_cast<double>(p->GetDamage(entry));
					est = false;
				}
				t["damage"] = dmg < 0.0 ? 0.0 : dmg;
				if (est)
					t["damageEstimated"] = true;
				const auto wt = weap->GetWeaponType();
				const bool ranged = wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow;
				if (ranged)
					t["ranged"] = true;
				t["badges"] = EnchantBadges(weap);
				return t;
			}
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				if (const char* nm = armo->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"]   = "shield";
				t["armor"]  = static_cast<int>(armo->GetArmorRating());
				t["badges"] = EnchantBadges(armo);
				return t;
			}
			if (auto* spell = form->As<RE::SpellItem>()) {
				if (const char* nm = spell->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"] = "spell";
				return t;
			}
			// A torch, a lantern, anything else holdable.
			if (auto* obj = form->As<RE::TESBoundObject>()) {
				if (const char* nm = obj->GetName(); nm && *nm)
					t["name"] = nm;
			}
			t["kind"] = "other";
			return t;
		}

		// The nocked arrow/bolt: its own damage and how many you have left. Both
		// are what Rober asked for by name ("damage and count for arrows").
		json AmmoTile(RE::TESAmmo* ammo, std::int64_t count)
		{
			json t{
				{ "slot", "ammo" },
				{ "label", "Ammo" },
				{ "kind", "ammo" },
				{ "name", "" },
			};
			if (!ammo)
				return t;
			if (const char* nm = ammo->GetName(); nm && *nm)
				t["name"] = nm;
			t["damage"] = static_cast<double>(ammo->GetRuntimeData().data.damage);
			t["count"]  = count;
			t["badges"] = EnchantBadges(ammo);
			PutIdentity(t, ammo);
			return t;
		}

		// Every worn slot, in a fixed order so the grid never reflows. Head falls
		// back to hair then circlet, because a hood, a helmet and a circlet all
		// answer "what is on your head" and only one of the three is ever the
		// slot the record actually uses.
		json EquipJson(RE::PlayerCharacter* p, RE::TESAmmo* nocked, std::int64_t ammoCount)
		{
			json out = json::array();
			if (!p)
				return out;
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;

			auto worn = [p](Slot s) -> RE::TESObjectARMO* { return p->GetWornArmor(s); };
			RE::TESObjectARMO* head = worn(Slot::kHead);
			if (!head)
				head = worn(Slot::kHair);
			if (!head)
				head = worn(Slot::kCirclet);

			struct Row { const char* key; const char* label; RE::TESObjectARMO* armo; };
			const Row rows[] = {
				{ "head",   "Head",   head },
				{ "body",   "Body",   worn(Slot::kBody) },
				{ "hands",  "Hands",  worn(Slot::kHands) },
				{ "feet",   "Feet",   worn(Slot::kFeet) },
				{ "amulet", "Amulet", worn(Slot::kAmulet) },
				{ "ring",   "Ring",   worn(Slot::kRing) },
			};
			// A robe or a full-body outfit occupies several slots at once; listing
			// it once per slot would read as six copies of the same armour value.
			// Same dedupe the wardrobe export uses.
			std::vector<RE::FormID> seen;
			for (const auto& r : rows) {
				RE::TESObjectARMO* a = r.armo;
				if (a) {
					const auto id = a->GetFormID();
					if (std::find(seen.begin(), seen.end(), id) != seen.end())
						a = nullptr;   // already shown on an earlier slot
					else
						seen.push_back(id);
				}
				out.push_back(ArmorTile(r.key, r.label, a));
			}
			out.push_back(HandTile(p, false));
			out.push_back(HandTile(p, true));
			out.push_back(AmmoTile(nocked, ammoCount));
			return out;
		}

		// Resistances. Six of the seven are plain actor values already expressed
		// as percentages; `armor` is the raw rating and `phys` is what that rating
		// actually BUYS you.
		//
		// phys = clamp(rating*0.12 + 3*wornPieces, 0, 80) — Skyrim's own armour
		// formula (the per-piece bonus is why the piece census above exists), and
		// the 80% figure is the engine's hard cap. `magic` caps at 85 in vanilla;
		// both caps ride the payload so the view draws each meter against the
		// right full scale instead of assuming 100.
		json ResistJson(RE::ActorValueOwner* avo, std::int64_t armorPieces)
		{
			json r{
				{ "armor", 0 }, { "phys", 0 }, { "fire", 0 }, { "frost", 0 },
				{ "shock", 0 }, { "magic", 0 }, { "poison", 0 }, { "disease", 0 },
				{ "pieces", static_cast<int>(armorPieces) },
				{ "capMagic", 85 }, { "capPhys", 80 },
			};
			if (!avo)
				return r;
			const double rating = static_cast<double>(Floor0(avo->GetActorValue(RE::ActorValue::kDamageResist)));
			double phys = rating * 0.12 + 3.0 * static_cast<double>(armorPieces);
			if (phys < 0.0)
				phys = 0.0;
			if (phys > 80.0)
				phys = 80.0;
			r["armor"]   = rating;
			r["phys"]    = phys;
			r["fire"]    = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistFire));
			r["frost"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistFrost));
			r["shock"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistShock));
			r["magic"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistMagic));
			r["poison"]  = static_cast<double>(avo->GetActorValue(RE::ActorValue::kPoisonResist));
			r["disease"] = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistDisease));
			return r;
		}

		// Regeneration, in POINTS PER SECOND — the number the reference sheet puts
		// under each bar and the one Rober pointed at.
		//
		// Skyrim stores regen as a PERCENT OF MAX PER SECOND (kHealRate & co.,
		// vanilla 0.7 / 3.0 / 5.0) scaled by a fortify multiplier expressed in
		// percent (kHealRateMult, 100 = unmodified). So:
		//     points/sec = max * (rate/100) * (mult/100)
		// `inCombat` rides along because the engine applies a further combat
		// penalty to HEALTH regen that is a game setting we cannot read — the view
		// says "out of combat" rather than printing a number it cannot stand
		// behind. Honest beats precise-looking.
		json RegenJson(RE::ActorValueOwner* avo, RE::PlayerCharacter* p,
			double hpMax, double magMax, double staMax)
		{
			json r{ { "has", false }, { "hp", 0 }, { "mag", 0 }, { "sta", 0 }, { "inCombat", false } };
			if (!avo)
				return r;
			auto per = [avo](RE::ActorValue rate, RE::ActorValue mult, double mx) -> double {
				const double base = static_cast<double>(avo->GetActorValue(rate));
				const double m    = static_cast<double>(avo->GetActorValue(mult));
				return mx * (base / 100.0) * (m / 100.0);
			};
			r["hp"]  = per(RE::ActorValue::kHealRate, RE::ActorValue::kHealRateMult, hpMax);
			r["mag"] = per(RE::ActorValue::kMagickaRate, RE::ActorValue::kMagickaRateMult, magMax);
			r["sta"] = per(RE::ActorValue::kStaminaRate, RE::ActorValue::kStaminaRateMult, staMax);
			r["has"] = true;
			if (p)
				r["inCombat"] = p->IsInCombat();
			return r;
		}

		// The stat block: what you hit for, how fast, how far, how quickly you
		// move, and what you have left to spend. Damage/speed/reach come from the
		// RIGHT hand's weapon (the hand the engine's own damage call reads), and
		// fall back to unarmed when that hand is empty — an empty hand is not zero
		// damage, it is your fists.
		json CombatJson(RE::PlayerCharacter* p, RE::ActorValueOwner* avo)
		{
			json c{ { "damage", 0 }, { "speed", 0 }, { "reach", 0 }, { "move", 0 },
				    { "perks", 0 }, { "unarmed", false } };
			if (!p || !avo)
				return c;
			c["move"] = static_cast<double>(avo->GetActorValue(RE::ActorValue::kSpeedMult));

			auto* form = p->GetEquippedObject(false);
			auto* weap = form ? form->As<RE::TESObjectWEAP>() : nullptr;
			if (weap) {
				double dmg = static_cast<double>(weap->GetAttackDamage());
				if (auto* entry = p->GetEquippedEntryData(false))
					dmg = static_cast<double>(p->GetDamage(entry));
				c["damage"] = dmg < 0.0 ? 0.0 : dmg;
				// The weapon's own swing speed, scaled by whatever is fortifying it.
				double mult = static_cast<double>(avo->GetActorValue(RE::ActorValue::kWeaponSpeedMult));
				if (mult <= 0.0)
					mult = 1.0;
				c["speed"] = static_cast<double>(weap->GetSpeed()) * mult;
				c["reach"] = static_cast<double>(weap->GetReach());
			} else {
				c["damage"]  = static_cast<double>(Floor0(avo->GetActorValue(RE::ActorValue::kUnarmedDamage)));
				c["unarmed"] = true;
			}
			c["perks"] = static_cast<int>(p->GetGameStatsData().perkCount);
			return c;
		}

		// Which pile an active effect belongs on: Rober asked for buff / debuff /
		// disease / poison. "constant" is the fifth that the live profile forces —
		// a modded save carries scores of permanent controller abilities, and
		// filing those under "buff" would bury the twelve rows you actually came
		// to read.
		const char* EffectGroup(RE::MagicItem* src, bool harmful, double durSec)
		{
			using T = RE::MagicSystem::SpellType;
			if (src) {
				switch (src->GetSpellType()) {
				case T::kDisease:
				case T::kAddiction:
					return "disease";
				case T::kPoison:
					return "poison";
				default:
					break;
				}
			}
			if (harmful)
				return "debuff";
			if (durSec <= 0.0)
				return "constant";
			return "buff";
		}

		// Where an effect CAME from, in one word, straight off the source record's
		// own spell type. No name-sniffing: guessing "blessing" from the English
		// word in a spell's title is wrong the moment the game is not in English.
		const char* EffectSourceKind(RE::MagicItem* src)
		{
			using T = RE::MagicSystem::SpellType;
			if (!src)
				return "";
			switch (src->GetSpellType()) {
			case T::kSpell:            return "spell";
			case T::kLeveledSpell:     return "spell";
			case T::kAbility:          return "ability";
			case T::kPower:            return "power";
			case T::kLesserPower:      return "power";
			case T::kVoicePower:       return "shout";
			case T::kEnchantment:      return "enchantment";
			case T::kStaffEnchantment: return "staff";
			case T::kScroll:           return "scroll";
			case T::kWortCraft:        return "ingredient";
			case T::kPotion:           return "potion";
			case T::kPoison:           return "poison";
			case T::kDisease:          return "disease";
			case T::kAddiction:        return "addiction";
			default:                   return "";
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

			// "Harmful" is the record's own detrimental flag, plus the engine's
			// hostility bit — a fear or a frenzy is hostile without being flagged
			// detrimental, and filing it under Buffs would be a lie.
			const bool harmful = base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kDetrimental) ||
				base->IsHostile();
			const RemoveMode remove  = DispelMode(player, ae);
			const char* removeName = remove == RemoveMode::kSafe ? "safe" :
				(remove == RemoveMode::kConfirm ? "confirm" : "locked");

			// 2026-08-17: the fields the rebuilt Active Effects card groups and
			// explains by. `hidden` is the record's own kHideInUI flag — the game
			// keeps those off the magic menu because they are plumbing. We keep
			// the ROW (this tab is an inspector; you may well want to dispel one)
			// and let the view fold it away, which is the honest middle.
			const char* group  = EffectGroup(src, harmful, durSec);
			const char* srcKind = EffectSourceKind(src);
			const char* avName  = AvLabel(base->data.primaryAV);
			const bool  hidden  = base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI);

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
				{ "group", group },
				{ "sourceKind", srcKind },
				{ "av", avName },
				{ "hidden", hidden },
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
				{ "consumables", json{ { "poison", 0 }, { "food", 0 }, { "drink", 0 }, { "water", 0 } } },
				{ "waterOk", false },
				{ "lockpicks", 0 },
			};
			out["souls"]   = json{ { "dragon", 0 } };
			out["bounty"]  = 0;
			out["beast"]   = "";
			out["skills"]  = json::array();
			out["effects"] = json::array();
			// 2026-08-17 blocks: present but empty, so the view's normalize sees
			// the keys it expects and draws its own "no save" states rather than
			// falling back to the pre-1.12 layout on a main-menu snapshot.
			out["regen"]   = json{ { "has", false }, { "hp", 0 }, { "mag", 0 }, { "sta", 0 }, { "inCombat", false } };
			out["resist"]  = json{ { "armor", 0 }, { "phys", 0 }, { "fire", 0 }, { "frost", 0 },
				                   { "shock", 0 }, { "magic", 0 }, { "poison", 0 }, { "disease", 0 },
				                   { "pieces", 0 }, { "capMagic", 85 }, { "capPhys", 80 } };
			out["combat"]  = json{ { "damage", 0 }, { "speed", 0 }, { "reach", 0 }, { "move", 0 },
				                   { "perks", 0 }, { "unarmed", false } };
			out["equip"]   = json::array();
			// Faith is read off Wintersun's quest script, which does not resolve
			// with no save loaded — an absent card, not a wrong one.
			out["faith"]   = json{ { "present", false }, { "active", false } };
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

		// Fetched here, outside the guarded walk, and handed in: the walk counts
		// how many of THIS ammo you carry (see InventoryCounts::ammoCount).
		RE::TESAmmo* nocked = p->GetCurrentAmmo();
		const auto   inv    = ReadInventory(p, nocked);
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
			// Consumable cards (2026-08-15): poison/food/drink/water. drink
			// includes water bottles; water counts DRINKS. waterOk lets the
			// view hide the Water card honestly when no water mod is present.
			{ "consumables", json{
				{ "poison", inv.ok ? inv.poison : 0 },
				{ "food", inv.ok ? inv.food : 0 },
				{ "drink", inv.ok ? inv.drink : 0 },
				{ "water", inv.ok ? inv.water : 0 },
			} },
			{ "waterOk", Hotbar::WaterModPresent() },
			{ "lockpicks", inv.ok ? inv.lockpicks : 0 },
		};

		int dragon = 0;
		if (avo)
			dragon = static_cast<int>(Floor0(avo->GetActorValue(RE::ActorValue::kDragonSouls)));
		out["souls"]  = json{ { "dragon", dragon } };
		out["bounty"] = ReadBounty(p);
		out["beast"]  = BeastOf(p);

		// ---- 2026-08-17: regen · resistances · combat stats · worn equipment ---
		// All four ride the ONE snapshot this function already builds. Marker
		// literal below is the deploy fingerprint for the whole block.
		static bool sheetV2Said = false;
		if (!sheetV2Said) {
			sheetV2Said = true;
			logger::info("charsheet gear+resist: equipment, resistances and regen ready");
		}
		{
			// Read the pools back out of what we already serialized instead of
			// asking the engine again — the regen figure is a fraction of the SAME
			// max the bar above it is drawn against, and two reads a frame apart
			// could disagree.
			const double hpMax  = out["hp"].value("max", 0.0);
			const double magMax = out["mag"].value("max", 0.0);
			const double staMax = out["sta"].value("max", 0.0);
			out["regen"]  = RegenJson(avo, p, hpMax, magMax, staMax);
		}
		out["resist"] = ResistJson(avo, inv.ok ? inv.armorPieces : 0);
		out["combat"] = CombatJson(p, avo);
		out["equip"]  = EquipJson(p, nocked, inv.ok ? inv.ammoCount : 0);

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

		// Faith (Wintersun). Rides the sheet's own snapshot rather than a bridge
		// of its own: it is a card on this tab, the 2 s poll already refreshes it,
		// and the phone portal keeps working unchanged (it simply ignores a key it
		// does not know). `present:false` when Wintersun is not installed, and the
		// view then draws nothing at all.
		out["faith"] = Faith::BuildJson();

		out["meta"] = MetaJson(meta);

		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	namespace
	{
		// "health"|"magicka"|"stamina"|"other" -> the PotionPoolMask value a potion
		// must EXACTLY match to belong to that card. "other" is the catch-all: any
		// mask the three single-pool cards don't claim (0, or a multi-pool combo).
		// The consumable categories (2026-08-15) ride negative sentinels and match
		// through the shared classifier instead of the mask. Returns -1 for an
		// unknown category name.
		int CategoryMask(const std::string& category)
		{
			if (category == "health")  return 1;
			if (category == "magicka") return 2;
			if (category == "stamina") return 4;
			if (category == "other")   return -2;  // sentinel: "not 1/2/4"
			if (category == "poison")  return -3;
			if (category == "food")    return -4;
			if (category == "drink")   return -5;  // includes water, by design
			if (category == "water")   return -6;
			return -1;
		}

		bool PotionInCategory(const RE::AlchemyItem* alch, int wantMask)
		{
			using CK = Hotbar::ConsumableKind;
			const auto kind = Hotbar::ClassifyConsumable(alch);
			switch (wantMask) {
			case -3: return kind == CK::kPoison;
			case -4: return kind == CK::kFood;
			case -5: return kind == CK::kDrink || kind == CK::kWater;
			case -6: return kind == CK::kWater;
			default: break;
			}
			// The four classic cards are POTIONS only — food/poison/drink/water
			// belong to their own cards above, exactly as ReadInventoryRaw counts.
			if (kind != CK::kPotion)
				return false;
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
				if (!alch)
					continue;
				// No food/poison pre-filter any more (2026-08-15): the category
				// decides — PotionInCategory keeps the four classic cards
				// potions-only and routes poison/food/drink/water to theirs.
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
			if (category == "poison")  return "Poisons";
			if (category == "food")    return "Food";
			if (category == "drink")   return "Drinks";
			if (category == "water")   return "Water";
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
