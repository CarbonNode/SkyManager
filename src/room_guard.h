#pragma once

#include <cstdint>
#include <string>
#include <vector>

// Room Guard backend for the Hotkey Deck "Rooms" tab.
//
// The peeve: you rent a room at an inn and the patrons treat it as more inn.
// They path in, sit on your chair, sleep in your bed and stand in the doorway.
// Nothing is scripted about it — inn NPCs run a SANDBOX package over the whole
// interior, which scans for furniture and idle markers in radius and picks one.
// Your rented room's furniture is a perfectly valid target and nothing marks the
// room as yours to the AI.
//
// There is no engine API for "actors may not enter here", so this is a claimed
// VOLUME plus a watchdog:
//
//   1. CLAIM   — a cylinder (radius + half-height) keyed by the parent CELL.
//                RENTED inn rooms claim THEMSELVES: an inn cell (LocTypeInn)
//                holding a player-owned bed is the rental system's own
//                fingerprint, so the watchdog claims around that bed
//                unprompted (Config::autoClaim). Everything else — tents,
//                mod rooms without the keyword, private bedrooms at home —
//                is a manual claim from wherever you stand.
//   2. EVICT   — anyone inside the volume who isn't allowed gets taken out of
//                furniture and moved to the room's anchor. Actors you can see
//                get a grace window to walk out on their own first, so the
//                usual case is that they leave off-screen and you never witness
//                a teleport.
//   3. REPEL   — default ON: claim OWNERSHIP of the room's furniture, exactly
//                what the vanilla rental script does to the bed. Sandbox skips
//                furniture owned by someone else, so the chair stops being a
//                valid target and they stop coming — the root cause, where the
//                eviction is only the symptom.
//
// kind == "home" is the answer to "don't do this in my houses": a home room is
// REMEMBERED as a place but is never guarded, so a house you've marked can never
// start evicting your household — even if you claim inside it by accident.
//
// Ownership: the VIEW owns rooms/ignore/settings (sent whole via rgSave ->
// MergeViewSlice); C++ owns the claim snapshot, the eviction and the ownership
// bookkeeping (Room::owned).
// Mirrors finance / place_actions. See src/room-guard-wiring.md.
namespace RoomGuard
{
	// A durable reference to an NPC's BASE form. A raw FormID is brittle across a
	// load-order change, so identity is (plugin, local id) resolved through
	// TESDataHandler::LookupForm — the same scheme the Spell Deck and nff_control
	// use, and ESL-safe because ActorIdentity::LocalIdOf applies the source file's
	// own mask (and, unlike RE::TESForm::GetLocalFormID, survives a form that has
	// no source file at all — see actor_identity.h).
	// The base form is the right key: it makes "ignore Lydia" mean the person, not
	// one particular reference to her.
	struct NpcRef
	{
		std::string   plugin;
		std::uint32_t localId = 0;
		std::string   name;  // display only, for the pane

		bool valid() const { return !plugin.empty() && localId != 0; }
	};

	struct Room
	{
		std::string id, name, note;

		// "inn"     — guarded: strangers inside get evicted.
		// "private" — guarded, identically to "inn": a bedroom claimed INSIDE a
		//             shared cell (castle mods, player homes where the bedroom
		//             shares the cell with the hall). Separate kind because the
		//             pane treats it differently socially: its occupants are
		//             your own household, so the per-room ALLOW list is the
		//             main control, not the eviction.
		// "home"    — never guarded. Remembered so the place is on the list and
		//             so an accidental claim here stays inert.
		std::string kind = "inn";

		// The parent cell is the durable identity (FormID + editor-id fallback),
		// exactly as Domains does it — cells are addressed through the form table.
		std::uint32_t cellId = 0;
		std::string   cellEdid, cellName;

