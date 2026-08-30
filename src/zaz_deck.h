#pragma once

#include <cstdint>
#include <string>

#include <json.hpp>

// ZaZ segment of the Animations tab — the deck's hook into ZaZ Animation Pack
// (ZAP 8.0+, ZaZAnimationPack.esm), the OStim segment's structural twin
// (Rober, 2026-08-15: "Animations tab has hook support for ostim with a tab —
// I want the same for my version of Zaz").
//
// What it drives (always ZAP's OWN machinery, never a reimplementation):
//  - DEVICES: every named ARMO in the load order carrying a zbf* keyword
//    (ZAP's own device taxonomy — zbfWornWrist / zbfWornGag / zbfWornCollar…),
//    enumerated at runtime from TESDataHandler so it fits WHATEVER ZaZ variant
//    is installed, grouped by its zbfWorn* keyword. Apply = AddItem + the
//    wardrobe.cpp equip verb (queue/force/applyNow) — ZAP's zbf effect script
//    rides the equip event, so the bound-arms offset etc. is the mod's own
//    doing and fires the moment the game unpauses. Remove = unequip + take the
//    item back out. Free = strip every worn zbf device in one go.
//  - FURNITURE: ZaZ furniture refs (crosses, pillories, poles…) loaded near
//    the player, listed by distance; "use" sends the TARGET through the deck's
//    proven alias engine (NpcActions::SeatOn — SitTarget package at the chair
//    alias), so she walks there and the package holds her through AI
//    re-evaluations. The player is refused honestly (walk up and activate it).
//
// Target rule is the Animations tab's own: the crosshair NPC snapshotted at
// palette open (NpcActions::TargetFormID()), else the player.
//
// Bridge (main.cpp): requests zzGet / zzPoll / zzAct / zzUse / zzLog →
// replies zzOpen / zzState / zzResult (disjoint names, per the deck law).
// All entry points touch engine state — main thread only (AddTask).
namespace ZazDeck
{
	// Reset session caches. Call at kDataLoaded (device list is built lazily on
	// the first open, so a zero-ZaZ load order costs nothing).
	void Init();

	// zzOpen: detection + target + the whole device catalogue (with worn
	// state) + nearby ZaZ furniture.
	std::string OpenJson();

	// zzState: the light live refresh — target + worn keys + furniture.
	std::string StateJson();

	// zzAct: { op:"apply"|"remove"|"free", key?:"Plugin.esm|00ABCD" }.
	// Returns {ok,msg,wornKeys} for zzResult.
	std::string ActJson(const std::string& payload);

	// zzUse: { ref:"0x00123456" } — seat the target on that furniture ref.
	// Returns {ok,msg,close} for zzResult (close:true = the view should close
	// the palette: the walk-over is alias/Papyrus work that only runs unpaused).
	std::string UseJson(const std::string& payload);

	// ---- the ✨ Effects modal's view of the SAME catalogue (2026-08-17) -----
	//
	// Rober wanted ZaZ's restraints available from the quick card too, with
	// rendered mesh icons. That is a second SURFACE, not a second catalogue:
	// everything below reads the one device list BuildDevices() already makes,
	// so the Animations tab and the modal can never disagree about what ZaZ
	// offers. The only thing the modal adds is icons and paging.
	//
	// Two differences from the zz* bridge, both deliberate:
	//  - the target is the person the CARD is about (an explicit formId), not
	//    the Animations tab's crosshair snapshot;
	//  - icons are requested for the VISIBLE PAGE only. Rendering a few hundred
	//    restraint meshes up front is exactly the "huge loading" to avoid, and
	//    ItemIcons is render-once-keep-forever, so a page already seen is free.

	// { present, count, cats:[{cat,count}], devices:[{key,name,cat,worn,icon}] }
	// `icon` is a view-relative PNG path or null. Whole catalogue, unpaged —
	// a few hundred {key,name,cat} rows is small; it is the RENDERS that are
	// expensive, so the view pages and asks for icons per page.
	nlohmann::json EffectsJson(std::uint32_t formId);

	// Toggle one device on a SPECIFIC actor. Returns the effects reply shape
	// { ok, msg, id, on }. MAIN THREAD.
	std::string ApplyTo(std::uint32_t formId, const std::string& key, bool on);

	// Queue MRF renders for these device keys (comma separated, the visible
	// page). Already-rendered keys cost nothing. Returns { ok, msg, queued }.
	// MAIN THREAD.
	std::string RequestIcons(const std::string& keysCsv);

	// True when ZaZ is in the load order — feeds the modal's `anyPresent`.
	bool Present();
}
