'use strict';

/* ====================================================================== *
 *  Settlement — the inline world-object placer (Rober's ask: place any
 *  static / furniture / activator the load order ships, build a camp,
 *  keep named catalogs of favourites, and drive Campfire + Hunterborn
 *  through their own machinery).
 *
 *  The Items tab's structural twin. C++ owns the index, the matching, the
 *  placement verbs and the catalog/placement sidecar (settlement.cpp); this
 *  pane owns the ONE bar, the pills, the plugin chip-in-bar browse, the
 *  catalog rail, the Campfire category tree, the placement verb buttons and
 *  the "My placements" roster.
 *
 *  Bridge — requests: stState() · stQuery(json) · stAct(json) · stSpin(json)
 *    · stSave(json) · stCat(json) · stPlaced(json)
 *  Replies (disjoint, per the deck law): stStateResult · stResultData ·
 *    stActResult (physical ops push NO reply — C++ closes the palette) ·
 *    stSaved · stCatResult · stPlacedResult. Row art rides the SHARED item
 *    icon route: whIcons -> DOM event 'hd-item-icons', dir icons/items/.
 *
 *  Host contract (mirrors ItemsPane): SettlementPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 *
 *  marker: settlement-pane.js
 * ====================================================================== */

window.SettlementPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;

  /* Statics/furniture are the cheaper 512px item renders, so this pane
     paginates like item-explorer (25 default), never the NPC face default. */
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;

  /* ============================================================== kinds == */

  /* kind key -> [label, glyph]. Order = the pill row. 'all' and 'mods' are
     pseudo-kinds the C++ never sees ('mods' searches plugin names only);
     'camp' is a client-only pill that scopes to the Campfire category tree. */
  const KINDS = [
    ['all',  'Everything', '⌕'],
    ['mods', 'Mods',       '📦'],
    ['stat', 'Statics',    '🪨'],
    ['mstt', 'Movable',    '📦'],
    ['furn', 'Furniture',  '🪑'],
    ['cont', 'Containers', '🧰'],
    ['acti', 'Activators', '⚙'],
    ['tree', 'Trees',      '🌲'],
    ['flor', 'Flora',      '🌿'],
    ['door', 'Doors',      '🚪'],
    ['ligh', 'Lights',     '🕯'],
  ];

  function kindMeta(t) {
    for (let i = 0; i < KINDS.length; i++) if (KINDS[i][0] === t) return KINDS[i];
    return ['stat', 'Object', '❖'];
  }

  /* The Campfire category tree, fixed sub-buckets (recon 2 grouping). A
     Campfire item row carries `sub` = one of these keys; Tentapalooza items
     fold into the matching bucket when tentapalooza is present. */
  const CAMP_SUBS = [
    ['shelter', 'Shelter', '⛺'],
    ['fire',    'Fire',    '🔥'],
    ['cooking', 'Cooking', '🍲'],
    ['furn',    'Furniture', '🪑'],
    ['light',   'Light',   '🕯'],
    ['storage', 'Storage', '🧰'],
    ['shrines', 'Shrines', '🕯'],
    ['misc',    'Misc',    '❖'],
  ];
  function campSubMeta(s) {
    for (let i = 0; i < CAMP_SUBS.length; i++) if (CAMP_SUBS[i][0] === s) return CAMP_SUBS[i];
    return ['misc', 'Misc', '❖'];
  }

  /* ============================================================== state == */

  const state = {
    ready: false,
    count: 0,
    plugins: [],       // [{n,c,k,l}]
    catalogs: [],      // [{id,name,count}] — user catalogs, rail order
    campfire: { present: false, unleashed: false, tentapalooza: false },
    hunterborn: { present: false },
    seq: 0,
    total: 0,
    items: [],         // current page rows (never accumulates)
    awaiting: false,
    building: false,   // the C++ index walk is in flight (per-stage pushes)
    progress: 0,       // 0..1 while building
    stage: '',         // the stage being walked ("furniture", "camp gear", …)
    placed: null,      // "My placements" roster [{id,name,kind,cell}] or null (not asked)
    importFiles: null, // [{name,itemCount,file}] from importscan, or null
  };

  const ui = {
    q: '',
    type: 'all',
    plugin: '',
    catScope: '',      // catalog id the rail is scoping to, or '' (no scope)
    campSub: '',       // Campfire subcategory scope, or '' (whole tree)
    sel: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    page: 0,
    visible: false,
    debT: null,
    toastT: null,
    iconReq: {},
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
    hintSeen: false,
    catEditing: '',    // 'new' | catId while the inline name editor is up
    catFilter: '',     // filter-as-you-type over catalogs (8+)
    dragId: '',        // row id being dragged onto a catalog chip
    catMenu: null,
    placedView: false, // My placements sub-view toggle
    placedFilter: '',  // filter-as-you-type over My placements (8+)
    omoAbsent: false,  // set true when a move refusal says OMO isn't loaded
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'stState') setTimeout(devState, 30);
      if (DEV && fn === 'stQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'stAct') setTimeout(function () { devAct(arg); }, 30);
      if (DEV && fn === 'stSave') setTimeout(function () { devSave(arg); }, 30);
      if (DEV && fn === 'stCat') setTimeout(function () { devCat(arg); }, 30);
      if (DEV && fn === 'stPlaced') setTimeout(function () { devPlaced(arg); }, 30);
    }
  }

  window.stStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.phase === 'ready';
    /* While C++ walks the load order it pushes one of these PER STAGE, so the
       pane can show real progress instead of a dead screen for ~3 seconds
       (Rober, 2026-08-15: "took a while to load - thought i crashed"). */
    state.building = d.phase === 'building';
    if (typeof d.progress === 'number') state.progress = Math.max(0, Math.min(1, d.progress));
    if (typeof d.stage === 'string') state.stage = d.stage;
    state.count = d.count | 0;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) ui.pageSize = clampPageSize(d.pageSize);
    state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
    state.catalogs = Array.isArray(d.catalogs) ? d.catalogs : [];
    if (d.campfire && typeof d.campfire === 'object') {
      state.campfire.present = !!d.campfire.present;
      state.campfire.unleashed = !!d.campfire.unleashed;
      state.campfire.tentapalooza = !!d.campfire.tentapalooza;
    }
    if (d.hunterborn && typeof d.hunterborn === 'object') state.hunterborn.present = !!d.hunterborn.present;
    if (ui.visible) {
      if (state.ready && hasQuery() && !state.items.length && !state.awaiting) runQuery(true);
      render();
    }
  };

  window.stResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
    state.items = Array.isArray(d.items) ? d.items : [];
    if (!state.items.length && state.total > 0 && ui.page > 0 &&
        ui.page * ui.pageSize >= state.total) {
      ui.page = Math.max(0, Math.ceil(state.total / ui.pageSize) - 1);
      runQuery(false);
      return;
    }
    ui.sel = 0;
    if (ui.visible) render();
  };

  window.stActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    /* Physical ops (place/campplace/move/jumpto/remove) close the palette and
       push no reply; only a RESOLVE refusal (missing base, OMO-absent hint)
       or a fast non-physical reply lands here. */
    if (d.omo === false) ui.omoAbsent = true;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (ui.visible && ui.placedView) refreshPlaced();
  };

  window.stSaved = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) {
      const p = clampPageSize(d.pageSize);
      if (p !== ui.pageSize) { ui.pageSize = p; ui.page = 0; if (ui.visible) { runQuery(false); return; } }
    }
    if (ui.visible) { renderBody(); renderFooter(); }
  };

  window.stCatResult = function (d) {
    if (!d || typeof d !== 'object') return;
    /* importscan reply — a list of shareable catalog files on disk */
    if (Array.isArray(d.files)) {
      state.importFiles = d.files;
      if (ui.visible) openImportPicker();
      return;
    }
    /* an export wrote a file */
    if (typeof d.path === 'string' && d.op === 'export') {
      toast(d.ok ? ('Exported to ' + shortPath(d.path)) : (d.msg || 'Export failed'), !d.ok);
      return;
    }
    /* an import created a catalog */
    if (d.op === 'import') {
      toast(d.ok ? ('Imported ' + (d.imported | 0) + ' item' + ((d.imported | 0) === 1 ? '' : 's') +
        (d.missing ? ' · ' + (d.missing | 0) + ' from missing mods' : '')) : (d.msg || 'Import failed'), !d.ok);
    }
    /* every catalog mutation returns the fresh catalog list */
    if (Array.isArray(d.catalogs)) state.catalogs = d.catalogs;
    if (typeof d.msg === 'string' && d.op !== 'export' && d.op !== 'import') toast(d.msg, !d.ok);
    if (ui.visible) render();
  };

  window.stPlacedResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.placed = Array.isArray(d.items) ? d.items : [];
    if (ui.visible && ui.placedView) render();
  };

  function shortPath(p) {
    const s = String(p || '');
    const i = s.replace(/\\/g, '/').lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
  }

  /* ============================================================ queries == */

  function hasQuery() {
    return !!ui.q || !!ui.plugin || ui.type !== 'all' || !!ui.catScope || ui.type === 'camp';
  }

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

  function runQuery(reset) {
    if (reset) { ui.page = 0; chipLastLand = Date.now(); }
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!hasQuery()) {
      state.items = []; state.total = 0; state.awaiting = false; ui.page = 0;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    ui.sel = 0;
    /* `cat` scopes to a user catalog id; a Campfire pill scopes via cat='camp'
       plus the subcategory in `sub`. C++ treats an empty cat as no scope. */
    let cat = '';
    if (ui.catScope) cat = ui.catScope;
    else if (ui.type === 'camp') cat = 'camp';
    toGame('stQuery', JSON.stringify({
      q: ui.q,
      type: (ui.type === 'mods' || ui.type === 'camp') ? 'all' : ui.type,
      plugin: ui.plugin, cat: cat, sub: ui.type === 'camp' ? ui.campSub : '',
      limit: ui.pageSize, offset: ui.page * ui.pageSize, seq: state.seq,
    }));
    render();
  }

  function pageCount() {
    if (ui.pageSize <= 0) return 1;
    return Math.max(1, Math.ceil((state.total || 0) / ui.pageSize));
  }

  function gotoPage(p) {
    const pc = pageCount();
    p = Math.max(0, Math.min(pc - 1, Math.round(p) || 0));
    if (p === ui.page) return;
    ui.page = p;
    chipLastLand = Date.now();
    runQuery(false);
    const body = $('st-body');
    if (body) body.scrollTop = 0;
    const s = $('st-bar');
    if (s) s.focus();
  }

  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    toGame('stSave', JSON.stringify({ pageSize: ui.pageSize }));
    runQuery(false);
  }

  function queryDebounced() {
    if (ui.debT) clearTimeout(ui.debT);
    ui.debT = setTimeout(function () { ui.debT = null; runQuery(true); }, DEBOUNCE_MS);
  }

  function modMatches(limit) {
    const toks = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < state.plugins.length; i++) {
      const p = state.plugins[i];
      const low = String(p.n || '').toLowerCase();
      let ok = true;
      for (let t = 0; t < toks.length; t++) if (low.indexOf(toks[t]) === -1) { ok = false; break; }
      if (ok) out.push(p);
    }
    out.sort(function (a, b) { return (b.c | 0) - (a.c | 0); });
    return out.slice(0, limit);
  }

  /* ====================================================== selection model == */

  function flatRows() {
    const rows = [];
    if (showsModSection()) {
      modMatches(ui.type === 'mods' ? 30 : 5).forEach(function (p) { rows.push({ kind: 'plug', p: p }); });
    }
    if (ui.type !== 'mods') {
      state.items.forEach(function (it) { rows.push({ kind: 'item', it: it }); });
    }
    return rows;
  }

  function showsModSection() {
    if (ui.plugin) return false;
    if (ui.type === 'mods') return true;
    return ui.type === 'all' && !!ui.q && !ui.catScope;
  }

  /* Enter = Place the top hit (Campfire rows place via campplace). */
  function activate(row) {
    if (!row) return;
    if (row.kind === 'plug') { setPlugin(row.p.n); return; }
    if (row.kind === 'item') doPlace(row.it);
  }

  /* ============================================================= actions == */

  function act(payload) { toGame('stAct', JSON.stringify(payload)); }

  function isCampRow(it) { return !!(it && it.camp); }

  function doPlace(it) {
    if (!it) return;
    act({ id: it.id, op: isCampRow(it) ? 'campplace' : 'place' });
    /* physical op: C++ closes the palette; a toast only shows if it refused
       to resolve (stActResult) — no optimistic success message. */
  }
  function doMove(it) { if (it) act({ id: it.id, op: 'move' }); }
  function doRemove(it) { if (it) act({ id: it.id, op: 'remove' }); }
  function doJumpTo(pl) { if (pl) act({ id: pl.id, op: 'jumpto' }); }
  function doRemovePlaced(pl) { if (pl) act({ id: pl.id, op: 'remove' }); }

  function setPlugin(name) {
    ui.plugin = String(name || '');
    ui.q = '';
    ui.catScope = '';
    const s = $('st-bar');
    if (s) { s.value = ''; s.focus(); }
    if (ui.type === 'mods' || ui.type === 'camp') ui.type = 'all';
    runQuery(true);
  }

  function clearPlugin() {
    ui.plugin = '';
    runQuery(true);
    const s = $('st-bar');
    if (s) s.focus();
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
  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  /* ============================================================== icons == */

  /* Real object renders through the SHARED item icon route (WardrobePane +
     the 'hd-item-icons' event, dir icons/items/). A row id is
     "Plugin.esp|HEX6". Reuse the Items tab's exact resolution — never a
     stIcons bridge. */
  function idParts(id) {
    const s = String(id || '');
    const bar = s.lastIndexOf('|');
    if (bar === -1) return null;
    const plugin = s.slice(0, bar);
    const hex = s.slice(bar + 1);
    if (!plugin || !hex) return null;
    return { formId: '0x' + hex, plugin: plugin };
  }

  function iconFor(id) {
    const p = idParts(id);
    if (!p) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      const path = WardrobePane.itemIconFor(p) || '';
      if (!path) return '';
      if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }

  const RENDER_IDLE_MS = 30000;
  let chipLastLand = 0;
  let renderChip = null;
  let chipT = null;

  function renderWindowActive() {
    return state.ready && chipLastLand > 0 && missingArt() &&
      (Date.now() - chipLastLand) < RENDER_IDLE_MS;
  }

  function rowLoading(it) {
    return renderWindowActive() && !!idParts(it.id) && !iconFor(it.id);
  }

  function updateRenderChip() {
    const chip = $('st-render-chip');
    if (!chip) return;
    let pending = 0;
    (state.items || []).forEach(function (it) { if (idParts(it.id) && !iconFor(it.id)) pending++; });
    const active = pending > 0 && renderWindowActive();
    chip.classList.toggle('hidden', !active);
    if (active) {
      chip.innerHTML = '<span class="st-render-spin"></span>rendering ' + pending +
        ' object' + (pending === 1 ? '' : 's') + '…';
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

  function firstOpenHint() { return !ui.hintSeen && renderWindowActive(); }
  function dismissHintIfDone() {
    if (ui.hintSeen) return;
    if (chipLastLand > 0 && !missingArt()) ui.hintSeen = true;
  }

  function requestIcons() {
    if (!state.items.length) return;
    const items = [], seen = {};
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      const p = idParts(it.id);
      if (!p) continue;
      const key = p.formId + '|' + p.plugin;
      if (ui.iconReq[key] || seen[key]) continue;
      if (iconFor(it.id)) continue;
      seen[key] = 1;
      ui.iconReq[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: it.n || '' });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
  }

  const ICON_SETTLE_MS = 650;
  const ICON_POLL_MS = 2500;
  const ICON_POLL_MAX = 24;

  function scheduleIconWork() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!state.items.length) { stopIconPoll(); updateRenderChip(); return; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.visible) return;
      if (missingArt()) chipLastLand = Date.now();
      requestIcons();
      startIconPoll();
      updateRenderChip();
    }, ICON_SETTLE_MS);
  }

  function missingArt() {
    for (let i = 0; i < state.items.length; i++)
      if (idParts(state.items[i].id) && !iconFor(state.items[i].id)) return true;
    return false;
  }

  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }

  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    if (!missingArt()) return;
    ui.iconPollT = setInterval(iconPollTick, ICON_POLL_MS);
  }

  function iconPollTick() {
    if (!ui.visible || !missingArt() || ++ui.iconPollN > ICON_POLL_MAX) {
      stopIconPoll();
      return false;
    }
    toGame('whIcons', JSON.stringify({ items: [] }));
    return true;
  }

  function flushIconsForTest() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    requestIcons();
  }

  const ICO_ERR = ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;st-has-art&quot;);' +
    'b.removeChild(this);}"';

  function glyphInner(id, glyph) {
    const url = iconFor(id);
    if (!url) return glyph;
    return glyph + '<img class="st-art" src="' + esc(url) + '" alt="" draggable="false"' + ICO_ERR + '>';
  }

  /* ============================================================ lightbox == */

  /* Click the picture -> the big render. The turntable now rides HDLightbox's
     own hdSpin flow (bake on first DRAG, not on open — the old stSpin here
     spent renders the moment the box opened, on pieces nobody ever turned). */
  function openLightbox(it) {
    const url = iconFor(it.id);
    if (!url || !window.HDLightbox) return;
    const meta = kindMeta(it.t);
    const frames = ['-a090', '-a180', '-a270'].map(function (s) {
      return url.replace(/\.png$/, s + '.png');
    });
    HDLightbox.open({
      host: $('st-pane'),
      src: url,
      glyph: meta[2],
      title: it.n,
      sub: meta[1] + ' · ' + it.p + (it.e ? ' · edid-only' : ''),
      frames: frames,
      spin: (function () { const p = idParts(it.id); return p ? { kind: 'item', formId: p.formId, plugin: p.plugin } : null; })(),
    });
  }

  /* ============================================================ catalogs == */

  function catById(id) {
    if (!id) return null;
    for (let i = 0; i < state.catalogs.length; i++)
      if (state.catalogs[i].id === id) return state.catalogs[i];
    return null;
  }
  function catName(id) { const c = catById(id); return c ? c.name : ''; }

  /* Catalogs shown in the rail, filtered by the filter-as-you-type box when
     the user has 8+ catalogs. */
  function visibleCatalogs() {
    const f = ui.catFilter.trim().toLowerCase();
    if (!f) return state.catalogs.slice();
    return state.catalogs.filter(function (c) {
      return String(c.name || '').toLowerCase().indexOf(f) !== -1;
    });
  }

  function catAct(payload) { toGame('stCat', JSON.stringify(payload)); }

  function fileRow(catId, rowId) {
    const it = itemById(rowId);
    const label = it ? it.n : rowId;
    catAct({ op: 'file', id: rowId, catId: catId });
    toast('Filed ' + label + ' → ' + (catName(catId) || 'catalog'));
  }

  function unfileRow(catId, rowId) {
    catAct({ op: 'unfile', id: rowId, catId: catId });
  }

  function itemById(id) {
    for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  function moveCat(catId, dir) {
    const ids = state.catalogs.map(function (c) { return c.id; });
    const i = ids.indexOf(catId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    catAct({ op: 'reorder', order: ids });
  }

  /* Inline catalog name editor — replaces the cats rail while active. */
  function beginCatEdit(which) {
    ui.catEditing = which;
    const box = $('st-cats');
    if (!box) return;
    const cur = which === 'new' ? '' : catName(which);
    box.innerHTML = '<div class="st-catedit">' +
      '<input id="st-catedit-input" type="text" maxlength="40" value="' + esc(cur) + '" ' +
      'placeholder="' + (which === 'new' ? 'New catalog name — Enter creates, Esc cancels' : 'Rename — Enter saves, Esc cancels') + '">' +
      '<button class="st-btn st-btn-primary" id="st-catedit-save">' + (which === 'new' ? 'Create' : 'Save') + '</button>' +
      '<button class="st-btn" id="st-catedit-cancel">Cancel</button></div>';
    const inp = $('st-catedit-input');
    const done = function () { ui.catEditing = ''; renderCats(); };
    function commit() {
      const v = inp.value.trim();
      if (!v) { done(); return; }
      if (which === 'new') catAct({ op: 'add', name: v });
      else catAct({ op: 'rename', catId: which, name: v });
      done();
    }
    $('st-catedit-save').addEventListener('click', commit);
    $('st-catedit-cancel').addEventListener('click', done);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commit(); e.stopPropagation(); }
      else if (e.key === 'Escape') { done(); e.stopPropagation(); }
      else e.stopPropagation();
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }

  /* Catalog context menu (right-click a chip): rename / move / ARMED delete. */
  function closeCatMenu() {
    ui.catMenu = null;
    const el = $('st-catmenu');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    document.removeEventListener('mousedown', onCatMenuOutside, true);
  }
  function onCatMenuOutside(e) {
    const el = $('st-catmenu');
    if (el && !el.contains(e.target)) closeCatMenu();
  }
  function openCatMenu(catId, x, y) {
    closeCatMenu();
    ui.catMenu = { id: catId, x: x, y: y, armed: false };
    const menu = document.createElement('div');
    menu.id = 'st-catmenu';
    menu.className = 'st-catmenu';
    function paint() {
      const idx = state.catalogs.findIndex(function (c) { return c.id === catId; });
      let html = '<div class="st-cm-head">' + esc(catName(catId)) + '</div>' +
        '<button class="st-cm-item" data-act="rename">✎ Rename</button>' +
        '<button class="st-cm-item" data-act="export">⭱ Export…</button>';
      if (idx > 0) html += '<button class="st-cm-item" data-act="up">▲ Move up</button>';
      if (idx >= 0 && idx < state.catalogs.length - 1) html += '<button class="st-cm-item" data-act="down">▼ Move down</button>';
      html += ui.catMenu.armed
        ? '<button class="st-cm-item st-cm-danger st-cm-armed" data-act="delyes">✕ Really delete?</button>'
        : '<button class="st-cm-item st-cm-danger" data-act="del">✕ Delete catalog</button>';
      menu.innerHTML = html;
      menu.querySelectorAll('.st-cm-item').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = b.getAttribute('data-act');
          if (a === 'del') { ui.catMenu.armed = true; paint(); return; }
          closeCatMenu();
          if (a === 'rename') beginCatEdit(catId);
          else if (a === 'export') catAct({ op: 'export', catId: catId });
          else if (a === 'up' || a === 'down') moveCat(catId, a === 'up' ? -1 : 1);
          else if (a === 'delyes') catAct({ op: 'del', catId: catId });
        });
      });
    }
    document.body.appendChild(menu);
    paint();
    const scale = (typeof window.deckPaintScale === 'function') ? window.deckPaintScale() : 1;
    const r = menu.getBoundingClientRect();
    let px = x, py = y;
    if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
    if (py + r.height > window.innerHeight - 8) py = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
    menu.style.transform = 'scale(' + scale + ')';
    menu.style.transformOrigin = 'top left';
    setTimeout(function () { document.addEventListener('mousedown', onCatMenuOutside, true); }, 0);
  }

  /* Per-row "file to catalog" menu (the ⋯ button). */
  function openRowCatMenu(rowId, x, y) {
    closeCatMenu();
    const it = itemById(rowId);
    if (!it) return;
    ui.catMenu = { id: '', x: x, y: y, row: rowId };
    const menu = document.createElement('div');
    menu.id = 'st-catmenu';
    menu.className = 'st-catmenu';
    let html = '<div class="st-cm-head">File “' + esc(it.n) + '” into</div>';
    /* The catalog RAIL already treats 8+ catalogs as needing a filter
       (renderCats). This menu lists exactly the same set and did not — so the
       tab asked you to search in one place and scroll in the other. Same
       threshold, so there is one rule. */
    const wantCatFind = state.catalogs.length >= 8;
    if (wantCatFind) {
      html += '<div class="st-cm-find"><span class="st-cm-find-g">⌕</span>' +
        '<input id="st-cm-find-in" type="text" placeholder="Find a catalog…" ' +
        'title="Narrows the list as you type. Enter files into the top hit, Esc clears." ' +
        'autocomplete="off" spellcheck="false"></div>';
    }
    const inCat = String(it.cat || '');
    for (let i = 0; i < state.catalogs.length; i++) {
      const c = state.catalogs[i];
      const on = inCat === c.id;
      html += '<button class="st-cm-item' + (on ? ' st-cm-on' : '') + '" data-file="' + esc(c.id) + '">' +
        (on ? '✓ ' : '') + esc(c.name) + '</button>';
    }
    if (wantCatFind) html += '<div class="st-cm-none" id="st-cm-none">No catalog matches.</div>';
    html += '<button class="st-cm-item st-cm-plus" data-newcat="1">＋ New catalog…</button>';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    const scale = (typeof window.deckPaintScale === 'function') ? window.deckPaintScale() : 1;
    const r = menu.getBoundingClientRect();
    let px = x, py = y;
    if (px + r.width > window.innerWidth - 8) px = window.innerWidth - r.width - 8;
    if (py + r.height > window.innerHeight - 8) py = window.innerHeight - r.height - 8;
    menu.style.left = Math.max(8, px) + 'px';
    menu.style.top = Math.max(8, py) + 'px';
    menu.style.transform = 'scale(' + scale + ')';
    menu.style.transformOrigin = 'top left';
    menu.querySelectorAll('.st-cm-item').forEach(function (b) {
      b.addEventListener('click', function () {
        const newcat = b.getAttribute('data-newcat');
        const fid = b.getAttribute('data-file');
        closeCatMenu();
        if (newcat) { beginCatEdit('new'); return; }
        if (String(it.cat || '') === fid) unfileRow(fid, rowId);
        else fileRow(fid, rowId);
      });
    });

    if (wantCatFind) {
      const fin = menu.querySelector('#st-cm-find-in');
      /* Filter the LIVE buttons rather than rebuilding the menu: a rebuild
         would destroy the input mid-keystroke, and this popup is positioned
         imperatively, so re-running that on every letter would make it jump. */
      const rows = menu.querySelectorAll('.st-cm-item[data-file]');
      const none = menu.querySelector('#st-cm-none');
      const apply = function () {
        const q = String(fin.value || '').trim().toLowerCase();
        let shown = 0;
        for (let i = 0; i < rows.length; i++) {
          const hit = !q || (rows[i].textContent || '').toLowerCase().indexOf(q) >= 0;
          rows[i].classList.toggle('st-cm-nomatch', !hit);
          if (hit) shown++;
        }
        if (none) none.classList.toggle('st-cm-show', !!q && shown === 0);
      };
      if (fin) {
        fin.addEventListener('input', apply);
        fin.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (fin.value) { fin.value = ''; apply(); return; }
            closeCatMenu();
            return;
          }
          if (e.key === 'Enter') {
            /* Enter files into the top hit — filing is a reversible tag, and
               clicking the same catalog again unfiles it. */
            e.preventDefault();
            for (let i = 0; i < rows.length; i++) {
              if (!rows[i].classList.contains('st-cm-nomatch')) { rows[i].click(); return; }
            }
          }
        });
        /* the menu opens on a click, so it can take focus immediately */
        setTimeout(function () { try { fin.focus(); } catch (e) {} }, 0);
      }
    }

    setTimeout(function () { document.addEventListener('mousedown', onCatMenuOutside, true); }, 0);
  }

  /* Import: ask C++ to scan catalogs/*.json, then present a picker. */
  function beginImport() { catAct({ op: 'importscan' }); }

  function openImportPicker() {
    closeCatMenu();
    const files = state.importFiles || [];
    const menu = document.createElement('div');
    menu.id = 'st-catmenu';
    menu.className = 'st-catmenu st-import-menu';
    let html = '<div class="st-cm-head">Import a shared catalog</div>';
    if (!files.length) {
      html += '<div class="st-cm-empty">No catalog files found in <code>catalogs\\</code>. Export one first, or drop a shared <code>.json</code> there.</div>';
    } else {
      files.forEach(function (f) {
        html += '<button class="st-cm-item st-cm-import" data-file="' + esc(f.file) + '">' +
          '<span class="st-cm-import-n">' + esc(f.name) + '</span>' +
          '<span class="st-cm-import-c">' + fmtN(f.itemCount | 0) + ' item' + ((f.itemCount | 0) === 1 ? '' : 's') + '</span></button>';
      });
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);
    const scale = (typeof window.deckPaintScale === 'function') ? window.deckPaintScale() : 1;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.round((window.innerWidth - r.width) / 2)) + 'px';
    menu.style.top = Math.max(8, Math.round((window.innerHeight - r.height) / 3)) + 'px';
    menu.style.transform = 'scale(' + scale + ')';
    menu.style.transformOrigin = 'top left';
    menu.querySelectorAll('.st-cm-import').forEach(function (b) {
      b.addEventListener('click', function () {
        const file = b.getAttribute('data-file');
        closeCatMenu();
        catAct({ op: 'import', file: file });
      });
    });
    setTimeout(function () { document.addEventListener('mousedown', onCatMenuOutside, true); }, 0);
  }

  /* ============================================================ header/pills == */

  function renderHeader() {
    const chip = $('st-count');
    if (chip) {
      chip.textContent = state.ready
        ? (fmtN(state.count) + ' objects · ' + fmtN(state.plugins.length) + ' mods indexed')
        : 'reading the load order…';
    }
    updateRenderChip();
  }

  function renderPills() {
    const box = $('st-pills');
    if (!box) return;
    let list = KINDS.slice();
    let html = list.map(function (k) {
      return '<button class="st-pill' + (ui.type === k[0] && !ui.catScope ? ' st-pill-on' : '') +
        '" data-type="' + k[0] + '" title="' +
        (k[0] === 'all' ? 'Search objects and mods together'
          : k[0] === 'mods' ? 'Search plugin names only — esp, esm, esl'
            : 'Only ' + esc(k[1].toLowerCase())) + '">' +
        (k[0] === 'all' || k[0] === 'mods' ? '' : k[2] + ' ') + esc(k[1]) + '</button>';
    }).join('');
    /* the Campfire pill only when Campfire is installed */
    if (state.campfire.present) {
      html += '<button class="st-pill st-pill-camp' + (ui.type === 'camp' ? ' st-pill-on' : '') +
        '" data-type="camp" title="Campfire gear — Shelter, Fire, Cooking and more">⛺ Campfire</button>';
    }
    box.innerHTML = html;
    box.querySelectorAll('.st-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.type = b.getAttribute('data-type');
        ui.catScope = '';
        if (ui.type !== 'camp') ui.campSub = '';
        ui.sel = 0;
        runQuery(true);
        const s = $('st-bar');
        if (s) s.focus();
      });
    });
  }

  function renderPlugChip() {
    /* The plugin chip lives inside #st-barwrap (Gmail-token). Built into the
       bar dynamically so no static index.html slot is needed. */
    const wrap = document.querySelector('#st-pane .st-barwrap');
    if (!wrap) return;
    let chip = $('st-plug-chip');
    if (!ui.plugin) { if (chip) { chip.classList.add('hidden'); chip.innerHTML = ''; } return; }
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'st-plug-chip';
      chip.className = 'st-plug-chip';
      const bar = $('st-bar');
      if (bar && bar.parentNode) bar.parentNode.insertBefore(chip, bar);
    }
    chip.classList.remove('hidden');
    chip.innerHTML = '📦 <b title="' + esc(ui.plugin) + '">' + esc(ui.plugin) + '</b>' +
      '<span class="st-chip-x" title="Search everything again">✕</span>';
    chip.querySelector('.st-chip-x').addEventListener('click', clearPlugin);
  }

  /* ============================================================ cats rail == */

  function renderCats() {
    const box = $('st-cats');
    if (!box) return;
    if (ui.catEditing) return;   // the inline editor owns the rail
    if (ui.placedView) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');

    let html = '';

    /* filter-as-you-type over catalogs, only past 8 */
    if (state.catalogs.length >= 8) {
      html += '<div class="st-cat-filter"><span class="st-cat-filter-g">⌕</span>' +
        '<input id="st-cat-filter-input" type="text" placeholder="filter catalogs…" ' +
        'autocomplete="off" spellcheck="false" value="' + esc(ui.catFilter) + '"></div>';
    }

    html += '<div class="st-cat-chips">';
    /* Campfire tree chip (when installed) */
    if (state.campfire.present) {
      html += '<button class="st-cat-chip st-cat-camp' + (ui.type === 'camp' ? ' st-cat-on' : '') +
        '" data-camp="1" title="Campfire gear, grouped by kind">⛺ Campfire</button>';
    }
    visibleCatalogs().forEach(function (c) {
      const on = ui.catScope === c.id;
      html += '<button class="st-cat-chip' + (on ? ' st-cat-on' : '') + '" data-cat="' + esc(c.id) +
        '" title="' + esc(c.name) + ' — ' + (c.count | 0) + ' item' + ((c.count | 0) === 1 ? '' : 's') +
        ' · drag an object here to file it, right-click to rename / export / delete">' +
        esc(c.name) + '<span class="st-cat-n">' + (c.count | 0) + '</span></button>';
    });
    html += '<button class="st-cat-chip st-cat-new" data-new="1" title="Create a catalog">＋ Catalog</button>';
    html += '<button class="st-cat-chip st-cat-import" data-import="1" title="Import a shared catalog file">⭳ Import</button>';
    html += '<button class="st-cat-chip st-cat-placed' + (ui.placedView ? ' st-cat-on' : '') +
      '" data-placed="1" title="Everything you have placed in this save">📌 My placements</button>';
    html += '</div>';

    /* Campfire subcategory row when the Campfire scope is active */
    if (ui.type === 'camp') {
      html += '<div class="st-camp-subs">';
      html += '<button class="st-camp-sub' + (ui.campSub === '' ? ' st-camp-sub-on' : '') +
        '" data-sub="" title="All Campfire gear">All</button>';
      CAMP_SUBS.forEach(function (s) {
        html += '<button class="st-camp-sub' + (ui.campSub === s[0] ? ' st-camp-sub-on' : '') +
          '" data-sub="' + s[0] + '" title="' + esc(s[1]) + '">' + s[2] + ' ' + esc(s[1]) + '</button>';
      });
      if (state.campfire.unleashed === false) {
        html += '<span class="st-camp-unleashed" title="Campfire Unleashed is not installed — its extra gear is unavailable">◌ Unleashed · not installed</span>';
      }
      html += '</div>';
    }

    box.innerHTML = html;

    const fi = $('st-cat-filter-input');
    if (fi) {
      fi.addEventListener('input', function () {
        ui.catFilter = fi.value;
        renderCats();
        const f2 = $('st-cat-filter-input');
        if (f2) { f2.focus(); f2.setSelectionRange(f2.value.length, f2.value.length); }
      });
      /* Enter takes the top hit — scoping the browser to that catalog, which
         is exactly what clicking its chip does. Esc clears the filter. */
      fi.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (!ui.catFilter) return;
          ui.catFilter = ''; renderCats();
          const f2 = $('st-cat-filter-input'); if (f2) f2.focus();
          return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const top = visibleCatalogs()[0];
        if (!top) return;
        ui.catScope = (ui.catScope === top.id) ? '' : top.id;
        ui.type = 'all'; ui.campSub = ''; ui.sel = 0;
        runQuery(true);
      });
    }

    box.querySelectorAll('.st-cat-chip').forEach(function (b) {
      if (b.getAttribute('data-new')) { b.addEventListener('click', function () { beginCatEdit('new'); }); return; }
      if (b.getAttribute('data-import')) { b.addEventListener('click', beginImport); return; }
      if (b.getAttribute('data-placed')) { b.addEventListener('click', togglePlacedView); return; }
      if (b.getAttribute('data-camp')) {
        b.addEventListener('click', function () {
          ui.type = 'camp'; ui.catScope = ''; ui.plugin = ''; ui.sel = 0; runQuery(true);
        });
        return;
      }
      const cat = b.getAttribute('data-cat');
      if (cat != null) {
        b.addEventListener('click', function () {
          ui.catScope = (ui.catScope === cat) ? '' : cat;
          ui.type = 'all'; ui.campSub = '';
          ui.sel = 0; runQuery(true);
        });
        b.addEventListener('contextmenu', function (e) {
          e.preventDefault(); openCatMenu(cat, e.clientX, e.clientY);
        });
        b.addEventListener('dragover', function (e) { if (ui.dragId) { e.preventDefault(); b.classList.add('st-cat-drop'); } });
        b.addEventListener('dragleave', function () { b.classList.remove('st-cat-drop'); });
        b.addEventListener('drop', function (e) {
          e.preventDefault(); b.classList.remove('st-cat-drop');
          if (ui.dragId) fileRow(cat, ui.dragId);
        });
      }
    });

    box.querySelectorAll('.st-camp-sub').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.campSub = b.getAttribute('data-sub') || '';
        ui.sel = 0; runQuery(true);
      });
    });
  }

  /* ============================================================ rows == */

  function plugRowHtml(p, selIdx, idx) {
    const kindCls = p.k === 'esm' ? 'st-kind-esm' : (p.k === 'esl' || p.l) ? 'st-kind-esl' : 'st-kind-esp';
    const kindLbl = String(p.k || 'esp').toUpperCase() + (p.l && p.k === 'esp' ? ' · light' : '');
    return '<div class="st-plug-row' + (selIdx === idx ? ' st-sel' : '') + '" data-plug="' + esc(p.n) +
      '" title="Browse everything ' + esc(p.n) + ' ships">' +
      '<span class="st-kindbadge ' + kindCls + '">' + esc(kindLbl) + '</span>' +
      '<span class="st-plug-name">' + highlight(p.n, ui.q) + '</span>' +
      '<span class="st-plug-count">' + fmtN(p.c) + ' objects</span>' +
      '<span class="st-plug-go">Browse →</span></div>';
  }

  function itemRowHtml(it, selIdx, idx) {
    const camp = isCampRow(it);
    const meta = camp ? campSubMeta(it.sub) : kindMeta(it.t);
    const hasArt = !!iconFor(it.id);
    const loading = !hasArt && rowLoading(it);
    const open = false;
    const doorWarn = it.t === 'door';
    return '<div class="st-row' + (selIdx === idx ? ' st-sel' : '') + '" draggable="true" data-id="' + esc(it.id) + '">' +
      '<div class="st-glyph st-t-' + esc(camp ? 'camp' : it.t) + (hasArt ? ' st-has-art st-zoomable' : '') +
      (loading ? ' st-loading' : '') +
      '" title="' + esc(hasArt ? it.n + ' — click for a bigger look' : (loading ? 'rendering…' : meta[1])) + '">' +
      glyphInner(it.id, meta[2]) + '</div>' +
      '<div class="st-mid">' +
      '<div class="st-name" title="' + esc(it.n) + '"><span class="st-name-txt">' + highlight(it.n, ui.q) + '</span>' +
      (it.e ? '<span class="st-chip st-chip-edid" title="No display name — this is its EditorID">edid</span>' : '') +
      (camp ? '<span class="st-chip st-chip-camp" title="Campfire · ' + esc(meta[1]) + '">⛺ ' + esc(meta[1]) + '</span>' : '') +
      (doorWarn ? '<span class="st-chip st-chip-warn" title="Placed as a plain door mesh only — not a working load door">plain door</span>' : '') +
      '</div>' +
      '<div class="st-meta">' +
      '<span class="st-meta-type">' + esc(meta[1]) + '</span>' +
      '<span class="st-meta-plug" data-plug="' + esc(it.p) + '" title="Browse everything ' + esc(it.p) + ' ships">' + esc(it.p) + '</span>' +
      (it.missing ? '<span class="st-chip st-chip-warn" title="This catalog entry references a mod that is not in your load order">missing mod</span>' : '') +
      '</div></div>' +
      '<div class="st-act">' +
      '<button class="st-btn st-do st-primary" data-do="place" title="' +
      (camp ? 'Start Campfire’s own placement preview for this item' : 'Place it where you’re looking (Enter does this too)') +
      '">✚ Place</button>' +
      '<button class="st-btn st-do' + (ui.omoAbsent ? ' st-do-fallback' : '') + '" data-do="move" title="' +
      (ui.omoAbsent ? 'OMO not loaded — arrow-nudge only' : 'Grab and drag the placed copy (OMO if installed, else arrow-nudge)') +
      '">✥ Move</button>' +
      '<button class="st-btn st-do st-danger" data-do="remove" title="Remove the last copy you placed">✕ Remove</button>' +
      '<button class="st-row-cat" data-catbtn="1" title="File ' + esc(it.n) + ' into a catalog">⋯</button>' +
      '</div></div>';
  }

  /* ============================================================ body == */

  function renderBody() {
    if (ui.placedView) { renderPlaced(); return; }
    const body = $('st-body');
    const empty = $('st-empty');
    if (!body || !empty) return;

    if (!state.ready) {
      /* Skeleton rows alone read as "hung" for a three-second walk, so say what
         is happening and how far along it is. The bar is driven by the real
         per-stage pushes from C++, and the count climbs as objects land — a
         progress bar that moves is the difference between "loading" and
         "crashed". */
      const pct = Math.round((state.progress || 0) * 100);
      body.innerHTML =
        '<div class="st-loadcard" role="status" aria-live="polite">' +
        '<div class="st-load-spin" aria-hidden="true"></div>' +
        '<div class="st-load-title">Indexing every placeable object in your load order</div>' +
        '<div class="st-load-sub">' +
        (state.stage ? 'Walking <b>' + esc(state.stage) + '</b>' : 'Starting') +
        (state.count ? ' — <b>' + fmtN(state.count) + '</b> objects so far' : '') +
        '</div>' +
        '<div class="st-load-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="st-load-note">First open only — it is cached for the rest of the session.</div>' +
        '</div>' +
        new Array(4).fill(
          '<div class="st-row st-skel"><div class="st-glyph st-skel-box"></div>' +
          '<div class="st-mid"><span class="st-skel-box st-skel-w1"></span>' +
          '<span class="st-skel-box st-skel-w2"></span></div>' +
          '<span class="st-skel-box st-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = flatRows();

    /* hero — nothing asked yet */
    if (!rows.length && !hasQuery()) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="st-hero-glyph">🏕</div>' +
        '<div class="st-empty-title">Every object the load order ships</div>' +
        '<div class="st-empty-sub"><b>' + fmtN(state.count) + ' objects</b> across <b>' +
        fmtN(state.plugins.length) + ' mods</b> — statics, furniture, containers, camp gear. ' +
        'Type an object or a mod to browse, then place it where you’re looking.' +
        (state.campfire.present ? ' Campfire is installed — open its tree from the rail.' : '') +
        '</div>' +
        '<div class="st-try">' +
        ['chair', 'campfire', 'chest', 'brazier', 'Skyrim.esm'].map(function (t) {
          return '<button class="st-pill" data-try="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-try]').forEach(function (b) {
        b.addEventListener('click', function () {
          const s = $('st-bar');
          ui.q = b.getAttribute('data-try');
          ui.catScope = ''; ui.type = 'all';
          if (s) { s.value = ui.q; s.focus(); }
          runQuery(true);
        });
      });
      return;
    }

    /* honest empties */
    if (!rows.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      if (state.awaiting) {
        empty.innerHTML = '<div class="st-empty-title">Searching…</div>';
      } else if (ui.type === 'mods') {
        empty.innerHTML = '<div class="st-empty-title">No mod matches</div>' +
          '<div class="st-empty-sub">No plugin name contains “' + esc(ui.q) + '”. Try fewer letters.</div>';
      } else if (ui.catScope) {
        empty.innerHTML = '<div class="st-empty-title">“' + esc(catName(ui.catScope)) + '” is empty</div>' +
          '<div class="st-empty-sub">Drag an object onto this catalog’s chip, or use a row’s ⋯ menu to file it here.</div>';
      } else if (ui.type === 'camp') {
        empty.innerHTML = '<div class="st-empty-title">Nothing under this Campfire category</div>' +
          '<div class="st-empty-sub">Try “All”, another subcategory, or type a name.</div>';
      } else {
        empty.innerHTML = '<div class="st-empty-title">Nothing matches</div>' +
          '<div class="st-empty-sub">No object called “' + esc(ui.q) + '”' +
          (ui.plugin ? ' in ' + esc(ui.plugin) : '') +
          (ui.type !== 'all' ? ' under that pill' : '') +
          '. Try fewer letters, another pill, or the whole-word mod name.</div>';
      }
      return;
    }
    empty.classList.add('hidden');

    let html = '';
    let idx = 0;
    let inMods = false, inItems = false;
    const showHint = firstOpenHint() && rows.some(function (r) { return r.kind === 'item'; });
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        html += '<div class="st-sect">Mods <b>' +
          (ui.type === 'mods' ? modMatches(30).length : Math.min(5, modMatches(5).length)) + '</b></div>';
      }
      if (r.kind === 'item' && !inItems) {
        inItems = true;
        html += '<div class="st-sect">Objects <b>' + fmtN(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') +
          (ui.catScope ? '<b>· ' + esc(catName(ui.catScope)) + '</b>' : '') +
          (ui.type === 'camp' ? '<b>· ⛺ Campfire' + (ui.campSub ? ' · ' + esc(campSubMeta(ui.campSub)[1]) : '') + '</b>' : '') +
          '</div>';
        if (showHint)
          html += '<div class="st-firsthint">✨ First time seeing these — rendering their models in the ' +
            'background. Rows fill in as it lands.</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'item') html += itemRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    body.querySelectorAll('.st-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
    body.querySelectorAll('.st-row:not(.st-skel)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      row.querySelectorAll('.st-do').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          const it = itemById(id);
          if (!it) return;
          const op = b.getAttribute('data-do');
          if (op === 'place') doPlace(it);
          else if (op === 'move') doMove(it);
          else if (op === 'remove') doRemove(it);
        });
      });
      const zoom = row.querySelector('.st-glyph.st-zoomable');
      if (zoom) zoom.addEventListener('click', function (e) {
        e.stopPropagation();
        const it = itemById(id);
        if (it) openLightbox(it);
      });
      const plug = row.querySelector('.st-meta-plug');
      if (plug) plug.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlugin(plug.getAttribute('data-plug'));
      });
      const cb = row.querySelector('[data-catbtn]');
      if (cb) cb.addEventListener('click', function (e) {
        e.stopPropagation();
        openRowCatMenu(id, e.clientX, e.clientY);
      });
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openRowCatMenu(id, e.clientX, e.clientY);
      });
      row.addEventListener('dragstart', function (e) {
        ui.dragId = id;
        row.classList.add('st-dragging-row');
        if (e.dataTransfer) { try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {} }
      });
      row.addEventListener('dragend', function () {
        ui.dragId = '';
        row.classList.remove('st-dragging-row');
      });
      row.addEventListener('dblclick', function () {
        const it = itemById(id);
        if (it) doPlace(it);
      });
    });

    scheduleIconWork();
    updateRenderChip();
  }

  /* ============================================================ placements == */

  function togglePlacedView() {
    ui.placedView = !ui.placedView;
    if (ui.placedView) refreshPlaced();
    render();
  }

  function refreshPlaced() { toGame('stPlaced', JSON.stringify({})); }

  function renderPlaced() {
    const body = $('st-body');
    const empty = $('st-empty');
    if (!body || !empty) return;
    const list = state.placed;

    if (list === null) {
      body.innerHTML = new Array(4).fill(
        '<div class="st-row st-skel"><div class="st-glyph st-skel-box"></div>' +
        '<div class="st-mid"><span class="st-skel-box st-skel-w1"></span>' +
        '<span class="st-skel-box st-skel-w2"></span></div>' +
        '<span class="st-skel-box st-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    if (!list.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="st-hero-glyph">📌</div>' +
        '<div class="st-empty-title">No placements in this save yet</div>' +
        '<div class="st-empty-sub">Objects you place show up here — jump back to them or remove them. ' +
        'This roster is scoped to the <b>current save</b>: it prunes anything that belonged to a different one.</div>' +
        '<div class="st-try"><button class="st-pill" id="st-placed-back">← Back to objects</button></div>';
      const bk = $('st-placed-back');
      if (bk) bk.addEventListener('click', togglePlacedView);
      return;
    }
    empty.classList.add('hidden');

    /* ---- filter-as-you-type over the placements roster -------------------
       This list has no ceiling by construction: it is every object the player
       has ever placed in this save, and it only grows. The object BROWSER
       above it is searchable and paginated; the roster of what you actually
       built was neither, which made the one list you revisit most the hardest
       to use. Threshold 8 mirrors the catalog rail in renderCats, so the tab
       has one rule about when a filter appears rather than two.

       The query lives on `ui` because renderPlaced() re-runs wholesale on
       every stPlacedResult push, every render() and every remove — a local
       would drop what you typed the moment you removed a row. */
    const q = String(ui.placedFilter || '').trim().toLowerCase();
    const shown = q ? list.filter(function (pl) {
      const meta = kindMeta(pl.kind);
      return ((pl.name || '') + ' ' + (pl.cell || '') + ' ' + (meta[1] || ''))
        .toLowerCase().indexOf(q) >= 0;
    }) : list;
    const wantFilter = list.length >= 8;

    let html = '<div class="st-sect">My placements <b>' + fmtN(list.length) + '</b>' +
      (q ? '<span class="st-sect-n">' + fmtN(shown.length) + ' match' +
           (shown.length === 1 ? '' : 'es') + '</span>' : '') +
      '<button class="st-sect-back" id="st-placed-back-inline" title="Back to browsing objects">← Objects</button></div>';
    if (wantFilter) {
      html += '<div class="st-cat-filter st-placed-filter"><span class="st-cat-filter-g">⌕</span>' +
        '<input id="st-placed-filter-input" type="text" ' +
        'placeholder="Find a placement — name, kind or place…" ' +
        'title="Narrows your placements as you type. Enter travels to the top hit, Esc clears." ' +
        'autocomplete="off" spellcheck="false" value="' + esc(ui.placedFilter) + '"></div>';
    }
    if (q && !shown.length) {
      html += '<div class="st-placed-none">Nothing you have placed matches ' +
        '<b>' + esc(ui.placedFilter) + '</b>.</div>';
    }
    shown.forEach(function (pl) {
      const meta = kindMeta(pl.kind);
      html += '<div class="st-row st-placed-row" data-pid="' + esc(pl.id) + '">' +
        '<div class="st-glyph st-t-' + esc(pl.kind) + '" title="' + esc(meta[1]) + '">' + meta[2] + '</div>' +
        '<div class="st-mid"><div class="st-name" title="' + esc(pl.name) + '"><span class="st-name-txt">' + esc(pl.name) + '</span></div>' +
        '<div class="st-meta"><span class="st-meta-type">' + esc(meta[1]) + '</span>' +
        (pl.cell ? '<span class="st-meta-cell" title="' + esc(pl.cell) + '">' + esc(pl.cell) + '</span>' : '') +
        '</div></div>' +
        '<div class="st-act">' +
        '<button class="st-btn st-do st-primary" data-pdo="jumpto" title="Travel to where you placed it">⤞ Go to</button>' +
        '<button class="st-btn st-do st-danger" data-pdo="remove" title="Remove this placed object">✕ Remove</button>' +
        '</div></div>';
    });
    body.innerHTML = html;

    const bk = $('st-placed-back-inline');
    if (bk) bk.addEventListener('click', togglePlacedView);

    const pf = $('st-placed-filter-input');
    if (pf) {
      pf.addEventListener('input', function () {
        ui.placedFilter = pf.value;
        renderPlaced();
        /* body.innerHTML replaced the input, so put the caret back where the
           player left it — the catalog filter above does the same. */
        const f2 = $('st-placed-filter-input');
        if (f2) { f2.focus(); f2.setSelectionRange(f2.value.length, f2.value.length); }
      });
      pf.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.stopPropagation();          // Esc clears the filter before it closes the deck
          if (!pf.value) return;
          ui.placedFilter = '';
          renderPlaced();
          const f2 = $('st-placed-filter-input');
          if (f2) f2.focus();
          return;
        }
        if (e.key === 'Enter') {
          /* Enter takes the top hit, and for a placement the useful verb is
             the row's own primary one: go stand where you built it. */
          e.preventDefault();
          if (shown.length) doJumpTo(shown[0]);
        }
      });
    }

    body.querySelectorAll('.st-placed-row').forEach(function (row) {
      const pid = row.getAttribute('data-pid');
      const pl = (list || []).filter(function (x) { return x.id === pid; })[0];
      row.querySelectorAll('.st-do').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!pl) return;
          if (b.getAttribute('data-pdo') === 'jumpto') doJumpTo(pl);
          else doRemovePlaced(pl);
        });
      });
    });
  }

  /* ============================================================ footer == */

  let footEl = null;

  function footHost() {
    const pane = $('st-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'st-foot';
      footEl.id = 'st-foot';
      const body = $('st-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  function footVisible() {
    if (!state.ready) return false;
    if (ui.placedView) return false;
    if (ui.type === 'mods') return false;
    if (!hasQuery()) return false;
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('st-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;
    const first = total ? ui.page * ui.pageSize + 1 : 0;
    const last = Math.min(total, (ui.page + 1) * ui.pageSize);
    const multi = pc > 1;

    let html = '';
    if (multi) {
      html += '<button class="st-foot-nav st-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="st-foot-count">Showing <b>' + fmtN(first) + '–' + fmtN(last) +
      '</b> of <b>' + fmtN(total) + '</b>' + (multi ? ' · page ' + (ui.page + 1) + ' of ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="st-foot-nav st-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="st-foot-per" title="How many to show per page — fewer means fewer renders at once">' +
      '<span class="st-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="st-foot-size' + (n === ui.pageSize ? ' st-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('st-foot-on');

    const prev = foot.querySelector('.st-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.st-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.st-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* ============================================================ toast == */

  function toast(msg, err) {
    const t = $('st-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('st-toast-err', !!err);
    t.classList.add('st-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('st-toast-show'); }, 2600);
  }

  /* ============================================================ render == */

  function renderBodyPreservingScroll() {
    const body = $('st-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('st-body');
    if (b2) b2.scrollTop = top;
  }

  function render() {
    renderHeader();
    renderPills();
    renderPlugChip();
    renderCats();
    renderBody();
    renderFooter();
  }

  /* ============================================================ lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('stState');
    const s = $('st-bar');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready && hasQuery()) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
    closeCatMenu();
    if (window.HDLightbox) HDLightbox.close();
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (chipT) { clearTimeout(chipT); chipT = null; }
    stopIconPoll();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  function setFilter(text) {
    ui.q = String(text || '');
    ui.plugin = '';
    ui.type = 'all';
    ui.catScope = '';
    ui.placedView = false;
    const s = $('st-bar');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  let inited = false;
  function init() {
    if (inited) return;   // guard against double-wiring (readyState + DOMContentLoaded + harness)
    inited = true;
    const s = $('st-bar');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        queryDebounced();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const rows = flatRows();
          activate(rows[Math.min(ui.sel, rows.length - 1)] || rows[0]);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = flatRows();
          if (rows.length) {
            ui.sel = e.key === 'ArrowDown'
              ? Math.min(rows.length - 1, ui.sel + 1)
              : Math.max(0, ui.sel - 1);
            renderBody();
            const el = document.querySelector('#st-body .st-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
          if (footVisible() && pageCount() > 1) {
            gotoPage(ui.page + (e.key === 'PageDown' ? 1 : -1));
            e.preventDefault();
            e.stopPropagation();
          }
        } else if (e.key === 'Escape') {
          if (s.value) { s.value = ''; ui.q = ''; runQuery(true); e.stopPropagation(); }
          else if (ui.plugin) { clearPlugin(); e.stopPropagation(); }
          else if (ui.catScope || ui.type === 'camp') { ui.catScope = ''; ui.type = 'all'; runQuery(true); e.stopPropagation(); }
          /* bare Esc falls through to the palette close, on purpose */
        } else if (e.key === 'Backspace' && !s.value && ui.plugin) {
          clearPlugin();
          e.stopPropagation();
        }
      });
    }

    try {
      document.addEventListener('hd-item-icons', function () {
        if (!ui.visible) return;
        chipLastLand = Date.now();
        dismissHintIfDone();
        renderBodyPreservingScroll();
      });
    } catch (e) { /* no DOM in some harnesses */ }

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_ITEMS = [
    { id: 'Skyrim.esm|000BB9DA', n: 'Wooden Chair', t: 'furn', p: 'Skyrim.esm', e: false, cat: '' },
    { id: 'Skyrim.esm|0001CB37', n: 'Chest', t: 'cont', p: 'Skyrim.esm', e: false, cat: '' },
    { id: 'Skyrim.esm|0003B4E5', n: 'Brazier', t: 'stat', p: 'Skyrim.esm', e: false, cat: '' },
    { id: 'CoolClutter.esp|000801', n: 'Ornate Table', t: 'furn', p: 'CoolClutter.esp', e: false, cat: '' },
    { id: 'CoolClutter.esp|000ABC', n: 'BckGrdMarkerStatue', t: 'stat', p: 'CoolClutter.esp', e: true, cat: '' },
    { id: 'Skyrim.esm|00016597', n: 'Wooden Door', t: 'door', p: 'Skyrim.esm', e: false, cat: '' },
  ];
  const DEV_CAMP = [
    { id: 'Campfire.esm|01A314', n: 'Fur Tent', t: 'mstt', p: 'Campfire.esm', e: false, cat: '', camp: true, sub: 'shelter' },
    { id: 'Campfire.esm|01A320', n: 'Campfire (unlit)', t: 'mstt', p: 'Campfire.esm', e: false, cat: '', camp: true, sub: 'fire' },
    { id: 'Campfire.esm|01A330', n: 'Cooking Pot', t: 'mstt', p: 'Campfire.esm', e: false, cat: '', camp: true, sub: 'cooking' },
    { id: 'Tentapalooza.esp|000901', n: 'Large Canvas Tent', t: 'mstt', p: 'Tentapalooza.esp', e: false, cat: '', camp: true, sub: 'shelter' },
  ];

  function devState() {
    window.stStateResult({
      phase: 'ready', count: 84210, pageSize: ui.pageSize,
      plugins: [
        { n: 'Skyrim.esm', c: 41284, k: 'esm', l: false },
        { n: 'CoolClutter.esp', c: 214, k: 'esp', l: false },
        { n: 'Campfire.esm', c: 812, k: 'esm', l: false },
      ],
      catalogs: state.catalogs.length ? state.catalogs : [
        { id: 'c1', name: 'My Camp', count: 2 },
        { id: 'c2', name: 'Home Decor', count: 0 },
      ],
      campfire: { present: true, unleashed: false, tentapalooza: true },
      hunterborn: { present: true },
    });
  }

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    let pool = (req.cat === 'camp') ? DEV_CAMP.slice() : DEV_ITEMS.slice();
    if (req.cat && req.cat !== 'camp') pool = DEV_ITEMS.filter(function (it) { return it.cat === req.cat; });
    let rows = pool.filter(function (it) {
      if (req.plugin && it.p !== req.plugin) return false;
      if (req.type && req.type !== 'all' && it.t !== req.type) return false;
      if (req.cat === 'camp' && req.sub && it.sub !== req.sub) return false;
      for (let i = 0; i < toks.length; i++) {
        if (it.n.toLowerCase().indexOf(toks[i]) === -1 &&
            it.p.toLowerCase().indexOf(toks[i]) === -1) return false;
      }
      return true;
    });
    window.stResultData({ seq: req.seq | 0, total: rows.length, offset: req.offset | 0,
      items: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || 60)) });
  }

  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    /* physical ops close the palette in prod and push no reply; in dev we
       surface a toast so the harness can assert the op fired */
    if (req.op === 'move') { window.stActResult({ ok: true, op: 'move', omo: false, msg: 'Grab it with the arrow keys (OMO not loaded)' }); return; }
    window.stActResult({ ok: true, op: req.op, msg: 'ok: ' + req.op });
  }

  function devSave(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.stSaved({ ok: true, pageSize: req.pageSize || ui.pageSize });
  }

  let devCatCounter = 3;
  function devCat(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const cats = state.catalogs.slice();
    if (req.op === 'add') { cats.push({ id: 'c' + (devCatCounter++), name: req.name, count: 0 }); window.stCatResult({ ok: true, op: 'add', catalogs: cats, msg: 'Added ' + req.name }); return; }
    if (req.op === 'rename') { cats.forEach(function (c) { if (c.id === req.catId) c.name = req.name; }); window.stCatResult({ ok: true, op: 'rename', catalogs: cats }); return; }
    if (req.op === 'del') { window.stCatResult({ ok: true, op: 'del', catalogs: cats.filter(function (c) { return c.id !== req.catId; }), msg: 'Deleted' }); return; }
    if (req.op === 'reorder') {
      const order = req.order || [];
      const byId = {}; cats.forEach(function (c) { byId[c.id] = c; });
      const out = []; order.forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
      for (const k in byId) out.push(byId[k]);
      window.stCatResult({ ok: true, op: 'reorder', catalogs: out }); return;
    }
    if (req.op === 'file') { cats.forEach(function (c) { if (c.id === req.catId) c.count = (c.count | 0) + 1; }); window.stCatResult({ ok: true, op: 'file', catalogs: cats }); return; }
    if (req.op === 'unfile') { cats.forEach(function (c) { if (c.id === req.catId) c.count = Math.max(0, (c.count | 0) - 1); }); window.stCatResult({ ok: true, op: 'unfile', catalogs: cats }); return; }
    if (req.op === 'export') { window.stCatResult({ ok: true, op: 'export', path: 'catalogs/' + (catName(req.catId) || 'Catalog') + '.json' }); return; }
    if (req.op === 'importscan') { window.stCatResult({ ok: true, files: [{ name: 'Shared Camp', itemCount: 5, file: 'shared-camp.json' }] }); return; }
    if (req.op === 'import') { cats.push({ id: 'c' + (devCatCounter++), name: 'Shared Camp (imported)', count: 5 }); window.stCatResult({ ok: true, op: 'import', imported: 5, missing: 1, catalogs: cats, id: 'c' + (devCatCounter - 1) }); return; }
    window.stCatResult({ ok: false, op: req.op, msg: 'unknown op' });
  }

  function devPlaced() {
    window.stPlacedResult({ items: [
      { id: 'FF001234', name: 'Wooden Chair', kind: 'furn', cell: 'Riverwood' },
      { id: 'FF001235', name: 'Chest', kind: 'cont', cell: 'Riverwood' },
    ] });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    ui.visible = true;
    devState();
    ok('state: ready', state.ready === true);
    ok('state: plugins landed', state.plugins.length === 3);
    ok('state: campfire detected', state.campfire.present === true && state.campfire.tentapalooza === true);
    ok('state: hunterborn detected', state.hunterborn.present === true);

    /* hero */
    ui.q = ''; ui.plugin = ''; ui.type = 'all'; ui.catScope = ''; ui.placedView = false;
    render();
    ok('hero: shown with stats', !$('st-empty').classList.contains('hidden') &&
      $('st-empty').textContent.indexOf('84,210') !== -1);

    /* pills render from KINDS + Campfire pill present */
    ok('pills: kind + campfire', document.querySelectorAll('#st-pills .st-pill').length === KINDS.length + 1);

    /* query render */
    ui.q = 'chair';
    state.seq++; devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('query: chair found', state.items.length === 1 && state.items[0].n === 'Wooden Chair');
    ok('rows: in DOM', document.querySelectorAll('#st-body .st-row:not(.st-skel)').length === state.items.length);
    ok('highlight: match marked', !!document.querySelector('#st-body .st-name mark'));

    /* edid chip */
    ui.q = 'BckGrd';
    state.seq++; devQuery(JSON.stringify({ q: 'BckGrd', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('edid chip: drawn for nameless-full record', !!document.querySelector('#st-body .st-chip-edid'));

    /* door warn chip */
    ui.q = 'door';
    state.seq++; devQuery(JSON.stringify({ q: 'door', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('door: plain-door warn chip', !!document.querySelector('#st-body .st-chip-warn'));

    /* stale reply dropped */
    const before = state.items.length;
    devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq - 1, limit: 60, offset: 0 }));
    ok('stale seq: dropped', state.items.length === before);

    /* Enter fires Place (top hit) — capture stAct */
    const acts = [];
    const realAct = window.stAct;
    window.stAct = function (a) { acts.push(JSON.parse(a)); };
    ui.q = 'chair'; ui.type = 'all';
    state.seq++; devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    activate(flatRows()[0]);
    ok('place: Enter fires stAct op=place', acts.length === 1 && acts[0].op === 'place');

    /* plugin chip browse scopes */
    setPlugin('CoolClutter.esp');
    devQuery(JSON.stringify({ q: '', type: 'all', plugin: 'CoolClutter.esp', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('plugin browse: only its objects', state.items.length >= 1 && state.items.every(function (it) { return it.p === 'CoolClutter.esp'; }));
    ok('plugin chip: visible', $('st-plug-chip') && !$('st-plug-chip').classList.contains('hidden'));
    clearPlugin();

    /* type pill scopes */
    ui.type = 'cont'; ui.q = '';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'cont', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    ok('type pill: containers only', state.items.length >= 1 && state.items.every(function (it) { return it.t === 'cont'; }));
    ui.type = 'all';

    /* Campfire pill: tree + subcats + campplace op */
    ui.type = 'camp'; ui.campSub = ''; ui.q = '';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'all', plugin: '', cat: 'camp', sub: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('campfire tree: subcategory row present', document.querySelectorAll('#st-cats .st-camp-sub').length === CAMP_SUBS.length + 1);
    ok('campfire: tentapalooza folds in', state.items.some(function (it) { return it.p === 'Tentapalooza.esp'; }));
    ok('campfire: unleashed stand-down row', !!document.querySelector('#st-cats .st-camp-unleashed'));
    const acts2 = [];
    window.stAct = function (a) { acts2.push(JSON.parse(a)); };
    doPlace(state.items.filter(function (it) { return it.camp; })[0]);
    ok('campfire: row places via campplace', acts2.length === 1 && acts2[0].op === 'campplace');
    /* subcategory scope */
    ui.campSub = 'fire';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'all', plugin: '', cat: 'camp', sub: 'fire', seq: state.seq, limit: 60, offset: 0 }));
    ok('campfire: subcategory scopes rows', state.items.length >= 1 && state.items.every(function (it) { return it.sub === 'fire'; }));
    ui.type = 'all'; ui.campSub = '';
    window.stAct = realAct;

    /* catalogs: add / rename / del / reorder / file / unfile */
    const cats0 = state.catalogs.length;
    devCat(JSON.stringify({ op: 'add', name: 'Test Cat' }));
    ok('catalog: add', state.catalogs.length === cats0 + 1);
    const newId = state.catalogs[state.catalogs.length - 1].id;
    devCat(JSON.stringify({ op: 'rename', catId: newId, name: 'Renamed' }));
    ok('catalog: rename', catName(newId) === 'Renamed');
    devCat(JSON.stringify({ op: 'reorder', order: state.catalogs.map(function (c) { return c.id; }).reverse() }));
    ok('catalog: reorder keeps all', state.catalogs.length === cats0 + 1);
    /* file a row via context menu path */
    ui.q = 'chair'; state.seq++;
    devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    const catActs = [];
    const realCat = window.stCat;
    window.stCat = function (a) { catActs.push(JSON.parse(a)); devCat(a); };
    fileRow(newId, state.items[0].id);
    ok('catalog: file sends op=file', catActs.some(function (c) { return c.op === 'file' && c.catId === newId; }));
    unfileRow(newId, state.items[0].id);
    ok('catalog: unfile sends op=unfile', catActs.some(function (c) { return c.op === 'unfile'; }));
    /* export + import round-trip */
    catActs.length = 0;
    catAct({ op: 'export', catId: newId });
    ok('catalog: export sends op=export', catActs.some(function (c) { return c.op === 'export'; }));
    beginImport();
    ok('catalog: importscan sends op=importscan', catActs.some(function (c) { return c.op === 'importscan'; }));
    /* import creates a catalog */
    const catsB = state.catalogs.length;
    devCat(JSON.stringify({ op: 'import', file: 'shared-camp.json' }));
    ok('catalog: import creates a catalog', state.catalogs.length === catsB + 1);
    /* del refiles-not-destroys (removes only membership; object entry survives) */
    devCat(JSON.stringify({ op: 'del', catId: newId }));
    ok('catalog: del removes the catalog', !catById(newId));
    window.stCat = realCat;

    /* Catalogs: the rail filter's Enter, and the "File into…" menu's own filter.
       Both list the SAME set, so both use the same 8+ threshold. */
    (function () {
      const keepCats = state.catalogs.slice();
      const keepScope = ui.catScope;
      state.catalogs = [];
      for (let i = 0; i < 9; i++) {
        state.catalogs.push({ id: 'k' + i, count: i,
          name: (i === 6 ? 'Named Catalog' : 'Catalog ' + i) });
      }
      ui.catFilter = ''; ui.catScope = ''; ui.placedView = false;
      renderCats();
      ok('catalogs: rail filter appears past 8', !!$('st-cat-filter-input'));

      /* Enter on the rail filter scopes to the top hit, exactly as clicking
         that chip would */
      ui.catFilter = 'riverwood'; renderCats();
      const rf = $('st-cat-filter-input');
      if (rf) rf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      ok('catalogs: Enter scopes to the top hit', ui.catScope === 'k6');
      ui.catScope = ''; ui.catFilter = ''; renderCats();

      /* the per-row "File into…" menu */
      state.items = [{ id: 'i1', n: 'Wooden Chair', p: 'Skyrim.esm', k: 'furn', cat: '' }];
      openRowCatMenu('i1', 40, 40);
      const menu = $('st-catmenu');
      ok('file-into: menu lists every catalog',
        !!menu && menu.querySelectorAll('.st-cm-item[data-file]').length === 9);
      ok('file-into: filter appears past 8', !!$('st-cm-find-in'));

      const cin = $('st-cm-find-in');
      cin.value = 'riverwood';
      cin.dispatchEvent(new Event('input', { bubbles: true }));
      const vis = function () {
        return Array.prototype.filter.call(
          menu.querySelectorAll('.st-cm-item[data-file]'),
          function (b) { return !b.classList.contains('st-cm-nomatch'); }).length;
      };
      ok('file-into: filter narrows to the match', vis() === 1);

      cin.value = 'zzzz';
      cin.dispatchEvent(new Event('input', { bubbles: true }));
      ok('file-into: honest empty result',
        vis() === 0 && !!menu.querySelector('#st-cm-none.st-cm-show'));

      /* Enter files into the top hit */
      cin.value = 'riverwood';
      cin.dispatchEvent(new Event('input', { bubbles: true }));
      const filed = [];
      const keepCat = window.stCat;
      window.stCat = function (a) { filed.push(JSON.parse(a)); };
      cin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.stCat = keepCat;
      ok('file-into: Enter files into the top hit',
        filed.some(function (p) { return p.op === 'file' && p.catId === 'k6'; }));
      ok('file-into: Enter closes the menu', !$('st-catmenu'));

      /* under the threshold the menu stays a plain list */
      state.catalogs = keepCats;
      openRowCatMenu('i1', 40, 40);
      ok('file-into: no filter box under the threshold', !$('st-cm-find-in'));
      closeCatMenu();

      state.items = []; ui.catScope = keepScope; ui.catFilter = '';
      renderCats();
    })();

    /* My placements roster */
    ui.type = 'all'; ui.q = '';
    togglePlacedView();
    devPlaced();
    render();
    ok('placements: roster renders', document.querySelectorAll('#st-body .st-placed-row').length === 2);
    const pacts = [];
    window.stAct = function (a) { pacts.push(JSON.parse(a)); };
    doJumpTo(state.placed[0]);
    ok('placements: jump-to fires stAct op=jumpto', pacts.some(function (p) { return p.op === 'jumpto'; }));
    doRemovePlaced(state.placed[1]);
    ok('placements: remove fires stAct op=remove', pacts.some(function (p) { return p.op === 'remove'; }));
    window.stAct = realAct;

    /* placements filter — appears only past the 8-row threshold, narrows on
       rendered text, survives the re-render, and Enter travels to the top hit */
    ok('placements: no filter box under the threshold', !$('st-placed-filter-input'));
    (function () {
      const many = [];
      for (let i = 0; i < 9; i++) {
        many.push({ id: 'FF0020' + i, name: (i === 3 ? 'Alchemy Table' : 'Wooden Chair ' + i),
          kind: (i === 3 ? 'furn' : 'stat'), cell: (i === 3 ? 'Whiterun' : 'Riverwood') });
      }
      window.stPlacedResult({ items: many });
      render();
      ok('placements: filter box appears past 8 rows', !!$('st-placed-filter-input'));
      ok('placements: all rows before filtering',
        document.querySelectorAll('#st-body .st-placed-row').length === 9);

      ui.placedFilter = 'alchemy';
      renderPlaced();
      ok('placements: filter narrows to the match',
        document.querySelectorAll('#st-body .st-placed-row').length === 1);
      ok('placements: filter query survives the re-render',
        ($('st-placed-filter-input') || {}).value === 'alchemy');
      ok('placements: match count shown', !!document.querySelector('.st-sect-n'));

      /* the filter reads the CELL and the kind label too, not just the name */
      ui.placedFilter = 'whiterun';
      renderPlaced();
      ok('placements: filter matches the cell',
        document.querySelectorAll('#st-body .st-placed-row').length === 1);

      ui.placedFilter = 'zzzz';
      renderPlaced();
      ok('placements: honest empty result', !!document.querySelector('.st-placed-none') &&
        document.querySelectorAll('#st-body .st-placed-row').length === 0);

      /* Enter takes the top hit — for a placement that means travelling to it */
      ui.placedFilter = 'alchemy';
      renderPlaced();
      const ents = [];
      const keepAct = window.stAct;
      window.stAct = function (a) { ents.push(JSON.parse(a)); };
      const fin = $('st-placed-filter-input');
      if (fin) fin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      window.stAct = keepAct;
      ok('placements: Enter travels to the top hit',
        ents.some(function (p) { return p.op === 'jumpto' && p.id === 'FF00203'; }));

      ui.placedFilter = '';
    })();

    /* empty placements state */
    state.placed = [];
    render();
    ok('placements: empty state present', !$('st-empty').classList.contains('hidden') &&
      $('st-empty').textContent.indexOf('save') !== -1);
    ui.placedView = false; state.placed = null;

    /* Move button honest OMO-absent label */
    ui.omoAbsent = true;
    ui.q = 'chair'; state.seq++;
    devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('move: OMO-absent honest label', (function () {
      const mv = document.querySelector('#st-body .st-do.st-do-fallback');
      return !!mv && /arrow/i.test(mv.getAttribute('title') || '');
    })());
    ui.omoAbsent = false;

    /* pagination */
    ok('pageCount: computed from total', (function () { state.total = 120; return pageCount() === Math.ceil(120 / ui.pageSize); })());
    ok('clampPageSize: snaps to legal', clampPageSize(33) === 25 || clampPageSize(33) === 50);

    /* icon fallback: a row with no rendered model keeps its glyph and renders */
    ui.q = 'chair'; state.seq++;
    devQuery(JSON.stringify({ q: 'chair', type: 'all', plugin: '', cat: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('icon fallback: glyph shown when no PNG', (function () {
      const g = document.querySelector('#st-body .st-glyph');
      return !!g && !g.querySelector('img.st-art');
    })());

    /* icon upgrade: hd-item-icons event + a resolvable path swaps glyph -> img */
    (function () {
      const it = state.items[0];
      const p = idParts(it.id);
      const realWP = window.WardrobePane;
      window.WardrobePane = { itemIconFor: function (q) {
        return (q.formId === p.formId && q.plugin === p.plugin) ? 'icons/items/' + p.plugin.toLowerCase() + '-' + p.formId.slice(2).toLowerCase() + '.png' : '';
      } };
      renderBody();
      ok('icon upgrade: img mounted when path resolves', !!document.querySelector('#st-body .st-glyph.st-has-art img.st-art'));
      /* settle gate: no whIcons request until settled (we assert the request fn was called via flush) */
      const sent = [];
      const realWh = window.whIcons;
      window.whIcons = function (a) { sent.push(JSON.parse(a)); };
      /* clear one row's art so requestIcons has work */
      window.WardrobePane = { itemIconFor: function () { return ''; } };
      ui.iconReq = {};
      flushIconsForTest();
      window.whIcons = realWh;
      ok('settle gate: whIcons requested on flush', sent.length >= 1 && Array.isArray(sent[0].items));
      window.WardrobePane = realWP;
    })();

    /* lightbox open + turntable candidates + stSpin sent */
    (function () {
      const p = idParts('Skyrim.esm|000BB9DA');
      const realWP = window.WardrobePane;
      window.WardrobePane = { itemIconFor: function () { return 'icons/items/skyrim-000bb9da.png'; } };
      const spins = [];
      const realSpin = window.stSpin;
      window.stSpin = function (a) { spins.push(JSON.parse(a)); };
      let opened = null;
      const realLB = window.HDLightbox;
      window.HDLightbox = { open: function (o) { opened = o; }, close: function () {} };
      openLightbox({ id: 'Skyrim.esm|000BB9DA', n: 'Wooden Chair', t: 'furn', p: 'Skyrim.esm' });
      ok('lightbox: opened with 3 turntable candidates', !!opened && opened.frames && opened.frames.length === 3 &&
        opened.frames[0].indexOf('-a090.png') !== -1);
      ok('lightbox: stSpin requested', spins.length === 1 && spins[0].id === 'Skyrim.esm|000BB9DA');
      window.HDLightbox = realLB; window.stSpin = realSpin; window.WardrobePane = realWP;
    })();

    /* omni provider registered */
    ok('omni: provider registered', !!(window.HDOmni && HDOmni.providerById && HDOmni.providerById('settle')));

    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    if (document.body) document.body.append(box);
    console.log(out.join('\n'));
    window.__selftest = { out: out, fails: fails.length };
    window.__fdSelftest = { pass: out.length - fails.length, total: out.length, results: out };
  }

  /* ---- Omni search provider ------------------------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'settle', label: 'Settlement', tab: 'settle',
    setFilter: setFilter,
    index: function () {
      return [{
        label: 'Settlement',
        detail: 'place objects, statics, camp',
        kind: 'settle',
        keywords: 'settlement object static furniture place spawn build campfire catalog container activator tree light',
      }];
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _flushIcons: flushIconsForTest, _iconPollTick: iconPollTick, _missingArt: missingArt,
    _state: state, _ui: ui, _flatRows: flatRows, _modMatches: modMatches,
    _openLightbox: openLightbox, _rowLoading: rowLoading, _renderWindowActive: renderWindowActive,
    _armWindow: function () { chipLastLand = Date.now(); },
    _closeWindow: function () { chipLastLand = 1; },
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _doPlace: doPlace, _fileRow: fileRow, _togglePlaced: togglePlacedView,
    _catName: catName, _catById: catById,
    /* opened by the row's ⋯ button in play; exported so the overlap harness can
       measure the popup without synthesising the click that positions it */
    _openRowCatMenu: openRowCatMenu, _closeCatMenu: closeCatMenu,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.SettlementPane.init(); });
} else {
  window.SettlementPane.init();
}
