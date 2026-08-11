#pragma once

#include <string>

// Read-only bridge to two follower mods the deck does not own:
//
//   * Nether's Follower Framework 2.8.6.0b (nwsFollowerFramework.esp) — the
//     "home base" a follower is assigned to, and whether NFF has an outfit
//     stored for them.
//   * My Home is Your Home SKSE NG (MHiYH.esl) — the house a follower was told
//     to live in, plus the place for each of its eight daily ACTIVITIES and
//     which of them NG has in force right now.
//
// Both are read through the ENGINE, never through Papyrus *calls*:
//
//   * NFF's data lives in properties on its quest scripts. We bind the quest
//     object in the VM (FindBoundObject) and read the property variables
//     synchronously (Object::GetProperty). No Papyrus function is invoked —
//     this rig has a documented CTD bucket inside the native-call path, and a
//     read has no business going anywhere near it. Home index is then just
//     `actor->GetFactionRank(nwsFF_HomeFac)`, exactly what NFF's own
//     nwsFollowerHomeScript writes with SetFactionRank.
//   * MHiYH NG stores each activity's marker as a LINKED REF on the actor,
//     keyed by its own keyword (0x801 home · 0x802 sleep · 0x803 work · 0x804
//     guard, shared by active AND passive · 0x812/3/4 breakfast/lunch/dinner),
//     so each place is a single `actor->GetLinkedRef(kw)`.
//   * "Doing now" is read from the actor's ExtraAliasInstanceArray. NG keeps one
//     quest per activity and fills a resident alias in it while that activity is
//     the one in force, having ALREADY recomputed that from its own schedule
//     database and the game clock. So the filled alias is the mod's own answer,
//     wrapped-past-midnight and all — we read its conclusion instead of
//     re-deriving it, and cannot disagree with the packages the NPC is running.
//
// NOT read: the schedule HOURS (start/end/radius). They live only inside
// MHiYH.dll's own C++ database and are reachable solely through its
// `MMTYHNative` Papyrus **natives** — the one call shape this file exists to
// avoid. See the header comment in nff_bridge.cpp's kKindQuest table and the
// README for why "doing now" makes them largely redundant anyway.
//
// SOFT DEPENDENCY, always. Either mod may be absent, may be present with the
// properties unfilled, or may not have run yet on a fresh save. Every path here
// degrades to "no data" and logs once — the Followers roster must render
// identically whether or not these mods exist. Same posture as
// FollowerDeck::Available().
//
// NOTHING here writes. No outfit change, no home change, no Set*/Restore. SOES-NG
// on this rig blocks external equips on tracked actors and a write path here has
// already been shown to cause a CTD loop (modding/troubleshooting/soes_ng_crash_issue.md).
// Telling MHiYH to CHANGE a home is a separate file — src/mhiyh_control.cpp —
// and it does it by calling the mod's own dialogue entry points, never by
// writing the linked ref this one reads.
//
// MAIN THREAD ONLY — these touch live game state, like every other RE:: path in
// this plugin. Schedule via SKSE::GetTaskInterface()->AddTask.

namespace RE
{
	class BGSKeyword;
}

namespace NffBridge
{
	// MHiYH NG's linked-ref keyword for one activity kind (0 home · 1 sleep ·
	// 2 work · 3 guard · 4/5/6 breakfast/lunch/dinner · 7 passive watch, which
	// deliberately SHARES the guard keyword). nullptr when the kind is out of
	// range or MHiYH.esl is not in this load order.
	//
	// Exposed so the write side (src/mhiyh_control.cpp) decides "does she
	// already have a home" off exactly the table this file names places with —
	// one table, so read and write can never disagree about who has one.
	RE::BGSKeyword* MhiyhMarkerKeyword(int kind);

	// True when NFF's home-base script object could be bound this session.
	// False = the mod is absent, or no save is loaded yet.
	bool Available();

