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
 *    anGet() · anPlay(event) · anReset() · anState() · anCrawl() ·
 *    anScan() · anPack({name,on}) · anLog(str)
 *  C++ pushes back (names disjoint from the above, per the deck law):
 *    anOpen(catalogue+target) · anResult({ok,msg,on?}) · anTargetResult(target)
 *
 *  Load-order packs (2026-08-13): anOpen also carries scanned:bool +
 *  packs:[{name,file,count,enabled}] — the in-game FNIS scan (anScan) that
 *  populates every non-baked pose pack in the LO, persisted C++-side in
 *  anim-scan.json. The packs card in the sidebar owns scan/rescan/toggles.
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
      if (DEV && fn === 'anScan') setTimeout(devScan, 60);
      if (DEV && fn === 'anPack') devPack(arg);
    }
  }
  function glog(msg) { toGame('anLog', msg); }

  // Dev fixture: the baked six, plus a mock scanned layer once devScan ran.
  const devState = { scanned: false };
  const DEVPACKS = [
    { name: 'GomaPoses', file: 'FNIS_GomaPoses_List.txt', count: 2, enabled: true },
    { name: 'Kinoko Pose', file: 'FNIS_KinokoPose_List.txt', count: 2, enabled: true },
    { name: 'Wulf Poser', file: 'FNIS_WulfPoser_List.txt', count: 2, enabled: true },
  ];

  function devDoc() {
    const doc = {
      source: 'ZaZ Animation Pack 8.0 (dev)',
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
      scanned: devState.scanned,
      packs: devState.scanned ? DEVPACKS.map((p) => Object.assign({}, p)) : [],
    };
    if (devState.scanned) {
      for (const p of DEVPACKS) {
        if (!p.enabled) continue;
        for (let i = 1; i <= p.count; i++) {
          doc.entries.push({
            event: p.name.replace(/\s+/g, '') + 'Pose0' + i, label: 'Pose 0' + i,
            category: p.name + ' · Pose', kind: 'idle',
            needsFurniture: false, needsObject: false, pack: p.name,
          });
        }
      }
    }
    doc.count = doc.entries.length;
    const tally = {};
    for (const e of doc.entries) tally[e.category] = (tally[e.category] || 0) + 1;
    doc.categories = Object.keys(tally).map((k) => ({ name: k, count: tally[k] }));
    return doc;
  }

  function devOpen() { window.anOpen(JSON.stringify(devDoc())); }

  function devScan() {
    devState.scanned = true;
    window.anResult(JSON.stringify({ ok: true, msg: DEVPACKS.length + ' pack(s) found (dev)' }));
    devOpen();
  }

  function devPack(arg) {
    let j = {};
    try { j = JSON.parse(arg); } catch (e) { j = {}; }
    for (const p of DEVPACKS) if (p.name === j.name) p.enabled = !!j.on;
    devOpen();
  }

  /* ============================================================= state == */

  const state = {
    source: '', count: 0,
    cats: [],                 // [{name,count}]
    entries: [],              // [{event,label,category,kind,needsFurniture,needsObject}]
    target: { name: 'you', player: true, crawl: false },
    crawlReady: false,
    scanned: false,           // has a load-order scan ever run (persisted C++-side)
    packs: [],                // [{name,file,count,enabled}] — scanned packs
  };

  const ui = { inited: false, shown: false, activeCat: 'All', query: '', gotOpen: false,
    scanning: false, packFilter: '' };

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

  /* ---- load-order packs card (in-game FNIS scan) ------------------------ */

  function startScan() {
    if (ui.scanning) return;
    ui.scanning = true;
    renderPacks();
    toGame('anScan');
    glog('load-order scan requested');
  }

  function packRows() {
    const q = ui.packFilter.trim().toLowerCase();
    return q ? state.packs.filter((p) => String(p.name || '').toLowerCase().indexOf(q) !== -1) : state.packs;
  }

  function renderPackRows() {
    if (!els.pkRows) return;
    els.pkRows.textContent = '';
    const rows = packRows();
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'an-pk-hint';
      d.textContent = ui.packFilter
        ? 'No pack matches “' + ui.packFilter + '”.'
        : 'No other FNIS pose packs in this load order — ZaZ + Halo are built in.';
      els.pkRows.append(d);
      return;
    }
    for (const p of rows) {
      const row = document.createElement('label');
      row.className = 'an-pk-row' + (p.enabled ? '' : ' off');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!p.enabled;
      cb.setAttribute('aria-label', 'Show ' + esc(p.name));
      cb.addEventListener('change', () => {
        p.enabled = cb.checked;               // optimistic; the anOpen refresh confirms
        row.classList.toggle('off', !p.enabled);
        toGame('anPack', JSON.stringify({ name: p.name, on: p.enabled }));
        glog('pack ' + p.name + ' -> ' + (p.enabled ? 'on' : 'off'));
      });
      const name = document.createElement('span');
      name.className = 'an-pk-name';
      name.textContent = esc(p.name);
      name.title = esc(p.file || p.name) + ' — ' + p.count + ' animations';
      const count = document.createElement('span');
      count.className = 'an-pk-count';
      count.textContent = String(p.count);
      row.append(cb, name, count);
      els.pkRows.append(row);
    }
  }

  function renderPacks() {
    if (!els.pkBody) return;
    els.pkBody.textContent = '';
    els.pkRows = null;
    if (els.rescan) els.rescan.classList.toggle('hidden', !state.scanned || ui.scanning);

    if (ui.scanning) {
      const d = document.createElement('div');
      d.className = 'an-pk-busy';
      d.textContent = 'Scanning your load order';
      els.pkBody.append(d);
      return;
    }
    if (!state.scanned) {
      const pitch = document.createElement('div');
      pitch.className = 'an-pk-pitch';
      pitch.textContent = 'Only ZaZ + Halo are built in. Scan your load order to add every ' +
        'other pose pack it ships (FNIS-format lists — Nemesis and Pandora register ' +
        'those too) — the result is saved for good.';
      const btn = document.createElement('button');
      btn.id = 'an-scan';
      btn.className = 'an-btn an-pk-scan';
      btn.textContent = '⌕ Scan load order';
      btn.title = 'Find every FNIS animation list your mods ship and add their poses to this tab';
      btn.addEventListener('click', startScan);
      els.pkBody.append(pitch, btn);
      return;
    }
    if (state.packs.length > 8) {
      const f = document.createElement('input');
      f.className = 'an-pk-filter';
      f.type = 'text';
      f.placeholder = 'Filter packs…';
      f.value = ui.packFilter;
      f.setAttribute('aria-label', 'Filter animation packs');
      f.autocomplete = 'off';
      f.spellcheck = false;
      f.addEventListener('input', () => { ui.packFilter = f.value || ''; renderPackRows(); });
      els.pkBody.append(f);
    }
    const rowsBox = document.createElement('div');
    rowsBox.id = 'an-pk-rows';
    els.pkBody.append(rowsBox);
    els.pkRows = rowsBox;
    renderPackRows();
    if (state.packs.length) {
      const hint = document.createElement('div');
      hint.className = 'an-pk-hint';
      hint.textContent = 'Unticked packs are hidden, not forgotten. A pose that plays nothing ' +
        'was never registered — re-run FNIS/Nemesis/Pandora for that pack.';
      els.pkBody.append(hint);
    }
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
      state.scanned = !!j.scanned;
      state.packs = Array.isArray(j.packs) ? j.packs : [];
      ui.scanning = false;
      if (els.source) els.source.textContent = state.source
        ? state.source + ' · ' + state.entries.length + ' animations'
        : state.entries.length + ' animations';
      renderTarget();
      renderCats();
      renderPacks();
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
    els.pkBody = $('an-pk-body');
    els.rescan = $('an-rescan');

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
    if (els.rescan) els.rescan.addEventListener('click', startScan);

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
