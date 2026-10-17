#pragma once

#include "mod_keys.h"

#include <string>
#include <unordered_map>

// ---------------------------------------------------------------------------
// INTERACTIONS — the F7 card's "Interact" popout (Rober, 2026-10-14: "new
// interactions popout ... add to f7 on npc, hook to mod piggy back rides (hide
// power), hiding on same horse mod", then "search through other mods for more
// injections ... a tab / category system").
//
// The deck implements NO mechanic here. Every tile drives a mod the player
// already runs, through that mod's own door. Two kinds of door:
//
//   1. A POWER AIMED AT SOMEONE (the common shape, found by surveying every
//      enabled plugin's SPEL records for scripted powers / lesser powers with
//      Target Actor delivery, 2026-10-14). The tile casts the mod's own spell
//      from the player at the card's subject — exactly the cast the player
//      makes by hand — and the mod's effect script does the rest. The rows are
//      the kDoors table in interact_actions.cpp: plugin + local id (read with
//      tools/dump_records.py / the survey, never guessed), resolved through
//      TESDataHandler::LookupForm so ESL and full plugins both work and an
//      override (Hunterborn Extender's Taxonomy) wins as it does in game.
//      Carry Me (Nexus 194011) is one of these with a twist: its effect script
//      picks the carry STYLE from two facts read in OnEffectStart —
//      akTarget.GetHeadingAngle(player) inside +-90 (player in front) and
//      akCaster.IsWeaponDrawn() — so a style tile sets those (weapon state,
//      carrier heading) and then casts.
//
//   2. A MOD HOTKEY. Ride Along (Nexus 194579, RideAlong.dll) has no API and
//      no Papyrus; its only door is RideAlong.ini [General] Hotkey, which seats
//      the NEAREST follower behind a mounted player and lets them off again.
//      That is the case mod_keys.h allows (a key the mod ships for this, read
//      live at press time). The mod picks the rider, so the deck refuses up
//      front when the card's subject is not the one it would pick.
//
//   HIDE POWER: a mod that hands the player its power (Carry Me's PBR_Init,
//   Kiss Any Woman's OnInit ...) clutters the Magic menu once the tile exists.
//   Sidecar interact.json "hide" { "<mod id>": bool } — Carry Me defaults ON
//   (Rober asked), the rest OFF — takes those powers off the player after a
//   load and whenever the popout opens. Casting never needs the player to know
//   the spell. Hunterborn's hotkey spells are never hidden: they are what its
//   own favourites-hotkeys cast.
//
// THREADING: everything here is MAIN THREAD (engine reads and writes). The
// sidecar is one tiny file, loaded once and cached. A cast runs over a few
// frames (wait for unpause, Carry Me's weapon, then cast) on SKSE tasks;
// Papyrus does the rest unpaused, so the caller closes the palette FIRST and
// never reopens it.
// ---------------------------------------------------------------------------
namespace InteractActions
{
	// The hdInteract bridge ops: "state", "cast", "ride", "power".
	// Every reply carries { ok, op, msg, ... }; "state" is the popout's model:
	//   { ok:true, op:"state", name, formId, subject:{person,creature,horse,dead},
	//     doors:[{ id, mod, installed, ready, why }],
	//     mods: [{ id, name, hideable, hidden, known }],
	//     carried, ride:{ installed, mounted, ready, why } }
	std::string State(const std::string& reqJson,
		const std::unordered_map<std::string, std::string>& keyWhy = {});

	// For each MCM-Helper key door whose key cannot be pressed (unbound, file
	// missing), the sentence why — keyed by door id. WORKER thread (file IO);
	// main.cpp runs it before State and hands the map in.
	std::unordered_map<std::string, std::string> KeyProblems();

	// { op:"cast", door, formId, plugin?, style? } — style only for door "carry"
	// ("auto|piggyback|bridal|front|shoulder"). Starts the cast and returns the
	// "sent" envelope (or a refusal). The palette must already be closed. The
	// steps after "sent" say their own outcome on the HUD — the card is gone.
	std::string Cast(const std::string& reqJson);

	// { op:"ride", formId, plugin? } — the checks only. ok:true means the caller
	// presses RideAlongSpec()'s key (main.cpp, PressModKeyWhenUnpaused).
	std::string RideCheck(const std::string& reqJson);
	ModKeys::Spec RideAlongSpec();

	// A key door (OBody, Follower Stats, Kick Them All, Jaxonz Renamer): the
	// "cast" reply carries { press:{ glob } }; main.cpp calls this on a WORKER
	// (the MCM Helper ini is file IO) and presses the result when unpaused.
	// `spec` is filled for the press log.
	ModKeys::Press KeyPress(const std::string& door, long globValue, ModKeys::Spec& spec);

	// { op:"power", mod, hide:true|false } — saves the setting and applies it.
	std::string Power(const std::string& reqJson);

	// After a save loads / a new game starts: apply the hide settings.
	void OnGameLoaded();
}
