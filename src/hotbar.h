#pragma once

#include <cstdint>
#include <string>
#include <vector>

// nlohmann::json is provided by the force-included pch (<json.hpp>) — the sibling
// module headers reference it the same way, without an include of their own.

// Hotbar — a WoW-style action bar that lives on screen while you play (Rober,
// 2026-08-11: "a spell hotbar think like World of warcraft, just a plain action
// bar ... resize, set how many buttons there are, vertical or horizontal (1 or
// two rows) - hotkey each individual one ... shift + alt + control rotating the
// actions (and showing different icons)").
//
// Mechanically it is FollowersHud's twin: a PrismaUI view that is Shown but
// never Focused during play, so input passes straight through to the game and
// the bar costs no mouse. It is Focused only for the reposition/edit mode. The
// VIEW owns nothing durable; C++ owns the whole Config (slice "hotbar") and
// pushes it in — same ownership split as RoomGuard / LootHighlight / the HUD.
//
// WHY IT LIVES IN view/MagicDeck/: its icons are the Spell Deck's icons. That
// folder already holds the 1,913 PNGs extracted from Spell Hotbar 2's atlases
// plus icons/custom/ (the pool the Deck Portal uploads into), and those relative
// paths are PROVEN to render from a view in that folder. A view in a sibling
// folder would have to reach across with ../MagicDeck/icons/…, which is
// explicitly unverified in this codebase (see the Favorites Shelf note: spells
// there kept a glyph rather than risk it). Same folder, same paths, zero risk —
// and the portal's existing icon endpoints serve it for free.
namespace Hotbar
{
	// Hard ceiling on stored slots. The bar DISPLAYS rows*cols of them; the rest
	// stay in the config untouched. That is the whole trick behind resizing being
	// non-destructive: shrinking the bar from 12 to 6 hides slots 7-12, it does
	// not delete them, so widening it again brings your actions back exactly
	// where they were. A resize that silently ate half a bar would be the kind of
	// bug you only notice mid-fight.
	inline constexpr int kMaxSlots = 24;

	// The four pages, in a fixed order that is a CONTRACT with the view and with
	// the input sink: index 0 is what you see with no modifier held, 1/2/3 are
	// the shift/ctrl/alt pages. Storing them positionally (rather than keyed by
	// name) is what lets the sink turn "which modifiers are down right now" into
	// an index with no lookup, on every keypress.
	// 2026-09-13: three two-modifier pages joined (Rober: "more extended
	// hotkeys like alt + key shift + key"). Positional, like the first four —
	// an older file simply grows three disabled pages on load.
	inline constexpr int kPageCount     = 7;
	inline constexpr int kPageBase      = 0;
	inline constexpr int kPageShift     = 1;
	inline constexpr int kPageCtrl      = 2;
	inline constexpr int kPageAlt       = 3;
	inline constexpr int kPageShiftCtrl = 4;
	inline constexpr int kPageShiftAlt  = 5;
	inline constexpr int kPageCtrlAlt   = 6;

	// Flyout bundles (Rober, 2026-08-13: "an action bar set to be a fly out —
	// pops out with a quantifiable amount (3-9?) bundle"). A slot whose kind is
	// "flyout" holds up to this many CHILD slots; its key opens the fan instead
	// of firing, and the view's cycle-then-pause picks the child. One level
	// only — a flyout child is never itself a flyout (FromJson drops it).
	inline constexpr int kMaxFlyItems = 9;

