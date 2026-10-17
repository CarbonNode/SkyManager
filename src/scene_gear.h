#pragma once

#include <cstdint>
#include <string>

// Scene gear checker: what a participant of the player's OStim scene is
// wearing RIGHT NOW, sorted into the slots people actually think in (wig,
// earrings, top, bra, stockings, shoes, rings...), with one-press off and on.
//
// The ask (Rober, 2026-10-14): "automatic equipment checker and ability to
// remove while in scene. if you F7 an npc you see their equip, this would same
// show the render, and ability to remove any remaining gear on or off, as well
// as key slots like things where stockings would be, wigs, earrings, rings,
// shoes, tops, bras for easy equipping or unequipping".
//
// HOW IT WORKS. The worn set is read the same way the F7 card reads it - an
// inventory walk with IsWorn(), because a slot read misses anything that is
// not a biped slot. Each worn ARMOUR piece is put in one bucket (see Classify
// in the .cpp: the item's own words first, its biped slot second), so the
// view can show "Stockings: Thigh Highs" whatever slot the mod put them in.
// Off and on are the engine's own ActorEquipManager calls - the same ones the
// F7 card's take-off and the Wheel's equip already use - never an OStim verb,
// so this works on top of OStim's own undress and never fights it.
//
// MEMORY. Everything taken off here is remembered (plugin + local id) per
// participant, so "put back" restores exactly those pieces and nothing else.
// The memory belongs to ONE scene: it is dropped when the scene changes, and
// RestoreAll() puts it all back when the player's OStim thread ends (an NPC
// must not walk out of a scene bare because of a button that was pressed in
// it).
//
// THREADING: main thread only (the Scene page's request path and SKSE tasks).
namespace SceneGear
{
	// {ok, formId?, pieces:[{formId, plugin, name, bucket, mask}],
	//  buckets:[{key, label, worn, items:[name], gone}],
	//  gone:[{formId, plugin, name, bucket}], pieceCount}
	// `sceneGen` is the scene generation the caller holds; a different one than
	// the memory was made under drops the memory first.
	std::string StateJson(RE::Actor* actor, std::uint64_t sceneGen);

	// {op:"off"|"on"|"bucketOff"|"bucketOn"|"allOff"|"allOn",
	//  item?, itemPlugin?, bucket?} -> the fresh StateJson with {ok, msg} folded in.
	std::string ActJson(RE::Actor* actor, const std::string& req, std::uint64_t sceneGen);

	// The player's thread ended: put back what this module took off, once.
	// Main thread (the OStim callback hops over with AddTask).
	void RestoreAll();
}
