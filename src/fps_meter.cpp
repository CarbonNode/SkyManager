#include "fps_meter.h"

// pch (force-included) provides RE::/SKSE::/logger, nlohmann json (<json.hpp>)
// and, via RE/Skyrim.h, <Windows.h> (QueryPerformanceCounter, SendInput,
// MapVirtualKeyW) — whose min/max macros are dropped below for std::clamp.
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <thread>
#include <vector>

namespace FpsMeter
{
	using json = nlohmann::json;

	namespace
	{
		// ------------------------------------------------------ the switch --
		std::atomic<bool> g_want{ false };
		std::atomic<int>  g_rateMs{ 1000 };
		std::atomic<bool> g_reprime{ true };   // next sample only primes

		// ------------------------------------------- present-thread counts --
		std::atomic<std::uint64_t> g_frames{ 0 };
		std::atomic<std::int64_t>  g_lastQpc{ 0 };
		std::atomic<std::int64_t>  g_maxDelta{ 0 };   // slowest frame since the last sample, QPC ticks

		std::int64_t QpcNow()
		{
			LARGE_INTEGER t;
			QueryPerformanceCounter(&t);
			return t.QuadPart;
		}
		double QpcFreq()
		{
			static const double f = [] {
				LARGE_INTEGER q;
				QueryPerformanceFrequency(&q);
				return static_cast<double>(q.QuadPart);
			}();
			return f;
		}

		// ------------------------------------------ PureDark's FG counters --
		// PDPerfPlugin.dll!GetFgFrameCounters, layout read from the rig's
		// 1.20.15 build (see the header). The export checks size and version
		// and returns false for anything else, so a future layout change makes
		// this report "not available" instead of reading garbage.
		struct FgFrameCountersV2
		{
			std::uint32_t size = 0x28;
			std::uint32_t version = 2;
			std::uint64_t framegenFrames = 0;   // +0x08
			std::uint64_t sourceFrames = 0;     // +0x10
			std::uint64_t fwPresents = 0;       // +0x18 PD FrameWarp presents
			std::uint32_t owner = 0;            // +0x20 0 = DLSS-G owns presentation
			std::uint32_t pad = 0;
		};
		static_assert(sizeof(FgFrameCountersV2) == 0x28);
		using GetFgFrameCountersFn = bool (*)(FgFrameCountersV2*);

		GetFgFrameCountersFn g_pdFn = nullptr;
		int                  g_pdRetry = 0;
		bool                 g_pdMissingLogged = false;

		GetFgFrameCountersFn PdFn()
		{
			if (g_pdFn)
				return g_pdFn;
			// GetModuleHandle is cheap, but there is no point asking every
			// sample on a machine without the Upscaler: every 10th.
			if (g_pdRetry-- > 0)
				return nullptr;
			g_pdRetry = 10;
			const HMODULE m = GetModuleHandleW(L"PDPerfPlugin.dll");
			if (!m)
				return nullptr;
			g_pdFn = reinterpret_cast<GetFgFrameCountersFn>(GetProcAddress(m, "GetFgFrameCounters"));
			if (g_pdFn)
				logger::info("fps: PureDark frame-gen counters found (PDPerfPlugin.dll GetFgFrameCounters)");  // marker: fps-pd-counters
			else if (!g_pdMissingLogged) {
				g_pdMissingLogged = true;
				logger::info("fps: PDPerfPlugin.dll has no GetFgFrameCounters - frame-gen fps not available on this Upscaler build");
			}
			return g_pdFn;
		}

