#pragma once

// ============================================================================
//  Runtime icon bridge — the PORTABLE core.
// ----------------------------------------------------------------------------
//  Everything in here is plain C++ with no Windows, no CommonLibSSE and no
//  logging, for one reason: it is the part that can be WRONG in a way a
//  play-test would only show as "the icon looks like static", so it has to be
//  testable off the rig. `tools/icon_bridge_selftest.cpp` compiles this header
//  on any host (g++ -std=c++20) and checks the BC1/BC3 decode against blocks
//  whose pixel values are known exactly, plus the CSV parse and the key/
//  filename derivation. `icon_bridge.cpp` owns the Windows half — module-path
//  resolution, the directory sweep, the cache stamp, the thread and the PNG
//  writes.
//
//  WHY THIS EXISTS AT ALL: the deck used to SHIP 1,913 PNGs sliced out of
//  Spell Hotbar 2's atlases. That art is not ours to redistribute. Spell
//  Hotbar 2 already ships the atlases and their UV tables to everyone who
//  installs it, so the deck now slices the SAME library out of the user's own
//  copy, at runtime, and redistributes nothing.
//
//  ------------------------------------------------------------------ format
//  Source: Data/SKSE/Plugins/SpellHotbar/images/<atlas>.dds + <atlas>.csv.
//  The CSVs are TAB separated with a header row, and Spell Hotbar 2's own
//  loader (skse_plugin/src/rendering/texture_csv_loader.cpp) identifies a
//  sheet by which COLUMNS it has, not by position:
//
//    spell sheet    FormID  Plugin  u0 v0 u1 v1  [Name]
//    default sheet  IconName        u0 v0 u1 v1
//    cooldown       Cooldown        u0 v0 u1 v1     <- skipped (animation strip)
//    spellproc      SpellProc       u0 v0 u1 v1     <- skipped (overlay strip)
//
//  so this parser is column-NAME driven too: a sheet with its columns in a
//  different order, or with extra columns, still reads correctly.
//
//  u/v are fractions of the atlas (0..1), NOT pixels — every rect is scaled by
//  the decoded atlas size, so a 256px sheet and a 2048px sheet both work with
//  no per-atlas knowledge.
//
//  ---------------------------------------------------------------- licensing
//  The BC1/BC2/BC3 decoders below are hand-written from the block-compression
//  format description; no third-party decoder is vendored and no third-party
//  art enters this repo. The only vendored file in the feature is
//  `src/vendor/stb_image_write.h` (public domain / MIT, Sean Barrett), used by
//  icon_bridge.cpp to encode the crops as PNG.
// ============================================================================

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include <json.hpp>

namespace IconBridgeCore
{
	// ------------------------------------------------------------ small utils

