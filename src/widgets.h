#pragma once

#include <cstdint>
#include <string>

// nlohmann::json is provided by the force-included pch (<json.hpp>) — the
// sibling module headers reference it the same way, without an include of
// their own.

// Widgets — small always-on HUD readouts riding the EXISTING hotbar overlay
// view (Rober, 2026-08-15: "New widget system for SkyManager, configurable
// from Home Screen tab - ui elements … one or all types of potions + their
// counts … Also lockpicks, gold. Draggable like action bar, resizable, all
// enableable or customizable on which widgets you want").
//
// Three widgets ship: potions (per-pool counts through the smart-button
// classification), gold, lockpicks. They are ADDITIONAL absolutely-positioned
// DOM roots inside view/MagicDeck/hotbar.html — no new PrismaUI view, so the
// VIEW_HTML_ENTRYPOINTS packager trap stays closed and the icons resolve from
// the proven MagicDeck folder.
//
// OWNERSHIP SPLIT. C++ owns the whole config and pushes it in (wgConfig), the
// view edits it and sends it back whole (wgSave) — the RoomGuard/Hotbar shape.
// But the config persists in its OWN SIDECAR,
// Data/SKSE/Plugins/HotkeyDeck/widgets.json (the npc-finder / item-explorer
// precedent), NOT a hotkeys.json slice: sidecars are immune to the OnJsSave
// wholesale-replace trap (the charsheet-portrait loss) and to an old DLL
// dropping a slice it does not know.
//
// THREADING. Load/Save/accessors take the module's own mutex and are cheap.
// Everything that reads the ENGINE (LiveJson, PbListJson, PbUseJson) is MAIN
// THREAD ONLY — the hotbar ticker AddTasks the builds, never reads inventory
// on its worker thread. AnyEnabled() is an atomic snapshot, safe from the
// ticker's own thread.
//
// ---------------------------------------------------------------------------
// THE CONTEXT WIDGETS (Rober, 2026-08-17, after Skyrim Party Sheet SSE 167538:
// "add some new widgets for weather, and cell name and time … i like the idea
// of being able to pin any item as well with a count as a widget … Mount widget
// would be cool too. (health, stamina, etc)").
//
// Five more readouts ride the same wgLive payload — weather, place, clock,
// mount, and the two tracker lists (pins and collectible sets). They are
// ADDITIVE keys on the existing document; a view that does not know them
// ignores them, and a widget that has nothing to say omits its key entirely
// rather than sending zeros (an absent mount is absent, never 0/0 health).
//
// ⛔ THE DIFF-GATE LAW. WgPushLive suppresses a tick whose payload string is
// byte-identical to the last one. That gate is the only thing standing between
// this feature and the 2026-08-16 Action Bar bug, where a 0.1 s countdown made
// every tick differ and the view rebuilt itself several times a second forever.
// So EVERYTHING continuous is quantised at the source here: the clock to whole
// game MINUTES, mount health/stamina to whole points, place to a cached build
// that only changes when the cell or location form changes. An idle player
// standing still produces a byte-identical payload and the view is never
// touched. Anything added later must obey the same rule.
//
// ⛔ AND THE WALK LAW. 2026-08-16 collapsed six inventory enumerations per tick
// into one. The trackers do not add a seventh: pinned/set counts ride the SAME
// walk, and the walk itself is now EVENT-DRIVEN — a TESContainerChangedEvent
// sink (InstallSink) marks the cache dirty, so a player who is not picking
// things up pays ZERO inventory walks, with a 15 s safety resync so a missed
// event self-heals instead of lying forever.
namespace Widgets
{
	// Arm the TESContainerChangedEvent sink that marks the inventory cache
	// dirty. Call ONCE at kDataLoaded, right after Load(). Without it the
	// counts still refresh — on the 15 s safety resync — so a missing event
	// source degrades to "slightly stale", never to "wrong forever".
	void InstallSink();

	// A save just loaded: the pinned/set form resolves and the tracked mount
	// describe the OUTGOING session (a light plugin's runtime ids move with the
	// load order, and the mount handle points at another save's actor). Drops
	// both and forces one inventory rebuild. MAIN THREAD ONLY.
	void OnPostLoadGame();

	// Load the sidecar (idempotent; missing file = defaults). Call once at
	// kDataLoaded, before the ticker starts asking AnyEnabled().
	void Load();

	// Write the sidecar (tmp + rename; unknown top-level keys survive a
	// round-trip so a future field or a hand edit is never eaten).
	void Save();

	// Master switch — the seeded "widgets-toggle" action flips this. Returns
	// the new state so the caller can say it out loud.
	bool ToggleAll();