	// One thing you can put on a button. `kind` picks which existing verb runs
	// it — every one of these already exists and is already play-proven, which is
	// the point: the hotbar is a new SURFACE over the deck's actions, not a new
	// implementation of them.
	//
	//   "spell"  -> SpellActions::Cast          (spells, powers, shouts)
	//   "item"   -> WheelMenu::Use              (potions, food, weapons, scrolls…)
	//   "entry"  -> FireEntryById               (deck actions, key chords, vkeys)
	//   "combo"  -> SpellActions::CastSequence  (a Spell Deck combo)
	//   "flyout" -> opens the fan (the CHILD that is then picked fires through
	//               one of the four verbs above — the flyout adds no verb)
	//   "smart"  -> FireSmart (below): "the best potion of X I am carrying",
	//               re-picked at press time. refId names the pool:
	//               "heal" | "magicka" | "stamina" | "cure"
	//   "set"    -> FireSet (below): a GEAR SET — every child equipped in one
	//               press with STB-style hand placement (first weapon or hand
	//               spell right, the next one left, shields and torches left,
	//               a recorded `hand` wins), and STRIPPED on the next press
	//               when all of it is already worn. Children ride `items`
	//               like a flyout's, but may only be "item" / "spell".
	//   ""       -> empty slot
	//
	// Identity is the same durable pair used everywhere else in this plugin —
	// (plugin, localId) resolved through TESDataHandler, with the raw runtime
	// formId as the fallback for dynamic forms. Never store a bare formId and
	// hope: ESL load-order shuffles move them (see the esl-runtime-formids note).
	struct Slot
	{
		std::string   kind;             // "spell" | "item" | "entry" | "combo" | ""
		std::string   plugin;           // source file, e.g. "Skyrim.esm"
		std::uint32_t localId = 0;      // local FormID within `plugin`
		std::uint32_t formId  = 0;      // raw runtime id — fallback only

		// ---- instance identity + hand memory (2026-09-13, STB-style) ------
		// `uniqueId` is the engine's ExtraUniqueID stamped on ONE carried copy
		// — the enchanted / tempered one you bound from the inventory, not
		// "an ebony sword". 0 = any copy (the pre-2026-09 behaviour). The fire
		// path prefers that copy and falls back to any other of the same base
		// form, saying so, rather than greying out: a binding must survive the
		// bound copy being sold and bought back (it gets a new id then).
		std::uint16_t uniqueId = 0;
		// "" = let the engine choose | "right" | "left". Recorded at bind time
		// from the hand you were holding it in, honoured on every press, and
		// the tie-break a gear set uses before its own placement rule.
		std::string   hand;

		// For kind=="entry" / "combo": the deck-side id of the thing to run.
		// Kept separate from the form identity so an entry can never be mistaken
		// for a form (an empty plugin + a real id is a very easy bug otherwise).
		std::string refId;

		// What the button SAYS. Empty = use the live name read from the engine,
		// which is what you want almost always — it follows renames and shows a
		// tempered weapon's real title. A non-empty label is a deliberate
		// override and is never rewritten by a refresh.
		std::string label;

		// View-relative icon path ("icons/custom/fire.png"). Empty = let the view
		// resolve it from the spell's school/element/tier, exactly as the Spell
		// Deck does. Set by the icon picker or from the phone via the portal.
		std::string icon;

		// kind == "flyout" only: the bundle, in fan order, capped at
		// kMaxFlyItems by FromJson. (std::vector of the incomplete Slot is
		// legal since C++17 — the recursion is one level deep by construction,
		// enforced at parse time, not by the type.)
		std::vector<Slot> items;

		bool Empty() const
		{
			if (kind == "flyout" || kind == "set")
				return items.empty();
			return kind.empty() || (kind == "spell" && !localId && !formId) ||
			       (kind == "item" && !localId && !formId) ||
			       ((kind == "entry" || kind == "combo" || kind == "smart") && refId.empty());
		}
	};

	// One page of buttons. `enabled` is Rober's "ability to enable or disable"
	// per modifier: a disabled shift-page means holding shift does nothing at
	// all — the base page stays up and shift keeps whatever meaning the game
	// gives it (sprint, most likely), rather than swallowing the modifier for a
	// bar you never filled in.
	struct Page
	{
		bool              enabled = false;   // page 0 is forced on in FromJson
		std::string       name;              // shown in edit mode; "" = the default
		std::vector<Slot> slots;             // sized to kMaxSlots on load

		// A CUSTOM modifier for this page (2026-09-13, the STB "any key can be
		// the modifier" idea): while this key is held the page is live, on top
		// of (not instead of) the page's own Shift/Ctrl/Alt meaning. code 0 =
		// none. The input sink tracks every held key, so any keyboard key
		// works — "hold Q, press 1". Checked BEFORE the modifier rules, lowest
		// page index first, so a custom key is never out-voted by Shift.
		std::string   modDevice = "keyboard";
		std::uint32_t modCode   = 0;
		std::string   modLabel;
	};

