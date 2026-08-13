#include "portal_host.h"

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")

// pch (force-included) provides RE::/SKSE::/json and the logger, and pulls in
// Windows.h — which is why the liveness probe below is WinHTTP and not a raw
// socket: <winsock2.h> after <windows.h> is a redefinition minefield, and
// ask.cpp already proved WinHTTP works here.

using json = nlohmann::json;

namespace PortalHost
{
	namespace
	{
		// marker: portal-host (DLL spawns the Deck Portal's node server)

		constexpr int kDefaultPort = 8090;

		std::mutex        g_mutex;
		HANDLE            g_job = nullptr;      // kills the child if the game dies
		HANDLE            g_child = nullptr;
		std::atomic<bool> g_ours{ false };      // we spawned it (vs adopted)
		std::string       g_reason;             // why it is not running, in player words
		bool              g_triedOnce = false;

		int Port()
		{
			// Env wins so a second instance / a port clash is fixable without a
			// rebuild — the same knob server.js reads.
			char  buf[16]{};
			DWORD n = GetEnvironmentVariableA("DECK_PORTAL_PORT", buf, sizeof(buf) - 1);
			if (n > 0 && n < sizeof(buf) - 1) {
				const int p = std::atoi(buf);
				if (p > 0 && p < 65536)
					return p;
			}
			return kDefaultPort;
		}

		std::string Url()
		{
			return "http://127.0.0.1:" + std::to_string(Port()) + "/";
		}

