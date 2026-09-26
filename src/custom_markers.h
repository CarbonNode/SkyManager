#pragma once
#include <string>

namespace CustomMarkers
{
	bool Present();
	bool HasToggleHotkeys();
	bool HasCombatToggle();
	bool SupportsAction(const std::string& action);
	bool IsAction(const std::string& action);
	bool SendingInput();
	// Main-thread entry, after ClosePalette. Configured shortcut forwarding, or
	// the guarded combat toggle through the owner's cached settings + Save.
	void Fire(const std::string& action);
}
