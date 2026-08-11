#include "anim_resolver_bridge.h"

// pch (force-included) provides RE::/SKSE::, logger and Windows.h via SKSE.

namespace AnimResolverBridge
{
	namespace
	{
		using ManualResolveFn = void();

		// Resolved once, first use. GetModuleHandle (not LoadLibrary): if SKSE
		// didn't load the plugin, we must not load a second copy behind its
		// back — absent means absent.
		ManualResolveFn* Resolve()
		{
			static ManualResolveFn* fn = []() -> ManualResolveFn* {
				const HMODULE mod = ::GetModuleHandleA("AnimationResolver.dll");
				if (!mod) {
					logger::warn("anim-refresh: AnimationResolver.dll is not loaded");
					return nullptr;
				}
				const auto proc = ::GetProcAddress(mod, "AnimResolver_ManualResolve");
				if (!proc) {
					logger::warn(
						"anim-refresh: AnimationResolver.dll is loaded but exports no "
						"AnimResolver_ManualResolve — version mismatch");
					return nullptr;
				}
				logger::info("anim-refresh: bridged to AnimationResolver.dll");
				return reinterpret_cast<ManualResolveFn*>(proc);
			}();
			return fn;
		}
	}

	bool IsAction(const std::string& a_action)
	{
		return a_action == "anim-refresh";
	}

	void Fire()
	{
		if (auto* fn = Resolve()) {
			fn();  // posts its own main-thread task and logs to AnimationResolver.log
		} else {
			RE::DebugNotification("Animation Resolver is not installed - enable the mod in MO2");
		}
	}
}
