// Container Auto-Sort backend — see container_sort.h for the contract.
//
// Load-bearing design notes:
//  - The taxonomy classifier is COPIED from item_explorer.cpp (§4.1), not
//    shared: same playable/named filters, same file-width ESL-safe local-FormID
//    law (never GetLocalFormID(), whose missing null check is the 2026-08-03
//    CTD). Copying keeps this module free of item_explorer's index lifecycle.
//  - Real transfers use RemoveItem(obj, count, kStoreInContainer, extraList,
//    destRef) — NOT AddObjectToContainer, which drops the ExtraDataList so a
//    tempered / enchanted / named item would lose its data on the move (§4.5).
//    Each entry is moved per-extra-list so stacked-distinct items carry their
//    own ExtraDataList.
//  - The player-inventory read is a FRESH GetInventory() snapshot map (a copy,
//    so removing while iterating it is safe). The inbox read is the ONE
//    sanctioned container-inventory read (§4.7) — a container the user
//    deliberately filled; destination chests are NEVER read (levelled-loot
//    trap) — they only receive via RemoveItem(..., destRef).
//  - The broken-bag guard is REPLICATED from no_auto_gear.cpp
//    (InventorySafeToRemove / ScanInventory) because that pair lives in
//    no_auto_gear's anonymous namespace and is not exported. One dead inventory
//    entry anywhere in the bag faults RemoveItem and FREEZES the game; a bulk
//    move has no per-item equip fallback, so a dirty bag refuses the whole sweep.
//  - All JSON dumps use error_handler_t::replace: item / container names come
//    out of arbitrary ESPs and are not guaranteed UTF-8; a throwing dump would
//    kill the reply.

#include "container_sort.h"

#include "pch.h"

#include "container_actions.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

namespace ContainerSort
{
	namespace
	{
		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		std::function<Snapshot()> g_provider;

		constexpr RE::FormID kGold     = 0x0000000F;  // Gold001
		constexpr RE::FormID kLockpick = 0x0000000A;  // Lockpick

		// A MISC item worth at least this much, with no crafting/vendor role, reads
		// as `treasure` rather than `clutter` (goblets, jewelled dishes, ceremonial
		// plate). A value test rather than a shipped FormID list: it needs no
		// curation and it works for every mod in the order on day one.
		constexpr std::int32_t kTreasureValue = 75;

		// ------------------------------------------- recipe-derived materials --
		// "Is this lump of stuff a smithing material?" cannot be answered from
		// keywords alone across a 4,780-mod order — a mod's own ingot may carry no
		// VendorItem keyword at all. So ask the RECIPES: walk every
		// BGSConstructibleObject once, bucket it by its workbench keyword, and
		// remember every base form that appears in its required-items list. An item
		// used at a forge IS a forge material, by definition, whatever it is called
		// and whoever shipped it. (The technique is Arcane Vaults' insight; this is
		// our own walk, bucketed to our own tokens.)
		//
		// Built LAZILY on first classification and cached for the session: the walk
		// is a few tens of thousands of records, once, on the main thread.
		struct CraftIndex
		{
			std::unordered_set<RE::FormID> craft;   // forge / anvil / armour table / wheel
			std::unordered_set<RE::FormID> smelt;   // smelter
			std::unordered_set<RE::FormID> tan;     // tanning rack
			std::unordered_set<RE::FormID> build;   // carpenter / drafting table
			std::unordered_set<RE::FormID> cook;    // cook pot / spit / oven / grain mill
			bool                           built = false;
		};
		CraftIndex g_craft;

		// Which bucket does a workbench keyword editor ID name? Substring matching,
		// lowercased, so a mod's `MyModCraftingSmithingForge` lands correctly and an
		// unrecognised bench is simply skipped rather than mis-bucketed. ORDER
		// MATTERS: `CraftingSmelter` must be tested before the smithing family.
		enum class Bench
		{
			None,
			Craft,
			Smelt,
			Tan,
			Build,
			Cook,
			Alchemy,
			Enchant
		};

		Bench BenchOfKeyword(std::string_view edid)
		{
			const std::string k = Lower(edid);
			auto has = [&k](const char* s) { return k.find(s) != std::string::npos; };
			if (has("smelt"))
				return Bench::Smelt;
			if (has("tanning") || has("tanrack"))
				return Bench::Tan;
			if (has("cook") || has("spit") || has("oven") || has("grainmill") || has("campfire"))
				return Bench::Cook;
			if (has("carpenter") || has("drafting") || has("byoh"))
				return Bench::Build;
			if (has("alchemy"))
				return Bench::Alchemy;
			if (has("enchant"))
				return Bench::Enchant;
			if (has("smithing") || has("forge") || has("anvil") || has("sharpening") ||
				has("grindstone") || has("armortable") || has("workbench") || has("skyforge"))
				return Bench::Craft;
			return Bench::None;
		}

		void BuildCraftIndex()
		{
			if (g_craft.built)
				return;
			g_craft.built = true;  // set FIRST: a failed walk must not retry every item
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			std::size_t recipes = 0;
			for (auto* cobj : dh->GetFormArray<RE::BGSConstructibleObject>()) {
				if (!cobj || !cobj->benchKeyword)
					continue;
				const char* edid = cobj->benchKeyword->GetFormEditorID();
				if (!edid || !*edid)
					continue;
				std::unordered_set<RE::FormID>* bucket = nullptr;
				switch (BenchOfKeyword(edid)) {
				case Bench::Craft: bucket = &g_craft.craft; break;
				case Bench::Smelt: bucket = &g_craft.smelt; break;
				case Bench::Tan:   bucket = &g_craft.tan;   break;
				case Bench::Build: bucket = &g_craft.build; break;
				case Bench::Cook:  bucket = &g_craft.cook;  break;
				default: break;  // alchemy/enchanting have no COBJ requirement lists
				}
				if (!bucket)
					continue;
				++recipes;
				cobj->requiredItems.ForEachContainerObject(
					[bucket](RE::ContainerObject& co) {
						if (co.obj)
							bucket->insert(co.obj->GetFormID());
						return RE::BSContainer::ForEachResult::kContinue;
					});
			}
			logger::info(
				"container-sort: craft index built from {} recipes — {} forge, {} smelter, {} tanning, {} building, {} cooking material(s)",
				recipes, g_craft.craft.size(), g_craft.smelt.size(), g_craft.tan.size(),
				g_craft.build.size(), g_craft.cook.size());
		}

		bool InCraftBucket(const std::unordered_set<RE::FormID>& s, RE::FormID id)
		{
			return id && s.find(id) != s.end();
		}

		// ---------------------------------------------------------- taxonomy --
		// EVERY taxonomy token a base form carries — a SET, not one label, because
		// one item honestly belongs to several buckets at once (a steel ingot is
		// `oreIngot` AND a forge material AND a smelting product; a filled grand
		// soul gem is `soulgem`, `soulgemFilled` and `soulgemGrand`). A rule's
		// `types` is ANY-of over this set, so a broad "weapon" rule and a narrow
		// "twoHand" rule both work without the user having to know which one the
		// classifier would have picked.
		//
		// Every token added here is ADDITIVE over the pre-2026-08-17 single-token
		// vocabulary — the old leaf is always still in the set — so rules saved
		// before the split keep matching exactly what they used to match.
		// Deliberate exception to the parent rule: `jewelry` does NOT imply
		// `armor`, preserving our existing behaviour (an "armor" rule has never
		// swept rings and must not start now), and `drink` does not imply `food`.
		bool IsRestorative(RE::AlchemyItem* alch)
		{
			if (!alch)
				return false;
			for (auto* eff : alch->effects) {
				auto* base = eff ? eff->baseEffect : nullptr;
				if (!base || base->IsDetrimental() || base->IsHostile())
					continue;
				if (!base->HasArchetype(RE::EffectSetting::Archetype::kValueModifier) &&
					!base->HasArchetype(RE::EffectSetting::Archetype::kDualValueModifier) &&
					!base->HasArchetype(RE::EffectSetting::Archetype::kPeakValueModifier))
					continue;
				switch (base->data.primaryAV) {
				case RE::ActorValue::kHealth:
				case RE::ActorValue::kMagicka:
				case RE::ActorValue::kStamina:
					return true;
				default:
					break;
				}
			}
			return false;
		}

		// Materials tokens shared by MISC and Ingredient walks.
		void AddMaterialTokens(RE::FormID id, std::vector<std::string>& out)
		{
			bool any = false;
			if (InCraftBucket(g_craft.craft, id)) { out.push_back("craftMat"); any = true; }
			if (InCraftBucket(g_craft.smelt, id)) { out.push_back("smeltMat"); any = true; }
			if (InCraftBucket(g_craft.tan, id))   { out.push_back("tanMat");   any = true; }
			if (InCraftBucket(g_craft.build, id)) { out.push_back("buildMat"); any = true; }
			if (any)
				out.push_back("smithing");
		}