	// A per-slot key binding. `code` 0 = unbound, in which case the button is
	// click-only (it still works — you just have to open the bar's edit mode or
	// click it while another menu holds the cursor).
	struct SlotKey
	{
		std::string   device = "keyboard";   // "keyboard" | "mouse"
		std::uint32_t code   = 0;            // DIK scancode
		std::string   label;                 // what to print on the button corner
	};

	struct Config
	{
		// Master switch. Default OFF, like the Followers HUD — a fresh install
		// must never sprout an overlay nobody asked for.
		bool enabled = false;

		// Shown vs hidden. The toggle key flips THIS; the bar draws only when
		// enabled && visible (and always while editing).
		bool visible = true;

		// Placement, view pixels at scale 1. The stored point is the anchor
		// corner named by anchorH/anchorV, not always the top-left — that is what
		// keeps a bottom-centred bar bottom-centred when the resolution changes.
		int   x     = 0;
		int   y     = 90;
		float scale = 1.0f;

		// Play-mode opacity (0.3–1.0). Edit mode always renders opaque — the
		// view enforces that; this is only the persisted play value.
		float opacity = 1.0f;

		// "horiz" (buttons run left-to-right) or "vert" (top-to-bottom). In
		// "vert" the meaning of rows/cols swaps in the view: `cols` is still the
		// number of buttons along the bar's long axis and `rows` the number of
		// lines beside it, so a 2-row vertical bar is two columns of buttons.
		std::string orient = "horiz";

		// Which screen edge the anchor is measured from. "center" is a real
		// option for anchorH because a centred bar along the bottom of the screen
		// is what almost every action-bar game does, and faking it with a fixed x
		// breaks the moment the window is resized.
		std::string anchorH = "center";   // "left" | "center" | "right"
		// Which screen edge the SETUP PANEL docks to: "left" | "right". NOT the
		// bar's anchor (anchorH above) — the editor's own dock, so the bar can
		// be lined up against the edge the panel is not using.
		std::string side = "right";
		std::string anchorV = "bottom";   // "top"  | "bottom"

		// Shape. cols = buttons per row, rows = 1 or 2 ("vertical or horizontal
		// (1 or two rows)"). cols*rows is clamped to kMaxSlots on load.
		int cols = 8;
		int rows = 1;

		// Chrome toggles.
		bool showKeys   = true;    // the little key legend in each button corner
		bool showLabels = false;   // the name under each button — off by default:
		                           // on an 8-button bar it is noise, and the icon
		                           // is the thing you actually read at speed
		bool showCounts = true;    // stack count for consumables ("x14")
		bool showEmpty  = true;    // draw empty slots as sockets while editing/idle
		                           // — turn off for a bar that shows only what is on it
		bool showPages  = true;    // the Main/Shift/Ctrl/Alt pip strip above the bar.
		                           // Off = no page text at all (Rober, 2026-08-14:
		                           // "hide the MAIN, SHIFT, ETC text") — the modifier
		                           // pages still work, you just fly blind on which one
		                           // is live, which is fine once the muscle memory is in

		// ---- edit-mode placement aids (Rober, 2026-08-14) ------------------
		// All three exist for the same reason: while PLACING the bar you want to
		// see exactly what play mode will show, and the dashed halo / the ✥ grip
		// sitting flush against the bar make a pixel-precise judgement impossible.
		// They only ever affect EDIT mode — play mode never draws any of this.
		bool showOutline = true;   // the dashed halo around the bar while editing
		bool showGrip    = true;   // the ✥ drag handle (arrows + Reset still work
		                           // with it off, so the bar can never be stranded)
		// Where the grip sits relative to the bar: "auto" keeps the 2026-08-13
		// behaviour (below the bar in the top half of the screen, above it in the
		// bottom half, so it never clips off an edge); "top"/"bottom" pin it, for
		// judging the bar's opposite edge against something on screen.
		std::string gripPos = "auto";   // "auto" | "top" | "bottom"

