'use strict';
/* ====================================================================== *
 *  HDPotions — the paused potion browser (Rober, 2026-08-15: "A master
 *  hotkey to open a unified potion browser you can pick category of potion,
 *  or specific hotkey for say just health potions. Quick use. In popout.
 *  Freezes game when open." + "sorting by strength, value, and searchable").
 *
 *  The wheel's structural twin: a full-screen overlay in the MAIN deck view
 *  (body.pb-open hides #panel — hd-potions.css), routed through
 *  hdShowTab('potions'[@cat]) so it inherits the whole proven open sequence:
 *  open-if-closed, press-again-to-close with the 700 ms guard (app.js owns
 *  that half). The game pauses because the deck view is FOCUSED — nothing
 *  new; that is every palette surface's law.
 *
 *  Bridge (one name per direction — the deck law):
 *    toGame('pbList')          — "send me every potion I carry + my prefs"
 *    toGame('pbUse',  json)    — {plugin, formId, rt} drink this one NOW
 *    toGame('pbSave', json)    — {sort, cat, favs, scale, ico} persist the
 *                                browser prefs (C++ merges per-key into the
 *                                widgets.json `browser` blob, so new keys
 *                                need no DLL change)
 *  C++ replies (globals; response-style, so no hd-boot stub is needed):
 *    window.pbListData(json)   — {rows:[…], prefs:{sort,cat}}
 *    window.pbUseResult(json)  — {ok, msg, plugin, formId, newCount}
 *    window.pbSaved(json)      — write ack
 *
 *  Row art rides the EXACT items-pane icon idiom: whIcons requests through
 *  the wheel's own listener, WardrobePane.itemIconFor resolution, in-place
 *  upgrades on the 'hd-item-icons' document event, 650 ms settle gate +
 *  2.5 s empty poll — and an honest pool-hued glyph meanwhile.
 * ====================================================================== */
