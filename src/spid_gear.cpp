#include "spid_gear.h"

#include "actor_identity.h"

#include <algorithm>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>

// pch (force-included) provides RE::/SKSE::/json/logger and std::literals.

using json = nlohmann::json;

namespace SpidGear
{
	namespace
	{
		// The inbox chest base: Skyrim.esm "UnownedChest" — byte-verified against
		// the ESM on 2026-08-09 (CONT scan: zero CNTO items, DATA respawn bit
		// clear, standard Chest01 model). Fallbacks are equally verified empty
		// non-respawning bases, in case an overhaul gutted the first record.
		constexpr RE::FormID kChestCandidates[] = {
			0x000EA299,  // UnownedChest
			0x000D762F,  // MGHoldingChest
			0x000A0DB5,  // MQ201PlayerContainerNoResetNEW
		};

		// ContainerMenu::ContainerMode::kLoot — same transfer view the
		// Containers tab opens (see container_actions.cpp kOpenLoot).
		constexpr std::int32_t kOpenLoot = 0;

		// How far below the player the chest is parked. Same trick as the room
		// visualizer's hide park: the ref stays in a LOADED cell (so the menu
		// can open on it) but its 3D sits under the floor where nobody sees it.
		constexpr float kParkDrop = 2000.0f;

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

		std::string KeyOf(const std::string& plugin, std::uint32_t localId)
		{
			return Lower(plugin) + "|" + std::to_string(localId);
		}

		// --- session state (main thread only) ---------------------------------
		RE::FormID    g_chest = 0;       // session inbox chest (dynamic ref — never persisted)
		bool          g_armed = false;   // a harvest is pending on ContainerMenu close
		bool          g_harvestReady = false;  // set by the sink, consumed by main.cpp's callback
		Npc           g_pendingNpc;      // who the open inbox is about
		std::uint32_t g_pendingRuntime = 0;

		std::function<void()> g_onHarvest;

		// Durable base identity of an actor (ActorBase, not the reference —
		// SPID filters match the base, and the base is what survives respawns).
		bool IdentityOf(RE::Actor* actor, Npc& out)
		{
			if (!actor)
				return false;
			auto* base = actor->GetActorBase();
			if (!base)
				return false;
			std::string id, plugin;
			if (!ActorIdentity::DurableOf(base, id, plugin))
				return false;
			out.plugin = plugin;
			out.localId = ActorIdentity::ParseHex(id);
			if (const char* n = actor->GetDisplayFullName(); n && *n)
				out.name = n;
			return out.valid();
		}

		RE::TESObjectREFR* ChestRef()
		{
			if (!g_chest)
				return nullptr;
			auto* ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(g_chest);
			// A dynamic id from BEFORE a save load can resolve to something
			// unrelated — OnPostLoadGame zeroes g_chest, so anything resolving
			// here was placed this session. Still verify it is a container.
			if (!ref || !ref->GetContainer()) {
				g_chest = 0;
				return nullptr;
			}
			return ref;
		}

		void ParkChest(RE::TESObjectREFR* chest, RE::PlayerCharacter* player)
		{
			if (!chest || !player)
				return;
			auto pos = player->GetPosition();
			pos.z -= kParkDrop;
			chest->SetPosition(pos);
			chest->Update3DPosition(true);
		}

		RE::TESObjectREFR* EnsureChest(RE::PlayerCharacter* player)
		{
			if (auto* ref = ChestRef())
				return ref;
			RE::TESBoundObject* base = nullptr;
			for (const auto id : kChestCandidates) {
				base = RE::TESForm::LookupByID<RE::TESBoundObject>(id);
				if (base)
					break;
			}
			if (!base) {
				logger::error("spid-gear: no chest base resolved (UnownedChest & fallbacks missing?)");
				return nullptr;
			}
			auto ptr = player->PlaceObjectAtMe(base, true);
			if (!ptr) {
				logger::error("spid-gear: PlaceObjectAtMe(chest) returned null");
				return nullptr;
			}
			g_chest = ptr->GetFormID();
			ParkChest(ptr.get(), player);
			logger::info("spid-gear: inbox chest placed ({:08X})", g_chest);
			return ptr.get();
		}

