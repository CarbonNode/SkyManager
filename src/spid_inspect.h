#pragma once

#include <string>

// Distributions tab — "what could SPID / SkyPatcher give the NPC in my
// crosshair?" (Rober, 2026-08-18: "hit f7 on an npc and inspect them for any
// SPID/SkyPatcher's that effect them (possible, equipment, outfits) and then
// show the items it could add in a searchable UI (like the finder tab)").
//
// This module OWNS: enumerating + parsing every SPID `Data/*_DISTR.ini` and
// every `Data/SKSE/Plugins/SkyPatcher/npc/**/*.ini` the VFS shows (i.e. the
// enabled set — the game's own view of Data is the ground truth, no MO2
// parsing), and evaluating their filters against one actor's BASE record.
//
// HONESTY CONTRACT (the part the UI must keep saying):
//  - This answers "which distribution lines does this NPC's base record PASS
//    the filters of" — the candidate pool. It is NOT a replay of what SPID
//    actually rolled at load: chance is a per-NPC dice roll, and of many
//    matched outfits at most one is actually worn. Chance is therefore shown
//    per row, never resolved.
//  - Filters we cannot evaluate are BADGED per row ("uncertain"), and lines
//    whose filters we cannot evaluate at all are counted and reported, never
//    silently dropped into "no matches".
//
// Threading: file parsing runs on a worker thread (pure file IO, no game
// API). Form resolution and filter evaluation happen on the MAIN thread only
// (handlers arrive via SKSE::GetTaskInterface()->AddTask, same as every other
// pane bridge).
namespace SpidInspect
{
	// dxState → reply "dxStateResult": index status (building/ready + file and
	// line counts) plus the crosshair target card, or an honest refusal shaped
	// like the F7 inspect card's. First call kicks the parse thread off.
	std::string StateJson(const std::string& reqJson);

	// dxQuery → reply "dxResultData": the matched rows for the current target,
	// narrowed by {q, group}, with per-group counts over the full matched set.
	// {building:true} while the parse thread is still reading files.
	std::string QueryJson(const std::string& reqJson);

	// dxLeveled → reply "dxLeveledData": expand a leveled list.
	//
	// Why this exists: a distribution row often names a LEVELED LIST, which has
	// no display name at all — so the row can only show the raw form spec, and
	// Rober quite reasonably asked "what item is it saying it added?" of seven
	// rows that were all vanilla food lists. The honest answer is not a better
	// label, it is the CONTENTS: what the roll can actually produce.
	//
	// Takes {formId, plugin} and walks TESLevItem / TESLevCharacter recursively,
	// because leveled lists nest freely (a food list of food lists). Each node
	// reports its entries with count and required level, plus the list's own
	// chance-none and use-all flag, since those decide whether an entry is a
	// maybe or a certainty. Depth and node count are capped — a malformed or
	// self-referencing list must not walk forever.
	std::string LeveledJson(const std::string& reqJson);

	// dxOpenFile → reply "dxOpenResult": open one distribution ini on the PC.
	//
	// Rober, 2026-08-19: "i want to be able to open the spid doc on the pc with a
	// button in the UI". Takes {file} (the bare filename the rows already carry).
	//
	// ⚠ THE VFS PROBLEM, and why this is not one ShellExecute call. The path the
	// scanner walked is a VIRTUAL one — "Data\X_DISTR.ini" exists only inside the
	// game's USVFS view, and the shell process that would open it is NOT in that
	// view, so handing it that path opens nothing. So this resolves a REAL path
	// first: the MO2 mods root is derived from our own module handle (the same
	// walk icon_bridge uses for its writes), each mod folder is checked for the
	// file, and the physical Data folder is tried as the non-MO2 case. Only a
	// path that actually exists on disk is handed to the shell.
	std::string OpenFileJson(const std::string& reqJson);

	// dxReport → reply "dxReportResult": write a full diagnostic dump for the
	// inspected NPC to the real Desktop.
	//
	// Rober, 2026-08-20: "drop a spid report to desktop could be useful for
	// diagnosing leveled list and spid issues." The tab answers "what targets
	// her"; the report answers "why is this not firing", which needs three
	// things the pane summarises away — the RAW ini line as written, the lines
	// we rejected WITHOUT understanding (the honesty counter, itemised), and the
	// NPC's own resolved identity, since a non-match is usually explained by
	// something she is not. Leveled-list rows are expanded to what they can roll.
	//
	// Plain text: read by a human, grepped, pasted into a chat. Written outside
	// the VFS, so this is the one path in this module that needs no MO2 thought.
	std::string ReportJson(const std::string& reqJson);
}
