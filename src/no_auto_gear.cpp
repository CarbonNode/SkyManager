#include "no_auto_gear.h"

#include "actor_identity.h"
#include "npc_actions.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <mutex>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace NoAutoGear
{
	namespace
	{
		using clock = std::chrono::steady_clock;
		clock::time_point g_lastTick{};

		// Sweep radius from the player, game units. Generous — a protected NPC is
		// only ever LOADED when the player is near her cell anyway, so this covers
		// "everyone currently in the world" without walking unloaded space.
		constexpr float kSweepRadius = 20000.0f;

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// The plugin that DEFINES a form. This is what a distributed cloak/underwear
		// piece resolves to regardless of which system equipped it — SPID or the
		// SkyPatcher outfit bake both leave the ARMO authored by its own mod.
		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* file = form->GetFile(0))
				return std::string(file->GetFilename());
			return "";
		}

		bool PluginMatches(const std::string& plugin, const std::vector<std::string>& list)
		{
			if (plugin.empty())
				return false;
			const std::string p = Lower(plugin);
			for (const auto& want : list)
				if (Lower(want) == p)
					return true;
			return false;
		}

		// The crosshair actor snapshotted when the palette opened — the deck's
		// established idiom (a paused menu stops the live crosshair pick updating,
		// so reading it fresh is unreliable; SnapshotTarget latches it at open).
		RE::Actor* CrosshairActor()
		{
			const std::uint32_t id = NpcActions::TargetFormID();
			if (!id)
				return nullptr;
			auto* form = RE::TESForm::LookupByID(id);
			return form ? form->As<RE::Actor>() : nullptr;
		}

		// Durable base identity of an actor. False = no base / dynamic form.
		bool IdentityOf(RE::Actor* actor, NpcRef& out)
		{
			if (!actor)
				return false;
			auto* base = actor->GetActorBase();
			if (!base)
				return false;
			const std::uint32_t local = ActorIdentity::LocalIdOf(base);
			const std::string   plugin = PluginOf(base);
			if (!local || plugin.empty())
				return false;
			out.plugin = plugin;
			out.localId = local;
			if (const char* n = actor->GetDisplayFullName(); n && *n)
				out.name = n;
			return true;
		}

		std::string KeyOf(const std::string& plugin, std::uint32_t localId)
		{
			return Lower(plugin) + "|" + std::to_string(localId);
		}

		// ---- crash-safe removal guard --------------------------------------
		// RemoveItem walks the actor's WHOLE inventory-changes list, so ONE dead
		// entry anywhere in the bag (a form left by an uninstalled mod — the
		// "<Missing Name>" case) faults the call and FREEZES the game. Our own
		// target being live is not enough. So: prove the bag is clean before
		// RemoveItem, and fall back to the slot-targeted UnequipObject (which never
		// walks the list) when it isn't. Replicated verbatim from nff_control's
		// proven `removeItem-prevalidated` guard — same law, same reason.
		static bool PageIsReadable(const void* p, std::size_t size)
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

		static bool FormIsLive(const RE::TESForm* form)
		{
			if (!PageIsReadable(form, sizeof(RE::TESForm)))
				return false;
			const auto id = form->GetFormID();
			if (!id || id == 0xFFFFFFFF)
				return false;
			return RE::TESForm::LookupByID(id) == form;
		}

		// Object-free leaf so the SEH frame below stays C2712-clean under /EHsc.
		static void ScanInventoryInner(RE::Actor* actor, std::uint32_t* bad)
		{
			auto* changes = actor->GetInventoryChanges();
			if (!changes || !changes->entryList)
				return;
			for (auto* entry : *changes->entryList)
				if (!PageIsReadable(entry, sizeof(RE::InventoryEntryData)) ||
					!FormIsLive(entry->object))
					++*bad;
		}

		static bool ScanInventory(RE::Actor* actor, std::uint32_t* bad)
		{
			__try {
				ScanInventoryInner(actor, bad);
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		// True ONLY when RemoveItem is provably safe: the scan completed AND found
		// no broken entries. A scan that itself faulted returns false (refuse).
		bool InventorySafeToRemove(RE::Actor* actor)
		{
			std::uint32_t bad = 0;
			return ScanInventory(actor, &bad) && bad == 0;
		}

		// Slot-targeted take-off — never walks the inventory, so it is safe even on
		// a broken bag. The fallback when RemoveItem would freeze.
		void SafeUnequip(RE::Actor* actor, RE::TESBoundObject* obj)
		{
			if (auto* eqm = RE::ActorEquipManager::GetSingleton(); eqm && actor && obj)
				eqm->UnequipObject(actor, obj);
		}

		// Strip EVERY distributor armor piece in this actor's inventory — worn AND
		// spare. Returns how many removed. Main thread only.
		//
		// Worn-only was the bug (proven on Amaniri, WIC): a leveled-list outfit
		// stashes several cloak/hood VARIANTS in her bag and equips one. Take that
		// one off and the engine auto-equips the next spare (Black cloak off -> Ice
		// cloak on). Removing the whole distributor set from the bag leaves nothing
		// to auto-equip; the equip-sink below then catches anything a later outfit
		// re-application adds.
		int StripActor(RE::Actor* actor, const std::vector<std::string>& plugins)
		{
			if (!actor)
				return 0;
			// GetInventory() returns a fresh snapshot map, so removing afterwards is
			// safe (we are not mutating what we iterate).
			std::vector<std::pair<RE::TESBoundObject*, std::int32_t>> doomed;
			auto inv = actor->GetInventory();
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				// Cloaks, hoods and underwear are all ARMO. Restrict to armor so a
				// distributor's non-armour token is never yanked by accident.
				if (obj->GetFormType() != RE::FormType::Armor)
					continue;
				if (!PluginMatches(PluginOf(obj), plugins))
					continue;
				doomed.emplace_back(obj, data.first);
			}
			if (doomed.empty())
				return 0;
			// Only RemoveItem when the WHOLE bag is proven clean — otherwise a dead
			// entry elsewhere would freeze the game. On a broken bag, fall back to
			// slot-safe unequip (worn pieces come off; spares stay, which the
			// equip-sink then catches without ever walking the list).
			const bool safe = InventorySafeToRemove(actor);
			for (auto& [obj, count] : doomed) {
				if (safe)
					actor->RemoveItem(obj, count, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
				else
					SafeUnequip(actor, obj);
			}
			if (!safe) {
				const char* nm = actor->GetDisplayFullName();
				logger::warn("no-auto-gear: {} has a broken inventory entry — unequipped worn distributor "
					"gear only (RemoveItem would freeze); clear the broken item with ReSaver",
					nm && *nm ? nm : "that NPC");
			}
			return static_cast<int>(doomed.size());
		}

		// Sweep every protected NPC currently loaded near the player. Returns the
		// total pieces stripped.
		int SweepRoster(const Config& cfg)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* tes = RE::TES::GetSingleton();
			if (!player || !tes || !player->GetParentCell() || cfg.npcs.empty())
				return 0;

			std::unordered_set<std::string> roster;
			roster.reserve(cfg.npcs.size() * 2);
			for (const auto& n : cfg.npcs)
				if (n.valid())
					roster.insert(KeyOf(n.plugin, n.localId));
			if (roster.empty())
				return 0;

			int stripped = 0;
			tes->ForEachReferenceInRange(player, kSweepRadius,
				[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
					if (!ref || ref->IsDisabled() || ref->IsDeleted())
						return RE::BSContainer::ForEachResult::kContinue;
					auto* actor = ref->As<RE::Actor>();
					if (!actor || actor == player)
						return RE::BSContainer::ForEachResult::kContinue;
					auto* base = actor->GetActorBase();
					if (!base)
						return RE::BSContainer::ForEachResult::kContinue;
					const std::uint32_t local = ActorIdentity::LocalIdOf(base);
					if (!local)
						return RE::BSContainer::ForEachResult::kContinue;
					if (!roster.count(KeyOf(PluginOf(base), local)))
						return RE::BSContainer::ForEachResult::kContinue;
					stripped += StripActor(actor, cfg.plugins);
					return RE::BSContainer::ForEachResult::kContinue;
				});
			return stripped;
		}

		json RefToJson(const NpcRef& n)
		{
			return json{
				{ "plugin", n.plugin },
				{ "localId", ActorIdentity::HexOf(n.localId) },
				{ "name", n.name } };
		}

		bool Contains(const Config& cfg, const std::string& plugin, std::uint32_t localId)
		{
			const std::string key = KeyOf(plugin, localId);
			for (const auto& n : cfg.npcs)
				if (KeyOf(n.plugin, n.localId) == key)
					return true;
			return false;
		}

		// ---- live cache for the equip-event sink -----------------------------
		// The sink fires on the game thread and must NOT take g_configMutex (it
		// lives in main.cpp), so the roster + plugin list are mirrored here and
		// refreshed whenever the config changes (Tick, every ~1s, and on tag). This
		// is a leaf lock — never taken while g_configMutex is held the other way.
		std::mutex                      g_cacheMtx;
		std::unordered_set<std::string> g_rosterKeys;
		std::vector<std::string>        g_pluginsCache;
		bool                            g_enabledCache = false;

		void RefreshCache(const Config& c)
		{
			std::lock_guard l(g_cacheMtx);
			g_enabledCache = c.enabled;
			g_pluginsCache = c.plugins;
			g_rosterKeys.clear();
			for (const auto& n : c.npcs)
				if (n.valid())
					g_rosterKeys.insert(KeyOf(n.plugin, n.localId));
		}

		// Fires the instant any actor equips anything. For a protected NPC that
		// equips a distributor ARMO, remove it next tick. THIS is what beats the
		// outfit leveled-list re-roll that one-shot removal could never win: an
		// outfit re-application on a cell load rolls a fresh cloak/hood variant and
		// equips it -> this sees the equip and removes it before it settles, for
		// every variant, forever. No flicker, no whack-a-mole.
		class EquipSink : public RE::BSTEventSink<RE::TESEquipEvent>
		{
		public:
			static EquipSink* GetSingleton()
			{
				static EquipSink s;
				return &s;
			}

			RE::BSEventNotifyControl ProcessEvent(const RE::TESEquipEvent* ev,
				RE::BSTEventSource<RE::TESEquipEvent>*) override
			{
				if (!ev || !ev->equipped)
					return RE::BSEventNotifyControl::kContinue;
				{
					std::lock_guard l(g_cacheMtx);
					if (!g_enabledCache || g_rosterKeys.empty())
						return RE::BSEventNotifyControl::kContinue;
				}
				auto* actor = ev->actor ? ev->actor->As<RE::Actor>() : nullptr;
				if (!actor)
					return RE::BSEventNotifyControl::kContinue;
				auto* base = actor->GetActorBase();
				if (!base)
					return RE::BSEventNotifyControl::kContinue;
				const std::uint32_t local = ActorIdentity::LocalIdOf(base);
				if (!local)
					return RE::BSEventNotifyControl::kContinue;
				const std::string akey = KeyOf(PluginOf(base), local);
				std::vector<std::string> plugins;
				{
					std::lock_guard l(g_cacheMtx);
					if (!g_rosterKeys.count(akey))
						return RE::BSEventNotifyControl::kContinue;
					plugins = g_pluginsCache;
				}
				auto* obj = RE::TESForm::LookupByID(ev->baseObject);
				if (!obj || obj->GetFormType() != RE::FormType::Armor)
					return RE::BSEventNotifyControl::kContinue;
				auto* bound = obj->As<RE::TESBoundObject>();
				if (!bound || !PluginMatches(PluginOf(obj), plugins))
					return RE::BSEventNotifyControl::kContinue;
				// Remove NEXT tick — mutating inventory inside the equip event is
				// re-entrant and unsafe. kRemove so the leveled list cannot re-equip
				// THIS instance; a later re-roll is a fresh equip event we also catch.
				const RE::ActorHandle ah = actor->GetHandle();
				SKSE::GetTaskInterface()->AddTask([ah, bound]() {
					auto a = ah.get();
					if (!a || !bound)
						return;
					// Same crash guard: RemoveItem only on a provably-clean bag; the
					// item was just equipped, so slot-safe unequip is the correct
					// fallback (takes it back off without walking the list).
					if (InventorySafeToRemove(a.get()))
						a->RemoveItem(bound, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
					else
						SafeUnequip(a.get(), bound);
				});
				return RE::BSEventNotifyControl::kContinue;
			}
		};
	}  // namespace

	// ------------------------------------------------------------- lifecycle

	void Init()
	{
		g_lastTick = clock::time_point{};
		// Build marker (hd-markers.json: "no-auto-gear"). Unconditional so it is
		// REACHED every launch.
		logger::info("no-auto-gear: armed (strips distributor cloaks/hoods/underwear from protected NPCs)");
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton()) {
			holder->AddEventSink<RE::TESEquipEvent>(EquipSink::GetSingleton());
			// Build marker (hd-markers.json: "no-auto-gear-equipsink").
			logger::info("no-auto-gear: equip-sink armed (removes distributor gear the tick a protected NPC equips it)");
		} else {
			logger::error("no-auto-gear: no ScriptEventSourceHolder — equip-sink OFF (tick-only)");
		}
	}

	// ----------------------------------------------------------- persistence

	json ToJson(const Config& c)
	{
		json npcs = json::array();
		for (const auto& n : c.npcs)
			if (n.valid())
				npcs.push_back(RefToJson(n));
		json plugins = json::array();
		for (const auto& p : c.plugins)
			plugins.push_back(p);
		return json{
			{ "enabled", c.enabled },
			{ "notify", c.notify },
			{ "tickMs", c.tickMs },
			{ "npcs", npcs },
			{ "plugins", plugins } };
	}

	void FromJson(const json& j, Config& out)
	{
		Config c;
		c.plugins.clear();
		if (j.is_object()) {
			c.enabled = j.value("enabled", true);
			c.notify = j.value("notify", false);
			c.tickMs = std::clamp(j.value("tickMs", 5000u), 1000u, 60000u);
			if (j.contains("npcs") && j["npcs"].is_array()) {
				for (const auto& jn : j["npcs"]) {
					if (!jn.is_object())
						continue;
					NpcRef n;
					n.plugin = jn.value("plugin", std::string(""));
					n.localId = ActorIdentity::ParseHex(jn.value("localId", std::string("")));
					n.name = jn.value("name", std::string(""));
					if (n.valid())
						c.npcs.push_back(std::move(n));
				}
			}
			if (j.contains("plugins") && j["plugins"].is_array()) {
				for (const auto& jp : j["plugins"])
					if (jp.is_string() && !jp.get<std::string>().empty())
						c.plugins.push_back(jp.get<std::string>());
			}
		}
		// Never leave the distributor list empty — a blank/stale config still
		// strips the three live defaults. (Same spirit as loot re-seeding cats.)
		if (c.plugins.empty()) {
			Config def;
			c.plugins = def.plugins;
		}
		out = std::move(c);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		const auto j = json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;
		Config merged;
		FromJson(j, merged);
		cfg = std::move(merged);
		return true;
	}

	// --------------------------------------------------------- view payloads

	std::string OpenJson(const Config& c)
	{
		return Dump(ToJson(c));
	}

	std::string StateJson(const Config& c)
	{
		json out{ { "ok", true }, { "count", static_cast<int>(c.npcs.size()) } };
		if (auto* actor = CrosshairActor()) {
			NpcRef me;
			if (IdentityOf(actor, me)) {
				out["lookingAt"] = me.name;
				out["protected"] = Contains(c, me.plugin, me.localId);
			}
		}
		return Dump(out);
	}

	// ------------------------------------------------------------ operations

	std::string ToggleCrosshair(Config& cfg)
	{
		auto* actor = CrosshairActor();
		if (!actor)
			return Dump(json{ { "ok", false }, { "msg", "Look at someone first" } });
		NpcRef me;
		if (!IdentityOf(actor, me))
			return Dump(json{ { "ok", false }, { "msg", "That one has no durable identity" } });

		const std::string key = KeyOf(me.plugin, me.localId);
		auto it = std::find_if(cfg.npcs.begin(), cfg.npcs.end(),
			[&](const NpcRef& n) { return KeyOf(n.plugin, n.localId) == key; });

		bool nowProtected;
		std::string msg;
		if (it != cfg.npcs.end()) {
			cfg.npcs.erase(it);
			nowProtected = false;
			msg = me.name + " — auto-gear allowed again";
		} else {
			cfg.npcs.push_back(me);
			nowProtected = true;
			const int n = StripActor(actor, cfg.plugins);  // immediate effect
			msg = "🚫 " + me.name + " protected" + (n ? " (" + std::to_string(n) + " stripped)" : "");
		}
		if (cfg.notify)
			RE::DebugNotification(msg.c_str());
		logger::info("no-auto-gear: {} {} ({}|{:X})", nowProtected ? "PROTECT" : "unprotect",
			me.name, me.plugin, me.localId);
		RefreshCache(cfg);  // the equip-sink starts guarding her THIS instant, not on the next tick
		return Dump(json{ { "ok", true }, { "msg", msg }, { "protected", nowProtected },
			{ "name", me.name }, { "count", static_cast<int>(cfg.npcs.size()) } });
	}

	std::string ProtectParty(Config& cfg)
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* tes = RE::TES::GetSingleton();
		if (!player || !tes || !player->GetParentCell())
			return Dump(json{ { "ok", false }, { "msg", "Not in the world" } });

		int added = 0, stripped = 0;
		tes->ForEachReferenceInRange(player, kSweepRadius,
			[&](RE::TESObjectREFR* ref) -> RE::BSContainer::ForEachResult {
				if (!ref || ref->IsDisabled() || ref->IsDeleted())
					return RE::BSContainer::ForEachResult::kContinue;
				auto* actor = ref->As<RE::Actor>();
				if (!actor || actor == player || !actor->IsPlayerTeammate())
					return RE::BSContainer::ForEachResult::kContinue;
				NpcRef me;
				if (!IdentityOf(actor, me))
					return RE::BSContainer::ForEachResult::kContinue;
				if (!Contains(cfg, me.plugin, me.localId)) {
					cfg.npcs.push_back(me);
					++added;
					stripped += StripActor(actor, cfg.plugins);
				}
				return RE::BSContainer::ForEachResult::kContinue;
			});
		const std::string msg = added
			? "🚫 Protected " + std::to_string(added) + " follower(s)"
			: "Everyone with you is already protected";
		if (cfg.notify)
			RE::DebugNotification(msg.c_str());
		logger::info("no-auto-gear: protect-party added {} ({} stripped)", added, stripped);
		RefreshCache(cfg);
		return Dump(json{ { "ok", true }, { "msg", msg }, { "added", added },
			{ "count", static_cast<int>(cfg.npcs.size()) } });
	}

	std::string SweepNow(Config& cfg)
	{
		const int n = SweepRoster(cfg);
		g_lastTick = clock::now();
		const std::string msg = "Swept — " + std::to_string(n) + " piece(s) removed";
		if (cfg.notify)
			RE::DebugNotification(msg.c_str());
		return Dump(json{ { "ok", true }, { "msg", msg }, { "stripped", n } });
	}

	// ------------------------------------------------------------- the tick

	bool Tick(Config& cfg)
	{
		RefreshCache(cfg);  // keep the equip-sink's mirror <=1s fresh (runs before the early-out)
		if (!cfg.enabled || cfg.npcs.empty())
			return false;
		const auto now = clock::now();
		if (now - g_lastTick < std::chrono::milliseconds(cfg.tickMs))
			return false;
		g_lastTick = now;

		auto* ui = RE::UI::GetSingleton();
		if (ui && ui->GameIsPaused())  // deck/menu open — nothing to do
			return false;
		SweepRoster(cfg);
		return false;  // stateless: never mutates cfg
	}

	void OnPostLoadGame(Config& cfg)
	{
		// A load just re-ran the distributors; strip before the player sees it.
		// (Actors are still attaching as kPostLoadGame fires, so the periodic tick
		// mops up any that arrive a beat later — g_lastTick reset makes it immediate.)
		g_lastTick = clock::time_point{};
		if (cfg.enabled && !cfg.npcs.empty())
			SweepRoster(cfg);
	}
}
