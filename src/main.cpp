#include "PrismaUI_API.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <unordered_set>
#include <utility>

#include "finance.h"
#include "icon_bridge.h"
#include "wardrobe.h"
#include "item_icons.h"
#include "wheel.h"
#include "nff_outfits.h"
#include "follower_deck.h"
#include "live_api.h"
#include "fertility_bridge.h"
#include "mhiyh_control.h"
#include "chim_control.h"
#include "nff_bridge.h"
#include "nff_bases.h"
#include "nff_control.h"
#include "preset_bridge.h"
#include "gear_bridge.h"
#include "hotkey_history.h"
#include "aim_actions.h"
#include "formation_actions.h"
#include "menu_actions.h"
#include "vkey_bridge.h"
#include "anim_resolver_bridge.h"
#include "controls_fix.h"
#include "time_actions.h"
#include "npc_actions.h"
#include "save_actions.h"
#include "fix_actions.h"
#include "place_actions.h"
#include "container_actions.h"
#include "door_actions.h"
#include "portal_host.h"
#include "portrait_capture.h"
#include "quest_tools.h"
#include "relationship.h"
#include "ask.h"
#include "room_guard.h"
#include "loot_highlight.h"
#include "keys_scan.h"   // Keys tab: the load-order hotkey census (kc* bridge)
#include "no_auto_gear.h"
#include "spid_gear.h"
#include "actor_identity.h"   // sg* handlers parse durable npc/item ids
#include "quick_light.h"
#include "char_sheet.h"   // Character Sheet tab: live player stats + RP meta (ps* bridge)
#include "facelight.h"
#include "followers_hud.h"
#include "hotbar.h"
#include "anim_actions.h"
#include "ostim_deck.h"
#include "follower_tune.h"
#include "scene_stage.h"
#include "sharmat.h"
#include "spell_actions.h"

using json = nlohmann::json;

namespace
{
	PRISMA_UI_API::IVPrismaUI1* g_prisma = nullptr;
	PrismaView                  g_view = 0;
	std::atomic<bool>           g_viewReady{ false };
	std::atomic<bool>           g_viewRequested{ false };
	std::atomic<bool>           g_open{ false };
	std::atomic<bool>           g_focusPaused{ false };
	std::atomic<bool>           g_capturing{ false };  // JS capture modal open (Esc cancels there, not here)

	// --- wedged-capture escape hatch (2026-08-01) -------------------------------
	// g_capturing is set AND cleared by the webview. While it is true the input
	// sink deliberately hands EVERY key to the view: Escape is skipped (the view
	// cancels the capture instead) and the open-key toggle is skipped. So if the
	// view ever wedges mid-capture, nothing can clear the flag and the player is
	// locked out completely -- no Escape, no open key, no console. That happened
	// to Rober binding "Full Save": the DLL was alive and still logging his
	// keypresses, but every one of them was being routed into a dead modal and
	// the only way out was killing the game.
	//
	// Two independent ways out, both owned by the DLL so a dead view cannot
	// defeat them:
	//   1. Double-tap Escape. The first Esc still goes to the view (normal
	//      cancel); a second within kCaptureEscWindowMs forces the palette shut.
	//   2. A watchdog: a real capture is "press a key", over in a second or two.
	//      If the flag has been up longer than kCaptureWedgedMs the view is not
	//      coming back, so the next key press force-closes.
	std::atomic<long long>      g_captureStartMs{ 0 };  // when g_capturing went true
	std::atomic<long long>      g_lastEscMs{ 0 };       // last Escape seen while capturing
	constexpr long long         kCaptureEscWindowMs = 1500;   // double-tap window
	constexpr long long         kCaptureWedgedMs    = 20000;  // a capture this old is dead
	// Hold Escape this long and every palette closes, whatever our flags believe.
	// Long enough that a normal Esc tap never trips it, short enough to reach for
	// when the UI has stopped answering.
	constexpr float             kEscHoldPanicSec    = 1.0f;

	long long NowMs()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	// Second PrismaUI view (the Spell Deck / magic organizer) lives inside this
	// same plugin. PrismaUI focus is single-view, so at most one of g_open /
	// g_magicOpen is ever true — the two palettes are naturally exclusive.
	PrismaView                  g_magicView = 0;
	std::atomic<bool>           g_magicViewReady{ false };

	// Followers HUD — the third PrismaUI view (HotkeyDeck/hud.html). Unlike the
	// deck and the Spell Deck it is created eagerly at kDataLoaded and Shown but
	// never Focused during play (input passes through). Focused only to reposition.
	PrismaView                  g_hudView = 0;
	std::atomic<bool>           g_hudViewReady{ false };
	std::atomic<bool>           g_hudEditing{ false };
	// The next real key press is captured as the HUD toggle key while this is set
	// (armed from the deck's "Set show/hide key" control).
	std::atomic<bool>           g_hudKeyArming{ false };

	// Hotbar — the FOURTH PrismaUI view (MagicDeck/hotbar.html), and the HUD's
	// twin in every structural way: created eagerly, Shown but never Focused
	// during play, Focused only for the edit panel. It lives in the MagicDeck
	// view folder so `icons/…` resolves to the Spell Deck's pool (see hotbar.h).
	PrismaView                  g_hbView = 0;
	std::atomic<bool>           g_hbViewReady{ false };
	std::atomic<bool>           g_hbEditing{ false };
	// The modifier page the bar is currently showing. Written by the poller (or
	// by the latch), read by the input sink to decide WHICH page a slot key
	// fires — so the picture on screen and the action that runs can never
	// disagree, which is the one bug a mod-key bar must not have.
	std::atomic<int>            g_hbLivePage{ 0 };
	// Tap-to-latch mode's sticky page (config.modHold == false).
	std::atomic<int>            g_hbLatchPage{ 0 };
	// Whether the view is currently Shown, so the 150 ms auto-visibility beat
	// only calls Show/Hide when the answer actually CHANGED.
	std::atomic<bool>           g_hbShown{ false };
	// The EFFECTIVE visibility (master switch AND manual toggle AND the
	// automatic showMode rule). The input sink reads this, not the raw config
	// flags: a bar that is hidden must not fire.
	std::atomic<bool>           g_hbEffVisible{ false };
	// When the player was last seen in combat, for showMode's linger.
	std::atomic<long long>      g_hbLastCombatMs{ 0 };

	std::atomic<bool>           g_magicViewRequested{ false };
	std::atomic<bool>           g_magicOpen{ false };
	std::atomic<bool>           g_magicFocusPaused{ false };

	// The Followers tab (v0.9.0, formerly the standalone FollowerDeck view)
	// lives INSIDE the deck view — its fd* bridge registers on g_view and F14
	// deep-opens the palette onto that tab via g_pendingTab.
	std::string g_pendingTab;  // main thread only: consumed by OpenPalette()

	// v0.11.0 per-hotkey icons: each view owns its OWN icons/ tree (Ultralight
	// resolves an <img src> against the view that loaded the page), so the heavy
	// sh_index.json is pushed once per session PER VIEW — this is the deck's flag,
	// g_iconIndexPushed is the Spell Deck's.
	std::atomic<bool> g_deckIconIndexPushed{ false };
	// A save is loaded (or a new game started): Follower Organizer's roster exists,
	// so the Deck Portal's NPC-field replay may safely run. Set in SKSEMessageHandler.
	std::atomic<bool> g_gameReady{ false };
	// One portal-sidecar apply batch in flight at a time (poller <-> main thread).
	std::atomic<bool> g_portalPollBusy{ false };
	// A deck refresh that RefreshDeckIcons() had to skip because a capture modal
	// was up. Cleared by the poller once the modal is gone (see the guard below).
	std::atomic<bool> g_deckPushPending{ false };

	// Whichever palette is currently open — used by the shared ext-key bridge,
	// the Mouse4/5 capture-forward and the Esc-close path.
	PrismaView ActiveView() { return g_magicOpen.load() ? g_magicView : g_view; }
	bool       AnyOpen() { return g_open.load() || g_magicOpen.load(); }
	bool       ActiveViewReady()
	{
		return g_magicOpen.load() ? g_magicViewReady.load() : g_viewReady.load();
	}

	// ------------------------------------------- extended F13-F24 key bridge
	// DirectInput never delivers F13-F24 on this input path (iCUE remap ->
	// Parsec -> game), so the game — and every MCM keybind picker — is blind to
	// them. The bridge polls the OS key state (which DOES see them) and re-emits
	// each key as a configurable DIK code:
	//   * mapped to a standard key (e.g. F24 -> Num9): re-sent through SendInput,
	//     so the game/MCM sees an authentic press of that key — MCM pickers
	//     capture it like any real key. This is the mode that matters for MCM.
	//   * mapped to its faithful extended code (100-110, 118): injected as an
	//     engine ButtonEvent — reaches SKSE input sinks / RegisterForKey (and
	//     this plugin's own open key), but NOT MCM capture dialogs, whose
	//     key-name tables end at standard keys.

	inline constexpr int         kExtVkBase = 0x7C;  // VK_F13 .. VK_F24 = 0x7C..0x87
	inline constexpr std::size_t kExtCount = 12;
	inline constexpr std::array<std::uint32_t, kExtCount> kExtFaithfulDik{
		100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 118
	};
	inline constexpr const char* kExtNames[kExtCount] = {
		"F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24"
	};

	constexpr std::array<std::uint32_t, kExtCount> DefaultExtMap()
	{
		auto m = kExtFaithfulDik;
		m[11] = 73;  // F24 (the keyboard Brightness-key remap) -> Numpad 9, MCM-bindable
		return m;
	}

	std::array<std::atomic<bool>, kExtCount> g_extHwSeen{};  // hardware delivered this faithful code natively

	// device: "keyboard" (code = DIK scancode) | "mouse" (code = Skyrim idCode: 2=middle, 3=Mouse4, 4=Mouse5)
	struct HotkeyEntry
	{
		std::string                id;
		std::string                name;
		std::string                desc;
		std::string                device = "keyboard";
		std::uint32_t              code = 0;
		std::string                label;
		std::vector<std::uint32_t> mods;  // DIK codes held while the key is tapped
		std::string                category;  // user tab; "" = All only
		std::string                action;    // when device=="action": verb (freeze/sit/bed/release-all)
		std::string                icon;      // view-relative icon path ("icons/custom/x.png"); "" = none

		// OPTIONAL global trigger: press this with the palette CLOSED and the entry
		// fires where it stands. Orthogonal to `device`/`code`, which describe what
		// a keystroke entry SENDS -- an action entry sends nothing, so it had no key
		// to rebind and therefore no way to be fired without opening the deck. That
		// gap is why "Full Save" could only ever be clicked, and why Rober went into
		// rebind mode at all on 2026-08-01. Clicking still works exactly as before;
		// this is purely additive.
		std::string                trigDevice;  // "keyboard" / "mouse"; "" = no trigger
		std::uint32_t              trigCode = 0;
		std::string                trigLabel;
		std::vector<std::uint32_t> trigMods;    // DIK codes that must be held
	};

	struct ModAction  // Shift/Ctrl/Alt + open-key quick action (code 0 = off)
	{
		std::string   device = "keyboard";
		std::uint32_t code   = 0;
		std::string   label;
		// A slot can instead deep-open the deck onto a SURFACE — currently the
		// only one is "wheel" (the radial palette, Ctrl+F7 by default). Held as
		// a token rather than a second bool so a third surface costs a string,
		// and so a slot written by a newer view survives an older DLL as an
		// unknown token that simply does nothing (`Active()` still sees it, but
		// the dispatch falls through to the key path, which with code 0 is a
		// no-op — never a crash, never a wrong key).
		std::string   surface;
		// A slot is armed if it fires a key OR opens a surface. Every gate that
		// used to read `.code` must read this, or the surface slots are dead.
		bool Active() const { return code != 0 || !surface.empty(); }
	};

	// One tab's size overrides. 0 = unset (the view falls back to its stylesheet).
	struct TabScale
	{
		double ui  = 0.0;  // whole-tab zoom multiplier
		double img = 0.0;  // that tab's image size, in px
	};

	// Outer clamps only. The VIEW owns the per-control range (hd-scale.js SPEC:
	// 60%-160% for ui, and a different px band per tab for img), because that is
	// where the stylesheet's defaults live. These two exist purely so a hand-typed
	// nonsense value in hotkeys.json cannot produce a tab you can no longer reach
	// the controls of — they must stay WIDER than any JS range or a legitimate
	// setting would be silently rewritten on every load.
	constexpr double kTabUiMin  = 0.4,  kTabUiMax  = 2.5;
	constexpr double kTabImgMin = 8.0,  kTabImgMax = 512.0;

	double ClampTabScale(double v, double lo, double hi)
	{
		if (!std::isfinite(v) || v <= 0.0)
			return 0.0;  // 0 = unset; anything unusable becomes unset, never a wedge
		return (std::max)(lo, (std::min)(hi, v));  // (parens: windows.h min/max macros)
	}

	struct Settings
	{
		bool          pauseOnOpen = true;
		// Smooth pause: when pausing, DON'T use a menu pause (which makes Skyrim's
		// cursor floaty/framerate-coupled). Instead focus the view UN-paused and
		// freeze the world with sgtm 0 — the render loop keeps running at full FPS
		// so the cursor is buttery, while time/AI/physics are frozen. Default on;
		// uncheck for the classic menu pause. Only matters when pauseOnOpen is set.
		bool          smoothPause = true;
		bool          closeAfterFire = true;
		bool          stickyNpMods = false;  // numpad Shift/Ctrl/Alt stay on across presses
		// Open the palette while looking at an NPC and land on the Followers tab
		// instead of Hotkeys, where that person's dismiss / inventory / outfit /
		// wait buttons are. Only when the crosshair actually held someone at
		// open, and never over an explicit deep-open (F14/F15 set the tab
		// themselves and must win). Default on: Rober asked for it as the
		// behaviour, and with no target it changes nothing.
		bool          targetOpensFollowers = true;
		double        uiScale = 1.0;         // view-only: menu zoom (0.6-1.6), applied in JS
		double        scrollSpeed = 1.0;     // view-only: deck scroll-wheel speed multiplier (0.5-3.0)
		int           panelW = 0;            // drag-to-resize size, PRE-scale layout px (0 = auto)
		int           panelH = 0;
		std::string   openDevice = "keyboard";
		std::uint32_t openCode = 0x41;  // F7 (DIK)
		std::string   openLabel = "F7";
		bool          extEnabled = true;                              // F13-F24 bridge on/off
		std::array<std::uint32_t, kExtCount> extMap = DefaultExtMap();  // per-key target DIK (0 = key off)
		// Shift / Ctrl / Alt + open key each fire a configurable key (code 0 = off).
		ModAction     openShift{ "keyboard", 0xD3, "Del" };  // default: Shift = Del (weapon wheel)
		// Ctrl + the open key = OUR wheel (v0.16). Rober picked the chord
		// himself ("control + f7 or something else that doesn't interfere") —
		// and it does not: Shift is the vanilla weapon wheel and Alt is where
		// he had moved it to on the live rig, so Ctrl was the free slot.
		ModAction     openCtrl{ "keyboard", 0, "", "wheel" };
		ModAction     openAlt{};
		// ---- per-TAB size overrides (view-only) --------------------------------
		// { "<tab>": { ui, img } } — ui is a whole-tab zoom multiplier, img a pixel
		// size for whatever that tab draws as a picture. 0 (or absent) means UNSET,
		// which the view turns into "use the stylesheet's own default" — so the
		// default lives in the CSS and never has to be duplicated here.
		//
		// A MAP, not a field per tab, and that is the whole point: hd-scale.js can
		// add a tab tomorrow and this file does not change. It also means an entry
		// written by a NEWER deck survives a round-trip through an older DLL
		// instead of being silently dropped on the next save.
		//
		// Clamped on the way in as well as in JS: hotkeys.json is hand-editable and
		// a pasted 40 would paint a tab forty times the panel, with the controls
		// that could undo it somewhere off-screen.
		std::map<std::string, TabScale> tabScales;
	};

	struct Config
	{
		Settings                 settings;
		std::vector<std::string> categories;  // user-defined tabs, in display order
		std::string              notes;       // free-text Notes tab (in-game hotkey tracker)
		std::vector<HotkeyEntry> entries;
		// Action verbs the user DELETED from the seeded set. SeedMissingActions
		// re-adds any missing built-in; without this record a delete silently
		// un-deleted itself on the next launch (2026-08-12 audit).
		std::vector<std::string> suppressedSeeds;
		// Favorites Shelf (v0.15) — a VIEW-OWNED slice carried raw on purpose.
		// Pins reference other slices' identities (entry ids, spell plugin+localId,
		// domain ids), so the schema lives in hd-shelf.js and a key this DLL has
		// never heard of must survive the round-trip — same key-agnostic contract
		// as settings.tabScales. Only sanity is enforced at parse (object, size cap).
		json shelf = json::object();
		// Wheel Menu (v0.16) — the radial palette's wheels, slots and size.
		// Carried raw for exactly the same reason as `shelf` above, and kept a
		// SEPARATE slice on purpose: Rober asked for a second favourites system
		// that shares nothing with the first, so nothing here may reference it.
		// Schema lives in hd-wheel.js.
		json wheel = json::object();
		// Character Sheet (ps* bridge) — the RP half of the sheet: freeform
		// identity/story fields and a portrait path. The live stats are
		// read off the player every frame, never persisted; only this typed
		// meta round-trips under the "charsheet" root key. Capped fields,
		// not raw json, because the shape is fixed and the portrait path is
		// validated (see CharSheet::ValidPortraitPath) — the same reason the
		// deck's other typed slices aren't carried opaque.
		CharSheet::Meta charSheet;
	};

	Config     g_config;
	std::mutex g_configMutex;
	// hotkeys.json is rewritten wholesale (trunc) by WriteConfigFile, and
	// PersistAll() is now reachable from the JS listener threads, the main thread
	// AND the Deck Portal poller. Serialise the WRITE only — taken strictly after
	// g_configMutex has been released (PersistAll snapshots, then writes), so the
	// two are never held together and there is no lock-ordering hazard.
	std::mutex g_writeMutex;

	// ------------------------------------------------------- magic (Spell Deck)
	// A saved spell entry. Durable identity = (plugin, localId) with a raw formId
	// fallback — the same scheme quest_tools uses. `mode` = "cast" | "equip";
	// `hand` = "left" | "right" | "both" (ignored for powers / voice spells).
	struct SpellEntry
	{
		std::string   id;       // stable UI id (formId hex, or user-assigned)
		std::string   plugin;   // source file, e.g. "Skyrim.esm"
		std::uint32_t localId = 0;
		std::uint32_t formId = 0;
		std::string   name;
		std::string   mode = "cast";
		std::string   hand = "right";
		std::string   category;  // which rail category it lives under
		// Icon-metadata snapshot (same fields as SpellMeta) so the row still renders
		// correctly when the spell is no longer in KnownSpellsJson — e.g. after the
		// capture key's delete-on-add cleared it from the vanilla spellbook.
		std::string   slot;
		std::string   school;
		std::string   element;
		std::string   archetype;
		std::string   tier;
		std::string   icon;  // per-spell icon override (view-relative path); "" = auto
	};

	// A standalone spell snapshot: durable identity ((plugin, localId) with a raw
	// formId fallback, as everywhere else) plus the icon metadata the view needs
	// to draw it without a live KnownSpellsJson lookup. Two users: the "Removed
	// from spellbook" list (a removed spell is absent from KnownSpellsJson, so
	// its icon data must travel with it) and combo members (a combo survives its
	// source deck entries being deleted, so it can't reference them by id).
	struct SpellMeta
	{
		std::string   plugin;
		std::uint32_t localId = 0;
		std::uint32_t formId = 0;
		std::string   name;
		std::string   type;
		std::string   school;
		std::string   element;
		std::string   archetype;
		std::string   tier;
		std::string   icon;  // icon override carried from the source deck entry
	};

	// A spell combo — drag spells together in the view, click to cast them all
	// in order (one CastSequence barrage). Members are snapshots, not deck-entry
	// references; `spells` order IS the cast order.
	struct ComboEntry
	{
		std::string            id;
		std::string            name;
		std::vector<SpellMeta> spells;
	};

	struct MagicConfig
	{
		std::string              openDevice = "keyboard";
		std::uint32_t            openCode = 105;  // F18 faithful extended code
		std::string              openLabel = "F18";
		// Capture key: pressed inside the vanilla Magic Menu, it sends the
		// highlighted spell straight into the deck (input sink -> DoAddHighlighted).
		std::string              addDevice = "keyboard";
		std::uint32_t            addCode = 0x4E;  // Numpad +
		std::string              addLabel = "Num +";
		bool                     removeOnAdd = false;  // capture also clears it from the spellbook
		double                   uiScale = 1.0;
		int                      iconPx = 0;  // spell-row icon box in px (0 = the view's CSS default)
		int                      panelW = 0;  // drag-to-resize size, PRE-scale layout px (0 = auto)
		int                      panelH = 0;
		std::vector<std::string> categories;  // rail order
		std::vector<SpellEntry>  spells;
		std::vector<ComboEntry>  combos;   // cast-all-at-once spell groups
		std::vector<SpellMeta>   removed;  // cleared from the spellbook, restorable
		// Rail glyphs, keyed by category NAME (the rail has no stable slot index —
		// renames migrate the key in the view). Same idea as the Followers rail's
		// catIcons, same icons/custom pool.
		std::map<std::string, std::string> catIcons;
	};

	constexpr std::size_t kMaxSpellCatIcons = 64;  // rail categories are user-minted; cap the map, not the user

	MagicConfig g_magicConfig;  // guarded by g_configMutex, persisted under "magic"

	// ------------------------------------------------ followers (Follower Deck)
	// Only the view chrome is ours (open key + scale). The roster itself lives
	// in Follower Organizer's own JSON and is mutated through its in-process
	// Deck API (follower_deck.h) — this plugin never writes that file.
	// A DISPLAY crop for ONE portrait FILE. The plugin cannot re-cut the pixels
	// — portrait_capture.cpp ships a hand-rolled PNG encoder and no decoder at
	// all, so it cannot open a saved .jpg, crop it and write it back. So the
	// view pans/zooms the same <img> it already draws with a CSS transform, and
	// this is the memory of where it put it.
	//
	// z is the display zoom (1 = the whole cover-fitted frame); x/y are the pan
	// as FRACTIONS of the frame, so one crop is correct at a 40 px medallion and
	// at a 512 px lightbox alike. The invariant |x|,|y| <= (z-1)/2 (the slack the
	// zoom creates) is what stops a crop ever showing the well behind the photo,
	// and it is enforced identically here and in followers-pane.js clampCrop().
	struct PortraitCrop
	{
		double z = 1.0;
		double x = 0.0;
		double y = 0.0;
	};

	// Mirrored in followers-pane.js CROP_MAX_ENTRIES. Crops are pruned against
	// the real directory on every save, so this only ever bites a hand-edited
	// hotkeys.json — but a map the plugin re-reads at every load deserves a
	// ceiling on both sides.
	constexpr std::size_t kMaxPortraitCrops = 400;

	// Follower Organizer owns exactly 25 category slots plus slot 0 (the master
	// list), so a per-category map can never legitimately hold more than 26 rows
	// and no index outside [0, 25] names anything. Both are enforced on load:
	// the ceiling stops a hand-edited hotkeys.json growing the map without
	// bound, the range stops a stale index drawing an icon beside nothing.
	constexpr int         kFolCatMax = 25;
	constexpr std::size_t kMaxCatIcons = static_cast<std::size_t>(kFolCatMax) + 1;

	struct FollowerConfig
	{
		std::string   openDevice = "keyboard";
		std::uint32_t openCode = 101;  // F14 faithful ext code — Scimitar G1 via the bridge
		std::string   openLabel = "F14";
		double        uiScale = 1.0;
		// Row avatar diameter in px. 0 = "whatever the stylesheet says" (40),
		// so a config written before this field existed keeps today's look and
		// the default lives in exactly one place — the CSS.
		int avatarPx = 0;
		// Quick-card action labels: false = icon buttons that expand to a labelled
		// pill on hover (default), true = every label pinned open. View-only look
		// preference, round-tripped like avatarPx so the choice survives a restart.
		bool fqLabels = false;
		// Left category rail collapsed to an icon strip. View-only look pref,
		// round-tripped like fqLabels so the choice survives a restart.
		bool railCollapsed = false;
		// Category-icon size, as a PERCENT of the size the avatar slider derives
		// (100 = ride the avatar slider exactly, the pre-slider look). Independent
		// so the rail glyphs can be scaled up on their own — bigger also reads
		// CRISPER because Ultralight's hard downscale of the 256px art aliases
		// less. Round-tripped like avatarPx so the choice survives a restart.
		int railIconPct = 100;
		// Portrait FILE NAME -> crop. The file, never the follower: portraits
		// are versioned `<slug>~<unixtime>.png`, so a fresh capture — or a crop
		// the Deck Portal has BAKED into new pixels — arrives under a name this
		// map has never seen and is drawn as shot. That is what makes
		// double-cropping structurally impossible rather than merely unlikely.
		std::map<std::string, PortraitCrop> portraitCrops;
		// Category SLOT INDEX -> view-relative icon path ("icons/custom/x.png" |
		// "icons/sh/<atlas>/<key>.png"). Keyed by INDEX, never by name: FO's 25
		// slots are stable identities and the label is user-editable in the very
		// same rail row — renaming "Housecarls" would otherwise silently orphan
		// its shield. An absent index simply means "no icon", which is the
		// pre-icons look, so nothing regresses for a category nobody has set.
		std::map<int, std::string> catIcons;
	};

	FollowerConfig g_folConfig;  // guarded by g_configMutex, persisted under "followers"

	// -------------------------------------------------- domains (Domains tab)
	// A marked place. The parent CELL is the durable identity — a raw FormID
	// with an editor-id fallback, because cells are addressed through the
	// engine's form table, not by (plugin, localId) like spells and quests.
	// Position/angle are raw floats; worldspace is display metadata only, since
	// PlaceActions::Recall derives the worldspace from the cell it hands MoveTo.
	struct PlaceMark
	{
		std::string   id;
		std::string   name;
		std::string   category;
		std::string   parentId;  // id of the parent mark ("" = top-level); view-owned, C++ round-trips it
		std::string   note;
		// Free-form tags, his words. Normalised on the way in (trimmed, inner
		// whitespace collapsed, length-capped, de-duplicated CASE-INSENSITIVELY
		// while keeping the capitalisation he typed) — otherwise "Inn", "inn "
		// and "inn" become three chips that look identical and filter
		// differently. Same rule in domains-pane.js normTag()/mergeTags().
		std::vector<std::string> tags;
		// The photo, as a view-relative path: `domain-images/<file>`. Written by
		// photo mode and attached HERE rather than by the view, because the
		// palette is always closed while the camera is in the player's hands, so
		// a push to the view is dropped and a view-side attach never runs (the
		// 2026-08-02 "took a picture and it shows nowhere" bug). Empty = draw the
		// initials medallion.
		std::string   image;
		std::string   cellName;
		std::uint32_t cellId = 0;
		std::string   cellEdid;
		std::uint32_t worldspaceId = 0;
		std::string   worldspaceName;
		bool          interior = true;
		float         x = 0.0f;
		float         y = 0.0f;
		float         z = 0.0f;
		float         angleZ = 0.0f;
	};

	struct DomainsConfig
	{
		std::string              openDevice = "keyboard";
		std::uint32_t            openCode = 102;  // F15 faithful ext code — Scimitar G3 via the bridge
		std::string              openLabel = "F15";
		double                   uiScale = 1.0;   // round-tripped; the deck's own scale drives the panel
		// The row-image slider. It was missing from this struct entirely, so the
		// view sent it on every save and C++ dropped it on the floor — the
		// slider worked until you closed the deck and then forgot ("its not
		// remembering ui size on close and open on domains page").
		double                   thumbSize = 1.0;
		std::vector<std::string> categories;
		std::vector<PlaceMark>   marks;
		// Place-photo display crops, keyed by the image FILE NAME and never by
		// the domain id. Two consequences we want: renaming a domain keeps its
		// framing, and a RE-SHOT photo (which lands as `<slug>~<unixtime>.png`
		// whenever the renderer still has the old file mapped — and it does, the
		// moment the deck has drawn that row once) arrives under a name this map
		// has never seen and is drawn as shot. That is what makes double-cropping
		// structurally impossible rather than merely unlikely.
		//
		// Wardrobe::ImageCrop deliberately, not a private twin: the invariant
		// (|x|,|y| <= (z-1)/2, z in [1,4]) is the same geometry, and a second
		// copy of the clamp is exactly how the two would drift apart.
		std::map<std::string, Wardrobe::ImageCrop> imageCrops;
	};

	// -------------------------------------------------- containers (Containers tab)
	// A marked container. Its durable identity is the (plugin, localId) of its
	// WORLD REFERENCE — the ESL-safe pair, re-resolved through TESDataHandler each
	// load — because a container is addressed by its ref, not by its cell (that is
	// what sets it apart from a PlaceMark). The cell + position + angle are its
	// HOME, captured so a summoned container can be moved back exactly where it
	// stood (ContainerActions::OpenContainer). tags/imageCrops are deliberately not
	// carried: the Containers pane keeps only a single portrait, no tag chips.
	struct ContainerMark
	{
		std::string   id;
		std::string   name;
		std::string   category;
		std::string   note;
		std::string   image;      // view-relative `container-images/<file>`; empty = medallion
		std::string   plugin;     // owning plugin file name (ESL-safe identity)
		std::uint32_t localId = 0;
		std::string   cellName;
		std::uint32_t cellId = 0;
		std::string   cellEdid;
		std::uint32_t worldspaceId = 0;
		std::string   worldspaceName;
		bool          interior = true;
		float         x = 0.0f;
		float         y = 0.0f;
		float         z = 0.0f;
		float         angleZ = 0.0f;
	};

	struct ContainerConfig
	{
		std::string              openDevice = "keyboard";
		std::uint32_t            openCode = 103;  // F16 faithful ext code — Scimitar G8 via the bridge
		std::string              openLabel = "F16";
		double                   uiScale = 1.0;
		double                   thumbSize = 1.0;
		std::vector<std::string> categories;
		std::vector<ContainerMark> marks;
	};

	// Per-domain and whole-config ceilings on tags. A stuck key must not be able
	// to grow hotkeys.json without bound, and the pane re-renders every chip on
	// every keystroke of the filter. Mirrored in domains-pane.js TAG_MAX /
	// TAG_MAX_LEN.
	constexpr std::size_t kMaxTagsPerMark = 12;
	constexpr std::size_t kMaxTagLen      = 28;

	DomainsConfig g_domConfig;  // guarded by g_configMutex, persisted under "domains"
	// The domain a photo is being taken FOR, set by pdPhoto and read by the
	// photo-saved callback. Photo mode is single-flight (StartPhotoMode refuses
	// while another is live), so one pending id is enough — and it beats parsing
	// the id back out of the file name, which the lock-safe `<slug>~<unixtime>`
	// fallback would make ambiguous. Main thread only, like every other photo
	// step, so it needs no lock.
	std::string g_photoDomainId;
	ContainerConfig g_contConfig;  // guarded by g_configMutex, persisted under "containers"
	// The container a photo is being taken FOR (Containers tab), same single-slot
	// contract as g_photoDomainId — photo mode is single-flight.
	std::string g_photoContainerId;
	Finance::Config g_finConfig;  // guarded by g_configMutex, persisted under "finances"
	Wardrobe::Config g_wardrobeConfig;  // guarded by g_configMutex, persisted under "wardrobe"
	NffOutfits::Config g_nffConfig;  // guarded by g_configMutex, persisted under "nffOutfits"
	RoomGuard::Config g_roomConfig;  // guarded by g_configMutex, persisted under "rooms"
	FollowerTune::Config g_tuneConfig;  // guarded by g_configMutex, persisted under "tuning"
	LootHighlight::Config g_lootConfig;  // guarded by g_configMutex, persisted under "loot"
	FollowersHud::Config g_hudConfig;  // guarded by g_configMutex, persisted under "hud"
	Hotbar::Config g_hbConfig;  // guarded by g_configMutex, persisted under "hotbar"
	NoAutoGear::Config g_ngConfig;  // guarded by g_configMutex, persisted under "noAutoGear"
	SpidGear::Config g_spidConfig;  // guarded by g_configMutex, persisted under "spidGear"

	// ------------------------------------------------------------------ config

	std::filesystem::path ConfigPath()
	{
		return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "hotkeys.json";
	}

	Config DefaultConfig()
	{
		// What a FRESH INSTALL gets, and nobody else: written only when there
		// is no hotkeys.json at all. Native actions arrive ready to use (they
		// call into the game directly); keystroke rows arrive UNBOUND, because
		// the key each one should press belongs to the player's own MCM setup.
		Config c;
		c.categories = { "Combat", "Followers", "NPC", "Fixes", "Misc", "Menus" };
		c.entries = {
			// Combat
			// KEYSTROKE entries ship UNBOUND (code 0). They press a key at
			// ANOTHER mod, and only the player knows what key that mod is
			// configured with — shipping the author's own binds would fire
			// whatever those keys happen to do on someone else's setup. An
			// unbound entry is a labelled placeholder: SendScan(0) is a no-op,
			// and F2 edit mode press-to-binds it in two seconds. (The Menus
			// entries below need no key at all: they READ the target mod's own
			// config and synthesize whatever it is listening for.)
			{ "stance-1", "Stance 1", "Fires your combat/stance mod's first stance key. Unbound - press F2 and set the key you use.", "keyboard", 0, "", {}, "Combat" },
			{ "stance-2", "Stance 2", "Fires your combat/stance mod's second stance key. Unbound - press F2 and set the key you use.", "keyboard", 0, "", {}, "Combat" },
			{ "stance-3", "Stance 3", "Fires your combat/stance mod's third stance key. Unbound - press F2 and set the key you use.", "keyboard", 0, "", {}, "Combat" },
			{ "weapon-wheel", "Weapon Wheel", "Opens your weapon-wheel mod. Unbound - press F2 and set the key that mod uses.", "keyboard", 0, "", {}, "Combat" },
			{ "block", "Block", "Fires your combat mod's block/parry key. Unbound - press F2 and set the key you use.", "keyboard", 0, "", {}, "Combat" },
			// Followers
			{ "quick-follower", "Quick Follower Command", "Opens your quick follower-command mod's menu. Unbound - press F2 and set its key.", "keyboard", 0, "", {}, "Followers" },
			{ "followers-control", "Follower Control (NFF)", "Opens Nether's Follower Framework's control menu. Unbound - set this to the key NFF is configured with in its MCM.", "keyboard", 0, "", {}, "Followers" },
			{ "followers-teleport", "Followers: Teleport", "Teleports your followers to you via NFF. Unbound - set this to NFF's teleport key from its MCM.", "keyboard", 0, "", {}, "Followers" },
			{ "follower-organizer", "Follower Organizer", "Opens Follower Organizer's own menu. Unbound - set this to its MCM key.", "keyboard", 0, "", {}, "Followers" },
			// NPC (native actions)
			{ "npc-freeze", "Freeze NPC", "Hold the targeted NPC in place - toggle (ported from CommandNPC)", "action", 0, "Freeze", {}, "NPC", "freeze" },
			{ "npc-sit", "Sit NPC", "Send targeted NPC to nearest chair (ground if none); toggle to release", "action", 0, "Sit", {}, "NPC", "sit" },
			{ "npc-bed", "Bed NPC", "Send targeted NPC to nearest bed (ground if none); toggle to release", "action", 0, "Bed", {}, "NPC", "bed" },
			{ "npc-release-all", "Release All NPCs", "Free every NPC held/seated by these actions", "action", 0, "Release", {}, "NPC", "release-all" },
			{ "npc-grab", "Grab NPC", "Pick up the targeted NPC with Object Manipulation Overhaul (Groovatron-style): follows your crosshair, left-click places, right-click puts them back; stands up sitters", "action", 0, "Grab", {}, "NPC", "grab" },
			{ "npc-attack-target", "Sic 'em (Attack Target)", "Send every follower to attack whoever you're looking at, right now - plus any enemies already fighting near them. Skips the follower detection lag. Bind a key for combat (EFF-style assault command)", "action", 0, "Sic 'em", {}, "NPC", "attack-target" },
			{ "npc-no-auto-gear", "No Auto-Gear", "Toggle: stop SPID/SkyPatcher distributors putting cloaks, hoods or underwear on the NPC you're looking at, and strip what's worn. Bind a key or fire from the palette (no auto gear cloak hood underwear)", "action", 0, "NoGear", {}, "NPC", "no-auto-gear" },
			{ "npc-no-auto-gear-party", "No Auto-Gear: Party", "Protect every follower with you right now from distributor cloaks/hoods/underwear (no auto gear party)", "action", 0, "NoGear+", {}, "NPC", "no-auto-gear-party" },
			// Fixes / Unstuck (native console-backed actions) — for modded-game jank
			{ "fix-recycle", "Unstick NPC", "Rebuild the crosshair NPC's 3D and AI (recycleactor) - the fix for a T-posing, invisible, frozen or wedged follower", "action", 0, "Unstick", {}, "Fixes", "fix-recycle" },
			{ "fix-resetai", "Reset AI", "Re-evaluate the crosshair NPC's AI packages (resetai) - for someone stuck standing, not following, or ignoring their schedule", "action", 0, "Reset AI", {}, "Fixes", "fix-resetai" },
			{ "fix-calm", "Calm NPC", "Stop the crosshair NPC's combat and drop aggression to 0 - end a fight that should not be happening", "action", 0, "Calm", {}, "Fixes", "fix-calm" },
			{ "fix-resurrect", "Resurrect NPC", "Bring the crosshair corpse back keeping its inventory (resurrect 1) - undo a death you did not want", "action", 0, "Resurrect", {}, "Fixes", "fix-resurrect" },
			{ "fix-noclip", "Toggle Noclip (me)", "Toggle player collision (tcl) - walk out when you are stuck in geometry, fire again to turn it back on", "action", 0, "Noclip", {}, "Fixes", "fix-noclip" },
			// CHIM (native action) — unbound on purpose: it is a "when I feel
			// like it" action fired from the palette, not something you want
			// under a finger during combat.
			// "Capture Portrait" is no longer seeded as a hotkey: it lives on the
			// Followers tab's LOOKING-AT card, next to the other things you do to
			// the person in front of you. The "portrait" ACTION verb below is kept
			// so an entry someone already has (or binds by hand) still fires.
			{ "tailor-open", "Tailor (Outfits & Wigs)", "Opens Tailor's outfit/wig manager. Unbound - set this to the key Tailor is configured with.", "keyboard", 0, "", {}, "Followers" },
			// Misc
			{ "followers-loot", "NPC Sandbox / Skinshift", "Fires the key your NPC-sandbox or Skinshift mod listens for. Unbound - press F2 and set it.", "keyboard", 0, "", {}, "Misc" },
			{ "hd-additem-menu", "AddItemMenu", "Open AddItemMenu's mod-list popup - browse any installed mod's items and take them (add item menu)", "action", 0, "AddItemMenu", {}, "Misc", "additem-menu" },
			{ "hd-additem-search", "AddItemMenu: Search", "Open AddItemMenu straight into name search - type an item name and take it (add item search)", "action", 0, "Search", {}, "Misc", "additem-search" },
			// (Two "free slot" placeholders lived here for the author's spare
			// mouse buttons. A stranger's deck should start with no empty
			// mystery rows — add your own with the + button instead.)
			{ "omo-pick", "OMO: Pick Object", "Object Manipulation Overhaul picks up the item under your crosshair (decorating; NPCs use the Grab action instead). Unbound - set this to OMO's own pick key from its KeyConfiguration.txt.", "keyboard", 0, "", {}, "Misc" },
			// Menus — open another mod's settings menu from the deck, no dedicated
			// keyboard hotkey to remember. Each synthesizes the key that mod is
			// configured to listen for (read live from its own config).
			{ "open-prisma-mcm", "Prisma MCM", "Open the Prisma MCM Redux settings menu (the general PrismaUI MCM) - no hotkey needed", "action", 0, "Prisma MCM", {}, "Menus", "open-prisma-mcm" },
			{ "open-smf", "SKSE Menu", "Open the SKSE Menu Framework menu - no hotkey needed (double-taps its toggle key for you)", "action", 0, "SKSE Menu", {}, "Menus", "open-smf" },
			{ "open-community-shaders", "Community Shaders", "Open the Community Shaders menu (needs Community Shaders installed; default key End)", "action", 0, "Community Shaders", {}, "Menus", "open-community-shaders" },
		};
		return c;
	}

	json SettingsToJson(const Settings& s)
	{
		json extMap = json::object();
		for (std::size_t i = 0; i < kExtCount; ++i)
			extMap[kExtNames[i]] = s.extMap[i];
		// Every tab we hold, every time — this whole slice is round-tripped as one
		// object, so a key omitted here is a setting silently reset on the next
		// save. A tab whose values are both unset is dropped instead of written as
		// {0,0}: it is the same thing to the view, and it keeps hotkeys.json from
		// growing a line per tab the user never touched.
		json tabScales = json::object();
		for (const auto& [tab, ts] : s.tabScales) {
			if (ts.ui <= 0.0 && ts.img <= 0.0)
				continue;
			tabScales[tab] = json{ { "ui", ts.ui }, { "img", ts.img } };
		}
		return json{
			{ "pauseOnOpen", s.pauseOnOpen },
			{ "smoothPause", s.smoothPause },
			{ "closeAfterFire", s.closeAfterFire },
			{ "stickyNpMods", s.stickyNpMods },
			{ "targetOpensFollowers", s.targetOpensFollowers },
			{ "uiScale", s.uiScale },
			{ "scrollSpeed", s.scrollSpeed },
			{ "panelW", s.panelW },
			{ "panelH", s.panelH },
			{ "openKey", json{ { "device", s.openDevice }, { "code", s.openCode }, { "label", s.openLabel } } },
			{ "openMods", json{
				{ "shift", json{ { "device", s.openShift.device }, { "code", s.openShift.code }, { "label", s.openShift.label }, { "surface", s.openShift.surface } } },
				{ "ctrl", json{ { "device", s.openCtrl.device }, { "code", s.openCtrl.code }, { "label", s.openCtrl.label }, { "surface", s.openCtrl.surface } } },
				{ "alt", json{ { "device", s.openAlt.device }, { "code", s.openAlt.code }, { "label", s.openAlt.label }, { "surface", s.openAlt.surface } } } } },
			{ "extKeys", json{ { "enabled", s.extEnabled }, { "map", extMap } } },
			{ "tabScales", tabScales }
		};
	}

	json ConfigToJson(const Config& c)
	{
		json entries = json::array();
		for (const auto& e : c.entries) {
			entries.push_back(json{
				{ "id", e.id },
				{ "name", e.name },
				{ "desc", e.desc },
				{ "device", e.device },
				{ "code", e.code },
				{ "label", e.label },
				{ "mods", e.mods },
				{ "category", e.category },
				{ "action", e.action },
				{ "icon", e.icon },
				// Only written when set, so an untriggered entry's json is unchanged
				// and an older DLL reading this file simply ignores the key.
				{ "trigger", e.trigDevice.empty() ? json(nullptr) : json{
					{ "device", e.trigDevice },
					{ "code", e.trigCode },
					{ "label", e.trigLabel },
					{ "mods", e.trigMods } } } });
		}
		return json{ { "settings", SettingsToJson(c.settings) },
			{ "categories", c.categories },
			{ "notes", c.notes },
			{ "entries", entries },
			{ "suppressedSeeds", c.suppressedSeeds },
			{ "shelf", c.shelf },
			{ "wheel", c.wheel },
			{ "charsheet", json{
				{ "charClass", c.charSheet.charClass },
				{ "alignment", c.charSheet.alignment },
				{ "title", c.charSheet.title },
				{ "eyeColor", c.charSheet.eyeColor },
				{ "height", c.charSheet.height },
				{ "age", c.charSheet.age },
				{ "homeland", c.charSheet.homeland },
				{ "deity", c.charSheet.deity },
				{ "background", c.charSheet.background },
				{ "history", c.charSheet.history },
				{ "portrait", c.charSheet.portrait } } } };
	}

	// Runtime mod-detection for the deck's shipped INTEGRATIONS. Rides the OPEN
	// payload only (hdOpen), never the persisted hotkeys.json — so a SHARED config
	// carries no machine-specific detection, and the recipient's deck hides the
	// integrations they have not installed (the view maps entry->flag). Load-ORDER
	// presence for plugins (LookupLoadedMod*), not mere file existence, so an
	// unticked plugin reads as absent — which is what "the integration won't work"
	// means. Computed once (mods don't change mid-session). Build marker below.
	const json& DetectedModsJson()
	{
		static json cached;
		static bool done = false;
		if (done)
			return cached;
		auto* dh = RE::TESDataHandler::GetSingleton();
		auto  plugin = [&](const char* n) -> bool {
			return dh && (dh->LookupLoadedModByName(n) != nullptr || dh->LookupLoadedLightModByName(n) != nullptr);
		};
		auto dll = [](const char* n) { return GetModuleHandleA(n) != nullptr; };
		auto has = [](const char* p) { std::error_code ec; return std::filesystem::exists(p, ec); };
		cached = json{
			{ "omo", dll("ObjectManipulationOverhaul") },
			{ "additemmenu", plugin("AddItemMenuSE.esp") },
			{ "followerorganizer", dll("FollowerOrganizer.dll") },
			{ "nff", plugin("nwsFollowerFramework.esp") },
			{ "smf", has("Data/SKSE/Plugins/SKSEMenuFramework.ini") || dll("SKSEMenuFramework") },
			{ "cs", has("Data/SKSE/Plugins/CommunityShaders.json") || dll("CommunityShaders") },
			{ "virtualkey", has("Data/SKSE/Plugins/VirtualKey") || dll("VirtualKey") },
			{ "bfl", plugin("Better Face Lighting - ENB Light.esp") },
			// CHIM/Herika: AIAgent.esp is the game-side half of the AI companion
			// stack. Gates the Home "Ask (CHIM)" card + omni Ask/Direct modes —
			// a non-CHIM user was seeing a dead card on the front page
			// (Rober's screenshot, 2026-08-12).
			{ "chim", plugin("AIAgent.esp") },
			// Prisma MCM Redux had NO flag until 2026-08-12 — its opener row was
			// visible everywhere and synthesized "\\" on setups without the mod:
			// the exact dead button the mod page promises cannot exist.
			{ "prisma", has("Data/PrismaMCMRedux/PrismaCore.ini") || dll("PrismaMCMRedux") },
			// --- whole-TAB gates (2026-08-12 policy sweep, Rober): a tab whose
			// backing mod is absent showed with in-pane refusals; now the view
			// hides the tab entirely on an EXPLICIT false. Same explicit-false
			// law as the entry flags above — an older DLL sends none and nothing
			// vanishes.
			// SOES-NG is a pure SKSE DLL (no plugin), so detect the module (its
			// data JSON only exists AFTER a first export, which would false-negate
			// a fresh install). Backs the Wardrobe tab.
			{ "soes", dll("SkyrimOutfitEquipmentSystemNG.dll") },
			// Preset Director DLL — backs the Faces tab (preset_bridge.cpp
			// already probes this exact module for its C API).
			{ "presetdirector", dll("PresetDirector.dll") },
			// OStim SA DLL — backs the OStim scene deck (ostim_deck.cpp / its
			// vendored Thread API consume it via GetModuleHandle("OStim.dll")).
			{ "ostim", dll("OStim.dll") },
			// ZaZ Animation Pack — the Animations tab is a ZAP idle-event player;
			// its whole baked catalogue fires NotifyAnimationGraph events that
			// only resolve when ZAP's behaviour files are loaded, so with the ESM
			// absent every animation is a silent no-op.
			{ "zap", plugin("ZaZAnimationPack.esm") },
			// Tailor plugin — the seeded "tailor-open" row opens Tailor's own
			// PrismaUI view; unbound + mod-absent it is a dead key.
			{ "tailor", plugin("Tailor.esp") },
		};
		done = true;
		// Build marker (hd-markers.json: "deck-mod-detection"): unconditional so it
		// is reached the first time the deck opens. KEEP the leading literal
		// "deck: mod-detection omo=" intact (build marker) — new flags append.
		logger::info("deck: mod-detection omo={} aim={} fo={} nff={} smf={} cs={} vk={} bfl={} prisma={} chim={} soes={} presetdirector={} ostim={} zap={} tailor={}",
			cached["omo"].get<bool>(), cached["additemmenu"].get<bool>(),
			cached["followerorganizer"].get<bool>(), cached["nff"].get<bool>(),
			cached["smf"].get<bool>(), cached["cs"].get<bool>(), cached["virtualkey"].get<bool>(),
			cached["bfl"].get<bool>(), cached["prisma"].get<bool>(), cached["chim"].get<bool>(),
			cached["soes"].get<bool>(), cached["presetdirector"].get<bool>(),
			cached["ostim"].get<bool>(), cached["zap"].get<bool>(), cached["tailor"].get<bool>());
		return cached;
	}

	bool ValidDevice(const std::string& d) { return d == "keyboard" || d == "mouse"; }

	// The one path shape a webview can load: view-relative, forward slashes, under
	// "icons/". Normalises the separators IN PLACE (a hand-typed Windows path is a
	// typo, not an attack) and returns false when the path could still escape the
	// view directory — no "..", no drive letter, no leading '/'. "" (no icon) is
	// always valid, so clearing an icon always works.
	bool ValidViewIconPath(std::string& p)
	{
		std::replace(p.begin(), p.end(), '\\', '/');
		if (p.empty())
			return true;
		if (p.find("..") != std::string::npos || p.front() == '/' || p.find(':') != std::string::npos)
			return false;
		return p.compare(0, 6, "icons/") == 0;
	}

	bool ConfigFromJson(const json& j, Config& out)
	{
		try {
			if (!j.is_object())
				return false;
			Config c;
			if (j.contains("settings") && j["settings"].is_object()) {
				const auto& s = j["settings"];
				c.settings.pauseOnOpen = s.value("pauseOnOpen", true);
				c.settings.smoothPause = s.value("smoothPause", true);
				c.settings.closeAfterFire = s.value("closeAfterFire", true);
				c.settings.stickyNpMods = s.value("stickyNpMods", false);
				// Absent in every config written before v0.14 — default TRUE so the
				// behaviour is on for an existing hotkeys.json, not just a fresh one.
				c.settings.targetOpensFollowers = s.value("targetOpensFollowers", true);
				c.settings.uiScale = s.value("uiScale", 1.0);
				{
					const double sp = s.value("scrollSpeed", 1.0);
					c.settings.scrollSpeed = (sp <= 0.0) ? 1.0 : std::clamp(sp, 0.5, 3.0);
				}
				c.settings.panelW = s.value("panelW", 0);
				c.settings.panelH = s.value("panelH", 0);
				if (s.contains("openKey") && s["openKey"].is_object()) {
					const auto& ok = s["openKey"];
					auto dev = ok.value("device", std::string("keyboard"));
					auto code = ok.value("code", 0x41u);
					if (ValidDevice(dev) && code > 0) {
						c.settings.openDevice = dev;
						c.settings.openCode = code;
						c.settings.openLabel = ok.value("label", std::string(""));
					}
				}
				auto parseMod = [](const json& mj, ModAction& m) {
					auto d = mj.value("device", std::string("keyboard"));
					if (ValidDevice(d)) {
						m.device = d;
						m.code = mj.value("code", 0u);
						m.label = mj.value("label", std::string(""));
					}
					// Read OUTSIDE the device guard: a surface slot carries no
					// key at all, so gating it on a valid key device would make
					// the whole feature unreadable from an existing file.
					//
					// PRESENCE, not value — and that is the whole migration. A
					// pre-v0.16 hotkeys.json has no "surface" member anywhere,
					// so the field keeps its STRUCT default (Ctrl = the wheel)
					// and an existing config gains the feature on first load;
					// `mj.value(...)` would have read the absent key as "" and
					// silently unbound it for everyone who already plays.
					// A user who deliberately clears the slot writes an empty
					// string, which is present, and is honoured.
					if (mj.contains("surface") && mj["surface"].is_string()) {
						auto sf = mj["surface"].get<std::string>();
						if (sf.size() <= 24)
							m.surface = sf;
					}
				};
				if (s.contains("openMods") && s["openMods"].is_object()) {
					const auto& om = s["openMods"];
					if (om.contains("shift") && om["shift"].is_object()) parseMod(om["shift"], c.settings.openShift);
					if (om.contains("ctrl") && om["ctrl"].is_object()) parseMod(om["ctrl"], c.settings.openCtrl);
					if (om.contains("alt") && om["alt"].is_object()) parseMod(om["alt"], c.settings.openAlt);
				} else if (s.contains("openMod") && s["openMod"].is_object()) {
					parseMod(s["openMod"], c.settings.openShift);  // migrate v0.3.6 single slot
				}
				// Per-tab sizes. Deliberately key-agnostic: whatever tab names the
				// view sends are kept, so a tab this DLL has never heard of is not
				// erased by the next save. Only the two numbers are validated.
				if (s.contains("tabScales") && s["tabScales"].is_object()) {
					for (const auto& [tab, v] : s["tabScales"].items()) {
						if (tab.empty() || tab.size() > 48 || !v.is_object())
							continue;
						// is_number() first: value() THROWS on a type mismatch, and
						// "ui": "big" in a hand-edited file must be ignored, not
						// abort the whole config parse and reset the deck.
						const auto num = [&v](const char* k) -> double {
							const auto it = v.find(k);
							return (it != v.end() && it->is_number()) ? it->get<double>() : 0.0;
						};
						TabScale ts;
						ts.ui  = ClampTabScale(num("ui"), kTabUiMin, kTabUiMax);
						ts.img = ClampTabScale(num("img"), kTabImgMin, kTabImgMax);
						if (ts.ui > 0.0 || ts.img > 0.0)
							c.settings.tabScales[tab] = ts;
					}
				}
				if (s.contains("extKeys") && s["extKeys"].is_object()) {
					const auto& ek = s["extKeys"];
					c.settings.extEnabled = ek.value("enabled", true);
					if (ek.contains("map") && ek["map"].is_object()) {
						for (std::size_t i = 0; i < kExtCount; ++i) {
							const auto it = ek["map"].find(kExtNames[i]);
							if (it != ek["map"].end() && it->is_number_unsigned())
								c.settings.extMap[i] = (std::min)(it->get<std::uint32_t>(), 255u);  // (parens: windows.h min macro)
						}
					}
				}
			}
			if (j.contains("categories") && j["categories"].is_array()) {
				for (const auto& cat : j["categories"])
					if (cat.is_string() && !cat.get<std::string>().empty())
						c.categories.push_back(cat.get<std::string>());
			}
			c.notes = j.value("notes", std::string(""));
			if (j.contains("entries") && j["entries"].is_array()) {
				for (const auto& je : j["entries"]) {
					if (!je.is_object())
						continue;
					HotkeyEntry e;
					e.id = je.value("id", std::string(""));
					e.name = je.value("name", std::string("Unnamed"));
					e.desc = je.value("desc", std::string(""));
					e.device = je.value("device", std::string("keyboard"));
					e.code = je.value("code", 0u);
					e.label = je.value("label", std::string(""));
					e.category = je.value("category", std::string(""));
					e.action = je.value("action", std::string(""));
					e.icon = je.value("icon", std::string(""));
					if (je.contains("trigger") && je["trigger"].is_object()) {
						const auto& t = je["trigger"];
						e.trigDevice = t.value("device", std::string(""));
						e.trigCode   = t.value("code", 0u);
						e.trigLabel  = t.value("label", std::string(""));
						e.trigMods.clear();
						if (t.contains("mods") && t["mods"].is_array())
							for (const auto& m : t["mods"])
								if (m.is_number_unsigned())
									e.trigMods.push_back(m.get<std::uint32_t>());
						if (!ValidDevice(e.trigDevice) || e.trigCode == 0)
							e.trigDevice.clear();  // malformed -> no trigger, never a half-bound key
					}
					if (!ValidViewIconPath(e.icon))
						e.icon.clear();  // never hand a webview an escaping path
					if (je.contains("mods") && je["mods"].is_array()) {
						for (const auto& m : je["mods"])
							if (m.is_number_unsigned())
								e.mods.push_back(m.get<std::uint32_t>());
					}
					const bool validKey = ValidDevice(e.device) && e.code != 0;
					const bool validAction = e.device == "action" && !e.action.empty();
					// VirtualKey trigger: code is a virtual-key value (100000..9999999),
					// not a scancode, so ValidDevice/validKey can't vouch for it.
					const bool validVKey = e.device == "vkey" && VKey::IsVirtualKey(static_cast<std::int32_t>(e.code));
					if (e.id.empty() || (!validKey && !validAction && !validVKey))
						continue;
					c.entries.push_back(std::move(e));
				}
			}
			// Deliberately-deleted built-ins (see the Config struct comment).
			if (j.contains("suppressedSeeds") && j["suppressedSeeds"].is_array()) {
				for (const auto& v : j["suppressedSeeds"])
					if (v.is_string() && out.suppressedSeeds.size() < 64)
						out.suppressedSeeds.push_back(v.get<std::string>());
			}
			// Favorites Shelf — raw passthrough (see the Config struct comment).
			// The cap is the only rule: a runaway payload must not bloat
			// hotkeys.json, and dump() on the sub-object cannot throw for the
			// invalid-UTF-8 case (parse already normalised it).
			if (j.contains("shelf") && j["shelf"].is_object()) {
				if (j["shelf"].dump(-1, ' ', false, nlohmann::json::error_handler_t::replace).size() <= 262144)
					c.shelf = j["shelf"];
				else
					logger::warn("shelf slice over 256KB - refused, shelf resets (view caps pins at 96, this cannot happen legitimately)");
			}
			// Wheel Menu: same contract, same cap. 12 wheels x 16 slots is the
			// view's own ceiling, so a payload anywhere near this is corruption.
			if (j.contains("wheel") && j["wheel"].is_object()) {
				if (j["wheel"].dump(-1, ' ', false, nlohmann::json::error_handler_t::replace).size() <= 262144)
					c.wheel = j["wheel"];
				else
					logger::warn("wheel slice over 256KB - refused, wheels reset (view caps at 12 wheels x 16 slots)");
			}
			// Character Sheet meta — capped free-text fields, portrait path
			// validated on the way in (a hand-edited hotkeys.json is untrusted).
			// Each field just falls back to "" when absent or the wrong type, so
			// a partial slice never wipes a sibling field.
			if (j.contains("charsheet") && j["charsheet"].is_object()) {
				const auto& cs = j["charsheet"];
				auto pull = [&](const char* key, std::string& dst) {
					if (cs.contains(key) && cs[key].is_string()) {
						std::string v = cs[key].get<std::string>();
						const auto cap = CharSheet::MetaTextCap(key);
						if (v.size() > cap)
							v.resize(cap);
						dst = std::move(v);
					}
				};
				pull("charClass", c.charSheet.charClass);
				pull("alignment", c.charSheet.alignment);
				pull("title", c.charSheet.title);
				pull("eyeColor", c.charSheet.eyeColor);
				pull("height", c.charSheet.height);
				pull("age", c.charSheet.age);
				pull("homeland", c.charSheet.homeland);
				pull("deity", c.charSheet.deity);
				pull("background", c.charSheet.background);
				pull("history", c.charSheet.history);
				std::string portrait;
				if (cs.contains("portrait") && cs["portrait"].is_string()) {
					portrait = cs["portrait"].get<std::string>();
					if (portrait.size() > CharSheet::MetaTextCap("portrait"))
						portrait.resize(CharSheet::MetaTextCap("portrait"));
				}
				if (CharSheet::ValidPortraitPath(portrait))  // rewrites '\' to '/', "" ok
					c.charSheet.portrait = std::move(portrait);
			}
			out = std::move(c);
			return true;
		} catch (const std::exception& ex) {
			logger::error("config parse error: {}", ex.what());
			return false;
		}
	}

	// ----------------------------------------------------- magic (de)serialize

	MagicConfig DefaultMagicConfig()
	{
		MagicConfig m;
		m.categories = { "Destruction", "Restoration", "Alteration", "Conjuration", "Illusion" };
		return m;  // no spells until the player adds them in-game
	}

	json MetaToJson(const SpellMeta& r)
	{
		return json{
			{ "plugin", r.plugin },
			{ "localId", r.localId },
			{ "formId", r.formId },
			{ "name", r.name },
			{ "type", r.type },
			{ "school", r.school },
			{ "element", r.element },
			{ "archetype", r.archetype },
			{ "tier", r.tier },
			{ "icon", r.icon } };
	}

	// Returns false when the snapshot is unresolvable (no plugin AND no formId).
	bool MetaFromJson(const json& jr, SpellMeta& r)
	{
		if (!jr.is_object())
			return false;
		r.plugin = jr.value("plugin", std::string(""));
		r.localId = jr.value("localId", 0u);
		r.formId = jr.value("formId", 0u);
		r.name = jr.value("name", std::string("spell"));
		r.type = jr.value("type", std::string(""));
		r.school = jr.value("school", std::string(""));
		r.element = jr.value("element", std::string(""));
		r.archetype = jr.value("archetype", std::string(""));
		r.tier = jr.value("tier", std::string(""));
		r.icon = jr.value("icon", std::string(""));
		return !(r.plugin.empty() && r.formId == 0);
	}

	json MagicConfigToJson(const MagicConfig& m)
	{
		json spells = json::array();
		for (const auto& s : m.spells) {
			spells.push_back(json{
				{ "id", s.id },
				{ "plugin", s.plugin },
				{ "localId", s.localId },
				{ "formId", s.formId },
				{ "name", s.name },
				{ "mode", s.mode },
				{ "hand", s.hand },
				{ "category", s.category },
				{ "slot", s.slot },
				{ "school", s.school },
				{ "element", s.element },
				{ "archetype", s.archetype },
				{ "tier", s.tier },
				{ "icon", s.icon } });
		}
		json combos = json::array();
		for (const auto& c : m.combos) {
			json members = json::array();
			for (const auto& r : c.spells)
				members.push_back(MetaToJson(r));
			combos.push_back(json{
				{ "id", c.id },
				{ "name", c.name },
				{ "spells", members } });
		}
		json removed = json::array();
		for (const auto& r : m.removed)
			removed.push_back(MetaToJson(r));
		json catIcons = json::object();
		for (const auto& [name, icon] : m.catIcons)
			catIcons[name] = icon;
		return json{
			{ "openKey", json{ { "device", m.openDevice }, { "code", m.openCode }, { "label", m.openLabel } } },
			{ "addKey", json{ { "device", m.addDevice }, { "code", m.addCode }, { "label", m.addLabel } } },
			{ "removeOnAdd", m.removeOnAdd },
			{ "uiScale", m.uiScale },
			{ "iconPx", m.iconPx },
			{ "panelW", m.panelW },
			{ "panelH", m.panelH },
			{ "categories", m.categories },
			{ "spells", spells },
			{ "combos", combos },
			{ "removed", removed },
			{ "catIcons", catIcons } };
	}

	void MagicConfigFromJson(const json& j, MagicConfig& out)
	{
		MagicConfig m;
		if (j.is_object()) {
			if (j.contains("openKey") && j["openKey"].is_object()) {
				const auto& ok = j["openKey"];
				auto dev = ok.value("device", std::string("keyboard"));
				auto code = ok.value("code", 105u);
				if (ValidDevice(dev) && code > 0) {
					m.openDevice = dev;
					m.openCode = code;
					m.openLabel = ok.value("label", std::string("F18"));
				}
			}
			if (j.contains("addKey") && j["addKey"].is_object()) {
				const auto& ak = j["addKey"];
				auto dev = ak.value("device", std::string("keyboard"));
				auto code = ak.value("code", 0x4Eu);
				if (ValidDevice(dev) && code > 0) {
					m.addDevice = dev;
					m.addCode = code;
					m.addLabel = ak.value("label", std::string("Num +"));
				}
			}
			m.removeOnAdd = j.value("removeOnAdd", false);
			m.uiScale = j.value("uiScale", 1.0);
			m.iconPx = j.value("iconPx", 0);
			m.panelW = j.value("panelW", 0);
			m.panelH = j.value("panelH", 0);
			if (j.contains("categories") && j["categories"].is_array()) {
				for (const auto& cat : j["categories"])
					if (cat.is_string() && !cat.get<std::string>().empty())
						m.categories.push_back(cat.get<std::string>());
			}
			if (j.contains("catIcons") && j["catIcons"].is_object()) {
				for (const auto& [name, v] : j["catIcons"].items()) {
					if (name.empty() || !v.is_string())
						continue;
					auto icon = v.get<std::string>();  // non-const: the scrub normalises in place
					// Same scrub as every stored icon path — a hand-edited config
					// must never hand the webview a filesystem path.
					if (icon.empty() || !ValidViewIconPath(icon))
						continue;
					if (m.catIcons.size() >= kMaxSpellCatIcons)
						break;
					m.catIcons[name] = icon;
				}
			}
			if (j.contains("spells") && j["spells"].is_array()) {
				for (const auto& js : j["spells"]) {
					if (!js.is_object())
						continue;
					SpellEntry s;
					s.id = js.value("id", std::string(""));
					s.plugin = js.value("plugin", std::string(""));
					s.localId = js.value("localId", 0u);
					s.formId = js.value("formId", 0u);
					s.name = js.value("name", std::string("spell"));
					s.mode = js.value("mode", std::string("cast"));
					s.hand = js.value("hand", std::string("right"));
					s.category = js.value("category", std::string(""));
					s.slot = js.value("slot", std::string(""));
					s.school = js.value("school", std::string(""));
					s.element = js.value("element", std::string(""));
					s.archetype = js.value("archetype", std::string(""));
					s.tier = js.value("tier", std::string(""));
					s.icon = js.value("icon", std::string(""));
					if (!ValidViewIconPath(s.icon))
						s.icon.clear();  // same scrub as entries[].icon — never trust a stored path
					if (s.mode != "cast" && s.mode != "equip")
						s.mode = "cast";
					if (s.hand != "left" && s.hand != "right" && s.hand != "both")
						s.hand = "right";
					if (s.id.empty() || (s.plugin.empty() && s.formId == 0))
						continue;  // unresolvable — drop it
					m.spells.push_back(std::move(s));
				}
			}
			if (j.contains("combos") && j["combos"].is_array()) {
				for (const auto& jc : j["combos"]) {
					if (!jc.is_object())
						continue;
					ComboEntry c;
					c.id = jc.value("id", std::string(""));
					c.name = jc.value("name", std::string(""));
					if (jc.contains("spells") && jc["spells"].is_array()) {
						for (const auto& jr : jc["spells"]) {
							SpellMeta r;
							if (MetaFromJson(jr, r))
								c.spells.push_back(std::move(r));
						}
					}
					if (c.id.empty() || c.spells.empty())
						continue;  // unaddressable / nothing to cast — drop it
					m.combos.push_back(std::move(c));
				}
			}
			if (j.contains("removed") && j["removed"].is_array()) {
				for (const auto& jr : j["removed"]) {
					SpellMeta r;
					if (MetaFromJson(jr, r))
						m.removed.push_back(std::move(r));
				}
			}
		}
		if (m.categories.empty())
			m.categories = DefaultMagicConfig().categories;
		out = std::move(m);
	}

	// ------------------------------------------------- followers (de)serialize

	// THE one place the crop invariant lives on this side; followers-pane.js
	// clampCrop() is its twin and the two must agree, because either side can be
	// the last to touch a value. Returns false for "nothing to store": an
	// identity crop is not a crop, and keeping it would grow the map with rows
	// that draw nothing.
	bool ClampPortraitCrop(PortraitCrop& c)
	{
		const auto finite = [](double v) { return std::isfinite(v); };
		if (!finite(c.z))
			c.z = 1.0;
		c.z = std::clamp(c.z, 1.0, 4.0);
		const double lim = (c.z - 1.0) / 2.0;
		if (!finite(c.x))
			c.x = 0.0;
		if (!finite(c.y))
			c.y = 0.0;
		c.x = std::clamp(c.x, -lim, lim);
		c.y = std::clamp(c.y, -lim, lim);
		// Same 4dp the view rounds to, so a value that round-trips through JSON
		// compares equal to the one the editor sent.
		const auto r4 = [](double v) { return std::round(v * 1e4) / 1e4; };
		c.z = r4(c.z);
		c.x = r4(c.x);
		c.y = r4(c.y);
		return !(c.z == 1.0 && c.x == 0.0 && c.y == 0.0);
	}

	// A crop key names a SIBLING inside PrismaUI/views/HotkeyDeck/portraits/.
	// Anything that could walk out of it is refused rather than sanitised — the
	// same rule fdPortraits' `file` follows on the view side.
	bool ValidPortraitFileName(const std::string& s)
	{
		if (s.empty() || s.size() > 160 || s == "." || s == "..")
			return false;
		return s.find('/') == std::string::npos && s.find('\\') == std::string::npos &&
		       s.find(':') == std::string::npos;
	}

	json FollowerConfigToJson(const FollowerConfig& f)
	{
		json crops = json::object();
		for (const auto& [file, c] : f.portraitCrops)
			crops[file] = json{ { "z", c.z }, { "x", c.x }, { "y", c.y } };
		// Object keyed by the index rendered as text: JSON has no integer keys,
		// and an array would be sparse-with-holes for the common case of two or
		// three decorated categories out of 25.
		json cicons = json::object();
		for (const auto& [idx, path] : f.catIcons)
			cicons[std::to_string(idx)] = path;
		return json{
			{ "openKey", json{ { "device", f.openDevice }, { "code", f.openCode }, { "label", f.openLabel } } },
			{ "uiScale", f.uiScale },
			{ "avatarPx", f.avatarPx },
			{ "fqLabels", f.fqLabels },
			{ "railCollapsed", f.railCollapsed },
			{ "railIconPct", f.railIconPct },
			{ "catIcons", std::move(cicons) },
			{ "portraitCrops", std::move(crops) } };
	}

	// NOTE the `out` contract for portraitCrops AND catIcons: a payload with NO
	// such key KEEPS whatever `out` already held. That is what lets a save which
	// carries only part of the slice round-trip it without wiping a map it does
	// not own — the exact trap that bit portraitCrops and tabScales. Every other
	// field is still replaced wholesale, as it always was.
	void FollowerConfigFromJson(const json& j, FollowerConfig& out)
	{
		FollowerConfig f;
		f.portraitCrops = out.portraitCrops;
		f.catIcons = out.catIcons;
		if (j.is_object() && j.contains("catIcons") && j["catIcons"].is_object()) {
			f.catIcons.clear();
			for (const auto& [key, v] : j["catIcons"].items()) {
				if (f.catIcons.size() >= kMaxCatIcons)
					break;
				if (!v.is_string())
					continue;
				// Hand-parsed rather than std::stoi: the key comes from a JSON
				// file a human may have edited, and stoi THROWS on "abc" —
				// inside config load that is a lost config, not a bad icon.
				// Digits-only and <= 3 chars, so the accumulate below cannot
				// overflow and no locale/whitespace parsing is involved.
				if (key.empty() || key.size() > 3 ||
					key.find_first_not_of("0123456789") != std::string::npos)
					continue;
				int idx = 0;
				for (const char ch : key)
					idx = idx * 10 + (ch - '0');
				if (idx < 0 || idx > kFolCatMax)
					continue;
				auto path = v.get<std::string>();
				// Same rule as every other icon the deck stores: view-relative,
				// under icons/, no escape. A refused path clears rather than
				// keeps, so a bad edit degrades to "no icon", never to a broken
				// <img> the player cannot see to fix.
				if (path.empty() || !ValidViewIconPath(path))
					continue;
				f.catIcons[idx] = path;
			}
		}
		if (j.is_object() && j.contains("portraitCrops") && j["portraitCrops"].is_object()) {
			f.portraitCrops.clear();
			for (const auto& [file, v] : j["portraitCrops"].items()) {
				if (f.portraitCrops.size() >= kMaxPortraitCrops)
					break;
				if (!ValidPortraitFileName(file) || !v.is_object())
					continue;
				// is_number() rather than value<double>(): hotkeys.json is
				// hand-editable, and value() on a string THROWS type_error —
				// inside config load that is a lost config, not a bad crop.
				const auto num = [&v](const char* k, double d) {
					return (v.contains(k) && v[k].is_number()) ? v[k].get<double>() : d;
				};
				PortraitCrop c;
				c.z = num("z", 1.0);
				c.x = num("x", 0.0);
				c.y = num("y", 0.0);
				if (ClampPortraitCrop(c))
					f.portraitCrops[file] = c;
			}
		}
		if (j.is_object()) {
			if (j.contains("openKey") && j["openKey"].is_object()) {
				const auto& ok = j["openKey"];
				auto dev = ok.value("device", std::string("keyboard"));
				auto code = ok.value("code", 101u);
				if (ValidDevice(dev) && code > 0) {
					f.openDevice = dev;
					f.openCode = code;
					f.openLabel = ok.value("label", std::string("F14"));
				}
			}
			// Both clamped HERE as well as in the view: a hand-edited hotkeys.json
			// is the one input the view never sees, and a 4000 px avatar (or a
			// 50x tab scale) would make the roster unusable with no obvious way
			// back. The view's own bounds are the same numbers.
			const double sc = j.value("uiScale", 1.0);
			f.uiScale = (sc > 0.0) ? std::clamp(sc, 0.6, 1.6) : 1.0;
			const int px = j.value("avatarPx", 0);
			f.avatarPx = (px <= 0) ? 0 : std::clamp(px, 28, 128);
			f.fqLabels = j.value("fqLabels", f.fqLabels);   // quick-card action-labels pref; keep seeded value when omitted
			f.railCollapsed = j.value("railCollapsed", f.railCollapsed);   // collapsed-rail pref; keep seeded value when omitted
			// Category-icon scale: keep the seeded/prior value when omitted (an
			// older view, or the portal, saving only the chrome fields), then
			// clamp. 50..300% — the view's own stepper bounds are the same.
			const int icp = j.value("railIconPct", f.railIconPct);
			f.railIconPct = std::clamp(icp <= 0 ? 100 : icp, 50, 300);
			logger::info("[followers] rail-icon-scale {}%", f.railIconPct);  // marker: followers-railicon-scale
		}
		out = std::move(f);
	}

	// ---------------------------------------------------- domains (de)serialize

	DomainsConfig DefaultDomainsConfig()
	{
		DomainsConfig d;
		d.categories = { "Estates", "Cities", "Dungeons", "Wilderness" };
		return d;  // no marks until the player marks a spot in-game
	}

	// One tag as it is stored: trimmed, inner runs of whitespace collapsed to a
	// single space, capped. Returns "" for anything that normalises to nothing —
	// the caller drops those rather than storing an empty chip.
	std::string NormalizeTag(std::string t)
	{
		std::string out;
		out.reserve(t.size());
		bool pendingSpace = false;
		for (unsigned char ch : t) {
			// Control bytes would draw as nothing and break a one-line chip; the
			// high range is left alone so an accented tag survives intact.
			if (ch < 0x20 || ch == 0x7F)
				ch = ' ';
			if (ch == ' ' || ch == '\t') {
				pendingSpace = !out.empty();
				continue;
			}
			if (pendingSpace) {
				out.push_back(' ');
				pendingSpace = false;
			}
			out.push_back(static_cast<char>(ch));
			if (out.size() >= kMaxTagLen)
				break;
		}
		return out;
	}

	std::string FoldTag(const std::string& t)
	{
		std::string f = t;
		std::transform(f.begin(), f.end(), f.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return f;
	}

	// Normalise + de-duplicate (case-insensitively, first spelling wins) + cap.
	// The ONE place tags become storable on this side; the view's mergeTags() is
	// its twin, because hotkeys.json is hand-editable and either side can be the
	// last to touch the list.
	std::vector<std::string> NormalizeTags(const json& arr)
	{
		std::vector<std::string> out;
		if (!arr.is_array())
			return out;   // a hand-edited object/string/number degrades to "no tags"
		std::set<std::string> seen;
		for (const auto& v : arr) {
			if (!v.is_string())
				continue;
			auto t = NormalizeTag(v.get<std::string>());
			if (t.empty())
				continue;
			if (!seen.insert(FoldTag(t)).second)
				continue;
			out.push_back(std::move(t));
			if (out.size() >= kMaxTagsPerMark)
				break;
		}
		return out;
	}

	json MarkToJson(const PlaceMark& m)
	{
		return json{
			{ "id", m.id },
			{ "name", m.name },
			{ "category", m.category },
			{ "parentId", m.parentId },
			{ "note", m.note },
			{ "tags", m.tags },
			{ "image", m.image },
			{ "cellName", m.cellName },
			{ "cellId", m.cellId },
			{ "cellEdid", m.cellEdid },
			{ "worldspaceId", m.worldspaceId },
			{ "worldspaceName", m.worldspaceName },
			{ "interior", m.interior },
			{ "x", m.x },
			{ "y", m.y },
			{ "z", m.z },
			{ "angleZ", m.angleZ } };
	}

	// Returns false when the mark can no longer address a cell — dropped on load.
	bool MarkFromJson(const json& jm, PlaceMark& m)
	{
		if (!jm.is_object())
			return false;
		m.id = jm.value("id", std::string(""));
		m.name = jm.value("name", std::string("Unnamed domain"));
		m.category = jm.value("category", std::string(""));
		m.parentId = jm.value("parentId", std::string(""));  // "" = top-level; never dropped
		m.note = jm.value("note", std::string(""));
		// A payload that OMITS "tags" / "image" leaves them empty here; the
		// caller (DomainsConfigFromJson) then carries the previous value over by
		// id, so an older view build — or any partial save — can never wipe
		// them. A payload that CARRIES the key wins outright, which is how
		// removing the last tag and clearing a photo work.
		m.tags = NormalizeTags(jm.contains("tags") ? jm["tags"] : json::array());
		m.image = jm.value("image", std::string(""));
		m.cellName = jm.value("cellName", std::string(""));
		m.cellId = jm.value("cellId", 0u);
		m.cellEdid = jm.value("cellEdid", std::string(""));
		m.worldspaceId = jm.value("worldspaceId", 0u);
		m.worldspaceName = jm.value("worldspaceName", std::string(""));
		m.interior = jm.value("interior", true);
		m.x = jm.value("x", 0.0f);
		m.y = jm.value("y", 0.0f);
		m.z = jm.value("z", 0.0f);
		m.angleZ = jm.value("angleZ", 0.0f);
		return !m.id.empty() && (m.cellId != 0 || !m.cellEdid.empty());
	}

	json DomainsConfigToJson(const DomainsConfig& d)
	{
		json marks = json::array();
		for (const auto& m : d.marks)
			marks.push_back(MarkToJson(m));
		json crops = json::object();
		for (const auto& [file, c] : d.imageCrops)
			crops[file] = json{ { "z", c.z }, { "x", c.x }, { "y", c.y } };
		return json{
			{ "openKey", json{ { "device", d.openDevice }, { "code", d.openCode }, { "label", d.openLabel } } },
			{ "uiScale", d.uiScale },
			{ "thumbSize", d.thumbSize },
			{ "categories", d.categories },
			{ "imageCrops", std::move(crops) },
			{ "marks", marks } };
	}

	// NOTE the `out` contract, which is what makes a PARTIAL save safe. Two
	// fields survive a payload that does not mention them:
	//
	//   imageCrops — kept wholesale unless the payload carries the key. The
	//                view's pdSave sends marks/categories/settings and nothing
	//                else, so without this every rename would wipe every crop.
	//   marks[].tags / marks[].image — carried over PER MARK, by id, when that
	//                mark object omits the key. That is what stops an older view
	//                build (or the Deck Portal, or a hand-written payload) from
	//                silently deleting a photo or a tag list it never knew about.
	//
	// Everything else is still replaced wholesale, as it always was. `out` is the
	// PREVIOUS config, so every call site must pass the live one — OnJsPlaceSave
	// seeds from g_domConfig for exactly this reason.
	void DomainsConfigFromJson(const json& j, DomainsConfig& out)
	{
		DomainsConfig d;
		d.imageCrops = out.imageCrops;
		if (j.is_object()) {
			if (j.contains("openKey") && j["openKey"].is_object()) {
				const auto& ok = j["openKey"];
				auto        dev = ok.value("device", std::string("keyboard"));
				auto        code = ok.value("code", 102u);
				if (ValidDevice(dev) && code > 0) {
					d.openDevice = dev;
					d.openCode = code;
					d.openLabel = ok.value("label", std::string("F15"));
				}
			}
			d.uiScale = j.value("uiScale", 1.0);
			d.thumbSize = j.value("thumbSize", 1.0);
			if (j.contains("categories") && j["categories"].is_array()) {
				for (const auto& c : j["categories"])
					if (c.is_string() && !c.get<std::string>().empty())
						d.categories.push_back(c.get<std::string>());
			}
			if (j.contains("marks") && j["marks"].is_array()) {
				for (const auto& jm : j["marks"]) {
					PlaceMark m;
					if (!MarkFromJson(jm, m))
						continue;
					const bool hasTags = jm.is_object() && jm.contains("tags");
					const bool hasImage = jm.is_object() && jm.contains("image");
					if (!hasTags || !hasImage) {
						for (const auto& prev : out.marks) {
							if (prev.id != m.id)
								continue;
							if (!hasTags)
								m.tags = prev.tags;
							if (!hasImage)
								m.image = prev.image;
							break;
						}
					}
					d.marks.push_back(std::move(m));
				}
			}
			if (j.contains("imageCrops") && j["imageCrops"].is_object()) {
				d.imageCrops.clear();
				for (const auto& [file, v] : j["imageCrops"].items()) {
					if (d.imageCrops.size() >= Wardrobe::kMaxImageCrops)
						break;
					if (!Wardrobe::ValidImageFileName(file) || !v.is_object())
						continue;
					// is_number() rather than value<double>(): hotkeys.json is
					// hand-editable and value() on a string THROWS type_error —
					// inside config load that is a lost config, not a bad crop.
					const auto num = [&v](const char* k, double dv) {
						return (v.contains(k) && v[k].is_number()) ? v[k].get<double>() : dv;
					};
					Wardrobe::ImageCrop c;
					c.z = num("z", 1.0);
					c.x = num("x", 0.0);
					c.y = num("y", 0.0);
					if (Wardrobe::ClampImageCrop(c))
						d.imageCrops[file] = c;
				}
			}
		}
		if (d.categories.empty())
			d.categories = DefaultDomainsConfig().categories;
		out = std::move(d);
	}

	// -------------------------------------------------- containers (de)serialize

	ContainerConfig DefaultContainerConfig()
	{
		ContainerConfig c;
		c.categories = { "Home", "Storage", "Dungeons", "Shops" };
		return c;  // no marks until the player marks a container in-game
	}

	json ContMarkToJson(const ContainerMark& m)
	{
		return json{
			{ "id", m.id }, { "name", m.name }, { "category", m.category },
			{ "note", m.note }, { "image", m.image },
			{ "plugin", m.plugin }, { "localId", m.localId },
			{ "cellName", m.cellName }, { "cellId", m.cellId }, { "cellEdid", m.cellEdid },
			{ "worldspaceId", m.worldspaceId }, { "worldspaceName", m.worldspaceName },
			{ "interior", m.interior },
			{ "x", m.x }, { "y", m.y }, { "z", m.z }, { "angleZ", m.angleZ } };
	}

	// Returns false when the mark can no longer address a container reference —
	// dropped on load. Identity is (plugin, localId); a mark missing either is junk.
	bool ContMarkFromJson(const json& jm, ContainerMark& m)
	{
		if (!jm.is_object())
			return false;
		m.id = jm.value("id", std::string(""));
		m.name = jm.value("name", std::string("Container"));
		m.category = jm.value("category", std::string(""));
		m.note = jm.value("note", std::string(""));
		// image OMITTED leaves it empty here; the caller carries the previous value
		// over by id so an older view / the portal can't wipe a photo (same contract
		// DomainsConfigFromJson honours for marks[].image).
		m.image = jm.value("image", std::string(""));
		m.plugin = jm.value("plugin", std::string(""));
		m.localId = jm.value("localId", 0u);
		m.cellName = jm.value("cellName", std::string(""));
		m.cellId = jm.value("cellId", 0u);
		m.cellEdid = jm.value("cellEdid", std::string(""));
		m.worldspaceId = jm.value("worldspaceId", 0u);
		m.worldspaceName = jm.value("worldspaceName", std::string(""));
		m.interior = jm.value("interior", true);
		m.x = jm.value("x", 0.0f);
		m.y = jm.value("y", 0.0f);
		m.z = jm.value("z", 0.0f);
		m.angleZ = jm.value("angleZ", 0.0f);
		return !m.id.empty() && !m.plugin.empty() && m.localId != 0;
	}

	json ContainerConfigToJson(const ContainerConfig& c)
	{
		json marks = json::array();
		for (const auto& m : c.marks)
			marks.push_back(ContMarkToJson(m));
		return json{
			{ "openKey", json{ { "device", c.openDevice }, { "code", c.openCode }, { "label", c.openLabel } } },
			{ "uiScale", c.uiScale },
			{ "thumbSize", c.thumbSize },
			{ "categories", c.categories },
			{ "marks", marks } };
	}

	// `out` is the PREVIOUS config: a mark object that OMITS "image" keeps its
	// prior photo (carried over by id), exactly like the Domains slice — so a
	// partial ctSave (or a portal replay) can never wipe a picture it never knew.
	void ContainerConfigFromJson(const json& j, ContainerConfig& out)
	{
		ContainerConfig c;
		if (j.is_object()) {
			if (j.contains("openKey") && j["openKey"].is_object()) {
				const auto& ok = j["openKey"];
				auto        dev = ok.value("device", std::string("keyboard"));
				auto        code = ok.value("code", 103u);
				if (ValidDevice(dev) && code > 0) {
					c.openDevice = dev;
					c.openCode = code;
					c.openLabel = ok.value("label", std::string("F16"));
				}
			}
			c.uiScale = j.value("uiScale", 1.0);
			c.thumbSize = j.value("thumbSize", 1.0);
			if (j.contains("categories") && j["categories"].is_array()) {
				for (const auto& cc : j["categories"])
					if (cc.is_string() && !cc.get<std::string>().empty())
						c.categories.push_back(cc.get<std::string>());
			}
			if (j.contains("marks") && j["marks"].is_array()) {
				for (const auto& jm : j["marks"]) {
					ContainerMark m;
					if (!ContMarkFromJson(jm, m))
						continue;
					const bool hasImage = jm.is_object() && jm.contains("image");
					if (!hasImage) {
						for (const auto& prev : out.marks)
							if (prev.id == m.id) { m.image = prev.image; break; }
					}
					c.marks.push_back(std::move(m));
				}
			}
		}
		if (c.categories.empty())
			c.categories = DefaultContainerConfig().categories;
		out = std::move(c);
	}

	// Single writer for ALL config slices — the deck under the root keys, the
	// Spell Deck under "magic", the Followers tab under "followers", the
	// Domains tab under "domains" — so no save path clobbers another's data.
	bool WriteConfigFile(const Config& c, const MagicConfig& m, const FollowerConfig& f, const DomainsConfig& d,
		const ContainerConfig& ct,
		const Finance::Config& fin, const Wardrobe::Config& wd, const NffOutfits::Config& nf,
		const RoomGuard::Config& rg, const FollowerTune::Config& tn, const LootHighlight::Config& lt,
		const FollowersHud::Config& hd, const NoAutoGear::Config& ng, const SpidGear::Config& sg,
		const Hotbar::Config& hb)
	{
		std::lock_guard w(g_writeMutex);  // one writer at a time; never nested in g_configMutex
		try {
			const auto path = ConfigPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);

			// Serialise BEFORE touching the file. Opening with trunc destroys the
			// existing config, and ConfigToJson/dump() can throw (bad_alloc, or
			// type_error.316 on invalid UTF-8 in a user-typed name) — a throw after
			// the truncate would leave a ZERO-LENGTH hotkeys.json and there is no
			// rotation to fall back on. The portal poller now writes on every phone
			// edit, so this window is hit far more often than when it was written.
			json j = ConfigToJson(c);
			j["magic"] = MagicConfigToJson(m);
			j["followers"] = FollowerConfigToJson(f);
			j["domains"] = DomainsConfigToJson(d);
			j["containers"] = ContainerConfigToJson(ct);
			j["finances"] = Finance::ToJson(fin);
			j["wardrobe"] = Wardrobe::ToJson(wd);
			j["nffOutfits"] = NffOutfits::ToJson(nf);
			j["rooms"] = RoomGuard::ToJson(rg);
			j["tuning"] = FollowerTune::ToJson(tn);
			j["loot"] = LootHighlight::ToJson(lt);
			j["hud"] = FollowersHud::ToJson(hd);
			j["noAutoGear"] = NoAutoGear::ToJson(ng);
			j["spidGear"] = SpidGear::ToJson(sg);
			j["hotbar"] = Hotbar::ToJson(hb);
			const std::string text = j.dump(2);

			// One rotating backup, so even a torn write (power loss mid-flush) is
			// recoverable by hand. Best-effort: a failed copy must not block the save.
			if (std::filesystem::exists(path, ec)) {
				auto bak = path;
				bak.replace_extension(".bak");
				std::filesystem::copy_file(path, bak, std::filesystem::copy_options::overwrite_existing, ec);
			}

			// Atomic replace: write the full text to a sibling temp file, flush,
			// close, then rename over the real one. NTFS rename is atomic, so a
			// crash mid-save leaves either the OLD file or the NEW file — never a
			// torn fragment (the rig BSOD'd mid-session on 2026-08-12; a truncate-
			// in-place write here would have gambled the whole config on timing).
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::error("could not open {} for writing", tmp.string());
					return false;
				}
				out << text;
				out.flush();
				if (!out.good()) {
					logger::error("config write to {} failed mid-stream", tmp.string());
					return false;
				}
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec) {
				logger::error("atomic config swap failed: {}", ec.message());
				return false;
			}
			return true;
		} catch (const std::exception& ex) {
			logger::error("config save error: {}", ex.what());
			return false;
		}
	}

	// Snapshot every in-memory slice under the lock, then write outside it.
	bool PersistAll()
	{
		Config          c;
		MagicConfig     m;
		FollowerConfig  f;
		DomainsConfig   d;
		ContainerConfig ct;
		Finance::Config fin;
		Wardrobe::Config wd;
		NffOutfits::Config nf;
		RoomGuard::Config rg;
		FollowerTune::Config tn;
		LootHighlight::Config lt;
		FollowersHud::Config hd;
		NoAutoGear::Config ng;
		SpidGear::Config sg;
		Hotbar::Config hb;
		{
			std::lock_guard l(g_configMutex);
			c = g_config;
			m = g_magicConfig;
			f = g_folConfig;
			d = g_domConfig;
			ct = g_contConfig;
			fin = g_finConfig;
			wd  = g_wardrobeConfig;
			nf  = g_nffConfig;
			rg  = g_roomConfig;
			tn  = g_tuneConfig;
			lt  = g_lootConfig;
			hd  = g_hudConfig;
			ng  = g_ngConfig;
			sg  = g_spidConfig;
			hb  = g_hbConfig;
		}
		return WriteConfigFile(c, m, f, d, ct, fin, wd, nf, rg, tn, lt, hd, ng, sg, hb);
	}

	// A native action added in a new build only reaches a player who already has
	// a hotkeys.json if we put it there: DefaultConfig() is consulted on a FRESH
	// install and never again. Seeding is keyed on the ACTION VERB, not the id,
	// so an entry the player renamed, re-filed or re-bound is recognised as
	// already present and never duplicated. Returns true if anything changed.
	bool SeedMissingActions(Config& c)
	{
		struct Seed
		{
			const char* action;
			const char* id;
			const char* name;
			const char* desc;
			const char* category;
			// View-relative icon path (icons/custom/<name>.png), or "" for none.
			// Seeds only touch MISSING entries, so this decorates fresh installs
			// and any row a user deleted-then-reseeded; existing configs keep
			// whatever icon (or none) they already saved. Scrubbed by
			// ValidViewIconPath before it reaches the webview, same as any icon.
			const char* icon = "";
		};
		static constexpr Seed kSeeds[] = {
			{ "portrait", "chim-portrait", "Capture Portrait",
			  "Photograph the targeted NPC's face and save it as their portrait", "CHIM", "icons/custom/hk-portrait.png" },
			// Unbound like the rest: guessing a key on someone else's keyboard
			// collides with whatever they already have bound, and the row is
			// usable as-is — click it, or give it a key in F2. (Rober's G12
			// already sends F22 and is labelled SAVE, if he wants one.)
			{ "full-save", "hd-full-save", "Full Save",
			  "Writes a real save file - not the quicksave slot", "Misc", "icons/custom/hk-full-save.png" },
			// Rober's call (2026-08-02): the resolver gets no raw hotkey of its
			// own — it lives HERE, placed/renamed/bound like any other entry.
			{ "anim-refresh", "anim-refresh", "Fix Stuck Animation",
			  "Can't jump, or weapon stuck half-drawn? Runs Animation Resolver's un-wedge + logs the state", "Fixes", "icons/custom/hk-anim-fix.png" },
			// Controls un-wedge (2026-08-03): a script disables player controls
			// or the journal and dies before re-enabling — Tab dead, red
			// Quests/General in Esc, saving refused — and the lock persists in
			// the save. One press clears every layer and logs what was wedged.
			// "red menu unstick" in the desc are omni keywords on purpose.
			{ "fix-controls", "hd-fix-controls", "Fix Stuck Controls",
			  "Tab dead, Quests/General red in the Esc menu, saving blocked? Clears wedged control locks - menu, journal, chargen, text-entry - and logs what was stuck (unstick red menus)", "Fixes", "icons/custom/hk-fix-controls.png" },
			// Groovatron in the desc on purpose — it doubles as an omni keyword.
			{ "grab", "npc-grab", "Grab NPC",
			  "Pick up the targeted NPC with Object Manipulation Overhaul (Groovatron-style): follows your crosshair, left-click places, right-click puts them back; stands up sitters", "NPC", "icons/custom/hk-grab.png" },
			// Instant waits (2026-08-02): the vanilla Sleep/Wait menu ticks one
			// hour per REAL frame and this rig's frame generation throttles real
			// frames, so the menu crawls at any displayed FPS. These jump the
			// clock in ONE step — "sleep wait fast" keywords for omni on purpose.
			{ "wait-1", "hd-wait-1", "Wait 1 Hour",
			  "Instantly pass 1 game hour - skips the slow sleep wait menu entirely (fast wait)", "Misc", "icons/custom/hk-wait-1.png" },
			{ "wait-6", "hd-wait-6", "Wait 6 Hours",
			  "Instantly pass 6 game hours - skips the slow sleep wait menu entirely (fast wait)", "Misc", "icons/custom/hk-wait-6.png" },
			{ "wait-12", "hd-wait-12", "Wait 12 Hours",
			  "Instantly pass 12 game hours - skips the slow sleep wait menu entirely (fast wait)", "Misc", "icons/custom/hk-wait-12.png" },
			{ "wait-24", "hd-wait-24", "Wait 24 Hours",
			  "Instantly pass 24 game hours - a full day in one step (fast sleep wait)", "Misc", "icons/custom/hk-wait-24.png" },
			// AddItemMenu (2026-08-03): the deck casts the mod's own lesser
			// powers, so its Papyrus flow runs exactly as shipped — no
			// inventory digging for the [AddItemMenuSE] items. Unbound like
			// the rest: click, or give either a trigger key in F2.
			{ "additem-menu", "hd-additem-menu", "AddItemMenu",
			  "Open AddItemMenu's mod-list popup - browse any installed mod's items and take them (add item menu)", "Misc", "icons/custom/hk-additem.png" },
			{ "additem-search", "hd-additem-search", "AddItemMenu: Search",
			  "Open AddItemMenu straight into name search - type an item name and take it (add item search)", "Misc", "icons/custom/hk-additem-search.png" },
			// Loot Highlighter (2026-08-04): master toggle for the glow scanner.
			// "loot vision glow highlight" keywords for omni on purpose; colours
			// and categories live in the deck's Loot tab.
			{ "loot-vision", "hd-loot-vision", "Loot Vision",
			  "Toggle loot glow highlights - chests, unlooted corpses, museum pieces the LOTD still wants, coins, potions, valuable gear (loot vision glow; configure in the Loot tab)", "Misc", "icons/custom/hk-loot-vision.png" },
			// No Auto-Gear (2026-08-09): tag the crosshair NPC so SPID/SkyPatcher
			// stop dumping cloaks/hoods/underwear on her, and strip what's worn.
			// "no auto gear cloak hood underwear spid distributor" omni keywords.
			{ "no-auto-gear", "npc-no-auto-gear", "No Auto-Gear",
			  "Toggle: stop distributor mods (SPID/SkyPatcher) putting cloaks, hoods or underwear on the NPC you're looking at, and strip what's there (no auto gear cloak hood underwear distributor)", "NPC", "icons/custom/hk-no-auto-gear.png" },
			{ "no-auto-gear-party", "npc-no-auto-gear-party", "No Auto-Gear: Party",
			  "Protect every follower with you right now from distributor cloaks/hoods/underwear (no auto gear party)", "NPC", "icons/custom/hk-no-auto-gear.png" },
			// Fixes / Unstuck (2026-08-09): one-click rescues for modded-game jank.
			// Console-backed, run on the crosshair NPC (or the player for noclip).
			// "unstuck fix stuck broken jank" omni keywords on purpose.
			{ "fix-recycle", "fix-recycle", "Unstick NPC",
			  "Rebuild the crosshair NPC's 3D and AI (recycleactor) - the fix for a T-posing, invisible, frozen or wedged follower (unstuck stuck broken)", "Fixes", "icons/custom/hk-fix-unstick.png" },
			{ "fix-resetai", "fix-resetai", "Reset AI",
			  "Re-evaluate the crosshair NPC's AI packages (resetai) - for someone stuck standing, not following, or ignoring their schedule (unstuck stuck)", "Fixes", "icons/custom/hk-fix-resetai.png" },
			{ "fix-calm", "fix-calm", "Calm NPC",
			  "Stop the crosshair NPC's combat and drop aggression to 0 - end a fight that should not be happening (pacify stop combat)", "Fixes", "icons/custom/hk-fix-calm.png" },
			{ "fix-resurrect", "fix-resurrect", "Resurrect NPC",
			  "Bring the crosshair corpse back keeping its inventory (resurrect 1) - undo a death you did not want", "Fixes", "icons/custom/hk-fix-resurrect.png" },
			{ "fix-noclip", "fix-noclip", "Toggle Noclip (me)",
			  "Toggle player collision (tcl) - walk out when you are stuck in geometry, fire again to turn it back on (unstuck noclip)", "Fixes", "icons/custom/hk-fix-noclip.png" },
			// Quick Light (2026-08-05): toggle the carried portable light. The
			// deck reads Quick Light SE's own state and calls its own CastLight
			// / RemoveLight. Lives in the Utilities category, where a live On/Off
			// card appears above the row. "quick light lantern torch glow"
			// keywords for omni on purpose.
			{ "quick-light", "hd-quick-light", "Quick Light",
			  "Toggle Quick Light on or off - your carried portable light; live On/Off card in the Utilities category (quick light lantern torch glow)", "Utilities", "icons/custom/hk-quick-light.png" },
			// Crawl toggle (2026-08-05): make the crosshair NPC (or you) crawl on
			// all fours — the moving-crawl half of the Animations tab, also bindable.
			{ "crawl", "hd-crawl", "Crawl",
			  "Make the NPC you are looking at (or yourself) crawl on all fours - toggle; separate from normal sneak (crawl all fours animation)", "NPC", "icons/custom/hk-crawl.png" },
			// Menus (2026-08-05): open another mod's settings menu from the deck
			// without a dedicated keyboard hotkey. Each synthesizes the exact key
			// that mod listens for, read live from its own config so a rebind
			// there stays honored. "mcm settings config" keywords for omni.
			{ "open-prisma-mcm", "hd-open-prisma-mcm", "Prisma MCM",
			  "Open the Prisma MCM Redux settings menu (the general PrismaUI MCM) - no hotkey needed (mcm settings config)", "Menus", "icons/custom/hk-prisma-mcm.png" },
			{ "open-smf", "hd-open-smf", "SKSE Menu",
			  "Open the SKSE Menu Framework menu - no hotkey needed; double-taps its toggle key for you (mcm settings config)", "Menus", "icons/custom/hk-skse-menu.png" },
			{ "open-community-shaders", "hd-open-community-shaders", "Community Shaders",
			  "Open the Community Shaders menu - needs Community Shaders installed (default key End) (settings config shaders enb)", "Menus", "icons/custom/hk-community-shaders.png" },
			// Rooms privacy (2026-08-11): seal the room you are standing in —
			// nobody in at all, followers and allowed people included — and fire
			// it again to go back to that room's normal welcome list. Bindable
			// like the rest, which is the point: it is a "not now" button you
			// want to hit without opening anything. "privacy lock seal keep out
			// nobody alone" keywords for omni on purpose.
			{ "room-privacy", "hd-room-privacy", "Privacy: Seal Room",
			  "Toggle: let NOBODY into the claimed room you are standing in right now - followers and allowed people too - then press again to go back to your normal who's-allowed settings (privacy lock seal keep everyone out alone do not disturb)", "Utilities", "icons/custom/hk-privacy.png" },
			// The wheel already has a chord (Ctrl + the open key). This seed is
			// so it can have a KEY as well - a spare mouse button, a Scimitar
			// side key - without touching the chord. "radial ring circle
			// favorites" in the desc are omni keywords on purpose.
			{ "wheel", "hd-wheel-open", "Wheel Menu",
			  "Open the radial wheel - a ring of anything you pinned to it: weapons, armour, potions, followers, outfits, spells, places. Also on Ctrl + your deck key (radial ring circle quick wheel favorites)", "Utilities", "icons/custom/hk-wheel.png" },
			// Hotbar (2026-08-11). TWO seeds, because they are two different
			// jobs: one shows/hides the bar mid-play, the other opens the panel
			// where you build it. Both unbound — the SETUP one is the entry
			// point, so its description is written to be findable in omni by
			// someone who does not yet know the bar exists ("action bar hotbar
			// spell bar wow buttons").
			{ "hotbar-toggle", "hd-hotbar-toggle", "Action Bar: Show/Hide",
			  "Show or hide the on-screen action bar without changing anything on it (hotbar spell bar quick bar buttons wow)", "Utilities", "icons/custom/hk-hotbar.png" },
			{ "hotbar-edit", "hd-hotbar-edit", "Action Bar: Set Up",
			  "Open the action bar's editor - choose how many buttons, one or two rows, horizontal or vertical, where it sits, which key fires each button, and what goes on the shift/ctrl/alt pages (hotbar spell bar action bar wow configure resize icons)", "Utilities", "icons/custom/hk-hotbar.png" },
		};

		// Plain key entries added in a new build. Keyed by ID rather than by a
		// verb, because a keystroke entry has no verb to match on — so unlike
		// the action seeds above, a RENAMED copy is not recognised. That is the
		// right trade here: the id is ours and the player has no reason to
		// change it, whereas re-seeding a duplicate would be worse.
		struct KeySeed
		{
			const char*   id;
			const char*   name;
			const char*   desc;
			std::uint32_t code;
			const char*   label;
			std::uint32_t mod;   // 0 = none
			const char*   category;
		};
		// Seeded UNBOUND (code 0), for the same reason as DefaultConfig's
		// keystroke rows: each one presses a key at ANOTHER mod, and only the
		// player knows what key that mod is set to. A wrong key is worse than
		// no key — it presses whatever that scancode happens to do on their
		// setup. SendScan(0) is a no-op, so an unbound row is an honest
		// labelled placeholder until F2 press-to-bind gives it a key.
		static constexpr KeySeed kKeySeeds[] = {
			{ "tailor-open", "Tailor (Outfits & Wigs)",
			  "Opens Tailor's outfit/wig manager. Unbound - set this to the key Tailor is configured with.", 0, "", 0, "Followers" },
			// OMO's Pick, as a deck button — fires the real key, so OMO's own
			// pick filter applies (objects, not NPCs; the NPC path is Grab).
			{ "omo-pick", "OMO: Pick Object",
			  "Object Manipulation Overhaul picks up the item under your crosshair (decorating; NPCs use the Grab action). Unbound - set this to OMO's pick key from its KeyConfiguration.txt.", 0, "", 0, "Misc" },
			// Two common combat keys, on the deck so they are clickable,
			// searchable and re-bindable in one place. Whichever mod owns them
			// reacts exactly as if the key had been pressed by hand.
			{ "grip-switch", "Grip Switch (1H / 2H)",
			  "Switches your weapon grip between one-handed and two-handed, if a mod of yours binds that (grip stance 1h 2h one handed two handed). Unbound - press F2 and set your key.", 0, "", 0, "Combat" },
			{ "combat-kick", "Kick",
			  "Fires your combat mod's kick (combat kick shove stagger knock back). Unbound - press F2 and set your key.", 0, "", 0, "Combat" },
		};

		bool changed = false;
		for (const auto& k : kKeySeeds) {
			const bool have = std::any_of(c.entries.begin(), c.entries.end(),
				[&](const HotkeyEntry& e) { return e.id == k.id; });
			if (have)
				continue;
			if (std::find(c.categories.begin(), c.categories.end(), k.category) == c.categories.end())
				c.categories.emplace_back(k.category);
			HotkeyEntry e;
			e.id = k.id;
			e.name = k.name;
			e.desc = k.desc;
			e.device = "keyboard";
			e.code = k.code;
			e.label = k.label;
			if (k.mod)
				e.mods.push_back(k.mod);
			e.category = k.category;
			c.entries.push_back(std::move(e));
			logger::info("seeded new hotkey '{}' into tab '{}'", k.name, k.category);
			changed = true;
		}

		for (const auto& s : kSeeds) {
			const bool have = std::any_of(c.entries.begin(), c.entries.end(),
				[&](const HotkeyEntry& e) { return e.device == "action" && e.action == s.action; });
			if (have)
				continue;
			// The user deleted this built-in on purpose — honor it. Without this
			// check every launch resurrected the row (2026-08-12 audit).
			if (std::find(c.suppressedSeeds.begin(), c.suppressedSeeds.end(), s.action) != c.suppressedSeeds.end()) {
				logger::info("seed-suppress: '{}' stays deleted by user choice", s.action);
				continue;
			}
			// Put the tab back too if it was deleted, or the entry would land in
			// a category the tab bar does not draw.
			if (std::find(c.categories.begin(), c.categories.end(), s.category) == c.categories.end())
				c.categories.emplace_back(s.category);
			HotkeyEntry e;
			e.id = s.id;
			e.name = s.name;
			e.desc = s.desc;
			e.device = "action";
			e.code = 0;  // deliberately unbound — fire it from the palette
			e.label = s.name;  // the key chip reads the verb, not a generic "Action"
			e.category = s.category;
			e.action = s.action;
			// Ship a matching gold-glyph icon on fresh seeds. Scrubbed like any
			// stored icon so a bad path can never reach the webview. Only lands
			// on entries that didn't already exist, so a user who cleared an
			// icon and kept the row keeps it cleared.
			if (s.icon && *s.icon) {
				std::string ic = s.icon;
				if (ValidViewIconPath(ic))
					e.icon = ic;
			}
			c.entries.push_back(std::move(e));
			logger::info("seeded new action entry '{}' into tab '{}' (icon '{}')", s.name, s.category, e.icon);
			changed = true;
		}

		// One-time re-file: the two pre-existing fix actions were seeded into
		// "Misc" before the Fixes tab existed. Move them to "Fixes" so every
		// rescue lives together (Rober, 2026-08-09). Guarded on category=="Misc"
		// so it runs effectively once and respects a later deliberate move.
		for (auto& e : c.entries) {
			if (e.device == "action" && e.category == "Misc" &&
				(e.action == "anim-refresh" || e.action == "fix-controls")) {
				e.category = "Fixes";
				if (std::find(c.categories.begin(), c.categories.end(), "Fixes") == c.categories.end())
					c.categories.emplace_back("Fixes");
				logger::info("re-filed fix action '{}' from Misc into Fixes", e.action);
				changed = true;
			}
		}
		return changed;
	}

	void LoadConfigInner();

	// Every json read below can THROW, not just fail: value() raises
	// type_error.302 when a key exists with the wrong type, and one such key in
	// hotkeys.json is enough. This runs at kDataLoaded, so an escaping exception
	// is std::terminate -> abort -> the game never reaches the main menu, with
	// no crash log that names us (see CRT Guard: __fastfail bypasses every
	// logger). It cannot happen on a config this build wrote; it happens to
	// someone who hand-edited theirs, or was handed one by a newer build.
	//
	// Recovery, not just survival: move the offending file aside and load again.
	// The retry finds no config, writes seeded defaults, and the player has a
	// working deck plus their original file kept as .bad for inspection.
	void LoadConfig()
	{
		try {
			LoadConfigInner();
			return;
		} catch (const std::exception& ex) {
			logger::error("config: hotkeys.json could not be loaded ({}) — moving it aside "
						  "and starting from defaults", ex.what());
		} catch (...) {
			logger::error("config: hotkeys.json could not be loaded (unknown error) — moving "
						  "it aside and starting from defaults");
		}

		std::error_code ec;
		const auto      path = ConfigPath();
		auto            bad = path;
		bad += ".bad";
		std::filesystem::remove(bad, ec);
		std::filesystem::rename(path, bad, ec);
		if (ec)
			std::filesystem::remove(path, ec);

		try {
			LoadConfigInner();
		} catch (...) {
			logger::error("config: defaults could not be seeded either — the deck will run "
						  "on an empty config this session");
		}
	}

	void LoadConfigInner()
	{
		const auto path = ConfigPath();
		std::ifstream in(path);
		if (in.is_open()) {
			std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			const auto j = json::parse(text, nullptr, false);
			Config c;
			if (!j.is_discarded() && ConfigFromJson(j, c)) {
				// Deliberately NOT persisted here: LoadConfig holds the config
				// mutex through to its return and PersistAll() takes it. The
				// seed is idempotent and runs on every load, so the entry is
				// present every session regardless, and the next config write
				// for any other reason commits it to disk.
				SeedMissingActions(c);
				// also the build marker for hd-build-deploy's anti-clobber check
				// (favorites-shelf) — LoadConfig runs on every kDataLoaded, so the
				// literal is provably reachable, never linker-stripped
				{
					std::size_t shelfPins = 0;
					if (c.shelf.contains("pins") && c.shelf["pins"].is_array())
						shelfPins = c.shelf["pins"].size();
					logger::info("favorites shelf: {} pins", shelfPins);
				}
				// Build marker (wheel-menu). Same reason as the line above: it
				// sits on the LoadConfig path, which runs on every kDataLoaded,
				// so the literal is provably reached and cannot be stripped —
				// which is what makes it usable as a deployed-DLL fingerprint.
				{
					std::size_t wheels = 0, pinned = 0;
					if (c.wheel.contains("wheels") && c.wheel["wheels"].is_array()) {
						wheels = c.wheel["wheels"].size();
						for (const auto& w : c.wheel["wheels"])
							if (w.is_object() && w.contains("slots") && w["slots"].is_array())
								for (const auto& s : w["slots"])
									if (s.is_object())
										++pinned;
					}
					logger::info("wheel menu: {} wheels, {} pinned slots", wheels, pinned);
				}
				MagicConfig m;
				if (j.is_object() && j.contains("magic"))
					MagicConfigFromJson(j["magic"], m);
				else
					m = DefaultMagicConfig();
				FollowerConfig f;
				FollowerConfigFromJson(j.is_object() ? j.value("followers", json::object()) : json::object(), f);
				DomainsConfig d;
				if (j.is_object() && j.contains("domains"))
					DomainsConfigFromJson(j["domains"], d);
				else
					d = DefaultDomainsConfig();
				ContainerConfig ctc;
				if (j.is_object() && j.contains("containers"))
					ContainerConfigFromJson(j["containers"], ctc);
				else
					ctc = DefaultContainerConfig();
				Finance::Config fin;
				Wardrobe::Config wd;
				NffOutfits::Config nf;
				if (j.is_object() && j.contains("finances"))
					Finance::FromJson(j["finances"], fin);
				if (j.is_object() && j.contains("wardrobe"))
					Wardrobe::FromJson(j["wardrobe"], wd);
				if (j.is_object() && j.contains("nffOutfits"))
					NffOutfits::FromJson(j["nffOutfits"], nf);
				RoomGuard::Config rg;
				if (j.is_object() && j.contains("rooms"))
					RoomGuard::FromJson(j["rooms"], rg);
				FollowerTune::Config tn;
				if (j.is_object() && j.contains("tuning"))
					FollowerTune::FromJson(j["tuning"], tn);
				LootHighlight::Config lt;
				// Always through FromJson — a default-constructed Config has an
				// EMPTY category list (FromJson is what seeds it), which would
				// read as "every category off".
				LootHighlight::FromJson(
					j.is_object() ? j.value("loot", json::object()) : json::object(), lt);
				FollowersHud::Config hd;
				if (j.is_object() && j.contains("hud"))
					FollowersHud::FromJson(j["hud"], hd);
				NoAutoGear::Config ng;
				// Always through FromJson — it re-seeds the distributor plugin list
				// when absent, so a config from before this feature still strips.
				NoAutoGear::FromJson(
					j.is_object() ? j.value("noAutoGear", json::object()) : json::object(), ng);
				SpidGear::Config sg;
				SpidGear::FromJson(
					j.is_object() ? j.value("spidGear", json::object()) : json::object(), sg);
				// Hotbar: SEED only when the slice is absent. FromJson on a
				// present slice must never be preceded by SeedDefaults, or a bar
				// the player deliberately emptied would refill itself on every
				// load. FromJson normalises the page/slot array lengths, so a
				// config written by an older build still comes back whole.
				Hotbar::Config hb;
				if (j.is_object() && j.contains("hotbar"))
					Hotbar::FromJson(j["hotbar"], hb);
				else
					Hotbar::SeedDefaults(hb);
				std::lock_guard l(g_configMutex);
				g_config = std::move(c);
				g_magicConfig = std::move(m);
				g_folConfig = std::move(f);
				g_domConfig = std::move(d);
				g_contConfig = std::move(ctc);
				g_finConfig = std::move(fin);
				g_wardrobeConfig = std::move(wd);
				g_nffConfig = std::move(nf);
				g_roomConfig = std::move(rg);
				g_tuneConfig = std::move(tn);
				g_lootConfig = std::move(lt);
				g_hudConfig = std::move(hd);
				g_ngConfig = std::move(ng);
				g_spidConfig = std::move(sg);
				g_hbConfig = std::move(hb);
				// Build marker (hd-markers.json: "hotbar-config"). Unconditional so
				// it is REACHED on every successful load — a marker inside an `if`
				// that never fires is one the deploy check can never see.
				logger::info("hotbar: {}x{} buttons, skin={}, {} modifier page(s) on — config loaded",
					g_hbConfig.cols, g_hbConfig.rows, g_hbConfig.skin,
					(g_hbConfig.pages.size() > 3
						? (g_hbConfig.pages[1].enabled + g_hbConfig.pages[2].enabled + g_hbConfig.pages[3].enabled)
						: 0));
				logger::info("followers HUD: enabled={} orient={} key={} — config loaded",
					g_hudConfig.enabled, g_hudConfig.orient, g_hudConfig.keyCode);
				logger::info("loaded {} hotkeys + {} spells from {}",
					g_config.entries.size(), g_magicConfig.spells.size(), path.string());
				// Build marker (hd-markers.json: "tab-scales"). Unconditional, so it is
				// REACHED on every successful load -- a marker sitting inside an `if`
				// that never fires is one the linker may strip and the deploy check can
				// never see.
				logger::info("tab sizes: {} tab(s) with a size override", g_config.settings.tabScales.size());
				return;
			}
			logger::error("{} is invalid JSON — using built-in defaults (file left untouched)", path.string());
			std::lock_guard l(g_configMutex);
			g_config = DefaultConfig();
			g_magicConfig = DefaultMagicConfig();
			g_folConfig = FollowerConfig{};
			g_domConfig = DefaultDomainsConfig();
			g_contConfig = DefaultContainerConfig();
			g_finConfig = Finance::Config{};
			g_wardrobeConfig = Wardrobe::Config{};
			g_nffConfig = NffOutfits::Config{};
			g_roomConfig = RoomGuard::Config{};
			LootHighlight::FromJson(json::object(), g_lootConfig);  // seeds the category list
			NoAutoGear::FromJson(json::object(), g_ngConfig);      // seeds the distributor list
			Hotbar::SeedDefaults(g_hbConfig);                      // 8 empty buttons on 1..8
			return;
		}
		logger::info("no config at {} — writing seeded defaults", path.string());
		{
			std::lock_guard l(g_configMutex);
			g_config = DefaultConfig();
			g_magicConfig = DefaultMagicConfig();
			g_folConfig = FollowerConfig{};
			g_domConfig = DefaultDomainsConfig();
			g_contConfig = DefaultContainerConfig();
			g_finConfig = Finance::Config{};
			g_wardrobeConfig = Wardrobe::Config{};
			g_nffConfig = NffOutfits::Config{};
			g_roomConfig = RoomGuard::Config{};
			LootHighlight::FromJson(json::object(), g_lootConfig);  // seeds the category list
			NoAutoGear::FromJson(json::object(), g_ngConfig);      // seeds the distributor list
			Hotbar::SeedDefaults(g_hbConfig);                      // 8 empty buttons on 1..8
		}
		PersistAll();
	}

	// ------------------------------------------------------------ key sending

	void SendScan(std::uint32_t dik, bool down)
	{
		INPUT in{};
		in.type = INPUT_KEYBOARD;
		in.ki.wScan = static_cast<WORD>(dik & 0x7F);
		in.ki.dwFlags = KEYEVENTF_SCANCODE;
		if (dik > 0x7F)
			in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
		if (!down)
			in.ki.dwFlags |= KEYEVENTF_KEYUP;
		SendInput(1, &in, sizeof(INPUT));
	}

	void SendMouseButton(std::uint32_t code, bool down)
	{
		INPUT in{};
		in.type = INPUT_MOUSE;
		switch (code) {
		// Left/right exist for SYNTHESIS only (the OMO grab-cancel click) —
		// binding them as entries is still refused elsewhere on purpose.
		case 0:
			in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
			break;
		case 1:
			in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
			break;
		case 2:
			in.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
			break;
		case 3:
			in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
			in.mi.mouseData = XBUTTON1;
			break;
		case 4:
			in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
			in.mi.mouseData = XBUTTON2;
			break;
		default:
			return;
		}
		SendInput(1, &in, sizeof(INPUT));
	}

	// Runs on a detached worker thread.
	void FireChord(const std::string& device, std::uint32_t code, const std::vector<std::uint32_t>& mods)
	{
		using namespace std::chrono;
		for (auto m : mods) {
			SendScan(m, true);
			std::this_thread::sleep_for(milliseconds(15));
		}
		if (device == "mouse") {
			SendMouseButton(code, true);
			std::this_thread::sleep_for(milliseconds(45));
			SendMouseButton(code, false);
		} else {
			SendScan(code, true);
			std::this_thread::sleep_for(milliseconds(45));
			SendScan(code, false);
		}
		for (auto it = mods.rbegin(); it != mods.rend(); ++it) {
			std::this_thread::sleep_for(milliseconds(15));
			SendScan(*it, false);
		}
	}

	// OMO's Cancel is an INPUT, not an export — so cancelling a delegated grab
	// means synthesizing exactly the input OMO is listening for. That binding
	// lives in its own KeyConfiguration.txt ("Cancel, Mouse, RightButton" by
	// default, CSV, verified against the shipped file 2026-08-12), so read it at
	// fire time and honor a rebind. Mouse buttons only: OMO's realistic cancel
	// space is a click, and an unrecognized value falls back to the shipped
	// right-click default with a log line naming what it saw.
	int OmoCancelButton()
	{
		std::ifstream in("Data/Object Manipulation Overhaul/KeyConfiguration.txt");
		std::string   line;
		while (in && std::getline(in, line)) {
			if (line.rfind("Cancel", 0) != 0)
				continue;
			if (line.find("LeftButton") != std::string::npos) return 0;
			if (line.find("RightButton") != std::string::npos) return 1;
			if (line.find("MiddleButton") != std::string::npos) return 2;
			logger::warn("OMO cancel binding unrecognized ('{}') - using right-click", line);
			return 1;
		}
		return 1;  // no file / no Cancel row: OMO's shipped default
	}

	// Small lead-in so the deck-key press that asked for the cancel has fully
	// cleared the input queue first.
	void SynthOmoCancelClick()
	{
		std::thread([]() {
			using namespace std::chrono;
			const int btn = OmoCancelButton();
			std::this_thread::sleep_for(milliseconds(30));
			SendMouseButton(btn, true);
			std::this_thread::sleep_for(milliseconds(45));
			SendMouseButton(btn, false);
		}).detach();
	}

	// Shift+open quick action: fire a key (default Del) WITHOUT the Shift the user is
	// physically holding turning it into Shift+key -- briefly drop Shift, fire, restore.
	void FireModAction(std::string device, std::uint32_t code)
	{
		std::thread([device, code]() {
			using namespace std::chrono;
			std::this_thread::sleep_for(milliseconds(20));
			// Drop any held modifier so the game gets a CLEAN key, not Mod+key.
			struct M { int vk; std::uint32_t dik; };
			static const M kMods[6] = {
				{ VK_LSHIFT, 0x2A }, { VK_RSHIFT, 0x36 }, { VK_LCONTROL, 0x1D },
				{ VK_RCONTROL, 0x9D }, { VK_LMENU, 0x38 }, { VK_RMENU, 0xB8 }
			};
			bool held[6]; bool any = false;
			for (int i = 0; i < 6; ++i) {
				held[i] = (GetAsyncKeyState(kMods[i].vk) & 0x8000) != 0;
				if (held[i]) { SendScan(kMods[i].dik, false); any = true; }
			}
			if (any) std::this_thread::sleep_for(milliseconds(12));
			FireChord(device, code, {});
			if (any) std::this_thread::sleep_for(milliseconds(12));
			for (int i = 0; i < 6; ++i)
				if (held[i]) SendScan(kMods[i].dik, true);
		}).detach();
	}

	// ------------------------------------------------ extended F13-F24 bridge

	bool IsExtCode(std::uint32_t dik)
	{
		return (dik >= 100 && dik <= 110) || dik == 118;
	}

	// Tag on injected events so our sink can tell them from real hardware input.
	const RE::BSFixedString& ExtEventTag()
	{
		static RE::BSFixedString tag("HotkeyDeckExt");
		return tag;
	}

	// Main thread only (AddTask). Dispatches a synthetic keyboard ButtonEvent
	// through the engine's input queue — SKSE sinks, RegisterForKey and menus
	// all receive it exactly like a native event.
	void SendEngineKey(std::uint32_t dik, float value, float held)
	{
		auto idm = RE::BSInputDeviceManager::GetSingleton();
		if (!idm)
			return;
		auto ev = RE::ButtonEvent::Create(RE::INPUT_DEVICE::kKeyboard, ExtEventTag(), dik, value, held);
		if (!ev)
			return;
		RE::InputEvent* head = ev;
		idm->SendEvent(&head);
		RE::free(ev);  // Create() allocates on the game heap; sinks don't take ownership
	}

	// Let the palette's capture modal bind faithful-code F-keys (Ultralight
	// never sees engine-injected events, so we hand them to the view directly).
	void NotifyViewExtKey(std::size_t idx, std::uint32_t mappedDik)
	{
		if (!g_capturing.load() || !AnyOpen() || !ActiveViewReady())
			return;
		const PrismaView  view = ActiveView();
		const std::string js = "hdExtKey(" + json{
			{ "name", kExtNames[idx] },
			{ "raw", kExtFaithfulDik[idx] },
			{ "mapped", mappedDik }
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) + ")";
		SKSE::GetTaskInterface()->AddTask([js, view]() {
			if (g_prisma && AnyOpen())
				g_prisma->Invoke(view, js.c_str());
		});
	}

	// Detached poll thread. GetAsyncKeyState sees VK_F13..F24 regardless of what
	// DirectInput drops (including iCUE/Parsec software-injected presses).
	// The Wardrobe cadence tick. Without this the whole "she changes her clothes
	// every N hours" feature only fires when you OPEN the tab, which is exactly
	// when you are least likely to notice it. 30 s of real time is far finer than
	// the shortest cadence (1 in-game hour is ~2.5 min real at the default
	// timescale of 20), and MaybeRoll returns immediately unless a re-roll is
	// actually due — so this is close to free.
	void WardrobeTickLoop()
	{
		using namespace std::chrono_literals;
		while (true) {
			std::this_thread::sleep_for(30s);
			// Everything inside MaybeRoll touches live game state, so it has to
			// run on the main thread; this thread only does the waiting.
			// Calendar reads 0 with no save loaded and MaybeRoll bails on that,
			// so there is no need to track load state here.
			SKSE::GetTaskInterface()->AddTask([]() {
				bool rolled = false;
				{
					std::lock_guard l(g_configMutex);
					rolled = Wardrobe::MaybeRoll(g_wardrobeConfig);
				}
				if (rolled)
					PersistAll();
			});
		}
	}

	// Defined further down (view plumbing section); the tick loop below pushes a
	// fresh rooms slice after an auto-claim. Forward-declared for the same reason
	// as SetTextInputGuard above — no unit-level ordering in this file.
	void PushToView(std::string fn, std::string payload);

	// The Room Guard watchdog. Sleeps on a fixed short interval and lets Tick()
	// enforce the configured cadence, so changing tickMs in the pane takes effect
	// without restarting the thread. Tick early-outs on a couple of integer
	// compares unless the player is actually standing in an enabled guarded room,
	// which is the overwhelming majority of the time.
	void RoomGuardTickLoop()
	{
		using namespace std::chrono_literals;
		while (true) {
			std::this_thread::sleep_for(500ms);
			SKSE::GetTaskInterface()->AddTask([]() {
				bool        dirty = false;
				std::string open;
				{
					std::lock_guard l(g_configMutex);
					dirty = RoomGuard::Tick(g_roomConfig);
					if (dirty)
						open = RoomGuard::OpenJson(g_roomConfig);
				}
				// PersistAll takes the same lock — it must run OUTSIDE the guard
				// above or the tick deadlocks the main thread.
				if (dirty) {
					PersistAll();
					// Re-push the slice to an open pane. Without this, an AUTO-CLAIM
					// landing while the Rooms tab is up would be silently deleted by
					// the pane's next debounced save (it sends the whole rooms list,
					// built from its pre-auto-claim snapshot).
					PushToView("rgOpen", open);
				}
			});
		}
	}

	// The Loot Highlighter scanner. Same shape as RoomGuardTickLoop: the thread
	// only sleeps and posts; Tick() enforces the configured cadence and
	// early-outs on pause/master-off, so changing tickMs needs no restart.
	// (The task never re-posts itself — see the AddTask self-repost freeze.)
	void LootTickLoop()
	{
		using namespace std::chrono_literals;
		while (true) {
			std::this_thread::sleep_for(400ms);
			SKSE::GetTaskInterface()->AddTask([]() {
				std::lock_guard l(g_configMutex);
				LootHighlight::Tick(g_lootConfig);
			});
		}
	}

	// No Auto-Gear watchdog. Same shape: the thread only sleeps and posts; Tick()
	// enforces the configured cadence and early-outs when disabled / roster empty /
	// paused. (Never re-posts itself — see the AddTask self-repost freeze.)
	void NoAutoGearTickLoop()
	{
		using namespace std::chrono_literals;
		while (true) {
			std::this_thread::sleep_for(1000ms);
			SKSE::GetTaskInterface()->AddTask([]() {
				std::lock_guard l(g_configMutex);
				NoAutoGear::Tick(g_ngConfig);
			});
		}
	}

	void ExtPollLoop()
	{
		using clock = std::chrono::steady_clock;
		constexpr auto kTick = std::chrono::milliseconds(10);
		constexpr auto kMinHold = std::chrono::milliseconds(45);  // match FireChord's reliable hold

		struct KeyState
		{
			bool              down = false;
			bool              engine = false;     // engine event vs SendInput re-send
			bool              upPending = false;  // OS path: release owed after kMinHold
			std::uint32_t     firedDik = 0;
			clock::time_point pressedAt{};
		};
		std::array<KeyState, kExtCount> ks{};

		while (true) {
			std::this_thread::sleep_for(kTick);

			bool                                 enabled;
			std::array<std::uint32_t, kExtCount> map;
			{
				std::lock_guard l(g_configMutex);
				enabled = g_config.settings.extEnabled;
				map = g_config.settings.extMap;
			}

			// only react while the game window is foreground (mirrors DirectInput)
			HWND  fg = GetForegroundWindow();
			DWORD pid = 0;
			if (fg)
				GetWindowThreadProcessId(fg, &pid);
			const bool focused = pid == GetCurrentProcessId();

			const auto now = clock::now();
			for (std::size_t i = 0; i < kExtCount; ++i) {
				auto& k = ks[i];

				if (k.upPending && now - k.pressedAt >= kMinHold) {
					SendScan(k.firedDik, false);
					k.upPending = false;
				}

				const bool physDown = focused && enabled &&
					(GetAsyncKeyState(kExtVkBase + static_cast<int>(i)) & 0x8000) != 0;

				if (physDown && !k.down) {
					const auto dik = map[i];
					if (dik == 0 || (IsExtCode(dik) && g_extHwSeen[i].load()))
						continue;  // key disabled, or real hardware already covers it
					if (k.upPending) {  // flush the previous press's owed release first
						SendScan(k.firedDik, false);
						k.upPending = false;
					}
					k.down = true;
					k.engine = IsExtCode(dik);
					k.firedDik = dik;
					k.pressedAt = now;
					logger::info("ext {} down -> DIK {} ({})", kExtNames[i], dik,
						IsExtCode(dik) ? "engine event" : "sendinput");
					if (k.engine) {
						SKSE::GetTaskInterface()->AddTask([dik]() { SendEngineKey(dik, 1.0f, 0.0f); });
						NotifyViewExtKey(i, dik);
					} else {
						SendScan(dik, true);
					}
				} else if (physDown && k.down && k.engine) {
					// held: repeat like the engine does, with a growing hold time
					const auto  dik = k.firedDik;
					const float held = std::chrono::duration<float>(now - k.pressedAt).count();
					SKSE::GetTaskInterface()->AddTask([dik, held]() { SendEngineKey(dik, 1.0f, held); });
				} else if (!physDown && k.down) {
					k.down = false;
					const float held = std::chrono::duration<float>(now - k.pressedAt).count();
					if (k.engine) {
						const auto dik = k.firedDik;
						SKSE::GetTaskInterface()->AddTask([dik, held]() { SendEngineKey(dik, 0.0f, held); });
					} else if (now - k.pressedAt < kMinHold) {
						k.upPending = true;  // too quick — release on a later tick
					} else {
						SendScan(k.firedDik, false);
					}
				}
			}
		}
	}

	void StartExtBridge()
	{
		std::thread(ExtPollLoop).detach();  // lives for the whole process
		std::thread(WardrobeTickLoop).detach();
		std::thread(RoomGuardTickLoop).detach();
		std::thread(LootTickLoop).detach();
		std::thread(NoAutoGearTickLoop).detach();

		// Keys tab: how the scan learns the deck's OWN claims (open key +
		// every entry trigger). Called at scan time under the config lock, so
		// the census always reflects live state, never a stale snapshot.
		KeysScan::SetOwnKeysProvider([]() {
			std::vector<KeysScan::OwnBinding> out;
			std::lock_guard                   l(g_configMutex);
			const auto&                       s = g_config.settings;
			if (s.openDevice == "keyboard" && s.openCode) {
				out.push_back(KeysScan::OwnBinding{
					"Open deck" + (s.openLabel.empty() ? "" : " (" + s.openLabel + ")"),
					s.openCode, "" });
			}
			for (const auto& e : g_config.entries) {
				if (e.trigDevice != "keyboard" || !e.trigCode) {
					continue;
				}
				std::string mods;
				for (const auto m : e.trigMods) {
					if (m == 0x2A || m == 0x36) mods += "Shift+";
					else if (m == 0x1D || m == 0x9D) mods += "Ctrl+";
					else if (m == 0x38 || m == 0xB8) mods += "Alt+";
				}
				if (!mods.empty()) {
					mods.pop_back();
				}
				out.push_back(KeysScan::OwnBinding{ e.name, e.trigCode, std::move(mods) });
			}
			return out;
		});
	}

	// ------------------------------------------------------- palette open/close

	bool CanOpenNow()
	{
		auto ui = RE::UI::GetSingleton();
		if (!ui || ui->GameIsPaused())
			return false;
		if (ui->IsMenuOpen(RE::DialogueMenu::MENU_NAME))  // dialogue doesn't pause; fired keys would hit the dialogue UI
			return false;
		if (g_prisma && g_prisma->HasAnyActiveFocus())  // don't steal focus from another PrismaUI view (CHIM chat, Tailor…)
			return false;
		auto cm = RE::ControlMap::GetSingleton();
		if (cm && cm->GetRuntimeData().textEntryCount > 0)
			return false;
		return true;
	}

	void OpenPalette();
	void OnJsFire(const char* data);
	void OnJsFireKey(const char* data);
	void OnJsSave(const char* data);
	void OnJsClose(const char* data);
	void OnJsLog(const char* data);
	void OnJsTab(const char* data);
	void OnJsCapture(const char* data);
	void OnJsQuestList(const char* data);
	void OnJsQuestSearch(const char* data);
	void OnJsQuestDetail(const char* data);
	void OnJsQuestSetStage(const char* data);
	void OnJsQuestAction(const char* data);
	void OnJsVkCatalog(const char* data);
	void OnJsVkTest(const char* data);

	// Spell Deck (second view) forward decls.
	void OpenMagicPalette();
	void CloseMagicPalette();
	void EnsureMagicViewAndOpen();
	void OnJsMagicFire(const char* data);
	void OnJsMagicCastCombo(const char* data);
	void OnJsMagicKnown(const char* data);
	void OnJsMagicSave(const char* data);
	void OnJsMagicClose(const char* data);
	void OnJsMagicLog(const char* data);
	void OnJsMagicCapture(const char* data);
	void OnJsMagicRemoveSpell(const char* data);
	void OnJsMagicRestoreSpell(const char* data);

	// Followers tab (fd* bridge on the deck view) forward decls.
	void OnJsFolApply(const char* data);
	void OnJsFolWorld(const char* data);
	void OnJsFolMhiyh(const char* data);
	void OnJsFolNpc(const char* data);
	void OnJsFolDebug(const char* data);  // 🔍 Debug reveal: fdDebug -> fdDebugInfo
	// CHIM button (chim_control): activate/deactivate + read agent state.
	void OnJsChState(const char* data);
	void OnJsChSet(const char* data);
	// Formation with Followers modal (formation_actions.cpp does the work).
	void OnJsFmGet(const char* data);
	void OnJsFmApply(const char* data);
	void OnJsFmReg(const char* data);
	void OnJsFmRescue(const char* data);
	// Domains tab -> Bases section (nff_bases.cpp does the work).
	void OnJsNbGet(const char* data);
	void OnJsNbOp(const char* data);
	// Deck Portal button (portal_host.cpp): ptGet -> ptState, ptOpen -> ptState.
	void OnJsPtGet(const char* data);
	void OnJsPtOpen(const char* data);
	void OnJsHistory(const char* data);       // Recent tab: ask for the list
	void OnJsHistoryClear(const char* data);  // Recent tab: forget it       // v0.15.0 quick recruit / dismiss / inventory
	void OnJsFolEquipped(const char* data);  // v0.15.0 the worn set, read off the engine
	void OnJsItemSpin(const char* data);     // bake the turntable for one worn piece
	void OnJsFolTune(const char* data);      // v0.15.1 essential / health / shared spells
	void OnJsFolRank(const char* data);      // the player's RELA rank: read, and set
	void OnJsFolRefresh(const char* data);
	void OnJsFolPortrait(const char* data);
	void OnJsFolPreset(const char* data);   // Preset Director tools (preset_bridge)
	void OnJsFolGear(const char* data);     // Gear Toggle (gear_bridge)
	void OnJsWdPortrait(const char* data);
	// Both are defined further down but used by OnJsWdPortrait above them.
	void                  ClosePalette();
	std::filesystem::path DeckViewDir();
	void OnJsFolSave(const char* data);
	void OnJsFolLog(const char* data);
	// Defined down in the Followers section; declared here because OpenPalette
	// (above it in the file) pushes the listing at open.
	std::string FolPortraitsJson();
	std::string FolCropsJson();

	// Followers HUD — defined far below (after the portrait helpers it reuses),
	// but registered on the deck view and pushed on deck-open, both above.
	void        OnJsHudCfg(const char* data);
	void        HudPushDeckState();
	std::string HudDeckStateJson();
	// The live teammate/faction follower scan — defined far below with the HUD
	// helpers it reuses, but the Followers pane pushes it (fdLiveParty) on open
	// and after a roster mutation, both above, so it needs a forward decl here.
	std::string HudFollowersJson();
	void        CreateHudView();
	void        StartHudTicker();
	void        HudToggleVisible();
	// Hotbar — defined with the rest of its block far below, but FireAction (a
	// long way above it) dispatches the two seeded actions, so it needs these.
	void        CreateHotbarView();
	void        StartHotbarTicker();
	void        HbToggleVisible();
	void        HbOpenEdit();
	void        OnJsFolCropSave(const char* data);
	bool        PrunePortraitCrops();
	// Same reason: the crosshair snapshot goes out with the open payload, so the
	// quick-follower card on the Hotkeys tab has a target without the Followers
	// pane having to be shown first.
	std::string FolTargetJson();
	// The non-actor twin: the ground item under the crosshair at open, resolved
	// to the plugin that defines it (the item-source banner's payload).
	std::string ItemSourceJson();

	// Both are defined further down (the palette-desync watchdog section) but are
	// called by the open/close paths above it, so they need declaring here — the
	// file has no unit-level ordering guarantee and C++ has no forward inference.
	void SetTextInputGuard(bool on);
	bool PalettesDesynced();
	bool ViewOpenButUnfocused(PrismaView v, bool openFlag);

	// Wheel Menu (wh* bridge on the deck view). Requests whInv / whAct /
	// whIcons; replies whInvList / whActDone (and wdItemIcons, which is the
	// ITEM-ICON index's one reply name — shared with the Wardrobe on purpose,
	// because it is one index and a second name for it would be a second
	// thing to keep in step).
	void OnJsWheelInv(const char* data);
	void OnJsWheelAct(const char* data);
	void OnJsWheelIcons(const char* data);
	// Domains tab (pd* bridge on the deck view) forward decls.
	void OnJsPlaceMark(const char* data);
	void OnJsPlaceRecall(const char* data);
	void OnJsPlaceSave(const char* data);
	void OnJsPlacePhoto(const char* data);
	void OnJsPlaceScene(const char* data);
	void OnJsPlaceSceneSet(const char* data);
	void OnJsPlaceCropSave(const char* data);
	void OnJsPlaceRefresh(const char* data);
	void OnJsPlaceLog(const char* data);
	// Containers tab (ct* bridge on the deck view).
	void OnJsContMark(const char* data);
	void OnJsContGo(const char* data);
	void OnJsContSave(const char* data);
	void OnJsContPhoto(const char* data);
	void OnJsContRefresh(const char* data);
	void OnJsContLog(const char* data);
	// Door lock modal (dr* bridge on the deck view): drSet→drResult, drRefresh→drTarget.
	void OnJsDoorSet(const char* data);
	void OnJsDoorRefresh(const char* data);
	void OnJsPlaceNpcList(const char* data);
	void OnJsPlaceNpcTo(const char* data);
	// Rooms tab (rg* bridge on the deck view) forward decls.
	void OnJsRoomClaim(const char* data);
	void OnJsRoomAnchor(const char* data);
	void OnJsRoomEvict(const char* data);
	void OnJsRoomRelease(const char* data);
	void OnJsRoomIgnore(const char* data);
	void OnJsRoomLock(const char* data);
	void OnJsRoomState(const char* data);
	void OnJsRoomNpcs(const char* data);
	void OnJsTimeGet(const char* data);
	void OnJsKeysScan(const char* data);
	void OnJsKeysState(const char* data);
	void OnJsKeysResult(const char* data);
	void OnJsTimeWait(const char* data);
	void OnJsRoomSave(const char* data);
	void OnJsRoomLog(const char* data);
	void OnJsRoomRing(const char* data);
	// Loot tab (lt* bridge on the deck view) forward decls.
	void OnJsLootGet(const char* data);
	void OnJsLootSave(const char* data);
	void OnJsLootToggle(const char* data);
	void OnJsLootState(const char* data);
	void OnJsLootLog(const char* data);
	void OnJsNgGet(const char* data);
	void OnJsNgSave(const char* data);
	void OnJsNgToggle(const char* data);
	void OnJsNgParty(const char* data);
	void OnJsNgSweep(const char* data);
	void OnJsNgState(const char* data);
	void OnJsNgLog(const char* data);
	// SPID Gear (sg* bridge on the deck view, F7 card) forward decls.
	void OnJsSgGet(const char* data);
	void OnJsSgInbox(const char* data);
	void OnJsSgRemove(const char* data);
	void OnJsSgChance(const char* data);
	void OnJsSgAll(const char* data);
	void OnJsSgEnable(const char* data);
	void OnJsSgNpcOp(const char* data);
	void OnJsSgLog(const char* data);

	// Light tab (ql* bridge on the deck view) forward decls.
	void OnJsQuickLightGet(const char* data);
	void OnJsQuickLightOn(const char* data);
	void OnJsQuickLightOff(const char* data);
	void OnJsQuickLightToggle(const char* data);
	// Better FaceLight Redux quick-card probe (bfl* bridge) forward decls.
	void OnJsBflGet(const char* data);
	void OnJsBflSet(const char* data);
	// Character Sheet tab (ps* bridge on the deck view) forward decls.
	// request psGet -> reply psData; psRemoveEffect -> psResult + psData;
	// psSetMeta -> psResult + psData (one name per direction, deck law).
	void OnJsSheetGet(const char* data);
	void OnJsSheetRemoveEffect(const char* data);
	void OnJsSheetSetMeta(const char* data);
	// Animations tab (an* bridge on the deck view) forward decls.
	void OnJsAnimGet(const char* data);
	void OnJsAnimPlay(const char* data);
	void OnJsAnimReset(const char* data);
	void OnJsAnimState(const char* data);
	void OnJsAnimCrawl(const char* data);
	void OnJsAnimLog(const char* data);
	// OStim segment of the Animations tab (os* bridge on the deck view).
	void OnJsOstimGet(const char* data);
	void OnJsOstimPoll(const char* data);
	void OnJsOstimSearch(const char* data);
	void OnJsOstimNav(const char* data);
	void OnJsOstimSpeed(const char* data);
	void OnJsOstimAuto(const char* data);
	void OnJsOstimFurn(const char* data);
	void OnJsOstimSwap(const char* data);
	void OnJsOstimLog(const char* data);
	// Finances tab (fin* bridge on the deck view) forward decls.
	void OnJsFinGet(const char* data);
	void OnJsSharmatCall(const char* data);
	// Omni (universal Search + Ask, v0.14.0) forward decls.
	void OnJsAskCall(const char* data);
	void OnJsSpellsIndex(const char* data);
	void OnJsOmniCast(const char* data);
	void OnJsOmniEquip(const char* data);
	void OnJsWdGet(const char* data);
	void OnJsWdSave(const char* data);
	void OnJsWdCropSave(const char* data);
	void OnJsWdDress(const char* data);
	void OnJsWdTrack(const char* data);
	void OnJsWdBuild(const char* data);
	void OnJsWdWorn(const char* data);
	void OnJsWdArmorMods(const char* data);
	void OnJsWdArmorsFor(const char* data);

	// Photograph an outfit: dress the player in it, then hand them the camera.
	//
	// The dress is a mod event to SOES's Papyrus side, so it does not land
	// instantly — the palette has to close, the equip has to run, and the body
	// has to redraw. Hence the delay before photo mode starts; without it you
	// would be framing the OLD clothes.
	void OnJsWdPortrait(const char* data)
	{
		const std::string req = data ? data : "";
		const auto        j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("wdPortrait: bad payload");
			return;
		}
		const std::string outfit = j.value("name", std::string(""));
		if (outfit.empty()) {
			logger::warn("wdPortrait: no outfit name");
			return;
		}
		SKSE::GetTaskInterface()->AddTask([outfit]() {
			ClosePalette();
			const auto res = Wardrobe::DressNow(json{ { "outfit", outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			const auto jr = json::parse(res, nullptr, false);
			if (jr.is_discarded() || !jr.value("ok", false)) {
				const auto msg = jr.is_discarded() ? std::string("Could not wear that")
												   : jr.value("msg", std::string("Could not wear that"));
				RE::DebugNotification(msg.c_str());
				return;
			}
			// Detached wait, same idiom as the portrait: the main thread cannot
			// block while Papyrus does the equip.
			std::thread([outfit]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(1400));
				SKSE::GetTaskInterface()->AddTask([outfit]() {
					PortraitCapture::StartPhotoMode(DeckViewDir() / "icons" / "custom",
						"wd-" + PortraitCapture::SlugOfName(outfit), outfit);
				});
			}).detach();
		});
	}

	// wdGiveWear: "just put it on her" — the F7 dock's third destination
	// (Rober, 2026-08-11). Drops an outfit's pieces into the crosshair NPC's
	// inventory and force-equips them, enrolling her in NOTHING: no Assignment
	// for SOES to own, no NFF set. The palette deliberately stays OPEN — unlike
	// the container ops there is no menu to hand focus to, and you usually want
	// to try a second outfit straight after.
	void OnJsWdGiveWear(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdResult", Wardrobe::GiveAndWear(req));
		});
	}

	// wdWear: put this outfit on the PLAYER, nothing else — the "just let me
	// wear it" half of the photo flow above. The palette closes so the change
	// is visible immediately.
	void OnJsWdWear(const char* data)
	{
		const std::string req = data ? data : "";
		const auto        j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const std::string outfit = j.value("name", std::string(""));
		if (outfit.empty())
			return;
		SKSE::GetTaskInterface()->AddTask([outfit]() {
			ClosePalette();
			const auto res = Wardrobe::DressNow(json{ { "outfit", outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			const auto jr = json::parse(res, nullptr, false);
			std::string msg;
			if (jr.is_discarded() || !jr.value("ok", false))
				msg = jr.is_discarded() ? std::string("Could not wear that")
										: jr.value("msg", std::string("Could not wear that"));
			else
				msg = "Wearing \"" + outfit + "\"";
			RE::DebugNotification(msg.c_str());
			logger::info("wdWear: player -> '{}'", outfit);
		});
	}

	// wdEquipPiece: the Inventory tab's "wear just this one piece" — resolves,
	// checks the player actually carries it, equips, and says what happened.
	void OnJsWdEquipPiece(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto res = Wardrobe::EquipPiece(req);
			const auto jr  = json::parse(res, nullptr, false);
			const std::string msg = jr.is_discarded()
				? std::string("Could not equip that")
				: jr.value("msg", std::string("Could not equip that"));
			RE::DebugNotification(msg.c_str());
		});
	}

	void OnJsWdPieces(const char* data);
	void OnJsWdRemovePiece(const char* data);
	void OnJsWdOutfitDel(const char* data);
	void OnJsWdImport(const char* data);
	void OnJsWdOutfitMods(const char* data);
	void OnJsWdOutfitsFor(const char* data);
	void OnJsWdRename(const char* data);
	void OnJsWdFav(const char* data);
	void OnJsWdSoesOpt(const char* data);
	void OnJsWdInvMode(const char* data);
	void OnJsWdEnable(const char* data);
	void OnJsWdRefreshAll(const char* data);
	void OnJsWdResetAuto(const char* data);
	void OnJsWdLog(const char* data);
	// NFF outfits — the Wardrobe pane's second dressing backend (nf* bridge).
	void OnJsNfGet(const char* data);
	void OnJsNfSave(const char* data);
	void OnJsNfWear(const char* data);
	void OnJsNfBuild(const char* data);
	void OnJsNfClear(const char* data);
	void OnJsNfSatchel(const char* data);
	void OnJsNfClaim(const char* data);
	void OnJsNfPieces(const char* data);
	void OnJsNfCopy(const char* data);
	void OnJsNfClone(const char* data);
	void OnJsNfPreview(const char* data);
	void OnJsNfSwitch(const char* data);
	void OnJsNfChest(const char* data);
	void OnJsNfGear(const char* data);
	void OnJsNfSetGear(const char* data);
	void OnJsNfLog(const char* data);
	void OnJsFinSave(const char* data);
	void OnJsFinSettle(const char* data);
	void OnJsFinBuy(const char* data);
	void OnJsFinSell(const char* data);
	void OnJsFinBuyProp(const char* data);
	void OnJsFinSellProp(const char* data);
	void OnJsFinIcons(const char* data);
	void OnJsFinLog(const char* data);
	void OnJsMagicGetDesc(const char* data);
	void OnJsMagicIconList(const char* data);
	void DoAddHighlighted();

	// v0.11.0 deck icons + the Spell Deck jump. Defined further down (they need
	// DeckViewDir(), which lives in the Followers section) and declared here
	// because EnsureViewAndOpen / OpenPalette above them use them.
	void OnJsOpenSpells(const char* data);
	void OnJsIconList(const char* data);
	std::filesystem::path DeckViewDir();
	std::string DeckIconIndexJson();
	std::string DeckCustomIconsJson();
	bool ApplyPortalHotkeyIcons(const std::filesystem::path& customDir);
	// v0.12.0 phone hotkey edits (rename / desc / category / rebind / delete).
	bool ApplyPortalHotkeyEdits(const std::filesystem::path& deckDir);
	// The portal's portrait queue must EXIST before the game launches, or MO2's
	// launch-time listing snapshot hides it for the whole session. So the plugin
	// owns the file: it seeds an empty one on startup (landing in overwrite,
	// which is what the game reads) and empties it after each batch instead of
	// deleting it. The portal then only ever EDITS a file that is already there.
	//
	// `force` rewrites an existing file (the post-batch truncate); without it
	// this is a no-op when the file is already present, so startup never eats a
	// queue the portal left while the game was closed.
	void EnsurePortraitBridge(bool force)
	{
		const auto      file = DeckViewDir() / "portal-portraits.json";
		std::error_code ec;
		if (!force && std::filesystem::exists(file, ec))
			return;
		std::filesystem::create_directories(DeckViewDir(), ec);
		static const std::string kEmpty = "{\"shots\":[]}";
		std::ofstream            out(file, std::ios::binary | std::ios::trunc);
		if (!out.is_open()) {
			logger::warn("portal portraits: could not seed the bridge file");
			return;
		}
		out << kEmpty;
	}

	// The portal's CATEGORY-ICON queue, and the same law as the portrait bridge
	// above for the same MO2 reason: the file must EXIST before the game launches
	// or the running game's launch-time listing snapshot hides it for the whole
	// session, and it is EMPTIED rather than deleted after each batch so the
	// phone's next write is an edit of a file the game can already see.
	void EnsureCatIconBridge(bool force)
	{
		const auto      file = DeckViewDir() / "portal-cat-icons.json";
		std::error_code ec;
		if (!force && std::filesystem::exists(file, ec))
			return;
		std::filesystem::create_directories(DeckViewDir(), ec);
		static const std::string kEmpty = R"({"version":1,"set":[]})";
		std::ofstream            out(file, std::ios::binary | std::ios::trunc);
		if (!out.is_open()) {
			logger::warn("portal category icons: could not seed the bridge file");
			return;
		}
		out << kEmpty;
	}

	// The bridge file is PERMANENT (seeded above, truncated after every batch),
	// so its mere EXISTENCE says nothing about whether there is work — and gating
	// on its write TIME would spin at 1 Hz forever, because the truncate is
	// itself a write (the portrait bridge's own gate has exactly that shape).
	// Gate on the size differing from the canonical empty queue instead: one
	// stat(), no churn, and self-correcting — a portal that writes a
	// differently-formatted empty queue costs one no-op apply, after which our
	// own canonical text is back on disk.
	constexpr std::size_t kCatIconEmptyBytes = sizeof(R"({"version":1,"set":[]})") - 1;

	bool CatIconQueuePending()
	{
		std::error_code ec;
		const auto      sz = std::filesystem::file_size(DeckViewDir() / "portal-cat-icons.json", ec);
		if (ec)
			return false;  // absent: nothing queued (and nothing this session could see anyway)
		return sz != kCatIconEmptyBytes;
	}

	std::filesystem::path MagicViewDir();  // defined with the magic-view plumbing below

	// The SPELL DECK's category-glyph queue — same laws as the follower one above
	// (seeded before launch, truncated never deleted, size-gated), but it lives in
	// the MAGIC view's folder and its entries carry the category NAME, because the
	// spell rail has no stable slot index (renames migrate the key in the view).
	void EnsureSpellCatIconBridge(bool force)
	{
		const auto      file = MagicViewDir() / "portal-spell-cat-icons.json";
		std::error_code ec;
		if (!force && std::filesystem::exists(file, ec))
			return;
		std::filesystem::create_directories(MagicViewDir(), ec);
		static const std::string kEmpty = R"({"version":1,"set":[]})";
		std::ofstream            out(file, std::ios::binary | std::ios::trunc);
		if (!out.is_open()) {
			logger::warn("portal spell-category icons: could not seed the bridge file");
			return;
		}
		out << kEmpty;
	}

	bool SpellCatIconQueuePending()
	{
		std::error_code ec;
		const auto      sz = std::filesystem::file_size(MagicViewDir() / "portal-spell-cat-icons.json", ec);
		if (ec)
			return false;
		return sz != kCatIconEmptyBytes;  // same canonical empty text as the follower queue
	}

	bool ApplyPortalSpellCatIcons();

	bool ApplyPortalPortraits();
	bool ApplyPortalCatIcons();
	void OnJsFolFraming(const char*);
	void OnJsFolSetFraming(const char*);
	void FramingReply();
	void ApplyFraming(const std::string& raw);

	// Lazily create the view on first use — keeps our Ultralight view (and its deferred
	// DOM-ready callback) entirely out of the save-load window. Main thread only.
	void EnsureViewAndOpen()
	{
		if (!g_prisma)
			return;
		if (g_viewReady.load()) {
			OpenPalette();
			return;
		}
		if (g_viewRequested.exchange(true))
			return;  // creation already in flight; DOM-ready will open
		logger::info("creating view (first open)");
		g_view = g_prisma->CreateView("HotkeyDeck/index.html", [](PrismaView v) {
			g_viewReady = true;
			logger::info("view DOM ready (handle {})", v);
			SKSE::GetTaskInterface()->AddTask([v]() {
				if (CanOpenNow()) {
					OpenPalette();
				} else if (g_prisma) {
					// Refusing to open must not leave the view on screen holding
					// focus -- that is the desync that stranded the player (see
					// ForceClosePalettes). If we are not opening it, it is hidden.
					logger::info("view ready but CanOpenNow() said no -- hiding it rather than "
					             "leaving it shown with g_open false");
					g_prisma->Unfocus(v);
					g_prisma->Hide(v);
				}
			});
		});
		g_prisma->RegisterJSListener(g_view, "hdFire", OnJsFire);
		g_prisma->RegisterJSListener(g_view, "hdFireKey", OnJsFireKey);
		g_prisma->RegisterJSListener(g_view, "hdSave", OnJsSave);
		g_prisma->RegisterJSListener(g_view, "hdClose", OnJsClose);
		g_prisma->RegisterJSListener(g_view, "hdLog", OnJsLog);
		g_prisma->RegisterJSListener(g_view, "hdTab", OnJsTab);
		g_prisma->RegisterJSListener(g_view, "hdCapture", OnJsCapture);
		g_prisma->RegisterJSListener(g_view, "hdQuestList", OnJsQuestList);
		g_prisma->RegisterJSListener(g_view, "hdQuestSearch", OnJsQuestSearch);
		g_prisma->RegisterJSListener(g_view, "hdQuestGet", OnJsQuestDetail);
		g_prisma->RegisterJSListener(g_view, "hdQuestSetStage", OnJsQuestSetStage);
		g_prisma->RegisterJSListener(g_view, "hdQuestAction", OnJsQuestAction);
		// VirtualKey (Nexus 187350): catalog for the picker + a raw test-fire.
		g_prisma->RegisterJSListener(g_view, "vkCatalog", OnJsVkCatalog);
		g_prisma->RegisterJSListener(g_view, "vkTest", OnJsVkTest);
		logger::info("virtualkey device: native InputEvent dispatch ready");
		// Followers tab (v0.9.0): the fd* bridge lives on the deck view now.
		g_prisma->RegisterJSListener(g_view, "fdApply", OnJsFolApply);
		g_prisma->RegisterJSListener(g_view, "fdWorld", OnJsFolWorld);
		g_prisma->RegisterJSListener(g_view, "fdMhiyh", OnJsFolMhiyh);
		g_prisma->RegisterJSListener(g_view, "fdNpc", OnJsFolNpc);
		// F7 card 🔍 Debug reveal: fdDebug in, fdDebugInfo out (two names, one
		// per direction — the deck law). Pure read; NpcActions::DebugJson.
		g_prisma->RegisterJSListener(g_view, "fdDebug", OnJsFolDebug);
		// Formation with Followers modal (formation_actions): fmGet→fmOpen,
		// mutations→fmResult + a delayed fresh fmOpen once Papyrus has landed.
		g_prisma->RegisterJSListener(g_view, "fmGet", OnJsFmGet);
		g_prisma->RegisterJSListener(g_view, "fmApply", OnJsFmApply);
		g_prisma->RegisterJSListener(g_view, "fmReg", OnJsFmReg);
		g_prisma->RegisterJSListener(g_view, "fmRescue", OnJsFmRescue);
		// Domains tab -> Bases (nff_bases): nbGet→nbOpen, nbOp→nbResult plus a
		// delayed fresh nbOpen, because NFF's own functions run on the VM's
		// thread and the state only reflects them a beat later.
		g_prisma->RegisterJSListener(g_view, "nbGet", OnJsNbGet);
		g_prisma->RegisterJSListener(g_view, "nbOp", OnJsNbOp);
		// Deck Portal: state for the header button, and open-in-browser. Two
		// names, one per direction (the deck law).
		g_prisma->RegisterJSListener(g_view, "ptGet", OnJsPtGet);
		g_prisma->RegisterJSListener(g_view, "ptOpen", OnJsPtOpen);
		// CHIM button (chim_control): chState asks whether the NPC is a CHIM
		// agent -> chStateResult; chSet activates/deactivates -> chStateResult
		// (optimistic first, then reconciled from the mod's own agent set).
		g_prisma->RegisterJSListener(g_view, "chState", OnJsChState);
		g_prisma->RegisterJSListener(g_view, "chSet", OnJsChSet);
		// Recent tab. Request names hdHistory/hdHistoryClear, reply pushed as
		// hdRecent — disjoint, or toGame() would call the view's own receiver.
		g_prisma->RegisterJSListener(g_view, "hdHistory", OnJsHistory);
		g_prisma->RegisterJSListener(g_view, "hdHistoryClear", OnJsHistoryClear);
		g_prisma->RegisterJSListener(g_view, "fdEquipped", OnJsFolEquipped);
		/* fdItemSpin: bake the turntable for one worn piece on demand (the
		 * lightbox was dragged). No reply — the view derives and probes the
		 * angle-frame URLs itself, exactly like Dragon Roost's drSpin. */
		g_prisma->RegisterJSListener(g_view, "fdItemSpin", OnJsItemSpin);
		/* fdTune in, fdTuneInfo out — disjoint names, per the deck law. */
		g_prisma->RegisterJSListener(g_view, "fdTune", OnJsFolTune);
		g_prisma->RegisterJSListener(g_view, "fdRank", OnJsFolRank);
		g_prisma->RegisterJSListener(g_view, "fdRefresh", OnJsFolRefresh);
		// Portrait FRAMING (zoom / offset), so the knobs in capture.ini are
		// reachable in game instead of only from a text editor or the portal.
		// Two names, one per direction — a name used for both silently unplugs
		// the control (see the one-name-per-direction rule).
		g_prisma->RegisterJSListener(g_view, "fdFraming", OnJsFolFraming);
		g_prisma->RegisterJSListener(g_view, "fdSetFraming", OnJsFolSetFraming);
		// Portrait display CROP (v0.14.3) — pan/zoom on a photo that already
		// exists, as opposed to the framing above which aims the NEXT capture.
		// Same two-names rule: fdCropSave in, fdCrops out.
		g_prisma->RegisterJSListener(g_view, "fdCropSave", OnJsFolCropSave);
		g_prisma->RegisterJSListener(g_view, "fdSave", OnJsFolSave);
		g_prisma->RegisterJSListener(g_view, "fdLog", OnJsFolLog);
		g_prisma->RegisterJSListener(g_view, "fdPortrait", OnJsFolPortrait);
		g_prisma->RegisterJSListener(g_view, "fdPreset", OnJsFolPreset);
		g_prisma->RegisterJSListener(g_view, "fdGear", OnJsFolGear);
		// Followers HUD control (the card in the Followers tab). hudCfg in,
		// hudCfgState out — the two-names-per-direction deck law.
		g_prisma->RegisterJSListener(g_view, "hudCfg", OnJsHudCfg);
		// Wheel Menu (v0.16): the player's carryables, and using one.
		g_prisma->RegisterJSListener(g_view, "whInv", OnJsWheelInv);
		g_prisma->RegisterJSListener(g_view, "whAct", OnJsWheelAct);
		g_prisma->RegisterJSListener(g_view, "whIcons", OnJsWheelIcons);
		// Domains tab (v0.9.0): mark & recall, same deck view.
		g_prisma->RegisterJSListener(g_view, "pdMark", OnJsPlaceMark);
		g_prisma->RegisterJSListener(g_view, "pdRecall", OnJsPlaceRecall);
		g_prisma->RegisterJSListener(g_view, "pdSave", OnJsPlaceSave);
		// Place photos (v0.14.5): pdPhoto hands the player the camera; the
		// display crop is its OWN pair — pdCropSave in, pdCrops out — never the
		// wardrobe's or the portrait's, because PrismaUI installs each listener
		// as a global of that name and a shared name clobbers the handler.
		g_prisma->RegisterJSListener(g_view, "pdPhoto", OnJsPlacePhoto);
		// Scene staging (v0.14.6): TWO request names, ONE reply name. pdScene
		// asks, pdSceneSet writes the exposure, and both answer on pdSceneInfo —
		// a reply that shared a request's name would silently unplug the control
		// (the deck law, learned five times).
		g_prisma->RegisterJSListener(g_view, "pdScene", OnJsPlaceScene);
		g_prisma->RegisterJSListener(g_view, "pdSceneSet", OnJsPlaceSceneSet);
		g_prisma->RegisterJSListener(g_view, "pdCropSave", OnJsPlaceCropSave);
		g_prisma->RegisterJSListener(g_view, "pdRefresh", OnJsPlaceRefresh);
		g_prisma->RegisterJSListener(g_view, "pdClose", OnJsClose);      // alias of hdClose
		g_prisma->RegisterJSListener(g_view, "pdLog", OnJsPlaceLog);
		// Containers tab (v0.16.0): mark a container, remote-open it from anywhere.
		g_prisma->RegisterJSListener(g_view, "ctMark", OnJsContMark);
		g_prisma->RegisterJSListener(g_view, "ctGo", OnJsContGo);
		g_prisma->RegisterJSListener(g_view, "ctSave", OnJsContSave);
		g_prisma->RegisterJSListener(g_view, "ctPhoto", OnJsContPhoto);
		g_prisma->RegisterJSListener(g_view, "ctRefresh", OnJsContRefresh);
		g_prisma->RegisterJSListener(g_view, "ctLog", OnJsContLog);
		// Door lock modal: F7 on a door -> lock / unlock at a chosen level.
		g_prisma->RegisterJSListener(g_view, "drSet", OnJsDoorSet);
		g_prisma->RegisterJSListener(g_view, "drRefresh", OnJsDoorRefresh);

		g_prisma->RegisterJSListener(g_view, "rgClaim", OnJsRoomClaim);
		g_prisma->RegisterJSListener(g_view, "rgAnchor", OnJsRoomAnchor);
		g_prisma->RegisterJSListener(g_view, "rgEvict", OnJsRoomEvict);
		g_prisma->RegisterJSListener(g_view, "rgRelease", OnJsRoomRelease);
		g_prisma->RegisterJSListener(g_view, "rgIgnore", OnJsRoomIgnore);
		g_prisma->RegisterJSListener(g_view, "rgLock", OnJsRoomLock);
		g_prisma->RegisterJSListener(g_view, "rgState", OnJsRoomState);
		g_prisma->RegisterJSListener(g_view, "rgNpcs", OnJsRoomNpcs);
		g_prisma->RegisterJSListener(g_view, "tmGet", OnJsTimeGet);
		g_prisma->RegisterJSListener(g_view, "tmWait", OnJsTimeWait);
		// Keys tab. Requests kcScan/kcState/kcResult; replies kcStateResult/
		// kcResultData — names disjoint per the deck law.
		g_prisma->RegisterJSListener(g_view, "kcScan", OnJsKeysScan);
		g_prisma->RegisterJSListener(g_view, "kcState", OnJsKeysState);
		g_prisma->RegisterJSListener(g_view, "kcResult", OnJsKeysResult);
		g_prisma->RegisterJSListener(g_view, "rgSave", OnJsRoomSave);
		g_prisma->RegisterJSListener(g_view, "rgLog", OnJsRoomLog);
		g_prisma->RegisterJSListener(g_view, "rgRing", OnJsRoomRing);
		// Loot tab. Requests ltGet/ltSave/ltToggle/ltState/ltLog; replies
		// ltOpen/ltSaved/ltResult/ltStateResult — disjoint per the deck law
		// (PrismaUI installs each listener as a JS global of that name).
		// Light tab. Requests qlGet/qlOn/qlOff/qlToggle; replies qlState/qlResult
		// (names disjoint per the deck law — one name per direction).
		g_prisma->RegisterJSListener(g_view, "qlGet", OnJsQuickLightGet);
		g_prisma->RegisterJSListener(g_view, "qlOn", OnJsQuickLightOn);
		g_prisma->RegisterJSListener(g_view, "qlOff", OnJsQuickLightOff);
		g_prisma->RegisterJSListener(g_view, "qlToggle", OnJsQuickLightToggle);
		// Better FaceLight Redux state on the F7 quick card. Requests
		// bflGet/bflSet; replies bflState/bflResult (one name per direction).
		g_prisma->RegisterJSListener(g_view, "bflGet", OnJsBflGet);
		g_prisma->RegisterJSListener(g_view, "bflSet", OnJsBflSet);
		// Character Sheet tab. Requests psGet/psRemoveEffect/psSetMeta; replies
		// psData/psResult (names disjoint per the deck law - one name per
		// direction; PrismaUI installs each listener as a JS global of that name).
		g_prisma->RegisterJSListener(g_view, "psGet", OnJsSheetGet);
		g_prisma->RegisterJSListener(g_view, "psRemoveEffect", OnJsSheetRemoveEffect);
		g_prisma->RegisterJSListener(g_view, "psSetMeta", OnJsSheetSetMeta);

		g_prisma->RegisterJSListener(g_view, "ltGet", OnJsLootGet);
		g_prisma->RegisterJSListener(g_view, "ltSave", OnJsLootSave);
		g_prisma->RegisterJSListener(g_view, "ltToggle", OnJsLootToggle);
		g_prisma->RegisterJSListener(g_view, "ltState", OnJsLootState);
		// No Auto-Gear tab / F7 card. Requests ngGet/ngSave/ngToggle/ngParty/
		// ngSweep/ngState/ngLog; replies ngOpen/ngSaved/ngResult/ngStateResult
		// (names disjoint per the deck law — one name per direction).
		g_prisma->RegisterJSListener(g_view, "ngGet", OnJsNgGet);
		g_prisma->RegisterJSListener(g_view, "ngSave", OnJsNgSave);
		g_prisma->RegisterJSListener(g_view, "ngToggle", OnJsNgToggle);
		g_prisma->RegisterJSListener(g_view, "ngParty", OnJsNgParty);
		g_prisma->RegisterJSListener(g_view, "ngSweep", OnJsNgSweep);
		g_prisma->RegisterJSListener(g_view, "ngState", OnJsNgState);
		g_prisma->RegisterJSListener(g_view, "ngLog", OnJsNgLog);
		// SPID Gear (F7 card). Requests sgGet/sgInbox/sgRemove/sgChance/sgLog;
		// replies sgState/sgResult.
		g_prisma->RegisterJSListener(g_view, "sgGet", OnJsSgGet);
		g_prisma->RegisterJSListener(g_view, "sgInbox", OnJsSgInbox);
		g_prisma->RegisterJSListener(g_view, "sgRemove", OnJsSgRemove);
		g_prisma->RegisterJSListener(g_view, "sgChance", OnJsSgChance);
		g_prisma->RegisterJSListener(g_view, "sgAll", OnJsSgAll);
		g_prisma->RegisterJSListener(g_view, "sgEnable", OnJsSgEnable);
		g_prisma->RegisterJSListener(g_view, "sgNpcOp", OnJsSgNpcOp);
		g_prisma->RegisterJSListener(g_view, "sgLog", OnJsSgLog);
		g_prisma->RegisterJSListener(g_view, "ltLog", OnJsLootLog);
		// Animations tab. Requests anGet/anPlay/anReset/anState/anCrawl/anLog;
		// replies anOpen/anResult/anTargetResult — disjoint per the deck law.
		g_prisma->RegisterJSListener(g_view, "anGet", OnJsAnimGet);
		g_prisma->RegisterJSListener(g_view, "anPlay", OnJsAnimPlay);
		g_prisma->RegisterJSListener(g_view, "anReset", OnJsAnimReset);
		g_prisma->RegisterJSListener(g_view, "anState", OnJsAnimState);
		g_prisma->RegisterJSListener(g_view, "anCrawl", OnJsAnimCrawl);
		g_prisma->RegisterJSListener(g_view, "anLog", OnJsAnimLog);
		// OStim segment: requests os*, replies osOpen/osState/osList/osResult.
		g_prisma->RegisterJSListener(g_view, "osGet", OnJsOstimGet);
		g_prisma->RegisterJSListener(g_view, "osPoll", OnJsOstimPoll);
		g_prisma->RegisterJSListener(g_view, "osSearch", OnJsOstimSearch);
		g_prisma->RegisterJSListener(g_view, "osNav", OnJsOstimNav);
		g_prisma->RegisterJSListener(g_view, "osSpeed", OnJsOstimSpeed);
		g_prisma->RegisterJSListener(g_view, "osAuto", OnJsOstimAuto);
		g_prisma->RegisterJSListener(g_view, "osFurn", OnJsOstimFurn);
		g_prisma->RegisterJSListener(g_view, "osSwap", OnJsOstimSwap);
		g_prisma->RegisterJSListener(g_view, "osLog", OnJsOstimLog);
		g_prisma->RegisterJSListener(g_view, "pdCapture", OnJsCapture);  // shares g_capturing
		g_prisma->RegisterJSListener(g_view, "pdNpcList", OnJsPlaceNpcList);  // Summon NPC here: roster
		g_prisma->RegisterJSListener(g_view, "pdNpcTo", OnJsPlaceNpcTo);      // Summon NPC here: move
		// v0.11.0: per-hotkey icons + "open the Spell Deck from here". Request names
		// (hdIconList) and response names (hdIcons / hdIconIndex) stay disjoint —
		// PrismaUI installs each listener as a JS global of that name.
		g_prisma->RegisterJSListener(g_view, "hdOpenSpells", OnJsOpenSpells);
		g_prisma->RegisterJSListener(g_view, "hdIconList", OnJsIconList);
		// Finances tab (v0.13.0): recurring lines / market buy-sell / monthly settle.
		// Request names (finGet/finSave/finSettle/finBuy/finSell/finIcons) stay disjoint
		// from response names (finOpen/finState/finResult/finSaved/finIconList).
		g_prisma->RegisterJSListener(g_view, "finGet", OnJsFinGet);
		// Sharmat (CHIM intimacy profiles) — the deck's ONE outbound HTTP call.
		// Request name smCall, response name smReply: disjoint, like every other
		// pair here, because PrismaUI installs each listener as a JS global.
		g_prisma->RegisterJSListener(g_view, "smCall", OnJsSharmatCall);
		// Omni (v0.14.0): universal Search + Ask. Requests haAsk / hdSpellsIndex /
		// hdOmniCast; responses haAnswer / hdSpellsData — disjoint, same law.
		g_prisma->RegisterJSListener(g_view, "haAsk", OnJsAskCall);
		g_prisma->RegisterJSListener(g_view, "hdSpellsIndex", OnJsSpellsIndex);
		g_prisma->RegisterJSListener(g_view, "hdOmniCast", OnJsOmniCast);
		g_prisma->RegisterJSListener(g_view, "hdOmniEquip", OnJsOmniEquip);

		// Wardrobe. Requests are wd*; responses (wdOpen/wdState/wdResult/wdSaved/
		// wdShow) stay disjoint — PrismaUI installs each listener as a global of
		// that name, so a shared name clobbers the handler.
		g_prisma->RegisterJSListener(g_view, "wdGet", OnJsWdGet);
		g_prisma->RegisterJSListener(g_view, "wdSave", OnJsWdSave);
		g_prisma->RegisterJSListener(g_view, "wdDress", OnJsWdDress);
		g_prisma->RegisterJSListener(g_view, "wdTrack", OnJsWdTrack);
		g_prisma->RegisterJSListener(g_view, "wdBuild", OnJsWdBuild);
		g_prisma->RegisterJSListener(g_view, "wdWorn", OnJsWdWorn);
		g_prisma->RegisterJSListener(g_view, "wdArmorMods", OnJsWdArmorMods);
		g_prisma->RegisterJSListener(g_view, "wdArmorsFor", OnJsWdArmorsFor);
		g_prisma->RegisterJSListener(g_view, "wdPieces", OnJsWdPieces);
		g_prisma->RegisterJSListener(g_view, "wdPortrait", OnJsWdPortrait);
		g_prisma->RegisterJSListener(g_view, "wdWear", OnJsWdWear);
		g_prisma->RegisterJSListener(g_view, "wdGiveWear", OnJsWdGiveWear);
		g_prisma->RegisterJSListener(g_view, "wdEquipPiece", OnJsWdEquipPiece);
		// Photo mode landed a file: hand the view the outfit slug and the file
		// name so it can hang the image on the card without a refresh.
		// Whatever the shot did to the clock and the sky, put it back — on EVERY
		// exit, not just a successful one. Registered here so the staging module
		// never has to know photo mode exists.
		PortraitCapture::SetPhotoEndedCallback([]() { SceneStage::Restore(); });
		PortraitCapture::SetPhotoSavedCallback([](const std::string& slug, const std::string& file,
											      const std::string& label) {
			// ONE callback, TWO owners: photo mode is shared by the Wardrobe tab
			// and the Domains tab, and PortraitCapture holds a single slot. The
			// slug prefix says whose shot this was — without this branch a place
			// photo would land in the wardrobe and INVENT an outfit named after
			// the domain.
			if (slug.rfind("ct-", 0) == 0) {
				// Containers tab's twin of the domain branch — the slug prefix keeps
				// a container photo out of the wardrobe and the domains list.
				const std::string image = "container-images/" + file;
				const std::string id = g_photoContainerId;
				g_photoContainerId.clear();
				bool attached = false;
				{
					std::lock_guard l(g_configMutex);
					for (auto& m : g_contConfig.marks)
						if (m.id == id) { m.image = image; attached = true; break; }
				}
				if (!attached) {
					logger::warn("containers: photo '{}' has no container left to hang on ({})", file, id);
					return;
				}
				PersistAll();
				logger::info("containers: photo attached '{}' to '{}' ({})", file, label, id);
				PushToView("ctPhotoSaved", json{ { "id", id }, { "image", image } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				return;
			}
			if (slug.rfind("pd-", 0) == 0) {
				const std::string image = "domain-images/" + file;
				const std::string id = g_photoDomainId;
				g_photoDomainId.clear();
				bool attached = false;
				{
					std::lock_guard l(g_configMutex);
					for (auto& m : g_domConfig.marks)
						if (m.id == id) {
							m.image = image;
							attached = true;
							break;
						}
				}
				if (!attached) {
					// The domain was forgotten while the camera was up. The file
					// is still on disk and nothing is corrupted — say so rather
					// than silently binding the picture to nothing.
					logger::warn("domains: photo '{}' has no domain left to hang on ({})", file, id);
					return;
				}
				PersistAll();
				logger::info("domains: photo attached '{}' to '{}' ({})", file, label, id);
				// Usually dropped — the palette is closed during photo mode —
				// but harmless, and it makes the row update live in the one case
				// where the deck is somehow already back up.
				PushToView("pdPhotoSaved", json{
					{ "id", id },
					{ "image", image } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				return;
			}
			// Attach C++-SIDE and persist. The palette is always CLOSED during
			// photo mode, so the push below is usually dropped — relying on the
			// view to attach is why a taken photo showed nowhere (2026-08-02).
			const std::string image = "icons/custom/" + file;
			{
				std::lock_guard l(g_configMutex);
				bool have = false;
				for (auto& m : g_wardrobeConfig.outfitMeta)
					if (m.name == label) {
						m.image = image;
						have    = true;
					}
				if (!have && !label.empty()) {
					Wardrobe::OutfitMeta m;
					m.name  = label;
					m.image = image;
					g_wardrobeConfig.outfitMeta.push_back(std::move(m));
				}
			}
			PersistAll();
			logger::info("photo: attached '{}' to outfit '{}'", file, label);
			PushToView("wdPhotoSaved", json{
				{ "slug", slug },
				{ "image", image } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
		});

		// Outfit-photo display CROP (v0.14.4) — pan/zoom on a picture that
		// already exists. Same two-names rule: wdCropSave in, wdCrops out.
		g_prisma->RegisterJSListener(g_view, "wdCropSave", OnJsWdCropSave);

		g_prisma->RegisterJSListener(g_view, "wdRemovePiece", OnJsWdRemovePiece);
		g_prisma->RegisterJSListener(g_view, "wdOutfitDel", OnJsWdOutfitDel);
		g_prisma->RegisterJSListener(g_view, "wdImport", OnJsWdImport);
		// The importer's browser + the three SOES calls that had no route out of
		// its MCM. One name per DIRECTION throughout: wdOutfitMods asks,
		// wdOutfitModList answers; wdOutfitsFor asks, wdOutfitList answers.
		g_prisma->RegisterJSListener(g_view, "wdOutfitMods", OnJsWdOutfitMods);
		g_prisma->RegisterJSListener(g_view, "wdOutfitsFor", OnJsWdOutfitsFor);
		g_prisma->RegisterJSListener(g_view, "wdRename", OnJsWdRename);
		g_prisma->RegisterJSListener(g_view, "wdFav", OnJsWdFav);
		g_prisma->RegisterJSListener(g_view, "wdSoesOpt", OnJsWdSoesOpt);
		g_prisma->RegisterJSListener(g_view, "wdInvMode", OnJsWdInvMode);
		g_prisma->RegisterJSListener(g_view, "wdEnable", OnJsWdEnable);
		g_prisma->RegisterJSListener(g_view, "wdRefreshAll", OnJsWdRefreshAll);
		g_prisma->RegisterJSListener(g_view, "wdResetAuto", OnJsWdResetAuto);
		g_prisma->RegisterJSListener(g_view, "wdLog", OnJsWdLog);

		// NFF outfits. Requests are nf*; responses (nfOpen/nfResult/nfPieceList)
		// stay disjoint — PrismaUI installs each listener as a global of that
		// name, so a shared name clobbers the handler.
		g_prisma->RegisterJSListener(g_view, "nfGet", OnJsNfGet);
		g_prisma->RegisterJSListener(g_view, "nfSave", OnJsNfSave);
		g_prisma->RegisterJSListener(g_view, "nfWear", OnJsNfWear);
		g_prisma->RegisterJSListener(g_view, "nfBuild", OnJsNfBuild);
		g_prisma->RegisterJSListener(g_view, "nfClear", OnJsNfClear);
		g_prisma->RegisterJSListener(g_view, "nfSatchel", OnJsNfSatchel);
		g_prisma->RegisterJSListener(g_view, "nfClaim", OnJsNfClaim);
		g_prisma->RegisterJSListener(g_view, "nfPieces", OnJsNfPieces);
		g_prisma->RegisterJSListener(g_view, "nfCopy", OnJsNfCopy);
		// NFF's own outfit calls the deck could not reach: Copy Outfit, Outfit
		// Preview Mode, its outfit-switch hotkey, and the shared player chest.
		g_prisma->RegisterJSListener(g_view, "nfClone", OnJsNfClone);
		g_prisma->RegisterJSListener(g_view, "nfPreview", OnJsNfPreview);
		g_prisma->RegisterJSListener(g_view, "nfSwitch", OnJsNfSwitch);
		g_prisma->RegisterJSListener(g_view, "nfChest", OnJsNfChest);
		// One name per direction: nfGear/nfSetGear in, nfGearState out.
		g_prisma->RegisterJSListener(g_view, "nfGear", OnJsNfGear);
		g_prisma->RegisterJSListener(g_view, "nfSetGear", OnJsNfSetGear);
		g_prisma->RegisterJSListener(g_view, "nfLog", OnJsNfLog);
		g_prisma->RegisterJSListener(g_view, "finSave", OnJsFinSave);
		g_prisma->RegisterJSListener(g_view, "finSettle", OnJsFinSettle);
		g_prisma->RegisterJSListener(g_view, "finBuy", OnJsFinBuy);
		g_prisma->RegisterJSListener(g_view, "finSell", OnJsFinSell);
		g_prisma->RegisterJSListener(g_view, "finBuyProp", OnJsFinBuyProp);
		g_prisma->RegisterJSListener(g_view, "finSellProp", OnJsFinSellProp);
		g_prisma->RegisterJSListener(g_view, "finIcons", OnJsFinIcons);
		g_prisma->RegisterJSListener(g_view, "finLog", OnJsFinLog);
	}

	// ---- smooth pause: freeze the WORLD (sgtm 0) instead of a menu pause -------
	// A menu pause stops the update loop, which makes Skyrim's cursor floaty
	// (framerate-coupled). Freezing time with sgtm 0 leaves the render loop
	// running at full FPS — buttery cursor — while time/AI/physics are frozen.
	std::atomic<bool> g_worldFrozen{ false };

	// Console command on the MAIN thread (CompileAndRun touches game state). Same
	// pattern as PortraitCapture::RunConsole.
	void RunConsoleCmd(const char* cmd)
	{
		auto* factory = RE::IFormFactory::GetConcreteFormFactoryByType<RE::Script>();
		auto* script  = factory ? factory->Create() : nullptr;
		if (!script)
			return;
		script->SetCommand(cmd);
		script->CompileAndRun(nullptr);
		delete script;
	}

	// Idempotent. sgtm 0 == world frozen, sgtm 1 == normal. Restored on every
	// close path (ClosePalette / ForceClosePalettes / the 1 s watchdog) and before
	// a load, so the player can never be stranded frozen. Restore forces 1.0 (the
	// standard menu behaviour); a mod running permanent slow-mo is the one edge
	// this does not preserve, and is vanishingly rare.
	void FreezeWorld(bool freeze)
	{
		if (freeze == g_worldFrozen.load())
			return;
		RunConsoleCmd(freeze ? "sgtm 0" : "sgtm 1");
		g_worldFrozen = freeze;
		logger::info("smooth-pause: world {} (sgtm)", freeze ? "frozen" : "resumed");  // marker: smooth-pause-sgtm
	}

	bool SmoothPauseOn()
	{
		std::lock_guard l(g_configMutex);
		return g_config.settings.smoothPause;
	}

	// The single focus+pause routine every site funnels through. In smooth mode a
	// "paused" open focuses the view UN-paused and freezes the world; classic mode
	// uses the engine menu pause and never freezes. `wantPaused` is the LOGICAL
	// state (g_focusPaused), independent of the mechanism.
	void FocusDeck(bool wantPaused)
	{
		const bool smooth = SmoothPauseOn();
		g_prisma->Unfocus(g_view);
		if (!g_prisma->Focus(g_view, wantPaused && !smooth))
			logger::warn("Focus() returned false");
		g_focusPaused = wantPaused;
		FreezeWorld(wantPaused && smooth);
	}

	// Re-focus the view with/without the game pause. Main thread only.
	void ApplyFocusPause(bool pause)
	{
		if (!g_prisma || !g_open.load() || pause == g_focusPaused.load())
			return;
		FocusDeck(pause);
	}

	// Main thread only.
	void OpenPalette()
	{
		if (!g_prisma || !g_viewReady.load() || g_open.load())
			return;
		// Belt and braces: the 1 s portal poller normally lands a phone edit long
		// before this, but a sidecar written while the poller was mid-batch (or
		// while a rebind modal held it off) must still show up on the next open.
		// Idempotent — an assignment already in place is a no-op and never
		// rewrites hotkeys.json.
		ApplyPortalHotkeyIcons(DeckViewDir() / "icons" / "custom");
		ApplyPortalHotkeyEdits(DeckViewDir());
		ApplyPortalPortraits();
		// Category glyphs land in g_folConfig, which is snapshotted into `fcfg` a
		// few lines down — so applying here means an icon chosen on the phone
		// while the deck was closed is already on the rail at this open.
		if (CatIconQueuePending())
			ApplyPortalCatIcons();
		// Scan (sweep + magic->deck mirror) BEFORE hdOpen goes out: hdOpen carries
		// entries[].icon, and an <img src> whose file has not landed in THIS view's
		// folder yet paints as a hidden icon until something re-renders the list.
		// One scan per open — the listing is pushed further down, after hdOpen.
		const std::string iconList = DeckCustomIconsJson();
		std::string payload, fcfg, domPayload, roomPayload, contPayload;
		bool        pause;
		bool        cropsPruned = false;
		{
			std::lock_guard l(g_configMutex);
			// The open payload carries a runtime mod-detection map so the view can
			// hide integrations the player hasn't installed. NOT part of ConfigToJson
			// (that one is also what WriteConfigFile persists) — added here only.
			json cj = ConfigToJson(g_config);
			cj["detected"] = DetectedModsJson();
			payload = cj.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			fcfg = FollowerConfigToJson(g_folConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// Once per session, before the first domain crop map goes out: drop
			// crops whose photo has been deleted since the last run. Saving a
			// crop prunes too, so this only covers the player who deletes files
			// and never re-crops — but it also means the map cannot grow across
			// sessions on its own. A no-op on an unreadable/empty folder.
			static bool s_prunedDomainCrops = false;
			if (!s_prunedDomainCrops) {
				s_prunedDomainCrops = true;
				cropsPruned = Wardrobe::PruneCropMap(g_domConfig.imageCrops,
					DeckViewDir() / "domain-images");
			}
			domPayload = DomainsConfigToJson(g_domConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			contPayload = ContainerConfigToJson(g_contConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			// Carries the live "where are you standing" snapshot too, so the Rooms
			// pane can offer Claim with a suggested name the moment it is shown.
			roomPayload = RoomGuard::OpenJson(g_roomConfig);
			pause = g_config.settings.pauseOnOpen;
		}
		if (cropsPruned)
			PersistAll();   // outside the lock: PersistAll takes it itself
		// Snapshot the crosshair NPC before the cursor menu / pause takes over,
		// so action entries (freeze/sit/…) act on who the player was looking at.
		NpcActions::SnapshotTarget();
		// Same beat: snapshot the crosshair CONTAINER for the Containers tab's
		// "Mark this container" card (frozen now that the palette pauses the game).
		ContainerActions::SnapshotTarget();
		// And the crosshair DOOR for the lock modal. Reads NpcActions' non-actor
		// snapshot, so it must run after NpcActions::SnapshotTarget() above.
		DoorActions::SnapshotTarget();
		g_open = true;
		g_prisma->Show(g_view);
		FocusDeck(pause);   // smooth pause (sgtm 0 + unpaused focus) or classic menu pause
		// Cooperative half of the search-box fix: mods that check textEntryCount
		// hold their hotkeys while we own the keyboard. Guarded so it cannot leak.
		SetTextInputGuard(true);
		g_prisma->Invoke(g_view, ("hdOpen(" + payload + ")").c_str());
		// Tab-pane payloads after hdOpen (it resets the view): the Followers
		// chrome config, the Domains slice + a fresh location snapshot, then any
		// pending deep-open target (F14/F15 pressed while the palette was closed).
		g_prisma->Invoke(g_view, ("fdConfig(" + fcfg + ")").c_str());
		// The crosshair snapshot taken a few lines above. Pushed HERE, at open,
		// because it is an open-time fact — and because the quick-follower card
		// on the Hotkeys tab needs it too. It used to be sent only from
		// OnJsFolRefresh, which is fired by the Followers PANE's onShow: open the
		// deck on any other tab and the card never learned who you were looking
		// at, so it sat on its "look at an NPC first" empty state while you were
		// staring right at one.
		g_prisma->Invoke(g_view, ("fdTarget(" + FolTargetJson() + ")").c_str());
		// The non-actor twin: opened while looking at a ground item -> the view
		// shows which mod it comes from. Null when the crosshair held nothing
		// (or held an actor), and the banner stays hidden.
		g_prisma->Invoke(g_view, ("hdItemSource(" + ItemSourceJson() + ")").c_str());
		g_prisma->Invoke(g_view, ("hdRecent(" + HotkeyHistory::Json() + ")").c_str());
		g_prisma->Invoke(g_view, ("fdPortraits(" + FolPortraitsJson() + ")").c_str());
		// Once per session, before the first crop map goes out: drop crops whose
		// photo has been deleted since the last run. Saving a crop prunes too, so
		// this only covers the player who deletes files and never re-crops — but
		// that is exactly the case where the map would otherwise grow forever.
		// Guarded rather than run every open: it is a directory walk, and the
		// open path already pays for one in FolPortraitsJson().
		static bool pruned = false;
		if (!pruned) {
			pruned = true;
			if (PrunePortraitCrops())
				PersistAll();
		}
		g_prisma->Invoke(g_view, ("fdCrops(" + FolCropsJson() + ")").c_str());
		// Followers HUD control state (the card in the Followers tab).
		g_prisma->Invoke(g_view, ("hudCfgState(" + HudDeckStateJson() + ")").c_str());
		// The ROSTER, at open. It used to arrive only from OnJsFolRefresh — the
		// Followers pane's onShow — so on any other tab the view's category list
		// was empty. The quick-follower card on the Hotkeys tab reads it to say
		// who the crosshair NPC actually is (filed where, what you wrote about
		// her) and to offer Summon / Go to / Send back, which are Follower
		// Organizer ops addressed by (category, index); with no roster it called
		// every real follower "unfiled" and offered nothing.
		//
		// Free, as it happens: NffBridge::StateJson()'s no-argument overload
		// builds the FO state itself, so this open was already paying for one.
		// Build it ONCE and feed both, which is exactly what OnJsFolRefresh does.
		const auto foAtOpen = FollowerDeck::StateJson();
		g_prisma->Invoke(g_view, ("fdState(" + foAtOpen + ")").c_str());
		// LIVE party — the same teammate/faction scan the HUD uses, so the
		// Followers tab's "Current party" shows framework-driven companions the FO
		// roster never lists (Amaniri's Nether's Niri, Vayne's CSV, CHIM soft-
		// follow). The view merges these into partyList() de-duped by formId, so
		// an FO member is never doubled and a non-FO follower is no longer dropped.
		g_prisma->Invoke(g_view, ("fdLiveParty(" + HudFollowersJson() + ")").c_str());
		logger::info("[followers] live-party pushed on open");  // marker: followers-live-party
		// NFF home base + My Home is Your Home NG home, read-only, keyed by the
		// same formIds the FO envelope uses. Both mods are soft: with neither
		// installed this is an empty members map and the roster is unchanged.
		g_prisma->Invoke(g_view, ("fdNff(" + NffBridge::StateJson(foAtOpen) + ")").c_str());
		// Fertility Mode pregnancy / cycle, same rail and the same soft posture:
		// with FM absent this is an empty actors map and the roster is unchanged.
		g_prisma->Invoke(g_view, ("fdFertility(" + FertilityBridge::StateJson(foAtOpen) + ")").c_str());
		g_prisma->Invoke(g_view, ("pdOpen(" + domPayload + ")").c_str());
		g_prisma->Invoke(g_view, ("rgOpen(" + roomPayload + ")").c_str());
		g_prisma->Invoke(g_view, ("pdHere(" + PlaceActions::CurrentLocationJson() + ")").c_str());
		// Containers tab: its slice + the crosshair-container snapshot taken above.
		g_prisma->Invoke(g_view, ("ctOpen(" + contPayload + ")").c_str());
		g_prisma->Invoke(g_view, ("ctTarget(" + ContainerActions::TargetJson() + ")").c_str());
		// Opened while looking at a DOOR -> the lock modal raises itself over
		// whatever tab loads (hd-door.js auto-opens on a fresh non-null push;
		// a null push closes any stale modal from the previous open).
		g_prisma->Invoke(g_view, ("drTarget(" + DoorActions::TargetJson() + ")").c_str());
		// Icon library, same two-step as the Spell Deck: the heavy index once per
		// session (each view resolves "icons/..." against its OWN folder, so the deck
		// needs its own push), the live custom listing (scanned above) on every open.
		// Before the g_pendingTab block, which must stay last — hdShowTab can close
		// the view.
		if (!g_deckIconIndexPushed.exchange(true))
			g_prisma->Invoke(g_view, ("hdIconIndex(" + DeckIconIndexJson() + ")").c_str());
		g_prisma->Invoke(g_view, ("hdIcons(" + iconList + ")").c_str());
		// Opened while looking at someone -> land on Followers, where that
		// person's dismiss / inventory / outfit / wait buttons are (Rober,
		// 2026-08-02). Deliberately last, and deliberately only when nothing
		// else claimed the tab: F14/F15 are explicit deep-opens and must win
		// over a heuristic. With an empty crosshair this is a no-op, so the
		// plain "F7 to reach my hotkeys" habit is untouched.
		//
		// Reads the SAME snapshot fdTarget was built from a few lines above, so
		// the tab we land on and the person the card names can never disagree.
		if (g_pendingTab.empty() && NpcActions::TargetFormID() != 0) {
			bool wants = false;
			{
				std::lock_guard l(g_configMutex);
				wants = g_config.settings.targetOpensFollowers;
			}
			// The Followers tab rides Follower Organizer; with FO absent the tab is
			// HIDDEN in the view (SYS_TABS requires:'followerorganizer'). Routing a
			// plain F7-with-target onto it would bounce the view to Home with a
			// toast on every look-and-open — so degrade here: don't route to a tab
			// that isn't there (2026-08-12 gate sweep). The explicit-false gate
			// mirrors the view's tabAvailable.
			const auto& det = DetectedModsJson();
			const bool  foGone = det.contains("followerorganizer") && det["followerorganizer"].is_boolean() && det["followerorganizer"].get<bool>() == false;
			if (wants && !foGone) {
				g_pendingTab = "followers";
				logger::info("open: crosshair target -> landing on the Followers tab");
			} else if (wants && foGone) {
				logger::info("open: crosshair target, but Follower Organizer absent -> Followers tab hidden, staying put");  // marker: gate-f7-followers
			}
		}
		if (!g_pendingTab.empty()) {
			g_prisma->Invoke(g_view, ("hdShowTab(\"" + g_pendingTab + "\")").c_str());
			g_pendingTab.clear();
		}
	}

	// Main thread only.
	void ClosePalette()
	{
		if (!g_prisma || !g_open.exchange(false))
			return;
		g_capturing = false;  // hdClosed() clears the JS capture without notifying us
		g_prisma->Invoke(g_view, "hdClosed()");
		g_prisma->Unfocus(g_view);
		g_prisma->Hide(g_view);
		g_focusPaused = false;
		FreezeWorld(false);   // never leave the world frozen after a close
		SetTextInputGuard(false);
	}

	// Unconditional close. ClosePalette()/CloseMagicPalette() both bail out when
	// their g_*open flag is already false -- which is correct for a normal toggle
	// and catastrophic in the one state that actually strands the player:
	//
	//   the view is SHOWN and holding PrismaUI focus, but g_open is FALSE.
	//
	// That state is reachable because OpenPalette() is gated on CanOpenNow(),
	// and CanOpenNow() returns false while a TEXT FIELD is active
	// (textEntryCount > 0) -- e.g. the deck's own search box. Skip the open and
	// the flag never goes true, but PrismaUI is already showing/holding the view.
	// From there every exit is disabled: Escape is gated on AnyOpen(), the open
	// key tries to OPEN and is refused because focus is held, the close-view pipe
	// command lands in ClosePalette()'s early return, and the in-view buttons are
	// dead. Rober hit exactly this twice on 2026-08-01, both times while typing in
	// the search box, and both times the only way out was killing SkyrimSE.
	//
	// So: ignore the flags, tell PrismaUI to let go, and put the flags back in
	// sync with reality afterwards.
	void ForceClosePalettes(const char* why)
	{
		if (!g_prisma)
			return;
		logger::warn("force-close ({}): open={} magicOpen={} capturing={} anyFocus={}",
			why, g_open.load(), g_magicOpen.load(), g_capturing.load(),
			g_prisma->HasAnyActiveFocus());
		g_capturing      = false;
		g_captureStartMs = 0;
		g_lastEscMs      = 0;
		if (g_view) {
			g_prisma->Invoke(g_view, "hdClosed()");
			g_prisma->Unfocus(g_view);
			g_prisma->Hide(g_view);
		}
		if (g_magicView) {
			g_prisma->Invoke(g_magicView, "mdClosed()");
			g_prisma->Unfocus(g_magicView);
			g_prisma->Hide(g_magicView);
		}
		g_open            = false;
		g_magicOpen       = false;
		g_focusPaused     = false;
		g_magicFocusPaused = false;
		FreezeWorld(false);        // the rescue must also thaw a frozen world
		SetTextInputGuard(false);  // never strand the engine's text-entry refcount
	}

	// Runs on the main thread once a second. Recovers the stranded state WITHOUT
	// the player having to know a rescue key exists -- which is the whole point:
	// a lockout the player never sees is better than one they can escape from.
	// Requires the condition to hold for a couple of consecutive ticks so a normal
	// open/close, which briefly has the view shown before the flag flips, is never
	// mistaken for it.
	std::atomic<int> g_desyncTicks{ 0 };

	void DesyncWatchdogTick()
	{
		// Smooth-pause safety net: the world must never stay frozen with no palette
		// up. Every close path thaws it already; this catches any path that didn't
		// (an unforeseen close, a mod force-hiding our view) within a second.
		if (g_worldFrozen.load() && !g_open.load() && !g_magicOpen.load())
			FreezeWorld(false);
		if (!PalettesDesynced()) {
			g_desyncTicks = 0;
			return;
		}
		// 5 s, not 3: a legitimate handoff can look identical for a moment --
		// opening the console, the deck -> Spell Deck jump, a tab switch that
		// re-focuses. None of those last five seconds; being locked out does.
		if (g_desyncTicks.fetch_add(1) + 1 >= 5) {
			// Reset BEFORE acting: Hide() may not be reflected by IsHidden() on the
			// very next tick, and without this the watchdog would re-fire (and
			// re-log) every second afterwards. Zeroing here means a genuinely
			// unfixable strand retries every 3 s instead of spamming.
			g_desyncTicks = 0;
			const bool unfocused = ViewOpenButUnfocused(g_view, g_open.load()) ||
			                       ViewOpenButUnfocused(g_magicView, g_magicOpen.load());
			ForceClosePalettes(unfocused
				? "watchdog: palette OPEN but another view holds the keyboard"
				: "watchdog: view shown but palette flag says closed");
		}
	}

	// The impossible state above: one of OUR views is SHOWN while its palette flag
	// says closed. Nothing else can be true at once, so seeing it is enough to act.
	//
	// Uses the PER-VIEW IsHidden(), not HasAnyActiveFocus(). The global check was
	// wrong: another mod's PrismaUI view (CHIM chat, Tailor) holding focus while
	// our palettes are shut is a completely NORMAL state, so it would have
	// misfired through every CHIM conversation.
	bool ViewStranded(PrismaView v, bool openFlag)
	{
		return v && g_prisma && g_prisma->IsValid(v) && !g_prisma->IsHidden(v) && !openFlag;
	}

	// The OTHER stranded state, and the one that actually kept happening:
	// we believe the palette is OPEN, but the keyboard belongs to somebody else.
	//
	// PrismaUI focus CAPTURES mouse/keyboard for the focused view, so the deck's
	// Escape is handled by the VIEW's own JS (hdClose), not by our input sink --
	// which is why every sink-side rescue key was dead code in precisely the
	// situation it was written for, and why not one of them logged.
	//
	// When another PrismaUI view takes focus (CHIM's chat opening on V, which is
	// what Rober kept hitting), our view stops receiving keys, so its Esc handler
	// never runs; our sink never sees them either; and g_open is still true, so
	// nothing looks wrong from the DLL's side. Open-but-not-focused for several
	// seconds is that state, and it is not reachable any other way: a genuinely
	// open deck owns the keyboard.
	bool ViewOpenButUnfocused(PrismaView v, bool openFlag)
	{
		return v && g_prisma && openFlag && g_prisma->IsValid(v) && !g_prisma->HasFocus(v);
	}

	bool PalettesDesynced()
	{
		return ViewStranded(g_view, g_open.load()) ||
		       ViewStranded(g_magicView, g_magicOpen.load()) ||
		       ViewOpenButUnfocused(g_view, g_open.load()) ||
		       ViewOpenButUnfocused(g_magicView, g_magicOpen.load());
	}

	// True while one of our views legitimately owns the keyboard -- i.e. the player
	// is typing into OUR ui. Used to stop other mods' input sinks seeing those
	// keystrokes at all (see the sink's kStop), which is what makes the search box
	// safe rather than merely recoverable.
	bool OurViewHasKeyboard()
	{
		if (!g_prisma)
			return false;
		return (g_view && g_prisma->IsValid(g_view) && g_prisma->HasFocus(g_view)) ||
		       (g_magicView && g_prisma->IsValid(g_magicView) && g_prisma->HasFocus(g_magicView));
	}

	// Cooperative signal for well-behaved mods: bump the engine's text-entry
	// refcount while our search box owns the keyboard, so anything that checks
	// textEntryCount (as our own CanOpenNow does) holds its hotkeys.
	//
	// Guarded so it can NEVER leak: we only take the reference when the count is
	// zero, and only ever release one we took. A leaked textEntryCount costs the
	// player every hotkey in the game until they restart, which would be a far
	// worse bug than the one this prevents. PrismaUI may well bump it itself --
	// if it does, the count is already non-zero and we simply stay out of it.
	std::atomic<bool> g_tookTextInput{ false };

	void SetTextInputGuard(bool on)
	{
		auto* cm = RE::ControlMap::GetSingleton();
		if (!cm)
			return;
		if (on) {
			if (!g_tookTextInput.load() && cm->GetRuntimeData().textEntryCount == 0) {
				cm->AllowTextInput(true);
				g_tookTextInput = true;
			}
		} else if (g_tookTextInput.exchange(false)) {
			cm->AllowTextInput(false);
		}
	}

	void FireAndClose(HotkeyEntry entry)
	{
		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); });
		std::thread([entry = std::move(entry), reopen]() {
			// Give the game a few frames to unpause and take input focus back.
			std::this_thread::sleep_for(std::chrono::milliseconds(200));
			FireChord(entry.device, entry.code, entry.mods);
			if (reopen) {
				std::this_thread::sleep_for(std::chrono::milliseconds(250));
				SKSE::GetTaskInterface()->AddTask([]() {
					if (CanOpenNow())
						OpenPalette();
				});
			}
		}).detach();
	}

	// VirtualKey entry (device == "vkey"): close the palette, then fire the virtual
	// key. Same close/reopen timing as FireAndClose, but the payload is a native
	// InputEvent (VKey::Fire) instead of a synthesized scancode -- a virtual key is
	// not a keyboard key, so SendInput could never reach it. The verb rides in the
	// reused `action` field ("tap" default / "down" / "up").
	void FireVKeyAndClose(HotkeyEntry entry)
	{
		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		const std::int32_t code = static_cast<std::int32_t>(entry.code);
		const std::string  verb = entry.action.empty() ? std::string("tap") : entry.action;
		SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); });
		std::thread([code, verb, reopen]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(200));
			VKey::Fire(code, verb);
			if (reopen) {
				std::this_thread::sleep_for(std::chrono::milliseconds(250));
				SKSE::GetTaskInterface()->AddTask([]() {
					if (CanOpenNow())
						OpenPalette();
				});
			}
		}).detach();
	}

	// Native action entry (device == "action"): close the palette, then run the
	// C++ action against the snapshotted target. No keystroke is synthesized.
	void FireAction(HotkeyEntry entry)
	{
		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		std::string action = entry.action;

		// Portrait capture owns its own timing and must NOT be followed by a
		// reopen: it photographs the screen a few frames from now, and the
		// palette painting itself back over the world is precisely what it is
		// waiting to be rid of.
		if (PortraitCapture::IsAction(action)) {
			const auto dir = DeckViewDir() / "portraits";
			SKSE::GetTaskInterface()->AddTask([dir]() {
				ClosePalette();
				PortraitCapture::Fire(dir);
			});
			return;
		}

		// A full save owns its timing for the same reason portrait capture does,
		// and must NOT be followed by a reopen: the engine grabs the save's
		// THUMBNAIL from the frame it saves on, so the deck has to be off screen
		// and stay off until the save has gone in. A reopen would race that and
		// put the palette in the picture.
		if (SaveActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				SaveActions::Fire();
			});
			return;
		}

		// The animation un-wedge also owns its timing, and must NOT reopen: its
		// sheathe->redraw second half runs on unpaused ticks, and the palette
		// painting itself back over the game would pause it mid-cycle. The
		// bridged call posts its own task, giving menu-close one extra frame to
		// hand controls back before the resolver checks who owns the player.
		// Instant wait: jump the game clock in one step. Close first so the
		// catch-up hitch happens on the world, not under the palette; reopen
		// per the user's close-after-fire preference like a normal action.
		if (TimeActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([action, reopen]() {
				ClosePalette();
				TimeActions::Fire(action);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// Fixes / Unstuck: console-backed rescues on the crosshair NPC snapshot
		// (recycleactor / resetai / resurrect / calm) or the player (tcl). Close
		// first so the command runs on the live world, reopen per preference —
		// same shape as the time/anim actions above.
		if (FixActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([action, reopen]() {
				ClosePalette();
				FixActions::Fire(action);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// Wheel Menu: open the radial palette. Unlike every other action here it
		// does NOT close the palette — it IS a palette surface, so it takes the
		// same road the Ctrl+F7 chord does (g_pendingTab -> hdShowTab("wheel")).
		// Fired from a bound key with the deck shut, that opens the view onto
		// the wheel; fired from a row inside the deck, the view is already up
		// and only the overlay is raised.
		if (action == "wheel") {
			SKSE::GetTaskInterface()->AddTask([]() {
				if (g_open.load()) {
					if (g_prisma && g_viewReady.load())
						g_prisma->Invoke(g_view, "hdShowTab(\"wheel\")");
					return;
				}
				if (!CanOpenNow())
					return;
				g_pendingTab = "wheel";
				EnsureViewAndOpen();
			});
			return;
		}

		// Hotbar. Both act on a view of our own, not on a crosshair target, so a
		// trigger key needs no snapshot. Show/hide is safe with the palette open
		// (it only flips a flag), but SET UP must close the deck first: two
		// PrismaUI views cannot hold focus at once, and the edit panel needs it.
		if (action == "hotbar-toggle") {
			SKSE::GetTaskInterface()->AddTask([]() { HbToggleVisible(); });
			return;
		}
		if (action == "hotbar-edit") {
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				// One frame later, so the deck has actually let go of focus
				// before we ask for it — grabbing it in the same task is how you
				// get a view that is Shown, Focused and deaf.
				SKSE::GetTaskInterface()->AddTask([]() { HbOpenEdit(); });
			});
			return;
		}

		// Rooms privacy lockdown: seal the claimed room you are standing in —
		// nobody in at all — or lift the seal. It acts on the PLACE, not on a
		// crosshair target, so a trigger key needs no snapshot and this is the
		// same code whether it came from the palette or a bound key. Close first
		// so the eviction happens on the live world, reopen per preference.
		if (action == "room-privacy") {
			SKSE::GetTaskInterface()->AddTask([reopen]() {
				ClosePalette();
				std::string res;
				{
					std::lock_guard l(g_configMutex);
					res = RoomGuard::ToggleLockdown(g_roomConfig, "");
				}
				if (!PersistAll())
					logger::error("room-privacy: flipped but failed to write to disk");
				PushToView("rgResult", res);  // the pane's toast, if it is open behind us
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// Crawl toggle (the seeded "crawl" action or a bound key): make the
		// crosshair target crawl on all fours. Plain toggle — close, fire, reopen.
		if (AnimActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([reopen]() {
				ClosePalette();
				const std::string res = AnimActions::ToggleCrawl();
				PushToView("anResult", res);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// Loot Vision toggle: instant state flip, nothing owns the screen — so
		// unlike the flows above it follows the normal close-after-fire
		// preference. The pane (if open behind the reopen) gets ltResult so its
		// master switch tracks the truth.
		if (LootHighlight::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([reopen]() {
				ClosePalette();
				std::string res;
				{
					std::lock_guard l(g_configMutex);
					res = LootHighlight::ToggleMaster(g_lootConfig);
				}
				PersistAll();  // outside the lock — PersistAll takes it too
				PushToView("ltResult", res);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// No Auto-Gear: toggle protection on the crosshair NPC, or protect the
		// whole party. Instant, nothing owns the screen — normal close-after-fire.
		if (action == "no-auto-gear" || action == "no-auto-gear-party") {
			const bool party = action == "no-auto-gear-party";
			SKSE::GetTaskInterface()->AddTask([reopen, party]() {
				ClosePalette();
				std::string res;
				{
					std::lock_guard l(g_configMutex);
					res = party ? NoAutoGear::ProtectParty(g_ngConfig)
					            : NoAutoGear::ToggleCrosshair(g_ngConfig);
				}
				PersistAll();  // outside the lock — PersistAll takes it too
				PushToView("ngResult", res);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		// Quick Light toggle: like Loot Vision, nothing owns the screen, so it
		// honours the normal close-after-fire preference. The Light pane (if
		// open behind the reopen) gets qlResult + qlState so its indicator
		// tracks the truth. No config to persist — the state is in the save.
		if (QuickLight::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([reopen]() {
				ClosePalette();
				const std::string res = QuickLight::Toggle();
				PushToView("qlResult", res);
				PushToView("qlState", QuickLight::StateJson());
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		if (AnimResolverBridge::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				AnimResolverBridge::Fire();
			});
			return;
		}

		// The controls un-wedge must NOT reopen either: half of it runs through
		// the Papyrus VM, and a reopened palette (pauseOnOpen) would pause the
		// VM and hold that half hostage until the deck closed again.
		if (ControlsFix::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				ControlsFix::Fire();
			});
			return;
		}

		// AddItemMenu opens its own UIExtensions menus and the whole flow runs
		// through the Papyrus VM — a reopened palette (pauseOnOpen) would pause
		// the VM mid-flow and paint over the list, so like the controls fix:
		// close and stay closed.
		if (AimActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([action]() {
				ClosePalette();
				AimActions::Fire(action);
			});
			return;
		}

		// Open another mod's settings menu (Prisma MCM / SKSE Menu Framework /
		// Community Shaders): close the palette so the game has focus and is
		// unpaused, then synthesize the key that mod listens for. The menu owns
		// the screen after it opens, so NEVER reopen — Fire() runs its own
		// worker thread with a settle delay, so the task returns at once.
		if (MenuActions::IsAction(action)) {
			SKSE::GetTaskInterface()->AddTask([action]() {
				ClosePalette();
				MenuActions::Fire(action);
			});
			return;
		}

		// Sic 'em is a combat command: close the palette, send the followers in,
		// and stay closed even with close-after-fire off — the last thing you
		// want mid-swing is the paused menu painting itself back over the fight.
		if (action == "attack-target") {
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				NpcActions::Run("attack-target");
			});
			return;
		}

		// Grab owns the screen after firing: the NPC follows the crosshair until
		// placed, so the palette must never repaint itself over the drag —
		// no reopen even with close-after-fire off. Firing grab while a
		// delegated drag is already live is a TOGGLE: cancel it (via OMO's own
		// Cancel input) instead of starting another.
		if (action == "grab") {
			if (NpcActions::OmoGrabActive()) {
				SKSE::GetTaskInterface()->AddTask([]() {
					ClosePalette();
					NpcActions::CancelOmoGrab();
				});
				SynthOmoCancelClick();
				return;
			}
			SKSE::GetTaskInterface()->AddTask([]() {
				ClosePalette();
				NpcActions::Run("grab");
			});
			return;
		}

		SKSE::GetTaskInterface()->AddTask([action, reopen]() {
			ClosePalette();
			NpcActions::Run(action);
			if (reopen)
				SKSE::GetTaskInterface()->AddTask([]() {
					if (CanOpenNow())
						OpenPalette();
				});
		});
	}

	// ---------------------------------------------------------- JS -> C++ API

	// "Shift + Z" from mods + key, mirroring the view's chordLabel() so a row in
	// the history reads exactly like the chip on the entry it came from. The
	// three modifier DIKs are the same ones FireChord holds down.
	std::string ChordLabel(const std::vector<std::uint32_t>& mods, const std::string& key)
	{
		std::string out;
		for (const auto m : mods) {
			switch (m) {
			case 42: out += "Shift + "; break;
			case 29: out += "Ctrl + ";  break;
			case 56: out += "Alt + ";   break;
			default: break;
			}
		}
		out += key.empty() ? "?" : key;
		return out;
	}

	void OnJsFire(const char* data)
	{
		if (!data)
			return;
		const std::string id = data;
		HotkeyEntry       entry;
		bool              found = false;
		{
			std::lock_guard l(g_configMutex);
			for (const auto& e : g_config.entries)
				if (e.id == id) {
					entry = e;
					found = true;
					break;
				}
		}
		if (!found) {
			logger::warn("hdFire: unknown entry id '{}'", id);
			return;
		}
		if (entry.device == "action") {
			logger::info("action '{}' -> {}", entry.name, entry.action);
			HotkeyHistory::Record(HotkeyHistory::Source::kAction, entry.name,
				entry.label.empty() ? entry.action : entry.label, entry.category);
			FireAction(std::move(entry));
			return;
		}
		if (entry.device == "vkey") {
			logger::info("vkey fire '{}' code {} verb {}", entry.name, entry.code,
				entry.action.empty() ? "tap" : entry.action);
			HotkeyHistory::Record(HotkeyHistory::Source::kEntry, entry.name,
				entry.label.empty() ? ("VK" + std::to_string(entry.code)) : entry.label, entry.category);
			FireVKeyAndClose(std::move(entry));
			return;
		}
		logger::info("fire '{}' ({} code {}, {} mods)", entry.name, entry.device, entry.code, entry.mods.size());
		HotkeyHistory::Record(HotkeyHistory::Source::kEntry, entry.name,
			ChordLabel(entry.mods, entry.label), entry.category);
		FireAndClose(std::move(entry));
	}

	// Fire an entry by id, from anywhere. Shared by the view's click (hdFire) and
	// by a global trigger key, so both routes behave identically -- same history
	// record, same action/keystroke split. Main thread.
	void FireEntryById(const std::string& id, const char* via)
	{
		HotkeyEntry entry;
		bool        found = false;
		{
			std::lock_guard l(g_configMutex);
			for (const auto& e : g_config.entries)
				if (e.id == id) { entry = e; found = true; break; }
		}
		if (!found)
			return;
		if (entry.device == "action") {
			// A trigger fires with the palette CLOSED, so the palette-open target
			// snapshot is stale (whoever was in the crosshair the LAST time the
			// deck opened). Re-aim NPC actions at the live crosshair now.
			if (NpcActions::IsAction(entry.action) || AnimActions::IsAction(entry.action) ||
				FixActions::IsAction(entry.action) ||
				entry.action == "no-auto-gear")
				NpcActions::SnapshotTarget();
			logger::info("trigger {} -> action '{}' ({}), live-target snapshot", via, entry.name, entry.action);
			HotkeyHistory::Record(HotkeyHistory::Source::kAction, entry.name,
				entry.label.empty() ? entry.action : entry.label, entry.category);
			FireAction(std::move(entry));
			return;
		}
		if (entry.device == "vkey") {
			logger::info("trigger {} -> vkey '{}' code {}", via, entry.name, entry.code);
			HotkeyHistory::Record(HotkeyHistory::Source::kEntry, entry.name,
				entry.label.empty() ? ("VK" + std::to_string(entry.code)) : entry.label, entry.category);
			VKey::Fire(static_cast<std::int32_t>(entry.code), entry.action.empty() ? "tap" : entry.action);
			return;
		}
		logger::info("trigger {} -> '{}'", via, entry.name);
		HotkeyHistory::Record(HotkeyHistory::Source::kEntry, entry.name,
			ChordLabel(entry.mods, entry.label), entry.category);
		// Deliberately NOT FireAndClose: the palette is closed already, so there is
		// nothing to close and nothing to reopen afterwards.
		FireChord(entry.device, entry.code, entry.mods);
	}

	// Does this key press match an entry's global trigger? Palette-closed only --
	// with the deck open the view owns the keyboard and its own rows handle firing.
	// Returns the entry id, or "" for no match.
	std::string TriggerMatch(bool isKb, bool isMs, std::uint32_t idc)
	{
		std::lock_guard l(g_configMutex);
		for (const auto& e : g_config.entries) {
			if (e.trigDevice.empty() || e.trigCode != idc)
				continue;
			if (!((isKb && e.trigDevice == "keyboard") || (isMs && e.trigDevice == "mouse")))
				continue;
			// Only the three real modifiers are honoured, checked the same way the
			// quick-fire slots already do it. A trigger is meant to be one key you
			// can hit blind; arbitrary DIK chords would need a DIK->VK table that
			// does not exist here, and would be worse to remember anyway.
			bool modsHeld = true;
			for (const auto m : e.trigMods) {
				int vk = 0;
				if (m == 0x2A || m == 0x36) vk = VK_SHIFT;        // L/R shift
				else if (m == 0x1D || m == 0x9D) vk = VK_CONTROL; // L/R ctrl
				else if (m == 0x38 || m == 0xB8) vk = VK_MENU;    // L/R alt
				else continue;                                    // unknown -> not required
				if (!(GetAsyncKeyState(vk) & 0x8000)) { modsHeld = false; break; }
			}
			if (modsHeld)
				return e.id;
		}
		return {};
	}

	// Raw chord from the numpad tab: {"device":"keyboard","code":181,"mods":[42],"label":"Num /"}
	void OnJsFireKey(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("hdFireKey: bad payload");
			return;
		}
		HotkeyEntry e;
		e.id = "raw";
		e.name = j.value("label", std::string("raw key"));
		e.device = j.value("device", std::string("keyboard"));
		e.code = j.value("code", 0u);
		if (j.contains("mods") && j["mods"].is_array())
			for (const auto& m : j["mods"])
				if (m.is_number_unsigned())
					e.mods.push_back(m.get<std::uint32_t>());
		if (!ValidDevice(e.device) || e.code == 0)
			return;
		logger::info("fire raw '{}' ({} code {}, {} mods) — palette stays open", e.name, e.device, e.code, e.mods.size());
		HotkeyHistory::Record(HotkeyHistory::Source::kNumpad, e.name,
			ChordLabel(e.mods, e.name), "Numpad");
		// Numpad tab is an on-screen keyboard: fire WITHOUT closing. The numpad tab
		// runs unpaused (see OnJsTab), so the target system reacts immediately.
		std::thread([e = std::move(e)]() {
			std::this_thread::sleep_for(std::chrono::milliseconds(30));
			FireChord(e.device, e.code, e.mods);
		}).detach();
	}

	// Capture modal opened/closed in the view ("1"/"0").
	void OnJsCapture(const char* data)
	{
		const bool on = data && data[0] == '1';
		g_capturing = on;
		// Stamp the start so the watchdog can tell a live capture from a dead
		// one; clear it on close so a later stale timestamp can't fire.
		g_captureStartMs = on ? NowMs() : 0;
		g_lastEscMs      = 0;
	}

	// Force the capture flag down and shut whichever palette is open. Safe to
	// call from the input sink: both closers are self-guarded and hop to the
	// main thread themselves.
	void ForceCloseWedgedCapture(const char* why)
	{
		logger::warn("capture escape hatch fired ({}) -- forcing the palette shut", why);
		g_capturing      = false;
		g_captureStartMs = 0;
		g_lastEscMs      = 0;
		SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); CloseMagicPalette(); });
	}

	// Tab switched in the view: "deck" pauses (if configured), "numpad" runs live.
	void OnJsTab(const char* data)
	{
		const std::string tab = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([tab]() {
			if (!g_open.load())
				return;
			bool pauseSetting;
			{
				std::lock_guard l(g_configMutex);
				pauseSetting = g_config.settings.pauseOnOpen;
			}
			if (!pauseSetting)
				return;  // pause disabled entirely — nothing to toggle
			ApplyFocusPause(tab == "deck");
		});
	}

	void OnJsSave(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		Config     c;
		bool       ok = !j.is_discarded() && ConfigFromJson(j, c);
		size_t     count = 0;
		if (ok) {
			{
				std::lock_guard l(g_configMutex);
				g_config = c;
				count = g_config.entries.size();
			}
			ok = PersistAll();  // emits both slices (deck just-updated + magic unchanged)
			if (ok)
				logger::info("config saved ({} entries)", count);
			else
				logger::error("hdSave: config accepted but failed to write to disk");
		} else {
			logger::error("hdSave: rejected invalid config payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "hdSaved(true)" : "hdSaved(false)");
		});
	}

	void OnJsClose(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); });
	}

	void OnJsLog(const char* data)
	{
		if (data)
			logger::info("[view] {}", data);
	}

	// ------------------------------------------------------------ quests tab

	// Every quest query touches live game data, so it runs on the main thread via
	// AddTask (which still ticks while the palette holds the pause), and the reply
	// is pushed back into the view from that same task.
	// ⚠ PAYLOAD MUST BE A STRING — CALL .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) ON ANY json YOU PASS HERE.
	// nlohmann::json has an implicit conversion operator to std::string, so
	// `PushToView("x", json{...})` COMPILES and then throws type_error.302
	// ("type must be string, but is object") at runtime. Inside a PrismaUI
	// callback nothing catches that, so it is a hard CTD — shipped exactly that
	// on 2026-08-02 with the Adjust panel.
	//
	// A `= delete`d json overload would turn this into a compile error, and was
	// tried: it makes every string-LITERAL caller ambiguous (PushToView("x",
	// "null") converts equally well to both), so it is not usable here without
	// touching a dozen unrelated call sites. Hence this comment instead.
	void PushToView(std::string fn, std::string payload)
	{
		std::string js = std::move(fn) + "(" + std::move(payload) + ")";
		if (g_prisma && g_viewReady.load() && g_open.load())
			g_prisma->Invoke(g_view, js.c_str());
	}

	std::uint32_t ParseFormId(const std::string& s)
	{
		try {
			return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
		} catch (const std::exception&) {
			return 0;
		}
	}

	// Payload is OPTIONAL and three shapes are accepted, because two callers ask:
	//   ""  / null        the Quests tab — whoever the crosshair snapshot named.
	//   {"formId":"HEX"}  the F7 card's quest modal (hd-quests.js) — an EXPLICIT
	//                     actor, because that card's subject is a picked party
	//                     member whenever you clicked a face on the party strip.
	//   "HEX"             the same thing, bare, so a hand-typed call still works.
	void OnJsQuestList(const char* data)
	{
		std::string raw = data ? data : "";
		std::uint32_t id = 0;
		if (!raw.empty()) {
			if (raw.front() == '{') {
				const auto j = json::parse(raw, nullptr, false);
				if (!j.is_discarded() && j.is_object())
					id = ParseFormId(j.value("formId", std::string("")));
			} else {
				id = ParseFormId(raw);
			}
		}
		SKSE::GetTaskInterface()->AddTask([id]() {
			// npc-quest-modal: the marker that proves THIS build carries the
			// explicit-actor path (hd-markers.json). Reached on every ask.
			logger::info("hdQuestList: npc-quest-modal actor {:08X}", id);
			PushToView("hdQuests", id ? QuestTools::QuestsForActor(id)
			                          : QuestTools::QuestsForTarget());
		});
	}

	// VirtualKey picker: hand the view VirtualKey's discovered-binding catalog.
	void OnJsVkCatalog(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("vkCatalogData", VKey::CatalogJson());
		});
	}

	// VirtualKey picker "Test" button: fire a raw virtual key without an entry.
	// Payload: {"code":100003,"verb":"tap"}.
	void OnJsVkTest(const char* data)
	{
		if (!data)
			return;
		try {
			const auto        j = json::parse(data);
			const std::int32_t code = j.value("code", 0);
			const std::string  verb = j.value("verb", std::string("tap"));
			VKey::Fire(code, verb);
		} catch (const std::exception& e) {
			logger::warn("vkTest: bad payload ({})", e.what());
		}
	}

	void OnJsQuestSearch(const char* data)
	{
		const std::string query = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([query]() {
			PushToView("hdQuests", QuestTools::SearchQuests(query));
		});
	}

	void OnJsQuestDetail(const char* data)
	{
		const std::string id = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([id]() {
			PushToView("hdQuestInfo", QuestTools::QuestDetail(ParseFormId(id)));
		});
	}

	// {"formId":"000A2C9E","stage":200}
	void OnJsQuestSetStage(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("hdQuestSetStage: bad payload");
			return;
		}
		const auto id = ParseFormId(j.value("formId", std::string("")));
		const auto stage = j.value("stage", 0u);
		SKSE::GetTaskInterface()->AddTask([id, stage]() {
			PushToView("hdQuestResult", QuestTools::SetStage(id, stage));
			PushToView("hdQuestInfo", QuestTools::QuestDetail(id));
		});
	}

	// {"formId":"000A2C9E","verb":"reset"}
	void OnJsQuestAction(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("hdQuestAction: bad payload");
			return;
		}
		const auto id = ParseFormId(j.value("formId", std::string("")));
		const auto verb = j.value("verb", std::string(""));

		// "Go to target" is physical, not administrative: pre-flight first (movetoqt
		// fails silently, so surface WHY in the palette), and only on a live target
		// close the palette — the jump lands in the unpaused world — then fire it.
		if (verb == "movetoqt") {
			SKSE::GetTaskInterface()->AddTask([id]() {
				const auto check = QuestTools::CheckQuestTarget(id);
				const auto jc = json::parse(check, nullptr, false);
				if (jc.is_discarded() || !jc.value("ok", false)) {
					PushToView("hdQuestResult", check);
					return;
				}
				ClosePalette();
				QuestTools::MoveToQuestTarget(id);
			});
			return;
		}

		SKSE::GetTaskInterface()->AddTask([id, verb]() {
			PushToView("hdQuestResult", QuestTools::RunAction(id, verb));
			PushToView("hdQuestInfo", QuestTools::QuestDetail(id));
		});
	}

	// ----------------------------------------------------- Spell Deck (magic view)

	std::atomic<bool> g_iconIndexPushed{ false };  // heavy index goes over once per session

	std::filesystem::path MagicViewDir()
	{
		return std::filesystem::path("Data") / "PrismaUI" / "views" / "MagicDeck";
	}

	// The build-time-extracted Spell Hotbar icon index, validated (parse + re-dump)
	// so a corrupted file can't inject script through the Invoke that carries it.
	// "null" when the library isn't installed — the view falls back to SVG glyphs.
	// BOTH views own a copy of the tree and every path inside the index is
	// view-relative, so the same index is correct in either one — hence the path
	// parameter (`which` only names the view in the log).
	std::string IconIndexJsonAt(const std::filesystem::path& indexFile, const char* which)
	{
		try {
			std::ifstream in(indexFile, std::ios::binary);
			if (!in.is_open()) {
				logger::info("{}: no icon library (icons/sh_index.json missing) — SVG glyphs only", which);
				return "null";
			}
			std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
			const auto  j = json::parse(text, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::error("{}: icons/sh_index.json is invalid JSON — icon library disabled", which);
				return "null";
			}
			logger::info("{}: icon library index loaded ({} KB)", which, text.size() / 1024);
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		} catch (const std::exception& ex) {
			logger::error("{}: icon index read failed: {}", which, ex.what());
			return "null";
		}
	}

	std::string IconIndexJson()  // Spell Deck
	{
		return IconIndexJsonAt(MagicViewDir() / "icons" / "sh_index.json", "spell deck");
	}

	bool IsImageExt(std::filesystem::path p)
	{
		auto ext = p.extension().string();
		std::transform(ext.begin(), ext.end(), ext.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif" || ext == ".svg";
	}

	// Copy every image from `src` into `dst` that is new or whose size changed.
	// Shared by the Desktop drop sweep and the MagicDeck -> HotkeyDeck custom-icon
	// mirror, so ONE place decides what an icon file is and when a copy is owed.
	// portal-*.json sidecars and readme.txt need no special case — IsImageExt()
	// already rejects them. Returns the number of files copied.
	std::size_t CopyNewImages(const std::filesystem::path& src, const std::filesystem::path& dst, const char* what)
	{
		std::error_code ec;
		std::filesystem::create_directories(dst, ec);
		std::size_t copied = 0;
		for (std::filesystem::directory_iterator it(src, ec), end; !ec && it != end; it.increment(ec)) {
			std::error_code fec;
			if (!it->is_regular_file(fec) || !IsImageExt(it->path()))
				continue;
			const auto target = dst / it->path().filename();
			const auto srcSize = std::filesystem::file_size(it->path(), fec);
			if (fec)
				continue;  // vanished between listing and stat
			if (std::filesystem::exists(target, fec) && std::filesystem::file_size(target, fec) == srcSize)
				continue;  // already there, unchanged
			std::filesystem::copy_file(it->path(), target,
				std::filesystem::copy_options::overwrite_existing, fec);
			if (!fec) {
				++copied;
				logger::info("{}: copied '{}'", what, it->path().filename().string());
			} else {
				logger::warn("{}: could not copy '{}': {}", what, it->path().filename().string(), fec.message());
			}
		}
		return copied;
	}

	// The quick-add path: anything dropped into Desktop\Spell Deck Icons gets
	// swept into the view's icons/custom/ on every scan (the webview can only
	// load files inside the view dir). Minimize the game, drop an image on that
	// folder, reopen the deck (or hit the picker's Refresh) — it's usable.
	// Both folders are created on first scan so the drop target is discoverable.
	// The sweep target stays the SPELL DECK's folder (one authoring folder, and
	// renaming it would orphan the drops already sitting on the Desktop); the deck
	// view gets them via MirrorCustomIcons().
	void SweepDesktopIcons(const std::filesystem::path& customDir)
	{
		const char* prof = std::getenv("USERPROFILE");
		if (!prof || !*prof)
			return;
		std::error_code ec;
		const auto drop = std::filesystem::path(prof) / "Desktop" / "Spell Deck Icons";
		std::filesystem::create_directories(drop, ec);
		std::filesystem::create_directories(customDir, ec);
		CopyNewImages(drop, customDir, "desktop icon sweep");
	}

	// Live listing of user-dropped icon files. Re-scanned on EVERY palette open
	// and on the picker's Refresh, so an image dropped into icons/custom/ — or
	// onto Desktop\Spell Deck Icons (swept here) — shows up without a restart
	// (MO2's VFS passes new files through).
	std::string CustomIconsJsonIn(const std::filesystem::path& dir)
	{
		json            arr = json::array();
		std::error_code ec;
		std::filesystem::create_directories(dir, ec);  // fresh install / robocopy skipped
		std::vector<std::pair<std::string, std::string>> rows;  // label, view-relative path
		for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
			std::error_code fec;
			if (!it->is_regular_file(fec))
				continue;
			if (!IsImageExt(it->path()))
				continue;
			rows.emplace_back(it->path().stem().string(), "icons/custom/" + it->path().filename().string());
		}
		std::sort(rows.begin(), rows.end());
		for (auto& [label, file] : rows)
			arr.push_back(json{ { "file", file }, { "label", label } });
		return json{ { "custom", arr } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// The Spell Deck's own custom folder — the upload / drop target, so the desktop
	// sweep happens here and nowhere else.
	std::string CustomIconsJson()
	{
		const auto dir = MagicViewDir() / "icons" / "custom";
		SweepDesktopIcons(dir);
		return CustomIconsJsonIn(dir);
	}

	// ------------------------------------------------ Deck Portal icon handoff
	// The Deck Portal (portal/server.js) lets a phone assign a spell icon while
	// the game is running. It deliberately NEVER writes hotkeys.json: we hold the
	// whole config in memory and rewrite that file wholesale on every
	// PersistAll(), so a portal write would be silently clobbered by the next
	// in-game edit. Instead the portal drops a sidecar next to the custom icons
	// and we consume it here, on the palette-open path that already re-scans that
	// folder.
	//
	//   { "version": 1,
	//     "assign": [ { "spellId": "<magic.spells[].id>",
	//                   "icon": "icons/custom/foo.png" } ] }
	//
	// `icon` is a view-relative override path exactly as the picker stores it
	// (CustomIconsJson() emits the same "icons/custom/<file>" strings); "" means
	// back to the automatic icon. Unknown spellIds are skipped — the player
	// deleted the spell — and a malformed file is logged and discarded rather
	// than retried on every open.
	//
	// v0.11.0: also called every second by PortalPollLoop(), so a phone edit no
	// longer waits for the next palette open. Returns true only when an icon
	// actually changed — that is the poller's "worth re-pushing the view" signal.
	bool ApplyPortalAssignments(const std::filesystem::path& customDir)
	{
		const auto      file = customDir / "portal-assignments.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next open gets it.
				logger::warn("portal assignments present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto j = json::parse(text, nullptr, false);
		bool       changed = false;
		if (j.is_discarded() || !j.is_object() || !j.contains("assign") || !j["assign"].is_array()) {
			logger::error("portal assignments file is malformed — discarding it");
		} else {
			// Scope the lock TIGHTLY: PersistAll() takes g_configMutex itself and
			// std::mutex is not recursive, so it must be called unlocked.
			std::lock_guard l(g_configMutex);
			for (const auto& e : j["assign"]) {
				if (!e.is_object())
					continue;
				const auto  id = e.value("spellId", std::string(""));
				std::string icon = e.value("icon", std::string(""));
				if (id.empty())
					continue;
				if (!ValidViewIconPath(icon)) {
					logger::warn("portal assignment icon '{}' is not a view-relative icons/ path — skipped", icon);
					continue;
				}
				auto it = std::find_if(g_magicConfig.spells.begin(), g_magicConfig.spells.end(),
					[&id](const SpellEntry& s) { return s.id == id; });
				if (it == g_magicConfig.spells.end()) {
					logger::info("portal assignment for unknown spell id '{}' — skipped", id);
					continue;
				}
				if (it->icon == icon)
					continue;  // already there; don't churn the config file
				logger::info("portal assignment: '{}' icon -> '{}'", it->name,
					icon.empty() ? std::string("(auto)") : icon);
				it->icon = icon;
				changed = true;
			}
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. If the delete is refused, blank it so the portal stops showing
		// the change as still pending.
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal assignments ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"assign":[]})";
		}
		if (changed && !PersistAll())
			logger::error("portal assignments applied in memory but the config write failed");
		return changed;
	}

	// Lazily create the magic view on first open — same deferral as the deck view.
	// Main thread only.
	void EnsureMagicViewAndOpen()
	{
		if (!g_prisma)
			return;
		if (g_magicViewReady.load()) {
			OpenMagicPalette();
			return;
		}
		if (g_magicViewRequested.exchange(true))
			return;  // creation already in flight; DOM-ready will open
		logger::info("creating magic view (first open)");
		g_magicView = g_prisma->CreateView("MagicDeck/index.html", [](PrismaView v) {
			g_magicViewReady = true;
			logger::info("magic view DOM ready (handle {})", v);
			SKSE::GetTaskInterface()->AddTask([]() {
				if (CanOpenNow())
					OpenMagicPalette();
			});
		});
		g_prisma->RegisterJSListener(g_magicView, "mdFire", OnJsMagicFire);
		g_prisma->RegisterJSListener(g_magicView, "mdCastCombo", OnJsMagicCastCombo);
		g_prisma->RegisterJSListener(g_magicView, "mdKnown", OnJsMagicKnown);
		g_prisma->RegisterJSListener(g_magicView, "mdSave", OnJsMagicSave);
		g_prisma->RegisterJSListener(g_magicView, "mdClose", OnJsMagicClose);
		g_prisma->RegisterJSListener(g_magicView, "mdLog", OnJsMagicLog);
		g_prisma->RegisterJSListener(g_magicView, "mdCapture", OnJsMagicCapture);
		g_prisma->RegisterJSListener(g_magicView, "mdRemoveSpell", OnJsMagicRemoveSpell);
		g_prisma->RegisterJSListener(g_magicView, "mdRestoreSpell", OnJsMagicRestoreSpell);
		g_prisma->RegisterJSListener(g_magicView, "mdGetDesc", OnJsMagicGetDesc);
		g_prisma->RegisterJSListener(g_magicView, "mdIconList", OnJsMagicIconList);
	}

	// Main thread only.
	void OpenMagicPalette()
	{
		if (!g_prisma || !g_magicViewReady.load() || g_magicOpen.load())
			return;
		// Apply anything the Deck Portal queued from the phone BEFORE the payload
		// is snapshotted — mdOpen() below carries the icons the view will draw, so
		// consuming the sidecar any later would cost an extra open to show up.
		ApplyPortalAssignments(MagicViewDir() / "icons" / "custom");
		if (SpellCatIconQueuePending())
			ApplyPortalSpellCatIcons();  // rail glyphs ride the same open, same reason
		std::string payload;
		bool        pause;
		{
			std::lock_guard l(g_configMutex);
			payload = MagicConfigToJson(g_magicConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			pause = g_config.settings.pauseOnOpen;  // reuse the deck's pause preference
		}
		// Snapshot the crosshair NPC before the cursor/pause takes over, so a
		// non-self spell cast from the menu targets who the player was looking at.
		NpcActions::SnapshotTarget();
		g_magicOpen = true;
		g_prisma->Show(g_magicView);
		if (!g_prisma->Focus(g_magicView, pause))
			logger::warn("magic Focus() returned false");
		g_magicFocusPaused = pause;
		g_prisma->Invoke(g_magicView, ("mdOpen(" + payload + ")").c_str());
		// Reconcile the equip badges against true engine state right away.
		g_prisma->Invoke(g_magicView, ("mdEquipState(" + SpellActions::EquipStateJson() + ")").c_str());
		// Icon library: the heavy index once per session (the view re-renders when
		// it lands), the live custom-folder listing on every open.
		if (!g_iconIndexPushed.exchange(true))
			g_prisma->Invoke(g_magicView, ("mdIconIndex(" + IconIndexJson() + ")").c_str());
		g_prisma->Invoke(g_magicView, ("mdIcons(" + CustomIconsJson() + ")").c_str());
	}

	// Main thread only.
	void CloseMagicPalette()
	{
		if (!g_prisma || !g_magicOpen.exchange(false))
			return;
		g_capturing = false;  // mdClosed() clears the JS capture without notifying us
		g_prisma->Invoke(g_magicView, "mdClosed()");
		g_prisma->Unfocus(g_magicView);
		g_prisma->Hide(g_magicView);
		g_magicFocusPaused = false;
	}

	// Push a C++ -> JS call into the magic view (main thread only).
	void PushToMagicView(std::string fn, std::string payload)
	{
		std::string js = std::move(fn) + "(" + std::move(payload) + ")";
		if (g_prisma && g_magicViewReady.load() && g_magicOpen.load())
			g_prisma->Invoke(g_magicView, js.c_str());
	}

	// mdFire: a spell entry was clicked. Cast entries fire-and-close (respecting
	// closeAfterFire); equip entries toggle and leave the palette open, updating
	// the badge from the NEW intended state EquipToggle returns.
	void OnJsMagicFire(const char* data)
	{
		if (!data)
			return;
		const std::string id = data;
		SpellEntry        entry;
		bool              found = false;
		{
			std::lock_guard l(g_configMutex);
			for (const auto& s : g_magicConfig.spells)
				if (s.id == id) {
					entry = s;
					found = true;
					break;
				}
		}
		if (!found) {
			logger::warn("mdFire: unknown spell id '{}'", id);
			return;
		}

		if (entry.mode == "equip") {
			logger::info("equip-toggle '{}' ({} hand)", entry.name, entry.hand);
			SKSE::GetTaskInterface()->AddTask([entry]() {
				PushToMagicView("mdToggled",
					SpellActions::EquipToggle(entry.plugin, entry.localId, entry.formId, entry.hand));
			});
			return;
		}

		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		logger::info("cast '{}'", entry.name);
		SKSE::GetTaskInterface()->AddTask([entry, reopen]() {
			CloseMagicPalette();  // unpause first, so the spell fires into the live world
			// reopen rides Cast's onDone: immediate for hand spells, but a
			// voice-slot item (power/shout) fires via a DELAYED shout-key press
			// — reopening before it lands would pause the world under the key.
			std::function<void()> onDone;
			if (reopen)
				onDone = []() {
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenMagicPalette();
					});
				};
			SpellActions::Cast(entry.plugin, entry.localId, entry.formId, std::move(onDone));
		});
	}

	// mdCastCombo: a combo card was clicked — cast every member, in order, as
	// one staggered barrage. The view sends the FULL member list (not just the
	// combo id) so a just-created combo fires correctly even while its save is
	// still sitting in the view's 350 ms debounce. Combo casts always close the
	// palette first (the barrage needs the live world); closeAfterFire=false
	// reopens it only after the LAST cast so pause-on-open can't freeze the tail.
	constexpr std::uint32_t kComboStaggerMs = 150;  // barrage cadence
	constexpr std::size_t   kComboMaxSpells = 12;   // sanity cap, mirrored in the view

	void OnJsMagicCastCombo(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("mdCastCombo: bad payload");
			return;
		}
		const auto name = j.value("name", std::string(""));

		std::vector<SpellActions::SpellRef> refs;
		if (j.contains("spells") && j["spells"].is_array()) {
			for (const auto& js : j["spells"]) {
				if (!js.is_object())
					continue;
				SpellActions::SpellRef r;
				r.plugin = js.value("plugin", std::string(""));
				r.localId = js.value("localId", 0u);
				r.formId = js.value("formId", 0u);
				if (r.plugin.empty() && r.formId == 0)
					continue;  // unresolvable — skip
				refs.push_back(std::move(r));
				if (refs.size() >= kComboMaxSpells)
					break;
			}
		}
		if (refs.empty()) {
			logger::warn("mdCastCombo: combo '{}' has no castable members", name);
			return;
		}

		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		logger::info("combo-cast '{}' ({} spells)", name, refs.size());
		SKSE::GetTaskInterface()->AddTask([name, refs = std::move(refs), reopen]() {
			CloseMagicPalette();  // unpause first, so the barrage fires into the live world
			SpellActions::CastSequence(name, refs, kComboStaggerMs,
				reopen ? std::function<void()>([]() {
					if (CanOpenNow())
						OpenMagicPalette();
				}) :
						 std::function<void()>{});
		});
	}

	// mdKnown: the "add spell" picker asked for the player's known spells.
	void OnJsMagicKnown(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToMagicView("mdSpells", SpellActions::KnownSpellsJson());
		});
	}

	// mdSave: the view edited categories / spells / open-key — persist the magic slice.
	void OnJsMagicSave(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		bool       ok = false;
		if (!j.is_discarded()) {
			MagicConfig m;
			MagicConfigFromJson(j, m);
			{
				std::lock_guard l(g_configMutex);
				g_magicConfig = std::move(m);
			}
			ok = PersistAll();  // emits both slices (magic just-updated + deck unchanged)
			if (ok)
				logger::info("magic config saved");
			else
				logger::error("mdSave: accepted but failed to write to disk");
		} else {
			logger::error("mdSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_magicViewReady.load())
				g_prisma->Invoke(g_magicView, ok ? "mdSaved(true)" : "mdSaved(false)");
		});
	}

	void OnJsMagicClose(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { CloseMagicPalette(); });
	}

	void OnJsMagicLog(const char* data)
	{
		if (data)
			logger::info("[magic view] {}", data);
	}

	void OnJsMagicCapture(const char* data)
	{
		g_capturing = data && data[0] == '1';
	}

	// mdRemoveSpell: clear a spell from the player's spellbook (engine RemoveSpell).
	// We only mutate game state here and report the result; the view owns the
	// persistent Removed list — it folds the returned metadata into g_magicConfig
	// via the normal mdSave round-trip, so C++ never double-manages it.
	void OnJsMagicRemoveSpell(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded())
			return;
		const auto plugin = j.value("plugin", std::string(""));
		const auto localId = j.value("localId", 0u);
		const auto formId = j.value("formId", 0u);
		SKSE::GetTaskInterface()->AddTask([plugin, localId, formId]() {
			PushToMagicView("mdRemoved", SpellActions::RemoveFromSpellbook(plugin, localId, formId));
		});
	}

	// mdRestoreSpell: re-learn a previously removed spell (engine AddSpell).
	void OnJsMagicRestoreSpell(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded())
			return;
		const auto plugin = j.value("plugin", std::string(""));
		const auto localId = j.value("localId", 0u);
		const auto formId = j.value("formId", 0u);
		SKSE::GetTaskInterface()->AddTask([plugin, localId, formId]() {
			PushToMagicView("mdRestored", SpellActions::RestoreToSpellbook(plugin, localId, formId));
		});
	}

	// mdGetDesc: hover tooltip asked for a spell's auto-generated description.
	void OnJsMagicGetDesc(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const auto plugin = j.value("plugin", std::string(""));
		const auto localId = j.value("localId", 0u);
		const auto formId = j.value("formId", 0u);
		SKSE::GetTaskInterface()->AddTask([plugin, localId, formId]() {
			PushToMagicView("mdDesc", SpellActions::DescriptionJson(plugin, localId, formId));
		});
	}

	// mdIconList: the icon picker's Refresh — re-scan icons/custom/ right now.
	void OnJsMagicIconList(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToMagicView("mdIcons", CustomIconsJson());
		});
	}

	// The Magic Menu capture key: snapshot the highlighted spell, file it into
	// the deck (under the category named like its school when one exists),
	// optionally clear it from the vanilla spellbook (magic.removeOnAdd),
	// persist, notify. The deck entry survives a spellbook removal and stays
	// castable — CastSpellImmediate doesn't require the spell to be known — and
	// the removal lands in the restorable Removed list like any other.
	// Main thread only (reads menu scaleform + mutates the player).
	void DoAddHighlighted()
	{
		const auto snap = json::parse(SpellActions::HighlightedSpellJson(), nullptr, false);
		if (snap.is_discarded() || !snap.value("ok", false)) {
			RE::DebugNotification("Spell Deck: no spell highlighted");
			return;
		}
		const auto plugin = snap.value("plugin", std::string(""));
		const auto localId = snap.value("localId", 0u);
		const auto formId = snap.value("formId", 0u);
		const auto name = snap.value("name", std::string("spell"));
		const auto type = snap.value("type", std::string(""));

		char hex[11];
		std::snprintf(hex, sizeof(hex), "0x%08X", formId);

		bool        removeOnAdd, wasDup = false;
		std::string category;
		{
			std::lock_guard l(g_configMutex);
			removeOnAdd = g_magicConfig.removeOnAdd;
			if (g_magicConfig.categories.empty())
				g_magicConfig.categories = DefaultMagicConfig().categories;
			// File under the category named like the school (case-insensitive) when
			// there is one — "Destruction" catches destruction — else the first.
			category = g_magicConfig.categories.front();
			if (const auto school = snap.value("school", std::string("")); !school.empty()) {
				for (const auto& c : g_magicConfig.categories) {
					std::string lc = c;
					std::transform(lc.begin(), lc.end(), lc.begin(),
						[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
					if (lc == school) {
						category = c;
						break;
					}
				}
			}
			for (const auto& s : g_magicConfig.spells) {
				if (s.formId == formId) {
					wasDup = true;
					category = s.category;  // report where it already lives
					break;
				}
			}
			if (!wasDup) {
				SpellEntry e;
				e.id = hex;
				while (std::any_of(g_magicConfig.spells.begin(), g_magicConfig.spells.end(),
					[&](const SpellEntry& s) { return s.id == e.id; }))
					e.id += "+";
				e.plugin = plugin;
				e.localId = localId;
				e.formId = formId;
				e.name = name;
				e.mode = "cast";
				e.hand = "right";
				e.category = category;
				e.slot = snap.value("slot", std::string(""));
				e.school = snap.value("school", std::string(""));
				e.element = snap.value("element", std::string(""));
				e.archetype = snap.value("archetype", std::string(""));
				e.tier = snap.value("tier", std::string(""));
				g_magicConfig.spells.push_back(std::move(e));
			}
		}

		// Optional spellbook removal (only real hand spells; RemoveFromSpellbook
		// re-checks). notify=false — the combined notification below covers it.
		bool removed = false;
		if (removeOnAdd && type == "spell") {
			const auto rr = json::parse(
				SpellActions::RemoveFromSpellbook(plugin, localId, formId, false), nullptr, false);
			if (!rr.is_discarded() && rr.value("ok", false)) {
				removed = true;
				SpellMeta m;
				m.plugin = rr.value("plugin", plugin);
				m.localId = rr.value("localId", localId);
				m.formId = rr.value("formId", formId);
				m.name = rr.value("name", name);
				m.type = rr.value("type", type);
				m.school = rr.value("school", std::string(""));
				m.element = rr.value("element", std::string(""));
				m.archetype = rr.value("archetype", std::string(""));
				m.tier = rr.value("tier", std::string(""));
				std::lock_guard l(g_configMutex);
				std::erase_if(g_magicConfig.removed,
					[&](const SpellMeta& x) { return x.formId == m.formId; });
				g_magicConfig.removed.insert(g_magicConfig.removed.begin(), std::move(m));
			}
		}

		PersistAll();
		std::string note = wasDup ? ("Spell Deck: " + name + " is already in " + category) :
									("Spell Deck: added " + name + " to " + category);
		if (removed)
			note += " (removed from spellbook)";
		RE::DebugNotification(note.c_str());
		logger::info("capture-key: {} ({}) -> '{}'{}{}", name, hex, category,
			wasDup ? " [dup]" : "", removed ? " [removed from spellbook]" : "");
	}

	// ------------------------------------------- Followers tab (deck view)
	// The roster is Follower Organizer's data, reached through its in-process
	// Deck API (follower_deck.h). The pane (followers-pane.js) is thin: it
	// renders whatever state envelope C++ pushes and sends one mutation op at
	// a time; every reply carries fresh state, so the view never owns roster
	// truth. All fd* traffic rides the DECK view (registered in
	// EnsureViewAndOpen); F14 deep-opens the palette onto the tab.

	// The add-follower target: whoever the crosshair snapshot caught at open.
	std::string FolTargetJson()
	{
		const auto id = NpcActions::TargetFormID();
		auto*      actor = id ? RE::TESForm::LookupByID<RE::Actor>(id) : nullptr;
		if (!actor)
			return "null";
		// `following` / `dead` ride along so the quick strip can say the one
		// thing that is actually available (Recruit vs Dismiss) instead of
		// offering both and letting NFF refuse one of them.
		//
		// `wedged` is the third state neither of those covers: the factions say
		// current follower, the engine says not a teammate, and BOTH halves of
		// her follower dialogue are conditioned away (nff_control.h). Without
		// it the card offers Recruit — which is exactly the call that put her
		// there — and the one control that repairs it is unreachable.
		// `imported` is a FOURTH, independent state: NFF's "Add to Framework"
		// is not recruitment, so it is orthogonal to `following` — she can be
		// imported without being a teammate (the normal case: her own follower
		// mod moves her). The card needs it to label one button truthfully as
		// Add or Remove instead of offering both.
		return json{ { "formId", id },
			{ "name", actor->GetDisplayFullName() },
			{ "following", actor->IsPlayerTeammate() },
			{ "wedged", NffControl::IsWedgedFollower(actor) },
			{ "imported", NffControl::IsImported(actor) },
			// Whether the game will let you ask her to follow AT ALL
			// (PotentialFollowerFaction). Most NPCs are not in it — that is
			// what NFF's "Force Follower" grants, so the card only offers it
			// to someone who actually lacks it.
			{ "canFollow", NffControl::CanBeFollower(actor) },
			// …and whether that eligibility is one WE granted, which is the
			// only case where offering to take it away is safe.
			{ "forcedFollow", NffControl::WasForcedFollower(actor) },
			{ "dead", actor->IsDead() } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// The ground item under the crosshair at open, resolved to the mod that
	// owns it (the item-source banner's payload). Two plugins matter and they
	// are different questions: the BASE object's defining file answers "what
	// mod adds this item"; the last file in the base's source list is the
	// winning override ("who last edited the record"); and the REFERENCE's
	// defining file is who placed this particular instance in the world — a
	// dropped or spawned item is a runtime 0xFF ref with no file at all, which
	// is reported honestly as empty rather than guessed at.
	std::string ItemSourceJson()
	{
		const auto id = NpcActions::ItemRefFormID();
		auto*      ref = id ? RE::TESForm::LookupByID<RE::TESObjectREFR>(id) : nullptr;
		auto*      base = ref ? ref->GetBaseObject() : nullptr;
		if (!base)
			return "null";

		const auto fileName = [](const RE::TESFile* f) {
			return f ? std::string(f->GetFilename()) : std::string();
		};

		const std::string basePlugin = fileName(base->GetFile(0));
		// Winning override: the LAST file carrying the record. GetFile(-1) is
		// the canonical "last source" accessor — the rig's pinned CommonLib
		// snapshot predates public sourceFiles access, which broke the build
		// here on 2026-08-03.
		std::string winner = fileName(base->GetFile(-1));
		if (winner == basePlugin)
			winner.clear();
		const std::string refPlugin = fileName(ref->GetFile(0));

		const char* disp = ref->GetDisplayFullName();
		std::string name = (disp && disp[0]) ? disp : "";
		if (name.empty()) {
			const char* bn = base->GetName();
			name = (bn && bn[0]) ? bn : "(unnamed object)";
		}

		char baseHex[16];
		std::snprintf(baseHex, sizeof(baseHex), "%08X", base->GetFormID());

		logger::info("open: item-source banner -> \"{}\" [{}] from {}", name,
			baseHex, basePlugin.empty() ? "(dynamic form)" : basePlugin);

		return json{
			{ "name", name },
			{ "baseId", baseHex },
			{ "basePlugin", basePlugin },  // "" = runtime/dynamic form
			{ "override", winner },        // "" = no later override
			{ "refPlugin", refPlugin }     // "" = dropped/spawned in this save
		}
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::filesystem::path DeckViewDir()
	{
		return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck";
	}

	// Live listing of follower portrait files — the same trick as
	// CustomIconsJson() for the Spell Deck. Re-scanned on EVERY palette open and
	// every fdRefresh, so a file dropped into portraits\ (by hand or by the Deck
	// Portal web app) shows up without a restart: MO2's VFS passes new files in a
	// mounted mod dir straight through.
	//
	// The slug comes from the file stem via PortraitCapture::SlugFromFileStem —
	// `<slug>.png` and `<slug>~<version>.png` both resolve to `<slug>`, and the
	// pane matches that against slugOf(member.original). mtime rides along as a
	// cache-bust token — Ultralight caches view-relative images by URL, so
	// REPLACING a portrait under the same name would otherwise keep painting the
	// old bytes.
	//
	// WHY VERSIONS EXIST AT ALL: Ultralight memory-maps every image it draws and
	// holds it for the session, so a portrait the deck has already SHOWN cannot
	// be overwritten in place — the capture lands beside it as `<slug>~<n>.png`
	// instead. Hence the two rules here: many files may share a slug, and the
	// NEWEST of them is the portrait. The winner's real FILENAME is what goes to
	// the view; it can no longer be rebuilt from slug + ext.
	std::string FolPortraitsJson()
	{
		std::error_code ec;
		const auto      dir = DeckViewDir() / "portraits";
		// Create it so the drop target exists even on a fresh install.
		std::filesystem::create_directories(dir, ec);

		// MSVC's file_time_type ticks are 100 ns since 1601-01-01. Shift to the
		// Unix epoch so the value is a readable timestamp in the log and stays
		// well inside the range JS handles exactly.
		constexpr std::uint64_t kTicksPerSec = 10000000ULL;
		constexpr std::uint64_t kWinToUnix   = 11644473600ULL;

		// slug -> the best file seen so far. A map rather than straight-to-array
		// because the winner is only known once the whole folder has been read.
		struct Shot
		{
			std::string   file;    // verbatim, as the view must load it
			std::string   fold;    // lowercased, for the tie-break only
			std::string   ext;
			std::uint64_t mtime = 0;
		};
		std::map<std::string, Shot> best;

		const auto LowerCopy = [](std::string s) {
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		};

		std::size_t skipped = 0;
		std::size_t superseded = 0;
		for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
			std::error_code fec;
			if (!it->is_regular_file(fec))
				continue;

			auto ext = it->path().extension().string();
			std::transform(ext.begin(), ext.end(), ext.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			// Deliberately narrow: no gif/svg. A portrait is a still photo in a
			// 40 px circle; the Deck Portal refuses anything else too.
			if (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".webp") {
				++skipped;
				continue;
			}

			const auto slug = PortraitCapture::SlugFromFileStem(it->path().stem().string());
			if (slug.empty())
				continue;

			std::uint64_t stamp = 0;
			const auto    ft = std::filesystem::last_write_time(it->path(), fec);
			if (!fec) {
				const auto secs = static_cast<std::uint64_t>(ft.time_since_epoch().count()) / kTicksPerSec;
				stamp = secs > kWinToUnix ? secs - kWinToUnix : secs;
			}

			// The name is kept VERBATIM for the view to load — only the comparison
			// key is folded. Windows is case-insensitive so `Elana-Darkfire.JPG`
			// would probably load either way, but handing the loader a name that
			// is not the one on disk is a gamble with nothing to win.
			auto       file = it->path().filename().string();
			const auto fold = LowerCopy(file);

			// THE WINNER RULE, and portal/server.js betterPortrait() must match it
			// exactly or the phone shows one face and the deck draws another:
			// newest mtime wins; on a tie the greater FILENAME wins. The tie-break
			// earns its keep — these stamps are whole seconds, so a re-capture
			// landing in the same second as the file it supersedes is entirely
			// possible. '~' (0x7E) sorts above '.' (0x2E), so `x~1753900000.png`
			// beats `x.png`, and between two versions the later stamp beats the
			// earlier.
			auto&      cur = best[slug];
			const bool wins = cur.file.empty() ||
							  stamp > cur.mtime ||
							  (stamp == cur.mtime && fold > cur.fold);
			if (!cur.file.empty())
				++superseded;
			if (wins) {
				cur.file = std::move(file);
				cur.fold = fold;
				cur.ext = ext.substr(1);   // "png", not ".png"
				cur.mtime = stamp;
			}
		}

		json arr = json::array();
		for (const auto& [slug, shot] : best) {
			arr.push_back(json{
				{ "slug", slug },
				// The real filename, because `<slug>.<ext>` no longer reconstructs
				// it. The view still falls back to that form if `file` is absent,
				// so an older view and a newer DLL do not break each other.
				{ "file", shot.file },
				{ "ext", shot.ext },
				{ "mtime", shot.mtime } });
		}

		if (!arr.empty() || skipped || superseded)
			logger::info("portraits: {} usable, {} superseded (older file for the same follower), {} skipped (unsupported type)",
				arr.size(), superseded, skipped);
		return arr.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// ------------------------------------------------------- deck icon library
	// The deck view draws per-hotkey icons from ITS OWN icons/ tree: Ultralight
	// resolves an <img src> against the view that loaded the page, so a
	// "../MagicDeck/..." or absolute path is not an option. The deployer
	// robocopies icons/{sh/**, sh_index.json} into view/HotkeyDeck/ as well, and
	// the two indexes are interchangeable because every path inside is
	// view-relative.
	std::string DeckIconIndexJson()
	{
		return IconIndexJsonAt(DeckViewDir() / "icons" / "sh_index.json", "deck");
	}

	// Custom icons arrive in the SPELL DECK's folder — the Deck Portal uploads
	// there and SweepDesktopIcons() sweeps Desktop\Spell Deck Icons there — so
	// mirror them across before the deck scans its own pool. ONE WAY on purpose
	// (MagicDeck stays the single authoring folder, so a stale copy can never
	// win); images only; size-compared, so it is a no-op after the first pass.
	void MirrorCustomIcons(const std::filesystem::path& src, const std::filesystem::path& dst)
	{
		if (const auto copied = CopyNewImages(src, dst, "icon mirror"); copied > 0)
			logger::info("mirrored {} custom icon(s) into the deck view", copied);
	}

	// Live listing for the deck's icon picker: sweep the desktop drop folder,
	// mirror magic -> deck, then enumerate the deck's own folder.
	std::string DeckCustomIconsJson()
	{
		const auto magicDir = MagicViewDir() / "icons" / "custom";
		const auto deckDir = DeckViewDir() / "icons" / "custom";
		SweepDesktopIcons(magicDir);
		MirrorCustomIcons(magicDir, deckDir);
		return CustomIconsJsonIn(deckDir);
	}

	// hdIconList: the deck picker's Refresh — re-scan and re-push right now.
	// Deliberately does NOT re-push hdOpen (that would reset the tab / edit mode /
	// search); the view merges the new listing into its icon library only.
	void OnJsIconList(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("hdIcons", DeckCustomIconsJson());
		});
	}

	// hdOpenSpells: the "Spells" launcher in the deck's top nav. PrismaUI focus is
	// single-view, so ours must let go FIRST and the handover happens on a SECOND
	// task hop — CanOpenNow() gates on HasAnyActiveFocus() and on the pause the
	// deck was holding, and neither is guaranteed to have settled in the same
	// frame as the Unfocus. Same nested-AddTask shape OnJsFolWorld already uses.
	void OnJsOpenSpells(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); });
		// ClosePalette() only STARTS the handoff: PrismaUI still owns focus (and
		// the pause with it) for a frame or more afterwards, so CanOpenNow() is
		// reliably FALSE on the very next task — which is how this shipped, and
		// why the launcher answered "use F18" every single time (play-tested
		// 2026-07-30 12:26). A click is an explicit request, so give the handoff
		// a real budget instead of one frame. Same detached-sleep-then-AddTask
		// idiom as FireAndClose().
		std::thread([]() {
			using namespace std::chrono;
			for (int i = 0; i < 15; ++i) {  // ~1.2 s, then give up loudly
				std::this_thread::sleep_for(milliseconds(80));
				if (g_magicOpen.load())
					return;  // open — the click landed
				SKSE::GetTaskInterface()->AddTask([]() {
					// Re-checked on the main thread: CanOpenNow() reads live UI state.
					if (!g_magicOpen.load() && CanOpenNow())
						EnsureMagicViewAndOpen();
				});
			}
			SKSE::GetTaskInterface()->AddTask([]() {
				if (g_magicOpen.load())
					return;
				// Never fail silently: the player clicked something.
				logger::warn("hdOpenSpells: focus/pause never cleared after ~1.2 s");
				// ASCII only: the notification bar renders the game's own
				// encoding, not UTF-8 (every other literal here follows suit).
				RE::DebugNotification("Spell Deck unavailable right now - use the F18 key");
			});
		}).detach();
	}

	// ------------------------------------------- Deck Portal NPC-field handoff
	// The Deck Portal (portal/server.js) lets a phone set a follower's
	// relationship/home/… while the game is running. It deliberately NEVER
	// writes FollowerOrganizer.json: FO holds the whole roster in memory and
	// rewrites that file wholesale on every SaveSettings(), so a portal write
	// would be clobbered by the next in-game rename — silently, and after
	// burning a rotating-backup slot. Instead the portal drops a sidecar in the
	// deck's view folder and we replay it HERE, through the FO Deck API, so FO
	// itself performs the write exactly as if the edit came from the pane.
	//
	//   { "version": 1,
	//     "set": [ { "original": "<Member.OriginalName>",
	//                "key": "relationship", "value": "wife" } ] }
	//
	// Addressed by ORIGINAL NAME, never cat/idx: those shift the moment anyone
	// reorders or re-files someone in-game, and the portal's snapshot of them can
	// be minutes stale. setFieldByOriginal applies to EVERY entry with that name,
	// so a person filed in two categories can't end up disagreeing with herself.
	// "" clears the field. Unknown names are skipped (FO returns a message we
	// log); a malformed file is logged and discarded rather than retried forever.
	//
	// MAIN THREAD ONLY — FollowerDeck::Apply touches FO's roster and live actors.
	// v0.11.0: also replayed by PortalPollLoop()'s main-thread task (gated on
	// g_gameReady, because the roster does not exist on the main menu). Returns
	// true when at least one field write was accepted, so the poller re-pushes
	// fdState only on real news.

	// Minimal base64 -> bytes. No dependency, and the only caller is the portal
	// portrait bridge, which hands us an image a phone just encoded.
	std::vector<std::uint8_t> DecodeBase64(const std::string& in)
	{
		auto val = [](unsigned char c) -> int {
			if (c >= 'A' && c <= 'Z') return c - 'A';
			if (c >= 'a' && c <= 'z') return c - 'a' + 26;
			if (c >= '0' && c <= '9') return c - '0' + 52;
			if (c == '+') return 62;
			if (c == '/') return 63;
			return -1;               // '=' and any whitespace/newline
		};
		std::vector<std::uint8_t> out;
		out.reserve(in.size() * 3 / 4);
		int acc = 0, bits = 0;
		for (const unsigned char c : in) {
			const int v = val(c);
			if (v < 0) continue;     // skip padding and stray whitespace
			acc = (acc << 6) | v;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out.push_back(static_cast<std::uint8_t>((acc >> bits) & 0xFF));
			}
		}
		return out;
	}

	// ------------------------------------------------- portal portraits (live)
	//
	//  WHY THIS EXISTS: a portrait cropped on the phone used to be invisible in
	//  game until the next launch. MO2 snapshots the directory LISTING at start,
	//  so a file the portal newly creates in the mod folder is not there as far
	//  as the running game is concerned — the scanner iterates the folder and
	//  simply never sees it. (A direct open by exact path DOES resolve, which is
	//  why the sidecars below work at all.)
	//
	//  So the portal stops writing the image itself and hands us the BYTES. Our
	//  write goes through the VFS from inside the game, exactly like an in-game
	//  capture, so the file lands in overwrite and the very next scan finds it.
	//  The portal is no longer writing image files into a mod folder the game has
	//  open — which it never should have been.
	bool ApplyPortalPortraits()
	{
		const auto      file = DeckViewDir() / "portal-portraits.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				logger::warn("portal portraits present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto j = json::parse(text, nullptr, false);
		std::size_t wrote = 0;
		if (j.is_discarded() || !j.is_object() || !j["shots"].is_array()) {
			logger::error("portal portraits file is malformed — discarding it");
		} else {
			const auto dir = DeckViewDir() / "portraits";
			std::filesystem::create_directories(dir, ec);
			for (const auto& e : j["shots"]) {
				if (!e.is_object())
					continue;
				const auto slug = PortraitCapture::SlugOfName(e.value("slug", std::string("")));
				auto       ext = e.value("ext", std::string("jpg"));
				const auto b64 = e.value("dataBase64", std::string(""));
				if (slug.empty() || b64.empty())
					continue;
				if (ext != "png" && ext != "jpg" && ext != "jpeg" && ext != "webp")
					ext = "jpg";
				const auto bytes = DecodeBase64(b64);
				if (bytes.empty()) {
					logger::warn("portal portrait '{}' did not decode — skipped", slug);
					continue;
				}
				// Same lock rule as the capture: a portrait the deck has already
				// DRAWN is memory-mapped and cannot be overwritten, so fall back
				// to a versioned name the scanner resolves back to this slug.
				if (!PortraitCapture::WritePortraitBytes(dir, slug, ext, bytes))
					logger::warn("portal portrait '{}' could not be written", slug);
				else
					++wrote;
			}
		}

		// TRUNCATE, never delete. MO2 snapshots the directory LISTING at launch,
		// so a file the portal CREATES mid-session is invisible to the running
		// game — but an edit to a file that already existed is seen. Deleting the
		// bridge after every batch therefore made the next phone upload a create,
		// and the queue silently never arrived. (Proven 2026-08-02: ysolda.jpg and
		// a 202 KB portal-portraits.json both on disk, zero "portal portrait"
		// lines in the log, because the game launched ten minutes earlier.)
		// Writing an empty queue back keeps the file — and its VFS visibility —
		// alive for the next one.
		EnsurePortraitBridge(true);
		if (wrote)
			logger::info("portal portraits: wrote {} through the VFS - visible without a relaunch", wrote);
		return wrote > 0;
	}

	// ------------------------------------ portal category icons (followers rail)
	//
	//  The phone's half of v0.14's category glyphs. Shape:
	//
	//    { "version": 1,
	//      "set": [ { "cat": 3, "icon": "icons/custom/hd-shield.png" } ] }
	//
	//  "" clears one. Keyed by the FO category SLOT INDEX for exactly the reason
	//  the in-game picker is (see FollowerConfig::catIcons): the label is
	//  renameable — from this very portal — so a name key would orphan the glyph
	//  the moment "Housecarls" became "Housecarls (Whiterun)".
	//
	//  CONFIG-ONLY, so unlike the fo-ops/npc-field sidecars this needs no loaded
	//  save, no roster and no main thread: it is applied straight on the poller's
	//  own worker thread, exactly like the hotkey-icon sidecar, and works at the
	//  main menu. Validation is the SAME pair of rules as every other writer of
	//  this map — a real slot index and a path ValidViewIconPath accepts —
	//  because the portal is just another untrusted input here.
	bool ApplyPortalCatIcons()
	{
		const auto      file = DeckViewDir() / "portal-cat-icons.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next tick gets it.
				logger::warn("portal category icons present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto  j = json::parse(text, nullptr, false);
		std::size_t applied = 0, skipped = 0;
		if (j.is_discarded() || !j.is_object() || !j.contains("set") || !j["set"].is_array()) {
			logger::error("portal category icons file is malformed — discarding it");
		} else {
			for (const auto& e : j["set"]) {
				if (!e.is_object())
					continue;
				if (!e.contains("cat") || !e["cat"].is_number_integer()) { ++skipped; continue; }
				const int idx = e["cat"].get<int>();
				if (idx < 0 || idx > kFolCatMax) {
					++skipped;
					logger::info("portal category icon for slot {} skipped: outside 0..{}", idx, kFolCatMax);
					continue;
				}
				auto path = e.value("icon", std::string(""));
				// Empty is the legal CLEAR, so it is checked before the path guard
				// (which also accepts "" — this branch is what makes the intent
				// explicit rather than incidental).
				const bool clear = path.empty();
				if (!clear && !ValidViewIconPath(path)) {
					++skipped;
					logger::info("portal category icon for slot {} refused: '{}' is not a view-relative icons/ path",
						idx, e.value("icon", std::string("")));
					continue;
				}
				{
					std::lock_guard l(g_configMutex);
					if (clear) {
						g_folConfig.catIcons.erase(idx);
					} else if (g_folConfig.catIcons.size() < kMaxCatIcons ||
						g_folConfig.catIcons.count(idx)) {
						// Same ceiling rule as the portrait crops: only a NEW key is
						// refused when the map is full, so re-skinning a category
						// that already has a glyph always works.
						g_folConfig.catIcons[idx] = path;
					} else {
						++skipped;
						continue;
					}
				}
				++applied;
				logger::info("portal category icon: slot {} -> {}", idx, clear ? std::string("(none)") : path);
			}
		}

		if (applied) {
			if (!PersistAll())
				logger::error("portal category icons: applied but failed to write to disk");
			logger::info("portal category icons: {} set, {} skipped", applied, skipped);
		} else if (skipped) {
			logger::info("portal category icons: 0 set, {} skipped", skipped);
		}

		// TRUNCATE, never delete — the portrait bridge's law, and the same MO2
		// listing-snapshot reason: a file the portal has to CREATE mid-session is
		// invisible to the running game, so the empty queue is written back to
		// keep this one alive for the next batch.
		EnsureCatIconBridge(true);
		return applied > 0;
	}

	// The Spell Deck twin of ApplyPortalCatIcons above: entries are
	// { cat: "<category name>", icon: "icons/custom/x.png" | "" }, applied into
	// g_magicConfig.catIcons. A name the rail doesn't currently hold is stored
	// anyway — the portal validates against the live rail, and an entry for a
	// category re-added later is a feature, not a leak (the map is capped).
	bool ApplyPortalSpellCatIcons()
	{
		const auto      file = MagicViewDir() / "portal-spell-cat-icons.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				logger::warn("portal spell-category icons present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto  j = json::parse(text, nullptr, false);
		std::size_t applied = 0, skipped = 0;
		if (j.is_discarded() || !j.is_object() || !j.contains("set") || !j["set"].is_array()) {
			logger::error("portal spell-category icons file is malformed — discarding it");
		} else {
			for (const auto& e : j["set"]) {
				if (!e.is_object())
					continue;
				if (!e.contains("cat") || !e["cat"].is_string()) { ++skipped; continue; }
				const auto name = e["cat"].get<std::string>();
				if (name.empty() || name.size() > 64) { ++skipped; continue; }
				auto       path = e.value("icon", std::string(""));
				const bool clear = path.empty();
				if (!clear && !ValidViewIconPath(path)) {
					++skipped;
					logger::info("portal spell-category icon for '{}' refused: '{}' is not a view-relative icons/ path",
						name, e.value("icon", std::string("")));
					continue;
				}
				{
					std::lock_guard l(g_configMutex);
					if (clear) {
						g_magicConfig.catIcons.erase(name);
					} else if (g_magicConfig.catIcons.size() < kMaxSpellCatIcons ||
						g_magicConfig.catIcons.count(name)) {
						g_magicConfig.catIcons[name] = path;
					} else {
						++skipped;
						continue;
					}
				}
				++applied;
				logger::info("portal spell-category icon: '{}' -> {}", name, clear ? std::string("(none)") : path);
			}
		}

		if (applied) {
			if (!PersistAll())
				logger::error("portal spell-category icons: applied but failed to write to disk");
			logger::info("portal spell-category icons: {} set, {} skipped", applied, skipped);
		} else if (skipped) {
			logger::info("portal spell-category icons: 0 set, {} skipped", skipped);
		}

		EnsureSpellCatIconBridge(true);  // truncate, never delete — same law as every bridge
		return applied > 0;
	}

	bool ApplyPortalNpcFields()
	{
		const auto      file = DeckViewDir() / "portal-npc-fields.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next open gets it.
				logger::warn("portal npc fields present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto  j = json::parse(text, nullptr, false);
		std::size_t applied = 0;  // hoisted: the poller needs it after the block
		if (j.is_discarded() || !j.is_object() || !j.contains("set") || !j["set"].is_array()) {
			logger::error("portal npc fields file is malformed — discarding it");
		} else {
			std::size_t skipped = 0;
			for (const auto& e : j["set"]) {
				if (!e.is_object())
					continue;
				const auto original = e.value("original", std::string(""));
				const auto key = e.value("key", std::string(""));
				if (original.empty() || key.empty())
					continue;
				// Straight through the same API the pane uses — FO validates the
				// key, trims/caps the value, erases on "" and saves its own JSON.
				const json cmd{ { "op", "setFieldByOriginal" },
					{ "original", original },
					{ "key", key },
					{ "value", e.value("value", std::string("")) } };
				const auto res = json::parse(FollowerDeck::Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
				if (!res.is_discarded() && res.value("ok", false)) {
					++applied;
					logger::info("portal npc field: '{}' {} -> '{}'", original, key,
						e.value("value", std::string("")));
				} else {
					++skipped;
					logger::info("portal npc field for '{}' skipped: {}", original,
						res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
				}
			}
			if (applied || skipped)
				logger::info("portal npc fields: {} applied, {} skipped", applied, skipped);
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. If the delete is refused, blank it so the portal stops showing
		// the change as still pending.
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal npc fields ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"set":[]})";
		}
		return applied > 0;
	}

	// -------------------------------- Deck Portal category-ops handoff
	// portal-fo-ops.json: category MOVE + RENAME queued by the phone. Same law and
	// same shape of handler as ApplyPortalNpcFields() above — read, apply each op
	// through the FO Deck API, consume the file either way. A MOVE is name-keyed, so
	// it is resolved to the follower's live cat/idx off a fresh StateJson() before
	// calling moveMember (see src/portal-fo-ops-wiring.md).
	//
	// MAIN THREAD ONLY — needs a loaded save (FO roster) and touches actors.
	// Returns true when at least one op was accepted, so the poller re-pushes
	// fdState only on real news.
	bool ApplyPortalFollowerOps()
	{
		const auto      file = DeckViewDir() / "portal-fo-ops.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, next tick gets it.
				logger::warn("portal fo-ops present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto  j = json::parse(text, nullptr, false);
		std::size_t applied = 0;
		if (j.is_discarded() || !j.is_object() || !j.contains("ops") || !j["ops"].is_array()) {
			logger::error("portal fo-ops file is malformed — discarding it");
		} else {
			std::size_t skipped = 0;

			// One StateJson snapshot for the whole batch — resolve every MOVE name
			// against it. Renames don't need it (they carry the slot directly), but
			// building it once is cheap and keeps the two paths uniform.
			const auto state = json::parse(FollowerDeck::StateJson(), nullptr, false);

			// original (lowercased) -> {cat, idx}, first occurrence wins.
			auto resolve = [&](const std::string& original) -> std::optional<std::pair<int, int>> {
				if (state.is_discarded() || !state.contains("categories"))
					return std::nullopt;
				std::string want = original;
				std::transform(want.begin(), want.end(), want.begin(),
					[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
				for (const auto& c : state["categories"]) {
					const int cat = c.value("index", -1);
					if (cat < 1 || !c.contains("members"))
						continue;
					int idx = 0;
					for (const auto& m : c["members"]) {
						std::string got = m.value("original", std::string(""));
						std::transform(got.begin(), got.end(), got.begin(),
							[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
						if (got == want)
							return std::make_pair(cat, idx);
						++idx;
					}
				}
				return std::nullopt;
			};

			for (const auto& e : j["ops"]) {
				if (!e.is_object())
					continue;
				const auto type = e.value("type", std::string(""));

				if (type == "move") {
					const auto original = e.value("original", std::string(""));
					const int  toCat = e.value("toCat", -1);
					if (original.empty() || toCat < 1) { ++skipped; continue; }
					const auto hit = resolve(original);
					if (!hit) {
						++skipped;
						logger::info("portal fo move for '{}' skipped: not in the roster", original);
						continue;
					}
					const json cmd{ { "op", "moveMember" },
						{ "cat", hit->first }, { "idx", hit->second }, { "to", toCat } };
					const auto res = json::parse(FollowerDeck::Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
					// moveMember returns "" (empty message) on success; the FO Deck
					// API wraps that as {"ok":true}. Match ApplyPortalNpcFields().
					if (!res.is_discarded() && res.value("ok", false)) {
						++applied;
						logger::info("portal fo move: '{}' ({},{}) -> slot {}", original,
							hit->first, hit->second, toCat);
					} else {
						++skipped;
						logger::info("portal fo move for '{}' skipped: {}", original,
							res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
					}

				} else if (type == "delete") {
					// Take her off the roster entirely (Rober: "ability to delete
					// followers as well form web app is needed").
					//
					// Keyed by ORIGINAL NAME for the same reason move is, only more
					// so: a delete SHIFTS every index after it, so a batch holding
					// two deletes addressed by position would get the second one
					// wrong. Resolving each name against a snapshot taken before
					// the batch has the same flaw, so this one re-resolves against
					// LIVE state per op rather than using `resolve`.
					//
					// This removes her from Follower Organizer's list. It does not
					// dismiss, disable or otherwise touch the actor — FO is a
					// filing cabinet and this is un-filing her.
					const auto original = e.value("original", std::string(""));
					if (original.empty()) { ++skipped; continue; }

					const auto live = json::parse(FollowerDeck::StateJson(), nullptr, false);
					std::optional<std::pair<int, int>> hit;
					if (!live.is_discarded() && live.contains("categories")) {
						std::string want = original;
						std::transform(want.begin(), want.end(), want.begin(),
							[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
						for (const auto& c : live["categories"]) {
							const int cat = c.value("index", -1);
							if (cat < 1 || !c.contains("members"))
								continue;
							int idx = 0;
							for (const auto& m : c["members"]) {
								std::string got = m.value("original", m.value("name", std::string("")));
								std::transform(got.begin(), got.end(), got.begin(),
									[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
								if (got == want) { hit = std::make_pair(cat, idx); break; }
								++idx;
							}
							if (hit)
								break;
						}
					}
					if (!hit) {
						++skipped;
						logger::info("portal fo delete for '{}' skipped: not in the roster", original);
						continue;
					}
					const json cmd{ { "op", "deleteMember" },
						{ "cat", hit->first }, { "idx", hit->second } };
					const auto res = json::parse(FollowerDeck::Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
					if (!res.is_discarded() && res.value("ok", false)) {
						++applied;
						logger::info("portal fo delete: '{}' removed from slot {}", original, hit->first);
					} else {
						++skipped;
						logger::info("portal fo delete for '{}' skipped: {}", original,
							res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
					}

				} else if (type == "setDesc") {
					// The NOTE under a follower's name — FO's own Description
					// field, which the deck has always been able to type into
					// and the phone could only READ ("be nice if i could edit
					// their sub-text in web app"). Same resolve-by-name rule as
					// the others; "" is a legal value and clears it.
					const auto original = e.value("original", std::string(""));
					if (original.empty()) { ++skipped; continue; }
					const auto hit = resolve(original);
					if (!hit) {
						++skipped;
						logger::info("portal fo note for '{}' skipped: not in the roster", original);
						continue;
					}
					const json cmd{ { "op", "setDesc" },
						{ "cat", hit->first }, { "idx", hit->second },
						{ "desc", e.value("desc", std::string("")) } };
					const auto res = json::parse(FollowerDeck::Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
					if (!res.is_discarded() && res.value("ok", false)) {
						++applied;
						logger::info("portal fo note: '{}' updated", original);
					} else {
						++skipped;
						logger::info("portal fo note for '{}' skipped: {}", original,
							res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
					}

				} else if (type == "renameCategory") {
					const int cat = e.value("cat", -1);
					if (cat < 1) { ++skipped; continue; }
					const json cmd{ { "op", "renameCategory" },
						{ "cat", cat }, { "name", e.value("name", std::string("")) } };
					const auto res = json::parse(FollowerDeck::Apply(cmd.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
					if (!res.is_discarded() && res.value("ok", false)) {
						++applied;
						logger::info("portal fo rename: slot {} -> '{}'", cat, e.value("name", std::string("")));
					} else {
						++skipped;
						logger::info("portal fo rename slot {} skipped: {}", cat,
							res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
					}
				} else {
					++skipped;  // unknown op type
				}
			}
			if (applied || skipped)
				logger::info("portal fo-ops: {} applied, {} skipped", applied, skipped);
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. Same delete-or-blank fallback as ApplyPortalNpcFields().
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal fo-ops ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"ops":[]})";
		}
		return applied > 0;
	}

	// --------------------------------------- Deck Portal hotkey-icon handoff
	// Exactly the ApplyPortalAssignments contract, for Config.entries[].icon:
	//
	//   { "version": 1,
	//     "assign": [ { "entryId": "<Config.entries[].id>",
	//                   "icon": "icons/custom/foo.png" } ] }
	//
	// Lives in the DECK view's icons/custom/ (each view loads icons from its own
	// tree). "" clears the icon. Unknown entryIds are skipped — the player deleted
	// the hotkey — and a malformed file is logged and discarded rather than
	// retried forever. Returns true only when an icon actually changed, so the
	// poller re-pushes the view on real news only.
	bool ApplyPortalHotkeyIcons(const std::filesystem::path& customDir)
	{
		const auto      file = customDir / "portal-hotkey-icons.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, the next tick gets it.
				logger::warn("portal hotkey icons present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto j = json::parse(text, nullptr, false);
		bool       changed = false;
		if (j.is_discarded() || !j.is_object() || !j.contains("assign") || !j["assign"].is_array()) {
			logger::error("portal hotkey icons file is malformed — discarding it");
		} else {
			// Scope the lock TIGHTLY: PersistAll() takes g_configMutex itself and
			// std::mutex is not recursive, so it must be called unlocked.
			std::lock_guard l(g_configMutex);
			for (const auto& e : j["assign"]) {
				if (!e.is_object())
					continue;
				const auto  id = e.value("entryId", std::string(""));
				std::string icon = e.value("icon", std::string(""));
				if (id.empty())
					continue;
				if (!ValidViewIconPath(icon)) {
					logger::warn("portal hotkey icon '{}' is not a view-relative icons/ path — skipped", icon);
					continue;
				}
				// Ids SHOULD be unique, but a hand-edited hotkeys.json can duplicate one;
				// hit every match so a duplicated entry can't disagree with itself.
				bool found = false;
				for (auto& h : g_config.entries) {
					if (h.id != id)
						continue;
					found = true;
					if (h.icon == icon)
						continue;  // already there; don't churn the config file
					logger::info("portal hotkey icon: '{}' -> '{}'", h.name,
						icon.empty() ? std::string("(none)") : icon);
					h.icon = icon;
					changed = true;
				}
				if (!found) {
					logger::info("portal hotkey icon for unknown entry id '{}' — skipped", id);
					continue;
				}
			}
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. If the delete is refused, blank it so the portal stops showing
		// the change as still pending.
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal hotkey icons ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"assign":[]})";
		}
		if (changed && !PersistAll())
			logger::error("portal hotkey icons applied in memory but the config write failed");
		return changed;
	}

	// --------------------------------------- Deck Portal hotkey-edit handoff
	// The fourth sidecar, and the only one that changes what a hotkey IS:
	//
	//   { "version": 1,
	//     "ops": [ { "op": "update", "entryId": "<Config.entries[].id>",
	//                "name": "...", "desc": "...", "category": "...",
	//                "device": "keyboard"|"mouse", "code": 65, "label": "F7",
	//                "mods": [42, 29] },
	//              { "op": "delete", "entryId": "..." } ] }
	//
	// PARTIAL by design: only the keys PRESENT are touched, so the phone can push a
	// rename without shipping (and re-staling) the rest of the entry. An empty
	// desc/category IS a value — it clears the field; the writer omits what it does
	// not mean to change. A phone cannot "press a key to bind", so a rebind arrives
	// as device + code + label (+ mods) from the portal's curated DIK table.
	//
	// Same mechanics as the other three sidecars: dedupe by entryId (last update
	// wins; a delete always beats an update for the same id, whichever order they
	// arrived in), the CONSUMER deletes the file, an unreadable file (the portal
	// mid-write) is left for the next tick, a malformed one is discarded rather
	// than retried forever, and an unknown entryId is logged and skipped.
	// Config-only, so it is safe on the poller thread and at the main menu.

	constexpr std::size_t kPortalNameMax  = 64;   // an entry must keep a usable name
	constexpr std::size_t kPortalDescMax  = 200;
	constexpr std::size_t kPortalLabelMax = 24;   // the deck prints it verbatim on the key cap
	constexpr std::size_t kPortalModsMax  = 3;    // Shift/Ctrl/Alt is the whole vocabulary

	// Trim ASCII whitespace off both ends. Deliberately not std::isspace: that is
	// locale-dependent and UB on a negative char (UTF-8 bytes are negative).
	std::string PortalTrim(std::string s)
	{
		const auto ws = [](char c) {
			return c == ' ' || c == '\t' || c == '\r' || c == '\n';
		};
		std::size_t b = 0, e = s.size();
		while (b < e && ws(s[b]))
			++b;
		while (e > b && ws(s[e - 1]))
			--e;
		return s.substr(b, e - b);
	}

	// Trim, then cap the BYTE length without ever splitting a UTF-8 sequence:
	// ConfigToJson(...).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) throws on invalid UTF-8 and OpenPalette() calls it
	// unguarded, so half a character here would be a CTD, not a cosmetic bug.
	// (json::parse already guarantees the input string is valid UTF-8.)
	std::string PortalTrimCap(std::string s, std::size_t maxBytes)
	{
		s = PortalTrim(std::move(s));
		if (s.size() > maxBytes) {
			std::size_t n = maxBytes;
			while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80)
				--n;  // back off the continuation bytes onto a lead byte
			s.resize(n);
		}
		return s;
	}

	// One collapsed queue slot: the phone may have tapped several times on one
	// entry before the game got a tick.
	struct PendingHotkeyEdit
	{
		std::string id;
		bool        del = false;
		json        fields;  // the winning "update" op; unused when del
	};

	// Apply one "update" op to one entry. THE CALLER HOLDS g_configMutex (the
	// category whitelist lives in g_config). Every field is validated on its own:
	// a bad one is logged and dropped and the rest of the op still lands — a phone
	// that sends one out-of-range code must not also lose the rename it sent with
	// it. Returns true when the entry really changed.
	bool ApplyOneHotkeyEdit(HotkeyEntry& h, const json& e)
	{
		bool changed = false;

		// --- name: an entry must always keep a name, so an empty one is ignored.
		if (e.contains("name")) {
			if (!e["name"].is_string()) {
				logger::warn("portal hotkey edit '{}': name is not a string — skipped", h.name);
			} else {
				const auto name = PortalTrimCap(e["name"].get<std::string>(), kPortalNameMax);
				if (name.empty()) {
					logger::warn("portal hotkey edit '{}': empty name ignored", h.name);
				} else if (name != h.name) {
					logger::info("portal hotkey edit: '{}' renamed -> '{}'", h.name, name);
					h.name = name;
					changed = true;
				}
			}
		}

		// --- desc: "" is a real value (clear the description).
		if (e.contains("desc")) {
			if (!e["desc"].is_string()) {
				logger::warn("portal hotkey edit '{}': desc is not a string — skipped", h.name);
			} else {
				const auto desc = PortalTrimCap(e["desc"].get<std::string>(), kPortalDescMax);
				if (desc != h.desc) {
					logger::info("portal hotkey edit: '{}' desc -> '{}'", h.name,
						desc.empty() ? std::string("(none)") : desc);
					h.desc = desc;
					changed = true;
				}
			}
		}

		// --- category: must already be a tab (case-sensitive); "" = All only. The
		// portal never creates tabs — that is a deck edit, and inventing one here
		// would resurrect a tab the player just deleted.
		if (e.contains("category")) {
			if (!e["category"].is_string()) {
				logger::warn("portal hotkey edit '{}': category is not a string — skipped", h.name);
			} else {
				const auto cat = PortalTrim(e["category"].get<std::string>());  // NOT capped: it must match a tab byte for byte
				const bool known = cat.empty() ||
					std::find(g_config.categories.begin(), g_config.categories.end(), cat) != g_config.categories.end();
				if (!known) {
					logger::warn("portal hotkey edit '{}': unknown category '{}' — skipped (add the tab in-game first)",
						h.name, cat);
				} else if (cat != h.category) {
					logger::info("portal hotkey edit: '{}' category -> '{}'", h.name,
						cat.empty() ? std::string("(All only)") : cat);
					h.category = cat;
					changed = true;
				}
			}
		}

		// --- the binding: device / code / label / mods.
		const bool hasDevice = e.contains("device");
		const bool hasCode = e.contains("code");
		const bool hasLabel = e.contains("label");
		const bool hasMods = e.contains("mods");
		if (!hasDevice && !hasCode && !hasLabel && !hasMods)
			return changed;

		// The action verb is C++-owned: an action entry can be renamed and re-filed
		// from the phone, never re-bound, and a key entry can never be turned INTO
		// one. Both directions would produce an entry OnJsFire cannot dispatch.
		if (h.device == "action") {
			logger::warn("portal hotkey edit '{}': native action entry — binding fields skipped", h.name);
			return changed;
		}

		std::string device = h.device;
		if (hasDevice) {
			if (!e["device"].is_string()) {
				logger::warn("portal hotkey edit '{}': device is not a string — skipped", h.name);
			} else {
				const auto d = PortalTrim(e["device"].get<std::string>());
				if (!ValidDevice(d))  // rejects "action" too, by construction
					logger::warn("portal hotkey edit '{}': device '{}' is not keyboard/mouse — skipped", h.name, d);
				else
					device = d;
			}
		}

		// Range depends on the device the entry ENDS UP on: keyboard = DIK scancode,
		// mouse = Skyrim idCode (2 middle / 3 Mouse4 / 4 Mouse5).
		const auto inRange = [](const std::string& dev, std::uint32_t c) {
			return dev == "mouse" ? (c >= 2 && c <= 4) : (c >= 1 && c <= 255);
		};

		std::uint32_t code = h.code;
		bool          rebind = false;
		bool          codeRejected = false;
		if (hasCode) {
			if (!e["code"].is_number_integer()) {
				logger::warn("portal hotkey edit '{}': code is not a number — skipped", h.name);
				codeRejected = true;
			} else {
				const auto raw = e["code"].get<std::int64_t>();
				if (raw < 0 || raw > 255 || !inRange(device, static_cast<std::uint32_t>(raw))) {
					logger::warn("portal hotkey edit '{}': code {} is out of range for device '{}' — binding skipped",
						h.name, raw, device);
					codeRejected = true;
				} else {
					code = static_cast<std::uint32_t>(raw);
					rebind = true;
				}
			}
		} else if (device != h.device && !inRange(device, h.code)) {
			// Device switched with no new code, and the old code cannot live there
			// (e.g. keyboard 65 -> mouse). Refuse rather than leave a dead entry.
			logger::warn("portal hotkey edit '{}': device '{}' needs a code that fits it — skipped", h.name, device);
			codeRejected = true;
		}
		if (codeRejected)
			device = h.device;  // never strand an entry on a device its code cannot fire

		if (device != h.device) {
			logger::info("portal hotkey edit: '{}' device -> '{}'", h.name, device);
			h.device = device;
			changed = true;
		}
		if (rebind && code != h.code) {
			logger::info("portal hotkey edit: '{}' code -> {}", h.name, code);
			h.code = code;
			changed = true;
		}

		// Cosmetic, and the deck prints it verbatim — so it may travel alone, but
		// never alongside a code we just refused (that would label the key a lie).
		if (hasLabel && !codeRejected) {
			if (!e["label"].is_string()) {
				logger::warn("portal hotkey edit '{}': label is not a string — skipped", h.name);
			} else {
				const auto label = PortalTrimCap(e["label"].get<std::string>(), kPortalLabelMax);
				if (label != h.label) {
					logger::info("portal hotkey edit: '{}' label -> '{}'", h.name,
						label.empty() ? std::string("(none)") : label);
					h.label = label;
					changed = true;
				}
			}
		}

		// An explicit [] clears the chord; same "not with a refused code" rule.
		if (hasMods && !codeRejected) {
			if (!e["mods"].is_array()) {
				logger::warn("portal hotkey edit '{}': mods is not an array — skipped", h.name);
			} else {
				std::vector<std::uint32_t> mods;
				std::size_t                bad = 0, over = 0;
				for (const auto& m : e["mods"]) {
					if (!m.is_number_integer()) {
						++bad;
						continue;
					}
					const auto raw = m.get<std::int64_t>();
					if (raw < 1 || raw > 255) {
						++bad;
						continue;
					}
					const auto v = static_cast<std::uint32_t>(raw);
					if (std::find(mods.begin(), mods.end(), v) != mods.end())
						continue;  // deduped: holding a key twice is still holding it once
					if (mods.size() >= kPortalModsMax) {
						++over;
						continue;
					}
					mods.push_back(v);
				}
				if (bad || over)
					logger::warn("portal hotkey edit '{}': {} bad modifier(s), {} past the {}-modifier limit — dropped",
						h.name, bad, over, kPortalModsMax);
				if (mods != h.mods) {
					logger::info("portal hotkey edit: '{}' mods -> {} held key(s)", h.name, mods.size());
					h.mods = std::move(mods);
					changed = true;
				}
			}
		}
		return changed;
	}

	// Returns true only when the config really changed — the poller's "worth
	// repainting the deck" signal.
	bool ApplyPortalHotkeyEdits(const std::filesystem::path& deckDir)
	{
		const auto      file = deckDir / "portal-hotkey-edits.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				// Held open by the portal mid-write: leave it, the next tick gets it.
				logger::warn("portal hotkey edits present but unreadable — retrying");
				return false;
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		const auto j = json::parse(text, nullptr, false);
		bool       changed = false;
		if (j.is_discarded() || !j.is_object() || !j.contains("ops") || !j["ops"].is_array()) {
			logger::error("portal hotkey edits file is malformed — discarding it");
		} else {
			// Pass 1, no lock: collapse the queue in arrival order.
			std::vector<PendingHotkeyEdit> queue;
			for (const auto& e : j["ops"]) {
				if (!e.is_object())
					continue;
				if (!e.contains("entryId") || !e["entryId"].is_string())
					continue;
				const auto id = e["entryId"].get<std::string>();
				if (id.empty())
					continue;
				std::string op = "update";  // a missing op is an update
				if (e.contains("op")) {
					if (!e["op"].is_string()) {
						logger::warn("portal hotkey edit for '{}': op is not a string — skipped", id);
						continue;
					}
					op = e["op"].get<std::string>();
				}
				if (op != "update" && op != "delete") {
					logger::warn("portal hotkey edit for '{}': unknown op '{}' — skipped", id, op);
					continue;
				}
				auto it = std::find_if(queue.begin(), queue.end(),
					[&id](const PendingHotkeyEdit& p) { return p.id == id; });
				if (it == queue.end()) {
					PendingHotkeyEdit p;
					p.id = id;
					p.del = (op == "delete");
					if (!p.del)
						p.fields = e;
					queue.push_back(std::move(p));
				} else if (op == "delete") {
					it->del = true;  // a delete always wins, whatever the order
				} else if (!it->del) {
					it->fields = e;  // last update wins
				}
			}

			std::size_t updated = 0, removed = 0, unknown = 0;
			{
				// Scope the lock TIGHTLY: PersistAll() takes g_configMutex itself and
				// std::mutex is not recursive, so it must be called unlocked.
				std::lock_guard l(g_configMutex);
				for (const auto& p : queue) {
					if (p.del) {
						const auto before = g_config.entries.size();
						g_config.entries.erase(
							std::remove_if(g_config.entries.begin(), g_config.entries.end(),
								[&p](const HotkeyEntry& h) { return h.id == p.id; }),
							g_config.entries.end());
						const auto gone = before - g_config.entries.size();
						if (gone == 0) {
							++unknown;
							logger::info("portal hotkey delete for unknown entry id '{}' — skipped", p.id);
							continue;
						}
						// Deleting the LAST entry is allowed; the deck draws an empty state.
						removed += gone;
						changed = true;
						logger::info("portal hotkey delete: id '{}' ({} removed, {} entries left)",
							p.id, gone, g_config.entries.size());
						continue;
					}
					// Ids SHOULD be unique, but a hand-edited hotkeys.json can duplicate
					// one; hit every match so a duplicate can't disagree with itself.
					bool found = false;
					for (auto& h : g_config.entries) {
						if (h.id != p.id)
							continue;
						found = true;
						if (ApplyOneHotkeyEdit(h, p.fields)) {
							++updated;
							changed = true;
						}
					}
					if (!found) {
						++unknown;
						logger::info("portal hotkey edit for unknown entry id '{}' — skipped", p.id);
					}
				}
			}
			if (updated || removed || unknown)
				logger::info("portal hotkey edits: {} updated, {} deleted, {} unknown", updated, removed, unknown);
		}

		// Consume it either way — a file we could not apply must not be retried
		// forever. If the delete is refused, blank it so the portal stops showing
		// the change as still pending.
		std::filesystem::remove(file, ec);
		if (ec) {
			logger::warn("could not delete portal hotkey edits ({}) — blanking instead", ec.message());
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({"version":1,"ops":[]})";
		}
		if (changed && !PersistAll())
			logger::error("portal hotkey edits applied in memory but the config write failed");
		return changed;
	}

	// fdApply: an in-place mutation (rename / note / move / reorder / delete /
	// add / track / category ops). Every reply re-renders the pane from the
	// fresh state the envelope carries.
	void OnJsFolApply(const char* data)
	{
		const std::string cmd = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([cmd]() {
			PushToView("fdState", FollowerDeck::Apply(cmd));
			// A recruit/track/add can change WHO is following, so refresh the live
			// party alongside the roster (main thread — HudFollowersJson scans
			// actors). Cheap and keeps the Current-party bar honest after a mutate.
			PushToView("fdLiveParty", HudFollowersJson());
		});
	}

	// fdWorld: summon / goto / sendback — physical, not administrative. Close
	// the palette first so the teleport lands in the live world, then run, then
	// optionally reopen (closeAfterFire=false), same shape as spell casts.
	// Photograph the follower you clicked, rather than whatever the crosshair
	// happened to be on when the palette opened. Same capture pipeline as the
	// CHIM tab's action — it just names its subject.
	//
	// The palette closes first for the same reason the action does: it is a
	// full-screen web view, and a portrait of it is not a portrait of her.
	void OnJsFolPortrait(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("fdPortrait: bad payload");
			return;
		}
		// The view sends the FO form string ("0x00a2c8"); accept a number too so
		// a future caller does not have to care.
		std::uint32_t formId = 0;
		if (const auto it = j.find("formId"); it != j.end()) {
			if (it->is_number_unsigned()) {
				formId = it->get<std::uint32_t>();
			} else if (it->is_string()) {
				const auto s = it->get<std::string>();
				formId = static_cast<std::uint32_t>(std::strtoul(s.c_str(), nullptr, 16));
			}
		}
		if (!formId) {
			logger::warn("fdPortrait: no usable formId in {}", j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			return;
		}
		const auto dir = DeckViewDir() / "portraits";
		SKSE::GetTaskInterface()->AddTask([dir, formId]() {
			ClosePalette();
			PortraitCapture::Fire(dir, formId);
		});
	}

	void OnJsFolWorld(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("fdWorld: bad payload");
			return;
		}
		const std::string cmd = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const std::string label = j.value("label", std::string(""));
		bool              reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		SKSE::GetTaskInterface()->AddTask([cmd, label, reopen]() {
			ClosePalette();  // the teleport lands in the live world
			const auto res = FollowerDeck::Apply(cmd);
			const auto jr = json::parse(res, nullptr, false);
			const bool ok = !jr.is_discarded() && jr.value("ok", false);
			std::string msg = jr.is_discarded() ? std::string("") : jr.value("msg", std::string(""));
			if (!ok && msg.empty())
				msg = "Follower action failed — see HotkeyDeck.log";
			if (!msg.empty())
				RE::DebugNotification(msg.c_str());
			else if (!label.empty())
				RE::DebugNotification(label.c_str());
			if (reopen)
				SKSE::GetTaskInterface()->AddTask([]() {
					if (CanOpenNow()) {
						g_pendingTab = "followers";  // land back on the tab
						OpenPalette();
					}
				});
		});
	}

	// The NFF / My Home is Your Home snapshot goes out in TWO directions, and
	// both want the same freshly built payload: the in-game pane gets it as
	// `fdNff`, and the Deck Portal gets the MHiYH half of it re-keyed by
	// original name in mhiyh-status.json (a phone has no runtime FormIDs —
	// see the header of src/mhiyh_control.h). One helper, so the export can
	// never be forgotten at one of the four places that push the state.
	/* ---- the LIVE roster, for the phone ---------------------------------
	 *  "deleting in game didnt delete them from the web-app" (Rober).
	 *
	 *  Not a portal bug. The portal reads FollowerOrganizer.json off disk, and
	 *  Follower Organizer holds the whole roster IN MEMORY while the game runs
	 *  — it rewrites the file on its own schedule. So the phone was showing a
	 *  snapshot from some earlier moment and had no way to know it was stale.
	 *  The same law that stops the portal WRITING that file (it would be
	 *  discarded) also stops it trusting the file for reads.
	 *
	 *  So export what the deck already has in hand. FollowerDeck::StateJson()
	 *  is FO's own live state, straight from the singleton — the very payload
	 *  the Followers tab renders — and this is the one place every refresh
	 *  funnels through, so the export cannot drift from what the deck shows.
	 *  Stamped with `at` so the portal can prefer whichever source is FRESHER
	 *  rather than guessing.
	 */
	void WriteRosterExport(const std::string& fo)
	{
		auto state = json::parse(fo, nullptr, false);
		if (state.is_discarded() || !state.is_object())
			return;   // nothing worth writing; keep the last good export

		const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
		state["at"] = static_cast<long long>(now);
		state["source"] = "live";

		const auto dir = DeckViewDir();
		std::error_code ec;
		std::filesystem::create_directories(dir, ec);
		const auto file = dir / "fo-roster.json";
		const auto tmp = dir / "fo-roster.json.tmp";
		{
			std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
			if (!out.is_open())
				return;
			out << state.dump(-1, ' ', false, json::error_handler_t::replace);
		}
		std::filesystem::rename(tmp, file, ec);   // atomic: never a half file
		if (ec)
			return;

		static bool said = false;
		if (!said) {
			said = true;
			logger::info("fo: live roster exported for the portal");
		}
	}

	void PushFollowerNff(const std::string& fo)
	{
		const auto nff = NffBridge::StateJson(fo);
		PushToView("fdNff", nff);
		MhiyhControl::WriteStatusJson(DeckViewDir(), fo, nff);
		WriteRosterExport(fo);
	}

	// What a PHONE-queued day change does when MHiYH finally answers. Byte for
	// byte what an in-deck click does (see OnJsFolMhiyh below): the open pane
	// gets the same `fdMhiyhResult` toast and the same repaint, so a change made
	// from the phone is indistinguishable from one made in game. Main thread —
	// MhiyhControl hops for us before calling this.
	void PortalMhiyhDone(const std::string& res)
	{
		PushToView("fdMhiyhResult", res);
		PushFollowerNff(FollowerDeck::StateJson());
	}

	// fdMhiyh: tell My Home is Your Home NG to change someone's day — give or
	// move a home, mark or clear one of the six other stops, forget the lot.
	//
	// NAMING: request listener `fdMhiyh`, reply pushed as `fdMhiyhResult` — the
	// two MUST differ. PrismaUI installs every registered listener as a JS
	// global of its own name, so a pane that also assigns `window.fdMhiyh` to
	// catch the reply overwrites the bridge, and `toGame('fdMhiyh')` then calls
	// the pane's own handler instead of this function. That is not a cosmetic
	// clash: it silently unplugs the whole feature (proven on fdNpc/fdEquipped
	// in v0.10, and this listener carried the same defect until 2026-08-02).
	//
	// Deliberately NOT shaped like fdWorld: nothing here teleports anybody, and
	// the marker every op creates is placed at the PLAYER'S feet, so closing the
	// palette would gain nothing and cost the popout you set it from. Same
	// posture as hdQuestSetStage, which has fired Papyrus from inside the open
	// palette since v0.4.0.
	//
	// TWO replies per op, because the Papyrus call is asynchronous: `phase:
	// "sent"` the moment the stack is queued (or `"refused"` if MhiyhControl
	// turned it down without dispatching), then `phase: "done"` carrying MHiYH's
	// own Bool. The second one also re-pushes fdNff, so the day stepper repaints
	// itself with whatever the mod actually did rather than what we hoped.
	void OnJsFolMhiyh(const char* data)
	{
		const std::string cmd = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([cmd]() {
			const auto pre = MhiyhControl::Apply(cmd, [](const std::string& res) {
				// Already back on the main thread — MhiyhControl hops for us.
				PushToView("fdMhiyhResult", res);
				const auto fo = FollowerDeck::StateJson();
				PushFollowerNff(fo);
			});
			PushToView("fdMhiyhResult", pre);
		});
	}

	// CHIM button — parse { formId, name } from the view. formId may arrive as a
	// JSON number or a "0x…"/decimal string; be tolerant of both.
	std::uint32_t ChParseFormId(const json& j)
	{
		try {
			if (j.contains("formId")) {
				const auto& v = j.at("formId");
				if (v.is_number_unsigned())
					return v.get<std::uint32_t>();
				if (v.is_number_integer())
					return static_cast<std::uint32_t>(v.get<std::int64_t>());
				if (v.is_string()) {
					const auto s = v.get<std::string>();
					if (!s.empty())
						return static_cast<std::uint32_t>(std::stoul(s, nullptr, 0));
				}
			}
		} catch (...) {}
		return 0;
	}

	// chState: read whether the NPC is currently a CHIM agent -> chStateResult.
	void OnJsChState(const char* data)
	{
		const std::string in = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([in]() {
			std::uint32_t fid = 0;
			std::string   name;
			try {
				const auto j = json::parse(in);
				fid = ChParseFormId(j);
				name = j.value("name", "");
			} catch (...) {}
			ChimControl::QueryActive(fid, name, [fid, name](bool active, bool ok) {
				PushToView("chStateResult",
					json{ { "formId", fid }, { "name", name },
						{ "active", active }, { "ok", ok } }
						.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			});
		});
	}

	// chSet: activate/deactivate CHIM AI, then reconcile the label from the
	// mod's own agent set. The optimistic push makes the button feel instant;
	// the reconcile push corrects it if the toggle was refused.
	void OnJsChSet(const char* data)
	{
		const std::string in = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([in]() {
			std::uint32_t fid = 0;
			std::string   name;
			bool          on = true;
			try {
				const auto j = json::parse(in);
				fid = ChParseFormId(j);
				name = j.value("name", "");
				on = j.value("on", true);
			} catch (...) {}
			const bool sent = ChimControl::SetActive(fid, name, on);
			// Optimistic: if we dispatched, assume the requested state.
			PushToView("chStateResult",
				json{ { "formId", fid }, { "name", name },
					{ "active", sent ? on : false }, { "ok", sent } }
					.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			// Reconcile from CHIM's own agent set (getAgentByName).
			ChimControl::QueryActive(fid, name, [fid, name](bool active, bool ok) {
				if (!ok)
					return;   // keep the optimistic value
				PushToView("chStateResult",
					json{ { "formId", fid }, { "name", name },
						{ "active", active }, { "ok", true } }
						.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			});
		});
	}

	// fdNpc: quick recruit / dismiss / open-inventory against ONE actor —
	//
	// NAMING: the request listener is `fdNpc`, the reply is pushed as
	// `fdNpcResult`. They MUST differ — PrismaUI installs every registered
	// listener as a JS global of that name, so reusing one name means the
	// view's `toGame('fdNpc', …)` resolves to the view's OWN receiver and the
	// call never reaches C++ at all. Same rule as hdIconList -> hdIcons.
	// either a roster member the pane named, or (with no formId) whoever was
	// under the crosshair when the palette opened.
	//
	// Two phases like fdMhiyh, for the same reason: the Papyrus call is
	// asynchronous, so `phase:"sent"` goes back the moment the stack is queued
	// and `phase:"done"` carries what actually happened. A `phase:"refused"`
	// is final and never gets a second reply.
	//
	// The palette-closing rule differs PER OP, which is why this is not shaped
	// like fdWorld:
	//   * recruit / dismiss — the palette STAYS OPEN (like fdMhiyh). Recruiting
	//     is administrative; closing the deck to do it would cost you the tab
	//     you were working in, and NFF's own notification is the feedback.
	//   * inventory / storage — the palette MUST close first. The ContainerMenu
	//     cannot open while PrismaUI owns input focus, and it does NOT reopen
	//     after: you are now standing in that container, and popping the deck
	//     back over it is exactly the overlap this project treats as a bug.
	//     BOTH container ops, not just the first — see the closing test below.
	// ------------------------------------------------------- Gear Toggle --
	// fdGear: the Followers card's "hide worn gear" toggles, riding Gear
	// Toggle's in-process C API. Both ops BLOCK on the game thread inside the
	// engine, so they leave the deck thread first — worker out, task back in.
	void OnJsFolGear(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("fdGear: bad payload");
			return;
		}
		const std::string op = j.value("op", "");
		const std::uint32_t formId = j.value("formId", 0u);
		if (!formId) {
			PushToView("fdGearResult", R"({"ok":false,"error":"no one to hide gear on"})");
			return;
		}
		char hex[16];
		std::snprintf(hex, sizeof(hex), "%08X", formId);

		json body;
		body["formId"] = hex;
		std::string path;
		if (op == "toggle") {
			body["group"] = j.value("group", "");
			path = "/toggle";
			logger::info("gear-toggle: {} {}", hex, body["group"].get<std::string>());
		} else {
			path = "/state";
		}
		std::thread([path, payload = body.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)]() {
			const std::string res = GearBridge::Call("POST", path, payload);
			if (auto* tasks = SKSE::GetTaskInterface())
				tasks->AddTask([res]() { PushToView("fdGearResult", res); });
		}).detach();
	}

	// ------------------------------------------------------ Preset Director --
	// fdPreset: the Followers tab's preset tools, riding Preset Director's
	// in-process C API (preset_bridge.cpp). GET routes (/presets, /registry)
	// are pure file/memory reads inside PD and safe to call inline; the POST
	// routes (apply/spawn) BLOCK their calling thread on an SKSE task, so they
	// leave the game thread first — worker thread out, task back in — or the
	// palette would deadlock itself into PD's 8s leash.
	std::filesystem::path PresetIconsDir() { return DeckViewDir() / "preset-icons"; }

	json PresetAssignments()
	{
		json          m = json::object();
		std::ifstream in(PresetIconsDir() / "assign.json");
		if (in) {
			json j = json::parse(in, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				m = std::move(j);
		}
		return m;
	}

	// Favorites + categories for the Faces tab. One file beside assign.json:
	// { "fav":[names], "cats":[names], "catOf":{preset:cat} }. PrismaUI can't
	// write, so C++ owns it — same pattern as assign.json.
	std::filesystem::path PresetMetaPath() { return PresetIconsDir() / "meta.json"; }

	json PresetMeta()
	{
		json m;
		std::ifstream in(PresetMetaPath());
		if (in) {
			json j = json::parse(in, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				m = std::move(j);
		}
		if (!m.contains("fav") || !m["fav"].is_array())
			m["fav"] = json::array();
		if (!m.contains("cats") || !m["cats"].is_array())
			m["cats"] = json::array();
		if (!m.contains("catOf") || !m["catOf"].is_object())
			m["catOf"] = json::object();
		return m;
	}

	void WritePresetMeta(const json& m)
	{
		std::error_code ec;
		std::filesystem::create_directories(PresetIconsDir(), ec);
		std::ofstream out(PresetMetaPath(), std::ios::trunc);
		if (out)
			out << m.dump(2);
	}

	std::string PresetIndexJson()
	{
		json out;
		out["ok"] = true;
		out["available"] = PresetBridge::Available();
		json presets = json::parse(PresetBridge::Call("GET", "/presets", ""), nullptr, false);
		json registry = json::parse(PresetBridge::Call("GET", "/registry", ""), nullptr, false);
		out["presets"] = presets.is_discarded() ? json::object() : presets;
		out["registry"] = registry.is_discarded() ? json::object() : registry;
		// Icon files living in the view's own folder (like portraits/), so the
		// tiles are plain relative URLs the webview can already reach.
		json            icons = json::array();
		std::error_code ec;
		const auto      dir = PresetIconsDir();
		std::filesystem::create_directories(dir, ec);
		for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
			if (!it->is_regular_file(ec))
				continue;
			auto ext = it->path().extension().string();
			for (auto& c : ext)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp")
				icons.push_back(it->path().filename().string());
		}
		out["icons"] = icons;
		out["assign"] = PresetAssignments();
		const json meta = PresetMeta();
		out["fav"] = meta["fav"];
		out["cats"] = meta["cats"];
		out["catOf"] = meta["catOf"];
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void OnJsFolPreset(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("fdPreset: bad payload");
			return;
		}
		const std::string op = j.value("op", "");

		if (op == "index") {
			logger::info("PresetDeck: index requested");
			const std::string idx = PresetIndexJson();
			PushToView("fdPresetData", idx);
			// Mirror the catalogue to disk so the Deck Portal can browse presets
			// with the game closed — the .jslot files are scattered across mod
			// folders and only PD's VFS view sees them all. faces-preset-deck-catalogue.
			std::error_code ec;
			std::ofstream   cat(DeckViewDir() / "faces-catalogue.json", std::ios::trunc);
			if (cat)
				cat << idx;
			return;
		}

		if (op == "img") {
			// Assign (or clear) an icon file for a preset name — deck-side
			// file IO only, PD never hears about images.
			const std::string preset = j.value("preset", "");
			const std::string icon = j.value("icon", "");
			if (preset.empty())
				return;
			json m = PresetAssignments();
			if (icon.empty())
				m.erase(preset);
			else
				m[preset] = icon;
			std::error_code ec;
			std::filesystem::create_directories(PresetIconsDir(), ec);
			std::ofstream outF(PresetIconsDir() / "assign.json", std::ios::trunc);
			if (outF)
				outF << m.dump(2);
			PushToView("fdPresetData", PresetIndexJson());
			return;
		}

		// ---- Faces favorites + categories (faces-meta) ----
		if (op == "fav") {
			const std::string preset = j.value("preset", "");
			const bool        on = j.value("on", true);
			if (preset.empty())
				return;
			json m = PresetMeta();
			json arr = json::array();
			bool present = false;
			for (auto& e : m["fav"]) {
				if (e.is_string() && e.get<std::string>() == preset) { present = true; continue; }  // drop dups / the one we toggle off
				arr.push_back(e);
			}
			if (on && !present)
				arr.push_back(preset);
			m["fav"] = arr;
			WritePresetMeta(m);
			PushToView("fdPresetData", PresetIndexJson());
			return;
		}
		if (op == "cat-new" || op == "cat-del" || op == "cat-rename") {
			json m = PresetMeta();
			if (op == "cat-new") {
				const std::string name = j.value("name", "");
				bool have = false;
				for (auto& c : m["cats"]) if (c.is_string() && c.get<std::string>() == name) have = true;
				if (!name.empty() && !have)
					m["cats"].push_back(name);
			} else if (op == "cat-del") {
				const std::string name = j.value("name", "");
				json keep = json::array();
				for (auto& c : m["cats"]) if (!(c.is_string() && c.get<std::string>() == name)) keep.push_back(c);
				m["cats"] = keep;
				// unfile every preset that pointed at it
				json catOf = json::object();
				for (auto& [k, v] : m["catOf"].items())
					if (!(v.is_string() && v.get<std::string>() == name)) catOf[k] = v;
				m["catOf"] = catOf;
			} else {  // cat-rename
				const std::string from = j.value("from", ""), to = j.value("to", "");
				if (!from.empty() && !to.empty()) {
					json cats = json::array();
					for (auto& c : m["cats"]) cats.push_back((c.is_string() && c.get<std::string>() == from) ? json(to) : c);
					m["cats"] = cats;
					for (auto& [k, v] : m["catOf"].items())
						if (v.is_string() && v.get<std::string>() == from) m["catOf"][k] = to;
				}
			}
			WritePresetMeta(m);
			PushToView("fdPresetData", PresetIndexJson());
			return;
		}
		if (op == "cat-set") {
			const std::string preset = j.value("preset", "");
			const std::string cat = j.value("cat", "");
			if (preset.empty())
				return;
			json m = PresetMeta();
			if (cat.empty())
				m["catOf"].erase(preset);
			else
				m["catOf"][preset] = cat;
			WritePresetMeta(m);
			PushToView("fdPresetData", PresetIndexJson());
			return;
		}

		if (op == "saveplayer") {
			// Back the player's current face up (Faces tab "try on me" revert).
			const std::string name = j.value("name", "PD_MyFaceBackup");
			std::thread([name]() {
				json body;
				body["name"] = name;
				const std::string res = PresetBridge::Call("POST", "/save-player", body.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				if (auto* tasks = SKSE::GetTaskInterface())
					tasks->AddTask([res]() { PushToView("fdPresetResult", res); });
			}).detach();
			return;
		}

		if (op == "apply" || op == "spawn") {
			json body;
			// Face shape + morphs only by default: flags 15's SkinOverrides
			// half painted the first live test target BLUE (textures her body
			// doesn't have). "full" is the caller's explicit opt-in.
			body["flags"] = j.value("flags", 3);
			body["preset"] = j.value("preset", "");
			std::string path;
			if (op == "apply") {
				const std::uint32_t formId = j.value("formId", 0u);
				if (!formId || body["preset"].get<std::string>().empty()) {
					PushToView("fdPresetResult", R"({"ok":false,"error":"need a person and a preset"})");
					return;
				}
				char hex[16];
				std::snprintf(hex, sizeof(hex), "%08X", formId);
				body["ref"] = hex;
				path = "/apply";
			} else {
				body["base"] = j.value("base", "2004C26");  // Traveling Pilgrim, the proven donor
				body["name"] = j.value("name", "");
				path = "/spawn";
			}
			std::thread([path, payload = body.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)]() {
				const std::string res = PresetBridge::Call("POST", path, payload);
				if (auto* tasks = SKSE::GetTaskInterface())
					tasks->AddTask([res]() { PushToView("fdPresetResult", res); });
			}).detach();
			return;
		}

		logger::warn("fdPreset: unknown op {}", op);
	}

	void OnJsFolNpc(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("fdNpc: bad payload");
			return;
		}
		const std::string cmd     = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		// Both container ops hand the focus to a menu the deck must not be
		// sitting on top of. "storage" was missed when it was added — the spare
		// inventory opened UNDER the palette, which is the overlap this project
		// treats as a bug (Rober, 2026-08-03).
		const auto        npcOp  = j.value("op", std::string(""));
		const bool        closing = (npcOp == "inventory" || npcOp == "storage");

		SKSE::GetTaskInterface()->AddTask([cmd, closing]() {
			if (closing)
				ClosePalette();  // the container menu needs the focus back

			const auto pre = NffControl::Apply(cmd, [](const std::string& res) {
				// Already on the main thread — NffControl hops for us.
				PushToView("fdNpcResult", res);
				// A recruit changes the roster's "following" state, so re-push
				// the things that render it rather than leaving a stale badge.
				const auto fo = FollowerDeck::StateJson();
				PushToView("fdState", fo);
				PushFollowerNff(fo);
				const auto jr = json::parse(res, nullptr, false);
				if (!jr.is_discarded()) {
					const auto msg = jr.value("msg", std::string(""));
					if (!msg.empty())
						RE::DebugNotification(msg.c_str());
				}
			});

			PushToView("fdNpcResult", pre);

			// A refusal never reaches the callback above, so say it here or it
			// is said nowhere — the palette may already be shut.
			const auto jp = json::parse(pre, nullptr, false);
			if (!jp.is_discarded() && !jp.value("ok", false)) {
				const auto msg = jp.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
		});
	}

	// F7 card 🔍 Debug: build the raw dossier (flags, factions, frameworks,
	// aliases, package) for the card's subject — or the crosshair snapshot
	// when the payload names nobody — and push it back as fdDebugInfo.
	void OnJsFolDebug(const char* data)
	{
		const auto j = json::parse(data ? data : "{}", nullptr, false);
		std::uint32_t id = 0;
		if (!j.is_discarded() && j.is_object()) {
			const auto s = j.value("formId", std::string(""));
			if (!s.empty()) {
				try {
					id = static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
				} catch (...) {}
			}
		}
		SKSE::GetTaskInterface()->AddTask([id]() {
			const auto use = id ? id : NpcActions::TargetFormID();
			PushToView("fdDebugInfo", NpcActions::DebugJson(use));
		});
	}

	// Formation with Followers — the F7 card's centered modal. fmGet is a pure
	// read; the three mutations reply on fmResult and then push a FRESH fmOpen
	// after a beat, because the apply step is a fire-and-forget Papyrus
	// dispatch (EvaluateAllFormation & co.) and the re-read is what shows the
	// truth — a failed hop shows up as the control springing back, the same
	// contract nfSetGear settled on.
	void OnJsFmGet(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("fmOpen", FormationActions::StateJson(req));
		});
	}

	namespace
	{
		void FmMutate(const char* data, std::string (*fn)(const std::string&))
		{
			const std::string req = data ? data : "{}";
			SKSE::GetTaskInterface()->AddTask([req, fn]() {
				PushToView("fmResult", fn(req));
				std::thread([req]() {
					std::this_thread::sleep_for(std::chrono::milliseconds(700));
					SKSE::GetTaskInterface()->AddTask([req]() {
						PushToView("fmOpen", FormationActions::StateJson(req));
					});
				}).detach();
			});
		}
	}

	void OnJsFmApply(const char* data)
	{
		FmMutate(data, [](const std::string& r) { return FormationActions::Apply(r); });
	}

	void OnJsFmReg(const char* data)
	{
		FmMutate(data, [](const std::string& r) { return FormationActions::Reg(r); });
	}

	void OnJsFmRescue(const char* data)
	{
		FmMutate(data, [](const std::string& r) {
			(void)r;
			return FormationActions::Rescue();
		});
	}

	/* ---- Domains tab: NFF home bases -----------------------------------
	 *  Same shape as the Formation modal above, and for the same reason: the
	 *  mutations are NFF's OWN Papyrus functions, dispatched onto the VM's
	 *  thread, so reading the state back in the same frame would show the
	 *  world before the change. The immediate nbResult carries the sentence
	 *  ("Base removed", or why it was refused) and a second nbOpen follows
	 *  once Papyrus has actually landed it.
	 *
	 *  `visit` is the exception in the view, not here: it closes the palette
	 *  itself before sending, exactly like the Domains recall does, so the
	 *  teleport is not fired at a paused game with a menu open.
	 */
	/* ---- Deck Portal button --------------------------------------------
	 *  The portal's server is started at kDataLoaded and dies with the game
	 *  through its Job Object — there is deliberately no shutdown hook, because
	 *  a hook only runs on a CLEAN exit and the crash case is the one that
	 *  strands a node process holding the port. The OS closing our handles is
	 *  the guarantee.
	 *
	 *  Both run on the main thread: ShellExecute and the WinHTTP liveness probe
	 *  are short, and the palette is paused while the button is pressed.
	 */
	void OnJsPtGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("ptState", PortalHost::StateJson());
		});
	}

	void OnJsPtOpen(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("ptState", PortalHost::Open());
		});
	}

	void OnJsNbGet(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nbOpen", NffBases::StateJson(req));
		});
	}

	void OnJsNbOp(const char* data)
	{
		const std::string req = data ? data : "{}";
		const auto        j = json::parse(req, nullptr, false);
		const bool        isVisit = !j.is_discarded() && j.is_object() && j.value("op", std::string()) == "visit";

		// Travel is the one op that must not run under an open palette — the
		// same rule the Domains recall follows: close first, teleport, then
		// come back on this tab if the deck is set to stay open. A reply
		// pushed after ClosePalette would go nowhere (PushToView is gated on
		// the view being open), so the outcome is an on-screen notification.
		if (isVisit) {
			bool reopen;
			{
				std::lock_guard l(g_configMutex);
				reopen = !g_config.settings.closeAfterFire;
			}
			SKSE::GetTaskInterface()->AddTask([req, reopen]() {
				ClosePalette();
				const auto  res = json::parse(NffBases::Apply(req), nullptr, false);
				std::string msg = res.is_discarded() ? std::string() : res.value("msg", std::string());
				if (msg.empty())
					msg = "Bases: travel failed - see HotkeyDeck.log";
				RE::DebugNotification(msg.c_str());
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow()) {
							g_pendingTab = "domains";  // land back on the tab
							OpenPalette();
						}
					});
			});
			return;
		}

		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nbResult", NffBases::Apply(req));
			std::thread([req]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(700));
				SKSE::GetTaskInterface()->AddTask([req]() {
					PushToView("nbOpen", NffBases::StateJson(req));
				});
			}).detach();
		});
	}

	// fdEquipped: everything an actor currently has ON, read off the engine.
	// Request `fdEquipped`, reply pushed as `fdWorn` — disjoint, see fdNpc above.
	// A pure read — no palette juggling, no Papyrus. See nff_control.h for why
	// this exists alongside the container menu rather than trusting it.
	void OnJsFolEquipped(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const std::string worn = NffControl::EquippedJson(req);
			PushToView("fdWorn", worn);
			// The quick card draws each worn piece as its rendered mesh. Two
			// things make that true without a Wardrobe-tab visit: queue a
			// render for any piece with no PNG yet (her own gear is almost
			// never in the wardrobe exports EnsureIcons walks), and hand the
			// view the index — on a fresh session it has never been pushed.
			// The view's receiver is change-gated, so this repeats safely.
			ItemIcons::EnsureIconsForWorn(worn);
			PushToView("wdItemIcons", ItemIcons::IndexJson());
		});
	}

	// fdItemSpin: the worn-item lightbox was dragged, so bake that piece's
	// turntable (7 angle frames). One subject, on demand — never bulk. No
	// reply: the view derives the -a045.png … sibling URLs from the frame-0
	// URL and probes for them as the DLL writes them (the Dragon Roost pattern).
	void OnJsItemSpin(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const std::string fid    = j.value("formId", std::string());
			const std::string plugin = j.value("plugin", std::string());
			ItemIcons::CaptureAngles(fid, plugin);
		});
	}

	// fdTune: the follower controls that write to the ACTOR rather than to a
	// framework — essential/protected, base health, and spells you share out of
	// your own book. Every one of them is REMEMBERED (config slice "tuning")
	// and re-applied on load, because a leveled actor recalculates her values,
	// a framework re-applies its template, and a cell reset rebuilds her from
	// her base record. See follower_tune.h for why that is the whole design.
	//
	// One reply name, fdTuneInfo, for every op including the plain read; the
	// payload always carries the LIVE engine state beside what is remembered,
	// so the card can show the two disagreeing instead of asserting a promise.
	void OnJsFolTune(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				PushToView("fdTuneInfo", json{ { "ok", false }, { "msg", "Bad request" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				return;
			}
			/* The spellbook is asked for by its own op rather than riding on
			   every reply: it is ~100 rows and the card only needs it when the
			   picker actually opens. */
			const auto askOp = j.value("op", std::string(""));
			if (askOp == "spells") {
				PushToView("fdTuneInfo", json{
					{ "ok", true }, { "op", "spells" },
					{ "spells", FollowerTune::PlayerSpellsJson() } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				return;
			}
			/* The perk catalogue is the whole load order's worth (~700 vanilla,
			   more with mods), so like the spellbook it is fetched only when the
			   picker actually opens. */
			if (askOp == "perks") {
				PushToView("fdTuneInfo", json{
					{ "ok", true }, { "op", "perks" },
					{ "perks", FollowerTune::AllPerksJson() } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				return;
			}
			json reply;
			bool changed = false;
			{
				std::lock_guard l(g_configMutex);
				reply = FollowerTune::Apply(g_tuneConfig, j, changed);
			}
			if (changed)
				PersistAll();
			reply["op"] = j.value("op", std::string(""));
			/* Echo the id the VIEW asked with. The reply's own `formId` is the
			   DURABLE local one, which is a different string from the runtime id
			   the card holds — a cache keyed on the reply would never be found
			   again. */
			reply["reqId"] = j.value("formId", std::string(""));
			PushToView("fdTuneInfo", reply.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
		});
	}

	// fdRank: read — or change — the player's RELA relationship rank with an
	// actor. Request `fdRank`, reply pushed as `fdRankInfo`; disjoint names, or
	// toGame() would fire the view's own receiver instead of reaching C++
	// (see the fdNpc comment above — this has cost us four features).
	//
	// The WRITE goes through the Papyrus VM and is therefore asynchronous, so
	// the reply cannot be the new truth; the view re-asks a beat later. Both
	// halves need the main thread — the VM dispatch and the engine lookup.
	void OnJsFolRank(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("fdRankInfo", Relationship::Handle(req));
		});
	}

	// hdHistory: the Recent tab wants the list. Pushed back as `hdRecent` —
	// the names must differ, see the fdNpc comment above.
	void OnJsHistory(const char*)
	{
		PushToView("hdRecent", HotkeyHistory::Json());
	}

	void OnJsHistoryClear(const char*)
	{
		HotkeyHistory::Clear();
		PushToView("hdRecent", HotkeyHistory::Json());
	}

	// fdRefresh: the pane became visible and wants a fresh snapshot.
	void OnJsFolRefresh(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			// Anything the phone queued lands BEFORE the snapshot is taken, so the
			// pane paints the new values on this open rather than the next one.
			// Belt and braces since v0.11.0: PortalPollLoop() normally applies the
			// sidecar within a second of the phone tap (and re-pushes fdState), but
			// this path still covers a queue that landed while no save was loaded.
			ApplyPortalNpcFields();
			// Same belt-and-braces for the phone's queued category MOVE/RENAME ops:
			// the poller normally eats portal-fo-ops.json within a second, this
			// covers a queue that landed with no save loaded. Runs BEFORE the
			// roster build so the moved/renamed slot paints on this open.
			ApplyPortalFollowerOps();
			// And the phone's queued PORTRAITS, for the same reason and with the same
			// timing: it runs BEFORE FolPortraitsJson() below, so a face uploaded or
			// cropped on the phone paints on THIS open of the tab. Before this, the
			// queue was drained only at palette open — so a portrait made while the
			// deck was already up stayed invisible in game until the next F7, which
			// is exactly the "it shows in the web app but not in game" report.
			ApplyPortalPortraits();
			// One FO state build, used twice: the roster itself and the NFF/MHiYH
			// lookup keyed off its formIds.
			const auto fo = FollowerDeck::StateJson();
			// …and a third time, for the phone's queued day changes. Same
			// belt-and-braces as the fields above: the poller normally eats this
			// sidecar within a second, this covers a queue that landed with no
			// save loaded. It runs AFTER the roster build because it needs the
			// name -> formId map. The dispatch is asynchronous, so the pushes
			// below still show the PRE-change day; PortalMhiyhDone() repaints
			// when MHiYH answers, exactly as an in-deck click does.
			MhiyhControl::ApplyPortal(DeckViewDir(), fo, PortalMhiyhDone);
			PushToView("fdState", fo);
			PushToView("fdTarget", FolTargetJson());
			PushToView("fdPortraits", FolPortraitsJson());
			// The crop map rides the same rail as the portrait listing: a face drawn
			// before its crop lands would pop to the new framing a frame later, which
			// reads as a glitch rather than as a setting.
			PushToView("fdCrops", FolCropsJson());
			PushFollowerNff(fo);
			PushToView("fdFertility", FertilityBridge::StateJson(fo));
		});
	}

	// fdFraming: the adjust panel opened and wants the current numbers.
	// Reads capture.ini every time rather than caching: the portal and a text
	// editor both write the same file, and a stale panel would quietly undo
	// their edit the next time you nudged anything here.
	void OnJsFolFraming(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { FramingReply(); });
	}

	// The actual read + push, on the main thread. Split out because
	// OnJsFolSetFraming wants to reuse it for its echo without re-entering the
	// listener (and without posting a second task from inside one).
	void FramingReply()
	{
		const auto f = PortraitCapture::GetFraming(DeckViewDir());
		const auto d = PortraitCapture::DefaultFraming();
		// .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) is NOT optional: PushToView takes a std::string, and nlohmann's
		// implicit conversion operator makes `json{...}` COMPILE here and then
		// throw type_error.302 ("type must be string, but is object") at runtime.
		// Unhandled inside a PrismaUI JS callback, that is a hard CTD — which is
		// exactly what shipping this without the dump did on 2026-08-02
		// (KERNELBASE RaiseException <- VCRUNTIME140 <- HotkeyDeck.dll, called
		// from PrismaUI API.cpp's callback dispatch).
		PushToView("fdFramingInfo", json{
			{ "ok", true },
			{ "zoom", f.zoom }, { "offsetX", f.offsetX }, { "offsetY", f.offsetY },
			// Shipped defaults travel WITH the values so the view's Reset and the
			// plugin's idea of "default" cannot drift into two different numbers.
			{ "defZoom", d.zoom }, { "defOffsetX", d.offsetX }, { "defOffsetY", d.offsetY },
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
	}

	// fdSetFraming: {zoom, offsetX, offsetY} -> capture.ini, then echo back what
	// actually landed. The echo matters: the values are CLAMPED on the way in, so
	// the panel must show what was stored rather than what it asked for.
	void OnJsFolSetFraming(const char* data)
	{
		if (!data)
			return;
		const std::string raw = data;   // copied: the callback's buffer is not ours to keep
		SKSE::GetTaskInterface()->AddTask([raw]() { ApplyFraming(raw); });
	}

	void ApplyFraming(const std::string& raw)
	{
		const auto j = json::parse(raw, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const auto dir = DeckViewDir();
		auto       f = PortraitCapture::GetFraming(dir);   // partial updates are fine
		if (j.contains("zoom") && j["zoom"].is_number())
			f.zoom = j["zoom"].get<float>();
		if (j.contains("offsetX") && j["offsetX"].is_number())
			f.offsetX = j["offsetX"].get<float>();
		if (j.contains("offsetY") && j["offsetY"].is_number())
			f.offsetY = j["offsetY"].get<float>();
		PortraitCapture::SetFraming(dir, f);
		FramingReply();   // one source of truth for the reply shape; already on the main thread
	}

	// ------------------------------------------------ portrait display crops
	// The filenames actually sitting in portraits/ right now. Only ever used to
	// PRUNE — folded to lower case because Windows compares names that way and
	// a crop keyed `Ysolda.PNG` must recognise `ysolda.png` on disk as its file.
	std::set<std::string> PortraitFilesOnDisk()
	{
		std::set<std::string> live;
		std::error_code       ec;
		const auto            dir = DeckViewDir() / "portraits";
		for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
			std::error_code fec;
			if (!it->is_regular_file(fec))
				continue;
			auto name = it->path().filename().string();
			std::transform(name.begin(), name.end(), name.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			live.insert(std::move(name));
		}
		return live;
	}

	// Drop crops whose photo has left the folder, so the map cannot grow for the
	// life of the save. Called on every crop save (the only thing that grows it)
	// and once when the view first comes up. Caller holds no lock; this takes it.
	//
	// DELIBERATELY A NO-OP WHEN THE FOLDER READS EMPTY. An unreadable directory
	// (mid-MO2 VFS teardown, a drive hiccup) is indistinguishable from a folder
	// someone really emptied, and one of those two readings silently deletes
	// every crop the player ever set. Losing a prune costs nothing; the next
	// save does it.
	bool PrunePortraitCrops()
	{
		const auto live = PortraitFilesOnDisk();
		if (live.empty())
			return false;
		std::size_t dropped = 0;
		{
			std::lock_guard l(g_configMutex);
			for (auto it = g_folConfig.portraitCrops.begin(); it != g_folConfig.portraitCrops.end();) {
				auto name = it->first;
				std::transform(name.begin(), name.end(), name.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (live.count(name)) {
					++it;
				} else {
					it = g_folConfig.portraitCrops.erase(it);
					++dropped;
				}
			}
		}
		if (dropped)
			logger::info("portrait crops pruned: {} whose photo is gone", dropped);
		return dropped > 0;
	}

	std::string FolCropsJson()
	{
		json crops = json::object();
		{
			std::lock_guard l(g_configMutex);
			for (const auto& [file, c] : g_folConfig.portraitCrops)
				crops[file] = json{ { "z", c.z }, { "x", c.x }, { "y", c.y } };
		}
		// .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), never the json itself: PushToView takes a std::string and
		// nlohmann's implicit conversion COMPILES and then throws type_error.302
		// at runtime — which inside a PrismaUI callback is a hard CTD.
		return crops.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ============================================================ Followers HUD
	// The always-on portrait strip (view/HotkeyDeck/hud.html). The data feed here
	// reuses the roster's own portrait scan (FolPortraitsJson) + crop map
	// (FolCropsJson), keyed by SlugOfName of the teammate's display name so a
	// captured face lands on the HUD exactly as it does in the roster; anyone with
	// no match keeps the initials medallion the view draws. Marker for the deploy
	// check: "followers-hud".

	// Placement + settings, mirrored into the view via window.hudConfig.
	std::string HudConfigJson()
	{
		std::lock_guard l(g_configMutex);
		const auto& c = g_hudConfig;
		return json{
			{ "x", c.x }, { "y", c.y }, { "scale", c.scale },
			{ "orient", c.orient == "vert" ? "vert" : "horiz" },
			{ "anchorH", c.anchorH == "right" ? "right" : "left" },
			{ "anchorV", c.anchorV == "bottom" ? "bottom" : "top" },
			{ "visible", c.enabled && c.visible },
			{ "showNames", c.showNames },
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// The compact state the DECK control renders (a card in the Followers tab).
	std::string HudDeckStateJson()
	{
		std::lock_guard l(g_configMutex);
		const auto& c = g_hudConfig;
		return json{
			{ "enabled", c.enabled },
			{ "visible", c.visible },
			{ "orient", c.orient == "vert" ? "vert" : "horiz" },
			{ "anchorH", c.anchorH == "right" ? "right" : "left" },
			{ "anchorV", c.anchorV == "bottom" ? "bottom" : "top" },
			{ "showNames", c.showNames },
			{ "arming", g_hudKeyArming.load() },
			{ "key", json{ { "device", c.keyDevice }, { "code", c.keyCode }, { "label", c.keyLabel } } },
		}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// Build the live follower list. MAIN THREAD ONLY (touches loaded actors).
	std::string HudFollowersJson()
	{
		int  maxFaces = 12;
		bool includeDead = true;
		{
			std::lock_guard l(g_configMutex);
			maxFaces = g_hudConfig.maxFaces;
			includeDead = g_hudConfig.includeDead;
		}

		// file -> {z,x,y}, parsed from the same helper the roster uses (a bad parse
		// just means no crops this pass).
		json crops     = json::parse(FolCropsJson(), nullptr, false);

		// slug -> {file,ext,mtime}. FolPortraitsJson() returns an ARRAY of
		// {slug,file,ext,mtime} — the shape the roster's JS iterates — so fold it
		// into a slug-keyed object here. (The old code parsed it and treated the
		// value AS an object: `portraits.is_object()` was false for an array, so
		// attachPortrait matched ZERO faces and every HUD chip fell back to
		// initials — the "with-portrait=0" bug, marker: hud-portrait-index-fix.)
		json portraits = json::object();
		{
			json parr = json::parse(FolPortraitsJson(), nullptr, false);
			if (parr.is_array()) {
				for (auto& p : parr) {
					if (p.is_object() && p.contains("slug") && p["slug"].is_string())
						portraits[p["slug"].get<std::string>()] = p;
				}
			}
		}

		// formId -> ORIGINAL name from the FO roster. The deck roster keys portraits
		// on m.original (portraitFor -> slugOf(m.original)), so a follower renamed in
		// FO/CHIM keeps her portrait under her ORIGINAL name. The HUD's
		// GetDisplayFullName() is the RENAMED name and therefore misses — this is why
		// the roster showed faces but the widget did not. Match the roster: prefer the
		// FO original, then the base (née) name, then the display name.
		std::map<RE::FormID, std::string> foOriginal;
		{
			auto st = json::parse(FollowerDeck::StateJson(), nullptr, false);
			const json* cats = nullptr;
			if (st.is_object()) {
				if (st.contains("categories") && st["categories"].is_array())
					cats = &st["categories"];
				else if (st.contains("state") && st["state"].is_object() &&
						 st["state"].contains("categories") && st["state"]["categories"].is_array())
					cats = &st["state"]["categories"];
			}
			if (cats) {
				for (const auto& c : *cats) {
					if (!c.is_object() || !c.contains("members") || !c["members"].is_array())
						continue;
					for (const auto& m : c["members"]) {
						if (!m.is_object())
							continue;
						std::string orig = m.value("original", m.value("name", std::string()));
						if (orig.empty())
							continue;
						RE::FormID fid = 0;
						if (m.contains("formId")) {
							const auto& f = m["formId"];
							if (f.is_number_unsigned())
								fid = f.get<RE::FormID>();
							else if (f.is_number_integer())
								fid = static_cast<RE::FormID>(f.get<std::int64_t>());
							else if (f.is_string()) {
								try { fid = static_cast<RE::FormID>(std::stoul(f.get<std::string>(), nullptr, 16)); }
								catch (...) {}
							}
						}
						if (fid)
							foOriginal.emplace(fid, orig);
					}
				}
			}
		}

		// Resolve a portrait row from the first candidate name that has a file.
		auto attachPortrait = [&](json& row, const std::vector<std::string>& names) -> bool {
			for (const auto& nm : names) {
				if (nm.empty())
					continue;
				const std::string slug = PortraitCapture::SlugOfName(nm);
				if (slug.empty() || !portraits.is_object() || !portraits.contains(slug) || !portraits[slug].is_object())
					continue;
				const auto& p = portraits[slug];
				const std::string file = p.value("file", std::string());
				if (file.empty())
					continue;
				row["file"] = file;
				row["ext"] = p.value("ext", std::string());
				row["mtime"] = p.value("mtime", (std::uint64_t)0);
				if (crops.is_object() && crops.contains(file) && crops[file].is_object())
					row["crop"] = crops[file];
				return true;
			}
			return false;
		};

		// The vanilla "CurrentFollowerFaction" (Skyrim.esm 0x0005C84E). Custom
		// follower mods (Amaniri's Nether's Niri, Vayne's CSV, CHIM's soft-follow)
		// often drive following through alias PACKAGES and never set the vanilla
		// teammate flag — but most still add the actor to this faction for
		// compatibility. Matching it as well as IsPlayerTeammate is what makes the
		// HUD populate for framework-driven companions. Resolved once, null-guarded.
		static RE::TESFaction* s_followerFac = nullptr;
		static bool            s_facTried = false;
		if (!s_facTried) {
			s_facTried = true;
			s_followerFac = RE::TESForm::LookupByID<RE::TESFaction>(0x0005C84E);
		}

		int nTeam = 0, nFac = 0, nMatched = 0;

		json arr = json::array();
		auto* lists = RE::ProcessLists::GetSingleton();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (lists) {
			std::unordered_set<RE::FormID> seen;
			for (auto& h : lists->highActorHandles) {
				auto ptr = h.get();
				RE::Actor* a = ptr ? ptr.get() : nullptr;
				if (!a || a == player || a->IsPlayerRef())
					continue;
				const bool team = a->IsPlayerTeammate();
				const bool fac = s_followerFac && a->IsInFaction(s_followerFac);
				if (!team && !fac)
					continue;
				const bool dead = a->IsDead();
				if (dead && !includeDead)
					continue;
				const RE::FormID id = a->GetFormID();
				if (!seen.insert(id).second)
					continue;
				if (team) ++nTeam; else ++nFac;

				const char* dn = a->GetDisplayFullName();
				std::string name = (dn && dn[0]) ? dn : "Follower";

				// Base (née) name — the actor's TESNPC name before any rename, which
				// is what a portrait captured before a rename is filed under.
				std::string baseName;
				if (auto* base = a->GetActorBase()) {
					if (const char* bn = base->GetName(); bn && bn[0])
						baseName = bn;
				}

				json row{ { "name", name }, { "formId", id }, { "following", true }, { "dead", dead } };

				// Roster-parity order: FO original (exact roster key) → base name →
				// current display name. First candidate with a portrait file wins.
				std::vector<std::string> cand;
				if (auto it = foOriginal.find(id); it != foOriginal.end())
					cand.push_back(it->second);
				cand.push_back(baseName);
				cand.push_back(name);
				if (attachPortrait(row, cand))
					++nMatched;
				arr.push_back(std::move(row));
				if ((int)arr.size() >= maxFaces)
					break;
			}
		}

		// Diagnostic — logged only when the tallies change, so a still scene is
		// silent but the moment the roster shifts the log names exactly why the
		// strip is (or isn't) populated: how many were caught by the teammate flag
		// vs the follower faction, and how many had a portrait to draw. If this
		// ever reads "teammates=0 follower-faction=0" while companions are plainly
		// following, the detection net — not the portraits — is the thing to widen.
		static std::string s_lastDiag;
		std::string diag = "[hud] scan teammates=" + std::to_string(nTeam) +
			" follower-faction=" + std::to_string(nFac) +
			" shown=" + std::to_string((int)arr.size()) +
			" with-portrait=" + std::to_string(nMatched) +
			" portraits-indexed=" + std::to_string((int)portraits.size());
		if (diag != s_lastDiag) {
			s_lastDiag = diag;
			logger::info("{}", diag);
		}

		return arr.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// Show/Hide the view per enabled && (visible || editing). Main thread.
	void HudApplyVisibility()
	{
		if (!g_prisma || !g_hudView || !g_hudViewReady.load())
			return;
		bool enabled, visible;
		{
			std::lock_guard l(g_configMutex);
			enabled = g_hudConfig.enabled;
			visible = g_hudConfig.visible;
		}
		const bool want = enabled && (visible || g_hudEditing.load());
		if (want)
			g_prisma->Show(g_hudView);
		else
			g_prisma->Hide(g_hudView);
	}

	void HudPushConfig()
	{
		if (g_prisma && g_hudView && g_hudViewReady.load())
			g_prisma->Invoke(g_hudView, ("hudConfig(" + HudConfigJson() + ")").c_str());
	}

	// Push the follower list, but only when it actually changed — Ultralight
	// re-render every 1.2 s for a static strip is waste. Main thread.
	void HudPushData(bool force)
	{
		static std::string s_last;
		if (!g_prisma || !g_hudView || !g_hudViewReady.load())
			return;
		std::string js = HudFollowersJson();
		if (!force && js == s_last)
			return;
		s_last = js;
		g_prisma->Invoke(g_hudView, ("hudData(" + js + ")").c_str());
	}

	// Push the deck-side control's state (Followers tab card).
	void HudPushDeckState()
	{
		if (g_prisma && g_viewReady.load() && g_open.load())
			g_prisma->Invoke(g_view, ("hudCfgState(" + HudDeckStateJson() + ")").c_str());
	}

	// ---- view -> C++ listeners (registered on g_hudView) ----
	void OnJsHudReady(const char*)
	{
		g_hudViewReady = true;
		SKSE::GetTaskInterface()->AddTask([]() {
			HudPushConfig();
			HudPushData(true);
			HudApplyVisibility();
		});
	}
	void OnJsHudLog(const char* data)
	{
		if (data && data[0])
			logger::info("[hud] {}", data);
	}
	// Placement written from the reposition edit-mode: {x,y,scale,orient,showNames}.
	void OnJsHudSave(const char* data)
	{
		const auto j = json::parse(data ? data : "", nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		{
			std::lock_guard l(g_configMutex);
			if (j.contains("x") && j["x"].is_number()) g_hudConfig.x = j["x"].get<int>();
			if (j.contains("y") && j["y"].is_number()) g_hudConfig.y = j["y"].get<int>();
			if (j.contains("scale") && j["scale"].is_number())
				g_hudConfig.scale = std::clamp(j["scale"].get<float>(), 0.4f, 3.0f);
			if (j.contains("orient") && j["orient"].is_string())
				g_hudConfig.orient = (j["orient"].get<std::string>() == "vert") ? "vert" : "horiz";
			if (j.contains("anchorH") && j["anchorH"].is_string())
				g_hudConfig.anchorH = (j["anchorH"].get<std::string>() == "right") ? "right" : "left";
			if (j.contains("anchorV") && j["anchorV"].is_string())
				g_hudConfig.anchorV = (j["anchorV"].get<std::string>() == "bottom") ? "bottom" : "top";
			if (j.contains("showNames") && j["showNames"].is_boolean())
				g_hudConfig.showNames = j["showNames"].get<bool>();
		}
		PersistAll();
		SKSE::GetTaskInterface()->AddTask([]() { HudPushDeckState(); });
	}
	// Reposition finished — drop focus so the mouse is the camera again.
	void OnJsHudEditDone(const char*)
	{
		g_hudEditing = false;
		SKSE::GetTaskInterface()->AddTask([]() {
			if (g_prisma && g_hudView)
				g_prisma->Unfocus(g_hudView);
			HudApplyVisibility();
		});
	}

	// ---- deck -> C++ control (registered on g_view as "hudCfg") ----
	// { op: enable|visible|orient|names|reposition|bindkey|state, on?, orient? }
	void OnJsHudCfg(const char* data)
	{
		const auto j = json::parse(data ? data : "", nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const std::string op = j.value("op", std::string());
		bool persist = true, pushHud = true, pushCfg = false, reposition = false, pushData = false;

		if (op == "enable") {
			std::lock_guard l(g_configMutex);
			g_hudConfig.enabled = j.value("on", !g_hudConfig.enabled);
			// The data ticker idles while the HUD is off, so the view is still holding
			// the empty roster it rendered at load — and an empty panel is display:none
			// (CSS), so Show() alone leaves nothing on screen until the next scan lands.
			// Push config + a forced scan NOW, the same feed reposition does, so
			// enabling shows the strip immediately.
			if (g_hudConfig.enabled) { pushCfg = true; pushData = true; }
		} else if (op == "visible") {
			std::lock_guard l(g_configMutex);
			g_hudConfig.visible = j.value("on", !g_hudConfig.visible);
		} else if (op == "orient") {
			std::lock_guard l(g_configMutex);
			g_hudConfig.orient = (j.value("orient", g_hudConfig.orient) == "vert") ? "vert" : "horiz";
			pushCfg = true;
		} else if (op == "names") {
			std::lock_guard l(g_configMutex);
			g_hudConfig.showNames = j.value("on", !g_hudConfig.showNames);
			pushCfg = true;
		} else if (op == "grow") {
			// Cycle the anchor corner: TL -> TR -> BR -> BL -> TL. The stored x/y
			// keep their magnitudes; only which edge they measure from changes, so
			// the panel flips which way it grows and stays on-screen.
			std::lock_guard l(g_configMutex);
			const bool right = g_hudConfig.anchorH == "right";
			const bool bottom = g_hudConfig.anchorV == "bottom";
			if (!right && !bottom)      { g_hudConfig.anchorH = "right"; }
			else if (right && !bottom)  { g_hudConfig.anchorV = "bottom"; }
			else if (right && bottom)   { g_hudConfig.anchorH = "left"; }
			else                        { g_hudConfig.anchorV = "top"; }
			pushCfg = true;
		} else if (op == "bindkey") {
			g_hudKeyArming = true;
			persist = false; pushHud = false;
		} else if (op == "clearkey") {
			std::lock_guard l(g_configMutex);
			g_hudConfig.keyCode = 0; g_hudConfig.keyLabel.clear(); g_hudConfig.keyDevice = "keyboard";
		} else if (op == "reposition") {
			// Turn it on if it was off, then Focus for a stable cursor to drag with.
			{
				std::lock_guard l(g_configMutex);
				g_hudConfig.enabled = true;
			}
			reposition = true;
		} else if (op == "state") {
			persist = false; pushHud = false;
		}

		if (persist)
			PersistAll();
		const bool doCfg = pushCfg, doHud = pushHud, doRepos = reposition, doData = pushData;
		SKSE::GetTaskInterface()->AddTask([doCfg, doHud, doRepos, doData]() {
			if (doHud) HudApplyVisibility();
			if (doCfg) HudPushConfig();
			if (doData) HudPushData(true);
			if (doRepos) {
				g_hudEditing = true;
				if (g_prisma && g_hudView && g_hudViewReady.load()) {
					g_prisma->Show(g_hudView);
					HudPushConfig();
					HudPushData(true);
					g_prisma->Focus(g_hudView, true, true);
					g_prisma->Invoke(g_hudView, "hudEdit(\"1\")");
				}
			}
			HudPushDeckState();
		});
	}

	// Toggle from the show/hide key (main thread).
	void HudToggleVisible()
	{
		{
			std::lock_guard l(g_configMutex);
			if (!g_hudConfig.enabled) g_hudConfig.enabled = true;  // first press also arms it
			g_hudConfig.visible = !g_hudConfig.visible;
		}
		PersistAll();
		HudApplyVisibility();
		HudPushDeckState();
	}

	// Create the HUD view at load. Shown per config; never Focused except to edit.
	void CreateHudView()
	{
		if (!g_prisma || g_hudView)
			return;
		g_hudView = g_prisma->CreateView("HotkeyDeck/hud.html", [](PrismaView v) {
			g_hudViewReady = true;
			logger::info("followers HUD view DOM ready (handle {})", v);
			SKSE::GetTaskInterface()->AddTask([]() {
				HudPushConfig();
				HudPushData(true);
				HudApplyVisibility();
			});
		});
		g_prisma->RegisterJSListener(g_hudView, "hudReady", OnJsHudReady);
		g_prisma->RegisterJSListener(g_hudView, "hudSave", OnJsHudSave);
		g_prisma->RegisterJSListener(g_hudView, "hudEditDone", OnJsHudEditDone);
		g_prisma->RegisterJSListener(g_hudView, "hudLog", OnJsHudLog);
		logger::info("followers-hud: view created + listeners registered");
	}

	// The data-feed ticker. Own thread; every tick posts a MAIN-THREAD task that
	// rebuilds + pushes only when the roster changed. Idle (no scan) while the
	// feature is off, so a disabled HUD costs nothing.
	std::atomic<bool> g_hudTickerRun{ false };
	void StartHudTicker()
	{
		if (g_hudTickerRun.exchange(true))
			return;
		std::thread([]() {
			for (;;) {
				std::uint32_t ms = 1200;
				bool          on = false;
				{
					std::lock_guard l(g_configMutex);
					ms = g_hudConfig.tickMs;
					on = g_hudConfig.enabled;
				}
				std::this_thread::sleep_for(std::chrono::milliseconds(std::max<std::uint32_t>(300, ms)));
				if (!on || !g_hudViewReady.load())
					continue;
				SKSE::GetTaskInterface()->AddTask([]() { HudPushData(false); });
			}
		}).detach();
	}

	// ================================================================== Hotbar
	// The always-on action bar (view/MagicDeck/hotbar.html). Structurally the
	// Followers HUD's twin — created eagerly, Shown but never Focused during
	// play — but where the HUD only DISPLAYS, this one RUNS things, so the
	// interesting parts are the page selection and the fire dispatch.
	//
	// Nothing here implements an action. Every verb is one the deck already
	// ships and has already play-proven: SpellActions::Cast for spells and
	// voice powers, WheelMenu::Use for anything in the bag, FireEntryById for
	// deck actions and key chords, SpellActions::CastSequence for a combo. The
	// bar is a new SURFACE, not a second implementation — which is also why a
	// slot can hold "literally any" of them.
	//
	// Marker for the deploy check: "hotbar-fire".

	std::string HbConfigJson()
	{
		std::lock_guard l(g_configMutex);
		return Hotbar::ToJson(g_hbConfig).dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// Live slot state for the page currently on screen. MAIN THREAD ONLY.
	//
	// Hotbar::LiveJson resolves FORMS (spells, items) but knows nothing about the
	// deck's own entries or the Spell Deck's combos — those are ids into config
	// slices it cannot see. So their names are filled in here. Without this a
	// deck-action button has no name AND no live name, and the view draws its
	// initials-of-nothing fallback: a bare "·" (seen 2026-08-11).
	//
	// Deliberately resolved on every tick rather than copied into the slot's
	// `label` at assign time: this way renaming the deck entry renames the
	// button, and a deleted one can be reported honestly instead of showing a
	// name for something that is gone.
	std::string HbLiveJson()
	{
		Hotbar::Config c;
		{
			std::lock_guard l(g_configMutex);
			c = g_hbConfig;
		}
		auto j = json::parse(Hotbar::LiveJson(c, g_hbLivePage.load()), nullptr, false);
		if (!j.is_object() || !j.contains("slots") || !j["slots"].is_array())
			return j.is_discarded() ? std::string(R"({"page":0,"slots":[]})") : j.dump(-1, ' ', false, json::error_handler_t::replace);

		std::lock_guard l(g_configMutex);
		for (auto& row : j["slots"]) {
			if (!row.is_object())
				continue;
			const std::string kind = row.value("kind", std::string());
			const std::string ref  = row.value("refId", std::string());
			if (ref.empty())
				continue;
			bool found = false;
			if (kind == "entry") {
				for (const auto& e : g_config.entries)
					if (e.id == ref) { row["name"] = e.name; found = true; break; }
			} else if (kind == "combo") {
				for (const auto& cb : g_magicConfig.combos)
					if (cb.id == ref) { row["name"] = cb.name; found = true; break; }
			} else {
				continue;
			}
			if (!found) {
				// It really is gone — say so rather than drawing a nameless
				// button that silently does nothing when pressed.
				row["ok"] = false;
				row["name"] = kind == "combo" ? "Missing combo" : "Missing action";
				row["msg"] = kind == "combo" ? "That combo was deleted"
											 : "That deck action was deleted";
			}
		}
		return j.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// Should the bar be on screen RIGHT NOW? Three layers, in order: the master
	// switch, the manual show/hide, then the automatic rule (showMode). MAIN
	// THREAD ONLY — it reads the player actor and the menu stack.
	//
	// Editing always wins: you cannot place a bar you cannot see, and an editor
	// that vanished because you sheathed your sword would be maddening.
	bool HbWantVisible()
	{
		if (g_hbEditing.load())
			return true;

		std::string   mode;
		std::uint32_t linger;
		bool          enabled, visible, hideInMenus;
		{
			std::lock_guard l(g_configMutex);
			enabled     = g_hbConfig.enabled;
			visible     = g_hbConfig.visible;
			mode        = g_hbConfig.showMode;
			linger      = g_hbConfig.lingerMs;
			hideInMenus = g_hbConfig.hideInMenus;
		}
		if (!enabled || !visible)
			return false;

		if (hideInMenus) {
			// GameIsPaused covers the lot — inventory, map, magic, the console,
			// and our own palette — with one call and no menu-name list to keep
			// in step with whatever UI mod is installed this week.
			auto* ui = RE::UI::GetSingleton();
			if (ui && ui->GameIsPaused())
				return false;
		}
		if (mode == "always")
			return true;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return true;   // no player to ask -> do not hide the bar on a guess

		const bool inCombat = player->IsInCombat();
		if (inCombat)
			g_hbLastCombatMs = NowMs();

		// The linger: keep the bar up for a beat after the fight so it does not
		// blink out between two draugr in the same room.
		const bool combatish = inCombat ||
			(linger && g_hbLastCombatMs.load() &&
				(NowMs() - g_hbLastCombatMs.load()) < static_cast<long long>(linger));

		bool drawn = false;
		if (auto* st = player->AsActorState())
			drawn = st->IsWeaponDrawn();

		if (mode == "combat")
			return combatish;
		if (mode == "drawn")
			return drawn;
		if (mode == "either")
			return combatish || drawn;
		return true;
	}

	void HbApplyVisibility()
	{
		if (!g_prisma || !g_hbView || !g_hbViewReady.load())
			return;
		const bool want = HbWantVisible();
		// The keys follow the PICTURE, deliberately. "Show only in combat" that
		// still cast Fireball while the bar was hidden would be a trap, and a
		// hidden bar handing 1-8 back to vanilla favourites is the behaviour you
		// actually want out of combat.
		g_hbEffVisible = want;
		if (want == g_hbShown.load())
			return;   // Show/Hide every 150 ms is Ultralight work for nothing
		g_hbShown = want;
		if (want)
			g_prisma->Show(g_hbView);
		else
			g_prisma->Hide(g_hbView);
	}

	void HbPushConfig()
	{
		if (g_prisma && g_hbView && g_hbViewReady.load())
			g_prisma->Invoke(g_hbView, ("hbConfig(" + HbConfigJson() + ")").c_str());
	}

	// Push live state, but only when it actually changed — re-rendering a
	// static bar at 1.4 Hz is Ultralight work for nothing. `force` after a
	// config change or a page swap, where the old string is meaningless.
	void HbPushLive(bool force)
	{
		static std::string s_last;
		if (!g_prisma || !g_hbView || !g_hbViewReady.load())
			return;
		std::string js = HbLiveJson();
		if (!force && js == s_last)
			return;
		s_last = js;
		g_prisma->Invoke(g_hbView, ("hbLive(" + js + ")").c_str());
	}

	// The instant half of a page swap: the stored slots (icons, labels, keys)
	// are already in the view, so this repaints the whole bar on the very next
	// frame; the live rebuild that follows only corrects counts and greying.
	void HbPushPage()
	{
		if (g_prisma && g_hbView && g_hbViewReady.load())
			g_prisma->Invoke(g_hbView,
				("hbPage(" + json{ { "page", g_hbLivePage.load() } }
					.dump(-1, ' ', false, json::error_handler_t::replace) + ")").c_str());
	}

	// Everything the player can put on a button, in the shape the picker wants:
	// {name, plugin, localId, formId, refId, detail, school/element/tier}.
	// MAIN THREAD ONLY (it reads the spellbook and the inventory).
	std::string HbCatalogJson()
	{
		json out{ { "spells", json::array() }, { "items", json::array() },
			{ "entries", json::array() }, { "combos", json::array() } };

		// ---- spells, powers, shouts (the Spell Deck's own enumeration) ----
		{
			auto j = json::parse(SpellActions::KnownSpellsJson(), nullptr, false);
			if (j.is_array()) {
				for (auto& s : j) {
					if (!s.is_object())
						continue;
					json r{
						{ "name", s.value("name", std::string()) },
						{ "plugin", s.value("plugin", std::string()) },
						{ "localId", s.value("localId", 0u) },
						{ "formId", s.value("formId", 0u) },
						{ "school", s.value("school", std::string()) },
						{ "element", s.value("element", std::string()) },
						{ "archetype", s.value("archetype", std::string()) },
						{ "tier", s.value("tier", std::string()) },
						{ "type", s.value("type", std::string()) },
						{ "voice", s.value("slot", std::string()) == "voice" },
					};
					// `detail` is the searchable second line — the picker matches
					// on it too, so "destruction" or "shout" finds things whose
					// NAME says neither.
					std::string detail = s.value("school", std::string());
					if (detail.empty())
						detail = s.value("type", std::string());
					const std::string tier = s.value("tier", std::string());
					if (!tier.empty())
						detail += (detail.empty() ? "" : " · ") + tier;
					r["detail"] = detail;
					out["spells"].push_back(std::move(r));
				}
			}
		}

		// ---- everything in the bag (the wheel's own enumeration) ----------
		{
			auto j = json::parse(WheelMenu::InventoryJson(), nullptr, false);
			if (j.is_object() && j.contains("items") && j["items"].is_array()) {
				for (auto& it : j["items"]) {
					if (!it.is_object())
						continue;
					// ⚠ WheelMenu emits formId as a HEX STRING; the hotbar stores
					// localId as a NUMBER (it is what TESDataHandler wants). Parse
					// here rather than teaching the view two identity shapes.
					const std::uint32_t local =
						ActorIdentity::ParseHex(it.value("formId", std::string()));
					if (!local)
						continue;
					const std::string kind = it.value("kind", std::string());
					const int         cnt  = it.value("count", 0);
					std::string detail = kind;
					if (cnt > 1)
						detail += " · x" + std::to_string(cnt);
					out["items"].push_back(json{
						{ "name", it.value("name", std::string()) },
						{ "plugin", it.value("plugin", std::string()) },
						{ "localId", local },
						{ "formId", local },
						{ "detail", detail },
					});
				}
			}
		}

		// ---- deck entries: actions, key chords, vkeys --------------------
		{
			std::lock_guard l(g_configMutex);
			for (const auto& e : g_config.entries) {
				out["entries"].push_back(json{
					{ "name", e.name },
					{ "refId", e.id },
					{ "detail", e.category.empty() ? std::string("Deck") : e.category },
				});
			}
			for (const auto& cb : g_magicConfig.combos) {
				out["combos"].push_back(json{
					{ "name", cb.name },
					{ "refId", cb.id },
					{ "detail", std::to_string(cb.spells.size()) + " spells" },
				});
			}
		}
		return out.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	// Run the button. MAIN THREAD ONLY. Every branch ends in a verb that
	// already exists; an unresolvable slot gets an honest notification rather
	// than a button that silently does nothing.
	void HbFireSlot(int page, int i)
	{
		Hotbar::Slot s;
		int          p = 0;
		{
			std::lock_guard l(g_configMutex);
			p = std::clamp(page, 0, Hotbar::kPageCount - 1);
			if (p >= static_cast<int>(g_hbConfig.pages.size()))
				return;
			const auto& slots = g_hbConfig.pages[p].slots;
			if (i < 0 || i >= static_cast<int>(slots.size()))
				return;
			s = slots[i];
		}
		if (s.Empty())
			return;

		// Flash first: the bar never has focus, so this is the ONLY feedback
		// that the key landed, and it must not wait on the action.
		if (g_prisma && g_hbView && g_hbViewReady.load()) {
			logger::debug("hotbar-flash: page {} button {}", p, i + 1);
			g_prisma->Invoke(g_hbView,
				("hbFlash(" + json{ { "page", p }, { "i", i } }
					.dump(-1, ' ', false, json::error_handler_t::replace) + ")").c_str());
		}

		if (s.kind == "spell") {
			logger::info("hotbar-fire: page {} button {} -> spell {}|{:X}", p, i + 1, s.plugin, s.localId);
			SpellActions::Cast(s.plugin, s.localId, s.formId);
			return;
		}
		if (s.kind == "item") {
			logger::info("hotbar-fire: page {} button {} -> item {}|{:X}", p, i + 1, s.plugin, s.localId);
			const std::string req = json{
				{ "formId", ActorIdentity::HexOf(s.localId) },
				{ "plugin", s.plugin },
			}.dump(-1, ' ', false, json::error_handler_t::replace);
			const auto res = json::parse(WheelMenu::Use(req), nullptr, false);
			// The wheel answers {ok,msg} instead of toasting, so a refusal is a
			// useful sentence — say it, or the button looks broken.
			if (res.is_object() && !res.value("ok", false)) {
				const std::string msg = res.value("msg", std::string("That didn't work"));
				RE::DebugNotification(msg.c_str());
			}
			return;
		}
		if (s.kind == "entry") {
			logger::info("hotbar-fire: page {} button {} -> entry '{}'", p, i + 1, s.refId);
			FireEntryById(s.refId, "hotbar");
			return;
		}
		if (s.kind == "combo") {
			ComboEntry cb;
			bool       found = false;
			{
				std::lock_guard l(g_configMutex);
				for (const auto& c : g_magicConfig.combos)
					if (c.id == s.refId) { cb = c; found = true; break; }
			}
			if (!found) {
				RE::DebugNotification("That combo is gone");
				return;
			}
			std::vector<SpellActions::SpellRef> refs;
			refs.reserve(cb.spells.size());
			for (const auto& m : cb.spells)
				refs.push_back(SpellActions::SpellRef{ m.plugin, m.localId, m.formId });
			logger::info("hotbar-fire: page {} button {} -> combo '{}' ({} spells)",
				p, i + 1, cb.name, refs.size());
			SpellActions::CastSequence(cb.name, std::move(refs), 150, nullptr);
			return;
		}
	}

	// ---- view -> C++ listeners (registered on g_hbView) ------------------

	void OnJsHbReady(const char*)
	{
		g_hbViewReady = true;
		SKSE::GetTaskInterface()->AddTask([]() {
			HbPushConfig();
			HbPushLive(true);
			HbApplyVisibility();
			if (g_prisma && g_hbView) {
				// The icon pool, pushed once per session exactly as the Spell
				// Deck gets it — this view is in that folder so the paths match.
				g_prisma->Invoke(g_hbView, ("hbIconIndex(" + IconIndexJson() + ")").c_str());
				g_prisma->Invoke(g_hbView, ("hbIcons(" + CustomIconsJson() + ")").c_str());
			}
		});
	}

	void OnJsHbLog(const char* data)
	{
		if (data && data[0])
			logger::info("[hotbar] {}", data);
	}

	// The whole editable Config, written after any edit. Round-tripped through
	// Hotbar::FromJson so every clamp and every array-length normalisation
	// happens in ONE place — the view is not trusted to have got them right.
	void OnJsHbSave(const char* data)
	{
		const auto j = json::parse(data ? data : "", nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::error("hbSave: rejected invalid payload");
			return;
		}
		{
			std::lock_guard l(g_configMutex);
			// enabled/visible are NOT in the view's payload (it has no business
			// switching the feature off), so carry them across explicitly.
			const bool wasEnabled = g_hbConfig.enabled;
			const bool wasVisible = g_hbConfig.visible;
			Hotbar::FromJson(j, g_hbConfig);
			g_hbConfig.enabled = wasEnabled;
			g_hbConfig.visible = wasVisible;
		}
		PersistAll();
		SKSE::GetTaskInterface()->AddTask([]() { HbPushLive(true); });
	}

	void OnJsHbEditDone(const char*)
	{
		g_hbEditing = false;
		SKSE::GetTaskInterface()->AddTask([]() {
			if (g_prisma && g_hbView)
				g_prisma->Unfocus(g_hbView);
			HbApplyVisibility();
			HbPushConfig();   // re-place the bar without the edit-panel offset
		});
	}

	// A click on a button in edit mode never fires it (that would cast a spell
	// at yourself while you were rearranging); this is here for a future
	// click-to-fire and for the portal.
	void OnJsHbFire(const char* data)
	{
		const auto j = json::parse(data ? data : "", nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const int page = j.value("page", 0);
		const int i    = j.value("i", -1);
		if (i < 0)
			return;
		SKSE::GetTaskInterface()->AddTask([page, i]() { HbFireSlot(page, i); });
	}

	// The view already wrote the slot into its own copy and sent the whole
	// config via hbSave; this is the hook for anything that must happen on the
	// game side when a button changes. Kept so the bridge is symmetrical and a
	// future "verify this is still castable" has somewhere to live.
	void OnJsHbAssign(const char* data)
	{
		if (data && data[0])
			logger::info("hotbar: button assigned {}", data);
		SKSE::GetTaskInterface()->AddTask([]() { HbPushLive(true); });
	}

	void OnJsHbCatalog(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			if (!g_prisma || !g_hbView || !g_hbViewReady.load())
				return;
			g_prisma->Invoke(g_hbView, ("hbCatalogData(" + HbCatalogJson() + ")").c_str());
			// A fresh listing of icons/custom every time the picker opens, so a
			// PNG dropped in (or sent from the phone) mid-session shows up.
			g_prisma->Invoke(g_hbView, ("hbIcons(" + CustomIconsJson() + ")").c_str());
		});
	}

	void CreateHotbarView()
	{
		if (!g_prisma || g_hbView)
			return;
		g_hbView = g_prisma->CreateView("MagicDeck/hotbar.html", [](PrismaView v) {
			g_hbViewReady = true;
			logger::info("hotbar view DOM ready (handle {})", v);
			SKSE::GetTaskInterface()->AddTask([]() {
				HbPushConfig();
				HbPushLive(true);
				HbApplyVisibility();
			});
		});
		g_prisma->RegisterJSListener(g_hbView, "hbReady", OnJsHbReady);
		g_prisma->RegisterJSListener(g_hbView, "hbSave", OnJsHbSave);
		g_prisma->RegisterJSListener(g_hbView, "hbEditDone", OnJsHbEditDone);
		g_prisma->RegisterJSListener(g_hbView, "hbFire", OnJsHbFire);
		g_prisma->RegisterJSListener(g_hbView, "hbAssign", OnJsHbAssign);
		g_prisma->RegisterJSListener(g_hbView, "hbCatalog", OnJsHbCatalog);
		g_prisma->RegisterJSListener(g_hbView, "hbLog", OnJsHbLog);
		logger::info("hotbar: view created + listeners registered");
	}

	void HbToggleVisible()
	{
		bool        nowVisible;
		std::string mode;
		{
			std::lock_guard l(g_configMutex);
			if (!g_hbConfig.enabled)
				g_hbConfig.enabled = true;   // first press also arms it
			g_hbConfig.visible = !g_hbConfig.visible;
			nowVisible = g_hbConfig.visible;
			mode       = g_hbConfig.showMode;
		}
		PersistAll();
		HbApplyVisibility();
		// If you switch it ON and it stays off because the automatic rule says
		// so, SAY so. Otherwise the toggle key looks broken, and the setting
		// that is actually responsible is three menus away.
		if (nowVisible && mode != "always" && !g_hbEffVisible.load()) {
			const std::string why = mode == "combat" ? "in combat" :
				mode == "drawn"                      ? "with a weapon or spell drawn" :
													   "in combat or with a weapon drawn";
			RE::DebugNotification(("Action bar is on - it shows " + why).c_str());
		}
	}

	// Open the edit panel: Focus the view (the one state where the bar owns the
	// mouse) and tell it to draw the panel.
	void HbOpenEdit()
	{
		{
			std::lock_guard l(g_configMutex);
			g_hbConfig.enabled = true;
		}
		PersistAll();
		g_hbEditing = true;
		if (g_prisma && g_hbView && g_hbViewReady.load()) {
			g_prisma->Show(g_hbView);
			HbPushConfig();
			HbPushLive(true);
			g_prisma->Focus(g_hbView, true, true);
			g_prisma->Invoke(g_hbView, "hbEdit(\"1\")");
		}
	}

	// The poller. Two jobs on one thread, at two cadences: modifier state at
	// 50 ms (a page swap has to feel instant — that is the whole point of
	// "hold shift and the bar changes"), and the live rebuild at the config's
	// own tickMs. Idle while the feature is off, so a disabled bar costs
	// nothing at all.
	std::atomic<bool> g_hbTickerRun{ false };
	void StartHotbarTicker()
	{
		if (g_hbTickerRun.exchange(true))
			return;
		std::thread([]() {
			bool          prevShift = false, prevCtrl = false, prevAlt = false;
			std::uint32_t sinceLive = 0;
			std::uint32_t sinceVis  = 0;
			for (;;) {
				std::this_thread::sleep_for(std::chrono::milliseconds(50));

				// A LIGHT read, deliberately: this runs 20x a second, and copying
				// the whole Config would allocate ~100 slot structs (five strings
				// each) every tick for the sake of four booleans. Only the page
				// flags and the three scalars come across; `c` is a stand-in
				// carrying just enough for PageForMods.
				Hotbar::Config c;
				c.pages.assign(Hotbar::kPageCount, Hotbar::Page{});
				{
					std::lock_guard l(g_configMutex);
					c.enabled = g_hbConfig.enabled;
					c.modHold = g_hbConfig.modHold;
					c.tickMs  = g_hbConfig.tickMs;
					for (int p = 0; p < Hotbar::kPageCount &&
						 p < static_cast<int>(g_hbConfig.pages.size()); ++p)
						c.pages[p].enabled = g_hbConfig.pages[p].enabled;
				}
				if (!c.enabled || !g_hbViewReady.load()) {
					sinceLive = 0;
					sinceVis  = 0;
					// An enabled bar that has just been switched off still has
					// to come DOWN once, or it stays painted over the game.
					if (g_hbShown.load() && g_hbViewReady.load())
						SKSE::GetTaskInterface()->AddTask([]() { HbApplyVisibility(); });
					continue;
				}

				// The auto-visibility beat: combat / weapon-drawn / menu state
				// all have to be read on the MAIN thread, so this posts a task
				// rather than reading here. 150 ms is fast enough that the bar is
				// up before the first swing lands, and a seventh of the cost of
				// doing it on every 50 ms poll.
				sinceVis += 50;
				if (sinceVis >= 150) {
					sinceVis = 0;
					SKSE::GetTaskInterface()->AddTask([]() { HbApplyVisibility(); });
				}

				const bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
				const bool ctrl  = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
				const bool alt   = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;

				int want;
				if (c.modHold) {
					want = Hotbar::PageForMods(c, shift, ctrl, alt);
				} else {
					// Tap to latch: the RISING edge of a modifier toggles its
					// page. Tapping the page you are already on returns to base,
					// so one key both enters and leaves — otherwise a latched
					// page would need a second, different key to escape.
					const auto edge = [](bool now, bool& prev) {
						const bool rose = now && !prev;
						prev = now;
						return rose;
					};
					const bool rs = edge(shift, prevShift);
					const bool rc = edge(ctrl, prevCtrl);
					const bool ra = edge(alt, prevAlt);
					int latched = g_hbLatchPage.load();
					if (rs && c.pages.size() > Hotbar::kPageShift && c.pages[Hotbar::kPageShift].enabled)
						latched = (latched == Hotbar::kPageShift) ? Hotbar::kPageBase : Hotbar::kPageShift;
					else if (rc && c.pages.size() > Hotbar::kPageCtrl && c.pages[Hotbar::kPageCtrl].enabled)
						latched = (latched == Hotbar::kPageCtrl) ? Hotbar::kPageBase : Hotbar::kPageCtrl;
					else if (ra && c.pages.size() > Hotbar::kPageAlt && c.pages[Hotbar::kPageAlt].enabled)
						latched = (latched == Hotbar::kPageAlt) ? Hotbar::kPageBase : Hotbar::kPageAlt;
					g_hbLatchPage = latched;
					want = latched;
				}
				if (c.modHold) { prevShift = shift; prevCtrl = ctrl; prevAlt = alt; }

				if (want != g_hbLivePage.load()) {
					g_hbLivePage = want;
					SKSE::GetTaskInterface()->AddTask([]() {
						HbPushPage();       // instant repaint from the stored slots
						HbPushLive(true);   // then the live truth for the new page
					});
					sinceLive = 0;
					continue;
				}

				sinceLive += 50;
				if (sinceLive >= std::max<std::uint32_t>(200, c.tickMs)) {
					sinceLive = 0;
					SKSE::GetTaskInterface()->AddTask([]() { HbPushLive(false); });
				}
			}
		}).detach();
	}

	// Does this key press match a hotbar button? Returns the slot index, or -1.
	// Palette-CLOSED only and never while the game is paused: with a menu up the
	// number keys belong to that menu (and to the console), and a bar that cast
	// Fireball because you typed "1" into the console would be a disaster.
	int HbSlotForKey(bool isKb, bool isMs, std::uint32_t idc)
	{
		// EFFECTIVE visibility, not the raw config flags — see HbApplyVisibility.
		// A bar hidden by "only in combat" must not fire, or the setting is a
		// trap and 1-8 never go back to vanilla favourites.
		if (!g_hbEffVisible.load())
			return -1;
		std::lock_guard l(g_configMutex);
		if (!g_hbConfig.enabled || !g_hbConfig.visible)
			return -1;
		const int n = g_hbConfig.VisibleSlots();
		for (int i = 0; i < n && i < static_cast<int>(g_hbConfig.slotKeys.size()); ++i) {
			const auto& k = g_hbConfig.slotKeys[i];
			if (!k.code || k.code != idc)
				continue;
			if ((isKb && k.device == "keyboard") || (isMs && k.device == "mouse"))
				return i;
		}
		return -1;
	}

	// fdCropSave: one crop written from the editor. Reply is `fdCrops` — a
	// different name in the other direction, because a name used for both
	// silently unplugs the control (five times and counting).
	//
	// { file, z, x, y } sets one; { file, clear:true } removes it. `clear`
	// rather than a z=1 payload so C++ never has to decide whether an identity
	// crop means "remove me" — they are the same thing and saying it explicitly
	// keeps the map free of rows that draw nothing.
	void OnJsFolCropSave(const char* data)
	{
		const std::string raw = data ? data : "";
		const auto        j = json::parse(raw, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::error("fdCropSave: rejected invalid payload");
			return;
		}
		const auto file = j.value("file", std::string());
		if (!ValidPortraitFileName(file)) {
			logger::error("fdCropSave: refused file name '{}'", file);
			return;
		}
		const bool clear = j.value("clear", false);
		PortraitCrop c;
		if (!clear) {
			const auto num = [&j](const char* k, double d) {
				return (j.contains(k) && j[k].is_number()) ? j[k].get<double>() : d;
			};
			c.z = num("z", 1.0);
			c.x = num("x", 0.0);
			c.y = num("y", 0.0);
		}
		// An identity crop and an explicit clear are the same instruction.
		const bool keep = !clear && ClampPortraitCrop(c);
		{
			std::lock_guard l(g_configMutex);
			if (keep) {
				// Only refuse a NEW key past the ceiling: overwriting a crop that
				// already exists must always work, however full the map is.
				if (g_folConfig.portraitCrops.size() < kMaxPortraitCrops ||
					g_folConfig.portraitCrops.count(file))
					g_folConfig.portraitCrops[file] = c;
			} else {
				g_folConfig.portraitCrops.erase(file);
			}
		}
		PrunePortraitCrops();   // the only thing that grows the map is also the thing that trims it
		const bool ok = PersistAll();
		if (ok)
			logger::info("portrait crop saved: {} z={:.3f} x={:.3f} y={:.3f} keep={}",
				file, c.z, c.x, c.y, keep);
		else
			logger::error("fdCropSave: accepted but failed to write to disk");
		// The authoritative map goes back, including the prune the view cannot
		// compute (it only ever learns the WINNING file per follower, never the
		// whole directory).
		SKSE::GetTaskInterface()->AddTask([]() { PushToView("fdCrops", FolCropsJson()); });
	}

	// fdSave: view chrome only (open key + scale) — the "followers" slice.
	void OnJsFolSave(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		bool       ok = false;
		if (!j.is_discarded()) {
			FollowerConfig f;
			// Seed the maps a partial payload does NOT send: fdSave from an
			// older view (or from the portal) carries only
			// openKey/avatarPx/uiScale, and FollowerConfigFromJson replaces every
			// field it is given. Without this, changing the avatar size would
			// wipe every portrait crop AND every category icon — the exact trap
			// saveCfg()'s own comment warns about, one field later.
			{
				std::lock_guard l(g_configMutex);
				f.portraitCrops = g_folConfig.portraitCrops;
				f.catIcons = g_folConfig.catIcons;
				f.fqLabels = g_folConfig.fqLabels;   // partial payload (older view/portal) must not wipe it
				f.railCollapsed = g_folConfig.railCollapsed;
			}
			FollowerConfigFromJson(j, f);
			std::size_t nIcons = 0;
			{
				std::lock_guard l(g_configMutex);
				g_folConfig = std::move(f);
				nIcons = g_folConfig.catIcons.size();
			}
			ok = PersistAll();  // emits every slice (followers just-updated, others unchanged)
			if (ok)
				logger::info("follower config saved ({} category icons)", nIcons);
			else
				logger::error("fdSave: accepted but failed to write to disk");
		} else {
			logger::error("fdSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "fdSaved(true)" : "fdSaved(false)");
		});
	}

	void OnJsFolLog(const char* data)
	{
		if (data)
			logger::info("[followers tab] {}", data);
	}

	// ------------------------------------------------------------- Domains tab
	// The Domains pane lives INSIDE the deck view, so its bridge is registered on
	// g_view and its pushes go through PushToView. Marks are view-owned (like the
	// Spell Deck's spells): the pane edits its model and sends the whole slice
	// back through pdSave. C++ owns only the location snapshot and the teleport.

	std::string NewMarkId(const DomainsConfig& d)
	{
		std::size_t n = d.marks.size() + 1;
		std::string id;
		do {
			id = "m" + std::to_string(n++);
		} while (std::any_of(d.marks.begin(), d.marks.end(),
			[&](const PlaceMark& x) { return x.id == id; }));
		return id;
	}

	// pdMark: the view can't read the player's position, so C++ snapshots it here,
	// merges the pane's {name, category}, appends at the FRONT (newest first) and
	// replies with the finished mark — the pane must not wait for a reopen.
	void OnJsPlaceMark(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto jr = json::parse(req, nullptr, false);
			const auto loc = json::parse(PlaceActions::CurrentLocationJson(), nullptr, false);
			if (loc.is_discarded() || !loc.value("ok", false)) {
				RE::DebugNotification("Domains: can't read your position right now");
				PushToView("pdMarked", "null");
				return;
			}
			const bool haveReq = !jr.is_discarded() && jr.is_object();

			PlaceMark m;
			m.name = haveReq ? jr.value("name", std::string("")) : std::string("");
			if (m.name.empty())
				m.name = loc.value("suggested", std::string("Unnamed domain"));
			m.category = haveReq ? jr.value("category", std::string("")) : std::string("");
			m.cellName = loc.value("cellName", std::string(""));
			m.cellId = loc.value("cellId", 0u);
			m.cellEdid = loc.value("cellEdid", std::string(""));
			m.worldspaceId = loc.value("worldspaceId", 0u);
			m.worldspaceName = loc.value("worldspaceName", std::string(""));
			m.interior = loc.value("interior", true);
			m.x = loc.value("x", 0.0f);
			m.y = loc.value("y", 0.0f);
			m.z = loc.value("z", 0.0f);
			m.angleZ = loc.value("angleZ", 0.0f);

			std::string reply, name, category;
			{
				std::lock_guard l(g_configMutex);
				if (g_domConfig.categories.empty())
					g_domConfig.categories = DefaultDomainsConfig().categories;
				if (std::find(g_domConfig.categories.begin(), g_domConfig.categories.end(), m.category) ==
					g_domConfig.categories.end())
					m.category = g_domConfig.categories.front();
				m.id = NewMarkId(g_domConfig);
				name = m.name;
				category = m.category;
				reply = MarkToJson(m).dump(-1, ' ', false, json::error_handler_t::replace);
				g_domConfig.marks.insert(g_domConfig.marks.begin(), std::move(m));
			}
			PersistAll();
			PushToView("pdMarked", reply);
			logger::info("domains: marked '{}' in '{}'", name, category);
		});
	}

	// pdRecall: physical, not administrative — close the palette first so the jump
	// lands in the live world, travel, notify, then optionally reopen straight
	// back onto the Domains tab (closeAfterFire=false).
	void OnJsPlaceRecall(const char* data)
	{
		if (!data)
			return;
		const std::string mark = data;
		const auto        j = json::parse(mark, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("pdRecall: bad payload");
			return;
		}
		const std::string label = j.value("label", std::string(""));
		bool              reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}
		SKSE::GetTaskInterface()->AddTask([mark, label, reopen]() {
			ClosePalette();
			const auto  res = json::parse(PlaceActions::Recall(mark), nullptr, false);
			std::string msg = res.is_discarded() ? std::string("") : res.value("msg", std::string(""));
			if (msg.empty())
				msg = label.empty() ? std::string("Domains: travel failed — see HotkeyDeck.log") : label;
			RE::DebugNotification(msg.c_str());
			if (reopen)
				SKSE::GetTaskInterface()->AddTask([]() {
					if (CanOpenNow()) {
						g_pendingTab = "domains";  // land back on the tab
						OpenPalette();
					}
				});
		});
	}

	// ------------------------------------------------------------ Containers tab
	// The Containers pane lives inside the deck view (ct* bridge on g_view). Marks
	// are view-owned like the Domains slice; C++ owns the crosshair snapshot and
	// the remote open. A mark's durable identity is (plugin, localId) of its ref.

	std::string NewContId(const ContainerConfig& c)
	{
		std::size_t n = c.marks.size() + 1;
		std::string id;
		do {
			id = "c" + std::to_string(n++);
		} while (std::any_of(c.marks.begin(), c.marks.end(),
			[&](const ContainerMark& x) { return x.id == id; }));
		return id;
	}

	// ctMark: build a mark from the crosshair-container snapshot taken at open,
	// merge the pane's {category}, append at the FRONT, reply with the finished mark.
	void OnJsContMark(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto jr = json::parse(req, nullptr, false);
			const auto snap = json::parse(ContainerActions::TargetJson(), nullptr, false);
			if (snap.is_discarded() || !snap.value("found", false)) {
				RE::DebugNotification("Containers: look at a container first");
				PushToView("ctMarked", "null");
				return;
			}
			const bool haveReq = !jr.is_discarded() && jr.is_object();

			ContainerMark m;
			m.name = snap.value("name", std::string("Container"));
			m.category = haveReq ? jr.value("category", std::string("")) : std::string("");
			m.plugin = snap.value("plugin", std::string(""));
			m.localId = snap.value("localId", 0u);
			m.cellName = snap.value("cellName", std::string(""));
			m.cellId = snap.value("cellId", 0u);
			m.cellEdid = snap.value("cellEdid", std::string(""));
			m.worldspaceId = snap.value("worldspaceId", 0u);
			m.worldspaceName = snap.value("worldspaceName", std::string(""));
			m.interior = snap.value("interior", true);
			m.x = snap.value("x", 0.0f);
			m.y = snap.value("y", 0.0f);
			m.z = snap.value("z", 0.0f);
			m.angleZ = snap.value("angleZ", 0.0f);

			std::string reply, name, category;
			{
				std::lock_guard l(g_configMutex);
				if (g_contConfig.categories.empty())
					g_contConfig.categories = DefaultContainerConfig().categories;
				if (std::find(g_contConfig.categories.begin(), g_contConfig.categories.end(), m.category) ==
					g_contConfig.categories.end())
					m.category = g_contConfig.categories.front();
				m.id = NewContId(g_contConfig);
				name = m.name;
				category = m.category;
				reply = ContMarkToJson(m).dump(-1, ' ', false, json::error_handler_t::replace);
				g_contConfig.marks.insert(g_contConfig.marks.begin(), std::move(m));
			}
			PersistAll();
			PushToView("ctMarked", reply);
			logger::info("containers: marked '{}' in '{}'", name, category);
		});
	}

	// ctGo: remote-open a stored container. Close the palette first — OpenContainer
	// raises a ContainerMenu, and a paused palette would hold it hostage. No reopen.
	void OnJsContGo(const char* data)
	{
		if (!data)
			return;
		const std::string mark = data;
		const auto        j = json::parse(mark, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("ctGo: bad payload");
			return;
		}
		SKSE::GetTaskInterface()->AddTask([mark]() {
			ClosePalette();
			const auto        res = json::parse(ContainerActions::OpenContainer(mark), nullptr, false);
			const std::string msg = res.is_discarded() ? std::string("") : res.value("msg", std::string(""));
			if (!msg.empty())
				RE::DebugNotification(msg.c_str());
		});
	}

	// ctSave: the pane edited categories / marks / open key — persist the slice.
	void OnJsContSave(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		bool       ok = false;
		if (!j.is_discarded()) {
			// Seeded from the LIVE config so a partial payload (older view / portal)
			// keeps each mark's photo, carried by id in ContainerConfigFromJson.
			ContainerConfig c;
			{
				std::lock_guard l(g_configMutex);
				c = g_contConfig;
			}
			ContainerConfigFromJson(j, c);
			{
				std::lock_guard l(g_configMutex);
				g_contConfig = std::move(c);
			}
			ok = PersistAll();
			if (!ok)
				logger::error("ctSave: accepted but failed to write to disk");
		} else {
			logger::error("ctSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "ctSaved(true)" : "ctSaved(false)");
		});
	}

	// ctRefresh: re-snapshot the crosshair container and push it (ctTarget).
	void OnJsContRefresh(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			ContainerActions::SnapshotTarget();
			PushToView("ctTarget", ContainerActions::TargetJson());
		});
	}

	// drSet: the door modal's Lock / Unlock button. {action:"lock"|"unlock",
	// level:int} — the console's own `lock <level>` / `unlock` compiled against
	// the door snapshotted at palette open; the reply carries the re-read state
	// so the modal always ends on the engine's truth.
	void OnJsDoorSet(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			const bool haveReq = !j.is_discarded() && j.is_object();
			const bool lock = !haveReq || j.value("action", std::string("lock")) == "lock";
			const int  level = haveReq ? j.value("level", 50) : 50;
			PushToView("drResult", DoorActions::SetLock(lock, level));
		});
	}

	// drRefresh: re-snapshot the crosshair door and push it (drTarget).
	void OnJsDoorRefresh(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			DoorActions::SnapshotTarget();
			PushToView("drTarget", DoorActions::TargetJson());
		});
	}

	// ctPhoto: photograph THIS container — the same camera the wardrobe / domains
	// hand you. Palette closes first; the file lands in <deck view>/container-images/
	// and the photo-saved callback (slug "ct-…") attaches it.
	void OnJsContPhoto(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("ctPhoto: bad payload");
				return;
			}
			const auto  id = j.value("id", std::string(""));
			std::string name;
			{
				std::lock_guard l(g_configMutex);
				for (const auto& m : g_contConfig.marks)
					if (m.id == id) { name = m.name; break; }
			}
			if (id.empty() || name.empty()) {
				logger::warn("ctPhoto: no such container '{}'", id);
				RE::DebugNotification("That container is gone");
				return;
			}
			const std::string slug = "ct-" + PortraitCapture::SlugOfName(name) + "-" +
				PortraitCapture::SlugOfName(id);
			g_photoContainerId = id;
			ClosePalette();
			logger::info("containers: photo mode for '{}' ({})", name, id);
			std::thread([slug, name]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(450));
				SKSE::GetTaskInterface()->AddTask([slug, name]() {
					PortraitCapture::StartPhotoMode(DeckViewDir() / "container-images", slug, name);
				});
			}).detach();
		});
	}

	void OnJsContLog(const char* data)
	{
		if (data)
			logger::info("[containers tab] {}", data);
	}

	// pdSave: the pane edited categories / marks / open key — persist the slice.
	void OnJsPlaceSave(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		bool       ok = false;
		if (!j.is_discarded()) {
			// SEEDED FROM THE LIVE CONFIG, never default-constructed: FromJson
			// preserves what its `out` already holds for the fields the payload
			// omits (the crop map, and per-mark tags/image). A fresh DomainsConfig
			// here would make that preservation a no-op and every rename would
			// wipe every photo crop.
			DomainsConfig d;
			{
				std::lock_guard l(g_configMutex);
				d = g_domConfig;
			}
			DomainsConfigFromJson(j, d);
			{
				std::lock_guard l(g_configMutex);
				g_domConfig = std::move(d);
			}
			ok = PersistAll();  // emits every slice (domains just-updated, others unchanged)
			if (ok) {
				std::size_t marks = 0, tagged = 0, shot = 0;
				{
					std::lock_guard l(g_configMutex);
					marks = g_domConfig.marks.size();
					for (const auto& m : g_domConfig.marks) {
						tagged += m.tags.size();
						shot += m.image.empty() ? 0u : 1u;
					}
				}
				logger::info("domains config saved: {} domains, {} tags, {} photos",
					marks, tagged, shot);
			} else {
				logger::error("pdSave: accepted but failed to write to disk");
			}
		} else {
			logger::error("pdSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "pdSaved(true)" : "pdSaved(false)");
		});
	}

	// pdPhoto: photograph THIS place. Same camera the wardrobe hands you for an
	// outfit — menus hidden, fov 60, free camera with time frozen, E shoots,
	// Esc cancels, 5-minute timeout, everything restored on every exit. The
	// palette has to be gone before the frame is worth grabbing, so it closes
	// first and the camera starts a beat later.
	//
	// The file lands in <deck view>/domain-images/, which is also where the
	// pane's existing `domain-images/<id>.<ext>` convention looks, so a photo
	// and a hand-dropped picture live side by side. The PLUGIN does the write
	// on purpose: MO2 composes its VFS at launch, so a file an outside process
	// drops into the mod folder mid-session is invisible to the running game.
	void OnJsPlacePhoto(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("pdPhoto: bad payload");
				return;
			}
			const auto id = j.value("id", std::string(""));
			std::string name;
			{
				std::lock_guard l(g_configMutex);
				for (const auto& m : g_domConfig.marks)
					if (m.id == id) {
						name = m.name;
						break;
					}
			}
			if (id.empty() || name.empty()) {
				logger::warn("pdPhoto: no such domain '{}'", id);
				RE::DebugNotification("That domain is gone");
				return;
			}
			// Name AND id in the stem: the name is what makes the file readable
			// in a folder listing, the id is what keeps two domains called
			// "Riverwood" from writing over each other.
			const std::string slug = "pd-" + PortraitCapture::SlugOfName(name) + "-" +
				PortraitCapture::SlugOfName(id);
			g_photoDomainId = id;

			// SCENE STAGING (v0.14.6). The picture is of a PLACE, and a place
			// photographed at 3am in a blizzard is a black rectangle no capture
			// setting can rescue — so the pane may name an hour and a sky, and
			// they are applied to the world for the length of the shot and put
			// back by the photo-ended hook. Absent/blank fields change nothing,
			// which is what every photo taken before this build did.
			SceneStage::Request stage;
			if (j.contains("hour") && j["hour"].is_number())
				stage.hour = j["hour"].get<float>();
			if (j.contains("weather") && j["weather"].is_number())
				stage.weather = j["weather"].get<std::uint32_t>();

			ClosePalette();
			logger::info("domains: photo mode for '{}' ({})", name, id);
			// Detached, same idiom as the outfit photo: the main thread cannot
			// block while the palette tears down and the HUD redraws.
			std::thread([slug, name, stage]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(450));
				SKSE::GetTaskInterface()->AddTask([slug, name, stage]() {
					// Stage BEFORE the free camera: `tfc 1` freezes the world,
					// and the sun and sky read the clock while the world ticks.
					std::string err;
					if (!SceneStage::Apply(stage, err) && !err.empty()) {
						logger::warn("domains: scene staging refused - {}", err);
						RE::DebugNotification(err.c_str());
					}
					PortraitCapture::StartPhotoMode(DeckViewDir() / "domain-images", slug, name);
				});
			}).detach();
		});
	}

	// pdScene: what the world currently looks like, and what it COULD look like
	// — {hour, weatherId/Name/Kind, presets, list, exposure, exposureMax}. The
	// weather list is read from the load order and classified by the engine's
	// own record flags, so a weather mod's skies are first-class and no FormID
	// is ever hardcoded (see scene_stage.h).
	//
	// Exposure rides along because the pane shows it in the same block: it is
	// the answer for a place that is dark because it IS dark (a cave), where
	// changing the hour and the sky does nothing.
	void OnJsPlaceScene(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			auto info = json::parse(SceneStage::InfoJson(), nullptr, false);
			if (info.is_discarded() || !info.is_object())
				info = json::object();
			const auto dir = DeckViewDir() / "domain-images";
			info["exposure"] = PortraitCapture::GetPhotoExposure(dir);
			info["exposureMax"] = PortraitCapture::ExposureMax();
			PushToView("pdSceneInfo", info.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
		});
	}

	// pdSceneSet {exposure}: persist the photo exposure into capture.ini, where
	// the capture already reads its framing from — so it survives a restart and
	// stays hand-editable, and there is no second place for it to live.
	void OnJsPlaceSceneSet(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (!j.is_discarded() && j.is_object() && j.contains("exposure") && j["exposure"].is_number()) {
				PortraitCapture::SetPhotoExposure(DeckViewDir() / "domain-images",
					j["exposure"].get<float>());
			}
			// Always answer with the truth from disk, never with what was asked
			// for: the setter clamps, and a view showing the unclamped number
			// would disagree with the picture it is about to take.
			auto info = json::parse(SceneStage::InfoJson(), nullptr, false);
			if (info.is_discarded() || !info.is_object())
				info = json::object();
			const auto dir = DeckViewDir() / "domain-images";
			info["exposure"] = PortraitCapture::GetPhotoExposure(dir);
			info["exposureMax"] = PortraitCapture::ExposureMax();
			PushToView("pdSceneInfo", info.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
		});
	}

	// pdCropSave: one place-photo display crop written from the pane's editor.
	// The reply is `pdCrops` — a DIFFERENT name in the other direction, because
	// a name used for both silently unplugs the control (five times and
	// counting), and its OWN pair, never the wardrobe's or the portrait's.
	//
	// { file, z, x, y } sets one; { file, clear:true } removes it.
	void OnJsPlaceCropSave(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			bool       ok = false;
			if (!j.is_discarded() && j.is_object()) {
				const auto file = j.value("file", std::string(""));
				if (Wardrobe::ValidImageFileName(file)) {
					const bool         clear = j.value("clear", false);
					Wardrobe::ImageCrop c;
					if (!clear) {
						const auto num = [&j](const char* k, double dv) {
							return (j.contains(k) && j[k].is_number()) ? j[k].get<double>() : dv;
						};
						c.z = num("z", 1.0);
						c.x = num("x", 0.0);
						c.y = num("y", 0.0);
					}
					// An identity crop and an explicit clear are the same
					// instruction, so the view says `clear` outright and neither
					// side has to guess. ClampImageCrop returns false for both.
					const bool keep = !clear && Wardrobe::ClampImageCrop(c);
					{
						std::lock_guard l(g_configMutex);
						if (keep) {
							// Only refuse a NEW key past the ceiling: overwriting
							// a crop already in the map must always work, however
							// full it is.
							if (g_domConfig.imageCrops.size() < Wardrobe::kMaxImageCrops ||
								g_domConfig.imageCrops.count(file))
								g_domConfig.imageCrops[file] = c;
						} else {
							g_domConfig.imageCrops.erase(file);
						}
						// The only thing that grows the map is also the thing
						// that trims it: drop crops whose picture has left the
						// folder since. A no-op on an empty read, by contract.
						Wardrobe::PruneCropMap(g_domConfig.imageCrops,
							DeckViewDir() / "domain-images");
					}
					logger::info("domain crop saved: {} z={:.3f} x={:.3f} y={:.3f} keep={}",
						file, c.z, c.x, c.y, keep);
					ok = true;
				} else {
					logger::error("pdCropSave: refused file name '{}'", file);
				}
			} else {
				logger::error("pdCropSave: rejected invalid payload");
			}
			if (ok && !PersistAll())
				logger::error("pdCropSave: accepted but failed to write to disk");
			// The authoritative map goes back either way, including the prune the
			// view cannot compute — it only ever knows the pictures its own
			// domains point at, never the whole folder.
			std::string crops;
			{
				std::lock_guard l(g_configMutex);
				json out = json::object();
				for (const auto& [file, c] : g_domConfig.imageCrops)
					out[file] = json{ { "z", c.z }, { "x", c.x }, { "y", c.y } };
				// .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), never the json itself — PushToView takes a std::string
				// and the implicit conversion COMPILES, then throws type_error.302
				// at runtime inside a PrismaUI callback, which is a hard CTD.
				crops = json{ { "crops", std::move(out) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			PushToView("pdCrops", crops);
		});
	}

	// pdRefresh: the pane became visible — re-push the location snapshot only.
	// The config slice travels once per palette open (pdOpen), so a refresh can
	// never stomp an edit sitting in the pane's 350 ms save debounce.
	void OnJsPlaceRefresh(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("pdHere", PlaceActions::CurrentLocationJson());
		});
	}

	void OnJsPlaceLog(const char* data)
	{
		if (data)
			logger::info("[domains] {}", data);
	}

	// --------------------------------------------------------------- Rooms tab
	// Room Guard: claim a room, keep strangers out of it. Same split as Domains —
	// the pane owns rooms/ignore/settings and sends the slice back through rgSave;
	// C++ owns the claim snapshot, the eviction and the furniture bookkeeping.
	// Every handler hops to the main thread first: all of it touches live actors.

	// One shape for every rgOp reply, so the pane has a single code path: run the
	// op under the lock, persist outside it, push the result plus a fresh config.
	template <class Op>
	void RunRoomOp(Op op, bool repushConfig)
	{
		SKSE::GetTaskInterface()->AddTask([op = std::move(op), repushConfig]() {
			std::string res, cfgJson;
			{
				std::lock_guard l(g_configMutex);
				res = op(g_roomConfig);
				if (repushConfig)
					cfgJson = RoomGuard::OpenJson(g_roomConfig);
			}
			PersistAll();  // outside the lock — PersistAll takes it too
			PushToView("rgResult", res);
			if (repushConfig)
				PushToView("rgOpen", cfgJson);
		});
	}

	void OnJsRoomClaim(const char* data)
	{
		const std::string req = data ? data : "{}";
		RunRoomOp([req](RoomGuard::Config& c) { return RoomGuard::ClaimHere(c, req); }, true);
	}

	void OnJsRoomAnchor(const char* data)
	{
		const std::string id = data ? data : "";
		RunRoomOp([id](RoomGuard::Config& c) { return RoomGuard::SetAnchorHere(c, id); }, true);
	}

	void OnJsRoomEvict(const char* data)
	{
		const std::string id = data ? data : "";
		RunRoomOp([id](RoomGuard::Config& c) { return RoomGuard::EvictNow(c, id); }, false);
	}

	void OnJsRoomRelease(const char* data)
	{
		const std::string id = data ? data : "";
		RunRoomOp([id](RoomGuard::Config& c) { return RoomGuard::ReleaseRoom(c, id); }, true);
	}

	void OnJsRoomIgnore(const char*)
	{
		RunRoomOp([](RoomGuard::Config& c) { return RoomGuard::ToggleIgnoreCrosshair(c); }, true);
	}

	// rgLock: flip a room's PRIVACY LOCKDOWN ("nobody in here right now"). Empty
	// payload = the room you are standing in. Re-pushes the config because the
	// flag lives on the room and the pane's rooms array must agree immediately —
	// the seal is loud UI (banner + row chip) and a stale one would be a lie.
	void OnJsRoomLock(const char* data)
	{
		const std::string id = data ? data : "";
		RunRoomOp([id](RoomGuard::Config& c) { return RoomGuard::ToggleLockdown(c, id); }, true);
	}

	// rgState: live occupancy for the pane's "who's in here" readout. Read-only,
	// so it neither persists nor re-pushes the config.
	//
	// NAMING: request listener `rgState`, reply pushed as `rgStateResult`. The
	// pane used to catch the reply on `window.rgState` too and tell the two
	// apart by shape — but the outgoing request carries NO payload, so the
	// shape test classified it as an unusable reply and swallowed it before it
	// ever reached this function. The occupant list simply never filled. Same
	// law as fdMhiyh / fdNpc above: one name per direction, no exceptions.
	void OnJsRoomState(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string state;
			{
				std::lock_guard l(g_configMutex);
				state = RoomGuard::StateJson(g_roomConfig);
			}
			PushToView("rgStateResult", state);
		});
	}

	// rgNpcs: candidate NPCs for the pane's searchable pickers (per-room ban,
	// global never-move). Read-only, so no persist and no config re-push. Reply
	// is rgNpcsResult — one name per direction, same law as rgState.
	void OnJsRoomNpcs(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = RoomGuard::NpcsJson(g_roomConfig, req);
			}
			PushToView("rgNpcsResult", res);
		});
	}

	// Keys tab. kcScan starts the hotkey census (idempotent while one runs);
	// kcState polls progress (small packet, no bindings); kcResult pulls the
	// full registry. Replies kcStateResult / kcResultData — one name per
	// direction, per the deck law. No AddTask: KeysScan touches only its own
	// state here (the scan itself runs on its own thread).
	void OnJsKeysScan(const char*)
	{
		if (!KeysScan::Start()) {
			logger::info("kcScan: a scan is already running");
		}
		PushToView("kcStateResult", KeysScan::StateJson(false));
	}

	void OnJsKeysState(const char*)
	{
		PushToView("kcStateResult", KeysScan::StateJson(false));
	}

	void OnJsKeysResult(const char*)
	{
		PushToView("kcResultData", KeysScan::StateJson(true));
	}

	// Time pane. tmGet -> tmInfo (the live game clock); tmWait(hours) -> tmResult
	// then a fresh tmInfo, so the pane's dial sweeps to where the world now is.
	// One name per direction, as the law demands.
	void OnJsTimeGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("tmInfo", TimeActions::InfoJson());
		});
	}

	void OnJsTimeWait(const char* data)
	{
		const float hours = data ? static_cast<float>(std::atof(data)) : 0.0f;
		SKSE::GetTaskInterface()->AddTask([hours]() {
			std::string err;
			const bool  ok = TimeActions::Jump(hours, err);
			char reply[192];
			if (ok)
				std::snprintf(reply, sizeof(reply), "{\"ok\":true,\"hours\":%.1f}", hours);
			else
				std::snprintf(reply, sizeof(reply), "{\"ok\":false,\"msg\":\"%s\"}", err.c_str());
			PushToView("tmResult", reply);
			PushToView("tmInfo", TimeActions::InfoJson());
		});
	}

	void OnJsRoomSave(const char* data)
	{
		const std::string payload = data ? data : "";
		bool              ok = false;
		{
			std::lock_guard l(g_configMutex);
			ok = RoomGuard::MergeViewSlice(payload, g_roomConfig);
		}
		if (ok) {
			ok = PersistAll();
			if (ok)
				logger::info("rooms config saved");
			else
				logger::error("rgSave: accepted but failed to write to disk");
		} else {
			logger::error("rgSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "rgSaved(true)" : "rgSaved(false)");
		});
	}

	void OnJsRoomLog(const char* data)
	{
		if (data)
			logger::info("[rooms] {}", data);
	}

	// rgRing: show / re-aim / hide the boundary visualizer. Cosmetic and
	// session-scoped — EXCEPT the align flag, which re-captures a box room's
	// yaw from the player's facing and therefore has to persist.
	void OnJsRoomRing(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = RoomGuard::ShowRing(g_roomConfig, req);
			}
			const auto j = nlohmann::json::parse(req, nullptr, false);
			if (!j.is_discarded() && j.is_object() && j.value("align", false))
				PersistAll();
			PushToView("rgRingState", res);
		});
	}

	// ------------------------------------------------------------ Wheel Menu
	// The radial palette (Ctrl+F7). Its layout is view-owned (a raw json blob on
	// Config, like the shelf's); the only thing the engine owes it is the one
	// class of thing no existing pane indexed — what the player is CARRYING.

	void OnJsWheelInv(const char*)
	{
		// Main thread: walks the player's inventory.
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("whInvList", WheelMenu::InventoryJson());
		});
	}

	void OnJsWheelAct(const char* data)
	{
		const std::string payload = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const std::string res = WheelMenu::Use(payload);
			// The wheel closes the deck the moment a wedge fires, so the answer
			// can NOT be a view toast — the view is already gone. It goes on
			// screen as a game notification, which is also where "Equipped
			// Ebony Sword" belongs: you are looking at the game by then.
			auto j = nlohmann::json::parse(res, nullptr, false);
			if (!j.is_discarded() && j.is_object()) {
				const auto msg = j.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
			PushToView("whActDone", res);
			// A toggle changed what is worn — re-read, so a wheel reopened a
			// second later shows the sword as drawn rather than sheathed.
			PushToView("whInvList", WheelMenu::InventoryJson());
		});
	}

	void OnJsWheelIcons(const char* data)
	{
		const std::string payload = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			// Renders only what is actually ON a wheel (the view bounds the
			// list). EnsureIconsForList is idempotent and render-once, so
			// asking on every wheel open costs a directory read once the
			// pictures exist.
			ItemIcons::EnsureIconsForList(payload);
			PushToView("wdItemIcons", ItemIcons::IndexJson());
		});
	}

	// --------------------------------------------------------------- Loot tab
	// Loot Highlighter: glow scanner config. Same split as Rooms — the pane owns
	// every setting and sends the slice back whole through ltSave; C++ owns the
	// live glow map / opened set / caches, which never persist. All engine work
	// hops to the main thread.

	void OnJsLootGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string cfg;
			{
				std::lock_guard l(g_configMutex);
				cfg = LootHighlight::OpenJson(g_lootConfig);
			}
			PushToView("ltOpen", cfg);
		});
	}

	void OnJsLootSave(const char* data)
	{
		const std::string payload = data ? data : "";
		bool              ok = false;
		{
			std::lock_guard l(g_configMutex);
			ok = LootHighlight::MergeViewSlice(payload, g_lootConfig);
		}
		if (ok) {
			ok = PersistAll();
			if (!ok)
				logger::error("ltSave: accepted but failed to write to disk");
		} else {
			logger::error("ltSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "ltSaved(true)" : "ltSaved(false)");
		});
	}

	void OnJsLootToggle(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string res, cfg;
			{
				std::lock_guard l(g_configMutex);
				res = LootHighlight::ToggleMaster(g_lootConfig);
				cfg = LootHighlight::OpenJson(g_lootConfig);
			}
			PersistAll();  // outside the lock — PersistAll takes it too
			PushToView("ltResult", res);
			PushToView("ltOpen", cfg);
		});
	}

	// ltState: live glow counts for the pane's readout. Read-only; reply name
	// ltStateResult, NOT ltState (one name per direction — the rgState lesson).
	void OnJsLootState(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string state;
			{
				std::lock_guard l(g_configMutex);
				state = LootHighlight::StateJson(g_lootConfig);
			}
			PushToView("ltStateResult", state);
		});
	}

	void OnJsLootLog(const char* data)
	{
		if (data)
			logger::info("[loot] {}", data);
	}

	// ------------------------------------------------------- No Auto-Gear tab
	// Strips distributor cloaks/hoods/underwear from tagged NPCs. Every op that
	// touches actors hops to the main thread first (AddTask), runs under
	// g_configMutex, and PersistAll()s OUTSIDE the lock. Reply names ngOpen/
	// ngSaved/ngResult/ngStateResult are disjoint from the request names.
	void OnJsNgGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string cfg;
			{
				std::lock_guard l(g_configMutex);
				cfg = NoAutoGear::OpenJson(g_ngConfig);
			}
			PushToView("ngOpen", cfg);
		});
	}

	void OnJsNgSave(const char* data)
	{
		const std::string payload = data ? data : "";
		bool              ok = false;
		{
			std::lock_guard l(g_configMutex);
			ok = NoAutoGear::MergeViewSlice(payload, g_ngConfig);
		}
		if (ok) {
			if (!PersistAll())
				logger::error("ngSave: accepted but failed to write to disk");
		} else {
			logger::error("ngSave: rejected invalid payload");
		}
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "ngSaved(true)" : "ngSaved(false)");
		});
	}

	void OnJsNgToggle(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string res, cfg;
			{
				std::lock_guard l(g_configMutex);
				res = NoAutoGear::ToggleCrosshair(g_ngConfig);
				cfg = NoAutoGear::OpenJson(g_ngConfig);
			}
			PersistAll();  // outside the lock — PersistAll takes it too
			PushToView("ngResult", res);
			PushToView("ngOpen", cfg);
		});
	}

	void OnJsNgParty(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string res, cfg;
			{
				std::lock_guard l(g_configMutex);
				res = NoAutoGear::ProtectParty(g_ngConfig);
				cfg = NoAutoGear::OpenJson(g_ngConfig);
			}
			PersistAll();
			PushToView("ngResult", res);
			PushToView("ngOpen", cfg);
		});
	}

	void OnJsNgSweep(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NoAutoGear::SweepNow(g_ngConfig);
			}
			PushToView("ngResult", res);
		});
	}

	// ngState: crosshair NPC + protected? + roster count for the F7 card. Read-
	// only; reply name ngStateResult, NOT ngState (one name per direction).
	void OnJsNgState(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string state;
			{
				std::lock_guard l(g_configMutex);
				state = NoAutoGear::StateJson(g_ngConfig);
			}
			PushToView("ngStateResult", state);
		});
	}

	void OnJsNgLog(const char* data)
	{
		if (data)
			logger::info("[no-auto-gear] {}", data);
	}

	// -------------------------------------------------------------- SPID Gear
	// The F7 card's container→SPID pipeline (spid_gear.cpp). Requests sgGet/
	// sgInbox/sgRemove/sgChance/sgLog; replies sgState/sgResult — one name per
	// direction. Mutations snapshot the slice and rewrite the ini OUTSIDE the
	// config lock (file IO), then PersistAll.
	void OnJsSgGet(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			const std::uint32_t fid =
				(!j.is_discarded() && j.is_object()) ? j.value("formId", 0u) : 0u;
			std::string state;
			{
				std::lock_guard l(g_configMutex);
				state = SpidGear::StateJson(g_spidConfig, fid);
			}
			PushToView("sgState", state);
		});
	}

	void OnJsSgInbox(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			const std::uint32_t fid =
				(!j.is_discarded() && j.is_object()) ? j.value("formId", 0u) : 0u;
			// The transfer menu needs the focus back — same rule as the fdNpc
			// "inventory"/"storage" ops (a menu opened under the palette is the
			// overlap bug of 2026-08-03).
			ClosePalette();
			const auto res = SpidGear::OpenInbox(fid);
			PushToView("sgResult", res);
			const auto jr = json::parse(res, nullptr, false);
			if (!jr.is_discarded()) {
				const auto msg = jr.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
		});
	}

	void OnJsSgRemove(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const auto npcPlugin = j.value("npcPlugin", std::string(""));
			const auto npcLocal = ActorIdentity::ParseHex(j.value("npcLocalId", std::string("")));
			const auto itPlugin = j.value("plugin", std::string(""));
			const auto itLocal = ActorIdentity::ParseHex(j.value("localId", std::string("")));
			const std::uint32_t fid = j.value("formId", 0u);
			std::string      res, state;
			SpidGear::Config snap;
			{
				std::lock_guard l(g_configMutex);
				res = SpidGear::RemoveGrant(g_spidConfig, npcPlugin, npcLocal, itPlugin, itLocal);
				snap = g_spidConfig;
				if (fid)
					state = SpidGear::StateJson(g_spidConfig, fid);
			}
			SpidGear::WriteIni(snap);
			PersistAll();
			PushToView("sgResult", res);
			// Only refresh the card when the ask came FROM the card (a manager
			// row about an unloaded NPC carries no runtime id — a fid-0 state
			// would cache a bogus "no identity" answer under the card's key).
			if (fid)
				PushToView("sgState", state);
		});
	}

	void OnJsSgChance(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const auto npcPlugin = j.value("npcPlugin", std::string(""));
			const auto npcLocal = ActorIdentity::ParseHex(j.value("npcLocalId", std::string("")));
			const auto itPlugin = j.value("plugin", std::string(""));
			const auto itLocal = ActorIdentity::ParseHex(j.value("localId", std::string("")));
			const int  chance = j.value("chance", 100);
			std::string      res;
			SpidGear::Config snap;
			{
				std::lock_guard l(g_configMutex);
				res = SpidGear::SetChance(g_spidConfig, npcPlugin, npcLocal, itPlugin, itLocal, chance);
				snap = g_spidConfig;
			}
			SpidGear::WriteIni(snap);
			PersistAll();
			PushToView("sgResult", res);
			// No sgState push: the slider already shows the value it sent, and a
			// repaint mid-drag would fight the pointer.
		});
	}

	// sgAll: the manager modal's roster — every NPC with grants, their items
	// and dates. Read-only; reply sgAllState.
	void OnJsSgAll(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string all;
			{
				std::lock_guard l(g_configMutex);
				all = SpidGear::AllJson(g_spidConfig);
			}
			PushToView("sgAllState", all);
		});
	}

	// sgEnable: one grant on/off (Wardrobe → SPID segment). Reversible twin of
	// sgRemove — the row stays, the ini line goes. Reply sgResult + a fresh
	// sgAllState so the segment repaints from truth, never from its own guess.
	void OnJsSgEnable(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const auto npcPlugin = j.value("npcPlugin", std::string(""));
			const auto npcLocal = ActorIdentity::ParseHex(j.value("npcLocalId", std::string("")));
			const auto itPlugin = j.value("plugin", std::string(""));
			const auto itLocal = ActorIdentity::ParseHex(j.value("localId", std::string("")));
			const bool on = j.value("enabled", true);
			const std::uint32_t fid = j.value("formId", 0u);
			std::string      res, all, state;
			SpidGear::Config snap;
			{
				std::lock_guard l(g_configMutex);
				res = SpidGear::SetItemEnabled(g_spidConfig, npcPlugin, npcLocal,
					itPlugin, itLocal, on);
				snap = g_spidConfig;
				all = SpidGear::AllJson(g_spidConfig);
				if (fid)
					state = SpidGear::StateJson(g_spidConfig, fid);
			}
			SpidGear::WriteIni(snap);
			PersistAll();
			PushToView("sgResult", res);
			PushToView("sgAllState", all);
			if (fid)
				PushToView("sgState", state);
		});
	}

	// sgNpcOp: her whole block — op = enable | disable | delete. Delete is the
	// destructive one and the view arms it with a two-click; the DLL still
	// answers in words either way.
	void OnJsSgNpcOp(const char* data)
	{
		const std::string payload = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			const auto j = json::parse(payload, nullptr, false);
			if (j.is_discarded() || !j.is_object())
				return;
			const auto npcPlugin = j.value("npcPlugin", std::string(""));
			const auto npcLocal = ActorIdentity::ParseHex(j.value("npcLocalId", std::string("")));
			const auto op = j.value("op", std::string(""));
			const std::uint32_t fid = j.value("formId", 0u);
			std::string      res, all, state;
			SpidGear::Config snap;
			{
				std::lock_guard l(g_configMutex);
				if (op == "delete")
					res = SpidGear::RemoveNpc(g_spidConfig, npcPlugin, npcLocal);
				else if (op == "enable" || op == "disable")
					res = SpidGear::SetNpcEnabled(g_spidConfig, npcPlugin, npcLocal,
						op == "enable");
				else
					res = R"({"ok":false,"msg":"Unknown SPID op"})";
				snap = g_spidConfig;
				all = SpidGear::AllJson(g_spidConfig);
				if (fid)
					state = SpidGear::StateJson(g_spidConfig, fid);
			}
			SpidGear::WriteIni(snap);
			PersistAll();
			PushToView("sgResult", res);
			PushToView("sgAllState", all);
			if (fid)
				PushToView("sgState", state);
			const auto jr = json::parse(res, nullptr, false);
			if (!jr.is_discarded()) {
				const auto msg = jr.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
		});
	}

	void OnJsSgLog(const char* data)
	{
		if (data)
			logger::info("[spid-gear] {}", data);
	}

	// --------------------------------------------------------------- Light tab
	// Quick Light control. No config slice — the light state lives in the save
	// (an ability spell on the player), so every request reads live truth and
	// the actions dispatch through Quick Light's own alias script. Engine work
	// hops to the main thread. Reply names qlState/qlResult are disjoint from
	// the request names (one name per direction — the rgState lesson).

	void OnJsQuickLightGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("qlState", QuickLight::StateJson());
		});
	}

	void OnJsQuickLightOn(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("qlResult", QuickLight::TurnOn());
			PushToView("qlState", QuickLight::StateJson());
		});
	}

	void OnJsQuickLightOff(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("qlResult", QuickLight::TurnOff());
			PushToView("qlState", QuickLight::StateJson());
		});
	}

	void OnJsQuickLightToggle(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("qlResult", QuickLight::Toggle());
			PushToView("qlState", QuickLight::StateJson());
		});
	}

	// ------------------------------------------- Better FaceLight (quick card)
	// Per-NPC facelight truth + on/off/re-light, src/facelight.cpp. No config
	// slice — the state lives in the save (ability spells on the actor), so
	// every request reads live truth on the main thread.

	// The view sends { formId } — the quick card's subject (FO form string or
	// a number, same tolerance as fdPortrait).
	std::uint32_t BflFormIdOf(const char* data)
	{
		if (!data)
			return 0;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return 0;
		if (const auto it = j.find("formId"); it != j.end()) {
			if (it->is_number_unsigned())
				return it->get<std::uint32_t>();
			if (it->is_string())
				return static_cast<std::uint32_t>(std::strtoul(it->get<std::string>().c_str(), nullptr, 16));
		}
		return 0;
	}

	void OnJsBflGet(const char* data)
	{
		const auto formId = BflFormIdOf(data);
		SKSE::GetTaskInterface()->AddTask([formId]() {
			PushToView("bflState", Facelight::StateJson(formId));
		});
	}

	void OnJsBflSet(const char* data)
	{
		const auto formId = BflFormIdOf(data);
		std::string op;
		if (data) {
			const auto j = json::parse(data, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				op = j.value("op", std::string(""));
		}
		SKSE::GetTaskInterface()->AddTask([formId, op]() {
			const auto res = Facelight::Apply(formId, op);
			PushToView("bflResult", res);
			// A fresh state rides along so the card's icon flips without a
			// second round-trip ("relight" finishes ~1.2 s later; the view
			// re-asks after that beat on its own).
			PushToView("bflState", Facelight::StateJson(formId));
		});
	}

	// ------------------------------------------------------ Character Sheet tab
	// The player's own live stats (level, the three pools, active magic effects)
	// plus a freeform RP identity (class / profile / story / portrait). Ships
	// on the deck AND the phone portal — the export/import pair below is the phone
	// half, file-based exactly like mhiyh-status.json + portal-npc-fields.json.
	//
	// Bridge (one name per direction, deck law):
	//   psGet          -> psData(payload)
	//   psRemoveEffect -> psResult({ok,msg}) then a fresh psData
	//   psSetMeta      -> psResult({ok,msg}) then a fresh psData
	//
	// EVERYTHING here that reads the player runs on the main thread (CharSheet::*
	// touches RE::PlayerCharacter and the active-effect list), so the listeners
	// hop through the task interface even when the request carried no game work.

	// Build the payload under the config lock (snapshot the meta), then off it.
	// MAIN THREAD ONLY — the caller has already hopped. Also writes the portal
	// status sidecar, so a phone polling charsheet-status.json sees the same
	// numbers the deck does, refreshed whenever the deck asks or the ticker fires.
	std::string BuildSheetPayload()
	{
		CharSheet::Meta meta;
		{
			std::lock_guard l(g_configMutex);
			meta = g_config.charSheet;
		}
		return CharSheet::BuildSheetJson(meta);
	}

	// Write charsheet-status.json into the HotkeyDeck view dir: the psData payload
	// with an "at" ms timestamp merged in, atomically (temp + rename), so the
	// portal never reads a torn file. Same law and same dir as mhiyh-status.json.
	// MAIN THREAD ONLY (it builds the payload). Best-effort: a write failure is a
	// logged warning, never a crash.
	void WriteSheetStatus(const std::string& payload)
	{
		std::error_code ec;
		const auto      dir = DeckViewDir();
		std::filesystem::create_directories(dir, ec);

		// Merge the timestamp into the payload object without reparsing twice.
		auto j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		j["at"] = static_cast<long long>(
			std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::system_clock::now().time_since_epoch())
				.count());
		const std::string text = j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto file = dir / "charsheet-status.json";
		auto       tmp  = file;
		tmp += ".tmp";
		{
			std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
			if (!out.is_open()) {
				logger::warn("charsheet export: could not open {} for writing", tmp.string());
				return;
			}
			out << text;
		}
		std::filesystem::rename(tmp, file, ec);
		if (ec)
			logger::warn("charsheet export: atomic swap failed: {}", ec.message());
		else {
			// Once at INFO so the marker string is present in a fresh log (and so
			// hd-markers.json's fingerprint is a line this build demonstrably
			// reaches), then DEBUG — the ticker writes this every few seconds.
			static bool said = false;
			if (!said) {
				said = true;
				logger::info("charsheet export: wrote charsheet-status.json for the portal");
			} else
				logger::debug("charsheet export: refreshed charsheet-status.json");
		}
	}

	// Push psData to an open deck AND refresh the portal sidecar in one place, so
	// the two surfaces never disagree. MAIN THREAD ONLY.
	void PushSheet()
	{
		const std::string payload = BuildSheetPayload();
		PushToView("psData", payload);
		WriteSheetStatus(payload);
	}

	void OnJsSheetGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { PushSheet(); });
	}

	void OnJsSheetRemoveEffect(const char* data)
	{
		// Payload: { "key": <instance-hex>, "force": bool }. ActiveEffect's
		// usUniqueID is commonly 0 for many simultaneous effects on the live
		// profile, so it cannot safely address a row.
		std::string key;
		bool        force = false;
		if (data) {
			const auto j = json::parse(data, nullptr, false);
			if (!j.is_discarded() && j.is_object()) {
				if (j.contains("key") && j["key"].is_string())
					key = j["key"].get<std::string>();
				if (j.contains("force") && j["force"].is_boolean())
					force = j["force"].get<bool>();
			}
		}
		SKSE::GetTaskInterface()->AddTask([key = std::move(key), force]() {
			PushToView("psResult", CharSheet::RemoveEffect(key, force));
			// A fresh sheet rides along so the removed effect leaves the list
			// without a second round-trip.
			PushSheet();
		});
	}

	// Shared by psSetMeta and the portal import: apply a partial meta edit,
	// persist, and (on the main thread) push a fresh sheet. Returns the {ok,msg}
	// result string. Safe on any thread — the meta mutation and PersistAll are
	// pure config/disk work; only the psData push is hopped to the main thread.
	std::string ApplySheetMeta(const std::string& editJson)
	{
		std::string res;
		{
			std::lock_guard l(g_configMutex);
			res = CharSheet::ApplyMeta(g_config.charSheet, editJson);
		}
		const auto j = json::parse(res, nullptr, false);
		if (!j.is_discarded() && j.is_object() && j.value("ok", false))
			PersistAll();  // takes the write mutex itself, outside the config lock above
		return res;
	}

	void OnJsSheetSetMeta(const char* data)
	{
		const std::string edit = data ? data : "{}";
		const std::string res  = ApplySheetMeta(edit);
		SKSE::GetTaskInterface()->AddTask([res]() {
			PushToView("psResult", res);
			PushSheet();
		});
	}

	// -------------------------------- Deck Portal Character-Sheet edit handoff
	// portal-sheet-edits.json: a partial CharSheet::Meta object.
	// object queued by the phone (the portal must never write hotkeys.json while
	// the game owns it — same law as portal-npc-fields.json). Read it, apply as
	// psSetMeta would, then TRUNCATE it (never delete — the portal keeps the file
	// present and empty as its "no pending edit" state). Config-only, so it is
	// safe on the poller's worker thread and at the main menu. Returns true when a
	// real edit landed, so the poller re-pushes psData only on news.
	bool ApplyPortalSheetEdits()
	{
		const auto      file = DeckViewDir() / "portal-sheet-edits.json";
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		std::string text;
		{
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open()) {
				logger::warn("portal sheet edit present but unreadable — retrying");
				return false;  // held open mid-write: leave it, next tick gets it
			}
			text.assign((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		}

		bool       applied = false;
		const auto j       = json::parse(text, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::error("portal sheet edit file is malformed — discarding it");
		} else if (j.contains("charClass") || j.contains("alignment") ||
			j.contains("title") || j.contains("eyeColor") || j.contains("height") ||
			j.contains("age") || j.contains("homeland") || j.contains("deity") ||
			j.contains("background") || j.contains("history") || j.contains("portrait")) {
			// Straight through the same path psSetMeta uses (validate, cap,
			// persist). The push is queued separately by the poller.
			const auto res = json::parse(ApplySheetMeta(text), nullptr, false);
			if (!res.is_discarded() && res.value("ok", false)) {
				applied = true;
				logger::info("charsheet: portal meta edit applied");
			} else {
				logger::info("charsheet: portal meta edit skipped: {}",
					res.is_discarded() ? std::string("bad reply") : res.value("msg", std::string("?")));
			}
		}

		// Truncate, never delete — the portal treats an empty file as "no pending
		// edit" and would re-create it on the next edit either way. Same law as
		// portal-npc-fields' fallback branch, applied unconditionally here because
		// the spec fixes truncate as this file's consume step.
		{
			std::ofstream out(file, std::ios::binary | std::ios::trunc);
			if (out.is_open())
				out << R"({})";
			else
				logger::warn("could not truncate portal sheet edit file");
		}
		return applied;
	}

	// -------------------------------------------------------- Animations tab
	// ZAP player: apply an animation to the crosshair target (or the player).
	// C++ owns the catalogue (read from zap-catalog.json at Init) and the apply
	// (NotifyAnimationGraph); the pane owns browsing. Engine work is main-thread.

	void OnJsAnimGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("anOpen", AnimActions::OpenJson());
		});
	}

	void OnJsAnimPlay(const char* data)
	{
		const std::string ev = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([ev]() {
			PushToView("anResult", AnimActions::Play(ev));
		});
	}

	void OnJsAnimReset(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("anResult", AnimActions::Reset());
		});
	}

	void OnJsAnimState(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("anTargetResult", AnimActions::TargetJson());
		});
	}

	void OnJsAnimCrawl(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("anResult", AnimActions::ToggleCrawl());
		});
	}

	void OnJsAnimLog(const char* data)
	{
		if (data)
			logger::info("[anim] {}", data);
	}

	// -------------------------------------------------- OStim segment
	// Scene search / change / furniture / role-swap over OStim SA's Thread API
	// (ostim_deck.cpp). Every entry point touches the OStim thread manager, which
	// is main-thread state — so, like the ZAP player above, all work is an AddTask.

	void OnJsOstimGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("osOpen", OstimDeck::OpenJson());
		});
	}

	void OnJsOstimPoll(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("osState", OstimDeck::StateJson());
		});
	}

	void OnJsOstimSearch(const char* data)
	{
		const std::string q = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([q]() {
			PushToView("osList", OstimDeck::SearchJson(q));
		});
	}

	void OnJsOstimNav(const char* data)
	{
		const std::string id = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([id]() {
			PushToView("osResult", OstimDeck::ChangeScene(id));
		});
	}

	void OnJsOstimSpeed(const char* data)
	{
		const std::string d = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([d]() {
			PushToView("osResult", OstimDeck::Speed(d));
		});
	}

	void OnJsOstimAuto(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("osResult", OstimDeck::ToggleAuto());
		});
	}

	void OnJsOstimFurn(const char* data)
	{
		const std::string mode = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([mode]() {
			PushToView("osResult", OstimDeck::SwitchFurniture(mode));
		});
	}

	void OnJsOstimSwap(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("osResult", OstimDeck::SwapRoles());
		});
	}

	void OnJsOstimLog(const char* data)
	{
		if (data)
			logger::info("[ostim] {}", data);
	}

	// pdNpcList: build the summonable roster (followers + nearby loaded actors) on
	// the main thread — RE:: actor iteration is main-thread only — and push it back
	// as window.pdNpcs({ npcs: [...] }).
	void OnJsPlaceNpcList(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("pdNpcs", PlaceActions::NpcListJson());
		});
	}

	// pdNpcTo: { npcKey:"0x…", mark:{ cellId, cellEdid, x, y, z, angleZ, name, … } }.
	// Resolve the actor and move it to the mark through the shared recall marker,
	// then report via window.pdNpcDone({ ok, name, msg }). A missing/unloaded actor
	// or unresolvable cell is a friendly {ok:false,…}, never a crash.
	void OnJsPlaceNpcTo(const char* data)
	{
		const std::string req = data ? data : "{}";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto j = json::parse(req, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("pdNpcTo: bad payload");
				PushToView("pdNpcDone", R"({"ok":false,"name":"","msg":"Bad request"})");
				return;
			}
			const std::string npcKey = j.value("npcKey", std::string(""));
			const json        mark = (j.contains("mark") && j["mark"].is_object()) ? j["mark"] : json::object();
			const std::string res = PlaceActions::MoveNpcTo(
				npcKey, mark.dump(-1, ' ', false, json::error_handler_t::replace));
			PushToView("pdNpcDone", res);
		});
	}

	// ------------------------------------------------- Finances tab (fin* bridge)
	// Ownership split: the VIEW owns lines/market/settings (finSave -> MergeViewSlice);
	// C++ owns gold/debt/ledger (Settle/Buy/Sell move real Gold001 and are pushed back
	// via finState). Config-only handlers run synchronously (thread-safe under the
	// mutex, like OnJsPlaceSave); anything that reads/moves gold hops to the main
	// thread via AddTask (RE:: player mutation is main-thread only).

	// ------------------------------------------------------------- Wardrobe
	// A wardrobe layer over SOES-NG. The deck NEVER calls SOES directly (its API
	// is Papyrus natives and this rig has a CTD bucket in that path) — wardrobe.cpp
	// sends mod events and HD_WardrobeExec.psc does the work. See src/wardrobe-wiring.md.

	/* Ask SOES for a fresh catalogue and WATCH for it to land.
	 *
	 * RequestCatalogueRefresh only fires a mod event; SOES answers through
	 * Papyrus whenever it feels like it — measured at ~90 s on this save — so
	 * whoever asks must also wait, or the answer is simply never read. Opening
	 * the tab did this inline; nothing else did, which is why building an outfit
	 * wrote it, logged it, and then showed nothing until the tab was closed and
	 * reopened LATER THAN SOES took to answer (reported 2026-08-02, "Necromant"
	 * never appeared). Now every path that changes the catalogue calls this.
	 *
	 * Polls the export file's write time rather than a flag, because the point is
	 * the FILE changing; a flag would only say we asked. Detached and bounded, so
	 * a SOES that never answers costs one warning line, not a stuck thread. */
	void WatchForCatalogue()
	{
		const std::uint64_t before = Wardrobe::CatalogueStamp();
		Wardrobe::RequestCatalogueRefresh();
		std::thread([before]() {
			using namespace std::chrono_literals;
			for (int i = 0; i < 300; ++i) {          // up to ~2.5 min
				std::this_thread::sleep_for(500ms);
				if (Wardrobe::CatalogueStamp() == before)
					continue;
				SKSE::GetTaskInterface()->AddTask([]() {
					if (!Wardrobe::LoadCatalogue())
						return;
					const auto  fo = FollowerDeck::StateJson();
					std::string state;
					{
						std::lock_guard l(g_configMutex);
						state = Wardrobe::StateJson(g_wardrobeConfig, fo);
					}
					logger::info("Wardrobe: catalogue caught up - pushing the tab");
					PushToView("wdState", state);   // the tab fills itself in
				});
				return;
			}
			logger::warn("Wardrobe: SOES never exported - is the executor plugin enabled?");
		}).detach();
	}

	// wdGet: the pane became visible — refresh SOES's catalogue and the armour
	// list, replay queued portal edits, run any due re-rolls, then seed the view.
	void OnJsWdGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			// The export lands asynchronously, so this open shows the PREVIOUS
			// dump and the next one is current — hence the view's "SOES isn't
			// answering" banner rather than blocking on it.
			// Read whatever is on disk from last time FIRST, so the tab opens with
			// content instead of an empty banner.
			Wardrobe::LoadCatalogue();
			Wardrobe::WriteInventoryJson();      // so the portal sees the same armour
			// Real armour renders for the rows that showed a "+" glyph: queue
			// whatever the two exports name that has no PNG yet, and hand the
			// view what already exists so icons show on THIS open.
			ItemIcons::EnsureIcons();
			PushToView("wdItemIcons", ItemIcons::IndexJson());

			// Then ask SOES for a fresh dump. That is a mod event -> Papyrus ->
			// ExportSettings(), and Papyrus answers when it feels like it —
			// measured at ~90 s on this save. The first cut read the file in the
			// same breath as asking for it, so the very first open could never
			// show anything and you had to close and reopen the tab. Watch for the
			// file to actually change instead, and push the result when it lands.
			WatchForCatalogue();

			bool changed = false;
			{
				std::lock_guard l(g_configMutex);
				changed = Wardrobe::ApplyPortalWardrobe(g_wardrobeConfig);
				if (Wardrobe::MaybeRoll(g_wardrobeConfig))
					changed = true;
				// Once per session, before the first crop map goes out: drop
				// crops whose picture has been deleted since the last run.
				// Saving a crop prunes too, so this only covers the player who
				// deletes files and never re-crops — but it also means the map
				// cannot grow across sessions on its own.
				static bool s_prunedCrops = false;
				if (!s_prunedCrops) {
					s_prunedCrops = true;
					if (Wardrobe::PruneImageCrops(g_wardrobeConfig, DeckViewDir() / "icons" / "custom"))
						changed = true;
				}
			}
			if (changed)
				PersistAll();

			const auto  fo = FollowerDeck::StateJson();   // roster; no config lock
			std::string open;
			bool        repaired = false;
			{
				std::lock_guard l(g_configMutex);
				// Before anything is rendered: put every stored identity back on
				// the durable (local FormID + plugin) pair, and re-key by name
				// anyone whose FormID a load-order change has orphaned. Doing it
				// on OPEN is deliberate — this is the first moment we have both
				// the config and a live FO roster in hand.
				repaired = Wardrobe::RepairIdentities(g_wardrobeConfig, fo);
				repaired = NffOutfits::RepairIdentities(g_nffConfig, fo) || repaired;
				open     = Wardrobe::OpenJson(g_wardrobeConfig, fo);
			}
			if (repaired)
				PersistAll();
			PushToView("wdOpen", open);
		});
	}

	// wdSave: the view edited its own slice — merge (roll bookkeeping untouched).
	void OnJsWdSave(const char* data)
	{
		const std::string payload = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([payload]() {
			bool ok = false;
			std::vector<std::pair<std::string, std::string>> nowActive;
			{
				std::lock_guard l(g_configMutex);
				ok = Wardrobe::MergeViewSlice(payload, g_wardrobeConfig, &nowActive);
			}
			if (ok)
				PersistAll();
			// AUTO-TRACK anyone this save just gave an outfit/wardrobe to.
			// Assigning means "SOES manages her" — before this, the assignment
			// saved fine and she still stood there undressed because tracking
			// was a third, separate click nobody remembered. The guard inside
			// SetTracked is inherently satisfied here: we only fire AFTER the
			// merge, so the assignment it checks for exists. Someone who was
			// DELIBERATELY untracked stays untracked unless her assignment is
			// re-activated — this fires on the off→active EDGE, not on every
			// save, so a hand-chosen tracked state is never overridden.
			for (const auto& [fid, plg] : nowActive) {
				std::string res;
				{
					std::lock_guard l(g_configMutex);
					res = Wardrobe::SetTracked(g_wardrobeConfig,
						nlohmann::json{ { "formId", fid }, { "plugin", plg }, { "track", true } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
				}
				logger::info("Wardrobe: auto-tracked {}|{} on assignment -> {}", fid, plg, res);
			}
			PushToView("wdSaved", ok ? "1" : "0");
		});
	}

	// wdCropSave: one outfit-photo display crop written from the editor. The
	// reply is `wdCrops` — a DIFFERENT name in the other direction, because a
	// name used for both silently unplugs the control (five times and counting).
	//
	// { file, z, x, y } sets one; { file, clear:true } removes it.
	void OnJsWdCropSave(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			bool ok = false;
			{
				std::lock_guard l(g_configMutex);
				ok = Wardrobe::ApplyCropSave(g_wardrobeConfig, req);
				// The only thing that grows the map is also the thing that trims
				// it: drop crops whose picture has left the folder since.
				if (ok)
					Wardrobe::PruneImageCrops(g_wardrobeConfig, DeckViewDir() / "icons" / "custom");
			}
			if (ok && !PersistAll())
				logger::error("wdCropSave: accepted but failed to write to disk");
			// The authoritative map goes back either way, including the prune the
			// view cannot compute — it only ever knows the pictures its own
			// outfits point at, never the whole folder.
			std::string crops;
			{
				std::lock_guard l(g_configMutex);
				crops = Wardrobe::CropsJson(g_wardrobeConfig);
			}
			PushToView("wdCrops", crops);
		});
	}

	// wdDress: pick from their wardrobe (or take their one outfit) and apply now.
	void OnJsWdDress(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::Dress(g_wardrobeConfig, req);
			}
			PersistAll();                                 // lastRollDay/lastOutfit moved
			const auto fo = FollowerDeck::StateJson();
			{
				std::lock_guard l(g_configMutex);
				state = Wardrobe::StateJson(g_wardrobeConfig, fo);
			}
			PushToView("wdResult", res);
			PushToView("wdState", state);
		});
	}

	// wdTrack: add/remove the actor from SOES's tracked set.
	void OnJsWdTrack(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::SetTracked(g_wardrobeConfig, req);
			}
			Wardrobe::RequestCatalogueRefresh();   // SOES's own state changed
			PushToView("wdResult", res);
		});
	}

	// wdBuild: assemble a REAL SOES outfit out of inventory pieces, from the
	// deck's Inventory tab. Same payload as the portal's POST /api/outfit.
	void OnJsWdBuild(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::BuildOutfit(g_wardrobeConfig, req);
			}
			PersistAll();                                 // the new outfit got a metadata row
			// SOES has the outfit now, but its export lags ~90 s and nothing was
			// watching for it — so the tab kept showing the pre-build catalogue
			// until it happened to be reopened later than that. The state pushed
			// below already lists it as pending (MergePendingOutfits); this is
			// what turns it into the real, piece-counted entry when SOES answers.
			WatchForCatalogue();
			const auto fo = FollowerDeck::StateJson();
			{
				std::lock_guard l(g_configMutex);
				state = Wardrobe::StateJson(g_wardrobeConfig, fo);
			}
			PushToView("wdResult", res);
			PushToView("wdState", state);
		});
	}

	// wdWorn: what the player (or a named actor) currently has equipped, so the
	// Inventory tab can pre-fill the build basket from an existing look.
	void OnJsWdWorn(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdWornList", Wardrobe::WornJson(req));
		});
	}

	// ---- browsing the load order (engine-side, no Papyrus, no SOES needed) ----

	// NAMING: request listener `wdArmorMods`, reply pushed as `wdArmorModList`.
	// The pane assigned `window.wdArmorMods` for the reply, which overwrote the
	// bridge outright — so clicking "All armour" called the pane's own receiver
	// with the empty request string, JSON.parse('') threw, and the mod list
	// never loaded. One name per direction (see fdMhiyh / fdNpc above).
	void OnJsWdArmorMods(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("wdArmorModList", Wardrobe::ArmorModsJson());
		});
	}

	void OnJsWdArmorsFor(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdArmorList", Wardrobe::ArmorsForModJson(req));
		});
	}

	// ---- an existing outfit's actual contents ----

	void OnJsWdPieces(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdPieceList", Wardrobe::OutfitPiecesJson(req));
		});
	}

	void OnJsWdRemovePiece(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::RemovePiece(g_wardrobeConfig, req);
			}
			PushToView("wdResult", res);
			// the outfit changed — re-read it so the sheet is honest immediately
			PushToView("wdPieceList", Wardrobe::OutfitPiecesJson(req));
			// …and the LIST's piece count is now stale until SOES re-exports.
			WatchForCatalogue();
		});
	}

	// ---- SOES-wide settings ----

	// wdOutfitDel: remove an outfit from SOES and from everything pointing at it.
	void OnJsWdOutfitDel(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::DeleteOutfit(g_wardrobeConfig, req);
			}
			PersistAll();
			// Push the post-tombstone catalogue too, so the deleted outfit
			// leaves the LIST now — not after SOES's ~90 s export cycle.
			const auto  fo = FollowerDeck::StateJson();
			std::string st;
			{
				std::lock_guard l(g_configMutex);
				st = Wardrobe::StateJson(g_wardrobeConfig, fo);
			}
			PushToView("wdState", st);
			PushToView("wdResult", res);
		});
	}

	void OnJsWdImport(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdResult", Wardrobe::ImportModOutfits(req));
			// SOES has to re-export before an imported outfit appears in the
			// catalogue; watch for it rather than making the user reopen the tab.
			WatchForCatalogue();
		});
	}

	// The importer's BROWSER. Own name per direction, like wdArmorMods above:
	// request `wdOutfitMods` / `wdOutfitsFor`, replies `wdOutfitModList` /
	// `wdOutfitList`.
	void OnJsWdOutfitMods(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("wdOutfitModList", Wardrobe::OutfitModsJson());
		});
	}

	void OnJsWdOutfitsFor(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdOutfitList", Wardrobe::OutfitsForModJson(req));
		});
	}

	// wdRename: SOES holds an outfit by NAME, so this has to land on both sides
	// at once. Persisted immediately — every pool, assignment and roll record
	// that named it has just been re-pointed.
	void OnJsWdRename(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::RenameOutfit(g_wardrobeConfig, req);
			}
			PersistAll();
			const auto  fo = FollowerDeck::StateJson();
			std::string st;
			{
				std::lock_guard l(g_configMutex);
				st = Wardrobe::StateJson(g_wardrobeConfig, fo);
			}
			PushToView("wdState", st);
			PushToView("wdResult", res);
		});
	}

	// wdFav: the star, which until now was deck-only decoration. It now also
	// sets SOES's own favourite flag — the list its quick-swap power reads.
	void OnJsWdFav(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::SetOutfitFav(g_wardrobeConfig, req);
			}
			PersistAll();
			PushToView("wdResult", res);
		});
	}

	// wdSoesOpt: quick-swap power / climate priority.
	void OnJsWdSoesOpt(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = Wardrobe::SetSoesOption(g_wardrobeConfig, req);
			}
			PersistAll();
			PushToView("wdResult", res);
		});
	}

	void OnJsWdInvMode(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdResult", Wardrobe::SetInventoryMode(req));
		});
	}

	void OnJsWdEnable(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("wdResult", Wardrobe::SetSoesEnabled(req));
		});
	}

	void OnJsWdRefreshAll(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("wdResult", Wardrobe::RefreshAll());
		});
	}

	void OnJsWdResetAuto(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			PushToView("wdResult", Wardrobe::ResetAutoSwitch());
		});
	}

	void OnJsWdLog(const char* data)
	{
		if (data && *data)
			logger::info("[wardrobe view] {}", data);
	}

	// --------------------------------------------------- NFF outfits (nf* bridge)
	// The Wardrobe pane's SECOND dressing backend. Reads are pure engine (faction
	// ranks + NFF's chest form lists); writes are SKSE mod events that
	// HD_WardrobeExec.psc turns into NFF's own DialogueCmd / switchOutfit — the
	// deck never calls Papyrus, same rule as the SOES side.
	//
	// ⛔ ONE ACTOR, ONE BACKEND. NffOutfits refuses to dress someone the Wardrobe
	// (SOES) still holds; see the header for why the two cannot share an actor.

	// One place to rebuild and push the tab's whole payload, because six handlers
	// want it and the lock order (config, then FO's roster with no lock held)
	// must be identical every time.
	void PushNffOpen()
	{
		const auto  fo = FollowerDeck::StateJson();   // roster; no config lock
		std::string open;
		bool        repaired = false;
		{
			std::lock_guard l(g_configMutex);
			// Same identity repair as the Wardrobe tab, and it must run on BOTH
			// because either tab can be the first one opened this session. Both
			// slices are re-keyed here so the two backends never disagree about
			// who someone is — that disagreement is what showed one woman twice.
			repaired = NffOutfits::RepairIdentities(g_nffConfig, fo);
			repaired = Wardrobe::RepairIdentities(g_wardrobeConfig, fo) || repaired;
			open     = NffOutfits::OpenJson(g_nffConfig, g_wardrobeConfig, fo);
		}
		if (repaired)
			PersistAll();
		PushToView("nfOpen", open);

		// Drop the same payload beside the inventory export, so the Deck Portal
		// can show what only the game knows — which sets exist, their piece
		// counts, who is wearing what. Without this the phone's NFF sheet was
		// names-and-photos only, which read as pointless (Rober, 2026-08-02).
		try {
			const auto file = DeckViewDir() / "nff-status.json";
			auto       tmp  = file;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc);
				if (out.is_open())
					out << open;
			}
			std::error_code ec;
			std::filesystem::rename(tmp, file, ec);
			if (!ec)
				logger::info("nff: status exported for the portal");
		} catch (...) { /* export is best-effort; the tab push above already worked */ }
	}

	// nfGet: the tab became visible — replay queued phone edits, then seed it.
	void OnJsNfGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			bool changed = false;
			{
				std::lock_guard l(g_configMutex);
				changed = NffOutfits::ApplyPortal(g_nffConfig);
			}
			if (changed)
				PersistAll();
			PushNffOpen();
		});
	}

	// nfSave: the view edited its own slice (labels, icons, notes, the master
	// switch). Config-only, so it runs synchronously under the mutex like
	// OnJsPlaceSave — nothing here touches RE:: state.
	void OnJsNfSave(const char* data)
	{
		const std::string payload = data ? data : "";
		bool              ok = false;
		{
			std::lock_guard l(g_configMutex);
			ok = NffOutfits::MergeViewSlice(payload, g_nffConfig);
		}
		if (ok)
			PersistAll();
		else
			logger::error("nfSave: rejected invalid payload");
	}

	void OnJsNfWear(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::Wear(g_nffConfig, g_wardrobeConfig, req);
			}
			PushToView("nfResult", res);
			// NFF's switchOutfit is a Papyrus sequence with its own waits, so the
			// worn flag is not true yet. Re-read after it has had time to land,
			// rather than showing a state we only hope is correct.
			std::thread([]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(1600));
				SKSE::GetTaskInterface()->AddTask([]() { PushNffOpen(); });
			}).detach();
		});
	}

	// nfBuild: NFF answers this by opening a ContainerMenu, so the palette has to
	// let go FIRST — otherwise the container opens underneath a focused webview
	// and the click reads as doing nothing.
	void OnJsNfBuild(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::Build(g_nffConfig, g_wardrobeConfig, req);
			}
			const auto jr = json::parse(res, nullptr, false);
			const bool ok = !jr.is_discarded() && jr.value("ok", false);
			if (!ok) {
				PushToView("nfResult", res);   // refused — stay open and say why
				return;
			}
			ClosePalette();
			const std::string msg = jr.value("msg", std::string(""));
			if (!msg.empty())
				RE::DebugNotification(msg.c_str());
		});
	}

	void OnJsNfClear(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::Clear(g_nffConfig, req);
			}
			PersistAll();   // our labels/icons for a cleared set went with it
			PushToView("nfResult", res);
			std::thread([]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(1600));
				SKSE::GetTaskInterface()->AddTask([]() { PushNffOpen(); });
			}).detach();
		});
	}

	// nfSatchel: also a ContainerMenu, so the palette closes first.
	void OnJsNfSatchel(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			const auto res = NffOutfits::Satchel(req);
			const auto jr = json::parse(res, nullptr, false);
			if (jr.is_discarded() || !jr.value("ok", false)) {
				PushToView("nfResult", res);
				return;
			}
			ClosePalette();
		});
	}

	void OnJsNfClaim(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				// Takes BOTH configs: claiming someone for NFF clears her Wardrobe
				// assignment and untracks her from SOES, which is the entire point.
				res = NffOutfits::Claim(g_nffConfig, g_wardrobeConfig, req);
			}
			PersistAll();
			PushToView("nfResult", res);
			PushNffOpen();
		});
	}

	void OnJsNfPieces(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nfPieceList", NffOutfits::PiecesJson(req));
		});
	}

	// nfCopy: pour a SOES-NG outfit's pieces into one of her NFF sets. The only
	// place the two backends meet, and it moves ITEMS ONLY — she is not tracked
	// in SOES and her Wardrobe assignment is untouched, so the one-actor-one-
	// backend rule still holds afterwards.
	void OnJsNfCopy(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::CopyFromWardrobe(g_nffConfig, g_wardrobeConfig, req);
			}
			PushToView("nfResult", res);
			PushNffOpen();   // piece counts moved
		});
	}

	// nfClone: NFF's Copy Outfit. Nothing leaves her, so no roster re-push and
	// no palette close — the copy lands in your pack while you keep working.
	void OnJsNfClone(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::Clone(g_nffConfig, g_wardrobeConfig, req);
			}
			PushToView("nfResult", res);
		});
	}

	// nfPreview: NFF's Outfit Preview Mode — whether "fill a set" hands you a
	// chest or hands you HER. Persisted, because our copy is what the phone
	// portal renders when the game is not running.
	void OnJsNfPreview(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res;
			{
				std::lock_guard l(g_configMutex);
				res = NffOutfits::SetPreview(g_nffConfig, req);
			}
			PersistAll();
			PushToView("nfResult", res);
			PushNffOpen();   // the toggle re-reads live, so echo the new truth
		});
	}

	// nfSwitch: re-dress EVERYONE for where you are standing. NFF re-dresses
	// asynchronously (SetOutfit, a wait, SetOutfit again, per follower), so the
	// re-push is delayed exactly like nfWear's — an immediate one would show the
	// clothes they were wearing a moment ago.
	void OnJsNfSwitch(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nfResult", NffOutfits::SwitchNow(req));
			std::thread([]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(2200));
				SKSE::GetTaskInterface()->AddTask([]() { PushNffOpen(); });
			}).detach();
		});
	}

	// nfGear: read her four NFF combat-gear switches (helmet/shield/weapon/ammo).
	// Pure engine faction reads — cheap enough to ask per person on card open,
	// which is why there is no roster-wide variant to keep in sync.
	void OnJsNfGear(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nfGearState", NffOutfits::Gear(req));
		});
	}

	// nfSetGear: flip one of them. The write is a mod event to the executor, so
	// the engine-visible faction only changes a beat later — hence the re-read
	// rather than trusting the request to have landed. 600ms is the same shape
	// of wait the other executor-backed ops use; the reply carries the TRUTH, so
	// a failed Papyrus hop shows up as the control springing back.
	void OnJsNfSetGear(const char* data)
	{
		const std::string req = data ? data : "";
		SKSE::GetTaskInterface()->AddTask([req]() {
			PushToView("nfResult", NffOutfits::SetGear(req));
			std::thread([req]() {
				std::this_thread::sleep_for(std::chrono::milliseconds(600));
				SKSE::GetTaskInterface()->AddTask([req]() {
					PushToView("nfGearState", NffOutfits::Gear(req));
				});
			}).detach();
		});
	}

	// nfChest: NFF's shared player chest. "chestOpen" raises a ContainerMenu, so
	// the palette closes first — the same rule the spare inventory needed
	// (Rober, 2026-08-03); "chestPlace" only moves it and leaves you where you
	// are, so the palette stays up and you can open it next.
	void OnJsNfChest(const char* data)
	{
		auto j = json::parse(data ? data : "{}", nullptr, false);
		const std::string which = (!j.is_discarded() && j.is_object())
			? j.value("op", std::string("chestOpen"))
			: std::string("chestOpen");
		if (which != "chestOpen" && which != "chestPlace") {
			PushToView("nfResult",
				json{ { "ok", false }, { "msg", "Unknown chest action" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
			return;
		}
		const std::string cmd     = json{ { "op", which } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const bool        closing = (which == "chestOpen");
		SKSE::GetTaskInterface()->AddTask([cmd, closing]() {
			if (closing)
				ClosePalette();
			const auto pre = NffControl::Apply(cmd, [](const std::string& res) {
				PushToView("nfResult", res);
				const auto jr = json::parse(res, nullptr, false);
				if (!jr.is_discarded()) {
					const auto msg = jr.value("msg", std::string(""));
					if (!msg.empty())
						RE::DebugNotification(msg.c_str());
				}
			});
			PushToView("nfResult", pre);
			// A refusal never reaches the callback, and with the palette already
			// shut the view may never render it — say it on screen or nowhere.
			const auto jp = json::parse(pre, nullptr, false);
			if (!jp.is_discarded() && !jp.value("ok", false)) {
				const auto msg = jp.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
		});
	}

	void OnJsNfLog(const char* data)
	{
		if (data && *data)
			logger::info("[nff view] {}", data);
	}

	// finGet: the pane became visible — replay any queued portal edits, then seed it
	// with the whole slice (+ live gold + the custom-icon pool for the image picker).
	/* ---------------------------------------------------- Sharmat bridge ----
	 *  A dumb relay, on purpose. The view hands us an action name plus already
	 *  URL-encoded query/form strings; we hand back whatever CHIM said. All the
	 *  knowledge of what the fields MEAN — and in particular the read-modify-
	 *  write dance that CHIM's save endpoint requires, since it wipes every
	 *  field a POST omits — lives in JS, once, shared with the phone portal.
	 *
	 *  No AddTask here: Sharmat::Call is explicitly the non-blocking path and
	 *  returns immediately. Wrapping it in a main-thread task would achieve
	 *  nothing except to move the (already async) kick onto the game thread.
	 *  The REPLY is marshalled back to the main thread by the bridge itself.
	 */
	void OnJsSharmatCall(const char* data)
	{
		std::string id, action, query, form;
		try {
			const auto j = nlohmann::json::parse(data ? data : "{}");
			id = j.value("id", "");
			action = j.value("action", "");
			query = j.value("query", "");
			form = j.value("form", "");
		} catch (const std::exception& e) {
			logger::warn("smCall: unparseable payload ({})", e.what());
			return;
		}
		if (action.empty()) {
			logger::warn("smCall: no action");
			return;
		}
		logger::info("smCall: {} (id {})", action, id);
		Sharmat::Call(std::move(id), std::move(action), std::move(query), std::move(form),
			[](const std::string& envelope) { PushToView("smReply", envelope); });
	}

	/* ------------------------------------------------- Omni bridges (v0.14) --
	 *  haAsk: the Ask mode's question, relayed to CHIM's deck_ask endpoint over
	 *  the Ask channel (ask.cpp — a sibling of the Sharmat bridge with its own
	 *  in-flight budget, so a slow LLM think can never starve a profile save).
	 *  The view sends the FULL pre-encoded querystring; this stays a dumb pipe.
	 *  No AddTask around the kick — Ask::Call is non-blocking and marshals its
	 *  own reply back to the main thread, exactly like Sharmat::Call. */
	void OnJsAskCall(const char* data)
	{
		std::string id, query;
		bool        llm = false;
		try {
			const auto j = nlohmann::json::parse(data ? data : "{}");
			id = j.value("id", "");
			query = j.value("query", "");
			llm = j.value("llm", false);
		} catch (const std::exception& e) {
			logger::warn("haAsk: unparseable payload ({})", e.what());
			return;
		}
		if (query.empty()) {
			logger::warn("haAsk: empty query");
			return;
		}
		logger::info("haAsk: {} ask (id {})", llm ? "llm" : "structured", id);
		/* The structured layer is a DB read — seconds. The LLM layer is a chat
		   completion and gets the long leash; connect stays short either way so
		   an unreachable base fails over fast (see ask.cpp). */
		Ask::Call(std::move(id), std::move(query), llm ? 75000 : 10000,
			[](const std::string& envelope) { PushToView("haAnswer", envelope); });
	}

	// hdSpellsIndex: Omni asked for the searchable spell/combo index. The magic
	// slice already holds everything (names, schools, tiers, identities) — no
	// engine call needed, so this is a snapshot-and-push.
	void OnJsSpellsIndex(const char*)
	{
		std::string payload;
		{
			std::lock_guard l(g_configMutex);
			payload = MagicConfigToJson(g_magicConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		logger::info("hdSpellsIndex: omni spell index pushed");
		SKSE::GetTaskInterface()->AddTask([payload = std::move(payload)]() {
			PushToView("hdSpellsData", payload);
		});
	}

	/* hdOmniEquip: EQUIP a spell into a named hand, from the deck view — the
	 * sibling of hdOmniCast and the deck-view twin of the Spell Deck's own
	 * equip branch in OnJsMagicFire. Payload:
	 *   {"plugin":"…","localId":N,"formId":N,"name":"…","hand":"left|right|both"}
	 *
	 * The Wheel Menu's spell wedges use it: a wedge can CAST its spell or park
	 * it in a hand, which is a different verb entirely and the reason this is
	 * not a flag on hdOmniCast.
	 *
	 * Deliberately does NOT close the palette (unlike the cast, which needs the
	 * live unpaused world): equipping is preparation, the wheel wants to show
	 * you the result, and a toggle whose outcome you cannot see is a toggle you
	 * press twice. EquipToggle already answers with the NEW intended state and
	 * puts its own message on screen. */
	void OnJsOmniEquip(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("hdOmniEquip: bad payload");
			return;
		}
		const auto          plugin = j.value("plugin", std::string(""));
		const auto          name = j.value("name", std::string(""));
		const std::uint32_t localId = j.value("localId", 0u);
		const std::uint32_t formId = j.value("formId", 0u);
		auto                hand = j.value("hand", std::string("right"));
		if (hand != "left" && hand != "right" && hand != "both")
			hand = "right";
		if (plugin.empty() && formId == 0) {
			logger::warn("hdOmniEquip: spell '{}' has no identity", name);
			return;
		}
		logger::info("hdOmniEquip: equip-toggle '{}' ({} hand)", name, hand);
		SKSE::GetTaskInterface()->AddTask([plugin, localId, formId, hand]() {
			// Same reply name the Spell Deck uses for the same fact, but pushed
			// to THIS view — the wheel repaints its badge off it.
			PushToView("hdOmniEquipped",
				SpellActions::EquipToggle(plugin, localId, formId, hand));
		});
	}

	/* hdOmniCast: cast a spell or combo straight from the Omni overlay — the
	 *  DECK-view twin of OnJsMagicFire / OnJsMagicCastCombo. Payload:
	 *    {"kind":"spell","plugin":"...","localId":N,"formId":N,"name":"..."}
	 *    {"kind":"combo","name":"...","spells":[{plugin,localId,formId},...]}
	 *  The deck palette closes first (the cast needs the live, unpaused world);
	 *  closeAfterFire=false reopens the DECK afterwards — the user was in the
	 *  deck, not the Spell Deck, so that is where "reopen" goes back to. */
	void OnJsOmniCast(const char* data)
	{
		if (!data)
			return;
		const auto j = json::parse(data, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("hdOmniCast: bad payload");
			return;
		}
		const auto kind = j.value("kind", std::string(""));
		const auto name = j.value("name", std::string(""));

		bool reopen;
		{
			std::lock_guard l(g_configMutex);
			reopen = !g_config.settings.closeAfterFire;
		}

		if (kind == "spell") {
			const auto          plugin = j.value("plugin", std::string(""));
			const std::uint32_t localId = j.value("localId", 0u);
			const std::uint32_t formId = j.value("formId", 0u);
			if (plugin.empty() && formId == 0) {
				logger::warn("hdOmniCast: spell '{}' has no identity", name);
				return;
			}
			logger::info("hdOmniCast: cast '{}'", name);
			SKSE::GetTaskInterface()->AddTask([plugin, localId, formId, reopen]() {
				ClosePalette();  // unpause first, so the spell fires into the live world
				SpellActions::Cast(plugin, localId, formId);
				if (reopen)
					SKSE::GetTaskInterface()->AddTask([]() {
						if (CanOpenNow())
							OpenPalette();
					});
			});
			return;
		}

		if (kind == "combo") {
			std::vector<SpellActions::SpellRef> refs;
			if (j.contains("spells") && j["spells"].is_array()) {
				for (const auto& js : j["spells"]) {
					if (!js.is_object())
						continue;
					SpellActions::SpellRef r;
					r.plugin = js.value("plugin", std::string(""));
					r.localId = js.value("localId", 0u);
					r.formId = js.value("formId", 0u);
					if (r.plugin.empty() && r.formId == 0)
						continue;
					refs.push_back(std::move(r));
					if (refs.size() >= kComboMaxSpells)
						break;
				}
			}
			if (refs.empty()) {
				logger::warn("hdOmniCast: combo '{}' has no castable members", name);
				return;
			}
			logger::info("hdOmniCast: combo-cast '{}' ({} spells)", name, refs.size());
			SKSE::GetTaskInterface()->AddTask([name, refs = std::move(refs), reopen]() {
				ClosePalette();
				SpellActions::CastSequence(name, refs, kComboStaggerMs,
					reopen ? std::function<void()>([]() {
						if (CanOpenNow())
							OpenPalette();
					}) :
							 std::function<void()>{});
			});
			return;
		}

		logger::warn("hdOmniCast: unknown kind '{}'", kind);
	}

	void OnJsFinGet(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			bool changed = false;
			{
				std::lock_guard l(g_configMutex);
				changed = Finance::ApplyPortalFinances(g_finConfig);
				if (Finance::MaybeAutoSettle(g_finConfig))   // auto monthly settle, if toggled on
					changed = true;
			}
			if (changed)
				PersistAll();
			const std::string icons = DeckCustomIconsJson();  // file scan; no config lock
			std::string       open;
			{
				std::lock_guard l(g_configMutex);
				open = Finance::OpenJson(g_finConfig, icons);
			}
			PushToView("finOpen", open);
		});
	}

	// finSave: the view edited lines/market/settings — merge (debt/ledger untouched).
	void OnJsFinSave(const char* data)
	{
		if (!data)
			return;
		const std::string payload = data;
		bool              ok = false;
		{
			std::lock_guard l(g_configMutex);
			ok = Finance::MergeViewSlice(payload, g_finConfig);
		}
		if (ok)
			ok = PersistAll();
		else
			logger::error("finSave: rejected invalid payload");
		SKSE::GetTaskInterface()->AddTask([ok]() {
			if (g_prisma && g_viewReady.load())
				g_prisma->Invoke(g_view, ok ? "finSaved(true)" : "finSaved(false)");
		});
	}

	// finSettle: net income vs expenses+debt against real gold; roll the shortfall
	// into debt. Moves gold -> main thread only.
	void OnJsFinSettle(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res = Finance::Settle(g_finConfig);
				state = Finance::StateJson(g_finConfig);
			}
			PersistAll();
			PushToView("finState", state);
			PushToView("finResult", res);
		});
	}

	// finBuy: spend gold on a named item (blocks when broke). Main thread only.
	void OnJsFinBuy(const char* data)
	{
		if (!data)
			return;
		const std::string req = data;
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res = Finance::Buy(g_finConfig, req);
				state = Finance::StateJson(g_finConfig);
			}
			PersistAll();
			PushToView("finState", state);
			PushToView("finResult", res);
		});
	}

	// finSell: gain gold for a named item. Main thread only.
	void OnJsFinSell(const char* data)
	{
		if (!data)
			return;
		const std::string req = data;
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res = Finance::Sell(g_finConfig, req);
				state = Finance::StateJson(g_finConfig);
			}
			PersistAll();
			PushToView("finState", state);
			PushToView("finResult", res);
		});
	}

	// finBuyProp: acquire a property — charge its cost, mark it owned, update net worth.
	// Moves gold -> main thread only.
	void OnJsFinBuyProp(const char* data)
	{
		if (!data)
			return;
		const std::string req = data;
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				logger::info("[finances] property buy/sell");   // marker: finance-properties
				res   = Finance::BuyProperty(g_finConfig, req);
				state = Finance::StateJson(g_finConfig);
			}
			PersistAll();
			PushToView("finState", state);
			PushToView("finResult", res);
		});
	}

	// finSellProp: sell an owned property — return its value in gold, drop ownership.
	void OnJsFinSellProp(const char* data)
	{
		if (!data)
			return;
		const std::string req = data;
		SKSE::GetTaskInterface()->AddTask([req]() {
			std::string res, state;
			{
				std::lock_guard l(g_configMutex);
				res   = Finance::SellProperty(g_finConfig, req);
				state = Finance::StateJson(g_finConfig);
			}
			PersistAll();
			PushToView("finState", state);
			PushToView("finResult", res);
		});
	}

	// finIcons: the image picker asked for the custom-icon pool (shared with hotkeys).
	void OnJsFinIcons(const char*)
	{
		SKSE::GetTaskInterface()->AddTask([]() { PushToView("finIconList", DeckCustomIconsJson()); });
	}

	void OnJsFinLog(const char* data)
	{
		if (data)
			logger::info("[finances] {}", data);
	}

	// ------------------------------------- Deck Portal live sidecar poller
	// Main thread. Re-push everything the DECK view needs to redraw its hotkeys:
	// hdOpen carries the whole entry list (names, descs, categories, bindings and
	// entries[].icon), hdIcons the custom-file listing.
	void RefreshDeckIcons()
	{
		if (!g_open.load())
			return;  // nothing on screen; the next OpenPalette() carries it anyway
		// Mid-edit safety: a rebind capture owns the view. The sidecar is ALREADY
		// consumed into g_config + hotkeys.json, so dropping this push outright is
		// silent data loss: the stale view's next whole-config hdSave rewrites
		// g_config from what it still believes, reverting the phone's change with
		// nothing left on disk to retry. Remember the debt instead — PortalPollLoop
		// re-fires it on the first tick after the modal closes.
		if (g_capturing.load()) {
			g_deckPushPending = true;
			return;
		}
		// Scan first, push second — for the same reason OpenPalette() does: hdOpen
		// carries the icon PATHS, so the files must already be mirrored into this
		// view's folder before the rows try to load them.
		const std::string iconList = DeckCustomIconsJson();
		std::string       payload;
		{
			std::lock_guard l(g_configMutex);
			payload = ConfigToJson(g_config).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		PushToView("hdOpen", payload);      // entries (with icon paths) first
		PushToView("hdIcons", iconList);    // then the picker's file listing
	}

	// Main thread. The same three payloads OpenMagicPalette() sends, minus the
	// once-per-session mdIconIndex (heavy, and hdIcons/mdIcons is the incremental
	// channel).
	void RefreshMagicIcons()
	{
		if (!g_magicOpen.load() || g_capturing.load())
			return;
		std::string payload;
		{
			std::lock_guard l(g_configMutex);
			payload = MagicConfigToJson(g_magicConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		PushToMagicView("mdOpen", payload);
		PushToMagicView("mdEquipState", SpellActions::EquipStateJson());
		PushToMagicView("mdIcons", CustomIconsJson());
	}

	// Main thread. The Followers tab. No tab check is needed: followers-pane.js
	// caches the state and only re-renders when it is the active tab, and every
	// route into the tab re-asks via fdRefresh. fdTarget is deliberately NOT
	// re-pushed — it is the crosshair snapshot taken at palette open.
	void RefreshFollowersState()
	{
		if (!g_open.load())
			return;
		const auto fo = FollowerDeck::StateJson();
		PushToView("fdState", fo);
		PushToView("fdPortraits", FolPortraitsJson());
		// The crop map rides the same rail as the portrait listing: a face drawn
		// before its crop lands would pop to the new framing a frame later, which
		// reads as a glitch rather than as a setting.
		PushToView("fdCrops", FolCropsJson());
		PushFollowerNff(fo);
		PushToView("fdFertility", FertilityBridge::StateJson(fo));
	}

	// The v0.11.0 headline fix. Until now ApplyPortalAssignments() ran only inside
	// OpenMagicPalette() and ApplyPortalNpcFields() only on fdRefresh, so a phone
	// edit sat in its sidecar until the player happened to reopen the right view
	// (proven 2026-07-29: an icon uploaded at 22:29:44 landed in the sidecar at
	// 22:30:38 and was never consumed, because the Spell Deck was ALREADY open).
	// This applies any pending sidecar within ~1 s and, when the affected view is
	// open, pushes the refresh that makes it visible.
	//
	// Thread contract — the same one every JS listener follows: config + disk IO on
	// this worker thread, live game state (FollowerDeck::*, RE::*) and every
	// PrismaUI Invoke inside AddTask on the main thread. So the three config-only
	// sidecars are applied right here (PersistAll()'s dump + write stays off the
	// render thread) and only the FO replay and the view pushes are queued.
	void PortalPollLoop()
	{
		constexpr auto kTick = std::chrono::milliseconds(1000);

		// Relative paths under Data\, and MO2's VFS is per-process, so they stay
		// valid for the life of the game.
		const auto magicCustom = MagicViewDir() / "icons" / "custom";
		const auto deckDir = DeckViewDir();
		const auto deckCustom = deckDir / "icons" / "custom";
		const auto spellFile = magicCustom / "portal-assignments.json";
		const auto npcFile = deckDir / "portal-npc-fields.json";
		const auto foFile = deckDir / "portal-fo-ops.json";
		const auto iconFile = deckCustom / "portal-hotkey-icons.json";
		const auto editFile = deckDir / "portal-hotkey-edits.json";
		const auto mhiyhFile = deckDir / "portal-mhiyh.json";
		const auto basesFile = deckDir / "portal-bases-ops.json";
		const auto portraitFile = deckDir / "portal-portraits.json";
		const auto sheetFile = deckDir / "portal-sheet-edits.json";
		// portal-cat-icons.json is deliberately absent from this list: it is a
		// permanent seeded file, so it is probed by SIZE through
		// CatIconQueuePending() rather than by existence.

		while (true) {
			// Sleep FIRST (as ExtPollLoop does): SKSEMessageHandler still holds
			// g_configMutex when it starts this thread.
			std::this_thread::sleep_for(kTick);

			// Desync watchdog rides this existing 1 s tick -- no new thread, and it
			// runs whether or not there is any portal work to do, which is exactly
			// when it is needed. The check itself must happen on the main thread
			// (it touches PrismaUI), so hop.
			SKSE::GetTaskInterface()->AddTask([]() { DesyncWatchdogTick(); });

			// Character Sheet export for the phone: refresh charsheet-status.json
			// every ~5th tick (~5 s) while a save is loaded, on the main thread
			// (WriteSheetStatus reads the player). Rides this existing loop so no
			// new thread is spawned, and runs BEFORE the early-outs below so a
			// quiet portal (no pending sidecars) still keeps the phone's numbers
			// live. The deck push inside PushSheet no-ops when the deck is closed —
			// this path is deliberately the sidecar-only refresh.
			{
				static int s_sheetTick = 0;
				if (++s_sheetTick >= 5) {
					s_sheetTick = 0;
					if (g_gameReady.load())
						SKSE::GetTaskInterface()->AddTask([]() { WriteSheetStatus(BuildSheetPayload()); });
				}
			}

			// The previous batch is still queued on the main thread: skip, so a slow
			// frame can never stack tasks or double-apply.
			if (g_portalPollBusy.load())
				continue;

			// A press-to-rebind / capture modal owns the view's state: a refresh push
			// can't be shown, yet applying would DELETE the sidecar and the view's
			// next whole-config save would then overwrite the assignment for good.
			// The sidecar is cheap to leave on disk — retry once the modal closes.
			if (g_capturing.load())
				continue;

			// The modal has just closed and a push was skipped while it was up. The
			// sidecar behind it is long gone, so this is the only thing that can get
			// the applied config into the view before its next save overwrites it.
			if (g_deckPushPending.exchange(false)) {
				if (g_open.load()) {
					g_portalPollBusy = true;
					SKSE::GetTaskInterface()->AddTask([]() {
						RefreshDeckIcons();
						g_portalPollBusy = false;
					});
					continue;
				}
				// Deck closed: OpenPalette() pushes the whole payload anyway.
			}

			// The 99.99% path: four stat()s, no allocation, no lock, no engine call.
			// exists() with the error_code overload never throws.
			std::error_code ec;
			const bool haveSpell = std::filesystem::exists(spellFile, ec);
			const bool haveIcon = std::filesystem::exists(iconFile, ec);
			const bool haveEdit = std::filesystem::exists(editFile, ec);
			const bool haveNpc = std::filesystem::exists(npcFile, ec);
			const bool haveFo = std::filesystem::exists(foFile, ec);
			const bool haveMhiyh = std::filesystem::exists(mhiyhFile, ec);
			const bool haveBases = std::filesystem::exists(basesFile, ec);
			const bool haveSheet = std::filesystem::exists(sheetFile, ec);
			// The bridge file is permanent now (see EnsurePortraitBridge), so its
			// mere existence says nothing. Gate on the write TIME changing, which
			// is one stat() — reparsing a multi-megabyte base64 queue every second
			// would be a real cost for a file that changes a few times an hour.
			static std::filesystem::file_time_type s_portraitStamp{};
			bool                                   havePortrait = false;
			if (std::filesystem::exists(portraitFile, ec)) {
				const auto stamp = std::filesystem::last_write_time(portraitFile, ec);
				if (!ec && stamp != s_portraitStamp) {
					s_portraitStamp = stamp;
					havePortrait = true;
				}
			}
			// Category icons from the phone. Config-only, so it rides the same
			// worker-thread pass as the icon/edit sidecars below and needs no
			// loaded save — a glyph chosen at the main menu still lands.
			const bool haveCatIcon = CatIconQueuePending();
			const bool haveSpellCatIcon = SpellCatIconQueuePending();
			if (!haveSpell && !haveIcon && !haveEdit && !haveNpc && !haveFo && !haveMhiyh &&
				!havePortrait && !haveCatIcon && !haveSpellCatIcon && !haveSheet)
				continue;

			// Config-only, so safe on this thread and safe at the main menu. Each
			// returns false when nothing really changed — including the "held open
			// mid-write" case, where the file is deliberately NOT consumed and the
			// next tick retries it. Edits go LAST of the deck pair, so a delete and
			// an icon assignment landing in the same tick resolve delete-wins.
			const bool spellChanged = haveSpell && ApplyPortalAssignments(magicCustom);
			const bool iconChanged = haveIcon && ApplyPortalHotkeyIcons(deckCustom);
			const bool editChanged = haveEdit && ApplyPortalHotkeyEdits(deckDir);
			const bool catIconChanged = haveCatIcon && ApplyPortalCatIcons();
			// Spell-rail glyphs: config-only like the follower ones; the open magic
			// view repaints on its next open (mdOpen snapshots the config).
			if (haveSpellCatIcon)
				ApplyPortalSpellCatIcons();

			// Portraits from the phone: pure file writes (decode base64, write PNG/JPG
			// through the same lock-safe versioned path a capture uses), no engine
			// call and no roster — so it belongs up here with the other config-only
			// work, and it needs no loaded save. This is what makes a crop saved on
			// the phone appear in the open deck about a second later instead of on
			// the next palette open.
			const bool portraitChanged = havePortrait && ApplyPortalPortraits();

			// Character-sheet meta from the phone: pure config work (validate, cap,
			// persist), no engine call and no roster — so it belongs up here with
			// the other config-only sidecars and lands even at the main menu. On a
			// real change the main-thread task below re-pushes psData + the status
			// file so the open deck and the phone both refresh.
			const bool sheetChanged = haveSheet && ApplyPortalSheetEdits();

			// The NPC replay needs a loaded save: FO's roster does not exist on the
			// main menu and FollowerDeck::Apply touches actors. Leave that sidecar
			// untouched until then — it costs one stat() a second.
			const bool doNpc = haveNpc && g_gameReady.load();
			// Same gate: the category MOVE/RENAME replay also goes through
			// FollowerDeck::Apply, whose roster does not exist at the main menu.
			const bool doFo = haveFo && g_gameReady.load();
			// Same gate, and for a stronger reason than the fields: every MHiYH
			// op dispatches Papyrus against a live actor, and the positional ones
			// place a marker at the player's feet. Neither exists at the main
			// menu. The TTL inside ApplyPortal is what keeps a queue that waited
			// here from being applied in the wrong place later.
			const bool doMhiyh = haveMhiyh && g_gameReady.load();
			// NFF base ops dispatch Papyrus against live actors and read the
			// roster, so they need a loaded save exactly like the MHiYH/NPC
			// replays — a queue that waited here is applied once the save is up.
			const bool doBases = haveBases && g_gameReady.load();

			if (!spellChanged && !iconChanged && !editChanged && !portraitChanged &&
				!catIconChanged && !doNpc && !doFo && !doMhiyh && !doBases && !sheetChanged)
				continue;  // nothing worth waking the main thread for

			g_portalPollBusy = true;
			SKSE::GetTaskInterface()->AddTask([spellChanged, iconChanged, editChanged, portraitChanged, catIconChanged, doNpc, doFo, doMhiyh, doBases, sheetChanged]() {
				// Main thread from here. The FO replay runs BEFORE the pushes —
				// RefreshFollowersState() must read the state FO just wrote.
				const bool npcChanged = doNpc && ApplyPortalNpcFields();
				// Category MOVE/RENAME from the phone, same FO Deck API path.
				const bool foChanged = doFo && ApplyPortalFollowerOps();
				// NFF home-base ops from the phone, replayed through the same
				// NffBases::Apply the in-game Bases controls use. On a real change
				// re-push the live state (which also rewrites the phone snapshot).
				if (doBases && NffBases::ApplyPortalOps()) {
					const std::string bs = NffBases::StateJson("{}");
					if (g_open.load())
						PushToView("nbOpen", bs);
				}
				// The day ops need the roster to turn an original name into a
				// formId, and they answer asynchronously through PortalMhiyhDone
				// — so nothing here waits on them or re-pushes for them.
				if (doMhiyh)
					MhiyhControl::ApplyPortal(DeckViewDir(), FollowerDeck::StateJson(), PortalMhiyhDone);
				if (spellChanged)
					RefreshMagicIcons();
				// Same repaint for both: hdOpen carries names, descs, categories,
				// bindings AND icons, and the view treats it as a soft refresh while
				// it is already visible (tab / edit mode / search survive).
				if (iconChanged || editChanged)
					RefreshDeckIcons();
				if (npcChanged || foChanged)
					RefreshFollowersState();  // one repaint covers both
				// Just the listing, not the whole roster: the pane keys faces off
				// fdPortraits alone, so re-pushing it repaints the new face without
				// disturbing scroll, search or an open menu. Cheap enough to send
				// whether or not the tab is showing — the pane simply keeps it.
				// The rail's glyphs live in the followers CONFIG slice, which the
				// pane only ever learns through fdConfig — so this, not
				// RefreshFollowersState(), is what repaints them. fdConfig is a
				// whole-slice push the pane treats as a reconfigure (it re-applies
				// avatar size / ui scale to the same values), so it is safe to send
				// while the tab is open, mid-search or mid-edit.
				if (catIconChanged) {
					std::string fcfg;
					{
						std::lock_guard l(g_configMutex);
						fcfg = FollowerConfigToJson(g_folConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
					}
					PushToView("fdConfig", fcfg);
				}
				if (portraitChanged) {
					logger::info("portal portraits: applied live, re-pushing the listing");
					PushToView("fdPortraits", FolPortraitsJson());
					// The crop map rides the same rail as the portrait listing: a face drawn
					// before its crop lands would pop to the new framing a frame later, which
					// reads as a glitch rather than as a setting.
					PushToView("fdCrops", FolCropsJson());
				}
				// A phone meta edit landed: re-push the sheet (and refresh the
				// portal status file) so the open deck shows the new class/history
				// without a manual re-open. PushSheet no-ops the deck push when the
				// deck is closed and just rewrites the sidecar, which is correct.
				if (sheetChanged)
					PushSheet();
				g_portalPollBusy = false;
			});
		}
	}

	// ------------------------------------------------------- live API (pipe)
	// The portal's fast path. It does EXACTLY what the portal would have done —
	// drop the sidecar — and then runs the SAME applier the poller runs, so there
	// is only ever one apply path to reason about and nothing new to validate.
	// Every failure degrades to the polled path: the sidecar is written first, so
	// if anything below refuses, the next tick picks it up.
	std::string OnLiveApiRequest(const std::string& body)
	{
		json res;
		res["ok"] = false;
		try {
			const auto j = json::parse(body, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				res["msg"] = "bad json";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}
			const auto kind = j.value("kind", std::string(""));
			if (kind == "ping") {  // liveness probe: the portal uses it to pick a transport
				res["ok"] = true;
				res["msg"] = "hotkey deck live";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Rescue hatch. Every other kind here only WRITES CONFIG, which is why
			// a wedged view was unrecoverable from outside on 2026-08-01: the DLL
			// was alive and answering, but nothing could tell it to let go of the
			// input focus, so the only way out was killing the game. This closes
			// whichever palette is open and drops the capture flag, from any
			// machine, without touching the save.
			if (kind == "close-view") {
				const bool wasOpen  = AnyOpen();
				const bool wasCap   = g_capturing.load();
				const bool desynced = PalettesDesynced();
				// ForceClosePalettes, NOT ClosePalette: the whole point of this
				// command is rescuing a state where the flags are wrong, and
				// ClosePalette early-returns on exactly those flags. Calling it
				// here would have made this command useless in the one situation
				// it exists for -- which is what happened on 2026-08-01.
				SKSE::GetTaskInterface()->AddTask([]() {
					ForceClosePalettes("live api: close-view");
				});
				logger::warn("live api: close-view requested (open={}, capturing={}, desynced={})",
					wasOpen, wasCap, desynced);
				res["ok"] = true;
				res["was_open"] = wasOpen;
				res["was_capturing"] = wasCap;
				res["was_desynced"] = desynced;
				res["msg"] = "force-closed";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Wear an outfit on the PLAYER right now, from the phone. Live-only on
			// purpose: replaying a queued "wear" hours later, mid-fight, when the
			// Wardrobe tab happens to open would be a jump-scare, not a feature.
			if (kind == "wear-outfit") {
				const std::string outfit = j.value("outfit", std::string(""));
				if (outfit.empty()) {
					res["msg"] = "no outfit named";
					return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				}
				SKSE::GetTaskInterface()->AddTask([outfit]() {
					const auto r  = Wardrobe::DressNow(json{ { "outfit", outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
					const auto jr = json::parse(r, nullptr, false);
					std::string msg;
					if (jr.is_discarded() || !jr.value("ok", false))
						msg = jr.is_discarded() ? std::string("Could not wear that")
												: jr.value("msg", std::string("Could not wear that"));
					else
						msg = "Wearing \"" + outfit + "\" (from the phone)";
					RE::DebugNotification(msg.c_str());
					logger::info("live api: wear-outfit '{}'", outfit);
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "wearing";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Pull a portal-written image INTO the VFS. A file an outside process
			// adds to the MOD FOLDER mid-session is invisible to the running game
			// (MO2 snapshots its map at launch) — so a phone-cropped outfit photo
			// showed BLANK in game until relaunch. The plugin re-reading the real
			// file and re-writing it through its own (VFS-mapped) Data path lands
			// it in overwrite, which the session CAN see. {"src": "<abs>", "name": "<file>"}
			if (kind == "import-icon") {
				const std::string src  = j.value("src", std::string(""));
				const std::string name = j.value("name", std::string(""));
				// name is a bare filename, never a path — this writes inside the
				// view's own icons/custom and nowhere else.
				if (src.empty() || name.empty() || name.find('\\') != std::string::npos ||
					name.find('/') != std::string::npos || name.find("..") != std::string::npos) {
					res["msg"] = "bad import request";
					return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				}
				SKSE::GetTaskInterface()->AddTask([src, name]() {
					std::error_code ec;
					const auto dst = DeckViewDir() / "icons" / "custom" / name;
					std::filesystem::create_directories(dst.parent_path(), ec);
					// copy via read+write (not copy_file) so the WRITE goes through
					// this process's hooked filesystem, i.e. through the VFS
					std::ifstream in(src, std::ios::binary);
					if (!in.is_open()) {
						logger::warn("live api: import-icon could not read {}", src);
						return;
					}
					std::ofstream out(dst, std::ios::binary | std::ios::trunc);
					if (!out.is_open()) {
						logger::warn("live api: import-icon could not write {}", dst.string());
						return;
					}
					out << in.rdbuf();
					logger::info("live api: import-icon '{}' pulled into the session", name);
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "importing";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// The phone's "hook to my live inventory": re-export the player's
			// armour + worn list RIGHT NOW, so /api/inventory is fresh without a
			// Wardrobe tab open. Main thread only — it walks the player's inventory.
			if (kind == "inventory-refresh") {
				SKSE::GetTaskInterface()->AddTask([]() {
					if (Wardrobe::WriteInventoryJson())
						logger::info("live api: inventory re-exported for the portal");
					ItemIcons::EnsureIcons();   // fresh export may name new pieces
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "exporting inventory";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			const auto magicCustom = MagicViewDir() / "icons" / "custom";
			const auto deckDir = DeckViewDir();
			const auto deckCustom = deckDir / "icons" / "custom";

			std::filesystem::path file;
			if (kind == "spell-icons")        file = magicCustom / "portal-assignments.json";
			else if (kind == "hotkey-icons")  file = deckCustom / "portal-hotkey-icons.json";
			else if (kind == "hotkey-edits")  file = deckDir / "portal-hotkey-edits.json";
			else if (kind == "npc-fields")    file = deckDir / "portal-npc-fields.json";
			else if (kind == "fo-ops")        file = deckDir / "portal-fo-ops.json";
			else if (kind == "wardrobe")      file = deckDir / "portal-wardrobe.json";
			else if (kind == "mhiyh")         file = deckDir / "portal-mhiyh.json";
			else if (kind == "cat-icons")     file = deckDir / "portal-cat-icons.json";
			else if (kind == "spell-cat-icons") file = MagicViewDir() / "portal-spell-cat-icons.json";
			else if (kind == "finances")      file = deckDir / "portal-finances.json";
			else {
				res["msg"] = "unknown kind";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Same temp+rename the portal uses, for the same reason: a reader must
			// never see half a file.
			json payload = j;
			payload.erase("kind");
			{
				std::error_code ec;
				std::filesystem::create_directories(file.parent_path(), ec);
				auto tmp = file;
				tmp += ".tmp";
				{
					std::ofstream out(tmp, std::ios::trunc);
					if (!out.is_open()) {
						res["msg"] = "cannot write sidecar";
						return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
					}
					out << payload.dump(2);
				}
				std::filesystem::rename(tmp, file, ec);
				if (ec) {
					res["msg"] = "cannot place sidecar";
					return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				}
			}

			// A capture modal owns the view: leave it queued rather than consuming
			// something we cannot repaint (identical reasoning to the poller guard).
			if (g_capturing.load()) {
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "queued — a key-rebind menu is open in game";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// NPC fields touch live actors through FollowerDeck, so they are main
			// thread only: hand them to the poller's own applier on a task and
			// answer honestly that it is queued (it lands within a frame).
			if (kind == "npc-fields") {
				SKSE::GetTaskInterface()->AddTask([]() {
					if (ApplyPortalNpcFields())
						RefreshFollowersState();
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "applying";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Category MOVE/RENAME touch FO's roster through FollowerDeck, so —
			// exactly like npc-fields — main thread only, answered as queued (it
			// lands within a frame; the poller is the fallback if this refuses).
			if (kind == "fo-ops") {
				SKSE::GetTaskInterface()->AddTask([]() {
					if (ApplyPortalFollowerOps())
						RefreshFollowersState();
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "applying";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// A day change dispatches Papyrus at a live actor and marks the
			// PLAYER'S FEET, so this is the path that matters most for MHiYH: it
			// applies within a frame of the tap, which is the only time
			// "where I am standing" means what the phone said it meant. The
			// polled path is the fallback, and its TTL drops anything stale.
			if (kind == "mhiyh") {
				SKSE::GetTaskInterface()->AddTask([]() {
					MhiyhControl::ApplyPortal(DeckViewDir(), FollowerDeck::StateJson(), PortalMhiyhDone);
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "applying";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Wardrobe ops resolve armour forms and send SOES mod events, so they
			// are main thread only — same shape as npc-fields. After applying,
			// push a fresh wdOpen so an open Wardrobe tab updates in place; with
			// the tab closed the push is a harmless no-op.
			if (kind == "wardrobe") {
				SKSE::GetTaskInterface()->AddTask([]() {
					bool changed = false;
					{
						std::lock_guard l(g_configMutex);
						changed = Wardrobe::ApplyPortalWardrobe(g_wardrobeConfig);
					}
					if (!changed)
						return;
					PersistAll();
					const auto  fo = FollowerDeck::StateJson();
					std::string open;
					{
						std::lock_guard l(g_configMutex);
						open = Wardrobe::OpenJson(g_wardrobeConfig, fo);
					}
					PushToView("wdOpen", open);
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "applying";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Category icons are config-only too, but their repaint is a fdConfig
			// push rather than a deck-icon refresh — different slice, different
			// bridge name — so they answer here instead of falling into the
			// shared tail below.
			// The Spell Deck's rail glyphs: same config-only shape, but the repaint
			// is an mdOpen push into the MAGIC view (its whole cfg snapshot — the
			// view's own open re-render, invoked in place).
			if (kind == "spell-cat-icons") {
				const bool changed = ApplyPortalSpellCatIcons();
				if (changed && g_magicOpen.load()) {
					SKSE::GetTaskInterface()->AddTask([]() {
						std::string cfg;
						{
							std::lock_guard l(g_configMutex);
							cfg = MagicConfigToJson(g_magicConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
						}
						PushToMagicView("mdOpen", cfg);
					});
				}
				json res2 = json::object();
				res2["ok"] = true;
				res2["changed"] = changed;
				res2["msg"] = changed ? "applied" : "nothing to apply";
				return res2.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Finance ops are config-only, but the repaint reads GOLD, which walks
			// the player's inventory — main thread only (the Finances-tab CTD of
			// 2026-07-30 came from exactly that walk). Same shape as wardrobe:
			// apply the sidecar, then push a fresh finOpen so an open Finances
			// tab updates in place; with the tab closed the push is a no-op and
			// the row (or its new icon) is simply there on the next open.
			if (kind == "finances") {
				SKSE::GetTaskInterface()->AddTask([]() {
					bool changed = false;
					{
						std::lock_guard l(g_configMutex);
						changed = Finance::ApplyPortalFinances(g_finConfig);
					}
					if (!changed)
						return;
					PersistAll();
					const std::string icons = DeckCustomIconsJson();  // file scan; no config lock
					std::string       open;
					{
						std::lock_guard l(g_configMutex);
						open = Finance::OpenJson(g_finConfig, icons);
					}
					PushToView("finOpen", open);
					logger::info("live api: finances applied");
				});
				res["ok"] = true;
				res["queued"] = true;
				res["msg"] = "applying";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			if (kind == "cat-icons") {
				const bool changed = ApplyPortalCatIcons();
				if (changed) {
					SKSE::GetTaskInterface()->AddTask([]() {
						std::string fcfg;
						{
							std::lock_guard l(g_configMutex);
							fcfg = FollowerConfigToJson(g_folConfig).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
						}
						PushToView("fdConfig", fcfg);
					});
				}
				res["ok"] = true;
				res["changed"] = changed;
				res["msg"] = changed ? "applied" : "nothing to apply";
				return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			}

			// Config-only from here — safe on this thread, exactly as the poller does.
			bool changed = false;
			if (kind == "spell-icons")       changed = ApplyPortalAssignments(magicCustom);
			else if (kind == "hotkey-icons") changed = ApplyPortalHotkeyIcons(deckCustom);
			else if (kind == "hotkey-edits") changed = ApplyPortalHotkeyEdits(deckDir);

			if (changed) {
				const bool magic = (kind == "spell-icons");
				SKSE::GetTaskInterface()->AddTask([magic]() {
					if (magic)
						RefreshMagicIcons();
					else
						RefreshDeckIcons();
				});
			}
			res["ok"] = true;
			res["changed"] = changed;
			res["msg"] = changed ? "applied" : "nothing to apply";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		} catch (const std::exception& ex) {
			logger::error("live api: {}", ex.what());
			res["msg"] = "error";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
	}

	void StartPortalPoller()
	{
		std::thread(PortalPollLoop).detach();  // lives for the whole process
	}

	// ------------------------------------------------------------- input sink

	class OpenKeySink final : public RE::BSTEventSink<RE::InputEvent*>
	{
	public:
		static OpenKeySink* GetSingleton()
		{
			static OpenKeySink s;
			return &s;
		}

		RE::BSEventNotifyControl ProcessEvent(RE::InputEvent* const* a_events, RE::BSTEventSource<RE::InputEvent*>*) override
		{
			if (!a_events || !g_prisma)
				return RE::BSEventNotifyControl::kContinue;

			std::string   dev, devMagic, devAdd, devFol, devDom, devCont, devHud, devHb;
			std::uint32_t code, codeMagic, codeAdd, codeFol, codeDom, codeCont, codeHud, codeHb;
			ModAction     msShift, msCtrl, msAlt;
			{
				std::lock_guard l(g_configMutex);
				dev       = g_config.settings.openDevice;
				code      = g_config.settings.openCode;
				devMagic  = g_magicConfig.openDevice;
				codeMagic = g_magicConfig.openCode;
				devAdd    = g_magicConfig.addDevice;
				codeAdd   = g_magicConfig.addCode;
				devFol    = g_folConfig.openDevice;
				codeFol   = g_folConfig.openCode;
				devDom    = g_domConfig.openDevice;
				codeDom   = g_domConfig.openCode;
				devCont   = g_contConfig.openDevice;
				codeCont  = g_contConfig.openCode;
				devHud    = g_hudConfig.keyDevice;
				codeHud   = g_hudConfig.keyCode;
				devHb     = g_hbConfig.keyDevice;
				codeHb    = g_hbConfig.keyCode;
				msShift   = g_config.settings.openShift;
				msCtrl    = g_config.settings.openCtrl;
				msAlt     = g_config.settings.openAlt;
			}

			for (auto e = *a_events; e; e = e->next) {
				const auto btn = e->AsButtonEvent();
				if (!btn || !btn->IsDown())
					continue;
				const auto device = btn->GetDevice();

				// If real hardware ever delivers an extended F-key natively, stop
				// bridging that key so presses don't double-fire.
				if (device == RE::INPUT_DEVICE::kKeyboard && IsExtCode(btn->GetIDCode()) &&
					btn->QUserEvent() != ExtEventTag()) {
					for (std::size_t i = 0; i < kExtCount; ++i)
						if (kExtFaithfulDik[i] == btn->GetIDCode() && !g_extHwSeen[i].exchange(true))
							logger::info("hardware delivers {} (code {}) natively — bridge disabled for it",
								kExtNames[i], btn->GetIDCode());
				}

				// --- photo mode owns the keyboard while it is up -----------------
				// FIRST, deliberately: everything below assumes a palette is open
				// or that keys should reach the view, and in photo mode no palette
				// is open and the player is flying a camera. PhotoModeActive()
				// also enforces the timeout, so a forgotten photo mode cannot
				// leave the world frozen.
				if (PortraitCapture::PhotoModeActive() && device == RE::INPUT_DEVICE::kKeyboard) {
					const auto pcode = btn->GetIDCode();
					if (btn->IsDown() && pcode == 0x12) {   // E
						SKSE::GetTaskInterface()->AddTask([]() { PortraitCapture::PhotoShootNow(); });
						continue;
					}
					if (btn->IsDown() && pcode == 0x01) {   // Esc
						SKSE::GetTaskInterface()->AddTask([]() { PortraitCapture::PhotoCancel(); });
						continue;
					}
					// Everything else (WASD, mouse look) is left alone on purpose —
					// that IS the camera you are flying.
					continue;
				}

				// --- grab drag: an NPC is riding the camera -----------------------
				// Same shape as photo mode: no palette is open, mouse look IS the
				// control. Click / E / Esc drops; the wheel adjusts carry distance;
				// the deck open key drops AND falls through, so the palette still
				// opens on top of the freshly dropped NPC. This sink cannot consume
				// events, so the game also sees the drop key (an E may activate, a
				// click may swing) — the drop lands first, same frame.
				if (NpcActions::DragActive()) {
					const auto gcode = btn->GetIDCode();
					bool       drop = false;
					bool       handled = false;
					if (device == RE::INPUT_DEVICE::kKeyboard) {
						if (gcode == 0x12 || gcode == 0x01) {          // E / Esc
							drop = true;
							handled = true;
						} else if (dev == "keyboard" && gcode == code) {  // deck key
							drop = true;                                  // ...and fall through
						}
					} else if (device == RE::INPUT_DEVICE::kMouse) {
						if (gcode == 0 || gcode == 1) {                // L / R click
							drop = true;
							handled = true;
						} else if (gcode == 8 || gcode == 9) {         // wheel up / down
							const bool closer = gcode == 9;
							SKSE::GetTaskInterface()->AddTask([closer]() {
								NpcActions::NudgeDragDistance(closer);
							});
							handled = true;
						} else if (dev == "mouse" && gcode == code) {  // deck key on mouse
							drop = true;
						}
					}
					if (drop)
						SKSE::GetTaskInterface()->AddTask([]() { NpcActions::DropDrag("drop input"); });
					if (handled)
						continue;
				}

				// Forward Mouse4/Mouse5 to the capture modal — Ultralight doesn't
				// reliably receive X-button events in-game, but this sink always does.
				// (Middle-click reaches the webview natively, so it isn't forwarded.)
				if (g_capturing.load() && AnyOpen() && device == RE::INPUT_DEVICE::kMouse) {
					const auto mcode = btn->GetIDCode();
					if (mcode == 3 || mcode == 4) {
						const std::string js = "hdNativeMouse(" + json{
							{ "code", mcode },
							{ "label", mcode == 3 ? "Mouse 4" : "Mouse 5" }
						}.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) + ")";
						const PrismaView  view = ActiveView();
						SKSE::GetTaskInterface()->AddTask([js, view]() {
							if (g_prisma && ActiveViewReady() && AnyOpen())
								g_prisma->Invoke(view, js.c_str());
						});
						continue;
					}
				}

				// Guaranteed Esc-close: the webview may not receive/act on Escape,
				// but this sink always sees it. (Skipped while the capture modal is
				// up — Esc cancels the capture there instead.)
				if (AnyOpen() && !g_capturing.load() &&
					device == RE::INPUT_DEVICE::kKeyboard && btn->GetIDCode() == 0x01) {
					// Both closers are self-guarded, so only the open one acts.
					SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); CloseMagicPalette(); });
					break;
				}

				// Escape while DESYNCED (view shown + focus held, but both palettes
				// claim to be closed). The branch above cannot fire here because
				// AnyOpen() is false -- which is precisely why the player was
				// stranded. One press gets out.
				if (device == RE::INPUT_DEVICE::kKeyboard && btn->GetIDCode() == 0x01 &&
					PalettesDesynced()) {
					SKSE::GetTaskInterface()->AddTask([]() {
						ForceClosePalettes("Escape while focus held but no palette open");
					});
					break;
				}

				// Panic key: HOLD Escape. Independent of every flag we keep, so it
				// works in states we have not thought of -- including ones where the
				// view is alive and simply refusing to let go.
				if (device == RE::INPUT_DEVICE::kKeyboard && btn->GetIDCode() == 0x01 &&
					btn->HeldDuration() >= kEscHoldPanicSec &&
					(AnyOpen() || PalettesDesynced() || (g_prisma && g_prisma->HasAnyActiveFocus()))) {
					SKSE::GetTaskInterface()->AddTask([]() {
						ForceClosePalettes("Escape held");
					});
					break;
				}

				// --- escape hatches for a WEDGED capture ---------------------------
				// Everything below hands the key to the view, so these must come
				// first or they are unreachable. See the note on g_captureStartMs.
				if (g_capturing.load() && AnyOpen()) {
					const long long now   = NowMs();
					const long long began = g_captureStartMs.load();

					// (2) Watchdog: a real "press a key" capture is over in a second
					// or two. This one is not coming back — any key gets you out.
					if (began != 0 && now - began > kCaptureWedgedMs) {
						ForceCloseWedgedCapture("capture stuck > 20 s");
						break;
					}

					// (1) Double-tap Escape. The first Esc still falls through to the
					// view so a healthy capture cancels normally; only a second one
					// inside the window overrides it.
					if (device == RE::INPUT_DEVICE::kKeyboard && btn->GetIDCode() == 0x01) {
						const long long prev = g_lastEscMs.exchange(now);
						if (prev != 0 && now - prev <= kCaptureEscWindowMs) {
							ForceCloseWedgedCapture("Escape pressed twice");
							break;
						}
					}
				}

				// During a rebind capture the key belongs to the webview (including the
				// bridge-injected ext code, e.g. F18->105) — never toggle a palette here.
				if (g_capturing.load())
					continue;

				const bool isKb = device == RE::INPUT_DEVICE::kKeyboard;
				const bool isMs = device == RE::INPUT_DEVICE::kMouse;
				const auto idc  = btn->GetIDCode();

				// --- Followers HUD: arming the show/hide key --------------------
				// The deck's "Set show/hide key" put us in arming mode; the NEXT
				// real press becomes the toggle key. Works for any device incl.
				// F13-F24 and mouse buttons (which the webview cannot capture).
				// Escape cancels the bind instead of binding Escape.
				if (g_hudKeyArming.load() && (isKb || isMs) && idc != 0) {
					const bool cancel = isKb && idc == 0x01;
					if (!cancel) {
						std::lock_guard l(g_configMutex);
						g_hudConfig.keyDevice = isKb ? "keyboard" : "mouse";
						g_hudConfig.keyCode = idc;
						g_hudConfig.keyLabel = (isKb ? "Key " : "Mouse ") + std::to_string((int)idc);
					}
					g_hudKeyArming = false;
					SKSE::GetTaskInterface()->AddTask([]() { PersistAll(); HudPushDeckState(); });
					break;  // consume the bind press
				}

				// --- Followers HUD: the show/hide toggle key -------------------
				// Independent of any palette (it is its own overlay). Skipped while
				// our view owns the keyboard so it never fires from a search field.
				if (codeHud != 0 && !OurViewHasKeyboard() &&
					((isKb && devHud == "keyboard") || (isMs && devHud == "mouse")) && idc == codeHud) {
					SKSE::GetTaskInterface()->AddTask([]() { HudToggleVisible(); });
					break;
				}

				// --- Hotbar: its own show/hide toggle key ---------------------
				// Same shape and same guards as the HUD's above. This is the key
				// bound from the bar's OWN editor; the seeded "Action Bar:
				// Show/Hide" deck action is the other route and they coexist.
				// Tested BEFORE the slot keys so binding the toggle to a key that
				// is also a slot key still toggles rather than firing button N.
				if (codeHb != 0 && !OurViewHasKeyboard() &&
					((isKb && devHb == "keyboard") || (isMs && devHb == "mouse")) && idc == codeHb) {
					SKSE::GetTaskInterface()->AddTask([]() { HbToggleVisible(); });
					break;
				}

				// Capture key: inside the vanilla Magic Menu (palettes closed), send
				// the highlighted spell straight into the Spell Deck.
				if (!AnyOpen() && codeAdd != 0 &&
					((isKb && devAdd == "keyboard") || (isMs && devAdd == "mouse")) && idc == codeAdd) {
					if (auto* mui = RE::UI::GetSingleton(); mui && mui->IsMenuOpen(RE::MagicMenu::MENU_NAME)) {
						SKSE::GetTaskInterface()->AddTask([]() { DoAddHighlighted(); });
						break;
					}
				}

				// Hotbar slot keys: palette CLOSED and the game UNPAUSED only. A
				// paused game means a menu owns the keyboard — inventory, map, and
				// above all the CONSOLE, where typing "1" must not cast Fireball.
				// Tested before the per-entry trigger so a bar button wins a shared
				// key (the bar is the thing you are looking at).
				//
				// ⚠ This sink cannot CONSUME events, so a slot key also does its
				// vanilla job — which for 1-8 is the favourites hotkey. The edit
				// panel warns about exactly that and offers the numpad instead.
				if (!AnyOpen()) {
					auto* pui = RE::UI::GetSingleton();
					if (!pui || !pui->GameIsPaused()) {
						const int slot = HbSlotForKey(isKb, isMs, idc);
						if (slot >= 0) {
							const int pg = g_hbLivePage.load();
							SKSE::GetTaskInterface()->AddTask([pg, slot]() { HbFireSlot(pg, slot); });
							break;
						}
					}
				}

				// Global per-entry trigger: palette CLOSED only. With the deck open the
				// view owns the keyboard and its own rows do the firing, so checking
				// here would double-fire. Tested before the open-key matches so a
				// trigger can share a key with nothing else we handle.
				if (!AnyOpen()) {
					const auto trigId = TriggerMatch(isKb, isMs, idc);
					if (!trigId.empty()) {
						SKSE::GetTaskInterface()->AddTask([trigId]() {
							FireEntryById(trigId, "key");
						});
						break;
					}
				}

				// --- a grab we handed to OMO is live -------------------------------
				// The click that ends the drag normally (left = place, right = put
				// back) clears the flag — same event OMO acts on. The DECK KEY
				// cancels instead of opening ("hitting F7 again should cancel
				// grab"): synthesize OMO's own Cancel input and swallow the open.
				if (NpcActions::OmoGrabActive()) {
					if (isMs && (idc == 0 || idc == 1)) {
						const bool placed = idc == 0;
						SKSE::GetTaskInterface()->AddTask([placed]() {
							NpcActions::OmoGrabEnded(placed ? "left click (placed)" : "right click (put back)");
						});
						// fall through — the click is OMO's to act on
					} else if (((isKb && dev == "keyboard") || (isMs && dev == "mouse")) && idc == code) {
						SKSE::GetTaskInterface()->AddTask([]() { NpcActions::CancelOmoGrab(); });
						SynthOmoCancelClick();
						break;   // F7 is the cancel this time, not the deck
					}
				}

				const bool matchDeck =
					((isKb && dev == "keyboard") || (isMs && dev == "mouse")) && idc == code;
				const bool matchMagic =
					((isKb && devMagic == "keyboard") || (isMs && devMagic == "mouse")) && idc == codeMagic;
				const bool matchFol =
					((isKb && devFol == "keyboard") || (isMs && devFol == "mouse")) && idc == codeFol;
				const bool matchDom =
					((isKb && devDom == "keyboard") || (isMs && devDom == "mouse")) && idc == codeDom;
				const bool matchCont =
					((isKb && devCont == "keyboard") || (isMs && devCont == "mouse")) && idc == codeCont;
				if (!matchDeck && !matchMagic && !matchFol && !matchDom && !matchCont)
					continue;

				if (matchDeck) {
					// Shift / Ctrl / Alt + deck open key (palette closed) = quick-fire that
					// slot's key instead of opening the menu. Priority: Shift > Ctrl > Alt.
					if (!g_open.load() && CanOpenNow()) {
						const ModAction* slot = nullptr;
						if ((GetAsyncKeyState(VK_SHIFT) & 0x8000) && msShift.Active())        slot = &msShift;
						else if ((GetAsyncKeyState(VK_CONTROL) & 0x8000) && msCtrl.Active())  slot = &msCtrl;
						else if ((GetAsyncKeyState(VK_MENU) & 0x8000) && msAlt.Active())      slot = &msAlt;
						// A SURFACE slot deep-opens the deck instead of firing a
						// key — Ctrl+F7 = the Wheel Menu by default. Ahead of the
						// key branch because a surface slot has no key to fire,
						// and it takes the g_pendingTab road every other
						// deep-open key (F14/F15/F16) already travels.
						if (slot && !slot->surface.empty()) {
							const std::string surf = slot->surface;
							SKSE::GetTaskInterface()->AddTask([surf]() {
								g_pendingTab = surf;
								EnsureViewAndOpen();
							});
							break;
						}
						if (slot && slot->code && ValidDevice(slot->device)) {
							// The one fire the player never sees a row for — it
							// skips the palette entirely, so the history is the
							// only place it shows up at all.
							HotkeyHistory::Record(HotkeyHistory::Source::kQuickFire,
								slot->label.empty() ? std::string("Quick-fire") : slot->label,
								slot->label, "Quick-fire");
							FireModAction(slot->device, slot->code);
							break;
						}
					}
					if (g_open.load()) {
						// Open key is a toggle: pressing it again closes the palette
						// (also doubles as the lost-focus failsafe reset).
						SKSE::GetTaskInterface()->AddTask([]() { ClosePalette(); });
					} else if (CanOpenNow()) {
						SKSE::GetTaskInterface()->AddTask([]() { EnsureViewAndOpen(); });
					}
					break;
				}

				if (matchMagic) {
					// F18 (or its faithful bridge code) toggles the Spell Deck.
					// CanOpenNow() gates on PrismaUI focus, so the views stay mutually
					// exclusive — the magic view won't open while another holds focus.
					if (g_magicOpen.load()) {
						SKSE::GetTaskInterface()->AddTask([]() { CloseMagicPalette(); });
					} else if (CanOpenNow()) {
						SKSE::GetTaskInterface()->AddTask([]() { EnsureMagicViewAndOpen(); });
					}
					break;
				}

				// matchFol / matchDom / matchCont: F14 (Followers) / F15 (Domains) /
				// F16 (Containers) deep-open the deck on their tab. While the palette
				// is open the view decides (same tab = close, other tab = switch) via
				// hdShowTab.
				{
					const char* tab = matchFol ? "followers" : matchDom ? "domains" : "containers";
					if (g_open.load()) {
						SKSE::GetTaskInterface()->AddTask([tab]() {
							if (g_prisma && g_viewReady.load() && g_open.load())
								g_prisma->Invoke(g_view, (std::string("hdShowTab(\"") + tab + "\")").c_str());
						});
					} else if (CanOpenNow()) {
						SKSE::GetTaskInterface()->AddTask([tab]() {
							g_pendingTab = tab;
							EnsureViewAndOpen();
						});
					}
				}
				break;
			}
			// While the player is typing into OUR ui, no other mod should be acting
			// on those keystrokes. Returning kStop ends propagation, so downstream
			// input sinks never see them.
			//
			// This is what makes the search box SAFE rather than merely recoverable:
			// on 2026-08-01 typing "sav" fired CHIM's dialogue key (bound to V),
			// CHIM opened its own PrismaUI view, the two views fought over the single
			// focus slot and the deck was stranded. Rober should not have to keep
			// letters off every other mod's hotkeys just to use a search field.
			//
			// Honest limit: BSTEventSource dispatches in REGISTRATION order, so this
			// only stops sinks registered after ours. It is strictly better and it is
			// the correct thing to do, but it is not a guarantee against every mod --
			// which is exactly why the watchdog above exists as the backstop.
			if (OurViewHasKeyboard())
				return RE::BSEventNotifyControl::kStop;
			return RE::BSEventNotifyControl::kContinue;
		}
	};

	// ------------------------------------------------------------------ setup

	void SetupLog()
	{
		auto path = SKSE::log::log_directory();
		if (!path)
			return;
		*path /= "HotkeyDeck.log";
#ifdef NDEBUG
		auto sink = std::make_shared<spdlog::sinks::basic_file_sink_mt>(path->string(), true);
#else
		auto sink = std::make_shared<spdlog::sinks::msvc_sink_mt>();
#endif
		auto log = std::make_shared<spdlog::logger>("global", std::move(sink));
		log->set_level(spdlog::level::info);
		log->flush_on(spdlog::level::info);
		spdlog::set_default_logger(std::move(log));
		spdlog::set_pattern("[%H:%M:%S.%e] [%l] %v");
	}

	void SKSEMessageHandler(SKSE::MessagingInterface::Message* message)
	{
		if (!message)
			return;
		// A loaded save (or a new game) is when Follower Organizer's roster exists,
		// so it is when the Deck Portal's NPC-field replay may safely run. The
		// config-only sidecars (spell / hotkey icons) need no such gate and apply
		// even while the game sits on the main menu.
		// A load is starting: the roster/actors are about to be torn down, so stop the
		// poller from replaying NPC fields until the load reports success.
		if (message->type == SKSE::MessagingInterface::kPreLoadGame) {
			g_gameReady = false;
			// A load tears down the session — make sure smooth-pause never carries a
			// frozen world into it (the deck should already be closed, but be sure).
			FreezeWorld(false);
			// Fertility Mode's storage quest is cached as a bound VM object, and a
			// handle from the outgoing session is not valid in the next one.
			FertilityBridge::Invalidate();
			return;
		}
		if (message->type == SKSE::MessagingInterface::kPostLoadGame) {
			if (message->data)  // data = "the load succeeded"
				g_gameReady = true;
			// A grab drag must never survive a load — the dynamic FormIDs it
			// holds may have been remapped, and a tick would fling whatever
			// they now resolve to.
			NpcActions::OnPostLoadGame();
			// Loot glows PERSIST in the save (ReferenceEffects serialize) and the
			// tracking map does not — sweep them before the scanner repopulates,
			// and drop the session "opened" set, which described the old save.
			LootHighlight::OnPostLoadGame();
		// Crawl faction membership persists in the save; the forced sneak does
		// not — re-assert it on the player if they are still a crawl member.
		AnimActions::OnPostLoadGame();
			// Release any furniture a PREVIOUS session left blocked. BlockActivation
			// lives on the reference and persists in the save, so a claim that ended
			// while refs were blocked (config edited outside the game, mod removed and
			// re-added, crash mid-claim) would otherwise leave chairs permanently
			// unusable. This has to run HERE and not at kDataLoaded: with no save
			// loaded the ref FormIDs do not resolve, so clearing the record there
			// would drop the only evidence of what to unblock. The tick re-blocks
			// whatever is still legitimately claimed within a second or two.
			if (g_gameReady) {
				bool cleared = false;
				{
					std::lock_guard l(g_configMutex);
					cleared = RoomGuard::UnblockAll(g_roomConfig);
				}
				if (cleared)
					PersistAll();
				// Distributor gear a load just re-applied — strip it from protected
				// NPCs before it is seen (source-agnostic: SPID or SkyPatcher). The
				// periodic tick mops up any actor still attaching a beat later.
				{
					std::lock_guard l(g_configMutex);
					NoAutoGear::OnPostLoadGame(g_ngConfig);
				}
				// SPID Gear: the session inbox chest is a dynamic ref — forget
				// it (touches only session statics, no lock needed).
				SpidGear::OnPostLoadGame();
				/* Put back everything the deck promised to maintain about a
				   follower. HERE and not at kDataLoaded, for the same reason as
				   the unblock above: with no save loaded the FormIDs do not
				   resolve. Deferred a beat because the actors we are about to
				   look up are still being attached as this fires. */
				std::thread([]() {
					std::this_thread::sleep_for(std::chrono::milliseconds(1500));
					SKSE::GetTaskInterface()->AddTask([]() {
						FollowerTune::Config snap;
						{
							std::lock_guard l(g_configMutex);
							snap = g_tuneConfig;
						}
						if (!snap.rows.empty())
							FollowerTune::Reapply(snap);
					});
				}).detach();
			}
			return;
		}
		if (message->type == SKSE::MessagingInterface::kNewGame) {
			g_gameReady = true;
			FertilityBridge::Invalidate();
			return;
		}
		if (message->type != SKSE::MessagingInterface::kDataLoaded)
			return;

		LoadConfig();
		NpcActions::Init();   // crosshair sink for freeze/sit/bed/release-all action entries
		QuestTools::Init();   // quest inspector; its alias index builds lazily on first use
		SpellActions::Init();  // Spell Deck backend (known-spell enum, cast, equip-toggle)
		PlaceActions::Init();  // Domains tab backend (location snapshot + recall marker)
		ContainerActions::Init();  // Containers tab backend (crosshair snapshot + remote open)
		RoomGuard::Init();     // Rooms tab backend (claim volumes + eviction marker)
		// Deck Portal: start its node server with the game and let the Job
		// Object take it down with us. Safe to do unattended because the portal
		// binds 127.0.0.1 unless a password is set (portal/server.js). A
		// missing Node is an ordinary state here, reported to the button rather
		// than logged as a fault.
		PortalHost::Start();
		LootHighlight::Init(); // Loot tab backend (glow scanner + container-open sink)
		NoAutoGear::Init();    // No Auto-Gear: strip distributor cloaks/hoods/underwear from tagged NPCs
		// SPID Gear: inbox chest → per-NPC SPID ini (F7 card). The callback runs
		// on the main thread when the inbox's transfer menu closes: read the
		// chest, persist, rewrite the ini, tell the card.
		SpidGear::Init([]() {
			std::string      res, state;
			SpidGear::Config snap;
			{
				std::lock_guard l(g_configMutex);
				res = SpidGear::Harvest(g_spidConfig);
				snap = g_spidConfig;
				state = SpidGear::StateJson(g_spidConfig, SpidGear::PendingRuntimeId());
			}
			SpidGear::WriteIni(snap);
			PersistAll();
			PushToView("sgResult", res);
			PushToView("sgState", state);
			const auto jr = json::parse(res, nullptr, false);
			if (!jr.is_discarded()) {
				const auto msg = jr.value("msg", std::string(""));
				if (!msg.empty())
					RE::DebugNotification(msg.c_str());
			}
		});
		// Spell-icon library, built at runtime from the user's OWN Spell Hotbar 2
		// install instead of shipping 1,913 PNGs of someone else's art (see
		// src/icon_bridge.h). Background thread, cached against a source stamp,
		// and completely inert when Spell Hotbar isn't installed — in which case
		// IconIndexJsonAt() still answers "null" and both views keep their SVG
		// glyphs. On a rebuild it drops the once-per-session latches so the next
		// palette open pushes the FRESH index rather than the one from boot.
		IconBridge::Start([]() {
			g_iconIndexPushed = false;
			g_deckIconIndexPushed = false;
		});
		AnimActions::Init();   // Animations tab: load zap-catalog.json + resolve crawl faction
		OstimDeck::Init();     // OStim segment: reset cache (Thread API acquired lazily on first open)
		Finance::Init();       // Finances tab backend (gold move + settle/buy/sell)
		Wardrobe::Init();      // Wardrobe tab backend (SOES-NG pools, cadence, builds)
		ItemIcons::Init();     // armour renders via Mesh Rendering Framework (soft-bound)
		ItemIcons::SetOnBatchDone([]() {
			PushToView("wdItemIcons", ItemIcons::IndexJson());
		});

		g_prisma = static_cast<PRISMA_UI_API::IVPrismaUI1*>(
			PRISMA_UI_API::RequestPluginAPI(PRISMA_UI_API::InterfaceVersion::V1));
		if (!g_prisma) {
			logger::error("PrismaUI.dll not found — is the PrismaUI framework installed and enabled?");
			return;
		}

		// View is created lazily on the first open-key press (EnsureViewAndOpen) so this
		// plugin adds nothing to game startup or the save-load window.

		// The Followers HUD view is the exception — it is always-on, so it is
		// created HERE (Shown per config, never Focused except to reposition). The
		// ticker idles while the HUD is disabled, so an off HUD costs nothing.
		CreateHudView();
		StartHudTicker();

		// Same deal for the Hotbar — always-on, so created here rather than on a
		// key press. Its poller also idles while the bar is disabled.
		CreateHotbarView();
		StartHotbarTicker();

		if (auto idm = RE::BSInputDeviceManager::GetSingleton()) {
			idm->AddEventSink(OpenKeySink::GetSingleton());
			logger::info("input sink registered");
		} else {
			logger::critical("BSInputDeviceManager unavailable — open key will not work");
		}

		// Seed the portal's portrait queue BEFORE anything can consume it, and
		// before the player can reach the portal. MO2 fixes the visible file list
		// at launch, so this file has to exist by now or a phone upload made this
		// session is invisible until the next launch. Non-destructive: a queue the
		// portal left while the game was closed is preserved and applied normally.
		EnsurePortraitBridge(false);
		// Same law, same reason, for the phone's category-icon queue: seed it now
		// or a glyph chosen on the phone this session cannot be seen by the game.
		EnsureCatIconBridge(false);
		EnsureSpellCatIconBridge(false);  // and the Spell Deck rail's twin

		StartExtBridge();
		StartPortalPoller();  // outside the lock below: its first act is a 1 s sleep
		// Fast path for the portal. The poller above stays as the durable fallback:
		// anything queued while the game is closed still lands on the next launch.
		LiveApi::Start("HotkeyDeck", OnLiveApiRequest);

		std::lock_guard l(g_configMutex);
		logger::info("HotkeyDeck ready — open key: {} code {} ({}), {} entries",
			g_config.settings.openDevice, g_config.settings.openCode,
			g_config.settings.openLabel, g_config.entries.size());
		logger::info("F13-F24 bridge {} — F24 -> DIK {}",
			g_config.settings.extEnabled ? "active" : "off (extKeys.enabled=false)",
			g_config.settings.extMap[11]);
		logger::info("Quick-fire slots -- Shift:{} Ctrl:{} Alt:{}",
			g_config.settings.openShift.code, g_config.settings.openCtrl.code, g_config.settings.openAlt.code);
		logger::info("Spell Deck ready -- open key: {} code {} ({}), {} categories / {} spells",
			g_magicConfig.openDevice, g_magicConfig.openCode, g_magicConfig.openLabel,
			g_magicConfig.categories.size(), g_magicConfig.spells.size());
		logger::info("Spell Deck capture key: {} code {} ({}), removeOnAdd={}",
			g_magicConfig.addDevice, g_magicConfig.addCode, g_magicConfig.addLabel,
			g_magicConfig.removeOnAdd);
		logger::info("Followers tab ready -- deep-open key: {} code {} ({}); FO Deck API {}",
			g_folConfig.openDevice, g_folConfig.openCode, g_folConfig.openLabel,
			FollowerDeck::Available() ? "resolved" : "MISSING (needs the patched Follower Organizer >= 0.2.0)");
		logger::info("Domains tab ready -- deep-open key: {} code {} ({}), {} categories / {} marks",
			g_domConfig.openDevice, g_domConfig.openCode, g_domConfig.openLabel,
			g_domConfig.categories.size(), g_domConfig.marks.size());
		logger::info("Deck Portal poller active (1 s) -- spell icons / hotkey icons / hotkey edits / NPC fields apply live");
	}
}

extern "C" DLLEXPORT bool SKSEAPI SKSEPlugin_Load(const SKSE::LoadInterface* a_skse)
{
	REL::Module::reset();

	auto g_messaging = reinterpret_cast<SKSE::MessagingInterface*>(
		a_skse->QueryInterface(SKSE::LoadInterface::kMessaging));
	if (!g_messaging)
		return false;

	SKSE::Init(a_skse, false);  // a_log=false: we install our own sink in SetupLog()
	SetupLog();
	SKSE::AllocTrampoline(1 << 10);

	g_messaging->RegisterListener("SKSE", SKSEMessageHandler);

	logger::info("HotkeyDeck 0.14.0 loaded (Portrait capture: fire \"Capture Portrait\" in the CHIM tab while looking at an NPC and their face is saved as their portrait -- the head NODE is projected to screen space so the crop tracks the face at any distance, the frame comes straight off the D3D11 back buffer [this rig's vanilla screenshot path is broken and ENB owns the key], the HUD is hidden for the grab and always restored, and the plugin does the write so MO2's launch-time VFS cannot hide it; unbound by default; 0.13.2 Spell Deck adjustable icon size 28-96px; fix: the Spells launcher now waits for the deck to release PrismaUI focus instead of giving up after one frame; 0.13.0 Finances tab: recurring income/expense/tax lines + a monthly Settle that nets income vs expenses + rolling debt against REAL gold [Gold001], Market buy/sell buttons that move gold, per-item images, a ledger -- editable in-deck and from the Deck Portal; 0.12.0 edit a hotkey from the phone: the Deck Portal renames / re-describes / re-files / REBINDS via a searchable DIK picker / deletes, queued into portal-hotkey-edits.json and applied live by the 1 s poller with per-field validation -- an action entry's verb and an unknown category are never touched; 0.11.0 per-hotkey icons: searchable picker in the deck + the Deck Portal, own icons/ tree with a MagicDeck custom-icon mirror; Spells launcher in the deck nav; LIVE portal apply -- a 1 s poller lands spell icons / hotkey icons / NPC fields without reopening a view; 0.10.0 NPC fields: relationship/home/occupation/faction on followers, deck + portal sidecar; 0.9.4 main deck XL: resizable + remembered size, all tabs; pointer-drag for Followers/Domains panes + Spell Deck combos [Ultralight has no HTML5 DnD]; 0.9.3 portal spell-icon assignment; 0.9.2 portraits + Deck Portal; 0.9.1 Spell Deck XL: resizable + larger type/icons; 0.9.0 one deck: Followers + Domains as top tabs w/ F14/F15 deep-open; Domains = mark a place, click to travel; 0.8.0 FO Deck API; 0.7.0 Spell Deck icons)");
	return true;
}
