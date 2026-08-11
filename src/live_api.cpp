#include "live_api.h"

#include <atomic>
#include <thread>
#include <vector>

// pch (force-included) provides Windows.h (via PrismaUI_API.h's WIN32_LEAN_AND_MEAN
// include) plus SKSE's logger. Named pipes live in Windows.h, so there is nothing
// extra to include and no header-ordering hazard.

namespace LiveApi
{
	namespace
	{
		constexpr DWORD kBufSize = 64 * 1024;          // per-instance pipe buffer
		constexpr std::size_t kMaxRequest = 256 * 1024;  // hard cap on one request

		std::atomic<bool> g_running{ false };
		std::string       g_pipePath;
		Handler           g_handler;

		// Read one newline-terminated request. Returns false on EOF, error, or a
		// client that exceeds the cap (a portal bug must never grow the game's
		// heap without bound).
		bool ReadRequest(HANDLE pipe, std::string& out)
		{
			out.clear();
			std::vector<char> buf(4096);
			for (;;) {
				DWORD read = 0;
				if (!ReadFile(pipe, buf.data(), static_cast<DWORD>(buf.size()), &read, nullptr) || read == 0)
					return false;  // client hung up or errored
				out.append(buf.data(), read);
				if (const auto nl = out.find('\n'); nl != std::string::npos) {
					out.resize(nl);  // drop the delimiter and anything after it
					return true;
				}
				if (out.size() > kMaxRequest) {
					logger::warn("live api: request exceeded {} bytes — dropped", kMaxRequest);
					return false;
				}
			}
		}

		void WriteResponse(HANDLE pipe, const std::string& body)
		{
			const std::string payload = body + "\n";
			DWORD             written = 0;
			// One shot: the client reads until the newline and closes. A partial
			// write means the client vanished, which is not worth retrying.
			WriteFile(pipe, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr);
			FlushFileBuffers(pipe);
		}

		// One connection at a time, forever. Requests are tiny and rare (a phone
		// tap), so a sequential loop is the right shape: no thread pool to starve,
		// no concurrency for the handler to defend against beyond what the config
		// mutex already gives us.
		void ServeLoop(std::string pipePath)
		{
			while (true) {
				const HANDLE pipe = CreateNamedPipeA(
					pipePath.c_str(),
					PIPE_ACCESS_DUPLEX,
					PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
					PIPE_UNLIMITED_INSTANCES,
					kBufSize, kBufSize,
					0,        // default timeout
					nullptr);  // default ACL: the creating user only — this is why
					           // the pipe needs no auth of its own.
				if (pipe == INVALID_HANDLE_VALUE) {
					logger::error("live api: CreateNamedPipe failed ({}) — retrying in 5 s", GetLastError());
					g_running = false;
					std::this_thread::sleep_for(std::chrono::seconds(5));
					continue;
				}
				g_running = true;

				// Blocks until a client connects. ERROR_PIPE_CONNECTED means one
				// beat us to it between Create and Connect — still a live client.
				const BOOL ok = ConnectNamedPipe(pipe, nullptr) ? TRUE :
					(GetLastError() == ERROR_PIPE_CONNECTED ? TRUE : FALSE);
				if (!ok) {
					CloseHandle(pipe);
					continue;
				}

				std::string request;
				if (ReadRequest(pipe, request)) {
					std::string response;
					try {
						response = g_handler ? g_handler(request) :
											   R"({"ok":false,"msg":"no handler"})";
					} catch (const std::exception& ex) {
						// The handler touches config and the file system; a throw
						// here must never take the game's process with it.
						logger::error("live api: handler threw: {}", ex.what());
						response = R"({"ok":false,"msg":"handler error"})";
					} catch (...) {
						logger::error("live api: handler threw a non-std exception");
						response = R"({"ok":false,"msg":"handler error"})";
					}
					WriteResponse(pipe, response);
				}

				FlushFileBuffers(pipe);
				DisconnectNamedPipe(pipe);
				CloseHandle(pipe);
			}
		}
	}

	void Start(const std::string& pipeName, Handler handler)
	{
		if (pipeName.empty()) {
			logger::info("live api: disabled (empty pipe name) — portal falls back to sidecars");
			return;
		}
		if (g_handler) {
			logger::warn("live api: already started — ignoring second Start()");
			return;
		}
		g_handler = std::move(handler);
		g_pipePath = "\\\\.\\pipe\\" + pipeName;
		std::thread(ServeLoop, g_pipePath).detach();  // lives for the whole process
		logger::info("live api: listening on {} (portal pushes land instantly; sidecars remain the offline path)",
			g_pipePath);
	}

	bool Running() { return g_running.load(); }

	std::string PipePath() { return g_pipePath; }
}
