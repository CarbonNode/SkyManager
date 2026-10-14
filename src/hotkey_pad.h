#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

/*
 * HotkeyPad — the stored half of the Hotkey Pad (Rober, 2026-10-11: "a
 * configurable resizable calculator like popup - that lets you define buttons
 * that fire that hotkey on press. you can resize the buttons in the UI, and the
 * UI itself, this is useful for like short keyboards or when im not using my
 * macro mouse").
 *
 * The pad itself is view/HotkeyDeck/hud-pad.js on the HUD view; its
 * open/close/Focus/fire runtime lives in main.cpp beside the other HUD-view
 * claimants (Hp* beside Sw*, Td*, Od*). Its settings window is the deck view's
 * hd-padcfg.js, opened from Home > UI Elements. This module owns only the
 * pad's own document and never fires anything: a button names a deck ENTRY id,
 * and main.cpp fires it through FireEntryById — the same verb a trigger key,
 * the Action Bar and the wheel use. The pad implements no mechanics.
 *
 * Storage is the module's own sidecar, Data/SKSE/Plugins/HotkeyDeck/
 * hotkey-pad.json — not a hotkeys.json slice, so OnJsSave's wholesale replace
 * cannot eat it (the config-storage law).
 *
 * Geometry: the pad is a grid of `cols` columns of square cells. A button
 * covers w x h cells (a calculator's tall "+" or wide "0"); `scale` sizes the
 * whole pad, cells and type together. x/y are the pad's top-left corner as a
 * fraction of the screen, so a resolution change keeps it on screen.
 */
namespace HotkeyPad
{
	// A button fires ONE of two things (Rober, same day: "and can be plain
	// keys like home, page up, insert, etc"):
	//   entry — a deck entry id, fired through FireEntryById;
	//   press — a plain key (+ optional Shift/Ctrl/Alt), sent as a real
	//           keypress through FireChord — the Numpad tab's own keys, picked
	//           from the same list (app.js NUMPAD_LAYOUT / hdKeypadKeys).
	struct Press
	{
		std::uint32_t              dik = 0;   // DirectInput scancode; 0 = not a key button
		std::vector<std::uint32_t> mods;      // Shift/Ctrl/Alt DIKs only
		std::string                name;      // the cap's own name ("Home", "PgUp")
	};

	struct Button
	{
		std::string id;      // pad-local id ("b1"), [a-z0-9-], unique in the pad
		std::string entry;   // deck entry id this button fires ("" for a key button)
		Press       press;   // the key this button presses (dik 0 for an entry button)
		std::string label;   // optional override; "" = the entry's own name
		int         w = 1;   // cells across, 1 .. min(kMaxSpan, cols)
		int         h = 1;   // cells down, 1 .. kMaxSpan
	};

	struct Options
	{
		int                 cols = 4;
		float               scale = 1.0f;
		float               x = 0.62f;   // top-left, fraction of screen width
		float               y = 0.30f;   // top-left, fraction of screen height
		bool                stayOpen = true;   // a press keeps the pad up
		bool                pause = false;     // pause the game while it is up
		bool                showKeys = true;   // key hint on each button
		std::vector<Button> buttons;
	};

	inline constexpr int   kMinCols = 1, kMaxCols = 8;
	inline constexpr int   kMaxSpan = 4;
	inline constexpr int   kMaxButtons = 60;
	inline constexpr float kMinScale = 0.6f, kMaxScale = 2.5f;

	// Cached; reads the sidecar on first use. Any thread.
	Options GetOptions();

	// What a pad button fires. False when the pad has no such button. This is
	// the table hpFire is validated against.
	bool TargetFor(const std::string& buttonId, std::string& entry, Press& press);

	// Apply one request and persist. `known(entryId)` says whether the deck has
	// that entry right now; a button naming an unknown entry is refused unless
	// it was already on the pad with that entry (a seeded entry whose mod is
	// missing today must not be wiped by an unrelated edit). Requests:
	//   {op:"set", cols?, scale?, x?, y?, stayOpen?, pause?, showKeys?}
	//   {op:"buttons", buttons:[{id?, entry | press:{dik,mods,name}, label?, w?, h?}]}   full replace,
	//        in order; a missing/duplicate/invalid id gets a fresh one
	//   {op:"add", entry | press:{dik,mods,name}, label?, w?, h?}   append one button
	//   {op:"remove", id}
	//   {op:"reset-layout"}   cols/scale/x/y/flags back to defaults, buttons kept
	// Returns false and a player-facing `error` when nothing could be applied.
	bool Apply(const std::string& requestJson, const std::function<bool(const std::string&)>& known,
		std::string& error);

	// {cols, scale, x, y, stayOpen, pause, showKeys,
	//  buttons:[{id, entry, label, w, h}], limits:{...}} — raw, unresolved.
	std::string OptionsJson();
}
