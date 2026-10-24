#pragma once

/* Small CommonLibSSE-NG v12 conveniences, force-included through pch.h.
 *
 * SkyManager builds against alandtse CommonLibSSE-NG v12.x only (since
 * 2026-10-18: one DLL for 1.5.97, 1.6 and 1.7.99+ / 1.7.104, which ships
 * Address Library format 5). The old April-2025 pin is no longer supported;
 * the #error below makes a workspace still on it fail at the first
 * file instead of 110 errors deep. Call the v12 API directly; only helpers
 * that save real repetition live here. */

#if !__has_include(<RE/S/SendHUDMessage.h>)
#	error "SkyManager needs CommonLibSSE-NG v12.x (alandtse). See modding/hotkey-deck/CLAUDE.md."
#endif

namespace RE
{
	// v12 moved the corner-notification call into SendHUDMessage. Same
	// function (RELOCATION_ID 52050, 52933), same arguments; the deck calls
	// it from ~260 places under the old name.
	inline void DebugNotification(const char* a_notification, const char* a_soundToPlay = nullptr, bool a_cancelIfAlreadyQueued = true)
	{
		SendHUDMessage::ShowHUDMessage(a_notification, a_soundToPlay, a_cancelIfAlreadyQueued);
	}
}

namespace HdCompat
{
	// A biped slot mask as plain bits: GetSlotMask() returns a REX::EnumSet,
	// a single BipedObjectSlot is a plain enum. Both come out as uint32 bits.
	template <class T>
	[[nodiscard]] constexpr std::uint32_t SlotBits(const T& a_mask) noexcept
	{
		if constexpr (requires { a_mask.underlying(); })
			return static_cast<std::uint32_t>(a_mask.underlying());
		else
			return static_cast<std::uint32_t>(a_mask);
	}

	// An actor's collision filter word (layer in the low byte, group in the
	// high half), as a ray-cast input's filterInfo.filter wants it.
	[[nodiscard]] inline std::uint32_t CollisionFilterInfo(RE::Actor* a_actor)
	{
		RE::CFilter f{};
		a_actor->GetCollisionFilterInfo(f);
		return f.filter;
	}
}