window.HDPotions = (function () {
  var DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[pb dev->game]', fn, arg);
  }
  function coerce(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmt(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ------------------------------------------------------------- state */

  var env = null;   // { closeDeck } — handed over lazily by app.js's router
  var ui = {
    open: false,
    openedAt: 0,
    standalone: false,   // opened by its own key => closing it closes the deck
    cat: 'all',
    sort: 'strength',
    q: '',
    cursor: 0,
    loaded: false,       // pbListData arrived (skeletons until then)
    prefsApplied: false, // session-once: prefs land only until the user chooses
    catForced: false,    // a category deep-open beats the persisted pref
    rows: [],            // the filtered+sorted view of state.rows
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
    iconReq: {},         // session-deduped whIcons requests
    saveT: null,
    toastT: null,
    sheet: '',           // '' | 'ai' | 'smart' | 'combos' | 'view' — the fold-out panel below the pills
    comboEdit: null,     // { id, name, icon, items:[…] } while the editor is open
    comboArm: '',        // id armed for delete (second click confirms)
  };
  var state = { rows: [], waterOk: true, ai: null, smart: null, combos: [],
    /* the favorites shelf: durable identities only ({plugin, formId, name,
       cat}) — count/strength resolve LIVE from state.rows on every paint, so
       a pinned potion can never show stale numbers */
    favs: [],
    /* the ⛭ View knobs — persisted with the other prefs */
    scale: 1,            // whole-popout scale (the overlay sits OUTSIDE #panel, so it self-scales)
    ico: 58 };           // icon plate size in px

  var MAX_FAVS = 24;
  var SCALE_MIN = 0.6, SCALE_MAX = 1.6;
  var ICO_MIN = 40, ICO_MAX = 96;

  /* Every consumable now rides the list (2026-08-15): the four pools, then
     poison / food / drink / water. Drink INCLUDES water by design (a water
     bottle is a drink); Water shows only water and counts its rows' drinks.
     The Water pill hides itself when no water mod is in the load order. */
  var CATS = [
    { id: 'all',     label: 'All',     glyph: '⚗' },
    { id: 'heal',    label: 'Health',  glyph: '❤' },
    { id: 'magicka', label: 'Magicka', glyph: '✦' },
    { id: 'stamina', label: 'Stamina', glyph: '⚡' },
    { id: 'cure',    label: 'Cure',    glyph: '✚' },
    { id: 'poison',  label: 'Poison',  glyph: '☠' },
    { id: 'food',    label: 'Food',    glyph: '🍖' },
    { id: 'drink',   label: 'Drink',   glyph: '🍺' },
    { id: 'water',   label: 'Water',   glyph: '💧' },
    { id: 'other',   label: 'Other',   glyph: '◇' },
  ];
  var SORTS = [
    { id: 'strength', label: 'Strength' },
    { id: 'value',    label: 'Value' },
    { id: 'name',     label: 'Name' },
    { id: 'count',    label: 'Count' },
  ];
  var GLYPH = { heal: '❤', magicka: '✦', stamina: '⚡', cure: '✚',
                poison: '☠', food: '🍖', drink: '🍺', water: '💧', other: '◇' };

  /* Which rows a pill claims — 'drink' includes water, 'all' everything. */
  function inCat(row, cat) {
    if (cat === 'all') return true;
    if (cat === 'drink') return row.cat === 'drink' || row.cat === 'water';
    return row.cat === cat;
  }

  /* The honest verb per category: quick-using a poison APPLIES it to your
     equipped weapon (the same EquipObject the game's own poison flow runs);
     food is eaten; everything else is drunk. */
  function verbFor(cat) {
    if (cat === 'poison') return { label: 'Apply', title: 'Apply this poison to your equipped weapon' };
    if (cat === 'food')   return { label: 'Eat',   title: 'Eat it now' };
    return { label: 'Drink', title: 'Drink it now — the strongest read of a quick sip' };
  }

  /* --------------------------------------------------------------- dom */

  var root = null, listEl = null, qEl = null, pillsEl = null, sortsEl = null,
      countEl = null, toastEl = null, sheetEl = null, shelfListEl = null;

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'hd-potions';
    root.innerHTML =
      '<div class="pb-wrap">' +
      /* the favorites wing — the deck shelf's spirit, in the pb- namespace
         (a pane may never reuse the deck skeleton's classes) */
      '<div id="pb-shelf" class="pb-shelf">' +
        '<div class="pb-shelf-head"><span class="t">★ Favorites</span>' +
          '<span id="pb-shelf-n" class="pb-shelf-n"></span></div>' +
        '<div id="pb-shelf-list" class="pb-shelf-list"></div>' +
        '<div class="pb-shelf-foot">☆ on any potion pins it here for quick use</div>' +
      '</div>' +
      '<div class="pb-box">' +
        '<div class="pb-head">' +
          '<span class="pb-title">⚗ Potion Browser</span>' +
          '<span id="pb-count" class="pb-count"></span>' +
          '<button id="pb-x" class="pb-x" type="button" title="Close (Esc)">✕</button>' +
        '</div>' +
        '<div class="pb-controls">' +
          '<div class="pb-qrow"><span class="g">⌕</span>' +
            '<input id="pb-q" type="text" autocomplete="off" spellcheck="false" ' +
              'placeholder="Search your potions — Enter drinks the top one">' +
          '</div>' +
          '<div id="pb-pills" class="pb-pills"></div>' +
          '<div id="pb-sorts" class="pb-sorts"></div>' +
          '<div class="pb-tools">' +
            '<button id="pb-ai-btn" class="pb-tool" type="button" ' +
              'title="Automatic potion drinker — thresholds for health, magicka and stamina">' +
              '⚕ Potion AI <span id="pb-ai-state" class="pb-tool-state">off</span></button>' +
            '<button id="pb-smart-btn" class="pb-tool" type="button" ' +
              'title="How the smart potion buttons choose — least waste, top off, or always the strongest">' +
              '⚖ Smart picking <span id="pb-smart-state" class="pb-tool-state"></span></button>' +
            '<button id="pb-combo-btn" class="pb-tool" type="button" ' +
              'title="Quick-drink several potions with one press — saved combos become deck actions">' +
              '⧉ Combos <span id="pb-combo-n" class="pb-tool-state"></span></button>' +
            '<button id="pb-view-btn" class="pb-tool" type="button" ' +
              'title="Size the browser — panel scale and icon size, remembered">⛭ View</button>' +
          '</div>' +
        '</div>' +
        '<div id="pb-sheet" class="pb-sheet" hidden></div>' +
        '<div id="pb-list" class="pb-list"></div>' +
        '<div class="pb-foot">Enter = drink the highlighted one · ↑↓ move · ☆ pins a favorite · Esc clears the search, then closes</div>' +
        '<div id="pb-toast" class="pb-toast" role="status"></div>' +
      '</div>' +
      '</div>';
    document.body.appendChild(root);
    listEl = document.getElementById('pb-list');
    shelfListEl = document.getElementById('pb-shelf-list');
    qEl = document.getElementById('pb-q');
    pillsEl = document.getElementById('pb-pills');
    sortsEl = document.getElementById('pb-sorts');
    countEl = document.getElementById('pb-count');
    toastEl = document.getElementById('pb-toast');

    document.getElementById('pb-x').addEventListener('click', function () { close(true); });
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(true); });
    sheetEl = document.getElementById('pb-sheet');
    document.getElementById('pb-ai-btn').addEventListener('click', function () {
      setSheet(ui.sheet === 'ai' ? '' : 'ai');
    });
    document.getElementById('pb-smart-btn').addEventListener('click', function () {
      setSheet(ui.sheet === 'smart' ? '' : 'smart');
    });
    document.getElementById('pb-combo-btn').addEventListener('click', function () {
      setSheet(ui.sheet === 'combos' ? '' : 'combos');
    });
    document.getElementById('pb-view-btn').addEventListener('click', function () {
      setSheet(ui.sheet === 'view' ? '' : 'view');
    });
    applyView();

    qEl.addEventListener('input', function () {
      ui.q = qEl.value;
      ui.cursor = 0;
      renderList();
      scheduleIcons();
    });

    /* Capture-phase so the deck's own key handling never sees keys meant for
       the browser (the hb-cap idiom). Active only while open. */
    document.addEventListener('keydown', onKey, true);

    /* renders land whenever the framework gets to them — upgrade in place */
    document.addEventListener('hd-item-icons', upgradeArt);

    renderPills();
    renderSorts();
  }

  function onKey(e) {
    if (!ui.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      /* peel back a layer at a time: combo editor → open sheet → query → close */
      if (ui.comboEdit) { ui.comboEdit = null; renderSheet(); return; }
      if (ui.sheet) { setSheet(''); return; }
      if (ui.q) { qEl.value = ''; ui.q = ''; ui.cursor = 0; renderList(); return; }
      close(true);
      return;
    }
    /* keys born inside the sheet (the AI steppers, the combo editor's own
       search/basket) belong to the sheet's controls — the list must not
       drink on the combo editor's Enter. */
    if (sheetEl && e.target && sheetEl.contains(e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      ui.cursor = clamp(ui.cursor + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, ui.rows.length - 1));
      renderList();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      var r = ui.rows[clamp(ui.cursor, 0, ui.rows.length - 1)];
      if (r) drink(r);
    }
  }

  /* ------------------------------------------------------------- icons */
  /* The items-pane idiom, verbatim in spirit: resolve through WardrobePane's
     ONE key normalisation, request through the wheel's whIcons listener,
     settle 650 ms so keystroke churn never floods the render queue, then a
     bounded empty poll while drawn rows still lack art. */

  var ICON_SETTLE_MS = 650;
  var ICON_POLL_MS = 2500;
  var ICON_POLL_MAX = 24;

  function idParts(r) {
    if (!r || !r.plugin || !r.formId || r.formId === '0x0') return null;
    return { formId: String(r.formId), plugin: String(r.plugin) };
  }
  function iconFor(r) {
    var p = idParts(r);
    if (!p) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      var path = WardrobePane.itemIconFor(p) || '';
      if (!path) return '';
      if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }
  function missingArt() {
    for (var i = 0; i < ui.rows.length; i++)
      if (idParts(ui.rows[i]) && !iconFor(ui.rows[i])) return true;
    return false;
  }
  function requestIcons() {
    var items = [], seen = {};
    function want(r) {
      if (items.length >= 80) return;
      var p = idParts(r);
      if (!p) return;
      var key = p.formId + '|' + p.plugin;
      if (ui.iconReq[key] || seen[key]) return;
      if (iconFor(r)) return;
      seen[key] = 1;
      ui.iconReq[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: r.name || '' });
    }
    for (var i = 0; i < ui.rows.length; i++) want(ui.rows[i]);
    /* shelf pins render too — a favorite you are not carrying right now still
       deserves its picture next time you are */
    for (var f = 0; f < state.favs.length; f++) want(state.favs[f]);
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
  }
  function scheduleIcons() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!ui.rows.length) { stopIconPoll(); return; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.open) return;
      requestIcons();
      startIconPoll();
    }, ICON_SETTLE_MS);
  }
  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }
  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    if (!missingArt()) return;
    ui.iconPollT = setInterval(function () {
      if (!ui.open || !missingArt() || ++ui.iconPollN > ICON_POLL_MAX) { stopIconPoll(); return; }
      toGame('whIcons', JSON.stringify({ items: [] }));
    }, ICON_POLL_MS);
  }
  /* A landed render upgrades its plate IN PLACE — no list rebuild, so the
     cursor and scroll stay put. onerror removes a dead path (never a broken
     box; plain src, never ?v= — Ultralight eats the query). */
  function upgradeArt() {
    if (!ui.open) return;
    function mount(plate, r) {
      if (!r || plate.querySelector('img.pb-art')) return;
      var url = iconFor(r);
      if (!url) return;
      var img = document.createElement('img');
      img.className = 'pb-art';
      img.alt = '';
      img.draggable = false;
      img.onerror = (function (node) { return function () { if (node.parentNode) node.parentNode.removeChild(node); }; })(img);
      img.src = url;
      plate.appendChild(img);
    }
    if (listEl) {
      var plates = listEl.querySelectorAll('.pb-plate[data-rid]');
      for (var i = 0; i < plates.length; i++)
        mount(plates[i], rowById(plates[i].getAttribute('data-rid')));
    }
    /* the shelf's plates carry the fav's own identity — a pin whose potion is
       not in the bag right now still shows its render */
    if (shelfListEl) {
      var sp = shelfListEl.querySelectorAll('.pb-plate[data-fi]');
      for (var k = 0; k < sp.length; k++)
        mount(sp[k], state.favs[parseInt(sp[k].getAttribute('data-fi'), 10)]);
    }
  }

  /* -------------------------------------------- favorites (the ★ shelf) */
  /* Identity-only pins, the combo rule: dynamic forms (formId 0x0) cannot
     survive a save/load, so they cannot be pinned either. Counts, effects
     and the verb resolve LIVE from state.rows at paint time. */

  function favKey(r) { return (r.plugin || '') + '|' + (r.formId || ''); }
  function favIndex(r) {
    var k = favKey(r);
    for (var i = 0; i < state.favs.length; i++)
      if (favKey(state.favs[i]) === k) return i;
    return -1;
  }
  function isFav(r) { return favIndex(r) !== -1; }
  function sanitizeFavs(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < MAX_FAVS; i++) {
      var f = list[i];
      if (!f || typeof f !== 'object') continue;
      if (!f.plugin || !f.formId || f.formId === '0x0') continue;
      out.push({ plugin: String(f.plugin), formId: String(f.formId),
                 name: String(f.name || 'Potion'), cat: String(f.cat || 'other') });
    }
    return out;
  }
  function liveRowFor(f) {
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (r.plugin === f.plugin && r.formId === f.formId) return r;
    }
    return null;
  }
  function toggleFav(r) {
    var i = favIndex(r);
    if (i !== -1) {
      state.favs.splice(i, 1);
      toast('Unpinned ' + (r.name || 'it'));
    } else {
      if (!r.plugin || !r.formId || r.formId === '0x0') {
        toast('That one is dynamic — it can\'t survive a save/load, so it can\'t be pinned');
        return;
      }
      if (state.favs.length >= MAX_FAVS) {
        toast('The shelf holds ' + MAX_FAVS + ' — unpin something first');
        return;
      }
      state.favs.push({ plugin: r.plugin, formId: r.formId,
                        name: r.name || 'Potion', cat: r.cat || 'other' });
      toast('Pinned ' + (r.name || 'it') + ' to the shelf');
    }
    renderShelf();
    renderList();     // the row's star flips
    scheduleIcons();  // a fresh pin may still need its render
    savePrefsSoon();
  }

  function renderShelf() {
    if (!shelfListEl) return;
    var nEl = document.getElementById('pb-shelf-n');
    if (nEl) nEl.textContent = state.favs.length ? String(state.favs.length) : '';
    if (!state.favs.length) {
      shelfListEl.innerHTML = '<div class="pb-shelf-empty">Nothing pinned yet.<br>' +
        'Hit the <b>☆</b> on any potion to keep it here for quick use.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < state.favs.length; i++) {
      var f = state.favs[i];
      var live = liveRowFor(f);
      var count = live ? (live.count | 0) : 0;
      var cat = live ? live.cat : f.cat;
      var verb = verbFor(cat);
      var dry = !(count > 0);
      html += '<div class="pb-shelf-row' + (dry ? ' is-dry' : '') + '" data-fi="' + i + '" ' +
          'title="' + esc(f.name) + (dry ? ' — none in your bag right now' : ' — click to ' + verb.label.toLowerCase() + ' it') + '">' +
        '<div class="pb-plate c-' + esc(cat || 'other') + '" data-fi="' + i + '">' +
          (GLYPH[cat] || GLYPH.other) + '</div>' +
        '<div class="pb-swhat">' +
          '<div class="pb-snm">' + esc(f.name) + '</div>' +
          '<div class="pb-sct">' + (dry ? 'none left' : 'x' + fmt(count) + (live && live.fx ? ' · ' + esc(live.fx) : '')) + '</div>' +
        '</div>' +
        '<button class="pb-mini pb-sx" type="button" data-fi="' + i + '" title="Unpin it">✕</button>' +
      '</div>';
    }
    shelfListEl.innerHTML = html;
    upgradeArt();   // pins whose renders exist paint immediately
    var rows = shelfListEl.querySelectorAll('.pb-shelf-row');
    for (var k = 0; k < rows.length; k++) {
      (function (node) {
        var f = state.favs[parseInt(node.getAttribute('data-fi'), 10)];
        if (!f) return;
        node.addEventListener('click', function () {
          var live = liveRowFor(f);
          if (!live || !(live.count > 0)) { toast('None of ' + f.name + ' in your bag'); return; }
          drink(live);
        });
        var x = node.querySelector('.pb-sx');
        if (x) x.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleFav(f);
        });
      })(rows[k]);
    }
  }

  /* ------------------------------------------------ the ⛭ View knobs */
  /* The overlay hangs off document.body — OUTSIDE #panel's --ui-scale
     transform — so it self-scales (the 2026-08-14 vh/vw audit's rule): the
     wrap carries the transform and the box divides its own viewport units by
     the scale so the SCALED result still fits the screen. */

  function applyView() {
    if (!root) return;
    state.scale = clamp(Number(state.scale) || 1, SCALE_MIN, SCALE_MAX);
    state.ico = clamp(Math.round(Number(state.ico) || 58), ICO_MIN, ICO_MAX);
    root.style.setProperty('--pb-scale', String(state.scale));
    root.style.setProperty('--pb-ico', state.ico + 'px');
  }

  /* ----------------------------------------------------- filter + sort */

  function rid(r) { return (r.plugin || '') + '|' + (r.formId || '') + '|' + (r.rt || 0); }
  function rowById(id) {
    for (var i = 0; i < state.rows.length; i++)
      if (rid(state.rows[i]) === id) return state.rows[i];
    return null;
  }

  function catCount(cat) {
    var n = 0;
    for (var i = 0; i < state.rows.length; i++)
      if (inCat(state.rows[i], cat)) n++;
    return n;
  }

  function compute() {
    var q = ui.q.trim().toLowerCase();
    var out = [];
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (!inCat(r, ui.cat)) continue;
      if (q) {
        var n = String(r.name || '').toLowerCase();
        var fx = String(r.fx || '').toLowerCase();
        var score = -1;
        if (n.indexOf(q) === 0) score = 0;
        else if (n.indexOf(q) !== -1) score = 1;
        else if (fx.indexOf(q) !== -1) score = 2;
        if (score < 0) continue;
        r._s = score;
      } else {
        r._s = 0;
      }
      out.push(r);
    }
    out.sort(function (a, b) {
      if (a._s !== b._s) return a._s - b._s;     // better search hit first
      var d = 0;
      if (ui.sort === 'strength')   d = (b.strength || 0) - (a.strength || 0);
      else if (ui.sort === 'value') d = (b.value || 0) - (a.value || 0);
      else if (ui.sort === 'count') d = (b.count || 0) - (a.count || 0);
      if (d) return d;
      var an = String(a.name || '').toLowerCase(), bn = String(b.name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    ui.rows = out;
  }

  /* ------------------------------------------------------------ render */

  function renderPills() {
    if (!pillsEl) return;
    pillsEl.innerHTML = '';
    CATS.forEach(function (c) {
      /* no water mod => no Water pill; strays stay reachable under Drink */
      if (c.id === 'water' && state.waterOk === false) return;
      var n = ui.loaded ? catCount(c.id) : null;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-pill' + (ui.cat === c.id ? ' is-on' : '');
      b.setAttribute('data-cat', c.id);
      b.title = c.id === 'all'    ? 'Everything you can eat, drink or apply' :
                c.id === 'poison' ? 'Only poisons — Apply coats your equipped weapon' :
                c.id === 'food'   ? 'Only food' :
                c.id === 'drink'  ? 'Every drink — ale, mead, wine, tea, milk… water included' :
                c.id === 'water'  ? 'Only fresh water — the count is bottles; each row names its drinks' :
                                    ('Only ' + c.label.toLowerCase() + ' potions');
      b.innerHTML = c.glyph + ' ' + esc(c.label) + (n === null ? '' : ' <span class="c">' + fmt(n) + '</span>');
      b.addEventListener('click', function () {
        ui.cat = c.id;
        ui.cursor = 0;
        ui.catForced = true;
        renderPills();
        renderList();
        scheduleIcons();
        savePrefsSoon();
      });
      pillsEl.appendChild(b);
    });
  }

  function renderSorts() {
    if (!sortsEl) return;
    sortsEl.innerHTML = '';
    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Sort by';
    sortsEl.appendChild(lbl);
    SORTS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-sort' + (ui.sort === s.id ? ' is-on' : '');
      b.setAttribute('data-sort', s.id);
      b.title = 'Strongest, priciest, A-Z or biggest stack first';
      b.textContent = s.label;
      b.addEventListener('click', function () {
        ui.sort = s.id;
        ui.cursor = 0;
        renderSorts();
        renderList();
        savePrefsSoon();
      });
      sortsEl.appendChild(b);
    });
  }

  function markUp(text, q) {
    var t = esc(text);
    if (!q) return t;
    var i = String(text || '').toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return t;
    var raw = String(text || '');
    return esc(raw.slice(0, i)) + '<mark>' + esc(raw.slice(i, i + q.length)) + '</mark>' + esc(raw.slice(i + q.length));
  }

  function skeletons(n) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<div class="pb-skel-row"><div class="pb-skel pb-skel-ico"></div>' +
        '<div class="pb-skel-txt"><div class="pb-skel pb-skel-l1"></div><div class="pb-skel pb-skel-l2"></div></div></div>';
    }
    return out;
  }

  function renderList() {
    if (!listEl) return;
    compute();
    if (!ui.loaded) {
      listEl.innerHTML = skeletons(6);
      if (countEl) countEl.textContent = '';
      return;
    }
    if (countEl) {
      var total = 0;
      for (var t = 0; t < state.rows.length; t++) total += state.rows[t].count || 0;
      countEl.textContent = fmt(state.rows.length) + ' kinds · ' + fmt(total) + ' bottles';
    }
    if (!ui.rows.length) {
      var catLbl = (CATS.filter(function (c) { return c.id === ui.cat; })[0] || {}).label || '';
      listEl.innerHTML = '<div class="pb-empty">' +
        (ui.q
          ? 'Nothing matches <b>' + esc(ui.q) + '</b>' + (ui.cat !== 'all' ? ' among your ' + esc(catLbl.toLowerCase()) + ' potions' : '') + '.'
          : 'No ' + (ui.cat === 'all' ? '' : esc(catLbl.toLowerCase()) + ' ') + 'potions in your bag — go brew something.') +
        '</div>';
      return;
    }
    ui.cursor = clamp(ui.cursor, 0, ui.rows.length - 1);
    var q = ui.q.trim();
    var html = '';
    for (var i = 0; i < ui.rows.length; i++) {
      var r = ui.rows[i];
      var gone = !(r.count > 0);
      var id = rid(r);
      var verb = verbFor(r.cat);
      var rowTitle = r.cat === 'poison'
        ? (r.name || '') + ' — applying it coats your EQUIPPED weapon'
        : (r.name || '');
      var fxLine = gone ? 'none left' : esc(r.fx || '');
      if (!gone && r.cat === 'water' && r.drinks > 0)
        fxLine = esc(String(r.drinks) + ' drink' + (r.drinks === 1 ? '' : 's') + ' each') +
                 (r.fx ? ' · ' + esc(r.fx) : '');
      html += '<div class="pb-row' + (i === ui.cursor ? ' is-cursor' : '') + (gone ? ' is-gone' : '') +
          '" data-rid="' + esc(id) + '" data-i="' + i + '" title="' + esc(rowTitle) + '">' +
        '<div class="pb-plate c-' + esc(r.cat || 'other') + '" data-rid="' + esc(id) + '">' +
          (GLYPH[r.cat] || GLYPH.other) + '</div>' +
        '<div class="pb-what">' +
          '<div class="pb-nm">' + markUp(r.name || 'Potion', q) + '</div>' +
          '<div class="pb-fx">' + fxLine + '</div>' +
        '</div>' +
        '<div class="pb-meta">' +
          '<span class="pb-str" title="Strength — the biggest helpful magnitude">✧ <b>' + fmt(r.strength || 0) + '</b></span>' +
          '<span class="pb-val" title="Gold value">🜚 ' + fmt(r.value || 0) + '</span>' +
          '<span class="pb-cnt" title="How many you carry">x' + fmt(r.count || 0) + '</span>' +
        '</div>' +
        (canBar(r)
          ? '<button class="pb-bar' + (isBarred(r) ? ' is-on' : '') + '" type="button" data-i="' + i + '" ' +
              'title="' + (isBarred(r)
                ? 'Let the smart buttons pick this one again'
                : 'Never let the smart buttons or the Potion AI pick this one') + '">' +
              (isBarred(r) ? '🚫' : '⃠') + '</button>'
          : '') +
        '<button class="pb-star' + (isFav(r) ? ' is-on' : '') + '" type="button" data-i="' + i + '" ' +
          'title="' + (isFav(r) ? 'Unpin from the favorites shelf' : 'Pin to the favorites shelf') + '">' +
          (isFav(r) ? '★' : '☆') + '</button>' +
        '<button class="pb-drink" type="button" data-i="' + i + '"' + (gone ? ' disabled' : '') +
          ' title="' + esc(verb.title) + '">' + esc(verb.label) + '</button>' +
      '</div>';
    }
    listEl.innerHTML = html;
    upgradeArt();   // renders already on disk paint immediately

    /* delegation would survive the innerHTML rebuild, but the rebuild is the
       render — wire per-row, it is a short list by nature */
    var rows = listEl.querySelectorAll('.pb-row');
    for (var k = 0; k < rows.length; k++) {
      (function (node) {
        node.addEventListener('mouseenter', function () {
          var idx = parseInt(node.getAttribute('data-i'), 10);
          if (isNaN(idx) || idx === ui.cursor) return;
          var cur = listEl.querySelector('.pb-row.is-cursor');
          if (cur) cur.classList.remove('is-cursor');
          ui.cursor = idx;
          node.classList.add('is-cursor');
        });
        node.addEventListener('dblclick', function () {
          var r = ui.rows[parseInt(node.getAttribute('data-i'), 10)];
          if (r) drink(r);
        });
      })(rows[k]);
    }
    var btns = listEl.querySelectorAll('.pb-drink');
    for (var m = 0; m < btns.length; m++) {
      (function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = ui.rows[parseInt(b.getAttribute('data-i'), 10)];
          if (r) drink(r);
        });
      })(btns[m]);
    }
    var stars = listEl.querySelectorAll('.pb-star');
    for (var s = 0; s < stars.length; s++) {
      (function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = ui.rows[parseInt(b.getAttribute('data-i'), 10)];
          if (r) toggleFav(r);
        });
      })(stars[s]);
    }
    var bars = listEl.querySelectorAll('.pb-bar');
    for (var bi = 0; bi < bars.length; bi++) {
      (function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = ui.rows[parseInt(b.getAttribute('data-i'), 10)];
          if (r) toggleBar(r);
        });
      })(bars[bi]);
    }
    var curNode = listEl.querySelector('.pb-row.is-cursor');
    if (curNode && curNode.scrollIntoView) curNode.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------- verbs */

  function drink(r) {
    if (!r || !(r.count > 0)) return;
    toGame('pbUse', JSON.stringify({ plugin: r.plugin || '', formId: r.formId || '', rt: r.rt || 0 }));
    /* DEV harness fallback: fake the reply so the flow is walkable */
    if (DEV && typeof window.pbUse !== 'function') {
      var self = r;
      setTimeout(function () {
        window.pbUseResult({ ok: true, msg: 'Drank ' + (self.name || 'potion'),
          plugin: self.plugin, formId: self.formId, newCount: (self.count | 0) - 1 });
      }, 0);
    }
  }

  /* `bad` dresses the toast as a refusal (the hud's own idiom) — a combo that
     could not fire must not read like one that did. */
  function toast(msg, bad) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-bad', !!bad);
    toastEl.classList.add('is-on');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1700);
  }

  function savePrefsSoon() {
    if (ui.saveT) clearTimeout(ui.saveT);
    ui.saveT = setTimeout(function () {
      ui.saveT = null;
      /* C++ merges per-key, so a partial save never clobbers what it omits.
         Until the stored prefs have LANDED (prefsApplied), favs/scale/ico in
         this session are just defaults — sending them would overwrite the
         real shelf with an empty one if a pill is clicked inside the
         pbListData round-trip window (2026-08-19 verification-swarm find). */
      var p = { sort: ui.sort, cat: ui.cat };
      if (ui.prefsApplied) { p.favs = state.favs; p.scale = state.scale; p.ico = state.ico; }
      toGame('pbSave', JSON.stringify(p));
    }, 400);
  }

  /* ----------------------------------------------- Potion AI (⚕ sheet) */
  /* C++ owns the tick and the clamps; this sheet only edits the numbers.
     Saved through the SAME pbSave contract with an extra `ai` key — C++
     peels it off into the real config, sort/cat behave exactly as before. */

  function aiDefaults() {
    return { enabled: false, combatOnly: false, notify: true, cooldownMs: 2500,
      stats: { health: { on: true, pct: 25 }, magicka: { on: false, pct: 20 },
               stamina: { on: false, pct: 15 } } };
  }
  function aiCfg() {
    if (!state.ai || typeof state.ai !== 'object') state.ai = aiDefaults();
    if (!state.ai.stats || typeof state.ai.stats !== 'object') state.ai.stats = aiDefaults().stats;
    return state.ai;
  }
  var aiSaveT = null;
  function aiSave() {
    updateTools();
    if (aiSaveT) clearTimeout(aiSaveT);
    aiSaveT = setTimeout(function () {
      aiSaveT = null;
      toGame('pbSave', JSON.stringify({ sort: ui.sort, cat: ui.cat, ai: aiCfg() }));
    }, 350);
  }

  function updateTools() {
    var st = document.getElementById('pb-ai-state');
    if (st) {
      var on = !!(state.ai && state.ai.enabled);
      st.textContent = on ? 'on' : 'off';
      st.className = 'pb-tool-state' + (on ? ' is-on' : '');
    }
    var sm = document.getElementById('pb-smart-state');
    if (sm) {
      var s = smartCfg();
      sm.textContent = s.optimal ? (s.preferOverheal ? 'top off' : 'least waste') : 'strongest';
      sm.className = 'pb-tool-state is-on';
    }
    var cn = document.getElementById('pb-combo-n');
    if (cn) cn.textContent = state.combos.length ? String(state.combos.length) : '';
    var ab = document.getElementById('pb-ai-btn');
    if (ab) ab.classList.toggle('is-open', ui.sheet === 'ai');
    var sb = document.getElementById('pb-smart-btn');
    if (sb) sb.classList.toggle('is-open', ui.sheet === 'smart');
    var cb = document.getElementById('pb-combo-btn');
    if (cb) cb.classList.toggle('is-open', ui.sheet === 'combos');
    var vb = document.getElementById('pb-view-btn');
    if (vb) vb.classList.toggle('is-open', ui.sheet === 'view');
  }

  function setSheet(which) {
    ui.sheet = which || '';
    if (ui.sheet !== 'combos') { ui.comboEdit = null; ui.comboArm = ''; }
    renderSheet();
    updateTools();
  }

  /* ▲▼ steppers, never <input type=range> — the deck law. */
  function stepperHtml(id, text) {
    return '<span class="pb-step" data-step="' + id + '">' +
      '<button type="button" class="pb-step-dn" title="Lower">▼</button>' +
      '<b class="pb-step-v">' + esc(text) + '</b>' +
      '<button type="button" class="pb-step-up" title="Raise">▲</button></span>';
  }
  function wireStepper(box, id, get, set, fmtV, save) {
    var el = box.querySelector('.pb-step[data-step="' + id + '"]');
    if (!el) return;
    var v = el.querySelector('.pb-step-v');
    var after = save || aiSave;
    el.querySelector('.pb-step-dn').addEventListener('click', function () {
      set(-1); v.textContent = fmtV(get()); after();
    });
    el.querySelector('.pb-step-up').addEventListener('click', function () {
      set(1); v.textContent = fmtV(get()); after();
    });
  }
  function checkHtml(id, label, on, title) {
    return '<label class="pb-check" title="' + esc(title || '') + '">' +
      '<input type="checkbox" data-check="' + id + '"' + (on ? ' checked' : '') + '>' +
      '<span>' + esc(label) + '</span></label>';
  }
  function wireCheck(box, id, onChange) {
    var el = box.querySelector('input[data-check="' + id + '"]');
    if (el) el.addEventListener('change', function () { onChange(el.checked); });
  }

  var AI_STATS = [
    { id: 'health',  label: 'Health',  glyph: '❤' },
    { id: 'magicka', label: 'Magicka', glyph: '✦' },
    { id: 'stamina', label: 'Stamina', glyph: '⚡' },
  ];

  function renderAiSheet() {
    var ai = aiCfg();
    var html = '<div class="pb-sheet-head"><span class="t">⚕ Potion AI</span>' +
      '<span class="pb-sheet-hint">drinks your strongest matching potion — the same pick the smart buttons use</span></div>' +
      '<div class="pb-ai-master">' +
        checkHtml('enabled', 'Drink for me when a stat runs low', ai.enabled,
          'The master switch — the seeded "Potion AI: On/Off" action flips this too') +
        checkHtml('combatOnly', 'Only in combat', ai.combatOnly,
          'Never sip outside a fight') +
        checkHtml('notify', 'Say what it drank', ai.notify,
          'A corner notification names the potion and the stat') +
      '</div>';
    AI_STATS.forEach(function (s) {
      var st = ai.stats[s.id] || { on: false, pct: 20 };
      ai.stats[s.id] = st;
      html += '<div class="pb-ai-row c-' + s.id + '">' +
        '<span class="g">' + s.glyph + '</span>' +
        checkHtml('st-' + s.id, s.label, st.on, 'Watch ' + s.label.toLowerCase()) +
        '<span class="pb-ai-under">drink under</span>' +
        stepperHtml('pct-' + s.id, st.pct + '%') +
      '</div>';
    });
    html += '<div class="pb-ai-row pb-ai-cd">' +
      '<span class="g">⏱</span><span class="pb-ai-under">at most one bottle per</span>' +
      stepperHtml('cd', (ai.cooldownMs / 1000).toFixed(1) + ' s') +
      '<span class="pb-sheet-hint">per stat — health first, then magicka, then stamina</span>' +
    '</div>';
    sheetEl.innerHTML = html;

    wireCheck(sheetEl, 'enabled', function (on) { ai.enabled = on; aiSave(); });
    wireCheck(sheetEl, 'combatOnly', function (on) { ai.combatOnly = on; aiSave(); });
    wireCheck(sheetEl, 'notify', function (on) { ai.notify = on; aiSave(); });
    AI_STATS.forEach(function (s) {
      var st = ai.stats[s.id];
      wireCheck(sheetEl, 'st-' + s.id, function (on) { st.on = on; aiSave(); });
      wireStepper(sheetEl, 'pct-' + s.id,
        function () { return st.pct; },
        function (d) { st.pct = clamp(st.pct + d * 5, 5, 90); },
        function (v) { return v + '%'; });
    });
    wireStepper(sheetEl, 'cd',
      function () { return ai.cooldownMs; },
      function (d) { ai.cooldownMs = clamp(ai.cooldownMs + d * 500, 1000, 15000); },
      function (v) { return (v / 1000).toFixed(1) + ' s'; });
  }

  /* -------------------------------------------- smart picking (⚖ sheet) */
  /* WHICH potion the smart buttons drink. C++ owns the decision and the
     clamps (hotbar.h SmartPrefs); this sheet only says what the player wants.
     Saved through the same pbSave contract as the AI sheet, under `smart`.

     The exclusion list is edited from the ROWS (the 🚫 on each potion), not
     from a picker in here — you decide "never auto-drink this" while looking
     at the potion, and this sheet just shows the tally and can clear it. */

  var POOL_CATS = { heal: 1, magicka: 1, stamina: 1, cure: 1 };

  function smartDefaults() {
    return { optimal: true, allowOverheal: true, preferOverheal: false,
      emergencyPct: 25, blockWhenFull: true, exclude: [] };
  }
  function smartCfg() {
    if (!state.smart || typeof state.smart !== 'object') state.smart = smartDefaults();
    if (!Array.isArray(state.smart.exclude)) state.smart.exclude = [];
    return state.smart;
  }
  var smartSaveT = null;
  function smartSave() {
    updateTools();
    if (smartSaveT) clearTimeout(smartSaveT);
    smartSaveT = setTimeout(function () {
      smartSaveT = null;
      toGame('pbSave', JSON.stringify({ sort: ui.sort, cat: ui.cat, smart: smartCfg() }));
    }, 350);
  }

  /* Durable identity only — a dynamic potion (no plugin) can never be named
     in a saved list, so those rows simply do not offer the button. */
  function smartKey(r) {
    return (r && r.plugin && r.formId) ? (r.plugin + '|' + r.formId) : '';
  }
  function canBar(r) { return !!(r && POOL_CATS[r.cat] && smartKey(r)); }
  function isBarred(r) {
    var k = smartKey(r);
    return !!k && smartCfg().exclude.indexOf(k) >= 0;
  }
  function toggleBar(r) {
    var k = smartKey(r);
    if (!k) return;
    var ex = smartCfg().exclude;
    var at = ex.indexOf(k);
    if (at >= 0) {
      ex.splice(at, 1);
      toast('“' + (r.name || 'That potion') + '” can be picked again');
    } else {
      ex.push(k);
      toast('“' + (r.name || 'That potion') + '” will never be auto-picked');
    }
    smartSave();
    renderList();
    if (ui.sheet === 'smart') renderSheet();
  }

  function renderSmartSheet() {
    var s = smartCfg();
    var mode = s.optimal ? 'optimal' : 'strongest';
    var html = '<div class="pb-sheet-head"><span class="t">⚖ Smart picking</span>' +
      '<span class="pb-sheet-hint">the smart buttons, the wheel and the Potion AI all drink by these rules</span></div>' +
      '<div class="pb-seg" role="group">' +
        '<button type="button" class="pb-seg-b' + (mode === 'optimal' ? ' is-on' : '') + '" data-mode="optimal" ' +
          'title="Measure what is missing and drink the potion that answers it — no more, no less">' +
          'Fit the wound</button>' +
        '<button type="button" class="pb-seg-b' + (mode === 'strongest' ? ' is-on' : '') + '" data-mode="strongest" ' +
          'title="Always the biggest potion you carry — how the buttons worked before">' +
          'Always the strongest</button>' +
      '</div>';

    if (s.optimal) {
      html += '<div class="pb-ai-master">' +
        checkHtml('preferOverheal', 'Top me off', s.preferOverheal,
          'On: the smallest potion that COVERS what is missing (you end up full, some is wasted). ' +
          'Off: the biggest potion that fits INSIDE it (nothing wasted, you may stay a little short)') +
        checkHtml('allowOverheal', 'May waste a potion when nothing fits', s.allowOverheal,
          'Off, a pool with only oversized potions refuses out loud instead of burning one') +
        checkHtml('blockWhenFull', 'Never drink when already full', s.blockWhenFull,
          'The button says so instead of spending a potion on nothing') +
      '</div>' +
      '<div class="pb-ai-row pb-smart-row">' +
        '<span class="g">⚠</span><span class="pb-ai-under">Below this, always top off</span>' +
        stepperHtml('emg', s.emergencyPct > 0 ? s.emergencyPct + '%' : 'off') +
        '<span class="pb-sheet-hint">at 12% health the tidy sip is not the answer — 0 turns it off</span>' +
      '</div>';
    } else {
      html += '<div class="pb-smart-note">Every smart button drinks the strongest matching potion you ' +
        'carry, whatever is missing. Nothing below applies.</div>';
    }

    var n = s.exclude.length;
    html += '<div class="pb-ai-row pb-smart-row">' +
      '<span class="g">🚫</span><span class="pb-ai-under">Never auto-picked</span>' +
      '<b class="pb-smart-n">' + (n ? fmt(n) + (n === 1 ? ' potion' : ' potions') : 'none') + '</b>' +
      (n ? '<button type="button" class="pb-smart-clear" title="Let every potion be picked again">Clear</button>' : '') +
      '<span class="pb-sheet-hint">🚫 on any potion in the list below adds it here</span>' +
    '</div>';
    sheetEl.innerHTML = html;

    var segs = sheetEl.querySelectorAll('.pb-seg-b');
    for (var i = 0; i < segs.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          s.optimal = b.getAttribute('data-mode') === 'optimal';
          smartSave();
          renderSheet();
        });
      })(segs[i]);
    }
    if (s.optimal) {
      wireCheck(sheetEl, 'preferOverheal', function (on) { s.preferOverheal = on; smartSave(); });
      wireCheck(sheetEl, 'allowOverheal', function (on) { s.allowOverheal = on; smartSave(); });
      wireCheck(sheetEl, 'blockWhenFull', function (on) { s.blockWhenFull = on; smartSave(); });
      wireStepper(sheetEl, 'emg',
        function () { return s.emergencyPct; },
        function (d) { s.emergencyPct = clamp(s.emergencyPct + d * 5, 0, 90); },
        function (v) { return v > 0 ? v + '%' : 'off'; },
        smartSave);
    }
    var clr = sheetEl.querySelector('.pb-smart-clear');
    if (clr) clr.addEventListener('click', function () {
      s.exclude = [];
      smartSave();
      renderList();
      renderSheet();
      toast('Every potion can be picked again');
    });
  }

  /* ------------------------------------------------- view knobs (⛭ sheet) */
  /* ▲▼ steppers, never <input type=range> — the deck law (hd-scale.js). */

  function renderViewSheet() {
    var html = '<div class="pb-sheet-head"><span class="t">⛭ View</span>' +
      '<span class="pb-sheet-hint">both remembered — this is how the browser opens next time</span></div>' +
      '<div class="pb-ai-row pb-view-row">' +
        '<span class="g">⤢</span><span class="pb-ai-under">Panel scale</span>' +
        stepperHtml('scale', Math.round(state.scale * 100) + '%') +
        '<span class="pb-sheet-hint">the whole popout, ' + Math.round(SCALE_MIN * 100) + '–' + Math.round(SCALE_MAX * 100) + '%</span>' +
      '</div>' +
      '<div class="pb-ai-row pb-view-row">' +
        '<span class="g">◻</span><span class="pb-ai-under">Icon size</span>' +
        stepperHtml('ico', state.ico + 'px') +
        '<span class="pb-sheet-hint">the potion pictures, ' + ICO_MIN + '–' + ICO_MAX + 'px</span>' +
      '</div>';
    sheetEl.innerHTML = html;
    function viewChanged() { applyView(); savePrefsSoon(); }
    wireStepper(sheetEl, 'scale',
      function () { return state.scale; },
      function (d) { state.scale = clamp(Math.round((state.scale + d * 0.1) * 100) / 100, SCALE_MIN, SCALE_MAX); },
      function (v) { return Math.round(v * 100) + '%'; },
      viewChanged);
    wireStepper(sheetEl, 'ico',
      function () { return state.ico; },
      function (d) { state.ico = clamp(state.ico + d * 4, ICO_MIN, ICO_MAX); },
      function (v) { return v + 'px'; },
      viewChanged);
  }

  /* --------------------------------------------- potion combos (⧉ sheet) */

  function comboCarried(it) {
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (r.plugin === it.plugin && r.formId === it.formId) return r.count | 0;
    }
    return 0;
  }
  function comboSaveAll() {
    toGame('pbCombo', JSON.stringify({ op: 'save', combos: state.combos }));
  }
  function comboFire(id) {
    toGame('pbCombo', JSON.stringify({ op: 'fire', id: id }));
  }

  function renderComboList() {
    var html = '<div class="pb-sheet-head"><span class="t">⧉ Potion combos</span>' +
      '<button id="pb-combo-new" class="pb-tool" type="button" title="Name a new combo, then fill its basket">＋ New combo</button></div>';
    if (!state.combos.length) {
      html += '<div class="pb-empty pb-combo-empty">No combos yet. Make one — saved combos appear as ' +
        '<b>deck actions</b>: bind a key in F2, slot them on the action bar, pin them to the wheel or shelf.</div>';
    } else {
      html += '<div class="pb-combo-rows">';
      state.combos.forEach(function (c, i) {
        var armed = ui.comboArm === c.id;
        html += '<div class="pb-combo-row" data-i="' + i + '">' +
          '<span class="pb-combo-glyph">' + (c.icon ? '<img src="' + esc(c.icon) + '" alt="">' : '⧉') + '</span>' +
          '<span class="pb-combo-nm" title="' + esc(c.name) + '">' + esc(c.name) + '</span>' +
          '<span class="pb-combo-ct">' + c.items.length + ' potion' + (c.items.length === 1 ? '' : 's') + '</span>' +
          '<button class="pb-mini pb-combo-fire" type="button" title="Drink it now, as a test — a bound key runs exactly this">▶</button>' +
          '<button class="pb-mini pb-combo-edit" type="button" title="Rename, re-order or refill the basket">✎</button>' +
          '<button class="pb-mini pb-combo-del' + (armed ? ' is-armed' : '') + '" type="button" title="' +
            (armed ? 'Click again to really delete it (its deck action retires too)' : 'Delete this combo') + '">' +
            (armed ? 'Sure?' : '✕') + '</button>' +
        '</div>';
      });
      html += '</div>';
    }
    sheetEl.innerHTML = html;
    document.getElementById('pb-combo-new').addEventListener('click', function () {
      ui.comboEdit = { id: '', name: '', icon: '', items: [] };
      ui.comboArm = '';
      renderSheet();
    });
    var rows = sheetEl.querySelectorAll('.pb-combo-row');
    for (var k = 0; k < rows.length; k++) {
      (function (node) {
        var c = state.combos[parseInt(node.getAttribute('data-i'), 10)];
        if (!c) return;
        node.querySelector('.pb-combo-fire').addEventListener('click', function () { comboFire(c.id); });
        node.querySelector('.pb-combo-edit').addEventListener('click', function () {
          ui.comboEdit = { id: c.id, name: c.name, icon: c.icon || '',
            items: c.items.map(function (it) { return { plugin: it.plugin, formId: it.formId, name: it.name }; }) };
          ui.comboArm = '';
          renderSheet();
        });
        node.querySelector('.pb-combo-del').addEventListener('click', function () {
          if (ui.comboArm !== c.id) { ui.comboArm = c.id; renderSheet(); return; }
          ui.comboArm = '';
          state.combos = state.combos.filter(function (x) { return x.id !== c.id; });
          comboSaveAll();
          renderSheet();
          updateTools();
        });
      })(rows[k]);
    }
  }

  function renderComboEditor() {
    var ed = ui.comboEdit;
    var html = '<div class="pb-sheet-head"><span class="t">' +
        (ed.id ? '✎ ' + esc(ed.name || 'Edit combo') : '＋ New combo') + '</span>' +
      '<span class="pb-sheet-hint">up to 8 potions, drunk in order with one press</span></div>' +
      '<div class="pb-combo-fields">' +
        '<input id="pb-ce-name" class="pb-ce-input" type="text" maxlength="48" ' +
          'placeholder="Name it — “Battle Prep”, “Last Stand”…" value="' + esc(ed.name) + '">' +
        '<input id="pb-ce-icon" class="pb-ce-input pb-ce-icon" type="text" maxlength="128" ' +
          'placeholder="icons/custom/….png (optional)" value="' + esc(ed.icon) + '" ' +
          'title="A view-relative icon path for its deck action; leave empty for the ⧉ glyph">' +
      '</div>' +
      '<div class="pb-ce-basket" id="pb-ce-basket"></div>' +
      '<div class="pb-ce-addrow"><span class="g">⌕</span>' +
        '<input id="pb-ce-q" class="pb-ce-input" type="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="Search your bag to add — any category, Enter adds the top hit"></div>' +
      '<div class="pb-ce-results" id="pb-ce-results"></div>' +
      '<div class="pb-ce-foot">' +
        '<button id="pb-ce-save" class="pb-tool pb-ce-savebtn" type="button">Save combo</button>' +
        '<button id="pb-ce-cancel" class="pb-tool" type="button">Cancel</button>' +
        '<span class="pb-sheet-hint">it lands in F2 → Utilities the moment you save</span>' +
      '</div>';
    sheetEl.innerHTML = html;

    var nameEl = document.getElementById('pb-ce-name');
    var iconEl = document.getElementById('pb-ce-icon');
    nameEl.addEventListener('input', function () { ed.name = nameEl.value; });
    iconEl.addEventListener('input', function () { ed.icon = iconEl.value.trim(); });

    function paintBasket() {
      var box = document.getElementById('pb-ce-basket');
      if (!ed.items.length) {
        box.innerHTML = '<div class="pb-ce-basket-empty">The basket is empty — search below and add up to 8.</div>';
        return;
      }
      var h = '';
      ed.items.forEach(function (it, i) {
        var have = comboCarried(it);
        h += '<div class="pb-ce-item" data-i="' + i + '">' +
          '<span class="n">' + (i + 1) + '.</span>' +
          '<span class="nm" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
          '<span class="have' + (have ? '' : ' is-dry') + '" title="How many you carry right now">x' + fmt(have) + '</span>' +
          '<button class="pb-mini ce-up" type="button" title="Drink earlier"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button class="pb-mini ce-dn" type="button" title="Drink later"' + (i === ed.items.length - 1 ? ' disabled' : '') + '>▼</button>' +
          '<button class="pb-mini ce-rm" type="button" title="Take it out">✕</button>' +
        '</div>';
      });
      box.innerHTML = h;
      var items = box.querySelectorAll('.pb-ce-item');
      for (var k = 0; k < items.length; k++) {
        (function (node) {
          var i = parseInt(node.getAttribute('data-i'), 10);
          node.querySelector('.ce-up').addEventListener('click', function () {
            var t = ed.items[i - 1]; ed.items[i - 1] = ed.items[i]; ed.items[i] = t; paintBasket();
          });
          node.querySelector('.ce-dn').addEventListener('click', function () {
            var t = ed.items[i + 1]; ed.items[i + 1] = ed.items[i]; ed.items[i] = t; paintBasket();
          });
          node.querySelector('.ce-rm').addEventListener('click', function () {
            ed.items.splice(i, 1); paintBasket(); paintResults();
          });
        })(items[k]);
      }
    }

    var qEl2 = document.getElementById('pb-ce-q');
    function addRow(r) {
      if (ed.items.length >= 8) { toast('A combo holds at most 8 potions'); return; }
      if (!r.plugin || !r.formId || r.formId === '0x0') {
        toast('That one is dynamic — it can\'t survive a save/load, so it can\'t join a combo');
        return;
      }
      ed.items.push({ plugin: r.plugin, formId: r.formId, name: r.name || 'Potion' });
      paintBasket();
      paintResults();
    }
    function resultsFor() {
      var q = (qEl2.value || '').trim().toLowerCase();
      var out = [];
      for (var i = 0; i < state.rows.length && out.length < 12; i++) {
        var r = state.rows[i];
        if (q) {
          var n = String(r.name || '').toLowerCase();
          var fx = String(r.fx || '').toLowerCase();
          if (n.indexOf(q) === -1 && fx.indexOf(q) === -1) continue;
        }
        out.push(r);
      }
      return out;
    }
    function paintResults() {
      var box = document.getElementById('pb-ce-results');
      var rows = resultsFor();
      if (!rows.length) {
        box.innerHTML = '<div class="pb-ce-basket-empty">' +
          ((qEl2.value || '').trim() ? 'Nothing in your bag matches.' : 'Your bag is empty.') + '</div>';
        return;
      }
      var h = '';
      rows.forEach(function (r, i) {
        h += '<div class="pb-ce-res" data-i="' + i + '">' +
          '<span class="g">' + (GLYPH[r.cat] || GLYPH.other) + '</span>' +
          '<span class="nm">' + esc(r.name || 'Potion') + '</span>' +
          '<span class="have">x' + fmt(r.count || 0) + '</span>' +
          '<button class="pb-mini ce-add" type="button" title="Add it to the basket">＋</button>' +
        '</div>';
      });
      box.innerHTML = h;
      var nodes = box.querySelectorAll('.pb-ce-res');
      for (var k = 0; k < nodes.length; k++) {
        (function (node) {
          var r = rows[parseInt(node.getAttribute('data-i'), 10)];
          node.querySelector('.ce-add').addEventListener('click', function () { addRow(r); });
        })(nodes[k]);
      }
    }
    qEl2.addEventListener('input', paintResults);
    qEl2.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        var rows = resultsFor();
        if (rows.length) addRow(rows[0]);
      }
    });

    document.getElementById('pb-ce-save').addEventListener('click', function () {
      ed.name = (nameEl.value || '').trim();
      if (!ed.name) { toast('Name it first'); nameEl.focus(); return; }
      ed.icon = (iconEl.value || '').trim();
      var next = state.combos.slice();
      var found = false;
      for (var i = 0; i < next.length; i++)
        if (ed.id && next[i].id === ed.id) { next[i] = ed; found = true; break; }
      if (!found) next.push(ed);
      state.combos = next;
      ui.comboEdit = null;
      comboSaveAll();
      renderSheet();
      updateTools();
    });
    document.getElementById('pb-ce-cancel').addEventListener('click', function () {
      ui.comboEdit = null;
      renderSheet();
    });

    paintBasket();
    paintResults();
    setTimeout(function () { if (ui.comboEdit === ed) nameEl.focus(); }, 30);
  }

  function renderSheet() {
    if (!sheetEl) return;
    if (!ui.sheet) { sheetEl.hidden = true; sheetEl.innerHTML = ''; return; }
    sheetEl.hidden = false;
    if (ui.sheet === 'ai') renderAiSheet();
    else if (ui.sheet === 'smart') renderSmartSheet();
    else if (ui.sheet === 'view') renderViewSheet();
    else if (ui.comboEdit) renderComboEditor();
    else renderComboList();
  }

  /* -------------------------------------------------------- open/close */

  function open(standalone, cat) {
    ensureDom();
    ui.open = true;
    ui.openedAt = Date.now();
    ui.standalone = !!standalone;
    ui.cursor = 0;
    ui.q = '';
    if (qEl) qEl.value = '';
    if (cat && CATS.some(function (c) { return c.id === cat; })) {
      ui.cat = cat;
      ui.catForced = true;
    }
    document.body.classList.add('pb-open');
    ui.loaded = false;
    applyView();
    renderPills();
    renderSorts();
    renderList();
    renderShelf();
    toGame('pbList');
    setTimeout(function () { if (ui.open && qEl) qEl.focus(); }, 30);
  }

  function close(closeDeck) {
    if (!ui.open) return;
    ui.open = false;
    stopIconPoll();
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    document.body.classList.remove('pb-open');
    if (closeDeck && ui.standalone) {
      if (env && typeof env.closeDeck === 'function') env.closeDeck();
      /* the pending-deep-open race can open us before app.js hooked the
         env — the bare bridge close is the honest fallback (nothing was
         being edited in that window, so there is nothing to flush) */
      else toGame('hdClose');
    }
    ui.standalone = false;
  }

  /* --------------------------------------------------------- receivers */

  window.pbListData = function (j) {
    var d = coerce(j);
    if (!d || typeof d !== 'object') return;
    state.rows = Array.isArray(d.rows) ? d.rows : [];
    ui.loaded = true;
    /* ⚠ HYDRATE THE C++-OWNED SLICES. Combos and the Potion AI config are
       stored server-side and REPLACED wholesale on save (CombosFrom ends in
       a move; AiFrom clamps what it is sent). Until 2026-08-19 this receiver
       read only rows+prefs, so state.combos stayed [] all session and the
       next combo save ERASED every saved combo — and retired its deck entry
       and keybind with it (verification-swarm find, both refuters upheld).
       The smart-pick prefs joined them the same day and hydrate the same way.
       The `!…SaveT` guards are the one subtlety: a reply that lands between an
       edit and its debounced write must not overwrite what is about to be
       sent. Combos need no guard — their own save path replaces state first. */
    if (Array.isArray(d.combos)) state.combos = d.combos;
    if (d.ai && typeof d.ai === 'object' && !aiSaveT) state.ai = d.ai;
    if (d.smart && typeof d.smart === 'object' && !smartSaveT) state.smart = d.smart;
    updateTools();
    /* A sheet that was opened BEFORE this reply landed is drawn from the
       defaults the hydration above just replaced — so it must be repainted or
       it shows numbers nobody set. This is not hypothetical: the omni results
       open the browser straight onto a sheet, which is always faster than the
       round trip. The combo EDITOR is exempt: it holds work in progress. */
    if (ui.open && ui.sheet && !ui.comboEdit) renderSheet();
    /* persisted prefs land once per session, and never over a deliberate
       choice (a category deep-open, or a pill/sort the user already hit) */
    if (!ui.prefsApplied && d.prefs && typeof d.prefs === 'object') {
      ui.prefsApplied = true;
      if (!ui.catForced && d.prefs.cat && CATS.some(function (c) { return c.id === d.prefs.cat; }))
        ui.cat = d.prefs.cat;
      if (d.prefs.sort && SORTS.some(function (s) { return s.id === d.prefs.sort; }))
        ui.sort = d.prefs.sort;
      /* the shelf and the ⛭ View knobs land with the same once-per-session
         gate, so a stepper touched before this reply can never snap back */
      state.favs = sanitizeFavs(d.prefs.favs);
      if (d.prefs.scale != null) state.scale = Number(d.prefs.scale) || 1;
      if (d.prefs.ico != null) state.ico = Number(d.prefs.ico) || 58;
      applyView();
    }
    if (!ui.open) return;
    renderPills();
    renderSorts();
    renderList();
    renderShelf();
    scheduleIcons();
  };

  window.pbUseResult = function (j) {
    var d = coerce(j);
    if (!d || typeof d !== 'object') return;
    if (!d.ok) { toast(d.msg || 'That didn\'t work'); return; }
    toast(d.msg || 'Drank it');
    /* decrement IN PLACE — the row greys at zero with an honest note; the
       list order stays put until the next real render (rows jumping under
       the cursor after every sip would be worse than a stale sort) */
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (r.plugin === d.plugin && r.formId === d.formId) {
        r.count = Math.max(0, d.newCount | 0);
        var node = listEl && listEl.querySelector('.pb-row[data-rid="' + rid(r).replace(/"/g, '\\"') + '"]');
        if (node) {
          var cnt = node.querySelector('.pb-cnt');
          if (cnt) cnt.textContent = 'x' + fmt(r.count);
          if (!(r.count > 0)) {
            node.classList.add('is-gone');
            var fx = node.querySelector('.pb-fx');
            if (fx) fx.textContent = 'none left';
            var btn = node.querySelector('.pb-drink');
            if (btn) btn.disabled = true;
          }
        }
        break;
      }
    }
    renderPills();   // the live counts on the pills follow the sip
    renderShelf();   // ...and so do the shelf's
  };

  window.pbSaved = function () { /* ack only — nothing to do */ };

  /* Every pbCombo op answers here — save, delete, and a test fire. C++ has
     pushed this since the combos landed; nothing DEFINED it, so a refusal
     ("you aren't carrying any of it", "unknown combo") vanished into a
     dropped call and the button looked dead (2026-08-19 swarm find, both
     refuters upheld). A save/delete ack also re-syncs the list from the
     authoritative side, so the view can never drift from what C++ stored. */
  window.pbComboResult = function (j) {
    var d = coerce(j);
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.combos)) { state.combos = d.combos; updateTools(); }
    if (d.msg) toast(String(d.msg), !d.ok);
    else if (!d.ok) toast('That combo didn\'t run');
    if (ui.open && ui.sheet === 'combos' && !ui.comboEdit) renderSheet();
  };

  /* ---- Omni search provider: the browser + its four category doors ---- */
  if (window.HDOmni) {
    HDOmni.register({
      id: 'potions', label: 'Potions', tab: 'items',
      index: function () {
        var rows = [{
          label: 'Potion Browser',
          detail: 'Every potion you carry — search, sort by strength or value, quick-drink',
          kind: 'potions',
          keywords: 'potion browser drink quick use health magicka stamina cure bottle alchemy',
          run: function () { open(false, ''); },
        }];

        /* THE SHEETS ARE FEATURES, NOT FURNITURE (2026-08-19). Searching the
           deck for "smart picking" — a settings panel with that name printed on
           its own button — returned nothing, because this provider indexed the
           browser and its category doors and stopped there. Anything a player
           can NAME has to be reachable by that name, so each fold-out sheet is
           its own result that opens the browser straight onto it. */
        [
          { sheet: 'smart', label: 'Smart picking',
            detail: 'Which potion the smart buttons drink — fit the wound, top off, emergency threshold, and potions to never auto-pick',
            keywords: 'smart picking optimal least waste overheal top off emergency threshold ' +
                      'deficit fortify never pick veto exclude potion choice rules' },
          { sheet: 'ai', label: 'Potion AI',
            detail: 'Drink for me when a stat runs low — per-stat thresholds, combat-only, cooldown',
            keywords: 'potion ai automatic auto drink threshold low health magicka stamina emergency healer' },
          { sheet: 'combos', label: 'Potion combos',
            detail: 'Quick-drink several potions with one press — every combo is also a deck action you can bind',
            keywords: 'potion combo combos multiple bundle stack quick drink bind action' },
          { sheet: 'view', label: 'Potion Browser: size',
            detail: 'How big the browser opens — panel scale and icon size',
            keywords: 'potion browser size scale bigger smaller icon size view zoom' },
        ].forEach(function (s) {
          rows.push({
            label: s.label, detail: s.detail, kind: 'potions', keywords: s.keywords,
            run: function () { open(false, ''); setSheet(s.sheet); },
          });
        });
        CATS.forEach(function (c) {
          if (c.id === 'all' || c.id === 'other') return;
          rows.push({
            label: 'Potions: ' + c.label,
            detail: 'Open the potion browser on your ' + c.label.toLowerCase() + ' potions',
            kind: 'potions',
            keywords: 'potion drink ' + c.label.toLowerCase(),
            run: function () { open(false, c.id); },
          });
        });
        return rows;
      },
    });
  }

  var api = {
    hookInto: function (e) { env = e; },
    hooked: function () { return !!env; },
    open: open,
    close: close,
    isOpen: function () { return ui.open; },
    /* hdClosed teardown — the overlay hangs off document.body, so the panel
       hiding does not take it along (the wheel's own lesson). */
    onDeckClosed: function () { close(false); },
    /* test seams */
    _ui: ui,
    _state: state,
    _compute: compute,
    _renderList: renderList,
    _renderPills: renderPills,
    _drink: drink,
    _rid: rid,
    _iconFor: iconFor,
    _missingArt: missingArt,
    _requestIcons: requestIcons,
    _flushIcons: function () {
      if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
      requestIcons();
    },
    _upgradeArt: upgradeArt,
    _cats: CATS,
    _sorts: SORTS,
    _toggleFav: toggleFav,
    _toggleBar: toggleBar,
    _smartCfg: smartCfg,
    _smartDefaults: smartDefaults,
    _renderShelf: renderShelf,
    _applyView: applyView,
    _isFav: isFav,
  };

  /* A deep-open that raced this deferred script parked its category on the
     window (app.js's hdShowTab router) — consume it now. */
  var pend = window.__hdPendingPotions;
  if (pend !== undefined && pend !== null) {
    window.__hdPendingPotions = null;
    open(true, pend === '1' ? '' : String(pend));
  }

  return api;
})();