	// Opening the editor arms the feature: master on, and if every individual
	// widget was off, all three come back (a panel over an invisible feature
	// reads as broken). Persists.
	void ArmForEdit();

	// At least one widget of EITHER family is on — i.e. "does the HUD view have
	// any widget reason to exist". Atomic — readable from the ticker thread
	// without touching the config mutex.
	bool AnyEnabled();

	// ⚠ THE VISIBILITY SPLIT (marker widgets-vis-split, 2026-08-19). The
	// readout STACK and the FREE widgets are independent systems and must never
	// gate each other — `enabled` is the stack's master alone. Ask the half you
	// actually mean; AnyEnabled() is only ever "either of them".
	//   StackEnabled()       — the in-panel readouts, behind that master
	//   FreeWidgetsEnabled() — the Equipped group / quick items / loot lamp,
	//                          each behind its OWN switch
	bool StackEnabled();
	bool FreeWidgetsEnabled();

	// The whole editable config, for the wgConfig push. JSON text.
	std::string ConfigJson();

	// The Time Dial's persisted placement (the Widget shape) for the tdState
	// push — see the timeDial member in widgets.cpp. The dial saves changes
	// back through the ordinary wgSave partial-write road.
	std::string TimeDialJson();

	// The view sent the whole config back (wgSave payload). Clamps + persists.
	void ApplyViewConfig(const std::string& payload);

