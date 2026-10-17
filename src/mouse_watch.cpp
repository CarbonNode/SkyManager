#include "mouse_watch.h"

#include "pch.h"

#include "cursor_keeper.h"
#include "freeze_backdrop.h"
#include "open_diag.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <string>
#include <utility>

namespace MouseWatch
{
	namespace
	{
		constexpr int          kMinMoves       = 4;     // raw move events in one second = the player moved the mouse
		constexpr int          kFrozenTicks    = 2;     // seconds of motion with a still cursor before it is called frozen
		constexpr int          kRefocusTick    = 4;     // MouseWatchRefocus=1: drop + retake focus here
		constexpr int          kRepeatDumpTick = 12;    // one more dump if it is still frozen
		constexpr int          kMaxDumps       = 40;    // per session, so a broken setup cannot fill the log
		constexpr std::int64_t kViewBeatStale  = 3000;  // ms without a view beat while the cursor moves = starved
		constexpr std::string_view kCursorMenu = "Cursor Menu";   // RE::CursorMenu::MENU_NAME

		Hooks g_hooks;

		// Written on the game thread (sink) and the Ultralight thread (beat).
		std::atomic<int>           g_rawMoves{ 0 };
		std::atomic<std::int64_t>  g_lastViewBeatMs{ 0 };
		std::atomic<std::int64_t>  g_lastKeyMs{ 0 };
		std::atomic<std::uint32_t> g_lastKeyCode{ 0 };

		// Main thread only.
		float        g_lastX = -1.f;
		float        g_lastY = -1.f;
		int          g_frozen = 0;
		int          g_starved = 0;
		std::int64_t g_frozenSinceMs = 0;
		int          g_dumps = 0;

		// Cursor assist (marker cursor-assist). The engine dispatches input on the
		// main thread, MenuControls first (registered at startup), so by the time
		// OUR sink sees a mouse move the engine's Cursor Menu has already moved
		// MenuCursor for it — or has not. Twelve raw moves (~0.2 s of motion) in
		// a row that leave the cursor exactly where we last saw it, away from a
		// screen edge, while a palette holds the keyboard = the engine is not
		// moving it. From then on this sink moves MenuCursor itself from the raw
		// deltas, at the pixels-per-count ratio it learned while the engine was
		// driving, and stops the moment a position changes that it did not write
		// (the engine is back). PrismaUI draws its sprite at MenuCursor and hands
		// the view that position on the next move, so the deck keeps working
		// while the log says what went wrong. Game thread only.
		constexpr int     kAssistAfterMoves = 12;
		std::atomic<bool> g_deckFocused{ false };   // Tick -> sink: a palette is open and holds focus
		std::atomic<bool> g_assist{ false };
		float             g_seenX = -1.f;            // MenuCursor after the previous raw move (engine's or ours)
		float             g_seenY = -1.f;
		int               g_stillMoves = 0;
		int               g_assistMoves = 0;
		float             g_scale = 1.f;             // cursor px per raw count, learned while the engine drives

		bool AtEdge(float x, float y, float w, float h)
		{
			return x <= 1.f || y <= 1.f || x >= w - 2.f || y >= h - 2.f;
		}

		std::string FocusMenuName()
		{
			auto learned = FreezeBackdrop::PrismaFocusMenu();
			return learned.empty() ? std::string("PrismaUI_FocusMenu") : learned;
		}

		std::string OpenMenus(RE::UI* ui)
		{
			std::string out;
			int         n = 0;
			for (auto& e : ui->menuMap) {
				if (!e.second.menu)
					continue;
				if (++n > 14) {
					out += ", ...";
					break;
				}
				if (!out.empty())
					out += ", ";
				out += std::string(e.first.c_str()) + "(d" + std::to_string(static_cast<int>(e.second.menu->depthPriority)) + ")";
			}
			return out.empty() ? std::string("none") : out;
		}

		std::string Age(std::int64_t now, std::int64_t then)
		{
			if (then <= 0)
				return "never";
			return std::to_string(now - then) + " ms ago";
		}