		// Claimed volume: a cylinder by default — or, because real rooms are
		// rarely round, a rotated BOX ("rooms aren't always a perfect circle",
		// Rober, play-test 2026-08-03). The box's axes come from the direction
		// the player FACED when claiming (stand facing the bed wall and the
		// rectangle sits square to the room); yaw is that heading in radians.
		// Vertical stays a simple half-height either way — a sphere big enough
		// for a room's corners would leak through the floor.
		std::string shape = "circle";  // "circle" (radius) | "box" (halfX/halfY + yaw)
		float x = 0.0f, y = 0.0f, z = 0.0f;
		// Game units: 1u ~= 1.43 cm. These defaults are deliberately SMALL —
		// 200u is a ~5.7 m circle and 130u is a ~3.7 m storey, i.e. about one
		// room. The first version shipped 320/180 (a 9 m circle over 5 m tall),
		// which is roughly double a rented inn room: it reached through the wall
		// into the corridor and down through the floor into the common room, so
		// it would have grabbed people walking past the door. Under-covering is
		// the safe error — the volume is tunable per room against the live
		// occupant list, and a missed corner is a nuisance where a false grab is
		// a bug you watch happen.
		float radius = 200.0f;  // circle: horizontal, game units
		float halfX = 200.0f;   // box: half-width  (to the claimer's right)
		float halfY = 260.0f;   // box: half-depth  (along the claimer's facing)
		float yaw = 0.0f;       // box: rotation, radians (player heading at claim)
		float height = 130.0f;  // half-extent above AND below the centre

		bool enabled = true;

		// PRIVACY LOCKDOWN (Rober, 2026-08-11): "don't let anyone in this room at
		// all right now" — a quick privacy override, not a new set of rules. While
		// it is on, the follower exemption and this room's own allow list are both
		// ignored and everyone inside is shown out; turn it off and the room goes
		// straight back to the people it normally welcomes, because nothing else
		// was edited to get here. It overrides `enabled` AND kind == "home" on
		// purpose: a privacy button that silently does nothing in the one place
		// you most want privacy — your own bedroom — is worse than no button.
		// What it does NOT override: the safety exemptions (mid-dialogue, combat,
		// kill move) and the GLOBAL never-move list, which are promises made
		// elsewhere and must not be broken by a convenience toggle. A home room
		// under lockdown still takes no furniture ownership (see repel), so
		// sealing your bedroom can never re-own your own house's chairs.
		bool lockdown = false;

		// Push FOLLOWERS out of this room too (default OFF — teammates walk in
		// freely, Rober's global default). When set, a teammate is no longer
		// exempt HERE: she is parked (see below) and moved to the anchor like any
		// stranger. Per-room so "keep followers out of my bedroom" doesn't mean
		// "keep them out everywhere". Gated behind the global Config::allowFollowers
		// only in the sense that turning the global OFF already evicts them
		// everywhere; this turns them out for THIS room while they roam elsewhere.
		bool evictFollowers = false;

		// Guard the ENTIRE parent cell, not just the claimed volume. "Mark a cell
		// as private": anyone unwelcome ANYWHERE in the cell is a target, no
		// radius/box test. The cell is still the durable identity, so nothing else
		// changes — the volume fields are simply ignored for the occupancy test
		// (and furniture ownership/repel is skipped, since owning every chair in a
		// whole cell is heavy and the point here is eviction, not decoy-removal).
		bool wholeCell = false;

		// Where evictees are put. Strongly recommended: stand outside the door and
		// set it. With no anchor the fallback pushes each actor radially out past
		// the volume edge, which keeps them in the same cell but can land them in
		// geometry — so the pane nags for one.
		bool  hasAnchor = false;
		float ax = 0.0f, ay = 0.0f, az = 0.0f, aangle = 0.0f;

		// REPEL (default ON): claim OWNERSHIP of the furniture and idle markers
		// inside the volume, the way the vanilla rental script claims the bed —
		// sandbox skips targets owned by someone else, so this removes the REASON
		// to walk in rather than bouncing people after they arrive. Unlike the
		// earlier BlockActivation approach it never locks the player out of
		// anything, so beds are included. Ownership persists in the save, so
		// every claimed ref is recorded WITH its original owner and restored on
		// release/disable/delete/load — a rented bed the rental script already
		// gave you is skipped entirely, so releasing a room can never take your
		// own bed away.
		bool repel = true;

