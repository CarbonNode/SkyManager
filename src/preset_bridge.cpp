#include "preset_bridge.h"

// pch (force-included) provides logger and Windows.h via SKSE.

namespace
{
	using CallFn = const char* (*)(const char*, const char*, const char*);

	CallFn g_call = nullptr;
	bool   g_resolveTried = false;

	// PD's DLL is a fellow SKSE plugin in this same process; one resolve
	// attempt is enough (plugins never load after kPostLoad).
	void Resolve()
	{
		if (g_resolveTried)
			return;
		g_resolveTried = true;
		const auto mod = GetModuleHandleA("PresetDirector.dll");
		if (!mod) {
			logger::warn("PresetDeck: PresetDirector.dll not loaded");
			return;
		}
		g_call = reinterpret_cast<CallFn>(GetProcAddress(mod, "PresetDirector_Call"));
		if (!g_call)
			logger::warn("PresetDeck: PresetDirector.dll has no C API (needs >= 0.2.0)");
		else
			logger::info("PresetDeck: Preset Director C API resolved");
	}
}

namespace PresetBridge
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
			return R"json({"ok":false,"error":"Preset Director isn't loaded — tick the mod in MO2 (needs >= 0.2.0)"})json";
		const char* r = g_call(method.c_str(), path.c_str(), body.c_str());
		return r ? std::string(r) : R"json({"ok":false,"error":"Preset Director returned nothing"})json";
	}
}
