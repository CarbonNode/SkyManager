#pragma once

#include <string>

// Gear Toggle's in-process C API (GearToggle.dll, our standalone mod) — hide
// worn gear per-actor. Same resolve-once GetProcAddress pattern as the FO /
// Preset Director bridges. Call() BLOCKS the caller while GearToggle round-trips
// the game thread, so only ever call it from a WORKER thread.
namespace GearBridge
{
	bool        Available();
	std::string Call(const std::string& method, const std::string& path, const std::string& body);
}
