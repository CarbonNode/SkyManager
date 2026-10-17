#pragma once

#include <string>

// ---------------------------------------------------------------------------
// OStim add-on settings — the Scene page's Fluids popout (Rober, 2026-10-14:
// "new ostim mod just added having to do with liquids, hook to it and add
// controls to our [Scene] menu"; the mod is OStrands, Nexus 195115).
//
// THE HOOK IS NOT IN THIS DLL. It lives in its own plugin and archive,
// modding/skymanager-ostim-addons (SkyManagerOStimAddons.dll), because Rober
// wants every hook into another mod shipped apart ("always make hooks in
// seperate archive fyi so if it updates"): when OStim or OStrands changes,
// only that small DLL is rebuilt. That plugin puts a pass-through proxy in
// front of OStim's SettingInterface and keeps the groups OStrands registers;
// see its bridge.h for the mechanism and its guards.
//
// This side only finds the plugin (GetModuleHandle + GetProcAddress, the
// Follower Organizer / Gear Toggle soft-dependency idiom) and passes JSON
// through. Without it, the popout says which archive to install.
// ---------------------------------------------------------------------------

namespace OstimAddons
{
	// { ok, hooked, loaded, bridge, why, groups:[{ group, name, settings:[{
	//   index, name, tooltip, type, enabled, on|value,min,max,step,def|
	//   options,choice|text|key }] }] }. Main thread.
	std::string StateJson();

	// { op:"set", group, name, index, action:"toggle"|"value"|"choice"|"click"|"key",
	//   value } -> StateJson with { ok, msg }. Main thread.
	std::string Set(const std::string& request);
}
