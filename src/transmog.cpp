// Transmog tab — runtime-restyled placeholder-ARMO pool. See transmog.h for
// the contract and the mechanism rationale.
//
// Design notes that are load-bearing:
//  - Durable identity is ALWAYS (plugin name, file-width-masked local id) —
//    the item_explorer idiom, NEVER CommonLib's GetLocalFormID() (its missing
//    null check is the 2026-08-03 actor_identity CTD).
//  - RestyleSlot mutates the pool record IN MEMORY only. Nothing is written
//    to disk; the co-save stores identity specs and kPostLoadGame replays the
//    restyles before the player can open an inventory.
//  - The instance swap mutates the REAL InventoryEntryData from
//    GetInventoryChanges()->entryList. GetInventory()'s entries are copies —
//    fine for reading (their ExtraDataList POINTERS are shared), wrong for
//    detaching a list.
//  - RemoveItem walks the whole inventory-changes list, so the proven
//    clean-bag guard (nff_control's `removeItem-prevalidated`, replicated in
//    no_auto_gear.cpp) runs before any mutation — one dead entry from an
//    uninstalled mod would otherwise freeze the game.
//  - All JSON dumps use error_handler_t::replace: display names come out of
//    arbitrary ESPs and player renames, and are not guaranteed UTF-8.

#include "transmog.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

namespace Transmog
{
	namespace
	{
		using json = nlohmann::json;

		constexpr const char*  kPlugin = "SkyManagerTransmog.esp";
		constexpr std::uint32_t kSlotBase = 0x800;
		constexpr int           kArmoSlots = 128;  // locals 0x800..0x87F
		constexpr int           kWeapSlots = 64;   // locals 0x880..0x8BF
		constexpr int           kSlots = kArmoSlots + kWeapSlots;  // pool slot i = local 0x800+i

		// 'HDTM' — explicit so no multi-char-literal portability question.
		// v2 adds slot kind + donor-absent flag + the override block; the v1
		// reader is kept (v1 never shipped, but reading it costs nothing).
		constexpr std::uint32_t kCosaveUID = 0x4844544D;
		constexpr std::uint32_t kCosaveRec = 0x4844544D;
		constexpr std::uint32_t kCosaveVersion = 2;

		// LeftHand equip slot, Skyrim.esm — so a left-hand weapon re-equips
		// into the hand it came off of (nullptr = the engine's right-hand
		// default).
		constexpr std::uint32_t kLeftHandSlotId = 0x00013F43;

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

		// ------------------------------------------------------------ specs --
		struct Spec
		{
			std::string   plugin;   // engine spelling, e.g. "Skyrim.esm"
			std::uint32_t localId = 0;

			bool empty() const { return plugin.empty(); }
		};

		std::string HexOf(std::uint32_t localId)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%06X", localId);
			return buf;
		}

		std::uint32_t ParseHex(const std::string& s)
		{
			return static_cast<std::uint32_t>(std::strtoul(s.c_str(), nullptr, 16));
		}

		// File-width mask — exactly what GetLocalFormID would do if it
		// null-checked (item_explorer.cpp precedent).
		std::optional<Spec> SpecOf(const RE::TESForm* form)
		{
			if (!form)
				return std::nullopt;
			auto* file = form->GetFile(0);
			if (!file)
				return std::nullopt;  // dynamic (0xFF…) — not durable
			Spec s;
			s.plugin = std::string(file->GetFilename());
			s.localId = form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			return s;
		}

		RE::TESObjectARMO* ResolveArmo(const Spec& s)
		{
			if (s.empty())
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::TESObjectARMO>(s.localId, s.plugin) : nullptr;
		}

		RE::TESObjectWEAP* ResolveWeap(const Spec& s)
		{
			if (s.empty())
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::TESObjectWEAP>(s.localId, s.plugin) : nullptr;
		}

		// ARMO or WEAP only — everything else answers nullptr (the two pool
		// kinds are the whole transmog surface).
		RE::TESBoundObject* ResolveBound(const Spec& s)
		{
			if (auto* a = ResolveArmo(s))
				return a;
			if (auto* w = ResolveWeap(s))
				return w;
			return nullptr;
		}

		// ------------------------------------------------------------ slots --
		enum class Kind : std::uint8_t
		{
			Armo = 0,
			Weap = 1,
		};

		const char* KindName(Kind k) { return k == Kind::Weap ? "weap" : "armo"; }

		// Per-slot stat edits — every field optional; applied LAST in the
		// restyle so they always win. Values are display units (armorRating
		// is the CK value; the record stores it x100).
		struct Overrides
		{
			std::optional<std::string>   name;
			std::optional<std::uint32_t> value;
			std::optional<float>         weight;
			std::optional<float>         armorRating;  // armo
			std::optional<std::uint16_t> damage;       // weap
			std::optional<std::uint16_t> critDamage;   // weap
			std::optional<float>         speed;        // weap
			std::optional<float>         reach;        // weap
			std::optional<float>         stagger;      // weap

			bool any() const
			{
				return name || value || weight || armorRating ||
				       damage || critDamage || speed || reach || stagger;
			}
		};

		struct Slot
		{
			Spec      stat;                 // the ORIGINAL item's base
			Spec      donor;                // whose looks it wears (empty when donorNone)
			Kind      kind = Kind::Armo;
			Overrides ov;                   // stat edits, applied last
			bool      active = false;
			bool      donorNone = false;    // stats-only: wears the ORIGINAL's own look
			bool      donorMissing = false; // donor plugin gone -> restyled to stat's own look
		};

		Slot g_slots[kSlots];

		// Pool locals are CONTIGUOUS: slot i (0..191) is local 0x800+i —
		// ARMO for i < 128, WEAP for i >= 128 (make_transmog_esp.py).
		RE::TESBoundObject* PoolBound(int i)
		{
			if (i < 0 || i >= kSlots)
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			const auto local = kSlotBase + static_cast<std::uint32_t>(i);
			if (i < kArmoSlots)
				return dh->LookupForm<RE::TESObjectARMO>(local, kPlugin);
			return dh->LookupForm<RE::TESObjectWEAP>(local, kPlugin);
		}

		bool EspPresent()
		{
			return PoolBound(0) != nullptr;
		}

		// Is this base one of OUR pool records? -> its slot index, or -1.
		int SlotIndexOf(const RE::TESForm* form)
		{
			const auto spec = SpecOf(form);
			if (!spec || Lower(spec->plugin) != Lower(kPlugin))
				return -1;
			if (spec->localId < kSlotBase || spec->localId >= kSlotBase + kSlots)
				return -1;
			return static_cast<int>(spec->localId - kSlotBase);
		}

		int FreeSlot(Kind k)
		{
			const int lo = k == Kind::Weap ? kArmoSlots : 0;
			const int hi = k == Kind::Weap ? kSlots : kArmoSlots;
			for (int i = lo; i < hi; ++i)
				if (!g_slots[i].active)
					return i;
			return -1;
		}

