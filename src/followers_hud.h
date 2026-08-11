#pragma once

#include <cstdint>
#include <string>

// nlohmann::json is provided by the force-included pch (<json.hpp>) — the sibling
// module headers reference it the same way, without an include of their own.

// Followers HUD — an always-on portrait strip of who is CURRENTLY following you
// (Rober, 2026-08-05). Lives in a SECOND PrismaUI view (HotkeyDeck/hud.html) in
// the same view folder as the deck, so `portraits/<file>` resolves the same way
// the roster does. The view is Shown but never Focused during play, so it never
// steals the mouse/keyboard — input passes straight through. It is Focused ONLY
// for the reposition edit-mode (drag / resize / flip). Placement is owned here
// (config slice "hud") and mirrored into the view via window.hudConfig; every
// edit comes back via the hudSave listener.
//
// Ownership split mirrors RoomGuard / LootHighlight: the VIEW owns nothing
// durable; C++ owns the whole Config and pushes it in. The follower list is
// rebuilt each tick from live engine state (IsPlayerTeammate) and pushed only
// when it changes.
namespace FollowersHud
{
	struct Config
	{
		// Master switch. Default OFF — opt-in from the Followers tab, so a fresh
		// install does not sprout an overlay unasked.
		bool enabled = false;

		// Shown vs hidden. The toggle key flips THIS; the HUD draws only when
		// enabled && visible (and always while repositioning).
		bool visible = true;

		// Placement, view pixels at scale 1. The stored anchor is the top-left.
		int   x = 60;
		int   y = 90;
		float scale = 1.0f;

		// "horiz" (a row) or "vert" (a column).
		std::string orient = "horiz";

		// Which corner the strip anchors to / grows FROM. anchorH is the horizontal
		// edge the stored x is measured from ("left" or "right"); anchorV the
		// vertical edge for y ("top" or "bottom"). A row anchored "right" grows
		// leftward; a column anchored "bottom" grows upward. This is the "flip
		// which way it grows" control (Rober, 2026-08-05).
		std::string anchorH = "left";
		std::string anchorV = "top";

		// Name captions under each face.
		bool showNames = true;

		// Refresh cadence for the live follower scan.
		std::uint32_t tickMs = 1200;

		// Cap the strip so a big entourage cannot run off the screen.
		int maxFaces = 12;

		// Show a downed teammate, greyed, rather than dropping her from the strip.
		bool includeDead = true;

		// Show / hide toggle key — same shape as the deck's open keys. code 0 =
		// unbound (the HUD then has no key and is toggled from the deck control).
		std::string   keyDevice = "keyboard";
		std::uint32_t keyCode = 0;
		std::string   keyLabel = "";
	};

	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);
}
