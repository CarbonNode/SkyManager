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
 *    anScan() · anPack({name,on}) · anUser(userBlob) · anLog(str)
 *  C++ pushes back (names disjoint from the above, per the deck law):
 *    anOpen(catalogue+target) · anResult({ok,msg,on?}) · anTargetResult(target)
 *
 *  Load-order packs (2026-08-13): anOpen also carries scanned:bool +
 *  packs:[{name,file,count,enabled,paired,behav}] — the in-game FNIS scan
 *  (anScan) that populates every non-baked pose pack in the LO, persisted
 *  C++-side in anim-scan.json. The packs card in the sidebar owns
 *  scan/rescan/toggles. Scan v2: packs whose lines are ALL paired (`pa`) or
 *  behaviour plumbing land in the card greyed with the reason instead of
 *  vanishing — an invisible pack read as "the scan missed it".
 *
 *  Tabs · favorites · pack search (2026-08-14, Rober's play-test asks):
 *  - The Poses|OStim segmented row is now DYNAMIC: ★ Favorites plus custom
 *    user tabs (＋ to add, right-click to rename/delete, drag to reorder).
 *    A custom tab is a named collection of animations; add from any row's
 *    right-click menu. All of it persists via the anUser blob →
 *    Data/SKSE/Plugins/HotkeyDeck/anim-user.json (C++ round-trips it raw —
 *    the schema lives HERE, shelf-slice precedent).
 *  - Every applyable row grows a ☆ (hover) — favorites are one click.
 *  - Search covers PACK names: matching packs ride above the rows as 📦
 *    chips; clicking one scopes the list to that pack (✕ chip clears).
 *  - The category rail groups by PACK (collapsible), so 28 scanned packs
 *    don't flood it.
 *
 *  Host contract (mirrors LootPane/RoomsPane): AnimPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.AnimPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const RENDER_CAP = 240;   // most rows we paint at once — refine to see the rest
  const SEP = ' · ';   // middot — the pack·category namespace separator
  const MAX_TABS = 12;
  const MAX_TAB_NAME = 24;
  const MAX_PACK_CHIPS = 8;

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
      if (DEV && fn === 'anUser') {
        try { devState.user = JSON.parse(String(arg)); } catch (e) { devState.user = null; }
        window.anResult(JSON.stringify({ ok: true, msg: '' }));
      }
    }
  }
  function glog(msg) { toGame('anLog', msg); }

  // Dev fixture: the baked six, plus a mock scanned layer once devScan ran.
  const devState = { scanned: false, user: null };
  const DEVPACKS = [
    { name: 'GomaPoses', file: 'FNIS_GomaPoses_List.txt', count: 2, enabled: true, paired: 0, behav: 0 },
    { name: 'Kinoko Pose', file: 'FNIS_KinokoPose_List.txt', count: 2, enabled: true, paired: 0, behav: 0 },
    { name: 'Wulf Poser', file: 'FNIS_WulfPoser_List.txt', count: 2, enabled: true, paired: 0, behav: 0 },
    { name: 'PairedOnly', file: 'FNIS_PairedOnly_List.txt', count: 0, enabled: true, paired: 12, behav: 3 },
  ];

  function devDoc() {
    const doc = {
      source: 'ZaZ Animation Pack 8.0 (dev)',
      entries: [
        { event: 'ZazAPC101', label: 'APC 101', category: 'ZaZ' + SEP + 'Core Poses', source: 'ZaZ', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZazAPC102', label: 'APC 102', category: 'ZaZ' + SEP + 'Core Poses', source: 'ZaZ', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZapKneelDisplay', label: 'Kneel Display', category: 'ZaZ' + SEP + 'Core Poses', source: 'ZaZ', kind: 'idle', needsFurniture: false, needsObject: false },
        { event: 'ZapYokePose01', label: 'Yoke Pose 01', category: 'ZaZ' + SEP + 'Yoke', source: 'ZaZ', kind: 'idle', needsFurniture: false, needsObject: true },
        { event: 'ZazDisco_VB_Enter', label: 'Disco', category: 'ZaZ' + SEP + 'Furniture', source: 'ZaZ', kind: 'furniture', needsFurniture: true, needsObject: false },
        { event: 'ZazKickDance_Enter', label: 'Kick Dance', category: 'ZaZ' + SEP + 'Dances', source: 'ZaZ', kind: 'furniture', needsFurniture: true, needsObject: false },
      ],
      target: { name: 'Lydia', player: false, crawl: false },
      crawlReady: true,
      scanned: devState.scanned,
      packs: devState.scanned ? DEVPACKS.map((p) => Object.assign({}, p)) : [],
      user: devState.user || {},
    };
    if (devState.scanned) {
      for (const p of DEVPACKS) {
        if (!p.enabled || !p.count) continue;
        for (let i = 1; i <= p.count; i++) {
          doc.entries.push({
            event: p.name.replace(/\s+/g, '') + 'Pose0' + i, label: 'Pose 0' + i,
            category: p.name + SEP + 'Pose', kind: 'idle',
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
    window.anResult(JSON.stringify({ ok: true, msg: '3 pack(s) · 6 new poses (dev)' }));
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
    entries: [],              // [{event,label,category,kind,needsFurniture,needsObject,pack?,source?}]
    target: { name: 'you', player: true, crawl: false },
    crawlReady: false,
    scanned: false,           // has a load-order scan ever run (persisted C++-side)
    packs: [],                // [{name,file,count,enabled,paired?,behav?}] — scanned packs
    user: { favs: {}, tabs: [] },  // persisted via anUser (anim-user.json)
  };

  const ui = { inited: false, shown: false, activeCat: 'All', query: '', gotOpen: false,
    scanning: false, packFilter: '', view: 'poses', activePack: '',
    openPacks: {}, userT: 0, armDelete: '', drag: null };

  const els = {};
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* ======================================================== user store == */

  function normUser(u) {
    const out = { favs: {}, tabs: [] };
    if (u && typeof u === 'object') {
      if (u.favs && typeof u.favs === 'object' && !Array.isArray(u.favs)) {
        for (const k of Object.keys(u.favs)) {
          const s = u.favs[k];
          if (s && typeof s === 'object' && s.event) out.favs[k] = s;
        }
      }
      if (Array.isArray(u.tabs)) {
        for (const t of u.tabs) {
          if (!t || typeof t !== 'object' || !t.id || !t.name) continue;
          out.tabs.push({
            id: String(t.id), name: String(t.name).slice(0, MAX_TAB_NAME),
            items: Array.isArray(t.items) ? t.items.filter((s) => s && s.event) : [],
          });
          if (out.tabs.length >= MAX_TABS) break;
        }
      }
      // Unknown keys a NEWER view wrote survive the round-trip untouched.
      for (const k of Object.keys(u)) if (k !== 'favs' && k !== 'tabs') out[k] = u[k];
    }
    return out;
  }

  function saveUser() {
    clearTimeout(ui.userT);
    ui.userT = setTimeout(() => {
      toGame('anUser', JSON.stringify(state.user));
    }, 350);
  }

  function snapOf(e) {
    return { event: e.event, label: e.label || e.event, category: e.category || '',
      kind: e.kind || 'idle', pack: packKeyOf(e), needsObject: !!e.needsObject };
  }

  function isFav(e) { return !!state.user.favs[e.event]; }

  function toggleFav(e) {
    if (!e || e.needsFurniture) return;
    if (state.user.favs[e.event]) delete state.user.favs[e.event];
    else state.user.favs[e.event] = snapOf(e);
    saveUser();
    renderSeg();
    renderList();
  }

  function tabById(id) { return state.user.tabs.find((t) => t.id === id) || null; }

  function inTab(t, event) { return t.items.some((s) => s.event === event); }

  function createTab(name) {
    name = String(name || '').trim().slice(0, MAX_TAB_NAME);
    if (!name) return null;
    if (state.user.tabs.length >= MAX_TABS) { toast('tab limit reached (' + MAX_TABS + ')', false); return null; }
    const id = 't' + Math.random().toString(36).slice(2, 8);
    const t = { id, name, items: [] };
    state.user.tabs.push(t);
    saveUser(); renderSeg();
    return t;
  }

  function deleteTab(id) {
    const i = state.user.tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    state.user.tabs.splice(i, 1);
    if (ui.view === id) setView('poses');
    saveUser(); renderSeg();
  }

  function addToTab(id, e) {
    const t = tabById(id);
    if (!t || !e || e.needsFurniture) return;
    if (!inTab(t, e.event)) { t.items.push(snapOf(e)); saveUser(); renderSeg(); }
    toast('added to “' + t.name + '”', true);
    if (ui.view === id) renderList();
  }

  function removeFromTab(id, event) {
    const t = tabById(id);
    if (!t) return;
    const i = t.items.findIndex((s) => s.event === event);
    if (i !== -1) { t.items.splice(i, 1); saveUser(); renderSeg(); }
    if (ui.view === id) { renderCats(); renderList(); }
  }

  /* ============================================================ render == */

  function packKeyOf(e) {
    if (e.pack) return e.pack;
    if (e.source) return e.source;
    const c = String(e.category || '');
    const i = c.indexOf(SEP);
    return i > 0 ? c.slice(0, i) : 'Misc';
  }

  // The entry set the current top tab shows. Favorites / custom tabs resolve
  // their snapshots against the LIVE catalogue first (so labels/categories
  // stay current); a snapshot whose event vanished (pack unticked, mod gone)
  // stays visible but greyed — never a silently shrinking collection.
  let eventIndex = null;  // event -> live entry, rebuilt on every anOpen
  function liveByEvent(event) {
    if (!eventIndex) {
      eventIndex = {};
      for (const e of state.entries) eventIndex[e.event] = e;
    }
    return eventIndex[event] || null;
  }

  function resolveSnaps(snaps) {
    const out = [];
    for (const s of snaps) {
      const live = liveByEvent(s.event);
      if (live) out.push(live);
      else out.push(Object.assign({}, s, { _missing: true, needsFurniture: false }));
    }
    return out;
  }

  function collectionEntries() {
    if (ui.view === 'fav') return resolveSnaps(Object.keys(state.user.favs).map((k) => state.user.favs[k]));
    const t = tabById(ui.view);
    if (t) return resolveSnaps(t.items);
    return state.entries;
  }

  function filtered() {
    const q = ui.query.trim().toLowerCase();
    const cat = ui.activeCat;
    const out = [];
    for (const e of collectionEntries()) {
      if (cat !== 'All' && e.category !== cat) continue;
      if (ui.activePack && packKeyOf(e) !== ui.activePack) continue;
      if (q) {
        const hay = (e.label + ' ' + e.event + ' ' + e.category + ' ' + packKeyOf(e)).toLowerCase();
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

  /* ---- the top tab row: Poses | ★ Favorites | custom… | ＋ | OStim ------ */

  function ostimMode() {
    const pane = $('an-pane');
    return !!(pane && pane.classList.contains('mode-ostim'));
  }

  function segAlwaysOn() { return true; }   // ostim-pane's gate asks: v2 keeps the row (tabs live here)

  function setView(v) {
    if (v !== 'poses' && v !== 'fav' && !tabById(v)) v = 'poses';
    ui.view = v;
    ui.activeCat = 'All';
    ui.activePack = '';
    if (window.OStimPane && ostimMode()) OStimPane.setMode('poses');
    syncSegActive();
    renderCats();
    renderScope();
    renderList();
  }

  function syncSegActive() {
    const inOstim = ostimMode();
    const segPoses = $('an-seg-poses');
    if (segPoses) segPoses.classList.toggle('active', !inOstim && ui.view === 'poses');
    if (els.seg) {
      for (const b of els.seg.querySelectorAll('.an-seg-user, .an-seg-fav'))
        b.classList.toggle('active', !inOstim && ui.view === b.dataset.view);
    }
  }

  function renderSeg() {
    const seg = $('an-seg');
    if (!seg) return;
    els.seg = seg;
    // sweep our dynamic buttons, keep the two static ones (ostim-pane owns them)
    for (const b of seg.querySelectorAll('.an-seg-fav, .an-seg-user, .an-seg-add')) b.remove();

    const segOstim = $('an-seg-ostim');
    const put = (btn) => segOstim ? seg.insertBefore(btn, segOstim) : seg.append(btn);

    // ★ Favorites — always present; the count says whether it's worth a look
    const nFav = Object.keys(state.user.favs).length;
    const fav = document.createElement('button');
    fav.className = 'an-seg-btn an-seg-fav';
    fav.dataset.view = 'fav';
    fav.setAttribute('role', 'tab');
    fav.textContent = '★ Favorites' + (nFav ? ' (' + nFav + ')' : '');
    fav.title = nFav ? nFav + ' favorite animation(s)' : 'Star any animation to collect it here';
    fav.addEventListener('click', () => setView('fav'));
    put(fav);

    // custom tabs
    for (const t of state.user.tabs) {
      const b = document.createElement('button');
      b.className = 'an-seg-btn an-seg-user';
      b.dataset.view = t.id;
      b.setAttribute('role', 'tab');
      b.textContent = t.name + (t.items.length ? ' (' + t.items.length + ')' : '');
      b.title = t.items.length + ' animation(s) — right-click to rename, delete or reorder; drag to move';
      b.addEventListener('click', () => { if (!ui.drag || !ui.drag.moved) setView(t.id); });
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); tabCtx(ev, t); });
      b.addEventListener('pointerdown', (ev) => tabDragStart(ev, t, b));
      put(b);
    }

    // ＋ add — the trailing add-a-tab affordance. Rober (2026-08-14): move OStim
    // in front of the ＋ so the ＋ stays last. OStim is a static button owned by
    // ostim-pane; we just reposition it here (put() normally inserts before it).
    const add = document.createElement('button');
    add.className = 'an-seg-btn an-seg-add';
    add.setAttribute('role', 'tab');
    add.textContent = '＋';
    add.title = 'New tab — a collection you fill from any animation’s right-click menu';
    add.addEventListener('click', (ev) => openNamer(ev.currentTarget, null));
    if (segOstim) seg.append(segOstim);   // OStim now sits after the custom tabs…
    seg.append(add);                      // …and the ＋ trails it as the last control.

    syncSegActive();
  }

  /* ---- tab drag-reorder (pointer-based, the deck's tab idiom) ----------- */

  function tabDragStart(ev, t, btn) {
    if (ev.button !== 0) return;
    ui.drag = { id: t.id, btn, x0: ev.clientX, moved: false };
    const move = (e2) => {
      const d = ui.drag;
      if (!d) return;
      if (!d.moved && Math.abs(e2.clientX - d.x0) < 6) return;
      d.moved = true;
      d.btn.classList.add('dragging');
      // swap with the neighbour whose midpoint we crossed
      const sibs = Array.from(els.seg.querySelectorAll('.an-seg-user'));
      const idx = sibs.indexOf(d.btn);
      for (let i = 0; i < sibs.length; i++) {
        if (i === idx) continue;
        const r = sibs[i].getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if ((i < idx && e2.clientX < mid) || (i > idx && e2.clientX > mid)) {
          const order = state.user.tabs;
          const from = order.findIndex((x) => x.id === d.id);
          const to = from + (i < idx ? -1 : 1);
          if (to >= 0 && to < order.length) {
            const [m] = order.splice(from, 1);
            order.splice(to, 0, m);
            renderSeg();
            // re-grab our button (renderSeg rebuilt it)
            d.btn = els.seg.querySelector('.an-seg-user[data-view="' + d.id + '"]') || d.btn;
            d.btn.classList.add('dragging');
          }
          break;
        }
      }
    };
    const up = () => {
      const d = ui.drag;
      if (d) {
        d.btn.classList.remove('dragging');
        if (d.moved) saveUser();
        // let the click handler know this gesture was a drag, then clear
        setTimeout(() => { ui.drag = null; }, 0);
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---- context menus + the tab namer (pane-anchored, scale-safe) -------- */

  // keepArm: a menu replacing another menu (the armed-delete reopen) must NOT
  // reset the arm, or the confirm click re-arms forever instead of deleting.
  function closeCtx(keepArm) {
    if (els.ctx) { els.ctx.remove(); els.ctx = null; }
    if (els.namer) { els.namer.remove(); els.namer = null; }
    if (!keepArm) ui.armDelete = '';
  }

  function paneXY(ev) {
    const r = els.pane.getBoundingClientRect();
    // #panel is transform-scaled; rects are screen px but our absolute children
    // lay out in PANE px — divide by the effective scale so the menu lands
    // under the pointer at every deck scale (the popup-audit rule).
    const sx = r.width ? (els.pane.offsetWidth / r.width) : 1;
    const sy = r.height ? (els.pane.offsetHeight / r.height) : 1;
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
  }

  function showCtx(ev, items) {
    closeCtx(true);
    const m = document.createElement('div');
    m.className = 'an-ctx';
    for (const it of items) {
      if (it === '-') {
        const hr = document.createElement('div');
        hr.className = 'an-ctx-sep';
        m.append(hr);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'an-ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      if (it.hint) b.title = it.hint;
      b.addEventListener('click', (e2) => { e2.stopPropagation(); it.run(); });
      m.append(b);
    }
    els.pane.append(m);
    const p = paneXY(ev);
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(p.x, els.pane.offsetWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(p.y, els.pane.offsetHeight - mh - 6)) + 'px';
    els.ctx = m;
  }

  function tabCtx(ev, t) {
    const order = state.user.tabs;
    const i = order.findIndex((x) => x.id === t.id);
    showCtx(ev, [
      { label: '✎ Rename…', run: () => { const b = els.seg.querySelector('.an-seg-user[data-view="' + t.id + '"]'); closeCtx(); openNamer(b, t); } },
      { label: '⇤ Move left', run: () => { if (i > 0) { const [m] = order.splice(i, 1); order.splice(i - 1, 0, m); saveUser(); renderSeg(); } closeCtx(); } },
      { label: '⇥ Move right', run: () => { if (i < order.length - 1) { const [m] = order.splice(i, 1); order.splice(i + 1, 0, m); saveUser(); renderSeg(); } closeCtx(); } },
      '-',
      {
        label: ui.armDelete === t.id ? '🗑 Delete “' + t.name + '” — sure?' : '🗑 Delete tab',
        danger: true,
        hint: 'The animations stay in the catalogue — only the tab goes',
        run: () => {
          if (ui.armDelete === t.id) { deleteTab(t.id); closeCtx(); toast('tab “' + t.name + '” deleted', true); }
          else { ui.armDelete = t.id; tabCtx(ev, t); }   // re-open armed
        },
      },
    ]);
  }

  function rowCtx(ev, e) {
    const items = [];
    if (!e.needsFurniture) {
      items.push({ label: isFav(e) ? '★ Un-favorite' : '☆ Favorite', run: () => { toggleFav(e); closeCtx(); } });
      const t = tabById(ui.view);
      if (t) {
        items.push('-');
        items.push({ label: '✕ Remove from “' + t.name + '”', run: () => { removeFromTab(t.id, e.event); closeCtx(); } });
      } else {
        if (state.user.tabs.length) items.push('-');
        for (const tb of state.user.tabs) {
          if (inTab(tb, e.event))
            items.push({ label: '✓ In “' + tb.name + '” — remove', run: () => { removeFromTab(tb.id, e.event); closeCtx(); } });
          else
            items.push({ label: '＋ Add to “' + tb.name + '”', run: () => { addToTab(tb.id, e); closeCtx(); } });
        }
        items.push('-');
        items.push({ label: '＋ New tab with this…', run: () => { closeCtx(); openNamer($('an-seg') && $('an-seg').querySelector('.an-seg-add'), null, e); } });
      }
    }
    if (items.length) showCtx(ev, items);
  }

  // The ＋ popover: name a new tab (or rename `t`). `withEntry` lands in the
  // fresh tab as its first animation (the row-menu "New tab with this…" path).
  function openNamer(anchor, t, withEntry) {
    closeCtx();
    const box = document.createElement('div');
    box.className = 'an-namer';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = MAX_TAB_NAME;
    inp.placeholder = t ? 'Rename tab…' : 'New tab name…';
    inp.value = t ? t.name : '';
    inp.setAttribute('aria-label', inp.placeholder);
    inp.autocomplete = 'off'; inp.spellcheck = false;
    const okB = document.createElement('button');
    okB.textContent = t ? 'Rename' : 'Create';
    const commit = () => {
      const name = inp.value.trim().slice(0, MAX_TAB_NAME);
      if (!name) { closeCtx(); return; }
      if (t) { t.name = name; saveUser(); renderSeg(); }
      else {
        const nt = createTab(name);
        if (nt) {
          if (withEntry) addToTab(nt.id, withEntry);
          setView(nt.id);
        }
      }
      closeCtx();
    };
    okB.addEventListener('click', commit);
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') closeCtx();
      ev.stopPropagation();
    });
    box.append(inp, okB);
    els.pane.append(box);
    // anchor under the ＋ / the tab button
    if (anchor) {
      const pr = els.pane.getBoundingClientRect();
      const ar = anchor.getBoundingClientRect();
      const sx = pr.width ? (els.pane.offsetWidth / pr.width) : 1;
      const sy = pr.height ? (els.pane.offsetHeight / pr.height) : 1;
      box.style.left = Math.max(6, Math.min((ar.left - pr.left) * sx, els.pane.offsetWidth - box.offsetWidth - 6)) + 'px';
      box.style.top = ((ar.bottom - pr.top) * sy + 6) + 'px';
    } else {
      box.style.left = '20px'; box.style.top = '48px';
    }
    els.namer = box;
    inp.focus();
  }

  /* ---- category rail, grouped by pack ----------------------------------- */

  function renderCats() {
    if (!els.cats) return;
    els.cats.textContent = '';
    const ents = collectionEntries();

    const mkCat = (name, count, isAll, indent) => {
      const b = document.createElement('button');
      b.className = 'an-cat' + (ui.activeCat === name && !ui.activePack ? ' active' : '') + (indent ? ' an-cat-sub' : '');
      b.dataset.cat = name;
      const n = document.createElement('span'); n.className = 'an-cat-name';
      n.textContent = indent ? name.slice(name.indexOf(SEP) + SEP.length) : name;
      n.title = name;
      const c = document.createElement('span'); c.className = 'an-cat-count'; c.textContent = String(count);
      b.append(n, c);
      b.title = isAll ? 'Every animation' : count + ' in ' + name;
      b.addEventListener('click', () => { ui.activeCat = name; ui.activePack = ''; renderCats(); renderScope(); renderList(); });
      return b;
    };

    els.cats.append(mkCat('All', ents.length, true, false));

    // group categories by pack — collapsible headers keep 30 packs breathable
    const groups = [];               // [{pack, count, cats:[{name,count}]}] in first-seen order
    const byPack = {};
    for (const e of ents) {
      const pk = packKeyOf(e);
      let g = byPack[pk];
      if (!g) { g = byPack[pk] = { pack: pk, count: 0, cats: [], byCat: {} }; groups.push(g); }
      g.count++;
      let c = g.byCat[e.category];
      if (!c) { c = g.byCat[e.category] = { name: e.category, count: 0 }; g.cats.push(c); }
      c.count++;
    }

    const flat = groups.length <= 1 || ui.view !== 'poses';
    for (const g of groups) {
      if (flat) {
        for (const c of g.cats) els.cats.append(mkCat(c.name, c.count, false, false));
        continue;
      }
      const open = !!ui.openPacks[g.pack];
      const head = document.createElement('button');
      head.className = 'an-pack-head' + (open ? ' open' : '') + (ui.activePack === g.pack ? ' active' : '');
      const tw = document.createElement('span'); tw.className = 'an-pack-tw'; tw.textContent = open ? '▾' : '▸';
      const nm = document.createElement('span'); nm.className = 'an-pack-name'; nm.textContent = g.pack; nm.title = g.pack;
      const ct = document.createElement('span'); ct.className = 'an-cat-count'; ct.textContent = String(g.count);
      head.append(tw, nm, ct);
      head.title = g.count + ' animations in ' + g.pack + ' — click to ' + (open ? 'fold' : 'browse');
      head.addEventListener('click', () => {
        ui.openPacks[g.pack] = !open;
        if (!open) { ui.activePack = g.pack; ui.activeCat = 'All'; }        // opening = browse the pack
        else if (ui.activePack === g.pack) ui.activePack = '';              // folding clears its scope
        renderCats(); renderScope(); renderList();
      });
      els.cats.append(head);
      if (open)
        for (const c of g.cats) els.cats.append(mkCat(c.name, c.count, false, true));
    }
  }

  /* ---- search scope (pack chip in the searchbar) ------------------------ */

  function renderScope() {
    if (!els.scope) return;
    els.scope.textContent = '';
    if (!ui.activePack) return;
    const chip = document.createElement('span');
    chip.className = 'an-scope-chip';
    const nm = document.createElement('span');
    nm.textContent = '📦 ' + ui.activePack;
    const x = document.createElement('button');
    x.className = 'an-scope-x';
    x.textContent = '✕';
    x.title = 'Show every pack again';
    x.addEventListener('click', () => { ui.activePack = ''; renderCats(); renderScope(); renderList(); });
    chip.append(nm, x);
    els.scope.append(chip);
  }

  function matchingPacks(q) {
    const out = [];
    const seen = {};
    for (const e of collectionEntries()) {
      const pk = packKeyOf(e);
      if (seen[pk] !== undefined) { if (seen[pk] >= 0) out[seen[pk]].count++; continue; }
      if (pk.toLowerCase().indexOf(q) !== -1) { seen[pk] = out.length; out.push({ pack: pk, count: 1 }); }
      else seen[pk] = -1;
    }
    return out;
  }

  /* ============================================================ list  == */

  function renderList() {
    if (!els.list) return;
    const rows = filtered();
    els.count.textContent = rows.length + (rows.length === 1 ? ' animation' : ' animations');
    els.list.textContent = '';

    // 📦 pack hits ride above the rows while typing (search covers pack names)
    const q = ui.query.trim().toLowerCase();
    if (q && !ui.activePack) {
      const packs = matchingPacks(q).slice(0, MAX_PACK_CHIPS);
      if (packs.length) {
        const row = document.createElement('div');
        row.className = 'an-pk-chiprow';
        for (const p of packs) {
          const chip = document.createElement('button');
          chip.className = 'an-pk-chip';
          chip.textContent = '📦 ' + p.pack + ' · ' + p.count;
          chip.title = 'Browse every ' + p.pack + ' animation';
          chip.addEventListener('click', () => {
            ui.activePack = p.pack; ui.activeCat = 'All';
            ui.query = ''; if (els.search) els.search.value = '';
            ui.openPacks[p.pack] = true;
            renderCats(); renderScope(); renderList();
          });
          row.append(chip);
        }
        els.list.append(row);
      }
    }

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'an-empty';
      const t = tabById(ui.view);
      if (ui.query) empty.textContent = 'Nothing matches “' + ui.query + '”.';
      else if (ui.view === 'fav' && !Object.keys(state.user.favs).length)
        empty.textContent = 'No favorites yet — hover any animation and hit its ☆.';
      else if (t && !t.items.length)
        empty.textContent = 'Nothing in “' + t.name + '” yet — right-click any animation and “Add to “' + t.name + '””.';
      else empty.textContent = 'No animations in this category.';
      els.list.append(empty);
      return;
    }

    const shown = Math.min(rows.length, RENDER_CAP);
    for (let i = 0; i < shown; i++) {
      const e = rows[i];
      const row = document.createElement('div');
      row.className = 'an-row' + (e.needsFurniture ? ' disabled' : '') + (i === 0 ? ' top' : '') +
        (e._missing ? ' missing' : '');

      const main = document.createElement('div');
      main.className = 'an-row-main';
      const name = document.createElement('div');
      name.className = 'an-row-name';
      name.textContent = e.label || e.event;
      name.title = e.event;
      const meta = document.createElement('div');
      meta.className = 'an-row-meta';
      meta.textContent = e.category + (e.needsObject ? ' · needs prop' : '') +
        (e.needsFurniture ? ' · needs furniture' : '') +
        (e._missing ? ' · pack hidden or not scanned — may still play' : '');
      main.append(name, meta);
      row.append(main);

      if (!e.needsFurniture) {
        const star = document.createElement('button');
        star.className = 'an-star' + (isFav(e) ? ' on' : '');
        star.textContent = isFav(e) ? '★' : '☆';
        star.title = isFav(e) ? 'Un-favorite' : 'Favorite — collects it under ★ Favorites';
        star.addEventListener('click', (ev) => { ev.stopPropagation(); toggleFav(e); });
        row.append(star);
      }

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
        if (ev.target === btn || ev.target.classList.contains('an-star')) return;
        apply(e);
      });
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); rowCtx(ev, e); });
      els.list.append(row);
    }

    if (rows.length > shown) {
      const more = document.createElement('div');
      more.className = 'an-more';
      more.textContent = (rows.length - shown) + ' more — keep typing to narrow it down.';
      els.list.append(more);
    }
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
      const zero = !p.count;
      const row = document.createElement('label');
      row.className = 'an-pk-row' + (p.enabled ? '' : ' off') + (zero ? ' zero' : '');
      if (!zero) {
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
        row.append(cb);
      } else {
        const dot = document.createElement('span');
        dot.className = 'an-pk-zerodot';
        dot.textContent = '◦';
        row.append(dot);
      }
      const name = document.createElement('span');
      name.className = 'an-pk-name';
      name.textContent = esc(p.name);
      const count = document.createElement('span');
      count.className = 'an-pk-count';
      if (zero) {
        // scan v2 honesty: this pack ships animations, but none this tab can
        // fire — say WHY instead of hiding it (an invisible pack reads as a
        // scanner miss).
        const why = (p.paired && !p.behav) ? 'paired — plays through OStim scenes'
          : (!p.paired && p.behav) ? 'behaviour files, not poses'
          : (p.paired || p.behav) ? 'paired/behaviour only'
          : 'nothing applyable';
        name.title = esc(p.file || p.name) + ' — ' + why +
          (p.paired ? ' (' + p.paired + ' paired line(s))' : '');
        const tagEl = document.createElement('span');
        tagEl.className = 'an-pk-why';
        tagEl.textContent = why;
        count.textContent = '0';
        row.append(name, tagEl, count);
      } else {
        name.title = esc(p.file || p.name) + ' — ' + p.count + ' animations';
        count.textContent = String(p.count);
        row.append(name, count);
      }
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
        'was never registered — re-run FNIS/Nemesis/Pandora for that pack. Packs from ' +
        'MO2-disabled mods are invisible to the game and cannot be scanned.';
      els.pkBody.append(hint);
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
      state.user = normUser(j.user);
      eventIndex = null;
      ui.scanning = false;
      if (ui.view !== 'poses' && ui.view !== 'fav' && !tabById(ui.view)) ui.view = 'poses';
      if (els.source) {
        const nScan = state.packs.filter((p) => p.count).length;
        els.source.textContent = state.entries.length + ' animations · ZaZ + Halo built in' +
          (nScan ? ' + ' + nScan + ' scanned pack' + (nScan === 1 ? '' : 's') : '');
        els.source.title = state.source;
      }
      renderSeg();
      renderTarget();
      renderCats();
      renderScope();
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

    // the searchbar's scope slot (pack chip) — created here so the static
    // markup needs no edit
    const bar = $('an-searchbar');
    if (bar) {
      els.scope = document.createElement('span');
      els.scope.id = 'an-scope';
      bar.insertBefore(els.scope, els.search);
    }

    els.search.addEventListener('input', () => { ui.query = els.search.value || ''; renderList(); });
    els.search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const rows = filtered();
        if (rows.length) apply(rows[0]);   // Enter = top hit (deck idiom)
      }
      if (ev.key === 'Escape' && ui.activePack) {
        ui.activePack = '';
        renderCats(); renderScope(); renderList();
      }
    });
    els.reset.addEventListener('click', () => { toGame('anReset'); toast('reset', true); });
    els.crawl.addEventListener('click', () => {
      if (!state.crawlReady) { toast('crawl not available — rebuild the wardrobe ESP', false); return; }
      toGame('anCrawl');
    });
    if (els.rescan) els.rescan.addEventListener('click', startScan);

    // the static Poses/OStim buttons: ostim-pane owns the mode flip; we track
    // the view + our buttons' active state on top of it
    const segPoses = $('an-seg-poses');
    if (segPoses) {
      // Rober (2026-08-14): the first segment should read "Animations", not
      // "Poses". Renamed at the LABEL only — the id (an-seg-poses), the view
      // key ('poses') and every marker stay, so nothing downstream shifts.
      segPoses.textContent = 'Animations';
      segPoses.title = 'Every applyable animation in your load order';
      segPoses.addEventListener('click', () => setView('poses'));
    }
    const segOstim = $('an-seg-ostim');
    if (segOstim) segOstim.addEventListener('click', () => { closeCtx(); setTimeout(syncSegActive, 0); });

    // any click outside a menu closes it
    document.addEventListener('click', (ev) => {
      if (els.ctx && !els.ctx.contains(ev.target)) closeCtx();
      else if (els.namer && !els.namer.contains(ev.target) &&
               !(ev.target.classList && ev.target.classList.contains('an-seg-add'))) closeCtx();
    });

    chain('anOpen', 'open');
    chain('anResult', 'result');
    chain('anTargetResult', 'target');

    renderSeg();

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
    syncSegActive();
  }

  function onHide() { ui.shown = false; closeCtx(); if (window.OStimPane) OStimPane.onAnimHide(); }
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
    ok('rows rendered', els.list.querySelectorAll('.an-row').length === 6);
    ok('furniture row disabled', !!els.list.querySelector('.an-row.disabled'));
    ok('furniture apply disabled', els.list.querySelector('.an-row.disabled .an-apply').disabled === true);
    ok('needs-prop noted', /needs prop/.test(els.list.textContent));
    ok('target reads Lydia', /Lydia/.test(els.target.textContent));
    ok('crawl button ready', !els.crawl.classList.contains('disabled'));
    ok('favorites seg button present', !!els.seg.querySelector('.an-seg-fav'));
    ok('add-tab button present', !!els.seg.querySelector('.an-seg-add'));

    // search within All
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
          keywords: 'animation pose zap ' + e.event + ' ' + e.category + ' ' + packKeyOf(e),
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
    init, onShow, onHide, toggleEdit, wantsPause, segAlwaysOn,
    _state: state, _ui: ui, _devUser: () => devState.user   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.AnimPane.init());
} else {
  window.AnimPane.init();
}
