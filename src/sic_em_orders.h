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
//
// 2026-10-12 (Rober, after Vayne was sent back at a Cave Bear eight times over
// ninety seconds and never arrived: "'couldn't get to target' make sure this
// is configurable and a time if it doesnt get to target npcs teleport next to
// it"). "Couldn't get there" is now a TIME, set in Settings (reachSeconds),
// not a count of re-issues; when it runs out she is moved next to the target
// (teleport, on by default) and gets one more window before the order drops.
namespace SicEmOrders
{
	inline constexpr float kPushIntervalSeconds = 3.0f;    // re-issue cadence while she is not fighting
	inline constexpr float kOrderTimeoutSeconds = 120.0f;  // an order nobody finished is forgotten
	inline constexpr int   kMaxPushes = 8;                 // reached her target, then 8 refusals = she will not fight it

	// Settings → Combat. The clamp is shared by main.cpp's config reader and
	// the view's control, so the three agree.
	inline constexpr float kDefaultReachSeconds = 15.0f;
	inline constexpr float kMinReachSeconds = 5.0f;
	inline constexpr float kMaxReachSeconds = 60.0f;
	constexpr float ClampReachSeconds(double v)
	{
		if (!(v == v))  // NaN
			return kDefaultReachSeconds;
		return v < kMinReachSeconds ? kMinReachSeconds
			 : v > kMaxReachSeconds ? kMaxReachSeconds
			 : static_cast<float>(v);
	}

	struct Options
	{
		float reachSeconds = kDefaultReachSeconds;  // how long she gets to reach the target
		bool  teleport = true;                      // then move her next to it (off: drop the order)
	};

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
		bool  reached = false;       // she got to this target (in reach, or hurting it from range)
		float unreached = 0.0f;      // seconds she has spent NOT having reached it (since issue / teleport)
		bool  teleported = false;    // already moved next to this target once
		Options options{};
	};

	enum class Step { Keep, Push, Retarget, Teleport, Drop };

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
		// Out of time to get there — checked BEFORE "fighting": a StartCombat
		// she cannot path on still flags her in combat (Vayne and the bear).
		if (!s.reached && s.unreached >= s.options.reachSeconds)
			return (s.options.teleport && !s.teleported)
				? Decision{ Step::Teleport, "could not reach" }
				: Decision{ Step::Drop, "could not reach" };
		// Fighting — even someone else. Who she swings at inside a brawl is the
		// engine's call; re-pinning her every tick fights the combat AI.
		if (s.allyInCombat)
			return { Step::Keep, "fighting" };
		if (s.sincePush < kPushIntervalSeconds)
			return { Step::Keep, "waiting" };
		if (s.reached && s.pushes >= kMaxPushes)
			return { Step::Drop, "would not engage" };
		return { Step::Push, "not fighting" };
	}
}
