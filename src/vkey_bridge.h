#pragma once

#include <cstdint>
#include <string>

// VirtualKey support (Nexus 187350, "VirtualKey - Virtual Hotkeys for MCM").
//
// VirtualKey hands MCM hotkeys an independent virtual-key range (100000..9999999)
// so a mod's KeyMap can be bound to, say, [VK003] instead of eating a real
// keyboard key. The deck's normal keystroke entries fire OS-level SendInput
// (real scancodes) and CANNOT reach these values -- a virtual key is not a
// keyboard key. So a `device:"vkey"` deck entry fires the virtual key the way
// VirtualKey's own NativeInputBackend does: it constructs a keyboard ButtonEvent
// carrying the virtual idCode and pushes it through BSInputDeviceManager. Every
// MCM-bound mod reacts because VirtualKey's SKSEInputPatch (active whenever the
// mod is loaded) lets SKSE deliver the high idCode to RegisterForKey listeners.
//
// This deliberately does NOT use VirtualKey's Papyrus API: the 1.0.0 release
// archive shipped without Scripts\VirtualKey.pex, so that API is inert until the
// author fixes it. Native dispatch is self-contained in our DLL and identical to
// what VirtualKey does internally, so it works regardless of that packaging bug.
namespace VKey
{
	inline constexpr std::int32_t kBase = 100000;
	inline constexpr std::int32_t kMax  = 9999999;

	bool IsVirtualKey(std::int32_t code);

	// Fire a virtual key. verb: "tap" (down, then up after holdMs), "down", "up".
	// Dispatches on the game thread; returns immediately. No-op (logged) if the
	// code is out of range or the input manager is unavailable.
	void Fire(std::int32_t code, const std::string& verb = "tap", int holdMs = 110);

	// VirtualKey's discovered-binding catalog (Data/SKSE/Plugins/VirtualKey/
	// Bindings.json) as a JSON array string for the picker:
	//   [{ "key":100003, "label":"Target Lock", "mod":"...", "page":"...",
	//      "option":"...", "verification":"verified" }, ...]
	// Empty array if the file is missing/unreadable -- the picker still offers
	// manual number entry, so an absent catalog is never a dead end.
	std::string CatalogJson();
}
