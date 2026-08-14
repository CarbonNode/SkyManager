'use strict';

/* ====================================================================== *
 *  Home — the deck's landing page (Rober, 2026-08-05).
 *
 *  Instead of hunting the tab strip: a card per system + a universal search
 *  that opens Omni over everything. It is the DEFAULT tab the deck opens to
 *  (but the "land on the tab you closed on" memory still wins over it), and
 *  the old Recent tab is folded into a collapsed drawer below the cards.
 *
 *  Self-contained like the other panes: owns its DOM (hm- prefixed), never
 *  touches app.js `state`. It reaches the deck through a small host contract
 *  (setTab / toGame / openOmni / hotkeyCount), handed in via hookInto — the
 *  same pattern HDOmni and HDShelf use. Counts come from the LIVE Omni
 *  provider registry, so a card's number is whatever that system holds right
 *  now, with zero new bridges.
 *
 *  Edit mode (F2 / the ⚙ Edit button — Rober, 2026-08-12: "edit on homepage
 *  does nothing… maybe should allow you to rearrange the systems"). toggleEdit()
 *  flips a local editing flag: the grid grows a grip per card and cards become
 *  pointer-draggable to REORDER (Ultralight has no HTML5 DnD, so this rides the
 *  shared PDrag/pdScan engine in app.js, exactly like Domains/Followers). The
 *  order PERSISTS through the host as state.shelf.home.order — a RAW json blob
 *  C++ round-trips untouched, the same trick tabbarPrefs() uses, because a
 *  brand-new `settings` key would be dropped field-by-field on the save round-
 *  trip. A missing/unknown system in the stored order is tolerated: sanitizeOrder
 *  keeps the known ids in their saved order and APPENDS any card the store never
 *  heard of, so a newly-added system always shows (at the end) rather than
 *  vanishing.
 *
 *  Host contract (mirrors the other panes): HomePane.init() · onShow() ·
 *  onHide() · hookInto(host) · receiveRecent(payload) · toggleEdit().
 *  Two OPTIONAL host hooks power the reorder & the completeness audit:
 *    getHomeOrder() -> string[]  · setHomeOrder(string[])  (shelf-blob backed)
 *    sysTabs()      -> string[]  (the app's SYS_TABS ids, for the dev audit)
 *  Two more surface the open-key rebind on Home (home-open-key):
 *    getOpenKey()   -> label string  · startOpenKeyPicker() (reuses app.js's
 *    own startCapture('open') — press-to-rebind + the pick-from-list button)
 * ====================================================================== */

