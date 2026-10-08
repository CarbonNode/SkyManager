'use strict';

/* ====================================================================== *
 *  Items — the inline item explorer (Rober, 2026-08-13: "think additemmenu
 *  but you can just straight up type in a esp or esl name, a mod item name
 *  … one unified highly polished search bar think google, with maybe pills
 *  … then like a toggle to ask if you want to set a price - asks the price
 *  or just freely give it to yourself").
 *
 *  C++ owns the index, the matching and the add (item_explorer.cpp); this
 *  pane owns the ONE bar, the pills, merchant mode and the price sheet.
 *
 *  Bridge — requests: ixState() · ixQuery(json) · ixAdd(json) · ixSave(json)
 *  Replies (disjoint, per the deck law): ixStateResult({phase,count,gold,pay,
 *  mult,plugins}) · ixResultData({seq,total,offset,items}) · ixAddResult(
 *  {ok,msg,gold}) · ixSaved({ok,pay,mult})
 *
 *  Modify (2026-08-17, the PROTEUS-class base-record editor — item_edit.cpp):
 *  requests ieGet/ieApply/ieRevert/ieList/ieEnch · replies ieGetResult/
 *  ieApplyResult/ieRevertResult/ieListResult/ieEnchResult. The ✎ button in a
 *  row's detail block opens the edit sheet; edits change EVERY copy of the
 *  item, persist in the DLL's item-edits.json sidecar across launches, and
 *  revert live from stored originals.
 *
 *  Host contract (mirrors KeysPane): ItemsPane.init() · onShow() · onHide() ·
 *  toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.ItemsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;   // per keystroke, before the C++ query fires

  /* Pagination (Rober, 2026-08-14: "the finder page should probably be
     paginated with options to show how many per page … maybe default to 10?").
     A page is ONE query slice — state.items holds exactly the current page and
     never accumulates, so only the drawn rows request a render. Items are the
     cheaper 512px renders, so this pane defaults to 25 (the NPC pane, whose
     faces are 1024px, defaults to 10 — same control, different sensible default). */
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;

  /* ============================================================== kinds == */

  /* kind key -> [label, glyph]. Order = the pill row. 'all' and 'mods' are
     pseudo-kinds the C++ never sees ('mods' searches plugin names only). */
  const KINDS = [
    ['all',  'Everything', '⌕'],
    ['mods', 'Mods',       '📦'],
    ['weap', 'Weapons',    '⚔'],
    ['armo', 'Armor',      '🛡'],
    ['alch', 'Potions',    '🧪'],
    ['food', 'Food',       '🍖'],
    ['ingr', 'Ingredients','🌿'],
    ['book', 'Books',      '📕'],
    ['scrl', 'Scrolls',    '📜'],
    ['slgm', 'Soul Gems',  '🔮'],
    ['misc', 'Misc',       '💎'],
    ['ammo', 'Ammo',       '➶'],
    ['keym', 'Keys',       '🗝'],
    ['ligh', 'Torches',    '🕯'],
  ];

  function kindMeta(t) {
    for (let i = 0; i < KINDS.length; i++) if (KINDS[i][0] === t) return KINDS[i];
    return ['misc', 'Item', '❖'];
  }

  /* ============================================================== state == */

  const state = {
    ready: false,
    count: 0,
    gold: -1,        // -1 = unknown (SEH sentinel) — shown as "?"
    pay: false,
    mult: 1,
    inspect3d: true, // the lightbox's "Turn in 3D" switch (item-explorer.json inspect3d)
    plugins: [],     // [{n,c,k,l}] — matched locally for the Mods section
    seq: 0,          // last query seq we SENT; stale replies are dropped
    total: 0,
    items: [],       // accumulated rows for the current query (paging appends)
    awaiting: false,
    askedOnce: false,
    editedSet: {},   // item id -> edited-field count (from ieListResult) — drives the ✎ chips
    edited: [],      // the same reply's rows [{id,n,p,fields}] — omni needs the NAMES
  };

  const ui = {
    q: '',
    type: 'all',
    plugin: '',
    plugFilter: '',      // secondary fuzzy filter on the OWNING plugin name (client-side)
    plugFilterOpen: false,
    sel: 0,          // index into flatRows()
    pageSize: DEFAULT_PAGE_SIZE,  // rows per page — restored from state, persisted on change
    page: 0,                      // current page, 0-based — SESSION-ONLY, never persisted
    qty: {},         // item id -> chosen quantity (default 1)
    visible: false,
    debT: null,
    sheet: null,     // {item, qty} while the price sheet is up
    toastT: null,
    iconAskSig: '',  // the missing-art keys of the last render ask ('' = none open)
    iconT: null,     // the settle timer before icons are requested for a query
    iconPollT: null, // on-disk index poll while drawn rows still lack art
    iconPollN: 0,
    hintSeen: false, // the first-open "art renders in the background" hint
    /* Rich detail (2026-08-15): the expanded row's info (damage/armor/enchants/
       effects/keywords). `expanded` is the id of the row currently open (only one
       at a time, keyboard-navigable); `detail` caches computed blocks by id so
       re-expanding is instant and a page repaint never re-asks. `detailErr` holds
       an honest "couldn't read" reason per id. */
    expanded: '',
    detail: {},
    detailErr: {},
    /* Modify sheet (2026-08-17): {id, it, data(null until ieGetResult),
       pendingEnch(undefined|'none'|id), pendingEnchName, enchOpen, enchRows,
       busy} while the edit sheet is up. */
    editSheet: null,
    enchT: null,     // debounce timer for the enchantment picker's search
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'ixState') setTimeout(devState, 30);
      if (DEV && fn === 'ixQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'ixAdd') setTimeout(function () { devAdd(arg); }, 30);
      if (DEV && fn === 'ixSave') setTimeout(function () { devSave(arg); }, 30);
      if (DEV && fn === 'ieGet') setTimeout(function () { devIeGet(arg); }, 30);
      if (DEV && fn === 'ieApply') setTimeout(function () { devIeApply(arg); }, 30);
      if (DEV && fn === 'ieRevert') setTimeout(function () { devIeRevert(arg); }, 30);
      if (DEV && fn === 'ieList') setTimeout(devIeList, 30);
      if (DEV && fn === 'ieEnch') setTimeout(function () { devIeEnch(arg); }, 30);
    }
  }

  window.ixStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.phase === 'ready';
    state.count = d.count | 0;
    state.gold = (typeof d.gold === 'number') ? d.gold : -1;
    state.pay = !!d.pay;
    state.mult = Number(d.mult) || 1;
    /* An old DLL sends no inspect3d and has no inspector: the toggle hides. */
    state.inspect3d = typeof d.inspect3d === 'boolean' ? d.inspect3d : null;
    /* Persisted page size from the DLL. Absent (an old DLL) => keep our default,
       so the pane still paginates — old-DLL tolerance in the read direction. */
    if (typeof d.pageSize === 'number' && d.pageSize > 0) ui.pageSize = clampPageSize(d.pageSize);
    state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
    if (ui.visible) {
      /* A query typed before the index answered (or carried over from the last
         open) now has something to run against. */
      if (state.ready && (ui.q || ui.plugin || ui.type !== 'all') && !state.items.length && !state.awaiting)
        runQuery(true);
      render();
    }
  };

  window.ixResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    /* Detail reply (a row expansion) rides this SAME listener — keyed by the
       `detail` field a page reply never carries — so no new C++ bridge was
       needed. Cache it and patch only the open row's detail block in place, so
       a landing detail never rebuilds the whole list. It is NOT gated on seq:
       the detail seq is the page's seq at expand time, but a detail can arrive
       after the next page query bumped state.seq (a fast typer), and dropping
       it would leave the block spinning forever. */
    if (typeof d.detail === 'string' && d.detail) {
      const hasInfo = d.info && typeof d.info === 'object' && Object.keys(d.info).length > 0;
      if (hasInfo) ix.detailCacheSet(d.detail, d.info, '');
      else ix.detailCacheSet(d.detail, null, d.err || 'Could not read this item');
      if (ui.visible && ui.expanded === d.detail) patchDetailInPlace(d.detail);
      return;
    }
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
    /* A page REPLACES — state.items is exactly the current page, never the
       accumulation the old "Show more" foot built up. This is what shrinks the
       render burst with page size: requestIcons() only ever sees one page. */
    state.items = Array.isArray(d.items) ? d.items : [];
    /* A page that no longer exists (total shrank under a stale offset) — step
       back to the last real page and re-ask. */
    if (!state.items.length && state.total > 0 && ui.page > 0 &&
        ui.page * ui.pageSize >= state.total) {
      ui.page = Math.max(0, Math.ceil(state.total / ui.pageSize) - 1);
      runQuery(false);
      return;
    }
    ui.sel = 0;
    if (ui.visible) render();
  };

  window.ixAddResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.gold === 'number') state.gold = d.gold;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (ui.visible) renderHeader();
  };

  /* ---- Modify replies (ie* bridge) -------------------------------------- */

  window.ieGetResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (!ui.editSheet || d.id !== ui.editSheet.id) return;
    if (!d.ok) { closeEditSheet(); toast(d.msg || 'Could not read that item', true); return; }
    ui.editSheet.data = d;
    renderEditSheet();
  };

  /* Apply and revert answer with the same fresh-state shape — fold both into
     one landing: sync the edited set, patch the row's stale name/value/weight,
     drop the cached detail so the next expand re-reads truth. */
  function editLanded(d) {
    if (!d || typeof d !== 'object') return;
    if (!d.ok) { toast(d.msg || 'Failed', true); if (ui.editSheet) ui.editSheet.busy = false; return; }
    const edited = Array.isArray(d.edited) ? d.edited : [];
    if (edited.length) state.editedSet[d.id] = edited.length;
    else delete state.editedSet[d.id];
    if (d.fields && typeof d.fields === 'object') {
      for (let i = 0; i < state.items.length; i++) {
        if (state.items[i].id !== d.id) continue;
        if (typeof d.fields.name === 'string' && d.fields.name) state.items[i].n = d.fields.name;
        if (typeof d.fields.value === 'number') state.items[i].v = d.fields.value;
        if (typeof d.fields.weight === 'number') state.items[i].w = d.fields.weight;
      }
    }
    delete ui.detail[d.id];
    delete ui.detailErr[d.id];
    closeEditSheet();
    toast(d.msg || 'Done', false);
    if (ui.visible) {
      if (ui.expanded === d.id) requestDetail(d.id);
      renderBodyPreservingScroll();
    }
  }

  window.ieApplyResult = function (d) { editLanded(d); };
  window.ieRevertResult = function (d) { editLanded(d); };

  window.ieListResult = function (d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.edits)) return;
    state.editedSet = {};
    /* The rows are kept whole as well: the id->count map drives the ✎ chips,
       but omni has to NAME what a "revert" would undo, and only these rows
       carry the item's name and its owning plugin. */
    state.edited = d.edits.slice();
    for (let i = 0; i < d.edits.length; i++) {
      const e = d.edits[i];
      if (e && e.id) state.editedSet[e.id] = (e.fields | 0) || 1;
    }
    if (ui.visible) renderBodyPreservingScroll();
  };

  window.ieEnchResult = function (d) {
    if (!d || typeof d !== 'object' || !ui.editSheet || !ui.editSheet.enchOpen) return;
    ui.editSheet.enchRows = Array.isArray(d.ench) ? d.ench : [];
    renderEnchResults();
  };

  window.ixSaved = function (d) {
    if (!d || typeof d !== 'object') return;
    state.pay = !!d.pay;
    state.mult = Number(d.mult) || 1;
    if (typeof d.inspect3d === 'boolean') state.inspect3d = d.inspect3d;
    /* pageSize round-trips through the same save reply (item-explorer.json). If
       the DLL snapped it to a different legal value, follow — and re-query so
       the page matches the confirmed size. */
    if (typeof d.pageSize === 'number' && d.pageSize > 0) {
      const p = clampPageSize(d.pageSize);
      if (p !== ui.pageSize) { ui.pageSize = p; ui.page = 0; if (ui.visible) { runQuery(false); return; } }
    }
    if (ui.visible) { renderHeader(); renderBody(); renderFooter(); }
  };

  /* ============================================================ queries == */

  function clampPageSize(n) {
    n = Math.round(Number(n) || 0);
    if (PAGE_SIZES.indexOf(n) !== -1) return n;
    /* not one of the offered sizes (a hand-edited sidecar / an odd DLL value) —
       snap to the nearest legal choice so the selector always highlights one. */
    let best = DEFAULT_PAGE_SIZE, bestD = Infinity;
    for (let i = 0; i < PAGE_SIZES.length; i++) {
      const d = Math.abs(PAGE_SIZES[i] - n);
      if (d < bestD) { bestD = d; best = PAGE_SIZES[i]; }
    }
    return best;
  }

  /* reset (a new query / filter / pill / plugin change) always returns to page
     1; Prev/Next call with reset=false and set ui.page themselves first. Each
     query REPLACES the page — state.items is never carried across. */
  function runQuery(reset) {
    if (reset) { ui.page = 0; chipLastLand = Date.now(); }   // a new search re-arms the render window
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!ui.q && !ui.plugin && ui.type === 'all') {
      /* nothing to ask — the hero state owns the screen */
      state.items = []; state.total = 0; state.awaiting = false; ui.page = 0;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    ui.sel = 0;
    toGame('ixQuery', JSON.stringify({
      q: ui.q, type: ui.type === 'mods' ? 'all' : ui.type, plugin: ui.plugin,
      limit: ui.pageSize, offset: ui.page * ui.pageSize, seq: state.seq,
    }));
    render();
  }

  /* ---- pagination controls ------------------------------------------------ */

  function pageCount() {
    if (ui.pageSize <= 0) return 1;
    return Math.max(1, Math.ceil((state.total || 0) / ui.pageSize));
  }

  /* Jump to a page (clamped). Prev/Next and PgUp/PgDn route through here; it
     re-queries the new slice, so the render window follows the page. */
  function gotoPage(p) {
    const pc = pageCount();
    p = Math.max(0, Math.min(pc - 1, Math.round(p) || 0));
    if (p === ui.page) return;
    ui.page = p;
    chipLastLand = Date.now();     // a new page re-arms the render window for its rows
    runQuery(false);
    const body = $('ix-body');
    if (body) body.scrollTop = 0;  // a fresh page reads from the top
    const s = $('ix-search');
    if (s) s.focus();
  }

  /* The per-page selector. Persists through the module's sidecar (ixSave, which
     already round-trips pay/mult) AND resets to page 1 — a smaller page from
     deep in a big result set would otherwise land on an out-of-range page. */
  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    toGame('ixSave', JSON.stringify({ pageSize: ui.pageSize }));
    runQuery(false);
  }

  /* The 3D inspector switch — the same sidecar as pay/mult/pageSize. Optimistic;
     ixSaved confirms. An open lightbox learns it from its next hdSpinState. */
  function setInspect3d(on) {
    if (state.inspect3d === null) return;   // an old DLL has no inspector
    state.inspect3d = !!on;
    renderHeader();
    toGame('ixSave', JSON.stringify({ inspect3d: state.inspect3d }));
  }

  function queryDebounced() {
    if (ui.debT) clearTimeout(ui.debT);
    ui.debT = setTimeout(function () { ui.debT = null; runQuery(true); }, DEBOUNCE_MS);
  }

  /* Matching MODS, locally: every token must appear in the plugin name.
     Count-heavy plugins first — the big content mods are the likely target. */
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

  /* ================================================ secondary plugin filter ==
     A fuzzy, client-side narrowing on the OWNING plugin name (Rober, 2026-08-14:
     after typing an item name, narrow "122 rows across arnima.esm / miranda.esp"
     down to one plugin, typing a partial esp/esl/esm name). It composes with the
     name search, the pills and the mod-chip browse; it never touches C++ (the
     `ux.plugin` browse is EXACT — this is the loose companion). Fuzzy = case-
     insensitive substring on the whole query first, then a per-token substring,
     then a subsequence fallback so "mrnd" still finds "miranda.esp".
     Because results are server-paginated, this filters the CURRENT page's rows;
     the section header shows the on-page filtered count so it stays honest. */
  function pluginFuzzy(pluginName, query) {
    const p = String(pluginName || '').toLowerCase();
    const q = String(query || '').toLowerCase().trim();
    if (!q) return true;
    if (p.indexOf(q) !== -1) return true;                      // whole-query substring
    const toks = q.split(/\s+/).filter(Boolean);
    if (toks.length > 1 && toks.every(function (t) { return p.indexOf(t) !== -1; })) return true;
    /* subsequence: every char of the (spaceless) query appears in order */
    const chars = q.replace(/\s+/g, '');
    let i = 0;
    for (let c = 0; c < p.length && i < chars.length; c++) if (p[c] === chars[i]) i++;
    return i === chars.length;
  }

  /* Does the secondary plugin filter keep this item row? Empty filter keeps all. */
  function passesPlugFilter(it) {
    if (!ui.plugFilter) return true;
    return pluginFuzzy(it && it.p, ui.plugFilter);
  }

  /* ====================================================== selection model == */

  /* Everything the keyboard can land on, in visual order: mod rows first,
     then item rows, then the Show-more foot. */
  function flatRows() {
    const rows = [];
    if (showsModSection()) {
      modMatches(ui.type === 'mods' ? 30 : 5).forEach(function (p) { rows.push({ kind: 'plug', p: p }); });
    }
    if (ui.type !== 'mods') {
      state.items.forEach(function (it) {
        if (passesPlugFilter(it)) rows.push({ kind: 'item', it: it });
      });
      /* no 'more' row — paging is the footer bar under the list now */
    }
    return rows;
  }

  function showsModSection() {
    if (ui.plugin) return false;             // already inside one mod
    if (ui.type === 'mods') return true;     // the Mods pill: only mods
    return ui.type === 'all' && !!ui.q;      // unified search: mods ride on top
  }

  function activate(row) {
    if (!row) return;
    if (row.kind === 'plug') { setPlugin(row.p.n); return; }
    if (row.kind === 'item') {
      const qty = ui.qty[row.it.id] || 1;
      if (state.pay) openSheet(row.it, qty);
      else takeItem(row.it, qty, false, 0);
    }
  }

  /* ============================================================= actions == */

  function takeItem(it, qty, pay, price) {
    toGame('ixAdd', JSON.stringify({ id: it.id, count: qty, pay: !!pay, price: price | 0 }));
  }

  function setPlugin(name) {
    ui.plugin = String(name || '');
    ui.q = '';
    ui.plugFilter = '';           // browsing INSIDE a mod makes the fuzzy filter redundant
    ui.plugFilterOpen = false;
    const s = $('ix-search');
    if (s) { s.value = ''; s.focus(); }
    if (ui.type === 'mods') ui.type = 'all';
    runQuery(true);
  }

  function clearPlugin() {
    ui.plugin = '';
    runQuery(true);
    const s = $('ix-search');
    if (s) s.focus();
  }

  function suggestedPrice(it, qty) {
    const v = Math.max(0, it.v | 0);
    return Math.max(0, Math.round(v * (state.mult || 1))) * qty;
  }

  /* ========================================================= price sheet == */

  function openSheet(it, qty) {
    ui.sheet = { item: it, qty: qty };
    renderSheet();
  }

  function closeSheet() {
    ui.sheet = null;
    const sh = $('ix-sheet');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; }
    const s = $('ix-search');
    if (s) s.focus();
  }

  /* A render for the sheet's item arrived — drop the picture into the plate in
     place, so the open sheet upgrades without rebuilding (which would eat the
     price the user is typing). No-op if it already has art or none exists. */
  function refreshSheetArt() {
    if (!ui.sheet) return;
    const sh = $('ix-sheet');
    if (!sh) return;
    const plate = sh.querySelector('.ix-sheet-glyph');
    if (!plate || plate.classList.contains('ix-has-art')) return;
    const url = iconFor(ui.sheet.item.id);
    if (!url) return;
    const img = document.createElement('img');
    img.className = 'ix-art';
    img.src = url;
    img.alt = '';
    img.draggable = false;
    img.onerror = function () { plate.classList.remove('ix-has-art'); if (img.parentNode) img.parentNode.removeChild(img); };
    plate.classList.add('ix-has-art');
    plate.appendChild(img);
  }

  function renderSheet() {
    const sh = $('ix-sheet');
    if (!sh || !ui.sheet) return;
    const it = ui.sheet.item;
    const qty = ui.sheet.qty;
    const val = Math.max(0, it.v | 0) * qty;
    const sug = suggestedPrice(it, qty);
    const meta = kindMeta(it.t);
    const hasArt = !!iconFor(it.id);
    sh.classList.remove('hidden');
    sh.innerHTML =
      '<div class="ix-sheet-card">' +
      '<div class="ix-sheet-title">Name the price</div>' +
      '<div class="ix-sheet-item">' +
      '<div class="ix-glyph ix-sheet-glyph ix-t-' + esc(it.t) + (hasArt ? ' ix-has-art' : '') +
      '" title="' + esc(meta[1]) + '">' + glyphInner(it.id, meta[2]) + '</div>' +
      '<div class="ix-sheet-item-txt"><b title="' + esc(it.n) + '">' + esc(it.n) + (qty > 1 ? ' ×' + qty : '') + '</b>' +
      '<span title="' + esc(meta[1]) + ' · ' + esc(it.p) + '">' + esc(meta[1]) + ' · ' + esc(it.p) + ' · worth ' + fmtGold(val) + ' g</span></div></div>' +
      '<div class="ix-sheet-row"><span class="ix-sheet-label">Price</span>' +
      '<input id="ix-price" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="' + sug + '">' +
      '<span class="ix-sheet-label">gold</span></div>' +
      '<div class="ix-sheet-row">' +
      '<button class="ix-pill" data-price="' + val + '">Value · ' + fmtGold(val) + '</button>' +
      '<button class="ix-pill" data-price="' + (val * 2) + '">×2 · ' + fmtGold(val * 2) + '</button>' +
      '<button class="ix-pill" data-price="' + (val * 5) + '">×5 · ' + fmtGold(val * 5) + '</button>' +
      '<button class="ix-pill" data-price="0">Free</button>' +
      '</div>' +
      '<div id="ix-sheet-note" class="ix-sheet-note"></div>' +
      '<div class="ix-sheet-actions">' +
      '<button id="ix-sheet-cancel" class="ix-btn">Cancel</button>' +
      '<button id="ix-sheet-pay" class="ix-pay">Pay</button>' +
      '</div></div>';

    const price = $('ix-price');
    const note = $('ix-sheet-note');
    const pay = $('ix-sheet-pay');

    function current() {
      const n = parseInt(String(price.value).replace(/[^0-9]/g, ''), 10);
      return isNaN(n) ? 0 : Math.min(n, 100000000);
    }
    function refresh() {
      const p = current();
      const short = state.gold >= 0 && p > state.gold;
      pay.disabled = short;
      pay.textContent = p > 0 ? ('Pay ' + fmtGold(p) + ' g & take') : 'Take for free';
      note.textContent = state.gold < 0 ? 'Your gold could not be read — the game will still refuse if you cannot pay.'
        : short ? ('You carry ' + fmtGold(state.gold) + ' g — that is ' + fmtGold(p - state.gold) + ' short.')
          : ('You carry ' + fmtGold(state.gold) + ' g.');
      note.classList.toggle('ix-short', short);
    }
    price.addEventListener('input', refresh);
    price.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !pay.disabled) { e.stopPropagation(); doPay(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); }
    });
    sh.querySelectorAll('.ix-pill[data-price]').forEach(function (b) {
      b.addEventListener('click', function () {
        price.value = b.getAttribute('data-price');
        refresh();
        price.focus();
      });
    });
    function doPay() {
      const p = current();
      const it2 = ui.sheet && ui.sheet.item;
      const q2 = ui.sheet ? ui.sheet.qty : 1;
      closeSheet();
      if (it2) takeItem(it2, q2, p > 0, p);
    }
    pay.addEventListener('click', doPay);
    const sheetPlate = sh.querySelector('.ix-sheet-glyph');
    if (sheetPlate) sheetPlate.addEventListener('click', function () {
      if (sheetPlate.classList.contains('ix-has-art')) openLightbox(it);
    });
    $('ix-sheet-cancel').addEventListener('click', closeSheet);
    sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
    refresh();
    setTimeout(function () { price.focus(); price.select(); }, 30);
  }

  /* ========================================================= edit sheet == */

  /* Modify (2026-08-17) — the PROTEUS-class base-record editor. Numeric field
     spec per kind: [key, label, step, decimals]. name/value/weight are common;
     ench/charge render as their own block when the reply carries them. */
  const EDIT_NUM_FIELDS = {
    weap: [
      ['damage', 'Damage', 1, 0], ['crit', 'Crit damage', 1, 0],
      ['speed', 'Speed', 0.05, 2], ['reach', 'Reach', 0.05, 2],
      ['stagger', 'Stagger', 0.05, 2],
    ],
    armo: [['armor', 'Armor rating', 1, 1]],
    ammo: [['damage', 'Damage', 1, 1]],
    other: [],
  };
  const EDIT_COMMON = [['value', 'Value (gold)', 1, 0], ['weight', 'Weight', 0.1, 1]];

  function openEditSheet(it) {
    closeSheet();                       // one sheet at a time in #ix-sheet
    ui.editSheet = { id: it.id, it: it, data: null, pendingEnch: undefined,
      pendingEnchName: '', enchOpen: false, enchRows: [], busy: false };
    renderEditSheet();                  // loading skeleton until ieGetResult
    toGame('ieGet', JSON.stringify({ id: it.id }));
  }

  function closeEditSheet() {
    if (!ui.editSheet) return;
    ui.editSheet = null;
    if (ui.enchT) { clearTimeout(ui.enchT); ui.enchT = null; }
    const sh = $('ix-sheet');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; }
    const s = $('ix-search');
    if (s) s.focus();
  }

  /* Typed-but-unapplied values must survive a sheet re-render (opening the
     enchantment picker, picking a hit) — snapshot the live inputs first and
     let the render prefer the snapshot over the record's fields. */
  function captureEditDraft() {
    const es = ui.editSheet;
    const sh = $('ix-sheet');
    if (!es || !sh) return;
    const draft = es.draft || (es.draft = {});
    const nameEl = $('ix-ed-name');
    if (nameEl) draft.name = nameEl.value;
    sh.querySelectorAll('.ix-ed-field[data-step]').forEach(function (row) {
      const input = row.querySelector('.ix-ed-num');
      if (input) draft[row.getAttribute('data-key')] = input.value;
    });
    const chargeEl = $('ix-ed-charge');
    if (chargeEl) draft.charge = chargeEl.value;
  }

  function editNumRow(key, label, step, dec, cur, origVal, draft) {
    const edited = origVal !== undefined && origVal !== null;
    let shown = dec > 0 ? (Math.round(Number(cur) * Math.pow(10, dec)) / Math.pow(10, dec)) : Math.round(Number(cur));
    if (draft && draft[key] !== undefined) shown = draft[key];
    return '<div class="ix-ed-field" data-key="' + esc(key) + '" data-step="' + step + '" data-dec="' + dec + '">' +
      '<span class="ix-ed-label">' + esc(label) + '</span>' +
      '<span class="ix-ed-ctrl">' +
      '<button class="ix-ed-step" data-d="-1" title="Less">−</button>' +
      '<input class="ix-ed-num" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + shown + '">' +
      '<button class="ix-ed-step" data-d="1" title="More">+</button>' +
      '</span>' +
      /* the title carries the VALUE, not the explainer — when the marker is
         narrow this tooltip is the only way back to the number Revert restores */
      (edited ? '<span class="ix-ed-was" title="Was ' + esc(String(origVal)) +
        ' before this Modify edit — Revert restores it">was ' +
        esc(String(origVal)) + '</span>' : '<span class="ix-ed-was"></span>') +
      '</div>';
  }

  function renderEditSheet() {
    const sh = $('ix-sheet');
    if (!sh || !ui.editSheet) return;
    const es = ui.editSheet;
    sh.classList.remove('hidden');

    if (!es.data) {
      sh.innerHTML = '<div class="ix-sheet-card ix-ed-card">' +
        '<div class="ix-sheet-title">✎ Modify</div>' +
        '<div class="ix-detail-load"><span class="ix-detail-spin"></span> Reading the record…</div></div>';
      sh.onclick = function (e) { if (e.target === sh) closeEditSheet(); };
      return;
    }

    const d = es.data;
    const f = d.fields || {};
    const orig = d.orig || {};
    const kind = d.kind || 'other';
    const meta = kindMeta(es.it ? es.it.t : 'misc');
    const nums = (EDIT_NUM_FIELDS[kind] || []).concat(EDIT_COMMON)
      .filter(function (r) { return f[r[0]] !== undefined; });

    /* enchantment block — only when the form is enchantable */
    let enchHtml = '';
    if (f.ench !== undefined) {
      const curNone = !d.ench;
      const pendingTxt = es.pendingEnch === undefined ? '' :
        (es.pendingEnch === 'none' ? 'will be removed on Apply' :
          '→ ' + esc(es.pendingEnchName || es.pendingEnch) + ' on Apply');
      enchHtml =
        '<div class="ix-ed-ench">' +
        '<div class="ix-ed-ench-head">✦ Enchantment' +
        '<span class="ix-ed-ench-cur"' + (curNone ? '' : ' title="' + esc(d.ench.n) + '"') + '>' +
        (curNone ? 'none' : esc(d.ench.n)) + '</span>' +
        (orig.ench !== undefined ? '<span class="ix-ed-was">edited</span>' : '') +
        '</div>' +
        (pendingTxt ? '<div class="ix-ed-ench-pending">' + pendingTxt + '</div>' : '') +
        '<div class="ix-ed-ench-acts">' +
        '<button id="ix-ed-ench-change" class="ix-btn">' + (es.enchOpen ? 'Close list' : 'Change…') + '</button>' +
        ((!curNone || es.pendingEnch) ? '<button id="ix-ed-ench-none" class="ix-btn">Remove</button>' : '') +
        '<span class="ix-ed-charge"><span class="ix-ed-label">Charge</span>' +
        '<input id="ix-ed-charge" class="ix-ed-num" type="text" inputmode="numeric" autocomplete="off" value="' +
        esc(String(es.draft && es.draft.charge !== undefined ? es.draft.charge : (f.charge | 0))) + '"></span>' +
        '</div>' +
        (es.enchOpen ?
          '<div class="ix-ed-enchpick">' +
          '<input id="ix-ed-ench-q" type="text" placeholder="Search enchantments — Enter takes the top hit" ' +
          'autocomplete="off" spellcheck="false">' +
          '<div id="ix-ed-ench-rows" class="ix-ed-ench-rows"></div></div>' : '') +
        '</div>';
    }

    const editedCount = Array.isArray(d.edited) ? d.edited.length : 0;
    sh.innerHTML =
      '<div class="ix-sheet-card ix-ed-card">' +
      '<div class="ix-sheet-title">✎ Modify' +
      (editedCount ? '<span class="ix-ed-count">' + editedCount + ' field' + (editedCount === 1 ? '' : 's') + ' edited</span>' : '') +
      '</div>' +
      '<div class="ix-sheet-item">' +
      '<div class="ix-glyph ix-sheet-glyph ix-t-' + esc(es.it ? es.it.t : 'misc') + '">' + esc(meta[2]) + '</div>' +
      '<div class="ix-sheet-item-txt"><b title="' + esc(d.n || '') + '">' + esc(d.n || '') + '</b>' +
      '<span>' + esc(meta[1]) + ' · ' + esc(d.plugin || '') + '</span></div></div>' +
      '<div class="ix-ed-warn">Changes the BASE record — every copy in the game, ' +
      'yours and the world’s. Kept across launches; Revert restores the originals.</div>' +
      '<div class="ix-ed-field ix-ed-namerow" data-key="name">' +
      '<span class="ix-ed-label">Name</span>' +
      '<input id="ix-ed-name" class="ix-ed-text" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="' +
      esc(String(es.draft && es.draft.name !== undefined ? es.draft.name : (f.name || ''))) + '">' +
      (orig.name !== undefined ? '<span class="ix-ed-was" title="' + esc(String(orig.name)) + '">was ' +
        esc(String(orig.name)) + '</span>' : '<span class="ix-ed-was"></span>') +
      '</div>' +
      '<div class="ix-ed-grid">' +
      nums.map(function (r) { return editNumRow(r[0], r[1], r[2], r[3], f[r[0]], orig[r[0]], es.draft); }).join('') +
      '</div>' +
      enchHtml +
      '<div class="ix-sheet-actions ix-ed-actions">' +
      (editedCount ? '<button id="ix-ed-revert" class="ix-btn ix-ed-revertbtn" title="Restore every original value and forget the edits">↺ Revert all</button>' : '') +
      '<span class="ix-ed-actgap"></span>' +
      '<button id="ix-ed-cancel" class="ix-btn">Cancel</button>' +
      '<button id="ix-ed-apply" class="ix-pay">' + (es.busy ? 'Applying…' : 'Apply') + '</button>' +
      '</div></div>';

    /* ---- wiring ---- */
    sh.onclick = function (e) { if (e.target === sh) closeEditSheet(); };
    sh.querySelectorAll('.ix-ed-step').forEach(function (b) {
      b.addEventListener('click', function () {
        const row = b.closest('.ix-ed-field');
        const input = row.querySelector('.ix-ed-num');
        const step = parseFloat(row.getAttribute('data-step')) || 1;
        const dec = parseInt(row.getAttribute('data-dec'), 10) || 0;
        const d2 = parseInt(b.getAttribute('data-d'), 10) || 0;
        const cur = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ''));
        const next = (isNaN(cur) ? 0 : cur) + d2 * step;
        input.value = String(Math.max(0, Math.round(next * Math.pow(10, dec)) / Math.pow(10, dec)));
      });
    });
    sh.querySelectorAll('.ix-ed-num, .ix-ed-text').forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.stopPropagation(); doEditApply(); }
        if (e.key === 'Escape') { e.stopPropagation(); closeEditSheet(); }
      });
    });
    const cancel = $('ix-ed-cancel');
    if (cancel) cancel.addEventListener('click', closeEditSheet);
    const apply = $('ix-ed-apply');
    if (apply) apply.addEventListener('click', doEditApply);
    const revert = $('ix-ed-revert');
    if (revert) revert.addEventListener('click', function () {
      if (es.busy) return;
      es.busy = true;
      toGame('ieRevert', JSON.stringify({ id: es.id }));
    });
    const chg = $('ix-ed-ench-change');
    if (chg) chg.addEventListener('click', function () {
      captureEditDraft();
      es.enchOpen = !es.enchOpen;
      renderEditSheet();
      if (es.enchOpen) {
        const q = $('ix-ed-ench-q');
        if (q) { q.focus(); }
        requestEnch('');
      }
    });
    const none = $('ix-ed-ench-none');
    if (none) none.addEventListener('click', function () {
      captureEditDraft();
      es.pendingEnch = 'none';
      es.pendingEnchName = '';
      es.enchOpen = false;
      renderEditSheet();
    });
    const eq = $('ix-ed-ench-q');
    if (eq) {
      eq.addEventListener('input', function () {
        if (ui.enchT) clearTimeout(ui.enchT);
        ui.enchT = setTimeout(function () { requestEnch(eq.value); }, 200);
      });
      eq.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {           // Enter = top hit (the deck law)
          e.stopPropagation();
          if (es.enchRows.length) pickEnch(es.enchRows[0]);
        }
        if (e.key === 'Escape') { e.stopPropagation(); captureEditDraft(); es.enchOpen = false; renderEditSheet(); }
      });
      renderEnchResults();
    }
  }

  function requestEnch(q) {
    if (!ui.editSheet) return;
    const kind = ui.editSheet.data ? ui.editSheet.data.kind : '';
    toGame('ieEnch', JSON.stringify({ q: String(q || ''), kind: kind === 'weap' || kind === 'armo' ? kind : '' }));
  }

  function pickEnch(row) {
    const es = ui.editSheet;
    if (!es || !row) return;
    captureEditDraft();
    es.pendingEnch = row.id;
    es.pendingEnchName = row.n;
    es.enchOpen = false;
    renderEditSheet();
  }

  function renderEnchResults() {
    const es = ui.editSheet;
    const box = $('ix-ed-ench-rows');
    if (!es || !box) return;
    if (!es.enchRows.length) {
      box.innerHTML = '<div class="ix-eff-none">No named enchantment matches.</div>';
      return;
    }
    box.innerHTML = es.enchRows.map(function (r, i) {
      return '<div class="ix-ed-ench-row' + (i === 0 ? ' ix-ed-ench-top' : '') + '" data-i="' + i + '">' +
        '<span class="ix-ed-ench-n" title="' + esc(r.n) + '">' + esc(r.n) + '</span>' +
        (r.eff ? '<span class="ix-ed-ench-eff" title="' + esc(r.eff) + '">' + esc(r.eff) + '</span>' : '') +
        '</div>';
    }).join('');
    box.querySelectorAll('.ix-ed-ench-row').forEach(function (el) {
      el.addEventListener('click', function () {
        pickEnch(es.enchRows[parseInt(el.getAttribute('data-i'), 10) | 0]);
      });
    });
  }

  /* Collect only the fields that DIFFER from what the record holds now, so the
     C++ apply loop (and its original-capture) sees real changes only. */
  function collectEditChanges() {
    const es = ui.editSheet;
    if (!es || !es.data) return null;
    const f = es.data.fields || {};
    const set = {};
    const nameEl = $('ix-ed-name');
    if (nameEl) {
      const nm = String(nameEl.value || '').trim();
      if (nm && nm !== String(f.name || '')) set.name = nm;
    }
    const sh = $('ix-sheet');
    if (sh) sh.querySelectorAll('.ix-ed-field[data-step]').forEach(function (row) {
      const key = row.getAttribute('data-key');
      const input = row.querySelector('.ix-ed-num');
      if (!key || !input || f[key] === undefined) return;
      const n = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ''));
      if (isNaN(n) || n < 0) return;                    // garbage typed — skip the field
      if (Math.abs(n - Number(f[key])) > 1e-4) set[key] = n;
    });
    const chargeEl = $('ix-ed-charge');
    if (chargeEl && f.charge !== undefined) {
      const c = parseInt(String(chargeEl.value).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(c) && c !== (f.charge | 0)) set.charge = c;
    }
    if (es.pendingEnch !== undefined) set.ench = es.pendingEnch;
    return set;
  }

  function doEditApply() {
    const es = ui.editSheet;
    if (!es || !es.data || es.busy) return;
    const set = collectEditChanges();
    if (!set || !Object.keys(set).length) { closeEditSheet(); return; }   // nothing changed
    captureEditDraft();
    es.busy = true;
    renderEditSheet();
    toGame('ieApply', JSON.stringify({ id: es.id, set: set }));
  }

  /* ============================================================= render == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtGold(n) {
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

  /* Real item pictures — Mesh Rendering Framework via C++ (ItemIcons), the
     exact pipeline the Wardrobe and the wheel already use. A row id is
     "Plugin.esp|HEX6": the payload wants the 0x-prefixed formId + the plugin,
     the resolver wants the same pair. WardrobePane owns the ONE key
     normalisation and the ONE index (window.wdItemIcons + the 'hd-item-icons'
     event) — we never reimplement it, and a harness with no WardrobePane just
     shows the glyph. */

  /* Row id "Skyrim.esm|013989" -> { formId:'0x013989', plugin:'Skyrim.esm' }. */
  function idParts(id) {
    const s = String(id || '');
    const bar = s.lastIndexOf('|');
    if (bar === -1) return null;
    const plugin = s.slice(0, bar);
    const hex = s.slice(bar + 1);
    if (!plugin || !hex) return null;
    return { formId: '0x' + hex, plugin: plugin };
  }

  /* Resolved render path for a row, or '' — through the Wardrobe's resolver so
     the "UPPERCASE hex | lowercase plugin" key is normalised in exactly one
     place. A view-relative path only (its guard rejects '..', absolute, ':'). */
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

  /* ---- loading visibility (Rober, 2026-08-14: "the finder items DID render,
     but it wasn't obvious it was loading anything") -----------------------
     A row whose art is expected-but-not-yet-landed must READ as loading — a
     shimmer on the plate + glyph — instead of looking final; and a pane-level
     "rendering N items…" chip names what is happening at couch distance. Both
     ride ONE window: renders land one by one, so "active" = a render landed
     within the timeout (chipLastLand). The window closes when renders stop
     arriving — a potion/book that never gets a mesh must not shimmer forever,
     so its glyph is its honest final state past the timeout. */
  const RENDER_IDLE_MS = 30000;   // no new art for this long => window closed
  let chipLastLand = 0;           // ms of the last render that actually landed
  let renderChip = null;
  let chipT = null;               // watchdog: fires at window-close to repaint

  /* Is a render still plausibly in flight? Armed (we asked at least once, so
     chipLastLand is set), the disk poll or a fresh land seen within the idle
     window, and at least one drawn row still lacks its expected art. */
  function renderWindowActive() {
    return state.ready && chipLastLand > 0 && missingArt() &&
      (Date.now() - chipLastLand) < RENDER_IDLE_MS;
  }

  /* This row is expected to get a picture and hasn't yet — draw it as loading.
     (Every indexed item CAN have a mesh; only at/after the idle window do we
     concede one never will and drop the shimmer.) */
  function rowLoading(it) {
    return renderWindowActive() && !!idParts(it.id) && !iconFor(it.id);
  }

  /* The pane-level progress chip, top-of-results so it reads at 2560×1440 from
     the couch (not a corner whisper). Hidden the moment the window closes. */
  function updateRenderChip() {
    const pane = $('ix-pane');
    if (!pane) return;
    if (!renderChip) {
      renderChip = document.createElement('div');
      renderChip.className = 'ix-render-chip';
      renderChip.innerHTML = '<span class="ix-render-spin"></span><span class="ix-render-txt"></span>';
      pane.appendChild(renderChip);
    }
    let pending = 0;
    (state.items || []).forEach(function (it) { if (idParts(it.id) && !iconFor(it.id)) pending++; });
    const active = pending > 0 && renderWindowActive();
    renderChip.classList.toggle('ix-on', !!active);
    if (active) {
      renderChip.querySelector('.ix-render-txt').textContent =
        'rendering ' + pending + ' item' + (pending === 1 ? '' : 's') + '…';
      /* Anchor at the very top of the results, right-aligned — it lands over
         the "Items N" section-header band, whose right side is empty, and
         floats above the rows (pointer-events:none, so a row it grazes stays
         fully clickable). Measured, so it tracks wherever the header wraps to. */
      const body = $('ix-body');
      if (body && body.offsetTop) renderChip.style.top = body.offsetTop + 'px';
    }
    armChipWatchdog(active);
  }

  /* Nothing else fires at the idle mark, so a lone timer repaints once the
     window is about to close — dropping the chip and every row's shimmer
     together (a spinner that can't finish is worse than none). */
  function armChipWatchdog(active) {
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (!active) return;
    const left = Math.max(250, RENDER_IDLE_MS - (Date.now() - chipLastLand) + 60);
    chipT = setTimeout(function () {
      chipT = null;
      if (ui.visible) { renderBodyPreservingScroll(); }
    }, left);
  }

  /* The one-time first-open hint: a fresh query fired renders for most of the
     visible page, so say art is coming (dismissed on the first completion, not
     a modal). Shown inline above the rows via renderBody. */
  function firstOpenHint() {
    return !ui.hintSeen && renderWindowActive();
  }
  function dismissHintIfDone() {
    if (ui.hintSeen) return;
    if (chipLastLand > 0 && !missingArt()) ui.hintSeen = true;   // everything landed
  }

  /* After a render, ask C++ for the meshes of the VISIBLE item rows that have
     no picture yet — bounded to what state.items holds (one page), never the
     whole index.

     The ask REPLACES the Finder's previous one (owner 'finder', replace:true):
     C++ drops whatever it was still waiting to render for an older page and
     keeps only this one. Asks used to pile up, so paging through a mod's
     weapons queued every page behind the next — 67 renders in seven seconds,
     still landing (and stalling the game) half a minute after the deck closed
     (Rober, 2026-10-07: "i selected a mod and it started generating visuals
     but lagged super hard"). Because C++ forgets what it dropped, paging BACK
     re-asks that page's rows; the same set twice in a row is not re-sent. */
  const ICON_OWNER = 'finder';
  function requestIcons() {
    if (!state.items.length) return;
    const items = [], seen = {};
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      const p = idParts(it.id);
      if (!p) continue;
      const key = p.formId + '|' + p.plugin;
      if (seen[key]) continue;                      // dup this batch
      if (iconFor(it.id)) continue;                 // already rendered
      seen[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: it.n || '' });
    }
    const sig = Object.keys(seen).sort().join(',');
    if (!items.length || sig === ui.iconAskSig) return;
    ui.iconAskSig = sig;
    toGame('whIcons', JSON.stringify({ owner: ICON_OWNER, replace: true, items: items }));
  }

  /* Leaving the tab (or closing the deck) takes the Finder's waiting renders
     back: nobody is looking at them, and each one would stall the game it
     lands over. Renders already in flight finish; coming back re-asks. */
  function cancelIcons() {
    if (!ui.iconAskSig) return;
    ui.iconAskSig = '';
    toGame('whIcons', JSON.stringify({ owner: ICON_OWNER, replace: true, items: [] }));
  }

  /* The settle gate (2026-08-13 play-test): requesting renders on EVERY render
     meant every intermediate keystroke of "ebony sword" queued its own page —
     the e/eb/ebo… junk pages flooded the C++ render queue and the real rows'
     renders sat minutes behind them. Icons are now asked for only once the
     results have sat unchanged for a moment. */
  const ICON_SETTLE_MS = 650;
  const ICON_POLL_MS = 2500;
  const ICON_POLL_MAX = 24;   // ~60s of watching per settled query

  function scheduleIconWork() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!state.items.length) { stopIconPoll(); updateRenderChip(); return; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.visible) return;
      /* Window opens: arm the loading window so the chip + row shimmer show
         while renders are in flight (refreshed by each land in the
         hd-item-icons handler). */
      if (missingArt()) chipLastLand = Date.now();
      requestIcons();
      startIconPoll();
      updateRenderChip();
    }, ICON_SETTLE_MS);
  }

  /* Renders land whenever the framework gets to them, and the C++ batch-done
     push only fires when the WHOLE queue drains — behind a long queue that can
     be minutes away. So while drawn rows still lack art, nudge C++ every couple
     of seconds: an EMPTY whIcons queues nothing but replies with the current
     on-disk index, and the wardrobe receiver raises 'hd-item-icons' only when
     it actually changed — rows upgrade as their renders hit the disk. */
  function missingArt() {
    for (let i = 0; i < state.items.length; i++)
      if (!iconFor(state.items[i].id)) return true;
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

  /* Harness hook: run the pending settle timer NOW (jsdom runs real timers,
     the checks are synchronous). */
  function flushIconsForTest() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    requestIcons();
  }

  /* An <img> over the glyph plate: the emoji stays behind as the loading /
     fallback state, and a broken path removes itself (never a broken-image box
     — the app.js HK_ICO_ERR idiom, with the class dropped so the plate keeps
     its per-type hue). NEVER a ?v= query: Ultralight drops it and fails load. */
  const ICO_ERR = ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;ix-has-art&quot;);' +
    'b.removeChild(this);}"';

  function glyphInner(id, glyph) {
    const url = iconFor(id);
    if (!url) return glyph;
    return glyph + '<img class="ix-art" src="' + esc(url) + '" alt="" draggable="false"' + ICO_ERR + '>';
  }

  /* ============================================================ lightbox == */

  /* Click the picture -> the 512px render, big (hd-lightbox.js). The angle
     candidates are the Wardrobe turntable's on-disk names derived from THIS
     row's frame-0 url — HDLightbox probes them and only a frame that actually
     loads joins the spin, so a piece nobody ever orbited just shows big. */
  function openLightbox(it) {
    const url = iconFor(it.id);
    if (!url || !window.HDLightbox) return;
    const meta = kindMeta(it.t);
    const w = Math.round((Number(it.w) || 0) * 10) / 10;
    const frames = ['-a090', '-a180', '-a270'].map(function (s) {
      return url.replace(/\.png$/, s + '.png');
    });
    HDLightbox.open({
      host: $('ix-pane'),
      src: url,
      glyph: meta[2],
      title: it.n,
      sub: meta[1] + ' · ' + it.p + ' · 🜚 ' + fmtGold(Math.max(0, it.v | 0)) + ' g · ' + w + ' wt',
      frames: frames,
      /* hold + drag bakes the turntable through the hdSpin bridge — opening
         costs zero renders (hd-lightbox.js owns the whole flow) */
      spin: (function () { const p = idParts(it.id); return p ? { kind: 'item', formId: p.formId, plugin: p.plugin } : null; })(),
    });
  }

  /* ============================================================ detail == */

  /* The rich per-item detail (Rober, 2026-08-15: "expand our finder section for
     items and npcs — effects, enchants, damage, factions, npc stats, all sorts
     of info"). Lazy: C++ computes the block only when a row is expanded, replies
     through the shared ixResultData listener with a `detail` field. One row open
     at a time; the block is cached so re-expanding is instant. */
  const ix = {
    detailCacheSet: function (id, info, err) {
      if (info) { ui.detail[id] = info; delete ui.detailErr[id]; }
      else { ui.detailErr[id] = err || 'Could not read this item'; }
    },
  };

  /* Toggle the expanded row. Collapsing just clears; expanding asks C++ (unless
     cached) and repaints the body so the block mounts under the row. */
  function toggleDetail(id) {
    if (ui.expanded === id) { ui.expanded = ''; renderBodyPreservingScroll(); return; }
    ui.expanded = id;
    if (!ui.detail[id] && !ui.detailErr[id]) requestDetail(id);
    renderBodyPreservingScroll();
    revealDetail();
  }

  /* renderBodyPreservingScroll restores scrollTop VERBATIM, so a block mounted
     under a row near the fold lands entirely below it and the ⓘ reads as dead
     (measured: at 2560x1440 row 5 showed 0 of 283px, at 1280x720 rows 1+ showed
     0). Scroll down just enough to bring the block into view — and never past
     the top of the row that owns it: a headerless slab of stats is worse than a
     clipped one. Scrolls DOWN only, so a detail landing late (the C++ reply, or
     a re-read after Apply) can't yank a list the player has scrolled away. */
  function revealDetail() {
    const body = $('ix-body');
    if (!body) return;
    const d = body.querySelector('.ix-detail');
    if (!d) return;
    const row = d.previousElementSibling;
    const br = body.getBoundingClientRect();
    const dr = d.getBoundingClientRect();
    const rowTop = row ? row.getBoundingClientRect().top : dr.top;
    const need = Math.max(0, dr.bottom - br.bottom);          // how far it falls short
    const room = Math.max(0, rowTop - br.top);                // before the row leaves the top
    const delta = Math.min(need, room);
    if (delta > 1) body.scrollTop += delta;
  }

  function requestDetail(id) {
    toGame('ixQuery', JSON.stringify({ detail: id, seq: state.seq }));
  }

  /* One effect line: "Fire Damage · 25 pts for 10s in 15ft" — magnitude, then
     duration (0 = instant), then area (0 = self/touch). Harmful effects tint
     red, beneficial gold. */
  function effectRowHtml(e) {
    if (!e || !e.n) return '';
    const bits = [];
    if (e.mag != null && Number(e.mag) > 0) bits.push('<b>' + fmtGold(Math.round(Number(e.mag))) + '</b> pts');
    if (e.dur != null && Number(e.dur) > 0) bits.push('for ' + fmtGold(Number(e.dur)) + 's');
    if (e.area != null && Number(e.area) > 0) bits.push('in ' + fmtGold(Number(e.area)) + 'ft');
    const meta = bits.length ? bits.join(' ') : 'constant';
    return '<div class="ix-eff' + (e.harm ? ' ix-eff-harm' : '') + '">' +
      '<span class="ix-eff-dot"></span>' +
      '<span class="ix-eff-name" title="' + esc(e.n) + '">' + esc(e.n) + '</span>' +
      '<span class="ix-eff-mag">' + meta + '</span>' +
      (e.school ? '<span class="ix-eff-school">' + esc(e.school) + '</span>' : '') +
      '</div>';
  }

  function statHtml(label, value, cls) {
    return '<div class="ix-stat"><span class="ix-stat-l">' + esc(label) + '</span>' +
      '<span class="ix-stat-v' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</span></div>';
  }

  /* Build the inner HTML of a detail block from a cached info object. Sections
     appear only when the data has them, so a plain misc item shows just its
     value/weight and (if any) keywords. */
  function detailInnerHtml(id, info) {
    if (ui.detailErr[id] && !info)
      return '<div class="ix-detail-err">⚠ ' + esc(ui.detailErr[id]) + '</div>';
    if (!info)
      return '<div class="ix-detail-load"><span class="ix-detail-spin"></span> Reading…</div>';

    let html = '';

    /* headline stats grid — whatever numeric facts this kind has */
    let stats = '';
    if (info.dmg != null) stats += statHtml('Damage', fmtGold(info.dmg), 'ix-stat-dmg');
    if (info.armor != null) stats += statHtml('Armor', String(Math.round(Number(info.armor) * 10) / 10), 'ix-stat-arm');
    if (info.wtype) stats += statHtml('Type', info.wtype);
    if (info.speed != null && Number(info.speed) > 0) stats += statHtml('Speed', String(Math.round(Number(info.speed) * 100) / 100));
    if (info.reach != null && Number(info.reach) > 0) stats += statHtml('Reach', String(Math.round(Number(info.reach) * 100) / 100));
    if (info.crit != null && Number(info.crit) > 0) stats += statHtml('Crit', fmtGold(info.crit));
    if (info.v != null) stats += statHtml('Value', '🜚 ' + fmtGold(info.v));
    if (info.w != null) stats += statHtml('Weight', (Math.round(Number(info.w) * 10) / 10) + ' wt');
    if (info.poison) stats += statHtml('', 'Poison', 'ix-stat-harm');
    if (stats) html += '<div class="ix-stats">' + stats + '</div>';

    /* enchantment — its own titled block with effect lines */
    if (info.ench) {
      html += '<div class="ix-detail-sect"><div class="ix-detail-h">✦ Enchantment' +
        (info.ench.name ? ' · <span class="ix-detail-hsub">' + esc(info.ench.name) + '</span>' : '') +
        (info.ench.charge ? ' <span class="ix-detail-hsub">· ' + fmtGold(info.ench.charge) + ' charge</span>' : '') +
        '</div>';
      const effs = Array.isArray(info.ench.effects) ? info.ench.effects : [];
      html += effs.length ? effs.map(effectRowHtml).join('') :
        '<div class="ix-eff-none">No listed magic effects.</div>';
      html += '</div>';
    }

    /* potion / scroll / ingredient effects */
    if (Array.isArray(info.effects) && info.effects.length) {
      html += '<div class="ix-detail-sect"><div class="ix-detail-h">🧪 Magic effects</div>' +
        info.effects.map(effectRowHtml).join('') + '</div>';
    }

    /* keywords — quiet chips at the foot */
    if (Array.isArray(info.keywords) && info.keywords.length) {
      html += '<div class="ix-detail-sect"><div class="ix-detail-h">Keywords</div>' +
        '<div class="ix-kw-wrap">' +
        info.keywords.map(function (k) { return '<span class="ix-kw" title="' + esc(k) + '">' + esc(k) + '</span>'; }).join('') +
        '</div></div>';
    }

    if (!html) html = '<div class="ix-eff-none">No extra detail for this item.</div>';

    /* Modify foot — the door into the base-record editor. Present whenever the
       detail is real (not the spinner / error branches above). */
    const editedN = state.editedSet[id] | 0;
    html += '<div class="ix-detail-acts">' +
      '<button class="ix-btn ix-edit-open" data-edit="' + esc(id) +
      '" title="Edit this record — damage, name, value, enchantment. Changes every copy; kept across launches.">✎ Modify</button>' +
      (editedN ? '<button class="ix-btn ix-edit-revert" data-revert="' + esc(id) +
        '" title="Restore the original values and forget the edits">↺ Revert</button>' +
        '<span class="ix-edited-note">✎ ' + editedN + ' field' + (editedN === 1 ? '' : 's') + ' edited</span>' : '') +
      '</div>';
    return html;
  }

  /* Wire the Modify/Revert buttons inside detail blocks under `scope` — called
     after renderBody AND after patchDetailInPlace, because both paths write
     detail HTML with innerHTML and lose any prior listeners. */
  function wireDetailActions(scope) {
    if (!scope) return;
    scope.querySelectorAll('.ix-edit-open').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = b.getAttribute('data-edit');
        let it = null;
        for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) { it = state.items[i]; break; }
        openEditSheet(it || { id: id, t: 'misc', n: '', p: '', v: 0, w: 0 });
      });
    });
    scope.querySelectorAll('.ix-edit-revert').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        toGame('ieRevert', JSON.stringify({ id: b.getAttribute('data-revert') }));
      });
    });
  }

  /* Patch just the open row's detail block — called when a detail reply lands so
     the "Reading…" spinner swaps to real content without a body rebuild. */
  function patchDetailInPlace(id) {
    const box = document.querySelector('#ix-body .ix-detail[data-for="' + cssEsc(id) + '"]');
    if (!box) return;
    box.innerHTML = detailInnerHtml(id, ui.detail[id]);
    wireDetailActions(box);
    /* the spinner block was ~40px; the real one is ~283px, so the reveal has to
       run again once the content that needs the room is actually in it */
    revealDetail();
  }

  /* CSS.escape isn't in Ultralight; ids are "Plugin.esp|HEX6" — the only risky
     char for an attribute selector is the quote we wrap in, so escape that. */
  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  function renderHeader() {
    const chip = $('ix-count-chip');
    if (chip) {
      chip.textContent = state.ready
        ? (fmtGold(state.count) + ' items · ' + fmtGold(state.plugins.length) + ' mods indexed')
        : 'reading the load order…';
    }
    const gold = $('ix-gold');
    if (gold) gold.textContent = '🜚 ' + (state.gold < 0 ? '?' : fmtGold(state.gold));
    const payBtn = $('ix-pay-toggle');
    if (payBtn) {
      payBtn.classList.toggle('ix-toggle-on', state.pay);
      payBtn.textContent = state.pay ? '💰 Merchant mode: ON' : '💰 Merchant mode';
      payBtn.title = state.pay
        ? 'Taking an item asks a price and pays REAL gold — click for free-take mode'
        : 'Free take — click to make items cost gold (asks a price each time)';
    }
    const insp = $('ix-3d-toggle');
    if (insp) {
      insp.classList.toggle('hidden', state.inspect3d === null);
      insp.classList.toggle('ix-toggle-on', state.inspect3d === true);
      insp.textContent = state.inspect3d ? '3D inspector: on' : '3D inspector: off';
      insp.setAttribute('aria-pressed', state.inspect3d ? 'true' : 'false');
      insp.title = state.inspect3d
        ? 'Click a picture, then "Turn in 3D": 24 angles rendered big. Click to switch the inspector off.'
        : 'Off: pictures open with the small 4-angle turn only, and nothing extra renders. Click to switch on.';
    }
    const mult = $('ix-mult');
    if (mult) {
      mult.classList.toggle('hidden', !state.pay);
      const want = String(state.mult);
      if (mult.value !== want) mult.value = want;
    }
  }

  function renderPills() {
    const box = $('ix-pills');
    if (!box) return;
    box.innerHTML = KINDS.map(function (k) {
      return '<button class="ix-pill' + (ui.type === k[0] ? ' ix-pill-on' : '') +
        '" data-type="' + k[0] + '" title="' +
        (k[0] === 'all' ? 'Search items and mods together'
          : k[0] === 'mods' ? 'Search plugin names only — esp, esm, esl'
            : 'Only ' + esc(k[1].toLowerCase())) + '">' +
        (k[0] === 'all' || k[0] === 'mods' ? '' : k[2] + ' ') + esc(k[1]) + '</button>';
    }).join('');
    box.querySelectorAll('.ix-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.type = b.getAttribute('data-type');
        ui.sel = 0;
        runQuery(true);
        const s = $('ix-search');
        if (s) s.focus();
      });
    });
  }

  function renderPlugChip() {
    const chip = $('ix-plug-chip');
    if (!chip) return;
    if (!ui.plugin) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
    chip.classList.remove('hidden');
    chip.innerHTML = '📦 <b title="' + esc(ui.plugin) + '">' + esc(ui.plugin) + '</b>' +
      '<span class="ix-chip-x" title="Search everything again">✕</span>';
    chip.querySelector('.ix-chip-x').addEventListener('click', clearPlugin);
  }

  /* ------------------------------------------------- secondary plugin filter --
     A "⛃ Filter by mod" toggle in the filter row (right of the pills' flow), and
     a revealed typeable input that fuzzy-narrows the current results by owning
     plugin. Built dynamically into .ix-barwrap after #ix-pills so no index.html
     edit is needed (the dynamic-footer idiom). Browsing INSIDE a mod (a plug
     chip) already scopes to one plugin, so the secondary filter is hidden then.
     The input keeps focus across repaints (we only rebuild when the reveal state
     or plugin browse changes), so typing is never interrupted. */
  let plugFilterEl = null;

  function plugFilterHost() {
    const wrap = document.querySelector('#ix-pane .ix-barwrap');
    if (!wrap) return null;
    if (!plugFilterEl) {
      plugFilterEl = document.createElement('div');
      plugFilterEl.className = 'ix-plugfilter';
      plugFilterEl.id = 'ix-plugfilter';
      const pills = $('ix-pills');
      if (pills && pills.nextSibling) wrap.insertBefore(plugFilterEl, pills.nextSibling);
      else wrap.appendChild(plugFilterEl);
    }
    return plugFilterEl;
  }

  /* Show the control only where a plugin filter makes sense: an actual search /
     pill view with rows, and NOT while browsing inside one mod (already scoped). */
  function plugFilterVisible() {
    if (!state.ready) return false;
    if (ui.plugin) return false;                 // already inside one mod
    if (ui.type === 'mods') return false;        // mods-only view has no item rows
    return !!ui.q || ui.type !== 'all';          // a real search / pill is active
  }

  function renderPlugFilter() {
    const host = plugFilterHost();
    if (!host) return;
    if (!plugFilterVisible()) {
      host.classList.remove('ix-pf-on');
      host.innerHTML = '';
      return;
    }
    host.classList.add('ix-pf-on');

    const open = ui.plugFilterOpen || !!ui.plugFilter;
    const active = !!ui.plugFilter;
    /* Rebuild only when the OPEN/CLOSED shape changes — never on every keystroke,
       so the <input> keeps focus + caret while typing. The active tint and the
       clear ✕ are toggled in place (syncPlugFilterActive), not rebuilt. */
    const shape = open ? 'o' : 'c';
    if (host.getAttribute('data-shape') !== shape) {
      let html = '<button class="ix-pf-toggle' + (active ? ' ix-pf-toggle-on' : '') +
        '" id="ix-pf-toggle" title="Narrow these results to a mod — type part of an esp / esl / esm name">' +
        '⛃ Filter by mod</button>';
      if (open) {
        html += '<span class="ix-pf-box">' +
          '<span class="ix-pf-glyph">📦</span>' +
          '<input id="ix-pf-input" type="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="plugin (esp / esl / esm)…" value="' + esc(ui.plugFilter) + '">' +
          '<span class="ix-pf-x' + (active ? '' : ' hidden') + '" id="ix-pf-clear" title="Clear the mod filter">✕</span>' +
          '</span>';
      }
      host.innerHTML = html;
      host.setAttribute('data-shape', shape);

      const toggle = $('ix-pf-toggle');
      if (toggle) toggle.addEventListener('click', function () {
        ui.plugFilterOpen = !ui.plugFilterOpen;
        if (!ui.plugFilterOpen) { ui.plugFilter = ''; }
        ui.sel = 0;
        render();
        if (ui.plugFilterOpen) { const i = $('ix-pf-input'); if (i) i.focus(); }
      });
      const clear = $('ix-pf-clear');
      if (clear) clear.addEventListener('click', function () {
        ui.plugFilter = ''; ui.sel = 0;
        render();
        const i = $('ix-pf-input'); if (i) i.focus();
      });
      const input = $('ix-pf-input');
      if (input) {
        input.addEventListener('input', function () {
          ui.plugFilter = input.value.trim();
          ui.sel = 0;
          /* body + count only — never a full render (which would rebuild THIS
             input and drop focus mid-type) */
          renderBody(); renderFooter();
          syncPlugFilterActive();
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const rows = flatRows();
            activate(rows[Math.min(ui.sel, rows.length - 1)] || rows[0]);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            if (ui.plugFilter) { ui.plugFilter = ''; input.value = ''; renderBody(); renderFooter(); syncPlugFilterActive(); }
            else { ui.plugFilterOpen = false; render(); const s = $('ix-search'); if (s) s.focus(); }
          }
        });
      }
    } else {
      /* shape unchanged — just keep the input's value in sync if state changed
         externally (omni jump, plugin browse) without stealing the caret */
      const input = $('ix-pf-input');
      if (input && input.value !== ui.plugFilter && document.activeElement !== input) input.value = ui.plugFilter;
    }
  }

  /* Flip the toggle's active tint and the clear ✕ the moment the filter goes
     from empty to set (or back) WITHOUT rebuilding the row — keeps the caret in
     the input while typing (the row only rebuilds on an open/close change). */
  function syncPlugFilterActive() {
    const active = !!ui.plugFilter;
    const toggle = $('ix-pf-toggle');
    if (toggle) toggle.classList.toggle('ix-pf-toggle-on', active);
    const x = $('ix-pf-clear');
    if (x) x.classList.toggle('hidden', !active);
  }

  function plugRowHtml(p, selIdx, idx) {
    const kindCls = p.k === 'esm' ? 'ix-kind-esm' : (p.k === 'esl' || p.l) ? 'ix-kind-esl' : 'ix-kind-esp';
    const kindLbl = String(p.k || 'esp').toUpperCase() + (p.l && p.k === 'esp' ? ' · light' : '');
    return '<div class="ix-plug-row' + (selIdx === idx ? ' ix-sel' : '') + '" data-plug="' + esc(p.n) +
      '" title="Browse everything ' + esc(p.n) + ' ships">' +
      '<span class="ix-kindbadge ' + kindCls + '">' + esc(kindLbl) + '</span>' +
      '<span class="ix-plug-name">' + highlight(p.n, ui.q) + '</span>' +
      '<span class="ix-plug-count">' + fmtGold(p.c) + ' items</span>' +
      '<span class="ix-plug-go">Browse →</span></div>';
  }

  function itemRowHtml(it, selIdx, idx) {
    const meta = kindMeta(it.t);
    const qty = ui.qty[it.id] || 1;
    const price = suggestedPrice(it, qty);
    const btn = state.pay
      ? ('Buy · ~' + fmtGold(price) + ' g')
      : (qty > 1 ? 'Take ×' + qty : 'Take');
    const w = Math.round((Number(it.w) || 0) * 10) / 10;
    const hasArt = !!iconFor(it.id);
    const loading = !hasArt && rowLoading(it);
    const val = fmtGold(Math.max(0, it.v | 0));
    const open = ui.expanded === it.id;
    return '<div class="ix-row' + (selIdx === idx ? ' ix-sel' : '') + (open ? ' ix-row-open' : '') +
      '" data-id="' + esc(it.id) + '">' +
      '<div class="ix-glyph ix-t-' + esc(it.t) + (hasArt ? ' ix-has-art ix-zoomable' : '') +
      (loading ? ' ix-loading' : '') +
      '" title="' + esc(hasArt ? it.n + ' — click for a bigger look' : (loading ? 'rendering…' : meta[1])) + '">' +
      glyphInner(it.id, meta[2]) + '</div>' +
      '<div class="ix-mid">' +
      '<div class="ix-name" title="' + esc(it.n) + '">' + highlight(it.n, ui.q) +
      (state.editedSet[it.id] ? '<span class="ix-edited-chip" title="Carries Modify edits — open ⓘ to see or revert them">✎</span>' : '') +
      '</div>' +
      '<div class="ix-meta">' +
      '<span class="ix-meta-type">' + esc(meta[1]) + '</span>' +
      '<span class="ix-meta-plug" data-plug="' + esc(it.p) + '" title="Browse everything ' + esc(it.p) + ' ships">' + esc(it.p) + '</span>' +
      '<span class="ix-meta-vw">' +
      '<span class="ix-meta-val" title="Base value in gold">🜚 ' + val + '</span>' +
      '<span class="ix-meta-wt" title="Weight">' + w + ' wt</span>' +
      '</span>' +
      '</div></div>' +
      '<div class="ix-act">' +
      '<button class="ix-info' + (open ? ' ix-info-on' : '') + '" data-info="' + esc(it.id) +
      '" title="Show damage / armor / enchantments / effects / keywords" aria-expanded="' +
      (open ? 'true' : 'false') + '">ⓘ</button>' +
      '<span class="ix-qty"><button data-d="-1" title="Fewer">−</button><b>' + qty + '</b>' +
      '<button data-d="1" title="More">+</button></span>' +
      '<button class="ix-take" title="' +
      (state.pay ? 'Asks the price, then pays real gold' : 'Add to your inventory') + '">' + btn + '</button>' +
      '</div></div>' +
      (open ? '<div class="ix-detail" data-for="' + esc(it.id) + '">' +
        detailInnerHtml(it.id, ui.detail[it.id]) + '</div>' : '');
  }

  /* Show/hide the hero-or-empty state. #ix-body and #ix-empty are BOTH flex:1,
     so an emptied body kept claiming half the pane and the state that owns the
     screen rendered in the bottom half under a dead band (measured: 333px of
     void, hero centre 148px below the content centre at 2560x1440). The body
     yields its share whenever it has nothing to show. */
  function showEmptyState(on) {
    const body = $('ix-body');
    const empty = $('ix-empty');
    if (empty) empty.classList.toggle('hidden', !on);
    if (body) body.classList.toggle('ix-body-yield', !!on);
  }

  function renderBody() {
    const body = $('ix-body');
    const empty = $('ix-empty');
    if (!body || !empty) return;

    /* index not answered yet: skeleton rows sized like the real thing */
    if (!state.ready) {
      body.innerHTML = new Array(7).fill(
        '<div class="ix-row ix-skel"><div class="ix-glyph ix-skel-box"></div>' +
        '<div class="ix-mid"><span class="ix-skel-box ix-skel-w1"></span>' +
        '<span class="ix-skel-box ix-skel-w2"></span></div>' +
        '<span class="ix-skel-box ix-skel-btn"></span></div>').join('');
      showEmptyState(false);
      return;
    }

    const rows = flatRows();

    /* hero — nothing asked yet */
    if (!rows.length && !ui.q && !ui.plugin && ui.type === 'all') {
      body.innerHTML = '';
      showEmptyState(true);
      empty.innerHTML =
        '<div class="ix-hero-glyph">⚒</div>' +
        '<div class="ix-empty-title">Every item the load order ships</div>' +
        '<div class="ix-empty-sub"><b>' + fmtGold(state.count) + ' items</b> across <b>' +
        fmtGold(state.plugins.length) + ' mods</b>, one bar. Type an item, or a mod to browse its whole catalogue.' +
        (state.pay ? ' Merchant mode is on — taking asks a price and pays real gold.' : '') + '</div>' +
        '<div class="ix-try">' +
        ['ebony sword', 'sweetroll', 'soul gem', 'Skyrim.esm'].map(function (t) {
          return '<button class="ix-pill" data-try="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-try]').forEach(function (b) {
        b.addEventListener('click', function () {
          const s = $('ix-search');
          ui.q = b.getAttribute('data-try');
          if (s) { s.value = ui.q; s.focus(); }
          runQuery(true);
        });
      });
      return;
    }

    /* honest empties */
    if (!rows.length) {
      body.innerHTML = '';
      showEmptyState(true);
      if (state.awaiting) {
        empty.innerHTML = '<div class="ix-empty-title">Searching…</div>';
      } else if (ui.plugFilter && state.items.length > 0) {
        /* the search DID return rows, the secondary mod filter hid them all on
           this page — say so, and offer the escape hatch */
        empty.innerHTML = '<div class="ix-empty-title">No item on this page is from “' + esc(ui.plugFilter) + '”</div>' +
          '<div class="ix-empty-sub">The mod filter matched nothing on this page. Try a different mod name, ' +
          'page through the results, or clear the filter.</div>' +
          '<div class="ix-try"><button class="ix-pill" id="ix-pf-empty-clear">Clear mod filter</button></div>';
        const c = $('ix-pf-empty-clear');
        if (c) c.addEventListener('click', function () {
          ui.plugFilter = ''; ui.sel = 0; render();
          const i = $('ix-pf-input'); if (i) i.focus();
        });
        return;
      } else if (ui.type === 'mods') {
        empty.innerHTML = '<div class="ix-empty-title">No mod matches</div>' +
          '<div class="ix-empty-sub">No plugin name contains “' + esc(ui.q) + '”. Try fewer letters.</div>';
      } else {
        empty.innerHTML = '<div class="ix-empty-title">Nothing matches</div>' +
          '<div class="ix-empty-sub">No item called “' + esc(ui.q) + '”' +
          (ui.plugin ? ' in ' + esc(ui.plugin) : '') +
          (ui.type !== 'all' ? ' under that pill' : '') +
          '. Try fewer letters, another pill, or the whole-word mod name.</div>';
      }
      return;
    }
    showEmptyState(false);

    let html = '';
    let idx = 0;
    let inMods = false, inItems = false;
    /* first-open hint: a fresh query fired renders for the visible page — say
       art is coming, once, so the emoji placeholders don't read as final */
    const showHint = firstOpenHint() && rows.some(function (r) { return r.kind === 'item'; });
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        html += '<div class="ix-sect">Mods <b>' +
          (ui.type === 'mods' ? modMatches(30).length : Math.min(5, modMatches(5).length)) + '</b></div>';
      }
      if (r.kind === 'item' && !inItems) {
        inItems = true;
        /* When the secondary plugin filter is on, the "Items N" total is the
           whole (server) result count, but only some of THIS page's rows match —
           say both so the count never reads as a lie. */
        const shownItems = rows.filter(function (x) { return x.kind === 'item'; }).length;
        const pageItems = state.items.length;
        html += '<div class="ix-sect">Items <b>' + fmtGold(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') +
          (ui.plugFilter ? '<b class="ix-sect-filt">· ⛃ ' + fmtGold(shownItems) + ' of ' +
            fmtGold(pageItems) + ' on this page match “' + esc(ui.plugFilter) + '”</b>' : '') +
          '</div>';
        if (showHint)
          html += '<div class="ix-firsthint">✨ First time seeing these — rendering their art in the ' +
            'background. Rows fill in as it lands.</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'item') html += itemRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    /* wire rows */
    body.querySelectorAll('.ix-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
    body.querySelectorAll('.ix-row:not(.ix-skel)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      function item() {
        for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
      }
      const takeBtn = row.querySelector('.ix-take');
      if (takeBtn) takeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const it = item();
        if (it) activate({ kind: 'item', it: it });
      });
      const infoBtn = row.querySelector('.ix-info');
      if (infoBtn) infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDetail(infoBtn.getAttribute('data-info'));
      });
      const zoom = row.querySelector('.ix-glyph.ix-zoomable');
      if (zoom) zoom.addEventListener('click', function (e) {
        e.stopPropagation();
        const it = item();
        if (it) openLightbox(it);
      });
      row.querySelectorAll('.ix-qty button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          const d = parseInt(b.getAttribute('data-d'), 10) || 0;
          ui.qty[id] = Math.max(1, Math.min(999, (ui.qty[id] || 1) + d));
          renderBody();
        });
      });
      const plug = row.querySelector('.ix-meta-plug');
      if (plug) plug.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlugin(plug.getAttribute('data-plug'));
      });
      row.addEventListener('dblclick', function () {
        const it = item();
        if (it) activate({ kind: 'item', it: it });
      });
    });

    /* the expanded row's detail block was rewritten with the body — re-wire
       its Modify/Revert buttons (innerHTML ate the old listeners) */
    wireDetailActions(body);

    /* ask C++ for the meshes of the rows we just drew — via the settle gate,
       so a mid-typing render never floods the render queue */
    scheduleIconWork();
    updateRenderChip();   // reflect loading state right now, not only post-settle
  }

  /* Re-render the body but keep the scroll position — a render batch landing
     mid-scroll must not jump the list back to the top (keys-pane idiom). */
  /* A render landed: upgrade the plates of the rows already on screen, and
     leave every other node - the Take button above all - exactly where it is.
     Same markup the row painter uses, so a patched plate is byte-identical to
     a freshly painted one (and zoomable the same way). */
  function patchRowsArt() {
    const body = $('ix-body');
    if (!body) return;
    body.querySelectorAll('.ix-row:not(.ix-skel)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      const plate = row.querySelector('.ix-glyph');
      if (!id || !plate || plate.classList.contains('ix-has-art')) return;
      let it = null;
      for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) { it = state.items[i]; break; }
      if (!it) return;
      const meta = kindMeta(it.t);
      if (iconFor(id)) {
        plate.innerHTML = glyphInner(id, meta[2]);
        plate.classList.add('ix-has-art');
        plate.classList.add('ix-zoomable');
        plate.classList.remove('ix-loading');
        plate.setAttribute('title', it.n + ' — click for a bigger look');
        plate.addEventListener('click', function (e) { e.stopPropagation(); openLightbox(it); });
        return;
      }
      // Still expected, or the window closed on it: keep the shimmer honest.
      if (rowLoading(it)) { plate.classList.add('ix-loading'); plate.setAttribute('title', 'rendering…'); }
      else { plate.classList.remove('ix-loading'); plate.setAttribute('title', meta[1]); }
    });
  }

  function renderBodyPreservingScroll() {
    const body = $('ix-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('ix-body');
    if (b2) b2.scrollTop = top;
  }

  function render() {
    renderHeader();
    renderPills();
    renderPlugChip();
    renderPlugFilter();
    renderBody();
    renderFooter();
  }

  /* ============================================================= footer == */

  /* The pagination bar under the results: ‹ Prev / count / Next › + a per-page
     segmented control. Created dynamically and appended to #ix-pane (like the
     render chip) so no index.html edit is needed. Hidden whenever there is no
     paged list to show: index not ready, hero, empty results, or the Mods-only
     view (mods are matched locally, not paged). A SINGLE short page keeps the
     count + selector but hides Prev/Next. It sits below the price SHEET's z, so
     an open sheet covers it. */
  let footEl = null;

  function footHost() {
    const pane = $('ix-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'ix-foot';
      footEl.id = 'ix-foot';
      /* after #ix-body, before the toast/sheet, so it sits at the pane's foot
         and never overlaps the scroll area (toast, sheet + lightbox are higher z). */
      const body = $('ix-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  function footVisible() {
    if (!state.ready) return false;
    if (ui.type === 'mods') return false;         // mods are local, not paged
    if (!ui.q && !ui.plugin && ui.type === 'all') return false;  // hero
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('ix-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;          // keep the index sane after a shrink
    const first = total ? ui.page * ui.pageSize + 1 : 0;
    const last = Math.min(total, (ui.page + 1) * ui.pageSize);
    const multi = pc > 1;

    let html = '';
    if (multi) {
      html += '<button class="ix-foot-nav ix-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="ix-foot-count">Showing <b>' + fmtGold(first) + '–' + fmtGold(last) +
      '</b> of <b>' + fmtGold(total) + '</b>' + (multi ? ' · page ' + (ui.page + 1) + ' of ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="ix-foot-nav ix-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="ix-foot-per" title="How many to show per page — fewer means fewer renders at once">' +
      '<span class="ix-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="ix-foot-size' + (n === ui.pageSize ? ' ix-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('ix-foot-on');

    const prev = foot.querySelector('.ix-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.ix-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.ix-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('ix-toast');
    if (!t) return;
    /* Lift clear of the pagination bar. #ix-foot is the pane's last in-flow row,
       so a toast pinned at the pane's foot sits squarely on Next › and the
       page-size buttons for the 2.6s it shows (measured: 543x40 of overlap,
       covering the whole 84x40 Next ›). The bar WRAPS on a narrow panel, so its
       height is measured every time, never assumed. */
    const foot = $('ix-foot');
    const lift = (foot && foot.classList.contains('ix-foot-on')) ? foot.offsetHeight + 10 : 0;
    t.style.bottom = (18 + lift) + 'px';
    t.textContent = msg;
    t.classList.toggle('ix-toast-err', !!err);
    t.classList.add('ix-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('ix-toast-show'); }, 2600);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('ixState');   // first call builds the C++ index; later calls refresh gold
    toGame('ieList');    // which items carry Modify edits — drives the ✎ chips
    state.askedOnce = true;
    const s = $('ix-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready && (ui.q || ui.plugin || ui.type !== 'all')) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
    closeSheet();
    closeEditSheet();
    if (window.HDLightbox) HDLightbox.close();
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (renderChip) renderChip.classList.remove('ix-on');
    stopIconPoll();
    cancelIcons();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the bar pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.plugin = '';
    ui.type = 'all';
    const s = $('ix-search');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  function init() {
    const s = $('ix-search');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        queryDebounced();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Authoritative: preventDefault + stopPropagation so Enter never
             leaks to the deck's global handler (which would fire a random
             hotkey and close the palette). Take the top visible result and
             STAY OPEN — Items Enter is "keep grabbing", never a close. With no
             results activate() no-ops, so Enter on an empty roster does nothing
             (it does NOT close). */
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
            const el = document.querySelector('#ix-body .ix-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
          /* Page nav — Arrows are already row-nav (above), so paging rides
             PgDn/PgUp. Only when a paged list is on screen. */
          if (!ui.sheet && footVisible() && pageCount() > 1) {
            gotoPage(ui.page + (e.key === 'PageDown' ? 1 : -1));
            e.preventDefault();
            e.stopPropagation();
          }
        } else if (e.key === 'Escape') {
          if (ui.sheet) { closeSheet(); e.stopPropagation(); }
          else if (s.value) { s.value = ''; ui.q = ''; runQuery(true); e.stopPropagation(); }
          else if (ui.plugin) { clearPlugin(); e.stopPropagation(); }
          /* bare Esc falls through to the palette's close, on purpose */
        } else if (e.key === 'Backspace' && !s.value && ui.plugin) {
          clearPlugin();
          e.stopPropagation();
        }
      });
    }
    /* Finder mode switch — the other half of the merged tab. The typed query
       rides along, so "ebony" over items becomes "ebony" over people. app.js
       owns the actual tab flip (__hdFinderGo); a harness without it no-ops. */
    document.querySelectorAll('#ix-pane .fx-sw').forEach(function (b) {
      b.addEventListener('click', function () {
        const go = b.getAttribute('data-go');
        if (go !== 'items' && typeof window.__hdFinderGo === 'function') window.__hdFinderGo(go, ui.q);
      });
    });
    const payBtn = $('ix-pay-toggle');
    if (payBtn) payBtn.addEventListener('click', function () {
      state.pay = !state.pay;   // optimistic; ixSaved confirms
      renderHeader(); renderBody();
      toGame('ixSave', JSON.stringify({ pay: state.pay }));
    });
    const inspBtn = $('ix-3d-toggle');
    /* once per button even if init runs twice (a harness calls it on top of
       the module's own self-init) — a toggle wired twice flips back */
    if (inspBtn && !inspBtn.getAttribute('data-wired')) {
      inspBtn.setAttribute('data-wired', '1');
      inspBtn.addEventListener('click', function () { setInspect3d(!state.inspect3d); });
    }
    const mult = $('ix-mult');
    if (mult) mult.addEventListener('change', function () {
      state.mult = Number(mult.value) || 1;
      renderBody();
      toGame('ixSave', JSON.stringify({ mult: state.mult }));
    });

    /* A render batch landed (WardrobePane pushed a new index and fired the
       shared event) — repaint so glyphs upgrade to real pictures in place,
       and refresh the price sheet's item art if it is open. Bounded: only
       while this pane is actually on screen. */
    try {
      document.addEventListener('hd-item-icons', function () {
        if (!ui.visible) return;
        chipLastLand = Date.now();      // a render landed — keep the window open
        dismissHintIfDone();
        /* IN PLACE, never a rebuild. This used to call renderBodyPreservingScroll():
           renders land one by one for seconds after a search, and every landing
           replaced the whole list - including the Take button under the cursor,
           between mousedown and mouseup, so the click was simply lost. Rober,
           2026-09-23: "items search refuses to give me item when i hit take 1
           before its done loading fully". */
        patchRowsArt();
        updateRenderChip();
        if (ui.sheet) refreshSheetArt();
      });
    } catch (e) { /* no DOM in some harnesses */ }

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_ITEMS = [
    { id: 'Skyrim.esm|00013989', n: 'Ebony Sword', t: 'weap', v: 720, w: 15, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|0004DEE3', n: 'Ebony Greatsword', t: 'weap', v: 1440, w: 22, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|00064B71', n: 'Sweetroll', t: 'food', v: 5, w: 0.2, p: 'Skyrim.esm' },
    { id: 'CoolSwords.esl|000801', n: 'Sword of Cool', t: 'weap', v: 2500, w: 9, p: 'CoolSwords.esl' },
    { id: 'Ordinator - Perks of Skyrim.esp|0141AB', n: 'Spell Tome: Cool Nova', t: 'book', v: 320, w: 1, p: 'Ordinator - Perks of Skyrim.esp' },
    { id: 'Skyrim.esm|0002E4E2', n: 'Grand Soul Gem', t: 'slgm', v: 500, w: 0.5, p: 'Skyrim.esm' },
  ];

  function devState() {
    window.ixStateResult({
      phase: 'ready', count: 412391, gold: 12345, pay: state.pay, mult: state.mult || 1,
      inspect3d: state.inspect3d !== false,
      plugins: [
        { n: 'Skyrim.esm', c: 12842, k: 'esm', l: false },
        { n: 'Ordinator - Perks of Skyrim.esp', c: 214, k: 'esp', l: false },
        { n: 'CoolSwords.esl', c: 12, k: 'esl', l: true },
      ],
    });
  }

  const DEV_DETAIL = {
    'Skyrim.esm|00013989': { v: 720, w: 15, dmg: 13, speed: 1, reach: 1, crit: 6, wtype: 'One-Handed Sword',
      ench: { name: 'Fiery Soul Trap', charge: 500, effects: [
        { n: 'Fire Damage', mag: 10, dur: 0, area: 0, harm: true, school: 'Destruction' },
        { n: 'Soul Trap', mag: 0, dur: 3, area: 0, harm: true, school: 'Conjuration' } ] },
      keywords: ['WeapTypeSword', 'WeapMaterialEbony'] },
    'CoolSwords.esl|000801': { v: 2500, w: 9, dmg: 22, speed: 0.9, reach: 1.1, crit: 15, wtype: 'Two-Handed Sword',
      keywords: ['WeapTypeGreatsword'] },
    'Skyrim.esm|00064B71': { v: 5, w: 0.2, food: true, effects: [
      { n: 'Restore Health', mag: 5, dur: 0, area: 0, harm: false } ] },
    'Skyrim.esm|0002E4E2': { v: 500, w: 0.5, keywords: ['VendorItemSoulGem'] },
  };

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.detail) {
      const info = DEV_DETAIL[req.detail];
      window.ixResultData(info
        ? { seq: req.seq | 0, detail: req.detail, info: info }
        : { seq: req.seq | 0, detail: req.detail, info: {}, err: 'No dev detail fixture' });
      return;
    }
    const q = String(req.q || '').toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    let rows = DEV_ITEMS.filter(function (it) {
      if (req.plugin && it.p !== req.plugin) return false;
      if (req.type && req.type !== 'all' && it.t !== req.type) return false;
      for (let i = 0; i < toks.length; i++) {
        if (it.n.toLowerCase().indexOf(toks[i]) === -1 &&
            it.p.toLowerCase().indexOf(toks[i]) === -1) return false;
      }
      return true;
    });
    window.ixResultData({ seq: req.seq | 0, total: rows.length, offset: req.offset | 0,
      items: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || 60)) });
  }

  function devAdd(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const paid = req.pay ? (req.price | 0) : 0;
    if (paid > 12345) {
      window.ixAddResult({ ok: false, msg: 'You carry 12,345 gold - this costs ' + paid, gold: 12345 });
      return;
    }
    window.ixAddResult({ ok: true, msg: (paid ? 'Bought item - ' + paid + ' gold' : '+ item'), gold: 12345 - paid });
  }

  function devSave(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if ('pay' in req) state.pay = !!req.pay;
    if ('mult' in req) state.mult = Number(req.mult) || 1;
    if ('inspect3d' in req) state.inspect3d = !!req.inspect3d;
    window.ixSaved({ ok: true, pay: state.pay, mult: state.mult, inspect3d: state.inspect3d });
  }

  /* ---- Modify dev fixtures — mirror item_edit.cpp's store semantics so the
     harness can walk the full open → apply → revert loop offline. ---------- */
  const DEV_EDIT_FIELDS = {
    'Skyrim.esm|00013989': { name: 'Ebony Sword', value: 720, weight: 15, damage: 13, crit: 6,
      speed: 1, reach: 1, stagger: 0.75, ench: 'none', charge: 0 },
  };
  const DEV_EDIT_STORE = {};   // id -> {set:{}, orig:{}}
  const DEV_ENCH = [
    { id: 'Skyrim.esm|0490FE', n: 'Fiery Soul Trap', eff: 'Fire Damage 10 pts' },
    { id: 'Skyrim.esm|048C6D', n: 'Frost Damage', eff: 'Frost Damage 15 pts' },
    { id: 'Skyrim.esm|0AD486', n: 'Absorb Health', eff: 'Absorb Health 10 pts' },
  ];
  let DEV_LAST_APPLY = null;   // the harness asserts the exact wire payload

  function devEditState(id) {
    const f = DEV_EDIT_FIELDS[id];
    const st = DEV_EDIT_STORE[id];
    const edited = st ? Object.keys(st.set) : [];
    return { ok: true, id: id, kind: 'weap', n: f.name, plugin: 'Skyrim.esm',
      fields: JSON.parse(JSON.stringify(f)),
      ench: f.ench !== 'none' ? { id: f.ench, n: 'Some Enchantment' } : undefined,
      orig: st ? st.orig : undefined, edited: edited, count: Object.keys(DEV_EDIT_STORE).length };
  }

  function devIeGet(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const f = DEV_EDIT_FIELDS[req.id];
    window.ieGetResult(f ? devEditState(req.id) : { ok: false, id: req.id, msg: 'No dev fixture' });
  }

  function devIeApply(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    DEV_LAST_APPLY = req;
    const f = DEV_EDIT_FIELDS[req.id];
    if (!f) { window.ieApplyResult({ ok: false, id: req.id, msg: 'No dev fixture' }); return; }
    const st = DEV_EDIT_STORE[req.id] || (DEV_EDIT_STORE[req.id] = { set: {}, orig: {} });
    Object.keys(req.set || {}).forEach(function (k) {
      if (!(k in f)) return;
      if (!(k in st.orig)) st.orig[k] = f[k];
      f[k] = req.set[k];
      if (st.orig[k] === req.set[k]) { delete st.set[k]; delete st.orig[k]; }
      else st.set[k] = req.set[k];
    });
    if (!Object.keys(st.set).length) delete DEV_EDIT_STORE[req.id];
    const out = devEditState(req.id);
    out.msg = 'Changed - every copy of it, saved across launches';
    window.ieApplyResult(out);
  }

  function devIeRevert(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const f = DEV_EDIT_FIELDS[req.id];
    const st = DEV_EDIT_STORE[req.id];
    if (f && st) Object.keys(st.orig).forEach(function (k) { f[k] = st.orig[k]; });
    delete DEV_EDIT_STORE[req.id];
    const out = f ? devEditState(req.id) : { ok: true, id: req.id, edited: [] };
    out.msg = 'Restored to its original values';
    window.ieRevertResult(out);
  }

  function devIeList() {
    window.ieListResult({ edits: Object.keys(DEV_EDIT_STORE).map(function (id) {
      return { id: id, n: DEV_EDIT_FIELDS[id] ? DEV_EDIT_FIELDS[id].name : '?',
        p: id.split('|')[0], fields: Object.keys(DEV_EDIT_STORE[id].set).length };
    }), count: Object.keys(DEV_EDIT_STORE).length });
  }

  function devIeEnch(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    window.ieEnchResult({ ench: DEV_ENCH.filter(function (r) {
      return !q || r.n.toLowerCase().indexOf(q) !== -1;
    }) });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    ui.visible = true;
    devState();
    ok('state: ready', state.ready === true);
    ok('state: plugins landed', state.plugins.length === 3);

    /* hero first */
    ui.q = ''; ui.plugin = ''; ui.type = 'all';
    render();
    ok('hero: shown with stats', !$('ix-empty').classList.contains('hidden') &&
      $('ix-empty').textContent.indexOf('412,391') !== -1);

    /* unified search: mods section + items */
    ui.q = 'ebony';
    state.seq++; devQuery(JSON.stringify({ q: 'ebony', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    ok('query: two ebony items', state.items.length === 2);
    ui.q = 'cool';
    state.seq++; devQuery(JSON.stringify({ q: 'cool', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('mods section: CoolSwords listed', document.querySelectorAll('#ix-body .ix-plug-row').length >= 1);
    ok('items section: rows in DOM', document.querySelectorAll('#ix-body .ix-row').length === state.items.length);
    ok('highlight: match marked', !!document.querySelector('#ix-body .ix-name mark'));

    /* stale replies dropped */
    const before = state.items.length;
    devQuery(JSON.stringify({ q: 'ebony', type: 'all', plugin: '', seq: state.seq - 1, limit: 60, offset: 0 }));
    ok('stale seq: dropped', state.items.length === before);

    /* plugin chip narrows */
    setPlugin('CoolSwords.esl');
    devQuery(JSON.stringify({ q: '', type: 'all', plugin: 'CoolSwords.esl', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('plugin browse: only its items', state.items.length === 1 && state.items[0].p === 'CoolSwords.esl');
    ok('plugin chip: visible', !$('ix-plug-chip').classList.contains('hidden'));
    clearPlugin();

    /* pills */
    ui.type = 'weap'; ui.q = 'ebony';
    state.seq++; devQuery(JSON.stringify({ q: 'ebony', type: 'weap', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    ok('type pill: weapons only', state.items.every(function (it) { return it.t === 'weap'; }));
    ui.type = 'mods'; ui.q = 'cool';
    render();
    ok('mods pill: mod rows only', document.querySelectorAll('#ix-body .ix-plug-row').length === 1 &&
      document.querySelectorAll('#ix-body .ix-row:not(.ix-skel)').length === 0);
    ui.type = 'all';

    /* merchant math */
    state.mult = 2;
    ok('price: value x mult x qty', suggestedPrice({ v: 100 }, 3) === 600);
    state.mult = 1;

    /* price sheet */
    state.pay = true;
    openSheet(DEV_ITEMS[0], 2);
    ok('sheet: open with suggested price', $('ix-price') && $('ix-price').value === String(720 * 2));
    const shortBefore = $('ix-sheet-pay').disabled;
    $('ix-price').value = '99999999';
    $('ix-price').dispatchEvent(new Event('input'));
    ok('sheet: refuses what you cannot pay', !shortBefore && $('ix-sheet-pay').disabled === true);
    closeSheet();
    ok('sheet: closed', $('ix-sheet').classList.contains('hidden'));
    state.pay = false;

    /* add round-trip updates gold */
    state.gold = 12345;
    devAdd(JSON.stringify({ id: 'x', count: 1, pay: true, price: 345 }));
    ok('add: gold chip follows the purse', state.gold === 12000);

    /* keyboard flat rows */
    ui.q = 'cool'; ui.plugin = ''; ui.type = 'all';
    state.seq++; devQuery(JSON.stringify({ q: 'cool', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    const rows = flatRows();
    ok('flat rows: mods before items', rows.length >= 2 && rows[0].kind === 'plug');

    /* secondary plugin filter — fuzzy match + composes with the name search */
    ok('plugfilter: whole-substring matches', pluginFuzzy('miranda.esp', 'mira'));
    ok('plugfilter: subsequence matches (mrnd)', pluginFuzzy('miranda.esp', 'mrnd'));
    ok('plugfilter: rejects a non-match', !pluginFuzzy('miranda.esp', 'skyrim'));
    ok('plugfilter: empty keeps everything', pluginFuzzy('anything.esp', ''));
    ui.q = ''; ui.plugin = ''; ui.type = 'all'; ui.plugFilter = '';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'weap', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    ui.type = 'weap';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'weap', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    const allWeap = flatRows().filter(function (x) { return x.kind === 'item'; }).length;
    ui.plugFilter = 'cool';
    const coolWeap = flatRows().filter(function (x) { return x.kind === 'item'; }).length;
    ok('plugfilter: narrows the page to the matching plugin', allWeap > coolWeap && coolWeap >= 1 &&
      flatRows().filter(function (x) { return x.kind === 'item'; }).every(function (x) { return /cool/i.test(x.it.p); }));
    ui.plugFilter = ''; ui.type = 'all';
    ok('plugfilter: hidden while browsing inside one mod', (function () {
      ui.plugin = 'CoolSwords.esl'; const v = plugFilterVisible(); ui.plugin = ''; return v === false;
    })());

    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) -------------------------
     Until 2026-08-19 this indexed exactly one row — the tab itself — so the
     deck-wide search could not reach a single one of the 400,000-odd items
     the C++ side indexes, nor Modify, nor Merchant mode, nor any type pill.
     Three things fix that: the doors below (index(), live state, cheap), the
     edited-record rows (so "revert" names what it would undo), and lazy(),
     which asks the same C++ index the bar asks. */

  /* A row that has to act INSIDE the pane opens the tab first: setTab runs the
     pane's onShow (its DOM, its data), and re-selecting the tab you are already
     on is a no-op, so this is safe from either place. */
  function omniLand() {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('items');
  }

  /* Open the tab on one type pill, the way clicking that pill does. */
  function omniOpenKind(t) {
    omniLand();
    ui.type = t;
    ui.plugin = '';
    ui.plugFilter = '';
    ui.q = '';
    const s = $('ix-search');
    if (s) s.value = '';
    runQuery(true);
  }

  /* ---- lazy item rows ---------------------------------------------------
     These ride ixPick / ixPickData — the PICKER's door, never the pane's own
     ixQuery / ixResultData, because a second consumer of that reply would
     fight the tab's own list for state.items (one listener per reply name is
     the bridge law). HDItemPick loads before this file and already owns
     ixPickData, so its handler is CHAINED rather than replaced, and our
     requests carry sequence numbers from a range the picker never mints —
     so neither side can swallow the other's answer. */
  const OMNI_SEQ_BASE = 500000;
  const OMNI_LIMIT = 12;          // omni is a shortlist; the tab is where you browse
  let omniSeq = OMNI_SEQ_BASE;
  let omniT = null;
  const omniPrevPick = window.ixPickData;

  function omniAsk(q) {
    omniSeq++;
    toGame('ixPick', JSON.stringify({ q: q, type: 'all', plugin: '',
      limit: OMNI_LIMIT, offset: 0, seq: omniSeq }));
  }

  function omniItemRow(it) {
    const meta = kindMeta(it.t);
    const w = Math.round((Number(it.w) || 0) * 10) / 10;
    return {
      label: it.n || '(unnamed item)',
      detail: meta[1] + ' · ' + (it.p || '?') + ' · 🜚 ' + fmtGold(Math.max(0, it.v | 0)) + ' · ' + w + ' wt',
      kind: 'item',
      keywords: (it.p || '') + ' ' + meta[1] + ' additem add spawn give take buy',
      /* Merchant mode never charges silently — it opens the tab and the price
         sheet, exactly as pressing Enter on the row inside the pane does. A
         free take needs no tab at all: the DLL's own "+ Ebony Sword"
         notification is the receipt. */
      run: function () {
        if (state.pay) { omniLand(); openSheet(it, 1); }
        else takeItem(it, 1, false, 0);
      },
    };
  }

  window.ixPickData = function (d) {
    if (typeof omniPrevPick === 'function') { try { omniPrevPick(d); } catch (e) {} }
    let j = null;
    try { j = (typeof d === 'string') ? JSON.parse(d) : (d || {}); } catch (e) { return; }
    if (!j || (j.seq | 0) !== omniSeq) return;   // the picker's own reply, or one typed past
    if (!window.HDOmni) return;
    const rows = Array.isArray(j.items) ? j.items : [];
    HDOmni.lazyResults('items', rows.map(omniItemRow));
  };

  if (window.HDOmni) HDOmni.register({
    id: 'items', label: 'Items', tab: 'items',
    setFilter: setFilter,
    /* Which records carry Modify edits is only known after the tab has been
       opened once — asking here costs one bridge call per omni open and makes
       "revert" answerable from a cold session. */
    warm: function () { toGame('ieList'); },
    lazy: function (q) {
      /* Debounced exactly like the pane's own bar: C++ answers a query by
         walking the whole index on the main thread, so one request per
         keystroke would queue work the player has already typed past. */
      if (omniT) clearTimeout(omniT);
      omniT = setTimeout(function () { omniT = null; omniAsk(q); }, DEBOUNCE_MS);
    },
    index: function () {
      const rows = [{
        label: 'Item Explorer',
        detail: 'Find any item any mod ships — take it, or pay gold for it',
        kind: 'items',
        keywords: 'item explorer additem add item spawn give cheat search buy merchant mod esp esl esm',
      }];

      rows.push({
        label: 'Merchant mode',
        detail: state.pay
          ? 'ON — taking an item asks a price and pays real gold. Run to go back to free take.'
          : 'OFF — items are free. Run to make them cost gold (it asks the price each time).',
        kind: 'items',
        keywords: 'merchant mode buy pay gold price cost multiplier free take cheat shop',
        /* The same optimistic flip the header toggle does — ixSaved confirms it
           and the tab comes along so the toggle visibly agrees. */
        run: function () {
          omniLand();
          state.pay = !state.pay;
          renderHeader(); renderBody();
          toGame('ixSave', JSON.stringify({ pay: state.pay }));
        },
      });

      /* Only once the DLL has said it HAS an inspector (inspect3d in ixState):
         an old build would take the flip and do nothing. */
      if (state.inspect3d !== null) rows.push({
        label: '3D item inspector',
        detail: state.inspect3d
          ? 'ON — click any item picture, then Turn in 3D: 24 angles rendered big. Run to switch it off.'
          : 'OFF — pictures open with the small 4-angle turn only. Run to switch the 3D inspector on.',
        kind: 'items',
        keywords: '3d inspector turntable turn spin rotate orbit model view catalog inspect item picture big',
        run: function () { omniLand(); setInspect3d(!state.inspect3d); },
      });

      rows.push({
        label: 'Modify an item',
        detail: 'Edit any item\'s record — damage, armor, value, weight, name, enchantment. ' +
          'Search the item, open its ⓘ, then ✎ Modify.',
        kind: 'items',
        keywords: 'modify edit change item record damage armor rating value weight rename ' +
          'enchantment stronger weaker buff nerf rebalance proteus',
        /* There is no standalone editor to land on — the sheet belongs to one
           item — so this opens the tab and says where the button is, rather
           than dropping the player somewhere that looks unchanged. */
        run: function () { omniLand(); toast('Search an item, open its ⓘ, then ✎ Modify'); },
      });

      /* One row per record that carries edits, so "revert" is answerable by the
         item's own name. Running it is the same one-click revert the ✎ Revert
         button in the row's detail block does. */
      for (let i = 0; i < state.edited.length; i++) {
        (function (e) {
          if (!e || !e.id) return;
          const n = (e.fields | 0) || 1;
          rows.push({
            label: 'Revert edits: ' + (e.n || e.id),
            detail: n + ' field' + (n === 1 ? '' : 's') + ' edited · ' + (e.p || '?') +
              ' — restores the original values and forgets the edits',
            kind: 'items',
            keywords: 'revert undo restore original modify edit ' + (e.p || ''),
            run: function () { toGame('ieRevert', JSON.stringify({ id: e.id })); },
          });
        })(state.edited[i]);
      }

      /* The type pills as doors, the shape hd-potions and hd-quiver both ship.
         'all' is the Item Explorer row above; every other pill, Mods included,
         is a real place to land. */
      KINDS.forEach(function (k) {
        if (k[0] === 'all') return;
        rows.push({
          label: 'Items: ' + k[1],
          detail: k[0] === 'mods'
            ? 'Browse the load order by mod — pick one and see its whole catalogue'
            : 'Open the Finder on every ' + k[1].toLowerCase() + ' the load order ships',
          kind: 'items',
          keywords: k[1].toLowerCase() + ' browse list all',
          run: function () { omniOpenKind(k[0]); },
        });
      });

      return rows;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _flushIcons: flushIconsForTest, _iconPollTick: iconPollTick, _missingArt: missingArt,
    _state: state, _ui: ui, _flatRows: flatRows, _modMatches: modMatches,
    _suggestedPrice: suggestedPrice, _openSheet: openSheet, _closeSheet: closeSheet,
    _openLightbox: openLightbox, _setInspect3d: setInspect3d,
    _rowLoading: rowLoading, _renderWindowActive: renderWindowActive,
    _armWindow: function () { chipLastLand = Date.now(); },
    _closeWindow: function () { chipLastLand = 1; },   // far past => window shut
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _pluginFuzzy: pluginFuzzy, _plugFilterVisible: plugFilterVisible,
    _toggleDetail: toggleDetail, _detailInnerHtml: detailInnerHtml,
    _openEditSheet: openEditSheet, _closeEditSheet: closeEditSheet,
    _collectEditChanges: collectEditChanges, _doEditApply: doEditApply,
    /* the omni lazy ask, without its debounce — a harness cannot wait */
    _omniAsk: omniAsk,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.ItemsPane.init(); });
} else {
  window.ItemsPane.init();
}
