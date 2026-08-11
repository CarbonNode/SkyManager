#pragma once

#include <cstdint>
#include <filesystem>
#include <map>
#include <string>
#include <utility>
#include <vector>

// Wardrobe backend for the Hotkey Deck "Wardrobe" tab — a wardrobe layer over
// SOES-NG (Skyrim Outfit Equipment System NG). Encapsulates the wardrobe config
// slice AND the roll/apply operations, so main.cpp holds only a global + thin JS
// handlers (mirrors finance / spell_actions / place_actions).
//
// WHY A LAYER. SOES-NG owns outfit definitions, per-actor assignment across 25
// location types, the EquipObject hook and the auto-switch poller. Per its own
// source review (modding/guides/soes_ng_technical_analysis.md §8) it has NO
// outfit pools, NO randomisation, NO scheduling beyond Day/Night and NO
// per-outfit metadata. This file adds exactly those four and nothing else.
//
// ⛔ WE NEVER CALL SOES DIRECTLY. Its API is Papyrus natives, and this rig has a
// documented CTD bucket inside the Papyrus-VM native-call path — nff_bridge.h
// refuses to write for the same reason. Instead the deck sends an SKSE MOD EVENT
// and a thin Papyrus quest script (HD_WardrobeExec.psc) calls the natives, which
// is SOES's own intended call path. The actor rides on the event's `sender`
// field because a float numArg cannot hold a 32-bit FormID exactly.
//
// Ownership: the VIEW owns categories/outfitMeta/wardrobes/assignments/settings
// (sent whole via wdSave -> MergeViewSlice); C++ owns the SOES catalogue, the
// roster, the roll bookkeeping (lastRollDay/lastOutfit) and the game clock,
// pushed back via wdOpen/wdState. The two never race.
//
// MAIN THREAD ONLY for anything touching RE:: state. See src/wardrobe-wiring.md.
namespace Wardrobe
{
	struct Category
	{
		std::string  id, name;
		std::int32_t hue = 38;
	};

	// "This outfit / this wardrobe is HERS." A durable actor identity plus the
	// display name at the time it was tagged — the name is a CACHE for drawing a
	// pill without resolving a form (the deck must be able to draw the tag with
	// the game shut, on the phone portal), and `key` is what anything actually
	// compares. Renaming her in Follower Organizer changes the cached name on
	// the next tag, never the identity.
	struct NpcTag
	{
		std::string key;    // "0xABCD|Mod.esp" — ActorKey(), the same shape assignments use
		std::string name;   // display name when tagged, for the pill
	};

	// Our metadata ON TOP of a SOES outfit. Joined by `name`, because that is
	// SOES's own key (SetSelectedOutfit(actor, name)).
	//
	// `tags` and `forNpcs` are the pill row (Rober, 2026-08-11: "adding tags to
	// wardrobes that show as pills. One such tag would be associating a wardrobe
	// or outfit with an npc, and then being able to easily filter in the outfit
	// popout"). They are DELIBERATELY separate from categoryIds: a category is a
	// curated, hued, renameable thing with an id, and there are a handful of
	// them; a tag is free text you type once and forget. Both draw as pills.
	struct OutfitMeta
	{
		std::string              name, image, note;
		std::vector<std::string> categoryIds;
		bool                     fav = false;
		std::vector<std::string> tags;
		std::vector<NpcTag>      forNpcs;
	};

	// A pool of SOES outfit names.
	struct Pool
	{
		std::string              id, name, note;
		std::int32_t             hue = 38;
		std::vector<std::string> outfits;
		// Same pill row as an outfit's — a wardrobe is the thing Rober asked for
		// tags on first ("adding tags to wardrobes").
		std::vector<std::string> tags;
		std::vector<NpcTag>      forNpcs;
		// "bag" = shuffle-bag: every outfit is worn once before any repeats, which
		// is what people actually mean by "vary her clothes". "random" = uniform
		// pick, avoiding only the last one. `bag` holds what is still unworn this
		// cycle and refills when it empties.
		std::string              mode = "bag";     // bag | random
		std::vector<std::string> bag;
	};

	struct LocOverride
	{
		std::int32_t loc = 0;          // SOES LocationType id (0..6400)
		// Exactly one of these is set. A wardrobe rolls a fresh pick from the
		// pool on every dress; an outfit pins SOES's native per-location slot to
		// that one look — the "full base logic" (Rober, 2026-08-02), with
		// wardrobes injectable per location on top.
		std::string  wardrobeId;
		std::string  outfit;
	};

