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
    { id: 'spellcraft',name: 'Spell Crafting', icon: '✨', img: 'icons/custom/hm-spellcraft.png', hue: '#b79bff', sub: 'Craft your own spells',   act: 'tab', prov: 'spellcraft' },
    { id: 'highking',  name: 'High King',   icon: '👑', img: 'icons/custom/hm-highking.png',  hue: '#e5c877', sub: 'Rule Skyrim — taxes, approval, powers', act: 'tab', prov: 'highking', requires: 'highking' },
    { id: 'followers', name: 'Followers',  icon: '👥', img: 'icons/custom/hm-followers.png', hue: '#e0a86a', sub: 'Summon, order, dress',        act: 'tab', prov: 'followers', requires: 'followerorganizer' },
    /* Household (2026-09-13) — sits beside Followers because it is the same
       people seen a different way: the roster answers "who exists", this one
       answers "who is my wife and who is expecting". Rose, the hue the roster
       row already uses for a pregnancy. UNGATED for the same reason the tab
       is: with FM or MARAS silent the pane says so itself. */
    { id: 'household', name: 'Household',  icon: '♥', img: 'icons/custom/hm-household.png', hue: '#d98aa6', sub: 'Wives & who is expecting',    act: 'tab' },
    { id: 'quests',    name: 'Quests',     icon: '❈',  img: 'icons/custom/hm-quests.png',    hue: '#c9a24b', sub: 'Inspect & repair any quest',  act: 'tab' },
    { id: 'domains',   name: 'Domains',    icon: '📍', img: 'icons/custom/hm-domains.png',   hue: '#8fd8a0', sub: 'Mark a spot, click to travel',act: 'tab', prov: 'domains' },
    { id: 'containers',name: 'Containers', icon: '📦', img: 'icons/custom/hm-containers.png',hue: '#c9a24b', sub: 'Mark a chest, open it anywhere',act: 'tab', prov: 'containers' },
    { id: 'rooms',     name: 'Rooms',      icon: '🚪', img: 'icons/custom/hm-rooms.png',     hue: '#b79bff', sub: 'Claim a room, keep it yours', act: 'tab', prov: 'rooms' },
    { id: 'loot',      name: 'Loot',       icon: '✨', img: 'icons/custom/hm-loot.png',      hue: '#ffd36a', sub: 'Glow the loot worth grabbing',act: 'tab' },
    { id: 'keys',      name: 'Keys',       icon: '🗝', img: 'icons/custom/hm-keys.png',      hue: '#c9a24b', sub: 'Every hotkey in the load order',act: 'tab' },
    /* Items + NPCs merged into ONE Finder tab (2026-08-14) — setTab('finder')
       resolves to whichever roster was used last; the pane's own switch flips */
    { id: 'finder',    name: 'Finder',     icon: '⌕',  img: 'icons/custom/hm-finder.png',    hue: '#ffd36a', sub: 'Any item, anyone — take, bring, spawn', act: 'tab' },
    { id: 'transmog',  name: 'Transmog',   icon: '◇',  img: 'icons/custom/hm-transmog.png',  hue: '#b79bff', sub: 'Your gear, any look — stats stay', act: 'tab' },
    /* Combat Arts lives in the Spell Deck window (2026-08-15), so its card is a
       LAUNCHER like the Spell Deck's own — act 'arts' opens that view on it. */
    { id: 'combatarts',name: 'Combat Arts',icon: '⚔',  img: 'icons/custom/hm-combat-arts.png',hue: '#e08a6a', sub: 'Ashes of War — equip an art',  act: 'arts' },
    { id: 'loadouts',  name: 'Loadouts',   icon: '⚑',  img: 'icons/custom/hm-loadouts.png',  hue: '#e0a86a', sub: 'Follower groups — deploy in one press', act: 'tab' },
    { id: 'settle',    name: 'Settlement', icon: '🏕', img: 'icons/custom/hm-settlement.png',hue: '#9dcb8f', sub: 'Place objects & build a camp', act: 'tab', prov: 'settle' },
    { id: 'survival',  name: 'Survival',   icon: '⛺', img: 'icons/custom/hm-survival.png',  hue: '#9dcb8f', sub: 'Needs, camp, skills — your way', act: 'tab' },
    { id: 'wigs',      name: 'Wigs',       icon: '💇', img: 'icons/custom/hm-wigs.png',      hue: '#d9a86c', sub: 'Rendered wig catalogue - add a mod, wear a wig', act: 'tab', prov: 'wigs' },
    { id: 'anim',      name: 'Animations', icon: '🩰', img: 'icons/custom/hm-anim.png',      hue: '#e58fb0', sub: 'Apply a ZaZ animation',        act: 'tab', requires: 'zap' },
    { id: 'finances',  name: 'Finances',   icon: '⚖',  img: 'icons/custom/hm-finances.png',  hue: '#d0c07a', sub: 'Ledger, market & settle',     act: 'tab', prov: 'finances' },
    { id: 'wardrobe',  name: 'Wardrobe',   icon: '👗', img: 'icons/custom/hm-wardrobe.png',  hue: '#e58fb0', sub: 'Outfits & who dresses whom',  act: 'tab', prov: 'wardrobe', requires: 'soes' },
    { id: 'faces',     name: 'Faces',      icon: '🙂', img: 'icons/custom/hm-faces.png',     hue: '#8fd8ff', sub: 'Browse & apply RaceMenu presets', act: 'tab', requires: 'presetdirector' },
    { id: 'journal',   name: 'Journal',    icon: '📖', img: 'icons/custom/hm-journal.png',   hue: '#d9b45c', sub: 'Write your own pages, with pictures', act: 'tab', prov: 'journal' },
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
  /* round 3 (2026-08-17): hotbar + widgets master + the four free slot
     widgets got REAL state — hdUiState -> hdUiStateData reads it straight off
     the configs, so the cards stop guessing. */
  /* ---- ENABLED vs ON SCREEN (2026-08-19, round 3) -------------------------
     Rober's live config: the Action Bar was `enabled=true, visible=false,
     showMode=always` and this drawer showed a flat "ON" — a row claiming an
     element is on while the screen shows nothing reads as "enabled but broken".

     Two of these elements carry TWO flags, a master `enabled` and their own
     show/hide `visible`, and the Action Bar carries a third gate on top: the
     automatic `showMode` rule ("only in combat", "only with a weapon drawn"),
     whose live verdict C++ publishes as `hotbarEffective`. So the pill shows
     the EFFECTIVE truth — ON / HIDDEN / OFF — and the row says out loud which
     flag is holding it down. Round 2's law is intact: a pill never fakes a
     state it cannot read; these ARE readable (they sit in the config slice
     UiStateJson already serialises), so they are read. */
  var uie = { inlineOpen: null, hud: null, hudVisible: null,
              loot: null, hotbar: null, hotbarVisible: null,
              hotbarMode: 'always', hotbarEff: null, widgets: null,
              fw: { handR: null, handL: null, voice: null, quick: null,
                    quick2: null, lootStatus: null,
                    /* 2026-08-31: the season widget joined the free layer, so it
                       reads its state through the same widgets.<id>.enabled walk
                       below — nothing else here needed changing. */
                    season: null },
              /* the merged Equipped widget's own facts, read straight off the
                 HUD view's `hud.grp` blob inside hdUiStateData (2026-08-19).
                 `known:false` = never heard from the game, so the expander
                 shows the shipped defaults rather than inventing values. */
              grp: { orient: 'vert', scale: 1, locked: true, mem: null, keys: null, known: false } };
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
    if (sys.act === 'arts') { host.toGame && host.toGame('hdOpenSpells', 'arts'); return; }
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
     key hint shown instead of a toggle where the element has no on/off.
     `kw` is what a PLAYER would type looking for this thing — the words the
     code never uses ("party frames", "ammo", "spotlight") — and it exists so
     the omni provider below can find an element nobody knows the name of. It
     lives here, beside the row, because the day an element is added is the day
     its synonyms are known. */
  var UIE = [
    { id: 'hud', ic: '⁂', img: 'icons/custom/hm-followers.png', name: 'Followers HUD', sub: 'On-screen portrait strip of your followers',
      kw: 'followers hud party frames portrait strip companion faces who is with me',
      state: function () { return uie.hud; },
      /* on, but its own show/hide flag is down — the pill says HIDDEN rather
         than claiming a strip is on screen when it is not (round 3) */
      hidden: function () { return uie.hud === true && uie.hudVisible === false; },
      toggle: function () {
        if (!host.toGame) return;
        /* HIDDEN → show it (the flag that is actually holding it down); on/off
           → the master. Both are the deck card's own existing hudCfg ops. */
        if (uie.hud === true && uie.hudVisible === false) {
          host.toGame('hudCfg', JSON.stringify({ op: 'visible', on: true }));
          return;   /* the optimistic flip lives in ONE place — renderUie's click */
        }
        var on = uie.hud === true;
        host.toGame('hudCfg', JSON.stringify({ op: 'enable', on: !on }));
      },
      /* ---- THE INLINE CHIP STRIP IS RETIRED (2026-08-19, round 3) ---------
         Rober, third play-test: "the Followers HUD needs the same shelf
         treatment — its own config button opening a popout right panel… not
         whatever the hell this is", pointing at what this row used to expand
         into: FolPane._hudSettingsRow(), a wrapped strip of nineteen 9px chips
         (Enabled · Reposition · Vertical · Grows · Aa Names on · Lv badge ·
         Direction · Health · Magicka · Stamina · Widgets… · Circle · Rounded ·
         Square · Diamond · Compact · Set browse key · Shown · Set key).

         Every one of those is now a real row in the HUD shelf's own Followers
         HUD section — big type, the deck's row idioms, and the shelf filter
         reaches all of them. So this row has ONE configure door, and it is the
         same `hudCfg {op:'shelf'}` idiom the Equipped widget and HUD Widgets
         rows already use. Opening it is also what puts the strip into its edit
         dress; entering widget config no longer does (see hud.js stripEdit).

         (FolPane._hudSettingsRow still exists and still feeds the Followers
         tab's own 👥 HUD modal — this drawer simply stopped mounting it.) */
      jumpLabel: 'Config →',
      jump: function () { host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf', key: 'strip' })); },
      /* …and the separation the shelf section states out loud: who is on the
         roster, and their portraits, are the Followers TAB's business. */
      extra: [
        { label: 'Roster →', title: 'Who is following you, their portraits and their faces — the deck’s Followers tab',
          run: function () { host.setTab && host.setTab('followers'); } },
      ] },
    { id: 'hotbar', ic: '▦', img: 'icons/custom/hk-hotbar.png', name: 'Action Bar', sub: 'WoW-style spell/action bar (hotbar)',
      kw: 'action bar hotbar skill bar spell bar quick bar number keys wow bar',
      state: function () { return uie.hotbar; },   // hdUiStateData reads the config directly
      /* ROUND 3 — Rober's live config was enabled=true, visible=false and this
         row said a flat "ON" while nothing was on screen. The bar has TWO
         flags; the pill answers for the pair. */
      hidden: function () { return uie.hotbar === true && uie.hotbarVisible === false; },
      /* …and a THIRD gate: the automatic showMode rule. When that is what is
         holding an otherwise-shown bar off screen, say so instead of pretending
         (the row is honest; the pill still reads ON, because it IS on — the
         rule is a condition, not a switch someone flipped). */
      note: function () {
        if (uie.hotbar !== true || uie.hotbarVisible === false) return '';
        if (uie.hotbarEff !== false) return '';
        var m = uie.hotbarMode;
        if (m === 'combat') return 'hidden by rule: only in combat';
        if (m === 'drawn') return 'hidden by rule: only with a weapon or spell drawn';
        if (m === 'either') return 'hidden by rule: only in combat or with a weapon drawn';
        return '';
      },
      /* hd-hotbar-toggle IS the show/hide verb (main.cpp HbToggleVisible flips
         `visible`, and arms `enabled` on the first press) — so one action
         answers for both faces of the pill. No new verb. */
      toggle: function () { host.toGame && host.toGame('hdFire', 'hd-hotbar-toggle'); },
      jump: function () { host.toGame && host.toGame('hdFire', 'hd-hotbar-edit'); },
      jumpLabel: 'Config →' },
    { id: 'wheel', ic: '◎', img: 'icons/custom/hk-wheel.png', name: 'Wheel Menu', sub: 'Radial ring of anything you pinned',
      kw: 'wheel radial ring quick menu weapon wheel favourites wheel pie menu',
      state: function () { return null; },
      chord: 'Ctrl + your deck key',
      open: function () { host.toGame && host.toGame('hdFire', 'hd-wheel-open'); },
      openLabel: 'Open' },
    { id: 'widgets', ic: '⌗', img: 'icons/custom/hk-widgets.png', name: 'HUD Widgets',
      sub: 'Readouts, vitals, pins — the whole widget stack',
      kw: 'widgets hud overlay readouts meters bars vitals health magicka stamina',
      state: function () { return uie.widgets; },
      toggle: function () { host.toGame && host.toGame('hdFire', 'hd-widgets-toggle'); },
      /* 2026-08-19: "Set up" now opens the HUD's own SHELF — the one place
         every element's switch, size and options live. Same arming path
         "Place" uses, so the deck closes and the screen goes to the editor. */
      jump: function () { host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf' })); },
      jumpLabel: 'Config →' },
    /* ---- ONE row for the merged Equipped widget (2026-08-19) --------------
       The HUD view merged right hand / left hand / shout into a SINGLE widget
       with a derived master and its own orientation, size and membership
       (hud.js wgrp / grpSetMaster). This drawer was still showing the old
       three-row shape with nothing but a Place button — "i see no
       configuration options either" (Rober, play-test). One row now: the
       master inline, the per-line switches and the real controls in the
       expander, and a door to the HUD's own shelf for everything else.

       ⚠ Nothing here re-implements the group's rules. The per-line switches
       ride the existing hdWidgetToggle (C++ Widgets::ToggleOne), and master /
       orientation / size ride hdWidgetGrp, which C++ relays into hud.js's own
       hudGrpCmd — the same functions the shelf's buttons run. */
    { id: 'fw-eq', ic: '†', img: 'icons/custom/hd-sword.png', name: 'Equipped Widget',
      sub: 'Right hand · left hand · shout — one widget, three lines',
      kw: 'equipped widget right hand left hand shout power what am i holding weapon readout',
      state: function () { return grpMaster(); },
      toggle: function () {
        var on = grpMaster() === true;
        grpSend({ op: 'master', on: !on });
        grpOptimistic(!on);
      },
      inline: buildEqInline,
      /* Rober, 2026-08-19: "i asked for a slide out right shelf for equipped
         widget … equipped widgets place button should also open right slider."
         So the PRIMARY configure action is the shelf, focused on the group's
         own card — not an inline expander and not bare reposition mode. The
         per-line switches keep their expander, demoted to a secondary button,
         because they are the one thing worth doing without leaving the deck. */
      jumpLabel: 'Config →',
      jump: function () { host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf', key: 'fwgrp' })); },
      expandLabel: 'Lines ▾' },
    { id: 'fw-season', fw: 'season', ic: '❉', img: 'icons/custom/sn-autumn.png',
      name: 'Season Widget', sub: 'Which season the world is wearing — asked of Seasons of Skyrim itself',
      kw: 'season winter spring summer autumn fall year month calendar seasons of skyrim weather',
      state: function () { return uie.fw.season; },
      toggle: function () { host.toGame && host.toGame('hdWidgetToggle', JSON.stringify({ id: 'season' })); },
      jump: function () { host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf', key: 'season' })); },
      jumpLabel: 'Config →' },
    { id: 'fw-quick', fw: 'quick', ic: '★', img: 'icons/custom/hk-quick-light.png',
      name: 'Quick Items Widget', sub: 'Everything you favourited, with live counts and hotkey digits',
      kw: 'quick items favourites favorites star items counts hotkey digits favourite bar',
      state: function () { return uie.fw.quick; },
      toggle: function () { host.toGame && host.toGame('hdWidgetToggle', JSON.stringify({ id: 'quick' })); },
      jump: function () { host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf', key: 'quick' })); },
      jumpLabel: 'Config →' },
    { id: 'potions', ic: '◍', img: 'icons/custom/hk-potion-browser.png', name: 'Potion Browser', sub: 'Paused popout — search, sort, quick-drink; bindable in Utilities',
      kw: 'potion browser potions drink healing elixir alchemy flask',
      state: function () { return null; },
      chord: 'Bindable — Utilities tab',
      open: function () { host.toGame && host.toGame('hdFire', 'hd-potion-browser'); },
      openLabel: 'Open' },
    /* The Quiver is a placed WINDOW, not a toggle — it has no on/off to chip,
       so it reads like the Potion Browser: how it opens, and a button that
       opens it. `hd-quiver-open` is the seeded ENTRY id (main.cpp's seed
       table), never the `quiver` action verb — OnJsFire looks entries up by
       id and silently warns on a verb. */
    { id: 'quiver', ic: '➶', img: 'icons/custom/hk-quiver.png', name: 'Quiver', sub: 'Ring of every arrow and bolt you carry — damage, poisons, click to nock',
      kw: 'quiver arrows bolts ammo ammunition archery bow crossbow nock',
      state: function () { return null; },
      chord: 'Bindable — Combat tab',
      open: function () { host.toGame && host.toGame('hdFire', 'hd-quiver-open'); },
      openLabel: 'Open' },
    /* Time Dial (2026-08-18): the openable circular wait dial on the HUD
       view. An openable window like the Quiver — no on/off to chip; it
       remembers its own spot and size, so there is nothing to place here.
       `hd-time-dial` is the seeded ENTRY id (main.cpp's seed table). */
    { id: 'timedial', ic: '◷', img: 'icons/custom/hm-time.png', name: 'Time Dial', sub: 'Circular wait dial — drag the ring, time passes in one step',
      kw: 'time dial wait clock pass time skip hours rest until morning',
      state: function () { return null; },
      chord: 'Bindable — Misc tab',
      open: function () { host.toGame && host.toGame('hdFire', 'hd-time-dial'); },
      openLabel: 'Open' },
    /* Super Searcher (2026-08-19): the standalone quick-search widget —
       hd-super.js dresses the omni search as an anchored, scaled, animated
       popup with the panel hidden. The pill is its own enabled flag (view-
       side, in the shelf blob), the note reads the fire-from-anywhere
       binding off the seeded action's trigger, Open tries it right here, and
       Config opens its popup (scale · placement · what shows up · the key). */
    { id: 'supersearch', ic: '⌕', img: 'icons/custom/hm-finder.png', name: 'Super Searcher',
      sub: 'One key, one box — search everything and fire it: hotkeys, spells, people, outfits, your bag',
      kw: 'super searcher search everything find anything quick search spotlight one box search bar',
      /* hd-super.js rides the DEFERRED boot set, so for the first moments of a
         session HDSuper does not exist yet and every control on this row is a
         no-op. The drawer still lists the row (you can see it is there and why
         it is dead); the omni provider skips it, because a search result that
         fires nothing is a dead end with no explanation attached. */
      avail: function () { return !!window.HDSuper; },
      state: function () { return window.HDSuper ? HDSuper.isEnabled() : null; },
      toggle: function () { if (window.HDSuper) HDSuper.setEnabled(!HDSuper.isEnabled()); },
      note: function () {
        if (!window.HDSuper) return '';
        var b = HDSuper.bindLabel();
        return b ? ('Opens from anywhere on ' + b)
                 : 'No key yet — Config → “Bind a key”, and it opens mid-game';
      },
      extra: [
        { label: 'Open', title: 'Open the Super Searcher now',
          run: function () { if (window.HDSuper) HDSuper.open(false); } },
      ],
      jump: function () { if (window.HDSuper) HDSuper.openConfig(); },
      jumpLabel: 'Config →' },
    { id: 'loot', ic: '✧', img: 'icons/custom/hm-loot.png', name: 'Loot Vision', sub: 'Glow the loot worth walking to',
      kw: 'loot vision glow highlight shiny treasure chests corpses valuables',
      state: function () { return uie.loot; },
      toggle: function () { host.toGame && host.toGame('ltToggle'); },
      jump: function () { host.setTab && host.setTab('loot'); },
      jumpLabel: 'Config →' },
  ];

  /* ---- the merged Equipped widget: state, commands, and its expander -----
     (2026-08-19; the HUD side is hud.js wgrp / grpSetMaster / hudGrpCmd.) */
  var GRP_LINES = [
    { key: 'handR', name: 'Right hand', ic: '†', img: 'icons/custom/hd-sword.png' },
    { key: 'handL', name: 'Left hand', ic: '◈', img: 'icons/custom/hd-shield.png' },
    { key: 'voice', name: 'Shout / Power', ic: '≋', img: 'icons/custom/sc-shouts.png' },
  ];
  /* The lines the group actually holds. The HUD lets a player LINK other
     widgets in (hud.grp.keys), so the drawer reads membership from the live
     blob and falls back to the three shipped lines. */
  function grpLineKeys() {
    var ks = uie.grp && uie.grp.keys;
    return (ks && ks.length) ? ks : ['handR', 'handL', 'voice'];
  }
  function grpLineName(k) {
    for (var i = 0; i < GRP_LINES.length; i++) if (GRP_LINES[i].key === k) return GRP_LINES[i];
    return { key: k, name: FW_NAMES[k] || k, ic: '·', img: '' };
  }
  var FW_NAMES = { quick: 'Quick items', quick2: 'My items', lootStatus: 'Loot lamp' };
  /* The master is DERIVED exactly as hud.js's grpAnyOn is — any line on means
     the widget is on — so the two surfaces can never disagree. null while no
     state has arrived, so the row wears no chip rather than a guess. */
  function grpMaster() {
    var known = false, ks = grpLineKeys();
    for (var i = 0; i < ks.length; i++) {
      var v = uie.fw[ks[i]];
      if (v === true) return true;
      if (v === false) known = true;
    }
    return known ? false : null;
  }
  function grpSend(cmd) {
    if (host.toGame) host.toGame('hdWidgetGrp', JSON.stringify(cmd));
  }
  /* OPTIMISTIC chips only — hdUiStateData is the truth and lands as soon as the
     HUD view has applied and saved. Off = every line off; on = the remembered
     set (hud.grp.mem), or all of them when nothing was remembered. That is
     grpSetMaster's own rule, read off the same blob, so the chip that flashes
     for one frame is the chip that stays. */
  function grpOptimistic(on) {
    var ks = grpLineKeys();
    var mem = (uie.grp && uie.grp.mem && uie.grp.mem.length) ? uie.grp.mem : null;
    var any = false;
    ks.forEach(function (k) {
      uie.fw[k] = on ? (mem ? mem.indexOf(k) !== -1 : true) : false;
      if (uie.fw[k]) any = true;
    });
    if (on && !any) ks.forEach(function (k) { uie.fw[k] = true; });
  }
  function eqBtn(label, title, on, run, cls) {
    var b = document.createElement('button');
    b.className = 'hm-eq-btn' + (on ? ' on' : '') + (cls ? ' ' + cls : '');
    b.type = 'button'; b.title = title;
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  }
  function eqGroup(label) {
    var g = document.createElement('div'); g.className = 'hm-eq-grp';
    var l = document.createElement('div'); l.className = 'hm-eq-lab'; l.textContent = label;
    var r = document.createElement('div'); r.className = 'hm-eq-row';
    g.appendChild(l); g.appendChild(r);
    g.row = r;
    return g;
  }
  /* The expander under the Equipped row: per-line switches, orientation, size,
     and the door to the HUD's own shelf. Rebuilt on every render (the drawer
     wipes itself on every state reply), so it always paints from what just
     arrived. */
  function buildEqInline(mount) {
    mount.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'hm-eq';

    /* --- the lines --- */
    var lines = eqGroup('Lines — each one on its own');
    grpLineKeys().forEach(function (k) {
      var def = grpLineName(k);
      var on = uie.fw[k];
      var b = eqBtn(def.name, (on === true ? 'Hide ' : 'Show ') + def.name, on === true, function () {
        host.toGame && host.toGame('hdWidgetToggle', JSON.stringify({ id: k }));
        if (uie.fw[k] !== null && uie.fw[k] !== undefined) uie.fw[k] = !uie.fw[k];
        renderUie();
      }, 'hm-eq-line');
      /* the glyph rides the button, with the mark behind it */
      var ic = document.createElement('span');
      ic.className = 'hm-eq-ic';
      if (def.img) {
        var im = document.createElement('img');
        im.src = def.img; im.alt = ''; im.setAttribute('draggable', 'false');
        im.onerror = function () { im.remove(); ic.textContent = def.ic; };
        ic.appendChild(im);
      } else ic.textContent = def.ic;
      b.insertBefore(ic, b.firstChild);
      var chip = document.createElement('span');
      chip.className = 'hm-eq-state ' + (on === true ? 'on' : on === false ? 'off' : 'unk');
      chip.textContent = on === true ? 'ON' : on === false ? 'OFF' : '—';
      b.appendChild(chip);
      lines.row.appendChild(b);
    });
    wrap.appendChild(lines);

    /* --- orientation --- */
    var orient = (uie.grp && uie.grp.orient === 'horiz') ? 'horiz' : 'vert';
    var og = eqGroup('Orientation');
    og.row.appendChild(eqBtn('↕ Column', 'Stack the lines in a column', orient !== 'horiz', function () {
      grpSend({ op: 'orient', orient: 'vert' });
      if (uie.grp) uie.grp.orient = 'vert';
      renderUie();
    }));
    og.row.appendChild(eqBtn('↔ Row', 'Lay the lines out in a row', orient === 'horiz', function () {
      grpSend({ op: 'orient', orient: 'horiz' });
      if (uie.grp) uie.grp.orient = 'horiz';
      renderUie();
    }));
    wrap.appendChild(og);

    /* --- size: the deck's no-range-input law, same stepper idiom as the HUD's --- */
    var sc = (uie.grp && typeof uie.grp.scale === 'number') ? uie.grp.scale : 1;
    var sg = eqGroup('Size');
    var step = function (which, d) {
      return function () {
        grpSend({ op: 'size', size: which });
        if (uie.grp) {
          var v = which === 'reset' ? 1 : Math.round((sc + d) * 100) / 100;
          uie.grp.scale = Math.max(0.5, Math.min(2.5, v));
        }
        renderUie();
      };
    };
    sg.row.appendChild(eqBtn('−', 'Smaller', false, step('smaller', -0.1), 'hm-eq-sz'));
    var val = document.createElement('span');
    val.className = 'hm-eq-val'; val.title = 'Size of the equipped widget';
    val.textContent = Math.round(sc * 100) + '%';
    sg.row.appendChild(val);
    sg.row.appendChild(eqBtn('＋', 'Bigger', false, step('bigger', 0.1), 'hm-eq-sz'));
    sg.row.appendChild(eqBtn('⟲', 'Back to 100%', false, step('reset', 0), 'hm-eq-sz'));
    wrap.appendChild(sg);

    /* --- welded or separate, and the door to the shelf --- */
    var locked = !(uie.grp && uie.grp.locked === false);
    var mg = eqGroup('On screen');
    mg.row.appendChild(eqBtn(locked ? '⛓ One widget' : '⛓ Separated',
      locked ? 'The lines move and scale as ONE — click to separate them'
             : 'The lines are separate — click to weld them back into one widget',
      locked, function () {
        grpSend({ op: 'lock', on: !locked });
        if (uie.grp) uie.grp.locked = !locked;
        renderUie();
      }));
    mg.row.appendChild(eqBtn('⚙ Configure on screen',
      'Opens the HUD shelf on this widget — linking, per-line size, everything else',
      false, function () {
        host.toGame && host.toGame('hudCfg', JSON.stringify({ op: 'shelf', key: 'fwgrp' }));
      }, 'hm-eq-wide'));
    wrap.appendChild(mg);

    var note = document.createElement('p');
    note.className = 'hm-eq-note';
    note.textContent = 'Turning the widget off remembers which lines were on, and turning it back ' +
      'on restores exactly those. “Configure on screen” hands the screen to the HUD shelf, where ' +
      'every element can be sized, floated and linked together.';
    wrap.appendChild(note);
    mount.appendChild(wrap);
    return true;
  }

  /* THE PILL IS THE SWITCH (Rober, 2026-08-19: "change anything that says turn
     off or on (remove) and just make the on or off pill clickable").

     It used to be a dead <span> beside a "Turn on" / "Turn off" button that
     said the same thing twice — and the button's label inverted the pill's, so
     the row read "ON … Turn off" and you had to stop and parse which was the
     state. One control now: a real <button>, so it is keyboard-focusable and
     carries hover / active / focus states, with a one-shot pop on the flip so
     the click visibly registers before the reply lands.

     `v === null` with a toggle present means "we cannot read this one's state"
     (the Action Bar's bridges live in another view) — the pill still has to be
     pressable, so it says so honestly instead of vanishing and stranding the
     row with no switch at all. */
  /* `hidden` (round 3, 2026-08-19) is the THIRD face: the element is enabled,
     but its own show/hide flag is down, so nothing is on screen. A flat "ON"
     there is the lie Rober caught — "enabled but not showing = broken". The
     pill is still one clickable control; clicking a HIDDEN pill flips the flag
     that is actually holding it down (each row's own toggle decides which). */
  function stateChip(v, toggle, name, hidden) {
    if ((v === null || v === undefined) && !toggle) return null;
    var known = (v === true || v === false);
    /* ⚠ `is-hidden`, NOT `hidden` (2026-08-19): app.css line 10 owns the global
       utility `.hidden { display: none !important; }`, so the old class name
       made this pill invisible — measured 0x0 in chromium. The row that most
       needs a switch (on, but nothing is on screen) was the row that had none. */
    var face = !known ? 'unk' : (hidden ? 'is-hidden' : (v ? 'on' : 'off'));
    var chip = document.createElement(toggle ? 'button' : 'span');
    chip.className = 'hm-uie-state ' + face + (toggle ? ' is-btn' : '');
    chip.textContent = !known ? 'TOGGLE' : (hidden ? 'HIDDEN' : (v ? 'ON' : 'OFF'));
    if (toggle) {
      chip.type = 'button';
      chip.title = !known ? ('Toggle ' + (name || 'this'))
        : hidden ? ((name || 'This') + ' is on but hidden right now — click to show it')
        : ((v ? 'Turn off ' : 'Turn on ') + (name || 'this'));
      chip.setAttribute('aria-pressed', known ? String(!!v && !hidden) : 'mixed');
    }
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
      ic.className = 'hm-uie-ic';
      if (el.img) {
        /* plain path — Ultralight eats a ?v= query. A stale or missing PNG
           removes itself and the typographic mark takes over, so a broken
           file can never leave a broken-image box (the no-emoji law's own
           fallback rule). */
        var uim = document.createElement('img');
        uim.src = el.img; uim.alt = ''; uim.setAttribute('draggable', 'false');
        uim.onerror = function () { uim.remove(); ic.textContent = el.ic; };
        ic.appendChild(uim);
      } else {
        ic.textContent = el.ic;
      }
      row.appendChild(ic);

      var t = document.createElement('div'); t.className = 'hm-uie-t';
      var b = document.createElement('b'); b.textContent = el.name;
      var s = document.createElement('span'); s.textContent = el.sub;
      t.appendChild(b); t.appendChild(s);
      /* the honest "why is it not on screen" line (round 3): a rule holding an
         enabled, shown element back is a CONDITION, not a switch — so it is
         written under the name rather than faked into the pill */
      var why = el.note ? el.note() : '';
      if (why) {
        var wn = document.createElement('span');
        wn.className = 'hm-uie-why';
        wn.textContent = why;
        wn.title = 'The element is on — this rule decides when it is drawn. Change it in its own config.';
        t.appendChild(wn);
      }
      row.appendChild(t);

      /* ⚠ EVERY control of this card goes in ONE group (2026-08-19 design
         pass). They used to be appended straight onto the wrapping row, so a
         card with two actions put one top-RIGHT and the other — the one that
         wrapped — bottom-LEFT under the icon: the two buttons for the same
         element ended up in opposite corners, and the drawer's right edge went
         ragged (measured at 2560: Followers HUD, Wheel Menu, Equipped Widget,
         Potion Browser, Quiver and Time Dial all did it). The group carries
         `margin-left:auto`, so it hugs the right whether it rides line 1 or
         drops whole to line 2, and its own wrap keeps the buttons together.
         Everything below still appends in the same ORDER, and every selector
         in the harness and the sheet reaches these by descent, not by child. */
      var acts = document.createElement('div');
      acts.className = 'hm-uie-acts';

      /* the pill IS the toggle now — never both a pill and a Turn on/off button */
      var chip = stateChip(el.state ? el.state() : null, !el.chord && el.toggle, el.name,
        el.hidden ? el.hidden() : false);
      if (chip) {
        if (!el.chord && el.toggle) chip.addEventListener('click', function () {
          el.toggle();
          /* the pop is one-shot: removed, reflow read, re-added, so a second
             click retriggers it instead of doing nothing (the deck's own
             fw-bump idiom) */
          chip.classList.remove('is-flip');
          void chip.offsetWidth;
          chip.classList.add('is-flip');
          /* optimistic flip where we track the state, so the pill feels instant;
             the chained receiver corrects it when the real reply lands */
          /* ⚠ ROUND 3: the two-flag elements flip the flag their toggle
             actually SENT, or the pill contradicts the screen for a beat and
             then snaps back when the reply lands. Each branch mirrors the C++
             verb exactly. */
          if (el.id === 'hud') {
            if (uie.hud === true && uie.hudVisible === false) uie.hudVisible = true;
            else if (uie.hud !== null) uie.hud = !uie.hud;
          }
          if (el.id === 'loot' && uie.loot !== null) uie.loot = !uie.loot;
          if (el.id === 'hotbar') {
            /* main.cpp HbToggleVisible: the first press ARMS the bar and shows
               it; from then on it is the show/hide flip. */
            if (uie.hotbar === false) { uie.hotbar = true; uie.hotbarVisible = true; }
            else if (uie.hotbarVisible !== null) uie.hotbarVisible = !uie.hotbarVisible;
            else if (uie.hotbar !== null) uie.hotbar = !uie.hotbar;
          }
          if (el.id === 'widgets' && uie.widgets !== null) uie.widgets = !uie.widgets;
          if (el.fw && uie.fw[el.fw] !== null) uie.fw[el.fw] = !uie.fw[el.fw];
          renderUie();
        });
        acts.appendChild(chip);
      }

      /* a chord-only element (Wheel) shows the chord + an Open button, no toggle */
      if (el.chord) {
        var kc = document.createElement('span');
        kc.className = 'hm-uie-chord'; kc.textContent = el.chord;
        kc.title = 'How it opens'; acts.appendChild(kc);
        if (el.open) {
          var ob = document.createElement('button');
          ob.className = 'hm-uie-btn'; ob.type = 'button';
          ob.textContent = el.openLabel || 'Open';
          ob.title = 'Open ' + el.name;
          ob.addEventListener('click', el.open);
          acts.appendChild(ob);
        }
      }
      /* (no Turn on / Turn off button — the pill above IS the switch) */

      /* extra per-row actions (the strip's "On screen →"), before the
         configure button so the row reads left-to-right as do → configure */
      if (el.extra && el.extra.length) {
        el.extra.forEach(function (x) {
          var xb = document.createElement('button');
          xb.className = 'hm-uie-btn'; xb.type = 'button';
          xb.textContent = x.label; xb.title = x.title || x.label;
          xb.addEventListener('click', x.run);
          acts.appendChild(xb);
        });
      }

      /* An element whose PRIMARY configure door is elsewhere (the HUD shelf)
         but which still has something worth doing in place keeps its expander
         as a SECOND button — the Equipped widget's per-line switches. Without
         this the two would fight over one button and the shelf would win, so
         the lines became unreachable from the drawer. */
      if (el.inline && el.expandLabel && el.jump) {
        var eb = document.createElement('button');
        eb.className = 'hm-uie-btn' + (uie.inlineOpen === el.id ? ' on' : '');
        eb.type = 'button';
        eb.textContent = el.expandLabel;
        eb.title = 'Show ' + el.name + '’s own switches right here';
        eb.addEventListener('click', function () {
          uie.inlineOpen = (uie.inlineOpen === el.id) ? null : el.id;
          renderUie();
          if (uie.inlineOpen && host.toGame)
            host.toGame('hudCfg', JSON.stringify({ op: 'state' }));
        });
        acts.appendChild(eb);
      }

      if (el.jump || el.inline) {
        var jb = document.createElement('button');
        var jbInline = el.inline && !el.expandLabel;
        jb.className = 'hm-uie-btn hm-uie-jump' +
          ((jbInline && uie.inlineOpen === el.id) ? ' on' : '');
        jb.type = 'button';
        jb.textContent = el.jumpLabel || 'Config →';
        jb.title = jbInline ? ('Configure ' + el.name + ' right here')
                            : ('Go to where ' + el.name + ' is configured');
        jb.addEventListener('click', function () {
          /* Configure-in-place when the element offers it. The expander is
             STATE (uie.inlineOpen), not a one-off DOM insert: every state
             reply (hudCfgState -> receiveHud) re-runs renderUie, which wipes
             the drawer — a hand-inserted row lived ~50ms and read as "the
             settings button does nothing" (Rober, 2026-08-18, twice). */
          /* …unless the expander already has its own button above
             (expandLabel), in which case THIS button is the real configure
             door and must jump. */
          if (el.inline && !el.expandLabel) {
            uie.inlineOpen = (uie.inlineOpen === el.id) ? null : el.id;
            renderUie();
            /* ONE fresh-state ask per open; the reply repaints via renderUie */
            if (uie.inlineOpen && host.toGame)
              host.toGame('hudCfg', JSON.stringify({ op: 'state' }));
            return;
          }
          if (el.jump) el.jump();
        });
        acts.appendChild(jb);
      }
      if (acts.childNodes.length) row.appendChild(acts);
      body.appendChild(row);
      /* the open expander is rebuilt fresh on every render, so it always
         paints from the state that just arrived */
      if (el.inline && uie.inlineOpen === el.id) {
        var mount = document.createElement('div');
        mount.className = 'hm-uie-inline';
        if (el.inline(mount)) body.appendChild(mount);
        else uie.inlineOpen = null;
      }
    });
  }

  function receiveHud(env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    uie.hud = !!env.enabled;
    /* the strip's own show/hide flag, so this row can tell "off" from
       "on but hidden" the same way the Action Bar's does (round 3) */
    if (typeof env.visible === 'boolean') uie.hudVisible = env.visible;
    if (ui.uieOpen) renderUie();
  }
  function receiveLoot(env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    if (typeof env.enabled === 'boolean') { uie.loot = env.enabled; if (ui.uieOpen) renderUie(); }
  }
  /* hdUiStateData: {hotbar, hud, widgets:{enabled, widgets:{<id>:{enabled}}}}
     — the widgets member is the plugin's own config document, one serializer
     with the wgConfig push (round 3). */
  function receiveUiState(env) {
    env = coerce(env);
    if (!env || typeof env !== 'object') return;
    if (typeof env.hotbar === 'boolean') uie.hotbar = env.hotbar;
    if (typeof env.hotbarVisible === 'boolean') uie.hotbarVisible = env.hotbarVisible;
    if (typeof env.hotbarShowMode === 'string') uie.hotbarMode = env.hotbarShowMode;
    if (typeof env.hotbarEffective === 'boolean') uie.hotbarEff = env.hotbarEffective;
    if (typeof env.hud === 'boolean') uie.hud = env.hud;
    if (typeof env.hudVisible === 'boolean') uie.hudVisible = env.hudVisible;
    var w = env.widgets;
    if (w && typeof w === 'object') {
      if (typeof w.enabled === 'boolean') uie.widgets = w.enabled;
      var ws = w.widgets;
      if (ws && typeof ws === 'object') {
        for (var k in uie.fw) {
          var o = ws[k];
          if (o && typeof o.enabled === 'boolean') uie.fw[k] = o.enabled;
        }
      }
      /* 2026-08-19: the HUD view's own prefs ride this same document as an
         opaque `hud` blob (C++ stores it verbatim), and the merged Equipped
         widget's orientation / size / lock / membership / master-memory live
         in its `grp` key. Reading them here is what lets the drawer show the
         real values instead of guessing — and it costs no new bridge. */
      var hp = w.hud;
      if (hp && typeof hp === 'object' && hp.grp && typeof hp.grp === 'object') {
        var g = hp.grp;
        if (g.orient === 'horiz' || g.orient === 'vert') uie.grp.orient = g.orient;
        if (typeof g.scale === 'number' && isFinite(g.scale)) uie.grp.scale = g.scale;
        if (typeof g.locked === 'boolean') uie.grp.locked = g.locked;
        uie.grp.mem = Array.isArray(g.mem) ? g.mem.slice() : null;
        uie.grp.keys = Array.isArray(g.keys) && g.keys.length ? g.keys.slice() : null;
        uie.grp.known = true;
      }
    }
    if (ui.uieOpen) renderUie();
  }

  /* Lazy-chain the elements' reply receivers, then ask each queryable element
     for fresh state. Chaining on demand (not at parse) means followers-pane /
     loot-pane have already installed their own handlers, so ours forwards to
     them. Shared by the drawer's open and by the omni provider's warm() — the
     search rows carry the same live ON/OFF the drawer does, and warm() is the
     one place in the provider contract allowed to ask a bridge. */
  function askUieState() {
    if (!ui.uieChained) {
      ui.uieChained = true;
      chainReceiver('hudCfgState', receiveHud);
      chainReceiver('ltOpen', receiveLoot);    // carries `enabled`
      chainReceiver('ltResult', receiveLoot);  // toggle reply, also `enabled`
      chainReceiver('hdUiStateData', receiveUiState);  // round 3: real chips
    }
    if (host.toGame) {
      host.toGame('hudCfg', JSON.stringify({ op: 'state' }));  // HUD -> hudCfgState
      host.toGame('ltGet', '');                                // Loot -> ltOpen
      host.toGame('hdUiState', '');                            // -> hdUiStateData
    }
  }

  function toggleUie() {
    ui.uieOpen = !ui.uieOpen;
    setDrawer('uie', ui.uieOpen, function () {
      askUieState();
      renderUie();
    });
  }

  /* Where a search result for an on-screen element LANDS (Shift+Enter): the
     Home tab with the drawer already unfolded, because the drawer is the row's
     own home and arriving at a collapsed one reads as arriving nowhere. */
  function openUieDrawer() {
    if (host.setTab) host.setTab('home');
    if (!ui.uieOpen) toggleUie();
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
    /* omni providers: an "open key" query finds the rebind result, whose run()
       jumps to Home and starts the picker. Test the provider's index directly
       (the omni core is a separate module; here we assert the contract we ship).
       Home registers TWO providers now (home-uie-omni), so the capture keys them
       by id — grabbing "the last one registered" silently tested the wrong one. */
    var provs = (function () {
      var caught = {};
      var real = window.HDOmni;
      window.HDOmni = { register: function (p) { caught[p.id] = p; } };
      registerOmni(); window.HDOmni = real;
      return caught;
    })();
    var okProv = provs.openkey;
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

    /* home-uie-omni: every on-screen element is searchable, by the words a
       player would type, and its Config row runs the element's own door. */
    var uieProv = provs.uielements;
    ok('on-screen elements provider registered',
      !!uieProv && uieProv.tab === 'home' && typeof uieProv.warm === 'function');
    var uieRows = uieProv ? uieProv.index() : [];
    var uieHay = uieRows.map(function (i) {
      return (i.label + ' ' + i.keywords).toLowerCase(); }).join(' ');
    ok('omni indexes the elements nothing else carried',
      uieHay.indexOf('equipped widget') !== -1 && uieHay.indexOf('party frames') !== -1 &&
      uieHay.indexOf('ammo') !== -1);
    ok('every element that can be acted on has a run()',
      uieRows.length > 0 && uieRows.every(function (i) { return typeof i.run === 'function'; }));

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

  /* ------------------------------------ the on-screen elements, searched -- *
   *  home-uie-omni. Every element the deck DRAWS is switched on and configured
   *  inside one collapsed drawer on one tab, and the drawer was in no index at
   *  all: a player who had heard of the Super Searcher and typed its name got
   *  nothing back, while the drawer three feet away held its switch, its key
   *  and its settings.
   *
   *  Each element now answers search with up to three rows — the element
   *  itself (Enter flips it, or opens it where it is a window rather than a
   *  switch), its own extra doors, and its configure door, which lands ON that
   *  element's settings rather than merely on the Home tab. Shift+Enter always
   *  lands on the drawer, unfolded.
   *
   *  index() only READS the flags the drawer already holds, so it stays cheap
   *  on every keystroke; asking the game for them is warm()'s job. */

  /* One element misbehaving must not blank everybody's search results, so the
     per-element hooks are called through this rather than inline — index() runs
     inside the omni's query loop, where a throw costs every other provider. */
  function tryCall(fn, dflt) {
    if (typeof fn !== 'function') return dflt;
    try { return fn(); } catch (e) { return dflt; }
  }

  function uieOmniItems() {
    var items = [];
    UIE.forEach(function (el) {
      if (tryCall(el.avail, true) === false) return;

      var v = tryCall(el.state, null);
      var hidden = (v === true) && tryCall(el.hidden, false) === true;
      /* the same three faces the drawer's pill wears, in words — a row that
         said a flat "On" for an element nothing is drawing would be the exact
         lie the drawer was fixed for on 2026-08-19 */
      var word = (v === true || v === false)
        ? (hidden ? 'On, but hidden' : (v ? 'On' : 'Off')) : '';
      var why = tryCall(el.note, '') || '';
      var kw = (el.kw || '') + ' ' + el.name + ' ' + el.sub +
               ' on screen element widget ui hud overlay';

      var run = null, verb = '';
      if (!el.chord && typeof el.toggle === 'function') {
        run = el.toggle;
        verb = hidden ? 'Enter shows it'
             : v === true ? 'Enter turns it off'
             : v === false ? 'Enter turns it on'
             : 'Enter toggles it';
      } else if (typeof el.open === 'function') {
        run = el.open;
        verb = 'Enter opens it';
      }

      /* detail is assembled from the parts that EXIST, never from a template
         with holes in it — an element with no readable state and no rule note
         still reads as a sentence */
      var parts = [];
      if (word) parts.push(word);
      /* the openable windows say "Bindable — <tab>" in BOTH their chord hint and
         their subtitle, and a detail line that says it twice reads as a bug */
      if (el.chord && String(el.sub).toLowerCase().indexOf('bindable') === -1)
        parts.push(el.chord);
      parts.push(why || el.sub);
      if (verb) parts.push(verb);

      var row = {
        label: el.name,
        detail: parts.join(' · '),
        kind: 'on-screen',
        keywords: kw + ' turn on turn off toggle switch show hide enable disable',
        jump: openUieDrawer,
      };
      if (run) row.run = run;
      items.push(row);

      /* an element's own extra doors (the HUD's roster, the Super Searcher's
         Open) — the drawer offers them as buttons, so search offers them too */
      if (el.extra && el.extra.length) {
        el.extra.forEach(function (x) {
          if (typeof x.run !== 'function') return;
          var lbl = String(x.label || '').replace(/\s*→\s*$/, '');
          items.push({
            label: el.name + ' · ' + lbl,
            detail: x.title || lbl,
            kind: 'on-screen',
            keywords: kw + ' ' + lbl,
            run: x.run,
            jump: openUieDrawer,
          });
        });
      }

      if (typeof el.jump === 'function') {
        items.push({
          label: el.name + ' settings',
          detail: 'Opens where ' + el.name + ' is configured',
          kind: 'setting',
          keywords: kw + ' settings setting configure config options set up setup ' +
                    'customise customize move reposition resize bigger smaller place',
          run: el.jump,
          jump: openUieDrawer,
        });
      }
    });
    return items;
  }

  function registerOmni() {
    if (!window.HDOmni || !HDOmni.register) return;
    HDOmni.register({
      id: 'uielements', label: 'On-screen elements', tab: 'home',
      /* the one place the contract allows a bridge ask — so the rows carry the
         same live ON/OFF the drawer does, instead of guessing from stale flags */
      warm: askUieState,
      setFilter: function () { /* Home has no filter box — the drawer IS the landing */ },
      index: uieOmniItems,
    });
    /* Make the open-key rebind FINDABLE by search (home-open-key). A user
       typing "open key" / "hotkey" / "change key" / "F7" in ⌕ gets a result
       whose Enter runs the rebind flow; Shift+Enter jumps to the Home tab.
       index() reads the live bind so the current key shows in `detail`. */
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
    /* the merged Equipped widget (2026-08-19) — the harness drives the same
       functions the row does */
    _receiveUiState: receiveUiState, _grpMaster: grpMaster,
    _openKeyLabel: openKeyLabel, _registerOmni: registerOmni,
    /* home-uie-omni: the search rows for the on-screen elements, so a harness
       can read them without standing up the whole omni core */
    _uieOmniItems: uieOmniItems, _openUieDrawer: openUieDrawer
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.HomePane.init(); });
} else {
  window.HomePane.init();
}