		// C++-owned bookkeeping (never sent by the view): refs whose ownership
		// this room claimed, with the original owner to restore. owner == 0
		// means "was unowned".
		struct OwnedRef
		{
			std::uint32_t ref = 0;
			std::uint32_t owner = 0;
		};
		std::vector<OwnedRef> owned;

		// C++-owned bookkeeping for followers this room PARKED (see evictFollowers).
		// Pure eviction of a follower is a bouncer loop: her follow package warps
		// her back to you on the next cell attach. So before moving her out we send
		// her follower framework's OWN "wait here" (FollowerFrameworks::SendWait) so
		// she stops following — then she stays where we drop her. This records who
		// we parked and the framework spec index to RESUME with when you leave the
		// cell, so a release really re-follows and we never resume someone who was
		// waiting deliberately. Durable identity (plugin+localId) is kept alongside
		// the runtime ref so the mapping survives a save/load. spec < 0 means the
		// framework was unknown/unparkable — recorded so the pane can say so, but
		// nothing to resume.
		struct ParkedRef
		{
			std::uint32_t ref = 0;      // runtime FormID of the parked follower
			std::string   plugin;       // durable base identity, for cross-load resume
			std::uint32_t localId = 0;
			int           spec = -1;    // FollowerFrameworks spec index, or -1
			std::string   name;         // display only
		};
		std::vector<ParkedRef> parked;

		std::vector<NpcRef> allow;  // per-room extra welcome list

		// Per-room BLACKLIST (Rober, 2026-08-09): this person is shown out of THIS
		// room even when something else would welcome them — a ban beats the
		// follower exemption and beats a stale allow entry. The global ignore
		// list still wins ("never moved, anywhere" is an explicit promise), and
		// the safety exemptions (mid-dialogue, combat, kill move) always hold.
		std::vector<NpcRef> deny;
	};

	struct Config
	{
		std::vector<Room>   rooms;
		std::vector<NpcRef> ignore;  // global "never move this person, anywhere"

		bool enabled = true;         // master switch
		bool allowFollowers = true;  // teammates walk in freely (Rober's default)
		bool notify = true;          // corner message on each eviction

		// Rent a room, it guards itself: when the watchdog sees the player in an
		// inn cell (LocTypeInn) containing a player-owned bed and no claim, it
		// claims around the bed unprompted. autoClaimed remembers every cell it
		// has done this to — ONCE per inn, ever — so deleting an auto-claim is
		// respected instead of re-fought on the next tick.
		// Default OFF for a public build (2026-08-11). Auto-claiming rewrites
		// the OWNERSHIP of an inn's furniture the moment the player rents a
		// room, before they have asked for anything or seen the Rooms tab —
		// and while release/disable/delete/load all restore the original
		// owners, an UNINSTALL cannot, because an SKSE plugin never unloads.
		// A feature that silently changes persistent world state has to be a
		// thing the player turns on, not a thing they discover. The toggle is
		// in the Rooms tab; claiming by hand is unaffected.
		bool                       autoClaim = false;
		std::vector<std::uint32_t> autoClaimed;  // C++-owned, like Room::owned

		// Boundary-ring visualizer: the FIRST of these editor ids that resolves
		// becomes the glow object the ring is built from. In hotkeys.json so a
		// wrong/invisible pick is fixable by editing the list — no rebuild.
		// Resolution relies on runtime editor-id lookup (po3 Tweaks caches ids
		// for all form types on this load order); no candidate resolving is an
		// honest log line and the visualizer sits out.
		std::vector<std::string> ringEdids;
		float                    ringBaseRadius = 60.0f;  // glow mesh half-width, for SetScale sizing

