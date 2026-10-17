#pragma once

#include <string>

// ---------------------------------------------------------------------------
// PPA — Procedural Penis Animations (AccuratePenetration.dll), surfaced on the
// deck's Scene page (Rober, 2026-09-21: "hook ppa - procedural penis animations
// and have its settings in the unified menu").
//
// WHAT PPA ACTUALLY IS. A pure C++ SKSE plugin. It ships NO esp, NO Papyrus and
// NO MCM — so there is no quest to read, no global to set and no SkyUI page to
// drive. Every one of its ~90 tunables lives in ONE file:
//
//     Data/SKSE/Plugins/accurate-penetration.toml
//
// (plus ppa-override-configs / ppa-animation-tagging / ppa-voice-configs, which
// are per-actor and per-animation and deliberately NOT edited from here.)
//
// SO THE WIRE IS THE FILE. We rewrite a single value in place and then tap the
// Reload hotkey PPA itself ships, read LIVE from that same file's [Hotkeys]
// section so a rebind there stays honoured — the sos_actions.cpp / menu_actions
// idiom, and the same reason: synthesize exactly the input the target mod is
// listening for, never a hardcoded default.
//
// ⚠ TWO THINGS THE EDITOR MUST NOT BREAK, both stated by PPA's own file:
//   · comments. The file is 550 lines of which most are documentation, and it
//     is the only documentation PPA has. Every write is line-surgical: the
//     value substring is replaced and the rest of the line, including a
//     trailing comment, is preserved byte for byte.
//   · decimal spelling. PPA warns in its header: "If a value has decimal
//     places, like 1.0 - you MUST have a decimal. No decimal means it may be
//     read wrong." So a float is always written back WITH a decimal point, and
//     an integer always without.
//
// The synthesized reload DOES land with the deck open (2026-10-14: each
// "ppa: X = Y (reload dik 63)" line is followed ~70 ms later by PPA's own
// "Loading config file" line in AccuratePenetration.log).
//
// ⚠ AND A RELOAD IS NOT ENOUGH. PPA keeps a second, SKSE Menu Framework copy of
// its General/Hotkeys/Debug/SoundEffects settings and writes it back over this
// file on every Escape press (SMF calls that "menu closed"); a reload never
// refreshes it. So every write here also sets that copy (ppa_menu_sync.h),
// or the deck's own close key undoes the change.
// ---------------------------------------------------------------------------

namespace PpaConfig
{
	// { ok, installed, path, reloadKey, reloadDik, shiftOnly, rows:[…], msg }
	// rows: { section, key, label, type:"bool"|"int"|"float", value, step,
	//         detail, readonly }
	std::string StateJson();

	// request: { key:"Section.Key", value:"<text>" } -> the new StateJson with
	// { ok, msg } replaced. Rewrites the file, then taps PPA's Reload key on a
	// detached worker. Main thread.
	std::string Set(const std::string& request);

	// Taps PPA's own Reload key, read live from the file, so PPA re-reads it
	// (the Keys tab calls this after rewriting one of PPA's [Hotkeys] keys,
	// keys_write.cpp). Returns the key as words ("Shift + F5"), or "" when PPA
	// is not loaded, the file is unreadable, or its reload key is unbound.
	std::string ReloadNow();

	// Sets PPA's SKSE Menu Framework copy of its settings to what the toml
	// says (ppa_menu_sync.h: PPA writes that copy back over the file on every
	// Escape, and a reload never refreshes it). Set/StateJson/ReloadNow call
	// it themselves; call it after any OTHER write to the file. false when PPA
	// is absent or its settings list could not be found. Any thread.
	bool KeepMenuInStep(const char* why);
}
