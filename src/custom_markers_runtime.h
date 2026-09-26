#pragma once

namespace CustomMarkersRuntime
{
	// Does not initialize or change foreign settings. Unknown binaries fail closed.
	bool Supported();
	enum class Status { unsupported, notReady, changed, saveFailed };
	struct Result { Status status; bool showInCombat = false; bool beamsEnabled = false; };
	// Main thread, after the deck closes; changes the owner's cached bool and
	// invokes its own Save. Caller verifies the resulting effective INI.
	Result ToggleCombat();
}
