#include "game_icons.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE::, the logger and nlohmann json.hpp.
//
// A port of two upstream pieces, read from source on 2026-10-10:
//  * SkyUI (schlangster/skyui, src/ItemMenus/InventoryDataSetter.as and
//    InventoryIconSetter.as) — sub types, weight classes, default icons;
//  * Inventory Interface Information Injector (Exit-9B/InventoryInjector, MIT,
//    (c) 2023 Parapets) — src/Data/Config/{Rule,Property,PropertyParser,
//    RuleParser}.cpp and src/Data/CustomDataManager.cpp — the rule engine.
// The enum values below are I4's (src/Data/Defines/*.h), which mirror SkyUI's.

namespace GameIcons
{
	using json = nlohmann::json;
	namespace fs = std::filesystem;

	namespace
	{
		constexpr const char* kDefaultSource = "skyui/icons_item_psychosteve.swf";
		constexpr std::uint32_t kItmPotionUse = 0x000B6435;   // Skyrim.esm ITMPotionUse: a "drink" sound

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// UTF-8 text -> path (u8path is deprecated in C++20).
		fs::path U8(const std::string& s)
		{
			return fs::path(std::u8string(s.begin(), s.end()));
		}

		std::string Slug(const std::string& src)
		{
			std::string out;
			bool dash = false;
			for (unsigned char c : src) {
				if (std::isalnum(c)) {
					out += static_cast<char>(std::tolower(c));
					dash = false;
				} else if (!dash && !out.empty()) {
					out += '-';
					dash = true;
				}
			}
			while (!out.empty() && out.back() == '-')
				out.pop_back();
			return out;
		}

		// ---------------------------------------------------------- enums --

		using Table = std::unordered_map<std::string, int>;   // lower-case name -> value

		const Table kFormTypes = {
			{ "ammo", static_cast<int>(RE::FormType::Ammo) },
			{ "armor", static_cast<int>(RE::FormType::Armor) },
			{ "book", static_cast<int>(RE::FormType::Book) },
			{ "enchantment", static_cast<int>(RE::FormType::Enchantment) },
			{ "ingredient", static_cast<int>(RE::FormType::Ingredient) },
			{ "key", static_cast<int>(RE::FormType::KeyMaster) },
			{ "light", static_cast<int>(RE::FormType::Light) },
			{ "miscitem", static_cast<int>(RE::FormType::Misc) },
			{ "potion", static_cast<int>(RE::FormType::AlchemyItem) },
			{ "scroll", static_cast<int>(RE::FormType::Scroll) },
			{ "spell", static_cast<int>(RE::FormType::Spell) },
			{ "soulgem", static_cast<int>(RE::FormType::SoulGem) },
			{ "weapon", static_cast<int>(RE::FormType::Weapon) },
		};
		// EquipType
		enum : int { eHead = 0, eHair, eLongHair, eBody, eForearms, eHands, eShield, eCalves, eFeet, eCirclet, eAmulet, eEars, eRing, eTail };
		const Table kEquip = { { "head", eHead }, { "hair", eHair }, { "longhair", eLongHair }, { "body", eBody },
			{ "forearms", eForearms }, { "hands", eHands }, { "shield", eShield }, { "calves", eCalves }, { "feet", eFeet },
			{ "circlet", eCirclet }, { "amulet", eAmulet }, { "ears", eEars }, { "ring", eRing }, { "tail", eTail } };
		// BookType
		enum : int { bSpellTome = 0, bNote, bRecipe };
		const Table kBook = { { "spelltome", bSpellTome }, { "note", bNote }, { "recipe", bRecipe } };
		// MiscType
		enum : int { mGem = 0, mDragonClaw, mArtifact, mLeather, mLeatherStrips, mHide, mRemains, mIngot, mTool,
			mChildrensClothes, mToy, mFirewood, mFastener, mWeaponRack, mShelf, mFurniture, mExterior, mContainer,
			mHousePart, mClutter, mLockpick, mGold };
		const Table kMisc = { { "gem", mGem }, { "dragonclaw", mDragonClaw }, { "artifact", mArtifact },
			{ "leather", mLeather }, { "leatherstrips", mLeatherStrips }, { "hide", mHide }, { "remains", mRemains },
			{ "ingot", mIngot }, { "tool", mTool }, { "childrensclothes", mChildrensClothes }, { "toy", mToy },
			{ "firewood", mFirewood }, { "fastener", mFastener }, { "weaponrack", mWeaponRack }, { "shelf", mShelf },
			{ "furniture", mFurniture }, { "exterior", mExterior }, { "container", mContainer },
			{ "housepart", mHousePart }, { "clutter", mClutter }, { "lockpick", mLockpick }, { "gold", mGold } };
		// WeaponType
		enum : int { wMelee = 0, wSword, wDagger, wWarAxe, wMace, wGreatsword, wBattleaxe, wWarhammer, wBow, wCrossbow,
			wStaff, wPickaxe, wWoodAxe };
		const Table kWeapon = { { "melee", wMelee }, { "sword", wSword }, { "dagger", wDagger }, { "waraxe", wWarAxe },
			{ "mace", wMace }, { "greatsword", wGreatsword }, { "battleaxe", wBattleaxe }, { "warhammer", wWarhammer },
			{ "bow", wBow }, { "crossbow", wCrossbow }, { "staff", wStaff }, { "pickaxe", wPickaxe }, { "woodaxe", wWoodAxe } };
		const Table kAmmo = { { "arrow", 0 }, { "bolt", 1 } };
		// PotionType
		enum : int { pHealth = 0, pHealRate, pHealRateMult, pMagicka, pMagickaRate, pMagickaRateMult, pStamina,
			pStaminaRate, pStaminaRateMult, pFireResist, pElectricResist, pFrostResist, pPotion, pDrink, pFood, pPoison };
		const Table kPotion = { { "health", pHealth }, { "healrate", pHealRate }, { "healratemult", pHealRateMult },
			{ "magicka", pMagicka }, { "magickarate", pMagickaRate }, { "magickaratemult", pMagickaRateMult },
			{ "stamina", pStamina }, { "staminarate", pStaminaRate }, { "staminaratemult", pStaminaRateMult },
			{ "fireresist", pFireResist }, { "electricresist", pElectricResist }, { "frostresist", pFrostResist },
			{ "potion", pPotion }, { "drink", pDrink }, { "food", pFood }, { "poison", pPoison } };
		const Table kSoulGem = { { "none", 0 }, { "petty", 1 }, { "lesser", 2 }, { "common", 3 }, { "greater", 4 },
			{ "grand", 5 }, { "azura", 6 } };
		const Table kStatus = { { "empty", 0 }, { "partial", 1 }, { "full", 2 } };
		const Table kWeight = { { "light", 0 }, { "heavy", 1 }, { "clothing", 3 }, { "jewelry", 4 } };
		const Table kAnim = { { "handtohandmelee", 0 }, { "onehandsword", 1 }, { "onehanddagger", 2 },
			{ "onehandaxe", 3 }, { "onehandmace", 4 }, { "twohandsword", 5 }, { "twohandaxe", 6 }, { "bow", 7 },
			{ "staff", 8 }, { "crossbow", 9 } };
		const Table kBookType = { { "book", 0 }, { "note", 255 } };
		const Table kBookFlags = { { "teachesspell", 1 << 2 }, { "teachesskill", 1 << 0 }, { "read", 1 << 3 } };
		const Table kPotionFlags = { { "manualcalc", 1 << 0 }, { "food", 1 << 1 }, { "medicine", 1 << 16 }, { "poison", 1 << 17 } };
		// EffectArchetypes, in the engine's (and I4 schema's) order.
		const char* const kArchetypes[] = { "ValueModifier", "Script", "Dispel", "CureDisease", "Absorb",
			"DualValueModifier", "Calm", "Demoralize", "Frenzy", "Disarm", "CommandSummoned", "Invisibility", "Light",
			"Darkness", "NightEye", "Lock", "Open", "BoundWeapon", "SummonCreature", "DetectLife", "Telekinesis",
			"Paralysis", "Reanimate", "SoulTrap", "TurnUndead", "Guide", "WerewolfFeed", "CureParalysis",
			"CureAddiction", "CurePoison", "Concussion", "ValueAndParts", "AccumulateMagnitude", "Stagger",
			"PeakValueModifier", "Cloak", "Werewolf", "SlowTime", "Rally", "EnhanceWeapon", "SpawnHazard",
			"Etherealize", "Banish", "SpawnScriptedRef", "Disguise", "GrabActor", "VampireLord" };