		// Fade the whole bar when you have not touched it. 0 = never fade (always
		// fully opaque). Otherwise the bar drops to `idleAlpha` after this many
		// milliseconds without a press, and snaps back on the next one.
		std::uint32_t idleMs    = 0;
		float         idleAlpha = 0.35f;

		// ---- when the bar is on screen at all ------------------------------
		// Rober, 2026-08-11: "hotkey to toggle hide - show only in combat
		// option?". `showMode` is the AUTOMATIC rule, on top of the manual
		// enabled/visible flags:
		//   "always" — whenever enabled && visible (the default)
		//   "combat" — only while you are in combat (+ `lingerMs` after it ends)
		//   "drawn"  — only while a weapon or spell is drawn
		//   "either" — in combat OR drawn, whichever comes first
		// A bar you cannot see does not fire either (see kEffective note in
		// main.cpp): "only in combat" that still cast Fireball out of combat
		// would be a trap, and hiding it hands 1-8 back to vanilla favourites.
		std::string showMode = "always";

		// How long the bar stays up after combat ends, so it does not blink out
		// between two draugr in the same room. Ignored unless showMode watches
		// combat.
		std::uint32_t lingerMs = 4000;

		// Drop the bar while a menu owns the screen (inventory, map, magic, the
		// console, the deck itself). On by default — an action bar drawn over
		// your inventory is just clutter, and the keys are inert there anyway.
		bool hideInMenus = true;

		// Size of the EDITOR (the panel, the pickers, the key modal) — separate
		// from `scale`, which is the bar itself. Rober, 2026-08-11: "no tiny
		// text impossible to read (without ability to scale)". The bar could be
		// resized from the day it shipped; its settings panel could not, so its
		// type size was whatever it was and that is exactly the trap he means.
		// Clamped 1.0–2.0 here (it only ever makes things BIGGER), and clamped
		// AGAIN in the view against the real
		// viewport so a big number can never push the panel off screen.
		float uiScale = 1.0f;

		// The art. "plain" is the honest default Rober asked for first ("just a
		// plain action bar"); the others are the framed skins. A skin is pure
		// CSS + an optional frame PNG in the view folder, so adding one later
		// needs no DLL change.
		std::string skin = "plain";

		// Bind straight from the game's own menus (2026-09-13, the STB Hotkey
		// System idea): with the inventory, magic menu or favourites open,
		// highlight a row and press a slot's key — that row lands on the
		// button of the page your modifiers select, no editor, no picker. A
		// key pressed on a gear set or flyout ADDS to it instead. Default on;
		// off = slot keys stay inert in menus exactly as before.
		bool menuBind = true;

		// How the modifier pages behave. true (default, and what WoW does) =
		// HOLD the modifier to see and fire that page, release to fall back.
		// false = TAP the modifier to latch that page until you tap it again,
		// for anyone who would rather not hold a key during a fight.
		bool modHold = true;

		// The pages themselves — always exactly kPageCount after FromJson.
		std::vector<Page> pages;

		// Per-slot keys, index-aligned with the slots and SHARED across pages:
		// key #1 fires slot 1 of whichever page the modifiers select. That is the
		// whole point of pages — one row of keys, four rows of actions.
		std::vector<SlotKey> slotKeys;

		// Show / hide toggle key, same shape as every other open key in the
		// plugin. code 0 = unbound, in which case the bar is toggled by the
		// seeded "Action Bar: Show/Hide" deck action instead (which can carry
		// its own trigger key from F2 — the two routes coexist deliberately,
		// because this one is bindable from the bar's OWN editor where you are
		// already standing when you want it).
		std::string   keyDevice = "keyboard";
		std::uint32_t keyCode   = 0;
		std::string   keyLabel;

		// Refresh cadence for the live slot scan (counts, known-spell checks,
		// equipped badges). 0 is not allowed — FromJson floors it.
		std::uint32_t tickMs = 700;

		// How many slots are actually on screen.
		int VisibleSlots() const;
	};

