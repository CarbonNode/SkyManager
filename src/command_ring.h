#pragma once

#include <cstdint>
#include <string>
#include <vector>

/*
 * CommandRing — the engine half of the Command Ring (Rober, 2026-10-12: "id
 * like to integrate the commands system and camp system [of Warband] but with
 * skymanager type UI ... build something similar to this, but hooks to our
 * skymanager supported mods NFF and My home is your home - we also use this
 * now Fight With Me ... i want to be sure its fully integrated").
 *
 * Warband (Nexus 194934) ships a follower framework of its own: an eight-slot
 * text ring of orders, a camp it builds out of placed objects, homes it keeps
 * by linked ref. This rig already runs a follower framework (NFF), a homes
 * framework (My Home is Your Home) and a combat-orders framework (Fight With
 * Me), and Campfire builds the camp. So the Command Ring takes Warband's
 * SHAPE — the ring, its four pages, the camp you pitch, wait at and break —
 * and borrows every mechanic from the mods already here:
 *
 *   Orders  NFF (NffControl ops), PartyRecall, Sic 'em, NFF's own menu,
 *           Walk With Me's menu.
 *   Camp    The camp is a SPOT: where you stood when you made it (a
 *           PlaceActions mark, saved in the co-save, record 'HDCR'). Campfire's
 *           own spells build the fire and craft the gear; NFF's group sandbox
 *           is "settle in"; Domains' marker moves followers to the spot and
 *           its travel takes you back; NFF waits them there.
 *   Homes   My Home is Your Home (MhiyhControl setHome, per follower), NFF's
 *           send-home + wait, a move + NFF follow to bring them back.
 *   Battle  Fight With Me: its four party orders press ITS OWN keys, read
 *           live from FightWithMe.ini [Orders] at the press (the ModKeys law:
 *           those keys exist for exactly this, and FWM 0.1 publishes no
 *           export for them); the Battle Plan through its C export; every
 *           follower's role read through FightWithMe_GetInterface.
 *
 * Nothing of NFF, MHiYH, FWM or Campfire is reimplemented here. This module
 * owns the TABLE (pages, slots, words, what each needs), the camp spot, the
 * ring's own two settings, and the Fight With Me reads. main.cpp owns the
 * runtime (Cr* beside Sw*: open, Focus, slow time) and the dispatch, because
 * the verbs it calls (FireChord, QueueTravel, NpcActions) live there.
 *
 * Settings sidecar: Data/SKSE/Plugins/HotkeyDeck/command-ring.json
 * ({"slow":0.25,"size":100}) — the module's own file, immune to OnJsSave.
 */
namespace CommandRing
{
	// ---- the table ---------------------------------------------------------
	// Pages in ring order. Stable ids: the view and the seeded actions use them.
	const std::vector<std::string>& PageIds();   // orders, camp, homes, battle

	// True for a command id this module knows (cr-*).
	bool IsCommand(const std::string& id);

	// True when the command asks for a second press before it runs (Home is
	// here moves every follower's home).
	bool NeedsConfirm(const std::string& id);

	// MAIN THREAD. Everything the ring draws:
	//   {"ok":true,"page":"orders","size":100,"slow":0.25,
	//    "pages":[{"id","name","full","slots":[{"slot":0..7,"id","label","full",
	//              "ok","why","confirm","key"}]}],
	//    "band":{"count","waiting","loaded","names":[…]},
	//    "camp":{"up","name","dist","here","fire"},
	//    "fwm":{"ok","roles":{"Tank":1,…},"line":"2 Tanks · 1 Healer"}}
	// `key` is the deck trigger bound to the command's seeded entry; for a
	// Fight With Me order with no deck trigger it is FWM's own key ("Num 8").
	// `deckKeys` maps a command id to that deck trigger label (main.cpp reads
	// g_config under its own lock and passes it in).
	std::string StateJson(const std::vector<std::pair<std::string, std::string>>& deckKeys);

	// MAIN THREAD. ok + a player-facing reason when the command cannot run
	// right now (mod missing, nobody following, no camp, …). Asked again at
	// the press, so a stale ring cannot dispatch a dead command.
	bool CanRun(const std::string& id, std::string& why);

	// ---- the camp ----------------------------------------------------------
	// MAIN THREAD. Mark the camp where the player stands (PlaceActions'
	// CurrentLocationJson). Returns false + why indoors / no cell.
	bool MakeCampHere(std::string& why);
	bool CampUp();
	void BreakCamp();
	// The camp as a PlaceActions mark ({name,cellId,cellEdid,x,y,z,angleZ}),
	// "" when no camp is up.
	std::string CampMark();
	// The same mark moved `radius` units out from the camp at `angleDeg`
	// (0 = north) — one spot per follower, so a band waiting at camp stands
	// round it instead of inside one another.
	std::string CampMarkAround(float angleDeg, float radius);
	// Distance from the player to the camp in game units; -1 when the camp is
	// in another cell/worldspace or not up.
	float CampDistance();

	// Co-save record 'HDCR' (hosted by transmog.cpp's callbacks, the
	// ShoutCooldowns precedent): the camp belongs to the save it was made in.
	inline constexpr std::uint32_t kRecord = 'HDCR';
	inline constexpr std::uint32_t kRecordVersion = 1;
	void SaveCosave(SKSE::SerializationInterface* s);
	bool LoadCosave(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t length);
	void RevertCosave();

	// ---- Fight With Me -----------------------------------------------------
	// True when FightWithMe.dll is loaded.
	bool FwmLoaded();
	// The FightWithMe.ini setting a party-order command presses
	// ("iAttack" / "iToMe" / "iHoldBack" / "iAsYouWere"), "" for any other id.
	std::string FwmOrderKey(const std::string& id);
	// WORKER THREAD (file IO). Re-read FightWithMe.ini [Orders] so the ring
	// can print FWM's keys and dim an order whose key is unbound. Call at
	// kDataLoaded and on every ring open; re-push the state after.
	void RefreshFwmKeys();
	// FWM's role for one follower: "Fighter", "Tank", "Healer", "Bruiser",
	// "Archer", "Mage", or "" when FWM is absent / has no orders for her.
	// MAIN THREAD (the interface says so).
	std::string FwmRole(std::uint32_t actorFormId);

	// ---- settings ----------------------------------------------------------
	// slow  = world time multiplier while the ring is up (0.05 .. 1.0, never 0).
	// size  = the ring's scale in percent (70 .. 140).
	struct Options
	{
		float slow = 0.25f;
		int   size = 100;
	};
	Options     GetOptions();
	std::string OptionsJson();
	// Merge {"slow":n,"size":n} or {"reset":true}, clamp, persist.
	std::string SetOptions(const std::string& requestJson);
}
