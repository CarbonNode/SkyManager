#pragma once

// Open/close timing diagnostics — born from Nexus report Ank164 2026-08-13
// ("freezes ~10s on first press, then nothing; second press opens; third
// freezes solid"). We could not diagnose remotely because nothing recorded
// WHERE the time went. Now every open/close phase logs its duration to the
// ordinary HotkeyDeck.log, so a user's copy-paste names the guilty step —
// and a side-thread watchdog logs when open/close BLOCKS, precisely because
// the main thread is the thing that may be hung.
//
// ON by default (a freezing user cannot be asked to enable a setting first).
// Opt out: Data\SKSE\Plugins\SkyManager.ini
//     [Diagnostics]
//     bOpenTiming=0

#include <atomic>
#include <cstdint>
#include <memory>

namespace OpenDiag
{
	// The INI verdict, read once and cached. Missing file / missing key = ON.
	bool Enabled();

	// Generic boolean probe against Data\SKSE\Plugins\SkyManager.ini (section-blind,
	// same 0/false=off, anything-else=on parse as bOpenTiming). Missing file or
	// missing key returns `dflt`. Lets other subsystems (e.g. [Performance]
	// bEagerDeckView) read the same INI without duplicating the parser. Not cached
	// here — the caller caches (once, in a function-local static).
	bool IniBool(const char* key, bool dflt);

	// Monotonic milliseconds, for phase math.
	[[nodiscard]] std::int64_t NowMs();

	// "open-diag: <label> took <ms> ms" when enabled (info; warn at >= slowMs).
	void LogMs(const char* label, std::int64_t ms, std::int64_t slowMs = 1000);

	// Side-thread watchdog: if Done() has not run after `afterMs`, log that
	// `label` is still blocked — from the watchdog thread, since the main
	// thread may be the thing that is hung. Destroying the object disarms.
	class Watchdog
	{
	public:
		Watchdog(const char* label, std::int64_t afterMs);
		~Watchdog();
		void Done();

	private:
		std::shared_ptr<std::atomic<bool>> done_;
	};
}
