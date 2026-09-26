'use strict';
/* ============================== HDSuper — the Super Searcher ==============================
 *
 *  Rober, 2026-08-19: "super searcher … a hotkeyable widget (with some configuration) …
 *  configurable by scale, screen placement etc and that config button should be in
 *  home - ui elements. also configurable (what shows in search) … quick search anything
 *  in f7 menu, followers (names), spells and hook to inventory and show inventory icons
 *  … clicking an inventory item would equip, or use it, esc to close the menu and get
 *  back to normal game. wardrobes, clickable to trigger … an animated popup, something
 *  really visually nice, highly polished."
 *
 *  WHAT THIS IS. A standalone, hotkeyable dress on the deck's EXISTING Omni search —
 *  not a second search engine. One bound key (the seeded "Super Searcher" action's
 *  fire-from-anywhere trigger, or the Home row's Open button) deep-opens the deck
 *  with the panel hidden (body.ss-open, the potion-browser idiom) and the Omni box
 *  restyled, repositioned and rescaled into the widget (hd-super.css). Every Omni
 *  provider is already wired to DO things — hotkeys fire, spells cast (hdOmniCast),
 *  inventory equips/drinks (whAct, the Wheel's verb), outfits wear (wdWear) — so a
 *  click on a result acts, the overlay closes, and you are back in the game. Esc
 *  closes without acting (C++'s guaranteed-Esc palette close is the backstop).
 *
 *  ROUTE-OUT. hd-omni.js close() now reports WHY it closed (setClosedHook):
 *    'jump'            → the player asked for the owning tab — reveal the deck there.
 *    'run'/'esc'/other → done — when this open owned the palette (standalone),
 *                        close it so the game resumes.
 *
 *  CONFIG lives in the shelf blob (state.shelf.supersearch via __hdShelfSlice — the
 *  raw slice C++ round-trips whole, the tabbar/finder/hints precedent), so an older
 *  DLL can never drop it:
 *    { enabled, scale (0.7–1.5), anchor ('tl'…'br'), size ('compact'|'normal'|'tall'),
 *      sources { <providerId>: false } }   — absent source key = shown.
 *  The slice object is re-fetched on EVERY read: hdOpen replaces state.shelf
 *  wholesale, so a cached reference goes stale (documented trap).
 *
 *  ITEM PICTURES. Carried-item rows resolve their render through the same
 *  WardrobePane.itemIconFor index every other surface uses; renders that don't exist
 *  yet are requested via whIcons for the currently VISIBLE inventory results only
 *  (capped — the Wheel's "only what you pinned" law: rendering a whole bag is
 *  measured in minutes). The 'hd-item-icons' event upgrades glyphs in place.
 *
 *  Marker (hd-markers.json view): 'window.HDSuper ='.
 * ========================================================================================= */

