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
	inline constexpr int kPageCount = 4;
	inline constexpr int kPageBase  = 0;
	inline constexpr int kPageShift = 1;
	inline constexpr int kPageCtrl  = 2;
	inline constexpr int kPageAlt   = 3;

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
			if (kind == "flyout")
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
	// the player switched off. Priority when several are held is shift > ctrl >
	// alt — fixed, so the same combination always lands on the same page.
	int PageForMods(const Config& c, bool shift, bool ctrl, bool alt);

	// Config <-> json for the "hotbar" slice.
	nlohmann::json ToJson(const Config& c);
	void           FromJson(const nlohmann::json& j, Config& out);

	// Seed a first-run bar: 8 empty slots keyed to 1..8, base page on, the three
	// modifier pages present but disabled. Called only when the slice is absent,
	// so it can never overwrite a bar you have already filled in.
	void SeedDefaults(Config& out);

	// Drink the strongest carried potion of the named pool ("heal" | "magicka" |
	// "stamina" | "cure"). The pick happens AT PRESS TIME against the live
	// inventory — that is the whole point of a smart button: it can never grey
	// out because you drank the last of one specific tier. Food and poisons are
	// never candidates. Returns {ok,msg}; a refusal names why. MAIN THREAD ONLY.
	std::string FireSmart(const std::string& ref);

	// Live state for one page, read fresh from the engine. MAIN THREAD ONLY —
	// it touches the player actor, the inventory and the magic caster.
	//   {"page":N,"slots":[{i, kind, ok, label, icon, count, equipped, msg, …}]}
	// A slot whose thing is gone comes back ok=false WITH a reason, because a
	// button that greys out and says why beats one that silently does nothing.
	std::string LiveJson(const Config& c, int page);
}