	struct Assignment
	{
		// Durable actor identity: local FormID + source plugin, the same shape
		// SOES itself persists ("0xABCD|Mod.esp"). A raw runtime FormID would
		// break the moment the load order moves.
		std::string              formId, plugin, name;
		std::string              mode = "off";   // off | outfit | wardrobe
		std::string              wardrobeId, outfit;
		std::int32_t             cadenceHours = 0;   // 0 = never re-roll
		std::vector<LocOverride> locationOverrides;
		double                   lastRollDay = 0.0;  // Calendar::GetDaysPassed()
		std::string              lastOutfit;
	};

	// A DISPLAY crop for ONE outfit-photo FILE. The plugin cannot re-cut the
	// pixels — portrait_capture.cpp ships a hand-rolled PNG encoder and no
	// decoder at all — so the view pans/zooms the picture it already draws with
	// a CSS transform and this is the memory of where it put it.
	//
	// z is the display zoom (1 = the whole cover-fitted tile); x/y are the pan
	// as FRACTIONS of the tile's own width/height, so one crop is right on a
	// 22 px builder chip and in the big editor alike. The invariant
	// |x|,|y| <= (z-1)/2 (the slack the zoom creates) is what stops a crop ever
	// showing the well behind the picture, and it is enforced identically here
	// and in wardrobe-pane.js clampCrop().
	struct ImageCrop
	{
		double z = 1.0;
		double x = 0.0;
		double y = 0.0;
	};

	// Mirrored in wardrobe-pane.js CROP_MAX_ENTRIES. Crops are pruned against
	// the real icons/custom/ folder on every save, so this only ever bites a
	// hand-edited hotkeys.json — but a map the plugin re-reads at every load
	// deserves a ceiling on both sides.
	inline constexpr std::size_t kMaxImageCrops = 400;

	struct Config
	{
		std::vector<Category>   categories;
		std::vector<OutfitMeta> outfitMeta;
		std::vector<Pool>       wardrobes;
		std::vector<Assignment> assignments;
		// Outfit-photo FILE NAME -> crop. The file, never the outfit: renaming
		// an outfit must keep its framing, and a re-shot photo (which lands as
		// `<slug>~<unixtime>.png` whenever the renderer still has the old file
		// mapped, which it does the moment the deck has drawn the card) arrives
		// under a name this map has never seen and is drawn as shot. That is
		// what makes double-cropping structurally impossible rather than merely
		// unlikely. Keys are bare names inside PrismaUI/views/HotkeyDeck/icons/
		// custom/ — anything with a separator is refused, never sanitised.
		std::map<std::string, ImageCrop> imageCrops;
		bool                    enabled = true;   // master switch for the cadence tick
		bool                    notify  = true;   // corner notification on a re-roll
		// Two SOES-NG system switches that had no route out of its MCM.
		//
		//   soesQuickslot   SOES's quick-swap POWER — a lesser power that raises
		//                   a menu of the outfits flagged favourite. Setting an
		//                   outfit's star now also sets SOES's own favourite
		//                   flag, which is the list this menu reads.
		//   soesClimate     climate priority: when ON, weather (snow/rain) beats
		//                   the location type, so a blizzard dresses her for the
		//                   blizzard instead of for "she is in a city".
		//
		// ⚠ These are a MIRROR, not a reading. SOES exposes IsQuickslotEnabled /
		// IsClimatePriorityEnabled only as Papyrus natives, and this file never
		// calls Papyrus (see the header comment) — nor does SOES put either flag
		// in the JSON it exports. So the deck remembers what IT last set and says
		// so in the UI; a change made in SOES's own MCM is invisible here until
		// the deck is used to set it again. Both are therefore C++-OWNED and
		// preserved across MergeViewSlice, exactly like the roll bookkeeping —
		// the view renders them but is never their authority.
		bool                    soesQuickslot = false;
		bool                    soesClimate   = false;
		// View-only: the Wardrobe TAB's own zoom (0.6-1.6), applied in JS as
		// --wd-ui-scale. C++ never acts on it, it only carries it so the setting
		// survives a restart - exactly like Settings::uiScale for the deck and
		// FollowerConfig::uiScale for the Followers tab.
		double                  uiScale = 1.0;
	};

	void Init();

