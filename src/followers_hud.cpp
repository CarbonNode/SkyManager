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

	std::string ClampShape(const std::string& s)
	{
		return (s == "rounded" || s == "square" || s == "diamond") ? s : "circle";
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
			{ "showLevel", c.showLevel },
			{ "showDir", c.showDir },
			{ "showHp", c.showHp },
			{ "showSt", c.showSt },
			{ "showMk", c.showMk },
			{ "faceShape", ClampShape(c.faceShape) },
			{ "compact", c.compact },
			{ "compactSeeded", c.compactSeeded },
			{ "navKey", json{
				{ "device", c.navDevice },
				{ "code", c.navCode },
				{ "label", c.navLabel },
			} },
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
		out.showLevel = j.value("showLevel", out.showLevel);
		out.showDir = j.value("showDir", out.showDir);
		out.showHp = j.value("showHp", out.showHp);
		out.showSt = j.value("showSt", out.showSt);
		out.showMk = j.value("showMk", out.showMk);
		out.faceShape = ClampShape(j.value("faceShape", out.faceShape));
		// One-shot migration (2026-08-18): faces-only is the SPEC default, but
		// the first compact build persisted compact:false into every existing
		// hotkeys.json before the default flipped — so a plain j.value() read
		// would pin those files expanded forever. compactSeeded marks a config
		// that has seen the new default; until it has, the stored false is the
		// old build's write, not the player's choice, and is superseded once.
		// Build marker (hd-markers.json: "hud-compact-migrate").
		if (j.value("compactSeeded", false)) {
			out.compact = j.value("compact", out.compact);
		} else {
			out.compact = true;
			logger::info("followers-hud: compact default migrated (faces-only)");
		}
		out.compactSeeded = true;
		if (j.contains("navKey") && j["navKey"].is_object()) {
			const auto& k = j["navKey"];
			out.navDevice = k.value("device", out.navDevice);
			out.navCode = k.value("code", out.navCode);
			out.navLabel = k.value("label", out.navLabel);
		}

		if (j.contains("key") && j["key"].is_object()) {
			const auto& k = j["key"];
			out.keyDevice = k.value("device", out.keyDevice);
			out.keyCode = k.value("code", out.keyCode);
			out.keyLabel = k.value("label", out.keyLabel);
		}
	}
}
