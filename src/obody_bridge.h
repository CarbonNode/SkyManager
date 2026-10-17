#pragma once

#include <functional>
#include <string>

// OBody NG body preset on the F7 card's Equipped box (Rober, 2026-10-15: "show
// the name of the obody body they are using if they are 3ba or UBE, and a
// button to change it opens obody picker").
//
// ------------------------------------------------------------------ why ----
// OBody NG (>= 4.3.7; the rig runs 4.4.3) keeps each actor's preset in its own
// SKSE cosave and publishes it through Papyrus natives on `OBodyNative`:
//   GetPresetAssignedToActor(actor)            -> String ("" = none yet)
//   GetAllPossiblePresets(actor)               -> String[] (the female or male
//                                                 set, exactly what its own
//                                                 menu lists for her)
//   AssignPresetToActor(actor, name, true, false) -> Bool (no random fallback,
//                                                 morphs applied at once)
// So the deck reads and writes through those three, the same entry points
// OBody's own preset menu (OBodyNGScript.ShowPresetMenu) uses, and links
// nothing of OBody's DLL. When OBody is not installed the dispatch is refused
// and the card says so.
//
// The BODY (3BA / UBE / male) is not something OBody reports. UBE characters
// wear UBE's own races (UBE_AllRace.esp: 00UBE_NordRace, 00UBE_NordRaceVampire,
// … 00UBE_CustomRace01/02 — EditorIDs read from the plugin 2026-10-15); every
// other woman on this load order wears CBBE 3BA. So: UBE race -> "UBE",
// female -> "3BA", male -> "Male".
//
// -------------------------------------------------------------- threading ---
// MAIN THREAD ONLY (resolves a live actor + dispatches Papyrus). `reply` fires
// later, already hopped back to the main thread, with one JSON envelope:
//   { op, ok, formId, name, body:{kind,label,race}, preset?, presets?, msg?,
//     missing? (OBody not loaded), applies? (false = not a person) }
namespace ObodyBridge
{
	using Reply = std::function<void(const std::string&)>;

	// reqJson: { op: "get" | "list" | "set", formId (number or hex string;
	// none = the crosshair NPC), preset (for "set") }
	void Handle(const std::string& reqJson, Reply reply);
}
