#include "hotkey_pad.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::/logger and nlohmann::json, and via
// RE/Skyrim.h <Windows.h> — carry the macro block every module that touches
// json beside Windows.h carries (the cross-module trap in CLAUDE.md).
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace HotkeyPad
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		constexpr std::size_t kMaxLabel = 40;
		constexpr std::size_t kMaxId = 24;
		constexpr std::size_t kMaxEntryId = 128;

		std::mutex g_mutex;
		Options    g_opt;
		bool       g_loaded = false;

		fs::path OptionsPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "hotkey-pad.json";
		}

		bool ValidId(const std::string& id)
		{
			if (id.empty() || id.size() > kMaxId)
				return false;
			for (const char c : id)
				if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
					return false;
			return true;
		}

		// Labels are shown, never executed; trim, cap, and drop control bytes so
		// a hand-edited file cannot put a newline into a one-line caption.
		std::string CleanLabel(std::string s)
		{
			std::string out;
			out.reserve(s.size());
			for (const unsigned char c : s)
				if (c >= 0x20 && c != 0x7f)
					out.push_back(static_cast<char>(c));
			const auto a = out.find_first_not_of(' ');
			if (a == std::string::npos)
				return {};
			const auto b = out.find_last_not_of(' ');
			out = out.substr(a, b - a + 1);
			if (out.size() > kMaxLabel) {
				out.resize(kMaxLabel);
				// never leave half a UTF-8 sequence at the cut
				while (!out.empty() && (static_cast<unsigned char>(out.back()) & 0xC0) == 0x80)
					out.pop_back();
				if (!out.empty() && (static_cast<unsigned char>(out.back()) & 0x80))
					out.pop_back();
			}
			return out;
		}

		int ClampInt(const json& j, const char* key, int lo, int hi, int def)
		{
			if (!j.contains(key) || !j[key].is_number())
				return def;
			const double v = j[key].get<double>();
			if (!std::isfinite(v))
				return def;
			return std::clamp(static_cast<int>(std::lround(v)), lo, hi);
		}

		float ClampFloat(const json& j, const char* key, float lo, float hi, float def)
		{
			if (!j.contains(key) || !j[key].is_number())
				return def;
			const double v = j[key].get<double>();
			if (!std::isfinite(v))
				return def;
			return std::clamp(static_cast<float>(v), lo, hi);
		}

		std::string FreshId(const std::set<std::string>& used)
		{
			for (int n = 1; n < 100000; ++n) {
				std::string id = "b" + std::to_string(n);
				if (!used.count(id))
					return id;
			}
			return "b0";
		}

		bool IsModDik(std::uint32_t d)
		{
			return d == 0x2A || d == 0x36 || d == 0x1D || d == 0x9D || d == 0x38 || d == 0xB8;
		}

		// {dik, mods, name}: a real scancode that is not itself a modifier,
		// modifiers limited to Shift/Ctrl/Alt (deduplicated, at most three).
		bool ParsePress(const json& p, Press& out)
		{
			if (!p.is_object() || !p.contains("dik") || !p["dik"].is_number_integer())
				return false;
			const auto dik = p["dik"].get<std::int64_t>();
			if (dik <= 0 || dik > 0xFF || IsModDik(static_cast<std::uint32_t>(dik)))
				return false;
			out.dik = static_cast<std::uint32_t>(dik);
			out.mods.clear();
			if (p.contains("mods") && p["mods"].is_array())
				for (const auto& m : p["mods"])
					if (m.is_number_integer()) {
						const auto d = static_cast<std::uint32_t>(m.get<std::int64_t>());
						if (IsModDik(d) && std::find(out.mods.begin(), out.mods.end(), d) == out.mods.end() && out.mods.size() < 3)
							out.mods.push_back(d);
					}
			out.name = (p.contains("name") && p["name"].is_string()) ? CleanLabel(p["name"].get<std::string>()) : std::string();
			if (out.name.size() > 24)
				out.name.resize(24);
			if (out.name.empty())
				out.name = "Key " + std::to_string(out.dik);
			return true;
		}

		// One button out of a json object. `prevEntry` is the entry the same
		// id held before this edit ("" when new) — the keep-unknown rule.
		bool ParseButton(const json& b, int cols, const std::function<bool(const std::string&)>& known,
			const std::string& prevEntry, Button& out)
		{
			if (!b.is_object())
				return false;
			if (b.contains("press") && b["press"].is_object()) {
				// a key button: no deck entry behind it at all
				if (!ParsePress(b["press"], out.press))
					return false;
				out.entry.clear();
			} else {
				if (!b.contains("entry") || !b["entry"].is_string())
					return false;
				const std::string entry = b["entry"].get<std::string>();
				if (entry.empty() || entry.size() > kMaxEntryId)
					return false;
				if (known && !known(entry) && entry != prevEntry)
					return false;
				out.entry = entry;
				out.press = Press{};
			}
			out.label = (b.contains("label") && b["label"].is_string()) ? CleanLabel(b["label"].get<std::string>()) : std::string();
			out.w = ClampInt(b, "w", 1, std::min(kMaxSpan, std::max(1, cols)), 1);
			out.h = ClampInt(b, "h", 1, kMaxSpan, 1);
			return true;
		}

		// A wider pad never needs its buttons re-clamped; a narrower one does.
		void FitSpans(Options& o)
		{
			const int maxW = std::min(kMaxSpan, std::max(1, o.cols));
			for (auto& b : o.buttons)
				b.w = std::clamp(b.w, 1, maxW);
		}

		json ToJson(const Options& o)
		{
			json btns = json::array();
			for (const auto& b : o.buttons) {
				json one = { { "id", b.id }, { "entry", b.entry }, { "label", b.label }, { "w", b.w }, { "h", b.h } };
				if (b.press.dik)
					one["press"] = { { "dik", b.press.dik }, { "mods", b.press.mods }, { "name", b.press.name } };
				btns.push_back(std::move(one));
			}
			return {
				{ "v", 1 }, { "cols", o.cols }, { "scale", o.scale }, { "x", o.x }, { "y", o.y },
				{ "stayOpen", o.stayOpen }, { "pause", o.pause }, { "showKeys", o.showKeys },
				{ "buttons", btns },
			};
		}

		void ReadLayout(const json& j, Options& o)
		{
			o.cols = ClampInt(j, "cols", kMinCols, kMaxCols, o.cols);
			o.scale = ClampFloat(j, "scale", kMinScale, kMaxScale, o.scale);
			o.x = ClampFloat(j, "x", 0.0f, 0.98f, o.x);
			o.y = ClampFloat(j, "y", 0.0f, 0.98f, o.y);
			if (j.contains("stayOpen") && j["stayOpen"].is_boolean())
				o.stayOpen = j["stayOpen"].get<bool>();
			if (j.contains("pause") && j["pause"].is_boolean())
				o.pause = j["pause"].get<bool>();
			if (j.contains("showKeys") && j["showKeys"].is_boolean())
				o.showKeys = j["showKeys"].get<bool>();
		}

		// Caller holds g_mutex.
		void LoadLocked()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(OptionsPath(), std::ios::binary);
			if (!in)
				return;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			Options o;
			ReadLayout(j, o);
			std::set<std::string> used;
			if (j.contains("buttons") && j["buttons"].is_array()) {
				for (const auto& b : j["buttons"]) {
					if (static_cast<int>(o.buttons.size()) >= kMaxButtons)
						break;
					Button btn;
					// the file is our own: every entry it names is kept, known or not
					if (!ParseButton(b, o.cols, nullptr, {}, btn))
						continue;
					const std::string id = (b.contains("id") && b["id"].is_string()) ? b["id"].get<std::string>() : std::string();
					btn.id = (ValidId(id) && !used.count(id)) ? id : FreshId(used);
					used.insert(btn.id);
					o.buttons.push_back(std::move(btn));
				}
			}
			FitSpans(o);
			g_opt = std::move(o);
			// Build marker (hd-markers.json: "hotkey-pad-options").
			logger::info("hotkey-pad: options loaded ({} buttons, {} columns)", g_opt.buttons.size(), g_opt.cols);
		}

		// Caller holds g_mutex.
		void SaveLocked()
		{
			std::error_code ec;
			fs::create_directories(OptionsPath().parent_path(), ec);
			std::ofstream out(OptionsPath(), std::ios::binary | std::ios::trunc);
			if (out)
				out << ToJson(g_opt).dump(2);
			else
				logger::warn("hotkey-pad: could not write hotkey-pad.json");
		}
	}

	Options GetOptions()
	{
		std::lock_guard l(g_mutex);
		LoadLocked();
		return g_opt;
	}

	bool TargetFor(const std::string& buttonId, std::string& entry, Press& press)
	{
		std::lock_guard l(g_mutex);
		LoadLocked();
		for (const auto& b : g_opt.buttons)
			if (b.id == buttonId) {
				entry = b.entry;
				press = b.press;
				return true;
			}
		return false;
	}

	bool Apply(const std::string& requestJson, const std::function<bool(const std::string&)>& known,
		std::string& error)
	{
		const auto j = json::parse(requestJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			error = "That pad change could not be read.";
			return false;
		}
		const std::string op = j.value("op", std::string());
		std::lock_guard l(g_mutex);
		LoadLocked();
		Options o = g_opt;

		if (op == "set") {
			ReadLayout(j, o);
		} else if (op == "reset-layout") {
			const auto keep = std::move(o.buttons);
			o = Options{};
			o.buttons = keep;
		} else if (op == "add") {
			if (static_cast<int>(o.buttons.size()) >= kMaxButtons) {
				error = "The pad is full (" + std::to_string(kMaxButtons) + " buttons).";
				return false;
			}
			Button btn;
			if (!ParseButton(j, o.cols, known, {}, btn)) {
				error = (j.contains("press")) ? "That key cannot be put on the pad." : "That hotkey is not in the deck any more.";
				return false;
			}
			std::set<std::string> used;
			for (const auto& b : o.buttons)
				used.insert(b.id);
			btn.id = FreshId(used);
			o.buttons.push_back(std::move(btn));
		} else if (op == "remove") {
			const std::string id = j.value("id", std::string());
			const auto before = o.buttons.size();
			o.buttons.erase(std::remove_if(o.buttons.begin(), o.buttons.end(),
								[&](const Button& b) { return b.id == id; }),
				o.buttons.end());
			if (o.buttons.size() == before) {
				error = "That button is already gone.";
				return false;
			}
		} else if (op == "buttons") {
			if (!j.contains("buttons") || !j["buttons"].is_array()) {
				error = "That pad change could not be read.";
				return false;
			}
			std::vector<Button> next;
			std::set<std::string> used;
			for (const auto& b : j["buttons"]) {
				if (static_cast<int>(next.size()) >= kMaxButtons)
					break;
				const std::string id = (b.is_object() && b.contains("id") && b["id"].is_string()) ? b["id"].get<std::string>() : std::string();
				std::string prevEntry;
				for (const auto& old : o.buttons)
					if (old.id == id) { prevEntry = old.entry; break; }
				Button btn;
				if (!ParseButton(b, o.cols, known, prevEntry, btn))
					continue;
				btn.id = (ValidId(id) && !used.count(id)) ? id : FreshId(used);
				used.insert(btn.id);
				next.push_back(std::move(btn));
			}
			o.buttons = std::move(next);
		} else {
			error = "Unknown pad change.";
			return false;
		}
		FitSpans(o);
		g_opt = std::move(o);
		SaveLocked();
		logger::info("hotkey-pad: saved '{}' ({} buttons, {} columns, scale {})", op, g_opt.buttons.size(), g_opt.cols, g_opt.scale);
		return true;
	}

	std::string OptionsJson()
	{
		const Options o = GetOptions();
		json j = ToJson(o);
		j["limits"] = { { "minCols", kMinCols }, { "maxCols", kMaxCols }, { "maxSpan", kMaxSpan },
			{ "maxButtons", kMaxButtons }, { "minScale", kMinScale }, { "maxScale", kMaxScale } };
		return j.dump();
	}
}
