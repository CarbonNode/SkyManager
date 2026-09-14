#pragma once

#include <string>

// Ward Anytime, the SkyManager way (Rober, 2026-09-01: "a new hotkey + widget
// that shows if ward spell is currently on or off … a hotkey to instant cast
// your best ward", pointing at github.com/HaidarYusuf-001/WardAnytime).
//
// One bindable action — "ward-toggle" — raises your STRONGEST known ward and
// keeps it up from any stance (weapons, bow, shield, fists, sheathed): the
// upstream mod's proven mechanism, re-cast through the kInstant magic caster
// on a short main-thread beat while magicka drains at the spell's own
// per-second cost. Press again to lower it. The HUD "ward" widget
// (widgets.cpp / hud.js) reads the SAME state plus the engine's WardPower
// actor value, so it also lights up for a ward you cast by hand.
//
// Mechanism notes, carried over from WardAnytime's source (MIT-sized, 169
// lines — read 2026-09-01):
//   * cost is CalculateMagickaCost(player) x elapsed seconds, deducted via
//     RestoreActorValue(kDamage, kMagicka, -cost) — concentration spells
//     price themselves per second, so this is the vanilla drain;
//   * the ward VFX+effect persist a short while after an instant cast, so a
//     ~0.6 s re-cast keeps the shield solid without fighting attack/sprint
//     animations (upstream's RecastInterval default);
//   * lowering the ward DISPELS our own active effect explicitly — letting it
//     time out leaves a ~2 s ghost shield after the "off" notification.
//
// Where it differs on purpose: no hardcoded FormID list. Best ward = the
// highest-magnitude known spell whose effect feeds the WardPower actor value
// (data.primaryAV == kWardPower) — which is every vanilla ward, Mysticism's,
// and any modded ward that actually wards. No INI either: the key is a deck
// binding like everything else.
//
// THREADING: Toggle/Tick/Reset/BestKnownWard touch the player actor — MAIN
// THREAD ONLY (main.cpp AddTasks them). Enabled()/Maintained() are atomic
// snapshots, safe from the ticker's worker thread.
namespace WardActions
{
	// Flip the maintained ward. Enabling with no ward spell known is an
	// honest on-screen refusal, not a silent arm. Says what it did
	// ("Greater Ward raised" / "Ward lowered"). MAIN THREAD ONLY.
	void Toggle();

	// Atomic: the maintained ward is armed. Readable from any thread — the
	// hotbar ticker gates its ward beat on this.
	bool Enabled();

	// One maintenance pass: drain magicka for the real elapsed time, re-cast
	// when the recast interval is due, auto-lower with a notification when
	// magicka runs dry or the player dies. Skips (without draining) while the
	// game is paused. MAIN THREAD ONLY.
	void Tick();

	// A save just loaded: the armed flag describes the OUTGOING session and
	// the cached spell pointer another load order. Drops both silently — a
	// maintained drain must never survive into a save that never asked for
	// it. MAIN THREAD ONLY.
	void Reset();

	// The strongest ward the actor actually KNOWS (base spell list + learned),
	// ranked by the ward effect's magnitude. nullptr when none. MAIN THREAD
	// ONLY. Shared with widgets.cpp so the widget and the toggle can never
	// disagree about which ward "best" means.
	RE::SpellItem* BestKnownWard(RE::Actor* actor);
}
