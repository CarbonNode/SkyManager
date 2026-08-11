#pragma once

#include <functional>
#include <string>

/* ===================================================================== *
 *  Sharmat bridge — the deck's ONLY outbound network call.
 *
 *  Talks to CHIM's aiagent_nsfw admin API (config_manager.php) inside the
 *  DwemerAI4Skyrim3 WSL distro, so the Followers tab can show and edit an
 *  NPC's intimacy profile without alt-tabbing to the web config page.
 *
 *  ⛔ EVERY REQUEST RUNS OFF THE MAIN THREAD. ⛔
 *  This is not a style preference. CHIM's server serialises work behind a
 *  semaphore and has been measured holding it for 8.5–12.4 s per event
 *  while the game plugin floods it with ~20 req/s; a synchronous call from
 *  the game thread would convoy behind that and reproduce exactly the
 *  fast-travel / door / mid-speech freezes that were tracked down and
 *  fixed in 2026-07. Call(), therefore, returns IMMEDIATELY, does the
 *  round trip on a detached worker, and delivers the reply back on the
 *  main thread via SKSE's task interface.
 *
 *  The bridge is deliberately a DUMB PIPE: it knows how to reach CHIM and
 *  nothing about what the fields mean. Building the form body, merging a
 *  patch over the current profile and re-posting the whole field set (see
 *  the destructive-partial-save trap documented in the view and in
 *  portal/server.js) all live in JavaScript, once, shared by the deck view
 *  and the phone portal. Adding a field is a view edit; it never comes
 *  back here.
 * ===================================================================== */

namespace Sharmat
{
	/* Envelope handed to `done`, always valid JSON:
	     { "id": "...", "ok": true,  "status": 200, "json": <parsed reply> }
	     { "id": "...", "ok": false, "error": "…", "chimDown": true|false }
	   `chimDown` distinguishes "CHIM isn't running" (the normal resting
	   state — it only lives while Skyrim does) from "CHIM answered badly",
	   because the view says very different things about the two. */
	using Reply = std::function<void(const std::string& envelopeJson)>;

	/* Fire one request. `query` and `form` are already URL-encoded key=value
	   strings (empty `form` means GET). `done` runs on the MAIN thread. */
	void Call(std::string id, std::string action, std::string query, std::string form, Reply done);

	/* Candidate base URLs, tried in order until one answers; the winner is
	   pinned for the session and dropped again on its first failure.

	   ⚠ BOTH OF THESE ARE CURRENTLY UNWIRED — nothing calls them, so the
	   linker strips them and any string literal inside them. They are the
	   seam for a future "CHIM URL" config knob; the built-in candidate list
	   (localhost first, then the distro IP) covers both real cases today.
	   Do NOT pick a build marker from in here: a marker in dead code is
	   silently absent from the DLL and protects nothing. Take one from the
	   request path instead — `Call` is where the live literals are. */
	void SetBaseUrl(const std::string& base);
	std::string BaseUrl();

	/* Stop issuing new requests and let in-flight workers unwind quietly.
	   Called when the plugin is going away so a pending 6-second timeout can
	   never fire a callback into a torn-down view. */
	void Shutdown();
}