	// Which page index the given modifier state selects, honouring `enabled`:
	// a held-but-disabled modifier falls back to base rather than showing a page
	// the player switched off. Order: a page whose CUSTOM key is held (lowest
	// index first) > the two-modifier pages (shift+ctrl > shift+alt > ctrl+alt)
	// > the singles (shift > ctrl > alt) — most specific first, then fixed, so
	// the same combination always lands on the same page. `customHeld[p]` says
	// whether page p's custom key is down right now; null = none held.
	int PageForMods(const Config& c, bool shift, bool ctrl, bool alt,
		const bool* customHeld = nullptr);

	// Config <-> json for the "hotbar" slice.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Seed a first-run bar: 8 empty slots keyed to 1..8, base page on, the three
	// modifier pages present but disabled. Called only when the slice is absent,
	// so it can never overwrite a bar you have already filled in.
	void SeedDefaults(Config& out);

	// Drink the RIGHT carried potion of the named pool ("heal" | "magicka" |
	// "stamina" | "cure"). The pick happens AT PRESS TIME against the live
	// inventory — that is the whole point of a smart button: it can never grey
	// out because you drank the last of one specific tier. Food and poisons are
	// never candidates. Returns {ok,msg}; a refusal names why. MAIN THREAD ONLY.
	std::string FireSmart(const std::string& ref);

	// ---- how "the right potion" is decided (2026-08-19) -------------------
	// Until this date the answer was simply "the biggest magnitude you carry",
	// which drinks an Ultimate Healing Potion to top off 10 lost HP. The pick
	// is now DEFICIT-AWARE: it measures how much of the pool is actually
	// missing (max - current, the char sheet's own formula) and chooses the
	// least wasteful potion that answers it.
	//
	// Credit where it is due: the idea — and the proof that players want it —
	// comes from wSkeever's "Smart Optimal Salves" and ItzIvy05's SKSE port of
	// its scan. Nothing here is their code; this is our own implementation on
	// our own data path (their scan is a Papyrus native called from an MCM
	// script, ours is the deck's C++ press-time pick), and it goes further:
	// fortify effects can no longer masquerade as restores, regeneration
	// potions are understood, and the emergency rule below has no counterpart
	// there.
	struct SmartPrefs
	{
		// false = the pre-2026-08-19 behaviour (always the strongest potion),
		// kept because it is what a player who never opens the settings had.
		bool optimal = true;
		// May a potion that restores MORE than is missing be drunk at all?
		// Off, a pool with only oversized potions refuses out loud rather than
		// burning one — which is a real playstyle, not a bug.
		bool allowOverheal = true;
		// On: top off completely (the smallest potion that COVERS the deficit).
		// Off: waste nothing (the biggest potion that fits INSIDE the deficit).
		bool preferOverheal = false;
		// Below this percent of the pool, behave as if preferOverheal were on —
		// at 12% health the cheapest sip is not the answer. 0 disables.
		int emergencyPct = 25;
		// Refuse when the pool is already full instead of drinking anyway.
		bool blockWhenFull = true;
		// Potions the picker must never choose, as "plugin|0x……" LOCAL ids
		// (the actor_identity law — a runtime id moves when an ESL is toggled).
		// Counting is deliberately NOT filtered by this: you still carry them,
		// so the widgets still say so; they are simply never auto-chosen.
		std::vector<std::string> exclude;
	};

	// The prefs live in the WIDGETS sidecar (widgets.json, key "smart") because
	// that is where the potion browser that edits them already persists — but
	// they are CACHED here so the picker never calls back into that module.
	// That direction matters: Widgets::AiTick already calls FireSmart, and a
	// reverse call under the other module's lock is how deadlocks are written.
	// Setting them re-resolves the exclusion list on next use. Thread-safe.
	void       SetSmartPrefs(const SmartPrefs& p);
	SmartPrefs GetSmartPrefs();

	// ---- the smart classification, exported (widgets / potion browser) ----
	// The HUD widgets and the paused potion browser count and categorise
	// potions with the SAME pool matcher the smart buttons drink through —
	// these are thin public wrappers over the file-local SmartMatches /
	// SmartFind, never a second copy of the rule (two definitions of "is this
	// a healing potion" would disagree the day one is edited).

