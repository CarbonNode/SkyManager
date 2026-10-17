#pragma once

#include <string>

// Immersive Equipment Displays (IED) control: the "gear on my back" toggle and
// the auto-hide of displayed gear on people in an OStim scene.
//
// WHAT IED GIVES US. IED (Ersh) draws sheathed weapons, quivers, lanterns and
// the like on an actor's back and hips. It ships a Papyrus surface in
// Scripts/Source/IED.psc, global natives on the script "IED":
//     Function AddActorBlock(Actor akActor, string asPlugin) native global
//     Function RemoveActorBlock(Actor akActor, string asPlugin) native global
//     Function Evaluate(Actor akActor) native global
// A block keyed to a LOADED plugin stops IED drawing for that actor (its DLL
// even logs "erasing actor block from missing plugin" for a stale key), and is
// serialized in IED's co-save. That block is the whole mechanism here: the
// deck never edits IED's configuration, never presses its UI key, and never
// touches an item's own setting - a block is one reversible switch.
//
// WHAT THIS MODULE DOES
//   * Player toggle   - "show / hide my displayed gear", a Hotkeys action and a
//                       Settings row. Persisted in our sidecar and RE-ASSERTED
//                       on every game load (IED's own co-save is not trusted
//                       to agree with a save made before the toggle).
//   * Scene auto-hide - while an OStim thread runs, every NPC in it (and,
//                       optionally, the player) is blocked, and released when
//                       the thread ends. OStim thread events are consumed
//                       through its public Thread API, the same one the Scene
//                       page uses.
//   * Crash safety    - IED keeps the block across a crash. The set of refs we
//                       blocked is written to the sidecar on every change and
//                       released on the next game load, so a crash mid-scene
//                       cannot leave anyone bare of displays for good.
//
// The block key is "HotkeyDeckWardrobe.esp": it must be a loaded plugin, and
// it is the deck's own (the wardrobe/NPC-control ESP in the SkyManager Source
// mod). With it absent the module refuses honestly instead of calling IED.
//
// THREADING: every entry point runs on the main thread (SKSE task). OStim's
// event callback and the delayed re-read hop onto it with AddTask.
namespace IedControl
{
	// IED's DLL is loaded.
	[[nodiscard]] bool Present();

	// Main thread, kDataLoaded: read the sidecar and (if OStim is up) listen
	// for scene events. Safe with either mod absent.
	void Init();

	// Main thread, kPostLoadGame: release anything a previous session left
	// blocked, then re-assert the player toggle.
	void OnPostLoadGame();

	// {present, canBlock, msg, playerShown, hideNpcs, hidePlayer,
	//  scenes:<running OStim threads>, hidden:<refs blocked right now>}
	std::string StateJson();

	// {key:"playerShown"|"hideNpcs"|"hidePlayer", value:bool} -> {ok,msg,...StateJson}
	std::string SetJson(const std::string& req);

	// Flip the player's gear displays. {ok,msg,shown}
	std::string TogglePlayerJson();
}