		// SEH, no C++ objects: a foreign build that faults here must cost the
		// reading, never the game.
		bool CallPd(GetFgFrameCountersFn fn, FgFrameCountersV2* out)
		{
			__try {
				return fn(out);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		// -------------------------------------------- sampler (main thread) --
		struct SampleState
		{
			std::int64_t      qpc = 0;
			std::uint64_t     frames = 0;
			bool              pdValid = false;
			FgFrameCountersV2 pd{};
			std::string       last;
			int               diagLines = 0;
		};
		SampleState g_s;

		// ----------------------------------------- Community Shaders overlay --
		std::atomic<bool> g_csAuto{ false };
		std::atomic<bool> g_csOn{ false };        // tracked; CS starts hidden every launch
		std::atomic<bool> g_csAutoDone{ false };
		std::atomic<bool> g_csPresent{ false };
		std::atomic<bool> g_csChecked{ false };

		struct CsKey
		{
			bool                       loaded = false;
			bool                       bound = true;
			std::uint32_t              dik = 0x44;          // F10
			std::vector<std::uint32_t> modVks;              // VK_SHIFT / VK_CONTROL / VK_MENU
			std::vector<std::uint32_t> modDiks;
			std::string                name = "F10";
		};
		std::mutex        g_keyMtx;
		CsKey             g_key;
		std::atomic<bool> g_keyReady{ false };
		std::atomic<bool> g_keyLoading{ false };
		// Lock-free copy of what NoteKey needs on the game thread.
		std::atomic<std::uint32_t> g_keyDik{ 0 };
		std::atomic<std::uint32_t> g_keyModMask{ 0 };   // 1 shift, 2 ctrl, 4 alt

		std::uint32_t VkToDik(std::uint32_t vk)
		{
			const UINT sc = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
			if (!sc)
				return 0;
			const bool ext = (sc & 0xFF00) == 0xE000 || (sc & 0xFF00) == 0xE100;
			return (sc & 0x7F) | (ext ? 0x80u : 0u);
		}

		std::string KeyName(std::uint32_t vk)
		{
			if (vk >= VK_F1 && vk <= VK_F24)
				return "F" + std::to_string(vk - VK_F1 + 1);
			switch (vk) {
			case VK_SHIFT: return "Shift";
			case VK_CONTROL: return "Ctrl";
			case VK_MENU: return "Alt";
			case VK_END: return "End";
			case VK_HOME: return "Home";
			case VK_INSERT: return "Insert";
			case VK_DELETE: return "Delete";
			case VK_PRIOR: return "Page Up";
			case VK_NEXT: return "Page Down";
			case VK_MULTIPLY: return "Num *";
			case VK_ADD: return "Num +";
			case VK_SUBTRACT: return "Num -";
			case VK_DIVIDE: return "Num /";
			default: break;
			}
			if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9)
				return "Num " + std::to_string(vk - VK_NUMPAD0);
			const UINT sc = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
			LONG       lp = static_cast<LONG>((sc & 0xFF) << 16);
			if ((sc & 0xFF00) == 0xE000)
				lp |= 1 << 24;
			wchar_t buf[64]{};
			if (GetKeyNameTextW(lp, buf, 64) > 0) {
				char out[192]{};
				const int n = WideCharToMultiByte(CP_UTF8, 0, buf, -1, out, sizeof(out), nullptr, nullptr);
				if (n > 1)
					return std::string(out);
			}
			return "key " + std::to_string(vk);
		}

		// CS keeps the bind as a plain VK (121), an array of VKs for a combo
		// ([16,35] = Shift+End), or 0 when unbound (Menu.cpp loadComboList).
		CsKey ReadCsKey()
		{
			CsKey k;
			k.loaded = true;
			std::vector<std::uint32_t> vks;
			try {
				const auto    path = std::filesystem::path("Data") / "SKSE" / "Plugins" / "CommunityShaders" / "SettingsUser.json";
				std::ifstream f(path, std::ios::binary);
				if (f) {
					const json j = json::parse(f, nullptr, false);
					if (j.is_object() && j.contains("Menu") && j["Menu"].is_object() && j["Menu"].contains("OverlayToggleKey")) {
						const auto& v = j["Menu"]["OverlayToggleKey"];
						if (v.is_number_integer())
							vks.push_back(v.get<std::uint32_t>());
						else if (v.is_array())
							for (const auto& e : v)
								if (e.is_number_integer())
									vks.push_back(e.get<std::uint32_t>());
						if (vks.empty() || (vks.size() == 1 && vks[0] == 0)) {
							k.bound = false;
							k.name = "unbound";
							return k;
						}
					}
				}
			} catch (...) {
				vks.clear();
			}
			if (vks.empty())
				vks.push_back(VK_F10);   // CS's default (Menu.h)
			const std::uint32_t main = vks.back();
			k.dik = VkToDik(main);
			k.name.clear();
			for (std::size_t i = 0; i + 1 < vks.size(); ++i) {
				const auto vk = vks[i];
				k.modVks.push_back(vk);
				k.modDiks.push_back(VkToDik(vk));
				k.name += KeyName(vk) + "+";
			}
			k.name += KeyName(main);
			if (!k.dik)
				k.bound = false;
			return k;
		}

		void PublishKey(const CsKey& k)
		{
			std::uint32_t mask = 0;
			for (auto vk : k.modVks)
				mask |= vk == VK_SHIFT ? 1u : vk == VK_CONTROL ? 2u : vk == VK_MENU ? 4u : 0u;
			g_keyModMask = mask;
			g_keyDik = k.bound ? k.dik : 0;
			g_keyReady = true;
		}

		// Reads the bind off the game thread the first time anyone needs it.
		void EnsureKeyAsync()
		{
			if (g_keyReady.load() || g_keyLoading.exchange(true))
				return;
			std::thread([] {
				CsKey k = ReadCsKey();
				{
					std::lock_guard l(g_keyMtx);
					g_key = k;
				}
				PublishKey(k);
				logger::info("fps: Community Shaders overlay key is {}", k.name);  // marker: fps-cs-key
			}).detach();
		}

		void SendScan(std::uint32_t dik, bool down)
		{
			INPUT in{};
			in.type = INPUT_KEYBOARD;
			in.ki.wScan = static_cast<WORD>(dik & 0x7F);
			in.ki.dwFlags = KEYEVENTF_SCANCODE;
			if (dik > 0x7F)
				in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
			if (!down)
				in.ki.dwFlags |= KEYEVENTF_KEYUP;
			SendInput(1, &in, sizeof(INPUT));
		}

		std::atomic<bool> g_pressing{ false };

		// Detached worker. The bind is re-read first: CS saves its settings
		// whenever its own menu closes, so a rebind takes effect on the next
		// press without a restart. Each edge is held a beat longer than one
		// engine frame (frame generation can put 30 ms between real frames),
		// or the engine polls down and up in one batch.
		void PressCsKey()
		{
			if (g_pressing.exchange(true))
				return;
			std::thread([] {
				using namespace std::chrono_literals;
				CsKey k = ReadCsKey();
				{
					std::lock_guard l(g_keyMtx);
					g_key = k;
				}
				PublishKey(k);
				if (k.bound) {
					for (auto d : k.modDiks)
						if (d) SendScan(d, true);
					if (!k.modDiks.empty())
						std::this_thread::sleep_for(50ms);
					SendScan(k.dik, true);
					std::this_thread::sleep_for(90ms);
					SendScan(k.dik, false);
					if (!k.modDiks.empty()) {
						std::this_thread::sleep_for(50ms);
						for (auto d : k.modDiks)
							if (d) SendScan(d, false);
					}
					logger::info("fps: pressed {} for the Community Shaders overlay", k.name);
				} else {
					logger::info("fps: Community Shaders overlay key is unbound - nothing pressed");
				}
				std::this_thread::sleep_for(150ms);
				g_pressing = false;
			}).detach();
		}

		bool ModsHeld(std::uint32_t mask)
		{
			const auto held = [](int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; };
			if ((mask & 1) && !held(VK_SHIFT)) return false;
			if ((mask & 2) && !held(VK_CONTROL)) return false;
			if ((mask & 4) && !held(VK_MENU)) return false;
			return true;
		}

		int Round(double v) { return static_cast<int>(std::lround(v)); }
		double Round1(double v) { return std::round(v * 10.0) / 10.0; }
	}

