#include "npc_inspect.h"

#include "pch.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "actor_identity.h"   // DurableOf — plugin + file-width-masked local id
#include "maras.h"            // marital status, read off MARAS's own faction mirror
#include "npc_actions.h"      // the crosshair snapshot taken at palette-open
#include "relationship.h"     // the RELA rank, and its Creation Kit word

using json = nlohmann::json;

// ===========================================================================
// See npc_inspect.h for what this answers and why it is the LIVE actor rather
// than the base record. This file is the data half only — every pixel is
// npcs-pane.{js,css}'s.
//
// KNOW YOUR ENEMY 2 — deliberately NOT ported, and here is the reasoning so
// nobody has to rediscover it. The reference mod reads KYE2's per-creature
// perks and replays its Papyrus multiplier pipeline (blade/blunt/axe/bow/…
// factors against two intensity globals) to print "weak to axes". Three
// reasons that is the wrong trade for us today:
//
//   1. KYE2 IS NOT IN THIS LOAD ORDER. Checked against the live MO2 index on
//      2026-08-17: neither know_your_enemy2.esp nor know_your_enemy_2_armors
//      .esp is present (the only hits are icon-injector JSONs shipped by an
//      unrelated mod for users who do have it). Porting ~350 lines of a
//      multiplier table that cannot be run, let alone verified, against a mod
//      nobody here has installed is how untested code ships.
//   2. THE HALF THAT MATTERS ALREADY WORKS. KYE2 applies its MAGICAL
//      intensities as ordinary actor values — kResistFire and friends — so a
//      KYE2 install's elemental weaknesses appear in the resist block below
//      with no integration at all, and appear correctly for every OTHER mod
//      that touches resistances too. Only the physical (blade/blunt/axe/bow/
//      bash) multipliers live in perks, and those are the part that is a
//      verbatim replay of another mod's balance table.
//   3. What a player actually wants from "what is this thing weak to" is
//      answered load-order-independently below: the actor-type keywords say
//      WHAT it is, and a NEGATIVE resist value says what hurts it. That is
//      engine truth, it needs no mod, and it cannot go stale when KYE2
//      rebalances.
//
// If KYE2 is ever installed here, the hook is one function: probe
// LookupModByName("know_your_enemy2.esp"), then LookupByEditorID<BGSPerk>
// ("kye2_animal_perk" &c.) and add the archetype to `traits`. The multiplier
// pipeline should stay out — it is their balance data, not an engine fact.
// ===========================================================================

namespace NpcInspect
{
	namespace
	{
		// The Windows max() macro leaks through the SKSE headers and mangles a
		// std::max on '::' — the same trap char_sheet.cpp and room_guard.cpp
		// hit. A tiny local clamp-to-zero sidesteps it.
		inline double Floor0(double v) { return v > 0.0 ? v : 0.0; }

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// A refusal is a SENTENCE. `why` is the machine-readable reason so the
		// view can pick an illustration; `msg` is what a human reads.
		std::string Refuse(const char* why, const std::string& msg, int seq)
		{
			return Dump(json{
				{ "ok", false },
				{ "seq", seq },
				{ "why", why },
				{ "msg", msg },
			});
		}

		std::string NameOf(RE::TESObjectREFR* ref)
		{
			if (!ref)
				return "";
			if (const char* n = ref->GetName(); n && *n)
				return n;
			return "";
		}

		std::string FullNameOf(RE::TESForm* f)
		{
			if (!f)
				return {};
			if (auto* fn = f->As<RE::TESFullName>()) {
				if (const char* nm = fn->GetFullName(); nm && *nm)
					return nm;
			}
			if (const char* nm = f->GetName(); nm && *nm)
				return nm;
			return {};
		}

		// ------------------------------------------------------ resolution --

		// "Plugin.esp|HEX6" -> the base record, ESL-safe. The Finder's own
		// identity spelling; parsed here rather than reached for across
		// npc_finder.cpp's anonymous namespace so this module stands alone.
		RE::TESNPC* ResolveBaseId(const std::string& id)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return nullptr;
			const std::string   plugin = id.substr(0, bar);
			const std::uint32_t local = static_cast<std::uint32_t>(
				std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !local)
				return nullptr;
			auto* form = dh->LookupForm(local, plugin);
			return form ? form->As<RE::TESNPC>() : nullptr;
		}

		// A live actor's base IS `target`, or descends from it: a levelled
		// spawn carries a dynamic base whose template chain leads back to the
		// record the Finder named. Bounded, so a self-referential chain from a
		// broken plugin cannot spin.
		bool BaseDescendsFrom(RE::TESNPC* base, RE::TESNPC* target)
		{
			RE::TESNPC* n = base;
			for (int i = 0; i < 16 && n; ++i) {
				if (n == target)
					return true;
				auto* t = n->baseTemplateForm;
				n = t ? t->As<RE::TESNPC>() : nullptr;
			}
			return false;
		}

		// Scan the four process arrays, most-loaded first. The first LIVING
		// match wins; a dead one is kept as the fallback so a corpse can still
		// be inspected (and the card says so) rather than answering "nobody is
		// loaded" while you stand over the body.
		RE::Actor* FindLoaded(RE::TESNPC* target)
		{
			auto* pl = RE::ProcessLists::GetSingleton();
			if (!pl || !target)
				return nullptr;
			RE::Actor* fallback = nullptr;
			const RE::BSTArray<RE::ActorHandle>* arrays[4] = {
				&pl->highActorHandles, &pl->middleHighActorHandles,
				&pl->middleLowActorHandles, &pl->lowActorHandles
			};
			for (const auto* arr : arrays) {
				for (const auto& h : *arr) {
					auto a = h.get();
					if (!a)
						continue;
					auto* base = a->GetActorBase();
					if (!base || !BaseDescendsFrom(base, target))
						continue;
					if (a->IsDead()) {
						if (!fallback)
							fallback = a.get();
						continue;
					}
					return a.get();
				}
			}
			return fallback;
		}