	inline std::string ToLower(std::string s)
	{
		std::transform(s.begin(), s.end(), s.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return s;
	}

	inline std::string Trim(const std::string& s)
	{
		std::size_t a = 0, b = s.size();
		auto        space = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
		while (a < b && space(static_cast<unsigned char>(s[a])))
			++a;
		while (b > a && space(static_cast<unsigned char>(s[b - 1])))
			--b;
		std::string out = s.substr(a, b - a);
		// pandas quotes a field only when it has to; unquote defensively.
		if (out.size() >= 2 && out.front() == '"' && out.back() == '"') {
			out = out.substr(1, out.size() - 2);
			std::string un;
			for (std::size_t i = 0; i < out.size(); ++i) {
				if (out[i] == '"' && i + 1 < out.size() && out[i + 1] == '"')
					++i;
				un.push_back(out[i]);
			}
			out.swap(un);
		}
		return out;
	}

	// Lowercase hex, no leading zeros — the exact key shape the view builds with
	// `(m.localId >>> 0).toString(16)` (view/MagicDeck/app.js, shKeyFor).
	inline std::string HexNoPad(std::uint32_t v)
	{
		if (v == 0)
			return "0";
		static const char* kDigits = "0123456789abcdef";
		std::string        out;
		bool               started = false;
		for (int shift = 28; shift >= 0; shift -= 4) {
			const auto nib = (v >> shift) & 0xF;
			if (nib || started) {
				out.push_back(kDigits[nib]);
				started = true;
			}
		}
		return out;
	}

	// A CSV FormID is the id as authored in the plugin (Spell Hotbar 2 hands it
	// straight to its own LookupForm-alike). Masking off the mod index gives the
	// engine's GetLocalFormID() for a full plugin (0x0002DD29 -> 0x2DD29) and is
	// a no-op for an ESL's 0x800-range ids (0x000008AE -> 0x8AE), which is why
	// one mask covers ESM, ESP and ESL alike.
	inline std::uint32_t LocalFormId(std::uint32_t raw) { return raw & 0x00FFFFFFu; }

	// Filenames end up in an <img src> inside a webview, so keep them to a
	// conservative set. Dots survive because "skyrim.esm_2dd29.png" is the
	// established name shape (an existing per-spell override in hotkeys.json
	// stores that exact path).
	inline std::string SanitizeStem(const std::string& in, std::size_t cap = 96)
	{
		std::string out;
		for (unsigned char c : in) {
			const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			                (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
			out.push_back(ok ? static_cast<char>(c) : '_');
			if (out.size() >= cap)
				break;
		}
		if (out.empty())
			out = "icon";
		// A trailing dot or a reserved device name would make an unopenable file.
		while (!out.empty() && out.back() == '.')
			out.pop_back();
		if (out.empty())
			out = "icon";
		return out;
	}

	// ------------------------------------------------------------------ image

	struct Image
	{
		int                       w = 0;
		int                       h = 0;
		std::vector<std::uint8_t> rgba;  // w*h*4, straight RGBA8

		bool        valid() const { return w > 0 && h > 0 && rgba.size() == static_cast<std::size_t>(w) * h * 4; }
		std::size_t at(int x, int y) const { return (static_cast<std::size_t>(y) * w + x) * 4; }
	};

	// --------------------------------------------------------- BC (DXT) decode
	//
	// Hand-written from the format, deliberately: a decoder is ~120 lines and
	// vendoring one would add a second licence to account for. The 5/6-bit ->
	// 8-bit expansion is the standard bit-replication (r8 = r5<<3 | r5>>2), the
	// same rule every hardware and software decoder uses.

	inline void Rgb565(std::uint16_t c, std::uint8_t& r, std::uint8_t& g, std::uint8_t& b)
	{
		const auto r5 = static_cast<std::uint8_t>((c >> 11) & 0x1F);
		const auto g6 = static_cast<std::uint8_t>((c >> 5) & 0x3F);
		const auto b5 = static_cast<std::uint8_t>(c & 0x1F);
		r = static_cast<std::uint8_t>((r5 << 3) | (r5 >> 2));
		g = static_cast<std::uint8_t>((g6 << 2) | (g6 >> 4));
		b = static_cast<std::uint8_t>((b5 << 3) | (b5 >> 2));
	}

	// One 8-byte colour block -> 16 RGBA texels (alpha 255, or 0 on the punch-
	// through index in BC1's 3-colour mode). `alwaysOpaque` is what separates
	// BC1 (mode depends on c0>c1) from the colour half of BC2/BC3, where the
	// 4-colour interpolation is used unconditionally.
	inline void DecodeColorBlock(const std::uint8_t* b, std::uint8_t out[64], bool alwaysOpaque)
	{
		const auto c0 = static_cast<std::uint16_t>(b[0] | (b[1] << 8));
		const auto c1 = static_cast<std::uint16_t>(b[2] | (b[3] << 8));

		std::uint8_t pal[4][4]{};
		Rgb565(c0, pal[0][0], pal[0][1], pal[0][2]);
		Rgb565(c1, pal[1][0], pal[1][1], pal[1][2]);
		pal[0][3] = pal[1][3] = 255;

		if (alwaysOpaque || c0 > c1) {
			for (int k = 0; k < 3; ++k) {
				pal[2][k] = static_cast<std::uint8_t>((2 * pal[0][k] + pal[1][k]) / 3);
				pal[3][k] = static_cast<std::uint8_t>((pal[0][k] + 2 * pal[1][k]) / 3);
			}
			pal[2][3] = pal[3][3] = 255;
		} else {
			for (int k = 0; k < 3; ++k)
				pal[2][k] = static_cast<std::uint8_t>((pal[0][k] + pal[1][k]) / 2);
			pal[2][3] = 255;
			pal[3][0] = pal[3][1] = pal[3][2] = 0;
			pal[3][3] = 0;  // punch-through: transparent black
		}

		const std::uint32_t bits = static_cast<std::uint32_t>(b[4]) |
		                           (static_cast<std::uint32_t>(b[5]) << 8) |
		                           (static_cast<std::uint32_t>(b[6]) << 16) |
		                           (static_cast<std::uint32_t>(b[7]) << 24);
		for (int i = 0; i < 16; ++i) {
			const auto idx = (bits >> (2 * i)) & 0x3u;
			std::memcpy(out + i * 4, pal[idx], 4);
		}
	}

	// BC3's 8-byte alpha block -> 16 alpha values.
	inline void DecodeAlphaBlock(const std::uint8_t* b, std::uint8_t out[16])
	{
		const std::uint8_t a0 = b[0], a1 = b[1];
		std::uint8_t       pal[8]{ a0, a1 };
		if (a0 > a1) {
			for (int i = 1; i <= 6; ++i)
				pal[i + 1] = static_cast<std::uint8_t>(((7 - i) * a0 + i * a1) / 7);
		} else {
			for (int i = 1; i <= 4; ++i)
				pal[i + 1] = static_cast<std::uint8_t>(((5 - i) * a0 + i * a1) / 5);
			pal[6] = 0;
			pal[7] = 255;
		}
		std::uint64_t bits = 0;
		for (int i = 0; i < 6; ++i)
			bits |= static_cast<std::uint64_t>(b[2 + i]) << (8 * i);
		for (int i = 0; i < 16; ++i)
			out[i] = pal[(bits >> (3 * i)) & 0x7u];
	}

	// BC2's 8-byte alpha block: 16 explicit 4-bit alphas, low nibble first.
	inline void DecodeAlpha4Block(const std::uint8_t* b, std::uint8_t out[16])
	{
		for (int i = 0; i < 16; ++i) {
			const auto nib = (i & 1) ? (b[i / 2] >> 4) : (b[i / 2] & 0x0F);
			out[i] = static_cast<std::uint8_t>(nib * 17);  // 0..15 -> 0..255
		}
	}

	enum class BcFormat
	{
		None,
		Bc1,  // DXT1
		Bc2,  // DXT3
		Bc3,  // DXT5
	};

	// ------------------------------------------------------------------- DDS
	//
	// Header layout (all little endian): "DDS " magic, then a 124-byte
	// DDS_HEADER whose fields we need are height@12, width@16, and the nested
	// DDS_PIXELFORMAT at 76 (flags@80, fourCC@84, rgbBitCount@88, masks@92..).
	// A "DX10" fourCC adds a 20-byte DDS_HEADER_DXT10 whose dxgiFormat@0 tells
	// us the real block format.

	inline std::uint32_t Rd32(const std::uint8_t* p) { return static_cast<std::uint32_t>(p[0]) | (p[1] << 8) | (p[2] << 16) | (static_cast<std::uint32_t>(p[3]) << 24); }

	// Decodes MIP 0 of a DDS into RGBA8. Returns false with a reason in `err`
	// for anything it does not understand — never a partial image.
	inline bool DecodeDds(const std::uint8_t* data, std::size_t size, Image& out, std::string& err,
		int maxDim = 8192)
	{
		out = Image{};
		if (!data || size < 128) {
			err = "file shorter than a DDS header";
			return false;
		}
		if (Rd32(data) != 0x20534444u) {  // 'DDS '
			err = "not a DDS (bad magic)";
			return false;
		}
		const std::uint32_t headerSize = Rd32(data + 4);
		if (headerSize != 124) {
			err = "unexpected DDS header size " + std::to_string(headerSize);
			return false;
		}
		const std::uint32_t height = Rd32(data + 12);
		const std::uint32_t width = Rd32(data + 16);
		if (width == 0 || height == 0 || width > static_cast<std::uint32_t>(maxDim) ||
			height > static_cast<std::uint32_t>(maxDim)) {
			err = "implausible atlas size " + std::to_string(width) + "x" + std::to_string(height);
			return false;
		}

		const std::uint32_t pfFlags = Rd32(data + 80);
		const std::uint32_t fourCc = Rd32(data + 84);
		std::size_t         payload = 128;
		BcFormat            fmt = BcFormat::None;

		auto cc = [](const char* s) {
			return static_cast<std::uint32_t>(static_cast<unsigned char>(s[0])) |
			       (static_cast<std::uint32_t>(static_cast<unsigned char>(s[1])) << 8) |
			       (static_cast<std::uint32_t>(static_cast<unsigned char>(s[2])) << 16) |
			       (static_cast<std::uint32_t>(static_cast<unsigned char>(s[3])) << 24);
		};

		const bool hasFourCc = (pfFlags & 0x4u) != 0;
		if (hasFourCc && fourCc == cc("DXT1"))
			fmt = BcFormat::Bc1;
		else if (hasFourCc && (fourCc == cc("DXT2") || fourCc == cc("DXT3")))
			fmt = BcFormat::Bc2;
		else if (hasFourCc && (fourCc == cc("DXT4") || fourCc == cc("DXT5")))
			fmt = BcFormat::Bc3;
		else if (hasFourCc && fourCc == cc("DX10")) {
			if (size < 148) {
				err = "DX10 header truncated";
				return false;
			}
			const std::uint32_t dxgi = Rd32(data + 128);
			payload = 148;
			switch (dxgi) {
			case 70: case 71: case 72: fmt = BcFormat::Bc1; break;
			case 73: case 74: case 75: fmt = BcFormat::Bc2; break;
			case 76: case 77: case 78: fmt = BcFormat::Bc3; break;
			default:
				err = "unsupported DXGI format " + std::to_string(dxgi);
				return false;
			}
		}

		// Everything below allocates only AFTER the format and the payload size
		// have been accepted: a refused decode must leave `out` empty, never a
		// half-filled image that a careless caller could still encode.

		// ---- uncompressed 32bpp, kept as a defensive path: a re-saved atlas
		// (some users run texture tools over their mods) is still usable.
		if (fmt == BcFormat::None) {
			const bool rgbFlag = (pfFlags & 0x40u) != 0;  // DDPF_RGB
			const std::uint32_t bits = Rd32(data + 88);
			if (!rgbFlag || bits != 32) {
				err = "unsupported pixel format (not BC1/BC2/BC3 and not 32-bit RGB)";
				return false;
			}
			const std::uint32_t rMask = Rd32(data + 92), gMask = Rd32(data + 96),
			                    bMask = Rd32(data + 100), aMask = Rd32(data + 104);
			const std::size_t need = static_cast<std::size_t>(width) * height * 4;
			if (size < payload + need) {
				err = "pixel data truncated";
				return false;
			}
			out.w = static_cast<int>(width);
			out.h = static_cast<int>(height);
			out.rgba.assign(need, 0);
			auto shiftOf = [](std::uint32_t m) {
				int s = 0;
				if (!m)
					return -1;
				while (!(m & 1u)) {
					m >>= 1;
					++s;
				}
				return s;
			};
			const int rs = shiftOf(rMask), gs = shiftOf(gMask), bs = shiftOf(bMask), as = shiftOf(aMask);
			for (std::size_t i = 0; i < static_cast<std::size_t>(width) * height; ++i) {
				const std::uint32_t px = Rd32(data + payload + i * 4);
				out.rgba[i * 4 + 0] = rs < 0 ? 0 : static_cast<std::uint8_t>((px & rMask) >> rs);
				out.rgba[i * 4 + 1] = gs < 0 ? 0 : static_cast<std::uint8_t>((px & gMask) >> gs);
				out.rgba[i * 4 + 2] = bs < 0 ? 0 : static_cast<std::uint8_t>((px & bMask) >> bs);
				out.rgba[i * 4 + 3] = as < 0 ? 255 : static_cast<std::uint8_t>((px & aMask) >> as);
			}
			return true;
		}

		// ---- block compressed
		const std::size_t blockBytes = (fmt == BcFormat::Bc1) ? 8u : 16u;
		const std::size_t bx = (width + 3) / 4, by = (height + 3) / 4;
		const std::size_t need = bx * by * blockBytes;
		if (size < payload + need) {
			err = "block data truncated (" + std::to_string(size - payload) + " of " + std::to_string(need) + " bytes)";
			return false;
		}

		out.w = static_cast<int>(width);
		out.h = static_cast<int>(height);
		out.rgba.assign(static_cast<std::size_t>(width) * height * 4, 0);

		for (std::size_t byi = 0; byi < by; ++byi) {
			for (std::size_t bxi = 0; bxi < bx; ++bxi) {
				const std::uint8_t* blk = data + payload + (byi * bx + bxi) * blockBytes;
				std::uint8_t        texels[64]{};
				std::uint8_t        alpha[16];
				bool                haveAlpha = false;

				if (fmt == BcFormat::Bc1) {
					DecodeColorBlock(blk, texels, /*alwaysOpaque*/ false);
				} else if (fmt == BcFormat::Bc2) {
					DecodeAlpha4Block(blk, alpha);
					DecodeColorBlock(blk + 8, texels, true);
					haveAlpha = true;
				} else {
					DecodeAlphaBlock(blk, alpha);
					DecodeColorBlock(blk + 8, texels, true);
					haveAlpha = true;
				}

				for (int t = 0; t < 16; ++t) {
					const std::size_t px = bxi * 4 + (t % 4);
					const std::size_t py = byi * 4 + (t / 4);
					if (px >= width || py >= height)
						continue;  // padding texels of a non-multiple-of-4 atlas
					const std::size_t o = (py * width + px) * 4;
					out.rgba[o + 0] = texels[t * 4 + 0];
					out.rgba[o + 1] = texels[t * 4 + 1];
					out.rgba[o + 2] = texels[t * 4 + 2];
					out.rgba[o + 3] = haveAlpha ? alpha[t] : texels[t * 4 + 3];
				}
			}
		}
		return true;
	}

	// -------------------------------------------------------------- UV -> crop

	struct Rect
	{
		int x = 0, y = 0, w = 0, h = 0;
	};

	// UVs are fractions of the atlas. Rounded (not truncated) because the
	// stitcher writes exact multiples of tile/atlas — 0.9999999 must land on the
	// edge, not one pixel short. Returns false for a degenerate or off-sheet
	// rect rather than emitting a 0x0 PNG.
	inline bool RectFromUv(float u0, float v0, float u1, float v1, int w, int h, Rect& out)
	{
		if (!(u0 >= -0.001f && v0 >= -0.001f && u1 <= 1.001f && v1 <= 1.001f))
			return false;
		if (!(u1 > u0 && v1 > v0))
			return false;
		auto px = [](float f, int n) {
			int v = static_cast<int>(f * static_cast<float>(n) + 0.5f);
			return std::clamp(v, 0, n);
		};
		const int x0 = px(u0, w), x1 = px(u1, w), y0 = px(v0, h), y1 = px(v1, h);
		if (x1 <= x0 || y1 <= y0)
			return false;
		out = Rect{ x0, y0, x1 - x0, y1 - y0 };
		return true;
	}

	inline bool CropTo(const Image& src, const Rect& r, Image& dst)
	{
		if (!src.valid() || r.w <= 0 || r.h <= 0)
			return false;
		if (r.x + r.w > src.w || r.y + r.h > src.h)
			return false;
		dst.w = r.w;
		dst.h = r.h;
		dst.rgba.assign(static_cast<std::size_t>(r.w) * r.h * 4, 0);
		for (int y = 0; y < r.h; ++y)
			std::memcpy(dst.rgba.data() + static_cast<std::size_t>(y) * r.w * 4,
				src.rgba.data() + src.at(r.x, r.y + y),
				static_cast<std::size_t>(r.w) * 4);
		return true;
	}

	// ------------------------------------------------------------------- CSV

	enum class SheetKind
	{
		Unknown,
		Spell,   // FormID + Plugin
		Named,   // IconName
		Skipped  // Cooldown / SpellProc strips — animation frames, not icons
	};

	struct IconRow
	{
		bool         isForm = false;
		std::string  plugin;   // spell rows only, verbatim from the CSV
		std::uint32_t formId = 0;  // spell rows only, already masked to the local id
		std::string  name;     // spell rows: the Name column; named rows: IconName
		float        u0 = 0, v0 = 0, u1 = 0, v1 = 0;
	};

	inline std::vector<std::string> SplitTabs(const std::string& line)
	{
		std::vector<std::string> out;
		std::string              cur;
		for (char c : line) {
			if (c == '\t') {
				out.push_back(cur);
				cur.clear();
			} else if (c != '\r') {
				cur.push_back(c);
			}
		}
		out.push_back(cur);
		return out;
	}

	inline bool ParseFloat(const std::string& s, float& out)
	{
		if (s.empty())
			return false;
		try {
			std::size_t used = 0;
			const float v = std::stof(s, &used);
			if (used == 0)
				return false;
			if (!(v == v))  // NaN — pandas writes empty, but be explicit
				return false;
			out = v;
			return true;
		} catch (...) {
			return false;
		}
	}

	// Column-name driven, exactly like Spell Hotbar 2's own rapidcsv loader, so
	// column order and extra columns are irrelevant. Rows whose UVs don't parse
	// are skipped (pandas leaves a blank for an icon it could not place) —
	// `skipped` reports how many, so a badly formed sheet says so in the log
	// instead of silently producing half a library.
	inline SheetKind ParseIconCsv(const std::string& text, std::vector<IconRow>& rows, std::size_t& skipped)
	{
		rows.clear();
		skipped = 0;

		std::size_t pos = 0;
		auto        nextLine = [&](std::string& line) {
            if (pos >= text.size())
                return false;
            const auto nl = text.find('\n', pos);
            line = text.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
            pos = (nl == std::string::npos) ? text.size() : nl + 1;
            return true;
		};

		std::string header;
		while (nextLine(header)) {
			if (!Trim(header).empty())
				break;
		}
		if (Trim(header).empty())
			return SheetKind::Unknown;

		const auto cols = SplitTabs(header);
		auto       indexOf = [&](const char* want) -> int {
            for (std::size_t i = 0; i < cols.size(); ++i)
                if (ToLower(Trim(cols[i])) == ToLower(want))
                    return static_cast<int>(i);
            return -1;
		};

		const int iU0 = indexOf("u0"), iV0 = indexOf("v0"), iU1 = indexOf("u1"), iV1 = indexOf("v1");
		const int iForm = indexOf("FormID"), iPlugin = indexOf("Plugin"), iName = indexOf("Name");
		const int iIcon = indexOf("IconName");
		const int iCooldown = indexOf("Cooldown"), iProc = indexOf("SpellProc");

		if (iU0 < 0 || iV0 < 0 || iU1 < 0 || iV1 < 0)
			return SheetKind::Unknown;
		if (iCooldown >= 0 || iProc >= 0)
			return SheetKind::Skipped;

		SheetKind kind = SheetKind::Unknown;
		if (iForm >= 0 && iPlugin >= 0)
			kind = SheetKind::Spell;
		else if (iIcon >= 0)
			kind = SheetKind::Named;
		else
			return SheetKind::Unknown;

		std::string line;
		while (nextLine(line)) {
			if (Trim(line).empty())
				continue;
			const auto f = SplitTabs(line);
			auto       cell = [&](int i) { return (i >= 0 && static_cast<std::size_t>(i) < f.size()) ? Trim(f[i]) : std::string(); };

			IconRow r;
			if (!ParseFloat(cell(iU0), r.u0) || !ParseFloat(cell(iV0), r.v0) ||
				!ParseFloat(cell(iU1), r.u1) || !ParseFloat(cell(iV1), r.v1)) {
				++skipped;
				continue;
			}

			if (kind == SheetKind::Spell) {
				const auto sForm = cell(iForm);
				const auto sPlug = cell(iPlugin);
				if (sForm.empty() || sPlug.empty()) {
					++skipped;
					continue;
				}
				std::uint32_t raw = 0;
				try {
					raw = static_cast<std::uint32_t>(std::stoul(sForm, nullptr, 16));
				} catch (...) {
					++skipped;
					continue;
				}
				r.isForm = true;
				r.plugin = sPlug;
				r.formId = LocalFormId(raw);
				r.name = cell(iName);
			} else {
				const auto sIcon = cell(iIcon);
				if (sIcon.empty()) {
					++skipped;
					continue;
				}
				r.isForm = false;
				r.name = sIcon;
			}
			rows.push_back(std::move(r));
		}
		return kind;
	}

	// ------------------------------------------------- index key / file naming
	//
	// These two are load-bearing for COMPATIBILITY, not just correctness: the
	// view matches a spell with `plugin.toLowerCase() + "|" + localIdHex`, and a
	// per-spell override already saved in hotkeys.json stores the FILE PATH
	// (icons/sh/<atlas>/<stem>.png). Change either and existing overrides break.

	inline std::string FormKey(const std::string& plugin, std::uint32_t localId)
	{
		return ToLower(plugin) + "|" + HexNoPad(localId);
	}

	inline std::string FormStem(const std::string& plugin, std::uint32_t localId)
	{
		return SanitizeStem(ToLower(plugin) + "_" + HexNoPad(localId));
	}

	inline std::string NamedKey(const std::string& atlas, const std::string& iconName)
	{
		return atlas + "|" + iconName;
	}

	inline std::string NamedStem(const std::string& iconName) { return SanitizeStem(iconName); }

	// Atlases that carry animation strips rather than icons. The column probe
	// above already rejects the first two by shape; the names are kept as a
	// belt-and-braces match for the build-time extractor's own skip list, and
	// `default_icons_nordic` is an ALTERNATE style sheet whose IconNames collide
	// with default_icons — including it would silently reskin every generic.
	inline bool IsSkippedAtlas(const std::string& stemLower)
	{
		return stemLower == "icons_cooldown" || stemLower == "icons_spellproc_overlay" ||
		       stemLower == "default_icons_nordic";
	}

	// ------------------------------------------------------- the build itself
	//
	// The generation LOOP lives here too, behind two callbacks (encode a crop,
	// write some bytes), so the whole pipeline — sheet in, PNGs + index out —
	// can be driven end to end by the off-rig selftest with an in-memory
	// filesystem. icon_bridge.cpp supplies the real ones (stb_image_write and
	// std::ofstream) and adds only the directory sweep, the cache stamp, the
	// thread and the logging.

	using EncodeFn = std::function<std::vector<std::uint8_t>(const Image&)>;
	// relPath is always forward-slashed and view-relative: "icons/sh/<atlas>/<stem>.png".
	using WriteFn = std::function<bool(const std::string& relPath, const std::vector<std::uint8_t>& bytes)>;

	struct BuildStats
	{
		std::size_t atlases = 0;        // sheets that produced at least one icon
		std::size_t icons = 0;          // PNGs written
		std::size_t rowsSkipped = 0;    // CSV rows with unusable UVs / ids
		std::size_t rectsRejected = 0;  // UV rects that fell outside the sheet
		std::size_t writeFailures = 0;  // encode or write refused (locked file, full disk)
		std::size_t sheetsSkipped = 0;  // cooldown / spellproc / nordic / unreadable
	};

	struct IndexAccum
	{
		nlohmann::json byForm = nlohmann::json::object();
		nlohmann::json generic = nlohmann::json::object();
		nlohmann::json catalog = nlohmann::json::array();

		nlohmann::json ToJson() const
		{
			return nlohmann::json{ { "byForm", byForm }, { "generic", generic }, { "catalog", catalog } };
		}
	};

	// One sheet -> N PNGs + N index rows. Returns false only when the sheet
	// itself was unusable (bad DDS, unparseable CSV); a bad ROW is counted, not
	// fatal, because one broken line in a mod author's sheet must not cost the
	// other 1,900 icons.
	inline bool BuildAtlas(const std::string& atlasStem, const std::vector<std::uint8_t>& dds,
		const std::string& csvText, const EncodeFn& encode, const WriteFn& write,
		IndexAccum& index, BuildStats& stats, std::string& note)
	{
		note.clear();
		if (IsSkippedAtlas(ToLower(atlasStem))) {
			note = "skipped by name (animation strip / alternate style sheet)";
			++stats.sheetsSkipped;
			return false;
		}

		std::vector<IconRow> rows;
		std::size_t          skipped = 0;
		const auto           kind = ParseIconCsv(csvText, rows, skipped);
		stats.rowsSkipped += skipped;
		if (kind == SheetKind::Skipped) {
			note = "skipped by shape (cooldown / spellproc strip)";
			++stats.sheetsSkipped;
			return false;
		}
		if (kind == SheetKind::Unknown) {
			note = "csv has no recognised columns";
			++stats.sheetsSkipped;
			return false;
		}
		if (rows.empty()) {
			note = "csv has no usable rows";
			++stats.sheetsSkipped;
			return false;
		}

		Image sheet;
		if (!DecodeDds(dds.data(), dds.size(), sheet, note)) {
			++stats.sheetsSkipped;
			return false;
		}

		const std::string dirName = SanitizeStem(atlasStem);
		const bool        isDefaultSheet = ToLower(atlasStem) == "default_icons";
		std::size_t       made = 0;

		for (const auto& r : rows) {
			Rect rect;
			if (!RectFromUv(r.u0, r.v0, r.u1, r.v1, sheet.w, sheet.h, rect)) {
				++stats.rectsRejected;
				continue;
			}
			Image crop;
			if (!CropTo(sheet, rect, crop)) {
				++stats.rectsRejected;
				continue;
			}

			const std::string stem = r.isForm ? FormStem(r.plugin, r.formId) : NamedStem(r.name);
			const std::string rel = "icons/sh/" + dirName + "/" + stem + ".png";

			const auto bytes = encode(crop);
			if (bytes.empty() || !write(rel, bytes)) {
				++stats.writeFailures;
				continue;
			}
			++made;
			++stats.icons;

			if (r.isForm) {
				const auto key = FormKey(r.plugin, r.formId);
				index.byForm[key] = rel;
				index.catalog.push_back(nlohmann::json{
					{ "file", rel },
					{ "atlas", dirName },
					{ "label", r.name.empty() ? key : r.name },
					{ "kind", "form" },
					{ "key", key } });
			} else {
				// The generic names (DESTRUCTION_FIRE_ADEPT, SHOUT_GENERIC, ...)
				// are what the view falls back to when a spell has no exact
				// match. default_icons is their home sheet and always wins;
				// anything else only fills a gap, so an "extra icons" sheet that
				// happens to reuse a name can never reskin the whole fallback
				// ladder behind the user's back.
				if (isDefaultSheet || !index.generic.contains(r.name))
					index.generic[r.name] = rel;
				index.catalog.push_back(nlohmann::json{
					{ "file", rel },
					{ "atlas", dirName },
					{ "label", r.name },
					{ "kind", "name" },
					{ "key", NamedKey(dirName, r.name) } });
			}
		}

		if (made == 0) {
			note = "no icon rect landed inside the sheet";
			++stats.sheetsSkipped;
			return false;
		}
		++stats.atlases;
		note = std::to_string(made) + " icons";
		return true;
	}
}  // namespace IconBridgeCore
