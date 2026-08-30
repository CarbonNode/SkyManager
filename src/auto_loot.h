#pragma once

#include <functional>
#include <map>
#include <string>
#include <vector>
#include <cstdint>

namespace RE { class TESObjectREFR; }

// Auto-Loot — configurable auto-pickup of nearby LOOSE world loot to the player
// or a designated marked container (Rober, 2026-08-15). Sibling to the Loot
// Highlighter's glow scanner, but SHARES NOTHING with it: its own poller, own
// scan, own config slice (`autoLoot`), own session looted-set. It reads
// LootHighlight only never — the LOTD-wanted toast classification is RE-DERIVED
// here (the TCC list read), because loot_highlight.h exposes no usable public
// API for it and its source belongs to another session's WIP.
//
// Design, load-bearing:
//   - Master toggle defaults OFF (Loot Vision precedent) — a 4,780-mod
//     playthrough vacuuming the floor on first launch is a jump-scare.
//   - Operates ONLY on loose world item REFRs (items lying in the world) plus,
//     optionally, deferred dead-actor drops. It NEVER peeks an unopened
//     container's inventory (the levelled-loot trap — GetInventory on an
//     unopened container resolves its levelled lists early, a gameplay side
//     effect). Corpses are the sole inventory read, and only after a death
//     grace, deliberately (§overrides).
//   - Take path is C++ ActivateRef (mounts.cpp:415 precedent): the engine moves
//     the whole placed stack + its ExtraDataList on pickup of a placed ref, so a
//     single Activate handles count>1 and tempered/enchanted data. A plain
//     count-1 remainder (no extra data) is topped up with AddObjectToContainer.
//   - `dest` = a marked container ⇒ Activate to the player, then RemoveItem the
//     taken item player→destRef on the same task (pick up → forward). Dest
//     unresolvable ⇒ fall back to player and say so honestly.
//   - Never steals: IsOffLimits / a foreign GetOwner skips the ref (fired player
//     arrows exempt). `lootOwned` stays false and the UI never exposes true.
//
// Config struct is g_autoLootConfig in main.cpp (its own `autoLoot` slice, fully
// round-tripped through WriteConfigFile / PersistAll / load / reset). This header
// declares the ENGINE ops only; every one is MAIN-THREAD ONLY (the caller wraps
// it in SKSE::GetTaskInterface()->AddTask and holds g_configMutex where noted).
namespace AutoLoot
{
	// The config as the poller/scan reads it, snapshotted once under g_configMutex
	// by the host's provider (the ContainerSort::SetConfigProvider precedent) so
	// the engine loop never touches g_autoLootConfig — the snapshot IS the lock
	// discipline. Mirrors the `autoLoot` slice fields owned in main.cpp.
	struct Snapshot
	{
		bool          enabled = false;
		float         radius = 400.0f;
		std::string   dest = "player";  // "player" | "<markId>"
		bool          questGuard = true;
		bool          toastRare = true;
		std::int32_t  valueFloor = 250;
		bool          corpses = true;
		bool          lootOwned = false;  // always false — never steal
		// Tell the Loot Highlighter that a corpse we emptied is looted, so its
		// glow dies (LootHighlight::NoteLooted). Default ON. Only fires on a
		// body we actually TOOK from: a corpse whose contents were all filtered
		// out still holds loot a hand-search would want, and killing its glow
		// there would hide it.
		bool          clearGlow = true;
		// Per-category pickup toggles (§1.3 keys). `keys` defaults FALSE and
		// `lockpicks` TRUE because those two were SPLIT OUT of the original
		// eleven: keys were hard-skipped (quest/door keys), lockpicks rode the
		// "coins" always-want tier — so these defaults reproduce the behaviour a
		// pre-split config had, which is what a config without the keys must do.
		bool coins = true, gems = true, potions = true, food = false, ingredients = true,
			 soulgems = true, scrolls = true, ammo = true, books = false, valuables = true,
			 gear = false, keys = false, lockpicks = true;

		// ---- per-item rules (Rober, 2026-08-16) --------------------------------
		// One item, durably identified the way the Item Explorer identifies it:
		// owning plugin + the local FormID under that file's width (ESL-safe).
		// NEVER a raw runtime FormID — that is not stable across load orders.
		struct ItemRef
		{
			std::string   plugin;
			std::uint32_t localId = 0;
		};

