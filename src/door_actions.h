#pragma once

#include <string>

// F7-on-a-door → the lock popup. The crosshair reference is snapshotted at
// palette open (NpcActions already freezes the non-actor ref); when its base
// form is a DOOR the view gets a drTarget payload and raises a centered modal:
// Lock (at a chosen level) / Unlock, with the door's current state shown.
//
// The mutation is the console's own `lock <level>` / `unlock` compiled against
// the door reference — deliberately, not a hand-rolled ExtraLock edit: the
// console path ADDS lock data to a door that never had any (most house doors),
// clears the right flags, and is the exact code path every player-typed
// `lock` has exercised for a decade. Reversible by construction (`unlock`).
//
// Lock levels (CK canon): 1 Novice · 25 Apprentice · 50 Adept · 75 Expert ·
// 100 Master · >100/255 Requires Key (unpickable without the key).
namespace DoorActions
{
	// Freeze the crosshair DOOR for this palette-open. Call right after
	// NpcActions::SnapshotTarget() (it reads that snapshot's non-actor ref).
	// Main thread only.
	void SnapshotTarget();

	// "null", or the door's live state:
	// { refId, name, hasLock, locked, level, tier, keyName }.
	// Main thread only (reads the reference).
	std::string TargetJson();

	// Lock (at `level`, clamped 0-255) or unlock the snapshotted door.
	// Returns { ok, msg, state } — state is the re-read truth after the
	// console command ran, so the modal always lands on what the engine
	// actually did. Main thread only.
	std::string SetLock(bool lock, int level);
}