		void Dump(const char* tag, int moves, std::int64_t now)
		{
			if (++g_dumps > kMaxDumps)
				return;
			auto* ui = RE::UI::GetSingleton();
			auto* mc = RE::MenuCursor::GetSingleton();
			auto* cm = RE::ControlMap::GetSingleton();
			auto* mcs = RE::MenuControls::GetSingleton();
			auto* idm = RE::BSInputDeviceManager::GetSingleton();
			if (!ui || !mc)
				return;
			const auto&  rd = mc->GetRuntimeData();
			const auto   fm = FocusMenuName();
			int           textEntry = -1;
			std::uint32_t controls = 0;
			const char*   ignoreKbm = "n/a";
			if (cm) {
				const auto& crd = cm->GetRuntimeData();
				textEntry = static_cast<int>(crd.textEntryCount);
				controls = static_cast<std::uint32_t>(crd.enabledControls.underlying());
				ignoreKbm = crd.ignoreKeyboardMouse ? "yes" : "no";
			}
			std::string menus = "n/a";
			if (mcs) {
				const auto& mrd = mcs->GetRuntimeData();
				menus = std::string("remapMode ") + (mrd.remapMode ? "ON" : "off") + " processing " + (mrd.isProcessing ? "yes" : "no");
				// Is the engine's Cursor Menu even in MenuControls' handler list, and
				// how many handlers (mods' included) run before it? A handler ahead of
				// it that answers "handled" to a mouse move starves it.
				RE::MenuEventHandler* cur = nullptr;
				if (auto cmenu = ui->GetMenu<RE::CursorMenu>())
					cur = cmenu->AsMenuEventHandler();
				int idx = -1;
				const auto& hs = mcs->handlers;
				for (std::uint32_t i = 0; i < hs.size(); ++i) {
					if (hs[i] == cur) {
						idx = static_cast<int>(i);
						break;
					}
				}
				menus += " handlers " + std::to_string(hs.size()) + " cursorMenuHandler " +
				         (!cur ? std::string("no-menu") : idx >= 0 ? "#" + std::to_string(idx) : std::string("NOT-REGISTERED"));
			}
			std::string pad = "n/a";
			if (idm)
				pad = std::string(idm->IsGamepadEnabled() ? "enabled" : "disabled") + "/" + (idm->IsGamepadConnected() ? "connected" : "none");
			logger::warn("mouse-watch: cursor frozen? {} - raw mouse moves {}/s, cursor ({:.0f},{:.0f}) of {:.0f}x{:.0f} sens {:.2f} showCursorCount {} | Cursor Menu {} | focus menu '{}' {} | open menus: {} | textEntry {} controls 0x{:08X} ignoreKbm {} | {} | paused {} menusShown {} modal {} | gamepad {} | deck {} assist {} scale {:.2f} | view saw a move {} | last key 0x{:02X} {} | menus in the last 10 s: {}",  // marker: mouse-watch
				tag, moves, rd.cursorPosX, rd.cursorPosY, rd.screenWidthX, rd.screenWidthY, rd.cursorSensitivity, rd.showCursorCount,
				ui->IsMenuOpen(kCursorMenu) ? "open" : "CLOSED",
				fm, ui->IsMenuOpen(fm) ? "open" : "CLOSED",
				OpenMenus(ui), textEntry, controls, ignoreKbm, menus,
				ui->GameIsPaused() ? "yes" : "no", ui->IsShowingMenus() ? "yes" : "no", ui->modal ? "yes" : "no",
				pad,
				g_hooks.deckState ? g_hooks.deckState() : std::string("n/a"),
				g_assist.load() ? "ON" : "off", g_scale,
				Age(now, g_lastViewBeatMs.load()),
				g_lastKeyCode.load(), Age(now, g_lastKeyMs.load()),
				g_hooks.recentMenus ? g_hooks.recentMenus() : std::string("n/a"));
		}

		void ResetEpisode()
		{
			g_frozen = 0;
			g_starved = 0;
			g_frozenSinceMs = 0;
		}

