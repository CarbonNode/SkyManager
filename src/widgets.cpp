#include "widgets.h"

#include "actor_identity.h"
#include "finance.h"
#include "hotbar.h"
#include "item_icons.h"
#include "ward_actions.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace Widgets
{
	using json = nlohmann::json;

	namespace
	{
		// ------------------------------------------------------------ model --
		struct Widget
		{
			// ⛔ OFF BY DEFAULT, and this is load-bearing. It used to be `true`,
			// which meant every widget ADDED LATER switched itself on inside the
			// saved config of someone who already had the feature: their file
			// simply has no key for the new one, so it took the default. Rober,
			// 2026-08-17, with a clock, a place and a carry bar he never asked
			// for on his screen: "widgets cut off, i never even enabled these."
			// A new widget must arrive silent. The four the feature shipped with
			// are turned on explicitly in Config() below, so a fresh install
			// still gets a sensible first set.
			bool        enabled = false;   // per-widget; the MASTER switch gates all
			int         x = 24;
			int         y = 24;
			std::string anchorH = "left";    // "left" | "center" | "right"
			std::string anchorV = "top";     // "top"  | "bottom"
			float       scale = 1.0f;        // 0.5–2.5
			float       opacity = 1.0f;      // 0.3–1.0
			bool        showLabel = true;
			bool        hideInMenus = true;  // drop while GameIsPaused (per widget)
			// "remove backgrounds just icon + value if i want" (Rober,
			// 2026-08-15): drops the plate, border and shadow and leaves the
			// glyph + number floating on the scene. The view keeps a text
			// shadow so it stays readable over snow and sky.
			bool        bare = false;
		};

		// The potions widget also chooses WHICH pools it shows. All on by
		// default — Rober's "one or all types of potions + their counts", and
		// (2026-08-15) "Poison support, food, drinks … water as well". The
		// water chip additionally hides itself in the VIEW when the live tick
		// says no water mod is present (waterOk:false) — the flag here only
		// records the player's choice.
		struct PotCats
		{
			bool heal = true, magicka = true, stamina = true, cure = true, all = true;
			bool poison = true, food = true, drink = true, water = true;
		};

		// ---- Potion AI (see widgets.h) ----------------------------------
		struct AiStat
		{
			bool on = false;
			int  pct = 20;
		};
		struct AiCfg
		{
			bool   enabled = false;
			bool   combatOnly = false;
			bool   notify = true;
			int    cooldownMs = 2500;
			AiStat health{ true, 25 };
			AiStat magicka{ false, 20 };
			AiStat stamina{ false, 15 };
		};

		// ---- trackers: pinned items + collectible sets -------------------
		// (Rober, 2026-08-17: "i like the idea of being able to pin any item as
		// well with a count as a widget", and the reference mod's second
		// screenshot — 18/24 Stones of Barenziah, 8/12 Dragon Claws, a finished
		// set that hides itself.)
		//
		// ONE struct serves both, because a collectible set IS a pin with a
		// goal and a quest link: `goal == 0` is a plain pin (show the count),
		// `goal > 0` is a set (show count/goal, and hide when the linked quest
		// completes). Two LISTS rather than one tagged list, because the view
		// draws them as two separate widgets and a tag would only be re-split
		// on the other side.
		//
		// Identity is (plugin + LOCAL formId), never a runtime id — the Elana
		// lesson in actor_identity.h: a light plugin's runtime id moves by
		// 0x1000 the moment any ESL ahead of it is enabled or disabled.
		constexpr int kMaxPins = 16;         // pin entries
		constexpr int kMaxSets = 12;         // collectible-set entries
		constexpr int kMaxRefsPerEntry = 32; // forms inside ONE entry (24 Stones
		                                     // are one form; 12 claws are twelve)

		struct TrackRef
		{
			std::string plugin;  // "" = unusable (dynamic / hand-edited)
			std::string formId;  // "0x……" plugin-local id
		};
		struct TrackEntry
		{
			std::string           id;              // stable slug, minted once
			std::string           label;
			std::string           icon;            // view-relative icons/… or ""
			bool                  enabled = true;
			int                   goal = 0;        // >0 = set tracker
			std::vector<TrackRef> items;
			TrackRef              quest;           // sets only; optional
			// ---- runtime only, never persisted --------------------------
			// Filled by ResolveList when the resolve generation moves; copied
			// into a TrackSnap for the lock-free live build.
			std::vector<RE::TESBoundObject*> resolved;
			RE::TESQuest*                    questForm = nullptr;
			bool                             anyMissing = true;
		};

		// ---- potion combos (see widgets.h) -------------------------------
		constexpr int kMaxComboItems = 8;
		struct ComboItem
		{
			std::string plugin;   // "" = dynamic, unresolvable across loads
			std::string formId;   // "0x……" local id, file-width masked
			std::string name;     // display fallback when the form is gone
		};
		struct Combo
		{
			std::string            id;     // stable slug — the deck entry rides it
			std::string            name;
			std::string            icon;   // view-relative icons/… path or ""
			std::vector<ComboItem> items;
		};

		// ---- custom quick items (round 4, 2026-08-18) --------------------
		// (Rober: "i want a secondary same exact widget where you can add any
		// item to it. and keybind each specific one if you care to" + "ability
		// to set how many items".) The FAVOURITES widget is the game's own
		// list and the player cannot curate it from the HUD; this is the twin
		// they own outright.
		//
		// STORED beyond what is DRAWN, deliberately: `quick2Max` decides how
		// many rows the live payload carries, the item list keeps everything.
		// Shrinking the widget therefore HIDES rows instead of eating them —
		// the hotbar's stored-at-24-draw-rows*cols law, and the same reason.
		constexpr int kMaxQuick2Items = 16;   // hard ceiling on the stored list
		constexpr int kQuick2MaxDefault = 8;  // rows drawn out of the box

		struct Quick2Item
		{
			std::string plugin;     // "" = unusable; a row without one is dropped
			std::string formId;     // "0x……" plugin-local id, file-width masked
			std::string name;       // display fallback when the form is gone
			// Optional per-item bind, in the hotbar slot-key shape so the input
			// sink matches it exactly the way it matches a bar slot.
			std::string keyDevice;  // "" = unbound; else "keyboard" | "mouse"
			int         keyCode = 0;
			std::string keyLabel;
			// ---- runtime only, never persisted --------------------------
			RE::TESBoundObject* resolved = nullptr;
			const char*         kind = "misc";
		};

		struct Config
		{
			// Master switch. Default OFF, like the hotbar and the Followers
			// HUD — a fresh install must never sprout an overlay nobody asked
			// for. The seeded "widgets-toggle" action (and the Home tab's UI
			// Elements row) flips it.
			bool    enabled = false;
			Widget  potions;
			PotCats cats;
			Widget  gold;
			Widget  lockpicks;
			Widget  carry;      // carry weight: current load / max capacity
			// The 2026-08-17 context widgets. Same Widget shape (position,
			// anchor, scale, opacity, bare, hideInMenus) — the view's whole
			// placement/edit UI works on them for free.
			Widget  weather;
			Widget  place;
			Widget  clock;
			Widget  mount;
			Widget  pins;
			Widget  sets;
			// ---- round 2, 2026-08-17: the PLAYER's own state ----------------
			// (Rober: "Keep polishing adding features we missed from the
			// reference mod" — Skyrim Party Sheet SSE 167538, MIT.) Six more
			// readouts on the same Widget shape, so the placement/edit UI, the
			// sidecar and the wgConfig push all carry them for free.
			//
			// All six default OFF, like every widget added after the original
			// four — a new widget must never appear in a config that predates
			// it. `resist` is off even in the Full preset — see the view's
			// PRESETS comment.
			Widget  vitals;    // hp / magicka / stamina + level, XP, shout timer
			Widget  effects;   // active buffs & debuffs with time remaining
			Widget  equip;     // what is in your hands right now, + ammo
			Widget  resist;    // the elemental / magic resist row
			Widget  survival;  // SunHelm's needs, read off its own globals
			Widget  allies;    // temporary quest allies fighting beside you
			// ---- round 3, 2026-08-17: the four Party-Sheet SLOT widgets -----
			// (Rober: "four widgets, ripped from this … fourth being one for
			// quick items … place anywhere on screen indvidually".) These are
			// FREE widgets: the HUD view draws each at its OWN
			// x/y/anchor/scale/opacity instead of inside the stacked assembly,
			// which is what finally makes the Widget placement fields
			// load-bearing on the hud side. All four inherit the struct's
			// enabled=false default AND set it explicitly below — the 7d810c8
			// lesson: a widget added later must arrive SILENT in every existing
			// save's config (a missing key takes the default).
			Widget  handR;     // right hand: weapon / spell / torch
			Widget  handL;     // left hand — shows the nocked ammo behind a bow
			Widget  voice;     // shout / power slot, with the recovery veil
			Widget  quick;     // quick items: everything you favourited, live counts
			// ---- ward (2026-09-01) -----------------------------------------
			// A fifth FREE widget: is a ward up right now? Reads the engine's
			// WardPower actor value (so a hand-cast ward lights it too) plus
			// WardActions' maintained flag; pairs with the "ward-toggle" deck
			// action. Same silent-arrival law as the other four.
			Widget  ward;      // ward up/down, strength, best known ward
			// ---- 2026-08-31: the season readout -----------------------------
			// A FREE widget too (Rober: "not apart of other widgets … drag,
			// move around, toggle on or off"), fed by Seasons of Skyrim's own
			// Papyrus API — see SeasonJson far below for why the month is never
			// enough on its own.
			Widget  season;
			// ---- round 4, 2026-08-18: the CUSTOM quick items ----------------
			// `quick` above is the game's own favourites and the player cannot
			// curate it from here. This is its twin, entirely theirs: any
			// carried item, in their order, each row optionally carrying its
			// own key. Default OFF like every widget added after the first four
			// (the 7d810c8 lesson: a widget added later must arrive SILENT).
			Widget                  quick2;
			int                     quick2Max = kQuick2MaxDefault;   // rows DRAWN, 1..16
			std::vector<Quick2Item> quick2Items;                     // rows STORED
			// The loot lamp: Loot Vision's glow master and Auto-Loot's master,
			// read through the provider main.cpp installs. This module never
			// learns what looting is — see SetLootStateProvider.
			Widget                  lootStatus;
			// ---- Time Dial (2026-08-18) ------------------------------------
			// The hotkey-openable circular wait dial (hud-td.js). Only its
			// PLACEMENT lives here — x/y/anchor/scale, so "remembers where it
			// was when the hotkey triggers" survives sessions. Its open/close
			// is runtime state in main.cpp (g_tdOpen), never persisted, and
			// `enabled` is deliberately unused: the dial draws only while
			// open, so it must NOT arm the live tick (RecountAnyLocked skips
			// it on purpose).
			Widget  timeDial;
			// How the mount widget chooses WHO to show. "ridden" = only while
			// you are actually on it (costs one GetMount call and nothing else);
			// "lastRidden" (default) also keeps showing the last horse you rode
			// while it is still alive, loaded and within kMountForget of you.
			// Deliberately NOT a scan of every nearby actor: a per-tick walk of
			// ProcessLists to find a horse you might own is exactly the kind of
			// steady-state cost this module spent 2026-08-16 deleting.
			std::string             mountFollow = "lastRidden";
			std::vector<TrackEntry> pinList;
			std::vector<TrackEntry> setList;
			// The potion browser's persisted prefs ({sort, cat}) — a raw blob
			// the VIEW owns the schema of; C++ only round-trips it.
			json browser = json::object();
			// The hud view's own draw prefs (detail toggles + detached-block
			// placements, schema in hud.js) — same opaque-blob law as
			// `browser`. Until 2026-08-18 the view SENT this and C++ dropped
			// it, so the detail switches never survived a restart.
			// Build marker (hd-markers.json: "widgets-hud-blob").
			json hudPrefs = json::object();
			// Potion AI + combos — C++ OWNS both (the AI drinks by these
			// numbers, FireCombo resolves these forms), so unlike `browser`
			// they are parsed and clamped, never round-tripped opaquely.
			AiCfg              ai;
			std::vector<Combo> combos;
			// How the smart potion buttons choose (2026-08-19). Owned by the
			// PICKER, parked here: every change is mirrored into Hotbar with
			// SmartPush() so the drink path never reads this struct.
			Hotbar::SmartPrefs smart;

			Config()
			{
				// The set the feature shipped with (2026-08-15). Explicit, so
				// that `enabled = false` above can protect everything added
				// afterwards without changing what an existing user sees.
				potions.enabled = true;
				gold.enabled = true;
				lockpicks.enabled = true;
				carry.enabled = true;

				// Defaults STACK down the top-left, deliberately clear of the
				// bar's bottom-centre default — the overlap pass's baseline.
				potions.y = 24;
				gold.y = 112;
				lockpicks.y = 196;
				carry.y = 280;
				// The context readouts stack down the RIGHT edge, clear of the
				// potion column — the reference mod's own arrangement is a row
				// of quick readouts, but the deck's widgets are individually
				// draggable, so a non-overlapping first paint is what matters.
				clock.anchorH = "right";   clock.x = 24;   clock.y = 24;
				weather.anchorH = "right"; weather.x = 24; weather.y = 96;
				place.anchorH = "right";   place.x = 24;   place.y = 168;
				mount.anchorH = "right";   mount.x = 24;   mount.y = 240;
				pins.anchorH = "center";   pins.anchorV = "bottom"; pins.x = 0; pins.y = 180;
				sets.anchorH = "right";    sets.anchorV = "bottom"; sets.x = 24; sets.y = 180;
				// The player's own state hangs off the BOTTOM-LEFT, clear of the
				// potion column (top-left) and the context column (top-right) —
				// so the first paint with everything on has no overlap to fix.
				vitals.anchorH = "left";   vitals.anchorV = "bottom"; vitals.x = 24; vitals.y = 260;
				effects.anchorH = "left";  effects.anchorV = "bottom"; effects.x = 24; effects.y = 190;
				equip.anchorH = "left";    equip.anchorV = "bottom"; equip.x = 24; equip.y = 96;
				resist.anchorH = "left";   resist.anchorV = "bottom"; resist.x = 24; resist.y = 24;
				survival.anchorH = "right"; survival.anchorV = "bottom"; survival.x = 24; survival.y = 300;
				allies.anchorH = "center"; allies.anchorV = "top"; allies.x = 0; allies.y = 24;
				// Defaults OFF for the four that are either niche (resist),
				// mod-gated (survival), situational (allies) or a duplicate of
				// what the vanilla HUD already draws (equip).
				resist.enabled = false;
				equip.enabled = false;
				survival.enabled = false;
				allies.enabled = false;
				// Round 3: the four slot widgets sit in a row above the vanilla
				// HUD's bottom-centre — the reference mod's own arrangement (R,
				// L, voice, then the quick strip). All OFF by default (a fresh
				// install sprouts nothing, an existing save's config stays
				// silent); placement pre-spread so the first enable has no
				// overlap to fix.
				handR.anchorH = "center"; handR.anchorV = "bottom"; handR.x = -250; handR.y = 96;
				handL.anchorH = "center"; handL.anchorV = "bottom"; handL.x = -125; handL.y = 96;
				voice.anchorH = "center"; voice.anchorV = "bottom"; voice.x = 0;    voice.y = 96;
				quick.anchorH = "center"; quick.anchorV = "bottom"; quick.x = 235;  quick.y = 96;
				handR.enabled = false;
				handL.enabled = false;
				voice.enabled = false;
				quick.enabled = false;
				// Ward: left of the slot row, same shelf, same silence. -520
				// matches hud.js's wfree.ward default exactly (the two must
				// agree or a fresh install jumps on first config push), and
				// clears the 158px cards' handR at -352.
				ward.anchorH = "center"; ward.anchorV = "bottom"; ward.x = -520; ward.y = 96;
				ward.enabled = false;
				// Season (2026-08-31): a FREE widget like the four above, so it
				// gets its own spot rather than a line in someone else's stack
				// (Rober: "not apart of other widgets"). Parked top-right and
				// BELOW the context column's default four, so turning it on
				// while clock/weather/place/mount are up still lands clear.
				season.anchorH = "right"; season.anchorV = "top";
				season.x = 24; season.y = 320;
				season.enabled = false;
				// Round 4: the custom quick strip sits one row ABOVE the
				// favourites strip (same x, +54 y) so enabling both at once
				// has no overlap to fix; the loot lamp hangs off the
				// bottom-right, under the survival meters.
				quick2.anchorH = "center"; quick2.anchorV = "bottom";
				quick2.x = 235; quick2.y = 150;
				quick2.enabled = false;
				lootStatus.anchorH = "right"; lootStatus.anchorV = "bottom";
				lootStatus.x = 24; lootStatus.y = 372;
				lootStatus.enabled = false;
				// Time Dial: first open lands centred, upper third of the
				// screen — clear of the free-widget row along the bottom.
				timeDial.anchorH = "center"; timeDial.anchorV = "top";
				timeDial.x = 0; timeDial.y = 120;
				timeDial.enabled = false;
			}
		};

		Config            g_cfg;
		json              g_extra = json::object();  // unknown sidecar keys, kept verbatim
		std::mutex        g_mtx;
		std::atomic<bool> g_any{ false };
		// The two halves of g_any, kept apart so a caller can ask about ONE
		// system (see RecountAnyLocked's note on the visibility split).
		std::atomic<bool> g_anyStack{ false };   // in-panel readouts, behind the stack master
		std::atomic<bool> g_anyFree{ false };    // free widgets, behind their own switches
		bool              g_loaded = false;

		std::string ClampAnchorH(const std::string& s)
		{
			return (s == "center" || s == "right") ? s : "left";
		}
		std::string ClampAnchorV(const std::string& s)
		{
			return s == "bottom" ? "bottom" : "top";
		}

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "widgets.json";
		}

		std::string Dump(const json& j)
		{
			// error_handler replace: a mod name with a broken byte must never
			// make the dump throw (the anim-scan CTD lesson).
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		// ⚠ THE VISIBILITY SPLIT (marker widgets-vis-split). Rober, 2026-08-19:
		// "if hud widgets is off, other widgets stop showing, dont do that
		// (equipped widget)" … "follower hud should be seperate, equipement
		// widget should be seperate, and so should hud element".
		//
		// `g_cfg.enabled` is the READOUT STACK's master switch (the thing the
		// Home drawer calls "HUD Widgets", flipped by ToggleAll). It used to
		// gate this whole expression, which meant the FREE widgets — the
		// Equipped group, the quick items, the loot lamp — went dark with it,
		// even though each has its own switch and its own place on screen.
		//
		// So the count is now two independent halves:
		//   g_anyStack — the in-panel readouts, behind the stack master
		//   g_anyFree  — the free-floating widgets, behind their OWN switches
		// and g_any (what AnyEnabled() answers, i.e. "does this view have any
		// reason to exist") is their OR. The view honours the same split in
		// hud.js fwGate.
		bool HudFlag(const char* key, bool fallback = false)
		{
			const auto it = g_cfg.hudPrefs.find(key);
			return it != g_cfg.hudPrefs.end() && it->is_boolean() ? it->get<bool>() : fallback;
		}
		void RecountAnyLocked()
		{
			// pins/sets count ONLY when they actually hold something: an enabled
			// tracker with an empty list has nothing to draw, and letting it arm
			// the whole live tick would mean paying a beat forever for an empty
			// row. Everything else is a plain per-widget flag.
			const bool stack =
			        g_cfg.enabled &&
			        (g_cfg.potions.enabled || g_cfg.gold.enabled || g_cfg.lockpicks.enabled ||
			         g_cfg.carry.enabled || g_cfg.weather.enabled || g_cfg.place.enabled ||
			         g_cfg.clock.enabled || HudFlag("calendar") || HudFlag("weatherOnly") || g_cfg.mount.enabled ||
			         g_cfg.vitals.enabled || g_cfg.effects.enabled || g_cfg.equip.enabled ||
			         g_cfg.resist.enabled || g_cfg.survival.enabled || g_cfg.allies.enabled ||
			         g_cfg.handR.enabled || g_cfg.handL.enabled ||
			         g_cfg.voice.enabled || g_cfg.quick.enabled ||
			         g_cfg.ward.enabled ||
			         (g_cfg.pins.enabled && !g_cfg.pinList.empty()) ||
			         (g_cfg.sets.enabled && !g_cfg.setList.empty()));
			// The free widgets: NOT gated on g_cfg.enabled, by design.
			const bool free =
			        g_cfg.handR.enabled || g_cfg.handL.enabled ||
			        g_cfg.voice.enabled || g_cfg.quick.enabled ||
			        g_cfg.ward.enabled ||
			        g_cfg.season.enabled ||
			        g_cfg.lootStatus.enabled ||
			        // Same rule as the trackers: an enabled custom strip with
			        // nothing in it has nothing to draw, and arming the live
			        // tick for it would buy a beat forever for an empty row.
			        (g_cfg.quick2.enabled && !g_cfg.quick2Items.empty());
			g_anyStack = stack;
			g_anyFree  = free;
			g_any      = stack || free;
		}

		json WidgetJson(const Widget& w)
		{
			return json{
				{ "enabled", w.enabled },
				{ "x", w.x }, { "y", w.y },
				{ "anchorH", ClampAnchorH(w.anchorH) },
				{ "anchorV", ClampAnchorV(w.anchorV) },
				{ "scale", w.scale }, { "opacity", w.opacity }, { "bare", w.bare },
				{ "showLabel", w.showLabel },
				{ "hideInMenus", w.hideInMenus },
			};
		}

		void WidgetFrom(const json& j, Widget& out)
		{
			if (!j.is_object())
				return;
			out.enabled = j.value("enabled", out.enabled);
			out.x = j.value("x", out.x);
			out.y = j.value("y", out.y);
			out.anchorH = ClampAnchorH(j.value("anchorH", out.anchorH));
			out.anchorV = ClampAnchorV(j.value("anchorV", out.anchorV));
			out.scale = std::clamp(j.value("scale", out.scale), 0.5f, 2.5f);
			out.opacity = std::clamp(j.value("opacity", out.opacity), 0.3f, 1.0f);
			out.bare = j.value("bare", out.bare);
			out.showLabel = j.value("showLabel", out.showLabel);
			out.hideInMenus = j.value("hideInMenus", out.hideInMenus);
		}

		json CatsJson(const PotCats& c)
		{
			return json{ { "heal", c.heal }, { "magicka", c.magicka },
				{ "stamina", c.stamina }, { "cure", c.cure }, { "all", c.all },
				{ "poison", c.poison }, { "food", c.food },
				{ "drink", c.drink }, { "water", c.water } };
		}
		void CatsFrom(const json& j, PotCats& out)
		{
			if (!j.is_object())
				return;
			out.heal = j.value("heal", out.heal);
			out.magicka = j.value("magicka", out.magicka);
			out.stamina = j.value("stamina", out.stamina);
			out.cure = j.value("cure", out.cure);
			out.all = j.value("all", out.all);
			out.poison = j.value("poison", out.poison);
			out.food = j.value("food", out.food);
			out.drink = j.value("drink", out.drink);
			out.water = j.value("water", out.water);
		}

		// ---- Potion AI config <-> json -----------------------------------
		json AiStatJson(const AiStat& s)
		{
			return json{ { "on", s.on }, { "pct", s.pct } };
		}
		void AiStatFrom(const json& j, AiStat& out)
		{
			if (!j.is_object())
				return;
			out.on = j.value("on", out.on);
			out.pct = std::clamp(j.value("pct", out.pct), 5, 90);
		}
		json AiJson(const AiCfg& a)
		{
			return json{
				{ "enabled", a.enabled },
				{ "combatOnly", a.combatOnly },
				{ "notify", a.notify },
				{ "cooldownMs", a.cooldownMs },
				{ "stats", json{
					{ "health", AiStatJson(a.health) },
					{ "magicka", AiStatJson(a.magicka) },
					{ "stamina", AiStatJson(a.stamina) },
				} },
			};
		}
		// ---- smart-pick prefs (see hotbar.h SmartPrefs) --------------------
		// Stored here because this is the module whose UI edits them (the
		// potion browser's ⚗ sheet) and whose sidecar is already the deck's
		// potion config. They are only PARKED here — the picker keeps its own
		// cached copy, pushed with SmartPush() below, so it never has to call
		// back into this module while the Potion AI holds its lock.
		json SmartJson(const Hotbar::SmartPrefs& s)
		{
			json ex = json::array();
			for (const auto& k : s.exclude)
				ex.push_back(k);
			return json{
				{ "optimal", s.optimal },
				{ "allowOverheal", s.allowOverheal },
				{ "preferOverheal", s.preferOverheal },
				{ "emergencyPct", s.emergencyPct },
				{ "blockWhenFull", s.blockWhenFull },
				{ "exclude", std::move(ex) },
			};
		}
		void SmartFrom(const json& j, Hotbar::SmartPrefs& out)
		{
			if (!j.is_object())
				return;
			out.optimal = j.value("optimal", out.optimal);
			out.allowOverheal = j.value("allowOverheal", out.allowOverheal);
			out.preferOverheal = j.value("preferOverheal", out.preferOverheal);
			out.emergencyPct = std::clamp(j.value("emergencyPct", out.emergencyPct), 0, 90);
			out.blockWhenFull = j.value("blockWhenFull", out.blockWhenFull);
			if (j.contains("exclude") && j["exclude"].is_array()) {
				out.exclude.clear();
				for (const auto& e : j["exclude"]) {
					if (!e.is_string())
						continue;
					const auto s = e.get<std::string>();
					// "plugin|0x……" and nothing else — a key without the bar
					// could never resolve, and 128 forms is far past any real
					// "never drink these" list.
					if (s.empty() || s.size() > 128 || s.find('|') == std::string::npos)
						continue;
					if (std::find(out.exclude.begin(), out.exclude.end(), s) == out.exclude.end())
						out.exclude.push_back(s);
					if (out.exclude.size() >= 128)
						break;
				}
			}
		}

		void AiFrom(const json& j, AiCfg& out)
		{
			if (!j.is_object())
				return;
			out.enabled = j.value("enabled", out.enabled);
			out.combatOnly = j.value("combatOnly", out.combatOnly);
			out.notify = j.value("notify", out.notify);
			out.cooldownMs = std::clamp(j.value("cooldownMs", out.cooldownMs), 1000, 15000);
			if (j.contains("stats") && j["stats"].is_object()) {
				const auto& s = j["stats"];
				if (s.contains("health"))
					AiStatFrom(s["health"], out.health);
				if (s.contains("magicka"))
					AiStatFrom(s["magicka"], out.magicka);
				if (s.contains("stamina"))
					AiStatFrom(s["stamina"], out.stamina);
			}
		}

		std::atomic<bool> g_aiOn{ false };  // ticker-readable snapshot of ai.enabled

		// ---- combos <-> json ----------------------------------------------
		// Local icon scrub — main.cpp's ValidViewIconPath is out of reach from
		// this module, so the same rule is enforced here: view-relative,
		// inside icons/, no escapes. A bad path is dropped, never "fixed".
		bool ValidComboIcon(const std::string& p)
		{
			if (p.empty() || p.size() > 128)
				return false;
			if (p.rfind("icons/", 0) != 0)
				return false;
			if (p.find("..") != std::string::npos || p.find(':') != std::string::npos ||
				p.find('\\') != std::string::npos)
				return false;
			return true;
		}

		// name -> "a-safe-slug". Split out of SlugFor (2026-08-17) so the pin and
		// set trackers mint ids by the same rule without borrowing the combo
		// list's uniquing — one spelling of "what is a slug here", two callers.
		std::string SlugBase(const std::string& name)
		{
			std::string base;
			for (const char ch : name) {
				const unsigned char c = static_cast<unsigned char>(ch);
				if (std::isalnum(c))
					base += static_cast<char>(std::tolower(c));
				else if ((ch == ' ' || ch == '-' || ch == '_') && !base.empty() && base.back() != '-')
					base += '-';
			}
			while (!base.empty() && base.back() == '-')
				base.pop_back();
			return base;
		}

		// A stable slug for a new combo, minted once at save time and never
		// regenerated — the deck entry id ("pcombo-<id>") and every pin/bind
		// hang off it, so a rename must not move it.
		std::string SlugFor(const std::string& name, const std::vector<Combo>& taken)
		{
			std::string base = SlugBase(name);
			if (base.empty())
				base = "combo";
			std::string out = base;
			int         n = 2;
			const auto  used = [&taken](const std::string& s) {
				 for (const auto& c : taken)
					 if (c.id == s)
						 return true;
				 return false;
			};
			while (used(out))
				out = base + "-" + std::to_string(n++);
			return out;
		}

		// ---- trackers <-> json --------------------------------------------
		// Same wire shape for a pin and a set — `goal` and `quest` are simply
		// meaningless on a pin. The reference mod's own file (PartySheet_
		// Widgets.json) settled on {id,label,goal,enabled,items:[{mod,formId}],
		// quest:{mod,formId}} and it is a good shape; ours keeps the deck's own
		// spelling (`plugin`, not `mod`) so every other bridge payload in this
		// codebase reads the same way, and adds `icon` because our view already
		// has an icon picker and theirs derives the PNG from the id.
		json TrackJson(const std::vector<TrackEntry>& list)
		{
			json arr = json::array();
			for (const auto& e : list) {
				json items = json::array();
				for (const auto& r : e.items)
					items.push_back(json{ { "plugin", r.plugin }, { "formId", r.formId } });
				json o{ { "id", e.id }, { "label", e.label }, { "icon", e.icon },
					{ "enabled", e.enabled }, { "goal", e.goal }, { "items", std::move(items) } };
				if (!e.quest.formId.empty())
					o["quest"] = json{ { "plugin", e.quest.plugin }, { "formId", e.quest.formId } };
				arr.push_back(std::move(o));
			}
			return arr;
		}

		bool TrackIdTaken(const std::vector<TrackEntry>& seen, const std::string& id)
		{
			for (const auto& e : seen)
				if (e.id == id)
					return true;
			return false;
		}

		void TrackFrom(const json& j, std::vector<TrackEntry>& out, int cap)
		{
			if (!j.is_array())
				return;
			std::vector<TrackEntry> parsed;
			for (const auto& e : j) {
				if (!e.is_object())
					continue;
				TrackEntry t;
				t.label = e.value("label", std::string());
				if (t.label.empty())
					continue;  // an unlabelled row is unreadable everywhere — drop
				t.id = e.value("id", std::string());
				const std::string icon = e.value("icon", std::string());
				if (ValidComboIcon(icon))  // one icon rule for the whole module
					t.icon = icon;
				t.enabled = e.value("enabled", true);
				t.goal = std::clamp(e.value("goal", 0), 0, 9999);
				if (e.contains("items") && e["items"].is_array()) {
					for (const auto& it : e["items"]) {
						if (!it.is_object())
							continue;
						TrackRef r;
						r.plugin = it.value("plugin", std::string());
						r.formId = it.value("formId", std::string());
						if (r.plugin.empty() || r.formId.empty())
							continue;  // no durable identity = no honest count
						t.items.push_back(std::move(r));
						if (static_cast<int>(t.items.size()) >= kMaxRefsPerEntry)
							break;
					}
				}
				if (t.items.empty())
					continue;  // nothing to count
				if (e.contains("quest") && e["quest"].is_object()) {
					t.quest.plugin = e["quest"].value("plugin", std::string());
					t.quest.formId = e["quest"].value("formId", std::string());
					if (t.quest.plugin.empty())
						t.quest.formId.clear();
				}
				if (t.id.empty())
					t.id = SlugBase(t.label);
				if (t.id.empty())
					t.id = "tracked";
				// A duplicate id would make two rows fight over one icon and one
				// enable flag — suffix until it is unique, never silently drop.
				while (TrackIdTaken(parsed, t.id))
					t.id += "-2";
				parsed.push_back(std::move(t));
				if (static_cast<int>(parsed.size()) >= cap)
					break;
			}
			out = std::move(parsed);
		}

		// ---- custom quick items <-> json ---------------------------------
		// Same identity law as the trackers: (plugin + LOCAL formId), never a
		// runtime id. `name` is the display fallback for a row whose mod is
		// off, so the widget can say WHICH item went missing rather than
		// dropping it and reading as "you spent them all". The optional bind
		// is the hotbar's own {device, code, label} shape so the input sink
		// matches it exactly the way it matches a bar slot key.
		json Quick2Json(const std::vector<Quick2Item>& list)
		{
			json arr = json::array();
			for (const auto& q : list) {
				json o{ { "plugin", q.plugin }, { "formId", q.formId }, { "name", q.name } };
				if (!q.keyDevice.empty() && q.keyCode > 0) {
					o["keyDevice"] = q.keyDevice;
					o["keyCode"] = q.keyCode;
					o["keyLabel"] = q.keyLabel;
				}
				arr.push_back(std::move(o));
			}
			return arr;
		}

		void Quick2From(const json& j, std::vector<Quick2Item>& out)
		{
			if (!j.is_array())
				return;
			std::vector<Quick2Item> parsed;
			for (const auto& e : j) {
				if (!e.is_object())
					continue;
				Quick2Item q;
				q.plugin = e.value("plugin", std::string());
				q.formId = e.value("formId", std::string());
				if (q.plugin.empty() || q.formId.empty())
					continue;  // no durable identity = nothing this row could fire
				q.name = e.value("name", std::string());
				// An unbound row is the normal case ("keybind each specific one
				// IF you care to"), so a partial or nonsense bind lands as
				// unbound rather than as a key nobody can press.
				const std::string dev = e.value("keyDevice", std::string());
				const int         code = e.value("keyCode", 0);
				if ((dev == "keyboard" || dev == "mouse") && code > 0) {
					q.keyDevice = dev;
					q.keyCode = code;
					q.keyLabel = e.value("keyLabel", std::string());
				}
				parsed.push_back(std::move(q));
				if (static_cast<int>(parsed.size()) >= kMaxQuick2Items)
					break;
			}
			out = std::move(parsed);
		}

		json CombosJsonLocked(const std::vector<Combo>& combos)
		{
			json arr = json::array();
			for (const auto& c : combos) {
				json items = json::array();
				for (const auto& it : c.items)
					items.push_back(json{ { "plugin", it.plugin },
						{ "formId", it.formId }, { "name", it.name } });
				arr.push_back(json{ { "id", c.id }, { "name", c.name },
					{ "icon", c.icon }, { "items", std::move(items) } });
			}
			return arr;
		}
		void CombosFrom(const json& j, std::vector<Combo>& out)
		{
			if (!j.is_array())
				return;
			std::vector<Combo> parsed;
			for (const auto& e : j) {
				if (!e.is_object())
					continue;
				Combo c;
				c.id = e.value("id", std::string());
				c.name = e.value("name", std::string());
				if (c.name.empty())
					continue;  // a nameless combo is unfindable everywhere — drop
				std::string icon = e.value("icon", std::string());
				if (ValidComboIcon(icon))
					c.icon = icon;
				if (e.contains("items") && e["items"].is_array()) {
					for (const auto& it : e["items"]) {
						if (!it.is_object())
							continue;
						ComboItem ci;
						ci.plugin = it.value("plugin", std::string());
						ci.formId = it.value("formId", std::string());
						ci.name = it.value("name", std::string());
						if (ci.formId.empty() && ci.name.empty())
							continue;
						c.items.push_back(std::move(ci));
						if (static_cast<int>(c.items.size()) >= kMaxComboItems)
							break;
					}
				}
				if (c.id.empty())
					c.id = SlugFor(c.name, parsed);
				// A duplicate id would make two deck entries fight — re-mint.
				for (const auto& seen : parsed)
					if (seen.id == c.id) {
						c.id = SlugFor(c.name, parsed);
						break;
					}
				parsed.push_back(std::move(c));
			}
			out = std::move(parsed);
		}

		// The whole config as one object — the sidecar's document and the
		// wgConfig push are the SAME shape on purpose: one serializer, no
		// second dialect to keep in step.
		json ConfigJsonLocked()
		{
			json pot = WidgetJson(g_cfg.potions);
			pot["cats"] = CatsJson(g_cfg.cats);
			json mnt = WidgetJson(g_cfg.mount);
			mnt["follow"] = g_cfg.mountFollow;
			json pin = WidgetJson(g_cfg.pins);
			pin["items"] = TrackJson(g_cfg.pinList);
			json set = WidgetJson(g_cfg.sets);
			set["items"] = TrackJson(g_cfg.setList);
			// The custom quick strip carries its row cap and its whole list on
			// the same object the placement rides — one widget key, one
			// serializer, exactly like pins/sets above.
			json q2 = WidgetJson(g_cfg.quick2);
			q2["max"] = g_cfg.quick2Max;
			q2["items"] = Quick2Json(g_cfg.quick2Items);
			return json{
				{ "enabled", g_cfg.enabled },
				{ "widgets", json{
					{ "potions", std::move(pot) },
					{ "gold", WidgetJson(g_cfg.gold) },
					{ "lockpicks", WidgetJson(g_cfg.lockpicks) },
					{ "carry", WidgetJson(g_cfg.carry) },
					{ "weather", WidgetJson(g_cfg.weather) },
					{ "place", WidgetJson(g_cfg.place) },
					{ "clock", WidgetJson(g_cfg.clock) },
					{ "mount", std::move(mnt) },
					{ "pins", std::move(pin) },
					{ "sets", std::move(set) },
					{ "vitals", WidgetJson(g_cfg.vitals) },
					{ "effects", WidgetJson(g_cfg.effects) },
					{ "equip", WidgetJson(g_cfg.equip) },
					{ "resist", WidgetJson(g_cfg.resist) },
					{ "survival", WidgetJson(g_cfg.survival) },
					{ "allies", WidgetJson(g_cfg.allies) },
					{ "timeDial", WidgetJson(g_cfg.timeDial) },
					{ "handR", WidgetJson(g_cfg.handR) },
					{ "handL", WidgetJson(g_cfg.handL) },
					{ "voice", WidgetJson(g_cfg.voice) },
					{ "quick", WidgetJson(g_cfg.quick) },
					{ "ward", WidgetJson(g_cfg.ward) },
					{ "season", WidgetJson(g_cfg.season) },
					{ "quick2", std::move(q2) },
					{ "lootStatus", WidgetJson(g_cfg.lootStatus) },
				} },
				{ "browser", g_cfg.browser },
				{ "hud", g_cfg.hudPrefs },
				{ "ai", AiJson(g_cfg.ai) },
				{ "smart", SmartJson(g_cfg.smart) },
				{ "combos", CombosJsonLocked(g_cfg.combos) },
			};
		}

		// Hand the picker its copy. Called after every load and every save that
		// touched `smart` — never from inside a path that holds another
		// module's lock, and Hotbar's own mutex is a leaf, so this cannot
		// deadlock in either direction.
		void SmartPush()
		{
			Hotbar::SetSmartPrefs(g_cfg.smart);
		}

		void ConfigFromLocked(const json& j)
		{
			if (!j.is_object())
				return;
			g_cfg.enabled = j.value("enabled", g_cfg.enabled);
			// ai / combos only land when PRESENT: the hotbar view's wgSave
			// payload carries neither (they are the deck-side pb* bridge's),
			// and a partial write must never reset them to defaults.
			if (j.contains("ai")) {
				AiFrom(j["ai"], g_cfg.ai);
				g_aiOn = g_cfg.ai.enabled;
			}
			if (j.contains("smart")) {
				SmartFrom(j["smart"], g_cfg.smart);
				SmartPush();
			}
			if (j.contains("combos"))
				CombosFrom(j["combos"], g_cfg.combos);
			if (j.contains("widgets") && j["widgets"].is_object()) {
				const auto& w = j["widgets"];
				if (w.contains("potions")) {
					WidgetFrom(w["potions"], g_cfg.potions);
					if (w["potions"].is_object() && w["potions"].contains("cats"))
						CatsFrom(w["potions"]["cats"], g_cfg.cats);
				}
				if (w.contains("gold"))
					WidgetFrom(w["gold"], g_cfg.gold);
				if (w.contains("lockpicks"))
					WidgetFrom(w["lockpicks"], g_cfg.lockpicks);
				if (w.contains("carry"))
					WidgetFrom(w["carry"], g_cfg.carry);
				if (w.contains("weather"))
					WidgetFrom(w["weather"], g_cfg.weather);
				if (w.contains("place"))
					WidgetFrom(w["place"], g_cfg.place);
				if (w.contains("clock"))
					WidgetFrom(w["clock"], g_cfg.clock);
				if (w.contains("mount")) {
					WidgetFrom(w["mount"], g_cfg.mount);
					if (w["mount"].is_object()) {
						const std::string f = w["mount"].value("follow", g_cfg.mountFollow);
						g_cfg.mountFollow = (f == "ridden") ? f : "lastRidden";
					}
				}
				// The tracker LISTS land only when the payload carries them —
				// same rule as ai/combos above. A view that saves the widget
				// block without its items (an older hotbar view, a partial
				// write) must not silently empty the player's pin list.
				if (w.contains("pins")) {
					WidgetFrom(w["pins"], g_cfg.pins);
					if (w["pins"].is_object() && w["pins"].contains("items"))
						TrackFrom(w["pins"]["items"], g_cfg.pinList, kMaxPins);
				}
				if (w.contains("sets")) {
					WidgetFrom(w["sets"], g_cfg.sets);
					if (w["sets"].is_object() && w["sets"].contains("items"))
						TrackFrom(w["sets"]["items"], g_cfg.setList, kMaxSets);
				}
				// The round-2 widgets carry no list of their own, so the plain
				// WidgetFrom is the whole read — and each is still guarded by
				// contains(), so a view that saves only the block it edited
				// (the HUD view does exactly that) cannot reset the others.
				if (w.contains("vitals"))
					WidgetFrom(w["vitals"], g_cfg.vitals);
				if (w.contains("effects"))
					WidgetFrom(w["effects"], g_cfg.effects);
				if (w.contains("equip"))
					WidgetFrom(w["equip"], g_cfg.equip);
				if (w.contains("resist"))
					WidgetFrom(w["resist"], g_cfg.resist);
				if (w.contains("survival"))
					WidgetFrom(w["survival"], g_cfg.survival);
				if (w.contains("allies"))
					WidgetFrom(w["allies"], g_cfg.allies);
				// Round 3: the four slot widgets. The HUD view saves these WITH
				// their placement (it is where they are dragged), still guarded
				// by contains() like every other partial write.
				// Time Dial placement — saved by hud-td.js as a partial write
				// ({"widgets":{"timeDial":{…}}}), merged here like every other
				// contains()-guarded key.
				if (w.contains("timeDial"))
					WidgetFrom(w["timeDial"], g_cfg.timeDial);
				if (w.contains("handR"))
					WidgetFrom(w["handR"], g_cfg.handR);
				if (w.contains("handL"))
					WidgetFrom(w["handL"], g_cfg.handL);
				if (w.contains("voice"))
					WidgetFrom(w["voice"], g_cfg.voice);
				if (w.contains("quick"))
					WidgetFrom(w["quick"], g_cfg.quick);
				if (w.contains("ward"))
					WidgetFrom(w["ward"], g_cfg.ward);
				if (w.contains("season"))
					WidgetFrom(w["season"], g_cfg.season);
				// Round 4. `max` and `items` land only when PRESENT — the same
				// partial-write rule the tracker lists live by, so a view that
				// saves just the placement it dragged can never empty the
				// player's custom strip.
				if (w.contains("quick2")) {
					WidgetFrom(w["quick2"], g_cfg.quick2);
					if (w["quick2"].is_object()) {
						if (w["quick2"].contains("max"))
							g_cfg.quick2Max = std::clamp(
								w["quick2"].value("max", g_cfg.quick2Max), 1, kMaxQuick2Items);
						if (w["quick2"].contains("items"))
							Quick2From(w["quick2"]["items"], g_cfg.quick2Items);
					}
				}
				if (w.contains("lootStatus"))
					WidgetFrom(w["lootStatus"], g_cfg.lootStatus);
			}
			if (j.contains("browser") && j["browser"].is_object())
				g_cfg.browser = j["browser"];
			if (j.contains("hud") && j["hud"].is_object()) {
				g_cfg.hudPrefs = j["hud"];
				logger::info("widgets: hud view prefs stored ({} key(s))",
					g_cfg.hudPrefs.size());
			}
			RecountAnyLocked();
		}

		void SaveLocked()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			// Start from what the file HELD (g_extra) and overlay our keys, so
			// an unknown top-level key survives the round-trip.
			json doc = g_extra.is_object() ? g_extra : json::object();
			const json ours = ConfigJsonLocked();
			for (auto it = ours.begin(); it != ours.end(); ++it)
				doc[it.key()] = it.value();
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("widgets: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(doc);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("widgets: sidecar rename failed: {}", ec.message());
		}

		// ---------------------------------------------------- raw inventory --
		// Lockpick count, EXACTLY the ReadGoldRaw discipline (finance.cpp):
		// walk the inventory-changes entry list summing counts for one FormID
		// — never GetInventory<>(), which rebuilds every item's entry and has
		// faulted on this 4,780-mod load order. No C++ objects in the __try
		// frame (C2712), __declspec(noinline) so the walk owns its own frame.
		constexpr std::uint32_t kLockpickFormId = 0x0000000A;  // Lockpick, Skyrim.esm

		__declspec(noinline) std::int64_t ReadLockpicksRaw()
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p)
				return 0;
			std::int64_t total = 0;
			auto*        changes = p->GetInventoryChanges();
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object && entry->object->GetFormID() == kLockpickFormId)
						total += entry->countDelta;
				}
			}
			return total;
		}
		std::int64_t ReadLockpicks()
		{
			__try {
				return ReadLockpicksRaw();
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return -1;  // sentinel: the view shows "?" rather than a lie
			}
		}

		// Carry weight: current load (GetWeightInContainer — engine-cached, the
		// same number the vanilla HUD bar shows) over max capacity (the
		// kCarryWeight AV, buffs included). Same SEH discipline as ReadLockpicks:
		// the raw read owns its frame, no C++ objects with destructors in the
		// __try (C2712), a fault leaves both at -1 so the view shows "?".
		__declspec(noinline) bool ReadCarryRaw(float& cur, float& max)
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p)
				return false;
			cur = p->GetWeightInContainer();
			auto* avo = p->AsActorValueOwner();
			max = avo ? avo->GetActorValue(RE::ActorValue::kCarryWeight) : 0.0f;
			return true;
		}
		bool ReadCarry(float& cur, float& max)
		{
			__try {
				return ReadCarryRaw(cur, max);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return false;
			}
		}

		// -------------------------------------------------- potion browser --
		std::uint32_t ParseHexId(const std::string& s)
		{
			try {
				return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		// The biggest helpful magnitude — food/drink strength, and the "other"
		// potion fallback, so sorting by strength still means something for
		// fortify/resist bottles and hearty stews alike.
		float BestHelpfulMag(const RE::AlchemyItem* alch)
		{
			float best = 0.0f;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base || base->IsDetrimental())
					continue;
				best = std::max<float>(best, effect->effectItem.magnitude);
			}
			return best;
		}

		// Classify one consumable: poisons / food / drinks / water go by the
		// ONE shared classifier (Hotbar::ClassifyConsumable); a plain potion
		// then falls to the smart-button pools, first match in heal → magicka
		// → stamina → cure order, anything else "other". outScore = the
		// row's `strength` — the matching magnitude for pools, the biggest
		// helpful magnitude for food/drink, the biggest magnitude FULL STOP
		// for a poison (its effects are detrimental by design; "strongest
		// poison first" must still sort).
		std::string CatOf(const RE::AlchemyItem* alch, float& outScore)
		{
			using CK = Hotbar::ConsumableKind;
			switch (Hotbar::ClassifyConsumable(alch)) {
			case CK::kPoison:
				outScore = 0.0f;
				for (auto* effect : alch->effects) {
					if (effect)
						outScore = std::max<float>(outScore, effect->effectItem.magnitude);
				}
				return "poison";
			case CK::kWater:
				outScore = static_cast<float>(Hotbar::WaterDrinks(alch));
				return "water";
			case CK::kDrink:
				outScore = BestHelpfulMag(alch);
				return "drink";
			case CK::kFood:
				outScore = BestHelpfulMag(alch);
				return "food";
			default:
				break;
			}
			static const char* kPools[] = { "heal", "magicka", "stamina", "cure" };
			for (const char* pool : kPools) {
				float score = 0.0f;
				if (Hotbar::PoolMatch(pool, alch, score)) {
					outScore = score;
					return pool;
				}
			}
			outScore = BestHelpfulMag(alch);
			return "other";
		}

		// Two effect names + magnitudes — the row's second line. Short on
		// purpose; the row is a quick-drink surface, not an inspector.
		std::string FxSummary(const RE::AlchemyItem* alch)
		{
			std::string out;
			int         shown = 0;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				const char* nm = base->GetName();
				if (!nm || !*nm)
					continue;
				if (shown)
					out += " \xC2\xB7 ";  // " · "
				out += nm;
				const int mag = static_cast<int>(effect->effectItem.magnitude);
				if (mag > 0)
					out += " " + std::to_string(mag);
				if (++shown >= 2)
					break;
			}
			return out;
		}

		// How many of this exact object the player still carries.
		std::int32_t CarriedCount(RE::TESBoundObject* obj)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !obj)
				return 0;
			auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			for (auto& [o, data] : inv)
				if (o == obj)
					return data.first;
			return 0;
		}

		// ================================================================== //
		//  THE CONTEXT WIDGETS (2026-08-17)                                  //
		//  weather · place · clock · mount · pins · sets                     //
		// ================================================================== //

		// ---------------------------------------------------------- weather --
		// The ENGINE's own classification, off the weather record's data flags —
		// never a name match, because a weather mod's records are called
		// whatever its author felt like. Order is snow → rain → cloudy →
		// everything else is clear: the flags are not exclusive (a snowy record
		// is usually cloudy too) and the most specific answer is the useful one.
		//
		// Deliberately NOT scene_stage.cpp's KindOf, which tests kPleasant
		// before kCloudy and can answer "other". That order is right for its
		// picker (it wants one preset per flag) and wrong for a HUD icon, which
		// must always name something. Same flags, different tie-break — the two
		// are allowed to disagree, and this comment is why.
		const char* WeatherKindOf(const RE::TESWeather* w)
		{
			if (!w)
				return "clear";
			using Flag = RE::TESWeather::WeatherDataFlag;
			const auto f = w->data.flags;
			if (f.any(Flag::kSnow))
				return "snow";
			if (f.any(Flag::kRainy))
				return "rain";
			if (f.any(Flag::kCloudy))
				return "cloudy";
			return "clear";
		}

		// ------------------------------------------------------------ place --
		// Location TYPE from the location's own LocType keywords — never from
		// the NAME. "Understone Keep" is not a keep because of the word, and a
		// translated load order would break a name match outright.
		//
		// TWO facts make this table work, both of them engine behaviour:
		//   1. BGSLocation::HasKeyword walks the PARENT-location chain, so an
		//      inn's interior inherits the city's keywords. That is why the
		//      table is ORDERED most-specific-first: check LocTypeInn before
		//      LocTypeDwelling (an inn is also a dwelling) and check both long
		//      before LocTypeCity, or every building in Whiterun reads "city".
		//   2. Keywords keep their editor id at runtime, so LookupByEditorID
		//      resolves them ONCE at first use and the per-tick cost is a
		//      pointer compare inside the engine's own keyword array.
		// A keyword this load order does not have simply resolves to null and
		// is skipped — an unknown edid is a miss, never a crash, which is what
		// lets the table carry names from mods we have not got.
		struct LocRule
		{
			const char* edid;
			const char* type;
		};
		const LocRule kLocRules[] = {
			// buildings you are INSIDE — the reference mod's own order, which
			// it earned: inn, castle→palace, jail, temple, store, then homes
			{ "LocTypeInn", "inn" },
			{ "LocTypeJail", "jail" },
			{ "LocTypeTemple", "temple" },
			{ "LocTypeCastle", "palace" },
			{ "LocTypeStore", "store" },
			{ "LocTypeBarracks", "barracks" },
			{ "LocTypePlayerHouse", "home" },
			// the dangerous interiors, specific lair before the generic dungeon
			{ "LocTypeDraugrCrypt", "crypt" },
			{ "LocTypeDwarvenAutomatons", "dwemer" },
			{ "LocTypeVampireLair", "dungeon" },
			{ "LocTypeDragonPriestLair", "dungeon" },
			{ "LocTypeFalmerHive", "dungeon" },
			{ "LocTypeWerewolfLair", "dungeon" },
			{ "LocTypeWarlockLair", "dungeon" },
			{ "LocTypeHagravenNest", "dungeon" },
			{ "LocTypeMilitaryFort", "fort" },
			{ "LocTypeMine", "mine" },
			{ "LocTypeCave", "cave" },
			{ "LocTypeDragonLair", "dragon" },
			{ "LocTypeShipwreck", "ship" },
			{ "LocTypeShip", "ship" },
			{ "LocTypeDungeon", "dungeon" },
			// outdoor places
			{ "LocTypeBanditCamp", "camp" },
			{ "LocTypeForswornCamp", "camp" },
			{ "LocTypeGiantCamp", "camp" },
			{ "LocTypeMilitaryCamp", "camp" },
			{ "LocTypeOrcStronghold", "stronghold" },
			{ "LocTypeFarm", "farm" },
			{ "LocTypeLumberMill", "mill" },
			// settlements LAST — every building above inherits these from its
			// parent location, so anything reaching here really is the town
			{ "LocTypeCity", "city" },
			{ "LocTypeTown", "town" },
			{ "LocTypeSettlement", "settlement" },
			{ "LocTypeHabitation", "settlement" },
			// and the catch-all home, after the inn/store/temple that also
			// carry LocTypeDwelling
			{ "LocTypeDwelling", "home" },
		};
		RE::BGSKeyword* g_locKw[std::size(kLocRules)] = {};
		bool            g_locKwReady = false;

		void EnsureLocKeywords()
		{
			if (g_locKwReady)
				return;
			g_locKwReady = true;
			int found = 0;
			for (std::size_t i = 0; i < std::size(kLocRules); ++i) {
				g_locKw[i] = RE::TESForm::LookupByEditorID<RE::BGSKeyword>(kLocRules[i].edid);
				if (g_locKw[i])
					++found;
			}
			// Build marker (hd-markers.json: "widgets: location keywords").
			logger::info("widgets: location keywords resolved ({} of {})",
				found, static_cast<int>(std::size(kLocRules)));
		}

		// The place's KIND, as the icon sets are keyed. Extracted out of the
		// player's own place readout (2026-09-17) so a FOLLOWER's location can be
		// classified the same way: the Followers roster draws an icon for where
		// she is standing, and a second table of keywords would drift from this
		// one the first time a location type was added. First rule wins — the
		// order of kLocRules is load-bearing (settlements last, so a shop inside
		// a city reads as a shop).
		std::string KindOfLocation(RE::BGSLocation* loc, bool interior)
		{
			EnsureLocKeywords();
			for (std::size_t i = 0; i < std::size(kLocRules); ++i)
				if (g_locKw[i] && loc && loc->HasKeyword(g_locKw[i]))
					return kLocRules[i].type;
			return interior ? "interior" : "wilderness";
		}

		std::string FullNameOf(RE::TESForm* form)
		{
			if (!form)
				return {};
			if (auto* full = form->As<RE::TESFullName>()) {
				const char* n = full->GetFullName();
				if (n && *n)
					return n;
			}
			return {};
		}

		// The place block is CACHED on (cell, location) identity: standing still
		// must produce a byte-identical payload, and rebuilding it every tick
		// would pay a keyword walk 1.1 times a second for an answer that changes
		// when you walk through a door.
		struct PlaceCache
		{
			std::uint32_t cellId = 0;
			std::uint32_t locId = 0;
			bool          have = false;
			json          j;
		};
		PlaceCache g_place;  // main thread only

		json PlaceJson()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* cell = player ? player->GetParentCell() : nullptr;
			if (!cell)
				return nullptr;  // no save loaded / mid-transition: absent, not "Tamriel"
			auto* loc = player->GetCurrentLocation();
			if (!loc)
				loc = cell->GetLocation();
			const std::uint32_t cellId = cell->GetFormID();
			const std::uint32_t locId = loc ? loc->GetFormID() : 0u;
			if (g_place.have && g_place.cellId == cellId && g_place.locId == locId)
				return g_place.j;

			EnsureLocKeywords();
			const bool interior = cell->IsInteriorCell();

			// NAME. Indoors the CELL is what the place is called ("The Bannered
			// Mare", "Breezehome"); outdoors the cell is an unnamed grid square
			// and the LOCATION is the answer ("Whiterun Stables"). Each falls
			// back to the other, then to the worldspace, then to nothing —
			// never to an invented label.
			std::string name = interior ? FullNameOf(cell) : FullNameOf(loc);
			if (name.empty())
				name = interior ? FullNameOf(loc) : FullNameOf(cell);
			std::string world;
			if (!interior) {
				world = FullNameOf(player->GetWorldspace());
				if (name.empty())
					name = world;
			}

			std::string type = KindOfLocation(loc, interior);

			// The location's OWN LocType/LocSet keywords ride along. They cost a
			// walk of one small array, they only change when the place does, and
			// they are the whole diagnostic for "this cave got the wrong icon" —
			// without them the answer to a wrong type is guesswork.
			json kws = json::array();
			if (auto* kf = loc ? loc->As<RE::BGSKeywordForm>() : nullptr) {
				for (std::uint32_t i = 0; i < kf->numKeywords && kws.size() < 10; ++i) {
					auto* kw = kf->keywords[i];
					const char* e = kw ? kw->GetFormEditorID() : nullptr;
					if (e && (std::strncmp(e, "LocType", 7) == 0 || std::strncmp(e, "LocSet", 6) == 0))
						kws.push_back(std::string(e));
				}
			}

			json out{ { "name", name }, { "type", type }, { "interior", interior },
				{ "kws", std::move(kws) } };
			if (!world.empty())
				out["world"] = world;
			g_place = PlaceCache{ cellId, locId, true, out };
			return out;
		}

		// ------------------------------------------------------------ clock --
		const char* const kMonthNames[12] = { "Morning Star", "Sun's Dawn", "First Seed",
			"Rain's Hand", "Second Seed", "Midyear", "Sun's Height", "Last Seed",
			"Hearthfire", "Frostfall", "Sun's Dusk", "Evening Star" };

		json TimeJson()
		{
			auto* cal = RE::Calendar::GetSingleton();
			if (!cal || !cal->gameHour)
				return nullptr;
			// QUANTISED TO THE MINUTE, on purpose. gameHour is a float that
			// moves every frame; sending it raw would make every tick's payload
			// differ and the diff-gate would never fire again — the exact shape
			// of the 2026-08-16 Action Bar countdown bug. Whole minutes mean an
			// idle player repaints roughly once every three real seconds at the
			// default timescale, and not at all while time is stopped.
			const float raw = cal->gameHour->value;
			int h = static_cast<int>(raw);
			int m = static_cast<int>((raw - static_cast<float>(h)) * 60.0f);
			if (m > 59) m = 59;
			if (m < 0) m = 0;
			h %= 24;
			if (h < 0) h += 24;

			const bool pm = h >= 12;
			int h12 = h % 12;
			if (h12 == 0)
				h12 = 12;
			char txt[16], t24[8];
			std::snprintf(txt, sizeof(txt), "%d:%02d %s", h12, m, pm ? "PM" : "AM");
			std::snprintf(t24, sizeof(t24), "%02d:%02d", h, m);

			json out{ { "h", h }, { "m", m }, { "txt", std::string(txt) },
				{ "h24", std::string(t24) },
				// The reference mod's own night window, and it is the right one:
				// the moon icon belongs from dusk to dawn, not from 00:00.
				{ "night", h < 6 || h >= 20 } };

			// GetMonth() is 0-BASED here (finance.cpp's Stamp() indexes the same
			// table with it directly); the gameMonth GLOBAL is 1-based. Two
			// conventions, one engine — send the name too so the view never has
			// to know which one arrived.
			const int day = static_cast<int>(cal->GetDay());
			const int mon = static_cast<int>(cal->GetMonth());
			const int yr = static_cast<int>(cal->GetYear());
			const char* mn = (mon >= 0 && mon < 12) ? kMonthNames[mon] : "";
			out["day"] = day;
			out["month"] = mon;
			out["monthName"] = mn;
			out["year"] = yr;
			out["date"] = std::to_string(day) + " " + mn + ", 4E " + std::to_string(yr);
			return out;
		}

		// ------------------------------------------------------------ season --
		// (Rober, 2026-08-31: "a season widget would be nice. not sure how to
		// best hook to seasons of skyrim".)
		//
		// ⛔ NEVER COMPUTE THE SEASON FROM THE MONTH. It is the obvious shortcut
		// and it is wrong on this very rig. Seasons of Skyrim's month->season
		// map lives in its INI and mods rewrite it: the load order here also
		// carries "Four Seasons - Faster Seasons of Skyrim", which ships a map
		// running autumn-winter-spring-summer THREE times a year so the world
		// turns over every month. (Its INI is `.mohidden` on this rig today, so
		// the stock map is the live one — which is exactly the point: a
		// hardcoded "Frostfall means autumn" would be right this week and a lie
		// the moment that file is unhidden.)
		//
		// So we ASK, through the mod's own documented API — its shipped
		// Source/scripts/SeasonsOfSkyrim.psc:
		//
		//     int Function GetCurrentSeason()  global native
		//     int Function GetSeasonOverride() global native
		//     0 none · 1 winter · 2 spring · 3 summer · 4 autumn
		//
		// A Papyrus dispatch answers on the VM's own thread, so this NEVER
		// blocks a tick: LiveJson reads a LATCH and re-arms the dispatch on a
		// slow beat. A season can only turn over across an interior->exterior
		// transition (the mod's own rule), so kSeasonPollMs is already far
		// finer-grained than the thing it watches.
		//
		// The INI is read too, but only for what the API cannot say: whether
		// seasons are switched off / pinned at all (Season Type), and how many
		// days are left before the next one — and the map is used as the
		// ANSWER only when the mod is absent, in which case the payload says so
		// (`src:"calendar"`) instead of pretending to be authoritative.
		constexpr int         kSeasonPollMs = 5000;   // re-ask at most this often
		constexpr int         kSeasonStuckMs = 15000; // a dispatch that never called back

		const char* const kSeasonIds[5] = { "", "winter", "spring", "summer", "autumn" };
		const char* const kSeasonNames[5] = { "", "Winter", "Spring", "Summer", "Autumn" };

		// Skyrim's own month lengths — needed only for "spring in 6 days".
		const int kMonthDays[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };

		std::atomic<int>       g_season{ -1 };        // -1 = never answered
		std::atomic<int>       g_seasonOvr{ -1 };     // GetSeasonOverride, same scale
		std::atomic<int>       g_seasonApi{ 0 };      // 0 unknown · 1 present · -1 absent
		std::atomic<bool>      g_seasonFlight{ false };
		std::atomic<long long> g_seasonAsked{ 0 };

		long long NowMs()
		{
			using namespace std::chrono;
			return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
		}

		// ---- the INI, read once ------------------------------------------
		// Relative "Data/…" is the idiom the rest of this plugin uses
		// (keys_scan.cpp, journal.cpp): under MO2 the VFS resolves it to the
		// WINNING copy, which is by construction the same file Seasons itself
		// opened. On this rig that winner lives in MO2's Overwrite, which is
		// exactly why the path must not be hardcoded to a mod folder.
		// The two facts are tracked SEPARATELY on purpose. A file that gives us
		// `Season Type` but no month lines would otherwise leave the shipped map
		// standing in as if it had been read, and "Spring in 6 days" would be a
		// number invented from a default. Each claim below is gated on the fact
		// it actually needs.
		struct SeasonIni
		{
			bool read = false;      // the parse ran (success or not)
			bool haveType = false;  // a `Season Type` line was read
			bool haveMap = false;   // all twelve month lines were read
			int  type = 5;          // 0 off · 1-4 pinned · 5 seasonal
			int  map[12] = { 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 1 };  // po3's shipped map
		};
		SeasonIni g_sini;

		// "Frost Fall" (the INI's spelling) and "Frostfall" (the engine's) must
		// compare equal, and so must "Sun's Dawn" against "suns dawn".
		std::string MonthKey(std::string s)
		{
			std::string out;
			for (unsigned char c : s) {
				if (std::isalpha(c))
					out.push_back(static_cast<char>(std::tolower(c)));
			}
			return out;
		}

		void LoadSeasonIni()
		{
			if (g_sini.read)
				return;
			g_sini.read = true;
			std::ifstream in("Data/SKSE/Plugins/po3_SeasonsOfSkyrim.ini");
			if (!in.is_open()) {
				logger::info("widgets: season — no po3_SeasonsOfSkyrim.ini on disk");
				return;
			}
			// The month keys, in engine order, matched by letters only.
			const std::string want[12] = {
				MonthKey("Morning Star"), MonthKey("Sun's Dawn"), MonthKey("First Seed"),
				MonthKey("Rain's Hand"), MonthKey("Second Seed"), MonthKey("Mid Year"),
				MonthKey("Sun's Height"), MonthKey("Last Seed"), MonthKey("Hearthfire"),
				MonthKey("Frost Fall"), MonthKey("Sun's Dusk"), MonthKey("Evening Star")
			};
			bool        inSettings = false;
			int         found = 0;
			std::string line;
			while (std::getline(in, line)) {
				// strip comment + trim
				if (const auto c = line.find(';'); c != std::string::npos)
					line.erase(c);
				const auto b = line.find_first_not_of(" \t\r\n");
				if (b == std::string::npos)
					continue;
				const auto e = line.find_last_not_of(" \t\r\n");
				line = line.substr(b, e - b + 1);
				if (line.empty())
					continue;
				if (line.front() == '[') {
					// [Settings] holds the map; [Winter]/[Spring]/… hold swap
					// flags whose keys ("Grass = true") must never be read as
					// months. One section, and we stop when it ends.
					inSettings = (MonthKey(line) == "settings");
					continue;
				}
				if (!inSettings)
					continue;
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				const std::string key = MonthKey(line.substr(0, eq));
				const std::string val = line.substr(eq + 1);
				int               n = 0;
				try {
					n = std::stoi(val);
				} catch (...) {
					continue;
				}
				if (key == "seasontype") {
					if (n >= 0 && n <= 5) {
						g_sini.type = n;
						g_sini.haveType = true;
					}
					continue;
				}
				for (int m = 0; m < 12; ++m) {
					if (key == want[m]) {
						if (n >= 0 && n <= 4)
							g_sini.map[m] = n;
						++found;
						break;
					}
				}
			}
			g_sini.haveMap = (found >= 12);
			logger::info("widgets: season ini (type {}{}, {} month(s) mapped)",
				g_sini.type, g_sini.haveType ? "" : " assumed", found);
		}

		// ---- the Papyrus latch -------------------------------------------
		// The Int a SeasonsOfSkyrim global answers, delivered on the VM's own
		// thread. Nothing here touches game state, so unlike mhiyh's BoolResult
		// it does not need a main-thread hop — it only stores into atomics.
		// `primary` is the GetCurrentSeason call, and ONLY it owns the two
		// session-wide verdicts (does the API exist, is a dispatch outstanding).
		// The override call rides the same beat and must never be able to
		// declare the mod absent on its own — one companion answering oddly
		// would otherwise switch the whole widget to the INI fallback.
		class SeasonResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			SeasonResult(std::atomic<int>* into, bool primary) :
				_into(into), _primary(primary)
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				// The in-flight flag is cleared FIRST and unconditionally: an
				// early return below would otherwise strand it and the widget
				// would freeze at whatever it last knew, forever.
				if (_primary)
					g_seasonFlight = false;
				// IsInt() before GetSInt(): Variable::Get* reinterprets a union,
				// and a call into a script that is not loaded answers None, not 0
				// (the BoolResult lesson in mhiyh_control.cpp).
				if (!a_result.IsInt()) {
					if (_primary && g_seasonApi.exchange(-1) == 0)
						logger::info("widgets: season — SeasonsOfSkyrim answered nothing; "
						             "falling back to the INI month map");
					return;
				}
				const int v = static_cast<int>(a_result.GetSInt());
				if (_into)
					_into->store((v >= 0 && v <= 4) ? v : 0);
				if (_primary && g_seasonApi.exchange(1) == 0)
					logger::info("widgets: season live (Seasons of Skyrim answered {})", v);
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::atomic<int>* _into;
			bool              _primary;
		};

		bool DispatchSeason(const char* fn, std::atomic<int>* into, bool primary)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new SeasonResult(into, primary));
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchStaticCall("SeasonsOfSkyrim", fn, args, cb);
		}

		// Re-arm the two dispatches if the latch has gone stale. MAIN THREAD.
		void PollSeason()
		{
			if (g_seasonApi.load() < 0)
				return;   // proven absent — never ask again this session
			const long long now = NowMs();
			if (g_seasonFlight.load()) {
				// A dispatch that never called back would wedge the latch. The
				// VM drops stacks on load screens, which is exactly when this
				// widget's answer changes, so a stuck flag is not theoretical.
				if (now - g_seasonAsked.load() < kSeasonStuckMs)
					return;
				g_seasonFlight = false;
			}
			if (g_season.load() >= 0 && now - g_seasonAsked.load() < kSeasonPollMs)
				return;
			g_seasonAsked.store(now);
			g_seasonFlight = true;
			if (!DispatchSeason("GetCurrentSeason", &g_season, true)) {
				g_seasonFlight = false;
				if (g_seasonApi.exchange(-1) == 0)
					logger::info("widgets: season — SeasonsOfSkyrim.GetCurrentSeason is not "
					             "available (mod not installed?); falling back to the INI month map");
				return;
			}
			// The override rides the same beat; its own callback clears nothing
			// but its latch, and a refusal here is not worth a second warning —
			// GetCurrentSeason above already decided whether the API exists.
			(void)DispatchSeason("GetSeasonOverride", &g_seasonOvr, false);
		}

		json SeasonJson()
		{
			LoadSeasonIni();
			PollSeason();

			auto* cal = RE::Calendar::GetSingleton();
			const int mon = cal ? static_cast<int>(cal->GetMonth()) : -1;
			const int day = cal ? static_cast<int>(cal->GetDay()) : 0;

			// Where the answer comes from. The mod wins whenever it has spoken;
			// the INI map is the fallback and SAYS it is one.
			int         n = 0;
			const char* src = "";
			const bool  noApi = g_seasonApi.load() < 0;
			const bool  pinned = g_sini.haveType && g_sini.type >= 1 && g_sini.type <= 4;
			if (g_seasonApi.load() > 0 && g_season.load() >= 0) {
				n = g_season.load();
				src = "mod";
			} else if (noApi && pinned) {
				n = g_sini.type;
				src = "calendar";
			} else if (noApi && g_sini.haveMap && (!g_sini.haveType || g_sini.type == 5) &&
			           mon >= 0 && mon < 12) {
				n = g_sini.map[mon];
				src = "calendar";
			}
			// Nothing to say: seasons disabled, or nobody has answered yet. The
			// key is OMITTED (widgets.h's omit-or-tell law) — the view draws
			// nothing and its switch greys honestly, rather than showing a
			// season the world is not wearing.
			if (n < 1 || n > 4)
				return nullptr;

			json out{
				{ "id", kSeasonIds[n] },
				{ "name", kSeasonNames[n] },
				{ "n", n },
				{ "src", src },
			};
			if (mon >= 0 && mon < 12) {
				out["month"] = mon;
				out["monthName"] = kMonthNames[mon];
				out["day"] = day;
			}
			if (cal)
				out["year"] = static_cast<int>(cal->GetYear());

			// Pinned by the INI (Season Type 1-4) — there is no "next" and the
			// view should not imply one.
			if (pinned)
				out["fixed"] = true;
			const int ovr = g_seasonOvr.load();
			if (ovr >= 1 && ovr <= 4) {
				out["override"] = true;
				out["overrideName"] = kSeasonNames[ovr];
			}

			// "Spring in 6 days". Only when the whole chain is honest: the INI
			// gave us a real map, seasons are actually cycling, nothing has
			// overridden them, and the mod's own answer AGREES with what the map
			// says this month should be. That last check is what stops a wrong
			// or stale INI (a second copy winning the VFS, a mod that reloads
			// the map at runtime) from being reported as fact.
			if (!pinned && !(ovr >= 1 && ovr <= 4) && g_sini.haveMap &&
				(!g_sini.haveType || g_sini.type == 5) &&
				mon >= 0 && mon < 12 && g_sini.map[mon] == n) {
				int days = kMonthDays[mon] - day;   // days left in THIS month
				if (days < 0)
					days = 0;
				int nxt = 0;
				for (int step = 1; step <= 12; ++step) {
					const int m = (mon + step) % 12;
					if (g_sini.map[m] != n && g_sini.map[m] >= 1 && g_sini.map[m] <= 4) {
						nxt = g_sini.map[m];
						break;
					}
					days += kMonthDays[m];
				}
				if (nxt >= 1 && nxt <= 4)
					out["next"] = json{ { "id", kSeasonIds[nxt] },
						{ "name", kSeasonNames[nxt] }, { "in", days } };
			}
			return out;
		}

		// ------------------------------------------------------------- pools --
		// ONE {cur,max} formula for every bar this module draws — the player's
		// vitals, the mount's, an ally's. It is the CHAR SHEET's Pool()
		// (char_sheet.cpp:34) with the rounding moved to the source: cur =
		// GetActorValue, max = GetPermanentActorValue (base + PERMANENT
		// modifiers — the number the bar is drawn against, never
		// GetBaseActorValue), cur floored at 0 and clamped up into max so a
		// temporary fortify cannot produce a bar past its own end.
		//
		// ⚠ WHOLE POINTS, at the source. A pool regenerating at a fraction of a
		// point per frame would otherwise make every tick's payload differ and
		// the diff-gate would never fire again (widgets.h, THE DIFF-GATE LAW).
		// A player standing at full health produces a byte-identical payload.
		//
		// Deliberately NOT the reference mod's base + kPermanent + kTemporary
		// modifier reconstruction (ActorStats.cpp:9-18). That is a defensible
		// second answer, but this deck already has ONE answer to "what is her
		// max health" and the char sheet, the follower tuner and the mount
		// widget all speak it — a HUD bar disagreeing with the sheet one tab
		// away is a bug report, not a nicety.
		json PoolPoints(RE::ActorValueOwner* avo, RE::ActorValue av)
		{
			if (!avo)
				return nullptr;
			float cur = avo->GetActorValue(av);
			float mx = avo->GetPermanentActorValue(av);
			if (cur < 0.0f)
				cur = 0.0f;
			if (mx < cur)
				mx = cur;
			return json{ { "cur", static_cast<int>(std::lround(cur)) },
				{ "max", static_cast<int>(std::lround(mx)) } };
		}

		// ------------------------------------------------------------ mount --
		// Who to show when you are NOT riding. A horse forgotten the instant you
		// dismount is a useless widget; a per-tick ProcessLists sweep looking
		// for one you might own is the cost this module spent 2026-08-16
		// deleting. So we remember the last thing you actually rode — one
		// ActorHandle, zero scans — and let it go honestly the moment it dies,
		// unloads, or walks past kMountForget.
		constexpr float   kMountForget = 8192.0f;  // ~2 cells; mounts.cpp uses 4096 for "near"
		RE::ActorHandle   g_lastMount;             // main thread only
		std::uint32_t     g_mountImgFor = 0;       // runtime id the cached path belongs to
		std::string       g_mountImg;
		std::uint32_t     g_mountSaid = 0;         // last id we logged, so the marker is not spam

		json MountJson(const std::string& follow)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return nullptr;
			// `keep` owns the smart pointer for the WHOLE function on purpose:
			// an NiPointer released at the end of its little scope drops the
			// reference the raw `m` still relies on. The mount is alive in the
			// world either way, but a raw pointer outliving the only refcount
			// that names it is precisely the shape that bites later.
			RE::NiPointer<RE::Actor> keep;
			RE::Actor*               m = nullptr;
			bool                     riding = false;
			if (player->GetMount(keep) && keep) {
				m = keep.get();
				riding = true;
				g_lastMount = m->GetHandle();
			}
			if (!m && follow != "ridden") {
				keep = g_lastMount.get();
				auto* a = keep ? keep.get() : nullptr;
				if (a && !a->IsDead() && a->Is3DLoaded() &&
					a->GetPosition().GetDistance(player->GetPosition()) < kMountForget)
					m = a;
				else
					g_lastMount = RE::ActorHandle();  // gone: forget, don't guess
			}
			if (!m)
				return nullptr;  // ABSENT — never a row of zeros

			auto* avo = m->AsActorValueOwner();
			if (!avo)
				return nullptr;
			// Whole points, both stats, through the SHARED PoolPoints above —
			// this used to be a local lambda saying the same thing, and the
			// round-2 vitals widget would have made it a third copy.
			const auto pool = [avo](RE::ActorValue av) { return PoolPoints(avo, av); };

			std::string name;
			if (const char* n = m->GetDisplayFullName(); n && *n)
				name = n;
			else if (const char* n2 = m->GetName(); n2 && *n2)
				name = n2;
			else
				name = "Mount";

			json out{ { "name", name }, { "riding", riding },
				{ "hp", pool(RE::ActorValue::kHealth) },
				{ "sta", pool(RE::ActorValue::kStamina) } };

			// A body render, if the Mounts tab already baked one. Same key the
			// Mounts tab renders under (the NPC BASE's durable identity through
			// ItemIcons::BodyPathFor), so the two features share one PNG and
			// neither ever renders the same creature twice. Cached per actor —
			// the path cannot change while you are on the same horse.
			const std::uint32_t rt = m->GetFormID();
			if (rt != g_mountImgFor) {
				g_mountImgFor = rt;
				g_mountImg.clear();
				std::string fid, plug;
				if (auto* base = m->GetActorBase();
					base && ActorIdentity::DurableOf(base, fid, plug))
					g_mountImg = ItemIcons::BodyPathFor(fid, plug);
			}
			if (!g_mountImg.empty())
				out["img"] = g_mountImg;

			if (rt != g_mountSaid) {
				g_mountSaid = rt;
				// Build marker (hd-markers.json: "widgets: mount tracked").
				logger::info("widgets: mount tracked '{}' ({}, art {})", name,
					riding ? "riding" : "dismounted", g_mountImg.empty() ? "none" : g_mountImg);
			}
			return out;
		}

		// =====================================================================
		//  ROUND 2 (2026-08-17) — the PLAYER's own state.
		//
		//  Everything below closes the gap with Skyrim Party Sheet (SSE 167538,
		//  MIT, (c) 2025 Rijosan). What was taken is the ENGINE FACTS — which
		//  actor values, which formula, in what order, and which predicate makes
		//  someone a quest ally. Not one line of its presentation, and none of
		//  its assets: the layout, the glyphs and the vocabulary are the deck's.
		//  Rober's standing constraint, 2026-08-17: "do not obviously copy cody
		//  1:1 have to stay above board. But can take all the inspiration."
		//
		//  ⛔ THE DIFF-GATE LAW APPLIES TO EVERY LINE OF IT. Each builder
		//  quantises at the source, and each omits its key outright when it has
		//  nothing true to say. An idle player produces a byte-identical
		//  payload; a player with no active effect sends no `effects` key at
		//  all, not an empty array.
		// =====================================================================

		// ----------------------------------------------------------- vitals --
		// hp / magicka / stamina through the shared PoolPoints, plus level, the
		// XP bar and the shout timer.
		//
		// THE SHOUT TIMER is the one genuinely awkward number in this file: the
		// engine publishes only how much recovery is LEFT (AIProcess::high's
		// voiceRecoveryTime) and never the total, so there is nothing to draw a
		// bar against. Both this deck (hotbar.cpp's rings, play-proven) and the
		// reference mod solve it the same way and it is the only way there is —
		// LATCH the largest value seen this cooldown and treat it as 100%. The
		// latch is RESET the moment the voice is ready again, which the hotbar
		// ring does not do: resetting means the next shout re-learns its OWN
		// total instead of being drawn against the longest shout of the session.
		float g_shoutScale = 0.0f;   // main thread only

		// The one voice-recovery read, shared by VitalsJson's chip and the
		// round-3 voice tile. ONE latch (g_shoutScale), updated idempotently —
		// both callers run inside the same tick and see the same
		// voiceRecoveryTime, so a second call cannot move it. Returns true and
		// fills rem/dur while the voice is recovering; resets the latch and
		// returns false the moment it is ready (so the next shout re-learns its
		// OWN total).
		bool VoiceCd(RE::PlayerCharacter* p, int& rem, int& dur)
		{
			float voice = 0.0f;
			if (auto* proc = p ? p->GetActorRuntimeData().currentProcess : nullptr; proc && proc->high)
				voice = proc->high->voiceRecoveryTime;
			if (voice <= 0.0f) {
				g_shoutScale = 0.0f;   // ready: forget this shout's total
				return false;
			}
			if (voice > g_shoutScale)
				g_shoutScale = voice;
			// FLOOR the remainder, CEIL the total: a countdown must never claim
			// more time than is left, and the denominator must never be smaller
			// than the numerator.
			rem = static_cast<int>(std::floor(voice));
			dur = static_cast<int>(std::ceil(g_shoutScale));
			return true;
		}

		// ⛔ THE NO-SAVE GUARD. PlayerCharacter::GetSingleton() answers at the
		// MAIN MENU too, with most of the actor unbuilt — and this tick runs
		// there, because the widget ticker starts at kDataLoaded, not on a load.
		// PlaceJson already refuses on the same test ("no save loaded /
		// mid-transition"), and every round-2 builder that reads player-derived
		// state must refuse with it: GetGameStatsData() in particular is a
		// dereference of the player's skill block, which is exactly the thing
		// that does not exist before a save is in.
		RE::PlayerCharacter* PlayerInWorld()
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			return (p && p->GetParentCell()) ? p : nullptr;
		}

		json VitalsJson()
		{
			auto* p = PlayerInWorld();
			auto* avo = p ? p->AsActorValueOwner() : nullptr;
			if (!p || !avo)
				return nullptr;

			json out{
				{ "hp", PoolPoints(avo, RE::ActorValue::kHealth) },
				{ "mag", PoolPoints(avo, RE::ActorValue::kMagicka) },
				{ "sta", PoolPoints(avo, RE::ActorValue::kStamina) },
				{ "lvl", static_cast<int>(p->GetLevel()) },
				{ "combat", p->IsInCombat() },
			};

			// XP toward the next level. It does NOT live on GameStateData (that
			// struct is only 0xC bytes: difficulty, assumedIdentity, murder,
			// perkCount, byCharGenFlag) — it lives on PlayerSkills::Data, which
			// hangs off the INFO runtime data. The pointer chain is real memory
			// the engine may not have built yet, so both hops are null-checked.
			// A threshold of 0 means the engine has not published one yet (no
			// save loaded, mid-level-up) — the key is OMITTED then, so the view
			// draws no bar rather than an empty one.
			const auto* pskills = p->GetInfoRuntimeData().skills;
			const auto* sdata = pskills ? pskills->data : nullptr;
			if (sdata) {
				const float thr = sdata->levelThreshold;
				if (thr > 0.0f) {
					float cur = sdata->xp;
					if (cur < 0.0f)
						cur = 0.0f;
					if (cur > thr)
						cur = thr;
					out["xp"] = json{ { "cur", static_cast<int>(std::lround(cur)) },
						{ "max", static_cast<int>(std::lround(thr)) } };
				}
			}

			if (int rem = 0, dur = 0; VoiceCd(p, rem, dur))
				out["shout"] = json{ { "rem", rem }, { "dur", dur } };
			return out;
		}

		// ---------------------------------------------------------- effects --
		// Active buffs and debuffs with time remaining.
		//
		// THE CLASSIFICATION IS THE CHAR SHEET'S, verbatim (char_sheet.cpp's
		// EffectGroup): the group comes off the SOURCE RECORD's spell type and
		// the base effect's detrimental/hostile flags — never off the English
		// name, never off the sign of the magnitude. The sheet and the HUD must
		// give the same answer for the same effect.
		//
		// WHERE THIS DELIBERATELY DIVERGES FROM THE SHEET, and why:
		//   * kHideInUI rows are DROPPED here and KEPT there. The sheet is an
		//     inspector and folds them; a HUD that shows what the game asked it
		//     not to show is just noise.
		//   * permanent effects (duration 0 — racials, abilities, worn
		//     enchantments) are dropped. On this load order that is dozens of
		//     rows that never change; the sheet's "constant" group is where you
		//     go to read them.
		//   * anything under kMinFxSec is dropped: a 1-second effect would
		//     appear and vanish between two ticks and read as a flicker.
		// Both cuts match the reference mod's own filter cascade, which arrived
		// at them for the same reasons.
		constexpr int   kMaxFxRows = 12;   // a HUD row, not a spreadsheet
		constexpr float kMinFxSec = 2.0f;

		const char* FxGroupOf(RE::MagicItem* src, bool harmful, float durSec)
		{
			if (src) {
				using T = RE::MagicSystem::SpellType;
				switch (src->GetSpellType()) {
				case T::kDisease:
				case T::kAddiction:
					return "disease";
				case T::kPoison:
					return "poison";
				default:
					break;
				}
			}
			if (harmful)
				return "debuff";
			if (durSec <= 0.0f)
				return "constant";
			return "buff";
		}

		// Seconds remaining, quantised so an idle player is byte-identical for
		// as long as honesty allows. Under 100 s the view prints a live
		// second-by-second countdown, so whole seconds it is; above that the
		// view prints minutes, so a whole MINUTE is the smallest step that can
		// change what is on screen — an eight-hour Fortify Restoration therefore
		// produces one identical payload for a minute at a time instead of
		// re-pushing the whole HUD once a second for eight hours.
		int QuantiseRemaining(float rem)
		{
			if (rem <= 0.0f)
				return 0;
			if (rem < 100.0f)
				return static_cast<int>(std::floor(rem));
			return static_cast<int>(std::floor(rem / 60.0f)) * 60;
		}

		json EffectsJson()
		{
			auto* p = PlayerInWorld();
			auto* mt = p ? p->AsMagicTarget() : nullptr;
			auto* list = mt ? mt->GetActiveEffectList() : nullptr;
			if (!list)
				return nullptr;

			struct Row
			{
				float       rem;
				std::string sort;   // group + name: the STABLE display order
				json        j;
			};
			std::vector<Row> rows;
			for (auto* ae : *list) {
				if (!ae)
					continue;
				if (ae->flags.any(RE::ActiveEffect::Flag::kInactive) ||
					ae->flags.any(RE::ActiveEffect::Flag::kDispelled))
					continue;
				auto* eff = ae->effect;
				auto* base = eff ? eff->baseEffect : nullptr;
				if (!base)
					continue;
				if (base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI))
					continue;
				const float dur = ae->duration;
				if (dur < kMinFxSec)
					continue;
				const float rem = dur - ae->elapsedSeconds;
				if (rem <= 0.0f)
					continue;
				const char* nm = base->GetFullName();
				if (!nm || !*nm)
					continue;

				const bool harmful =
					base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kDetrimental) ||
					base->IsHostile();
				const char* group = FxGroupOf(ae->spell, harmful, dur);

				json j{
					{ "name", std::string(nm) },
					{ "group", group },
					{ "rem", QuantiseRemaining(rem) },
					{ "dur", static_cast<int>(std::floor(dur)) },
				};
				// Magnitude is stable for the life of the effect, so it costs the
				// diff-gate nothing. abs() because the sign is already carried by
				// the group — a "-40 Health" debuff reading "40" under a red
				// arrow says the same thing without the double negative.
				const int mag = static_cast<int>(std::lround(std::fabs(ae->magnitude)));
				if (mag > 0)
					j["mag"] = mag;
				rows.push_back(Row{ rem, std::string(group) + "\x1f" + nm, std::move(j) });
			}
			if (rows.empty())
				return nullptr;

			// TWO-STAGE ORDER, and the reason is the always-on law. If there are
			// more effects than fit, the ones worth the space are the ones about
			// to run out — so the CUT is by remaining time. But the surviving
			// rows are then sorted by group+name, which only changes when the SET
			// changes: sorting the drawn list by a countdown would re-order the
			// pills as two effects crossed and force a structural rebuild of the
			// row for nothing.
			if (rows.size() > static_cast<std::size_t>(kMaxFxRows)) {
				std::partial_sort(rows.begin(), rows.begin() + kMaxFxRows, rows.end(),
					[](const Row& a, const Row& b) { return a.rem < b.rem; });
				rows.resize(static_cast<std::size_t>(kMaxFxRows));
			}
			std::sort(rows.begin(), rows.end(),
				[](const Row& a, const Row& b) { return a.sort < b.sort; });

			json arr = json::array();
			for (auto& r : rows)
				arr.push_back(std::move(r.j));
			return arr;
		}

		// ------------------------------------------------------------ equip --
		// What is in your hands right now, and what you are shooting.
		//
		// Three tiles, in a fixed order — right, left, ammo — so the row cannot
		// reflow as you swap. An empty hand is still a tile (kind "empty"); the
		// AMMO tile is the one exception and appears only when something is
		// actually nocked, because a permanent empty quiver beside a mage is
		// clutter rather than information.
		constexpr int kMaxEqBadges = 3;

		// A NARROWER percent table than char_sheet.cpp's AvIsPercent, on purpose.
		// That one also covers every skill modifier and every regen rate, which a
		// weapon or armour enchantment essentially never carries. The failure
		// mode of the short list is a percent enchant printing "+40" instead of
		// "40%" on a 22px pill — cosmetic, and the char sheet has the exact
		// answer one tab away. Getting it wrong the other way (a "+25 Health"
		// amulet claiming "25%") is the one that actually misleads, and the six
		// resists below are what causes it.
		bool EqAvIsPercent(RE::ActorValue av)
		{
			switch (av) {
			case RE::ActorValue::kResistFire:
			case RE::ActorValue::kResistFrost:
			case RE::ActorValue::kResistShock:
			case RE::ActorValue::kResistMagic:
			case RE::ActorValue::kPoisonResist:
			case RE::ActorValue::kResistDisease:
			case RE::ActorValue::kSpeedMult:
			case RE::ActorValue::kWeaponSpeedMult:
				return true;
			default:
				return false;
			}
		}

		// One item -> one `kind` word, the vocabulary the quick strips, the
		// custom strip and the item picker all draw their glyph from. Extracted
		// 2026-08-18 from the favourites walk so the three surfaces cannot
		// drift into three spellings of "is this a shield".
		const char* KindOf(RE::TESBoundObject* obj)
		{
			if (!obj)
				return "misc";
			switch (obj->GetFormType()) {
			case RE::FormType::Weapon: return "weapon";
			case RE::FormType::Armor:
				if (auto* a = obj->As<RE::TESObjectARMO>())
					return a->IsShield() ? "shield" : "armor";
				return "armor";
			case RE::FormType::Ammo: return "ammo";
			case RE::FormType::AlchemyItem:
				if (auto* al = obj->As<RE::AlchemyItem>())
					return al->IsPoison() ? "poison" : al->IsFood() ? "food" : "potion";
				return "potion";
			case RE::FormType::Scroll: return "scroll";
			case RE::FormType::Book: return "book";
			case RE::FormType::Light: return "torch";
			case RE::FormType::Ingredient: return "ingredient";
			default: return "misc";
			}
		}

		// The identity pair the mesh-render pipeline keys on. A byte copy of
		// char_sheet.cpp's PutIdentity — file-static there, so it cannot be
		// called across the translation unit. ⚠ NEVER GetLocalFormID(): it
		// null-derefs on a dynamic form (the 2026-08-03 crash).
		void PutItemIdentity(json& row, RE::TESForm* f)
		{
			if (!f)
				return;
			auto* file = f->GetFile(0);
			if (!file)
				return;
			const std::uint32_t local = f->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%06X", local);
			row["formId"] = buf;
			row["plugin"] = std::string(file->GetFilename());
		}

		// The "+N" / "40%" cluster, off the form's OWN enchantment record. Same
		// deliberate gap as the char sheet's: a PLAYER-made enchantment rides
		// ExtraEnchantment on the inventory entry, not the base form, so a
		// self-enchanted sword shows no badge. A false negative — the tile just
		// says nothing — which is the acceptable failure.
		json EqBadges(RE::TESForm* form)
		{
			json badges = json::array();
			auto* ench = form ? form->As<RE::TESEnchantableForm>() : nullptr;
			auto* item = ench ? ench->formEnchanting : nullptr;
			if (!item)
				return badges;
			int n = 0;
			for (auto* effect : item->effects) {
				if (n >= kMaxEqBadges)
					break;
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				const double mag = static_cast<double>(effect->effectItem.magnitude);
				if (mag <= 0.0)
					continue;
				char buf[24];
				if (EqAvIsPercent(base->data.primaryAV))
					std::snprintf(buf, sizeof(buf), "%.0f%%", mag);
				else
					std::snprintf(buf, sizeof(buf), "+%.0f", mag);
				badges.push_back(json{ { "text", std::string(buf) } });
				++n;
			}
			// An enchantment whose every effect is scripted or zero-magnitude
			// still makes the piece enchanted — say so with a bare mark rather
			// than letting it read as mundane.
			if (badges.empty())
				badges.push_back(json{ { "text", "\xE2\x9C\xA6" } });   // ✦
			return badges;
		}

		// ---- spell icon metadata (round 3) -------------------------------
		// school / element / tier for a spell or voice tile — what the HUD's
		// icon resolver ladder consumes (hud.js hudIconIndex: override ->
		// byForm exact -> school/tier generic -> glyph, the Spell Deck's own
		// chain). A faithful reduction of mounts.cpp's FillSpellMeta, which is
		// itself a mirror of spell_actions' anon-namespace originals — three
		// copies because the originals are TU-static; all three read the same
		// engine fields, so they cannot disagree.
		const char* IconSchoolAV(RE::ActorValue av)
		{
			switch (av) {
			case RE::ActorValue::kAlteration:  return "alteration";
			case RE::ActorValue::kConjuration: return "conjuration";
			case RE::ActorValue::kDestruction: return "destruction";
			case RE::ActorValue::kIllusion:    return "illusion";
			case RE::ActorValue::kRestoration: return "restoration";
			default:                           return "";
			}
		}
		void PutSpellIconMeta(json& t, RE::SpellItem* s)
		{
			if (!s)
				return;
			std::string school;
			if (auto skill = s->GetAssociatedSkill(); skill != RE::ActorValue::kNone)
				school = IconSchoolAV(skill);
			if (auto* eff = s->GetAVEffect()) {
				switch (eff->data.resistVariable) {
				case RE::ActorValue::kResistFire:  t["element"] = "fire"; break;
				case RE::ActorValue::kResistFrost: t["element"] = "frost"; break;
				case RE::ActorValue::kResistShock: t["element"] = "shock"; break;
				default: break;
				}
				if (school.empty())
					school = IconSchoolAV(eff->GetMagickSkill());
			}
			if (!school.empty())
				t["school"] = school;
			if (s->GetSpellType() == RE::MagicSystem::SpellType::kSpell) {
				const auto* eff  = s->GetCostliestEffectItem();
				const auto* base = eff ? eff->baseEffect : nullptr;
				const auto  min  = base ? base->data.minimumSkill : 0;
				t["tier"] = min >= 100 ? "master" : min >= 75 ? "expert" : min >= 50 ? "adept"
					: min >= 25       ? "apprentice"
					                  : "novice";
			}
		}

		json HandTile(RE::PlayerCharacter* p, const char* slot, const char* label,
			RE::TESForm* form, bool left)
		{
			json t{ { "slot", slot }, { "label", label }, { "kind", "empty" }, { "name", "" } };
			if (!p || !form)
				return t;
			PutItemIdentity(t, form);
			// The As<> cascade and the name read are the char sheet's: the name
			// comes off the CONCRETE narrowed record in each branch, never off
			// the bare TESForm*.
			if (auto* weap = form->As<RE::TESObjectWEAP>()) {
				t["kind"] = "weapon";
				if (const char* n = weap->GetFullName(); n && *n)
					t["name"] = n;
				// The ENGINE's own number: GetDamage on the equipped entry folds
				// in skill, perks, fortifies and temper. The base record's
				// GetAttackDamage is only the fallback when there is no entry.
				double dmg = static_cast<double>(weap->GetAttackDamage());
				if (auto* entry = p->GetEquippedEntryData(left))
					dmg = p->GetDamage(entry);
				t["damage"] = static_cast<int>(std::lround(dmg < 0.0 ? 0.0 : dmg));
				const auto wt = weap->GetWeaponType();
				if (wt == RE::WEAPON_TYPE::kBow || wt == RE::WEAPON_TYPE::kCrossbow)
					t["ranged"] = true;
				t["badges"] = EqBadges(form);
			} else if (auto* armo = form->As<RE::TESObjectARMO>()) {
				t["kind"] = "shield";
				if (const char* n = armo->GetFullName(); n && *n)
					t["name"] = n;
				t["armor"] = static_cast<int>(armo->GetArmorRating());
				t["badges"] = EqBadges(form);
			} else if (auto* sp = form->As<RE::SpellItem>()) {
				t["kind"] = "spell";
				if (const char* n = sp->GetFullName(); n && *n)
					t["name"] = n;
				// Round 3: the resolver metadata that lets the HUD draw this
				// spell's real Spell-Hotbar art instead of the vector glyph.
				PutSpellIconMeta(t, sp);
			} else if (auto* obj = form->As<RE::TESBoundObject>()) {
				t["kind"] = "other";   // a torch, a lantern
				if (const char* n = obj->GetName(); n && *n)
					t["name"] = n;
			}
			if (t.value("name", std::string()).empty())
				t["kind"] = "empty";
			return t;
		}

		// Count one carried object the crash-safe way — the ReadLockpicksRaw
		// discipline (finance.cpp's ReadGold seam): walk the inventory-changes
		// entry list, never GetInventory<>(), which has faulted inside this DLL
		// on the 4,780-mod order. PODs only inside the __try frame (C2712), and
		// __declspec(noinline) so the walk owns its own frame.
		__declspec(noinline) std::int64_t ReadObjCountRaw(RE::TESBoundObject* want)
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p || !want)
				return 0;
			std::int64_t total = 0;
			auto*        changes = p->GetInventoryChanges();
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object == want)
						total += entry->countDelta;
				}
			}
			return total;
		}
		std::int64_t ReadObjCount(RE::TESBoundObject* want)
		{
			__try {
				return ReadObjCountRaw(want);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return -1;
			}
		}

		json EquipJson()
		{
			auto* p = PlayerInWorld();
			if (!p)
				return nullptr;
			RE::TESForm* rh = p->GetEquippedObject(false);
			RE::TESForm* lh = p->GetEquippedObject(true);

			// TWO-HANDER DEDUPE. The engine hands back the SAME form for both
			// hands on a greatsword, a battleaxe and a bow — drawing it twice
			// would read as dual-wielding it. Blank the left slot, but only when
			// nothing genuinely occupies it (a spell in the off hand while the
			// right holds a bow does exist).
			if (lh && lh == rh) {
				if (auto* w = rh->As<RE::TESObjectWEAP>()) {
					const auto wt = w->GetWeaponType();
					const bool twoHanded = wt == RE::WEAPON_TYPE::kTwoHandSword ||
					                       wt == RE::WEAPON_TYPE::kTwoHandAxe ||
					                       wt == RE::WEAPON_TYPE::kBow ||
					                       wt == RE::WEAPON_TYPE::kCrossbow;
					if (twoHanded && !p->GetEquippedEntryData(true))
						lh = nullptr;
				}
			}

			json arr = json::array();
			arr.push_back(HandTile(p, "right", "Right", rh, false));
			arr.push_back(HandTile(p, "left", "Left", lh, true));

			// Round 3: the VOICE tile — Party Sheet's third slot ("use the
			// shouts icons, shouts should also support powers"). Emitted ONLY
			// when something is actually equipped there: the stacked equip
			// block predates it, and a permanent empty fourth tile would
			// reflow every spellless HUD for nothing. kind shout | power |
			// lesser; cd rides the same latch the vitals chip uses.
			if (auto* vf = p->GetActorRuntimeData().selectedPower) {
				json t{ { "slot", "voice" }, { "label", "Shout" },
					{ "kind", "shout" }, { "name", "" } };
				PutItemIdentity(t, vf);
				if (auto* sh = vf->As<RE::TESShout>()) {
					if (const char* n = sh->GetFullName(); n && *n)
						t["name"] = n;
					if (auto* w0 = sh->variations[0].spell)
						PutSpellIconMeta(t, w0);
				} else if (auto* sp = vf->As<RE::SpellItem>()) {
					t["kind"] = sp->GetSpellType() == RE::MagicSystem::SpellType::kLesserPower
						? "lesser" : "power";
					t["label"] = "Power";
					if (const char* n = sp->GetFullName(); n && *n)
						t["name"] = n;
					PutSpellIconMeta(t, sp);
				}
				if (!t.value("name", std::string()).empty()) {
					if (int rem = 0, dur = 0; VoiceCd(p, rem, dur))
						t["cd"] = json{ { "rem", rem }, { "dur", dur } };
					static bool s_voiceLogged = false;
					if (!s_voiceLogged) {
						s_voiceLogged = true;
						logger::info("widgets: voice slot live ('{}')",
							t["name"].get<std::string>());
					}
					arr.push_back(std::move(t));
				}
			}

			if (auto* ammo = p->GetCurrentAmmo()) {
				json t{ { "slot", "ammo" }, { "label", "Ammo" }, { "kind", "ammo" } };
				PutItemIdentity(t, ammo);
				const char* n = ammo->GetName();
				t["name"] = (n && *n) ? n : "Ammo";
				t["damage"] = static_cast<int>(ammo->GetRuntimeData().data.damage);
				const std::int64_t have = ReadObjCount(ammo);
				// -1 is the read-failed sentinel and travels: the view prints "?"
				// rather than claiming an empty quiver.
				t["count"] = static_cast<int>(have);
				t["badges"] = EqBadges(ammo);
				arr.push_back(std::move(t));
			}
			return arr;
		}

		// ----------------------------------------------------------- resist --
		// The six resist actor values, the armour rating, and what that rating
		// actually buys you.
		//
		// phys = clamp(rating * 0.12 + 3 * wornPieces, 0, 80) is SKYRIM'S OWN
		// formula — which is why the worn-piece census below exists at all, and
		// why clothing is excluded (the per-piece +3 does not apply to it). It
		// is the same formula char_sheet.cpp's ResistJson uses, and the same one
		// the reference mod arrived at; there is only one right answer here.
		//
		// The census is done with GetWornArmor over the seven slots that can
		// carry armour, NOT with an inventory walk: this widget ticks at ~1 Hz
		// and the module spent 2026-08-16 deleting exactly that kind of steady
		// cost. Deduped by form id because a robe occupies several slots at once.
		int WornArmorPieces(RE::PlayerCharacter* p)
		{
			if (!p)
				return 0;
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;
			const Slot slots[] = { Slot::kHead, Slot::kHair, Slot::kCirclet, Slot::kBody,
				Slot::kHands, Slot::kFeet, Slot::kShield };
			std::vector<RE::FormID> seen;
			int                     n = 0;
			for (const auto s : slots) {
				auto* a = p->GetWornArmor(s);
				if (!a)
					continue;
				const auto id = a->GetFormID();
				if (std::find(seen.begin(), seen.end(), id) != seen.end())
					continue;
				seen.push_back(id);
				if (a->GetArmorType() != RE::TESObjectARMO::ArmorType::kClothing)
					++n;
			}
			return n;
		}

		json ResistJson()
		{
			auto* p = PlayerInWorld();
			auto* avo = p ? p->AsActorValueOwner() : nullptr;
			if (!avo)
				return nullptr;
			const auto pctOf = [avo](RE::ActorValue av) {
				// Whole percent at the source — a resist AV does not drift, but
				// a fortify potion ticking off would otherwise send fractions.
				return static_cast<int>(std::lround(avo->GetActorValue(av)));
			};
			const double rating = static_cast<double>(avo->GetActorValue(RE::ActorValue::kDamageResist));
			const int    pieces = WornArmorPieces(p);
			double       phys = rating * 0.12 + 3.0 * static_cast<double>(pieces);
			if (phys < 0.0)
				phys = 0.0;
			if (phys > 80.0)
				phys = 80.0;
			return json{
				{ "armor", static_cast<int>(std::lround(rating < 0.0 ? 0.0 : rating)) },
				{ "phys", static_cast<int>(std::lround(phys)) },
				{ "fire", pctOf(RE::ActorValue::kResistFire) },
				{ "frost", pctOf(RE::ActorValue::kResistFrost) },
				{ "shock", pctOf(RE::ActorValue::kResistShock) },
				{ "magic", pctOf(RE::ActorValue::kResistMagic) },
				{ "poison", pctOf(RE::ActorValue::kPoisonResist) },
				{ "disease", pctOf(RE::ActorValue::kResistDisease) },
				{ "pieces", pieces },
				// The caps ride WITH the data so the view draws each meter
				// against the right full scale — magic tops out at 85, not 100.
				{ "capMagic", 85 },
				{ "capPhys", 80 },
			};
		}

		// --------------------------------------------------------- survival --
		// SunHelm's hunger / thirst / fatigue / cold.
		//
		// ⚠ WHY THIS IS NOT Survival::StateJson(). The needs block is welded
		// inside a ~900-line builder that also runs a full inventory walk and
		// resolves every camp mod's powers; calling it at ~1 Hz would break this
		// module's own walk law outright. survival.cpp is READ-ONLY to this pass
		// (it belongs to another surface), so the cheap half cannot be exported
		// today. What IS shared is the SOURCE OF TRUTH and the table: the exact
		// editor ids below were dumped out of SunHelmSurvival.esp for
		// survival.cpp and are copied from it unchanged. If that table ever
		// changes, change it here too — or better, export a Survival::NeedsJson()
		// and delete this block (see the report).
		//
		// The globals are resolved ONCE into pointers (the EnsureLocKeywords
		// idiom), so the per-tick cost is a float read. A missing global means
		// that need is not in this build of the mod and the meter is OMITTED —
		// never invented as a zero, because an invented number is worse than no
		// number when you are deciding whether to eat.
		struct NeedDef
		{
			const char* id;
			const char* label;
			const char* value;
			const char* cap;       // may be null
			const char* disabled;  // may be null
		};
		const NeedDef kNeeds[] = {
			{ "hunger", "Hunger", "_SHCurrentHungerLevel", nullptr, "_SHHungerShouldBeDisabled" },
			{ "thirst", "Thirst", "_SHCurrentThirstLevel", nullptr, "_SHThirstShouldBeDisabled" },
			{ "fatigue", "Fatigue", "_SHCurrentFatigueLevel", nullptr, "_SHFatigueShouldBeDisabled" },
			{ "cold", "Cold", "_SHCurrentColdLevel", "_SHColdLevelCap", "_SHColdShouldBeDisabled" },
		};
		struct NeedForms
		{
			RE::TESGlobal* value = nullptr;
			RE::TESGlobal* cap = nullptr;
			RE::TESGlobal* disabled = nullptr;
		};
		NeedForms      g_needs[std::size(kNeeds)];
		RE::TESGlobal* g_shEnabled = nullptr;
		RE::TESGlobal* g_shHeat = nullptr;
		RE::TESGlobal* g_shFreezing = nullptr;
		RE::TESGlobal* g_shAmbient = nullptr;
		bool           g_needsReady = false;
		// Names verified from the installed SunHelmSurvival.esp, 2026-09-23.
		// Read the mod's actual ability, not guessed raw-value thresholds.
		struct NeedStage { const char* need; const char* edid; int urgency; RE::SpellItem* spell = nullptr; };
		NeedStage g_needStages[] = {
			{"hunger", "_SHPosHunger", 0}, {"hunger", "_SHHunger00", 0},
			{"hunger", "_SHHunger01", 1}, {"hunger", "_SHHunger02", 2},
			{"hunger", "_SHHunger03", 3}, {"hunger", "_SHHunger04", 4},
			{"thirst", "_SHThirst00", 0}, {"thirst", "_SHThirst01", 0},
			{"thirst", "_SHThirst02", 1}, {"thirst", "_SHThirst03", 2},
			{"thirst", "_SHThirst04", 3}, {"thirst", "_SHThirst05", 4},
			{"fatigue", "_SHFatigue00", 0}, {"fatigue", "_SHFatigue01", 0},
			{"fatigue", "_SHFatigue02", 1}, {"fatigue", "_SHFatigue03", 2},
			{"fatigue", "_SHFatigue04", 3}, {"fatigue", "_SHFatigue05", 4}
		};


		RE::TESGlobal* GlobalByEdid(const char* edid)
		{
			return edid ? RE::TESForm::LookupByEditorID<RE::TESGlobal>(edid) : nullptr;
		}

		void EnsureNeedForms()
		{
			if (g_needsReady)
				return;
			g_needsReady = true;
			int found = 0;
			for (std::size_t i = 0; i < std::size(kNeeds); ++i) {
				g_needs[i].value = GlobalByEdid(kNeeds[i].value);
				g_needs[i].cap = GlobalByEdid(kNeeds[i].cap);
				g_needs[i].disabled = GlobalByEdid(kNeeds[i].disabled);
				if (g_needs[i].value)
					++found;
			}
			int stages = 0;
			for (auto& stage : g_needStages) {
				stage.spell = RE::TESForm::LookupByEditorID<RE::SpellItem>(stage.edid);
				if (stage.spell) ++stages;
			}
			logger::info("widgets: SunHelm condition spells resolved ({})", stages);
			g_shEnabled = GlobalByEdid("_SHEnabled");
			g_shHeat = GlobalByEdid("_SHIsNearHeatSource");
			g_shFreezing = GlobalByEdid("_SHIsInFreezingWater");
			g_shAmbient = GlobalByEdid("_SHAmbientTemperature");
			// Build marker (hd-markers.json: "widgets: survival globals").
			logger::info("widgets: survival globals resolved ({} of {} needs)",
				found, static_cast<int>(std::size(kNeeds)));
		}

		json SurvivalJson()
		{
			EnsureNeedForms();
			json meters = json::array();
			for (std::size_t i = 0; i < std::size(kNeeds); ++i) {
				auto* g = g_needs[i].value;
				if (!g)
					continue;
				// Whole points: a need that creeps up by hundredths every frame
				// would defeat the diff-gate on its own.
				json m{ { "id", kNeeds[i].id }, { "label", kNeeds[i].label },
					{ "v", static_cast<int>(std::lround(g->value)) } };
				if (g_needs[i].cap && g_needs[i].cap->value > 0.0f)
					m["max"] = static_cast<int>(std::lround(g_needs[i].cap->value));
				if (g_needs[i].disabled && g_needs[i].disabled->value != 0.0f)
					m["off"] = true;   // the player turned this need off in the MCM
				if (auto* pc = RE::PlayerCharacter::GetSingleton()) {
					const NeedStage* active = nullptr;
					for (const auto& stage : g_needStages) {
						if (std::strcmp(stage.need, kNeeds[i].id) == 0 && stage.spell && pc->HasSpell(stage.spell) &&
							(!active || stage.urgency > active->urgency)) active = &stage;
					}
					if (active) {
						m["level"] = active->urgency;
						const char* name = active->spell->GetName();
						m["state"] = name ? name : "";
					}
				}
				meters.push_back(std::move(m));
			}
			if (meters.empty())
				return nullptr;   // the mod is not installed: no block at all
			json out{
				{ "present", true },
				{ "mod", "SunHelm Survival" },
				// The mod installed with its own master switch OFF still draws —
				// greyed and labelled. Vanishing would read as our bug rather
				// than the player's setting.
				{ "on", !g_shEnabled || g_shEnabled->value != 0.0f },
				{ "meters", std::move(meters) },
				{ "nearHeat", g_shHeat && g_shHeat->value != 0.0f },
				{ "freezing", g_shFreezing && g_shFreezing->value != 0.0f },
			};
			if (g_shAmbient)
				out["ambient"] = static_cast<int>(std::lround(g_shAmbient->value));
			return out;
		}

		// ----------------------------------------------------------- allies --
		// The people fighting beside you who are NOT on your roster: a jarl's
		// housecarl during a quest, a Companion on a radiant hunt, a stormcloak
		// in a set-piece battle. The follower strip has never shown them.
		//
		// THE PREDICATE is the reference mod's (FollowerHUD::IsQuestAlly), whose
		// engine facts are worth having: CurrentFollowerFaction is 0x0005A1A4,
		// membership of it ALONE is not enough (a between-quests follower would
		// clutter the HUD forever), and combat on either side is what makes it
		// current. Two deliberate differences:
		//
		//   * it also honours a user-editable party_allies.ini whitelist backed
		//     by a package-type confirmation. There is no ini plumbing on this
		//     side and inventing one for a HUD row is not worth a new file, so
		//     the whitelist arm is replaced by a PURE-ENGINE second arm: an
		//     actor on a follow/escort/accompany package who is in combat and is
		//     not hostile to you. Same idea (the package must confirm they are
		//     actually tagging along), no configuration.
		//   * summons are excluded via IsCommandedActor() alone; the reference
		//     also calls IsSummoned(), which nothing in this tree has compiled
		//     against. A commanded actor covers conjurations and thralls, which
		//     is what the exclusion is for.
		//
		// COST. This is the only per-tick walk in the round-2 set, so it is gated
		// on combat with a lingering window: allies that blinked out between two
		// draugr would be worse than useless, and a walk of highActorHandles
		// while you are wandering an empty road is exactly the steady cost this
		// module spent 2026-08-16 deleting.
		constexpr int    kMaxAllies = 6;
		constexpr double kAllyLingerSec = 6.0;
		std::chrono::steady_clock::time_point g_combatSeen{};

		bool IsFollowishPackage(const RE::TESPackage* pkg)
		{
			if (!pkg)
				return false;
			switch (pkg->packData.packType.get()) {
			case RE::PACKAGE_TYPE::kFollow:
			case RE::PACKAGE_TYPE::kEscort:
			case RE::PACKAGE_TYPE::kAccompany:
				return true;
			default:
				return false;
			}
		}

		json AlliesJson()
		{
			auto* p = PlayerInWorld();
			if (!p)
				return nullptr;
			const auto now = std::chrono::steady_clock::now();
			if (p->IsInCombat())
				g_combatSeen = now;
			if (g_combatSeen.time_since_epoch().count() == 0)
				return nullptr;
			if (std::chrono::duration<double>(now - g_combatSeen).count() > kAllyLingerSec)
				return nullptr;

			auto* lists = RE::ProcessLists::GetSingleton();
			if (!lists)
				return nullptr;
			auto* faction = RE::TESForm::LookupByID<RE::TESFaction>(0x0005A1A4);  // CurrentFollowerFaction

			// Gathered into a vector of (sort key, row) and sorted THERE, not in
			// the json array: nlohmann's iterator is bidirectional, and std::sort
			// wants random access. Sorting the array directly is the kind of
			// thing that compiles on one standard library and not the next.
			std::vector<std::pair<std::string, json>> rows;
			for (auto& h : lists->highActorHandles) {
				if (rows.size() >= static_cast<std::size_t>(kMaxAllies))
					break;
				auto  ptr = h.get();
				auto* a = ptr ? ptr.get() : nullptr;
				if (!a || a == p)
					continue;
				if (a->IsDead() || !a->Is3DLoaded())
					continue;
				// A real follower is already on the strip; a summon is yours, not
				// an ally who turned up.
				if (a->IsPlayerTeammate() || a->IsCommandedActor())
					continue;
				const bool inFaction = faction && a->IsInFaction(faction);
				const bool tagging = a->IsInCombat() && IsFollowishPackage(a->GetCurrentPackage());
				if (!inFaction && !tagging)
					continue;
				// Faction membership needs combat on EITHER side; the package arm
				// already required the ally's own.
				if (inFaction && !tagging && !p->IsInCombat() && !a->IsInCombat())
					continue;

				std::string nm;
				if (const char* n = a->GetDisplayFullName(); n && *n)
					nm = n;
				else if (const char* n2 = a->GetName(); n2 && *n2)
					nm = n2;
				else
					continue;   // nameless = scenery, never a HUD row

				json row{ { "name", nm } };
				if (auto* base = a->GetActorBase()) {
					std::string fid, plug;
					if (ActorIdentity::DurableOf(base, fid, plug)) {
						row["formId"] = fid;
						row["plugin"] = plug;
					}
				}
				row["hp"] = PoolPoints(a->AsActorValueOwner(), RE::ActorValue::kHealth);
				rows.emplace_back(std::move(nm), std::move(row));
			}
			if (rows.empty())
				return nullptr;
			// STABLE ORDER. Sorting by distance would re-order the chips as
			// everyone moved and rebuild the strip every tick; by name it changes
			// only when the party does.
			std::sort(rows.begin(), rows.end(),
				[](const auto& a, const auto& b) { return a.first < b.first; });
			json arr = json::array();
			for (auto& r : rows)
				arr.push_back(std::move(r.second));
			return arr;
		}

		// --------------------------------------------- the ONE inventory walk --
		// EVENT-DRIVEN (2026-08-17). The potion pools and every tracker count
		// come out of a SINGLE GetInventory pass — and that pass now runs only
		// when something moved. A TESContainerChangedEvent involving the player
		// sets g_invDirty; the next live tick rebuilds; a player who is walking
		// around not picking things up pays NOTHING.
		//
		// The 15 s floor is the honesty clause: if an inventory change ever
		// reaches the bag without an event (a mod writing the entry list
		// directly, an event source we failed to attach to), a stale count
		// repairs itself within 15 s instead of lying until the next pickup.
		std::atomic<bool> g_invDirty{ true };
		std::atomic<int>  g_resolveGen{ 0 };   // bumped on config change / save load

		// The sink itself. Everything it does is set a flag — no form lookups,
		// no engine reads, nothing that cares which thread it runs on (the
		// CombatArts ContainerSink precedent, minus even the set lookup).
		//
		// Deliberately NOT filtered by "is this a form we track": deciding that
		// needs a LookupByID off the game thread, and the cost of a false
		// positive is ONE extra walk within 900 ms. Looting a whole chest fires
		// a burst of events and still costs exactly one walk.
		class ContainerSink final : public RE::BSTEventSink<RE::TESContainerChangedEvent>
		{
		public:
			static ContainerSink* GetSingleton()
			{
				static ContainerSink s;
				return &s;
			}
			RE::BSEventNotifyControl ProcessEvent(const RE::TESContainerChangedEvent* ev,
				RE::BSTEventSource<RE::TESContainerChangedEvent>*) override
			{
				constexpr RE::FormID kPlayerId = 0x00000014;
				if (ev && (ev->newContainer == kPlayerId || ev->oldContainer == kPlayerId))
					g_invDirty = true;
				return RE::BSEventNotifyControl::kContinue;
			}
		};

		struct InvCache
		{
			bool                                  have = false;
			int                                   gen = -1;
			json                                  pots = json::object();
			json                                  quick = json::array();  // round 3: favourited items
			std::vector<int>                      pinCounts, setCounts;
			std::vector<int>                      quick2Counts;  // round 4: the custom strip
			std::chrono::steady_clock::time_point at{};
		};
		InvCache g_inv;  // main thread only — never guarded by g_mtx

		// Resolve one tracker list's forms to live pointers. Called only when
		// the generation moved (config edit, save load), never per tick: a
		// FAILED plugin-qualified resolve is not memoised inside ActorIdentity
		// (nulls are deliberately never remembered there), so retrying a missing
		// mod's form every tick would pay an uncached by-name scan of a
		// 4,780-mod load order 1.1 times a second.
		void ResolveList(std::vector<TrackEntry>& list)
		{
			for (auto& e : list) {
				e.resolved.clear();
				e.anyMissing = false;
				for (const auto& r : e.items) {
					auto* form = ActorIdentity::Resolve(r.formId, r.plugin);
					auto* bound = form ? form->As<RE::TESBoundObject>() : nullptr;
					if (bound)
						e.resolved.push_back(bound);
					else
						e.anyMissing = true;  // say so; never count it as 0 silently
				}
				e.questForm = nullptr;
				if (!e.quest.formId.empty()) {
					auto* qf = ActorIdentity::Resolve(e.quest.formId, e.quest.plugin);
					e.questForm = qf ? qf->As<RE::TESQuest>() : nullptr;
				}
			}
		}

		// The custom quick strip's twin of ResolveList, and it follows the same
		// generation rule for the same reason: a FAILED plugin-qualified
		// resolve is deliberately not memoised inside ActorIdentity, so
		// retrying a missing mod's form every tick would pay an uncached
		// by-name scan of a 4,780-mod load order at 1.1 Hz. Caller holds g_mtx.
		void ResolveQuick2(std::vector<Quick2Item>& list)
		{
			for (auto& q : list) {
				auto* form = ActorIdentity::Resolve(q.formId, q.plugin);
				q.resolved = form ? form->As<RE::TESBoundObject>() : nullptr;
				q.kind = KindOf(q.resolved);
			}
		}

		// One custom quick row, frozen for THIS tick — same copies-not-locks
		// discipline as TrackSnap below.
		struct Quick2Snap
		{
			std::string         plugin, formId, name, kind, hk;
			RE::TESBoundObject* ptr = nullptr;
		};

		// Caller holds g_mtx. Only the rows the widget DRAWS are snapshotted:
		// `max` is what the player asked to see, the rest stay stored so that
		// shrinking the strip hides rows instead of eating them.
		void SnapshotQuick2Locked(const std::vector<Quick2Item>& list, int max,
			std::vector<Quick2Snap>& out)
		{
			out.clear();
			const int n = std::clamp(max, 1, kMaxQuick2Items);
			for (const auto& q : list) {
				if (static_cast<int>(out.size()) >= n)
					break;
				Quick2Snap s;
				s.plugin = q.plugin;
				s.formId = q.formId;
				s.kind = q.kind ? q.kind : "misc";
				s.ptr = q.resolved;
				// The LIVE name wins — a renaming mod or a translation must not
				// be overruled by whatever the picker wrote down months ago.
				if (q.resolved) {
					if (const char* nm = q.resolved->GetName(); nm && *nm)
						s.name = nm;
				}
				if (s.name.empty())
					s.name = !q.name.empty() ? q.name : std::string("Item");
				s.hk = q.keyLabel;
				out.push_back(std::move(s));
			}
		}

		// One tracker row, frozen for THIS tick. The live build runs entirely
		// outside the config lock, so it works on copies: before 2026-08-17 the
		// inventory walk was lock-free (LiveJson copied `cats` and let go), and
		// folding the trackers in must not quietly start holding g_mtx across a
		// GetInventory — wgSave arrives on the view's thread and would block on
		// it.
		struct TrackSnap
		{
			std::string                      id, label, icon;
			int                              goal = 0;
			bool                             missing = true;
			RE::TESQuest*                    quest = nullptr;
			std::vector<RE::TESBoundObject*> ptrs;   // only filled on a rebuild
		};

		// Caller holds g_mtx. DISABLED entries are dropped here, which is also
		// what makes the count cache index-parallel to the snapshot: the enabled
		// set can only change through a config edit, and every config edit bumps
		// g_resolveGen, which forces a recount. EnsureInv size-checks anyway.
		// The pointers are copied EVERY time, not just on a rebuild: an entry
		// list is at most 16 rows of (usually) one pointer, and the version that
		// skipped the copy when the cache looked fresh had a real footgun in it
		// — EnsureInv can decide it is stale on its own (the size check), and it
		// would then have counted an empty pointer list as "you own none".
		void SnapshotLocked(const std::vector<TrackEntry>& list, std::vector<TrackSnap>& out)
		{
			out.clear();
			out.reserve(list.size());
			for (const auto& e : list) {
				if (!e.enabled)
					continue;
				TrackSnap s;
				s.id = e.id;
				s.label = e.label;
				s.icon = e.icon;
				s.goal = e.goal;
				s.missing = e.anyMissing;
				s.quest = e.questForm;
				s.ptrs = e.resolved;
				out.push_back(std::move(s));
			}
		}

		// THE walk. Fills g_inv (potion pools + every tracker count) from ONE
		// GetInventory pass. NO LOCK HELD; g_inv is main-thread-only state.
		// `stale` was decided by the caller (dirty flag / generation / the 15 s
		// safety floor) so the flag is consumed exactly once per tick.
		void EnsureInv(const PotCats& cats, bool wantPots, bool wantQuick, bool stale, int gen,
			const std::vector<TrackSnap>& pinSnap, const std::vector<TrackSnap>& setSnap,
			const std::vector<Quick2Snap>& q2Snap)
		{
			const bool needPots = wantPots &&
			                      (cats.heal || cats.magicka || cats.stamina || cats.cure ||
			                       cats.all || cats.poison || cats.food || cats.drink || cats.water);
			// The custom strip's counts ride THIS walk (the walk law) — a
			// second GetInventory pass for eight rows is exactly what 2026-08-16
			// spent a day deleting.
			const bool needTrack = !pinSnap.empty() || !setSnap.empty() || !q2Snap.empty();
			if (!needPots && !needTrack && !wantQuick) {
				// Still consume the generation: leaving g_inv.gen behind kept
				// the caller's "stale && gen moved" branch true forever, which
				// re-resolved the trackers and logged "trackers resolved" every
				// tick (1.1 Hz log spam, 2026-08-18).
				g_inv.gen = gen;
				return;  // nothing on screen wants the bag - do not open it
			}
			// Defensive: a count cache that no longer lines up with the snapshot
			// is not a cache, it is a wrong answer wearing one.
			if (g_inv.pinCounts.size() != pinSnap.size() ||
				g_inv.setCounts.size() != setSnap.size() ||
				g_inv.quick2Counts.size() != q2Snap.size())
				stale = true;
			if (!stale)
				return;

			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return;  // no save: leave the cache un-had so the next tick retries

			// One hash set for the predicate - a linear scan of up to 512 tracked
			// pointers PER inventory object would undo the whole point of this.
			std::unordered_set<RE::TESBoundObject*> tracked;
			const auto collect = [&tracked](const std::vector<TrackSnap>& snap) {
				for (const auto& s : snap)
					for (auto* p : s.ptrs)
						tracked.insert(p);
			};
			collect(pinSnap);
			collect(setSnap);
			for (const auto& q : q2Snap)
				if (q.ptr)
					tracked.insert(q.ptr);

			auto inv = player->GetInventory([&](RE::TESBoundObject& o) {
				// Quick items (round 3): the favourite flag lives on the ENTRY,
				// not the object, so the walk has to admit everything to see it.
				// Still one walk, still event-driven — the walk law holds.
				if (wantQuick)
					return true;
				if (needPots && o.Is(RE::FormType::AlchemyItem))
					return true;
				return tracked.find(&o) != tracked.end();
			});

			// ---- potion pools -------------------------------------------
			// PERF (2026-08-16): ONE inventory enumeration for the whole potion
			// block. This used to be up to SIX - Hotbar::SmartCount() walks the
			// player's inventory once per pool (heal / magicka / stamina / cure),
			// Hotbar::CountAllPotions() walks it again, and the consumable chips
			// walked it a sixth time. Every one of those calls builds a std::map
			// and heap-copies an InventoryEntryData per matching item, on the
			// GAME THREAD, ~1.1 times a second, forever. The counting rules below
			// are lifted verbatim from those functions (SmartCount = PoolMatch
			// with the highest score winning `best`; CountAllPotions = every
			// AlchemyItem that is neither food nor poison; the consumable chips =
			// ClassifyConsumable, drink including water, water counting DRINKS),
			// so the numbers are identical - only the number of walks changed.
			// 2026-08-17 goes one further: the walk itself is event-driven, so
			// the steady-state cost of the whole block is now ZERO.
			g_inv.pots = json::object();
			if (needPots) {
				struct Pool
				{
					int         total = 0;
					float       bestScore = 0.0f;
					std::string bestName;
					bool        have = false;
				};
				Pool pHeal, pMag, pSta, pCure;
				int  allPotions = 0;
				int  poison = 0, food = 0, drink = 0, water = 0;
				const bool needCons = cats.poison || cats.food || cats.drink || cats.water;

				// Built once, not once per item per pool: PoolMatch takes a
				// std::string reference and this runs inside the item loop.
				static const std::string kHeal{ "heal" }, kMag{ "magicka" },
					kSta{ "stamina" }, kCure{ "cure" };
				const auto feed = [](Pool& p, const std::string& ref, RE::AlchemyItem* alch, std::int32_t count) {
					float score = 0.0f;
					if (!Hotbar::PoolMatch(ref, alch, score))
						return;
					p.total += count;
					if (!p.have || score > p.bestScore) {
						p.have = true;
						p.bestScore = score;
						if (const char* nm = alch->GetName(); nm && *nm)
							p.bestName = nm;
						else
							p.bestName.clear();
					}
				};
				for (auto& [obj, data] : inv) {
					if (data.first <= 0)
						continue;
					auto* alch = obj ? obj->As<RE::AlchemyItem>() : nullptr;
					if (!alch)
						continue;  // a tracked non-potion rode the same walk
					if (cats.heal)    feed(pHeal, kHeal, alch, data.first);
					if (cats.magicka) feed(pMag, kMag, alch, data.first);
					if (cats.stamina) feed(pSta, kSta, alch, data.first);
					if (cats.cure)    feed(pCure, kCure, alch, data.first);
					// CountAllPotions' own rule, deliberately NOT the
					// classifier's: everything that is not food and not poison.
					if (cats.all && !alch->IsFood() && !alch->IsPoison())
						allPotions += data.first;
					if (needCons) {
						using CK = Hotbar::ConsumableKind;
						switch (Hotbar::ClassifyConsumable(alch)) {
						case CK::kPoison: poison += data.first; break;
						case CK::kFood:   food += data.first; break;
						case CK::kDrink:  drink += data.first; break;
						case CK::kWater:
							drink += data.first;
							water += data.first * Hotbar::WaterDrinks(alch);
							break;
						default: break;
						}
					}
				}
				const auto poolJson = [](const Pool& p) {
					json e{ { "n", p.total } };
					if (!p.bestName.empty())
						e["best"] = p.bestName;
					return e;
				};
				if (cats.heal)    g_inv.pots["heal"] = poolJson(pHeal);
				if (cats.magicka) g_inv.pots["magicka"] = poolJson(pMag);
				if (cats.stamina) g_inv.pots["stamina"] = poolJson(pSta);
				if (cats.cure)    g_inv.pots["cure"] = poolJson(pCure);
				if (cats.all)     g_inv.pots["all"] = allPotions;
				// Consumable chips (poison / food / drink / water). drink counts
				// BOTTLES and includes water (the Drink category includes water
				// everywhere); water counts DRINKS (a full waterskin is three).
				if (cats.poison) g_inv.pots["poison"] = json{ { "n", poison } };
				if (cats.food)   g_inv.pots["food"] = json{ { "n", food } };
				if (cats.drink)  g_inv.pots["drink"] = json{ { "n", drink } };
				if (cats.water)  g_inv.pots["water"] = json{ { "n", water } };
			}

			// ---- quick items (round 3): everything FAVOURITED -------------
			// The game's own quick items — the favourites star in inventory.
			// No picker UI to build or maintain: the player already curates
			// this list with the game's own flow, and the widget just shows it
			// with live counts. Hotkeyed entries sort first (their digit rides
			// as `hk`), then by name; capped so a favourites hoarder cannot
			// grow an overlay across the screen.
			g_inv.quick = json::array();
			if (wantQuick) {
				constexpr int kMaxQuick = 12;
				std::vector<std::pair<std::string, json>> rows;
				for (auto& [obj, data] : inv) {
					if (!obj || data.first <= 0)
						continue;
					auto* entry = data.second.get();
					if (!entry || !entry->IsFavorited())
						continue;
					const char* nm = obj->GetName();
					if (!nm || !*nm)
						continue;
					json row{ { "name", nm }, { "count", data.first },
						{ "kind", KindOf(obj) } };
					PutItemIdentity(row, obj);
					row["id"] = row.value("plugin", std::string("?")) + "|" +
					            row.value("formId", std::string("?"));
					// The vanilla hotkey digit, when this favourite carries one.
					// Read as the raw underlying byte so kUnbound (0xFF) can
					// never masquerade as a slot.
					int hkSlot = -1;
					if (entry->extraLists) {
						for (auto* xl : *entry->extraLists) {
							if (!xl)
								continue;
							if (auto* xh = xl->GetByType<RE::ExtraHotkey>()) {
								const auto raw = static_cast<std::uint8_t>(xh->hotkey.get());
								if (raw <= 7)
									hkSlot = static_cast<int>(raw);
								break;
							}
						}
					}
					if (hkSlot >= 0)
						row["hk"] = hkSlot + 1;   // the digit the player pressed
					// Sort key: hotkeyed first (by slot), then case-folded name.
					std::string key = hkSlot >= 0 ? ("0" + std::to_string(hkSlot)) : "1";
					for (const char* c = nm; *c; ++c)
						key.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
					rows.emplace_back(std::move(key), std::move(row));
				}
				std::sort(rows.begin(), rows.end(),
					[](const auto& a, const auto& b) { return a.first < b.first; });
				int n = 0;
				for (auto& r : rows) {
					if (n++ >= kMaxQuick)
						break;
					g_inv.quick.push_back(std::move(r.second));
				}
				static bool s_quickLogged = false;
				if (!s_quickLogged && !g_inv.quick.empty()) {
					s_quickLogged = true;
					logger::info("widgets: quick items live ({} favourite(s))",
						g_inv.quick.size());
				}
			}

			// ---- tracker counts -----------------------------------------
			// The inventory result is already a map keyed by the bound object, so
			// a tracked form's count is a lookup, not a second scan. Counts SUM
			// across an entry's forms, which is what lets one shape serve both
			// trackers: 24 Stones of Barenziah are ONE form with count 18, and 12
			// dragon claws are twelve forms with count 1 each.
			const auto countInto = [&inv](const std::vector<TrackSnap>& snap,
				std::vector<int>& out) {
				out.assign(snap.size(), 0);
				for (std::size_t i = 0; i < snap.size(); ++i) {
					int n = 0;
					for (auto* p : snap[i].ptrs) {
						auto it = inv.find(p);
						if (it != inv.end() && it->second.first > 0)
							n += it->second.first;
					}
					out[i] = n;
				}
			};
			countInto(pinSnap, g_inv.pinCounts);
			countInto(setSnap, g_inv.setCounts);

			// The custom strip: ONE form per row, so a lookup rather than the
			// tracker's sum. An unresolved row stays 0 and carries `missing`
			// into the live payload, which is what stops it reading as "you
			// spent them all".
			g_inv.quick2Counts.assign(q2Snap.size(), 0);
			for (std::size_t i = 0; i < q2Snap.size(); ++i) {
				if (!q2Snap[i].ptr)
					continue;
				auto it = inv.find(q2Snap[i].ptr);
				if (it != inv.end() && it->second.first > 0)
					g_inv.quick2Counts[i] = it->second.first;
			}

			g_inv.have = true;
			g_inv.gen = gen;
			g_inv.at = std::chrono::steady_clock::now();
		}

		// One tracker list as live rows. No lock: everything comes from the
		// snapshot and the count cache.
		json TrackLive(const std::vector<TrackSnap>& snap, const std::vector<int>& counts,
			bool isSet)
		{
			json arr = json::array();
			for (std::size_t i = 0; i < snap.size(); ++i) {
				const auto& s = snap[i];
				const int   n = i < counts.size() ? counts[i] : 0;
				json row{ { "id", s.id }, { "label", s.label }, { "icon", s.icon },
					{ "n", n },
					// A form whose plugin is off resolves to nothing. Saying so
					// is the point: a silent 0 reads as "you spent them all".
					{ "missing", s.missing } };
				if (isSet) {
					row["goal"] = s.goal;
					row["done"] = s.goal > 0 && n >= s.goal;
					// Quest-aware hiding is the VIEW's call - C++ only reports
					// the fact, and it reports it EVERY tick rather than from the
					// count cache, because a quest completes without anything
					// moving in your bag. A finished "No Stone Unturned" is
					// exactly when the stones leave you, so a count-only rule
					// would show 0/24 forever.
					row["questDone"] = s.quest != nullptr && s.quest->IsCompleted();
				}
				arr.push_back(std::move(row));
			}
			return arr;
		}

		// The custom strip as live rows. No lock: everything comes from the
		// snapshot and the count cache, exactly like TrackLive above.
		json Quick2Live(const std::vector<Quick2Snap>& snap, const std::vector<int>& counts)
		{
			json arr = json::array();
			for (std::size_t i = 0; i < snap.size(); ++i) {
				const auto& s = snap[i];
				json row{ { "id", s.plugin + "|" + s.formId },
					{ "name", s.name }, { "kind", s.kind },
					{ "count", i < counts.size() ? counts[i] : 0 },
					{ "formId", s.formId }, { "plugin", s.plugin },
					// A form whose plugin is off resolves to nothing. Saying so
					// is the point: a silent 0 reads as "you ran out".
					{ "missing", s.ptr == nullptr } };
				if (!s.hk.empty())
					row["hk"] = s.hk;
				arr.push_back(std::move(row));
			}
			return arr;
		}

		// ---- the loot lamp's reader (see SetLootStateProvider) -------------
		// A plain function pointer, not a std::function: it is installed once
		// at startup from a capture-less lambda and read from the live tick, so
		// there is nothing to own and nothing to race on beyond the pointer
		// itself.
		std::atomic<LootStateFn> g_lootState{ nullptr };
	}

	void SetLootStateProvider(LootStateFn fn)
	{
		g_lootState = fn;
		// Build marker (hd-markers.json: "widgets-loot-provider").
		logger::info("widgets: loot state provider {}", fn ? "installed" : "cleared");
	}

	void Load()
	{
		std::lock_guard l(g_mtx);
		if (g_loaded)
			return;
		g_loaded = true;
		std::ifstream in(SidecarPath(), std::ios::binary);
		if (in) {
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object()) {
					g_extra = j;  // unknown keys survive: writes overlay onto this
					ConfigFromLocked(j);
				}
			} catch (...) {
				logger::warn("widgets: sidecar unreadable - defaults kept");
			}
		}
		RecountAnyLocked();
		// Build marker (hd-markers.json: "widgets: config loaded").
		logger::info("widgets: config loaded (master {}, potions {}, gold {}, lockpicks {})",
			g_cfg.enabled, g_cfg.potions.enabled, g_cfg.gold.enabled, g_cfg.lockpicks.enabled);
		// Build marker (hd-markers.json: "widgets: context config").
		logger::info("widgets: context config (weather {}, place {}, clock {}, mount {}/{}, {} pin(s), {} set(s))",
			g_cfg.weather.enabled, g_cfg.place.enabled, g_cfg.clock.enabled,
			g_cfg.mount.enabled, g_cfg.mountFollow, g_cfg.pinList.size(), g_cfg.setList.size());
	}

	void InstallSink()
	{
		// The pinned/set counts and the potion pools all come out of ONE
		// inventory walk (EnsureInv), and this is what stops that walk
		// running on a clock: the sink marks the cache dirty, the next live tick
		// rebuilds, and a player who is not picking things up pays nothing.
		if (auto* holder = RE::ScriptEventSourceHolder::GetSingleton()) {
			holder->AddEventSink<RE::TESContainerChangedEvent>(ContainerSink::GetSingleton());
			// Build marker (hd-markers.json: "widgets: inventory sink").
			logger::info("widgets: inventory sink armed (counts refresh on pickup, not on a clock)");
		} else {
			// Honest degradation: the 15 s safety resync in EnsureInv
			// still repairs every count, just later.
			logger::error("widgets: no ScriptEventSourceHolder - counts fall back to the 15 s resync");
		}
	}

	void OnPostLoadGame()
	{
		// Everything cached here describes the OUTGOING save: a light plugin's
		// runtime FormIDs move with the load order (actor_identity.h's Elana
		// lesson), the mount handle points at another session's actor, and the
		// place cache holds a cell id that may now be somebody else's.
		g_resolveGen.fetch_add(1);
		g_invDirty = true;
		g_lastMount = RE::ActorHandle();
		g_mountImgFor = 0;
		g_mountSaid = 0;
		g_mountImg.clear();
		g_place = PlaceCache{};
		g_inv.have = false;
		// Round 2: the shout denominator belonged to the outgoing save's last
		// shout, and the combat window to its last fight. Keeping either would
		// draw a full cooldown bar, or a stale ally strip, on a save where
		// neither ever happened. The SunHelm globals are NOT reset — a TESGlobal
		// pointer is a form and survives a load like every other form.
		g_shoutScale = 0.0f;
		g_combatSeen = {};
		// The season latch described the OUTGOING save — a different save can
		// be in a different month, and the mod re-evaluates across the load
		// screen anyway. Drop the answer (not the api verdict: whether
		// SeasonsOfSkyrim exists is a property of the load order, not the save)
		// and let the next tick re-ask immediately.
		g_season.store(-1);
		g_seasonOvr.store(-1);
		g_seasonFlight = false;
		g_seasonAsked.store(0);
	}

	void Save()
	{
		std::lock_guard l(g_mtx);
		SaveLocked();
	}

	bool ToggleAll()
	{
		bool now;
		{
			std::lock_guard l(g_mtx);
			g_cfg.enabled = !g_cfg.enabled;
			now = g_cfg.enabled;
			RecountAnyLocked();
			SaveLocked();
		}
		// A widget that was dark for an hour must show TRUE counts on its first
		// frame, not whatever the cache last saw.
		g_invDirty = true;
		// Says WHICH master, out loud: this one is the readout stack's, and it
		// deliberately no longer speaks for the free widgets (widgets-vis-split).
		logger::info("widgets: master toggled {} (readout stack only; free widgets keep their own switches)",
			now ? "ON" : "OFF");
		return now;
	}

	bool ToggleOne(const std::string& id)
	{
		bool now = false;
		{
			std::lock_guard l(g_mtx);
			Widget* w = id == "handR" ? &g_cfg.handR :
			            id == "handL" ? &g_cfg.handL :
			            id == "voice" ? &g_cfg.voice :
			            id == "quick" ? &g_cfg.quick :
			            id == "ward" ? &g_cfg.ward :
			            id == "season" ? &g_cfg.season :
			            id == "quick2" ? &g_cfg.quick2 :
			            id == "lootStatus" ? &g_cfg.lootStatus :
			            id == "vitals" ? &g_cfg.vitals :
			            id == "effects" ? &g_cfg.effects :
			            id == "equip" ? &g_cfg.equip :
			            id == "resist" ? &g_cfg.resist :
			            id == "survival" ? &g_cfg.survival :
			            id == "allies" ? &g_cfg.allies :
			            id == "potions" ? &g_cfg.potions :
			            id == "gold" ? &g_cfg.gold :
			            id == "lockpicks" ? &g_cfg.lockpicks :
			            id == "carry" ? &g_cfg.carry :
			            id == "weather" ? &g_cfg.weather :
			            id == "place" ? &g_cfg.place :
			            id == "clock" ? &g_cfg.clock :
			            id == "mount" ? &g_cfg.mount :
			            id == "pins" ? &g_cfg.pins :
			            id == "sets" ? &g_cfg.sets : nullptr;
			if (!w) {
				logger::warn("widgets: toggle refused (unknown widget '{}')", id);
				return false;
			}
			w->enabled = !w->enabled;
			now = w->enabled;
			// Turning a widget on also arms the master — a toggle that leaves
			// the feature dark reads as broken (the ArmForEdit rule).
			if (now)
				g_cfg.enabled = true;
			RecountAnyLocked();
			SaveLocked();
		}
		// A quick/pins flip changes what the walk must collect.
		g_resolveGen.fetch_add(1);
		g_invDirty = true;
		logger::info("widgets: toggle '{}' -> {}", id, now ? "ON" : "OFF");
		return now;
	}

	void ArmForEdit()
	{
		std::lock_guard l(g_mtx);
		g_cfg.enabled = true;
		// "Every widget is off" now means EVERY widget, not the first three.
		// The old test predated carry and the six context readouts, so someone
		// running only the clock got all three original widgets forced back on
		// the moment they opened the editor.
		const bool anyOn = g_cfg.potions.enabled || g_cfg.gold.enabled ||
		                   g_cfg.lockpicks.enabled || g_cfg.carry.enabled ||
		                   g_cfg.weather.enabled || g_cfg.place.enabled ||
		                   g_cfg.clock.enabled || g_cfg.mount.enabled ||
		                   g_cfg.pins.enabled || g_cfg.sets.enabled;
		if (!anyOn) {
			g_cfg.potions.enabled = true;
			g_cfg.gold.enabled = true;
			g_cfg.lockpicks.enabled = true;
		}
		RecountAnyLocked();
		SaveLocked();
		g_invDirty = true;
	}

	bool AnyEnabled()
	{
		return g_any.load();
	}

	// The two halves, for a caller that must speak about ONE system. Same
	// atomic-snapshot contract as AnyEnabled(). Marker: widgets-vis-split.
	bool StackEnabled()
	{
		return g_anyStack.load();
	}

	bool FreeWidgetsEnabled()
	{
		return g_anyFree.load();
	}

	std::string ConfigJson()
	{
		std::lock_guard l(g_mtx);
		return Dump(ConfigJsonLocked());
	}

	std::string TimeDialJson()
	{
		std::lock_guard l(g_mtx);
		return Dump(WidgetJson(g_cfg.timeDial));
	}

	void ApplyViewConfig(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::error("wgSave: rejected invalid payload");
			return;
		}
		std::lock_guard l(g_mtx);
		ConfigFromLocked(j);
		SaveLocked();
		// The edit may have added a pin, changed a potion category or turned a
		// widget on — every one of those makes the cached walk wrong. Bumping
		// the generation ALSO forces the tracker forms to re-resolve, which is
		// the only thing that makes a just-added pin count on the next tick.
		g_resolveGen.fetch_add(1);
		g_invDirty = true;
	}

	namespace
	{
		// The ward widget's live row (2026-09-01). Emitted whenever the player
		// KNOWS a ward or one is up right now — "ward down" is the message half
		// the widget exists for, so a known-but-inactive ward still reports.
		// Omitted only when there is truly nothing to say (no ward known, none
		// active). `on` reads the engine's WardPower actor value, so a ward
		// cast BY HAND lights the widget exactly like the maintained one.
		// Quantised per the diff-gate law: power to whole points (it only moves
		// during the cast ramp), everything else discrete.
		json WardJson()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player)
				return json();
			auto* avo = player->AsActorValueOwner();
			const int power = avo
				? static_cast<int>(std::lround(avo->GetActorValue(RE::ActorValue::kWardPower)))
				: 0;
			auto* best = WardActions::BestKnownWard(player);
			if (!best && power <= 0)
				return json();
			json w{ { "on", power > 0 }, { "maint", WardActions::Enabled() } };
			if (power > 0)
				w["power"] = power;
			if (best) {
				const char* n = best->GetFullName();
				w["name"] = (n && *n) ? n : "Ward";
				PutItemIdentity(w, best);
				PutSpellIconMeta(w, best);
			} else {
				w["name"] = "Ward";
			}
			// One line the first time the row is built, so a live log proves
			// the path (hd-markers.json: "widgets: ward live").
			static bool s_wd = false;
			if (!s_wd) {
				s_wd = true;
				logger::info("widgets: ward live (power {}, maintained {})",
					power, WardActions::Enabled());
			}
			return w;
		}
	}

	// Public: classify any location the way the HUD's place readout does.
	// MAIN THREAD (keyword lookup + HasKeyword). Marker: widgets-loc-kind.
	std::string PlaceKindOf(RE::BGSLocation* loc, bool interior)
	{
		return KindOfLocation(loc, interior);
	}

	std::string LiveJson()
	{
		// One-time marker so the tick path is provably reached in a live log
		// without spamming it at 1.1 Hz (hd-markers.json: "widgets: live").
		static bool s_logged = false;
		if (!s_logged) {
			s_logged = true;
			logger::info("widgets: live tick running");
		}

		// ⛔ NO SAVE, NO NUMBERS. On the main menu and during a load the player
		// singleton exists but has no world around it, and every reader below
		// answers with its zero — which is how "0 gold, 0 / 300 carry, 8:00 AM"
		// came to be painted over a loading screen (Rober, 2026-08-17). An empty
		// document makes the view draw nothing at all, which is the honest
		// picture; the menu gate (WgApplyHudVisibility) hides the plate as well,
		// and the two are deliberately independent so neither alone can fail.
		if (auto* pc = RE::PlayerCharacter::GetSingleton(); !pc || !pc->GetParentCell())
			return "{}";

		// Is the cached inventory answer still good? Decided BEFORE the lock —
		// it reads only atomics and this thread's own cache — so the dirty flag
		// is consumed exactly once per tick whatever happens below.
		const int  gen = g_resolveGen.load();
		bool       stale = !g_inv.have || g_inv.gen != gen ||
		             (std::chrono::steady_clock::now() - g_inv.at) >= std::chrono::seconds(15);
		if (g_invDirty.exchange(false))
			stale = true;

		PotCats                cats;
		bool                   wantGold, wantPicks, wantPots, wantCarry;
		bool                   wantWeather, wantPlace, wantClock, wantMount;
		bool                   wantPins, wantSets;
		bool                   wantVitals, wantFx, wantEquip, wantResist, wantSurv, wantAllies;
		bool                   wantHandR, wantHandL, wantVoice, wantQuick;
		bool                   wantWard;
		bool                   wantSeason;
		bool                   wantQuick2, wantLoot;
		std::string            follow;
		std::vector<TrackSnap> pinSnap, setSnap;
		std::vector<Quick2Snap> q2Snap;
		json                   pinsJson, setsJson, quick2Json;
		{
			std::lock_guard l(g_mtx);
			cats = g_cfg.cats;
			wantGold = g_cfg.gold.enabled;
			wantPicks = g_cfg.lockpicks.enabled;
			wantPots = g_cfg.potions.enabled;
			wantCarry = g_cfg.carry.enabled;
			wantWeather = g_cfg.weather.enabled || HudFlag("weatherOnly");
			wantPlace = g_cfg.place.enabled;
			wantClock = g_cfg.clock.enabled || HudFlag("calendar") || HudFlag("weatherOnly");
			wantMount = g_cfg.mount.enabled;
			follow = g_cfg.mountFollow;
			wantPins = g_cfg.pins.enabled && !g_cfg.pinList.empty();
			wantSets = g_cfg.sets.enabled && !g_cfg.setList.empty();
			wantVitals = g_cfg.vitals.enabled;
			wantFx = g_cfg.effects.enabled;
			wantEquip = g_cfg.equip.enabled;
			wantResist = g_cfg.resist.enabled;
			wantSurv = g_cfg.survival.enabled;
			wantAllies = g_cfg.allies.enabled;
			wantHandR = g_cfg.handR.enabled;
			wantHandL = g_cfg.handL.enabled;
			wantVoice = g_cfg.voice.enabled;
			wantQuick = g_cfg.quick.enabled;
			wantWard = g_cfg.ward.enabled;
			wantSeason = g_cfg.season.enabled || (HudFlag("calendar") && HudFlag("calendarSeason", true));
			wantQuick2 = g_cfg.quick2.enabled && !g_cfg.quick2Items.empty();
			wantLoot = g_cfg.lootStatus.enabled;
			// Re-resolve the tracker forms only when the generation moved (a
			// config edit or a save load) — never per tick: a FAILED
			// plugin-qualified resolve is deliberately not memoised inside
			// ActorIdentity, so retrying a missing mod's form every tick would
			// pay an uncached by-name scan of a 4,780-mod load order at 1.1 Hz.
			if (stale && g_inv.gen != gen) {
				ResolveList(g_cfg.pinList);
				ResolveList(g_cfg.setList);
				ResolveQuick2(g_cfg.quick2Items);
				// Build marker (hd-markers.json: "widgets: trackers resolved").
				logger::info("widgets: trackers resolved ({} pin(s), {} set(s))",
					g_cfg.pinList.size(), g_cfg.setList.size());
			}
			if (wantPins)
				SnapshotLocked(g_cfg.pinList, pinSnap);
			if (wantSets)
				SnapshotLocked(g_cfg.setList, setSnap);
			if (wantQuick2)
				SnapshotQuick2Locked(g_cfg.quick2Items, g_cfg.quick2Max, q2Snap);
		}
		// LOCK RELEASED. Everything below works on copies, so the inventory walk
		// never blocks a wgSave arriving on the view's thread.
		EnsureInv(cats, wantPots, wantQuick, stale, gen, pinSnap, setSnap, q2Snap);
		if (wantPins)
			pinsJson = TrackLive(pinSnap, g_inv.pinCounts, false);
		if (wantSets)
			setsJson = TrackLive(setSnap, g_inv.setCounts, true);
		if (wantQuick2)
			quick2Json = Quick2Live(q2Snap, g_inv.quick2Counts);

		json out = json::object();
		if (wantGold)
			out["gold"] = Finance::GetGold();  // -1 sentinel travels; the view shows "?"
		if (wantPicks)
			out["lockpicks"] = ReadLockpicks();
		if (wantCarry) {
			float cur = 0.0f, max = 0.0f;
			if (ReadCarry(cur, max))
				out["carry"] = json{ { "cur", static_cast<int>(std::lround(cur)) },
				                     { "max", static_cast<int>(std::lround(max)) } };
			else
				out["carry"] = json{ { "cur", -1 }, { "max", -1 } };  // view shows "?"
		}
		if (wantPots) {
			// Straight out of the cache (see EnsureInv) — the walk that filled
			// it ran only if something moved in the bag.
			out["potions"] = g_inv.pots;
			// The view hides the Water chip honestly when no water mod is in
			// the load order (name-matched waters still show under Drink).
			out["waterOk"] = Hotbar::WaterModPresent();
		}

		// ---- the 2026-08-17 context widgets ----------------------------------
		// Every one of these OMITS its key when it has nothing true to say. An
		// absent key means "draw nothing"; it never means zero.
		if (wantWeather) {
			if (auto* player = RE::PlayerCharacter::GetSingleton())
				if (auto* cell = player->GetParentCell()) out["interior"] = cell->IsInteriorCell();
			auto* sky = RE::Sky::GetSingleton();
			// currentWeather only, deliberately. RE::Sky also carries lastWeather
			// (the outgoing sky mid-transition) and that would be the marginally
			// better fallback — but nothing in this codebase has ever compiled
			// against that member, and this module cannot be built here. It is
			// the one honest follow-up for whoever next has a compiler.
			auto* w = sky ? sky->currentWeather : nullptr;
			if (w) {
				json wj{ { "kind", WeatherKindOf(w) } };
				// The editor id is the only human handle a weather record has (it
				// carries no FULL name) — useless as a label, invaluable when a
				// weather mod's sky picks the wrong icon and someone has to say
				// WHICH sky it was.
				if (const char* e = w->GetFormEditorID(); e && *e)
					wj["edid"] = e;
				out["weather"] = std::move(wj);
			}
		}
		if (wantPlace) {
			json p = PlaceJson();
			if (p.is_object())
				out["place"] = std::move(p);
		}
		if (wantClock) {
			json t = TimeJson();
			if (t.is_object())
				out["time"] = std::move(t);
		}
		if (wantMount) {
			json m = MountJson(follow);
			if (m.is_object())
				out["mount"] = std::move(m);
		}
		if (wantSeason) {
			// Cheap by construction: a latch read plus, at most once every
			// kSeasonPollMs, one fire-and-forget VM dispatch. Nothing here
			// waits on the VM, so a busy Papyrus frame cannot stall a tick.
			json s = SeasonJson();
			if (s.is_object())
				out["season"] = std::move(s);
		}
		if (wantPins && pinsJson.is_array() && !pinsJson.empty())
			out["pins"] = std::move(pinsJson);
		if (wantSets && setsJson.is_array() && !setsJson.empty())
			out["sets"] = std::move(setsJson);

		// ---- round 2: the player's own state ---------------------------------
		// Same omit-or-tell rule as the context half: a builder that has nothing
		// true to say returns null and its key never appears. The view treats an
		// absent key as "draw nothing" — never as zero.
		if (wantVitals) {
			json v = VitalsJson();
			if (v.is_object())
				out["vitals"] = std::move(v);
		}
		if (wantFx) {
			json f = EffectsJson();
			if (f.is_array() && !f.empty())
				out["effects"] = std::move(f);
		}
		// Round 3: the free slot widgets feed off the SAME equip rows the
		// stacked block reads — one builder, so the two surfaces can never
		// disagree about what is in your hands.
		if (wantEquip || wantHandR || wantHandL || wantVoice) {
			json e = EquipJson();
			if (e.is_array() && !e.empty())
				out["equip"] = std::move(e);
		}
		if (wantQuick && g_inv.quick.is_array() && !g_inv.quick.empty())
			out["quick"] = g_inv.quick;
		if (wantWard) {
			json wd = WardJson();
			if (wd.is_object())
				out["ward"] = std::move(wd);
		}
		// Round 4: the player's OWN strip. Emitted even when every row is
		// missing — "your mod is off" is the useful sentence, and the rows
		// carry `missing` to say it.
		if (wantQuick2 && quick2Json.is_array() && !quick2Json.empty()) {
			out["quick2"] = std::move(quick2Json);
			static bool s_q2 = false;
			if (!s_q2) {
				s_q2 = true;
				// Build marker (hd-markers.json: "widgets-quick2-live").
				logger::info("widgets: custom quick items live ({} row(s) drawn)",
					out["quick2"].size());
			}
		}
		if (wantLoot) {
			// The two masters belong to OTHER modules; main.cpp installs the
			// reader. No provider (an older main, a partial build) = no key,
			// which draws nothing rather than two lamps stuck at off.
			if (const LootStateFn fn = g_lootState.load()) {
				bool glow = false, autoLoot = false;
				fn(glow, autoLoot);
				out["lootstate"] = json{ { "glow", glow }, { "auto", autoLoot } };
			}
		}
		if (wantResist) {
			json r = ResistJson();
			if (r.is_object())
				out["resist"] = std::move(r);
		}
		if (wantSurv) {
			json s = SurvivalJson();
			if (s.is_object())
				out["survival"] = std::move(s);
		}
		if (wantAllies) {
			json a = AlliesJson();
			if (a.is_array() && !a.empty())
				out["allies"] = std::move(a);
		}
		// One line the first time the round-2 half produces anything, so a live
		// log proves the path without spamming it at 1.1 Hz (hd-markers.json:
		// "widgets: player state").
		static bool s_ps = false;
		if (!s_ps && (out.contains("vitals") || out.contains("effects") ||
				out.contains("equip") || out.contains("resist") ||
				out.contains("survival") || out.contains("allies"))) {
			s_ps = true;
			logger::info("widgets: player state live (vitals {}, effects {}, equip {}, "
			             "resist {}, survival {}, allies {})",
				out.contains("vitals"), out.contains("effects"), out.contains("equip"),
				out.contains("resist"), out.contains("survival"), out.contains("allies"));
		}

		// One line the first time the context half produces anything, so a live
		// log proves the path without spamming it (hd-markers.json: "widgets:
		// context").
		static bool s_ctx = false;
		if (!s_ctx && (out.contains("weather") || out.contains("place") ||
				out.contains("time") || out.contains("mount"))) {
			s_ctx = true;
			logger::info("widgets: context readouts live (weather {}, place {}, clock {}, mount {})",
				out.contains("weather"), out.contains("place"), out.contains("time"),
				out.contains("mount"));
		}
		return Dump(out);
	}

	std::string PbListJson()
	{
		json rows = json::array();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player) {
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::AlchemyItem);
			});
			for (auto& [obj, data] : inv) {
				if (data.first <= 0)
					continue;
				auto* alch = obj ? obj->As<RE::AlchemyItem>() : nullptr;
				if (!alch)
					continue;
				// EVERY consumable rides the list now (2026-08-15) — poisons,
				// food, drinks and water included; the row's `cat` names which
				// pill owns it and the view picks the honest verb per cat.
				float strength = 0.0f;
				const std::string cat = CatOf(alch, strength);

				json row;
				auto* file = alch->GetFile(0);
				if (file) {
					// File-width mask, exactly as GetLocalFormID would if it
					// null-checked (the actor_identity lesson). Resolve back
					// via LookupForm(local, plugin), never the raw runtime id.
					const std::uint32_t local =
						alch->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
					char buf[16];
					std::snprintf(buf, sizeof(buf), "0x%06X", local);
					row["plugin"] = std::string(file->GetFilename());
					row["formId"] = std::string(buf);
				} else {
					// Dynamic (0xFF…) — no durable identity; the raw runtime
					// id below is the only handle pbUse can use.
					row["plugin"] = "";
					row["formId"] = "0x0";
				}
				row["rt"] = alch->GetFormID();
				const char* nm = alch->GetName();
				row["name"] = (nm && *nm) ? nm : "Potion";
				row["count"] = data.first;
				row["value"] = alch->GetGoldValue();
				row["strength"] = static_cast<double>(static_cast<int>(strength * 10)) / 10.0;
				row["cat"] = cat;
				row["fx"] = FxSummary(alch);
				if (cat == "water")
					row["drinks"] = Hotbar::WaterDrinks(alch);  // per bottle
				rows.push_back(std::move(row));
			}
		}
		json prefs, ai, combos, smart;
		{
			std::lock_guard l(g_mtx);
			prefs = g_cfg.browser.is_object() ? g_cfg.browser : json::object();
			ai = AiJson(g_cfg.ai);
			smart = SmartJson(g_cfg.smart);
			combos = CombosJsonLocked(g_cfg.combos);
		}
		// The smart row (2026-09-23): each pool's gap and the bottle the smart
		// rules would pick for it right now - the same preview the press uses.
		json pools = json::object();
		for (const char* ref : { "heal", "magicka", "stamina" }) {
			const auto pv = Hotbar::PreviewSmart(ref);
			pools[ref] = json{ { "cur", static_cast<int>(pv.cur + 0.5f) }, { "max", static_cast<int>(pv.max + 0.5f) },
				{ "gap", static_cast<int>(pv.deficit + 0.5f) }, { "ok", pv.ok }, { "full", pv.full },
				{ "name", pv.name }, { "restores", static_cast<int>(pv.score + 0.5f) },
				{ "overheal", pv.overheal }, { "total", pv.total }, { "why", pv.why } };
		}
		// Build marker (hd-markers.json: "potion-browser: list").
		logger::info("potion-browser: list built ({} potion(s) carried)", rows.size());
		return Dump(json{ { "rows", std::move(rows) }, { "prefs", std::move(prefs) },
			{ "waterOk", Hotbar::WaterModPresent() },
			{ "ai", std::move(ai) }, { "smart", std::move(smart) },
			{ "combos", std::move(combos) }, { "pools", std::move(pools) } });
	}

	std::string PbUseJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		const auto refuse = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg } });
		};
		if (j.is_discarded() || !j.is_object())
			return refuse("Bad request");

		// The smart row (2026-09-23, Rober: "a smart button for like use best
		// potion (to heal my current health gap)"): the same picker and the
		// same drink the hotbar's smart slots and the Potion AI use. The reply
		// asks the browser to re-list: counts and the gaps both moved.
		if (j.contains("smart")) {
			const std::string ref = j.value("smart", std::string());
			if (ref != "heal" && ref != "magicka" && ref != "stamina" && ref != "cure")
				return refuse("Unknown pool");
			auto res = json::parse(Hotbar::FireSmart(ref), nullptr, false);
			if (!res.is_object())
				res = json{ { "ok", false }, { "msg", "The smart drink did not answer" } };
			res["smart"] = ref;
			res["relist"] = true;
			logger::info("potion-browser: smart '{}' -> {}", ref, res.value("ok", false) ? "drank" : "refused");  // marker: potion-browser-smart
			return Dump(res);
		}

		const std::string plugin = j.value("plugin", std::string());
		const std::string idHex = j.value("formId", std::string());
		const std::uint32_t rt = j.value("rt", 0u);

		RE::TESForm* form = nullptr;
		if (!plugin.empty()) {
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				form = dh->LookupForm(ParseHexId(idHex), plugin);
		}
		if (!form && rt)
			form = RE::TESForm::LookupByID(rt);
		auto* alch = form ? form->As<RE::AlchemyItem>() : nullptr;
		if (!alch)
			return refuse("That potion's mod is off, or the form is gone");

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return refuse("No save loaded");
		const std::int32_t have = CarriedCount(alch);
		if (have <= 0)
			return refuse("You aren't carrying any more of it");
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return refuse("The equip manager isn't up");

		std::string nm = "potion";
		if (const char* n = alch->GetName(); n && *n)
			nm = n;
		// EquipObject on an AlchemyItem IS the drink — the wheel's own verb,
		// proven from the paused palette (FireSmart takes the same road).
		eqm->EquipObject(player, alch);
		// Build marker (hd-markers.json: "potion-browser: use").
		logger::info("potion-browser: use '{}' ({} carried before the drink)", nm, have);
		return Dump(json{ { "ok", true }, { "msg", "Drank " + nm },
			{ "plugin", plugin }, { "formId", idHex },
			{ "newCount", have - 1 } });
	}

	std::string PbSaveJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		if (j.is_object()) {
			std::lock_guard l(g_mtx);
			if (!g_cfg.browser.is_object())
				g_cfg.browser = json::object();
			// The view owns the browser schema; keep whatever keys it sends
			// (sort, cat today), so a future pref needs no DLL change. The
			// `ai` key is the one exception: C++ drinks by those numbers, so
			// it is peeled off, CLAMPED into the real config and never stored
			// as an opaque blob.
			for (auto it = j.begin(); it != j.end(); ++it) {
				if (it.key() == "ai") {
					AiFrom(it.value(), g_cfg.ai);
					g_aiOn = g_cfg.ai.enabled;
					continue;
				}
				if (it.key() == "smart") {
					// Same law as `ai`: C++ DRINKS by these, so they are parsed
					// and clamped here, never stored as an opaque blob.
					SmartFrom(it.value(), g_cfg.smart);
					SmartPush();
					// Build marker (hd-markers.json: "smart-potion-prefs").
					logger::info("smart-potion-prefs: mode {}, overheal {}/{}, emergency {}%, {} excluded",
						g_cfg.smart.optimal ? "optimal" : "strongest",
						g_cfg.smart.allowOverheal ? "allowed" : "off",
						g_cfg.smart.preferOverheal ? "preferred" : "last resort",
						g_cfg.smart.emergencyPct, g_cfg.smart.exclude.size());
					continue;
				}
				g_cfg.browser[it.key()] = it.value();
			}
			SaveLocked();
		}
		return Dump(json{ { "ok", true } });
	}

	// ---- Potion AI ---------------------------------------------------------

	bool AiEnabled()
	{
		return g_aiOn.load();
	}

	bool ToggleAi()
	{
		bool now;
		{
			std::lock_guard l(g_mtx);
			g_cfg.ai.enabled = !g_cfg.ai.enabled;
			now = g_cfg.ai.enabled;
			g_aiOn = now;
			SaveLocked();
		}
		// Build marker (hd-markers.json: "potion-ai: toggled").
		logger::info("potion-ai: toggled {}", now ? "ON" : "OFF");
		return now;
	}

	void AiTick()
	{
		AiCfg ai;
		{
			std::lock_guard l(g_mtx);
			ai = g_cfg.ai;
		}
		if (!ai.enabled)
			return;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player || player->IsDead() || !player->GetParentCell())
			return;
		if (auto* ui = RE::UI::GetSingleton(); ui && ui->GameIsPaused())
			return;
		if (ai.combatOnly && !player->IsInCombat())
			return;
		auto* avo = player->AsActorValueOwner();
		if (!avo)
			return;

		// Per-stat runtime state, main-thread only: last successful drink (the
		// cooldown), and whether the "you're dry" notice already fired for the
		// CURRENT dry episode (cleared when the stat recovers, so it can never
		// spam and never stays silent forever either).
		using clock = std::chrono::steady_clock;
		static clock::time_point s_lastFire[3] = {};
		static bool              s_dryNotified[3] = {};
		const auto               now = clock::now();

		struct Probe
		{
			int            idx;
			const AiStat*  cfg;
			RE::ActorValue av;
			const char*    pool;
			const char*    label;
		};
		const Probe probes[] = {
			{ 0, &ai.health, RE::ActorValue::kHealth, "heal", "health" },
			{ 1, &ai.magicka, RE::ActorValue::kMagicka, "magicka", "magicka" },
			{ 2, &ai.stamina, RE::ActorValue::kStamina, "stamina", "stamina" },
		};

		for (const auto& p : probes) {
			if (!p.cfg->on)
				continue;
			// Percent exactly as the char sheet's Pool() computes its bars:
			// cur = GetActorValue (live), max = GetPermanentActorValue (base +
			// permanent modifiers). One formula both sides, so the AI and the
			// sheet can never disagree about "22%".
			const float mx = avo->GetPermanentActorValue(p.av);
			if (mx <= 0.0f)
				continue;
			const float cur = avo->GetActorValue(p.av);
			const int   pct = static_cast<int>((cur / mx) * 100.0f);
			if (pct >= p.cfg->pct) {
				s_dryNotified[p.idx] = false;  // recovered — re-arm the dry notice
				continue;
			}
			if (now - s_lastFire[p.idx] < std::chrono::milliseconds(ai.cooldownMs))
				continue;

			const auto res = json::parse(Hotbar::FireSmart(p.pool), nullptr, false);
			if (res.is_object() && res.value("ok", false)) {
				s_lastFire[p.idx] = now;
				std::string nm = res.value("msg", std::string());
				if (nm.rfind("Drank ", 0) == 0)
					nm = nm.substr(6);
				// Build marker (hd-markers.json: "potion-ai: drank").
				logger::info("potion-ai: drank '{}' ({} at {}%)", nm, p.label, pct);
				if (ai.notify)
					RE::DebugNotification(("Potion AI: " + nm + " (" + p.label + " " +
						std::to_string(pct) + "%)").c_str());
				return;  // ONE drink per tick — health outranks magicka outranks stamina
			}
			// Dry: say so once per dry episode (the honest refusal beats a
			// silent guardian that isn't guarding), then keep trying the next
			// stat this same tick — a dry health pool must not block a
			// magicka drink that IS possible.
			if (!s_dryNotified[p.idx]) {
				s_dryNotified[p.idx] = true;
				logger::info("potion-ai: dry — no {} potions left", p.label);
				RE::DebugNotification(("Potion AI: no " + std::string(p.label) +
					" potions left!").c_str());
			}
		}
	}

	// ---- potion combos -------------------------------------------------------

	std::string CombosJson()
	{
		std::lock_guard l(g_mtx);
		return Dump(CombosJsonLocked(g_cfg.combos));
	}

	std::string ApplyCombosJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		if (j.is_discarded() || !j.is_array())
			return Dump(json{ { "ok", false }, { "msg", "Bad combo payload" } });
		json out;
		{
			std::lock_guard l(g_mtx);
			CombosFrom(j, g_cfg.combos);
			SaveLocked();
			out = CombosJsonLocked(g_cfg.combos);
		}
		logger::info("potion-combo: saved {} combo(s)", out.size());
		return Dump(json{ { "ok", true }, { "combos", std::move(out) } });
	}

	std::string FireComboJson(const std::string& id)
	{
		Combo combo;
		bool  found = false;
		{
			std::lock_guard l(g_mtx);
			for (const auto& c : g_cfg.combos)
				if (c.id == id) {
					combo = c;
					found = true;
					break;
				}
		}
		const auto refuse = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg } });
		};
		if (!found)
			return refuse("That combo was deleted");
		if (combo.items.empty())
			return refuse("'" + combo.name + "' has no potions in it yet");
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return refuse("No save loaded");
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return refuse("The equip manager isn't up");
		auto* dh = RE::TESDataHandler::GetSingleton();

		int         drank = 0;
		std::string firstMissing;
		for (const auto& it : combo.items) {
			RE::TESForm* form = nullptr;
			if (dh && !it.plugin.empty())
				form = dh->LookupForm(ParseHexId(it.formId), it.plugin);
			auto* alch = form ? form->As<RE::AlchemyItem>() : nullptr;
			if (!alch || CarriedCount(alch) <= 0) {
				if (firstMissing.empty())
					firstMissing = !it.name.empty() ? it.name : std::string("a potion");
				continue;
			}
			// EquipObject IS the drink/eat/apply — the wheel's own verb, one
			// bottle per combo line. Potions stack instantly; nothing in this
			// codebase suggests spacing is needed (CastSequence spaces CASTS,
			// which race the magic caster — an equip does not).
			eqm->EquipObject(player, alch);
			++drank;
		}
		const int total = static_cast<int>(combo.items.size());
		// Build marker (hd-markers.json: "potion-combo: fired").
		logger::info("potion-combo: fired '{}' ({} of {} drunk)", combo.name, drank, total);
		if (drank == 0)
			return refuse("'" + combo.name + "': nothing left to drink — out of " + firstMissing);
		std::string msg = combo.name + ": drank " + std::to_string(drank) + " of " +
		                  std::to_string(total);
		if (!firstMissing.empty())
			msg += " — out of " + firstMissing;
		RE::DebugNotification(msg.c_str());
		return Dump(json{ { "ok", true }, { "msg", msg } });
	}

	// ---- custom quick items (round 4, 2026-08-18) ---------------------------

	std::string Quick2UseJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		const auto refuse = [](const std::string& msg, bool say) {
			// A key press with no UI behind it must SAY why nothing happened —
			// a button that silently does nothing is the worse bug. The view's
			// own row press gets the reply and shows it there.
			if (say)
				RE::DebugNotification(msg.c_str());
			return Dump(json{ { "ok", false }, { "msg", msg } });
		};
		if (j.is_discarded() || !j.is_object())
			return refuse("Bad request", false);

		const std::string plugin = j.value("plugin", std::string());
		const std::string idHex = j.value("formId", std::string());
		const bool        notify = j.value("notify", false);
		if (plugin.empty() || idHex.empty())
			return refuse("That item has no durable identity", notify);

		auto* dh = RE::TESDataHandler::GetSingleton();
		// ESL-safe by construction: LookupForm(local, plugin) is the only
		// resolve that survives a light plugin moving in the load order.
		auto* form = dh ? dh->LookupForm(ParseHexId(idHex), plugin) : nullptr;
		auto* obj = form ? form->As<RE::TESBoundObject>() : nullptr;
		if (!obj)
			return refuse("That item's mod is off, or the form is gone", notify);

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return refuse("No save loaded", notify);
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return refuse("The equip manager isn't up", notify);

		std::string nm = "item";
		if (const char* n = obj->GetName(); n && *n)
			nm = n;

		// What the verb may act on. EquipObject IS the drink for an
		// AlchemyItem (the wheel's own verb, proven from the paused palette),
		// and the ordinary equip for everything else here. A book is
		// deliberately NOT on the list: "equipping" one opens the reading menu
		// over whatever you were doing, which is not what a quick slot means.
		switch (obj->GetFormType()) {
		case RE::FormType::AlchemyItem:
		case RE::FormType::Weapon:
		case RE::FormType::Armor:
		case RE::FormType::Ammo:
		case RE::FormType::Scroll:
		case RE::FormType::Ingredient:
		case RE::FormType::Light:
			break;
		default:
			return refuse("'" + nm + "' isn't something the deck can use or equip", notify);
		}

		const std::int32_t have = CarriedCount(obj);
		if (have <= 0)
			return refuse("You aren't carrying any " + nm, notify);

		eqm->EquipObject(player, obj);
		// Build marker (hd-markers.json: "widgets-quick2-use").
		logger::info("widgets: quick2 used '{}' ({} carried before)", nm, have);
		const bool  consumed = obj->Is(RE::FormType::AlchemyItem);
		std::string msg = (consumed ? "Used " : "Equipped ") + nm;
		if (notify)
			RE::DebugNotification(msg.c_str());
		return Dump(json{ { "ok", true }, { "msg", std::move(msg) },
			{ "plugin", plugin }, { "formId", idHex },
			// Only a consumable is one fewer; equipping a sword does not spend
			// it, and saying it did would make the widget lie by one.
			{ "newCount", consumed ? have - 1 : have } });
	}

	std::string Quick2CatalogJson()
	{
		json rows = json::array();
		bool capped = false;
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player) {
			constexpr int kMaxCatalog = 400;
			// ON DEMAND, and deliberately NOT the live tick's cached walk: that
			// one admits only what the widgets need, and the picker has to show
			// everything the player is carrying.
			auto inv = player->GetInventory([](RE::TESBoundObject&) { return true; });
			std::vector<std::pair<std::string, json>> sorted;
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				const char* nm = obj->GetName();
				if (!nm || !*nm)
					continue;  // a nameless form is unpickable and unreadable
				json row{ { "name", nm }, { "count", data.first },
					{ "kind", KindOf(obj) } };
				PutItemIdentity(row, obj);
				// No plugin = a dynamic form; there is no identity to store in
				// the config, so it could never be fired again after a reload.
				if (!row.contains("plugin"))
					continue;
				std::string key;
				for (const char* c = nm; *c; ++c)
					key.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
				sorted.emplace_back(std::move(key), std::move(row));
			}
			std::sort(sorted.begin(), sorted.end(),
				[](const auto& a, const auto& b) { return a.first < b.first; });
			capped = static_cast<int>(sorted.size()) > kMaxCatalog;
			int n = 0;
			for (auto& r : sorted) {
				if (n++ >= kMaxCatalog)
					break;
				rows.push_back(std::move(r.second));
			}
		}
		// Build marker (hd-markers.json: "widgets-quick2-catalog").
		logger::info("widgets: quick2 catalog built ({} carried item(s){})",
			rows.size(), capped ? ", capped" : "");
		return Dump(json{ { "rows", std::move(rows) }, { "capped", capped } });
	}

	std::string Quick2ForKey(bool isKb, bool isMs, std::uint32_t idc)
	{
		if (!idc || (!isKb && !isMs))
			return {};
		std::lock_guard l(g_mtx);
		// ⛔ THE KEYS FOLLOW THE PICTURE (the hotbar's own law). A row the
		// widget is not drawing — because the master is off, the widget is off,
		// or it sits past `max` — must not fire: a key that casts from an
		// invisible strip is a trap, not a feature.
		if (!g_cfg.enabled || !g_cfg.quick2.enabled)
			return {};
		const int n = std::clamp(g_cfg.quick2Max, 1, kMaxQuick2Items);
		int       i = 0;
		for (const auto& q : g_cfg.quick2Items) {
			if (i++ >= n)
				break;
			if (q.keyCode <= 0 || static_cast<std::uint32_t>(q.keyCode) != idc)
				continue;
			if (!((isKb && q.keyDevice == "keyboard") || (isMs && q.keyDevice == "mouse")))
				continue;
			return Dump(json{ { "plugin", q.plugin }, { "formId", q.formId },
				{ "notify", true } });
		}
		return {};
	}
}
