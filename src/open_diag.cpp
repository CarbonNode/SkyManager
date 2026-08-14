#include "open_diag.h"

#include "pch.h"

#include <chrono>
#include <fstream>
#include <string>
#include <thread>

namespace OpenDiag
{
	namespace
	{
		// Tiny by-hand INI probe (the SkyrimDiagHelper style): find the named key
		// anywhere in SkyManager.ini (section-blind, as the original bOpenTiming
		// probe was), honor 0/false, treat everything else — including a missing
		// file or a missing key — as `dflt`. Shared by every boolean SkyManager.ini
		// flag so INI parsing lives in exactly one place.
		bool ReadIniBool(const char* wantKey, bool dflt)
		{
			std::ifstream in("Data/SKSE/Plugins/SkyManager.ini");
			if (!in)
				return dflt;
			std::string line;
			while (std::getline(in, line)) {
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				std::string key = line.substr(0, eq);
				key.erase(0, key.find_first_not_of(" \t"));
				key.erase(key.find_last_not_of(" \t") + 1);
				if (_stricmp(key.c_str(), wantKey) != 0)
					continue;
				std::string val = line.substr(eq + 1);
				val.erase(0, val.find_first_not_of(" \t"));
				val.erase(val.find_last_not_of(" \t\r") + 1);
				return !(val == "0" || _stricmp(val.c_str(), "false") == 0);
			}
			return dflt;
		}
	}

	bool Enabled()
	{
		static const bool s_on = []() {
			const bool on = ReadIniBool("bOpenTiming", true);
			if (!on)
				logger::info("open-diag: disabled via SkyManager.ini [Diagnostics] bOpenTiming=0");
			return on;
		}();
		return s_on;
	}

	bool IniBool(const char* key, bool dflt)
	{
		return ReadIniBool(key, dflt);
	}

	std::int64_t NowMs()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	void LogMs(const char* label, std::int64_t ms, std::int64_t slowMs)
	{
		if (!Enabled())
			return;
		if (ms >= slowMs)
			logger::warn("open-diag: {} took {} ms (SLOW)", label, ms);
		else
			logger::info("open-diag: {} took {} ms", label, ms);
	}

	Watchdog::Watchdog(const char* label, std::int64_t afterMs)
	{
		if (!Enabled())
			return;
		done_ = std::make_shared<std::atomic<bool>>(false);
		// Detached on purpose: if the main thread hangs, this is the only voice
		// left. shared_ptr keeps the flag alive past our destruction.
		std::thread([flag = done_, name = std::string(label), afterMs]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(afterMs));
			if (!flag->load())
				logger::warn("open-diag: {} STILL BLOCKED after {} ms - the render/main "
				             "thread is likely hung underneath it", name, afterMs);
		}).detach();
	}

	Watchdog::~Watchdog()
	{
		Done();
	}

	void Watchdog::Done()
	{
		if (done_)
			done_->store(true);
	}
}