		// ---------------------------------------------------- actor values --

		// {cur, max}. cur is what they have right now (it drains as you hit
		// them); max is the PERMANENT value — base plus every permanent
		// modifier — which is the number a bar must be drawn against. Same
		// split follower_tune.cpp and char_sheet.cpp read.
		json Pool(RE::ActorValueOwner* avo, RE::ActorValue av)
		{
			if (!avo)
				return json{ { "cur", 0 }, { "max", 0 } };
			return json{
				{ "cur", Floor0(static_cast<double>(avo->GetActorValue(av))) },
				{ "max", Floor0(static_cast<double>(avo->GetPermanentActorValue(av))) },
			};
		}

		double AV(RE::ActorValueOwner* avo, RE::ActorValue av)
		{
			return avo ? static_cast<double>(avo->GetActorValue(av)) : 0.0;
		}

		// The 18 skills, in the canonical order the vanilla skills menu uses.
		// These are LIVE values (level scaling, fortifies, mod perks folded in)
		// — the base record's numbers are what the Finder's ⓘ detail shows, and
		// on a levelled actor the two are wildly different on purpose.
		const std::array<std::pair<RE::ActorValue, const char*>, 18>& SkillTable()
		{
			using AVe = RE::ActorValue;
			static const std::array<std::pair<AVe, const char*>, 18> t{ {
				{ AVe::kOneHanded, "One-Handed" },
				{ AVe::kTwoHanded, "Two-Handed" },
				{ AVe::kArchery, "Archery" },
				{ AVe::kBlock, "Block" },
				{ AVe::kSmithing, "Smithing" },
				{ AVe::kHeavyArmor, "Heavy Armor" },
				{ AVe::kLightArmor, "Light Armor" },
				{ AVe::kPickpocket, "Pickpocket" },
				{ AVe::kLockpicking, "Lockpicking" },
				{ AVe::kSneak, "Sneak" },
				{ AVe::kAlchemy, "Alchemy" },
				{ AVe::kSpeech, "Speech" },
				{ AVe::kAlteration, "Alteration" },
				{ AVe::kConjuration, "Conjuration" },
				{ AVe::kDestruction, "Destruction" },
				{ AVe::kIllusion, "Illusion" },
				{ AVe::kRestoration, "Restoration" },
				{ AVe::kEnchanting, "Enchanting" },
			} };
			return t;
		}

		// ------------------------------------------------- the AI dispositions
		// Aggression, confidence, morality, assistance, energy and mood are the
		// numbers that actually decide how someone behaves — will they swing at
		// you, will they run, will they mind you picking a lock, will they join
		// in when their friend does. Skyrim shows none of them anywhere, which
		// is exactly why they belong on an inspect card. Each ships with the
		// Creation Kit's own word for the value, so the card reads like the
		// editor rather than like a debug dump; an out-of-range number (a mod
		// can set anything) answers "" and the view then prints the bare figure.

		const char* AggressionWord(int v)
		{
			switch (v) {
			case 0: return "Unaggressive";
			case 1: return "Aggressive";
			case 2: return "Very aggressive";
			case 3: return "Frenzied";
			default: return "";
			}
		}

		const char* ConfidenceWord(int v)
		{
			switch (v) {
			case 0: return "Cowardly";
			case 1: return "Cautious";
			case 2: return "Average";
			case 3: return "Brave";
			case 4: return "Foolhardy";
			default: return "";
			}
		}

		const char* MoralityWord(int v)
		{
			switch (v) {
			case 0: return "Any crime";
			case 1: return "Violence against enemies";
			case 2: return "Property crime only";
			case 3: return "No crime";
			default: return "";
			}
		}

		const char* AssistanceWord(int v)
		{
			switch (v) {
			case 0: return "Helps nobody";
			case 1: return "Helps allies";
			case 2: return "Helps friends and allies";
			default: return "";
			}
		}

		const char* MoodWord(int v)
		{
			switch (v) {
			case 0: return "Neutral";
			case 1: return "Angry";
			case 2: return "Fear";
			case 3: return "Happy";
			case 4: return "Sad";
			case 5: return "Surprised";
			case 6: return "Puzzled";
			case 7: return "Disgusted";
			default: return "";
			}
		}

		json AiRow(const char* key, const char* label, double value, const char* word, const char* note)
		{
			return json{
				{ "key", key },
				{ "label", label },
				{ "value", value },
				{ "word", word ? word : "" },
				{ "note", note ? note : "" },
			};
		}

		json AiJson(RE::ActorValueOwner* avo)
		{
			json out = json::array();
			if (!avo)
				return out;
			const int agg = static_cast<int>(AV(avo, RE::ActorValue::kAggression));
			const int con = static_cast<int>(AV(avo, RE::ActorValue::kConfidence));
			const int mor = static_cast<int>(AV(avo, RE::ActorValue::kMorality));
			const int ass = static_cast<int>(AV(avo, RE::ActorValue::kAssistance));
			const int moo = static_cast<int>(AV(avo, RE::ActorValue::kMood));
			const double ene = AV(avo, RE::ActorValue::kEnergy);
			out.push_back(AiRow("aggression", "Aggression", agg, AggressionWord(agg),
				"Whether they pick the fight — unaggressive means they never start one."));
			out.push_back(AiRow("confidence", "Confidence", con, ConfidenceWord(con),
				"Whether they finish it. Cowardly flees at the first hit; foolhardy never runs."));
			out.push_back(AiRow("morality", "Morality", mor, MoralityWord(mor),
				"What they will let YOU get away with in front of them."));
			out.push_back(AiRow("assistance", "Assistance", ass, AssistanceWord(ass),
				"Whether they join in when someone they know is attacked."));
			out.push_back(AiRow("mood", "Mood", moo, MoodWord(moo),
				"The idle expression the face animation plays."));
			out.push_back(AiRow("energy", "Energy", ene, "",
				"How much they wander while sandboxing — 0 is a statue, 100 is restless."));
			return out;
		}

