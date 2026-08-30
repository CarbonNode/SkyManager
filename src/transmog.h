#pragma once

// Transmog tab — restyle a SPECIFIC inventory piece to look like any armor
// the load order ships, without touching the original base record (Rober,
// 2026-08-15: "Fully featured transmog tab … Use mesh framework to show
// previews … Hook to items not base id so it's unique and specific").
//
// MECHANISM (decided by prior research — do not swap it for hooks):
// a pool of 128 placeholder ARMO records + 64 placeholder WEAP records in
// our own ESL plugin (SkyManagerTransmog.esp, HD_TmogSlot000..127 at locals
// 0x800..0x87F and HD_TmogWeap000..063 at 0x880..0x8BF — pool slot i is
// always local 0x800+i; tools/make_transmog_esp.py). Applying a transmog
// RESTYLES one pool record in memory (stats/name/slot mask or weapon data/
// keywords/enchantment copied from the ORIGINAL base; appearance — armor
// addons + world models, or weapon model/icon/1st-person object — copied
// from the DONOR; per-stat OVERRIDES applied last) and then swaps the chosen
// inventory INSTANCE onto the pool base, its ExtraDataList (temper, rename,
// player enchant) riding along. Per-instance by construction; zero render
// hooks — the SOS-style display override breaks strip scenes on this
// OStim+SOES-NG rig, and a live ARMA swap on a real base restyles every
// copy in the world.
//
// STAT EDITS (phase 2, Rober: "item stat editor … must be unique to specific
// item and persistent, not the base id"): a slot carries an optional
// Overrides block (name/value/weight; armor rating; weapon damage/crit/
// speed/reach/stagger), applied AFTER the stat+donor copy so it always wins.
// The donor may be ABSENT ("stats only") — the slot then wears the
// ORIGINAL's own appearance, so a stat-edited piece keeps its look. This is
// the structural fix for the Proteus shape (Papyrus SetBaseDamage on the
// shared base, re-applied from name-keyed JSON): our edited instance is its
// own pool form, keyed by slot, not by base or display name.
//
// PERSISTENCE: the SKSE co-save ('HDTM', record v2 — v1 never shipped, but
// the loader still reads it). Form data is NOT serialized — only the
// per-slot identity specs (plugin name + file-width-masked local id for the
// stat base and the donor), the slot kind, the donor-absent flag and the
// override block — and every active slot is re-restyled at kPostLoadGame,
// before the player can open the inventory. A vanished donor plugin
// degrades honestly: the slot re-styles to the ORIGINAL's own appearance
// (never hollow/invisible) and the row says the donor is gone.
//
// PLAYER-ONLY for v1: SOES-NG tracks NPCs and its EquipObject hook eats
// foreign equips — the pane says so if asked.
//
// THREADING CONTRACT (item_explorer.h precedent): every entry point touches
// engine structures (form arrays, the player's inventory-changes list), so
// main.cpp calls all of them from SKSE tasks only — one thread, no locks.
// InitSerialization() is the one exception: it must run at SKSEPlugin_Load
// time (SKSE requires serialization callbacks registered there).
//
// Bridge (registered in main.cpp): requests tgState/tgList/tgDonors/tgApply/
// tgRevert/tgStats; replies tgStateResult/tgListData/tgDonorsData/
// tgApplyResult/tgRevertResult/tgStatsResult — names disjoint per the deck
// law.

#include <string>

namespace Transmog
{
	// SKSEPlugin_Load-time: registers the plugin's co-save callbacks
	// (SetUniqueID 'HDTM' + save/load/revert). NOTE: SKSE allows ONE set of
	// serialization callbacks per plugin — main.cpp had none before this; if
	// a future feature needs the co-save too, it must share these callbacks
	// rather than register its own.
	void InitSerialization();