		// Hand everything in the chest back to the player. Recording (or not)
		// already happened — this is the "the chest holds nothing between
		// uses" invariant, and it doubles as crash recovery: items stranded by
		// a mid-menu crash come home at the next open instead of vanishing.
		int FlushChestToPlayer(RE::TESObjectREFR* chest, RE::PlayerCharacter* player)
		{
			if (!chest || !player)
				return 0;
			std::vector<std::pair<RE::TESBoundObject*, std::int32_t>> held;
			auto inv = chest->GetInventory();
			for (auto& [obj, data] : inv)
				if (obj && data.first > 0)
					held.emplace_back(obj, data.first);
			for (auto& [obj, count] : held)
				chest->RemoveItem(obj, count, RE::ITEM_REMOVE_REASON::kStoreInContainer,
					nullptr, player);
			return static_cast<int>(held.size());
		}

		Npc* FindNpc(Config& cfg, const std::string& plugin, std::uint32_t localId)
		{
			const auto key = KeyOf(plugin, localId);
			for (auto& n : cfg.npcs)
				if (KeyOf(n.plugin, n.localId) == key)
					return &n;
			return nullptr;
		}

		Item* FindItem(Npc& n, const std::string& plugin, std::uint32_t localId)
		{
			const auto key = KeyOf(plugin, localId);
			for (auto& it : n.items)
				if (KeyOf(it.plugin, it.localId) == key)
					return &it;
			return nullptr;
		}

		json ItemToJson(const Item& it)
		{
			return json{
				{ "plugin", it.plugin },
				{ "localId", ActorIdentity::HexOf(it.localId) },
				{ "name", it.name },
				{ "count", it.count },
				{ "chance", it.chance },
				{ "when", it.when },
				{ "enabled", it.enabled } };
		}

		// Today, as "YYYY-MM-DD" — the grant history stamp. Wall clock, not game
		// time: "when did I set this up" is a player question, not a lore one.
		std::string Today()
		{
			const std::time_t t = std::time(nullptr);
			std::tm           tm{};
			localtime_s(&tm, &t);
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d",
				tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
			return buf;
		}

		// The transfer menu closing on OUR inbox. Narrow like the Containers
		// sink: acts only while armed and only on a ContainerMenu CLOSE. The
		// heavy lifting hops through the harvest callback so config mutation
		// and persistence happen where the mutex lives (main.cpp).
		class MenuSink : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (ev && !ev->opening && g_armed &&
					ev->menuName == RE::ContainerMenu::MENU_NAME) {
					g_armed = false;
					g_harvestReady = true;
					if (g_onHarvest) {
						// AddTask: run on the main thread, next frame, outside
						// the menu teardown we are being notified from.
						SKSE::GetTaskInterface()->AddTask([]() {
							if (g_onHarvest)
								g_onHarvest();
						});
					}
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		MenuSink g_menuSink;
	}  // namespace

	void Init(std::function<void()> onHarvest)
	{
		g_onHarvest = std::move(onHarvest);
		g_chest = 0;
		g_armed = false;
		g_harvestReady = false;
		g_pendingRuntime = 0;
		if (auto* ui = RE::UI::GetSingleton())
			ui->AddEventSink<RE::MenuOpenCloseEvent>(&g_menuSink);
		// Build marker (hd-markers.json: "spid-gear"). Unconditional — reached
		// on every launch.
		logger::info("spid-gear: armed (inbox chest -> per-NPC SPID ini, F7 card)");
	}

	void OnPostLoadGame()
	{
		// The chest is a dynamic (0xFF……) ref — its id is meaningless across a
		// save load and could resolve to something unrelated. Drop it; the next
		// open places a fresh one. An armed harvest died with the old world too.
		g_chest = 0;
		g_armed = false;
		g_harvestReady = false;
	}

	// ------------------------------------------------------------- persistence