		// Narrow (UTF-8/ASCII) -> wide, the safe way. The old idiom here was
		// `std::wstring(s.begin(), s.end())`, an iterator-pair construct over a
		// char range — and a per-char widen of a temporary's iterators is exactly
		// the kind of string op that, if the narrow string is ever garbage or the
		// length is miscomputed, throws std::length_error("string too long").
		// That throw crashed the game on 2026-08-13 (the button ran on the SKSE
		// main-thread task with nothing catching it — crash-2026-08-13-01-45-35.log
		// shows the "string too long" length_error unwinding through SkyManager.dll
		// with our URL strings on the stack). MultiByteToWideChar sizes the buffer
		// exactly and never throws.
		std::wstring Widen(const std::string& s)
		{
			if (s.empty())
				return std::wstring();
			const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
				static_cast<int>(s.size()), nullptr, 0);
			if (n <= 0)
				return std::wstring();
			std::wstring out(static_cast<size_t>(n), L'\0');
			MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
				out.data(), n);
			return out;
		}

		bool FileExists(const std::wstring& p)
		{
			const DWORD a = GetFileAttributesW(p.c_str());
			return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
		}

		std::wstring EnvW(const wchar_t* name)
		{
			wchar_t buf[MAX_PATH]{};
			const DWORD n = GetEnvironmentVariableW(name, buf, MAX_PATH);
			return (n > 0 && n < MAX_PATH) ? std::wstring(buf, n) : std::wstring();
		}

		/* node.exe is NOT bundled; it is a documented
		 * requirement — so "absent" is a normal state for a fair number of
		 * users and must produce a sentence, never a dead button.
		 *
		 * PATH first (how a normal install is found), then the two places the
		 * official installer puts it, because a user who installed Node in the
		 * same session the game is already running has a stale PATH in this
		 * process and would otherwise be told to install what they just did. */
		std::wstring FindNode()
		{
			wchar_t found[MAX_PATH]{};
			if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr))
				return found;

			const std::wstring candidates[] = {
				EnvW(L"ProgramFiles") + L"\\nodejs\\node.exe",
				EnvW(L"ProgramW6432") + L"\\nodejs\\node.exe",
				EnvW(L"ProgramFiles(x86)") + L"\\nodejs\\node.exe",
				EnvW(L"LOCALAPPDATA") + L"\\Programs\\nodejs\\node.exe",
				EnvW(L"APPDATA") + L"\\npm\\node.exe",
			};
			for (const auto& c : candidates)
				if (c.size() > 12 && FileExists(c))
					return c;
			return {};
		}

		/* The portal's server.js.
		 *
		 * The shipped location is inside our own mod, beside the rest of the
		 * plugin's data. Developers can opt into another checkout explicitly with
		 * DECK_PORTAL_SERVER; no machine-specific path belongs in the build. */
		std::wstring FindServer()
		{
			const std::wstring fromEnv = EnvW(L"DECK_PORTAL_SERVER");
			if (!fromEnv.empty() && FileExists(fromEnv))
				return fromEnv;

			// Mod-folder paths only. A developer running the portal from a
			// checkout points DECK_PORTAL_SERVER at it (handled above) — an
			// absolute path from one machine has no business compiled into a
			// public build.
			const std::wstring candidates[] = {
				L"Data\\SKSE\\Plugins\\HotkeyDeck\\portal\\server.js",
				L"Data\\SKSE\\Plugins\\HotkeyDeck\\portal\\portal\\server.js",
			};
			for (const auto& c : candidates)
				if (FileExists(c))
					return c;
			return {};
		}

		/* Is something already serving on the port?
		 *
		 * Matters because the portal may already run as a scheduled task, and a
		 * second game instance is possible. Spawning into a bound port
		 * gets an immediate EADDRINUSE exit and a confusing "it started but it
		 * isn't ours" state; adopting is both correct and quieter.
		 *
		 * ANY answer counts, including a 401 — an exposed portal with a
		 * password set is still a portal that is up. Only "nothing accepted the
		 * connection" means not running. Short timeouts: this runs on the main
		 * thread from a button press. */
		// POD-only body (no C++ objects with destructors) so it can be wrapped in
		// SEH — C2712 otherwise. `port` is passed in; the caller reads Port()
		// outside the __try. A structured exception inside WinHTTP (an AV in a
		// broken proxy/LSP shim, say) becomes "not answering" instead of a CTD.
		bool PortAnsweringSeh(int port)
		{
			bool up = false;
			__try {
				HINTERNET session = WinHttpOpen(L"SkyManager/1.0",
					WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
					WINHTTP_NO_PROXY_BYPASS, 0);
				if (session) {
					WinHttpSetTimeouts(session, 300, 300, 500, 500);
					if (HINTERNET conn = WinHttpConnect(session, L"127.0.0.1",
							static_cast<INTERNET_PORT>(port), 0)) {
						if (HINTERNET req = WinHttpOpenRequest(conn, L"GET", L"/api/health",
								nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0)) {
							if (WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
									WINHTTP_NO_REQUEST_DATA, 0, 0, 0))
								up = WinHttpReceiveResponse(req, nullptr) != FALSE;
							WinHttpCloseHandle(req);
						}
						WinHttpCloseHandle(conn);
					}
					WinHttpCloseHandle(session);
				}
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				up = false;
			}
			return up;
		}

		bool PortAnswering()
		{
			return PortAnsweringSeh(Port());
		}

		bool ChildAlive()
		{
			if (!g_child)
				return false;
			return WaitForSingleObject(g_child, 0) == WAIT_TIMEOUT;
		}

		void CloseHandles()
		{
			if (g_child) { CloseHandle(g_child); g_child = nullptr; }
			if (g_job)   { CloseHandle(g_job);   g_job = nullptr; }
		}

		void StartImpl()
		{
			std::lock_guard lock(g_mutex);
			if (ChildAlive())
				return;

			const std::wstring node = FindNode();
			if (node.empty()) {
				g_reason = "Node.js isn't installed - the portal needs it. Install it from nodejs.org, then restart Skyrim.";
				if (!g_triedOnce)
					logger::info("portal-host: node.exe not found; portal disabled (Node is a documented requirement, not bundled)");
				g_triedOnce = true;
				return;
			}

			const std::wstring server = FindServer();
			if (server.empty()) {
				g_reason = "The portal's files are missing from the mod folder.";
				if (!g_triedOnce)
					logger::warn("portal-host: server.js not found in the mod folder (set DECK_PORTAL_SERVER to override)");
				g_triedOnce = true;
				return;
			}

			// Somebody is already serving: adopt rather than race a bound socket.
			if (PortAnswering()) {
				g_ours = false;
				g_reason.clear();
				if (!g_triedOnce)
					logger::info("portal-host: a portal is already running on port {} - adopting it", Port());
				g_triedOnce = true;
				return;
			}

			/* A Job Object with KILL_ON_JOB_CLOSE is the whole reason this is safe
			 * to do automatically: if the GAME CRASHES, our shutdown path never
			 * runs, and a stray node server would keep the port bound so the next
			 * launch could not start one. Tying the child's lifetime to this
			 * process's handle makes the OS clean up for us. */
			g_job = CreateJobObjectW(nullptr, nullptr);
			if (g_job) {
				JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
				li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
				SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof(li));
			}

			std::wstring cmd = L"\"" + node + L"\" \"" + server + L"\"";

			STARTUPINFOW        si{};
			PROCESS_INFORMATION pi{};
			si.cb = sizeof(si);
			si.dwFlags = STARTF_USESHOWWINDOW;
			si.wShowWindow = SW_HIDE;

			// CREATE_SUSPENDED so the child is in the job BEFORE it can spawn
			// anything of its own; otherwise a grandchild could escape the job and
			// outlive the game.
			const BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
				CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &si, &pi);
			if (!ok) {
				g_reason = "Couldn't start the portal (Node is installed but wouldn't run).";
				logger::warn("portal-host: CreateProcess failed ({})", GetLastError());
				CloseHandles();
				g_triedOnce = true;
				return;
			}

			if (g_job)
				AssignProcessToJobObject(g_job, pi.hProcess);
			ResumeThread(pi.hThread);
			CloseHandle(pi.hThread);

			g_child = pi.hProcess;
			g_ours = true;
			g_reason.clear();
			g_triedOnce = true;
			logger::info("portal-host: started the Deck Portal on {} (pid {})", Url(), pi.dwProcessId);
		}

		void StopImpl()
		{
			std::lock_guard lock(g_mutex);
			if (!g_child) { CloseHandles(); return; }
			// Closing the JOB is the kill: it takes the child and anything it
			// spawned, which TerminateProcess on the child alone would not.
			logger::info("portal-host: stopping the Deck Portal");
			CloseHandles();
			g_ours = false;
		}

		std::string StateJsonImpl()
		{
			std::lock_guard lock(g_mutex);
			const bool alive = ChildAlive();
			// A child that EXITED (port clash, a crash in node) must not keep
			// reporting "running" — re-probe rather than trust our own handle.
			const bool running = alive || PortAnswering();
			if (!running && g_reason.empty() && g_triedOnce)
				g_reason = "The portal isn't running.";

			return json{
				{ "ok", true },
				{ "running", running },
				{ "ours", alive && g_ours.load() },
				{ "url", Url() },
				{ "node", !FindNode().empty() },
				{ "reason", running ? std::string() : g_reason },
			}.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string OpenImpl()
		{
			StartImpl();  // first press starts it; takes its own lock

			bool running;
			{
				std::lock_guard lock(g_mutex);
				running = ChildAlive();
			}
			if (!running)
				running = PortAnswering();

			if (running) {
				// The default browser, on the machine the game is on — which is the
				// only place 127.0.0.1 means anything. Widen() sizes the buffer
				// exactly; the old std::wstring(begin,end) here is what threw the
				// std::length_error that CTD'd the game on 2026-08-13.
				const std::wstring url = Widen(Url());
				if (!url.empty()) {
					ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
					logger::info("portal-host: opened {} in the default browser", Url());
				}
			}
			return StateJsonImpl();
		}

		// A JSON payload the deck can always render, even after a failure — so a
		// caught exception still lights the button's error state instead of
		// leaving it spinning.
		std::string FailJson(const char* why)
		{
			return json{
				{ "ok", true },
				{ "running", false },
				{ "ours", false },
				{ "url", Url() },
				{ "node", false },
				{ "reason", why ? why : "The portal hit an unexpected error." },
			}.dump(-1, ' ', false, json::error_handler_t::replace);
		}
	}

	/* Public entry points — every one runs on the SKSE MAIN THREAD (the deck's
	 * bridge handlers AddTask into it), so an exception escaping here does not
	 * unwind into friendly code: it terminates the process. That is precisely
	 * how the Portal button CTD'd the game on 2026-08-13 — a std::length_error
	 * ("string too long") from a string op climbed out of the task with nothing
	 * to catch it. The header's "never throws" contract is enforced HERE:
	 * catch(...) turns any C++ exception into a logged no-op / error payload, and
	 * the SEH guard in the WinHTTP probe covers structured exceptions too. */
	void Start()
	{
		try {
			StartImpl();
		} catch (const std::exception& e) {
			logger::error("portal-host: Start threw ({}) - swallowed so the game survives", e.what());
		} catch (...) {
			logger::error("portal-host: Start threw a non-standard exception - swallowed");
		}
	}

	void Stop()
	{
		try {
			StopImpl();
		} catch (...) {
			logger::error("portal-host: Stop threw - swallowed so the game survives");
		}
	}

	std::string StateJson()
	{
		try {
			return StateJsonImpl();
		} catch (const std::exception& e) {
			logger::error("portal-host: StateJson threw ({}) - returning an error payload", e.what());
			return FailJson("The portal hit an unexpected error.");
		} catch (...) {
			logger::error("portal-host: StateJson threw a non-standard exception - returning an error payload");
			return FailJson("The portal hit an unexpected error.");
		}
	}

	std::string Open()
	{
		try {
			return OpenImpl();
		} catch (const std::exception& e) {
			logger::error("portal-host: Open threw ({}) - returning an error payload so the button doesn't hang", e.what());
			return FailJson("Couldn't open the portal (an unexpected error).");
		} catch (...) {
			logger::error("portal-host: Open threw a non-standard exception - returning an error payload");
			return FailJson("Couldn't open the portal (an unexpected error).");
		}
	}
}
