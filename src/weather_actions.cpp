// Weather picker — the Time tab's "Sky" card (PROTEUS's weather menu,
// rebuilt over the whole load order instead of its 25 hardcoded forms).
// See weather_actions.h for the contract.
//
// Design notes that are load-bearing:
//  - TESWeather has NO display name — only an editor id, which vanilla SKSE
//    cannot read for WTHR. This rig runs powerofthree's Tweaks, whose hook
//    makes GetFormEditorID real for every form; when the id still comes back
//    empty (no po3, or a truly nameless record) the row degrades to its
//    classification + local id, honestly labelled, never dropped.
//  - Forcing uses Sky::ForceWeather(w, override=true) — the same engine door
//    the console's `fw` uses; "Let the sky decide" is ReleaseWeatherOverride
//    + ResetWeather so natural weather resumes instead of sticking forever.
//  - The classification chip comes from data.flags (pleasant/cloudy/rainy/
//    snow) — the one piece of semantics a WTHR record actually carries.
//  - The LOCK (Weather tab, 2026-10-08) is the Community Shaders editor's
//    idea rebuilt without its hooks: ForceWeather(override) holds until a
//    region change, a load screen or a quest script changes the sky, so the
//    500 ms tick puts the locked weather back whenever it is not current and
//    the player is under an open sky. Interiors are left alone — they show no
//    weather, and forcing one there is what makes the next exit flash.