	json ToJson(const Config& c)
	{
		json npcs = json::array();
		for (const auto& n : c.npcs) {
			if (!n.valid())
				continue;
			json items = json::array();
			for (const auto& it : n.items)
				if (it.valid())
					items.push_back(ItemToJson(it));
			npcs.push_back(json{
				{ "plugin", n.plugin },
				{ "localId", ActorIdentity::HexOf(n.localId) },
				{ "name", n.name },
				{ "enabled", n.enabled },
				{ "items", items } });
		}
		return json{ { "npcs", npcs } };
	}

	void FromJson(const json& j, Config& out)
	{
		Config c;
		if (j.is_object() && j.contains("npcs") && j["npcs"].is_array()) {
			for (const auto& jn : j["npcs"]) {
				if (!jn.is_object())
					continue;
				Npc n;
				n.plugin = jn.value("plugin", std::string(""));
				n.localId = ActorIdentity::ParseHex(jn.value("localId", std::string("")));
				n.name = jn.value("name", std::string(""));
				// Absent in configs written before 2026-08-11 — an old save's
				// grants must come back ON, never silently muted.
				n.enabled = jn.value("enabled", true);
				if (jn.contains("items") && jn["items"].is_array()) {
					for (const auto& ji : jn["items"]) {
						if (!ji.is_object())
							continue;
						Item it;
						it.plugin = ji.value("plugin", std::string(""));
						it.localId = ActorIdentity::ParseHex(ji.value("localId", std::string("")));
						it.name = ji.value("name", std::string(""));
						it.count = std::clamp(ji.value("count", 1), 1, 999);
						it.chance = std::clamp(ji.value("chance", 100), 1, 100);
						it.when = ji.value("when", std::string(""));
						it.enabled = ji.value("enabled", true);
						if (it.valid())
							n.items.push_back(std::move(it));
					}
				}
				if (n.valid())
					c.npcs.push_back(std::move(n));
			}
		}
		out = std::move(c);
	}

	// ----------------------------------------------------------- view payloads

	std::string StateJson(const Config& c, std::uint32_t runtimeFormId)
	{
		json out;
		out["ok"] = true;
		out["present"] = true;  // no external mod needed — the DLL answering IS the gate
		out["formId"] = runtimeFormId;
		out["ini"] = "HotkeyDeckGear_DISTR.ini";

		auto* form = runtimeFormId ? RE::TESForm::LookupByID(runtimeFormId) : nullptr;
		auto* actor = form ? form->As<RE::Actor>() : nullptr;
		Npc   who;
		if (!IdentityOf(actor, who)) {
			out["ok"] = false;
			out["msg"] = "No durable identity - a spawned copy can't take SPID gear";
			return Dump(out);
		}
		out["name"] = who.name;
		out["npcPlugin"] = who.plugin;
		out["npcLocalId"] = ActorIdentity::HexOf(who.localId);

		json items = json::array();
		// const_cast-free lookup: linear scan, the list is small.
		const auto key = KeyOf(who.plugin, who.localId);
		for (const auto& n : c.npcs) {
			if (KeyOf(n.plugin, n.localId) != key)
				continue;
			for (const auto& it : n.items)
				if (it.valid())
					items.push_back(ItemToJson(it));
			break;
		}
		out["items"] = items;
		return Dump(out);
	}

	std::string AllJson(const Config& c)
	{
		json npcs = json::array();
		int  liveLines = 0;   // how many lines the ini will actually carry
		for (const auto& n : c.npcs) {
			if (!n.valid() || n.items.empty())
				continue;
			json items = json::array();
			int  on = 0;
			for (const auto& it : n.items) {
				if (!it.valid())
					continue;
				items.push_back(ItemToJson(it));
				if (it.enabled)
					++on;
			}
			if (n.enabled)
				liveLines += on;
			npcs.push_back(json{
				{ "plugin", n.plugin },
				{ "localId", ActorIdentity::HexOf(n.localId) },
				{ "name", n.name },
				{ "enabled", n.enabled },
				// Counted here so the card never has to re-derive it: `on` is
				// how many of her grants are ticked, `live` how many actually
				// reach the ini (zero for a disabled NPC, however many of her
				// own rows are ticked).
				{ "on", on },
				{ "live", n.enabled ? on : 0 },
				{ "items", items } });
		}
		return Dump(json{ { "ok", true }, { "npcs", npcs }, { "lines", liveLines },
			{ "ini", "HotkeyDeckGear_DISTR.ini" } });
	}

