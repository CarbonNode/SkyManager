#pragma once

#include <cstdint>
#include <functional>
#include <string>

/*
 * Bestiary — the monster log (Rober, 2026-10-08: "a really cool monster log,
 * where you can hit a button when hovering over a killed creature and you get a
 * really cool visually stunning book UI … stats and rating it … categorization of
 * types (would support all modded creatures) … our own openrouter api connection
 * … regional data"; then "would want this to work without chim").
 *
 * What this module owns:
 *   - a TESDeathEvent sink: every actor the player (or a follower) kills is
 *     MEASURED at the moment of death, off the dying actor itself, and written
 *     into the book: stats, resistances, AI temper, combat style, soul, body,
 *     death items, where it fell (hold + place), and a tally/log row;
 *   - "Study": the creature under the crosshair, dead or alive, measured into
 *     the book without a kill (the "hover and press a key" ask);
 *   - the sidecar bestiary.json beside hotkeys.json (atomic write + .bak; never a
 *     hotkeys.json slice — the OnJsSave trap);
 *   - the state the view draws (hd-bestiary.js, window.bxState / bxEntry);
 *   - the Scribe's settings, and the OpenRouter key, which lives ONLY in
 *     SkyManager.ini [Bestiary] and is never sent up to the view (a masked tail is).
 *
 * Kind identity. One page per KIND: the race's EditorID + the display name, so a
 * Frost Troll and an Armored Frost Troll are two pages that share a family (the
 * race) and list each other as variants. Durable across load-order re-indexing
 * because it is built from EditorIDs and names, never a runtime FormID.
 *
 * Threading. The death sink fires on the main thread; measuring happens there
 * (engine reads stay on the main thread). bestiary.json is written two seconds
 * after the last change, serialised under the lock and written on a worker;
 * kSaveGame and the deck's close flush it at once.
 * StateJson / Study / Scribe run as SKSE tasks on the main thread. Every entry
 * point runs inside a guard: a malformed book costs an answer and a log line,
 * never the game.
 *
 * Honesty. A field the engine cannot answer is left OUT of the JSON; the view
 * says "not read yet" instead of guessing (the deck's evidence-not-inference law).
 */
namespace Bestiary
{
	// main.cpp injects PushToView: (window function name, JSON payload).
	using PushFn = std::function<void(const char*, const std::string&)>;
	void SetPush(PushFn fn);

	// Register the death sink, and the combat + hit sinks that time your
	// fights for the page's records. Call once at kDataLoaded.
	void Install();

	// kPreLoadGame: drop the per-save caches (what-works answers read against
	// the outgoing player's perks, open fights). Any thread.
	void OnPreLoad();

	// Write bestiary.json now if a debounced save is pending (kSaveGame, the
	// deck's close). Writes are otherwise batched two seconds after a change.
	void Flush();

	// main.cpp's ItemIcons batch-done hook: a render landed - forget the cached
	// "no picture" answers, bump rev, and answer any turntable still baking
	// with a fresh bxSpinState. Main thread.
	void OnRendersLanded();

	// The whole book for the view: {player, scribe, chapters, totals, latest,
	// entries:[…]}. Main thread.
	std::string StateJson();

	// Measure the actor under the crosshair into the book (no kill counted) and
	// return its entry id, or "" with a reason in `why`. Main thread.
	std::string StudyCrosshair(std::string& why);

	// bxScribe {op:'save'|'test'|'remove', key?, model, voice, length, codex, chim,
	// auto, spoilers} → the JSON for window.bxScribeResult. Main thread; a test
	// or a lore request goes out on a worker and answers through the callback.
	std::string ScribeOp(const std::string& json);

	// bxLore {id, rewrite} — ask the Scribe for this page (worker thread; the
	// finished page arrives as window.bxEntry). Returns the entry as it stands
	// now ("writing"). Main thread.
	std::string Lore(const std::string& json);

	// bxEdit {id, set:{field:value}, unset:[field], notes?, lesson?, everywhere?} —
	// the reader overrides ANY field the page draws (kept beside the measurement,
	// so each one reverts), writes their own notes, and teaches the Scribe a
	// correction for this page or for every page. Returns the entry. Main thread.
	std::string Edit(const std::string& json);

	// bxLesson {op:'add'|'edit'|'remove', index, text} — the Scribe's lessons,
	// fed into every lore request. Returns the bxScribeResult JSON. Main thread.
	std::string Lesson(const std::string& json);

	// bxShelf {op:'save', chapter:{id?, name, icon, blurb}} | {op:'delete', id} -
	// the reader's own chapters, kept in the book as "shelves" (id "my-<n>"); a
	// page joins one through bxEdit set.chapter. Deleting one sends its pages back
	// to the kind the engine gave them. Returns the whole book (bxState). Main thread.
	std::string Shelf(const std::string& json);

	// bxStudy {formId} — the F7 card's "Add to the Bestiary": measure that actor,
	// start the Scribe if there is a key and no page yet. Returns {ok,id,fresh,
	// writing,why}. Main thread.
	std::string Study(const std::string& json);

	// The actor Study aims at (crosshair now, else the palette snapshot); 0 and a
	// reason when there is none. Main thread.
	std::uint32_t AimedActor(std::string& name, std::string& why);

	// bxSpin {id} — bake the page's 45-degree turntable frames, and answer at
	// once with bxSpinState {id, frames:[angles on disk], total:8, baking}
	// (no bake when all eight already exist). Main thread.
	void Spin(const std::string& json);

	// bxRender: queue the portraits pages are missing (no StateJson build). Main thread.
	void EnsureRenders();

	// The F7 target's page, if its kind already has one: {id, name, slain,
	// studied, tier, img?} as JSON, else "". Main thread.
	std::string PeekJson(std::uint32_t actorFormId);

	// bxSound {name} — open/close/page/pageback/write/new, each a vanilla sound
	// descriptor (Skyrim.esm). Main thread.
	void Sound(const std::string& name);

	// Deck action ids this module answers ("bestiary-open", "bestiary-study").
	bool IsAction(const std::string& action);
}
