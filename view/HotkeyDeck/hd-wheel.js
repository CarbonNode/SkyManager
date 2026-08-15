'use strict';

/* ====================================================================== *
 *  Wheel Menu (v0.16.0) — a radial palette, Ctrl+F7.
 *
 *  Rober's ask (2026-08-11): "a really highly polished wheel menu built in
 *  too… another new thing you can favorite anything to. doesn't share the
 *  same favorites but anything can be bound to it. even like what would
 *  happen if you hit F7 on a party member (and shows their face in
 *  preview). Also allowed — weapons, armor, individual usables, wardrobe
 *  outfits. and uses the mesh system that shows actual visuals of the items
 *  you add… be able to resize the wheel, add or remove as many as you want
 *  and tabs (circles bottom right that act as ticks for what wheel you are
 *  on, left/right arrow to cycle between different wheels)."
 *
 *  ---- "anything" is the Omni provider registry, again -----------------
 *  Exactly like the Favorites Shelf, the wheel knows nothing about spells,
 *  followers or domains: it stores OMNI PINS ({prov,key,label,detail,kind,
 *  snap,icon}) and re-resolves them against each provider's LIVE index() at
 *  click time. So every pane that registers a provider is wheel-able the
 *  day it lands, with no edit here — and the two systems stay INDEPENDENT
 *  because they keep separate storage slices. Pinning to the shelf does not
 *  touch a wheel, and vice versa; that separation is the ask, not a detail.
 *
 *  The four item classes Rober named needed one NEW provider, registered at
 *  the bottom of this file: `inventory` — the player's own weapons, armour,
 *  usables and misc, read live from C++ (`whInv`). It is registered with
 *  HDOmni rather than kept private, so Ctrl+F finds your gear too.
 *
 *  ---- activation: live truth first, snapshot second, honesty third -----
 *  Same three-step contract as the shelf (see hd-shelf.js), because a pin
 *  that silently does nothing is the failure mode that matters:
 *    1. live item found → run() it;
 *    2. else the provider's pinRun(snap, item) (a follower opens her card,
 *       a quest opens its detail);
 *    3. else the wedge greys with the reason and the click SAYS why.
 *
 *  ---- pictures: the mesh system ---------------------------------------
 *  An inventory pin carries no baked art. Its picture is the GAME's own
 *  render of the item's ground model — Mesh Rendering Framework, driven by
 *  src/item_icons.cpp, the same index the Wardrobe rows and the F7 card's
 *  gear tiles draw from. We ask for renders (`whIcons`) only for the items
 *  actually ON a wheel, resolve them through WardrobePane.itemIconFor (one
 *  implementation, one key normalisation), and repaint when a batch lands.
 *  Missing framework = the glyph, which is a supported setup, not an error.
 *
 *  ---- why no SVG -------------------------------------------------------
 *  Every ring, spoke and tile is a plain positioned div moved with
 *  translate/rotate. Ultralight's SVG and clip-path support is not
 *  something to bet a whole menu on, and a half-drawn wheel is worse than
 *  none. Selection is by CURSOR ANGLE about the hub — which also means you
 *  never have to hit a small target: pointing in a direction is enough.
 * ====================================================================== */

