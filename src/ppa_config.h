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
// ⚠ AND ONE THING THAT IS NOT PROVEN. Whether PPA's input handler sees a
// synthesized key while the PrismaUI overlay is up has NOT been play-tested.
// The deck's input sink cannot consume events (a deck key also does its vanilla
// job), which is the reason to expect it works — but expectation is not
// evidence, and the page says so rather than claiming the reload landed.
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
}
