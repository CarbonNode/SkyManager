#pragma once

#include <string>

// Sweeping Organizes Stuff owns the animation and every object it restores.
// Call on the game thread after closing the palette; Papyrus must stay unpaused.
namespace BroomCleanup
{
	bool IsAction(const std::string& action);
	void Fire();
	void Reset();  // discard a pending callback's ownership when a save is loaded
}
