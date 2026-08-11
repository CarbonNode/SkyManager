#include "portrait_capture.h"

#include "npc_actions.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <functional>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

// The game's own device and swap chain are handed to us as REX::W32 opaque
// pointers; to actually call GetBuffer/CopySubresourceRegion/Map we need the
// real COM vtables. Including <d3d11.h> and casting is the standard SKSE move —
// we never CREATE a device, so there is no d3d11.lib to link.
#include <d3d11.h>
#include <d3d11_4.h>  // ID3D11Multithread - see the grab's threading note

// windows.h — pulled in by the force-included PCH via PrismaUI_API.h, and again
// by d3d11.h — defines min/max as MACROS unless NOMINMAX was set before it. They
// swallow every std::min/std::max in this file and the diagnostics are useless
// ("illegal token on right side of '::'", then a cascade of unmatched braces).
// Undef here rather than fighting the include order.
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace PortraitCapture
{
	namespace
	{
		// Output size. The roster row draws this in a 40-128 px circle, but the
		// same file is opened full-size in the lightbox and shown on a phone, and
		// detail cannot be invented later — so capture generously and let the
		// small views downscale. An uncompressed 512 PNG is ~780 KB, which is
		// fine for a few dozen followers.
		//
		// The crop box is clamped either side so a face across a courtyard does
		// not become a 12 px smudge, and one pressed against the camera does not
		// swallow the screen.
		// 1024, not 512. At zoom 1.00 the crop is the FULL buffer height (960 on
		// this rig) and squeezing that into 512 threw away nearly half the detail —
		// so cropping to a face in the portal editor came out pixelated. With the
		// cap above the buffer, `min(kOutSize, box.size)` keeps the capture at its
		// native 960 and there is real detail to crop INTO.
		//
		// Costs ~2.7 MB per raw capture (uncompressed PNG). That is disk only, and
		// the portal re-encodes to JPEG the moment you crop one.
		constexpr int kOutSize = 1024;
		constexpr int kMinBox  = 96;
		constexpr int kMaxBox  = 900;

		// NEVER UPSCALE. The output used to be a hard 512 whatever the crop was,
		// so a face across a room — a 300 px crop — was stretched to 512 and the
		// result was a soft, faintly smeared portrait that LOOKED like a bad
		// capture. Resampling cannot invent a pore. When the crop is smaller
		// than 512 the file is written at the crop's own size instead: a sharp
		// 300 px portrait beats a blurry 512 px one every time, and the roster
		// draws it in a 40-128 px circle regardless.
		//
		// The floor stops a genuinely tiny grab becoming unusable in the
		// lightbox; below it a little softness is better than a postage stamp.
		constexpr int kMinOut = 192;

		// How much of the head to keep around the head node. The node sits at
		// the base of the skull, so the box is biased UPWARD — otherwise you
		// frame a chin and a collarbone.
		//
		// kBoxScale is a HALF-width in projected head radii, so the box spans
		// 2x it. 3.2 was the first guess and it was far too loose: the first
		// real capture logged "900x900 crop at 875,0" — the box hit the clamp
		// ceiling AND ran off the top of the screen, so the face was a small
		// part of a big picture. That, more than the pixel count, is why the
		// result read as "too small to see". 1.9 gives roughly head-plus-
		// shoulders, which is what a portrait wants.
		constexpr float kBoxScale  = 1.9f;   // half-width in projected head radii
		constexpr float kUpBias    = 0.16f;  // fraction of the box height, shifted up

		// ---------------------------------------------------------- the zoom
		// Narrowing the FOV before the grab is the one genuinely useful trick
		// CHIM uses (it sets a flat 60). It is a real resolution win: the face
		// covers more screen pixels, so the crop has detail to downscale FROM.
		//
		// But a FIXED number only frames well at one distance, and that is the
		// single biggest thing standing between this and a good headshot. On a
		// 1440p screen at fov 40, an NPC ~150 units away yields a ~900 px crop
		// (downscales to 512, sharp); the SAME NPC at ~500 units yields ~320 px,
		// which then had to be upscaled — the mush. Fixed fov cannot serve both.
		//
		// CHIM sets a flat 60 and does nothing else. After three rounds of a
		// cleverer scheme producing worse pictures, this is the number we use.
		constexpr float kCaptureFov = 60.0f;

		void Notify(const std::string& msg)
		{
			RE::DebugNotification(msg.c_str());
		}

		// ------------------------------------------------------ menus & target
		// `tm` is a TOGGLE, so it must be tracked, not fired blind. Leaving it
		// off is the worst failure this module can produce: the HUD and every
		// menu vanish, nothing responds to a keypress, and it reads as a hung
		// game. Suspected exactly that on 2026-07-31 — a capture's log ends at
		// the write with no "FOV restored" line, i.e. the delayed restore task
		// never ran, and the session was reported as "fully frozen".
		//
		// Both helpers are idempotent, so the safety task at the end of Fire()
		// can call them again without toggling the menus back OFF.
		bool g_menusHidden = false;   // main thread only

		void RunConsole(const char* cmd);

		void HideMenus()
		{
			if (g_menusHidden)
				return;
			RunConsole("tm");
			g_menusHidden = true;
		}

		void RestoreMenus()
		{
			if (!g_menusHidden)
				return;
			RunConsole("tm");
			g_menusHidden = false;
		}

		// `tfc` is the other toggle CHIM uses, and it is not decoration: setting
		// `fov` does not take effect until the camera state changes, which is
		// exactly what toggling free-camera does. Ours set the fov and never
		// toggled, so the zoom may simply never have applied. Tracked and
		// restored like the menus — leaving the player in free camera would be
		// as bad as leaving the menus off.
		bool g_freeCam = false;   // main thread only

		// `freezeTime` is what makes photo mode usable: `tfc 1` stops the world
		// so your subject holds still while you fly around her. The plain `tfc`
		// (CHIM's) is right for the fire-and-forget capture, where a frozen world
		// would be a pointless side effect the player never sees.
		void EnterFreeCam(bool freezeTime = false)
		{
			if (g_freeCam)
				return;
			RunConsole(freezeTime ? "tfc 1" : "tfc");
			g_freeCam = true;
		}

		void ExitFreeCam()
		{
			if (!g_freeCam)
				return;
			RunConsole("tfc");
			g_freeCam = false;
		}

		// Whose face to capture. 0 = "whoever the crosshair snapshot caught at
		// palette open", which is how the CHIM-tab action has always worked. The
		// Followers tab sets it explicitly so you can photograph the follower you
		// clicked rather than whatever you happen to be looking at.
		std::atomic<std::uint32_t> g_targetOverride{ 0 };

		std::uint32_t ResolveTargetId()
		{
			const auto over = g_targetOverride.load();
			return over ? over : NpcActions::TargetFormID();
		}

		// ---------------------------------------------------------------- slug
		// Byte-for-byte the rule in followers-pane.js / server.js slugOf():
		// lowercase, every run of non-alphanumerics becomes one '-', trimmed.
		// Non-ASCII is dropped rather than accent-folded: std::string here is
		// bytes, and a wrong fold would produce a slug the pane cannot match,
		// which is worse than dropping a diacritic the JS side would have
		// stripped anyway.
		std::string SlugOf(std::string_view name)
		{
			std::string out;
			out.reserve(name.size());
			bool pendingDash = false;
			for (const unsigned char c : name) {
				const bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
				if (alnum) {
					if (pendingDash && !out.empty())
						out.push_back('-');
					pendingDash = false;
					out.push_back(static_cast<char>(std::tolower(c)));
				} else {
					pendingDash = true;  // collapses runs, and trailing runs never emit
				}
			}
			return out;
		}

		// ----------------------------------------------------------- PNG output
		// A minimal, dependency-free encoder. Deflate has a "stored" (literal)
		// block mode, so a valid zlib stream is just a 2-byte header, the rows
		// chunked into <=65535-byte literal blocks, and an Adler-32. That costs
		// us compression we do not need — a 512x512 RGB portrait is ~780 KB —
		// and buys zero third-party code in a plugin loaded into the game.

		std::uint32_t Crc32(const std::uint8_t* data, std::size_t len, std::uint32_t crc = 0xFFFFFFFFu)
		{
			static std::uint32_t table[256];
			static bool          built = false;
			if (!built) {
				for (std::uint32_t n = 0; n < 256; ++n) {
					std::uint32_t c = n;
					for (int k = 0; k < 8; ++k)
						c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
					table[n] = c;
				}
				built = true;
			}
			for (std::size_t i = 0; i < len; ++i)
				crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
			return crc;
		}

		void PutU32(std::vector<std::uint8_t>& v, std::uint32_t x)
		{
			v.push_back(static_cast<std::uint8_t>(x >> 24));
			v.push_back(static_cast<std::uint8_t>(x >> 16));
			v.push_back(static_cast<std::uint8_t>(x >> 8));
			v.push_back(static_cast<std::uint8_t>(x));
		}

		void Chunk(std::vector<std::uint8_t>& out, const char tag[5], const std::vector<std::uint8_t>& body)
		{
			PutU32(out, static_cast<std::uint32_t>(body.size()));
			std::vector<std::uint8_t> crcInput;
			crcInput.reserve(4 + body.size());
			for (int i = 0; i < 4; ++i)
				crcInput.push_back(static_cast<std::uint8_t>(tag[i]));
			crcInput.insert(crcInput.end(), body.begin(), body.end());
			out.insert(out.end(), crcInput.begin(), crcInput.end());
			PutU32(out, Crc32(crcInput.data(), crcInput.size()) ^ 0xFFFFFFFFu);
		}

		// rgb: w*h*3 bytes, top-down.
		std::vector<std::uint8_t> EncodePng(const std::vector<std::uint8_t>& rgb, int w, int h)
		{
			// raw = per-row filter byte 0 + the row's bytes
			std::vector<std::uint8_t> raw;
			raw.reserve(static_cast<std::size_t>(h) * (1 + static_cast<std::size_t>(w) * 3));
			for (int y = 0; y < h; ++y) {
				raw.push_back(0);
				const auto off = static_cast<std::size_t>(y) * static_cast<std::size_t>(w) * 3;
				raw.insert(raw.end(), rgb.begin() + off, rgb.begin() + off + static_cast<std::size_t>(w) * 3);
			}

			// zlib stream: 0x78 0x01 (deflate, 32K window, no preset dict, check
			// bits chosen so the header word is a multiple of 31), then stored
			// blocks, then Adler-32 of the RAW bytes.
			std::vector<std::uint8_t> z{ 0x78, 0x01 };
			constexpr std::size_t     kBlock = 65535;
			for (std::size_t i = 0; i < raw.size(); i += kBlock) {
				const std::size_t n     = std::min(kBlock, raw.size() - i);
				const bool        final = (i + n) >= raw.size();
				z.push_back(final ? 1 : 0);
				z.push_back(static_cast<std::uint8_t>(n & 0xFF));
				z.push_back(static_cast<std::uint8_t>((n >> 8) & 0xFF));
				z.push_back(static_cast<std::uint8_t>((~n) & 0xFF));
				z.push_back(static_cast<std::uint8_t>(((~n) >> 8) & 0xFF));
				z.insert(z.end(), raw.begin() + i, raw.begin() + i + n);
			}
			std::uint32_t a = 1, b = 0;
			for (const auto byte : raw) {
				a = (a + byte) % 65521;
				b = (b + a) % 65521;
			}
			PutU32(z, (b << 16) | a);

			std::vector<std::uint8_t> png{ 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
			std::vector<std::uint8_t> ihdr;
			PutU32(ihdr, static_cast<std::uint32_t>(w));
			PutU32(ihdr, static_cast<std::uint32_t>(h));
			ihdr.push_back(8);  // bit depth
			ihdr.push_back(2);  // colour type 2 = truecolour RGB
			ihdr.push_back(0);  // deflate
			ihdr.push_back(0);  // adaptive filtering
			ihdr.push_back(0);  // no interlace
			Chunk(png, "IHDR", ihdr);
			Chunk(png, "IDAT", z);
			Chunk(png, "IEND", {});
			return png;
		}

		// 0 on success, else the Win32 error from whichever call failed.
		//
		// CreateFileW rather than std::ofstream because the REASON matters here.
		// An ofstream that will not open reports one undifferentiated `false`, and
		// that is exactly how this bug hid: "could not write the file" read like a
		// disk/permission problem when the truth was that the game had the file
		// memory-mapped. The caller branches on the code, so it has to be honest.
		std::uint32_t WriteBytes(const std::filesystem::path& path, const std::vector<std::uint8_t>& bytes)
		{
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);

			// CREATE_ALWAYS = create or truncate; share mode 0 = nobody reads a
			// half-written PNG out from under us.
			HANDLE h = ::CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
				CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
			if (h == INVALID_HANDLE_VALUE) {
				const auto err = ::GetLastError();
				return err ? err : static_cast<std::uint32_t>(ERROR_OPEN_FAILED);
			}

			DWORD      written = 0;
			const BOOL ok = ::WriteFile(h, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
			const auto err = ok ? 0u : ::GetLastError();
			::CloseHandle(h);

			if (!ok)
				return err ? err : static_cast<std::uint32_t>(ERROR_WRITE_FAULT);
			if (written != bytes.size())
				return static_cast<std::uint32_t>(ERROR_WRITE_FAULT);
			return 0;
		}

		// "Someone else has this file and will not let go."
		//
		// ERROR_USER_MAPPED_FILE is the one that actually fires here: Ultralight
		// MAPS the images it draws, and Windows refuses to truncate a mapped file
		// outright. The other three are the ordinary sharing/permission refusals —
		// all of them mean "try a different name", none of them mean "the disk is
		// broken", which is the distinction the caller needs.
		bool IsLockedError(std::uint32_t err)
		{
			return err == ERROR_USER_MAPPED_FILE ||
				   err == ERROR_SHARING_VIOLATION ||
				   err == ERROR_LOCK_VIOLATION ||
				   err == ERROR_ACCESS_DENIED;
		}

		// Seconds since the Unix epoch — the version token in `<slug>~<n>.png`.
		// Seconds (not ms) keeps the filename short and readable in the folder;
		// the caller bumps on collision, so two captures in the same second are
		// handled without needing more precision.
		std::uint64_t NowSeconds()
		{
			using namespace std::chrono;
			return static_cast<std::uint64_t>(
				duration_cast<seconds>(system_clock::now().time_since_epoch()).count());
		}

		// Best-effort tidy-up after a versioned write: drop every OTHER file that
		// resolves to this slug, so the folder does not grow a new 780 KB file on
		// every re-capture. Failures are the normal case and are ignored — the
		// file we could not overwrite is, by definition, one we cannot delete
		// either. The scanner already ignores it (newest wins), and the Deck
		// Portal sweeps the leftovers once the game is closed.
		void PruneOtherVersions(const std::filesystem::path& dir, const std::string& slug,
			const std::filesystem::path& keep)
		{
			std::error_code ec;
			std::size_t     gone = 0;
			for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
				std::error_code fec;
				if (!it->is_regular_file(fec) || it->path() == keep)
					continue;
				// Only ever delete IMAGES. Without this, anything whose stem
				// happens to resolve to the slug goes too — a note, a .txt, a
				// backup someone parked next to the portraits. Deleting a file
				// this module does not own is not a risk worth taking to save a
				// few hundred KB.
				auto ext = it->path().extension().string();
				std::transform(ext.begin(), ext.end(), ext.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".webp")
					continue;
				if (SlugFromFileStem(it->path().stem().string()) != slug)
					continue;
				if (std::filesystem::remove(it->path(), fec) && !fec)
					++gone;
			}
			if (gone)
				logger::info("portrait: pruned {} superseded file(s) for '{}'", gone, slug);
		}

		// --------------------------------------------------------- auto-levels
		// Rober asked for the CHIM look, which he described as "zooms in, focuses
		// the face, lights it up". Two of those are real; the lighting is not —
		// CHIM spawns no light for its portraits at all. But the underlying
		// complaint is: faces shot in a Skyrim interior come out murky.
		//
		// Fix it in software on the captured pixels, NOT by putting a light in
		// the world. A spawned TESObjectLIGH is a persistent dynamic reference
		// (save bloat, cleanup risk) and Candlelight attaches a visible glowing
		// orb that would land IN the shot. A histogram stretch has none of those
		// failure modes and addresses the actual problem.
		//
		// Conservative on purpose: clip 1% at each end, and refuse to stretch a
		// frame that is already well exposed (or one so flat that stretching it
		// would just amplify noise into banding).
		void AutoLevels(std::vector<std::uint8_t>& rgb)
		{
			if (rgb.size() < 3)
				return;

			std::uint32_t hist[256] = {};
			const std::size_t pixels = rgb.size() / 3;
			for (std::size_t i = 0; i < pixels; ++i) {
				// Rec. 601 luma, integer — we only need it to pick the clip points.
				const std::uint32_t y = (77u * rgb[i * 3] + 150u * rgb[i * 3 + 1] + 29u * rgb[i * 3 + 2]) >> 8;
				++hist[y > 255 ? 255 : y];
			}

			const std::uint32_t clip = static_cast<std::uint32_t>(pixels / 100);  // 1%
			std::uint32_t acc = 0;
			int lo = 0, hi = 255;
			for (int i = 0; i < 256; ++i) {
				acc += hist[i];
				if (acc > clip) { lo = i; break; }
			}
			acc = 0;
			for (int i = 255; i >= 0; --i) {
				acc += hist[i];
				if (acc > clip) { hi = i; break; }
			}

			// Too flat to stretch safely, or already using the full range.
			if (hi - lo < 24 || (lo < 8 && hi > 247))
				return;

			// Build the map once; a 320-512px square is ~100-260k pixels and a
			// per-pixel divide would be pure waste.
			std::uint8_t  map[256];
			const float   span = static_cast<float>(hi - lo);
			for (int i = 0; i < 256; ++i) {
				float v = (static_cast<float>(i) - static_cast<float>(lo)) / span;
				v = v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
				// Mild gamma lift: opens the shadows a face lives in without
				// washing out the midtones the way a straight brightness add does.
				v = std::pow(v, 0.88f);
				map[i] = static_cast<std::uint8_t>(v * 255.0f + 0.5f);
			}
			for (auto& c : rgb)
				c = map[c];
		}

		// -------------------------------------------------- expose for the face
		// AutoLevels above stretches the ENDPOINTS. That is not enough, and the
		// measurements say so: a real capture off this rig (amaniri.png, taken
		// AFTER AutoLevels had already run) came out at mean luma 75.6/255 with a
		// median of 72 — half the picture below 28% brightness — while its p1..p99
		// range was already 194 wide.
		//
		// So the image was never low-CONTRAST, it was low-KEY: the ends were
		// spread but the mass sat dark. An endpoint stretch does nothing for that
		// shape, and the 0.88 gamma was far too gentle to move it (reaching a 120
		// median from 72 needs about 0.60). This is why portraits read as murky.
		//
		// The fix is auto-exposure, and it is metered on the CENTRE — where, by
		// construction, the head is (the crop puts it at ~53% of frame). Metering
		// the whole frame would let a black interior wall drag the exposure up
		// until the face blew out, or a bright window behind them crush the face
		// into shadow. Expose for the subject, exactly as a camera does.
		//
		// NOT a light in the world: a spawned TESObjectLIGH is a persistent
		// dynamic reference (save bloat, cleanup risk) and Candlelight puts a
		// visible glowing orb IN the shot. Verified 2026-07-31 that CHIM spawns no
		// light either — across all 40 of its Papyrus sources, its portrait path
		// (AIAgentSoulGazeEffect.SendProfilePicture) is only `tm`, `fov 60`, `tfc`.
		void ExposeForFace(std::vector<std::uint8_t>& rgb, int w, int h)
		{
			if (w < 8 || h < 8 || rgb.size() < static_cast<std::size_t>(w) * h * 3)
				return;

			// Middle half of the frame, i.e. the head and not much else.
			const int x0 = w / 4, x1 = w - w / 4;
			const int y0 = h / 4, y1 = h - h / 4;
			std::vector<std::uint8_t> lum;
			lum.reserve(static_cast<std::size_t>(x1 - x0) * (y1 - y0));
			for (int y = y0; y < y1; ++y) {
				for (int x = x0; x < x1; ++x) {
					const auto* p = &rgb[(static_cast<std::size_t>(y) * w + x) * 3];
					lum.push_back(static_cast<std::uint8_t>((77u * p[0] + 150u * p[1] + 29u * p[2]) >> 8));
				}
			}
			if (lum.empty())
				return;

			// Median, not mean: a specular highlight on an eye or a bright helmet
			// trim would drag a mean around, and the thing being exposed is skin.
			std::nth_element(lum.begin(), lum.begin() + lum.size() / 2, lum.end());
			const int med = lum[lum.size() / 2];

			constexpr int kTarget = 118;   // a well-exposed midtone
			// Leave a well-exposed face alone rather than nudging every capture.
			if (med >= 96 && med <= 150) {
				logger::info("portrait: face median {} - already well exposed, no lift", med);
				return;
			}
			// Essentially black: there is no signal down there to recover, only
			// sensor-style noise and banding to amplify.
			if (med < 6) {
				logger::info("portrait: face median {} - too dark to lift safely, left alone", med);
				return;
			}

			float g = std::log(static_cast<float>(kTarget) / 255.0f) /
					  std::log(static_cast<float>(med) / 255.0f);
			// Bounded hard. An unbounded gamma on a near-black frame produces a
			// flat grey wash that looks far worse than the dark original.
			g = std::clamp(g, 0.45f, 1.25f);

			std::uint8_t map[256];
			for (int i = 0; i < 256; ++i) {
				const float v = std::pow(static_cast<float>(i) / 255.0f, g);
				map[i] = static_cast<std::uint8_t>((v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v)) * 255.0f + 0.5f);
			}
			for (auto& c : rgb)
				c = map[c];

			logger::info("portrait: face median {} -> ~{} (gamma {:.2f})", med, map[med], g);
		}

		// ----------------------------------------------------------- sharpen
		// Unsharp mask, applied ONLY after a genuine downscale.
		//
		// Box-averaging 900px down to 512 is the right filter — it is also, by
		// construction, a low-pass: it throws away exactly the high frequencies
		// that read as "detail" on eyelashes, hair and the edge of an iris. The
		// result is accurate and slightly soft. Adding a little of the
		// difference between the image and a blurred copy puts that apparent
		// crispness back.
		//
		// Deliberately gentle (0.35). Portrait sharpening is the easiest thing
		// in imaging to overdo, and a haloed, crunchy face looks far worse than
		// a soft one — especially in a 40px circle where the halo survives the
		// downscale better than the detail does.
		void Sharpen(std::vector<std::uint8_t>& rgb, int w, int h)
		{
			if (w < 3 || h < 3 || rgb.size() < static_cast<std::size_t>(w) * h * 3)
				return;
			constexpr float kAmount = 0.35f;

			const std::vector<std::uint8_t> src = rgb;
			const auto at = [&](int x, int y, int c) -> int {
				return src[(static_cast<std::size_t>(y) * w + x) * 3 + c];
			};

			// Interior only: the 1px border keeps its original pixels rather
			// than being sharpened against pixels that do not exist.
			for (int y = 1; y < h - 1; ++y) {
				for (int x = 1; x < w - 1; ++x) {
					for (int c = 0; c < 3; ++c) {
						const int sum =
							at(x - 1, y - 1, c) + at(x, y - 1, c) + at(x + 1, y - 1, c) +
							at(x - 1, y, c) + at(x, y, c) + at(x + 1, y, c) +
							at(x - 1, y + 1, c) + at(x, y + 1, c) + at(x + 1, y + 1, c);
						const float blur = static_cast<float>(sum) / 9.0f;
						const float orig = static_cast<float>(at(x, y, c));
						const float v = orig + kAmount * (orig - blur);
						rgb[(static_cast<std::size_t>(y) * w + x) * 3 + c] =
							static_cast<std::uint8_t>(v < 0.0f ? 0.0f : (v > 255.0f ? 255.0f : v));
					}
				}
			}
		}

		// ----------------------------------------------------------- tuning
		// Framing lives in a plain text file next to the portraits, NOT in the
		// binary, because "a bit more zoomed in, slightly offset" is a matter of
		// taste that takes one capture to judge and — baked into C++ — a full
		// rebuild-and-relaunch to change. Editing this file costs nothing and
		// takes effect on the very next capture.
		//
		// Editing an EXISTING file mid-session is safe under MO2: the VFS
		// snapshots the file LIST at launch, so a new file would be invisible,
		// but changing the contents of one already mapped is picked up normally.
		// The range the ini, the bridge and the view all agree on. One camera
		// stop each way is a nudge; +3 is "this cave had no light in it".
		constexpr float kExpMin = -3.0f;
		constexpr float kExpMax = 3.0f;

		// Exposure, done the way a camera does it: scale the LIGHT, not the
		// stored byte. sRGB is a display encoding, so multiplying the bytes
		// brightens midtones and shadows by different real amounts and the
		// result looks washed rather than exposed. Decode to linear, apply the
		// gain, re-encode, clamp — highlights clip exactly like an over-exposed
		// photograph, which is the behaviour the name promises.
		//
		// A 256-entry map, because a 512x512 crop is 786k channel values and a
		// per-value pow() pair is pure waste.
		void ApplyExposure(std::vector<std::uint8_t>& rgb, float stops)
		{
			if (rgb.empty() || stops == 0.0f)
				return;
			const float gain = std::pow(2.0f, std::clamp(stops, kExpMin, kExpMax));
			std::uint8_t map[256];
			for (int i = 0; i < 256; ++i) {
				const float lin = std::pow(static_cast<float>(i) / 255.0f, 2.2f) * gain;
				const float enc = std::pow(lin < 0.0f ? 0.0f : (lin > 1.0f ? 1.0f : lin), 1.0f / 2.2f);
				map[i] = static_cast<std::uint8_t>(enc * 255.0f + 0.5f);
			}
			for (auto& c : rgb)
				c = map[c];
		}

		struct Tuning
		{
			float zoom = 0.60f;   // fraction of the screen's short side to keep
			float offsetX = 0.0f; // + moves the crop RIGHT, as a fraction of that side
			float offsetY = -0.06f;
			// Exposure compensation in STOPS, applied to the captured pixels.
			// 0 = the frame exactly as the buffer had it, which stays the
			// default: this is a knob, not the automatic tone mapping that was
			// tried and reverted (see the note above EncodePng). +1 doubles the
			// light, -1 halves it, like a camera.
			float exposure = 0.0f;
		};

		// A FACE and a whole OUTFIT want opposite framing, and they were sharing
		// one setting — so tuning one broke the other. The follower portrait wants
		// the middle 60% biased upward, because it is a head. An outfit photo
		// wants the WHOLE frame: the deck draws outfit art at aspect-ratio 3/4 and
		// the subject is a standing person, so cropping to 60% of the height cuts
		// her off at the waist no matter where you stand.
		//
		// Same file, separate keys, separate defaults.
		struct TuneKeys
		{
			const char* zoom;
			const char* offX;
			const char* offY;
			float       defZoom;
			float       defX;
			float       defY;
			const char* expo;
		};
		constexpr TuneKeys kFaceKeys{ "zoom", "offsetx", "offsety", 0.60f, 0.0f, -0.06f, "exposure" };
		constexpr TuneKeys kPhotoKeys{ "photozoom", "photooffsetx", "photooffsety", 1.00f, 0.0f, 0.0f, "photoexposure" };

		Tuning ReadTuning(const std::filesystem::path& dir, const TuneKeys& keys = kFaceKeys)
		{
			Tuning          t;
			t.zoom = keys.defZoom;
			t.offsetX = keys.defX;
			t.offsetY = keys.defY;
			std::error_code ec;
			const auto      file = dir / "capture.ini";

			if (!std::filesystem::exists(file, ec)) {
				// Write it out the first time, so the knobs are discoverable
				// rather than something you have to be told about.
				std::filesystem::create_directories(dir, ec);
				const std::string seed =
					"; Portrait framing. Edit and take another portrait - no restart needed.\r\n"
					";\r\n"
					"; zoom    = how much of the screen to keep, 0.2 (very tight) .. 1.0 (whole frame).\r\n"
					";           Smaller = more zoomed in. 0.60 keeps the middle 60%.\r\n"
					"; offsetx = shift the crop sideways. Negative = LEFT, positive = RIGHT.\r\n"
					"; offsety = shift the crop up/down.  Negative = UP,   positive = DOWN.\r\n"
					";           Both are fractions of the screen height, so 0.05 is a small nudge.\r\n"
					"\r\n"
					"zoom=0.60\r\n"
					"offsetx=0.00\r\n"
					"offsety=-0.06\r\n"
					"\r\n"
					"; --- WARDROBE PHOTOS (right-click an outfit) are framed separately, ---\r\n"
					"; because a whole outfit wants the frame a face does not. 1.00 keeps the\r\n"
					"; full height, which is what fits a standing person.\r\n"
					"photozoom=1.00\r\n"
					"photooffsetx=0.00\r\n"
					"photooffsety=0.00\r\n"
					"\r\n"
					"; --- EXPOSURE, in stops. 0 = the frame exactly as it was rendered. ---\r\n"
					"; +1 doubles the light, -1 halves it, like a camera. Use it when a place\r\n"
					"; or a face is shot somewhere genuinely dark; the picture cannot invent\r\n"
					"; detail that was never rendered, so large lifts go grey and noisy.\r\n"
					"exposure=0.00\r\n"
					"photoexposure=0.00\r\n";
				std::vector<std::uint8_t> bytes(seed.begin(), seed.end());
				WriteBytes(file, bytes);
				return t;
			}

			std::ifstream in(file);
			if (!in.is_open())
				return t;
			std::string line;
			while (std::getline(in, line)) {
				const auto hash = line.find_first_of(";#");
				if (hash != std::string::npos)
					line.erase(hash);
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				std::string key = line.substr(0, eq);
				std::string val = line.substr(eq + 1);
				const auto trim = [](std::string& s) {
					const auto b = s.find_first_not_of(" \t\r\n");
					const auto e = s.find_last_not_of(" \t\r\n");
					s = (b == std::string::npos) ? std::string() : s.substr(b, e - b + 1);
				};
				trim(key);
				trim(val);
				std::transform(key.begin(), key.end(), key.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (val.empty())
					continue;
				const float f = std::strtof(val.c_str(), nullptr);
				// Clamped, so a typo cannot produce a zero-size or off-screen crop.
				if (key == keys.zoom)
					t.zoom = std::clamp(f, 0.15f, 1.0f);
				else if (key == keys.offX)
					t.offsetX = std::clamp(f, -0.5f, 0.5f);
				else if (key == keys.offY)
					t.offsetY = std::clamp(f, -0.5f, 0.5f);
				else if (keys.expo && key == keys.expo)
					t.exposure = std::clamp(f, kExpMin, kExpMax);
			}
			return t;
		}

		// Rewrite ONE key set in capture.ini, leaving everything else — the other
		// key set, the comments that make the knobs discoverable, any hand-added
		// line — exactly as it was. A regenerate-from-scratch would silently drop
		// the wardrobe-photo framing the moment you nudged a face, and throw away
		// the explanatory header that is the only documentation these knobs have.
		//
		// Matching is on the same relaxed rules ReadTuning parses with (case
		// folded, whitespace anywhere, ';'/'#' comments), so a key the player
		// typed as " Zoom = 0.7 " is REPLACED rather than duplicated — two lines
		// for one key would leave the file's meaning depending on read order.
		bool WriteTuning(const std::filesystem::path& dir, const TuneKeys& keys, const Tuning& t)
		{
			std::error_code ec;
			std::filesystem::create_directories(dir, ec);
			const auto file = dir / "capture.ini";

			// Seed the file (with its comments) if it has never been written, so
			// the first in-game nudge produces the documented file too.
			if (!std::filesystem::exists(file, ec))
				ReadTuning(dir, keys);

			std::vector<std::string> lines;
			{
				std::ifstream in(file);
				std::string   line;
				while (std::getline(in, line)) {
					if (!line.empty() && line.back() == '\r')
						line.pop_back();
					lines.push_back(line);
				}
			}

			const auto keyOf = [](const std::string& raw) -> std::string {
				std::string l = raw;
				const auto  hash = l.find_first_of(";#");
				if (hash != std::string::npos)
					l.erase(hash);
				const auto eq = l.find('=');
				if (eq == std::string::npos)
					return {};
				std::string k = l.substr(0, eq);
				const auto  b = k.find_first_not_of(" \t");
				const auto  e = k.find_last_not_of(" \t");
				k = (b == std::string::npos) ? std::string() : k.substr(b, e - b + 1);
				std::transform(k.begin(), k.end(), k.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				return k;
			};

			const auto fmt = [](const char* k, float v) {
				char buf[64];
				std::snprintf(buf, sizeof(buf), "%s=%.3f", k, static_cast<double>(v));
				return std::string(buf);
			};

			bool wroteZoom = false, wroteX = false, wroteY = false, wroteExp = false;
			for (auto& line : lines) {
				const auto k = keyOf(line);
				if (k == keys.zoom)      { line = fmt(keys.zoom, t.zoom);    wroteZoom = true; }
				else if (k == keys.offX) { line = fmt(keys.offX, t.offsetX); wroteX = true; }
				else if (k == keys.offY) { line = fmt(keys.offY, t.offsetY); wroteY = true; }
				else if (keys.expo && k == keys.expo) { line = fmt(keys.expo, t.exposure); wroteExp = true; }
			}
			if (!wroteZoom) lines.push_back(fmt(keys.zoom, t.zoom));
			if (!wroteX)    lines.push_back(fmt(keys.offX, t.offsetX));
			if (!wroteY)    lines.push_back(fmt(keys.offY, t.offsetY));
			if (keys.expo && !wroteExp) lines.push_back(fmt(keys.expo, t.exposure));

			std::string out;
			for (const auto& line : lines) {
				out += line;
				out += "\r\n";
			}
			std::vector<std::uint8_t> bytes(out.begin(), out.end());
			// Same lock-aware writer the portraits use: capture.ini is not drawn
			// by the view so it is never memory-mapped, but sharing one path means
			// one place to fix if that ever stops being true.
			if (!WriteBytes(file, bytes)) {
				logger::warn("portrait: could not write capture.ini");
				return false;
			}
			logger::info("portrait: framing saved - {}={:.3f} {}={:.3f} {}={:.3f}",
				keys.zoom, t.zoom, keys.offX, t.offsetX, keys.offY, t.offsetY);
			return true;
		}

		// ------------------------------------------------------- head geometry
		// Head node names differ between vanilla, custom races and some body
		// replacers; try the usual suspects before falling back to the actor's
		// own height. The fallback still gives a usable portrait — it is only
		// less exact about where the chin is.
		RE::NiAVObject* HeadNode(RE::Actor* actor)
		{
			static const char* kNames[] = {
				"NPC Head [Head]", "NPCHead [Head]", "NPC Head", "Head",
				"BSFaceGenNiNodeSkinned", "NPC Neck [Neck]"
			};
			for (const auto* n : kNames) {
				if (auto* node = actor->GetNodeByName(n))
					return node;
			}
			return nullptr;
		}

		struct Box
		{
			int  x = 0, y = 0, size = 0;
			bool ok = false;
		};

		// Where the head lands on screen, and how big it is there, AT THE FOV
		// CURRENTLY IN EFFECT. Split out from HeadBox so the zoom step can take
		// the same measurement before deciding what fov to ask for.
		struct HeadProj
		{
			float px = 0.0f;           // pixels, top-left origin
			float py = 0.0f;
			float pixelRadius = 0.0f;  // projected head radius, in pixels
			bool  ok = false;
		};

		HeadProj ProjectHead(RE::Actor* actor, int screenW, int screenH)
		{
			HeadProj out;
			auto*    cam = RE::Main::WorldRootCamera();
			if (!cam)
				return out;

			RE::NiPoint3 head;
			float        radius = 12.0f;  // Skyrim units; a human head is ~12-14
			if (auto* node = HeadNode(actor)) {
				head = node->world.translate;
				// The node's own bound radius is the honest size when it has one.
				if (node->worldBound.radius > 1.0f)
					radius = node->worldBound.radius;
			} else {
				// Fallback: the actor's origin plus most of their height.
				head = actor->GetPosition();
				const float h = actor->GetHeight();
				head.z += (h > 1.0f ? h : 120.0f) * 0.92f;
			}

			const auto& rt   = cam->GetRuntimeData();
			const auto& rt2  = cam->GetRuntimeData2();
			const auto& port = rt2.port;

			float hx = 0, hy = 0, hz = 0;
			if (!RE::NiCamera::WorldPtToScreenPt3(rt.worldToCam, port, head, hx, hy, hz, 1e-5f))
				return out;
			// z <= 0 means behind the camera — the projection still returns
			// coordinates, they are just nonsense.
			if (hz <= 0.0f)
				return out;

			// A second point one radius above the head gives the on-screen scale
			// without needing the FOV: the pixel gap IS the projected radius.
			RE::NiPoint3 above = head;
			above.z += radius;
			float ax = 0, ay = 0, az = 0;
			if (RE::NiCamera::WorldPtToScreenPt3(rt.worldToCam, port, above, ax, ay, az, 1e-5f) && az > 0.0f)
				out.pixelRadius = std::abs(ay - hy) * static_cast<float>(screenH);

			// WorldPtToScreenPt3 returns normalised coordinates with y measured
			// from the BOTTOM; the back buffer is top-down.
			out.px = hx * static_cast<float>(screenW);
			out.py = (1.0f - hy) * static_cast<float>(screenH);
			out.ok = true;
			return out;
		}

		// Size a square around a projected head.
		Box BoxFrom(const HeadProj& hp, int screenW, int screenH)
		{
			Box box;
			if (!hp.ok)
				return box;
			const float px = hp.px;
			const float py = hp.py;

			int size = static_cast<int>(hp.pixelRadius * kBoxScale * 2.0f);
			if (size <= 0)
				size = kMinBox * 2;  // projection gave us nothing usable

			// kMaxBox is what the ZOOM aims for, NOT a ceiling on the crop — and
			// clamping to it here was cutting into the face. Proven by a real
			// capture on 2026-07-31: standing close, the head projected a 673 px
			// RADIUS (1346 px across) and the box was clamped to 900, so the crop
			// was smaller than the head it was supposed to contain. The zoom
			// cannot rescue that case either, because widening past the player's
			// own FOV is the one thing it refuses to do.
			//
			// The only real ceiling is the screen. A bigger grab costs a slightly
			// steeper downscale to 512, which box-averaging handles fine, and
			// yields MORE source detail rather than less.
			size = std::clamp(size, kMinBox, std::min(screenW, screenH));

			int x = static_cast<int>(px) - size / 2;
			int y = static_cast<int>(py) - size / 2 - static_cast<int>(size * kUpBias);

			// Nudge a box that runs off an edge back on screen rather than
			// failing: a face near the edge is still a fine portrait.
			x = std::clamp(x, 0, screenW - size);
			y = std::clamp(y, 0, screenH - size);

			box.x = x;
			box.y = y;
			box.size = size;
			box.ok = true;
			return box;
		}

		// ------------------------------------------------------ frame grabbing
		// Copies ONLY the crop rectangle out of the back buffer, so the staging
		// texture is a few hundred KB rather than a full 4K frame.
		// ------------------------------------------------------- pixel formats
		// How to read ONE pixel, per swap-chain format. The old code hardcoded
		// "4 bytes, BGRA or RGBA" and silently produced garbage on anything else.
		struct PixFmt
		{
			int  stride = 0;      // bytes per pixel; 0 = unsupported
			bool supported() const { return stride > 0; }
		};

		float HalfToFloat(std::uint16_t h)
		{
			const std::uint32_t sign = (h >> 15) & 0x1u;
			std::uint32_t       exp = (h >> 10) & 0x1Fu;
			std::uint32_t       man = h & 0x3FFu;
			if (exp == 0) {
				if (man == 0)
					return sign ? -0.0f : 0.0f;
				// subnormal — normalise it
				while (!(man & 0x400u)) { man <<= 1; --exp; }
				++exp;
				man &= 0x3FFu;
			} else if (exp == 31) {
				return sign ? -INFINITY : INFINITY;
			}
			const std::uint32_t bits = (sign << 31) | ((exp + 112u) << 23) | (man << 13);
			float               f;
			std::memcpy(&f, &bits, sizeof(f));
			return f;
		}

		std::uint8_t LinearToSrgb8(float v)
		{
			v = v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
			// The float back buffer is LINEAR light; writing it raw yields a dark,
			// flat image. Encode it the way a display would.
			const float s = (v <= 0.0031308f) ? (v * 12.92f) : (1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f);
			return static_cast<std::uint8_t>(s * 255.0f + 0.5f);
		}

		PixFmt FormatOf(DXGI_FORMAT f)
		{
			switch (f) {
			case DXGI_FORMAT_B8G8R8A8_UNORM:
			case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
			case DXGI_FORMAT_B8G8R8X8_UNORM:
			case DXGI_FORMAT_R8G8B8A8_UNORM:
			case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
				return { 4 };
			case DXGI_FORMAT_R10G10B10A2_UNORM:
				return { 4 };
			case DXGI_FORMAT_R16G16B16A16_FLOAT:
				return { 8 };
			case DXGI_FORMAT_R11G11B10_FLOAT:
				return { 4 };
			default:
				return { 0 };
			}
		}

		// Decode one pixel to 8-bit RGB.
		void ReadPixel(const std::uint8_t* p, DXGI_FORMAT f, std::uint8_t& r, std::uint8_t& g, std::uint8_t& b)
		{
			switch (f) {
			case DXGI_FORMAT_B8G8R8A8_UNORM:
			case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
			case DXGI_FORMAT_B8G8R8X8_UNORM:
				b = p[0]; g = p[1]; r = p[2];
				return;
			case DXGI_FORMAT_R8G8B8A8_UNORM:
			case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
				r = p[0]; g = p[1]; b = p[2];
				return;
			case DXGI_FORMAT_R10G10B10A2_UNORM: {
				std::uint32_t v;
				std::memcpy(&v, p, sizeof(v));
				r = static_cast<std::uint8_t>(((v >> 0) & 0x3FFu) >> 2);
				g = static_cast<std::uint8_t>(((v >> 10) & 0x3FFu) >> 2);
				b = static_cast<std::uint8_t>(((v >> 20) & 0x3FFu) >> 2);
				return;
			}
			case DXGI_FORMAT_R16G16B16A16_FLOAT: {
				std::uint16_t h[3];
				std::memcpy(h, p, sizeof(h));
				r = LinearToSrgb8(HalfToFloat(h[0]));
				g = LinearToSrgb8(HalfToFloat(h[1]));
				b = LinearToSrgb8(HalfToFloat(h[2]));
				return;
			}
			case DXGI_FORMAT_R11G11B10_FLOAT: {
				std::uint32_t v;
				std::memcpy(&v, p, sizeof(v));
				// 11/11/10 packed floats: no sign bit, 5-bit exponents.
				const auto un11 = [](std::uint32_t x) {
					return HalfToFloat(static_cast<std::uint16_t>(((x & 0x7C0u) << 4) | ((x & 0x3Fu) << 4)));
				};
				const auto un10 = [](std::uint32_t x) {
					return HalfToFloat(static_cast<std::uint16_t>(((x & 0x3E0u) << 5) | ((x & 0x1Fu) << 5)));
				};
				r = LinearToSrgb8(un11((v >> 0) & 0x7FFu));
				g = LinearToSrgb8(un11((v >> 11) & 0x7FFu));
				b = LinearToSrgb8(un10((v >> 22) & 0x3FFu));
				return;
			}
			default:
				r = g = b = 0;
				return;
			}
		}

		// The render target's real size. Distinct from GetScreenSize(), which
		// reports the DISPLAY: with any upscaler (DLSS/FSR) or an ENB downscale
		// the buffer is smaller, and every crop must be expressed in ITS pixels.
		bool BackBufferSize(int& w, int& h)
		{
			auto* window = RE::BSGraphics::Renderer::GetCurrentRenderWindow();
			if (!window || !window->swapChain)
				return false;
			auto*            swap = reinterpret_cast<IDXGISwapChain*>(window->swapChain);
			ID3D11Texture2D* back = nullptr;
			if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&back))) || !back)
				return false;
			D3D11_TEXTURE2D_DESC d{};
			back->GetDesc(&d);
			back->Release();
			w = static_cast<int>(d.Width);
			h = static_cast<int>(d.Height);
			return w > 0 && h > 0;
		}

		bool GrabRegion(const Box& box, std::vector<std::uint8_t>& rgbOut, int outSize)
		{
			auto* window = RE::BSGraphics::Renderer::GetCurrentRenderWindow();
			if (!window || !window->swapChain)
				return false;
			auto* device = RE::BSGraphics::Renderer::GetDevice();
			if (!device)
				return false;

			auto* swap = reinterpret_cast<IDXGISwapChain*>(window->swapChain);
			auto* dev  = reinterpret_cast<ID3D11Device*>(device);

			ID3D11Texture2D* back = nullptr;
			if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&back))) || !back)
				return false;

			D3D11_TEXTURE2D_DESC desc{};
			back->GetDesc(&desc);

			// The back buffer's FORMAT was assumed (BGRA8, 4 bytes per pixel) and
			// never checked. That assumption is wrong on an ENB rig, where the
			// swap chain is routinely R10G10B10A2 or RGBA16F — and reading 8-byte
			// pixels as 4-byte ones produces exactly the striped garbage a real
			// capture produced on 2026-07-31. Log it so the next capture says what
			// this rig actually uses instead of leaving us to guess.
			logger::info("portrait: backbuffer {}x{} fmt={} samples={} | crop {}px at {},{}",
				desc.Width, desc.Height, static_cast<int>(desc.Format), desc.SampleDesc.Count,
				box.size, box.x, box.y);

			// MSAA cannot be CopySubresourceRegion'd into a non-MSAA staging
			// texture; it needs ResolveSubresource first. Rather than silently
			// hand back rubbish, say so.
			if (desc.SampleDesc.Count > 1) {
				logger::warn("portrait: backbuffer is {}x MSAA - cannot copy directly", desc.SampleDesc.Count);
				back->Release();
				return false;
			}

			// Clamp once more against the ACTUAL buffer: the render window's
			// reported size and the buffer can disagree (borderless, DSR, an
			// upscaler), and a box past the edge makes CopySubresourceRegion a
			// silent no-op that would hand back a black square.
			Box b = box;
			b.size = std::min<int>(b.size, static_cast<int>(std::min(desc.Width, desc.Height)));
			b.x = std::clamp(b.x, 0, static_cast<int>(desc.Width) - b.size);
			b.y = std::clamp(b.y, 0, static_cast<int>(desc.Height) - b.size);

			D3D11_TEXTURE2D_DESC sd = desc;
			sd.Width = static_cast<UINT>(b.size);
			sd.Height = static_cast<UINT>(b.size);
			sd.MipLevels = 1;
			sd.ArraySize = 1;
			sd.SampleDesc.Count = 1;
			sd.SampleDesc.Quality = 0;
			sd.Usage = D3D11_USAGE_STAGING;
			sd.BindFlags = 0;
			sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
			sd.MiscFlags = 0;

			ID3D11Texture2D* staging = nullptr;
			if (FAILED(dev->CreateTexture2D(&sd, nullptr, &staging)) || !staging) {
				back->Release();
				return false;
			}

			ID3D11DeviceContext* ctx = nullptr;
			dev->GetImmediateContext(&ctx);
			if (!ctx) {
				staging->Release();
				back->Release();
				return false;
			}

			// ---- THE THREADING RULE THIS CODE BROKE ------------------------
			// A D3D11 IMMEDIATE context is explicitly NOT thread-safe, and this
			// runs on the SKSE task thread while Skyrim's renderer is using that
			// very context on its own thread. Two threads issuing commands into
			// one context is undefined behaviour, and the way it actually fails
			// is a null dereference deep inside the vendor's user-mode driver on
			// a DRIVER worker thread -- which is exactly the crash on 2026-08-02
			// 19:18:55: EXCEPTION_ACCESS_VIOLATION at nvwgf2umx.dll+018BBFB,
			// `mov rcx,[rdx+0x10]` with RDX 0, an 18-frame stack that is entirely
			// nvwgf2umx bottoming out in BaseThreadInitThunk. Our own log stops
			// between "backbuffer ..." and "reading N bytes/px" -- i.e. inside
			// exactly this block. It "worked" dozens of times first because a
			// data race is a race: the successful capture two minutes earlier
			// proves nothing about the next one.
			//
			// ID3D11Multithread is the documented fix, and it needs BOTH halves:
			//  * SetMultithreadProtected(TRUE) makes the DRIVER take its own lock
			//    inside every context call -- including the renderer's, which is
			//    the half we do not control and cannot wrap.
			//  * Enter()/Leave() holds that same lock across our whole
			//    copy -> Map -> read -> Unmap sequence, so the renderer cannot
			//    interleave BETWEEN our copy and our map and leave us reading a
			//    surface it has since reused.
			// Protection is left ON afterwards on purpose: switching it back off
			// would re-open the race for any call already in flight, and the cost
			// is a lock the driver takes anyway once any overlay enables it.
			ID3D11Multithread* mt = nullptr;
			if (SUCCEEDED(ctx->QueryInterface(__uuidof(ID3D11Multithread), reinterpret_cast<void**>(&mt))) && mt) {
				if (!mt->GetMultithreadProtected()) {
					mt->SetMultithreadProtected(TRUE);
					logger::info("portrait: enabled D3D11 multithread protection on the immediate context");
				}
				mt->Enter();
			} else {
				// No lock available: a grab here is a coin flip against the
				// renderer, and losing it is a hard CTD rather than a bad photo.
				// Refusing is the only honest option -- and it is visible, unlike
				// a crash five minutes later that reads as "the game is unstable".
				logger::error("portrait: ID3D11Multithread unavailable - refusing the grab rather than racing the renderer");
				ctx->Release();
				staging->Release();
				back->Release();
				return false;
			}
			// Releases the driver lock however this scope is left, including the
			// early `return false` paths below and any exception.
			struct MtGuard {
				ID3D11Multithread* m;
				~MtGuard() { if (m) { m->Leave(); m->Release(); } }
			} mtGuard{ mt };

			D3D11_BOX region{};
			region.left = static_cast<UINT>(b.x);
			region.top = static_cast<UINT>(b.y);
			region.front = 0;
			region.right = static_cast<UINT>(b.x + b.size);
			region.bottom = static_cast<UINT>(b.y + b.size);
			region.back = 1;
			ctx->CopySubresourceRegion(staging, 0, 0, 0, 0, back, 0, &region);

			D3D11_MAPPED_SUBRESOURCE mapped{};
			bool ok = SUCCEEDED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped)) && mapped.pData;
			// A zero row pitch means every output row would read the SAME source
			// bytes — which is precisely the all-rows-identical striping a real
			// capture produced. Catch it here rather than write it to disk.
			if (ok && mapped.RowPitch == 0) {
				logger::warn("portrait: Map returned RowPitch 0 - refusing the frame");
				ok = false;
			}
			const PixFmt pf = FormatOf(desc.Format);
			if (ok && !pf.supported()) {
				logger::warn("portrait: unsupported backbuffer format {} - refusing rather than saving garbage",
					static_cast<int>(desc.Format));
				ok = false;
			}
			if (ok) {
				logger::info("portrait: reading {} bytes/px, RowPitch {}", pf.stride, mapped.RowPitch);
				rgbOut.assign(static_cast<std::size_t>(outSize) * outSize * 3, 0);
				const auto* base = static_cast<const std::uint8_t*>(mapped.pData);
				// BOX-AVERAGE downscale. This started as nearest-neighbour, which
				// is the wrong filter for the job: a face crop is routinely 700-900
				// px reduced to a few hundred, and point-sampling a >2x reduction
				// throws away 3/4 of the pixels and aliases hard — stray bright
				// pixels crawl on hair and eyelashes and the result reads as cheap.
				// Averaging every source pixel that falls in an output cell costs a
				// few hundred microseconds once per capture and is the single
				// biggest quality win available here.
				//
				// When the crop is SMALLER than the output (a face far away), each
				// cell covers one source pixel and this degrades to nearest, which
				// is correct — there is no detail to invent.
				for (int oy = 0; oy < outSize; ++oy) {
					const int sy0 = oy * b.size / outSize;
					const int sy1 = std::max(sy0 + 1, (oy + 1) * b.size / outSize);
					for (int ox = 0; ox < outSize; ++ox) {
						const int sx0 = ox * b.size / outSize;
						const int sx1 = std::max(sx0 + 1, (ox + 1) * b.size / outSize);
						std::uint32_t r = 0, g = 0, bl = 0, n = 0;
						for (int sy = sy0; sy < sy1 && sy < b.size; ++sy) {
							const auto* row = base + static_cast<std::size_t>(sy) * mapped.RowPitch;
							for (int sx = sx0; sx < sx1 && sx < b.size; ++sx) {
								const auto*  px = row + static_cast<std::size_t>(sx) * pf.stride;
								std::uint8_t pr, pg, pb;
								ReadPixel(px, desc.Format, pr, pg, pb);
								r += pr;
								g += pg;
								bl += pb;
								++n;
							}
						}
						if (!n)
							n = 1;
						auto* dst = &rgbOut[(static_cast<std::size_t>(oy) * outSize + ox) * 3];
						dst[0] = static_cast<std::uint8_t>(r / n);
						dst[1] = static_cast<std::uint8_t>(g / n);
						dst[2] = static_cast<std::uint8_t>(bl / n);
					}
				}
				ctx->Unmap(staging, 0);

				// SANITY CHECK — is this actually a photograph?
				//
				// A capture on 2026-07-31 produced 512x512 of vertical colour
				// stripes: every row identical, standard deviation DOWN a column
				// of 2.0 against 80.8 across a row. A real frame is never like
				// that. The write path reported success and the file looked fine
				// by every check that did not involve looking at it.
				//
				// So measure the thing that distinguishes a picture from a
				// pattern: if the image barely varies vertically while varying
				// wildly horizontally, the grab failed — refuse it rather than
				// save it over someone's portrait.
				// Sampled across MANY lines, not one. A single centre column is
				// a bad statistic for a portrait: faces have large, smoothly lit
				// areas, so one column can easily be near-uniform on a perfectly
				// good shot — and rejecting a good capture with "could not read
				// the frame" would be a worse bug than the one this guards.
				// Medians over 16 evenly spaced lines make a lucky flat line
				// harmless while still catching a whole image that is flat.
				constexpr int kLines = 16;
				const auto lineSd = [&](bool vertical) {
					std::vector<double> sds;
					sds.reserve(kLines);
					for (int i = 1; i <= kLines; ++i) {
						const int at = outSize * i / (kLines + 1);
						double    mean = 0.0;
						for (int j = 0; j < outSize; ++j) {
							const std::size_t idx = vertical
								? (static_cast<std::size_t>(j) * outSize + at)
								: (static_cast<std::size_t>(at) * outSize + j);
							mean += rgbOut[idx * 3];
						}
						mean /= outSize;
						double var = 0.0;
						for (int j = 0; j < outSize; ++j) {
							const std::size_t idx = vertical
								? (static_cast<std::size_t>(j) * outSize + at)
								: (static_cast<std::size_t>(at) * outSize + j);
							const double d = rgbOut[idx * 3] - mean;
							var += d * d;
						}
						sds.push_back(std::sqrt(var / outSize));
					}
					std::nth_element(sds.begin(), sds.begin() + sds.size() / 2, sds.end());
					return sds[sds.size() / 2];
				};
				const double colSd = lineSd(true);    // variation DOWN the image
				const double rowSd = lineSd(false);   // variation ACROSS it
				logger::info("portrait: frame check - median stdev down {:.1f}, across {:.1f}", colSd, rowSd);
				if (colSd < 4.0 && rowSd > 4.0 * (colSd + 1.0)) {
					logger::warn("portrait: frame is vertically flat (down {:.1f} vs across {:.1f}) - that is a bad grab, not a face",
						colSd, rowSd);
					ok = false;
				}
			}

			ctx->Release();
			staging->Release();
			back->Release();
			return ok;
		}

		// ---------------------------------------------------------------- FOV
		// Saved across the capture so the restore is EXACT rather than a guess
		// at the player's preferred FOV. -1 = nothing saved / nothing to undo.
		float g_savedWorldFov = -1.0f;
		float g_savedFirstFov = -1.0f;

		void RunConsole(const char* cmd);

		// Applied through the CONSOLE rather than by writing the field: a raw
		// field write is not guaranteed to be picked up until the camera state
		// changes (which is why CHIM toggles free-camera after setting it), and
		// `fov` is the path the engine itself uses. We still READ the fields, so
		// unlike CHIM — which never restores and silently leaves the player at
		// fov 60 forever — we can put back exactly what was there.
		void ZoomForCapture()
		{
			auto* cam = RE::PlayerCamera::GetSingleton();
			if (!cam)
				return;
			const auto& rt2 = cam->GetRuntimeData2();
			g_savedWorldFov = rt2.worldFOV;
			g_savedFirstFov = rt2.firstPersonFOV;
			if (g_savedWorldFov <= 1.0f || g_savedWorldFov > 179.0f) {
				// Nonsense reading — don't touch it, and make sure the restore
				// below is a no-op rather than forcing a made-up value.
				g_savedWorldFov = -1.0f;
				g_savedFirstFov = -1.0f;
				return;
			}

			// CHIM'S SEQUENCE, VERBATIM. `fov 60`, then `tfc`.
			//
			// The head-projection zoom that used to live here is gone on purpose.
			// It was solving for a crop that the projection then mis-placed — the
			// Elana capture had perfectly good pixels aimed at a cave wall — and
			// every additional clever step was another thing that could put the
			// frame somewhere other than the face. CHIM does none of it, and
			// CHIM's shots are the ones that look right.
			//
			// `tfc` second, because it is what makes the fov change take: setting
			// the field alone does not apply until the camera state changes.
			// NO `tfc` HERE any more. CHIM toggles free camera to make its fov
			// change take, and copying that faithfully is what caused the next
			// report: after a portrait the third-person camera sat clipped into
			// the player's face. Entering and leaving free camera does not put
			// the third-person rig back exactly where it was.
			//
			// It costs us nothing to drop. The crop is the centre square of the
			// back buffer, so the fov only decides how much world is in shot, not
			// whether the framing is right — and if `fov` does not apply without a
			// camera-state change, the shot is simply taken at the player's own
			// fov, which is a slightly wider picture and not a broken one.
			//
			// Photo mode still uses free camera, because there the camera IS the
			// feature and the player is flying it deliberately.
			logger::info("portrait: fov {} (was fov {:.0f}), no free-camera toggle",
				static_cast<int>(kCaptureFov), g_savedWorldFov);
			RunConsole(("fov " + std::to_string(static_cast<int>(kCaptureFov))).c_str());
		}

		// MUST run on every exit path. Leaving the player permanently zoomed is
		// far worse than a missing portrait — it is the exact bug CHIM ships.
		void RestoreFov()
		{
			if (g_savedWorldFov <= 0.0f)
				return;
			RunConsole(("fov " + std::to_string(static_cast<int>(g_savedWorldFov))).c_str());
			// The console sets both world and first-person from one number; put
			// the fields back individually in case they differed.
			if (auto* cam = RE::PlayerCamera::GetSingleton()) {
				auto& rt2 = cam->GetRuntimeData2();
				rt2.worldFOV = g_savedWorldFov;
				rt2.firstPersonFOV = g_savedFirstFov;
			}
			logger::info("portrait: FOV restored to {}", g_savedWorldFov);
			g_savedWorldFov = -1.0f;
			g_savedFirstFov = -1.0f;
		}

		// ------------------------------------------------------------ console
		void RunConsole(const char* cmd)
		{
			auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
			auto* script  = factory ? factory->Create() : nullptr;
			if (!script)
				return;
			script->SetCommand(cmd);
			script->CompileAndRun(nullptr);
			delete script;
		}

		// ------------------------------------------------------- the main step
		// Runs on the MAIN thread: it touches the render device and the scene
		// graph, neither of which may be read from our timer thread.
		// The shared capture core: grab the frame, write it lock-safely under
		// `<slug>.png` in `dir`, prune superseded versions. Used by BOTH the
		// follower portrait and the wardrobe photo mode — the wardrobe needs the
		// versioned-write fallback just as much, because the deck draws outfit
		// images too and Ultralight maps every image it draws.
		//
		// Returns 0 on success (and sets `written`), else the Win32 error, so the
		// caller can word its own message.

		// Defined below; photo mode shares the follower capture's core so both get
		// the same lock-safe versioned write.
		std::uint32_t CaptureToFile(const std::filesystem::path& dir, const std::string& slug,
			const std::string& label, std::filesystem::path& written, const TuneKeys& keys = kFaceKeys);

		// ============================== photo mode =============================
		//  Dress-and-frame-it-yourself, for wardrobe outfits.
		//
		//  The follower portrait is fire-and-forget: it shoots a second after you
		//  press the key, from wherever you were standing. An OUTFIT wants the
		//  opposite — you need to walk around your own character and pick the
		//  angle, because the whole point is the clothes. So this hands the camera
		//  to you and waits, instead of counting to one and firing.
		//
		//  Everything it turns on is tracked and restored by ONE guard, on every
		//  exit path including the timeout: menus, free camera, frozen time, FOV.
		//  A photo mode you cannot get out of would be indistinguishable from the
		//  frozen game we already shipped once by accident.
		std::atomic<bool>     g_photoMode{ false };
		std::filesystem::path g_photoDir;
		std::string           g_photoSlug;
		std::string           g_photoLabel;
		std::uint64_t         g_photoStartedAt = 0;

		// Set by main.cpp so this module never has to know the view exists.
		std::function<void(const std::string&, const std::string&, const std::string&)> g_onPhotoSaved;
		std::function<void()>                                                          g_onPhotoEnded;

		// A hard ceiling, so a forgotten photo mode cannot strand the player in a
		// frozen world forever. Five minutes is far longer than framing a shot.
		constexpr std::uint64_t kPhotoTimeoutSec = 300;

		void EndPhotoMode()
		{
			if (!g_photoMode.exchange(false))
				return;
			ExitFreeCam();
			RestoreFov();
			RestoreMenus();
			logger::info("photo: mode ended");
			// EVERY exit runs through here — shot, cancel, Esc, timeout, the
			// watchdog. That is the whole reason the scene-staging restore hangs
			// off this and not off the saved callback: a photo you cancelled
			// must put the clock and the sky back exactly like one you took.
			if (g_onPhotoEnded) {
				auto cb = g_onPhotoEnded;
				cb();
			}
		}

		void PhotoShoot()
		{
			if (!g_photoMode.load())
				return;
			// The HUD is only hidden for the SHOT now, not the whole session
			// (see StartPhotoMode) — so hide it, give the game a beat to redraw
			// without it, then grab and restore everything. Grab BEFORE tearing
			// down, or we photograph the HUD coming back.
			HideMenus();
			std::thread([]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(250));
				SKSE::GetTaskInterface()->AddTask([]() {
					if (!g_photoMode.load()) {   // ended (timeout/cancel) while we waited
						RestoreMenus();
						return;
					}
					std::filesystem::path written;
					const auto            err = CaptureToFile(g_photoDir, g_photoSlug, g_photoLabel, written, kPhotoKeys);
					EndPhotoMode();
					if (err) {
						Notify(IsLockedError(err)
								   ? "Photo failed: that image is locked - restart Skyrim to replace it"
								   : "Photo failed: could not save the picture");
						return;
					}
					Notify(("Photo saved: " + g_photoLabel).c_str());
					if (g_onPhotoSaved)
						g_onPhotoSaved(g_photoSlug, written.filename().string(), g_photoLabel);
				});
			}).detach();
		}

		std::uint32_t CaptureToFile(const std::filesystem::path& dir, const std::string& slug,
			const std::string& label, std::filesystem::path& written, const TuneKeys& keys)
		{
			// THE BACK BUFFER's size, not the screen's. These are NOT the same
			// number and assuming they were is what broke the framing:
			// GetScreenSize() reports the DISPLAY (2560x1440 here) while the
			// render target is the RESOLUTION SCALE (1706x960 on this rig — DLSS
			// / FSR / an ENB downscale). Cropping in display coordinates and then
			// clamping into a smaller buffer shoved the box against the right and
			// bottom edges: measured 421 px right and 48 px down of centre, at 90%
			// of the buffer's height. That is exactly the "not straight on, and so
			// cut off I cannot fix it" report — the shot was of the screen's right
			// edge, not of whoever was in front of you.
			int sw = 0, sh = 0;
			if (!BackBufferSize(sw, sh)) {
				// Only as a last resort: better a display-sized guess than no
				// portrait, and it is correct whenever there is no upscaler.
				const auto size = RE::BSGraphics::Renderer::GetScreenSize();
				sw = static_cast<int>(size.width);
				sh = static_cast<int>(size.height);
				logger::warn("portrait: could not read the back buffer size - falling back to the screen size {}x{}", sw, sh);
			}
			if (sw <= 0 || sh <= 0)
				return static_cast<std::uint32_t>(ERROR_INVALID_HANDLE);

			// THE WHOLE FRAME, exactly like CHIM. No head projection, no computed
			// box, no bias — the centre square of the screen, which is where you
			// were aiming.
			//
			// The projection is gone because it was the thing getting it wrong:
			// the one capture with valid pixels framed a cave wall and the
			// player's back instead of the follower. Every clever step was
			// another chance to point the camera at the wrong thing, and CHIM —
			// which does none of it — is the one that produces usable pictures.
			// ...taken from the CENTRE, zoomed and nudged by capture.ini so the
			// framing is yours to dial in rather than mine to guess at.
			const Tuning tune = ReadTuning(dir, keys);
			const int    shortSide = std::min(sw, sh);

			Box box;
			box.size = std::clamp(static_cast<int>(shortSide * tune.zoom), 64, shortSide);
			const int cx = sw / 2 + static_cast<int>(tune.offsetX * shortSide);
			const int cy = sh / 2 + static_cast<int>(tune.offsetY * shortSide);
			box.x = std::clamp(cx - box.size / 2, 0, sw - box.size);
			box.y = std::clamp(cy - box.size / 2, 0, sh - box.size);
			box.ok = true;

			logger::info("portrait: framing zoom {:.2f} offset {:+.2f},{:+.2f} -> {}px at {},{}",
				tune.zoom, tune.offsetX, tune.offsetY, box.size, box.x, box.y);

			// Never upscale: if a tight zoom on a small window gives less than
			// 512, write it at its own size rather than stretching it.
			const int outSize = std::min(kOutSize, box.size);

			std::vector<std::uint8_t> rgb;
			if (!GrabRegion(box, rgb, outSize)) {
				logger::warn("portrait: back-buffer grab failed for '{}'", label);
				return static_cast<std::uint32_t>(ERROR_READ_FAULT);
			}

			// The ONE optional pixel op, and only when asked for: exposure. It
			// defaults to 0 stops, so the paragraph below still describes what
			// happens unless someone deliberately dialled a lift in — which is
			// the difference between a knob and the automatic tone mapping that
			// was tried and reverted.
			if (tune.exposure != 0.0f) {
				logger::info("portrait: exposure {:+.2f} stop(s) applied to '{}'", tune.exposure, label);
				ApplyExposure(rgb, tune.exposure);
			}

			// NO tone mapping, NO sharpening. CHIM writes the frame as it came
			// off the buffer and its shots look right; every processing stage we
			// added was a guess layered on a picture nobody had looked at. The
			// format-aware read already converts the linear HDR buffer to sRGB,
			// which is the only conversion that is not optional.

			// Encoded ONCE. A retry under a different name re-uses these bytes
			// rather than paying for the whole PNG again.
			const auto png = EncodePng(rgb, outSize, outSize);

			// The tidy name first. It succeeds whenever the deck has not already
			// DRAWN this person's portrait — a first capture, or any session where
			// their face has not been on screen yet.
			const auto canonical = dir / (slug + ".png");
			auto       path = canonical;
			auto       err = WriteBytes(path, png);

			// Locked: Ultralight has it mapped for the session (see the header).
			// Nothing can free it short of closing the game, so stop trying to and
			// write a new file instead. The scanner resolves it back to this slug
			// and prefers it for being newer, so the deck shows the NEW face — the
			// player never learns any of this happened.
			if (IsLockedError(err)) {
				logger::info("portrait: '{}' is held open by the running view (win32 {}) - writing a versioned file instead",
					canonical.filename().string(), err);
				const auto stamp = NowSeconds();
				// Bump past a same-second collision; 8 is far more headroom than
				// a human pressing a hotkey can ever need.
				for (int bump = 0; bump < 8; ++bump) {
					std::error_code fec;
					auto            candidate = dir / (slug + "~" + std::to_string(stamp + static_cast<std::uint64_t>(bump)) + ".png");
					if (std::filesystem::exists(candidate, fec))
						continue;
					path = candidate;
					err = WriteBytes(path, png);
					if (!IsLockedError(err))
						break;
				}
			}

			if (err) {
				logger::warn("portrait: write failed for '{}': {} (win32 {})", label, path.string(), err);
				return err;
			}

			// Runs on BOTH paths. After a versioned write it stops the folder
			// growing a 780 KB file per re-capture; after a plain one it clears
			// versions left by an earlier session, so the tidy name comes back on
			// its own once the game is no longer holding it.
			PruneOtherVersions(dir, slug, path);

			// Everything the next "that one came out badly" report needs, without
			// having to reproduce it: how big the grab was, what it was written
			// at, and whether that was a downscale (good) or a stretch (the
			// subject was too far away even after the zoom).
			logger::info("portrait: captured '{}' -> {} ({}px crop at {},{} -> {}px out, {})",
				label, path.filename().string(), box.size, box.x, box.y, outSize,
				box.size > outSize ? "downscaled + sharpened" :
									 (box.size == outSize ? "1:1" : "UPSCALED - subject was too far for a sharp portrait"));
			written = path;
			return 0;
		}

		void DoCapture(const std::filesystem::path& dir)
		{
			// EVERY exit path from here restores the camera and the menus. This
			// used to live only in a task posted 90 ms later, which meant any
			// path that never ran it left the player with no HUD and no menus —
			// indistinguishable from a frozen game. Restoring in the SAME task
			// that hid them removes the window entirely; the later task stays as
			// a belt-and-braces safety net and is harmless because both calls
			// are idempotent.
			struct Restore
			{
				~Restore()
				{
					ExitFreeCam();
					RestoreFov();
					RestoreMenus();
					g_targetOverride.store(0);
				}
			} restoreOnExit;

			const auto id = ResolveTargetId();
			if (!id) {
				Notify("No NPC targeted - look at one, then open the deck");
				return;
			}
			auto* form = RE::TESForm::LookupByID(id);
			auto* actor = form ? form->As<RE::Actor>() : nullptr;
			if (!actor) {
				Notify("That NPC is no longer loaded");
				return;
			}

			std::string name = actor->GetDisplayFullName() ? actor->GetDisplayFullName() : "";
			if (name.empty())
				name = actor->GetName() ? actor->GetName() : "";
			const std::string slug = SlugOf(name);
			if (slug.empty()) {
				Notify("That NPC has no usable name");
				return;
			}

			std::filesystem::path written;
			const auto err = CaptureToFile(dir, slug, name, written);
			if (err) {
				// Two genuinely different failures, so say which one it is: a
				// player can act on "restart the game", and cannot act on a
				// generic "could not write the file".
				Notify(IsLockedError(err)
						   ? "Portrait failed: that file is locked - restart Skyrim to replace it"
						   : (err == ERROR_READ_FAULT ? "Portrait failed: could not read the frame"
													  : "Portrait failed: could not write the file"));
				return;
			}
			Notify(("Portrait saved: " + name).c_str());
		}
	}

	// `<slug>~<version>` -> `<slug>`; a plain stem comes back unchanged. The '~'
	// is safe as the separator precisely because it cannot occur in a slug: the
	// slug rule emits only [a-z0-9-], so a tilde is unambiguously OURS and can
	// never eat part of a real name the way a '-' would have.
	// The one slug rule, exported so callers that need a FILE NAME for a thing
	// (an outfit, a follower) cannot quietly grow a second, subtly different
	// copy of it.
	std::string SlugOfName(std::string_view name) { return SlugOf(name); }

	// Write already-encoded image bytes as `<slug>.<ext>`, with the SAME lock
	// fallback the capture uses: a portrait the deck has already drawn is
	// memory-mapped and cannot be overwritten, so it lands as
	// `<slug>~<unix seconds>.<ext>` and the newest-wins scan picks it up.
	//
	// Exists so the Deck Portal's live bridge writes through exactly one code
	// path rather than growing a second, subtly different one.
	bool WritePortraitBytes(const std::filesystem::path& dir, const std::string& slug,
		const std::string& ext, const std::vector<std::uint8_t>& bytes)
	{
		if (slug.empty() || bytes.empty())
			return false;
		const auto canonical = dir / (slug + "." + ext);
		auto       path = canonical;
		auto       err = WriteBytes(path, bytes);
		if (IsLockedError(err)) {
			const auto stamp = NowSeconds();
			for (int bump = 0; bump < 8; ++bump) {
				std::error_code fec;
				auto            cand = dir / (slug + "~" + std::to_string(stamp + static_cast<std::uint64_t>(bump)) + "." + ext);
				if (std::filesystem::exists(cand, fec))
					continue;
				path = cand;
				err = WriteBytes(path, bytes);
				if (!IsLockedError(err))
					break;
			}
		}
		if (err) {
			logger::warn("portrait: portal write failed for '{}': {} (win32 {})", slug, path.string(), err);
			return false;
		}
		PruneOtherVersions(dir, slug, path);
		logger::info("portrait: portal bytes -> {}", path.filename().string());
		return true;
	}


	std::string SlugFromFileStem(std::string_view stem)
	{
		const auto  cut = stem.find('~');
		std::string out{ cut == std::string_view::npos ? stem : stem.substr(0, cut) };
		std::transform(out.begin(), out.end(), out.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return out;
	}

	bool IsAction(const std::string& action)
	{
		return action == "portrait";
	}


	void SetPhotoSavedCallback(std::function<void(const std::string&, const std::string&, const std::string&)> cb)
	{
		g_onPhotoSaved = std::move(cb);
	}

	void SetPhotoEndedCallback(std::function<void()> cb)
	{
		g_onPhotoEnded = std::move(cb);
	}

	bool PhotoModeActive()
	{
		if (!g_photoMode.load())
			return false;
		// Lazy timeout — checked wherever anyone asks, which is every input
		// event, so no timer of our own and no way to be stranded in a frozen
		// world because a tick stopped running.
		if (NowSeconds() - g_photoStartedAt > kPhotoTimeoutSec) {
			logger::info("photo: timed out after {}s - restoring", kPhotoTimeoutSec);
			Notify("Photo mode timed out");
			EndPhotoMode();
			return false;
		}
		return true;
	}

	void StartPhotoMode(const std::filesystem::path& dir, const std::string& slug, const std::string& label)
	{
		if (g_photoMode.load()) {
			Notify("Already in photo mode");
			return;
		}
		g_photoDir = dir;
		g_photoSlug = slug;
		g_photoLabel = label;
		g_photoStartedAt = NowSeconds();
		g_photoMode.store(true);

		// ⛔ NO HideMenus() HERE any more. Hiding the whole UI for the session
		// is what stranded Rober (2026-08-02): the "E to shoot" toast was
		// invisible, and his escape attempts opened an INVISIBLE console that
		// swallowed E and Esc — from the outside, "stuck in tfc, nothing
		// works". The HUD now disappears only around the shot itself
		// (PhotoShoot), which is the only moment it matters.
		//
		// Same order as the capture: fov, then the camera toggle that makes the
		// fov take. `true` freezes time so she holds the pose.
		auto* cam = RE::PlayerCamera::GetSingleton();
		if (cam) {
			const auto& rt2 = cam->GetRuntimeData2();
			g_savedWorldFov = rt2.worldFOV;
			g_savedFirstFov = rt2.firstPersonFOV;
			if (g_savedWorldFov <= 1.0f || g_savedWorldFov > 179.0f) {
				g_savedWorldFov = -1.0f;
				g_savedFirstFov = -1.0f;
			} else {
				RunConsole(("fov " + std::to_string(static_cast<int>(kCaptureFov))).c_str());
			}
		}
		EnterFreeCam(true);
		logger::info("photo: mode started for '{}' -> {}", label, (dir / (slug + ".png")).string());
		Notify("Photo mode: fly around, E to shoot, Esc to cancel");

		// A REAL watchdog, not just the lazy check in PhotoModeActive(): that
		// one only runs when an input event asks, so the exact failure that
		// needs it — input not reaching us — is the one it can never catch.
		// This thread ends the mode from outside after the ceiling, whatever
		// the input system is doing. Single-shot tasks from our own thread,
		// never a task that re-posts itself.
		std::thread([]() {
			using namespace std::chrono_literals;
			while (g_photoMode.load()) {
				std::this_thread::sleep_for(5s);
				if (g_photoMode.load() && NowSeconds() - g_photoStartedAt > kPhotoTimeoutSec) {
					logger::info("photo: watchdog fired after {}s - restoring", kPhotoTimeoutSec);
					SKSE::GetTaskInterface()->AddTask([]() {
						if (g_photoMode.load()) {
							Notify("Photo mode timed out");
							EndPhotoMode();
						}
					});
					return;
				}
			}
		}).detach();
	}

	void PhotoShootNow() { PhotoShoot(); }

	void PhotoCancel()
	{
		if (!g_photoMode.load())
			return;
		EndPhotoMode();
		Notify("Photo cancelled");
	}

	void Fire(const std::filesystem::path& portraitDir, std::uint32_t targetFormId)
	{
		// Set before the thread starts so the very first task already sees it.
		// Cleared by DoCapture's restore guard, so a targeted capture can never
		// leak into the next crosshair one.
		g_targetOverride.store(targetFormId);

		// Copied into the thread: the caller's path object must not be relied on
		// once FireAction's task has returned.
		std::thread([dir = portraitDir]() {
			using namespace std::chrono;
			// The palette is a full-screen web view and the HUD puts a crosshair
			// exactly where the face is. Both have to be gone, and the game needs
			// a frame or two to actually render without them — the same
			// detached-sleep-then-AddTask idiom FireAndClose() uses, for the same
			// reason: you cannot block the main thread waiting for it to draw.
			std::this_thread::sleep_for(milliseconds(220));
			SKSE::GetTaskInterface()->AddTask([]() {
				// CHIM's order exactly: menus off, then fov, then tfc. The
				// subject is not needed here any more — the zoom is a flat 60
				// regardless of where they are standing.
				HideMenus();
				ZoomForCapture();
			});
			// A FULL SECOND, which is what CHIM waits. We used 420 ms to feel
			// snappy; on a 4,200-plugin load order that is a gamble on how many
			// frames actually rendered with the HUD gone and the new fov applied.
			// CHIM's number is the one that is known to produce good frames, so
			// it is the one we use.
			std::this_thread::sleep_for(milliseconds(1000));
			SKSE::GetTaskInterface()->AddTask([dir]() { DoCapture(dir); });
			std::this_thread::sleep_for(milliseconds(90));
			// Belt and braces. DoCapture already restored on its way out; this
			// only does anything if DoCapture never ran at all (e.g. its task was
			// dropped). All three no-op when there is nothing to undo.
			//
			// Clearing the override HERE too matters: if DoCapture never ran, its
			// guard never cleared it, and the next crosshair capture would
			// silently photograph the follower selected minutes ago instead of
			// whoever you are looking at.
			SKSE::GetTaskInterface()->AddTask([]() {
				ExitFreeCam();
				RestoreFov();
				RestoreMenus();
				g_targetOverride.store(0);
			});
		}).detach();
	}

	Framing DefaultFraming()
	{
		Framing f;
		f.zoom = kFaceKeys.defZoom;
		f.offsetX = kFaceKeys.defX;
		f.offsetY = kFaceKeys.defY;
		return f;
	}

	Framing GetFraming(const std::filesystem::path& dir)
	{
		const Tuning t = ReadTuning(dir, kFaceKeys);
		Framing      f;
		f.zoom = t.zoom;
		f.offsetX = t.offsetX;
		f.offsetY = t.offsetY;
		return f;
	}

	bool SetFraming(const std::filesystem::path& dir, const Framing& f)
	{
		// READ first: WriteTuning writes every key this set owns, and exposure is
		// now one of them. Starting from a default-constructed Tuning would reset
		// a face exposure to 0 every time the framing was nudged.
		Tuning t = ReadTuning(dir, kFaceKeys);
		t.zoom = std::clamp(f.zoom, 0.15f, 1.0f);
		t.offsetX = std::clamp(f.offsetX, -0.5f, 0.5f);
		t.offsetY = std::clamp(f.offsetY, -0.5f, 0.5f);
		return WriteTuning(dir, kFaceKeys, t);
	}

	// ---- photo-mode exposure ------------------------------------------------
	// Its own pair rather than a fourth field on Framing: Framing is the FACE's
	// key set (its comment says so), and photo mode's pictures are places and
	// outfits. Same file, the photo key set.
	float ExposureMax() { return kExpMax; }

	float GetPhotoExposure(const std::filesystem::path& dir)
	{
		return ReadTuning(dir, kPhotoKeys).exposure;
	}

	bool SetPhotoExposure(const std::filesystem::path& dir, float stops)
	{
		Tuning t = ReadTuning(dir, kPhotoKeys);
		t.exposure = std::clamp(stops, kExpMin, kExpMax);
		logger::info("photo: exposure set to {:+.2f} stop(s) in {}", t.exposure, dir.string());
		return WriteTuning(dir, kPhotoKeys, t);
	}
}