	// ------------------------------------------------------------- frames --
	void OnFrame()
	{
		if (!g_want.load(std::memory_order_relaxed))
			return;
		const std::int64_t now = QpcNow();
		const std::int64_t prev = g_lastQpc.exchange(now, std::memory_order_relaxed);
		if (prev > 0) {
			const std::int64_t d = now - prev;
			if (d > g_maxDelta.load(std::memory_order_relaxed))
				g_maxDelta.store(d, std::memory_order_relaxed);
		}
		g_frames.fetch_add(1, std::memory_order_relaxed);
	}

	void SetConfig(bool widgetOn, int rateMs, bool csAuto)
	{
		const bool was = g_want.exchange(widgetOn);
		if (widgetOn && !was) {
			g_lastQpc = 0;
			g_maxDelta = 0;
			g_reprime = true;
		}
		g_rateMs = std::clamp(rateMs, 500, 2000);
		g_csAuto = csAuto;
	}
	bool Wanted() { return g_want.load(); }
	int  RateMs() { return g_rateMs.load(); }

	std::string SampleJson(bool force)
	{
		auto&              s = g_s;
		const std::int64_t now = QpcNow();
		const std::uint64_t frames = g_frames.load(std::memory_order_relaxed);

		FgFrameCountersV2 pd{};
		bool              pdOk = false;
		if (auto fn = PdFn())
			pdOk = CallPd(fn, &pd);

		if (g_reprime.exchange(false) || s.qpc == 0) {
			s.qpc = now;
			s.frames = frames;
			s.pd = pd;
			s.pdValid = pdOk;
			g_maxDelta = 0;
			return {};
		}
		const double dt = (now - s.qpc) / QpcFreq();
		if (dt < 0.2)
			return {};
		const double engine = static_cast<double>(frames - s.frames) / dt;
		const double worstMs = g_maxDelta.exchange(0, std::memory_order_relaxed) * 1000.0 / QpcFreq();

		json fg = json::object();
		if (pdOk && s.pdValid && pd.framegenFrames >= s.pd.framegenFrames && pd.sourceFrames >= s.pd.sourceFrames) {
			const double fgRate = static_cast<double>(pd.framegenFrames - s.pd.framegenFrames) / dt;
			const double srcRate = static_cast<double>(pd.sourceFrames - s.pd.sourceFrames) / dt;
			const double fwRate = pd.fwPresents >= s.pd.fwPresents ? static_cast<double>(pd.fwPresents - s.pd.fwPresents) / dt : 0.0;
			// What PureDark's own menu calls "Framegen FPS": the FrameWarp
			// presenter's rate while FrameWarp owns presentation, else DLSS-G's.
			const double out = pd.owner ? fwRate : fgRate;
			if (out >= 1.0) {
				fg["ok"] = true;
				fg["o"] = Round(out);
				if (engine >= 1.0)
					fg["x"] = Round1(out / engine);
				fg["fw"] = pd.owner != 0;
			} else {
				// FG initialised but not producing: PureDark stands it down in
				// menus and loading screens, or it was toggled off with its key.
				fg["ok"] = false;
				fg["why"] = "idle";
			}
			if (s.diagLines < 3 && engine >= 5.0) {
				++s.diagLines;
				logger::info("fps: engine {:.1f} fps | PureDark framegen {:.1f}/s, source {:.1f}/s, framewarp {:.1f}/s, owner {} (framegen/engine {:.2f})",
					engine, fgRate, srcRate, fwRate, pd.owner, engine > 0 ? fgRate / engine : 0.0);  // marker: fps-pd-sample
			}
		} else {
			fg["ok"] = false;
			fg["why"] = GetModuleHandleW(L"SkyrimUpscaler.dll") ? (g_pdFn ? "idle" : "nocounter") : "none";
		}

		s.qpc = now;
		s.frames = frames;
		s.pd = pd;
		s.pdValid = pdOk;

		json j = {
			{ "e", Round(engine) },
			{ "ms", engine >= 1.0 ? Round1(1000.0 / engine) : 0.0 },
			{ "worst", Round(worstMs) },
			{ "fg", fg },
			{ "cs", json::parse(CsJson(), nullptr, false) },
		};
		std::string out = j.dump(-1, ' ', false, json::error_handler_t::replace);
		if (!force && out == s.last)
			return {};
		s.last = out;
		return out;
	}

