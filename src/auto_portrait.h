#pragma once

#include <filesystem>
#include <functional>
#include <set>
#include <string>

/*
 * AutoPortrait — real in-game face photos, taken by themselves (2026-10-12).
 *
 * Rober, after the MRF head renders kept coming out wrong for some NPCs (Sol's
 * white eyes, untinted hair everywhere): "can it just be smarter and more
 * dynamic??" The renders are an imitation of the game's renderer; a photo of
 * the game's own frame is right by construction. So: while the deck is open,
 * anyone on the roster who is loaded nearby and has no real photo gets one —
 * at most two per open, nearest first — and the render stays only as the
 * placeholder for people you have not been near yet.
 *
 * THE CONTRACT (proven offline in tools/auto_portrait_policy_test.cpp):
 *   - a portrait the PLAYER took or dropped in is never overwritten;
 *   - our own photo is retaken only when her look changes (hair, head parts,
 *     race, hair colour) — not for a helmet, which is hidden for the shot;
 *   - one try per person per look per session, so a failure never loops.
 *
 * THE SEQUENCE (all built from play-proven pieces):
 *   view -> fdAutoPhoto {op:"consider", people:[{id,slug,name}]}   (after first paint)
 *   C++  -> fdAutoPhotoStart {names}      the view hides the deck, then...
 *   view -> fdAutoPhoto {op:"go"}         ...says the deck is off the frame
 *   C++  : HUD off, PersonLive::StartFace (free-camera lease, portrait fill,
 *          world frozen, helmet culled), wait for a STEADY frame (probe diff,
 *          not a fixed delay), PortraitCapture::CaptureAutoPortrait, next one,
 *          then put EVERYTHING back
 *   C++  -> fdPortraits (refreshed) + fdAutoPhotoDone {taken, failed}
 * Every exit — success, refusal, timeout, palette close, load — restores the
 * camera, lights, HUD, focus and helmet, and tells the view to show the deck.
 *
 * MAIN THREAD for every entry point; the waits run on a worker.
 */
namespace AutoPortrait
{
	struct Hooks
	{
		std::function<void(const char*, const std::string&)> push;   // PushToView
		std::function<std::string()> portraitsJson;                  // FolPortraitsJson
		std::function<void()> enterLiveFocus;                        // same as the live view
		std::function<void()> restoreFocus;
		std::function<void(bool)> hudViewHidden;                     // hide the HUD view (widgets) for the shot
		std::filesystem::path portraitDir;                           // <deck view>/portraits
	};
	void Init(Hooks hooks);

	// fdAutoPhoto {op:"consider"|"go"|"set", ...}
	void OnMessage(const std::string& payload);

	// Palette close, force-close, save load: stop and restore now. Idempotent.
	void Abort(const char* why);

	bool Busy();

	// Every portrait file auto photos ever wrote in `dir` (lower-cased names, all
	// versions, read from its auto-portraits.json). THE WINNER RULE uses it: a
	// file the player supplied beats any auto photo of the same person whatever
	// the dates (Rober, 2026-10-12: user-supplied images over auto generation).
	// FolPortraitsJson (main.cpp) and the portal's betterPortrait() both apply it.
	std::set<std::string> AutoFiles(const std::filesystem::path& dir);
}
