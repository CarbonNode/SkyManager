#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Container Auto-Sort backend for the Hotkey Deck (Containers tab, cs* bridge).
//
// The half that does the ENGINE work: sweep the player's inventory into a
// rule-matching marked container ("Unload"), and distribute a designated
// drop-box inbox's contents across every rule-matching marked container
// ("Sort"). The CONFIG (rules on a mark, the sort options, pins, inbox id,
// respawn-safety verdicts) lives ON `ContainerMark` / `ContainerConfig` in
// main.cpp and round-trips through ContainerConfigTo/FromJson with the same
// carry-over discipline the `image` field already uses — a partial ctSave /
// portal replay that omits `rule` keeps the prior rule rather than wiping it.
//
// This header therefore declares only the operations that touch live game
// state — the taxonomy classifier, the match predicate, the batch moves, the
// respawn-safety verdict, and the state JSON. It reads/mutates g_contConfig
// under g_configMutex where noted; the CALLER (the cs* handlers in main.cpp)
// takes the lock, snapshots into locals, and does the engine work outside it.
//
// THREADING: every public function here is MAIN-THREAD ONLY. main.cpp wraps
// each call in SKSE::GetTaskInterface()->AddTask, exactly as it does for
// ContainerActions / NpcActions / LootHighlight. UnloadTo / SortDropBox take
// g_configMutex only long enough to SNAPSHOT rules+pins+inbox into locals, then
// release it before any RemoveItem — they never hold the lock across engine
// calls, and they never call PersistAll while holding it.
namespace ContainerSort
{
	// Mirrors the JSON `rule` on a mark. Owned by main.cpp on ContainerMark; this
	// mirror is what UnloadTo / SortDropBox snapshot to decide routing outside the
	// lock, so the engine loop never touches g_contConfig.
	struct SortRule
	{
		bool                     enabled = false;
		std::vector<std::string> types;                 // taxonomy tokens (see §4.1); ANY-of
		std::int32_t             minValue = 0, maxValue = 0;
		std::vector<std::string> keywords;              // BGSKeyword edid OR name-substring; ANY-of
		bool                     enchantedOnly = false;
		int                      priority = 0;          // manual tiebreak (higher wins)
	};

	// The respawn-safety verdict for a mark's resolved container ref. `acknowledged`
	// lives in the config, not here — EvaluateSafety computes only respawns+reason.
	struct SafeVerdict
	{
		bool        respawns = false;
		std::string reason;
	};

	// Crafting-loan settings (2026-08-17). The idea is borrowed from Arcane Vaults:
	// standing at a crafting station, the materials you own but left in a chest are
	// lent to you for the duration and put back when you step away — so a stocked
	// materials chest means you never haul ore to a forge again. Ours differs in
	// where it takes from: a mark only lends when its own `lend` flag is on, and it
	// obeys the same respawn-safety verdict every other routing path does.
	struct LoanOpts
	{
		bool enabled = false;     // master, default OFF (nothing moves until asked)
		bool smithing = true;     // forge / anvil / armour table / sharpening wheel
		bool smelting = true;     // smelter
		bool tanning = true;      // tanning rack
		bool cooking = true;      // cook pot / spit / oven
		bool alchemy = true;      // alchemy lab
		bool enchanting = true;   // arcane enchanter (soul gems)
		bool returnOnExit = true; // put back what is left when you step away
	};

	// One item's routing outcome, reported per container + the misses.
	struct MoveReport
	{
		int moved = 0, residue = 0;
		struct PerCont
		{
			std::string markId, name;
			int         count = 0;
		};
		std::vector<PerCont> byContainer;
		struct Skip
		{
			std::string name, reason;
		};
		std::vector<Skip> skipped;
		bool              refused = false;  // whole op refused (broken bag / no inbox)
		std::string       msg;
	};

	// One marked container as the engine loop needs it: durable identity, its rule,
	// and whether the user acknowledged an unsafe verdict. Built by the host's
	// provider under g_configMutex (the KeysScan::OwnBinding precedent) so the
	// engine loop below never touches g_contConfig — the snapshot IS the lock
	// discipline. `order` is the mark's index in the config array = the user's
	// manual arrangement, the second tiebreak key (§4.3).
	struct MarkSnap
	{
		std::string   id, name, category, plugin;
		std::uint32_t localId = 0;
		SortRule      rule;
		bool          safeAcknowledged = false;
		int           order = 0;
		// Crafting loan opt-in: this container lends its materials at a bench.
		// Independent of `rule.enabled` on purpose — a chest can be a lending
		// materials store without also being a sweep destination.
		bool          lend = false;
		// Physical redirect: activating THIS container in the world opens the mark
		// named here instead, and its crosshair prompt says so. "" = no redirect.
		// A barrel by the door becomes the mouth of the chest upstairs.
		std::string   redirectTo;
		// The mark as ContMarkToJson writes it — the payload ContainerActions::
		// OpenContainer needs (home cell + position + angle, which the fields above
		// deliberately do not duplicate). Filled by the provider; the redirect hook
		// hands it straight back so a redirected chest that has to be SUMMONED still
		// knows where to go home.
		std::string   markJson;
	};

	// A per-item classification override: this base form IS these tokens, whatever
	// the classifier would have said. Identity is (plugin, local FormID) — the
	// ESL-safe pair every other durable reference in the deck uses. Empty `types`
	// removes the override. Unlike a pin (which routes ONE item to ONE container
	// and overrides nothing else), an override changes what the item IS, so value
	// bands, keyword rules, the crafting loan and Gather all see the new answer.
	struct TypeOverride
	{
		std::string              plugin;
		std::uint32_t            localId = 0;
		std::vector<std::string> types;
	};

