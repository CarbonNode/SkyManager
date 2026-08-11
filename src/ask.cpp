#include "ask.h"

#include <atomic>
#include <mutex>
#include <thread>
#include <vector>

#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

namespace Ask
{
	namespace
	{
		/* Same discovery order as the Sharmat bridge, same reasoning: WSL2's
		   localhost forwarding survives distro-IP reassignment; the hard-coded
		   distro IP is the fallback. Kept as OWN state — see ask.h. */
		/* Localhost only. WSL2 projects the distro's listening ports onto the
		   Windows loopback, so this is the address that works on ANY machine —
		   and it is the only one we can know. A second entry used to hardcode
		   one developer's distro IP: useless to everyone else, and it shipped
		   that IP inside the DLL. Someone whose localhost forwarding is off
		   sets HOTKEYDECK_CHIM_BASE instead (read below). */
		const std::vector<std::string> kDefaultBases = {
			"http://127.0.0.1:8081",
		};
		constexpr auto  kPath = L"/HerikaServer/ext/deck_ask/ask.php";
		constexpr DWORD kMaxReply = 1u * 1024u * 1024u;

		std::mutex               g_mut;
		std::string              g_pinned;  // last base that answered
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

		struct Parsed
		{
			std::wstring  host;
			INTERNET_PORT port = 80;
			bool          ok = false;
		};

		Parsed SplitBase(const std::string& base)
		{
			Parsed      p;
			std::string rest = base;
			const auto  scheme = rest.find("://");
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
					return p;
				}
			}
			if (hostPart.empty())
				return p;
			p.host = Widen(hostPart);
			p.ok = true;
			return p;
		}

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

		HttpResult DoOne(const std::string& base, const std::string& query, int timeoutMs)
		{
			HttpResult   r;
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
			/* Connect stays SHORT even for LLM asks — an unreachable base must
			   fail over to the next candidate in seconds, not after the full
			   think budget. Only the receive phase gets the long leash. */
			WinHttpSetTimeouts(session.h, 5000, 5000, timeoutMs, timeoutMs);

			const Handle conn(WinHttpConnect(session.h, p.host.c_str(), p.port, 0));
			if (!conn) {
				r.error = "connect failed (" + std::to_string(GetLastError()) + ")";
				return r;
			}

			const std::wstring target = std::wstring(kPath) + L"?" + Widen(query);
			const Handle       req(WinHttpOpenRequest(conn.h, L"GET", target.c_str(),
				      nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
			if (!req) {
				r.error = "open request failed (" + std::to_string(GetLastError()) + ")";
				return r;
			}

			if (!WinHttpSendRequest(req.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
					WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
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
					logger::warn("ask: reply exceeded {} bytes — truncated", kMaxReply);
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

	void Call(std::string id, std::string query, int timeoutMs, Reply done)
	{
		/* One think at a time is plenty; 2 leaves room for a structured ask
		   racing a slow LLM one. Beyond that the button is being mashed. */
		if (g_inFlight.load() >= 2) {
			done(EnvelopeError(id, "an ask is already in flight — give it a moment", false));
			return;
		}

		std::vector<std::string> bases;
		{
			std::scoped_lock lock(g_mut);
			if (!g_pinned.empty())
				bases.push_back(g_pinned);
			for (const auto& b : kDefaultBases)
				if (b != g_pinned)
					bases.push_back(b);
		}

		g_inFlight.fetch_add(1);
		std::thread([id = std::move(id), query = std::move(query), timeoutMs,
						bases = std::move(bases), done = std::move(done)]() {
			std::string envelope;
			std::string tried;

			for (const auto& base : bases) {
				const HttpResult r = DoOne(base, query, timeoutMs);
				if (!r.ok) {
					tried += (tried.empty() ? "" : "; ") + base + " -> " + r.error;
					continue;
				}
				nlohmann::json parsed;
				try {
					parsed = nlohmann::json::parse(r.body);
				} catch (const std::exception&) {
					tried += (tried.empty() ? "" : "; ") + base + " -> non-JSON reply";
					continue;
				}
				{
					std::scoped_lock lock(g_mut);
					if (g_pinned != base)
						logger::info("ask: reached CHIM deck_ask at {}", base);
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
					g_pinned.clear();
				}
				envelope = EnvelopeError(id,
					"CHIM did not answer the ask — is the server up, and is deck_ask installed? (" + tried + ")",
					true);
			}

			g_inFlight.fetch_sub(1);

			/* Back to the main thread before touching the view — same contract
			   as the Sharmat bridge. */
			SKSE::GetTaskInterface()->AddTask([done, envelope]() { done(envelope); });
		}).detach();
	}
}
