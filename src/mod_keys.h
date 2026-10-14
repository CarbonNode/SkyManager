#pragma once

#include <cstdint>
#include <string>
#include <vector>

// "mod-key" deck entries (2026-10-11): ANOTHER mod's own hotkey, as a row in
// the Hotkeys tab. Rober searched the Hotkeys tab for "walk with me" and got
// nothing; he wanted the keys SKSE-menu mods ship "shown as hotkeys in our app".
//
// THE LAW THIS SITS UNDER ("Never open another mod's UI by firing its hotkey and
// hoping"): key synthesis is only right when the mod ships a key FOR that
// purpose and the deck reads it LIVE from the mod's own config at fire time.
// A mod-key entry therefore stores WHERE the key lives, never the key itself:
//
//     { file, section, key, modsKey?, modsKind?, space, mod, where }
//
//   file     - path under Data/SKSE/Plugins, '/' separators ("Wayfarer.ini")
//   section  - the ini/toml [section] (case-insensitive); for a json config,
//              the trail of parent object names joined by " · " exactly as the
//              Keys census writes it
//   key      - the setting that holds the key code ("iCommandKey")
//   modsKey  - optional setting holding the modifier ("iCommandModifiers")
//   modsKind - how modsKey is spelled: "mask" = 1 Shift, 2 Ctrl, 4 Alt,
//              additive (Walk With Me's docs/hotkeys.md). "" = no modifier.
//   space    - "dik" (DirectInput scancode) or "vk" (Windows virtual-key).
//              Only ever a STATED space: the Keys tab offers "Add to Hotkeys"
//              on rows whose code space the census did not have to assume.
//   mod      - display name for messages ("Walk With Me")
//   where    - where the player sets that key, for the refusal sentence
//
// At fire time the value is read again from the file (keys_sources.cpp's own
// parser, so the census and the press can never disagree). Unbound (-1/0/255),
// a vanished file or field, or a code the deck cannot press is REFUSED with an
// on-screen sentence that names the mod's menu - never a silent guess.
//
// Threading: Resolve() is file IO and runs on the fire worker, never on the
// main thread; the press itself goes through main.cpp's FireChord, the same
// play-proven SendInput path every keystroke entry uses.
namespace ModKeys
{
	struct Spec
	{
		std::string file;
		std::string section;
		std::string key;
		std::string modsKey;
		std::string modsKind;
		std::string space = "dik";
		std::string mod;
		std::string where;

		bool Set() const { return !file.empty() && !key.empty(); }
	};

	// The verb a mod-key entry carries in HotkeyEntry::action.
	inline constexpr const char* kAction = "mod-key";

	// Parse + validate a stored spec. False (and `out` untouched) when the
	// object is not a usable spec: a bad path, an unknown space, oversized text.
	bool FromJsonText(const std::string& jsonText, Spec& out);
	// The spec as a JSON object string (for ConfigToJson).
	std::string ToJsonText(const Spec& s);

	struct Press
	{
		bool                       ok = false;
		std::uint32_t              dik = 0;   // DIK scancode to tap
		std::vector<std::uint32_t> mods;      // DIK modifiers held around it
		long                       raw = 0;   // the value read from the file
		std::string                msg;       // refusal sentence (ok == false)
	};

	// Read the binding LIVE from the mod's own config. Worker thread (file IO).
	// `entryName` names the row in a refusal ("Walk With Me: Order wheel").
	Press Resolve(const Spec& s, const std::string& entryName);
}