	// Everything a sweep/sort/state reads, snapshotted once under the lock.
	struct Snapshot
	{
		std::vector<MarkSnap> marks;
		std::string           inboxMarkId;                 // "" = no drop-box
		struct Pin
		{
			std::string   plugin, markId;
			std::uint32_t localId = 0;
		};
		std::vector<Pin> pins;
		bool             excludeEquipped = true;
		bool             excludeFavorited = true;
		bool             excludeQuest = true;
		bool             keepGold = true;
		// Close the drop-box's own transfer menu and it distributes itself — the
		// "conduit" idiom (fill it, walk away, it sorts). Default OFF: an automatic
		// bulk move is not something to spring on someone.
		bool             sortOnClose = false;
		LoanOpts         loan;
		std::vector<TypeOverride> overrides;
	};

	// main.cpp installs this at startup; called at op time — it takes g_configMutex
	// itself, so the callers here never hold the lock across engine work.
	void SetConfigProvider(std::function<Snapshot()> provider);

	// Register the two sinks this module owns: the ContainerMenu watcher (drop-box
	// sort-on-close) and the furniture watcher (crafting loan). Call once at
	// kDataLoaded, beside ContainerActions::Init(). Both sinks are inert unless the
	// matching option is on, so registering them costs nothing when unused.
	void Init();

	// main.cpp installs this so an op the USER did not press a button for — a
	// sort-on-close sweep, a crafting loan — can still report itself to the view
	// (csResult JSON) and the HUD. Called on the main thread.
	void SetResultSink(std::function<void(const std::string&)> sink);

	// The taxonomy the rule editor offers, as JSON:
	//   { groups:[{label, tokens:[{id,label,parent}]}] }
	// The view renders the chip picker from THIS, so the C++ classifier and the UI
	// can never drift apart (adding a token in one place is enough).
	std::string TaxonomyJson();

	// Unload: sweep the PLAYER's inventory into ONE marked container `markId` per
	// its rule. Guards: broken-bag guard (InventorySafeToRemove) first — refuse the
	// WHOLE sweep if the bag is dirty (a bulk move has no per-item equip fallback);
	// skip equipped/favorited/quest/gold per the sort options; respawn-safety per
	// §4.6 (un-acknowledged unsafe container refuses with a named reason).
	// `keep` leaves that many of each stack in the bag; `only` (> 0) moves at most
	// that many of each (the "put one copy away" verb). Both default to 0 = move
	// everything that matches.
	MoveReport UnloadTo(const std::string& markId, int keep = 0, int only = 0);

	// Put it all away: run the SAME routing pass the drop-box uses, but over the
	// PLAYER's inventory — every matching item goes to whichever marked container
	// its rules name, in one press, instead of one Unload per container. Residue
	// (anything no rule claims) stays in the bag, untouched. Same exclusions and
	// the same broken-bag refusal as UnloadTo.
	MoveReport SweepAll(int keep = 0, int only = 0);

	// Gather: pull matching items to the player from EVERY marked container that
	// is safe and reachable — the one-press "bring me every reagent I own". An
	// empty `types` is refused rather than emptying all your storage: Gather is a
	// filtered verb by definition (use Retrieve for a named container).
	MoveReport GatherAll(const std::vector<std::string>& types, int keep = 0);

	// Sort drop-box: read the designated inbox container's inventory (the ONE
	// sanctioned container-inventory read, §4.7 — a container the user deliberately
	// filled) and distribute each item to the first-matching enabled+safe marked
	// container (pin > keyword > type+value; §4.2). Residue stays in the inbox.
	MoveReport SortDropBox();

	// Retrieve: the other direction — pull a marked container's contents BACK to
	// the player. `types` empty = everything the container holds; otherwise only
	// items carrying one of those taxonomy tokens. `keep` > 0 leaves that many of
	// each stack behind (the "keep one for the display case" verb), so keep=1 on a
	// full retrieve is the idiomatic "take my spares". Reading the destination's
	// inventory is sanctioned here for the same reason the inbox read is: the user
	// asked for THIS container by name, on purpose (§4.7).
	MoveReport RetrieveFrom(const std::string& markId, int keep,
		const std::vector<std::string>& types);

	// Every taxonomy token a base form carries, AFTER any user override — the
	// single answer the whole module classifies by. Exposed so main.cpp can tell
	// the override editor what an item currently reads as. Main thread.
	std::vector<std::string> TokensForForm(const std::string& plugin, std::uint32_t localId);

	// Respawn-safety verdict for a mark's resolved container ref (§4.6). No
	// inventory read — resolves the ref, reads its cell + EncounterZone + owner.
	SafeVerdict EvaluateSafety(const std::string& plugin, std::uint32_t localId);

	// State JSON for csState (marks+rules+pins+inbox+opts+safe+playerGold). Reads
	// g_contConfig under the lock (caller does NOT hold it — this takes it itself).
	std::string StateJson();

	// Seeded-action dispatch. "sort-now" fires SortDropBox() when an inbox exists,
	// else notifies "designate a drop-box inbox first". The palette is closed by
	// the caller (SortDropBox needs the unpaused world). Returns a csResult JSON.
	bool        IsUnloadAction(const std::string& action);   // action == "sort-now"
	std::string RunUnloadAction();                           // main thread; ClosePalette is the caller's job

	// "put-it-away": the bindable twin of SweepAll, for a key press with no deck
	// open. Same main-thread + closed-palette contract as RunUnloadAction.
	bool        IsSweepAction(const std::string& action);    // action == "put-it-away"
	std::string RunSweepAction();
}
