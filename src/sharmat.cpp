#include "sharmat.h"

#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

namespace Sharmat
{
	namespace
	{
		/* Where CHIM lives, in priority order.

		   `127.0.0.1:8081` first and deliberately: Apache inside the distro
		   binds 0.0.0.0:8081, and WSL2's localhost forwarding projects a
		   distro's listening ports onto the Windows loopback. That address
		   therefore survives the reboots that reassign the distro's own IP.
		   There is deliberately no second, hard-coded address: one developer's
		   distro IP is useless to every other player and shipped inside the
		   DLL. Override with HOTKEYDECK_CHIM_BASE where forwarding is off. */
		const std::vector<std::string> kDefaultBases = {
			"http://127.0.0.1:8081",
		};
		constexpr auto kPath = L"/HerikaServer/ext/aiagent_nsfw/config_manager.php";

		/* Short on purpose. CHIM being down is the COMMON case (it only runs
		   while Skyrim does, and the deck can be opened before it is up), so a
		   long timeout would leave the pane spinning for the normal outcome.
		   Six seconds is comfortably above a healthy round trip and still
		   under the patience of someone standing in a paused menu. */
		constexpr int kTimeoutMs = 6000;
		constexpr DWORD kMaxReply = 4u * 1024u * 1024u;

		std::mutex               g_mut;
		std::vector<std::string> g_bases = kDefaultBases;
		std::string              g_pinned;               // last base that answered
		std::atomic<bool>        g_down{ false };        // set once the plugin unloads
		std::atomic<int>         g_inFlight{ 0 };

		std::wstring Widen(const std::string& s)
		{
			if (s.empty())
				return {};
			const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
			std::wstring out(static_cast<std::size_t>(n), L'\0');
			MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n);
			return out;
		}

		std::string Narrow(const std::wstring& s)
		{
			if (s.empty())
				return {};
			const int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
			std::string out(static_cast<std::size_t>(n), '\0');
			WideCharToMultiByte(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr);
			return out;
		}

		struct Parsed
		{
			std::wstring host;
			INTERNET_PORT port = 80;
			bool          ok = false;
		};

		/* Only ever fed our own base strings, so this is a splitter rather than
		   a URL parser: scheme is always http, there is never a path or auth. */
		Parsed SplitBase(const std::string& base)
		{
			Parsed p;
			std::string rest = base;
			const auto scheme = rest.find("://");
			if (scheme != std::string::npos)
				rest = rest.substr(scheme + 3);
			while (!rest.empty() && rest.back() == '/')
				rest.pop_back();

			std::string hostPart = rest;
			const auto  colon = rest.rfind(':');
			if (colon != std::string::npos) {
				hostPart = rest.substr(0, colon);
				try {
					p.port = static_cast<INTERNET_PORT>(std::stoi(rest.substr(colon + 1)));
				} catch (const std::exception&) {
					return p;  // ok stays false
				}
			}
			if (hostPart.empty())
				return p;
			p.host = Widen(hostPart);
			p.ok = true;
			return p;
		}

		/* Every WinHTTP handle is owned by one of these, so the many early
		   returns below cannot leak one. */
		struct Handle
		{
			HINTERNET h = nullptr;
			explicit Handle(HINTERNET x = nullptr) :
				h(x) {}
			~Handle()
			{
				if (h)
					WinHttpCloseHandle(h);
			}
			Handle(const Handle&) = delete;
			Handle& operator=(const Handle&) = delete;
			explicit operator bool() const { return h != nullptr; }
		};

		struct HttpResult
		{
			bool        ok = false;
			DWORD       status = 0;
			std::string body;
			std::string error;
		};