	// ------------------------------------------------- Community Shaders --
	bool CsPresent()
	{
		if (g_csPresent.load())
			return true;
		// A DLL never unloads mid-session, so a "yes" is final; a "no" is
		// re-asked (cheap) in case something asks before plugins finish loading.
		const bool p = GetModuleHandleW(L"CommunityShaders.dll") != nullptr;
		if (p) {
			g_csPresent = true;
			EnsureKeyAsync();
		}
		g_csChecked = true;
		return p;
	}
	bool CsOn() { return g_csOn.load(); }

	std::string CsJson()
	{
		const bool present = CsPresent();
		std::string name = "F10";
		bool        bound = true;
		if (g_keyReady.load()) {
			std::lock_guard l(g_keyMtx);
			name = g_key.name;
			bound = g_key.bound;
		}
		json j = {
			{ "present", present },
			{ "on", present && g_csOn.load() },
			{ "key", name },
			{ "bound", bound },
			{ "auto", g_csAuto.load() },
		};
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	void NoteKey(std::uint32_t dik, bool down, bool up)
	{
		if (!g_csPresent.load(std::memory_order_relaxed)) {
			if (g_csChecked.load(std::memory_order_relaxed))
				return;
			if (!CsPresent())
				return;
		}
		if (!g_keyReady.load(std::memory_order_relaxed)) {
			EnsureKeyAsync();
			return;
		}
		const std::uint32_t want = g_keyDik.load(std::memory_order_relaxed);
		if (!want || dik != want)
			return;
		const std::uint32_t mask = g_keyModMask.load(std::memory_order_relaxed);
		// CS: a single-key bind fires on key-UP, a combo on key-DOWN with its
		// modifiers held (Menu.cpp dispatchHotkeyActions). Mirror both.
		const bool fires = mask == 0 ? up : (down && ModsHeld(mask));
		if (!fires)
			return;
		const bool now = !g_csOn.load();
		g_csOn = now;
		logger::info("fps: Community Shaders overlay is now {} (tracked)", now ? "ON" : "off");  // marker: fps-cs-tracked
	}

	void CsSet(bool on)
	{
		if (!CsPresent())
			return;
		if (g_csOn.load() == on)
			return;
		PressCsKey();
	}
	void CsToggle()
	{
		if (!CsPresent())
			return;
		PressCsKey();
	}

	bool CsAutoPending()
	{
		return g_csAuto.load() && !g_csAutoDone.load() && g_csPresent.load();
	}

	void CsAutoTick()
	{
		static std::int64_t s_since = 0;   // QPC when unpaused play began
		if (!CsAutoPending())
			return;
		auto* pc = RE::PlayerCharacter::GetSingleton();
		auto* ui = RE::UI::GetSingleton();
		const bool inWorld = pc && pc->GetParentCell() && ui && !ui->GameIsPaused() &&
		                     !ui->IsMenuOpen(RE::LoadingMenu::MENU_NAME) && !ui->IsMenuOpen(RE::MainMenu::MENU_NAME);
		if (!inWorld) {
			s_since = 0;
			return;
		}
		const std::int64_t now = QpcNow();
		if (!s_since) {
			s_since = now;
			return;
		}
		// A few seconds of real play first: CS swallows nothing then, and the
		// press does not land in the load's last frames.
		if ((now - s_since) / QpcFreq() < 3.0)
			return;
		g_csAutoDone = true;
		if (!g_csOn.load()) {
			logger::info("fps: turning the Community Shaders overlay on (turn on when the game loads)");  // marker: fps-cs-auto
			PressCsKey();
		}
	}
}
