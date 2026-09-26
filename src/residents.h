#pragma once

#include <filesystem>
#include <functional>
#include <string>

// Residents — the My Home is Your Home NG MASTER LIST, and remote assignment.
//
// The third mode of the Domains tab (🗺 Places ‖ 🏰 Bases ‖ ⌂ Residents). Where
// the Followers tab's "Her Day" and the F7 card can only mark the PLAYER'S
// FEET for the people Follower Organizer knows about, this module reads
// MHiYH's OWN registry (every resident it holds, up to 1000, whether or not
// FO has ever heard of her) and can put any stop of her day on a Domains
// mark from anywhere in Skyrim.
//
// -------------------------------------------------------------- the door ---
// Everything goes through HD_MhiyhRemote.pex (modding/OutfitCycler/Scripts/
// Source/HD_MhiyhRemote.psc), a Global-only script that needs no ESP: the VM
// loads it from Data\Scripts on the first DispatchStaticCall. Its functions
// are MHiYHController's own transactions with the marker handed IN instead of
// created at the player — see the .psc header. The marker itself is placed
// HERE (PlaceObjectAtMe(XMarker, forcePersist) + SetParentCell/SetPosition,
// the same four calls place_actions.cpp aims the recall marker with), because
// Papyrus has no way to put a reference at bare coordinates in another cell.
// MHiYH's DLL serialises force-persistent markers and restores them as the
// package's Named Linked Reference on load (its own comment in
// CreateMarkerAtPlayer), so a marker we place is as durable as one it placed.
//
// ------------------------------------------------------------ the reads ----
// The roster is the ONE thing that must come from Papyrus: the registry lives
// inside MHiYH.dll's private database and is reachable only through its
// MMTYHNative natives (GetNextRegisteredSlot / GetActorBySlot). One VM call
// returns "formid|slot;" rows; every other fact — name, where she is, each
// stop's place and its cell + coordinates, what she is doing now — is read
// off the engine on the main thread through nff_bridge (linked refs + alias
// instances, zero Papyrus), exactly as the Followers tab reads it. Hours and
// radii are a second, on-demand VM call per resident (Day()), because they
// too live only in the DLL's database.
//
// ---------------------------------------------------------- threading ------
// MAIN THREAD ONLY for every entry point (they touch live actors, cells and
// the VM). The Papyrus calls are asynchronous; every result is hopped back to
// the main thread before `push` / `done` runs, so callers can PushToView from
// inside them.
namespace Residents
{
	using Push = std::function<void(const std::string&)>;

	// MHiYH.esl is in the load order and its keywords resolved.
	bool Available();

	// Ask MHiYH for its registry and push `rsStateResult` once, decorated:
	//
	//   { "present": true, "script": true, "n": 12,
	//     "residents": [ { "formId": "0x0001A6A1", "slot": 3, "name": "Lydia",
	//        "following": false, "dead": false, "inWorld": true,
	//        "where": "Breezehome", "whereId": 0x165A8, "waiting": false,
	//        "flagged": true,
	//        "home": { "name": "Breezehome", "cellId": …, "cellName": …, "x": …, "y": …,
	//                  "z": …, "interior": true, "worldspaceName": "" } | null,
	//        "acts": [ { "k": 1, "now": false, "place": "Breezehome", "cellId": …, … } ],
	//        "now": [ 0 ] } ] }
	//
	//   present:false  — MHiYH absent (nothing dispatched)
	//   script:false   — the VM would not take HD_MhiyhRemote.Roster (pex not
	//                    installed / no save loaded); `msg` says which
	//
	// `deckViewDir` receives residents-status.json (the same JSON) for the
	// Deck Portal, atomically. Pass an empty path to skip the export.
	void RequestState(const std::filesystem::path& deckViewDir, Push push);

	// Her hours: dispatch Day() and push `rsDayResult`
	//   { "ok": true, "formId": "…", "day": [ { "k": 0, "start": 0, "end": 24,
	//     "enabled": true, "radius": 1024 }, … 8 rows ] }
	// Returns the immediate envelope ({ok:false,msg} when nothing was sent).
	std::string RequestDay(const std::string& formIdHex, Push push);

	// One verb. `cmdJson`:
	//
	//   { "op":"setAt",    "formId":"0x…", "kind":0..6,
	//                      "mark": { "name", "cellId", "cellEdid", "x","y","z","angleZ" } }
	//   { "op":"setAt",    "formId":"0x…", "kind":0..6, "here": true }
	//   { "op":"hours",    "formId":"0x…", "kind":0..7, "start":0..23, "end":0..24,
	//                      "enabled":bool, "radius":64..4096 }
	//   { "op":"guard",    "formId":"0x…", "mode":0|1|2 }        0 off · 1 watch · 2 guard
	//   { "op":"sendHome", "formId":"0x…" }
	//   { "op":"refresh" }
	//   { "op":"forget",   "formId":"0x…" }                       -> MhiyhControl forgetHome
	//   { "op":"clear",    "formId":"0x…", "kind":1..6 }          -> MhiyhControl clearSpot
	//   { "op":"repair",   "formId":"0x…" }                       -> MhiyhControl repair
	//
	// Returns immediately, MhiyhControl's envelope shape:
	//   { ok:false, phase:"refused", msg }      nothing dispatched — a complete answer
	//   { ok:true,  phase:"sent", op, formId, kind, msg }
	// and later, on `done` (main thread):
	//   { ok:bool,  phase:"done", op, formId, kind, msg }
	std::string Apply(const std::string& cmdJson, Push done);
}