	// Where "home" actually IS, as a reference you can move somebody to.
	//
	// StateJson() reports both homes as NAMES, which is all a roster row needs
	// and useless for the Followers tab's "send her home" — so this is the
	// same lookup, stopping at the reference:
	//
	//   which == "mhiyh"  the actor's linked ref on MHiYH's home keyword —
	//                     the marker its own dialogue sets, so we send her
	//                     exactly where the mod believes she lives.
	//   which == "nff"    NFF's base marker for the home INDEX she is filed
	//                     under (its home factions encode the slot).
	//
	// nullptr for: unknown `which`, the mod absent, no save loaded, or simply
	// no home set — the caller cannot tell those apart and does not need to,
	// because the view only offers the button when StateJson already showed a
	// home name for that follower.
	RE::TESObjectREFR* HomeRefFor(RE::Actor* actor, const std::string& which);

	// NFF's own "allow sandboxing" switch (the nwsAllowSandbox global its MCM
	// writes). 0 off · 1 on · 2-3 on plus auto-boxing indoors/in towns.
	// SandboxLevel() returns -1 when NFF is absent or no save is loaded, which
	// the view renders as "no toggle" rather than as "off".
	//
	// Not the same question as the party orders in nff_control: those say
	// "relax NOW", this says "may they relax at all".
	int  SandboxLevel();
	bool SetSandboxLevel(int level);

	// Whether THIS follower is included in sandboxing — NFF's own per-follower
	// MCM checkbox, stored as her rank in nwsFF_BoxFaction (rank 0 excludes;
	// not in the faction at all is the default-allowed state). Returns NFF's
	// own default (true) when the mod is absent, because that is what the game
	// behaves as, not because we know.
	//
	// Three different sandbox questions, do not conflate them:
	//   SandboxLevel()        may ANYONE relax          (global setting)
	//   allRelax / allUnrelax relax NOW                 (party order)
	//   SandboxAllowedFor()   is SHE included           (this one)
	bool SandboxAllowedFor(RE::Actor* actor);
	bool SetSandboxAllowedFor(RE::Actor* actor, bool allow);

	// Set (index >= 0) or clear (index < 0) a follower's NFF home base. The
	// index is the one published in StateJson's "bases" array, which is the
	// faction rank NFF itself stores — see SetBase's note.
	bool SetBase(RE::Actor* actor, int index, std::string& err);

	// True when MHiYH.esl is in the load order and its link keyword resolved.
	bool MhiyhAvailable();

	// Per-follower NFF + MHiYH facts for exactly the members in `foStateJson`
	// (a Follower Organizer Deck API envelope — we reuse its formIds rather
	// than trying to enumerate "followers" ourselves).
	//
	//   {
	//     "ok": true,
	//     "nff": true, "mhiyh": true,          // availability, for the UI
	//     "members": {
	//       "0x0001A6A1": {
	//         "nff":   { "managed": true,
	//                    "home": { "i": 3, "name": "Riverwood" } | null,
	//                    "outfit": { "has": true } },
	//         "mhiyh": { "home": { "name": "Breezehome" } | null,
	//                    "flagged": true,
	//                    // one per CONFIGURED activity (and any in force even
	//                    // without a readable marker); "k" is MMTYHNative's own
	//                    // kind number, which the view's ACTS spec keys off.
	//                    "acts": [ { "k": 1, "place": "Breezehome", "now": true },
	//                              { "k": 2, "place": "Warmaiden's", "now": false } ],
	//                    "now":  [ 1 ] }      // kinds in force this moment
	//       }
	//     }
	//   }
	//
	// Members with nothing to say are omitted entirely, so the payload stays
	// small on a ~70-member roster.
	std::string StateJson(const std::string& foStateJson);

	// Convenience overload: pulls the FO state itself. Costs an extra FO state
	// build, so prefer passing the envelope you already have.
	std::string StateJson();
}