var HDWheel = (function () {
  var DEV = location.search.indexOf('dev=1') !== -1;

  var MAX_WHEELS = 12;
  var MAX_SLOTS = 16;         // per wheel; more than this and nothing is findable
  var MIN_SLOTS = 2;
  var DEFAULT_SLOTS = 8;
  /* Flyout bundles (Rober, 2026-08-13: "a wheel section could be set to be a
     flyout — pops out with a quantifiable amount (3-9?) bundle"). One wedge
     holds up to 9 ordinary pins; firing the wedge fans them out around it and
     the click (or 1-9) picks one. Children are plain pins — a flyout can never
     hold another flyout, because a two-deep radial fan is a maze, not a menu. */
  var MAX_FLY = 9;
  /* 0.5, not 0.6: the "Corner, minimal" preset asks for 0.55, and a floor above
     it would have slice() clamp the value the preset just wrote — leaving the
     dropdown reading "Custom" immediately after you picked something. Matches
     metrics()'s own effective-scale floor. */
  var SIZE_MIN = 0.5, SIZE_MAX = 1.6, SIZE_STEP = 0.05;
  var DEAD_ZONE = 0.42;       // fraction of the ring radius that selects nothing

  var env = null;             // { state, saveSoon, setTab, toGame, closeDeck }
  var root = null;

  var ui = {
    open: false,
    standalone: false,        // opened by Ctrl+F7 (closing it closes the deck)
    sel: -1,                  // selected slot index, -1 = none (cursor in the hub)
    edit: false,
    sheet: null,              // 'pick' | 'settings' | null
    pickSlot: -1,             // slot the picker is filling (-1 = first free)
    pickQ: '',
    pickCat: 'all',
    pickSel: 0,
    menu: null,               // { slot, x, y, armed }
    fly: null,                // { slot } — an open flyout fan over the ring
    flyArm: false,            // the flyedit sheet's armed "remove all" state
    rename: null,             // 'wheel' — inline rename target in the settings sheet
    radius: 260,              // computed, post-scale
    center: null,             // { x, y } — where the ring actually sits (anchor)
    presetOpen: false,        // the preset list inside the ⚙ settings sheet
    lookOpen: false,          // the Look dropdown on the wheel's own top bar
    capKey: null,             // action id waiting for its new key ("press a key…")
    capMsg: '',               // what the last rebind attempt did, in words
  };

  /* ------------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m) { if (typeof window.toast === 'function') window.toast(m); }
  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[wheel dev->game]', fn, arg);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function newId() {
    return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 4096).toString(36);
  }

  /* View-relative image paths only — the same rule as C++'s ValidViewIconPath
     and the shelf's safeIcon: a hand-edited absolute path renders nothing
     rather than reaching outside the view folder. */
  function safeIcon(p) {
    p = String(p || '');
    if (!p) return '';
    if (p.indexOf('..') !== -1 || p[0] === '/' || p.indexOf(':') !== -1) return '';
    return p;
  }

  /* ------------------------------------------------- keys inside the wheel */
  /* Rober, 2026-08-11: "need to be able to rebind V." Right — and V was never
     special, so all four of the wheel's letter shortcuts became bindable in
     one go rather than leaving him to come back for E, F and S.
   *
   * NOT rebindable, deliberately: Esc (the universal way out — a menu whose
   * escape key can be reassigned is a menu you can get trapped in), 1-9 (they
   * ARE the slot numbers), and the arrows (they are the tick strip). Those are
   * structure, not preference, and the settings sheet says so out loud rather
   * than leaving you hunting for the row.
   *
   * A binding is one printable key, stored lowercase; '' means the shortcut is
   * off, which is a legitimate choice and not a broken state — the button on
   * the bar still does the job. */
  var KEYSPEC = [
    { id: 'look', def: 'v', label: 'Look — next preset',
      note: 'Steps through the visual presets. The ◱ button on the bar opens the full list.' },
    { id: 'add', def: 'f', label: 'Add something',
      note: 'Opens the search panel to put something in a slot.' },
    { id: 'edit', def: 'e', label: 'Edit mode',
      note: 'Shows the empty slots so you can fill and rearrange them.' },
    { id: 'settings', def: 's', label: 'Settings',
      note: 'Size, slots, wheels and these key bindings.' },
  ];
  /* Keys the wheel already owns for something structural. Refusing them at
     BIND time (with the reason) beats accepting a binding that then never
     fires because something earlier in onKey swallowed it. */
  var RESERVED = {
    escape: 'Esc always closes — that one cannot move',
    enter: 'Enter is the picker’s "take the top hit"',
    tab: 'Tab switches the picker’s categories',
    arrowleft: 'the arrows cycle wheels', arrowright: 'the arrows cycle wheels',
    arrowup: 'the arrows move the picker’s selection', arrowdown: 'the arrows move the picker’s selection',
    delete: 'Delete clears the slot you are pointing at',
    backspace: 'Backspace clears the slot you are pointing at',
  };
  function keyOf(id) {
    var w = slice();
    var k = w && w.keys ? w.keys[id] : undefined;
    if (k === '') return '';                       // deliberately turned off
    if (typeof k === 'string' && k) return k;
    var s = specOf(id);
    return s ? s.def : '';
  }
  function specOf(id) {
    for (var i = 0; i < KEYSPEC.length; i++) if (KEYSPEC[i].id === id) return KEYSPEC[i];
    return null;
  }
  /* The action a pressed key means, or ''. Compared lowercase so a binding
     made with caps lock on still fires. */
  function actionForKey(k) {
    var low = String(k || '').toLowerCase();
    if (!low) return '';
    for (var i = 0; i < KEYSPEC.length; i++) {
      var bound = keyOf(KEYSPEC[i].id);
      if (bound && bound === low) return KEYSPEC[i].id;
    }
    return '';
  }
  function keyLabel(k) {
    if (!k) return 'off';
    if (k === ' ') return 'Space';
    return k.length === 1 ? k.toUpperCase() : k;
  }
  /* Returns '' on success, or the reason it was refused. */
  function bindKey(id, raw) {
    var w = slice();
    if (!w) return 'no config';
    var low = String(raw || '').toLowerCase();
    if (RESERVED[low]) return keyLabel(raw) + ' is taken — ' + RESERVED[low];
    if (low >= '0' && low <= '9' && low.length === 1)
      return 'The number keys fire slots 1–9';
    if (low.length !== 1 && !/^f\d{1,2}$/.test(low))
      return 'Press a single letter, number-pad key or F-key';
    for (var i = 0; i < KEYSPEC.length; i++) {
      if (KEYSPEC[i].id !== id && keyOf(KEYSPEC[i].id) === low)
        return keyLabel(raw) + ' is already ' + KEYSPEC[i].label;
    }
    if (!w.keys || typeof w.keys !== 'object') w.keys = {};
    w.keys[id] = low;
    save();
    return '';
  }

  /* ------------------------------------------------------------ presets */
  /* Rober, 2026-08-11: "a visual preset where it sits kinda middle bottom
     right and doesn't obscure screen as much would be cool, thinking a visual
     preset dropdown system you can pick from."

     A preset is a BUNDLE of the three things that decide how much screen the
     wheel takes: where it sits, how big it is, and how hard it dims the game
     behind it. One pick, not three sliders — but the three knobs stay
     individually adjustable underneath, and touching one flips the preset to
     "Custom" rather than silently disagreeing with its own label.

     `anchor` is a corner/edge token, not coordinates: the actual centre is
     computed against the live viewport in stageAt(), so a preset chosen on the
     desktop preview still fits on a stream at another size. */
  var ANCHORS = { c: 1, bc: 1, br: 1, bl: 1, tr: 1, tl: 1 };
  var DIMS = { full: 1, light: 1, none: 1 };
  var ANCHOR_NAME = {
    c: 'Centre of the screen', bc: 'Bottom centre', br: 'Bottom right',
    bl: 'Bottom left', tr: 'Top right', tl: 'Top left',
  };
  var DIM_NAME = {
    full: 'Dim the whole screen behind the wheel — easiest to read',
    light: 'Only a little — you can still see the fight',
    none: 'Nothing dimmed at all; the wheel keeps its own dark pool',
  };

  var PRESETS = [
    { id: 'center', label: 'Centred', anchor: 'c', size: 1.0, dim: 'full',
      note: 'The full ring, dead centre, game dimmed behind it. Easiest to read.' },
    { id: 'center-light', label: 'Centred, see-through', anchor: 'c', size: 0.9, dim: 'light',
      note: 'Same place, a little smaller, and you can still see the fight behind it.' },
    { id: 'br', label: 'Bottom right', anchor: 'br', size: 0.7, dim: 'light',
      note: 'Tucked into the corner by your health bar. Leaves the middle of the screen alone.' },
    { id: 'bl', label: 'Bottom left', anchor: 'bl', size: 0.7, dim: 'light',
      note: 'The same, on the other side.' },
    { id: 'bc', label: 'Bottom centre', anchor: 'bc', size: 0.75, dim: 'light',
      note: 'Low and central — under the crosshair rather than over it.' },
    { id: 'mini', label: 'Corner, minimal', anchor: 'br', size: 0.55, dim: 'none',
      note: 'Small, bottom right, nothing dimmed at all. The least in the way.' },
  ];
  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }
  /* Which preset the current knobs ARE, or 'custom'. Derived rather than
     trusted, so a hand-edited hotkeys.json (or a knob nudged by an older
     build) cannot leave the dropdown claiming something untrue. */
  function currentPreset(w) {
    for (var i = 0; i < PRESETS.length; i++) {
      var p = PRESETS[i];
      if (p.anchor === w.anchor && Math.abs(p.size - w.size) < 0.001 && p.dim === w.dim)
        return p.id;
    }
    return 'custom';
  }
  function applyPreset(id) {
    var p = presetById(id);
    var w = slice();
    if (!p || !w) return;
    w.anchor = p.anchor;
    w.size = p.size;
    w.dim = p.dim;
    save();
    render();
    toast('Wheel: ' + p.label);
  }

  /* ------------------------------------------------------------- storage */
  /* state.wheel = { size, active, wheels:[ {id,name,slots:[pin|null]} ] }
     Normalised IN PLACE (never replaced) for the same reason as the shelf:
     app.js may already hold the object reference. C++ carries the slice as a
     raw json blob, so a key written by a newer view survives an older DLL. */
  function slice() {
    var st = env && env.state;
    if (!st) return null;
    if (!st.wheel || typeof st.wheel !== 'object' || Array.isArray(st.wheel)) st.wheel = {};
    var w = st.wheel;
    w.size = clamp(typeof w.size === 'number' && isFinite(w.size) ? w.size : 1, SIZE_MIN, SIZE_MAX);
    /* Placement + dim (v0.16.1). Absent = the old behaviour exactly, so a
       config written before presets existed opens where it always did. */
    if (!ANCHORS[w.anchor]) w.anchor = 'c';
    if (!DIMS[w.dim]) w.dim = 'full';
    /* How the open key behaves (v0.17). 'toggle' = the old press-open,
       press-close. 'hold' = hold the key, point, RELEASE fires — the classic
       console radial rhythm. Absent = toggle, so old configs are unchanged. */
    if (w.openStyle !== 'hold') w.openStyle = 'toggle';
    /* Key bindings. Absent = the defaults; a key present but empty means the
       shortcut was deliberately turned OFF and must stay off, which is why
       this normalises rather than filling blanks in. */
    if (!w.keys || typeof w.keys !== 'object' || Array.isArray(w.keys)) w.keys = {};
    Object.keys(w.keys).forEach(function (id) {
      var v = w.keys[id];
      if (typeof v !== 'string') { delete w.keys[id]; return; }
      w.keys[id] = v.toLowerCase().slice(0, 4);
    });
    if (!Array.isArray(w.wheels)) w.wheels = [];
    w.wheels = w.wheels.filter(function (x) { return x && typeof x === 'object'; }).slice(0, MAX_WHEELS);
    w.wheels.forEach(function (x, i) {
      x.id = String(x.id || '') || ('w' + i);
      x.name = String(x.name || '') || ('Wheel ' + (i + 1));
      if (!Array.isArray(x.slots)) x.slots = [];
      /* Length is authoritative and clamped: a hand-edited 400 would place 400
         tiles on a circle none of which could be told apart. */
      var n = clamp(x.slots.length || DEFAULT_SLOTS, MIN_SLOTS, MAX_SLOTS);
      x.slots.length = n;
      for (var k = 0; k < n; k++) x.slots[k] = normPin(x.slots[k]);
    });
    if (!w.wheels.length) w.wheels.push(freshWheel('Wheel 1'));
    w.active = clamp(typeof w.active === 'number' ? w.active | 0 : 0, 0, w.wheels.length - 1);
    return w;
  }

  function normPin(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    /* A flyout bundle: `fly` is an array of ordinary pins. Normalised FIRST,
       because its prov is the sentinel '_fly' and no provider will ever index
       it — the bundle's identity is its own, not a resolvable pin's. Children
       go through normPin themselves; a child that is itself a flyout is
       dropped rather than nested (one level, by design). */
    if (Array.isArray(p.fly)) {
      var kids = [];
      for (var fi = 0; fi < p.fly.length && kids.length < MAX_FLY; fi++) {
        var fc = p.fly[fi];
        if (!fc || Array.isArray(fc.fly)) continue;
        fc = normPin(fc);
        if (fc) kids.push(fc);
      }
      return {
        prov: '_fly',
        key: (typeof p.key === 'string' && p.key) ? p.key : newId(),
        label: String(p.label || ''),
        detail: '',
        kind: 'flyout',
        alias: String(p.alias || ''),
        icon: safeIcon(p.icon),
        mode: '',
        snap: null,
        fly: kids,
      };
    }
    if (typeof p.prov !== 'string' || !p.prov || typeof p.key !== 'string' || !p.key) return null;
    return {
      prov: p.prov, key: p.key,
      label: String(p.label || ''),
      detail: String(p.detail || ''),
      kind: String(p.kind || ''),
      alias: String(p.alias || ''),
      icon: safeIcon(p.icon),
      /* Spell wedges only: '' = cast (the default), otherwise the hand to
         equip into. Stored on the PIN rather than derived, because "this
         wedge equips into my left hand" is a property of the wedge, not of
         the spell — the same spell can sit on two wedges as cast and equip. */
      mode: SPELL_MODES[p.mode] ? p.mode : '',
      snap: (p.snap && typeof p.snap === 'object') ? p.snap : null,
    };
  }

  /* label + the verb, in the words the hub and the menu both use */
  var SPELL_MODES = {
    left: { label: 'Equip — left hand', verb: 'equip left', hand: 'left' },
    right: { label: 'Equip — right hand', verb: 'equip right', hand: 'right' },
    both: { label: 'Equip — both hands', verb: 'equip in both', hand: 'both' },
  };
  function modeOf(p) { return (p && SPELL_MODES[p.mode]) ? p.mode : ''; }
  function castable(p) { return p && (p.prov === 'spells'); }
  function isFly(p) { return !!(p && Array.isArray(p.fly)); }

  function freshWheel(name) {
    var slots = [];
    for (var i = 0; i < DEFAULT_SLOTS; i++) slots.push(null);
    return { id: newId(), name: name || 'New wheel', slots: slots };
  }

  function cur() {
    var w = slice();
    return w ? w.wheels[w.active] : null;
  }
  function nameOf(p) { return (p && (p.alias || p.label)) || '(unnamed)'; }
  function save() { if (env) env.saveSoon(); }

  /* ------------------------------------------------------- pin identity */

  function findPin(wheel, prov, key) {
    if (!wheel) return -1;
    for (var i = 0; i < wheel.slots.length; i++) {
      var s = wheel.slots[i];
      if (s && s.prov === prov && s.key === key) return i;
    }
    return -1;
  }

  /* Is this omni item on ANY wheel? (the picker's ✓ badge). Looks inside
     flyout bundles too — an item tucked into a fan is still "on a wheel". */
  function onAnyWheel(prov, key) {
    var w = slice();
    if (!w) return false;
    for (var i = 0; i < w.wheels.length; i++) {
      var wh = w.wheels[i];
      if (findPin(wh, prov, key) >= 0) return true;
      for (var s = 0; s < wh.slots.length; s++) {
        var p = wh.slots[s];
        if (!isFly(p)) continue;
        for (var c = 0; c < p.fly.length; c++)
          if (p.fly[c] && p.fly[c].prov === prov && p.fly[c].key === key) return true;
      }
    }
    return false;
  }

  function pinFromItem(provider, item) {
    return {
      prov: provider.id,
      key: String(item.pin),
      label: String(item.label || ''),
      detail: String(item.detail || ''),
      kind: String(item.kind || ''),
      alias: '',
      icon: safeIcon(item.icon),
      /* stringify-parse: the snap must be JSON-safe NOW rather than at save
         time — a closure smuggled in here would poison hdSave for the whole
         config, and this is the moment that mistake is cheap to see. */
      snap: item.snap ? JSON.parse(JSON.stringify(item.snap)) : null,
    };
  }

  /* Put an omni item on the wheel. slot < 0 = first empty (append a slot if
     the wheel is full and there is room). Returns true when it landed. */
  function place(provider, item, slot) {
    var wh = cur();
    if (!wh || !provider || !item || !item.pin) return false;
    var already = findPin(wh, provider.id, String(item.pin));
    if (already >= 0 && (slot === undefined || slot < 0)) {
      toast('“' + (item.label || '') + '” is already on this wheel');
      return false;
    }
    var idx = (typeof slot === 'number' && slot >= 0) ? slot : firstFree(wh);
    if (idx < 0) {
      if (wh.slots.length >= MAX_SLOTS) {
        toast('This wheel is full (' + MAX_SLOTS + ' slots) — make another wheel');
        return false;
      }
      wh.slots.push(null);
      idx = wh.slots.length - 1;
    }
    wh.slots[idx] = pinFromItem(provider, item);
    save();
    wantIcons();
    render();
    return true;
  }

  function firstFree(wh) {
    for (var i = 0; i < wh.slots.length; i++) if (!wh.slots[i]) return i;
    return -1;
  }

  /* -------------------------------------------------------- activation */

  function resolve(p) {
    if (window.HDOmni && typeof HDOmni.resolvePin === 'function')
      return HDOmni.resolvePin(p.prov, p.key);
    return { provider: null, item: null, indexed: false };
  }

  /* 'ok' | 'snap' | 'unknown' (provider data not loaded yet — never greyed)
     | 'gone' (the provider says it no longer exists) */
  function statusOf(p, r) {
    if (r.item) return 'ok';
    if (p.snap && r.provider && typeof r.provider.pinRun === 'function') return 'snap';
    if (!r.indexed) return 'unknown';
    return 'gone';
  }

  /* A PARTY wedge is "what would happen if you hit F7 on her" (Rober's own
     words) — the Followers tab's quick card, addressed at her. That is NOT
     the shelf's follower behaviour (the shelf opens her roster ACTION MENU),
     and deliberately so: the two surfaces were asked for different things, so
     the wheel takes the card route explicitly instead of silently changing
     `pinRun` and moving the shelf with it. Falls through to the ordinary
     resolution when the pane is absent or she has left the roster. */
  function tryPartyCard(p) {
    if (p.prov !== 'followers') return false;
    if (!window.FolPane || typeof FolPane.quickPick !== 'function') return false;
    var who = (p.snap && p.snap.original) || p.label;
    if (!who) return false;
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('followers');
    else if (env && env.setTab) env.setTab('followers');
    var ok = false;
    try { ok = FolPane.quickPick(who, p.label); } catch (e) { ok = false; }
    return ok;
  }

  function fire(i) {
    var wh = cur();
    var p = wh && wh.slots[i];
    if (!p) { openPicker(i); return; }
    /* A flyout wedge never fires directly — it fans its bundle out around
       itself and the NEXT pick (click or 1-9) is the real fire. Clicking the
       open wedge again folds it back up, which is the toggle every flyout in
       every game does. */
    if (isFly(p)) {
      if (ui.fly && ui.fly.slot === i) { closeFly(); return; }
      if (!p.fly.length) { toast('Nothing in this flyout yet — right-click it to fill it'); openFlyEdit(i); return; }
      openFly(i);
      return;
    }
    firePinAt(p, i);
  }

  function openFly(i) {
    ui.fly = { slot: i };
    ui.menu = null;
    ui.lookOpen = false;
    render();
  }
  function closeFly() {
    if (!ui.fly) return;
    ui.fly = null;
    render();
  }
  function fireFlyChild(k) {
    var wh = cur();
    var p = ui.fly && wh && wh.slots[ui.fly.slot];
    if (!isFly(p)) { closeFly(); return; }
    var child = p.fly[k];
    var at = ui.fly.slot;
    ui.fly = null;
    if (!child) { render(); return; }
    firePinAt(child, at);
  }

  function firePinAt(p, i) {
    /* A spell wedge set to EQUIP takes its own route: the omni provider's
       run() is hard-wired to cast, and equipping is a different verb with a
       hand argument. Fired from the stored identity (plugin + local id), the
       same pair everything else here addresses forms by, so it works whether
       or not the live spell index has warmed up yet. Equip does NOT close the
       deck — you equip in order to then go and use it, and a toggle you
       cannot see the result of is a toggle you press twice. */
    var md = modeOf(p);
    if (md && castable(p)) {
      var sn = p.snap || {};
      if (!sn.plugin && !sn.formId) { toast('That spell has no identity to equip'); return; }
      flash(i);
      toGame('hdOmniEquip', JSON.stringify({
        plugin: sn.plugin || '', localId: sn.localId >>> 0, formId: sn.formId >>> 0,
        name: sn.name || p.label || '', hand: SPELL_MODES[md].hand,
      }));
      return;
    }
    if (p.prov === 'followers') {
      /* close FIRST: the card is drawn by the deck panel this overlay hides,
         so opening it without leaving would show her card to nobody. */
      var wasOpen = ui.open;
      close(false);
      if (tryPartyCard(p)) { return; }
      if (wasOpen) { ui.open = true; document.body.classList.add('whl-open'); render(); }
    }
    var r = resolve(p);
    if (r.item) {
      /* live truth refreshes the stored label and art — but never the alias,
         which is the user's own name for it */
      if (r.item.label && r.item.label !== p.label) { p.label = r.item.label; save(); }
      var li = safeIcon(r.item.icon);
      if (li !== p.icon) { p.icon = li; save(); }
      if (typeof r.item.run === 'function') {
        flash(i);
        try { r.item.run(); } catch (e) {}
        afterFire(p);
        return;
      }
      if (r.provider && typeof r.provider.pinRun === 'function') {
        flash(i);
        try { r.provider.pinRun(p.snap || {}, r.item); } catch (e) {}
        afterFire(p, true);
        return;
      }
      jump(p, r.provider);
      return;
    }
    if (p.snap && r.provider && typeof r.provider.pinRun === 'function') {
      flash(i);
      try { r.provider.pinRun(p.snap, null); } catch (e) {}
      afterFire(p, true);
      return;
    }
    if (statusOf(p, r) === 'gone') {
      toast('“' + nameOf(p) + '” isn’t there any more — ' + goneWhy(p));
      return;
    }
    jump(p, r.provider);
  }

  function goneWhy(p) {
    if (p.prov === 'inventory') return 'you are not carrying it';
    if (p.prov === 'followers') return 'she is not on the roster';
    if (p.prov === 'hotkeys') return 'that hotkey was deleted';
    return 'its owner no longer lists it';
  }

  /* A wedge that opened a TAB (a follower card, a quest detail) has to leave
     the wheel — you cannot read the thing it opened through a full-screen
     overlay. A wedge that just fired (equip, cast, travel) closes the whole
     deck, which is what a radial menu is for: one gesture, back to the game. */
  function afterFire(p, wentToTab) {
    if (wentToTab) { close(false); return; }
    close(true);
  }

  function jump(p, provider) {
    provider = provider || (window.HDOmni && HDOmni.providerById(p.prov)) || null;
    if (!provider || !provider.tab) { toast('“' + nameOf(p) + '” isn’t reachable right now'); return; }
    close(false);
    /* setTab BEFORE setFilter — Finances (and others) wipe their filter in
       onShow, so the order is the whole difference between a pre-filled search
       and an empty one. Same trap omni's jumpTo documents. */
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab(provider.tab);
    else if (env && env.setTab) env.setTab(provider.tab);
    if (typeof provider.setFilter === 'function') {
      try { provider.setFilter(p.label || p.alias || ''); } catch (e) {}
    }
  }

  function flash(i) {
    var el = root && root.querySelector('.whl-slot[data-i="' + i + '"]');
    if (!el) return;
    el.classList.add('fire');
    setTimeout(function () { if (el) el.classList.remove('fire'); }, 340);
  }

  /* ------------------------------------------------------------- pictures */

  /* Ask C++ to render the meshes for every inventory pin across ALL wheels.
     Bounded by construction (12 wheels × 16 slots), never the whole inventory
     — 8 renders per item is measured in minutes, so "only what you pinned" is
     the difference between instant and unusable. */
  function wantIcons() {
    var w = slice();
    if (!w) return;
    var items = [], seen = {};
    function want(p) {
      if (!p) return;
      /* Flyout children are pinned items too — their renders are what the fan
         shows, so they are part of "only what you pinned" by definition. */
      if (isFly(p)) { p.fly.forEach(want); return; }
      if (p.prov !== 'inventory' || !p.snap) return;
      var k = String(p.snap.formId || '') + '|' + String(p.snap.plugin || '');
      if (!p.snap.formId || !p.snap.plugin || seen[k]) return;
      seen[k] = 1;
      items.push({ formId: p.snap.formId, plugin: p.snap.plugin, name: p.snap.name || p.label || '' });
    }
    w.wheels.forEach(function (wh) { wh.slots.forEach(want); });
    if (!items.length) return;
    toGame('whIcons', JSON.stringify({ items: items }));
  }

  /* One implementation of the key normalisation, and it is the Wardrobe's —
     ours would be a second place to get "UPPERCASE hex | lowercase plugin"
     subtly wrong. Absent pane (a harness) simply means no rendered art. */
  function meshIcon(p) {
    if (!p || p.prov !== 'inventory' || !p.snap) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      return safeIcon(WardrobePane.itemIconFor({ formId: p.snap.formId, plugin: p.snap.plugin }) || '');
    } catch (e) { return ''; }
  }

  function artFor(p) {
    return meshIcon(p) || safeIcon(p.icon);
  }
  /* A portrait is a face and must FILL its circle; an item render is a small
     object on transparency and must not be cropped. */
  function isFace(p) { return p.prov === 'followers' || String(p.icon || '').indexOf('portraits/') === 0; }

  var PROV_GLYPH = {
    hotkeys: '⌨', 'deck-actions': '⚙', tabs: '▦', notes: '✎', quests: '❖',
    spells: '✦', time: '◔', domains: '◈', rooms: '⌂', finances: 'ᚠ',
    wardrobe: '⛃', followers: '☺', inventory: '⚔', bases: '🏰', anim: '🕺',
    loot: '◆', ostim: '❥',
  };
  var KIND_GLYPH = {
    weapon: '⚔', armor: '🛡', armour: '🛡', potion: '⚗', food: '🍖', scroll: '📜',
    ingredient: '🌿', soulgem: '💎', book: '📖', ammo: '➶', key: '🗝', misc: '◈',
    combo: '⚡', action: '⚙', hotkey: '⌨', tab: '▦', note: '✎', quest: '❖',
    spell: '✦', wait: '◔', room: '⌂', outfit: '⛃', wardrobe: '⛃', market: 'ᚠ',
  };
  function glyphOf(p) {
    var k = String(p.kind || '').split(' ')[0].split('·')[0].trim().toLowerCase();
    return KIND_GLYPH[k] || PROV_GLYPH[p.prov] || '★';
  }

  /* What clicking it will DO, in words — the hub's bottom line. Derived from
     the provider, so a new provider gets an honest generic rather than a lie. */
  var HINTS = {
    inventory: function (p) {
      var k = String(p.kind || '').toLowerCase();
      if (k.indexOf('weapon') === 0 || k.indexOf('armo') === 0) return 'Click to equip';
      if (k.indexOf('potion') === 0 || k.indexOf('food') === 0) return 'Click to drink';
      if (k.indexOf('scroll') === 0) return 'Click to equip';
      return 'Click to use';
    },
    followers: function () { return 'Click to open her card'; },
    /* the wedge's own verb, not the provider's — a spell set to equip must not
       keep promising a cast */
    spells: function (p) {
      var m = modeOf(p);
      return m ? ('Click to ' + SPELL_MODES[m].verb) : 'Click to cast';
    },
    domains: function () { return 'Click to travel'; },
    wardrobe: function () { return 'Click to open the outfit'; },
    hotkeys: function () { return 'Click to fire the key'; },
    'deck-actions': function () { return 'Click to run'; },
    quests: function () { return 'Click to open the quest'; },
    time: function () { return 'Click to wait'; },
    rooms: function () { return 'Click to open the room'; },
  };
  function hintFor(p) {
    var f = HINTS[p.prov];
    try { return f ? f(p) : 'Click to open'; } catch (e) { return 'Click to open'; }
  }

  /* -------------------------------------------------------------- layout */

  /* The ring must always FIT: the tiles hang off it and their labels hang off
     them, so the usable radius is the half-viewport minus a tile and a margin.
     Measured every render — the deck is played at 2560×1440 and previewed at
     640, and a wheel that overflows either is not a wheel. */
  /* ---- ONE sizing calculation, for the radius AND the tiles ------------
     The first version fitted the RADIUS to the window and left the tiles at
     their full size. On a short window that put 8 unshrunk tiles on a small
     circle: neighbours touched, labels ran over the tile beside them and the
     hub. Radius and tile size are not two decisions — they are one, and this
     is where it is made.

     Per side, beyond the radius, the ring needs half a tile (56·eff), its
     two-line label (46·eff) and CHROME for the corner bars (the ticks, the
     ✎⚙✕ row, the help line — a wedge label landing on those is the exact
     overlap Rober's UI rule calls a bug).

         maxR(eff) = min(vw,vh)/2 − (102·eff + 60)

     Wanted radius is 260·eff. If that fits, eff is simply the user's size.
     If it does not, the whole assembly scales down together — eff = r/260 —
     and substituting gives a closed form rather than a guess:

         r = (min(vw,vh)/2 − 60) / (1 + 102/260)

     Then the ARC cap: n tiles on a circle of radius r get 2πr/n each, and a
     slot's box is 112·eff wide. More slots therefore means smaller tiles, on
     any screen — which is what stops a 16-slot wheel from overlapping itself
     at a size where an 8-slot one is comfortable. */
  function metrics(n, userScale) {
    var vw = (root && root.clientWidth) || window.innerWidth || 1280;
    var vh = (root && root.clientHeight) || window.innerHeight || 720;
    /* CHROME is the real height of the corner bars (ticks / help line at
       bottom:26, ~46 tall) plus a little air — 88, matching stageAt's EDGE_Y.
       The two MUST agree: metrics decides whether the assembly plus its chrome
       fits in half the viewport, and stageAt then parks it that far from the
       edge. When they disagreed (60 vs 26) a bottom-anchored wheel at 640x720
       fitted the screen and still sat on top of the help line. */
    var CHROME = 88, PER_SCALE = 102, R_AT_1 = 260, SLOT_BOX = 112;
    var half = Math.min(vw, vh) / 2;

    var eff = userScale;
    var r   = R_AT_1 * eff;
    if (r > half - (PER_SCALE * eff + CHROME)) {
      r = (half - CHROME) / (1 + PER_SCALE / R_AT_1);
      eff = r / R_AT_1;
    }
    /* How many LINES of label the arc can carry. A label is wider than the
       tile above it, so on a crowded ring the labels collide long before the
       tiles do — which is what a 16-slot wheel looked like before this: rings
       of names lying across their neighbours' pictures. Rather than shrink
       the type past readable (Rober's first UI rule is "no small text"), the
       label degrades: two lines, then one, then none. Nothing is lost when it
       reaches none — the hub always names what you are pointing at, and every
       tile carries hover text. */
    var arcPx = 2 * Math.PI * r / Math.max(n, 1);
    var lines = arcPx >= 150 ? 2 : (arcPx >= 106 ? 1 : 0);

    /* With no label under it, a slot only has to fit its own tile plus a gap,
       so the tiles stay big on a dense ring instead of being punished for a
       label that is not there. */
    var box = lines ? SLOT_BOX : 104;
    var arcEff = arcPx / box;
    if (arcEff < eff) eff = arcEff;

    /* Floors, so a pathologically small window degrades to "cramped but
       readable" rather than to unreadable. Rober's screen is 2560×1440; this
       branch exists for the 640px preview and for a stream at an odd size. */
    if (eff < 0.5) eff = 0.5;
    if (r < 120) r = 120;
    return { r: Math.round(r), eff: Math.round(eff * 1000) / 1000, lines: lines };
  }

  /* kept as a thin seam for the harness, which asserts the fit directly */
  function fitRadius(scale) { return metrics(8, scale).r; }

  /* Where the ring's CENTRE sits, in viewport pixels, for the chosen anchor.
     Coordinates are computed here rather than baked into the preset so a
     preset picked on a 2560-wide desktop still fits a stream at another size.

     `need` is the assembly's half-extent (radius + half a tile + its label),
     so a corner-anchored wheel is pushed exactly far enough off the edges that
     nothing is clipped — and clamped afterwards so it can never end up
     off-screen on a viewport too small for the chosen size. */
  function stageAt(anchor, r, eff, lines) {
    var vw = (root && root.clientWidth) || window.innerWidth || 1280;
    var vh = (root && root.clientHeight) || window.innerHeight || 720;
    var need = r + 56 * eff + (lines ? 46 * eff : 0);
    /* The edge margin is not one number, because the CHROME is not spread
       evenly: the ticks and the help line sit along the bottom (~46px tall at
       bottom:26) and the title/buttons row along the top. A flat 26px margin
       put a bottom-anchored wheel's labels straight through the help line at
       640x720 — nothing was off-screen, it was just on top of the text.
       Sideways there is nothing to clear, because the chrome moves to the
       opposite corner for a corner anchor (see the anc-* rules in the CSS). */
    var EDGE_X = 30, EDGE_Y = 88;
    var x = vw / 2, y = vh / 2;
    if (anchor === 'br' || anchor === 'tr') x = vw - need - EDGE_X;
    if (anchor === 'bl' || anchor === 'tl') x = need + EDGE_X;
    if (anchor === 'br' || anchor === 'bl' || anchor === 'bc') y = vh - need - EDGE_Y;
    if (anchor === 'tr' || anchor === 'tl') y = need + EDGE_Y;
    /* The clamp keeps the same margins metrics() budgeted for, so it can never
       "rescue" the wheel by pushing it back into the chrome. lo>hi is
       impossible by construction (metrics caps `need` at half the viewport
       minus CHROME, and CHROME == EDGE_Y), but the Math.min guards it anyway
       rather than trusting two constants to stay in step forever. */
    var loX = need + EDGE_X, hiX = vw - need - EDGE_X;
    var loY = need + EDGE_Y, hiY = vh - need - EDGE_Y;
    return {
      x: Math.round(hiX >= loX ? clamp(x, loX, hiX) : vw / 2),
      y: Math.round(hiY >= loY ? clamp(y, loY, hiY) : vh / 2),
    };
  }

  function slotPos(i, n, r) {
    /* first slot at 12 o'clock, then clockwise — the reading order every
       radial menu in every game uses */
    var a = (-Math.PI / 2) + (i * 2 * Math.PI / n);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, a: a };
  }

  /* Cursor angle → slot. Inside the dead zone nothing is selected, which is
     what makes the hub a readout you can rest on rather than a 17th target. */
  function slotAt(dx, dy, n, r) {
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < r * DEAD_ZONE) return -1;
    var a = Math.atan2(dy, dx) + Math.PI / 2;      // 0 = up
    while (a < 0) a += Math.PI * 2;
    while (a >= Math.PI * 2) a -= Math.PI * 2;
    return Math.round(a / (Math.PI * 2 / n)) % n;
  }

  /* ------------------------------------------------------------- render */

  function ensureDom() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'hd-wheel';
    root.innerHTML =
      '<div class="whl-stage">' +
        '<div class="whl-pool"></div>' +
        '<div class="whl-beam"></div>' +
        '<div class="whl-ring"></div>' +
        '<div class="whl-ring inner"></div>' +
        '<div class="whl-spokes"></div>' +
        '<div class="whl-slots"></div>' +
        '<div class="whl-hub"></div>' +
      '</div>' +
      '<div class="whl-bar tl">' +
        '<span class="whl-wname"></span><span class="whl-wsub"></span>' +
      '</div>' +
      '<div class="whl-bar tr">' +
        /* The look picker lives ON the wheel, not inside ⚙ settings: it is the
           control you reach for BECAUSE the wheel is in your way right now,
           and making that a trip through a settings sheet (or a hotkey you
           have to remember) is the wrong shape. Rober, 2026-08-11: "need some
           sort of dropdown when wheel is open to do it, not a hardcoded V." */
        '<button class="whl-btn whl-look" data-act="look" ' +
          'title="Where the wheel sits, how big it is, how much it dims the game">' +
          '<span class="whl-look-ico">◱</span>' +
          '<span class="whl-look-lab"></span>' +
          '<span class="whl-look-caret">▾</span>' +
        '</button>' +
        '<button class="whl-btn" data-act="pick" title="Add something to this wheel (F)">＋ Add</button>' +
        '<button class="whl-btn" data-act="edit" title="Edit mode — arrange, rename and remove (E)">✎</button>' +
        '<button class="whl-btn" data-act="settings" title="Wheel settings — size, slots, wheels (S)">⚙</button>' +
        '<button class="whl-btn" data-act="close" title="Close the wheel (Esc)">✕</button>' +
      '</div>' +
      '<div class="whl-bar bl"><span class="whl-help"></span></div>' +
      '<div class="whl-bar br">' +
        '<button class="whl-btn" data-act="prev" title="Previous wheel (←)">‹</button>' +
        '<div class="whl-dots"></div>' +
        '<button class="whl-btn" data-act="next" title="Next wheel (→)">›</button>' +
      '</div>';
    document.body.appendChild(root);

    root.addEventListener('mousemove', onMove);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('contextmenu', onCtx);
    /* Ultralight has no PointerEvents and its wheel event is plain 'mousewheel'
       on some builds — listen for both, and never rely on the delta's units. */
    root.addEventListener('wheel', onScroll);
    root.addEventListener('mousewheel', onScroll);
    return root;
  }

  function render() {
    if (!ui.open) return;
    ensureDom();
    var w = slice();
    if (!w) return;
    var wh = w.wheels[w.active];
    var n = wh.slots.length;
    var m = metrics(n, w.size);
    var r = m.r;
    ui.radius = r;
    ui.eff = m.eff;
    /* the EFFECTIVE scale, not the stored one — see metrics(). The settings
       sheet still shows the user's own number; this is what draws. */
    root.style.setProperty('--whl-scale', String(m.eff));
    root.style.setProperty('--whl-r', r + 'px');
    root.classList.toggle('lbl-1', m.lines === 1);
    root.classList.toggle('lbl-0', m.lines === 0);

    /* placement + dim (the preset's two halves) */
    var at = stageAt(w.anchor, r, m.eff, m.lines);
    ui.center = at;
    var stage = root.querySelector('.whl-stage');
    stage.style.left = at.x + 'px';
    stage.style.top = at.y + 'px';
    ['c', 'bc', 'br', 'bl', 'tr', 'tl'].forEach(function (a) {
      root.classList.toggle('anc-' + a, w.anchor === a);
    });
    ['full', 'light', 'none'].forEach(function (d) {
      root.classList.toggle('dim-' + d, w.dim === d);
    });
    root.classList.toggle('has-sel', ui.sel >= 0);
    root.classList.toggle('editing', !!ui.edit);

    /* spokes: one per boundary BETWEEN slots (offset by half a step) */
    var spokes = '';
    for (var s = 0; s < n; s++) {
      var deg = (s + 0.5) * (360 / n) - 90;
      spokes += '<div class="whl-spoke" style="transform:rotate(' + (deg + 90) + 'deg)"></div>';
    }
    root.querySelector('.whl-spokes').innerHTML = spokes;

    /* slots */
    var host = root.querySelector('.whl-slots');
    var html = '';
    for (var i = 0; i < n; i++) {
      var p = wh.slots[i];
      var pos = slotPos(i, n, r);
      var cls = 'whl-slot' + (i === ui.sel ? ' sel' : '');
      var art = '', label = '', title = '';
      if (!p) {
        cls += ' empty';
        art = '<span class="whl-glyph">＋</span>';
        label = ui.edit ? 'Add…' : '';
        title = 'Empty slot — click to add something';
      } else if (isFly(p)) {
        cls += ' fly' + (ui.fly && ui.fly.slot === i ? ' fly-open' : '');
        /* Face of the bundle: its own chosen icon first, else the first
           child's art, else the fan glyph. The count chip is always there —
           a wedge that hides how much it holds reads as one action. */
        var furl = safeIcon(p.icon) || (p.fly[0] ? artFor(p.fly[0]) : '');
        art = '<span class="whl-glyph">⧉</span>' +
          (furl ? '<img class="whl-img" src="' + esc(furl) + '" alt="" draggable="false">' : '') +
          '<span class="whl-flyn">' + p.fly.length + '</span>';
        if (furl) cls += ' has-art';
        label = esc(nameOf(p) || 'Flyout');
        title = (nameOf(p) || 'Flyout') + ' — flyout, ' + p.fly.length + ' inside. Click to fan it out.';
      } else {
        var r2 = resolve(p);
        var stat = statusOf(p, r2);
        if (stat === 'gone') cls += ' gone';
        var url = artFor(p);
        /* The glyph is the FALLBACK, so it must not show through a picture
           with transparency (an item render is a small object on nothing).
           `has-art` hides it; the error handler takes the class off with the
           <img>, so a stale path lands back on the glyph rather than on an
           empty circle. */
        art = '<span class="whl-glyph">' + glyphOf(p) + '</span>' +
          (url ? '<img class="whl-img' + (isFace(p) ? ' face' : '') + '" src="' + esc(url) +
                 '" alt="" draggable="false">' : '');
        if (url) cls += ' has-art';
        label = esc(nameOf(p));
        title = nameOf(p) + (p.detail ? ' — ' + p.detail : '') +
          (stat === 'gone' ? '  (missing: ' + goneWhy(p) + ')' : '');
      }
      html += '<div class="' + cls + '" data-i="' + i + '" title="' + esc(title) + '" ' +
        'style="transform:translate(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px)">' +
        '<div class="whl-tile">' + art + '</div>' +
        '<div class="whl-name">' + label + '</div>' +
        '</div>';
    }
    host.innerHTML = html;
    armImgFallbacks(host);
    root.classList.toggle('has-fly', !!ui.fly);
    renderFly(wh, n, r);

    /* the beam sits at the selected slot's angle, just inside the ring */
    var beam = root.querySelector('.whl-beam');
    if (ui.sel >= 0) {
      var bp = slotPos(ui.sel, n, r * 0.62);
      beam.style.transform = 'translate(' + Math.round(bp.x) + 'px,' + Math.round(bp.y) + 'px)';
    }

    renderHub(wh, n);
    renderChrome(w, wh, n);
    renderLook(w);
    renderMenu();
    renderSheet();
  }

  /* innerHTML cannot carry listeners — arm the error fallback after the paint,
     so a stale path costs a blink instead of a broken-image box (the same
     contract the shelf's plates use). */
  function armImgFallbacks(host) {
    var imgs = host.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      (function (im) {
        im.addEventListener('error', function () {
          /* Put the glyph back BEFORE dropping the picture — the two classes
             are one decision, and an <img> removed without clearing `has-art`
             leaves a blank circle, which is the failure the fallback exists
             to prevent. The flag is walked up rather than assumed on the
             parent, because the tile and the hub nest it differently. */
          var el = im.parentNode;
          while (el && el.classList) {
            if (el.classList.contains('has-art')) { el.classList.remove('has-art'); break; }
            el = el.parentNode;
          }
          if (im.parentNode) im.parentNode.removeChild(im);
        });
      })(imgs[i]);
    }
  }

  /* The flyout fan: the bundle's pins on a small arc AROUND the open wedge,
     centred on its outward direction, numbered 1-9. Lives inside .whl-stage so
     it shares the ring's coordinate space; positions are then shifted as a
     group if the fan would poke off-screen (a corner-anchored wheel's outward
     is exactly where the screen ends). */
  function renderFly(wh, n, r) {
    var stage = root.querySelector('.whl-stage');
    var old = stage && stage.querySelector('.whl-fly');
    if (old) old.parentNode.removeChild(old);
    if (!ui.fly || !stage) return;
    var p = wh.slots[ui.fly.slot];
    if (!isFly(p) || !p.fly.length) { ui.fly = null; root.classList.remove('has-fly'); return; }

    var eff = ui.eff || 1;
    var pos = slotPos(ui.fly.slot, n, r);
    var k = p.fly.length;
    var stepDeg = k <= 3 ? 52 : (k <= 5 ? 46 : (k <= 7 ? 40 : 34));
    var FR = 128 * eff;

    var offs = [];
    for (var c = 0; c < k; c++) {
      var ang = pos.a + ((c - (k - 1) / 2) * stepDeg) * Math.PI / 180;
      offs.push({ x: pos.x + Math.cos(ang) * FR, y: pos.y + Math.sin(ang) * FR });
    }
    /* group clamp: keep every tile (half-box HALF) inside the viewport */
    var vw = root.clientWidth || window.innerWidth || 1280;
    var vh = root.clientHeight || window.innerHeight || 720;
    var cx = ui.center ? ui.center.x : vw / 2;
    var cy = ui.center ? ui.center.y : vh / 2;
    var HALF = 46 * eff + 10;
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    offs.forEach(function (o) {
      minX = Math.min(minX, o.x); maxX = Math.max(maxX, o.x);
      minY = Math.min(minY, o.y); maxY = Math.max(maxY, o.y);
    });
    var dx = 0, dy = 0;
    if (cx + minX - HALF < 0) dx = -(cx + minX - HALF);
    else if (cx + maxX + HALF > vw) dx = vw - (cx + maxX + HALF);
    if (cy + minY - HALF < 0) dy = -(cy + minY - HALF);
    else if (cy + maxY + HALF > vh) dy = vh - (cy + maxY + HALF);

    var box = document.createElement('div');
    box.className = 'whl-fly';
    var html = '';
    for (var j = 0; j < k; j++) {
      var ch = p.fly[j];
      var url = ch ? artFor(ch) : '';
      var nm = ch ? nameOf(ch) : '';
      html += '<div class="whl-flych' + (url ? ' has-art' : '') + '" data-fk="' + j + '" ' +
        'title="' + esc(nm + (ch && ch.detail ? ' — ' + ch.detail : '')) + '" ' +
        'style="transform:translate(' + Math.round(offs[j].x + dx) + 'px,' + Math.round(offs[j].y + dy) + 'px)">' +
        '<div class="whl-flych-tile">' +
          '<span class="whl-glyph">' + (ch ? glyphOf(ch) : '＋') + '</span>' +
          (url ? '<img class="whl-img' + (ch && isFace(ch) ? ' face' : '') + '" src="' + esc(url) + '" alt="" draggable="false">' : '') +
          '<span class="whl-flych-n">' + (j + 1) + '</span>' +
        '</div>' +
        '<div class="whl-flych-name">' + esc(nm) + '</div>' +
        '</div>';
    }
    box.innerHTML = html;
    stage.appendChild(box);
    armImgFallbacks(box);
  }

  function renderHub(wh, n) {
    var hub = root.querySelector('.whl-hub');
    var p = ui.sel >= 0 ? wh.slots[ui.sel] : null;
    if (ui.sel >= 0 && !p) {
      hub.innerHTML =
        '<div class="whl-hub-art">＋</div>' +
        '<div class="whl-hub-name">Empty slot</div>' +
        '<div class="whl-hub-detail">Slot ' + (ui.sel + 1) + ' of ' + n + '</div>' +
        '<div class="whl-hub-hint">Click to add something</div>';
      return;
    }
    if (!p) {
      var filled = 0;
      wh.slots.forEach(function (s) { if (s) filled++; });
      hub.innerHTML =
        '<div class="whl-hub-title">' + esc(wh.name) + '</div>' +
        '<div class="whl-hub-sub">' + filled + ' of ' + n + ' slots filled</div>' +
        '<div class="whl-hub-sub">' + (filled ? 'Point at one to see it' : 'Nothing here yet — hit ＋ Add') + '</div>';
      return;
    }
    if (isFly(p)) {
      var fnames = p.fly.map(function (c) { return nameOf(c); }).slice(0, 4).join(' · ');
      var furl2 = safeIcon(p.icon) || (p.fly[0] ? artFor(p.fly[0]) : '');
      hub.innerHTML =
        '<div class="whl-hub-art' + (furl2 ? ' has-art' : '') + '">' +
          '<span class="whl-hub-glyph">⧉</span>' +
          (furl2 ? '<img src="' + esc(furl2) + '" alt="">' : '') +
        '</div>' +
        '<div class="whl-hub-name">' + esc(nameOf(p) || 'Flyout') + '</div>' +
        (fnames ? '<div class="whl-hub-detail">' + esc(fnames + (p.fly.length > 4 ? ' · +' + (p.fly.length - 4) + ' more' : '')) + '</div>' : '') +
        '<div class="whl-hub-kind">flyout · ' + p.fly.length + ' inside</div>' +
        '<div class="whl-hub-hint">' + (p.fly.length ? 'Click to fan it out — then click one, or press its number' : 'Empty — right-click to fill it') + '</div>';
      armImgFallbacks(hub);
      return;
    }
    var r2 = resolve(p);
    var stat = statusOf(p, r2);
    var url = artFor(p);
    var detail = (r2.item && r2.item.detail) || p.detail || '';
    hub.innerHTML =
      '<div class="whl-hub-art' + (url ? ' has-art' : '') + '">' +
        '<span class="whl-hub-glyph">' + glyphOf(p) + '</span>' +
        (url ? '<img class="' + (isFace(p) ? 'face' : '') + '" src="' + esc(url) + '" alt="">' : '') +
      '</div>' +
      '<div class="whl-hub-name">' + esc(nameOf(p)) + '</div>' +
      (detail ? '<div class="whl-hub-detail">' + esc(detail) + '</div>' : '') +
      /* the chip carries the wedge's MODE when it has one — "spell" alone
         would not tell you this one goes in your left hand */
      (function () {
        var md = modeOf(p);
        var chip = md ? (p.kind || 'spell') + ' · ' + SPELL_MODES[md].label.toLowerCase() : p.kind;
        return chip ? '<div class="whl-hub-kind">' + esc(chip) + '</div>' : '';
      })() +
      '<div class="whl-hub-hint">' + (stat === 'gone'
        ? 'Missing — ' + esc(goneWhy(p))
        : (stat === 'unknown' ? 'Loading…' : esc(hintFor(p)))) + '</div>';
    armImgFallbacks(hub);
  }

  function renderChrome(w, wh, n) {
    root.querySelector('.whl-wname').textContent = wh.name;
    root.querySelector('.whl-wsub').textContent =
      (w.wheels.length > 1 ? 'wheel ' + (w.active + 1) + ' / ' + w.wheels.length : '');
    /* The help line reads the LIVE bindings — a rebound or switched-off key
       must not still be advertised, which is the whole failure mode of a
       hand-written hint string. */
    function hint(id, words) {
      var k = keyOf(id);
      return k ? (keyLabel(k) + ' ' + words) : '';
    }
    root.querySelector('.whl-help').textContent = ui.edit
      ? 'EDIT — click a slot to fill it · right-click to rename or remove · Del clears'
      : ['1–' + (n > 9 ? 9 : n) + ' fire', '← → wheels',
         '◱ Look' + (keyOf('look') ? ' (' + keyLabel(keyOf('look')) + ')' : ''),
         hint('edit', 'edit'), hint('add', 'add'), 'Esc close']
        .filter(Boolean).join(' · ');
    root.querySelector('[data-act="edit"]').classList.toggle('on', !!ui.edit);

    var dots = '';
    for (var i = 0; i < w.wheels.length; i++)
      dots += '<div class="whl-dot' + (i === w.active ? ' on' : '') + '" data-w="' + i + '" title="' +
        esc(w.wheels[i].name) + '"></div>';
    if (w.wheels.length < MAX_WHEELS)
      dots += '<div class="whl-dot add" data-w="new" title="New wheel"></div>';
    root.querySelector('.whl-dots').innerHTML = dots;
    var prev = root.querySelector('[data-act="prev"]'), next = root.querySelector('[data-act="next"]');
    prev.classList.toggle('disabled', w.wheels.length < 2);
    next.classList.toggle('disabled', w.wheels.length < 2);
  }

  /* ---------------------------------------------------- the look dropdown */
  /* The same preset rows the settings sheet shows — presetRowsHtml() is the
     one implementation, so a preset added to the table appears in both places
     with no second edit. Drawn as a panel hanging off the ✎/⚙ bar rather than
     a native <select>, which Ultralight renders unpredictably (and which could
     not carry the little screen maps anyway). */
  function renderLook(w) {
    var btn = root.querySelector('.whl-look');
    var pid = currentPreset(w);
    var p = presetById(pid);
    btn.querySelector('.whl-look-lab').textContent = p ? p.label : 'Custom';
    var lk = keyOf('look');
    btn.setAttribute('title', 'Where the wheel sits, how big it is, how much it dims the game' +
      (lk ? ' — ' + keyLabel(lk) + ' steps to the next one' : ''));
    btn.classList.toggle('on', !!ui.lookOpen);
    btn.querySelector('.whl-look-caret').textContent = ui.lookOpen ? '▴' : '▾';

    var old = root.querySelector('.whl-look-pop');
    if (old) old.parentNode.removeChild(old);
    if (!ui.lookOpen) return;

    var pop = document.createElement('div');
    pop.className = 'whl-look-pop';
    pop.innerHTML =
      '<div class="whl-look-head">Look &amp; placement' +
        '<span class="whl-look-sub">Pick one — the wheel moves as you do</span>' +
      '</div>' +
      '<div class="whl-presets">' + presetRowsHtml(pid) +
        (pid === 'custom'
          ? '<div class="whl-preset on" data-preset="custom" title="Your own mix, set in ⚙ settings">' +
              presetMap({ anchor: w.anchor, size: w.size, dim: w.dim }) +
              '<div class="whl-preset-txt">' +
                '<div class="whl-preset-name">Custom</div>' +
                '<div class="whl-preset-note">Your own mix — the rows in ⚙ settings set it.</div>' +
              '</div>' +
              '<div class="whl-preset-meta">' + Math.round(w.size * 100) + '%</div>' +
            '</div>'
          : '') +
      '</div>' +
      '<div class="whl-look-foot">More in ⚙ settings — size, slots and wheels</div>';
    root.appendChild(pop);

    /* Own handlers, and they STOP the event: the field behind this panel fires
       whatever wedge the cursor points at, so a click that fell through would
       equip a sword instead of moving the wheel. */
    pop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    pop.addEventListener('contextmenu', function (e) { e.stopPropagation(); e.preventDefault(); });
    pop.addEventListener('click', function (e) {
      e.stopPropagation();
      var row = closestSel(e.target, '[data-preset]');
      if (!row) return;
      var id = row.getAttribute('data-preset');
      if (id === 'custom') return;
      applyPreset(id);        // re-renders, which redraws this panel in place
    });
  }

  /* --------------------------------------------------------------- input */

  function onMove(e) {
    if (ui.sheet || ui.menu) return;
    /* An open fan freezes the pointer-angle selection: the cursor is on its
       way to a child tile, and re-aiming the ring underneath would repaint
       the world mid-reach. */
    if (ui.fly) return;
    /* The STAGE's centre, not the viewport's — with a corner preset those are
       nowhere near each other, and reading the viewport would aim the whole
       wheel from the middle of the screen while it is drawn in the corner. */
    var rect = root.getBoundingClientRect();
    var cx = rect.left + (ui.center ? ui.center.x : rect.width / 2);
    var cy = rect.top + (ui.center ? ui.center.y : rect.height / 2);
    var wh = cur();
    if (!wh) return;
    var s = slotAt(e.clientX - cx, e.clientY - cy, wh.slots.length, ui.radius);
    if (s === ui.sel) return;
    ui.sel = s;
    /* Targeted repaint: a full render() on every mousemove would rebuild the
       whole ring 60× a second and throw away the img elements mid-load. */
    var prev = root.querySelector('.whl-slot.sel');
    if (prev) prev.classList.remove('sel');
    if (s >= 0) {
      var el = root.querySelector('.whl-slot[data-i="' + s + '"]');
      if (el) el.classList.add('sel');
      var bp = slotPos(s, wh.slots.length, ui.radius * 0.62);
      root.querySelector('.whl-beam').style.transform =
        'translate(' + Math.round(bp.x) + 'px,' + Math.round(bp.y) + 'px)';
    }
    root.classList.toggle('has-sel', s >= 0);
    renderHub(wh, wh.slots.length);
  }

  function onDown(e) {
    if (e.button === 2) return;                       // handled by onCtx
    var t = e.target;
    /* chrome and overlays own their own clicks */
    if (closestSel(t, '.whl-sheet') || closestSel(t, '.whl-menu') ||
        closestSel(t, '.whl-look-pop')) return;
    if (ui.menu) { ui.menu = null; renderMenu(); return; }
    var btn = closestSel(t, '.whl-btn');
    if (btn) { e.preventDefault(); e.stopPropagation(); doAct(btn.getAttribute('data-act')); return; }
    /* An open fan owns the click: a child tile fires, anything else folds the
       fan back up — and does NOTHING else, so reaching past the fan can never
       fire the wedge underneath it. */
    if (ui.fly) {
      e.preventDefault();
      e.stopPropagation();
      var fch = closestSel(t, '.whl-flych');
      if (fch) { fireFlyChild(parseInt(fch.getAttribute('data-fk'), 10)); return; }
      closeFly();
      return;
    }
    /* A click anywhere else dismisses the Look panel FIRST and does nothing
       else — click-away must not also fire the wedge you happened to be
       pointing at while reaching for empty space. */
    if (ui.lookOpen) {
      e.preventDefault();
      e.stopPropagation();
      ui.lookOpen = false;
      render();
      return;
    }
    var dot = closestSel(t, '.whl-dot');
    if (dot) {
      e.preventDefault(); e.stopPropagation();
      var d = dot.getAttribute('data-w');
      if (d === 'new') addWheel(); else selectWheel(parseInt(d, 10));
      return;
    }
    if (ui.sheet) return;
    /* A click anywhere on the field fires whatever the cursor is POINTING at —
       you never have to hit the tile. In the dead zone it closes, which is the
       "click away to dismiss" every menu owes the player. */
    var slotEl = closestSel(t, '.whl-slot');
    var i = slotEl ? parseInt(slotEl.getAttribute('data-i'), 10) : ui.sel;
    e.preventDefault();
    e.stopPropagation();
    if (i < 0) { close(true); return; }
    if (ui.edit) {
      /* In edit mode a flyout wedge opens ITS editor — the plain picker would
         overwrite the whole bundle with one pin, which is never what an edit
         click means. */
      var ep = cur() && cur().slots[i];
      if (isFly(ep)) { openFlyEdit(i); return; }
      openPicker(i);
      return;
    }
    fire(i);
  }

  function onCtx(e) {
    e.preventDefault();
    e.stopPropagation();
    if (ui.sheet) return;
    if (ui.fly) { closeFly(); return; }
    var slotEl = closestSel(e.target, '.whl-slot');
    var i = slotEl ? parseInt(slotEl.getAttribute('data-i'), 10) : ui.sel;
    if (i < 0) { ui.menu = null; renderMenu(); return; }
    ui.menu = { slot: i, x: e.clientX, y: e.clientY, armed: false };
    renderMenu();
  }

  function onScroll(e) {
    if (ui.sheet) return;
    var d = e.deltaY !== undefined ? e.deltaY : -(e.wheelDelta || 0);
    if (!d) return;
    e.preventDefault();
    cycleWheel(d > 0 ? 1 : -1);
  }

  /* Element.closest is not something to assume in Ultralight — and neither is
     Element.matches, which the first version fell back to. If matches() were
     missing, EVERY chrome button would silently stop working (the walk would
     return null and the click would fall through to "fire whatever the cursor
     points at"), so the matcher is hand-rolled over the three shapes this file
     actually uses: '.class', '[attr]' and a bare tag name. No regex, no
     selector engine, nothing to be absent. */
  function selMatch(el, sel) {
    if (sel.charAt(0) === '.') {
      return !!el.classList && el.classList.contains(sel.slice(1));
    }
    if (sel.charAt(0) === '[') {
      return !!el.getAttribute && el.getAttribute(sel.slice(1, -1)) !== null;
    }
    return String(el.tagName || '').toLowerCase() === sel;
  }
  function closestSel(el, sel) {
    while (el && el !== root && el.nodeType === 1) {
      if (selMatch(el, sel)) return el;
      el = el.parentNode;
    }
    return null;
  }

  function doAct(a) {
    if (a === 'look') { ui.lookOpen = !ui.lookOpen; render(); return; }
    if (a === 'close') { close(true); return; }
    if (a === 'edit') { ui.edit = !ui.edit; ui.menu = null; ui.lookOpen = false; render(); return; }
    if (a === 'pick') { ui.lookOpen = false; openPicker(-1); return; }
    if (a === 'settings') { ui.lookOpen = false; ui.sheet = 'settings'; render(); return; }
    if (a === 'prev') { cycleWheel(-1); return; }
    if (a === 'next') { cycleWheel(1); return; }
  }

  /* ---------------------------------------------------------- the wheels */

  function cycleWheel(dir) {
    var w = slice();
    if (!w || w.wheels.length < 2) return;
    selectWheel((w.active + dir + w.wheels.length) % w.wheels.length);
  }

  function selectWheel(i) {
    var w = slice();
    if (!w || !(i >= 0) || i >= w.wheels.length || i === w.active) return;
    w.active = i;
    ui.sel = -1;
    ui.menu = null;
    ui.fly = null;
    save();
    render();
  }

  function addWheel() {
    var w = slice();
    if (!w) return;
    if (w.wheels.length >= MAX_WHEELS) { toast('That is the last wheel (' + MAX_WHEELS + ')'); return; }
    w.wheels.push(freshWheel('Wheel ' + (w.wheels.length + 1)));
    w.active = w.wheels.length - 1;
    ui.sel = -1;
    save();
    render();
    toast('New wheel — ＋ Add to fill it');
  }

  /* --------------------------------------------------------- slot editing */

  function clearSlot(i) {
    var wh = cur();
    if (!wh || !wh.slots[i]) return;
    var nm = nameOf(wh.slots[i]);
    wh.slots[i] = null;
    save();
    ui.menu = null;
    render();
    toast('Removed “' + nm + '”');
  }

  function moveSlot(i, dir) {
    var wh = cur();
    if (!wh) return;
    var n = wh.slots.length;
    var j = (i + dir + n) % n;
    var t = wh.slots[i]; wh.slots[i] = wh.slots[j]; wh.slots[j] = t;
    ui.sel = j;
    ui.menu = null;
    save();
    render();
  }

  function setSlotCount(n) {
    var wh = cur();
    if (!wh) return;
    n = clamp(n | 0, MIN_SLOTS, MAX_SLOTS);
    var old = wh.slots.length;
    if (n === old) return;
    if (n < old) {
      /* Shrinking must not silently eat pins: compact the survivors down into
         the slots that remain, and only refuse when they genuinely will not
         fit. Losing a pin to a −1 click is not an acceptable trade. */
      var kept = wh.slots.filter(function (s) { return !!s; });
      if (kept.length > n) {
        toast('Remove a pin first — ' + kept.length + ' pins will not fit in ' + n + ' slots');
        return;
      }
      var next = [];
      for (var i = 0; i < n; i++) next.push(kept[i] || null);
      wh.slots = next;
    } else {
      for (var k = old; k < n; k++) wh.slots.push(null);
    }
    ui.sel = -1;
    save();
    render();
  }

  /* ------------------------------------------------------- context menu */

  function renderMenu() {
    var old = root.querySelector('.whl-menu');
    if (old) old.parentNode.removeChild(old);
    if (!ui.menu) return;
    var wh = cur();
    var p = wh && wh.slots[ui.menu.slot];
    var m = document.createElement('div');
    m.className = 'whl-menu';
    var html = '';
    if (!p) {
      html = '<button data-m="add">＋ Put something here…</button>' +
        '<button data-m="newfly">⧉ New flyout here…</button>';
    } else if (isFly(p)) {
      html =
        '<button data-m="fire">▶ Fan it out</button>' +
        '<button data-m="flyedit">⧉ Edit the flyout…</button>' +
        '<button data-m="rename">✎ Rename on the wheel…</button>' +
        '<div class="sep"></div>' +
        '<button data-m="left">‹ Move counter-clockwise</button>' +
        '<button data-m="right">› Move clockwise</button>' +
        '<div class="sep"></div>' +
        '<button class="danger" data-m="del">' +
          (ui.menu.armed ? '✕ Really remove “' + esc(nameOf(p)) + '” and everything in it'
                         : '✕ Remove from wheel') +
        '</button>';
    } else {
      html =
        '<button data-m="fire">▶ ' + esc(hintFor(p).replace(/^Click to /, '')) + '</button>' +
        '<button data-m="rename">✎ Rename on the wheel…</button>' +
        '<button data-m="swap">⇄ Replace with something else…</button>' +
        '<button data-m="mkfly">⧉ Turn into a flyout…</button>' +
        /* Spell wedges choose their verb here — cast it, or equip it into a
           named hand. Only spells get the block: nothing else has hands. */
        (castable(p)
          ? '<div class="sep"></div>' +
            '<div class="whl-menu-h">What this wedge does</div>' +
            ['', 'left', 'right', 'both'].map(function (m) {
              var on = modeOf(p) === m;
              var lab = m ? SPELL_MODES[m].label : 'Cast it';
              return '<button class="mode' + (on ? ' on' : '') + '" data-mode="' + m + '">' +
                (on ? '✓ ' : '') + esc(lab) + '</button>';
            }).join('')
          : '') +
        '<div class="sep"></div>' +
        '<button data-m="left">‹ Move counter-clockwise</button>' +
        '<button data-m="right">› Move clockwise</button>' +
        '<div class="sep"></div>' +
        '<button class="danger" data-m="del">' +
          (ui.menu.armed ? '✕ Really remove “' + esc(nameOf(p)) + '”' : '✕ Remove from wheel') +
        '</button>';
    }
    m.innerHTML = html;
    /* clamp into view — a menu opened near the right edge must not be
       half off-screen with its dangerous item unreachable */
    var mw = 246, mh = p ? 300 : 60;
    var x = Math.min(ui.menu.x, (root.clientWidth || window.innerWidth) - mw - 12);
    var y = Math.min(ui.menu.y, (root.clientHeight || window.innerHeight) - mh - 12);
    m.style.left = Math.max(8, x) + 'px';
    m.style.top = Math.max(8, y) + 'px';
    root.appendChild(m);
    m.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    m.addEventListener('click', function (e) {
      var b = closestSel(e.target, 'button');
      if (!b) return;
      e.stopPropagation();
      var mode = b.getAttribute('data-mode');
      if (mode !== null) {
        var wh2 = cur();
        var pp = wh2 && wh2.slots[ui.menu.slot];
        if (pp) {
          pp.mode = SPELL_MODES[mode] ? mode : '';
          save();
        }
        ui.menu = null;
        render();
        toast(mode ? ('That wedge now ' + SPELL_MODES[mode].verb + 's it')
                   : 'That wedge casts it');
        return;
      }
      onMenu(b.getAttribute('data-m'));
    });
  }

  function onMenu(a) {
    var i = ui.menu ? ui.menu.slot : -1;
    if (i < 0) return;
    if (a === 'add' || a === 'swap') { ui.menu = null; openPicker(i); return; }
    if (a === 'newfly') { ui.menu = null; makeFly(i, null); return; }
    if (a === 'mkfly') { ui.menu = null; makeFly(i, cur() && cur().slots[i]); return; }
    if (a === 'flyedit') { ui.menu = null; openFlyEdit(i); return; }
    if (a === 'fire') { ui.menu = null; render(); fire(i); return; }
    if (a === 'left') { moveSlot(i, -1); return; }
    if (a === 'right') { moveSlot(i, 1); return; }
    if (a === 'rename') { ui.menu = null; ui.sheet = 'rename'; ui.pickSlot = i; render(); return; }
    if (a === 'del') {
      /* Armed two-click: PrismaUI has no confirm(), and a one-click destroy on
         a right-click menu is how you lose a pin you spent time finding. */
      if (!ui.menu.armed) { ui.menu.armed = true; renderMenu(); return; }
      clearSlot(i);
    }
  }

  /* ------------------------------------------------------------- sheets */

  function openPicker(slot) {
    ui.sheet = 'pick';
    ui.pickSlot = (typeof slot === 'number') ? slot : -1;
    ui.pickQ = '';
    ui.pickCat = 'all';
    ui.pickSel = 0;
    warmProviders();
    render();
    setTimeout(function () {
      var s = root && root.querySelector('.whl-search');
      if (s) s.focus();
    }, 30);
  }

  /* ---- flyout creation + editing --------------------------------------- */

  /* Make slot i a flyout. `seed` (the pin already there, when converting)
     becomes child 1, and the bundle inherits its name so the wedge keeps
     reading the way it did — one action became a family of them. */
  function makeFly(i, seed) {
    var wh = cur();
    if (!wh) return;
    wh.slots[i] = normPin({
      fly: seed && !isFly(seed) ? [seed] : [],
      key: newId(),
      label: seed ? (seed.alias || seed.label || '') : '',
      icon: seed ? seed.icon : '',
    });
    save();
    render();
    openFlyEdit(i);
    toast(seed ? '“' + nameOf(seed) + '” is now a flyout — add more to it'
               : 'New flyout — search below to fill it');
  }

  function openFlyEdit(i) {
    ui.sheet = 'flyedit';
    ui.pickSlot = i;
    ui.flyArm = false;
    ui.pickQ = '';
    ui.pickCat = 'all';
    ui.pickSel = 0;
    ui.menu = null;
    ui.fly = null;
    warmProviders();
    render();
    focusSearch();
  }

  function addToFly(r) {
    var wh = cur();
    var p = wh && wh.slots[ui.pickSlot];
    if (!isFly(p)) return;
    if (p.fly.length >= MAX_FLY) {
      toast('That flyout is full (' + MAX_FLY + ') — remove one first');
      return;
    }
    var pin = pinFromItem(r.pv, r.it);
    for (var i = 0; i < p.fly.length; i++) {
      if (p.fly[i] && p.fly[i].prov === pin.prov && p.fly[i].key === pin.key) {
        toast('“' + (r.it.label || '') + '” is already in this flyout');
        return;
      }
    }
    p.fly.push(pin);
    save();
    wantIcons();
    render();
    focusSearch();
    toast('Added “' + (r.it.label || '') + '” — ' + p.fly.length + ' of ' + MAX_FLY);
  }

  /* The flyedit sheet's per-child buttons: reorder, one-click remove (the
     list is on screen and the search to re-add is directly below, so an armed
     two-step here would be ceremony), and "make it a wedge again" when one
     child is all that is left. */
  function fedAct(a, idx) {
    var wh = cur();
    var p = wh && wh.slots[ui.pickSlot];
    if (!isFly(p)) return;
    if (a === 'up' || a === 'down') {
      var j = idx + (a === 'up' ? -1 : 1);
      if (j < 0 || j >= p.fly.length) return;
      var t = p.fly[idx]; p.fly[idx] = p.fly[j]; p.fly[j] = t;
      save(); render();
      return;
    }
    if (a === 'del') {
      var gone = p.fly.splice(idx, 1)[0];
      save(); render();
      toast('Took “' + (gone ? nameOf(gone) : '') + '” out of the flyout');
      return;
    }
    if (a === 'one') {
      if (p.fly.length !== 1) return;
      wh.slots[ui.pickSlot] = p.fly[0];
      save();
      closeSheet();
      toast('Back to a single wedge — “' + nameOf(wh.slots[ui.pickSlot]) + '”');
      return;
    }
    if (a === 'delall') {
      if (!ui.flyArm) { ui.flyArm = true; render(); return; }
      wh.slots[ui.pickSlot] = null;
      ui.flyArm = false;
      save();
      closeSheet();
      toast('Flyout removed');
    }
  }

  function closeSheet() {
    ui.sheet = null;
    ui.rename = null;
    ui.flyArm = false;
    /* A capture left armed would eat the next keypress from a wheel that no
       longer shows any sign of listening. */
    ui.capKey = null;
    ui.capMsg = '';
    render();
  }

  /* Providers whose data only arrives on demand (spells, and our own
     inventory) need one nudge when a picker opens — the shelf does the same
     thing on its open. Cheap, once, never in a loop. */
  function warmProviders() {
    if (!window.HDOmni || typeof HDOmni.providers !== 'function') { toGame('whInv'); return; }
    try {
      HDOmni.providers().forEach(function (p) {
        if (typeof p.warm === 'function') { try { p.warm(); } catch (e) {} }
      });
    } catch (e) { toGame('whInv'); }
  }

  /* ---- the picker's categories -----------------------------------------
     Predicates over omni items, not a second registry: a provider the wheel
     has never heard of still shows up under "Everything else", which is what
     keeps this file from needing an edit when a pane lands. */
  var CATS = [
    { id: 'all', label: 'All' },
    { id: 'party', label: 'Party', test: function (it, pv) { return pv.id === 'followers'; } },
    { id: 'weapons', label: 'Weapons', test: function (it, pv) { return pv.id === 'inventory' && /weapon|ammo/i.test(it.kind || ''); } },
    { id: 'armour', label: 'Armour', test: function (it, pv) { return pv.id === 'inventory' && /armo/i.test(it.kind || ''); } },
    { id: 'usables', label: 'Usables', test: function (it, pv) { return pv.id === 'inventory' && /potion|food|scroll|ingredient/i.test(it.kind || ''); } },
    { id: 'misc', label: 'Misc', test: function (it, pv) { return pv.id === 'inventory' && /misc|soulgem|book|key/i.test(it.kind || ''); } },
    { id: 'outfits', label: 'Outfits', test: function (it, pv) { return pv.id === 'wardrobe'; } },
    { id: 'spells', label: 'Spells', test: function (it, pv) { return pv.id === 'spells'; } },
    { id: 'places', label: 'Places', test: function (it, pv) { return pv.id === 'domains' || pv.id === 'rooms' || pv.id === 'bases'; } },
    { id: 'deck', label: 'Deck', test: function (it, pv) {
        return pv.id === 'hotkeys' || pv.id === 'deck-actions' || pv.id === 'tabs' || pv.id === 'time';
      } },
  ];
  function catOf(it, pv) {
    for (var i = 1; i < CATS.length; i++) {
      try { if (CATS[i].test(it, pv)) return CATS[i]; } catch (e) {}
    }
    return null;
  }

  /* Everything pinnable, right now. Only items with a durable `pin` — an item
     without one cannot be re-resolved next session, so putting it on a wheel
     would be building a button that dies at the next load. */
  function pickables() {
    var out = [];
    if (!window.HDOmni || typeof HDOmni.providers !== 'function') return out;
    var provs = [];
    try { provs = HDOmni.providers() || []; } catch (e) { return out; }
    provs.forEach(function (pv) {
      var items = [];
      try { items = pv.index ? (pv.index() || []) : []; } catch (e) { items = []; }
      items.forEach(function (it) {
        if (!it || !it.pin) return;
        out.push({ pv: pv, it: it, cat: catOf(it, pv) });
      });
    });
    return out;
  }

  function matches(rec, q) {
    if (!q) return true;
    var hay = ((rec.it.label || '') + ' ' + (rec.it.detail || '') + ' ' +
      (rec.it.kind || '') + ' ' + (rec.it.keywords || '')).toLowerCase();
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
    return true;
  }

  /* Rank: label-prefix beats label-contains beats anything-else, then shorter
     labels first. Enter takes the top hit, so the ordering IS the feature. */
  function rank(rec, q) {
    if (!q) return 50;
    var l = String(rec.it.label || '').toLowerCase();
    var t = q.toLowerCase();
    if (l === t) return 0;
    if (l.indexOf(t) === 0) return 10;
    if (l.indexOf(t) !== -1) return 20;
    return 40;
  }

  function pickResults() {
    var q = ui.pickQ.trim();
    var all = pickables().filter(function (r) { return matches(r, q); });
    if (ui.pickCat !== 'all') {
      all = all.filter(function (r) { return r.cat && r.cat.id === ui.pickCat; });
    }
    all.sort(function (a, b) {
      var d = rank(a, q) - rank(b, q);
      if (d) return d;
      var la = String(a.it.label || ''), lb = String(b.it.label || '');
      if (la.length !== lb.length) return la.length - lb.length;
      return la.localeCompare(lb);
    });
    return all.slice(0, 200);
  }

  function hl(text, q) {
    text = String(text || '');
    var t = q.trim().toLowerCase();
    if (!t) return esc(text);
    var i = text.toLowerCase().indexOf(t);
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + '<b>' + esc(text.slice(i, i + t.length)) + '</b>' + esc(text.slice(i + t.length));
  }

  function renderSheet() {
    var old = root.querySelector('.whl-sheet');
    if (old) old.parentNode.removeChild(old);
    if (!ui.sheet) return;
    var sh = document.createElement('div');
    sh.className = 'whl-sheet';
    if (ui.sheet === 'pick') sh.innerHTML = pickHtml();
    else if (ui.sheet === 'flyedit') sh.innerHTML = flyEditHtml();
    else if (ui.sheet === 'settings') sh.innerHTML = settingsHtml();
    else if (ui.sheet === 'rename') sh.innerHTML = renameHtml();
    root.appendChild(sh);
    sh.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    wireSheet(sh);
  }

  function pickHtml() {
    var res = pickResults();
    var q = ui.pickQ.trim();
    var counts = {};
    pickables().filter(function (r) { return matches(r, q); }).forEach(function (r) {
      var id = r.cat ? r.cat.id : 'other';
      counts[id] = (counts[id] || 0) + 1;
      counts.all = (counts.all || 0) + 1;
    });
    var chips = CATS.map(function (c) {
      var n = counts[c.id] || 0;
      if (c.id !== 'all' && !n) return '';
      return '<div class="whl-chip' + (ui.pickCat === c.id ? ' on' : '') + '" data-cat="' + c.id + '">' +
        esc(c.label) + '<span class="n">' + n + '</span></div>';
    }).join('');

    var body;
    if (!res.length) {
      body = '<div class="whl-empty"><b>Nothing matches “' + esc(q) + '”</b>' +
        'Weapons, armour, potions and misc come from what you are CARRYING. ' +
        'Everything else — followers, outfits, spells, places, hotkeys — is whatever the deck knows about right now.</div>';
    } else {
      var lastGroup = '';
      body = res.map(function (r, i) {
        var g = r.pv.label || r.pv.id;
        var head = (g !== lastGroup) ? ('<div class="whl-group-h">' + esc(g) + '</div>') : '';
        lastGroup = g;
        var on = onAnyWheel(r.pv.id, String(r.it.pin));
        var url = safeIcon(r.it.icon) ||
          (r.pv.id === 'inventory' && r.it.snap
            ? meshIcon({ prov: 'inventory', snap: r.it.snap }) : '');
        var face = r.pv.id === 'followers';
        return head +
          '<div class="whl-res' + (i === ui.pickSel ? ' sel' : '') + (on ? ' on-wheel' : '') +
            '" data-r="' + i + '" title="' + esc((r.it.label || '') + (r.it.detail ? ' — ' + r.it.detail : '')) + '">' +
            '<div class="whl-res-art">' +
              (url ? '<img class="' + (face ? 'face' : '') + '" src="' + esc(url) + '" alt="">'
                   : glyphOf({ prov: r.pv.id, kind: r.it.kind })) +
            '</div>' +
            '<div class="whl-res-txt">' +
              '<div class="whl-res-name">' + hl(r.it.label, q) + '</div>' +
              (r.it.detail ? '<div class="whl-res-detail">' + esc(r.it.detail) + '</div>' : '') +
            '</div>' +
            '<div class="whl-res-kind">' + (on ? '✓ on a wheel' : esc(r.it.kind || r.pv.label || '')) + '</div>' +
          '</div>';
      }).join('');
    }

    var where = ui.pickSlot >= 0 ? ('slot ' + (ui.pickSlot + 1)) : 'the first free slot';
    return '<div class="whl-sheet-head">' +
        '<div class="whl-sheet-title">Add to ' + esc((cur() || {}).name || 'the wheel') + ' — ' + where + '</div>' +
        '<button class="whl-btn" data-act="sheet-close" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="whl-sheet-body">' +
        '<input class="whl-search" type="text" placeholder="Search everything — an item you carry, a follower, an outfit, a spell, a place…" ' +
          'autocomplete="off" spellcheck="false" value="' + esc(ui.pickQ) + '">' +
        '<div class="whl-chips">' + chips + '</div>' +
        '<div class="whl-results">' + body + '</div>' +
        '<div class="whl-newcc-row"><button class="whl-btn whl-newcc" data-act="newcc" ' +
          'title="Type any console command and put it straight on this wedge — one command per line, like a batch file">＞ New console command…</button></div>' +
      '</div>';
  }

  /* The flyout editor: what's inside (with pictures, reorderable, one-click
     remove) on top, and the SAME searchable picker below it to add more —
     "easy UI, typeable search bar to add, show icons" was the ask, verbatim.
     Enter takes the top hit and the sheet stays open, because filling a
     bundle is a run of adds, not one. */
  function flyEditHtml() {
    var wh = cur();
    var p = wh && wh.slots[ui.pickSlot];
    if (!isFly(p)) return '<div class="whl-sheet-head"><div class="whl-sheet-title">That flyout is gone</div>' +
      '<button class="whl-btn" data-act="sheet-close" title="Close (Esc)">✕</button></div>';

    var kids = p.fly.map(function (ch, i) {
      var url = ch ? artFor(ch) : '';
      var nm = ch ? nameOf(ch) : '';
      return '<div class="whl-fed" title="' + esc(nm + (ch && ch.detail ? ' — ' + ch.detail : '')) + '">' +
        '<div class="whl-fed-n">' + (i + 1) + '</div>' +
        '<div class="whl-res-art">' +
          (url ? '<img class="' + (ch && isFace(ch) ? 'face' : '') + '" src="' + esc(url) + '" alt="">'
               : (ch ? glyphOf(ch) : '＋')) +
        '</div>' +
        '<div class="whl-res-txt">' +
          '<div class="whl-res-name">' + esc(nm) + '</div>' +
          (ch && ch.detail ? '<div class="whl-res-detail">' + esc(ch.detail) + '</div>' : '') +
        '</div>' +
        '<button class="whl-btn whl-fed-b" data-fed="up" data-idx="' + i + '" ' +
          (i === 0 ? 'disabled ' : '') + 'title="Earlier in the fan">↑</button>' +
        '<button class="whl-btn whl-fed-b" data-fed="down" data-idx="' + i + '" ' +
          (i === p.fly.length - 1 ? 'disabled ' : '') + 'title="Later in the fan">↓</button>' +
        '<button class="whl-btn whl-fed-b whl-danger" data-fed="del" data-idx="' + i + '" ' +
          'title="Take it out of the flyout">✕</button>' +
        '</div>';
    }).join('');

    var res = pickResults();
    var q = ui.pickQ.trim();
    var body;
    if (!res.length) {
      body = '<div class="whl-empty"><b>Nothing matches “' + esc(q) + '”</b>' +
        'Anything a wedge can hold, a flyout can hold — items you carry, spells, followers, places, deck actions.</div>';
    } else {
      body = res.map(function (r, i) {
        var url = safeIcon(r.it.icon) ||
          (r.pv.id === 'inventory' && r.it.snap
            ? meshIcon({ prov: 'inventory', snap: r.it.snap }) : '');
        return '<div class="whl-res' + (i === ui.pickSel ? ' sel' : '') +
            '" data-r="' + i + '" title="' + esc((r.it.label || '') + (r.it.detail ? ' — ' + r.it.detail : '')) + '">' +
            '<div class="whl-res-art">' +
              (url ? '<img class="' + (r.pv.id === 'followers' ? 'face' : '') + '" src="' + esc(url) + '" alt="">'
                   : glyphOf({ prov: r.pv.id, kind: r.it.kind })) +
            '</div>' +
            '<div class="whl-res-txt">' +
              '<div class="whl-res-name">' + hl(r.it.label, q) + '</div>' +
              (r.it.detail ? '<div class="whl-res-detail">' + esc(r.it.detail) + '</div>' : '') +
            '</div>' +
            '<div class="whl-res-kind">' + esc(r.it.kind || r.pv.label || '') + '</div>' +
          '</div>';
      }).join('');
    }

    return '<div class="whl-sheet-head">' +
        '<div class="whl-sheet-title">⧉ Flyout — ' + esc(nameOf(p) || 'unnamed') + '</div>' +
        '<button class="whl-btn" data-act="sheet-close" title="Done (Esc)">✕</button>' +
      '</div>' +
      '<div class="whl-sheet-body">' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Name' +
            '<div class="whl-row-sub">What the wedge says on the ring.</div>' +
          '</div>' +
          '<input class="whl-input" data-act="flyname" type="text" value="' + esc(p.label) + '" maxlength="40" placeholder="Flyout">' +
        '</div>' +
        '<div class="whl-fed-head">Inside — ' + p.fly.length + ' of ' + MAX_FLY +
          '<span class="whl-fed-sub">Click the wedge to fan these out; click one (or press its number) to fire it.</span>' +
        '</div>' +
        (kids || '<div class="whl-fed-none">Nothing yet — search below and hit Enter to add.</div>') +
        '<div class="whl-fed-actions">' +
          (p.fly.length === 1
            ? '<button class="whl-btn" data-fed="one" data-idx="0" title="The one thing inside becomes the wedge again">Back to a single wedge</button>'
            : '') +
          '<button class="whl-btn whl-danger" data-fed="delall" data-idx="0" ' +
            'title="Remove the flyout and everything in it">' +
            (ui.flyArm ? 'Really remove it all' : '✕ Remove the flyout') + '</button>' +
        '</div>' +
        '<div class="whl-fed-head">Add something' +
          '<span class="whl-fed-sub">Enter adds the top hit and keeps the search open.</span>' +
        '</div>' +
        '<input class="whl-search" type="text" placeholder="Search everything — an item you carry, a spell, a follower, a place…" ' +
          'autocomplete="off" spellcheck="false" value="' + esc(ui.pickQ) + '">' +
        '<div class="whl-results whl-results-short">' + body + '</div>' +
        '<div class="whl-newcc-row"><button class="whl-btn whl-newcc" data-act="newcc" ' +
          'title="Type any console command and add it to this flyout — one command per line, like a batch file">＞ New console command…</button></div>' +
      '</div>';
  }

  /* A 3×3 map of the screen with a dot where that preset parks the wheel, its
     dot sized by the preset's scale. The point of a VISUAL preset picker is
     that you can see the answer without reading it. */
  function presetMap(p) {
    var cells = '';
    var col = (p.anchor === 'bl' || p.anchor === 'tl') ? 0 : (p.anchor === 'bc' || p.anchor === 'c') ? 1 : 2;
    var row = (p.anchor === 'tl' || p.anchor === 'tr') ? 0 : (p.anchor === 'c') ? 1 : 2;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        var on = (r === row && c === col);
        cells += '<div class="whl-pm-cell' + (on ? ' on' : '') + '">' +
          (on ? '<div class="whl-pm-dot" style="--pm:' + p.size + '"></div>' : '') + '</div>';
      }
    }
    return '<div class="whl-pm dim-' + p.dim + '">' + cells + '</div>';
  }

  function presetRowsHtml(activeId) {
    return PRESETS.map(function (p) {
      return '<div class="whl-preset' + (p.id === activeId ? ' on' : '') + '" data-preset="' + p.id + '" ' +
        'title="' + esc(p.note) + '">' +
        presetMap(p) +
        '<div class="whl-preset-txt">' +
          '<div class="whl-preset-name">' + esc(p.label) + '</div>' +
          '<div class="whl-preset-note">' + esc(p.note) + '</div>' +
        '</div>' +
        '<div class="whl-preset-meta">' + Math.round(p.size * 100) + '%<br>' +
          (p.dim === 'full' ? 'dimmed' : p.dim === 'light' ? 'see-through' : 'no dim') + '</div>' +
      '</div>';
    }).join('');
  }

  function settingsHtml() {
    var w = slice();
    var wh = w.wheels[w.active];
    var pct = Math.round(w.size * 100);
    var pid = currentPreset(w);
    var pcur = presetById(pid);
    return '<div class="whl-sheet-head">' +
        '<div class="whl-sheet-title">⚙ Wheel settings</div>' +
        '<button class="whl-btn" data-act="sheet-close" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="whl-sheet-body">' +
        '<div class="whl-row whl-row-preset">' +
          '<div class="whl-row-lab">Look &amp; placement' +
            '<div class="whl-row-sub">Where the wheel sits, how big it is and how much it dims the game — one pick. ' +
              'Press <b>V</b> in the wheel to flick through them without opening this.</div>' +
          '</div>' +
          '<button class="whl-dd" data-act="preset-toggle" title="Choose a visual preset">' +
            '<span class="whl-dd-lab">' + esc(pcur ? pcur.label : 'Custom') + '</span>' +
            '<span class="whl-dd-caret">' + (ui.presetOpen ? '▴' : '▾') + '</span>' +
          '</button>' +
        '</div>' +
        (ui.presetOpen
          ? '<div class="whl-presets">' + presetRowsHtml(pid) +
              (pid === 'custom'
                ? '<div class="whl-preset on" data-preset="custom" title="Your own mix of the three settings below">' +
                    presetMap({ anchor: w.anchor, size: w.size, dim: w.dim }) +
                    '<div class="whl-preset-txt">' +
                      '<div class="whl-preset-name">Custom</div>' +
                      '<div class="whl-preset-note">Your own mix — set by the three rows below.</div>' +
                    '</div>' +
                    '<div class="whl-preset-meta">' + pct + '%</div>' +
                  '</div>'
                : '') +
            '</div>'
          : '') +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Wheel size' +
            '<div class="whl-row-sub">How big the whole assembly draws. It is capped by your window, so it can never spill off-screen.</div>' +
          '</div>' +
          '<button class="whl-btn" data-act="size-" title="Smaller">−</button>' +
          '<div class="whl-val">' + pct + '%</div>' +
          '<button class="whl-btn" data-act="size+" title="Bigger">＋</button>' +
          '<button class="whl-btn" data-act="size0" title="Back to 100%">Reset</button>' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Where it sits' +
            '<div class="whl-row-sub">Nudge the preset without leaving it — anything you change here just flips the pick to Custom.</div>' +
          '</div>' +
          /* the order IS the layout: row 1 = top-left, centre, top-right;
             row 2 = bottom-left, bottom-centre, bottom-right */
          '<div class="whl-seg pos">' +
            [['tl', '◤'], ['c', '◉'], ['tr', '◥'], ['bl', '◣'], ['bc', '▼'], ['br', '◢']].map(function (a) {
              return '<button class="whl-segb' + (w.anchor === a[0] ? ' on' : '') + '" data-anchor="' + a[0] +
                '" title="' + esc(ANCHOR_NAME[a[0]]) + '">' + a[1] + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">How much it dims the game' +
            '<div class="whl-row-sub">Less dim keeps the fight visible; the wheel keeps its own dark pool underneath so it stays readable over snow or fire.</div>' +
          '</div>' +
          '<div class="whl-seg dim">' +
            [['full', 'Dimmed'], ['light', 'See-through'], ['none', 'None']].map(function (d) {
              return '<button class="whl-segb wide' + (w.dim === d[0] ? ' on' : '') + '" data-dim="' + d[0] +
                '" title="' + esc(DIM_NAME[d[0]]) + '">' + d[1] + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">How the key opens it' +
            '<div class="whl-row-sub">Press = tap to open, tap again to close. Hold = keep the key down, point at a wedge, ' +
              'and RELEASING fires it — one gesture, back to the game. A quick tap still opens it either way.</div>' +
          '</div>' +
          '<div class="whl-seg style">' +
            [['toggle', 'Press'], ['hold', 'Hold & release']].map(function (o) {
              return '<button class="whl-segb wide' + (w.openStyle === o[0] ? ' on' : '') + '" data-openstyle="' + o[0] +
                '" title="' + (o[0] === 'hold'
                  ? 'Hold the key down, aim, let go to fire what you are pointing at'
                  : 'The key opens the wheel and pressing it again closes it') + '">' + o[1] + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Slots on “' + esc(wh.name) + '”' +
            '<div class="whl-row-sub">' + MIN_SLOTS + '–' + MAX_SLOTS + '. Removing slots keeps every pin — it refuses rather than dropping one.</div>' +
          '</div>' +
          '<button class="whl-btn" data-act="slots-" title="One fewer slot">−</button>' +
          '<div class="whl-val">' + wh.slots.length + '</div>' +
          '<button class="whl-btn" data-act="slots+" title="One more slot">＋</button>' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Name of this wheel' +
            '<div class="whl-row-sub">Shown top-left, and on the tick you hover at the bottom right.</div>' +
          '</div>' +
          '<input class="whl-input" data-act="wname" type="text" value="' + esc(wh.name) + '" maxlength="40">' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Wheels' +
            '<div class="whl-row-sub">' + w.wheels.length + ' of ' + MAX_WHEELS +
              '. Cycle them with ← → , the mouse wheel, or the ticks at the bottom right.</div>' +
          '</div>' +
          '<button class="whl-btn" data-act="wheel-new" title="Add another wheel">＋ New wheel</button>' +
          '<button class="whl-btn whl-danger" data-act="wheel-del"' +
            (w.wheels.length < 2 ? ' disabled title="The last wheel cannot be deleted"' : ' title="Delete this wheel"') + '>' +
            (ui.rename === 'armed-del' ? 'Really delete “' + esc(wh.name) + '”' : '✕ Delete this wheel') +
          '</button>' +
        '</div>' +
        '<div class="whl-row whl-row-keys">' +
          '<div class="whl-row-lab">Keys inside the wheel' +
            '<div class="whl-row-sub">Each one is a shortcut for a button on the bar, so turning one off costs nothing. ' +
              '<b>Esc</b> (close), <b>1–9</b> (fire a slot) and <b>← →</b> (change wheel) are fixed — they are what the wheel IS, not preferences.</div>' +
          '</div>' +
        '</div>' +
        '<div class="whl-keys">' +
          KEYSPEC.map(function (s) {
            var k = keyOf(s.id);
            var capturing = ui.capKey === s.id;
            return '<div class="whl-key' + (capturing ? ' capturing' : '') + '">' +
              '<div class="whl-key-txt">' +
                '<div class="whl-key-lab">' + esc(s.label) + '</div>' +
                '<div class="whl-key-note">' + esc(s.note) + '</div>' +
              '</div>' +
              '<button class="whl-keychip' + (k ? '' : ' off') + '" data-bind="' + s.id + '" ' +
                'title="' + (capturing ? 'Press the key you want (Esc cancels)' : 'Click, then press the key you want') + '">' +
                (capturing ? 'press a key…' : esc(keyLabel(k))) +
              '</button>' +
              '<button class="whl-btn whl-keyoff" data-unbind="' + s.id + '" ' +
                (k ? '' : 'disabled ') + 'title="Turn this shortcut off — the button on the bar still works">✕</button>' +
            '</div>';
          }).join('') +
          (ui.capMsg ? '<div class="whl-key-msg">' + esc(ui.capMsg) + '</div>' : '') +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Opening the wheel' +
            '<div class="whl-row-sub">Ctrl + your deck key (F7) by default. It is also a bindable deck action — “Wheel Menu” in the Utilities tab — so you can give it any key, or a mouse button.</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renameHtml() {
    var wh = cur();
    var p = wh && wh.slots[ui.pickSlot];
    var nm = p ? (p.alias || p.label || '') : '';
    return '<div class="whl-sheet-head">' +
        '<div class="whl-sheet-title">Rename on the wheel</div>' +
        '<button class="whl-btn" data-act="sheet-close" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="whl-sheet-body">' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab">Label' +
            '<div class="whl-row-sub">Your own name for this wedge. The real thing keeps its name — clear the box to go back to it.</div>' +
          '</div>' +
          '<input class="whl-input" data-act="alias" type="text" value="' + esc(nm) + '" maxlength="40">' +
        '</div>' +
        '<div class="whl-row">' +
          '<div class="whl-row-lab"></div>' +
          '<button class="whl-btn" data-act="alias-ok">Save</button>' +
        '</div>' +
      '</div>';
  }

  function wireSheet(sh) {
    sh.addEventListener('click', function (e) {
      var b = closestSel(e.target, '[data-act]');
      if (b) { e.stopPropagation(); sheetAct(b.getAttribute('data-act'), sh); return; }
      var chip = closestSel(e.target, '.whl-chip');
      if (chip) {
        e.stopPropagation();
        ui.pickCat = chip.getAttribute('data-cat');
        ui.pickSel = 0;
        render();
        focusSearch();
        return;
      }
      var bind = closestSel(e.target, '[data-bind]');
      if (bind) {
        e.stopPropagation();
        ui.capKey = bind.getAttribute('data-bind');
        ui.capMsg = '';
        render();
        return;
      }
      var unbind = closestSel(e.target, '[data-unbind]');
      if (unbind) {
        e.stopPropagation();
        var uid = unbind.getAttribute('data-unbind');
        var w4 = slice();
        if (!w4.keys || typeof w4.keys !== 'object') w4.keys = {};
        w4.keys[uid] = '';                     // '' = off, and slice() keeps it
        ui.capKey = null;
        ui.capMsg = '“' + ((specOf(uid) || {}).label || uid) + '” has no key now — use the button on the bar';
        save();
        render();
        return;
      }
      var pre = closestSel(e.target, '[data-preset]');
      if (pre) {
        e.stopPropagation();
        var id = pre.getAttribute('data-preset');
        if (id !== 'custom') { applyPreset(id); ui.presetOpen = false; }
        ui.sheet = 'settings';
        render();
        return;
      }
      var osb = closestSel(e.target, '[data-openstyle]');
      if (osb) {
        e.stopPropagation();
        var w5 = slice();
        w5.openStyle = osb.getAttribute('data-openstyle') === 'hold' ? 'hold' : 'toggle';
        save();
        render();
        return;
      }
      var anc = closestSel(e.target, '[data-anchor]');
      if (anc) {
        e.stopPropagation();
        var w2 = slice();
        w2.anchor = anc.getAttribute('data-anchor');
        save();
        render();
        return;
      }
      var dm = closestSel(e.target, '[data-dim]');
      if (dm) {
        e.stopPropagation();
        var w3 = slice();
        w3.dim = dm.getAttribute('data-dim');
        save();
        render();
        return;
      }
      var fed = closestSel(e.target, '[data-fed]');
      if (fed) {
        e.stopPropagation();
        if (fed.hasAttribute('disabled')) return;
        fedAct(fed.getAttribute('data-fed'), parseInt(fed.getAttribute('data-idx'), 10) || 0);
        return;
      }
      var res = closestSel(e.target, '.whl-res');
      if (res) {
        e.stopPropagation();
        takeResult(parseInt(res.getAttribute('data-r'), 10));
      }
    });
    var s = sh.querySelector('.whl-search');
    if (s) {
      s.addEventListener('input', function (e) {
        ui.pickQ = e.target.value;
        ui.pickSel = 0;
        var caret = e.target.selectionStart;
        render();
        var s2 = root.querySelector('.whl-search');
        if (s2) { s2.focus(); try { s2.setSelectionRange(caret, caret); } catch (er) {} }
      });
    }
    var fn = sh.querySelector('[data-act="flyname"]');
    if (fn) {
      fn.addEventListener('input', function (e) {
        var wh = cur();
        var p = wh && wh.slots[ui.pickSlot];
        if (!isFly(p)) return;
        p.label = String(e.target.value || '').slice(0, 40);
        save();
        /* the ring repaints on close — a full render() here would rebuild the
           sheet and steal the caret, the exact trap the wname input avoids */
      });
    }
    var nm = sh.querySelector('[data-act="wname"]');
    if (nm) {
      nm.addEventListener('input', function (e) {
        var wh = cur();
        if (!wh) return;
        wh.name = String(e.target.value || '').slice(0, 40);
        save();
        root.querySelector('.whl-wname').textContent = wh.name || '(unnamed)';
      });
    }
  }

  function focusSearch() {
    setTimeout(function () {
      var s = root && root.querySelector('.whl-search');
      if (s) s.focus();
    }, 10);
  }

  /* "＞ New console command…" from the pick / flyedit sheets: the deck's own
     console editor (app.js) opens ON TOP of the wheel, and the entry it makes
     is pinned exactly where the user was standing — the slot being filled, or
     the bundle being edited. The editor is a real deck entry factory, so the
     new command also shows up in the palette, the Hotbar picker and Omni. */
  function newConsoleFromSheet() {
    if (typeof window.openConsoleEditor !== 'function') {
      toast('The console editor isn’t available in this build');
      return;
    }
    var mode = ui.sheet;          // 'pick' | 'flyedit' — captured now, used at onDone
    var slot = ui.pickSlot;
    window.openConsoleEditor(null, null, { onDone: function (en) {
      var pv = { id: 'hotkeys' };
      try {
        if (window.HDOmni && typeof HDOmni.providers === 'function')
          HDOmni.providers().forEach(function (p) { if (p && p.id === 'hotkeys') pv = p; });
      } catch (err) {}
      var item = { label: en.name, detail: en.desc || '', kind: 'hotkey',
                   pin: 'hk:' + en.id, icon: '' };
      if (mode === 'flyedit') {
        var wh = cur();
        var p = wh && wh.slots[slot];
        if (!isFly(p)) return;
        if (p.fly.length >= MAX_FLY) { toast('That flyout is full (' + MAX_FLY + ')'); return; }
        p.fly.push(pinFromItem(pv, item));
        save();
        render();
        toast('“' + en.name + '” added to the flyout');
        return;
      }
      if (place(pv, item, slot))
        closeSheet();
    } });
  }

  function sheetAct(a, sh) {
    var w = slice();
    if (a === 'sheet-close') { closeSheet(); return; }
    if (a === 'newcc') { newConsoleFromSheet(); return; }
    if (a === 'preset-toggle') { ui.presetOpen = !ui.presetOpen; render(); return; }
    if (a === 'size-') { w.size = clamp(+(w.size - SIZE_STEP).toFixed(2), SIZE_MIN, SIZE_MAX); save(); render(); return; }
    if (a === 'size+') { w.size = clamp(+(w.size + SIZE_STEP).toFixed(2), SIZE_MIN, SIZE_MAX); save(); render(); return; }
    if (a === 'size0') { w.size = 1; save(); render(); return; }
    if (a === 'slots-') { setSlotCount(cur().slots.length - 1); if (ui.sheet) render(); return; }
    if (a === 'slots+') { setSlotCount(cur().slots.length + 1); if (ui.sheet) render(); return; }
    if (a === 'wheel-new') { addWheel(); ui.sheet = 'settings'; render(); return; }
    if (a === 'wheel-del') {
      if (w.wheels.length < 2) return;
      if (ui.rename !== 'armed-del') { ui.rename = 'armed-del'; render(); return; }
      var nm = w.wheels[w.active].name;
      w.wheels.splice(w.active, 1);
      w.active = clamp(w.active, 0, w.wheels.length - 1);
      ui.rename = null;
      ui.sel = -1;
      save();
      render();
      toast('Deleted “' + nm + '”');
      return;
    }
    if (a === 'alias-ok') {
      var inp = sh.querySelector('[data-act="alias"]');
      var wh = cur();
      var p = wh && wh.slots[ui.pickSlot];
      if (p && inp) {
        var v = String(inp.value || '').trim().slice(0, 40);
        p.alias = (v && v !== p.label) ? v : '';
        save();
      }
      closeSheet();
    }
  }

  function takeResult(i) {
    var res = pickResults();
    var r = res[i];
    if (!r) return;
    /* The flyedit sheet reuses the picker's results wholesale — a take there
       lands in the BUNDLE, and the sheet stays open for the next one. */
    if (ui.sheet === 'flyedit') { addToFly(r); return; }
    if (place(r.pv, r.it, ui.pickSlot)) {
      /* Straight back to the wheel — one add is the common case, and landing
         back on the ring shows you WHERE it went. Hold the picker open with
         Shift for a run of adds. */
      if (!ui.keepPicker) { closeSheet(); return; }
      ui.pickSlot = -1;
      render();
      focusSearch();
    }
  }

  /* ---------------------------------------------------------------- keys */
  /* Called by app.js's key handler while the wheel owns the screen. Returns
     true when the key was ours, so the deck never also acts on it. */
  function onKey(e) {
    if (!ui.open) return false;
    /* The deck's console editor is open ON TOP of the wheel (the "new console
       command" flow): every key belongs to its inputs. Claim the key so
       neither the wheel nor the deck acts on it — without preventDefault, so
       it still types into the editor's fields. */
    if (document.getElementById('console-picker-backdrop')) return true;
    var k = e.key;
    /* A rebind is listening: this press IS the binding, so it must be caught
       ahead of everything — including the sheet's own Esc — or pressing "S"
       to bind Settings would instead open Settings. Esc cancels the capture
       rather than binding Escape. */
    if (ui.capKey) {
      e.preventDefault();
      var id = ui.capKey;
      ui.capKey = null;
      if (k === 'Escape') { ui.capMsg = 'Rebind cancelled'; render(); return true; }
      ui.capMsg = bindKey(id, k) || ('“' + (specOf(id) || {}).label + '” is now ' + keyLabel(k));
      render();
      return true;
    }
    if (ui.sheet) {
      if (k === 'Escape') { e.preventDefault(); closeSheet(); return true; }
      /* flyedit shares the picker's whole keyboard: same results list, same
         arrows, same Enter-takes-the-top-hit. */
      if (ui.sheet !== 'pick' && ui.sheet !== 'flyedit') return false;
      var res = pickResults();
      if (k === 'ArrowDown') { e.preventDefault(); ui.pickSel = Math.min(ui.pickSel + 1, res.length - 1); render(); focusSearch(); return true; }
      if (k === 'ArrowUp') { e.preventDefault(); ui.pickSel = Math.max(ui.pickSel - 1, 0); render(); focusSearch(); return true; }
      if (k === 'Enter') {
        e.preventDefault();
        ui.keepPicker = !!e.shiftKey;
        takeResult(ui.pickSel);
        ui.keepPicker = false;
        return true;
      }
      if (k === 'Tab') {
        e.preventDefault();
        var ids = CATS.map(function (c) { return c.id; });
        var at = ids.indexOf(ui.pickCat);
        ui.pickCat = ids[(at + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
        ui.pickSel = 0;
        render();
        focusSearch();
        return true;
      }
      return false;
    }
    if (ui.menu && k === 'Escape') { e.preventDefault(); ui.menu = null; renderMenu(); return true; }
    /* Esc closes the Look panel before it closes the wheel — dismissing an
       overlay should never also end the thing underneath it. */
    if (ui.lookOpen && k === 'Escape') { e.preventDefault(); ui.lookOpen = false; render(); return true; }
    /* An open fan: its numbers fire ITS children, and Esc folds it up rather
       than closing the wheel — same overlay-first rule as the Look panel. */
    if (ui.fly) {
      if (k === 'Escape') { e.preventDefault(); closeFly(); return true; }
      if (k >= '1' && k <= '9') {
        var fwh = cur();
        var fp = fwh && fwh.slots[ui.fly.slot];
        var fk = parseInt(k, 10) - 1;
        if (isFly(fp) && fk < fp.fly.length) { e.preventDefault(); fireFlyChild(fk); return true; }
      }
      return false;
    }
    if (k === 'Escape') { e.preventDefault(); close(true); return true; }
    if (k === 'ArrowLeft') { e.preventDefault(); cycleWheel(-1); return true; }
    if (k === 'ArrowRight') { e.preventDefault(); cycleWheel(1); return true; }
    /* The four letter shortcuts are BOUND, not literal — see KEYSPEC. Each is
       a shortcut for a button that is already on the bar, so a binding turned
       off costs nothing but a click. */
    var act = actionForKey(k);
    if (act === 'edit') { e.preventDefault(); ui.edit = !ui.edit; ui.lookOpen = false; render(); return true; }
    if (act === 'add') { e.preventDefault(); openPicker(-1); return true; }
    if (act === 'settings') { e.preventDefault(); ui.lookOpen = false; ui.sheet = 'settings'; render(); return true; }
    if (act === 'look') {
      /* steps to the next preset; the ◱ button opens the full list */
      e.preventDefault();
      var w = slice();
      var at = currentPreset(w);
      var i = -1;
      for (var z = 0; z < PRESETS.length; z++) if (PRESETS[z].id === at) i = z;
      applyPreset(PRESETS[(i + 1 + PRESETS.length) % PRESETS.length].id);
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && ui.sel >= 0) {
      e.preventDefault();
      /* One keypress may clear one pin, but not a whole bundle — a filled
         flyout goes through the armed remove in its menu or its editor. */
      var dp = cur() && cur().slots[ui.sel];
      if (isFly(dp) && dp.fly.length) {
        toast('That is a flyout with ' + dp.fly.length + ' inside — right-click it to remove it');
        return true;
      }
      clearSlot(ui.sel);
      return true;
    }
    if (k >= '1' && k <= '9') {
      var idx = parseInt(k, 10) - 1;
      var wh = cur();
      if (wh && idx < wh.slots.length) { e.preventDefault(); fire(idx); return true; }
    }
    return false;
  }

  /* --------------------------------------------------------- open / close */

  function open(standalone) {
    ensureDom();
    ui.open = true;
    ui.openedAt = Date.now();
    ui.standalone = !!standalone;
    ui.sel = -1;
    ui.edit = false;
    ui.sheet = null;
    ui.menu = null;
    ui.fly = null;
    ui.lookOpen = false;      // a fresh wheel must not come up with a panel showing
    document.body.classList.add('whl-open');
    slice();
    /* The pictures are the point — ask for the renders the moment it opens, so
       a wheel filled last session comes up with art rather than glyphs. */
    wantIcons();
    toGame('whInv');
    render();
  }

  /* closeDeck=true also closes the palette (the wheel was the whole errand);
     false leaves the deck open behind it (we are handing over to a tab). */
  function close(closeDeck) {
    if (!ui.open) return;
    ui.open = false;
    ui.sheet = null;
    ui.menu = null;
    ui.fly = null;
    ui.sel = -1;
    document.body.classList.remove('whl-open');
    if (root) { root.classList.remove('has-sel'); root.classList.remove('has-fly'); }
    if (closeDeck && ui.standalone && env && typeof env.closeDeck === 'function') env.closeDeck();
    ui.standalone = false;
  }

  function toggle(standalone) {
    if (ui.open) close(true); else open(standalone);
  }

  /* ---- hold-to-release (openStyle 'hold') ------------------------------ */
  /* C++ pushes hdWheelKeyUp() when the key that OPENED the wheel comes back
     up. In hold mode that release IS the pick: fire whatever the cursor
     points at, or fold up pointing at nothing. Guards, in order:
       - toggle mode / wheel closed: the release means nothing;
       - a sheet, menu, edit mode or an open fan: the player has moved from
         "gesture" to "browsing" — the wheel stays up and mouse rules apply;
       - a quick TAP (released inside 300 ms, nothing selected): stay open.
         Without this, hold mode would punish the muscle memory of tapping
         the key, and the two styles would fight instead of blending. */
  function onOpenKeyRelease() {
    var w = slice();
    if (!w || w.openStyle !== 'hold' || !ui.open) return;
    if (ui.sheet || ui.menu || ui.edit || ui.fly || ui.lookOpen) return;
    if (ui.sel >= 0) { fire(ui.sel); return; }
    if (Date.now() - (ui.openedAt || 0) < 300) return;   // a tap — stay open
    close(true);
  }
  window.hdWheelKeyUp = function () { try { onOpenKeyRelease(); } catch (e) {} };

  /* ------------------------------------------------------ game callbacks */

  /* The player's own carryables, from C++ (`whInv`). Parse-time global for the
     same reason as the other panes': a push can land before init. */
  var inv = { items: [], at: 0 };
  window.whInvList = function (payload) {
    try {
      var j = typeof payload === 'string' ? JSON.parse(payload) : payload;
      inv.items = (j && Array.isArray(j.items)) ? j.items : [];
      inv.at = Date.now();
    } catch (e) { inv.items = []; }
    if (ui.open) render();
  };

  /* The equip toggle answered. C++ already put the message on screen (and the
     spell's new state is the engine's truth, not ours) — this only repaints,
     so a wedge you just equipped reads as equipped straight away. */
  window.hdOmniEquipped = function () { if (ui.open) render(); };

  /* A render batch landed — repaint so glyphs upgrade to real pictures in
     place. Cheap and bounded: only while the wheel is actually on screen. */
  try {
    document.addEventListener('hd-item-icons', function () { if (ui.open) render(); });
  } catch (e) { /* no DOM yet in some harnesses */ }

  /* ---------------------------------------------- the inventory provider */
  /* Registered with OMNI, not kept private: your gear should be findable from
     Ctrl+F too, and registering means the wheel's picker gets it for free
     through exactly the same path as everything else. */

  var KIND_LABEL = {
    weapon: 'weapon', armor: 'armour', ammo: 'ammo', potion: 'potion', food: 'food',
    scroll: 'scroll', ingredient: 'ingredient', soulgem: 'soul gem', book: 'book',
    key: 'key', misc: 'misc',
  };

  function invItems() {
    return (inv.items || []).map(function (it) {
      var kind = String(it.kind || 'misc').toLowerCase();
      var bits = [];
      if (it.count > 1) bits.push('×' + it.count);
      if (it.slot) bits.push(it.slot);
      if (it.dmg) bits.push(it.dmg + ' dmg');
      if (it.armor) bits.push(it.armor + ' armour');
      if (it.value) bits.push(it.value + ' gold');
      if (it.equipped) bits.push('equipped');
      return {
        label: String(it.name || '(unnamed)'),
        detail: bits.join(' · '),
        kind: KIND_LABEL[kind] || kind,
        keywords: String(it.plugin || ''),
        /* plugin + LOCAL id: an ESL's runtime FormID shifts with load order,
           so the durable identity is the pair, never the runtime id
           ([[esl-runtime-formids-shift-with-load-order]]). */
        pin: 'inv:' + String(it.plugin || '').toLowerCase() + ':' + String(it.formId || '').toUpperCase(),
        snap: { formId: it.formId, plugin: it.plugin, name: it.name, kind: kind },
        run: function () { useItem(it.formId, it.plugin, kind); },
      };
    });
  }

  function useItem(formId, plugin, kind) {
    toGame('whAct', JSON.stringify({ op: 'use', formId: formId, plugin: plugin, kind: kind }));
  }

  if (window.HDOmni && typeof HDOmni.register === 'function') {
    HDOmni.register({
      id: 'inventory', label: 'What you are carrying', tab: '',
      warm: function () { toGame('whInv'); },
      /* Fired from a snapshot when the live read has not landed yet (or the
         item genuinely left the bag — C++ answers honestly either way, which
         is better than the wheel guessing). */
      pinRun: function (snap) {
        if (!snap || !snap.formId) return;
        useItem(snap.formId, snap.plugin, snap.kind);
      },
      index: invItems,
    });
  }

  /* ------------------------------------------------------------- exports */

  return {
    hookInto: function (e) { env = e; },
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return ui.open; },
    onKey: onKey,
    render: render,
    /* hdClosed teardown — the overlay hangs off document.body, so `body.open`
       going away does NOT take it with it: without this the next F7 would
       greet you with last session's wheel over the deck, eating every click. */
    onDeckClosed: function () { close(false); },
    /* test seams */
    _ui: ui,
    _slice: slice,
    _preset: applyPreset,
    _currentPreset: currentPreset,
    _keyOf: keyOf,
    _bindKey: bindKey,
    _keySpec: function () { return KEYSPEC.slice(); },
    _presetIds: function () { return PRESETS.map(function (p) { return p.id; }); },
    _stageAt: stageAt,
    _slotAt: slotAt,
    _fitRadius: fitRadius,
    _pickResults: pickResults,
    _place: place,
    _setSlotCount: setSlotCount,
    _isFly: isFly,
    _makeFly: makeFly,
    _addToFly: addToFly,
    _openFly: openFly,
    _closeFly: closeFly,
    _fireFlyChild: fireFlyChild,
    _fedAct: fedAct,
    _normPin: normPin,
    _maxFly: MAX_FLY,
    _onOpenKeyRelease: onOpenKeyRelease,
    _inv: function (list) { window.whInvList(JSON.stringify({ items: list })); },
  };
})();
