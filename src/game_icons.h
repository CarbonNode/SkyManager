#pragma once

// GameIcons — which SkyUI / I4 inventory icon (and tint) the game gives an item,
// so the Inventory tab can draw "game icons" instead of model renders
// (Rober, 2026-10-10: "toggle to switch to skyrim default icons").
//
// Two halves, the same two the game has:
//  1. SkyUI's default icon setter (InventoryDataSetter.as + InventoryIconSetter.as
//     in schlangster/skyui), ported: form type + sub type + weight class pick an
//     iconLabel and an iconColor in skyui/icons_item_psychosteve.swf.
//  2. Inventory Interface Information Injector's rule engine (Exit-9B/
//     InventoryInjector, MIT), ported: SKSE/Plugins/InventoryInjector/<plugin>.json
//     for every ACTIVE plugin, in load order. Same two passes as I4's
//     CustomDataManager::ProcessEntry: every matching rule's non-icon data first
//     (subType, subTypeDisplay), the default icon re-derived if any of that
//     matched, then every matching rule's iconSource/iconLabel/iconColor, later
//     rules winning. Same property semantics (a repeated key in one rule keeps
//     only its LAST value, as I4's map does; `anyOf` objects; {min,max} ranges;
//     keywords by editor id; parts/mainPart on the biped mask).
//
// The pictures are NOT made here — a SWF cannot be read at runtime. The rig tool
// scripts/rig/game-icons/export_game_icons.py bakes every labelled frame into
// Data/PrismaUI/views/HotkeyDeck/icons/game/<slug>/<label>.png (white + alpha;
// the view tints it with a CSS mask, proven in Ultralight 2026-10-10). Path()
// answers "" when that file is not on disk, and the view falls back to renders.
//
// MAIN THREAD ONLY (rules load lazily on first use and read forms).

#include <cstdint>
#include <string>

namespace RE
{
	class TESBoundObject;
	class ExtraDataList;
}

namespace GameIcons
{
	struct Instance
	{
		bool equipped = false;
		bool stolen = false;
		bool enchanted = false;
		bool poisoned = false;
		int  soul = -1;       // contained soul level for a gem instance, -1 = base's
		std::int32_t value = 0;
		float        weight = 0.0f;
		float        damage = -1.0f;
		float        armor = -1.0f;
	};

	struct Icon
	{
		std::string   path;       // "icons/game/<slug>/<label>.png", "" = no picture on disk
		std::string   label;      // the frame label SkyUI/I4 chose
		std::string   source;     // the SWF, as rules spell it
		std::uint32_t color = 0xFFFFFF;
		std::string   display;    // I4 subTypeDisplay ("$Ore" -> "Ore"), "" = none
	};

	// The icon the SkyUI inventory would draw for this item instance.
	Icon For(RE::TESBoundObject* obj, const Instance& inst);

	// True once the rig export has run (icons/game/index.json is on disk).
	bool Available();

	// "<n> rules from <m> files" — for the pane's status line and the log.
	std::string Summary();
}
