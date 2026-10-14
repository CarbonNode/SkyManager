#pragma once

// Nexus 191027, two official files ONLY: 808624 (1.2.7) and 818288 (1.3.0).
// This is a private, exact-binary adapter, not a public Custom Markers API.
// Every value below was read out of that exact DLL (evidence:
// docs/CUSTOM-MARKERS.md). A build is used only when its hash, PE identity,
// SKSE version AND all five code fingerprints match — never "close enough":
// 1.3.0 moved the settings fields by 0x48, so the 1.2.7 offsets would write a
// random byte in its memory.
#include <array>
#include <cstdint>
#include <span>
#include <string_view>

namespace CustomMarkersContract
{
	inline constexpr auto CombatAction = "custom-markers-combat";

	struct Fingerprint { std::uint32_t rva; std::string_view hex; };

	struct Build
	{
		std::string_view name;          // "1.2.7"
		std::string_view sha256;
		std::uint32_t    fileSize;
		std::uint32_t    imageSize;
		std::uint32_t    timeStamp;
		std::uint32_t    version;       // SKSEPlugin_Version pluginVersion
		std::uint32_t    getSettings;   // Settings::GetSingleton
		std::uint32_t    saveSettings;  // Settings::Save
		std::uint32_t    settings;      // the static Settings object
		std::uint32_t    initialized;   // its MSVC static-init epoch
		std::uint32_t    hideInCombat;  // LootBeamHideInCombat, Settings+
		std::uint32_t    beamsVisible;  // LootBeamVisible, Settings+
		std::array<Fingerprint, 5> fingerprints; // getter, saver, INI load site, INI save site, renderer gate
	};

	inline constexpr std::array<Build, 2> Builds{{
		{ "1.2.7", "0675e7c8bbddd14915dc3e89642671c951e94421a01f08161ccd2dfc240c8a16",
			3905024, 0x3C8000, 0x6AB0C249, 0x01020070,
			0x17E30, 0x5D5D0, 0x3A1510, 0x3A17B8, 0x1F0, 0x1EF, {{
			{0x17E30, "40534883ec208b0d8c11390065488b042558000000ba7c000000488b04c88b04023905619938007f0d488d05b0963800"},
			{0x5D5D0, "488bc4488958104889701855574156488da828ffffff4881ecc00100000f2970d80f2978c8488b0544dc33004833c448898590000000488bd94533f6488d4de0"},
			{0x59F11, "4438aff0010000410f95c14c896c24204c8d05e82a2100488d15211f2100488d4c2470e8b7d7ffff85c00f95c08887f0010000"},
			{0x6013D, "4438b3f0010000410f95c1c644243000c6442428004c897424204c8d05b2c82000488d15ebbc2000488d4c2450e861190000"},
			{0xB2AE2, "4438a0f00100007414488b03488bcbff901807000084c00f85001c0000"} }} },
		// 1.3.0 (2026-10-11). Static analysis 2026-10-12: the bool block moved
		// +0x48 (Visible 0x237, HideInCombat 0x238). The renderer gate was
		// rewritten: with LootBeamTrackDroppedWeapons on, HideInCombat hides
		// normal loot beams but dropped-weapon beams still draw.
		{ "1.3.0", "982e530351f0d1c97be5ae920ef8992765dce02c73df58e1f9b0d7a7e545901b",
			4106240, 0x3F9000, 0x6ACBAAC0, 0x01030000,
			0x2AF80, 0x6B2B0, 0x3D1170, 0x3D1480, 0x238, 0x237, {{
			{0x2AF80, "40534883ec208b0d4ce03a0065488b042558000000baac000000488b04c88b04023905d9643a007f0d488d05c0613a00"},
			{0x6B2B0, "488bc4488958104889701855574156488da818ffffff4881ecd00100000f2970d80f2978c8488b05e4f235004833c4488985a0000000488bd94533f6488d4d00"},
			{0x67809, "4438af38020000410f95c14c896c24204c8d0520d62200488d1509c92200488d4c2460e80fd3ffff85c00f95c0888738020000"},
			{0x6DFDA, "4438b338020000410f95c1c644243000c6442428004c897424204c8d05456e2200488d152e612200488d4c2450e8241c0000"},
			{0xCB51F, "80be38020000007453488b03488bcbff901807000084c074434084ff0f8479200000"} }} },
	}};

	constexpr std::uint8_t Nibble(char c) { return static_cast<std::uint8_t>(c >= 'a' ? c - 'a' + 10 : c - '0'); }

	inline bool Matches(const Build& b, std::span<const std::uint8_t> image, std::uint32_t version,
		std::uint32_t timestamp, std::string_view sha256)
	{
		if(image.size() != b.imageSize || version != b.version || timestamp != b.timeStamp || sha256 != b.sha256) return false;
		for(const auto& f : b.fingerprints) {
			if(f.rva > image.size() || f.hex.size() / 2 > image.size() - f.rva) return false;
			for(std::size_t n = 0; n < f.hex.size() / 2; ++n)
				if(image[f.rva + n] != static_cast<std::uint8_t>((Nibble(f.hex[n * 2]) << 4) | Nibble(f.hex[n * 2 + 1]))) return false;
		}
		return true;
	}

	// The build this exact binary is, or nullptr.
	inline const Build* Identify(std::span<const std::uint8_t> image, std::uint32_t version,
		std::uint32_t timestamp, std::string_view sha256)
	{
		for(const auto& b : Builds)
			if(Matches(b, image, version, timestamp, sha256)) return &b;
		return nullptr;
	}

	// Cheap pre-check before hashing a file: does any build have this identity?
	inline const Build* Candidate(std::uint32_t imageSize, std::uint32_t timestamp, std::uint32_t version)
	{
		for(const auto& b : Builds)
			if(b.imageSize == imageSize && b.timeStamp == timestamp && b.version == version) return &b;
		return nullptr;
	}
}
