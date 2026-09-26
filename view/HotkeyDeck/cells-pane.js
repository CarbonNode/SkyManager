'use strict';

/* ====================================================================== *
 *  Cells — the Finder's third roster (Rober, 2026-09-20: "any idea if we
 *  can add a new pill for 'cells' and look for cells?").
 *
 *  The NPC Finder's structural twin with the expensive half removed: no
 *  portraits, no render queue, no spawn. C++ owns the index, the matching
 *  and the travel (cell_finder.cpp); this pane owns the ONE bar, the pills
 *  and the rows.
 *
 *  Interiors, named exterior cells, and map markers share the roster. The
 *  Cells (COC) filter shows cells with a usable editor id; Map markers shows
 *  travel points reached by player.moveto. A marker never has cell DATA flags.
 *
 *  MOST interiors have no full name. That is not a defect: a modded dungeon
 *  cell is addressed by its EDITOR ID, which is also the only handle `coc`
 *  understands. So a nameless row draws its editor id as the title (in the
 *  mono face, so it reads as the identifier it is), and a row with NEITHER
 *  never reaches the view — C++ drops it.
 *
 *  Bridge — requests: cxState() · cxQuery(json) · cxAct(json) · cxSave(json)
 *  Replies (disjoint, per the deck law): cxStateResult({phase,count,pageSize,
 *  plugins}) · cxResultData({seq,total,offset,items} | {seq,detail,info}) ·
 *  cxActResult({ok,act,found,msg}) · cxSaved({ok,pageSize}). A successful
 *  travel gets NO reply — C++ waits for the palette to close, then travels.
 *
 *  Host contract (mirrors ItemsPane / NpcsPane): CellsPane.init() · onShow()
 *  · onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.CellsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;

  /* No renders on this roster, so a page costs nothing but markup: 25, the
     item-explorer default, rather than the NPC pane's face-bound 10. */
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;

  /* The Mods roster is client-side (the plugin list arrives whole with
     cxState), so it grows a chunk at a time instead of paging through C++. */
  const MODS_PAGE = 30;
  const MODS_PREVIEW = 5;   // 'Everywhere' searches show a taste of the mods

  /* ============================================================== pills == */

  /* pseudo-kinds; 'all' and 'mods' the C++ never sees, the rest map to the
     C++ `type` filter. Named/Unnamed is the split that actually matters here:
     "Named" is the places a player recognises, "Unnamed" is the editor-id
     plumbing — and on this load order the second pile is the bigger one. */
  const KINDS = [
    ['all',      'Everywhere', '⌕', 'Search places and mods together'],
    ['mods',     'Mods',       '',  'Search plugin names only — esp, esm, esl'],
    ['coc',      'Cells (COC)', '',  'Interior and outdoor cells with an editor ID you can use with coc'],
    ['markers',  'Map markers','',  'Travel to map points using Go to marker — these are not COC cell names'],
    ['named',    'Named',      '★', 'Only cells with a real name — the places you would recognise'],
    ['unnamed',  'Unnamed',    '',  'Only cells with no name, addressed by editor id — most modded dungeons'],
  ];

  /* ============================================================== state == */

  const state = {
    ready: false,
    count: 0,
    plugins: [],
    seq: 0,
    total: 0,
    items: [],
    awaiting: false,
  };

  const ui = {
    q: '',
    type: 'all',
    plugin: '',
    sel: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    page: 0,
    modsShown: MODS_PAGE,
    visible: false,
    debT: null,
    toastT: null,
    /* Detail (the live half): expanded holds the one open row id; detail
       caches computed blocks by id; detailErr holds an honest failure. */
    expanded: '',
    detail: {},
    detailErr: {},
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'cxState') setTimeout(devState, 30);
      if (DEV && fn === 'cxQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'cxAct') setTimeout(function () { devAct(arg); }, 30);
    }
  }

  window.cxStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.phase === 'ready';
    state.count = d.count | 0;
    state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
    /* Persisted page size from the DLL. Absent (an old DLL) => keep our
       default, so the pane still paginates. */
    if (typeof d.pageSize === 'number' && d.pageSize > 0) ui.pageSize = clampPageSize(d.pageSize);
    if (ui.visible) {
      if (state.ready && (ui.q || ui.plugin || ui.type !== 'all') && !state.items.length && !state.awaiting)
        runQuery(true);
      render();
    }
  };

  window.cxSaved = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) {
      const p = clampPageSize(d.pageSize);
      if (p !== ui.pageSize) { ui.pageSize = p; if (ui.visible) runQuery(true); }
    }
  };

  window.cxResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    /* Detail reply rides this SAME listener — keyed by the `detail` field a
       page reply never carries. NOT gated on seq: a detail can land after the
       next keystroke bumped it, and dropping it leaves the block spinning. */
    if (typeof d.detail === 'string' && d.detail) {
      if (d.info && typeof d.info === 'object' && Object.keys(d.info).length)
        { ui.detail[d.detail] = d.info; delete ui.detailErr[d.detail]; }
      else ui.detailErr[d.detail] = d.err || 'Could not read this cell';
      if (ui.visible && ui.expanded === d.detail) patchDetailInPlace(d.detail);
      return;
    }
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
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

  window.cxActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
  };

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

  /* reset (a new query / pill / plugin change) always returns to page 1;
     Prev/Next call with reset=false and set ui.page themselves first. */
  function runQuery(reset) {
    if (reset) { ui.page = 0; ui.modsShown = MODS_PAGE; }
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!ui.q && !ui.plugin && ui.type === 'all') {
      state.items = []; state.total = 0; state.awaiting = false; ui.page = 0;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    ui.sel = 0;
    toGame('cxQuery', JSON.stringify({
      q: ui.q, type: ui.type === 'mods' ? 'all' : ui.type, plugin: ui.plugin,
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
    runQuery(false);
    const body = $('cl-body');
    if (body) body.scrollTop = 0;
    const s = $('cl-search');
    if (s) s.focus();
  }

  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    toGame('cxSave', JSON.stringify({ pageSize: ui.pageSize }));
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
    /* No limit = the honest total. Callers that draw rows pass one; callers
       that COUNT must not, or the header reports its own cap as the total. */
    return limit ? out.slice(0, limit) : out;
  }

  /* ====================================================== selection model == */

  function flatRows() {
    const rows = [];
    if (showsModSection()) {
      const cap = ui.type === 'mods' ? ui.modsShown : MODS_PREVIEW;
      const all = modMatches(0);
      all.slice(0, cap).forEach(function (p) { rows.push({ kind: 'plug', p: p }); });
      if (ui.type === 'mods' && all.length > cap)
        rows.push({ kind: 'more', left: all.length - cap });
    }
    if (ui.type !== 'mods')
      state.items.forEach(function (it) { rows.push({ kind: 'cell', it: it }); });
    return rows;
  }

  function showsModSection() {
    if (ui.plugin) return false;
    if (ui.type === 'mods') return true;
    return ui.type === 'all' && !!ui.q;
  }

  /* Enter = travel, the sibling rosters' "top hit does the obvious thing".
     A cell with no editor id cannot be travelled to, and activate() sends the
     act anyway: C++ owns that refusal, and one refusal in one place cannot
     disagree with itself. */
  function activate(row) {
    if (!row) return;
    if (row.kind === 'plug') { setPlugin(row.p.n); return; }
    if (row.kind === 'more') { showMoreMods(); return; }
    if (row.kind === 'cell') act('go', row.it);
  }

  function showMoreMods() {
    ui.modsShown += MODS_PAGE;
    renderBodyPreservingScroll();
  }

  /* ============================================================= actions == */

  function act(what, it) {
    if (!it) return;
    toGame('cxAct', JSON.stringify({ act: what, id: it.id }));
    if (what === 'go') toast('Traveling to ' + labelOf(it) + '…');
  }

  function setPlugin(name) {
    ui.plugin = String(name || '');
    ui.q = '';
    const s = $('cl-search');
    if (s) { s.value = ''; s.focus(); }
    if (ui.type === 'mods') ui.type = 'all';
    runQuery(true);
  }

  function clearPlugin() {
    ui.plugin = '';
    runQuery(true);
    const s = $('cl-search');
    if (s) s.focus();
  }

  /* ============================================================= render == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtN(n) {
    return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(String(q).toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }

  /* The ONE place a row's title is chosen, so every heading, toast and title
     attribute names a cell the same way C++'s LabelOf does. */
  function labelOf(it) {
    if (!it) return '';
    return it.n || it.e || '(unnamed cell)';
  }
  function isNameless(it) { return !!it && !it.n && !!it.e; }
  /* 2026-09-21: the roster now carries named EXTERIOR cells (it.ext) and MAP MARKERS
     (it.mk — Bannermist Tower has no interior, only a marker). A marker has no
     editor id: travel is player.moveto the marker ref, so it is never "untravellable". */
  function isMarker(it) { return !!it && !!it.mk; }

  /* ============================================================== rows == */

  function plugRowHtml(p, selIdx, idx) {
    const kindCls = p.k === 'esm' ? 'cl-kind-esm' : (p.k === 'esl' || p.l) ? 'cl-kind-esl' : 'cl-kind-esp';
    const kindLbl = String(p.k || 'esp').toUpperCase() + (p.l && p.k === 'esp' ? ' · light' : '');
    return '<div class="cl-plug-row' + (selIdx === idx ? ' cl-sel' : '') + '" data-plug="' + esc(p.n) +
      '" title="Browse every place ' + esc(p.n) + ' ships">' +
      '<span class="cl-kindbadge ' + kindCls + '">' + esc(kindLbl) + '</span>' +
      '<span class="cl-plug-name">' + highlight(p.n, ui.q) + '</span>' +
      '<span class="cl-plug-count">' + fmtN(p.c) + ' places</span>' +
      '<span class="cl-plug-go">Browse →</span></div>';
  }

  function moreModsRowHtml(left, selIdx, idx) {
    const next = Math.min(left, MODS_PAGE);
    return '<button class="cl-plug-more' + (selIdx === idx ? ' cl-sel' : '') +
      '" title="Draw the next ' + fmtN(next) + ' mods">' +
      '<span class="cl-plug-more-t">Show ' + fmtN(next) + ' more</span>' +
      '<span class="cl-plug-count">' + fmtN(left) + ' not shown</span>' +
      '<span class="cl-plug-go">▼</span></button>';
  }

  /* The four DATA flags worth a chip. Deliberately worded as what they mean
     for walking in, not as the flag name: "Public" is the one that decides
     whether the room's owner minds. */
  function chipsHtml(it) {
    if (isMarker(it)) return ''; // A REFR has no CELL flags, even from an older DLL.
    let out = '';
    if (it.pub)
      out += '<span class="cl-chip cl-chip-pub" title="Public area — nobody owns what is in here, so taking it is not stealing">Public</span>';
    if (it.wt)
      out += '<span class="cl-chip" title="This cell has water">Water</span>';
    if (it.tv)
      out += '<span class="cl-chip" title="You can fast-travel straight out of this cell">Travel out</span>';
    if (it.wn)
      out += '<span class="cl-chip cl-chip-warn" title="The game warns you to leave this cell — usually someone&#39;s private space">Warns you off</span>';
    return out;
  }

  function cellRowHtml(it, selIdx, idx) {
    const open = ui.expanded === it.id;
    const nameless = isNameless(it);
    const title = labelOf(it);
    const marker = isMarker(it);
    const canGo = !!it.e || marker;
    /* The editor id is BOTH the subtitle of a named cell and the title of a
       nameless one — never printed twice. */
    const titleHtml = nameless
      ? '<span class="cl-name-txt cl-mono">' + highlight(it.e, ui.q) + '</span>'
      : '<span class="cl-name-txt">' + highlight(it.n, ui.q) + '</span>';
    let meta = '';
    if (!nameless && it.e)
      meta += '<span class="cl-meta-edid cl-mono" title="Editor id — what the console travels by">' +
        highlight(it.e, ui.q) + '</span>';
    if (marker)
      meta += '<span class="cl-meta-edid cl-meta-marker" title="A map marker — travel is player.moveto the marker itself">Map marker' +
        (it.mt ? ' · ' + highlight(it.mt, ui.q) : '') + '</span>';
    if (it.loc)
      meta += '<span class="cl-meta-loc" title="' + (marker || it.ext ? 'The worldspace this place is in' : 'The location this cell belongs to') + '">' +
        highlight(it.loc, ui.q) + '</span>';
    meta += '<span class="cl-meta-plug" data-plug="' + esc(it.p) + '" title="Browse every place ' +
      esc(it.p) + ' ships">' + esc(it.p) + '</span>';
    return '<div class="cl-row' + (selIdx === idx ? ' cl-sel' : '') + (open ? ' cl-row-open' : '') +
      '" data-id="' + esc(it.id) + '">' +
      '<div class="cl-mid">' +
      '<div class="cl-name" title="' + esc(title) + '">' + titleHtml + chipsHtml(it) +
      (nameless ? '<span class="cl-chip cl-chip-noname" title="This cell has no name of its own — its editor id is its handle, which is also what travel uses">no name</span>' : '') +
      (it.ext ? '<span class="cl-chip cl-chip-outdoors" title="An outdoor cell that kept an editor id — coc reaches it like any interior">Outdoors</span>' : '') +
      (marker ? '<span class="cl-chip cl-chip-marker" title="A travel point on the map — Go to marker teleports to this point">Map marker</span>' : '') +
      (marker && !it.vis ? '<span class="cl-chip cl-chip-warn" title="Not discovered on your map yet — travel works anyway">Undiscovered</span>' : '') +
      (marker && it.dis ? '<span class="cl-chip cl-chip-warn" title="The marker is not enabled yet (usually quest-gated) — travel still lands beside it">Not placed yet</span>' : '') +
      '</div>' +
      '<div class="cl-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="cl-act">' +
      '<button class="cl-btn cl-info' + (open ? ' cl-info-on' : '') + '" data-info="' + esc(it.id) +
      '" title="Travel method, console command, and destination details" ' +
      'aria-expanded="' + (open ? 'true' : 'false') + '">ⓘ Info</button>' +
      (canGo
        ? '<button class="cl-btn cl-do cl-primary" data-act="go" ' +
          'title="' + (marker
            ? 'Travel there now — player.moveto the map marker, which loads that part of the world (Enter does this too)'
            : 'Travel there now — the console&#39;s own coc, which loads the cell properly (Enter does this too)') +
          '">⤞ ' + (marker ? 'Go to marker' : 'Go there') + '</button>'
        : '<button class="cl-btn cl-do cl-cant" disabled ' +
          'title="This cell has no editor id, so the console cannot name it — nothing can travel to it">⤞ Go there</button>') +
      '</div></div>' +
      (open ? '<div class="cl-detail" data-for="' + esc(it.id) + '">' +
        detailInnerHtml(it.id, ui.detail[it.id]) + '</div>' : '');
  }

  /* ============================================================ detail == */

  function toggleDetail(id) {
    if (!id) return;
    if (ui.expanded === id) { ui.expanded = ''; renderBodyPreservingScroll(); return; }
    ui.expanded = id;
    if (!ui.detail[id] && !ui.detailErr[id]) requestDetail(id);
    renderBodyPreservingScroll();
  }

  function requestDetail(id) {
    toGame('cxQuery', JSON.stringify({ detail: id, seq: state.seq }));
  }

  function statHtml(label, value, cls) {
    return '<div class="cl-stat' + (cls ? ' ' + cls : '') + '">' +
      '<span class="cl-stat-l">' + esc(label) + '</span>' +
      '<span class="cl-stat-v">' + esc(value) + '</span></div>';
  }

  function detailInnerHtml(id, info) {
    if (ui.detailErr[id])
      return '<div class="cl-detail-err">' + esc(ui.detailErr[id]) + '</div>';
    if (!info)
      return '<div class="cl-detail-wait">Reading the destination…</div>';
    let html = '';
    if (info.marker) {
      html += statHtml('Travel', 'Go to marker — teleports to this map point');
      if (/^(?:0x)?[0-9a-f]{8}$/i.test(info.formId || ''))
        html += statHtml('Console command', 'player.moveto ' + info.formId.replace(/^0x/i, ''), 'cl-command');
      html += statHtml('Kind', 'Map marker' + (info.type ? ' · ' + info.type : ''));
      if (info.worldspace) html += statHtml('Worldspace', info.worldspace);
      html += statHtml('Discovered', info.discovered ? 'Yes — it is on your map' : 'Not yet');
      if (info.enabled === false) html += statHtml('Placed', 'Not yet (quest-gated)');
      if (info.formId) html += '<div class="cl-stat"><span class="cl-stat-l">Marker ref</span>' +
        '<span class="cl-stat-v cl-mono">' + esc(info.formId) + '</span></div>';
      if (info.plugin) html += statHtml('From', info.plugin);
      return '<div class="cl-stats">' + html + '</div>';
    }
    if (info.edid)
      html += statHtml('Console command', 'coc ' + info.edid, 'cl-command');
    /* Owner first: it is the only line that changes what happens when you walk
       in. "Nobody" is a real answer and is said, not left blank. */
    html += statHtml('Owner', info.owner
      ? info.owner + (info.ownerKind === 'faction' ? ' (faction)' : '')
      : 'Nobody');
    html += statHtml('Loaded right now', info.here ? 'You are standing in it'
      : info.attached ? 'Yes — it is attached' : 'No');
    if (info.loc) html += statHtml('Location', info.loc);
    if (info.edid) html += '<div class="cl-stat"><span class="cl-stat-l">Editor id</span>' +
      '<span class="cl-stat-v cl-mono">' + esc(info.edid) + '</span></div>';
    if (info.formId) html += '<div class="cl-stat"><span class="cl-stat-l">Form id</span>' +
      '<span class="cl-stat-v cl-mono">' + esc(info.formId) + '</span></div>';
    if (info.plugin) html += statHtml('From', info.plugin);
    return '<div class="cl-stats">' + html + '</div>';
  }

  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  /* Patch ONLY the open block, so a landing detail never rebuilds the list
     under the user's cursor (the NPC pane's anti-flash discipline). */
  function patchDetailInPlace(id) {
    const el = document.querySelector('#cl-body .cl-detail[data-for="' + cssEsc(id) + '"]');
    if (!el) { renderBodyPreservingScroll(); return; }
    el.innerHTML = detailInnerHtml(id, ui.detail[id]);
  }

  /* ============================================================ header == */

  function renderHeader() {
    const chip = $('cl-count-chip');
    if (chip) {
      chip.textContent = state.ready
        ? (fmtN(state.count) + ' places · ' + fmtN(state.plugins.length) + ' mods indexed')
        : 'reading the load order…';
    }
  }

  function renderPills() {
    const box = $('cl-pills');
    if (!box) return;
    box.innerHTML = KINDS.map(function (k) {
      return '<button class="cl-pill' + (ui.type === k[0] ? ' cl-pill-on' : '') +
        '" data-type="' + k[0] + '" aria-pressed="' + (ui.type === k[0] ? 'true' : 'false') +
        '" title="' + esc(k[3]) + '">' +
        (k[2] ? k[2] + ' ' : '') + esc(k[1]) + '</button>';
    }).join('');
    box.querySelectorAll('.cl-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.type = b.getAttribute('data-type');
        ui.sel = 0;
        runQuery(true);
        const s = $('cl-search');
        if (s) s.focus();
      });
    });
  }

  function renderPlugChip() {
    const chip = $('cl-plug-chip');
    if (!chip) return;
    if (!ui.plugin) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
    chip.classList.remove('hidden');
    chip.innerHTML = '<b title="' + esc(ui.plugin) + '">' + esc(ui.plugin) + '</b>' +
      '<span class="cl-chip-x" title="Search every mod again">✕</span>';
    const x = chip.querySelector('.cl-chip-x');
    if (x) x.addEventListener('click', clearPlugin);
  }

  /* ============================================================== body == */

  function renderBody() {
    const body = $('cl-body');
    const empty = $('cl-empty');
    if (!body || !empty) return;

    if (!state.ready) {
      body.innerHTML = new Array(7).fill(
        '<div class="cl-row cl-skel"><div class="cl-mid">' +
        '<span class="cl-skel-box cl-skel-w1"></span>' +
        '<span class="cl-skel-box cl-skel-w2"></span></div>' +
        '<span class="cl-skel-box cl-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = flatRows();

    /* hero — nothing asked yet */
    if (!rows.length && !ui.q && !ui.plugin && ui.type === 'all') {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="cl-empty-title">Every place the load order ships</div>' +
        '<div class="cl-empty-sub"><b>' + fmtN(state.count) + ' places</b> across <b>' +
        fmtN(state.plugins.length) + ' mods</b>, one bar. Type a place, an editor id, or a mod to browse ' +
        'everything it adds — then go straight there.<br>' +
        'Interiors · outdoors · map markers. Choose <b>Cells (COC)</b> for cell editor IDs, ' +
        'or <b>Map markers</b> to teleport to a point on the map. ' +
        'Nameless outdoor grid squares have no names to search, so those are not.</div>' +
        '<div class="cl-try">' +
        ['Breezehome', 'Bleak Falls', 'Sleeping Giant', 'Skyrim.esm'].map(function (t) {
          return '<button class="cl-pill" data-try="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-try]').forEach(function (b) {
        b.addEventListener('click', function () {
          const s = $('cl-search');
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
      empty.classList.remove('hidden');
      if (state.awaiting) {
        empty.innerHTML = '<div class="cl-empty-title">Searching…</div>';
      } else if (ui.type === 'mods') {
        empty.innerHTML = '<div class="cl-empty-title">No mod matches</div>' +
          '<div class="cl-empty-sub">No plugin name contains “' + esc(ui.q) + '”. Try fewer letters.</div>';
      } else {
        empty.innerHTML = '<div class="cl-empty-title">No ' +
          (ui.type === 'coc' ? 'COC cell' : ui.type === 'markers' ? 'map marker' : 'place') + ' matches</div>' +
          '<div class="cl-empty-sub">Nothing called “' + esc(ui.q) + '”' +
          (ui.plugin ? ' in ' + esc(ui.plugin) : '') +
          (ui.type === 'named' ? ' with a name of its own' : ui.type === 'unnamed' ? ' among the unnamed cells' : '') +
          '. Try fewer letters, another pill, or part of an editor id.' +
          (ui.type === 'named' ? ' Most modded dungeons have no name — try <b>Everywhere</b>.' : '') +
          '</div>';
      }
      return;
    }
    empty.classList.add('hidden');

    let html = '';
    let idx = 0;
    let inMods = false, inCells = false;
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        const modTotal = modMatches(0).length;
        const modDrawn = rows.filter(function (x) { return x.kind === 'plug'; }).length;
        html += '<div class="cl-sect">Mods <b>' + fmtN(modTotal) + '</b>' +
          (modDrawn < modTotal ? '<b>· showing ' + fmtN(modDrawn) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'cell' && !inCells) {
        inCells = true;
        html += '<div class="cl-sect">' +
          (ui.type === 'coc' ? 'COC cells' : ui.type === 'markers' ? 'Map markers' : 'Places') +
          ' <b>' + fmtN(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'more') html += moreModsRowHtml(r.left, ui.sel, idx);
      else if (r.kind === 'cell') html += cellRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    body.querySelectorAll('.cl-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
    const moreBtn = body.querySelector('.cl-plug-more');
    if (moreBtn) moreBtn.addEventListener('click', showMoreMods);
    /* Plain '.cl-row', not ':not(.cl-skel)': renderBody draws EITHER the
       skeleton or the rows and returns early in the skeleton branch, so no
       skeleton can be standing here — and the browserless harness's DOM
       has no selector negation. */
    body.querySelectorAll('.cl-row').forEach(function (row) {
      const id = row.getAttribute('data-id');
      function cell() {
        for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
      }
      row.querySelectorAll('.cl-do').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          /* A real browser never delivers a click to a disabled button; belt
             and braces anyway, and by ATTRIBUTE as well as property, because
             that is what the markup carries and what the harness can see. */
          if (b.disabled || b.getAttribute('disabled') !== null) return;
          const it = cell();
          if (it) act(b.getAttribute('data-act'), it);
        });
      });
      const infoBtn = row.querySelector('.cl-info');
      if (infoBtn) infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDetail(infoBtn.getAttribute('data-info'));
      });
      const plug = row.querySelector('.cl-meta-plug');
      if (plug) plug.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlugin(plug.getAttribute('data-plug'));
      });
    });
  }

  function renderBodyPreservingScroll() {
    const body = $('cl-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('cl-body');
    if (b2) b2.scrollTop = top;
  }

  function render() {
    renderHeader();
    renderPills();
    renderPlugChip();
    renderBody();
    renderFooter();
  }

  /* ============================================================= footer == */

  /* The pagination bar under the results, created dynamically and appended to
     #cl-pane (the NPC pane's shape) so no index.html edit is needed. */
  let footEl = null;

  function footHost() {
    const pane = $('cl-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'cl-foot';
      footEl.id = 'cl-foot';
      const body = $('cl-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  function footVisible() {
    if (!state.ready) return false;
    if (ui.type === 'mods') return false;                        // mods are local, not paged
    if (!ui.q && !ui.plugin && ui.type === 'all') return false;  // hero
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('cl-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;
    const first = total ? ui.page * ui.pageSize + 1 : 0;
    const last = Math.min(total, (ui.page + 1) * ui.pageSize);
    const multi = pc > 1;

    let html = '';
    if (multi) {
      html += '<button class="cl-foot-nav cl-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="cl-foot-count">Showing <b>' + fmtN(first) + '–' + fmtN(last) +
      '</b> of <b>' + fmtN(total) + '</b>' + (multi ? ' · page ' + (ui.page + 1) + ' of ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="cl-foot-nav cl-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="cl-foot-per" title="How many cells to show per page">' +
      '<span class="cl-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="cl-foot-size' + (n === ui.pageSize ? ' cl-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('cl-foot-on');

    const prev = foot.querySelector('.cl-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.cl-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.cl-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('cl-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('cl-toast-err', !!err);
    t.classList.add('cl-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('cl-toast-show'); }, 2600);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('cxState');   // first call builds the C++ index; later calls are cheap
    const s = $('cl-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready && (ui.q || ui.plugin || ui.type !== 'all')) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the bar pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.plugin = '';
    ui.type = 'all';
    const s = $('cl-search');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  function init() {
    const s = $('cl-search');
    if (s) {
      s.setAttribute('aria-label', 'Search cells and map markers');
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        queryDebounced();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Authoritative: preventDefault + stopPropagation so Enter never
             leaks to the deck's global handler (which would fire a random
             hotkey and close the palette). */
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
            const el = document.querySelector('#cl-body .cl-sel');
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
          /* bare Esc falls through to the palette's close, on purpose */
        } else if (e.key === 'Backspace' && !s.value && ui.plugin) {
          clearPlugin();
          e.stopPropagation();
        }
      });
    }
    /* Finder mode switch — the third of the merged tab. The typed query rides
       along, so "falkreath" over interiors becomes "falkreath" over people.
       app.js owns the actual tab flip (__hdFinderGo); a harness without it
       no-ops. */
    document.querySelectorAll('#cl-pane .fx-sw').forEach(function (b) {
      b.addEventListener('click', function () {
        const go = b.getAttribute('data-go');
        if (go !== 'cells' && typeof window.__hdFinderGo === 'function') window.__hdFinderGo(go, ui.q);
      });
    });

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_CELLS = [
    { id: 'Skyrim.esm|0165A8', n: 'Breezehome', e: 'WhiterunBreezehome', p: 'Skyrim.esm',
      loc: 'Whiterun', pub: false, wt: false, tv: true, wn: false },
    { id: 'Skyrim.esm|01AC5C', n: 'The Sleeping Giant Inn', e: 'RiverwoodSleepingGiantInn',
      p: 'Skyrim.esm', loc: 'Riverwood', pub: true, wt: false, tv: true, wn: false },
    { id: 'Skyrim.esm|01E7A8', n: 'Bleak Falls Barrow', e: 'BleakFallsBarrow01', p: 'Skyrim.esm',
      loc: 'Bleak Falls Barrow', pub: false, wt: true, tv: false, wn: false },
    { id: 'KuroneSoulTomb.esp|000D41', n: '', e: 'KuroneSoulTombHall02', p: 'KuroneSoulTomb.esp',
      loc: '', pub: false, wt: false, tv: false, wn: false },
    { id: 'KuroneSoulTomb.esp|000D42', n: 'Soul Tomb Sanctum', e: '', p: 'KuroneSoulTomb.esp',
      loc: 'Soul Tomb', pub: false, wt: false, tv: false, wn: true },
  ];

  const DEV_DETAIL = {
    'Skyrim.esm|0165A8': { owner: 'Player', ownerKind: 'person', attached: true, here: false,
      formId: '0x000165A8', edid: 'WhiterunBreezehome', loc: 'Whiterun', plugin: 'Skyrim.esm' },
  };

  function devState() {
    window.cxStateResult({
      phase: 'ready', count: 18422, pageSize: ui.pageSize,
      plugins: [
        { n: 'Skyrim.esm', c: 3244, k: 'esm', l: false },
        { n: 'KuroneSoulTomb.esp', c: 41, k: 'esp', l: true },
        { n: 'Dawnguard.esm', c: 288, k: 'esm', l: false },
      ],
    });
  }

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.detail) {
      const info = DEV_DETAIL[req.detail];
      window.cxResultData(info
        ? { seq: req.seq | 0, detail: req.detail, info: info }
        : { seq: req.seq | 0, detail: req.detail, info: {}, err: 'No dev detail fixture' });
      return;
    }
    const q = String(req.q || '').toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    const rows = DEV_CELLS.filter(function (it) {
      if (req.plugin && it.p !== req.plugin) return false;
      if (req.type === 'coc' && (isMarker(it) || !it.e)) return false;
      if (req.type === 'markers' && !isMarker(it)) return false;
      if (req.type === 'named' && !it.n) return false;
      if (req.type === 'unnamed' && it.n) return false;
      for (let i = 0; i < toks.length; i++) {
        if (it.n.toLowerCase().indexOf(toks[i]) === -1 &&
            it.e.toLowerCase().indexOf(toks[i]) === -1 &&
            String(it.loc).toLowerCase().indexOf(toks[i]) === -1 &&
            it.p.toLowerCase().indexOf(toks[i]) === -1) return false;
      }
      return true;
    });
    window.cxResultData({ seq: req.seq | 0, total: rows.length, offset: req.offset | 0,
      items: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || 60)) });
  }

  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    let row = null;
    for (let i = 0; i < DEV_CELLS.length; i++) if (DEV_CELLS[i].id === req.id) row = DEV_CELLS[i];
    if (row && !row.e && !isMarker(row)) {
      window.cxActResult({ ok: false, act: req.act, found: false,
        msg: labelOf(row) + ' has no editor id, so the console cannot name it — mark it as a Domain while you are there instead' });
      return;
    }
    window.cxActResult({ ok: true, act: req.act, found: true, msg: 'Traveling to ' + labelOf(row) });
  }

  function selftest() {
    const out = [];
    const t = function (name, ok) { out.push((ok ? 'PASS  ' : 'FAIL  ') + name); };
    t('labelOf prefers the name', labelOf({ n: 'Breezehome', e: 'X' }) === 'Breezehome');
    t('labelOf falls back to the editor id', labelOf({ n: '', e: 'X' }) === 'X');
    t('a nameless cell is detected', isNameless({ n: '', e: 'X' }) === true);
    t('page size snaps to a legal choice', clampPageSize(33) === 25);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'cells', label: 'Cells', tab: 'cells',
    setFilter: setFilter,
    index: function () {
      return [{
        label: 'Cell Finder',
        detail: 'Find cells and map markers — and travel straight to them',
        kind: 'cells',
        keywords: 'cell cells interior interiors exterior outdoors map marker room dungeon house inn place places travel coc moveto teleport find editor id',
      }];
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _state: state, _ui: ui, _flatRows: flatRows, _modMatches: modMatches,
    _labelOf: labelOf, _isNameless: isNameless, _chipsHtml: chipsHtml,
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _toggleDetail: toggleDetail, _detailInnerHtml: detailInnerHtml,
    _showsModSection: showsModSection, _act: act, _render: render,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.CellsPane.init(); });
} else {
  window.CellsPane.init();
}
