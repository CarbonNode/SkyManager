#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace PartyRecall
{
	// MAIN THREAD only unless noted. No actor-state changes except the existing
	// MoveTo summon operation; never recruits, resumes, or clears anyone's AI.
	std::string Recall(); // allSummon JSON response, with counts and per-actor reasons
	// The Recall roster page (Followers tab): every actor the recall would
	// answer for, every flagged-but-unrecruited one it leaves alone, and the
	// register — with the basis for each. Reads only; moves nobody.
	// MAIN THREAD. Everyone the eligibility policy (party_recall_policy.h) says
	// is FOLLOWING right now, waiting ones included: the band the Command Ring
	// orders about (2026-10-12). Same Survey as Recall()/Roster(), so the ring,
	// the recall key and the Recall page can never disagree about who that is.
	// `waiting` = told to wait (WaitingForPlayer, or Serana's mental model);
	// `busy` = mounted, in a scene, pose-held or in an OStim scene.
	struct Member
	{
		std::uint32_t formId = 0;
		bool          waiting = false;
		bool          busy = false;
		bool          loaded = false;
	};
	std::vector<Member> Members();
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
