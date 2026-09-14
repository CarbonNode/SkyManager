// Places — the searchable teleport. See places.h for the contract.

#include "places.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <string>
#include <unordered_set>
#include <vector>
// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

namespace Places
{
	using json = nlohmann::json;

	namespace
	{
		struct Row
		{
			bool        marker = false;
			std::string name;      // full name ("Crystaldrift Cave"); may be empty for a cell
			std::string edid;      // cell editor ID (cells only)
			std::string id;        // 8-hex ref FormID (markers only)
			std::string where;     // owning plugin (cells) / worldspace name (markers)
			std::string type;      // marker type word ("cave", "city", …)
			bool        visible = false;   // marker: discovered on the map
			bool        disabled = false;  // marker: ref not enabled yet (quest-gated)
			// lowercase haystacks, split so the scorer can rank a NAME hit above
			// a plugin hit
			std::string lname;     // name + name-without-spaces
			std::string ledid;
			std::string lwhere;    // where + type
		};

		std::vector<Row> g_rows;
		bool             g_built = false;

		std::string Lower(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		std::string NoSpaces(const std::string& s)
		{
			std::string out;
			out.reserve(s.size());
			for (const char c : s)
				if (c != ' ' && c != '\'' && c != '-')
					out += c;
			return out;
		}

		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return {};
			const auto* file = form->GetFile(0);
			if (!file)
				return {};
			return std::string(file->GetFilename());
		}

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
			case M::kNordicTower: return "nordic tower";
			case M::kNordicDwelling: return "dwelling";
			case M::kDocks: return "docks";
			case M::kShrine: return "shrine";
			case M::kRiftenCastle: case M::kWindhelmCastle: case M::kWhiterunCastle:
			case M::kSolitudeCastle: case M::kMarkarthCastle: case M::kWinterholdCastle:
			case M::kMorthalCastle: case M::kFalkreathCastle: case M::kDawnstarCastle:
				return "castle";
			case M::kRiftenCapitol: case M::kWindhelmCapitol: case M::kWhiterunCapitol:
			case M::kSolitudeCapitol: case M::kMarkarthCapitol: case M::kWinterholdCapitol:
			case M::kMorthalCapitol: case M::kFalkreathCapitol: case M::kDawnstarCapitol:
				return "capital";
			case M::kDLC02MiraakTemple: return "temple";
			case M::kDLC02RavenRock: return "town";
			case M::kDLC02StandingStone: return "standing stone";
			case M::kDLC02TelvanniTower: return "tower";
			case M::kDLC02ToSkyrim: case M::kDLC02ToSolstheim: return "boat";
			case M::kDLC02CastleKarstaag: return "castle";
			case M::kDoor: return "door";
			default: return "place";
			}
		}

		void FinishRow(Row& r)
		{
			r.lname = Lower(r.name);
			if (!r.name.empty())
				r.lname += " " + Lower(NoSpaces(r.name));
			r.ledid = Lower(r.edid);
			r.lwhere = Lower(r.where) + " " + r.type;
		}

		void AddCell(RE::TESObjectCELL* cell, std::unordered_set<RE::FormID>& seen)
		{
			if (!cell || cell->IsDeleted())
				return;
			const char* eid = cell->GetFormEditorID();
			if (!eid || !*eid)
				return;
			if (!seen.insert(cell->GetFormID()).second)
				return;
			Row r;
			r.edid = eid;
			if (const char* nm = cell->GetFullName(); nm && *nm)
				r.name = nm;
			r.where = PluginOf(cell);
			FinishRow(r);
			g_rows.emplace_back(std::move(r));
		}

		void Build()
		{
			const auto t0 = std::chrono::steady_clock::now();
			g_rows.clear();
			g_built = true;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh) {
				logger::warn("places: no data handler; index is empty");
				return;
			}

			std::unordered_set<RE::FormID> seen;
			// (1) every CELL that kept an editor ID — the map `coc` itself resolves
			// against, so a listed cell is by construction one `coc` can reach.
			{
				const auto [map, lock] = RE::TESForm::GetAllFormsByEditorID();
				const RE::BSReadLockGuard l{ lock.get() };
				if (map) {
					for (const auto& entry : *map) {
						RE::TESForm* form = entry.second;
						if (!form || form->GetFormType() != RE::FormType::Cell)
							continue;
						AddCell(static_cast<RE::TESObjectCELL*>(form), seen);
					}
				}
			}
			const std::size_t fromMap = g_rows.size();
			// (2) belt and braces: the handler's own interior list, for any cell
			// the map somehow missed (an editor ID set after the map filled).
			for (auto* cell : dh->interiorCells)
				AddCell(cell, seen);
			const std::size_t cells = g_rows.size();

			// (3) map markers: persistent refs of every worldspace carrying
			// ExtraMapMarker. Listed whether or not discovered/enabled — flagged.
			std::size_t markers = 0;
			for (auto* ws : dh->GetFormArray<RE::TESWorldSpace>()) {
				if (!ws)
					continue;
				auto* pc = ws->persistentCell;
				if (!pc)
					continue;
				const char* wsName = ws->GetFullName();
				std::string wsLabel = (wsName && *wsName) ? wsName :
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
					Row r;
					r.marker = true;
					r.name = nm;
					char buf[16];
					std::snprintf(buf, sizeof(buf), "%08X", ref->GetFormID());
					r.id = buf;
					r.where = wsLabel;
					r.type = MarkerTypeName(mm->mapData->type.get());
					r.visible = mm->mapData->flags.any(RE::MapMarkerData::Flag::kVisible);
					r.disabled = ref->IsDisabled();
					FinishRow(r);
					g_rows.emplace_back(std::move(r));
					++markers;
				}
			}
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			// marker: places-index
			logger::info("places: indexed {} cells ({} via the editor-ID map) + {} map markers in {} ms",
				cells, fromMap, markers, ms);
		}

		// ranking: exact > prefix > word-prefix > substring, on the NAME or the
		// EDITOR ID; a hit only in the plugin/worldspace/type counts for little.
		// Every query word must land somewhere or the row is out.
		int ScoreWord(const Row& r, const std::string& w)
		{
			int best = 0;
			// plain comparisons on purpose: <windows.h>'s max() macro is live in
			// this TU and turns a std max/min call into a syntax error
			const auto lift = [&](int v) { if (v > best) best = v; };
			const auto scoreIn = [&](const std::string& t, int exact, int prefix, int wordPrefix, int sub) {
				if (t.empty())
					return;
				if (t == w) { lift(exact); return; }
				if (t.compare(0, w.size(), w) == 0) { lift(prefix); return; }
				const auto at = t.find(w);
				if (at == std::string::npos || at == 0)
					return;
				const char before = t[at - 1];
				if (before == ' ' || before == '_' || before == '-' || before == '/')
					lift(wordPrefix);
				else
					lift(sub);
			};
			scoreIn(r.lname, 100, 60, 40, 25);
			scoreIn(r.ledid, 90, 55, 35, 22);
			scoreIn(r.lwhere, 12, 10, 8, 6);
			return best;
		}

		json RowJson(const Row& r)
		{
			json j;
			j["n"] = r.name;
			if (r.marker) {
				j["k"] = "m";
				j["id"] = r.id;
				j["w"] = r.where;
				j["t"] = r.type;
				j["v"] = r.visible;
				j["d"] = r.disabled;
			} else {
				j["k"] = "c";
				j["e"] = r.edid;
				j["p"] = r.where;
			}
			return j;
		}

		// The same Script-factory run the console-command entries use
		// (console_actions.cpp): the system-window compiler accepts every
		// console verb, `coc` and `player.moveto` included.
		void RunConsole(const std::string& cmd)
		{
			auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
			auto* script = factory ? factory->Create() : nullptr;
			if (!script) {
				logger::warn("places: no Script factory; '{}' not run", cmd);
				return;
			}
			script->SetCommand(cmd);
			script->CompileAndRun(nullptr);
			delete script;
		}
	}

	void Reset()
	{
		g_rows.clear();
		g_built = false;
	}

	std::string QueryJson(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = in.value("q", std::string(""));
		const auto        seq = in.value("seq", 0);
		int               limit = in.value("limit", 40);
		limit = std::clamp(limit, 1, 200);

		if (!g_built)
			Build();

		json out;
		out["seq"] = seq;
		out["q"] = q;
		out["count"] = g_rows.size();
		out["rows"] = json::array();

		// words
		std::vector<std::string> words;
		{
			std::string cur;
			for (const char c : Lower(q)) {
				if (c == ' ' || c == '\t') {
					if (!cur.empty()) { words.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				words.push_back(cur);
		}
		if (words.empty()) {
			out["total"] = 0;
			return out.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		struct Hit { int score; const Row* row; };
		std::vector<Hit> hits;
		for (const auto& r : g_rows) {
			int total = 0;
			bool all = true;
			for (const auto& w : words) {
				const int s = ScoreWord(r, w);
				if (s <= 0) { all = false; break; }
				total += s;
			}
			if (!all)
				continue;
			// tie-breaks: a named cell over an unnamed one, a discovered marker
			// over an undiscovered one, an enabled marker over a gated one, and
			// the shorter label first among equals
			if (!r.name.empty()) total += 3;
			if (r.marker && r.visible) total += 2;
			if (r.marker && r.disabled) total -= 4;
			const std::size_t len = r.name.empty() ? r.edid.size() : r.name.size();
			total = total * 64 - static_cast<int>(len < 60 ? len : 60);
			hits.push_back({ total, &r });
		}
		std::stable_sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.score > b.score; });
		out["total"] = hits.size();
		const std::size_t n = hits.size() < static_cast<std::size_t>(limit) ? hits.size() : static_cast<std::size_t>(limit);
		for (std::size_t i = 0; i < n; ++i)
			out["rows"].push_back(RowJson(*hits[i].row));
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Go(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string kind = in.value("kind", std::string(""));
		const std::string label = in.value("label", std::string(""));

		if (kind == "cell") {
			const std::string edid = in.value("edid", std::string(""));
			if (edid.empty() || edid.find_first_of(" \t\r\n\"") != std::string::npos) {
				logger::warn("places: refused cell edid '{}'", edid);
				return "Places: that isn't a cell name";
			}
			auto* cell = RE::TESForm::LookupByEditorID<RE::TESObjectCELL>(edid);
			if (!cell) {
				logger::warn("places: no cell with editor ID '{}'", edid);
				return "Places: no cell called " + edid + " in this load order";
			}
			const std::string cmd = "coc " + edid;
			logger::info("places: go cell '{}' -> \"{}\"", label.empty() ? edid : label, cmd);  // marker: places-go
			RunConsole(cmd);
			const char* nm = cell->GetFullName();
			return "\xE2\xA4\x9E " + std::string((nm && *nm) ? nm : edid.c_str()) + "  (" + cmd + ")";
		}
		if (kind == "marker") {
			const std::string idText = in.value("id", std::string(""));
			std::uint32_t     id = 0;
			try {
				id = static_cast<std::uint32_t>(std::stoul(idText, nullptr, 16));
			} catch (...) {}
			auto* ref = id ? RE::TESForm::LookupByID<RE::TESObjectREFR>(id) : nullptr;
			if (!ref) {
				logger::warn("places: no marker ref {}", idText);
				return "Places: that map marker isn't in this load order any more";
			}
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08X", ref->GetFormID());
			const std::string cmd = std::string("player.moveto ") + buf;
			std::string name = label;
			if (const auto* mm = ref->extraList.GetByType<RE::ExtraMapMarker>(); mm && mm->mapData) {
				if (const char* nm = mm->mapData->locationName.GetFullName(); nm && *nm)
					name = nm;
			}
			logger::info("places: go marker '{}' -> \"{}\"", name, cmd);
			RunConsole(cmd);
			return "\xE2\xA4\x9E " + (name.empty() ? std::string(buf) : name);
		}
		logger::warn("places: unknown kind '{}'", kind);
		return {};
	}
}
