#pragma once

#include <string>

// Weather picker — the Time tab's "Sky" card. Lists every WTHR the load
// order ships (labelled via po3 Tweaks' editor-id hook, classified from the
// record's own pleasant/cloudy/rainy/snow flags) and forces one through
// Sky::ForceWeather, or hands the sky back with ReleaseWeatherOverride.
//
// Threading law is item_explorer's: both entry points run on the SKSE task
// thread only (main.cpp AddTasks each call). Nothing here persists — a
// forced weather is a moment, not a setting.
//
// Bridge (wired in main.cpp, the Time tab's tm* family): requests
// tmWeatherList/tmWeatherSet; replies tmWeatherListData/tmWeatherResult.
namespace WeatherActions
{
	// {q} -> {weathers:[{id,n,kind,p,cur}], current:{id,n,kind}|null}
	std::string ListJson(const std::string& req);

	// {id:"Plugin|HEX"} forces it; {id:"release"} lets the sky decide again.
	std::string SetJson(const std::string& req);
}