		// Precedence, and it matters: DENY beats everything, then ALLOW overrides
		// the category + value gates, then the ordinary category rules run. What
		// allow does NOT override: ownership (never steal), the quest guard, and
		// the worn-gear skip on a corpse — an allow entry is "I want this item",
		// never "commit a crime for it".
		std::vector<ItemRef>     deny, allow;
		// Case-insensitive name substrings, the family form of the same two lists
		// ("daedric" catches every piece without listing 40 forms).
		std::vector<std::string> denyWords, allowWords;
		// Exclusive mode: take ONLY what the allow list/words match. Off, the
		// allow list is an override on top of the categories.
		bool allowOnly = false;

		// ---- LOTD museum rule (Rober, 2026-08-17) -------------------------------
		// "only pickup items you don't already have picked up and or in the
		// museum (both those)". The membership test already existed here for the
		// rare-item toast; this turns it into a PICKUP rule.
		//
		// The gate is TCC's own runtime model, not a static list we maintain:
		// dbmNew holds every displayable item the player does not yet have, and
		// TCC's inventory monitors move a form to dbmFound on pickup and dbmDisp
		// once displayed. So "still wanted" is exactly
		// `new && !found && !disp` — which answers BOTH halves of the ask in one
		// test, because an item already picked up or already on a museum shelf has
		// left dbmNew's wanted state by TCC's own bookkeeping.
		//
		//   Off    — LOTD plays no part (what every existing config does).
		//   Always — a still-wanted piece is taken even when its category is off
		//            or it sits under a value floor. An OVERRIDE, ranking with the
		//            allow list; a duplicate you already own just falls through to
		//            the ordinary rules.
		//   Only   — take NOTHING but still-wanted museum pieces. The literal
		//            reading of the ask, and the museum-run mode.
		//
		// Absent TCC (no DBM_RelicNotifications.esp) every mode degrades to Off
		// rather than to "take nothing": a museum filter that silently empties the
		// vacuum on a load order without the museum would read as broken.
		enum class Lotd
		{
			Off = 0,
			Always,
			Only
		};
		Lotd lotd = Lotd::Off;

		// Per-category gold floor, key -> minimum value. Absent/0 = no floor for
		// that category. The global `valueFloor` remains the default for the two
		// historically value-gated buckets (valuables, gear) when they have no
		// entry here, so an old config keeps behaving identically.
		std::map<std::string, std::int32_t> catFloors;

		// Carry-weight guard: stop taking at >= weightPct% of capacity, so the
		// vacuum cannot walk you into permanent over-encumbrance. Checked per
		// tick AND before each take (one heavy item can cross the line).
		bool         weightGuard = true;
		std::int32_t weightPct = 90;

		// ---- place rules (Rober, 2026-08-16) -----------------------------------
		// "probably be smart to not autoloot homes". A whole SCAN is refused by
		// where the player is standing, before any ref is examined — cheaper than
		// a per-ref test and it means the honest answer to "why did nothing get
		// picked up here" is one line the UI can state.
		//
		// homeGuard: skip any cell the PLAYER OWNS. That is the engine's own
		// definition of "your house" — a bought home's cell is owned by a faction
		// you were added to (Breezehome/Hjerim/…), and Hearthfire houses are owned
		// outright — so it covers vanilla and Hearthfire without a hardcoded cell
		// list. A mod home the detection misses is exactly what areaDeny is for.
		bool homeGuard = true;
		// Explicit per-place rules, keyed by CELL the same durable way Domains and
		// Room Guard key theirs (owning plugin + local FormID under that file's
		// width). Mirrors the item rules on purpose — same shape, same precedence
		// vocabulary, so the UI and the mental model are the one thing.
		// ⚠ An EXTERIOR cell is one grid square, not "the region": marking a spot
		// in the wilderness covers that square only. Interiors (the case this was
		// built for) are the whole place.
		std::vector<ItemRef> areaDeny, areaAllow;
		// Exclusive mode: run ONLY inside a listed allow area. Off, areaAllow is
		// an override that re-permits a place homeGuard would otherwise refuse.
		bool areaAllowOnly = false;

		// ---- when it may run (2026-08-17, adopted from SmartHarvestSE) --------
		// Three answers to "not right now" that the place rules cannot express,
		// because they are about the PLAYER's situation, not where they stand.
		// They are checked BEFORE the area lists and they beat an allow-listed
		// place: "don't loot mid-fight" is a safety rule, and a cell being on a
		// list is not consent to vacuum during a dragon attack.
		//
		// All default OFF: an existing config must keep behaving exactly as it
		// did, and each of these can look like auto-loot has broken if it turns
		// itself on without being asked.
		bool pauseInCombat = false;
		bool pauseWeaponDrawn = false;
		bool pauseConcealed = false;  // invisible — you are sneaking for a reason

