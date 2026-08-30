// Combat Arts tab — Ashes of War integration. See combat_arts.h for the contract.
//
// Design notes that are load-bearing:
//  - The mod's whole mechanic is WEARING an ash ARMO (all 74 share biped slot
//    mask 0x2000000, so the engine auto-swaps; DAR/OAR reads the worn keyword).
//    No spells, no scripts — so equip/unequip here is the plain ZaZ-segment
//    armour idiom (AddObjectToContainer + ActorEquipManager::EquipObject with
//    forceEquip/applyNow, UnequipObject + RemoveItem), nothing reimplemented.
//  - The index stores (runtime FormID, local FormID) per art and resolves an
//    equip via TESDataHandler::LookupForm(local, plugin) — the ESL-safe
//    identity the deck already uses. The local id is computed with the
//    file-width mask, NOT CommonLib's GetLocalFormID() (its missing null check
//    is the 2026-08-03 CTD; see actor_identity.cpp). No art FormID is
//    hardcoded — the ARMOs are enumerated from the plugin at runtime.
//  - The container-change sink must not intercept OUR OWN equip add: an
//    expected-add counter per FormID is set before AddObjectToContainer and
//    decremented by the sink. Our RemoveItem calls fire events with the player
//    as the OLD container — the sink only acts on newContainer == player.
//  - Sidecar JSON via the vendored json.hpp; a corrupt file = start fresh
//    (logged), unknown root keys are preserved on rewrite (the whole parsed
//    root is kept and only the owned keys are overwritten).

#include "combat_arts.h"