		int Lookup(const Table& t, const std::string& name)
		{
			auto it = t.find(Lower(name));
			return it == t.end() ? -1 : it->second;
		}

		int ActorValueByName(const std::string& name)
		{
			if (auto* list = RE::ActorValueList::GetSingleton()) {
				const auto av = list->LookupActorValueByName(name);
				return static_cast<int>(av);
			}
			return -1;
		}

		int ArchetypeByName(const std::string& name)
		{
			const auto low = Lower(name);
			for (int i = 0; i < static_cast<int>(std::size(kArchetypes)); ++i)
				if (Lower(kArchetypes[i]) == low)
					return i;
			return -1;
		}

		// -------------------------------------------------------- the entry --
		// The fields an I4 rule can look at, for one item instance. Missing
		// (nullopt) is "undefined" in the SkyUI entry object.

		struct Entry
		{
			int                             formType = -1;
			std::uint32_t                   formId = 0;
			std::unordered_set<std::string> keywords;
			std::unordered_set<std::string> effectKeywords;
			std::unordered_map<std::string, double> num;   // name -> value
			std::unordered_map<std::string, bool>   flag;  // name -> value
		};

		// ---------------------------------------------------------- rules --

		struct Prop
		{
			enum class K { Match, Range, Bits, Keyword, MainPart, AnyOf } k = K::Match;
			enum class V { Null, Num, Bool, Str } v = V::Null;
			double                num = 0;
			bool                  b = false;
			std::string           str;
			std::optional<double> mn, mx;
			std::uint32_t         bits = 0;
			std::vector<Prop>     any;
		};

		struct Rule
		{
			int                                    formType = -1;   // for the index; -1 = any
			std::unordered_map<std::string, Prop>  props;           // one per name, LAST wins (I4's map)
			bool                                   hasInfo = false;
			std::optional<int>                     subType;
			std::string                            display;
			bool                                   setSource = false;
			std::string                            source;   // "" = SkyUI's default file
			std::optional<std::string>             label;
			std::optional<std::uint32_t>           color;
		};

		std::vector<Rule>  g_rules;
		bool               g_loaded = false;
		std::size_t        g_files = 0;
		std::unordered_map<std::string, bool> g_sourceOk;
		std::unordered_map<std::string, bool> g_pathOk;
		int                g_available = -1;

		// AV numbers resolved by NAME once (the enum spelling differs between
		// CommonLib versions; the engine's own name table does not).
		struct Avs
		{
			int health = -2, magicka = -2, stamina = -2, healRate = -2, magickaRate = -2, staminaRate = -2,
			    healRateMult = -2, magickaRateMult = -2, staminaRateMult = -2, fire = -2, shock = -2, frost = -2;
		} g_av;

		void ResolveAvs()
		{
			if (g_av.health != -2)
				return;
			g_av.health = ActorValueByName("Health");
			g_av.magicka = ActorValueByName("Magicka");
			g_av.stamina = ActorValueByName("Stamina");
			g_av.healRate = ActorValueByName("HealRate");
			g_av.magickaRate = ActorValueByName("MagickaRate");
			g_av.staminaRate = ActorValueByName("StaminaRate");
			g_av.healRateMult = ActorValueByName("HealRateMult");
			g_av.magickaRateMult = ActorValueByName("MagickaRateMult");
			g_av.staminaRateMult = ActorValueByName("StaminaRateMult");
			g_av.fire = ActorValueByName("FireResist");
			g_av.shock = ActorValueByName("ElectricResist");
			g_av.frost = ActorValueByName("FrostResist");
		}

