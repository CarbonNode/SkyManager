#pragma once

#include <string>

// Preset Director's in-process C API (PresetDirector.dll, our own standalone
// SKSE mod) — spawn NPCs and apply RaceMenu presets. Same resolve-once
// GetProcAddress pattern as the FO Deck API (follower_deck.cpp).
//
// ⚠ Call() BLOCKS the calling thread while Preset Director round-trips the
// game thread — so it must only ever be called from a WORKER thread (the
// ask.cpp contract), never from a Prisma callback or an SKSE task.
namespace PresetBridge
{
	bool Available();

	// method "GET"/"POST", path e.g. "/presets", body JSON ("" for GET).
	// Returns the route's JSON reply, or an {ok:false,...} sentence when
	// Preset Director isn't loaded.
	std::string Call(const std::string& method, const std::string& path, const std::string& body);
}
