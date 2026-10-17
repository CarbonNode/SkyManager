#pragma once

#include <string>

// Spellbook — the full-screen personal spell catalog (view: hd-spellbook.js,
// opened from Home > UI Elements). Rober, 2026-10-14: "a personal catalog of
// spells, you create nice categories, then get a grid like list of any spell
// you have you can list in these categories, chevrons, draggable order, add or
// remove, auto cast, equip".
//
// This module owns ONE thing: the sidecar `spellbook-sheet.json` under
// Data/SKSE/Plugins/HotkeyDeck/ (not `spellbook.json` — that is the Spell
// Deck's portal export). The VIEW owns its schema (categories, order,
// per-spell click action, sizes) — C++ checks only that it is a JSON object of
// sane size, so a newer view can add keys an older DLL never flattens.
// Casting and equipping are NOT here: main.cpp routes them through the
// play-proven SpellActions::Cast / EquipToggle, exactly like the Spell Deck.
namespace Spellbook
{
	// The open payload, built on the MAIN thread (it reads the spellbook and
	// the equip slots): {known:[…KnownSpellsJson rows + cost], equip:{…},
	// doc:<sidecar object>|null, msg}. Each known row gains `cost` (magicka,
	// rounded) where the engine can answer, absent where it cannot.
	std::string StateJson();

	// Persist the view's document. Validated here, written on a worker
	// (coalesced: a burst of saves writes the last one once), atomically via a
	// temp file + rename. Returns {"ok":bool,"msg":"…"} at once.
	std::string Save(const std::string& docJson);
}
