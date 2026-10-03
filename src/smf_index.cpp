#include "smf_index.h"

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

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace SmfIndex
{
	namespace
	{
		using json = nlohmann::json;
		using RenderFn = void(__stdcall*)();

		// ── SMF 3.0 ABI ────────────────────────────────────────────────────
		// WindowInterface (WindowManager.h): two std::atomic<bool>.
		struct WindowIface
		{
			std::atomic<bool> IsOpen;
			std::atomic<bool> BlockUserInput;
		};

		struct Vec2  // ImVec2: 8 bytes, passed by value in one register
		{
			float x, y;
		};

		using AddWindowFn = WindowIface* (*)(RenderFn);
		using VersionFn = float (*)();
		using BeginFn = bool (*)(const char*, bool*, int);
		using EndFn = void (*)();
		using BeginChildFn = bool (*)(const char*, Vec2, int, int);
		using EndChildFn = void (*)();
		using SetNextPosFn = void (*)(Vec2, int, Vec2);
		using SetNextSizeFn = void (*)(Vec2, int);
		using SetNextFocusFn = void (*)();
		using KeyPressedFn = bool (*)(int, bool);

		// Enum values from SMF's own cimgui.h at 592860b. ImGuiKey_Escape has
		// been 526 since ImGui 1.87 named keys.
		constexpr int kWinNoCollapse = 1 << 5;
		constexpr int kWinNoSavedSettings = 1 << 8;
		constexpr int kChildBorder = 1 << 0;
		constexpr int kCondAppearing = 1 << 3;
		constexpr int kKeyEscape = 526;

		struct Api
		{
			AddWindowFn    addWindow = nullptr;
			VersionFn      version = nullptr;
			BeginFn        begin = nullptr;
			EndFn          end = nullptr;
			BeginChildFn   beginChild = nullptr;
			EndChildFn     endChild = nullptr;
			SetNextPosFn   setPos = nullptr;
			SetNextSizeFn  setSize = nullptr;
			SetNextFocusFn setFocus = nullptr;
			KeyPressedFn   keyPressed = nullptr;
		} g_api;

		float                 g_version = 0.0f;
		WindowIface*          g_iface = nullptr;
		std::atomic<RenderFn> g_target{ nullptr };
		std::atomic<bool>     g_focusNext{ false };
		char                  g_title[512] = "###SkyManagerSmfHost";

		// ── MSVC (release) container layouts, read raw ─────────────────────
		struct RawString  // std::string: 16-byte buffer/pointer, size, capacity
		{
			std::uintptr_t buf[2];
			std::uint64_t  size;
			std::uint64_t  res;
		};
		struct RawMap  // std::map: _Myhead, _Mysize
		{
			std::uintptr_t head;
			std::uint64_t  size;
		};
		struct RawVec  // std::vector: _Myfirst, _Mylast, _Myend
		{
			std::uintptr_t first, last, end;
		};
		struct RawTree  // UI::MenuTree
		{
			RawMap         children;
			RawVec         sorted;
			std::uintptr_t render;
			RawString      title;
		};
		struct RawPair  // std::pair<const std::string, MenuTree*>
		{
			RawString      key;
			std::uintptr_t node;
		};
		static_assert(sizeof(RawString) == 32);
		static_assert(sizeof(RawTree) == 80);
		static_assert(sizeof(RawPair) == 40);

		constexpr std::uint64_t kMaxChildren = 2000;
		constexpr int           kMaxDepth = 8;
		constexpr int           kMaxNodes = 5000;

		// One guarded copy of foreign memory. No C++ objects in this frame
		// (C2712); a fault reads as "not this".
		__declspec(noinline) bool SafeCopy(void* dst, std::uintptr_t src, std::size_t n)
		{
			__try {
				std::memcpy(dst, reinterpret_cast<const void*>(src), n);
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		bool Plausible(std::uintptr_t p)
		{
			return p >= 0x10000 && p < 0x00007FFFFFFF0000ull && (p & 7) == 0;
		}

		bool ReadString(const RawString& s, std::string& out)
		{
			if (s.res < 15 || s.size > s.res || s.size > 255)
				return false;
			char tmp[256];
			if (s.res == 15) {
				std::memcpy(tmp, s.buf, 16);
				if (tmp[s.size] != '\0')
					return false;
			} else if (!Plausible(s.buf[0]) || !SafeCopy(tmp, s.buf[0], s.size + 1) || tmp[s.size] != '\0') {
				return false;
			}
			for (std::size_t i = 0; i < s.size; ++i) {
				const auto c = static_cast<unsigned char>(tmp[i]);
				if (c < 0x20 || c == 0x7F)
					return false;
			}
			out.assign(tmp, s.size);
			return true;
		}

		bool ReadTree(std::uintptr_t addr, RawTree& t)
		{
			if (!Plausible(addr) || !SafeCopy(&t, addr, sizeof(t)))
				return false;
			if (!Plausible(t.children.head) || t.children.size > kMaxChildren)
				return false;
			// The map's head is a sentinel node: _Isnil (byte 25) is set.
			unsigned char headTail[26];
			if (!SafeCopy(headTail, t.children.head, sizeof(headTail)) || headTail[25] != 1)
				return false;
			const auto& v = t.sorted;
			if (t.children.size == 0) {
				if (v.first != v.last)
					return false;
			} else {
				if (!Plausible(v.first) || v.last < v.first || v.end < v.last)
					return false;
				const auto bytes = v.last - v.first;
				if (bytes % sizeof(RawPair) != 0 || bytes / sizeof(RawPair) != t.children.size)
					return false;
			}
			// Code addresses need not be 8-aligned; ModuleOf vets them properly.
			return t.render == 0 || (t.render >= 0x10000 && t.render < 0x00007FFFFFFF0000ull);
		}

		// A page callback must live inside a loaded module's image.
		bool ModuleOf(std::uintptr_t fn, std::string& dll)
		{
			HMODULE mod = nullptr;
			if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
					reinterpret_cast<LPCWSTR>(fn), &mod) ||
				!mod)
				return false;
			static std::map<HMODULE, std::string> names;
			if (const auto it = names.find(mod); it != names.end()) {
				dll = it->second;
				return true;
			}
			wchar_t buf[MAX_PATH]{};
			const auto n = GetModuleFileNameW(mod, buf, MAX_PATH);
			dll = n ? PathU8(std::filesystem::path(std::wstring(buf, n)).filename()) : std::string("?");
			names.emplace(mod, dll);
			return true;
		}

		struct Page
		{
			std::string    path, section, label, dll;
			std::uintptr_t render = 0;
		};

		struct Walk
		{
			std::vector<Page> pages;
			int               nodes = 0;
			bool              bad = false;
			std::string       why;

			void Fail(std::string w)
			{
				if (!bad)
					why = std::move(w);
				bad = true;
			}

			void Node(const RawTree& t, const std::string& prefix, const std::string& section, int depth)
			{
				for (std::uint64_t i = 0; i < t.children.size && !bad; ++i) {
					RawPair pr{};
					if (!SafeCopy(&pr, t.sorted.first + i * sizeof(RawPair), sizeof(pr)))
						return Fail("unreadable child entry");
					std::string key;
					if (!ReadString(pr.key, key) || key.empty())
						return Fail("child name is not a string");
					RawTree child{};
					if (!ReadTree(pr.node, child))
						return Fail("child '" + key + "' is not a menu node");
					if (++nodes > kMaxNodes)
						return Fail("tree too large");
					const auto path = prefix.empty() ? key : prefix + "/" + key;
					const auto sec = section.empty() ? key : section;
					if (child.render) {
						Page pg;
						if (!ModuleOf(child.render, pg.dll))
							return Fail("page '" + path + "' points outside every loaded module");
						if (!ReadString(child.title, pg.label))
							return Fail("page '" + path + "' has an unreadable title");
						if (pg.label.empty())
							pg.label = key;
						pg.path = path;
						pg.section = sec;
						pg.render = child.render;
						pages.push_back(std::move(pg));
					}
					if (child.children.size) {
						if (depth + 1 >= kMaxDepth)
							return Fail("tree too deep");
						Node(child, path, sec, depth + 1);
					}
				}
			}
		};

		// The root: no render callback, empty title, at least one section,
		// and the whole tree under it walks clean with at least one page.
		bool WalkRoot(std::uintptr_t root, Walk& w)
		{
			RawTree t{};
			if (!ReadTree(root, t)) {
				w.Fail("root is not a menu node");
				return false;
			}
			if (t.render != 0 || t.title.size != 0 || t.title.res != 15 || t.children.size == 0) {
				w.Fail("root shape mismatch");
				return false;
			}
			w.Node(t, "", "", 0);
			if (!w.bad && w.pages.empty())
				w.Fail("no pages");
			return !w.bad;
		}

		std::uintptr_t g_slot = 0;  // address of SMF's UI::RootMenu global
		bool           g_loggedMiss = false;

		// Scan SMF's writable sections for the one pointer that walks as the
		// root. Fails closed on zero or on two DIFFERENT matches.
		bool Discover(std::string& why)
		{
			const auto smf = GetModuleHandleW(L"SKSEMenuFramework.dll");
			if (!smf) {
				why = "SKSE Menu Framework is not loaded";
				return false;
			}
			const auto       base = reinterpret_cast<std::uintptr_t>(smf);
			IMAGE_DOS_HEADER dos{};
			IMAGE_NT_HEADERS64 nt{};
			if (!SafeCopy(&dos, base, sizeof(dos)) || dos.e_magic != IMAGE_DOS_SIGNATURE ||
				!SafeCopy(&nt, base + dos.e_lfanew, sizeof(nt)) || nt.Signature != IMAGE_NT_SIGNATURE) {
				why = "SKSEMenuFramework.dll has no readable PE header";
				return false;
			}
			const auto imageEnd = base + nt.OptionalHeader.SizeOfImage;
			const auto secAt = base + dos.e_lfanew + offsetof(IMAGE_NT_HEADERS64, OptionalHeader) +
			                   nt.FileHeader.SizeOfOptionalHeader;

			std::uintptr_t slot = 0, value = 0;
			int            distinct = 0;
			for (unsigned s = 0; s < nt.FileHeader.NumberOfSections; ++s) {
				IMAGE_SECTION_HEADER sh{};
				if (!SafeCopy(&sh, secAt + s * sizeof(sh), sizeof(sh)))
					break;
				if (!(sh.Characteristics & IMAGE_SCN_MEM_WRITE))
					continue;
				const auto start = base + sh.VirtualAddress;
				const auto size = static_cast<std::size_t>(sh.Misc.VirtualSize) & ~std::size_t(7);
				if (!size || size > 64u * 1024 * 1024)
					continue;
				std::vector<std::uint64_t> words(size / 8);
				if (!SafeCopy(words.data(), start, size))
					continue;
				for (std::size_t i = 0; i < words.size(); ++i) {
					const auto v = static_cast<std::uintptr_t>(words[i]);
					if (!Plausible(v) || (v >= base && v < imageEnd) || v == value)
						continue;
					Walk w;
					if (!WalkRoot(v, w))
						continue;
					if (distinct++ == 0) {
						slot = start + i * 8;
						value = v;
					}
				}
			}
			if (distinct == 0) {
				why = "could not find SKSE Menu Framework's menu tree (unknown SMF layout, or no pages yet)";
				return false;
			}
			if (distinct > 1) {
				why = "found " + std::to_string(distinct) + " candidate menu trees; refusing to guess";
				return false;
			}
			g_slot = slot;
			logger::info("smf-index: root at SKSEMenuFramework.dll+{:#x} -> {:#x} (SMF {:.1f})", slot - base, value,
				g_version);
			return true;
		}

		bool Pages(std::vector<Page>& out, std::string& why)
		{
			if (!g_slot && !Discover(why)) {
				if (!g_loggedMiss) {
					logger::warn("smf-index: {}", why);
					g_loggedMiss = true;
				}
				return false;
			}
			std::uintptr_t root = 0;
			Walk           w;
			if (!SafeCopy(&root, g_slot, sizeof(root)) || !WalkRoot(root, w)) {
				why = "SKSE Menu Framework's menu tree no longer reads cleanly (" + w.why + ")";
				logger::warn("smf-index: {}", why);
				g_slot = 0;
				return false;
			}
			out = std::move(w.pages);
			return true;
		}

		// ── The host window ────────────────────────────────────────────────
		__declspec(noinline) bool CallPage(RenderFn fn)
		{
			__try {
				fn();
				return true;
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		void CloseHost()
		{
			g_target.store(nullptr, std::memory_order_release);
			if (g_iface)
				g_iface->IsOpen = false;
		}

		// SMF calls this every frame while our window IsOpen (its render
		// pass, main thread). Only SMF's exported ImGui functions are used.
		void __stdcall HostRender()
		{
			const RenderFn fn = g_target.load(std::memory_order_acquire);
			if (!fn) {
				CloseHost();
				return;
			}
			const auto  screen = RE::BSGraphics::Renderer::GetScreenSize();
			const float w = screen.width ? static_cast<float>(screen.width) : 2560.0f;
			const float h = screen.height ? static_cast<float>(screen.height) : 1440.0f;
			g_api.setPos({ w * 0.5f, h * 0.5f }, kCondAppearing, { 0.5f, 0.5f });
			g_api.setSize({ w * 0.62f, h * 0.74f }, kCondAppearing);
			if (g_focusNext.exchange(false))
				g_api.setFocus();

			bool       open = true;
			bool       ok = true;
			const bool shown = g_api.begin(g_title, &open, kWinNoCollapse | kWinNoSavedSettings);
			if (shown) {
				// The page draws into a bordered child, as it does in SMF's own
				// panel (its content region is a child window too).
				g_api.beginChild("##SkyManagerSmfPage", { 0.0f, 0.0f }, kChildBorder, 0);
				ok = CallPage(fn);
				g_api.endChild();
			}
			const bool esc = g_api.keyPressed(kKeyEscape, false);
			g_api.end();
			if (!ok) {
				logger::error("smf-index: page '{}' faulted while drawing; window closed", g_title);
				RE::DebugNotification("That mod's menu page crashed while drawing, so SkyManager closed it.");
			}
			if (!open || esc || !ok)
				CloseHost();
		}

		template <class F>
		bool Resolve(HMODULE smf, const char* name, F& out)
		{
			out = reinterpret_cast<F>(GetProcAddress(smf, name));
			if (!out)
				logger::warn("smf-index: SKSEMenuFramework.dll has no export '{}'", name);
			return out != nullptr;
		}
	}

	void Init()
	{
		const auto smf = GetModuleHandleW(L"SKSEMenuFramework.dll");
		if (!smf) {
			logger::info("smf-index: SKSE Menu Framework not loaded; mod-menu search is off");
			return;
		}
		if (g_iface)
			return;
		bool ok = Resolve(smf, "AddWindow", g_api.addWindow);
		ok = Resolve(smf, "igBegin", g_api.begin) && ok;
		ok = Resolve(smf, "igEnd", g_api.end) && ok;
		ok = Resolve(smf, "igBeginChild_Str", g_api.beginChild) && ok;
		ok = Resolve(smf, "igEndChild", g_api.endChild) && ok;
		ok = Resolve(smf, "igSetNextWindowPos", g_api.setPos) && ok;
		ok = Resolve(smf, "igSetNextWindowSize", g_api.setSize) && ok;
		ok = Resolve(smf, "igSetNextWindowFocus", g_api.setFocus) && ok;
		ok = Resolve(smf, "igIsKeyPressed_Bool", g_api.keyPressed) && ok;
		if (Resolve(smf, "GetMenuFrameworkVersion", g_api.version))
			g_version = g_api.version();
		if (!ok) {
			logger::warn("smf-index: SMF {:.1f} lacks exports we need; pages can be listed but not opened", g_version);
			return;
		}
		g_iface = g_api.addWindow(&HostRender);
		if (g_iface) {
			g_iface->IsOpen = false;
			g_iface->BlockUserInput = true;
		}
		logger::info("smf-index: host window registered with SMF {:.1f} ({})", g_version, g_iface ? "ok" : "AddWindow returned null");
	}

	std::string ListJson()
	{
		json res{ { "ok", false }, { "present", GetModuleHandleW(L"SKSEMenuFramework.dll") != nullptr },
			{ "version", g_version }, { "canOpen", g_iface != nullptr }, { "msg", "" }, { "pages", json::array() } };
		if (!res["present"].get<bool>()) {
			res["msg"] = "SKSE Menu Framework is not installed";
			return res.dump();
		}
		std::vector<Page> pages;
		std::string       why;
		if (!Pages(pages, why)) {
			res["msg"] = why;
			return res.dump(-1, ' ', false, json::error_handler_t::replace);
		}
		for (const auto& p : pages)
			res["pages"].push_back(
				json{ { "path", p.path }, { "section", p.section }, { "label", p.label }, { "dll", p.dll } });
		res["ok"] = true;
		return res.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string Open(const std::string& path)
	{
		auto fail = [](std::string msg) {
			logger::warn("smf-index: open refused: {}", msg);
			return json{ { "ok", false }, { "msg", std::move(msg) } }.dump(-1, ' ', false, json::error_handler_t::replace);
		};
		if (!g_iface)
			return fail("SKSE Menu Framework's window could not be set up, so its pages cannot be opened from here");
		std::vector<Page> pages;
		std::string       why;
		if (!Pages(pages, why))
			return fail(why);
		const Page* hit = nullptr;
		for (const auto& p : pages)
			if (p.path == path) {
				hit = &p;
				break;
			}
		if (!hit)
			return fail("'" + path + "' is not a page in SKSE Menu Framework right now");

		std::string title;
		for (const char c : hit->path)
			title += c == '/' ? std::string("  /  ") : std::string(1, c);
		title += "###SkyManagerSmfHost";  // stable ImGui id whatever the page
		if (title.size() >= sizeof(g_title))
			title = hit->label + "###SkyManagerSmfHost";
		strncpy_s(g_title, title.c_str(), _TRUNCATE);

		g_target.store(reinterpret_cast<RenderFn>(hit->render), std::memory_order_release);
		g_focusNext = true;
		g_iface->BlockUserInput = true;
		g_iface->IsOpen = true;
		logger::info("smf-index: open '{}' ({})", hit->path, hit->dll);
		return json{ { "ok", true }, { "msg", "" } }.dump();
	}
}
