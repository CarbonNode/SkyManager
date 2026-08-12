#pragma once

#include <string>

// Bridge to the Follower Organizer fork's in-process Deck API.
//
// The supported Follower Organizer build (≥ v0.2.0) exports two C functions —
// FollowerDeck_GetState() and FollowerDeck_Apply(cmdJson) — resolved lazily
// here via GetModuleHandle("FollowerOrganizer.dll") + GetProcAddress. Both
// return an envelope string:
//
//   { "ok": bool, "msg"?: string, "state": { "categories": [...], "total": n } }
//
// The roster data itself lives in FO's own FollowerOrganizer.json; every
// mutation goes through the organizer singleton (which saves with rotating
// backups), so this plugin never writes that file.
//
// All calls are MAIN THREAD ONLY (they touch live game state) — schedule via
// SKSE::GetTaskInterface()->AddTask, same as every other game-touching path.
namespace FollowerDeck
{
	// True once both exports resolve. Safe any time after kDataLoaded.
	bool Available();

	// Full organizer state envelope; a friendly ok:false envelope when the
	// Follower Organizer DLL (or its Deck API) is missing.
	std::string StateJson();

	// Apply one mutation command; returns the envelope with fresh state.
	std::string Apply(const std::string& cmdJson);
}
