'use strict';
/* ====================================================================== *
 *  HDQuiver — the ammo radial (Rober, 2026-08-15: "fully customizable,
 *  sortable and searchable element, inherits from the wheel menu but its
 *  own cool visual identity, populates with arrows and bolts automatically,
 *  favorites / categories show damage. Poisons, effects on arrows").
 *
 *  The wheel's blood relative, but a WINDOW, not a modal (Rober,
 *  2026-08-16: "I wanted the quiver to be a UI like a popout showing your
 *  arrow that you could interact with (mouse or keyboard) to select, with
 *  options to place / drag it around on screen, resize it etc"). It lives
 *  in the MAIN deck view, routed through hdShowTab('quiver'[@arrows|@bolts])
 *  so it inherits the whole proven open sequence; the game pauses because
 *  the deck view is FOCUSED — every palette surface's law — but the screen
 *  is NOT dimmed and the box is not centred: it sits wherever you put it,
 *  at whatever size you dragged it to, over the frozen world. That is the
 *  point of the placement: park it clear of your target.
 *
 *  PLACEMENT (hd-outfit's floater idiom — the layer takes no pointer events,
 *  the box does): drag the header to move, drag the ⤡ corner to resize,
 *  Ctrl+arrows nudge (Shift = 10x), [ and ] resize from the keyboard, ↺ puts
 *  it back in the middle. {x, y, w} ride the SAME view-owned prefs blob as
 *  sort/cat/ring/favs — quiver.cpp merges unknown keys, so placement needed
 *  no DLL change. Everything is clamped into the viewport on every apply, so
 *  a window saved on a 2560-wide screen cannot strand itself off a 1080p one.
 *  The identity is unchanged: ammo fanned in a RING around a hub, like
 *  looking down into the quiver — and the ring follows the window's size.
 *
 *  Bridge (one name per direction — the deck law):
 *    toGame('qvList')          — "send me every arrow/bolt I carry + prefs"
 *    toGame('qvUse',  json)    — {plugin, formId, rt} nock this one NOW
 *    toGame('qvSave', json)    — {sort, cat, ring, favs} persist prefs
 *  C++ replies (globals; response-style, so no hd-boot stub is needed):
 *    window.qvListData(json)   — {rows:[…], launcher:{…}|null, prefs:{…}}
 *    window.qvUseResult(json)  — {ok, msg, plugin, formId, equipped}
 *    window.qvSaved(json)      — write ack
 *
 *  Damage rides EVERY tile (the ask: "favorites / categories show damage"),
 *  poison is a green dot + hub line, an enchant description a violet dot —
 *  and the launcher strip tells the vanilla truth: poison lives on the BOW,
 *  so that is where the quiver reports it.
 *
 *  Row art is a real mesh render of the arrow itself, through the shared
 *  ItemIcons / Mesh Rendering Framework pipeline. Two things make it feel
 *  instant rather than slow (Rober, 2026-08-16: "it just takes time to
 *  load... It needs to be persistent (remember generations) and show some
 *  sort of loading animation on the arrows"):
 *    PERSISTENCE — renders are render-once-keep-forever on disk, and C++
 *      stamps the existing PNG onto every row of qvListData, so ammo drawn
 *      in ANY previous session paints on the first frame. C++ also queues
 *      the missing ones off the same list walk, so the work starts at open,
 *      not after the view's settle gate. The settle gate survives for
 *      TYPING only; opening, paging and pills ask immediately.
 *    HONESTY — a tile still cooking spins a nock ring; one that can never
 *      render (no plugin identity, or a verdict from the framework) drops
 *      back to its fletching glyph with the reason on hover and a ⟳ retry
 *      in the hub. The poll is bounded, so a rig with no Mesh Rendering
 *      Framework stops promising a picture instead of spinning for ever.
 * ====================================================================== */