		std::uint32_t ParseFormId(const std::string& spec)
		{
			const auto bar = spec.find('|');
			if (bar == std::string::npos)
				return 0;
			const std::string plugin = spec.substr(0, bar);
			std::uint32_t     raw = 0;
			try {
				raw = static_cast<std::uint32_t>(std::stoul(spec.substr(bar + 1), nullptr, 16));
			} catch (...) {
				return 0;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* file = dh ? dh->LookupModByName(plugin) : nullptr;
			if (!file || file->compileIndex == 0xFF)
				return 0;
			std::uint32_t id = static_cast<std::uint32_t>(file->compileIndex) << 24;
			if (file->compileIndex == 0xFE && file->IsLight())
				id += static_cast<std::uint32_t>(file->smallFileCompileIndex) << 12;
			return id + raw;
		}

		std::uint32_t ParseColor(const json& v)
		{
			if (v.is_number())
				return static_cast<std::uint32_t>(v.get<double>());
			if (!v.is_string())
				return 0xFFFFFF;
			std::string s = v.get<std::string>();
			if (!s.empty() && s[0] == '#')
				s = s.substr(1);
			try {
				return static_cast<std::uint32_t>(std::stoll(s, nullptr, 16));
			} catch (...) {
				return 0xFFFFFF;
			}
		}

		// The value parser I4 picks for a match key. Strings go through it;
		// numbers, bools and nulls are literal matches; arrays recurse (each
		// element REPLACES the last — I4's map); {anyOf} gathers; {min,max} ranges.
		enum class Parser { Generic, FormType, FormId, Keywords, Parts, MainPart, Enum, Bits, Color, ActorValue, Archetype };

		struct Ctx
		{
			Parser       parser = Parser::Generic;
			const Table* table = nullptr;
		};

		Prop StringProp(const Ctx& c, const std::string& s, std::string& name)
		{
			Prop p;
			switch (c.parser) {
			case Parser::FormType:
				p.v = Prop::V::Num;
				p.num = Lookup(kFormTypes, s);
				break;
			case Parser::FormId:
				p.v = Prop::V::Num;
				p.num = ParseFormId(s);
				break;
			case Parser::Keywords:
				p.k = Prop::K::Keyword;
				p.str = s;
				break;
			case Parser::Enum:
				p.v = Prop::V::Num;
				p.num = c.table ? Lookup(*c.table, s) : -1;
				break;
			case Parser::Bits:
				p.k = Prop::K::Bits;
				p.bits = static_cast<std::uint32_t>(std::max<int>(0, c.table ? Lookup(*c.table, s) : 0));
				break;
			case Parser::Color:
				p.v = Prop::V::Num;
				p.num = ParseColor(json(s));
				break;
			case Parser::ActorValue:
				p.v = Prop::V::Num;
				p.num = ActorValueByName(s);
				break;
			case Parser::Archetype:
				p.v = Prop::V::Num;
				p.num = ArchetypeByName(s);
				break;
			default:
				p.v = Prop::V::Str;
				p.str = s;
				break;
			}
			(void)name;
			return p;
		}

		Prop NumberProp(const Ctx& c, double n, std::string& name)
		{
			Prop p;
			if (c.parser == Parser::Parts) {
				name = "partMask";
				p.k = Prop::K::Bits;
				p.bits = 1u << (static_cast<std::uint32_t>(n) - 30);
			} else if (c.parser == Parser::MainPart) {
				name = "partMask";
				p.k = Prop::K::MainPart;
				p.bits = 1u << (static_cast<std::uint32_t>(n) - 30);
			} else {
				p.v = Prop::V::Num;
				p.num = n;
			}
			return p;
		}

		// Parse one spec into `out` under `name` (I4: PropertyParser::Parse).
		void ParseSpec(const Ctx& c, const json& spec, const std::string& baseName,
			std::unordered_map<std::string, Prop>& out)
		{
			std::string name = baseName;
			if (spec.is_string()) {
				out[name] = StringProp(c, spec.get<std::string>(), name);
			} else if (spec.is_number()) {
				Prop p = NumberProp(c, spec.get<double>(), name);
				out[name] = std::move(p);
			} else if (spec.is_boolean()) {
				Prop p;
				p.v = Prop::V::Bool;
				p.b = spec.get<bool>();
				out[name] = std::move(p);
			} else if (spec.is_array()) {
				for (const auto& sub : spec)
					ParseSpec(c, sub, baseName, out);
			} else if (spec.is_object()) {
				if (spec.contains("anyOf") && spec["anyOf"].is_array()) {
					std::unordered_map<std::string, Prop> tmp;
					Prop any;
					any.k = Prop::K::AnyOf;
					std::string anyName = baseName;
					for (const auto& sub : spec["anyOf"]) {
						tmp.clear();
						ParseSpec(c, sub, baseName, tmp);
						for (auto& [n, p] : tmp) {
							anyName = n;
							any.any.push_back(std::move(p));
						}
					}
					out[anyName] = std::move(any);
				}
				std::optional<double> mn, mx;
				if (spec.contains("min") && spec["min"].is_number())
					mn = spec["min"].get<double>();
				if (spec.contains("max") && spec["max"].is_number())
					mx = spec["max"].get<double>();
				if (mn || mx) {
					Prop p;
					p.k = Prop::K::Range;
					p.mn = mn;
					p.mx = mx;
					out[name] = std::move(p);
				}
			} else if (spec.is_null()) {
				out[name] = Prop{};
			}
		}

		Ctx ContextFor(const std::string& name, int formType)
		{
			Ctx c;
			if (name == "formType") c.parser = Parser::FormType;
			else if (name == "formId" || name == "equipSlot" || name == "teachesSpell") c.parser = Parser::FormId;
			else if (name == "keywords" || name == "effectKeywords") c.parser = Parser::Keywords;
			else if (name == "parts") c.parser = Parser::Parts;
			else if (name == "mainPart") c.parser = Parser::MainPart;
			else if (name == "weightClass") { c.parser = Parser::Enum; c.table = &kWeight; }
			else if (name == "weaponType") { c.parser = Parser::Enum; c.table = &kAnim; }
			else if (name == "gemSize" || name == "soulSize") { c.parser = Parser::Enum; c.table = &kSoulGem; }
			else if (name == "status") { c.parser = Parser::Enum; c.table = &kStatus; }
			else if (name == "bookType") { c.parser = Parser::Enum; c.table = &kBookType; }
			else if (name == "actorValue" || name == "resistance" || name == "teachesSkill" || name == "school") c.parser = Parser::ActorValue;
			else if (name == "archetype") c.parser = Parser::Archetype;
			else if (name == "iconColor") c.parser = Parser::Color;
			else if (name == "flags") {
				if (formType == static_cast<int>(RE::FormType::Book)) { c.parser = Parser::Bits; c.table = &kBookFlags; }
				else if (formType == static_cast<int>(RE::FormType::AlchemyItem)) { c.parser = Parser::Bits; c.table = &kPotionFlags; }
			} else if (name == "subType") {
				c.parser = Parser::Enum;
				if (formType == static_cast<int>(RE::FormType::Armor)) c.table = &kEquip;
				else if (formType == static_cast<int>(RE::FormType::Book)) c.table = &kBook;
				else if (formType == static_cast<int>(RE::FormType::Misc)) c.table = &kMisc;
				else if (formType == static_cast<int>(RE::FormType::Weapon)) c.table = &kWeapon;
				else if (formType == static_cast<int>(RE::FormType::Ammo)) c.table = &kAmmo;
				else if (formType == static_cast<int>(RE::FormType::AlchemyItem)) c.table = &kPotion;
				else if (formType == static_cast<int>(RE::FormType::SoulGem)) c.table = &kSoulGem;
				else c.parser = Parser::Generic;
			}
			return c;
		}

		const Table* SubTypeTable(int formType)
		{
			if (formType == static_cast<int>(RE::FormType::Armor)) return &kEquip;
			if (formType == static_cast<int>(RE::FormType::Book)) return &kBook;
			if (formType == static_cast<int>(RE::FormType::Misc)) return &kMisc;
			if (formType == static_cast<int>(RE::FormType::Weapon)) return &kWeapon;
			if (formType == static_cast<int>(RE::FormType::Ammo)) return &kAmmo;
			if (formType == static_cast<int>(RE::FormType::AlchemyItem)) return &kPotion;
			if (formType == static_cast<int>(RE::FormType::SoulGem)) return &kSoulGem;
			return nullptr;
		}

		bool SourceOk(const std::string& src)
		{
			const auto key = Lower(src);
			if (auto it = g_sourceOk.find(key); it != g_sourceOk.end())
				return it->second;
			std::error_code ec;
			const bool ok = fs::exists(fs::path("Data") / "Interface" / U8(src), ec);
			g_sourceOk[key] = ok;
			return ok;
		}

		void LoadRule(const json& r)
		{
			if (!r.is_object() || !r.contains("match") || !r.contains("assign"))
				return;
			const auto& match = r["match"];
			const auto& assign = r["assign"];
			if (!match.is_object() || !assign.is_object())
				return;
			Rule rule;
			if (match.contains("formType") && match["formType"].is_string())
				rule.formType = Lookup(kFormTypes, match["formType"].get<std::string>());
			for (auto it = match.begin(); it != match.end(); ++it) {
				if (it.key().empty() || it.key()[0] == '$')
					continue;
				ParseSpec(ContextFor(it.key(), rule.formType), it.value(), it.key(), rule.props);
			}
			bool any = false;
			for (auto it = assign.begin(); it != assign.end(); ++it) {
				const auto& k = it.key();
				if (k.empty() || k[0] == '$')
					continue;
				any = true;
				if (k == "iconSource") {
					rule.setSource = true;
					rule.source = it.value().is_string() ? it.value().get<std::string>() : std::string();
				} else if (k == "iconLabel") {
					if (it.value().is_string())
						rule.label = it.value().get<std::string>();
				} else if (k == "iconColor") {
					rule.color = ParseColor(it.value());
				} else {
					rule.hasInfo = true;
					if (k == "subType") {
						if (it.value().is_string()) {
							const auto* t = SubTypeTable(rule.formType);
							const int v = t ? Lookup(*t, it.value().get<std::string>()) : -1;
							if (v >= 0)
								rule.subType = v;
						} else if (it.value().is_number()) {
							rule.subType = static_cast<int>(it.value().get<double>());
						}
					} else if (k == "subTypeDisplay" && it.value().is_string()) {
						rule.display = it.value().get<std::string>();
					}
				}
			}
			// I4 Rule::Validate.
			if (rule.setSource) {
				if (rule.source.empty() || !SourceOk(rule.source)) {
					rule.setSource = false;
					rule.source.clear();
					rule.label.reset();
				}
			} else if (rule.label) {
				rule.setSource = true;   // null source: SkyUI's own file
				rule.source.clear();
			}
			if (rule.props.empty() || !any)
				return;
			if (!rule.hasInfo && !rule.setSource && !rule.label && !rule.color)
				return;
			g_rules.push_back(std::move(rule));
		}


		// I4 reads its files with JsonCpp, which forgives what strict JSON does
		// not: trailing commas, comments, raw tabs/newlines inside strings. A
		// third of the rig's rule packs lean on that (MARA I4, Ruin Coins,
		// Vulcano, Arclight ... 2026-10-10), so the text is made strict first.
		std::string Lenient(const std::string& in)
		{
			std::string out;
			out.reserve(in.size());
			bool str = false, esc = false;
			for (std::size_t i = 0; i < in.size(); ++i) {
				const char c = in[i];
				if (str) {
					if (esc) { esc = false; out += c; continue; }
					if (c == '\\') { esc = true; out += c; continue; }
					if (c == '"') { str = false; out += c; continue; }
					out += (static_cast<unsigned char>(c) < 0x20) ? ' ' : c;
					continue;
				}
				if (c == '"') { str = true; out += c; continue; }
				if (c == '/' && i + 1 < in.size() && in[i + 1] == '/') {
					while (i < in.size() && in[i] != '\n')
						++i;
					out += '\n';
					continue;
				}
				if (c == '/' && i + 1 < in.size() && in[i + 1] == '*') {
					i += 2;
					while (i + 1 < in.size() && !(in[i] == '*' && in[i + 1] == '/'))
						++i;
					++i;
					continue;
				}
				if (c == ',') {
					std::size_t k = i + 1;
					while (k < in.size()) {
						if (std::isspace(static_cast<unsigned char>(in[k]))) {
							++k;
						} else if (in[k] == '/' && k + 1 < in.size() && in[k + 1] == '/') {
							while (k < in.size() && in[k] != '\n')
								++k;
						} else if (in[k] == '/' && k + 1 < in.size() && in[k + 1] == '*') {
							k += 2;
							while (k + 1 < in.size() && !(in[k] == '*' && in[k + 1] == '/'))
								++k;
							k += 2;
						} else {
							break;
						}
					}
					if (k < in.size() && (in[k] == '}' || in[k] == ']'))
						continue;   // trailing comma
				}
				out += c;
			}
			return out;
		}

		void LoadRules()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			ResolveAvs();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			for (auto* file : dh->files) {
				if (!file || !file->recordFlags.all(RE::TESFile::RecordFlag::kChecked))
					continue;
				fs::path name = U8(std::string(file->GetFilename()));
				name.replace_extension(".json");
				const fs::path p = fs::path("Data") / "SKSE" / "Plugins" / "InventoryInjector" / name;
				std::ifstream in(p, std::ios::binary);
				if (!in)
					continue;
				std::stringstream ss;
				ss << in.rdbuf();
				auto j = json::parse(Lenient(ss.str()), nullptr, false);
				if (j.is_discarded() || !j.is_object() || !j.contains("rules") || !j["rules"].is_array()) {
					logger::warn("game-icons: could not read {}", PathU8(name));
					continue;
				}
				const auto before = g_rules.size();
				for (const auto& r : j["rules"])
					LoadRule(r);
				++g_files;
				logger::info("game-icons: {} rule(s) from {}", g_rules.size() - before, PathU8(name));
			}
			logger::info("game-icons: {} I4 rule(s) from {} file(s)", g_rules.size(), g_files);   // marker: game-icons-rules
		}

