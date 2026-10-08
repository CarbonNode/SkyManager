#pragma once
#include <string>

// CastAnim — the action bar's OPTIONAL casting animation (2026-10-08, Rober:
// "support for casting animations would be good too. supports if you have,
// doesnt require if you dont want it").
//
// The bar casts without equipping (hotbar_cast.h), so the vanilla graph never
// plays a cast: its magic states are only reachable with a spell in hand.
// Spell Hotbar 2 solved that without a behaviour patch, and this module rides
// its installation when it is there:
//   * SpellHotbar.esp carries three globals — SpellHotbar_SpellAnimationType
//     (0x815), SpellHotbar_CastingSource (0x835), SpellHotbar_isCastingConcSpell
//     (0x834), plus a cast timer (0x838);
//   * its Open Animation Replacer submods (meshes/actors/character/
//     OpenAnimationReplacer/SpellHotbar2/cast_*) replace the SHOUT clips with
//     casting clips whenever those globals say a cast is running;
//   * so a cast is: set the globals, NotifyAnimationGraph("ShoutStart"), and
//     the shout state plays a cast clip with the weapon still in hand. The
//     release is "MT_BreathExhaleShort" (the shout's own exhale event), a
//     cancel is "ShoutStop", and a channel re-sends ShoutStart every half
//     second to re-loop its clip — exactly what SpellHotbar2.dll does
//     (casts/casting_controller.cpp, read 2026-10-08; the OAR condition files
//     on the rig were read the same day and key on those three globals).
//
// Nothing here is REQUIRED: Probe() looks for the plugin, its globals and the
// OAR folder, and when any of them is missing every call below is a silent
// no-op and the cast goes off exactly as before (no animation). The editor
// shows the probe's verdict in words. The user's own switch is the hotbar
// config's `castAnim` ("auto" | "off").
//
// ⚠ The shout state's own clip carries the Voice_SpellFire_Event annotation
// that fires an equipped shout; Spell Hotbar 2's replacement clips do not.
// That is why this bridge engages ONLY when its OAR folder is present: a
// ShoutStart with no replacement clip would be a real shout.
//
// THREADING: everything is MAIN THREAD ONLY except GetStatus/Enabled/Busy.
// Tick() is driven by HotbarCast::Tick (the hotbar poll thread, via the task
// interface) — Busy() keeps that thread awake for the delayed global reset
// after a cast has ended.
namespace RE
{
	class MagicItem;
}

namespace CastAnim
{
	struct Status
	{
		bool        available = false;
		std::string source;   // "Spell Hotbar 2" when available
		std::string why;      // when not: the missing piece, in words
	};

	// Look for Spell Hotbar 2 (plugin + globals + OAR clips + OAR itself).
	// Cheap; safe to call again (a re-probe after a load). MAIN THREAD.
	void   Probe();
	bool   Probed();
	Status GetStatus();
	// {"available":bool,"source":"…","why":"…"} for the editor.
	std::string StatusJson();

	// The config switch (castAnim == "auto"). Off = every call is a no-op.
	void SetEnabled(bool on);
	bool Enabled();

	// Start the clip for this press. true = an animation was started and the
	// caller should Release()/End() it. `left` = the casting hand, `dual` =
	// both hands (the perk, or "both hands" without it), `conc` = a channel.
	bool Begin(RE::MagicItem* item, bool left, bool dual, bool conc);
	// Advance Spell Hotbar 2's cast timer, re-loop a channel, run the delayed
	// reset. MAIN THREAD.
	void Tick(float dt);
	// The spell leaves the hand now: play the release half (a channel flips
	// to its loop clip instead).
	void Release();
	// The cast is over. `cancelled` = it fizzled / the channel stopped: the
	// clip is cut with ShoutStop and the globals reset at once. Otherwise the
	// release clip is left to finish and the globals reset a second later.
	void End(bool cancelled);
	// The shout state is live right now (the graph's IsShouting).
	bool Playing();
	// A clip is running or a reset is pending — keep ticking.
	bool Busy();
}
