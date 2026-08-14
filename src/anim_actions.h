#pragma once

#include <cstdint>
#include <string>

// ---------------------------------------------------------------------------
// Animations tab — a ZaZ Animation Pack (ZAP) player for the Hotkey Deck.
//
// The ask (Rober, 2026-08-05, out of the Leash Framework crawl thread): a
// searchable, categorized deck tab that APPLIES an animation to the crosshair
// NPC (or the player) on demand — ZAP's own catalogue, "with its categories
// etc. and ability to apply". This is the standalone-tab realisation of that.
//
// HOW IT APPLIES
// --------------
// A ZAP idle is a FNIS animation event registered in the behaviour graph (the
// FNIS_ZaZAnimationPack_List.txt entries). Playing one is a single
//   actor->NotifyAnimationGraph("<AnimEvent>")
// — the engine-direct equivalent of Papyrus Debug.SendAnimationEvent, and the
// exact idiom the deck already uses for IdleForceDefaultState / the ground-sit
// idle in npc_actions.cpp. Reset is NotifyAnimationGraph("IdleForceDefaultState").
//
// The CATALOGUE is two-layered (v2, 2026-08-13 — Rober: "search in game for
// other mods and persistently populate an organized list of animations for
// your LO"):
//   1. The BAKED layer — tools/build_zap_catalog.py output in
//      Data/PrismaUI/views/HotkeyDeck/zap-catalog.json. Hand-curated category
//      maps for ZaZ + Halo; read once at Init, unchanged.
//   2. The SCANNED layer — an in-game load-order scan. Scan() walks
//      Data/meshes/actors/character/animations/<Pack>/FNIS_<Pack>_List.txt
//      through the MO2 VFS (FNIS lists are always loose — the generator needs
//      them on disk), parses them with the same type rules the baker uses, and
//      auto-categorizes by event-prefix. Lists the baked layer already covers
//      are skipped (basename match against the baked doc's "lists" array), so
//      ZaZ/Halo stay curated. Results + per-pack enabled flags persist in
//      Data/SKSE/Plugins/HotkeyDeck/anim-scan.json (the item-explorer.json
//      sidecar precedent; the write lands in MO2 Overwrite) — scan once, keep
//      it across sessions, Rescan refreshes.
// OpenJson merges layer 1 + the ENABLED packs of layer 2 and recomputes the
// category tally, so the pane needs no knowledge of where a row came from.
// ⚠ Honest limit: a list present on disk but never run through FNIS/Nemesis
// yields events the behaviour graph doesn't know — the apply is then a silent
// no-op. We cannot detect registration; the pane says so in the packs card.
//
// TARGET is whoever the deck snapshotted under the crosshair
// (NpcActions::TargetFormID()); with nothing targeted the animation plays on
// the player, so "look at nothing, apply" poses yourself.
//
// CRAWL (a moving crawl, separate from normal sneak) is folded in here as a
// toggle: the crawl OAR replacer is gated on a deck-owned faction
// (HotkeyDeckWardrobe.esp | HD_CrawlFaction 0x900), and this toggle adds/removes
// the target from it and forces the sneak state the crawl clips live in. See
// anim_actions.cpp for the (in-game-unverified) forced-sneak caveat.
// ---------------------------------------------------------------------------
namespace AnimActions
{
	// kDataLoaded: load zap-catalog.json into memory, resolve the crawl faction.
	void Init();

	// kPostLoadGame: re-assert the forced sneak on everyone still in the crawl
	// faction (faction membership persists in the save; forced sneak does not).
	void OnPostLoadGame();

	// ---- bridge payloads (an* — requests anGet/anPlay/anReset/anState/anCrawl/
	//      anScan/anPack/anLog; replies anOpen/anResult/anTargetResult, all
	//      disjoint) ----------------------------------------------------------

	// anOpen: the whole catalogue + current target. Sent on palette open and on
	// anGet. { source, count, categories:[{name,count}], entries:[...], target }.
	std::string OpenJson();

	// anState reply (anTargetResult): just the live target block, so the pane can
	// refresh "applying to <who>" without re-shipping 870 entries.
	std::string TargetJson();

	// Apply an animation event to the current target. Returns {ok,msg} for anResult.
	std::string Play(const std::string& event);

	// Return the target to its default idle. Returns {ok,msg}.
	std::string Reset();

	// Toggle the moving-crawl on the current target. Returns {ok,msg,on}.
	std::string ToggleCrawl();

	// anScan: walk the load order's FNIS lists and rebuild the scanned layer.
	// Pure file IO — safe OFF the main thread (the handler runs it on a worker
	// so a 4,780-mod VFS walk never hitches the game). Preserves per-pack
	// enabled flags across rescans, saves the sidecar. Returns {ok,msg} for
	// anResult; refuses ({ok:false}) if a scan is already running.
	std::string Scan();

	// anPack: {"name":"<pack>","on":bool} — enable/disable one scanned pack and
	// persist. Returns {ok,msg}; the handler follows with a fresh anOpen.
	std::string SetPack(const std::string& payloadJson);

	// anUser: the pane's user-data blob — favorites + custom tabs (+ whatever a
	// newer view adds; the schema lives in anim-pane.js, C++ only round-trips
	// it). Persisted in Data/SKSE/Plugins/HotkeyDeck/anim-user.json (the
	// item-explorer sidecar precedent — NOT a hotkeys.json slice, so the
	// OnJsSave wholesale-replace trap can never eat it). OpenJson ships it back
	// under "user". Returns {ok,msg} with an EMPTY msg on success — a favorite
	// toggle must not toast.
	std::string SetUser(const std::string& payloadJson);

	// The seeded "crawl" action verb (bindable, also fired from the tab).
	bool IsAction(const std::string& a);
	bool Run(const std::string& a);  // main thread; false for an unknown verb
}
