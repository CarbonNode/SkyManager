#pragma once

#include <string>

// Deck Portal host — starts the portal's Node server with the game and stops it
// with the game, so the web UI is something the deck OWNS rather than something
// you remember to launch.
//
// Rober's design call (2026-08-11), replacing a scheduled task and a hand-copied
// folder: "a just local not exposed to internet server that boots with the dll,
// and a button in the SkyManager to open it (opens browser)."
//
// WHY THIS IS SAFE TO SPAWN AUTOMATICALLY. The portal now binds 127.0.0.1 by
// default and refuses to start on a wider bind without a password (see
// portal/server.js). So a server that comes up on its own is reachable only from
// this machine — there is no network surface to leave open by accident, which is
// exactly what made "boot it with the DLL" the right shape.
//
// NODE IS A REQUIREMENT, NOT A BUNDLE. Rober's call: no node.exe ships with the
// mod, it is named in the description instead. So "Node is missing" is an
// ordinary, expected state for a lot of users, and it is reported as a sentence
// the deck can show — never a crash, never a dead button that silently does
// nothing.
//
// WON'T DOUBLE-START. If something already answers on the port (Rober's own
// DeckPortalKeeper task, or a second game instance) this adopts it instead of
// racing a second server onto a bound socket.
//
// The child is put in a Job Object with KILL_ON_JOB_CLOSE, so it dies with the
// game even if the game CRASHES and never runs our shutdown path. A stray node
// server outliving the game — holding the port so the next launch can't bind —
// is the obvious failure mode of doing this at all.
namespace PortalHost
{
	// Start the server if it isn't already up. Safe to call more than once.
	// Never throws, never blocks on the child.
	void Start();

	// Stop a server WE started. Adopted ones are left alone — they belong to
	// whoever started them.
	void Stop();

	// ptGet -> ptState. What the deck's Portal button needs to render itself:
	//
	//   { "ok": true,
	//     "running": true,          // something is answering on the port
	//     "ours": true,             // we spawned it (vs adopted)
	//     "url": "http://127.0.0.1:8090/",
	//     "node": true,             // node.exe was found
	//     "reason": "" }            // why it is not running, in plain words
	//
	// `reason` is written to be shown to a player, not to a developer.
	std::string StateJson();

	// ptOpen -> ptState. Open the portal in the default browser. Starts the
	// server first if it isn't up, so the button works on the first press.
	// Returns the same payload as StateJson so the caller can react.
	std::string Open();
}
