#include "smf_widget.h"

#include "menu_actions.h"

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

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace SmfWidget
{
	namespace
	{
		using json = nlohmann::json;

		// ── SMF 3.x ABI (source commit 592860b; names checked against the
		//    rig's SKSEMenuFramework.dll export table, 2026-10-07) ───────────
		struct Vec2  // ImVec2: 8 bytes, passed by value in one register
		{
			float x, y;
		};
		struct DrawList;  // ImDrawList, opaque
		struct Font;      // ImFont, opaque

		using HudFn = void(__stdcall*)();
		using InputFn = bool(__stdcall*)(RE::InputEvent*);
		using RegisterHudFn = std::int64_t (*)(HudFn);
		using RegisterInputFn = std::int64_t (*)(InputFn);
		using BlockingFn = bool (*)();
		using FgListFn = DrawList* (*)();
		using RectFilledFn = void (*)(DrawList*, Vec2, Vec2, std::uint32_t, float, int);
		using RectFn = void (*)(DrawList*, Vec2, Vec2, std::uint32_t, float, int, float);
		using ImageFn = void (*)(DrawList*, void*, Vec2, Vec2, Vec2, Vec2, std::uint32_t);
		using LoadTextureFn = void* (*)(const char*, Vec2*);
		using TextFn = void (*)(DrawList*, const Font*, float, Vec2, std::uint32_t, const char*, const char*, float,
			const void*);
		using CalcFn = void (*)(Vec2*, const char*, const char*, bool, float);
		using GetFontFn = Font* (*)();
		using FontSizeFn = float (*)();

		struct Api
		{
			RegisterHudFn   registerHud = nullptr;
			RegisterInputFn registerInput = nullptr;
			BlockingFn      blocking = nullptr;
			FgListFn        fgList = nullptr;
			RectFilledFn    rectFilled = nullptr;
			RectFn          rect = nullptr;
			ImageFn         image = nullptr;        // optional: no icon without it
			LoadTextureFn   loadTexture = nullptr;  // optional
			TextFn          text = nullptr;
			CalcFn          calc = nullptr;
			GetFontFn       font = nullptr;
			FontSizeFn      fontSize = nullptr;
		} g_api;

		// IM_COL32: ImGui packs colours as ABGR.
		constexpr std::uint32_t Col(std::uint32_t r, std::uint32_t g, std::uint32_t b, std::uint32_t a)
		{
			return (a << 24) | (b << 16) | (g << 8) | r;
		}

		constexpr const char*   kLabel = "Mod Menus";
		constexpr const char*   kHint = "Opens SKSE Menu Framework. Drag to move.";
		// The deck's own art for this action (the seeded "SKSE Menu" entry's icon).
		constexpr const char*   kIconPath = "Data/PrismaUI/views/HotkeyDeck/icons/custom/hk-skse-menu.png";
		constexpr std::uint64_t kOpenDeadlineMs = 1500;  // open-smf needs ~0.3 s
		constexpr std::uint64_t kStatusMs = 7000;

		// Menus, from the UI event sink.
		std::atomic<bool> g_journal{ false };
		std::atomic<bool> g_msgbox{ false };

		// Everything below is touched only on the main thread: SMF runs the
		// HUD callback from its render hook and the input callback from its
		// input hook, and both hooks sit in the game's main loop.
		bool          g_shown = false;    // drawn on the last frame
		float         g_rx = 0, g_ry = 0, g_rw = 0, g_rh = 0;  // last drawn rect, px
		bool          g_placed = false;   // the player has put it somewhere
		float         g_cx = 0, g_cy = 0; // its centre, 0..1 of the screen
		bool          g_pressed = false;
		bool          g_dragging = false;
		float         g_pressX = 0, g_pressY = 0;  // cursor at mouse-down
		float         g_grabX = 0, g_grabY = 0;    // cursor minus rect origin
		bool          g_opening = false;
		std::uint64_t g_openT = 0;
		std::string   g_status;
		std::uint64_t g_statusUntil = 0;
		bool          g_loggedHit = false;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "smf-widget.json";
		}

		// -> false when the sidecar turns the button off.
		bool LoadSidecar()
		{
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return true;
			const auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return true;
			if (j.contains("x") && j.contains("y") && j["x"].is_number() && j["y"].is_number()) {
				g_cx = std::clamp(j["x"].get<float>(), 0.0f, 1.0f);
				g_cy = std::clamp(j["y"].get<float>(), 0.0f, 1.0f);
				g_placed = true;
			}
			return !(j.contains("enabled") && j["enabled"].is_boolean() && !j["enabled"].get<bool>());
		}

		void SaveSidecar()
		{
			std::error_code ec;
			std::filesystem::create_directories(SidecarPath().parent_path(), ec);
			std::ofstream out(SidecarPath(), std::ios::binary | std::ios::trunc);
			if (!out) {
				logger::warn("smf-widget: could not write {}", PathU8(SidecarPath()));
				return;
			}
			out << json{ { "enabled", true }, { "x", g_cx }, { "y", g_cy } }.dump(1, '\t');
		}

		// The game's menu cursor in ImGui pixels. MenuCursor keeps its own
		// extent beside the position, so scale by it rather than assume the
		// two spaces are the same size.
		bool Cursor(float w, float h, float& x, float& y)
		{
			const auto* mc = RE::MenuCursor::GetSingleton();
			if (!mc)
				return false;
			const auto& rd = mc->GetRuntimeData();
			const float sx = rd.screenWidthX > 1.0f ? w / rd.screenWidthX : 1.0f;
			const float sy = rd.screenWidthY > 1.0f ? h / rd.screenWidthY : 1.0f;
			x = rd.cursorPosX * sx;
			y = rd.cursorPosY * sy;
			return true;
		}

		void Screen(float& w, float& h)
		{
			const auto s = RE::BSGraphics::Renderer::GetScreenSize();
			w = s.width ? static_cast<float>(s.width) : 2560.0f;
			h = s.height ? static_cast<float>(s.height) : 1440.0f;
		}

		bool OverButton(float x, float y)
		{
			return g_shown && x >= g_rx && x <= g_rx + g_rw && y >= g_ry && y <= g_ry + g_rh;
		}

		void EndPress(bool keepPlace)
		{
			if (g_dragging && keepPlace)
				SaveSidecar();
			g_pressed = false;
			g_dragging = false;
		}

		// SMF loads the PNG into its own D3D device and keeps it. Its WIC path
		// returns an uninitialised pointer when a file exists but does not
		// decode, so the file is proven to be a PNG before SMF is asked.
		void* IconTexture()
		{
			static bool  tried = false;
			static void* tex = nullptr;
			if (tried)
				return tex;
			tried = true;
			if (!g_api.image || !g_api.loadTexture)
				return nullptr;
			static const unsigned char kPng[8] = { 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A };
			unsigned char              head[8] = {};
			std::ifstream              in(kIconPath, std::ios::binary);
			if (!in.read(reinterpret_cast<char*>(head), sizeof(head)) || std::memcmp(head, kPng, sizeof(kPng)) != 0) {
				logger::warn("smf-widget: icon {} is missing or not a PNG; button drawn without it", kIconPath);
				return nullptr;
			}
			in.close();
			tex = g_api.loadTexture(kIconPath, nullptr);
			if (!tex)
				logger::warn("smf-widget: SKSE Menu Framework could not load {}", kIconPath);
			return tex;
		}

		float TextWidth(const char* s, float px)
		{
			Vec2        sz{ 0.0f, 0.0f };
			const float base = g_api.fontSize();
			g_api.calc(&sz, s, nullptr, false, -1.0f);
			return base > 0.0f ? sz.x * (px / base) : sz.x;
		}

		// SMF's render pass, every frame.
		void __stdcall OnHud()
		{
			if (!g_journal.load(std::memory_order_relaxed)) {
				if (g_pressed)
					EndPress(true);
				g_shown = false;
				return;
			}
			const std::uint64_t now = GetTickCount64();
			const bool          blocking = g_api.blocking();
			if (g_opening) {
				if (blocking) {
					g_opening = false;
					logger::info("smf-widget: SKSE Menu Framework opened");
				} else if (now - g_openT > kOpenDeadlineMs) {
					g_opening = false;
					const std::string how = MenuActions::SmfToggleHint();
					g_status = how.empty() ? "SKSE Menu Framework did not open. Its own key is turned off."
										   : "SKSE Menu Framework did not open. Press " + how + ".";
					g_statusUntil = now + kStatusMs;
					logger::warn("smf-widget: open not confirmed after {} ms", kOpenDeadlineMs);
				}
			}
			// An SMF panel or a confirm box owns the screen: stand down.
			if (blocking || g_msgbox.load(std::memory_order_relaxed)) {
				if (g_pressed)
					EndPress(true);
				g_shown = false;
				return;
			}
			DrawList* dl = g_api.fgList();
			if (!dl)
				return;

			float w = 0, h = 0;
			Screen(w, h);
			const float u = h / 1440.0f;                       // 1 unit = 1 px at 1440p
			const float fs = std::max(22.0f, 34.0f * u);       // label
			const float fs2 = std::max(20.0f, 26.0f * u);      // hint / status
			const float padX = 28.0f * u, gap = 16.0f * u, edge = 8.0f * u;
			const Font* font = g_api.font();
			void* const tex = IconTexture();
			const float icon = tex ? 56.0f * u : 0.0f;         // no art, no gap for it

			const float bw = padX + (tex ? icon + gap : 0.0f) + TextWidth(kLabel, fs) + padX;
			const float bh = 86.0f * u;
			if (!g_placed) {
				// Top-right corner: clear of the journal's tabs and its lists.
				g_cx = (w - 48.0f * u - bw * 0.5f) / w;
				g_cy = (44.0f * u + bh * 0.5f) / h;
			}

			float cx = 0, cy = 0;
			const bool haveCursor = Cursor(w, h, cx, cy);
			if (g_pressed && haveCursor) {
				if (!g_dragging && std::hypot(cx - g_pressX, cy - g_pressY) > 8.0f * u)
					g_dragging = true;
				if (g_dragging) {
					g_cx = (cx - g_grabX + bw * 0.5f) / w;
					g_cy = (cy - g_grabY + bh * 0.5f) / h;
					g_placed = true;
				}
			}
			float x = g_cx * w - bw * 0.5f;
			float y = g_cy * h - bh * 0.5f;
			x = std::clamp(x, edge, std::max(edge, w - bw - edge));
			y = std::clamp(y, edge, std::max(edge, h - bh - edge));
			if (g_dragging) {  // store what is drawn, so the saved place is on screen
				g_cx = (x + bw * 0.5f) / w;
				g_cy = (y + bh * 0.5f) / h;
			}
			g_rx = x, g_ry = y, g_rw = bw, g_rh = bh;
			g_shown = true;

			const bool hover = haveCursor && (g_pressed || OverButton(cx, cy));
			const auto fill = g_pressed ? Col(46, 36, 20, 244) : hover ? Col(32, 26, 17, 240) : Col(16, 13, 10, 224);
			const auto line = g_dragging ? Col(244, 212, 142, 255) : hover ? Col(224, 192, 126, 255) : Col(160, 132, 82, 210);
			const auto ink = hover ? Col(250, 242, 224, 255) : Col(232, 222, 202, 255);
			const float rad = 12.0f * u;

			g_api.rectFilled(dl, { x + 2.0f * u, y + 4.0f * u }, { x + bw + 2.0f * u, y + bh + 4.0f * u },
				Col(0, 0, 0, 110), rad, 0);
			g_api.rectFilled(dl, { x, y }, { x + bw, y + bh }, fill, rad, 0);
			g_api.rect(dl, { x, y }, { x + bw, y + bh }, line, rad, 0, (hover ? 3.0f : 2.0f) * u);

			float tx = x + padX;
			if (tex) {
				const float iy = y + (bh - icon) * 0.5f;
				g_api.image(dl, tex, { tx, iy }, { tx + icon, iy + icon }, { 0.0f, 0.0f }, { 1.0f, 1.0f },
					hover ? Col(255, 255, 255, 255) : Col(255, 255, 255, 226));
				tx += icon + gap;
			}
			g_api.text(dl, font, fs, { tx, y + (bh - fs) * 0.5f }, ink, kLabel, nullptr, 0.0f, nullptr);

			// One line under the button: why the open failed, else what it does.
			if (!g_status.empty() && now > g_statusUntil)
				g_status.clear();
			const bool  failed = !g_status.empty();
			const char* note = failed ? g_status.c_str() : (hover && !g_dragging ? kHint : nullptr);
			if (note) {
				const float nPad = 20.0f * u;
				const float nw = TextWidth(note, fs2) + nPad * 2.0f;
				const float nh = fs2 + nPad * 1.2f;
				float       nx = std::clamp(x, edge, std::max(edge, w - nw - edge));
				float       ny = y + bh + 10.0f * u;
				if (ny + nh > h - edge)
					ny = y - nh - 10.0f * u;
				g_api.rectFilled(dl, { nx, ny }, { nx + nw, ny + nh }, Col(12, 10, 8, 236), 8.0f * u, 0);
				g_api.rect(dl, { nx, ny }, { nx + nw, ny + nh }, failed ? Col(214, 120, 96, 255) : Col(120, 100, 66, 220),
					8.0f * u, 0, 1.5f * u);
				g_api.text(dl, font, fs2, { nx + nPad, ny + (nh - fs2) * 0.5f },
					failed ? Col(246, 214, 204, 255) : Col(214, 204, 184, 255), note, nullptr, 0.0f, nullptr);
			}
		}

		// SMF's input hook, once per event. true = the game never sees it.
		bool __stdcall OnInput(RE::InputEvent* e)
		{
			if (!g_shown && !g_pressed)
				return false;  // the common case: not in the Esc menu
			const auto* btn = e ? e->AsButtonEvent() : nullptr;
			if (!btn || btn->GetDevice() != RE::INPUT_DEVICE::kMouse || btn->GetIDCode() != 0)
				return false;

			if (btn->IsDown()) {
				float w = 0, h = 0, cx = 0, cy = 0;
				Screen(w, h);
				if (g_opening || !Cursor(w, h, cx, cy) || !OverButton(cx, cy))
					return false;
				g_pressed = true;
				g_dragging = false;
				g_pressX = cx, g_pressY = cy;
				g_grabX = cx - g_rx, g_grabY = cy - g_ry;
				if (!g_loggedHit) {
					g_loggedHit = true;
					const auto& rd = RE::MenuCursor::GetSingleton()->GetRuntimeData();
					logger::info("smf-widget: first press at {:.0f},{:.0f} (cursor {:.0f},{:.0f} of {:.0f}x{:.0f}; screen {:.0f}x{:.0f})",
						cx, cy, rd.cursorPosX, rd.cursorPosY, rd.screenWidthX, rd.screenWidthY, w, h);
				}
				return true;
			}
			if (!g_pressed)
				return false;
			if (btn->IsUp()) {
				const bool wasDrag = g_dragging;
				EndPress(true);
				if (wasDrag) {
					logger::info("smf-widget: moved to {:.3f},{:.3f}", g_cx, g_cy);
				} else {
					g_status.clear();
					g_opening = true;
					g_openT = GetTickCount64();
					logger::info("smf-widget: click, opening SKSE Menu Framework");
					MenuActions::Fire("open-smf");
				}
			}
			return true;  // down, held and up of OUR press all stay ours
		}

		class MenuSink : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (ev) {
					if (ev->menuName == RE::JournalMenu::MENU_NAME)
						g_journal.store(ev->opening, std::memory_order_relaxed);
					else if (ev->menuName == RE::MessageBoxMenu::MENU_NAME)
						g_msgbox.store(ev->opening, std::memory_order_relaxed);
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		MenuSink g_menuSink;
		bool     g_armed = false;

		template <class F>
		bool Resolve(HMODULE smf, const char* name, F& out)
		{
			out = reinterpret_cast<F>(GetProcAddress(smf, name));
			if (!out)
				logger::warn("smf-widget: SKSEMenuFramework.dll has no export '{}'", name);
			return out != nullptr;
		}
	}

	void Init()
	{
		if (g_armed)
			return;
		const auto smf = GetModuleHandleW(L"SKSEMenuFramework.dll");
		if (!smf)
			return;  // smf-index already logged that SMF is absent
		if (!LoadSidecar()) {
			logger::info("smf-widget: turned off in smf-widget.json");
			return;
		}
		bool ok = Resolve(smf, "RegisterHudElement", g_api.registerHud);
		ok = Resolve(smf, "RegisterInpoutEvent", g_api.registerInput) && ok;
		ok = Resolve(smf, "IsAnyBlockingWindowOpened", g_api.blocking) && ok;
		ok = Resolve(smf, "igGetForegroundDrawList_Nil", g_api.fgList) && ok;
		ok = Resolve(smf, "ImDrawList_AddRectFilled", g_api.rectFilled) && ok;
		ok = Resolve(smf, "ImDrawList_AddRect", g_api.rect) && ok;
		ok = Resolve(smf, "ImDrawList_AddText_FontPtr", g_api.text) && ok;
		ok = Resolve(smf, "igCalcTextSize", g_api.calc) && ok;
		ok = Resolve(smf, "igGetFont", g_api.font) && ok;
		ok = Resolve(smf, "igGetFontSize", g_api.fontSize) && ok;
		Resolve(smf, "ImDrawList_AddImage", g_api.image);
		Resolve(smf, "LoadTexture", g_api.loadTexture);
		if (!ok) {
			logger::warn("smf-widget: this SKSE Menu Framework lacks exports the Esc-menu button needs; button off");
			return;
		}
		auto* ui = RE::UI::GetSingleton();
		if (!ui)
			return;
		ui->AddEventSink<RE::MenuOpenCloseEvent>(&g_menuSink);
		g_journal = ui->IsMenuOpen(RE::JournalMenu::MENU_NAME);
		g_api.registerInput(&OnInput);
		g_api.registerHud(&OnHud);
		g_armed = true;
		logger::info("smf-widget: Esc-menu Mod Menus button armed");
	}
}