		std::vector<std::string> TokensOf(RE::TESBoundObject* obj)
		{
			std::vector<std::string> out;
			if (!obj)
				return out;
			BuildCraftIndex();
			const auto id = obj->GetFormID();

			switch (obj->GetFormType()) {
			case RE::FormType::Weapon: {
				out.push_back("weapon");
				if (auto* weap = obj->As<RE::TESObjectWEAP>()) {
					switch (weap->GetWeaponType()) {
					case RE::WEAPON_TYPE::kOneHandSword:
					case RE::WEAPON_TYPE::kOneHandDagger:
					case RE::WEAPON_TYPE::kOneHandAxe:
					case RE::WEAPON_TYPE::kOneHandMace:
						out.push_back("oneHand");
						break;
					case RE::WEAPON_TYPE::kTwoHandSword:
					case RE::WEAPON_TYPE::kTwoHandAxe:
						out.push_back("twoHand");
						break;
					case RE::WEAPON_TYPE::kBow:
					case RE::WEAPON_TYPE::kCrossbow:
						out.push_back("bow");
						break;
					case RE::WEAPON_TYPE::kStaff:
						out.push_back("staff");
						break;
					default:
						break;
					}
				}
				return out;
			}
			case RE::FormType::Armor: {
				auto* armo = obj->As<RE::TESObjectARMO>();
				// Jewelry is ARMO with the VendorItemJewelry keyword. HasKeywordString
				// is the robust, load-order-safe test (no hardcoded FormID or slot
				// mask) — but an un-keyworded ring is common in mods, so fall back to
				// the biped slots the vanilla jewellery pieces occupy.
				const bool jewelry = armo &&
					(armo->HasKeywordString("VendorItemJewelry") ||
						armo->HasPartOf(RE::BIPED_MODEL::BipedObjectSlot::kRing) ||
						armo->HasPartOf(RE::BIPED_MODEL::BipedObjectSlot::kAmulet) ||
						armo->HasPartOf(RE::BIPED_MODEL::BipedObjectSlot::kCirclet));
				if (jewelry) {
					out.push_back("jewelry");
					return out;
				}
				out.push_back("armor");
				if (armo) {
					if (armo->HasKeywordString("ArmorShield") ||
						(armo->GetFormFlags() & RE::TESObjectARMO::RecordFlags::kShield) != 0)
						out.push_back("shield");
					switch (armo->GetArmorType()) {
					case RE::BIPED_MODEL::ArmorType::kHeavyArmor:
						out.push_back("heavyArmor");
						break;
					case RE::BIPED_MODEL::ArmorType::kLightArmor:
						out.push_back("lightArmor");
						break;
					case RE::BIPED_MODEL::ArmorType::kClothing:
						out.push_back("clothing");
						break;
					default:
						break;
					}
				}
				return out;
			}
			case RE::FormType::Ammo:
				out.push_back("ammo");
				return out;
			case RE::FormType::AlchemyItem: {
				auto* alch = obj->As<RE::AlchemyItem>();
				if (alch) {
					if (alch->IsPoison()) {
						out.push_back("poison");
						return out;
					}
					if (alch->IsFood()) {
						// Drinks (mead, wine, ale) carry a VendorItemDrink keyword;
						// everything else edible reads as food. A `drink` rule token
						// therefore separates a wine rack from a food larder.
						if (alch->HasKeywordString("VendorItemDrink")) {
							out.push_back("drink");
							return out;
						}
						out.push_back("food");
						// Raw vs cooked decides which shelf a larder wants. The
						// VendorItemFoodRaw keyword is the vanilla marker; anything
						// the cooking recipes CONSUME is raw by definition, which
						// catches modded produce that carries no keyword at all.
						if (alch->HasKeywordString("VendorItemFoodRaw") ||
							InCraftBucket(g_craft.cook, id))
							out.push_back("rawFood");
						else
							out.push_back("cookedFood");
						return out;
					}
				}
				out.push_back("potion");
				if (IsRestorative(alch))
					out.push_back("restorative");
				return out;
			}
			case RE::FormType::Ingredient: {
				out.push_back("ingredient");
				auto* ing = obj->As<RE::IngredientItem>();
				// A reagent is an ingredient you EAT or cook with; a catalyst is one
				// a smith consumes (fire salts, void salts). Same form type, opposite
				// shelves — and the recipe index is what tells them apart.
				const bool smith = InCraftBucket(g_craft.craft, id) ||
					InCraftBucket(g_craft.smelt, id) || InCraftBucket(g_craft.build, id);
				if ((ing && ing->IsFood()) || InCraftBucket(g_craft.cook, id))
					out.push_back("reagent");
				else if (smith)
					out.push_back("catalyst");
				AddMaterialTokens(id, out);
				return out;
			}
			case RE::FormType::SoulGem: {
				out.push_back("soulgem");
				if (auto* gem = obj->As<RE::TESSoulGem>()) {
					if (gem->GetContainedSoul() == RE::SOUL_LEVEL::kNone)
						out.push_back("soulgemEmpty");
					else
						out.push_back("soulgemFilled");
					if (gem->GetMaximumCapacity() == RE::SOUL_LEVEL::kGrand)
						out.push_back("soulgemGrand");
				}
				return out;
			}
			case RE::FormType::Scroll:
				out.push_back("scroll");
				return out;
			case RE::FormType::KeyMaster:
				out.push_back("key");
				return out;
			case RE::FormType::Book: {
				out.push_back("book");
				if (auto* book = obj->As<RE::TESObjectBOOK>()) {
					if (book->TeachesSpell())
						out.push_back("spellbook");
					else if (book->TeachesSkill())
						out.push_back("skillbook");
				}
				return out;
			}
			case RE::FormType::Misc: {
				if (id == kGold) {
					out.push_back("gold");
					return out;
				}
				if (id == kLockpick) {
					out.push_back("lockpick");
					return out;
				}
				auto* misc = obj->As<RE::TESObjectMISC>();
				bool  named = false;
				if (misc) {
					if (misc->HasKeywordString("VendorItemGem")) {
						out.push_back("gem");
						named = true;
					} else if (misc->HasKeywordString("VendorItemOreIngot")) {
						out.push_back("oreIngot");
						named = true;
					} else if (misc->HasKeywordString("VendorItemAnimalHide") ||
						misc->HasKeywordString("VendorItemAnimalPart")) {
						out.push_back("hide");
						named = true;
					}
				}
				if (!named) {
					// Everything else MISC stays `clutter` (rules written before the
					// split keep working) and additionally earns `treasure` when it
					// is plainly loot rather than junk — a goblet, a circlet mould, a
					// jewelled dish. Value is the honest, mod-proof test.
					out.push_back("clutter");
					if (obj->GetGoldValue() >= kTreasureValue)
						out.push_back("treasure");
				}
				AddMaterialTokens(id, out);
				return out;
			}
			case RE::FormType::Light:
				out.push_back("clutter");  // carryable torches — sweepable as clutter
				return out;
			default:
				return out;
			}
		}

		bool HasToken(const std::vector<std::string>& tokens, const std::string& t)
		{
			return std::find(tokens.begin(), tokens.end(), t) != tokens.end();
		}

		// ---------------------------------------------------------- overrides --
		// A user override replaces an item's whole token set, so it is applied at
		// the ONE place everything classifies through. Resolved to runtime FormIDs
		// once per operation (the identity is the ESL-safe (plugin, localId) pair,
		// so it survives a load-order change; the map is per-op and never cached).
		using OverrideMap = std::unordered_map<RE::FormID, std::vector<std::string>>;

		OverrideMap OverridesOf(const Snapshot& snap)
		{
			OverrideMap out;
			if (snap.overrides.empty())
				return out;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return out;
			for (const auto& o : snap.overrides) {
				if (o.plugin.empty() || !o.localId || o.types.empty())
					continue;
				if (auto* f = dh->LookupForm(o.localId, o.plugin))
					out[f->GetFormID()] = o.types;
			}
			return out;
		}

		std::vector<std::string> TokensOfWith(RE::TESBoundObject* obj, const OverrideMap* ov)
		{
			if (ov && obj && !ov->empty()) {
				const auto it = ov->find(obj->GetFormID());
				if (it != ov->end())
					return it->second;
			}
			return TokensOf(obj);
		}

		// The cats-key spec token → a bool. §4.1 vocabulary.
		bool ObjEnchanted(RE::TESBoundObject* obj, RE::InventoryEntryData* entry)
		{
			// Base form carries an object enchantment (staff, pre-enchanted gear).
			if (auto* ench = obj ? obj->As<RE::TESEnchantableForm>() : nullptr) {
				if (ench->formEnchanting)
					return true;
			}
			// OR the inventory entry carries a player-applied ExtraEnchantment on a
			// base with none. entry->IsEnchanted() answers both, but we may not have
			// an entry (Sort reads a container's inventory map); keep the base test.
			return entry && entry->IsEnchanted();
		}

