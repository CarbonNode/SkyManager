#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace Wardrobe { struct Config; }

// ---------------------------------------------------------------------------
// NFF outfits — the SECOND dressing backend behind the deck's Wardrobe tab.
//
// Nether's Follower Framework has an outfit system of its own, and it is a
// complete auto-switching dressing engine, not a helper: per follower it keeps
// up to THREE wardrobes of real items in hidden chests and swaps her whole
// default Outfit as the PLAYER's location type changes.
//
// Decoded from the shipped scripts (Champollion -> C:\Dev\nff-decomp;
// nwsFollowerSetsScript.psc + nwsFollowerAutoSetsScript.psc):
//
//   nwsFF_storedFac   in faction  = NFF holds outfit state for this actor
//                     RANK        = her storage SLOT (0..127)
//   nwsFF_OutfitFac   RANK        = which of the three sets EXIST, as a code:
//                       0 adventure · 1 town · 2 home
//                       3 adv+town · 4 adv+home · 5 town+home · 6 all three
//                       (7 = none; CheckActorOutfit skips 0 and 7)
//   nwsFF_OutTypeFac  RANK        = which set she is WEARING right now
//                       0 adventure · 1 town · 2 home · 3 = her base outfit
//   nwsFFOutfitChestList[slot]    = the adventure set's chest  (a real container)
//   nwsFFTownChestList[slot]      = the town set's chest
//   nwsFFHomeChestList[slot]      = the home set's chest
//
// switchOutfit(actor, type) then does: SetOutfit(blank) -> rebuild the per-slot
// LeveledItem from that chest -> SetOutfit(nwsFFOutfitsCustom[slot]).
//
// ============================ THE HARD RULE ================================
//
// ⛔ ONE ACTOR, ONE DRESSING BACKEND. NFF outfits and SOES-NG cannot both own
// the same NPC:
//
//   * SOES-NG hooks RE::ActorEquipManager::EquipObject and, for a TRACKED
//     actor, silently drops any equip of a piece that is not in its current
//     outfit (soes_ng_technical_analysis.md §"EquipObject hook"). The live
//     SkyrimOutfitEquipmentSystemNG.ini on this rig has
//     AllowExternalEquipment = false, i.e. the hook is ON.
//   * NFF's switchOutfit re-dresses through exactly that path, so on a tracked
//     actor the strip lands and the re-dress does not. NFF still stamps
//     nwsFF_OutTypeFac, so it believes it succeeded and never retries — the
//     follower is simply, permanently, wearing the wrong thing.
//   * And every player location change costs a full strip + re-equip of every
//     biped slot. That strip/re-equip storm is the signature of the documented
//     White Hearth crash (troubleshooting/soes_ng_crash_issue.md).
//
// So the two backends coexist happily at the SYSTEM level and never at the
// ACTOR level. Everything here enforces that: `Conflicts()` names the overlap,
// and every write op refuses an actor SOES is tracking unless the caller has
// explicitly claimed her for NFF (which untracks her from SOES first).
//
// ============================ WHAT WE CALL =================================
//
// NFF publishes NO mod events — proven, not assumed: scanning every .pex in
// `Nether's Follower Framework\Scripts` for the string "ModEvent" returns
// exactly one hit and it is UILIB_1.pex (SkyUILib), not NFF's own code. The
// only programmatic route is a Papyrus call on its quest script.
//
// So, like Wardrobe over SOES, the deck NEVER calls it from C++ (this rig has
// a documented CTD bucket inside the Papyrus-VM native-call path, which is why
// nff_bridge.h refuses to write at all). Reads here are pure ENGINE — faction
// ranks, form lists, container inventories — and writes are an SKSE MOD EVENT
// that HD_WardrobeExec.psc turns into NFF's own public entry points:
//
//   DialogueCmd(actor, 0, type)   create/refill a set  (opens the chest — NFF's
//                                 own dialogue fragment calls exactly this)
//   DialogueCmd(actor, 1, type)   clear a set; type 3 = drop her from NFF
//   DialogueCmd(actor, 2, 0)      open her satchel
//   switchOutfit(actor, type)     wear a set now; type 3 = back to her base
//
// ONE event, "HD_NFF_Op", and its three fields are chosen so the Papyrus side
// needs no parsing and no new ESP master:
//
//   strArg  the operation, as a literal: "wear0".."wear3", "build0".."build2",
//           "clear0".."clear3", "satchel". Twelve exact string compares beats
//           writing a hex parser in Papyrus.
//   numArg  the ESP-LOCAL FormID of NFF's outfit quest. float32 carries a
//           24-bit mantissa and a local id is <= 0xFFFFFF, so it round-trips
//           exactly; the executor turns it back with Game.GetFormFromFile and
//           casts to nwsFollowerSetsScript. That is why the deck can address
//           NFF without OutfitCycler.esp taking it as a master, and why the
//           executor never hardcodes a FormID nobody verified.
//   sender  the Actor — which is precisely what CANNOT ride on numArg, because
//           a runtime FormID uses all 32 bits.
//
// MAIN THREAD ONLY for anything touching RE:: state.
// ---------------------------------------------------------------------------
namespace NffOutfits
{
	// The three NFF outfit types, numbered as NFF numbers them. This numbering
	// is NFF's own public API (its dialogue fragments pass it as myOpt), so it
	// is what goes on the wire and what the view's SETS spec keys off.
	constexpr int kTypeCount = 3;
	enum Type : int
	{
		kAdventure = 0,
		kTown      = 1,
		kHome      = 2,
		kBase      = 3,   // not a set — "wear her original outfit"
	};

