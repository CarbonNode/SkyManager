#pragma once

#include <string>

/*
 * Music tab — what is playing, and a player for anything else.
 *
 * Rober, 2026-10-14: "music controller, see what song is playing in
 * skymanager, change to any other song searchable, favoritable, hook to
 * youtube and stream music in game".
 *
 * ── Two sources, one page ────────────────────────────────────────────────
 *   Skyrim     the engine's own music: BSMusicManager's current music type,
 *              its track (the MUST record, named by po3 Tweaks' editor-id
 *              cache when it is installed) and the queue under it. Every
 *              MUSC record in the load order is listed, so a music mod's
 *              types are first-class. "Play" HOLDS a type: its priority is
 *              raised to 1 in memory (lower wins: combat is 2, explore 49 —
 *              read out of Skyrim.esm) and it is pushed with Papyrus
 *              MusicType.Add(), the call every music mod uses; "Release"
 *              is MusicType.Remove() and puts the priority back. Papyrus
 *              runs unpaused only, so both land as the deck closes. The
 *              engine picks the track inside a type; we name it, we do not
 *              choose it.
 *   YouTube    a hidden mpv.exe child (no window, no video), driven over its
 *              JSON IPC pipe, playing what yt-dlp.exe resolves. Search is
 *              yt-dlp's own "ytsearch", a pasted http(s) link (video or
 *              playlist) lists what it holds. The queue is ours, mpv plays
 *              one item at a time. While a stream is audible the game's
 *              Music category (Skyrim.esm AudioCategoryMUS 0x071E64) is held
 *              at 0 and put back after — the Audio menu's Music slider reads
 *              0 meanwhile, said in the pane.
 *              mpv + yt-dlp are NOT bundled: the tools dir is
 *              SkyManager.ini [Music] sToolsDir, else
 *              %LOCALAPPDATA%\SkyManager\music-tools, else PATH. yt-dlp needs
 *              a JavaScript runtime for YouTube (deno on PATH, or node, which
 *              we pass explicitly when deno is absent).
 *
 * Sidecar: Data/SKSE/Plugins/HotkeyDeck/music.json — favourite types and
 * videos, recents, saved playlists ({id,name,items}), volume, repeat, mute.
 * C++-owned; unknown keys are kept.
 *
 * Threading: StateJson/SetJson run on the SKSE task thread (main.cpp
 * AddTasks each call) — engine reads, the Papyrus dispatch, the category.
 * The stream lives on its own worker thread (pipe I/O, process spawn) and a
 * search on a detached one; neither touches the engine, and the mute is
 * handed back to the main thread with AddTask. Bridge: muState / muSet →
 * muStateData / muResult.
 */
namespace MusicPlayer
{
	// kDataLoaded: read the sidecar, find the tools and the Music category.
	void Init();

	// kPreLoadGame / kNewGame: forget a held type (the engine resets its
	// queue on a load) and put its priority back.
	void OnGameLoading();
	// kPostLoadGame / kNewGame: re-apply the mute if a stream is audible.
	void OnGameLoaded();

	// {full?:bool, plSeq?:int} -> the tab's payload; `full` adds every music
	// type. The saved playlists ride along when `full`, or when plSeq is not
	// the generation C++ holds (the view says which one it has).
	std::string StateJson(const std::string& req);

	// {act:"sk-play"|"sk-release"|"sk-again"|"fav"|"yt-search"|"yt-play"|
	//      "yt-add"|"yt-toggle"|"yt-stop"|"yt-next"|"yt-prev"|"yt-seek"|
	//      "yt-vol"|"yt-drop"|"yt-repeat"|"mute"|"tools-update"|
	//      "pl-new"|"pl-rename"|"pl-delete"|"pl-add"|"pl-drop"|"pl-move", ...}
	//   -> {ok,msg,state[,id]}   (a pl-* reply carries the playlists; pl-new
	//      carries the new list's id)
	std::string SetJson(const std::string& req);

	// Process exit: stop mpv and put the Music category back.
	void Shutdown();
}