		HttpResult DoOne(const std::string& base, const std::string& action,
			const std::string& query, const std::string& form)
		{
			HttpResult r;
			const Parsed p = SplitBase(base);
			if (!p.ok) {
				r.error = "malformed base url \"" + base + "\"";
				return r;
			}

			const Handle session(WinHttpOpen(L"HotkeyDeck/1.0",
				WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
			if (!session) {
				r.error = "WinHttpOpen failed (" + std::to_string(GetLastError()) + ")";
				return r;
			}
			WinHttpSetTimeouts(session.h, kTimeoutMs, kTimeoutMs, kTimeoutMs, kTimeoutMs);

			const Handle conn(WinHttpConnect(session.h, p.host.c_str(), p.port, 0));
			if (!conn) {
				r.error = "connect failed (" + std::to_string(GetLastError()) + ")";
				return r;
			}

			std::wstring target = std::wstring(kPath) + L"?action=" + Widen(action);
			if (!query.empty())
				target += L"&" + Widen(query);

			const bool   post = !form.empty();
			const Handle req(WinHttpOpenRequest(conn.h, post ? L"POST" : L"GET", target.c_str(),
				nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
			if (!req) {
				r.error = "open request failed (" + std::to_string(GetLastError()) + ")";
				return r;
			}

			const wchar_t* hdr = post ? L"Content-Type: application/x-www-form-urlencoded\r\n" : WINHTTP_NO_ADDITIONAL_HEADERS;
			BOOL sent = WinHttpSendRequest(req.h, hdr, post ? DWORD(-1L) : 0,
				post ? const_cast<char*>(form.data()) : WINHTTP_NO_REQUEST_DATA,
				post ? static_cast<DWORD>(form.size()) : 0,
				post ? static_cast<DWORD>(form.size()) : 0, 0);
			if (!sent) {
				const DWORD e = GetLastError();
				r.error = (e == ERROR_WINHTTP_CANNOT_CONNECT || e == ERROR_WINHTTP_TIMEOUT)
				            ? "no answer from " + base
				            : "send failed (" + std::to_string(e) + ")";
				return r;
			}
			if (!WinHttpReceiveResponse(req.h, nullptr)) {
				r.error = "no response from " + base + " (" + std::to_string(GetLastError()) + ")";
				return r;
			}

			DWORD status = 0, len = sizeof(status);
			WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
				WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
			r.status = status;

			std::string body;
			for (;;) {
				DWORD avail = 0;
				if (!WinHttpQueryDataAvailable(req.h, &avail) || avail == 0)
					break;
				const DWORD want = (body.size() + avail > kMaxReply)
				                     ? static_cast<DWORD>(kMaxReply - body.size())
				                     : avail;
				if (want == 0) {
					// A misconfigured CHIM answers with the whole 12k-line HTML
					// config page. Stop reading rather than grow the game's heap.
					logger::warn("sharmat: reply exceeded {} bytes — truncated", kMaxReply);
					break;
				}
				std::string chunk(want, '\0');
				DWORD       got = 0;
				if (!WinHttpReadData(req.h, chunk.data(), want, &got) || got == 0)
					break;
				chunk.resize(got);
				body += chunk;
			}

			r.body = std::move(body);
			r.ok = (status >= 200 && status < 300);
			if (!r.ok && r.error.empty())
				r.error = "HTTP " + std::to_string(status);
			return r;
		}

		std::string EnvelopeError(const std::string& id, const std::string& msg, bool chimDown)
		{
			nlohmann::json j;
			j["id"] = id;
			j["ok"] = false;
			j["error"] = msg;
			j["chimDown"] = chimDown;
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	void SetBaseUrl(const std::string& base)
	{
		std::scoped_lock lock(g_mut);
		g_pinned.clear();
		if (base.empty()) {
			g_bases = kDefaultBases;
		} else {
			std::string b = base;
			while (!b.empty() && b.back() == '/')
				b.pop_back();
			g_bases = { b };
		}
		logger::info("sharmat: base url set to {}", g_bases.front());
	}

	std::string BaseUrl()
	{
		std::scoped_lock lock(g_mut);
		return g_pinned.empty() ? (g_bases.empty() ? std::string{} : g_bases.front()) : g_pinned;
	}

	void Shutdown() { g_down.store(true); }

	void Call(std::string id, std::string action, std::string query, std::string form, Reply done)
	{
		if (g_down.load())
			return;

		/* A hard ceiling on concurrent workers. The view only ever has one
		   request outstanding, but a mashed button must not be able to spawn
		   an unbounded thread pile against a server that is already the
		   slowest thing in the system. */
		if (g_inFlight.load() >= 4) {
			done(EnvelopeError(id, "a Sharmat request is already in flight", false));
			return;
		}

		std::vector<std::string> bases;
		{
			std::scoped_lock lock(g_mut);
			if (!g_pinned.empty())
				bases.push_back(g_pinned);
			for (const auto& b : g_bases)
				if (b != g_pinned)
					bases.push_back(b);
		}

		g_inFlight.fetch_add(1);
		std::thread([id = std::move(id), action = std::move(action), query = std::move(query),
						form = std::move(form), bases = std::move(bases), done = std::move(done)]() {
			std::string envelope;
			std::string tried;

			for (const auto& base : bases) {
				if (g_down.load())
					break;
				const HttpResult r = DoOne(base, action, query, form);
				if (!r.ok) {
					tried += (tried.empty() ? "" : "; ") + base + " → " + r.error;
					continue;
				}
				// Answered 2xx. If it is not JSON it is a PHP fatal rendered as
				// HTML — report that as a failure rather than handing the view
				// something it will throw on.
				nlohmann::json parsed;
				try {
					parsed = nlohmann::json::parse(r.body);
				} catch (const std::exception&) {
					tried += (tried.empty() ? "" : "; ") + base + " → non-JSON reply";
					continue;
				}
				{
					std::scoped_lock lock(g_mut);
					// Log only on a CHANGE of winner, not per request: this fires
					// once when CHIM first answers (and again if we fail over to
					// the other candidate), which is exactly the line you want
					// when working out whether WSL2's localhost forwarding is
					// carrying the call or the distro IP had to be used.
					if (g_pinned != base)
						logger::info("sharmat: reached CHIM at {}", base);
					g_pinned = base;
				}
				nlohmann::json j;
				j["id"] = id;
				j["ok"] = true;
				j["status"] = r.status;
				j["json"] = std::move(parsed);
				envelope = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				break;
			}

			if (envelope.empty()) {
				{
					std::scoped_lock lock(g_mut);
					g_pinned.clear();  // re-probe every candidate next time
				}
				envelope = EnvelopeError(id,
					"CHIM did not answer — is the CHIM server up? (" + tried + ")", true);
			}

			g_inFlight.fetch_sub(1);
			if (g_down.load())
				return;

			/* Back to the main thread before touching the view. PrismaUI's
			   Invoke is not ours to call from a worker, and the reply lands
			   while the palette may already have closed — the task body
			   re-checks that through PushToView's own guards. */
			SKSE::GetTaskInterface()->AddTask([done, envelope]() { done(envelope); });
		}).detach();
	}
}