		std::uint32_t graceMs = 4000;  // seen-you window before a visible actor is moved
		std::uint32_t tickMs = 1500;   // watchdog cadence
	};

	void Init();

	// Persisted slice. ToJson returns a json OBJECT for WriteConfigFile to drop
	// under "rooms"; FromJson is what LoadConfig reads back.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Apply a VIEW rgSave payload (rooms/ignore/settings). Room::owned is C++-owned
	// and preserved across a merge. Returns false on an unparseable payload.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg);

	// Payloads pushed to the view.
	std::string OpenJson(const Config& c);   // rgOpen(cfg + live context)
	std::string StateJson(const Config& c);  // rgState({room, occupants, …})

	// Candidate NPCs for the pane's searchable pickers (ban / never-move):
	// every LOADED actor near the player, plus any runtime formIds the view
	// hands over in reqJson {"extra":[{"formId":N,"name":"…"},…]} (the Follower
	// Organizer roster — persistent refs that resolve even when not loaded).
	// Each row carries the durable base identity (plugin + localId) AND the
	// runtime refId, so the F7 card can match its crosshair snapshot (which
	// only knows the runtime id) to a durable ref. Read-only.
	std::string NpcsJson(const Config& c, const std::string& reqJson);

	// ---- operations (MAIN THREAD ONLY) ----

	// Claim the room you are standing in. reqJson may carry {name, kind, radius,
	// height}. Replies {ok,msg,room}. Appends at the front (newest first).
	std::string ClaimHere(Config& cfg, const std::string& reqJson);

	// Set a room's eviction anchor to where the player is standing.
	std::string SetAnchorHere(Config& cfg, const std::string& roomId);

	// Evict everyone evictable from a room RIGHT NOW, ignoring the grace window.
	// roomId empty = the room the player is currently standing in.
	std::string EvictNow(Config& cfg, const std::string& roomId);

	// Add / remove the crosshair NPC on the global ignore list (toggles).
	std::string ToggleIgnoreCrosshair(Config& cfg);

	// Flip a room's PRIVACY LOCKDOWN (Room::lockdown). roomId empty = the room
	// you are standing in — which is what the bindable "Privacy" action uses, so
	// it works with no UI at all. Turning it ON clears the room immediately when
	// you are in its cell rather than waiting for the watchdog's next pass ("right
	// now" is the whole promise); from elsewhere it just arms and says so.
	// Turning it OFF restores nothing because nothing was destroyed — the allow
	// list, bans and follower setting were never touched — and any follower the
	// lockdown parked is released by the watchdog on its next tick.
	std::string ToggleLockdown(Config& cfg, const std::string& roomId);

	// Release a claim: unblocks any furniture it blocked, then the VIEW removes
	// the row. Called before a delete so no ref is left blocked in the save.
	std::string ReleaseRoom(Config& cfg, const std::string& roomId);

	// The watchdog. Cheap and early-outs unless the player is inside an enabled
	// guarded room. Returns true if cfg changed (ownership bookkeeping) so the
	// caller persists. Call on the main thread; caller holds the config lock.
	bool Tick(Config& cfg);

	// Boundary ring: place a circle of glow objects on the room's edge so the
	// claimed volume is VISIBLE in the world — the play-test failure this fixes
	// was a too-small claim that silently covered nothing, with no way to see
	// it. reqJson {id, radius?, height?} shows/re-aims (overrides let a slider
	// drag preview before the debounced save lands); {} or unknown id hides.
	// Rings are session-scoped temporaries and auto-hide ~20 s after the last
	// touch (the watchdog sweeps them), so nothing persists into the save.
	std::string ShowRing(Config& cfg, const std::string& reqJson);
	void        HideRing();

	// Restore the original owner of every ref any room claimed — called on save
	// load so claimed ownership never outlives its claim (the tick re-claims
	// whatever is still legitimately guarded). Returns true if cfg changed.
	// (Named for the old BlockActivation design; kept so main.cpp is untouched.)
	bool UnblockAll(Config& cfg);
}
