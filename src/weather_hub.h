#pragma once

#include <string>

/*
 * Weather tab — every weather in the load order, and the weather MODS'
 * own controls, on one page.
 *
 * Rober, 2026-10-08: "weather control in Skymanager? A new tab or something
 * that auto populates and lets you configure stuff" → "id want the list to be
 * dynamic, and hook to a lot of the weather systems we have".
 *
 * ── What auto-populates ──────────────────────────────────────────────────
 *   - The weather list: every WTHR record the load order ships, walked live
 *     (weather_actions.cpp), with what the RECORD says about itself — kind,
 *     lightning (thunder frequency != 255, Storm Lightning's own test),
 *     precipitation, aurora, wind — and which plugin made it and which one
 *     last edited it. A new weather mod shows up without a code change.
 *   - The systems: each adapter below checks for its mod on disk / in the
 *     load order and draws nothing when the mod is absent.
 *
 * ── The adapters, and how each one is driven (verified on the rig) ───────
 *   Storm Lightning      MCM Helper menu + an SKSE DLL that takes its values
 *                        ONLY from Papyrus (StormLightningPluginScript.
 *                        SetIntValue/SetFloatValue — the DLL never reads the
 *                        ini). A change is written three ways, exactly as its
 *                        own MCM does: the StormLGlobal_* global (so its menu
 *                        agrees), the native setter (live), and MCM Helper's
 *                        SetModSetting* (the ini, so the next load restores
 *                        it). The two Papyrus calls run once the game is
 *                        unpaused — the pane says "as you close the deck".
 *                        Labels, ranges and defaults come from the mod's own
 *                        config.json; the presets are its own seven.
 *   Seasons of Skyrim    its Papyrus API (GetCurrentSeason/SetSeasonOverride/
 *                        ClearSeasonOverride) through widgets.cpp's latch —
 *                        the HUD season widget and this card share one asker.
 *   Seasonal Weathers    publishes this month's weather weights as globals
 *   Framework            (Season_Common_* / SN_Season_Common_*): READ, shown
 *                        as odds. Writing them would be undone by its own
 *                        script on the next sleep or load.
 *   R.A.S.S.             MCM Helper + a Papyrus script that adds spells; its
 *                        values are SHOWN, not written (its script applies
 *                        them, and only through its own menu).
 *   Community Shaders    detected; its in-game editor has its own weather
 *                        lock, and two locks fight — the card says so.
 *   Splashes of Storms   detected; a toml read at launch.
 *
 * Sidecar: Data/SKSE/Plugins/HotkeyDeck/weather.json — favourites, the lock,
 * the force mode. Its own file (the config-storage law), C++-owned.
 *
 * Threading: everything runs on the SKSE task thread (main.cpp AddTasks
 * each call). Bridge: wxState / wxSet → wxStateData / wxResult.
 */
namespace WeatherHub
{
	// kDataLoaded: read the sidecar and restore a saved lock.
	void Init();

	// {full?:bool} -> the tab's whole payload; `full` adds the weather list.
	std::string StateJson(const std::string& req);

	// {act:"force"|"release"|"lock"|"unlock"|"fav"|"how"|"storm"|
	//      "sl"|"slPreset"|"season", ...} -> {ok,msg,state}
	std::string SetJson(const std::string& req);
}
