'use strict';

/* ====================================================================== *
 *  Survival tab — the dashboard (Rober, 2026-08-15: "that stats thing …
 *  would be better suited in a tab that has a sort of customizable system
 *  that lets you enable and move around the stats / information etc.
 *  resize. the popout is for quick actions").
 *
 *  So the split is: the POPOUT is verbs (pitch, drink, pray, harvest), this
 *  TAB is everything you read. Every number here is one the mods themselves
 *  keep — C++ (survival.cpp) reads their globals and ships them; this pane
 *  only arranges them.
 *
 *  THE ARRANGEMENT IS THE FEATURE:
 *    * every card can be turned off,
 *    * dragged into any order (pointer-drag — Ultralight has no HTML5 DnD,
 *      the deck's own idiom since the Followers pane),
 *    * and sized S / M / L, which is a COLUMN SPAN, so the grid stays a grid
 *      instead of becoming free-floating boxes that overlap at the 640px
 *      floor.
 *  Layout persists in the sv* sidecar (C++-owned, view-opaque), so it is the
 *  same on your next launch and cannot be eaten by a config round-trip.
 *
 *  Bridge: svState -> svStateResult (shared with the popout: ONE read of the
 *  mods' state serves both), svLayout -> svLayoutSaved.
 * ====================================================================== */

