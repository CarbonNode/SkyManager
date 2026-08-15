#pragma once

#include <string>

// Console-command entries (device == "console"): a deck button that runs the
// command text you typed — one console command per line — exactly as if you
// had opened the console and typed it. Because a console entry is a normal
// deck entry, every surface fires it for free: the palette row, a bound
// trigger key, a Hotbar slot, a wheel pin, a shelf pin, an Omni hit.
//
// Target modes (the entry's reused `action` field, the vkey-verb precedent):
//   ""          — global: CompileAndRun(nullptr), like typing with nothing
//                 selected ("tgm", "player.additem f 100", "set timescale to 6").
//   "crosshair" — ref-scoped: runs ON the crosshair snapshot (actor first,
//                 then the non-actor ref), like clicking a ref in the console
//                 first ("resurrect", "unlock", "disable"). No target found
//                 is an honest on-screen refusal, never a silent global run.
namespace ConsoleActions
{
	// Longest command text an entry may carry. The view enforces this at
	// creation; the config parser drops (with a log) anything longer, which
	// can only be a hand-edited hotkeys.json.
	inline constexpr std::size_t kCommandMax = 4096;

	// Run one entry's command text. MAIN THREAD ONLY (CompileAndRun).
	// `name` is the entry name (for the HUD/log); `targetCrosshair` selects
	// the target mode described above.
	void Fire(const std::string& name, const std::string& command, bool targetCrosshair);
}