		// --------------------------------------------------------- identity --

		// Item identity for the deck's mesh-render pipeline: origin plugin +
		// the FILE-WIDTH-masked local id, through ActorIdentity (never
		// GetLocalFormID() — the actor_identity null-deref lesson). Writes
		// nothing for a dynamic form, so the view keeps a glyph instead of
		// asking for a render that cannot exist.
		void PutIdentity(json& row, RE::TESForm* f)
		{
			if (!f)
				return;
			std::string fid, plug;
			if (ActorIdentity::DurableOf(f, fid, plug) && !plug.empty()) {
				row["formId"] = fid;
				row["plugin"] = plug;
			}
		}

		// ----------------------------------------------------------- equip --

		// The "+N" / "25%" cluster on a tile, read off the piece's OWN
		// enchantment record.
		//
		// ⚠ KNOWN GAP, deliberate and shared with the character sheet: a
		// PLAYER-made enchantment rides ExtraEnchantment on the inventory
		// entry, not the base form, so a self-enchanted ring shows no badge.
		// That is a false NEGATIVE — the tile simply says nothing — which is
		// the acceptable failure. Inventing a number would not be.
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
				const char* label = Shared::AvLabel(static_cast<int>(av));
				char        buf[24];
				if (Shared::AvIsPercent(static_cast<int>(av)))
					std::snprintf(buf, sizeof(buf), "%.0f%%", mag);
				else
					std::snprintf(buf, sizeof(buf), "+%.0f", mag);
				badges.push_back(json{ { "text", std::string(buf) },
					{ "av", label && *label ? label : "" } });
				++n;
			}
			// An enchantment whose every effect is scripted or zero-magnitude
			// still makes the piece enchanted — say so with a bare mark rather
			// than leaving the tile looking mundane.
			if (badges.empty()) {
				std::string nm;
				if (const char* en = item->GetFullName(); en && *en)
					nm = en;
				badges.push_back(json{ { "text", "\xE2\x9C\xA6" }, { "av", nm } });   // ✦
			}
			return badges;
		}

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

		// Which skill and which fortify actor value a weapon's damage scales
		// with. Returned as a pair so the caller can ask the actor for both.
		void WeaponSkillFor(RE::WEAPON_TYPE wt, RE::ActorValue& skill, RE::ActorValue& fortify, bool& ranged)
		{
			using WT = RE::WEAPON_TYPE;
			using AVe = RE::ActorValue;
			skill = AVe::kNone;
			fortify = AVe::kNone;
			ranged = false;
			switch (wt) {
			case WT::kOneHandSword:
			case WT::kOneHandDagger:
			case WT::kOneHandAxe:
			case WT::kOneHandMace:
				skill = AVe::kOneHanded;
				fortify = AVe::kOneHandedModifier;
				break;
			case WT::kTwoHandSword:
			case WT::kTwoHandAxe:
				skill = AVe::kTwoHanded;
				fortify = AVe::kTwoHandedModifier;
				break;
			case WT::kBow:
			case WT::kCrossbow:
				skill = AVe::kArchery;
				fortify = AVe::kMarksmanModifier;
				ranged = true;
				break;
			default:
				break;
			}
		}

		bool IsRangedWeapon(RE::TESObjectWEAP* weap)
		{
			if (!weap)
				return false;
			const auto wt = weap->GetWeaponType();
			return wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow;
		}

		// What a weapon in THIS actor's hands hits for.
		//
		// ⚠ This is an ESTIMATE and says so in the payload. The engine's own
		// answer is PlayerCharacter::GetDamage(entryData) — a PLAYER method
		// (its entry-data getter is too), so it is unreachable for anyone else.
		// The reference mod branches at exactly this point for the same reason
		// and derives the number the way the engine documents it:
		//     base * (1 + skill/200) * (1 + fortify/100)
		// plus the arrow's own damage on a bow, plus any flat elemental damage
		// the weapon's enchantment adds. Close, honestly labelled, and far
		// better than printing the naked base damage as if it were the truth.
		double EstimateWeaponDamage(RE::Actor* a, RE::ActorValueOwner* avo,
			RE::TESObjectWEAP* weap, double& outArrow, std::string& outArrowName)
		{
			outArrow = 0.0;
			outArrowName.clear();
			if (!weap)
				return 0.0;
			double base = static_cast<double>(weap->GetAttackDamage());
			RE::ActorValue skill = RE::ActorValue::kNone, fort = RE::ActorValue::kNone;
			bool           ranged = false;
			WeaponSkillFor(weap->GetWeaponType(), skill, fort, ranged);
			if (ranged && a) {
				if (auto* ammo = a->GetCurrentAmmo()) {
					outArrow = static_cast<double>(ammo->GetRuntimeData().data.damage);
					if (const char* nm = ammo->GetName(); nm && *nm)
						outArrowName = nm;
				}
			}
			const double skillLvl = (skill != RE::ActorValue::kNone) ? AV(avo, skill) : 0.0;
			const double fortify = (fort != RE::ActorValue::kNone) ? AV(avo, fort) : 0.0;
			double dmg = (base + outArrow) * (1.0 + skillLvl / 200.0) * (1.0 + fortify / 100.0);
			// A weapon enchantment that does flat health damage of an elemental
			// kind adds to what the swing takes off. Read the same way the
			// reference does: primary actor value is health, and the effect
			// resists against fire / frost / shock / poison.
			if (auto* ench = weap->As<RE::TESEnchantableForm>(); ench && ench->formEnchanting) {
				for (auto* effect : ench->formEnchanting->effects) {
					auto* b = effect ? effect->baseEffect : nullptr;
					if (!b)
						continue;
					const double mag = static_cast<double>(effect->effectItem.magnitude);
					if (mag <= 0.0 || b->data.primaryAV != RE::ActorValue::kHealth)
						continue;
					const auto rv = b->data.resistVariable;
					if (rv == RE::ActorValue::kResistFire || rv == RE::ActorValue::kResistFrost ||
						rv == RE::ActorValue::kResistShock || rv == RE::ActorValue::kPoisonResist) {
						dmg += mag;
						break;
					}
				}
			}
			return dmg < 0.0 ? 0.0 : dmg;
		}

		// One hand. A hand can hold a weapon, a shield, a spell or a torch — so
		// the tile says what it actually is instead of pretending everything is
		// a sword. The name is read off the CONCRETE record in each branch:
		// GetEquippedObject hands back a bare TESForm*, and asking a bare
		// TESForm for a display name is the kind of "probably fine" call that
		// only fails once the build is on the rig.
		json HandTile(RE::Actor* a, RE::ActorValueOwner* avo, bool left)
		{
			json t{
				{ "slot", left ? "left" : "right" },
				{ "label", left ? "Left hand" : "Right hand" },
				{ "kind", "empty" },
				{ "name", "" },
			};
			auto* form = a ? a->GetEquippedObject(left) : nullptr;
			if (!form)
				return t;
			PutIdentity(t, form);

			if (auto* weap = form->As<RE::TESObjectWEAP>()) {
				if (const char* nm = weap->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"] = "weapon";
				t["speed"] = static_cast<double>(weap->GetSpeed());
				t["reach"] = static_cast<double>(weap->GetReach());
				double      arrow = 0.0;
				std::string arrowName;
				t["damage"] = EstimateWeaponDamage(a, avo, weap, arrow, arrowName);
				t["damageEstimated"] = true;   // never the engine's own figure — see above
				if (IsRangedWeapon(weap))
					t["ranged"] = true;
				t["badges"] = EnchantBadges(weap);
				return t;
			}
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				if (const char* nm = armo->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"] = "shield";
				t["armor"] = static_cast<int>(armo->GetArmorRating());
				t["badges"] = EnchantBadges(armo);
				return t;
			}
			if (auto* spell = form->As<RE::SpellItem>()) {
				if (const char* nm = spell->GetFullName(); nm && *nm)
					t["name"] = nm;
				t["kind"] = "spell";
				return t;
			}
			if (auto* obj = form->As<RE::TESBoundObject>()) {
				if (const char* nm = obj->GetName(); nm && *nm)
					t["name"] = nm;
			}
			t["kind"] = "other";
			return t;
		}

		// The nocked arrow or bolt. No COUNT: how many an NPC is carrying would
		// need an inventory walk of theirs, and this card refuses to open a
		// stranger's bag to answer a cosmetic question. The tile shows the
		// ammunition and its damage, which is what decides how much their next
		// shot hurts.
		json AmmoTile(RE::TESAmmo* ammo)
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
			t["badges"] = EnchantBadges(ammo);
			PutIdentity(t, ammo);
			return t;
		}

		// Nine fixed tiles, in a fixed order, so the grid cannot reflow as gear
		// changes — an EMPTY slot is still a tile, it just carries no numbers.
		// Head falls back to hair then circlet, because a hood, a helmet and a
		// circlet all answer "what is on their head" and only one of the three
		// is ever the slot the record actually uses. `outPieces` counts the
		// worn, non-clothing armour in the four ARMOUR slots — the same four
		// the engine's per-piece damage-reduction bonus applies to, and the
		// other half of the physical-resist formula.
		json EquipJson(RE::Actor* a, RE::ActorValueOwner* avo, int& outPieces)
		{
			outPieces = 0;
			json out = json::array();
			if (!a)
				return out;
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;

			auto worn = [a](Slot s) -> RE::TESObjectARMO* { return a->GetWornArmor(s); };
			RE::TESObjectARMO* head = worn(Slot::kHead);
			if (!head)
				head = worn(Slot::kHair);
			if (!head)
				head = worn(Slot::kCirclet);

			struct Row { const char* key; const char* label; RE::TESObjectARMO* armo; bool counts; };
			const Row rows[] = {
				{ "head",   "Head",   head,             true },
				{ "body",   "Body",   worn(Slot::kBody),  true },
				{ "hands",  "Hands",  worn(Slot::kHands), true },
				{ "feet",   "Feet",   worn(Slot::kFeet),  true },
				{ "amulet", "Amulet", worn(Slot::kAmulet), false },
				{ "ring",   "Ring",   worn(Slot::kRing),  false },
			};
			// A robe or a full-body outfit occupies several slots at once;
			// listing it once per slot would read as six copies of the same
			// armour value. Same dedupe the wardrobe export and the character
			// sheet use.
			std::vector<RE::FormID> seen;
			for (const auto& r : rows) {
				RE::TESObjectARMO* armo = r.armo;
				if (armo) {
					const auto fid = armo->GetFormID();
					if (std::find(seen.begin(), seen.end(), fid) != seen.end())
						armo = nullptr;   // already shown on an earlier slot
					else
						seen.push_back(fid);
				}
				if (armo && r.counts &&
					armo->GetArmorType() != RE::TESObjectARMO::ArmorType::kClothing)
					++outPieces;
				out.push_back(ArmorTile(r.key, r.label, armo));
			}
			out.push_back(HandTile(a, avo, false));
			out.push_back(HandTile(a, avo, true));
			out.push_back(AmmoTile(a->GetCurrentAmmo()));
			return out;
		}

		// --------------------------------------------------------- resists --

		json ResistJson(RE::ActorValueOwner* avo, int pieces)
		{
			json r{
				{ "armor", 0 }, { "phys", 0 }, { "fire", 0 }, { "frost", 0 },
				{ "shock", 0 }, { "magic", 0 }, { "poison", 0 }, { "disease", 0 },
				{ "pieces", pieces },
				{ "capMagic", Shared::kCapMagic }, { "capPhys", Shared::kCapPhys },
			};
			if (!avo)
				return r;
			const double rating = Floor0(AV(avo, RE::ActorValue::kDamageResist));
			r["armor"] = rating;
			r["phys"] = Shared::PhysFromArmor(rating, pieces);
			r["fire"] = AV(avo, RE::ActorValue::kResistFire);
			r["frost"] = AV(avo, RE::ActorValue::kResistFrost);
			r["shock"] = AV(avo, RE::ActorValue::kResistShock);
			r["magic"] = AV(avo, RE::ActorValue::kResistMagic);
			r["poison"] = AV(avo, RE::ActorValue::kPoisonResist);
			r["disease"] = AV(avo, RE::ActorValue::kResistDisease);
			return r;
		}

		// Regeneration, in POINTS PER SECOND.
		//
		// Skyrim stores regen as a PERCENT OF MAX PER SECOND (kHealRate & co.)
		// scaled by a fortify multiplier itself expressed in percent
		// (kHealRateMult, 100 = unmodified):
		//     points/sec = max * (rate/100) * (mult/100)
		// `inCombat` rides along because the engine applies a further combat
		// penalty to HEALTH regen out of a game setting we cannot read, so the
		// view labels the figure rather than quietly printing a wrong one.
		// Honest beats precise-looking.
		json RegenJson(RE::Actor* a, RE::ActorValueOwner* avo,
			double hpMax, double magMax, double staMax)
		{
			json r{ { "has", false }, { "hp", 0 }, { "mag", 0 }, { "sta", 0 }, { "inCombat", false } };
			if (!avo)
				return r;
			auto per = [avo](RE::ActorValue rate, RE::ActorValue mult, double mx) -> double {
				return mx * (AV(avo, rate) / 100.0) * (AV(avo, mult) / 100.0);
			};
			r["hp"] = per(RE::ActorValue::kHealRate, RE::ActorValue::kHealRateMult, hpMax);
			r["mag"] = per(RE::ActorValue::kMagickaRate, RE::ActorValue::kMagickaRateMult, magMax);
			r["sta"] = per(RE::ActorValue::kStaminaRate, RE::ActorValue::kStaminaRateMult, staMax);
			r["has"] = true;
			if (a)
				r["inCombat"] = a->IsInCombat();
			return r;
		}

		// The stat block. Damage/speed/reach come from the RIGHT hand, falling
		// back to unarmed when it is empty — an empty hand is not zero damage,
		// it is their fists, and on a troll that is the whole story.
		json CombatJson(RE::Actor* a, RE::ActorValueOwner* avo)
		{
			json c{ { "damage", 0 }, { "speed", 0 }, { "reach", 0 }, { "move", 0 },
				    { "unarmed", false }, { "estimated", false }, { "weapon", "" },
				    { "ranged", false }, { "arrow", 0 }, { "arrowName", "" } };
			if (!a || !avo)
				return c;
			c["move"] = AV(avo, RE::ActorValue::kSpeedMult);

			auto* form = a->GetEquippedObject(false);
			auto* weap = form ? form->As<RE::TESObjectWEAP>() : nullptr;
			if (!weap) {
				// A creature's attack lives on its race, not on a weapon it
				// holds — so the LEFT hand is worth one more look before
				// calling it unarmed.
				auto* lform = a->GetEquippedObject(true);
				weap = lform ? lform->As<RE::TESObjectWEAP>() : nullptr;
			}
			if (weap) {
				if (const char* nm = weap->GetFullName(); nm && *nm)
					c["weapon"] = nm;
				double      arrow = 0.0;
				std::string arrowName;
				c["damage"] = EstimateWeaponDamage(a, avo, weap, arrow, arrowName);
				c["estimated"] = true;
				double mult = AV(avo, RE::ActorValue::kWeaponSpeedMult);
				if (mult <= 0.0)
					mult = 1.0;
				c["speed"] = static_cast<double>(weap->GetSpeed()) * mult;
				c["reach"] = static_cast<double>(weap->GetReach());
				c["ranged"] = IsRangedWeapon(weap);
				c["arrow"] = arrow;
				c["arrowName"] = arrowName;
			} else {
				c["damage"] = Floor0(AV(avo, RE::ActorValue::kUnarmedDamage));
				c["unarmed"] = true;
			}
			return c;
		}

		// -------------------------------------------------------- effects --

		// Which pile an active effect belongs on. "constant" is the fifth the
		// live profile forces: a modded actor carries scores of permanent
		// controller abilities, and filing those under "buff" would bury the
		// handful you actually came to read.
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

		// Where an effect CAME from, in one word, straight off the source
		// record's own spell type. No name-sniffing: guessing "blessing" from
		// the English word in a spell's title is wrong the moment the game is
		// not in English.
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

		std::optional<json> EffectRow(RE::ActiveEffect* ae)
		{
			if (!ae)
				return std::nullopt;
			// Effects already on their way out still sit in the list for a
			// frame and would flicker in the UI.
			if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
				ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
				return std::nullopt;

			auto* eff = ae->effect;
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				return std::nullopt;

			std::string name;
			if (const char* n = base->GetFullName(); n && *n)
				name = n;
			if (name.empty())
				name = "Effect";

			RE::MagicItem* src = ae->spell;
			std::string    source, plugin;
			if (src) {
				if (const char* sn = src->GetFullName(); sn && *sn)
					source = sn;
				std::string fid;
				ActorIdentity::DurableOf(src, fid, plugin);
			}

			const double durSec = ae->duration > 0.0f ? static_cast<double>(ae->duration) : 0.0;
			const double remainSec = durSec > 0.0
				? Floor0(static_cast<double>(ae->duration - ae->elapsedSeconds))
				: 0.0;

			// "Harmful" is the record's own detrimental flag PLUS the engine's
			// hostility bit — a fear or a frenzy is hostile without being
			// flagged detrimental, and filing it under buffs would be a lie.
			const bool harmful =
				base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kDetrimental) ||
				base->IsHostile();
			const bool hidden =
				base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI);

			return json{
				{ "name", std::move(name) },
				{ "source", std::move(source) },
				{ "plugin", std::move(plugin) },
				{ "magnitude", static_cast<double>(ae->magnitude) },
				{ "durSec", durSec },
				{ "remainSec", remainSec },
				{ "harmful", harmful },
				{ "group", EffectGroup(src, harmful, durSec) },
				{ "sourceKind", EffectSourceKind(src) },
				{ "av", Shared::AvLabel(static_cast<int>(base->data.primaryAV)) },
				{ "hidden", hidden },
			};
		}

		// --------------------------------------------------------- traits --

		// WHAT this thing is, off the engine's own actor-type keywords. Every
		// probe is a string lookup, so a keyword a given load order does not
		// define simply never matches — a false negative, never a crash and
		// never a wrong claim. Order is deliberate: the specific kinds first,
		// so a draugr reads "Undead" rather than "Person".
		json TraitsJson(RE::Actor* a)
		{
			json out = json::array();
			if (!a)
				return out;
			auto add = [&out](const char* text, const char* kind) {
				out.push_back(json{ { "text", text }, { "kind", kind } });
			};
			struct K { const char* kwd; const char* text; const char* kind; };
			static const K kinds[] = {
				{ "ActorTypeUndead",  "Undead",  "type" },
				{ "ActorTypeDaedra",  "Daedra",  "type" },
				{ "ActorTypeDwarven", "Dwarven", "type" },
				{ "ActorTypeDragon",  "Dragon",  "type" },
				{ "ActorTypeGiant",   "Giant",   "type" },
				{ "ActorTypeFalmer",  "Falmer",  "type" },
				{ "ActorTypeAnimal",  "Animal",  "type" },
				{ "ActorTypeCreature", "Creature", "type" },
				{ "ActorTypeNPC",     "Person",  "type" },
			};
			bool named = false;
			for (const auto& k : kinds) {
				if (a->HasKeywordString(k.kwd)) {
					// A draugr carries Undead AND NPC; the first, most specific
					// hit is the useful label. Creature/NPC are the fallbacks.
					const bool generic = (k.text[0] == 'P' || k.text[0] == 'C');
					if (generic && named)
						continue;
					add(k.text, k.kind);
					named = true;
				}
			}
			// Beast blood, best-effort, off the race — the same two cheap
			// signals char_sheet.cpp's BeastOf reads for the player. A miss is
			// silence, never a wrong guess.
			if (auto* race = a->GetRace()) {
				auto scan = [](const char* s, const char* needle) {
					if (!s || !*s)
						return false;
					std::string lo = s;
					std::transform(lo.begin(), lo.end(), lo.begin(),
						[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
					return lo.find(needle) != std::string::npos;
				};
				const char* eid = race->GetFormEditorID();
				const char* nm = race->GetFullName();
				if (scan(eid, "vampire") || scan(nm, "vampire"))
					add("Vampire", "beast");
				else if (scan(eid, "werewolf") || scan(nm, "werewolf") || scan(eid, "werebeast"))
					add("Werewolf", "beast");
			}
			if (a->IsGhost())
				add("Ghost — physical weapons pass through", "beast");
			return out;
		}

		// -------------------------------------------------------- social --

		json FactionList(RE::TESNPC* base)
		{
			json out = json::array();
			if (!base)
				return out;
			for (const auto& fr : base->factions) {
				if (out.size() >= 32)
					break;
				if (!fr.faction)
					continue;
				std::string nm = FullNameOf(fr.faction);
				if (nm.empty()) {
					if (const char* eid = fr.faction->GetFormEditorID(); eid && *eid)
						nm = eid;
				}
				if (nm.empty())
					continue;
				out.push_back(json{ { "n", nm }, { "rank", static_cast<int>(fr.rank) } });
			}
			return out;
		}

		json SocialJson(RE::Actor* a, RE::TESNPC* base)
		{
			json s;
			const auto rel = Relationship::Of(a);
			s["rank"] = json{
				{ "has", rel.has },
				{ "rank", rel.rank },
				{ "label", Relationship::LabelOf(rel.rank) },
			};
			s["teammate"] = a ? a->IsPlayerTeammate() : false;
			if (auto* p = RE::PlayerCharacter::GetSingleton(); p && a)
				s["hostile"] = a->IsHostileToActor(p);
			else
				s["hostile"] = false;
			s["factions"] = FactionList(base);
			// MARAS, when installed. Its own faction-rank mirror is the
			// authority; with the mod absent the key is simply not emitted, so
			// "no maras key" means "no MARAS", never "not married".
			if (Maras::Installed()) {
				const auto st = Maras::Of(a);
				const auto payload = Maras::Json(st);
				if (!payload.empty()) {
					auto j = json::parse(payload, nullptr, false);
					if (!j.is_discarded())
						s["maras"] = std::move(j);
				}
			}
			return s;
		}

		// ---------------------------------------------------- the payload --

		json BuildFor(RE::Actor* a, const char* src, int seq)
		{
			auto* base = a->GetActorBase();
			auto* avo = a->AsActorValueOwner();

			json out{ { "ok", true }, { "seq", seq }, { "src", src } };

			json who;
			who["name"] = NameOf(a);
			if (who["name"].get<std::string>().empty() && base)
				who["name"] = FullNameOf(base);
			if (who["name"].get<std::string>().empty())
				who["name"] = "Someone";
			who["ref"] = ActorIdentity::HexOf(a->GetFormID());
			if (base) {
				std::string fid, plug;
				if (ActorIdentity::DurableOf(base, fid, plug)) {
					who["formId"] = fid;
					who["plugin"] = plug;
				}
			}
			who["level"] = static_cast<int>(a->GetLevel());
			if (auto* race = a->GetRace()) {
				who["race"] = FullNameOf(race);
				if (const char* eid = race->GetFormEditorID(); eid && *eid)
					who["raceEditorId"] = eid;
			}
			if (base) {
				if (base->npcClass) {
					std::string cls = FullNameOf(base->npcClass);
					if (cls.empty()) {
						if (const char* eid = base->npcClass->GetFormEditorID(); eid && *eid)
							cls = eid;
					}
					if (!cls.empty())
						who["cls"] = cls;
				}
				if (base->combatStyle) {
					std::string cs = FullNameOf(base->combatStyle);
					if (cs.empty()) {
						if (const char* eid = base->combatStyle->GetFormEditorID(); eid && *eid)
							cs = eid;
					}
					if (!cs.empty())
						who["combatStyle"] = cs;
				}
				if (base->voiceType) {
					if (const char* veid = base->voiceType->GetFormEditorID(); veid && *veid)
						who["voice"] = veid;
				}
				who["sex"] = base->IsFemale() ? "Female" : "Male";
				who["essential"] = base->IsEssential();
				who["protected"] = base->IsProtected();
				who["unique"] = base->IsUnique();
				who["summonable"] = base->IsSummonable();
			}
			who["dead"] = a->IsDead();
			who["inCombat"] = a->IsInCombat();
			out["who"] = std::move(who);

			out["pools"] = json{
				{ "hp", Pool(avo, RE::ActorValue::kHealth) },
				{ "mag", Pool(avo, RE::ActorValue::kMagicka) },
				{ "sta", Pool(avo, RE::ActorValue::kStamina) },
			};

			// Read the maxima back out of what was just serialized rather than
			// asking the engine again: the regen figure is a fraction of the
			// SAME max the bar above it is drawn against, and two reads a frame
			// apart could disagree.
			const double hpMax = out["pools"]["hp"].value("max", 0.0);
			const double magMax = out["pools"]["mag"].value("max", 0.0);
			const double staMax = out["pools"]["sta"].value("max", 0.0);
			out["regen"] = RegenJson(a, avo, hpMax, magMax, staMax);

			int pieces = 0;
			out["equip"] = EquipJson(a, avo, pieces);
			out["resist"] = ResistJson(avo, pieces);
			out["combat"] = CombatJson(a, avo);
			out["ai"] = AiJson(avo);
			out["traits"] = TraitsJson(a);
			out["social"] = SocialJson(a, base);

			json skills = json::array();
			if (avo) {
				for (const auto& [av, label] : SkillTable())
					skills.push_back(json{ { "name", label },
						{ "level", Floor0(AV(avo, av)) } });
			}
			out["skills"] = std::move(skills);

			json effects = json::array();
			if (auto* mt = a->AsMagicTarget()) {
				if (auto* list = mt->GetActiveEffectList()) {
					for (auto* ae : *list) {
						if (auto row = EffectRow(ae))
							effects.push_back(std::move(*row));
					}
				}
			}
			out["effects"] = std::move(effects);
			return out;
		}
	}

	// ================================================================ API ==

	std::string InspectJson(const std::string& reqJson)
	{
		json in = json::object();
		{
			const auto j = json::parse(reqJson, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				in = j;
		}
		const int         seq = in.value("seq", 0);
		const std::string id = in.value("id", std::string(""));
		const std::string ref = in.value("ref", std::string(""));

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Refuse("nosave", "No save is loaded, so there is nobody to look at.", seq);

		RE::Actor* actor = nullptr;
		const char* src = "crosshair";

		if (!ref.empty()) {
			src = "ref";
			const auto fid = ActorIdentity::ParseHex(ref);
			actor = fid ? RE::TESForm::LookupByID<RE::Actor>(fid) : nullptr;
			if (!actor)
				return Refuse("gone", "That reference is not in the world any more.", seq);
		} else if (!id.empty()) {
			src = "id";
			auto* base = ResolveBaseId(id);
			if (!base)
				return Refuse("gone", "That record is not in the load order any more.", seq);
			std::string who = "They";
			if (const char* nm = base->GetName(); nm && *nm)
				who = nm;
			actor = FindLoaded(base);
			if (!actor)
				return Refuse("unloaded",
					who + " isn't anywhere in the loaded world right now — bring them to you "
					      "first, then inspect.",
					seq);
		} else {
			// The crosshair, snapshotted the instant the palette opened (before
			// the pause and the cursor menu take the target away).
			const auto fid = NpcActions::TargetFormID();
			if (!fid) {
				// The non-actor twin tells us WHY there is no person: looking at
				// a chest is a different refusal from looking at nothing, and
				// saying so is the difference between a card and a dead button.
				const auto itemRef = NpcActions::ItemRefFormID();
				if (itemRef) {
					auto*       r = RE::TESForm::LookupByID<RE::TESObjectREFR>(itemRef);
					std::string nm = NameOf(r);
					if (nm.empty())
						nm = "That";
					return Refuse("object", nm + " is a thing, not a person — inspect only reads "
					                             "people and creatures.", seq);
				}
				return Refuse("nothing",
					"Nothing was in your crosshair when the deck opened. Look at someone, "
					"press the deck key again, and inspect.", seq);
			}
			actor = RE::TESForm::LookupByID<RE::Actor>(fid);
			if (!actor)
				return Refuse("gone", "Whoever you were looking at is no longer loaded.", seq);
		}

		if (actor->IsPlayerRef())
			return Refuse("object",
				"That is you — the Character tab is your own sheet, in far more detail.", seq);

		static bool said = false;
		if (!said) {
			said = true;
			logger::info("npc-inspect: live-actor card ready (pools, resists, gear, effects)");
		}

		json out;
		try {
			out = BuildFor(actor, src, seq);
		} catch (...) {
			// A half-built record from a third-party plugin must not take the
			// palette with it. An honest refusal beats a crash.
			logger::warn("npc-inspect: build threw while reading an actor — refused");
			return Refuse("gone", "Something about that character could not be read.", seq);
		}
		const std::string name = out["who"].value("name", std::string("someone"));
		logger::info("npc-inspect: built for '{}'", name);
		return Dump(out);
	}

	namespace Shared
	{
		const char* AvLabel(int actorValue)
		{
			using AVe = RE::ActorValue;
			switch (static_cast<AVe>(actorValue)) {
			case AVe::kHealth: return "Health";
			case AVe::kMagicka: return "Magicka";
			case AVe::kStamina: return "Stamina";
			case AVe::kCarryWeight: return "Carry";
			case AVe::kHealRate: case AVe::kHealRateMult: return "Health regen";
			case AVe::kMagickaRate: case AVe::kMagickaRateMult: return "Magicka regen";
			case AVe::kStaminaRate: case AVe::kStaminaRateMult: return "Stamina regen";
			case AVe::kDamageResist: return "Armour";
			case AVe::kResistFire: return "Fire resist";
			case AVe::kResistFrost: return "Frost resist";
			case AVe::kResistShock: return "Shock resist";
			case AVe::kResistMagic: return "Magic resist";
			case AVe::kPoisonResist: return "Poison resist";
			case AVe::kResistDisease: return "Disease resist";
			case AVe::kSpeedMult: return "Speed";
			case AVe::kUnarmedDamage: return "Unarmed";
			case AVe::kWeaponSpeedMult: return "Weapon speed";
			case AVe::kAttackDamageMult: return "Attack damage";
			case AVe::kCriticalChance: return "Critical chance";
			case AVe::kInvisibility: return "Invisibility";
			case AVe::kParalysis: return "Paralysis";
			case AVe::kAbsorbChance: return "Spell absorption";
			case AVe::kReflectDamage: return "Reflect damage";
			case AVe::kOneHanded: case AVe::kOneHandedModifier: return "One-Handed";
			case AVe::kTwoHanded: case AVe::kTwoHandedModifier: return "Two-Handed";
			case AVe::kArchery: case AVe::kMarksmanModifier: return "Archery";
			case AVe::kBlock: case AVe::kBlockModifier: return "Block";
			case AVe::kSmithing: case AVe::kSmithingModifier: return "Smithing";
			case AVe::kHeavyArmor: case AVe::kHeavyArmorModifier: return "Heavy Armor";
			case AVe::kLightArmor: case AVe::kLightArmorModifier: return "Light Armor";
			case AVe::kPickpocket: case AVe::kPickpocketModifier: return "Pickpocket";
			case AVe::kLockpicking: case AVe::kLockpickingModifier: return "Lockpicking";
			case AVe::kSneak: case AVe::kSneakingModifier: return "Sneak";
			case AVe::kAlchemy: case AVe::kAlchemyModifier: return "Alchemy";
			case AVe::kSpeech: case AVe::kSpeechcraftModifier: return "Speech";
			case AVe::kAlteration: case AVe::kAlterationModifier: return "Alteration";
			case AVe::kConjuration: case AVe::kConjurationModifier: return "Conjuration";
			case AVe::kDestruction: case AVe::kDestructionModifier: return "Destruction";
			case AVe::kIllusion: case AVe::kIllusionModifier: return "Illusion";
			case AVe::kRestoration: case AVe::kRestorationModifier: return "Restoration";
			case AVe::kEnchanting: case AVe::kEnchantingModifier: return "Enchanting";
			default: return "";
			}
		}

		bool AvIsPercent(int actorValue)
		{
			using AVe = RE::ActorValue;
			switch (static_cast<AVe>(actorValue)) {
			case AVe::kResistFire: case AVe::kResistFrost: case AVe::kResistShock:
			case AVe::kResistMagic: case AVe::kPoisonResist: case AVe::kResistDisease:
			case AVe::kHealRate: case AVe::kMagickaRate: case AVe::kStaminaRate:
			case AVe::kHealRateMult: case AVe::kMagickaRateMult: case AVe::kStaminaRateMult:
			case AVe::kSpeedMult: case AVe::kCriticalChance: case AVe::kAbsorbChance:
			case AVe::kOneHandedModifier: case AVe::kTwoHandedModifier:
			case AVe::kMarksmanModifier: case AVe::kBlockModifier:
			case AVe::kSmithingModifier: case AVe::kHeavyArmorModifier:
			case AVe::kLightArmorModifier: case AVe::kPickpocketModifier:
			case AVe::kLockpickingModifier: case AVe::kSneakingModifier:
			case AVe::kAlchemyModifier: case AVe::kSpeechcraftModifier:
			case AVe::kAlterationModifier: case AVe::kConjurationModifier:
			case AVe::kDestructionModifier: case AVe::kIllusionModifier:
			case AVe::kRestorationModifier: case AVe::kEnchantingModifier:
				return true;
			default:
				return false;
			}
		}

		double PhysFromArmor(double armorRating, int pieces)
		{
			double phys = armorRating * 0.12 + 3.0 * static_cast<double>(pieces);
			if (phys < 0.0)
				phys = 0.0;
			if (phys > static_cast<double>(kCapPhys))
				phys = static_cast<double>(kCapPhys);
			return phys;
		}
	}
}