		// ---------------------------------------------------------- match --

		bool MatchOne(const Prop& p, const std::string& name, const Entry& e)
		{
			if (p.k == Prop::K::AnyOf) {
				for (const auto& s : p.any)
					if (MatchOne(s, name, e))
						return true;
				return false;
			}
			if (p.k == Prop::K::Keyword) {
				const auto& set = name == "effectKeywords" ? e.effectKeywords : e.keywords;
				return set.count(p.str) != 0;
			}
			if (name == "formType")
				return p.v == Prop::V::Num && static_cast<int>(p.num) == e.formType;
			if (name == "formId") {
				if (p.v != Prop::V::Num)
					return false;
				return static_cast<std::uint32_t>(p.num) == e.formId;
			}
			if (auto it = e.flag.find(name); it != e.flag.end())
				return p.k == Prop::K::Match && p.v == Prop::V::Bool && p.b == it->second;
			auto it = e.num.find(name);
			if (it == e.num.end())
				return p.k == Prop::K::Match && p.v == Prop::V::Null;   // undefined matches only null
			const double v = it->second;
			switch (p.k) {
			case Prop::K::Range:
				return (!p.mn || v >= *p.mn) && (!p.mx || v <= *p.mx);
			case Prop::K::Bits:
				return (static_cast<std::uint32_t>(v) & p.bits) != 0;
			case Prop::K::MainPart:
				{
					const auto mask = static_cast<std::uint32_t>(v);
					if ((mask & p.bits) == 0)
						return false;
					static const std::uint32_t kOrder[] = { 1u << 2, 1u << 1, 1u << 3, 1u << 4, 1u << 7, 1u << 8, 1u << 9,
						1u << 5, 1u << 6, 1u << 11, 1u << 13, 1u << 0, 1u << 12, 1u << 10 };
					std::uint32_t main = 0;
					for (auto s : kOrder)
						if (mask & s) { main = s; break; }
					if (!main)
						for (std::uint32_t i = 14; i < 32; ++i)
							if (mask & (1u << i)) { main = 1u << i; break; }
					return main && main == p.bits;
				}
			default:
				if (p.v == Prop::V::Num)
					return v == p.num;
				if (p.v == Prop::V::Bool)
					return (v != 0) == p.b;
				return false;
			}
		}

