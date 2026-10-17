#include "freeze_backdrop.h"

#include "pch.h"

#include "open_diag.h"

#include <Windows.h>
// <Windows.h> brings object-like macros that rename CommonLib members
// (GetObject -> GetObjectA) and break std::min/max. Nothing here wants them.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

#include <atomic>
#include <cstdio>
#include <string>

namespace FreezeBackdrop
{
	namespace
	{
		using Flag = RE::UI_MENU_FLAGS;

		constexpr std::string_view kMenuName = "SkyManager Backdrop";

		std::atomic<bool>          g_installed{ false };
		std::atomic<bool>          g_enabled{ false };   // off unless SkyManager.ini opts in: it hung the game (2026-10-09)
		std::atomic<std::uint32_t> g_want{ 0 };
		std::atomic<bool>          g_shown{ false };   // a kShow is queued or the menu is open

		// PrismaUI's focus menu (it draws the cursor). Learned at runtime from the
		// first menu whose code lives in PrismaUI.dll; PrismaUI does not publish
		// the name. Main thread only.
		std::string g_focusName;
		bool        g_addedSkip = false;   // we set its skip-screenshot bit
		bool        g_loggedFocus = false;
		bool        g_loggedInventory = false;

		std::string Hex(std::uint32_t v)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%08X", v);
			return buf;
		}

		// The menu without a movie: nothing to advance, nothing to draw. The engine
		// only reads its flags. kCustomRendering is what lets a movie-less menu
		// sit on the stack (the DetailedMiniMap LocalMenu precedent); no input
		// context and no cursor — PrismaUI's focus menu owns both.
		// backdrop-inventory-recipe (2026-10-14). The vanilla InventoryMenu's flags on
		// this rig are 0x0000A4C5 (logged below): kCustomRendering + kPausesGame +
		// cursor/item bits, and NO kFreezeFrameBackground. With it open the engine
		// ran at 66 fps real on 7 ms of game thread (Upscaler FPS_PROFILE, 13:53),
		// against 15-40 with the world drawn behind the deck. The first try
		// (kFreezeFrameBackground + kCustomRendering) hung the main thread on its
		// first open, so the default is now the inventory's own pair, and
		// SkyManager.ini can try others without a rebuild:
		//     BackdropFlags = 0x8001   ; any UI_MENU_FLAGS value, read at every show
		//     BackdropMovie = 1        ; carry an invisible cursormenu movie
		constexpr std::uint32_t kInventoryRecipe =
			static_cast<std::uint32_t>(Flag::kCustomRendering) | static_cast<std::uint32_t>(Flag::kPausesGame);

		std::uint32_t IniFlags()
		{
			const auto raw = OpenDiag::IniString("BackdropFlags", "");
			if (raw.empty())
				return kInventoryRecipe;
			try {
				return static_cast<std::uint32_t>(std::stoul(raw, nullptr, 0));
			} catch (...) {
				logger::warn("freeze-backdrop: BackdropFlags \"{}\" is not a number - using the inventory recipe", raw);
				return kInventoryRecipe;
			}
		}

		std::atomic<std::uint32_t> g_lastFlags{ 0 };

		class BackdropMenu final : public RE::IMenu
		{
		public:
			BackdropMenu()
			{
				const std::uint32_t flags = IniFlags();
				menuFlags.set(static_cast<Flag>(flags));
				g_lastFlags = flags;
				depthPriority = 0;   // under everything, the focus menu's cursor included
				inputContext  = Context::kNone;
				if (OpenDiag::IniBool("BackdropMovie", false)) {
					const auto sf = RE::BSScaleformManager::GetSingleton();
					if (sf && sf->LoadMovieEx(this, "cursormenu", [](RE::GFxMovieDef*) {}) && uiMovie)
						uiMovie->SetVisible(false);
					else
						logger::warn("freeze-backdrop: BackdropMovie=1 but cursormenu did not load - movie-less");
				}
			}
			static RE::IMenu* Create() { return new BackdropMenu(); }
			void AdvanceMovie(float, std::uint32_t) override {}
			void PostDisplay() override {}
		};

		bool InPrismaUi(const RE::IMenu* a_menu)
		{
			static std::uintptr_t lo = 0, hi = 0;
			static bool           probed = false;
			if (!probed) {
				probed = true;
				if (const auto mod = GetModuleHandleW(L"PrismaUI.dll")) {
					const auto base = reinterpret_cast<const std::uint8_t*>(mod);
					const auto dos  = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
					const auto nt   = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
					lo = reinterpret_cast<std::uintptr_t>(mod);
					hi = lo + nt->OptionalHeader.SizeOfImage;
				}
			}
			if (!a_menu || !lo)
				return false;
			const auto vtable = *reinterpret_cast<const std::uintptr_t*>(a_menu);
			return vtable >= lo && vtable < hi;
		}

		RE::GPtr<RE::IMenu> FocusMenu()
		{
			const auto ui = RE::UI::GetSingleton();
			if (!ui || g_focusName.empty() || !ui->IsMenuOpen(g_focusName))
				return {};
			return ui->GetMenu(g_focusName);
		}

		void ApplyFocusSkip()
		{
			const auto m = FocusMenu();
			if (!m || g_addedSkip || m->SkipRenderDuringFreezeFrameScreenshot())
				return;
			m->menuFlags.set(Flag::kSkipRenderDuringFreezeFrameScreenshot);
			g_addedSkip = true;
		}

		void ClearFocusSkip()
		{
			if (!g_addedSkip)
				return;
			g_addedSkip = false;
			if (const auto m = FocusMenu())
				m->menuFlags.reset(Flag::kSkipRenderDuringFreezeFrameScreenshot);
		}