	// Re-restyle every active slot from the just-loaded co-save table.
	// Call from the kPostLoadGame branch of the SKSE message handler (forms
	// resolve there; at kDataLoaded no save is loaded yet).
	void OnPostLoadGame();

	// {esp, used, total, active:[{index, kind, statName, donorName, stat:
	// {plugin, formId}, donor:{plugin,formId}, worn, donorMissing, edited,
	// own}]}. esp=false means SkyManagerTransmog.esp is not in the load
	// order — the pane shows the setup card and every verb refuses.
	[[nodiscard]] std::string StateJson();

	// The player's armor AND weapons, PER-INSTANCE: worn/equipped first,
	// then carried. Row = {plugin, formId, ix, name, count, worn, ench,
	// kind:"armo"|"weap", slot (biped mask, armo), wtype (anim type, weap),
	// stats:{ar,val,wt} or {dmg,crit,speed,reach,stagger,val,wt}, tmog}.
	// `ix` is the ordinal index into that base's extra-data lists (-1 = the
	// plain, extra-less remainder of the stack); `name` is the instance
	// display name (carries temper/rename) and doubles as the apply-time
	// checksum. A row whose base is one of our pool forms carries
	// `tmog:{slot, statName, donorName, donorMissing, edited, own}` — it
	// reverts instead of applying; `edited` = overrides active, `own` = no
	// donor (stats-only). Bound weapons are skipped (they re-summon from
	// their spell — nothing durable to restyle or edit).
	[[nodiscard]] std::string ListJson();

	// {q, kind?, slot?, wtype?, limit?} -> {total, items:[{plugin, formId,
	// n, v, w, slot, t?}]}. Searchable catalog of every named, playable
	// TESObjectARMO (kind "armo", default) or TESObjectWEAP (kind "weap") in
	// the load order (lazy one-time walk, the item_explorer Harvest
	// pattern). `slot` (a biped mask) keeps only armor donors overlapping
	// it; `wtype` >= 0 keeps only weapons of that anim type (the weapon twin
	// of same-slot — a bow donor on a sword stat would swing like a sword
	// but LOOK like a bow, so same-type is the picker's default). Weapon
	// rows carry `t` = anim type. Capped at 200 rows per reply with the
	// honest total alongside.
	[[nodiscard]] std::string DonorsJson(const std::string& req);

	// {plugin, formId, ix, name, donorPlugin?, donorFormId?, overrides?} or
	// {slot, overrides} -> {ok, msg, slot}.
	// Three shapes, one verb:
	//  - donor given: the phase-1 restyle (re-resolves the instance, takes a
	//    free pool slot of the right kind — 128 armo / 64 weap — restyles,
	//    swaps the instance, ExtraDataList preserved, re-equips if worn),
	//    with overrides applied last when present.
	//  - donor absent + overrides: STATS-ONLY — allocates a slot whose donor
	//    is the original itself (look unchanged), then applies overrides.
	//  - {slot, overrides}: replaces the override block on an ALREADY-active
	//    slot and re-restyles in place (no inventory mutation). An empty
	//    overrides object clears every edit (stats back to the original's).
	[[nodiscard]] std::string ApplyJson(const std::string& req);

	// {slot} -> {ok, msg}. The inverse swap: pool piece back onto the
	// original base, extras preserved, re-equip if worn, slot freed —
	// overrides cleared with the slot, so a full revert is the original
	// item back, stats included.
	[[nodiscard]] std::string RevertJson(const std::string& req);

	// {plugin, formId} or {slot} -> {ok, kind, slot, name, origName,
	// base:{...stats...}, cur:{...stats...}, ov:{...active overrides...}}.
	// The stat sheet for the ✎ editor: `base` is the ORIGINAL base record's
	// values, `cur` the effective values (the pool record when transmogged,
	// the base itself when not), `ov` the active override block. slot = -1
	// when the item is not pooled yet. Refuses bound weapons.
	[[nodiscard]] std::string StatsJson(const std::string& req);
}
