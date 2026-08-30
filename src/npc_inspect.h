#pragma once

#include <string>

// ===========================================================================
// INSPECT CARD — look at anyone and see what they actually are.
//
// Rober, 2026-08-17: "Keep polishing adding features we missed from the
// reference mod." The reference is Skyrim Party Sheet (Nexus SSE 167538) and
// the headline thing it has that we did not is NPC INSPECTION: point at
// someone and read the numbers the game never shows you — their real health
// pool, their resistances, what their weapon actually hits for, what is
// running on them right now, and what they are wearing.
//
// This is the LIVE ACTOR's answer, not the base record's. The NPCs tab already
// had a "detail" block (npc_finder.cpp, 2026-08-15) and that block reads
// TESNPC: the record as the mod author wrote it. It is the right answer to
// "who is this person in the load order" and the WRONG answer to "what am I
// fighting" — a levelled bandit's record says level 1 and 0/0/0 attributes,
// while the one swinging at you is level 48 with 700 health, a fortified axe
// and three active poisons. Everything here comes off RE::Actor, so mod-added
// perks, SPID-distributed abilities, an enchanted helmet and a drunk buff are
// all already in the numbers.
//
// WHAT IT ANSWERS
//   * identity   name, race (+ EditorID), class, sex, level, voice, combat style
//   * flags      dead · essential · protected · unique · hostile to you ·
//                your teammate · in combat · a ghost · summoned
//   * pools      health / magicka / stamina as {cur,max} — max is the
//                PERMANENT value (base + permanent modifiers), the number the
//                bar is drawn against, exactly the split char_sheet.cpp uses
//   * regen      points per second for each pool, derived the way the engine
//                stores it (see Shared::RegenJson)
//   * resist     the six resist actor values as percentages, the raw armour
//                rating, and what that rating BUYS — with the real caps, so a
//                meter is drawn against 85 for magic and 80 for physical
//                rather than a made-up 100
//   * combat     what their equipped weapon hits for, its speed and reach,
//                their move speed and their unarmed damage
//   * ai         aggression / confidence / morality / assistance / energy /
//                mood — the hidden dispositions that decide whether they will
//                fight you, run, or help. Nothing in Skyrim's UI shows these
//                and they are the single most useful thing about inspecting a
//                stranger; each ships with the engine's own word for the value
//   * equip      nine fixed tiles (head, body, hands, feet, amulet, ring,
//                right, left, ammo) with armour / damage / enchant badges
//   * effects    every active effect on THEM: name, source, magnitude, timer,
//                pile (buff/debuff/disease/poison/constant) and where it came
//                from
//   * social     your relationship rank with them (the RELA record), their
//                factions with rank, and MARAS's marital view when installed
//   * traits     what KIND of thing they are, off the engine's own actor-type
//                keywords — undead, daedra, dwarven, animal, dragon — plus
//                vampire / werewolf. This is the honest, load-order-independent
//                half of what Know Your Enemy 2 would tell you; see the KYE2
//                note in npc_inspect.cpp for why the rest is deliberately not
//                here.
//
// WHERE THE ENGINE FACTS CAME FROM. Which actor value, which formula and which
// call spelling were checked against Skyrim Party Sheet's MIT-licensed source
// (ActorStats.cpp, InspectCard.cpp, EquipmentStatResolver.cpp,
// WornGearStatResolver.cpp), which builds on the same CommonLibSSE-NG we do —
// so every call named here is proven to compile and to be the right question.
// Those are facts about Skyrim's engine, not their expression: no text is
// copied, the payload shape is ours, and the presentation is entirely
// npcs-pane.{js,css}'s. The MIT notice is recorded in the session report.
//
// SHARED WITH THE CHARACTER SHEET. char_sheet.cpp answers the same questions
// about the PLAYER and grew its own private copies of the resist maths, the
// regen derivation, the enchant-badge reader and the effect classification on
// 2026-08-17. Two copies of a formula is how they drift, so the actor-generic
// versions live HERE, in NpcInspect::Shared, and char_sheet's private twins
// should be deleted in favour of them the next time that file is opened (a
// mechanical swap — the player is just an Actor). Until then this header is
// the canonical statement of each formula and carries the reasoning.
//
// THREADING: everything here touches RE:: structures (the actor, ProcessLists,
// the magic-target list, the data handler), so it is MAIN THREAD ONLY —
// schedule through SKSE::GetTaskInterface()->AddTask, exactly like the NPC
// Finder's own handlers. Nothing here takes a lock and nothing here writes.
// ===========================================================================
namespace NpcInspect
{
	// The bridge. Request `niInspect`, reply pushed as `niInspectData` — the
	// two names are DISJOINT per the deck law ([[prismaui-one-name-per-
	// direction]]: a name used for both directions silently unplugs the
	// control).
	//
	// Request, any ONE of:
	//   {}                              inspect whoever was under the crosshair
	//                                   when the palette opened
	//   { "id": "Plugin.esp|HEX6" }     inspect that Finder row's person — the
	//                                   loaded world is scanned for a live
	//                                   reference of that base (levelled spawns
	//                                   included, via the template chain)
	//   { "ref": "0x00014B29" }         inspect that exact reference
	// plus an optional { "seq": N } which is echoed back, so a reply from an
	// older click can be dropped by the view.
	//
	// Reply is always well formed and always carries `ok`:
	//   { ok:false, why:"nothing"|"object"|"gone"|"unloaded"|"nosave",
	//     msg:"<a sentence you can put on screen>", seq:N }
	//   { ok:true, seq:N, src:"crosshair"|"id"|"ref", who:{…}, pools:{…},
	//     regen:{…}, resist:{…}, combat:{…}, ai:{…}, skills:[…], equip:[…],
	//     effects:[…], social:{…}, traits:[…] }
	//
	// A refusal is a SENTENCE, never an empty card: "Nothing in your crosshair",
	// "That is a chest, not a person", "Nobody by that name is loaded right now
	// — bring them to you first". MAIN THREAD ONLY. Never throws: a missing
	// player, a null actor or a half-built record degrades to a refusal or to a
	// section left out, not to a crash.
	std::string InspectJson(const std::string& reqJson);