	// Our metadata for ONE of a person's three sets. NFF stores none of this:
	// its sets are anonymous, identified only by their slot in the chest list.
	// A name and an icon is the whole reason this tab exists rather than the
	// MCM.
	struct SetMeta
	{
		std::string label;   // "Riverwood evening", "" = use the type's own name
		std::string icon;    // "icons/custom/foo.png" — the shared deck icon pool
		std::string note;
	};

	struct NpcMeta
	{
		// Durable identity, same shape as Wardrobe::Assignment and SOES itself.
		std::string formId, plugin, name;
		SetMeta     sets[kTypeCount];
		std::string note;
		// True once this person has been deliberately handed to NFF. It is what
		// makes the one-backend rule enforceable rather than advisory: claiming
		// her untracks her from SOES, and the Wardrobe tab greys her out.
		bool claimed = false;
	};

	struct Config
	{
		std::vector<NpcMeta> npcs;
		bool                 enabled = true;   // show the tab / allow writes
		// NFF's "Outfit Preview Mode" (its MCM's $FF_ViewGear), mirrored.
		//
		// OFF (NFF's default) a set is filled through a hidden chest: you see a
		// container, not her. ON, NFF freezes her, strips her and hands you HER
		// inventory instead, so you dress the body you are looking at and the
		// result is applied when you close the menu.
		//
		// ⚠ A MIRROR, like Wardrobe's SOES switches. `viewMode` is a hidden
		// property on NFF's quest and this file never READS Papyrus state it
		// cannot get through a property fetch — it can, in fact, be read, but
		// only while the quest is bound, so the stored copy is what the UI
		// renders when the game is not up (the Deck Portal). C++-owned:
		// preserved across MergeViewSlice.
		bool                 preview = false;
	};

	// ---- persistence (slice "nffOutfits" in hotkeys.json) ----
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Apply a VIEW payload. The view owns every field in Config, so this is a
	// straight replace with validation. Returns false on an unparseable body.
	bool MergeViewSlice(const std::string& viewJson, Config& cfg);

	// True when NFF's outfit quest script could be bound this session. False =
	// NFF absent, or no save loaded yet. Never throws, never warns twice.
	bool Available();

	// ---- reads (pure engine, MAIN THREAD) ----

