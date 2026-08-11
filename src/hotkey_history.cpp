#include "hotkey_history.h"

#include <chrono>
#include <cstdio>
#include <ctime>
#include <deque>
#include <mutex>
#include <string>

// pch (force-included) provides nlohmann/json.

using json = nlohmann::json;

namespace HotkeyHistory
{
	namespace
	{
		struct Row
		{
			Source            source{};
			std::string       name;
			std::string       label;
			std::string       category;
			std::uint32_t     times = 1;
			std::time_t       at = 0;   // latest fire, for "14:02:11" and "ago"
		};

		std::deque<Row> g_rows;   // newest at the FRONT
		std::mutex      g_mutex;

		const char* SourceName(Source s)
		{
			switch (s) {
			case Source::kAction:    return "action";
			case Source::kNumpad:    return "numpad";
			case Source::kQuickFire: return "quickfire";
			default:                 return "entry";
			}
		}

		std::string Clock(std::time_t t)
		{
			std::tm tm{};
#ifdef _WIN32
			localtime_s(&tm, &t);
#else
			localtime_r(&t, &tm);
#endif
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d", tm.tm_hour, tm.tm_min, tm.tm_sec);
			return buf;
		}

		// "just now" / "40s" / "12m" / "3h". Coarse on purpose: the point is
		// recency, and a second-accurate age on a list you read for ten seconds
		// is noise that also goes stale as you read it.
		std::string Ago(std::time_t then, std::time_t now)
		{
			const auto d = (now > then) ? (now - then) : 0;
			if (d < 10)
				return "just now";
			if (d < 60)
				return std::to_string(d) + "s";
			if (d < 3600)
				return std::to_string(d / 60) + "m";
			return std::to_string(d / 3600) + "h";
		}
	}

	void Record(Source source, const std::string& name, const std::string& label,
		const std::string& category)
	{
		const auto now = std::time(nullptr);
		std::lock_guard lock(g_mutex);

		// Collapse a repeat of the same thing into the row already at the top.
		// Only CONSECUTIVE repeats: firing A, then B, then A again is genuinely
		// three things and reads wrong as two.
		if (!g_rows.empty()) {
			Row& top = g_rows.front();
			if (top.source == source && top.name == name && top.label == label) {
				++top.times;
				top.at = now;
				return;
			}
		}

		Row r;
		r.source   = source;
		r.name     = name;
		r.label    = label;
		r.category = category;
		r.at       = now;
		g_rows.push_front(std::move(r));
		while (g_rows.size() > kMax)
			g_rows.pop_back();
	}

	std::string Json()
	{
		const auto now = std::time(nullptr);
		std::lock_guard lock(g_mutex);

		json items = json::array();
		for (const auto& r : g_rows) {
			items.push_back(json{
				{ "name", r.name },
				{ "label", r.label },
				{ "category", r.category },
				{ "source", SourceName(r.source) },
				{ "times", r.times },
				{ "at", Clock(r.at) },
				{ "ago", Ago(r.at, now) } });
		}
		return json{
			{ "ok", true },
			// The view says "since the game started" rather than implying this
			// is everything you have ever pressed.
			{ "sinceLaunch", true },
			{ "count", static_cast<std::uint32_t>(g_rows.size()) },
			{ "max", static_cast<std::uint32_t>(kMax) },
			{ "items", items }
		}.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	void Clear()
	{
		std::lock_guard lock(g_mutex);
		g_rows.clear();
	}
}
