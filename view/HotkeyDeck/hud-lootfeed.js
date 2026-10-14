/* ============================================================================
   Loot feed (2026-10-12) — the rows behind hud-lootfeed.css. Read its header
   for the ask and the HUD laws this obeys.

   API (window.HDLootFeed):
     mount(host)        build the feed inside `host` (an absolutely placed box)
     setCfg(cfg)        { max 1-12, lifeMs, value, grow:'down'|'up', scale,
                          richAt (stack value that lights the edge, 0 = never) }
     push(list)         [{ id, name, count, kind, value, icon }] — one entry per
                        item that entered the bag; C++ batches a frame's pickups
     clear()            drop every row at once (load screen, feed switched off)
     state()            rows on screen, for harnesses

   Row lifecycle: arrive (slide in from the left) → live `lifeMs` → leave
   (fade + slide left) → removed, and the rows behind it slide up into the gap.
   A repeat of an item whose row is still up is MERGED into it: count bumps,
   its life restarts, nothing moves. More rows than `max`: the oldest leaves
   early (a quicker fade), so the feed never grows past the limit.
   ============================================================================ */
(function () {
  'use strict';

  var ROW = 58;                 // row pitch in layout px — hud-lootfeed.css --lf-row
  var ARRIVE_X = -48, LEAVE_X = -36;
  var SETTLE_MS = 240, STAGGER_MS = 70;   // the 280 ms slide is ~95% there at 240
  var cfg = { max: 5, lifeMs: 4500, value: true, grow: 'down', scale: 1, richAt: 250 };
  var host = null, root = null, ghost = null;
  var rows = [];                // newest first
  var seq = 0;

  /* Family art. The deck's own gold glyph set (icons/custom/gl-*), one per kind
     C++ reports; an item that has a real 3D render (icons/items/…) wears that. */
  var KIND_ART = {
    gold: 'gl-coins', ingredient: 'gl-herb', flora: 'gl-herb', potion: 'gl-potion', poison: 'gl-potion',
    food: 'gl-meat', drink: 'gl-tankard', gem: 'gl-gem', ore: 'gl-stone', ingot: 'gl-stone',
    book: 'gl-book', scroll: 'gl-scroll', note: 'gl-notepad', key: 'gl-key', soulgem: 'gl-orb',
    weapon: 'gl-swords', bow: 'gl-bow', ammo: 'gl-bow', armor: 'gl-shield', clothing: 'gl-shirt',
    jewelry: 'gl-ring', pelt: 'gl-paw', misc: 'gl-pouch'
  };
  function artFor(it) {
    if (it.icon) return { src: it.icon, render: true };
    return { src: 'icons/custom/' + (KIND_ART[it.kind] || KIND_ART.misc) + '.png', render: false };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  function fmtNum(n) {
    n = Math.round(Number(n) || 0);
    return n >= 10000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
  }

  function mount(h) {
    host = h;
    root = document.createElement('div');
    root.className = 'hud-lf lf-empty';
    ghost = document.createElement('div');
    ghost.className = 'hud-lf-ghost';
    ghost.innerHTML = '<span class="hud-lf-art"><img src="icons/custom/gl-pouch.png" alt=""></span>Loot feed';
    root.appendChild(ghost);
    host.appendChild(root);
    applyCfg();
    return root;
  }

  function applyCfg() {
    if (!root) return;
    root.style.setProperty('--lf-scale', String(cfg.scale));
    root.classList.toggle('lf-noval', !cfg.value);
    root.classList.toggle('lf-up', cfg.grow === 'up');
  }

  function setCfg(c) {
    if (!c || typeof c !== 'object') return;
    var n = Number(c.max);
    if (isFinite(n)) cfg.max = Math.max(1, Math.min(12, Math.round(n)));
    n = Number(c.lifeMs);
    if (isFinite(n)) cfg.lifeMs = Math.max(1500, Math.min(15000, n));
    if (typeof c.value === 'boolean') cfg.value = c.value;
    if (c.grow === 'up' || c.grow === 'down') cfg.grow = c.grow;
    n = Number(c.scale);
    if (isFinite(n)) cfg.scale = Math.max(0.5, Math.min(2.5, n));
    n = Number(c.richAt);
    if (isFinite(n)) cfg.richAt = Math.max(0, n);
    applyCfg();
    while (liveRows().length > cfg.max) leave(oldestLive(), true);
    layout();
  }

  function liveRows() { return rows.filter(function (r) { return !r.leaving; }); }
  function oldestLive() { var l = liveRows(); return l[l.length - 1]; }

  /* translateY for row slot `i` (0 = the anchor edge). Growing UP stacks
     upwards from the host's bottom-left, so a feed parked low on the screen
     keeps its newest row nearest the edge it is anchored to. */
  function yFor(i) { return cfg.grow === 'up' ? -(i + 1) * ROW : i * ROW; }

  var now = (window.performance && performance.now) ? function () { return performance.now(); } : Date.now;
  var lastMove = -1e9;          // when the visible stack last started sliding

  /* `instant`: jump there with no transition. A row still waiting to slide in
     is invisible, and letting it glide to a new slot means it is somewhere in
     the middle of the stack when it does fade in. */
  function place(r, x, instant) {
    var el = r.el;
    if (instant) el.style.transition = 'none';
    el.style.transform = 'translate(' + (x || 0) + 'px,' + yFor(r.slot) + 'px)';
    if (instant) { void el.offsetWidth; el.style.transition = ''; }
  }

  /* Every row on screen keeps a slot, LEAVING ones included, until it is
     removed: a row fading out holds its place, so nothing slides under it while
     it is still visible (the first cut let the rows pushed past `max` fade
     where they stood while the stack moved down onto them). Rows behind a
     leaver close the gap when it is removed, not before. */
  function layout() {
    var moved = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], was = r.slot;
      r.slot = i;
      /* a row still waiting to slide in is re-placed too, at its NEW slot and
         instantly: three items arriving in one push otherwise all started in
         slot 0 and slid apart while fading in (the preview's overlap check) */
      if (!r.shown && !r.leaving) { place(r, ARRIVE_X, true); continue; }
      if (was !== i) moved.push(r);
      else place(r, r.leaving ? LEAVE_X : 0);
    }
    if (moved.length) {
      /* Start every moving row on the SAME frame. A row interrupted mid-slide
         restarts its transition one frame ahead of a row at rest, and the two
         squeezed 21 px into each other on the way down (traced frame by frame
         in the preview). So: pin each one where it is right now, flush once,
         then hand them all their new slots together. */
      lastMove = now();
      for (var m = 0; m < moved.length; m++) {
        var cur = '';
        try { cur = getComputedStyle(moved[m].el).transform; } catch (e) {}
        moved[m].el.style.transition = 'none';
        if (cur && cur !== 'none') moved[m].el.style.transform = cur;
      }
      void root.offsetWidth;
      for (var k = 0; k < moved.length; k++) {
        moved[k].el.style.transition = '';
        place(moved[k], moved[k].leaving ? LEAVE_X : 0);
      }
    }
    if (root) root.classList.toggle('lf-empty', rows.length === 0);
  }

  function rowHtml(r) {
    var a = artFor(r.it);
    var count = r.it.kind === 'gold' ? '+' + fmtNum(r.count) : (r.count > 1 ? '×' + fmtNum(r.count) : '');
    var name = r.it.kind === 'gold' ? 'Gold' : r.it.name;
    var val = (r.it.kind !== 'gold' && r.it.value > 0)
      ? '<span class="hud-lf-val"><img src="icons/custom/gl-coins.png" alt="">' + fmtNum(r.it.value * r.count) + '</span>' : '';
    return '<span class="hud-lf-art"><img' + (a.render ? ' class="lf-render"' : '') + ' src="' + esc(a.src) + '" alt=""></span>' +
      '<span class="hud-lf-name">' + esc(name) + '</span>' +
      '<span class="hud-lf-count">' + esc(count) + '</span>' + val;
  }

  function isRich(r) { return cfg.richAt > 0 && r.it.kind !== 'gold' && r.it.value * r.count >= cfg.richAt; }

  function arm(r) {
    clearTimeout(r.timer);
    r.timer = setTimeout(function () { leave(r, false); }, cfg.lifeMs);
  }

  function arrive(it, batchIdx) {
    batchIdx = batchIdx | 0;
    var el = document.createElement('div');
    el.className = 'hud-lf-row lf-k-' + (it.kind || 'misc');
    var r = { key: String(it.id || it.name), it: it, count: Math.max(1, it.count | 0), el: el,
              slot: 0, shown: false, leaving: false, timer: 0, n: ++seq };
    el.innerHTML = rowHtml(r);
    el.classList.toggle('lf-rich', isRich(r));
    rows.unshift(r);
    root.appendChild(el);
    /* Rows already on screen slide down to make room; a new row that faded in
       at once would be crossed by them mid-slide (the preview's overlap check
       measured 38-43 px). So it waits for the stack to settle, and a batch
       (a chest, a sweep frame) cascades in 70 ms apart. */
    var moving = rows.some(function (x) { return x.shown && !x.leaving; });
    var wait = (moving ? SETTLE_MS : 0) + batchIdx * STAGGER_MS;
    layout();             // places it off to the left, in its slot
    /* At least two frames either way: the first commits the start position —
       one frame is not enough for the engine to see a "from". */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var go = function () {
          if (r.leaving) return;
          /* the stack moved again while it waited (the next chest, the next
             sweep frame): wait for that slide to finish too */
          var since = now() - lastMove;
          if (since < SETTLE_MS) { setTimeout(go, SETTLE_MS - since + 10); return; }
          r.shown = true;
          el.classList.add('lf-in');
          place(r, 0);
        };
        if (wait > 0) setTimeout(go, wait); else go();
      });
    });
    arm(r);
  }

  function merge(r, it) {
    r.count += Math.max(1, it.count | 0);
    if (it.value > 0) r.it.value = it.value;
    r.el.innerHTML = rowHtml(r);
    r.el.classList.toggle('lf-rich', isRich(r));
    var c = r.el.querySelector('.hud-lf-count');
    if (c) c.classList.add('lf-bump');
    arm(r);
  }

  function leave(r, early) {
    if (!r || r.leaving) return;
    r.leaving = true;
    clearTimeout(r.timer);
    r.el.classList.remove('lf-in');
    r.el.classList.add(early ? 'lf-drop' : 'lf-out');
    place(r, LEAVE_X);
    setTimeout(function () {
      if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
      var i = rows.indexOf(r);
      if (i !== -1) rows.splice(i, 1);
      layout();   // the rows behind it close the gap now that it is gone
    }, early ? 220 : 400);
  }

  function push(list) {
    if (!root) return;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { return; } }
    if (!Array.isArray(list)) list = list && Array.isArray(list.items) ? list.items : [];
    var fresh = 0;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || !(it.name || it.kind === 'gold')) continue;
      it = { id: it.id, name: String(it.name || ''), count: Math.max(1, Number(it.count) | 0),
             kind: String(it.kind || 'misc'), value: Math.max(0, Number(it.value) || 0),
             icon: typeof it.icon === 'string' && it.icon && !/^[a-z]+:|\.\./i.test(it.icon) ? it.icon : '' };
      var key = String(it.id || it.name);
      var hit = null;
      for (var k = 0; k < rows.length; k++) if (!rows[k].leaving && rows[k].key === key) { hit = rows[k]; break; }
      if (hit) merge(hit, it);
      else {
        arrive(it, fresh++);
        while (liveRows().length > cfg.max) leave(oldestLive(), true);
      }
    }
  }

  function clear() {
    rows.forEach(function (r) { clearTimeout(r.timer); if (r.el.parentNode) r.el.parentNode.removeChild(r.el); });
    rows = [];
    layout();
  }

  function state() {
    return liveRows().map(function (r) {
      return { key: r.key, name: r.it.name, count: r.count, slot: r.slot, rich: r.el.classList.contains('lf-rich') };
    });
  }

  window.HDLootFeed = { mount: mount, setCfg: setCfg, push: push, clear: clear, state: state, cfg: function () { return cfg; } };
})();
