#pragma once

#include <string>

// Scene camera: why F and the mouse wheel do nothing in an OStim scene, a log
// that proves it on the next scene, and a way out that does not depend on the
// locked key.
//
// The ask (Rober, 2026-10-14): "any idea why in ostim mode f doesnt or
// scrolling doesnt go to third person? ... be certain ... and figure out the
// camera as well."
//
// WHAT OSTIM DOES (OStimNG 7.4, GameAPI/GameCamera.cpp, read from the source).
// When its MCM "Improved Camera" global (OStim.esp 0xDE6) is non-zero, every
// player scene start runs
//     PlayerControls.data.povScriptMode = true
//     ForceFirstPerson(); ControlMap.enabledControls.reset(kPOVSwitch); ForceThirdPerson();
// and restores both when the scene ends. kPOVSwitch is the F / mouse-wheel
// first-person switch and povScriptMode is the engine's "a script owns the
// view" gate: with either set the key and the wheel cannot change the view.
// (Furniture scenes also put the vanilla camera in its Furniture state, which
// Improved Camera SE / No Furniture Camera then reshape - that is why this
// module LOGS the camera state as well, instead of assuming.)
//
// WHAT THIS MODULE DOES
//   * LOG: once a second while a player scene runs it logs the camera state,
//     the POV / wheel control bits, povScriptMode, OStim's Improved Camera
//     global and the player's sit/sleep state - on CHANGE only, so a whole
//     scene is a handful of lines in HotkeyDeck.log. That is the evidence the
//     next play-test turns into a certain answer.
//   * UNLOCK (setting, default on): 1.5 s after a scene starts, and after any
//     re-lock, give the POV switch and wheel zoom back and clear povScriptMode.
//     It never forces a view - it only lets F and the wheel work again.
//   * TOGGLE (a Hotkeys action, bindable to any key): flip first / third person
//     right now through PlayerCamera::ForceFirstPerson / ForceThirdPerson, which
//     do not need the locked key at all, and log the state before and after.
//
// MAIN THREAD ONLY (the ticker hops over with AddTask).
namespace SceneCamera
{
	// Sidecar + the once-a-second ticker. Main thread, kDataLoaded.
	void Init();

	// A save loaded: forget the scene we were watching.
	void OnPostLoadGame();

	// {unlock, inScene, state, firstPerson, povSwitch, wheelZoom, povScript, ostimCam, msg?}
	std::string StateJson();

	// {key:"unlock", value:bool} -> StateJson with {ok}.
	std::string SetJson(const std::string& req);

	// The action: flip first / third person now; returns {ok, msg}.
	std::string ToggleViewJson();
}
