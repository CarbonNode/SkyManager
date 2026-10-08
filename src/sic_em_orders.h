#pragma once

// Standing attack orders — what happens AFTER a Sic 'em / Hunt has been given.
//
// Until 2026-10-05 an order was one StartCombat and nothing else: a follower
// who lost her target on the way (it broke line of sight, she never detected
// it, her follow package pulled her back) simply stopped, and the order was
// gone. Hunt Them Down (Nexus 194054, zfroggyman, GPL-3) keeps a per-ally
// command alive on a monitor instead — re-issue while she is not fighting,
// move on to the next enemy when the target dies, give up on a timeout. That
// mod drives the walk through Harbinger's travel claims; this is the same
// state machine over our own StartCombat, with no framework dependency.
//
// Pure policy, no engine types: npc_actions.cpp samples the actors and does
// what Decide() says, tests/sic_em_orders.cpp proves the table.
namespace SicEmOrders
{
	inline constexpr float kPushIntervalSeconds = 3.0f;    // re-issue cadence while she is not fighting
	inline constexpr float kOrderTimeoutSeconds = 120.0f;  // an order nobody finished is forgotten
	inline constexpr int   kMaxPushes = 8;                 // ~24 s of refusing to engage = she cannot get there

	struct Sample
	{
		bool  allyPresent = false;   // loaded, alive, enabled
		bool  allyHeld = false;      // a deck hold (freeze / sit / bed / grab) owns her now
		bool  targetAlive = false;   // exists, alive, enabled
		bool  allyInCombat = false;
		bool  hunt = false;          // a Hunt order moves on to the next enemy; a Sic 'em ends with its target
		float sinceIssued = 0.0f;    // seconds since the order (or its last retarget)
		float sincePush = 0.0f;      // seconds since StartCombat was last sent
		int   pushes = 0;            // re-issues sent so far
	};

	enum class Step { Keep, Push, Retarget, Drop };

	struct Decision
	{
		Step        step;
		const char* reason;
	};

	constexpr Decision Decide(const Sample& s)
	{
		if (!s.allyPresent)
			return { Step::Drop, "ally gone" };
		if (s.allyHeld)
			return { Step::Drop, "held by the deck" };  // a later Freeze/Sit outranks the charge
		if (!s.targetAlive)
			return s.hunt ? Decision{ Step::Retarget, "target down" } : Decision{ Step::Drop, "target down" };
		if (s.sinceIssued >= kOrderTimeoutSeconds)
			return { Step::Drop, "timed out" };
		// Fighting — even someone else. Who she swings at inside a brawl is the
		// engine's call; re-pinning her every tick fights the combat AI.
		if (s.allyInCombat)
			return { Step::Keep, "fighting" };
		if (s.sincePush < kPushIntervalSeconds)
			return { Step::Keep, "waiting" };
		if (s.pushes >= kMaxPushes)
			return { Step::Drop, "would not engage" };
		return { Step::Push, "not fighting" };
	}
}