	// Everything the tab needs, for exactly the people in `foStateJson` (a
	// Follower Organizer Deck API envelope — the same roster the Followers and
	// Wardrobe tabs use, so all three always agree on who exists).
	//
	//   { "ok":true, "nff":true, "enabled":true,
	//     "slotsUsed": 11, "slotsMax": 128,
	//     // `original` is FO's un-renamed name. It is here because it is what a
	//     // PORTRAIT is keyed on — the Followers tab resolves a face with
	//     // slugOf(original || name) against the fdPortraits listing, and this
	//     // pane reuses that exact resolver rather than growing a second one.
	//     "npcs": [ { "formId","plugin","name","original",
	//                 "slot": 3,               // -1 = NFF holds nothing for her
	//                 "have": [true,false,true],   // which sets exist
	//                 "worn": 0,               // 0..2, 3 = her base outfit, -1 unknown
	//                 "counts": [7,0,4],       // pieces in each set's chest
	//                 "meta": { label/icon/note per set, note, claimed } } ],
	//     "conflicts": [ "0x1A6A1|Skyrim.esm", … ] }   // ALSO SOES-tracked
	//
	// `wardrobe` is consulted read-only for the conflict list; pass the live
	// Wardrobe::Config. Nothing here mutates it.
	std::string OpenJson(const Config& c, const Wardrobe::Config& wardrobe,
		const std::string& foStateJson);

	// The actual armour in one person's set — "what IS this outfit" was never
	// answerable from NFF's own UI without opening the chest in-game.
	// req: {"formId","plugin","type":0|1|2}
	std::string PiecesJson(const std::string& reqJson);

	// ---- writes (mod events -> HD_WardrobeExec.psc, MAIN THREAD) ----

	// Wear a set now. req: {"formId","plugin","type":0|1|2|3}. Refuses while
	// SOES is tracking her unless she is `claimed`.
	std::string Wear(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson);

	// Open the chest for a set so you can fill it (NFF's CreateOutfit). This is
	// inherently interactive — NFF hands you a ContainerMenu — so the caller
	// must close the palette first. req: {"formId","plugin","type":0|1|2}.
	std::string Build(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson);

	// Clear one set, or (type 3) drop her from NFF's outfit system entirely and
	// give her her original outfit back. req: {"formId","plugin","type":0..3}.
	std::string Clear(Config& cfg, const std::string& reqJson);

	// Open her NFF satchel (where her own gear went while an outfit is on).
	std::string Satchel(const std::string& reqJson);

	// Copy what she is WEARING into the player's pack — NFF's own "Copy Outfit"
	// ($FF_CloneOutfit). It adds a copy of each part of her active set, or of her
	// DEFAULT outfit when no set is active, so the same look can be built for
	// somebody else without undressing her. Nothing leaves her inventory.
	// req: {"formId","plugin"}
	std::string Clone(const Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson);

	// The two SYSTEM-WIDE controls NFF's outfit engine has and its MCM kept to
	// itself. Neither takes a follower.
	//
	//   SetPreview  {"on":bool}                 — Outfit Preview Mode (above)
	//   SwitchNow   {"mode":"switch"|"recheck"} — "switch" is NFF's own outfit
	//               switch hotkey (raises its three-way chooser on Manual switch
	//               style, flips on Toggle, re-evaluates on Automatic);
	//               "recheck" is the quiet half — re-evaluate and re-dress
	//               everyone with no chooser. Between them they are the answer
	//               to "she is standing in my house still in her armour".
	std::string SetPreview(Config& cfg, const std::string& reqJson);
	std::string SwitchNow(const std::string& reqJson);

