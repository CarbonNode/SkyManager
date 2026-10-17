#include "cursor_keeper.h"

#include "pch.h"

#include "freeze_backdrop.h"
#include "open_diag.h"

#include <array>
#include <cstdint>
#include <string>
#include <utility>

namespace CursorKeeper
{
	namespace
	{
		// PrismaUI 1.4.1 names its focus menu this; FreezeBackdrop learns the real
		// name from the menu stack and wins when it has one.
		constexpr std::string_view kDefaultFocusMenu = "PrismaUI_FocusMenu";
		// The engine's own cursor menu (RE::CursorMenu::MENU_NAME): the menu whose
		// ProcessMouseMove moves MenuCursor. See EnsureCursorMenu in the header.
		constexpr std::string_view kCursorMenu = "Cursor Menu";

		constexpr std::int64_t kRecentMs   = 3000;   // menus listed in the warning
		constexpr std::int64_t kBurstMs    = 5000;
		constexpr int          kBurstLimit = 3;

		std::function<bool()> g_paletteOpen;
		std::function<bool()> g_holdsKeyboard;

		// Last menu opens/closes, for the warning. Main thread only.
		struct MenuEvent
		{
			std::string  name;
			bool         opening = false;
			std::int64_t ms      = 0;
		};
		std::array<MenuEvent, 10> g_recent{};
		std::size_t               g_recentNext = 0;

		std::int64_t g_burstStart = 0;
		int          g_burstCount = 0;

		std::string FocusMenuName()
		{
			auto learned = FreezeBackdrop::PrismaFocusMenu();
			return learned.empty() ? std::string(kDefaultFocusMenu) : learned;
		}

		std::string Recent(std::int64_t now, std::int64_t windowMs = kRecentMs)
		{
			std::string out;
			for (std::size_t i = 0; i < g_recent.size(); ++i) {
				const auto& e = g_recent[(g_recentNext + i) % g_recent.size()];
				if (e.name.empty() || now - e.ms > windowMs)
					continue;
				if (!out.empty())
					out += ", ";
				out += e.name + (e.opening ? " opened " : " closed ") + std::to_string(now - e.ms) + " ms ago";
			}
			return out.empty() ? std::string("none") : out;
		}

		bool LoadingScreenUp()
		{
			const auto ui = RE::UI::GetSingleton();
			return !ui || ui->IsMenuOpen(RE::LoadingMenu::MENU_NAME);
		}

		// One burst budget for both menus: three reopens in five seconds, then
		// the keeper stands down until the closes stop (it must never fight
		// another mod forever).
		bool BurstAllows(const char* what)
		{
			const std::int64_t now = OpenDiag::NowMs();
			if (now - g_burstStart > kBurstMs) {
				g_burstStart = now;
				g_burstCount = 0;
			}
			if (++g_burstCount > kBurstLimit) {
				if (g_burstCount == kBurstLimit + 1)
					logger::warn("cursor-keeper: {} closed {} times in {} s - not reopening it again until that stops",
						what, g_burstCount, kBurstMs / 1000);
				return false;
			}
			return true;
		}

		void Reopen(const char* how)
		{
			const std::int64_t now = OpenDiag::NowMs();
			if (!BurstAllows("the focus menu"))
				return;
			const auto name = FocusMenuName();
			logger::warn("cursor-keeper: PrismaUI's focus menu (the cursor) closed while the deck still holds the keyboard - reopened it ({}). Menus in the last 3 s: {}",  // marker: cursor-keeper
				how, Recent(now));
			if (const auto q = RE::UIMessageQueue::GetSingleton())
				q->AddMessage(std::string_view{ name }, RE::UI_MESSAGE_TYPE::kShow, nullptr);
		}

		class Sink final : public RE::BSTEventSink<RE::MenuOpenCloseEvent>
		{
		public:
			static Sink* Get()
			{
				static Sink s;
				return &s;
			}

			RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* a_event,
				RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override
			{
				if (!a_event)
					return RE::BSEventNotifyControl::kContinue;
				const std::string  name(a_event->menuName.c_str());
				const std::int64_t now = OpenDiag::NowMs();
				g_recent[g_recentNext] = { name, a_event->opening, now };
				g_recentNext = (g_recentNext + 1) % g_recent.size();

				if (a_event->opening)
					return RE::BSEventNotifyControl::kContinue;
				if (name == kCursorMenu) {
					// PrismaUI's own hook refuses this menu's hide while any of its views
					// has focus, so a close that lands while we hold the keyboard means
					// that answer was wrong for a moment (it is an Ultralight-thread
					// round trip). Put the cursor back; the line says what moved first.
					if (g_paletteOpen && g_paletteOpen() && !LoadingScreenUp() && g_holdsKeyboard && g_holdsKeyboard())
						EnsureCursorMenu("close event");
					return RE::BSEventNotifyControl::kContinue;
				}
				if (name != FocusMenuName())
					return RE::BSEventNotifyControl::kContinue;
				if (!g_paletteOpen || !g_paletteOpen() || LoadingScreenUp())
					return RE::BSEventNotifyControl::kContinue;
				if (g_holdsKeyboard && g_holdsKeyboard())
					Reopen("close event");
				else
					logger::info("cursor-keeper: the focus menu closed while a palette is open but another view holds the keyboard - left to the desync watchdog. Menus in the last 3 s: {}",
						Recent(now));
				return RE::BSEventNotifyControl::kContinue;
			}
		};
	}

	void Install(std::function<bool()> paletteOpen, std::function<bool()> holdsKeyboard)
	{
		static bool s_installed = false;
		g_paletteOpen   = std::move(paletteOpen);
		g_holdsKeyboard = std::move(holdsKeyboard);
		if (s_installed)
			return;
		const auto ui = RE::UI::GetSingleton();
		if (!ui) {
			logger::warn("cursor-keeper: no UI singleton - not installed");
			return;
		}
		ui->AddEventSink<RE::MenuOpenCloseEvent>(Sink::Get());
		s_installed = true;
		logger::info("cursor-keeper: watching PrismaUI's focus menu under the open deck");
	}

	void Tick()
	{
		// Two ticks in a row: PrismaUI opens its menu a task after Focus(), so
		// one tick can land between the two on a fresh open.
		static int s_missing = 0;
		static int s_cursorMissing = 0;
		const auto ui = RE::UI::GetSingleton();
		if (!ui || !g_paletteOpen || !g_paletteOpen() || LoadingScreenUp()) {
			s_missing = 0;
			s_cursorMissing = 0;
			return;
		}
		if (ui->IsMenuOpen(FocusMenuName())) {
			s_missing = 0;
			// The focus menu is up; the engine's Cursor Menu should be too (the
			// engine opens it for any kUsesCursor menu, and PrismaUI holds it open).
			if (ui->IsMenuOpen(kCursorMenu)) {
				s_cursorMissing = 0;
			} else if (++s_cursorMissing >= 2) {
				s_cursorMissing = 0;
				if (g_holdsKeyboard && g_holdsKeyboard())
					EnsureCursorMenu("1 s check");
			}
			return;
		}
		s_cursorMissing = 0;
		if (++s_missing < 2)
			return;
		s_missing = 0;
		if (g_holdsKeyboard && g_holdsKeyboard())
			Reopen("1 s check");
	}

	bool EnsureCursorMenu(const char* how)
	{
		const auto ui = RE::UI::GetSingleton();
		const auto mc = RE::MenuCursor::GetSingleton();
		if (!ui || !mc)
			return false;
		if (ui->IsMenuOpen(kCursorMenu))
			return false;
		if (!ui->IsMenuOpen(FocusMenuName()))
			return false;   // no focus menu either: that is Reopen()'s case, not this one
		const std::int64_t now = OpenDiag::NowMs();
		const int          count = mc->GetRuntimeData().showCursorCount;
		if (count < 1) {
			// The engine itself thinks the cursor is hidden although a kUsesCursor
			// menu of ours is open: a count somebody left unbalanced. A bare show
			// would be hidden again by the next balanced hide and leave the count
			// negative for the next game menu, so only say it.
			logger::warn("cursor-menu-keeper: the engine's Cursor Menu is closed under the focused deck and its showCursorCount is {} ({}) - not reopening, the count is wrong. Menus in the last 3 s: {}",
				count, how, Recent(now));
			return false;
		}
		if (!BurstAllows("the engine's Cursor Menu"))
			return false;
		logger::warn("cursor-menu-keeper: the engine's Cursor Menu (what moves the cursor) was closed while the deck still holds the keyboard - reopened it ({}, showCursorCount {}). Menus in the last 3 s: {}",  // marker: cursor-menu-keeper
			how, count, Recent(now));
		if (const auto q = RE::UIMessageQueue::GetSingleton())
			q->AddMessage(kCursorMenu, RE::UI_MESSAGE_TYPE::kShow, nullptr);
		return true;
	}

	std::string RecentMenus(std::int64_t windowMs)
	{
		return Recent(OpenDiag::NowMs(), windowMs);
	}
}
