#pragma once

#include <cstdint>
#include <string>

// ============================================================================
//  Who a stored row IS — the one place the deck decides that.
// ============================================================================
//
// THE BUG THIS FILE EXISTS FOR (proven 2026-08-02, Elana Darkfire).
// Follower Organizer's Deck API hands us `std::format("0x{:08X}", GetFormID())`
// and NO plugin at all, so every deck surface that filed someone away wrote a
// RUNTIME FormID with an empty plugin into hotkeys.json. On a light plugin that
// id is `0xFE | smallFileCompileIndex<<12 | localId`, and the small-file index
// is just her plugin's POSITION among the load order's light plugins — this rig
// has 4,004 of them. Enable or disable one ESL ahead of hers and every stored id
// after it moves by 0x1000.
//
// That is exactly what happened: one live hotkeys.json held Elana twice, under
// two ids one light-slot apart —
//   wardrobe.assignments[] : 0xFECEE81A   (stale; the load order she was filed in)
//   nffOutfits.npcs[]      : 0xFECED81A   (current; FO's live roster agrees)
// — so she rendered as TWO people, and every op keyed on the stale one refused
// with "Couldn't find that person in the game right now".
//
// THE RULE, therefore: a stored identity is (LOCAL FormID + defining plugin).
// That pair survives any load-order change, because TESDataHandler recomposes
// the runtime id from the plugin's CURRENT index every time it is asked.
//
// TRAP inside TESDataHandler::LookupFormID (read it — it is 8 lines):
//     formID  = file->compileIndex << 24;
//     formID += file->smallFileCompileIndex << 12;
//     formID += a_localFormID;              // <- ADDS. It does not mask.
// Hand it a FULL runtime id together with a plugin and the file's own prefix is
// added ON TOP of the one already in the id — it addresses nothing, silently.
// Resolve() therefore masks to the file's own local width (0xFFF for a light
// plugin, 0xFFFFFF otherwise) BEFORE the lookup, which leaves a bare local id
// untouched and repairs a full one.
//
// A dynamic form (0xFF……, spawned this session) has no source file and so has
// no durable identity at all; DurableOf() reports that honestly instead of
// inventing one.
namespace ActorIdentity
{
	// "0x81A" — the spelling every config and every bridge payload uses.
	std::string   HexOf(std::uint32_t v);
	std::uint32_t ParseHex(const std::string& s);

	// ⛔ NEVER call RE::TESForm::GetLocalFormID() DIRECTLY. Use these.
	//
	// CommonLibSSE-NG's implementation is, verbatim:
	//     auto file = GetFile(0);
	//     RE::FormID fileIndex = file->compileIndex << (3 * 8);   // <- UNCHECKED
	//     fileIndex += file->smallFileCompileIndex << ((1 * 8) + 4);
	//     return formID & ~fileIndex;
	// and GetFile(0) returns NULL for any form with no source file — i.e. every
	// DYNAMIC form (FormID 0xFF……): an NPC a mod spawned this session, a
	// player-enchanted item, a record DFG minted at runtime. The read then lands
	// on TESFile::compileIndex at offset 0x478 through a null pointer.
	//
	// PROVEN 2026-08-03, crash-2026-08-03-19-16-41: a spawned "Traveling Pilgrim"
	// (ref 0xFF004400, base 0xFF004401, ParentCell already gone) walked into a
	// guarded inn room, RoomGuard's per-occupant exemption check built an NpcRef
	// for her, and the game died at HotkeyDeck.dll+0144102 —
	// `movzx edx, byte ptr [rax+0x478]` with RAX = 0.
	//
	// LocalIdOf  — the DURABLE plugin-local id, or 0 when the form has none.
	//              0 means "there is no durable identity here"; a caller must not
	//              treat it as an id (RoomGuard::NpcRef::valid() already doesn't).
	// BestIdOf   — the same, but falls back to the full runtime FormID, for the
	//              surfaces that would rather address a dynamic form for THIS
	//              session than not address it at all.
	// Both tolerate a null form.
	std::uint32_t LocalIdOf(const RE::TESForm* form);
	std::uint32_t BestIdOf(const RE::TESForm* form);

	// Resolve a stored pair to the live form. An empty plugin falls back to a
	// raw runtime lookup, because that is what older configs (and the crosshair
	// snapshot, which only ever has a runtime id) hand us.
	RE::TESForm* Resolve(const std::string& formId, const std::string& plugin);
	RE::Actor*   ResolveActor(const std::string& formId, const std::string& plugin);

	// The durable identity of a live form. False = it has none (dynamic form,
	// or no source file), and the caller must keep whatever it already had.
	bool DurableOf(const RE::TESForm* form, std::string& outFormId, std::string& outPlugin);

	// Rewrite a stored pair into its durable spelling. True = it changed, so the
	// caller knows to persist. A pair that does not resolve is left ALONE — a
	// stale id is still the only clue to who she was, and the name-repair pass
	// upgrades it from a live roster later.
	bool Canonicalise(std::string& formId, std::string& plugin);

	// The same, for an ACTOR whose name we already know — and the safe one to
	// reach for. A stale light-plugin id does not merely fail: index<<12 lands it
	// in a DIFFERENT plugin's slot, where local 0x81A is somebody else entirely.
	// Canonicalising that would write the stranger's durable pair over her row
	// and make the mistake permanent (and then dress him). This refuses unless
	// the pair resolves to an Actor and, when `expectedName` is non-empty, to the
	// right one. True = the pair changed.
	bool CanonicaliseActor(std::string& formId, std::string& plugin,
		const std::string& expectedName);

	// True when the pair resolves to an actor who is demonstrably NOT this
	// person — worth a log line, because it means a row has been pointing at a
	// stranger and any op fired from it went to him.
	bool ResolvesToStranger(const std::string& formId, const std::string& plugin,
		const std::string& expectedName);

	// The comparison key. Case-folded, and resolved to the durable pair first
	// where it can be, so a row that arrived spelled as a runtime id matches the
	// row stored as (local + plugin). THIS is what every "is it the same person?"
	// test in the deck must use — never raw string equality on formId.
	std::string Key(const std::string& formId, const std::string& plugin);
}