	// ---- combat gear: helmet / shield / weapon / ammo ----
	//
	// NFF's four per-follower gear switches — "helmet only in combat" and its
	// three siblings. They are FACTION state, not script properties, which is
	// the fact the whole implementation turns on:
	//
	//   nwsFF_HelmFac    absent = unmanaged · RANK 0 = helmet only in combat
	//                    RANK 1 = never wears one
	//   nwsFF_ShieldFac  membership = shield only in combat
	//   nwsFF_WeaponFac  membership = her weapons follow YOUR sheath
	//   nwsFF_AmmoFac    membership = arrows away out of combat
	//
	// The faction forms live on nwsFollowerVariableScript, found in the same
	// quest sweep that finds the sets quest.
	//
	// Gear    req {"formId","plugin"} -> {"ok","known",helm:"off"|"combat"|
	//         "never", shield, weapon, ammo}. `known:false` = NFF's variable
	//         quest could not be bound (no save loaded / NFF absent); the view
	//         must render that as unknown, NOT as four confident OFFs.
	// SetGear req {"formId","plugin","op"} where op is one of
	//         helmOff|helmCombat|helmNever|shieldOn|shieldOff|
	//         weaponOn|weaponOff|ammoOn|ammoOff.
	//
	// ABSOLUTE states, not toggles — NFF's own MCM cycles, which is right for a
	// menu you are looking at and wrong for a deck button firing against a read
	// that may be a frame stale. Sending the same op twice is a no-op.
	//
	// Neither is gated by the one-actor-one-backend rule: these switches dress
	// nobody, and a SOES-tracked follower has a head too.
	std::string Gear(const std::string& reqJson);
	std::string SetGear(const std::string& reqJson);

	// Copy the PIECES of a SOES-NG outfit into one of her NFF sets — the bridge
	// between the two backends, and the only place they are allowed to meet.
	// req: {"formId","plugin","type":0|1|2,"outfit":"<SOES outfit name>"}
	//
	// This moves ITEMS ONLY. It does not track her in SOES, does not touch her
	// Wardrobe assignment, and leaves NFF owning her exactly as before — which
	// is what keeps it clear of the one-actor-one-backend rule. Displaced
	// contents go to the PLAYER, mirroring NFF's own ClearContainer rather than
	// destroying clothes.
	//
	// Requires the set to already EXIST: NFF learns about a set through its own
	// CreateOutfit flow (faction rank, satchel alias, saved base outfit), so
	// stuffing a chest it has never registered would put clothes somewhere
	// nothing ever reads.
	std::string CopyFromWardrobe(Config& cfg, const Wardrobe::Config& wardrobe, const std::string& reqJson);

	// Claim / release a person for the NFF backend. Claiming UNTRACKS her from
	// SOES first (that is the whole point — one backend per actor) and drops any
	// Wardrobe assignment she had; releasing just clears the flag and leaves
	// both systems alone. req: {"formId","plugin","on":true}.
	std::string Claim(Config& cfg, Wardrobe::Config& wardrobe, const std::string& reqJson);

	// ---- identity repair ----
	// Upgrade every stored row to the DURABLE (local FormID + plugin) pair, and
	// rescue any row whose stored FormID no longer addresses anybody by matching
	// its NAME against the live Follower Organizer roster.
	//
	// Why this is needed and not just paranoia: FO's Deck API hands out a RUNTIME
	// FormID with no plugin, and on this rig ~4,000 light plugins means a light
	// plugin's index — and therefore every runtime id it owns — moves whenever
	// one ESL ahead of it is enabled or disabled. A row filed in the old order
	// then resolves to nothing (or, worse, to a stranger), which is what put two
	// Elana Darkfires in the tab, one permanently "not loaded" (2026-08-02).
	//
	// Returns true when something changed, so the caller persists. Call it with
	// the config lock held and a fresh FollowerDeck::StateJson().
	bool RepairIdentities(Config& cfg, const std::string& foStateJson);

	// ---- portal replay ----
	// Read Data/PrismaUI/views/HotkeyDeck/portal-nff.json, apply the queued ops
	// (metadata only — labels, icons, notes; never a gameplay write), delete it.
	// Returns true if anything changed, so the caller persists and re-pushes.
	//
	// The portal must NEVER write this config itself: the game owns hotkeys.json
	// while it runs, exactly as it owns FollowerOrganizer.json. Same law, same
	// queue-and-replay answer as portal-npc-fields.json.
	bool ApplyPortal(Config& cfg);
}
