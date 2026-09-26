// Cells tab — the Finder's third roster. See cell_finder.h for the contract.
//
// Design notes that are load-bearing:
//  - The source is TESDataHandler::interiorCells, which is the complete
//    interior list at boot with nothing loaded. Its backing NiTArray iterates
//    to CAPACITY, not size, so empty slots come back as nulls — every read is
//    null-checked, which is also what makes a partly-filled array harmless.
//  - Identity is (plugin, file-width-masked local FormID), the ESL-safe pair
//    the Items and NPCs rosters proved; never CommonLib's GetLocalFormID().
//  - MOST interiors have no full name — an unnamed cell is not a broken row,
//    it is the normal case for a modded dungeon, and its EDITOR ID is what a
//    player can actually search and travel by. Both are indexed, and the pane
//    draws the editor id when there is no name instead of an empty row.
//  - The index walk touches ONLY name, editor id, location and the DATA flags.
//    Owner and attachment are live facts read one cell at a time in the detail
//    path — walking 20,000 cells' extra data at boot buys nothing.
//  - All JSON dumps use error_handler_t::replace — cell names come out of
//    thousands of third-party plugins and are not guaranteed UTF-8.

#include "cell_finder.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <unordered_map>
#include <vector>

#include "console_actions.h"

namespace CellFinder
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

		// ------------------------------------------------------------- index --
		struct Plugin
		{
			std::string   name;
			std::string   lower;
			std::string   ext;
			bool          light = false;
			std::uint32_t count = 0;
		};

		struct Cell
		{
			std::uint32_t formId = 0;   // runtime — session-scoped lookups
			std::uint32_t localId = 0;  // durable half of the row identity
			std::uint16_t plug = 0;     // index into g_plugins
			// Markers are REFRs, not CELLs: they never have these DATA flags.
			bool          pub = false;      // kPublicArea
			bool          water = false;    // kHasWater
			bool          travel = false;   // kCanTravelFromHere
			bool          warn = false;     // kWarnToLeave
			std::string   name;     // full name, often empty
			std::string   edid;     // editor id, "" = untravellable
			std::string   loc;      // owning location's name, may be empty
			std::string   lname;    // lowercased name
			std::string   ledid;    // lowercased editor id
			std::string   lloc;     // lowercased location name
			/* Outdoors (Rober, 2026-09-21: "searched bannermist … never got Bannermist
			 * Tower"). Vanilla Bannermist Tower is an exterior ruin with a MAP MARKER and
			 * no interior, so an interiors-only index could never list it. Two more row
			 * kinds now ride the same roster: a named exterior cell that kept an editor
			 * id (`coc` reaches it), and a map marker (travel = player.moveto the marker
			 * ref — the Places module's road). `loc` holds the worldspace for both. */
			bool          exterior = false;  // a worldspace cell with an editor id
			bool          marker = false;    // an ExtraMapMarker ref: edid is "", formId is the REFR
			bool          visible = false;   // marker: discovered on the map
			bool          disabled = false;  // marker: ref not enabled yet (quest-gated)
			std::string   mtype;             // marker: "tower", "cave" … (Places' names)
			std::string   lmtype;
		};

		std::vector<Plugin> g_plugins;
		std::vector<Cell>   g_cells;
		bool                g_built = false;

		/* Persisted page size only — this module's OWN sidecar, not a
		 * hotkeys.json slice (the ItemExplorer / NpcFinder precedent, and the
		 * reason OnJsSave's wholesale replace can never eat it). No renders on
		 * this roster, so a page is cheap: 25, the item-explorer default,
		 * rather than the NPC pane's 10. */
		int  g_pageSize = 25;
		bool g_settingsLoaded = false;

		int ClampPageSize(int n)
		{
			return std::clamp(n, 1, 100);
		}

		std::filesystem::path SettingsPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "cell-finder.json";
		}

		void LoadSettings()
		{
			if (g_settingsLoaded)
				return;
			g_settingsLoaded = true;
			std::ifstream in(SettingsPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object())
					// unknown keys survive: j is READ-only here, the writer emits
					// back only the fields we own.
					g_pageSize = ClampPageSize(j.value("pageSize", g_pageSize));
			} catch (...) {
				logger::warn("cell-finder: settings sidecar unreadable - defaults kept");
			}
		}

		void SaveSettingsFile()
		{
			const auto path = SettingsPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("cell-finder: cannot write {}", PathU8(path));
					return;
				}
				out << Dump(json{ { "pageSize", g_pageSize } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("cell-finder: sidecar rename failed - {}", ec.message());
		}

		/* The file a form's identity BELONGS to — the one its load index names —
		 * never GetFile(0). Rober, 2026-09-21: Go on "BannermistTowerExterior01"
		 * said "not in the load order any more" while the row sat right there.
		 * That cell is Skyrim.esm's but OVERRIDDEN by Landscape Fixes For Grass
		 * Mods.esp, and GetFile(0) handed back the override: the row's id then read
		 * "Landscape Fixes…|0132C7" and LookupForm looked for local 0132C7 INSIDE
		 * that patch — nothing there. The load index in the runtime FormID is the
		 * only thing coc / LookupForm agree on, so derive the file from it. */
		const RE::TESFile* OwnerFile(RE::TESDataHandler* dh, RE::FormID formId)
		{
			if (!dh)
				return nullptr;
			const std::uint32_t hi = formId >> 24;
			if (hi == 0xFF)
				return nullptr;   // dynamic — not a durable place
			if (hi == 0xFE)
				return dh->LookupLoadedLightModByIndex(static_cast<std::uint16_t>((formId >> 12) & 0xFFFu));
			return dh->LookupLoadedModByIndex(static_cast<std::uint8_t>(hi));
		}

		std::uint16_t PlugIndexFor(const RE::TESFile* file,
			std::unordered_map<const RE::TESFile*, std::uint16_t>& map)
		{
			if (auto it = map.find(file); it != map.end())
				return it->second;
			Plugin p;
			p.name = std::string(file->GetFilename());
			p.lower = Lower(p.name);
			p.light = file->IsLight();
			const auto dot = p.lower.rfind('.');
			p.ext = dot == std::string::npos ? "esp" : p.lower.substr(dot + 1);
			const auto idx = static_cast<std::uint16_t>(g_plugins.size());
			g_plugins.push_back(std::move(p));
			map.emplace(file, idx);
			return idx;
		}

		// Marker types, worded the way the Places module words them so the two
		// rosters agree on what a "tower" is.
		const char* MarkerTypeName(RE::MARKER_TYPE t)
		{
			using M = RE::MARKER_TYPE;
			switch (t) {
			case M::kCity: return "city";
			case M::kTown: return "town";
			case M::kSettlement: return "settlement";
			case M::kCave: return "cave";
			case M::kCamp: return "camp";
			case M::kFort: return "fort";
			case M::kNordicRuin: return "nordic ruin";
			case M::kDwemerRuin: return "dwemer ruin";
			case M::kShipwreck: return "shipwreck";
			case M::kGrove: return "grove";
			case M::kLandmark: return "landmark";
			case M::kDragonLair: return "dragon lair";
			case M::kFarm: return "farm";
			case M::kWoodMill: return "wood mill";
			case M::kMine: return "mine";
			case M::kImperialCamp: return "imperial camp";
			case M::kStormcloakCamp: return "stormcloak camp";
			case M::kDoomstone: return "standing stone";
			case M::kWheatMill: return "mill";
			case M::kSmelter: return "smelter";
			case M::kStable: return "stable";
			case M::kImperialTower: return "tower";
			case M::kClearing: return "clearing";
			case M::kPass: return "pass";
			case M::kAltar: return "altar";
			case M::kRock: return "rock";
			case M::kLighthouse: return "lighthouse";
			case M::kOrcStronghold: return "orc stronghold";
			case M::kGiantCamp: return "giant camp";
			case M::kShack: return "shack";
			case M::kNordicTower: return "tower";
			case M::kNordicDwelling: return "dwelling";
			case M::kDocks: return "docks";
			case M::kShrine: return "shrine";
			case M::kRiftenCastle: return "castle";
			case M::kRiftenCapitol: return "capitol";
			case M::kWindhelmCastle: return "castle";
			case M::kWindhelmCapitol: return "capitol";
			case M::kWhiterunCastle: return "castle";
			case M::kWhiterunCapitol: return "capitol";
			case M::kSolitudeCastle: return "castle";
			case M::kSolitudeCapitol: return "capitol";
			case M::kMarkarthCastle: return "castle";
			case M::kMarkarthCapitol: return "capitol";
			case M::kWinterholdCastle: return "castle";
			case M::kWinterholdCapitol: return "capitol";
			case M::kMorthalCastle: return "castle";
			case M::kMorthalCapitol: return "capitol";
			case M::kFalkreathCastle: return "castle";
			case M::kFalkreathCapitol: return "capitol";
			case M::kDawnstarCastle: return "castle";
			case M::kDawnstarCapitol: return "capitol";
			default: return "place";
			}
		}

		std::string FullNameOf(RE::TESForm* form)
		{
			if (!form)
				return {};
			if (auto* fn = form->As<RE::TESFullName>()) {
				const char* n = fn->GetFullName();
				if (n && *n)
					return n;
			}
			return {};
		}

		void EnsureIndex()
		{
			if (g_built)
				return;
			g_built = true;
			LoadSettings();
			const auto t0 = std::chrono::steady_clock::now();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			std::unordered_map<const RE::TESFile*, std::uint16_t> pmap;
			g_cells.reserve(8192);
			std::uint32_t skippedAnonymous = 0;
			std::unordered_set<RE::FormID> indexed;
			for (auto* cell : dh->interiorCells) {
				// The array iterates to CAPACITY: holes are null, not the end.
				if (!cell)
					continue;
				auto* file = OwnerFile(dh, cell->GetFormID());
				if (!file)
					continue;  // dynamic (0xFF…) — not a durable place
				Cell c;
				c.formId = cell->GetFormID();
				c.localId = c.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				c.plug = PlugIndexFor(file, pmap);
				const char* nm = cell->GetFullName();
				const char* ed = cell->GetFormEditorID();
				c.name = (nm && *nm) ? nm : "";
				c.edid = (ed && *ed) ? ed : "";
				if (c.name.empty() && c.edid.empty()) {
					// Nothing to search by and nothing to travel with: a row
					// here would be a blank line the player cannot act on.
					++skippedAnonymous;
					continue;
				}
				c.loc = FullNameOf(cell->GetLocation());
				const auto f = cell->cellFlags;
				c.pub = f.any(RE::TESObjectCELL::Flag::kPublicArea);
				c.water = f.any(RE::TESObjectCELL::Flag::kHasWater);
				c.travel = f.any(RE::TESObjectCELL::Flag::kCanTravelFromHere);
				c.warn = f.any(RE::TESObjectCELL::Flag::kWarnToLeave);
				c.lname = Lower(c.name);
				c.ledid = Lower(c.edid);
				c.lloc = Lower(c.loc);
				g_plugins[c.plug].count++;
				indexed.insert(c.formId);
				g_cells.push_back(std::move(c));
			}
			const std::size_t interiors = g_cells.size();

			// (b) exterior cells that kept an editor id — the game's own editor-id
			// map is exactly what `coc` resolves against (the Places module's
			// walk), so every row added here is one coc can reach. Nameless grid
			// squares never have one, so this stays a short list of real places.
			{
				const auto [map, lock] = RE::TESForm::GetAllFormsByEditorID();
				const RE::BSReadLockGuard l{ lock.get() };
				if (map) {
					for (const auto& entry : *map) {
						RE::TESForm* form = entry.second;
						if (!form || form->GetFormType() != RE::FormType::Cell)
							continue;
						auto* cell = static_cast<RE::TESObjectCELL*>(form);
						if (cell->IsDeleted() || cell->IsInteriorCell())
							continue;
						if (indexed.count(cell->GetFormID()))
							continue;
						auto* file = OwnerFile(dh, cell->GetFormID());
						if (!file)
							continue;
						const char* ed = cell->GetFormEditorID();
						if (!ed || !*ed)
							continue;
						Cell c;
						c.formId = cell->GetFormID();
						c.localId = c.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
						c.plug = PlugIndexFor(file, pmap);
						const char* nm = cell->GetFullName();
						c.name = (nm && *nm) ? nm : "";
						c.edid = ed;
						c.exterior = true;
						if (auto* ws = cell->GetRuntimeData().worldSpace) {
							const char* wn = ws->GetFullName();
							c.loc = (wn && *wn) ? wn : (ws->GetFormEditorID() ? ws->GetFormEditorID() : "");
						}
						const auto f = cell->cellFlags;
						c.pub = f.any(RE::TESObjectCELL::Flag::kPublicArea);
						c.water = f.any(RE::TESObjectCELL::Flag::kHasWater);
						c.travel = f.any(RE::TESObjectCELL::Flag::kCanTravelFromHere);
						c.warn = f.any(RE::TESObjectCELL::Flag::kWarnToLeave);
						c.lname = Lower(c.name);
						c.ledid = Lower(c.edid);
						c.lloc = Lower(c.loc);
						g_plugins[c.plug].count++;
						indexed.insert(c.formId);
						g_cells.push_back(std::move(c));
					}
				}
			}
			const std::size_t exteriors = g_cells.size() - interiors;

			// (c) map markers: every persistent ref carrying ExtraMapMarker in every
			// worldspace — Whiterun, Bannermist Tower, a mod's new town. Listed
			// whether or not discovered / enabled, and flagged, never hidden.
			std::size_t markers = 0;
			for (auto* ws : dh->GetFormArray<RE::TESWorldSpace>()) {
				if (!ws)
					continue;
				auto* pc = ws->persistentCell;
				if (!pc)
					continue;
				const char* wsName = ws->GetFullName();
				const std::string wsLabel = (wsName && *wsName) ? wsName :
				                            (ws->GetFormEditorID() ? ws->GetFormEditorID() : "");
				for (const auto& rp : pc->GetRuntimeData().references) {
					RE::TESObjectREFR* ref = rp.get();
					if (!ref || ref->IsDeleted())
						continue;
					const auto* mm = ref->extraList.GetByType<RE::ExtraMapMarker>();
					if (!mm || !mm->mapData)
						continue;
					const char* nm = mm->mapData->locationName.GetFullName();
					if (!nm || !*nm)
						continue;
					auto* file = OwnerFile(dh, ref->GetFormID());
					if (!file)
						continue;  // a runtime-placed marker has no durable identity
					if (!indexed.insert(ref->GetFormID()).second)
						continue;
					Cell c;
					c.formId = ref->GetFormID();
					c.localId = c.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
					c.plug = PlugIndexFor(file, pmap);
					c.name = nm;
					c.marker = true;
					c.loc = wsLabel;
					c.mtype = MarkerTypeName(mm->mapData->type.get());
					c.visible = mm->mapData->flags.any(RE::MapMarkerData::Flag::kVisible);
					c.disabled = ref->IsDisabled();
					c.lname = Lower(c.name);
					c.lloc = Lower(c.loc);
					c.lmtype = Lower(c.mtype);
					g_plugins[c.plug].count++;
					g_cells.push_back(std::move(c));
					++markers;
				}
			}
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			logger::info("cell-finder: index built - {} interior cells + {} exterior cells + {} map markers across {} plugins in {} ms ({} unnamed+unidentified skipped)",
				interiors, exteriors, markers, g_plugins.size(), ms, skippedAnonymous);
			logger::info("cell-finder: COC cells and map markers have separate filters and travel methods");
		}

		// ---------------------------------------------------------- queries --
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

		/* 0 best, -1 no match — the NPC roster's ranking, re-weighted for a list
		 * where the NAME is the rarer field: a full-name hit always outranks an
		 * editor-id hit, and the editor id outranks the location and the plugin.
		 * "sleeping giant" should find the inn before every cell in a mod whose
		 * name happens to contain "giant". */
		int TokenScore(const Cell& c, const Plugin& pl, const std::string& tok)
		{
			if (!c.lname.empty()) {
				const auto pos = c.lname.find(tok);
				if (pos == 0)
					return 0;
				if (pos != std::string::npos) {
					const char before = c.lname[pos - 1];
					if (before == ' ' || before == '(' || before == '\'' || before == '-')
						return 1;
					return 2;
				}
			}
			if (!c.ledid.empty()) {
				const auto pos = c.ledid.find(tok);
				if (pos == 0)
					return 3;
				if (pos != std::string::npos)
					return 4;
			}
			if (!c.lloc.empty() && c.lloc.find(tok) != std::string::npos)
				return 5;
			if (c.marker && !c.lmtype.empty() && c.lmtype.find(tok) != std::string::npos)
				return 5;   // "tower", "cave" — the marker's kind is a real handle
			if (pl.lower.find(tok) != std::string::npos)
				return 6;
			return -1;
		}

		// ------------------------------------------------------------ resolve --
		RE::TESForm* ResolveForm(const std::string& id, const Cell** rowOut)
		{
			if (rowOut)
				*rowOut = nullptr;
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return nullptr;
			const std::string   plugin = id.substr(0, bar);
			const std::uint32_t local = static_cast<std::uint32_t>(
				std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !local)
				return nullptr;
			// The indexed row carries the editor id `coc` needs, so find it too —
			// by identity, never by scanning names.
			if (rowOut) {
				const std::string plow = Lower(plugin);
				for (const auto& c : g_cells) {
					if (c.localId == local && g_plugins[c.plug].lower == plow) {
						*rowOut = &c;
						break;
					}
				}
			}
			return dh->LookupForm(local, plugin);
		}

		RE::TESObjectCELL* ResolveId(const std::string& id, const Cell** rowOut)
		{
			auto* form = ResolveForm(id, rowOut);
			return form ? form->As<RE::TESObjectCELL>() : nullptr;
		}

		// The marker's live facts: the same idiom as DetailForCell, for a REFR.
		json DetailForMarker(RE::TESObjectREFR* ref, const Cell* row)
		{
			json d = json::object();
			d["marker"] = true;
			if (row) {
				d["type"] = row->mtype;
				d["worldspace"] = row->loc;
				d["plugin"] = g_plugins[row->plug].name;
			}
			if (ref) {
				bool vis = row ? row->visible : false;
				if (const auto* mm = ref->extraList.GetByType<RE::ExtraMapMarker>(); mm && mm->mapData)
					vis = mm->mapData->flags.any(RE::MapMarkerData::Flag::kVisible);
				d["discovered"] = vis;
				d["enabled"] = !ref->IsDisabled();
				char fid[16];
				std::snprintf(fid, sizeof(fid), "%08X", ref->GetFormID());
				d["formId"] = std::string("0x") + fid;
			}
			return d;
		}

		// A row's display label: the name when it has one, else the editor id.
		// The ONE place this choice is made, so every log line, notification and
		// refusal names a cell the same way the row does.
		std::string LabelOf(const Cell& c)
		{
			return c.name.empty() ? c.edid : c.name;
		}

		// ------------------------------------------------------------- detail --
		// LIVE facts, one cell at a time, on demand — deliberately not part of
		// the index walk. Every read is null-guarded: a third-party plugin can
		// hand us a cell with a malformed owner, and a detail block missing a
		// field beats one that crashes.
		json DetailForCell(RE::TESObjectCELL* cell, const Cell* row)
		{
			json d = json::object();
			if (!cell)
				return d;
			// Owner: a faction (the Companions' quarters) or a person (someone's
			// house). Without one, walking in is nobody's business — which is a
			// different statement from "public area", and both are shown.
			std::string owner;
			std::string ownerKind;
			if (auto* fac = cell->GetFactionOwner()) {
				owner = FullNameOf(fac);
				ownerKind = "faction";
			} else if (auto* npc = cell->GetActorOwner()) {
				owner = FullNameOf(npc);
				ownerKind = "person";
			}
			d["owner"] = owner;
			d["ownerKind"] = ownerKind;
			d["attached"] = cell->IsAttached();
			// Are you standing in it right now? Honest, and it is the one case
			// where travelling is pointless.
			bool here = false;
			if (auto* player = RE::PlayerCharacter::GetSingleton())
				here = player->GetParentCell() == cell;
			d["here"] = here;
			char fid[16];
			std::snprintf(fid, sizeof(fid), "%08X", cell->GetFormID());
			d["formId"] = std::string("0x") + fid;
			if (row) {
				d["edid"] = row->edid;
				d["loc"] = row->loc;
				d["plugin"] = g_plugins[row->plug].name;
			}
			return d;
		}
	}

	std::string StateJson()
	{
		EnsureIndex();
		json plugs = json::array();
		for (const auto& p : g_plugins) {
			if (!p.count)
				continue;
			plugs.push_back(json{ { "n", p.name }, { "c", p.count }, { "k", p.ext }, { "l", p.light } });
		}
		return Dump(json{
			{ "phase", "ready" },
			{ "count", g_cells.size() },
			{ "pageSize", g_pageSize },
			{ "plugins", std::move(plugs) },
		});
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}

		// --- detail path: expand ONE row (lazy, on demand). Same reply as a
		// page, distinguished by the `detail` field — no extra listener.
		if (in.contains("detail")) {
			const int         seq = in.value("seq", 0);
			const std::string id = in.value("detail", std::string(""));
			const Cell*       row = nullptr;
			auto*             form = ResolveForm(id, &row);
			if (row && row->marker) {
				auto* ref = form ? form->As<RE::TESObjectREFR>() : nullptr;
				return Dump(json{ { "seq", seq }, { "detail", id }, { "info", DetailForMarker(ref, row) } });
			}
			auto* cell = form ? form->As<RE::TESObjectCELL>() : nullptr;
			if (!cell) {
				logger::info("cell-finder-detail: unresolved '{}'", id);
				return Dump(json{ { "seq", seq }, { "detail", id }, { "info", json::object() },
					{ "err", "That cell is not in the load order any more" } });
			}
			return Dump(json{ { "seq", seq }, { "detail", id }, { "info", DetailForCell(cell, row) } });
		}

		const std::string q = in.value("q", std::string(""));
		const std::string type = in.value("type", std::string("all"));
		const std::string plugin = in.value("plugin", std::string(""));
		const int         seq = in.value("seq", 0);
		const int         offset = (std::max)(0, in.value("offset", 0));
		// The view's chosen page size arrives as `limit` (1..100 selector). A
		// request WITHOUT it is an OLD view — default to 60, so DLL and view can
		// deploy independently.
		const int         limit = std::clamp(in.value("limit", 60), 1, 100);

		const auto tokens = Tokens(q);
		const auto plugLower = Lower(plugin);

		struct Hit { int score; std::uint32_t idx; };
		std::vector<Hit> hits;
		hits.reserve(1024);

		for (std::uint32_t i = 0; i < g_cells.size(); ++i) {
			const Cell& c = g_cells[i];
			if (type == "coc" && (c.marker || c.edid.empty()))
				continue;
			if (type == "markers" && !c.marker)
				continue;
			if (type == "named" && c.name.empty())
				continue;
			if (type == "unnamed" && !c.name.empty())
				continue;
			const Plugin& pl = g_plugins[c.plug];
			if (!plugLower.empty() && pl.lower != plugLower)
				continue;
			int  score = 0;
			bool okAll = true;
			for (const auto& tok : tokens) {
				const int s = TokenScore(c, pl, tok);
				if (s < 0) { okAll = false; break; }
				score += s;
			}
			if (!okAll)
				continue;
			hits.push_back(Hit{ score, i });
		}

		const bool browse = tokens.empty();
		std::sort(hits.begin(), hits.end(), [browse](const Hit& a, const Hit& b) {
			const Cell& x = g_cells[a.idx];
			const Cell& y = g_cells[b.idx];
			if (browse) {
				// A plugin's roster reads named-places-first: those are the ones
				// a player recognises, and the editor-id rows are the plumbing.
				if (x.name.empty() != y.name.empty())
					return !x.name.empty();
				return (x.name.empty() ? x.ledid : x.lname) <
				       (y.name.empty() ? y.ledid : y.lname);
			}
			if (a.score != b.score)
				return a.score < b.score;
			if (x.name.empty() != y.name.empty())
				return !x.name.empty();   // a real name beats an editor id at equal score
			const std::string& xs = x.name.empty() ? x.ledid : x.lname;
			const std::string& ys = y.name.empty() ? y.ledid : y.lname;
			if (xs.size() != ys.size())
				return xs.size() < ys.size();   // "Bleak Falls Barrow" over "…Barrow 02"
			return xs < ys;
		});

		json      items = json::array();
		const int total = static_cast<int>(hits.size());
		for (int i = offset; i < total && i < offset + limit; ++i) {
			const Cell&   c = g_cells[hits[static_cast<std::size_t>(i)].idx];
			const Plugin& pl = g_plugins[c.plug];
			char idbuf[16];
			std::snprintf(idbuf, sizeof(idbuf), "%06X", c.localId);
			json row = json{
				{ "id", pl.name + "|" + idbuf },
				{ "n", c.name },
				{ "e", c.edid },
				{ "p", pl.name },
				{ "loc", c.loc },
				{ "pub", c.pub },
				{ "wt", c.water },
				{ "tv", c.travel },
				{ "wn", c.warn },
			};
			if (c.exterior)
				row["ext"] = true;
			if (c.marker) {
				row["mk"] = true;        // an old view ignores these and shows a Go-less row
				row["mt"] = c.mtype;
				row["vis"] = c.visible;
				row["dis"] = c.disabled;
			}
			items.push_back(std::move(row));
		}
		return Dump(json{
			{ "seq", seq }, { "total", total }, { "offset", offset }, { "items", std::move(items) } });
	}

	std::string ActJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string act = in.value("act", std::string(""));
		const std::string id = in.value("id", std::string(""));

		auto fail = [&act](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "act", act }, { "found", false }, { "msg", msg } });
		};

		if (act != "go")
			return fail("Unknown action");

		const Cell* row = nullptr;
		auto*       form = ResolveForm(id, &row);
		if (row && row->marker) {
			auto* ref = form ? form->As<RE::TESObjectREFR>() : nullptr;
			if (!ref)
				return fail("That map marker is not in the load order any more");
			return Dump(json{ { "ok", true }, { "act", act }, { "found", true },
				{ "msg", "Traveling to " + LabelOf(*row) } });
		}
		auto* cell = form ? form->As<RE::TESObjectCELL>() : nullptr;
		if (!cell || !row)
			return fail("That cell is not in the load order any more");
		if (row->edid.empty())
			// coc addresses a cell by editor id and nothing else. A cell without
			// one cannot be travelled to — say that, rather than running a
			// command that would do nothing.
			return fail(LabelOf(*row) + " has no editor id, so the console cannot name it \xE2\x80\x94 "
			            "mark it as a Domain while you are there instead");
		if (auto* player = RE::PlayerCharacter::GetSingleton(); player && player->GetParentCell() == cell)
			return fail("You are already standing in " + LabelOf(*row));

		// Physical travel happens after ClosePalette() — main.cpp calls
		// ExecuteTravel. This reply just says "close and go".
		return Dump(json{ { "ok", true }, { "act", act }, { "found", true },
			{ "msg", "Traveling to " + LabelOf(*row) } });
	}

	std::string ExecuteTravel(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));

		const Cell* row = nullptr;
		auto*       form = ResolveForm(id, &row);
		if (row && row->marker) {
			// A map marker has no cell to coc into: the Places module's road is
			// player.moveto the marker REFR — the engine loads whatever exterior
			// grid that ref stands in. marker: cell-finder-markers
			auto* ref = form ? form->As<RE::TESObjectREFR>() : nullptr;
			if (!ref)
				return "Cell Finder: travel failed";
			char fid[16];
			std::snprintf(fid, sizeof(fid), "%08X", ref->GetFormID());
			ConsoleActions::Fire("Cell Finder", std::string("player.moveto ") + fid, false);
			logger::info("cell-finder: moveto '{}' ({}, map marker)", fid, id);
			return "\xE2\xA4\x9E " + LabelOf(*row);  // ⤞
		}
		auto* cell = form ? form->As<RE::TESObjectCELL>() : nullptr;
		if (!cell || !row || row->edid.empty())
			return "Cell Finder: travel failed";
		// The deck's own play-proven console verb, global target — `coc` takes
		// the cell's editor id and runs the engine's whole cell-transition
		// sequence, which is the only thing that works for a cell nobody has
		// ever been to.
		ConsoleActions::Fire("Cell Finder", "coc " + row->edid, false);
		logger::info("cell-finder: coc '{}' ({})", row->edid, id);
		return "\xE2\xA4\x9E " + LabelOf(*row);  // ⤞
	}

	std::string SaveJson(const std::string& req)
	{
		LoadSettings();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (in.contains("pageSize"))
			g_pageSize = ClampPageSize(in.value("pageSize", g_pageSize));
		SaveSettingsFile();
		return Dump(json{ { "ok", true }, { "pageSize", g_pageSize } });
	}

}
