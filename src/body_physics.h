#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

// 🫧 Body physics — CBBE 3BA (Nexus 30174, "3BBB.esp") integration for the F7
// quick-card Effects modal, plus the OSmp OStim bridge that rides the same
// machinery.
//
// WHAT 3BA'S TOGGLE ACTUALLY IS. 3BA ships every female body in two physics
// flavours: CBPC (cheap, per-bone, always on) and HDT-SMP (cloth simulation,
// expensive). The switch is an ARMOR the actor wears — an invisible object in
// biped slot 48/50/51/60 whose NIF carries the SMP config — plus a call that
// STOPS CBPC on the same bones so the two don't fight. The "cup" A/B/C/D picks
// which of four SMP configs the object carries. It is a JIGGLE PROFILE, not a
// size: 3BA's own MCM says "This does NOT affect breast size!" — A is the
// stiffest, C the bounciest, D the heaviest/most gravity. Nothing about the
// body mesh changes.
//
// HOW WE DRIVE IT. Never by reimplementing the equip: every write goes through
// the mod's OWN Mus3BAddonMCM functions over the Papyrus VM, so its slot
// setting, its gender rule and its CBPC hand-off all apply exactly as the mod
// intends — the follower_frameworks / effects_actions law.
//   on / set cup  -> CupNum := n, then AddNPCSMP(actor)   (purely additive:
//                    returns early if already at that cup, else strips all 16
//                    objects and equips the new one — no toggle ambiguity)
//   off           -> RemoveSMP(actor, false)              (strips all 16 and
//                    hands the bones back to CBPC, whatever slot she wore)
//   player        -> PlayerSMP()                          (its own P-objects,
//                    no cup — the player has one SMP variant)
// AddNPCSMP is chosen over the mod's own NPCSMP() deliberately: NPCSMP is a
// TOGGLE guarded by a Papyrus state (`GoToState("BlockedEvents")`), so "set her
// to C" would turn her off when she was already C, and a burst of calls would
// silently no-op mid-state. The additive pair is deterministic.
//
// EVERYTHING HERE IS MAIN-THREAD-ONLY (it reads worn inventory and dispatches
// to the VM); the fx* bridge handlers in main.cpp already AddTask us there.
namespace BodyPhysics
{
	// The `body` block EffectsActions::StateJson rides on fxState. Shape:
	//   { present, available, reason?, isPlayer, mode:"smp"|"cbpc",
	//     cup, cupLabel, defaultCup, slot, wornSlot, slotStale, stranded,
	//     blocked?, cups:[{n,label,detail}], parts:[{key,label,on}], partsOn,
	//     osmp:{ present, disabled, keepNpc, keepPlayer, autoCup, weights } }
	// `present`   = 3BBB.esp is in the load order (the view shows the tab)
	// `available` = its MCM quest bound and the 16 switch objects resolved
	// `stranded`  = she CARRIES a switch object that nothing is wearing (an
	//               outfit in the same biped slot knocked it off) — physics is
	//               CBPC right now even though 3BA's own count would say SMP.
	nlohmann::json BodyJson(std::uint32_t formId);

	// Ids the view sends back through fxSet, all prefixed "3ba:":
	//   "3ba:physics"      + on  -> SMP on (at the default cup) / off
	//   "3ba:cup:<0-3>"          -> apply that cup (works from on or off)
	//   "3ba:osmp:<key>"   + on  -> one OSmp toggle (disable|keepNpc|
	//                               keepPlayer|autoCup)
	// Returns the effects reply shape { ok, msg, id, on }.
	std::string Apply(std::uint32_t formId, const std::string& id, bool on);
}
