// Bridge to the Animation Resolver plugin (our separate SKSE DLL that
// un-wedges stuck jump state and desynced weapon draw/sheathe).
//
// Same in-process pattern as the Follower Deck's FO bridge: the DLL is already
// loaded by SKSE, so this is a GetModuleHandle + GetProcAddress away — no
// keystroke, no IPC. Soft dependency: if the plugin isn't installed, the
// palette entry says so instead of silently doing nothing.

#pragma once

#include <string>

namespace AnimResolverBridge
{
	// True for the "anim-refresh" action verb.
	bool IsAction(const std::string& a_action);

	// Fire the manual resolve. Main thread (called from a task). Notifies the
	// player if the Animation Resolver DLL is not loaded.
	void Fire();
}
