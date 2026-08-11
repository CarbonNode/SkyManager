#pragma once

#include <cstdint>
#include <string>

namespace RE
{
	class Actor;
}

// ---------------------------------------------------------------------------
// Follower-framework awareness for the deck's native NPC actions.
//
// THE BUG THIS EXISTS FOR (found 2026-08-02)
// ------------------------------------------
// "freeze" / "sit" / "bed" act on the ACTOR: SetRestrained, SetDontMove,
// SpeedMult 0, and a furniture idle. That is enough for a townsperson, and it
// is NOT enough for a companion driven by her own follower framework, because
// a package instanced on a QUEST ALIAS outranks anything applied at actor
// level. The framework's follow package keeps winning the package stack, the
// companion walks after the player through the door, and the deck reported
// success — a silent no-op, which is the worst possible answer.
//
// Concretely: Amaniri (Nether's Amaniri, NWS_Amaniri.esp) and Vayne (Vayne
// Remastered, CSV_Vayne.esp) both run their own controller quest, and both
// ignored the hold.
//
// WHAT THIS DOES
// --------------
// 1. Probe()  — asks the ENGINE whether the actor is alias-driven and whether
//               one of those alias packages is a follow/escort/accompany, and
//               names the framework when the owning plugin is one we know.
// 2. SendWait()   — dispatches that framework's OWN "wait here" through the
//                   Papyrus VM, so the order arrives by the same door the
//                   mod's own dialogue uses and the alias package steps aside.
// 3. SendResume() — the matching "follow me again", so a release really does
//                   release.
// 4. Whatever is left over is REPORTED. A framework we have no mapping for
//    gets an on-screen "use her dialogue" notice instead of a fake success.
//
// The table lives in follower_frameworks.cpp and is pure data — adding a
// framework is four strings and an argument shape, no new logic.
// ---------------------------------------------------------------------------
namespace FollowerFrameworks
{
	struct Detection
	{
		// The actor currently fills at least one quest alias.
		bool aliasDriven = false;

		// One of those alias-instanced packages (or the package the actor is
		// running right now) is a follow / escort / accompany. This is what
		// makes an alias "a follower framework" rather than "a shopkeeper in a
		// quest".
		bool followPackage = false;

		// A table entry matched, so SendWait()/SendResume() can actually do
		// something.
		bool known = false;

		// Index into the spec table, or -1. Persist THIS (not a pointer) if you
		// need to resume later.
		int spec = -1;

		// Human label for the matched framework ("Nether's Amaniri"), empty
		// when unknown.
		std::string label;

		// The plugin that identified it, or — when unknown — the plugin of the
		// alias quest that looks the most framework-like. May be empty.
		std::string plugin;

		// True when the actor is being driven by a follower framework we have
		// NO native wait for. This is the case that must be said out loud.
		bool NeedsWarning() const { return !known && aliasDriven && followPackage; }

		// True when the deck's actor-level hold alone cannot be trusted.
		bool FrameworkDriven() const { return aliasDriven && followPackage; }
	};

	// Read-only. Safe to call on any actor, including one in no aliases at all.
	Detection Probe(RE::Actor* actor);

	// Spec index when the actor herself SHIPS in a one-companion mod's plugin
	// (the matchByActorPlugin specs: Amaniri, Vayne), else -1. This answers
	// "is she framework-OWNED" where Probe() answers "is she framework-DRIVEN
	// right now" — ownership holds even while she is idle in an inn filling
	// no follow alias, which is exactly when a caller is most tempted to
	// hand her to NFF. Deliberately no alias or controller-quest requirement.
	int OwningCompanionSpec(RE::Actor* actor);

	// Tell the matched framework to hold this companion where she stands.
	// Returns false when there is no mapping, the controller quest is missing,
	// or the VM refused the call — never "true, probably".
	bool SendWait(RE::Actor* actor, const Detection& detection);

	// The inverse, by spec index (so a caller can resume from a saved index
	// long after the Detection went out of scope). Only call it for an actor
	// YOU put on hold: resuming someone who was already waiting before you
	// touched her is a behaviour change she did not ask for.
	bool SendResume(RE::Actor* actor, int spec);

	// True when the framework already has this actor waiting — checked before
	// SendWait so a release never resumes someone who was parked deliberately.
	bool AlreadyWaiting(RE::Actor* actor);

	// Label for a spec index, or "" for -1 / out of range.
	const char* Label(int spec);

	// One-line, log-friendly summary of a probe ("alias-driven, follow pkg,
	// framework=Nether's Amaniri").
	std::string Summarise(const Detection& detection);
}