		// -------------------------------------------------- overrides wire --
		// The wire shape ({name, value, weight, armorRating, damage,
		// critDamage, speed, reach, stagger}, every key optional) is shared
		// by tgApply's `overrides` and tgStats' `ov`. Numbers are clamped to
		// engine-sane ranges; garbage keys are simply ignored.
		Overrides ParseOverrides(const json& j)
		{
			Overrides ov;
			if (!j.is_object())
				return ov;
			if (j.contains("name") && j["name"].is_string()) {
				auto s = j["name"].get<std::string>();
				if (!s.empty() && s.size() <= 200)
					ov.name = std::move(s);
			}
			auto num = [&](const char* k) -> std::optional<double> {
				if (j.contains(k) && j[k].is_number())
					return j[k].get<double>();
				return std::nullopt;
			};
			if (auto v = num("value"))
				ov.value = static_cast<std::uint32_t>(std::clamp(*v, 0.0, 2.0e9));
			if (auto v = num("weight"))
				ov.weight = static_cast<float>(std::clamp(*v, 0.0, 10000.0));
			if (auto v = num("armorRating"))
				ov.armorRating = static_cast<float>(std::clamp(*v, 0.0, 10000.0));
			if (auto v = num("damage"))
				ov.damage = static_cast<std::uint16_t>(std::clamp(*v, 0.0, 65535.0));
			if (auto v = num("critDamage"))
				ov.critDamage = static_cast<std::uint16_t>(std::clamp(*v, 0.0, 65535.0));
			if (auto v = num("speed"))
				ov.speed = static_cast<float>(std::clamp(*v, 0.01, 20.0));
			if (auto v = num("reach"))
				ov.reach = static_cast<float>(std::clamp(*v, 0.01, 20.0));
			if (auto v = num("stagger"))
				ov.stagger = static_cast<float>(std::clamp(*v, 0.0, 10.0));
			return ov;
		}

		json OverridesJson(const Overrides& ov)
		{
			json j = json::object();
			if (ov.name)        j["name"] = *ov.name;
			if (ov.value)       j["value"] = *ov.value;
			if (ov.weight)      j["weight"] = *ov.weight;
			if (ov.armorRating) j["armorRating"] = *ov.armorRating;
			if (ov.damage)      j["damage"] = *ov.damage;
			if (ov.critDamage)  j["critDamage"] = *ov.critDamage;
			if (ov.speed)       j["speed"] = *ov.speed;
			if (ov.reach)       j["reach"] = *ov.reach;
			if (ov.stagger)     j["stagger"] = *ov.stagger;
			return j;
		}

		// ---------------------------------------------------------- restyle --
		// In-memory only. STAT side: everything the game reads for mechanics
		// (name, biped slots + armor type so light/heavy skill stays honest,
		// rating, value, weight, keywords, base enchantment, equip slot).
		// DONOR side: everything the game reads for looks (armor addons, world
		// models, inventory icons, race gate). templateArmor is nulled so no
		// inherit chain re-fills fields behind our back. Overrides are the
		// caller's job (ApplyOverridesTo, LAST — so they win over both).
		void RestyleArmoSlot(RE::TESObjectARMO* pool, RE::TESObjectARMO* stat, RE::TESObjectARMO* donor)
		{
			if (!pool || !stat || !donor)
				return;

			pool->fullName = stat->fullName;
			pool->bipedModelData = stat->bipedModelData;   // slot mask + armor type
			pool->armorRating = stat->armorRating;
			pool->value = stat->value;
			pool->weight = stat->weight;
			pool->formEnchanting = stat->formEnchanting;   // base enchantment
			pool->amountofEnchantment = stat->amountofEnchantment;
			pool->equipSlot = stat->equipSlot;
			// Keyword array: shared pointer + count. The stat form owns the
			// storage and outlives us (forms are permanent) — the exact shape
			// the engine itself uses for template inheritance.
			pool->keywords = stat->keywords;
			pool->numKeywords = stat->numKeywords;
			pool->templateArmor = nullptr;

			// looks
			pool->armorAddons = donor->armorAddons;        // BSTArray copy-assign
			pool->race = donor->race;                      // ARMA race gating
			for (std::size_t s = 0; s < 2; ++s) {          // SEXES: kMale, kFemale
				// TESModelTextureSwap: path via the accessor pair item_icons
				// reads with; the alternate-texture swap travels as a shared
				// pointer + count (donor owns the storage, forms are permanent).
				pool->worldModels[s].SetModel(donor->worldModels[s].GetModel());
				pool->worldModels[s].alternateTextures = donor->worldModels[s].alternateTextures;
				pool->worldModels[s].numAlternateTextures = donor->worldModels[s].numAlternateTextures;
				pool->inventoryIcons[s].textureName = donor->inventoryIcons[s].textureName;
			}

			const auto ps = SpecOf(stat);
			const auto pd = SpecOf(donor);
			logger::info("transmog: restyle slot {} stat={}|{} donor={}|{}",
				SlotIndexOf(pool),
				ps ? ps->plugin : "?", ps ? HexOf(ps->localId) : "?",
				pd ? pd->plugin : "?", pd ? HexOf(pd->localId) : "?");
		}

		// The weapon twin. STAT side is EVERYTHING mechanical: the whole DNAM
		// struct rides over (anim type included, so the swing/skill/animation
		// stays the ORIGINAL's even under a cross-type donor look — a bow
		// donor on a sword stat keeps swinging like a sword), plus crit data,
		// base damage, value/weight, keywords, enchantment, equip type, the
		// attack/equip sound set, impact + block-bash data and detection
		// sound level. DONOR side is looks only: world model + texture swaps
		// + inventory icon + the 1st-person model object. Shared pointers
		// (rangedData inside weaponData, keywords, alternateTextures) follow
		// the ARMO idiom — the source form owns the storage and forms are
		// permanent. templateWeapon is nulled so no inherit chain re-fills
		// fields behind our back.
		void RestyleWeapSlot(RE::TESObjectWEAP* pool, RE::TESObjectWEAP* stat, RE::TESObjectWEAP* donor)
		{
			if (!pool || !stat || !donor)
				return;

			pool->fullName = stat->fullName;
			pool->weaponData = stat->weaponData;           // DNAM: type/speed/reach/stagger/skill/flags
			pool->criticalData = stat->criticalData;       // CRDT
			pool->attackDamage = stat->attackDamage;
			pool->value = stat->value;
			pool->weight = stat->weight;
			pool->formEnchanting = stat->formEnchanting;   // base enchantment
			pool->amountofEnchantment = stat->amountofEnchantment;
			pool->equipSlot = stat->equipSlot;
			pool->keywords = stat->keywords;
			pool->numKeywords = stat->numKeywords;
			pool->attackSound = stat->attackSound;
			pool->attackSound2D = stat->attackSound2D;
			pool->attackLoopSound = stat->attackLoopSound;
			pool->attackFailSound = stat->attackFailSound;
			pool->idleSound = stat->idleSound;
			pool->equipSound = stat->equipSound;
			pool->unequipSound = stat->unequipSound;
			pool->pickupSound = stat->pickupSound;
			pool->putdownSound = stat->putdownSound;
			pool->impactDataSet = stat->impactDataSet;
			pool->blockBashImpactDataSet = stat->blockBashImpactDataSet;
			pool->altBlockMaterialType = stat->altBlockMaterialType;
			pool->soundLevel = stat->soundLevel;
			pool->embeddedNode = stat->embeddedNode;
			pool->templateWeapon = nullptr;

			// looks
			pool->SetModel(donor->GetModel());             // TESModel path
			pool->alternateTextures = donor->alternateTextures;
			pool->numAlternateTextures = donor->numAlternateTextures;
			pool->textureName = donor->textureName;        // TESIcon
			pool->firstPersonModelObject = donor->firstPersonModelObject;  // WNAM

			const auto ps = SpecOf(stat);
			const auto pd = SpecOf(donor);
			logger::info("transmog: restyle weap slot {} stat={}|{} donor={}|{}",
				SlotIndexOf(pool),
				ps ? ps->plugin : "?", ps ? HexOf(ps->localId) : "?",
				pd ? pd->plugin : "?", pd ? HexOf(pd->localId) : "?");
		}