		bool Matches(const Rule& r, const Entry& e)
		{
			for (const auto& [name, p] : r.props)
				if (!MatchOne(p, name, e))
					return false;
			return true;
		}

		// -------------------------------------------- SkyUI's data setter --

		void Keywords(RE::BGSKeywordForm* kf, std::unordered_set<std::string>& out)
		{
			if (!kf)
				return;
			for (std::uint32_t i = 0; i < kf->numKeywords; ++i) {
				auto* k = kf->keywords ? kf->keywords[i] : nullptr;
				const char* id = k ? k->GetFormEditorID() : nullptr;
				if (id && *id)
					out.insert(id);
			}
		}

		bool Has(const Entry& e, const char* kw) { return e.keywords.count(kw) != 0; }

		std::uint32_t MainPart(std::uint32_t mask)
		{
			static const std::uint32_t kOrder[] = { 1u << 2, 1u << 1, 1u << 3, 1u << 4, 1u << 7, 1u << 8, 1u << 9,
				1u << 5, 1u << 6, 1u << 11, 1u << 13, 1u << 0, 1u << 12, 1u << 10 };
			for (auto s : kOrder)
				if (mask & s)
					return s;
			return 0;
		}

		int EquipOf(std::uint32_t main)
		{
			switch (main) {
			case 1u << 0: return eHead;
			case 1u << 1: return eHair;
			case 1u << 11: return eLongHair;
			case 1u << 2: return eBody;
			case 1u << 3: return eHands;
			case 1u << 4: return eForearms;
			case 1u << 5: return eAmulet;
			case 1u << 6: return eRing;
			case 1u << 7: return eFeet;
			case 1u << 8: return eCalves;
			case 1u << 9: return eShield;
			case 1u << 12: return eCirclet;
			case 1u << 13: return eEars;
			case 1u << 10: return eTail;
			default: return -1;
			}
		}

