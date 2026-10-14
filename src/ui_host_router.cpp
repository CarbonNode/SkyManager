#include "ui_host_router.h"

#include "pch.h"

#include "MagelightUI_API.h"
#include "open_diag.h"

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
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

namespace UiHostRouter
{
	namespace
	{
		namespace ML = MAGELIGHT_API;
		using PRISMA_UI_API::IVPrismaUI1;

		// Tag carried by every handle that lives on Magelight. The tag alone does NOT
		// identify one: Prisma UI's handles are full 64-bit values (the HUD view's was
		// 0xe034171aa0a2e99f on 2026-10-10, bit 62 set), and testing the bit sent every
		// HUD and Hotbar call to Magelight, where it failed (listeners "result 5",
		// Focus refused, the Stance Wheel slowed time and never drew). A handle is
		// Magelight's only when the router created it: IsMg looks it up in views_.
		constexpr std::uint64_t kTag = 1ull << 62;
		constexpr std::string_view kDeckHtml = "HotkeyDeck/index.html";
		constexpr std::uint32_t kMinHost = 3101;   // 0.31.1: cursor, freeze-world, escape capture, PostGameTask

		std::atomic<bool> g_deckOnMagelight{ false };
		std::mutex        g_statusMx;
		Status            g_status;

		void SetNote(std::string note)
		{
			std::lock_guard l(g_statusMx);
			g_status.note = std::move(note);
		}

		// ---------------------------------------------------------------- worker --
		// One ordered thread that runs page->C++ calls and DOM-ready callbacks, the
		// way Prisma UI's own UI thread did. Jobs are copies: Magelight's argument
		// pointers are valid only during its callback.
		class Worker
		{
		public:
			void Post(std::function<void()> job)
			{
				{
					std::lock_guard l(mx_);
					q_.push_back(std::move(job));
					if (!started_) {
						started_ = true;
						std::thread([this]() { Run(); }).detach();
					}
				}
				cv_.notify_one();
			}

		private:
			void Run()
			{
				for (;;) {
					std::function<void()> job;
					{
						std::unique_lock l(mx_);
						cv_.wait(l, [this]() { return !q_.empty(); });
						job = std::move(q_.front());
						q_.pop_front();
					}
					try {
						job();
					} catch (const std::exception& e) {
						logger::error("ui-host: a page call threw: {}", e.what());
					} catch (...) {
						logger::error("ui-host: a page call threw a non-standard exception");
					}
				}
			}

			std::mutex                         mx_;
			std::condition_variable            cv_;
			std::deque<std::function<void()>>  q_;
			bool                               started_ = false;
		};

		Worker& Jobs()
		{
			static Worker w;
			return w;
		}

		std::string Utf8(const std::filesystem::path& p)
		{
			const auto u = p.u8string();
			return std::string(reinterpret_cast<const char*>(u.data()), u.size());
		}

