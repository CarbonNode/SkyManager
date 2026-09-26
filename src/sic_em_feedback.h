#pragma once

#include <cstdint>
#include <functional>
#include <optional>

namespace RE { class Actor; }

// The Sic 'em bolt — the "spell" Rober sees when he fires the order.
//
// 2026-09-25 it was a cosmetic: launched only AFTER a target had been chosen,
// from the player's head straight at that actor, so it (a) never fired when
// nothing resolved and (b) flew like a magic missile to whoever the fallback
// had picked instead of going where he was looking. Rober, 2026-09-26: "SIC EM
// SPELL DOES NOT FIRE WHEN NO ENEMIES IN CELL, AND WHEN IT DOES IT SEEMS TO
// LIKE MAGIC MISSLE TO AN NPC AND NOT FLY OUT OF CROSSHAIR WHERE IM LOOKING".
//
// Now it is EFF's targeting spell for real: every press fires the bolt down the
// crosshair, and when the instant rules (crosshair snapshot, longshot) find no
// one, whoever the bolt LANDS ON is the target. The bolt never homes.
namespace SicEmFeedback
{
	// Once, from NpcActions::Init (kDataLoaded): a vtable hook on
	// MissileProjectile::AddImpact so the bolt can report what it struck.
	// Safe to call twice; logs once.
	void InstallHooks();

	// What the bolt met.
	struct Impact
	{
		std::uint32_t collidee = 0;  // FormID of the reference struck, 0 = scenery
		float         x = 0.0f, y = 0.0f, z = 0.0f;  // where the bolt was when it hit
	};

	// Fire the bolt from the player's head along the CAMERA aim, converging on
	// the point the crosshair ray meets the world (so a close target is not
	// missed by the third-person camera offset). Straight flight, no damage,
	// no threat. Returns false when the projectile art is missing or unsafe —
	// nothing was launched and there is nothing to await. Main thread.
	bool FireAlongAim();

	// Wait for the bolt fired by the last FireAlongAim to land, die or fly its
	// range, then call `onDone` ON THE MAIN THREAD with the impact — nullopt
	// when it met nothing. One waiter at a time: a newer FireAlongAim
	// supersedes an earlier waiter silently (its onDone is dropped). Polling
	// is a thread posting SINGLE-SHOT tasks, never a task that re-adds itself
	// (see the AddTask self-repost freeze in npc_actions.cpp). Main thread.
	void AwaitImpact(std::function<void(std::optional<Impact>)> onDone);

	// The eight-second gold ping on the actor the order actually went for.
	// Cosmetic; safe on any actor. Main thread.
	void Ping(RE::Actor* target);
}