	// Live counts for every widget: gold (Finance's SEH-guarded read, -1
	// sentinel survives to the view, which shows "?"), lockpicks (a raw
	// inventory-changes walk modeled on ReadGoldRaw), and the four potion
	// pools + the all-potions total through Hotbar's own classification.
	// MAIN THREAD ONLY.
	//
	// THE WHOLE wgLive CONTRACT (every key optional — a disabled widget, or one
	// with nothing to say, omits its key; the view must treat absent as "draw
	// nothing", never as zero):
	//
	//   gold        int             -1 = unreadable, show "?"
	//   lockpicks   int             -1 = unreadable
	//   carry       {cur,max}       ints; -1/-1 = unreadable
	//   potions     {…}             unchanged from 2026-08-15
	//   waterOk     bool            unchanged
	//   weather     { kind:"clear"|"cloudy"|"rain"|"snow", edid:"SkyrimClear" }
	//               absent indoors-with-no-sky and before the sky exists
	//   place       { name, type, interior:bool, world?:"Skyrim",
	//                 kws:["LocTypeInn",…] }
	//               type ∈ inn store home palace temple jail fort barracks
	//                      cave crypt dwemer mine dungeon dragon camp
	//                      stronghold farm mill ship city town settlement
	//                      interior wilderness
	//   time        { h:0-23, m:0-59, txt:"11:42 PM", h24:"23:42", night:bool,
	//                 day:int, month:int (0-based, 7 = Last Seed),
	//                 monthName:"Last Seed", year:int, date:"17 Last Seed, 4E 201" }
	//   mount       { name, riding:bool, hp:{cur,max}, sta:{cur,max},
	//                 img?:"icons/mounts/….png" }        absent = no mount
	//   pins        [ { id, label, icon, n:int, missing:bool } ]
	//   sets        [ { id, label, icon, n:int, goal:int, done:bool,
	//                   questDone:bool, missing:bool } ]
	//               both absent when the configured list is empty
	//
	// ---- ROUND 2 (2026-08-17): the PLAYER's own state ----------------------
	// Closing the gap with Skyrim Party Sheet (SSE 167538, MIT). Six more
	// optional keys, same law: a builder with nothing true to say omits its key,
	// and every continuous number is quantised at the source.
	//
	//   vitals   { hp:{cur,max}, mag:{cur,max}, sta:{cur,max},   whole points
	//              lvl:int, combat:bool,
	//              xp?:{cur,max},        absent when the engine publishes no
	//                                    level threshold yet
	//              shout?:{rem:int, dur:int} }   seconds; ABSENT while the
	//                                    voice is ready (never "0s left"),
	//                                    dur is the largest remaining seen
	//                                    since this cooldown began
	//   effects  [ { name, group, rem:int, dur:int, mag?:int } ]   <= 12 rows
	//              group ∈ buff debuff disease poison (char_sheet.cpp's
	//              EffectGroup vocabulary, same predicate). `rem` is whole
	//              seconds under 100 s and whole MINUTES above it, so a
	//              long buff does not defeat the diff-gate. Permanent
	//              (duration 0), kHideInUI and sub-2 s effects are dropped —
	//              the char sheet is the inspector, this is a HUD.
	//   equip    [ { slot, label, kind, name, formId?, plugin?,
	//                damage?, armor?, count?, ranged?, badges?:[{text}] } ]
	//              slots right, left and — only when something is nocked —
	//              ammo, in that fixed order. kind ∈ weapon shield spell
	//              other ammo empty. A two-hander is NOT drawn twice.
	//              count = -1 means the inventory read failed ("?").
	//   resist   { armor:int, phys:int, fire, frost, shock, magic, poison,
	//              disease, pieces:int, capMagic:85, capPhys:80 }
	//              percentages raw (a fortify can exceed the cap); phys is
	//              Skyrim's own clamp(rating*0.12 + 3*pieces, 0, 80).
	//   survival { present, mod, on:bool, nearHeat, freezing, ambient?:int,
	//              meters:[{id,label,v:int,max?:int,off?:bool}] }
	//              SunHelm's own globals; absent entirely when it is not
	//              installed. `on:false` = installed, MCM switch off.
	//   allies   [ { name, formId?, plugin?, hp:{cur,max} } ]   <= 6 rows
	//              temporary quest allies — NOT followers, NOT summons.
	//              Only built while you are in combat (plus a 6 s linger),
	//              so an idle player pays no actor walk at all.
	//
	// ---- ROUND 3 (2026-08-17): the four Party-Sheet slot widgets ----------
	// (Rober: "four widgets, ripped from this … fourth being one for quick
	// items … use the shouts icons, (shouts should also support powers) …
	// should be able to place anywhere on screen indvidually".) Config grows
	// four FREE widgets — handR, handL, voice, quick — whose Widget placement
	// fields the HUD view finally honours per-widget instead of stacking.
	// Payload changes, same omit-or-tell law:
	//
	//   equip    grows a FOURTH row, slot "voice", ONLY when something is
	//            equipped in the voice slot: { slot:"voice", label, kind:
	//            "shout"|"power"|"lesser", name, formId, plugin,
	//            school?, element?, tier?, cd?:{rem,dur} }. The cd rides the
	//            SAME g_shoutScale latch the vitals chip uses (one latch,
	//            updated idempotently — see VoiceCd). Hand rows with kind
	//            "spell" now also carry school/element/tier, which is what
	//            lets the HUD run the Spell Deck's own icon resolve ladder
	//            (override -> byForm exact -> school/tier generic -> glyph).
	// ---- SEASON (2026-08-31) ----------------------------------------------
	// (Rober: "a season widget would be nice. not sure how to best hook to
	// seasons of skyrim … same suite of configurations, drag, move around,
	// toggle on or off, not apart of other widgets, part of hud widget
	// suite".) A FIFTH free widget, drawn at its own placement like the four
	// slot widgets. One more optional key, same omit-or-tell law:
	//
	//   season   { id:"winter"|"spring"|"summer"|"autumn", name:"Winter",
	//              n:1-4, src:"mod"|"calendar",
	//              month?:int (0-based), monthName?, day?:int, year?:int,
	//              fixed?:true,                 INI pinned to one season
	//              override?:true, overrideName?,  a SetSeasonOverride is live
	//              next?:{ id, name, in:int } }    whole game days
	//            ABSENT when seasons are off, when the mod has not answered
	//            yet, or when nothing can say which season it is — never a
	//            guessed one.
	//
	// ⛔ The season is ASKED, never derived from the month. Seasons of Skyrim's
	// month->season map is INI-driven and mods rewrite it (this rig also runs
	// "Four Seasons - Faster Seasons of Skyrim", which cycles all four seasons
	// three times a year). The source of truth is the mod's own documented
	// Papyrus API — SeasonsOfSkyrim.GetCurrentSeason() / GetSeasonOverride() —
	// dispatched fire-and-forget into a latch; the INI is parsed only for what
	// the API cannot say (seasons off / pinned, and days until the next one),
	// and becomes the ANSWER only when the mod is absent, in which case `src`
	// says "calendar" out loud.
	//
	//   quick    [ { id, name, count, kind, formId, plugin, hk? } ] <= 12 rows
	//            everything the player FAVOURITED in inventory (the game's own
	//            quick items — "we should have source"), counts live off the
	//            SAME event-driven inventory walk (the walk law), hotkeyed
	//            entries first. kind ∈ weapon shield armor ammo potion food
	//            poison scroll book torch ingredient misc.
	//
	// ---- ROUND 4 (2026-08-18): the CUSTOM quick items + the loot lamp -----
	// (Rober: "i want a secondary same exact widget where you can add any item
	// to it. and keybind each specific one if you care to" + "ability to set
	// how many items"; and "shows a different color or something when auto loot
	// or glow is enabled".) Two more optional keys, same omit-or-tell law:
	//
	//   quick2   [ { id, name, count, kind, formId, plugin, missing, hk? } ]
	//            the player's OWN curated list — any carried item, in their
	//            order, each row optionally carrying its own key. Rows are
	//            capped at the config's `quick2.max` (1..16, default 8), so
	//            shrinking the widget HIDES rows instead of eating them (the
	//            hotbar's stored-24-drawn-N law). `missing:true` = the item's
	//            plugin is off / the form is gone; the row says so instead of
	//            reading as "you have none". Counts ride the SAME event-driven
	//            inventory walk as the pins (the walk law — no second walk).
	//   lootstate { glow:bool, auto:bool }
	//            the Loot Vision master and the Auto-Loot master, read through
	//            a provider main.cpp installs (SetLootStateProvider) — this
	//            module never learns what looting is. Absent when no provider
	//            is installed, so an older/partial build draws nothing rather
	//            than two permanently-off lamps.
	// The KIND of a location, in the same closed vocabulary the HUD's place
	// readout and the loc-* icon set use ("inn", "store", "home", "city",
	// "cave", "fort", …; "interior"/"wilderness" when nothing matched). Shared
	// so the Followers roster can icon a follower's current location without a
	// second keyword table to keep in step. MAIN THREAD.
	std::string PlaceKindOf(RE::BGSLocation* loc, bool interior);