#include "pch.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace CombatArts
{
	namespace
	{
		using json = nlohmann::json;

		constexpr const char* kPlugin = "Ashes of War Additional Attack v Items.esp";
		constexpr const char* kAbsentReason =
			"Ashes of War (Items version) isn't in the load order";

		// The player's fixed FormID — compared raw in the sink so the sink
		// makes no engine call on whatever thread the event arrives on.
		constexpr RE::FormID kPlayerId = 0x00000014;

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

		// ------------------------------------------------------------- index --
		struct Art
		{
			RE::FormID    formId = 0;   // runtime — valid this session
			std::uint32_t localId = 0;  // durable half of the id we hand the view
			int           num = 0;      // the NN in "Ashes NN: <name>"
			std::string   id;           // "<plugin>|<6-hex-lowercase-local>"
			std::string   full;         // "Ashes 01: High Kick"
			std::string   name;         // "High Kick"
		};

		std::vector<Art>  g_arts;                    // sorted by num
		std::atomic<bool> g_indexBuilt{ false };
		std::atomic<bool> g_present{ false };

		// Read by the sink on an arbitrary thread, written once at index build
		// (main thread) — hence the mutex. Main-thread reads AFTER the build
		// need no lock (the set is never mutated again).
		std::mutex                              g_sinkMtx;
		std::unordered_set<RE::FormID>          g_ashForms;
		std::unordered_map<RE::FormID, int>     g_expectedAdds;  // our own equip adds

		// ----------------------------------------------------- sidecar state --
		// Main thread only (every mutator runs inside an SKSE task).
		bool                                         g_sideLoaded = false;
		json                                         g_sideRoot = json::object();  // unknown keys preserved
		std::unordered_map<std::string, int>         g_collected;   // artId -> copies stored
		std::string                                  g_equipped;    // artId, "" = none
		std::unordered_map<std::string, std::string> g_icons;       // artId -> icons/… path

		bool                                    g_swept = false;      // adoption sweep ran this session
		std::atomic<bool>                       g_queueBusy{ false }; // portal consume in flight
		std::function<void(const std::string&)> g_push;               // caStateResult live push

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "combat-arts.json";
		}

		// The phone's icon queue, in the deck view's folder — the same Data\
		// VFS path DeckViewDir() uses, so MO2 resolves it into the SkyManager
		// Source mod. Seeded at install and TRUNCATED after every batch, never
		// deleted (the spell-cat-icons law: a file the portal creates
		// mid-session is invisible to the running game's VFS snapshot).
		std::filesystem::path BridgePath()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" /
			       "portal-combat-art-icons.json";
		}

		constexpr std::size_t kQueueEmptyBytes = sizeof(R"({"queue":[]})") - 1;

		void EnsureBridge(bool force)
		{
			const auto      file = BridgePath();
			std::error_code ec;
			if (!force && std::filesystem::exists(file, ec))
				return;
			std::filesystem::create_directories(file.parent_path(), ec);
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (!out.is_open()) {
				logger::warn("combat-arts: could not seed the portal icon bridge file");
				return;
			}
			out << R"({"queue":[]})";
		}

		// One stat(), the CatIconQueuePending shape: the file is permanent, so
		// existence says nothing and mtime spins (the truncate is a write) —
		// gate on the size differing from the canonical empty queue.
		bool BridgePending()
		{
			std::error_code ec;
			const auto      sz = std::filesystem::file_size(BridgePath(), ec);
			if (ec)
				return false;  // absent: nothing queued (and invisible mid-session anyway)
			return sz != kQueueEmptyBytes;
		}

		void LoadSidecar()
		{
			if (g_sideLoaded)
				return;
			g_sideLoaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (!j.is_object())
					throw std::runtime_error("root is not an object");
				g_sideRoot = j;
				if (j.contains("collected") && j["collected"].is_object())
					for (const auto& [k, v] : j["collected"].items())
						if (v.is_number_integer() && v.get<int>() > 0)
							g_collected[k] = v.get<int>();
				if (j.contains("equipped") && j["equipped"].is_string())
					g_equipped = j["equipped"].get<std::string>();
				if (j.contains("icons") && j["icons"].is_object())
					for (const auto& [k, v] : j["icons"].items())
						if (v.is_string())
							g_icons[k] = v.get<std::string>();
			} catch (...) {
				logger::warn("combat-arts: sidecar unreadable — starting fresh");
				g_sideRoot = json::object();
				g_collected.clear();
				g_equipped.clear();
				g_icons.clear();
			}
		}

		void SaveSidecar()
		{
			json root = g_sideRoot;  // unknown keys survive the rewrite
			root["version"] = 1;
			json col = json::object();
			for (const auto& [k, v] : g_collected)
				if (v > 0)
					col[k] = v;
			root["collected"] = std::move(col);
			root["equipped"] = g_equipped.empty() ? json(nullptr) : json(g_equipped);
			json ico = json::object();
			for (const auto& [k, v] : g_icons)
				ico[k] = v;
			root["icons"] = std::move(ico);
			g_sideRoot = root;

			const auto      path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("combat-arts: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(root);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("combat-arts: sidecar rename failed: {}", ec.message());
		}

		// --------------------------------------------------------- the index --
		bool PluginPresent()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(kPlugin) != nullptr ||
							 dh->LookupLoadedLightModByName(kPlugin) != nullptr);
		}

		void BuildIndex()
		{
			if (g_indexBuilt.exchange(true))
				return;
			LoadSidecar();
			if (!PluginPresent()) {
				g_present = false;
				logger::info("combat-arts: {}", kAbsentReason);
				return;
			}
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			const std::string plugLower = Lower(kPlugin);
			for (auto* armo : dh->GetFormArray<RE::TESObjectARMO>()) {
				if (!armo)
					continue;
				auto* file = armo->GetFile(0);
				if (!file || Lower(file->GetFilename()) != plugLower)
					continue;
				const char* nm = armo->GetName();
				if (!nm || !*nm)
					continue;  // the shared ARMA/keyword scaffolding is nameless
				Art a;
				a.formId = armo->GetFormID();
				// File-width mask, exactly as GetLocalFormID would if it null-checked.
				a.localId = a.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				a.full = nm;
				// "Ashes NN: <Art Name>" — num from the prefix, name after ": ".
				if (a.full.rfind("Ashes ", 0) == 0)
					a.num = std::atoi(a.full.c_str() + 6);
				a.name = a.full;
				if (const auto p = a.full.find(": "); p != std::string::npos && p + 2 < a.full.size())
					a.name = a.full.substr(p + 2);
				char idbuf[16];
				std::snprintf(idbuf, sizeof(idbuf), "%06x", a.localId);
				a.id = std::string(kPlugin) + "|" + idbuf;
				g_arts.push_back(std::move(a));
			}
			std::sort(g_arts.begin(), g_arts.end(), [](const Art& x, const Art& y) {
				if (x.num != y.num)
					return x.num < y.num;
				return x.full < y.full;
			});
			{
				std::lock_guard l(g_sinkMtx);
				for (const auto& a : g_arts)
					g_ashForms.insert(a.formId);
			}
			g_present = !g_arts.empty();
			if (!g_present) {
				// The plugin is loaded but holds no named ARMOs — treat as absent
				// (a stripped/repacked variant we cannot drive).
				logger::warn("combat-arts: {} is loaded but has no ash items — standing down", kPlugin);
				return;
			}
			// Build marker (hd-markers.json: "combat-arts") — reached every launch
			// with the mod installed.
			logger::info("combat-arts: index built ({} arts from {})", g_arts.size(), kPlugin);
		}

		const Art* ArtById(const std::string& id)
		{
			for (const auto& a : g_arts)
				if (a.id == id)
					return &a;
			return nullptr;
		}

		const Art* ArtByFormId(RE::FormID fid)
		{
			for (const auto& a : g_arts)
				if (a.formId == fid)
					return &a;
			return nullptr;
		}

		// How many of this ash the player carries, and whether one is worn.
		void InvCountWorn(RE::PlayerCharacter* player, RE::FormID fid,
			std::int32_t& outCount, bool& outWorn)
		{
			outCount = 0;
			outWorn = false;
			auto inv = player->GetInventory([fid](RE::TESBoundObject& o) {
				return o.GetFormID() == fid;
			});
			for (auto& [obj, data] : inv) {
				outCount = data.first;
				outWorn = data.second && data.second->IsWorn();
			}
		}

		int CollectedDistinct()
		{
			int n = 0;
			for (const auto& [k, v] : g_collected)
				if (v > 0)
					++n;
			return n;
		}

		// State builder — assumes the index is built. The public StateJson
		// wraps this with the build/sweep/queue-consume preamble.
		std::string BuildStateJson()
		{
			json out;
			out["present"] = g_present.load();
			if (!g_present.load()) {
				out["reason"] = kAbsentReason;
				out["equipped"] = nullptr;
				out["collected"] = 0;
				out["arts"] = json::array();
				return Dump(out);
			}
			out["equipped"] = g_equipped.empty() ? json(nullptr) : json(g_equipped);
			out["collected"] = CollectedDistinct();
			json arts = json::array();
			for (const auto& a : g_arts) {
				const auto cIt = g_collected.find(a.id);
				const int  count = cIt != g_collected.end() ? cIt->second : 0;
				const auto iIt = g_icons.find(a.id);
				arts.push_back(json{
					{ "id", a.id },
					{ "num", a.num },
					{ "name", a.name },
					{ "full", a.full },
					{ "owned", count > 0 },
					{ "count", count },
					{ "icon", iIt != g_icons.end() ? json(iIt->second) : json(nullptr) },
					{ "equipped", !g_equipped.empty() && a.id == g_equipped },
				});
			}
			out["arts"] = std::move(arts);
			return Dump(out);
		}

		void PushState()
		{
			if (g_push)
				g_push(BuildStateJson());
		}

		// ---------------------------------------------------- portal icons --
		bool ValidIconPath(const std::string& p)
		{
			return !p.empty() && p.size() <= 160 && p.rfind("icons/", 0) == 0 &&
			       p.find("..") == std::string::npos && p.find('\\') == std::string::npos;
		}

		// Main thread. Returns true when at least one icon changed.
		bool ConsumeQueueNow()
		{
			if (!g_present.load())
				return false;
			const auto      file = BridgePath();
			std::error_code ec;
			if (!std::filesystem::exists(file, ec)) {
				EnsureBridge(false);
				return false;
			}
			const auto sz = std::filesystem::file_size(file, ec);
			if (ec || sz == kQueueEmptyBytes)
				return false;

			std::string text;
			{
				std::ifstream in(file, std::ios::binary);
				if (!in.is_open()) {
					// Held open by the portal mid-write: leave it, next pass gets it.
					logger::warn("combat-arts: icon queue present but unreadable — retrying");
					return false;
				}
				text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			}

			const auto  j = json::parse(text, nullptr, false);
			std::size_t applied = 0, skipped = 0;
			if (j.is_discarded() || !j.is_object() || !j.contains("queue") || !j["queue"].is_array()) {
				logger::error("combat-arts: portal icon queue malformed — discarding it");
			} else {
				for (const auto& e : j["queue"]) {
					if (!e.is_object())
						continue;
					const auto art = e.value("art", std::string(""));
					if (art.empty() || !ArtById(art)) {
						++skipped;
						continue;
					}
					std::string icon;
					if (e.contains("icon") && e["icon"].is_string())
						icon = e["icon"].get<std::string>();
					const bool clear = icon.empty();  // null or "" = clear
					if (!clear && !ValidIconPath(icon)) {
						++skipped;
						logger::info("combat-arts: portal icon for '{}' refused: '{}' is not a view-relative icons/ path",
							art, icon);
						continue;
					}
					if (clear)
						g_icons.erase(art);
					else
						g_icons[art] = icon;
					++applied;
					logger::info("combat-arts: portal icon '{}' -> {}", art,
						clear ? std::string("(none)") : icon);
				}
			}
			if (applied)
				SaveSidecar();
			if (applied || skipped)
				logger::info("combat-arts: portal icons {} set, {} skipped", applied, skipped);
			EnsureBridge(true);  // truncate, never delete — the bridge law
			return applied > 0;
		}

		// ------------------------------------------------------- intercept --
		// Main thread (queued by the sink). Idempotent — a doubled event finds
		// nothing left to remove and returns.
		void InterceptNow(RE::FormID base)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return;
			const Art* art = ArtByFormId(base);
			if (!art)
				return;
			auto* armo = RE::TESForm::LookupByID<RE::TESObjectARMO>(base);
			if (!armo)
				return;

			std::int32_t count = 0;
			bool         worn = false;
			InvCountWorn(player, base, count, worn);
			if (count <= 0)
				return;

			// A worn copy stays (and is adopted as the equipped art if our
			// record disagreed — the engine's truth wins); everything loose is
			// stored.
			bool equippedChanged = false;
			if (worn && g_equipped != art->id) {
				g_equipped = art->id;
				equippedChanged = true;
			}
			const std::int32_t toRemove = count - (worn ? 1 : 0);
			if (toRemove <= 0) {
				if (equippedChanged)
					SaveSidecar();
				return;
			}

			player->RemoveItem(armo, toRemove, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			g_collected[art->id] += toRemove;
			SaveSidecar();
			RE::DebugNotification(
				("Combat Art acquired: " + art->name + " — stored in Combat Arts (F7)").c_str());
			// Build marker (hd-markers.json: "combat-arts-store").
			logger::info("combat-arts: stored '{}' (x{}, {} held)", art->full, toRemove,
				g_collected[art->id]);
			PushState();
		}

		// The adoption sweep — main thread. Reconciles equipped against the
		// live save and stores every loose ash.
		void Sweep()
		{
			if (!g_present.load())
				return;
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return;  // no save yet — retry on the next caState
			g_swept = true;

			// Ash filter over the inventory. Main-thread read of g_ashForms
			// after the one-time build needs no lock (never mutated again).
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return g_ashForms.count(o.GetFormID()) != 0;
			});

			std::string wornId;
			int         adopted = 0;
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				const Art* art = ArtByFormId(obj->GetFormID());
				if (!art)
					continue;
				const bool worn = data.second && data.second->IsWorn();
				std::int32_t toRemove = data.first;
				if (worn) {
					wornId = art->id;
					if (g_collected[art->id] < 1)
						g_collected[art->id] = 1;  // the worn copy counts as collected
					--toRemove;
				}
				if (toRemove > 0) {
					player->RemoveItem(obj, toRemove, RE::ITEM_REMOVE_REASON::kRemove,
						nullptr, nullptr);
					g_collected[art->id] += toRemove;
					adopted += toRemove;
					logger::info("combat-arts: stored '{}' (x{}, adopted by the sweep)",
						art->full, toRemove);
				}
			}

			// The save's truth on what is worn beats our record — a save from
			// before this feature, or one where the art was swapped outside the
			// deck, reconciles here.
			const bool equippedChanged = g_equipped != wornId;
			g_equipped = wornId;

			if (adopted > 0 || equippedChanged) {
				SaveSidecar();
				if (adopted > 0)
					RE::DebugNotification(
						("Combat Arts: " + std::to_string(adopted) +
							" stored — browse them in Combat Arts (F7)").c_str());
				PushState();
			}
		}

		// ------------------------------------------------------------ sink --
		class ContainerSink final : public RE::BSTEventSink<RE::TESContainerChangedEvent>
		{
		public:
			static ContainerSink* GetSingleton()
			{
				static ContainerSink s;
				return &s;
			}

			RE::BSEventNotifyControl ProcessEvent(const RE::TESContainerChangedEvent* ev,
				RE::BSTEventSource<RE::TESContainerChangedEvent>*) override
			{
				// Only items ARRIVING in the player's bag matter; our own
				// RemoveItem calls fire with the player as the OLD container
				// and fall through here untouched.
				if (!ev || ev->newContainer != kPlayerId || ev->itemCount <= 0)
					return RE::BSEventNotifyControl::kContinue;
				const RE::FormID base = ev->baseObj;
				{
					std::lock_guard l(g_sinkMtx);
					if (!g_ashForms.count(base))
						return RE::BSEventNotifyControl::kContinue;
					auto it = g_expectedAdds.find(base);
					if (it != g_expectedAdds.end() && it->second > 0) {
						// Our own equip add — consume the suppression, don't intercept.
						if (--it->second == 0)
							g_expectedAdds.erase(it);
						return RE::BSEventNotifyControl::kContinue;
					}
				}
				// Minimal work here (arbitrary thread) — the remove/notify runs
				// as an SKSE task on the main thread.
				SKSE::GetTaskInterface()->AddTask([base]() { InterceptNow(base); });
				return RE::BSEventNotifyControl::kContinue;
			}
		};
	}

	// ================================================================ API ==

	void InstallSink()
	{
		BuildIndex();
		if (!g_present.load())
			return;  // stand down honestly — no sink, no bridge file
		EnsureBridge(false);
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton()) {
			holder->AddEventSink<RE::TESContainerChangedEvent>(ContainerSink::GetSingleton());
			logger::info("combat-arts: container sink armed (ash pickups auto-stored)");
		} else {
			logger::error("combat-arts: no ScriptEventSourceHolder — pickups adopted only by the load sweep");
		}
	}

	void SetStatePush(std::function<void(const std::string&)> push)
	{
		g_push = std::move(push);
	}

	void OnPostLoadGame()
	{
		if (!g_indexBuilt.load())
			return;  // kDataLoaded never ran (plugin scan failed) — nothing to sweep
		Sweep();
	}

	std::string StateJson()
	{
		BuildIndex();
		if (!g_present.load())
			return BuildStateJson();
		if (!g_swept)
			Sweep();  // defensive: adopt pre-feature pickups even if the load hook missed
		ConsumeQueueNow();
		return BuildStateJson();
	}

	std::string Act(const std::string& req)
	{
		BuildIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string op = in.value("op", std::string(""));
		const std::string id = in.value("id", std::string(""));

		auto reply = [&](bool ok, const std::string& msg) {
			return Dump(json{ { "ok", ok }, { "msg", msg }, { "id", id },
				{ "equipped", g_equipped.empty() ? json(nullptr) : json(g_equipped) } });
		};

		if (!g_present.load())
			return reply(false, kAbsentReason);
		const Art* art = ArtById(id);
		if (!art)
			return reply(false, "That art isn't in the load order any more");
		auto* player = RE::PlayerCharacter::GetSingleton();
		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!player || !dh || !eqm)
			return reply(false, "No save loaded");

		// ESL-safe resolve — the durable identity, not the cached runtime id.
		auto* armo = dh->LookupForm<RE::TESObjectARMO>(art->localId, kPlugin);
		if (!armo)
			return reply(false, "That art didn't resolve — mod updated?");

		if (op == "equip") {
			const auto cIt = g_collected.find(art->id);
			if (cIt == g_collected.end() || cIt->second <= 0)
				return reply(false, "You haven't found that art yet");
			if (g_equipped == art->id)
				return reply(true, art->name + " is already equipped");

			// Take the previous art off FIRST (and out of the bag), so the
			// one-ash-in-inventory invariant holds at every step. RemoveItem
			// fires an event with the player as OLD container — sink-ignored.
			if (!g_equipped.empty()) {
				if (const Art* prev = ArtById(g_equipped)) {
					if (auto* prevArmo = dh->LookupForm<RE::TESObjectARMO>(prev->localId, kPlugin)) {
						eqm->UnequipObject(player, prevArmo);
						player->RemoveItem(prevArmo, 1, RE::ITEM_REMOVE_REASON::kRemove,
							nullptr, nullptr);
					}
				}
			}

			// Our own add fires a container event — arm the suppression BEFORE
			// the add so the sink never intercepts it.
			{
				std::lock_guard l(g_sinkMtx);
				g_expectedAdds[armo->GetFormID()] += 1;
			}
			player->AddObjectToContainer(armo, nullptr, 1, nullptr);
			// zaz_deck's proven armour-equip flags: forced, silent, applied now —
			// armour equip works under the paused deck (wardrobe precedent), so
			// the palette stays open.
			eqm->EquipObject(player, armo, nullptr, 1, nullptr,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
			g_equipped = art->id;
			SaveSidecar();
			// Build marker (hd-markers.json: "combat-arts-equip").
			logger::info("combat-arts: equip '{}'", art->full);
			return reply(true, art->name + " equipped");
		}

		if (op == "unequip") {
			if (g_equipped != art->id)
				return reply(false, "That art isn't equipped");
			eqm->UnequipObject(player, armo);
			player->RemoveItem(armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
			g_equipped.clear();
			SaveSidecar();
			logger::info("combat-arts: unequip '{}'", art->full);
			return reply(true, art->name + " unequipped");
		}

		return reply(false, "unknown op");
	}

	std::string Save(const std::string& req)
	{
		BuildIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (g_present.load() && in.contains("icons") && in["icons"].is_object()) {
			bool changed = false;
			for (const auto& [k, v] : in["icons"].items()) {
				if (!ArtById(k))
					continue;  // only arts the index knows — keeps the map bounded
				if (v.is_string() && !v.get<std::string>().empty()) {
					const auto path = v.get<std::string>();
					if (!ValidIconPath(path))
						continue;
					g_icons[k] = path;
					changed = true;
				} else {  // null or "" = clear
					changed = g_icons.erase(k) > 0 || changed;
				}
			}
			if (changed)
				SaveSidecar();
		}
		json ico = json::object();
		for (const auto& [k, v] : g_icons)
			ico[k] = v;
		return Dump(json{ { "ok", true }, { "icons", std::move(ico) } });
	}

	void PollTick()
	{
		// Portal poll WORKER thread: one atomic read + one stat(). Real work
		// hops to the main thread; g_queueBusy stops a slow frame stacking
		// consume tasks.
		if (!g_indexBuilt.load() || !g_present.load())
			return;
		if (!BridgePending())
			return;
		if (g_queueBusy.exchange(true))
			return;
		SKSE::GetTaskInterface()->AddTask([]() {
			if (ConsumeQueueNow())
				PushState();
			g_queueBusy = false;
		});
	}
}
