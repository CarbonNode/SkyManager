#include "open_diag.h"

#include "pch.h"

#include <chrono>
#include <cstddef>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

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

	Watchdog::Watchdog(const char* label, std::int64_t afterMs, std::function<void()> onBlocked)
	{
		// A callback arms the watchdog even with logging opted out — the caller
		// wants the side effect (e.g. the smooth-wedge flag file), not the line.
		if (!Enabled() && !onBlocked)
			return;
		done_ = std::make_shared<std::atomic<bool>>(false);
		// Detached on purpose: if the main thread hangs, this is the only voice
		// left. shared_ptr keeps the flag alive past our destruction.
		std::thread([flag = done_, name = std::string(label), afterMs, cb = std::move(onBlocked)]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(afterMs));
			if (flag->load())
				return;
			if (Enabled())
				logger::warn("open-diag: {} STILL BLOCKED after {} ms - the render/main "
				             "thread is likely hung underneath it", name, afterMs);
			if (cb)
				cb();
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

	// ------------------------------------------------------ steady-state census
	namespace
	{
		struct Bucket
		{
			const char*  label = nullptr;   // string literal; compared by POINTER
			std::int64_t calls = 0;
			std::int64_t worstUs = 0;
			std::int64_t totalUs = 0;
		};

		constexpr std::size_t kMaxBuckets = 24;

		// Main-thread only by contract, but the mutex is free at this call rate and
		// makes a future off-thread NoteTick a slow line rather than a data race.
		std::mutex   g_censusMtx;
		Bucket       g_buckets[kMaxBuckets];
		std::size_t  g_bucketCount = 0;
		std::int64_t g_windowStartMs = 0;
	}

	bool TickCensusEnabled()
	{
		static const bool s_on = []() {
			const bool on = ReadIniBool("bTickCensus", true);
			if (!on)
				logger::info("perf-census: disabled via SkyManager.ini [Diagnostics] bTickCensus=0");
			return on;
		}();
		return s_on;
	}

	void NoteTick(const char* label, std::int64_t micros)
	{
		if (!label || !TickCensusEnabled())
			return;
		std::lock_guard l(g_censusMtx);
		for (std::size_t i = 0; i < g_bucketCount; ++i) {
			if (g_buckets[i].label == label) {
				auto& b = g_buckets[i];
				++b.calls;
				b.totalUs += micros;
				if (micros > b.worstUs)
					b.worstUs = micros;
				return;
			}
		}
		if (g_bucketCount >= kMaxBuckets)
			return;   // never grow unbounded; labels are a fixed, small set
		auto& b = g_buckets[g_bucketCount++];
		b.label = label;
		b.calls = 1;
		b.worstUs = micros;
		b.totalUs = micros;
	}

	void FlushTickCensus()
	{
		if (!TickCensusEnabled())
			return;

		std::string line;
		std::int64_t windowMs = 0;
		{
			std::lock_guard l(g_censusMtx);
			const auto now = NowMs();
			if (g_windowStartMs == 0) {
				g_windowStartMs = now;
				return;   // first call only starts the clock
			}
			windowMs = now - g_windowStartMs;
			if (windowMs < 60000 || g_bucketCount == 0)
				return;

			// Heaviest TOTAL first — that is the frame time this plugin actually
			// spent, which is the question. Selection sort over <=24 entries.
			std::size_t order[kMaxBuckets];
			for (std::size_t i = 0; i < g_bucketCount; ++i)
				order[i] = i;
			for (std::size_t i = 0; i < g_bucketCount; ++i)
				for (std::size_t j = i + 1; j < g_bucketCount; ++j)
					if (g_buckets[order[j]].totalUs > g_buckets[order[i]].totalUs)
						std::swap(order[i], order[j]);

			const auto ms1 = [](std::int64_t us) {
				// one decimal, no float formatting
				return std::to_string(us / 1000) + "." + std::to_string((us % 1000) / 100);
			};
			for (std::size_t i = 0; i < g_bucketCount; ++i) {
				const auto& b = g_buckets[order[i]];
				if (b.calls == 0)
					continue;
				if (!line.empty())
					line += " | ";
				line += b.label;
				line += ' ';
				line += std::to_string(b.calls);
				line += "x worst ";
				line += ms1(b.worstUs);
				line += "ms total ";
				line += ms1(b.totalUs);
				line += "ms";
			}
			g_bucketCount = 0;
			g_windowStartMs = now;
		}
		if (!line.empty())
			logger::info("perf-census ({}s, main thread): {}", windowMs / 1000, line);
	}

	TickTimer::TickTimer(const char* label) :
		label_(label), startUs_(0)
	{
		if (label_ && TickCensusEnabled())
			startUs_ = std::chrono::duration_cast<std::chrono::microseconds>(
				std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	TickTimer::~TickTimer()
	{
		if (!label_ || startUs_ == 0)
			return;
		const auto endUs = std::chrono::duration_cast<std::chrono::microseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
		NoteTick(label_, endUs - startUs_);
	}
}
