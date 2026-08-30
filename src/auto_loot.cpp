// Auto-Loot backend — see auto_loot.h for the contract.
//
// Load-bearing design notes (mirrors the loot-highlight / container-sort law):
//  - Scan is BOUNDED: TES::ForEachReferenceInRange(player, radius, cb) with cb
//    returning BSContainer::ForEachResult (kContinue to keep walking, kStop to
//    bail early on the per-tick budget). A full-cell ForEachReference would cost
//    the frame on a 4,780-mod cell.
//  - The take of a LOOSE world ref is C++ ActivateRef(player, ...) — the
//    mounts.cpp:415 precedent. The engine moves the WHOLE placed stack + its
//    ExtraDataList on pickup of a placed reference, so a single Activate covers
//    count>1 and tempered/enchanted data. AddObjectToContainer is used ONLY as
//    the count-1 top-up for a plain stack the engine reported took just one, and
//    only when the ref carries no ExtraDataList (a plain remainder). This is
//    exactly the override-#1 contract.
//  - `dest` = a marked container ⇒ Activate to the player, then RemoveItem the
//    same item player→destRef on the SAME task. Dest unresolvable ⇒ fall back to
//    the player (destResolvable=false in alStateData).
//  - Corpses (dead actors) get a SEPARATE deferred path: a corpse only becomes
//    eligible after a DEATH GRACE (>= kDeadTicks consecutive dead ticks) so the
//    engine's post-death equip-state settle can't be raced (looting a body inline
//    right after death crashes). The take there is RemoveItem(corpse→dest) per
//    §5, deferred in its own AddTask, skipping FormType::LeveledItem and any
//    entry still worn/equipped (logged, not taken — the equip-state hazard).
//  - Never steals: IsOffLimits / a foreign GetOwner skips the ref (fired player
//    arrows exempt). lootOwned stays false; the UI never exposes true.
//  - LOTD-wanted toast is RE-DERIVED here (loot_highlight is off-limits WIP): the
//    same TCC gate `dbmNew && !dbmFound && !dbmDisp`, read lazily only when
//    toastRare is on and DBM_RelicNotifications.esp is present.
//  - All JSON dumps use error_handler_t::replace — item names come out of
//    arbitrary ESPs and are not guaranteed UTF-8.

#include "auto_loot.h"

#include "pch.h"

#include "container_actions.h"
// Read-only use of ONE public entry point (NoteLooted) so a corpse this module
// empties stops glowing. The rest of LootHighlight stays untouched.
#include "loot_highlight.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <map>
#include <vector>
#include <string>
#include <unordered_map>
#include <unordered_set>

using json = nlohmann::json;

namespace AutoLoot
{
	namespace
	{
		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		constexpr RE::FormID kGold     = 0x0000000F;  // Gold001
		constexpr RE::FormID kLockpick = 0x0000000A;  // Lockpick

		// Per-tick take budget + wall-clock bail (§5): spread a big pile over
		// several ticks so a single frame never eats a RemoveItem storm.
		constexpr int  kTakeBudget   = 8;
		constexpr auto kTickBudgetMs = std::chrono::milliseconds(4);
		// The door pre-pass gets its own, smaller slice: it is a SECOND walk
		// over the same refs and must not be able to spend the whole frame
		// budget before the sweep that actually takes anything has started.
		constexpr auto kClampBudgetMs = std::chrono::milliseconds(1);

		// Death grace (override #2): a corpse must be observed dead this many
		// consecutive ticks (~500ms each ⇒ ~2s at 4) before its inventory is
		// touched — the post-death equip-state settle must not be raced.
		constexpr int kDeadTicks = 4;

		std::function<Snapshot()>                        g_provider;
		std::function<DestResolve(const std::string&)>   g_destResolver;
		std::function<bool()>                            g_masterToggler;

		// Session dedupe: refs already taken / in-flight this session, keyed by the
		// ref FormID (stable per-session, the same key loot_highlight's opened-set
		// uses). Cleared on save load — a handle from before a load is meaningless.
		std::unordered_set<std::uint32_t> g_looted;

		// Corpses seen dead, ref FormID -> consecutive dead-tick count. A corpse
		// only becomes eligible at kDeadTicks; cleared on save load with g_looted.
		std::unordered_map<std::uint32_t, int> g_deadTicks;

		// Rare-toast dedupe: one toast per ref, for the session.
		std::unordered_set<std::uint32_t> g_toasted;

		// Last-tick pickup count, for alStateData. Atomic — read by StateJson which
		// runs on the same main thread but is set from the tick; keep it simple.
		std::atomic<int> g_lastPicked{ 0 };

		// -------------------------------------------------------- LOTD re-derive --
		// The TCC list read, re-derived independently (override #4). dbmNew holds
		// every displayable item the player does NOT yet have; TCC moves items to
		// dbmFound on pickup / dbmDisp when displayed. The wanted gate is exactly
		// `new && !found && !disp`. Lazy: only resolved when toastRare asks for it.
		struct ListCache
		{
			RE::BGSListForm*                  list = nullptr;
			bool                              tried = false;
			std::uint64_t                     sig = ~0ull;
			std::unordered_set<std::uint32_t> set;
		};
		ListCache g_lotdNew, g_lotdFound, g_lotdDisp;

		// Strikes taken at each ore vein this SWEEP. Reset per sweep rather
		// than remembered: a vein you walk back to later should be mineable
		// again, and the engine's own depletion decides when it is empty.
		std::unordered_map<RE::FormID, int> g_mineStrikes;

		void RefreshList(ListCache& lc, const char* edid)
		{
			if (!lc.list && !lc.tried) {
				lc.tried = true;
				auto* form = RE::TESForm::LookupByEditorID(edid);
				lc.list = form ? form->As<RE::BGSListForm>() : nullptr;
			}
			if (!lc.list)
				return;
			const std::uint64_t sig =
				(static_cast<std::uint64_t>(lc.list->forms.size()) << 32) |
				(lc.list->scriptAddedTempForms ? lc.list->scriptAddedTempForms->size() : 0u);
			if (sig == lc.sig)
				return;
			lc.sig = sig;
			lc.set.clear();
			for (auto* f : lc.list->forms)
				if (f)
					lc.set.insert(f->GetFormID());
			if (lc.list->scriptAddedTempForms)
				for (const auto id : *lc.list->scriptAddedTempForms)
					lc.set.insert(id);
		}

		// True when TCC's own list form resolves, i.e. the museum is installed.
		// Kept separate from IsLotdWanted because "no piece is wanted" and "there
		// is no museum" are different answers, and the Only mode has to tell them
		// apart before it refuses to take anything.
		bool LotdPresent()
		{
			RefreshList(g_lotdNew, "dbmNew");
			return g_lotdNew.list != nullptr;
		}

		// True when the base form is a museum piece the LOTD still wants. Returns
		// false (never a crash / never a spurious toast) when TCC is absent.
		bool IsLotdWanted(RE::TESForm* base)
		{
			if (!base)
				return false;
			RefreshList(g_lotdNew, "dbmNew");
			if (!g_lotdNew.list)
				return false;  // TCC / DBM_RelicNotifications.esp not present
			RefreshList(g_lotdFound, "dbmFound");
			RefreshList(g_lotdDisp, "dbmDisp");
			const auto id = base->GetFormID();
			return g_lotdNew.set.count(id) != 0 &&
				g_lotdFound.set.count(id) == 0 &&
				g_lotdDisp.set.count(id) == 0;
		}

