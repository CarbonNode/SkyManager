#pragma once

#include <functional>
#include <string>

// ---------------------------------------------------------------------------
// Keys tab: rebind ANOTHER mod's hotkey by rewriting its own config in place.
//
// Rober, 2026-10-11: "walk with me and skymanager, doesnt integrate their
// hotkey into our hotkey menu?" then "would be cool if it could parse skse
// menu mods and show them as hotkeys in our app that our configurable
// universally".
//
// WHAT MAY BE WRITTEN is decided by the census, not here: keys_sources.cpp
// gives every file row a Write handle or a reason (keys_sources.h, WRITING).
// This module only trusts what it can re-derive. A request names a file, a
// field and the stamp the census saw; the file is re-read here, the field
// must be a WRITABLE row of that fresh reading, and the bytes must still be
// the ones the census saw. Anything else is refused and the row re-read.
//
// HOW it writes (the formation_wwm / ppa_config precedent):
//   * in place: exactly the value's bytes change -- comments, order, unknown
//     keys, line endings, quoting and number spelling (0x hex stays hex) are
//     kept byte for byte, and the result is re-parsed and compared before a
//     byte reaches the disk;
//   * one backup per file per session, next to it: <file>.skymanager-bak;
//   * truncate-and-write, not temp-and-rename (MO2's VFS, see formation_wwm);
//   * file IO on a worker thread; the mod's own re-read runs on the main
//     thread afterwards: Walk With Me's ReloadSettings, PPA's reload key
//     (read live from its file). Every other mod: "takes effect next launch".
// ---------------------------------------------------------------------------

namespace KeysWrite
{
	// kcRebind. `request` (JSON):
	//   { file, field, stamp, code: <DIK 1..255>, mods: ["Shift","Ctrl","Alt"] }
	//   { file, field, stamp, clear: true }
	// Returns at once; the work runs on a worker. `done` is called on the MAIN
	// thread with { ok, msg, file, field, code, mods, cleared, apply, applied }.
	void Rebind(std::string request, std::function<void(std::string)> done);
}