	// Persisted slice. ToJson returns a json OBJECT for WriteConfigFile to drop
	// under "wardrobe"; FromJson is what LoadConfig reads back.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Apply a VIEW wdSave payload. Roll bookkeeping (lastRollDay/lastOutfit) is
	// C++-owned and is preserved per assignment even though the view echoes it.
	// Returns false on an unparseable payload.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg);

	// Assignments that this merge just turned ON — mode moved off→active, or an
	// active one gained its first outfit/pool. Filled by MergeViewSlice when the
	// caller passes it, so the caller can auto-track them: assigning an outfit
	// MEANS "SOES manages her" (Rober, 2026-08-03), and a third click to say so
	// again was the step everyone forgot.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg,
		std::vector<std::pair<std::string, std::string>>* activated);

	// ---- outfit-photo display crops ----
	// Own bridge pair on the view side: `wdCropSave` in, `wdCrops` out. One name
	// per DIRECTION — PrismaUI installs each listener as a global, so a name used
	// for both silently unplugs the control.

	// THE one place the crop invariant lives on this side. Returns false for
	// "nothing to store": an identity crop is not a crop, and keeping it would
	// grow the map with rows that draw nothing.
	bool ClampImageCrop(ImageCrop& c);

	// A crop key names a plain SIBLING inside icons/custom/. Anything that could
	// walk out of there is refused rather than sanitised.
	bool ValidImageFileName(const std::string& s);

	// Apply one `{file,z,x,y}` (or `{file,clear:true}`) from the editor.
	// Returns false if the payload was unusable — the caller then persists
	// nothing. Does NOT prune; call PruneImageCrops after.
	bool ApplyCropSave(Config& cfg, const std::string& reqJson);

	// Drop crops whose picture has left `dir`, so the map cannot grow for the
	// life of the save. DELIBERATELY A NO-OP WHEN THE FOLDER READS EMPTY: an
	// unreadable directory (mid-MO2 VFS teardown, a drive hiccup) is
	// indistinguishable from one somebody really emptied, and one of those two
	// readings silently deletes every crop the player ever set. Losing a prune
	// costs nothing; the next save does it. Returns true if anything was dropped.
	bool PruneImageCrops(Config& cfg, const std::filesystem::path& dir);

	// The map-level half of PruneImageCrops, exposed so a DIFFERENT tab's crop
	// map gets the identical rule — including the empty-directory refusal above,
	// which is the part nobody re-derives correctly. The Domains tab's place
	// photos (main.cpp, DomainsConfig::imageCrops) are the first borrower: they
	// live in their own folder but obey the same invariant, and a second copy of
	// this loop is exactly how the two would drift.
	bool PruneCropMap(std::map<std::string, ImageCrop>& crops, const std::filesystem::path& dir);

	// The map as the view wants it, already `.dump()`ed — PushToView takes a
	// std::string, and handing it a nlohmann::json COMPILES and then throws
	// type_error.302 at runtime, which inside a PrismaUI callback is a hard CTD.
	std::string CropsJson(const Config& c);

	// Payloads pushed to the view.
	//   wdOpen  — the whole slice + the SOES catalogue + the roster + the clock
	//   wdState — the volatile half only (catalogue, roster, rolls, clock)
	//
	// `foStateJson` is a Follower Organizer Deck API envelope — the roster is
	// taken from FO rather than enumerated here, exactly like nff_bridge, so the
	// Wardrobe and Followers tabs always agree on who exists. Anyone already
	// carrying an assignment is appended even if FO has since dropped them, so a
	// wardrobe never silently loses its wearer.
	// Upgrade every stored assignment to the DURABLE (local FormID + plugin)
	// pair, and rescue any whose stored FormID no longer addresses anybody by
	// matching its NAME against the live Follower Organizer roster.
	//
	// Follower Organizer's Deck API hands out a RUNTIME FormID and no plugin, so
	// that is what every assignment was filed under. On this rig ~4,000 light
	// plugins means a light plugin's index — and every runtime id it owns — moves
	// whenever one ESL ahead of it is toggled, which orphaned Elana Darkfire's
	// assignment and rendered her as a second, permanently "not loaded" person
	// (2026-08-02). It also means no row ever matched SOES's own
	// "0x81a|NWS_Elana.esp" keys, so nobody was shown as tracked.
	//
	// Returns true when something changed, so the caller persists. Call it with
	// the config lock held and a fresh FollowerDeck::StateJson().
	bool RepairIdentities(Config& cfg, const std::string& foStateJson);

	std::string OpenJson(const Config& c, const std::string& foStateJson);
	std::string StateJson(const Config& c, const std::string& foStateJson);

	// ---- operations (MAIN THREAD ONLY) ----

	// Pick from the person's wardrobe (or take their single outfit) and dress
	// them now. Returns {ok,msg} and, on success, stamps lastRollDay/lastOutfit.
	std::string Dress(Config& cfg, const std::string& reqJson);

	// Put a specific outfit on the PLAYER now, ignoring assignments. Used by the
	// wardrobe's photo mode, where the whole point is to look at one outfit.
	// {"outfit":"name"}
	std::string DressNow(const std::string& reqJson);

	// Equip ONE armour piece on the PLAYER — the Inventory tab's "wear just
	// this". Refuses pieces the player is not carrying. {"formId","plugin"}
	// Returns {ok,msg}. MAIN THREAD ONLY.
	std::string EquipPiece(const std::string& reqJson);

	// "Just put it on her." Drop an outfit's pieces into an actor's inventory
	// and force-equip them, with no assignment, no tracking and no SOES event —
	// Rober, 2026-08-11: "what about option to just drop it into inventory and
	// force equip?". Dress() and DressNow() both go THROUGH a management system
	// (an Assignment SOES then owns); this deliberately goes through neither, so
	// what she is wearing afterwards is nobody's business but hers.
	//
	// Pieces come from Wardrobe::OutfitPiecesJson, i.e. SOES's own export read
	// by the one parser we have — never a second reader. A piece she already
	// carries is equipped rather than duplicated. Anything that no longer
	// resolves is COUNTED and reported, never silently dropped.
	//
	// ⚠ It is the caller's job to refuse this while SOES tracks her: SOES's
	// EquipObject hook re-dresses a tracked actor within its 2 s poll, so a
	// force-equip would be visibly undone (the same hazard nff_outfits.cpp
	// documents on Claim). The F7 dock guards it view-side, where the mode is
	// already known. {"formId","plugin","outfit"} -> {ok,msg,worn,missing}
	// MAIN THREAD ONLY.
	std::string GiveAndWear(const std::string& reqJson);

	// Track / untrack an actor in SOES. Refuses to TRACK someone with nothing to
	// wear: a tracked actor SOES cannot dress gets stripped every 2 s poll, which
	// is the documented White Hearth crash-loop
	// (modding/troubleshooting/soes_ng_crash_issue.md).
	std::string SetTracked(const Config& cfg, const std::string& reqJson);

	// ---- browsing what the game has (engine-side, no Papyrus) ----

	// Every armour mod in the load order that actually contains armour, and the
	// armours within one. This is how an outfit gets built out of something you
	// do NOT currently carry. Read straight off TESDataHandler's form array —
	// SOES exposes natives for this too, but the engine already has the answer
	// and going direct avoids a Papyrus round trip entirely.
	std::string ArmorModsJson();
	std::string ArmorsForModJson(const std::string& reqJson);   // {"plugin":"x.esp","q":"filter"}

	// The pieces of an existing SOES outfit, from its own export. Answers "what
	// is actually in this thing" — the count alone was never enough.
	std::string OutfitPiecesJson(const std::string& reqJson);   // {"name":"..."}

	// ---- editing outfits + SOES itself (mod events -> HD_WardrobeExec.psc) ----

	std::string RemovePiece(Config& cfg, const std::string& reqJson);      // {"name","formId","plugin"}

	// Rename an outfit in SOES *and* re-point everything of ours that named it:
	// metadata, every pool's list and shuffle-bag, every assignment's outfit,
	// its location overrides and its roll history. SOES holds an outfit under
	// its NAME and nothing else, so a rename that only touched our side would be
	// a delete plus a pile of orphans. {"name":"old","to":"new"}
	//
	// Refuses a "|" in either name: that character is the separator the rename
	// event uses to carry two strings in one field (and SOES's own form-key
	// separator), so a name containing it cannot round-trip. Refused loudly
	// rather than mangled.
	std::string RenameOutfit(Config& cfg, const std::string& reqJson);

	// Set SOES's OWN favourite flag on an outfit, and mirror it into our
	// OutfitMeta so the star survives a restart. This is what makes the star
	// mean something in-game: SOES's quickslot power lists exactly the outfits
	// SetOutfitFavoriteStatus has flagged. {"name":"...","on":true}
	std::string SetOutfitFav(Config& cfg, const std::string& reqJson);

	// One of the two SOES system switches above. {"key":"quickslot"|"climate","on":bool}
	std::string SetSoesOption(Config& cfg, const std::string& reqJson);

	// Every plugin in the load order that DEFINES outfit (OTFT) records, and the
	// outfits inside one — the browser behind SOES's own outfit importer.
	//
	// Why enumerate rather than ask SOES: its GetAllLoadedOutfitModsList /
	// GetAllLoadedOutfitsForMod are Papyrus natives, and a native's answer would
	// have to come back through a second mod event and a file. TESDataHandler
	// already holds every BGSOutfit and which file it came from, so the engine
	// answers instantly and exactly. The IMPORT itself still goes through SOES
	// (ImportModOutfits -> HD_Wardrobe_Import), because only SOES knows how to
	// turn an OTFT into one of its own outfits.
	std::string OutfitModsJson();                                          // {} -> {"mods":[{plugin,count}]}
	std::string OutfitsForModJson(const std::string& reqJson);             // {"plugin":"x.esp","q":"filter"}

	// Delete an outfit from SOES itself, and drop our metadata + any pool
	// membership so nothing dangles. {"name":"..."}
	std::string DeleteOutfit(Config& cfg, const std::string& reqJson);
	std::string ImportModOutfits(const std::string& reqJson);              // {"plugin","editorId"?} — one, or all
	std::string SetInventoryMode(const std::string& reqJson);              // {"who":"player"|"npc","mode":1|2}
	std::string SetSoesEnabled(const std::string& reqJson);                // {"on":true}
	std::string RefreshAll();                                              // re-dress every tracked actor
	std::string ResetAutoSwitch();                                         // clear the auto-switch state machine

	// Cadence tick. For every wardrobe assignment whose cadence has elapsed in
	// GAME time, roll a new outfit (never the same one twice running) and apply
	// it. Returns true if anything changed, so the caller persists and re-pushes.
	// Cheap enough to call on a slow timer; it does nothing until a due date.
	bool MaybeRoll(Config& cfg);

	// Build a real SOES outfit from inventory pieces, straight from the deck.
	// Same payload shape as the portal's POST /api/outfit, so the in-game and
	// phone paths cannot drift:
	//   { "name": "...", "items": [ { "formId": "0x...", "plugin": "...", "name": "..." } ] }
	// Returns {ok,msg}. MAIN THREAD ONLY (resolves forms, sends mod events).
	std::string BuildOutfit(Config& cfg, const std::string& reqJson);

	// What an actor is WEARING right now, as the same {formId,plugin,name,slot,…}
	// shape the inventory uses — so "make an outfit out of what she has on" is
	// just a pre-filled build basket. `reqJson` is {} or {"formId","plugin"};
	// empty targets the PLAYER. Returns {ok,who,items:[...]}.
	// MAIN THREAD ONLY.
	std::string WornJson(const std::string& reqJson);

	// Export the player's armour to wardrobe-inventory.json, so the Deck Portal
	// (and Claude, over /api/inventory) can see what there is to build an outfit
	// from. MAIN THREAD ONLY — it walks the player's inventory.
	bool WriteInventoryJson();

	// Ask SOES to dump its state to OutfitEquipmentSystemNGData.json, then read
	// it. Called on tab open; the catalogue is cached until the next refresh.
	void RequestCatalogueRefresh();
	bool LoadCatalogue();          // true if the file parsed and the cache changed
	bool CatalogueAvailable();

	// Last-write time of SOES's export, or 0 if it isn't there. The export is
	// ASYNCHRONOUS — RequestCatalogueRefresh only posts a mod event, and Papyrus
	// gets to it when it gets to it (measured: ~90 s on a busy save). Callers
	// watch this stamp so the tab can fill itself in instead of making you close
	// and reopen it, which is what the first cut did.
	std::uint64_t CatalogueStamp();

	// Portal replay: read Data/PrismaUI/views/HotkeyDeck/portal-wardrobe.json,
	// apply queued ops to cfg (view-owned fields only), then delete it. Returns
	// true if anything changed (caller: PersistAll + re-push wdOpen).
	bool ApplyPortalWardrobe(Config& cfg);
}