		// ---------------------------------------------------------- taxonomy ----
		// Map a base form to a `cats` KEY (§1.3 / §5.1). "" = not a takeable loose
		// item (skip). Mirrors container_sort's TokenOf but folds to the coarser
		// auto-loot buckets. Gold/gems/lockpicks share the "coins"/"gems" tier.
		std::string CatKeyOf(RE::TESBoundObject* obj)
		{
			if (!obj)
				return "";
			switch (obj->GetFormType()) {
			case RE::FormType::Weapon:
			case RE::FormType::Armor:
				return "gear";
			case RE::FormType::Ammo:
				return "ammo";
			case RE::FormType::AlchemyItem: {
				auto* alch = obj->As<RE::AlchemyItem>();
				if (alch && alch->IsFood())
					return "food";
				return "potions";  // potions + poisons
			}
			case RE::FormType::Ingredient:
				return "ingredients";
			case RE::FormType::SoulGem:
				return "soulgems";
			case RE::FormType::Scroll:
				return "scrolls";
			case RE::FormType::Book:
				return "books";
			case RE::FormType::KeyMaster:
				return "keys";  // own bucket since 2026-08-16, default OFF
			case RE::FormType::Misc: {
				const auto id = obj->GetFormID();
				if (id == kLockpick)
					return "lockpicks";  // split out of "coins" 2026-08-16
				if (id == kGold)
					return "coins";  // the "always want" tier
				auto* misc = obj->As<RE::TESObjectMISC>();
				if (misc && misc->HasKeywordString("VendorItemGem"))
					return "gems";
				return "valuables";  // generic misc — gated by valueFloor below
			}
			case RE::FormType::Light:
				return "valuables";  // carryable torches — value-gated clutter
			default:
				return "";
			}
		}

		// Is this cats key enabled in the snapshot?
		bool CatEnabled(const Snapshot& s, const std::string& key)
		{
			if (key == "coins") return s.coins;
			if (key == "gems") return s.gems;
			if (key == "potions") return s.potions;
			if (key == "food") return s.food;
			if (key == "ingredients") return s.ingredients;
			if (key == "soulgems") return s.soulgems;
			if (key == "scrolls") return s.scrolls;
			if (key == "ammo") return s.ammo;
			if (key == "books") return s.books;
			if (key == "valuables") return s.valuables;
			if (key == "gear") return s.gear;
			if (key == "keys") return s.keys;
			if (key == "lockpicks") return s.lockpicks;
			return false;
		}

		// Defined below, next to the other form helpers — declared here because the
		// per-item rules (which read display names) sit above it.
		std::string NameOf(RE::TESBoundObject* obj);

		// ------------------------------------------------- per-item identity ----
		// The Item Explorer's identity, mirrored (never shared — item_explorer.cpp
		// owns its own index): owning plugin + local id under that file's width.
		// GetLocalFormID() is deliberately NOT used (the actor_identity null-deref
		// lesson: a dynamic form has no source file).
		bool IdentityOf(RE::TESBoundObject* obj, std::string& plugin, std::uint32_t& localId)
		{
			if (!obj)
				return false;
			auto* file = obj->GetFile(0);
			if (!file)
				return false;  // dynamic/runtime form — no durable identity
			plugin = std::string(file->GetFilename());
			localId = obj->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			return true;
		}

		std::string LowerOf(std::string v)
		{
			for (auto& c : v)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return v;
		}

		bool ListHas(const std::vector<Snapshot::ItemRef>& list, const std::string& plugin,
			std::uint32_t localId)
		{
			if (list.empty())
				return false;
			const std::string lp = LowerOf(plugin);
			for (const auto& e : list)
				if (e.localId == localId && LowerOf(e.plugin) == lp)
					return true;
			return false;
		}

		// Case-insensitive substring match of the item's display name against a
		// word list. Words are stored lowercase by the config layer.
		bool WordsHit(const std::vector<std::string>& words, const std::string& name)
		{
			if (words.empty())
				return false;
			const std::string ln = LowerOf(name);
			for (const auto& w : words)
				if (!w.empty() && ln.find(w) != std::string::npos)
					return true;
			return false;
		}

		// The gold floor that applies to one category: its own entry when set,
		// else the global valueFloor for the two historically gated buckets, else
		// none. Keeping the fallback here is what makes an old config behave
		// identically after per-category floors landed.
		std::int32_t FloorFor(const Snapshot& s, const std::string& catKey)
		{
			if (auto it = s.catFloors.find(catKey); it != s.catFloors.end() && it->second > 0)
				return it->second;
			if (catKey == "valuables" || catKey == "gear")
				return s.valueFloor;
			return 0;
		}

		// ------------------------------------------------ the ONE item verdict --
		// Shared by the loose-ref walk and the corpse sweep so the two can never
		// disagree about what "wanted" means. Deliberately item-level only:
		// ownership, the quest guard and the worn-gear skip are REF/entry-level
		// and stay with their callers, because an allow-list entry must never be
		// able to turn auto-loot into a thief.
		// Is this an ingredient with an effect the player has not learned? Skyrim
		// stores the known effects as a 4-bit mask ON THE INGREDIENT itself, which
		// is why this is a cheap read and not a save-data dig.
		bool HasUnknownEffect(RE::TESBoundObject* obj)
		{
			auto* ingr = obj ? obj->As<RE::IngredientItem>() : nullptr;
			if (!ingr)
				return false;
			const std::size_t n = ingr->effects.size();
			if (n == 0)
				return false;
			for (std::size_t i = 0; i < n && i < 4; ++i)
				if ((ingr->gamedata.knownEffectFlags & (1u << i)) == 0)
					return true;
			return false;
		}

		// Worth carrying? Weighed items are judged on value per unit weight;
		// weightless ones on value alone, because the ratio divides by zero there
		// and that is where gold, keys and ammo live.
		bool WorthTheWeight(const Snapshot& s, RE::TESBoundObject* obj)
		{
			if (!obj)
				return true;
			const float w = obj->GetWeight();
			if (w <= 0.0f)
				return !(s.weightlessMinValue > 0 && obj->GetGoldValue() < s.weightlessMinValue);
			if (s.vwRatio <= 0.0f)
				return true;
			return (static_cast<float>(obj->GetGoldValue()) / w) >= s.vwRatio;
		}