		// The setting, with SkyManager.ini's FreezeBackdrop re-read live so a test
		// can switch it while the game runs (an edited ini is visible through
		// MO2's VFS at once).
		bool EffectiveEnabled()
		{
			return OpenDiag::IniBool("FreezeBackdrop", g_enabled.load());
		}

		bool WantsFreezeFrame()
		{
			return (g_lastFlags.load() & static_cast<std::uint32_t>(Flag::kFreezeFrameBackground)) != 0;
		}

		void Queue(RE::UI_MESSAGE_TYPE a_type)
		{
			if (const auto q = RE::UIMessageQueue::GetSingleton())
				q->AddMessage(kMenuName, a_type, nullptr);
		}

		void Sync(const char* why)
		{
			if (!g_installed.load())
				return;
			const bool should = g_want.load() != 0 && EffectiveEnabled();
			if (should) {
				if (!g_shown.exchange(true)) {
					Queue(RE::UI_MESSAGE_TYPE::kShow);
					logger::info("freeze-backdrop: world frozen behind the deck ({})", why);  // marker: freeze-backdrop
					logger::info("freeze-backdrop: backdrop flags 0x{:08X} (inventory recipe 0x{:08X}), movie {}",  // marker: backdrop-inventory-recipe
						IniFlags(), kInventoryRecipe, OpenDiag::IniBool("BackdropMovie", false));
				}
			} else if (g_shown.exchange(false)) {
				ClearFocusSkip();
				Queue(RE::UI_MESSAGE_TYPE::kHide);
				logger::info("freeze-backdrop: world drawn again ({})", why);
			} else {
				ClearFocusSkip();
			}
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
				const std::string_view name = a_event->menuName.c_str();
				if (name == kMenuName) {
					if (!a_event->opening)
						g_shown = false;   // closed by anyone (a load, a force-hide): ours to re-show
					else if (WantsFreezeFrame())
						ApplyFocusSkip();
					return RE::BSEventNotifyControl::kContinue;
				}
				const auto ui = RE::UI::GetSingleton();
				if (!ui)
					return RE::BSEventNotifyControl::kContinue;

				if (a_event->opening && !g_loggedInventory && name == RE::InventoryMenu::MENU_NAME) {
					// The reference this whole module copies: what the vanilla
					// inventory asks of the renderer. One line per session.
					g_loggedInventory = true;
					if (const auto inv = ui->GetMenu(name))
						logger::info("freeze-backdrop: InventoryMenu flags {} (freeze-frame {}, blur {})",
							Hex(inv->menuFlags.underlying()), inv->FreezeFrameBackground(), inv->UsesBlurredBackground());
				}

				if (a_event->opening) {
					const auto m = ui->GetMenu(name);
					if (m && InPrismaUi(m.get())) {
						if (g_focusName != name) {
							g_focusName = std::string(name);
							g_addedSkip = false;
						}
						if (!g_loggedFocus) {
							g_loggedFocus = true;
							logger::info("freeze-backdrop: PrismaUI focus menu is \"{}\", flags {}, depth {}",
								g_focusName, Hex(m->menuFlags.underlying()), static_cast<int>(m->depthPriority));
						}
						g_addedSkip = false;   // a fresh instance carries only its own flags
						if (g_shown.load() && WantsFreezeFrame())
							ApplyFocusSkip();
					}
				} else if (name == g_focusName) {
					g_addedSkip = false;   // that instance is gone
				}
				return RE::BSEventNotifyControl::kContinue;
			}
		};
	}

	void Install()
	{
		if (g_installed.exchange(true))
			return;
		const auto ui = RE::UI::GetSingleton();
		if (!ui) {
			g_installed = false;
			logger::warn("freeze-backdrop: no UI singleton - not installed, the world draws behind the deck as before");
			return;
		}
		ui->Register(kMenuName, BackdropMenu::Create);
		ui->AddEventSink<RE::MenuOpenCloseEvent>(Sink::Get());
		logger::info("freeze-backdrop: installed (menu \"{}\")", kMenuName);
	}

	void SetEnabled(bool on)
	{
		if (g_enabled.exchange(on) != on)
			Sync(on ? "setting on" : "setting off");
	}

	bool Enabled() { return EffectiveEnabled(); }

	void Want(Owner who, bool want)
	{
		if (want)
			g_want.fetch_or(who);
		else
			g_want.fetch_and(~static_cast<std::uint32_t>(who));
		Sync(who == kMagic ? "spell deck" : "deck");
	}

	void ReleaseAll(const char* why)
	{
		g_want = 0;
		Sync(why);
	}

	std::string PrismaFocusMenu() { return g_focusName; }

	void Tick(bool anyPaletteOpen)
	{
		if (!g_installed.load())
			return;
		if (!anyPaletteOpen && g_want.load() != 0) {
			g_want = 0;   // an owner closed without saying so — never strand a frozen world
			logger::warn("freeze-backdrop: still wanted with no palette open - releasing");
		}
		const auto ui = RE::UI::GetSingleton();
		const bool open = ui && ui->IsMenuOpen(kMenuName);
		const bool should = g_want.load() != 0 && EffectiveEnabled();
		if (!should && open) {
			g_shown = false;
			ClearFocusSkip();
			Queue(RE::UI_MESSAGE_TYPE::kHide);
			logger::warn("freeze-backdrop: open with nobody wanting it - hidden by the reconcile");
		} else if (should && !open) {
			g_shown = false;   // the queued show never landed; ask again
			Sync("reconcile");
		}
	}
}
