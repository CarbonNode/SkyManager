'use strict';

/* ====================================================================== *
 *  Wigs — the rendered wig catalogue (Rober, 2026-08-15: "New tab: Wigs.
 *  Like the mod Tailor — you add a wig mod by esp, it populates with all
 *  the wigs. I never know what a wig will look like, so make it like the
 *  presets tab visually, and use the mesh render mod to render icons for
 *  all the wigs — persistent, remembers icons. Searchable, favoritable,
 *  categorizable into tabs.")
 *
 *  The Faces tab's gallery skin over the Items tab's plumbing. C++ owns
 *  the wig index, the wear/strip/take verbs and the sidecar persistence;
 *  this pane owns the ONE bar, the target control, the pills (All /
 *  ★ Favorites / custom tabs), the registered-mod rail, the add-mod
 *  picker and the BIG tile gallery. Tile art rides the SHARED item icon
 *  route verbatim: whIcons -> DOM event 'hd-item-icons', resolved through
 *  WardrobePane.itemIconFor — render once, remembered on disk forever.
 *
 *  Bridge — requests: wvState() · wvMods(json) · wvQuery(json) ·
 *    wvUse(json) · wvSave(json)
 *  Replies (disjoint, per the deck law — all RESPONSE-style, the pane
 *  always asks first, so no hd-boot STUB_FNS entry):
 *    wvStateResult({ready,mods,view}) · wvModsData({mods}) ·
 *    wvResultData({total,offset,rows}) · wvUseResult({ok,msg,id,op}) ·
 *    wvSaved({ok})
 *
 *  The `view` blob is OURS — C++ round-trips it verbatim:
 *    { favs:[ids], tabs:[{name, ids:[]}], pageSize, target, lastPill }
 *
 *  Host contract (mirrors ItemsPane): WigsPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 *
 *  marker: wigs-pane.js
 * ====================================================================== */

