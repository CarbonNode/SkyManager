#pragma once

#include <cstdint>
#include <memory>
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

	// The most recent StateJson() envelope, if it is younger than maxAgeMs and
	// no Apply() has run since; otherwise a fresh StateJson() (which refills the
	// cache). For PERIODIC readers only — the HUD roster tick and the court
	// writer — that need roster identity (names, form ids), not this second's
	// teammate flags.
	//
	// Why it exists (2026-10-07 smoothness pass): FO's state builder walks
	// every loaded actor for every member stored as a base form, then the whole
	// envelope is serialised and parsed back. The HUD ticker paid that ~50x a
	// minute on the game thread: the perf census read "hud-roster 50x worst
	// 15.9ms total 221ms", i.e. a frame-sized hitch about once a second.
	//
	// The pointer is stable until the next refresh, so a caller can compare it
	// to the one it saw last time and skip re-deriving anything from it.
	// Any thread; the fresh build itself still needs the main thread, like StateJson.
	std::shared_ptr<const std::string> CachedState(std::int64_t maxAgeMs);
}
