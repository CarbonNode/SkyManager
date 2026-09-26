// Wigs tab — register a wig mod by plugin, browse and wear its wigs. See
// wigs.h for the contract.
//
// Design notes that are load-bearing (item_explorer.cpp's laws, inherited):
//  - The index stores (runtime FormID, file-width-masked local FormID, plugin
//    name) per wig and resolves a use via TESDataHandler::LookupForm(local,
//    plugin) — the ESL-safe identity the deck already uses everywhere. The
//    local id is computed with the file-width mask, NOT CommonLib's
//    GetLocalFormID() (its missing null check is the 2026-08-03 CTD; see
//    actor_identity.cpp).
//  - Dynamic (no source file) forms are skipped: not durable, not listable.
//  - All JSON is dumped with error_handler_t::replace — wig names come out of
//    arbitrary ESPs and are not guaranteed UTF-8; a throwing dump would kill
//    the reply for the whole query (anim_actions' sidecar lesson).
//  - The equip is the wardrobe/zaz-proven shape: AddObjectToContainer when the
//    actor has none, then ActorEquipManager::EquipObject with
//    queueEquip/forceEquip/no-sounds/applyNow — the look takes hold the
//    moment the deck closes and the game unpauses.

#include "wigs.h"

#include "npc_actions.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace Wigs
{
	namespace
	{
		using json = nlohmann::json;

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

		// ---------------------------------------------------------- sidecar --
		struct ModEntry
		{
			std::string plugin;   // as the user registered it, e.g. "KS Wigs.esp"
			std::string lower;
			bool        all = false;   // keep EVERY named playable ARMO, not just hair-slot
		};

		std::vector<ModEntry> g_mods;
		json                  g_viewBlob = json::object();  // opaque, view-owned, verbatim
		bool                  g_sidecarLoaded = false;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "wigs.json";
		}

		// Validate one mods[] entry from json: plugin must be a non-empty
		// string, all a bool (absent = false). Returns false on junk.
		bool ParseModEntry(const json& j, ModEntry& out)
		{
			if (!j.is_object())
				return false;
			if (!j.contains("plugin") || !j["plugin"].is_string())
				return false;
			out.plugin = j["plugin"].get<std::string>();
			if (out.plugin.empty())
				return false;
			out.lower = Lower(out.plugin);
			out.all = j.value("all", false);
			return true;
		}

		void LoadSidecar()
		{
			if (g_sidecarLoaded)
				return;
			g_sidecarLoaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;   // no sidecar yet — start empty, that's a fresh install
			try {
				json j = json::parse(in, nullptr, true, true);
				if (!j.is_object())
					return;
				if (j.contains("mods") && j["mods"].is_array()) {
					for (const auto& m : j["mods"]) {
						ModEntry e;
						if (ParseModEntry(m, e))
							g_mods.push_back(std::move(e));
						else
							logger::warn("wigs: sidecar mods[] entry skipped (not {{plugin,all}})");
					}
				}
				// The view blob is round-tripped VERBATIM — C++ never reads
				// inside it, so unknown view-side keys survive any DLL age.
				if (j.contains("view") && j["view"].is_object())
					g_viewBlob = j["view"];
				logger::info("wigs: sidecar loaded - {} registered mod(s)", g_mods.size());
			} catch (...) {
				logger::warn("wigs: sidecar unreadable - starting empty");
			}
		}

		void SaveSidecarFile()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("wigs: could not write {}", PathU8(tmp));
					return;
				}
				json mods = json::array();
				for (const auto& m : g_mods)
					mods.push_back(json{ { "plugin", m.plugin }, { "all", m.all } });
				out << Dump(json{ { "mods", std::move(mods) }, { "view", g_viewBlob } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("wigs: sidecar rename failed: {}", ec.message());
		}

		// ------------------------------------------------------------ armo ---
		// Hair slots: slot 31 = kHair (bit 1), slot 41 = kLongHair (bit 11).
		// GetSlotMask() returns the raw bit-flag enum, NOT an EnumSet — test
		// the bits directly (wardrobe.cpp's lesson).
		bool IsHairSlot(std::uint32_t mask)
		{
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			return (mask & static_cast<std::uint32_t>(Slot::kHair)) != 0 ||
			       (mask & static_cast<std::uint32_t>(Slot::kLongHair)) != 0;
		}

		// The row's headline slot number (30-based biped convention): the first
		// set bit, preferring the hair slots so a hair+longhair wig reads 31.
		int PrimarySlotOf(std::uint32_t mask)
		{
			using Slot = RE::BGSBipedObjectForm::BipedObjectSlot;
			if (mask & static_cast<std::uint32_t>(Slot::kHair))
				return 31;
			if (mask & static_cast<std::uint32_t>(Slot::kLongHair))
				return 41;
			for (int i = 0; i < 32; ++i)
				if (mask & (1u << i))
					return 30 + i;
			return 0;
		}

		// Named + playable, the item_explorer ARMO filter verbatim: record flag
		// 0x04 = NonPlayable (xEdit); CommonLib exposes no named constant for
		// it on armour, so the raw bit it is.
		const char* NamedPlayable(RE::TESObjectARMO* a)
		{
			if (!a)
				return nullptr;
			if (a->formFlags & 0x04u)
				return nullptr;
			const char* nm = a->GetName();
			return (nm && *nm) ? nm : nullptr;
		}

		bool PluginPresent(const std::string& name)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(name) != nullptr ||
							 dh->LookupLoadedLightModByName(name) != nullptr);
		}

		// ------------------------------------------------------------ index --
		struct Wig
		{
			std::uint32_t formId;    // runtime — this session only
			std::uint32_t localId;   // durable half of the identity we hand the view
			std::int32_t  value;
			float         weight;
			int           slot;
			std::uint16_t mod;       // index into g_mods
			std::string   name;
			std::string   lower;
		};

		std::vector<Wig>           g_wigs;
		std::vector<std::uint32_t> g_modCounts;   // parallel to g_mods
		bool                       g_indexBuilt = false;

		void EnsureIndex()
		{
			LoadSidecar();
			if (g_indexBuilt)
				return;
			g_indexBuilt = true;
			g_wigs.clear();
			g_modCounts.assign(g_mods.size(), 0);
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			for (auto* a : dh->GetFormArray<RE::TESObjectARMO>()) {
				const char* nm = NamedPlayable(a);
				if (!nm)
					continue;
				auto* file = a->GetFile(0);
				if (!file)
					continue;   // dynamic — not durable, not listable
				const std::string fileLower = Lower(file->GetFilename());
				std::uint16_t modIdx = 0xFFFF;
				for (std::size_t i = 0; i < g_mods.size(); ++i)
					if (g_mods[i].lower == fileLower) {
						modIdx = static_cast<std::uint16_t>(i);
						break;
					}
				if (modIdx == 0xFFFF)
					continue;
				const auto mask = static_cast<std::uint32_t>(a->GetSlotMask());
				if (!g_mods[modIdx].all && !IsHairSlot(mask))
					continue;
				Wig w;
				w.formId = a->GetFormID();
				// File-width mask, exactly as GetLocalFormID would if it null-checked.
				w.localId = w.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				w.value = a->GetGoldValue();
				w.weight = a->GetWeight();
				w.slot = PrimarySlotOf(mask);
				w.mod = modIdx;
				w.name = nm;
				w.lower = Lower(w.name);
				g_modCounts[modIdx]++;
				g_wigs.push_back(std::move(w));
			}
			logger::info("wigs: index built - {} mods, {} wigs", g_mods.size(), g_wigs.size());
		}

		// ----------------------------------------------------------- census --
		// Every plugin in the load order that ships >=1 named playable
		// hair-slot ARMO — the "Add a wig mod" picker's feed. Computed once
		// per session across the whole ARMO array, independent of what is
		// registered (so it never needs invalidating on wvSave).
		struct CensusRow
		{
			std::string   name;
			std::string   lower;
			std::uint32_t count = 0;
		};

		std::vector<CensusRow> g_census;
		bool                   g_censusBuilt = false;

		void EnsureCensus()
		{
			if (g_censusBuilt)
				return;
			g_censusBuilt = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			std::vector<const RE::TESFile*> seen;   // parallel to g_census
			for (auto* a : dh->GetFormArray<RE::TESObjectARMO>()) {
				if (!NamedPlayable(a))
					continue;
				auto* file = a->GetFile(0);
				if (!file)
					continue;
				if (!IsHairSlot(static_cast<std::uint32_t>(a->GetSlotMask())))
					continue;
				std::size_t idx = seen.size();
				for (std::size_t i = 0; i < seen.size(); ++i)
					if (seen[i] == file) { idx = i; break; }
				if (idx == seen.size()) {
					seen.push_back(file);
					CensusRow r;
					r.name = std::string(file->GetFilename());
					r.lower = Lower(r.name);
					g_census.push_back(std::move(r));
				}
				g_census[idx].count++;
			}
			logger::info("wigs: census - {} plugins ship hair-slot armor", g_census.size());
		}

		// ------------------------------------------------------------- rows --
		json RowJson(const Wig& w)
		{
			const ModEntry& m = g_mods[w.mod];
			char idbuf[16];
			std::snprintf(idbuf, sizeof(idbuf), "%06X", w.localId);
			char fidbuf[16];
			std::snprintf(fidbuf, sizeof(fidbuf), "0x%06X", w.localId);
			return json{
				{ "id", m.plugin + "|" + idbuf },
				{ "plugin", m.plugin },
				{ "formId", std::string(fidbuf) },
				{ "name", w.name },
				{ "slot", w.slot },
				{ "val", w.value },
				{ "wt", w.weight },
			};
		}

		// Split "Plugin.esp|HEX6" -> (plugin, local). false on junk.
		bool SplitId(const std::string& id, std::string& plugin, std::uint32_t& local)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0 || bar + 1 >= id.size())
				return false;
			plugin = id.substr(0, bar);
			local = static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			return true;
		}
	}

	// ================================================================ API ==

	std::string StateJson()
	{
		EnsureIndex();
		json mods = json::array();
		for (std::size_t i = 0; i < g_mods.size(); ++i) {
			const auto& m = g_mods[i];
			mods.push_back(json{
				{ "plugin", m.plugin },
				{ "present", PluginPresent(m.plugin) },
				{ "all", m.all },
				{ "count", i < g_modCounts.size() ? g_modCounts[i] : 0 },
			});
		}
		return Dump(json{
			{ "ready", true },
			{ "mods", std::move(mods) },
			{ "view", g_viewBlob },
		});
	}

	std::string ModsJson(const std::string& req)
	{
		LoadSidecar();
		EnsureCensus();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = Lower(in.value("q", std::string("")));

		json mods = json::array();
		for (const auto& r : g_census) {
			if (!q.empty() && r.lower.find(q) == std::string::npos)
				continue;
			const bool added = std::any_of(g_mods.begin(), g_mods.end(),
				[&](const ModEntry& m) { return m.lower == r.lower; });
			mods.push_back(json{
				{ "plugin", r.name },
				{ "count", r.count },
				{ "added", added },
			});
		}
		return Dump(json{ { "mods", std::move(mods) } });
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}

		// --- ids path: resolve exactly that list, in order, missing rows
		// answered honestly (the favorites/custom-tab law). The view pages
		// this mode too: it sends the FULL ids array plus limit/offset and
		// drops any reply whose offset differs from its current page — so we
		// slice here and echo offset, total = the whole list's length. ---------
		if (in.contains("ids") && in["ids"].is_array()) {
			const auto& idsArr = in["ids"];
			const int idsTotal = static_cast<int>(idsArr.size());
			// (std::max) — parenthesized so windows.h's max macro cannot eat it
			const int idsOffset = (std::max)(0, in.value("offset", 0));
			const int idsLimit = std::clamp(in.value("limit", 24), 1, 100);
			json rows = json::array();
			for (int ii = idsOffset; ii < idsTotal && ii < idsOffset + idsLimit; ++ii) {
				const auto& idj = idsArr[static_cast<std::size_t>(ii)];
				if (!idj.is_string())
					continue;
				const std::string id = idj.get<std::string>();
				std::string   plugin;
				std::uint32_t local = 0;
				bool found = false;
				if (SplitId(id, plugin, local)) {
					const std::string plugLower = Lower(plugin);
					for (const auto& w : g_wigs) {
						if (w.localId == local && g_mods[w.mod].lower == plugLower) {
							rows.push_back(RowJson(w));
							found = true;
							break;
						}
					}
				}
				if (!found)
					rows.push_back(json{
						{ "id", id }, { "missing", true }, { "name", "" },
						{ "plugin", plugin } });
			}
			return Dump(json{
				{ "total", idsTotal }, { "offset", idsOffset },
				{ "rows", std::move(rows) } });
		}

		const std::string q = Lower(in.value("q", std::string("")));
		const std::string mod = Lower(in.value("mod", std::string("")));
		// (std::max) — parenthesized so windows.h's max macro cannot eat it
		const int offset = (std::max)(0, in.value("offset", 0));
		const int limit = std::clamp(in.value("limit", 24), 1, 100);

		std::vector<std::uint32_t> hits;
		hits.reserve(g_wigs.size());
		for (std::uint32_t i = 0; i < g_wigs.size(); ++i) {
			const Wig& w = g_wigs[i];
			if (!mod.empty() && g_mods[w.mod].lower != mod)
				continue;
			if (!q.empty() && w.lower.find(q) == std::string::npos)
				continue;
			hits.push_back(i);
		}
		std::sort(hits.begin(), hits.end(), [](std::uint32_t a, std::uint32_t b) {
			const Wig& x = g_wigs[a];
			const Wig& y = g_wigs[b];
			if (x.lower != y.lower)
				return x.lower < y.lower;
			return x.localId < y.localId;   // stable tiebreak for duplicate names
		});

		json rows = json::array();
		const int total = static_cast<int>(hits.size());
		for (int i = offset; i < total && i < offset + limit; ++i)
			rows.push_back(RowJson(g_wigs[hits[static_cast<std::size_t>(i)]]));
		return Dump(json{
			{ "total", total }, { "offset", offset }, { "rows", std::move(rows) } });
	}

	std::string UseJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));
		const std::string op = in.value("op", std::string("wear"));
		const std::string target = in.value("target", std::string("me"));

		auto fail = [&](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg }, { "id", id }, { "op", op } });
		};
		auto okay = [&](const std::string& msg) {
			return Dump(json{ { "ok", true }, { "msg", msg }, { "id", id }, { "op", op } });
		};

		std::string   plugin;
		std::uint32_t local = 0;
		if (!SplitId(id, plugin, local))
			return fail("Malformed wig id");

		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!dh || !player)
			return fail("No game loaded");
		auto* form = dh->LookupForm(local, plugin);
		auto* armo = form ? form->As<RE::TESObjectARMO>() : nullptr;
		if (!armo)
			return fail(plugin + " isn't in the load order any more - that wig can't resolve");
		const char* nm = armo->GetName();
		const std::string name = (nm && *nm) ? nm : "wig";

		// take: player's inventory, no equip — target is irrelevant by design.
		if (op == "take") {
			player->AddObjectToContainer(armo, nullptr, 1, nullptr);
			RE::DebugNotification(("+ " + name).c_str());
			logger::info("wigs: take '{}' from {}", name, plugin);
			return okay("+ " + name);
		}

		// wear/strip need an actor: me, or the crosshair NPC snapshotted at
		// palette-open (the same accessor every crosshair pane verb uses).
		RE::Actor* actor = nullptr;
		if (target == "look") {
			const auto formId = NpcActions::TargetFormID();
			if (!formId)
				return fail("Look at someone first");
			actor = RE::TESForm::LookupByID<RE::Actor>(formId);
			if (!actor)
				return fail("They aren't loaded any more - look at them and reopen");
		} else if (target != "me" && !target.empty()) {
			// A SPECIFIC actor (2026-09-23, Rober: "add that as a popout to a
			// specific npc ... the wig i pick immedietly gets forced into inventory
			// and equipped for that npc"): the NPC card's own subject, by runtime
			// FormID - decimal or 0x-hex, whichever the view holds. Loaded-actor
			// check as for "look"; the dead check below applies the same.
			const auto formId = static_cast<std::uint32_t>(std::strtoul(target.c_str(), nullptr, 0));
			actor = formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
			if (!actor)
				return fail("They aren't loaded any more - find them and reopen");
			logger::info("wigs: target actor {:08X}", formId);  // marker: wigs-target-actor
		} else {
			actor = player;
		}
		if (actor->IsDead())
			return fail("They're dead - a wig won't help");
		const char* an = actor->GetDisplayFullName();
		const std::string who = actor->IsPlayerRef() ? std::string("you")
			: ((an && *an) ? std::string(an) : std::string("them"));

		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return fail("Equip manager missing");

		if (op == "strip") {
			eqm->UnequipObject(actor, armo);
			logger::info("wigs: strip '{}' off {}", name, who);
			return okay(name + " off - " + who);
		}
		if (op != "wear")
			return fail("Unknown op");

		// Only hand them one if they have none — a repeated wear must not
		// quietly fill the pack with duplicates (wardrobe.cpp's rule).
		bool have = false;
		for (const auto& [obj, data] : actor->GetInventory())
			if (obj == armo && data.first > 0) {
				have = true;
				break;
			}
		if (!have)
			actor->AddObjectToContainer(armo, nullptr, 1, nullptr);
		// wardrobe/zaz's proven equip flags — the look takes hold the moment
		// the deck closes and the game unpauses.
		eqm->EquipObject(actor, armo, nullptr, 1, nullptr,
			/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
		logger::info("wigs: wear '{}' on {}", name, who);
		return okay(name + " on - " + who);
	}

	std::string SaveJson(const std::string& req)
	{
		LoadSidecar();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (!in.is_object())
			return Dump(json{ { "ok", false }, { "msg", "bad request" } });

		if (in.contains("mods") && in["mods"].is_array()) {
			std::vector<ModEntry> mods;
			for (const auto& m : in["mods"]) {
				ModEntry e;
				if (ParseModEntry(m, e))
					mods.push_back(std::move(e));
				else
					logger::warn("wigs: save dropped a mods[] entry (not {{plugin,all}})");
			}
			g_mods = std::move(mods);
		}
		if (in.contains("view") && in["view"].is_object())
			g_viewBlob = in["view"];   // wholesale, verbatim — the view owns it

		SaveSidecarFile();
		// The registration list changed: the wig index must rebuild against it
		// on the next wvState/wvQuery. The census is registration-independent
		// and stays warm.
		g_indexBuilt = false;
		logger::info("wigs: saved - {} registered mod(s)", g_mods.size());
		return Dump(json{ { "ok", true } });
	}
}