	// ------------------------------------------------------------------ inbox

	std::string OpenInbox(std::uint32_t runtimeFormId)
	{
		json out;
		out["ok"] = false;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player) {
			out["msg"] = "No player reference";
			return Dump(out);
		}
		auto* form = runtimeFormId ? RE::TESForm::LookupByID(runtimeFormId) : nullptr;
		auto* actor = form ? form->As<RE::Actor>() : nullptr;
		Npc   who;
		if (!IdentityOf(actor, who)) {
			out["msg"] = "She has no durable identity - SPID can't target a spawned copy";
			return Dump(out);
		}

		auto* chest = EnsureChest(player);
		if (!chest) {
			out["msg"] = "Couldn't conjure the inbox chest (see HotkeyDeck.log)";
			return Dump(out);
		}

		// Crash recovery + base-contents belt: anything already inside goes
		// back to the player BEFORE the menu opens, unrecorded.
		if (const int stranded = FlushChestToPlayer(chest, player))
			logger::info("spid-gear: returned {} stranded stack(s) from the inbox", stranded);

		g_pendingNpc = who;
		g_pendingRuntime = runtimeFormId;
		g_armed = true;

		// Attempt A — open where it is parked (the player's cell is loaded, so
		// this is expected to work). Attempt B — one frame later, if no menu
		// came up, bring it to the player and open on the frame after (same
		// two-step as ContainerActions::OpenContainer; it re-parks on harvest).
		chest->InitInventoryIfRequired();
		chest->OpenContainer(kOpenLoot);
		const RE::FormID cid = g_chest;
		SKSE::GetTaskInterface()->AddTask([cid]() {
			auto* ui = RE::UI::GetSingleton();
			if (ui && ui->IsMenuOpen(RE::ContainerMenu::MENU_NAME))
				return;
			auto* c = RE::TESForm::LookupByID<RE::TESObjectREFR>(cid);
			auto* pl = RE::PlayerCharacter::GetSingleton();
			if (!c || !pl)
				return;
			c->MoveTo(pl);
			SKSE::GetTaskInterface()->AddTask([cid]() {
				auto* c2 = RE::TESForm::LookupByID<RE::TESObjectREFR>(cid);
				if (!c2)
					return;
				c2->InitInventoryIfRequired();
				c2->OpenContainer(kOpenLoot);
			});
			logger::info("spid-gear: parked open failed - summoned inbox to the player");
		});

		out["ok"] = true;
		out["msg"] = "Drop what " + who.name + " should always have, then close the chest";
		logger::info("spid-gear: inbox open for {} ({}|{:X})", who.name, who.plugin, who.localId);
		return Dump(out);
	}

	bool HarvestPending() { return g_harvestReady; }

	std::uint32_t PendingRuntimeId() { return g_pendingRuntime; }

