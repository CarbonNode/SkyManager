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
// The CATALOGUE is static data, not something the engine hands us: it is baked
// by tools/build_zap_catalog.py from the installed FNIS lists into
//   Data/PrismaUI/views/HotkeyDeck/zap-catalog.json
// C++ reads that file once at load and pushes it to the view in anOpen; the
// pane renders + searches it. Regenerate the JSON (and redeploy) when ZAP
// changes — it is ZAP-only for v1.
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
	//      anLog; replies anOpen/anResult/anTargetResult, all disjoint) --------

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

	// The seeded "crawl" action verb (bindable, also fired from the tab).
	bool IsAction(const std::string& a);
	bool Run(const std::string& a);  // main thread; false for an unknown verb
}