	// ---------------------------------------------------------------------
	// The formulas, actor-generic and stated ONCE. Public so char_sheet.cpp
	// can adopt them (see the header note above) and so a future card — a
	// follower dossier, the HUD — cannot quietly invent a second version.
	//
	// All of these take a live RE::Actor and are MAIN THREAD ONLY. The
	// nlohmann::json return type is spelled through the pch's `json` alias
	// exactly as every other module here does; the declarations live in the
	// .cpp to keep this header free of the RE:: and json includes.
	// ---------------------------------------------------------------------
	namespace Shared
	{
		// "Health", "Fire resist", "One-Handed"… — what one actor value is
		// CALLED on a badge or an effect row. Deliberately partial: it covers
		// what an enchantment or an effect can plausibly touch and answers ""
		// for anything else, so a caller falls back to a generic mark rather
		// than printing a made-up label. (char_sheet.cpp::AvLabel is the twin.)
		const char* AvLabel(int actorValue);

		// Is that actor value expressed as a PERCENTAGE on an enchantment
		// ("25%") rather than as flat points ("+25")? Resists and every
		// *Modifier / *Rate variant are percentages; the pools and the base
		// skills are points. Getting this wrong is how a +25 Health amulet
		// claims "25% Health". (char_sheet.cpp::AvIsPercent is the twin.)
		bool AvIsPercent(int actorValue);

		// Skyrim's physical damage reduction, in percent:
		//     clamp(armourRating * 0.12 + 3 * wornArmourPieces, 0, 80)
		// The per-piece term is why the worn-armour census exists at all, and
		// 80 is the engine's own hard cap. `pieces` counts WORN, non-clothing
		// armour in the four armour slots (head, body, hands, feet) — the same
		// four the engine's bonus applies to.
		double PhysFromArmor(double armorRating, int pieces);

		// The caps a resist meter must be drawn against. Magic tops out at 85
		// in vanilla, not 100; the elemental and physical resists at 80.
		inline constexpr int kCapMagic = 85;
		inline constexpr int kCapPhys = 80;
	}
}
