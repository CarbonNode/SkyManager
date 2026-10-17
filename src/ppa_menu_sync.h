#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Keeping PPA's SKSE Menu Framework copy of its settings in step with the toml.
//
// THE BUG (proven 2026-10-14 from both logs, SMF 3.x source and a disassembly of
// AccuratePenetration.dll): a value the deck's Scene -> PPA panel wrote (and PPA
// reloaded) was put back the next time the deck closed:
//
//   SKSE Menu Framework, Renderer.cpp ProcessOpenClose: EVERY keyboard Escape
//   event (press and release, menu open or not) calls WindowManager::Close(),
//   which broadcasts kCloseMenu to every AddEvent listener. Escape is how the
//   deck closes, and how the pause menu opens, so that event fires constantly.
//
//   PPA, ModMenu::EventListener: on kCloseMenu, if any of its tracked settings'
//   LIVE value (what its Reload key refreshes) differs from its MENU copy (set at
//   startup and by its own SMF widgets, never by a reload), it logs "SKSE Mod
//   Menu closed with unsaved changes. Saving..." and writes the MENU copy of
//   every tracked setting into the toml, then reloads it.
//
// So any tracked setting changed on disk + reloaded is reverted on the next
// Escape anywhere. Tracked = PPA's own General / Hotkeys / Debug / SoundEffects
// pages (Penis.ClipFix or Animation.HipPhysics are not tracked, which is why
// those survived). The deck cannot stop SMF's broadcast (it fires from SMF's
// input hook before anything of ours sees the key, and Escape outside the deck
// fires it too), so the fix is to make PPA's menu copy agree with the file
// whenever the deck writes the file: PPA then has nothing "unsaved" to write
// back, and if its reload had not landed yet, its own save applies OUR value.
//
// PPA's settings list (closed source; layout read out of the rig's DLL, banner
// "AccuratePenetration v0-3-7-0", sha256 7273cac8… — its IsDirty loop, the entry
// constructor and Save's value visitor): one global
// std::vector<Entry>, sizeof(Entry) == 0xC8:
//   +0x00 std::string section      ("SoundEffects")
//   +0x20 std::string subsection   ("ClapImpulse", or empty)
//   +0x40 std::string key          ("CheekDelay")
//   +0x60 std::string label        ("Cheek Stagger Delay")
//   +0x80 std::string (empty)
//   +0xA0 std::variant<bool*, int*, float*>  live value   (index byte +0xA8)
//   +0xB0 std::variant<bool,  int,  float >  menu copy    (index byte +0xB4)
// The global is not exported, so it is FOUND (scan the DLL's writable sections
// for a vector whose every element decodes like this and that holds
// Debug.Logging) and the scan FAILS CLOSED: none, or two different, means no
// sync, and the panel says so. A PPA that changes the layout fails the checks.
//
// This file is pure (memory goes through the Read/Write callbacks), so it is
// compiled and exercised off-rig by tools/ppa_menu_sync_selftest.cpp.
// ---------------------------------------------------------------------------

namespace PpaMenuSync
{
	using ReadFn = bool (*)(void* dst, std::uintptr_t src, std::size_t n);
	using WriteFn = bool (*)(std::uintptr_t dst, const void* src, std::size_t n);

	constexpr std::size_t kEntrySize = 0xC8;
	constexpr std::size_t kOffSection = 0x00, kOffSub = 0x20, kOffKey = 0x40, kOffLabel = 0x60, kOffSpare = 0x80;
	constexpr std::size_t kOffLivePtr = 0xA0, kOffLiveIdx = 0xA8, kOffMenu = 0xB0, kOffMenuIdx = 0xB4;

	enum class Type : std::uint8_t { Bool = 0, Int = 1, Float = 2 };

	struct Region  // one writable section of AccuratePenetration.dll
	{
		std::uintptr_t start = 0;
		std::size_t    size = 0;
	};

	struct Entry
	{
		std::string    section, sub, key, label;
		Type           type = Type::Bool;
		std::uintptr_t liveAddr = 0;  // what PPA runs on (its Reload refreshes it)
		std::uintptr_t menuAddr = 0;  // what PPA SAVES on an SMF close
		std::uint32_t  liveBits = 0, menuBits = 0;

		// "Section.Key" or "Section.Sub.Key": the toml path, as the deck names it.
		std::string Path() const { return section + (sub.empty() ? "" : "." + sub) + "." + key; }
	};

	// Address of the std::vector header, or 0 (why says which: none, ambiguous).
	std::uintptr_t Locate(const std::vector<Region>& regions, ReadFn read, std::string& why);

	// Decodes every element of the vector whose header sits at `slot`. false
	// (with why) when it no longer reads as PPA's settings list.
	bool ReadEntries(std::uintptr_t slot, ReadFn read, std::vector<Entry>& out, std::string& why);

	// The file's literal value text -> the bits PPA keeps for that type. false
	// when the text is not that type (a bool setting holding "1", an int holding
	// "1.5"): such a row is left alone.
	bool Encode(Type type, const std::string& text, std::uint32_t& bits);

	// Writes the file's value into PPA's menu copy for every tracked setting
	// whose toml path is in `fileValues` and whose menu copy differs from it.
	// Returns the paths written; `failed` gets paths whose write faulted.
	std::vector<std::string> SyncFromFile(const std::vector<Entry>& entries,
		const std::map<std::string, std::string>& fileValues, WriteFn write, std::vector<std::string>* failed = nullptr);
}