		bool WantsItem(const Snapshot& s, RE::TESBoundObject* obj, const std::string& catKey)
		{
			if (!obj || catKey.empty())
				return false;

			// Both the display name and the plugin identity ALLOCATE, and this
			// runs for every candidate reference on every sweep — so neither is
			// built until a rule actually asks for it. A config with no lists and
			// no word rules (the common case) now does no string work here at all,
			// where it used to build two per item per sweep.
			std::string   name;
			bool          nameBuilt = false;
			auto          Name = [&]() -> const std::string& {
				if (!nameBuilt) {
					name = NameOf(obj);
					nameBuilt = true;
				}
				return name;
			};
			std::string   plugin;
			std::uint32_t localId = 0;
			int           idState = -1;  // -1 not asked, 0 no identity, 1 identified
			auto          Identified = [&]() {
				if (idState < 0)
					idState = IdentityOf(obj, plugin, localId) ? 1 : 0;
				return idState == 1;
			};

			// (1) DENY wins outright — list first, then the word form. It beats the
			// museum rule too: "never take this" is the user naming one item, and
			// a rule that hauled it in anyway because the museum wants it would be
			// the deck overruling an explicit instruction.
			if (!s.deny.empty() && Identified() && ListHas(s.deny, plugin, localId))
				return false;
			if (!s.denyWords.empty() && WordsHit(s.denyWords, Name()))
				return false;

			const bool allowed =
				(!s.allow.empty() && Identified() && ListHas(s.allow, plugin, localId)) ||
				(!s.allowWords.empty() && WordsHit(s.allowWords, Name()));

			// (2) LOTD museum rule. `wanted` is TCC's own live verdict, so an item
			// already picked up or already displayed is not wanted — which is both
			// halves of "only what I don't already have" in one test. Resolved only
			// when the mode asks for it, so a load order without TCC pays nothing.
			if (s.lotd != Snapshot::Lotd::Off) {
				const bool wanted = IsLotdWanted(obj);
				if (s.lotd == Snapshot::Lotd::Only) {
					// Museum-run mode. The allow list still means "I want this
					// item", so it survives here rather than becoming a control
					// that silently stops working while the mode is on.
					if (!LotdPresent())
						/* TCC absent: degrade to the ordinary rules below rather
						   than taking nothing at all. */;
					else
						return wanted || allowed;
				} else if (wanted) {
					return true;  // Always: ranks with the allow list, an override
				}
			}

			// (3) ALLOW: an override, so it skips the category and value gates.
			if (allowed)
				return true;

			// (4) Exclusive mode: nothing but the allow list gets through.
			// Checked BEFORE the unknown-ingredient override on purpose: "take
			// only my list" has to mean only that list, or it is not exclusive.
			if (s.allowOnly)
				return false;

			// (5) An ingredient you have not fully learned. An override on the
			// categories and floors — discovery is the point, and a 1-gold
			// mushroom you have never eaten is worth more than its price says.
			if (s.unknownIngredients && HasUnknownEffect(obj))
				return true;

			// (6) The ordinary rules: category on, its gold floor, then whether it
			// is worth its weight.
			if (!CatEnabled(s, catKey))
				return false;
			const std::int32_t floor = FloorFor(s, catKey);
			if (floor > 0 && obj->GetGoldValue() < floor)
				return false;
			if (!WorthTheWeight(s, obj))
				return false;
			return true;
		}

		// ---------------------------------------------------- carry-weight guard --
		// True when the player is at/over the configured share of carry capacity.
		// A zero/absent capacity (god mode, an odd mod state) never blocks: a guard
		// that silently disables looting because an actor value read oddly is worse
		// than no guard.
		bool OverWeight(const Snapshot& s)
		{
			if (!s.weightGuard)
				return false;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return false;
			auto* avo = player->AsActorValueOwner();
			if (!avo)
				return false;
			const float cap = avo->GetActorValue(RE::ActorValue::kCarryWeight);
			if (cap <= 0.0f)
				return false;
			const float carried = avo->GetActorValue(RE::ActorValue::kInventoryWeight);
			const float pct = static_cast<float>(s.weightPct <= 0 ? 90 : s.weightPct) / 100.0f;
			return carried >= cap * pct;
		}

		bool ObjEnchanted(RE::TESBoundObject* obj)
		{
			if (auto* ench = obj ? obj->As<RE::TESEnchantableForm>() : nullptr)
				return ench->formEnchanting != nullptr;
			return false;
		}

		std::string NameOf(RE::TESBoundObject* obj)
		{
			const char* n = obj ? obj->GetName() : nullptr;
			return (n && *n) ? n : "item";
		}

		// ---------------------------------------------------------- place rules --
		// Durable cell identity: owning plugin filename + the local FormID under
		// that file's width. Same law the Item Explorer uses for items and the
		// same reason — a raw runtime FormID is not stable across load orders, and
		// GetLocalFormID() null-derefs on a form with no file (the actor_identity
		// lesson), which a dynamic/temporary cell can be.
		struct CellId
		{
			std::string   plugin;
			std::uint32_t localId = 0;
			bool          ok = false;
		};

		CellId IdentifyCell(RE::TESObjectCELL* cell)
		{
			CellId out;
			if (!cell)
				return out;
			auto* file = cell->GetFile(0);
			if (!file)
				return out;  // dynamic / runtime cell — no durable identity to store
			out.plugin = std::string(file->GetFilename());
			out.localId = cell->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			out.ok = !out.plugin.empty();
			return out;
		}

		// Cell membership rides the SAME comparison the item lists use (ListHas,
		// above) rather than a second lookalike — one identity law, one bug.
		bool CellListHas(const std::vector<Snapshot::ItemRef>& v, const CellId& c)
		{
			return c.ok && ListHas(v, c.plugin, c.localId);
		}

		// Does the PLAYER own this cell? The engine's own notion of "your house":
		// a bought vanilla home's cell is owned by a faction the purchase adds you
		// to, a Hearthfire house is owned outright. Covers both without a
		// hardcoded cell list; a mod home it misses is what areaDeny is for.
		bool PlayerOwnsCell(RE::TESObjectCELL* cell)
		{
			if (!cell)
				return false;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return false;
			if (auto* npc = cell->GetActorOwner(); npc && npc == player->GetActorBase())
				return true;
			if (auto* fac = cell->GetFactionOwner(); fac && player->IsInFaction(fac))
				return true;
			return false;
		}

		// ------------------------------------------------------ ownership guard --
		// §5.2: skip an off-limits ref, or one owned by someone who isn't the player
		// or a player faction. Fired player arrows are exempt (they're yours). Never
		// steals — lootOwned is always false. A player-arrow REFR is a live
		// ProjectileArrow you already fired; the engine flags it not-owned anyway,
		// but the explicit exemption keeps it takeable even if a mod tags it.
		bool OwnershipBlocks(RE::TESObjectREFR* ref)
		{
			if (ref->GetFormType() == RE::FormType::ProjectileArrow)
				return false;
			if (ref->IsOffLimits())
				return true;
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* playerBase = player ? player->GetActorBase() : nullptr;
			if (auto* owner = ref->GetOwner(); owner && owner != playerBase) {
				auto* ownerFac = owner->As<RE::TESFaction>();
				const bool playerFaction = ownerFac && player && player->IsInFaction(ownerFac);
				if (!playerFaction)
					return true;
			}
			return false;
		}

		// §5.3 quest guard for a LOOSE world ref. CommonLib-NG here has no
		// ExtraDataList::IsREFRQuestObject; the durable signal a placed ref is a
		// quest object is a quest-alias fill on its extra list (kFromAlias) — the
		// engine's own "this ref belongs to a quest" marker — plus the base's own
		// quest-object flag where the base carries it (aliases resolve to a
		// BGSBaseAlias, but that isn't reachable from a bare REFR, so kFromAlias is
		// the reliable REFR-level test).
		bool IsQuestRef(RE::TESObjectREFR* ref)
		{
			if (ref->extraList.HasType(RE::ExtraDataType::kFromAlias))
				return true;
			if (ref->extraList.HasType(RE::ExtraDataType::kAliasInstanceArray))
				return true;
			return false;
		}