	// Does this carried-or-not potion feed the named pool ("heal" | "magicka" |
	// "stamina" | "cure")? outScore ranks it against its own pool (bigger =
	// stronger). Food and poisons never match, detrimental effects never count.
	//
	// ⚠ outScore is NOT a raw magnitude any more (2026-08-19). A potion that
	// restores 5 points a second for 60 s puts back 300, and ranking it by "5"
	// put it below a 25-point sip; the score is now the POINTS RESTORED, and a
	// regeneration potion (one that lifts the HealRate actor values rather than
	// Health itself) ranks in a band below every direct restore because it can
	// never be relied on to answer a deficit right now. Nothing outside this
	// module compares scores ACROSS pools, so a single ordering is enough.
	//
	// Fortify effects are excluded here, which is the bug this note exists for:
	// Fortify Health is the same archetype on the same actor value as Restore
	// Health and differs only by the MGEF's Recover flag (and its
	// MagicAlchFortify… keyword), so before this date a Fortify Health potion
	// was a candidate healing potion — and, being a big number, usually the
	// WINNER. It raises your ceiling; it does not heal you.
	bool PoolMatch(const std::string& ref, const RE::AlchemyItem* alch, float& outScore);

	// How much of `ref`'s pool is missing right now, in points (0 when full or
	// when the pool has no deficit concept, e.g. "cure"). max is
	// GetPermanentActorValue and cur is GetActorValue — the char sheet's own
	// Pool() formula, so the bar you see and the potion you get can never
	// disagree. MAIN THREAD ONLY.
	float PoolDeficit(const std::string& ref);

	// Pool census over the live inventory: how many matching potions are
	// carried (all tiers), and the strongest one's name. MAIN THREAD ONLY.
	struct SmartInfo
	{
		int         total = 0;
		std::string bestName;
		float       bestScore = 0.0f;
	};
	SmartInfo SmartCount(const std::string& ref);

	// What FireSmart WOULD drink right now, without drinking it - the Potion
	// Browser's smart row names the pick beside the gap (Rober, 2026-09-23:
	// "a smart button for like use best potion (to heal my current health
	// gap)"). Same candidates, same prefs, same "already full" rule as the
	// press itself, so the row can never promise a bottle the press refuses.
	// MAIN THREAD ONLY.
	struct SmartPreview
	{
		bool        ok = false;        // a pick exists and the press would drink it
		bool        full = false;      // no deficit - optimal mode refuses to waste one
		std::string name;              // the pick
		float       score = 0.0f;      // what it restores
		bool        overheal = false;
		int         total = 0;         // matching potions carried, all tiers
		std::string why;               // when !ok: the reason, in words
		float       cur = 0.0f;
		float       max = 0.0f;
		float       deficit = 0.0f;
	};
	SmartPreview PreviewSmart(const std::string& ref);

	// Every carried AlchemyItem that is a POTION (not food, not poison) —
	// the widgets' "All" figure. MAIN THREAD ONLY.
	int CountAllPotions();

	// ---- consumable classification (2026-08-15: "Poison support, food,
	// drinks … Hook to campfire fit water as well") -------------------------
	// ONE implementation, shared by the HUD widgets, the potion browser and
	// the character sheet's Pack Check — the same reason PoolMatch exists:
	// two definitions of "is this a drink" would disagree the day one is
	// edited. Everything here is engine-read only; callers respect the same
	// MAIN THREAD ONLY rule as the census functions above.
	//
	//   kPoison — alch->IsPoison()
	//   kWater  — fresh, DRINKABLE water: the exact SunHelm bottle/skin forms
	//             (salt water excluded), plus a narrow name fallback for other
	//             survival mods' waters. Water is also a drink — the Drink
	//             category deliberately INCLUDES water everywhere (pills,
	//             chips, Pack Check); the Water category shows only water.
	//   kDrink  — IsFood() split from solid food by the consumption sound
	//             (ITMPotionUse = the vanilla drink gulp), the VendorItemDrink
	//             keyword when some mod ships one, or a word-boundary name
	//             heuristic (ale/mead/wine/…). Honest belt-and-braces: a mod
	//             food that defeats all three signals counts as food.
	//   kFood   — IsFood() and none of the drink signals
	//   kPotion — everything else (the four pools + "other", as before)
	enum class ConsumableKind
	{
		kPotion,
		kPoison,
		kFood,
		kDrink,
		kWater,
	};
	ConsumableKind ClassifyConsumable(const RE::AlchemyItem* alch);

