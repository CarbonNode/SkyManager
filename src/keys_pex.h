#pragma once

// Keys tab, Papyrus source: the keys a script asks for in COMPILED bytecode.
//
// The hole this fills. A classic script mod calls `RegisterForKey(<code>)` in
// its own quest script and never registers an MCM. Nothing else in the census
// can see that: it is not in the ControlMap, there is no MCM to ask, there is
// no config file to read. The bind exists only inside a .pex.
//
// So we read the .pex. Every loose `Data/Scripts/*.pex` (the MO2 VFS hands us
// the winning copy of each) is parsed for `RegisterForKey` calls, and the key
// code is resolved from an integer literal, from a local the same function
// assigned a literal to, or from the compiled default of the object variable
// backing a property. Anything it cannot resolve produces NOTHING -- a census
// row invented from an unresolved argument would be a lie in a conflict list.
//
// What it deliberately SKIPS:
//   * scripts extending SKI_ConfigBase, or calling AddKeyMapOption -- those are
//     MCM configs, and keys_scan.cpp already asks the live MCM what it owns.
//     Reading their compiled defaults too would report a stale key beside the
//     real one and call the pair a conflict.
//   * .pex packed inside a BSA. The archive contents are not enumerable from
//     here; loose scripts are the common case and the scan says so in the log
//     rather than implying it read everything.
//
// Code space is NOT ambiguous here, unlike a plugin config: Papyrus
// `RegisterForKey` takes a DirectInput scancode, which is the census space
// already. These rows are facts, not assumptions.
//
// COST + CACHE. A large load order has thousands of loose scripts. Two things
// keep this cheap: every file is rejected on its STRING TABLE (if the compiled
// name `RegisterForKey` is not in it, the object walk never happens), and the
// per-file result is cached in a sidecar keyed by path + size + write time, so
// only scripts that actually changed are re-read.

#include <cstdint>
#include <string>
#include <vector>

namespace KeysPex
{
	struct Row
	{
		std::string   script;   // owning script class, e.g. "MyMod_ControlQuest"
		std::string   control;  // what it does, e.g. "Registered in OnInit"
		std::uint32_t code;     // DirectInput scancode (census space)
		std::string   detail;   // provenance: file, function, resolved argument
	};

	// Parse (or reuse cached results for) every loose Data/Scripts/*.pex.
	// force=true ignores the cache. Best-effort throughout: a malformed script
	// is skipped, never fatal.
	std::vector<Row> Scan(bool force);

	// Parse ONE file with the string-table early-out disabled, reporting how the
	// walk went. Two uses: the selftest exercises the full object walk against
	// real scripts (which the early-out would otherwise skip in a fraction of a
	// millisecond), and it answers "why did the scan say nothing about this
	// script?" without a rebuild.
	struct Probe
	{
		bool             ok = false;   // the walk completed and landed cleanly
		bool             mcmOwned = false;
		std::string      error;        // set when ok is false
		std::vector<Row> rows;
	};

	Probe ProbeFile(const std::string& path);
}