		// Stat overrides — applied AFTER the stat+donor copy so they always
		// win, both at apply time and at every kPostLoadGame replay. Returns
		// the number of fields applied.
		int ApplyOverridesTo(RE::TESBoundObject* poolBound, const Slot& sl, int idx)
		{
			const auto& ov = sl.ov;
			int         n = 0;
			if (auto* a = poolBound ? poolBound->As<RE::TESObjectARMO>() : nullptr) {
				if (ov.name) { a->fullName = ov.name->c_str(); ++n; }
				if (ov.value) { a->value = static_cast<std::int32_t>(*ov.value); ++n; }
				if (ov.weight) { a->weight = *ov.weight; ++n; }
				if (ov.armorRating) {
					// display units -> record units (CK value x100)
					a->armorRating = static_cast<std::uint32_t>(std::lround(*ov.armorRating * 100.0f));
					++n;
				}
			} else if (auto* w = poolBound ? poolBound->As<RE::TESObjectWEAP>() : nullptr) {
				if (ov.name) { w->fullName = ov.name->c_str(); ++n; }
				if (ov.value) { w->value = static_cast<std::int32_t>(*ov.value); ++n; }
				if (ov.weight) { w->weight = *ov.weight; ++n; }
				if (ov.damage) { w->attackDamage = *ov.damage; ++n; }
				if (ov.critDamage) { w->criticalData.damage = *ov.critDamage; ++n; }
				if (ov.speed) { w->weaponData.speed = *ov.speed; ++n; }
				if (ov.reach) { w->weaponData.reach = *ov.reach; ++n; }
				if (ov.stagger) { w->weaponData.staggerValue = *ov.stagger; ++n; }
			}
			if (n)
				logger::info("transmog: stat overrides applied - slot {} ({} field(s))", idx, n);
			return n;
		}

		// Kind-dispatched restyle of one slot's pool record: STAT copy ->
		// DONOR appearance (donor == stat when absent/gone = "keep own
		// look") -> overrides LAST.
		void RestyleSlotRecords(int i, RE::TESBoundObject* pool,
			RE::TESBoundObject* stat, RE::TESBoundObject* donor)
		{
			if (g_slots[i].kind == Kind::Weap)
				RestyleWeapSlot(pool ? pool->As<RE::TESObjectWEAP>() : nullptr,
					stat ? stat->As<RE::TESObjectWEAP>() : nullptr,
					donor ? donor->As<RE::TESObjectWEAP>() : nullptr);
			else
				RestyleArmoSlot(pool ? pool->As<RE::TESObjectARMO>() : nullptr,
					stat ? stat->As<RE::TESObjectARMO>() : nullptr,
					donor ? donor->As<RE::TESObjectARMO>() : nullptr);
			ApplyOverridesTo(pool, g_slots[i], i);
		}

		// Replay one slot from its specs. Missing donor degrades to the stat's
		// own appearance — NEVER hollow/invisible. Missing stat deactivates.
		void ReapplySlot(int i)
		{
			auto& sl = g_slots[i];
			if (!sl.active)
				return;
			auto* pool = PoolBound(i);
			if (!pool) {
				logger::warn("transmog: slot {} active but {} is not in the load order", i, kPlugin);
				return;
			}
			auto* stat = sl.kind == Kind::Weap
			                 ? static_cast<RE::TESBoundObject*>(ResolveWeap(sl.stat))
			                 : static_cast<RE::TESBoundObject*>(ResolveArmo(sl.stat));
			if (!stat) {
				logger::warn("transmog: slot {} original base {}|{} no longer resolves - slot deactivated",
					i, sl.stat.plugin, HexOf(sl.stat.localId));
				sl.active = false;
				return;
			}
			RE::TESBoundObject* donor = nullptr;
			if (sl.donorNone) {
				sl.donorMissing = false;   // stats-only: its own look, by design
			} else {
				donor = sl.kind == Kind::Weap
				            ? static_cast<RE::TESBoundObject*>(ResolveWeap(sl.donor))
				            : static_cast<RE::TESBoundObject*>(ResolveArmo(sl.donor));
				sl.donorMissing = donor == nullptr;
				if (sl.donorMissing)
					logger::warn("transmog: slot {} donor {}|{} is gone - restyled to the original's own look",
						i, sl.donor.plugin, HexOf(sl.donor.localId));
			}
			RestyleSlotRecords(i, pool, stat, donor ? donor : stat);
		}

		// ------------------------------------------------ clean-bag guard --
		// Replicated from nff_control's proven `removeItem-prevalidated`
		// guard (see no_auto_gear.cpp): RemoveItem walks the WHOLE inventory-
		// changes list, so one dead entry anywhere freezes the game.
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

		bool InventorySafeToMutate(RE::Actor* actor)
		{
			std::uint32_t bad = 0;
			return ScanInventory(actor, &bad) && bad == 0;
		}

		// ------------------------------------------------- instance access --
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

		std::int32_t TotalCountOf(RE::PlayerCharacter* player, RE::TESBoundObject* obj)
		{
			auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			for (auto& [o, data] : inv)
				if (o == obj)
					return data.first;
			return 0;
		}

		bool ListWorn(RE::ExtraDataList* xl)
		{
			return xl && (xl->HasType(RE::ExtraDataType::kWorn) ||
			              xl->HasType(RE::ExtraDataType::kWornLeft));
		}

		std::int32_t ListCount(RE::ExtraDataList* xl)
		{
			return xl ? xl->GetCount() : 1;
		}

		// "<Missing Name>" is the ENGINE's own placeholder for a form with no FULL
		// record -- GetDisplayName hands it back rather than an empty string, so a
		// plain `*dn` test lets it through and the row renders as literal
		// "<Missing Name>" (Rober's 2026-08-15 screenshot: two of them from
		// Skyrim.esm at 0 dmg / 0 value / 0 weight, i.e. engine plumbing, not
		// gear). Same family as the stranded leftovers nff_control refuses to
		// touch. Nothing here is restyleable, so it is treated as nameless and
		// the row is dropped by pushRow's own empty-name gate.
		bool EngineNoName(const char* n)
		{
			return !n || !*n || std::strcmp(n, "<Missing Name>") == 0;
		}

		std::string InstanceName(RE::ExtraDataList* xl, RE::TESBoundObject* obj)
		{
			if (xl) {
				if (const char* dn = xl->GetDisplayName(obj); !EngineNoName(dn))
					return dn;
			}
			if (const char* nm = obj ? obj->GetName() : nullptr; !EngineNoName(nm))
				return nm;
			return {};
		}

		// The ix-th extra-data list of an entry (list order = the wire order
		// ListJson emitted). nullptr when ix is out of range.
		RE::ExtraDataList* NthList(RE::InventoryEntryData* entry, int ix)
		{
			if (!entry || !entry->extraLists || ix < 0)
				return nullptr;
			int i = 0;
			for (auto* xl : *entry->extraLists) {
				if (i++ == ix)
					return xl;
			}
			return nullptr;
		}

