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

		// Per-face extras (Rober, 2026-08-17, the Skyrim Party Sheet catch-up:
		// "id love to add direction to our follower hud, level badge would be
		// nice too, all toggable … options for health and things too, stamina,
		// magicka"). Each is its own toggle so the strip can stay exactly as
		// lean as he likes. Defaults: the two glanceable ones on, the two
		// extra pools off — three bars per face is clutter nobody asked to
		// start with. When a toggle is OFF its field is simply absent from the
		// row JSON, so an unchanged party costs the change-gated push nothing.
		bool showLevel = true;   // level badge on the portrait corner
		bool showDir   = true;   // direction chevron + distance in meters
		bool showHp    = true;   // health bar
		bool showSt    = false;  // stamina bar
		bool showMk    = false;  // magicka bar

		// Portrait shape (Party Sheet's cuts): circle | rounded | square |
		// diamond. A strip-level CSS class in the view; clamped on every read
		// so a hand-edited config can never put the strip in an unknown state.
		std::string faceShape = "circle";

		// Show / hide toggle key — same shape as the deck's open keys. code 0 =
		// unbound (the HUD then has no key and is toggled from the deck control).
		std::string   keyDevice = "keyboard";
		std::uint32_t keyCode = 0;
		std::string   keyLabel = "";

		// Compact + activator navigation (Rober, 2026-08-18: "auto compacted to
		// just the faces ... press an activator then use wasd or arrows and
		// enter to navigate ... hit hotkey again to close"). compact hides
		// everything but the faces until a chip is browsed; navKey drives the
		// browse state through the input sink WITHOUT focusing the view (the
		// game stays live, hotbar slot-key precedent; the sink cannot consume,
		// so WASD also does its vanilla job while browsing - documented).
		bool          compact = true;   // faces-only IS the default (Rober's spec)
		bool          compactSeeded = false;  // has this config seen the faces-only default?
		std::string   navDevice = "keyboard";
		std::uint32_t navCode = 0;
		std::string   navLabel = "";
	};

	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);
	// "circle" unless the value is exactly one of the four known shapes.
	std::string    ClampShape(const std::string& s);
}
