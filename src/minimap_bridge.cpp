#include "minimap_bridge.h"

#include <Windows.h>
#ifdef GetObject
#undef GetObject
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

#include <filesystem>
#include <vector>

namespace MinimapBridge
{
	namespace
	{
		using json = nlohmann::json;

		using ApiVersionFn = int (*)();
		using GetStateFn = int (*)(char*, int);
		using SetFn = bool (*)(const char*, const char*);
		using SaveFn = void (*)();
		using SetPreviewFn = void (*)(bool);
		using PlaceFn = bool (*)(float, float, float, float);
		using ResetFn = void (*)(const char*);

		struct Api
		{
			bool         present = false;
			int          version = 0;
			GetStateFn   getState = nullptr;
			SetFn        set = nullptr;
			SaveFn       save = nullptr;
			SetPreviewFn setPreview = nullptr;
			PlaceFn      place = nullptr;
			ResetFn      reset = nullptr;
		};

		// resolved once the DLL is there (a loaded SKSE plugin never unloads)
		const Api& Get()
		{
			static Api  api;
			static bool resolved = false;
			if (resolved)
				return api;
			const auto mod = GetModuleHandleW(L"DetailedMiniMap.dll");
			api.present = mod != nullptr;
			if (!mod)
				return api;  // asked again next time: plugins load before kDataLoaded, but be safe
			resolved = true;
			const auto version = reinterpret_cast<ApiVersionFn>(GetProcAddress(mod, "DMM_ApiVersion"));
			if (!version) {
				SKSE::log::info("minimap-bridge: DetailedMiniMap.dll loaded WITHOUT the SkyManager API (upstream build)");
				return api;
			}
			api.getState = reinterpret_cast<GetStateFn>(GetProcAddress(mod, "DMM_GetState"));
			api.set = reinterpret_cast<SetFn>(GetProcAddress(mod, "DMM_Set"));
			api.save = reinterpret_cast<SaveFn>(GetProcAddress(mod, "DMM_Save"));
			api.setPreview = reinterpret_cast<SetPreviewFn>(GetProcAddress(mod, "DMM_SetPreview"));
			api.place = reinterpret_cast<PlaceFn>(GetProcAddress(mod, "DMM_Place"));
			api.reset = reinterpret_cast<ResetFn>(GetProcAddress(mod, "DMM_Reset"));
			if (api.getState && api.set && api.save && api.setPreview && api.place && api.reset)
				api.version = version();
			SKSE::log::info("minimap-bridge: DetailedMiniMap API v{} ({})", api.version, api.version ? "all exports" : "an export is missing");
			return api;
		}

		bool previewOn = false;

		// a frame's preview picture in the deck's own view tree, or null (the tile shows the name)
		json Thumb(const std::string& a_id)
		{
			if (a_id.empty() || a_id.find_first_of("\\/:.") != std::string::npos)
				return nullptr;
			const auto rel = "icons/minimap-frames/" + a_id + ".png";
			std::error_code ec;
			if (std::filesystem::exists(std::filesystem::path("Data/PrismaUI/views/HotkeyDeck") / rel, ec))
				return rel;
			return nullptr;
		}

		std::string Text(const json& a_v)
		{
			if (a_v.is_string())
				return a_v.get<std::string>();
			if (a_v.is_boolean())
				return a_v.get<bool>() ? "1" : "0";
			if (a_v.is_number())
				return a_v.dump();
			return {};
		}

		float Num(const json& a_j, const char* a_key)
		{
			const auto it = a_j.find(a_key);
			return it != a_j.end() && it->is_number() ? it->get<float>() : -1.0f;
		}
	}

	bool Present()
	{
		return Get().present;
	}

	std::string StateJson()
	{
		const auto& api = Get();
		json        j = json::object();
		if (api.version >= 1) {
			std::vector<char> buf(256 * 1024);
			int               n = api.getState(buf.data(), static_cast<int>(buf.size()));
			if (n >= static_cast<int>(buf.size())) {
				buf.resize(static_cast<std::size_t>(n) + 1);
				n = api.getState(buf.data(), static_cast<int>(buf.size()));
			}
			if (n > 0 && n < static_cast<int>(buf.size()))
				j = json::parse(std::string(buf.data(), static_cast<std::size_t>(n)), nullptr, false);
			if (j.is_discarded() || !j.is_object())
				j = json::object();
			if (j.contains("frames") && j["frames"].is_array())
				for (auto& f : j["frames"])
					if (f.is_object())
						f["thumb"] = Thumb(f.value("id", std::string()));
		}
		j["present"] = api.present;
		j["api"] = api.version;
		j["ok"] = api.version >= 1;
		j["msg"] = !api.present ? "Detailed MiniMap is not loaded. Tick its mod in MO2 (and SKSE Menu Framework, which draws it)."
		         : api.version < 1 ? "This is the Nexus/upstream Detailed MiniMap. SkyManager drives the SkyManager build (same mod, plus an API, rectangles and frames)."
		                           : "";
		j["preview"] = previewOn;
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	void Handle(const std::string& a_payload, bool& a_push)
	{
		a_push = true;
		const auto& api = Get();
		const auto  req = json::parse(a_payload, nullptr, false);
		if (req.is_discarded() || !req.is_object() || api.version < 1)
			return;  // the state says why
		const auto op = req.value("op", std::string());
		const bool save = req.value("save", true);
		if (req.value("quiet", false))
			a_push = false;
		if (op == "set") {
			const auto it = req.find("values");
			if (it == req.end() || !it->is_object())
				return;
			int done = 0;
			for (const auto& [key, value] : it->items()) {
				if (key.size() > 64 || done >= 64)
					continue;
				const auto text = Text(value);
				if (text.size() <= 128 && api.set(key.c_str(), text.c_str()))
					++done;
				else
					SKSE::log::info("minimap-bridge: set {} refused", key);
			}
			if (save && done)
				api.save();
		} else if (op == "place") {
			const float l = Num(req, "l"), t = Num(req, "t"), w = Num(req, "w"), h = Num(req, "h");
			if (l < -0.5f || t < -0.5f || !(w > 0.0f && w <= 1.0f) || !(h > 0.0f && h <= 1.0f))
				return;
			if (api.place(l, t, w, h) && save)
				api.save();
		} else if (op == "preview") {
			previewOn = req.value("on", false);
			api.setPreview(previewOn);
		} else if (op == "reset") {
			const auto what = req.value("what", std::string());
			if (what == "map" || what == "look")
				api.reset(what.c_str());
		}
	}

	void SyncPreview(bool a_editing)
	{
		if (a_editing == previewOn)
			return;
		const auto& api = Get();
		if (api.version < 1)
			return;
		previewOn = a_editing;
		api.setPreview(previewOn);
		SKSE::log::info("minimap-bridge: preview {}", previewOn ? "on (HUD editor)" : "off");
	}
}