window.WigsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;      // per keystroke, before the C++ query fires
  const PICKER_DEBOUNCE_MS = 140;

  /* Gallery pagination — BIG tiles, so the sizes are grid-shaped (rows of
     ~4-6 at deck width). KS packs ship hundreds of wigs; the page is the only
     thing that ever reaches the DOM or the render queue. */
  const PAGE_SIZES = [12, 24, 48, 96];
  const DEFAULT_PAGE_SIZE = 24;

  const MAX_TAB_NAME = 28;
  const MAX_TABS = 12;

  /* ============================================================== state == */

  const state = {
    ready: false,
    mods: [],        // [{plugin, present, all, count}] — the REGISTERED wig mods
    total: 0,
    rows: [],        // current page only — never accumulates
    awaiting: false,
    names: {},       // id -> name, session cache (fav labels for omni / ctx)
    worn: { me: '', look: '' },   // wvUseResult history this session, per target
    user: { favs: [], tabs: [], hidden: [] }, // the view blob's favs + tabs + hidden (schema above)
  };

  const ui = {
    q: '',
    mod: '',         // scope: one registered mod's plugin, or ''
    view: 'all',     // 'all' | 'fav' | 'tab:<name>'
    target: 'me',    // 'me' | 'look' — persisted in the view blob
    sel: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    page: 0,         // 0-based, session-only
    visible: false,
    debT: null,
    toastT: null,
    iconReq: {},     // formId|plugin -> 1 : renders already asked this session
    iconT: null,     // settle timer before icons are requested for a query
    iconPollT: null,
    iconPollN: 0,
    hintSeen: false,
    armDelete: '',   // tab name armed for delete via ctx
    armUnreg: '',    // mod plugin armed for unregister via the chip ✕
    picker: null,    // { q, mods:[], sel, debT } while the add-mod picker is up
  };

  const els = { ctx: null, namer: null };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'wvState') setTimeout(devState, 30);
      if (DEV && fn === 'wvQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'wvMods') setTimeout(function () { devMods(arg); }, 30);
      if (DEV && fn === 'wvUse') setTimeout(function () { devUse(arg); }, 30);
      if (DEV && fn === 'wvSave') setTimeout(function () { window.wvSaved({ ok: true }); }, 30);
    }
  }

  /* Receivers at parse time — the hd-boot buffering stubs and the C++ pushes
     both resolve against window.<fn> the moment this script lands. */

  window.wvStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = !!d.ready;
    state.mods = Array.isArray(d.mods) ? d.mods : [];
    applyViewBlob(d.view);
    if (ui.visible) {
      if (state.ready) runQuery(true);
      render();
    }
  };

  window.wvModsData = function (d) {
    if (!d || typeof d !== 'object') return;
    if (!ui.picker) return;                     // picker closed — stale answer
    ui.picker.mods = Array.isArray(d.mods) ? d.mods : [];
    ui.picker.sel = 0;
    renderPickerRows();
  };

  window.wvResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    /* No seq in the wv contract — the bridge is FIFO, so last-write-wins;
       the one stale shape worth dropping is a reply for a page we already
       left (its offset no longer matches where the pane stands). */
    if ((d.offset | 0) !== ui.page * ui.pageSize) return;
    state.awaiting = false;
    state.total = d.total | 0;
    state.rows = Array.isArray(d.rows) ? d.rows : [];
    state.rows.forEach(function (r) { if (r && r.id && r.name) state.names[r.id] = r.name; });
    /* a page that no longer exists (total shrank under a stale offset) */
    if (!state.rows.length && state.total > 0 && ui.page > 0 &&
        ui.page * ui.pageSize >= state.total) {
      ui.page = Math.max(0, Math.ceil(state.total / ui.pageSize) - 1);
      runQuery(false);
      return;
    }
    ui.sel = 0;
    if (ui.visible) render();
  };

  window.wvUseResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (d.ok && d.id) {
      if (d.op === 'wear') state.worn[ui.target] = d.id;
      else if (d.op === 'strip' && state.worn[ui.target] === d.id) state.worn[ui.target] = '';
    }
    if (ui.visible) renderBodyPreservingScroll();
  };

  window.wvSaved = function (d) {
    /* {ok} only — nothing to reconcile; the blob is ours and already applied */
  };

  /* ========================================================== view blob == */

  function applyViewBlob(v) {
    if (!v || typeof v !== 'object') return;
    state.user.favs = Array.isArray(v.favs) ? v.favs.filter(function (x) { return typeof x === 'string' && x; }) : [];
    /* wigs the player took OUT of the catalogue (Rober, 2026-08-15: "ability to
       remove individual wigs or faces?"). Curation only — the mod keeps every
       record, so a hidden wig comes straight back from the Hidden pill; it also
       stops asking for a render, which is the cheap way to stop a wig that
       cannot render from occupying the queue forever. */
    state.user.hidden = Array.isArray(v.hidden) ? v.hidden.filter(function (x) { return typeof x === 'string' && x; }) : [];
    state.user.tabs = Array.isArray(v.tabs) ? v.tabs.map(function (t) {
      return {
        name: String(t && t.name || '').slice(0, MAX_TAB_NAME),
        ids: (t && Array.isArray(t.ids)) ? t.ids.filter(function (x) { return typeof x === 'string' && x; }) : [],
      };
    }).filter(function (t) { return t.name; }).slice(0, MAX_TABS) : [];
    if (typeof v.pageSize === 'number' && v.pageSize > 0) ui.pageSize = clampPageSize(v.pageSize);
    if (v.target === 'me' || v.target === 'look') ui.target = v.target;
    if (typeof v.lastPill === 'string' && viewResolves(v.lastPill)) ui.view = v.lastPill;
  }

  function viewResolves(view) {
    if (view === 'all' || view === 'fav') return true;
    if (view === 'hidden') return true;
    if (view.indexOf('tab:') === 0) return !!tabByName(view.slice(4));
    return false;
  }

  function viewBlob() {
    return {
      favs: state.user.favs.slice(),
      hidden: state.user.hidden.slice(),
      tabs: state.user.tabs.map(function (t) { return { name: t.name, ids: t.ids.slice() }; }),
      pageSize: ui.pageSize,
      target: ui.target,
      lastPill: ui.view,
    };
  }

  /* Everything the pane must remember rides ONE save: the registered mods
     (plugin + all flag, C++'s half) and the view blob (ours, verbatim). */
  function saveAll() {
    toGame('wvSave', JSON.stringify({
      mods: state.mods.map(function (m) { return { plugin: m.plugin, all: !!m.all }; }),
      view: viewBlob(),
    }));
  }

  /* ============================================================ queries == */

  function clampPageSize(n) {
    n = Math.round(Number(n) || 0);
    if (PAGE_SIZES.indexOf(n) !== -1) return n;
    let best = DEFAULT_PAGE_SIZE, bestD = Infinity;
    for (let i = 0; i < PAGE_SIZES.length; i++) {
      const d = Math.abs(PAGE_SIZES[i] - n);
      if (d < bestD) { bestD = d; best = PAGE_SIZES[i]; }
    }
    return best;
  }

  function tabByName(name) {
    for (let i = 0; i < state.user.tabs.length; i++)
      if (state.user.tabs[i].name === name) return state.user.tabs[i];
    return null;
  }

  function currentTab() {
    return ui.view.indexOf('tab:') === 0 ? tabByName(ui.view.slice(4)) : null;
  }

  /* The id list an ids-mode view queries against, or null for the catalogue. */
  function viewIds() {
    if (ui.view === 'fav') return state.user.favs;
    if (ui.view === 'hidden') return state.user.hidden;
    const t = currentTab();
    if (t) return t.ids;
    return null;
  }

  function registeredCount() {
    let n = 0;
    state.mods.forEach(function (m) { n += (m.count | 0); });
    return n;
  }

  function runQuery(reset) {
    if (reset) { ui.page = 0; chipLastLand = Date.now(); }   // a new search re-arms the render window
    if (!state.ready || !state.mods.length) {
      state.rows = []; state.total = 0; state.awaiting = false;
      render();
      return;
    }
    const ids = viewIds();
    if (ids && !ids.length) {
      /* an empty collection is a local fact — never a round-trip */
      state.rows = []; state.total = 0; state.awaiting = false;
      render();
      return;
    }
    state.awaiting = true;
    ui.sel = 0;
    const req = { limit: ui.pageSize, offset: ui.page * ui.pageSize };
    if (ui.q) req.q = ui.q;
    if (ids) req.ids = ids.slice();
    else if (ui.mod) req.mod = ui.mod;
    toGame('wvQuery', JSON.stringify(req));
    render();
  }

  function queryDebounced() {
    if (ui.debT) clearTimeout(ui.debT);
    ui.debT = setTimeout(function () { ui.debT = null; runQuery(true); }, DEBOUNCE_MS);
  }

  /* ---- pagination ------------------------------------------------------- */

  function pageCount() {
    if (ui.pageSize <= 0) return 1;
    return Math.max(1, Math.ceil((state.total || 0) / ui.pageSize));
  }

  function gotoPage(p) {
    const pc = pageCount();
    p = Math.max(0, Math.min(pc - 1, Math.round(p) || 0));
    if (p === ui.page) return;
    ui.page = p;
    chipLastLand = Date.now();     // a new page re-arms the render window for its tiles
    runQuery(false);
    const body = $('wv-body');
    if (body) body.scrollTop = 0;
    const s = $('wv-search');
    if (s) s.focus();
  }

  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    saveAll();
    runQuery(false);
  }

  /* ============================================================ actions == */

  function useWig(row, op) {
    if (!row || row.missing) {
      if (row && row.missing) toast('That wig isn’t in the load order any more', true);
      return;
    }
    toGame('wvUse', JSON.stringify({ id: row.id, op: op || 'wear', target: ui.target }));
  }

  function setView(view) {
    if (ui.view === view) return;
    ui.view = view;
    if (view !== 'all') ui.mod = '';    // ids-mode and the mod scope are exclusive
    ui.page = 0;
    saveAll();                          // lastPill persists
    runQuery(true);
  }

  function setMod(plugin) {
    ui.mod = String(plugin || '');
    ui.view = 'all';
    ui.page = 0;
    saveAll();
    runQuery(true);
    const s = $('wv-search');
    if (s) s.focus();
  }

  function clearMod() {
    if (!ui.mod) return;
    ui.mod = '';
    runQuery(true);
    const s = $('wv-search');
    if (s) s.focus();
  }

  function setTarget(t) {
    if (t !== 'me' && t !== 'look') return;
    if (ui.target === t) return;
    ui.target = t;
    saveAll();
    renderTarget();
    renderBodyPreservingScroll();   // the worn accent follows the target
  }

  /* ---- favorites + custom tabs (anim-pane v2 idioms) -------------------- */

  function isFav(id) { return state.user.favs.indexOf(id) !== -1; }
  function isHidden(id) { return state.user.hidden.indexOf(id) !== -1; }

  function setHidden(id, on) {
    const i = state.user.hidden.indexOf(id);
    if (on && i === -1) state.user.hidden.push(id);
    else if (!on && i !== -1) state.user.hidden.splice(i, 1);
    saveAll();
    ui.sel = 0;
    render();
  }

  function toggleFav(row) {
    const i = state.user.favs.indexOf(row.id);
    if (i === -1) state.user.favs.push(row.id);
    else state.user.favs.splice(i, 1);
    if (row.name) state.names[row.id] = row.name;
    saveAll();
    renderPills();
    if (ui.view === 'fav') runQuery(false);
    else renderBodyPreservingScroll();
  }

  function createTab(name) {
    name = String(name || '').trim().slice(0, MAX_TAB_NAME);
    if (!name) return null;
    if (tabByName(name)) { toast('A tab named “' + name + '” already exists', true); return null; }
    if (state.user.tabs.length >= MAX_TABS) { toast('Tab limit reached (' + MAX_TABS + ')', true); return null; }
    const t = { name: name, ids: [] };
    state.user.tabs.push(t);
    saveAll();
    renderPills();
    return t;
  }

  function renameTab(t, name) {
    name = String(name || '').trim().slice(0, MAX_TAB_NAME);
    if (!name || name === t.name) return;
    if (tabByName(name)) { toast('A tab named “' + name + '” already exists', true); return; }
    const wasActive = ui.view === 'tab:' + t.name;
    t.name = name;
    if (wasActive) ui.view = 'tab:' + name;
    saveAll();
    renderPills();
  }

  /* Delete refiles NOTHING — the membership just dissolves; the wigs stay in
     the catalogue (and in favorites, if starred). */
  function deleteTab(name) {
    const i = state.user.tabs.findIndex(function (t) { return t.name === name; });
    if (i === -1) return;
    state.user.tabs.splice(i, 1);
    if (ui.view === 'tab:' + name) ui.view = 'all';
    saveAll();
    renderPills();
    runQuery(true);
  }

  function inTab(t, id) { return t.ids.indexOf(id) !== -1; }

  function addToTab(t, row) {
    if (inTab(t, row.id)) return;
    t.ids.push(row.id);
    if (row.name) state.names[row.id] = row.name;
    saveAll();
    renderPills();
    toast('Added to “' + t.name + '”');
  }

  function removeFromTab(t, id) {
    const i = t.ids.indexOf(id);
    if (i === -1) return;
    t.ids.splice(i, 1);
    saveAll();
    renderPills();
    if (ui.view === 'tab:' + t.name) runQuery(false);
  }

  /* ---- registered mods -------------------------------------------------- */

  function modByPlugin(plugin) {
    for (let i = 0; i < state.mods.length; i++)
      if (state.mods[i].plugin === plugin) return state.mods[i];
    return null;
  }

  function addMod(plugin, count) {
    if (modByPlugin(plugin)) return;
    state.mods.push({ plugin: plugin, present: true, all: false, count: count | 0 });
    saveAll();
    /* C++ recounts on save; re-ask so counts/present are its truth, and the
       fresh mod's wigs join the gallery */
    toGame('wvState');
    renderHeader(); renderMods();
    runQuery(true);
  }

  function removeMod(plugin) {
    const i = state.mods.findIndex(function (m) { return m.plugin === plugin; });
    if (i === -1) return;
    state.mods.splice(i, 1);
    if (ui.mod === plugin) ui.mod = '';
    ui.armUnreg = '';
    saveAll();
    toGame('wvState');
    render();
    runQuery(true);
    toast('“' + plugin + '” unregistered — its wigs left the gallery');
  }

  function toggleModAll(plugin) {
    const m = modByPlugin(plugin);
    if (!m) return;
    m.all = !m.all;
    saveAll();
    toGame('wvState');
    toast(m.all ? 'Showing everything “' + plugin + '” ships' : 'Back to hair-slot wigs only');
    runQuery(true);
  }

  /* ============================================================= render == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtN(n) {
    n = Math.round(Number(n) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }

  /* ============================================================== icons == */

  /* The item-render pipeline VERBATIM (items-pane precedent): row id
     "Plugin.esp|HEX6" -> whIcons {items:[{formId,plugin,name}]} for the
     visible page only; upgrades land via the shared 'hd-item-icons' event;
     WardrobePane owns the ONE key normalisation + index. */

  function idParts(id) {
    const s = String(id || '');
    const bar = s.lastIndexOf('|');
    if (bar === -1) return null;
    const plugin = s.slice(0, bar);
    const hex = s.slice(bar + 1);
    if (!plugin || !hex) return null;
    return { formId: '0x' + hex, plugin: plugin };
  }

  /* What this wig should be drawn with, as an HDArt spec. `icon` is a picture
     the OWNER chose (C++ ships it on the row when there is one) — the top rung
     of the precedence law, and the reason this goes through HDArt at all. */
  function artSpec(id) {
    const p = idParts(id);
    if (!p) return null;
    const r = rowById(id);
    return {
      kind: 'item', formId: p.formId, plugin: p.plugin,
      name: r ? r.name : '', icon: (r && r.icon) || '', glyph: '💇',
    };
  }

  /* HDArt FIRST — it owns the one precedence law (custom upload > MRF render >
     interface icon > glyph) and taps the same wdItemIcons reply these renders
     arrive on, so nothing about the render route changes. Asking WardrobePane
     alone, as this did, could only ever see rung 2: a wig with a hand-chosen
     icon drew a glyph. WardrobePane stays the fallback for a harness (or an
     older view) with no hd-art.js loaded. */
  function iconFor(id) {
    const p = idParts(id);
    if (!p) return '';
    try {
      if (window.HDArt && typeof HDArt.for === 'function') {
        const a = HDArt.for(artSpec(id));
        if (a && a.src) return a.src;        // already sanitised by HDArt
      }
    } catch (e) { /* fall through to the pane's own route */ }
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      const path = WardrobePane.itemIconFor(p) || '';
      if (!path) return '';
      if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }

  /* Why this wig will never get art, or '' if it might still land. C++ ships a
     verdict per dead end; without it a failed tile is indistinguishable from a
     queued one, which is exactly how Rober sat waiting on a wig that had
     already failed (2026-08-15). */
  function failFor(id) {
    const p = idParts(id);
    if (!p) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFailed !== 'function') return '';
    try { return WardrobePane.itemIconFailed(p) || ''; } catch (e) { return ''; }
  }

  function retryArt(id) {
    const p = idParts(id);
    if (!p || !window.WardrobePane || typeof WardrobePane.retryItemIcon !== 'function') return;
    const r = rowById(id);
    if (r) p.name = r.name;
    try { WardrobePane.retryItemIcon(p); } catch (e) { return; }
    chipLastLand = Date.now();      // re-open the render window for the retry
    renderBody();
  }

  /* ---- the one-shot self-closing render window (items/npcs idiom) ------- */
  const RENDER_IDLE_MS = 30000;   // no new art for this long => window closed
  let chipLastLand = 0;
  let renderChip = null;
  let chipT = null;

  function renderWindowActive() {
    return state.ready && chipLastLand > 0 && missingArt() &&
      (Date.now() - chipLastLand) < RENDER_IDLE_MS;
  }

  function rowLoading(r) {
    return !r.missing && renderWindowActive() && !!idParts(r.id) && !iconFor(r.id) && !failFor(r.id);
  }

  function missingArt() {
    for (let i = 0; i < state.rows.length; i++) {
      const r = state.rows[i];
      if (!r.missing && !iconFor(r.id) && !failFor(r.id)) return true;
    }
    return false;
  }

  function updateRenderChip() {
    const pane = $('wv-pane');
    if (!pane) return;
    if (!renderChip) {
      renderChip = document.createElement('div');
      renderChip.className = 'wv-render-chip';
      renderChip.innerHTML = '<span class="wv-render-spin"></span><span class="wv-render-txt"></span>';
      pane.appendChild(renderChip);
    }
    let pending = 0;
    /* a wig whose render FAILED is not pending — counting it kept the chip
       spinning forever on a queue that was already finished */
    (state.rows || []).forEach(function (r) {
      if (!r.missing && idParts(r.id) && !iconFor(r.id) && !failFor(r.id)) pending++;
    });
    const active = pending > 0 && renderWindowActive();
    renderChip.classList.toggle('wv-on', !!active);
    if (active) {
      renderChip.querySelector('.wv-render-txt').textContent =
        'rendering ' + pending + ' wig' + (pending === 1 ? '' : 's') + '…';
      const body = $('wv-body');
      if (body && body.offsetTop) renderChip.style.top = body.offsetTop + 'px';
    }
    armChipWatchdog(active);
  }

  function armChipWatchdog(active) {
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (!active) return;
    const left = Math.max(250, RENDER_IDLE_MS - (Date.now() - chipLastLand) + 60);
    chipT = setTimeout(function () {
      chipT = null;
      if (ui.visible) renderBodyPreservingScroll();
    }, left);
  }

  function firstOpenHint() {
    return !ui.hintSeen && renderWindowActive();
  }
  function dismissHintIfDone() {
    if (ui.hintSeen) return;
    if (chipLastLand > 0 && !missingArt()) ui.hintSeen = true;
  }

  function requestIcons() {
    if (!state.rows.length) return;
    const items = [], seen = {};
    for (let i = 0; i < state.rows.length; i++) {
      const r = state.rows[i];
      if (r.missing) continue;
      const p = idParts(r.id);
      if (!p) continue;
      const key = p.formId + '|' + p.plugin;
      if (ui.iconReq[key] || seen[key]) continue;
      if (iconFor(r.id)) continue;
      seen[key] = 1;
      ui.iconReq[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: r.name || '' });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
  }

  /* The settle gate — NEVER request renders per keystroke (the e/eb/ebo flood
     lesson): icons are asked for only once the results sat unchanged 650ms. */
  const ICON_SETTLE_MS = 650;
  const ICON_POLL_MS = 2500;
  const ICON_POLL_MAX = 24;   // ~60s of watching per settled query

  function scheduleIconWork() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!state.rows.length) { stopIconPoll(); updateRenderChip(); return; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.visible) return;
      if (missingArt()) chipLastLand = Date.now();
      requestIcons();
      startIconPoll();
      updateRenderChip();
    }, ICON_SETTLE_MS);
  }

  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }

  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    ui.iconPollLast = undefined;
    if (!missingArt()) return;
    ui.iconPollT = setInterval(iconPollTick, ICON_POLL_MS);
  }

  /* The C++ batch-done push only fires when the WHOLE render queue drains —
     an EMPTY whIcons queues nothing but answers with the on-disk index, so
     tiles upgrade as their renders hit the disk.
     Two rules earned on 2026-08-16 ("Apple (Elf) just shows generating skeleton
     for ever, never updates"):
       · the tick budget counts STALLED ticks, not elapsed ones. 88 wigs render
         well past 60 s (renders are paced while the world draws), so a flat
         24-tick cap gave up mid-batch and the remaining tiles span forever.
         Progress since the last tick resets the counter; only 60 s with NOTHING
         landing closes the window.
       · every 4th tick re-ASKS for the rows still missing. A key C++ dropped
         (queue full, or a batch cut short by a crash/reload) is otherwise dead
         for the session: requestIcons marks it asked and never asks again, and
         an empty poll queues nothing. Re-asking is free when it is already
         queued — C++ dedupes on its own asked set. */
  const ICON_REASK_EVERY = 4;
  function iconPollTick() {
    if (!ui.visible || !missingArt()) { stopIconPoll(); return false; }
    const pending = pendingArtCount();
    if (ui.iconPollLast === undefined || pending < ui.iconPollLast)
      ui.iconPollN = 0;             // art is still landing — keep watching
    ui.iconPollLast = pending;
    if (++ui.iconPollN > ICON_POLL_MAX) { stopIconPoll(); return false; }
    if (ui.iconPollN % ICON_REASK_EVERY === 0) {
      reaskMissing();
      return true;
    }
    toGame('whIcons', JSON.stringify({ items: [] }));
    return true;
  }

  function pendingArtCount() {
    let n = 0;
    for (let i = 0; i < state.rows.length; i++) {
      const r = state.rows[i];
      if (!r.missing && !iconFor(r.id) && !failFor(r.id)) n++;
    }
    return n;
  }

  /* Drop the "already asked" marks for rows that still have no picture, then
     ask again — the only way a dropped key ever gets queued a second time. */
  function reaskMissing() {
    for (let i = 0; i < state.rows.length; i++) {
      const r = state.rows[i];
      if (r.missing || iconFor(r.id) || failFor(r.id)) continue;
      const p = idParts(r.id);
      if (p) delete ui.iconReq[p.formId + '|' + p.plugin];
    }
    requestIcons();
  }

  function flushIconsForTest() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    requestIcons();
  }

  /* ============================================================ lightbox == */

  function openLightbox(row) {
    const url = iconFor(row.id);
    if (!url || !window.HDLightbox) return;
    const frames = ['-a090', '-a180', '-a270'].map(function (s) {
      return url.replace(/\.png$/, s + '.png');
    });
    HDLightbox.open({
      host: $('wv-pane'),
      src: url,
      glyph: '💇',
      title: row.name,
      sub: row.plugin + (row.slot ? ' · slot ' + row.slot : ''),
      frames: frames,
      spin: (function () { const p = idParts(row.id); return p ? { kind: 'item', formId: p.formId, plugin: p.plugin } : null; })(),
    });
  }

  /* =========================================================== renderers == */

  function renderHeader() {
    const chip = $('wv-count');
    if (chip) {
      chip.textContent = !state.ready
        ? 'reading your wig mods…'
        : state.mods.length
          ? (fmtN(registeredCount()) + ' wigs · ' + state.mods.length + ' mod' + (state.mods.length === 1 ? '' : 's'))
          : 'no wig mods registered yet';
    }
    renderTarget();
  }

  /* Target segmented control: Me | Who I'm looking at. Persisted. */
  function renderTarget() {
    const box = $('wv-target');
    if (!box) return;
    box.innerHTML =
      '<button class="wv-tgt' + (ui.target === 'me' ? ' wv-tgt-on' : '') + '" data-tgt="me" ' +
      'title="Wigs go on your own head">👤 Me</button>' +
      '<button class="wv-tgt' + (ui.target === 'look' ? ' wv-tgt-on' : '') + '" data-tgt="look" ' +
      'title="Wigs go on whoever your crosshair was on when the deck opened">👁 Who I’m looking at</button>';
    box.querySelectorAll('.wv-tgt').forEach(function (b) {
      b.addEventListener('click', function () { setTarget(b.getAttribute('data-tgt')); });
    });
  }

  /* Both rails are capped and scroll inside themselves (wigs-pane.css), so the
     SELECTED chip has to be pulled back into view after a re-render — picking a
     tab that wrapped onto row three otherwise leaves nothing on screen looking
     selected. scrollTop by hand, not scrollIntoView: the pane sits inside the
     transform-scaled #panel and scrollIntoView walks scrollable ancestors too. */
  function keepActiveInView(box, sel) {
    if (!box || box.scrollHeight <= box.clientHeight + 1) return;
    const on = box.querySelector(sel);
    if (!on) return;
    const top = on.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = Math.max(0, top - 4);
    else if (top + on.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top + on.offsetHeight - box.clientHeight + 4;
  }

  /* Pills: All · ★ Favorites (live count) · custom tabs · ＋ New tab */
  function renderPills() {
    const box = $('wv-pills');
    if (!box) return;
    let html =
      '<button class="wv-pill' + (ui.view === 'all' ? ' wv-pill-on' : '') + '" data-view="all" ' +
      'title="Every wig your registered mods ship">All</button>' +
      '<button class="wv-pill' + (ui.view === 'fav' ? ' wv-pill-on' : '') + '" data-view="fav" ' +
      'title="Your starred wigs">★ Favorites' +
      (state.user.favs.length ? ' <b class="wv-pill-n">' + state.user.favs.length + '</b>' : '') + '</button>';
    if (state.user.hidden.length)
      html += '<button class="wv-pill' + (ui.view === 'hidden' ? ' wv-pill-on' : '') + '" data-view="hidden" ' +
        'title="Wigs you removed from the catalogue — still in the mod; bring one back with ⟲">⊘ Hidden' +
        ' <b class="wv-pill-n">' + state.user.hidden.length + '</b></button>';
    state.user.tabs.forEach(function (t) {
      html += '<button class="wv-pill wv-pill-user' + (ui.view === 'tab:' + t.name ? ' wv-pill-on' : '') +
        '" data-view="tab:' + esc(t.name) + '" data-tab="' + esc(t.name) +
        '" title="' + t.ids.length + ' wig' + (t.ids.length === 1 ? '' : 's') +
        ' — right-click to rename or delete">' + esc(t.name) +
        (t.ids.length ? ' <b class="wv-pill-n">' + t.ids.length + '</b>' : '') + '</button>';
    });
    html += '<button class="wv-pill wv-pill-add" id="wv-tab-add" ' +
      'title="New tab — a collection you fill from any wig’s right-click menu">＋ New tab</button>';
    box.innerHTML = html;
    box.querySelectorAll('.wv-pill[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
      const tabName = b.getAttribute('data-tab');
      if (tabName) b.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        const t = tabByName(tabName);
        if (t) tabCtx(ev, t);
      });
    });
    const add = $('wv-tab-add');
    if (add) add.addEventListener('click', function () { openNamer(add, null, null); });
    keepActiveInView(box, '.wv-pill-on');
  }

  /* The registered-mod rail: one chip per mod (click = scope, ✕ = armed
     unregister, right-click = "Show everything it ships"), + the add chip. */
  function renderMods() {
    const box = $('wv-mods');
    if (!box) return;
    if (!state.ready) { box.innerHTML = ''; return; }
    let html = '';
    state.mods.forEach(function (m) {
      const absent = m.present === false;
      const armed = ui.armUnreg === m.plugin;
      html += '<span class="wv-mod' + (ui.mod === m.plugin ? ' wv-mod-on' : '') +
        (absent ? ' wv-mod-absent' : '') + '" data-plug="' + esc(m.plugin) + '" title="' +
        (absent ? esc(m.plugin) + ' isn’t in the load order — its wigs can’t show until it’s back'
          : 'Only ' + esc(m.plugin) + '’s wigs — right-click for options') + '">' +
        '<span class="wv-mod-name">' + esc(m.plugin) + '</span>' +
        '<b class="wv-mod-n">' + fmtN(m.count) + '</b>' +
        (m.all ? '<span class="wv-mod-all" title="Showing everything this mod ships, not just hair-slot pieces">all</span>' : '') +
        '<span class="wv-mod-x' + (armed ? ' wv-mod-x-armed' : '') + '" data-unreg="' + esc(m.plugin) + '" title="' +
        (armed ? 'Click again to unregister — favorites keep their stars, the wigs just leave the gallery'
          : 'Unregister this mod') + '">' + (armed ? 'sure?' : '✕') + '</span>' +
        '</span>';
    });
    html += '<button class="wv-mod wv-mod-add" id="wv-mod-add" ' +
      'title="Register a wig mod — its whole catalogue joins the gallery">＋ Add a wig mod…</button>';
    box.innerHTML = html;

    box.querySelectorAll('.wv-mod[data-plug]').forEach(function (chip) {
      const plug = chip.getAttribute('data-plug');
      chip.addEventListener('click', function (e) {
        if (e.target.getAttribute && e.target.getAttribute('data-unreg')) return;   // the ✕ owns itself
        ui.armUnreg = '';
        if (ui.mod === plug) clearMod(); else setMod(plug);
        renderMods();
      });
      chip.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        const m = modByPlugin(plug);
        if (!m) return;
        showCtx(ev, [
          {
            label: m.all ? '✓ Showing everything it ships — back to wigs only'
              : '👁 Show everything it ships',
            hint: 'For packs that put wigs on odd slots — lists every wearable piece, not just hair-slot ones',
            run: function () { closeCtx(); toggleModAll(plug); },
          },
          '-',
          {
            label: '✕ Unregister “' + m.plugin + '”',
            danger: true,
            run: function () { closeCtx(); ui.armUnreg = plug; renderMods(); },
          },
        ]);
      });
    });
    box.querySelectorAll('[data-unreg]').forEach(function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        const plug = x.getAttribute('data-unreg');
        if (ui.armUnreg === plug) removeMod(plug);
        else { ui.armUnreg = plug; renderMods(); }
      });
    });
    const add = $('wv-mod-add');
    if (add) add.addEventListener('click', openPicker);
    keepActiveInView(box, '.wv-mod-on');
  }

  /* ---- tiles ------------------------------------------------------------ */

  /* A file that isn't there degrades to the glyph, never a broken-image box.
     HDArt owns the shared inline degrade; the literal is the same behaviour for
     a harness with no hd-art.js. Resolved per render, not at load: this module
     may parse before hd-art.js does. */
  const ICO_ERR_FALLBACK = ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;wv-has-art&quot;);' +
    'b.removeChild(this);}"';
  function icoErr() {
    try {
      if (window.HDArt && typeof HDArt.errFor === 'function') return HDArt.errFor('wv-has-art');
    } catch (e) { /* fall through */ }
    return ICO_ERR_FALLBACK;
  }

  function tileHtml(r, idx) {
    if (r.missing) {
      /* an ids-mode row whose wig left the load order — greyed, with the
         honest reason, never silently dropped */
      const name = state.names[r.id] || r.id;
      return '<div class="wv-tile wv-missing' + (idx === ui.sel ? ' wv-sel' : '') + '" data-id="' + esc(r.id) + '">' +
        '<div class="wv-art"><span class="wv-glyph">💇</span>' +
        '<span class="wv-missing-band">not in the load order</span></div>' +
        '<div class="wv-name" title="' + esc(name) + ' — its mod was removed or disabled; put it back and this wig returns">' +
        esc(name) + '</div>' +
        '<div class="wv-plug" title="' + esc(r.plugin || '') + '">' + esc(r.plugin || 'mod missing') + '</div>' +
        '</div>';
    }
    const hasArt = !!iconFor(r.id);
    const why = hasArt ? '' : failFor(r.id);
    const loading = !hasArt && !why && rowLoading(r);
    const worn = state.worn[ui.target] === r.id;
    const fav = isFav(r.id);
    const hid = isHidden(r.id);
    return '<div class="wv-tile' + (idx === ui.sel ? ' wv-sel' : '') + (worn ? ' wv-worn' : '') +
      '" data-id="' + esc(r.id) + '" title="' + esc(r.name) + ' — click to wear' +
      (ui.target === 'look' ? ' on who you’re looking at' : '') + '">' +
      '<div class="wv-art' + (hasArt ? ' wv-has-art' : '') + (loading ? ' wv-loading' : '') +
      (why ? ' wv-failed' : '') + '">' +
      '<span class="wv-glyph">💇</span>' +
      (hasArt ? '<img class="wv-img" src="' + esc(iconFor(r.id)) + '" alt="" draggable="false"' + icoErr() + '>' : '') +
      /* an honest dead end: the x says it failed, the tooltip says why, and the
         button asks again — never a tile that just sits there */
      (why ? '<span class="wv-fail-x" title="' + esc(why) + '">✕</span>' +
             '<button class="wv-retry" data-retry="' + esc(r.id) + '" title="' + esc(why) +
             ' — click to try rendering it again">try again</button>' : '') +
      '<button class="wv-fav' + (fav ? ' wv-fav-on' : '') + '" data-fav="' + esc(r.id) +
      '" title="' + (fav ? 'Un-favorite' : 'Favorite') + '">' + (fav ? '★' : '☆') + '</button>' +
      /* ✕ / ⟲ — take this wig out of the catalogue, or put it back. The mod
         keeps every record; hidden wigs also stop asking for renders. */
      '<button class="wv-hide' + (hid ? ' wv-hide-on' : '') + '" data-hide="' + esc(r.id) +
      '" title="' + (hid ? 'Bring this wig back into the catalogue'
                         : 'Remove this wig from the catalogue (the mod keeps it)') + '">' +
      (hid ? '⟲' : '✕') + '</button>' +
      (hasArt ? '<button class="wv-zoom" data-zoom="' + esc(r.id) + '" title="Bigger look">🔍</button>' : '') +
      (worn ? '<span class="wv-worn-band">worn</span>' : '') +
      '</div>' +
      '<div class="wv-name" title="' + esc(r.name) + '">' + highlight(r.name, ui.q) + '</div>' +
      '<div class="wv-plug" title="' + esc(r.plugin) + '">' + esc(r.plugin) + '</div>' +
      '</div>';
  }

  function rowById(id) {
    for (let i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) return state.rows[i];
    return null;
  }

  /* An emptied body must give its space back to #wv-empty, or it sits there as
     an empty flex:1 column and shoves the hero past the bottom of the deck
     card (measured: the CTA clipped by 17px at 1280x720). The CSS half is
     #wv-body.wv-body-idle. */
  function setBodyIdle(body, on) {
    if (body && body.classList) body.classList.toggle('wv-body-idle', !!on);
  }

  function renderBody() {
    const body = $('wv-body');
    const empty = $('wv-empty');
    if (!body || !empty) return;

    /* index not answered yet: skeleton tiles sized like the real thing */
    if (!state.ready) {
      setBodyIdle(body, false);
      body.innerHTML = '<div class="wv-grid">' + new Array(8).fill(
        '<div class="wv-tile wv-skel"><div class="wv-art wv-skel-box"></div>' +
        '<span class="wv-skel-box wv-skel-w1"></span>' +
        '<span class="wv-skel-box wv-skel-w2"></span></div>').join('') + '</div>';
      empty.classList.add('hidden');
      return;
    }

    /* hero — no wig mods registered yet */
    if (!state.mods.length) {
      setBodyIdle(body, true);
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="wv-hero">' +
        '<div class="wv-hero-glyph">💇</div>' +
        '<div class="wv-hero-title">Every wig, rendered, one click to wear</div>' +
        '<div class="wv-hero-sub">Register a wig mod — KS Hairdos, Salt &amp; Wind, any esp/esl that ships ' +
        'wearable hair — and its whole catalogue lands here as pictures. The renders are baked once and ' +
        'remembered, search finds any of them, ★ keeps your favourites, and tabs sort them however you like.</div>' +
        '<button class="wv-hero-add" id="wv-hero-add">＋ Add your first wig mod</button>' +
        '</div>';
      const b = $('wv-hero-add');
      if (b) b.addEventListener('click', openPicker);
      return;
    }

    /* Anywhere but the Hidden view, a hidden wig is simply not there. The page
       it was on renders one tile shorter rather than back-filling from the next
       page: the query is C++-paged, and quietly changing what a page contains
       would make the pager lie about where you are. */
    const rows = ui.view === 'hidden'
      ? state.rows
      : state.rows.filter(function (r) { return !isHidden(r.id); });

    if (!rows.length) {
      setBodyIdle(body, true);
      body.innerHTML = '';
      empty.classList.remove('hidden');
      if (state.awaiting) {
        empty.innerHTML = '<div class="wv-empty-title">Searching…</div>';
      } else if (ui.view === 'fav' && !state.user.favs.length) {
        empty.innerHTML = '<div class="wv-empty-title">No favorites yet</div>' +
          '<div class="wv-empty-sub">Hover any wig and hit ☆ — it lands here.</div>';
      } else if (ui.view !== 'hidden' && state.rows.length) {
        /* the page had wigs — you hid all of them; say so instead of claiming
           nothing matches, which would read as a broken search */
        empty.innerHTML = '<div class="wv-empty-title">Every wig on this page is hidden</div>' +
          '<div class="wv-empty-sub">Open <b>⊘ Hidden</b> to bring any of them back.</div>';
      } else if (currentTab() && !currentTab().ids.length) {
        empty.innerHTML = '<div class="wv-empty-title">Nothing filed under “' + esc(currentTab().name) + '” yet</div>' +
          '<div class="wv-empty-sub">Right-click any wig → “Add to ' + esc(currentTab().name) + '”.</div>';
      } else if (ui.q) {
        empty.innerHTML = '<div class="wv-empty-title">Nothing matches</div>' +
          '<div class="wv-empty-sub">No wig called “' + esc(ui.q) + '”' +
          (ui.mod ? ' in ' + esc(ui.mod) : '') +
          (ui.view !== 'all' ? ' in this tab' : '') +
          '. Try fewer letters' + (ui.mod ? ', or clear the mod chip' : '') + '.</div>';
      } else {
        /* Zero rows with an EMPTY box is not a failed search — it is a
           registered mod that shipped nothing here (not in the load order, or
           no hair-slot records). Saying “No wig called “”” read as a bug at
           exactly the moment the honest reason mattered. */
        empty.innerHTML = '<div class="wv-empty-title">No wigs here yet</div>' +
          '<div class="wv-empty-sub">' +
          (ui.mod ? esc(ui.mod) + ' has nothing to show — it may not be in the load order, or its ' +
                    'hair sits on an odd slot (right-click its chip → “Show everything it ships”). ' +
                    'Clear the mod chip to look at every registered mod.'
                  : 'Your registered mods returned nothing. Check they are still in the load order, ' +
                    'or add another with ＋ Add a wig mod…') +
          '</div>';
      }
      return;
    }
    empty.classList.add('hidden');
    setBodyIdle(body, false);

    let html = '';
    const showHint = firstOpenHint();
    if (showHint)
      html += '<div class="wv-firsthint">✨ First time seeing these — rendering their art in the ' +
        'background. Tiles fill in as it lands.</div>';
    html += '<div class="wv-grid">' + rows.map(function (r, i) { return tileHtml(r, i); }).join('') + '</div>';
    body.innerHTML = html;

    /* wire tiles */
    body.querySelectorAll('.wv-tile:not(.wv-skel)').forEach(function (tile) {
      const id = tile.getAttribute('data-id');
      tile.addEventListener('click', function (e) {
        if (e.target.closest && (e.target.closest('.wv-fav') || e.target.closest('.wv-zoom'))) return;
        const r = rowById(id);
        if (r) useWig(r, 'wear');
      });
      tile.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        const r = rowById(id);
        if (r) tileCtx(ev, r);
      });
      const fav = tile.querySelector('.wv-fav');
      if (fav) fav.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = rowById(id);
        if (r) toggleFav(r);
      });
      const zoom = tile.querySelector('.wv-zoom');
      if (zoom) zoom.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = rowById(id);
        if (r) openLightbox(r);
      });
      const hide = tile.querySelector('.wv-hide');
      if (hide) hide.addEventListener('click', function (e) {
        e.stopPropagation();   // the tile WEARS the wig — hiding must never do that
        setHidden(id, !isHidden(id));
      });
      const again = tile.querySelector('.wv-retry');
      if (again) again.addEventListener('click', function (e) {
        e.stopPropagation();   // the tile itself WEARS the wig — never on a retry
        retryArt(id);
      });
    });

    scheduleIconWork();
    updateRenderChip();
  }

  function renderBodyPreservingScroll() {
    const body = $('wv-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('wv-body');
    if (b2) b2.scrollTop = top;
  }

  function render() {
    renderHeader();
    renderPills();
    renderMods();
    renderBody();
    renderFooter();
  }

  /* ============================================================= footer == */

  let footEl = null;

  function footHost() {
    const pane = $('wv-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'wv-foot';
      footEl.id = 'wv-foot';
      const body = $('wv-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  function footVisible() {
    if (!state.ready || !state.mods.length) return false;
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('wv-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;
    const multi = pc > 1;

    let html = '';
    if (multi) {
      html += '<button class="wv-foot-nav wv-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="wv-foot-count"><b>' + fmtN(total) + '</b> wig' + (total === 1 ? '' : 's') +
      (multi ? ' · page <b>' + (ui.page + 1) + '</b> / ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="wv-foot-nav wv-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="wv-foot-per" title="Tiles per page — fewer means fewer renders at once">' +
      '<span class="wv-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="wv-foot-size' + (n === ui.pageSize ? ' wv-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('wv-foot-on');

    const prev = foot.querySelector('.wv-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.wv-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.wv-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* ================================================= ctx menus + namer == */

  /* Pane-anchored, scale-safe (the anim-pane popup-audit idiom: #panel is
     transform-scaled, so screen px are divided back into pane px). */

  function closeCtx(keepArm) {
    if (els.ctx) { els.ctx.remove(); els.ctx = null; }
    if (els.namer) { els.namer.remove(); els.namer = null; }
    if (!keepArm) ui.armDelete = '';
  }

  function paneEl() { return $('wv-pane'); }

  function paneXY(ev) {
    const pane = paneEl();
    const r = pane.getBoundingClientRect();
    const sx = r.width ? (pane.offsetWidth / r.width) : 1;
    const sy = r.height ? (pane.offsetHeight / r.height) : 1;
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
  }

  function showCtx(ev, items) {
    closeCtx(true);
    const pane = paneEl();
    if (!pane) return;
    const m = document.createElement('div');
    m.className = 'wv-ctx';
    items.forEach(function (it) {
      if (it === '-') {
        const hr = document.createElement('div');
        hr.className = 'wv-ctx-sep';
        m.append(hr);
        return;
      }
      const b = document.createElement('button');
      b.className = 'wv-ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      if (it.hint) b.title = it.hint;
      b.addEventListener('click', function (e2) { e2.stopPropagation(); it.run(); });
      m.append(b);
    });
    pane.append(m);
    const p = paneXY(ev);
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(p.x, pane.offsetWidth - mw - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(p.y, pane.offsetHeight - mh - 6)) + 'px';
    els.ctx = m;
  }

  function tabCtx(ev, t) {
    const order = state.user.tabs;
    const i = order.findIndex(function (x) { return x.name === t.name; });
    showCtx(ev, [
      { label: '✎ Rename…', run: function () {
          const b = $('wv-pills') && $('wv-pills').querySelector('.wv-pill-user[data-tab="' + cssEsc(t.name) + '"]');
          closeCtx();
          openNamer(b, t, null);
        } },
      { label: '⇤ Move left', run: function () {
          if (i > 0) { const m = order.splice(i, 1)[0]; order.splice(i - 1, 0, m); saveAll(); renderPills(); }
          closeCtx();
        } },
      { label: '⇥ Move right', run: function () {
          if (i < order.length - 1) { const m = order.splice(i, 1)[0]; order.splice(i + 1, 0, m); saveAll(); renderPills(); }
          closeCtx();
        } },
      '-',
      {
        label: ui.armDelete === t.name ? '🗑 Delete “' + t.name + '” — sure?' : '🗑 Delete tab',
        danger: true,
        hint: 'The wigs stay in the catalogue (and in Favorites) — only the tab goes',
        run: function () {
          if (ui.armDelete === t.name) { const n = t.name; deleteTab(n); closeCtx(); toast('tab “' + n + '” deleted', true); }
          else { ui.armDelete = t.name; tabCtx(ev, t); }   // re-open armed
        },
      },
    ]);
  }

  function tileCtx(ev, r) {
    const items = [];
    if (r.missing) {
      /* the only sensible op on a ghost is letting it go */
      const t = currentTab();
      if (ui.view === 'fav') {
        items.push({ label: '✕ Remove from Favorites', run: function () { toggleFav(r); closeCtx(); } });
      } else if (t) {
        items.push({ label: '✕ Remove from “' + t.name + '”', run: function () { removeFromTab(t, r.id); closeCtx(); } });
      }
      if (items.length) showCtx(ev, items);
      return;
    }
    items.push({ label: '💇 Wear', hint: ui.target === 'me' ? 'On your own head' : 'On who you’re looking at',
      run: function () { useWig(r, 'wear'); closeCtx(); } });
    items.push({ label: '🦲 Take off', hint: 'Unequip it from the current target',
      run: function () { useWig(r, 'strip'); closeCtx(); } });
    items.push({ label: '🎒 Take into inventory', run: function () { useWig(r, 'take'); closeCtx(); } });
    /* ---- enforce it permanently (2026-08-20) --------------------------
       "Wear" lasts until something in the game undresses her; a SPID grant
       hands it back at every launch, forever. That is the whole reason the
       grant machinery exists ("enforce items (like wigs, etc)"), and until
       now the only way to set one up was to walk to her with the wig in your
       pocket and open a chest. The grant is made by IDENTITY here — the wig
       need not be in anyone's inventory.
       Only offered against a real person: enforcing something on YOURSELF is
       not what SPID does (it distributes to NPCs), so the row says so rather
       than quietly granting to the wrong target. */
    if (window.WardrobeSpid && typeof WardrobeSpid.enforce === 'function') {
      const parts = idParts(r.id);
      const look = ui.target === 'look';
      items.push({
        label: '🔒 Enforce forever (SPID)',
        hint: look
          ? 'She is handed it at every launch — manage it under Wardrobe → SPID'
          : 'Aim at someone first: SPID distributes to NPCs, not to you',
        run: function () {
          closeCtx();
          if (!look) { toast('Point at someone first — SPID grants go to NPCs, not to you', true); return; }
          if (!parts) { toast('That wig has no plugin identity to enforce', true); return; }
          /* Her runtime id comes from the palette's own crosshair snapshot —
             the same one the F7 card and the NPC tuner read, so all three
             agree on who "who you're looking at" is. The DLL turns it into
             her durable base identity; the view never guesses at that. */
          let who = 0;
          try {
            const t = window.FolPane && FolPane._state && FolPane._state.target;
            who = t ? (Number(t.formId) || 0) >>> 0 : 0;
          } catch (e) { who = 0; }
          if (!who) { toast('Nobody is under your crosshair right now', true); return; }
          const ok = WardrobeSpid.enforce({
            formId: who,
            item: { plugin: parts.plugin, localId: parts.formId, name: r.name || '' },
          });
          if (!ok) toast('Could not enforce that one', true);
        },
      });
    }
    items.push('-');
    items.push({ label: isFav(r.id) ? '★ Un-favorite' : '☆ Favorite', run: function () { toggleFav(r); closeCtx(); } });
    const t = currentTab();
    if (t) {
      items.push({ label: '✕ Remove from “' + t.name + '”', run: function () { removeFromTab(t, r.id); closeCtx(); } });
    } else {
      if (state.user.tabs.length) items.push('-');
      state.user.tabs.forEach(function (tb) {
        if (inTab(tb, r.id))
          items.push({ label: '✓ In “' + tb.name + '” — remove', run: function () { removeFromTab(tb, r.id); closeCtx(); } });
        else
          items.push({ label: '＋ Add to “' + tb.name + '”', run: function () { addToTab(tb, r); closeCtx(); } });
      });
      items.push('-');
      items.push({ label: '＋ New tab with this…', run: function () {
        closeCtx();
        openNamer($('wv-tab-add'), null, r);
      } });
    }
    showCtx(ev, items);
  }

  /* The ＋ popover: name a new tab (or rename `t`). `withRow` lands in the
     fresh tab as its first wig (the tile-menu "New tab with this…" path). */
  function openNamer(anchor, t, withRow) {
    closeCtx();
    const pane = paneEl();
    if (!pane) return;
    const box = document.createElement('div');
    box.className = 'wv-namer';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = MAX_TAB_NAME;
    inp.placeholder = t ? 'Rename tab…' : 'New tab name…';
    inp.value = t ? t.name : '';
    inp.setAttribute('aria-label', inp.placeholder);
    inp.autocomplete = 'off'; inp.spellcheck = false;
    const okB = document.createElement('button');
    okB.textContent = t ? 'Rename' : 'Create';
    const commit = function () {
      const name = inp.value.trim().slice(0, MAX_TAB_NAME);
      if (!name) { closeCtx(); return; }
      if (t) renameTab(t, name);
      else {
        const nt = createTab(name);
        if (nt) {
          if (withRow) addToTab(nt, withRow);
          setView('tab:' + nt.name);
        }
      }
      closeCtx();
    };
    okB.addEventListener('click', commit);
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') closeCtx();
      ev.stopPropagation();
    });
    box.append(inp, okB);
    pane.append(box);
    if (anchor) {
      const pr = pane.getBoundingClientRect();
      const ar = anchor.getBoundingClientRect();
      const sx = pr.width ? (pane.offsetWidth / pr.width) : 1;
      const sy = pr.height ? (pane.offsetHeight / pr.height) : 1;
      box.style.left = Math.max(6, Math.min((ar.left - pr.left) * sx, pane.offsetWidth - box.offsetWidth - 6)) + 'px';
      box.style.top = ((ar.bottom - pr.top) * sy + 6) + 'px';
    } else {
      box.style.left = '20px'; box.style.top = '48px';
    }
    els.namer = box;
    inp.focus();
  }

  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  /* ====================================================== add-mod picker == */

  /* A pane-anchored modal (the ix-sheet idiom) over wvModsData: search-as-you-
     type across every load-order plugin shipping ≥1 hair-slot wig, counts on
     every row, Enter adds the top not-yet-added hit, already-added rows are
     marked and stay put (so a second add is a visible no-op, not a mystery). */

  function openPicker() {
    ui.picker = { q: '', mods: [], sel: 0, debT: null };
    const sh = $('wv-picker');
    if (!sh) return;
    sh.classList.remove('hidden');
    sh.innerHTML =
      '<div class="wv-picker-card">' +
      '<div class="wv-picker-title">Add a wig mod' +
      '<button class="wv-picker-x" id="wv-picker-x" title="Close (Esc)">✕</button></div>' +
      '<div class="wv-picker-sub">Every plugin in the load order that ships wearable hair. ' +
      'Type to narrow — Enter registers the top hit.</div>' +
      '<div class="wv-picker-bar"><span class="wv-bar-glyph">⌕</span>' +
      '<input id="wv-picker-q" type="text" placeholder="esp / esl / esm name…" autocomplete="off" spellcheck="false"></div>' +
      '<div id="wv-picker-rows" class="wv-picker-rows"><div class="wv-picker-note">Looking for wig mods…</div></div>' +
      '</div>';
    $('wv-picker-x').addEventListener('click', closePicker);
    sh.addEventListener('click', function (e) { if (e.target === sh) closePicker(); });
    const q = $('wv-picker-q');
    q.addEventListener('input', function () {
      if (!ui.picker) return;
      ui.picker.q = q.value.trim();
      ui.picker.sel = 0;
      if (ui.picker.debT) clearTimeout(ui.picker.debT);
      ui.picker.debT = setTimeout(function () {
        if (ui.picker) toGame('wvMods', JSON.stringify({ q: ui.picker.q }));
      }, PICKER_DEBOUNCE_MS);
    });
    q.addEventListener('keydown', function (e) {
      if (!ui.picker) return;
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const cands = ui.picker.mods.filter(function (m) { return !m.added && !modByPlugin(m.plugin); });
        const pick = cands[Math.min(ui.picker.sel, cands.length - 1)] || cands[0];
        if (pick) pickerAdd(pick);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = ui.picker.mods.filter(function (m) { return !m.added && !modByPlugin(m.plugin); }).length;
        if (n) {
          ui.picker.sel = e.key === 'ArrowDown'
            ? Math.min(n - 1, ui.picker.sel + 1) : Math.max(0, ui.picker.sel - 1);
          renderPickerRows();
        }
        e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker();
      }
    });
    toGame('wvMods', JSON.stringify({ q: '' }));
    setTimeout(function () { const i = $('wv-picker-q'); if (i) i.focus(); }, 30);
  }

  function closePicker() {
    if (ui.picker && ui.picker.debT) clearTimeout(ui.picker.debT);
    ui.picker = null;
    const sh = $('wv-picker');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; }
    const s = $('wv-search');
    if (s) s.focus();
  }

  function pickerAdd(m) {
    addMod(m.plugin, m.count);
    m.added = true;
    renderPickerRows();
    toast('“' + m.plugin + '” registered — ' + fmtN(m.count) + ' wigs joined the gallery');
  }

  function renderPickerRows() {
    const box = $('wv-picker-rows');
    if (!box || !ui.picker) return;
    const mods = ui.picker.mods;
    if (!mods.length) {
      box.innerHTML = '<div class="wv-picker-note">' +
        (ui.picker.q ? 'No plugin matches “' + esc(ui.picker.q) + '”. Fewer letters?'
          : 'No load-order plugin ships hair-slot wigs.') + '</div>';
      return;
    }
    let selIdx = -1;
    box.innerHTML = mods.map(function (m) {
      const added = m.added || !!modByPlugin(m.plugin);
      if (!added) selIdx++;
      const sel = !added && selIdx === ui.picker.sel;
      return '<div class="wv-picker-row' + (added ? ' wv-picker-added' : '') + (sel ? ' wv-sel' : '') +
        '" data-plug="' + esc(m.plugin) + '" title="' +
        (added ? esc(m.plugin) + ' is already registered' : 'Register ' + esc(m.plugin)) + '">' +
        '<span class="wv-picker-name">' + highlight(m.plugin, ui.picker.q) + '</span>' +
        '<span class="wv-picker-n">' + fmtN(m.count) + ' wig' + ((m.count | 0) === 1 ? '' : 's') + '</span>' +
        (added ? '<span class="wv-picker-chip">✓ added</span>'
          : '<span class="wv-picker-go">＋ Add</span>') +
        '</div>';
    }).join('');
    box.querySelectorAll('.wv-picker-row:not(.wv-picker-added)').forEach(function (row) {
      row.addEventListener('click', function () {
        const plug = row.getAttribute('data-plug');
        for (let i = 0; i < mods.length; i++)
          if (mods[i].plugin === plug) { pickerAdd(mods[i]); return; }
      });
    });
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('wv-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('wv-toast-err', !!err);
    t.classList.add('wv-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('wv-toast-show'); }, 2600);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    /* onHide only runs on a TAB SWITCH (app.js closes the deck without one),
       so a menu left open when the deck closed would still be mounted here.
       Nothing survives an open. */
    closeCtx();
    toGame('wvState');   // first call builds the C++ wig index; later calls refresh mods/counts
    const s = $('wv-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
    closePicker();
    closeCtx();
    if (window.HDLightbox) HDLightbox.close();
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (renderChip) renderChip.classList.remove('wv-on');
    stopIconPoll();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the bar pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.mod = '';
    ui.view = 'all';
    const s = $('wv-search');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  function init() {
    const s = $('wv-search');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        queryDebounced();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Enter WEARS the top hit and STAYS OPEN — with no results it
             no-ops (never leaks to the deck's global handler). */
          e.preventDefault();
          e.stopPropagation();
          const r = state.rows[Math.min(ui.sel, state.rows.length - 1)] || state.rows[0];
          if (r) useWig(r, 'wear');
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
                   e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          /* a GRID: ←→ step one tile, ↑↓ jump a visual row (measured columns) */
          if (state.rows.length) {
            const cols = gridCols();
            let d = 0;
            if (e.key === 'ArrowRight') d = 1;
            else if (e.key === 'ArrowLeft') d = -1;
            else if (e.key === 'ArrowDown') d = cols;
            else d = -cols;
            ui.sel = Math.max(0, Math.min(state.rows.length - 1, ui.sel + d));
            renderBodyPreservingScroll();
            const el = document.querySelector('#wv-body .wv-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
          if (!ui.picker && footVisible() && pageCount() > 1) {
            gotoPage(ui.page + (e.key === 'PageDown' ? 1 : -1));
            e.preventDefault();
            e.stopPropagation();
          }
        } else if (e.key === 'Escape') {
          /* peel back: picker → menus → query → mod chip → (palette close) */
          if (ui.picker) { closePicker(); e.stopPropagation(); }
          else if (els.ctx || els.namer) { closeCtx(); e.stopPropagation(); }
          else if (s.value) { s.value = ''; ui.q = ''; runQuery(true); e.stopPropagation(); }
          else if (ui.mod) { clearMod(); e.stopPropagation(); }
          /* bare Esc falls through to the palette's close, on purpose */
        } else if (e.key === 'Backspace' && !s.value && ui.mod) {
          clearMod();
          e.stopPropagation();
        }
      });
    }

    /* ⛔ Escape must reach the OPEN MENU, wherever focus is. The peel-back in
       #wv-search's keydown only fires while that box has focus, and
       right-clicking a tile takes focus off it — so Escape went to the deck's
       global close, the palette shut, and the menu (never told) was still in
       the DOM, sitting over the gallery the next time the deck opened.
       Document + CAPTURE is the deck's sanctioned way to claim a key
       (app.js's Escape branch only ARMS hdEscFallback and lets the event
       travel; stopPropagation here means nothing ever closes the palette). */
    try {
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (!els.ctx && !els.namer) return;
        closeCtx();
        ev.preventDefault();
        ev.stopPropagation();
      }, true);
    } catch (e) { /* no DOM in some harnesses */ }

    /* click-away closes context menus / the namer (anim-pane idiom) */
    try {
      document.addEventListener('mousedown', function (ev) {
        if (els.ctx && !els.ctx.contains(ev.target)) closeCtx();
        else if (els.namer && !els.namer.contains(ev.target)) closeCtx();
        if (ui.armUnreg && !(ev.target.closest && ev.target.closest('[data-unreg]'))) {
          ui.armUnreg = '';
          if (ui.visible) renderMods();
        }
      });
    } catch (e) { /* no DOM in some harnesses */ }

    /* A render batch landed (WardrobePane pushed a new index and fired the
       shared event) — upgrade tiles in place. Bounded to on-screen. */
    try {
      document.addEventListener('hd-item-icons', function () {
        if (!ui.visible) return;
        chipLastLand = Date.now();      // a render landed — keep the window open
        dismissHintIfDone();
        renderBodyPreservingScroll();
      });
    } catch (e) { /* ignore */ }

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* Measured grid columns for ↑↓ nav — jsdom (no layout) degrades to 4. */
  function gridCols() {
    const grid = document.querySelector('#wv-body .wv-grid');
    if (!grid || !grid.children.length) return 4;
    const first = grid.children[0].getBoundingClientRect();
    if (!first.width) return 4;
    let cols = 0;
    const top = first.top;
    for (let i = 0; i < grid.children.length; i++) {
      const r = grid.children[i].getBoundingClientRect();
      if (Math.abs(r.top - top) < 2) cols++;
      else break;
    }
    return Math.max(1, cols);
  }

  /* =============================================================== dev == */

  const DEV_MODS = [
    { plugin: 'KS Hairdos.esp', count: 887, added: false },
    { plugin: 'SaltAndWind.esp', count: 112, added: false },
    { plugin: 'HG Hairdos.esp', count: 340, added: false },
  ];
  const DEV_ROWS = [
    { id: 'KS Hairdos.esp|012345', plugin: 'KS Hairdos.esp', formId: '0x012345', name: 'Wig - Anne', slot: 31, val: 25, wt: 0.5 },
    { id: 'KS Hairdos.esp|012346', plugin: 'KS Hairdos.esp', formId: '0x012346', name: 'Wig - Bella Long', slot: 31, val: 25, wt: 0.5 },
    { id: 'SaltAndWind.esp|000801', plugin: 'SaltAndWind.esp', formId: '0x000801', name: 'Windswept Braid', slot: 31, val: 30, wt: 0.4 },
  ];

  function devState() {
    window.wvStateResult({
      ready: true,
      mods: state.mods.length ? state.mods
        : [{ plugin: 'KS Hairdos.esp', present: true, all: false, count: 887 }],
      view: null,
    });
  }

  function devMods(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    window.wvModsData({
      mods: DEV_MODS.filter(function (m) {
        return !q || m.plugin.toLowerCase().indexOf(q) !== -1;
      }).map(function (m) {
        return { plugin: m.plugin, count: m.count, added: !!modByPlugin(m.plugin) };
      }),
    });
  }

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    let rows;
    if (Array.isArray(req.ids)) {
      rows = req.ids.map(function (id) {
        for (let i = 0; i < DEV_ROWS.length; i++) if (DEV_ROWS[i].id === id) return DEV_ROWS[i];
        return { id: id, missing: true, plugin: String(id).split('|')[0] };
      });
    } else {
      rows = DEV_ROWS.filter(function (r) {
        if (req.mod && r.plugin !== req.mod) return false;
        return !q || r.name.toLowerCase().indexOf(q) !== -1;
      });
    }
    if (q && Array.isArray(req.ids)) {
      rows = rows.filter(function (r) { return r.missing || r.name.toLowerCase().indexOf(q) !== -1; });
    }
    window.wvResultData({
      total: rows.length,
      offset: req.offset | 0,
      rows: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || DEFAULT_PAGE_SIZE)),
    });
  }

  function devUse(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.wvUseResult({ ok: true, id: req.id, op: req.op,
      msg: req.op === 'wear' ? 'Worn' : req.op === 'strip' ? 'Taken off' : 'Taken' });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    ui.visible = true;
    window.wvStateResult({ ready: true,
      mods: [{ plugin: 'KS Hairdos.esp', present: true, all: false, count: 887 }],
      view: { favs: [], tabs: [], pageSize: 24, target: 'me', lastPill: 'all' } });
    ok('state: ready with one mod', state.ready && state.mods.length === 1);

    window.wvResultData({ total: 3, offset: 0, rows: DEV_ROWS.slice() });
    render();
    ok('tiles: page rendered', document.querySelectorAll('#wv-body .wv-tile').length === 3);

    const r0 = state.rows[0];
    toggleFav(r0);
    ok('fav: id recorded', isFav(r0.id));
    const t = createTab('Braids');
    ok('tab: created', !!t && state.user.tabs.length === 1);
    addToTab(t, state.rows[2]);
    ok('tab: membership', inTab(t, state.rows[2].id));
    ok('blob: shape', (function () {
      const v = viewBlob();
      return Array.isArray(v.favs) && Array.isArray(v.tabs) && v.tabs[0].name === 'Braids' &&
        typeof v.pageSize === 'number' && (v.target === 'me' || v.target === 'look') &&
        typeof v.lastPill === 'string';
    })());
    deleteTab('Braids');
    toggleFav(r0);

    /* ---- hide / restore one wig (2026-08-15) ---- */
    (function () {
      const id = state.rows[0].id;
      const before = document.querySelectorAll('#wv-body .wv-tile').length;
      setHidden(id, true);
      ok('hide: the wig leaves the catalogue view',
        document.querySelectorAll('#wv-body .wv-tile').length === before - 1);
      ok('hide: it is remembered in the view blob', viewBlob().hidden.indexOf(id) !== -1);
      ok('hide: a hidden wig is not counted as pending art', !rowLoading({ id: id, missing: false }));
      const pills = $('wv-pills') ? $('wv-pills').textContent : '';
      ok('hide: the Hidden pill appears with a count', pills.indexOf('Hidden') !== -1);
      setView('hidden');
      ok('hide: the Hidden view queries the hidden ids', viewIds() === state.user.hidden);
      setView('all');
      setHidden(id, false);
      ok('restore: it comes straight back',
        document.querySelectorAll('#wv-body .wv-tile').length === before &&
        viewBlob().hidden.indexOf(id) === -1);
    })();

    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90%;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    if (document.body) document.body.append(box);
    /* headless runners read this (the <pre> above is for a browser open) */
    window.__wvSelftest = { pass: out.length - fails.length, total: out.length, results: out };
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (settlement-pane idiom) --------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'wigs', label: 'Wigs', tab: 'wigs',
    setFilter: setFilter,
    index: function () {
      const out = [{
        label: 'Wigs',
        detail: 'rendered wig catalogue — add a mod, wear a wig',
        kind: 'wigs',
        keywords: 'wig wigs hair hairdo hairstyle ks hairdos salt wind wear head',
      }];
      state.mods.forEach(function (m) {
        out.push({
          label: m.plugin,
          detail: fmtN(m.count) + ' wigs — registered wig mod',
          kind: 'wigs',
          keywords: 'wig mod ' + m.plugin,
        });
      });
      state.user.favs.forEach(function (id) {
        const name = state.names[id];
        if (name) out.push({
          label: name,
          detail: '★ favorite wig',
          kind: 'wigs',
          keywords: 'wig favorite ' + name,
        });
      });
      return out;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _flushIcons: flushIconsForTest, _iconPollTick: iconPollTick, _missingArt: missingArt,
    _state: state, _ui: ui,
    _rowLoading: rowLoading, _renderWindowActive: renderWindowActive,
    _armWindow: function () { chipLastLand = Date.now(); },
    _closeWindow: function () { chipLastLand = 1; },   // far past => window shut
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _viewBlob: viewBlob, _applyViewBlob: applyViewBlob, _saveAll: saveAll,
    _toggleFav: toggleFav, _isFav: isFav,
    _createTab: createTab, _renameTab: renameTab, _deleteTab: deleteTab,
    _addToTab: addToTab, _removeFromTab: removeFromTab, _tabByName: tabByName, _inTab: inTab,
    _setView: setView, _setMod: setMod, _clearMod: clearMod, _setTarget: setTarget,
    _useWig: useWig, _openPicker: openPicker, _closePicker: closePicker, _pickerAdd: pickerAdd,
    _addMod: addMod, _removeMod: removeMod, _toggleModAll: toggleModAll, _modByPlugin: modByPlugin,
    _tileCtx: tileCtx, _tabCtx: tabCtx, _closeCtx: closeCtx, _els: els,
    _openLightbox: openLightbox, _runQuery: runQuery,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.WigsPane.init(); });
} else {
  window.WigsPane.init();
}