		// -------------------------------------------------------- rare toasts ----
		// §5: one HUD line per rare item, deduped by ref. Rare = LOTD-wanted OR
		// enchanted OR value >= valueFloor.
		void MaybeToast(const Snapshot& s, RE::TESObjectREFR* ref, RE::TESBoundObject* obj)
		{
			if (!s.toastRare || !ref || !obj)
				return;
			const auto refId = ref->GetFormID();
			if (g_toasted.count(refId))
				return;

			const std::int32_t value = obj->GetGoldValue();
			const bool         ench = ObjEnchanted(obj);
			const bool         lotd = IsLotdWanted(obj->As<RE::TESForm>());
			const bool         valuable = value >= s.valueFloor;
			if (!lotd && !ench && !valuable)
				return;

			g_toasted.insert(refId);
			std::string tag;
			if (lotd)
				tag = "museum-wanted";
			if (ench)
				tag += tag.empty() ? "enchanted" : ", enchanted";
			if (valuable)
				tag += (tag.empty() ? "" : ", ") + std::to_string(value) + "g";
			std::string msg = "Rare find: " + NameOf(obj);
			if (!tag.empty())
				msg += " (" + tag + ")";
			RE::DebugNotification(msg.c_str());
		}

		// ------------------------------------------------------------- the take --
		// Take ONE loose world ref. `dest` (nullptr = player) is the resolved
		// destination container ref. Returns true if something was picked up.
		bool TakeLooseRef(const Snapshot& s, RE::TESObjectREFR* ref, RE::TESObjectREFR* dest)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !ref)
				return false;
			auto* obj = ref->GetBaseObject();
			if (!obj)
				return false;

			MaybeToast(s, ref, obj);

			// Activate to the player — the engine's own pickup handling (OnActivate
			// scripts, OnContainerChanged events, sound + notification, and the whole
			// placed stack + ExtraDataList move at once). ActivateRef(actioner, arg,
			// object, count, defaultProcessingOnly): mirrors mounts.cpp:415.
			ref->ActivateRef(player, 0, nullptr, 1, false);
			logger::info("auto-loot: picked '{}'", NameOf(obj));