window.SurvivalPane = (function () {
  const DEV = location.search.indexOf('dev=1') !== -1;
  const SIZES = ['s', 'm', 'l'];

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[svtab dev->game]', fn, arg);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function coerce(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  function $(id) { return document.getElementById(id); }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  const state = { loaded: false, hero: null, needs: null, camp: {}, water: {} };
  const ui = {
    visible: false,
    edit: false,            // the arrange mode: toggles, sizes, drag handles
    layout: null,           // [{id, on, size}] — the saved arrangement
    drag: null,             // { id, fromX, fromY, moved }
    q: '',
  };

  /* ---------------------------------------------------------- the cards */

  /* Card ids are DERIVED from the payload, so a card appears the day C++
     starts shipping its group and disappears when the mod is uninstalled —
     no list here to keep in step. `needs` and `career` are the two the view
     composes itself out of the shared state. */
  /* Which mod a card speaks for, so the board is scannable by colour instead
     of being a wall of identical grey boxes. Matched on the label because that
     is what C++ names the group after — a new mod picks up the neutral accent
     and still reads fine. */
  function accentFor(label) {
    const l = String(label || '').toLowerCase();
    if (l.indexOf('sunhelm') !== -1 || l.indexOf('need') !== -1 ||
        l.indexOf('temperature') !== -1 || l.indexOf('rate') !== -1) return 'sun';
    if (l.indexOf('campfire') !== -1) return 'camp';
    if (l.indexOf('hunterborn') !== -1) return 'hunt';
    if (l.indexOf('wintersun') !== -1 || l.indexOf('faith') !== -1) return 'faith';
    if (l.indexOf('life') !== -1) return 'life';
    return '';
  }

  function cardDefs() {
    const out = [];
    if (state.needs && state.needs.present && (state.needs.meters || []).length)
      out.push({ id: 'needs', label: (state.needs.mod || 'Needs'), kind: 'needs' });
    ((state.hero && state.hero.blocks) || []).forEach(function (b) {
      out.push({ id: 'hero:' + b.id, label: b.label, kind: 'hero', block: b });
    });
    ((state.hero && state.hero.statGroups) || []).forEach(function (g) {
      out.push({ id: 'stat:' + g.label, label: g.label, kind: 'stat', group: g });
    });
    out.forEach(function (d) { d.accent = accentFor(d.label); });
    return out;
  }

  function layoutFor(defs) {
    const saved = Array.isArray(ui.layout) ? ui.layout : [];
    const byId = {};
    saved.forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    /* saved order first (so dragging sticks), then anything new appended —
       a card that appears because you installed a mod must not be invisible */
    const ordered = [];
    saved.forEach(function (l) {
      const d = defs.filter(function (x) { return x.id === l.id; })[0];
      if (d) ordered.push(d);
    });
    defs.forEach(function (d) { if (ordered.indexOf(d) === -1) ordered.push(d); });
    return ordered.map(function (d) {
      const l = byId[d.id] || {};
      return {
        def: d,
        on: l.on !== false,
        size: SIZES.indexOf(l.size) === -1 ? 'm' : l.size,
      };
    });
  }

  /* Two halves on purpose. A drag reorders on EVERY card you pass over, and
     each of those used to be a sidecar write — dozens of disk writes for one
     gesture. Now the order is applied in memory as you move (so the board keeps
     up) and pushed once when you let go. */
  function applyLayout(cards) {
    ui.layout = cards.map(function (c) {
      return { id: c.def.id, on: !!c.on, size: c.size };
    });
  }
  function pushLayout() {
    toGame('svLayout', JSON.stringify({ cards: ui.layout || [] }));
  }
  function saveLayout(cards) { applyLayout(cards); pushLayout(); }

  /* ------------------------------------------------------------ render */

  function fmt(v, isInt) {
    const n = Number(v) || 0;
    return isInt === false ? (Math.round(n * 100) / 100) : Math.round(n);
  }

  /* The needs card reads a meter through the POPOUT's own vitals semantics
     (HDSurvival.needMeta): one direction table, one set of severity bands, one
     set of state words. Two surfaces fed by the same svStateResult must never
     disagree about whether you are starving — and the direction of a meter is
     the one thing neither may guess at separately. If the popout module is not
     loaded (a broken install, a harness), this degrades to exactly what it drew
     before: number, and a track only where the mod publishes a max.
     marker: sp-need-word */
  function needMeta(m) {
    try {
      if (window.HDSurvival && typeof HDSurvival.needMeta === 'function')
        return HDSurvival.needMeta(m) || null;
    } catch (e) { /* fall through to the plain reading */ }
    return null;
  }

  function needsCardHtml(n) {
    return (n.meters || []).map(function (m) {
      const val = Math.round(Number(m.value) || 0);
      const pub = (typeof m.max === 'number' && m.max > 0) ? m.max : 0;
      const meta = needMeta(m);
      const max = pub || (meta ? meta.max : 0);
      const assumed = !pub && !!(meta && meta.assumed);
      const pct = (max && !m.off) ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
      const drawBar = !m.off && !!max && (!!pub || !!meta);
      return '<div class="sp-need' + (m.off ? ' sp-off' : '') +
        (meta && meta.sevClass ? ' ' + meta.sevClass : '') +
        '" data-need="' + esc(String(m.id || '')) + '">' +
        '<div class="sp-need-top"><span>' +
        (meta && meta.glyph ? '<i class="sp-need-ico">' + meta.glyph + '</i>' : '') +
        esc(m.label) + '</span>' +
        '<b>' + (m.off ? 'off' : val + (pub ? ' / ' + Math.round(pub) : '')) + '</b></div>' +
        (drawBar ? '<div class="sp-meter"><span style="width:' + pct.toFixed(1) + '%"></span></div>' : '') +
        ((meta && meta.word) || assumed
          ? '<div class="sp-need-foot"><span class="sp-need-word">' +
            esc((meta && meta.word) || '') + '</span>' +
            (assumed ? '<span class="sp-need-scale">≈ ' + Math.round(max) + '</span>' : '') +
            '</div>'
          : '') +
        '</div>';
    }).join('') +
      ((n.nearHeat || n.inFreezingWater || typeof n.ambient === 'number')
        ? '<div class="sp-flags">' +
          (n.nearHeat ? '<span class="sp-flag sp-good"><i>🔥</i>by a heat source</span>' : '') +
          (n.inFreezingWater ? '<span class="sp-flag sp-bad"><i>🧊</i>in freezing water</span>' : '') +
          (typeof n.ambient === 'number' ? '<span class="sp-flag"><i>🌡</i>ambient ' + Math.round(n.ambient) + '°</span>' : '') +
          '</div>'
        : '');
  }

  function heroCardHtml(b) {
    const nums = (b.nums || []).map(function (x) {
      return '<div class="sp-stat"><span class="sp-stat-v">' + fmt(x.value) + '</span>' +
        '<span class="sp-stat-l">' + esc(x.label) + '</span></div>';
    }).join('');
    const bars = (b.bars || []).map(function (bar) {
      const v = Math.round(Number(bar.value) || 0);
      const max = (typeof bar.max === 'number' && bar.max > 0) ? bar.max : 0;
      const pct = max ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
      return '<div class="sp-need"><div class="sp-need-top"><span>' + esc(bar.label) + '</span>' +
        '<b>' + v + (max ? '/' + Math.round(max) : '') + '</b></div>' +
        (max ? '<div class="sp-meter"><span style="width:' + pct.toFixed(1) + '%"></span></div>' : '') +
        '</div>';
    }).join('');
    return (nums ? '<div class="sp-stats">' + nums + '</div>' : '') + bars;
  }

  function statRows(g) {
    const q = ui.q.toLowerCase().trim();
    return (g.rows || []).filter(function (r) {
      return !q || String(r.label).toLowerCase().indexOf(q) !== -1;
    });
  }

  /* While searching, a card with nothing matching gets out of the way rather
     than sitting there saying "nothing here" five times over. */
  function cardMatches(def) {
    const q = ui.q.toLowerCase().trim();
    if (!q) return true;
    if (String(def.label).toLowerCase().indexOf(q) !== -1) return true;
    if (def.kind === 'stat') return statRows(def.group || {}).length > 0;
    if (def.kind === 'needs')
      return ((state.needs && state.needs.meters) || []).some(function (m) {
        return String(m.label).toLowerCase().indexOf(q) !== -1;
      });
    const b = def.block || {};
    return (b.nums || []).concat(b.bars || []).some(function (x) {
      return String(x.label).toLowerCase().indexOf(q) !== -1;
    });
  }

  function statCardHtml(g) {
    const rows = statRows(g);
    if (!rows.length) return '<div class="sp-none">nothing here matches</div>';
    return (g.hint ? '<div class="sp-hint">' + esc(g.hint) + '</div>' : '') +
      rows.map(function (r) {
        return '<div class="sp-row"><span class="sp-row-l">' + esc(r.label) +
          (r.note ? ' <i>' + esc(r.note) + '</i>' : '') + '</span>' +
          '<span class="sp-row-v">' + fmt(r.value, r.int) + '</span></div>';
      }).join('');
  }

  function cardBody(def) {
    if (def.kind === 'needs') return needsCardHtml(state.needs || {});
    if (def.kind === 'hero') return heroCardHtml(def.block || {});
    return statCardHtml(def.group || {});
  }

  function render() {
    const body = $('sp-body');
    if (!body) return;
    if (!state.loaded) {
      body.innerHTML = new Array(4).fill(
        '<div class="sp-card sp-size-m sp-skel"><div class="sp-skel-box sp-w1"></div>' +
        '<div class="sp-skel-box sp-w2"></div><div class="sp-skel-box sp-w2"></div></div>').join('');
      return;
    }
    const cards = layoutFor(cardDefs());
    if (!cards.length) {
      body.innerHTML = '<div class="sp-hero-empty">' +
        '<div class="sp-hero-glyph">⛺</div>' +
        '<div class="sp-empty-t">No survival mods detected</div>' +
        '<div class="sp-empty-s">SunHelm, Campfire, Hunterborn and Wintersun all feed this page. ' +
        'Install any of them and its numbers appear here on their own.</div></div>';
      return;
    }
    const shown = (ui.edit ? cards : cards.filter(function (c) { return c.on; }))
      .filter(function (c) { return ui.edit || cardMatches(c.def); });
    if (!shown.length) {
      body.innerHTML = ui.q
        ? '<div class="sp-hero-empty"><div class="sp-empty-t">Nothing matches “' + esc(ui.q) + '”</div>' +
          '<div class="sp-empty-s">Try fewer letters — this searches every number on the page.</div></div>'
        : '<div class="sp-hero-empty"><div class="sp-empty-t">Every card is turned off</div>' +
          '<div class="sp-empty-s">Hit <b>✥ Arrange</b> and switch some back on.</div></div>';
      return;
    }
    body.innerHTML = (ui.edit
      /* Arrange mode has to say what it is. Glyph buttons with tooltips are
         not discoverable on a couch — one line of plain English is. */
      ? '<div class="sp-arrange-hint">Drag <b>✥</b> or press <b>‹ ›</b> to reorder' +
        ' · <b>S M L</b> sets how wide a card is · <b>👁</b> hides one' +
        ' · <b>✓ Done</b> when you like it</div>'
      : '') + shown.map(function (c, i) {
      const idx = cards.indexOf(c);
      return '<section class="sp-card sp-size-' + c.size + (c.on ? '' : ' sp-cardoff') +
        (c.def.accent ? ' sp-a-' + c.def.accent : '') +
        (ui.edit ? ' sp-editing' : '') + '" data-card="' + esc(c.def.id) + '" data-idx="' + idx + '">' +
        '<header class="sp-card-h">' +
        (ui.edit ? '<span class="sp-grip" title="Drag to move this card">✥</span>' : '') +
        '<span class="sp-card-t">' + esc(c.def.label) + '</span>' +
        (ui.edit
          ? '<span class="sp-card-tools">' +
            /* arrows as well as the grip: dragging is lovely with a mouse, but
               one click per step always works — including on a couch trackpad */
            '<button class="sp-mv" data-mv="-1" title="Move earlier"' +
            (idx === 0 ? ' disabled' : '') + '>‹</button>' +
            '<button class="sp-mv" data-mv="1" title="Move later"' +
            (idx === cards.length - 1 ? ' disabled' : '') + '>›</button>' +
            SIZES.map(function (sz) {
              return '<button class="sp-sz' + (c.size === sz ? ' on' : '') + '" data-size="' + sz +
                '" title="' + (sz === 's' ? 'Narrow' : sz === 'm' ? 'Medium' : 'Wide') + '">' +
                sz.toUpperCase() + '</button>';
            }).join('') +
            '<button class="sp-onoff' + (c.on ? ' on' : '') + '" data-toggle="1" title="' +
            (c.on ? 'Hide this card' : 'Show this card') + '">' + (c.on ? '👁' : '🚫') + '</button>' +
            '</span>'
          : '') +
        (!ui.edit && !c.on ? '' : '') +
        '</header>' +
        '<div class="sp-card-b">' + cardBody(c.def) + '</div>' +
        '</section>';
    }).join('');
    wire(cards);
    /* a re-render mid-drag must not drop the "you are holding this" state */
    if (ui.drag && ui.drag.id) {
      const held = body.querySelector('.sp-card[data-card="' + cssEsc(ui.drag.id) + '"]');
      if (held) held.classList.add('sp-lifted');
    }
  }

  function wire(cards) {
    const body = $('sp-body');
    if (!body) return;
    body.querySelectorAll('.sp-card').forEach(function (el) {
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      el.querySelectorAll('.sp-sz').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          cards[idx].size = b.getAttribute('data-size');
          saveLayout(cards);
          render();
        });
      });
      const t = el.querySelector('.sp-onoff');
      if (t) t.addEventListener('click', function (e) {
        e.stopPropagation();
        cards[idx].on = !cards[idx].on;
        saveLayout(cards);
        render();
      });
      el.querySelectorAll('.sp-mv').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (b.disabled) return;
          const to = idx + parseInt(b.getAttribute('data-mv'), 10);
          if (to < 0 || to >= cards.length) return;
          const moved = cards.splice(idx, 1)[0];
          cards.splice(to, 0, moved);
          saveLayout(cards);
          render();
        });
      });
      const grip = el.querySelector('.sp-grip');
      if (grip) grip.addEventListener('mousedown', function (e) {
        e.preventDefault();
        ui.drag = { idx: idx, id: cards[idx].def.id, cards: cards, moved: false };
        el.classList.add('sp-lifted');       // the card you are holding says so
        document.body.classList.add('sp-dragging');
      });
      el.addEventListener('mouseenter', function () {
        if (!ui.drag || ui.drag.idx === idx) return;
        /* live reorder as you pass over a card — the Followers pane's idiom,
           mouse events because Ultralight has no HTML5 drag and drop */
        const moved = ui.drag.cards.splice(ui.drag.idx, 1)[0];
        ui.drag.cards.splice(idx, 0, moved);
        ui.drag.idx = idx;
        ui.drag.moved = true;
        applyLayout(ui.drag.cards);   // memory only — one write on drop
        render();
      });
    });
  }

  function endDrag() {
    if (!ui.drag) return;
    const moved = ui.drag.moved;
    ui.drag = null;
    if (moved) pushLayout();      // the whole gesture costs exactly one write
    document.body.classList.remove('sp-dragging');
    const body = $('sp-body');
    if (body) body.querySelectorAll('.sp-lifted').forEach(function (n) { n.classList.remove('sp-lifted'); });
  }

  /* ------------------------------------------------------------- chrome */

  function renderHead() {
    const el = $('sp-head');
    if (!el) return;
    const pane = $('sp-pane');
    if (pane) pane.classList.toggle('sp-arranging', !!ui.edit);
    const anyMod = !!(state.needs && state.needs.present) ||
                   !!(state.camp && state.camp.present) ||
                   !!((state.hero && (state.hero.blocks || []).length));
    const cards = state.loaded ? layoutFor(cardDefs()) : [];
    const hidden = cards.filter(function (c) { return !c.on; }).length;
    el.innerHTML =
      '<div class="sp-title">Survival</div>' +
      '<div class="sp-sub">' + (anyMod
        ? 'What your survival mods track — arranged however you like'
        : 'No survival mods detected') +
      /* a hidden card must be discoverable, or you forget it exists */
      (hidden && !ui.edit
        ? ' <button class="sp-chip" id="sp-hidden" title="Arrange the board — the hidden ones are dimmed, click 👁 to bring one back">' +
          hidden + ' hidden</button>'
        : '') +
      '</div>' +
      '<div class="sp-headbtns">' +
      (ui.edit ? '<button class="sp-btn' + (ui.resetArmed ? ' sp-armed' : '') + '" id="sp-reset" title="Every card back on, default order and size">' +
        (ui.resetArmed ? '↺ Sure?' : '↺ Reset') + '</button>' : '') +
      '<button class="sp-btn" id="sp-open-actions" title="The quick-action popout — pitch, drink, pray, harvest">⛺ Quick actions</button>' +
      '<button class="sp-btn' + (ui.edit ? ' on' : '') + '" id="sp-arrange" title="Turn cards on and off, resize them, drag them into order">' +
      (ui.edit ? '✓ Done' : '✥ Arrange') + '</button>' +
      '</div>';
    const hid = $('sp-hidden');
    /* the chip is the way BACK to the hidden cards, so it must be clickable —
       a count you cannot act on is just a nag */
    if (hid) hid.addEventListener('click', function () { setEdit(true); });
    const rst = $('sp-reset');
    if (rst) rst.addEventListener('click', function () {
      /* ARMED: one click asks, the second does it. An arrangement you spent a
         minute on must not die to a stray click, and there is no undo. */
      if (!ui.resetArmed) {
        ui.resetArmed = true;
        renderHead();
        clearTimeout(ui.resetTimer);
        ui.resetTimer = setTimeout(function () { ui.resetArmed = false; renderHead(); }, 3000);
        return;
      }
      clearTimeout(ui.resetTimer);
      ui.resetArmed = false;
      ui.layout = [];
      pushLayout();
      renderHead();
      render();
    });
    const a = $('sp-arrange');
    if (a) a.addEventListener('click', function () { setEdit(!ui.edit); });
    const q = $('sp-open-actions');
    if (q) q.addEventListener('click', function () {
      /* Opened from the tab, so it is NOT standalone: closing it returns you
         here rather than shutting the whole deck. */
      if (window.hdShowTab) { window.hdShowTab('survival-quick'); return; }
      if (window.HDSurvival) HDSurvival.open(false);
    });
  }

  /* ---------------------------------------------------------- receivers */

  /* svStateResult is SHARED with the popout: one read of the mods' state
     serves both surfaces, so they can never disagree about your needs. */
  (function chainState() {
    const prev = window.svStateResult;
    window.svStateResult = function (j) {
      if (typeof prev === 'function') { try { prev(j); } catch (e) {} }
      const d = coerce(j);
      if (!d || typeof d !== 'object') return;
      state.loaded = true;
      state.hero = d.hero || null;
      state.needs = d.needs || null;
      state.camp = d.camp || {};
      state.water = d.water || {};
      if (ui.visible) { renderHead(); render(); }
    };
  })();

  window.svLayoutData = function (j) {
    const d = coerce(j);
    if (d && Array.isArray(d.cards)) ui.layout = d.cards;
    if (ui.visible) render();
  };

  /* ---------------------------------------------------------- lifecycle */

  function onShow() {
    ui.visible = true;
    toGame('svState');
    toGame('svLayoutGet');
    renderHead();
    render();
    focusSearch();
  }

  function onHide() {
    ui.visible = false;
    endDrag();
  }

  function setFilter(text) {
    ui.q = String(text || '');
    const s = $('sp-search');
    if (s && s.value !== ui.q) s.value = ui.q;
    const clr = $('sp-clear');
    if (clr) clr.classList.toggle('hidden', !ui.q);
    if (ui.visible) render();
  }

  /* Entering arrange with a filter on would have you rearranging a board that
     is not the board you'll be looking at — so the query is dropped, and the
     search bar stands down until you're done. */
  function setEdit(on) {
    ui.edit = !!on;
    ui.resetArmed = false;
    if (ui.edit && ui.q) setFilter('');
    renderHead();
    render();
    if (!ui.edit) focusSearch();
  }

  function focusSearch() {
    const s = $('sp-search');
    /* the couch rule: you should be able to just start typing */
    if (s && ui.visible && !ui.edit) { try { s.focus(); } catch (e) {} }
  }

  function init() {
    document.addEventListener('mouseup', endDrag, true);
    const s = $('sp-search');
    if (s) {
      s.addEventListener('input', function () { setFilter(s.value); });
      s.addEventListener('keydown', function (e) {
        /* Esc peels back one layer at a time — query, then the deck's own
           close — the same ladder every search box here uses. */
        if (e.key === 'Escape' && s.value) { setFilter(''); e.stopPropagation(); }
      });
      /* a query you can only clear by selecting the text is a defect; the ✕ is
         injected here so the shipped skeleton and the harness cannot drift */
      const bar = s.parentNode;
      if (bar && !$('sp-clear')) {
        const b = document.createElement('button');
        b.id = 'sp-clear';
        b.className = 'sp-clear hidden';
        b.title = 'Clear the filter';
        b.textContent = '✕';
        b.addEventListener('click', function () { setFilter(''); focusSearch(); });
        bar.appendChild(b);
      }
    }
    /* Escape anywhere in the pane leaves arrange mode rather than closing the
       whole deck — you are in a sub-mode, and Escape means "out of this". */
    const pane = $('sp-pane');
    if (pane) pane.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.edit) { setEdit(false); e.stopPropagation(); }
    }, true);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else
    init();

  /* ------------------------------------------------------------- omni */

  /* What a player TYPES for a card is rarely what the mod calls it: the needs
     card is "hunger" and "how cold am I", a Wintersun block is "faith" or
     "prayer". The accent already knows which mod a card speaks for, so it
     doubles as the synonym key and a new mod's card still gets the generic
     survival words below. */
  const ACCENT_WORDS = {
    sun: 'sunhelm needs hunger thirst fatigue cold warmth temperature exposure freezing weather',
    camp: 'campfire camping perks firecraft trailblazer instincts',
    hunt: 'hunterborn hunting skinning butcher carcass forage',
    faith: 'wintersun faith religion god deity prayer favour favor blessing worship',
    life: 'days survived playthrough this life',
  };

  /* The words for a NEED, which are what you actually type when you want to
     know whether to eat: the state word ("starving") comes from the shared
     semantics, but "food" and "eat" have to be here. */
  const NEED_WORDS = {
    hunger: 'hunger hungry starving eat food meal',
    thirst: 'thirst thirsty parched drink water waterskin',
    fatigue: 'fatigue tired weary exhausted sleep rest bed',
    cold: 'cold chilly freezing warmth warm temperature exposure frost',
  };

  /* Landing on the tab with the CARD's own name in the filter rather than with
     whatever you typed: "how cold am I" is a fine question and a hopeless
     filter, and the board's search matches labels, so this always arrives
     looking at the thing you picked. setTab FIRST — onShow() renders, and a
     filter set before it would be drawn against the old board. */
  function openBoard(filter) {
    if (window.__omniSetTab) window.__omniSetTab('survival');
    setFilter(String(filter || ''));
  }

  /* A card you have switched off cannot be filtered to — read mode does not
     draw it at all. Arrange does, dimmed and with its 👁 ready, so that is
     where a search for a hidden card has to land. */
  function openArrange() {
    if (window.__omniSetTab) window.__omniSetTab('survival');
    setEdit(true);
  }

  function cardWords(def) {
    const labels = [];
    if (def.kind === 'needs')
      ((state.needs && state.needs.meters) || []).forEach(function (m) {
        labels.push(m.label);
        labels.push(NEED_WORDS[String(m.id || '')] || '');
      });
    else if (def.kind === 'stat')
      ((def.group && def.group.rows) || []).forEach(function (r) { labels.push(r.label); });
    else
      ((def.block && def.block.nums) || []).concat((def.block && def.block.bars) || [])
        .forEach(function (x) { labels.push(x.label); });
    return ('survival stats ' + (ACCENT_WORDS[def.accent] || '') + ' ' +
      labels.join(' ')).replace(/\s+/g, ' ');
  }

  /* A card's result says what it is holding, so it is useful BEFORE you jump —
     the needs card leads with its live readings, a stat group with the numbers
     it keeps. Four is as many as the row has room for. */
  function cardSummary(c) {
    const def = c.def;
    const bits = [];
    if (def.kind === 'needs')
      ((state.needs && state.needs.meters) || []).forEach(function (m) {
        if (m.off) return;
        const meta = needMeta(m);
        bits.push(m.label + ' ' + Math.round(Number(m.value) || 0) +
          (meta && meta.word ? ' (' + meta.word + ')' : ''));
      });
    else if (def.kind === 'stat')
      ((def.group && def.group.rows) || []).forEach(function (r) { bits.push(r.label); });
    else
      ((def.block && def.block.nums) || []).concat((def.block && def.block.bars) || [])
        .forEach(function (x) { bits.push(x.label); });
    return (c.on ? '' : 'hidden on the board · ') +
      (bits.length ? bits.slice(0, 4).join(' · ') : 'a card on the Survival board');
  }

  /* The board is live, mod-derived data and none of it was searchable: "how
     cold am I", "Wintersun", "temperature" all came back empty while this very
     tab was displaying the number. The index is therefore built from the SAME
     cardDefs() / needMeta() the board draws with — one row per card, one per
     need and one per stat, each carrying its current value — so search and
     board can never disagree.  marker: sp-omni */
  if (window.HDOmni) HDOmni.register({
    id: 'survival', label: 'Survival', tab: 'survival',
    setFilter: setFilter,
    /* The tab only reads the mods' globals when it is opened, so without this
       the whole board stayed invisible to search until you had visited it once
       this session. One request per omni open, answered into the shared
       svStateResult that already feeds both surfaces. */
    warm: function () { toGame('svState'); },
    index: function () {
      if (!state.loaded) return [];
      const cards = layoutFor(cardDefs());
      if (!cards.length) return [];
      const rows = [];
      cards.forEach(function (c) {
        rows.push({
          label: c.def.label,
          detail: cardSummary(c),
          kind: 'survival',
          keywords: cardWords(c.def),
          run: function () {
            if (c.on) openBoard(c.def.label); else openArrange();
          },
        });
      });
      const needsCard = cards.filter(function (c) { return c.def.kind === 'needs'; })[0];
      if (needsCard)
        ((state.needs && state.needs.meters) || []).forEach(function (m) {
          const meta = needMeta(m);
          rows.push({
            label: m.label,
            detail: (m.off
              ? 'not tracked by ' + ((state.needs && state.needs.mod) || 'the mod')
              : Math.round(Number(m.value) || 0) +
                (meta && meta.word ? ' · ' + meta.word : '')) +
              ' · ' + ((state.needs && state.needs.mod) || 'Needs'),
            kind: 'need',
            keywords: 'survival need vitals ' + (NEED_WORDS[String(m.id || '')] || ''),
            run: function () {
              if (needsCard.on) openBoard(needsCard.def.label); else openArrange();
            },
          });
        });
      /* One row per NUMBER as well as per card: "ambient" and "days survived"
         are what a player types, and they live inside a card named after the
         mod. The value rides in the detail, so the answer is often the result
         itself. */
      cards.forEach(function (c) {
        if (!c.on) return;         // a hidden card's rows cannot be filtered to
        const def = c.def;
        const nums = def.kind === 'stat'
          ? ((def.group && def.group.rows) || [])
          : def.kind === 'hero'
            ? ((def.block && def.block.nums) || []).concat((def.block && def.block.bars) || [])
            : [];
        nums.forEach(function (r) {
          rows.push({
            label: r.label,
            detail: fmt(r.value, r.int) +
              (typeof r.max === 'number' && r.max > 0 ? ' / ' + fmt(r.max) : '') +
              ' · ' + def.label + (r.note ? ' · ' + r.note : ''),
            kind: 'stat',
            keywords: cardWords(def),
            run: function () { openBoard(r.label); },
          });
        });
      });
      /* Arrange IS the tab's feature and nothing named it: it is reached only
         by the head button, so "hide a card" or "resize" found nothing. */
      rows.push({
        label: 'Arrange the Survival board',
        detail: 'Turn cards on and off, size them S / M / L, drag them into the order you want',
        kind: 'survival',
        keywords: 'arrange rearrange reorder move drag resize size hide show card ' +
          'layout customise customize dashboard board survival',
        run: openArrange,
      });
      return rows;
    },
  });

  return {
    init: init, onShow: onShow, onHide: onHide, setFilter: setFilter,
    toggleEdit: function () { setEdit(!ui.edit); },
    setEdit: setEdit,
    isEditing: function () { return ui.edit; },
    wantsPause: function () { return true; },
    _state: state, _ui: ui, _cards: function () { return layoutFor(cardDefs()); },
    _render: render,
  };
})();
