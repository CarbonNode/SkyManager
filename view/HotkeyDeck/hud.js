'use strict';

/* ============================================================================
   SkyManager HUD — view logic for the always-on overlay.

   Two tenants share one movable assembly:
     • the follower portrait strip (2026-08-05, play-proven — untouched below)
     • the WIDGET stack (2026-08-17): quick readouts, a context-aware
       weather/place slot, pinned item tiles, a mount card, collectible sets.

   Rober, 2026-08-17, after Skyrim Party Sheet: "add some new widgets for
   weather, and cell name and time … i like the idea of being able to pin any
   item as well with a count as a widget and using mesh rendering framework.
   Mount widget would be cool too", under the standing constraint "do not
   obviously copy cody 1:1 have to stay above board. But can take all the
   inspiration and flare." The IDEAS are borrowed; the glyphs are drawn here as
   inline SVG in the deck's own gold, the layout is ours, no asset of theirs is
   referenced.

   ---------------------------------------------------------------- bridge ----
   toGame('hudReady')              — on load: "push me config + data"
   toGame('hudSave', json)         — placement {x,y,scale,orient,anchor*,showNames}
   toGame('hudWidgetSave', json)   — the widget config (falls back to 'wgSave')
   toGame('hudIcons', json)        — {items:[{formId,plugin,name}]} render request
                                     (falls back to 'whIcons', the wheel's own
                                     listener — one render route, never a second)
   toGame('hudEditDone')           — leave reposition mode (C++ then Unfocuses)
   toGame('hudLog', msg)

   C++ calls INTO us:
     window.hudConfig(json)     — {x,y,scale,orient,anchor*,visible,showNames}
     window.hudData(json)       — [{name, original, following, dead, file?, ext?,
                                    mtime?, crop?:{z,x,y}, hue?}]
     window.hudWidgets(json)    — the LIVE widget feed (shape documented at
                                  `live` below). Also accepted: a combined
                                  {config:…, live:…} envelope.
     window.hudWidgetCfg(json)  — the widget CONFIG (which blocks/lines show)
     window.hudIconsData(json)  — {icons:{"FORMID|plugin":path}, fails:{…}}
     window.hudEdit("1"|"0")    — enter / leave reposition mode

   ⚠ CONTRACT NOT YET FINAL (2026-08-17). src/widgets.cpp is being extended in
   parallel; until it publishes, every field below is read DEFENSIVELY — a
   missing key means the block is absent, never a zero, and the aliases wgConfig
   / wgLive / whIconsData are installed too so whichever name the DLL ends up
   registering lands here. Reconcile the names when its report arrives.

   ⚠ PERF LAW. This view is on screen for the whole play session. The Action Bar
   was caught rebuilding 40 elements and 7 images every tick in exactly this
   class of view (2026-08-16). So: everything stable is HASHED, the volatile
   numbers are written IN PLACE, and a full rebuild happens only on a structural
   change. Recreating an <img> whose src has not changed is the specific sin.
   And no looping animation anywhere — an animated gradient SMEARS with the
   compositor off.
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[hud->game]', fn, arg);
    }
  }
  /* Send to the FIRST name the DLL actually registered. The widget bridge is
     still being named on the C++ side; this is what keeps the view from being
     wired to a listener that does not exist yet. */
  function toGameAny(names, arg) {
    for (const n of names) if (typeof window[n] === 'function') { toGame(n, arg); return n; }
    if (DEV) console.log('[hud->game?]', names.join('/'), arg);
    return '';
  }

  /* ---- placement config, owned by C++, mirrored here ------------------- */
  const cfg = { x: 40, y: 40, scale: 1, orient: 'horiz', anchorH: 'left', anchorV: 'top', visible: true, showNames: true,
    /* Per-face extras (Party Sheet catch-up, 2026-08-17). The DLL only sends a
       row field while its toggle is on, so these mirror C++ mostly for the
       settings modal; the chips draw whatever fields actually arrive. */
    showLevel: true, showDir: true, showHp: true, showSt: false, showMk: false,
    /* Portrait shape — circle | rounded | square | diamond (Party Sheet's
       "portrait shapes"). A pure strip-level CSS class; see SHAPES. */
    faceShape: 'circle', compact: true };
  const SHAPES = ['circle', 'rounded', 'square', 'diamond'];
  let followers = [];
  let editing = false;
  /* ---- THE STRIP IS NOT PART OF WIDGET CONFIG (2026-08-19, round 3) --------
     Rober: "why does config for hud widgets turn on follower hud? That is super
     annoying — it should be separate from follower hud altogether and not toggle
     or even show it when config is pressed, only if its pressed."

     Edit mode used to be ONE mode: entering it force-showed the follower strip
     (applyVisible's `&& !editing`), dressed the panel in its dashed plate, put
     the strip's own ⠿ Move / ⇄ Flip / ⤢ Grow / Aa Names toolbar on screen and
     armed the ⚙ grip — regardless of whether the strip was on, and regardless
     of what you actually came to configure. So opening the widget shelf read as
     "config turned my follower HUD on".

     There are two scopes now. `editing` alone = the WIDGETS are being placed;
     the strip keeps its honest visibility and grows no chrome. `stripEdit` on
     top of it = the STRIP is what is being configured, and only then does it
     appear in edit dress. It is armed by exactly three deliberate acts: the
     deck's Followers-HUD "Config →" (hudCfg {op:'shelf', key:'strip'}), the
     shelf's own Follower-HUD section (its ✥ Place on screen chip, or being
     revealed on that row), and the strip's ⚙ grip — never by entering edit mode.
     It always dies with edit mode, so a session can never be stranded in it. */
  let stripEdit = false;
  /* Declared up here with the rest of the module state, NOT next to the
     wgMenus bridge that owns it: renderWidgets reads it, and a `let` still in
     its temporal dead zone when something calls that early would throw during
     load — which in Ultralight takes the whole renderer down (CLAUDE.md,
     2026-08-17). Cheap insurance against a re-order. */
  let menusOpen = false;
  /* The ⚙ settings popout's own screen position, in fixed px from the top-left
     RETIRED 2026-08-19: the card became a right-docked SHELF, which has no
     position to remember. The stored key is dropped on the next save rather
     than carried as a ghost of the window it used to be — nothing else ever
     read it. */

  const SCALE_MIN = 0.5, SCALE_MAX = 2.6;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ⛔ Ultralight law: an UNCAUGHT JS error during load takes the whole
     renderer down with an access violation — measured 2026-08-17 with
     tools/ultralight-probe (a missing #hud-vitals threw
     "null is not an object", exit 0xC0000005; the same page with an
     onerror shim that swallowed it ran clean). PrismaUI shares that
     renderer with every other view, which is the shape of the 1.8.0
     "opens once, then freezes forever" report. So this view must never be
     able to null-deref a missing element: `need()` hands back a detached
     div when the skeleton is older than the script, and the widget simply
     draws nowhere instead of killing the HUD, the deck and the hotbar. */
  function need(id) {
    return document.getElementById(id) || document.createElement('div');
  }
  const el = {
    body: document.body,
    hud: need('hud'),
    panel: need('hud-panel'),
    strip: need('hud-strip'),
    empty: need('hud-empty'),
    tools: document.querySelector('.hud-tools') || document.createElement('div'),
    hint: document.querySelector('.hud-hint') || document.createElement('div'),
    widgets: need('hud-widgets'),
    /* Retired 2026-08-18 — kept, and kept EMPTY, only so nothing can null-deref
       it. Every readout line owns its own element below. */
    readouts: need('hud-readouts'),
    roGold: need('hud-ro-gold'),
    roCarry: need('hud-ro-carry'),
    roTime: need('hud-ro-time'),
    roContext: need('hud-ro-context'),
    roPots: need('hud-ro-pots'),
    stripGrip: need('hud-strip-grip'),
    vitals: need('hud-vitals'),
    resist: need('hud-resist'),
    effects: need('hud-effects'),
    equip: need('hud-equip'),
    survival: need('hud-survival'),
    allies: need('hud-allies'),
    mount: need('hud-mount'),
    pins: need('hud-pins'),
    sets: need('hud-sets'),
    settings: need('hud-settings'),
    presets: need('hud-presets'),
    opts: need('hud-opts'),
    /* Round 4 (2026-08-18) — three popouts that must live OUTSIDE #hud, because
       #hud carries transform: scale(--hud-scale) and a transformed ancestor
       becomes the containing block for position:fixed (the ⚙ popout's lesson).
       Empty roots in the skeleton, filled by JS: the browse info card, the
       custom-quick-items picker, and the one-line toast. */
    navcard: need('hud-navcard'),
    q2pick: need('hud-q2pick'),
    toast: need('hud-toast'),
    /* Browse mode's one-line key hint (2026-08-18). Browsing takes the
       keyboard off the player, so the keys that give it back have to be ON
       SCREEN — nothing else in the game says WASD/Enter/Esc, and a mode you
       cannot see your way out of is the lock-in class this view has already
       been bitten by twice. */
    navhint: need('hud-navhint'),
  };

  /* ---- small helpers ported verbatim from followers-pane.js ------------ */
  function slugOf(name) {
    let s = String(name == null ? '' : name);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* keep */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }
  function hueOf(i) { return (i * 47) % 360; }

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else if (k in node) { try { node[k] = attrs[k]; } catch (e) { node.setAttribute(k, attrs[k]); } }
      else node.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid != null) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return node;
  }
  /* Write text only when it actually changed — an assignment to textContent is a
     DOM mutation even when the string is identical, and this runs every tick. */
  function setText(node, s) { if (node && node.textContent !== s) node.textContent = s; }
  function setStyle(node, prop, v) { if (node && node.style[prop] !== v) node.style[prop] = v; }
  function setClass(node, name, on) { if (node) node.classList.toggle(name, !!on); }

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  function num(v, fallback) { return isNum(v) ? v : (isNum(fallback) ? fallback : null); }
  /* 12480 -> "12,480". Written by hand rather than toLocaleString: Ultralight's
     ICU data is not something this view should bet a number on. */
  function comma(n) {
    const neg = n < 0; let s = String(Math.round(Math.abs(n))), out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (neg ? '-' : '') + s + out;
  }
  function pct(cur, max) {
    if (!isNum(cur) || !isNum(max) || max <= 0) return 0;
    return clamp(cur / max, 0, 1);
  }
  /* A bar width, serialised the way CSS itself will serialise it — "82%", never
     "82.0%". setStyle compares against what the DOM gives BACK, so a trailing
     zero would make every tick look like a change and write the style forever
     on a view that is never off screen. */
  function pctWidth(cur, max) { return String(+(pct(cur, max) * 100).toFixed(1)) + '%'; }

  /* ======================================================================
     ICONS — inline SVG, drawn here, in the deck's gold.
     Deliberately NOT images: an <img> rasterises at layout size in Ultralight
     and a scaled transform resamples a too-small bitmap (the hd-facefit
     lesson), and the reference mod's icon packs are separate mods that are not
     ours to ship. Vector strokes are also free of the whole render pipeline.
     ====================================================================== */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgIcon(parts, size) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 22));
    s.setAttribute('height', String(size || 22));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const p of parts) {
      if (Array.isArray(p)) {                      // ['circle', cx, cy, r]
        const c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', p[1]); c.setAttribute('cy', p[2]); c.setAttribute('r', p[3]);
        s.appendChild(c);
      } else {
        const d = document.createElementNS(SVGNS, 'path');
        d.setAttribute('d', p);
        s.appendChild(d);
      }
    }
    return s;
  }

  const CLOUD = 'M7.5 17.5h8.7a3.3 3.3 0 0 0 .3-6.6 4.8 4.8 0 0 0-9.2-1 3.4 3.4 0 0 0 .2 7.6z';
  const WEATHER_ART = {
    clear: [['circle', 12, 12, 4], 'M12 3.5v2', 'M12 18.5v2', 'M3.5 12h2', 'M18.5 12h2',
      'M6 6l1.4 1.4', 'M16.6 16.6L18 18', 'M18 6l-1.4 1.4', 'M7.4 16.6L6 18'],
    cloudy: [CLOUD, 'M14.2 7.4a4.4 4.4 0 0 1 5.6 4.2'],
    overcast: [CLOUD, 'M5 20.4h14'],
    rain: [CLOUD, 'M9 19.6l-.8 2.2', 'M13 19.6l-.8 2.2', 'M17 19.6l-.8 2.2'],
    storm: [CLOUD, 'M13 14l-4 6h4l-1 3 6-7h-5l1-2'],
    snow: [CLOUD, 'M9 20v2.2', 'M8 20.6l2 1', 'M10 20.6l-2 1',
      'M15.5 20v2.2', 'M14.5 20.6l2 1', 'M16.5 20.6l-2 1'],
    fog: ['M3.5 8h17', 'M6 12h15', 'M3.5 16h13', 'M8 20h11'],
    ash: ['M4 8.5h16', 'M6.5 12.5h13', ['circle', 8, 17, .9], ['circle', 13, 18.5, .9], ['circle', 17.5, 16.5, .9]],
  };
  /* Season glyphs (2026-08-31). The ALWAYS-present fallback under the painted
     PNGs, same contract as the weather set: a snowflake, a sprouting shoot, a
     sun, a falling leaf. Deliberately NOT re-using WEATHER_ART.snow for winter
     — a season is not a sky, and reading "it is snowing" off a widget that
     means "it is winter" is exactly the confusion worth one more glyph. */
  const SEASON_ART = {
    winter: ['M12 2.6v18.8', 'M4.3 7.1l15.4 8.8', 'M19.7 7.1L4.3 15.9',
      'M9.2 4.4L12 6.4l2.8-2', 'M9.2 19.6L12 17.6l2.8 2',
      'M4.6 11.2l.3 2.6', 'M19.4 11.2l-.3 2.6'],
    spring: ['M12 21.4v-8.6', 'M12 12.8C12 9 9.4 6.6 5.6 6.6c0 3.8 2.6 6.2 6.4 6.2z',
      'M12 12.8c0-3.4 2.4-5.6 5.8-5.6 0 3.4-2.4 5.6-5.8 5.6z', 'M6.6 21.4h10.8'],
    summer: [['circle', 12, 12, 4.6], 'M12 2.4v2.6', 'M12 19v2.6', 'M2.4 12h2.6',
      'M19 12h2.6', 'M5.2 5.2l1.9 1.9', 'M16.9 16.9l1.9 1.9',
      'M18.8 5.2l-1.9 1.9', 'M7.1 16.9l-1.9 1.9'],
    autumn: ['M12.6 20.8c0-5.4 1.6-9.4 5.6-12.4-.4 6.6-2.2 10.4-5.6 12.4z',
      'M12.6 20.8C10.4 16 7 13.4 3.2 12.8c1.6 5 4.6 7.6 9.4 8z',
      'M12.6 20.8v-3.2'],
  };
  const WEATHER_ALIAS = {
    clear: 'clear', sunny: 'clear', fair: 'clear', pleasant: 'clear',
    cloudy: 'cloudy', partly: 'cloudy', overcast: 'overcast',
    rain: 'rain', rainy: 'rain', drizzle: 'rain',
    storm: 'storm', thunder: 'storm', thunderstorm: 'storm', lightning: 'storm',
    snow: 'snow', snowy: 'snow', blizzard: 'snow',
    fog: 'fog', foggy: 'fog', mist: 'fog', misty: 'fog',
    ash: 'ash', ashfall: 'ash', ashstorm: 'ash', sandstorm: 'ash',
  };

  const PLACE_ART = {
    inn: ['M7 8.5h8.5V18a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z', 'M15.5 10.5H18a1.8 1.8 0 0 1 0 4.6h-2.5',
      'M7 8.5c1.1-2 3-2 4.3-1.1s3.1.9 4.2 1.1'],
    house: ['M3.8 11.2L12 4.8l8.2 6.4', 'M6.2 10.2V20h11.6v-9.8', 'M10.3 20v-4.6h3.4V20'],
    store: ['M5 9.2h14L20 20H4z', 'M9 9.2V7.4a3 3 0 0 1 6 0v1.8', 'M4 12.6h16'],
    city: ['M3 20.2v-7.4l4.2-3 4.2 3v7.4', 'M11.4 20.2v-5.6l4.8-3.6 4.8 3.6v5.6',
      'M5.6 15.4h1.4', 'M14.4 16.4h1.4', 'M18 16.4h1.4'],
    cave: ['M3.2 20.4v-4c0-4.9 3.9-8.8 8.8-8.8s8.8 3.9 8.8 8.8v4', 'M8.2 20.4v-3.6a3.8 3.8 0 0 1 7.6 0v3.6',
      'M8.6 6.8l.7 2.4', 'M12 6.2l.5 2.8', 'M15.4 6.8l-.7 2.4'],
    barrow: ['M6 20.6V10a6 6 0 0 1 12 0v10.6', 'M6 14.6h12', 'M12 4V2.2', 'M3.6 20.6h16.8'],
    jail: ['M4.4 5.4v15', 'M9.4 5.4v15', 'M14.6 5.4v15', 'M19.6 5.4v15', 'M4.4 12.4h15.2', 'M3 5.4h18'],
    fort: ['M4 20.4V9.4h2.2V7.2h3.2v2.2h5.2V7.2h3.2v2.2H20v11z', 'M10.6 20.4v-5.2h2.8v5.2', 'M4 13.4h16'],
    palace: ['M4 19.8h16', 'M4.6 19.8l1.2-9.6 3.8 3.8L12 6.4l2.4 7.6 3.8-3.8 1.2 9.6', ['circle', 12, 4.2, 1.3]],
    temple: ['M12 3.2l8.2 5H3.8z', 'M6.4 8.2v11', 'M17.6 8.2v11', 'M3.6 20.4h16.8', 'M10.2 20.4v-6h3.6v6'],
    mine: ['M3.4 21l9.2-9.2', 'M9.2 5.6c3.9-2.6 8.6-1.6 11.4 1.6-3.8 1.1-7 3.2-9.2 6.2',
      'M12.6 11.8l-2.2-2.2'],
    camp: ['M12 4.6L3.8 20.4h16.4z', 'M12 4.6v15.8', 'M8.6 20.4L12 13.6l3.4 6.8'],
    ship: ['M3.6 16.4h16.8l-2.4 4.4H6z', 'M12 16.4V3.6', 'M12 6l5.4 6.6H12'],
    farm: ['M3.8 20.4V10.2L12 5l8.2 5.2v10.2z', 'M3.8 14h16.4', 'M12 5v15.4'],
    ruin: ['M6.6 20.4V6.2h4v14.2', 'M13 20.4v-8.2h4.2v8.2', 'M4.4 20.4h15.2', 'M6.6 9.6h4'],
    ship_wreck: ['M3.6 16.4h16.8l-2.4 4.4H6z', 'M12 16.4V6.6', 'M12 8.6l4.6 5.4H12'],
    wild: ['M2.8 19.4l6.2-9.2 3.8 5 2.2-3 6.2 7.2z', ['circle', 17.4, 6.6, 2]],
  };
  /* Location TYPES the game hands us are many and inconsistently named, so one
     alias table maps every synonym onto the drawn set. An unknown kind falls
     back to "house" indoors / "wild" outdoors rather than drawing nothing. */
  const PLACE_ALIAS = {
    inn: 'inn', tavern: 'inn', bar: 'inn', lodge: 'inn',
    home: 'house', house: 'house', player_home: 'house', dwelling: 'house', room: 'house',
    store: 'store', shop: 'store', market: 'store', smithy: 'store', apothecary: 'store',
    city: 'city', town: 'city', settlement: 'city', village: 'city', habitation: 'city',
    cave: 'cave', grotto: 'cave', den: 'cave', lair: 'cave',
    dungeon: 'barrow', barrow: 'barrow', crypt: 'barrow', tomb: 'barrow', nordicruin: 'barrow',
    draugrcrypt: 'barrow', catacomb: 'barrow',
    jail: 'jail', prison: 'jail', dungeoncell: 'jail',
    fort: 'fort', keep: 'fort', tower: 'fort', castle: 'fort', bandit_camp: 'fort', stronghold: 'fort',
    palace: 'palace', hall: 'palace', jarlshall: 'palace', throne: 'palace', longhouse: 'palace',
    temple: 'temple', shrine: 'temple', chapel: 'temple', college: 'temple', guild: 'temple',
    mine: 'mine', quarry: 'mine',
    camp: 'camp', tent: 'camp', encampment: 'camp',
    ship: 'ship', boat: 'ship', shipwreck: 'ship_wreck',
    farm: 'farm', mill: 'farm', stable: 'farm',
    ruin: 'ruin', dwemer: 'ruin', dwemerruin: 'ruin', imperialruin: 'ruin',
    wilderness: 'wild', wild: 'wild', outdoors: 'wild', clearing: 'wild', landmark: 'wild',
    /* src/widgets.cpp's closed `place.type` list (2026-08-17 contract), every
       member mapped onto a drawn kind. barracks/stronghold read as a fort,
       crypt/dwemer as a barrow, a dragon lair as a cave, a mill as a farm,
       settlement as a city, a bare "interior" as a house. */
    barracks: 'fort', stronghold: 'fort', crypt: 'barrow', dwemer: 'barrow',
    dragon: 'cave', mill: 'farm', settlement: 'city', interior: 'house',
  };

  const READOUT_ART = {
    gold: ['M5 8.4c0-1.5 3.1-2.6 7-2.6s7 1.1 7 2.6-3.1 2.6-7 2.6-7-1.1-7-2.6z',
      'M5 8.4v4.2c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V8.4',
      'M5 12.6v4.2c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6v-4.2'],
    /* A weight, not a padlock — the first draft's ring-over-a-sack read as a
       lock at 22px. A trapezoid body plus a semicircular handle is the universal
       "carry weight" glyph. */
    carry: ['M7.2 8.6h9.6l2 11.8H5.2z', 'M9.4 8.6a2.6 2.6 0 0 1 5.2 0'],
    sun: WEATHER_ART.clear,
    moon: ['M20.2 14.8A8.6 8.6 0 1 1 9.4 3.9a6.9 6.9 0 0 0 10.8 10.9z'],
    /* A HORSESHOE. A horse's head does not survive 26px of 1.6px stroke — the
       first draft rendered as a blob. A shoe reads instantly at any size and is
       nobody's artwork. */
    mount: ['M6.4 20.6v-6.2a5.6 5.6 0 0 1 11.2 0v6.2', 'M9.6 20.6v-6.2a2.4 2.4 0 0 1 4.8 0v6.2',
      'M6.4 20.6h3.2', 'M14.4 20.6h3.2',
      ['circle', 8, 15.4, .65], ['circle', 16, 15.4, .65],
      ['circle', 8.1, 18.2, .65], ['circle', 15.9, 18.2, .65]],
    pin: ['M12.8 3.2h8v8l-8.6 8.6-8-8z', ['circle', 16.6, 7.4, 1.2]],
    set: ['M8 4h8v3.8a4 4 0 0 1-8 0z', 'M8 5.2H5.2v1.6a3.2 3.2 0 0 0 3.2 3.2',
      'M16 5.2h2.8v1.6a3.2 3.2 0 0 1-3.2 3.2', 'M10.2 11.8v3.4h3.6v-3.4', 'M7.8 19.4h8.4', 'M10 15.2h4v4.2h-4z'],
  };

  /* ---- round 2 glyphs: effect groups, resist schools, equipment slots -----
     Same rule as everything above: inline vector in the deck's gold, drawn here,
     nothing borrowed. Deliberately NOT emoji — the 2026-08-17 Ultralight probe
     measured colour emoji rendering MONOCHROME at a 1.4em advance, which shaves
     a glyph inside a fixed icon box. A stroked path has no such surprise. */
  const FX_ART = {
    buff: ['M12 20.4V5.2', 'M6.2 11L12 5.2 17.8 11'],
    debuff: ['M12 3.6v15.2', 'M17.8 13L12 18.8 6.2 13'],
    /* A flask — disease and its addiction cousin arrive from a potion-shaped
       source often enough that the bottle reads instantly. */
    disease: ['M10 3.4h4', 'M10.6 3.4v5.2L6.4 17a2.6 2.6 0 0 0 2.3 3.8h6.6a2.6 2.6 0 0 0 2.3-3.8l-4.2-8.4V3.4',
      'M8.2 14.4h7.6'],
    /* A skull, reduced to the two sockets and a jaw — poison is the one group
       that must be unmistakable at a glance. */
    poison: ['M12 3.4a6.6 6.6 0 0 0-4.2 11.7v2.5h8.4v-2.5A6.6 6.6 0 0 0 12 3.4z',
      'M9 17.6v3h6v-3', ['circle', 9.8, 10.4, 1.5], ['circle', 14.2, 10.4, 1.5]],
    /* Infinity: a permanent ability has no clock, and saying so with a shape
       beats printing a fake "0s". */
    constant: ['M8.2 9.2a2.8 2.8 0 1 0 0 5.6c2.6 0 3-5.6 7.6-5.6a2.8 2.8 0 0 1 0 5.6c-4.6 0-5-5.6-7.6-5.6z'],
  };
  const RESIST_ART = {
    /* A flame, one closed stroke plus its inner tongue. */
    fire: ['M12 3.2c3.4 3.4 5.6 5.8 5.6 9.4a5.6 5.6 0 0 1-11.2 0c0-2.2 1-3.8 2.4-5.2.4 1.4 1.2 2.2 2 2.4-.6-2.6-.4-4.6 1.2-6.6z',
      'M12 20.2a2.6 2.6 0 0 0 2.6-2.6c0-1.4-1.2-2.2-2.6-4-1.4 1.8-2.6 2.6-2.6 4A2.6 2.6 0 0 0 12 20.2z'],
    /* A snowflake — three axes plus barbs, which survives a 1.6px stroke where
       a six-armed crystal turns into a dot. */
    frost: ['M12 3.4v17.2', 'M4.6 7.6l14.8 8.8', 'M19.4 7.6L4.6 16.4',
      'M12 6.6l-2 -1.6', 'M12 6.6l2 -1.6', 'M12 17.4l-2 1.6', 'M12 17.4l2 1.6'],
    shock: ['M13.6 2.8L6.4 13.4h4.4l-1 7.8 7.4-10.8h-4.4z'],
    /* An arcane eye: the school of "magic resistance" has no natural object, so
       a warded eye is the deck's own answer. */
    magic: ['M2.8 12S6.4 6.2 12 6.2 21.2 12 21.2 12 17.6 17.8 12 17.8 2.8 12 2.8 12z',
      ['circle', 12, 12, 2.6]],
    /* A dripping vial — poison RESISTANCE, distinct from the skull above so the
       two never read as the same idea. */
    poison: ['M9.4 3.4h5.2', 'M10 3.4v4.4l-3.2 8.2a2.4 2.4 0 0 0 2.2 3.4h6a2.4 2.4 0 0 0 2.2-3.4L14 7.8V3.4',
      ['circle', 12, 15.4, 1.6]],
    /* A physician's cross inside a shield — disease resistance. */
    disease: ['M12 3.2l7 2.6v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9v-6z',
      'M12 8.4v7.2', 'M8.4 12h7.2'],
    /* An armour rating: a plain heater shield, no cross. */
    armor: ['M12 3.2l7.2 2.6v6.2c0 4.4-3.1 7.6-7.2 9-4.1-1.4-7.2-4.6-7.2-9V5.8z'],
    phys: ['M12 3.2l7.2 2.6v6.2c0 4.4-3.1 7.6-7.2 9-4.1-1.4-7.2-4.6-7.2-9V5.8z', 'M12 3.2v17.8'],
  };
  /* The resist row, in the order the reference mod settled on and it is the
     right one: the three elements you actually get hit by, then the three
     abstract ones. `cap` is the scale each meter is drawn against — magic tops
     out at 85 in vanilla, not 100, so drawing it against 100 would make a
     capped character look short. C++ ships capMagic/capPhys with the data, and
     those override the numbers here. */
  const RESIST_ROWS = [
    ['fire', 'Fire', 100],
    ['frost', 'Frost', 100],
    ['shock', 'Shock', 100],
    ['magic', 'Magic', 85],
    ['poison', 'Poison', 100],
    ['disease', 'Disease', 100],
  ];

  const EQUIP_ART = {
    /* A sword, point up — the right hand's default and the only weapon glyph a
       26px box can carry without turning to mush. */
    weapon: ['M12 2.6l2.2 2.2v9.6h-4.4V4.8z', 'M8 16.6h8', 'M12 16.6v4.8', 'M10 21.4h4'],
    /* A hand cradling a spark: any spell, either hand. */
    spell: ['M12 4.2v3.4', 'M12 16.4v3.4', 'M4.6 12h3.4', 'M16 12h3.4',
      'M6.8 6.8l2.4 2.4', 'M14.8 14.8l2.4 2.4', 'M17.2 6.8l-2.4 2.4', 'M9.2 14.8l-2.4 2.4',
      ['circle', 12, 12, 2.4]],
    shield: RESIST_ART.armor,
    /* An arrow, nock and all. */
    ammo: ['M4.4 19.6L18 6', 'M13.4 5.2h5.4v5.4', 'M4.4 19.6l1.4-4 2.6 2.6z'],
    /* A torch / lantern stand-in for "something else in that hand". */
    other: ['M9.6 20.4h4.8', 'M12 20.4v-5.6', 'M8.8 8.6h6.4l-1.2 6.2H10z',
      'M12 8.6c0-2.4-1.6-3.2-1.6-5 2.2.8 3.4 2 3.4 3.4'],
    empty: ['M6.2 6.2l11.6 11.6', 'M17.8 6.2L6.2 17.8'],
  };
  const NEED_ART = {
    /* A haunch — hunger. */
    hunger: ['M7.6 16.4c-2.2-2.2-2.2-6 .6-8.4 2.8-2.4 6.6-2 8.6.4 2 2.4 1.6 6-1 8s-6 1.8-8.2-.2z',
      'M7.4 16.6l-3 3', 'M4.4 19.6l-1.6.4.4-1.6'],
    /* A droplet — thirst. */
    thirst: ['M12 3.2c3.4 4.2 5.6 6.8 5.6 9.8a5.6 5.6 0 1 1-11.2 0c0-3 2.2-5.6 5.6-9.8z'],
    /* A crescent over a pillow line — fatigue. */
    fatigue: ['M19.6 14.4A8 8 0 1 1 9.6 4.4a6.4 6.4 0 0 0 10 10z', 'M4.2 20.4h15.6'],
    /* Cold reuses the snowflake, because it IS the same idea. */
    cold: RESIST_ART.frost,
    default: ['M12 3.6v16.8', 'M5.6 10h12.8'],
  };
  const VITAL_ART = {
    /* A voice/shout: three widening arcs off a mouth. Not a speaker — a speaker
       reads as "audio settings". */
    shout: ['M6.2 12a3 3 0 0 1 3-3h1.4l4.4-3.6v13.2L10.6 15H9.2a3 3 0 0 1-3-3z',
      'M18 8.4a5.2 5.2 0 0 1 0 7.2', 'M20.4 5.8a8.6 8.6 0 0 1 0 12.4'],
    /* A rising chevron over a bar: experience toward the next level. */
    xp: ['M4.2 15.6l4.4-4.6 3.4 3.2 7.8-8', 'M16 6.2h3.8V10'],
    ally: ['M9.4 11.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z',
      'M2.8 20.4c0-3.4 2.9-5.8 6.6-5.8s6.6 2.4 6.6 5.8',
      'M17 5.4l1.4 2.9 3.2.4-2.3 2.2.6 3.1-2.9-1.5-2.9 1.5.6-3.1-2.3-2.2 3.2-.4z'],
  };

  function weatherKind(kind) { return WEATHER_ALIAS[String(kind || '').toLowerCase()] || 'cloudy'; }
  function placeKind(kind, interior) {
    const k = PLACE_ALIAS[String(kind || '').toLowerCase().replace(/[\s-]+/g, '_')];
    return (k && PLACE_ART[k]) ? k : (interior ? 'house' : 'wild');
  }
  function weatherArt(kind) { return WEATHER_ART[weatherKind(kind)] || WEATHER_ART.cloudy; }
  function placeArt(kind, interior) { return PLACE_ART[placeKind(kind, interior)]; }

  /* ---- painted glyphs, when the icon set has one -----------------------
     The icon agent ships hand-painted 256px PNGs into icons/custom/ for the
     weather kinds, the location types and three of the readouts. Those are the
     art of record; the inline SVG above stays as the ALWAYS-present fallback,
     drawn underneath, so a kind with no painting (ash, ruin, a shipwreck) still
     gets a glyph instead of a hole — and so this view never depends on a file
     landing. The <img> is created only when the KIND changes (a structural
     rebuild), never per tick, and it is laid out at its final size because an
     <img> rasterises at layout size in Ultralight. */
  const PAINTED = {
    ro: { gold: 'hud-gold', carry: 'hud-carry', mount: 'hud-mount' },
    wx: { clear: 'wx-clear', cloudy: 'wx-cloudy', overcast: 'wx-cloudy', rain: 'wx-rain',
      storm: 'wx-storm', snow: 'wx-snow', fog: 'wx-fog' },
    wxNight: { clear: 'wx-clear-night' },
    sn: { winter: 'sn-winter', spring: 'sn-spring', summer: 'sn-summer', autumn: 'sn-autumn' },
    loc: { inn: 'loc-inn', house: 'loc-home', store: 'loc-shop', city: 'loc-city',
      cave: 'loc-cave', barrow: 'loc-dungeon', jail: 'loc-jail', fort: 'loc-fort',
      palace: 'loc-palace', temple: 'loc-temple', mine: 'loc-mine', camp: 'loc-camp',
      ship: 'loc-ship', farm: 'loc-farm' },
  };
  /* The shipped icon set has no loc-ruin / loc-wild / loc-shipwreck, so those
     three kinds keep the inline SVG. Everything in the C++ closed list resolves
     through PLACE_ALIAS first, so `barracks` arrives here as `fort` and paints. */
  /* Keep the SVG until the painting has loaded, then hide it: transparent art
     must never reveal a second symbol underneath. A failed image restores it. */
  function glyphBox(cls, art, painted, size) {
    const fallback = svgIcon(art, size);
    const box = h('span', { class: cls }, fallback);
    if (!painted) return box;
    const img = document.createElement('img');
    img.className = 'hud-glyph-img';
    img.alt = ''; img.draggable = false;
    img.width = size; img.height = size;
    img.onload = function () { fallback.style.visibility = 'hidden'; };
    img.onerror = function () { fallback.style.visibility = ''; if (img.parentNode) img.parentNode.removeChild(img); };
    img.src = 'icons/custom/' + painted + '.png';   // plain path — no ?v= query
    box.appendChild(img);
    return box;
  }

  /* ======================================================================
     WIDGET CONFIG — what shows. Defensive defaults; C++ owns the durable copy.
     ====================================================================== */
  const wcfg = {
    on: true,                       // master switch for the whole widget stack
    gold: true, carry: true, time: true, context: true, pots: true, lockpicks:false, weatherOnly:false, weatherCenter:false,
    clock24: false, snapRects: false, ornateClock: false, clockFrame: false, clockMotion: true, clockDate: true,
    calendar: false, calendarDay: true, calendarMonth: true, calendarSeason: true,
    needsSeparate: false, needsIconsOnly: false, needFood: true, needDrink: true, needSleep: true, needCold: false,
    mount: true, pins: true, sets: true,
    /* round 2 (2026-08-17) — the player's own state */
    vitals: true, resist: false, effects: true, equip: true, survival: true, allies: true,
    /* round 3 — the four FREE slot widgets. Default OFF like their C++ side:
       a widget added later must arrive silent (the 7d810c8 lesson). */
    handR: false, handL: false, voice: false, quick: false,
    /* round 4 (2026-08-18) — the custom quick-items twin and the loot lamp.
       Default OFF, same law: a widget added later arrives silent. */
    quick2: false, lootStatus: false,
    /* 2026-08-31 — the season readout, a free widget of its own. OFF, same law. */
    season: false,
    /* 2026-09-01 — the ward widget (WardAnytime). OFF, same law. */
    ward: false,
    pinLabels: true, badges: true, barNumbers: true,
  };
  const LINE_KEYS = ['gold', 'carry', 'time', 'context', 'pots', 'lockpicks', 'weatherOnly'];
  /* Order here is the order of the switches in the settings card, and it mirrors
     the DOM order in hud.html so the card reads top-to-bottom like the stack. */
  const BLOCK_KEYS = ['vitals', 'resist', 'effects', 'equip', 'survival', 'mount', 'pins', 'sets', 'allies'];
  const ALMANAC_KEYS = ['calendar', 'calendarDay', 'calendarMonth', 'calendarSeason'];
  const NEED_KEYS = ['needsSeparate', 'needsIconsOnly', 'needFood', 'needDrink', 'needSleep', 'needCold'];
  const CLOCK_KEYS = ['ornateClock', 'clockFrame', 'clockMotion', 'clockDate'];
  const DETAIL_KEYS = ['pinLabels', 'badges', 'barNumbers', 'clock24', 'weatherOnly', 'weatherCenter', 'snapRects'].concat(ALMANAC_KEYS, NEED_KEYS, CLOCK_KEYS);
  /* ---- EDIT MODE DRAWS EVERY WIDGET, ON OR OFF (2026-08-19, round 3) -------
     Rober, third shelf play-test: "if widgets are off and i hit config, then it
     doesn't show them, just circles."

     Root cause: an OFF widget was `display:none`, and the only thing left on
     screen was the container it used to fill — a `.hud-det` wrap or the empty
     `.hud-panel`, both of which carry padding + a rounded border + the dashed
     edit outline, so an empty one paints as a ~24px rounded blob. A screen of
     those is unplaceable and unreadable: you cannot tell which blob is Gold and
     which is Survival, and there is nothing to size.

     So edit mode now draws EVERYTHING. A widget whose switch is off renders its
     real card — live data where the game is sending any, its own ghost line
     where it is not — dimmed, dashed and tagged `off` (`is-editoff`). Placing
     and sizing an off widget is therefore the same act as placing an on one,
     which is the whole point of a placement editor. Leaving edit mode goes
     straight back to honest visibility: `blockWant` collapses to the shipped
     `wcfg.on && wcfg[key] && has` the moment `editing` is false, so nothing an
     off widget does here can ever survive into play. */
  function blockWant(key, has) {
    if (editing) return true;
    return !!(wcfg.on && wcfg[key] && has);
  }
  /* True when the block is only on screen because we are editing — the switch
     (its own, or the stack master above it) says off. */
  function blockGhosted(key) { return editing && !(wcfg.on && wcfg[key]); }
  /* Round 3: the free slot widgets. NOT in BLOCK_KEYS — they draw outside the
     stacked assembly, each at its own Widget placement, and own their menu
     gate per widget (hideInMenus finally means one plate, not the whole
     stack). `wfree` mirrors the C++ Widget fields; C++ owns the durable copy
     and this view is the only editor of the placement. */
  /* `quick2` (the player-curated twin of the favourites strip) and
     `lootStatus` (the glow / auto-loot lamp) join the free layer in round 4 —
     they are free widgets in every mechanical sense (own placement, own drag,
     own wheel scale, own menu gate), so they ride this list rather than growing
     a third system beside it. Only the BUILDER differs, which renderFree picks
     per key. */
  /* `season` joins in 2026-08-31 for the same reason quick2 and lootStatus did:
     it is a free widget in every mechanical sense (own placement, own drag, own
     wheel scale, own menu gate) and only its BUILDER differs. Rober asked for it
     "not apart of other widgets" — this list is what grants that. */
  /* `ward` joins 2026-09-01: same free-layer mechanics, its own builder (wardRow
     through the slot-card path). */
  const FREE_KEYS = ['handR', 'handL', 'voice', 'quick', 'quick2', 'lootStatus', 'season', 'ward'];
  /* The slot widgets that carry a per-key ⚙ switch. Since 2026-08-18 the card
     no longer draws them as one flat row — handR/handL/voice are nested inside
     the merged "Equipped slots" widget and quick/quick2 have their own group —
     but the list is still the completeness invariant the OPT_LABELS harness
     check reads: every key here MUST have a label. */
  const FW_SLOT_GROUP = ['handR', 'handL', 'voice', 'quick', 'quick2'];
  /* spacing matches the 158px reference-scale cards — and OLD default
     positions (the 76px-card era: -250/-125/0/235) are silently upgraded in
     wgConfig below, so a config that was never hand-dragged doesn't overlap
     itself the day the cards grew. A dragged card keeps its spot. */
  const wfree = {
    handR: { x: -352, y: 96, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    handL: { x: -176, y: 96, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    voice: { x: 0, y: 96, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    quick: { x: 300, y: 96, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    /* One row ABOVE the favourites strip — and far enough above it to actually
       clear it. The shipped 150/200 assumed a strip ~54 px tall; the real
       favourites card is 172 px (64 px tiles + label + padding), so the two
       shelves came up as ONE PILE on any config that had never been dragged
       (measured 10,744 px² of overlap at both 2560x1440 and 1280x720, Opus
       audit 2026-08-18). 300 clears the strip with air to spare. */
    quick2: { x: 300, y: 300, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    lootStatus: { x: 24, y: 24, anchorH: 'right', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    /* Top-right, below the context column's default four, so switching it on
       with clock/weather/place/mount already up lands clear. Mirrors the C++
       Config() default exactly — the two must agree or a fresh install jumps
       the first time C++ pushes its copy. */
    season: { x: 24, y: 320, anchorH: 'right', anchorV: 'top', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
    /* Left of the equipped row, clear of the 158px cards. Mirrors the C++
       Config() default exactly — the two must agree or a fresh install jumps. */
    ward: { x: -520, y: 96, anchorH: 'center', anchorV: 'bottom', scale: 1, opacity: 1, bare: false, showLabel: true, hideInMenus: true },
  };
  /* ---- the custom quick items' own config (round 4) ----------------------
     `max` (1..16) is how many rows are DRAWN; `items` is what is STORED, up to
     16 — shrinking max hides rows, it never eats them (the hotbar's
     stored-at-24 law). ⚠ C++ contains()-guards both, so saveWidgetCfg sends
     them ONLY when this view actually edited them: a placement-only save that
     carried an empty `items` would wipe the player's list. */
  const Q2_MAX_ITEMS = 16;
  const q2 = { max: 8, items: [], dirty: false };
  function q2Items() { return q2.items; }
  function q2Drawn() { return q2.items.slice(0, clamp(q2.max, 1, Q2_MAX_ITEMS)); }
  /* The hands/powers cards ship LOCKED TOGETHER as one vertical unit
     (Rober's spec, 2026-08-18: "meant to ship as locked together - with
     similar rectangular sizing - and move as one (vertically longer), by
     default. with ability to seperate them"). wgrp is the group's one
     placement; it is ALSO registered as wdet.fwgrp so the shared .hud-det
     drag/wheel machinery moves and scales it with zero extra code. */
  const GRP_DEFAULT_KEYS = ['handR', 'handL', 'voice'];
  /* ---- WHO IS IN THE GROUP IS DATA NOW (2026-08-19) ----------------------
     Rober, after the shelf play-test: "ability to connect up widgets if you
     want to". Membership used to be the constant above; it is now
     `wgrp.keys` — any FREE widget (the six .hud-fw cards) can be linked in,
     and the group still drags, scales, hides and orients as ONE.

     It rides `hud.grp.keys` in the same view-owned blob the rest of the
     group's state does (C++ stores `hud` verbatim and never parses it), so
     there is NO schema break in either direction: a config written before
     this has no `keys` and falls back to the three shipped members, and an
     older view simply ignores the key and keeps welding the same three.
     ⚠ Never let it go empty — a group with no members is a placement that
     owns nothing, so grpLink refuses the last unlink. */
  function grpKeys() {
    return (wgrp.keys && wgrp.keys.length) ? wgrp.keys : GRP_DEFAULT_KEYS;
  }
  function grpHas(k) { return grpKeys().indexOf(k) !== -1; }
  /* ⚠ NOT "Equipped" — that name is already taken by the stack block of the
     same idea (DET_LABELS.equip), and two switches reading "Equipped" in a
     filterable card is a trap, not a name. */
  const GRP_LABEL = 'Equipped slots';
  /* `orient` (2026-08-18, Rober: "they default to vertical, no option to make
     the group horizontal") and `mem` (what the master switch has to put BACK)
     ride the same view-owned `hud.grp` blob the placement already rides, so
     they round-trip for free — C++ keeps `hud` verbatim and never parses it.
     An older config simply has neither key and falls back to these defaults. */
  const wgrp = { locked: true, x: 28, y: 220, anchorH: 'left', anchorV: 'top', scale: 1,
    orient: 'vert', mem: null, keys: null };
  /* ---- the three slots are ONE widget with three lines --------------------
     (Rober, play-test 2026-08-18: "left / right / powers show as THREE
     different widgets… should be one widget with individual toggles inside it,
     plus one master toggle that by default toggles all three together".)
     The master is DERIVED — any line on means the widget is on — so an
     individual toggle can never disagree with it. Turning the master off
     remembers which lines were on, and turning it back on restores exactly
     those; a config that has never had one on gets all three. */
  function grpAnyOn() { for (const k of grpKeys()) if (wcfg[k]) return true; return false; }
  function grpAllOn() { for (const k of grpKeys()) if (!wcfg[k]) return false; return true; }
  function grpSetMaster(on) {
    if (!on) {
      const mem = [];
      for (const k of grpKeys()) if (wcfg[k]) mem.push(k);
      wgrp.mem = mem.length ? mem : null;
      for (const k of grpKeys()) wcfg[k] = false;
      return;
    }
    const mem = (wgrp.mem && wgrp.mem.length) ? wgrp.mem : grpKeys();
    for (const k of grpKeys()) wcfg[k] = mem.indexOf(k) !== -1;
    if (!grpAnyOn()) for (const k of grpKeys()) wcfg[k] = true;   // never a no-op switch
  }
  /* Link a free widget INTO the group, or take it back out (2026-08-19).
     Linking is pure membership: the widget keeps its own stored x/y/scale, so
     unlinking later puts it back exactly where it used to live. */
  function grpLink(k, on) {
    if (FREE_KEYS.indexOf(k) === -1) return false;
    const cur = grpKeys().slice();
    const at = cur.indexOf(k);
    if (on && at !== -1) return false;
    if (!on && at === -1) return false;
    if (on) cur.push(k);
    else {
      if (cur.length <= 1) return false;   // a group with no members owns nothing
      cur.splice(at, 1);
    }
    /* store in the shipped order, so a group always reads the same way */
    const ks = FREE_KEYS.filter(function (f) { return cur.indexOf(f) !== -1; });
    wgrp.keys = ks.join(',') === GRP_DEFAULT_KEYS.join(',') ? null : ks;
    /* A widget just linked in must lose its own placement styles (the group
       places it), and one just taken out must get its own back — applyGroup
       reparents, renderFree re-places. */
    applyGroup(); renderFree(); applyGroup();
    return true;
  }
  function grpScaleBy(d) {
    wgrp.scale = clamp(num(wgrp.scale, 1) + d, 0.5, 2.5);
    const g = grpEl(false);
    if (g) placeFree(g, wgrp);
  }
  const OLD_FREE_X = { handR: -250, handL: -125, voice: 0, quick: 235 };
  const NEW_FREE_X = { handR: -352, handL: -176, voice: 0, quick: 300 };
  /* Every y the custom strip has ever SHIPPED at, none of which clears the
     favourites strip below it (C++ 150, this view's old 200). A config still
     sitting on one of them was never dragged, so moving it is a fix, not a
     surprise; anything else is the player's own placement and is untouchable. */
  const OLD_Q2_Y = [150, 200];
  function migrateFreeDefaults() {
    for (const k of FREE_KEYS) {
      const w = wfree[k];
      if (w.x === OLD_FREE_X[k] && w.y === 96 && w.anchorH === 'center' && w.anchorV === 'bottom')
        w.x = NEW_FREE_X[k];
    }
    const q = wfree.quick2;
    if (q.anchorH === 'center' && q.anchorV === 'bottom' &&
        (q.x === 235 || q.x === 300) && OLD_Q2_Y.indexOf(q.y) !== -1) {
      q.x = 300; q.y = 300;
    }
  }

  /* ---- detachable stack blocks (Rober, 2026-08-18: "each one of these
     should be its own widget. not bound to one..... so you can grab them
     around anywhere"). A floated block's DOM node MOVES out of the stack into
     an absolutely-placed wrap in #hud-free — same element, so every renderer,
     signature and live patch keeps working on it untouched. Placement lives
     in the view-owned `hud` prefs blob (wdet), beside the detail toggles. */
  /* 2026-08-18: the readouts LINE was one detachable block ('readouts'); Rober,
     pointing at the gold · carry · time · place · Potions bar — "every one of
     these widgets should be movable and seperate too by default" — so the five
     lines are five DET keys of their own and the old 'readouts' key is retired.
     An old config's stored det.readouts is simply never read again (this loop
     is the only reader), and the five new keys seed themselves on first render
     because needsSeed() checks PER KEY, not one global flag. */
  const DET_KEYS = ['roLockpicks', 'roWeather', 'calendar', 'needFood', 'needDrink', 'needSleep', 'needCold', 'roGold', 'roCarry', 'roTime', 'roContext', 'roPots',
    'vitals', 'resist', 'effects', 'equip', 'survival',
    'mount', 'pins', 'sets', 'allies'];
  const DET_LABELS = {
    roLockpicks:'Lockpicks', roWeather:'Weather',
    calendar: 'Date & season', needFood: 'SunHelm food', needDrink: 'SunHelm drink', needSleep: 'SunHelm sleep', needCold: 'SunHelm cold',
    roGold: 'Gold', roCarry: 'Carry weight', roTime: 'Time',
    roContext: 'Weather / place', roPots: 'Potions',
    vitals: 'Vitals', resist: 'Resists', effects: 'Effects',
    equip: 'Equipped', survival: 'Survival', mount: 'Mount', pins: 'Pins',
    sets: 'Sets', allies: 'Allies',
  };
  const ST_ORDER = ['roLockpicks', 'roWeather', 'calendar', 'needFood', 'needDrink', 'needSleep', 'needCold', 'roGold', 'roCarry', 'roTime', 'roContext', 'roPots',
    'vitals', 'resist', 'effects', 'equip', 'survival',
    'mount', 'pins', 'sets'];
  const wdet = {};   // k -> {on,x,y,anchorH,anchorV,scale}
  function detOn(k) { return !!(wdet[k] && wdet[k].on); }
  function detWrap(k, make) {
    let wrap = document.getElementById('hud-det-' + k);
    if (!wrap && make) {
      wrap = h('div', { class: 'hud-det', id: 'hud-det-' + k, 'data-det': k });
      const freeRoot = document.getElementById('hud-free');
      if (freeRoot) freeRoot.appendChild(wrap);
    }
    return wrap;
  }
  function reattachBlock(k, node) {
    if (k === 'allies') { el.panel.insertBefore(node, el.empty); return; }
    /* canonical order: before the first LATER sibling still in the stack */
    const at = ST_ORDER.indexOf(k);
    for (let i = at + 1; i < ST_ORDER.length; i++) {
      const sib = el[ST_ORDER[i]];
      if (sib && sib.parentNode === el.widgets) { el.widgets.insertBefore(node, sib); return; }
    }
    el.widgets.appendChild(node);
  }
  function applyDetach(gatedOff) {
    for (const k of DET_KEYS) {
      const node = el[k];
      if (!node) continue;
      if (detOn(k)) {
        const wrap = detWrap(k, true);
        if (node.parentNode !== wrap) wrap.appendChild(node);
        setClass(wrap, 'hud-clock-bare', k === 'roTime' && wcfg.ornateClock && !wcfg.clockFrame);
        const d = wdet[k];
        placeFree(wrap, { x: d.x, y: d.y, anchorH: d.anchorH, anchorV: d.anchorV,
          scale: num(d.scale, 1), opacity: 1 });
        /* a floated block still obeys the master switch, the menu gate and its
           own is-off (no data / toggled off) — but never disappears mid-edit */
        setClass(wrap, 'is-off',
          node.classList.contains('hud-layout-inactive') || (!editing && (gatedOff || node.classList.contains('is-off'))));
        /* the wrap wears the ghost dress its BLOCK is wearing — the dim and the
           "off" tag belong on the draggable thing, not doubled on both */
        setClass(wrap, 'is-editoff', editing && node.classList.contains('is-editoff'));
      } else {
        const wrap = detWrap(k, false);
        if (wrap) { reattachBlock(k, node); wrap.remove(); }
      }
    }
    /* a block just moved into or out of the panel — re-take its verdict */
    refreshPanelBlank();
  }
  function floatBlock(k, on) {
    const node = el[k];
    if (!node) return;
    if (on && !detOn(k)) {
      /* pop out EXACTLY where it sits right now — no jump */
      const r = node.getBoundingClientRect();
      wdet[k] = { on: true, x: Math.max(0, Math.round(r.left)),
        y: Math.max(0, Math.round(r.top)), anchorH: 'left', anchorV: 'top', scale: 1 };
    } else if (!on && wdet[k]) {
      wdet[k].on = false;
    }
    applyDetach(false);
    if (typeof fitWidgets === 'function') fitWidgets();
    saveWidgetCfg();
  }
  /* ---- ONE drag path for every movable widget (2026-08-18) ---------------
     Both families of movable thing — the floated stack blocks / the equipped
     group (.hud-det wraps) and the free slot widgets (.hud-fw roots) — now
     move through THIS function. It takes a SCREEN delta, folds it into the
     widget's own anchored x/y, clamps it inside the viewport and writes the
     placement onto the NODE THE CALLER IS HOLDING.

     ⚠ Holding the node is the whole point, and it is the bug this replaces.
     The old .hud-det mover re-looked-up its element as
     `document.getElementById('hud-det-' + k)` — which is right for a floated
     stack block and WRONG for the equipped group, whose element is
     `#hud-fw-grp` (grpEl builds it; detWrap never made it). So `wrap` came
     back null on every single pointermove, the `if (wrap)` guard swallowed the
     write, and the group's x/y advanced with the cursor while NOTHING on
     screen moved. The card then jumped to the new spot only when something
     else happened to call applyGroup() — i.e. on the next live widget tick.
     That is exactly the reported symptom: the free widgets glide, the equipped
     group lurches along a few times a second. */
  function moveWidgetBy(node, w, dx, dy, o) {
    o = o || {};
    w.x = num(w.x, 0) + (w.anchorH === 'right' ? -dx : dx);
    w.y = num(w.y, 0) + (w.anchorV === 'bottom' ? -dy : dy);
    /* keep the widget reachable: its anchor point stays on-screen */
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    if (w.anchorH === 'center') w.x = clamp(w.x, -vw / 2 + 24, vw / 2 - 24);
    else w.x = clamp(w.x, 0, Math.max(0, vw - 48));
    w.y = clamp(w.y, 0, Math.max(0, vh - 48));
    /* snap to the exact centre while DRAGGING near it (never on key nudges —
       a 1px nudge that teleports 9px would fight the player's hand) */
    let snapped = false;
    if (o.snap && w.anchorH === 'center' && Math.abs(w.x) < 10) { w.x = 0; snapped = true; }
    fwGuide().classList.toggle('show', snapped);
    if (node) placeFree(node, { x: w.x, y: w.y, anchorH: w.anchorH, anchorV: w.anchorV,
      scale: num(w.scale, 1), opacity: o.opacity == null ? num(w.opacity, 1) : o.opacity });
  }

  /* Rectangle magnetism uses SCREEN rects (already scaled), never layout sizes.
     Start-of-drag coordinates stay raw: snapped pixels must not accumulate and
     trap the cursor at a join. No layout reads in the pointermove path. */
  const RECT_SNAP_KEYS = ['roGold', 'roCarry', 'roTime', 'roContext', 'roPots',
    'roLockpicks', 'roWeather', 'calendar', 'survival', 'needFood', 'needDrink', 'needSleep', 'needCold'];
  function snapRectangle(r, others, vw, vh) {
    const gap = 8, reach = 12;
    let best = { dx: 0, dy: 0, key: '' }, score = Infinity;
    function consider(dx, dy, target) {
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) return;
      const x = r.left + dx, y = r.top + dy;
      if (x < 0 || y < 0 || x + r.width > vw || y + r.height > vh) return;
      if (others.some(t => x < t.left + t.width - 0.5 && x + r.width > t.left + 0.5 &&
          y < t.top + t.height - 0.5 && y + r.height > t.top + 0.5)) return;
      const cost = dx * dx + dy * dy;
      if (cost < score) { best = { dx: dx, dy: dy, key: target.key }; score = cost; }
    }
    for (const t of others) {
      const alignY = [t.top - r.top, t.top + t.height - r.top - r.height];
      const alignX = [t.left - r.left, t.left + t.width - r.left - r.width];
      const nearest = a => a.reduce((x, y) => Math.abs(x) <= Math.abs(y) ? x : y);
      const ay = nearest(alignY), ax = nearest(alignX);
      const dy = Math.abs(ay) <= reach ? ay : 0, dx = Math.abs(ax) <= reach ? ax : 0;
      // Side-by-side or stacked, with overlap on the other axis. Never attract
      // a distant tile just because it happens to share an x or y coordinate.
      if (r.top + dy < t.top + t.height && r.top + dy + r.height > t.top) {
        consider(t.left + t.width + gap - r.left, dy, t);
        consider(t.left - gap - r.width - r.left, dy, t);
      }
      if (r.left + dx < t.left + t.width && r.left + dx + r.width > t.left) {
        consider(dx, t.top + t.height + gap - r.top, t);
        consider(dx, t.top - gap - r.height - r.top, t);
      }
    }
    return best;
  }
  function rectangleTargets(key) {
    const out = [];
    for (const k of RECT_SNAP_KEYS) {
      if (k === key || !detOn(k) || (k === 'roTime' && wcfg.ornateClock)) continue;
      const node = detWrap(k, false);
      if (!node || node.classList.contains('is-off') || node.classList.contains('is-editoff')) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({key:k, left:r.left, top:r.top, width:r.width, height:r.height});
    }
    return out;
  }
  function connectedRectangles(start, others) {
    // Reconstruct the visible chain from its eight-pixel joins. No permanent
    // grouping data: pulling a tile away with a normal drag disconnects it.
    const found = [start], todo = others.slice();
    function touches(a, b) {
      const near = v => Math.abs(v - 8) <= 2;
      const beside = near(a.left - b.left - b.width) || near(b.left - a.left - a.width);
      const above = near(a.top - b.top - b.height) || near(b.top - a.top - a.height);
      return (beside && Math.min(a.top+a.height,b.top+b.height) - Math.max(a.top,b.top) > 2) ||
        (above && Math.min(a.left+a.width,b.left+b.width) - Math.max(a.left,b.left) > 2);
    }
    for (let i = 0; i < found.length; i++) {
      for (let j = todo.length - 1; j >= 0; j--) {
        if (touches(found[i], todo[j])) found.push(todo.splice(j, 1)[0]);
      }
    }
    return found;
  }
  function moveRectangleCluster(d, x, y) {
    const members = d.cluster;
    const left = Math.min.apply(null, members.map(m => m.rect.left));
    const top = Math.min.apply(null, members.map(m => m.rect.top));
    const right = Math.max.apply(null, members.map(m => m.rect.left + m.rect.width));
    const bottom = Math.max.apply(null, members.map(m => m.rect.top + m.rect.height));
    // One screen delta for the entire chain, including mixed anchors/scales.
    // Clamp the union once so a screen edge never crushes its spacing.
    const dx = clamp(x - d.sx, Math.min(0, -left), Math.max(0, (window.innerWidth || 1920) - right));
    const dy = clamp(y - d.sy, Math.min(0, -top), Math.max(0, (window.innerHeight || 1080) - bottom));
    for (const m of members) {
      m.w.x = m.x; m.w.y = m.y;
      moveWidgetBy(m.node, m.w, dx, dy, {snap:false, opacity:1});
      m.node.classList.add('hud-rect-snapped');
    }
  }
  function clearRectangleSnap() {
    for (const n of document.querySelectorAll('.hud-rect-snapped')) n.classList.remove('hud-rect-snapped');
  }
  function moveRectangleDrag(d, w, x, y, bypass) {
    const dx = x - d.sx, dy = y - d.sy;
    const r = {left:d.rect.left + dx, top:d.rect.top + dy, width:d.rect.width, height:d.rect.height};
    const hit = wcfg.snapRects && !bypass
      ? snapRectangle(r, d.targets, window.innerWidth || 1920, window.innerHeight || 1080)
      : {dx:0, dy:0, key:''};
    w.x = d.x; w.y = d.y;
    moveWidgetBy(d.node, w, dx + hit.dx, dy + hit.dy, {snap:!hit.key, opacity:1});
    clearRectangleSnap();
    if (hit.key) {
      d.node.classList.add('hud-rect-snapped');
      const target = detWrap(hit.key, false);
      if (target) target.classList.add('hud-rect-snapped');
    }
  }

  /* drag a floated block or the equipped group (edit mode only).
     Wired EXACTLY like the free widgets' drag below — pointer AND mouse, with
     the same double-fire guard — because this view runs in Ultralight, where
     which of the two families arrives is the engine's business, not ours. It
     was the one drag in the whole file listening for pointer events alone. */
  let ddrag = null;
  function onDetDown(e) {
    if (!editing) return;
    const wrap = e.target && e.target.closest ? e.target.closest('.hud-det') : null;
    if (!wrap) return;
    const k = wrap.getAttribute('data-det');
    if (!k || !wdet[k]) return;
    /* a control inside a draggable wrap ACTS, it never starts a drag — the
       same law the free widgets' mini toolbar lives by */
    const btn = e.target.closest ? e.target.closest('[data-fwact]') : null;
    if (btn) {
      grpToolAct(k, btn.getAttribute('data-fwact'));
      e.preventDefault(); e.stopPropagation();
      return;
    }
    /* clicking a floated block (or the welded group) jumps the shelf to its
       row — same key mapping the block's own ⚙ button uses */
    revealInShelf(k === 'fwgrp' ? 'fwgrp' : (KEY_OF_DET[k] || k));
    ddrag = { k: k, node: wrap, sx: e.clientX, sy: e.clientY };
    if (RECT_SNAP_KEYS.indexOf(k) !== -1 && !(k === 'roTime' && wcfg.ornateClock)) {
      ddrag.rect = wrap.getBoundingClientRect();
      ddrag.x = wdet[k].x; ddrag.y = wdet[k].y;
      ddrag.targets = rectangleTargets(k);
      if (e.shiftKey && wcfg.snapRects) {
        const r = ddrag.rect;
        const chain = connectedRectangles({key:k, left:r.left, top:r.top, width:r.width, height:r.height}, ddrag.targets);
        if (chain.length > 1) ddrag.cluster = chain.map(function (rect) {
          const w = wdet[rect.key];
          return {node:detWrap(rect.key, false), rect:rect, w:w, x:w.x, y:w.y};
        });
      }
    }
    wrap.classList.add('is-drag');
    try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault(); e.stopPropagation();
  }
  function onDetMove(e) {
    if (!ddrag) return;
    if (ddrag.cluster) {
      moveRectangleCluster(ddrag, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (ddrag.rect) {
      moveRectangleDrag(ddrag, wdet[ddrag.k], e.clientX, e.clientY, e.altKey);
      e.preventDefault();
      return;
    }
    /* INCREMENTAL, like the free widgets: the delta since the last move, not
       since the press. A dropped event then costs one frame of travel instead
       of replaying the whole gesture. */
    moveWidgetBy(ddrag.node, wdet[ddrag.k], e.clientX - ddrag.sx, e.clientY - ddrag.sy,
      { snap: true, opacity: 1 });
    ddrag.sx = e.clientX; ddrag.sy = e.clientY;
    e.preventDefault();
  }
  function onDetUp() {
    if (!ddrag) return;
    if (ddrag.node) ddrag.node.classList.remove('is-drag');
    ddrag = null;
    clearRectangleSnap();
    fwGuide().classList.remove('show');
    saveWidgetCfg();
  }
  let sawDetPointer = 0;
  document.addEventListener('pointerdown', function (e) {
    sawDetPointer = Date.now(); onDetDown(e);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (Date.now() - sawDetPointer < 500) return;
    e.pointerId = e.pointerId || 1;
    onDetDown(e);
  }, true);
  document.addEventListener('pointermove', onDetMove);
  document.addEventListener('mousemove', onDetMove);
  document.addEventListener('pointerup', onDetUp);
  document.addEventListener('mouseup', onDetUp);
  wdet.fwgrp = wgrp;   // same object: drag/wheel writes land in wgrp directly
  function grpEl(make) {
    let g = document.getElementById('hud-fw-grp');
    if (!g && make) {
      g = h('div', { class: 'hud-det hud-fw-grp', id: 'hud-fw-grp', 'data-det': 'fwgrp' });
      const freeRoot = document.getElementById('hud-free');
      if (freeRoot) freeRoot.appendChild(g);
    }
    return g;
  }
  function applyGroup() {
    const freeRoot = document.getElementById('hud-free');
    if (!freeRoot) return;
    if (wgrp.locked) {
      const g = grpEl(true);
      /* EVICT FIRST (2026-08-19): membership is editable now, so a widget the
         player just unlinked is still sitting inside the group's container
         with no placement of its own. Put it back on the free layer before
         the members are collected, or it would ride the group forever. */
      for (const k of FREE_KEYS) {
        const root = elFree[k];
        if (root && root.parentNode === g && !grpHas(k)) freeRoot.appendChild(root);
      }
      for (const k of grpKeys()) {
        const root = elFree[k];
        if (!root) continue;
        if (root.parentNode !== g) g.appendChild(root);
        /* the group owns placement; the member sits in flow */
        root.style.left = root.style.right = root.style.top = root.style.bottom = '';
        root.style.transform = ''; root.style.opacity = '';
      }
      /* vertical by default, horizontal on request — one class, no relayout
         maths of our own; the cards are fixed-width so a row of three is the
         same three cards turned sideways. */
      setClass(g, 'is-horiz', wgrp.orient === 'horiz');
      placeFree(g, wgrp);
      /* the group hides only when EVERY member is off — and never mid-edit */
      let anyOn = false;
      for (const k of grpKeys()) if (elFree[k] && !elFree[k].classList.contains('is-off')) anyOn = true;
      setClass(g, 'is-off', !anyOn && !editing);
      /* round 3: a group whose every member is switched off is drawn as ghosts
         while editing, so the WRAP wears the off dress and the members do not
         double it (they are nested inside it). */
      setClass(g, 'is-editoff', editing && !grpAnyOn());
      for (const k of grpKeys()) if (elFree[k]) setClass(elFree[k], 'is-editoff', editing && !grpAnyOn() ? false : (editing && !wcfg[k]));
      attachGrpTools(g);
    } else {
      const g = grpEl(false);
      if (g) {
        for (const k of FREE_KEYS) {
          const root = elFree[k];
          if (root && root.parentNode === g) freeRoot.appendChild(root);
        }
        g.remove();
      }
    }
  }

  /* ---- the group's own mini toolbar (2026-08-18) -------------------------
     Rober's play-test: "NO scaling options for this widget". The root cause is
     structural, not a missing button: scale lives on the .hud-fw-tools bar,
     that bar is attached to the SELECTED free widget, and a member of the
     locked group can never BE selected — `.hud-fw-grp .hud-fw` is
     pointer-events:none so the group drags as one. So the group gets the same
     bar, on the same class, driven by the same data-fwact attribute; there is
     no second toolbar idiom. It is always present in edit mode (there is only
     ever one group, so nothing has to be selected to disambiguate it). */
  function attachGrpTools(g) {
    /* direct-child scan, not `:scope >` — that selector is unproven in
       Ultralight and this runs on every tick */
    let bar = null;
    for (const c of g.children) if (c.classList && c.classList.contains('hud-fw-tools')) { bar = c; break; }
    if (!editing) { if (bar) bar.remove(); return; }
    if (bar) {
      /* keep the two stateful faces honest without rebuilding the bar */
      const o = bar.querySelector('[data-fwact="orient"]');
      if (o) {
        setText(o, wgrp.orient === 'horiz' ? '↔' : '↕');
        o.title = wgrp.orient === 'horiz'
          ? 'Horizontal — click for a vertical column'
          : 'Vertical — click for a horizontal row';
      }
      return;
    }
    const mk = (act, label, title) =>
      h('button', { class: 'hud-fw-tool', type: 'button', 'data-fwact': act, title: title }, label);
    const b = h('div', { class: 'hud-fw-tools' });
    b.appendChild(mk('anchor', '⤢', 'Cycle which screen corner or edge the group hangs from'));
    b.appendChild(mk('smaller', '−', 'Smaller — the whole group scales as one'));
    b.appendChild(mk('bigger', '＋', 'Bigger — the whole group scales as one'));
    b.appendChild(mk('orient', wgrp.orient === 'horiz' ? '↔' : '↕',
      wgrp.orient === 'horiz' ? 'Horizontal — click for a vertical column'
                              : 'Vertical — click for a horizontal row'));
    b.appendChild(mk('unlock', '⛓', 'Separate the members so each moves on its own'));
    b.appendChild(mk('cfg', '⚙', 'Open the widget shelf on this group — members, size, linking'));
    b.appendChild(mk('off', '✕', 'Hide every member (turn them back on in the ⚙ shelf)'));
    g.appendChild(b);
    /* a group dragged to the top edge would park its bar above the viewport —
       the free widgets' below-flip, kept */
    if (g.getBoundingClientRect().top < 44) b.classList.add('below');
  }

  /* Actions from a .hud-det wrap's toolbar. Floated stack blocks share the
     scale/anchor half; the rest is the group's. */
  function grpToolAct(k, act) {
    const d = wdet[k];
    if (!d) return;
    /* the shelf, opened on the thing whose toolbar was clicked */
    if (act === 'cfg') { setCfgOpen(true, k === 'fwgrp' ? 'fwgrp' : (KEY_OF_DET[k] || k)); return; }
    const node = k === 'fwgrp' ? grpEl(false) : detWrap(k, false);
    if (act === 'smaller' || act === 'bigger') {
      d.scale = clamp(num(d.scale, 1) + (act === 'bigger' ? 0.1 : -0.1), 0.5, 2.5);
      if (node) placeFree(node, { x: d.x, y: d.y, anchorH: d.anchorH, anchorV: d.anchorV,
        scale: d.scale, opacity: 1 });
    } else if (act === 'anchor') {
      /* the free widgets' anchor cycle, verbatim in spirit: rotate the anchor
         while PRESERVING the on-screen spot, so nothing jumps */
      if (!node) return;
      const r = node.getBoundingClientRect();
      const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
      let i = 0;
      for (let n = 0; n < FW_ANCHOR_CYCLE.length; n++)
        if (FW_ANCHOR_CYCLE[n][0] === d.anchorH && FW_ANCHOR_CYCLE[n][1] === d.anchorV) { i = n; break; }
      const nxt = FW_ANCHOR_CYCLE[(i + 1) % FW_ANCHOR_CYCLE.length];
      d.anchorH = nxt[0]; d.anchorV = nxt[1];
      const cx = r.left + r.width / 2;
      d.x = d.anchorH === 'right' ? Math.max(0, Math.round(vw - r.right)) :
            d.anchorH === 'center' ? Math.round(cx - vw / 2) :
            Math.max(0, Math.round(r.left));
      d.y = d.anchorV === 'bottom' ? Math.max(0, Math.round(vh - r.bottom)) : Math.max(0, Math.round(r.top));
      placeFree(node, { x: d.x, y: d.y, anchorH: d.anchorH, anchorV: d.anchorV,
        scale: num(d.scale, 1), opacity: 1 });
    } else if (act === 'orient' && k === 'fwgrp') {
      wgrp.orient = wgrp.orient === 'horiz' ? 'vert' : 'horiz';
      applyGroup();
      if (cfgOpen) buildSettings();
    } else if (act === 'unlock' && k === 'fwgrp') {
      wgrp.locked = false;
      applyGroup(); renderFree();
      if (cfgOpen) buildSettings();
    } else if (act === 'off') {
      if (k === 'fwgrp') grpSetMaster(false);
      else wdet[k].on = false;
      renderFree(); applyDetach(false);
      if (cfgOpen) buildSettings();
    }
    saveWidgetCfg();
  }
  /* wheel over any floated wrap in edit mode = scale it (0.5–2.5). This is
     the "scale separately" half of the spec. */
  let wheelSaveT = 0;
  document.addEventListener('wheel', function (e) {
    if (!editing) return;
    /* floated stack blocks AND the slot group share wdet; a SEPARATED slot
       widget scales through its own wfree entry ("when they are seperate i
       have no way of scaling individaul widgets", Rober 2026-08-18). One
       wheel, every widget. */
    const wrap = e.target && e.target.closest ? e.target.closest('.hud-det') : null;
    const fw = !wrap && e.target && e.target.closest ? e.target.closest('.hud-fw') : null;
    const k = wrap ? wrap.getAttribute('data-det') : fw ? fw.getAttribute('data-fw') : '';
    const d = wrap ? wdet[k] : fw ? wfree[k] : null;
    if (!d) return;
    if (fw && wgrp.locked && grpHas(k)) return;  /* group scales as one */
    e.preventDefault();
    d.scale = clamp(num(d.scale, 1) + (e.deltaY < 0 ? 0.05 : -0.05), 0.5, 2.5);
    placeFree(wrap || fw, { x: d.x, y: d.y, anchorH: d.anchorH, anchorV: d.anchorV,
      scale: d.scale, opacity: wrap ? 1 : num(d.opacity, 1) });
    clearTimeout(wheelSaveT);
    wheelSaveT = setTimeout(saveWidgetCfg, 400);
  }, { passive: false });

  /* ---- default split: every stack block its own widget --------------------
     (Rober: "The hud elements hsould be by default all their own. that you
     enable or toggle seperatly and move and scale seperetly.") Seeded ONCE
     per config: drawn blocks pop out at their measured spots, the rest join a
     ladder below, and from then on the stored placements rule. */
  let detSeeded = false;
  /* Per-KEY, deliberately — not the one detSeeded flag it replaces. A config
     written before a block existed has detSeeded:true and no entry for the new
     key, and the old global gate meant that block stayed welded into the stack
     for ever (which is exactly what would have happened to the five readout
     lines on every existing HUD). Presence of the key is the only honest test.
     detSeeded is still written for older builds reading the same blob. */
  function needsSeed() {
    for (const k of DET_KEYS) if (!wdet[k]) return true;
    return false;
  }
  /* Is there anything on screen to measure a seed against? One drawn block is
     enough — the rest of the stack sits in the same column, so one real rect
     anchors the whole seed. */
  function anyBlockDrawn() {
    for (const k of DET_KEYS) {
      const n = el[k];
      if (n && !n.classList.contains('is-off') && n.offsetHeight) return true;
    }
    return false;
  }
  /* One rung of the fallback ladder. Sized for a readout line inside a
     .hud-det wrap (22px glyph + 14px line padding + 20px wrap padding + air) —
     the old 46 was measured against a bare block and left the wraps overlapping
     each other by their own padding. */
  const LADDER_STEP = 58;
  /* A column of the fallback ladder. Wide enough for a readout wrap, so wrapping
     into the next column cannot land a rung on top of the one beside it. */
  const LADDER_COL = 300;
  /* The ladder used to march straight down for ever: fourteen rungs × 58 px from
     a y0 under the panel is ~870 px, so on a 720-line screen the last five
     blocks (survival · mount · pins · sets · allies) seeded BELOW THE BOTTOM OF
     THE SCREEN and the player could never find them — they simply did not exist
     (measured at 1280x720, Opus audit 2026-08-18). It wraps into a new column
     now, and every rung is clamped inside the viewport. */
  function ladderRunner(x0, y0) {
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    let cx = x0, cy = y0;
    return function () {
      if (cy + LADDER_STEP > vh - 16) {          // no room for another rung
        cx = cx + LADDER_COL;
        if (cx > Math.max(0, vw - 200)) cx = Math.max(0, vw - 200);
        cy = clamp(y0, 0, Math.max(0, vh - LADDER_STEP - 16));
      }
      const spot = { x: clamp(cx, 0, Math.max(0, vw - 120)), y: clamp(cy, 0, Math.max(0, vh - 40)) };
      cy += LADDER_STEP;
      return spot;
    };
  }
  function seedDetach() {
    let x0 = 60, y0 = 60;
    const first = el.widgets && el.widgets.getBoundingClientRect();
    if (first && first.width) { x0 = Math.max(0, Math.round(first.left)); y0 = Math.max(0, Math.round(first.top)); }
    else {
      /* The usual case at boot: nothing has data yet, so the stack has no size
         and every block takes the ladder. Start it BELOW the assembly — the
         stack is empty by then, so the follower strip is sitting exactly where
         the old "top of the stack" origin pointed, and a ladder started there
         drops straight onto the faces. */
      const pr = el.panel && el.panel.getBoundingClientRect ? el.panel.getBoundingClientRect() : null;
      if (pr && pr.width) { x0 = Math.max(0, Math.round(pr.left)); y0 = Math.max(0, Math.round(pr.bottom) + 14); }
    }
    let nextY = y0;
    const fresh = [];
    let rung = null;                     // built lazily: y0 can move as we measure
    for (const k of DET_KEYS) {
      if (wdet[k]) continue;
      fresh.push(k);
      const node = el[k];
      const drawn = node && !node.classList.contains('is-off') && node.parentNode;
      const r = drawn ? node.getBoundingClientRect() : null;
      if (r && r.width) {
        wdet[k] = { on: true, x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
          anchorH: 'left', anchorV: 'top', scale: 1 };
        nextY = Math.max(nextY, Math.round(r.bottom) + 14);
      } else {
        if (!rung) rung = ladderRunner(x0, nextY);
        const spot = rung();
        wdet[k] = { on: true, x: spot.x, y: spot.y, anchorH: 'left', anchorV: 'top', scale: 1 };
      }
    }
    detSeeded = true;
    applyDetach(false);
    declumpFresh(fresh);
    saveWidgetCfg();
  }
  /* A measured position is stale the instant it is used, for two reasons: the
     stack EMPTIES as its blocks leave it, so the follower strip rises into the
     space they were measured in; and every .hud-det wrap adds its own padding,
     so two blocks that sat 10px apart in the stack overlap by that padding once
     they float. Both were visible the moment the five readout lines became five
     widgets — a fresh Gold/Carry/Time ladder landed straight on the faces.

     So freshly seeded wraps are pushed DOWN until they are clear of the panel
     and of each other, once, right after they are placed. Only fresh keys are
     touched: a position the player dragged is sacred and is never second-
     guessed by an overlap rule. */
  function declumpFresh(fresh) {
    if (!fresh || !fresh.length) return;
    const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    const busy = [];    // hard: nothing may share these
    const soft = [];    // preferred-clear: honoured while there is room to
    const pr = el.panel && el.panel.getBoundingClientRect ? el.panel.getBoundingClientRect() : null;
    if (pr && pr.width) {
      busy.push(pr);
      /* The lane the edit chrome takes when Reposition opens: the toolbar
         (~40 px, above or flipped below) and the hint line under it. Neither
         exists while packing — both are display:none during play — so a pack
         that only knew the panel put widgets exactly where the toolbar was
         about to appear, and all six buttons landed on a readout the moment you
         went to move things (Opus audit, 2026-08-18). SOFT, because on a short
         screen reserving another 520x150 band is worth less than not stacking
         two widgets on each other. The bar is wider than a one-follower panel,
         hence the minimum width. */
      const TOOLS_H = 48, HINT_H = 56, TOOLS_W = 520;
      soft.push({ left: pr.left - 8, top: pr.top - TOOLS_H,
        right: Math.max(pr.right, pr.left + TOOLS_W) + 8, bottom: pr.bottom + TOOLS_H + HINT_H });
    }
    /* ⚠ The FREE widgets are blockers too. They are a separate placement system
       (wfree / wgrp, screen px of their own), so a stack block seeded at a
       measured spot happily landed straight on top of the locked hands+powers
       group — which sits at 28,220 by default, i.e. exactly where the ladder
       runs. The whole left column of the HUD came up unreadable on a config
       with the slot widgets on (Opus audit, 2026-08-18). */
    const freeRoot = document.getElementById('hud-free');
    if (freeRoot) {
      for (const w of freeRoot.children) {
        if (w.classList.contains('hud-det')) continue;          // handled below, per key
        if (w.id === 'hud-fw-guide' || w.classList.contains('is-off')) continue;
        const wr = w.getBoundingClientRect();
        if (wr.width && wr.height) busy.push(wr);
      }
      const g = document.getElementById('hud-fw-grp');
      if (g && !g.classList.contains('is-off')) {
        const gr = g.getBoundingClientRect();
        if (gr.width && gr.height) busy.push(gr);
      }
    }
    /* COLUMN PACKING, not a downward march. The old rule only ever pushed a
       clashing wrap DOWN — so on a screen with less room than blocks it walked
       them straight off the bottom edge, where they are not misplaced but GONE
       (five of fourteen, measured at 1280x720). Fresh wraps are packed into
       columns instead: keep a measured spot that is already clear and on
       screen, otherwise take the next free slot down the current column, and
       start a new column to the right when the current one is full. Bounded at
       every step, and only FRESH keys are ever moved — a placement the player
       dragged is still sacred. */
    const box = (x, y, r) => ({ left: x, top: y, right: x + r.width, bottom: y + r.height });
    const clear = (b) => { for (const o of busy) if (hits(b, o)) return false; return true; };
    const clearSoft = (b) => { if (!clear(b)) return false; for (const o of soft) if (hits(b, o)) return false; return true; };
    const onScreen = (b) => b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh;
    /* First fit on a coarse grid, column-major (down a column, then right) —
       the reading order the stack had, so a packed HUD still looks like a
       laid-out one. Coarse on purpose: 24x16 px steps make this a few thousand
       cheap rect tests that run ONCE per config, not per frame. */
    const STEP_X = 24, STEP_Y = 16, PAD = 12;
    function scan(r, test) {
      for (let x = PAD; x + r.width <= vw - PAD; x += STEP_X)
        for (let y = PAD; y + r.height <= vh - PAD; y += STEP_Y) {
          const cand = box(x, y, r);
          if (test(cand)) return cand;
        }
      return null;
    }
    /* Honour the soft reservation first; give it up rather than fail to place. */
    function findSlot(r) { return scan(r, clearSoft) || scan(r, clear); }
    const todo = [];
    for (const k of fresh) {
      const wrap = detWrap(k, false);
      const d = wdet[k];
      if (!wrap || !d || !wrap.getBoundingClientRect) continue;
      const r = wrap.getBoundingClientRect();
      if (!r.width) continue;               // not drawn right now — leave its seed alone
      const at = box(num(d.x, 0), num(d.y, 0), r);
      /* clearSoft, not clear: a measured spot INSIDE the edit-chrome lane is
         exactly the case this pass exists for — keeping it there is how the
         toolbar came down on the Time readout. */
      if (onScreen(at) && clearSoft(at)) { busy.push(at); continue; }
      todo.push({ wrap: wrap, d: d, r: r });
    }
    /* BIGGEST FIRST. Plain first-fit hands the early, small blocks the roomy
       slots and leaves the big ones nowhere to go; decreasing-first-fit is the
       textbook fix and it cut the residual collisions on a full 1280x720 by
       two thirds in measurement. */
    todo.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    for (const t of todo) {
      const d = t.d, r = t.r;
      /* No clear slot at all means the widgets genuinely outsize the screen. An
         overlap is then unavoidable — but landing ON SCREEN is not optional, so
         the fallback clamps rather than walking off the edge. */
      const spot = findSlot(r) ||
        box(clamp(Math.round(num(d.x, 0)), PAD, Math.max(PAD, vw - PAD - r.width)),
            clamp(Math.round(num(d.y, 0)), PAD, Math.max(PAD, vh - PAD - r.height)), r);
      d.x = Math.round(spot.left); d.y = Math.round(spot.top);
      placeFree(t.wrap, { x: d.x, y: d.y, anchorH: d.anchorH, anchorV: d.anchorV,
        scale: num(d.scale, 1), opacity: 1 });
      busy.push(box(d.x, d.y, r));
    }
  }

  /* harness hook — the float chips live behind edit mode + the ⚙ card, which
     a headless run cannot click through reliably */
  window.__hudDet = { float: floatBlock, on: detOn, seed: seedDetach, grp: wgrp, applyGroup: applyGroup,
    /* harness only: drop a stored placement so the seed path can be re-run */
    forget: function (k) { delete wdet[k]; }, needsSeed: needsSeed,
    /* the merged equipped widget — the harness drives master/orientation/size
       and the ONE drag path through the same functions the mouse does */
    get keys() { return grpKeys(); }, link: grpLink, master: grpSetMaster,
    anyOn: grpAnyOn, allOn: grpAllOn,
    tool: grpToolAct, moveBy: moveWidgetBy, snapRectangle, rectangleTargets, moveRectangleDrag, connectedRectangles, moveRectangleCluster,
    beginDrag:onDetDown, dragMove:onDetMove, endDrag:onDetUp, dragging: function () { return !!ddrag; } };

  /* Presets, so the whole thing can go minimal in ONE click and never becomes a
     settings maze (Rober's brief). "custom" is not a preset — it is what the
     card shows when the toggles no longer match any of these. */
  const PRESETS = {
    /* Full is everything the game is willing to say. RESIST is off even here:
       the six numbers barely move outside a gear change, so a permanent row of
       them is the one block that earns its place only when you go looking. */
    full: { on: 1, gold: 1, carry: 1, time: 1, context: 1, pots: 1, mount: 1, pins: 1, sets: 1,
      vitals: 1, resist: 0, effects: 1, equip: 1, survival: 1, allies: 1,
      pinLabels: 1, badges: 1, barNumbers: 1 },
    lean: { on: 1, gold: 1, carry: 1, time: 1, context: 1, pots: 1, mount: 1, pins: 1, sets: 0,
      vitals: 1, resist: 0, effects: 1, equip: 0, survival: 1, allies: 1,
      pinLabels: 0, badges: 1, barNumbers: 0 },
    minimal: { on: 1, gold: 1, carry: 1, time: 0, context: 0, pots: 0, mount: 0, pins: 0, sets: 0,
      vitals: 0, resist: 0, effects: 0, equip: 0, survival: 0, allies: 0,
      pinLabels: 0, badges: 0, barNumbers: 0 },
    off: { on: 0, gold: 0, carry: 0, time: 0, context: 0, pots: 0, mount: 0, pins: 0, sets: 0,
      vitals: 0, resist: 0, effects: 0, equip: 0, survival: 0, allies: 0,
      pinLabels: 0, badges: 0, barNumbers: 0 },
  };
  const PRESET_ORDER = [['full', 'Full'], ['lean', 'Lean'], ['minimal', 'Minimal'], ['off', 'Off']];

  function activePreset() {
    for (const id in PRESETS) {
      const def = PRESETS[id];   // for..in, not Object.entries — the ONE use of
                                 // that API in the whole view tree was here, on
                                 // the settings path; unproven in Ultralight.
      let hit = true;
      for (const k in def) if (!!wcfg[k] !== !!def[k]) { hit = false; break; }
      if (hit) return id;
    }
    return 'custom';
  }
  function applyPreset(id) {
    const def = PRESETS[id];
    if (!def) return;
    for (const k in def) wcfg[k] = !!def[k];
    applyWidgetCfg(); renderWidgets(); buildSettings(); saveWidgetCfg();
  }

  /* ======================================================================
     LIVE WIDGET DATA — the C++ feed. Every field optional, on purpose.
       gold      : number | -1 (unknown sentinel)
       carry     : {cur, max}
       time      : {text?, hour?, min?, day?, dayName?}
       weather   : {name, kind}
       place     : {name, kind}
       interior  : bool
       mount     : {name, health:{cur,max}, stamina:{cur,max}, carry?:{cur,max}, dead?}
       pins      : [{id, name, count, goal?, icon?, formId, plugin,
                     value?, enchant?, damage?, armor?, kind?}]
       sets      : [{id, name, have, goal, icon?, done?}]
     ====================================================================== */
  let live = {};

  /* ---------------------------------------------------------------------
     THE CONTRACT, in one place. src/widgets.cpp published the final shape on
     2026-08-17 and it does not match the defensive guess above field for
     field — so every incoming payload is normalised HERE, once, and the render
     code below keeps one vocabulary. Anything the DLL does not send stays
     undefined, and undefined is what makes a block disappear: absent NEVER
     means zero (the contract says so out loud, and a mount showing 0/0 is the
     exact lie this rule exists to prevent).

       gold        number, -1 = unreadable          -> gold
       carry       {cur,max}, -1 = unreadable       -> carry
       weather     {kind, edid}                     -> weather {kind, name}
       place       {name, type, interior, world}    -> place {name, kind} + interior
       time        {h,m,txt,h24,night,date,…}       -> time {hour,min,text,h24,night}
       mount       {name, riding, hp, sta, img}     -> mount {name, health, stamina, img}
       pins[]      {id,label,icon,n,missing}        -> pins[] {id,name,icon,count,missing}
       sets[]      {id,label,icon,n,goal,done,
                    questDone,missing}              -> sets[] {id,name,have,goal,done,hide}

     The optional badge numbers (value / enchant / damage / armor) are read if
     they ever appear but are NOT in the contract yet, so those badges simply do
     not draw today — payload-driven, so they light up the day C++ sends them
     with no view change. */
  function normPin(p, i) {
    if (!p || typeof p !== 'object') return null;
    const o = {
      id: p.id || p.formId || ('pin' + i),
      name: p.label != null ? String(p.label) : String(p.name || ''),
      icon: p.icon || '',
      missing: p.missing === true,
      formId: p.formId, plugin: p.plugin,
    };
    /* `missing` means one of the entry's forms did not resolve — that mod is
       off. The count would be a lie, so it is deliberately NOT carried over:
       the tile says "not loaded" instead of showing 0. */
    if (!o.missing) {
      const n = isNum(p.n) ? p.n : p.count;
      if (isNum(n)) o.count = n;
    }
    if (isNum(p.goal) && p.goal > 0) o.goal = p.goal;
    for (const k of ['value', 'enchant', 'damage', 'armor']) if (p[k] !== undefined) o[k] = p[k];
    return o;
  }
  function normSet(s, i) {
    if (!s || typeof s !== 'object') return null;
    return {
      id: s.id || ('set' + i),
      name: s.label != null ? String(s.label) : String(s.name || ''),
      icon: s.icon || '',
      have: isNum(s.n) ? s.n : (isNum(s.have) ? s.have : 0),
      goal: isNum(s.goal) ? s.goal : 0,
      done: !!s.done,
      missing: s.missing === true,
      /* HIDING a finished set is the view's call, and it is made on the QUEST
         flag, never on the count — finishing "No Stone Unturned" is precisely
         when the stones leave your bag, so a count rule would read 0/24 for
         ever (C++ reports questDone and deliberately does not act on it). */
      hide: s.questDone === true,
    };
  }
  function normLive(j) {
    if (!j || typeof j !== 'object') return {};
    const o = {};
    if (isNum(j.gold)) o.gold = j.gold;
    if (isNum(j.lockpicks)) o.lockpicks = j.lockpicks;
    if (j.carry && typeof j.carry === 'object') o.carry = { cur: j.carry.cur, max: j.carry.max };

    const w = j.weather;
    if (w && typeof w === 'object' && w.kind) {
      /* The contract ships a KIND, not a display string — so the label is the
         kind, title-cased. Deliberate: it stays honest for a kind we have never
         seen, and it never invents wording the game did not give us. */
      const k = String(w.kind);
      o.weather = { kind: k, name: w.name || (k.charAt(0).toUpperCase() + k.slice(1)) };
    }
    const p = j.place;
    if (p && typeof p === 'object') {
      o.place = { name: p.name || '', kind: p.type || p.kind || '' };
      if (typeof p.interior === 'boolean') o.interior = p.interior;
    }
    if (typeof j.interior === 'boolean' && typeof o.interior !== 'boolean') o.interior = j.interior;

    const t = j.time;
    if (t && typeof t === 'object') {
      o.time = {
        text: t.txt || t.text || '', h24: t.h24 || '',
        hour: isNum(t.h) ? t.h : t.hour, min: isNum(t.m) ? t.m : t.min,
        night: typeof t.night === 'boolean' ? t.night : undefined,
        date: typeof t.date === 'string' ? t.date : '',
        day: t.day, month: t.month, monthName: t.monthName, year: t.year,
      };
    }
    const m = j.mount;
    /* `riding:false` with a remembered horse is still a mount worth showing —
       C++ can be told to follow "lastRidden". An absent mount object is the
       only thing that removes the block. */
    if (m && typeof m === 'object' && (m.name || m.hp || m.health)) {
      o.mount = {
        name: m.name || '', img: m.img || '',
        health: m.hp || m.health, stamina: m.sta || m.stamina, carry: m.carry,
        riding: m.riding !== false,
        dead: !!m.dead || (m.hp && isNum(m.hp.cur) && m.hp.cur <= 0),
      };
    }
    if (Array.isArray(j.pins)) o.pins = j.pins.map(normPin).filter(Boolean);
    if (Array.isArray(j.sets)) o.sets = j.sets.map(normSet).filter(Boolean);

    /* ---- round 2 (2026-08-17): the player's own state -------------------
       Same law as everything above — a key the DLL did not send stays
       undefined, and undefined is what removes the block. Nothing here
       invents a zero, because every one of these numbers is a number you
       would act on: a fake 0 magicka or a fake 0% fire resist is worse than
       no widget at all. */
    const vt = j.vitals;
    if (vt && typeof vt === 'object' && (vt.hp || vt.mag || vt.sta || isNum(vt.lvl))) {
      o.vitals = {
        hp: pool2(vt.hp), mag: pool2(vt.mag), sta: pool2(vt.sta),
        lvl: isNum(vt.lvl) ? vt.lvl : (isNum(vt.level) ? vt.level : null),
        xp: pool2(vt.xp),
        combat: vt.combat === true,
      };
      /* The shout timer is ABSENT while the voice is ready — the one state the
         widget must not draw as "0s left", which reads as a stuck cooldown. */
      const sh = vt.shout;
      if (sh && typeof sh === 'object' && isNum(sh.rem) && sh.rem > 0)
        o.vitals.shout = { rem: sh.rem, dur: isNum(sh.dur) && sh.dur > 0 ? sh.dur : sh.rem };
    }
    if (Array.isArray(j.effects)) o.effects = j.effects.map(normFx).filter(Boolean);
    if (Array.isArray(j.equip)) o.equip = j.equip.map(normEq).filter(Boolean);
    if (Array.isArray(j.quick)) o.quick = j.quick.map(normQuick).filter(Boolean);
    if (Array.isArray(j.quick2)) o.quick2 = j.quick2.map(normQuick2).filter(Boolean);
    /* The loot lamp's two masters. Absent = main.cpp installed no provider, and
       the widget then draws NOTHING rather than two lamps stuck at off — the
       same "absent is not zero" law the rest of this payload obeys. */
    const ls = j.lootstate || j.lootState;
    if (ls && typeof ls === 'object' && (typeof ls.glow === 'boolean' || typeof ls.auto === 'boolean'))
      o.lootstate = { glow: ls.glow === true, auto: ls.auto === true };
    /* ⚠ POTION POOLS. widgets.cpp ships `potions:{heal:{n,best?}, magicka:…,
       all:<number>}` plus a `waterOk` flag — and this function used to drop BOTH
       on the floor, so `live.potions` was permanently undefined, `havePots()`
       permanently false, and the Potions readout could NEVER draw no matter what
       the game sent (its ⚙ switch sat greyed as "nothing to show" for ever).
       Found by pushing the real payload at the view, Opus audit 2026-08-18.
       Shape is PRESERVED rather than flattened: `all` arrives as a bare number
       and potCount() reads both dialects. */
    if (j.potions && typeof j.potions === 'object') {
      const pots = {};
      for (const k in j.potions) {
        const v = j.potions[k];
        if (isNum(v)) pots[k] = v;
        else if (v && typeof v === 'object' && (isNum(v.n) || typeof v.best === 'string')) {
          const e = {};
          if (isNum(v.n)) e.n = v.n;
          if (typeof v.best === 'string' && v.best) e.best = v.best;
          pots[k] = e;
        }
      }
      o.potions = pots;
    }
    /* No water mod in the load order ⇒ the Water chip is hidden honestly
       (potPools reads this); absent means "nobody said", which is not false. */
    if (typeof j.waterOk === 'boolean') o.waterOk = j.waterOk;

    /* ---- ward (2026-09-01): up/down, strength, and the best known ward.
       The key is ABSENT when the player knows no ward and none is active —
       the widget then hides in play and ghosts in edit, same as an empty
       hand. `on` comes off the engine's WardPower actor value, so a ward
       cast by hand lights it exactly like the maintained one. */
    const wa = j.ward;
    if (wa && typeof wa === 'object') {
      o.ward = {
        on: wa.on === true, maint: wa.maint === true,
        name: String(wa.name || 'Ward'),
        plugin: wa.plugin || '', formId: wa.formId || '',
        school: wa.school || '', element: wa.element || '', tier: wa.tier || '',
      };
      if (isNum(wa.power)) o.ward.power = wa.power;
    }

    const rs = j.resist;
    if (rs && typeof rs === 'object') {
      o.resist = { capMagic: num(rs.capMagic, 85), capPhys: num(rs.capPhys, 80),
        pieces: isNum(rs.pieces) ? rs.pieces : null };
      for (const k of RESIST_ROWS) if (isNum(rs[k[0]])) o.resist[k[0]] = rs[k[0]];
      /* armor is the raw rating; phys is what that rating actually STOPS, which
         C++ has already run through Skyrim's own formula and cap. Both ride the
         one armour chip — the rating as the number, the reduction as its bar. */
      if (isNum(rs.armor)) o.resist.armor = rs.armor;
      if (isNum(rs.phys)) o.resist.phys = rs.phys;
    }
    const sv = j.survival;
    if (sv && typeof sv === 'object' && sv.present !== false) {
      const meters = Array.isArray(sv.meters) ? sv.meters : [];
      o.survival = {
        mod: String(sv.mod || 'Survival'),
        /* `on:false` = the mod is installed but its own MCM switch is off. The
           block still draws, greyed and labelled — silently vanishing would
           read as our bug rather than the player's setting. */
        on: sv.on !== false && sv.enabled !== false,
        nearHeat: sv.nearHeat === true,
        freezing: sv.freezing === true || sv.inFreezingWater === true,
        ambient: isNum(sv.ambient) ? sv.ambient : null,
        meters: meters.map(function (m, i) {
          if (!m || typeof m !== 'object') return null;
          const v = isNum(m.v) ? m.v : m.value;
          if (!isNum(v)) return null;
          return { id: String(m.id || ('need' + i)), label: String(m.label || m.id || '—'),
            v: v, max: isNum(m.max) && m.max > 0 ? m.max : null, off: m.off === true,
            state: typeof m.state === 'string' ? m.state : '',
            level: Number.isInteger(m.level) && m.level >= 0 && m.level <= 4 ? m.level : null };
        }).filter(Boolean),
      };
      if (!o.survival.meters.length) delete o.survival;
    }
    if (Array.isArray(j.allies)) {
      o.allies = j.allies.map(function (a, i) {
        if (!a || typeof a !== 'object') return null;
        return { id: String(a.id || a.formId || ('ally' + i)), name: String(a.name || 'Ally'),
          hp: pool2(a.hp), dead: a.dead === true };
      }).filter(Boolean);
    }

    /* ---- 2026-08-31: the season ----------------------------------------
       The id is checked against the CLOSED set the contract publishes, not
       merely for being a string: the id picks a glyph and a colour, so an
       unknown one would paint a blank card. A payload we cannot name leaves
       `season` undefined and the widget stays away — the same omit rule the
       DLL already applied on its side. */
    const sn = j.season;
    if (sn && typeof sn === 'object' && SEASON_ART[String(sn.id || '')]) {
      const id = String(sn.id);
      o.season = {
        id: id,
        name: sn.name || (id.charAt(0).toUpperCase() + id.slice(1)),
        src: sn.src === 'calendar' ? 'calendar' : 'mod',
        monthName: sn.monthName ? String(sn.monthName) : '',
        day: isNum(sn.day) ? sn.day : null,
        fixed: sn.fixed === true,
        override: sn.override === true,
        overrideName: sn.overrideName ? String(sn.overrideName) : '',
      };
      const nx = sn.next;
      if (nx && typeof nx === 'object' && nx.name && isNum(nx.in))
        o.season.next = { id: String(nx.id || ''), name: String(nx.name), in: nx.in };
    }
    return o;
  }
  /* A {cur,max} pair, or null. -1 is the contract's "could not read it"
     sentinel and is preserved so the view can print "?" rather than a lie. */
  function pool2(p) {
    if (!p || typeof p !== 'object') return null;
    if (!isNum(p.cur) && !isNum(p.max)) return null;
    return { cur: isNum(p.cur) ? p.cur : null, max: isNum(p.max) ? p.max : null };
  }
  /* Effect groups are the CHAR SHEET's vocabulary, unchanged (char_sheet.cpp
     EffectGroup): buff | debuff | disease | poison | constant, decided off the
     source record's spell type and the detrimental flag — never off the English
     name. Anything unrecognised falls back to "buff" so a future group still
     draws something rather than vanishing. */
  const FX_GROUPS = { buff: 1, debuff: 1, disease: 1, poison: 1, constant: 1 };
  function normFx(e, i) {
    if (!e || typeof e !== 'object') return null;
    const name = String(e.name || '');
    if (!name) return null;
    const g = String(e.group || '').toLowerCase();
    const rem = isNum(e.rem) ? e.rem : e.remainSec;
    const dur = isNum(e.dur) ? e.dur : e.durSec;
    return {
      key: String(e.key || e.id || ('fx' + i)),
      name: name,
      group: FX_GROUPS[g] ? g : 'buff',
      av: String(e.av || ''),
      /* dur <= 0 is the engine's own "no timer" — an ability, a racial power, a
         permanent enchantment. It is NOT zero seconds left. */
      rem: isNum(rem) && isNum(dur) && dur > 0 ? Math.max(0, rem) : null,
      dur: isNum(dur) && dur > 0 ? dur : null,
      mag: isNum(e.mag) ? e.mag : (isNum(e.magnitude) ? e.magnitude : null),
      hidden: e.hidden === true,
    };
  }
  /* shout / power / lesser joined in round 3 — the voice slot's kinds. They
     resolve art through the SPELL ladder (hudIconIndex), never the mesh
     renderer, and the voice row alone may carry a cd:{rem,dur}. */
  const EQ_KINDS = { weapon: 1, shield: 1, spell: 1, ammo: 1, other: 1, empty: 1,
    shout: 1, power: 1, lesser: 1 };
  function normEq(t, i) {
    if (!t || typeof t !== 'object') return null;
    const kind = String(t.kind || '').toLowerCase();
    const o = {
      slot: String(t.slot || ('eq' + i)),
      label: String(t.label || ''),
      kind: EQ_KINDS[kind] ? kind : 'other',
      name: String(t.name || ''),
      formId: t.formId, plugin: t.plugin,
      badges: Array.isArray(t.badges) ? t.badges.slice(0, 3) : [],
    };
    for (const k of ['damage', 'armor', 'count']) if (isNum(t[k])) o[k] = t[k];
    if (t.ranged === true) o.ranged = true;
    /* the spell-icon resolver's inputs, carried verbatim when present */
    for (const k of ['school', 'element', 'tier']) if (typeof t[k] === 'string') o[k] = t[k];
    const cd = t.cd;
    if (cd && typeof cd === 'object' && isNum(cd.rem) && cd.rem > 0)
      o.cd = { rem: cd.rem, dur: isNum(cd.dur) && cd.dur > 0 ? cd.dur : cd.rem };
    if (!o.name) o.kind = 'empty';
    return o;
  }
  /* one quick-item row (round 3): a favourited inventory entry with a live
     count and maybe the vanilla hotkey digit. `missing` has no meaning here —
     favourites are read fresh off the bag every walk. */
  function normQuick(q, i) {
    if (!q || typeof q !== 'object') return null;
    const name = String(q.name || '');
    if (!name) return null;
    return {
      id: String(q.id || q.formId || ('qk' + i)),
      name: name,
      kind: String(q.kind || 'misc'),
      count: isNum(q.count) ? q.count : null,
      hk: isNum(q.hk) && q.hk >= 1 && q.hk <= 8 ? q.hk : null,
      formId: q.formId, plugin: q.plugin,
    };
  }
  /* one CUSTOM quick-item row (round 4). Unlike the favourites twin above,
     `missing` DOES have a meaning here: the row is a stored plugin+formId, so
     the mod that adds it can be switched off. The count would be a lie then, so
     it is dropped and the tile says "mod off" instead of reading as "you ran
     out" — the pins' rule, verbatim. `hk` is a LABEL string here (the bound
     key's pretty name), not a vanilla 1-8 digit. */
  function normQuick2(q, i) {
    if (!q || typeof q !== 'object') return null;
    const o = {
      id: String(q.id || ((q.plugin || '') + '|' + (q.formId || i))),
      name: String(q.name || ''),
      kind: String(q.kind || 'misc'),
      missing: q.missing === true,
      hk: q.hk == null ? '' : String(q.hk),
      formId: q.formId, plugin: q.plugin,
      count: null,
    };
    if (!o.name) return null;
    if (!o.missing && isNum(q.count)) o.count = q.count;
    return o;
  }

  /* ---------------------------------------------------------- readouts ---- */
  /* Structural signature = which lines are drawn + the context ICON identity.
     The NUMBERS are never in the signature: they change every tick and must be
     written in place, or this becomes the Action-Bar churn bug again. */
  function ctxKind() {
    const inside = !!live.interior;
    if (inside) {
      const p = live.place || {};
      return 'p:' + (PLACE_ALIAS[String(p.kind || '').toLowerCase().replace(/[\s-]+/g, '_')] || 'house');
    }
    const w = live.weather || {};
    return 'w:' + (WEATHER_ALIAS[String(w.kind || '').toLowerCase()] || 'cloudy');
  }
  function ctxText() {
    if (live.interior) {
      const p = live.place || {};
      return String(p.name || 'Indoors');
    }
    const w = live.weather || {};
    /* Outdoors we lead with the weather (that is the reference's call and it is
       right — outside, the sky is the thing you cannot see on the compass), but
       if the game gave us no weather at all a place name still beats nothing. */
    return String(w.name || (live.place && live.place.name) || '');
  }

  function haveGold() { return isNum(live.gold); }
  function haveCarry() { return !!(live.carry && (isNum(live.carry.cur) || isNum(live.carry.max))); }
  function haveTime() { return !!(live.time && (live.time.text || live.time.h24 || isNum(live.time.hour))); }
  function haveCtx() { return !!(live.weather || live.place || typeof live.interior === 'boolean'); }

  function timeText() {
    const t = live.time || {};
    /* C++ already formatted both strings (contract: txt is the 12-hour form the
       screenshot shows, h24 the other). Do NOT re-derive them — a second
       formatter is a second answer. The hour/min fallback below is only for a
       payload that omits them. */
    if (wcfg.clock24 && t.h24) return String(t.h24);
    if (!wcfg.clock24 && t.text) return String(t.text);
    if (t.text) return String(t.text);
    if (!isNum(t.hour)) return '';
    const m = isNum(t.min) ? Math.floor(t.min) : 0;
    const mm = (m < 10 ? '0' : '') + m;
    let hr = Math.floor(t.hour) % 24; if (hr < 0) hr += 24;
    if (wcfg.clock24) return (hr < 10 ? '0' : '') + hr + ':' + mm;
    const ap = hr < 12 ? 'AM' : 'PM';
    let h12 = hr % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + mm + ' ' + ap;
  }
  /* The sun/moon glyph switch. C++ owns the verdict (`time.night`); the hour
     window is only the fallback for a payload that did not send it. */
  function isNight() {
    const t = live.time || {};
    if (typeof t.night === 'boolean') return t.night;
    let hr = isNum(t.hour) ? Math.floor(t.hour) % 24 : 12;
    if (hr < 0) hr += 24;
    return hr < 6 || hr >= 19;
  }

  let roSig = '';
  /* Potion pools — the compact rebuild of the retired hotbar-view bar
     (2026-08-18, Rober: "basically garbage… really wide for no reason").
     One chip per pool THE PAYLOAD CARRIES (C++ sends only enabled pools):
     a coloured typographic mark or a gold-glyph PNG, and the live count.
     No colour emoji — the 2026-08-16 icon law. */
  const POT_POOLS = [
    ['heal',    '\u2665', '#e06a55', 'Healing potions', ''],
    ['magicka', '\u2726', '#7d99e8', 'Magicka potions', ''],
    ['stamina', '\u27b6', '#7fca7a', 'Stamina potions', ''],
    ['cure',    '\u271a', '#e8d27a', 'Cures', ''],
    ['all',     '\u03a3', '#cfc7b8', 'All potions', ''],
    ['poison',  '\u2620', '#9fae62', 'Poisons', ''],
    ['food',    '\u25a4', '#d8b980', 'Food', 'ps-food'],
    ['drink',   '\u25d2', '#c89a5e', 'Drinks', 'ps-drink'],
    ['water',   '\u25cd', '#8fb7d8', 'Water (drinks that quench)', 'ps-water'],
  ];
  function potPools() {
    const p = live.potions;
    if (!p || typeof p !== 'object') return [];
    return POT_POOLS.filter(function (d) {
      if (d[0] === 'water' && live.waterOk === false) return false;
      return p[d[0]] !== undefined;
    });
  }
  function havePots() { return potPools().length > 0; }
  function potCount(k) {
    const p = (live.potions || {})[k];
    if (isNum(p)) return p;                      // `all` arrives as a bare number
    if (p && typeof p === 'object' && isNum(p.n)) return p.n;
    return null;
  }

  /* ---- one line = one widget (2026-08-18) --------------------------------
     Rober, pointing at the gold · carry · time · place · Potions bar: "every
     one of these widgets should be movable and seperate too by default". So
     each LINE_KEY now owns its own element (#hud-ro-gold …), which makes it a
     DET key like every other block — same drag, same wheel-scale, same ⚙
     toggle, no new machinery. The old shared #hud-readouts row is kept in the
     DOM and kept EMPTY, purely so nothing can null-deref it.

     RO_DET maps the config key (which is what ⚙ and C++ speak) onto the el /
     wdet key; RO_ROW maps it onto the `data-ro` dialect the chip builder and
     the volatile pass have always used, which is why neither of them changed. */
  const RO_DET = { lockpicks:'roLockpicks', weatherOnly:'roWeather', gold: 'roGold', carry: 'roCarry', time: 'roTime', context: 'roContext', pots: 'roPots' };
  const RO_ROW = { lockpicks:'lockpicks', weatherOnly:'weatherOnly', gold: 'gold', carry: 'carry', time: 'time', context: 'ctx', pots: 'pots' };
  const roSigs = {};
  function haveLine(key) {
    if (key === 'lockpicks') return isNum(live.lockpicks);
    if (key === 'weatherOnly') return !!live.weather || live.interior === true;
    if (key === 'gold') return haveGold();
    if (key === 'carry') return haveCarry();
    if (key === 'time') return haveTime();
    if (key === 'context') return haveCtx();
    return havePots();
  }
  /* The structural signature of ONE line. The time glyph flips sun/moon by the
     hour and the context glyph flips with the weather or the room you walked
     into, and the potion CHIP SET changes with the pools the payload carries —
     those are the only reasons a line ever needs rebuilding. The numbers never
     appear here; they are written in place below. */
  function roSigFor(key) {
    if (key === 'weatherOnly') return 'weather|' + (live.interior ? 'inside' : (live.weather || {}).kind) + '|' + isNight();
    if (key === 'time') return 'time|' + (isNight() ? 'n' : 'd') + '|' + !!wcfg.ornateClock;
    if (key === 'context') return 'ctx|' + ctxKind() + '|' + (isNight() ? 'n' : 'd');
    if (key === 'pots') return 'pots|' + potPools().map(function (d) { return d[0]; }).join(',');
    return key;
  }
  function buildRoRow(id) {
    const night = isNight();
    const row = h('span', { class: 'hud-ro' + (id === 'ctx' ? ' hud-ctx' : ''), 'data-ro': id });
    let art, painted = '';
    if (id === 'gold') { art = READOUT_ART.gold; painted = PAINTED.ro.gold; }
    else if (id === 'carry') { art = READOUT_ART.carry; painted = PAINTED.ro.carry; }
    else if (id === 'time') { art = night ? READOUT_ART.moon : READOUT_ART.sun; }
    else if (id === 'lockpicks') { painted = 'wg-lockpick'; }
    else if (id === 'weatherOnly') {
      const k = weatherKind((live.weather || {}).kind);
      // One vector symbol, not a transparent moon laid over a sun fallback.
      // Vector strokes stay crisp when the player scales this compact tile.
      art = live.interior ? PLACE_ART.house : (k === 'clear' && night ? READOUT_ART.moon : WEATHER_ART[k]);
      row.setAttribute('data-weather-icon', live.interior ? 'indoors' : k === 'clear' && night ? 'clear-night' : k);
    }
    else if (ctxKind()[0] === 'p') {
      const k = placeKind((live.place || {}).kind, true);
      art = PLACE_ART[k]; painted = PAINTED.loc[k] || '';
    } else {
      const k = weatherKind((live.weather || {}).kind);
      art = k === 'clear' && night ? READOUT_ART.moon : WEATHER_ART[k];
      row.setAttribute('data-weather-icon', k === 'clear' && night ? 'clear-night' : k);
    }
    if (id === 'pots') {
      /* Multi-chip row: [mark|png] count, per pool the payload carries.
         Counts are volatile; the CHIP SET is structural (in the sig). */
      row.classList.add('hud-ro-pots');
      const pools = potPools();
      if (!pools.length) {
        row.appendChild(h('i', { class: 'hud-pot-ghost' }, 'Potions'));
      }
      for (const d of pools) {
        const chip = h('span', { class: 'hud-pot', 'data-pot': d[0], title: d[3] });
        const mark = h('i', { class: 'hud-pot-m' }, d[1]);
        mark.style.color = d[2];
        chip.appendChild(mark);
        if (d[4]) {
          const img = document.createElement('img');
          img.className = 'hud-pot-img';
          img.alt = ''; img.draggable = false;
          img.width = 18; img.height = 18;
          img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); mark.style.display = ''; };
          img.src = 'icons/custom/' + d[4] + '.png';
          mark.style.display = 'none';
          chip.appendChild(img);
        }
        chip.appendChild(h('b', { class: 'hud-pot-n' }));
        row.appendChild(chip);
      }
      return row;
    }
    if (id === 'lockpicks') {
      // Transparent lockpick art must not sit on top of the gold-coins fallback.
      const glyph = h('span', { class: 'hud-ro-ico' });
      const img = document.createElement('img');
      img.className = 'hud-glyph-img'; img.alt = 'Lockpicks'; img.draggable = false;
      img.width = 22; img.height = 22;
      img.onerror = function () { glyph.textContent = '?'; };
      img.src = 'icons/custom/' + painted + '.png';
      glyph.appendChild(img); row.appendChild(glyph);
    } else row.appendChild(glyphBox('hud-ro-ico', art, painted, 22));
    const value = h('b', { class: 'hud-ro-v' });
    if (id === 'weatherOnly') value.appendChild(h('span', { class: 'hud-weather-label' }));
    row.appendChild(value);
    if (id === 'time' && wcfg.ornateClock) buildOrnateClock(row);
    return row;
  }

  /* Aether clock: open engraved flourishes, using the existing sun/moon glyphs.
     The 24-hour pointer is game time, not an invented moon-phase/weather reading.
     Geometry is vector-native so scaling stays crisp in Ultralight. */
  function buildOrnateClock(row) {
    row.classList.add('hud-aether-clock');
    const ornament = h('span', {class:'hud-aether-engraving', 'aria-hidden':'true'});
    let ticks = '';
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24 * Math.PI * 2) - Math.PI / 2;
      const a = i % 3 === 0 ? 42 : 46, b = 50;
      ticks += '<path d="M' + (160 + Math.cos(angle)*a).toFixed(2) + ' ' +
        (60 + Math.sin(angle)*a).toFixed(2) + 'L' + (160 + Math.cos(angle)*b).toFixed(2) +
        ' ' + (60 + Math.sin(angle)*b).toFixed(2) + '"/>';
    }
    ornament.innerHTML = '<svg viewBox="0 0 320 184" xmlns="http://www.w3.org/2000/svg" fill="none">' +
      '<g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">' + ticks +
      '<path d="M119 28 A52 52 0 0 1 201 28 M112 82 A52 52 0 0 0 128 102 M192 102 A52 52 0 0 0 208 82"/>' +
      '<path d="M8 95 Q34 69 66 87 Q91 102 106 74 M14 99 Q39 82 61 95 Q88 113 104 92 M28 80 Q50 55 77 78 Q93 94 105 64 M63 76 Q51 62 64 60 Q76 61 72 70 M30 96 Q47 113 58 99 M102 52 L110 60 L102 68 L94 60 Z"/>' +
      '<path d="M312 95 Q286 69 254 87 Q229 102 214 74 M306 99 Q281 82 259 95 Q232 113 216 92 M292 80 Q270 55 243 78 Q227 94 215 64 M257 76 Q269 62 256 60 Q244 61 248 70 M290 96 Q273 113 262 99 M218 52 L226 60 L218 68 L210 60 Z"/>' +
      '<path d="M66 170 Q100 163 122 170 M198 170 Q220 163 254 170 M148 174 L160 180 L172 174 M160 3 L164 9 L160 15 L156 9 Z"/>' +
      '</g><g class="hud-aether-pointer"><path d="M160 16 L164 23 L160 21 L156 23 Z" fill="currentColor"/></g></svg>';
    row.insertBefore(ornament, row.firstChild);
    row.appendChild(h('span', {class:'hud-aether-phase'}));
    row.appendChild(h('span', {class:'hud-aether-date'}));
  }
  function paintOrnateClock(row) {
    if (!row.classList.contains('hud-aether-clock')) return;
    const t = live.time || {}, hour = num(t.hour, 0) + num(t.min, 0) / 60;
    const phase = !isNum(t.hour) ? 'Awaiting time' : hour < 5 ? 'Deep night' : hour < 8 ? 'Dawn' :
      hour < 12 ? 'Morning' : hour < 14 ? 'High sun' : hour < 18 ? 'Afternoon' : hour < 21 ? 'Dusk' : 'Night';
    setText(row.querySelector('.hud-aether-phase'), phase);
    setText(row.querySelector('.hud-aether-date'), wcfg.clockDate && haveTime() ? String(t.date || '') : '');
    const needle = row.querySelector('.hud-aether-pointer');
    if (needle) { needle.style.visibility = isNum(t.hour) ? 'visible' : 'hidden'; needle.setAttribute('transform', 'rotate(' + ((hour % 24) * 15).toFixed(2) + ' 160 60)'); }
    setClass(row, 'is-night', isNight());
    setClass(row, 'is-animated', !!wcfg.clockMotion && haveTime());
  }

  function renderReadouts() {
    /* The retired shared row. Emptied once and left alone — it is DOM
       compatibility, not a widget, so it never draws and never wins a toggle. */
    if (el.readouts.firstChild) el.readouts.innerHTML = '';
    setClass(el.readouts, 'is-off', true);
    roSig = '';
    for (const key of LINE_KEYS) {
      const host = el[RO_DET[key]];
      if (!host) continue;
      const want = blockWant(key, haveLine(key));
      setClass(host, 'is-off', !want);
      setClass(host, 'is-editoff', blockGhosted(key));
      if (!want) { roSigs[key] = ''; host.innerHTML = ''; continue; }
      const sig = roSigFor(key);
      if (sig !== roSigs[key]) {
        roSigs[key] = sig;
        host.innerHTML = '';
        host.appendChild(buildRoRow(RO_ROW[key]));
      }
      paintRoRow(host.firstChild);
    }
  }

  /* --- volatile pass: text + state classes only, never a new element --- */
  function paintRoRow(row) {
    if (!row || !row.getAttribute) return;
      const id = row.getAttribute('data-ro');
      const v = row.querySelector('.hud-ro-v');
      if (id === 'lockpicks') {
        const n = live.lockpicks;
        setText(v, !isNum(n) || n < 0 ? '?' : comma(n));
        setClass(row, 'is-unknown', !isNum(n) || n < 0);
        row.title = 'Lockpicks';
      } else if (id === 'weatherOnly') {
        setClass(v, 'is-centered', !!wcfg.weatherCenter);
        const label = live.interior ? 'Indoors' : (live.weather || {}).name || '—';
        const text = v.querySelector('.hud-weather-label');
        setText(text, label); row.title = label;
        // Measure layout pixels, independent of the user's widget scale. Keep
        // the same nodes/animation across live ticks; only long labels move.
        const travel = v.clientWidth > 0 ? Math.max(0, text.scrollWidth - v.clientWidth) : 0;
        const distance = -travel + 'px';
        if (text.style.getPropertyValue('--hud-weather-travel') !== distance) {
          text.style.setProperty('--hud-weather-travel', distance);
          text.style.setProperty('--hud-weather-duration', Math.max(6, travel / 18 + 4) + 's');
        }
        setClass(v, 'is-scrolling', travel > 1);
      } else if (id === 'gold') {
        const g = live.gold;
        const unknown = !isNum(g) || g < 0;
        setClass(row, 'is-unknown', unknown);
        setText(v, unknown ? '?' : comma(g));
        if (!row.title) row.title = 'Gold';
      } else if (id === 'carry') {
        const c = live.carry || {};
        /* -1 is the contract's "could not read it" sentinel, exactly like gold.
           An honest "?" beats a confident 0 that would look like an empty pack. */
        const cur = isNum(c.cur) && c.cur >= 0 ? c.cur : null;
        const max = isNum(c.max) && c.max >= 0 ? c.max : null;
        setClass(row, 'is-unknown', !isNum(cur));
        setClass(row, 'is-over', isNum(cur) && isNum(max) && cur > max);
        v.innerHTML = '';
        v.appendChild(document.createTextNode(isNum(cur) ? comma(cur) : '?'));
        if (isNum(max)) v.appendChild(h('i', null, ' / ' + comma(max)));
      } else if (id === 'pots') {
        for (const chip of row.children) {
          const k = chip.getAttribute && chip.getAttribute('data-pot');
          if (!k) continue;
          const n = potCount(k);
          const nEl = chip.querySelector('.hud-pot-n');
          if (nEl) setText(nEl, n == null ? '—' : comma(n));
          setClass(chip, 'is-zero', n === 0);
          const pool = (live.potions || {})[k];
          const best = pool && typeof pool === 'object' && pool.best ? ' — best: ' + pool.best : '';
          const full = (POT_POOLS.filter(function (d) { return d[0] === k; })[0] || [])[3] + best;
          if (chip.title !== full) chip.title = full;
        }
        return;
      } else if (id === 'time') {
        setText(v, timeText() || '—');
        paintOrnateClock(row);
      } else {
        const txt = ctxText();
        setText(v, txt || (editing ? 'Weather / place' : '—'));
        if (v.title !== txt) v.title = txt;
      }
      /* .hud-ro-v ellipsizes, so every readout carries its full value as a
         tooltip — a number clipped to "612 / 4…" with nothing to hover is a
         readout that lies. (The context slot sets its own title just above;
         this is the catch-all for the numeric ones.) */
      if (v && id !== 'ctx') {
        const full = v.textContent || '';
        if (v.title !== full) v.title = full;   // compare first: these tick every frame
      }
  }

  /* ------------------------------------------------------------- mount ---- */
  /* No mount ⇒ NOTHING is drawn. An empty bar labelled 0/0 would read as a
     broken widget, and Rober asked for it to be honest. In EDIT mode a dashed
     ghost stands in, so the block can be placed before you ever mount. */
  let mountSig = '';
  function renderMount() {
    const m = live.mount;
    const has = !!(m && (m.name || m.health || m.stamina));
    const want = blockWant('mount', has);
    setClass(el.mount, 'is-off', !want);
    setClass(el.mount, 'is-editoff', blockGhosted('mount'));
    if (!want) { mountSig = ''; el.mount.innerHTML = ''; return; }

    const bars = [];
    if (!has) bars.push('ghost');
    else {
      if (m.health) bars.push('hp');
      if (m.stamina) bars.push('sp');
      if (m.carry) bars.push('wt');
    }
    const sig = bars.join(',') + '|' + safePath((m && m.img) || '');
    if (sig !== mountSig) {
      mountSig = sig;
      el.mount.innerHTML = '';
      /* mount.img is a render C++ already baked for THIS horse; otherwise the
         icon set's painted horseshoe; otherwise the inline vector. */
      const mimg = safePath((live.mount || {}).img);
      const box = glyphBox('hud-mount-ico', READOUT_ART.mount, mimg ? '' : PAINTED.ro.mount, 26);
      if (mimg) {
        const im = document.createElement('img');
        im.className = 'hud-glyph-img'; im.alt = ''; im.draggable = false;
        im.width = 26; im.height = 26;
        im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); };
        im.src = mimg;
        box.appendChild(im);
      }
      el.mount.appendChild(box);
      const main = h('div', { class: 'hud-mount-main' });
      main.appendChild(h('div', { class: 'hud-mount-name' }));
      for (const b of bars) {
        if (b === 'ghost') continue;
        const line = h('div', { class: 'hud-bar-line', 'data-bar': b });
        const bar = h('div', { class: 'hud-bar ' + b });
        bar.appendChild(h('i'));
        line.appendChild(bar);
        line.appendChild(h('span', { class: 'hud-bar-num' }));
        main.appendChild(line);
      }
      el.mount.appendChild(main);
    }
    const nameEl = el.mount.querySelector('.hud-mount-name');
    if (!has) {
      setText(nameEl, 'Mount — appears when you are riding');
      setClass(el.mount, 'is-down', false);
      return;
    }
    setText(nameEl, String(m.name || 'Your mount'));
    const hp = m.health || {};
    setClass(el.mount, 'is-down', !!m.dead || (isNum(hp.cur) && hp.cur <= 0));
    const feed = { hp: m.health, sp: m.stamina, wt: m.carry };
    for (const line of el.mount.querySelectorAll('.hud-bar-line')) {
      const key = line.getAttribute('data-bar');
      const d = feed[key] || {};
      const cur = num(d.cur), max = num(d.max);
      /* Stepped width. NO transition here on purpose — see hud.css. */
      setStyle(line.querySelector('.hud-bar > i'), 'width', pctWidth(cur, max));
      setText(line.querySelector('.hud-bar-num'),
        isNum(cur) ? (comma(cur) + (isNum(max) ? ' / ' + comma(max) : '')) : '?');
    }
  }

  /* ================================================================ pins ==
     Pinned item tiles. Art comes from the deck's EXISTING render route: the
     same key normalisation the wardrobe pane uses (FORMID upper | plugin
     lower), the same request listener the wheel and the Items tab use, the
     same settle gate + bounded empty poll. A PrismaUI view cannot import
     another view's module, so the resolver is re-implemented here — but it is
     the SAME route and the SAME on-disk renders, never a second pipeline.
     ====================================================================== */
  const ICON_SETTLE_MS = 650;
  const ICON_POLL_MS = 2500;
  const ICON_POLL_MAX = 24;
  const iconIndex = Object.create(null);   // KEY -> path
  const iconFail = Object.create(null);    // KEY -> why it will never render
  const iconAsked = Object.create(null);   // KEY -> requested once
  let iconT = null, iconPollT = null, iconPollN = 0;

  /* ONE formId dialect for icon keys: 8-digit zero-padded UPPER hex, no 0x —
     because that is what ItemIcons::IndexJson keys actually look like
     ("0001396B|skyrim.esm", read straight off the probe), while the widget
     payload spells the same form "0x01396B". The old key builder uppercased
     the 0x INTO the key, so no lookup could ever match and every plate kept
     its glyph — the 2026-08-18 "dont render actual real icons" report. */
  function canonHex8(v) {
    const n = parseInt(String(v == null ? '' : v).replace(/^0x/i, ''), 16);
    if (!isFinite(n)) return '';
    return ('00000000' + (n >>> 0).toString(16).toUpperCase()).slice(-8);
  }
  function iconKey(p) {
    if (!p || !p.formId || !p.plugin) return '';
    const hex = canonHex8(p.formId);
    return hex ? hex + '|' + String(p.plugin).toLowerCase() : '';
  }
  /* The index key is FORMID-upper | plugin-lower — NOT the whole string
     uppercased. Getting that wrong silently loses every render (caught in the
     harness, 2026-08-17): the wardrobe pane's KeyOf on the C++ side is case
     sensitive in exactly this asymmetric way, so a reply is re-normalised on
     arrival rather than trusted. */
  function normKey(k) {
    const s = String(k || '');
    const i = s.indexOf('|');
    if (i < 0) return s.toUpperCase();
    const hex = canonHex8(s.slice(0, i)) || s.slice(0, i).toUpperCase();
    return hex + '|' + s.slice(i + 1).toLowerCase();
  }
  /* A path is only ever used if it stays INSIDE this view folder. Same guard the
     other panes apply — a '..' or an absolute path is a bug or worse. */
  function safePath(s) {
    const p = String(s || '');
    if (!p) return '';
    if (/^(data:|blob:)/i.test(p)) return p;
    if (p.indexOf('..') !== -1 || p[0] === '/' || p.indexOf(':') !== -1) return '';
    return p;
  }
  function pinIcon(p) {
    if (!p) return '';
    const direct = safePath(p.icon);      // C++ may just hand us the path
    if (direct) return direct;
    const k = iconKey(p);
    return k ? safePath(iconIndex[k]) : '';
  }
  function pinsList() { return Array.isArray(live.pins) ? live.pins : []; }
  /* Everything on screen that wants a mesh render, in ONE list. The pinned
     tiles were the only client until the equipped-gear tiles landed
     (2026-08-17); both carry the same {formId, plugin, name} identity, so they
     share one request, one settle gate and one poll rather than growing a
     second pipeline beside the first. */
  /* Kinds the MESH renderer can draw. Spell-family rows resolve through the
     hudIconIndex ladder instead — queueing a shout at the render framework
     would burn a framework mesh on a form with no world model. */
  const MRF_KINDS = { weapon: 1, shield: 1, ammo: 1, other: 1,
    armor: 1, potion: 1, food: 1, poison: 1, scroll: 1, book: 1, torch: 1,
    ingredient: 1, misc: 1 };
  function artItems() {
    const out = pinsList().slice();
    for (const t of eqList())
      if (t.formId && t.plugin && MRF_KINDS[t.kind]) out.push(t);
    for (const q of quickList())
      if (q.formId && q.plugin && MRF_KINDS[q.kind]) out.push(q);
    /* round 4: the custom quick items ride the SAME render route — one
       pipeline, one settle gate, one poll. A `missing` row is skipped: its mod
       is off, so there is no form to render. */
    for (const q of quick2List())
      if (!q.missing && q.formId && q.plugin && MRF_KINDS[q.kind]) out.push(q);
    return out;
  }
  function quickList() { return Array.isArray(live.quick) ? live.quick : []; }
  function quick2List() { return Array.isArray(live.quick2) ? live.quick2 : []; }
  function lootState() { return (live.lootstate && typeof live.lootstate === 'object') ? live.lootstate : null; }
  function missingArt() {
    for (const p of artItems()) { const k = iconKey(p); if (k && !pinIcon(p) && !iconFail[k]) return true; }
    return false;
  }
  function requestIcons() {
    const items = [];
    for (const p of artItems()) {
      const k = iconKey(p);
      if (!k || iconAsked[k] || pinIcon(p) || iconFail[k]) continue;
      iconAsked[k] = 1;
      items.push({ formId: String(p.formId), plugin: String(p.plugin), name: String(p.name || '') });
      if (items.length >= 40) break;
    }
    if (items.length) toGameAny(['hudIcons', 'whIcons'], JSON.stringify({ items: items }));
  }
  function stopIconPoll() { if (iconPollT) { clearInterval(iconPollT); iconPollT = null; } }
  function startIconPoll() {
    stopIconPoll();
    iconPollN = 0;
    if (!missingArt()) return;
    /* An EMPTY request queues nothing — it just asks C++ to re-answer with the
       on-disk index, which is how a render that landed after the batch reply
       reaches the view. Bounded, because a form with no world model would poll
       for ever otherwise. */
    iconPollT = setInterval(function () {
      if (!missingArt() || ++iconPollN > ICON_POLL_MAX) { stopIconPoll(); return; }
      toGameAny(['hudIcons', 'whIcons'], JSON.stringify({ items: [] }));
    }, ICON_POLL_MS);
  }
  /* Settle gate: the Items tab shipped without one and every intermediate
     keystroke queued a page of renders (2026-08-13). Here the churn source is a
     pin list that can be re-pushed each tick — same fix, same reason. */
  function scheduleIcons() {
    if (iconT) { clearTimeout(iconT); iconT = null; }
    if (!artItems().length) { stopIconPoll(); return; }
    iconT = setTimeout(function () {
      iconT = null;
      requestIcons();
      startIconPoll();
    }, ICON_SETTLE_MS);
  }
  /* A landed render is APPENDED to the plate that lacks one. Never a rebuild,
     and never a new <img> for a src that is already there — that is the exact
     always-on churn sin. */
  function upgradeArt() {
    upgradePlates(el.pins.querySelectorAll('.hud-pin-art'), 'hud-pin-img', '.hud-pin-glyph');
    upgradePlates(el.equip.querySelectorAll('.hud-eq-art'), 'hud-pin-img', '.hud-eq-glyph');
    /* round 3: the free slot widgets' plates ride the same in-place upgrade */
    const free = document.getElementById('hud-free');
    if (free) upgradePlates(free.querySelectorAll('.hud-fw-art'), 'hud-pin-img', '.hud-fw-glyph');
  }
  function upgradePlates(plates, imgClass, glyphSel) {
    for (const art of plates) {
      if (!art || art.querySelector('.' + imgClass)) continue;
      const url = art.getAttribute('data-icon') || '';
      if (!url) continue;
      const img = document.createElement('img');
      img.className = imgClass;
      img.alt = '';
      img.draggable = false;
      const g = art.querySelector(glyphSel);
      /* The wheel's contract, both halves: art hides the glyph, and a 404
         RESTORES it — half of it (the restore) was missing, so a stale path
         left a completely blank plate. */
      const fail = function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        if (g) g.style.display = '';
      };
      /* a cross-view or corrupt file can "load" as 0x0 without ever firing
         onerror (probe-proven, dac9a2cc) — treat that as the failure it is */
      img.onload = function () { if (!img.naturalWidth) fail(); };
      img.onerror = function () {
        fail();
      };
      img.src = url;                       // plain path — Ultralight eats a ?v= query
      art.appendChild(img);
      if (g) g.style.display = 'none';
    }
  }

  function badge(cls, text) { return h('span', { class: 'hud-badge ' + cls }, text); }

  /* Badge grammar (Rober, 2026-08-17: "the equipment has +20, damage and count
     for arrows, a red number for swords, +x on trinkets"). The reference gates
     badges per slot type; we gate per PAYLOAD instead — a number the game did
     not send is a badge we do not draw — plus one kind rule: damage reads red,
     armour reads steel, and they never share the corner. */
  function pinBadges(p) {
    const out = [];
    /* `missing` = one of this entry's forms did not resolve, i.e. the mod that
       adds it is off. The contract ships that flag precisely so the count
       cannot lie, so the tile wears a "—" and greys out. */
    if (p.missing) out.push(badge('hud-pin-count hud-pin-gone', '\u2014'));
    else if (isNum(p.count)) out.push(badge('hud-pin-count', comma(p.count)));
    if (isNum(p.enchant) && p.enchant !== 0) out.push(badge('hud-pin-ench', (p.enchant > 0 ? '+' : '') + comma(p.enchant)));
    else if (typeof p.enchant === 'string' && p.enchant) out.push(badge('hud-pin-ench', p.enchant));
    if (isNum(p.damage)) out.push(badge('hud-pin-dmg', comma(p.damage)));
    else if (isNum(p.armor)) out.push(badge('hud-pin-armor', comma(p.armor)));
    if (isNum(p.value)) out.push(badge('hud-pin-val', comma(p.value)));
    return out;
  }

  /* Structural signature: identity, art path and WHICH badges exist — never the
     badge NUMBERS, which are written in place below. */
  function pinSig(p) {
    return [p.id || p.formId || p.name || '', pinIcon(p), p.missing ? 'x' : '',
      isNum(p.count) ? 'c' : '', (p.enchant || p.enchant === 0) ? 'e' : '',
      isNum(p.damage) ? 'd' : isNum(p.armor) ? 'a' : '', isNum(p.value) ? 'v' : '',
      isNum(p.goal) ? 'g' : '', p.name || ''].join('|');
  }
  let pinSigs = [];
  function renderPins() {
    const list = pinsList();
    const want = blockWant('pins', list.length > 0);
    setClass(el.pins, 'is-off', !want);
    setClass(el.pins, 'is-editoff', blockGhosted('pins'));
    if (!want) { pinSigs = []; el.pins.innerHTML = ''; stopIconPoll(); return; }

    if (!list.length) {
      /* The edit-mode ghost. Built ONCE — the first draft's guard was always
         true, so it re-wrote innerHTML on every push; harmless-looking, and
         exactly the churn this view exists to avoid. */
      if (!el.pins.querySelector('.hud-ghost')) {
        pinSigs = [];
        el.pins.innerHTML = '';
        /* Bare .hud-ghost, NOT .hud-pin-name: `body.hud-pinlabels-off
           .hud-pin-name { display: none }` would hide the placeholder too, and
           then the one widget you cannot position before you own a pinned item
           is the pins block itself — switched on, drawing nothing. Every round-2
           block uses the bare class for this reason. */
        el.pins.appendChild(h('div', { class: 'hud-ghost', style: 'width:auto;opacity:.7' },
          'Pinned items — pin something and it shows here'));
      }
      return;
    }

    const sigs = list.map(pinSig);
    const same = sigs.length === pinSigs.length && sigs.every((s, i) => s === pinSigs[i]) &&
      el.pins.children.length === sigs.length;
    if (!same) {
      pinSigs = sigs;
      el.pins.innerHTML = '';
      for (const p of list) {
        const tile = h('div', { class: 'hud-pin' });
        const art = h('div', { class: 'hud-pin-art', title: p.name || '' });
        const url = pinIcon(p);
        if (url) art.setAttribute('data-icon', url);
        art.appendChild(h('span', { class: 'hud-pin-glyph' }, svgIcon(READOUT_ART.pin, 30)));
        for (const b of pinBadges(p)) art.appendChild(b);
        tile.appendChild(art);
        if (isNum(p.goal) && p.goal > 0) {
          const bar = h('div', { class: 'hud-bar hud-pin-goal wt' });
          bar.appendChild(h('i'));
          tile.appendChild(bar);
        }
        tile.appendChild(h('div', { class: 'hud-pin-name', title: p.name || '' }, String(p.name || '—')));
        el.pins.appendChild(tile);
      }
      scheduleIcons();
    }
    /* --- volatile pass --- */
    list.forEach((p, i) => {
      const tile = el.pins.children[i];
      if (!tile) return;
      setClass(tile, 'is-none', !p.missing && isNum(p.count) && p.count <= 0);
      setClass(tile, 'is-missing', !!p.missing);
      const art = tile.querySelector('.hud-pin-art');
      /* Guarded for the same reason the element map goes through need(): an
         uncaught throw here would not break one tile, it would take Ultralight's
         renderer down with it (CLAUDE.md, 2026-08-17). Not reachable today —
         every path that rebuilds this block rebuilds the art node with it — but
         "not reachable today" is exactly what was true of el.vitals. */
      if (!art) return;
      if (art.title !== (p.missing ? (p.name || '') + ' — that mod is not loaded' : (p.name || '')))
        art.title = p.missing ? (p.name || '') + ' — that mod is not loaded' : (p.name || '');
      const c = art.querySelector('.hud-pin-count');
      if (c && !p.missing) setText(c, comma(num(p.count, 0)));
      const e = art.querySelector('.hud-pin-ench');
      if (e) setText(e, isNum(p.enchant) ? ((p.enchant > 0 ? '+' : '') + comma(p.enchant)) : String(p.enchant || ''));
      const d = art.querySelector('.hud-pin-dmg'); if (d) setText(d, comma(num(p.damage, 0)));
      const a = art.querySelector('.hud-pin-armor'); if (a) setText(a, comma(num(p.armor, 0)));
      const v = art.querySelector('.hud-pin-val'); if (v) setText(v, comma(num(p.value, 0)));
      const goal = tile.querySelector('.hud-pin-goal > i');
      if (goal) setStyle(goal, 'width', pctWidth(num(p.count, 0), p.goal));
    });
    upgradeArt();
  }

  /* -------------------------------------------------------------- sets ---- */
  function setsList() {
    /* A set linked to a finished quest disappears (the reference's
       quest-aware hiding — a solved "No Stone Unturned" should stop taking
       screen space). C++ owns the verdict; we just honour `done === 'hide'`. */
    return (Array.isArray(live.sets) ? live.sets : []).filter((s) => s && s.hide !== true);
  }
  function setSig(s) { return [s.id || s.name || '', s.name || '', s.goal, s.missing ? 'x' : '', safePath(s.icon)].join('|'); }
  let setSigs = [];
  function renderSets() {
    const list = setsList();
    const want = blockWant('sets', list.length > 0);
    setClass(el.sets, 'is-off', !want);
    setClass(el.sets, 'is-editoff', blockGhosted('sets'));
    if (!want) { setSigs = []; el.sets.innerHTML = ''; return; }

    if (!list.length) {
      if (!el.sets.querySelector('.hud-ghost')) {
        setSigs = [];
        el.sets.innerHTML = '';
        el.sets.appendChild(h('div', { class: 'hud-set-name hud-ghost', style: 'opacity:.7' },
          'Collections — set trackers show here'));
      }
      return;
    }
    const sigs = list.map(setSig);
    const same = sigs.length === setSigs.length && sigs.every((s, i) => s === setSigs[i]) &&
      el.sets.children.length === sigs.length;
    if (!same) {
      setSigs = sigs;
      el.sets.innerHTML = '';
      for (const s of list) {
        const row = h('div', { class: 'hud-set-row' });
        const ico = h('span', { class: 'hud-set-ico' }, svgIcon(READOUT_ART.set, 20));
        const url = safePath(s.icon);
        if (url) {
          const img = document.createElement('img');
          img.alt = ''; img.draggable = false;
          img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
          img.src = url;
          ico.appendChild(img);
        }
        row.appendChild(ico);
        const main = h('div', { class: 'hud-set-main' });
        main.appendChild(h('div', { class: 'hud-set-name', title: s.name || '' }, String(s.name || '—')));
        const bar = h('div', { class: 'hud-bar wt' });
        bar.appendChild(h('i'));
        main.appendChild(bar);
        row.appendChild(main);
        row.appendChild(h('span', { class: 'hud-set-count' }));
        el.sets.appendChild(row);
      }
    }
    list.forEach((s, i) => {
      const row = el.sets.children[i];
      if (!row) return;
      const have = num(s.have, 0), goal = num(s.goal, 0);
      setClass(row, 'is-missing', !!s.missing);
      setClass(row, 'is-done', !s.missing && (!!s.done || (isNum(goal) && goal > 0 && have >= goal)));
      setStyle(row.querySelector('.hud-bar > i'), 'width', s.missing ? '0%' : pctWidth(have, goal));
      setText(row.querySelector('.hud-set-count'),
        s.missing ? 'not loaded' : comma(have) + (goal > 0 ? ' / ' + comma(goal) : ''));
    });
  }

  /* ======================================================================
     ROUND 2 (2026-08-17) — the player's own state.

     Six blocks: vitals, resist, effects, equip, survival, allies. Every one of
     them follows the SAME two-pass shape the pins and the mount already use,
     because this view is on screen for the whole session: a STRUCTURAL
     signature decides whether the DOM is rebuilt, and the numbers that move
     every tick are written in place. A countdown that rebuilt its pill once a
     second is the 2026-08-16 Action Bar bug wearing a different hat.

     No rings anywhere. `conic-gradient` computes to `none` under PrismaUI's
     Ultralight — measured 2026-08-17, and it fails SILENTLY, drawing an empty
     plate that chromium renders perfectly. Every proportion below is therefore
     a plain-width bar, which is the one primitive both engines agree on.
     ====================================================================== */

  /* Seconds → a HUD string. Deliberately coarse above a minute: the payload
     itself is quantised to whole minutes up there (see widgets.h), so printing
     "12m 34s" would be printing a digit the game did not send. */
  function fmtSecs(s) {
    if (!isNum(s) || s < 0) return '';
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return m ? (h + 'h ' + m + 'm') : (h + 'h');
  }
  function barLine(kind, cls) {
    const line = h('div', { class: 'hud-bar-line' + (cls ? ' ' + cls : ''), 'data-bar': kind });
    const bar = h('div', { class: 'hud-bar ' + kind });
    bar.appendChild(h('i'));
    line.appendChild(bar);
    line.appendChild(h('span', { class: 'hud-bar-num' }));
    return line;
  }

  /* ----------------------------------------------------------- vitals ---- */
  function haveVitals() { return !!live.vitals; }
  let vitSig = '';
  function renderVitals() {
    const v = live.vitals;
    const has = !!v;
    const want = blockWant('vitals', has);
    setClass(el.vitals, 'is-off', !want);
    setClass(el.vitals, 'is-editoff', blockGhosted('vitals'));
    if (!want) { vitSig = ''; el.vitals.innerHTML = ''; return; }

    const bars = [];
    if (has) {
      if (v.hp) bars.push('hp');
      if (v.mag) bars.push('mp');
      if (v.sta) bars.push('sp');
    }
    /* The SHOUT chip is in the signature because it appears and disappears —
       and it disappears the moment the voice is ready, which is exactly when a
       "0s" left behind would read as a stuck cooldown. */
    const sig = [has ? 'v' : 'ghost', bars.join(','), (has && v.xp) ? 'x' : '',
      (has && v.shout) ? 's' : '', (has && isNum(v.lvl)) ? 'l' : ''].join('|');
    if (sig !== vitSig) {
      vitSig = sig;
      el.vitals.innerHTML = '';
      if (!has) {
        el.vitals.appendChild(h('div', { class: 'hud-ghost hud-vit-ghost' },
          'Health, magicka and stamina — shown once you are in a save'));
        return;
      }
      if (isNum(v.lvl)) {
        const medal = h('div', { class: 'hud-vit-lvl' });
        medal.appendChild(h('b', { class: 'hud-vit-lvl-n' }));
        medal.appendChild(h('span', { class: 'hud-vit-lvl-c' }, 'Level'));
        el.vitals.appendChild(medal);
      }
      const main = h('div', { class: 'hud-vit-main' });
      for (const b of bars) main.appendChild(barLine(b));
      if (v.xp) {
        const xl = h('div', { class: 'hud-vit-xp' });
        xl.appendChild(h('span', { class: 'hud-vit-xp-ico' }, svgIcon(VITAL_ART.xp, 14)));
        const bar = h('div', { class: 'hud-bar xp' });
        bar.appendChild(h('i'));
        xl.appendChild(bar);
        xl.appendChild(h('span', { class: 'hud-bar-num hud-vit-xp-n' }));
        main.appendChild(xl);
      }
      el.vitals.appendChild(main);
      if (v.shout) {
        const chip = h('div', { class: 'hud-vit-shout', title: 'Shout recovery' });
        chip.appendChild(h('span', { class: 'hud-vit-shout-ico' }, svgIcon(VITAL_ART.shout, 18)));
        chip.appendChild(h('b', { class: 'hud-vit-shout-n' }));
        const bar = h('div', { class: 'hud-bar shout' });
        bar.appendChild(h('i'));
        chip.appendChild(bar);
        el.vitals.appendChild(chip);
      }
    }
    if (!has) return;

    /* --- volatile pass --- */
    setClass(el.vitals, 'is-combat', v.combat === true);
    const n = el.vitals.querySelector('.hud-vit-lvl-n');
    if (n) setText(n, isNum(v.lvl) ? String(v.lvl) : '—');
    const feed = { hp: v.hp, mp: v.mag, sp: v.sta };
    for (const line of el.vitals.querySelectorAll('.hud-vit-main > .hud-bar-line')) {
      const key = line.getAttribute('data-bar');
      const d = feed[key] || {};
      setStyle(line.querySelector('.hud-bar > i'), 'width', pctWidth(d.cur, d.max));
      setText(line.querySelector('.hud-bar-num'),
        isNum(d.cur) ? (comma(d.cur) + (isNum(d.max) ? ' / ' + comma(d.max) : '')) : '?');
      /* Health, and only health, shouts when it is low — the one number on this
         HUD you have to act on within a second. */
      if (key === 'hp') setClass(line, 'is-low', pct(d.cur, d.max) < 0.25 && isNum(d.cur));
    }
    if (v.xp) {
      setStyle(el.vitals.querySelector('.hud-bar.xp > i'), 'width', pctWidth(v.xp.cur, v.xp.max));
      setText(el.vitals.querySelector('.hud-vit-xp-n'),
        String(Math.round(pct(v.xp.cur, v.xp.max) * 100)) + '%');
    }
    if (v.shout) {
      const rem = num(v.shout.rem, 0), dur = num(v.shout.dur, 0);
      setText(el.vitals.querySelector('.hud-vit-shout-n'), fmtSecs(rem) || '0s');
      /* The bar DRAINS: what is drawn is time left, so a full bar means the
         cooldown just started. */
      setStyle(el.vitals.querySelector('.hud-bar.shout > i'), 'width', pctWidth(rem, dur));
    }
  }

  /* ----------------------------------------------------------- resist ---- */
  function haveResist() { return !!live.resist; }
  let resSig = '';
  function renderResist() {
    const r = live.resist;
    const rows = r ? RESIST_ROWS.filter((k) => isNum(r[k[0]])) : [];
    const hasArmor = !!(r && isNum(r.armor));
    const has = !!r && (rows.length > 0 || hasArmor);
    const want = blockWant('resist', has);
    setClass(el.resist, 'is-off', !want);
    setClass(el.resist, 'is-editoff', blockGhosted('resist'));
    if (!want) { resSig = ''; el.resist.innerHTML = ''; return; }

    const sig = (has ? rows.map((k) => k[0]).join(',') : 'ghost') + '|' + (hasArmor ? 'a' : '');
    if (sig !== resSig) {
      resSig = sig;
      el.resist.innerHTML = '';
      if (!has) {
        el.resist.appendChild(h('div', { class: 'hud-ghost' }, 'Resistances — fire, frost, shock and the rest'));
        return;
      }
      if (hasArmor) {
        const chip = h('div', { class: 'hud-res hud-res-armor', 'data-res': 'armor',
          title: 'Armour rating, and the physical damage it stops' });
        chip.appendChild(h('span', { class: 'hud-res-ico' }, svgIcon(RESIST_ART.armor, 18)));
        chip.appendChild(h('b', { class: 'hud-res-v' }));
        const bar = h('div', { class: 'hud-bar res' });
        bar.appendChild(h('i'));
        chip.appendChild(bar);
        el.resist.appendChild(chip);
      }
      for (const k of rows) {
        const chip = h('div', { class: 'hud-res', 'data-res': k[0], title: k[1] + ' resistance' });
        chip.appendChild(h('span', { class: 'hud-res-ico' }, svgIcon(RESIST_ART[k[0]], 18)));
        chip.appendChild(h('b', { class: 'hud-res-v' }));
        const bar = h('div', { class: 'hud-bar res' });
        bar.appendChild(h('i'));
        chip.appendChild(bar);
        el.resist.appendChild(chip);
      }
    }
    if (!has) return;

    const capMagic = num(r.capMagic, 85), capPhys = num(r.capPhys, 80);
    for (const chip of el.resist.querySelectorAll('.hud-res')) {
      const id = chip.getAttribute('data-res');
      if (id === 'armor') {
        setText(chip.querySelector('.hud-res-v'), comma(num(r.armor, 0)));
        /* The armour chip's bar is the DAMAGE REDUCTION the rating buys, not
           the rating — a 300 rating means nothing on its own, "62% of 80" is
           the sentence. C++ already applied Skyrim's own formula and its cap. */
        setStyle(chip.querySelector('.hud-bar > i'), 'width', pctWidth(num(r.phys, 0), capPhys));
        const t = 'Armour ' + comma(num(r.armor, 0)) +
          (isNum(r.phys) ? ' — stops ' + r.phys + '% of physical damage' : '') +
          (isNum(r.pieces) ? ' (' + r.pieces + ' piece' + (r.pieces === 1 ? '' : 's') + ' worn)' : '');
        if (chip.title !== t) chip.title = t;
        setClass(chip, 'is-capped', num(r.phys, 0) >= capPhys);
        continue;
      }
      const v = num(r[id], 0);
      const cap = id === 'magic' ? capMagic : 100;
      setText(chip.querySelector('.hud-res-v'), v + '%');
      setStyle(chip.querySelector('.hud-bar > i'), 'width', pctWidth(v, cap));
      /* At the cap the chip goes green: past it the extra points do nothing,
         which is a thing worth knowing before you drink another potion. */
      setClass(chip, 'is-capped', v >= cap);
      setClass(chip, 'is-weak', v < 0);
    }
  }

  /* ---------------------------------------------------------- effects ---- */
  function fxList() { return Array.isArray(live.effects) ? live.effects : []; }
  function haveEffects() { return fxList().length > 0; }
  /* Structure = which pills exist, by group and name. The KEY is deliberately
     out of it: re-drinking the same potion mints a new ActiveEffect instance,
     and rebuilding the row for that would churn the whole strip every time you
     heal in a fight. The timer is volatile and gets written in place. */
  function fxSig(e) { return e.group + '|' + e.name + '|' + (isNum(e.mag) ? 'm' : ''); }
  let fxSigs = [];
  function renderEffects() {
    const list = fxList();
    const want = blockWant('effects', list.length > 0);
    setClass(el.effects, 'is-off', !want);
    setClass(el.effects, 'is-editoff', blockGhosted('effects'));
    if (!want) { fxSigs = []; el.effects.innerHTML = ''; return; }

    if (!list.length) {
      if (!el.effects.querySelector('.hud-ghost')) {
        fxSigs = [];
        el.effects.innerHTML = '';
        el.effects.appendChild(h('div', { class: 'hud-ghost' },
          'Active effects — buffs and debuffs show here while they run'));
      }
      return;
    }
    const sigs = list.map(fxSig);
    const same = sigs.length === fxSigs.length && sigs.every((s, i) => s === fxSigs[i]) &&
      el.effects.children.length === sigs.length;
    if (!same) {
      fxSigs = sigs;
      el.effects.innerHTML = '';
      for (const e of list) {
        const pill = h('div', { class: 'hud-fx fx-' + e.group });
        pill.appendChild(h('span', { class: 'hud-fx-ico' }, svgIcon(FX_ART[e.group] || FX_ART.buff, 16)));
        const main = h('div', { class: 'hud-fx-main' });
        const head = h('div', { class: 'hud-fx-head' });
        head.appendChild(h('span', { class: 'hud-fx-name', title: e.name }, e.name));
        if (isNum(e.mag)) head.appendChild(h('span', { class: 'hud-fx-mag' }, comma(e.mag)));
        main.appendChild(head);
        const bar = h('div', { class: 'hud-bar fx' });
        bar.appendChild(h('i'));
        main.appendChild(bar);
        pill.appendChild(main);
        pill.appendChild(h('b', { class: 'hud-fx-t' }));
        el.effects.appendChild(pill);
      }
    }
    list.forEach((e, i) => {
      const pill = el.effects.children[i];
      if (!pill) return;
      const t = pill.querySelector('.hud-fx-t');
      /* A permanent effect has no clock. Say so with the infinity glyph rather
         than printing "0s", which reads as "about to expire". */
      if (!isNum(e.rem)) { setText(t, '∞'); setStyle(pill.querySelector('.hud-bar.fx > i'), 'width', '100%'); }
      else {
        setText(t, fmtSecs(e.rem));
        setStyle(pill.querySelector('.hud-bar.fx > i'), 'width', pctWidth(e.rem, e.dur));
      }
      /* Under ten seconds the pill warns — that is the window in which you can
         still do something about it. */
      setClass(pill, 'is-soon', isNum(e.rem) && e.rem <= 10);
    });
  }

  /* ------------------------------------------------------------ equip ---- */
  function eqList() { return Array.isArray(live.equip) ? live.equip : []; }
  function haveEquip() { return eqList().some((t) => t.kind !== 'empty'); }
  function eqSig(t) {
    /* the SAME resolver the tile draws with (fwArtFor) — a signature that
       asked a different question than the renderer is a signature that cannot
       notice the picture changing */
    return [t.slot, t.kind, t.name, fwArtFor(t), (t.badges || []).length,
      isNum(t.damage) ? 'd' : '', isNum(t.armor) ? 'a' : '', isNum(t.count) ? 'c' : ''].join('|');
  }
  let eqSigs = [];
  function renderEquip() {
    const list = eqList();
    const want = blockWant('equip', list.length > 0);
    setClass(el.equip, 'is-off', !want);
    setClass(el.equip, 'is-editoff', blockGhosted('equip'));
    if (!want) { eqSigs = []; el.equip.innerHTML = ''; return; }

    if (!list.length) {
      if (!el.equip.querySelector('.hud-ghost')) {
        eqSigs = [];
        el.equip.innerHTML = '';
        el.equip.appendChild(h('div', { class: 'hud-ghost' }, 'Equipped — what is in your hands'));
      }
      return;
    }
    const sigs = list.map(eqSig);
    const same = sigs.length === eqSigs.length && sigs.every((s, i) => s === eqSigs[i]) &&
      el.equip.children.length === sigs.length;
    if (!same) {
      eqSigs = sigs;
      el.equip.innerHTML = '';
      for (const t of list) {
        const tile = h('div', { class: 'hud-eq eq-' + t.kind });
        const art = h('div', { class: 'hud-eq-art', title: t.name || t.label });
        /* ⚠ 2026-08-19 (Rober: "right widget still not using the default icon
           of the actual power"). This block asked pinIcon() — the MESH-render
           index — and nothing else. A shout or a power has no world model, so
           the render index can never hold one and the tile fell to its drawn
           glyph forever, while the FREE voice widget beside it (fwArtFor) was
           already resolving the spell ladder. Two render paths, one data row,
           two different pictures. They share fwArtFor now: spell-family kinds
           take the ladder, everything else takes the render index exactly as
           before. */
        const url = fwArtFor(t);
        if (url) art.setAttribute('data-icon', url);
        art.appendChild(h('span', { class: 'hud-eq-glyph' },
          svgIcon(EQUIP_ART[t.kind] || EQUIP_ART.other, 26)));
        /* Badge grammar, unchanged from the pins: damage reads red, armour
           steel, and they never share the corner; the count pill is the one
           badge that survives "badges off", because a quiver's number IS the
           reason the tile is there. */
        if (isNum(t.count)) art.appendChild(badge('hud-pin-count', t.count < 0 ? '?' : comma(t.count)));
        if (isNum(t.damage)) art.appendChild(badge('hud-eq-badge hud-pin-dmg', comma(t.damage)));
        else if (isNum(t.armor)) art.appendChild(badge('hud-eq-badge hud-pin-armor', comma(t.armor)));
        tile.appendChild(art);
        const ench = h('div', { class: 'hud-eq-badges' });
        for (const b of (t.badges || [])) {
          if (!b || !b.text) continue;
          ench.appendChild(h('span', { class: 'hud-badge hud-eq-badge hud-pin-ench', title: b.av || '' }, String(b.text)));
        }
        tile.appendChild(ench);
        tile.appendChild(h('div', { class: 'hud-eq-name', title: t.name || '' },
          t.kind === 'empty' ? (t.label === 'Left' ? 'Off hand' : 'Empty') : (t.name || '—')));
        el.equip.appendChild(tile);
      }
      scheduleIcons();
    }
    list.forEach((t, i) => {
      const tile = el.equip.children[i];
      if (!tile) return;
      setClass(tile, 'is-empty', t.kind === 'empty');
      /* Out of arrows is worth shouting about — a bow with an empty quiver is a
         club, and you will not notice from the tile art. */
      setClass(tile, 'is-none', isNum(t.count) && t.count === 0);
      const c = tile.querySelector('.hud-pin-count');
      if (c) setText(c, isNum(t.count) ? (t.count < 0 ? '?' : comma(t.count)) : '');
      const d = tile.querySelector('.hud-pin-dmg'); if (d) setText(d, comma(num(t.damage, 0)));
      const a = tile.querySelector('.hud-pin-armor'); if (a) setText(a, comma(num(t.armor, 0)));
    });
    upgradeArt();
  }

  /* Compact calendar + SunHelm needs. Existing clock stays its original size.
     hud-compact-calendar: preferences round-trip in hud, placements use wdet. */
  const NEED_READOUTS = [
    { key:'needFood', id:'hunger', label:'Food', art:'ps-food' },
    { key:'needDrink', id:'thirst', label:'Drink', art:'sv-drink' },
    { key:'needSleep', id:'fatigue', label:'Sleep', art:'hk-bed' },
    { key:'needCold', id:'cold', label:'Cold', art:'wx-snow' }
  ];
  for (const key of ['roLockpicks', 'roWeather', 'calendar'].concat(NEED_READOUTS.map(d => d.key))) {
    el[key] = need('hud-' + key);
    el[key].id = 'hud-' + key;
    el[key].className = 'hud-ro-one is-off';
    el.widgets.appendChild(el[key]);
  }
  function calendarText() {
    const t = live.time || {}, parts = [];
    if (wcfg.calendarDay && isNum(t.day)) parts.push(String(t.day));
    if (wcfg.calendarMonth && t.monthName) parts.push(String(t.monthName));
    let text = parts.join(' ');
    if (wcfg.calendarSeason && live.season && live.season.name)
      text += (text ? ' · ' : '') + live.season.name;
    return text;
  }
  function renderCalendar() {
    const host = el.calendar, text = calendarText();
    setClass(host, 'is-off', !blockWant('calendar', !!text));
    setClass(host, 'is-editoff', blockGhosted('calendar'));
    if (!text && !editing) { host.innerHTML = ''; return; }
    if (!host.firstChild) {
      const row = h('span', { class:'hud-ro hud-calendar' });
      row.appendChild(glyphBox('hud-ro-ico', READOUT_ART.sun, '', 22));
      row.appendChild(h('b', { class:'hud-ro-v' }));
      host.appendChild(row);
    }
    setText(host.querySelector('.hud-ro-v'), text || 'Date & season — choose fields');
    host.title = (live.time || {}).date || text;
  }
  function haveSurvival() { return !!(live.survival && live.survival.meters && live.survival.meters.length); }
  let svSig = '';
  function paintNeed(row, meter, definition, on) {
    const off = !on || meter.off === true;
    const level = off ? 'off' : meter.level == null ? 'unknown' : String(meter.level);
    if (row.getAttribute('data-level') !== level) row.setAttribute('data-level', level);
    const state = String(meter.state || '').replace(/^[^:]+:\s*/, '');
    const text = off ? 'Off' : state || (definition.id === 'cold' ?
      comma(meter.v) + (isNum(meter.max) ? ' / ' + comma(meter.max) : '') : 'Unrated');
    setText(row.querySelector('.hud-ro-v'), text);
    const title = 'SunHelm ' + definition.label + ': ' + text + ' · ' + comma(meter.v);
    if (row.title !== title) row.title = title;
  }
  function needRow(d) {
    const row = h('span', { class:'hud-ro hud-need-readout', 'data-need':d.id });
    row.appendChild(h('img', { class:'hud-need-art', src:'icons/custom/' + d.art + '.png', alt:d.label, draggable:'false' }));
    row.appendChild(h('b', { class:'hud-ro-v' }));
    return row;
  }
  function renderSurvival() {
    const s = live.survival || {}, meters = s.meters || [];
    const separate = wcfg.needsSeparate;
    setClass(el.survival, 'is-icons-only', wcfg.needsIconsOnly);
    const active = NEED_READOUTS.filter(d => wcfg[d.key] && meters.some(m => m.id === d.id));
    const want = blockWant('survival', active.length > 0);
    setClass(el.survival, 'hud-layout-inactive', separate);
    setClass(el.survival, 'is-off', separate || !want);
    setClass(el.survival, 'is-editoff', blockGhosted('survival'));
    const sig = active.map(d => d.key).join(',') + '|' + separate;
    if (sig !== svSig) {
      svSig = sig; el.survival.innerHTML = '';
      if (!separate) active.forEach(d => el.survival.appendChild(needRow(d)));
    }
    if (!separate && !active.length && editing && !el.survival.firstChild)
      el.survival.appendChild(h('span', { class:'hud-ghost' }, haveSurvival() ? 'SunHelm — choose needs below' : 'SunHelm — no live needs'));
    for (const d of NEED_READOUTS) {
      const host = el[d.key], m = meters.find(m => m.id === d.id);
      setClass(host, 'is-icons-only', wcfg.needsIconsOnly);
      const show = separate && (editing || (wcfg.survival && wcfg[d.key] && !!m));
      setClass(host, 'hud-layout-inactive', !separate);
      setClass(host, 'is-off', !show);
      setClass(host, 'is-editoff', !wcfg.survival || !wcfg[d.key]);
      if (!show) host.innerHTML = '';
      else {
        if (!host.firstChild) host.appendChild(needRow(d));
        if (m) paintNeed(host.firstChild, m, d, s.on !== false);
        else setText(host.querySelector('.hud-ro-v'), d.label + ' — no data');
      }
      const grouped = el.survival.querySelector('[data-need="' + d.id + '"]');
      if (grouped && m) paintNeed(grouped, m, d, s.on !== false);
    }
  }

  /* ----------------------------------------------------------- allies ---- */
  function alliesList() { return Array.isArray(live.allies) ? live.allies : []; }
  function haveAllies() { return alliesList().length > 0; }
  function allySig(a) { return a.id + '|' + a.name; }
  let allySigs = [];
  function renderAllies() {
    const list = alliesList();
    const want = blockWant('allies', list.length > 0);
    setClass(el.allies, 'is-off', !want);
    setClass(el.allies, 'is-editoff', blockGhosted('allies'));
    if (!want) { allySigs = []; el.allies.innerHTML = ''; return; }

    if (!list.length) {
      if (!el.allies.querySelector('.hud-ghost')) {
        allySigs = [];
        el.allies.innerHTML = '';
        el.allies.appendChild(h('div', { class: 'hud-ghost' },
          'Quest allies — anyone fighting beside you who is not a follower'));
      }
      return;
    }
    const sigs = list.map(allySig);
    const same = sigs.length === allySigs.length && sigs.every((s, i) => s === allySigs[i]) &&
      el.allies.children.length === sigs.length;
    if (!same) {
      allySigs = sigs;
      el.allies.innerHTML = '';
      for (const a of list) {
        const chip = h('div', { class: 'hud-ally' });
        chip.appendChild(h('span', { class: 'hud-ally-ico' }, svgIcon(VITAL_ART.ally, 16)));
        const main = h('div', { class: 'hud-ally-main' });
        main.appendChild(h('div', { class: 'hud-ally-name', title: a.name }, a.name));
        const bar = h('div', { class: 'hud-bar hp' });
        bar.appendChild(h('i'));
        main.appendChild(bar);
        chip.appendChild(main);
        el.allies.appendChild(chip);
      }
    }
    list.forEach((a, i) => {
      const chip = el.allies.children[i];
      if (!chip) return;
      const hp = a.hp || {};
      setClass(chip, 'hud-dead', !!a.dead || (isNum(hp.cur) && hp.cur <= 0));
      setClass(chip, 'is-low', isNum(hp.cur) && pct(hp.cur, hp.max) < 0.3);
      setStyle(chip.querySelector('.hud-bar.hp > i'), 'width', pctWidth(hp.cur, hp.max));
      chip.title = a.name + (isNum(hp.cur) ? ' — ' + comma(hp.cur) + (isNum(hp.max) ? ' / ' + comma(hp.max) : '') : '');
    });
  }

  function renderWidgets() {
    /* A menu owns the screen (or no save is loaded — C++ folds both into the
       same flag). Folded into the MASTER-OFF path on purpose rather than given
       a display:none of its own: that path already tears the blocks down and
       stops the icon poll, so a loading screen costs nothing instead of keeping
       a hidden stack of live <img>s alive behind it. Per-widget `hideInMenus`
       is honoured at plate granularity — the stack is one plate, and half a
       plate is worse than none — so a single widget asking to stay keeps it up.
       Everything downstream (is-off, widgetsDrawn, is-blank, fitWidgets) then
       works unchanged, which is the whole reason for folding rather than
       branching. */
    /* !editing: reposition mode PAUSES the game, which reads as menusOpen —
       without the exemption the player is asked to place a panel that is
       drawing nothing (the free widgets' own gate already exempts editing). */
    const gated = menusOpen && !wcfg.keepInMenus && !editing;
    /* Round 3: the free slot widgets draw OUTSIDE this stack and own their
       menu gate per widget, so they render on every path — including the
       gated one, where a widget with hideInMenus:false may stay up. */
    renderFree();
    /* The stack MASTER is a play-time switch, not an edit-time one: with it off
       the whole stack used to be torn down inside the editor, which is half of
       "it doesn't show them, just circles" — every floated block became an empty
       dashed wrap. Edit mode keeps the stack drawn and ghosts it instead. */
    const stackDown = (!wcfg.on && !editing) || gated;
    setClass(el.widgets, 'is-off', stackDown);
    setClass(el.widgets, 'is-editoff', editing && !wcfg.on);
    if (stackDown) {
      /* Master off: tear the stack down rather than leave it hidden-but-built,
         so nothing keeps a live <img> or a poll alive behind the game. */
      roSig = mountSig = vitSig = resSig = svSig = ''; pinSigs = []; setSigs = [];
      fxSigs = []; eqSigs = []; allySigs = [];
      for (const rk in RO_DET) { roSigs[rk] = ''; const n = el[RO_DET[rk]]; if (n) { n.innerHTML = ''; setClass(n, 'is-off', true); } }
      el.readouts.innerHTML = ''; el.mount.innerHTML = ''; el.pins.innerHTML = ''; el.sets.innerHTML = '';
      el.vitals.innerHTML = ''; el.resist.innerHTML = ''; el.effects.innerHTML = '';
      el.equip.innerHTML = ''; el.survival.innerHTML = ''; el.allies.innerHTML = '';
      for (const k of ['calendar', 'needFood', 'needDrink', 'needSleep', 'needCold']) { el[k].innerHTML = ''; setClass(el[k], 'is-off', true); }
      /* ⚠ The mesh-render pipeline is SHARED with the free widgets (artItems()
         reads the equipped and quick lists, which the Equipped group and the
         quick-items widget draw from). Killing it here because the STACK went
         off left every free widget stuck on its glyph — the same coupling
         fwGate just lost. Stop it only when nothing at all is asking. */
      if (FREE_KEYS.some(function (fk) { return fwGate(fk); })) scheduleIcons();
      else stopIconPoll();
      applyDetach(true);
      return;
    }
    renderReadouts();
    renderVitals();
    renderResist();
    renderEffects();
    renderEquip();
    renderSurvival();
    renderCalendar();
    renderMount();
    renderPins();
    renderSets();
    renderAllies();
    /* Seed only once there is something to MEASURE. The very first render
       happens before C++ has pushed a roster or a widget feed, so the whole
       assembly has no size — seeding there threw every block onto a blind
       ladder at 60,60, which is precisely where the follower strip lands the
       moment the roster arrives. needsSeed() stays true, so the next render
       with real content does the job properly. */
    /* ⚠ …and "something to measure" means a BLOCK, not a panel. `panel.
       offsetHeight` is satisfied by the empty-roster message alone, so on the
       usual boot order (config lands before the first live feed) the seed fired
       with every block still is-off — all fourteen took the BLIND ladder, which
       on a 1280x720 screen marched five of them clean off the bottom edge where
       they could never be found again (measured, Opus audit 2026-08-18). With a
       drawn block to measure, the seed lands on the compact stack positions the
       blocks already occupy and the ladder goes back to being the exception. */
    if (needsSeed() && el.panel.offsetHeight && anyBlockDrawn()) seedDetach();
    applyDetach(false);
  }

  /* Every block that can hold the panel open. Keep this in step with the DOM —
     a block missing here makes the panel collapse out from under it. */
  const DRAWN_ELS = ['roLockpicks', 'roWeather', 'calendar', 'needFood', 'needDrink', 'needSleep', 'needCold', 'roGold', 'roCarry', 'roTime', 'roContext', 'roPots',
    'vitals', 'resist', 'effects', 'equip', 'survival',
    'mount', 'pins', 'sets', 'allies'];
  function widgetsDrawn() {
    if (!wcfg.on && !editing) return false;
    for (const k of DRAWN_ELS) if (el[k] && !el[k].classList.contains('is-off')) return true;
    return false;
  }
  /* ---- is the PANEL itself holding anything? (2026-08-19, round 3) ---------
     `widgetsDrawn()` answers "is any stack block drawn" — and a FLOATED block
     is drawn somewhere else entirely, in its own `.hud-det` wrap on the free
     layer. Since every block floats itself by default (seedDetach), the panel
     is routinely empty while the screen is full of widgets, and the old
     is-blank test (`no followers && !widgetsDrawn()`) therefore said "not
     blank" — leaving an empty, dashed, rounded `.hud-panel` on screen in edit
     mode. That is one of the anonymous blobs Rober photographed.

     So the panel's own verdict counts only what is INSIDE it: the follower
     strip when it is actually being drawn, and stack blocks that have not been
     floated out. */
  /* The panel's verdict has THREE writers — a render, a strip visibility flip,
     and a float/unfloat (which physically moves a block in or out of it) — so
     it lives in one function all three call. A float that did not re-take it
     left an empty panel still marked non-blank, i.e. the blob again. */
  function refreshPanelBlank() {
    if (el.panel) el.panel.classList.toggle('is-blank', !panelHasContent());
    /* …and whether the panel is holding a STACK BLOCK, which is the only reason
       it needs its drag chrome outside the strip's own scope: every block floats
       itself out by default, so this is normally false and the plate stays off
       a strip the player merely happens to have switched on (round 3). */
    el.body.classList.toggle('hud-panel-blocks', panelHasBlocks());
  }
  function panelHasBlocks() {
    for (const k of DRAWN_ELS) {
      const n = el[k];
      if (n && n.parentNode === el.widgets && !n.classList.contains('is-off')) return true;
    }
    return false;
  }
  function panelHasContent() {
    if (followers.length && !el.body.classList.contains('hud-strip-off')) return true;
    return panelHasBlocks();
  }

  function applyWidgetCfg() {
    el.body.classList.toggle('hud-pinlabels-off', !wcfg.pinLabels);
    el.body.classList.toggle('hud-badges-off', !wcfg.badges);
    el.body.classList.toggle('hud-nums-off', !wcfg.barNumbers);
  }
  /* Our per-block switches map onto the C++ widget ids (2026-08-17 contract).
     `context` is ONE switch over the widgets' two — weather outdoors, place
     indoors is a single readout here, so both ids follow it. */
  const CFG_ID = { lockpicks:'lockpicks', gold: 'gold', carry: 'carry', time: 'clock', mount: 'mount', pins: 'pins', sets: 'sets',
    pots: 'potions',
    /* Round 2 — these six are 1:1, so the map is an identity for them. Kept
       explicit rather than derived: the two halves of this table are allowed to
       diverge again the next time C++ names a widget something else. */
    vitals: 'vitals', resist: 'resist', effects: 'effects', equip: 'equip',
    survival: 'survival', allies: 'allies' };
  const CTX_IDS = ['weather', 'place'];

  function saveWidgetCfg() {
    /* ⚠ PARTIAL WRITE, on purpose. The contract says a `widgets.pins` saved
       WITHOUT its `items` keeps the stored list — so this sends nothing but the
       `enabled` flag per widget. Sending our whole idea of the config back
       would blow away the tracked pins, the goals and every widget's placement,
       none of which this view owns. Same lesson as the charsheet slice that
       OnJsSave ate: never round-trip a slice you do not hold. */
    const widgets = {};
    for (const k in CFG_ID) widgets[CFG_ID[k]] = { enabled: !!wcfg[k] };
    for (const id of CTX_IDS) widgets[id] = { enabled: !!wcfg.context };
    /* Round 3: the free slot widgets are the exception to enabled-only — this
       view IS their placement editor, so it writes the full Widget fields it
       owns. Still a partial write for everything else. */
    for (const k of FREE_KEYS) {
      const w = wfree[k];
      widgets[k] = {
        enabled: !!wcfg[k],
        x: Math.round(num(w.x, 0)), y: Math.round(num(w.y, 0)),
        anchorH: w.anchorH, anchorV: w.anchorV,
        scale: +Number(w.scale || 1).toFixed(2),
        opacity: +Number(w.opacity == null ? 1 : w.opacity).toFixed(2),
        bare: !!w.bare, showLabel: w.showLabel !== false,
        hideInMenus: w.hideInMenus !== false,
      };
    }
    /* ⚠ quick2's `max` and `items` are contains()-GUARDED on the C++ side, so
       they are sent ONLY when this view actually changed them. A placement-only
       save (a drag, a wheel, a ⚙ toggle) must omit them — carrying our idea of
       the list into every save is exactly how the charsheet slice got eaten. */
    if (q2.dirty) {
      widgets.quick2.max = clamp(q2.max, 1, Q2_MAX_ITEMS);
      widgets.quick2.items = q2.items.slice(0, Q2_MAX_ITEMS).map(function (it) {
        const o = { plugin: String(it.plugin || ''), formId: String(it.formId || ''), name: String(it.name || '') };
        if (isNum(it.keyCode) && it.keyCode > 0) {
          o.keyDevice = it.keyDevice === 'mouse' ? 'mouse' : 'keyboard';
          o.keyCode = Math.round(it.keyCode);
          o.keyLabel = String(it.keyLabel || '');
        }
        return o;
      });
      q2.dirty = false;
    }
    toGameAny(['hudWidgetSave', 'wgSave'],
      JSON.stringify({ enabled: !!wcfg.on, on: !!wcfg.on, widgets: widgets, hud: hudOnlyPrefs() }));
  }
  /* The three "detail" switches and the clock format have no C++ widget — they
     are how THIS view draws, so they ride their own key and C++ can keep them
     as an opaque blob. */
  /* ======================================================================
     WIDGET BACKGROUNDS (2026-08-19). Rober: "add a bunch of additional
     backgrounds for the equipment hud widget (left, right, power), a bunch of
     nice default ones + upload your own image to fill the background, or a
     literal ui element to be the background, with scaling. Same for the
     follower hud."

     One per-key blob `wbg[key] = { file, scale, opacity, fit }`:
       key   — any FREE widget ('handR'…'lootStatus') or 'strip'
       file  — view-relative art: shipped 'backgrounds/…', an upload/custom
               'icons/custom/…', or any interface element 'icons/sh/…'
               (the "literal ui element" ask). Never '..', ':' or a leading
               '/', never a ?query (Ultralight refuses query URLs).
       scale — 0.3–3.0, transform on the art INSIDE the clipped layer
       opacity — 0.05–1
       fit   — 'cover' (fill the card) | 'contain' (show the whole element)
     Persisted inside the `hud` blob (bgPrefs ↔ takeWidgetCfg) — C++ stores
     that blob verbatim, so this needs ZERO plugin changes; but the blob is a
     WHOLESALE replace, so bgPrefs MUST be emitted on every save (the
     charsheet-slice law). The bg layer is the card's FIRST child — painting
     order puts every later sibling above it, so no z-index war.
     Build marker (hd-markers.json: "hud-widget-bg"). */
  const BG_SHIPPED = [
    { file: 'backgrounds/bg-knotwork-gold.png', label: 'Gold Knotwork' },
    { file: 'backgrounds/bg-leather-trim.png',  label: 'Leather Trim' },
    { file: 'backgrounds/bg-jarl-oak.png',      label: 'Jarl’s Oak' },
    { file: 'backgrounds/bg-braided-oak.png',   label: 'Braided Oak' },
    { file: 'backgrounds/bg-carved-stone.png',  label: 'Carved Stone' },
    { file: 'backgrounds/bg-dwemer-steel.png',  label: 'Dwemer Steel' },
    { file: 'backgrounds/bg-dragonhide.png',    label: 'Dragonhide' },
    { file: 'backgrounds/bg-scale-frame.png',   label: 'Scale Frame' },
    { file: 'backgrounds/bg-arcane-night.png',  label: 'Arcane Night' },
    { file: 'backgrounds/bg-burnt-vellum.png',  label: 'Burnt Vellum' },
  ];
  const BG_KEYS = FREE_KEYS.concat(['strip']);
  const BG_SCALE_MIN = 0.3, BG_SCALE_MAX = 3.0, BG_SCALE_STEP = 0.1;
  let wbg = {};
  let customIcons = [];   // [{file:'icons/custom/x.png', label}] — pushed by C++ (hudCustomIcons)
  function bgPathOk(p) {
    p = String(p || '');
    if (!p || p.indexOf('..') !== -1 || p.indexOf(':') !== -1 ||
        p.charAt(0) === '/' || p.indexOf('?') !== -1) return false;
    return p.indexOf('backgrounds/') === 0 || p.indexOf('icons/') === 0;
  }
  function bgSanitize(b) {
    if (!b || typeof b !== 'object' || !bgPathOk(b.file)) return null;
    return { file: String(b.file),
      scale: clamp(num(b.scale, 1), BG_SCALE_MIN, BG_SCALE_MAX),
      opacity: clamp(num(b.opacity, 1), 0.05, 1),
      fit: b.fit === 'contain' ? 'contain' : 'cover' };
  }
  function bgPrefs() {
    const o = {};
    for (const k of BG_KEYS) { const b = bgSanitize(wbg[k]); if (b) o[k] = b; }
    return o;
  }
  function bgFrom(src) {
    wbg = {};
    if (!src || typeof src !== 'object') return;
    for (const k of BG_KEYS) { const b = bgSanitize(src[k]); if (b) wbg[k] = b; }
  }
  function bgLabelOf(file) {
    for (const s of BG_SHIPPED) if (s.file === file) return s.label;
    for (const c of customIcons) if (c.file === file) return c.label || file;
    const cut = String(file || '').split('/').pop();
    return cut ? cut.replace(/\.[a-z0-9]+$/i, '') : 'None';
  }
  /* mount (or refresh) the bg layer on one element. Idempotent and cheap:
     when the mounted identity already matches, only the knobs are re-styled. */
  /* A background file that FAILED to load, remembered by path. Without this
     the onerror below removes the wrap, the next unconditional applyCardBg()
     rebuilds it, and the missing file is re-requested on every HUD push
     forever (2026-08-19 verification-swarm find). Cleared per-path whenever
     the config names a different file, so fixing the path retries once. */
  const bgDead = Object.create(null);

  /* Size the art by LAYOUT, never by transform: Ultralight rasterises an
     <img> at its layout size with the compositor off, so a CSS transform can
     only magnify an already-made bitmap — a scale knob driven that way is a
     blur knob (the hd-facefit lesson, codified in CLAUDE.md). Width/height in
     percent of the wrap + a centring inset gives the engine the real size to
     decode at. */
  function bgStyle(img, b) {
    const pct = Math.round(b.scale * 100);
    img.style.objectFit = b.fit;
    img.style.width = pct + '%';
    img.style.height = pct + '%';
    img.style.left = '50%';
    img.style.top = '50%';
    img.style.marginLeft = '-' + (pct / 2) + '%';
    img.style.marginTop = '-' + (pct / 2) + '%';
    img.style.opacity = String(b.opacity);
  }

  /* first-level child scan — never :scope (unproven in this engine) */
  function childByClass(host, cls) {
    if (!host) return null;
    for (let i = 0; i < host.children.length; i++)
      if (host.children[i].classList && host.children[i].classList.contains(cls)) return host.children[i];
    return null;
  }
  function bgMount(host, key) {
    if (!host) return;
    const b = bgSanitize(wbg[key]);
    let wrap = childByClass(host, 'hud-bgwrap');
    if (!b || bgDead[b.file]) { if (wrap) wrap.remove(); return; }
    let img = wrap && wrap.querySelector('img');
    if (!wrap || !img || img.getAttribute('data-bgfile') !== b.file) {
      if (wrap) wrap.remove();
      wrap = h('div', { class: 'hud-bgwrap' });
      img = h('img', { alt: '', draggable: 'false' });
      img.setAttribute('data-bgfile', b.file);
      img.onerror = (function (file, node) {
        return function () { bgDead[file] = 1; try { node.remove(); } catch (e) {} };
      })(b.file, wrap);
      /* a 0x0 "success" is the failure it is (the hud's own spell-art lesson) */
      img.onload = (function (file, node) {
        return function () { if (!this.naturalWidth) { bgDead[file] = 1; try { node.remove(); } catch (e) {} } };
      })(b.file, wrap);
      img.src = b.file;
      wrap.appendChild(img);
      host.insertBefore(wrap, host.firstChild);
    }
    bgStyle(img, b);
  }
  function applyCardBg(k) {
    const root = elFree[k];
    bgMount(root && root.querySelector('.hud-fw-card'), k);
  }
  /* The strip's faces are el.strip's DIRECT children and render() indexes
     them (children[i]) — so its layer lives on a SIBLING sized to the strip's
     box, never inside it. */
  function applyStripBg() {
    const strip = el.strip;
    const panel = strip && strip.parentNode;
    if (!panel) return;
    const b = bgSanitize(wbg.strip);
    let wrap = childByClass(panel, 'hud-strip-bgwrap');
    if (!b || bgDead[b.file] || !strip.children.length) { if (wrap) wrap.remove(); return; }
    if (!wrap) {
      wrap = h('div', { class: 'hud-bgwrap hud-strip-bgwrap' });
      panel.insertBefore(wrap, strip);
    }
    wrap.style.left = strip.offsetLeft + 'px';
    wrap.style.top = strip.offsetTop + 'px';
    wrap.style.width = strip.offsetWidth + 'px';
    wrap.style.height = strip.offsetHeight + 'px';
    let img = wrap.querySelector('img');
    if (!img || img.getAttribute('data-bgfile') !== b.file) {
      wrap.innerHTML = '';
      img = h('img', { alt: '', draggable: 'false' });
      img.setAttribute('data-bgfile', b.file);
      img.onerror = (function (file, node) {
        return function () { bgDead[file] = 1; try { node.remove(); } catch (e) {} };
      })(b.file, wrap);
      img.onload = (function (file, node) {
        return function () { if (!this.naturalWidth) { bgDead[file] = 1; try { node.remove(); } catch (e) {} } };
      })(b.file, wrap);
      img.src = b.file;
      wrap.appendChild(img);
    }
    bgStyle(img, b);
  }
  function applyAllBgs() {
    for (const k of FREE_KEYS) applyCardBg(k);
    applyStripBg();
  }
  function bgChanged(key) {
    if (key === 'strip') applyStripBg(); else applyCardBg(key);
    saveWidgetCfg();
    buildSettings(true);
  }
  /* ---- the shelf row: choose / size / see-through / fit / clear ---------- */
  function bgChipRow(key) {
    const b = bgSanitize(wbg[key]);
    const chips = h('div', { class: 'hud-el-chips hud-bg-chips' });
    chips.appendChild(elChip('data-bgpick', key,
      '⬒ ' + (b ? bgLabelOf(b.file) : 'Background…'),
      b ? 'Background: ' + bgLabelOf(b.file) + ' — click to choose another' :
          'Give it a background — a shipped plate, an uploaded image, or any icon art', !!b));
    if (b) {
      const mk = (act, txt, title) => {
        const c = elChip('data-bgact', act + ':' + key, txt, title, false);
        return c;
      };
      chips.appendChild(mk('smaller', '−', 'Shrink the background art'));
      chips.appendChild(h('span', { class: 'hud-sz-val' }, Math.round(b.scale * 100) + '%'));
      chips.appendChild(mk('bigger', '＋', 'Grow the background art'));
      chips.appendChild(mk('fit', b.fit === 'contain' ? '⛶ Whole' : '⛶ Fill',
        b.fit === 'contain' ? 'Showing the whole element — click to fill the card instead'
                            : 'Filling the card — click to show the whole element instead'));
      chips.appendChild(mk('dim', '◐ ' + Math.round(b.opacity * 100) + '%',
        'How solid it is — steps down, wraps back to full'));
      chips.appendChild(mk('clear', '✕', 'No background'));
    }
    return chips;
  }
  /* ---- the picker: search-as-you-type over every source ------------------ */
  let bgPickKey = '';
  function bgPickList(q) {
    q = String(q || '').trim().toLowerCase();
    const out = [];
    const push = (file, label, kind) => {
      if (q && (label + ' ' + file).toLowerCase().indexOf(q) === -1) return;
      out.push({ file: file, label: label, kind: kind });
    };
    for (const s of BG_SHIPPED) push(s.file, s.label, 'shipped');
    for (const c of customIcons) push(c.file, c.label || c.file, 'custom');
    /* the interface pool — the "literal ui element" half. Big (1,900+), so it
       only unfolds under a search; unsearched it would bury the plates.
       SICON.generic is the hudIconIndex ingest (sh_index.json). */
    if (q && typeof SICON === 'object' && SICON && SICON.generic) {
      for (const gk in SICON.generic) {
        if (out.length >= 60) break;
        push(SICON.generic[gk], String(gk).toLowerCase().replace(/[_-]+/g, ' '), 'ui');
      }
    }
    return out.slice(0, 60);
  }
  function closeBgPick() {
    const p = document.getElementById('hud-bgpick');
    if (p) p.remove();
    bgPickKey = '';
  }
  function openBgPick(key) {
    closeBgPick();
    bgPickKey = key;
    const label = key === 'strip' ? 'Follower strip' : (OPT_LABELS[key] || key);
    const pop = h('div', { id: 'hud-bgpick', class: 'hud-bgpick' });
    pop.appendChild(h('div', { class: 'hud-bgpick-head' },
      h('span', { class: 't' }, '⬒ Background — ' + label),
      h('button', { class: 'hud-sz-btn', type: 'button', 'data-bgact': 'closepick:' + key, title: 'Close' }, '✕')));
    const q = h('input', { class: 'hud-bgpick-q', type: 'text', placeholder:
      'Search — plates, your uploads, any interface art… Enter takes the top one', autocomplete: 'off', spellcheck: 'false' });
    pop.appendChild(q);
    const grid = h('div', { class: 'hud-bgpick-grid' });
    pop.appendChild(grid);
    pop.appendChild(h('div', { class: 'hud-el-note' },
      'Upload your own from the Deck Portal — Icons → HUD backgrounds. Uploads land here under Your art.'));
    const paint = () => {
      grid.innerHTML = '';
      const none = h('button', { class: 'hud-bgpick-tile is-none', type: 'button', title: 'No background' },
        h('span', { class: 'hud-bgpick-lbl' }, 'None'));
      none.addEventListener('click', function () { delete wbg[bgPickKey || key]; closeBgPick(); bgChanged(key); });
      grid.appendChild(none);
      for (const it of bgPickList(q.value)) {
        const tile = h('button', { class: 'hud-bgpick-tile', type: 'button', title: it.label });
        const im = h('img', { src: it.file, alt: '', draggable: 'false' });
        im.onerror = function () { try { tile.remove(); } catch (e) {} };
        tile.appendChild(im);
        tile.appendChild(h('span', { class: 'hud-bgpick-lbl' }, it.label));
        tile.addEventListener('click', function () {
          const prev = bgSanitize(wbg[key]);
          /* picking a file is the player saying "use this one" — forgive an
             earlier load failure so a since-uploaded path gets its retry */
          delete bgDead[it.file];
          wbg[key] = { file: it.file, scale: prev ? prev.scale : 1,
            opacity: prev ? prev.opacity : 1, fit: prev ? prev.fit : 'cover' };
          closeBgPick();
          bgChanged(key);
        });
        grid.appendChild(tile);
      }
    };
    q.addEventListener('input', paint);
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        const first = grid.querySelector('.hud-bgpick-tile:not(.is-none)');
        if (first) first.click();
      } else if (e.key === 'Escape') { e.stopPropagation(); closeBgPick(); }
    });
    paint();
    el.settings.appendChild(pop);
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 30);
  }
  function bgAct(spec) {
    const i = spec.indexOf(':');
    if (i < 0) return;
    const act = spec.slice(0, i), key = spec.slice(i + 1);
    if (act === 'closepick') { closeBgPick(); return; }
    const b = bgSanitize(wbg[key]);
    if (!b) return;
    if (act === 'smaller') b.scale = clamp(+(b.scale - BG_SCALE_STEP).toFixed(2), BG_SCALE_MIN, BG_SCALE_MAX);
    else if (act === 'bigger') b.scale = clamp(+(b.scale + BG_SCALE_STEP).toFixed(2), BG_SCALE_MIN, BG_SCALE_MAX);
    else if (act === 'fit') b.fit = b.fit === 'contain' ? 'cover' : 'contain';
    else if (act === 'dim') { b.opacity = +(b.opacity - 0.15).toFixed(2); if (b.opacity < 0.1) b.opacity = 1; }
    else if (act === 'clear') { delete wbg[key]; bgChanged(key); return; }
    wbg[key] = b;
    bgChanged(key);
  }
  window.hudCustomIcons = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    customIcons = (j && Array.isArray(j.custom)) ? j.custom.filter(function (c) {
      return c && bgPathOk(c.file);
    }) : [];
  };

  function hudOnlyPrefs() {
    const o = {};
    for (const k of DETAIL_KEYS) o[k] = !!wcfg[k];
    const det = {};
    for (const k of DET_KEYS) {
      const d = wdet[k];
      if (!d) continue;
      det[k] = { on: !!d.on, x: Math.round(num(d.x, 0)), y: Math.round(num(d.y, 0)),
        anchorH: d.anchorH === 'right' ? 'right' : d.anchorH === 'center' ? 'center' : 'left',
        anchorV: d.anchorV === 'bottom' ? 'bottom' : 'top',
        scale: +Number(d.scale || 1).toFixed(2) };
    }
    o.det = det;
    o.detSeeded = !!detSeeded;
    o.grp = { locked: !!wgrp.locked, x: Math.round(num(wgrp.x, 0)), y: Math.round(num(wgrp.y, 0)),
      anchorH: wgrp.anchorH === 'right' ? 'right' : wgrp.anchorH === 'center' ? 'center' : 'left',
      anchorV: wgrp.anchorV === 'bottom' ? 'bottom' : 'top',
      scale: +Number(wgrp.scale || 1).toFixed(2),
      /* 2026-08-18: the merged widget's two new facts. Both ride this blob
         because C++ stores `hud` verbatim — no bridge change, no C++ change,
         and an older DLL keeps them anyway. */
      orient: wgrp.orient === 'horiz' ? 'horiz' : 'vert',
      mem: (wgrp.mem && wgrp.mem.length) ? wgrp.mem.slice() : null,
      /* 2026-08-19: WHO is welded together. null = the three shipped members,
         which is also what every older config means. */
      keys: (wgrp.keys && wgrp.keys.length) ? wgrp.keys.slice() : null };
    /* (`cfgPos` is gone — the settings surface is a docked shelf now, so
       there is no remembered corner to write.)
       2026-08-19: which EDGE the shelf hangs on (Rober: "should be able to move
       to other side of screen, so you can line stuff on right if you need to").
       ⚠ This blob is a WHOLESALE replace on the C++ side (widgets.cpp stores
       `hud` verbatim), so a key that is not re-emitted here is destroyed on the
       next save — which is why it is written unconditionally, not only when it
       differs from the default. */
    o.shelf = { side: shelfSide() };
    /* widget backgrounds — same wholesale-replace law: emit on EVERY save */
    o.bg = bgPrefs();
    return o;
  }
  /* ---- which edge the shelf hangs on ------------------------------------
     Same idiom as the deck's Favorites Shelf (hd-shelf.js toggleSide): one ⇄
     button, a class on <body>, the value normalised on read so a hand-edited
     or older config can never put it somewhere that does not exist. */
  let shelfSideV = 'right';
  function shelfSide() { return shelfSideV === 'left' ? 'left' : 'right'; }
  function applyShelfSide() {
    el.body.classList.toggle('hud-cfg-left', shelfSide() === 'left');
    const b = document.getElementById('hud-shelf-side');
    if (b) b.title = shelfSide() === 'left'
      ? 'Dock the shelf on the right edge'
      : 'Dock the shelf on the left edge';
  }
  function setShelfSide(side) {
    shelfSideV = (side === 'left') ? 'left' : 'right';
    applyShelfSide();
    saveWidgetCfg();
  }

  /* ======================================================================
     FOLLOWER STRIP — unchanged. It is play-proven; this pass does not touch it
     beyond folding its emptiness into the whole-assembly verdict.
     ====================================================================== */
  function srcFor(file) {
    const s = String(file || '');
    return /^(data:|https?:|blob:)/i.test(s) ? s : 'portraits/' + s;
  }

  /* Every face and medal holds ONE inner .hud-face-in wrapper. It exists for
     the diamond shape (the frame rotates 45°, the wrapper counter-rotates so
     the face stays upright) and is inert for every other shape — building it
     unconditionally means switching shapes is a pure CSS class flip with no
     chip rebuild. */
  function medalOf(m, hue) {
    const medal = h('span', { class: 'hud-medal' },
      h('span', { class: 'hud-face-in' }, initialsOf(m.name)));
    medal.style.setProperty('--hud-hue', String(hue));
    return medal;
  }

  function faceEl(m, hue) {
    const file = m.file;
    if (!file) return medalOf(m, hue);
    const wrap = h('span', { class: 'hud-face' });
    wrap.style.setProperty('--hud-hue', String(hue));
    const raw = srcFor(file);
    const bust = m.mtime && !/^(data:|blob:)/i.test(raw) ? raw + '?v=' + m.mtime : raw;
    const img = h('img', { class: 'hud-face-img', src: bust, alt: '', draggable: false });
    // Crop transform — same math the deck applies so a framed face frames here.
    const c = m.crop;
    if (c && typeof c.z === 'number') {
      img.style.transformOrigin = '50% 50%';
      img.style.transform = 'translate(' + ((c.x || 0) * 100).toFixed(3) + '%,' +
        ((c.y || 0) * 100).toFixed(3) + '%) scale(' + Number(c.z).toFixed(4) + ')';
      img.style.objectPosition = '50% 50%';
    }
    // Query-hostile Ultralight loader: retry the raw path once, then initials.
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried && bust !== raw) { retried = true; img.src = raw; return; }
      toGame('hudLog', 'HUD portrait failed: ' + raw);
      if (wrap.parentNode) wrap.parentNode.replaceChild(medalOf(m, hue), wrap);
    });
    wrap.appendChild(h('span', { class: 'hud-face-in' }, img));
    return wrap;
  }

  /* Hurt ring (Rober, 2026-08-17): a STATIC red ring around anyone under a
     quarter health — the one who needs the heal reads at a glance. No flash,
     no pulse: the no-looping-animation law owns this surface. Meaningful only
     while the health field arrives (the hp toggle), and never on the dead —
     they have their own grey state. */
  function isHurt(m) {
    const p = m && m.hp;
    if (!p || typeof p !== 'object' || m.dead) return false;
    const mx = Number(p.max) || 0;
    return mx > 0 && (Number(p.cur) || 0) / mx < 0.25;
  }

  /* ---- per-face extras (Party Sheet catch-up, 2026-08-17) ---------------- *
   * Level badge on the portrait corner, stacked hp/mk/st bars, a direction
   * chevron with meters. The DLL sends a field ONLY while its toggle is on,
   * so presence in the row is the whole contract — an older DLL simply draws
   * the classic chip. The chevron glyph is ➤ (already proven in the deck's
   * equip tiles); it points right at rest, so rotate(deg − 90) makes the
   * DLL's 0° = "dead ahead" point up. */
  function barsEl(m) {
    /* .hud-cb, NOT .hud-bar — that class belongs to the WIDGET meter system,
       whose unscoped rules restyled these into the vertical red slivers of
       the 2026-08-18 play-test ("weird red lines to the left"). Plain divs,
       track + width-driven fill: the exact DOM shape the widget meters use,
       which the Ultralight probe verified painting. */
    const defs = [['hp', 'Health'], ['mk', 'Magicka'], ['st', 'Stamina']];
    const kids = [];
    for (let i = 0; i < defs.length; i++) {
      const k = defs[i][0], p = m[k];
      if (!p || typeof p !== 'object') continue;
      const mx = Number(p.max) || 0;
      const cur = Math.max(0, Math.min(Number(p.cur) || 0, mx || 1));
      const bar = h('div', { class: 'hud-cb ' + k,
        title: defs[i][1] + ' ' + cur + ' / ' + mx });
      const fill = h('div', { class: 'hud-cb-fill' });
      fill.style.width = (mx > 0 ? Math.round(cur / mx * 100) : 0) + '%';
      bar.appendChild(fill);
      kids.push(bar);
    }
    if (!kids.length) return null;
    const w = h('div', { class: 'hud-cbars' });
    for (let i = 0; i < kids.length; i++) w.appendChild(kids[i]);
    return w;
  }

  /* 8-direction glyph, not a rotated glyph: inline-transform rotation is
     unproven in this engine (the 2026-08-18 chevron sat frozen in-game), and
     a plain BMP arrow at 12px reads better anyway. 0° = dead ahead = ↑,
     clockwise. */
  const DIR_GLYPHS = ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'];
  function dirGlyph(deg) {
    let d = Number(deg) || 0;
    d = ((d % 360) + 360) % 360;
    return DIR_GLYPHS[Math.round(d / 45) % 8];
  }
  /* The needle (hud-dir-needle): a drawn gold compass pointer rotated to the
     EXACT bearing, replacing the 8-step text arrow that snapped between
     characters and read as a broken glyph (Rober, 2026-08-18: "visually it
     doesnt look good - the icon"). Rotation is CUMULATIVE — the shortest
     angular step is added to a running total kept on the element, so 350°→10°
     turns 20° clockwise instead of spinning 340° back through the dial; the
     existing .25s ease transition does the smoothing. Every follower chip
     carries its OWN needle fed its own bearing. */
  const DIR_NEEDLE = ['M12 3.4 L16 14.5 L12 12.2 L8 14.5 Z', ['circle', 12, 17.6, 1.7]];
  function setNeedle(ar, deg) {
    let d = Number(deg) || 0;
    d = ((d % 360) + 360) % 360;
    const prev = Number(ar.getAttribute('data-rot'));
    let rot = d;
    if (isFinite(prev)) {
      let delta = d - (((prev % 360) + 360) % 360);
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      rot = prev + delta;
    }
    ar.setAttribute('data-rot', String(rot));
    ar.style.transform = 'rotate(' + rot + 'deg)';
  }
  function dirEl(m) {
    const d = h('div', { class: 'hud-dir' });
    const ar = h('span', { class: 'hud-dir-ar' }, svgIcon(DIR_NEEDLE, 16));
    setNeedle(ar, m.dir);
    d.appendChild(ar);
    d.appendChild(h('span', { class: 'hud-dir-m' }, m.dist != null ? m.dist + 'm' : ''));
    return d;
  }

  function chipEl(m, i) {
    const hue = (typeof m.hue === 'number') ? m.hue : hueOf(i);
    const chip = h('div', { class: 'hud-chip' + (m.dead ? ' hud-dead' : '')
                                              + (isHurt(m) ? ' hud-hurt' : '') });
    const box = h('span', { class: 'hud-facebox' });
    box.appendChild(faceEl(m, hue));
    if (m.lvl != null) box.appendChild(h('b', { class: 'hud-lvl', title: 'Level ' + m.lvl }, String(m.lvl)));
    chip.appendChild(box);
    const bars = barsEl(m);
    if (bars) chip.appendChild(bars);
    if (m.dir != null) chip.appendChild(dirEl(m));
    chip.appendChild(h('div', { class: 'hud-name', title: m.name || '' }, m.name || '—'));
    return chip;
  }

  /* PERF. This is an always-on view, so every rebuild here is Ultralight work
     that lands behind the game. C++ only pushes hudData when the roster JSON
     changed — but the fields that move most (dead, following, a rename) do not
     touch the PORTRAIT, and the old code still threw away every chip and built
     a fresh <img> for each one, i.e. a re-request + re-decode of every face for
     a change of one CSS class. So the portrait identity is hashed separately
     from the volatile bits: same faces in the same order = patch the class and
     the name in place, anything else = the full rebuild exactly as before. */
  let lastFaceSigs = [];
  function faceSig(m, i) {
    const c = m.crop || {};
    /* The trailing x-block is the extras' STRUCTURE (which of level / bars /
       chevron this row carries) — toggling one in settings must rebuild the
       chip, while the values moving (health falling, someone walking away)
       stay on the cheap patch path below. */
    return [m.file || '', m.mtime || '', (typeof m.hue === 'number') ? m.hue : hueOf(i),
      (typeof c.z === 'number') ? [c.z, c.x || 0, c.y || 0].join(',') : '',
      'x' + [m.lvl != null ? 1 : 0, m.hp ? 1 : 0, m.mk ? 1 : 0, m.st ? 1 : 0,
        m.dir != null ? 1 : 0].join('')].join('|');
  }

  function render() {
    const sigs = followers.map(faceSig);
    const same = sigs.length === lastFaceSigs.length &&
                 sigs.every((s, i) => s === lastFaceSigs[i]) &&
                 el.strip.children.length === sigs.length;
    if (same) {
      // Faces are untouched — write only what actually moved.
      followers.forEach((m, i) => {
        const chip = el.strip.children[i];
        if (!chip) return;
        chip.classList.toggle('hud-dead', !!m.dead);
        chip.classList.toggle('hud-hurt', isHurt(m));
        const nm = chip.querySelector('.hud-name');
        const txt = m.name || '—';
        if (nm && nm.textContent !== txt) { nm.textContent = txt; nm.title = m.name || ''; }
        /* Extras: values move every push; write them in place. Structure is
           part of faceSig, so an element queried here always exists. */
        if (m.lvl != null) {
          const lv = chip.querySelector('.hud-lvl');
          if (lv && lv.textContent !== String(m.lvl)) {
            lv.textContent = String(m.lvl);
            lv.title = 'Level ' + m.lvl;
          }
        }
        const POOLS = { hp: 'Health', mk: 'Magicka', st: 'Stamina' };
        for (const k in POOLS) {
          const p = m[k];
          if (!p || typeof p !== 'object') continue;
          const bar = chip.querySelector('.hud-cb.' + k);
          if (!bar) continue;
          const mx = Number(p.max) || 0;
          const cur = Math.max(0, Math.min(Number(p.cur) || 0, mx || 1));
          const w = (mx > 0 ? Math.round(cur / mx * 100) : 0) + '%';
          const fill = bar.firstChild;
          if (fill && fill.style.width !== w) fill.style.width = w;
          bar.title = POOLS[k] + ' ' + cur + ' / ' + mx;
        }
        if (m.dir != null) {
          const ar = chip.querySelector('.hud-dir-ar');
          if (ar) setNeedle(ar, m.dir);
          const dm = chip.querySelector('.hud-dir-m');
          if (dm && m.dist != null) {
            const t = m.dist + 'm';
            if (dm.textContent !== t) dm.textContent = t;
          }
        }
      });
    } else {
      el.strip.innerHTML = '';
      followers.forEach((m, i) => el.strip.appendChild(chipEl(m, i)));
      lastFaceSigs = sigs;
    }
    renderWidgets();
    /* `is-empty` = no followers (the place-me hint keys off it, unchanged).
       `is-blank` = nothing at all to draw, which is what hides the panel. */
    applyNav();   // selection survives the rebuild
    el.panel.classList.toggle('is-empty', followers.length === 0);
    refreshPanelBlank();
    applyOrient();
    fitWidgets();
  }

  /* Keep the assembly on the screen. With every block switched on the stack is
     taller than the viewport (measured 1769px against a 1440-line screen), and
     nothing can scroll it back: during play the whole view is pointer-events
     none. So when it does not fit, the stack WRAPS into columns — full-size
     text, growing away from the anchored corner, which is the only direction
     that does not move the thing the player placed.

     Everything here is measured in UNSCALED px because #hud carries
     `transform: scale(--hud-scale)`: the room a 1440px screen offers a 1.35x
     assembly is 1067 of its own px, not 1440. Two guards keep this honest —
     a floor of 160px so a tiny window cannot collapse the stack to a smear of
     one-block columns, and a signature check so the layout reads
     (offsetHeight / scrollHeight) only happen when something that could change
     the answer actually changed. */
  /* Measured every render on purpose. The first version cached the answer
     behind a signature of the cheap inputs (scale, y, anchor, block count) and
     was WRONG — the probe caught it never wrapping at all, because the first
     evaluation ran while the panel was still blank (offsetHeight 0, so "it
     fits") and no cheap input changed afterwards to invalidate it.

     While wrapped, scrollHeight is the CAPPED height and says nothing about
     whether one column would fit again, so the constraint is lifted for the
     measurement — but only when it is actually on, so the common case costs no
     extra reflow. Nothing is written unless the verdict changes. */
  let lastWrapW = -1;
  function fitWidgets() {
    const w = el.widgets;
    if (!w) return;
    /* Not laid out yet — a blank panel or a hidden view. Decide nothing and
       keep whatever we have; deciding here is what produced the bug above. */
    if (!widgetsDrawn() || !el.panel.offsetHeight) return;
    const wrapped = w.classList.contains('is-wrapped');
    /* Steady state, and this runs on the live widget tick: while wrapped and
       the column count has not moved, the content cannot have shrunk enough to
       fit one column again — so take the cheap read and leave. Only a change in
       scrollWidth (a column gained or lost) is worth the unwrap-and-remeasure. */
    if (wrapped && w.scrollWidth === lastWrapW) return;
    if (wrapped) { w.classList.remove('is-wrapped'); w.style.maxHeight = ''; }
    const natural = w.scrollHeight;
    const scale = num(cfg.scale, 1) || 1;
    const vh = window.innerHeight || 1080;
    /* Room from the anchored edge to the far edge, in the stack's OWN px:
       #hud carries transform: scale(--hud-scale), so a 1440-line screen offers
       a 1.35x assembly 1067 of its own px, not 1440. */
    const room = Math.max(0, vh - Math.max(0, num(cfg.y, 0)) - 16) / scale;
    /* Panel chrome + follower strip = whatever the panel spends that is not the
       stack. Measured, because the strip follows the avatar size and the
       caption setting. */
    const chrome = Math.max(0, el.panel.offsetHeight - w.offsetHeight);
    let cap = Math.max(160, room - chrome);
    /* Wrapping trades height for width, so the width has to be affordable too.
       A column is the unwrapped stack's own width plus the 10px gap; if the
       columns the cap implies cannot fit sideways, raise the cap until they do
       (a taller stack that stays on screen beats a wider one that leaves it).
       Room is measured from the anchored edge, which is why cfg.x works for
       either anchor — the assembly grows away from its corner. */
    const vw = window.innerWidth || 1920;
    const colW = Math.max(1, w.offsetWidth + 10);
    const availW = Math.max(0, vw - Math.max(0, num(cfg.x, 0)) - 16) / scale;
    const maxCols = Math.max(1, Math.floor(availW / colW));
    if (natural > cap + 1 && Math.ceil(natural / cap) > maxCols)
      cap = Math.ceil(natural / maxCols);
    if (natural > cap + 1) {
      const px = Math.round(cap) + 'px';
      w.classList.add('is-wrapped');
      if (w.style.maxHeight !== px) w.style.maxHeight = px;
      lastWrapW = w.scrollWidth;
    } else {
      lastWrapW = -1;
    }
  }



  /* ---- placement ------------------------------------------------------- */
  // orient = row vs column; anchor = which corner it hangs off and therefore
  // which way it grows. A row anchored right grows leftward (row-reverse); a
  // column anchored bottom grows upward (column-reverse). Body carries a-right /
  // a-bottom so the CSS reverses the strip.
  function applyOrient() {
    el.strip.classList.toggle('horiz', cfg.orient !== 'vert');
    el.strip.classList.toggle('vert', cfg.orient === 'vert');
    el.body.classList.toggle('a-right', cfg.anchorH === 'right');
    el.body.classList.toggle('a-bottom', cfg.anchorV === 'bottom');
  }
  /* `fast` = we are mid-drag. The cheap half (pure style WRITES) always runs;
     the measured half below is skipped, because it is three forced synchronous
     layouts of the whole HUD and running them per pointermove is the second
     drag-lag mechanism in this view.

     ⚠ THE PATTERN, so it is not re-introduced: this function writes styles,
     then READS el.hud.getBoundingClientRect(), then writes again, then READS
     el.tools.offsetHeight, then writes again. Every read after a write forces
     the engine to lay the panel + strip + widget stack out synchronously — and
     Ultralight runs these views with the compositor OFF, so that is a full CPU
     relayout and repaint per mouse move. The panel crawled behind the cursor
     for exactly that reason. The measured pass now runs on drag END (and on
     every other caller, which are all one-shots), where three layouts cost
     nothing. */
  function applyPlacement(fast) {
    const s = el.hud.style;
    if (cfg.anchorH === 'right') { s.right = cfg.x + 'px'; s.left = 'auto'; }
    else { s.left = cfg.x + 'px'; s.right = 'auto'; }
    if (cfg.anchorV === 'bottom') { s.bottom = cfg.y + 'px'; s.top = 'auto'; }
    else { s.top = cfg.y + 'px'; s.bottom = 'auto'; }
    s.setProperty('--hud-scale', String(cfg.scale));
    // Scale outward from the anchored corner so the anchor point stays fixed.
    s.transformOrigin = (cfg.anchorV === 'bottom' ? 'bottom' : 'top') + ' ' +
      (cfg.anchorH === 'right' ? 'right' : 'left');
    if (el.tools) {
      /* Counter-scale as a PLAIN LITERAL, set here rather than a CSS
         calc(1 / var(…)) — calc division inside scale() is the one arithmetic
         this engine has never been probed on, and a dropped declaration there
         means a 2.6×-scaled toolbar (a lock-in). transform-origin stays in
         CSS; setting transform does not disturb it.
         Write-only, so it rides the fast half and a RESIZE drag still keeps
         the bar at 1x while the corner is being dragged out. */
      el.tools.style.transform = 'scale(' + (1 / (cfg.scale || 1)) + ')';
      /* Mirror to the anchored edge: pinned left it grows RIGHT — off-screen
         when the assembly hugs the right edge (the 497px six-button row is
         wider than a one-follower panel; nowrap means it cannot fold back).
         Pin to whichever edge the assembly is anchored to, so it always grows
         INTO the screen. */
      const rightEdge = cfg.anchorH === 'right';
      el.tools.style.left = rightEdge ? 'auto' : '0';
      el.tools.style.right = rightEdge ? '0' : 'auto';
    }
    if (fast) return;   // mid-drag: no reads, no relayout storm
    /* The edit toolbar hangs 40px ABOVE the panel — off-screen when the HUD is
       parked at the top edge. Flip it under the panel instead; found in the
       2026-08-17 overlap pass at y < 48. The BODY carries the flag too, because
       the hint line and the settings card also live at top:100% and must step
       down out of the toolbar's way (that collision was the second thing the
       same pass caught: a 666×16 overlap of .hud-tools on .hud-hint). */
    /* The toolbar wraps, so 48px is not a constant — measure what it actually
       needs (it is display:none until editing, hence the || 40 fallback) and
       flip it under the panel when there is not that much room above. */
    const toolsH = (el.tools && el.tools.offsetHeight) || 40;
    /* MEASURED, not anchor-guessed: a bottom-anchored tall panel also puts
       the bar off the top (Opus verification measured tools[-30..7] at 2.6),
       and the counter-scaled bar's layout height IS its screen height. */
    const panelTop = el.hud.getBoundingClientRect ? el.hud.getBoundingClientRect().top : cfg.y;
    const below = panelTop < toolsH + 8;
    if (el.tools) el.tools.classList.toggle('below', below);
    el.body.classList.toggle('hud-tools-below', below);
    if (el.tools) {
      const right = cfg.anchorH === 'right';
      el.tools.style.transformOrigin = (below ? 'top' : 'bottom') + (right ? ' right' : ' left');
      /* The hint step-down below a flipped toolbar was 50 LOCAL px — but the
         counter-scaled bar has a FIXED screen height, so at scale < 0.83 it
         painted over what sits under it. Measure the real gap instead (screen
         px → local px is ÷ scale). The settings card no longer needs this: it
         is a free popout outside #hud and cannot collide with the toolbar. */
      const stepPx = below ? Math.ceil((el.tools.offsetHeight / (cfg.scale || 1)) + 12) : 0;
      const hintEl = document.querySelector('.hud-hint');
      if (hintEl) hintEl.style.marginTop = stepPx ? stepPx + 'px' : '';
    }
  }

  /* ---- the retired panel shell (Rober, 2026-08-18) -----------------------
     "i dont understand the point of the follower face? right now it s
     basically enforced as having on??? … The only point i can think of is
     just adding a settings wheel widget or something that doesnt display,
     only when configuring."

     The movable #hud-panel used to be a real plate — background, border,
     padding — wrapped around the follower strip AND the widget stack. Since
     every stack block floats by default the stack is empty, so all that plate
     did was draw a permanent box around the follower faces. It is now
     chrome-free during play: the strip floats visually on its own like every
     other widget, and the only panel-shaped thing left is the ⚙ grip, which
     appears ONLY while configuring so the strip can still be grabbed, flipped
     and resized exactly as before. Nothing about cfg.x/y/scale/orient or the
     hudSave contract changed — this is presentation, not placement. */
  function applyShell() {
    el.body.classList.toggle('hud-shell-bare', !editing);
  }
  /* ---- the strip's edit SCOPE (round 3) ---------------------------------- */
  const HINT_WIDGETS = 'Drag any widget to move it · the mouse wheel over one resizes it · ' +
    '⚙ Widgets opens the shelf — every element, its size and its options · Done to lock';
  const HINT_STRIP = 'Follower strip: drag the bar to move · corner to resize · Flip for row/column · ' +
    'Grow to change which corner it grows from · Done to lock';
  function stripEditing() { return editing && stripEdit; }
  function applyStripEdit() {
    el.body.classList.toggle('hud-strip-edit', stripEditing());
    /* the hint line under the assembly says what THIS scope can do — a strip
       hint over a screen of widgets was the old lie */
    if (el.hint) setText(el.hint, stripEditing() ? HINT_STRIP : HINT_WIDGETS);
  }
  /* Arm / disarm it. Everything the class changes is measured chrome (the
     toolbar's height feeds applyPlacement's flip-above/below decision), so the
     class flip HAS to land before the placement pass — the 2026-08-18
     zero-height-toolbar lesson, in the other direction. */
  function setStripEdit(on) {
    const next = !!on && editing;
    if (next === stripEdit) return;
    stripEdit = next;
    applyStripEdit();
    applyVisible();
    applyPlacement();
    render();
    if (cfgOpen) buildSettings();
  }

  // Cycle the anchor corner TL → TR → BR → BL, preserving the panel's on-screen
  // position across the flip so it doesn't jump when you change growth direction.
  function cycleAnchor() {
    const r = el.hud.getBoundingClientRect();
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    const right = cfg.anchorH === 'right', bottom = cfg.anchorV === 'bottom';
    if (!right && !bottom) cfg.anchorH = 'right';
    else if (right && !bottom) cfg.anchorV = 'bottom';
    else if (right && bottom) cfg.anchorH = 'left';
    else cfg.anchorV = 'top';
    cfg.x = (cfg.anchorH === 'right') ? Math.max(0, vw - r.right) : Math.max(0, r.left);
    cfg.y = (cfg.anchorV === 'bottom') ? Math.max(0, vh - r.bottom) : Math.max(0, r.top);
    applyOrient(); applyPlacement(); saveCfg();
  }
  /* Never hide the assembly WHILE EDITING — a visible:false config push landing
     mid-edit would vanish the toolbar with focus and the pause still live (the
     latent lock-in the Opus audit flagged; C++'s HudApplyVisibility already
     defends the same idea with `|| g_hudEditing`). */
  function applyVisible() {
    /* STRIP-ONLY. cfg.visible is the follower HUD's flag; the widget stack
       and free widgets are their own features and must survive it — hiding
       the whole assembly here is what made 'hud widgets, i see none of them
       now' (2026-08-18). body.hud-hidden stays reserved for hudSetVisible's
       all-off path. */
    /* ⚠ `!editing` became `!stripEditing()` in round 3 (2026-08-19): entering
       edit mode to place a WIDGET must not reveal a strip the player has
       switched off. It is still force-shown while the strip itself is the thing
       being configured — you cannot place what you cannot see. */
    /* follower-hud-menu-gate: menus temporarily suppress the strip without
       changing the player's saved toggle. Only its own placement editor can
       reveal it through that gate (the editor itself pauses the game). */
    el.body.classList.toggle('hud-strip-off', (!cfg.visible || menusOpen) && !stripEditing());
    /* the panel's own verdict depends on whether the strip is drawn, so it has
       to be re-taken here and not only on the next render() */
    refreshPanelBlank();
    /* hud.html BOOTS <body class="hud-hidden"> so nothing flashes before the
       first config arrives — the reveal lives here, and losing it in the
       strip-only rewrite blanked the ENTIRE view (caught by the ul-probe,
       2026-08-18: hudDrawn:false, bodyClasses "hud-hidden"). */
    el.body.classList.remove('hud-hidden');
  }
  function applyNames() { el.body.classList.toggle('hud-names-off', !cfg.showNames); }
  /* Shape is a strip-level class flip — chips never rebuild for it (the
     diamond's counter-rotation wrapper is built into every face already). */
  function applyCompact() { el.body.classList.toggle('hud-compact', !!cfg.compact); }
  function applyShape() {
    for (let i = 0; i < SHAPES.length; i++) el.strip.classList.remove('face-' + SHAPES[i]);
    el.strip.classList.add('face-' + (SHAPES.indexOf(cfg.faceShape) !== -1 ? cfg.faceShape : 'circle'));
  }

  function applyConfig() { applyPlacement(); applyOrient(); applyVisible(); applyNames(); applyShape(); applyCompact(); applyShell(); applyWidgetCfg(); }

  // x/y are distances from the anchored edges, so keep them non-negative and
  // short of the far edge — a corner of the assembly always stays on-screen.
  function clampToView() {
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    cfg.x = clamp(cfg.x, 0, Math.max(0, vw - 48));
    cfg.y = clamp(cfg.y, 0, Math.max(0, vh - 48));
  }

  function saveCfg() {
    clampToView();
    toGame('hudSave', JSON.stringify({
      x: Math.round(cfg.x), y: Math.round(cfg.y),
      scale: Number(cfg.scale.toFixed(3)), orient: cfg.orient,
      anchorH: cfg.anchorH, anchorV: cfg.anchorV, showNames: !!cfg.showNames,
    }));
  }

  /* ======================================================================
     WIDGET SETTINGS CARD — edit mode only.
     Individual toggles AND presets. Every control is a real button with hover,
     active and on states; nothing under 12px; a toggle whose data the game is
     not currently sending says so instead of pretending.
     ====================================================================== */
  let cfgOpen = false;
  const OPT_LABELS = {
    snapRects: 'Snap rectangular widgets',
    ornateClock: 'Ornate celestial clock', clockFrame: 'Clock background & frame', clockMotion: 'Clock animation', clockDate: 'Date under the clock',
    lockpicks:'Lockpicks', weatherOnly:'Weather', weatherCenter:'Center text',
    calendar:'Date & season', calendarDay:'Day of month', calendarMonth:'Month name', calendarSeason:'Season name', needsSeparate:'Place each need separately', needsIconsOnly:'Icons only · hide need text', needFood:'Food · SunHelm', needDrink:'Drink · SunHelm', needSleep:'Sleep · SunHelm', needCold:'Cold · SunHelm',
    gold: 'Gold', carry: 'Carry weight', time: 'Time', context: 'Weather / place',
    /* ⚠ `pots` had NO entry here, so the Potions switch rendered as a nameless
       empty button in the Readout lines row — a control with nothing written on
       it (Opus audit, 2026-08-18). Every key in LINE_KEYS / BLOCK_KEYS /
       FW_SLOT_GROUP / DETAIL_KEYS must appear in this table; there is a harness
       check for exactly that now. */
    pots: 'Potions',
    mount: 'Mount', pins: 'Pinned items', sets: 'Collections',
    vitals: 'Health · magicka · stamina', resist: 'Resistances', effects: 'Active effects',
    equip: 'Equipped', survival: 'Survival needs', allies: 'Quest allies',
    handR: 'Right hand', handL: 'Left hand · ammo', voice: 'Shout / power', quick: 'Quick items',
    quick2: 'My items — pick your own', lootStatus: 'Loot lamp — glow · auto-loot',
    season: 'Season',
    ward: 'Ward — up or down',
    pinLabels: 'Item names', badges: 'Badges', barNumbers: 'Bar numbers', clock24: '24-hour clock',
  };
  const OPT_ABSENT = {
    gold: () => !haveGold(), carry: () => !haveCarry(), time: () => !haveTime(), context: () => !haveCtx(),
    mount: () => !live.mount, pins: () => !pinsList().length, sets: () => !setsList().length,
    vitals: () => !haveVitals(), resist: () => !haveResist(), effects: () => !haveEffects(),
    equip: () => !haveEquip(), survival: () => !haveSurvival(), allies: () => !haveAllies(),
    handR: () => !eqBySlot('right'), handL: () => !eqBySlot('left') && !eqBySlot('ammo'),
    voice: () => !eqBySlot('voice'), quick: () => !quickList().length,
    /* quick2 is never "absent" for want of data — an empty list is a list you
       have not filled yet, and the widget's own ＋ is how you fill it. The lamp
       IS absent until a loot mod answers. */
    lootStatus: () => !lootState(),
    /* Greyed when nothing can honestly name the season — Seasons of Skyrim not
       installed and no INI map, or seasons switched off. The switch still
       flips; grey means "nothing to show right now", not "broken". */
    season: () => !live.season,
    /* Absent while the player knows no ward and none is active — the widget
       then has nothing honest to say. */
    ward: () => !live.ward,
  };

  function optButton(key) {
    const b = h('button', {
      class: 'hud-opt' + (wcfg[key] ? ' on' : ''), type: 'button', 'data-opt': key,
      title: OPT_LABELS[key],
    }, OPT_LABELS[key]);
    const absent = OPT_ABSENT[key];
    if (absent && absent()) { b.classList.add('is-absent'); b.title = OPT_LABELS[key] + ' — nothing to show right now'; }
    return b;
  }
  /* (The old `group(label, keys)` row builder is retired 2026-08-19 — the
     shelf files every switch under its OWN element row, so a bare row of
     nameless buttons no longer exists to build.) */
  /* ---- ONE scale control, reaching EVERY widget (2026-08-18) -------------
     Rober, mid-play-test: "in general every widget needs the same scalability
     and smoothness please."

     Every movable thing in this view already CARRIED a size — the assembly's
     `cfg.scale`, a floated block's `wdet[k].scale`, a free widget's
     `wfree[k].scale` — and the only way to reach any of them was to hold the
     mouse wheel over exactly the right pixels. That is undiscoverable, and it
     is impossible for a widget that is currently off or behind another one. So
     the ⚙ card grows the control, driven off the SAME fields the wheel and the
     mini toolbars write. No second scale system, no per-widget variant: one
     stepper, one clamp, one save. */
  const SCALE_STEP = 0.1;
  const FW_SCALE_MIN = 0.5, FW_SCALE_MAX = 2.5;   // the wheel's range, kept
  function scaleRef(id) {
    if (id === 'panel') return { w: cfg, node: null, min: SCALE_MIN, max: SCALE_MAX, panel: true };
    const at = String(id || '').indexOf(':');
    if (at === -1) return null;
    const kind = id.slice(0, at), k = id.slice(at + 1);
    if (kind === 'det' && wdet[k])
      return { w: wdet[k], node: k === 'fwgrp' ? grpEl(false) : detWrap(k, false),
        min: FW_SCALE_MIN, max: FW_SCALE_MAX, flat: true };
    if (kind === 'free' && wfree[k])
      return { w: wfree[k], node: elFree[k], min: FW_SCALE_MIN, max: FW_SCALE_MAX };
    return null;
  }
  function scaleOf(id) { const r = scaleRef(id); return r ? num(r.w.scale, 1) : 1; }
  function scaleSet(id, v) {
    const r = scaleRef(id);
    if (!r) return;
    r.w.scale = clamp(v, r.min, r.max);
    if (r.panel) { applyPlacement(); saveCfg(); return; }
    if (r.node) placeFree(r.node, { x: r.w.x, y: r.w.y, anchorH: r.w.anchorH, anchorV: r.w.anchorV,
      scale: r.w.scale, opacity: r.flat ? 1 : num(r.w.opacity, 1) });
    else applyDetach(false);   // floated but not drawn yet — let the normal pass place it
    saveWidgetCfg();
  }
  /* The one size stepper. `−  100%  ＋  ⟲`, with the widget it belongs to
     named on the left so the row still means something after the card is
     filtered. No range input — the deck's standing rule. */
  function sizeRow(id, label, note) {
    const row = h('div', { class: 'hud-sz-row', 'data-szname': String(label || '') });
    row.appendChild(h('span', { class: 'hud-sz-name', title: label }, label));
    const mk = (act, txt, title) => h('button', { class: 'hud-sz-btn', type: 'button',
      'data-szact': act, 'data-szid': id, title: title }, txt);
    row.appendChild(mk('smaller', '−', 'Smaller — ' + label));
    row.appendChild(h('span', { class: 'hud-sz-val', title: 'Size of ' + label },
      Math.round(scaleOf(id) * 100) + '%'));
    row.appendChild(mk('bigger', '＋', 'Bigger — ' + label));
    row.appendChild(mk('reset', '⟲', 'Back to 100% — ' + label));
    if (note) row.appendChild(h('span', { class: 'hud-sz-note' }, note));
    return row;
  }
  /* ⚠ The old "Size — every widget scales on its own" section is retired
     (2026-08-19): a second list of the same widgets, in a different order,
     is exactly the sibling-surface drift this shelf exists to end. Every
     size now rides its OWN element row (sizeIdFor → sizeRow), and an element
     with no size of its own says so there instead. */

  /* ---- the merged equipped widget's own section (2026-08-18) -------------
     Rober, play-test: "left / right / powers show as THREE different widgets…
     must become ONE widget with individual toggles inside it, plus one master
     toggle that by default toggles all three together" — and, in the same
     breath, no orientation choice and no scale. All four live here, nested
     under the master so the card reads as ONE thing with parts.

     `is-act` marks a button that DOES something rather than holding a state —
     it drops the tick box every .hud-opt otherwise wears, which on a "−" would
     read as a switch that is somehow off. */
  function grpActBtn(act, label, title, on) {
    return h('button', {
      class: 'hud-opt is-act' + (on ? ' on' : ''), type: 'button', 'data-grpact': act, title: title,
    }, label);
  }
  /* ======================================================================
     THE SHELF (2026-08-19) — one element, one row; the whole HUD in one list.
     Rober, play-test: "it should open a right popout shelf like action bar
     does, and have all configuration there, individual hud element
     configuration, scaling, resizing etc… ability to connect up widgets if
     you want to… easily searchable for settings."

     So the old ⚙ card's SHAPE is what changed, not its machinery: every
     switch is still `.hud-opt[data-opt]`, every size is still the one shared
     stepper (`sizeRow` → `scaleSet`), every float is still `[data-float]`.
     What is new is that they are grouped BY ELEMENT instead of by kind — a
     row per widget carrying its own on/off, its own size and its own options
     — plus link/unlink into the group, and a filter that narrows by element.

     ⛔ FOLLOWER-ORGANIZER SETTINGS DO NOT LIVE HERE (Rober, same play-test:
     "the hud widget settings need to be separate from the follower organizer
     ones"). The strip section at the bottom carries its PLACEMENT only —
     size, row/column, corner, captions — and says out loud where the roster,
     faces and portraits are configured.
     ====================================================================== */
  /* Gold-glyph art per element, with a typographic mark behind it (the deck's
     no-emoji law: an <img> plus a text fallback that removes itself on error,
     never a coloured emoji). Only files that exist in icons/custom are named
     here; an element with no art just wears its mark. */
  const EL_ICON = {
    lockpicks:'icons/custom/wg-lockpick.png', weatherOnly:'icons/custom/wx-clear.png',
    calendar:'icons/custom/hm-time.png', needFood:'icons/custom/ps-food.png', needDrink:'icons/custom/sv-drink.png', needSleep:'icons/custom/hk-bed.png', needCold:'icons/custom/wx-snow.png',
    gold: 'icons/custom/hud-gold.png', carry: 'icons/custom/hud-carry.png',
    time: 'icons/custom/hm-time.png', context: 'icons/custom/wx-clear.png',
    pots: 'icons/custom/ps-utility.png',
    vitals: 'icons/custom/ps-health.png', resist: 'icons/custom/res-magic.png',
    effects: 'icons/custom/sc-illusion.png', equip: 'icons/custom/hd-sword.png',
    survival: 'icons/custom/hm-survival.png', mount: 'icons/custom/hud-mount.png',
    pins: 'icons/custom/hm-items.png', sets: 'icons/custom/hm-quests.png',
    allies: 'icons/custom/hm-followers.png',
    handR: 'icons/custom/hd-sword.png', handL: 'icons/custom/hd-shield.png',
    voice: 'icons/custom/sc-shouts.png', quick: 'icons/custom/hk-quick-light.png',
    quick2: 'icons/custom/hm-items.png', lootStatus: 'icons/custom/hm-loot.png',
    season: 'icons/custom/sn-autumn.png',
    strip: 'icons/custom/hm-followers.png', fwgrp: 'icons/custom/hk-widgets.png',
    /* the Followers-HUD section's own rows (round 3) — no art of their own,
       so they wear their typographic marks below */
  };
  const EL_MARK = {
    gold: '¤', carry: '≡', time: '◷', context: '≈', pots: '◍',
    vitals: '❤', resist: '◈', effects: '✦', equip: '†', survival: '△',
    mount: '⌁', pins: '⚑', sets: '❈', allies: '⁂',
    handR: '†', handL: '◈', voice: '≋', quick: '★', quick2: '★', lootStatus: '✧',
    season: '❉',
    pinLabels: 'Aa', badges: '●', barNumbers: '№', clock24: '◷',
    strip: '⁂', fwgrp: '⌗',
    'strip-shape': '◇', 'strip-face': '☉', 'strip-compact': '▣', 'strip-keys': '⌨',
  };
  /* extra words the filter should match, so a player types what they CALL it */
  const EL_WORDS = {
    lockpicks:'lock picks lockpicking count inventory', weatherOnly:'weather rain snow sky outdoors indoors alignment center text',
    calendar:'date day month season calendar', calendarDay:'date day month calendar', calendarMonth:'month name calendar', calendarSeason:'season summer winter autumn spring calendar',
    needsIconsOnly:'sunhelm icons only compact no text trio grouped', needsSeparate:'sunhelm needs individual separate split group layout move position', needFood:'sunhelm hunger food need', needDrink:'sunhelm thirst water drink need', needSleep:'sunhelm fatigue sleep rest need', needCold:'sunhelm cold warmth need',
    gold: 'septims money purse', carry: 'weight encumbrance burden',
    time: 'clock hour day date', context: 'weather place location cell region',
    pots: 'potions healing magicka stamina drinks',
    vitals: 'health magicka stamina bars', resist: 'resistance fire frost shock armour',
    effects: 'buffs active spells', equip: 'equipped weapons gear',
    survival: 'hunger thirst warmth needs', mount: 'horse steed',
    pins: 'pinned tracked items', sets: 'collections goals',
    allies: 'quest allies companions', handR: 'right hand weapon spell',
    handL: 'left hand offhand ammo arrows shield', voice: 'shout power thuum dragon',
    quick: 'favourites favorites quick items', quick2: 'my items custom strip',
    lootStatus: 'loot lamp glow auto-loot',
    season: 'season winter spring summer autumn fall year month calendar seasons of skyrim',
    pinLabels: 'names labels',
    badges: 'badges', barNumbers: 'numbers bars', clock24: '24 hour clock',
    strip: 'followers hud strip party faces portraits roster place position size enable shown hidden row column corner names',
    fwgrp: 'equipped group linked hands shout',
    'strip-shape': 'shape circle rounded square diamond portrait cut',
    'strip-face': 'level badge direction distance health magicka stamina bars per face',
    'strip-compact': 'compact faces only browse',
    'strip-keys': 'key keys bind browse hotkey show hide toggle',
  };
  function elIcon(k) {
    const ic = h('span', { class: 'hud-el-ic' });
    const src = EL_ICON[k];
    const mark = EL_MARK[k] || '·';
    if (!src) { setText(ic, mark); return ic; }
    const im = h('img', { src: src, alt: '', draggable: 'false' });
    /* a missing/stale PNG degrades to the mark — never a broken-image box */
    im.onerror = function () { try { im.remove(); } catch (e) {} setText(ic, mark); };
    ic.appendChild(im);
    return ic;
  }
  /* Which floated key a stack element owns (the five readout lines were split
     out under ro* names; every other block key is its own det key). */
  const DET_OF = { lockpicks:'roLockpicks', weatherOnly:'roWeather', gold: 'roGold', carry: 'roCarry', time: 'roTime',
    context: 'roContext', pots: 'roPots' };
  /* …and back again: a floated block's mini toolbar knows its DET key, the
     shelf files its row under the wcfg key. */
  const KEY_OF_DET = (function () {
    const m = {};
    for (const k in DET_OF) m[DET_OF[k]] = k;
    return m;
  })();
  function detKeyOf(k) {
    if (DET_OF[k]) return DET_OF[k];
    return DET_KEYS.indexOf(k) !== -1 ? k : '';
  }
  /* The one size id an element answers to right now — the SAME ids the shared
     stepper already understands. '' means "this element has no size of its
     own at this moment", which the row then says out loud instead of showing
     a stepper that would silently do nothing. */
  function sizeIdFor(k) {
    if (FREE_KEYS.indexOf(k) !== -1)
      return (wgrp.locked && grpHas(k)) ? '' : 'free:' + k;
    const d = detKeyOf(k);
    return (d && detOn(d)) ? 'det:' + d : '';
  }
  function elChip(attr, val, label, title, on) {
    const b = h('button', { class: 'hud-el-chip' + (on ? ' on' : ''), type: 'button', title: title }, label);
    b.setAttribute(attr, val);
    return b;
  }
  /* ONE row per element: name + on/off, then its own size and its own options.
     `inGroup` rows are drawn nested inside the group card. */
  function elRow(k, inGroup) {
    const label = OPT_LABELS[k] || k;
    const row = h('div', { class: 'hud-el' + (inGroup ? ' is-nested' : '') , 'data-el': k,
      'data-elname': (label + ' ' + (EL_WORDS[k] || '')).toLowerCase() });
    const head = h('div', { class: 'hud-el-head' });
    head.appendChild(elIcon(k));
    head.appendChild(h('span', { class: 'hud-el-name', title: label }, label));
    /* the switch is the card's own optButton — same data-opt, same absent
       greying, same click path; only its face reads On/Off now that the name
       is written beside it. */
    const sw = optButton(k);
    sw.classList.add('hud-el-sw');
    setText(sw, wcfg[k] ? 'On' : 'Off');
    sw.title = (wcfg[k] ? 'Hide ' : 'Show ') + label +
      (sw.classList.contains('is-absent') ? ' — nothing to show right now' : '');
    if (k === 'snapRects') { sw.title = 'Toggle snapping while dragging rectangular widgets'; sw.setAttribute('aria-pressed', String(!!wcfg[k])); }
    head.appendChild(sw);
    row.appendChild(head);

    const body = h('div', { class: 'hud-el-body' });
    if (k === 'weatherOnly') {
      const center = optButton('weatherCenter');
      center.setAttribute('aria-pressed', String(!!wcfg.weatherCenter));
      body.appendChild(center);
    }
    if (NEED_READOUTS.some(d => d.key === k) && !wcfg.needsSeparate) body.appendChild(h('div', { class:'hud-el-note' }, 'Grouped with Survival needs. Enable separate placement to use its own position and size.'));
    const sid = sizeIdFor(k);
    const det = detKeyOf(k);
    if (sid) body.appendChild(sizeRow(sid, 'Size'));
    else if (inGroup) body.appendChild(h('div', { class: 'hud-el-note' },
      'Sized and placed with the group.'));
    else if (det) body.appendChild(h('div', { class: 'hud-el-note' },
      'Scales with the HUD panel — float it to give it a size of its own.'));

    const chips = h('div', { class: 'hud-el-chips' });
    if (det) {
      const on = detOn(det);
      chips.appendChild(elChip('data-float', det, on ? '⇲ Floating' : '⇱ Float it',
        on ? label + ' floats free — click to put it back in the HUD panel'
           : 'Take ' + label + ' out of the panel and drag it anywhere', on));
    }
    if (FREE_KEYS.indexOf(k) !== -1) {
      const linked = grpHas(k);
      chips.appendChild(elChip('data-grplink', k, linked ? '⛓ Linked' : '⛓ Link',
        linked ? 'Take ' + label + ' out of the group so it moves on its own'
               : 'Connect ' + label + ' into the group — one drag, one size, one place', linked));
    }
    if (chips.firstChild) body.appendChild(chips);
    /* a free widget's card can wear a background — a per-CARD skin, so it
       still applies while the widget is welded into the group */
    if (FREE_KEYS.indexOf(k) !== -1) body.appendChild(bgChipRow(k));
    if (body.firstChild) row.appendChild(body);
    return row;
  }
  function shelfSection(id, label, sub) {
    const sec = h('div', { class: 'hud-el-sec', 'data-sec': id },
      h('div', { class: 'hud-el-secname' }, label));
    if (sub) sec.appendChild(h('div', { class: 'hud-el-subhead' }, sub));
    return sec;
  }
  function buildElSection(id, label, keys, sub) {
    const sec = shelfSection(id, label, sub);
    for (const k of keys) {
      /* a free widget currently linked into the group is drawn INSIDE the
         group card — one element, one row, never two */
      if (FREE_KEYS.indexOf(k) !== -1 && wgrp.locked && grpHas(k)) continue;
      sec.appendChild(elRow(k, false));
    }
    return sec;
  }
  function buildGrpSection() {
    const keys = grpKeys();
    const anyOn = grpAnyOn();
    const names = keys.map(function (k) { return OPT_LABELS[k] || k; }).join(' · ');
    const sec = h('div', { class: 'hud-el-sec is-grp', 'data-sec': 'group' },
      h('div', { class: 'hud-el-secname' }, GRP_LABEL));
    const card = h('div', { class: 'hud-el is-card', 'data-el': 'fwgrp',
      'data-elname': ('group ' + GRP_LABEL + ' ' + names + ' ' + EL_WORDS.fwgrp).toLowerCase() });

    /* the master — DERIVED from the members, so it can never lie about them */
    const head = h('div', { class: 'hud-el-head' });
    head.appendChild(elIcon('fwgrp'));
    head.appendChild(h('span', { class: 'hud-el-name', title: names }, GRP_LABEL));
    head.appendChild(h('button', {
      class: 'hud-opt hud-el-sw hud-opt-master' + (anyOn ? ' on' : ''), type: 'button',
      'data-grpact': 'master',
      title: anyOn ? 'Hide the whole group — the members you had on are remembered'
                   : 'Show the group' + (grpAllOn() ? '' : ' — every member'),
    }, anyOn ? 'On' : 'Off'));
    card.appendChild(head);

    const body = h('div', { class: 'hud-el-body' });
    body.appendChild(h('div', { class: 'hud-el-note' }, names));

    /* orientation — vertical is the shipped default, horizontal is the ask */
    const orow = h('div', { class: 'hud-el-chips' });
    orow.appendChild(grpActBtn('vert', '↕ Column', 'Stack the members in a column',
      wgrp.orient !== 'horiz'));
    orow.appendChild(grpActBtn('horiz', '↔ Row', 'Lay the members out in a row',
      wgrp.orient === 'horiz'));
    orow.appendChild(h('button', {
      class: 'hud-el-chip' + (wgrp.locked ? ' on' : ''), type: 'button', 'data-grplock': '1',
      title: wgrp.locked ? 'The members move and scale as ONE — click to separate them'
                         : 'The members are separate — click to weld them back into one widget',
    }, wgrp.locked ? '⛓ One widget' : '⛓ Separated'));
    body.appendChild(orow);

    /* size — the SHARED stepper. Locked: one row for the whole group;
       separated: each member owns its own, on its own row below. */
    if (wgrp.locked) body.appendChild(sizeRow('det:fwgrp', 'Size'));
    card.appendChild(body);
    sec.appendChild(card);

    /* the members, each still its own row with its own switch */
    for (const k of keys) sec.appendChild(elRow(k, wgrp.locked));

    /* connect another widget in — the "ability to connect up widgets" ask */
    const spare = FREE_KEYS.filter(function (k) { return !grpHas(k); });
    if (spare.length) {
      const add = h('div', { class: 'hud-el-chips hud-el-add' },
        h('span', { class: 'hud-el-addlab' }, 'Connect a widget:'));
      for (const k of spare)
        add.appendChild(elChip('data-grplink', k, '＋ ' + (OPT_LABELS[k] || k),
          'Weld ' + (OPT_LABELS[k] || k) + ' into this group — it then moves, scales and hides with it', false));
      sec.appendChild(add);
    }
    sec.appendChild(h('div', { class: 'hud-el-note' }, wgrp.locked
      ? 'Welded: one drag, one size, one place. Turn a member off on its own row; the switch at the top hides all of them.'
      : 'Separated — each member is dragged, scaled and anchored on its own. Orientation and the group size apply once they are welded again.'));
    return sec;
  }
  /* ======================================================================
     THE FOLLOWERS HUD SECTION (2026-08-19, round 3)

     Rober: "the Followers HUD needs the same shelf treatment — its own config
     button opening a popout right panel… not whatever the hell this is",
     pointing at the deck drawer's inline strip of nineteen 9px chips
     (Enabled · Reposition · Vertical · Grows · Aa Names on · Lv badge ·
     Direction · Health · Magicka · Stamina · Widgets… · Circle · Rounded ·
     Square · Diamond · Compact · Set browse key · Shown · Set key).

     Every one of them is a REAL shelf row here, in the deck's own idioms: the
     on/off pill, the segmented shape row, the shared size stepper, the key
     capture rows. Nothing is reimplemented — each control sends the SAME
     `hudCfg` op the chip sent (enable / visible / orient / grow / names /
     part / shape / compact / bindnav / clearnav / bindkey / clearkey), which
     is why the two surfaces cannot drift.

     ⛔ AND THE SEPARATION STANDS: roster, faces and portraits stay in the
     deck's Followers tab. What lives here is the STRIP's display, placement
     and behaviour — exactly the chip list above. */
  /* Which shelf rows belong to the strip. Landing on any of them is what arms
     the strip's edit dress (setStripEdit) — see the stripEdit note up top. */
  const STRIP_SECTION_KEYS = ['strip', 'strip-shape', 'strip-face', 'strip-compact', 'strip-keys'];
  /* ONE door to C++, and it is the deck card's own: `hudCfg`. Registered on
     THIS view too since round 3 (main.cpp, marker hud-strip-cfg-bridge), so a
     shelf row and a deck chip run literally the same handler. */
  function stripCfg(op, extra) {
    toGame('hudCfg', JSON.stringify(Object.assign({ op: String(op) }, extra || {})));
  }
  /* The half of the strip's truth `hudConfig` cannot carry: `enabled` and
     `visible` are folded into one flag there (visible = enabled && visible),
     and the two bound keys / their arming state are deck-state only. Filled by
     window.hudCfgState below; null until the first reply, and every row that
     depends on one says so rather than guessing. */
  const strip = { enabled: null, visible: null, arming: false, navArming: false,
    key: null, navKey: null };
  function stripEnabled() { return strip.enabled === null ? !!cfg.visible : !!strip.enabled; }
  function stripShown() { return strip.visible === null ? !!cfg.visible : !!strip.visible; }
  function keyLabelOf(k) { return (k && k.label) ? String(k.label) : ''; }
  /* the per-face extras, in the order they read on a chip: badge, bearing,
     then the three pools. `on` is read from cfg — hudConfig carries all five. */
  const STRIP_PARTS = [
    ['level', 'Lv badge', 'A level badge on each portrait', function () { return cfg.showLevel !== false; }],
    ['dir', '➤ Direction', 'A needle pointing at her, with the distance in metres', function () { return cfg.showDir !== false; }],
    ['hp', '♥ Health', 'A live health bar under each face', function () { return cfg.showHp !== false; }],
    ['mk', '✦ Magicka', 'A live magicka bar under each face', function () { return cfg.showMk === true; }],
    ['st', '➶ Stamina', 'A live stamina bar under each face', function () { return cfg.showSt === true; }],
  ];
  const SHAPE_LABELS = { circle: '◯ Circle', rounded: '▢ Rounded', square: '■ Square', diamond: '◆ Diamond' };
  const SHAPE_TITLES = {
    circle: 'Round portraits — the classic strip',
    rounded: 'Rounded-corner squares',
    square: 'Sharp squares',
    diamond: 'Rotated diamonds, Party Sheet style',
  };
  /* A shelf row that is NOT a widget switch: a name, an optional badge, and a
     body of chips. Same skeleton elRow builds, so the filter, the focus ring
     and the section-hiding all work on it untouched. */
  function stripRow(key, label, words, badge) {
    const row = h('div', { class: 'hud-el', 'data-el': key,
      'data-elname': ('follower strip ' + label + ' ' + (words || '')).toLowerCase() });
    const head = h('div', { class: 'hud-el-head' });
    head.appendChild(elIcon(key));
    head.appendChild(h('span', { class: 'hud-el-name', title: label }, label));
    if (badge) head.appendChild(h('span', { class: 'hud-el-badge' }, badge));
    row.appendChild(head);
    const body = h('div', { class: 'hud-el-body' });
    row.appendChild(body);
    row.body = body;
    return row;
  }
  /* A key-capture row, matching how every other key capture in the deck reads:
     one button that says what is bound (or "Press a key…" while it is armed),
     and a ✕ that clears it once there is something to clear. */
  function stripKeyRow(chips, bindOp, clearOp, armed, bound, label, help) {
    const b = elChip('data-stripact', bindOp,
      armed ? '⌨ Press a key…' : (bound ? ('⌨ ' + label + ': ' + bound) : ('⌨ Set ' + label.toLowerCase() + ' key')),
      help, armed);
    if (armed) b.classList.add('is-arming');
    /* ⚠ The key and its ✕ are WELDED into one pair (2026-08-19 design pass).
       They used to be two loose chips in a `gap: 7px` row, so with both keys
       bound the row read as four evenly-spaced buttons — nothing said which ✕
       cleared which key, and at a glance "✕" looked like a third binding.
       Same seam idiom as the shape segment row; the pair is a plain wrapper,
       so every `[data-stripact=…]` selector (harness included) still finds the
       buttons by descent. */
    const pair = h('span', { class: 'hud-el-pair' });
    pair.appendChild(b);
    if (bound && !armed)
      pair.appendChild(elChip('data-stripact', clearOp, '✕', 'Clear the ' + label.toLowerCase() + ' key', false));
    chips.appendChild(pair);
  }
  function buildStripSection() {
    const sec = shelfSection('strip', 'Followers HUD',
      'The on-screen portrait strip — where it sits, what each face shows, and the keys that drive it. ' +
      'Roster, faces and portraits stay in the deck’s Followers tab.');
    const on = stripEnabled();
    const shown = stripShown();

    /* ---- 1. the strip itself: master switch, placement, size ------------- */
    const row = h('div', { class: 'hud-el', 'data-el': 'strip',
      'data-elname': ('follower strip ' + EL_WORDS.strip).toLowerCase() });
    const head = h('div', { class: 'hud-el-head' });
    head.appendChild(elIcon('strip'));
    head.appendChild(h('span', { class: 'hud-el-name', title: 'Follower strip' }, 'Follower strip'));
    const sw = h('button', {
      class: 'hud-opt hud-el-sw' + (on ? ' on' : ''), type: 'button', 'data-stripact': 'enable',
      title: on ? 'Turn the follower strip off entirely' : 'Show a portrait strip of your current followers',
    }, on ? 'On' : 'Off');
    head.appendChild(sw);
    row.appendChild(head);
    const body = h('div', { class: 'hud-el-body' });
    body.appendChild(sizeRow('panel', 'Size'));
    body.appendChild(bgChipRow('strip'));
    const chips = h('div', { class: 'hud-el-chips' });
    /* ✥ Place: the ONE control that puts the strip into edit dress. It is a
       state chip, not a verb — you can see whether the plate and the strip's
       own toolbar are up, and turn them off again without leaving edit mode. */
    chips.appendChild(elChip('data-stripact', 'place',
      stripEditing() ? '✥ Placing…' : '✥ Place on screen',
      stripEditing()
        ? 'The strip is in edit dress — drag it, resize it from the corner. Click to put the chrome away.'
        : 'Show the strip with its move bar and handles so it can be dragged and resized',
      stripEditing()));
    chips.appendChild(elChip('data-stripact', 'visible',
      /* typographic marks, never a colour emoji — the deck's 2026-08-16 law */
      shown ? '◉ Shown' : '◌ Hidden',
      shown ? 'Temporarily hide the strip without turning it off' : 'Show it again', shown));
    chips.appendChild(elChip('data-stripact', 'flip',
      cfg.orient === 'vert' ? '↕ Column' : '↔ Row',
      'Switch the strip between a row and a column', false));
    chips.appendChild(elChip('data-stripact', 'grow', '⤢ Corner',
      'Flip which screen corner it anchors to and grows from', false));
    chips.appendChild(elChip('data-stripact', 'names', 'Aa Names',
      'Show or hide the name captions under the faces', !!cfg.showNames));
    body.appendChild(chips);
    if (!on) body.appendChild(h('div', { class: 'hud-el-note' },
      'The strip is off — the settings below are still yours to set, they simply have nothing to draw yet.'));
    row.appendChild(body);
    sec.appendChild(row);

    /* ---- 2. portrait shape: a segmented row, one active ------------------ */
    const shape = SHAPES.indexOf(cfg.faceShape) !== -1 ? cfg.faceShape : 'circle';
    const shRow = stripRow('strip-shape', 'Portrait shape', 'circle rounded square diamond faces cut');
    const shChips = h('div', { class: 'hud-el-chips hud-el-seg' });
    for (const s of SHAPES) {
      const b = elChip('data-stripact', 'shape', SHAPE_LABELS[s],
        SHAPE_TITLES[s] + (shape === s ? ' — current' : ''), shape === s);
      b.setAttribute('data-shape', s);
      shChips.appendChild(b);
    }
    shRow.body.appendChild(shChips);
    sec.appendChild(shRow);

    /* ---- 3. what each face carries --------------------------------------- */
    const fRow = stripRow('strip-face', 'On each face', 'level badge direction distance health magicka stamina bars');
    const fChips = h('div', { class: 'hud-el-chips' });
    for (const p of STRIP_PARTS) {
      const isOn = p[3]();
      const b = elChip('data-stripact', 'part', p[1], p[2] + (isOn ? ' — shown' : ' — hidden'), isOn);
      b.setAttribute('data-part', p[0]);
      fChips.appendChild(b);
    }
    fRow.body.appendChild(fChips);
    sec.appendChild(fRow);

    /* ---- 4. compact ------------------------------------------------------- */
    const cRow = stripRow('strip-compact', 'Compact', 'compact faces only browse');
    const cChips = h('div', { class: 'hud-el-chips' });
    cChips.appendChild(elChip('data-stripact', 'compact',
      cfg.compact ? '▣ Compact' : '▣ Full',
      cfg.compact ? 'Compact is on — faces only until you browse the strip'
                  : 'Every face shows its level, bars and name all the time',
      !!cfg.compact));
    cRow.body.appendChild(cChips);
    cRow.body.appendChild(h('div', { class: 'hud-el-note' },
      'Compact shows faces alone; the level, bars and name appear on the one you are browsing.'));
    sec.appendChild(cRow);

    /* ---- 5. the two keys -------------------------------------------------- */
    const kRow = stripRow('strip-keys', 'Keys', 'key keys bind browse hotkey show hide toggle');
    const kChips = h('div', { class: 'hud-el-chips' });
    stripKeyRow(kChips, 'bindnav', 'clearnav', !!strip.navArming, keyLabelOf(strip.navKey), 'Browse',
      'Bind the BROWSE key: press it to highlight the strip, WASD or the arrows step through your ' +
      'followers, Enter expands one, Esc or the key again closes it. ⚠ movement keys still move you ' +
      'while browsing — the game stays live.');
    stripKeyRow(kChips, 'bindkey', 'clearkey', !!strip.arming, keyLabelOf(strip.key), 'Show / hide',
      'Bind a keyboard or mouse key that shows and hides the strip');
    kRow.body.appendChild(kChips);
    if (strip.enabled === null) kRow.body.appendChild(h('div', { class: 'hud-el-note' },
      'Waiting for the game to answer with the bound keys…'));
    sec.appendChild(kRow);

    sec.appendChild(h('div', { class: 'hud-el-note' },
      'Who is on the roster, their portraits and their faces are the deck’s Followers tab — this ' +
      'section is only how the strip looks and behaves on screen.'));
    return sec;
  }
  /* C++ answers `hudCfg {op:'state'}` (and every other op) with the deck-state
     blob — the SAME payload the Followers tab's card reads, pushed to this view
     too since round 3. It carries the two things hudConfig cannot: enabled vs
     visible as separate flags, and the bound keys with their arming state. */
  window.hudCfgState = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    if (typeof j.enabled === 'boolean') strip.enabled = j.enabled;
    if (typeof j.visible === 'boolean') strip.visible = j.visible;
    strip.arming = !!j.arming;
    strip.navArming = !!j.navArming;
    if (j.key && typeof j.key === 'object') strip.key = j.key;
    if (j.navKey && typeof j.navKey === 'object') strip.navKey = j.navKey;
    if (cfgOpen) buildSettings();
  };
  /* ---- filter-as-you-type over the switches (Rober, 2026-08-18: "everything
     editable or addable like in the quick items — searchable typable field").
     This card carries forty-odd buttons across six groups and grows by one
     every time a block is invented, so hunting for "Survival" in it was already
     a scan. Same idiom as the item picker: narrows live, Enter takes the top
     hit, Esc clears.

     ⚠ It lives in the HEAD, and is built exactly ONCE. buildSettings wipes
     el.opts on every toggle AND on every live tick while the card is open — an
     input mounted in there would be destroyed under the player's fingers, which
     is the same trap the Deck Portal's Ask box was written around. */
  let cfgFilter = '';
  function ensureCfgFilter() {
    if (!el.settings) return null;
    let inp = document.getElementById('hud-cfg-filter');
    if (inp) return inp;
    const head = el.settings.querySelector('.hud-set-head');
    if (!head) return null;
    inp = h('input', { class: 'hud-set-filter', id: 'hud-cfg-filter', type: 'text',
      placeholder: 'Search settings…', autocomplete: 'off', spellcheck: false,
      title: 'Type to narrow the list below — Enter flips the top one' });
    inp.addEventListener('input', function () { cfgFilter = inp.value; applyOptFilter(); });
    inp.addEventListener('keydown', function (e) {
      const c = e.code || '', k = e.key || '';
      if (c === 'Escape' || k === 'Escape') {
        if (inp.value) { inp.value = ''; cfgFilter = ''; applyOptFilter(); e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (c === 'Enter' || c === 'NumpadEnter' || k === 'Enter') {
        /* Enter takes the TOP HIT — the first still-visible element row's own
           switch (the shelf filters by row now, so a bare `.hud-opt` scan
           would happily flip a switch inside a hidden row). */
        const row = el.opts.querySelector('.hud-el:not(.is-hid)');
        const first = row ? row.querySelector('.hud-opt') : el.opts.querySelector('.hud-opt:not(.is-hid)');
        if (first) first.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
        e.preventDefault(); e.stopPropagation();
      }
    });
    head.appendChild(inp);
    return inp;
  }
  /* Filter-as-you-type over ELEMENTS (2026-08-19). The shelf lists one row per
     element, so a query narrows ROWS — matched on the element's name plus the
     words a player is likely to call it (EL_WORDS) — and a section whose every
     row went with it hides its heading too. Rows are the unit because the
     controls inside one (−, ＋, ⟲, ⇱) carry no words at all: scanning button
     text would have filtered every stepper out from under its own widget. */
  function applyOptFilter() {
    if (!el.opts) return;
    const q = String(cfgFilter || '').trim().toLowerCase();
    /* ROUND 3: a query of SEVERAL words matches when every word is in the row —
       "browse key" has to find the strip's key row even though its words sit
       apart in the haystack ("bind browse hotkey … show hide toggle"). The whole
       phrase is still tried first, so an exact phrase keeps ranking as a hit;
       this only ever ADDS matches, never removes one. */
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    let shown = 0;
    for (const r of el.opts.querySelectorAll('.hud-el')) {
      const hay = r.getAttribute('data-elname') || '';
      const hit = !q || hay.indexOf(q) !== -1 ||
        (terms.length > 1 && terms.every(function (t) { return hay.indexOf(t) !== -1; }));
      setClass(r, 'is-hid', !hit);
      if (hit) shown++;
    }
    /* a section whose every row is filtered out takes its heading with it —
       otherwise the shelf reads as a column of headings over nothing */
    for (const g of el.opts.querySelectorAll('.hud-el-sec'))
      setClass(g, 'is-hid', !!q && !g.querySelector('.hud-el:not(.is-hid)'));
    /* the "connect a widget" chips belong to the group card; they are noise
       under a query that is not about the group */
    for (const a of el.opts.querySelectorAll('.hud-el-add'))
      setClass(a, 'is-hid', !!q);
    let none = el.opts.querySelector('.hud-opt-none');
    if (q && !shown) {
      if (!none) { none = h('div', { class: 'hud-opt-none' }); el.opts.appendChild(none); }
      setText(none, 'Nothing matches “' + cfgFilter.trim() + '”.');
      setClass(none, 'is-hid', false);
    } else if (none) setClass(none, 'is-hid', true);
    setClass(el.opts, 'is-filtered', !!q);
  }

  /* ---- the card is rebuilt on EVERY live tick while it is open -----------
     (window.hudWidgets → `if (cfgOpen) buildSettings()`.) That was already
     wasteful; with a size stepper per widget it is ~80 more nodes thrown away
     and rebuilt several times a second, in an engine with the compositor off —
     and it wipes :hover out from under the finger mid-click. So the TICK caller
     (and only the tick caller) passes `cheap`: the card is rebuilt only when
     something it actually draws has changed, and otherwise just re-greys the
     switches whose data came or went. Structural signature, volatile pass —
     the same law every other renderer in this view follows. */
  let cfgSig = '';
  function settingsSig() {
    const p = [];
    for (const k in wcfg) p.push(k + (wcfg[k] ? '1' : '0'));
    p.push('g' + (wgrp.locked ? '1' : '0') + wgrp.orient + Number(num(wgrp.scale, 1)).toFixed(2));
    /* 2026-08-19: WHO is welded in is structural — a link/unlink moves rows
       between the group card and their own section, so the tick rebuild has
       to see it. */
    p.push('gk' + grpKeys().join(','));
    for (const k of DET_KEYS)
      p.push(k + (detOn(k) ? '1' : '0') + (wdet[k] ? Number(num(wdet[k].scale, 1)).toFixed(2) : ''));
    for (const k of FREE_KEYS) p.push(k + Number(num(wfree[k].scale, 1)).toFixed(2));
    p.push('p' + Number(num(cfg.scale, 1)).toFixed(3));
    /* round 3: the Followers-HUD section draws from cfg + the deck-state blob,
       so every one of those is structural here — without them a cheap tick
       would hold a stale shape / bar / key row on screen. */
    p.push('s' + (stripEnabled() ? '1' : '0') + (stripShown() ? '1' : '0') +
      (stripEditing() ? 'e' : '') + (cfg.orient === 'vert' ? 'v' : 'h') +
      (cfg.showNames ? 'n' : '') + (cfg.compact ? 'c' : '') + cfg.faceShape +
      (cfg.showLevel !== false ? 'L' : '') + (cfg.showDir !== false ? 'D' : '') +
      (cfg.showHp !== false ? 'H' : '') + (cfg.showMk === true ? 'M' : '') +
      (cfg.showSt === true ? 'S' : '') +
      (strip.arming ? 'a' : '') + (strip.navArming ? 'A' : '') +
      keyLabelOf(strip.key) + '/' + keyLabelOf(strip.navKey));
    /* 2026-08-19: the ⬒ Background row's own state. Without it a pick / scale
       / opacity / fit / clear applied to the WIDGET but left the shelf row
       showing the old text (and, after a clear, dead knobs that did nothing),
       because buildSettings(true) short-circuits on an unchanged signature. */
    p.push('bg' + JSON.stringify(bgPrefs()));
    p.push(activePreset());
    return p.join('|');
  }
  /* the only thing that moves per tick: a switch whose data the game stopped
     sending greys out, and says so, without the card being rebuilt */
  function refreshAbsent() {
    if (!el.opts) return;
    for (const b of el.opts.querySelectorAll('.hud-opt[data-opt]')) {
      const key = b.getAttribute('data-opt');
      const absent = OPT_ABSENT[key];
      const off = !!(absent && absent());
      setClass(b, 'is-absent', off);
      /* same sentence the row builds, so a cheap tick cannot swap the
         tooltip out from under the shelf's own wording */
      const t = key === 'weatherCenter' ? 'Toggle centered weather text' : key === 'snapRects' ? 'Toggle snapping while dragging rectangular widgets' : (wcfg[key] ? 'Hide ' : 'Show ') + OPT_LABELS[key] +
        (off ? ' — nothing to show right now' : '');
      if (b.title !== t) b.title = t;
    }
  }
  function buildSettings(cheap) {
    if (!el.opts || !el.presets) return;
    const sig = settingsSig();
    if (cheap && sig === cfgSig && el.opts.firstChild) { refreshAbsent(); return; }
    cfgSig = sig;
    /* ⚠ KEEP THE SCROLL POSITION. This wipes el.opts and rebuilds it, which
       resets scrollTop to 0 — and it runs on a LIVE TICK, so a player halfway
       down the shelf was thrown back to the top whenever any widget's data
       moved. Restored below, after the rebuild. */
    const keepScroll = el.opts.scrollTop;
    el.presets.innerHTML = '';
    const act = activePreset();
    for (const [id, label] of PRESET_ORDER) {
      el.presets.appendChild(h('button', {
        class: 'hud-preset' + (act === id ? ' on' : ''), type: 'button', 'data-preset': id,
        title: 'Preset: ' + label,
      }, label));
    }
    /* ---- the shelf body: one section per family, one ROW per element ------
       Every element carries its own switch, its own size and its own options,
       so nothing has to be hunted for across three lists. */
    el.opts.innerHTML = '';
    el.opts.appendChild(buildElSection('placement', 'Placement', ['snapRects'],
      'Drag rectangles close together to align their edges with an even gap. Shift-drag moves the connected row or cluster. Normal drag moves one tile; Alt bypasses snapping.'));
    el.opts.appendChild(buildElSection('readouts', 'Readouts', LINE_KEYS));
    el.opts.appendChild(buildElSection('player', 'Player & world', BLOCK_KEYS));
    /* the linked group — one card, its members nested under it */
    el.opts.appendChild(buildGrpSection());
    el.opts.appendChild(buildElSection('items', 'Quick items', ['quick', 'quick2']));
    el.opts.appendChild(buildElSection('loot', 'Loot', ['lootStatus']));
    /* The season rides the same free layer but is neither an equipment slot nor
       a quick-items strip, so it gets its own section rather than being filed
       under someone else's. */
    el.opts.appendChild(buildElSection('world', 'World', ['season']));
    /* The ward rides the free layer too; combat-flavoured, so its own card. */
    el.opts.appendChild(buildElSection('ward', 'Ward', ['ward']));
    el.opts.appendChild(buildElSection('calendar', 'Date & season', ALMANAC_KEYS, 'One rectangle. Choose the day, month name and season independently.'));
    el.opts.appendChild(buildElSection('sunhelm', 'SunHelm needs', NEED_KEYS, 'Turn on Survival needs, then choose what to show. Icons only fits the trio in one clock-sized rectangle; separate mode gives each need its own position and size.'));
    el.opts.appendChild(buildElSection('clockstyle', 'Clock appearance', CLOCK_KEYS,
      'Ornate replaces the compact Time tile. Its size and position stay adjustable under Time. Borderless by default; frame, date and motion are optional.'));
    el.opts.appendChild(buildElSection('detail', 'Detail', DETAIL_KEYS.filter(k => CLOCK_KEYS.indexOf(k) === -1 && k !== 'snapRects' && k !== 'weatherOnly' && k !== 'weatherCenter' && ALMANAC_KEYS.indexOf(k) === -1 && NEED_KEYS.indexOf(k) === -1),
      'Small print, everywhere at once.'));
    /* the strip's PLACEMENT only — the separation Rober asked for */
    el.opts.appendChild(buildStripSection());
    el.opts.appendChild(h('div', { class: 'hud-opt-note' },
      'Every element is its own row — switch it on, set its size, float it out of the panel, ' +
      'or link it into a group that moves as one. The presets above set every switch at once. ' +
      'A greyed switch means the game has nothing to show for it at this moment, not that it is broken. ' +
      'Drag any widget on screen to move it; the mouse wheel over one resizes it.'));
    /* the filter is built once and re-applied after every rebuild, so a live
       tick cannot quietly un-narrow the card under a typed query */
    ensureCfgFilter();
    applyOptFilter();
    if (keepScroll) { try { el.opts.scrollTop = keepScroll; } catch (e) {} }
  }
  /* ---- the shelf scrolls at a HUMAN speed (Rober, 2026-08-19: "scrolling is
     painfully slow on the right hud widgets popout") --------------------------
     Two causes, both fixed here. (1) Ultralight delivers small per-notch wheel
     deltas and the engine's own default scroll step is a few pixels — over a
     4,400px shelf that is a wrist exercise. So the wheel is handled explicitly:
     one notch = HUD_WHEEL_STEP px, which is about three rows. (2) The wheel
     over a widget RESIZES it in this view; without stopPropagation a scroll
     that started inside the shelf could also rescale whatever sits under it.
     preventDefault stops the engine adding its own step on top of ours. */
  const HUD_WHEEL_STEP = 132;
  if (el.opts) {
    el.opts.addEventListener('wheel', function (e) {
      const raw = (typeof e.deltaY === 'number' && e.deltaY) ? e.deltaY
        : (typeof e.wheelDelta === 'number' && e.wheelDelta) ? -e.wheelDelta : 0;
      if (!raw) return;
      /* DOM_DELTA_PIXEL (0) can carry a real pixel run from a trackpad — honour
         it, but never below one solid step for a mouse notch. */
      const px = (e.deltaMode === 0 && Math.abs(raw) > HUD_WHEEL_STEP)
        ? raw : (raw > 0 ? HUD_WHEEL_STEP : -HUD_WHEEL_STEP);
      el.opts.scrollTop += px;
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
  }
  /* ---- THE SHELF: docked to the right edge, slides in ---------------------
     Rober, play-test 2026-08-19: "it should open a right popout shelf like
     action bar does, and have all configuration there."

     So the ⚙ card stopped being a floating window and became a full-height
     shelf hinged on the right edge — one predictable place, big text, room
     for a row per element, and a search box at the top. Its old remembered
     x/y (`cfgPos`) is therefore retired: a docked shelf has nothing to
     place, and a stored corner would only be a ghost of the window it used
     to be. It still lives OUTSIDE #hud (that lesson stands — #hud carries
     transform: scale(--hud-scale), and a transformed ancestor becomes the
     containing block for position:fixed), and its own CSS owns its geometry.

     `cfgFocus` is the element the shelf was ASKED to open on (the deck's
     Home drawer, or a widget's own ⚙): it is scrolled to and lit for a
     moment, so "configure this one" lands on THAT row instead of the top. */
  let cfgFocus = '';
  function placeSettings() { /* docked — the stylesheet owns the geometry */ }
  function focusShelfEl(key) {
    if (!key || !el.opts) return;
    const row = el.opts.querySelector('.hud-el[data-el="' + key + '"]');
    if (!row) return;
    for (const r of el.opts.querySelectorAll('.hud-el.is-focus')) r.classList.remove('is-focus');
    row.classList.add('is-focus');
    /* scrollIntoView is unproven in Ultralight — do the arithmetic instead.
       ⚠ MEASURED FROM THE RECTS, not from offsetTop (fixed 2026-08-19). A row's
       `offsetTop` is relative to its OFFSET PARENT, and no shelf section is
       positioned, so the walk went past `#hud-opts` entirely — the number was
       an offset inside some ancestor and the jump landed at 0. "Config →
       Followers HUD" therefore opened the shelf at Readouts, i.e. exactly the
       row it was told not to open on. Rect deltas are parent-agnostic and
       already scroll-corrected, so they are right whatever the DOM does next. */
    const jump = function () {
      try {
        const rr = row.getBoundingClientRect(), or = el.opts.getBoundingClientRect();
        if (!or.height) return;
        const delta = (rr.top - or.top) - (or.height / 2) + (rr.height / 2);
        el.opts.scrollTop = Math.max(0, Math.round(el.opts.scrollTop + delta));
      } catch (e) {}
    };
    jump();
    /* ⚠ …and once more on the next tick. The shelf is opened by adding a class
       that SLIDES it in, so on the frame the open happens `el.opts.clientHeight`
       can still be 0 — the arithmetic then lands on 0 and the shelf reads as
       having ignored the row it was asked to open on (measured 2026-08-19:
       "Config → Followers HUD" opened at Readouts). The second pass costs one
       timer and is a no-op when the first already got it right. */
    setTimeout(jump, 0);
  }
  /* ---- clicking a widget on screen JUMPS the shelf to its row -------------
     Rober, 2026-08-19: "if i click a widget, the right slide out panel should
     jump down automatically to what i just clicked". The focus-on-open
     affordance hudShelf({key}) already had, generalised to every selection
     while the shelf is open.

     It CLEARS the filter first: a narrowed shelf may not be drawing the row at
     all, and scrolling to a hidden row is a click that does nothing. Clearing
     with the row lit is the reading that cannot surprise — you see where you
     landed. Silent when the shelf is closed; clicking a widget is not a reason
     to open it. */
  function revealInShelf(key) {
    if (!cfgOpen || !key || !el.opts) return;
    if (cfgFilter) {
      cfgFilter = '';
      const i = document.getElementById('hud-cfg-filter');
      if (i) i.value = '';
      applyOptFilter();
    }
    cfgFocus = String(key);
    /* revealing the Follower-HUD section is the same deliberate act as opening
       the shelf on it — so it arms the strip's edit dress too (round 3) */
    if (STRIP_SECTION_KEYS.indexOf(cfgFocus) !== -1) setStripEdit(true);
    focusShelfEl(cfgFocus);
  }
  /* A free widget welded into the LOCKED group has no row of its own — the
     group card is the thing that configures it, so that is where a click on it
     should land. Unlocked, each member keeps its own row. */
  function shelfKeyForFree(k) {
    return (wgrp.locked && grpHas(k)) ? 'fwgrp' : k;
  }
  function setCfgOpen(on, key) {
    cfgOpen = !!on && editing;
    el.body.classList.toggle('hud-cfg-open', cfgOpen);
    const btn = document.querySelector('[data-role="cfg"]');
    if (btn) btn.classList.toggle('on', cfgOpen);
    if (!cfgOpen) { cfgFocus = ''; return; }
    cfgFocus = String(key || '');
    /* the shelf is asked to open ON the Follower-HUD section: that ask IS the
       "configure the strip" act, so this is one of the three doors that arms
       the strip's edit dress (round 3). Opening it on anything else must not. */
    if (STRIP_SECTION_KEYS.indexOf(cfgFocus) !== -1) setStripEdit(true);
    /* one fresh ask for the strip's own truth (enabled / shown / the two bound
       keys) — the reply lands on window.hudCfgState and repaints the section */
    stripCfg('state');
    buildSettings();
    /* a fresh open starts unfiltered — a query left over from last time reads
       as a shelf that has lost half its rows */
    if (cfgFilter) { cfgFilter = ''; const i = document.getElementById('hud-cfg-filter'); if (i) i.value = ''; applyOptFilter(); }
    if (cfgFocus) focusShelfEl(cfgFocus);
  }
  /* Opened from OUTSIDE the view: C++ relays the deck's "configure this on
     screen" here after it has armed edit mode (main.cpp hudCfg op:'shelf').
     Marker: hud-shelf-open. */
  window.hudShelf = function (s) {
    const j = (typeof s === 'string' && s.charAt(0) === '{') ? parse(s) : s;
    const key = (j && typeof j === 'object') ? String(j.key || '') : String(s || '');
    if (!editing) setEditing(true);
    setCfgOpen(true, key === '1' ? '' : key);
  };
  function onSettingsClick(e) {
    const t = e.target && e.target.closest
      ? e.target.closest('[data-opt],[data-preset],[data-float],[data-grplock],[data-grpact],[data-szact],'
                       + '[data-grplink],[data-stripact],[data-shelfact],[data-bgpick],[data-bgact]') : null;
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    /* the shelf's own chrome */
    const sa = t.getAttribute('data-shelfact');
    if (sa === 'close') { setCfgOpen(false); return; }
    if (sa === 'side') { setShelfSide(shelfSide() === 'left' ? 'right' : 'left'); return; }
    /* widget backgrounds — the picker and its knobs */
    const bp = t.getAttribute('data-bgpick');
    if (bp) { openBgPick(bp); return; }
    const ba = t.getAttribute('data-bgact');
    if (ba) { bgAct(ba); return; }
    /* link / unlink a free widget into the group — the "connect up widgets"
       ask (2026-08-19). Membership is the ONLY thing that moves: the widget
       keeps its own stored placement and gets it back when it is unlinked. */
    const lk = t.getAttribute('data-grplink');
    if (lk) {
      if (grpLink(lk, !grpHas(lk))) { buildSettings(); saveWidgetCfg(); render(); }
      else toast('That is the last widget in the group — link another one in first.');
      return;
    }
    /* the follower strip's PLACEMENT (never its roster — that is the deck's
       Followers tab) — the same three actions the edit toolbar carries, so
       there is one implementation of each. */
    const st = t.getAttribute('data-stripact');
    if (st) {
      /* ---- flip / grow / names stay LOCAL: they live in the placement blob
         this view owns and saves with hudSave, exactly as the edit toolbar's
         own buttons do. Everything else is C++ state, and goes out on the
         `hudCfg` op the deck card already used — one implementation. */
      if (st === 'flip') { cfg.orient = cfg.orient === 'vert' ? 'horiz' : 'vert'; applyOrient(); }
      else if (st === 'grow') { cycleAnchor(); }
      else if (st === 'names') { cfg.showNames = !cfg.showNames; applyNames(); }
      else if (st === 'place') { setStripEdit(!stripEditing()); return; }
      else if (st === 'enable') {
        const next = !stripEnabled();
        strip.enabled = next;
        if (!next) strip.visible = strip.visible;   // visible is its own flag; enable never edits it
        stripCfg('enable', { on: next });
        buildSettings();
        return;
      } else if (st === 'visible') {
        const next = !stripShown();
        strip.visible = next;
        /* optimistic locally so the strip answers the click at once; C++ echoes
           the same value back on hudConfig a moment later */
        cfg.visible = next && stripEnabled();
        applyVisible();
        stripCfg('visible', { on: next });
        buildSettings(); render();
        return;
      } else if (st === 'shape') {
        const s = t.getAttribute('data-shape');
        if (SHAPES.indexOf(s) === -1) return;
        cfg.faceShape = s; applyShape();
        stripCfg('shape', { shape: s });
        buildSettings();
        return;
      } else if (st === 'part') {
        const k = t.getAttribute('data-part');
        const F = { level: 'showLevel', dir: 'showDir', hp: 'showHp', mk: 'showMk', st: 'showSt' };
        if (!F[k]) return;
        const dflt = (k === 'mk' || k === 'st') ? false : true;
        const cur = (typeof cfg[F[k]] === 'boolean') ? cfg[F[k]] : dflt;
        cfg[F[k]] = !cur;
        stripCfg('part', { key: k, on: !cur });
        buildSettings();
        return;
      } else if (st === 'compact') {
        cfg.compact = !cfg.compact; applyCompact();
        stripCfg('compact', { on: cfg.compact });
        buildSettings();
        return;
      } else if (st === 'bindnav' || st === 'bindkey') {
        /* arming is C++'s to own — it answers with hudCfgState and the row
           repaints itself as "Press a key…" */
        if (st === 'bindnav') strip.navArming = true; else strip.arming = true;
        stripCfg(st);
        buildSettings();
        return;
      } else if (st === 'clearnav' || st === 'clearkey') {
        if (st === 'clearnav') strip.navKey = null; else strip.key = null;
        stripCfg(st);
        buildSettings();
        return;
      }
      saveCfg(); buildSettings(); render();
      return;
    }
    /* the shared size stepper — one handler for every widget in the card */
    const sz = t.getAttribute('data-szact');
    if (sz) {
      const id = t.getAttribute('data-szid');
      if (sz === 'reset') scaleSet(id, 1);
      else scaleSet(id, scaleOf(id) + (sz === 'bigger' ? SCALE_STEP : -SCALE_STEP));
      buildSettings();
      return;
    }
    const preset = t.getAttribute('data-preset');
    if (preset) { applyPreset(preset); return; }
    const fl = t.getAttribute('data-float');
    if (fl) { floatBlock(fl, !detOn(fl)); buildSettings(); return; }
    if (t.getAttribute('data-grplock')) {
      wgrp.locked = !wgrp.locked;
      applyGroup(); renderFree(); buildSettings(); saveWidgetCfg();
      return;
    }
    /* the merged equipped widget's own controls — master, orientation, size */
    const ga = t.getAttribute('data-grpact');
    if (ga) {
      if (ga === 'master') grpSetMaster(!grpAnyOn());
      else if (ga === 'vert' || ga === 'horiz') { wgrp.orient = ga; applyGroup(); }
      else if (ga === 'smaller') grpScaleBy(-0.1);
      else if (ga === 'bigger') grpScaleBy(0.1);
      else if (ga === 'resetsize') { wgrp.scale = 1; grpScaleBy(0); }
      applyWidgetCfg(); renderWidgets(); renderFree(); buildSettings(); saveWidgetCfg();
      render();
      return;
    }
    const key = t.getAttribute('data-opt');
    if (!key) return;
    wcfg[key] = !wcfg[key];
    if (key === 'snapRects') clearRectangleSnap();
    applyWidgetCfg(); renderWidgets(); buildSettings(); saveWidgetCfg();
    render();
  }
  /* Same double-fire guard as the toolbar below: a browser that emits pointer
     AND mouse events would flip each switch twice and leave it where it was. */
  let sawSettingsPointer = 0;
  if (el.settings) {
    el.settings.addEventListener('pointerdown', function (e) {
      sawSettingsPointer = Date.now(); onSettingsClick(e);
    });
    el.settings.addEventListener('mousedown', function (e) {
      if (Date.now() - sawSettingsPointer < 500) return;
      onSettingsClick(e);
    });
  }

  /* ---- edit mode: drag / resize / flip / names ------------------------- */
  function setEditing(on) {
    if (!on) clearRectangleSnap();
    editing = !!on;
    el.body.classList.toggle('hud-editing', editing);
    /* ⚠ ROUND 3: entering edit mode NEVER arms the strip's scope — that is the
       whole "config must not turn my follower HUD on" fix. Leaving always
       disarms it, so the scope can never outlive the session that set it. */
    if (!editing) stripEdit = false;
    applyStripEdit();   // BEFORE applyPlacement: it decides the toolbar's height
    applyShell();   // the panel plate + the ⚙ grip exist only while configuring
    /* ⚠ RE-MEASURE THE TOOLBAR. .hud-tools is display:none during play, so the
       last applyPlacement measured it as ZERO — and every one of its measured
       decisions (flip above/below, the counter-scale, and above all the hint
       line's step-down under a flipped bar) was computed from that zero. The
       result was the bar sitting straight on top of the hint line the moment
       edit mode opened (a 487x37 bar over the hint at y+4, Opus audit
       2026-08-18). The class flip above is what gives the bar a height, so the
       re-measure has to happen AFTER it. */
    applyPlacement();
    // While repositioning the HUD is always shown even if 'visible' is off, so
    // it can be placed before it is ever toggled on. applyVisible re-runs on
    // BOTH transitions — its strip-off toggle reads `editing`, so it must be
    // re-evaluated here or the strip stays wrongly shown/hidden after Done.
    applyVisible();
    applyDetach(false);
    if (editing) el.body.classList.remove('hud-hidden');
    else {
      /* EVERY exit door funnels through here (Done, Esc, C++'s hudEdit("0")
         rescue) — so this is where in-flight state dies. A drag that survived
         an exit (Esc mid-hold, focus yanked before mouseup) used to replay its
         full cursor delta as a teleport on the NEXT edit session (Opus audit,
         2026-08-18); and a selection that survived re-attached its toolbar. */
      drag = null;
      fdrag = null;
      /* the .hud-det / group drag is in-flight state too — and it holds a NODE
         now, so its grabbed look has to be taken off with it */
      if (ddrag && ddrag.node) ddrag.node.classList.remove('is-drag');
      ddrag = null;
      fwSelected = null;
      const guide = document.getElementById('hud-fw-guide');
      if (guide) guide.classList.remove('show');   // never strand the snap guide in play
      applyVisible(); setCfgOpen(false);
    }
    // Edit mode reveals the ghost placeholders, so the stack must be re-rendered.
    render();
  }

  let drag = null;   // {mode:'move'|'resize', sx,sy, ox,oy, oscale}
  function onPointerDown(e) {
    if (!editing) return;
    // Clicks inside the settings card belong to the card, never to the drag.
    if (el.settings && el.settings.contains && el.settings.contains(e.target)) return;
    const role = e.target && e.target.getAttribute && e.target.getAttribute('data-role');
    if (role === 'flip') { cfg.orient = cfg.orient === 'vert' ? 'horiz' : 'vert'; applyOrient(); saveCfg(); return; }
    if (role === 'grow') { cycleAnchor(); return; }
    if (role === 'names') { cfg.showNames = !cfg.showNames; applyNames(); saveCfg(); return; }
    if (role === 'cfg') { setCfgOpen(!cfgOpen); return; }
    if (role === 'done') {
      // Bridge first, teardown second — same law as the Esc path: the exit
      // must release focus even if the exit render throws.
      toGame('hudEditDone');
      try { saveFree(); setCfgOpen(false); setEditing(false); saveCfg(); }
      catch (err) {
        try { toGame('hudLog', 'done-exit render threw: ' + err.message); } catch (e2) {}
        el.body.classList.remove('hud-editing');
        editing = false;
      }
      return;
    }
    if (role === 'resize') {
      drag = { mode: 'resize', sx: e.clientX, sy: e.clientY, oscale: cfg.scale };
    } else {
      // Anywhere on the panel or the grip moves it.
      drag = { mode: 'move', sx: e.clientX, sy: e.clientY, ox: cfg.x, oy: cfg.y,
        /* THE STRIP'S ⚙ (2026-08-19). It is the panel's drag grip and it is
           drawn as a gear, so a player clicks it expecting settings and
           nothing happens — screenshot-confirmed by Rober ("does nothing").
           It still drags; a click that never MOVED now opens the shelf. */
        gear: !!(el.stripGrip && e.target === el.stripGrip), moved: false };
      /* …and, with the shelf already open, grabbing the strip jumps it to the
         strip's own row (2026-08-19) — the same "show me what I just clicked"
         rule the free widgets and the floated blocks follow. */
      revealInShelf('strip');
    }
    try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag) return;
    if (drag.mode === 'move') {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      /* 4px of slop, the deck's own click-vs-drag threshold */
      if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
      // When anchored to the far edge the offset grows the opposite way, so the
      // panel always tracks the cursor regardless of which corner it hangs off.
      cfg.x = drag.ox + (cfg.anchorH === 'right' ? -dx : dx);
      cfg.y = drag.oy + (cfg.anchorV === 'bottom' ? -dy : dy);
      clampToView();
      applyPlacement(true);
    } else {
      // Drag the corner out to grow. Diagonal delta / a reference span -> scale.
      const d = ((e.clientX - drag.sx) + (e.clientY - drag.sy)) / 2;
      cfg.scale = clamp(drag.oscale + d / 220, SCALE_MIN, SCALE_MAX);
      applyPlacement(true);
    }
    e.preventDefault();
  }
  /* the measured chrome pass the drag skipped, run ONCE when the hand lets go */
  function onPointerUp() {
    if (!drag) return;
    const gearClick = drag.mode === 'move' && drag.gear && !drag.moved;
    drag = null;
    applyPlacement(); saveCfg();
    /* Build marker (hd-markers.json: "hud-strip-gear-shelf"). */
    if (gearClick) {
      toGame('hudLog', 'strip gear: opening the widget shelf');
      if (cfgOpen) setCfgOpen(false); else setCfgOpen(true, 'strip');
    }
  }

  /* Ultralight sometimes only emits mouse events, so both families are wired.
     ⚠ But an engine that emits BOTH runs every handler twice — and a TOGGLE run
     twice is a no-op. Caught in the 2026-08-17 overlap pass: the new ⚙ Widgets
     button opened and instantly re-closed the settings card in real chromium
     (and Flip / Grow / Names have carried the same latent hazard since v0.8).
     The mouse mirror now stands down when a pointer event for the same gesture
     has just run. */
  let sawPointer = 0;
  function pointerFirst(e) { sawPointer = Date.now(); onPointerDown(e); }
  function mouseMirror(e) {
    if (Date.now() - sawPointer < 500) return;
    e.pointerId = e.pointerId || 1;
    onPointerDown(e);
  }
  el.hud.addEventListener('pointerdown', pointerFirst);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  el.hud.addEventListener('mousedown', mouseMirror);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  /* ---- interop receivers (C++ -> view) --------------------------------- */
  function parse(s) { try { return JSON.parse(s); } catch (e) { toGame('hudLog', 'HUD parse: ' + e); return null; } }

  window.hudConfig = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j) return;
    if (typeof j.x === 'number') cfg.x = j.x;
    if (typeof j.y === 'number') cfg.y = j.y;
    if (typeof j.scale === 'number') cfg.scale = clamp(j.scale, SCALE_MIN, SCALE_MAX);
    if (j.orient === 'vert' || j.orient === 'horiz') cfg.orient = j.orient;
    if (j.anchorH === 'left' || j.anchorH === 'right') cfg.anchorH = j.anchorH;
    if (j.anchorV === 'top' || j.anchorV === 'bottom') cfg.anchorV = j.anchorV;
    if (typeof j.visible === 'boolean') cfg.visible = j.visible;
    if (typeof j.showNames === 'boolean') cfg.showNames = j.showNames;
    if (typeof j.showLevel === 'boolean') cfg.showLevel = j.showLevel;
    if (typeof j.showDir === 'boolean') cfg.showDir = j.showDir;
    if (typeof j.showHp === 'boolean') cfg.showHp = j.showHp;
    if (typeof j.showSt === 'boolean') cfg.showSt = j.showSt;
    if (typeof j.showMk === 'boolean') cfg.showMk = j.showMk;
    if (SHAPES.indexOf(j.faceShape) !== -1) cfg.faceShape = j.faceShape;
    if (typeof j.compact === 'boolean') cfg.compact = j.compact;
    // A combined push is accepted so C++ can send one blob if it prefers.
    if (j.widgets && typeof j.widgets === 'object') takeWidgetCfg(j.widgets);
    applyConfig();
  };
  /* Compact-browse navigation (Rober, 2026-08-18): C++'s input sink drives
     this with open/close/next/prev/enter — no focus, the game stays live.
     Selection survives strip rebuilds because render() re-applies it. */
  /* BROWSE v2 (2026-08-18). C++ now hands this view REAL keyboard focus while
     browsing (unpaused, focus menu on), so the keys arrive here as ordinary
     KeyboardEvents and the sink no longer forwards them — see the C++ half's
     `hud-nav-focus`. Two halves live below:
       • onNavKey — WASD / arrows step, Enter or E opens the info card,
         Esc / Backspace leave browsing altogether.
       • the info card — a centred popout with the selected follower's whole
         row: portrait, level, pools, bearing, and any extra field the payload
         happens to carry.
     ⚠ Whenever the VIEW ends browsing (Esc, Backspace, a click away, the card
     closing) it must say so with `hudNavDone`, or C++ keeps the keyboard and
     the player cannot move. C++'s own `hudNav("close")` is the other
     direction and deliberately does NOT echo one back. */
  const nav = { on: false, sel: 0, open: false, card: false };
  /* The one line that tells you how to get out again. Written once (its text
     never changes), shown while browsing and hidden the moment the info card
     takes over — the card carries its own foot line and two of them at once is
     noise. Placed on whichever half of the screen the follower strip is NOT in,
     measured rather than guessed, because the strip can be parked anywhere. */
  const NAV_HINT_TEXT = 'WASD or arrows move · Enter opens · Esc back to normal controls';
  function placeNavHint() {
    const e = el.navhint;
    if (!e) return;
    const show = nav.on && !nav.card;
    if (e.textContent !== NAV_HINT_TEXT) e.textContent = NAV_HINT_TEXT;
    setClass(e, 'is-up', show);
    if (!show) return;
    const vh = window.innerHeight || 1080;
    const pr = el.panel && el.panel.getBoundingClientRect ? el.panel.getBoundingClientRect() : null;
    const mid = (pr && pr.height) ? (pr.top + pr.bottom) / 2 : vh / 2;
    setClass(e, 'is-bottom', mid < vh / 2);   // strip up top ⇒ hint down bottom
  }
  function applyNav() {
    el.body.classList.toggle('hud-navving', nav.on);
    const chips = el.strip.children;
    for (let i = 0; i < chips.length; i++) {
      setClass(chips[i], 'nav-sel', nav.on && i === nav.sel);
      setClass(chips[i], 'nav-open', nav.on && i === nav.sel && nav.open);
    }
    /* a card whose follower walked off the roster closes rather than lying */
    if (nav.card && !followers[nav.sel]) nav.card = false;
    buildNavCard();
    placeNavHint();
  }
  function navStep(d) {
    const n = el.strip.children.length;
    if (!n) return;
    nav.sel = ((nav.sel + d) % n + n) % n;
    /* stepping while the card is up moves the CARD — that is the whole point
       of ← → in there; stepping without one just moves the highlight */
    if (!nav.card) nav.open = false;
    applyNav();
    if (typeof fitWidgets === 'function') fitWidgets();
  }
  function navEnter() {
    if (!nav.on) return;
    /* The card is the terminal state of a browse: dismissing it hands the
       controls straight back (Rober: "escape goes back to normal controls" —
       one press, never two). */
    if (nav.card) { navDone('card'); return; }
    if (!followers[nav.sel]) return;
    nav.card = true; nav.open = true;
    applyNav();
    if (typeof fitWidgets === 'function') fitWidgets();
  }
  /* The view-initiated exit. C++ hears hudNavDone and releases the keyboard. */
  function navDone(why) {
    const was = nav.on;
    nav.on = false; nav.open = false; nav.card = false;
    applyNav();
    if (typeof fitWidgets === 'function') fitWidgets();
    if (was) toGame('hudNavDone', String(why || ''));
  }
  /* Returns true when the key belonged to browse mode. Called from the one
     capture-phase keydown listener below, which then stops it going further —
     an arrow that ALSO nudged a widget would be a bug in both directions. */
  function onNavKey(e) {
    if (!nav.on) return false;
    const c = e.code || '';
    const k = e.key || '';
    if (c === 'Escape' || k === 'Escape' || e.keyCode === 27 ||
        c === 'Backspace' || k === 'Backspace' || e.keyCode === 8) { navDone('esc'); return true; }
    if (c === 'Enter' || c === 'NumpadEnter' || k === 'Enter' || e.keyCode === 13 ||
        c === 'KeyE' || k === 'e' || k === 'E') { navEnter(); return true; }
    if (c === 'ArrowLeft' || c === 'KeyA' || k === 'ArrowLeft' ||
        c === 'ArrowUp' || c === 'KeyW' || k === 'ArrowUp') { navStep(-1); return true; }
    if (c === 'ArrowRight' || c === 'KeyD' || k === 'ArrowRight' ||
        c === 'ArrowDown' || c === 'KeyS' || k === 'ArrowDown') { navStep(1); return true; }
    return false;
  }

  /* ---- the centred info card ------------------------------------------- */
  /* Everything the roster row is allowed to carry, in the order it reads. The
     card draws WHAT IS THERE and omits what is not — the payload law this whole
     view runs on, so an older DLL simply shows a smaller card. */
  const NC_POOLS = [['hp', 'Health', 'hp'], ['mk', 'Magicka', 'mk'], ['st', 'Stamina', 'st']];
  /* Fields the card renders itself, or that are plumbing — everything else in
     the row is shown as a labelled line, so a field added to the payload
     tomorrow appears here with no view change. */
  const NC_KNOWN = { name: 1, lvl: 1, hp: 1, mk: 1, st: 1, dir: 1, dist: 1, dead: 1,
    hue: 1, file: 1, crop: 1, mtime: 1, ext: 1, original: 1, following: 1, id: 1, formId: 1 };
  function ncLabel(k) {
    const s = String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function ncBar(label, p) {
    const cur = num(p.cur, null), mx = num(p.max, null);
    const wrap = h('div', { class: 'hud-nc-bar' });
    wrap.appendChild(h('span', { class: 'hud-nc-barlab' }, label));
    const track = h('div', { class: 'hud-nc-track' });
    const fill = h('div', { class: 'hud-nc-fill' });
    fill.style.width = pctWidth(cur, mx);
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(h('b', { class: 'hud-nc-barn' },
      (isNum(cur) ? comma(cur) : '?') + ' / ' + (isNum(mx) ? comma(mx) : '?')));
    return wrap;
  }
  function buildNavCard() {
    const root = el.navcard;
    if (!root) return;
    const m = nav.card ? followers[nav.sel] : null;
    root.className = 'hud-navcard' + (m ? ' is-open' : '');
    el.body.classList.toggle('hud-navcard-open', !!m);
    if (!m) { root.innerHTML = ''; return; }
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'hud-nc-back', 'data-navact': 'close' }));
    const card = h('div', { class: 'hud-nc-card' + (m.dead ? ' is-dead' : '') });
    const top = h('div', { class: 'hud-nc-top' });
    /* faceEl, not a second portrait builder: same crop math, same query-hostile
       retry, same initials fallback the strip already proves in game. */
    const hue = (typeof m.hue === 'number') ? m.hue : hueOf(nav.sel);
    top.appendChild(h('div', { class: 'hud-nc-face' }, faceEl(m, hue)));
    const id = h('div', { class: 'hud-nc-id' });
    id.appendChild(h('div', { class: 'hud-nc-name', title: m.name || '' }, m.name || '—'));
    const chips = h('div', { class: 'hud-nc-chips' });
    if (m.lvl != null) chips.appendChild(h('span', { class: 'hud-nc-chip is-lvl' }, 'Level ' + m.lvl));
    if (m.dead) chips.appendChild(h('span', { class: 'hud-nc-chip is-dead' }, 'Dead'));
    else if (typeof m.following === 'boolean')
      chips.appendChild(h('span', { class: 'hud-nc-chip' }, m.following ? 'Following' : 'Waiting'));
    if (m.dir != null || m.dist != null)
      chips.appendChild(h('span', { class: 'hud-nc-chip is-dir' },
        (m.dir != null ? dirGlyph(m.dir) + ' ' : '') + (m.dist != null ? m.dist + 'm' : '')));
    if (chips.children.length) id.appendChild(chips);
    top.appendChild(id);
    card.appendChild(top);
    const bars = h('div', { class: 'hud-nc-bars' });
    for (const [key, label, cls] of NC_POOLS) {
      const p = m[key];
      if (!p || typeof p !== 'object') continue;
      const b = ncBar(label, p);
      b.classList.add(cls);
      bars.appendChild(b);
    }
    if (bars.children.length) card.appendChild(bars);
    /* whatever else the row happens to carry */
    const extra = h('div', { class: 'hud-nc-fields' });
    for (const k in m) {
      if (NC_KNOWN[k]) continue;
      const v = m[k];
      const t = typeof v;
      if (v == null || v === '' || (t !== 'string' && t !== 'number' && t !== 'boolean')) continue;
      const line = h('div', { class: 'hud-nc-field' });
      line.appendChild(h('span', { class: 'hud-nc-fk' }, ncLabel(k)));
      line.appendChild(h('span', { class: 'hud-nc-fv' }, t === 'boolean' ? (v ? 'Yes' : 'No') : String(v)));
      extra.appendChild(line);
    }
    if (extra.children.length) card.appendChild(extra);
    card.appendChild(h('div', { class: 'hud-nc-foot' },
      '← → someone else · Esc or Backspace back to normal controls'));
    root.appendChild(card);
  }

  window.hudNav = function (op) {
    const n = el.strip.children.length;
    if (op === 'open') { nav.on = true; nav.open = false; nav.card = false; if (nav.sel >= n) nav.sel = 0; }
    else if (op === 'close') { nav.on = false; nav.open = false; nav.card = false; }
    else if (!nav.on || !n) { applyNav(); return; }
    /* prev/next/enter still arrive from the SINK when C++'s Focus was refused —
       the documented fallback path — so they route through the very same
       functions the keyboard uses. One behaviour, two doors. */
    else if (op === 'next') { navStep(1); return; }
    else if (op === 'prev') { navStep(-1); return; }
    else if (op === 'enter') { navEnter(); return; }
    applyNav();
    /* the grown face changes the strip's box — re-pack or it overlaps the
       neighbouring block (the SunHelm survival report) */
    if (typeof fitWidgets === 'function') fitWidgets();
  };
  /* click-away / a click on a face while browsing. The view holds the mouse
     during browse (focus menu on), so these are real clicks. */
  function onNavClick(e) {
    if (!nav.on || editing) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-navact="close"]')) { navDone('click'); e.preventDefault(); return; }
    if (t.closest('.hud-nc-card')) return;                 // inside the card: keep it
    const chip = t.closest('#hud-strip .hud-chip');
    if (chip) {
      const i = Array.prototype.indexOf.call(el.strip.children, chip);
      if (i >= 0) { nav.sel = i; nav.card = true; nav.open = true; applyNav(); }
      e.preventDefault();
      return;
    }
    navDone('click');
  }
  window.addEventListener('pointerdown', onNavClick, true);

  window.hudData = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    followers = Array.isArray(j) ? j : (j && Array.isArray(j.followers) ? j.followers : []);
    render();
    applyStripBg();   // the strip's box may have grown/shrunk with the roster
  };

  /* Read only keys we know, and only of the right type — an old or newer DLL
     must never be able to put this view into a shape it cannot draw. Both
     spellings are accepted: the flat one this view defined before the contract
     landed, and the real `widgets:{<id>:{enabled}}` block. */
  function takeWidgetCfg(j) {
    if (!j || typeof j !== 'object') return;
    if (typeof j.on === 'boolean') wcfg.on = j.on;
    else if (typeof j.enabled === 'boolean') wcfg.on = j.enabled;

    const W = (j.widgets && typeof j.widgets === 'object') ? j.widgets : null;
    const flag = (o) => (typeof o === 'boolean') ? o
      : (o && typeof o === 'object' && typeof o.enabled === 'boolean') ? o.enabled : undefined;

    if (W) {
      for (const k in CFG_ID) { const v = flag(W[CFG_ID[k]]); if (v !== undefined) wcfg[k] = v; }
      /* Weather and place are two widgets over one readout slot — the slot is on
         if EITHER is, so turning the pair off in the deck also empties it here. */
      const wx = flag(W.weather), pl = flag(W.place);
      if (wx !== undefined || pl !== undefined) wcfg.context = !!(wx || pl);
      /* Some blocks may also be spelled flat inside the same object. */
      for (const k of LINE_KEYS.concat(BLOCK_KEYS)) { const v = flag(W[k]); if (v !== undefined) wcfg[k] = v; }
    }
    const src = W || j;
    for (const k of LINE_KEYS.concat(BLOCK_KEYS, DETAIL_KEYS)) { const v = flag(src[k]); if (v !== undefined) wcfg[k] = v; }
    /* Round 3: the free slot widgets take their WHOLE Widget — enabled AND
       placement — since this view draws them at those coordinates. Clamped by
       vocabulary, never trusted blindly (an old or hand-edited config must not
       be able to park a widget at anchorH:"purple"). */
    if (W) {
      for (const k of FREE_KEYS) {
        const o = W[k];
        if (!o || typeof o !== 'object') continue;
        const w = wfree[k];
        if (typeof o.enabled === 'boolean') wcfg[k] = o.enabled;
        for (const f of ['x', 'y', 'scale', 'opacity']) if (isNum(o[f])) w[f] = o[f];
        if (o.anchorH === 'left' || o.anchorH === 'center' || o.anchorH === 'right') w.anchorH = o.anchorH;
        if (o.anchorV === 'top' || o.anchorV === 'bottom') w.anchorV = o.anchorV;
        for (const f of ['bare', 'showLabel', 'hideInMenus']) if (typeof o[f] === 'boolean') w[f] = o[f];
        w.scale = clamp(num(w.scale, 1), 0.5, 2.5);
        w.opacity = clamp(num(w.opacity, 1), 0.3, 1);
      }
      /* round 4: quick2 carries a list as well as a placement. Read it under
         the same vocabulary clamps — a hand-edited sidecar must not be able to
         put a widget into a shape this view cannot draw. */
      const q2cfg = W.quick2;
      if (q2cfg && typeof q2cfg === 'object') {
        if (isNum(q2cfg.max)) q2.max = clamp(Math.round(q2cfg.max), 1, Q2_MAX_ITEMS);
        if (Array.isArray(q2cfg.items)) {
          const items = [];
          for (const o of q2cfg.items) {
            if (!o || typeof o !== 'object' || !o.plugin || !o.formId) continue;
            const it = { plugin: String(o.plugin), formId: String(o.formId), name: String(o.name || '') };
            if (isNum(o.keyCode) && o.keyCode > 0) {
              it.keyCode = Math.round(o.keyCode);
              it.keyDevice = (o.keyDevice === 'mouse') ? 'mouse' : 'keyboard';
              it.keyLabel = String(o.keyLabel || '');
            }
            items.push(it);
            if (items.length >= Q2_MAX_ITEMS) break;
          }
          q2.items = items;
          /* C++ just told us what it holds, so nothing local is pending */
          q2.dirty = false;
          fwSigs.quick2 = '';
        }
      }
      migrateFreeDefaults();
    }
    /* Per-widget hideInMenus (default true, matching the plugin). Any ENABLED
       widget that opts out keeps the whole plate up in menus — see the note in
       renderWidgets for why this is decided per plate and not per block. */
    if (W) {
      let keep = false;
      for (const k in W) {
        const o = W[k];
        if (o && typeof o === 'object' && o.enabled && o.hideInMenus === false) keep = true;
      }
      wcfg.keepInMenus = keep;
    }
    const hudPrefs = j.hud && typeof j.hud === 'object' ? j.hud : null;
    if (hudPrefs) for (const k of DETAIL_KEYS) { const v = flag(hudPrefs[k]); if (v !== undefined) wcfg[k] = v; }
    if (hudPrefs && hudPrefs.detSeeded) detSeeded = true;
    /* (An old blob's `cfgPos` is ignored — the shelf is docked.) */
    /* which edge the shelf hangs on; anything unrecognised (or an older config
       with no `shelf` key at all) means the shipped right edge */
    if (hudPrefs && hudPrefs.shelf && typeof hudPrefs.shelf === 'object')
      shelfSideV = hudPrefs.shelf.side === 'left' ? 'left' : 'right';
    applyShelfSide();
    if (hudPrefs && hudPrefs.grp && typeof hudPrefs.grp === 'object') {
      const g = hudPrefs.grp;
      if (typeof g.locked === 'boolean') wgrp.locked = g.locked;
      if (isNum(g.x)) wgrp.x = g.x;
      if (isNum(g.y)) wgrp.y = g.y;
      if (g.anchorH === 'right' || g.anchorH === 'center' || g.anchorH === 'left') wgrp.anchorH = g.anchorH;
      if (g.anchorV === 'bottom' || g.anchorV === 'top') wgrp.anchorV = g.anchorV;
      if (isNum(g.scale)) wgrp.scale = clamp(num(g.scale, 1), 0.5, 2.5);
      /* MIGRATION (2026-08-18). A config written before the merge simply has
         neither key: `orient` falls back to the shipped vertical, and a null
         `mem` means the master switch restores all three lines the first time
         it is used. Nothing else moves — the group's anchor, position, scale
         and lock state are read above exactly as they always were, and each
         line's own on/off still lives in `widgets.<key>.enabled` on the C++
         side, so a player who had (say) only the right hand on keeps only the
         right hand on. */
      if (g.orient === 'horiz' || g.orient === 'vert') wgrp.orient = g.orient;
      /* 2026-08-19: linked membership. Read through FREE_KEYS so a hand-edited
         blob can never weld something that is not a free widget, and an empty
         list falls back to the three shipped members rather than to a group
         that owns nothing. */
      if (Array.isArray(g.keys)) {
        const ks = [];
        for (const k of FREE_KEYS) if (g.keys.indexOf(k) !== -1) ks.push(k);
        wgrp.keys = ks.length ? ks : null;
      }
      if (Array.isArray(g.mem)) {
        const mem = [];
        for (const k of g.mem) if (FREE_KEYS.indexOf(k) !== -1 && mem.indexOf(k) === -1) mem.push(k);
        wgrp.mem = mem.length ? mem : null;
      }
    }
    if (hudPrefs && hudPrefs.det && typeof hudPrefs.det === 'object') {
      for (const k of DET_KEYS) {
        const d = hudPrefs.det[k];
        if (!d || typeof d !== 'object') continue;
        wdet[k] = { on: !!d.on, x: num(d.x, 0), y: num(d.y, 0),
          anchorH: d.anchorH === 'right' ? 'right' : d.anchorH === 'center' ? 'center' : 'left',
          anchorV: d.anchorV === 'bottom' ? 'bottom' : 'top',
          scale: clamp(num(d.scale, 1), 0.5, 2.5) };
      }
    }
    /* widget backgrounds (sanitised on read — a hand-edited blob can never
       point the layer outside the view or carry a query URL) */
    if (hudPrefs) bgFrom(hudPrefs.bg);
    applyWidgetCfg();
    applyAllBgs();
  }
  /* wgMenus(1|0) — pushed by the plugin's 150ms beat: a menu owns the screen,
     or there is no save loaded at all. The HUD is the view that draws the
     widgets now, so it is the view that has to answer this; the flag used to
     reach the hotbar view only, which is why the readouts kept painting over
     the main menu. */
  window.wgMenus = function (v) {
    const now = (v === true || v === 1 || String(v) === '1');
    if (now === menusOpen) return;
    menusOpen = now;
    renderWidgets();
    applyVisible();
    fitWidgets();
  };

  window.hudWidgetCfg = function (s) {
    takeWidgetCfg((typeof s === 'string') ? parse(s) : s);
    renderWidgets(); if (cfgOpen) buildSettings(); render();
  };

  /* ---- the deck's Home drawer, driving the GROUP (home-grp-relay) --------
     The Home tab's "UI Elements" drawer lives in the DECK view, which cannot
     call into this one — so C++ relays its command here (main.cpp
     OnJsWidgetGrp → Invoke hudGrpCmd). It runs the SAME functions the shelf's
     own buttons run, because the master's memory, the orientation, the scale
     and the membership all live in THIS view's `hud.grp` blob: a second
     implementation on the deck side could only ever disagree with this one.
       { op: 'master' | 'orient' | 'size' | 'lock' | 'link', on?, orient?,
         size: 'bigger'|'smaller'|'reset', key? }
     The truth flows back the ordinary way — saveWidgetCfg → C++ → the deck's
     hdUiStateData — so the drawer's chips correct themselves within a frame. */
  window.hudGrpCmd = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    const op = String(j.op || '');
    const has = function (v) { return v !== undefined && v !== null; };
    if (op === 'master') {
      grpSetMaster(has(j.on) ? !!j.on : !grpAnyOn());
    } else if (op === 'orient') {
      wgrp.orient = (j.orient === 'horiz') ? 'horiz' : 'vert';
      applyGroup();
    } else if (op === 'size') {
      /* the SHARED stepper — same id, same clamp, same save as the shelf's
         size row and the group's own mini toolbar */
      const id = 'det:fwgrp';
      if (j.size === 'reset') scaleSet(id, 1);
      else scaleSet(id, scaleOf(id) + (j.size === 'smaller' ? -SCALE_STEP : SCALE_STEP));
    } else if (op === 'lock') {
      wgrp.locked = has(j.on) ? !!j.on : !wgrp.locked;
      applyGroup(); renderFree();
    } else if (op === 'link') {
      if (!grpLink(String(j.key || ''), has(j.on) ? !!j.on : !grpHas(String(j.key || '')))) return;
    } else {
      return;
    }
    applyWidgetCfg(); renderWidgets(); renderFree();
    if (cfgOpen) buildSettings();
    saveWidgetCfg();
    render();
  };

  window.hudWidgets = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    // Accept either the bare live blob or a {config, live} envelope.
    if (j.config || j.cfg) takeWidgetCfg(j.config || j.cfg);
    live = normLive((j.live && typeof j.live === 'object') ? j.live : j);
    renderWidgets();
    el.panel.classList.toggle('is-blank', followers.length === 0 && !widgetsDrawn());
    /* This path deliberately skips the full render() — it fires on every live
       tick and redrawing the follower strip with it would be pure waste — but
       the stack it just rebuilt is exactly what can outgrow the screen, so the
       fit still has to be checked here. */
    fitWidgets();
    /* `true` = the cheap path: rebuild only if the card's own content moved */
    if (cfgOpen) buildSettings(true);
  };

  /* The render index. Shape matches the wardrobe pane's so a straight reuse of
     the existing C++ reply works untouched. */
  window.hudIconsData = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    const icons = j.icons || j.map || j;
    if (icons && typeof icons === 'object')
      for (const k in icons) if (typeof icons[k] === 'string') iconIndex[normKey(k)] = icons[k];
    const fails = j.fails || j.failed;
    if (fails && typeof fails === 'object')
      for (const k in fails) iconFail[normKey(k)] = String(fails[k] || 'no render');
    /* Art landing must NOT rebuild the tiles — it appends the <img> that is
       missing and nothing else. Then re-sign, so a later structural rebuild
       carries the path. */
    for (const tile of el.pins.querySelectorAll('.hud-pin-art')) {
      if (tile.getAttribute('data-icon')) continue;
      const i = Array.prototype.indexOf.call(el.pins.children, tile.parentNode);
      const p = pinsList()[i];
      const url = p ? pinIcon(p) : '';
      if (url) tile.setAttribute('data-icon', url);
    }
    for (const tile of el.equip.querySelectorAll('.hud-eq-art')) {
      if (tile.getAttribute('data-icon')) continue;
      const i = Array.prototype.indexOf.call(el.equip.children, tile.parentNode);
      const t = eqList()[i];
      const url = t ? pinIcon(t) : '';
      if (url) tile.setAttribute('data-icon', url);
    }
    pinSigs = pinsList().map(pinSig);
    eqSigs = eqList().map(eqSig);
    /* round 3: re-render the free widgets so their structural signatures pick
       up the newly-landed art paths (the sig carries the icon url). */
    renderFree();
    upgradeArt();
    if (!missingArt()) stopIconPoll();
  };
  // The wheel's own reply name, in case C++ reuses that listener verbatim.
  if (typeof window.whIconsData !== 'function') window.whIconsData = window.hudIconsData;
  // Aliases for the widget bridge as src/widgets.cpp currently spells it.
  if (typeof window.wgConfig !== 'function') window.wgConfig = window.hudWidgetCfg;
  if (typeof window.wgLive !== 'function') window.wgLive = window.hudWidgets;

  /* ---- round 4 replies (C++ -> view) ------------------------------------ */
  /* wgQuick2Use answered. A refusal is the useful sentence, so it is TOASTED
     rather than swallowed; a success that spent a consumable patches the count
     in place (the forced wgLive is coming anyway, this just beats it). */
  window.wgQuick2Result = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    if (j.msg) toast(String(j.msg), j.ok === false);
    if (isNum(j.newCount)) {
      const rows = q2Rows();
      const pl = String(j.plugin || '').toLowerCase(), fid = canonHex8(j.formId);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (String(r.plugin || '').toLowerCase() !== pl || canonHex8(r.formId) !== fid) continue;
        const art = elFree.quick2.querySelectorAll('.hud-fw-qart')[i];
        const c = art && art.querySelector('.hud-pin-count');
        if (c) setBump(c, comma(j.newCount));
        break;
      }
    }
  };
  /* The picker's feed — one inventory walk, asked for once per open. */
  window.wgQuick2CatalogData = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    const rows = Array.isArray(j.rows) ? j.rows : [];
    q2pick.rows = rows.map(function (r) {
      if (!r || typeof r !== 'object' || !r.plugin || !r.formId) return null;
      return { name: String(r.name || ''), kind: String(r.kind || 'misc'),
        count: isNum(r.count) ? r.count : null,
        formId: String(r.formId), plugin: String(r.plugin) };
    }).filter(Boolean);
    q2pick.capped = j.capped === true;
    q2pick.sel = 0;
    if (q2pick.open) buildQ2Pick();
  };

  window.hudEdit = function (s) { setEditing(String(s) === '1' || s === true); };
  // Convenience single-flag setter C++ can use for the toggle key.
  window.hudSetVisible = function (s) { cfg.visible = (String(s) === '1' || s === true); applyVisible(); };

  // Expose a tiny surface for the harness / debugging.
  window.__hud = {
    cfg, wcfg,
    get followers() { return followers; },
    get live() { return live; },
    get editing() { return editing; },
    get cfgOpen() { return cfgOpen; },
    render, renderWidgets, setEditing, saveCfg,
    setCfgOpen, buildSettings, applyPreset, activePreset,
    /* the ⚙ card's filter-as-you-type (2026-08-18) */
    setOptFilter: function (s) { cfgFilter = String(s || ''); const i = document.getElementById('hud-cfg-filter'); if (i) i.value = cfgFilter; applyOptFilter(); },
    applyOptFilter, applyPlacement,
    /* browse mode's key hint */
    placeNavHint, NAV_HINT_TEXT,
    /* the shelf (2026-08-19) + the retired panel shell */
    placeSettings, applyShell, focusShelfEl,
    /* round 3: the strip's own edit scope, and the panel's blank verdict */
    setStripEdit, panelHasContent,
    get stripEditing() { return stripEditing(); },
    get strip() { return strip; },
    get cfgFocus() { return cfgFocus; },
    RO_DET, DET_KEYS, needsSeed,
    iconIndex, iconKey, pinIcon, timeText, ctxKind, ctxText, comma,
    /* round 2 surface, for the harness and the Ultralight probe */
    calendarText, renderCalendar, hudOnlyPrefs,
    renderVitals, renderResist, renderEffects, renderEquip, renderSurvival, renderAllies,
    fmtSecs, artItems, RESIST_ROWS,
    _icons: { request: requestIcons, upgrade: upgradeArt, schedule: scheduleIcons, stop: stopIconPoll },
  };

  /* ======================================================================
     ROUND 3 (2026-08-17) — the four FREE slot widgets.
     Rober: "four widgets, ripped from this [Skyrim Party Sheet's Equipment
     Widget] … fourth being one for quick items … render icons with mesh
     framework, use the shouts icons, (shouts should also support powers) …
     should be able to place anywhere on screen indvidually".

     Right hand · Left hand (auto-switches to the nocked ammo behind a bow —
     the reference's own rule) · Shout/Power (gold glow when the voice is
     ready, a recovery veil while it is not) · Quick items (everything
     FAVOURITED in inventory, live counts, vanilla hotkey digits).

     They draw on a separate fixed layer, NOT inside the movable assembly:
     each carries its OWN x/y/anchor/scale/opacity from src/widgets.cpp's
     Widget config, dragged individually in edit mode. Art: gear rides the
     SAME mesh-render route as the pins (one pipeline, never a second); the
     spell-family kinds resolve through the Spell Deck's OWN ladder —
     per-spell override → byForm exact → school/tier generic → vector glyph —
     fed once per session by hudIconIndex (the deck's sh_index + the player's
     magic.spells[].icon overrides, portal uploads included via the custom-
     icon mirror). Same perf law as everything above: structural signature
     rebuilds, volatile numbers written in place, no loops, no conic.
     ====================================================================== */

  const elFree = {
    layer: need('hud-free'),
    handR: need('hud-fw-handR'),
    handL: need('hud-fw-handL'),
    voice: need('hud-fw-voice'),
    quick: need('hud-fw-quick'),
    quick2: need('hud-fw-quick2'),
    lootStatus: need('hud-fw-lootStatus'),
    season: need('hud-fw-season'),
    ward: need('hud-fw-ward'),
  };

  function eqBySlot(slot) {
    for (const t of eqList()) if (t.slot === slot) return t;
    return null;
  }

  /* voice-slot glyphs: the shout arcs already exist (VITAL_ART.shout); a
     power is a starburst — drawn here, nothing borrowed. */
  const POWER_ART = ['M12 3.2v5', 'M12 15.8v5', 'M3.2 12h5', 'M15.8 12h5',
    'M6 6l3 3', 'M15 15l3 3', 'M18 6l-3 3', 'M9 15l-3 3', ['circle', 12, 12, 2.2]];
  EQUIP_ART.shout = VITAL_ART.shout;
  EQUIP_ART.power = POWER_ART;
  EQUIP_ART.lesser = POWER_ART;

  /* ---- the spell-icon resolver (the Spell Deck's ladder, ported) --------
     ⚠ 2026-08-19: this ladder had DRIFTED from the one hd-art.js/app.js run,
     which is exactly the failure mode HDArt was written to end — the same
     power wearing art in the Spell Deck and a bare glyph on the HUD. hd-art.js
     itself cannot simply be loaded here (it taps bridge verbs and starts a
     render poll; this view is always-on and must stay cheap), so instead the
     ladder is brought to PARITY with HDArt.genericKeys: the archetype rungs
     for Restoration / Illusion / Conjuration, and the name-sniff that recovers
     a school the payload omitted. Keep the two in step — a rung added there
     belongs here the same day. */
  const SICON = { byForm: {}, generic: {}, overrides: {} };
  function normIconPath(p) { return safePath(String(p == null ? '' : p).replace(/\\/g, '/')); }
  window.hudIconIndex = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j || typeof j !== 'object') return;
    /* Keys are LOWERCASED on ingest, exactly as the Spell Deck's ingest does
       (app.js `byForm[String(k).toLowerCase()]`). The extractor already emits
       lowercase, so this changes nothing today — it is the defence that stops
       a hand-edited or portal-written index from silently missing every hit,
       since the lookup key is built lowercase. `generic` keys are SHOUTED by
       construction, so they are taken verbatim. */
    if (j.byForm && typeof j.byForm === 'object') {
      const bf = {};
      for (const k in j.byForm) bf[String(k).toLowerCase()] = j.byForm[k];
      SICON.byForm = bf;
    }
    if (j.overrides && typeof j.overrides === 'object') {
      const ov = {};
      for (const k in j.overrides) ov[String(k).toLowerCase()] = j.overrides[k];
      SICON.overrides = ov;
    }
    if (j.generic && typeof j.generic === 'object') SICON.generic = j.generic;
    /* Both consumers repaint: the free slot widgets AND the stacked equip
       block, which resolves through this same ladder since 2026-08-19. A
       re-push (a mid-session icon assignment) must move BOTH or the picture
       disagrees with itself. */
    renderFree();
    eqSigs = [];          // force the stacked block to rebuild with the new art
    renderWidgets();
  };
  const SPELL_TIER_KEY = { novice: 'NOVICE', apprentice: 'APPRENTICE', adept: 'ADEPT', expert: 'EXPERT', master: 'MASTER' };
  /* the name-sniff rung, byte-for-byte HDArt's SCHOOL_WORDS */
  const SPELL_SCHOOL_WORDS = [
    ['destruction', /fire|flame|frost|ice|shock|lightning|burn|blast|thunder/i],
    ['restoration', /heal|ward|turn undead|cure|restor|sun|vampire's bane/i],
    ['illusion', /fury|calm|fear|frenzy|muffle|invisib|clairvoy|courage|rout|pacify/i],
    ['conjuration', /conjure|summon|bound |raise |reanimat|soul trap|dread|command daedra/i],
    ['alteration', /oakflesh|stoneflesh|ironflesh|ebonyflesh|dragonhide|candlelight|magelight|detect|paralyz|telekinesis|waterbreathing|transmute/i],
  ];
  function spellSchoolOf(t) {
    const s = String(t.school || '').toLowerCase();
    if (s) return s;
    const hay = String(t.name || '');
    if (!hay) return '';
    for (let i = 0; i < SPELL_SCHOOL_WORDS.length; i++)
      if (SPELL_SCHOOL_WORDS[i][1].test(hay)) return SPELL_SCHOOL_WORDS[i][0];
    return '';
  }
  function spellFormKey(t) {
    if (!t || !t.plugin || !t.formId) return '';
    const n = parseInt(String(t.formId), 16);
    if (!isFinite(n)) return '';
    return String(t.plugin).toLowerCase() + '|' + (n >>> 0).toString(16);
  }
  /* Every generic key worth trying, best first — the UNION HDArt settled on. */
  function spellGenericKeys(t) {
    const out = [];
    const kind = String(t.kind || '').toLowerCase();
    const slot = String(t.slot || '').toLowerCase();
    if (kind === 'shout' || kind === 'voice') { out.push('SHOUT_GENERIC'); return out; }
    if (kind === 'power') { out.push('GREATER_POWER'); return out; }
    if (kind === 'lesser') { out.push('LESSER_POWER'); return out; }
    /* a voice-slot row whose kind never arrived is still a power, not a spell */
    if (!kind && slot === 'voice') { out.push('GREATER_POWER'); return out; }
    const tr = SPELL_TIER_KEY[String(t.tier || '').toLowerCase()] || 'ADEPT';
    const school = spellSchoolOf(t);
    const arch = String(t.archetype || '').toLowerCase();
    const el2 = String(t.element || '').toLowerCase();
    switch (school) {
      case 'destruction':
        if (el2 === 'fire' || el2 === 'frost' || el2 === 'shock')
          out.push('DESTRUCTION_' + el2.toUpperCase() + '_' + tr);
        out.push('DESTRUCTION_GENERIC_' + tr);
        break;
      case 'restoration':
        out.push((arch === 'turnundead' || arch === 'banish' ? 'RESTORATION_HOSTILE_' : 'RESTORATION_FRIENDLY_') + tr);
        out.push('RESTORATION_FRIENDLY_' + tr);
        break;
      case 'illusion':
        out.push((arch === 'fear' || arch === 'frenzy' || arch === 'calm' ? 'ILLUSION_HOSTILE_' : 'ILLUSION_FRIENDLY_') + tr);
        out.push('ILLUSION_FRIENDLY_' + tr);
        break;
      case 'conjuration':
        out.push((arch === 'bound' ? 'CONJURATION_BOUND_WEAPON_' : 'CONJURATION_SUMMON_') + tr);
        out.push('CONJURATION_SUMMON_' + tr);
        break;
      default:
        if (school) { out.push(school.toUpperCase() + '_' + tr); out.push(school.toUpperCase() + '_GENERIC_' + tr); }
        break;
    }
    return out;
  }
  function spellArt(t) {
    if (!t) return '';
    /* An icon the OWNER picked wins outright — including one handed straight
       down on the row (the precedence law: custom upload > render > stock). */
    const own = normIconPath(t.icon);
    if (own) return own;
    const key = spellFormKey(t);
    if (key && SICON.overrides[key]) return normIconPath(SICON.overrides[key]);
    if (key && SICON.byForm[key]) return normIconPath(SICON.byForm[key]);
    const g = SICON.generic || {};
    const cand = spellGenericKeys(t);
    for (const c of cand) if (g[c]) return normIconPath(g[c]);
    return '';
  }
  const SPELL_KINDS = { spell: 1, shout: 1, power: 1, lesser: 1 };

  /* The initial render index arrives as wdItemIcons on this view (the push
     OnJsHudReady already makes); it is the same shape hudIconsData reads. */
  if (typeof window.wdItemIcons !== 'function') window.wdItemIcons = window.hudIconsData;

  /* ---- placement -------------------------------------------------------- */
  function placeFree(root, w) {
    const s = root.style;
    s.left = s.right = '';
    let tx = '';
    if (w.anchorH === 'right') { s.right = Math.round(num(w.x, 0)) + 'px'; }
    else if (w.anchorH === 'center') { s.left = 'calc(50% + ' + Math.round(num(w.x, 0)) + 'px)'; tx = 'translateX(-50%) '; }
    else { s.left = Math.round(num(w.x, 0)) + 'px'; }
    if (w.anchorV === 'bottom') { s.bottom = Math.round(num(w.y, 0)) + 'px'; s.top = 'auto'; }
    else { s.top = Math.round(num(w.y, 0)) + 'px'; s.bottom = 'auto'; }
    s.transform = tx + 'scale(' + num(w.scale, 1) + ')';
    s.transformOrigin = (w.anchorV === 'bottom' ? 'bottom' : 'top') + ' ' +
      (w.anchorH === 'right' ? 'right' : w.anchorH === 'center' ? 'center' : 'left');
    s.opacity = String(editing ? 1 : num(w.opacity, 1));
  }

  /* ---- data selection per widget ---------------------------------------- */
  function freeRow(k) {
    if (k === 'handR') return eqBySlot('right');
    if (k === 'voice') return eqBySlot('voice');
    if (k === 'handL') {
      /* The reference's bow rule: behind a ranged weapon the left slot shows
         the nocked AMMO with its live count — the hand itself is just the bow
         again, and the arrows are the number you act on. */
      const l = eqBySlot('left'), am = eqBySlot('ammo'), r = eqBySlot('right');
      if (am && r && r.ranged && (!l || l.kind === 'empty')) return am;
      return l;
    }
    return null;
  }
  const FW_SLOT_CHIP = { handR: 'R', handL: 'L', voice: 'Z', quick: 'Q', ward: 'W' };
  const FW_GHOST = {
    handR: 'Right hand', handL: 'Left hand / ammo',
    voice: 'Shout / power', quick: 'Quick items — favourite something (★)',
    /* The ghost is only ever seen inside Reposition mode, so it names the one
       button that fills it rather than describing the widget (Rober's
       "easy / self explanatory" bar, 2026-08-18). */
    quick2: 'My items — nothing here yet.\nPress ＋ Add items below.',
    lootStatus: 'Loot lamp — no loot mod is answering right now',
    /* The season ghost NAMES the mod, because "nothing here" and "you do not
       have Seasons of Skyrim" look identical otherwise and only one of them is
       something the player can act on. */
    season: 'Season — needs Seasons of Skyrim',
    ward: 'Ward — learn a ward spell to light this up',
  };

  /* The ward widget's row: the live.ward document reshaped into the slot-card
     vocabulary. kind "spell" on purpose — the art resolves through the SAME
     Spell Deck icon ladder as a hand spell, so the tile shows the actual
     ward's icon. `on` drives the up/down chrome; `count` doubles as the live
     ward strength badge (the engine's WardPower, whole points). */
  function wardRow() {
    const w = live.ward;
    if (!w) return null;
    return {
      kind: 'spell', on: w.on === true,
      name: w.name + (w.maint ? ' · auto' : ''),
      plugin: w.plugin || '', formId: w.formId || '',
      school: w.school || 'restoration', element: w.element || '', tier: w.tier || '',
      count: (w.on === true && isNum(w.power) && w.power > 0) ? w.power : undefined,
    };
  }

  /* ⚠ THREE INDEPENDENT SYSTEMS (Rober, 2026-08-19: "if hud widgets is off,
     other widgets stop showing, dont do that (equipped widget)" … "follower
     hud should be seperate, equipement widget should be seperate, and so
     should hud element").

       1. the follower STRIP        — cfg.visible / cfg.enabled
       2. the free widgets          — wcfg[k] per widget (this gate)
       3. the readout STACK         — wcfg.on

     `wcfg.on` used to be read here too, so the stack's master switch silently
     took the Equipped group, the quick items and the loot lamp down with it.
     It is the STACK's master and nothing else now; a free widget answers to
     its own switch alone. The C++ half of the same split lives in
     widgets.cpp RecountAnyLocked (marker widgets-vis-split). */
  function fwGate(k) {
    if (!wcfg[k]) return false;
    if (menusOpen && wfree[k].hideInMenus !== false && !editing) return false;
    return true;
  }

  /* ---- render ------------------------------------------------------------ */
  const fwSigs = { handR: '', handL: '', voice: '', quick: '', quick2: '', lootStatus: '', season: '', ward: '' };
  let fwSelected = '';

  function fwArtFor(row) {
    if (!row) return '';
    if (SPELL_KINDS[row.kind]) return spellArt(row);
    return pinIcon(row);
  }

  function slotCardSig(k, row) {
    if (!row || row.kind === 'empty')
      return ['ghost', editing ? 'e' : '', wcfg[k] ? '1' : ''].join('|');
    return [row.kind, row.name, fwArtFor(row), (row.badges || []).length,
      isNum(row.damage) ? 'd' : '', isNum(row.armor) ? 'a' : '', isNum(row.count) ? 'c' : '',
      row.cd ? 'cd' : '',
      /* ward: up/down is card CHROME (glow vs dimmed + status chip), so a
         state flip must rebuild — the sig carries it */
      typeof row.on === 'boolean' ? (row.on ? 'W1' : 'W0') : '',
      wfree[k].bare ? 'b' : '', wfree[k].showLabel === false ? 'nl' : '',
      editing ? 'e' : ''].join('|');
  }

  /* write text and BUMP the badge when the value actually moved — a one-shot
     scale pop, retriggered by class re-add (the reflow read restarts it).
     Never fires on a same-value tick, so the idle cost stays zero. */
  function setBump(node, s) {
    if (!node || node.textContent === s) return;
    node.textContent = s;
    node.classList.remove('fw-bump');
    void node.offsetWidth;
    node.classList.add('fw-bump');
  }

  /* PER-SLOT ACCENT (Rober, 2026-08-18, holding up the Party Sheet reference:
     each slot wears a distinct colour). One class, three families, so a card
     says WHAT KIND OF THING it is holding before you have read the name:
       gear  — steel/gold, the neutral default (weapons, ammo, shields, gear)
       spell — blue, the school colour the deck already uses for magicka
       voice — warm gold, the shout/power family the ready-glow already lights
     Deliberately a function of the ROW's kind, not of the widget key: the left
     hand holds a spell as often as a shield, and the card must follow the
     thing, not the slot it happens to sit in. */
  const FW_ACCENT = { spell: 'spell', shout: 'voice', power: 'voice', lesser: 'voice' };
  function fwAccent(row) { return (row && FW_ACCENT[row.kind]) || 'gear'; }

  function buildSlotCard(k, row) {
    const root = elFree[k];
    root.innerHTML = '';
    /* fw-in: the one-shot entrance. A weapon SWAP lands here too — the sig
       carries the name, so switching swords rebuilds the card and the new
       one rises in instead of popping. */
    const card = h('div', { class: 'hud-fw-card fw-in fw-k-' + fwAccent(row) });
    if (!row || row.kind === 'empty') {
      card.classList.add('is-ghost');
      card.appendChild(h('div', { class: 'hud-fw-ghost' }, FW_GHOST[k]));
      root.appendChild(card);
      return;
    }
    const art = h('div', { class: 'hud-fw-art', title: row.name || '' });
    const url = fwArtFor(row);
    if (SPELL_KINDS[row.kind]) {
      const spellGlyph = h('span', { class: 'hud-fw-glyph' },
        svgIcon(EQUIP_ART[row.kind] || EQUIP_ART.spell, 34));
      art.appendChild(spellGlyph);
      if (url) {
        /* spell art is a known file, not a lazy render. The pool lives in the
           MAGICDECK view folder and a view CANNOT read another view's folder
           (probe-proven, dac9a2cc: a cross-view img silently loads 0x0) — so
           the DLL mirrors MagicDeck/icons into THIS view's icons/ at startup
           (hud-icon-mirror) and the LOCAL path is the only candidate. A 0x0
           "success" is treated as the failure it is. */
        const img = document.createElement('img');
        img.className = 'hud-pin-img'; img.alt = ''; img.draggable = false;
        const fail = function () {
          if (img.parentNode) img.parentNode.removeChild(img);
          spellGlyph.style.display = '';
        };
        img.onload = function () { if (!img.naturalWidth) fail(); };
        img.onerror = fail;
        img.src = url;
        art.appendChild(img);
        spellGlyph.style.display = 'none';
      }
    } else {
      if (url) art.setAttribute('data-icon', url);
      art.appendChild(h('span', { class: 'hud-fw-glyph' },
        svgIcon(EQUIP_ART[row.kind] || EQUIP_ART.other, 34)));
    }
    if (isNum(row.count)) art.appendChild(badge('hud-pin-count', row.count < 0 ? '?' : comma(row.count)));
    if (isNum(row.damage)) art.appendChild(badge('hud-eq-badge hud-pin-dmg', comma(row.damage)));
    else if (isNum(row.armor)) art.appendChild(badge('hud-eq-badge hud-pin-armor', comma(row.armor)));
    if (row.cd) {
      /* the veil scales (scaleY), so the countdown text lives BESIDE it, not
         inside — a child would shrink with the drain */
      art.appendChild(h('div', { class: 'hud-fw-cd' }));
      art.appendChild(h('b', { class: 'hud-fw-cdt' }));
    }
    card.appendChild(art);
    /* ward: the up/down verdict is the widget's whole point, so it gets card
       chrome of its own — gold ready-glow + "UP" chip while a ward is live,
       dimmed art + "DOWN" while it is not. The is-ready class add also fires
       the one-shot gold flash, which reads as the ward snapping up. */
    if (typeof row.on === 'boolean') {
      card.classList.add(row.on ? 'is-ready' : 'is-ward-down');
      card.appendChild(h('span', { class: 'hud-fw-wardst ' + (row.on ? 'st-up' : 'st-down') },
        row.on ? 'UP' : 'DOWN'));
    }
    card.appendChild(h('span', { class: 'hud-fw-slot' }, FW_SLOT_CHIP[k]));
    const ench = h('div', { class: 'hud-fw-badges' });
    for (const b of (row.badges || [])) {
      if (!b || !b.text) continue;
      ench.appendChild(h('span', { class: 'hud-badge hud-eq-badge hud-pin-ench' }, String(b.text)));
    }
    if (ench.children.length) card.appendChild(ench);
    card.appendChild(h('div', { class: 'hud-fw-name', title: row.name || '' }, row.name || '—'));
    root.appendChild(card);
  }

  function quickSig() {
    if (!quickList().length)
      return ['ghost', editing ? 'e' : '', wcfg.quick ? '1' : ''].join('|');
    return quickList().map((q) => [q.id, q.name, pinIcon(q), q.hk || '', q.kind].join('~')).join('|') +
      '|' + (wfree.quick.bare ? 'b' : '') + (wfree.quick.showLabel === false ? 'nl' : '') + (editing ? 'e' : '');
  }
  function buildQuick() {
    const root = elFree.quick;
    root.innerHTML = '';
    const card = h('div', { class: 'hud-fw-card hud-fw-qcard fw-in' });
    const list = quickList();
    if (!list.length) {
      card.classList.add('is-ghost');
      card.appendChild(h('div', { class: 'hud-fw-ghost' }, FW_GHOST.quick));
      root.appendChild(card);
      return;
    }
    const row = h('div', { class: 'hud-fw-qrow' });
    list.forEach(function (q, qi) {
      const tile = h('div', { class: 'hud-fw-qtile', title: q.name + (isNum(q.count) ? ' × ' + comma(q.count) : '') });
      /* the cascade: each tile's one-shot entrance starts 25ms after the
         previous one ('backwards' fill keeps it invisible until its turn) */
      tile.style.animationDelay = (qi * 25) + 'ms';
      const art = h('div', { class: 'hud-fw-art hud-fw-qart' });
      const url = pinIcon(q);
      if (url) art.setAttribute('data-icon', url);
      art.appendChild(h('span', { class: 'hud-fw-glyph' }, svgIcon(READOUT_ART.pin, 22)));
      if (isNum(q.count)) art.appendChild(badge('hud-pin-count', comma(q.count)));
      if (q.hk) art.appendChild(h('span', { class: 'hud-fw-hk', title: 'Vanilla hotkey ' + q.hk }, String(q.hk)));
      tile.appendChild(art);
      row.appendChild(tile);
    });
    card.appendChild(row);
    if (wfree.quick.showLabel !== false)
      card.appendChild(h('div', { class: 'hud-fw-name' }, 'Quick items'));
    root.appendChild(card);
  }

  /* ======================================================================
     ROUND 4 (2026-08-18) — the CUSTOM quick items (`quick2`).
     Rober: "i want a secondary same exact widget where you can add any item to
     it. and keybind each specific one if you care to" + "ability to set how
     many items". So it wears the favourites strip's look exactly (same tiles,
     same art route, same count badges) and differs only in where the rows come
     from: a list the player curates here, stored in C++'s widgets.quick2.

     ⚠ Play mode cannot click a tile — this view is Shown but never Focused
     during play, so nothing here receives a mouse. A tile fires from its BOUND
     KEY (matched in the C++ input sink), or from a click inside edit mode where
     the view IS focused. That is stated on the card rather than faked.
     ====================================================================== */
  function q2KeyLabelOf(it) {
    if (!it) return '';
    return String(it.keyLabel || '');
  }
  /* The live row for a stored item, matched on plugin+formId — the live feed
     carries the counts and the "that mod is off" verdict, the stored list
     carries identity and the bind. Neither is complete alone. */
  function q2LiveFor(it) {
    if (!it) return null;
    const pl = String(it.plugin || '').toLowerCase();
    const fid = canonHex8(it.formId);
    for (const r of quick2List())
      if (String(r.plugin || '').toLowerCase() === pl && canonHex8(r.formId) === fid) return r;
    return null;
  }
  /* What the widget actually draws: one entry per STORED row within `max`,
     married to its live row when C++ has sent one. A stored item with no live
     row yet (the feed has not caught up, or the widget was off) still draws —
     with no count — rather than blinking out of the strip. */
  function q2Rows() {
    /* The stored list is the source of order and of the per-item bind, so it
       leads. But a live feed can arrive BEFORE the config does (C++ pushes them
       on separate paths), and a widget that draws nothing while the game is
       clearly sending it rows reads as broken — so an empty stored list falls
       back to the feed, read-only (`it` is null, so ✕ and ⌨ do not offer to
       edit a row this view cannot yet identify). */
    if (!q2.items.length) {
      return quick2List().slice(0, clamp(q2.max, 1, Q2_MAX_ITEMS)).map(function (r, i) {
        return { i: i, it: null, id: r.id || ('q2' + i), name: r.name, kind: r.kind,
          count: isNum(r.count) ? r.count : null, missing: !!r.missing,
          hk: String(r.hk || ''), formId: r.formId, plugin: r.plugin };
      });
    }
    return q2Drawn().map(function (it, i) {
      const lv = q2LiveFor(it);
      return {
        i: i, it: it,
        id: String(it.plugin || '') + '|' + String(it.formId || i),
        name: String((lv && lv.name) || it.name || '—'),
        kind: String((lv && lv.kind) || it.kind || 'misc'),
        count: lv && isNum(lv.count) ? lv.count : null,
        missing: !!(lv && lv.missing),
        hk: q2KeyLabelOf(it) || (lv ? String(lv.hk || '') : ''),
        formId: it.formId, plugin: it.plugin,
      };
    });
  }
  function quick2Sig() {
    const rows = q2Rows();
    if (!rows.length)
      return ['ghost', editing ? 'e' : '', wcfg.quick2 ? '1' : '', q2.max].join('|');
    return rows.map((r) => [r.id, r.name, pinIcon(r), r.hk, r.missing ? 'x' : '',
      isNum(r.count) ? 'c' : ''].join('~')).join('|') +
      '|' + q2.max + '|' + (q2cap.on ? 'k' + q2cap.i : '') +
      '|' + (wfree.quick2.bare ? 'b' : '') + (wfree.quick2.showLabel === false ? 'nl' : '') +
      (editing ? 'e' : '');
  }
  function q2Btn(act, label, title, cls) {
    return h('button', { class: 'hud-q2-btn' + (cls ? ' ' + cls : ''), type: 'button',
      'data-q2act': act, title: title }, label);
  }
  function buildQuick2() {
    const root = elFree.quick2;
    root.innerHTML = '';
    const card = h('div', { class: 'hud-fw-card hud-fw-qcard hud-q2card fw-in' });
    const rows = q2Rows();
    if (!rows.length) {
      card.classList.add('is-ghost');
      card.appendChild(h('div', { class: 'hud-fw-ghost' }, FW_GHOST.quick2));
    } else {
      const row = h('div', { class: 'hud-fw-qrow' });
      rows.forEach(function (r, qi) {
        const tile = h('div', {
          class: 'hud-fw-qtile hud-q2tile' + (r.missing ? ' is-gone' : ''),
          'data-q2i': String(qi),
          title: r.missing ? (r.name + ' — that mod is switched off')
                           : (r.name + (isNum(r.count) ? ' × ' + comma(r.count) : '') +
                              (r.hk ? ' · ' + r.hk : '')),
        });
        tile.style.animationDelay = (qi * 25) + 'ms';
        const art = h('div', { class: 'hud-fw-art hud-fw-qart', 'data-q2act': 'use' });
        const url = r.missing ? '' : pinIcon(r);
        if (url) art.setAttribute('data-icon', url);
        art.appendChild(h('span', { class: 'hud-fw-glyph' }, svgIcon(READOUT_ART.pin, 22)));
        /* A mod that is OFF gets an em-dash, never a 0 — the pins' rule. */
        if (r.missing) art.appendChild(badge('hud-pin-count hud-pin-gone', '—'));
        else if (isNum(r.count)) art.appendChild(badge('hud-pin-count', comma(r.count)));
        tile.appendChild(art);
        /* The bound key sits UNDER the plate, not on it. The favourites twin
           can corner-park a single digit; these labels are words ("Num 4",
           "F6") and cornering them put them straight through the count badge
           (overlap pass, 2026-08-18). */
        if (r.hk) tile.appendChild(h('span', { class: 'hud-fw-hk hud-q2-hk', title: 'Bound key: ' + r.hk }, r.hk));
        /* an unbound tile in EDIT mode keeps the label's height as an invisible
           placeholder, so a shelf of mixed bound/unbound tiles still lines its
           ⌨/✕ row up instead of stepping (overlap pass, 2026-08-18) */
        else if (editing) tile.appendChild(h('span', { class: 'hud-fw-hk hud-q2-hk is-blank' }, '—'));
        if (r.missing) tile.appendChild(h('div', { class: 'hud-q2-gone' }, 'mod off'));
        /* a row we only know from the live feed cannot be edited by index —
           the ✕ and the bind wait until the config lands */
        if (editing && r.it) {
          const tools = h('div', { class: 'hud-q2-tools' });
          tools.appendChild(h('button', {
            class: 'hud-q2-btn hud-q2-key' + (q2cap.on && q2cap.i === qi ? ' is-listening' : ''),
            type: 'button', 'data-q2act': 'key', 'data-q2i': String(qi),
            title: 'Bind a key to this item. ⚠ The key ALSO does its normal job — this view cannot swallow it.',
          }, q2cap.on && q2cap.i === qi ? 'Press…' : '⌨'));
          tools.appendChild(h('button', {
            class: 'hud-q2-btn hud-q2-x', type: 'button', 'data-q2act': 'rm', 'data-q2i': String(qi),
            title: 'Remove ' + r.name + ' from this widget',
          }, '✕'));
          tile.appendChild(tools);
        }
        row.appendChild(tile);
      });
      card.appendChild(row);
    }
    if (wfree.quick2.showLabel !== false)
      card.appendChild(h('div', { class: 'hud-fw-name' }, 'My items'));
    if (editing) {
      const ed = h('div', { class: 'hud-q2-edit' });
      const top = h('div', { class: 'hud-q2-edrow' });
      top.appendChild(q2Btn('add', '＋ Add items', 'Search everything you are carrying and add it here', 'is-primary'));
      /* the rows stepper — stored beyond drawn, so lowering this HIDES rows */
      const step = h('div', { class: 'hud-q2-step' });
      step.appendChild(h('span', { class: 'hud-q2-steplab' }, 'Rows'));
      step.appendChild(q2Btn('less', '−', 'Draw one row fewer (the item is kept, just hidden)'));
      step.appendChild(h('b', { class: 'hud-q2-stepn' }, String(clamp(q2.max, 1, Q2_MAX_ITEMS))));
      step.appendChild(q2Btn('more', '＋', 'Draw one row more'));
      top.appendChild(step);
      ed.appendChild(top);
      ed.appendChild(h('div', { class: 'hud-q2-note' },
        q2.items.length > clamp(q2.max, 1, Q2_MAX_ITEMS)
          ? ((q2.items.length - clamp(q2.max, 1, Q2_MAX_ITEMS)) + ' more stored below the line — raise Rows to show them. A bound key also does its normal job in game.')
          : 'A bound key also does its normal job in game — this view cannot swallow a keypress.'));
      card.appendChild(ed);
    }
    root.appendChild(card);
  }

  /* ======================================================================
     ROUND 4 — the LOOT LAMP (`lootStatus`).
     Rober: "shows a different color or something when auto loot or glow is
     enabled". Two chips, lit gold when their master is on, dim when it is off.
     Typographic marks only — the 2026-08-16 colour-emoji law — and both are
     marks this view already ships (✦ from the potions readout, ↓ from the
     direction glyphs), so neither is a font gamble.
     ====================================================================== */
  const LOOT_CHIPS = [['glow', '✦', 'Glow', 'Loot Vision — the highlight that glows loot worth walking to'],
                      ['auto', '↓', 'Auto-loot', 'Auto-Loot — picking things up as you walk over them']];
  function lootSig() {
    const ls = lootState();
    if (!ls) return ['ghost', editing ? 'e' : '', wcfg.lootStatus ? '1' : ''].join('|');
    return ['lamp', editing ? 'e' : '', wfree.lootStatus.bare ? 'b' : '',
      wfree.lootStatus.showLabel === false ? 'nl' : ''].join('|');
  }
  function buildLoot() {
    const root = elFree.lootStatus;
    root.innerHTML = '';
    const card = h('div', { class: 'hud-fw-card hud-loot-card fw-in' });
    const ls = lootState();
    if (!ls) {
      card.classList.add('is-ghost');
      card.appendChild(h('div', { class: 'hud-fw-ghost' }, FW_GHOST.lootStatus));
      root.appendChild(card);
      return;
    }
    const row = h('div', { class: 'hud-loot-row' });
    for (const [id, mark, label, tip] of LOOT_CHIPS) {
      const chip = h('div', {
        class: 'hud-loot-chip' + (ls[id] ? ' is-on' : ''),
        'data-loot': id, 'data-lootact': id,
        title: tip + ' — ' + (ls[id] ? 'on' : 'off') + '. Click while placing the HUD to flip it.',
      });
      chip.appendChild(h('i', { class: 'hud-loot-m' }, mark));
      chip.appendChild(h('span', { class: 'hud-loot-t' }, label));
      row.appendChild(chip);
    }
    card.appendChild(row);
    if (wfree.lootStatus.showLabel !== false)
      card.appendChild(h('div', { class: 'hud-fw-name' }, 'Loot'));
    root.appendChild(card);
  }

  /* ---- the season card (2026-08-31) -------------------------------------
     `live.season` is ABSENT whenever nothing can honestly name the season —
     Seasons of Skyrim missing, seasons switched off, or the mod not having
     answered yet (widgets.h's omit-or-tell law). So there is exactly one gate
     here and it is the presence of the object; this view never derives a
     season from the month, for the same reason C++ does not.

     `showLabel` gates the DETAIL lines (the month, the countdown), not the
     season name — the name IS the widget, and a season card that can hide the
     word "Autumn" would just be an empty plate. */
  function seasonData() {
    const s = live.season;
    return (s && typeof s === 'object' && s.id) ? s : null;
  }
  function seasonSig() {
    const s = seasonData();
    if (!s) return ['ghost', editing ? 'e' : '', wcfg.season ? '1' : ''].join('|');
    /* Deliberately WITHOUT s.day and next.in — those move once a game day and
       belong to the volatile pass, so the entrance animation plays on a real
       season or month change and not every midnight. */
    return [s.id, s.name, s.monthName || '', s.src || '', s.fixed ? 'f' : '',
      s.override ? 'o' : '', s.next ? 'n' : '',
      wfree.season.bare ? 'b' : '', wfree.season.showLabel === false ? 'nl' : '',
      editing ? 'e' : ''].join('|');
  }
  function buildSeasonCard() {
    const root = elFree.season;
    root.innerHTML = '';
    const s = seasonData();
    const card = h('div', { class: 'hud-fw-card hud-fw-scard fw-in' });
    if (!s) {
      card.classList.add('is-ghost');
      card.appendChild(h('div', { class: 'hud-fw-ghost' }, FW_GHOST.season));
      root.appendChild(card);
      return;
    }
    /* Per-season accent, CSS only — winter reads cold, autumn warm. The class
       lives on the CARD so `bare` (which strips the plate) keeps the hue on
       the glyph and the name. */
    card.classList.add('is-' + s.id);
    const art = h('div', { class: 'hud-fw-art hud-sn-art', title: s.name });
    art.appendChild(glyphBox('hud-fw-glyph hud-sn-glyph',
      SEASON_ART[s.id] || SEASON_ART.winter, PAINTED.sn[s.id], 44));
    card.appendChild(art);
    card.appendChild(h('div', { class: 'hud-fw-name hud-sn-name', title: s.name }, s.name));
    if (wfree.season.showLabel !== false) {
      /* The month is the honest second line: it is what the season is derived
         FROM under a stock map, and the thing that changes under a faster-
         seasons mod. Day rides it so the countdown below has a reference. */
      const sub = h('div', { class: 'hud-fw-sub hud-sn-sub' });
      sub.appendChild(h('b', { class: 'hud-sn-month' }, s.monthName || ''));
      sub.appendChild(h('i', { class: 'hud-sn-day' }, ''));
      card.appendChild(sub);
      if (s.override)
        card.appendChild(h('div', { class: 'hud-sn-foot is-forced' },
          'Forced' + (s.overrideName ? ' · ' + s.overrideName : '')));
      else if (s.fixed)
        card.appendChild(h('div', { class: 'hud-sn-foot is-forced' }, 'Locked all year'));
      else if (s.next)
        card.appendChild(h('div', { class: 'hud-sn-foot hud-sn-next' }, ''));
    }
    root.appendChild(card);
  }
  /* Whole game days, said the way a person would. */
  function seasonNextText(nx) {
    if (!nx || !nx.name) return '';
    const d = num(nx.in, -1);
    if (d < 0) return nx.name + ' next';
    if (d === 0) return nx.name + ' tomorrow';
    if (d === 1) return nx.name + ' in a day';
    return nx.name + ' in ' + d + ' days';
  }

  function renderFree() {
    for (const k of FREE_KEYS) {
      const root = elFree[k];
      const on = fwGate(k);
      const row = (k === 'quick' || k === 'quick2' || k === 'lootStatus' || k === 'season')
        ? null : k === 'ward' ? wardRow() : freeRow(k);
      const has = k === 'quick' ? quickList().length > 0
        : k === 'quick2' ? q2Rows().length > 0
        : k === 'lootStatus' ? !!lootState()
        : k === 'season' ? !!seasonData()
        : !!(row && row.kind !== 'empty');
      /* ROUND 3: edit mode draws it whether its switch is on or off. An off
         widget used to be display:none, which left nothing to place — see the
         blockWant note above; this is the free layer's half of the same law. */
      const ghosted = editing && !wcfg[k];
      const want = editing || (on && has);
      setClass(root, 'is-off', !want);
      setClass(root, 'is-editoff', ghosted);
      if (!want) { fwSigs[k] = ''; root.innerHTML = ''; continue; }
      if (!(wgrp.locked && grpHas(k)))
        placeFree(root, wfree[k]);
      setClass(root, 'is-bare', !!wfree[k].bare);
      setClass(root, 'is-nolabel', wfree[k].showLabel === false);
      setClass(root, 'is-sel', editing && fwSelected === k);
      /* the mini toolbar lives only on the SELECTED widget */
      if (!(editing && fwSelected === k)) {
        const tools = root.querySelector('.hud-fw-tools');
        if (tools) tools.remove();
      }
      const sig = (k === 'quick' ? quickSig()
        : k === 'quick2' ? quick2Sig()
        : k === 'lootStatus' ? lootSig()
        : k === 'season' ? seasonSig()
        : slotCardSig(k, row)) + (ghosted ? '|editoff' : '');
      if (sig !== fwSigs[k]) {
        fwSigs[k] = sig;
        if (k === 'quick') buildQuick();
        else if (k === 'quick2') buildQuick2();
        else if (k === 'lootStatus') buildLoot();
        else if (k === 'season') buildSeasonCard();
        else buildSlotCard(k, row);
        scheduleIcons();
      }
      /* the background layer — every pass, because a rebuild above just wiped
         it; idempotent when nothing changed (bgMount compares identity) */
      applyCardBg(k);
      /* the toolbar is attached whenever the SELECTED widget lacks it — a
         rebuild clears it, and selection can land without a rebuild */
      if (editing && fwSelected === k && !root.querySelector('.hud-fw-tools'))
        attachFwTools(k);
      /* --- volatile pass: counts and the voice recovery veil ------------- */
      if (k === 'quick') {
        quickList().forEach((q, i) => {
          const art = root.querySelectorAll('.hud-fw-qart')[i];
          if (!art) return;
          const c = art.querySelector('.hud-pin-count');
          if (c && isNum(q.count)) setBump(c, comma(q.count));
        });
      } else if (k === 'quick2') {
        q2Rows().forEach((r, i) => {
          const art = root.querySelectorAll('.hud-fw-qart')[i];
          if (!art) return;
          const c = art.querySelector('.hud-pin-count');
          if (c && !r.missing && isNum(r.count)) setBump(c, comma(r.count));
        });
      } else if (k === 'season') {
        /* Volatile: the day of the month and the countdown. Both move once a
           game day, so they are written in place instead of rebuilding the card
           and replaying its entrance every midnight. */
        const s = seasonData();
        if (s) {
          setText(root.querySelector('.hud-sn-day'), isNum(s.day) ? String(s.day) : '');
          setText(root.querySelector('.hud-sn-next'), seasonNextText(s.next));
        }
      } else if (k === 'lootStatus') {
        /* the two lamps flip with a class, never a rebuild — this is the whole
           reason the sig does not carry the two booleans */
        const ls = lootState();
        if (ls) for (const [id] of LOOT_CHIPS) {
          const chip = root.querySelector('[data-loot="' + id + '"]');
          if (chip) setClass(chip, 'is-on', !!ls[id]);
        }
      } else if (row) {
        const c = root.querySelector('.hud-pin-count');
        if (c && isNum(row.count)) setBump(c, row.count < 0 ? '?' : comma(row.count));
        const d = root.querySelector('.hud-pin-dmg'); if (d && isNum(row.damage)) setBump(d, comma(row.damage));
        const a = root.querySelector('.hud-pin-armor'); if (a && isNum(row.armor)) setBump(a, comma(row.armor));
        if (k === 'voice') {
          /* Party Sheet's rule, kept: gold glow while READY (the is-ready
             class add also fires the one-shot flash), a draining veil while
             recovering. The veil drains via scaleY — a transform repaints
             without a layout pass — and its .95s linear transition smooths
             the gap between the whole-second ticks. */
          setClass(root.querySelector('.hud-fw-card') || root, 'is-ready', !row.cd);
          const veil = root.querySelector('.hud-fw-cd');
          if (veil && row.cd) {
            /* +(…).toFixed(3): serialized the way CSSOM hands it back, so the
               setStyle compare actually gates (the pctWidth trailing-zero
               lesson — "0.500" would re-write the style every tick, forever) */
            setStyle(veil, 'transform', 'scaleY(' + String(+pct(row.cd.rem, row.cd.dur).toFixed(3)) + ')');
            setText(root.querySelector('.hud-fw-cdt'), fmtSecs(row.cd.rem));
          }
        }
      }
    }
    applyGroup();
    upgradeArt();
  }

  /* ---- edit mode: drag / select / nudge / per-widget tools --------------- */
  function saveFree() { saveWidgetCfg(); }

  /* the centre snap guide — a dashed line down the screen's middle, shown
     only while a DRAGGED centre-anchored widget sits snapped on it */
  function fwGuide() {
    let g = document.getElementById('hud-fw-guide');
    if (!g) {
      g = h('div', { id: 'hud-fw-guide' });
      elFree.layer.appendChild(g);
    }
    return g;
  }

  /* The free widgets' half of the ONE drag path — the clamp, the centre snap
     and the placement all live in moveWidgetBy now, so the two families cannot
     drift apart again. */
  function fwScreenDelta(k, dx, dy) {
    moveWidgetBy(elFree[k], wfree[k], dx, dy, { snap: !!fdrag });
  }

  let fdrag = null;   // {k, sx, sy}
  function onFreeDown(e) {
    if (!editing) return;
    const root = e.target && e.target.closest ? e.target.closest('.hud-fw') : null;
    if (!root) return;
    const k = root.getAttribute('data-fw');
    if (!k || !wfree[k]) return;
    /* toolbar buttons act, they never start a drag */
    const btn = e.target.closest ? e.target.closest('[data-fwact]') : null;
    if (btn) { fwToolAct(k, btn.getAttribute('data-fwact')); e.preventDefault(); e.stopPropagation(); return; }
    /* round 4: the custom-quick-items controls and the loot lamp's chips are
       the same idea — a control inside a draggable widget ACTS, it never starts
       a drag. Checked before the selection/drag path for exactly that reason. */
    const qb = e.target.closest ? e.target.closest('[data-q2act]') : null;
    if (qb) { q2Act(qb.getAttribute('data-q2act'), qb); e.preventDefault(); e.stopPropagation(); return; }
    const lb = e.target.closest ? e.target.closest('[data-lootact]') : null;
    if (lb) { lootAct(lb.getAttribute('data-lootact')); e.preventDefault(); e.stopPropagation(); return; }
    if (fwSelected !== k) fwSelected = k;
    renderFree();
    revealInShelf(shelfKeyForFree(k));
    fdrag = { k: k, sx: e.clientX, sy: e.clientY, root: root };
    root.classList.add('is-drag');
    try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault(); e.stopPropagation();
  }
  function onFreeMove(e) {
    if (!fdrag) return;
    fwScreenDelta(fdrag.k, e.clientX - fdrag.sx, e.clientY - fdrag.sy);
    fdrag.sx = e.clientX; fdrag.sy = e.clientY;
    e.preventDefault();
  }
  function onFreeUp() {
    if (!fdrag) return;
    if (fdrag.root) fdrag.root.classList.remove('is-drag');
    fdrag = null;
    fwGuide().classList.remove('show');
    saveFree();
  }
  /* Same pointer+mouse double-wire the assembly uses, same double-fire guard. */
  let sawFreePointer = 0;
  elFree.layer.addEventListener('pointerdown', function (e) { sawFreePointer = Date.now(); onFreeDown(e); });
  elFree.layer.addEventListener('mousedown', function (e) {
    if (Date.now() - sawFreePointer < 500) return;
    e.pointerId = e.pointerId || 1;
    onFreeDown(e);
  });
  window.addEventListener('pointermove', onFreeMove);
  window.addEventListener('pointerup', onFreeUp);
  window.addEventListener('mousemove', onFreeMove);
  window.addEventListener('mouseup', onFreeUp);

  /* The picker is a popout OUTSIDE the free layer, so it needs its own wire —
     same pointer+mouse double-wire and the same double-fire guard, because a
     row added twice would silently do nothing the second time. */
  let sawPickPointer = 0;
  function onPickDown(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-q2act]') : null;
    if (!b) return;
    q2Act(b.getAttribute('data-q2act'), b);
    e.preventDefault(); e.stopPropagation();
  }
  if (el.q2pick) {
    el.q2pick.addEventListener('pointerdown', function (e) { sawPickPointer = Date.now(); onPickDown(e); });
    el.q2pick.addEventListener('mousedown', function (e) {
      if (Date.now() - sawPickPointer < 500) return;
      onPickDown(e);
    });
  }

  /* the mini toolbar on the selected widget — scale, anchor, bare, label, off */
  function attachFwTools(k) {
    if (!editing || fwSelected !== k) return;
    const root = elFree[k];
    if (root.querySelector('.hud-fw-tools')) return;
    const bar = h('div', { class: 'hud-fw-tools' });
    const mk = (act, label, title) =>
      h('button', { class: 'hud-fw-tool', type: 'button', 'data-fwact': act, title: title }, label);
    bar.appendChild(mk('anchor', '⤢', 'Cycle which screen corner or edge it hangs from'));
    bar.appendChild(mk('smaller', '−', 'Smaller'));
    bar.appendChild(mk('bigger', '＋', 'Bigger'));
    bar.appendChild(mk('bare', '◻', 'Bare — drop the plate, keep icon and numbers'));
    bar.appendChild(mk('label', 'Aa', k === 'season' ?
      'Show or hide the month and the countdown' : 'Show or hide the name'));
    bar.appendChild(mk('cfg', '⚙', 'Open the widget shelf on this widget — size, options, linking'));
    bar.appendChild(mk('off', '✕', 'Hide this widget (turn it back on in the ⚙ shelf)'));
    root.appendChild(bar);
    /* A widget dragged to the top edge parked its toolbar entirely above the
       viewport — the assembly's .hud-tools has a below-flip for exactly this;
       the mini bar now gets the same one (Opus audit). */
    if (root.getBoundingClientRect().top < 44) bar.classList.add('below');
  }
  const FW_ANCHOR_CYCLE = [
    ['left', 'top'], ['center', 'top'], ['right', 'top'],
    ['right', 'bottom'], ['center', 'bottom'], ['left', 'bottom'],
  ];
  function fwToolAct(k, act) {
    const w = wfree[k];
    /* the shelf, opened straight onto this widget's row (2026-08-19) */
    if (act === 'cfg') { setCfgOpen(true, k); return; }
    if (act === 'smaller' || act === 'bigger') {
      w.scale = clamp(num(w.scale, 1) + (act === 'bigger' ? 0.1 : -0.1), 0.5, 2.5);
      placeFree(elFree[k], w);
    } else if (act === 'bare') {
      w.bare = !w.bare; fwSigs[k] = ''; renderFree();
    } else if (act === 'label') {
      w.showLabel = w.showLabel === false; fwSigs[k] = ''; renderFree();
    } else if (act === 'off') {
      wcfg[k] = false; fwSelected = ''; renderFree(); if (cfgOpen) buildSettings();
    } else if (act === 'anchor') {
      /* rotate through the six anchors, PRESERVING the on-screen spot — the
         assembly's cycleAnchor discipline, extended with the center column */
      const r = elFree[k].getBoundingClientRect();
      const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
      let i = 0;
      for (let n = 0; n < FW_ANCHOR_CYCLE.length; n++)
        if (FW_ANCHOR_CYCLE[n][0] === w.anchorH && FW_ANCHOR_CYCLE[n][1] === w.anchorV) { i = n; break; }
      const nxt = FW_ANCHOR_CYCLE[(i + 1) % FW_ANCHOR_CYCLE.length];
      w.anchorH = nxt[0]; w.anchorV = nxt[1];
      const cx = r.left + r.width / 2;
      w.x = w.anchorH === 'right' ? Math.max(0, Math.round(vw - r.right)) :
            w.anchorH === 'center' ? Math.round(cx - vw / 2) :
            Math.max(0, Math.round(r.left));
      w.y = w.anchorV === 'bottom' ? Math.max(0, Math.round(vh - r.bottom)) : Math.max(0, Math.round(r.top));
      placeFree(elFree[k], w);
    }
    saveFree();
  }

  /* ======================================================================
     ROUND 4 — one-line toast, the item picker, and the key capture.
     All three are popouts that live OUTSIDE #hud (its transform would become
     their containing block) and are only ever reachable in edit mode, where
     this view actually holds the mouse and the keyboard.
     ====================================================================== */
  let toastT = 0;
  function toast(msg, bad) {
    const t = el.toast;
    if (!t || !msg) return;
    t.textContent = String(msg);
    t.className = 'hud-toast is-up' + (bad ? ' is-bad' : '');
    clearTimeout(toastT);
    /* one-shot: a class removal after a timeout, never a looping animation */
    toastT = setTimeout(function () { t.className = 'hud-toast'; }, 2600);
  }

  /* Browser keydown gives a VK/name; the C++ sink matches DIK scancodes. The
     hotbar solved this already — `e.code` maps cleanly and is layout
     independent, and an unmapped key is REFUSED out loud rather than stored as
     a bind that could never match. Same table, deliberately. */
  const DIK = {
    Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
    Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0A, Digit0: 0x0B,
    Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F,
    KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
    KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
    BracketLeft: 0x1A, BracketRight: 0x1B, Enter: 0x1C, ControlLeft: 0x1D,
    KeyA: 0x1E, KeyS: 0x1F, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
    KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
    ShiftLeft: 0x2A, Backslash: 0x2B,
    KeyZ: 0x2C, KeyX: 0x2D, KeyC: 0x2E, KeyV: 0x2F, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
    Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
    NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3A,
    F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40,
    F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4A,
    Numpad4: 0x4B, Numpad5: 0x4C, Numpad6: 0x4D, NumpadAdd: 0x4E,
    Numpad1: 0x4F, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
    F11: 0x57, F12: 0x58,
    NumpadEnter: 0x9C, ControlRight: 0x9D, NumpadDivide: 0xB5, AltRight: 0xB8,
    Home: 0xC7, ArrowUp: 0xC8, PageUp: 0xC9, ArrowLeft: 0xCB, ArrowRight: 0xCD,
    End: 0xCF, ArrowDown: 0xD0, PageDown: 0xD1, Insert: 0xD2, Delete: 0xD3,
  };
  function prettyKey(code) {
    const c = String(code || '');
    if (c.indexOf('Digit') === 0) return c.slice(5);
    if (c.indexOf('Key') === 0) return c.slice(3);
    if (c.indexOf('Numpad') === 0) return 'Num ' + c.slice(6);
    return c;
  }

  const q2cap = { on: false, i: -1 };
  function startQ2Capture(i) {
    q2cap.on = true; q2cap.i = i;
    fwSigs.quick2 = '';           // the chip says "Press a key…"
    renderFree();
  }
  function endQ2Capture() {
    if (!q2cap.on) return;
    q2cap.on = false; q2cap.i = -1;
    fwSigs.quick2 = '';
    renderFree();
  }
  /* Returns true when the keypress was CONSUMED by the capture. */
  function q2CaptureKey(e) {
    if (!q2cap.on) return false;
    const it = q2.items[q2cap.i];
    if (!it) { endQ2Capture(); return true; }
    if (e.code === 'Escape' || e.key === 'Escape') { endQ2Capture(); return true; }
    /* Backspace clears the bind — the one key a picker must not swallow as a
       bind, because it is also the only obvious "un-bind me" gesture. */
    if (e.code === 'Backspace' || e.key === 'Backspace') {
      delete it.keyDevice; delete it.keyCode; delete it.keyLabel;
      endQ2Capture(); saveQ2();
      toast('Key cleared');
      return true;
    }
    const dik = DIK[e.code];
    if (!dik) { toast('That key can’t be used — try another', true); return true; }
    it.keyDevice = 'keyboard';
    it.keyCode = dik;
    it.keyLabel = prettyKey(e.code);
    endQ2Capture(); saveQ2();
    toast(it.keyLabel + ' → ' + (it.name || 'item') + ' · it still does its normal job too');
    return true;
  }

  /* ---- the Add Items picker -------------------------------------------- */
  const q2pick = { open: false, q: '', rows: [], capped: false, asked: false, sel: 0 };
  function q2PickRows() {
    const needle = q2pick.q.trim().toLowerCase();
    const out = [];
    for (const r of q2pick.rows) {
      if (needle && String(r.name || '').toLowerCase().indexOf(needle) === -1) continue;
      out.push(r);
      if (out.length >= 200) break;
    }
    return out;
  }
  function openQ2Pick() {
    q2pick.open = true; q2pick.sel = 0;
    /* ⚠ ONE request per OPEN, never per keystroke: the catalogue is a whole
       inventory walk on the main thread, and the Items tab already paid for
       that lesson (2026-08-13). Filtering happens here, on rows we hold. */
    if (!q2pick.asked) {
      q2pick.asked = true;
      toGameAny(['wgQuick2Catalog'], '');
    }
    buildQ2Pick();
  }
  function closeQ2Pick() {
    q2pick.open = false;
    /* asked stays true for the session — reopening reuses the rows we already
       hold, and ⟳ is what asks again. */
    buildQ2Pick();
  }
  function buildQ2Pick() {
    const root = el.q2pick;
    if (!root) return;
    root.className = 'hud-q2pick' + (q2pick.open ? ' is-open' : '');
    if (!q2pick.open) { root.innerHTML = ''; return; }
    root.innerHTML = '';
    const back = h('div', { class: 'hud-q2pick-back', 'data-q2act': 'pickclose' });
    const card = h('div', { class: 'hud-q2pick-card' });
    const head = h('div', { class: 'hud-q2pick-head' });
    head.appendChild(h('span', { class: 'hud-q2pick-title' }, 'Add a quick item'));
    head.appendChild(h('button', { class: 'hud-q2-btn', type: 'button', 'data-q2act': 'refresh',
      title: 'Ask the game for a fresh list of what you are carrying' }, '⟳'));
    head.appendChild(h('button', { class: 'hud-q2-btn', type: 'button', 'data-q2act': 'pickclose',
      title: 'Close' }, '✕'));
    card.appendChild(head);
    const inp = h('input', { class: 'hud-q2pick-inp', type: 'text', id: 'hud-q2pick-inp',
      placeholder: 'Type to filter — Enter adds the top hit', value: q2pick.q,
      autocomplete: 'off', spellcheck: false });
    card.appendChild(inp);
    const list = h('div', { class: 'hud-q2pick-list' });
    const rows = q2PickRows();
    if (!q2pick.rows.length) {
      list.appendChild(h('div', { class: 'hud-q2pick-empty' },
        'Reading what you are carrying…'));
    } else if (!rows.length) {
      list.appendChild(h('div', { class: 'hud-q2pick-empty' },
        'Nothing you are carrying matches “' + q2pick.q + '”.'));
    } else {
      rows.forEach(function (r, i) {
        const owned = q2.items.some((it) =>
          String(it.plugin || '').toLowerCase() === String(r.plugin || '').toLowerCase() &&
          canonHex8(it.formId) === canonHex8(r.formId));
        const b = h('button', {
          class: 'hud-q2pick-row' + (i === q2pick.sel ? ' is-sel' : '') + (owned ? ' is-owned' : ''),
          type: 'button', 'data-q2act': 'pickadd', 'data-q2row': String(i),
          title: owned ? (r.name + ' is already on the widget') : ('Add ' + r.name),
        });
        b.appendChild(h('span', { class: 'hud-q2pick-nm' }, String(r.name || '—')));
        b.appendChild(h('span', { class: 'hud-q2pick-kd' }, String(r.kind || '')));
        b.appendChild(h('span', { class: 'hud-q2pick-n' }, isNum(r.count) ? '×' + comma(r.count) : ''));
        list.appendChild(b);
      });
    }
    card.appendChild(list);
    const foot = h('div', { class: 'hud-q2pick-foot' },
      q2pick.capped ? 'Showing the first 400 carried items — filter to reach the rest.'
                    : (q2.items.length + ' of ' + Q2_MAX_ITEMS + ' slots used'));
    card.appendChild(foot);
    root.appendChild(back);
    root.appendChild(card);
    /* live filter — the deck's law: filter-as-you-type, Enter takes the top hit */
    inp.addEventListener('input', function () {
      q2pick.q = inp.value; q2pick.sel = 0;
      buildQ2Pick();
      const again = document.getElementById('hud-q2pick-inp');
      if (again) { try { again.focus(); } catch (x) {} }
    });
    try { inp.focus(); } catch (x) {}
  }
  function q2AddRow(r) {
    if (!r || !r.plugin || !r.formId) return;
    const dupe = q2.items.some((it) =>
      String(it.plugin || '').toLowerCase() === String(r.plugin || '').toLowerCase() &&
      canonHex8(it.formId) === canonHex8(r.formId));
    if (dupe) { toast(String(r.name || 'That item') + ' is already here'); return; }
    if (q2.items.length >= Q2_MAX_ITEMS) { toast('That is all ' + Q2_MAX_ITEMS + ' slots — remove one first', true); return; }
    q2.items.push({ plugin: String(r.plugin), formId: String(r.formId), name: String(r.name || '') });
    /* An item you just added must be VISIBLE — raise the drawn count with it,
       up to the cap. Lowering Rows later still only hides. */
    if (q2.items.length > q2.max) q2.max = clamp(q2.items.length, 1, Q2_MAX_ITEMS);
    saveQ2();
    toast('Added ' + (r.name || 'item'));
  }
  function saveQ2() {
    q2.dirty = true;
    fwSigs.quick2 = '';
    renderFree();
    saveWidgetCfg();
    if (q2pick.open) buildQ2Pick();
  }

  /* ---- edit-mode actions on the two round-4 widgets --------------------- */
  function q2Act(act, node) {
    if (act === 'add') { openQ2Pick(); return; }
    if (act === 'pickclose') { closeQ2Pick(); return; }
    if (act === 'refresh') { q2pick.rows = []; q2pick.asked = true; toGameAny(['wgQuick2Catalog'], ''); buildQ2Pick(); return; }
    if (act === 'pickadd') {
      const i = parseInt(node.getAttribute('data-q2row'), 10);
      const rows = q2PickRows();
      if (rows[i]) q2AddRow(rows[i]);
      return;
    }
    if (act === 'less' || act === 'more') {
      q2.max = clamp(q2.max + (act === 'more' ? 1 : -1), 1, Q2_MAX_ITEMS);
      saveQ2();
      return;
    }
    const tile = node.closest ? node.closest('[data-q2i]') : null;
    const idx = tile ? parseInt(tile.getAttribute('data-q2i'), 10) : -1;
    const rows = q2Rows();
    const r = rows[idx];
    if (!r) return;
    if ((act === 'rm' || act === 'key') && !r.it) {
      toast('Still reading that item’s settings — try again in a moment', true);
      return;
    }
    if (act === 'rm') {
      const at = q2.items.indexOf(r.it);
      if (at !== -1) q2.items.splice(at, 1);
      if (q2cap.on) endQ2Capture();
      saveQ2();
      toast('Removed ' + r.name);
      return;
    }
    if (act === 'key') { startQ2Capture(idx); return; }
    if (act === 'use') {
      if (r.missing) { toast(r.name + ' — that mod is switched off', true); return; }
      toGameAny(['wgQuick2Use'], JSON.stringify({ plugin: String(r.plugin || ''), formId: String(r.formId || '') }));
    }
  }
  function lootAct(which) {
    toGameAny(['wgLootToggle'], JSON.stringify({ which: which }));
  }

  /* ⛔ ONE capture-phase keydown, ahead of everything else, for the three
     round-4 keyboard owners: a bind being captured, the open item picker, and
     browse mode. It STOPS a key it consumed — an arrow that stepped a browse
     and then nudged a widget, or an Esc that closed the picker and also tore
     down edit mode, are both bugs, and the bubble-phase listener below is
     exactly what would do it. Capture runs first; stopPropagation ends it. */
  window.addEventListener('keydown', function (e) {
    if (q2cap.on && q2CaptureKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (q2pick.open) {
      const c = e.code || '', k = e.key || '';
      if (c === 'Escape' || k === 'Escape') { closeQ2Pick(); e.preventDefault(); e.stopPropagation(); return; }
      if (c === 'Enter' || c === 'NumpadEnter' || k === 'Enter') {
        /* the deck's law: Enter takes the top hit (or whichever row the arrows
           walked to) and the picker STAYS open, so a run of adds is one flow */
        const rows = q2PickRows();
        if (rows[q2pick.sel]) q2AddRow(rows[q2pick.sel]);
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (c === 'ArrowDown' || c === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowUp') {
        const rows = q2PickRows();
        if (rows.length) {
          const d = (c === 'ArrowUp' || k === 'ArrowUp') ? -1 : 1;
          q2pick.sel = ((q2pick.sel + d) % rows.length + rows.length) % rows.length;
          buildQ2Pick();
        }
        e.preventDefault(); e.stopPropagation(); return;
      }
      return;                       // every other key is TYPING — let it land
    }
    if (onNavKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* arrow-key nudge for the SELECTED free widget — the deck idiom: 1 px,
     10 with Shift. Only in edit mode, never from inside a form control. */
  window.addEventListener('keydown', function (e) {
    /* Esc ALWAYS leaves edit mode — the guaranteed exit that does not depend
       on any button being visible (the 2026-08-18 lock-in: the Done button
       was painted under the scaled panel and there was no other way out).
       One key, one meaning: out — selection and settings card included. */
    if ((e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) && editing) {
      /* THE RESCUE KEY RELEASES FOCUS FIRST. hudEditDone used to be the last
         statement — one exception anywhere in the exit render and C++ never
         heard, focus never dropped, and Esc LOOKED dead while doing nothing
         (Opus audit, 2026-08-18). The bridge call now leads, and the teardown
         runs under try/finally so a render throw can no longer strand focus.
         The key hedge (code/keyCode) is hd-door.js's belt, earned there. */
      toGame('hudEditDone');
      try {
        saveFree();          // a mid-drag reposition must not silently revert
        setCfgOpen(false);
        setEditing(false);   // also clears drag / fdrag / fwSelected
        saveCfg();
      } catch (err) {
        try { toGame('hudLog', 'esc-exit render threw: ' + err.message); } catch (e2) {}
        el.body.classList.remove('hud-editing');   // minimal visual teardown
        editing = false;
      }
      e.preventDefault();
      return;
    }
    if (!editing || !fwSelected || !wcfg[fwSelected]) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;
    fwScreenDelta(fwSelected, dx, dy);
    saveFree();
    e.preventDefault();
  });

  /* debug / harness surface */
  window.__hud.wfree = wfree;
  window.__hud.renderFree = renderFree;
  window.__hud.spellArt = spellArt;
  window.__hud.fwAccent = fwAccent;
  window.__hud.freeRow = freeRow;
  window.__hud.FREE_KEYS = FREE_KEYS;
  window.__hud.seasonData = seasonData;
  window.__hud.seasonNextText = seasonNextText;
  window.__hud.SEASON_ART = SEASON_ART;
  window.__hud.SICON = SICON;
  window.__hud.selectFree = function (k) { fwSelected = k; renderFree(); };
  /* round 4 surface — the harness drives the picker, the bind capture and the
     browse card through the same functions the mouse and keyboard do. */
  window.__hud.q2 = q2;
  window.__hud.q2Rows = q2Rows;
  window.__hud.q2Pick = q2pick;
  window.__hud.openQ2Pick = openQ2Pick;
  window.__hud.closeQ2Pick = closeQ2Pick;
  window.__hud.q2Cap = q2cap;
  window.__hud.nav = nav;
  window.__hud.buildNavCard = buildNavCard;
  window.__hud.DIK = DIK;
  window.__hud.toast = toast;

  /* Guarded init: an uncaught throw at view load is the 0xC0000005 class that
     wedges the SHARED Ultralight renderer for every view (the Nexus freeze
     mechanism) — a HUD that boots blank and says why beats one that takes the
     deck down with it. hudReady still fires so C++ never waits forever. */
  try {
    applyConfig();
    render();
  } catch (err) {
    try { toGame('hudLog', 'hud init threw: ' + (err && err.message)); } catch (e2) {}
  }
  /* ⚠ THE HANDSHAKE MUST NOT BE SILENTLY SWALLOWED (2026-08-18).
     `toGame` is deliberately forgiving — an unregistered callback is a no-op —
     which is right for every other call and WRONG for this one. `hudReady` is
     the single "push me my config and my icon maps" ping, and the view can
     finish parsing before PrismaUI has registered the C++ callback: the ping
     then lands on `undefined`, nothing is pushed, and the HUD comes up with no
     icon index at all, for ever, with nothing in the log to say why.
     So fire it only once the callback IS a function, retrying every 50ms for
     ~2s. On a rig where it was already registered this is the same single
     call it always was. */
  (function pingReady(n) {
    if (typeof window.hudReady === 'function') { toGame('hudReady'); return; }
    if (n > 0) setTimeout(function () { pingReady(n - 1); }, 50);
    else if (DEV) console.log('[hud->game] hudReady never registered');
  })(40);
})();
