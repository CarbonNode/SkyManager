#include "icon_bridge.h"

#include "icon_bridge_core.h"

// stb_image_write — public domain / MIT (Sean Barrett), vendored verbatim at
// src/vendor/stb_image_write.h with its licence block intact. It is the only
// third-party code in this feature; the DDS/BC decoders in icon_bridge_core.h
// are hand-written, and NO third-party ART enters this repo — that is the whole
// point of the bridge.
#pragma warning(push, 0)
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO  // we hand the bytes to std::ofstream ourselves
#include "vendor/stb_image_write.h"
#pragma warning(pop)

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

// pch (force-included) provides Windows.h, SKSE:: and the logger.

namespace IconBridge
{
	namespace fs = std::filesystem;
	using namespace IconBridgeCore;

	namespace
	{
		// Bump when the OUTPUT shape changes (naming, index fields, decode fix).
		// The stamp carries it, so a deck update that changes what a PNG should
		// look like regenerates the library instead of trusting yesterday's.
		constexpr int kFormatVersion = 1;

		constexpr std::uintmax_t kMaxSourceFile = 128ull * 1024 * 1024;  // one atlas
		constexpr std::size_t    kMaxIcons = 20000;                      // sanity ceiling

		std::atomic<bool> g_started{ false };
		std::mutex        g_statusMutex;
		std::string       g_status = "not started";

		void SetStatus(std::string s)
		{
			std::lock_guard l(g_statusMutex);
			g_status = std::move(s);
		}

		// ---------------------------------------------------------- where we are
		//
		// The mod folder, resolved from THIS DLL's own module handle. Under MO2
		// that is ...\mods\Hotkey Deck (PrismaUI)\SKSE\Plugins\HotkeyDeck.dll, so
		// three parents up is the mod root; on a plain (non-MO2) install the same
		// walk lands on the game's Data folder, which is equally correct. Writing
		// anywhere else is the Overwrite trap described in the header.
		fs::path ModRoot()
		{
			HMODULE self = nullptr;
			if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
					reinterpret_cast<LPCWSTR>(&ModRoot), &self) ||
				!self)
				return {};

			std::wstring buf(MAX_PATH, L'\0');
			for (;;) {
				const DWORD n = GetModuleFileNameW(self, buf.data(), static_cast<DWORD>(buf.size()));
				if (n == 0)
					return {};
				if (n < buf.size()) {
					buf.resize(n);
					break;
				}
				if (buf.size() >= 32768)
					return {};
				buf.resize(buf.size() * 2);
			}