	std::string Harvest(Config& cfg)
	{
		g_harvestReady = false;
		json out;
		out["ok"] = false;
		out["formId"] = g_pendingRuntime;

		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* chest = ChestRef();
		if (!player || !chest || !g_pendingNpc.valid()) {
			out["msg"] = "Inbox vanished before it could be read";
			return Dump(out);
		}

		int added = 0, skipped = 0;
		{
			auto inv = chest->GetInventory();
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				std::string id, plugin;
				if (!ActorIdentity::DurableOf(obj, id, plugin)) {
					// A runtime-minted form (DFG, 0xFF……) can't be written into
					// an ini — returned with the rest, honestly not recorded.
					++skipped;
					continue;
				}
				const std::uint32_t local = ActorIdentity::ParseHex(id);
				Npc* npc = FindNpc(cfg, g_pendingNpc.plugin, g_pendingNpc.localId);
				if (!npc) {
					cfg.npcs.push_back(Npc{ g_pendingNpc.plugin, g_pendingNpc.localId,
						g_pendingNpc.name, {} });
					npc = &cfg.npcs.back();
				}
				if (auto* have = FindItem(*npc, plugin, local)) {
					// (windows.h defines min/max macros — clamp sidesteps them)
					have->count = std::clamp(have->count + static_cast<int>(data.first), 1, 999);
					have->when = Today();  // topped up counts as a fresh grant
				} else {
					Item it;
					it.plugin = plugin;
					it.localId = local;
					it.count = std::clamp(static_cast<int>(data.first), 1, 999);
					it.chance = 100;
					it.when = Today();
					if (const char* n = obj->GetName(); n && *n)
						it.name = n;
					npc->items.push_back(std::move(it));
				}
				++added;
			}
		}

		// Everything goes home — recorded or not, the chest ends empty.
		FlushChestToPlayer(chest, player);
		ParkChest(chest, player);