		// Population guard. The value names the SMALLEST class where looting is
		// refused, and every larger class is refused too — so Settlements is the
		// strictest and Cities the loosest, which is SmartHarvest's own ordering
		// and the one that matches how people describe it ("not in towns").
		// Detected from the current LOCATION's keywords, walking the parent
		// chain, so a mod's city with the vanilla keywords is covered free.
		enum class Towns
		{
			Off = 0,      // loot anywhere
			Settlements,  // refuse in settlements, towns and cities
			Towns,        // refuse in towns and cities
			Cities        // refuse in cities only
		};
		Towns townGuard = Towns::Off;

		// ---- how far, and how often -------------------------------------------
		// A separate indoor reach, because the radius that feels right crossing a
		// field reaches through three rooms in a barrow. 0 = use `radius`.
		std::int32_t radiusIndoors = 0;
		// Vertical squash, applied to the effective radius on the Z axis only.
		// 1.0 = the plain sphere we have always used; 0.35 keeps a scan on your
		// own floor instead of pulling loot through the ceiling. Never 0 — a
		// perfectly flat disc would drop items on a slope you are standing on.
		float verticalFactor = 1.0f;
		// Clamp the reach to the nearest DOOR, so the vacuum stops at the room
		// you are in rather than emptying the one beyond it. Costs one extra
		// (cheap, type-test-only) pass over refs in range, so it is opt-in.
		bool doorClamp = false;
		// Scan cadence. The poller wakes every 500 ms regardless; these make Tick
		// skip until enough time has passed, which is where the cost actually is.
		// 0 indoors = use the outdoor figure.
		std::int32_t intervalMs = 500;
		std::int32_t intervalIndoorsMs = 0;

		// ---- harvesting (2026-08-17, adopted from SmartHarvestSE) -------------
		// Plants, fungi and the harvestable "trees" (wall fungus, hanging moss).
		// Both TESFlora and TESObjectTREE derive from TESProduceForm, so the
		// engine tells us what a plant WILL give before we touch it — which is
		// what lets the produce go through the ordinary item rules instead of
		// needing a parallel set: the Ingredients category, the value floors,
		// deny/allow, and even the museum rule all apply unchanged.
		//
		// The verb is the same ActivateRef a player pressing E uses, so scripted
		// plants (Hearthfire planters, mod flora) run their own scripts exactly
		// as they would by hand.
		//
		// Off by default like every other guard. Ownership is ALWAYS checked:
		// a farm's crops and a Hearthfire garden are owned, and a vacuum that
		// quietly made you a thief for walking past a cabbage patch would be a
		// trap rather than a feature.
		bool harvestFlora = false;

		// ---- worth the weight (2026-08-17, adopted from SmartHarvestSE) -------
		// A flat gold floor cannot tell a 60-gold ring from a 60-gold iron
		// warhammer, which is how a vacuum walks you into over-encumbrance while
		// technically obeying its rules. A value-per-unit-weight ratio can.
		//
		//   vwRatio > 0            take a WEIGHED item only when value/weight
		//                          reaches this. 0 = off, the old behaviour.
		//   weightlessMinValue > 0 a weight-0 item is judged by value alone —
		//                          the ratio is meaningless there (it divides by
		//                          zero), and gold, keys and ammo all live here.
		//
		// Both sit inside the ordinary-rules branch, so an allow-list entry, the
		// museum rule and the unknown-ingredient override all still beat them:
		// they shape what the CATEGORIES sweep up, not what you asked for by name.
		float        vwRatio = 0.0f;
		std::int32_t weightlessMinValue = 0;

		// Always take an ingredient whose effects you have not all learned yet —
		// an override, because discovery is the point and a 1-gold mushroom you
		// have never eaten is worth more than its price. Known ingredients fall
		// through to the ordinary rules.
		bool unknownIngredients = false;