var HDSuper = (function () {
  var env = null;   // { closeDeck } — handed over lazily by app.js's hdShowTab router

  var ui = {
    active: false,       // super mode is dressing the omni overlay right now
    standalone: false,   // this open owns the palette (deep-open from gameplay)
    cfgOpen: false,      // the config popup (Home → UI Elements → Config)
    cfgFilter: '',       // sources-list filter-as-you-type
    iconTimer: null,     // debounce for visible-row render requests
    iconAsked: {},       // formId|plugin already requested this open (never re-ask)
    inputHooked: false,  // #omni-input listener installed
    only: '',            // ONLY-MODE: a provider id this open is locked to ('' = the
                         // configured sources). The seeded "Teleport" action opens
                         // us as supersearch@places — every other source is gated
                         // off for that open and the box says what it wants typed.
  };

  /* what the input asks for when locked to one source */
  var ONLY_HINT = {
    places: 'Type a place… crystaldrift, breezehome, whiterun — Enter teleports',
  };
  function onlyHint(id) {
    return ONLY_HINT[id] || ('Search ' + id + '…');
  }

  var ANCHORS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
  var ANCHOR_NAMES = {
    tl: 'top left', tc: 'top', tr: 'top right',
    cl: 'left', cc: 'center', cr: 'right',
    bl: 'bottom left', bc: 'bottom', br: 'bottom right',
  };
  var SIZES = ['compact', 'normal', 'tall'];
  var ENTRY_ID = 'hd-super-search';   // the seeded action this widget opens through

  function $(id) { return document.getElementById(id); }
  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
  }
  function toastSafe(msg) {
    if (typeof toast === 'function') { try { toast(msg); return; } catch (e) {} }
    toGame('hdLog', 'supersearch: ' + msg);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------- config */

  var localCfg = {};   // harness fallback only — in the deck the shelf slice is the truth
  function slice() {
    if (typeof window.__hdShelfSlice === 'function') return window.__hdShelfSlice('supersearch');
    return localCfg;
  }
  /* Live, normalised config. NEVER cache the returned object across turns —
     hdOpen replaces state.shelf wholesale and a kept reference goes stale. */
  function cfg() {
    var s = slice();
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (!(typeof s.scale === 'number' && s.scale >= 0.7 && s.scale <= 1.5)) s.scale = 1;
    if (ANCHORS.indexOf(s.anchor) === -1) s.anchor = 'cc';
    if (SIZES.indexOf(s.size) === -1) s.size = 'normal';
    if (!s.sources || typeof s.sources !== 'object' || Array.isArray(s.sources)) s.sources = {};
    return s;
  }
  function saveCfg() {
    if (typeof window.__hdShelfSave === 'function') window.__hdShelfSave();
  }
  function sourceOn(id) { return cfg().sources[id] !== false; }

  /* the seeded action's entry (bound key lives on its TRIGGER) */
  function entry() {
    try {
      if (typeof state === 'object' && state && Array.isArray(state.entries)) {
        for (var i = 0; i < state.entries.length; i++)
          if (state.entries[i] && state.entries[i].id === ENTRY_ID) return state.entries[i];
      }
    } catch (e) {}
    return null;
  }
  function bindLabel() {
    var e = entry();
    if (e && e.trigger && e.trigger.code) return String(e.trigger.label || 'bound');
    return '';
  }

  /* ------------------------------------------------------- omni plumbing */

  function gate(p) {
    if (!ui.active || !p) return true;
    if (ui.only) return p.id === ui.only;   // locked open: one source, nothing else
    return sourceOn(p.id);
  }

  function onOmniClosed(reason) {
    if (!ui.active) return;
    if (reason === 'jump') { exitSuper(false); return; }   // into the deck, at the target tab
    exitSuper(true);                                       // done — back to the game
  }

  function applyChrome() {
    var c = cfg();
    document.body.classList.add('ss-open');
    document.body.setAttribute('data-ss-anchor', c.anchor);
    document.body.setAttribute('data-ss-size', c.size);
    document.body.style.setProperty('--ss-scale', String(c.scale));
  }
  function clearChrome() {
    document.body.classList.remove('ss-open');
    document.body.removeAttribute('data-ss-anchor');
    document.body.removeAttribute('data-ss-size');
    document.body.style.removeProperty('--ss-scale');
  }

  /* The ⛭ settings button lives in the omni head while super mode is up.
     Injected (idempotent) rather than added to hd-omni.js's template, so the
     classic omni never grows a button that configures a different surface. */
  function injectGear() {
    var head = document.querySelector('#omni-modal .omni-head');
    if (!head || $('ss-gear')) return;
    var b = document.createElement('button');
    b.id = 'ss-gear';
    b.className = 'omni-x';
    b.title = 'Super Searcher settings';
    b.textContent = '⛭';
    b.addEventListener('click', function () { openConfig(); });
    var x = $('omni-close');
    head.insertBefore(b, x || null);
  }

  /* keep the visible inventory rows' renders coming (bounded, deduped) */
  function hookInput() {
    if (ui.inputHooked) return;
    var inp = $('omni-input');
    if (!inp) return;
    ui.inputHooked = true;
    inp.addEventListener('input', function () {
      if (!ui.active) return;
      clearTimeout(ui.iconTimer);
      ui.iconTimer = setTimeout(requestVisibleInvIcons, 300);
    });
  }
  function requestVisibleInvIcons() {
    if (!ui.active || !window.HDOmni || !HDOmni._state) return;
    var flat = HDOmni._state.flat || [];
    var items = [];
    for (var i = 0; i < flat.length && items.length < 16; i++) {
      var row = flat[i];
      if (!row || !row.provider || row.provider.id !== 'inventory') continue;
      var it = row.item || {};
      if (it.icon) continue;                    // already has its picture
      var sn = it.snap || {};
      if (!sn.formId || !sn.plugin) continue;
      var k = String(sn.formId) + '|' + String(sn.plugin);
      if (ui.iconAsked[k]) continue;            // one request per item per open
      ui.iconAsked[k] = 1;
      items.push({ formId: sn.formId, plugin: sn.plugin, name: sn.name || it.label || '' });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
  }

  /* a render batch landed — glyphs upgrade to pictures in place */
  try {
    document.addEventListener('hd-item-icons', function () {
      if (ui.active && window.HDOmni && HDOmni.isOpen()) HDOmni.rerender();
    });
  } catch (e) { /* no DOM in some harnesses */ }

  /* ----------------------------------------------------------- open/close */

  /* opts.only = provider id to lock this open to (the Teleport seed passes 'places') */
  function open(standalone, opts) {
    if (!window.HDOmni) return;
    var c = cfg();
    if (c.enabled === false) {
      toastSafe('Super Searcher is off — turn it on in Home → UI Elements');
      if (standalone) {
        if (env && typeof env.closeDeck === 'function') env.closeDeck();
        else toGame('hdClose');
      }
      return;
    }
    if (ui.active) return;
    ui.active = true;
    ui.standalone = !!standalone;
    ui.only = (opts && opts.only) ? String(opts.only) : '';
    ui.iconAsked = {};
    applyChrome();
    HDOmni.setProviderGate(gate);
    HDOmni.setClosedHook(onOmniClosed);
    if (HDOmni.setBlankNote) {
      HDOmni.setBlankNote(ui.only === 'places'
        ? '↑↓ move · Enter teleport · Esc back to the game'
        : '↑↓ move · Enter fire it · Shift+Enter open its tab · Esc back to the game');
    }
    if (!HDOmni.isOpen()) HDOmni.open('search');
    else HDOmni.rerender();
    if (ui.only) {
      var inp = $('omni-input');
      if (inp) inp.placeholder = onlyHint(ui.only);
      document.body.setAttribute('data-ss-only', ui.only);
    }
    injectGear();
    hookInput();
  }

  /* Already up and asked to open AGAIN locked to one source (the Teleport action
     activated from inside the Super Searcher): swap the lock in place — the box
     empties, says what it wants typed, and only that source answers. Before this
     the router's press-again-to-close guard fired and the deck vanished
     (Rober, 2026-09-21). Returns false when super mode is not active. */
  function relock(only) {
    if (!ui.active || !window.HDOmni) return false;
    ui.only = only ? String(only) : '';
    if (ui.only) document.body.setAttribute('data-ss-only', ui.only);
    else document.body.removeAttribute('data-ss-only');
    if (HDOmni.setBlankNote) {
      HDOmni.setBlankNote(ui.only === 'places'
        ? '↑↓ move · Enter teleport · Esc back to the game'
        : '↑↓ move · Enter fire it · Shift+Enter open its tab · Esc back to the game');
    }
    var inp = $('omni-input');
    if (inp) inp.placeholder = ui.only ? onlyHint(ui.only) : 'Search…';
    if (typeof HDOmni.setQuery === 'function') HDOmni.setQuery('');
    else if (typeof HDOmni.rerender === 'function') HDOmni.rerender();
    if (inp && typeof inp.focus === 'function') { try { inp.focus(); } catch (e) {} }
    return true;
  }

  /* leave super mode. closeDeck=true also closes the palette when this open
     owned it (standalone) — the potion-browser contract. */
  function exitSuper(closeDeck) {
    if (!ui.active) return;
    ui.active = false;
    ui.only = '';
    document.body.removeAttribute('data-ss-only');
    closeConfig();
    clearChrome();
    clearTimeout(ui.iconTimer);
    if (window.HDOmni) {
      HDOmni.setProviderGate(null);
      if (HDOmni.setBlankNote) HDOmni.setBlankNote(null);
      HDOmni.setClosedHook(null);
    }
    var standalone = ui.standalone;
    ui.standalone = false;
    if (closeDeck && standalone) {
      if (env && typeof env.closeDeck === 'function') env.closeDeck();
      /* the pending-deep-open race can open us before app.js hooked the env —
         the bare bridge close is the honest fallback */
      else toGame('hdClose');
    }
  }

  function close(closeDeck) {
    if (!ui.active) return;
    if (window.HDOmni && HDOmni.isOpen()) {
      /* the closed hook routes this through exitSuper */
      HDOmni.close(closeDeck ? 'close' : 'jump');
    } else {
      exitSuper(!!closeDeck);
    }
  }

  /* C++ closed the palette out from under us (Esc's guaranteed close, a
     quick-fire, a deep-open key). body-level dressing must not survive it —
     a leaked ss-open would greet the next F7 with a hidden panel. */
  function onDeckClosed() {
    if (!ui.active) { clearChrome(); return; }
    ui.active = false;
    ui.standalone = false;
    closeConfig();
    clearChrome();
    clearTimeout(ui.iconTimer);
    if (window.HDOmni) {
      HDOmni.setClosedHook(null);     // BEFORE close — this teardown must not re-route
      HDOmni.setProviderGate(null);
      if (HDOmni.setBlankNote) HDOmni.setBlankNote(null);
      if (HDOmni.isOpen()) HDOmni.close();
    }
  }

  /* reveal the deck (keep the palette open) — the bind-key flow uses this so
     the capture modal never sits over a hidden panel */
  function exitToDeck() {
    if (!ui.active) return;
    if (window.HDOmni && HDOmni.isOpen()) HDOmni.close('jump');
    else exitSuper(false);
  }

  /* ------------------------------------------------------- config popup */

  function ensureCfgDom() {
    if ($('hd-super')) return;
    var el = document.createElement('div');
    el.id = 'hd-super';
    el.className = 'hidden';
    document.body.appendChild(el);
    el.addEventListener('mousedown', function (e) {
      if (e.button === 0 && e.target === el) closeConfig();
    });
    /* capture-phase keys while the popup is up: Esc closes IT (and only it) */
    document.addEventListener('keydown', function (e) {
      if (!ui.cfgOpen) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeConfig(); }
    }, true);
  }

  function openConfig() {
    ensureCfgDom();
    ui.cfgOpen = true;
    ui.cfgFilter = '';
    renderConfig();
    $('hd-super').classList.remove('hidden');
    toGame('hdCapture', '1');   // digits must not quick-fire behind the popup
  }

  function closeConfig() {
    if (!ui.cfgOpen) return;
    ui.cfgOpen = false;
    var el = $('hd-super');
    if (el) el.classList.add('hidden');
    /* only release the capture channel when the omni overlay is not the one
       holding it — it claims capture for itself while open */
    if (!(window.HDOmni && HDOmni.isOpen())) toGame('hdCapture', '0');
  }

  function sourceRows() {
    if (!window.HDOmni || typeof HDOmni.providers !== 'function') return [];
    var provs = HDOmni.providers();
    var q = ui.cfgFilter.trim().toLowerCase();
    var rows = [];
    for (var i = 0; i < provs.length; i++) {
      var p = provs[i];
      if (!p || !p.id) continue;
      var label = String(p.label || p.id);
      if (q && label.toLowerCase().indexOf(q) === -1) continue;
      rows.push({ id: p.id, label: label, on: sourceOn(p.id) });
    }
    rows.sort(function (a, b) { return a.label.localeCompare(b.label); });
    return rows;
  }

  function renderConfig() {
    var el = $('hd-super');
    if (!el || !ui.cfgOpen) return;
    var c = cfg();
    var bind = bindLabel();

    var html =
      '<div class="ss-cfg">' +
        '<div class="ss-cfg-head">' +
          '<span class="ss-cfg-glyph">⌕</span>' +
          '<span class="ss-cfg-title">Super Searcher</span>' +
          '<button id="ss-cfg-x" class="ss-cfg-x" title="Close (Esc)">✕</button>' +
        '</div>' +
        '<div class="ss-cfg-sub">One key, one box — search everything you have and fire it. ' +
          'Results act on click: hotkeys fire, spells cast, carried items equip or drink, outfits dress you.</div>' +
        '<div class="ss-cfg-body">' +

        /* ---- enabled + hotkey ---- */
        '<div class="ss-row">' +
          '<div class="ss-row-t"><b>Enabled</b><span>The widget answers its key and the Home row</span></div>' +
          '<button id="ss-en" class="ss-pill' + (c.enabled ? ' on' : '') + '">' +
            (c.enabled ? 'ON' : 'OFF') + '</button>' +
        '</div>' +
        '<div class="ss-row">' +
          '<div class="ss-row-t"><b>Hotkey</b><span>' +
            (bind ? 'Opens from anywhere on <b class="ss-key">' + esc(bind) + '</b>'
                  : 'Unbound — give it a key and it opens from anywhere, mid-game') +
          '</span></div>' +
          '<div class="ss-row-btns">' +
            '<button id="ss-bind" class="ss-btn">' + (bind ? 'Rebind…' : 'Bind a key…') + '</button>' +
            (bind ? '<button id="ss-unbind" class="ss-btn ghost" title="Remove the key">Clear</button>' : '') +
          '</div>' +
        '</div>' +

        /* ---- size ---- */
        '<div class="ss-sect">Size</div>' +
        '<div class="ss-row">' +
          '<div class="ss-row-t"><b>Scale</b><span id="ss-scale-val">' + Math.round(c.scale * 100) + '%</span></div>' +
          '<input id="ss-scale" class="ss-slider" type="range" min="70" max="150" step="5" value="' +
            Math.round(c.scale * 100) + '">' +
        '</div>' +
        '<div class="ss-row">' +
          '<div class="ss-row-t"><b>Height</b><span>How much of the screen the results get</span></div>' +
          '<div class="ss-row-btns">' +
            SIZES.map(function (s) {
              return '<button class="ss-btn ss-size' + (c.size === s ? ' on' : '') + '" data-size="' + s + '">' +
                s.charAt(0).toUpperCase() + s.slice(1) + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +

        /* ---- placement ---- */
        '<div class="ss-sect">Screen placement</div>' +
        '<div class="ss-row ss-row-anchor">' +
          '<div class="ss-row-t"><b>Position</b><span id="ss-anchor-name">' +
            esc(ANCHOR_NAMES[c.anchor] || 'center') + '</span></div>' +
          '<div class="ss-anchor-grid">' +
            ANCHORS.map(function (a) {
              return '<button class="ss-anchor' + (c.anchor === a ? ' on' : '') + '" data-anchor="' + a +
                '" title="' + esc(ANCHOR_NAMES[a]) + '"></button>';
            }).join('') +
          '</div>' +
        '</div>' +

        /* ---- sources ---- */
        '<div class="ss-sect">What shows up</div>' +
        '<div class="ss-src-note">Every search source the deck knows. Untick one and its results stay out of the widget ' +
          '(the deck’s own Ctrl-search keeps showing everything).</div>' +
        '<input id="ss-src-filter" class="ss-filter" type="text" placeholder="Filter sources…" ' +
          'autocomplete="off" spellcheck="false" value="' + esc(ui.cfgFilter) + '">' +
        '<div class="ss-srcs" id="ss-srcs">' + sourceRowsHtml() + '</div>' +

        '</div>' +
        '<div class="ss-cfg-foot">' +
          '<button id="ss-try" class="ss-btn gold">Open it now</button>' +
        '</div>' +
      '</div>';
    el.innerHTML = html;
    wireConfig();
  }

  function sourceRowsHtml() {
    var rows = sourceRows();
    if (!rows.length) {
      return '<div class="ss-src-empty">' +
        (ui.cfgFilter ? 'No source matches that.' : 'Sources appear as the deck finishes loading…') + '</div>';
    }
    return rows.map(function (r) {
      return '<button class="ss-src' + (r.on ? ' on' : '') + '" data-src="' + esc(r.id) + '">' +
        '<span class="ss-src-tick">' + (r.on ? '✓' : '') + '</span>' +
        '<span class="ss-src-l">' + esc(r.label) + '</span>' +
      '</button>';
    }).join('');
  }

  function wireConfig() {
    var el = $('hd-super');
    if (!el) return;
    var xb = $('ss-cfg-x');
    if (xb) xb.addEventListener('click', closeConfig);

    var en = $('ss-en');
    if (en) en.addEventListener('click', function () {
      var c = cfg();
      c.enabled = !c.enabled;
      saveCfg();
      renderConfig();
    });

    var bind = $('ss-bind');
    if (bind) bind.addEventListener('click', function () {
      if (!entry()) {
        toastSafe('The Super Searcher action isn’t seeded yet — relaunch the game once on this build');
        return;
      }
      closeConfig();
      exitToDeck();   // the capture modal must never sit over a hidden panel
      if (typeof window.__hdStartTriggerCapture === 'function')
        window.__hdStartTriggerCapture(ENTRY_ID);
      else toastSafe('Bind it from the Utilities tab — the Super Searcher row’s ⚡');
    });
    var unbind = $('ss-unbind');
    if (unbind) unbind.addEventListener('click', function () {
      var e = entry();
      if (e) { e.trigger = null; saveCfg(); }
      renderConfig();
    });

    var sl = $('ss-scale');
    if (sl) sl.addEventListener('input', function () {
      var v = Math.max(70, Math.min(150, Number(sl.value) || 100)) / 100;
      var c = cfg();
      c.scale = v;
      var lab = $('ss-scale-val');
      if (lab) lab.textContent = Math.round(v * 100) + '%';
      if (ui.active) document.body.style.setProperty('--ss-scale', String(v));   // live preview
      saveCfg();
    });

    el.querySelectorAll('.ss-size').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = cfg();
        c.size = b.dataset.size;
        saveCfg();
        if (ui.active) document.body.setAttribute('data-ss-size', c.size);
        renderConfig();
      });
    });

    el.querySelectorAll('.ss-anchor').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = cfg();
        c.anchor = b.dataset.anchor;
        saveCfg();
        if (ui.active) document.body.setAttribute('data-ss-anchor', c.anchor);
        renderConfig();
      });
    });

    var filt = $('ss-src-filter');
    if (filt) {
      filt.addEventListener('input', function () {
        ui.cfgFilter = filt.value;
        var host = $('ss-srcs');
        if (host) { host.innerHTML = sourceRowsHtml(); wireSources(); }
      });
      filt.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {   // Enter flips the top hit — the fd-ctx idiom
          e.preventDefault();
          var rows = sourceRows();
          if (rows[0]) toggleSource(rows[0].id);
        }
      });
    }
    wireSources();

    var tryb = $('ss-try');
    if (tryb) tryb.addEventListener('click', function () {
      closeConfig();
      if (!ui.active) open(false);
    });
  }

  function toggleSource(id) {
    var c = cfg();
    if (c.sources[id] === false) delete c.sources[id];
    else c.sources[id] = false;
    saveCfg();
    var host = $('ss-srcs');
    if (host) { host.innerHTML = sourceRowsHtml(); wireSources(); }
    if (ui.active && window.HDOmni) {
      /* a source just turned ON mid-open deserves its warm data */
      if (c.sources[id] !== false) {
        var provs = HDOmni.providers();
        for (var i = 0; i < provs.length; i++)
          if (provs[i].id === id && typeof provs[i].warm === 'function') {
            try { provs[i].warm(); } catch (e) {}
          }
      }
      HDOmni.rerender();
    }
  }
  function wireSources() {
    var host = $('ss-srcs');
    if (!host) return;
    host.querySelectorAll('.ss-src').forEach(function (b) {
      b.addEventListener('click', function () { toggleSource(b.dataset.src); });
    });
  }

  /* ------------------------------------------------------------- exports */

  var api = {
    hookInto: function (e) { env = e; },
    hooked: function () { return !!env; },
    open: open,
    close: close,
    isOpen: function () { return ui.active; },
    isEnabled: function () { return cfg().enabled !== false; },
    setEnabled: function (on) { var c = cfg(); c.enabled = on !== false; saveCfg(); },
    bindLabel: bindLabel,
    openConfig: openConfig,
    closeConfig: closeConfig,
    onDeckClosed: onDeckClosed,
    /* test seams */
    _ui: ui,
    _cfg: cfg,
    _gate: gate,
    _onOmniClosed: onOmniClosed,
    _sourceRows: sourceRows,
    relock: relock,
    _toggleSource: toggleSource,
    _requestVisibleInvIcons: requestVisibleInvIcons,
    _setLocalCfg: function (o) { localCfg = o || {}; },
  };

  /* a C++ deep-open raced our (deferred) load — app.js parked it */
  if (window.__hdPendingSuper) {
    /* a string other than '1' is the only-mode source id (supersearch@<id>) */
    var pend = window.__hdPendingSuper;
    delete window.__hdPendingSuper;
    var pendOpts = (typeof pend === 'string' && pend !== '1') ? { only: pend } : undefined;
    if (window.HDCss && typeof HDCss.need === 'function') {
      HDCss.need('super', function () { open(true, pendOpts); });
    } else {
      open(true, pendOpts);
    }
  }

  return api;
})();
window.HDSuper = HDSuper;
