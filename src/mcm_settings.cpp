#include "mcm_settings.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace McmSettings
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string Trim(std::string s)
		{
			const char* ws = " \t\r\n";
			const auto a = s.find_first_not_of(ws);
			if (a == std::string::npos)
				return {};
			const auto b = s.find_last_not_of(ws);
			return s.substr(a, b - a + 1);
		}

		using IniMap = std::unordered_map<std::string, std::string>;

		/* "section:key" -> value, lower-cased. Same shape keys_scan uses, so the
		   two agree about what a settings file says. */
		void LoadIni(const std::filesystem::path& path, IniMap& out)
		{
			std::ifstream in(path);
			if (!in)
				return;
			std::string line, section = "main";
			while (std::getline(in, line)) {
				line = Trim(line);
				if (line.empty() || line[0] == ';' || line[0] == '#')
					continue;
				if (line.front() == '[' && line.back() == ']') {
					section = Lower(line.substr(1, line.size() - 2));
					continue;
				}
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				out[section + ":" + Lower(Trim(line.substr(0, eq)))] = Trim(line.substr(eq + 1));
			}
		}

		/* $Label -> translated text. MCM translation files are UTF-16LE (all 135
		   on this rig are — verified by keys_scan's own dry run). */
		using TransMap = std::unordered_map<std::string, std::string>;

		TransMap LoadTranslations(const std::string& modName)
		{
			TransMap out;
			std::ifstream in("Data/Interface/Translations/" + modName + "_ENGLISH.txt",
				std::ios::binary);
			if (!in)
				return out;
			std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			std::string text;
			if (raw.size() >= 2 && static_cast<unsigned char>(raw[0]) == 0xFF &&
				static_cast<unsigned char>(raw[1]) == 0xFE) {
				for (std::size_t i = 2; i + 1 < raw.size(); i += 2) {
					const auto lo = static_cast<unsigned char>(raw[i]);
					const auto hi = static_cast<unsigned char>(raw[i + 1]);
					text.push_back(hi == 0 ? static_cast<char>(lo) : '?');
				}
			} else {
				text = raw;
			}
			std::size_t pos = 0;
			while (pos < text.size()) {
				auto eol = text.find('\n', pos);
				if (eol == std::string::npos)
					eol = text.size();
				auto line = Trim(text.substr(pos, eol - pos));
				pos = eol + 1;
				if (line.empty() || line[0] != '$')
					continue;
				const auto tab = line.find('\t');
				if (tab == std::string::npos)
					continue;
				out[Trim(line.substr(0, tab))] = Trim(line.substr(tab + 1));
			}
			return out;
		}

		std::string Translate(const TransMap& t, const std::string& s)
		{
			if (s.empty() || s[0] != '$')
				return s;
			if (const auto it = t.find(s); it != t.end())
				return it->second;
			return s.substr(1);   // a missing translation reads better than "$key"
		}

		/* ── the model ──────────────────────────────────────────────────── */

		struct Row
		{
			int           idx{ 0 };
			std::string   label, type, source, setting;
			// GlobalValue rows only
			std::string   gPlugin;
			std::uint32_t gLocal{ 0 };
			// ini-backed rows carry their parsed value
			bool          hasIni{ false };
			double        iniVal{ 0.0 };
			bool          readable{ false }, writable{ false };
			std::string   why;
			double        vmin{ 0 }, vmax{ 0 }, vstep{ 0 };
			std::vector<std::string> options;
		};

		struct Page { std::string name; std::vector<Row> rows; };
		struct Mod  { std::string id, name; std::vector<Page> pages; };

		std::mutex        g_m;
		std::vector<Mod>  g_mods;
		bool              g_scanned = false;

		/* "Plugin.esp|0x1234" — MCM Helper's own spelling for a form. */
		bool ParseForm(const std::string& s, std::string& plugin, std::uint32_t& local)
		{
			const auto bar = s.find('|');
			if (bar == std::string::npos)
				return false;
			plugin = Trim(s.substr(0, bar));
			const auto idTxt = Trim(s.substr(bar + 1));
			try {
				local = static_cast<std::uint32_t>(std::stoul(idTxt, nullptr, 16));
			} catch (...) {
				return false;
			}
			return !plugin.empty();
		}

		void BuildRow(const json& c, const TransMap& trans, const IniMap& ini, Row& r)
		{
			r.type = c.value("type", "");
			r.label = Translate(trans, c.value("text", ""));
			const auto& vo = c.contains("valueOptions") && c["valueOptions"].is_object()
				? c["valueOptions"] : json::object();
			r.source = vo.value("sourceType", "");
			r.setting = vo.value("sourceSetting", "");
			if (vo.contains("min"))  r.vmin = vo.value("min", 0.0);
			if (vo.contains("max"))  r.vmax = vo.value("max", 0.0);
			if (vo.contains("step")) r.vstep = vo.value("step", 0.0);
			if (vo.contains("options") && vo["options"].is_array()) {
				for (const auto& o : vo["options"])
					if (o.is_string())
						r.options.push_back(Translate(trans, o.get<std::string>()));
			}

			const auto src = Lower(r.source);
			if (src == "globalvalue") {
				const auto form = vo.value("sourceForm", "");
				if (ParseForm(form, r.gPlugin, r.gLocal)) {
					r.readable = true;
					r.writable = true;      // a global is what the MCM itself writes
				} else {
					r.why = "its form could not be read from the config";
				}
			} else if (src.rfind("modsetting", 0) == 0) {
				// ini-backed: readable from the overlay, deliberately not written
				const auto colon = r.setting.find(':');
				const std::string sect = colon == std::string::npos ? "main"
					: Lower(r.setting.substr(colon + 1));
				const std::string key = colon == std::string::npos ? Lower(r.setting)
					: Lower(r.setting.substr(0, colon));
				if (const auto it = ini.find(sect + ":" + key); it != ini.end()) {
					try {
						r.iniVal = std::stod(it->second);
						r.hasIni = true;
						r.readable = true;
					} catch (...) {
					}
				}
				if (!r.readable)
					r.why = "no saved value on disk yet";
				r.why = r.readable
					? "saved in this mod's settings file — change it in its own MCM"
					: r.why;
			} else if (src.rfind("propertyvalue", 0) == 0) {
				r.why = "lives on the mod's own script, which the deck does not read";
			} else if (!src.empty()) {
				r.why = "unsupported source (" + r.source + ")";
			}
		}

		void ScanLocked()
		{
			g_mods.clear();
			std::error_code ec;
			for (const auto& dir : fs::directory_iterator("Data/MCM/Config", ec)) {
				if (ec)
					break;
				if (!dir.is_directory(ec))
					continue;
				std::ifstream in(dir.path() / "config.json");
				if (!in)
					continue;
				const auto doc = json::parse(in, nullptr, false);
				if (doc.is_discarded() || !doc.is_object())
					continue;

				const auto modName = doc.value("modName", PathU8(dir.path().filename()));
				const auto trans = LoadTranslations(modName);

				IniMap ini;
				LoadIni(dir.path() / "settings.ini", ini);
				LoadIni("Data/MCM/Settings/" + modName + ".ini", ini);

				Mod m;
				m.id = modName;
				m.name = Translate(trans, doc.value("displayName", modName));

				int idx = 0;
				if (doc.contains("pages") && doc["pages"].is_array()) {
					for (const auto& pg : doc["pages"]) {
						if (!pg.is_object())
							continue;
						Page page;
						page.name = Translate(trans, pg.value("pageDisplayName", ""));
						if (pg.contains("content") && pg["content"].is_array()) {
							for (const auto& c : pg["content"]) {
								if (!c.is_object())
									continue;
								const auto t = Lower(c.value("type", ""));
								// only the control kinds that carry a VALUE
								if (t != "toggle" && t != "slider" && t != "enum" &&
									t != "stepper" && t != "text" && t != "color")
									continue;
								Row r;
								r.idx = idx++;
								BuildRow(c, trans, ini, r);
								if (r.source.empty())
									continue;   // a label-only control is not a setting
								page.rows.push_back(std::move(r));
							}
						}
						if (!page.rows.empty())
							m.pages.push_back(std::move(page));
					}
				}
				if (!m.pages.empty())
					g_mods.push_back(std::move(m));
			}
			std::sort(g_mods.begin(), g_mods.end(),
				[](const Mod& a, const Mod& b) { return Lower(a.name) < Lower(b.name); });
			g_scanned = true;
			// Build marker (hd-markers.json: "mcm-settings-scan").
			logger::info("mcm-settings: {} mod(s) with settings", g_mods.size());
		}

		// current value of a row, read LIVE for globals
		bool ValueOf(const Row& r, double& out)
		{
			if (r.writable) {
				auto* dh = RE::TESDataHandler::GetSingleton();
				auto* g = dh ? dh->LookupForm<RE::TESGlobal>(r.gLocal, r.gPlugin) : nullptr;
				if (!g)
					return false;
				out = static_cast<double>(g->value);
				return true;
			}
			if (r.hasIni) {
				out = r.iniVal;
				return true;
			}
			return false;
		}

		json RowJson(const Row& r)
		{
			json o{ { "i", r.idx }, { "label", r.label }, { "type", r.type },
				{ "source", r.source }, { "readable", r.readable }, { "writable", r.writable } };
			if (!r.setting.empty()) o["setting"] = r.setting;
			if (!r.why.empty())     o["why"] = r.why;
			if (r.vmax != 0.0 || r.vmin != 0.0) {
				o["min"] = r.vmin; o["max"] = r.vmax;
				if (r.vstep != 0.0) o["step"] = r.vstep;
			}
			if (!r.options.empty()) o["options"] = r.options;
			double v = 0.0;
			if (ValueOf(r, v))
				o["value"] = v;
			else if (r.readable)
				o["readable"] = false;   // config said readable, engine disagrees
			return o;
		}
	}   // namespace

	void Scan(bool force)
	{
		std::lock_guard lock(g_m);
		if (force || !g_scanned)
			ScanLocked();
	}

	std::string StateJson(bool force)
	{
		std::lock_guard lock(g_m);
		if (force || !g_scanned)
			ScanLocked();

		json mods = json::array();
		int  settings = 0, writable = 0;
		for (const auto& m : g_mods) {
			json pages = json::array();
			for (const auto& p : m.pages) {
				json rows = json::array();
				for (const auto& r : p.rows) {
					rows.push_back(RowJson(r));
					++settings;
					if (r.writable)
						++writable;
				}
				pages.push_back(json{ { "name", p.name }, { "rows", rows } });
			}
			mods.push_back(json{ { "id", m.id }, { "name", m.name }, { "pages", pages } });
		}
		return json{ { "mods", mods }, { "count", settings }, { "writable", writable } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string ValuesJson()
	{
		std::lock_guard lock(g_m);
		json out = json::array();
		for (const auto& m : g_mods) {
			json vals = json::object();
			for (const auto& p : m.pages) {
				for (const auto& r : p.rows) {
					double v = 0.0;
					if (ValueOf(r, v))
						vals[std::to_string(r.idx)] = v;
				}
			}
			out.push_back(json{ { "id", m.id }, { "values", vals } });
		}
		return json{ { "mods", out } }.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Set(const std::string& req)
	{
		json in;
		try {
			in = json::parse(req);
		} catch (...) {
			return json{ { "ok", false }, { "msg", "bad request" } }.dump();
		}
		const auto modId = in.value("mod", "");
		const int  idx = in.value("i", -1);
		const double want = in.value("value", 0.0);

		std::lock_guard lock(g_m);
		for (const auto& m : g_mods) {
			if (m.id != modId)
				continue;
			for (const auto& p : m.pages) {
				for (const auto& r : p.rows) {
					if (r.idx != idx)
						continue;
					if (!r.writable) {
						return json{ { "ok", false },
							{ "msg", r.label + " — " + (r.why.empty()
								? std::string("the deck cannot write this one")
								: r.why) } }.dump();
					}
					auto* dh = RE::TESDataHandler::GetSingleton();
					auto* g = dh ? dh->LookupForm<RE::TESGlobal>(r.gLocal, r.gPlugin) : nullptr;
					if (!g) {
						return json{ { "ok", false },
							{ "msg", r.gPlugin + " is not loaded" } }.dump();
					}
					g->value = static_cast<float>(want);
					// Build marker (hd-markers.json: "mcm-settings-set").
					logger::info("mcm-settings: set {}::{} = {}", m.id, r.label, want);
					return json{ { "ok", true }, { "mod", m.id }, { "i", idx },
						{ "value", want }, { "msg", r.label + " updated" } }.dump();
				}
			}
		}
		return json{ { "ok", false }, { "msg", "unknown setting" } }.dump();
	}

	std::vector<ModControl> ReadModControls(const std::string& modName)
	{
		std::vector<ModControl> out;
		const fs::path dir = fs::path("Data/MCM/Config") / modName;
		std::ifstream  in(dir / "config.json");
		if (!in)
			return out;
		const auto doc = json::parse(in, nullptr, false);
		if (doc.is_discarded() || !doc.is_object())
			return out;
		const auto trans = LoadTranslations(doc.value("modName", modName));
		IniMap ini;
		LoadIni(dir / "settings.ini", ini);
		LoadIni("Data/MCM/Settings/" + doc.value("modName", modName) + ".ini", ini);

		if (!doc.contains("pages") || !doc["pages"].is_array())
			return out;
		for (const auto& pg : doc["pages"]) {
			if (!pg.is_object() || !pg.contains("content") || !pg["content"].is_array())
				continue;
			const auto pageName = Translate(trans, pg.value("pageDisplayName", ""));
			for (const auto& c : pg["content"]) {
				if (!c.is_object())
					continue;
				const auto& vo = c.contains("valueOptions") && c["valueOptions"].is_object()
					? c["valueOptions"] : json::object();
				ModControl m;
				m.source = vo.value("sourceType", "");
				// MCM Helper keys an ini-backed control by its `id`
				// ("key:Section"); `sourceSetting` is the older spelling.
				m.id = c.value("id", vo.value("sourceSetting", ""));
				if (m.id.empty() || Lower(m.source).rfind("modsetting", 0) != 0)
					continue;
				const auto colon = m.id.find(':');
				m.key = colon == std::string::npos ? m.id : m.id.substr(0, colon);
				m.section = colon == std::string::npos ? "Main" : m.id.substr(colon + 1);
				m.label = Translate(trans, c.value("text", ""));
				m.type = c.value("type", "");
				m.page = pageName;
				if (vo.contains("min"))  m.vmin = vo.value("min", 0.0);
				if (vo.contains("max"))  m.vmax = vo.value("max", 0.0);
				if (vo.contains("step")) m.vstep = vo.value("step", 0.0);
				if (vo.contains("defaultValue")) {
					const auto& d = vo["defaultValue"];
					if (d.is_boolean()) { m.def = d.get<bool>() ? 1.0 : 0.0; m.hasDef = true; }
					else if (d.is_number()) { m.def = d.get<double>(); m.hasDef = true; }
				}
				if (vo.contains("options") && vo["options"].is_array())
					for (const auto& o : vo["options"])
						if (o.is_string())
							m.options.push_back(Translate(trans, o.get<std::string>()));
				if (const auto it = ini.find(Lower(m.section) + ":" + Lower(m.key)); it != ini.end()) {
					try {
						m.value = std::stod(it->second);
						m.hasValue = true;
					} catch (...) {
					}
				}
				out.push_back(std::move(m));
			}
		}
		return out;
	}
}