		// ---- ore veins and critters (2026-08-17) ------------------------------
		// Identified by the engine's OWN activation prompt — "Mine", "Catch" —
		// read through TESBoundObject::GetActivateText and cached per BASE FORM,
		// so the cost is one virtual call per distinct kind of thing rather than
		// per reference. That is the trick SmartHarvestSE uses (its MCM ships
		// localized regexes for exactly these verbs), and it means a mod's own
		// ore vein or critter is recognised without knowing anything about it.
		//
		// Unlike a plant, neither one can be judged before the fact: an ore
		// vein's yield lives in a Papyrus property and a critter's in its script.
		// So these get their own switches instead of riding the item rules, and
		// both are OFF by default — mining in particular plays an animation and
		// is loud.
		bool harvestCritters = false;
		bool mineOre = false;
		// Refuse to mine with no pickaxe. Without it the vanilla script simply
		// tells you that you need one — every sweep, which is notification spam
		// rather than a feature.
		bool miningNeedsPick = true;
		// Strikes at one vein per sweep. A vein yields per activation, so an
		// uncapped sweep empties it in a blink and the animation never catches up.
		std::int32_t maxMineStrikes = 2;
	};

	// Why a scan was refused before it started, so the view can say it plainly
	// instead of showing an enabled vacuum that silently does nothing.
	enum class Block
	{
		None = 0,
		Home,        // homeGuard: a cell the player owns
		AreaDenied,  // this cell is on the never-here list
		NotAllowed,  // areaAllowOnly and this cell is not on the allow list
		Combat,      // pauseInCombat and the player is fighting
		Drawn,       // pauseWeaponDrawn and a weapon/spell is out
		Concealed,   // pauseConcealed and the player is invisible
		Populated,   // townGuard and this is a settlement/town/city
	};

	// Resolve a dest markId → a live container ref (nullptr for "player" or an
	// unreachable id) + the human name. main.cpp installs this so auto_loot.cpp
	// never needs the ContainerMark struct. Returns {ref, name, exists}.
	struct DestResolve
	{
		RE::TESObjectREFR* ref = nullptr;  // nullptr = route to player
		std::string        name;           // display name of the marked container
		bool               known = false;  // the markId exists in config (vs "player")
		bool               reachable = false;  // resolved to a live container this frame
	};

	// main.cpp installs these at startup. `toggler` flips g_autoLootConfig.enabled
	// under the lock and returns the NEW value (ToggleMaster stays out of the
	// config struct this way — same split as the provider).
	void SetConfigProvider(std::function<Snapshot()> provider);
	void SetDestResolver(std::function<DestResolve(const std::string&)> resolver);
	void SetMasterToggler(std::function<bool()> toggler);

	// Called once near ContainerActions::Init / LootHighlight::Init (kDataLoaded).
	// Registers a save-load hook to clear the session looted-set; nothing else
	// engine-side by default.
	void Init();

	// The throttled poller body. Called every ~500 ms from AutoLootTickLoop
	// (clone of LootTickLoop) inside AddTask, under a g_configMutex snapshot. A
	// no-op unless master enabled && !GameIsPaused() && a valid player+cell
	// exists. Takes up to a small per-tick budget of loose refs, spreading a big
	// pile over several ticks. Emits the "auto-loot: picked " marker on a take.
	void Tick();

	// One-shot "loot around me now" (bindable action / alScanNow). Main thread.
	// Snapshots the config through the provider itself (so the caller does NOT
	// hold the lock). Returns count picked; builds the toast list internally and
	// writes a human summary into *outMsg.
	int ScanAndLootNow(std::string* outMsg);

	// Flip the master switch through the installed toggler (takes the lock
	// itself). Emits the "auto-loot: master " marker. Returns {ok,enabled,msg}
	// JSON for alResult; the CALLER persists after (PersistAll outside the lock).
	std::string ToggleMaster();

	bool IsEnabled();

	// Clear the session looted / in-flight set. Hooked to save-load so a
	// reloaded world starts fresh (a just-Activated ref handle is meaningless
	// across a load). Main thread.
	void ClearLootedSet();

	// alStateData / alOpen payload (full config + live runtime state). Reads the
	// config through the same lock the caller holds; resolves dest name +
	// reachability live.
	std::string StateJson();

	// Seeded-action dispatch (kSeeds action verbs).
	bool IsToggleAction(const std::string& action);   // "auto-loot"
	bool IsScanNowAction(const std::string& action);  // "auto-loot-now"

	// ---- place rules support -------------------------------------------------
	// Identify the cell the player is standing in, for the "＋ This place"
	// button and the live "why isn't it looting here" line. Main thread.
	// Returns {ok, plugin, localId, name, interior, owned} JSON; ok:false with a
	// reason when there is no resolvable cell (main menu / mid-load).
	std::string HereJson();

	// Would a scan run right here? Evaluated against the snapshot's place rules
	// only — master/pause/weight are separate concerns. Main thread.
	Block PlaceBlock(const Snapshot& s);
}