	std::string LiveJson();

	// Flip ONE widget's enabled flag by config key ("handR", "voice", "season",
	// "gold", …). Turning a widget on also arms the master switch (a toggle that
	// leaves the feature dark reads as broken). Persists; returns the new
	// state. Unknown key: returns false, changes nothing.
	bool ToggleOne(const std::string& id);

	// ---- the paused potion browser (pb* bridge on the DECK view) ---------
	// Every carried potion (not food, not poison) as
	//   { plugin, formId:"0x……", rt, name, count, value, strength, cat, fx }
	// plus the persisted browser prefs {sort, cat}. MAIN THREAD ONLY.
	std::string PbListJson();

	// Drink one: {plugin, formId, rt?} -> resolve, verify still carried,
	// EquipObject (the wheel's own drink verb — works from the paused
	// palette). Reply {ok, msg, plugin, formId, newCount}. MAIN THREAD ONLY.
	std::string PbUseJson(const std::string& payload);

	// Persist the browser's sort/category prefs into the sidecar's `browser`
	// key. An `ai` key in the payload is peeled off into the Potion AI config
	// (clamped here, never stored as an opaque blob — C++ drinks by it), the
	// rest round-trips into `browser` as before. Returns {ok:true} for pbSaved.
	std::string PbSaveJson(const std::string& payload);

	// ---- Potion AI (2026-08-15: "Automatic potion usage with threshold
	// control. Used before death for magicka, health or stamina.") ---------
	// Config lives in the sidecar's `ai` key:
	//   { enabled, combatOnly, notify, cooldownMs,
	//     stats: { health:{on,pct}, magicka:{on,pct}, stamina:{on,pct} } }
	// pct clamped 5..90, cooldownMs 1000..15000. C++ owns the tick — the view
	// only edits the numbers (through pbSave) and shows them.

	// ---- smart-pick prefs (2026-08-19) -----------------------------------
	// The sidecar also carries a `smart` key — how the smart potion buttons
	// (and therefore the Potion AI, the wheel and the hotbar) choose WHICH
	// potion to drink. Schema and meaning live in hotbar.h's SmartPrefs; this
	// module only persists them and hands them to the picker, because the
	// potion browser is where they are edited. Same peel-and-clamp law as
	// `ai`: they ride pbList out and pbSave in, and are never an opaque blob.
	//
	//   { optimal, allowOverheal, preferOverheal, emergencyPct,
	//     blockWhenFull, exclude:["Skyrim.esm|0x0003EADE", …] }

	// Atomic snapshot for the hotbar ticker's ~300 ms AI beat — readable off
	// the worker thread, same contract as AnyEnabled().
	bool AiEnabled();

	// The seeded "potion-ai-toggle" action flips this. Persists; returns the
	// new state so the caller can say it out loud.
	bool ToggleAi();

	// One AI pass: guards (player alive, game unpaused, combat-only), then
	// health -> magicka -> stamina in priority order, ONE drink per tick
	// through Hotbar::FireSmart (the same pick the smart buttons make).
	// Percent = GetActorValue / GetPermanentActorValue — the char sheet's own
	// Pool() formula, so the AI and the sheet's bars can never disagree.
	// MAIN THREAD ONLY.
	void AiTick();