window.HDQuiver = (function () {
  var DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[qv dev->game]', fn, arg);
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
  var PLACE_MIN_W = 520, PLACE_MAX_W = 1600;

  var ui = {
    open: false,
    place: { x: null, y: null, w: null },  // null = centred at the default width
    placing: false,
    standalone: false,   // opened by its own key => closing it closes the deck
    cat: 'all',
    sort: 'dmg',
    ringN: 12,
    q: '',
    sel: 0,              // absolute index into ui.rows
    page: 0,
    loaded: false,
    prefsApplied: false, // session-once: prefs land only until the user chooses
    catForced: false,    // a family deep-open beats the persisted pref
    rows: [],            // the filtered+sorted view of state.rows
    favs: {},            // favKey -> 1 (deck-side favorites, persisted)
    tileDrawn: 0,        // the ACTUAL tile px renderRing drew (geometry-shrunk)
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
    iconGaveUp: false,   // the bounded poll ran out — stop promising a picture
    iconReq: {},
    saveT: null,
    toastT: null,
  };
  var state = { rows: [], launcher: null };

  var CATS = [
    { id: 'all',    label: 'All',        glyph: '➶' },
    { id: 'arrows', label: 'Arrows',     glyph: '➹' },
    { id: 'bolts',  label: 'Bolts',      glyph: '➾' },
    { id: 'favs',   label: 'Favorites',  glyph: '★' },
    { id: 'poison', label: 'Poisoned',   glyph: '☠' },
    { id: 'ench',   label: 'Enchanted',  glyph: '✦' },
  ];
  var SORTS = [
    { id: 'dmg',   label: 'Damage' },
    { id: 'count', label: 'Count' },
    { id: 'name',  label: 'Name' },
    { id: 'value', label: 'Value' },
  ];
  var RINGS = [8, 12, 16];

  function favKey(r) { return (r.plugin || '') + '|' + (r.formId || '') + '|' + (r.plugin ? '' : (r.rt || 0)); }
  function rid(r) { return (r.plugin || '') + '|' + (r.formId || '') + '|' + (r.rt || 0); }
  function isFav(r) { return !!(ui.favs[favKey(r)] || r.gameFav); }
  function isEnch(r) { return !!(r.desc || r.explode); }
  function inCat(r, cat) {
    if (cat === 'all') return true;
    if (cat === 'arrows') return !r.bolt;
    if (cat === 'bolts') return !!r.bolt;
    if (cat === 'favs') return isFav(r);
    if (cat === 'poison') return !!r.poison;
    if (cat === 'ench') return isEnch(r);
    return true;
  }

  /* --------------------------------------------------------------- dom */

  var root = null, boxEl = null, stageEl = null, hubEl = null, qEl = null, pillsEl = null,
      sortsEl = null, ringsEl = null, countEl = null, pageEl = null,
      launcherEl = null, toastEl = null;

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'hd-quiver';
    root.innerHTML =
      '<div class="qv-box">' +
        '<div id="qv-head" class="qv-head">' +
          '<span class="qv-grip" aria-hidden="true">✥</span>' +
          '<span class="qv-title">➶ Quiver</span>' +
          '<span id="qv-count" class="qv-count"></span>' +
          '<button id="qv-reset" class="qv-x" type="button" ' +
            'title="Put the quiver back in the middle at its default size">↺</button>' +
          '<button id="qv-x" class="qv-x" type="button" title="Close (Esc)">✕</button>' +
        '</div>' +
        '<div class="qv-controls">' +
          '<div class="qv-qrow"><span class="g">⌕</span>' +
            '<input id="qv-q" type="text" autocomplete="off" spellcheck="false" ' +
              'placeholder="Search your arrows and bolts — Enter nocks the top one">' +
          '</div>' +
          '<div id="qv-pills" class="qv-pills"></div>' +
          '<div class="qv-tunerow">' +
            '<div id="qv-sorts" class="qv-sorts"></div>' +
            '<div id="qv-rings" class="qv-rings"></div>' +
          '</div>' +
        '</div>' +
        '<div id="qv-stage" class="qv-stage">' +
          '<div id="qv-hub" class="qv-hub"></div>' +
          '<div id="qv-page" class="qv-page"></div>' +
        '</div>' +
        '<div id="qv-launcher" class="qv-launcher"></div>' +
        '<div class="qv-foot">' +
          '<span class="qv-foot-1">Enter / click = nock · ←→ turn the ring · scroll or PgUp/PgDn = page · F = favorite · Esc clears the search, then closes</span>' +
          '<span class="qv-foot-2">drag the header to move it · drag ⤡ or press [ ] to resize · Ctrl+arrows nudge · ↺ recentres</span></div>' +
        '<div id="qv-toast" class="qv-toast" role="status"></div>' +
        '<div id="qv-size" class="qv-size" title="Drag to resize — or press [ and ]">⤡</div>' +
      '</div>';
    document.body.appendChild(root);
    boxEl = root.querySelector('.qv-box');
    stageEl = document.getElementById('qv-stage');
    hubEl = document.getElementById('qv-hub');
    qEl = document.getElementById('qv-q');
    pillsEl = document.getElementById('qv-pills');
    sortsEl = document.getElementById('qv-sorts');
    ringsEl = document.getElementById('qv-rings');
    countEl = document.getElementById('qv-count');
    pageEl = document.getElementById('qv-page');
    launcherEl = document.getElementById('qv-launcher');
    toastEl = document.getElementById('qv-toast');

    document.getElementById('qv-x').addEventListener('click', function () { close(true); });
    document.getElementById('qv-reset').addEventListener('click', resetPlace);
    makeDraggable(document.getElementById('qv-head'));
    makeResizable(document.getElementById('qv-size'));
    /* NO click-outside-to-close: the layer takes no pointer events now, and a
       window you can park somewhere must not vanish because you clicked the
       world behind it. Esc and ✕ close it. */
    stageEl.addEventListener('wheel', function (e) {
      e.preventDefault();
      turnPage(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    qEl.addEventListener('input', function () {
      ui.q = qEl.value;
      ui.sel = 0;
      ui.page = 0;
      renderAll();
      scheduleIcons();
    });

    /* Capture-phase so the deck's own key handling never sees keys meant
       for the quiver (the hb-cap idiom). Active only while open. */
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('hd-item-icons', upgradeArt);
    window.addEventListener('resize', function () {
      if (!ui.open) return;
      invalidateChrome();    // a new viewport can re-wrap the head/controls rows
      applyPlace();          // a saved spot must survive a resolution change
      renderRing();
    });

    renderPills();
    renderSorts();
    renderRings();
  }

  /* ------------------------------------------------- placement (the window) */

  function defaultW() { return Math.round(Math.min(880, window.innerWidth * 0.94)); }

  /* One place where geometry is decided, called after every move, resize,
     window resize and prefs load. Two jobs: keep the box on screen whatever
     it was saved at, and size the RING off the window — the width is FOR the
     ring, so a wider quiver has to mean bigger plates or the resize is a lie. */
  /* The chrome (head + controls + launcher + foot, i.e. everything the stage is
     NOT) is invariant while a window is being dragged or resized — it only
     changes when the quiver re-renders. Measuring it costs a forced layout, and
     applyPlace runs on EVERY mousemove of a drag, so it is measured once and
     held until something that could change it says otherwise. */
  var chromePx = null;
  function invalidateChrome() { chromePx = null; }

  function applyPlace() {
    if (!boxEl) return;
    var vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
    var wMin = Math.min(PLACE_MIN_W, vw - 16);
    var w = clamp(Math.round(ui.place.w || defaultW()), wMin, Math.min(PLACE_MAX_W, vw - 16));
    boxEl.style.width = w + 'px';
    /* The stage is square and bounded by BOTH the box's inner width and the
       height left over after the head, controls, launcher and foot. That
       leftover is MEASURED, not guessed: the ultralight-probe caught a fixed
       0.60*vh budget making the window 918px tall on a 900px screen — the
       bottom of it, launcher and all, simply off the bottom edge. Two passes:
       a provisional stage so the chrome can be measured around it, then the
       real one. */
    if (chromePx == null) {
      var probeStage = Math.max(220, Math.min(w - 96, Math.round(vh * 0.6)));
      boxEl.style.setProperty('--qv-stage', probeStage + 'px');
      chromePx = Math.max(0, (boxEl.offsetHeight || 0) - (stageEl ? stageEl.offsetHeight || 0 : 0));
    }
    var chrome = chromePx;
    var stage = Math.round(Math.max(200, Math.min(w - 96, vh - chrome - 16)));
    boxEl.style.setProperty('--qv-stage', stage + 'px');
    /* h is chrome + stage BY DEFINITION of chrome, so it is computed rather
       than read back — the second forced layout this function used to pay on
       every mousemove bought a number we already had. */
    var h = (chrome + stage) || Math.round(vh * 0.8);
    var x = (ui.place.x == null) ? Math.round((vw - w) / 2) : ui.place.x;
    var y = (ui.place.y == null) ? Math.round((vh - h) / 2) : ui.place.y;
    boxEl.style.left = clamp(x, 8, Math.max(8, vw - w - 8)) + 'px';
    boxEl.style.top = clamp(y, 8, Math.max(8, vh - h - 8)) + 'px';
  }

  function resetPlace() {
    ui.place = { x: null, y: null, w: null };
    invalidateChrome();
    applyPlace();
    renderRing();
    savePrefsSoon();
    toast('Back in the middle');
  }

  /* Edge magnet: within 16px of a screen edge, snap flush to the margin.
     Parking a window in a corner by hand is fiddly; this makes it one move. */
  function snapEdges() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = boxEl.offsetWidth, h = boxEl.offsetHeight, M = 8, K = 16;
    if (ui.place.x != null) {
      if (Math.abs(ui.place.x - M) < K) ui.place.x = M;
      else if (Math.abs((ui.place.x + w) - (vw - M)) < K) ui.place.x = vw - w - M;
    }
    if (ui.place.y != null) {
      if (Math.abs(ui.place.y - M) < K) ui.place.y = M;
      else if (Math.abs((ui.place.y + h) - (vh - M)) < K) ui.place.y = vh - h - M;
    }
  }

  /* hd-outfit's floater idiom. #hd-quiver hangs off document.body, OUTSIDE
     #panel's transform, so pointer travel is layout px 1:1 — no scale factor
     to divide by (the crop-editor lesson, which does need one). */
  function makeDraggable(head) {
    if (!head) return;
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !boxEl) return;
      if (e.target.closest && e.target.closest('button')) return;   // ✕ / ↺ are buttons
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var r = boxEl.getBoundingClientRect();
      var ox = r.width ? r.left : atX(), oy = r.width ? r.top : atY();
      ui.placing = true;
      /* Prime the chrome measurement HERE, once, so the mousemove path is pure
         style writes — a move never changes the window's width, so the chrome
         it measures cannot change while the drag runs. */
      invalidateChrome();
      applyPlace();
      document.body.classList.add('qv-moving');
      function mv(ev) {
        ui.place.x = Math.round(ox + (ev.clientX - sx));
        ui.place.y = Math.round(oy + (ev.clientY - sy));
        applyPlace();
      }
      function up() {
        document.removeEventListener('mousemove', mv, true);
        document.removeEventListener('mouseup', up, true);
        ui.placing = false;
        document.body.classList.remove('qv-moving');
        snapEdges();
        applyPlace();
        savePrefsSoon();
      }
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  function makeResizable(grip) {
    if (!grip) return;
    grip.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !boxEl) return;
      e.preventDefault();
      var sx = e.clientX;
      var r = boxEl.getBoundingClientRect();
      var w0 = r.width || atW();
      /* a resize must not also walk the window: the top-left stays put */
      ui.place.x = Math.round(r.width ? r.left : atX());
      ui.place.y = Math.round(r.width ? r.top : atY());
      ui.placing = true;
      document.body.classList.add('qv-moving');
      var raf = 0;
      function mv(ev) {
        ui.place.w = Math.round(w0 + (ev.clientX - sx));
        applyPlace();
        /* the ring is re-laid out on a frame, not per mouse event — 16 tiles
           rebuilt per pixel of drag is what makes a resize feel like tar */
        if (!raf) raf = requestAnimationFrame(function () { raf = 0; renderRing(); });
      }
      function up() {
        document.removeEventListener('mousemove', mv, true);
        document.removeEventListener('mouseup', up, true);
        ui.placing = false;
        document.body.classList.remove('qv-moving');
        /* The width settled — re-measure once, in case a control row wrapped
           on the way. During the drag the cached value is close enough for the
           on-screen clamp and costs no layout. */
        invalidateChrome();
        applyPlace();
        renderRing();
        savePrefsSoon();
      }
      document.addEventListener('mousemove', mv, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  /* Where the window IS, without measuring it. applyPlace has already written
     the authored value to the inline style, so a keyboard nudge never depends
     on layout — which also keeps it honest in the headless harness. */
  function atX() { return ui.place.x != null ? ui.place.x : (parseFloat(boxEl.style.left) || 0); }
  function atY() { return ui.place.y != null ? ui.place.y : (parseFloat(boxEl.style.top) || 0); }
  function atW() { return ui.place.w != null ? ui.place.w : (parseFloat(boxEl.style.width) || defaultW()); }

  function nudge(dx, dy) {
    ui.place.x = Math.round(atX() + dx);
    ui.place.y = Math.round(atY() + dy);
    applyPlace();
    savePrefsSoon();
  }

  function sizeBy(d) {
    ui.place.w = Math.round(atW() + d);
    applyPlace();
    renderRing();
    savePrefsSoon();
  }

  function onKey(e) {
    if (!ui.open) return;
    /* Ctrl + arrows move the window, so the bare arrows keep turning the ring
       — the selection is what you press most. Shift makes it a big step. */
    if (e.ctrlKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      var step = e.shiftKey ? 120 : 12;
      nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
            e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      return;
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault(); e.stopPropagation();
      sizeBy(e.key === ']' ? 60 : -60);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (ui.q) { qEl.value = ''; ui.q = ''; ui.sel = 0; ui.page = 0; renderAll(); return; }
      close(true);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      moveSel(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault(); e.stopPropagation();
      turnPage(e.key === 'PageDown' ? 1 : -1);
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      /* never steal typing from the search box */
      if (document.activeElement === qEl) return;
      e.preventDefault(); e.stopPropagation();
      var r = ui.rows[ui.sel];
      if (r) toggleFav(r);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      var hit = ui.rows[clamp(ui.sel, 0, ui.rows.length - 1)];
      if (hit) nock(hit);
    }
  }

  function moveSel(d) {
    if (!ui.rows.length) return;
    ui.sel = (ui.sel + d + ui.rows.length) % ui.rows.length;
    var page = Math.floor(ui.sel / ui.ringN);
    if (page !== ui.page) {
      ui.page = page;
      renderRing();      // a page turn IS new content — rebuild
      scheduleIcons(true);   // …and new content needs its own renders
    } else {
      applySel();        // same page: swap classes in place, never rebuild
    }
    renderHub();
  }

  /* Selection moved within the drawn page — restyle without a rebuild, so
     arrow-keying around the ring never replays the entrance animation and
     never drops landed art. */
  function applySel() {
    if (!stageEl) return;
    var cur = stageEl.querySelector('.qv-tile.is-sel');
    if (cur) cur.classList.remove('is-sel');
    var next = stageEl.querySelector('.qv-tile[data-abs="' + ui.sel + '"]');
    var r = ui.rows[ui.sel];
    if (next && r) {
      next.classList.add('is-sel');
      placeSelLabel(next, r);
    }
  }
  function turnPage(d) {
    var pages = Math.max(1, Math.ceil(ui.rows.length / ui.ringN));
    if (pages <= 1) return;
    ui.page = (ui.page + d + pages) % pages;
    ui.sel = clamp(ui.sel % ui.ringN + ui.page * ui.ringN, 0, ui.rows.length - 1);
    renderRing();
    renderHub();
    scheduleIcons(true);
  }

  /* ------------------------------------------------------------- icons */
  /* The potion-browser idiom, with the quiver's own opening move: renders are
     already queued by C++ off the qvList walk and every row arrives carrying
     `icon` (the on-disk render, if one exists from ANY prior session — they
     are render-once-keep-forever), so the ring paints real fletching on frame
     one instead of after a settle plus a round-trip. The settle gate survives
     for TYPING only, where it earns its keep; opening, paging and switching a
     pill ask straight away.

     A tile whose art has not landed yet says so — a spinning nock ring — and
     one that can never have art (a dynamic form, or a render the framework
     already refused) says THAT instead, because a spinner that cannot finish
     reads worse than no spinner at all (the Finder's own lesson). */

  var ICON_SETTLE_MS = 650, ICON_POLL_MS = 2500, ICON_POLL_MAX = 24;

  function idParts(r) {
    if (!r || !r.plugin || !r.formId || r.formId === '0x0') return null;
    return { formId: String(r.formId), plugin: String(r.plugin) };
  }
  /* view-relative paths only — the icon_bridge rule, applied to both sources */
  function safePath(path) {
    path = String(path || '');
    if (!path) return '';
    if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
    return path;
  }
  function iconFor(r) {
    if (!r) return '';
    /* C++ stamped it onto the row (first paint), or upgradeArt cached it there */
    var stamped = safePath(r.icon);
    if (stamped) return stamped;
    var p = idParts(r);
    if (!p) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      var path = safePath(WardrobePane.itemIconFor(p));
      /* remember it on the row so later renders skip the index lookup and the
         picture can never flicker back to a glyph mid-session */
      if (path) r.icon = path;
      return path;
    } catch (e) { return ''; }
  }
  /* Why this one will never get a picture, or '' if it still might. C++ marks
     the plugin-less forms; the framework's own verdicts ride the wardrobe
     index the same way every other pane reads them. */
  function iconFailure(r) {
    if (!r) return '';
    if (iconFor(r)) return '';
    if (r.noIcon || !idParts(r)) return 'This one has no plugin to render from';
    if (window.WardrobePane && typeof WardrobePane.itemIconFailed === 'function') {
      try { return String(WardrobePane.itemIconFailed(idParts(r)) || ''); } catch (e) {}
    }
    if (ui.iconGaveUp) return 'No render came back for this one';
    return '';
  }
  /* 'ok' | 'pending' | 'none' — what the plate should look like right now */
  function iconState(r) {
    if (iconFor(r)) return 'ok';
    return iconFailure(r) ? 'none' : 'pending';
  }
  function visibleRows() {
    return ui.rows.slice(ui.page * ui.ringN, ui.page * ui.ringN + ui.ringN);
  }
  function missingArt() {
    var vis = visibleRows();
    for (var i = 0; i < vis.length; i++)
      if (iconState(vis[i]) === 'pending') return true;
    return false;
  }
  function canRetryArt() {
    return !!(window.WardrobePane && typeof WardrobePane.retryItemIcon === 'function');
  }
  /* Forget the verdict and walk the normal path again — the wardrobe pane's
     own whIconRetry, so there is ONE implementation of "try again". */
  function retryArt(r) {
    var p = idParts(r);
    if (!p || !canRetryArt()) return;
    try {
      WardrobePane.retryItemIcon({ formId: p.formId, plugin: p.plugin, name: r.name || '' });
    } catch (e) { return; }
    delete ui.iconReq[p.formId + '|' + p.plugin];
    ui.iconGaveUp = false;
    r.icon = '';
    toast('Rendering ' + (r.name || 'it') + ' again…');
    paintPending();
    renderHub();
    startIconPoll();
  }

  /* how many drawn tiles are still waiting — the header's honest chip */
  function pendingCount() {
    var vis = visibleRows(), n = 0;
    for (var i = 0; i < vis.length; i++) if (iconState(vis[i]) === 'pending') n++;
    return n;
  }
  function requestIcons() {
    var items = [], seen = {};
    var vis = visibleRows();
    for (var i = 0; i < vis.length; i++) {
      var p = idParts(vis[i]);
      if (!p) continue;
      var key = p.formId + '|' + p.plugin;
      if (ui.iconReq[key] || seen[key]) continue;
      if (iconFor(vis[i])) continue;
      seen[key] = 1;
      ui.iconReq[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: vis[i].name || '' });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
  }
  /* `now` skips the settle gate — used for open, page turns, pill and ring
     changes, where the content jumped in one step and there is nothing to
     wait for. Only keystrokes settle. */
  function scheduleIcons(now) {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!ui.rows.length) { stopIconPoll(); paintPending(); return; }
    if (now) {
      if (!ui.open) return;
      requestIcons();
      startIconPoll();
      paintPending();
      return;
    }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.open) return;
      requestIcons();
      startIconPoll();
      paintPending();
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
      if (!ui.open || !missingArt()) { stopIconPoll(); paintPending(); return; }
      if (++ui.iconPollN > ICON_POLL_MAX) {
        /* Give up honestly rather than spin forever: with no Mesh Rendering
           Framework installed nothing will EVER land, and a nock ring turning
           on every tile for the rest of the session is a lie. The tiles fall
           back to their fletching glyph with a reason on hover. */
        ui.iconGaveUp = true;
        stopIconPoll();
        paintPending();
        return;
      }
      toGame('whIcons', JSON.stringify({ items: [] }));
    }, ICON_POLL_MS);
  }
  function upgradeArt() {
    if (!ui.open || !stageEl) return;
    var plates = stageEl.querySelectorAll('.qv-plate[data-rid]');
    for (var i = 0; i < plates.length; i++) {
      var plate = plates[i];
      if (plate.querySelector('img.qv-art')) continue;
      var r = rowById(plate.getAttribute('data-rid'));
      if (!r) continue;
      var url = iconFor(r);
      if (!url) continue;
      var img = document.createElement('img');
      img.className = 'qv-art';
      img.alt = '';
      img.draggable = false;
      img.onerror = (function (node, row) {
        return function () {
          if (node.parentNode) node.parentNode.removeChild(node);
          /* the path was stale — forget it so the plate goes back to waiting
             instead of showing a broken box for ever */
          if (row) row.icon = '';
          paintPending();
        };
      })(img, r);
      img.src = url;
      plate.appendChild(img);
    }
    paintPending();
  }

  /* The waiting state, painted on the plates that are drawn right now. Split
     out of renderRing so a batch landing never rebuilds the ring (a rebuild
     replays the entrance stagger and drops the selection's label). */
  function paintPending() {
    if (!stageEl) return;
    var plates = stageEl.querySelectorAll('.qv-plate[data-rid]');
    for (var i = 0; i < plates.length; i++) {
      var plate = plates[i];
      var r = rowById(plate.getAttribute('data-rid'));
      if (!r) continue;
      var st = iconState(r);
      plate.classList.toggle('is-waiting', st === 'pending');
      plate.classList.toggle('is-noart', st === 'none');
      if (st === 'none') plate.title = iconFailure(r);
      else if (st === 'pending') plate.title = 'Rendering this arrow…';
      else plate.removeAttribute('title');
    }
    renderCount();
  }
  function rowById(id) {
    for (var i = 0; i < state.rows.length; i++)
      if (rid(state.rows[i]) === id) return state.rows[i];
    return null;
  }

  /* ----------------------------------------------------- filter + sort */

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
        var hay = (String(r.desc || '') + ' ' +
          (r.poison ? String(r.poison.name || '') + ' ' + String(r.poison.fx || '') : '')).toLowerCase();
        var score = -1;
        if (n.indexOf(q) === 0) score = 0;
        else if (n.indexOf(q) !== -1) score = 1;
        else if (hay.indexOf(q) !== -1) score = 2;
        if (score < 0) continue;
        r._s = score;
      } else {
        r._s = 0;
      }
      out.push(r);
    }
    out.sort(function (a, b) {
      if (a._s !== b._s) return a._s - b._s;
      var d = 0;
      if (ui.sort === 'dmg')        d = (b.dmg || 0) - (a.dmg || 0);
      else if (ui.sort === 'value') d = (b.value || 0) - (a.value || 0);
      else if (ui.sort === 'count') d = (b.count || 0) - (a.count || 0);
      if (d) return d;
      var an = String(a.name || '').toLowerCase(), bn = String(b.name || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    ui.rows = out;
    var pages = Math.max(1, Math.ceil(out.length / ui.ringN));
    ui.page = clamp(ui.page, 0, pages - 1);
    ui.sel = clamp(ui.sel, 0, Math.max(0, out.length - 1));
  }

  /* ------------------------------------------------------------ render */

  function renderPills() {
    if (!pillsEl) return;
    pillsEl.innerHTML = '';
    CATS.forEach(function (c) {
      var n = ui.loaded ? catCount(c.id) : null;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qv-pill' + (ui.cat === c.id ? ' is-on' : '');
      b.setAttribute('data-cat', c.id);
      b.title = c.id === 'all' ? 'Every arrow and bolt you carry' : ('Only ' + c.label.toLowerCase());
      b.innerHTML = c.glyph + ' ' + esc(c.label) + (n === null ? '' : ' <span class="c">' + fmt(n) + '</span>');
      b.addEventListener('click', function () {
        ui.cat = c.id;
        ui.sel = 0;
        ui.page = 0;
        ui.catForced = true;
        renderAll();
        scheduleIcons(true);
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
      b.className = 'qv-sort' + (ui.sort === s.id ? ' is-on' : '');
      b.setAttribute('data-sort', s.id);
      b.title = 'Hardest-hitting, biggest stack, A-Z or priciest first';
      b.textContent = s.label;
      b.addEventListener('click', function () {
        ui.sort = s.id;
        ui.sel = 0;
        ui.page = 0;
        renderSorts();
        renderAll();   // re-sorts (compute), then repaints ring + hub
        savePrefsSoon();
      });
      sortsEl.appendChild(b);
    });
  }

  function renderRings() {
    if (!ringsEl) return;
    ringsEl.innerHTML = '';
    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Ring';
    ringsEl.appendChild(lbl);
    RINGS.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qv-ringn' + (ui.ringN === n ? ' is-on' : '');
      b.setAttribute('data-ring', String(n));
      b.title = n + ' tiles around the ring';
      b.textContent = String(n);
      b.addEventListener('click', function () {
        ui.ringN = n;
        ui.page = Math.floor(ui.sel / n);
        renderRings();
        renderRing();
        renderPage();
        savePrefsSoon();
        scheduleIcons(true);
      });
      ringsEl.appendChild(b);
    });
  }

  function renderPage() {
    if (!pageEl) return;
    var pages = Math.max(1, Math.ceil(ui.rows.length / ui.ringN));
    if (pages <= 1) { pageEl.innerHTML = ''; pageEl.style.display = 'none'; return; }
    pageEl.style.display = '';
    pageEl.innerHTML =
      '<button type="button" class="qv-pg" data-d="-1" title="Previous page">‹</button>' +
      '<span>' + (ui.page + 1) + ' / ' + pages + '</span>' +
      '<button type="button" class="qv-pg" data-d="1" title="Next page">›</button>';
    var btns = pageEl.querySelectorAll('.qv-pg');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { turnPage(parseInt(b.getAttribute('data-d'), 10)); });
      })(btns[i]);
    }
  }

  /* Tile size is PROPORTIONAL to the stage (fractions calibrated to the old
     104/88/74 px at the 560 stage), clamped sane — a 2560-wide screen gets
     plates worth looking at, a short window gets ones that fit. */
  function tilePx(S) {
    S = S || 560;
    var f = ui.ringN <= 8 ? 0.186 : ui.ringN <= 12 ? 0.157 : 0.132;
    return Math.max(48, Math.min(128, Math.round(S * f)));
  }

  /* The geometry contract: neighbouring plates never touch (spacing along
     the ring ≥ tile + 4px) AND the hub keeps ≥ 180px of clear air inside
     the plates' inner edge. Solved for the ACTUAL stage size by shrinking
     the tiles — overlap is a bug, not a style (UI rule 3). */
  function ringGeometry(S, n) {
    var T = tilePx(S);
    var R, hubD;
    for (;;) {
      R = S / 2 - T / 2 - 10;
      hubD = (R - T / 2 - 16) * 2;
      if (((2 * Math.PI * R) / n >= T + 4 && hubD >= 180) || T <= 48) break;
      T -= 4;
    }
    hubD = Math.min(320, Math.max(150, Math.round(hubD)));
    return { T: T, R: R, hubD: hubD };
  }

  function renderRing() {
    if (!stageEl) return;
    /* clear old tiles (hub + page chip stay) */
    var old = stageEl.querySelectorAll('.qv-tile, .qv-sel-label, .qv-empty');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

    if (!ui.loaded) return;   // hub shows the skeleton note
    if (!ui.rows.length) {
      var em = document.createElement('div');
      em.className = 'qv-empty';
      var catLbl = (CATS.filter(function (c) { return c.id === ui.cat; })[0] || {}).label || '';
      em.innerHTML = ui.q
        ? 'Nothing matches <b>' + esc(ui.q) + '</b>' + (ui.cat !== 'all' ? ' among your ' + esc(catLbl.toLowerCase()) : '') + '.'
        : (ui.cat === 'all'
            ? 'Your quiver is empty — no arrows or bolts in your bag.'
            : 'No ' + esc(catLbl.toLowerCase()) + ' in your quiver.');
      stageEl.appendChild(em);
      renderPage();
      return;
    }

    var S = stageEl.clientWidth || 560;
    var g = ringGeometry(S, ui.ringN);
    var T = g.T, R = g.R;
    ui.tileDrawn = T;   // placeSelLabel clears the ACTUAL tile, not the ideal
    /* density class: the 16-ring wears smaller badges (hd-quiver.css) */
    stageEl.className = 'qv-stage qv-n' + ui.ringN;
    /* the decorative bowstring line tracks the real ring radius */
    stageEl.style.setProperty('--qv-ring-inset', Math.round(S / 2 - R) + 'px');
    /* the hub breathes with the ring — never reaches the plates' inner edge */
    hubEl.style.width = hubEl.style.height = g.hubD + 'px';
    hubEl.classList.toggle('qv-hub-tight', g.hubD < 220);
    var cx = S / 2, cy = (stageEl.clientHeight || S) / 2;
    var vis = visibleRows();
    for (var k = 0; k < vis.length; k++) {
      var r = vis[k];
      var abs = ui.page * ui.ringN + k;
      /* slot 0 at 12 o'clock, clockwise — always N slots so positions are
         stable on a part-filled last page */
      var ang = -Math.PI / 2 + (k * 2 * Math.PI) / ui.ringN;
      var x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang);
      var tile = document.createElement('div');
      var selected = abs === ui.sel;
      tile.className = 'qv-tile' + (selected ? ' is-sel' : '') +
        (r.equipped ? ' is-nocked' : '') + (r.count > 0 ? '' : ' is-gone');
      tile.setAttribute('data-abs', String(abs));
      tile.style.width = tile.style.height = T + 'px';
      tile.style.left = x + 'px';
      tile.style.top = y + 'px';
      tile.style.setProperty('--i', String(k));   // entrance stagger (open only)
      var dots = '';
      if (r.poison) dots += '<span class="qv-dot d-poison" title="Poisoned: ' + esc(r.poison.name) + '">☠</span>';
      if (isEnch(r)) dots += '<span class="qv-dot d-ench" title="Enchanted">✦</span>';
      if (isFav(r)) dots += '<span class="qv-dot d-fav" title="Favorite">★</span>';
      /* the plate's waiting/no-art class is set at BUILD time, not only by the
         paintPending pass, so a freshly drawn ring never flashes a bare glyph
         for a frame before the spinner appears */
      var ist = iconState(r);
      tile.innerHTML =
        '<div class="qv-plate' + (ist === 'pending' ? ' is-waiting' : ist === 'none' ? ' is-noart' : '') +
          '" data-rid="' + esc(rid(r)) + '">' + (r.bolt ? '➾' : '➹') + '</div>' +
        '<span class="qv-dmg" title="Damage ' + fmt(r.dmg || 0) + '">' + fmt(r.dmg || 0) + '</span>' +
        '<span class="qv-cnt" title="You carry ' + fmt(r.count || 0) + '">' + fmt(r.count || 0) + '</span>' +
        (dots ? '<span class="qv-dots">' + dots + '</span>' : '');
      (function (node, row, idx) {
        node.addEventListener('mouseenter', function () {
          if (ui.sel === idx) return;
          ui.sel = idx;
          applySel();
          renderHub();
        });
        node.addEventListener('click', function () { ui.sel = idx; nock(row); });
      })(tile, r, abs);
      stageEl.appendChild(tile);
      if (selected) placeSelLabel(tile, r);
    }
    renderPage();
    upgradeArt();
  }

  /* Only the SELECTED tile gets a floating name label — 16 labels around a
     ring collide with each other (the hotbar fan's own lesson). Clears the
     damage badge below the tile and the count chip above it, and never runs
     off the stage's edges. */
  function placeSelLabel(tile, r) {
    var old = stageEl.querySelector('.qv-sel-label');
    if (old) old.parentNode.removeChild(old);
    var lab = document.createElement('div');
    lab.className = 'qv-sel-label';
    lab.innerHTML = markUp(r.name || '', ui.q.trim());
    lab.title = r.name || '';
    var S = stageEl.clientWidth || 560;
    var T = ui.tileDrawn || tilePx(S);
    var top = parseFloat(tile.style.top) || 0;
    var left = parseFloat(tile.style.left) || 0;
    var cy = (stageEl.clientHeight || S) / 2;
    lab.style.left = clamp(left, 110, Math.max(110, S - 110)) + 'px';
    /* AWAY from the hub, always: a top-half tile labels ABOVE itself (clear
       of its count chip), a bottom-half tile BELOW (clear of its damage
       badge). The stage's grown margins are the label's overhang room. */
    var y = top + (top <= cy ? -(T / 2 + 28) : (T / 2 + 36));
    lab.style.top = clamp(y, -20, (stageEl.clientHeight || S) + 8) + 'px';
    stageEl.appendChild(lab);
  }

  function markUp(text, q) {
    var raw = String(text || '');
    if (!q) return esc(raw);
    var i = raw.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(raw);
    return esc(raw.slice(0, i)) + '<mark>' + esc(raw.slice(i, i + q.length)) + '</mark>' + esc(raw.slice(i + q.length));
  }

  function renderHub() {
    if (!hubEl) return;
    if (!ui.loaded) {
      hubEl.innerHTML = '<div class="qv-hub-skel"><div class="s1"></div><div class="s2"></div><div class="s3"></div></div>';
      return;
    }
    var r = ui.rows[ui.sel];
    if (!r) {
      hubEl.innerHTML = '<div class="qv-hub-none">➶</div>';
      return;
    }
    var lines = '';
    if (r.poison)
      lines += '<div class="qv-hub-fx is-poison">☠ ' + esc(r.poison.name) +
        (r.poison.count > 0 ? ' · ' + fmt(r.poison.count) + ' shot' + (r.poison.count === 1 ? '' : 's') : '') +
        (r.poison.fx ? '<span class="sub">' + esc(r.poison.fx) + '</span>' : '') + '</div>';
    if (r.desc)
      lines += '<div class="qv-hub-fx is-ench">✦ ' + esc(r.desc) + '</div>';
    if (r.explode && !r.desc)
      lines += '<div class="qv-hub-fx is-ench">✦ Explodes on impact</div>';
    hubEl.innerHTML =
      '<div class="qv-hub-kind">' + (r.bolt ? '➾ Bolt' : '➹ Arrow') + (r.equipped ? ' · <b class="nk">nocked</b>' : '') + '</div>' +
      '<div class="qv-hub-name" title="' + esc(r.name) + '">' + markUp(r.name, ui.q.trim()) + '</div>' +
      '<div class="qv-hub-nums">' +
        '<span class="n-dmg" title="Damage">⚔ <b>' + fmt(r.dmg || 0) + '</b></span>' +
        '<span title="How many you carry">x' + fmt(r.count || 0) + '</span>' +
        '<span title="Gold value">🜚 ' + fmt(r.value || 0) + '</span>' +
      '</div>' +
      lines +
      '<div class="qv-hub-act">' +
        '<button id="qv-nock" type="button"' + (r.count > 0 ? '' : ' disabled') + '>' +
          (r.count > 0 ? (r.equipped ? 'Put away' : 'Nock it') : 'None left') + '</button>' +
        '<button id="qv-fav" type="button" class="' + (ui.favs[favKey(r)] ? 'is-on' : '') + '" ' +
          'title="Favorite — pins it to the ★ Favorites pill">★</button>' +
        /* the retry only exists where a render is actually possible AND has
           already failed — the honest x with a way out, never a dead button */
        (iconState(r) === 'none' && idParts(r) && canRetryArt()
          ? '<button id="qv-reart" type="button" title="' + esc(iconFailure(r)) +
              ' — try rendering it again">⟳</button>'
          : '') +
      '</div>';
    var nockBtn = document.getElementById('qv-nock');
    if (nockBtn) nockBtn.addEventListener('click', function () { nock(r); });
    var favBtn = document.getElementById('qv-fav');
    if (favBtn) favBtn.addEventListener('click', function () { toggleFav(r); });
    var reBtn = document.getElementById('qv-reart');
    if (reBtn) reBtn.addEventListener('click', function () { retryArt(r); });
  }

  function renderLauncher() {
    if (!launcherEl) return;
    if (!ui.loaded) { launcherEl.innerHTML = ''; return; }
    var L = state.launcher;
    if (!L) {
      launcherEl.innerHTML = '<span class="dim">No bow or crossbow in hand — nock ammo anyway; it waits for the draw.</span>';
      return;
    }
    var html = (L.kind === 'crossbow' ? '⩤' : '🏹') + ' In hand: <b>' + esc(L.name) + '</b>';
    if (L.poison)
      html += ' <span class="qv-lp" title="' + esc(L.poison.fx || '') + '">☠ ' + esc(L.poison.name) +
        (L.poison.count > 0 ? ' · ' + fmt(L.poison.count) + ' shot' + (L.poison.count === 1 ? '' : 's') + ' left' : '') + '</span>';
    else
      html += ' <span class="dim">· no poison on it</span>';
    launcherEl.innerHTML = html;
  }

  function renderCount() {
    if (!countEl) return;
    if (!ui.loaded) { countEl.innerHTML = ''; return; }
    var total = 0;
    for (var i = 0; i < state.rows.length; i++) total += state.rows[i].count || 0;
    /* the waiting chip goes NEXT TO the count rather than replacing it: how
       many renders are still cooking is a status, not the headline */
    var pend = pendingCount();
    countEl.innerHTML =
      '<span class="qv-count-t">' +
        esc(fmt(state.rows.length) + ' kinds · ' + fmt(total) + ' shots') + '</span>' +
      (pend ? '<span class="qv-rendering" title="The mesh renderer is drawing these arrows — ' +
                'they keep their picture once it has, in this session and every one after">' +
                '<i class="qv-spin"></i>rendering ' + fmt(pend) + '</span>' : '');
  }

  function renderAll() {
    compute();
    renderPills();
    renderCount();
    renderRing();
    renderHub();
    renderLauncher();
  }

  /* ------------------------------------------------------------- verbs */

  function nock(r) {
    if (!r || !(r.count > 0)) return;
    toGame('qvUse', JSON.stringify({ plugin: r.plugin || '', formId: r.formId || '', rt: r.rt || 0 }));
    if (DEV && typeof window.qvUse !== 'function') {
      var self = r;
      setTimeout(function () {
        window.qvUseResult({ ok: true, msg: (self.equipped ? 'Put away ' : 'Nocked ') + self.name,
          plugin: self.plugin, formId: self.formId, equipped: !self.equipped });
      }, 0);
    }
  }

  function toggleFav(r) {
    var k = favKey(r);
    if (ui.favs[k]) delete ui.favs[k];
    else ui.favs[k] = 1;
    /* leaving the Favorites pill un-favorites OUT of the view honestly */
    if (ui.cat === 'favs') { renderAll(); scheduleIcons(true); }
    else { renderRing(); renderHub(); renderPills(); }
    savePrefsSoon();
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1700);
  }

  function savePrefsSoon() {
    if (ui.saveT) clearTimeout(ui.saveT);
    ui.saveT = setTimeout(function () {
      ui.saveT = null;
      toGame('qvSave', JSON.stringify({
        sort: ui.sort, cat: ui.cat, ring: ui.ringN, favs: Object.keys(ui.favs),
        x: ui.place.x, y: ui.place.y, w: ui.place.w }));
    }, 400);
  }

  /* -------------------------------------------------------- open/close */

  function open(standalone, cat) {
    ensureDom();
    ui.open = true;
    ui.standalone = !!standalone;
    ui.sel = 0;
    ui.page = 0;
    ui.q = '';
    if (qEl) qEl.value = '';
    if (cat && CATS.some(function (c) { return c.id === cat; })) {
      ui.cat = cat;
      ui.catForced = true;
    }
    /* a new open deserves a fresh verdict: the framework may have finished
       (or been installed) since the last one gave up */
    ui.iconGaveUp = false;
    document.body.classList.add('qv-open');
    applyPlace();
    /* entrance: the tiles pop in staggered ON OPEN ONLY — the class leaves
       before any re-render, so arrow keys and filters never replay it */
    root.classList.add('qv-enter');
    setTimeout(function () { if (root) root.classList.remove('qv-enter'); }, 550);
    ui.loaded = false;
    renderAll();
    toGame('qvList');
    setTimeout(function () { if (ui.open && qEl) qEl.focus(); }, 30);
  }

  function close(closeDeck) {
    if (!ui.open) return;
    ui.open = false;
    stopIconPoll();
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    document.body.classList.remove('qv-open');
    if (closeDeck && ui.standalone) {
      if (env && typeof env.closeDeck === 'function') env.closeDeck();
      else toGame('hdClose');
    }
    ui.standalone = false;
  }

  /* --------------------------------------------------------- receivers */

  window.qvListData = function (j) {
    var d = coerce(j);
    if (!d || typeof d !== 'object') return;
    state.rows = Array.isArray(d.rows) ? d.rows : [];
    state.launcher = (d.launcher && typeof d.launcher === 'object') ? d.launcher : null;
    ui.loaded = true;
    if (!ui.prefsApplied && d.prefs && typeof d.prefs === 'object') {
      ui.prefsApplied = true;
      if (!ui.catForced && d.prefs.cat && CATS.some(function (c) { return c.id === d.prefs.cat; }))
        ui.cat = d.prefs.cat;
      if (d.prefs.sort && SORTS.some(function (s) { return s.id === d.prefs.sort; }))
        ui.sort = d.prefs.sort;
      if (RINGS.indexOf(d.prefs.ring | 0) !== -1) ui.ringN = d.prefs.ring | 0;
      /* where you left the window. Nulls are honoured as "centred", and every
         value is clamped by applyPlace, so a spot saved on one resolution can
         never strand the quiver off-screen on another. */
      if (typeof d.prefs.x === 'number') ui.place.x = Math.round(d.prefs.x);
      if (typeof d.prefs.y === 'number') ui.place.y = Math.round(d.prefs.y);
      if (typeof d.prefs.w === 'number') ui.place.w = Math.round(d.prefs.w);
      applyPlace();
      if (Array.isArray(d.prefs.favs)) {
        ui.favs = {};
        for (var i = 0; i < d.prefs.favs.length; i++)
          ui.favs[String(d.prefs.favs[i])] = 1;
      }
    }
    if (!ui.open) return;
    renderSorts();
    renderRings();
    renderAll();
    scheduleIcons(true);
  };

  window.qvUseResult = function (j) {
    var d = coerce(j);
    if (!d || typeof d !== 'object') return;
    if (!d.ok) { toast(d.msg || 'That didn\'t work'); return; }
    toast(d.msg || 'Done');
    /* one nock slot: equipping this one un-equips the rest */
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (r.plugin === d.plugin && r.formId === d.formId) r.equipped = !!d.equipped;
      else if (d.equipped) r.equipped = false;
    }
    renderRing();
    renderHub();
  };

  window.qvSaved = function () { /* ack only */ };

  /* ---- Omni search provider: the quiver + its two family doors -------- */
  if (window.HDOmni) {
    HDOmni.register({
      id: 'quiver', label: 'Quiver', tab: 'items',
      index: function () {
        return [{
          label: 'Quiver',
          detail: 'Every arrow and bolt you carry, on a ring — damage, poisons, enchantments; click to nock',
          kind: 'quiver',
          keywords: 'quiver ammo arrows bolts nock equip ring radial archery bow crossbow',
          run: function () { open(false, ''); },
        }, {
          label: 'Quiver: Arrows',
          detail: 'Open the quiver on your arrows',
          kind: 'quiver',
          keywords: 'arrows ammo quiver',
          run: function () { open(false, 'arrows'); },
        }, {
          label: 'Quiver: Bolts',
          detail: 'Open the quiver on your bolts',
          kind: 'quiver',
          keywords: 'bolts crossbow ammo quiver',
          run: function () { open(false, 'bolts'); },
        }];
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
    _renderAll: renderAll,
    _renderRing: renderRing,
    _renderHub: renderHub,
    _renderLauncher: renderLauncher,
    _nock: nock,
    _toggleFav: toggleFav,
    _rid: rid,
    _favKey: favKey,
    _inCat: inCat,
    _isEnch: isEnch,
    _tilePx: tilePx,
    _applyPlace: applyPlace,
    _resetPlace: resetPlace,
    _nudge: nudge,
    _sizeBy: sizeBy,
    _snapEdges: snapEdges,
    _moveSel: moveSel,
    _turnPage: turnPage,
    _visibleRows: visibleRows,
    _iconFor: iconFor,
    _iconState: iconState,
    _iconFailure: iconFailure,
    _pendingCount: pendingCount,
    _paintPending: paintPending,
    _retryArt: retryArt,
    _missingArt: missingArt,
    _flushIcons: function () {
      if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
      requestIcons();
    },
    _upgradeArt: upgradeArt,
    _cats: CATS,
    _sorts: SORTS,
    _rings: RINGS,
  };

  /* A deep-open that raced this deferred script parked its family on the
     window (app.js's hdShowTab router) — consume it now. */
  var pend = window.__hdPendingQuiver;
  if (pend !== undefined && pend !== null) {
    window.__hdPendingQuiver = null;
    open(true, pend === '1' ? '' : String(pend));
  }

  return api;
})();