#include "weather_actions.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace WeatherActions
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

	}

	// =========================================================== helpers ==

	std::string IdOf(const RE::TESForm* form)
	{
		if (!form)
			return {};
		auto* file = form->GetFile(0);
		if (!file)
			return {};
		const std::uint32_t local =
			form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
		char buf[16];
		std::snprintf(buf, sizeof(buf), "%06X", local);
		return std::string(file->GetFilename()) + "|" + buf;
	}

	const char* KindOf(RE::TESWeather* w)
	{
		if (!w)
			return "other";
		using F = RE::TESWeather::WeatherDataFlag;
		const auto flags = w->data.flags;
		if (flags.any(F::kSnow))
			return "snow";
		if (flags.any(F::kRainy))
			return "rain";
		if (flags.any(F::kCloudy))
			return "cloudy";
		if (flags.any(F::kPleasant))
			return "clear";
		return "other";
	}

	// Editor id via po3 Tweaks' hook; "" without it. Turned into a human
	// label by splitting the CamelCase ("SkyrimStormRain" -> "Skyrim Storm
	// Rain") so the list reads like a menu, not a code dump.
	std::string LabelOf(RE::TESWeather* w)
	{
		if (!w)
			return {};
		const char* eid = w->GetFormEditorID();
		if (!eid || !*eid)
			return {};
		std::string out;
		const char* p = eid;
		for (; *p; ++p) {
			if (std::isupper(static_cast<unsigned char>(*p)) && !out.empty() &&
				!std::isupper(static_cast<unsigned char>(out.back())) && out.back() != ' ')
				out += ' ';
			out += *p;
		}
		return out;
	}

	// ================================================================ API ==

	std::string ListJson(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = Lower(in.value("q", std::string("")));

		auto* dh = RE::TESDataHandler::GetSingleton();
		auto* sky = RE::Sky::GetSingleton();
		if (!dh)
			return Dump(json{ { "weathers", json::array() } });

		const std::string curId = sky && sky->currentWeather ? IdOf(sky->currentWeather) : "";

		struct Row { std::string id, label, kind, plugin; bool current; };
		std::vector<Row> rows;
		for (auto* w : dh->GetFormArray<RE::TESWeather>()) {
			if (!w)
				continue;
			auto* file = w->GetFile(0);
			if (!file)
				continue;   // dynamic — not durable, not offerable
			Row r;
			r.id = IdOf(w);
			r.label = LabelOf(w);
			r.kind = KindOf(w);
			r.plugin = std::string(file->GetFilename());
			if (r.label.empty())
				r.label = std::string(r.kind) + " weather " + r.id.substr(r.id.find('|') + 1);
			r.current = !curId.empty() && r.id == curId;
			if (!q.empty()) {
				const std::string hay = Lower(r.label) + " " + Lower(r.plugin) + " " + r.kind;
				bool ok = true;
				std::string tok;
				for (char c : q + " ") {
					if (c == ' ') {
						if (!tok.empty() && hay.find(tok) == std::string::npos) { ok = false; break; }
						tok.clear();
					} else {
						tok += c;
					}
				}
				if (!ok)
					continue;
			}
			rows.push_back(std::move(r));
		}
		std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
			if (a.kind != b.kind)
				return a.kind < b.kind;
			return a.label < b.label;
		});

		json out = json::array();
		for (auto& r : rows) {
			if (out.size() >= 400)
				break;
			out.push_back(json{ { "id", r.id }, { "n", r.label }, { "kind", r.kind },
				{ "p", r.plugin }, { "cur", r.current } });
		}
		json cur = json();
		if (sky && sky->currentWeather) {
			cur = json{ { "id", curId }, { "n", LabelOf(sky->currentWeather) },
				{ "kind", KindOf(sky->currentWeather) } };
		}
		return Dump(json{ { "weathers", std::move(out) }, { "current", std::move(cur) } });
	}

	std::string SetJson(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));

		if (!RE::Sky::GetSingleton())
			return Dump(json{ { "ok", false }, { "msg", "The sky is unreachable" } });

		if (id == "release") {
			Release();
			return Dump(json{ { "ok", true }, { "msg", "The sky decides again" } });
		}

		if (id.find('|') == std::string::npos || id.front() == '|')
			return Dump(json{ { "ok", false }, { "msg", "Malformed weather id" } });
		auto* w = Resolve(id);
		if (!w)
			return Dump(json{ { "ok", false }, { "msg", "That weather is gone from the load order" } });

		Force(w, false);
		std::string label = LabelOf(w);
		if (label.empty())
			label = "the chosen weather";
		return Dump(json{ { "ok", true }, { "msg", "The sky turns to " + label },
			{ "id", id } });
	}

	// ====================================================== shared verbs ==

	RE::TESWeather* Resolve(const std::string& id)
	{
		const auto bar = id.find('|');
		if (bar == std::string::npos || bar == 0 || bar + 1 >= id.size())
			return nullptr;
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return nullptr;
		return dh->LookupForm<RE::TESWeather>(
			static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16)),
			id.substr(0, bar));
	}

	namespace
	{
		// Main-thread only (every caller is an AddTask'd lambda or the tick),
		// so no lock: the same law as the rest of this file.
		std::string     g_lockId;
		RE::TESWeather* g_lockW = nullptr;
		int             g_reapplied = 0;
	}

	void Force(RE::TESWeather* w, bool blend)
	{
		auto* sky = RE::Sky::GetSingleton();
		if (!sky || !w)
			return;
		if (blend) {
			// The sky's own transition (CS's "gradual" path): override on,
			// no acceleration, so it rolls in at the record's trans delta.
			sky->SetWeather(w, true, false);
			logger::info("weather: blending to '{}'", IdOf(w));
		} else {
			sky->ForceWeather(w, true);
			logger::info("weather: forced '{}'", IdOf(w));
		}
		// Forcing something else while locked moves the lock with it —
		// otherwise the very next tick would undo what was just asked for.
		if (g_lockW && g_lockW != w) {
			g_lockW = w;
			g_lockId = IdOf(w);
		}
	}

	void Release()
	{
		auto* sky = RE::Sky::GetSingleton();
		Unlock();
		if (!sky)
			return;
		sky->ReleaseWeatherOverride();
		sky->ResetWeather();
		logger::info("weather: override released - the sky decides again");
	}

	void Lock(RE::TESWeather* w)
	{
		if (!w)
			return;
		g_lockW = w;
		g_lockId = IdOf(w);
		g_reapplied = 0;
		logger::info("weather: locked '{}'", g_lockId);
	}

	void Unlock()
	{
		if (!g_lockW && g_lockId.empty())
			return;
		logger::info("weather: unlocked '{}' after {} re-apply(s)", g_lockId, g_reapplied);
		g_lockW = nullptr;
		g_lockId.clear();
		g_reapplied = 0;
	}

	RE::TESWeather* Locked()
	{
		return g_lockW;
	}

	void Tick(bool gameReady, bool paused)
	{
		if (!g_lockW || !gameReady || paused)
			return;
		auto* sky = RE::Sky::GetSingleton();
		if (!sky || sky->mode.get() != RE::Sky::Mode::kFull)
			return;   // interior / no sky: nothing to hold, nothing to flash
		if (sky->currentWeather == g_lockW)
			return;
		sky->ForceWeather(g_lockW, true);
		++g_reapplied;
		// First few, then every 50th: a region that fights the lock all
		// session must not fill the log.
		if (g_reapplied <= 3 || g_reapplied % 50 == 0)
			logger::info("weather-lock: re-applied '{}' (#{}, the sky had moved to '{}')", g_lockId,
				g_reapplied, IdOf(sky->currentWeather));
	}
}
