#pragma once

#include <string>

/*
 * Mounts — the stable (Rober, 2026-08-14: "A mounts tab. It needs to hook to
 * the actual NPC itself - some are controlled by spells or earned via a spell
 * so it would be cool if you could add spells as mounts in this menu and it
 * can auto-detect the npc it conjures").
 *
 * The WoW mount-journal shape: a searchable list of everything you can ride,
 * and per row the verbs that actually get you riding. Two kinds of mount:
 *
 *   "actor" — a horse (or any rideable beast) that EXISTS in the world,
 *             added by looking at it (the palette's crosshair snapshot).
 *             Stored as the REFERENCE's durable identity plus its BASE's,
 *             because the ref is what you call and the base is what you
 *             render. A summoned/dynamic ref has no durable ref identity;
 *             those rows resolve by scanning loaded actors for the base.
 *   "spell" — a summon: the spell's durable identity plus the NPC it
 *             conjures, AUTO-DETECTED from the spell's own record (the
 *             kSummonCreature effect's associatedForm — no guessing, the
 *             engine's own data). A script-driven summon the record can't
 *             see keeps an empty NPC and says so honestly.
 *
 * "Ride" is the headline verb and it is one press end-to-end: an actor mount
 * is brought to you and activated (activation IS how the engine mounts — the
 * same thing pressing E on a horse does, so every mount framework's own
 * mount-handling runs untouched); a spell mount is cast, then the conjured
 * NPC is watched for by base identity and activated the moment it lands.
 *
 * Bodies render through the Mesh Rendering Framework route item icons proved
 * (ItemIcons::EnsureBodyIcons): the NPC's race-skin ARMA biped NIF — the
 * Dragon Roost precedent — at 512px into icons/mounts/, with a 45°-step
 * turntable (CaptureBodyAngles) so the big preview can be dragged around.
 *
 * Storage is mounts.json BESIDE hotkeys.json, owned entirely by this module
 * (atomic write + .bak). Deliberately NOT a hotkeys.json slice: a config
 * slice is silently dropped by any older DLL's save (the pre-v0.15 shelf
 * lesson), and DLLs from parallel sessions rotate often on this rig — a
 * separate file cannot be clobbered by a build that has never heard of it.
 *
 * Threading: every function here except ToJson/FromJson touches engine
 * structures and must be called from an SKSE task on the main thread (the
 * NpcFinder contract). The module has its own mutex for the file-backed
 * state only.
 */
namespace Mounts
{
	// {"mrf":bool,"count":N,"riding":{...}|null,
	//  "categories":[{id,name}],                       user categories, in order
	//  "prefs":{...},                                   free-form view prefs (e.g.
	//                                                   pickerSort) — round-tripped
	//                                                   verbatim, unknown keys kept
	//  "mounts":[{id,kind,name,fav,cat,note,race,plug,img,known,loaded,dead,
	//             near,riding,spName,npKnown}]}         cat = "" is uncategorised
	// First call loads mounts.json.
	std::string StateJson();

	// The add-summon candidate roster. Rebuilt from scratch on EVERY call — the
	// picker asks on each open (and on the manual ⟳), so a spell learned this
	// session shows up and every row's known-flag is a live player->HasSpell at
	// build time. It is a cheap in-memory pass (the spell form arrays are
	// already resident), so per-open is the right cadence, no cache to go stale.
	// NOT just the spells you already know: every KNOWN spell (known:true) PLUS
	// obvious catalogue candidates drawn from the whole load order (known:false)
	// — any spell with a summon / reanimate effect, any Conjuration-school
	// spell, and anything whose name or an effect name matches
	// summon|call|steed|mount|horse|conjure|raise.
	// Deduped by formId, each carrying the icon metadata (school/element/
	// archetype/tier/slot) so the picker can draw the real Spell-Hotbar art,
	// and the NPC its record says it conjures (null when a script does the
	// work — the honest "record hides what it conjures" case). This is what
	// makes a just-learned summon-horse spell — or one still sitting unread in
	// a tome — findable instead of invisible.
	// {"spells":[{plugin,localId,formId,name,school,element,archetype,tier,
	//             slot,known,np:{name,race,rideable,plugin,id}|null}]}
	std::string SpellsJson();

	// {"act":"addLook"|"addSpell"|"remove"|"fav"|"rename"|"note"|"spin"
	//        |"summon"|"call"|"ride"|"goto"
	//        |"catAdd"|"catRename"|"catDel"|"catReorder"|"setCat"
	//        |"setPref", "id":"m3", ...}
	//   -> {ok,act,found,msg,...}
	// setPref {key,value} stores one free-form view preference (e.g. the picker
	// sort) into prefs and saves — it touches no mount and never fails loudly.
	// Category verbs never touch a mount's own fields, and deleting a category
	// refiles its mounts to uncategorised — a category is a label, never a
	// container of the thing labelled.
	// summon/call/ride/goto only RESOLVE here: found=true means the caller
	// (main.cpp) closes the palette and calls ExecuteAction; found=false
	// carries the honest refusal for the still-open pane.
	std::string ActJson(const std::string& req);

	// The physical half (cast / move / activate), after ClosePalette().
	// Returns the notification text ("" = it notified on its own).
	std::string ExecuteAction(const std::string& req);

	// Queue body renders for every mount that lacks one (render-once rules
	// are ItemIcons'). Called from the mtState handler so art trickles in
	// while the tab is open.
	void EnsureRenders();
}
