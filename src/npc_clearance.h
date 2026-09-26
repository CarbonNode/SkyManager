#pragma once
#include <cstdint>
#include <string>
// Main thread only. Roster and writes share the same nearby predicate; Apply
// additionally requires membership in the last displayed, unexpired roster.
namespace NpcClearance {
std::string Nearby(const std::string& request);
std::string Apply(const std::string& request);
// Clear the room (Rober, 2026-09-21: "move them out of the cell and pause them (a
// toggle for this) then i can reopen have them teleport back after scene"):
// {token, ids} -> each selected actor is remembered (cell + position + facing),
// moved OUT of the player's cell — through the cell's own door to where that
// door leads, or into the engine's body-cleanup cell when there is no door —
// and has its AI switched off so it stays put. Restore brings every held actor
// back to where it stood and restores its original AI state. Both reply {ok,msg,…}.
std::string ClearRoom(const std::string& request);
std::string Restore();
int         HeldCount();
std::string HeldJson();          // [{formId,name}] for the picker's banner
void        OnPostLoadGame();    // safety net: held actors found frozen in the new session are released
void Reset();
// Native-only room privacy adapter. No arbitrary ids/coordinates from the view.
std::string PrivacyExit();
std::string HoldPrivacy(std::uint32_t id, const std::string& destination);
std::string RestorePrivacy(std::uint32_t id = 0);
std::string PrivacyHeldJson();
bool IsHeld(std::uint32_t id);
// Share SkyManager's existing co-save callbacks; never register a second set.
void SaveCosave(SKSE::SerializationInterface*);
bool LoadCosave(SKSE::SerializationInterface*, std::uint32_t type, std::uint32_t version, std::uint32_t length);
void RevertCosave();
}
