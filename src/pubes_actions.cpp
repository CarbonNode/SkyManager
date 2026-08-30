#include "pubes_actions.h"

#include "icon_bridge.h"
#include "icon_bridge_core.h"

// stb_image_write's IMPLEMENTATION lives in icon_bridge.cpp and must stay
// there — defining it twice is a duplicate-symbol link failure. Including the
// header plainly gives us the declarations (STBIWDEF is extern here), so the
// PNG writer below links against that one copy.
#include "vendor/stb_image_write.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

// pch (force-included) provides RE::/SKSE::, logger and nlohmann json (<json.hpp>).

// Windows.h (via the PCH) defines GetObject -> GetObjectA, which mangles
// RE::BSScript::Variable::GetObject() into a member that does not exist. Undo
// it locally — the house idiom, see body_physics.cpp / chim_control.cpp.
#ifdef GetObject
#	undef GetObject
#endif

// Same family of PCH damage: Windows.h defines min/max as MACROS, so every
// `std::max(a, b)` below expands to `std::(a) > (b) ? ...` and MSVC reports it
// as "C2589 '(': illegal token on right side of '::'" — which reads like a
// syntax error in OUR code and is not. The pixel work here is the first thing
// in this codebase to lean on <algorithm>, so this is the first file to need
// the undef.
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace PubesActions
{
	namespace
	{
		namespace fs = std::filesystem;
		using IconBridgeCore::Image;

		// ------------------------------------------------------------ the mod --

		constexpr const char* kPlugin = "OPubes.esp";
		constexpr const char* kModName = "OPubes NG - NPC Pubes Distributor";
		constexpr const char* kScript = "OPubesNGScript";

		// OPubes reads these two directories itself (GeneratePubicHairLists),
		// so reading the SAME paths through the VFS is what keeps the tab and
		// the mod agreeing about what exists.
		constexpr const char* kDirFemale = "Data/meshes/opubes";
		constexpr const char* kDirMale = "Data/meshes/opubes/male";

		// Bump when the BAKING math changes (crop, backdrop, size) so stale
		// tiles are purged once rather than outliving a rendering fix — the
		// item_icons generation rule, which exists because "fixed but still
		// looks wrong" was repeatedly a PNG that predated the fix.
		constexpr const char* kBakeGeneration = "pubes-v2-fullres-rect-skin";

		// TWO PASSES, because the art is a speck inside a huge texture.
		//
		// Pass 1 decodes a cheap 256-wide mip purely to MEASURE where the hair
		// is (it occupies ~9% of the width, low in the UV layout — measured on
		// this rig 2026-08-17). Pass 2 then decodes ONLY that region, at mip 0,
		// so the tile is genuine full-resolution art rather than an upscaled
		// mip: for a 4096 overlay that is roughly 370x280 px decoded instead of
		// the whole 67 MB level. Baking off a downscaled mip was visibly soft
		// once blown up, which is the whole reason the lightbox needs this.
		constexpr int kMeasureDim = 256;
		constexpr int kTileMax = 512;    // final PNG's longest side (lightbox-sized)
		constexpr int kAlphaFloor = 8;   // below this a texel is "not art"

		// If the art somehow covers most of the texture, a mip-0 region decode
		// is no longer a bargain — fall back to a level. Nothing on this rig
		// trips it; it exists so an unusual overlay cannot cost 67 MB.
		constexpr double kFullResAreaLimit = 0.10;  // fraction of the image
		constexpr int    kFallbackDim = 2048;

		// Dark hair on transparent is invisible on the deck's dark panel, so
		// the tile is composited over skin — which is also how it will actually
		// look. A mid warm tone that flatters neither black nor blonde.
		constexpr std::uint8_t kSkin[3] = { 0xD6, 0xB1, 0x95 };

		// ------------------------------------------------------- house idioms --
		// Local copies (the follower_frameworks / body_physics rule: a module
		// carries its own so none grows a dependency on another's guts).

		std::string Lower(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		std::string Trim(std::string s)
		{
			const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			return s;
		}

		bool PluginPresent(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(plugin) != nullptr ||
							 dh->LookupLoadedLightModByName(plugin) != nullptr);
		}

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			return formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
		}

		std::string Dump(const nlohmann::json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::string Reply(bool ok, const std::string& msg, const std::string& id, bool on)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id;
			j["on"] = on;
			return Dump(j);
		}

		// ------------------------------------------------------- the catalogue --

		struct Style
		{
			std::string key;    // stable, filesystem-safe; the view sends it back
			std::string name;   // "Trimmed 05"
			std::string pack;   // "Pubes Forever"
			std::string type;   // normal | stylish | hairy
			std::string tex;    // the JSON key VERBATIM — what OPubes passes on
			bool        male = false;
			bool        icon = false;  // a baked tile exists
		};

		struct Pack
		{
			std::string name;
			bool        male = false;
			int         count = 0;
			bool        ok = true;
			std::string reason;
		};

		std::mutex         g_mx;
		std::vector<Style> g_styles;
		std::vector<Pack>  g_packs;
		std::string        g_scanReason;
		std::atomic<bool>  g_scanning{ false };
		std::atomic<bool>  g_scanned{ false };

		// formId -> style key. A deck-side RECORD of what we put on whom, so
		// the tab can show the current pick; the VISUAL itself persists through
		// OPubes/NiOverride in the save, which is the part that actually has to
		// survive a reload.
		std::mutex                                   g_assignMx;
		std::unordered_map<std::uint32_t, std::string> g_assign;
		std::atomic<bool>                            g_assignLoaded{ false };

		fs::path SidecarPath()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "pubes.json";
		}

		fs::path IconDir()
		{
			const auto root = IconBridge::ModFolderRoot();
			if (root.empty())
				return {};
			return root / "PrismaUI" / "views" / "HotkeyDeck" / "icons" / "pubes";
		}

		// ---- key + label derivation ------------------------------------------

		// A stable, filesystem-safe key. Derived from the pack and the texture
		// stem, so a re-scan produces the SAME key and an already-baked tile is
		// still found (and a saved assignment still resolves).
		std::string SlugOf(const std::string& s)
		{
			std::string out;
			bool        dash = false;
			for (unsigned char c : s) {
				if (std::isalnum(c)) {
					out.push_back(static_cast<char>(std::tolower(c)));
					dash = false;
				} else if (!dash && !out.empty()) {
					out.push_back('-');
					dash = true;
				}
			}
			while (!out.empty() && out.back() == '-')
				out.pop_back();
			return out;
		}

		// "ak_05_trimmed05" -> "Trimmed 05"; "Landing Strip" -> "Landing Strip".
		// A pack-specific ordinal prefix (ak_05_) is noise, and a trailing digit
		// run reads better spaced. Anything this cannot improve is returned as
		// it came — a wrong-but-honest label beats a mangled one.
		std::string PrettyName(const std::string& stem)
		{
			std::string s = stem;

			// Drop a leading "<letters>_<digits>_" ordinal prefix.
			std::size_t i = 0;
			while (i < s.size() && std::isalpha(static_cast<unsigned char>(s[i])))
				++i;
			if (i > 0 && i < s.size() && s[i] == '_') {
				std::size_t j = i + 1;
				while (j < s.size() && std::isdigit(static_cast<unsigned char>(s[j])))
					++j;
				if (j > i + 1 && j < s.size() && s[j] == '_')
					s = s.substr(j + 1);
			}

			for (auto& c : s)
				if (c == '_' || c == '-')
					c = ' ';

			// Space a trailing digit run off the word it is glued to.
			std::size_t d = s.size();
			while (d > 0 && std::isdigit(static_cast<unsigned char>(s[d - 1])))
				--d;
			if (d > 0 && d < s.size() && s[d - 1] != ' ')
				s.insert(d, " ");

			s = Trim(s);
			if (s.empty())
				return stem;

			bool boundary = true;
			for (auto& c : s) {
				const unsigned char u = static_cast<unsigned char>(c);
				c = boundary ? static_cast<char>(std::toupper(u)) : static_cast<char>(std::tolower(u));
				boundary = (c == ' ');
			}
			return s;
		}

		// The texture path as it appears in the JSON is what OPubes hands to
		// NiOverride, so it is stored verbatim. For READING the file ourselves
		// it is already relative to the game root ("data/textures/..."), which
		// the MO2 VFS resolves — the same trick icon_bridge uses for Spell
		// Hotbar's atlases.
		fs::path TexReadPath(const std::string& tex)
		{
			std::string p = tex;
			for (auto& c : p)
				if (c == '/')
					c = '\\';
			return fs::path(p);
		}

		bool ReadFileBytes(const fs::path& p, std::vector<std::uint8_t>& out)
		{
			std::error_code ec;
			const auto      sz = fs::file_size(p, ec);
			if (ec)
				return false;
			std::ifstream f(p, std::ios::binary);
			if (!f)
				return false;
			out.resize(static_cast<std::size_t>(sz));
			if (!out.empty())
				f.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(out.size()));
			return static_cast<bool>(f);
		}

		// ---- thumbnail baking -------------------------------------------------

		// The alpha bounding box, padded. Returns false when nothing clears the
		// floor — a fully transparent overlay has no picture to show and must
		// be reported rather than baked into an empty tile.
		bool AlphaBounds(const Image& img, int pad, int& x0, int& y0, int& x1, int& y1)
		{
			x0 = img.w;
			y0 = img.h;
			x1 = -1;
			y1 = -1;
			for (int y = 0; y < img.h; ++y) {
				for (int x = 0; x < img.w; ++x) {
					if (img.rgba[(static_cast<std::size_t>(y) * img.w + x) * 4 + 3] <= kAlphaFloor)
						continue;
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
					if (y < y0) y0 = y;
					if (y > y1) y1 = y;
				}
			}
			if (x1 < 0)
				return false;
			x0 = std::max(0, x0 - pad);
			y0 = std::max(0, y0 - pad);
			x1 = std::min(img.w - 1, x1 + pad);
			y1 = std::min(img.h - 1, y1 + pad);
			return true;
		}

		// Crop -> composite over skin -> box-downscale to fit kTileMax. The
		// composite happens BEFORE the downscale so the average is of real
		// colours rather than of premultiplied-looking transparent black.
		Image MakeTile(const Image& src, int x0, int y0, int x1, int y1)
		{
			const int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
			if (cw <= 0 || ch <= 0)
				return {};

			Image flat;
			flat.w = cw;
			flat.h = ch;
			flat.rgba.assign(static_cast<std::size_t>(cw) * ch * 4, 255);
			for (int y = 0; y < ch; ++y) {
				for (int x = 0; x < cw; ++x) {
					const std::size_t s = (static_cast<std::size_t>(y + y0) * src.w + (x + x0)) * 4;
					const std::size_t d = (static_cast<std::size_t>(y) * cw + x) * 4;
					const int         a = src.rgba[s + 3];
					for (int c = 0; c < 3; ++c)
						flat.rgba[d + c] = static_cast<std::uint8_t>(
							(src.rgba[s + c] * a + kSkin[c] * (255 - a)) / 255);
					flat.rgba[d + 3] = 255;
				}
			}

			const int longest = std::max(cw, ch);
			if (longest <= kTileMax)
				return flat;

			// Integer box downscale: each destination pixel averages the source
			// box that maps to it. Good enough for a tile and dependency-free.
			const double scale = static_cast<double>(kTileMax) / longest;
			const int    dw = std::max(1, static_cast<int>(cw * scale));
			const int    dh = std::max(1, static_cast<int>(ch * scale));

			Image out;
			out.w = dw;
			out.h = dh;
			out.rgba.assign(static_cast<std::size_t>(dw) * dh * 4, 255);
			for (int y = 0; y < dh; ++y) {
				const int sy0 = y * ch / dh, sy1 = std::max(sy0 + 1, (y + 1) * ch / dh);
				for (int x = 0; x < dw; ++x) {
					const int sx0 = x * cw / dw, sx1 = std::max(sx0 + 1, (x + 1) * cw / dw);
					int       acc[3] = { 0, 0, 0 }, n = 0;
					for (int sy = sy0; sy < sy1; ++sy) {
						for (int sx = sx0; sx < sx1; ++sx) {
							const std::size_t s = (static_cast<std::size_t>(sy) * cw + sx) * 4;
							acc[0] += flat.rgba[s + 0];
							acc[1] += flat.rgba[s + 1];
							acc[2] += flat.rgba[s + 2];
							++n;
						}
					}
					const std::size_t d = (static_cast<std::size_t>(y) * dw + x) * 4;
					for (int c = 0; c < 3; ++c)
						out.rgba[d + c] = static_cast<std::uint8_t>(acc[c] / std::max(1, n));
					out.rgba[d + 3] = 255;
				}
			}
			return out;
		}

		bool WritePng(const fs::path& path, const Image& img)
		{
			if (!img.valid())
				return false;
			std::vector<std::uint8_t> mem;
			stbi_write_png_to_func(
				[](void* ctx, void* data, int len) {
					auto*       v = static_cast<std::vector<std::uint8_t>*>(ctx);
					const auto* p = static_cast<std::uint8_t*>(data);
					v->insert(v->end(), p, p + len);
				},
				&mem, img.w, img.h, 4, img.rgba.data(), img.w * 4);
			if (mem.empty())
				return false;
			std::ofstream f(path, std::ios::binary | std::ios::trunc);
			if (!f)
				return false;
			f.write(reinterpret_cast<const char*>(mem.data()), static_cast<std::streamsize>(mem.size()));
			return static_cast<bool>(f);
		}

		// Bake one style's tile if it is not already on disk. Returns whether a
		// usable tile exists afterwards.
		bool BakeTile(const Style& s, const fs::path& dir, std::string& why)
		{
			const auto out = dir / (s.key + ".png");
			std::error_code ec;
			if (fs::is_regular_file(out, ec) && !ec)
				return true;

			std::vector<std::uint8_t> dds;
			if (!ReadFileBytes(TexReadPath(s.tex), dds)) {
				why = "could not read the texture";
				return false;
			}

			// ---- pass 1: measure, on a cheap mip
			// NB `measure`, not `small`: rpcndr.h (via the PCH) defines `small`
			// as a MACRO for char, so `Image small;` compiles as `Image char;`.
			// Third member of the same family as the GetObject and min/max
			// undefs above — this one is cheaper to dodge than to undo.
			Image       measure;
			std::string err;
			if (!IconBridgeCore::DecodeDds(dds.data(), dds.size(), measure, err, 8192, kMeasureDim)) {
				why = err;
				return false;
			}
			int mx0, my0, mx1, my1;
			if (!AlphaBounds(measure, 1, mx0, my0, mx1, my1)) {
				why = "the overlay is fully transparent";
				return false;
			}

			// Normalised so pass 2 can apply it to whatever level it lands on.
			// x1/y1 are exclusive, matching NormRect's contract.
			IconBridgeCore::NormRect rect;
			rect.x0 = static_cast<double>(mx0) / measure.w;
			rect.y0 = static_cast<double>(my0) / measure.h;
			rect.x1 = static_cast<double>(mx1 + 1) / measure.w;
			rect.y1 = static_cast<double>(my1 + 1) / measure.h;

			const double area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
			const int    prefer = (area <= kFullResAreaLimit) ? 0 : kFallbackDim;

			// ---- pass 2: that region only, at full resolution
			Image img;
			if (!IconBridgeCore::DecodeDds(dds.data(), dds.size(), img, err, 8192, prefer, rect)) {
				why = err;
				return false;
			}

			// Re-tighten inside the returned window: NormRect snaps outward to
			// whole 4x4 blocks, so the crop we got carries a few pixels of slop.
			int x0, y0, x1, y1;
			if (!AlphaBounds(img, 6, x0, y0, x1, y1)) {
				// The measure pass saw art, so an empty box here means the two
				// passes disagree — use the whole window rather than fail.
				x0 = 0;
				y0 = 0;
				x1 = img.w - 1;
				y1 = img.h - 1;
			}
			const auto tile = MakeTile(img, x0, y0, x1, y1);
			if (!tile.valid()) {
				why = "the crop came out empty";
				return false;
			}
			if (!WritePng(out, tile)) {
				why = "could not write the tile";
				return false;
			}
			return true;
		}

		// Render-once-keep-forever, with a generation stamp: when the baking
		// math changes, the old tiles are wrong rather than merely old, so they
		// are purged ONCE instead of being kept forever.
		void EnsureGeneration(const fs::path& dir)
		{
			std::error_code ec;
			fs::create_directories(dir, ec);
			const auto  stampPath = dir / ".generation";
			std::string have;
			{
				std::ifstream f(stampPath);
				if (f)
					std::getline(f, have);
			}
			if (Trim(have) == kBakeGeneration)
				return;
			for (const auto& e : fs::directory_iterator(dir, ec)) {
				if (ec)
					break;
				if (e.is_regular_file() && e.path().extension() == ".png")
					fs::remove(e.path(), ec);
			}
			std::ofstream f(stampPath, std::ios::trunc);
			if (f)
				f << kBakeGeneration << "\n";
			logger::info("pubes: tile generation changed -> re-baking ({})", kBakeGeneration);
		}

		// ---- the scan ---------------------------------------------------------

		// One catalogue file: { "<texture path>": "normal|stylish|hairy", ... }.
		//
		// ⚠ OPubes abandons the WHOLE pack at the first missing texture, so a
		// half-installed pack contributes nothing in game. We mirror that
		// exactly — offering a style the mod would refuse to apply would make
		// the picker lie — and report which file broke it.
		void ScanOneFile(const fs::path& file, bool male, std::vector<Style>& styles,
			std::vector<Pack>& packs)
		{
			Pack pack;
			pack.name = PathU8(file.stem());
			pack.male = male;

			std::ifstream f(file);
			if (!f) {
				pack.ok = false;
				pack.reason = "could not be read";
				packs.push_back(pack);
				return;
			}
			nlohmann::json doc;
			try {
				f >> doc;
			} catch (const std::exception& e) {
				pack.ok = false;
				pack.reason = std::string("is not valid JSON (") + e.what() + ")";
				packs.push_back(pack);
				return;
			}
			if (!doc.is_object()) {
				pack.ok = false;
				pack.reason = "is not a JSON object of texture -> type";
				packs.push_back(pack);
				return;
			}

			std::vector<Style> mine;
			for (auto it = doc.begin(); it != doc.end(); ++it) {
				const std::string tex = it.key();
				if (!it.value().is_string())
					continue;
				const std::string type = Lower(it.value().get<std::string>());
				if (type != "normal" && type != "stylish" && type != "hairy")
					continue;  // OPubes logs and skips these too

				std::error_code ec;
				if (!fs::is_regular_file(TexReadPath(tex), ec) || ec) {
					pack.ok = false;
					pack.reason = "its textures aren't installed (" +
						PathU8(fs::path(tex).filename()) + " is missing) — OPubes skips the whole pack";
					packs.push_back(pack);
					return;
				}

				Style s;
				s.pack = pack.name;
				s.type = type;
				s.tex = tex;
				s.male = male;
				const auto stem = PathU8(fs::path(tex).stem());
				s.name = PrettyName(stem);
				s.key = SlugOf(pack.name) + "__" + SlugOf(stem) + (male ? "__m" : "");
				mine.push_back(std::move(s));
			}

			pack.count = static_cast<int>(mine.size());
			if (mine.empty()) {
				pack.ok = false;
				if (pack.reason.empty())
					pack.reason = "lists no usable styles";
			}
			packs.push_back(pack);
			styles.insert(styles.end(), mine.begin(), mine.end());
		}

		void ScanDir(const char* dir, bool male, std::vector<Style>& styles, std::vector<Pack>& packs)
		{
			std::error_code ec;
			if (!fs::is_directory(fs::path(dir), ec) || ec)
				return;
			std::vector<fs::path> files;
			for (const auto& e : fs::directory_iterator(fs::path(dir), ec)) {
				if (ec)
					break;
				if (!e.is_regular_file())
					continue;
				if (Lower(PathU8(e.path().extension())) != ".json")
					continue;
				files.push_back(e.path());
			}
			// Deterministic order, so keys and the list the view sees are stable
			// between runs regardless of what the filesystem hands back first.
			std::sort(files.begin(), files.end());
			for (const auto& f : files)
				ScanOneFile(f, male, styles, packs);
		}

		// Pure file IO + pixel work. No engine object is touched — this runs on
		// a detached background thread so a cold cache never hitches the game.
		void ScanWorker()
		{
			std::vector<Style> styles;
			std::vector<Pack>  packs;

			ScanDir(kDirFemale, false, styles, packs);
			// The male directory sits INSIDE the female one, so a plain
			// directory_iterator over kDirFemale never sees it (we do not
			// recurse) — the two calls are what keeps them separate, exactly as
			// OPubes' own two ParseJSONFiles calls do.
			ScanDir(kDirMale, true, styles, packs);

			const auto dir = IconDir();
			int        baked = 0, failed = 0;
			if (!dir.empty()) {
				EnsureGeneration(dir);
				for (auto& s : styles) {
					std::string why;
					s.icon = BakeTile(s, dir, why);
					if (s.icon) {
						++baked;
					} else {
						++failed;
						logger::warn("pubes: no tile for '{}' — {}", s.key, why);
					}
				}
			}

			int nStyles = 0, nPacks = 0;
			{
				std::lock_guard<std::mutex> lk(g_mx);
				g_styles = std::move(styles);
				g_packs = std::move(packs);
				g_scanReason.clear();
				nStyles = static_cast<int>(g_styles.size());
				nPacks = static_cast<int>(g_packs.size());
			}
			g_scanned.store(true);
			g_scanning.store(false);

			// Build marker (hd-markers.json: "pubes-tab") — one line per scan.
			logger::info("pubes: scan done — {} styles, {} packs, {} tiles ({} without art)",
				nStyles, nPacks, baked, failed);
		}

		void KickScan()
		{
			bool expected = false;
			if (!g_scanning.compare_exchange_strong(expected, true))
				return;  // already running
			std::thread(ScanWorker).detach();
		}

		// ---- the assignment sidecar -------------------------------------------

		void LoadAssignments()
		{
			if (g_assignLoaded.exchange(true))
				return;
			std::ifstream f(SidecarPath());
			if (!f)
				return;
			try {
				nlohmann::json doc;
				f >> doc;
				const auto& a = doc["assign"];
				if (!a.is_object())
					return;
				std::lock_guard<std::mutex> lk(g_assignMx);
				for (auto it = a.begin(); it != a.end(); ++it) {
					if (!it.value().is_string())
						continue;
					const auto id = static_cast<std::uint32_t>(std::stoul(it.key(), nullptr, 16));
					g_assign[id] = it.value().get<std::string>();
				}
			} catch (const std::exception& e) {
				logger::warn("pubes: pubes.json failed to parse: {}", e.what());
			}
		}

		void SaveAssignments()
		{
			nlohmann::json doc;
			doc["version"] = 1;
			auto a = nlohmann::json::object();
			{
				std::lock_guard<std::mutex> lk(g_assignMx);
				for (const auto& [id, key] : g_assign) {
					char buf[16]{};
					std::snprintf(buf, sizeof(buf), "0x%08X", id);
					a[buf] = key;
				}
			}
			doc["assign"] = a;

			std::error_code ec;
			fs::create_directories(SidecarPath().parent_path(), ec);
			std::ofstream f(SidecarPath(), std::ios::trunc);
			if (!f) {
				logger::warn("pubes: could not write pubes.json");
				return;
			}
			f << Dump(doc);
		}

		std::string AssignedKey(std::uint32_t formId)
		{
			LoadAssignments();
			std::lock_guard<std::mutex> lk(g_assignMx);
			const auto                  it = g_assign.find(formId);
			return it == g_assign.end() ? std::string{} : it->second;
		}

		void SetAssigned(std::uint32_t formId, const std::string& key)
		{
			LoadAssignments();
			{
				std::lock_guard<std::mutex> lk(g_assignMx);
				if (key.empty())
					g_assign.erase(formId);
				else
					g_assign[formId] = key;
			}
			SaveAssignments();
		}

		// ---- driving OPubes' own script ---------------------------------------

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		// The quest carrying OPubesNGScript, found by ASKING the VM which of
		// OPubes.esp's quests has it bound rather than hardcoding a local
		// FormID — a mod update that renumbers its records would silently break
		// a hardcoded id, and this costs one walk of a handful of quests.
		RE::TESQuest* OPubesQuest()
		{
			static RE::FormID cached = 0;
			if (cached) {
				auto* f = RE::TESForm::LookupByID(cached);
				if (auto* q = f ? f->As<RE::TESQuest>() : nullptr)
					return q;
				cached = 0;
			}

			auto* vm = Vm();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!vm || !dh)
				return nullptr;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return nullptr;

			for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
				if (!q)
					continue;
				const auto* file = q->GetFile(0);
				if (!file || Lower(std::string(file->GetFilename())) != Lower(kPlugin))
					continue;
				const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, q);
				if (handle == policy->EmptyHandle())
					continue;
				RE::BSTSmartPointer<RE::BSScript::Object> obj;
				if (vm->FindBoundObject(handle, kScript, obj) && obj) {
					cached = q->GetFormID();
					return q;
				}
			}
			return nullptr;
		}

		// Fire-and-forget into OPubesNGScript. The fresh fxState the bridge
		// pushes right afterwards is what tells the view whether it took — a
		// call the mod's own guards swallowed simply shows unchanged truth.
		bool CallOPubes(RE::TESQuest* quest, const char* fn, RE::Actor* actor,
			const std::string& strArg, bool boolArg, bool passBool)
		{
			auto* vm = Vm();
			if (!vm || !quest || !fn || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			// Every argument is passed EXPLICITLY: the VM builds the frame from
			// what we hand it, it does not fill in a Papyrus default for us.
			if (passBool) {
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(static_cast<RE::BSFixedString>(strArg.c_str())),
					std::move(static_cast<bool>(boolArg)));
				return vm->DispatchMethodCall(handle, kScript, fn, args, cb);
			}
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)),
				std::move(static_cast<RE::BSFixedString>(strArg.c_str())));
			return vm->DispatchMethodCall(handle, kScript, fn, args, cb);
		}

		// Returns a COPY, deliberately. A pointer into g_styles would dangle the
		// moment a concurrent Rescan swapped the vector — and Apply's Papyrus
		// dispatch happens well after the lock is released, which is exactly
		// the window that would bite.
		bool FindStyle(const std::string& key, Style& out)
		{
			std::lock_guard<std::mutex> lk(g_mx);
			for (const auto& s : g_styles) {
				if (s.key == key) {
					out = s;
					return true;
				}
			}
			return false;
		}
	}

	// ----------------------------------------------------------------- public --

	nlohmann::json PubesJson(std::uint32_t formId)
	{
		nlohmann::json j;
		const bool     present = PluginPresent(kPlugin);
		j["present"] = present;
		if (!present) {
			j["available"] = false;
			j["scanning"] = false;
			j["reason"] = std::string(kModName) + " isn't in the load order";
			j["styles"] = nlohmann::json::array();
			j["packs"] = nlohmann::json::array();
			j["current"] = nullptr;
			return j;
		}

		if (!g_scanned.load())
			KickScan();

		const bool scanning = g_scanning.load() && !g_scanned.load();
		j["scanning"] = scanning;

		auto* a = ActorFor(formId);
		const bool female = a ? (a->GetActorBase() && a->GetActorBase()->GetSex() == RE::SEX::kFemale) : true;
		j["sex"] = female ? "female" : "male";

		auto styles = nlohmann::json::array();
		auto packs = nlohmann::json::array();
		int  nNormal = 0, nStylish = 0, nHairy = 0;
		bool noPacksAtAll = true;
		{
			std::lock_guard<std::mutex> lk(g_mx);
			noPacksAtAll = g_packs.empty();
			for (const auto& s : g_styles) {
				// OPubes keys the male/female catalogues off the actor's sex, so
				// showing the other one would offer a style it will not apply.
				if (s.male == female)
					continue;
				nlohmann::json e;
				e["key"] = s.key;
				e["name"] = s.name;
				e["pack"] = s.pack;
				e["type"] = s.type;
				// Both arms must ALREADY be json: a std::string/json ternary has
				// no unique common type and MSVC rejects it (C2445).
				e["icon"] = s.icon ? nlohmann::json("icons/pubes/" + s.key + ".png")
									: nlohmann::json(nullptr);
				styles.push_back(e);
				if (s.type == "normal") ++nNormal;
				else if (s.type == "stylish") ++nStylish;
				else ++nHairy;
			}
			for (const auto& p : g_packs) {
				nlohmann::json e;
				e["name"] = p.name;
				e["sex"] = p.male ? "male" : "female";
				e["count"] = p.count;
				e["ok"] = p.ok;
				if (!p.ok)
					e["reason"] = p.reason;
				packs.push_back(e);
			}
		}

		j["styles"] = styles;
		j["packs"] = packs;
		j["counts"] = { { "normal", nNormal }, { "stylish", nStylish }, { "hairy", nHairy } };
		j["available"] = !styles.empty();
		if (styles.empty() && !scanning) {
			j["reason"] = noPacksAtAll
				? "OPubes is installed but no pube packs are — nothing to pick from"
				: "every OPubes pack on this load order is missing its textures";
		}

		const auto cur = AssignedKey(formId);
		j["current"] = cur.empty() ? nlohmann::json(nullptr) : nlohmann::json(cur);
		j["currentName"] = nullptr;
		if (!cur.empty()) {
			Style s;
			if (FindStyle(cur, s))
				j["currentName"] = s.name;
		}

		return j;
	}

	std::string Apply(std::uint32_t formId, const std::string& key)
	{
		const std::string id = "pubes:" + key;
		if (!PluginPresent(kPlugin))
			return Reply(false, std::string(kModName) + " isn't in the load order", id, true);

		Style s;
		if (!FindStyle(key, s))
			return Reply(false, g_scanned.load() ? "unknown style" : "still reading the catalogue — try again in a moment",
				id, true);
		const std::string tex = s.tex;
		const std::string name = s.name;

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, true);

		auto* quest = OPubesQuest();
		if (!quest)
			return Reply(false, "couldn't find OPubes' script — mod updated?", id, true);

		// ChangeActorPubes(Actor, String PubesTexture, Bool IgnorePlayer).
		// IgnorePlayer=false so the tab works on the player too.
		if (!CallOPubes(quest, "ChangeActorPubes", a, tex, false, true))
			return Reply(false, "OPubes refused the call", id, true);

		SetAssigned(formId, key);
		const char* raw = a->GetDisplayFullName();
		const std::string who = (raw && *raw) ? raw : "them";
		logger::info("pubes: apply '{}' to {:08X}", key, formId);
		return Reply(true, name + " — " + who, id, true);
	}

	std::string Clear(std::uint32_t formId)
	{
		const std::string id = "pubes:clear";
		if (!PluginPresent(kPlugin))
			return Reply(false, std::string(kModName) + " isn't in the load order", id, false);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, false);

		auto* quest = OPubesQuest();
		if (!quest)
			return Reply(false, "couldn't find OPubes' script — mod updated?", id, false);

		// UpdateActorPubes(Actor, String PubesType) with "Shaved" is OPubes'
		// own remove path — it restores default.dds, drops the six node
		// overrides and clears its StorageUtil flag, so its bookkeeping stays
		// in step in a way a bare override strip would not.
		if (!CallOPubes(quest, "UpdateActorPubes", a, "Shaved", false, false))
			return Reply(false, "OPubes refused the call", id, false);

		SetAssigned(formId, {});
		const char* raw = a->GetDisplayFullName();
		const std::string who = (raw && *raw) ? raw : "them";
		logger::info("pubes: clear on {:08X}", formId);
		return Reply(true, "Shaved — " + who, id, false);
	}

	std::string Rescan()
	{
		const std::string id = "pubes:rescan";
		if (!PluginPresent(kPlugin))
			return Reply(false, std::string(kModName) + " isn't in the load order", id, false);
		if (g_scanning.load())
			return Reply(false, "already reading the catalogue", id, false);
		g_scanned.store(false);
		KickScan();
		return Reply(true, "Re-reading the OPubes catalogue…", id, false);
	}
}
