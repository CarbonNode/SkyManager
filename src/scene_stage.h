#pragma once

#include <cstdint>
#include <string>

// Scene staging for photo mode — set the LIGHT before you take the picture.
//
// WHY: Rober, 2026-08-03 — "domain picture taking settings end up kinda dark
// or weather issues etc. maybe a button to set like weather or brightness /
// time of day?". A domain photo is a landscape shot of wherever you happen to
// be standing at whatever o'clock it happens to be, and a keep photographed at
// 3am in a blizzard is a black rectangle. Nothing about the CAPTURE can fix
// that: the back-buffer grab is faithful, and the frame really was dark.
//
// So this changes the WORLD for the length of the shot and puts it back
// afterwards. Two knobs, both engine-native:
//
//   TIME  — Calendar's GameHour global, set absolutely (the Time tab's Jump()
//           is relative and refuses in combat; this is the same global, aimed
//           at an hour rather than nudged by one). The engine drives the sun,
//           the shadows and the ambient light off it.
//   SKY   — Sky::ForceWeather(w, override=true), which SNAPS rather than
//           transitioning: a 30-second cross-fade is useless when the point is
//           to take one frame. Restore calls ReleaseWeatherOverride() +
//           ResetWeather() so the game's own weather system takes back over,
//           rather than force-holding the old weather (which would leave the
//           override flag set and freeze the sky for the rest of the session).
//
// Weather is never hardcoded to a FormID. The list is read from the load order
// (GetFormArray<TESWeather>) and each entry is CLASSIFIED by the engine's own
// data flags (pleasant / cloudy / rainy / snow), so a weather-overhaul mod's
// weathers are first-class and no id can go stale when the load order moves.
//
// Everything is single-flight and self-restoring: Apply() snapshots once, and
// Restore() is idempotent, so a photo cancelled or timed out puts the world
// back exactly like a successful one does.
namespace SceneStage
{
	struct Request
	{
		float         hour = -1.0f;   // <0 = leave the clock alone
		std::uint32_t weather = 0;    // 0  = leave the sky alone
	};

	// {hour, weatherId, weatherName, presets:[{key,id,name}], list:[{id,name,kind}]}
	// or "null" when there is no loaded game to ask. Main thread.
	std::string InfoJson();

	// Applies what the request names, snapshotting the current hour/weather the
	// FIRST time it changes anything. Main thread; `err` set on refusal.
	bool Apply(const Request& r, std::string& err);

	// Put back whatever Apply() changed. Safe to call when nothing was staged.
	void Restore();

	// True between an Apply() that changed something and its Restore().
	bool Staged();
}
