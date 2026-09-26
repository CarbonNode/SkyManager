#pragma once
#include <cstdint>
#include <string>

namespace PartyRecall
{
	// MAIN THREAD only unless noted. No actor-state changes except the existing
	// MoveTo summon operation; never recruits, resumes, or clears anyone's AI.
	std::string Recall(); // allSummon JSON response, with counts and per-actor reasons
	// The Recall roster page (Followers tab): every actor the recall would
	// answer for, every flagged-but-unrecruited one it leaves alone, and the
	// register — with the basis for each. Reads only; moves nobody.
	std::string Roster();
	// {"formId":"0x..","plugin":"","name":"","mode":"always"|"never"|"clear"}
	// → stores the durable pair in party-recall.json and answers with Roster().
	std::string SetRegistry(const std::string& request);
	std::string TakeOverKey();
	std::string RestoreNffKey();
	void Tick(bool gameReady, bool blocked);
	void Reset(); // before changing saves; drops all bound-instance assumptions
	// Thread-safe display for the Keys census. Zero = takeover not armed.
	std::uint32_t Hotkey();
	// Called only for a fresh keyboard press in unpaused, unfocused gameplay.
	bool OnKey(std::uint32_t key);
}