		Entry BuildEntry(RE::TESBoundObject* obj, const Instance& inst)
		{
			Entry e;
			e.formType = static_cast<int>(obj->GetFormType());
			e.formId = obj->GetFormID();
			e.num["value"] = inst.value;
			e.num["weight"] = inst.weight;
			e.flag["isEquipped"] = inst.equipped;
			e.flag["isStolen"] = inst.stolen;
			e.flag["isEnchanted"] = inst.enchanted;
			e.flag["isPoisoned"] = inst.poisoned;
			if (inst.damage >= 0)
				e.num["damage"] = inst.damage;
			if (inst.armor >= 0)
				e.num["armor"] = inst.armor;

			// Every item form type that has keywords carries a BGSKeywordForm;
			// As<> finds it without naming each class's inheritance (TESAmmo's
			// is not visible as a plain upcast in this CommonLib).
			Keywords(obj->As<RE::BGSKeywordForm>(), e.keywords);

			auto setSub = [&](int v) {
				if (v >= 0)
					e.num["subType"] = v;
			};

			if (auto* w = obj->As<RE::TESObjectWEAP>()) {
				const int anim = static_cast<int>(w->GetWeaponType());
				e.num["weaponType"] = anim;
				e.num["baseDamage"] = w->GetAttackDamage();
				switch (anim) {
				case 0: setSub(wMelee); break;
				case 1: setSub(wSword); break;
				case 2: setSub(wDagger); break;
				case 3: setSub(wWarAxe); break;
				case 4: setSub(wMace); break;
				case 5: setSub(wGreatsword); break;
				case 6: setSub(Has(e, "WeapTypeWarhammer") ? wWarhammer : wBattleaxe); break;
				case 7: setSub(wBow); break;
				case 8: setSub(wStaff); break;
				case 9: setSub(wCrossbow); break;
				default: break;
				}
			} else if (auto* a = obj->As<RE::TESObjectARMO>()) {
				const auto mask = static_cast<std::uint32_t>(a->GetSlotMask());
				e.num["partMask"] = mask;
				const auto main = MainPart(mask);
				if (main)
					setSub(EquipOf(main));
				int wc = -1;
				if (a->IsLightArmor())
					wc = 0;
				else if (a->IsHeavyArmor())
					wc = 1;
				else if (Has(e, "VendorItemClothing"))
					wc = 3;
				else if (Has(e, "VendorItemJewelry"))
					wc = 4;
				if (wc < 0) {
					switch (EquipOf(main)) {
					case eHead: case eHair: case eLongHair: case eBody: case eHands: case eForearms:
					case eFeet: case eCalves: case eShield: case eTail: wc = 3; break;
					case eAmulet: case eRing: case eCirclet: case eEars: wc = 4; break;
					default: break;
					}
				}
				if (wc >= 0)
					e.num["weightClass"] = wc;
			} else if (auto* am = obj->As<RE::TESAmmo>()) {
				setSub(am->IsBolt() ? 1 : 0);
			} else if (auto* b = obj->As<RE::TESObjectBOOK>()) {
				e.num["flags"] = static_cast<double>(b->data.flags.underlying());
				e.num["bookType"] = static_cast<double>(b->data.type.underlying());
				if (b->data.type.underlying() == 255)
					setSub(bNote);
				if (Has(e, "VendorItemRecipe"))
					setSub(bRecipe);
				else if (Has(e, "VendorItemSpellTome"))
					setSub(bSpellTome);
			} else if (auto* sg = obj->As<RE::TESSoulGem>()) {
				const int gem = static_cast<int>(sg->GetMaximumCapacity());
				const int soul = inst.soul >= 0 ? inst.soul : static_cast<int>(sg->GetContainedSoul());
				e.num["gemSize"] = gem;
				e.num["soulSize"] = soul;
				if (gem != 0)
					setSub(gem);
				e.num["status"] = soul == 0 ? 0 : (soul >= gem ? 2 : 1);
			} else if (auto* mi = obj->As<RE::TESObjectMISC>()) {
				if (Has(e, "BYOHAdoptionClothesKeyword")) setSub(mChildrensClothes);
				else if (Has(e, "BYOHAdoptionToyKeyword")) setSub(mToy);
				else if (Has(e, "BYOHHouseCraftingCategoryWeaponRacks") || Has(e, "BYOHHouseCraftingCategoryShelf") ||
				         Has(e, "BYOHHouseCraftingCategoryFurniture") || Has(e, "BYOHHouseCraftingCategoryExterior") ||
				         Has(e, "BYOHHouseCraftingCategoryContainers") || Has(e, "BYOHHouseCraftingCategoryBuilding") ||
				         Has(e, "BYOHHouseCraftingCategorySmithing")) setSub(mHousePart);
				else if (Has(e, "VendorItemDaedricArtifact")) setSub(mArtifact);
				else if (Has(e, "VendorItemGem")) setSub(mGem);
				else if (Has(e, "VendorItemAnimalHide")) setSub(mHide);
				else if (Has(e, "VendorItemTool")) setSub(mTool);
				else if (Has(e, "VendorItemAnimalPart")) setSub(mRemains);
				else if (Has(e, "VendorItemOreIngot")) setSub(mIngot);
				else if (Has(e, "VendorItemClutter")) setSub(mClutter);
				else if (Has(e, "VendorItemFirewood")) setSub(mFirewood);
				// SkyUI's base-id specials (Skyrim.esm): lockpick, gold, leather, strips.
				if (auto* f = mi->GetFile(0); f && Lower(std::string(f->GetFilename())) == "skyrim.esm") {
					switch (mi->GetFormID() & 0xFFFFFF) {
					case 0x00000A: setSub(mLockpick); break;
					case 0x00000F: setSub(mGold); break;
					case 0x0DB5D2: setSub(mLeather); break;
					case 0x0800E4: setSub(mLeatherStrips); break;
					default: break;
					}
				}
			} else if (auto* al = obj->As<RE::AlchemyItem>()) {
				e.num["flags"] = static_cast<double>(al->data.flags.underlying());
				int sub = pPotion;
				auto* eff = al->GetCostliestEffectItem();
				auto* base = eff ? eff->baseEffect : nullptr;
				if (base) {
					Keywords(base->As<RE::BGSKeywordForm>(), e.effectKeywords);
					e.num["actorValue"] = static_cast<int>(base->data.primaryAV);
					e.num["resistance"] = static_cast<int>(base->data.resistVariable);
					e.num["archetype"] = static_cast<int>(base->data.archetype);
				}
				if (al->IsFood()) {
					sub = pFood;
					if (al->data.consumptionSound && al->data.consumptionSound->GetFormID() == kItmPotionUse)
						sub = pDrink;
				} else if (al->IsPoison()) {
					sub = pPoison;
				} else if (base) {
					const int av = static_cast<int>(base->data.primaryAV);
					if (av == g_av.health) sub = pHealth;
					else if (av == g_av.magicka) sub = pMagicka;
					else if (av == g_av.stamina) sub = pStamina;
					else if (av == g_av.healRate) sub = pHealRate;
					else if (av == g_av.magickaRate) sub = pMagickaRate;
					else if (av == g_av.staminaRate) sub = pStaminaRate;
					else if (av == g_av.healRateMult) sub = pHealRateMult;
					else if (av == g_av.magickaRateMult) sub = pMagickaRateMult;
					else if (av == g_av.staminaRateMult) sub = pStaminaRateMult;
					else if (av == g_av.fire) sub = pFireResist;
					else if (av == g_av.shock) sub = pElectricResist;
					else if (av == g_av.frost) sub = pFrostResist;
				}
				setSub(sub);
			} else if (auto* sc = obj->As<RE::ScrollItem>()) {
				if (auto* eff = sc->GetCostliestEffectItem(); eff && eff->baseEffect) {
					Keywords(eff->baseEffect->As<RE::BGSKeywordForm>(), e.effectKeywords);
					e.num["actorValue"] = static_cast<int>(eff->baseEffect->data.primaryAV);
					e.num["resistance"] = static_cast<int>(eff->baseEffect->data.resistVariable);
					e.num["archetype"] = static_cast<int>(eff->baseEffect->data.archetype);
				}
			} else if (auto* ing = obj->As<RE::IngredientItem>()) {
				if (auto* eff = ing->GetCostliestEffectItem(); eff && eff->baseEffect) {
					Keywords(eff->baseEffect->As<RE::BGSKeywordForm>(), e.effectKeywords);
					e.num["actorValue"] = static_cast<int>(eff->baseEffect->data.primaryAV);
					e.num["resistance"] = static_cast<int>(eff->baseEffect->data.resistVariable);
					e.num["archetype"] = static_cast<int>(eff->baseEffect->data.archetype);
				}
			}
			return e;
		}

