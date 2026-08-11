#include "scene_stage.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace SceneStage
{
	namespace
	{
		bool          g_staged = false;
		bool          g_hadHour = false;
		float         g_savedHour = 0.0f;
		bool          g_hadWeather = false;

		RE::TESWeather* WeatherById(std::uint32_t id)
		{
			if (!id)
				return nullptr;
			auto* form = RE::TESForm::LookupByID(id);
			return form ? form->As<RE::TESWeather>() : nullptr;
		}

		// The engine's own classification, straight off the weather record. Used
		// for the chips in the view AND to pick the quick presets, so "Clear"
		// means the same thing here and there.
		const char* KindOf(const RE::TESWeather* w)
		{
			if (!w)
				return "other";
			const auto f = w->data.flags;
			if (f.any(RE::TESWeather::WeatherDataFlag::kSnow))     return "snow";
			if (f.any(RE::TESWeather::WeatherDataFlag::kRainy))    return "rain";
			if (f.any(RE::TESWeather::WeatherDataFlag::kPleasant)) return "clear";
			if (f.any(RE::TESWeather::WeatherDataFlag::kCloudy))   return "cloudy";
			return "other";
		}

		// A weather record has no FULL name, so the only human label available is
		// its editor id — which the runtime keeps only when something (po3's
		// Tweaks, usually) preserved it. Fall back to the plugin + local id,
		// which is at least stable and recognisable in xEdit.
		std::string NameOf(RE::TESWeather* w)
		{
			if (!w)
				return "";
			const char* edid = w->GetFormEditorID();
			if (edid && *edid)
				return edid;
			char buf[64];
			std::snprintf(buf, sizeof(buf), "Weather %08X", static_cast<unsigned>(w->GetFormID()));
			return buf;
		}

		std::vector<RE::TESWeather*> AllWeathers()
		{
			std::vector<RE::TESWeather*> out;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return out;
			for (auto* w : dh->GetFormArray<RE::TESWeather>())
				if (w)
					out.push_back(w);
			return out;
		}
	}

	bool Staged() { return g_staged; }

	std::string InfoJson()
	{
		auto* cal = RE::Calendar::GetSingleton();
		auto* sky = RE::Sky::GetSingleton();
		if (!cal || !cal->gameHour)
			return "null";

		json j;
		j["hour"] = cal->gameHour->value;
		j["staged"] = g_staged;

		auto* cur = sky ? sky->currentWeather : nullptr;
		j["weatherId"] = cur ? static_cast<std::uint32_t>(cur->GetFormID()) : 0u;
		j["weatherName"] = NameOf(cur);
		j["weatherKind"] = KindOf(cur);

		// The full list, so the pane can offer a searchable picker rather than
		// four buttons and no way to reach a weather mod's own sky.
		json list = json::array();
		json presets = json::object();
		for (auto* w : AllWeathers()) {
			const std::string kind = KindOf(w);
			list.push_back(json{
				{ "id", static_cast<std::uint32_t>(w->GetFormID()) },
				{ "name", NameOf(w) },
				{ "kind", kind },
			});
			// First of each kind wins the quick chip. Vanilla Skyrim.esm loads
			// first, so the presets are the vanilla skies unless a mod actually
			// replaced them.
			if (kind != "other" && !presets.contains(kind)) {
				presets[kind] = json{
					{ "id", static_cast<std::uint32_t>(w->GetFormID()) },
					{ "name", NameOf(w) },
				};
			}
		}
		j["list"] = list;
		j["presets"] = presets;
		return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	bool Apply(const Request& r, std::string& err)
	{
		const bool wantHour = r.hour >= 0.0f;
		const bool wantSky = r.weather != 0;
		if (!wantHour && !wantSky)
			return true;   // nothing asked for is not a failure

		auto* cal = RE::Calendar::GetSingleton();
		auto* sky = RE::Sky::GetSingleton();

		RE::TESWeather* w = nullptr;
		if (wantSky) {
			w = WeatherById(r.weather);
			if (!w) {
				err = "That weather is not in this load order any more.";
				return false;
			}
			if (!sky) {
				err = "The sky is unreachable right now.";
				return false;
			}
		}
		if (wantHour && (!cal || !cal->gameHour)) {
			err = "The clock is unreachable right now.";
			return false;
		}

		// Snapshot ONCE. Staging twice before a restore (change the hour, then
		// the sky) must still put back the world as it was before the first
		// change, not as it was mid-staging.
		if (wantHour && !g_hadHour) {
			g_savedHour = cal->gameHour->value;
			g_hadHour = true;
		}
		if (wantSky && !g_hadWeather)
			g_hadWeather = true;

		if (wantHour) {
			// Absolute, and wrapped into the day rather than added to it: the
			// GameHour global is hour-of-day and the engine advances the DATE
			// from it, so writing 26 would silently roll the calendar.
			float h = std::fmod(r.hour, 24.0f);
			if (h < 0.0f)
				h += 24.0f;
			logger::info("scene: hour {:.2f} -> {:.2f}", cal->gameHour->value, h);
			cal->gameHour->value = h;
		}
		if (wantSky) {
			// override=true SNAPS. SetWeather's transition is a 30-second
			// cross-fade, which is useless when the point is one frame.
			logger::info("scene: forcing weather {} ({:08X})", NameOf(w), static_cast<unsigned>(w->GetFormID()));
			sky->ForceWeather(w, true);
		}
		g_staged = true;
		return true;
	}

	void Restore()
	{
		if (!g_staged)
			return;
		g_staged = false;

		if (g_hadHour) {
			auto* cal = RE::Calendar::GetSingleton();
			if (cal && cal->gameHour) {
				logger::info("scene: hour restored to {:.2f}", g_savedHour);
				cal->gameHour->value = g_savedHour;
			}
			g_hadHour = false;
		}
		if (g_hadWeather) {
			auto* sky = RE::Sky::GetSingleton();
			if (sky) {
				// Hand the sky BACK to the game rather than force-holding the
				// weather we found. Forcing the old one would leave the override
				// flag set and freeze the weather for the rest of the session —
				// the photo would "work" and the world would stop having weather.
				logger::info("scene: weather override released");
				sky->ReleaseWeatherOverride();
				sky->ResetWeather();
			}
			g_hadWeather = false;
		}
	}
}
