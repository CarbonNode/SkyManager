#pragma once

#include <string>

/*
 * MinimapBridge — SkyManager's side of Detailed MiniMap (Neutral9, GPL-3.0,
 * github.com/Neutral9/DetailedMiniMap). Rober, 2026-10-09: "can we hook this
 * and its settings into skymanager? and maybe ability to easily drag it around
 * screen and maybe add some cool generated frames for it? Focus square /
 * rectangle".
 *
 * Upstream has no API: its settings live in a struct read every frame and two
 * ini files it reads once at launch. So the minimap runs as OUR fork
 * (modding/detailed-minimap/: a patch over a pinned upstream commit) which
 * exports a small C API — DMM_ApiVersion / GetState / Set / Save / SetPreview /
 * GetRect / Place / Reset — and adds rectangle maps and image frames. This
 * module finds those exports with GetProcAddress on DetailedMiniMap.dll and
 * never links to it: without the DLL the HUD editor says the mod is missing,
 * with the upstream DLL (no exports) it says the SkyManager build is needed.
 * DMM keeps owning its own ini; nothing here writes it behind its back.
 *
 * Bridge (deck AND HUD view): request mmCfg, reply mmCfgState.
 *   {op:"get"}
 *   {op:"set", values:{"Section.Key": v, ...}, save?, quiet?}
 *   {op:"place", l, t, w, h, save?, quiet?}   fractions of the screen
 *   {op:"preview", on}
 *   {op:"reset", what:"map"|"look"}
 *   {op:"shelf"}                              deck only, handled in main.cpp
 * Preview (shown and outlined under menus) follows the HUD editor: main.cpp
 * calls SyncPreview with g_hudEditing from its 500 ms tick and on edit entry.
 *
 * Main thread only (DMM builds its frame there).
 */
namespace MinimapBridge
{
	// the mmCfgState payload: {present, api, ok, msg, settings, ranges, kinds, frames, iconStyles, rect, preview, keys}
	std::string StateJson();

	// one mmCfg request applied; a_push: the caller pushes StateJson() back
	void Handle(const std::string& a_payload, bool& a_push);

	// preview on while the HUD editor is up, off once it is not (cheap when unchanged)
	void SyncPreview(bool a_editing);

	bool Present();  // DetailedMiniMap.dll loaded (any build)
}
