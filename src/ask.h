#pragma once

/* ====================================================================== *
 *  Ask bridge — the Omni overlay's HTTP channel to CHIM's deck_ask
 *  endpoint (in-game NPC Q&A: "what is Olfina's sexual preference?").
 *
 *  A deliberate SIBLING of the Sharmat bridge (sharmat.cpp), not a reuse
 *  of it: Sharmat's base-list / pinned-base / in-flight budget are
 *  file-static singletons tuned for 6-second config reads, and an ask
 *  that runs CHIM's LLM layer can legitimately take a minute. Sharing
 *  one channel would let a slow think starve a profile save (or the
 *  other way round). Same envelope shape, same thread model, own state.
 *
 *  JS -> C++:  haAsk  {"id":"ask-1","query":"q=…&npc=…&mode=…","llm":bool}
 *              `query` is the FULL pre-encoded querystring (the view owns
 *              encodeURIComponent; C++ appends it verbatim).
 *  C++ -> JS:  haAnswer with the Sharmat envelope shape:
 *              {"id","ok":true,"status",<"json": endpoint body>} or
 *              {"id","ok":false,"error","chimDown":bool}
 * ====================================================================== */

#include <cstdint>
#include <functional>
#include <string>

namespace Ask
{
	using Reply = std::function<void(const std::string& envelopeJson)>;

	// Fire one GET at <base>/HerikaServer/ext/deck_ask/ask.php?<query>.
	// Non-blocking: returns immediately, `done` runs later ON THE MAIN THREAD
	// with the envelope. `timeoutMs` differs by mode — the structured layer is
	// a DB read (short), the LLM layer is a chat completion (long).
	void Call(std::string id, std::string query, int timeoutMs, Reply done);
}