		// <game dir>\Data\PrismaUI\views\<rel>, absolute, backslashes. Under MO2 the
		// file is in a mod folder and reaches Data through the VFS, which hooks this
		// process's file reads for Magelight exactly as it does for Prisma UI.
		std::string PrismaViewAbsPath(std::string_view rel)
		{
			wchar_t buf[MAX_PATH * 2]{};
			const DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
			std::filesystem::path exe(std::wstring(buf, n));
			auto p = exe.parent_path() / "Data" / "PrismaUI" / "views";
			std::string r(rel);
			for (auto& c : r)
				if (c == '/')
					c = '\\';
			p /= std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(r.data()), r.size()));
			return Utf8(p);
		}

		struct MgView
		{
			ML::ViewId                                 real = 0;
			PRISMA_UI_API::OnDomReadyCallback          onDomReady = nullptr;
			int                                        scroll = 40;
			bool                                       visible = false;
			std::vector<std::string>                   listeners;   // names bridged into the page
		};

		// Prisma UI exposes each C++ listener to the page as a global function,
		// window[name](string); the deck calls them that way (toGame). Magelight's
		// pages reach C++ through window.magelight.send(name, arg) instead, so the
		// router defines the same globals in the page. Calls queued before DOM ready
		// land after it, ahead of the deck's own DOM-ready work (the same order as
		// Prisma UI binding its listeners at load).
		std::string ListenerShim(const std::string& name)
		{
			std::string q;   // names are C++ literals; escape anyway
			for (const char c : name) {
				if (c == '\\' || c == '"')
					q += '\\';
				q += c;
			}
			return "(function(n){window[n]=function(a){try{window.magelight.send(n,"
			       "a===undefined||a===null?'':String(a));}catch(e){}};})(\"" + q + "\");";
		}

		class Router final : public IVPrismaUI1
		{
		public:
			Router(IVPrismaUI1* prisma, const ML::MagelightApi4* api, bool freezeWorld) :
				prisma_(prisma), api_(api), freezeWorld_(freezeWorld) {}

			// ------------------------------------------------ creation / life --
			PrismaView CreateView(const char* htmlPath, PRISMA_UI_API::OnDomReadyCallback cb) noexcept override
			{
				if (!htmlPath || std::string_view(htmlPath) != kDeckHtml) {
					const PrismaView pv = prisma_->CreateView(htmlPath, cb);
					if (IsMg(pv))
						logger::error("ui-host: Prisma UI view {} has the same handle as a Magelight view - its calls will misroute", htmlPath);
					return pv;
				}
				if (!EnsureMod())
					return Fallback(htmlPath, cb, "Magelight refused the mod registration");

				const std::string abs = PrismaViewAbsPath(htmlPath);
				ML::ViewDesc d{};
				d.size = sizeof(d);
				d.name = "deck";
				d.htmlPath = abs.c_str();
				d.anchor = ML::Anchor::TopLeft;
				d.fullscreen = true;
				d.clickThrough = false;
				d.startVisible = false;
				d.layer = ML::Layer::Panel;
				d.uiScale = 0.0f;
				d.onDomReady = &Router::DomReadyThunk;
				ML::ViewId id = 0;
				const auto r = api_->CreateViewEx(mod_, &d, &id);
				if (r != ML::Result::Ok || !id)
					return Fallback(htmlPath, cb, LastError(r).c_str());

				const PrismaView tagged = id | kTag;
				{
					std::lock_guard l(mx_);
					MgView v;
					v.real = id;
					v.onDomReady = cb;
					views_[tagged] = v;
				}
				// The deck closes itself on Escape (its own JS -> ClosePalette); left to
				// the host, Escape would drop UI mode under an open deck.
				api_->SetEscapeCapture(id, true);
				if (freezeWorld_ && api_->QueryCapability("freezeWorld") == 1) {
					const auto fr = api_->SetViewFreezeWorld(id, true);
					logger::info("ui-host: freeze-world behind the paused deck {}", fr == ML::Result::Ok ? "on" : "refused");
				}
				g_deckOnMagelight = true;
				logger::info("ui-host: deck view on Magelight {} (view {}, page {})",   // marker: ui-host-router
					api_->hostVersion ? api_->hostVersion : "?", id, abs);
				return tagged;
			}

			bool IsValid(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->IsValid(view);
				return api_->IsViewValid(Real(view));
			}

			void Destroy(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Destroy(view);
				api_->DestroyView(Real(view));
				std::lock_guard l(mx_);
				views_.erase(view);
			}

			// ---------------------------------------------------- C++ -> page --
			void Invoke(PrismaView view, const char* script, PRISMA_UI_API::JSCallback cb) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Invoke(view, script, cb);
				if (!script)
					return;
				if (cb)
					api_->EvalJS(Real(view), script, &Router::EvalThunk, reinterpret_cast<void*>(cb));
				else
					api_->InvokeJS(Real(view), script);
			}

			void InteropCall(PrismaView view, const char* fn, const char* arg) noexcept override
			{
				if (!IsMg(view))
					return prisma_->InteropCall(view, fn, arg);
				api_->InteropCall(Real(view), fn, arg);
			}

			// ---------------------------------------------------- page -> C++ --
			void RegisterJSListener(PrismaView view, const char* name, PRISMA_UI_API::JSListenerCallback cb) noexcept override
			{
				if (!IsMg(view))
					return prisma_->RegisterJSListener(view, name, cb);
				if (!name || !*name)
					return;
				const auto r = api_->RegisterJSListenerEx(Real(view), name, &Router::ListenerThunk, reinterpret_cast<void*>(cb));
				if (r != ML::Result::Ok) {
					logger::warn("ui-host: listener '{}' refused: {}", name, LastError(r));
					return;
				}
				{
					std::lock_guard l(mx_);
					if (const auto it = views_.find(view); it != views_.end())
						it->second.listeners.emplace_back(name);
				}
				api_->InvokeJS(Real(view), ListenerShim(name).c_str());
			}

			// ---------------------------------------------- focus / visibility --
			bool Focus(PrismaView view, bool pauseGame, bool disableFocusMenu) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Focus(view, pauseGame, disableFocusMenu);
				const auto real = Real(view);
				const auto r = api_->RequestUIMode(real, pauseGame ? ML::kUIModeFlagPause : ML::kUIModeFlagNone);
				if (r != ML::Result::Ok) {
					logger::warn("ui-host: UI mode refused for the deck: {}", LastError(r));
					return false;
				}
				pending_ = real;
				SetVisible(view, true);   // UI-mode entry shows the view
				return true;
			}

			void Unfocus(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Unfocus(view);
				const auto real = Real(view);
				if (active_.load() == real || pending_.load() == real)
					api_->ReleaseUIMode(mod_);
				// Report "not focused" at once; the host's UIModeExited confirms later.
				if (active_.load() == real)
					active_ = 0;
				if (pending_.load() == real)
					pending_ = 0;
			}

			bool HasFocus(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->HasFocus(view);
				const auto real = Real(view);
				return active_.load() == real || pending_.load() == real;
			}

			bool HasAnyActiveFocus() noexcept override
			{
				return prisma_->HasAnyActiveFocus() || (api_->IsUIModeActive && api_->IsUIModeActive());
			}

			void Show(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Show(view);
				api_->ShowView(Real(view), true);
				SetVisible(view, true);
			}

			void Hide(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->Hide(view);
				api_->ShowView(Real(view), false);
				SetVisible(view, false);
			}

			bool IsHidden(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->IsHidden(view);
				ML::ViewDesc d{};
				d.size = sizeof(d);
				if (api_->GetViewInfo(Real(view), &d) == ML::Result::Ok)
					return !d.startVisible;   // startVisible = current visibility (header contract)
				std::lock_guard l(mx_);
				const auto it = views_.find(view);
				return it == views_.end() || !it->second.visible;
			}

			// --------------------------------------------------------- misc --
			int GetScrollingPixelSize(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->GetScrollingPixelSize(view);
				std::lock_guard l(mx_);
				const auto it = views_.find(view);
				return it == views_.end() ? 40 : it->second.scroll;
			}

			void SetScrollingPixelSize(PrismaView view, int px) noexcept override
			{
				if (!IsMg(view))
					return prisma_->SetScrollingPixelSize(view, px);
				api_->SetScrollStep(Real(view), px);
				std::lock_guard l(mx_);
				if (const auto it = views_.find(view); it != views_.end())
					it->second.scroll = px;
			}

			void SetOrder(PrismaView view, int order) noexcept override
			{
				if (!IsMg(view))
					return prisma_->SetOrder(view, order);
				api_->SetViewOrder(Real(view), static_cast<std::uint64_t>(order < 0 ? 0 : order));
			}

			int GetOrder(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->GetOrder(view);
				std::uint64_t o = 0;
				api_->GetViewOrder(Real(view), &o);
				return static_cast<int>(o);
			}

			void CreateInspectorView(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					prisma_->CreateInspectorView(view);
			}

			void SetInspectorVisibility(PrismaView view, bool visible) noexcept override
			{
				if (!IsMg(view))
					return prisma_->SetInspectorVisibility(view, visible);
				api_->ShowInspector(Real(view), visible);
			}

			bool IsInspectorVisible(PrismaView view) noexcept override
			{
				if (!IsMg(view))
					return prisma_->IsInspectorVisible(view);
				bool v = false;
				api_->IsInspectorVisible(Real(view), &v);
				return v;
			}

			void SetInspectorBounds(PrismaView view, float x, float y, unsigned int w, unsigned int h) noexcept override
			{
				if (!IsMg(view))
					prisma_->SetInspectorBounds(view, x, y, w, h);
			}

		private:
			// marker: ui-host-route-by-registry (the CreateView collision log line)
			bool IsMg(PrismaView v)
			{
				if ((v & kTag) == 0)
					return false;
				std::lock_guard l(mx_);
				return views_.find(v) != views_.end();
			}
			static ML::ViewId Real(PrismaView v) { return v & ~kTag; }

			std::string LastError(ML::Result r) const
			{
				std::string why = "result " + std::to_string(static_cast<int>(r));
				if (mod_ && api_->GetLastErrorMessage) {
					if (const char* m = api_->GetLastErrorMessage(mod_); m && *m)
						why += std::string(" (") + m + ")";
				}
				return why;
			}

			PrismaView Fallback(const char* htmlPath, PRISMA_UI_API::OnDomReadyCallback cb, const char* why)
			{
				logger::warn("ui-host: deck stays on Prisma UI - {}", why ? why : "unknown");
				SetNote(std::string("Magelight refused the deck, so it stayed on PrismaUI: ") + (why ? why : "unknown"));
				return prisma_->CreateView(htmlPath, cb);
			}

			bool EnsureMod()
			{
				if (mod_)
					return true;
				ML::ModDesc d{};
				d.size = sizeof(d);
				d.modId = "SkyManager";
				d.displayName = "SkyManager";
				d.modVersion = 0;
				d.minHostVersion = kMinHost;
				d.callbackThread = ML::CallbackThread::GameThread;
				d.onEvent = &Router::EventThunk;
				d.onLog = &Router::LogThunk;
				d.user = this;
				d.sessionName = nullptr;   // own storage jar
				ML::ModId id = 0;
				const auto r = api_->RegisterMod(&d, &id);
				if (r != ML::Result::Ok || !id) {
					logger::warn("ui-host: Magelight RegisterMod failed (result {})", static_cast<int>(r));
					return false;
				}
				mod_ = id;
				return true;
			}

			void SetVisible(PrismaView view, bool on)
			{
				std::lock_guard l(mx_);
				if (const auto it = views_.find(view); it != views_.end())
					it->second.visible = on;
			}

			// Find a tagged handle by Magelight's id.
			bool Lookup(ML::ViewId real, PrismaView& tagged, MgView& out)
			{
				std::lock_guard l(mx_);
				const auto it = views_.find(real | kTag);
				if (it == views_.end())
					return false;
				tagged = it->first;
				out = it->second;
				return true;
			}

			void Rebridge(ML::ViewId real)
			{
				std::vector<std::string> names;
				{
					std::lock_guard l(mx_);
					if (const auto it = views_.find(real | kTag); it != views_.end())
						names = it->second.listeners;
				}
				std::string js;
				for (const auto& n : names)
					js += ListenerShim(n);
				if (!js.empty())
					api_->InvokeJS(real, js.c_str());
			}

			// ---------------------------------------------------- host callbacks --
			static void DomReadyThunk(ML::ViewId real)
			{
				auto* self = g_self;
				if (!self)
					return;
				PrismaView tagged = 0;
				MgView v;
				if (!self->Lookup(real, tagged, v) || !v.onDomReady)
					return;
				const auto cb = v.onDomReady;
				Jobs().Post([cb, tagged]() { cb(tagged); });
			}

			static void ListenerThunk(ML::ViewId, const char* argument, void* user)
			{
				const auto cb = reinterpret_cast<PRISMA_UI_API::JSListenerCallback>(user);
				if (!cb)
					return;
				std::string arg = argument ? argument : "";
				Jobs().Post([cb, arg = std::move(arg)]() { cb(arg.c_str()); });
			}

			static void EvalThunk(ML::ViewId, const char* result, const char*, void* user)
			{
				const auto cb = reinterpret_cast<PRISMA_UI_API::JSCallback>(user);
				if (!cb)
					return;
				std::string res = result ? result : "";
				Jobs().Post([cb, res = std::move(res)]() { cb(res.c_str()); });
			}

			static void EventThunk(const ML::EventData* ev, void* user)
			{
				auto* self = static_cast<Router*>(user);
				if (!ev || !self)
					return;
				switch (ev->type) {
				case ML::Event::UIModeEntered:
					self->active_ = ev->view;
					if (self->pending_.load() == ev->view)
						self->pending_ = 0;
					break;
				case ML::Event::UIModeExited:
					if (self->active_.load() == ev->view)
						self->active_ = 0;
					break;
				case ML::Event::UIModeRefused:
					self->pending_ = 0;
					logger::warn("ui-host: UI mode refused: {}", ev->detail ? ev->detail : "");
					break;
				case ML::Event::ViewReloaded:
					// A reload wipes the page's globals: bridge every listener again.
					self->Rebridge(ev->view);
					break;
				case ML::Event::ViewLoadFailed:
					logger::error("ui-host: deck page failed to load: {}", ev->detail ? ev->detail : "");
					break;
				case ML::Event::RenderDead:
					logger::error("ui-host: Magelight disabled its renderer for this session - "
					              "set MagelightDeck=0 in SkyManager.ini to put the deck back on Prisma UI");
					break;
				default:
					break;
				}
			}

			static void LogThunk(int level, const char* message, void*)
			{
				if (!message)
					return;
				if (level >= 2)
					logger::error("ui-host (Magelight): {}", message);
				else if (level == 1)
					logger::warn("ui-host (Magelight): {}", message);
				else
					logger::info("ui-host (Magelight): {}", message);
			}

			IVPrismaUI1*                              prisma_;
			const ML::MagelightApi4*                  api_;
			bool                                      freezeWorld_;
			ML::ModId                                 mod_ = 0;
			std::mutex                                mx_;
			std::unordered_map<PrismaView, MgView>    views_;
			std::atomic<ML::ViewId>                   active_{ 0 };
			std::atomic<ML::ViewId>                   pending_{ 0 };

		public:
			static inline Router* g_self = nullptr;
		};
	}

	PRISMA_UI_API::IVPrismaUI1* Wrap(PRISMA_UI_API::IVPrismaUI1* prisma, bool wantMagelight,
		const std::string& source)
	{
		// Probe first, whatever was chosen: Settings says whether Magelight is there.
		const auto* api = ML::RequestApi4();
		{
			std::lock_guard l(g_statusMx);
			g_status.magelightFound = api != nullptr;
			g_status.magelightVersion = api && api->hostVersion ? api->hostVersion : "";
			g_status.magelightUsable = api && api->hostVersionNumber >= kMinHost;
			g_status.note.clear();
		}
		if (!prisma || !wantMagelight)
			return prisma;   // the default: everything on Prisma UI
		if (!api) {
			logger::warn("ui-host: {} asks for Magelight but Magelight.dll is not loaded - the deck stays on Prisma UI", source);
			SetNote("Magelight UI is not installed or not enabled, so the deck is on PrismaUI.");
			return prisma;
		}
		if (api->hostVersionNumber < kMinHost) {
			logger::warn("ui-host: Magelight {} is older than 0.31.1 - the deck stays on Prisma UI",
				api->hostVersion ? api->hostVersion : "?");
			SetNote("Magelight UI is too old (needs 0.31.1 or newer), so the deck is on PrismaUI.");
			return prisma;
		}
		const bool freeze = OpenDiag::IniBool("MagelightFreezeWorld", false);
		static Router router(prisma, api, freeze);
		Router::g_self = &router;
		logger::info("ui-host: router armed - the main deck will be created on Magelight {} (freeze-world {})",
			api->hostVersion ? api->hostVersion : "?", freeze ? "requested" : "off");
		logger::info("ui-host: chosen by {}", source);
		return &router;
	}

	Status GetStatus()
	{
		std::lock_guard l(g_statusMx);
		return g_status;
	}

	bool DeckOnMagelight()
	{
		return g_deckOnMagelight.load();
	}
}