		void EndAssist(const char* why)
		{
			if (!g_assist.exchange(false))
				return;
			const std::int64_t now = OpenDiag::NowMs();
			logger::info("mouse-watch: cursor assist off ({}) after {} assisted moves; last key 0x{:02X} {}",
				why, g_assistMoves, g_lastKeyCode.load(), Age(now, g_lastKeyMs.load()));
			g_assistMoves = 0;
			g_stillMoves = 0;
		}

		void BeginAssist(int moves, std::int64_t now)
		{
			g_assist = true;
			g_assistMoves = 0;
			logger::warn("mouse-watch: cursor still after {} raw moves while the deck holds the keyboard - driving MenuCursor from the raw mouse deltas (x{:.2f}) until the engine does (cursor-assist)",  // marker: cursor-assist
				g_stillMoves, g_scale);
			Dump("YES (assist starting)", moves, now);
			CursorKeeper::EnsureCursorMenu("cursor-assist");
		}

		void Drive(RE::MenuCursor* mc, float dx, float dy)
		{
			auto&       rd = mc->GetRuntimeData();
			const float w = rd.screenWidthX > 1.f ? rd.screenWidthX : 2560.f;
			const float h = rd.screenWidthY > 1.f ? rd.screenWidthY : 1440.f;
			rd.cursorPosX = std::clamp(rd.cursorPosX + dx * g_scale, 0.f, w - 1.f);
			rd.cursorPosY = std::clamp(rd.cursorPosY + dy * g_scale, 0.f, h - 1.f);
		}

		// One raw mouse move, game thread, after the engine has had its turn.
		void NoteMove(float dx, float dy)
		{
			if (!g_deckFocused.load(std::memory_order_relaxed)) {
				g_seenX = g_seenY = -1.f;
				g_stillMoves = 0;
				EndAssist("deck not focused");
				return;
			}
			auto* mc = RE::MenuCursor::GetSingleton();
			if (!mc)
				return;
			auto&       rd = mc->GetRuntimeData();
			const float x = rd.cursorPosX;
			const float y = rd.cursorPosY;
			const bool  fresh = g_seenX < 0.f;
			const bool  engineMoved = !fresh && (x != g_seenX || y != g_seenY);
			if (g_assist.load(std::memory_order_relaxed)) {
				if (engineMoved) {
					EndAssist("the engine moved it");
				} else {
					Drive(mc, dx, dy);
					++g_assistMoves;
				}
			} else if (engineMoved) {
				g_stillMoves = 0;
				// Learn the engine's pixels-per-count from a clean, mostly one-axis move.
				const bool  horiz = std::fabs(dx) >= std::fabs(dy);
				const float raw = horiz ? dx : dy;
				const float got = horiz ? (x - g_seenX) : (y - g_seenY);
				if (std::fabs(raw) >= 2.f) {
					const float r = got / raw;
					if (r > 0.05f && r < 20.f)
						g_scale = g_scale * 0.9f + r * 0.1f;
				}
			} else if (!fresh && !AtEdge(x, y, rd.screenWidthX, rd.screenWidthY)) {
				if (++g_stillMoves >= kAssistAfterMoves) {
					BeginAssist(g_rawMoves.load(), OpenDiag::NowMs());
					Drive(mc, dx, dy);
					++g_assistMoves;
				}
			}
			g_seenX = rd.cursorPosX;
			g_seenY = rd.cursorPosY;
		}
	}

	void Install(Hooks hooks)
	{
		g_hooks = std::move(hooks);
		logger::info("mouse-watch: comparing raw mouse motion with the cursor and the view under the open deck");  // marker: mouse-watch-armed
	}

