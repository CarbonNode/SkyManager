#pragma once

#include <string>

// ---------------------------------------------------------------------------
// SKSE Menu Framework pages in the Omni (Cmd-K).
//
// Rober, 2026-10-03: "it would be cool if we could auto parse any mod that
// adds a menu in https://www.nexusmods.com/skyrimspecialedition/mods/120352
// and make them searchable in our command k in skymanager".
//
// SKSE Menu Framework (SMF, Thiago099 / QTR-Modding) is the ImGui "Mod Control
// Panel". Mods add pages to it with AddSectionItem("Section/Page", render).
//
// ── Reading the list ────────────────────────────────────────────────────────
// SMF 3.0 (the rig's build, source commit 592860b) has NO enumeration export.
// Hooking AddSectionItem is no good either: most mods register in
// SKSEPluginLoad, and SkyManager.dll loads after most of them. So we read
// SMF's own menu tree. It is one global, UI::RootMenu, a pointer to:
//
//   class MenuTree {
//       std::map<std::string, MenuTree*> Children;                         // +0
//       std::vector<std::pair<const std::string, MenuTree*>> SortedChildren; // +16
//       RenderFunction Render;                                             // +40
//       std::string Title; };                                              // +48
//
// That global is not exported, so we find it: scan SMF's writable sections
// for a pointer that validates as that root. The checks are strict (see
// smf_index.cpp IsRoot) and the scan FAILS CLOSED: no match, or two different
// matches, means no list, and the log and the Omni say why. A future SMF that
// changes this layout fails the checks; it does not get misread.
//
// ── Opening a page ──────────────────────────────────────────────────────────
// SMF's selected page is a file-static we cannot find, so we do not drive
// SMF's panel. At kDataLoaded we register ONE window of our own with SMF's
// exported AddWindow. Opening a page points that window at the page's own
// render callback and sets IsOpen. SMF then draws it, pauses the game, and
// shows the cursor, as it does for any client window. The page you see is the
// mod's REAL page, not a copy. No hotkey is fired (the CLAUDE.md law: never
// open another mod's UI by firing its hotkey and hoping).
//
// We call ImGui only through SMF's own exported cimgui functions, so our
// calls go to the same ImGui context that SMF renders with.
// ---------------------------------------------------------------------------

namespace SmfIndex
{
	// kDataLoaded, main thread. Registers the host window with SMF.
	// Does nothing when SKSEMenuFramework.dll is not loaded.
	void Init();

	// { ok, present, version, msg, pages:[{ path, section, label, dll }] }
	// Re-walks the tree on every call (pages can register late). MAIN THREAD.
	std::string ListJson();

	// Opens one page in the host window. `path` must name a page in the
	// freshly walked tree; anything else is refused. -> { ok, msg }.
	// MAIN THREAD. The caller closes the deck palette when ok is true.
	std::string Open(const std::string& path);
}
