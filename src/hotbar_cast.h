#pragma once
#include <cstdint>
#include <functional>
#include <optional>
#include <string>

// HotbarCast — the action bar's REAL casting engine (2026-10-04, Rober:
// "improve our skymanager spellbar?" pointing at github.com/W1terr/SpellHotbarNG).
//
// Until this date a hand spell on the bar went through SpellActions::Cast,
// which is the Spell Deck's instant verb: CastSpellImmediate on the kInstant
// caster, aimed at the crosshair actor SNAPSHOTTED WHEN THE PALETTE LAST
// OPENED. On a bar used in live combat that meant three things nobody would
// accept from an action bar: every spell was FREE (CastSpellImmediate charges
// no magicka), it went off with no charge time at all, and an aimed spell
// flew at whoever you had looked at minutes ago in the deck — or straight
// ahead along your heading, not your crosshair. Concentration spells fired a
// single tick.
//
// This module casts the way Spell Hotbar NG does (GPL-3; its Actions.cpp and
// PlayerControl.cpp were read 2026-10-04 and are the model for the cast
// loop, the cost rules and the crosshair aim — credit in
// THIRD-PARTY-NOTICES.md). Per press:
//   * cost: CalculateMagickaCost for the player (perks included, through the
//     guarded SpellCost::Read), x fMagicDualCastingCostMult for a dual cast,
//     x2 for "both hands" without the perk. Not enough = the vanilla refusal
//     (magicka meter flash + MAGFailSD), nothing cast, nothing spent.
//   * charge: the spell's own charge time, with its own charge sound; the
//     button shows the wind-up. Released when the charge completes.
//   * concentration: channels while the slot key is HELD (drained per second
//     through the hand caster's currentSpellCost, exactly like a vanilla
//     channel), stops on release, on empty magicka, or on pressing the slot
//     again. A press that has no key to hold (a click, a flyout pick) toggles.
//     Pressing a DIFFERENT spell's button ends the channel and casts that.
//   * aim: aimed and target-location spells go to the CROSSHAIR at the moment
//     of release (a ray from the camera that stops on the first thing it
//     hits, actors included), from the casting hand. Self spells on self.
//   * scrolls bound as items are read and consumed the same way, at no cost.
//   * the vanilla blockers: no casting midair, swimming, mid-attack or in a
//     beast form; a press while drawing/sheathing or while the last cast is
//     still recovering WAITS (up to 3 s) instead of being dropped.
//
// Nothing in the hands changes — the hand casters fire without the spell
// being equipped. What this phase does NOT do yet is the casting ANIMATION:
// Spell Hotbar NG plays one through the shout behaviour + an Open Animation
// Replacer condition and generated clips. That is the next phase, tracked in
// the feature-history entry.
//
// Powers and shouts are NOT handled here: they already run through the
// game's own Shout key (SpellActions::Cast's voice road — real cooldown,
// real animation). `castMode == "instant"` in the hotbar config keeps the old
// free instant behaviour for anyone who wants it.
//
// THREADING: everything except Active() is MAIN THREAD ONLY. Tick() is driven
// by the hotbar poll thread (main.cpp) through the task interface while
// Active() is true.
namespace RE
{
	class MagicItem;
	class ScrollItem;
	class SpellItem;
}

namespace HotbarCast
{
	struct Request
	{
		RE::MagicItem*  item   = nullptr;   // the spell, or the scroll itself
		RE::ScrollItem* scroll = nullptr;   // set when `item` is a carried scroll
		std::string     hand;               // "" | "right" | "left" | "both"
		int             page = 0;
		int             slot = -1;          // bar button index (0-based)
		// Is the key that pressed this still down? null = there is no key to
		// hold (clicked, or picked from a flyout fan): a concentration spell
		// then toggles instead of channelling for as long as the key is held.
		std::function<bool()> held;
		bool aimCrosshair = true;
	};

	enum class Result
	{
		kStarted,   // charging, channelling, or already released
		kQueued,    // the bar is busy; it goes off when free (≤ 3 s)
		kStopped,   // the press stopped this slot's running channel
		kRefused,   // nothing happened; `msg` says why (feedback already given)
	};

	// Begin a cast for this press. MAIN THREAD ONLY.
	Result Start(Request req, std::string& msg);

	// Advance charge / channel / queue by the real time since the last call.
	// Skips (and does not accrue time) while the game is paused. MAIN THREAD.
	void Tick();

	// Atomic: a cast is charging or channelling, or a press is queued. The
	// poll thread drives Tick() only while this is true.
	bool Active();

	// A save just loaded / the player died: drop everything silently.
	void Reset();

	// What a press of this hand spell would cost right now (perks, dual cast
	// and both-hands included). nullopt for non-hand spells or when the cost
	// cannot be read safely. Concentration spells answer their PER-SECOND
	// cost. MAIN THREAD ONLY.
	std::optional<float> PressCost(RE::SpellItem* spell, const std::string& hand);

	// Where the view hears about wind-ups and channels: main.cpp installs a
	// sink that invokes hbCast(<json>) on the bar's view. Payloads:
	//   {"page":p,"i":i,"phase":"charge","dur":seconds}
	//   {"page":p,"i":i,"phase":"channel"}
	//   {"page":p,"i":i,"phase":"end"}
	void SetViewSink(std::function<void(const std::string&)> sink);
}
