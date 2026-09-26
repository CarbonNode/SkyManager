#pragma once

#include <cstdint>
#include <cstdio>
#include <optional>
#include <string>
#include <string_view>

namespace FaceGenPaths
{
	inline std::string Lower(std::string_view value)
	{
		std::string out(value);
		for (auto& c : out)
			if (c >= 'A' && c <= 'Z')
				c = static_cast<char>(c + ('a' - 'A'));
		return out;
	}

	inline bool ValidPlugin(std::string_view plugin)
	{
		if (plugin.size() < 5 || plugin.size() > 255 ||
			plugin.find_first_of("/\\:|*?\"<>") != std::string_view::npos)
			return false;
		for (unsigned char c : plugin)
			if (c < 32 || c == 127)
				return false;
		const auto lower = Lower(plugin);
		return lower.ends_with(".esp") || lower.ends_with(".esm") || lower.ends_with(".esl");
	}

	inline std::optional<std::uint32_t> LocalId(std::string_view fid)
	{
		if (fid.starts_with("0x") || fid.starts_with("0X"))
			fid.remove_prefix(2);
		if (fid.empty() || fid.size() > 8)
			return std::nullopt;
		std::uint32_t local = 0;
		for (char c : fid) {
			const auto digit = c >= '0' && c <= '9' ? c - '0' :
				c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
			if (digit < 0)
				return std::nullopt;
			local = local * 16 + static_cast<std::uint32_t>(digit);
		}
		return local && local <= 0xFFFFFFu ? std::optional{ local } : std::nullopt;
	}

	inline std::string Head(std::string_view plugin, std::uint32_t local)
	{
		char hex[9]{};
		std::snprintf(hex, sizeof(hex), "%08x", local);
		return "actors\\character\\facegendata\\facegeom\\" + std::string(plugin) + "\\" + hex + ".nif";
	}

	struct Result
	{
		std::string mesh;   // relative to meshes/, never changes the actor/cache identity
		bool recovered = false;
	};

	// Probe receives game-relative paths (BSResource in production). Identity
	// is read lazily, only for a missing head in a verified compatibility rule.
	// Never pick the first/only head in a folder: it can belong to another NPC.
	template <class Probe, class Identity>
	Result Resolve(std::string_view fid, std::string_view plugin, Probe probe, Identity identity)
	{
		const auto local = LocalId(fid);
		if (!local || !ValidPlugin(plugin))
			return {};
		const auto normal = Head(plugin, *local);
		if (probe("meshes\\" + normal))
			return { normal, false };   // installed/custom current head always wins

		// Verified from the real plugin and both BSAs, 2026-09-24:
		// EDID 0Caraleth, NPC local 080A, shipped FaceGeom/FaceTint local 2FA6.
		// Match the stable EDID so another compaction cannot assign her head to
		// whoever later occupies 080A. Evidence: caraleth_portrait_2026-09-24.md.
		if (Lower(plugin) != "curseofthehoundamulet.esp" || Lower(identity()) != "0caraleth")
			return {};
		const auto legacy = Head(plugin, 0x2FA6);
		if (legacy == normal || !probe("meshes\\" + legacy))
			return {};
		const auto tint = "textures\\actors\\character\\facegendata\\facetint\\" +
			std::string(plugin) + "\\00002fa6.dds";
		if (!probe(tint))
			return {};
		return { legacy, true };
	}
}
