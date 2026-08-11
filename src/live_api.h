#pragma once

#include <cstdint>
#include <functional>
#include <string>

// Live API — a tiny NAMED-PIPE server living inside the plugin so the Deck
// Portal can push a change straight into the RUNNING game instead of leaving a
// sidecar for the 1 s poller to find.
//
// Why a named pipe and not a socket:
//   * same machine by construction — the portal runs on this box, so a pipe is
//     the correct scope. A TCP listener inside the game process would mean a
//     port to collide with, a firewall prompt, and an accidental LAN surface.
//   * no Winsock: no WSAStartup, and none of the winsock2.h-before-windows.h
//     header ordering grief in a project whose PCH already pulled in Windows.h.
//   * node speaks it natively: net.connect({ path: '\\\\.\\pipe\\HotkeyDeck' }).
//
// The sidecar files REMAIN the durable path: the portal writes one whenever the
// pipe is not answering (game closed, plugin older than 0.12.0), so an edit made
// with the game shut down still lands on the next launch. The pipe is purely the
// fast path — same payloads, same appliers, no new data model.
//
// PROTOCOL (one request per connection, newline-framed UTF-8 JSON):
//     -> {"kind":"hotkey-edits","ops":[...]}\n
//     <- {"ok":true,"changed":true,"msg":"2 ops applied"}\n
//   "kind" selects the applier; the rest of the object is exactly the sidecar
//   payload for that kind, so the portal reuses its existing builders verbatim.
//   kind "ping" is a liveness probe and applies nothing.
namespace LiveApi
{
	// Runs on the PIPE thread — never the main game thread. Given the parsed
	// request body, it returns the JSON response body. It must do only
	// config-safe work itself (take g_configMutex, write the config file) and
	// schedule anything touching the engine or a view through
	// SKSE::GetTaskInterface()->AddTask, exactly as the portal poller does.
	using Handler = std::function<std::string(const std::string& requestJson)>;

	// Starts the listener thread. Call once, after kDataLoaded. Never blocks and
	// never throws; a pipe that cannot be created is logged and disabled, and the
	// sidecar path keeps working. `pipeName` is the bare name, e.g. "HotkeyDeck"
	// -> \\.\pipe\HotkeyDeck. Empty name disables the API.
	void Start(const std::string& pipeName, Handler handler);

	// True once the listener thread owns a pipe instance.
	bool Running();

	// The full pipe path in use (for logging), or "" when disabled.
	std::string PipePath();
}
