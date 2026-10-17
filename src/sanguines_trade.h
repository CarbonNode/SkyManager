#pragma once

#include <string>

// Sanguine's Trade - An Economy Mod: the Ledger verb.
//
// WHAT THIS IS. Sanguine's Trade runs its whole UI (the Ledger: workers,
// venues, clients, earnings) in its OWN PrismaUI view, opened by the mod's
// Papyrus script ST_PrismaLedger.TogglePrismaLedger() on the quest
// ST_PrismaLedgerQuest. The mod reaches that toggle three ways: its own F6
// hotkey (a StorageUtil value in the co-save, so no file to read it from),
// the "Sanguine's Ledger" lesser power the book grants, and nothing else.
// This module is the fourth: the deck dispatches the SAME toggle, so the
// Ledger gets a searchable, bindable row and the carried book can open it
// instead of being a dead end in search (WheelMenu::Use refuses a book:
// "isn't something you can use from here").
//
// The verb goes THROUGH the mod's own script — never a synthesized F6 (the
// key is rebindable and lives in StorageUtil) and never ST_PrismaBridge's
// native OpenLedger, which skips the state push the script does first.
//
// IDENTITY LAW: every id below is the LOCAL FormID inside the plugin, read
// from the ESP's own BOOK / QUST groups (2026-10-14; the plugin is a full,
// non-ESL plugin whose masters give its FormIDs the 0x04 prefix on disk).
// LookupForm applies the load-order prefix, so the pair survives re-indexing.
// The script class name comes from the quest's VMAD.
//
// THREADING: main thread only (SKSE task), like every engine-touching verb.
namespace SanguinesTrade
{
	inline constexpr const char* kPlugin = "Sanguine's Trade - An Economy Mod.esp";

	// TESDataHandler::LookupModByName(kPlugin) != nullptr, cached after the
	// first call (the load order cannot change mid-session).
	[[nodiscard]] bool Present();

	// Is this (local id hex, plugin file) pair the Sanguine's Ledger BOOK?
	// formIdHex is the wheel/inventory wire form ("0B09CD"); plugin is the
	// owning file name, compared case-insensitively. Pure compare, no engine
	// reads, so any thread may ask.
	[[nodiscard]] bool IsLedgerItem(const std::string& formIdHex, const std::string& plugin);

	// Toggle the Ledger through the mod's own script: opens it when closed,
	// closes it when open (the mod's F6 semantics). Returns {ok, msg}; msg is
	// the honest refusal when the mod is absent, its quest is not running, or
	// the dispatch is refused. The caller closes the deck FIRST — Papyrus runs
	// unpaused only, and the mod itself will not stack the Ledger on a menu.
	std::string ToggleLedgerJson();
}
