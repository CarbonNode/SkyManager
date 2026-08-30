#include "party_sheet.h"

#include "actor_identity.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace PartySheet
{
	namespace
	{
		// A negative actor value is a real thing (a debuff can push a pool under
		// zero) and it is never what a bar should be drawn against.
		inline float Floor0(float v) { return v > 0.0f ? v : 0.0f; }

		// Hard ceiling on the scan. A retinue of twenty is the design case;
		// sixty-four is a load order doing something unusual and is still worth
		// drawing. Past that this is no longer a comparison, it is a list — and
		// the roster is already a very good list.
		constexpr std::size_t kMaxMembers = 64;

		// The vanilla CurrentFollowerFaction, the same id main.cpp's
		// HudFollowersJson() casts its net with — one definition of "following
		// you" across the HUD strip, the party bar and this sheet, or the three
		// disagree in front of the player.
		//
		// ⚠ The reference mod calls 0x0005A1A4 by this name in two places. That
		// disagrees with the id this codebase has been shipping and play-proving
		// since the HUD landed. Ours is kept, deliberately: it is the one that
		// has been observed to populate the strip for framework-driven
		// companions on this profile. Either way the lookup is null-guarded and
		// tested with IsInFaction, so a wrong id can only ever fail to ADD
		// someone — it cannot invent a member.
		constexpr RE::FormID kCurrentFollowerFac = 0x0005C84E;

		// Gold001. A Skyrim.esm static, so the id is stable in every load order.
		constexpr RE::FormID kGold = 0x0000000F;

		// The 18 skill actor values in the order the vanilla skills menu shows
		// them. Emitted as a bare array of numbers per member with ONE shared
		// name list in the envelope: twenty members times eighteen object KEYS
		// is most of a payload spent re-spelling "One-handed".
		const std::array<std::pair<RE::ActorValue, const char*>, 18>& SkillTable()
		{
			using AV = RE::ActorValue;
			static const std::array<std::pair<AV, const char*>, 18> t{ {
				{ AV::kOneHanded, "One-handed" },
				{ AV::kTwoHanded, "Two-handed" },
				{ AV::kArchery, "Archery" },
				{ AV::kBlock, "Block" },
				{ AV::kHeavyArmor, "Heavy Armor" },
				{ AV::kLightArmor, "Light Armor" },
				{ AV::kSmithing, "Smithing" },
				{ AV::kSneak, "Sneak" },
				{ AV::kLockpicking, "Lockpicking" },
				{ AV::kPickpocket, "Pickpocket" },
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

		std::string Dump(const json& j)
		{
			// error_handler replace: a follower renamed with a broken byte (a
			// mod name, a CHIM rename, a mojibaked seed) must never make the
			// dump throw — the anim-scan CTD lesson.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string NameOf(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* full = form->As<RE::TESFullName>()) {
				if (const char* n = full->GetFullName(); n && *n)
					return n;
			}
			return "";
		}

		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return "";
			auto* file = form->GetFile(0);
			return (file && file->fileName) ? std::string(file->fileName) : std::string();
		}

		// A potion belongs to exactly ONE pool, so the four counts always add up
		// to the number of pool potions carried. Same rule as CharSheet's Pack
		// Check: a multi-pool concoction goes to `other` rather than being
		// counted twice. Deliberately NOT the full consumable classifier — the
		// party sheet asks one question, "can she heal herself", and food, drink
		// and poison are the player's own business on the player's own sheet.
		//
		// A DETRIMENTAL restore-health is a poison, and a follower holding three
		// of those is not equipped to heal; it returns 0 rather than counting.
		int PotionPoolMask(const RE::AlchemyItem* alch)
		{
			if (!alch)
				return 0;
			int mask = 0;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				if (base->IsDetrimental())
					return 0;
				for (const auto av : { base->data.primaryAV, base->data.secondaryAV }) {
					if (av == RE::ActorValue::kHealth)       mask |= 1;
					else if (av == RE::ActorValue::kMagicka) mask |= 2;
					else if (av == RE::ActorValue::kStamina) mask |= 4;
				}
			}
			return mask;
		}

		// -------------------------------------------------- inventory walk --
		// ONE narrow pass per actor over the inventory-CHANGES entry list —
		// never CommonLib's GetInventory<>() rebuild, which faulted inside this
		// DLL on the 4,780-mod profile (Finance::ReadGold and CharSheet's
		// InventoryCounts carry the same note and the same shape). The reference
		// mod rebuilds the whole inventory map every frame for its modal; that
		// is exactly the cost this walk exists to avoid, and it is why the party
		// sheet is asked ON DEMAND and never from a ticker.
		//
		// Kept a POD so the wrapper below can SEH-guard the CALL without C2712:
		// the __try frame must own no C++ object that needs unwinding, which is
		// why the walk lives in its own function and the guard in the caller.
		struct InvCounts
		{
			std::int64_t gold = 0;
			std::int64_t ammoCount = 0;
			std::int64_t health = 0;
			std::int64_t magicka = 0;
			std::int64_t stamina = 0;
			std::int64_t otherPotion = 0;
			// The NOCKED arrow/bolt. Actor has no GetCurrentAmmo() — that is a
			// PlayerCharacter method — so for a follower the only answer is the
			// worn TESAmmo entry, which this walk is already standing in front
			// of. A raw pointer keeps the struct POD.
			RE::TESAmmo* ammo = nullptr;
			bool         ok = true;
		};

		__declspec(noinline) InvCounts ReadInvRaw(RE::Actor* a)
		{
			InvCounts out;
			auto*     changes = a ? a->GetInventoryChanges() : nullptr;
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (!entry || !entry->object || entry->countDelta <= 0)
						continue;
					auto*              obj   = entry->object;
					const std::int64_t count = entry->countDelta;
					if (obj->GetFormID() == kGold) {
						out.gold += count;
						continue;
					}
					if (obj->GetFormType() == RE::FormType::Ammo) {
						// The FIRST worn ammo wins — an actor can carry five
						// kinds of arrow and only one is nocked.
						if (!out.ammo && entry->IsWorn()) {
							if (auto* am = obj->As<RE::TESAmmo>()) {
								out.ammo      = am;
								out.ammoCount = count;
							}
						}
						continue;
					}
					if (obj->GetFormType() != RE::FormType::AlchemyItem)
						continue;
					auto* alch = obj->As<RE::AlchemyItem>();
					if (!alch)
						continue;
					switch (PotionPoolMask(alch)) {
					case 0: break;   // food, poison, a cure — not a pool potion
					case 1: out.health += count; break;
					case 2: out.magicka += count; break;
					case 4: out.stamina += count; break;
					default: out.otherPotion += count; break;
					}
				}
			}
			return out;
		}

		InvCounts ReadInv(RE::Actor* a)
		{
			__try {
				return ReadInvRaw(a);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				InvCounts out;
				out.ok = false;
				return out;
			}
		}

		// ---------------------------------------------------- weapon damage --
		// ⛔ Actor has no GetDamage()/GetEquippedEntryData() — both are
		// PlayerCharacter methods, which is why CharSheet can ask the engine for
		// the player's real figure and this file CANNOT ask it for a follower.
		// So the number here is the game's own published arithmetic:
		//
		//     damage = base * (1 + skill/200) * (1 + fortify/100)
		//
		// with `base` the weapon record's attack damage (plus the nocked arrow's
		// damage for a bow, which is how the engine adds it), `skill` the
		// governing skill and `fortify` its modifier actor value. Every row
		// carries `est: true` so the view draws it as "≈ 47" and never pretends
		// to a precision it does not have. What it CANNOT see is the temper on
		// that particular sword — a tempered blade reads low. That is a known,
		// stated shortfall, not a silent one.
		void FillWeaponDamage(RE::TESObjectWEAP* weap, RE::ActorValueOwner* avo,
			double arrowDamage, json& tile)
		{
			if (!weap)
				return;
			double base = static_cast<double>(weap->GetAttackDamage());
			const auto wt = weap->GetWeaponType();

			RE::ActorValue skillAv = RE::ActorValue::kOneHanded;
			RE::ActorValue fortAv  = RE::ActorValue::kOneHandedModifier;
			switch (wt) {
			case RE::WEAPON_TYPE::kTwoHandSword:
			case RE::WEAPON_TYPE::kTwoHandAxe:
				skillAv = RE::ActorValue::kTwoHanded;
				fortAv  = RE::ActorValue::kTwoHandedModifier;
				break;
			case RE::WEAPON_TYPE::kBow:
			case RE::WEAPON_TYPE::kCrossbow:
				skillAv = RE::ActorValue::kArchery;
				// The fortify actor value for Archery is named "Marksman", not
				// "Archery". Getting that wrong silently drops every archery
				// fortify effect.
				fortAv = RE::ActorValue::kMarksmanModifier;
				base += arrowDamage;   // the engine adds the arrow BEFORE the multipliers
				break;
			default:
				break;
			}

			const double skill = avo ? static_cast<double>(Floor0(avo->GetActorValue(skillAv))) : 0.0;
			const double fort  = avo ? static_cast<double>(avo->GetActorValue(fortAv)) : 0.0;
			double dmg = base * (1.0 + skill / 200.0) * (1.0 + fort / 100.0);
			if (dmg < 0.0)
				dmg = 0.0;

			tile["damage"]     = dmg;
			tile["damageBase"] = base;
			tile["skill"]      = skill;
			tile["est"]        = true;
		}

		// ------------------------------------------------------- hand tiles --
		// What is IN a hand, named the way the roster's equipped readout names
		// things so the two never describe the same sword differently. `kind` is
		// the switch the view draws on: weapon | shield | spell | staff | torch |
		// other | "" (an empty hand).
		json HandTile(RE::TESForm* form, RE::ActorValueOwner* avo, double arrowDamage)
		{
			json t{ { "kind", "" }, { "name", "" } };
			if (!form)
				return t;

			if (auto* weap = form->As<RE::TESObjectWEAP>()) {
				t["name"] = NameOf(weap);
				const auto wt = weap->GetWeaponType();
				t["kind"]   = (wt == RE::WEAPON_TYPE::kStaff) ? "staff" : "weapon";
				t["ranged"] = (wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow);
				t["speed"]  = static_cast<double>(weap->GetSpeed());
				t["reach"]  = static_cast<double>(weap->GetReach());
				FillWeaponDamage(weap, avo, arrowDamage, t);
				return t;
			}
			if (auto* armo = form->As<RE::TESObjectARMO>()) {
				// A shield is the only armour the engine ever puts in a hand.
				t["name"]  = NameOf(armo);
				t["kind"]  = "shield";
				t["armor"] = static_cast<int>(armo->GetArmorRating());
				return t;
			}
			if (auto* spell = form->As<RE::SpellItem>()) {
				t["name"] = NameOf(spell);
				t["kind"] = "spell";
				return t;
			}
			if (auto* light = form->As<RE::TESObjectLIGH>()) {
				t["name"] = NameOf(light);
				t["kind"] = "torch";
				return t;
			}
			if (auto* obj = form->As<RE::TESBoundObject>()) {
				if (const char* nm = obj->GetName(); nm && *nm)
					t["name"] = nm;
			}
			t["kind"] = "other";
			return t;
		}

		// The armour slots, as a present/absent map, the BODY piece's name, and
		// the piece COUNT the damage-reduction formula needs.
		//
		// Head falls back to hair then circlet: a hood, a helmet and a circlet
		// all answer "what is on her head", and only one of the three is ever
		// the slot the record really uses.
		//
		// `pieces` counts ONLY head/body/hands/feet, non-clothing, capped at 4 —
		// which is what Skyrim's own +3-per-piece bonus applies to. It is
		// deliberately NOT "every worn armour form": counting a shield, an
		// amulet and two rings would inflate the physical-resist percentage by
		// twelve points of a number the player checks against the vanilla UI.
		// (The reference mod counts the same four but reads only slots 30/31 for
		// the head, so a character in a CIRCLET silently loses three points
		// there. We include the circlet on purpose — same rule the head fallback
		// above already follows.)
		void FillSlots(RE::Actor* a, json& row, int& piecesOut)
		{
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;
			piecesOut  = 0;
			json slots = json::object();
			if (!a) {
				row["slots"]        = slots;
				row["body"]         = "";
				row["bodyClothing"] = false;
				return;
			}
			auto worn = [a](Slot s) -> RE::TESObjectARMO* { return a->GetWornArmor(s); };
			auto isArmour = [](RE::TESObjectARMO* p) {
				return p && p->GetArmorType() != RE::TESObjectARMO::ArmorType::kClothing;
			};

			RE::TESObjectARMO* head = worn(Slot::kHead);
			if (!head) head = worn(Slot::kHair);
			if (!head) head = worn(Slot::kCirclet);
			RE::TESObjectARMO* body  = worn(Slot::kBody);
			RE::TESObjectARMO* hands = worn(Slot::kHands);
			RE::TESObjectARMO* feet  = worn(Slot::kFeet);

			if (isArmour(head))  ++piecesOut;
			if (isArmour(body))  ++piecesOut;
			if (isArmour(hands)) ++piecesOut;
			if (isArmour(feet))  ++piecesOut;

			slots["head"]   = head != nullptr;
			slots["body"]   = body != nullptr;
			slots["hands"]  = hands != nullptr;
			slots["feet"]   = feet != nullptr;
			slots["amulet"] = worn(Slot::kAmulet) != nullptr;
			slots["ring"]   = worn(Slot::kRing) != nullptr;
			row["slots"] = std::move(slots);
			row["body"]  = body ? NameOf(body) : std::string();
			// A tavern frock and bare skin are two DIFFERENT reports, and the
			// view can only tell them apart if the payload does.
			row["bodyClothing"] = body &&
				body->GetArmorType() == RE::TESObjectARMO::ArmorType::kClothing;
		}

		// ------------------------------------------------------- one member --
		// Everything the sheet knows about one actor. Every key is ALWAYS
		// written, so the view never has to tell "absent" from "zero" — an
		// unreadable value is flagged (`invOk`, `dist` = -1) rather than omitted.
		json MemberJson(RE::Actor* a, RE::PlayerCharacter* player, bool wantSkills)
		{
			json row = json::object();
			if (!a)
				return row;

			auto* base = a->GetActorBase();
			auto* avo  = a->AsActorValueOwner();

			// ---- identity ----
			// The RUNTIME id: the key fdLiveParty and the roster already use, so
			// the view can join this row to a roster member without a second
			// spelling of "who".
			row["formId"] = a->GetFormID();
			// The DURABLE pair, for anything that wants to remember her. Empty
			// for a dynamic (0xFF……) actor, which is honest rather than a
			// fabricated id — see actor_identity.h for the light-plugin trap
			// that makes a stored runtime id point at a stranger.
			row["id"]     = ActorIdentity::HexOf(
				ActorIdentity::LocalIdOf(base ? static_cast<RE::TESForm*>(base) : nullptr));
			row["plugin"] = PluginOf(base);

			const char* dn = a->GetDisplayFullName();
			row["name"] = (dn && dn[0]) ? std::string(dn) : std::string("Follower");
			// The née name — what a portrait captured before a rename is filed
			// under, and the key the roster's portraitFor() resolves against.
			row["base"] = base ? NameOf(base) : std::string();

			row["level"]  = static_cast<int>(a->GetLevel());
			row["female"] = base ? base->IsFemale() : false;
			row["unique"] = base ? base->IsUnique() : false;
			row["race"]   = a->GetRace() ? NameOf(a->GetRace()) : std::string();

			// ---- status ----
			row["dead"]      = a->IsDead();
			row["essential"] = a->IsEssential();
			row["protected"] = a->IsProtected();
			row["ghost"]     = a->IsGhost();
			row["combat"]    = a->IsInCombat();
			row["loaded"]    = a->Is3DLoaded();
			// A conjured familiar is a teammate too, and grading one for having
			// no boots is nonsense. Flagged rather than dropped: the view hides
			// summons by default and can offer them back, which is a setting
			// rather than a rebuild.
			row["summon"] = a->IsCommandedActor();
			row["drawn"]  = false;
			if (auto* st = a->AsActorState())
				row["drawn"] = st->IsWeaponDrawn();
			{
				RE::NiPointer<RE::Actor> mount;
				row["mounted"] = a->GetMount(mount) && mount;
			}

			// TOLD TO WAIT. Someone parked in an inn is still "following" as far
			// as the engine is concerned, so without this the person at your
			// back and the one three holds away look identical — exactly the
			// confusion the party strip already learned to avoid. Same actor
			// value follower_frameworks.cpp reads to decide whether a "wait"
			// order would be a no-op.
			row["waiting"] = avo &&
				avo->GetActorValue(RE::ActorValue::kWaitingForPlayer) >= 0.5f;

			// Where she is, and how far. `dist` is -1 when it cannot be read,
			// never 0 — a zero would read as "right beside you".
			row["where"] = "";
			if (auto* loc = a->GetCurrentLocation()) {
				if (const char* n = loc->GetFullName(); n && *n)
					row["where"] = std::string(n);
			}
			row["dist"]     = -1;
			row["sameCell"] = false;
			if (player) {
				row["dist"]     = static_cast<double>(a->GetPosition().GetDistance(player->GetPosition()));
				row["sameCell"] = a->GetParentCell() != nullptr &&
					a->GetParentCell() == player->GetParentCell();
			}

			// ---- vitals ----
			// cur = GetActorValue, max = GetPermanentActorValue: the split that
			// makes a wounded follower read as WOUNDED rather than as somebody
			// with a small pool, and the same split char_sheet.cpp and
			// follower_tune.cpp already use.
			//
			// ⚠ GetPermanentActorValue is base + PERMANENT modifiers, so a
			// TEMPORARY fortify-health effect raises `hp` above `hpMax`. The
			// view clamps the bar to max(cur, max) rather than this file
			// inventing a total out of a modifier read that no other module in
			// the deck has exercised. Over-full is drawn as full; it is never
			// drawn as a bar overflowing its own track.
			auto pool = [&](RE::ActorValue av, const char* cur, const char* max) {
				if (!avo) { row[cur] = 0; row[max] = 0; return; }
				row[cur] = static_cast<double>(Floor0(avo->GetActorValue(av)));
				row[max] = static_cast<double>(Floor0(avo->GetPermanentActorValue(av)));
			};
			pool(RE::ActorValue::kHealth, "hp", "hpMax");
			pool(RE::ActorValue::kMagicka, "mag", "magMax");
			pool(RE::ActorValue::kStamina, "sta", "staMax");

			// ---- the one guarded inventory pass ----
			const InvCounts inv = ReadInv(a);
			row["invOk"]  = inv.ok;
			// Carried gold, best effort: the changes list holds what has been
			// GIVEN to her, not coin baked into her base container. Under-count
			// is possible, over-count is not.
			row["gold"]   = inv.gold;
			row["potions"] = json{
				{ "health", inv.health },
				{ "magicka", inv.magicka },
				{ "stamina", inv.stamina },
				{ "other", inv.otherPotion },
			};

			json ammo{ { "name", "" }, { "damage", 0 }, { "count", 0 } };
			double arrowDamage = 0.0;
			if (inv.ammo) {
				ammo["name"]  = NameOf(inv.ammo);
				arrowDamage   = static_cast<double>(inv.ammo->GetRuntimeData().data.damage);
				ammo["damage"] = arrowDamage;
				ammo["count"]  = inv.ammoCount;
			}
			row["ammo"] = std::move(ammo);

			// ---- what she is holding ----
			// The two-handed alias: for a greatsword, a bow or a crossbow the
			// engine reports the SAME form in both hands. Drawn naively that is
			// a follower dual-wielding one weapon, and worse, it hides the fact
			// that her off hand is genuinely empty.
			RE::TESForm* rh = a->GetEquippedObject(false);
			RE::TESForm* lh = a->GetEquippedObject(true);
			if (lh && lh == rh) {
				if (auto* rw = rh->As<RE::TESObjectWEAP>()) {
					const auto wt = rw->GetWeaponType();
					if (wt == RE::WEAPON_TYPE::kTwoHandSword || wt == RE::WEAPON_TYPE::kTwoHandAxe ||
						wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow)
						lh = nullptr;
				}
			}
			row["right"] = HandTile(rh, avo, arrowDamage);
			row["left"]  = HandTile(lh, avo, arrowDamage);
			// Unarmed is not "zero damage", it is her fists — and it is the
			// single most useful thing this sheet can shout about a retinue.
			// A spell or a staff is a weapon for this purpose; a torch is not.
			auto armed = [](const json& t) {
				const auto k = t.value("kind", std::string());
				return k == "weapon" || k == "staff" || k == "spell";
			};
			row["unarmed"] = !armed(row["right"]) && !armed(row["left"]);
			row["unarmedDamage"] = avo
				? static_cast<double>(Floor0(avo->GetActorValue(RE::ActorValue::kUnarmedDamage)))
				: 0.0;

			int pieces = 0;
			FillSlots(a, row, pieces);
			row["pieces"] = pieces;

			// ---- protection ----
			// `armor` is the raw rating the engine keeps (worn pieces, perks and
			// fortifies already summed into it); `phys` is what that rating
			// actually BUYS — clamp(rating*0.12 + 3*pieces, 0, 80), Skyrim's own
			// armour formula, which is why the four-piece census above is not
			// optional. The caps ride the payload (magic tops out at 85, not
			// 100) so the view draws each meter against the right full scale
			// instead of assuming 100.
			double rating = 0.0;
			json   resist = json::object();
			if (avo) {
				rating = static_cast<double>(Floor0(avo->GetActorValue(RE::ActorValue::kDamageResist)));
				resist["fire"]    = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistFire));
				resist["frost"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistFrost));
				resist["shock"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistShock));
				resist["magic"]   = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistMagic));
				// The engine names this one kPoisonResist, not kResistPoison.
				resist["poison"]  = static_cast<double>(avo->GetActorValue(RE::ActorValue::kPoisonResist));
				resist["disease"] = static_cast<double>(avo->GetActorValue(RE::ActorValue::kResistDisease));
			} else {
				for (const char* k : { "fire", "frost", "shock", "magic", "poison", "disease" })
					resist[k] = 0;
			}
			double phys = rating * 0.12 + 3.0 * static_cast<double>(pieces);
			if (phys < 0.0) phys = 0.0;
			if (phys > 80.0) phys = 80.0;
			row["armor"]    = rating;
			row["phys"]     = phys;
			row["capPhys"]  = 80;
			row["capMagic"] = 85;
			row["resist"]   = std::move(resist);

			// ---- what she can carry, and what she is carrying ----
			// load = the engine's own cached figure (the number the vanilla HUD
			// bar draws); carry = the kCarryWeight actor value, buffs included.
			// Neither needs a walk. An over-encumbered follower does not keep
			// up, which is why this earns a place on an overview at all.
			row["load"]  = static_cast<double>(a->GetWeightInContainer());
			row["carry"] = avo
				? static_cast<double>(Floor0(avo->GetActorValue(RE::ActorValue::kCarryWeight)))
				: 0.0;

			// ---- skills, only when asked ----
			if (wantSkills) {
				json sk = json::array();
				for (const auto& [av, label] : SkillTable()) {
					(void)label;
					sk.push_back(avo ? static_cast<int>(Floor0(avo->GetActorValue(av))) : 0);
				}
				row["skills"] = std::move(sk);
			}
			return row;
		}
	}  // namespace

	std::string BuildPartyJson(const std::string& reqJson)
	{
		json req = json::parse(reqJson, nullptr, false);
		if (req.is_discarded() || !req.is_object())
			req = json::object();

		const bool wantSkills = req.value("skills", false);

		// Extra runtime FormIDs the caller wants measured: the Followers tab
		// sends the roster members it believes are following, so anybody the two
		// faction tests miss is still read rather than silently dropped.
		std::vector<RE::FormID> asked;
		if (req.contains("ids") && req["ids"].is_array()) {
			for (const auto& v : req["ids"]) {
				if (v.is_number_unsigned())
					asked.push_back(v.get<RE::FormID>());
				else if (v.is_number_integer())
					asked.push_back(static_cast<RE::FormID>(v.get<std::int64_t>()));
				else if (v.is_string()) {
					const auto raw = ActorIdentity::ParseHex(v.get<std::string>());
					if (raw)
						asked.push_back(static_cast<RE::FormID>(raw));
				}
			}
		}

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* lists  = RE::ProcessLists::GetSingleton();
		if (!player || !lists) {
			return Dump(json{
				{ "ok", false },
				{ "msg", "No game to read yet — load a save first." },
				{ "count", 0 }, { "unloaded", 0 },
				{ "skillNames", json::array() },
				{ "members", json::array() } });
		}

		static RE::TESFaction* s_followerFac = nullptr;
		static bool            s_facTried = false;
		if (!s_facTried) {
			s_facTried    = true;
			s_followerFac = RE::TESForm::LookupByID<RE::TESFaction>(kCurrentFollowerFac);
		}

		const std::unordered_set<RE::FormID> wanted(asked.begin(), asked.end());
		std::unordered_set<RE::FormID>       seen;
		std::unordered_set<RE::FormID>       found;

		json members = json::array();
		int  nTeam = 0, nFac = 0, nAsked = 0;

		for (auto& h : lists->highActorHandles) {
			if (members.size() >= kMaxMembers)
				break;
			auto       ptr = h.get();
			RE::Actor* a   = ptr ? ptr.get() : nullptr;
			if (!a || a == player || a->IsPlayerRef())
				continue;

			const RE::FormID id = a->GetFormID();
			if (!seen.insert(id).second)
				continue;

			const bool team  = a->IsPlayerTeammate();
			const bool fac   = s_followerFac && a->IsInFaction(s_followerFac);
			const bool named = wanted.count(id) > 0;
			if (!team && !fac && !named)
				continue;
			if (team) ++nTeam; else if (fac) ++nFac; else ++nAsked;
			if (named)
				found.insert(id);

			// `source` says WHY she is on the sheet, and it is not decoration:
			// a companion showing up under "faction" with the teammate flag OFF
			// is the half-recruit state nff_control.h documents, and the view
			// can point straight at it instead of the player wondering why her
			// orders do nothing.
			json row      = MemberJson(a, player, wantSkills);
			row["source"] = team ? "teammate" : (fac ? "faction" : "asked");
			members.push_back(std::move(row));
		}

		// Anyone the caller named who is not loaded right now cannot be read at
		// all. Report the COUNT rather than leaving a gap: "4 others are too far
		// away to read" is a different sentence from showing eight people out of
		// twelve and saying nothing.
		int unloaded = 0;
		for (const auto id : wanted)
			if (!found.count(id))
				++unloaded;

		json names = json::array();
		if (wantSkills)
			for (const auto& [av, label] : SkillTable()) {
				(void)av;
				names.push_back(label);
			}

		// Logged only when the tally CHANGES, so a still scene is silent but the
		// moment the party shifts the log says exactly what the sheet saw — and,
		// if it ever reads "teammates=0 follower-faction=0" while companions are
		// plainly walking behind you, it names the detection net rather than the
		// drawing as the thing to widen.
		static std::string s_lastDiag;
		std::string        diag = "party-sheet: scan teammates=" + std::to_string(nTeam) +
			" follower-faction=" + std::to_string(nFac) +
			" named=" + std::to_string(nAsked) +
			" shown=" + std::to_string(static_cast<int>(members.size())) +
			" unloaded=" + std::to_string(unloaded);
		if (diag != s_lastDiag) {
			s_lastDiag = diag;
			logger::info("{}", diag);
		}

		return Dump(json{
			{ "ok", true },
			{ "msg", "" },
			{ "count", static_cast<int>(members.size()) },
			{ "unloaded", unloaded },
			{ "skillNames", std::move(names) },
			{ "members", std::move(members) },
		});
	}
}
