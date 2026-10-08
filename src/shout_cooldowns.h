#pragma once
#include <cstdint>
#include <utility>

// ShoutCooldowns — every shout keeps its OWN cooldown (2026-10-04, Rober on the
// Spell Hotbar NG list: "this would be awesome").
//
// The engine has exactly ONE shout recovery timer for the player
// (AIProcess high->voiceRecoveryTime). With this on, the timer is SWAPPED
// whenever the equipped shout or voice power changes — through the action
// bar, the favourites menu, the magic menu, anything: the shout put away keeps
// what was left of the timer, the one equipped gets its own remaining time
// back (zero if it was never used). So Unrelenting Force no longer locks out
// Fire Breath. Kept in GAME time, so waiting and sleeping count, and stored in
// the SKSE co-save (record 'SHCD') so a reload does not reset every cooldown.
//
// Model: Spell Hotbar NG's casting/ShoutCooldowns.cpp (GPL-3, credited in
// THIRD-PARTY-NOTICES), itself after Spell Hotbar 2's option of the same name.
// Ours is driven by the hotbar poll thread's beat instead of a per-frame
// hook; the bar's voice road waits 250-750 ms before pressing the Shout key,
// far longer than that beat, so the swap always lands first.
//
// THREADING: Update/Get/Reset and the co-save calls are MAIN THREAD ONLY (the
// SKSE save/load callbacks run there too). SetEnabled/Enabled are atomic.
namespace SKSE
{
	class SerializationInterface;
}
namespace RE
{
	class TESForm;
}

namespace ShoutCooldowns
{
	inline constexpr std::uint32_t kRecord = 'SHCD';
	inline constexpr std::uint32_t kRecordVersion = 1;

	// The hotbar config's `ownShoutCooldowns`, mirrored here every poll beat.
	// Turning it off folds back to the one shared timer (the equipped shout's).
	void SetEnabled(bool on);
	bool Enabled();

	// Detect a voice-slot switch and swap the engine timer. MAIN THREAD.
	void Update();

	// Remaining and total seconds before this shout / voice power is ready.
	// {0,0} for anything that does not use the shout timer. With the feature
	// off every voice form answers the engine's one timer. MAIN THREAD.
	std::pair<float, float> Get(RE::TESForm* form);

	// A save loaded: what was equipped before is not a switch. MAIN THREAD.
	void Reset();

	void SaveCosave(SKSE::SerializationInterface* s);
	// true = the record was ours (consumed), false = someone else's.
	bool LoadCosave(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t length);
	void RevertCosave();
}
