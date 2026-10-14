#include "inventory_pane.h"

#include "actor_identity.h"
#include "book_reader.h"
#include "game_icons.h"
#include "item_icons.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <chrono>
#include <filesystem>
#include <unordered_map>
#include <fstream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::, the logger and nlohmann json.hpp.

namespace InventoryPane
{
	using json = nlohmann::json;
	namespace fs = std::filesystem;

	namespace
	{
		// Skyrim.esm's Gold001. The header shows the purse; a "Gold (12,840)"
		// row in Misc is noise the vanilla menu does not show either.
		constexpr std::uint32_t kGoldLocal = 0x0000000F;
		// Skyrim.esm's LeftHand equip slot (transmog.cpp uses the same id).
		constexpr std::uint32_t kLeftHandSlotId = 0x00013F43;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		json Refuse(const std::string& msg)
		{
			return json{ { "ok", false }, { "msg", msg } };
		}

		// "<Missing Name>" is the engine's placeholder for a form with no FULL
		// record (transmog.cpp found it the hard way) — treated as nameless.
		bool NoName(const char* s)
		{
			return !s || !*s || std::strcmp(s, "<Missing Name>") == 0;
		}

		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* file = form->GetFile(0))
				return std::string(file->GetFilename());
			return "";
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		float Round1(float v) { return std::round(v * 10.0f) / 10.0f; }

		// =========================================================== sidecar ==