	// How many DRINKS this water item holds (SunHelm's _SHWaterskin_3 = 3),
	// 0 when it is not fresh water at all. The water census counts drinks,
	// not bottles — a full waterskin is three of them.
	int WaterDrinks(const RE::AlchemyItem* alch);

	// Is SunHelmSurvival.esp in the load order? When it is not, the Water
	// category degrades honestly: the views hide the Water pill/chip/card
	// (name-matched waters still classify as kWater and stay reachable under
	// Drink, which includes water by design).
	bool WaterModPresent();

	// ---- instance-aware item use, gear sets, bind-from-menu (2026-09-13) --
	// All three MAIN THREAD ONLY (inventory walks + the equip manager).

	// Use one item slot: the bound COPY when `uniqueId` names one that is still
	// carried (else any copy of the base form, and the msg says so), equipped
	// into the remembered `hand` when there is one. A plain slot (no uniqueId,
	// no hand) goes through WheelMenu::Use unchanged — the play-proven path
	// stays the play-proven path. Toggle semantics are the wheel's: pressing
	// what you already hold puts it away. Returns {ok,msg,equipped}.
	std::string FireItem(const Slot& s);

	// Equip a whole gear set, or strip it. Every carried child that is not
	// worn is equipped, in order, with hand placement (see the kind table at
	// the top); when EVERY carried child is already worn the press unequips
	// the items instead (spells stay in hand — the engine has no unequip verb
	// for a spell). Returns {ok,msg,equipped} where equipped = the set is now
	// worn. A set with nothing of it in the bag refuses honestly.
	std::string FireSet(const Slot& s);

	// The row highlighted in the OPEN game menu — InventoryMenu (the selected
	// ItemList row: base form + its ExtraUniqueID + the hand it is worn in),
	// MagicMenu (the item card's spell/shout, via SpellActions), FavoritesMenu
	// (the selected favourite, read off the Scaleform list and cross-checked
	// against the menu's own entry array). Answers a slot-shaped object:
	//   {"ok":true,"kind":"item"|"spell","plugin","localId","formId",
	//    "uniqueId","hand","name","source":"inventory"|"magic"|"favorites"}
	// or {"ok":false,"msg"} naming which menu was open and why it could not
	// read it. Never guesses: a menu it cannot read says so.
	std::string HighlightedJson();

	// Which slot kinds a gear set may hold. The parse clamps children to this.
	bool IsSetChildKind(const std::string& kind);

	// Import Skyrim's OWN favourites hotkeys (the vanilla 1-8) onto `page`
	// (2026-09-13, the STB "vanilla migration" idea): spells/shouts/powers from
	// MagicFavorites::hotkeys, items from the ExtraHotkey stamped on the carried
	// copy (which also gives the exact copy + uniqueId). Only EMPTY buttons are
	// filled — a button you built is never overwritten; the reply says what was
	// skipped. MAIN THREAD ONLY. Returns
	//   {"ok":bool,"imported":n,"skipped":n,"names":["…"],"msg":"…"}
	std::string ImportVanillaHotkeys(Config& c, int page);

	// Live state for one page, read fresh from the engine. MAIN THREAD ONLY —
	// it touches the player actor, the inventory and the magic caster.
	//   {"page":N,"slots":[{i, kind, ok, label, icon, count, equipped, msg, …}]}
	// A slot whose thing is gone comes back ok=false WITH a reason, because a
	// button that greys out and says why beats one that silently does nothing.
	std::string LiveJson(const Config& c, int page);
}
