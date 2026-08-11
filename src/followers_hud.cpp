#include "followers_hud.h"

#include <algorithm>

namespace FollowersHud
{
	using json = nlohmann::json;

	static std::string ClampOrient(const std::string& s)
	{
		return s == "vert" ? "vert" : "horiz";
	}
	static std::string ClampAnchorH(const std::string& s)
	{
		return s == "right" ? "right" : "left";
	}
	static std::string ClampAnchorV(const std::string& s)
	{
		return s == "bottom" ? "bottom" : "top";
	}

	json ToJson(const Config& c)
	{
		return json{
			{ "enabled", c.enabled },
			{ "visible", c.visible },
			{ "x", c.x },
			{ "y", c.y },
			{ "scale", c.scale },
			{ "orient", ClampOrient(c.orient) },
			{ "anchorH", ClampAnchorH(c.anchorH) },
			{ "anchorV", ClampAnchorV(c.anchorV) },
			{ "showNames", c.showNames },
			{ "tickMs", c.tickMs },
			{ "maxFaces", c.maxFaces },
			{ "includeDead", c.includeDead },
			{ "key", json{
				{ "device", c.keyDevice },
				{ "code", c.keyCode },
				{ "label", c.keyLabel },
			} },
		};
	}

	void FromJson(const json& j, Config& out)
	{
		if (!j.is_object())
			return;
		out.enabled = j.value("enabled", out.enabled);
		out.visible = j.value("visible", out.visible);
		out.x = j.value("x", out.x);
		out.y = j.value("y", out.y);
		out.scale = std::clamp(j.value("scale", out.scale), 0.4f, 3.0f);
		out.orient = ClampOrient(j.value("orient", out.orient));
		out.anchorH = ClampAnchorH(j.value("anchorH", out.anchorH));
		out.anchorV = ClampAnchorV(j.value("anchorV", out.anchorV));
		out.showNames = j.value("showNames", out.showNames);
		out.tickMs = std::max<std::uint32_t>(300, j.value("tickMs", out.tickMs));
		out.maxFaces = std::clamp(j.value("maxFaces", out.maxFaces), 1, 40);
		out.includeDead = j.value("includeDead", out.includeDead);

		if (j.contains("key") && j["key"].is_object()) {
			const auto& k = j["key"];
			out.keyDevice = k.value("device", out.keyDevice);
			out.keyCode = k.value("code", out.keyCode);
			out.keyLabel = k.value("label", out.keyLabel);
		}
	}
}