		fs::path SidecarPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "inventory.json";
		}

		json ReadSidecar()
		{
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return json::object();
			std::stringstream ss;
			ss << in.rdbuf();
			auto j = json::parse(ss.str(), nullptr, false);
			return (j.is_discarded() || !j.is_object()) ? json::object() : j;
		}

		// ===================================================== classification ==

		// Biped slot bits (slot N = bit N-30).
		constexpr std::uint32_t kHead = 1u << 0, kHair = 1u << 1, kBody = 1u << 2, kHands = 1u << 3,
		                        kForearms = 1u << 4, kAmulet = 1u << 5, kRing = 1u << 6, kFeet = 1u << 7,
		                        kCalves = 1u << 8, kShield = 1u << 9, kCirclet = 1u << 12;

		const char* SlotLabel(std::uint32_t m)
		{
			if (m & kBody) return "Body";
			if (m & kShield) return "Shield";
			if (m & (kHead | kHair | kCirclet)) return (m & kCirclet) && !(m & kHead) ? "Circlet" : "Head";
			if (m & (kHands | kForearms)) return "Hands";
			if (m & (kFeet | kCalves)) return "Feet";
			if (m & kAmulet) return "Neck";
			if (m & kRing) return "Ring";
			return "Other";
		}

		const char* WeaponSub(RE::TESObjectWEAP* w)
		{
			switch (w->GetWeaponType()) {
			case RE::WEAPON_TYPE::kHandToHandMelee: return "Fist";
			case RE::WEAPON_TYPE::kOneHandSword:    return "Sword";
			case RE::WEAPON_TYPE::kOneHandDagger:   return "Dagger";
			case RE::WEAPON_TYPE::kOneHandAxe:      return "War axe";
			case RE::WEAPON_TYPE::kOneHandMace:     return "Mace";
			case RE::WEAPON_TYPE::kTwoHandSword:    return "Greatsword";
			case RE::WEAPON_TYPE::kTwoHandAxe:      return "Battleaxe";
			case RE::WEAPON_TYPE::kBow:             return "Bow";
			case RE::WEAPON_TYPE::kStaff:           return "Staff";
			case RE::WEAPON_TYPE::kCrossbow:        return "Crossbow";
			default:                                return "Weapon";
			}
		}

		struct Kind
		{
			std::string cat;
			std::string sub;
		};

		Kind Classify(RE::TESBoundObject* obj)
		{
			switch (obj->GetFormType()) {
			case RE::FormType::Weapon:
				{
					auto* w = obj->As<RE::TESObjectWEAP>();
					return { "weapon", w ? WeaponSub(w) : "Weapon" };
				}
			case RE::FormType::Armor:
				{
					auto* a = obj->As<RE::TESObjectARMO>();
					if (!a)
						return { "armor", "Armor" };
					const auto mask = static_cast<std::uint32_t>(a->GetSlotMask());
					const std::string slot = SlotLabel(mask);
					if (a->IsShield() || (mask & kShield))
						return { "shield", std::string(a->IsHeavyArmor() ? "Heavy" : a->IsLightArmor() ? "Light" : "") + (a->IsHeavyArmor() || a->IsLightArmor() ? " shield" : "Shield") };
					const bool jewelLike = (mask & (kAmulet | kRing | kCirclet)) && !(mask & (kBody | kHands | kFeet | kHead));
					if (jewelLike || a->HasKeywordString("ArmorJewelry"))
						return { "jewelry", slot == "Neck" ? "Amulet" : slot };
					if (a->IsHeavyArmor())
						return { "armor", "Heavy · " + slot };
					if (a->IsLightArmor())
						return { "armor", "Light · " + slot };
					return { "clothing", "Clothing · " + slot };
				}
			case RE::FormType::Ammo:
				{
					auto* am = obj->As<RE::TESAmmo>();
					return { "ammo", am && am->IsBolt() ? "Bolt" : "Arrow" };
				}
			case RE::FormType::Scroll:     return { "scroll", "Scroll" };
			case RE::FormType::Ingredient: return { "ingredient", "Ingredient" };
			case RE::FormType::SoulGem:    return { "soulgem", "Soul gem" };
			case RE::FormType::KeyMaster:  return { "key", "Key" };
			case RE::FormType::Light:      return { "light", "Torch" };
			case RE::FormType::Book:
				{
					auto* b = obj->As<RE::TESObjectBOOK>();
					if (b && b->TeachesSpell())
						return { "tome", "Spell tome" };
					if (b && b->TeachesSkill())
						return { "book", "Skill book" };
					return { "book", "Book" };
				}
			case RE::FormType::AlchemyItem:
				{
					auto* al = obj->As<RE::AlchemyItem>();
					if (al && al->IsPoison())
						return { "poison", "Poison" };
					if (al && al->IsFood())
						return { "food", "Food" };
					return { "potion", "Potion" };
				}
			default:
				return { "misc", "Misc" };
			}
		}

		// ============================================================ groups ==

		// One player-visible line of the inventory: one or more of a base's
		// extra-data lists (nullptr = the plain, extra-less remainder) that
		// look identical to a player. See the header for why rows are this.
		struct Group
		{
			std::string                     gk;
			std::string                     name;
			std::vector<RE::ExtraDataList*> lists;   // nullptr = the plain remainder
			std::vector<std::int32_t>       counts;  // parallel to lists
			std::int32_t                    count = 0;
			int                             eq = 0;  // 0 none, 1 right/worn, 2 left, 3 both
			bool                            fav = false;
			bool                            stolen = false;
			bool                            ench = false;
			bool                            poisoned = false;
			bool                            quest = false;
			int                             soul = -1;
			float                           dmg = -1.0f;
			float                           ar = -1.0f;
			std::int32_t                    value = 0;
			float                           weight = 0.0f;
			std::string                     enchName;
		};

		struct Stack
		{
			RE::TESBoundObject*     obj = nullptr;
			RE::InventoryEntryData* real = nullptr;   // the live entry (may be null for a pure base count)
			std::int32_t            total = 0;
			std::vector<Group>      groups;
		};

		std::uint32_t Fnv(const std::string& s)
		{
			std::uint32_t h = 2166136261u;
			for (unsigned char c : s) {
				h ^= c;
				h *= 16777619u;
			}
			return h;
		}

		RE::InventoryEntryData* RealEntryFor(RE::PlayerCharacter* player, RE::TESBoundObject* obj)
		{
			auto* changes = player ? player->GetInventoryChanges() : nullptr;
			if (!changes || !changes->entryList)
				return nullptr;
			for (auto* entry : *changes->entryList)
				if (entry && entry->object == obj)
					return entry;
			return nullptr;
		}

		// Read one instance the way the menu reads it: a scratch entry that
		// holds exactly that list. ~InventoryEntryData deletes the BSSimpleList
		// container it allocated in AddExtraList — its nodes, never the
		// ExtraDataList they point at (CommonLibSSE-NG InventoryEntryData.cpp),
		// so the live list is untouched.
		void Fill(RE::PlayerCharacter* player, RE::TESBoundObject* obj, RE::ExtraDataList* xl,
			std::int32_t cnt, Group& g)
		{
			RE::InventoryEntryData tmp(obj, cnt);
			if (xl)
				tmp.AddExtraList(xl);

			const char* dn = xl ? xl->GetDisplayName(obj) : nullptr;
			if (NoName(dn))
				dn = obj->GetName();
			g.name = NoName(dn) ? std::string() : std::string(dn);

			if (xl) {
				const bool right = xl->HasType(RE::ExtraDataType::kWorn);
				const bool left = xl->HasType(RE::ExtraDataType::kWornLeft);
				g.eq = right && left ? 3 : left ? 2 : right ? 1 : 0;
				g.fav = xl->HasType(RE::ExtraDataType::kHotkey);
				if (auto* s = xl->GetByType<RE::ExtraSoul>())
					g.soul = static_cast<int>(s->GetContainedSoul());
			}
			g.stolen = !tmp.IsOwnedBy(player, true);
			g.quest = tmp.IsQuestObject();
			g.poisoned = tmp.IsPoisoned();
			auto* ench = tmp.GetEnchantment();
			g.ench = ench != nullptr;
			if (ench && !NoName(ench->GetName()))
				g.enchName = ench->GetName();
			g.value = tmp.GetValue();
			g.weight = obj->GetWeight();
			if (obj->IsWeapon())
				g.dmg = player->GetDamage(&tmp);
			else if (obj->IsArmor())
				g.ar = player->GetArmorValue(&tmp);
			if (g.soul < 0) {
				if (auto* gem = obj->As<RE::TESSoulGem>())
					g.soul = static_cast<int>(gem->GetContainedSoul());
			}
		}

		std::string Signature(const RE::TESBoundObject* obj, const Group& g)
		{
			char buf[160];
			std::snprintf(buf, sizeof(buf), "%p|%d|%d|%d|%d|%d|%d|%d|%.1f|%.1f|%d",
				static_cast<const void*>(obj), g.eq, g.fav, g.stolen, g.ench, g.poisoned, g.quest, g.soul,
				g.dmg, g.ar, g.value);
			return g.name + "|" + buf;
		}

		// Every stack the player carries, grouped. The order of groups inside
		// a stack is the order of its lists, so it is stable between a list
		// read and the verb that follows it.
		std::vector<Stack> ReadStacks(RE::PlayerCharacter* player, RE::TESBoundObject* only = nullptr)
		{
			std::vector<Stack> out;
			auto inv = only ? player->GetInventory([only](RE::TESBoundObject& o) { return &o == only; })
			                : player->GetInventory();
			out.reserve(inv.size());
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				Stack st;
				st.obj = obj;
				st.total = data.first;
				st.real = RealEntryFor(player, obj);

				std::int32_t listed = 0;
				auto add = [&](RE::ExtraDataList* xl, std::int32_t cnt) {
					if (cnt <= 0)
						return;
					Group g;
					Fill(player, obj, xl, cnt, g);
					if (g.name.empty())
						return;
					const std::string sig = Signature(obj, g);
					for (auto& have : st.groups) {
						if (have.gk == sig) {
							have.lists.push_back(xl);
							have.counts.push_back(cnt);
							have.count += cnt;
							return;
						}
					}
					g.gk = sig;
					g.lists.push_back(xl);
					g.counts.push_back(cnt);
					g.count = cnt;
					st.groups.push_back(std::move(g));
				};
				if (st.real && st.real->extraLists) {
					for (auto* xl : *st.real->extraLists) {
						if (!xl)
							continue;
						const std::int32_t c = xl->GetCount();
						add(xl, c);
						listed += c;
					}
				}
				add(nullptr, st.total - listed);
				// The signature is long and carries a pointer; the wire gets a
				// short hash of it, with the stack's base in front so two
				// bases can never collide on the same key.
				for (auto& g : st.groups) {
					char h[12];
					std::snprintf(h, sizeof(h), "%08X", Fnv(g.gk));
					g.gk = h;
				}
				if (!st.groups.empty())
					out.push_back(std::move(st));
			}
			return out;
		}

		struct Target
		{
			Stack  stack;
			Group* group = nullptr;
		};

		bool Find(RE::PlayerCharacter* player, const json& j, Target& t, std::string& why)
		{
			const std::string id = j.value("id", std::string());
			const std::string pl = j.value("pl", std::string());
			const std::string gk = j.value("gk", std::string());
			auto* form = ActorIdentity::Resolve(id, pl);
			auto* obj = form ? form->As<RE::TESBoundObject>() : nullptr;
			if (!obj) {
				why = "That item didn't resolve - its mod may be off";
				return false;
			}
			auto stacks = ReadStacks(player, obj);
			if (stacks.empty()) {
				why = "You aren't carrying that any more";
				return false;
			}
			t.stack = std::move(stacks.front());
			for (auto& g : t.stack.groups)
				if (g.gk == gk)
					t.group = &g;
			if (!t.group) {
				// The instance changed under us (re-equipped, tempered, a
				// script renamed it). Fall back to the base's only line when
				// there is exactly one; otherwise refuse rather than guess.
				if (t.stack.groups.size() == 1) {
					t.group = &t.stack.groups.front();
				} else {
					why = "That stack changed - pick it again";
					return false;
				}
			}
			return true;
		}

		std::string MaterialOf(RE::TESBoundObject* obj);   // below, with the card facts

		// Game-icon answers per (form, instance state): the I4 rule walk is the
		// expensive part of a list read and its inputs never change for a form
		// within a session. Dynamic forms (0xFF...) are not cached.
		std::unordered_map<std::string, GameIcons::Icon> g_iconCache;

		const GameIcons::Icon& GameIconOf(RE::TESBoundObject* obj, const Group& g)
		{
			char key[96];
			std::snprintf(key, sizeof(key), "%08X|%d|%d|%d|%d|%d|%d", obj->GetFormID(), g.eq != 0, g.stolen,
				g.ench, g.poisoned, g.soul, static_cast<int>(g.dmg >= 0 ? 1 : 0));
			auto it = g_iconCache.find(key);
			if (it != g_iconCache.end())
				return it->second;
			GameIcons::Instance in;
			in.equipped = g.eq != 0;
			in.stolen = g.stolen;
			in.enchanted = g.ench;
			in.poisoned = g.poisoned;
			in.soul = g.soul;
			in.value = g.value;
			in.weight = g.weight;
			in.damage = g.dmg;
			in.armor = g.ar;
			auto ic = GameIcons::For(obj, in);
			if ((obj->GetFormID() >> 24) == 0xFF) {
				static GameIcons::Icon scratch;
				scratch = std::move(ic);
				return scratch;
			}
			return g_iconCache.emplace(key, std::move(ic)).first->second;
		}

		json RowOf(const Stack& st, const Group& g, const std::string& id, const std::string& pl, bool gameIcons = false)
		{
			const auto k = Classify(st.obj);
			json r{
				{ "id", id }, { "pl", pl }, { "gk", g.gk }, { "n", g.name },
				{ "c", k.cat }, { "s", k.sub }, { "q", g.count },
				{ "v", g.value }, { "w", Round1(g.weight) }, { "eq", g.eq },
			};
			if (g.fav) r["fav"] = 1;
			if (g.stolen) r["st"] = 1;
			if (g.ench) r["en"] = 1;
			if (g.poisoned) r["po"] = 1;
			if (g.quest) r["qi"] = 1;
			if (g.dmg >= 0.0f) r["dmg"] = static_cast<int>(std::lround(g.dmg));
			if (g.ar >= 0.0f) r["ar"] = static_cast<int>(std::lround(g.ar));
			if (auto* a = st.obj->As<RE::TESObjectARMO>())
				r["sl"] = static_cast<std::uint32_t>(a->GetSlotMask());
			if (auto* w = st.obj->As<RE::TESObjectWEAP>())
				r["wt"] = static_cast<int>(w->GetWeaponType());
			if (auto* am = st.obj->As<RE::TESAmmo>())
				r["dmg"] = static_cast<int>(std::lround(am->GetRuntimeData().data.damage));
			if (auto* b = st.obj->As<RE::TESObjectBOOK>()) {
				if (b->IsRead()) r["rd"] = 1;
				if (b->TeachesSpell()) r["tb"] = "spell";
				else if (b->TeachesSkill()) r["tb"] = "skill";
			}
			if (g.soul >= 0 && st.obj->As<RE::TESSoulGem>())
				r["soul"] = g.soul;
			if (st.obj->IsWeapon() || st.obj->IsArmor() || st.obj->GetFormType() == RE::FormType::Ammo) {
				if (auto mat = MaterialOf(st.obj); !mat.empty())
					r["mt"] = std::move(mat);
			}
			if (gameIcons) {
				const auto& ic = GameIconOf(st.obj, g);
				if (!ic.path.empty())
					r["gi"] = ic.path;
				if (ic.color != 0xFFFFFF) {
					char c[8];
					std::snprintf(c, sizeof(c), "#%06X", ic.color & 0xFFFFFF);
					r["gc"] = c;
				}
				if (!ic.display.empty())
					r["gd"] = ic.display;
			}
			return r;
		}

		std::string Ident(RE::TESBoundObject* obj, std::string& pl)
		{
			pl = PluginOf(obj);
			return ActorIdentity::HexOf(ActorIdentity::BestIdOf(obj));
		}

		// ================================================= detail helpers ==

		void ReplaceTag(std::string& text, std::string_view tag, const std::string& value)
		{
			for (std::size_t pos = 0; pos + tag.size() <= text.size();) {
				bool hit = true;
				for (std::size_t i = 0; i < tag.size(); ++i) {
					if (std::tolower(static_cast<unsigned char>(text[pos + i])) !=
						std::tolower(static_cast<unsigned char>(tag[i]))) {
						hit = false;
						break;
					}
				}
				if (hit) {
					text.replace(pos, tag.size(), value);
					pos += value.size();
				} else {
					++pos;
				}
			}
		}

		// Item-card text: <mag>/<dur>/<area> filled in, any other markup
		// (<font …>, <Global=…>) dropped so the panel never shows raw tags.
		std::string CleanCard(std::string t)
		{
			std::string out;
			out.reserve(t.size());
			bool in = false;
			for (char c : t) {
				if (c == '<') { in = true; continue; }
				if (c == '>') { in = false; continue; }
				if (!in) out += c;
			}
			return out;
		}

		json EffectsOf(RE::MagicItem* mi, std::uint16_t knownMask, bool isIngredient)
		{
			json arr = json::array();
			if (!mi)
				return arr;
			int ix = 0;
			for (auto* eff : mi->effects) {
				const int me = ix++;
				auto* base = eff ? eff->baseEffect : nullptr;
				if (!base)
					continue;
				if (base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI))
					continue;
				if (isIngredient && !(knownMask & (1u << me))) {
					// The vanilla menu hides an ingredient effect you have not
					// discovered. So do we — and say there is one.
					arr.push_back(json{ { "n", "Unknown effect" }, { "d", "Eat it or brew with it to learn this effect." }, { "unk", true } });
					continue;
				}
				std::string d = base->magicItemDescription.c_str() ? base->magicItemDescription.c_str() : "";
				ReplaceTag(d, "<mag>", std::to_string(static_cast<long long>(std::llround(eff->effectItem.magnitude))));
				ReplaceTag(d, "<dur>", std::to_string(eff->effectItem.duration));
				ReplaceTag(d, "<area>", std::to_string(eff->effectItem.area));
				const char* nm = base->GetFullName();
				arr.push_back(json{
					{ "n", NoName(nm) ? "" : nm },
					{ "d", CleanCard(d) },
					{ "mag", Round1(eff->effectItem.magnitude) },
					{ "dur", eff->effectItem.duration },
				});
			}
			return arr;
		}

		const char* SkillName(RE::ActorValue av)
		{
			auto* list = RE::ActorValueList::GetSingleton();
			auto* info = list ? list->GetActorValue(av) : nullptr;
			const char* n = info ? info->GetFullName() : nullptr;
			return (n && *n) ? n : "a skill";
		}

		const char* SoulName(int s)
		{
			switch (s) {
			case 0: return "Empty";
			case 1: return "Petty";
			case 2: return "Lesser";
			case 3: return "Common";
			case 4: return "Greater";
			case 5: return "Grand";
			default: return "";
			}
		}

		bool OneHanded(RE::TESObjectWEAP* w)
		{
			return w && !(w->IsTwoHandedAxe() || w->IsTwoHandedSword() || w->IsBow() || w->IsCrossbow() || w->IsStaff());
		}

		// ------------------------------------------------- the item card facts --

		// "SteelPlate" -> "Steel Plate".
		std::string SplitCamel(const std::string& s)
		{
			std::string out;
			for (std::size_t i = 0; i < s.size(); ++i) {
				const unsigned char c = s[i];
				if (i && std::isupper(c) && !std::isupper(static_cast<unsigned char>(s[i - 1])))
					out += ' ';
				out += static_cast<char>(c);
			}
			return out;
		}

		// Material, from the keywords SkyUI reads it from (ArmorMaterialX,
		// WeapMaterialX, DLC1ArmorMaterialX ...): the first one wins.
		std::string MaterialOf(RE::TESBoundObject* obj)
		{
			if (!obj->IsWeapon() && !obj->IsArmor() && obj->GetFormType() != RE::FormType::Ammo)
				return {};
			auto* kf = obj->As<RE::BGSKeywordForm>();
			if (!kf)
				return {};
			for (std::uint32_t i = 0; i < kf->numKeywords; ++i) {
				auto* k = kf->keywords ? kf->keywords[i] : nullptr;
				const char* id = k ? k->GetFormEditorID() : nullptr;
				if (!id)
					continue;
				const std::string e = id;
				const auto at = e.find("Material");
				if (at == std::string::npos || at + 8 >= e.size())
					continue;
				const std::string head = e.substr(0, at);
				if (head.find("Armor") == std::string::npos && head.find("Weap") == std::string::npos)
					continue;
				return SplitCamel(e.substr(at + 8));
			}
			return {};
		}

		std::string SlotsOf(std::uint32_t mask)
		{
			static const char* const kNames[] = { "Head", "Hair", "Body", "Hands", "Forearms", "Amulet", "Ring",
				"Feet", "Calves", "Shield", "Tail", "Long hair", "Circlet", "Ears" };
			std::string out;
			for (std::uint32_t i = 0; i < 32; ++i) {
				if (!(mask & (1u << i)))
					continue;
				if (!out.empty())
					out += ", ";
				out += i < std::size(kNames) ? kNames[i] : ("Slot " + std::to_string(30 + i));
			}
			return out;
		}

		const char* TemperTier(float health)
		{
			if (health < 1.05f) return nullptr;
			if (health < 1.15f) return "Fine";
			if (health < 1.25f) return "Superior";
			if (health < 1.35f) return "Exquisite";
			if (health < 1.45f) return "Flawless";
			if (health < 1.55f) return "Epic";
			return "Legendary";
		}

		std::string Num1(float v)
		{
			char b[32];
			if (std::fabs(v - std::round(v)) < 0.05f)
				std::snprintf(b, sizeof(b), "%.0f", v);
			else
				std::snprintf(b, sizeof(b), "%.1f", v);
			return b;
		}

		// 12840 -> "12,840" (gold and counts read at a glance; Form IDs never pass through here).
		std::string Thousands(long long v)
		{
			std::string d = std::to_string(v < 0 ? -v : v);
			for (int i = static_cast<int>(d.size()) - 3; i > 0; i -= 3)
				d.insert(static_cast<std::size_t>(i), ",");
			return v < 0 ? "-" + d : d;
		}

		json FactsOf(RE::PlayerCharacter* player, RE::TESBoundObject* obj, const Group& g, RE::ExtraDataList* xl)
		{
			json f = json::array();
			auto add = [&](const std::string& l, const std::string& v, const char* tone = nullptr) {
				if (v.empty())
					return;
				json row{ { "l", l }, { "v", v } };
				if (tone)
					row["t"] = tone;
				f.push_back(std::move(row));
			};
			const std::string mat = MaterialOf(obj);
			if (auto* w = obj->As<RE::TESObjectWEAP>()) {
				const int t = static_cast<int>(w->GetWeaponType());
				add("Skill", t >= 1 && t <= 4 ? "One-Handed" : (t == 5 || t == 6) ? "Two-Handed" : (t == 7 || t == 9) ? "Archery" : "");
				add("Material", mat);
				add("Base damage", std::to_string(w->GetAttackDamage()));
				add("Speed", Num1(w->GetSpeed()));
				add("Reach", Num1(w->GetReach()));
				add("Critical", std::to_string(w->GetCritDamage()));
				add("Stagger", Num1(w->weaponData.staggerValue));
			} else if (auto* a = obj->As<RE::TESObjectARMO>()) {
				add("Class", a->IsHeavyArmor() ? "Heavy armor" : a->IsLightArmor() ? "Light armor" : "Clothing");
				add("Material", mat);
				add("Covers", SlotsOf(static_cast<std::uint32_t>(a->GetSlotMask())));
				add("Base armor", Num1(a->GetArmorRating()));
			} else if (auto* am = obj->As<RE::TESAmmo>()) {
				add("Kind", am->IsBolt() ? "Bolt" : "Arrow");
				add("Material", mat);
			} else if (auto* ing = obj->As<RE::IngredientItem>()) {
				int known = 0, total = 0;
				for (std::size_t i = 0; i < ing->effects.size() && i < 16; ++i) {
					++total;
					if (ing->gamedata.knownEffectFlags & (1u << i))
						++known;
				}
				add("Effects known", std::to_string(known) + " of " + std::to_string(total));
			} else if (auto* gem = obj->As<RE::TESSoulGem>()) {
				add("Holds up to", SoulName(static_cast<int>(gem->GetMaximumCapacity())));
				if (g.soul >= 0)
					add("Holding", g.soul == 0 ? "Nothing" : std::string(SoulName(g.soul)) + " soul");
			}
			if (xl) {
				if (auto* h = xl->GetByType<RE::ExtraHealth>(); h) {
					if (const char* tier = TemperTier(h->health))
						add("Tempered", tier, "gold");
				}
				if (auto* p = xl->GetByType<RE::ExtraPoison>(); p && p->poison) {
					const char* pn = p->poison->GetName();
					add("Poisoned with", std::string(NoName(pn) ? "a poison" : pn) + " (" + std::to_string(p->count) +
						(p->count == 1 ? " hit)" : " hits)"), "poison");
				}
			}
			if (auto* w = obj->As<RE::TESObjectWEAP>()) {
				float maxCharge = static_cast<float>(w->amountofEnchantment);
				if (xl)
					if (auto* en = xl->GetByType<RE::ExtraEnchantment>(); en && en->charge)
						maxCharge = static_cast<float>(en->charge);
				float cur = maxCharge;
				if (xl)
					if (auto* c = xl->GetByType<RE::ExtraCharge>(); c)
						cur = c->charge;
				if (g.ench && maxCharge > 0)
					add("Charge", Num1(cur) + " / " + Num1(maxCharge), cur < maxCharge * 0.25f ? "warn" : nullptr);
			}
			// Money and weight: each, and for the line you carry.
			add("Value each", Thousands(g.value));
			if (g.count > 1)
				add("Value carried", Thousands(static_cast<long long>(g.value) * g.count));
			const std::int32_t baseValue = obj->GetGoldValue();
			if (g.value > baseValue && baseValue > 0)
				add("Base value", Thousands(baseValue) + " (+" + Thousands(g.value - baseValue) + " from upgrades)");
			add("Weight each", Num1(g.weight));
			if (g.count > 1 && g.weight > 0)
				add("Weight carried", Num1(g.weight * g.count));
			if (g.weight > 0)
				add("Gold per weight", Num1(static_cast<float>(g.value) / g.weight));
			(void)player;
			std::string pl = PluginOf(obj);
			add("From", pl.empty() ? "Created in this game" : pl);
			char id[16];
			std::snprintf(id, sizeof(id), "%08X", obj->GetFormID());
			add("Form ID", id);
			return f;
		}
	}

	// ================================================================= list ==

	std::string ListJson(const std::string& req)
	{
		const auto t0 = std::chrono::steady_clock::now();
		const auto rq = json::parse(req, nullptr, false);
		const bool wantIcons = rq.is_object() && rq.value("icons", false);
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Dump(json{ { "ok", false }, { "msg", "No player loaded" }, { "items", json::array() } });

		json items = json::array();
		std::size_t rows = 0;
		// The purse comes from this same walk. Never Actor::GetGoldAmount():
		// CommonLib's GetObject(DefaultObjectID::kGold) hands back a garbage
		// slot on 1.5.97 and the deref is a CTD (2026-10-10, the tab's first
		// open: SkyManager.dll+75D0C6, read at 0x16001A).
		std::int64_t gold = 0;
		for (auto& st : ReadStacks(player)) {
			std::string pl;
			const std::string id = Ident(st.obj, pl);
			if (Lower(pl) == "skyrim.esm" && ActorIdentity::LocalIdOf(st.obj) == kGoldLocal) {
				gold += st.total;
				continue;   // the purse is in the header
			}
			if (auto* w = st.obj->As<RE::TESObjectWEAP>(); w && w->IsBound())
				continue;   // bound blades live and die with their spell
			for (auto& g : st.groups) {
				items.push_back(RowOf(st, g, id, pl, wantIcons));
				++rows;
			}
		}

		auto* avo = player->AsActorValueOwner();
		const float cur = avo ? avo->GetActorValue(RE::ActorValue::kInventoryWeight) : 0.0f;
		const float max = avo ? avo->GetActorValue(RE::ActorValue::kCarryWeight) : 0.0f;

		const json side = ReadSidecar();
		json reply{
			{ "ok", true },
			{ "gold", gold },
			{ "carry", { { "cur", Round1(cur) }, { "max", Round1(max) } } },
			// The armor rating the vanilla menu shows (perks and effects in it).
			{ "armor", avo ? static_cast<int>(std::lround(avo->GetActorValue(RE::ActorValue::kDamageResist))) : 0 },
			{ "prefs", side.contains("prefs") && side["prefs"].is_object() ? side["prefs"] : json::object() },
			{ "seen", side.contains("seen") && side["seen"].is_array() ? side["seen"] : json::array() },
			{ "items", std::move(items) },
			// Game icons: whether the rig export has run, and what the rules are.
			{ "gameIcons", GameIcons::Available() },
		};
		if (wantIcons)
			reply["gameIconInfo"] = GameIcons::Summary();
		const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
		reply["ms"] = ms;
		logger::info("inventory-pane: list - {} rows", rows);   // marker: inventory-pane-list
		logger::info("inventory-pane: purse {} gold from the list walk", gold);   // marker: inventory-pane-purse-walk
		logger::info("inventory-pane: read in {} ms (game icons {})", ms, wantIcons ? "on" : "off");
		return Dump(reply);
	}

	// =============================================================== detail ==

	std::string DetailJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Dump(Refuse("No player loaded"));

		json out{ { "id", j.value("id", std::string()) }, { "pl", j.value("pl", std::string()) },
			{ "gk", j.value("gk", std::string()) } };
		Target t;
		std::string why;
		if (!Find(player, j, t, why)) {
			out["ok"] = false;
			out["msg"] = why;
			return Dump(out);
		}
		auto* obj = t.stack.obj;
		auto* g = t.group;
		auto* xl = g->lists.empty() ? nullptr : g->lists.front();

		RE::InventoryEntryData tmp(obj, g->count);
		if (xl)
			tmp.AddExtraList(xl);

		out["ok"] = true;
		out["plugin"] = PluginOf(obj);

		// The card line the vanilla menu prints under the stats.
		RE::BSString buf;
		if (auto* w = obj->As<RE::TESObjectWEAP>()) {
			w->GetDescription(buf, w);
			out["base"] = json{
				{ "dmg", w->GetAttackDamage() }, { "speed", Round1(w->GetSpeed()) },
				{ "reach", Round1(w->GetReach()) }, { "crit", w->GetCritDamage() },
				{ "stagger", Round1(w->weaponData.staggerValue) },
			};
		} else if (auto* a = obj->As<RE::TESObjectARMO>()) {
			a->GetDescription(buf, a);
			out["base"] = json{ { "ar", Round1(a->GetArmorRating()) } };
		} else if (auto* b = obj->As<RE::TESObjectBOOK>()) {
			// The item card (CNAM), not the book's text (DESC). The field tag is
			// spelled byte-reversed, like TESDescription's own 'CSED' default.
			b->itemCardDescription.GetDescription(buf, b, 'MANC');
			if (b->TeachesSpell()) {
				auto* sp = b->GetSpell();
				const char* sn = sp ? sp->GetName() : nullptr;
				const bool known = sp && player->HasSpell(sp);
				out["teaches"] = json{ { "kind", "spell" }, { "name", NoName(sn) ? "a spell" : sn }, { "known", known } };
			} else if (b->TeachesSkill()) {
				out["teaches"] = json{ { "kind", "skill" }, { "name", SkillName(b->GetSkill()) }, { "read", b->IsRead() } };
			}
			out["read"] = b->IsRead();
			// The book's own text, for the page's reader popout. Book markup is
			// HTML-ish (<p>, <br>, <font>, [pagebreak]); paragraphs survive as
			// blank lines, everything else is dropped.
			RE::BSString body;
			b->GetDescription(body, b);
			if (body.length() > 0) {
				std::string tx = body.c_str();
				ReplaceTag(tx, "[pagebreak]", "\n\n");
				ReplaceTag(tx, "<br>", "\n");
				ReplaceTag(tx, "</p>", "\n\n");
				tx = CleanCard(tx);
				if (tx.size() > 60000)
					tx.resize(60000);
				out["text"] = tx;
			}
		}
		if (buf.length() > 0)
			out["desc"] = CleanCard(buf.c_str());

		// Effects: the instance's enchantment for gear, the item's own list
		// for potions, food, poisons, scrolls and ingredients.
		if (auto* ench = tmp.GetEnchantment()) {
			out["effects"] = EffectsOf(ench, 0xFFFF, false);
			if (!NoName(ench->GetName()))
				out["ench"] = ench->GetName();
			if (auto ch = tmp.GetEnchantmentCharge())
				out["charge"] = Round1(static_cast<float>(*ch));
		} else if (auto* ing = obj->As<RE::IngredientItem>()) {
			out["effects"] = EffectsOf(ing, ing->gamedata.knownEffectFlags, true);
		} else if (auto* al = obj->As<RE::AlchemyItem>()) {
			out["effects"] = EffectsOf(al, 0xFFFF, false);
		} else if (auto* sc = obj->As<RE::ScrollItem>()) {
			out["effects"] = EffectsOf(sc, 0xFFFF, false);
		}

		if (g->soul >= 0) {
			json s{ { "have", SoulName(g->soul) } };
			if (auto* gem = obj->As<RE::TESSoulGem>())
				s["cap"] = SoulName(static_cast<int>(gem->GetMaximumCapacity()));
			out["soul"] = s;
		}
		if (g->stolen)
			out["stolen"] = true;
		if (g->quest)
			out["quest"] = true;
		out["facts"] = FactsOf(player, obj, *g, xl);
		if (const auto mat = MaterialOf(obj); !mat.empty())
			out["material"] = mat;
		return Dump(out);
	}

	// ================================================================ mirror ==

	std::string MirrorJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Dump(Refuse("No player loaded"));
		const bool queue = j.is_object() ? j.value("queue", true) : true;
		RE::TESObjectARMO* tryOn = nullptr;
		json tryEcho = nullptr;
		if (j.is_object() && j.contains("try") && j["try"].is_object()) {
			const auto& t = j["try"];
			const std::string id = t.value("id", std::string());
			const std::string pl = t.value("pl", std::string());
			auto* form = ActorIdentity::Resolve(id, pl);
			tryOn = form ? form->As<RE::TESObjectARMO>() : nullptr;
			if (!tryOn)
				return Dump(json{ { "ok", false }, { "why", "Only armour and clothing can be tried on" },
					{ "try", t } });
			tryEcho = t;
		}
		auto reply = json::parse(ItemIcons::MirrorJson(player, queue, tryOn), nullptr, false);
		if (!reply.is_object())
			reply = json{ { "ok", false }, { "why", "The figure renderer did not answer" } };
		reply["try"] = tryEcho;
		reply["player"] = true;
		return Dump(reply);
	}

	// ================================================================ verbs ==

	std::string ActJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!player || !eqm)
			return Dump(Refuse("No player loaded"));

		const std::string op = j.value("op", std::string());
		json echo{ { "op", op }, { "id", j.value("id", std::string()) }, { "pl", j.value("pl", std::string()) },
			{ "gk", j.value("gk", std::string()) } };
		auto reply = [&](bool ok, const std::string& msg) {
			json r = echo;
			r["ok"] = ok;
			r["msg"] = msg;
			logger::info("inventory-pane: {} -> {} ({})", op, ok ? "ok" : "refused", msg);   // marker: inventory-pane-act
			return Dump(r);
		};

		Target t;
		std::string why;
		if (!Find(player, j, t, why))
			return reply(false, why);
		auto* obj = t.stack.obj;
		auto* g = t.group;
		auto* xl = g->lists.empty() ? nullptr : g->lists.front();
		const auto kind = Classify(obj);
		const std::string& cat = kind.cat;
		const std::string& who = g->name;

		if (op == "use" || op == "left") {
			const bool left = op == "left";
			auto* weap = obj->As<RE::TESObjectWEAP>();
			if (left) {
				const bool handable = (weap && OneHanded(weap)) || cat == "scroll" || cat == "light";
				if (!handable)
					return reply(false, who + " can't go in the left hand");
			}
			const bool wearable = cat == "weapon" || cat == "armor" || cat == "clothing" || cat == "jewelry" ||
			                      cat == "shield" || cat == "ammo" || cat == "light";
			const bool oneShot = cat == "potion" || cat == "food" || cat == "poison" || cat == "ingredient" ||
			                     cat == "scroll";
			if (cat == "book" || cat == "tome")
				return reply(false, "Use Read for " + who);
			if (!wearable && !oneShot)
				return reply(false, who + " isn't something you can use from here");

			const RE::BGSEquipSlot* leftSlot = RE::TESForm::LookupByID<RE::BGSEquipSlot>(kLeftHandSlotId);
			// A toggle only for the wearables: clicking the sword in your hand
			// puts it away, which is what the vanilla menu does.
			if (wearable && g->eq != 0) {
				const bool inLeft = g->eq == 2;
				if (!left || inLeft) {
					eqm->UnequipObject(player, obj, xl, 1, inLeft ? leftSlot : nullptr,
						/*queue*/ true, /*force*/ false, /*sounds*/ true, /*applyNow*/ true);
					return reply(true, "Put away " + who);
				}
			}
			const std::uint32_t n = cat == "ammo" ? static_cast<std::uint32_t>(std::max<std::int32_t>(1, g->count)) : 1u;
			eqm->EquipObject(player, obj, xl, n, left ? leftSlot : nullptr,
				/*queue*/ true, /*force*/ false, /*sounds*/ true, /*applyNow*/ true);
			const std::string verb = cat == "potion"                       ? "Drank " :
			                         cat == "food" || cat == "ingredient" ? "Ate " :
			                         cat == "poison"                       ? "Applied " :
			                         cat == "scroll"                       ? "Readied " :
			                                                                 "Equipped ";
			return reply(true, verb + who + (left ? " (left hand)" : ""));
		}

		if (op == "drop") {
			if (g->quest)
				return reply(false, who + " is a quest item - it stays with you");
			std::int32_t want = std::clamp<std::int32_t>(j.value("n", 1), 1, g->count);
			const std::int32_t asked = want;
			// The group's lists in order, each for at most what it holds; the
			// plain remainder (nullptr) is dropped without a list.
			for (std::size_t i = 0; i < g->lists.size() && want > 0; ++i) {
				const std::int32_t take = std::min<std::int32_t>(want, g->counts[i]);
				if (take <= 0)
					continue;
				player->DropObject(obj, g->lists[i], take);
				want -= take;
			}
			const std::int32_t dropped = asked - want;
			return reply(dropped > 0, dropped > 0
				? "Dropped " + who + (dropped > 1 ? " x" + std::to_string(dropped) : "")
				: "Nothing to drop");
		}

		if (op == "fav") {
			auto* changes = player->GetInventoryChanges();
			if (!changes || !t.stack.real)
				return reply(false, "Your inventory isn't readable right now");
			const bool make = !g->fav;
			for (auto* l : g->lists) {
				if (make)
					changes->SetFavorite(t.stack.real, l);
				else if (l)
					changes->RemoveFavorite(t.stack.real, l);
			}
			return reply(true, (make ? "Favorited " : "Unfavorited ") + who);
		}

		if (op == "read") {
			auto* book = obj->As<RE::TESObjectBOOK>();
			if (!book)
				return reply(false, who + " isn't a book");
			const std::string msg = BookReader::ReadOne(book, t.stack.real);
			return reply(!msg.empty() && msg.rfind("Already", 0) != 0, msg.empty() ? "Nothing happened" : msg);
		}

		return reply(false, "Unknown action");
	}

	// ============================================================== sidecar ==

	void SaveJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		json side = ReadSidecar();
		for (auto it = j.begin(); it != j.end(); ++it)
			side[it.key()] = it.value();   // merge: keys an older view does not know survive
		// The seen-set is bounded: it only has to remember a bag, not a life.
		if (side.contains("seen") && side["seen"].is_array() && side["seen"].size() > 8000) {
			auto& s = side["seen"];
			s.erase(s.begin(), s.begin() + static_cast<std::ptrdiff_t>(s.size() - 8000));
		}
		std::error_code ec;
		fs::create_directories(SidecarPath().parent_path(), ec);
		std::ofstream out(SidecarPath(), std::ios::binary | std::ios::trunc);
		if (out)
			out << side.dump(1, ' ', false, json::error_handler_t::replace);
	}
}