window.HomePane = (function () {

  var DEV = location.search.indexOf('dev=1') !== -1;
  var SELFTEST = location.search.indexOf('selftest=1') !== -1;

  /* Every system, in grid order. `act`: how a click navigates —
       'tab'    setTab(id) (the default)
       'spells' the Spell Deck is a separate PrismaUI view, opened via a launcher
       'ask'    open Omni straight in Ask mode
     `prov` (optional): an Omni provider id whose live index length becomes the
     card's count. `hk` marks the Hotkeys card, counted from the host. */
  /* `img` is the gold-glyph icon (icons/custom/hm-*.png, generated from the
     skyrim-deck-gold-glyph Forge prompt + icon_knockout). PLAIN path, no ?v=
     query — Ultralight drops the query and fails the load. `icon` is the emoji
     fallback if the PNG ever 404s (remove-on-error in renderCards). */
  var SYSTEMS = [
    { id: 'all',       name: 'Hotkeys',    icon: '⌨',  img: 'icons/custom/hm-hotkeys.png',   hue: '#c9a24b', sub: 'Your keybind palette',        act: 'tab', hk: true },
    { id: 'spells',    name: 'Spell Deck', icon: '✦',  img: 'icons/custom/hm-spells.png',    hue: '#8fb8ff', sub: 'Cast, equip & combos',        act: 'spells' },
    { id: 'followers', name: 'Followers',  icon: '👥', img: 'icons/custom/hm-followers.png', hue: '#e0a86a', sub: 'Summon, order, dress',        act: 'tab', prov: 'followers', requires: 'followerorganizer' },
    { id: 'quests',    name: 'Quests',     icon: '❈',  img: 'icons/custom/hm-quests.png',    hue: '#c9a24b', sub: 'Inspect & repair any quest',  act: 'tab' },
    { id: 'domains',   name: 'Domains',    icon: '📍', img: 'icons/custom/hm-domains.png',   hue: '#8fd8a0', sub: 'Mark a spot, click to travel',act: 'tab', prov: 'domains' },
    { id: 'containers',name: 'Containers', icon: '📦', img: 'icons/custom/hm-containers.png',hue: '#c9a24b', sub: 'Mark a chest, open it anywhere',act: 'tab', prov: 'containers' },
    { id: 'rooms',     name: 'Rooms',      icon: '🚪', img: 'icons/custom/hm-rooms.png',     hue: '#b79bff', sub: 'Claim a room, keep it yours', act: 'tab', prov: 'rooms' },
    { id: 'loot',      name: 'Loot',       icon: '✨', img: 'icons/custom/hm-loot.png',      hue: '#ffd36a', sub: 'Glow the loot worth grabbing',act: 'tab' },
    { id: 'keys',      name: 'Keys',       icon: '🗝', img: 'icons/custom/hm-keys.png',      hue: '#c9a24b', sub: 'Every hotkey in the load order',act: 'tab' },
    /* Items + NPCs merged into ONE Finder tab (2026-08-14) — setTab('finder')
       resolves to whichever roster was used last; the pane's own switch flips */
    { id: 'finder',    name: 'Finder',     icon: '⌕',  img: 'icons/custom/hm-finder.png',    hue: '#ffd36a', sub: 'Any item, anyone — take, bring, spawn', act: 'tab' },
    { id: 'anim',      name: 'Animations', icon: '🩰', img: 'icons/custom/hm-anim.png',      hue: '#e58fb0', sub: 'Apply a ZaZ animation',        act: 'tab', requires: 'zap' },
    { id: 'finances',  name: 'Finances',   icon: '⚖',  img: 'icons/custom/hm-finances.png',  hue: '#d0c07a', sub: 'Ledger, market & settle',     act: 'tab', prov: 'finances' },
    { id: 'wardrobe',  name: 'Wardrobe',   icon: '👗', img: 'icons/custom/hm-wardrobe.png',  hue: '#e58fb0', sub: 'Outfits & who dresses whom',  act: 'tab', prov: 'wardrobe', requires: 'soes' },
    { id: 'faces',     name: 'Faces',      icon: '🙂', img: 'icons/custom/hm-faces.png',     hue: '#8fd8ff', sub: 'Browse & apply RaceMenu presets', act: 'tab', requires: 'presetdirector' },
    { id: 'numpad',    name: 'Numpad',     icon: '⌗',  img: 'icons/custom/hm-numpad.png',    hue: '#a49d8c', sub: 'Live on-screen keypad',        act: 'tab' },
    { id: 'ask',       name: 'Ask (CHIM)', icon: '🧠', img: 'icons/custom/hm-ask.png',       hue: '#b79bff', sub: 'Ask anything about anyone',    act: 'ask', requires: 'chim' },
  ];

  /* recent source glyphs (mirrors app.js RC_SOURCE, kept local so the drawer
     is self-contained) */
  var RC_IC = { entry: '⌨', action: '⚙', spell: '✦', ask: '🧠', quest: '❈', follower: '👥' };

  /* Time drawer — the compact wait control (Time is off the tab strip now).
     Same tm bridge TimePane uses: tmGet -> tmInfo, tmWait(hours) -> tmResult. */
  var MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed',
    'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];

  var host = { setTab: null, toGame: null, openOmni: null, hotkeyCount: null,
               getNotes: null, setNotes: null, getHomeOrder: null, setHomeOrder: null,
               sysTabs: null, detected: null,
               /* Open-key discoverability (home-open-key): getOpenKey() -> label
                  string, startOpenKeyPicker() reuses app.js's own rebind flow. */
               getOpenKey: null, startOpenKeyPicker: null };
  var recent = { items: [], count: 0, max: 0 };
  var timeCur = null;   // last tmInfo {hour,day,month,year}
  /* live on/off for the on-screen UI elements, filled by chained receivers.
     null = "not asked / not queryable yet" (render the row without a chip). */
  var uie = { hud: null, loot: null };
  var ui = { inited: false, recentOpen: false, notesOpen: false, timeOpen: false,
             uieOpen: false, tmChained: false, uieChained: false,
             notesT: null, editing: false, dragId: null };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* -------------------------------------------------------- live counts -- */
  function countFor(sys) {
    if (sys.hk && typeof host.hotkeyCount === 'function') {
      try { var n = host.hotkeyCount(); return n > 0 ? String(n) : ''; } catch (e) {}
    }
    if (sys.prov && window.HDOmni && HDOmni.providerById) {
      try {
        var p = HDOmni.providerById(sys.prov);
        if (p && typeof p.index === 'function') {
          var len = (p.index() || []).length;
          return len > 0 ? String(len) : '';
        }
      } catch (e) {}
    }
    return '';
  }

  /* ------------------------------------------------------- card order -- */
  var byId = {};
  SYSTEMS.forEach(function (s) { byId[s.id] = s; });

  /* Return a stored order array of card ids, keeping the KNOWN ids in their
     saved sequence and APPENDING every card the store never heard of (a newly
     added system, or one the user hasn't reordered yet). Unknown/stale ids in
     the store are dropped. This is the "new systems must appear even if not in
     the stored order" tolerance. */
  function sanitizeOrder(stored) {
    var out = [], seen = {};
    if (Array.isArray(stored)) {
      stored.forEach(function (id) {
        if (byId[id] && !seen[id]) { out.push(id); seen[id] = true; }
      });
    }
    SYSTEMS.forEach(function (s) { if (!seen[s.id]) { out.push(s.id); seen[s.id] = true; } });
    return out;
  }

  /* the systems in the order they should render right now */
  /* A card with `requires` hides only when the host's detection flags say
     that integration is EXPLICITLY absent — unknown/missing flags mean show
     (an older DLL sends none, and blanking the grid on that would be worse
     than a dead card). Gates: Ask (chim), Followers (followerorganizer),
     Animations (zap), Wardrobe (soes), Faces (presetdirector) — the same
     tabs SYS_TABS/app.js hides from the bar (2026-08-12 gate sweep). */
  function detectedGate(sys) {
    if (!sys || !sys.requires) return true;
    var det = null;
    if (typeof host.detected === 'function') {
      try { det = host.detected(); } catch (e) {}
    }
    if (!det || !(sys.requires in det)) return true;
    return det[sys.requires] !== false;
  }

  function orderedSystems() {
    var stored = null;
    if (typeof host.getHomeOrder === 'function') {
      try { stored = host.getHomeOrder(); } catch (e) {}
    }
    return sanitizeOrder(stored).map(function (id) { return byId[id]; })
      .filter(detectedGate);
  }

  function persistOrder(ids) {
    if (typeof host.setHomeOrder === 'function') {
      try { host.setHomeOrder(sanitizeOrder(ids)); } catch (e) {}
    }
  }

  /* DEV audit — flag any SYS_TAB the Home grid forgot to carry, so a system
     added to app.js's SYS_TABS is caught the day it lands (Task 2). Home also
     carries fixed extras (Hotkeys/Spells/Numpad/Ask) that are NOT SYS_TABS —
     those are expected, so the audit is one-directional. */
  function auditSystems() {
    if (typeof host.sysTabs !== 'function') return [];
    var tabs = [];
    try { tabs = host.sysTabs() || []; } catch (e) { return []; }
    var missing = tabs.filter(function (t) { return !byId[t]; });
    if (missing.length && (DEV || SELFTEST))
      console.log('[home] SYS_TABS missing from Home grid: ' + missing.join(', '));
    return missing;
  }

  /* ------------------------------------------------------------- cards -- */
  function navigate(sys) {
    if (sys.act === 'spells') { host.toGame && host.toGame('hdOpenSpells', ''); return; }
    if (sys.act === 'ask') { host.openOmni && host.openOmni('ask'); return; }
    host.setTab && host.setTab(sys.id);
  }

  function renderCards() {
    var grid = $('hm-grid');
    if (!grid) return;
    var editing = !!ui.editing;
    grid.classList.toggle('hm-editing', editing);
    grid.innerHTML = '';
    auditSystems();
    orderedSystems().forEach(function (sys) {
      var card = document.createElement('div');
      card.className = 'hm-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('data-id', sys.id);
      card.tabIndex = editing ? -1 : 0;
      card.title = editing ? 'Drag to reorder — ' + sys.name : sys.name + ' — ' + sys.sub;
      card.style.setProperty('--hmc', sys.hue + '22');
      card.style.setProperty('--hmb', sys.hue + '55');

      var count = countFor(sys);
      if (count) {
        var cc = document.createElement('div');
        cc.className = 'hm-count';
        cc.textContent = count;
        card.appendChild(cc);
      }
      var plate = document.createElement('div');
      plate.className = 'hm-plate';
      plate.style.color = sys.hue;
      if (sys.img) {
        var im = document.createElement('img');
        im.src = sys.img;      // plain path — Ultralight eats a ?v= query
        im.alt = '';
        im.setAttribute('draggable', 'false');
        /* a stale/missing PNG must never leave a broken-image box — drop to the
           emoji glyph, the same remove-on-error the Favorites Shelf uses */
        im.onerror = function () { im.remove(); plate.textContent = sys.icon; };
        plate.appendChild(im);
      } else {
        plate.textContent = sys.icon;
      }
      var h = document.createElement('h3'); h.textContent = sys.name;
      var p = document.createElement('p'); p.textContent = sys.sub;
      card.appendChild(plate); card.appendChild(h); card.appendChild(p);

      if (editing) {
        /* a visible grip handle (the deck's ⋮⋮ drag idiom) so the affordance
           reads even before the cursor lifts a card */
        var grip = document.createElement('span');
        grip.className = 'hm-grip';
        grip.title = 'Drag to reorder';
        grip.textContent = '⋮⋮';
        card.appendChild(grip);
        /* pointer-drag reorder — shared PDrag engine, before/after hit-scan.
           Card mousedown arms; a real drag reorders, a bare click is swallowed
           so an editing card never navigates. */
        card.addEventListener('mousedown', function (e) {
          if (!window.PDrag) return;
          PDrag.arm(e, {
            onStart: function () { ui.dragId = sys.id; },
            onMove: function (ev) {
              if (window.pdScan) pdScan(ev, [{ sel: '#hm-grid.hm-editing .hm-card', mode: 'ba',
                eligible: function (el) { return el.getAttribute('data-id') !== ui.dragId; } }]);
            },
            onDrop: function () {
              var t = window.pdTake ? pdTake() : null;
              var from = ui.dragId; ui.dragId = null;
              if (t && from) {
                var order = orderedSystems().map(function (s) { return s.id; });
                var fi = order.indexOf(from);
                if (fi !== -1) {
                  order.splice(fi, 1);
                  var toId = t.el.getAttribute('data-id');
                  var ti = order.indexOf(toId);
                  if (ti !== -1) order.splice(t.after ? ti + 1 : ti, 0, from);
                  else order.push(from);
                  persistOrder(order);
                }
              }
              renderCards();
            },
            onCancel: function () { ui.dragId = null; renderCards(); },
          });
        });
      } else {
        card.addEventListener('click', function () {
          if (window.PDrag && PDrag.suppressClick) return;
          navigate(sys);
        });
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(sys); }
        });
      }
      grid.appendChild(card);
    });
  }

  /* ------------------------------------------------------- recent drawer -- */
  function renderRecent() {
    var body = $('hm-recent-body');
    var cnt = $('hm-recent-count');
    if (!body) return;
    var items = recent.items || [];
    if (cnt) cnt.textContent = items.length ? String(items.length) : '';
    if (!ui.recentOpen) return;
    if (!items.length) {
      body.innerHTML = '<div class="hm-rc-empty">Nothing fired yet this session.</div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      var ic = RC_IC[it.source] || RC_IC.entry;
      return '<div class="hm-rc-row">' +
        '<span class="hm-rc-ic">' + ic + '</span>' +
        '<div class="hm-rc-t"><b>' + esc(it.name || '(unnamed)') +
          (it.times > 1 ? ' ×' + (it.times >>> 0) : '') + '</b>' +
          (it.category ? '<span>' + esc(it.category) + '</span>' : '') + '</div>' +
        '<span class="hm-rc-when">' + esc(it.ago || '') + '</span>' +
      '</div>';
    }).join('');
  }

  /* generic drawer open/close — flips the chevron + body, calls onOpen once */
  function setDrawer(id, open, onOpen) {
    var drawer = $('hm-' + id);
    var toggle = $('hm-' + id + '-toggle');
    var body = $('hm-' + id + '-body');
    if (drawer) drawer.classList.toggle('open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (body) body.classList.toggle('hidden', !open);
    if (open && onOpen) onOpen();
  }

  function toggleRecent() {
    ui.recentOpen = !ui.recentOpen;
    setDrawer('recent', ui.recentOpen, function () {
      /* the rendered "2m ago" cannot drift while folded, so refresh on open */
      if (host.toGame) host.toGame('hdHistory', '');
      renderRecent();
    });
  }

  /* ------------------------------------------------------- Notes drawer -- */
  function toggleNotes() {
    ui.notesOpen = !ui.notesOpen;
    setDrawer('notes', ui.notesOpen, function () {
      var ta = $('hm-notes-ta');
      if (ta && host.getNotes) {
        var v = host.getNotes();
        if (document.activeElement !== ta) ta.value = (v == null ? '' : v);
      }
      if (ta) ta.focus();
    });
  }
  function bindNotes() {
    var ta = $('hm-notes-ta');
    if (!ta) return;
    ta.addEventListener('input', function () {
      /* debounce the host save the same way the panes do */
      clearTimeout(ui.notesT);
      var v = ta.value;
      ui.notesT = setTimeout(function () { if (host.setNotes) host.setNotes(v); }, 250);
    });
  }

  /* -------------------------------------------------------- Time drawer -- */
  function fmtClock(hour) {
    var h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    var am = h < 12, disp = h % 12; if (disp === 0) disp = 12;
    return disp + ':' + (m < 10 ? '0' : '') + m + ' ' + (am ? 'AM' : 'PM');
  }
  function ordinal(n) {
    if (n % 10 === 1 && n !== 11) return n + 'st';
    if (n % 10 === 2 && n !== 12) return n + 'nd';
    if (n % 10 === 3 && n !== 13) return n + 'rd';
    return n + 'th';
  }
  function renderTime() {
    var clk = $('hm-time-clock'), dt = $('hm-time-date'), now = $('hm-time-now');
    if (!clk) return;
    if (!timeCur) { clk.textContent = '—:—'; if (dt) dt.textContent = 'reading the sky…'; return; }
    clk.textContent = fmtClock(timeCur.hour);
    var mon = MONTHS[((timeCur.month | 0) % 12 + 12) % 12] || '';
    if (dt) dt.textContent = ordinal(timeCur.day | 0) + ' of ' + mon + ' · 4E ' + (timeCur.year | 0);
    if (now) now.textContent = fmtClock(timeCur.hour);
    /* fill the "wait until" chips with the hours-away subtitle */
    var untils = $('hm-time-until');
    if (untils) Array.prototype.forEach.call(untils.querySelectorAll('.hm-time-chip'), function (b) {
      var target = parseFloat(b.getAttribute('data-until'));
      var h = target - timeCur.hour; if (h <= 0) h += 24;
      var sub = b.querySelector('.hm-time-sub');
      if (!sub) { sub = document.createElement('span'); sub.className = 'hm-time-sub'; b.appendChild(sub); }
      sub.textContent = 'in ' + h.toFixed(1) + ' h';
    });
  }
  function receiveTime(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    timeCur = d;
    renderTime();
  }
  function waitHours(h) { if (host.toGame && h) host.toGame('tmWait', String(h)); }
  function toggleTime() {
    ui.timeOpen = !ui.timeOpen;
    setDrawer('time', ui.timeOpen, function () {
      /* chain the tm receivers lazily — time-pane.js has loaded by the time a
         user opens this, so wrapping here (not at parse) is safe and keeps both
         TimePane and our drawer live off the one bridge name. */
      if (!ui.tmChained) {
        ui.tmChained = true;
        var pi = window.tmInfo;
        window.tmInfo = function (p) { receiveTime(p); if (typeof pi === 'function') return pi.apply(this, arguments); };
        var pr = window.tmResult;
        window.tmResult = function (p) { if (host.toGame) host.toGame('tmGet', ''); if (typeof pr === 'function') return pr.apply(this, arguments); };
      }
      if (host.toGame) host.toGame('tmGet', '');   // fresh clock on open
      renderTime();
    });
  }
  function bindTime() {
    var wire = function (wrapId, attr, fn) {
      var w = $(wrapId); if (!w) return;
      w.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.hm-time-chip') : null;
        if (!b) return;
        var v = parseFloat(b.getAttribute(attr));
        if (!isNaN(v)) fn(v);
      });
    };
    /* "wait until" target hour -> hours-from-now; "wait for" is the hours directly */
    wire('hm-time-until', 'data-until', function (target) {
      if (!timeCur) return;
      var h = target - timeCur.hour; if (h <= 0) h += 24;
      waitHours(h.toFixed(3));
    });
    wire('hm-time-for', 'data-hours', function (h) { waitHours(h); });
  }

  /* ------------------------------------------------ UI Elements drawer -- *
   *  One row per on-screen element (home-ui-elements). Rober (2026-08-12):
   *  "access their settings from home page as UI elements or something".
   *
   *  Each row: name + sub, a LIVE on/off chip WHERE the state is queryable, a
   *  toggle, and a "settings →" jump to where the element is configured.
   *
   *  Bridges are the elements' OWN, discovered by reading the code, one name
   *  per direction — never a reply name reused as a request:
   *    Followers HUD — request hudCfg {op}, reply hudCfgState (followers-pane).
   *      Toggle = hudCfg{op:'enable',on}; state via hudCfg{op:'state'}. Jump =
   *      the Followers tab (its HUD pill + settings modal live in the search row).
   *    Loot Vision   — request ltGet/ltToggle, reply ltOpen/ltResult carry
   *      `enabled` (loot-pane). Toggle = ltToggle; jump = the Loot tab.
   *    Action Bar    — its hb* bridges live in the OTHER (MagicDeck) view, so it
   *      has NO queryable state here. Show/Hide fires the deck's own
   *      `hotbar-toggle` action; "Set up →" fires `hotbar-edit` (opens the
   *      editor). No chip — never fake a state.
   *    Wheel Menu    — opened by a chord (Ctrl + your deck key), not a toggle;
   *      show the chord and a "Open" that fires the `wheel` deck action.
   *  Toggles/jumps that are deck actions ride host.toGame('hdFire', ENTRY id
   *  — the hd- prefixed seed id, NOT the action verb: OnJsFire looks entries up
   *  by id and silently warns on a verb (live bug 2026-08-12) — the
   *  exact call fireEntry() makes, so the seeded action ids fire as if pressed. */

  /* chain a reply receiver so BOTH the owning pane and our drawer see it. Same
     lazy-wrap trick the Time drawer uses (installed on drawer open, by which
     time the owning pane has registered its own handler). */
  function chainReceiver(name, fn) {
    var prev = window[name];
    window[name] = function () {
      try { fn.apply(null, arguments); } catch (e) {}
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
  }
  function coerce(x) {
    if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
    return x;
  }

  /* the elements, in row order. `toggle`/`jump` are functions; `state` reads
     the live flag (or returns null when not queryable). `chord` is a static
     key hint shown instead of a toggle where the element has no on/off. */
  var UIE = [
    { id: 'hud', ic: '👥', name: 'Followers HUD', sub: 'On-screen portrait strip of your followers',
      state: function () { return uie.hud; },
      toggle: function () {
        var on = uie.hud === true;
        if (host.toGame) host.toGame('hudCfg', JSON.stringify({ op: 'enable', on: !on }));
      },
      jump: function () { host.setTab && host.setTab('followers'); },
      jumpLabel: 'Followers tab →' },
    { id: 'hotbar', ic: '▦', name: 'Action Bar', sub: 'WoW-style spell/action bar (hotbar)',
      state: function () { return null; },   // hb* bridges are in the MagicDeck view — no live state here
      toggle: function () { host.toGame && host.toGame('hdFire', 'hd-hotbar-toggle'); },
      toggleLabel: 'Show / Hide',
      jump: function () { host.toGame && host.toGame('hdFire', 'hd-hotbar-edit'); },
      jumpLabel: 'Set up →' },
    { id: 'wheel', ic: '◎', name: 'Wheel Menu', sub: 'Radial ring of anything you pinned',
      state: function () { return null; },
      chord: 'Ctrl + your deck key',
      open: function () { host.toGame && host.toGame('hdFire', 'hd-wheel-open'); },
      openLabel: 'Open' },
    { id: 'loot', ic: '✨', name: 'Loot Vision', sub: 'Glow the loot worth walking to',
      state: function () { return uie.loot; },
      toggle: function () { host.toGame && host.toGame('ltToggle'); },
      jump: function () { host.setTab && host.setTab('loot'); },
      jumpLabel: 'Loot tab →' },
  ];

  function stateChip(v) {
    if (v === null || v === undefined) return null;
    var chip = document.createElement('span');
    chip.className = 'hm-uie-state ' + (v ? 'on' : 'off');
    chip.textContent = v ? 'ON' : 'OFF';
    return chip;
  }

  function renderUie() {
    var body = $('hm-uie-body');
    if (!body) return;
    if (!ui.uieOpen) return;
    body.innerHTML = '';
    UIE.forEach(function (el) {
      var row = document.createElement('div');
      row.className = 'hm-uie-row';
      row.setAttribute('data-id', el.id);

      var ic = document.createElement('span');
      ic.className = 'hm-uie-ic'; ic.textContent = el.ic; row.appendChild(ic);

      var t = document.createElement('div'); t.className = 'hm-uie-t';
      var b = document.createElement('b'); b.textContent = el.name;
      var s = document.createElement('span'); s.textContent = el.sub;
      t.appendChild(b); t.appendChild(s); row.appendChild(t);

      var chip = stateChip(el.state ? el.state() : null);
      if (chip) row.appendChild(chip);

      /* a chord-only element (Wheel) shows the chord + an Open button, no toggle */
      if (el.chord) {
        var kc = document.createElement('span');
        kc.className = 'hm-uie-chord'; kc.textContent = el.chord;
        kc.title = 'How it opens'; row.appendChild(kc);
        if (el.open) {
          var ob = document.createElement('button');
          ob.className = 'hm-uie-btn'; ob.type = 'button';
          ob.textContent = el.openLabel || 'Open';
          ob.title = 'Open ' + el.name;
          ob.addEventListener('click', el.open);
          row.appendChild(ob);
        }
      } else if (el.toggle) {
        var tb = document.createElement('button');
        tb.className = 'hm-uie-btn'; tb.type = 'button';
        var on = el.state ? el.state() : null;
        tb.textContent = el.toggleLabel || (on === true ? 'Turn off' : on === false ? 'Turn on' : 'Toggle');
        tb.title = 'Toggle ' + el.name;
        tb.addEventListener('click', function () {
          el.toggle();
          /* optimistic flip where we track the state, so the chip feels instant;
             the chained receiver corrects it when the real reply lands */
          if (el.id === 'hud' && uie.hud !== null) uie.hud = !uie.hud;
          if (el.id === 'loot' && uie.loot !== null) uie.loot = !uie.loot;
          renderUie();
        });
        row.appendChild(tb);
      }

      if (el.jump) {
        var jb = document.createElement('button');
        jb.className = 'hm-uie-btn hm-uie-jump'; jb.type = 'button';
        jb.textContent = el.jumpLabel || 'Settings →';
        jb.title = 'Go to where ' + el.name + ' is configured';
        jb.addEventListener('click', el.jump);
        row.appendChild(jb);
      }
      body.appendChild(row);
    });
  }

  function receiveHud(env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    uie.hud = !!env.enabled;
    if (ui.uieOpen) renderUie();
  }
  function receiveLoot(env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    if (typeof env.enabled === 'boolean') { uie.loot = env.enabled; if (ui.uieOpen) renderUie(); }
  }

  function toggleUie() {
    ui.uieOpen = !ui.uieOpen;
    setDrawer('uie', ui.uieOpen, function () {
      /* lazy-chain the elements' reply receivers on first open, then ask each
         queryable element for fresh state. Chaining now (not at parse) means
         followers-pane / loot-pane have already installed their own handlers,
         so ours forwards to them. */
      if (!ui.uieChained) {
        ui.uieChained = true;
        chainReceiver('hudCfgState', receiveHud);
        chainReceiver('ltOpen', receiveLoot);    // carries `enabled`
        chainReceiver('ltResult', receiveLoot);  // toggle reply, also `enabled`
      }
      if (host.toGame) {
        host.toGame('hudCfg', JSON.stringify({ op: 'state' }));  // HUD -> hudCfgState
        host.toGame('ltGet', '');                                // Loot -> ltOpen
      }
      renderUie();
    });
  }

  /* C++ pushes hdRecent; app.js owns the primary handler and forwards here so
     the drawer stays live without a second bridge name. */
  function receiveRecent(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    recent = {
      items: Array.isArray(d.items) ? d.items : [],
      count: d.count >>> 0,
      max: d.max >>> 0,
    };
    renderRecent();
  }

  /* --------------------------------------------------------------- host -- */
  function hookInto(h) {
    host.setTab = h && h.setTab;
    host.toGame = h && h.toGame;
    host.openOmni = h && h.openOmni;
    host.hotkeyCount = h && h.hotkeyCount;
    host.getNotes = h && h.getNotes;
    host.setNotes = h && h.setNotes;
    host.getHomeOrder = h && h.getHomeOrder;   // home-card-reorder: shelf-blob backed
    host.setHomeOrder = h && h.setHomeOrder;
    host.sysTabs = h && h.sysTabs;
    host.detected = h && h.detected;
    host.getOpenKey = h && h.getOpenKey;             // home-open-key
    host.startOpenKeyPicker = h && h.startOpenKeyPicker;
  }

  /* ---------------------------------------------------- open-key card -- *
   *  home-open-key — the ONE control a new user hunts for and can't find
   *  (Nexus IAMTOKKO wanted to rebind F7, searched everywhere, gave up).
   *  Shows the live bind big, and "Change…" runs app.js's OWN open-key
   *  rebind flow (startCapture('open') → press-to-rebind + the pick-from-
   *  list button), so there is exactly one implementation. */
  function openKeyLabel() {
    if (typeof host.getOpenKey === 'function') {
      try { var l = host.getOpenKey(); if (l) return String(l); } catch (e) {}
    }
    return '—';
  }
  function renderOpenKey() {
    var k = $('hm-ok-key');
    if (k) { var lbl = openKeyLabel(); k.textContent = lbl; k.title = lbl + ' opens SkyManager'; }
  }
  function bindOpenKey() {
    var btn = $('hm-ok-change');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (typeof host.startOpenKeyPicker === 'function') host.startOpenKeyPicker();
    });
  }

  function bindSearch() {
    var box = $('hm-search');
    if (!box) return;
    var openSearch = function () { if (host.openOmni) host.openOmni('search'); };
    box.addEventListener('click', openSearch);
    box.addEventListener('focus', openSearch);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSearch(); }
    });
  }

  function init() {
    if (ui.inited) return true;
    if (!$('hm-pane')) { console.log('[home] #hm-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;
    bindSearch();
    bindOpenKey();
    bindNotes();
    bindTime();
    var rt = $('hm-recent-toggle'); if (rt) rt.addEventListener('click', toggleRecent);
    var nt = $('hm-notes-toggle');  if (nt) nt.addEventListener('click', toggleNotes);
    var tt = $('hm-time-toggle');   if (tt) tt.addEventListener('click', toggleTime);
    var ut = $('hm-uie-toggle');    if (ut) ut.addEventListener('click', toggleUie);
    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  function onShow() {
    if (!init()) return;
    renderOpenKey();     // the live bind may have changed via Edit or a rebind
    renderCards();       // counts are live — re-read every show
    renderRecent();
    if (host.toGame) host.toGame('hdHistory', '');  // warm the drawer count
  }
  function onHide() {
    /* leaving the tab while editing must not strand the grid in edit chrome */
    if (ui.editing) { ui.editing = false; ui.dragId = null; }
  }

  /* F2 / Edit button (routed here from app.js toggleEdit for the Home tab).
     Flips the reorder mode and repaints so the grips + drag arming appear.
     home-card-reorder */
  function toggleEdit() {
    ui.editing = !ui.editing;
    ui.dragId = null;
    var pane = $('hm-pane');
    if (pane) pane.classList.toggle('hm-edit', ui.editing);
    renderCards();
  }
  function isEditing() { return !!ui.editing; }
  function wantsPause() { return true; }

  /* ------------------------------------------------------------ selftest -- */
  function selftest() {
    var out = [];
    var ok = function (n, c) { out.push((c ? 'PASS ' : 'FAIL ') + n); };
    $('hm-pane').classList.remove('hidden');

    var nav = [];
    var notesStore = 'hello';
    var orderStore = null;   // stands in for the shelf blob (state.shelf.home.order)
    var openKeyStore = 'F7';
    hookInto({
      setTab: function (t) { nav.push('tab:' + t); },
      toGame: function (fn, a) { nav.push('game:' + fn + (a ? ':' + a : '')); },
      openOmni: function (m) { nav.push('omni:' + m); },
      hotkeyCount: function () { return 34; },
      getNotes: function () { return notesStore; },
      setNotes: function (v) { notesStore = v; },
      getHomeOrder: function () { return orderStore; },
      setHomeOrder: function (ids) { orderStore = ids.slice(); },
      sysTabs: function () { return ['quests', 'followers', 'keys', 'loot']; },
      getOpenKey: function () { return openKeyStore; },
      startOpenKeyPicker: function () { nav.push('openkeypicker'); },
    });
    onShow();

    ok('pane mounted', !!$('hm-pane'));
    ok('every system renders a card', $('hm-grid').children.length === SYSTEMS.length);
    ok('Keys card present (Task 2 — new keys tab carried)',
      $('hm-grid').textContent.indexOf('Every hotkey in the load order') !== -1);
    ok('no Time/Notes card', $('hm-grid').textContent.indexOf('Skip the slow wait') === -1 &&
      $('hm-grid').textContent.indexOf('scratchpad') === -1);
    ok('Hotkeys count from host', /34/.test($('hm-grid').children[0].textContent));
    var cards = $('hm-grid').children;
    cards[0].click();
    ok('hotkeys card -> setTab(all)', nav.indexOf('tab:all') !== -1);
    cards[1].click();
    ok('spells card -> launcher', nav.indexOf('game:hdOpenSpells') !== -1);
    cards[cards.length - 1].click();
    ok('ask card -> omni ask', nav.indexOf('omni:ask') !== -1);
    $('hm-search').click();
    ok('search launcher -> omni search', nav.indexOf('omni:search') !== -1);

    /* Open-key card (home-open-key) — exists, shows the live bind, Change…
       runs the host's rebind flow, and it is findable via omni. */
    ok('open-key card present', !!$('hm-openkey'));
    ok('open-key card shows current label (F7)', $('hm-ok-key').textContent === 'F7');
    $('hm-ok-change').click();
    ok('Change… runs the host rebind flow', nav.indexOf('openkeypicker') !== -1);
    openKeyStore = 'Numpad 5';
    renderOpenKey();
    ok('label refreshes after a rebind', $('hm-ok-key').textContent === 'Numpad 5');
    /* omni provider: an "open key" query finds the rebind result, whose run()
       jumps to Home and starts the picker. Test the provider's index directly
       (the omni core is a separate module; here we assert the contract we ship). */
    var okProv = _registerOmni && (function () {
      var captured = null;
      var fakeOmni = { register: function (p) { captured = p; } };
      var real = window.HDOmni; window.HDOmni = fakeOmni;
      _registerOmni(); window.HDOmni = real;
      return captured;
    })();
    ok('omni provider registered', !!okProv && okProv.tab === 'home');
    var okItems = okProv ? okProv.index() : [];
    var hay = okItems.map(function (i) { return (i.label + ' ' + i.keywords).toLowerCase(); }).join(' ');
    ok('omni indexes "open key" keywords',
      hay.indexOf('open key') !== -1 && hay.indexOf('hotkey') !== -1 &&
      hay.indexOf('change key') !== -1 && hay.indexOf('numpad 5') !== -1);
    if (okItems[0] && typeof okItems[0].run === 'function') {
      var before = nav.length; okItems[0].run();
      ok('omni result run -> Home tab + picker',
        nav.slice(before).indexOf('tab:home') !== -1 &&
        nav.slice(before).indexOf('openkeypicker') !== -1);
    } else { ok('omni result run -> Home tab + picker', false); }

    /* reorder persistence (home-card-reorder): move 'ask' to the front and
       confirm the persisted order round-trips + renders */
    persistOrder(['ask'].concat(orderedSystems().map(function (s) { return s.id; })
      .filter(function (id) { return id !== 'ask'; })));
    ok('reorder persists to host', Array.isArray(orderStore) && orderStore[0] === 'ask');
    renderCards();
    ok('reorder repaints (ask now first)',
      $('hm-grid').children[0].getAttribute('data-id') === 'ask');

    /* sanitizer: unknown ids dropped, a NEW system appended even if unknown to
       the stored order (so a system added to app.js always shows) */
    var san = sanitizeOrder(['bogus', 'ask', 'quests']);
    ok('sanitize drops unknown ids', san.indexOf('bogus') === -1);
    ok('sanitize keeps stored order first', san[0] === 'ask' && san[1] === 'quests');
    ok('sanitize appends every known system', san.length === SYSTEMS.length &&
      san.indexOf('keys') !== -1 && san.indexOf('numpad') !== -1);

    /* edit mode toggles the reorder chrome */
    ok('not editing by default', !isEditing());
    toggleEdit();
    ok('toggleEdit enters edit mode', isEditing() &&
      $('hm-grid').classList.contains('hm-editing') &&
      !!$('hm-grid').querySelector('.hm-grip'));
    toggleEdit();
    ok('toggleEdit leaves edit mode', !isEditing() && !$('hm-grid').classList.contains('hm-editing'));

    /* UI Elements drawer (home-ui-elements) */
    ok('uie drawer starts closed', !$('hm-uie').classList.contains('open'));
    toggleUie();
    ok('uie opens', $('hm-uie').classList.contains('open'));
    ok('uie asked HUD state (hudCfg)', nav.some(function (n) { return n.indexOf('game:hudCfg') === 0; }));
    ok('uie asked Loot state (ltGet)', nav.indexOf('game:ltGet') !== -1);
    ok('uie four rows', $('hm-uie-body').querySelectorAll('.hm-uie-row').length === 4);
    ok('uie names all four', /Followers HUD/.test($('hm-uie-body').textContent) &&
      /Action Bar/.test($('hm-uie-body').textContent) &&
      /Wheel Menu/.test($('hm-uie-body').textContent) &&
      /Loot Vision/.test($('hm-uie-body').textContent));
    ok('wheel shows its chord, no fake state',
      /Ctrl \+ your deck key/.test($('hm-uie-body').textContent));
    receiveHud({ enabled: true });
    ok('HUD chip reads ON after hudCfgState', /ON/.test(
      $('hm-uie-body').querySelector('.hm-uie-row[data-id="hud"]').textContent));
    receiveLoot({ enabled: false });
    ok('Loot chip reads OFF after ltOpen', /OFF/.test(
      $('hm-uie-body').querySelector('.hm-uie-row[data-id="loot"]').textContent));
    /* HUD toggle fires the element's OWN request (hudCfg), never a reply name */
    var hudRow = $('hm-uie-body').querySelector('.hm-uie-row[data-id="hud"]');
    hudRow.querySelector('.hm-uie-btn').click();
    ok('HUD toggle fires hudCfg', nav.some(function (n) { return n.indexOf('game:hudCfg') === 0; }));
    /* Loot toggle fires ltToggle (request), jump goes to the Loot tab */
    var lootRow = $('hm-uie-body').querySelector('.hm-uie-row[data-id="loot"]');
    lootRow.querySelector('.hm-uie-btn').click();
    ok('Loot toggle fires ltToggle', nav.indexOf('game:ltToggle') !== -1);
    lootRow.querySelector('.hm-uie-jump').click();
    ok('Loot jump -> setTab(loot)', nav.indexOf('tab:loot') !== -1);
    /* Action Bar has no state chip (never faked) but fires deck actions */
    var hbRow = $('hm-uie-body').querySelector('.hm-uie-row[data-id="hotbar"]');
    ok('Action Bar shows NO state chip', !hbRow.querySelector('.hm-uie-state'));
    hbRow.querySelector('.hm-uie-jump').click();
    ok('Action Bar Set up -> hdFire hotbar-edit',
      nav.indexOf('game:hdFire:hotbar-edit') !== -1);
    toggleUie();

    ok('recent drawer starts closed', !$('hm-recent').classList.contains('open'));
    toggleRecent();
    ok('recent opens', $('hm-recent').classList.contains('open'));
    ok('recent asked hdHistory', nav.indexOf('game:hdHistory') !== -1);
    receiveRecent({ items: [{ name: 'Full Save', category: 'Misc', ago: '2m ago', source: 'action' }], count: 1, max: 300 });
    ok('recent row renders', /Full Save/.test($('hm-recent-body').textContent));
    ok('recent count chip', $('hm-recent-count').textContent === '1');
    toggleRecent();
    ok('recent folds again', !$('hm-recent').classList.contains('open'));

    /* Notes drawer */
    toggleNotes();
    ok('notes opens', $('hm-notes').classList.contains('open'));
    ok('notes loads host value', $('hm-notes-ta').value === 'hello');
    var ta = $('hm-notes-ta'); ta.value = 'edited'; ta.dispatchEvent(new Event('input'));

    /* Time drawer */
    toggleTime();
    ok('time opens', $('hm-time').classList.contains('open'));
    ok('time asked tmGet', nav.indexOf('game:tmGet') !== -1);
    receiveTime({ hour: 21.78, day: 17, month: 7, year: 204 });
    ok('time clock renders', $('hm-time-clock').textContent === '9:46 PM');
    ok('time date names Last Seed', /Last Seed/.test($('hm-time-date').textContent));
    $('hm-time-for').querySelector('[data-hours="6"]').click();
    ok('wait chip fires tmWait', nav.some(function (n) { return n.indexOf('game:tmWait') === 0; }));

    var fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    var box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' + (fails.length ? '#c85046' : '#4c8') +
      ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ------------------------------------------------- omni provider -- *
   *  Make the open-key rebind FINDABLE by search (home-open-key). A user
   *  typing "open key" / "hotkey" / "change key" / "F7" in ⌕ gets a result
   *  whose Enter runs the rebind flow; Shift+Enter jumps to the Home tab.
   *  index() reads the live bind so the current key shows in `detail`. */
  function registerOmni() {
    if (!window.HDOmni || !HDOmni.register) return;
    HDOmni.register({
      id: 'openkey', label: 'Deck', tab: 'home',
      setFilter: function () { /* Home has no filter box — landing on it is the jump */ },
      index: function () {
        var lbl = openKeyLabel();
        return [{
          label: 'Change the open key',
          detail: 'Currently ' + lbl + ' — the key that opens SkyManager',
          kind: 'setting',
          keywords: 'open key hotkey change key rebind keybind bind shortcut ' +
                    'launch menu deck skymanager f7 numpad ' + lbl,
          run: function () {
            if (host.setTab) host.setTab('home');
            if (typeof host.startOpenKeyPicker === 'function') host.startOpenKeyPicker();
          },
        }];
      },
    });
  }
  registerOmni();

  return {
    init: init, onShow: onShow, onHide: onHide, hookInto: hookInto,
    receiveRecent: receiveRecent, toggleEdit: toggleEdit, isEditing: isEditing,
    wantsPause: wantsPause,
    _systems: SYSTEMS, _sanitizeOrder: sanitizeOrder, _orderedSystems: orderedSystems,
    _ui: ui, _uie: uie, _UIE: UIE,
    _toggleUie: toggleUie, _renderUie: renderUie,
    _receiveHud: receiveHud, _receiveLoot: receiveLoot,
    _openKeyLabel: openKeyLabel, _registerOmni: registerOmni
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.HomePane.init(); });
} else {
  window.HomePane.init();
}
