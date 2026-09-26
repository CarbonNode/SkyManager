#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Schlongs of Skyrim: bend, from the deck.
//
// WHAT SOS ACTUALLY EXPOSES. Its Papyrus API (SOS_API.psc, shipped as source in
// the mod) covers identity and size only — IsSchlonged, Get/SetSize, Get/Set the
// active addon, the min/max/multiplier MCM settings. Bending is NOT in it, and
// not in the SKSE natives (SOS_SKSE.psc) either. Bend exists solely as three
// keymap options on SOS's own SkyUI MCM (SOS_Config.psc):
//
//     iBendUpKey             default 201 (PgUp)
//     iBendDownKey           default 209 (PgDn)
//     iBendPlayerModifierKey default  42 (Left Shift)
//
// SOS's own input handler watches for those keys. Bend normally targets the NPC
// under your crosshair; holding the modifier retargets it at the PLAYER.
//
// So there is no function to call — the honest wire is the one menu_actions.cpp
// already uses for Prisma MCM / SKSE Menu Framework / Community Shaders:
// synthesize EXACTLY the input the target mod is listening for, read LIVE from
// that mod's own config so a rebind there stays honored. The deck presses the
// key; Rober presses nothing but the palette button.
//
// WHERE THE BINDS COME FROM. Not a hardcoded FormID and not the defaults above:
// a property chain rooted in the one identity SOS itself documents, so it
// survives any load-order change —
//
//     SOS_API.Get()  ==  GetFormFromFile(0x1eda4, "Schlongs of Skyrim.esp")
//       -> .SOS      (SOS_SetupQuest_Script)
//       -> .config   (SOS_Config, the live MCM instance)
//       -> iBendUpKey / iBendDownKey / iBendPlayerModifierKey
//
// The defaults are used ONLY when that chain cannot be walked (SOS absent, or
// not yet initialised), and the log says which of the two it used — a bend that
// silently fires the wrong key is worse than one that says it guessed.
//
// Threading: the binds are VM data reads and stay on the MAIN thread (the
// caller already runs inside a task). The tap itself runs on a detached worker
// after the palette closes, because SOS's handler is Papyrus and Papyrus runs
// unpaused only.

namespace SosActions
{
	// Appearance snapshots use SOS's own API. All continuations run on the main
	// task queue, without blocking. The caller's epoch guard is checked before
	// every continuation so loading a save cancels further work.
	using AppearanceDone = std::function<void(std::string)>;
	using AppearanceAlive = std::function<bool()>;
	void CaptureAppearance(AppearanceDone done, AppearanceAlive alive);
	// Read-only live registration catalogue, requested while gameplay is
	// unpaused. The gallery uses the cached result; writes revalidate live.
	void ReadAppearanceCatalog(AppearanceDone done, AppearanceAlive alive);
	std::string AppearanceProblem(const std::string& state);
	void ValidateAppearance(const std::string& state, std::uint32_t raceId, bool female,
		AppearanceDone done, AppearanceAlive alive);
	void ApplyAppearance(const std::string& state, AppearanceDone done, AppearanceAlive alive);
	void VerifyAppearance(const std::string& state, AppearanceDone done, AppearanceAlive alive);

	// Explicit actor API for scene controls. No crosshair/player fallback.
	// Main-thread only; reply fires on the task queue after native readback.
	std::string SizeStateJson(std::uint32_t formId);
	void SetActorSize(std::uint32_t formId, int size, std::function<void(std::string)> done);

	// "sos-bend-up" / "sos-bend-down" / "sos-bend-up-player" / "sos-bend-down-player"
	bool IsAction(const std::string& a);

	// Spawns a worker thread and returns immediately. Call AFTER ClosePalette().
	void Fire(const std::string& a);

	// The live bind set, for the log and for anything that wants to show it.
	struct Binds
	{
		std::uint32_t up = 0;        // DIK scancode, 0 = unbound in SOS's MCM
		std::uint32_t down = 0;
		std::uint32_t playerMod = 0;
		bool          live = false;  // false = SOS's shipped defaults, not read
	};
	Binds Read();
}
