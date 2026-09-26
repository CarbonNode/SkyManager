#include "relight_config.h"

#include "container_actions.h"   // CrosshairRef

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace RelightConfig
{
	namespace
	{
		using json = nlohmann::json;

		constexpr const char* kPath = "Data/SKSE/Plugins/ReLight.ini";
		constexpr const char* kExcludeSection = "[Refs Excluded Using in Game Menu]";

		// The scalars worth a control. ReLight's ini also carries long bare-word
		// lists (mesh names, editor-id fragments, a priority order) which are
		// deliberately NOT exposed: they are a modlist-specific ordering that a
		// stray click would quietly wreck, and nothing here can validate them.
		struct Known { const char* key; const char* label; const char* detail; float step; };
		const Known kKnown[] = {
			{ "enableLightFlickerPrevention", "Stop lights flickering",
			  "Holds a light steady instead of letting the engine flicker it.", 0.f },
			{ "removeFakeGlowOrbs", "Remove fake glow orbs",
			  "Strips the painted-on glow sprites vanilla uses instead of real light.", 0.f },
			{ "enableDebugBulbs", "Show debug bulbs",
			  "Draws a marker at each light ReLight manages. Diagnostic only.", 0.f },
			{ "loggingLevel", "Logging level",
			  "0 critical, 1 warnings, 2 info, 3 debug.", 1.f },
			{ "light merge distance", "Light merge distance", "", 5.f },
			{ "shadow light merge distance", "Shadow merge distance", "", 5.f },
			{ "light merge distance increased", "Merge distance (increased)", "", 5.f },
			{ "max z diff to merge", "Max height difference", "", 2.f },
			{ "max z diff to merge increased", "Max height difference (increased)", "", 5.f },
			{ "light fade increase per merge", "Fade added per merge", "", 0.05f },
			{ "light radius increase per merge", "Radius added per merge", "", 0.05f },
			{ "light fade max", "Fade ceiling", "", 0.1f },
			{ "light radius max", "Radius ceiling", "", 0.1f },
			{ "light merge maxlights", "Most lights merged at once", "", 1.f },
		};

		std::string Trim(std::string v)
		{
			const auto b = v.find_first_not_of(" \t\r\n");
			if (b == std::string::npos)
				return "";
			const auto e = v.find_last_not_of(" \t\r\n");
			return v.substr(b, e - b + 1);
		}

		bool ReadLines(std::vector<std::string>& out)
		{
			std::ifstream in(kPath, std::ios::binary);
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

		bool WriteLines(const std::vector<std::string>& lines)
		{
			std::ofstream out(kPath, std::ios::binary | std::ios::trunc);
			if (!out)
				return false;
			for (const auto& l : lines)
				out << l;
			return out.good();
		}

		// key= value, with the value's exact span so a write touches nothing else.
		bool FindScalar(const std::vector<std::string>& lines, const std::string& key,
			size_t& lineOut, size_t& from, size_t& to, std::string& value)
		{
			for (size_t i = 0; i < lines.size(); ++i) {
				const std::string& raw = lines[i];
				const std::string t = Trim(raw);
				if (t.empty() || t[0] == ';' || t[0] == '[')
					continue;
				const auto eq = raw.find('=');
				if (eq == std::string::npos)
					continue;
				if (Trim(raw.substr(0, eq)) != key)
					continue;
				size_t b = raw.find_first_not_of(" \t", eq + 1);
				if (b == std::string::npos)
					return false;
				size_t end = raw.find(';', b);
				if (end == std::string::npos)
					end = raw.size();
				const auto last = raw.find_last_not_of(" \t\r\n", end ? end - 1 : 0);
				if (last == std::string::npos || last < b)
					return false;
				lineOut = i; from = b; to = last + 1;
				value = raw.substr(b, to - b);
				return true;
			}
			return false;
		}

		bool IsBool(const std::string& v) { return v == "true" || v == "false"; }

		// Where the excluded-refs section starts, and where its entries end.
		bool ExcludeSpan(const std::vector<std::string>& lines, size_t& begin, size_t& end)
		{
			begin = end = 0;
			for (size_t i = 0; i < lines.size(); ++i) {
				if (Trim(lines[i]) == kExcludeSection) {
					begin = i + 1;
					end = lines.size();
					for (size_t j = begin; j < lines.size(); ++j) {
						const std::string t = Trim(lines[j]);
						if (!t.empty() && t[0] == '[') { end = j; break; }
					}
					return true;
				}
			}
			return false;
		}

		// "0xBAC3A~Skyrim.esm"
		bool ParseRef(const std::string& t, std::string& id, std::string& plugin)
		{
			if (t.size() < 4 || t[0] != '0' || (t[1] != 'x' && t[1] != 'X'))
				return false;
			const auto tilde = t.find('~');
			if (tilde == std::string::npos)
				return false;
			id = t.substr(0, tilde);
			plugin = Trim(t.substr(tilde + 1));
			return !plugin.empty();
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		json Build(const std::vector<std::string>& lines, bool installed)
		{
			json rows = json::array();
			for (const auto& k : kKnown) {
				size_t line = 0, from = 0, to = 0; std::string v;
				if (!FindScalar(lines, k.key, line, from, to, v))
					continue;
				json row = { { "key", k.key }, { "label", k.label }, { "detail", k.detail } };
				if (IsBool(v)) {
					row["type"] = "bool";
					row["value"] = (v == "true");
				} else {
					float n = 0.f;
					try { n = std::stof(v); } catch (...) { continue; }
					row["type"] = "number";
					row["value"] = n;
					row["step"] = k.step > 0.f ? k.step : 1.f;
					// An integer in the file stays an integer when written back.
					row["int"] = (v.find('.') == std::string::npos);
				}
				rows.push_back(row);
			}

			json excluded = json::array();
			size_t b = 0, e = 0;
			if (ExcludeSpan(lines, b, e)) {
				for (size_t i = b; i < e; ++i) {
					const std::string t = Trim(lines[i]);
					if (t.empty() || t[0] == ';')
						continue;
					std::string id, plugin;
					if (!ParseRef(t, id, plugin))
						continue;
					std::string label = id + " · " + plugin;
					if (auto* f = RE::TESForm::LookupByID(
							static_cast<RE::FormID>(std::strtoul(id.c_str(), nullptr, 16)))) {
						if (f->GetName() && *f->GetName())
							label = std::string(f->GetName()) + "  (" + id + ")";
					}
					excluded.push_back({ { "line", static_cast<int>(i) }, { "id", id },
						{ "plugin", plugin }, { "label", label } });
				}
			}

			const bool smf = GetModuleHandleW(L"SKSEMenuFramework.dll") != nullptr;
			return json{ { "ok", true }, { "installed", installed }, { "path", kPath },
				{ "smf", smf }, { "rows", rows }, { "excluded", excluded },
				{ "hasSection", b != 0 },
				{ "msg", "" } };
		}
	}

	std::string StateJson()
	{
		const bool installed = GetModuleHandleW(L"Relight.dll") != nullptr;
		std::vector<std::string> lines;
		if (!ReadLines(lines)) {
			return Dump({ { "ok", false }, { "installed", installed },
				{ "rows", json::array() }, { "excluded", json::array() },
				{ "msg", installed
						? "ReLight is loaded but ReLight.ini could not be read"
						: "ReLight (Relight.dll) is not in this load order" } });
		}
		return Dump(Build(lines, installed));
	}

	std::string Apply(const std::string& request)
	{
		json req = json::parse(request, nullptr, false);
		auto fail = [](const std::string& msg) {
			json out = json::parse(StateJson(), nullptr, false);
			if (!out.is_object()) out = json::object();
			out["ok"] = false; out["msg"] = msg;
			return Dump(out);
		};
		if (!req.is_object())
			return fail("Invalid ReLight request");

		std::vector<std::string> lines;
		if (!ReadLines(lines))
			return fail("ReLight.ini could not be read");

		const auto op = req.value("op", std::string{});
		std::string note;

		if (op == "set") {
			const auto key = req.value("key", std::string{});
			const auto* known = static_cast<const Known*>(nullptr);
			for (const auto& k : kKnown)
				if (key == k.key) known = &k;
			if (!known)
				return fail("That ReLight setting is not one this page owns");
			size_t line = 0, from = 0, to = 0; std::string cur;
			if (!FindScalar(lines, key, line, from, to, cur))
				return fail("ReLight no longer has that setting — refresh");
			const auto text = req.value("value", std::string{});
			std::string written;
			if (IsBool(cur)) {
				if (text != "true" && text != "false")
					return fail("That ReLight setting is on/off");
				written = text;
			} else {
				float v = 0.f;
				try { v = std::stof(text); } catch (...) { return fail("That ReLight setting takes a number"); }
				if (!std::isfinite(v) || std::abs(v) > 10000.f)
					return fail("ReLight values are kept within ±10000");
				if (v < 0.f) v = 0.f;
				if (cur.find('.') == std::string::npos) {
					written = std::to_string(static_cast<long>(std::lround(v)));
				} else {
					char buf[32];
					std::snprintf(buf, sizeof(buf), "%.4f", v);
					written = buf;
					while (written.size() > 3 && written.back() == '0' && written[written.size() - 2] != '.')
						written.pop_back();
				}
			}
			std::string& l = lines[line];
			l = l.substr(0, from) + written + l.substr(to);
			note = "Saved. ReLight reads this at startup — it applies next launch.";
			logger::info("relight: {} = {}", key, written);   // marker: relight-set
		} else if (op == "exclude") {
			const auto fid = ContainerActions::CrosshairRef();
			if (!fid)
				return fail("Look at the light you want excluded, then press this");
			auto* form = RE::TESForm::LookupByID(fid);
			if (!form)
				return fail("That reference is gone");
			auto* file = form->GetFile(0);
			// container_actions.cpp's proven idiom: GetFilename() converts straight
			// to std::string; .data() on the string_view is not null-terminated.
			const std::string plugin = file ? std::string(file->GetFilename()) : std::string{};
			if (plugin.empty())
				return fail("That reference has no source plugin, so it cannot be listed");
			char idbuf[16];
			// The ini's own spelling: a BARE hex id, no leading zero padding.
			std::snprintf(idbuf, sizeof(idbuf), "0x%X", static_cast<unsigned>(fid & 0x00FFFFFF));
			const std::string entry = std::string(idbuf) + "~" + plugin;

			size_t b = 0, e = 0;
			if (!ExcludeSpan(lines, b, e)) {
				// ReLight writes this section itself the first time its own menu
				// is used; create it rather than refusing.
				lines.push_back("\r\n");
				lines.push_back(std::string(kExcludeSection) + "\r\n");
				b = lines.size(); e = lines.size();
			}
			for (size_t i = b; i < e; ++i)
				if (Trim(lines[i]) == entry)
					return fail("That light is already excluded");
			lines.insert(lines.begin() + static_cast<long>(e), entry + "\r\n");
			note = "Excluded " + entry + ". ReLight reads this at startup — it applies next launch.";
			logger::info("relight: exclude {}", entry);   // marker: relight-exclude
		} else if (op == "include") {
			const int line = req.value("line", -1);
			if (line < 0 || line >= static_cast<int>(lines.size()))
				return fail("That entry is gone — refresh");
			std::string id, plugin;
			if (!ParseRef(Trim(lines[line]), id, plugin))
				return fail("That line is not an excluded reference — refresh");
			lines.erase(lines.begin() + line);
			note = "Removed " + id + ". ReLight reads this at startup — it applies next launch.";
			logger::info("relight: include {}", id);   // marker: relight-include
		} else {
			return fail("Unknown ReLight request");
		}

		if (!WriteLines(lines))
			return fail("ReLight.ini could not be written (is it read-only?)");

		std::vector<std::string> fresh;
		ReadLines(fresh);
		json out = Build(fresh, GetModuleHandleW(L"Relight.dll") != nullptr);
		out["ok"] = true;
		out["msg"] = note;
		return Dump(out);
	}
}
