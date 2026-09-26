#pragma once

// Nexus 191027 / file 808624 ONLY. This is a private, exact-binary adapter,
// not a public Custom Markers API. Evidence: docs/CUSTOM-MARKERS.md.
#include <array>
#include <cstdint>
#include <span>
#include <string_view>

namespace CustomMarkersContract
{
	inline constexpr auto CombatAction = "custom-markers-combat";
	inline constexpr std::string_view Sha256 = "0675e7c8bbddd14915dc3e89642671c951e94421a01f08161ccd2dfc240c8a16";
	inline constexpr std::uint32_t FileSize = 3905024;
	inline constexpr std::uint32_t ImageSize = 0x3C8000;
	inline constexpr std::uint32_t TimeStamp = 0x6AB0C249;
	inline constexpr std::uint32_t Version = 0x01020070; // SKSE 1.2.7.0
	inline constexpr std::uint32_t GetSettings = 0x17E30;
	inline constexpr std::uint32_t SaveSettings = 0x5D5D0;
	inline constexpr std::uint32_t Settings = 0x3A1510;
	inline constexpr std::uint32_t Initialized = 0x3A17B8; // MSVC static-init epoch
	inline constexpr std::uint32_t HideInCombat = 0x1F0;
	inline constexpr std::uint32_t BeamsVisible = 0x1EF;

	struct Fingerprint { std::uint32_t rva; std::string_view hex; };
	inline constexpr std::array<Fingerprint, 5> Fingerprints{{
		{GetSettings, "40534883ec208b0d8c11390065488b042558000000ba7c000000488b04c88b04023905619938007f0d488d05b0963800"},
		{SaveSettings, "488bc4488958104889701855574156488da828ffffff4881ecc00100000f2970d80f2978c8488b0544dc33004833c448898590000000488bd94533f6488d4de0"},
		{0x59F11, "4438aff0010000410f95c14c896c24204c8d05e82a2100488d15211f2100488d4c2470e8b7d7ffff85c00f95c08887f0010000"},
		{0x6013D, "4438b3f0010000410f95c1c644243000c6442428004c897424204c8d05b2c82000488d15ebbc2000488d4c2450e861190000"},
		{0xB2AE2, "4438a0f00100007414488b03488bcbff901807000084c00f85001c0000"}
	}};
	constexpr std::uint8_t Nibble(char c) { return static_cast<std::uint8_t>(c >= 'a' ? c - 'a' + 10 : c - '0'); }
	inline bool Matches(std::span<const std::uint8_t> image, std::uint32_t version,
		std::uint32_t timestamp, std::string_view sha256)
	{
		if(image.size() != ImageSize || version != Version || timestamp != TimeStamp || sha256 != Sha256) return false;
		for(const auto& f : Fingerprints) {
			if(f.rva > image.size() || f.hex.size() / 2 > image.size() - f.rva) return false;
			for(std::size_t n = 0; n < f.hex.size() / 2; ++n)
				if(image[f.rva + n] != static_cast<std::uint8_t>((Nibble(f.hex[n * 2]) << 4) | Nibble(f.hex[n * 2 + 1]))) return false;
		}
		return true;
	}
}