		// Detach the ix-th list from the REAL entry so we own it across the
		// remove/add swap (RemoveItem with an attached xList + no move target
		// DESTROYS the extra data — detaching first is what preserves temper/
		// rename/player-enchant).
		//
		// BSSimpleList is a forward list with no index-erase, and its
		// const_iterator won't even instantiate for a pointer element type in
		// this CommonLibSSE-NG (begin() const feeds a `const Node*` to a ctor
		// taking `Node*`), so erase_after(const_iterator) is unreachable here.
		// Detach with only the parts that DO work: pop the first ix nodes aside,
		// take the target, and push the held ones back — front-pushes reverse,
		// so the original order is restored. pop_front frees the NODE only; the
		// held ExtraDataList* is a raw pointer, so it survives the pop.
		RE::ExtraDataList* DetachNthList(RE::InventoryEntryData* entry, int ix)
		{
			auto* ls = entry ? entry->extraLists : nullptr;
			if (!ls || ix < 0 || ls->empty())
				return nullptr;

			std::vector<RE::ExtraDataList*> held;
			held.reserve(static_cast<std::size_t>(ix));
			auto restore = [&]() {
				for (auto it = held.rbegin(); it != held.rend(); ++it)
					ls->push_front(*it);
			};

			for (int k = 0; k < ix; ++k) {
				if (ls->empty()) {   // index past the end — undo and bail
					restore();
					return nullptr;
				}
				held.push_back(ls->front());
				ls->pop_front();
			}
			if (ls->empty()) {       // nothing at ix
				restore();
				return nullptr;
			}
			RE::ExtraDataList* target = ls->front();
			ls->pop_front();
			restore();
			return target;
		}

		// ------------------------------------------------------ donor index --
		struct Donor
		{
			std::uint32_t localId;
			std::uint32_t slotMask;    // armo: biped mask · weap: unused (0)
			std::int32_t  value;
			float         weight;
			std::int32_t  wtype = -1;  // weap: DNAM anim type · armo: -1
			std::string   plugin;
			std::string   name;
			std::string   lower;       // name + plugin, the search haystack
		};

		std::vector<Donor> g_donors;       // ARMO
		std::vector<Donor> g_weapDonors;   // WEAP
		bool               g_donorsBuilt = false;
		bool               g_weapDonorsBuilt = false;

		void EnsureDonors()
		{
			if (g_donorsBuilt)
				return;
			g_donorsBuilt = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			g_donors.reserve(8192);
			for (auto* a : dh->GetFormArray<RE::TESObjectARMO>()) {
				if (!a)
					continue;
				const char* nm = a->GetName();
				if (!nm || !*nm)
					continue;                       // nameless = template junk
				if (a->formFlags & 0x04u)
					continue;                       // ARMO NonPlayable (raw bit, xEdit)
				auto* file = a->GetFile(0);
				if (!file)
					continue;                       // dynamic — not durable
				if (SlotIndexOf(a) >= 0)
					continue;                       // never offer our own pool as donors
				Donor d;
				d.localId = a->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				d.slotMask = static_cast<std::uint32_t>(a->GetSlotMask());
				d.value = a->value;
				d.weight = a->weight;
				d.plugin = std::string(file->GetFilename());
				d.name = nm;
				d.lower = Lower(d.name) + " " + Lower(d.plugin);
				g_donors.push_back(std::move(d));
			}
			logger::info("transmog: donor catalog built - {} armors", g_donors.size());
		}

		void EnsureWeapDonors()
		{
			if (g_weapDonorsBuilt)
				return;
			g_weapDonorsBuilt = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			g_weapDonors.reserve(4096);
			for (auto* w : dh->GetFormArray<RE::TESObjectWEAP>()) {
				if (!w)
					continue;
				const char* nm = w->GetName();
				if (!nm || !*nm)
					continue;                       // nameless = template junk
				if (w->formFlags & 0x04u)
					continue;                       // WEAP NonPlayable (raw record bit, xEdit)
				if (w->weaponData.flags.any(RE::TESObjectWEAP::Data::Flag::kNonPlayable))
					continue;                       // DNAM non-playable (item_explorer's check)
				if (w->weaponData.flags2.any(RE::TESObjectWEAP::Data::Flag2::kBoundWeapon))
					continue;                       // bound blades: ghost-fx summons, not gear
				auto* file = w->GetFile(0);
				if (!file)
					continue;                       // dynamic — not durable
				if (SlotIndexOf(w) >= 0)
					continue;                       // never offer our own pool as donors
				Donor d;
				d.localId = w->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				d.slotMask = 0;
				d.value = w->value;
				d.weight = w->weight;
				d.wtype = static_cast<std::int32_t>(w->GetWeaponType());
				d.plugin = std::string(file->GetFilename());
				d.name = nm;
				d.lower = Lower(d.name) + " " + Lower(d.plugin);
				g_weapDonors.push_back(std::move(d));
			}
			logger::info("transmog: weapon pool catalog built - {} weapons", g_weapDonors.size());
		}

