#pragma once

// ---------------------------------------------------------------------------
// "Mod Menus" button on the Esc menu.
//
// Rober, 2026-10-07, about SKSE Menu Framework (Nexus 120352): "a special
// widget that is draggable only in esc menu that opens the main window of
// this".
//
// While the Journal Menu (Esc) is open, a button is drawn over it. A click
// opens SKSE Menu Framework's own Mod Control Panel. A drag moves the button;
// the place is kept in Data/SKSE/Plugins/HotkeyDeck/smf-widget.json. The
// button exists nowhere else, so it can only be moved from the Esc menu.
//
// ── Drawing ─────────────────────────────────────────────────────────────────
// SMF exports RegisterHudElement: a callback it runs inside its own ImGui
// frame, every frame, whether or not an SMF window is open. We draw on the
// foreground draw list through SMF's exported cimgui functions, so the calls
// hit SMF's ImGui context. No PrismaUI view is involved. The icon is the
// deck's own hk-skse-menu.png, loaded through SMF's LoadTexture export.
//
// ── Input ───────────────────────────────────────────────────────────────────
// SMF turns ImGui's mouse OFF unless one of its blocking windows is open
// (Hooks.cpp DisableImGuiInput), so ImGui cannot hit-test this button. We
// hit-test it ourselves against the game's menu cursor. The click comes from
// SMF's exported RegisterInpoutEvent (their spelling): returning true from
// that callback REMOVES the event from the game's input chain, so the click
// that lands on the button does not also click the journal under it. The
// deck's own input sink cannot consume, which is why it is not used here.
//
// ── Opening ─────────────────────────────────────────────────────────────────
// SMF has no export that opens its main panel. The existing, seeded
// MenuActions "open-smf" verb is used: it reads SMF's ToggleKey/ToggleMode
// from SMF's own ini and presses exactly that. The result is VERIFIED with
// SMF's IsAnyBlockingWindowOpened export; a miss is said on the button.
// ---------------------------------------------------------------------------

namespace SmfWidget
{
	// kDataLoaded, main thread. Does nothing when SKSEMenuFramework.dll is not
	// loaded, lacks an export we need, or the sidecar says "enabled": false.
	void Init();
}
