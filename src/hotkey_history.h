#pragma once

#include <cstdint>
#include <string>

// What you have actually pressed — a plain reverse-chronological list of every
// hotkey, numpad chord and quick-fire the deck has sent this session.
//
// Why it exists: a deck with sixty entries across six tabs stops being
// answerable from memory. "What did I fire before that went wrong", "do I ever
// use this row", "which key did the wheel end up on" are all questions the deck
// could answer and did not.
//
// ------------------------------------------------------------- what it is ---
// An in-memory ring of the last kMax fires. NOT persisted: it costs nothing,
// cannot corrupt hotkeys.json, and the question it answers is almost always
// about the last few minutes. A restart clears it, and the view says so rather
// than pretending the list is complete.
//
// Consecutive repeats of the SAME entry collapse into one row with a count and
// the latest time — holding a stance key twenty times is one thing you did, not
// twenty things, and twenty identical rows would push everything else off the
// page.
//
// Recording is cheap and lock-guarded, so it is safe to call from the fire
// paths directly (they already hold no locks at that point).
namespace HotkeyHistory
{
	// Where a fire came from, so the list can say WHY something happened —
	// a quick-fire you triggered with a modifier looks identical to a click
	// otherwise, and that is exactly the confusion worth resolving.
	enum class Source
	{
		kEntry,     // a row in the deck (clicked, or picked with the number keys)
		kAction,    // a row whose device is "action" — ran C++, sent no key
		kNumpad,    // the Numpad tab's raw chord
		kQuickFire  // modifier + open key, which skips the palette entirely
	};

	// Longest list kept. Beyond this the oldest fall off.
	inline constexpr std::size_t kMax = 300;

	// Record one fire. `label` is the key as shown on the chip ("Del",
	// "Shift + Z", "Num /"); for an action it is the verb. Empty names and
	// labels are tolerated — the row still reads sensibly.
	void Record(Source source, const std::string& name, const std::string& label,
		const std::string& category);

	// { "ok":true, "sinceLaunch":true, "count":n,
	//   "items":[ { "name":"Weapon Wheel", "label":"Del", "category":"Combat",
	//               "source":"entry", "times":3, "at":"14:02:11", "ago":"2m" } ] }
	// Newest first. `ago` is rendered here rather than in the view so the list
	// does not silently drift while the palette sits open.
	std::string Json();

	// Forget everything. Wired to the page's own Clear.
	void Clear();
}
