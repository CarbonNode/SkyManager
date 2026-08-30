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
#include <functional>
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
	//
	// `onBlocked` (optional) also runs on the watchdog thread when it fires, so
	// a caller can leave durable evidence of a hang the main thread can never
	// record itself (the smooth-pause wedge sentinel writes its flag file here).
	// It must touch NOTHING but the filesystem/atomics — the game thread is
	// presumed hung underneath it. A callback keeps the watchdog armed even when
	// bOpenTiming=0 has silenced the logging.
	class Watchdog
	{
	public:
		Watchdog(const char* label, std::int64_t afterMs,
			std::function<void()> onBlocked = nullptr);
		~Watchdog();
		void Done();

	private:
		std::shared_ptr<std::atomic<bool>> done_;
	};

	// ------------------------------------------------------ steady-state census
	// The open path has told us where its milliseconds go since 2026-08-13. The
	// PLAY path never has: this plugin posts ~20-25 tasks a second to the game
	// thread while the player is just walking around (room guard, loot scan,
	// auto-loot, no-auto-gear, the HUD roster scan, the hotbar visibility beat,
	// the widgets rebuild, the portal watchdog), and nothing recorded what any
	// of them cost. "Intense microstuttering" cannot be attributed or ruled out
	// without that number, so each periodic main-thread task now times itself
	// and ONE summary line per 60 s names the worst offenders — never a line per
	// tick, and never any output at all when nothing was recorded.
	//
	// ON by default, same reasoning as bOpenTiming (a stuttering user cannot be
	// asked to switch a setting on first). Opt out:
	//     [Diagnostics]
	//     bTickCensus=0
	//
	// MAIN THREAD ONLY. `label` must be a string LITERAL — buckets are keyed by
	// pointer identity so the census never allocates or hashes on the hot path.
	bool TickCensusEnabled();

	// Record one completed main-thread task. Cheap: a pointer compare per bucket.
	void NoteTick(const char* label, std::int64_t micros);

	// Emit the summary if 60 s have passed since the last one and anything was
	// recorded. Safe (and free) to call every second; call it on the main thread.
	void FlushTickCensus();

	// Scoped timer around a periodic main-thread task:
	//     OpenDiag::TickTimer t("room-guard");
	class TickTimer
	{
	public:
		explicit TickTimer(const char* label);
		~TickTimer();

	private:
		const char*   label_;
		std::int64_t  startUs_;
	};
}
