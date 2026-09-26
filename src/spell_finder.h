#pragma once

#include <string>

/*
 * Spell Finder — the Finder's fourth roster (Rober, 2026-09-23, with the Cell
 * Finder open on "talk to imp": "add spells as searchable tab?").
 *
 * The Cell Finder's structural twin: one in-memory index over every SPELL,
 * POWER, ABILITY and SHOUT the load order ships, one search bar over it, and
 * the verbs a player actually wants from a spell list — learn it, forget it,
 * cast it, teach it to whoever you are looking at.
 *
 * Facts that shape it:
 *
 *  - TESDataHandler::GetFormArray<SpellItem>() is the WHOLE spell list at
 *    boot; TESShout is a separate form type (never a SpellItem), so shouts
 *    are walked from their own array and ride the same roster as kind
 *    "shout". Diseases, poisons and addictions are SpellItems too, and are
 *    deliberately not indexed: nobody searches a spell list for Ataxia.
 *  - Identity is (plugin, file-width-masked local FormID) — the ESL-safe pair
 *    every Finder roster uses — derived from the LOAD INDEX in the runtime id,
 *    never GetFile(0) (the Cell Finder's Bannermist lesson: an overridden
 *    record's GetFile(0) is the override, and LookupForm cannot find it there).
 *  - "Known" is a LIVE fact (Actor::HasSpell / HasShout) read per returned
 *    row and, for the Known/Unknown pills, per hit — never cached, because
 *    Learn changes it under the roster.
 *  - Casting reuses SpellActions::Cast, the deck's play-proven verb: main.cpp
 *    closes the palette first (a cast fires into the live world, not a paused
 *    one) and hangs the reopen on Cast's onDone, exactly as the Spell Deck's
 *    mdFire does. This module only RESOLVES a cast; it never fires one.
 *
 * Threading contract, exactly CellFinder's: every function touches engine
 * structures and must be called from an SKSE task on the main thread.
 */
namespace SpellFinder
{
	// {"phase":"ready","count":N,"pageSize":N,"plugins":[{n,c,k,l}],"target":{"name","formId"}|null}
	// — first call builds the index (logged with timing). `target` is the
	// crosshair actor snapshotted at palette open, so the view can say who
	// "Teach" would teach before anyone clicks it.
	std::string StateJson();

	// {"q","type":"all|spell|power|shout|ability|known|unknown","plugin","seq","offset","limit"} ->
	// {"seq","total","offset","items":[{id,n,e,k,s,el,ar,t,d,c,cost,hs,kn,p}]}
	//   id   = "Plugin.esp|HEX6" (durable identity, the deck idiom)
	//   n    = full name; e = editor id when the form kept one, else ""
	//   k    = kind: spell | power | lesser | voice | ability | shout
	//   s/el/ar/t = school / element / archetype / tier (the Spell Deck's icon keys)
	//   d    = delivery: self | touch | aimed | target | location
	//   c    = casting: fire | concentration | constant
	//   cost = magicka cost for YOU right now (0 for shouts and abilities)
	//   hs   = hostile (the game would treat casting it at someone as an attack)
	//   kn   = you know it right now (live)
	//
	// DETAIL PATH (the Finder idiom): {"detail":"Plugin.esp|HEX6","seq"} is
	// answered through the SAME sfResultData reply as {seq, detail, info} —
	// info carries the live facts the index walk never touches: the effects
	// with their numbers, the auto-generated description, the shout's words,
	// and whether the crosshair actor knows it.
	std::string QueryJson(const std::string& req);

	// {"act":"learn|forget|teach|cast","id"} -> {ok,act,msg[,cast:{plugin,localId,formId}]}
	// learn / forget / teach are done here and reported. cast only RESOLVES:
	// ok+cast means the caller closes the palette and fires SpellActions::Cast.
	std::string ActJson(const std::string& req);

	// {"pageSize"?} -> {ok, pageSize}. Persists to the module's own sidecar
	// (Data/SKSE/Plugins/HotkeyDeck/spell-finder.json) — never a hotkeys.json
	// slice. Unknown keys already in the sidecar survive. Bridge: sfSave -> sfSaved.
	std::string SaveJson(const std::string& req);
}