		std::vector<std::string> Tokens(const std::string& q)
		{
			std::vector<std::string> out;
			std::string cur;
			for (char c : Lower(q)) {
				if (std::isspace(static_cast<unsigned char>(c))) {
					if (!cur.empty()) { out.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				out.push_back(cur);
			return out;
		}

		// --------------------------------------------------------- worn probe --
		bool PoolWorn(RE::PlayerCharacter* player, int slot)
		{
			auto* pool = PoolBound(slot);
			if (!pool || !player)
				return false;
			auto inv = player->GetInventory([pool](RE::TESBoundObject& o) { return &o == pool; });
			for (auto& [o, data] : inv)
				if (o == pool && data.first > 0 && data.second && data.second->IsWorn())
					return true;
			return false;
		}

		json Refuse(const std::string& msg)
		{
			return json{ { "ok", false }, { "msg", msg } };
		}

		// The stat sheet of one ARMO/WEAP record, display units — shared by
		// tgStats' `base` (original record) and `cur` (effective record).
		json StatsOf(RE::TESBoundObject* b)
		{
			if (auto* a = b ? b->As<RE::TESObjectARMO>() : nullptr)
				return json{
					{ "ar", static_cast<double>(a->armorRating) / 100.0 },
					{ "val", a->value },
					{ "wt", a->weight } };
			if (auto* w = b ? b->As<RE::TESObjectWEAP>() : nullptr)
				return json{
					{ "dmg", w->attackDamage },
					{ "crit", w->criticalData.damage },
					{ "speed", w->weaponData.speed },
					{ "reach", w->weaponData.reach },
					{ "stagger", w->weaponData.staggerValue },
					{ "val", w->value },
					{ "wt", w->weight } };
			return json::object();
		}

		// -------------------------------------------------- co-save plumbing --
		bool WriteStr(SKSE::SerializationInterface* intfc, const std::string& s)
		{
			const auto len = static_cast<std::uint16_t>(std::min<std::size_t>(s.size(), 0xFFFF));
			return intfc->WriteRecordData(&len, sizeof(len)) &&
			       (len == 0 || intfc->WriteRecordData(s.data(), len));
		}

		bool ReadStr(SKSE::SerializationInterface* intfc, std::string& out)
		{
			std::uint16_t len = 0;
			if (intfc->ReadRecordData(&len, sizeof(len)) != sizeof(len))
				return false;
			out.assign(len, '\0');
			return len == 0 || intfc->ReadRecordData(out.data(), len) == len;
		}

		// Override presence bitmask on the wire (v2) — field order fixed.
		enum : std::uint16_t
		{
			kOvName = 1 << 0,
			kOvValue = 1 << 1,
			kOvWeight = 1 << 2,
			kOvArmorRating = 1 << 3,
			kOvDamage = 1 << 4,
			kOvCritDamage = 1 << 5,
			kOvSpeed = 1 << 6,
			kOvReach = 1 << 7,
			kOvStagger = 1 << 8,
		};

		void SaveCallback(SKSE::SerializationInterface* intfc)
		{
			if (!intfc->OpenRecord(kCosaveRec, kCosaveVersion)) {
				logger::warn("transmog: cosave OpenRecord failed");
				return;
			}
			std::uint32_t count = 0;
			for (const auto& sl : g_slots)
				if (sl.active)
					++count;
			intfc->WriteRecordData(&count, sizeof(count));
			for (std::uint32_t i = 0; i < kSlots; ++i) {
				const auto& sl = g_slots[i];
				if (!sl.active)
					continue;
				intfc->WriteRecordData(&i, sizeof(i));
				const std::uint8_t kind = static_cast<std::uint8_t>(sl.kind);
				const std::uint8_t flags = sl.donorNone ? 1 : 0;
				intfc->WriteRecordData(&kind, sizeof(kind));
				intfc->WriteRecordData(&flags, sizeof(flags));
				WriteStr(intfc, sl.stat.plugin);
				intfc->WriteRecordData(&sl.stat.localId, sizeof(sl.stat.localId));
				WriteStr(intfc, sl.donor.plugin);
				intfc->WriteRecordData(&sl.donor.localId, sizeof(sl.donor.localId));
				const auto&   ov = sl.ov;
				std::uint16_t mask = 0;
				if (ov.name) mask |= kOvName;
				if (ov.value) mask |= kOvValue;
				if (ov.weight) mask |= kOvWeight;
				if (ov.armorRating) mask |= kOvArmorRating;
				if (ov.damage) mask |= kOvDamage;
				if (ov.critDamage) mask |= kOvCritDamage;
				if (ov.speed) mask |= kOvSpeed;
				if (ov.reach) mask |= kOvReach;
				if (ov.stagger) mask |= kOvStagger;
				intfc->WriteRecordData(&mask, sizeof(mask));
				if (ov.name) WriteStr(intfc, *ov.name);
				if (ov.value) intfc->WriteRecordData(&*ov.value, sizeof(std::uint32_t));
				if (ov.weight) intfc->WriteRecordData(&*ov.weight, sizeof(float));
				if (ov.armorRating) intfc->WriteRecordData(&*ov.armorRating, sizeof(float));
				if (ov.damage) intfc->WriteRecordData(&*ov.damage, sizeof(std::uint16_t));
				if (ov.critDamage) intfc->WriteRecordData(&*ov.critDamage, sizeof(std::uint16_t));
				if (ov.speed) intfc->WriteRecordData(&*ov.speed, sizeof(float));
				if (ov.reach) intfc->WriteRecordData(&*ov.reach, sizeof(float));
				if (ov.stagger) intfc->WriteRecordData(&*ov.stagger, sizeof(float));
			}
			logger::info("transmog: cosave wrote {} active slot(s)", count);
		}

		template <class T>
		bool ReadPod(SKSE::SerializationInterface* intfc, T& out)
		{
			return intfc->ReadRecordData(&out, sizeof(T)) == sizeof(T);
		}

		void LoadCallback(SKSE::SerializationInterface* intfc)
		{
			for (auto& sl : g_slots)
				sl = Slot{};
			std::uint32_t type = 0, version = 0, length = 0;
			while (intfc->GetNextRecordInfo(type, version, length)) {
				if (type != kCosaveRec) {
					logger::warn("transmog: unknown cosave record {:08X} skipped", type);
					continue;
				}
				std::uint32_t count = 0;
				if (!ReadPod(intfc, count))
					return;
				for (std::uint32_t n = 0; n < count && n < kSlots; ++n) {
					std::uint32_t idx = 0;
					Slot          sl;
					if (!ReadPod(intfc, idx))
						return;
					if (version >= 2) {
						std::uint8_t kind = 0, flags = 0;
						if (!ReadPod(intfc, kind) || !ReadPod(intfc, flags))
							return;
						sl.kind = kind == 1 ? Kind::Weap : Kind::Armo;
						sl.donorNone = (flags & 1) != 0;
					}
					if (!ReadStr(intfc, sl.stat.plugin))
						return;
					if (!ReadPod(intfc, sl.stat.localId))
						return;
					if (!ReadStr(intfc, sl.donor.plugin))
						return;
					if (!ReadPod(intfc, sl.donor.localId))
						return;
					if (version >= 2) {
						std::uint16_t mask = 0;
						if (!ReadPod(intfc, mask))
							return;
						auto& ov = sl.ov;
						if (mask & kOvName) {
							std::string s;
							if (!ReadStr(intfc, s))
								return;
							ov.name = std::move(s);
						}
						std::uint32_t u32v = 0;
						std::uint16_t u16v = 0;
						float         f32v = 0;
						if (mask & kOvValue) { if (!ReadPod(intfc, u32v)) return; ov.value = u32v; }
						if (mask & kOvWeight) { if (!ReadPod(intfc, f32v)) return; ov.weight = f32v; }
						if (mask & kOvArmorRating) { if (!ReadPod(intfc, f32v)) return; ov.armorRating = f32v; }
						if (mask & kOvDamage) { if (!ReadPod(intfc, u16v)) return; ov.damage = u16v; }
						if (mask & kOvCritDamage) { if (!ReadPod(intfc, u16v)) return; ov.critDamage = u16v; }
						if (mask & kOvSpeed) { if (!ReadPod(intfc, f32v)) return; ov.speed = f32v; }
						if (mask & kOvReach) { if (!ReadPod(intfc, f32v)) return; ov.reach = f32v; }
						if (mask & kOvStagger) { if (!ReadPod(intfc, f32v)) return; ov.stagger = f32v; }
					}
					// v1 slots (never shipped, but cheap to honor): armo,
					// donor present, no overrides — the defaults above.
					sl.active = true;
					if (idx < kSlots) {
						// belt: a WEAP-range index claiming to be armo (or
						// the reverse) would restyle the wrong record type.
						sl.kind = idx >= static_cast<std::uint32_t>(kArmoSlots) ? Kind::Weap : Kind::Armo;
						g_slots[idx] = std::move(sl);
					}
				}
				logger::info("transmog: cosave loaded {} slot spec(s) (v{})", count, version);
			}
			// Restyles happen at kPostLoadGame (OnPostLoadGame) — the load
			// callback can run before every form is attach-ready.
		}

		void RevertCallback(SKSE::SerializationInterface*)
		{
			// New game / different save incoming — the table describes the OLD
			// session. Clear it; the load callback repopulates when the new
			// save carries our record.
			for (auto& sl : g_slots)
				sl = Slot{};
			logger::info("transmog: cosave revert - slot table cleared");
		}
	}  // namespace

	// ================================================================ API ==

	void InitSerialization()
	{
		auto* ser = SKSE::GetSerializationInterface();
		if (!ser) {
			logger::error("transmog: no serialization interface - transmogs will NOT survive saves");
			return;
		}
		ser->SetUniqueID(kCosaveUID);
		ser->SetSaveCallback(SaveCallback);
		ser->SetLoadCallback(LoadCallback);
		ser->SetRevertCallback(RevertCallback);
		logger::info("transmog: cosave registered ('HDTM')");
	}

	void OnPostLoadGame()
	{
		if (!EspPresent()) {
			bool any = false;
			for (const auto& sl : g_slots)
				any = any || sl.active;
			if (any)
				logger::warn("transmog: {} missing but the save carries transmogs - "
							 "pieces will show as plain placeholder records", kPlugin);
			return;
		}
		int n = 0;
		for (int i = 0; i < kSlots; ++i)
			if (g_slots[i].active) {
				ReapplySlot(i);
				++n;
			}
		if (n)
			logger::info("transmog: reapplied {} slot(s) after load", n);
	}

	std::string StateJson()
	{
		const bool esp = EspPresent();
		auto*      player = RE::PlayerCharacter::GetSingleton();
		json       active = json::array();
		int        used = 0;
		for (int i = 0; i < kSlots; ++i) {
			const auto& sl = g_slots[i];
			if (!sl.active)
				continue;
			++used;
			auto*       stat = ResolveBound(sl.stat);
			auto*       donor = sl.donorNone ? stat : ResolveBound(sl.donor);
			const char* sn = stat ? stat->GetName() : nullptr;
			const char* dn = donor ? donor->GetName() : nullptr;
			active.push_back(json{
				{ "index", i },
				{ "kind", KindName(sl.kind) },
				{ "statName", sn && *sn ? sn : "(gone)" },
				{ "donorName", dn && *dn ? dn : "(gone)" },
				{ "stat", { { "plugin", sl.stat.plugin }, { "formId", HexOf(sl.stat.localId) } } },
				{ "donor", { { "plugin", sl.donor.plugin }, { "formId", HexOf(sl.donor.localId) } } },
				{ "worn", player ? PoolWorn(player, i) : false },
				{ "donorMissing", sl.donorMissing },
				{ "edited", sl.ov.any() },
				{ "own", sl.donorNone } });
		}
		return Dump(json{
			{ "esp", esp }, { "used", used }, { "total", kSlots }, { "active", active } });
	}

	std::string ListJson()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Dump(json{ { "ok", false }, { "msg", "No player" }, { "items", json::array() } });

		json rows = json::array();
		// Filtered GetInventory (the nff_control EquippedJson precedent) for
		// totals + bases; per-instance detail off the REAL entry's extraLists
		// so the wire `ix` is the exact index apply will re-walk.
		auto inv = player->GetInventory(
			[](RE::TESBoundObject& o) { return o.IsArmor() || o.IsWeapon(); });
		for (auto& [obj, data] : inv) {
			if (!obj || data.first <= 0)
				continue;
			const auto spec = SpecOf(obj);
			if (!spec)
				continue;   // dynamic base — not durable, not transmoggable
			auto* armo = obj->As<RE::TESObjectARMO>();
			auto* weap = armo ? nullptr : obj->As<RE::TESObjectWEAP>();
			if (!armo && !weap)
				continue;
			if (weap && weap->weaponData.flags2.any(RE::TESObjectWEAP::Data::Flag2::kBoundWeapon))
				continue;   // bound blades re-summon from their spell — nothing durable here

			const int  poolSlot = SlotIndexOf(obj);
			json       tmog = nullptr;
			if (poolSlot >= 0 && g_slots[poolSlot].active) {
				const auto& sl = g_slots[poolSlot];
				auto*       stat = ResolveBound(sl.stat);
				auto*       donor = sl.donorNone ? stat : ResolveBound(sl.donor);
				tmog = json{
					{ "slot", poolSlot },
					{ "statName", stat && stat->GetName() ? stat->GetName() : "(gone)" },
					{ "donorName", donor && donor->GetName() ? donor->GetName() : "(gone)" },
					{ "donorMissing", sl.donorMissing },
					{ "edited", sl.ov.any() },
					{ "own", sl.donorNone } };
			}

			const std::uint32_t slotMask =
				armo ? static_cast<std::uint32_t>(armo->GetSlotMask()) : 0u;
			const std::int32_t wtype =
				weap ? static_cast<std::int32_t>(weap->GetWeaponType()) : -1;
			const bool baseEnch =
				(armo && armo->formEnchanting) || (weap && weap->formEnchanting);

			// The row's live stat readout — what the ✎ editor edits, shown
			// honestly on the row (base values; skills/perks/smithing
			// multiply on top, same caveat as Proteus).
			json stats;
			if (armo) {
				stats = json{
					{ "ar", static_cast<double>(armo->armorRating) / 100.0 },
					{ "val", armo->value },
					{ "wt", armo->weight } };
			} else {
				stats = json{
					{ "dmg", weap->attackDamage },
					{ "crit", weap->criticalData.damage },
					{ "speed", weap->weaponData.speed },
					{ "reach", weap->weaponData.reach },
					{ "stagger", weap->weaponData.staggerValue },
					{ "val", weap->value },
					{ "wt", weap->weight } };
			}

			auto pushRow = [&](int ix, RE::ExtraDataList* xl, std::int32_t cnt) {
				const std::string nm = InstanceName(xl, obj);
				if (nm.empty())
					return;   // unnamed / FakeItem rows
				rows.push_back(json{
					{ "plugin", spec->plugin },
					{ "formId", HexOf(spec->localId) },
					{ "ix", ix },
					{ "name", nm },
					{ "count", cnt },
					{ "worn", ListWorn(xl) },
					{ "ench", baseEnch || (xl && xl->HasType(RE::ExtraDataType::kEnchantment)) },
					{ "kind", armo ? "armo" : "weap" },
					{ "slot", slotMask },
					{ "wtype", wtype },
					{ "stats", stats },
					{ "tmog", tmog } });
			};

			std::int32_t listed = 0;
			if (auto* entry = RealEntryFor(player, obj); entry && entry->extraLists) {
				int ix = 0;
				for (auto* xl : *entry->extraLists) {
					const auto cnt = ListCount(xl);
					pushRow(ix++, xl, cnt);
					listed += cnt;
				}
			}
			if (data.first - listed > 0)
				pushRow(-1, nullptr, data.first - listed);   // the plain remainder
		}

		// Worn first, then name — the pane leads with what is on your back.
		std::sort(rows.begin(), rows.end(), [](const json& a, const json& b) {
			const bool wa = a.value("worn", false), wb = b.value("worn", false);
			if (wa != wb)
				return wa;
			return Lower(a.value("name", std::string(""))) < Lower(b.value("name", std::string("")));
		});
		return Dump(json{ { "ok", true }, { "esp", EspPresent() }, { "items", rows } });
	}

	std::string DonorsJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		const std::string q = j.is_object() ? j.value("q", std::string("")) : std::string("");
		const std::string kind = j.is_object() ? j.value("kind", std::string("armo")) : std::string("armo");
		const std::uint32_t slotWant = j.is_object() ? j.value("slot", 0u) : 0u;
		const std::int32_t  wtypeWant = j.is_object() ? j.value("wtype", -1) : -1;
		const std::int64_t  seq = j.is_object() ? j.value("seq", 0) : 0;   // echoed: stale-reply drop
		std::size_t         limit = j.is_object() ? j.value("limit", 200u) : 200u;
		limit = std::min<std::size_t>(std::max<std::size_t>(limit, 1), 200);

		const bool wantWeap = kind == "weap";
		if (wantWeap)
			EnsureWeapDonors();
		else
			EnsureDonors();
		const auto& pool = wantWeap ? g_weapDonors : g_donors;
		const auto  toks = Tokens(q);
		json        items = json::array();
		std::size_t total = 0;
		for (const auto& d : pool) {
			if (!wantWeap && slotWant && !(d.slotMask & slotWant))
				continue;   // same-slot filter: any biped overlap counts
			if (wantWeap && wtypeWant >= 0 && d.wtype != wtypeWant)
				continue;   // same-type filter: a bow look on a sword is nonsense
			bool ok = true;
			for (const auto& t : toks)
				if (d.lower.find(t) == std::string::npos) { ok = false; break; }
			if (!ok)
				continue;
			++total;
			if (items.size() < limit) {
				json row{
					{ "plugin", d.plugin },
					{ "formId", HexOf(d.localId) },
					{ "n", d.name },
					{ "v", d.value },
					{ "w", d.weight },
					{ "slot", d.slotMask } };
				if (wantWeap)
					row["t"] = d.wtype;
				items.push_back(std::move(row));
			}
		}
		return Dump(json{ { "seq", seq }, { "total", total }, { "items", items } });
	}

