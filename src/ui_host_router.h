#pragma once

#include "PrismaUI_API.h"

#include <string>

// UiHostRouter (2026-10-10, marker ui-host-router) — run the MAIN DECK on Magelight UI
// while every other view stays on Prisma UI.
//
// Why: Prisma UI rasterises every view on the CPU and draws its cursor after the game's
// interface pass, where frame generation blends it like scenery. Magelight UI draws the
// same Ultralight pages on the GPU, draws its cursor in the interface pass, and has a
// supported "stop drawing the world behind a paused page" switch. Rober, 2026-10-10:
// "cpu is usually taxed ... an alternative plugin or something, not a full switch".
//
// Shape: an IVPrismaUI1 that forwards to the real Prisma UI API, except for the one view
// created from "HotkeyDeck/index.html", which it creates and drives through Magelight's v4
// C API. Its handle is tagged so every later call on it routes to Magelight; every other
// handle goes to Prisma UI untouched. No call site in SkyManager changes.
//
// Off unless asked for: Settings -> UI renderer = Magelight (settings.uiHost), or
// SkyManager.ini UiHost=magelight / MagelightDeck=1, and Magelight.dll loaded with host
// 0.31.1 or newer. Anything missing or refused -> the deck is created on
// Prisma UI as before, and the log says why. Optional: MagelightFreezeWorld=1 asks
// Magelight to skip the 3D world behind the PAUSED deck (its SetViewFreezeWorld).
//
// Threading: Magelight calls page listeners inline on the render thread inside Present.
// Prisma UI called them on its own UI thread, and SkyManager's handlers are written for
// that (they AddTask to the game thread). So the router copies each call and runs it on
// one ordered worker thread of its own, which is also what Magelight's threading
// contract asks for (no SKSE AddTask from inside a frame).
namespace UiHostRouter
{
	// Returns a router wrapping `prisma` when `wantMagelight` and Magelight is usable,
	// otherwise returns `prisma` itself. `source` names where the choice came from, for
	// the log ("Settings", "SkyManager.ini MagelightDeck=1"). Call once, right after
	// Prisma UI's API is acquired and the config is loaded. Always records GetStatus().
	PRISMA_UI_API::IVPrismaUI1* Wrap(PRISMA_UI_API::IVPrismaUI1* prisma, bool wantMagelight,
		const std::string& source);

	// True when the deck view is actually living on Magelight (after its CreateView).
	bool DeckOnMagelight();

	// What Settings shows: is Magelight UI installed, which version, is it new
	// enough, and (when the deck fell back to Prisma UI) why.
	struct Status
	{
		bool        magelightFound = false;
		bool        magelightUsable = false;
		std::string magelightVersion;
		std::string note;
	};
	Status GetStatus();
}
