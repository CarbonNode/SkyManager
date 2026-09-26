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
	class Lease
	{
	public:
		template <class Camera>
		bool Enter(Camera* camera, bool* frozen, bool freeze)
		{
			if (owned_ || !camera || !frozen || camera->IsInFreeCameraMode()) return false;
			frozenBefore_ = *frozen;
			camera->ToggleFreeCameraMode(freeze);
			owned_ = camera->IsInFreeCameraMode();
			if (owned_ && freeze && !*frozen) {
				Exit(camera, frozen);
				return false;
			}
			if (!owned_) *frozen = frozenBefore_;
			return owned_;
		}

		template <class Camera>
		bool Exit(Camera* camera, bool* frozen)
		{
			if (!owned_) return true;
			// The player or another mod may already have left TFC. Toggling
			// blindly here would put them BACK into it after saving the photo.
			if (camera && camera->IsInFreeCameraMode()) camera->ToggleFreeCameraMode(false);
			if (frozen) *frozen = frozenBefore_;
			const bool restored = camera && !camera->IsInFreeCameraMode();
			owned_ = !restored; // retain ownership if restoration needs retrying
			return restored;
		}

	private:
		bool owned_ = false;
		bool frozenBefore_ = false;
	};
}