			fs::path dll(buf);
			// <root>\SKSE\Plugins\HotkeyDeck.dll -> <root>
			return dll.parent_path().parent_path().parent_path();
		}

		// Spell Hotbar's data is read through MO2's VFS on purpose: the atlases
		// live in ITS mod folder, which we neither know nor should guess. A
		// relative Data\... path is exactly what the VFS exists to resolve, and
		// on a plain install it is just the real folder.
		fs::path SourceDir()
		{
			return fs::path("Data") / "SKSE" / "Plugins" / "SpellHotbar" / "images";
		}

		struct Target
		{
			const char* name;
			fs::path    iconsDir;  // <mod>\PrismaUI\views\<view>\icons
		};

		std::vector<Target> Targets(const fs::path& root)
		{
			return {
				{ "HotkeyDeck", root / "PrismaUI" / "views" / "HotkeyDeck" / "icons" },
				{ "MagicDeck", root / "PrismaUI" / "views" / "MagicDeck" / "icons" },
			};
		}

		// ------------------------------------------------------------- the stamp

		struct Stamp
		{
			int              version = kFormatVersion;
			std::size_t      files = 0;
			std::uintmax_t   bytes = 0;
			std::int64_t     newest = 0;  // filetime ticks of the newest source file
			std::size_t      icons = 0;
			std::size_t      atlases = 0;

			bool SameSource(const Stamp& o) const
			{
				return version == o.version && files == o.files && bytes == o.bytes && newest == o.newest;
			}
			nlohmann::json ToJson() const
			{
				return nlohmann::json{ { "version", version }, { "files", files }, { "bytes", bytes },
					{ "newest", newest }, { "icons", icons }, { "atlases", atlases } };
			}
			static Stamp FromJson(const nlohmann::json& j)
			{
				Stamp s;
				s.version = j.value("version", -1);
				s.files = j.value("files", std::size_t{ 0 });
				s.bytes = j.value("bytes", std::uintmax_t{ 0 });
				s.newest = j.value("newest", std::int64_t{ 0 });
				s.icons = j.value("icons", std::size_t{ 0 });
				s.atlases = j.value("atlases", std::size_t{ 0 });
				return s;
			}
		};

		std::string ReadTextFile(const fs::path& p)
		{
			std::ifstream in(p, std::ios::binary);
			if (!in.is_open())
				return {};
			return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		bool ReadBinaryFile(const fs::path& p, std::vector<std::uint8_t>& out)
		{
			std::ifstream in(p, std::ios::binary | std::ios::ate);
			if (!in.is_open())
				return false;
			const auto size = in.tellg();
			if (size <= 0 || static_cast<std::uintmax_t>(size) > kMaxSourceFile)
				return false;
			out.resize(static_cast<std::size_t>(size));
			in.seekg(0);
			in.read(reinterpret_cast<char*>(out.data()), size);
			return in.good() || in.eof();
		}

		bool WriteBytes(const fs::path& p, const void* data, std::size_t n)
		{
			std::error_code ec;
			fs::create_directories(p.parent_path(), ec);
			std::ofstream out(p, std::ios::binary | std::ios::trunc);
			if (!out.is_open())
				return false;
			out.write(static_cast<const char*>(data), static_cast<std::streamsize>(n));
			return out.good();
		}

		// A "sheet" is one <stem>.csv with a matching <stem>.dds.
		struct Sheet
		{
			std::string stem;
			fs::path    csv;
			fs::path    dds;
		};

		// Scans the source folder and computes the cache stamp in the same pass.
		// Returns false when the folder isn't there — which is the whole
		// "no Spell Hotbar installed" contract: nothing is created, nothing is
		// logged as an error, the deck keeps its glyphs.
		bool ScanSource(std::vector<Sheet>& sheets, Stamp& stamp, std::string& why)
		{
			std::error_code ec;
			const auto      dir = SourceDir();
			if (!fs::is_directory(dir, ec)) {
				why = "no Spell Hotbar images folder";
				return false;
			}

			// Every query gets its OWN error_code. Sharing one across the loop
			// means a single file whose size can't be read (a lock, a junction)
			// leaves `ec` set and silently truncates the whole scan — which would
			// show up not as an error but as a WRONG STAMP, i.e. a library that
			// stops noticing that Spell Hotbar changed.
			std::vector<fs::path> csvs;
			std::error_code       iterEc;
			for (const auto& e : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, iterEc)) {
				std::error_code fileEc;
				if (!e.is_regular_file(fileEc) || fileEc)
					continue;
				const auto ext = ToLower(e.path().extension().string());
				if (ext != ".csv" && ext != ".dds")
					continue;

				++stamp.files;
				if (const auto sz = e.file_size(fileEc); !fileEc)
					stamp.bytes += sz;
				fileEc.clear();
				if (const auto wt = e.last_write_time(fileEc); !fileEc)
					// (std::max) in parens: Windows.h defines max as a macro and the
					// forced PCH pulls it in, so the bare call is a syntax error here.
					stamp.newest = (std::max)(stamp.newest,
						static_cast<std::int64_t>(wt.time_since_epoch().count()));
				if (ext == ".csv")
					csvs.push_back(e.path());
			}
			if (iterEc) {
				why = "could not list the images folder (" + iterEc.message() + ")";
				return false;
			}

			for (const auto& csv : csvs) {
				Sheet s;
				s.stem = csv.stem().string();
				s.csv = csv;
				s.dds = csv;
				s.dds.replace_extension(".dds");
				std::error_code pairEc;
				if (!fs::is_regular_file(s.dds, pairEc) || pairEc)
					continue;  // .png-backed sheets exist in theory; we only decode DDS
				sheets.push_back(std::move(s));
			}

			if (sheets.empty()) {
				why = "images folder has no <atlas>.csv + <atlas>.dds pair";
				return false;
			}
			return true;
		}

		bool LibraryIsCurrent(const std::vector<Target>& targets, const Stamp& want, Stamp& found)
		{
			for (const auto& t : targets) {
				std::error_code ec;
				if (!fs::is_regular_file(t.iconsDir / "sh_index.json", ec))
					return false;
				const auto text = ReadTextFile(t.iconsDir / "sh" / ".hd-icons-stamp.json");
				if (text.empty())
					return false;
				const auto j = nlohmann::json::parse(text, nullptr, false);
				if (j.is_discarded() || !j.is_object())
					return false;
				const auto s = Stamp::FromJson(j);
				if (!s.SameSource(want))
					return false;
				found = s;
			}
			return true;
		}

		// ---------------------------------------------------------------- build

		std::vector<std::uint8_t> EncodePng(const Image& img)
		{
			std::vector<std::uint8_t> mem;
			if (!img.valid())
				return mem;
			stbi_write_png_to_func(
				[](void* ctx, void* data, int len) {
					auto* v = static_cast<std::vector<std::uint8_t>*>(ctx);
					const auto* p = static_cast<std::uint8_t*>(data);
					v->insert(v->end(), p, p + len);
				},
				&mem, img.w, img.h, 4, img.rgba.data(), img.w * 4);
			return mem;
		}

		// fs::absolute throws on a pathological CWD; the log line is not worth
		// taking the run down for.
		std::string AbsForLog(const fs::path& p)
		{
			std::error_code ec;
			const auto      a = fs::absolute(p, ec);
			return ec ? p.string() : a.string();
		}

		void Run(std::function<void()> onReady)
		{
			using clock = std::chrono::steady_clock;
			const auto t0 = clock::now();

			const auto root = ModRoot();
			if (root.empty()) {
				logger::warn("icon-bridge: could not resolve this DLL's own folder — icon library left alone");
				SetStatus("module path unresolved");
				return;
			}

			std::vector<Sheet> sheets;
			Stamp              stamp;
			std::string        why;
			if (!ScanSource(sheets, stamp, why)) {
				// THE INERT PATH. Spell Hotbar 2 is not installed (or ships no
				// atlases): create nothing, delete nothing, and let the existing
				// "no icon library — SVG glyphs only" behaviour stand.
				logger::info("icon-bridge: {} at {} — no icons generated, the deck uses its built-in SVG glyphs",
					why, AbsForLog(SourceDir()));
				SetStatus("Spell Hotbar 2 not installed — SVG glyphs");
				return;
			}

			const auto targets = Targets(root);

			Stamp have;
			if (LibraryIsCurrent(targets, stamp, have)) {
				logger::info("icon-bridge: library is current ({} icons from {} atlases, {} source files) — nothing to do",
					have.icons, have.atlases, stamp.files);
				SetStatus(std::to_string(have.icons) + " icons (cached)");
				return;
			}

			logger::info("icon-bridge: rebuilding the icon library from {} sheet(s) in {} — this runs once per Spell Hotbar change",
				sheets.size(), AbsForLog(SourceDir()));

			IndexAccum index;
			BuildStats stats;
			std::size_t targetWriteFailures = 0;

			// One encode, N writes: each view resolves `icons/...` against its OWN
			// folder, so both trees need the same bytes (the deck view and the
			// Spell Deck are separate Ultralight roots).
			WriteFn write = [&](const std::string& rel, const std::vector<std::uint8_t>& bytes) {
				// rel is "icons/sh/<atlas>/<file>.png" by construction; refuse
				// anything else rather than resolve a path outside the view root.
				constexpr std::string_view kPrefix = "icons/";
				if (rel.compare(0, kPrefix.size(), kPrefix) != 0 || rel.find("..") != std::string::npos)
					return false;
				bool any = false;
				for (const auto& t : targets) {
					const auto tail = rel.substr(kPrefix.size());
					const auto dest = t.iconsDir / fs::path(tail);
					if (WriteBytes(dest, bytes.data(), bytes.size()))
						any = true;
					else
						++targetWriteFailures;
				}
				return any;
			};

			for (const auto& s : sheets) {
				if (stats.icons >= kMaxIcons) {
					logger::warn("icon-bridge: stopped at the {} icon ceiling — remaining sheets skipped", kMaxIcons);
					break;
				}
				std::vector<std::uint8_t> dds;
				std::string               note;
				if (IsSkippedAtlas(ToLower(s.stem))) {
					++stats.sheetsSkipped;
					continue;
				}
				if (!ReadBinaryFile(s.dds, dds)) {
					logger::warn("icon-bridge: {} — could not read {}", s.stem, s.dds.filename().string());
					++stats.sheetsSkipped;
					continue;
				}
				const auto csvText = ReadTextFile(s.csv);
				if (csvText.empty()) {
					logger::warn("icon-bridge: {} — csv is empty or unreadable", s.stem);
					++stats.sheetsSkipped;
					continue;
				}
				if (!BuildAtlas(s.stem, dds, csvText, EncodePng, write, index, stats, note))
					logger::info("icon-bridge: {} skipped ({})", s.stem, note);
			}

			if (stats.icons == 0) {
				// Better an untouched fallback than an index promising icons that
				// aren't there.
				logger::warn("icon-bridge: no icons could be generated ({} sheets skipped) — leaving the existing library alone",
					stats.sheetsSkipped);
				SetStatus("no icons generated");
				return;
			}

			stamp.icons = stats.icons;
			stamp.atlases = stats.atlases;

			const auto indexText = index.ToJson().dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			std::size_t indexFailures = 0;
			for (const auto& t : targets) {
				if (!WriteBytes(t.iconsDir / "sh_index.json", indexText.data(), indexText.size())) {
					logger::error("icon-bridge: could not write {}\\sh_index.json", t.name);
					++indexFailures;
					continue;
				}
				const auto stampText = stamp.ToJson().dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				if (!WriteBytes(t.iconsDir / "sh" / ".hd-icons-stamp.json", stampText.data(), stampText.size()))
					logger::warn("icon-bridge: {} index written but its stamp was not — it will rebuild next launch", t.name);
			}
			if (indexFailures == targets.size()) {
				SetStatus("index write failed");
				return;
			}

			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - t0).count();
			logger::info("icon-bridge: generated {} icons from {} atlases in {} ms ({} rows skipped, {} rects rejected, {} write failures)",
				stats.icons, stats.atlases, ms, stats.rowsSkipped, stats.rectsRejected,
				stats.writeFailures + targetWriteFailures);
			logger::info("icon-bridge: library written to the MOD folder ({}) — sliced from this machine's own Spell Hotbar 2 install, nothing redistributed",
				root.string());
			SetStatus(std::to_string(stats.icons) + " icons from " + std::to_string(stats.atlases) + " atlases");

			// A freshly built library is only useful if the view is told. The
			// caller drops its once-per-session latch on the main thread; the next
			// palette open pushes the new index. (Generation finishes long before
			// a palette can be opened in practice — this is the belt for the case
			// where it doesn't.)
			if (onReady) {
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([onReady]() { onReady(); });
			}
		}
	}

	void Start(std::function<void()> onReady)
	{
		if (g_started.exchange(true))
			return;
		SetStatus("scanning");
		std::thread([onReady = std::move(onReady)]() {
			SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
			try {
				Run(onReady);
			} catch (const std::exception& ex) {
				logger::error("icon-bridge: aborted — {}", ex.what());
				SetStatus(std::string("failed: ") + ex.what());
			} catch (...) {
				logger::error("icon-bridge: aborted — unknown exception");
				SetStatus("failed");
			}
		}).detach();
	}

	std::string StatusLine()
	{
		std::lock_guard l(g_statusMutex);
		return g_status;
	}

	// Public wrapper over the anonymous-namespace ModRoot() the bridge already
	// uses for its own writes — exposed so other view-tree writers (e.g. the
	// hotbar copying an outfit photo into MagicDeck) obey the same law #4 and
	// land in the real mod folder rather than MO2's Overwrite. Named distinctly
	// from the anonymous helper so the call below is unambiguous.
	std::filesystem::path ModFolderRoot()
	{
		return ModRoot();  // the anonymous-namespace one, in this same scope
	}
}
