'use strict';

/* ====================================================================== *
 *  Animations — a ZaZ Animation Pack player tab inside the Hotkey Deck.
 *
 *  The ask (Rober, 2026-08-05, out of the Leash crawl thread): a searchable,
 *  categorized tab that APPLIES an animation to the crosshair NPC (or you),
 *  ZAP's own catalogue "with its categories etc". C++ owns the catalogue
 *  (baked by tools/build_zap_catalog.py, read from zap-catalog.json) and the
 *  apply (NotifyAnimationGraph on the target); this pane owns browsing.
 *
 *  Bridge — C++ registers these JS->C++ listeners on the deck view:
 *    anGet() · anPlay(event) · anReset() · anState() · anCrawl() · anLog(str)
 *  C++ pushes back (names disjoint from the above, per the deck law):
 *    anOpen(catalogue+target) · anResult({ok,msg,on?}) · anTargetResult(target)
 *
 *  Host contract (mirrors LootPane/RoomsPane): AnimPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.AnimPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const RENDER_CAP = 240;   // most rows we paint at once — refine to see the rest

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'anGet') setTimeout(devOpen, 30);
      if (DEV && fn === 'anPlay') window.anResult(JSON.stringify({ ok: true, msg: 'dev ▸ ' + arg }));
      if (DEV && fn === 'anReset') window.anResult(JSON.stringify({ ok: true, msg: 'dev reset' }));
      if (DEV && fn === 'anCrawl') {
        state.target.crawl = !state.target.crawl;
        window.anResult(JSON.stringify({ ok: true, msg: 'dev crawl', on: state.target.crawl }));
      }
    }
  }
  function glog(msg) { toGame('anLog', msg); }

  function devOpen() {
    window.anOpen(JSON.stringify({
      source: 'ZaZ Animation Pack 8.0 (dev)', count: 6,
      categories: [
        { name: 'Core Poses', count: 3 }, { name: 'Furniture', count: 1 },
        { name: 'Yoke', count: 1 }, { name: 'Dances', count: 1 },
      ],
      entries: [
        { event: 'ZazAPC101', label: 'APC 101', category: 'Core Poses', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZazAPC102', label: 'APC 102', category: 'Core Poses', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZapKneelDisplay', label: 'Kneel Display', category: 'Core Poses', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZapYokePose01', label: 'Yoke Pose 01', category: 'Yoke', kind: 'idle', needsFurniture: false, needsObject: true },
        { event: 'ZazDisco_VB_Enter', label: 'Disco', category: 'Furniture', kind: 'furniture', needsFurniture: true, needsObject: false },
        { event: 'ZazKickDance_Enter', label: 'Kick Dance', category: 'Dances', kind: 'furniture', needsFurniture: true, needsObject: false },
      ],
      target: { name: 'Lydia', player: false, crawl: false },
      crawlReady: true,
    }));
  }

  /* ============================================================= state == */

  const state = {
    source: '', count: 0,
    cats: [],                 // [{name,count}]
    entries: [],              // [{event,label,category,kind,needsFurniture,needsObject}]
    target: { name: 'you', player: true, crawl: false },
    crawlReady: false,
  };

  const ui = { inited: false, shown: false, activeCat: 'All', query: '', gotOpen: false };

  const els = {};
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* ============================================================ render == */

  function filtered() {
    const q = ui.query.trim().toLowerCase();
    const cat = ui.activeCat;
    const out = [];
    for (const e of state.entries) {
      if (cat !== 'All' && e.category !== cat) continue;
      if (q) {
        const hay = (e.label + ' ' + e.event + ' ' + e.category).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      out.push(e);
    }
    return out;
  }

  function renderTarget() {
    if (!els.target) return;
    const t = state.target;
    els.target.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'an-tgt-dot' + (t.player ? ' me' : '');
    els.target.append(dot);
    const label = document.createElement('span');
    label.className = 'an-tgt-name';
    label.textContent = t.player ? 'You' : esc(t.name);
    els.target.append(document.createTextNode('Applying to '));
    els.target.append(label);
    // crawl toggle
    els.crawl.classList.toggle('on', !!t.crawl);
    els.crawl.classList.toggle('disabled', !state.crawlReady);
    els.crawl.textContent = t.crawl ? '🐾 Crawling — stop' : '🐾 Crawl';
    els.crawl.title = !state.crawlReady
      ? 'Crawl faction not found — rebuild HotkeyDeckWardrobe.esp'
      : (t.player ? 'Crawl yourself (sneak-based)' : 'Make ' + esc(t.name) + ' crawl');
  }

  function renderCats() {
    if (!els.cats) return;
    els.cats.textContent = '';
    const mk = (name, count, isAll) => {
      const b = document.createElement('button');
      b.className = 'an-cat' + (ui.activeCat === name ? ' active' : '');
      b.dataset.cat = name;
      const n = document.createElement('span'); n.className = 'an-cat-name'; n.textContent = name;
      const c = document.createElement('span'); c.className = 'an-cat-count'; c.textContent = String(count);
      b.append(n, c);
      b.title = isAll ? 'Every animation' : count + ' in ' + name;
      b.addEventListener('click', () => { ui.activeCat = name; renderCats(); renderList(); });
      return b;
    };
    els.cats.append(mk('All', state.entries.length, true));
    for (const c of state.cats) els.cats.append(mk(c.name, c.count, false));
  }

  function renderList() {
    if (!els.list) return;
    const rows = filtered();
    els.count.textContent = rows.length + (rows.length === 1 ? ' animation' : ' animations');
    els.list.textContent = '';

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'an-empty';
      empty.textContent = ui.query
        ? 'Nothing matches “' + ui.query + '”.'
        : 'No animations in this category.';
      els.list.append(empty);
      return;
    }

    const shown = Math.min(rows.length, RENDER_CAP);
    for (let i = 0; i < shown; i++) {
      const e = rows[i];
      const row = document.createElement('div');
      row.className = 'an-row' + (e.needsFurniture ? ' disabled' : '') + (i === 0 ? ' top' : '');

      const main = document.createElement('div');
      main.className = 'an-row-main';
      const name = document.createElement('div');
      name.className = 'an-row-name';
      name.textContent = e.label || e.event;
      name.title = e.event;
      const meta = document.createElement('div');
      meta.className = 'an-row-meta';
      meta.textContent = e.category + (e.needsObject ? ' · needs prop' : '') +
        (e.needsFurniture ? ' · needs furniture' : '');
      main.append(name, meta);
      row.append(main);

      const btn = document.createElement('button');
      btn.className = 'an-apply';
      if (e.needsFurniture) {
        btn.disabled = true;
        btn.textContent = 'Furniture';
        btn.title = 'This one plays on a furniture object, not on demand (v1)';
      } else {
        btn.textContent = 'Apply';
        btn.title = 'Play “' + (e.label || e.event) + '” on the target';
        btn.addEventListener('click', () => apply(e));
      }
      row.append(btn);

      if (!e.needsFurniture) row.addEventListener('click', (ev) => {
        if (ev.target === btn) return;
        apply(e);
      });
      els.list.append(row);
    }

    if (rows.length > shown) {
      const more = document.createElement('div');
      more.className = 'an-more';
      more.textContent = (rows.length - shown) + ' more — keep typing to narrow it down.';
      els.list.append(more);
    }
  }

  function toast(msg, ok) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = 'an-toast show' + (ok === false ? ' bad' : '');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(() => { els.toast.className = 'an-toast'; }, 2200);
  }

  function apply(e) {
    if (!e || e.needsFurniture) return;
    toGame('anPlay', e.event);
    toast('▸ ' + (e.label || e.event), true);   // optimistic; anResult confirms
    glog('apply ' + e.event);
  }

  /* =========================================================== receive == */

  function receive(key, info) {
    let j = null;
    if (typeof info === 'string') { try { j = JSON.parse(info); } catch (e) { j = null; } }
    else if (info && typeof info === 'object') { j = info; }

    if (key === 'open') {
      if (!j || typeof j !== 'object') return true;
      ui.gotOpen = true;
      state.source = esc(j.source);
      state.count = Number(j.count) || 0;
      state.cats = Array.isArray(j.categories) ? j.categories : [];
      state.entries = Array.isArray(j.entries) ? j.entries : [];
      state.target = (j.target && typeof j.target === 'object') ? j.target : state.target;
      state.crawlReady = !!j.crawlReady;
      if (els.source) els.source.textContent = state.source
        ? state.source + ' · ' + state.entries.length + ' animations'
        : state.entries.length + ' animations';
      renderTarget();
      renderCats();
      renderList();
      return true;
    }
    if (key === 'result') {
      if (j && typeof j === 'object') {
        if (typeof j.on === 'boolean') { state.target.crawl = j.on; renderTarget(); }
        if (j.msg) toast(esc(j.msg), j.ok !== false);
      }
      return true;
    }
    if (key === 'target') {
      if (j && typeof j === 'object') { state.target = j; renderTarget(); }
      return true;
    }
    return false;
  }

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    window[name].__anReceiver = true;
  }

  /* ============================================================= init  == */

  function init() {
    if (ui.inited) return true;
    if (!$('an-pane')) { console.log('[anim] #an-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.pane = $('an-pane');
    els.source = $('an-source');
    els.target = $('an-target');
    els.crawl = $('an-crawl');
    els.cats = $('an-cats');
    els.search = $('an-search');
    els.count = $('an-count');
    els.list = $('an-list');
    els.reset = $('an-reset');
    els.toast = $('an-toast');

    els.search.addEventListener('input', () => { ui.query = els.search.value || ''; renderList(); });
    els.search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const rows = filtered();
        if (rows.length) apply(rows[0]);   // Enter = top hit (deck idiom)
      }
    });
    els.reset.addEventListener('click', () => { toGame('anReset'); toast('reset', true); });
    els.crawl.addEventListener('click', () => {
      if (!state.crawlReady) { toast('crawl not available — rebuild the wardrobe ESP', false); return; }
      toGame('anCrawl');
    });

    chain('anOpen', 'open');
    chain('anResult', 'result');
    chain('anTargetResult', 'target');

    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  function onShow() {
    if (!init()) return;
    ui.shown = true;
    if (els.search) els.search.value = ui.query;
    toGame('anGet');
    // The OStim segment of this tab rides the Animations tab's lifecycle.
    if (window.OStimPane) OStimPane.onAnimShow();
  }

  function onHide() { ui.shown = false; if (window.OStimPane) OStimPane.onAnimHide(); }
  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);

    els.pane.classList.remove('hidden');
    devOpen();

    ok('pane exists', !!$('an-pane'));
    ok('got dev config', ui.gotOpen);
    ok('category rail built (All + 4)', els.cats.children.length === 5);
    ok('All is active by default', els.cats.children[0].classList.contains('active'));
    ok('rows rendered', els.list.querySelectorAll('.an-row').length === 6);
    ok('furniture row disabled', !!els.list.querySelector('.an-row.disabled'));
    ok('furniture apply disabled', els.list.querySelector('.an-row.disabled .an-apply').disabled === true);
    ok('needs-prop noted', /needs prop/.test(els.list.textContent));
    ok('target reads Lydia', /Lydia/.test(els.target.textContent));
    ok('crawl button ready', !els.crawl.classList.contains('disabled'));

    // category filter
    els.cats.children[1].click();  // Core Poses
    ok('category filter narrows', els.list.querySelectorAll('.an-row').length === 3);
    ok('active category moved', els.cats.children[1].classList.contains('active'));

    // search within All
    els.cats.children[0].click();
    els.search.value = 'yoke'; els.search.dispatchEvent(new Event('input'));
    ok('search narrows', els.list.querySelectorAll('.an-row').length === 1);
    ok('top row marked', !!els.list.querySelector('.an-row.top'));

    // apply top hit path
    els.search.value = 'kneel'; els.search.dispatchEvent(new Event('input'));
    apply(filtered()[0]);
    ok('apply toasts', els.toast.classList.contains('show'));

    // crawl toggle round-trip through dev bridge
    els.crawl.click();
    ok('crawl toggled on', state.target.crawl === true);

    ok('receivers tagged', window.anOpen.__anReceiver === true && window.anResult.__anReceiver === true);
    ok('no receiver on a REQUEST name', typeof window.anGet !== 'function' || window.anGet.__anReceiver !== true);

    const fails = out.filter((l) => l.indexOf('FAIL') === 0);
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'anim', label: 'Animations', tab: 'anim',
    setFilter: function (q) { ui.query = q || ''; if (els.search) els.search.value = ui.query; renderList(); },
    index: function () {
      // Only the directly-applyable ones are searchable from Omni (furniture
      // needs a furniture object, not a crosshair target).
      const items = [];
      for (const e of state.entries) {
        if (e.needsFurniture) continue;
        items.push({
          label: e.label || e.event,
          detail: 'Animation · ' + e.category,
          kind: 'anim',
          keywords: 'animation pose zap ' + e.event + ' ' + e.category,
          run: function () { apply(e); },
          pin: 'anim:' + e.event,
          snap: { event: e.event, label: e.label, category: e.category },
        });
      }
      return items;
    },
    pinRun: function (snap) {
      if (snap && snap.event) apply({ event: snap.event, label: snap.label, needsFurniture: false });
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause,
    _state: state, _ui: ui   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.AnimPane.init());
} else {
  window.AnimPane.init();
}
