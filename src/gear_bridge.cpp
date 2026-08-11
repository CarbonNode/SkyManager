#include "gear_bridge.h"

// pch (force-included) provides logger and Windows.h via SKSE.

namespace
{
	using CallFn = const char* (*)(const char*, const char*, const char*);

	CallFn g_call = nullptr;
	bool   g_resolveTried = false;

	void Resolve()
	{
		if (g_resolveTried)
			return;
		g_resolveTried = true;
		const auto mod = GetModuleHandleA("GearToggle.dll");
		if (!mod) {
			logger::warn("GearDeck: GearToggle.dll not loaded");
			return;
		}
		g_call = reinterpret_cast<CallFn>(GetProcAddress(mod, "GearToggle_Call"));
		if (!g_call)
			logger::warn("GearDeck: GearToggle.dll has no C API (needs >= 0.1.0)");
		else
			logger::info("GearDeck: Gear Toggle C API resolved");
	}
}

namespace GearBridge
{
	bool Available()
	{
		Resolve();
		return g_call != nullptr;
	}

	std::string Call(const std::string& method, const std::string& path, const std::string& body)
	{
		Resolve();
		if (!g_call)
			return R"json({"ok":false,"error":"Gear Toggle isn't loaded — tick the mod in MO2 (needs >= 0.1.0)"})json";
		const char* r = g_call(method.c_str(), path.c_str(), body.c_str());
		return r ? std::string(r) : R"json({"ok":false,"error":"Gear Toggle returned nothing"})json";
	}
}