	std::string ApplyJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		if (!EspPresent())
			return Dump(Refuse(std::string(kPlugin) + " isn't in your load order - tick it in MO2"));

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!player || !eqm)
			return Dump(Refuse("No player loaded"));

		const Overrides ov =
			j.contains("overrides") ? ParseOverrides(j["overrides"]) : Overrides{};

		// ---- overrides update on an ALREADY-active slot -----------------
		// {slot, overrides}: no inventory mutation — replace the override
		// block (the wire carries the full diff-vs-original, so an omitted
		// field IS a cleared field) and re-restyle the pool record in place.
		if (j.contains("slot") && j["slot"].is_number()) {
			const int slot = j.value("slot", -1);
			if (slot < 0 || slot >= kSlots || !g_slots[slot].active)
				return Dump(Refuse("That transmog isn't active any more"));
			g_slots[slot].ov = ov;
			ReapplySlot(slot);
			if (!g_slots[slot].active)
				return Dump(Refuse("The original item's mod is gone - can't touch its stats"));
			logger::info("transmog: overrides update slot {} ({})", slot,
				ov.any() ? "edited" : "cleared");
			return Dump(json{ { "ok", true },
				{ "msg", ov.any() ? "Stats updated" : "Stats back to the original's" },
				{ "slot", slot } });
		}

		Spec statSpec{ j.value("plugin", std::string("")), ParseHex(j.value("formId", std::string("0"))) };
		Spec donorSpec{ j.value("donorPlugin", std::string("")), ParseHex(j.value("donorFormId", std::string("0"))) };
		const int         ix = j.value("ix", -1);
		const std::string wantName = j.value("name", std::string(""));
		const bool        haveDonor = !donorSpec.plugin.empty();
		if (!haveDonor && !ov.any())
			return Dump(Refuse("Nothing to change"));

		auto* statBase = ResolveBound(statSpec);
		if (!statBase)
			return Dump(Refuse("That piece didn't resolve - its mod may be off"));
		if (SlotIndexOf(statBase) >= 0)
			return Dump(Refuse("That piece is already a transmog - revert it first"));
		const Kind kind = statBase->As<RE::TESObjectWEAP>() ? Kind::Weap : Kind::Armo;
		if (auto* sw = statBase->As<RE::TESObjectWEAP>();
			sw && sw->weaponData.flags2.any(RE::TESObjectWEAP::Data::Flag2::kBoundWeapon))
			return Dump(Refuse("That's a bound weapon - it re-summons from its spell "
							   "each cast, so there's nothing durable to change"));

		// Donor absent = stats-only: the piece wears its OWN look.
		RE::TESBoundObject* donor = statBase;
		if (haveDonor) {
			donor = ResolveBound(donorSpec);
			if (!donor)
				return Dump(Refuse("That look didn't resolve - its mod may be off"));
			const bool donorIsWeap = donor->As<RE::TESObjectWEAP>() != nullptr;
			if (donorIsWeap != (kind == Kind::Weap))
				return Dump(Refuse(kind == Kind::Weap
					? "A weapon can't wear an armor's look"
					: "An armor piece can't wear a weapon's look"));
		}

		const int slot = FreeSlot(kind);
		if (slot < 0)
			return Dump(Refuse(kind == Kind::Weap
				? "64 weapon transmogs active - revert one first"
				: "128 transmogs active - revert one first"));
		auto* pool = PoolBound(slot);
		if (!pool)
			return Dump(Refuse(std::string(kPlugin) + " isn't in your load order - tick it in MO2"));

		// Re-resolve the INSTANCE. The wire id is (base, ordinal ix, display
		// name); the inventory may have shifted since the list was drawn, so
		// the name is the checksum and a mismatch refuses honestly.
		auto* entry = RealEntryFor(player, statBase);
		const std::int32_t total = TotalCountOf(player, statBase);
		if (total <= 0)
			return Dump(Refuse("You aren't carrying that any more"));

		RE::ExtraDataList* xl = nullptr;
		if (ix >= 0) {
			xl = NthList(entry, ix);
			if (!xl)
				return Dump(Refuse("Your inventory shifted - reopen the list and try again"));
			const std::string nowName = InstanceName(xl, statBase);
			if (!wantName.empty() && nowName != wantName)
				return Dump(Refuse("Your inventory shifted - reopen the list and try again"));
			if (ListCount(xl) > 1)
				return Dump(Refuse("That's a stack sharing one set of extras - drop one and pick "
								   "it up so it stands alone, then transmog it"));
		} else {
			// plain remainder requested — verify one actually exists
			std::int32_t listed = 0;
			if (entry && entry->extraLists)
				for (auto* l : *entry->extraLists)
					listed += ListCount(l);
			if (total - listed <= 0)
				return Dump(Refuse("Your inventory shifted - reopen the list and try again"));
		}

		if (!InventorySafeToMutate(player))
			return Dump(Refuse("Your inventory holds a broken item from an uninstalled mod - "
							   "moving things would freeze the game (clean it with ReSaver)"));

		const bool wasWorn = ListWorn(xl);
		const bool wasWornLeft = xl && xl->HasType(RE::ExtraDataType::kWornLeft);

		// ---- the swap, one task, in order ------------------------------
		// 1) restyle the pool record so the piece never exists un-styled
		//    (slot fields FIRST — RestyleSlotRecords reads kind + overrides)
		g_slots[slot].stat = statSpec;
		g_slots[slot].donor = haveDonor ? donorSpec : Spec{};
		g_slots[slot].kind = kind;
		g_slots[slot].ov = ov;
		g_slots[slot].donorNone = !haveDonor;
		g_slots[slot].active = true;
		g_slots[slot].donorMissing = false;
		RestyleSlotRecords(slot, pool, statBase, donor);

		// 2) a worn piece comes off through the engine (clears ExtraWorn +
		//    every equip side effect the clean way)
		if (wasWorn)
			eqm->UnequipObject(player, statBase);

		// 3) detach the instance's extra list so WE own it across the swap —
		//    RemoveItem with an attached list and no move target destroys it.
		//    After the detach the instance is indistinguishable from a plain
		//    one, so removing "a plain one" removes exactly what we took.
		RE::ExtraDataList* moved = nullptr;
		if (ix >= 0) {
			moved = DetachNthList(entry, ix);
			if (!moved) {
				g_slots[slot] = Slot{};   // roll the slot back — nothing moved
				return Dump(Refuse("Your inventory shifted - reopen the list and try again"));
			}
			moved->RemoveByType(RE::ExtraDataType::kWorn);      // belt: never move a
			moved->RemoveByType(RE::ExtraDataType::kWornLeft);  // stale worn flag
		}
		player->RemoveItem(statBase, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		player->AddObjectToContainer(pool, moved, 1, nullptr);

		// 4) the re-equip IS the visual refresh (wardrobe.cpp's proven
		//    flags). A left-hand weapon goes back to the LEFT hand.
		if (wasWorn) {
			RE::BGSEquipSlot* eqSlot = nullptr;
			if (wasWornLeft && kind == Kind::Weap)
				eqSlot = RE::TESForm::LookupByID<RE::BGSEquipSlot>(kLeftHandSlotId);
			eqm->EquipObject(player, pool, nullptr, 1, eqSlot,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
		}

		const char* dn = donor->GetName();
		const char* sn = statBase->GetName();
		std::string msg;
		if (!haveDonor)
			msg = std::string(sn && *sn ? sn : "That piece") +
				" keeps its look - stats are yours now" + (wasWorn ? "" : " (in your pack)");
		else
			msg = std::string(sn && *sn ? sn : "That piece") +
				" now looks like " + (dn && *dn ? dn : "the donor") +
				(wasWorn ? "" : " (in your pack)");
		logger::info("transmog: apply slot {} kind={} stat={}|{} donor={}|{} worn={} ov={}",
			slot, KindName(kind), statSpec.plugin, HexOf(statSpec.localId),
			haveDonor ? donorSpec.plugin : "(own look)", HexOf(donorSpec.localId), wasWorn,
			ov.any());
		return Dump(json{ { "ok", true }, { "msg", msg }, { "slot", slot } });
	}

	std::string RevertJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));
		const int slot = j.value("slot", -1);
		if (slot < 0 || slot >= kSlots || !g_slots[slot].active)
			return Dump(Refuse("That transmog isn't active any more"));
		if (!EspPresent())
			return Dump(Refuse(std::string(kPlugin) + " isn't in your load order - tick it in MO2"));

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!player || !eqm)
			return Dump(Refuse("No player loaded"));

		auto* pool = PoolBound(slot);
		auto* statBase = ResolveBound(g_slots[slot].stat);
		if (!pool)
			return Dump(Refuse(std::string(kPlugin) + " isn't in your load order - tick it in MO2"));
		if (!statBase) {
			// The original's mod is gone — freeing the slot without a swap
			// would VANISH the piece; keep it honest and keep the item.
			return Dump(Refuse("The original item's mod is gone - can't restore it. "
							   "The piece stays as it looks now"));
		}

		const std::int32_t have = TotalCountOf(player, pool);
		if (have <= 0) {
			// The piece itself is gone (sold/stored elsewhere?) — the slot no
			// longer maps to anything the player holds. Free it.
			g_slots[slot] = Slot{};
			return Dump(json{ { "ok", true },
				{ "msg", "You no longer carry that piece - slot freed" }, { "slot", slot } });
		}

		if (!InventorySafeToMutate(player))
			return Dump(Refuse("Your inventory holds a broken item from an uninstalled mod - "
							   "moving things would freeze the game (clean it with ReSaver)"));

		auto*              entry = RealEntryFor(player, pool);
		RE::ExtraDataList* xl = entry ? NthList(entry, 0) : nullptr;
		const bool         wasWorn = ListWorn(xl) || (entry && entry->IsWorn());
		const bool         wasWornLeft = xl && xl->HasType(RE::ExtraDataType::kWornLeft);

		if (wasWorn)
			eqm->UnequipObject(player, pool);

		RE::ExtraDataList* moved = nullptr;
		if (xl) {
			moved = DetachNthList(entry, 0);
			if (moved) {
				moved->RemoveByType(RE::ExtraDataType::kWorn);
				moved->RemoveByType(RE::ExtraDataType::kWornLeft);
			}
		}
		player->RemoveItem(pool, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		player->AddObjectToContainer(statBase, moved, 1, nullptr);
		if (wasWorn) {
			RE::BGSEquipSlot* eqSlot = nullptr;
			if (wasWornLeft && g_slots[slot].kind == Kind::Weap)
				eqSlot = RE::TESForm::LookupByID<RE::BGSEquipSlot>(kLeftHandSlotId);
			eqm->EquipObject(player, statBase, nullptr, 1, eqSlot,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
		}

		// Slot{} clears the override block with everything else — a full
		// revert IS the original item back, stats included.
		const Spec statSpec = g_slots[slot].stat;
		g_slots[slot] = Slot{};
		const char* sn = statBase->GetName();
		logger::info("transmog: revert slot {} -> {}|{}", slot,
			statSpec.plugin, HexOf(statSpec.localId));
		return Dump(json{ { "ok", true },
			{ "msg", std::string(sn && *sn ? sn : "The piece") + " looks like itself again" },
			{ "slot", slot } });
	}

	std::string StatsJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(Refuse("Bad request"));

		int                 slot = -1;
		RE::TESBoundObject* base = nullptr;   // the ORIGINAL stat base
		RE::TESBoundObject* pool = nullptr;   // the effective record when pooled

		if (j.contains("slot") && j["slot"].is_number()) {
			slot = j.value("slot", -1);
			if (slot < 0 || slot >= kSlots || !g_slots[slot].active)
				return Dump(Refuse("That transmog isn't active any more"));
			base = ResolveBound(g_slots[slot].stat);
			pool = PoolBound(slot);
		} else {
			Spec s{ j.value("plugin", std::string("")), ParseHex(j.value("formId", std::string("0"))) };
			base = ResolveBound(s);
			if (base) {
				// A pool base sent directly resolves to its own slot.
				const int own = SlotIndexOf(base);
				if (own >= 0 && g_slots[own].active) {
					slot = own;
					pool = base;
					base = ResolveBound(g_slots[own].stat);
				}
			}
		}
		if (!base)
			return Dump(Refuse("That piece didn't resolve - its mod may be off"));
		if (auto* bw = base->As<RE::TESObjectWEAP>();
			bw && bw->weaponData.flags2.any(RE::TESObjectWEAP::Data::Flag2::kBoundWeapon))
			return Dump(Refuse("That's a bound weapon - it re-summons from its spell "
							   "each cast, so there's nothing durable to change"));

		auto*       effective = pool ? pool : base;
		const Kind  kind = base->As<RE::TESObjectWEAP>() ? Kind::Weap : Kind::Armo;
		const char* bn = base->GetName();
		const char* en = effective->GetName();

		json out{
			{ "ok", true },
			{ "kind", KindName(kind) },
			{ "slot", slot },
			{ "name", en && *en ? en : "" },
			{ "origName", bn && *bn ? bn : "" },
			{ "base", StatsOf(base) },
			{ "cur", StatsOf(effective) },
			{ "ov", slot >= 0 ? OverridesJson(g_slots[slot].ov) : json::object() } };
		return Dump(out);
	}
}