		// ---------------------------------------------------- broken-bag guard --
		// Replicated from no_auto_gear.cpp (InventorySafeToRemove / ScanInventory /
		// FormIsLive / PageIsReadable) — that guard is in no_auto_gear's anonymous
		// namespace, not exported. Same law, same reason: ONE dead inventory entry
		// faults RemoveItem and freezes the game.
		bool PageIsReadable(const void* p, std::size_t size)
		{
			const auto addr = reinterpret_cast<std::uintptr_t>(p);
			if (addr < 0x10000 || (addr & 7) != 0)
				return false;
			MEMORY_BASIC_INFORMATION mbi{};
			if (::VirtualQuery(p, &mbi, sizeof(mbi)) != sizeof(mbi))
				return false;
			if (mbi.State != MEM_COMMIT)
				return false;
			if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))
				return false;
			constexpr DWORD kReadable =
				PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
				PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
			if (!(mbi.Protect & kReadable))
				return false;
			const auto regionEnd =
				reinterpret_cast<std::uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
			return addr + size <= regionEnd;
		}

		bool FormIsLive(const RE::TESForm* form)
		{
			if (!PageIsReadable(form, sizeof(RE::TESForm)))
				return false;
			const auto id = form->GetFormID();
			if (!id || id == 0xFFFFFFFF)
				return false;
			return RE::TESForm::LookupByID(id) == form;
		}

		void ScanInventoryInner(RE::Actor* actor, std::uint32_t* bad)
		{
			auto* changes = actor->GetInventoryChanges();
			if (!changes || !changes->entryList)
				return;
			for (auto* entry : *changes->entryList)
				if (!PageIsReadable(entry, sizeof(RE::InventoryEntryData)) ||
					!FormIsLive(entry->object))
					++*bad;
		}

		bool ScanInventory(RE::Actor* actor, std::uint32_t* bad)
		{
			__try {
				ScanInventoryInner(actor, bad);
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		bool InventorySafeToRemove(RE::Actor* actor)
		{
			std::uint32_t bad = 0;
			return ScanInventory(actor, &bad) && bad == 0;
		}

		// ----------------------------------------------------- match predicate --
		// §4.2 answers "does this rule match this item?" — types ANY-of, keywords
		// ANY-of, value band + enchanted ANDed with the present predicates. A rule
		// with NO predicate (empty types+keywords, no value band, not enchantedOnly)
		// matches NOTHING — the honest "add a type or keyword" case, so a bare
		// enabled rule never vacuums the whole bag.
		bool RuleHasPredicate(const SortRule& r)
		{
			return !r.types.empty() || !r.keywords.empty() || r.minValue > 0 ||
				r.maxValue > 0 || r.enchantedOnly;
		}

		// Does the item hit this rule on a KEYWORD (name-substring OR BGSKeyword
		// edid)? Split out because §4.2 precedence tier 2 = keyword match wins over
		// bare type+value.
		bool KeywordHit(const SortRule& r, RE::TESBoundObject* obj, const std::string& lowerName)
		{
			for (const auto& kw : r.keywords) {
				if (kw.empty())
					continue;
				if (lowerName.find(Lower(kw)) != std::string::npos)
					return true;
				if (auto* kwf = obj ? obj->As<RE::BGSKeywordForm>() : nullptr)
					if (kwf->HasKeywordString(kw))
						return true;
			}
			return false;
		}

		bool TypeValueHit(const SortRule& r, const std::vector<std::string>& tokens,
			std::int32_t value, bool enchanted)
		{
			if (!r.types.empty()) {
				// ANY-of, over the item's WHOLE token set (§4.1) — so both a broad
				// "weapon" rule and a narrow "twoHand" rule catch a greatsword.
				const bool hit = std::any_of(r.types.begin(), r.types.end(),
					[&tokens](const std::string& want) { return HasToken(tokens, want); });
				if (!hit)
					return false;
			}
			if (r.minValue > 0 && value < r.minValue)
				return false;
			if (r.maxValue > 0 && value > r.maxValue)
				return false;
			if (r.enchantedOnly && !enchanted)
				return false;
			return true;
		}

		// Full rule match (all present predicates ANDed). Used for the type+value
		// tier; keyword tier calls KeywordHit + the value/enchant gates directly.
		bool RuleMatches(const SortRule& r, RE::TESBoundObject* obj,
			const std::vector<std::string>& tokens, const std::string& lowerName,
			std::int32_t value, bool enchanted)
		{
			if (!RuleHasPredicate(r))
				return false;
			if (!r.keywords.empty() && !KeywordHit(r, obj, lowerName))
				return false;
			return TypeValueHit(r, tokens, value, enchanted);
		}

		// ------------------------------------------------- destination routing --
		// Order the candidate marks by (priority DESC, config order ASC, id ASC) —
		// the §4.3 tiebreak, applied once so both tiers walk a deterministic list.
		std::vector<const MarkSnap*> OrderedMarks(const Snapshot& snap)
		{
			std::vector<const MarkSnap*> out;
			for (const auto& m : snap.marks)
				out.push_back(&m);
			std::sort(out.begin(), out.end(), [](const MarkSnap* a, const MarkSnap* b) {
				if (a->rule.priority != b->rule.priority)
					return a->rule.priority > b->rule.priority;   // higher wins
				if (a->order != b->order)
					return a->order < b->order;                   // config arrangement
				return a->id < b->id;                             // determinism
			});
			return out;
		}

		// Resolve a mark to a ref that is a live container AND safe to route into
		// (respawn verdict acknowledged-or-safe). Fills `reason` when it refuses so
		// the caller can surface an honest skip. nullptr + empty reason = "not a
		// candidate" (disabled / no predicate) rather than an error.
		RE::TESObjectREFR* SafeDest(const MarkSnap& m, std::string* reason)
		{
			auto* ref = ContainerActions::ResolveRef(m.plugin, m.localId);
			if (!ref) {
				*reason = m.name + " isn't in this load order any more";
				return nullptr;
			}
			if (!ref->GetContainer()) {
				*reason = m.name + " is no longer a container";
				return nullptr;
			}
			const auto v = EvaluateSafety(m.plugin, m.localId);
			if (v.respawns && !m.safeAcknowledged) {
				*reason = m.name + " respawns (" + v.reason + ") — tag it anyway to allow";
				return nullptr;
			}
			return ref;
		}

		// The precedence walk for ONE item (§4.2): pin > keyword > type+value.
		// Returns the destination mark id, or "" for residue. `pinReason` is set
		// when a pin exists but its target is unusable (skipped, never re-routed).
		std::string RouteItem(const Snapshot& snap, const std::vector<const MarkSnap*>& ordered,
			RE::TESBoundObject* obj, const std::vector<std::string>& tokens,
			const std::string& lowerName, std::int32_t value, bool enchanted,
			std::string* pinReason)
		{
			const auto id = obj->GetFormID();
			// 1) Per-item pin — highest precedence. A pin to a disabled/unsafe/gone
			// mark is a SKIP with a reason, never a silent re-route (explicit intent).
			for (const auto& pin : snap.pins) {
				RE::TESBoundObject* pinObj = nullptr;
				if (auto* dh = RE::TESDataHandler::GetSingleton())
					if (auto* f = dh->LookupForm(pin.localId, pin.plugin))
						pinObj = f->As<RE::TESBoundObject>();
				if (pinObj && pinObj->GetFormID() == id) {
					const MarkSnap* pm = nullptr;
					for (const auto* m : ordered)
						if (m->id == pin.markId) { pm = m; break; }
					if (!pm) {
						*pinReason = "pinned container is gone";
						return "";
					}
					std::string reason;
					if (!SafeDest(*pm, &reason)) {
						*pinReason = reason.empty() ? "pinned container unavailable" : reason;
						return "";
					}
					return pm->id;
				}
			}
			// 2) Keyword tier — first enabled mark whose rule matches on a keyword.
			for (const auto* m : ordered) {
				if (!m->rule.enabled || m->rule.keywords.empty())
					continue;
				if (!KeywordHit(m->rule, obj, lowerName))
					continue;
				if (!TypeValueHit(m->rule, tokens, value, enchanted))
					continue;
				std::string reason;
				if (SafeDest(*m, &reason))
					return m->id;
			}
			// 3) Type+value tier — first enabled mark matching on type/value/enchanted.
			for (const auto* m : ordered) {
				if (!m->rule.enabled || !m->rule.keywords.empty())
					continue;  // keyword rules already had their turn above
				if (!RuleMatches(m->rule, obj, tokens, lowerName, value, enchanted))
					continue;
				std::string reason;
				if (SafeDest(*m, &reason))
					return m->id;
			}
			return "";  // residue
		}

		std::string NameOf(RE::TESBoundObject* obj)
		{
			const char* n = obj ? obj->GetName() : nullptr;
			return (n && *n) ? n : "item";
		}

		// --------------------------------------------------- bulk move helper --
		// Move everything in `src` whose taxonomy set intersects `types` (empty =
		// everything) into `dest`, leaving `keep` of each stack behind. Shared by
		// Retrieve (chest → player), the crafting loan (chest → player) and the
		// loan return (player → chest), so all three obey one set of exclusions and
		// one ExtraDataList discipline. Returns the count moved.
		//
		// Reading `src`'s inventory is sanctioned by the same reasoning as the
		// drop-box read (§4.7): every caller here names ONE container the user
		// deliberately pointed at (a retrieve target, a chest they flagged as a
		// lender). It is never used to peek at an arbitrary destination.
		int MoveMatching(RE::TESObjectREFR* src, RE::TESObjectREFR* dest,
			const std::vector<std::string>& types, int keep, bool questGuard,
			MoveReport* rep, const OverrideMap* ov = nullptr)
		{
			if (!src || !dest)
				return 0;
			const bool fromPlayer = src == RE::PlayerCharacter::GetSingleton();

			auto* changes = src->GetInventoryChanges();
			std::unordered_map<RE::TESBoundObject*, RE::InventoryEntryData*> entryOf;
			if (changes && changes->entryList)
				for (auto* e : *changes->entryList)
					if (e && e->object)
						entryOf[e->object] = e;

			int  total = 0;
			auto inv = src->GetInventory();
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				if (obj->GetFormType() == RE::FormType::LeveledItem)
					continue;
				if (obj->GetFormID() == kGold)
					continue;  // gold belongs in the purse, both directions
				RE::InventoryEntryData* entry = nullptr;
				if (auto it = entryOf.find(obj); it != entryOf.end())
					entry = it->second;
				if (entry) {
					if (questGuard && entry->IsQuestObject()) {
						if (rep)
							rep->skipped.push_back({ NameOf(obj), "quest item" });
						continue;
					}
					if (fromPlayer && (entry->IsWorn() || entry->IsFavorited()))
						continue;  // never take the gear off someone's back
				}
				if (!types.empty()) {
					const auto tokens = TokensOfWith(obj, ov);
					const bool hit = std::any_of(types.begin(), types.end(),
						[&tokens](const std::string& want) { return HasToken(tokens, want); });
					if (!hit)
						continue;
				}

				int toMove = data.first - keep;
				if (toMove <= 0)
					continue;
				// Per extra-list first so a tempered / enchanted / named stack member
				// carries its own ExtraDataList across (§4.5); the plain remainder
				// (unmodified copies) rides one call.
				if (entry && entry->extraLists && !entry->extraLists->empty()) {
					for (auto* xl : *entry->extraLists) {
						if (!xl || toMove <= 0)
							continue;
						const int xc = xl->GetCount() > 0 ? xl->GetCount() : 1;
						const int n = xc < toMove ? xc : toMove;
						src->RemoveItem(obj, n, RE::ITEM_REMOVE_REASON::kStoreInContainer, xl, dest);
						toMove -= n;
						total += n;
					}
				}
				if (toMove > 0) {
					src->RemoveItem(obj, toMove, RE::ITEM_REMOVE_REASON::kStoreInContainer,
						nullptr, dest);
					total += toMove;
				}
			}
			return total;
		}

		// ------------------------------------------------ taxonomy, published --
		// ONE table drives both the classifier's vocabulary and the rule editor's
		// chip picker: the view renders from TaxonomyJson(), so a token can never
		// exist in the engine but be unpickable in the UI (or the reverse).
		struct TaxToken
		{
			const char* id;
			const char* label;
			const char* parent;  // "" = top level; the UI indents children under it
		};
		struct TaxGroup
		{
			const char*           label;
			std::vector<TaxToken> tokens;
		};

		const std::vector<TaxGroup>& TaxonomyTable()
		{
			static const std::vector<TaxGroup> table{
				{ "Gear", {
					{ "weapon", "Weapons", "" },
					{ "oneHand", "One-handed", "weapon" },
					{ "twoHand", "Two-handed", "weapon" },
					{ "bow", "Bows & crossbows", "weapon" },
					{ "staff", "Staves", "weapon" },
					{ "armor", "Armour", "" },
					{ "heavyArmor", "Heavy armour", "armor" },
					{ "lightArmor", "Light armour", "armor" },
					{ "clothing", "Clothing", "armor" },
					{ "shield", "Shields", "armor" },
					{ "jewelry", "Jewellery", "" },
					{ "ammo", "Arrows & bolts", "" },
				} },
				{ "Consumables", {
					{ "potion", "Potions", "" },
					{ "restorative", "Restoratives", "potion" },
					{ "poison", "Poisons", "" },
					{ "food", "Food", "" },
					{ "rawFood", "Raw food", "food" },
					{ "cookedFood", "Cooked food", "food" },
					{ "drink", "Drink", "" },
				} },
				{ "Materials", {
					{ "ingredient", "Ingredients", "" },
					// Labels deliberately plain rather than the trade words: what the
					// user reads should say what the split IS (what you cook with vs
					// what a smith consumes), not borrow another mod's vocabulary.
					{ "reagent", "Cooking ingredients", "ingredient" },
					{ "catalyst", "Smithing ingredients", "ingredient" },
					{ "gem", "Gems", "" },
					{ "soulgem", "Soul gems", "" },
					{ "soulgemEmpty", "Empty soul gems", "soulgem" },
					{ "soulgemFilled", "Filled soul gems", "soulgem" },
					{ "soulgemGrand", "Grand soul gems", "soulgem" },
					{ "oreIngot", "Ore & ingots", "" },
					{ "hide", "Hides & pelts", "" },
					{ "smithing", "Crafting materials", "" },
					{ "craftMat", "Forge materials", "smithing" },
					{ "smeltMat", "Smelter materials", "smithing" },
					{ "tanMat", "Tanning materials", "smithing" },
					{ "buildMat", "Building materials", "smithing" },
				} },
				{ "Books", {
					{ "book", "Books", "" },
					{ "spellbook", "Spell tomes", "book" },
					{ "skillbook", "Skill books", "book" },
					{ "scroll", "Scrolls", "" },
				} },
				{ "Misc", {
					{ "clutter", "Clutter", "" },
					{ "treasure", "Treasure", "clutter" },
					{ "key", "Keys", "" },
					{ "lockpick", "Lockpicks", "" },
					{ "gold", "Gold", "" },
				} },
			};
			return table;
		}

		json TaxonomyObj()
		{
			json groups = json::array();
			for (const auto& g : TaxonomyTable()) {
				json toks = json::array();
				for (const auto& t : g.tokens)
					toks.push_back(json{ { "id", t.id }, { "label", t.label },
						{ "parent", t.parent } });
				groups.push_back(json{ { "label", g.label }, { "tokens", std::move(toks) } });
			}
			return json{ { "groups", std::move(groups) } };
		}

		// ------------------------------------------------------- crafting loan --
		// What the player borrowed and from where, so stepping away puts it back
		// exactly where it came from. Session-scoped on purpose: if the game is saved
		// and reloaded mid-loan the materials are simply in the player's bag — nothing
		// is lost, the ledger just forgets to file them and the next Unload puts them
		// away.
		struct LoanEntry
		{
			std::string markId;
			RE::FormID  baseId = 0;
			int         count = 0;
		};
		std::vector<LoanEntry> g_loan;
		bool                   g_loanActive = false;

		std::function<void(const std::string&)> g_resultSink;

		void Report(const std::string& payload)
		{
			if (g_resultSink)
				g_resultSink(payload);
		}

		json ReportJson(const char* op, const MoveReport& rep)
		{
			json byC = json::array();
			for (const auto& b : rep.byContainer)
				byC.push_back(json{ { "markId", b.markId }, { "name", b.name },
					{ "count", b.count } });
			json skipped = json::array();
			for (const auto& s : rep.skipped)
				skipped.push_back(json{ { "name", s.name }, { "reason", s.reason } });
			return json{
				{ "ok", !rep.refused },
				{ "op", op },
				{ "moved", rep.moved },
				{ "byContainer", std::move(byC) },
				{ "residue", rep.residue },
				{ "skipped", std::move(skipped) },
				{ "msg", rep.msg },
			};
		}

		// Which bench is the player standing at? Keywords first (they survive mods
		// that reuse a generic bench type), the vanilla WBDT bench type as fallback.
		Bench BenchOfFurniture(RE::TESObjectREFR* ref)
		{
			auto* base = ref ? ref->GetBaseObject() : nullptr;
			auto* furn = base ? base->As<RE::TESFurniture>() : nullptr;
			if (!furn)
				return Bench::None;
			Bench found = Bench::None;
			furn->ForEachKeyword([&found](RE::BGSKeyword* kw) {
				const char* edid = kw ? kw->GetFormEditorID() : nullptr;
				if (edid && *edid) {
					const Bench b = BenchOfKeyword(edid);
					if (b != Bench::None) {
						found = b;
						return RE::BSContainer::ForEachResult::kStop;
					}
				}
				return RE::BSContainer::ForEachResult::kContinue;
			});
			if (found != Bench::None)
				return found;
			using BT = RE::TESFurniture::WorkBenchData::BenchType;
			switch (furn->workBenchData.benchType.get()) {
			case BT::kAlchemy:
			case BT::kAlchemyExperiment:
				return Bench::Alchemy;
			case BT::kEnchanting:
			case BT::kEnchantingExperiment:
				return Bench::Enchant;
			case BT::kSmithingWeapon:
			case BT::kSmithingArmor:
				return Bench::Craft;
			default:
				return Bench::None;
			}
		}

		// The taxonomy a given bench actually consumes. Deliberately narrow — a loan
		// hands you the materials for THIS station, it does not empty your stores.
		std::vector<std::string> WantedAt(Bench b)
		{
			switch (b) {
			case Bench::Craft:
				return { "craftMat", "oreIngot", "hide", "gem", "catalyst" };
			case Bench::Smelt:
				return { "smeltMat", "oreIngot" };
			case Bench::Tan:
				return { "tanMat", "hide" };
			case Bench::Build:
				return { "buildMat", "craftMat", "oreIngot" };
			case Bench::Cook:
				return { "rawFood", "reagent" };
			case Bench::Alchemy:
				return { "ingredient", "reagent", "catalyst" };
			case Bench::Enchant:
				return { "soulgem" };
			default:
				return {};
			}
		}

		bool LoanAllows(const LoanOpts& o, Bench b)
		{
			switch (b) {
			case Bench::Craft:   return o.smithing;
			case Bench::Smelt:   return o.smelting;
			case Bench::Tan:     return o.tanning;
			case Bench::Build:   return o.smithing;
			case Bench::Cook:    return o.cooking;
			case Bench::Alchemy: return o.alchemy;
			case Bench::Enchant: return o.enchanting;
			default:             return false;
			}
		}

		const char* BenchName(Bench b)
		{
			switch (b) {
			case Bench::Craft:   return "forge";
			case Bench::Smelt:   return "smelter";
			case Bench::Tan:     return "tanning rack";
			case Bench::Build:   return "workbench";
			case Bench::Cook:    return "cooking fire";
			case Bench::Alchemy: return "alchemy lab";
			case Bench::Enchant: return "enchanter";
			default:             return "bench";
			}
		}

		// Lend: chest → player, for every mark the user flagged as a lender.
		void BeginLoan(Bench bench)
		{
			if (g_loanActive || !g_provider)
				return;
			const Snapshot snap = g_provider();
			if (!snap.loan.enabled || !LoanAllows(snap.loan, bench))
				return;
			const auto wanted = WantedAt(bench);
			if (wanted.empty())
				return;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return;

			const OverrideMap ov = OverridesOf(snap);
			g_loan.clear();
			int total = 0;
			int lenders = 0;
			for (const auto& m : snap.marks) {
				if (!m.lend)
					continue;
				std::string reason;
				auto*       chest = SafeDest(m, &reason);
				if (!chest)
					continue;  // an unsafe / unreachable lender is simply skipped
				// Record BEFORE moving: the counts we are about to take are exactly
				// what the return may put back, no more.
				std::unordered_map<RE::FormID, int> taken;
				auto                                inv = chest->GetInventory();
				for (auto& [obj, data] : inv) {
					if (!obj || data.first <= 0)
						continue;
					if (obj->GetFormType() == RE::FormType::LeveledItem)
						continue;
					const auto tokens = TokensOfWith(obj, &ov);
					const bool hit = std::any_of(wanted.begin(), wanted.end(),
						[&tokens](const std::string& w) { return HasToken(tokens, w); });
					if (hit)
						taken[obj->GetFormID()] = data.first;
				}
				if (taken.empty())
					continue;
				const int moved = MoveMatching(chest, player, wanted, 0, true, nullptr, &ov);
				if (moved <= 0)
					continue;
				++lenders;
				total += moved;
				for (const auto& [id, n] : taken)
					g_loan.push_back({ m.id, id, n });
			}

			g_loanActive = total > 0;
			if (!g_loanActive)
				return;
			logger::info(
				"container-sort: crafting loan lent {} item(s) from {} container(s) at the {}",
				total, lenders, BenchName(bench));
			MoveReport rep;
			rep.moved = total;
			rep.msg = "Borrowed " + std::to_string(total) + " material(s) for the " +
				BenchName(bench);
			RE::DebugNotification(rep.msg.c_str());
			Report(Dump(ReportJson("loan", rep)));
		}

		// Return: player → the chest each stack came from, capped at what was lent.
		void EndLoan()
		{
			if (!g_loanActive)
				return;
			g_loanActive = false;
			if (g_loan.empty() || !g_provider)
				return;
			const Snapshot snap = g_provider();
			auto*          player = RE::PlayerCharacter::GetSingleton();
			if (!snap.loan.returnOnExit || !player) {
				g_loan.clear();
				return;
			}

			// What the player holds right now — the return is min(lent, held), so
			// materials spent at the bench are simply not put back, and anything
			// picked up meanwhile stays in the bag.
			std::unordered_map<RE::FormID, int> held;
			for (auto& [obj, data] : player->GetInventory())
				if (obj && data.first > 0)
					held[obj->GetFormID()] = data.first;

			int total = 0;
			for (const auto& e : g_loan) {
				auto it = held.find(e.baseId);
				if (it == held.end() || it->second <= 0)
					continue;
				const MarkSnap* m = nullptr;
				for (const auto& mm : snap.marks)
					if (mm.id == e.markId) { m = &mm; break; }
				if (!m)
					continue;
				auto* chest = ContainerActions::ResolveRef(m->plugin, m->localId);
				auto* obj = RE::TESForm::LookupByID<RE::TESBoundObject>(e.baseId);
				if (!chest || !obj)
					continue;
				const int n = it->second < e.count ? it->second : e.count;
				player->RemoveItem(obj, n, RE::ITEM_REMOVE_REASON::kStoreInContainer, nullptr,
					chest);
				it->second -= n;
				total += n;
			}
			g_loan.clear();
			if (total <= 0)
				return;
			logger::info("container-sort: crafting loan returned {} item(s)", total);
			MoveReport rep;
			rep.moved = total;
			rep.msg = "Returned " + std::to_string(total) + " material(s) to your stores";
			RE::DebugNotification(rep.msg.c_str());
			Report(Dump(ReportJson("loan-return", rep)));
		}

		// ------------------------------------------------------------- sinks --
		// The drop-box "conduit": close the inbox's own transfer menu and it sorts
		// itself. The target ref is captured on OPEN — ContainerMenu's target handle
		// is not reliably readable once the menu is tearing down.
		RE::FormID g_openContainer = 0;

		class MenuSink : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (!ev || ev->menuName != RE::ContainerMenu::MENU_NAME)
					return RE::BSEventNotifyControl::kContinue;

				if (ev->opening) {
					g_openContainer = 0;
					if (auto ref = RE::TESObjectREFR::LookupByHandle(
							RE::ContainerMenu::GetTargetRefHandle()))
						g_openContainer = ref->GetFormID();
					return RE::BSEventNotifyControl::kContinue;
				}

				const RE::FormID closed = g_openContainer;
				g_openContainer = 0;
				if (!closed || !g_provider)
					return RE::BSEventNotifyControl::kContinue;
				const Snapshot snap = g_provider();
				if (!snap.sortOnClose || snap.inboxMarkId.empty())
					return RE::BSEventNotifyControl::kContinue;
				const MarkSnap* inbox = nullptr;
				for (const auto& m : snap.marks)
					if (m.id == snap.inboxMarkId) { inbox = &m; break; }
				if (!inbox)
					return RE::BSEventNotifyControl::kContinue;
				auto* ref = ContainerActions::ResolveRef(inbox->plugin, inbox->localId);
				if (!ref || ref->GetFormID() != closed)
					return RE::BSEventNotifyControl::kContinue;

				// Off the event thread and onto the game thread's task queue: the menu
				// is still tearing down here, and a bulk move underneath it is exactly
				// the kind of thing that ends in a crash log.
				SKSE::GetTaskInterface()->AddTask([]() {
					const MoveReport rep = SortDropBox();
					if (!rep.refused && rep.moved > 0)
						RE::DebugNotification(rep.msg.c_str());
					Report(Dump(ReportJson("sort", rep)));
				});
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		class FurnitureSink : public RE::BSTEventSink<RE::TESFurnitureEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::TESFurnitureEvent* ev,
				RE::BSTEventSource<RE::TESFurnitureEvent>*) override
			{
				if (!ev || !ev->actor || !ev->targetFurniture)
					return RE::BSEventNotifyControl::kContinue;
				if (ev->actor.get() != RE::PlayerCharacter::GetSingleton())
					return RE::BSEventNotifyControl::kContinue;
				const Bench bench = BenchOfFurniture(ev->targetFurniture.get());
				if (bench == Bench::None)
					return RE::BSEventNotifyControl::kContinue;

				const bool entering =
					ev->type.get() == RE::TESFurnitureEvent::FurnitureEventType::kEnter;
				SKSE::GetTaskInterface()->AddTask([entering, bench]() {
					if (entering)
						BeginLoan(bench);
					else
						EndLoan();
				});
				return RE::BSEventNotifyControl::kContinue;
			}
		};


		// --------------------------------------------------------- redirect --
		// "Activating this barrel opens the chest upstairs." Two vtable thunks on
		// TESObjectCONT: 0x37 Activate (swallow the activation and open the mark it
		// points at) and 0x4C GetActivateText (so the crosshair says where it goes,
		// instead of lying about the barrel).
		//
		// Both are on the HOT path — the text thunk runs while the crosshair merely
		// RESTS on a container — so neither may take the config lock per frame. A
		// tiny cache of (source ref FormID -> destination mark) is rebuilt at most
		// every kRedirectTtl; the cost of that is a redirect you just set taking up
		// to a second to show up, which is the right trade for a per-frame hook.
		constexpr auto kRedirectTtl = std::chrono::milliseconds(1000);

		struct RedirectTarget
		{
			std::string markJson;   // what OpenContainer needs (home cell + pose)
			std::string name;       // for the crosshair prompt
		};
		std::unordered_map<RE::FormID, RedirectTarget> g_redirects;
		std::chrono::steady_clock::time_point          g_redirectsAt{};
		bool                                           g_anyRedirect = false;

		void RefreshRedirects()
		{
			const auto now = std::chrono::steady_clock::now();
			if (now - g_redirectsAt < kRedirectTtl)
				return;
			g_redirectsAt = now;
			g_redirects.clear();
			g_anyRedirect = false;
			if (!g_provider)
				return;
			const Snapshot snap = g_provider();
			for (const auto& m : snap.marks) {
				if (m.redirectTo.empty() || m.redirectTo == m.id)
					continue;
				const MarkSnap* dest = nullptr;
				for (const auto& d : snap.marks)
					if (d.id == m.redirectTo) { dest = &d; break; }
				if (!dest || dest->markJson.empty())
					continue;
				auto* src = ContainerActions::ResolveRef(m.plugin, m.localId);
				if (!src)
					continue;   // its plugin left the order — nothing to hook
				g_redirects[src->GetFormID()] = { dest->markJson, dest->name };
				g_anyRedirect = true;
			}
		}

		const RedirectTarget* RedirectFor(RE::TESObjectREFR* ref)
		{
			if (!ref)
				return nullptr;
			RefreshRedirects();
			if (!g_anyRedirect)
				return nullptr;
			const auto it = g_redirects.find(ref->GetFormID());
			return it == g_redirects.end() ? nullptr : &it->second;
		}

		struct ContainerActivateHook
		{
			static bool Thunk(RE::TESObjectCONT* self, RE::TESObjectREFR* target,
				RE::TESObjectREFR* activator, std::uint8_t a3, RE::TESBoundObject* obj,
				std::int32_t count)
			{
				// Only the player, only an unlocked container, and never re-entrant
				// (the redirected open activates its own container).
				static thread_local bool redirecting = false;
				if (!redirecting && target && activator == RE::PlayerCharacter::GetSingleton() &&
					!target->IsLocked()) {
					if (const auto* r = RedirectFor(target)) {
						const std::string payload = r->markJson;
						const std::string name = r->name;
						SKSE::GetTaskInterface()->AddTask([payload, name]() {
							redirecting = true;
							ContainerActions::OpenContainer(payload);
							redirecting = false;
						});
						logger::info("container-sort: redirected an activation to '{}'", name);
						return true;   // the barrel does not open; the chest does
					}
				}
				return g_origActivate(self, target, activator, a3, obj, count);
			}

			static inline REL::Relocation<decltype(Thunk)> g_origActivate;
		};

		struct ContainerActivateTextHook
		{
			static bool Thunk(RE::TESObjectCONT* self, RE::TESObjectREFR* activator,
				RE::BSString& dst)
			{
				const bool ok = g_origText(self, activator, dst);
				// The prompt has no ref parameter, so the ref is the crosshair's —
				// which is exactly the container whose text is being drawn.
				RE::TESObjectREFR* looked = nullptr;
				if (const RE::FormID id = ContainerActions::CrosshairRef())
					looked = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
				if (const auto* r = RedirectFor(looked)) {
					const std::string text = "Open " + r->name;
					dst = text.c_str();
					return true;
				}
				return ok;
			}

			static inline REL::Relocation<decltype(Thunk)> g_origText;
		};

		void InstallRedirectHooks()
		{
			REL::Relocation<std::uintptr_t> vt{ RE::TESObjectCONT::VTABLE[0] };
			ContainerActivateHook::g_origActivate =
				vt.write_vfunc(0x37, ContainerActivateHook::Thunk);
			ContainerActivateTextHook::g_origText =
				vt.write_vfunc(0x4C, ContainerActivateTextHook::Thunk);
			logger::info("container-sort: container redirect hooks installed");
		}

		MenuSink      g_menuSink;
		FurnitureSink g_furnSink;
	}

	void SetConfigProvider(std::function<Snapshot()> provider)
	{
		g_provider = std::move(provider);
	}

	void SetResultSink(std::function<void(const std::string&)> sink)
	{
		g_resultSink = std::move(sink);
	}

	std::string TaxonomyJson()
	{
		return Dump(TaxonomyObj());
	}

	void Init()
	{
		g_loan.clear();
		g_loanActive = false;
		g_openContainer = 0;
		if (auto* ui = RE::UI::GetSingleton())
			ui->AddEventSink<RE::MenuOpenCloseEvent>(&g_menuSink);
		if (auto* src = RE::ScriptEventSourceHolder::GetSingleton())
			src->AddEventSink<RE::TESFurnitureEvent>(&g_furnSink);
		InstallRedirectHooks();
		logger::info("container-sort: sinks installed — drop-box sort-on-close + crafting loan");
	}

	// ================================================================ safety ==
	SafeVerdict EvaluateSafety(const std::string& plugin, std::uint32_t localId)
	{
		SafeVerdict v;
		auto* ref = ContainerActions::ResolveRef(plugin, localId);
		if (!ref) {
			v.respawns = true;  // can't prove safe ⇒ treat as unsafe (refuse-by-default)
			v.reason = "container unresolved";
			return v;
		}
		auto* cell = ref->GetParentCell();
		if (!cell) {
			// A ref whose cell isn't loaded — we can still read its stored parent
			// cell via GetSaveParentCell fallback is not available here; be honest.
			v.respawns = true;
			v.reason = "cell not loaded — can't verify";
			return v;
		}

		// (4) Merchant chest — a vendor faction's own hidden stock container. It
		// respawns ~2 days AND is the shop's inventory; never a storage target.
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (dh) {
				for (auto* fac : dh->GetFormArray<RE::TESFaction>()) {
					if (fac && fac->IsVendor() && fac->vendorData.merchantContainer == ref) {
						v.respawns = true;
						v.reason = "merchant shop stock";
						return v;
					}
				}
			}
		}

		// (5) Owned / off-limits — a theft concern AND (for our purposes) unsafe.
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* playerBase = player ? player->GetActorBase() : nullptr;
		if (ref->IsOffLimits()) {
			v.respawns = true;
			v.reason = "off-limits (not yours)";
			return v;
		}
		if (auto* owner = ref->GetOwner(); owner && owner != playerBase) {
			// A faction the player leads / cell owned by the player is handled by
			// the player-home branch below; a foreign owner here is unsafe+theft.
			auto* ownerFac = owner->As<RE::TESFaction>();
			const bool playerFaction =
				ownerFac && player && player->IsInFaction(ownerFac);
			if (!playerFaction) {
				v.respawns = true;
				v.reason = "owned by someone else";
				return v;
			}
		}

		// (3) Player-home / player-owned cell — all containers there are safe.
		if (auto* cellOwner = cell->GetActorOwner(); cellOwner && cellOwner == playerBase) {
			v.respawns = false;
			v.reason = "player-owned cell";
			return v;
		}
		if (auto* facOwner = cell->GetFactionOwner();
			facOwner && player && player->IsInFaction(facOwner)) {
			v.respawns = false;
			v.reason = "your faction's cell";
			return v;
		}

		// (2) PRIMARY gate — the cell's EncounterZone with kNeverResets (NoResetZone)
		// ⇒ SAFE. A cell with no encounter zone (most player homes, some statics)
		// is treated per the branches above; a zone that CAN reset is unsafe.
		// NG keeps encounterZone inside LOADED_CELL_DATA (runtime data) — null for
		// an UNLOADED cell, so a far-away mark can't read its zone and falls to the
		// honest unsafe-unless-acknowledged default below; the ref's own extra list
		// carries the zone when the cell can't say (checked first — it survives
		// unload). Never a direct `cell->encounterZone` — that member doesn't exist.
		RE::BGSEncounterZone* zone = nullptr;
		if (auto* xez = ref->extraList.GetByType<RE::ExtraEncounterZone>())
			zone = xez->zone;
		if (!zone)
			if (auto* loaded = cell->GetRuntimeData().loadedData)
				zone = loaded->encounterZone;
		if (zone) {
			if (zone->data.flags.any(RE::ENCOUNTER_ZONE_DATA::Flag::kNeverResets)) {
				v.respawns = false;
				v.reason = "NoResetZone (never resets)";
				return v;
			}
			v.respawns = true;
			v.reason = "in a resetting encounter zone";
			return v;
		}

		// (6) Otherwise — a generic world/dungeon container with no protective zone.
		// Interiors with no encounter zone are usually safe town/quest cells, but we
		// cannot prove non-reset, so be honest: unsafe-unless-acknowledged.
		v.respawns = true;
		v.reason = cell->IsInteriorCell() ? "no NoReset zone on this cell"
										  : "exterior cell — may respawn";
		return v;
	}

	// =============================================================== sweeps ===
	// ONE walk of the player's bag serves both directions of "put this away":
	//   target != nullptr  — single destination, ITS rule decides (Unload here).
	//   target == nullptr  — routed, the §4.2 precedence decides per item, so one
	//                        press files the whole bag across every container.
	// Same exclusions, same ExtraDataList discipline, same honest residue count.
	// `keep` leaves that many of each stack in the bag; `only` (> 0) moves at most
	// that many of each — the "put one copy away" verb.
	namespace
	{
		MoveReport SweepPlayer(const Snapshot& snap, const MarkSnap* target, int keep, int only)
		{
			MoveReport rep;
			auto*      player = RE::PlayerCharacter::GetSingleton();
			if (!player) {
				rep.refused = true;
				rep.msg = "no player";
				return rep;
			}
			// Broken-bag guard: a bulk move has no per-item equip fallback, so a dirty
			// bag refuses the WHOLE sweep (§4.4).
			if (!InventorySafeToRemove(player)) {
				rep.refused = true;
				rep.msg = "broken bag — one dead item entry would freeze the game; clear it with ReSaver";
				return rep;
			}
			if (keep < 0)
				keep = 0;
			if (only < 0)
				only = 0;

			// Resolve the single destination up front (routed mode resolves per item).
			RE::TESObjectREFR* fixedDest = nullptr;
			if (target) {
				std::string reason;
				fixedDest = SafeDest(*target, &reason);
				if (!fixedDest) {
					rep.refused = true;
					rep.msg = reason.empty() ? "that container can't receive items" : reason;
					return rep;
				}
			}

			const auto        ordered = OrderedMarks(snap);
			const OverrideMap ov = OverridesOf(snap);
			std::unordered_map<std::string, int>          perCont;
			std::unordered_map<std::string, std::string>  nameOfMark;
			std::unordered_map<std::string, RE::TESObjectREFR*> refOfMark;
			for (const auto& m : snap.marks)
				nameOfMark[m.id] = m.name;

			// A FRESH snapshot map (a copy — safe to remove while iterating it). We
			// must decide against the ENTRY (for worn/favorite/quest/enchant state)
			// too, so walk the changes list for the same objects.
			auto* changes = player->GetInventoryChanges();
			std::unordered_map<RE::TESBoundObject*, RE::InventoryEntryData*> entryOf;
			if (changes && changes->entryList)
				for (auto* e : *changes->entryList)
					if (e && e->object)
						entryOf[e->object] = e;

			auto inv = player->GetInventory();
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				// Skip unresolved leveled-item stubs (§4.5).
				if (obj->GetFormType() == RE::FormType::LeveledItem)
					continue;
				if (obj->GetFormID() == kGold)
					continue;  // never swept, never reported
				RE::InventoryEntryData* entry = nullptr;
				if (auto it = entryOf.find(obj); it != entryOf.end())
					entry = it->second;

				// Exclusions (§4.4). Without an entry we cannot read worn/favorite/
				// quest — treat that as "no extra state" and only the base gates apply.
				if (entry) {
					if (snap.excludeEquipped && entry->IsWorn()) {
						rep.skipped.push_back({ NameOf(obj), "equipped" });
						continue;
					}
					if (snap.excludeFavorited && entry->IsFavorited()) {
						rep.skipped.push_back({ NameOf(obj), "favorited" });
						continue;
					}
					if (snap.excludeQuest && entry->IsQuestObject()) {
						rep.skipped.push_back({ NameOf(obj), "quest item" });
						continue;
					}
				}

				const std::vector<std::string> tokens = TokensOfWith(obj, &ov);
				const std::string  lower = Lower(NameOf(obj));
				const std::int32_t value = obj->GetGoldValue();
				const bool         ench = ObjEnchanted(obj, entry);

				// Where does it go?
				RE::TESObjectREFR* dest = fixedDest;
				std::string        destId = target ? target->id : std::string();
				if (target) {
					if (!RuleMatches(target->rule, obj, tokens, lower, value, ench)) {
						++rep.residue;
						continue;
					}
				} else {
					std::string pinReason;
					destId = RouteItem(snap, ordered, obj, tokens, lower, value, ench, &pinReason);
					if (destId.empty()) {
						if (!pinReason.empty())
							rep.skipped.push_back({ NameOf(obj), pinReason });
						else
							++rep.residue;
						continue;
					}
					// Resolve (and cache) the destination ref for this mark.
					if (auto it = refOfMark.find(destId); it != refOfMark.end()) {
						dest = it->second;
					} else {
						const MarkSnap* dm = nullptr;
						for (const auto* m : ordered)
							if (m->id == destId) { dm = m; break; }
						dest = dm ? ContainerActions::ResolveRef(dm->plugin, dm->localId) : nullptr;
						refOfMark[destId] = dest;
					}
					if (!dest) {
						rep.skipped.push_back({ NameOf(obj), nameOfMark[destId] + " went away mid-sweep" });
						continue;
					}
				}

				int toMove = data.first - keep;
				if (only > 0 && toMove > only)
					toMove = only;
				if (toMove <= 0)
					continue;

				// Move per extra-list so a stacked-distinct item (each enchant/temper)
				// carries its own ExtraDataList (§4.5); the plain remainder rides one
				// call.
				if (entry && entry->extraLists && !entry->extraLists->empty()) {
					for (auto* xl : *entry->extraLists) {
						if (!xl || toMove <= 0)
							continue;
						const int xc = xl->GetCount() > 0 ? xl->GetCount() : 1;
						const int n = xc < toMove ? xc : toMove;
						player->RemoveItem(obj, n, RE::ITEM_REMOVE_REASON::kStoreInContainer, xl, dest);
						toMove -= n;
						perCont[destId] += n;
						rep.moved += n;
					}
				}
				if (toMove > 0) {
					player->RemoveItem(obj, toMove, RE::ITEM_REMOVE_REASON::kStoreInContainer,
						nullptr, dest);
					perCont[destId] += toMove;
					rep.moved += toMove;
				}
			}

			for (auto& [id, n] : perCont)
				rep.byContainer.push_back({ id, nameOfMark.count(id) ? nameOfMark[id] : id, n });
			return rep;
		}
	}

	MoveReport UnloadTo(const std::string& markId, int keep, int only)
	{
		MoveReport rep;
		if (!g_provider) {
			rep.refused = true;
			rep.msg = "sort not initialised";
			return rep;
		}
		const Snapshot snap = g_provider();  // takes the config lock itself

		const MarkSnap* target = nullptr;
		for (const auto& m : snap.marks)
			if (m.id == markId) { target = &m; break; }
		if (!target) {
			rep.refused = true;
			rep.msg = "that container is gone";
			return rep;
		}
		if (!target->rule.enabled || !RuleHasPredicate(target->rule)) {
			rep.refused = true;
			rep.msg = "no predicates — add a type or keyword first";
			return rep;
		}

		rep = SweepPlayer(snap, target, keep, only);
		if (rep.refused)
			return rep;
		rep.msg = "Unloaded " + std::to_string(rep.moved) + " into " + target->name;
		logger::info("container-sort: unloaded {} item(s) into '{}' ({})", rep.moved,
			target->name, target->id);
		return rep;
	}

	// Put it all away — the drop-box routing pass, pointed at the player's bag.
	MoveReport SweepAll(int keep, int only)
	{
		MoveReport rep;
		if (!g_provider) {
			rep.refused = true;
			rep.msg = "sort not initialised";
			return rep;
		}
		const Snapshot snap = g_provider();
		const bool     anyRule = std::any_of(snap.marks.begin(), snap.marks.end(),
			[](const MarkSnap& m) { return m.rule.enabled && RuleHasPredicate(m.rule); });
		if (!anyRule && snap.pins.empty()) {
			rep.refused = true;
			rep.msg = "no container has a rule yet — give one a type or keyword first";
			return rep;
		}

		rep = SweepPlayer(snap, nullptr, keep, only);
		if (rep.refused)
			return rep;
		rep.msg = rep.moved > 0
			? "Put " + std::to_string(rep.moved) + " item(s) away across " +
				std::to_string(rep.byContainer.size()) + " container(s)"
			: "Nothing in your bag matched a container's rules";
		logger::info("container-sort: put away {} item(s) into {} container(s), {} residue",
			rep.moved, rep.byContainer.size(), rep.residue);
		return rep;
	}

	// Gather — every marked container that is safe and reachable hands over what
	// matches, in one press. Refuses an empty filter on purpose: Gather without a
	// type is "empty all my storage into my bag", which is never what was meant.
	MoveReport GatherAll(const std::vector<std::string>& types, int keep)
	{
		MoveReport rep;
		if (!g_provider) {
			rep.refused = true;
			rep.msg = "sort not initialised";
			return rep;
		}
		if (types.empty()) {
			rep.refused = true;
			rep.msg = "pick what to gather first";
			return rep;
		}
		const Snapshot snap = g_provider();
		auto*          player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			rep.refused = true;
			rep.msg = "no player";
			return rep;
		}
		const OverrideMap ov = OverridesOf(snap);

		for (const auto& m : snap.marks) {
			auto* chest = ContainerActions::ResolveRef(m.plugin, m.localId);
			if (!chest || !chest->GetContainer())
				continue;  // not reachable right now — silently skipped, not an error
			const int moved = MoveMatching(chest, player, types, keep, true, &rep, &ov);
			if (moved > 0) {
				rep.byContainer.push_back({ m.id, m.name, moved });
				rep.moved += moved;
			}
		}
		rep.msg = rep.moved > 0
			? "Gathered " + std::to_string(rep.moved) + " item(s) from " +
				std::to_string(rep.byContainer.size()) + " container(s)"
			: "Nothing matching in any reachable container";
		logger::info("container-sort: gathered {} item(s) from {} container(s)", rep.moved,
			rep.byContainer.size());
		return rep;
	}

	std::vector<std::string> TokensForForm(const std::string& plugin, std::uint32_t localId)
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh || plugin.empty() || !localId)
			return {};
		auto* form = dh->LookupForm(localId, plugin);
		auto* obj = form ? form->As<RE::TESBoundObject>() : nullptr;
		if (!obj)
			return {};
		OverrideMap ov;
		if (g_provider)
			ov = OverridesOf(g_provider());
		return TokensOfWith(obj, &ov);
	}

	// ================================================================= sort ===
	MoveReport SortDropBox()
	{
		MoveReport rep;
		if (!g_provider) {
			rep.refused = true;
			rep.msg = "sort not initialised";
			return rep;
		}
		const Snapshot snap = g_provider();

		if (snap.inboxMarkId.empty()) {
			rep.refused = true;
			rep.msg = "designate a drop-box inbox first";
			return rep;
		}
		const MarkSnap* inboxMark = nullptr;
		for (const auto& m : snap.marks)
			if (m.id == snap.inboxMarkId) { inboxMark = &m; break; }
		if (!inboxMark) {
			rep.refused = true;
			rep.msg = "the drop-box is gone — designate one again";
			return rep;
		}
		auto* inbox = ContainerActions::ResolveRef(inboxMark->plugin, inboxMark->localId);
		if (!inbox || !inbox->GetContainer()) {
			rep.refused = true;
			rep.msg = inboxMark->name + " isn't reachable right now";
			return rep;
		}

		const auto        ordered = OrderedMarks(snap);
		const OverrideMap ov = OverridesOf(snap);

		// The ONE sanctioned container-inventory read (§4.7): the inbox is a
		// container the user deliberately filled. GetInventory() returns a fresh
		// map copy (safe to move from while iterating). Destination chests are NEVER
		// read this way — they only receive via RemoveItem(..., destRef).
		auto*                                                        invChanges = inbox->GetInventoryChanges();
		std::unordered_map<RE::TESBoundObject*, RE::InventoryEntryData*> entryOf;
		if (invChanges && invChanges->entryList)
			for (auto* e : *invChanges->entryList)
				if (e && e->object)
					entryOf[e->object] = e;

		auto                                    inv = inbox->GetInventory();
		std::unordered_map<std::string, int>    perCont;
		std::unordered_map<std::string, std::string> nameOfMark;
		for (const auto& m : snap.marks)
			nameOfMark[m.id] = m.name;

		for (auto& [obj, data] : inv) {
			if (!obj || data.first <= 0)
				continue;
			if (obj->GetFormType() == RE::FormType::LeveledItem)
				continue;
			if (obj->GetFormID() == kGold)
				continue;  // gold stays — belongs in the purse, not a chest
			RE::InventoryEntryData* entry = nullptr;
			if (auto it = entryOf.find(obj); it != entryOf.end())
				entry = it->second;
			// Quest guard on the inbox path too (a user could have tossed one in).
			if (snap.excludeQuest && ((entry && entry->IsQuestObject()) || obj->GetFormID() == 0))
				continue;

			const std::vector<std::string> tokens = TokensOfWith(obj, &ov);
			const std::string  lower = Lower(NameOf(obj));
			const std::int32_t value = obj->GetGoldValue();
			const bool         ench = ObjEnchanted(obj, entry);

			std::string pinReason;
			const std::string destId =
				RouteItem(snap, ordered, obj, tokens, lower, value, ench, &pinReason);
			if (destId.empty()) {
				if (!pinReason.empty())
					rep.skipped.push_back({ NameOf(obj), pinReason });
				else
					++rep.residue;
				continue;
			}
			for (const auto* m : ordered) {
				if (m->id != destId)
					continue;
				auto* dest = ContainerActions::ResolveRef(m->plugin, m->localId);
				if (!dest) {
					rep.skipped.push_back({ NameOf(obj), m->name + " went away mid-sort" });
					break;
				}
				const std::int32_t count = data.first;
				if (entry && entry->extraLists && !entry->extraLists->empty()) {
					for (auto* xl : *entry->extraLists) {
						if (!xl)
							continue;
						const std::int32_t xc = xl->GetCount() > 0 ? xl->GetCount() : 1;
						inbox->RemoveItem(obj, xc, RE::ITEM_REMOVE_REASON::kStoreInContainer, xl, dest);
						perCont[destId] += xc;
						rep.moved += xc;
					}
				} else {
					inbox->RemoveItem(obj, count, RE::ITEM_REMOVE_REASON::kStoreInContainer, nullptr, dest);
					perCont[destId] += count;
					rep.moved += count;
				}
				break;
			}
		}

		for (auto& [id, n] : perCont)
			rep.byContainer.push_back({ id, nameOfMark[id], n });
		rep.msg = "Distributed " + std::to_string(rep.moved) + " item(s) to " +
			std::to_string(rep.byContainer.size()) + " container(s)";
		logger::info("container-sort: distributed {} item(s) from inbox '{}' to {} container(s), {} residue",
			rep.moved, inboxMark->name, rep.byContainer.size(), rep.residue);
		return rep;
	}

	// ============================================================= retrieve ===
	MoveReport RetrieveFrom(const std::string& markId, int keep,
		const std::vector<std::string>& types)
	{
		MoveReport rep;
		if (!g_provider) {
			rep.refused = true;
			rep.msg = "sort not initialised";
			return rep;
		}
		const Snapshot snap = g_provider();

		const MarkSnap* target = nullptr;
		for (const auto& m : snap.marks)
			if (m.id == markId) { target = &m; break; }
		if (!target) {
			rep.refused = true;
			rep.msg = "that container is gone";
			return rep;
		}
		auto* src = ContainerActions::ResolveRef(target->plugin, target->localId);
		if (!src || !src->GetContainer()) {
			rep.refused = true;
			rep.msg = target->name + " isn't reachable right now";
			return rep;
		}
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			rep.refused = true;
			rep.msg = "no player";
			return rep;
		}
		if (keep < 0)
			keep = 0;

		const int moved = MoveMatching(src, player, types, keep, /*questGuard*/ true, &rep);
		rep.moved = moved;
		if (moved > 0)
			rep.byContainer.push_back({ target->id, target->name, moved });
		rep.msg = moved > 0
			? "Retrieved " + std::to_string(moved) + " item(s) from " + target->name
			: "Nothing in " + target->name + " matched";
		logger::info("container-sort: retrieved {} item(s) from '{}' (keep {})", moved,
			target->name, keep);
		return rep;
	}

	// ================================================================ state ===
	std::string StateJson()
	{
		json out;
		out["ok"] = true;
		if (!g_provider) {
			out["ok"] = false;
			out["msg"] = "sort not initialised";
			return Dump(out);
		}
		const Snapshot snap = g_provider();

		json marks = json::array();
		for (const auto& m : snap.marks) {
			const auto v = EvaluateSafety(m.plugin, m.localId);
			json rule{
				{ "enabled", m.rule.enabled },
				{ "types", m.rule.types },
				{ "minValue", m.rule.minValue },
				{ "maxValue", m.rule.maxValue },
				{ "keywords", m.rule.keywords },
				{ "enchantedOnly", m.rule.enchantedOnly },
				{ "priority", m.rule.priority },
			};
			json safe{
				{ "respawns", v.respawns },
				{ "reason", v.reason },
				{ "acknowledged", m.safeAcknowledged },
			};
			marks.push_back(json{
				{ "id", m.id }, { "name", m.name }, { "category", m.category },
				{ "lend", m.lend }, { "redirectTo", m.redirectTo },
				{ "rule", std::move(rule) }, { "safe", std::move(safe) } });
		}

		json pins = json::array();
		for (const auto& p : snap.pins)
			pins.push_back(json{ { "plugin", p.plugin }, { "localId", p.localId }, { "markId", p.markId } });

		out["marks"] = std::move(marks);
		out["pins"] = std::move(pins);
		out["inbox"] = snap.inboxMarkId;
		out["opts"] = json{
			{ "excludeEquipped", snap.excludeEquipped },
			{ "excludeFavorited", snap.excludeFavorited },
			{ "excludeQuest", snap.excludeQuest },
			{ "keepGold", snap.keepGold },
			{ "sortOnClose", snap.sortOnClose },
		};
		out["loan"] = json{
			{ "enabled", snap.loan.enabled },
			{ "smithing", snap.loan.smithing },
			{ "smelting", snap.loan.smelting },
			{ "tanning", snap.loan.tanning },
			{ "cooking", snap.loan.cooking },
			{ "alchemy", snap.loan.alchemy },
			{ "enchanting", snap.loan.enchanting },
			{ "returnOnExit", snap.loan.returnOnExit },
		};
		json overrides = json::array();
		for (const auto& o : snap.overrides)
			overrides.push_back(json{ { "plugin", o.plugin }, { "localId", o.localId },
				{ "types", o.types } });
		out["overrides"] = std::move(overrides);
		out["taxonomy"] = TaxonomyObj();
		// How many items are currently out on loan — the honest "you are holding
		// borrowed materials" line the card shows while you stand at a bench.
		out["onLoan"] = static_cast<int>(g_loan.size());
		// playerGold — reuse the same SEH-guarded gold read finance/item_explorer use.
		std::int64_t gold = 0;
		if (auto* p = RE::PlayerCharacter::GetSingleton()) {
			if (auto* ch = p->GetInventoryChanges(); ch && ch->entryList)
				for (auto* e : *ch->entryList)
					if (e && e->object && e->object->GetFormID() == kGold)
						gold += e->countDelta;
		}
		out["playerGold"] = gold;
		return Dump(out);
	}

	// ============================================================ seeded op ===
	bool IsUnloadAction(const std::string& action)
	{
		return action == "sort-now";
	}

	bool IsSweepAction(const std::string& action)
	{
		return action == "put-it-away";
	}

	// The bindable twin of SweepAll: one key, anywhere, and the bag files itself.
	// The caller has already closed the palette (the moves need the live world).
	std::string RunSweepAction()
	{
		const MoveReport rep = SweepAll(0, 0);
		if (!rep.msg.empty())
			RE::DebugNotification(rep.msg.c_str());
		return Dump(ReportJson("sweep", rep));
	}

	// Fires the drop-box sort; the caller has already closed the palette (Sort needs
	// the unpaused world). Builds a csResult-shaped JSON from the MoveReport.
	std::string RunUnloadAction()
	{
		const MoveReport rep = SortDropBox();
		json byC = json::array();
		for (const auto& b : rep.byContainer)
			byC.push_back(json{ { "markId", b.markId }, { "name", b.name }, { "count", b.count } });
		json skipped = json::array();
		for (const auto& s : rep.skipped)
			skipped.push_back(json{ { "name", s.name }, { "reason", s.reason } });
		std::string msg = rep.msg;
		if (!rep.refused)
			RE::DebugNotification(msg.c_str());
		return Dump(json{
			{ "ok", !rep.refused },
			{ "op", "sort" },
			{ "moved", rep.moved },
			{ "byContainer", std::move(byC) },
			{ "residue", rep.residue },
			{ "skipped", std::move(skipped) },
			{ "msg", msg } });
	}
}
