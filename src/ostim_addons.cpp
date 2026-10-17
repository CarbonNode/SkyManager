#include "ostim_addons.h"

#include <cstdint>
#include <string>

namespace OstimAddons
{
	namespace
	{
		using json = nlohmann::json;

		constexpr std::uint32_t kApi = 1;

		using ApiVersionFn = std::uint32_t (*)();
		using StateFn = const char* (*)();
		using SetFn = const char* (*)(const char*);

		struct Bridge
		{
			StateFn     state = nullptr;
			SetFn       set = nullptr;
			std::string why;
		};

		// Looked up every call, not cached: it costs two GetProcAddress
		// calls, and it can never hold a pointer into a module that is gone.
		Bridge Find()
		{
			Bridge b;
			const HMODULE dll = GetModuleHandleW(L"SkyManagerOStimAddons.dll");
			if (!dll) {
				b.why = "Install the SkyManager OStim Add-ons archive (its own download, so it can follow OStim updates) to control OStrands from here";
				return b;
			}
			const auto version = reinterpret_cast<ApiVersionFn>(GetProcAddress(dll, "SkyManagerOStimAddons_ApiVersion"));
			if (!version || version() != kApi) {
				b.why = "SkyManager OStim Add-ons and SkyManager do not match; update both";
				return b;
			}
			b.state = reinterpret_cast<StateFn>(GetProcAddress(dll, "SkyManagerOStimAddons_State"));
			b.set = reinterpret_cast<SetFn>(GetProcAddress(dll, "SkyManagerOStimAddons_Set"));
			if (!b.state || !b.set)
				b.why = "SkyManager OStim Add-ons is missing its C API; reinstall it";
			return b;
		}

		std::string Missing(const Bridge& b)
		{
			const bool ostrands = GetModuleHandleW(L"OStrands.dll") != nullptr;
			return json{ { "ok", false }, { "hooked", false }, { "bridge", false }, { "loaded", ostrands },
				{ "why", b.why }, { "msg", b.why }, { "groups", json::array() } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Pass(const char* out)
		{
			auto j = json::parse(out ? out : "", nullptr, false);
			if (!j.is_object())
				return json{ { "ok", false }, { "msg", "SkyManager OStim Add-ons gave no answer" }, { "groups", json::array() } }.dump();
			j["bridge"] = true;
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}
	}

	std::string StateJson()
	{
		const auto b = Find();
		if (!b.state)
			return Missing(b);
		return Pass(b.state());
	}

	std::string Set(const std::string& request)
	{
		const auto b = Find();
		if (!b.set)
			return Missing(b);
		const std::string out = Pass(b.set(request.c_str()));
		logger::info("ostim-addons: set via bridge -> {}", json::parse(out, nullptr, false).value("msg", ""));  // marker: ostim-addons-bridge
		return out;
	}
}