	void NoteInputBatch(RE::InputEvent* const* a_events)
	{
		if (!a_events)
			return;
		for (auto e = *a_events; e; e = e->next) {
			switch (e->GetEventType()) {
			case RE::INPUT_EVENT_TYPE::kMouseMove: {
				auto m = e->AsMouseMoveEvent();
				if (m && (m->mouseInputX != 0 || m->mouseInputY != 0)) {
					g_rawMoves.fetch_add(1, std::memory_order_relaxed);
					NoteMove(static_cast<float>(m->mouseInputX), static_cast<float>(m->mouseInputY));
				}
				break;
			}
			case RE::INPUT_EVENT_TYPE::kButton: {
				auto b = e->AsButtonEvent();
				if (b && b->IsDown() && b->GetDevice() == RE::INPUT_DEVICE::kKeyboard) {
					g_lastKeyCode.store(b->GetIDCode(), std::memory_order_relaxed);
					g_lastKeyMs.store(OpenDiag::NowMs(), std::memory_order_relaxed);
				}
				break;
			}
			default:
				break;
			}
		}
	}

	void NoteViewMouse()
	{
		g_lastViewBeatMs.store(OpenDiag::NowMs(), std::memory_order_relaxed);
	}

	void Tick()
	{
		const int moves = g_rawMoves.exchange(0);
		const bool focused = g_hooks.paletteOpen && g_hooks.paletteOpen() && g_hooks.anyDeckFocused && g_hooks.anyDeckFocused();
		g_deckFocused.store(focused, std::memory_order_relaxed);
		if (!focused) {
			ResetEpisode();
			g_lastX = g_lastY = -1.f;
			g_seenX = g_seenY = -1.f;
			g_stillMoves = 0;
			EndAssist("deck closed");
			return;
		}
		auto* mc = RE::MenuCursor::GetSingleton();
		if (!mc)
			return;
		if (g_assist.load()) {
			// The sink is driving the cursor: what Tick would measure is our own
			// motion. The dump went out when the assist began; the end is logged
			// by the sink the moment the engine moves the cursor itself.
			g_lastX = mc->GetRuntimeData().cursorPosX;
			g_lastY = mc->GetRuntimeData().cursorPosY;
			ResetEpisode();
			return;
		}
		const auto& rd = mc->GetRuntimeData();
		const float x = rd.cursorPosX;
		const float y = rd.cursorPosY;
		const bool  first = g_lastX < 0.f;
		const bool  moved = !first && (std::fabs(x - g_lastX) > 0.5f || std::fabs(y - g_lastY) > 0.5f);
		g_lastX = x;
		g_lastY = y;
		if (first || moves < kMinMoves)
			return;   // no real motion this second: nothing to judge, the counts hold

		const std::int64_t now = OpenDiag::NowMs();
		if (moved) {
			if (g_frozen >= kFrozenTicks)
				logger::info("mouse-watch: cursor moving again after {} s still; last key 0x{:02X} {}",
					(now - g_frozenSinceMs) / 1000, g_lastKeyCode.load(), Age(now, g_lastKeyMs.load()));
			g_frozen = 0;
			g_frozenSinceMs = 0;
			// B: the cursor moves but the view has not seen a mousemove in a while.
			const bool mainFocused = g_hooks.mainDeckFocused && g_hooks.mainDeckFocused();
			if (mainFocused && now - g_lastViewBeatMs.load() > kViewBeatStale) {
				if (++g_starved == kFrozenTicks)
					Dump("no, the cursor moves but the VIEW gets no mouse events (a sink ahead of PrismaUI's?)", moves, now);
			} else {
				g_starved = 0;
			}
			return;
		}
		// At a screen edge a moving mouse legitimately leaves the cursor still.
		if (x <= 1.f || y <= 1.f || x >= rd.screenWidthX - 2.f || y >= rd.screenWidthY - 2.f)
			return;
		g_starved = 0;
		if (g_frozen++ == 0)
			g_frozenSinceMs = now;
		if (g_frozen == kFrozenTicks) {
			Dump("YES", moves, now);
			CursorKeeper::EnsureCursorMenu("mouse-watch");
		} else if (g_frozen == kRefocusTick && g_hooks.refocus && OpenDiag::IniBool("MouseWatchRefocus", false)) {
			logger::warn("mouse-watch: still frozen after {} s - dropping and retaking PrismaUI focus (MouseWatchRefocus=1)", kRefocusTick);
			g_hooks.refocus();
		} else if (g_frozen == kRepeatDumpTick) {
			Dump("still", moves, now);
		}
	}
}