		out["ok"] = true;
		out["added"] = added;
		out["skipped"] = skipped;
		if (added) {
			out["msg"] = "Recorded " + std::to_string(added) + " item(s) for " +
				g_pendingNpc.name + " - applies at next launch (SPID)";
		} else if (skipped) {
			out["msg"] = "Nothing recorded - " + std::to_string(skipped) +
				" item(s) had no plugin identity (returned to you)";
		} else {
			out["msg"] = "Chest closed empty - nothing recorded";
		}
		logger::info("spid-gear: harvest for {} - {} recorded, {} skipped",
			g_pendingNpc.name, added, skipped);
		return Dump(out);
	}

	// -------------------------------------------------------------- mutations

	std::string RemoveGrant(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal)
	{
		json out{ { "ok", false } };
		auto* npc = FindNpc(cfg, npcPlugin, npcLocal);
		if (!npc) {
			out["msg"] = "No grants for that NPC";
			return Dump(out);
		}
		const auto key = KeyOf(itemPlugin, itemLocal);
		const auto before = npc->items.size();
		std::erase_if(npc->items,
			[&](const Item& it) { return KeyOf(it.plugin, it.localId) == key; });
		if (npc->items.size() == before) {
			out["msg"] = "That grant is already gone";
			return Dump(out);
		}
		if (npc->items.empty())
			std::erase_if(cfg.npcs, [&](const Npc& n) {
				return KeyOf(n.plugin, n.localId) == KeyOf(npcPlugin, npcLocal);
			});
		out["ok"] = true;
		out["msg"] = "Grant removed - gone from the ini at next launch";
		return Dump(out);
	}

	std::string SetChance(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal, int chance)
	{
		json out{ { "ok", false } };
		auto* npc = FindNpc(cfg, npcPlugin, npcLocal);
		auto* it = npc ? FindItem(*npc, itemPlugin, itemLocal) : nullptr;
		if (!it) {
			out["msg"] = "That grant is gone";
			return Dump(out);
		}
		it->chance = std::clamp(chance, 1, 100);
		out["ok"] = true;
		out["chance"] = it->chance;
		return Dump(out);
	}

	std::string SetItemEnabled(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		const std::string& itemPlugin, std::uint32_t itemLocal, bool on)
	{
		json out{ { "ok", false } };
		auto* npc = FindNpc(cfg, npcPlugin, npcLocal);
		auto* it = npc ? FindItem(*npc, itemPlugin, itemLocal) : nullptr;
		if (!it) {
			out["msg"] = "That grant is gone";
			return Dump(out);
		}
		it->enabled = on;
		out["ok"] = true;
		out["enabled"] = on;
		out["msg"] = (it->name.empty() ? std::string("Grant") : it->name) +
			(on ? " is on again - back in the ini at next launch"
				: " is off - kept, but no longer distributed");
		return Dump(out);
	}

	std::string SetNpcEnabled(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal,
		bool on)
	{
		json out{ { "ok", false } };
		auto* npc = FindNpc(cfg, npcPlugin, npcLocal);
		if (!npc) {
			out["msg"] = "No grants for that NPC";
			return Dump(out);
		}
		npc->enabled = on;
		out["ok"] = true;
		out["enabled"] = on;
		out["msg"] = (npc->name.empty() ? std::string("She") : npc->name) +
			(on ? "'s gear is on again" : "'s gear is off - every grant kept, none distributed");
		return Dump(out);
	}

	std::string RemoveNpc(Config& cfg, const std::string& npcPlugin, std::uint32_t npcLocal)
	{
		json out{ { "ok", false } };
		const auto key = KeyOf(npcPlugin, npcLocal);
		const auto before = cfg.npcs.size();
		std::string name;
		int         gone = 0;
		for (const auto& n : cfg.npcs) {
			if (KeyOf(n.plugin, n.localId) == key) {
				name = n.name;
				gone = static_cast<int>(n.items.size());
				break;
			}
		}
		std::erase_if(cfg.npcs,
			[&](const Npc& n) { return KeyOf(n.plugin, n.localId) == key; });
		if (cfg.npcs.size() == before) {
			out["msg"] = "No grants for that NPC";
			return Dump(out);
		}
		out["ok"] = true;
		out["removed"] = gone;
		out["msg"] = "Forgot " + std::to_string(gone) + " grant(s) for " +
			(name.empty() ? std::string("that NPC") : name);
		return Dump(out);
	}

	// -------------------------------------------------------------- ini writer

	bool WriteIni(const Config& c)
	{
		try {
			const auto path = std::filesystem::path("Data") / "HotkeyDeckGear_DISTR.ini";
			std::string text;
			text += "; Generated by Hotkey Deck (SPID Gear, F7 card). Do not hand-edit -\n";
			text += "; the deck rewrites this file whenever a grant changes.\n";
			text += "; Read by Spell Perk Item Distributor at game launch. Under MO2 this\n";
			text += "; file lives in Overwrite (writes land there), which wins the VFS.\n";
			char line[512];
			int  blocks = 0;
			for (const auto& n : c.npcs) {
				if (!n.valid() || n.items.empty())
					continue;
				text += "\n; " + (n.name.empty() ? std::string("(unnamed)") : n.name) +
					" (" + n.plugin + " | " + ActorIdentity::HexOf(n.localId) + ")\n";
				// A disabled NPC keeps her block as a COMMENT, so the file still
				// reads as the full picture and turning her back on is a diff of
				// one character rather than a resurrection.
				if (!n.enabled) {
					text += ";   (all her gear is switched off in the deck)\n";
					continue;
				}
				++blocks;
				for (const auto& it : n.items) {
					if (!it.valid())
						continue;
					if (!it.enabled) {
						text += ";   off: " +
							(it.name.empty() ? std::string("(unnamed item)") : it.name) + "\n";
						continue;
					}
					// Item = form|strings|forms|levels|traits|count|chance
					std::snprintf(line, sizeof(line),
						"Item = 0x%X~%s|NONE|0x%X~%s|NONE|NONE|%d|%d\n",
						it.localId, it.plugin.c_str(),
						n.localId, n.plugin.c_str(),
						it.count, it.chance);
					text += line;
				}
			}
			std::ofstream out(path, std::ios::trunc);
			if (!out.is_open()) {
				logger::error("spid-gear: could not open {} for writing", path.string());
				return false;
			}
			out << text;
			logger::info("spid-gear: wrote {} ({} live NPC block(s) of {})", path.string(),
				blocks,
				std::count_if(c.npcs.begin(), c.npcs.end(),
					[](const Npc& n) { return n.valid() && !n.items.empty(); }));
			return true;
		} catch (const std::exception& ex) {
			logger::error("spid-gear: ini write error: {}", ex.what());
			return false;
		}
	}
}
