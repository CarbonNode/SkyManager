#pragma once

#include <functional>
#include <string>

/*
 * LootFeed (2026-10-12) — the source behind the HUD's loot feed widget
 * (view/HotkeyDeck/hud-lootfeed.js).
 *
 * Rober: "loot notifications maybe top left, where they sort of animation
 * slide in as iharvest picks stuff up? and others fade away (limit
 * configurable)" … "use actual item icons? like hook to inventory".
 *
 * - Every item that enters the PLAYER's inventory (TESContainerChangedEvent,
 *   newContainer = player) is queued while the `lootFeed` widget is on. The
 *   sink only queues; one task per frame drains the queue, folds repeats of
 *   the same item, and pushes ONE `lfPush([...])` to the HUD view.
 * - Each row carries the item's real picture when the deck already rendered
 *   it (ItemIcons::IconPathIfRendered, never queues). Items without one are
 *   remembered and handed to ItemIcons ONLY while the game is paused by a
 *   game menu (inventory, map, pause) — never mid-sweep, because a render is
 *   a 0.2-0.7 s stall of the game thread — and never while the deck itself
 *   is open (it has its own renders to pace).
 * - With the feed on and "hide the game's own lines" set, the game's
 *   "<item> added" HUD notifications are swallowed in HUDMenu::ProcessMessage,
 *   but only a notification that names an item the feed just showed AND
 *   carries the game's own "added" word (GMST sAddItemtoInventory). Anything
 *   else the HUD shows is untouched.
 */
namespace LootFeed
{
	// kDataLoaded, after Widgets::Load(): the container sink + the HUD hook.
	void Install();
	// How a batch reaches the HUD view (main.cpp: Invoke(g_hudView, ...)).
	// Called on the MAIN thread with the full script argument (a JSON array).
	void SetPusher(std::function<void(const std::string&)> push);
	// "Is the deck palette up?" — renders wait for a GAME menu, not the deck.
	void SetPaletteOpenProbe(std::function<bool()> probe);
	// ~1 Hz on the MAIN thread (the widgets beat): hands remembered render
	// wishes to ItemIcons while a game menu has the game paused.
	void Tick();
	// A save loaded: drop anything queued from the previous world.
	void Reset();
}