		// ------------------------------------------- SkyUI's icon setter --

		void DefaultIcon(const Entry& e, Icon& ic)
		{
			ic.source = kDefaultSource;
			ic.color = 0xFFFFFF;
			const auto subIt = e.num.find("subType");
			const int  sub = subIt == e.num.end() ? -1 : static_cast<int>(subIt->second);
			const auto ft = static_cast<RE::FormType>(e.formType);
			auto resistColor = [&]() {
				auto it = e.num.find("resistance");
				if (it == e.num.end())
					return;
				const int r = static_cast<int>(it->second);
				if (r == g_av.fire) ic.color = 0xC73636;
				else if (r == g_av.shock) ic.color = 0xFFFF00;
				else if (r == g_av.frost) ic.color = 0x1FFBFF;
			};
			switch (ft) {
			case RE::FormType::Scroll:
				ic.label = "default_scroll";
				resistColor();
				break;
			case RE::FormType::Armor:
				{
					ic.label = "default_armor";
					ic.color = 0xEDDA87;
					auto wcIt = e.num.find("weightClass");
					const int wc = wcIt == e.num.end() ? -1 : static_cast<int>(wcIt->second);
					auto jewelry = [&]() {
						if (sub == eAmulet) ic.label = "armor_amulet";
						else if (sub == eRing) ic.label = "armor_ring";
						else if (sub == eCirclet) ic.label = "armor_circlet";
					};
					auto part = [&](const char* prefix) {
						switch (sub) {
						case eHead: case eHair: case eLongHair: ic.label = std::string(prefix) + "_head"; break;
						case eBody: case eTail: ic.label = std::string(prefix) + "_body"; break;
						case eHands: ic.label = std::string(prefix) + "_hands"; break;
						case eForearms: ic.label = std::string(prefix) + "_forearms"; break;
						case eFeet: ic.label = std::string(prefix) + "_feet"; break;
						case eCalves: ic.label = std::string(prefix) + "_calves"; break;
						case eShield: ic.label = std::string(prefix) + "_shield"; break;
						case eAmulet: case eRing: case eCirclet: case eEars: jewelry(); break;
						default: break;
						}
					};
					if (wc == 0) { ic.color = 0x756000; part("lightarmor"); }
					else if (wc == 1) { ic.color = 0x6B7585; part("armor"); }
					else if (wc == 4) jewelry();
					else {
						switch (sub) {
						case eHead: case eHair: case eLongHair: ic.label = "clothing_head"; break;
						case eBody: case eTail: ic.label = "clothing_body"; break;
						case eHands: ic.label = "clothing_hands"; break;
						case eForearms: ic.label = "clothing_forearms"; break;
						case eFeet: ic.label = "clothing_feet"; break;
						case eCalves: ic.label = "clothing_calves"; break;
						case eShield: ic.label = "clothing_shield"; break;
						default: break;
						}
					}
					break;
				}
			case RE::FormType::Book:
				ic.label = "default_book";
				if (sub == bRecipe || sub == bNote) ic.label = "book_note";
				else if (sub == bSpellTome) ic.label = "book_tome";
				break;
			case RE::FormType::Ingredient: ic.label = "default_ingredient"; break;
			case RE::FormType::Light: ic.label = "misc_torch"; break;
			case RE::FormType::KeyMaster: ic.label = "default_key"; break;
			case RE::FormType::Weapon:
				ic.label = "default_weapon";
				ic.color = 0xA4A5BF;
				switch (sub) {
				case wSword: ic.label = "weapon_sword"; break;
				case wDagger: ic.label = "weapon_dagger"; break;
				case wWarAxe: ic.label = "weapon_waraxe"; break;
				case wMace: ic.label = "weapon_mace"; break;
				case wGreatsword: ic.label = "weapon_greatsword"; break;
				case wBattleaxe: ic.label = "weapon_battleaxe"; break;
				case wWarhammer: ic.label = "weapon_hammer"; break;
				case wBow: ic.label = "weapon_bow"; break;
				case wStaff: ic.label = "weapon_staff"; break;
				case wCrossbow: ic.label = "weapon_crossbow"; break;
				case wPickaxe: ic.label = "weapon_pickaxe"; break;
				case wWoodAxe: ic.label = "weapon_woodaxe"; break;
				default: break;
				}
				break;
			case RE::FormType::Ammo:
				ic.label = sub == 1 ? "weapon_bolt" : "weapon_arrow";
				ic.color = 0xA89E8C;
				break;
			case RE::FormType::AlchemyItem:
				ic.label = "default_potion";
				switch (sub) {
				case pDrink: ic.label = "food_wine"; break;
				case pFood: ic.label = "default_food"; break;
				case pPoison: ic.label = "potion_poison"; ic.color = 0xAD00B3; break;
				case pHealth: case pHealRate: case pHealRateMult: ic.label = "potion_health"; ic.color = 0xDB2E73; break;
				case pMagicka: case pMagickaRate: case pMagickaRateMult: ic.label = "potion_magic"; ic.color = 0x2E9FDB; break;
				case pStamina: case pStaminaRate: case pStaminaRateMult: ic.label = "potion_stam"; ic.color = 0x51DB2E; break;
				case pFireResist: ic.label = "potion_fire"; ic.color = 0xC73636; break;
				case pElectricResist: ic.label = "potion_shock"; ic.color = 0xEAAB00; break;
				case pFrostResist: ic.label = "potion_frost"; ic.color = 0x1FFBFF; break;
				default: break;
				}
				break;
			case RE::FormType::SoulGem:
				{
					ic.label = "misc_soulgem";
					ic.color = 0xE3E0FF;
					auto stIt = e.num.find("status");
					const int st = stIt == e.num.end() ? 0 : static_cast<int>(stIt->second);
					auto smallGem = [&]() { ic.label = st == 2 ? "soulgem_full" : st == 1 ? "soulgem_partial" : "soulgem_empty"; };
					auto bigGem = [&]() { ic.label = st == 2 ? "soulgem_grandfull" : st == 1 ? "soulgem_grandpartial" : "soulgem_grandempty"; };
					switch (sub) {
					case 1: ic.color = 0xD7D4FF; smallGem(); break;
					case 2: ic.color = 0xC0BAFF; smallGem(); break;
					case 3: ic.color = 0xABA3FF; smallGem(); break;
					case 4: ic.color = 0x948BFC; bigGem(); break;
					case 5: ic.color = 0x7569FF; bigGem(); break;
					case 6: ic.color = 0x7569FF; ic.label = "soulgem_azura"; break;
					default: break;
					}
					break;
				}
			case RE::FormType::Misc:
				ic.label = "default_misc";
				switch (sub) {
				case mArtifact: ic.label = "misc_artifact"; break;
				case mGem: ic.label = "misc_gem"; ic.color = 0xFFB0D1; break;
				case mHide: ic.label = "misc_hide"; ic.color = 0xDBB36E; break;
				case mRemains: ic.label = "misc_remains"; break;
				case mIngot: ic.label = "misc_ingot"; ic.color = 0x828282; break;
				case mClutter: ic.label = "misc_clutter"; break;
				case mFirewood: ic.label = "misc_wood"; ic.color = 0xA89E8C; break;
				case mDragonClaw: ic.label = "misc_dragonclaw"; break;
				case mLockpick: ic.label = "misc_lockpick"; break;
				case mGold: ic.label = "misc_gold"; ic.color = 0xCCCC33; break;
				case mLeather: ic.label = "misc_leather"; ic.color = 0xBA8D23; break;
				case mLeatherStrips: ic.label = "misc_strips"; ic.color = 0xBA8D23; break;
				case mChildrensClothes: ic.label = "clothing_body"; ic.color = 0xEDDA87; break;
				default: break;
				}
				break;
			default:
				break;
			}
		}

