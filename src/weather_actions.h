#pragma once

#include <string>

namespace RE
{
	class TESForm;
	class TESWeather;
}

// Weather verbs — the ONE module that touches RE::Sky for the deck.
//
// Two surfaces sit on it:
//   - the Time tab's "Sky" card (tmWeatherList/tmWeatherSet, the original
//     2026-08-17 picker: list every WTHR, force one, "let the sky decide");
//   - the Weather tab (weather_hub.cpp), which adds a gradual blend, a LOCK
//     that survives region changes and load screens, and the weather mods'
//     own controls. It calls the verbs below instead of re-implementing them.
//
// Threading law is item_explorer's: everything here runs on the SKSE task
// thread only (main.cpp AddTasks each call).
//
// Bridge (wired in main.cpp, the Time tab's tm* family): requests
// tmWeatherList/tmWeatherSet; replies tmWeatherListData/tmWeatherResult.
namespace WeatherActions
{
	// {q} -> {weathers:[{id,n,kind,p,cur}], current:{id,n,kind}|null}
	std::string ListJson(const std::string& req);

	// {id:"Plugin|HEX"} forces it; {id:"release"} lets the sky decide again.
	std::string SetJson(const std::string& req);

	// ---- shared verbs (weather_hub.cpp) ------------------------------------

	// "Plugin.esp|00ABCD" — plugin + LOCAL id, so it survives a load-order
	// re-index (a runtime FormID would not). "" for a dynamic form.
	std::string IdOf(const RE::TESForm* form);
	// Resolve an IdOf() string back to the record; nullptr when it is gone.
	RE::TESWeather* Resolve(const std::string& id);
	// Human label from the editor id (po3 Tweaks), "" without one.
	std::string LabelOf(RE::TESWeather* w);
	// clear / cloudy / rain / snow / other, from the record's own flags.
	const char* KindOf(RE::TESWeather* w);

	// Instant (`fw`-style) or a gradual blend (the sky's own transition).
	void Force(RE::TESWeather* w, bool blend);
	// Hand the sky back to the climate. Also drops any lock.
	void Release();

	// Lock: keep THIS weather until unlocked. Region changes, quest scripts
	// and load screens all try to change it; Tick() puts it back.
	void Lock(RE::TESWeather* w);
	void Unlock();
	RE::TESWeather* Locked();
	// Called from main.cpp's 500 ms tick. Cheap when nothing is locked.
	void Tick(bool gameReady, bool paused);
}