			// Route into a marked container: pick up → forward. The item is now in
			// the player's inventory; move exactly what we took into the dest ref. A
			// plain move (no extra list, the whole current count of that base) is
			// correct because we only just added it and nothing else touched it.
			if (dest && dest != player) {
				auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; }, true);
				std::int32_t have = 0;
				for (auto& [o, data] : inv)
					if (o == obj)
						have = data.first;
				if (have > 0)
					player->RemoveItem(obj, have, RE::ITEM_REMOVE_REASON::kStoreInContainer,
						nullptr, dest);
			}
			return true;
		}

		// ------------------------------------------------- ore veins & critters --
		// How do you recognise an ore vein without hardcoding a list, and without
		// binding a Papyrus script to every reference in range?
		//
		// You ask the ENGINE what the activate prompt says. GetActivateText is a
		// virtual on every bound object and returns the very words the crosshair
		// would show — "Mine", "Catch", "Harvest" — already localized, already
		// correct for mod-added things nobody has ever heard of. SmartHarvestSE
		// does the same (its MCM ships translated regexes for these three verbs),
		// which is the strongest evidence it is the right hook.
		//
		// The cost objection is real but solved by WHERE the cache sits: the verb
		// is a property of the BASE FORM, so one call per distinct kind of thing
		// answers for every reference of it forever. A field of forty iron veins
		// costs exactly one lookup.
		enum class Verb
		{
			Other = 0,
			Mine,
			Catch
		};
		std::unordered_map<RE::FormID, Verb> g_verbCache;

		Verb VerbOf(RE::TESObjectREFR* ref, RE::TESBoundObject* base)
		{
			if (!ref || !base)
				return Verb::Other;
			const auto id = base->GetFormID();
			if (auto it = g_verbCache.find(id); it != g_verbCache.end())
				return it->second;

			Verb       v = Verb::Other;
			RE::BSString dst;
			if (base->GetActivateText(ref, dst)) {
				std::string text = LowerOf(std::string(dst.c_str() ? dst.c_str() : ""));
				// A prompt is "Mine" / "Mine Iron Ore Vein" / "Catch Butterfly",
				// sometimes behind an icon glyph, so match on containment rather
				// than equality and let the first hit win.
				if (text.find("mine") != std::string::npos)
					v = Verb::Mine;
				else if (text.find("catch") != std::string::npos)
					v = Verb::Catch;
			}
			g_verbCache.emplace(id, v);
			return v;
		}

		// Do we hold something to mine with? Vanilla has no pickaxe keyword, so
		// this resolves the known pickaxes by EditorID and otherwise falls back to
		// a name match — deliberately loose, because the cost of a false NEGATIVE
		// is "mining silently never happens", which is the worse failure. The
		// switch can be turned off if a modded pick slips through.
		bool HasPickaxe()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return false;
			const auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.GetFormType() == RE::FormType::Weapon;
			});
			for (const auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				const std::string edid = LowerOf(std::string(obj->GetFormEditorID() ? obj->GetFormEditorID() : ""));
				if (edid.find("pickaxe") != std::string::npos)
					return true;
				if (LowerOf(NameOf(obj)).find("pickaxe") != std::string::npos)
					return true;
			}
			return false;
		}

		// ----------------------------------------------------------- harvesting --
		// What will this plant give? TESFlora and TESObjectTREE both carry a
		// TESProduceForm, so the engine can answer before we touch anything — and
		// that is the whole trick: knowing the produce lets a harvest run through
		// the SAME WantsItem the loose-item path uses, so the Ingredients switch,
		// the value floors, deny/allow and the museum rule all apply with no
		// parallel rule set to keep in step.
		RE::TESBoundObject* ProduceOf(RE::TESBoundObject* base)
		{
			if (!base)
				return nullptr;
			if (auto* flora = base->As<RE::TESFlora>())
				return flora->produceItem;
			if (auto* tree = base->As<RE::TESObjectTREE>())
				return tree->produceItem;
			return nullptr;
		}

		// Already picked? The engine sets kHarvested on the REFERENCE and clears it
		// when the plant regrows, which makes it self-maintaining in a way our own
		// g_looted set is not: a session that runs past the regrowth window would
		// otherwise never harvest that plant again.
		bool AlreadyHarvested(RE::TESObjectREFR* ref)
		{
			constexpr auto kHarvested =
				static_cast<std::uint32_t>(RE::TESObjectREFR::RecordFlags::kHarvested);
			return ref && (ref->GetFormFlags() & kHarvested) != 0;
		}

		// Pick one plant. Same verb as a player pressing E, so a scripted plant
		// (Hearthfire planter, mod flora) runs its own script exactly as it would
		// by hand; then forward to the marked container the way TakeLooseRef does.
		bool HarvestRef(const Snapshot& s, RE::TESObjectREFR* ref,
			RE::TESBoundObject* produce, RE::TESObjectREFR* dest)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !ref)
				return false;

			MaybeToast(s, ref, produce);
			ref->ActivateRef(player, 0, nullptr, 1, false);
			logger::info("auto-loot: harvested '{}'", NameOf(produce));

			if (dest && dest != player && produce) {
				auto inv = player->GetInventory(
					[produce](RE::TESBoundObject& o) { return &o == produce; }, true);
				std::int32_t have = 0;
				for (auto& [o, data] : inv)
					if (o == produce)
						have = data.first;
				if (have > 0)
					player->RemoveItem(produce, have, RE::ITEM_REMOVE_REASON::kStoreInContainer,
						nullptr, dest);
			}
			return true;
		}

		// ------------------------------------------------------- corpse looting --
		// §5 / override #2: loot a dead actor's inventory into `dest` (nullptr =
		// player), deferred in its OWN task after the death grace. RemoveItem
		// (corpse→dest) per entry; skip LeveledItem stubs and any still-worn entry
		// (the equip-state hazard — log it, don't take it in this first pass).
		int LootCorpse(const Snapshot& s, RE::TESObjectREFR* corpse, RE::TESObjectREFR* dest)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !corpse)
				return 0;
			RE::TESObjectREFR* into = (dest && dest != player) ? dest : player;

			auto*                                                           changes = corpse->GetInventoryChanges();
			std::unordered_map<RE::TESBoundObject*, RE::InventoryEntryData*> entryOf;
			if (changes && changes->entryList)
				for (auto* e : *changes->entryList)
					if (e && e->object)
						entryOf[e->object] = e;

			auto inv = corpse->GetInventory();
			int  took = 0;
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				if (obj->GetFormType() == RE::FormType::LeveledItem)
					continue;  // unresolved LVLI stub
				const std::string catKey = CatKeyOf(obj);
				if (!WantsItem(s, obj, catKey))
					continue;
				// Same weight law as the loose walk — stop, don't skip: past the
				// line every further entry would be refused anyway.
				if (OverWeight(s))
					break;

				RE::InventoryEntryData* entry = nullptr;
				if (auto it = entryOf.find(obj); it != entryOf.end())
					entry = it->second;
				if (entry && entry->IsWorn()) {
					// Equip-state hazard: a worn item still parented to the actor's 3D.
					// Skip it in the first implementation — logged, not taken.
					logger::info("auto-loot: skipped worn '{}' on corpse (equip-state hazard)", NameOf(obj));
					continue;
				}
				if (s.questGuard && entry && entry->IsQuestObject())
					continue;

				MaybeToast(s, corpse, obj);
				const std::int32_t count = data.first;
				if (entry && entry->extraLists && !entry->extraLists->empty()) {
					for (auto* xl : *entry->extraLists) {
						if (!xl)
							continue;
						const std::int32_t xc = xl->GetCount() > 0 ? xl->GetCount() : 1;
						corpse->RemoveItem(obj, xc, RE::ITEM_REMOVE_REASON::kStoreInContainer, xl, into);
						took += xc;
					}
				} else {
					corpse->RemoveItem(obj, count, RE::ITEM_REMOVE_REASON::kStoreInContainer, nullptr, into);
					took += count;
				}
			}
			if (took > 0) {
				logger::info("auto-loot: picked {} from corpse '{}'", took, corpse->GetDisplayFullName());
				// The highlighter's only looted-signal is its ContainerMenu sink,
				// and we never open one — so say it in code, or this body glows
				// "dead + not yet opened" forever. Deliberately gated on took>0:
				// a corpse whose every entry was filtered out (gear off, quest
				// items, worn armour) still holds loot a hand-search would want,
				// and dropping its glow there would HIDE that.
				if (s.clearGlow) {
					const auto cid = static_cast<std::uint32_t>(corpse->GetFormID());
					LootHighlight::NoteLooted(cid);
					logger::info("auto-loot: glow cleared on corpse {:08X}", cid);
				}
			}
			return took;
		}

		// The core scan. `budget` caps takes; `outMsg`/`outPicked` optional. Called
		// on the main thread with the config already snapshotted. Returns picked.
		int RunScan(const Snapshot& s, int budget)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !player->GetParentCell())
				return 0;
			auto* tes = RE::TES::GetSingleton();
			if (!tes)
				return 0;
			// Place rules refuse the WHOLE scan before any ref is examined — one
			// test instead of thousands, and it gives the UI a single honest
			// reason for "it's on but nothing is happening here".
			if (PlaceBlock(s) != Block::None)
				return 0;

			// ---- how far this sweep actually reaches ---------------------------
			// Indoors gets its own figure when one is set: a radius that feels
			// right crossing a field reaches through three rooms in a barrow.
			const bool interior = player->GetParentCell()->IsInteriorCell();
			float      radius = s.radius;
			if (interior && s.radiusIndoors > 0)
				radius = static_cast<float>(s.radiusIndoors);

			// Door clamp: stop at the room you are in. A cheap pre-pass — the only
			// work per ref is a form-type test — and only when asked for, because
			// it is a second walk over the same refs.
			if (s.doorClamp) {
				const auto  me = player->GetPosition();
				const auto  clampStart = std::chrono::steady_clock::now();
				float       nearest = radius;
				tes->ForEachReferenceInRange(player, radius,
					[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
						// Bounded like every other walk in this file. Without this
						// the clamp was the ONE unbudgeted pass here, free to run a
						// dense exterior cell to completion every single sweep.
						// Bailing early only widens the reach for one sweep, which
						// is the harmless direction to be wrong in.
						if (std::chrono::steady_clock::now() - clampStart > kClampBudgetMs)
							return RE::BSContainer::ForEachResult::kStop;
						if (!ref || ref->IsDisabled() || ref->IsDeleted())
							return RE::BSContainer::ForEachResult::kContinue;
						auto* base = ref->GetBaseObject();
						if (!base || base->GetFormType() != RE::FormType::Door)
							return RE::BSContainer::ForEachResult::kContinue;
						const float d = me.GetDistance(ref->GetPosition());
						if (d < nearest)
							nearest = d;
						return RE::BSContainer::ForEachResult::kContinue;
					});
				radius = nearest;
			}
			// Vertical squash, so the sweep stops pulling loot through the floor
			// above. Clamped away from 0: a flat disc would drop items lying on
			// the slope you are standing on.
			const float vFactor = s.verticalFactor > 0.05f ? s.verticalFactor : 0.05f;
			const float vLimit = radius * vFactor;
			const auto  origin = player->GetPosition();

			DestResolve dr;
			if (s.dest != "player" && g_destResolver)
				dr = g_destResolver(s.dest);
			RE::TESObjectREFR* dest = dr.reachable ? dr.ref : nullptr;  // fall back to player

			g_mineStrikes.clear();  // per-sweep, see the declaration
			// HasPickaxe walks the whole inventory and builds a map, and it used
			// to run inside the per-ref lambda — once per VEIN per sweep, which a
			// field of ore turns into a real cost. Answered at most once per
			// sweep now, and lazily, so a sweep that meets no vein never pays.
			int pickaxe = -1;  // -1 not asked, 0 none, 1 have one
			const auto tickStart = std::chrono::steady_clock::now();
			int        picked = 0;
			// Corpses within range, collected during the walk and looted AFTER (a
			// deferred, own-task path — never inline in the ref walk).
			std::vector<RE::TESObjectREFR*> corpseQueue;

			tes->ForEachReferenceInRange(player, radius,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (picked >= budget ||
						std::chrono::steady_clock::now() - tickStart > kTickBudgetMs)
						return RE::BSContainer::ForEachResult::kStop;
					if (!ref || ref == player || ref->IsDisabled() || ref->IsDeleted())
						return RE::BSContainer::ForEachResult::kContinue;
					// Vertical squash: the engine hands us a sphere, so the only
					// way to stop reaching through a floor is to drop what is too
					// far off our own level.
					if (vFactor < 1.0f &&
						std::fabs(ref->GetPositionZ() - origin.z) > vLimit)
						return RE::BSContainer::ForEachResult::kContinue;

					const auto refId = ref->GetFormID();

					// Corpses: the deferred path. A dead actor that has passed the
					// death grace is queued; the grace itself is counted here.
					if (auto* actor = ref->As<RE::Actor>()) {
						if (s.corpses && actor->IsDead(false)) {
							if (g_looted.count(refId))
								return RE::BSContainer::ForEachResult::kContinue;
							// Never steal from a body either. The loose-ref walk has
							// always run OwnershipBlocks; the corpse path did NOT, so
							// looting someone you murdered in town was a crime auto-loot
							// would happily commit on your behalf. Same guard, same
							// engine crime test (IsCrimeToActivate).
							if (OwnershipBlocks(ref)) {
								g_looted.insert(refId);  // decided once, not re-tested every tick
								return RE::BSContainer::ForEachResult::kContinue;
							}
							const int ticks = ++g_deadTicks[refId];
							if (ticks >= kDeadTicks)
								corpseQueue.push_back(ref);
						}
						return RE::BSContainer::ForEachResult::kContinue;
					}

					auto* obj = ref->GetBaseObject();
					if (!obj)
						return RE::BSContainer::ForEachResult::kContinue;

					// Harvestables: plants, fungi and the harvestable trees. Their
					// own branch because the thing you gain is not the thing in the
					// world — the rules are asked about the PRODUCE, and the verb
					// is an activate on the plant.
					if (s.harvestFlora &&
						(obj->GetFormType() == RE::FormType::Flora ||
							obj->GetFormType() == RE::FormType::Tree)) {
						if (AlreadyHarvested(ref))
							return RE::BSContainer::ForEachResult::kContinue;
						auto* produce = ProduceOf(obj);
						if (!produce)
							return RE::BSContainer::ForEachResult::kContinue;  // scenery
						const std::string pKey = CatKeyOf(produce);
						if (pKey.empty() || !WantsItem(s, produce, pKey))
							return RE::BSContainer::ForEachResult::kContinue;
						// Owned crops are theft — a farm's cabbages and a Hearthfire
						// garden both come back owned, and a vacuum that made you a
						// thief for walking past would be a trap. Checked AFTER the
						// verdict, same order as the item path.
						if (OwnershipBlocks(ref))
							return RE::BSContainer::ForEachResult::kContinue;
						if (s.questGuard && IsQuestRef(ref))
							return RE::BSContainer::ForEachResult::kContinue;
						if (OverWeight(s))
							return RE::BSContainer::ForEachResult::kStop;
						// Deliberately NOT added to g_looted: kHarvested already
						// says "picked", and it clears itself when the plant
						// regrows. Marking it here would blind us to the regrowth
						// for the rest of the session.
						if (HarvestRef(s, ref, produce, dest))
							++picked;
						return RE::BSContainer::ForEachResult::kContinue;
					}

					// Ore veins and critters. Neither can be judged before the fact
					// — a vein's yield is a Papyrus property, a critter's is its
					// script — so they answer to their own switches rather than to
					// the item rules, and the verb lookup is cached per base form.
					if ((s.mineOre || s.harvestCritters) &&
						obj->GetFormType() == RE::FormType::Activator) {
						const Verb v = VerbOf(ref, obj);
						if (v == Verb::Mine && s.mineOre) {
							if (s.miningNeedsPick) {
								if (pickaxe < 0)
									pickaxe = HasPickaxe() ? 1 : 0;
								if (!pickaxe)
									return RE::BSContainer::ForEachResult::kContinue;
							}
							if (OwnershipBlocks(ref))
								return RE::BSContainer::ForEachResult::kContinue;
							// A vein yields per activation, so an uncapped sweep
							// strips it in one frame and the mining animation never
							// catches up. Count strikes per vein, per sweep.
							int& strikes = g_mineStrikes[refId];
							if (strikes >= s.maxMineStrikes)
								return RE::BSContainer::ForEachResult::kContinue;
							++strikes;
							ref->ActivateRef(player, 0, nullptr, 1, false);
							logger::info("auto-loot: mined '{}'", NameOf(obj));
							++picked;
							return RE::BSContainer::ForEachResult::kContinue;
						}
						if (v == Verb::Catch && s.harvestCritters) {
							if (g_looted.count(refId))
								return RE::BSContainer::ForEachResult::kContinue;
							if (OwnershipBlocks(ref))
								return RE::BSContainer::ForEachResult::kContinue;
							g_looted.insert(refId);  // a caught critter is gone
							ref->ActivateRef(player, 0, nullptr, 1, false);
							logger::info("auto-loot: caught '{}'", NameOf(obj));
							++picked;
							return RE::BSContainer::ForEachResult::kContinue;
						}
						// An activator that is neither is scenery — a lever, a
						// button — and must never be pressed by a loot sweep.
						return RE::BSContainer::ForEachResult::kContinue;
					}

					// Only loose ITEM forms — containers/statics/furniture skipped.
					const std::string catKey = CatKeyOf(obj);
					if (catKey.empty())
						return RE::BSContainer::ForEachResult::kContinue;
					if (g_looted.count(refId))
						return RE::BSContainer::ForEachResult::kContinue;

					// (1) the item verdict: deny > allow > allowOnly > category +
					// its gold floor. One function, shared with the corpse sweep.
					if (!WantsItem(s, obj, catKey))
						return RE::BSContainer::ForEachResult::kContinue;
					// (2) not owned / not a crime. AFTER the verdict on purpose —
					// an allow-list entry must never make auto-loot steal.
					if (OwnershipBlocks(ref))
						return RE::BSContainer::ForEachResult::kContinue;
					// (3) quest guard.
					if (s.questGuard && IsQuestRef(ref))
						return RE::BSContainer::ForEachResult::kContinue;
					// (4) carry-weight guard, re-read per take: one heavy pickup can
					// cross the line mid-walk, and a vacuum that walks you into
					// permanent over-encumbrance is a trap, not a feature.
					if (OverWeight(s))
						return RE::BSContainer::ForEachResult::kStop;

					g_looted.insert(refId);  // mark in-flight before the take
					if (TakeLooseRef(s, ref, dest))
						++picked;
					return RE::BSContainer::ForEachResult::kContinue;
				});

			// Deferred corpse looting: each in its OWN task a beat later, never
			// inline in the walk above (the post-death equip-state hazard). One take
			// counts against the budget too, so a battlefield spreads over ticks.
			// The task runs FRAMES after this walk — a raw TESObjectREFR* could be
			// freed under it if the cell detaches in between, so it carries
			// ObjectRefHandles and re-resolves; a ref that vanished simply skips.
			for (auto* corpse : corpseQueue) {
				if (picked >= budget)
					break;
				const auto refId = corpse->GetFormID();
				g_looted.insert(refId);  // once — never re-queued
				const RE::ObjectRefHandle ch = corpse->GetHandle();
				const RE::ObjectRefHandle dh =
					dest ? dest->GetHandle() : RE::ObjectRefHandle();
				SKSE::GetTaskInterface()->AddTask([s, ch, dh]() {
					const auto cptr = ch.get();
					if (!cptr)
						return;  // unloaded between queue and task — nothing to loot
					const auto dptr = dh.get();
					LootCorpse(s, cptr.get(), dptr ? dptr.get() : nullptr);
				});
				++picked;
			}

			return picked;
		}
	}

	// Place verdict for the cell the player is standing in. Precedence mirrors the
	// item rules so there is one vocabulary to learn: an explicit DENY beats
	// everything, an explicit ALLOW overrides homeGuard (so you CAN vacuum your
	// own house if you say so out loud), then exclusive mode, then homeGuard.
	// ------------------------------------------------------- population class --
	// Which of the vanilla habitation keywords does the player's current location
	// carry? Resolved by EditorID at first use (never a hardcoded FormID, so a
	// mod's own city inherits the behaviour for free just by using the vanilla
	// keywords), and the parent chain is walked because an interior inside
	// Whiterun is a location whose PARENT is the city, not a city itself.
	//
	// Returns 0 = nowhere populated, 1 = settlement, 2 = town, 3 = city. The
	// numbers are deliberately the same ordering as Snapshot::Towns, so the
	// comparison at the call site is one `>=`.
	int PopulationClass()
	{
		static RE::BGSKeyword* kwCity = nullptr;
		static RE::BGSKeyword* kwTown = nullptr;
		static RE::BGSKeyword* kwSettlement = nullptr;
		static bool            tried = false;
		if (!tried) {
			tried = true;
			kwCity = RE::TESForm::LookupByEditorID<RE::BGSKeyword>("LocTypeCity");
			kwTown = RE::TESForm::LookupByEditorID<RE::BGSKeyword>("LocTypeTown");
			kwSettlement = RE::TESForm::LookupByEditorID<RE::BGSKeyword>("LocTypeSettlement");
		}
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return 0;
		int best = 0;
		int hops = 0;  // parent chains are shallow; the cap is a cycle guard
		for (auto* loc = player->GetCurrentLocation(); loc && hops < 8; loc = loc->parentLoc, ++hops) {
			if (kwCity && loc->HasKeyword(kwCity))
				return 3;  // nothing outranks a city, so stop early
			// Plain comparisons, not std::max: Windows.h defines max() as a MACRO,
			// so `std::max(a, b)` expands to `std::(a, b)` and the compiler reports
			// an illegal token after '::' — the same trap the Pubes tab hit with
			// `small`. Never reach for std::max/std::min in this codebase.
			if (kwTown && loc->HasKeyword(kwTown)) {
				if (best < 2)
					best = 2;
			} else if (kwSettlement && loc->HasKeyword(kwSettlement)) {
				if (best < 1)
					best = 1;
			}
		}
		return best;
	}

	Block PlaceBlock(const Snapshot& s)
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Block::None;

		// Situational guards run FIRST and beat every place rule. An allow-listed
		// cell says "you may vacuum here", not "vacuum during a dragon attack",
		// and a player who went invisible did it on purpose.
		if (s.pauseInCombat && player->IsInCombat())
			return Block::Combat;
		if (s.pauseWeaponDrawn) {
			if (auto* st = player->AsActorState(); st && st->IsWeaponDrawn())
				return Block::Drawn;
		}
		if (s.pauseConcealed) {
			if (auto* avo = player->AsActorValueOwner();
				avo && avo->GetActorValue(RE::ActorValue::kInvisibility) > 0.0f)
				return Block::Concealed;
		}
		// Population guard. `townGuard` names the smallest class that is refused,
		// so anything at or above it is refused too.
		if (s.townGuard != Snapshot::Towns::Off) {
			const int here = PopulationClass();
			if (here > 0 && here >= static_cast<int>(s.townGuard))
				return Block::Populated;
		}

		auto* cell = player->GetParentCell();
		if (!cell)
			return Block::None;
		const CellId id = IdentifyCell(cell);

		if (CellListHas(s.areaDeny, id))
			return Block::AreaDenied;
		const bool allowed = CellListHas(s.areaAllow, id);
		if (allowed)
			return Block::None;
		if (s.areaAllowOnly)
			return Block::NotAllowed;
		if (s.homeGuard && PlayerOwnsCell(cell))
			return Block::Home;
		return Block::None;
	}

	std::string HereJson()
	{
		json j;
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* cell = player ? player->GetParentCell() : nullptr;
		if (!cell) {
			j["ok"] = false;
			j["msg"] = "No cell loaded yet.";
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}
		const CellId id = IdentifyCell(cell);
		if (!id.ok) {
			// A runtime/dynamic cell has no plugin to key a rule on. Say so rather
			// than storing an identity that will not survive a reload.
			j["ok"] = false;
			j["msg"] = "This place has no durable identity — it can't be given a rule.";
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}
		const char* nm = cell->GetName();
		j["ok"] = true;
		j["plugin"] = id.plugin;
		j["localId"] = id.localId;
		j["name"] = (nm && *nm) ? nm : cell->GetFormEditorID();
		j["interior"] = cell->IsInteriorCell();
		j["owned"] = PlayerOwnsCell(cell);
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	void SetConfigProvider(std::function<Snapshot()> provider) { g_provider = std::move(provider); }
	void SetDestResolver(std::function<DestResolve(const std::string&)> resolver)
	{
		g_destResolver = std::move(resolver);
	}
	void SetMasterToggler(std::function<bool()> toggler) { g_masterToggler = std::move(toggler); }

	void Init()
	{
		// Nothing engine-side to register — the save-load clear is driven from
		// main.cpp's kPostLoadGame hook (which calls ClearLootedSet), so this is a
		// marker + a placeholder for symmetry with ContainerActions/LootHighlight.
		logger::info("auto-loot: init (loose-ref vacuum ready)");
	}

	void ClearLootedSet()
	{
		g_looted.clear();
		g_deadTicks.clear();
		g_toasted.clear();
		// Keyed by base FormID, which a different load order renumbers.
		g_verbCache.clear();
		g_mineStrikes.clear();
		// TCC lists re-resolve lazily; drop the caches so a reloaded save re-reads.
		g_lotdNew = ListCache{};
		g_lotdFound = ListCache{};
		g_lotdDisp = ListCache{};
	}

	void Tick()
	{
		if (!g_provider)
			return;
		const Snapshot s = g_provider();  // provider takes the lock itself
		if (!s.enabled)
			return;
		auto* ui = RE::UI::GetSingleton();
		if (ui && ui->GameIsPaused())
			return;  // menu / inventory / console / deck open

		// Configured cadence. The poller wakes on its own fixed 500 ms clock, so
		// the interval is enforced HERE — that keeps the thread dumb (it only
		// sleeps and posts, the AddTask self-repost freeze) and means a slower
		// setting actually costs less, rather than just scanning as often and
		// throwing the result away.
		{
			auto*       player = RE::PlayerCharacter::GetSingleton();
			auto*       cell = player ? player->GetParentCell() : nullptr;
			const bool  interior = cell && cell->IsInteriorCell();
			int         want = interior && s.intervalIndoorsMs > 0 ? s.intervalIndoorsMs : s.intervalMs;
			if (want < 100)
				want = 100;  // the poller cannot go faster than 500ms anyway
			static std::chrono::steady_clock::time_point last{};
			const auto now = std::chrono::steady_clock::now();
			if (last.time_since_epoch().count() != 0 &&
				now - last < std::chrono::milliseconds(want))
				return;
			last = now;
		}

		const int picked = RunScan(s, kTakeBudget);
		g_lastPicked.store(picked);
	}

	int ScanAndLootNow(std::string* outMsg)
	{
		if (!g_provider) {
			if (outMsg)
				*outMsg = "auto-loot not initialised";
			return 0;
		}
		Snapshot s = g_provider();
		// The one-shot honours the per-category / range / dest config but NOT the
		// master switch (it's an explicit "loot around me now"). A generous budget
		// so one press clears the pile the player is standing in.
		s.enabled = true;
		// Say WHY nothing happened rather than reporting a silent zero — being
		// over the weight line looks identical to "there was nothing there".
		if (OverWeight(s)) {
			if (outMsg)
				*outMsg = "Too encumbered to loot (" + std::to_string(s.weightPct) +
						  "% of carry weight) — drop something, or turn the weight guard off";
			logger::info("auto-loot: scan-now refused — over the carry-weight guard");
			return 0;
		}
		// Place rules bind the one-shot too. A manual press that quietly vacuums
		// the house you told it to leave alone is the worse surprise; refusing
		// OUT LOUD leaves the player one obvious switch to flip.
		switch (PlaceBlock(s)) {
		case Block::Home:
			if (outMsg)
				*outMsg = "This is your own house — auto-loot leaves it alone (turn off \"Never in a home you own\" to change that)";
			logger::info("auto-loot: scan-now refused — player-owned cell");
			return 0;
		case Block::AreaDenied:
			if (outMsg)
				*outMsg = "This place is on your never-here list";
			logger::info("auto-loot: scan-now refused — cell on the never-here list");
			return 0;
		case Block::NotAllowed:
			if (outMsg)
				*outMsg = "Only-here mode is on and this place is not on the list";
			logger::info("auto-loot: scan-now refused — cell not on the only-here list");
			return 0;
		default: break;
		}
		const int picked = RunScan(s, 64);
		g_lastPicked.store(picked);
		if (outMsg)
			*outMsg = picked > 0 ? ("Picked up " + std::to_string(picked) + " item(s)")
								 : (s.allowOnly ? "Nothing nearby matched your allow list"
												: "Nothing nearby to pick up");
		logger::info("auto-loot: scan-now picked {}", picked);
		return picked;
	}

	std::string ToggleMaster()
	{
		bool enabled = false;
		if (g_masterToggler)
			enabled = g_masterToggler();  // flips g_autoLootConfig.enabled under the lock
		logger::info("auto-loot: master toggled {}", enabled ? "ON" : "OFF");
		const std::string msg =
			enabled ? "Auto-Loot ON — picking up nearby loot" : "Auto-Loot OFF";
		RE::DebugNotification(msg.c_str());
		return Dump(json{ { "ok", true }, { "enabled", enabled }, { "msg", msg } });
	}

	bool IsEnabled()
	{
		if (!g_provider)
			return false;
		return g_provider().enabled;
	}

	std::string StateJson()
	{
		json out;
		out["ok"] = true;
		if (!g_provider) {
			out["ok"] = false;
			out["msg"] = "auto-loot not initialised";
			return Dump(out);
		}
		const Snapshot s = g_provider();

		std::string destName;
		bool        destResolvable = true;  // "player" is always reachable
		if (s.dest != "player") {
			destResolvable = false;
			if (g_destResolver) {
				const auto dr = g_destResolver(s.dest);
				destName = dr.name;
				destResolvable = dr.reachable;
			}
		}

		/* Is the museum actually installed? Reported so the page can grey the
		   rule and say why, rather than offering a switch that quietly does
		   nothing on a load order without TCC. Cheap: one cached EditorID
		   lookup, and the list is not walked here. */
		out["lotdPresent"] = LotdPresent();

		/* Live place verdict, so the page can say "on, but not here — it's your
		   house" instead of showing an enabled vacuum doing nothing. */
		switch (PlaceBlock(s)) {
		case Block::Home:       out["place"] = "home"; break;
		case Block::AreaDenied: out["place"] = "denied"; break;
		case Block::NotAllowed: out["place"] = "notallowed"; break;
		case Block::Combat:     out["place"] = "combat"; break;
		case Block::Drawn:      out["place"] = "drawn"; break;
		case Block::Concealed:  out["place"] = "concealed"; break;
		case Block::Populated:  out["place"] = "populated"; break;
		default:                out["place"] = ""; break;
		}
		/* What class of place this is, so the town guard can name it rather than
		   saying a bare "populated" — "you're in a city" is the useful sentence. */
		out["population"] = PopulationClass();
		{
			auto* pl = RE::PlayerCharacter::GetSingleton();
			auto* cl = pl ? pl->GetParentCell() : nullptr;
			const char* cn = cl ? cl->GetName() : nullptr;
			out["placeName"] = (cn && *cn) ? cn : "";
		}

		out["enabled"] = s.enabled;
		out["radius"] = s.radius;
		out["dest"] = s.dest;
		out["destName"] = destName;
		out["destResolvable"] = destResolvable;
		out["lastPicked"] = g_lastPicked.load();
		out["questGuard"] = s.questGuard;
		out["toastRare"] = s.toastRare;
		out["valueFloor"] = s.valueFloor;
		out["corpses"] = s.corpses;
		out["clearGlow"] = s.clearGlow;
		out["allowOnly"] = s.allowOnly;
		out["weightGuard"] = s.weightGuard;
		out["weightPct"] = s.weightPct;
		out["overWeight"] = OverWeight(s);  // live: why the vacuum is quiet right now
		{
			json deny = json::array(), allow = json::array();
			for (const auto& e : s.deny)
				deny.push_back(json{ { "plugin", e.plugin }, { "localId", e.localId } });
			for (const auto& e : s.allow)
				allow.push_back(json{ { "plugin", e.plugin }, { "localId", e.localId } });
			out["deny"] = deny;
			out["allow"] = allow;
		}
		out["denyWords"] = s.denyWords;
		out["allowWords"] = s.allowWords;
		out["catFloors"] = s.catFloors;
		out["cats"] = json{
			{ "coins", s.coins }, { "gems", s.gems }, { "potions", s.potions },
			{ "food", s.food }, { "ingredients", s.ingredients }, { "soulgems", s.soulgems },
			{ "scrolls", s.scrolls }, { "ammo", s.ammo }, { "books", s.books },
			{ "valuables", s.valuables }, { "gear", s.gear },
			{ "keys", s.keys }, { "lockpicks", s.lockpicks },
		};
		return Dump(out);
	}

	bool IsToggleAction(const std::string& action) { return action == "auto-loot"; }
	bool IsScanNowAction(const std::string& action) { return action == "auto-loot-now"; }
}