		std::string PathOf(const Icon& ic)
		{
			if (ic.label.empty())
				return {};
			const std::string rel = "icons/game/" + Slug(ic.source.empty() ? kDefaultSource : ic.source) + "/" + ic.label + ".png";
			if (auto it = g_pathOk.find(rel); it != g_pathOk.end())
				return it->second ? rel : std::string();
			std::error_code ec;
			const bool ok = fs::exists(fs::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / U8(rel), ec);
			g_pathOk[rel] = ok;
			return ok ? rel : std::string();
		}
	}

	bool Available()
	{
		if (g_available < 0) {
			std::error_code ec;
			g_available = fs::exists(fs::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "game" / "index.json", ec) ? 1 : 0;
		}
		return g_available == 1;
	}

	std::string Summary()
	{
		LoadRules();
		return std::to_string(g_rules.size()) + " I4 rules from " + std::to_string(g_files) + " files";
	}

	Icon For(RE::TESBoundObject* obj, const Instance& inst)
	{
		Icon ic;
		if (!obj)
			return ic;
		LoadRules();
		Entry e = BuildEntry(obj, inst);
		DefaultIcon(e, ic);

		// I4 pass 1: info (subType, subTypeDisplay ...) from every matching rule.
		bool info = false;
		for (const auto& r : g_rules) {
			if (!r.hasInfo || (r.formType >= 0 && r.formType != e.formType))
				continue;
			if (!Matches(r, e))
				continue;
			info = true;
			if (r.subType)
				e.num["subType"] = *r.subType;
			if (!r.display.empty())
				ic.display = r.display;
		}
		if (info) {
			const std::string display = ic.display;
			ic = Icon{};
			DefaultIcon(e, ic);
			ic.display = display;
		}
		// I4 pass 2: icons, later rules winning.
		for (const auto& r : g_rules) {
			if (!r.setSource && !r.label && !r.color)
				continue;
			if (r.formType >= 0 && r.formType != e.formType)
				continue;
			if (!Matches(r, e))
				continue;
			if (r.setSource)
				ic.source = r.source.empty() ? kDefaultSource : r.source;
			if (r.label)
				ic.label = *r.label;
			if (r.color)
				ic.color = *r.color;
		}
		if (!ic.display.empty() && ic.display[0] == '$')
			ic.display = ic.display.substr(1);
		ic.path = Available() ? PathOf(ic) : std::string();
		return ic;
	}
}
