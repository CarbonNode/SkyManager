#include "ppa_config.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace PpaConfig
{
	namespace
	{
		using json = nlohmann::json;

		constexpr const char* kPath = "Data/SKSE/Plugins/accurate-penetration.toml";

		// Sections we expose. Deliberately NOT the node-name and .Position
		// tables: those are skeleton anchors and offsets where a wrong number
		// silently misaligns everything, with no in-game feedback to catch it.
		// Rober asked for PPA's settings, not for a way to break its rig.
		bool Exposed(const std::string& section)
		{
			static const char* ok[] = { "General", "Hotkeys", "Debug", "Penis",
				"Vagina", "Anus", "Animation", "Solver", "SoundEffects" };
			for (auto* s : ok)
				if (section == s)
					return true;
			return false;
		}

		std::string Trim(std::string v)
		{
			const auto b = v.find_first_not_of(" \t\r\n");
			if (b == std::string::npos)
				return "";
			const auto e = v.find_last_not_of(" \t\r\n");
			return v.substr(b, e - b + 1);
		}

		// ---------------------------------------------------------- the file --
		// Read as bytes and split keeping the line endings, so a write puts back
		// exactly what it found everywhere it did not touch.
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
				if (c == '\n') {
					out.push_back(line);
					line.clear();
				}
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

		// ----------------------------------------------------------- parsing --
		struct Row
		{
			std::string section, key, value;
			size_t      line = 0;
			// Where the VALUE sits inside that line, so a write replaces the
			// value and nothing else (indentation and a trailing # comment
			// both survive).
			size_t from = 0, to = 0;
		};

		enum class Kind { None, Bool, Int, Float };

		Kind Classify(const std::string& v)
		{
			if (v == "true" || v == "false")
				return Kind::Bool;
			if (v.empty() || v[0] == '"' || v[0] == '[' || v[0] == '\'')
				return Kind::None;
			bool dot = false, digit = false;
			for (size_t i = 0; i < v.size(); ++i) {
				const char c = v[i];
				if (c == '-' || c == '+') {
					if (i != 0)
						return Kind::None;
				} else if (c == '.') {
					if (dot)
						return Kind::None;
					dot = true;
				} else if (std::isdigit(static_cast<unsigned char>(c))) {
					digit = true;
				} else
					return Kind::None;
			}
			if (!digit)
				return Kind::None;
			return dot ? Kind::Float : Kind::Int;
		}

		// Parse every `Key = value` under a `[Section]` header. `[[Array]]`
		// headers are skipped whole: their keys repeat per element, so
		// "Section.Key" would not address one of them uniquely.
		std::vector<Row> Parse(const std::vector<std::string>& lines)
		{
			std::vector<Row> rows;
			std::string section;
			bool        inArrayTable = false;
			for (size_t i = 0; i < lines.size(); ++i) {
				const std::string raw = lines[i];
				const std::string t = Trim(raw);
				if (t.empty() || t[0] == '#')
					continue;
				if (t[0] == '[') {
					inArrayTable = (t.size() > 1 && t[1] == '[');
					const auto close = t.find_last_of(']');
					section = inArrayTable ? "" : Trim(t.substr(1, close == std::string::npos ? std::string::npos : close - 1));
					continue;
				}
				if (inArrayTable || section.empty() || !Exposed(section))
					continue;
				const auto eq = raw.find('=');
				if (eq == std::string::npos)
					continue;
				const std::string key = Trim(raw.substr(0, eq));
				if (key.empty() || !(std::isalpha(static_cast<unsigned char>(key[0]))))
					continue;
				if (key.find_first_of(" \t") != std::string::npos)
					continue;
				// The value runs from the first non-blank after '=' to the
				// last non-blank before a trailing comment.
				size_t from = raw.find_first_not_of(" \t", eq + 1);
				if (from == std::string::npos)
					continue;
				size_t end = raw.find('#', from);
				if (end == std::string::npos)
					end = raw.size();
				const auto lastReal = raw.find_last_not_of(" \t\r\n", end ? end - 1 : 0);
				if (lastReal == std::string::npos || lastReal < from)
					continue;
				Row r;
				r.section = section;
				r.key = key;
				r.line = i;
				r.from = from;
				r.to = lastReal + 1;
				r.value = raw.substr(from, r.to - from);
				rows.push_back(r);
			}
			return rows;
		}

		// A readable label out of PPA's CamelCase key, so the page does not
		// read like a config file.
		std::string Label(const std::string& key)
		{
			std::string out;
			for (size_t i = 0; i < key.size(); ++i) {
				const char c = key[i];
				if (i && std::isupper(static_cast<unsigned char>(c)) &&
					!std::isupper(static_cast<unsigned char>(key[i - 1])))
					out.push_back(' ');
				out.push_back(i == 0 ? c : static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
			}
			if (!out.empty())
				out[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(out[0])));
			return out;
		}

		// The nearest preceding comment block — PPA documents every key, and
		// that documentation is worth more on the page than a bare number.
		std::string Detail(const std::vector<std::string>& lines, size_t at)
		{
			std::string out;
			size_t i = at;
			while (i > 0) {
				const std::string t = Trim(lines[i - 1]);
				if (t.empty() || t[0] != '#')
					break;
				std::string body = Trim(t.substr(1));
				// The file's box-drawing rules are decoration, not prose.
				if (!body.empty() && body.find_first_not_of("-=_*") != std::string::npos)
					out = body + (out.empty() ? "" : " " + out);
				--i;
				if (at - i > 6)
					break;
			}
			if (out.size() > 220)
				out = out.substr(0, 217) + "...";
			return out;
		}

		// ------------------------------------------------- the reload hotkey --
		// PPA's own, read live. Never the shipped default unless the file
		// genuinely does not answer — and the page says which it used.
		struct Reload
		{
			std::uint32_t dik = 0;
			bool          shiftOnly = false;
			bool          live = false;
		};
		Reload ReadReload(const std::vector<Row>& rows)
		{
			Reload r;
			for (const auto& row : rows) {
				if (row.section != "Hotkeys")
					continue;
				if (row.key == "Reload") {
					try {
						const long v = std::stol(row.value);
						if (v > 0 && v < 0x200) {
							r.dik = static_cast<std::uint32_t>(v);
							r.live = true;
						}
					} catch (...) {}
				} else if (row.key == "HotkeyWhileHoldingShiftOnly") {
					r.shiftOnly = (row.value == "true");
				}
			}
			return r;
		}

		// Byte-identical to main.cpp / sos_actions.cpp SendScan.
		void SendScan(std::uint32_t dik, bool down)
		{
			INPUT in{};
			in.type = INPUT_KEYBOARD;
			in.ki.wScan = static_cast<WORD>(dik & 0x7F);
			in.ki.dwFlags = KEYEVENTF_SCANCODE;
			if (dik > 0x7F)
				in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
			if (!down)
				in.ki.dwFlags |= KEYEVENTF_KEYUP;
			SendInput(1, &in, sizeof(INPUT));
		}

		void TapReload(Reload r)
		{
			if (!r.dik)
				return;
			constexpr std::uint32_t kLeftShift = 42;
			std::thread([r]() {
				using namespace std::chrono;
				std::this_thread::sleep_for(milliseconds(60));
				if (r.shiftOnly) {
					SendScan(kLeftShift, true);
					std::this_thread::sleep_for(milliseconds(15));
				}
				SendScan(r.dik, true);
				std::this_thread::sleep_for(milliseconds(45));
				SendScan(r.dik, false);
				if (r.shiftOnly) {
					std::this_thread::sleep_for(milliseconds(15));
					SendScan(kLeftShift, false);
				}
			}).detach();
		}

		std::string DikName(std::uint32_t dik)
		{
			switch (dik) {
			case 59: return "F1";  case 60: return "F2";  case 61: return "F3";
			case 62: return "F4";  case 63: return "F5";  case 64: return "F6";
			case 65: return "F7";  case 66: return "F8";  case 67: return "F9";
			case 68: return "F10"; case 87: return "F11"; case 88: return "F12";
			case 12: return "-";   case 14: return "Backspace";
			default: return "scan " + std::to_string(dik);
			}
		}

		float StepFor(const std::string& value, Kind kind)
		{
			if (kind == Kind::Int)
				return 1.f;
			float v = 0.f;
			try { v = std::stof(value); } catch (...) { v = 1.f; }
			const float mag = std::abs(v);
			// Proportional, so a 0.9 girth moves in hundredths and a 5.0 grip
			// strength moves in halves instead of taking forty presses.
			if (mag < 1.f) return 0.05f;
			if (mag < 10.f) return 0.1f;
			return 0.5f;
		}

		std::string Trimmed(float v)
		{
			// Always WITH a decimal point: PPA reads a float written as "1"
			// wrongly, and says so in its own header.
			char buf[32];
			std::snprintf(buf, sizeof(buf), "%.4f", v);
			std::string s(buf);
			while (s.size() > 3 && s.back() == '0' && s[s.size() - 2] != '.')
				s.pop_back();
			return s;
		}

		json RowsJson(const std::vector<std::string>& lines, const std::vector<Row>& rows)
		{
			json out = json::array();
			for (const auto& r : rows) {
				const auto kind = Classify(r.value);
				if (kind == Kind::None)
					continue;
				json row = {
					{ "section", r.section },
					{ "key", r.section + "." + r.key },
					{ "label", Label(r.key) },
					{ "detail", Detail(lines, r.line) },
					// Hotkeys are shown, never written: the Reload key is how
					// every other change is applied, so rebinding it from here
					// would be sawing the branch off.
					{ "readonly", r.section == "Hotkeys" },
				};
				if (kind == Kind::Bool) {
					row["type"] = "bool";
					row["value"] = (r.value == "true");
				} else if (kind == Kind::Int) {
					row["type"] = "int";
					try { row["value"] = std::stoi(r.value); } catch (...) { continue; }
					row["step"] = 1;
				} else {
					row["type"] = "float";
					try { row["value"] = std::stof(r.value); } catch (...) { continue; }
					row["step"] = StepFor(r.value, kind);
				}
				out.push_back(row);
			}
			return out;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}
	}

	std::string StateJson()
	{
		const bool installed = GetModuleHandleW(L"AccuratePenetration.dll") != nullptr;
		std::vector<std::string> lines;
		if (!ReadLines(lines)) {
			return Dump({ { "ok", false }, { "installed", installed }, { "rows", json::array() },
				{ "msg", installed
						? "PPA is loaded but accurate-penetration.toml could not be read"
						: "PPA (AccuratePenetration.dll) is not in this load order" } });
		}
		const auto rows = Parse(lines);
		const auto reload = ReadReload(rows);
		return Dump({ { "ok", true }, { "installed", installed }, { "path", kPath },
			{ "reloadDik", reload.dik },
			{ "reloadKey", reload.dik ? (std::string(reload.shiftOnly ? "Shift + " : "") + DikName(reload.dik)) : std::string("unbound") },
			{ "reloadLive", reload.live },
			{ "shiftOnly", reload.shiftOnly },
			{ "rows", RowsJson(lines, rows) },
			{ "msg", installed ? "" : "Reading PPA's config, but AccuratePenetration.dll is not loaded — nothing will act on these" } });
	}

	std::string Set(const std::string& request)
	{
		json req = json::parse(request, nullptr, false);
		auto fail = [](const std::string& msg) {
			json out = json::parse(StateJson(), nullptr, false);
			if (!out.is_object())
				out = json::object();
			out["ok"] = false;
			out["msg"] = msg;
			return Dump(out);
		};
		if (!req.is_object())
			return fail("Invalid PPA request");
		const auto target = req.value("key", std::string{});
		const auto text = req.value("value", std::string{});
		const auto dot = target.find('.');
		if (dot == std::string::npos || text.empty() || text.size() > 32)
			return fail("Invalid PPA setting");
		const std::string section = target.substr(0, dot), key = target.substr(dot + 1);
		if (!Exposed(section) || section == "Hotkeys")
			return fail("That PPA setting cannot be changed from here");

		std::vector<std::string> lines;
		if (!ReadLines(lines))
			return fail("accurate-penetration.toml could not be read");
		auto rows = Parse(lines);
		const Row* hit = nullptr;
		for (const auto& r : rows)
			if (r.section == section && r.key == key)
				hit = &r;
		if (!hit)
			return fail("PPA no longer has that setting — refresh");

		// The NEW value is re-derived from the value on disk, so the type can
		// never be changed by what arrived off the wire: a bool stays a bool,
		// a float keeps its decimal point, an int keeps not having one.
		const auto kind = Classify(hit->value);
		std::string written;
		if (kind == Kind::Bool) {
			if (text != "true" && text != "false")
				return fail("That PPA setting is on/off");
			written = text;
		} else if (kind == Kind::Int || kind == Kind::Float) {
			float v = 0.f;
			try { v = std::stof(text); } catch (...) { return fail("That PPA setting takes a number"); }
			if (!std::isfinite(v) || std::abs(v) > 1000.f)
				return fail("PPA values are kept within ±1000");
			written = (kind == Kind::Int)
				? std::to_string(static_cast<long>(std::lround(v)))
				: Trimmed(v);
		} else {
			return fail("That PPA setting is not a number or a switch");
		}

		// Line surgery: the value substring only. Indentation and any trailing
		// comment on the same line are preserved byte for byte.
		std::string& line = lines[hit->line];
		line = line.substr(0, hit->from) + written + line.substr(hit->to);
		if (!WriteLines(lines))
			return fail("accurate-penetration.toml could not be written (is it read-only?)");

		const auto reload = ReadReload(Parse(lines));
		logger::info("ppa: {} = {} (reload dik {})", target, written, reload.dik);  // marker: ppa-set
		TapReload(reload);

		json out = json::parse(StateJson(), nullptr, false);
		if (!out.is_object())
			out = json::object();
		out["ok"] = true;
		out["msg"] = reload.dik
			? ("Saved. Tapped PPA's reload key (" + std::string(reload.shiftOnly ? "Shift + " : "") + DikName(reload.dik) + ") to apply it.")
			: "Saved to accurate-penetration.toml. PPA's reload key is unbound, so it applies on the next game start.";
		return Dump(out);
	}
}