	// ---- potion combos (2026-08-15: "quick drink multiple potion
	// combination … find these combos in all UI systems") ------------------
	// Data lives in the sidecar's `combos` key:
	//   [{ id, name, icon, items:[{plugin, formId:"0x……", name}] }], cap 8
	// items per combo. Every combo is ALSO a deck entry (id "pcombo-<id>",
	// action "potion-combo:<id>") — main.cpp's EnsureComboEntries() keeps the
	// two in step, which is what makes a combo bindable in F2, slottable on
	// the hotbar, pinnable to the wheel/shelf and findable in omni for free.

	// The saved combos as JSON text (the sidecar shape above). Cheap; takes
	// the config lock.
	std::string CombosJson();

	// Replace the whole combo list from the view (pbCombo {op:"save"}).
	// Clamps: 8 items per combo, combos without an id get a stable slug
	// minted, icons must be view-relative icons/… paths. Persists. Returns
	// {ok:true, combos:[…]} for pbComboResult.
	std::string ApplyCombosJson(const std::string& payload);

	// Drink every still-carried item of the combo, one EquipObject each, in
	// one pass (potions stack instantly; nothing here needs spacing). The
	// reply's msg is the honest summary ("drank 3 of 4 — out of …"); missing
	// everything is a refusal, not a silent no-op. MAIN THREAD ONLY.
	std::string FireComboJson(const std::string& id);

	// ---- custom quick items (round 4, 2026-08-18) --------------------------
	// The config lives in the sidecar's widgets.quick2:
	//   { …the ordinary Widget placement fields…, max:int 1..16,
	//     items:[ { plugin, formId:"0x……", name,
	//               keyDevice?:"keyboard"|"mouse", keyCode?:int, keyLabel? } ] }
	// Identity is plugin + LOCAL formId, file-width masked, resolved through
	// TESDataHandler::LookupForm — never a runtime id.

	// Use / equip one custom quick item. Payload
	//   { plugin, formId, notify?:bool }
	// Resolves ESL-safely, verifies it is still carried, then takes the verb
	// the item's TYPE deserves: EquipObject for a potion/food/poison (the
	// wheel's own drink verb), for weapons/armour/ammo/scrolls/ingredients and
	// for a carryable light. Anything else is REFUSED out loud — a button that
	// silently does nothing is worse than one that says why. Reply
	//   { ok, msg, plugin, formId, newCount? }
	// MAIN THREAD ONLY.
	std::string Quick2UseJson(const std::string& payload);

	// Everything the player is CARRYING right now, for the item picker:
	//   { rows:[ { name, count, kind, formId, plugin } ], capped:bool }
	// Named, plugin-resolvable items only, sorted by name, capped at 400 rows.
	// One inventory walk ON DEMAND — deliberately NOT the live tick's cached
	// walk, which admits only what the widgets need. MAIN THREAD ONLY.
	std::string Quick2CatalogJson();

	// Input-sink lookup: does a bound custom quick item own this key? Returns
	// the {plugin, formId} payload for Quick2UseJson, or "" for no match. Only
	// the rows the widget actually DRAWS (the first `max`) can match — the
	// hotbar's law that the keys follow the picture. Cheap; takes the module
	// lock only. Safe from the input thread.
	std::string Quick2ForKey(bool isKb, bool isMs, std::uint32_t idc);

	// ---- the loot status lamp (round 4, 2026-08-18) ------------------------
	// Loot Vision's master lives in main.cpp's hotkeys.json slice and
	// Auto-Loot's behind its own provider, so this module cannot read either
	// one itself. main.cpp INSTALLS a reader at startup instead (the keys-scan
	// provider precedent) and the live tick calls it with NO lock held.
	// A capture-less lambda converts to this; pass nullptr to uninstall.
	using LootStateFn = void (*)(bool& glow, bool& autoLoot);
	void SetLootStateProvider(LootStateFn fn);

	// Weather tab (weather_hub.cpp): the season latch the HUD widget already
	// keeps, as JSON ("null" when nothing can say), and Seasons of Skyrim's
	// own SetSeasonOverride / ClearSeasonOverride (n = 0 clears). Papyrus,
	// fire-and-forget: it runs once the game is unpaused, and the mod applies
	// it at the next interior -> exterior transition. MAIN THREAD.
	std::string SeasonStateJson();
	bool        SetSeasonOverride(int n);
}
