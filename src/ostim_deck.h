#pragma once

#include <cstdint>
#include <string>

// ---------------------------------------------------------------------------
// OStim panel — a scene search / change / control surface INSIDE the deck's
// Animations tab (the "OStim" segment beside "Poses").
//
// The ask (Rober, 2026-08-07): the search-popout half of OStim Prism (Nexus
// 174750) WITHOUT replacing OStim's native menu — "an animation searcher popout
// I can use while in a scene to change the scene or start a scene" — plus
// (same thread) OStim Furniture Switch (Nexus 184782) "built right in without
// enabling it": real-time furniture switching and the DOM/SUB role swap.
//
// HOW IT TALKS TO OSTIM
// ---------------------
// Entirely through OStim SA's public C-ABI Thread API (ostim_thread_api.h,
// vendored from VersuchDrei/OStimNG), acquired the same way OStim Prism does:
// GetModuleHandle("OStim.dll") + RequestPluginAPI_Thread. No Papyrus round-trip
// for the read/search/navigate path — which is why it can react live mid-scene.
//   * search      -> IThreadInterface::SearchScenes
//   * change scene -> NavigateToSearchResult (validates, then warps the thread)
//   * speed/auto/stop-ish -> SetSpeed / IsAutoMode / GetNavigation*
//   * DOM/SUB swap -> MigrateThread with the actor list reversed (preserves state)
//
// The ONE thing the Thread API does not expose is furniture switching, so that
// verb dispatches the OStim Papyrus global native OThread.ChangeFurniture via
// the VM (with a furniture ref found in C++). Marked in the log as the only
// Papyrus path so a play-test can prove it.
//
// DELIBERATELY NOT DONE: SetExternalUIEnabled(false). That would kill OStim's
// own flash menus — the exact native UI Rober is keeping. We coexist with it.
//
// v1 scope: CHANGE the running scene (+ furniture + role swap + speed/auto).
// Starting a fresh scene (actor-fill + furniture pick) is the agreed follow-up.
// ---------------------------------------------------------------------------

namespace OstimDeck
{
	// Cheap: clears cached state. The API handle is acquired lazily on first use
	// (OStim.dll may load after us), so nothing here can fail if OStim is absent.
	void Init();

	// osGet -> osOpen: the whole live picture + an initial scene list.
	// { ok, ostim, inScene, threadID, scene, sceneName, actorCount,
	//   actors:[{name,female,formId}], speed, maxSpeed, auto, furnitureType,
	//   canSwap, scenes:[{sceneId,name,actorCount,compatible}] }
	std::string OpenJson();

	// osPoll -> osState: the same live block WITHOUT the scene list, for cheap
	// refreshes after an action.
	std::string StateJson();

	// osSearch(query) -> osList: { query, results:[{sceneId,name,actorCount,compatible}] }
	std::string SearchJson(const std::string& query);

	// osNav(sceneId) -> osResult: change the running scene. {ok,msg}
	std::string ChangeScene(const std::string& sceneId);

	// osSpeed("+"/"-"/"<n>") -> osResult (state rides along). {ok,msg,speed,maxSpeed}
	std::string Speed(const std::string& delta);

	// osAuto -> osResult: toggle OStim auto-mode. {ok,msg,auto}
	std::string ToggleAuto();

	// osFurn("nearby"/"floor") -> osResult: real-time furniture switch. {ok,msg}
	std::string SwitchFurniture(const std::string& mode);

	// osSwap -> osResult: swap DOM/SUB (reverse actor order via MigrateThread).
	std::string SwapRoles();
}
