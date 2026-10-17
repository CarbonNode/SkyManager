#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Furniture picker: SkyManager's own replacement for OStim's "use the nearby
// bed?" / "which furniture do you want" prompts.
//
// The ask (Rober, 2026-10-14): "can we inject and replace the build picker
// popout for ostim? right now it just says use bed? and picks nearest one, i
// want to be able to pick each bed in the house showing a actual little render
// of the bed. so i can easily pick with distance count, other little furniture
// icons as well."
//
// WHAT OSTIM DOES (OStimNG 7.4, PlayerThreadStarter.cpp + Furniture.cpp, read
// from the source): when a scene starts it either asks "Do you want to use the
// nearby bed?" (Yes/No - only ever the NEAREST bed) or, for a start with no
// chosen scene, "Which furniture do you want" with one button per furniture
// TYPE (the nearest of each). Both go through GameAPI::Game::showMessageBox.
// With UIExtensions.esp loaded - Rober's setup - that is a Papyrus call,
//     int OSKSE.UIExtMessageBox(string Caption, string[] Options)
// whose body shows the caption as a corner notification and opens a plain
// UIExtensions list menu; the int it returns is the index OStim acts on. That
// is why the prompt "just says use bed?".
//
// HOW WE REPLACE IT. We hook the Papyrus VM's DispatchStaticCall (vtable slot
// 0x26, the repo's write_vfunc idiom). A call to OSKSE.UIExtMessageBox whose
// caption is one of OStim's two furniture prompts is NOT dispatched: we keep
// the stack-callback OStim handed us, show our own picker (view/HotkeyDeck/
// furn-pick.html) and, when a choice is made, complete that callback with the
// int OStim expects - the exact contract the Papyrus function would have met.
// Anything else (every other Papyrus call, every other prompt, or any case we
// cannot serve) passes through untouched.
//
// WHICH FURNITURE. OStim's prompts only ever offer the nearest of each type and
// the callback only carries an index, so a bed OTHER than the nearest cannot be
// named through it. The answer is therefore two-step: complete the prompt with
// the closest legal index (Yes for a bed, the matching type for a type list),
// then, once the player's thread exists, call OStim's own
//     OThread.ChangeFurniture(threadID, furnitureRef, "")
// (a no-op when it is already that furniture). Mid-scene (the scene key's
// "change furniture" list) the same call is made at once.
//
// The list itself is built here: every FURN reference in range with a sit,
// sleep, lean or crafting use, then each one asked of OStim's own classifier,
//     OFurniture.GetFurnitureType(ref)  -> "bed" | "chair" | ... | "none"
// so a piece OStim cannot use is never offered. Renders are the deck's
// ItemIcons (Mesh Rendering Framework) of the furniture's BASE model.
//
// THE THIRD PROMPT (Rober, 2026-10-14: "another to intercept would be the one
// where it asks to add other npcs, show their dynamically generated faces / our
// image uploaded faces. searchable as well, adds in npcs from elsewhere"): OStim's
// "Select an actor to add to the scene" (PlayerThreadStarter::handleActorAddingInner)
// lists up to eight nearby eligible actors by NAME, and asks again after each one
// until the answer is None. Our picker shows every loaded person (uploaded portrait
// or facegen render or an initial), the party, and people from other places, and
// takes several at once. People in OStim's own list are answered by index, one
// prompt at a time, from a queue (the repeat prompts are answered silently). People
// OStim's list does not hold are moved next to the player (MoveTo) and joined once
// the thread exists, through the same MigrateThread the Scene tab's roster uses;
// that restart drops the furniture, so a chosen furniture piece is re-applied.
//
// MAIN THREAD for everything except the hook thunk, which only reads its
// arguments and hops over with AddTask.
namespace FurniturePick
{
	// What main.cpp gives us: the picker's own Prisma view.
	struct Host
	{
		std::function<bool()>                        ready;   // view loaded and usable
		std::function<bool(const std::string& json)> show;    // open it with this payload; false = refused
		std::function<void()>                        hide;    // close it and give the cursor back
		// Pictures for actors (formIds): uploaded portrait first, else the deck's
		// facegen head render (queued when missing). Returns
		// {"<hex>":{"portrait":"portraits/x.png","face":"icons/npcs/y.png","pending":bool}}.
		std::function<std::string(const std::vector<std::uint32_t>&)> faces;
	};
	void SetHost(Host host);

	// Hook the Papyrus dispatch and listen for OStim threads. Main thread,
	// kDataLoaded, after SetHost.
	void Install();

	// A save loaded: an open picker is released with its safe default.
	void OnPostLoadGame();

	// {enabled, hooked, ostim, uiext, pending, msg?} - the Settings group.
	std::string StateJson();
	// {key:"enabled", value:bool} -> StateJson with {ok,msg}.
	std::string SetJson(const std::string& req);

	// The view's choice: {key:"default"|"none"|"<ref key>"}.
	void OnPick(const std::string& payload);
	// The view asks whether renders have landed: replies with fpIcons(...).
	std::string IconsJson();

	// True while a picker is up (the render queue treats that like a palette).
	bool Active();
}
