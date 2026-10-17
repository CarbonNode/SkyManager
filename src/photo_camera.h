#pragma once

#include <cstddef>

namespace PhotoCamera
{
	// CommonLib's cross-VR Main declaration has one event-sink base. Flat
	// Skyrim has TWO: its freeze flag is at +0x16, not the declared +0x0E.
	// Reading Main::freezeTime in a multi-runtime build reads a vtable byte;
	// our old post-entry check therefore undid every successful frozen TFC.
	// SE offset verified in ToggleFreeCameraMode (49876), SkyrimSE+84B807.
	// Select by the running game, never by which runtimes were compiled in.
	inline bool* FreezeTimeFlag(void* world, bool isVR) noexcept
	{
		if (!world) return nullptr;
		return reinterpret_cast<bool*>(static_cast<std::byte*>(world) + (isVR ? 0x0E : 0x16));
	}

	// Main-thread lease of the game's real camera and time state. Never infer
	// ownership from having issued a command: another camera mod can refuse it.
	//
	// Two ways in, one verifier. A ROUTE is the caller's own way of asking the
	// engine for free camera (the console `tfc` / `tfc 1`, the sequence CHIM
	// uses and the one every photo used before 2026-09-24, when the chosen
	// `fov` visibly applied); the native ToggleFreeCameraMode is the fallback
	// when the route did not change the camera state. Whichever way in, the
	// lease still reads the REAL free-camera and frozen-time state afterwards
	// (the 2026-09-25 rule), and still rolls back a failed freeze.
	class Lease
	{
	public:
		template <class Camera>
		bool Enter(Camera* camera, bool* frozen, bool freeze)
		{
			return Enter(camera, frozen, freeze, [](bool) { return false; });
		}

		// `route(freeze)` returns true when it issued a request of its own.
		template <class Camera, class Route>
		bool Enter(Camera* camera, bool* frozen, bool freeze, Route route)
		{
			if (owned_ || !camera || !frozen || camera->IsInFreeCameraMode()) return false;
			frozenBefore_ = *frozen;
			viaRoute_ = route(freeze) && camera->IsInFreeCameraMode();
			if (!viaRoute_) camera->ToggleFreeCameraMode(freeze);
			owned_ = camera->IsInFreeCameraMode();
			if (owned_ && freeze && !*frozen) {
				Exit(camera, frozen);
				return false;
			}
			if (!owned_) { *frozen = frozenBefore_; viaRoute_ = false; }
			return owned_;
		}

		template <class Camera>
		bool Exit(Camera* camera, bool* frozen)
		{
			return Exit(camera, frozen, [](bool) { return false; });
		}

		// `route(false)` may ask the engine to leave free camera its own way;
		// the native toggle follows only if the camera is still free.
		template <class Camera, class Route>
		bool Exit(Camera* camera, bool* frozen, Route route)
		{
			if (!owned_) return true;
			// The player or another mod may already have left TFC. Toggling
			// blindly here would put them BACK into it after saving the photo.
			if (camera && camera->IsInFreeCameraMode()) {
				route(false);
				if (camera->IsInFreeCameraMode()) camera->ToggleFreeCameraMode(false);
			}
			if (frozen) *frozen = frozenBefore_;
			const bool restored = camera && !camera->IsInFreeCameraMode();
			owned_ = !restored; // retain ownership if restoration needs retrying
			if (restored) viaRoute_ = false;
			return restored;
		}

		// True while the current lease was obtained through the caller's route
		// rather than the native toggle. Logging only; the state is verified
		// the same way either way.
		bool EnteredByRoute() const noexcept { return owned_ && viaRoute_; }

	private:
		bool owned_ = false;
		bool frozenBefore_ = false;
		bool viaRoute_ = false;
	};
}
