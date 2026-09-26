#pragma once

#include <string>

// ---------------------------------------------------------------------------
// OStim scene → position pictogram, from the scene files themselves.
//
// Rober, 2026-09-21: "i think we should try to match keywords of animations and
// show specific icons for them", then "try to match icons betters".
//
// ── Why this exists at all ─────────────────────────────────────────────────
// The view can only see a scene's NAME and ID, and a survey of the 8,091 scene
// files installed on this rig showed that is not enough: the position is named
// ONLY in the scene's tags for 447 doggystyle, 358 oral, 260 missionary and 120
// reverse-cowgirl scenes. Name/id matching tops out at ~48% of the catalogue.
// OStim's Thread API exposes no tags (SceneSearchResult is {sceneId, name,
// actorCount}), so the data has to come from the files.
//
// Those figures are a historical survey, not current verified accuracy. The
// live response reports unique-scene coverage and invalid/conflicting records.
//
// ── The three vocabularies ─────────────────────────────────────────────────
// A scene JSON carries three independent signals, and NONE of them is
// sufficient alone:
//
//   tags[]              scene-level. Mostly author branding ("billyy",
//                       "funnybizness") and content flags ("aggressive",
//                       "necro"); only ~15 are positional. 400 scenes have none.
//   actors[].tags[]     the posture vocabulary — standing, kneeling, lyingback,
//                       allfours, bendover, ontop, facingaway, lyingside … the
//                       richest signal, but 1,464 scenes carry none (almost all
//                       of them the FunnyBiz pack, which tags at scene level).
//   actions[].type[]    the act — vaginalsex, blowjob, cunnilingus … 802 scenes
//                       have none, mostly transitions and idles.
//
// ⚠ ORDER MATTERS AND IS THE WHOLE ALGORITHM. An explicit position word (in
// tags or in the name) is tested BEFORE posture inference, because authors tag
// postures lazily: "Leito Bed Missionary" tags its actors standing/sitting.
// Where both signals fire they disagree 56% of the time.
//
// Specific collisions the order resolves, each measured:
//   · every 69 scene tags an actor allfours+facingaway → sixtynine must beat
//     doggy, or 39 scenes silently become doggy;
//   · reverse cowgirl before cowgirl;
//   · 524 standing+bendover scenes are doggy, not standing;
//   · explicit position words precede posture inference; the generic oral
//     inference (not the explicit-word branch) requires no penetration.
//   · the four furniture/posture additions require explicit phrases/tags:
//     face-sitting, bent-over-table, wall-behind and wheelbarrow. Generic
//     standing/chair metadata must never imply a more specific arrangement.
//
// Pure parsing/classification lives in scene_tags_model.h. All returned icon
// keys belong to its 24-key allowlist. Conflicting classifications for duplicate
// IDs are excluded from icons and listed in conflictedIds; consumers must not
// fall back to names for those IDs. Matching duplicates with the same icon are
// retained. A known match versus an unmatched copy also counts as conflicting.
//
// ── Cost and threading ─────────────────────────────────────────────────────
// ⚠ WORKER THREAD ONLY. This walks ~8,000 JSON files. It caches its result to
// Data/SKSE/Plugins/HotkeyDeck/scene-icons.json (the anim-scan.json precedent)
// and re-reads that instead on later launches; a rescan is explicit.
// ---------------------------------------------------------------------------

namespace SceneTags
{
	// { v:3, ok, cached, scanned, uniqueScenes, matched, invalid, duplicates,
	//   conflicts, conflictedIds:["<sceneId>", …], icons:{"<sceneId>":"doggy", …} }
	// scanned = all JSON files encountered; invalid = malformed/unreadable files;
	// duplicates = extra valid records beyond each first ID; conflicts = unique
	// IDs with disagreeing classifications; matched = icons.size(), not files.
	// Serves only a validated schema-3 cache. WORKER THREAD.
	std::string MapJson(bool rescan);

	// Independent, persistent artwork preferences (not the rebuildable index).
	// {ok:true, choices:{v:1,categories:{categoryId:iconId},scenes:{sceneId:iconId}}}
	// Set accepts {scope:"scene"|"category",key:string,icon:string}; empty icon resets.
	// Both perform file IO and must run on a worker. No engine state is changed.
	std::string ChoicesJson();
	std::string SetChoiceJson(const std::string& request);
}
