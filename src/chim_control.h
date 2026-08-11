#pragma once

#include <cstdint>
#include <functional>
#include <string>

// CHIM manual AI activation — driven through the mod's OWN Papyrus natives on
// the `AIAgentFunctions` script, the same entry points CHIM's "activate AI"
// spell effect uses (AIAgentActivateAIEffect.psc -> setDrivenByAIA), and its
// admin uses to drop an agent (removeAgentByName).
//
// ------------------------------------------------------------------ why ----
// There is NO per-NPC "AI on" flag in CHIM's database (core_npc_master has
// none), and no server lever: activation must originate game-side, because it
// makes the game start streaming that actor's context to the server. So this is
// one `DispatchStaticCall` into AIAgentFunctions per op — the exact shape as
// mhiyh_control's calls into MHiYHController. `setDrivenByAIA(actor, salutation)`
// adds her as an agent; `removeAgentByName(name)` drops her; `getAgentByName(name)`
// returns her Actor if she is currently an agent (None otherwise), which is how
// we read TRUE state for the button's Activate/Disable label.
//
// The natives live in CHIM's AIAgent.dll, so they are only reachable through
// the Papyrus VM — which is why this must be the deck's C++ and not the view.
//
// -------------------------------------------------------------- threading ---
// MAIN THREAD ONLY (resolves a live actor + dispatches Papyrus). The calls are
// asynchronous: SetActive() returns as soon as the stack is queued; QueryActive's
// callback arrives later, already hopped back to the main thread.
namespace ChimControl
{
	// (active, ok) — ok=false means nothing could be dispatched (no VM), in
	// which case `active` is meaningless.
	using StateCb = std::function<void(bool active, bool ok)>;

	// Toggle CHIM AI on the actor.
	//   on=true  -> setDrivenByAIA(actor, /*salutation*/ true)   (adds the agent)
	//   on=false -> removeAgentByName(name)                       (drops the agent)
	// Returns true when the call was dispatched into the VM. Fire-and-forget.
	bool SetActive(std::uint32_t formId, const std::string& name, bool on);

	// Ask whether the NPC is currently a CHIM agent (getAgentByName != None).
	// `cb` fires on the main thread. If nothing could be dispatched, cb is
	// invoked once with (false, false).
	void QueryActive(std::uint32_t formId, const std::string& name, StateCb cb);
}
