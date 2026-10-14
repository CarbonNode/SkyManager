#include "ini_mods.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace IniMods
{
	namespace
	{
		using json = nlohmann::json;

		enum class Kind { Toggle, Slider, Enum };

		struct Key
		{
			const char* page;     // the popout's page heading
			const char* section;  // [Section] in the ini
			const char* key;
			Kind        kind;
			const char* label;
			const char* info;
			double      min, max, step, def;
			bool        integer;  // written without a decimal point
			std::vector<const char*> options;  // Enum only: index = stored value
			bool        liveOnly = false;  // only exists in a build that exports Mod::liveExport
		};

		struct Mod
		{
			const char*      id;
			const char*      name;
			const wchar_t*   dll;      // present in the process = the mod is loaded
			const char*      path;     // relative to the game root, like the mod's own
			const char*      smfPage;  // "Section/Item" for SmfIndex::Open, "" = none
			const char*      note;        // a build that reads the ini once (next launch)
			const char*      liveExport;  // an export that means "this build re-reads the ini live", or ""
			const char*      liveNote;    // the note for such a build
			std::vector<Key> keys;
		};

		// IHarvest NG 1.0.8 (github.com/Kexodus/iharvest-ng). Keys, defaults and
		// ranges are read from its src/plugin/Settings.cpp (ForEachKey + Clamp)
		// and its UI/Menu.cpp slider ranges. Labels are the ones its own SMF
		// page uses, so the two menus agree. Where its menu range is narrower
		// than its clamp (the per-wisp costs: menu 0-100, clamp 0-500), the
		// menu's range wins, because that is what its author offers a player.
		const std::vector<Mod>& Table()
		{
			static const std::vector<Mod> kMods = {
				{ "ini:IHarvestNG", "IHarvest NG", L"IHarvestNG.dll", "Data/SKSE/Plugins/IHarvestNG.ini",
				  "IHarvest NG/Settings",
				  "IHarvest NG reads this file when the game starts, so a change here applies on your next "
				  "launch. Its own page in SKSE Menu Framework applies changes live instead. If you change "
				  "something there and close it, it rewrites this whole file from its live values, and any "
				  "edit made here this session is lost.",
				  // Our build (modding/iharvest-ng) re-reads its ini within a second of it changing and
				  // exports IHNG_LiveSettings; upstream 1.0.8 does neither.
				  "IHNG_LiveSettings",
				  "This is the CarbonNode build of IHarvest NG: it re-reads this file within a second of a "
				  "change, so everything here applies live. Its own page in SKSE Menu Framework edits the "
				  "same file.",
				  {
					{ "Casting", "Casting", "fMagickaCostPerWisp", Kind::Slider, "Magicka per wisp (spell)",
					  "Magicka drained for every wisp sent. Alteration cost reduction applies (never below 15%).",
					  0, 100, 1, 8, false },
					{ "Casting", "Casting", "fStaffChargePerWisp", Kind::Slider, "Charge per wisp (staff)",
					  "Enchantment charge drained for every wisp the Staff of Harvest sends.",
					  0, 100, 1, 12, false },
					{ "Casting", "Casting", "fXPPerWisp", Kind::Slider, "Alteration XP per wisp",
					  "Skill-use experience granted for every wisp you send.",
					  0, 100, 1, 10, false },
					{ "Casting", "Casting", "iMaxWisps", Kind::Slider, "Max wisps at once",
					  "Wisps in flight at the same time, across every caster (1-128).",
					  1, 128, 4, 64, true },
					{ "Casting", "Casting", "fRadiusMult", Kind::Slider, "Search radius multiplier",
					  "Scales the skill-based search radius (1.00 = original, 1500-4000 units).",
					  0.1, 4, 0.1, 1, false },
					{ "Casting", "Casting", "bDualCastPerkDoubleWisps", Kind::Toggle, "Dual Casting perk: double wisps",
					  "With the Alteration Dual Casting perk, dual casting sends two wisps at a time (each costs magicka).",
					  0, 1, 1, 1, true },
					{ "Casting", "Casting", "bAllowNPCCasters", Kind::Toggle, "NPC casters",
					  "NPCs who cast Harvest or use the Staff of Harvest send wisps too.",
					  0, 1, 1, 1, true },

					{ "What to harvest", "Harvest", "bFood", Kind::Toggle, "Food",
					  "Loose food, and plants that only yield food.", 0, 1, 1, 0, true },
					{ "What to harvest", "Harvest", "bHearthfire", Kind::Toggle, "Hearthfire planters",
					  "Your Hearthfire garden planters.", 0, 1, 1, 1, true },
					{ "What to harvest", "Harvest", "bCritters", Kind::Toggle, "Critters & special plants",
					  "Butterflies, moths, dragonflies, fish, nirnroot, poison blooms, Creation Club harvestables.",
					  0, 1, 1, 1, true },
					{ "What to harvest", "Harvest", "bArrows", Kind::Toggle, "Arrows & bolts",
					  "Loose ammo, and arrows or bolts stuck in the world.", 0, 1, 1, 0, true },
					{ "What to harvest", "Harvest", "bRespectOwnership", Kind::Toggle, "Respect ownership",
					  "Never take anything that would count as stealing.", 0, 1, 1, 1, true },

					{ "Wisps", "Wisps", "fSpawnDistanceMult", Kind::Slider, "Spawn distance multiplier",
					  "Wisps appear this far in front of you (x192 units). Negative = behind you.",
					  -3, 3, 0.5, 1, false },
					{ "Wisps", "Wisps", "fReturnOffset", Kind::Slider, "Return distance",
					  "How close to you (units) wisps come back before vanishing.",
					  192, 1000, 32, 192, false },
					{ "Wisps", "Wisps", "fSpeedMult", Kind::Slider, "Flight speed multiplier",
					  "Wisp travel speed (1.00 = original 1000 units/s, up to 20x).",
					  0.25, 20, 0.25, 1, false },
					{ "Wisps", "Wisps", "bSounds", Kind::Toggle, "Sounds",
					  "Wisp hum and despawn sound.", 0, 1, 1, 1, true },

					{ "Spell tomes", "SpellTomes", "fReadTomeDespawnChance", Kind::Slider, "Tome vanish chance",
					  "Once you know Harvest, the chance (0-1) that each placed Spell Tome: Harvest disappears when you find it.",
					  0, 1, 0.05, 0.8, false },

					{ "Diagnostics", "General", "iLogLevel", Kind::Enum, "Log level",
					  "Written to Documents/My Games/Skyrim Special Edition/SKSE/IHarvestNG.log.",
					  0, 6, 1, 2, true, { "trace", "debug", "info", "warn", "error", "critical", "off" } },

					// Appended, not inserted: a row's index is its identity on the wire.
					{ "What to harvest", "Harvest", "bStopWhenOverEncumbered", Kind::Toggle, "Stop before over-encumbered",
					  "Wisps are held back when what they bring would put you over your carry weight, and harvesting "
					  "resumes by itself once there is room again.",
					  0, 1, 1, 1, true, {}, true },
				  } },
			};
			return kMods;
		}

		std::mutex                                       g_lock;
		// Each bridge call runs on its own worker thread, so two quick clicks
		// could interleave a read-modify-write on the same file. One at a time.
		std::mutex                                       g_fileLock;
		bool                                             g_snapped = false;
		std::map<std::string, std::map<int, double>>     g_launch;   // mod id -> key index -> value

		std::string Dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }

		std::string Trim(const std::string& v)
		{
			const auto b = v.find_first_not_of(" \t\r\n");
			if (b == std::string::npos)
				return "";
			const auto e = v.find_last_not_of(" \t\r\n");
			return v.substr(b, e - b + 1);
		}

		bool IEquals(const std::string& a, const char* b)
		{
			const size_t n = std::char_traits<char>::length(b);
			if (a.size() != n)
				return false;
			for (size_t i = 0; i < n; ++i)
				if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i])))
					return false;
			return true;
		}

		bool Loaded(const Mod& m) { return GetModuleHandleW(m.dll) != nullptr; }

		// The loaded build re-reads its ini live (it exports m.liveExport).
		bool Live(const Mod& m)
		{
			if (!m.liveExport || !*m.liveExport)
				return false;
			const auto h = GetModuleHandleW(m.dll);
			return h && GetProcAddress(h, m.liveExport) != nullptr;
		}

		// Lines WITH their own line endings, so a write reproduces every byte it
		// did not mean to change.
		bool ReadLines(const char* path, std::vector<std::string>& out)
		{
			std::ifstream in(path, std::ios::binary);
			if (!in)
				return false;
			std::stringstream ss;
			ss << in.rdbuf();
			const std::string all = ss.str();
			out.clear();
			std::string line;
			for (char c : all) {
				line.push_back(c);
				if (c == '\n') { out.push_back(line); line.clear(); }
			}
			if (!line.empty())
				out.push_back(line);
			return true;
		}

		bool WriteLines(const char* path, const std::vector<std::string>& lines)
		{
			std::ofstream out(path, std::ios::binary | std::ios::trunc);
			if (!out)
				return false;
			for (const auto& l : lines)
				out << l;
			return out.good();
		}

		std::string Eol(const std::vector<std::string>& lines)
		{
			for (const auto& l : lines)
				if (l.size() >= 2 && l[l.size() - 2] == '\r' && l.back() == '\n')
					return "\r\n";
			return lines.empty() ? "\r\n" : "\n";
		}

		// "[Section]" -> "Section", else "".
		std::string SectionOf(const std::string& t)
		{
			if (t.size() < 2 || t.front() != '[' || t.back() != ']')
				return "";
			return Trim(t.substr(1, t.size() - 2));
		}

		// The value of [section] key = value, with its exact span. Section and key
		// match case-insensitively, as CSimpleIni (the mod's reader) does by default.
		// CSimpleIni has no inline comments, so the value is the rest of the line.
		struct Hit { size_t line = 0, from = 0, to = 0; std::string value; };

		bool Find(const std::vector<std::string>& lines, const char* section, const char* key, Hit& hit)
		{
			std::string cur;
			for (size_t i = 0; i < lines.size(); ++i) {
				const std::string& raw = lines[i];
				const std::string t = Trim(raw);
				if (t.empty() || t[0] == ';' || t[0] == '#')
					continue;
				if (t[0] == '[') { cur = SectionOf(t); continue; }
				if (!IEquals(cur, section))
					continue;
				const auto eq = raw.find('=');
				if (eq == std::string::npos || !IEquals(Trim(raw.substr(0, eq)), key))
					continue;
				// Content ends before the line break; the value is trimmed inside it.
				const auto last = raw.find_last_not_of("\r\n");
				const size_t contentEnd = (last == std::string::npos) ? 0 : last + 1;
				size_t b = raw.find_first_not_of(" \t", eq + 1);
				if (b == std::string::npos || b > contentEnd)
					b = contentEnd;
				const auto e = raw.find_last_not_of(" \t\r\n");
				const size_t to = (e == std::string::npos || e + 1 < b) ? b : e + 1;
				hit = { i, b, to, raw.substr(b, to - b) };
				return true;
			}
			return false;
		}

		// CSimpleIni's own reading rules, so the page shows what the mod sees.
		bool ParseBool(const std::string& v, bool fallback)
		{
			if (v.empty())
				return fallback;
			switch (std::tolower(static_cast<unsigned char>(v[0]))) {
			case 't': case 'y': case '1': return true;
			case 'f': case 'n': case '0': return false;
			case 'o': return v.size() > 1 && std::tolower(static_cast<unsigned char>(v[1])) == 'n';
			default: return fallback;
			}
		}

		double Parse(const Key& k, const std::string& v, bool present)
		{
			if (!present)
				return k.def;
			if (k.kind == Kind::Toggle)
				return ParseBool(v, k.def >= 1) ? 1.0 : 0.0;
			char* end = nullptr;
			const double d = k.integer ? static_cast<double>(std::strtol(v.c_str(), &end, 0))
			                           : std::strtod(v.c_str(), &end);
			if (end == v.c_str() || !std::isfinite(d))
				return k.def;
			// The mod clamps on load; show what it will actually use.
			return std::clamp(d, k.min, k.max);
		}

		std::string Spell(const Key& k, double v)
		{
			if (k.kind == Kind::Toggle)
				return v >= 1 ? "true" : "false";
			if (k.integer)
				return std::to_string(static_cast<long>(std::lround(v)));
			char buf[32];
			std::snprintf(buf, sizeof(buf), "%.4f", v);
			std::string s = buf;
			while (s.size() > 3 && s.back() == '0' && s[s.size() - 2] != '.')
				s.pop_back();
			return s;
		}

		std::map<int, double> ReadValues(const Mod& m)
		{
			std::map<int, double> out;
			std::vector<std::string> lines;
			const bool have = ReadLines(m.path, lines);
			for (size_t i = 0; i < m.keys.size(); ++i) {
				Hit h;
				const bool present = have && Find(lines, m.keys[i].section, m.keys[i].key, h);
				out[static_cast<int>(i)] = Parse(m.keys[i], h.value, present);
			}
			return out;
		}

		json BuildMod(const Mod& m)
		{
			std::vector<std::string> lines;
			const bool have = ReadLines(m.path, lines);
			const bool live = Live(m);
			std::map<int, double> launch;   // stays empty for a live build: nothing waits for a launch
			if (!live) {
				std::lock_guard l(g_lock);
				if (auto it = g_launch.find(m.id); it != g_launch.end())
					launch = it->second;
			}

			json pages = json::array();
			std::vector<std::string> order;
			std::map<std::string, json> rowsByPage;
			for (size_t i = 0; i < m.keys.size(); ++i) {
				const Key& k = m.keys[i];
				if (k.liveOnly && !live)
					continue;   // upstream would ignore it: showing it would be a control that lies
				Hit h;
				const bool present = have && Find(lines, k.section, k.key, h);
				const double v = Parse(k, h.value, present);
				json row = {
					{ "i", static_cast<int>(i) },
					{ "setting", std::string(k.section) + "." + k.key },
					{ "label", k.label },
					{ "info", k.info },
					{ "value", v },
					{ "def", k.def },
					{ "writable", true },
				};
				if (auto it = launch.find(static_cast<int>(i)); it != launch.end())
					row["launch"] = it->second;
				if (!present)
					row["why"] = have ? "not in the file yet, so the mod uses its default; a change here adds it"
					                  : "the settings file does not exist yet; a change here creates it";
				switch (k.kind) {
				case Kind::Toggle:
					row["type"] = "toggle";
					break;
				case Kind::Enum:
					row["type"] = "enum";
					row["options"] = k.options;
					break;
				case Kind::Slider:
					row["type"] = "slider";
					row["min"] = k.min;
					row["max"] = k.max;
					row["step"] = k.step;
					break;
				}
				if (!rowsByPage.count(k.page)) {
					order.emplace_back(k.page);
					rowsByPage[k.page] = json::array();
				}
				rowsByPage[k.page].push_back(std::move(row));
			}
			for (const auto& p : order)
				pages.push_back({ { "name", p }, { "rows", rowsByPage[p] } });

			const bool smf = GetModuleHandleW(L"SKSEMenuFramework.dll") != nullptr;
			return json{
				{ "id", m.id }, { "name", m.name }, { "src", "ini" }, { "path", m.path },
				{ "file", have }, { "smf", smf && *m.smfPage }, { "smfPage", m.smfPage },
				{ "note", live ? m.liveNote : m.note }, { "live", live }, { "pages", pages },
			};
		}
	}

	void SnapshotAtLaunch()
	{
		std::lock_guard l(g_lock);
		if (g_snapped)
			return;
		g_snapped = true;
		for (const auto& m : Table()) {
			if (!Loaded(m))
				continue;
			g_launch[m.id] = ReadValues(m);
			logger::info("ini-mods: {} detected, launch values read from {}", m.name, m.path);   // marker: ini-mods-detect
		}
	}

	std::string StateJson()
	{
		std::lock_guard fl(g_fileLock);
		json mods = json::array();
		for (const auto& m : Table())
			if (Loaded(m))
				mods.push_back(BuildMod(m));
		return Dump({ { "ok", true }, { "mods", mods } });
	}

	std::string Set(const std::string& request)
	{
		const json req = json::parse(request, nullptr, false);
		auto fail = [](const std::string& msg) { return Dump({ { "ok", false }, { "msg", msg } }); };
		if (!req.is_object())
			return fail("Invalid settings request");

		const auto id = req.value("mod", std::string{});
		const Mod* mod = nullptr;
		for (const auto& m : Table())
			if (id == m.id) mod = &m;
		if (!mod)
			return fail("That is not a mod this page edits");
		if (!Loaded(*mod))
			return fail(std::string(mod->name) + " is not loaded in this game");

		// The id off the wire is validated against the same table it writes.
		const int i = req.value("i", -1);
		if (i < 0 || i >= static_cast<int>(mod->keys.size()))
			return fail("That setting is gone. Rescan");
		const Key& k = mod->keys[static_cast<size_t>(i)];
		const bool live = Live(*mod);
		if (k.liveOnly && !live)
			return fail(std::string("That setting is not in the version of ") + mod->name + " that is loaded");

		if (!req.contains("value") || !req["value"].is_number())
			return fail("That setting takes a number");
		double v = req["value"].get<double>();
		if (!std::isfinite(v))
			return fail("That setting takes a number");
		v = std::clamp(v, k.min, k.max);
		if (k.kind != Kind::Slider || k.integer)
			v = std::round(v);
		else
			v = std::round(v * 10000.0) / 10000.0;   // a stepper's 0.1 + 0.2 lands on 0.3, not 0.30000000000000004

		std::lock_guard fl(g_fileLock);
		std::vector<std::string> lines;
		ReadLines(mod->path, lines);   // a missing file is created below
		const std::string eol = Eol(lines);
		const std::string text = Spell(k, v);

		Hit h;
		if (Find(lines, k.section, k.key, h)) {
			std::string& l = lines[h.line];
			l = l.substr(0, h.from) + text + l.substr(h.to);
		} else {
			// Add the key at the end of its section, or a new section at the end.
			const std::string entry = std::string(k.key) + " = " + text + eol;
			size_t header = std::string::npos, sectionEnd = std::string::npos;
			for (size_t li = 0; li < lines.size(); ++li) {
				const std::string t = Trim(lines[li]);
				if (t.empty() || t[0] != '[')
					continue;
				if (header != std::string::npos) {   // the first header after ours ends it
					sectionEnd = li;
					break;
				}
				if (IEquals(SectionOf(t), k.section))
					header = li;
			}
			if (header != std::string::npos && sectionEnd == std::string::npos)
				sectionEnd = lines.size();
			if (sectionEnd != std::string::npos) {
				// Before the blank lines that separate it from the next section.
				size_t at = sectionEnd;
				while (at > 0 && Trim(lines[at - 1]).empty())
					--at;
				if (at > 0 && !lines[at - 1].empty() && lines[at - 1].back() != '\n')
					lines[at - 1] += eol;
				lines.insert(lines.begin() + static_cast<long>(at), entry);
			} else {
				if (!lines.empty() && !lines.back().empty() && lines.back().back() != '\n')
					lines.back() += eol;
				if (!lines.empty())
					lines.push_back(eol);
				lines.push_back("[" + std::string(k.section) + "]" + eol);
				lines.push_back(entry);
			}
		}

		if (!WriteLines(mod->path, lines))
			return fail(std::string(mod->path) + " could not be written (is it read-only?)");
		logger::info("ini-mods: {} [{}] {} = {}", mod->name, k.section, k.key, text);   // marker: ini-mods-set

		// Read it back: the reply reports what the file now says, not what we sent.
		std::vector<std::string> fresh;
		Hit back;
		if (!ReadLines(mod->path, fresh) || !Find(fresh, k.section, k.key, back))
			return fail("Saved, but the file did not read back. Rescan");
		const double now = Parse(k, back.value, true);

		json out = { { "ok", true }, { "mod", mod->id }, { "i", i }, { "value", now } };
		if (live) {
			out["msg"] = std::string("Saved. ") + mod->name + " picks it up within a second.";
			return Dump(out);
		}
		double launch = now;
		bool haveLaunch = false;
		{
			std::lock_guard l(g_lock);
			if (auto it = g_launch.find(mod->id); it != g_launch.end())
				if (auto kt = it->second.find(i); kt != it->second.end()) {
					launch = kt->second;
					haveLaunch = true;
				}
		}
		if (haveLaunch)
			out["launch"] = launch;
		out["msg"] = (haveLaunch && std::abs(launch - now) < 1e-6)
			? std::string("Saved: back to the value this game started with.")
			: std::string("Saved. ") + mod->name + " reads this at startup, so it applies next launch.";
		return Dump(out);
	}
}
