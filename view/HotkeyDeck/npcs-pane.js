'use strict';

/* ====================================================================== *
 *  NPCs — the fast NPC finder (Rober, 2026-08-13: "i was wondering if we
 *  could build a fast npc finder. Curious too if its possible to use the
 *  mesh framework to show an npcs face as the icon?").
 *
 *  The Items tab's structural twin. C++ owns the index, the matching and
 *  the actions (npc_finder.cpp); this pane owns the ONE bar, the pills and
 *  the face portraits. Faces are FaceGen head renders (icons/npcs/) made by
 *  the same Mesh Rendering Framework route as the item art — the row's `fc`
 *  is the FACE OWNER's identity, which for a templated NPC is "" and the
 *  row honestly keeps its glyph.
 *
 *  Bridge — requests: nxState() · nxQuery(json) · nxAct(json) · nxIcons(json)
 *  Replies (disjoint, per the deck law): nxStateResult({phase,count,mrf,
 *  plugins}) · nxResultData({seq,total,offset,items}) · nxActResult({ok,act,
 *  found,msg}) · nxIconsData({version,icons}). A successful goto/bring gets
 *  NO reply — C++ closes the palette and moves.
 *
 *  Host contract (mirrors ItemsPane): NpcsPane.init() · onShow() · onHide() ·
 *  toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.NpcsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;

  /* Pagination (Rober, 2026-08-14: "the finder page should probably be
     paginated with options to show how many per page … maybe default to 10?").
     A page is ONE query slice — state.items holds exactly the current page and
     never accumulates, so only the drawn rows ever request a face render (55
     faces at 1024px in one burst was the whole problem). Faces are the
     expensive renders, so this pane defaults to 10; item-explorer picks 25. */
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 10;

  /* The Mods roster is client-side (the plugin list arrives whole with nxState),
     so it grows a chunk at a time instead of paging through C++. The cap is a
     draw budget, never a claim about the roster — the section header always
     names the FULL match count, and the tail row reveals the rest (4,780 mods
     on the rig: capping silently hid most of them). */
  const MODS_PAGE = 30;
  const MODS_PREVIEW = 5;   // 'Everyone' searches show a taste of the mods, not the roster

  /* ============================================================== pills == */

  /* pseudo-kinds; 'all' and 'mods' the C++ never sees, the rest map to the
     C++ `type` filter. */
  const KINDS = [
    ['all',  'Everyone', '⌕'],
    ['mods', 'Mods',     '📦'],
    ['uniq', 'Unique',   '★'],
    ['fem',  'Women',    '♀'],
    ['male', 'Men',      '♂'],
  ];

  /* ============================================================== state == */

  const state = {
    ready: false,
    count: 0,
    mrf: true,       // Mesh Rendering Framework bound? false = glyphs forever, say so
    plugins: [],
    seq: 0,
    total: 0,
    items: [],
    awaiting: false,
    icons: {},       // "0XHEX8|plugin.esp" (lowercase plugin) -> view-relative png
  };

  const ui = {
    q: '',
    type: 'all',
    plugin: '',
    plugFilter: '',      // secondary fuzzy filter on the OWNING plugin name (client-side)
    plugFilterOpen: false,
    sel: 0,
    pageSize: DEFAULT_PAGE_SIZE,  // rows per page — restored from state, persisted on change
    page: 0,                      // current page, 0-based — SESSION-ONLY, never persisted
    modsShown: MODS_PAGE,         // how many mod rows are drawn — grows on "Show more", resets per search
    visible: false,
    debT: null,
    toastT: null,
    iconReq: {},
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
    hintSeen: false,   // the first-open "faces render in the background" hint
    /* Rich detail (2026-08-15): level/race/class/stats/factions per NPC, lazily
       fetched on expand. `expanded` = the open row id (one at a time); `detail`
       caches computed blocks by id; `detailErr` holds an honest failure reason. */
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
      if (DEV && fn === 'nxState') setTimeout(devState, 30);
      if (DEV && fn === 'nxQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'nxAct') setTimeout(function () { devAct(arg); }, 30);
      if (DEV && fn === 'niInspect') setTimeout(function () { devInspect(arg); }, 30);
    }
  }

  window.nxStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.phase === 'ready';
    state.count = d.count | 0;
    state.mrf = d.mrf !== false;
    state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
    /* On-disk face/body index handed over at state time (a new DLL). Seeding
       state.icons here is what lets a previously-rendered face draw on the
       FIRST paint of a query — no nxIcons round-trip, no shimmer, no reload
       flash (the 2026-08-14 "faces aren't saved" fix). An old DLL omits it and
       faces still arrive via the nxIcons reply, just a beat later. */
    if (d.icons && typeof d.icons === 'object') {
      for (const k in d.icons) if (typeof d.icons[k] === 'string') state.icons[k] = d.icons[k];
    }
    /* Persisted page size from the DLL. Absent (an old DLL) => keep our default,
       so the pane still paginates — old-DLL tolerance in the read direction. */
    if (typeof d.pageSize === 'number' && d.pageSize > 0) ui.pageSize = clampPageSize(d.pageSize);
    if (ui.visible) {
      if (state.ready && (ui.q || ui.plugin || ui.type !== 'all') && !state.items.length && !state.awaiting)
        runQuery(true);
      render();
    }
  };

  /* Reply to nxSave: the DLL confirms the persisted page size (needs main.cpp's
     nxSave listener; until wired, this simply never arrives and the size stays
     session-only — the pane keeps working either way). */
  window.nxSaved = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) {
      const p = clampPageSize(d.pageSize);
      if (p !== ui.pageSize) { ui.pageSize = p; if (ui.visible) runQuery(true); }
    }
  };

  window.nxResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    /* Detail reply (a row expansion) rides this SAME listener — keyed by the
       `detail` field a page reply never carries — so no new C++ bridge was
       needed. NOT gated on seq: a detail can land after the next page query
       bumped state.seq, and dropping it would leave the block spinning. */
    if (typeof d.detail === 'string' && d.detail) {
      if (d.info && typeof d.info === 'object' && Object.keys(d.info).length)
        { ui.detail[d.detail] = d.info; delete ui.detailErr[d.detail]; }
      else ui.detailErr[d.detail] = d.err || 'Could not read this NPC';
      if (ui.visible && ui.expanded === d.detail) patchDetailInPlace(d.detail);
      return;
    }
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
    /* A page REPLACES — state.items is exactly the current page, never the
       accumulation the old "Show more" foot built up. This is what shrinks the
       face-render burst with page size: requestIcons() only ever sees one page. */
    state.items = Array.isArray(d.items) ? d.items : [];
    if (state.items.length) askStatusMaps();   // a page landed: make sure its chips can
    /* A page that no longer exists (total shrank under a stale offset, or the
       last page emptied) — step back to the last real page and re-ask. */
    if (!state.items.length && state.total > 0 && ui.page > 0 &&
        ui.page * ui.pageSize >= state.total) {
      ui.page = Math.max(0, Math.ceil(state.total / ui.pageSize) - 1);
      runQuery(false);
      return;
    }
    ui.sel = 0;
    if (ui.visible) render();
  };

  window.nxActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    /* The spawn guard: C++ answered "this copy would be faceless" instead of
       placing anything. A toast is the wrong shape for that — it vanishes, and
       it offers nothing to press. Open the card, which states the reason and
       carries the verb that actually works. Any DLL that doesn't know about
       the guard never sets `warn`, so this branch simply never fires. */
    if (d.warn === 'faceless' && d.id) { openSpawnGuard(d); return; }
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
  };

  /* Face renders landed (a reply to our nxIcons, or the C++ batch-done push).
     Merge, and upgrade the affected rows IN PLACE only if something changed.

     Root cause of the "faces always have to load again" flash (2026-08-14):
     an already-rendered face IS reused by C++ (EnqueueFaceLocked returns false
     on FileExists — no MRF render), and its path comes back on the very first
     nxIcons reply. But the view then rebuilt the WHOLE #nx-body innerHTML,
     which destroyed and recreated every <img>; in these compositor-off
     Ultralight views that forces a re-decode of a PNG that was already on
     screen — the visible "reload". So a landed icon now patches ONLY the
     <img> of the rows that changed (add the plate image, never touch an <img>
     already showing the right src), leaving the rest of the DOM — and every
     already-decoded image — untouched. */
  window.nxIconsData = function (d) {
    if (!d || typeof d !== 'object' || typeof d.icons !== 'object' || !d.icons) return;
    let changed = false;
    for (const k in d.icons) {
      if (state.icons[k] !== d.icons[k]) { state.icons[k] = d.icons[k]; changed = true; }
    }
    if (changed) { chipLastLand = Date.now(); dismissHintIfDone(); }   // progress: keep the chip honest
    if (changed && ui.visible) upgradeIconsInPlace();
    updateRenderChip();
  };

  /* Patch the drawn rows' plates to reflect state.icons WITHOUT rebuilding the
     list — the anti-flash path. For each on-screen NPC row: if its art now
     resolves and the plate has no <img> yet, mount one (and face-fit it); if
     the plate already shows the correct src, leave it exactly as it is so
     Ultralight never re-decodes it. Rows whose art is still pending keep their
     glyph + shimmer. Never a full innerHTML rebuild, so nothing on screen
     flickers when a single face lands. */
  function upgradeIconsInPlace() {
    const body = $('nx-body');
    if (!body) return;
    let mountedAny = false;
    body.querySelectorAll('.nx-row:not(.nx-skel)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      let it = null;
      for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) { it = state.items[i]; break; }
      if (!it) return;
      const plate = row.querySelector('.nx-plate');
      if (!plate) return;
      const art = artFor(it);
      const existing = plate.querySelector('img.nx-art');
      if (!art) {
        /* art went away (shouldn't for a landed render, but stay honest) */
        if (existing) { existing.parentNode.removeChild(existing); plate.classList.remove('nx-has-art', 'nx-zoomable', 'nx-has-body'); }
        return;
      }
      if (existing) {
        /* Already showing SOMETHING — only swap the src if it actually differs,
           and never rebuild the element (that is the re-decode we are avoiding). */
        if (existing.getAttribute('src') !== art.url) existing.setAttribute('src', art.url);
        return;
      }
      /* No image yet: mount one over the glyph, mirroring plateInner()/npcRowHtml. */
      const img = document.createElement('img');
      img.className = 'nx-art' + (art.body ? ' nx-art-body' : '');
      img.setAttribute('alt', '');
      img.setAttribute('draggable', 'false');
      img.onerror = function () {
        const b = img.parentNode;
        if (b) { b.classList.remove('nx-has-art'); b.removeChild(img); }
      };
      img.setAttribute('src', art.url);
      plate.appendChild(img);
      plate.classList.remove('nx-loading');
      plate.classList.add('nx-has-art', 'nx-zoomable');
      if (art.body) plate.classList.add('nx-has-body');
      /* the tmpl "no portrait" chip is now wrong — it got a picture */
      const tchip = row.querySelector('.nx-chip-tmpl');
      if (tchip) tchip.parentNode.removeChild(tchip);
      /* face-fit the new face tile (bodies show whole — nx-art-body excluded) */
      if (!art.body && window.HDFaceFit) window.HDFaceFit.ensure(img, art.url);
      /* the plate wasn't zoomable before, so its lightbox click isn't wired —
         wire it now for the newly-mounted art. */
      plate.addEventListener('click', function (e) {
        e.stopPropagation();
        openLightbox(it);
      });
      mountedAny = true;
    });
    /* keep the "rendering N…" chip / shimmer honest after a batch of mounts */
    if (mountedAny) armChipWatchdog(renderWindowActive());
  }

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
    /* a new search re-arms the render chip, and re-caps the mod roster */
    if (reset) { ui.page = 0; ui.modsShown = MODS_PAGE; chipLastLand = Date.now(); }
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!ui.q && !ui.plugin && ui.type === 'all') {
      state.items = []; state.total = 0; state.awaiting = false; ui.page = 0;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    ui.sel = 0;
    toGame('nxQuery', JSON.stringify({
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
     re-queries the new slice, so the face-render window follows the page. */
  function gotoPage(p) {
    const pc = pageCount();
    p = Math.max(0, Math.min(pc - 1, Math.round(p) || 0));
    if (p === ui.page) return;
    ui.page = p;
    chipLastLand = Date.now();     // a new page re-arms the render chip for its rows
    runQuery(false);
    const body = $('nx-body');
    if (body) body.scrollTop = 0;  // a fresh page reads from the top
    const s = $('nx-search');
    if (s) s.focus();
  }

  /* The per-page selector. Persists through the DLL sidecar (nxSave) AND resets
     to page 1 — a smaller page from deep in a big result set would otherwise
     land on an out-of-range page. */
  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    toGame('nxSave', JSON.stringify({ pageSize: ui.pageSize }));
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

  /* ================================================ secondary plugin filter ==
     A fuzzy, client-side narrowing on the OWNING plugin name (Rober, 2026-08-14:
     "122 Prisoner NPCs across arnima.esm / miranda.esp" — after a name search,
     narrow to one source plugin by typing a partial esp/esl/esm name). Composes
     with the name search, the pills and the mod-chip browse; never touches C++
     (the `ui.plugin` browse is EXACT — this is the loose companion). Fuzzy =
     case-insensitive substring first, then per-token substring, then a
     subsequence fallback so "mrnd" still finds "miranda.esp". Results are
     server-paginated, so this filters the CURRENT page's rows; the People
     section header shows the on-page filtered count so it stays honest. */
  function pluginFuzzy(pluginName, query) {
    const p = String(pluginName || '').toLowerCase();
    const q = String(query || '').toLowerCase().trim();
    if (!q) return true;
    if (p.indexOf(q) !== -1) return true;                      // whole-query substring
    const toks = q.split(/\s+/).filter(Boolean);
    if (toks.length > 1 && toks.every(function (t) { return p.indexOf(t) !== -1; })) return true;
    const chars = q.replace(/\s+/g, '');
    let i = 0;
    for (let c = 0; c < p.length && i < chars.length; c++) if (p[c] === chars[i]) i++;
    return i === chars.length;
  }

  function passesPlugFilter(it) {
    if (!ui.plugFilter) return true;
    return pluginFuzzy(it && it.p, ui.plugFilter);
  }

  /* ====================================================== selection model == */

  function flatRows() {
    const rows = [];
    if (showsModSection()) {
      const cap = ui.type === 'mods' ? ui.modsShown : MODS_PREVIEW;
      const all = modMatches(0);
      all.slice(0, cap).forEach(function (p) { rows.push({ kind: 'plug', p: p }); });
      /* Selectable, so Down-Down-Enter reaches the rest without the mouse. */
      if (ui.type === 'mods' && all.length > cap)
        rows.push({ kind: 'more', left: all.length - cap });
    }
    if (ui.type !== 'mods') {
      state.items.forEach(function (it) {
        if (passesPlugFilter(it)) rows.push({ kind: 'npc', it: it });
      });
      /* no 'more' row — paging is the footer bar under the list now */
    }
    return rows;
  }

  function showsModSection() {
    if (ui.plugin) return false;
    if (ui.type === 'mods') return true;
    return ui.type === 'all' && !!ui.q;
  }

  /* Enter = Bring: "fast npc finder" means "get her HERE" more often than
     anything else, and a miss is a harmless toast, never a teleport. */
  function activate(row) {
    if (!row) return;
    if (row.kind === 'plug') { setPlugin(row.p.n); return; }
    if (row.kind === 'more') { showMoreMods(); return; }
    if (row.kind === 'npc') act('bring', row.it);
  }

  /* Grow the mod roster in place. Selection stays where it is, so the row the
     button sat on becomes the first of the new batch. */
  function showMoreMods() {
    ui.modsShown += MODS_PAGE;
    renderBodyPreservingScroll();
  }

  /* ============================================================= actions == */

  /* `opts.force` is the spawn guard's "Spawn anyway" — the ONLY thing that
     sends force:true, and only after the user has read why the copy will be
     faceless. Every other caller sends the same two-field payload it always
     did, so an old DLL (which simply ignores an unknown key) still works. */
  function act(what, it, opts) {
    const req = { act: what, id: it.id };
    if (opts && opts.force) req.force = true;
    toGame('nxAct', JSON.stringify(req));
    if (what === 'spawn') toast('Placing ' + it.n + '…');
  }

  function setPlugin(name) {
    ui.plugin = String(name || '');
    ui.q = '';
    ui.plugFilter = '';           // browsing INSIDE a mod makes the fuzzy filter redundant
    ui.plugFilterOpen = false;
    const s = $('nx-search');
    if (s) { s.value = ''; s.focus(); }
    if (ui.type === 'mods') ui.type = 'all';
    runQuery(true);
  }

  function clearPlugin() {
    ui.plugin = '';
    runQuery(true);
    const s = $('nx-search');
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

  /* ============================================================== faces == */

  /* Row fc "Skyrim.esm|000A2C8E" -> the C++ KeyOf normalisation: the payload
     formId is '0x'+hex, and KeyOf uppercases the whole fid and lowercases the
     plugin — "0X000A2C8E|skyrim.esm". One function owns that here. */
  function faceParts(fc) {
    const s = String(fc || '');
    const bar = s.lastIndexOf('|');
    if (bar < 1) return null;
    const plugin = s.slice(0, bar);
    const hex = s.slice(bar + 1);
    if (!plugin || !hex) return null;
    return { formId: '0x' + hex, plugin: plugin };
  }

  function faceKey(fc) {
    const p = faceParts(fc);
    if (!p) return '';
    return p.formId.toUpperCase() + '|' + p.plugin.toLowerCase();
  }

  function safePath(path) {
    if (!path) return '';
    if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
    return path;
  }

  function iconFor(fc) {
    const key = faceKey(fc);
    if (!key) return '';
    return safePath(state.icons[key] || '');
  }

  /* Creature body render. `bd` is "SkinPlugin.esp|HEX6" (C++ blanks `fc` and
     fills `bd` when the facegen head can't render — atronachs, spiders,
     draugr, rieklings). Same icon map, same KeyOf normalisation; body keys
     never collide with face keys because a creature has no face render and a
     humanoid has no body one. */
  function bodyIconFor(bd) {
    const key = faceKey(bd);   // identical "0X{HEX}|{plugin}" normalisation
    if (!key) return '';
    return safePath(state.icons[key] || '');
  }

  /* The row's art, whichever kind exists: face first, then creature body. The
     `body` flag matters downstream — a body render must NOT be face-fitted
     (there is no skull to zoom onto; it shows whole, contain-fit). */
  function artFor(it) {
    const f = iconFor(it && it.fc);
    if (f) return { url: f, body: false };
    const b = bodyIconFor(it && it.bd);
    if (b) return { url: b, body: true };
    return null;
  }

  /* ---- loading visibility: "rendering faces…" chip + per-row shimmer -----
     Renders land one by one over seconds and rows upgrade as they do, which
     reads as CHOPPY with no explanation, and worse, the un-landed rows look
     FINAL — a plain glyph, nothing saying art is coming (Rober, 2026-08-14:
     "it wasn't obvious it was loading anything"). So a row whose face is
     expected-but-not-yet-landed SHIMMERS, and the chip names the count. Both
     hide after 30s without a single new face landing, because a row whose NPC
     has no facegen file will never land — a spinner that can't finish, and a
     shimmer that never resolves, are both worse than none. A templated row
     (no faceParts) is never loading: its glyph is its honest final state. */
  const RENDER_IDLE_MS = 30000;
  let renderChip = null;
  let chipLastLand = 0;
  let chipT = null;   // watchdog: repaint at window-close so the cues drop

  /* A face render still plausibly in flight? MRF bound, armed (a request went
     out so chipLastLand is set), progress within the idle window, and at least
     one non-templated row still lacks its face. */
  function renderWindowActive() {
    return state.mrf && chipLastLand > 0 && missingArt() &&
      (Date.now() - chipLastLand) < RENDER_IDLE_MS;
  }

  /* This row is expected to get a face and hasn't yet — draw it as loading.
     Templated rows (faceParts null) never qualify. */
  function rowLoading(it) {
    return renderWindowActive() && !!faceParts(it.fc) && !iconFor(it.fc);
  }

  function updateRenderChip() {
    const pane = $('nx-pane');
    if (!pane) return;
    if (!renderChip) {
      renderChip = document.createElement('div');
      renderChip.className = 'nx-render-chip';
      renderChip.innerHTML = '<span class="nx-render-spin"></span><span class="nx-render-txt"></span>';
      pane.appendChild(renderChip);
    }
    let pending = 0;
    (state.items || []).forEach(function (it) {
      if (faceParts(it.fc) && !iconFor(it.fc)) pending++;
    });
    const active = pending > 0 && renderWindowActive();
    renderChip.classList.toggle('nx-on', !!active);
    if (active) {
      renderChip.querySelector('.nx-render-txt').textContent =
        'rendering ' + pending + ' face' + (pending === 1 ? '' : 's') + '…';
      /* Anchor at the very top of the results, right-aligned — it lands over
         the "People N" section-header band (empty on the right) and floats
         above the rows (pointer-events:none, so a row it grazes stays fully
         clickable). Measured, so it tracks wherever the header wraps to. */
      const body = $('nx-body');
      if (body && body.offsetTop) renderChip.style.top = body.offsetTop + 'px';
    }
    armChipWatchdog(active);
  }

  /* Nothing else fires at the idle mark, so a lone timer repaints once the
     window is about to close — dropping the chip AND every row's shimmer. */
  function armChipWatchdog(active) {
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (!active) return;
    const left = Math.max(250, RENDER_IDLE_MS - (Date.now() - chipLastLand) + 60);
    chipT = setTimeout(function () {
      chipT = null;
      if (ui.visible) renderBodyPreservingScroll();
    }, left);
  }

  /* The one-time first-open hint (dismissed on the first full completion). */
  function firstOpenHint() {
    return !ui.hintSeen && renderWindowActive();
  }
  function dismissHintIfDone() {
    if (ui.hintSeen) return;
    if (chipLastLand > 0 && !missingArt()) ui.hintSeen = true;
  }

  /* Ask C++ for the faces of the drawn rows that lack one — bounded to
     state.items, deduped for the session (the Items tab discipline). */
  function requestIcons() {
    if (!state.mrf || !state.items.length) return;
    const items = [], seen = {};
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      const p = faceParts(it.fc);
      if (!p) continue;                             // templated: no face file, ever
      const key = faceKey(it.fc);
      if (ui.iconReq[key] || seen[key]) continue;
      if (iconFor(it.fc)) continue;
      seen[key] = 1;
      ui.iconReq[key] = 1;
      items.push({ formId: p.formId, plugin: p.plugin, name: it.n || '' });
    }
    if (items.length) toGame('nxIcons', JSON.stringify({ items: items }));
  }

  /* The settle gate + on-disk poll, verbatim from the Items tab (its 2026-08-13
     play-test lesson): ask only once results sit still, then nudge with an
     EMPTY nxIcons while drawn rows still lack art — renders land one by one. */
  const ICON_SETTLE_MS = 650;
  const ICON_POLL_MS = 2500;
  const ICON_POLL_MAX = 24;

  function scheduleIconWork() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (!state.items.length) { stopIconPoll(); return; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      if (!ui.visible) return;
      requestIcons();
      startIconPoll();
    }, ICON_SETTLE_MS);
  }

  function missingArt() {
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i];
      if (faceParts(it.fc) && !iconFor(it.fc)) return true;
    }
    return false;
  }

  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }

  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    if (!state.mrf || !missingArt()) return;
    ui.iconPollT = setInterval(iconPollTick, ICON_POLL_MS);
  }

  function iconPollTick() {
    if (!ui.visible || !missingArt() || ++ui.iconPollN > ICON_POLL_MAX) {
      stopIconPoll();
      return false;
    }
    toGame('nxIcons', JSON.stringify({ items: [] }));
    return true;
  }

  function flushIconsForTest() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    requestIcons();
  }

  /* Face plate: real render over the glyph; a broken path removes itself and
     the glyph stays (never a broken-image box). NEVER a ?v= query — Ultralight
     drops it and fails the load. */
  const ICO_ERR = ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;nx-has-art&quot;);' +
    'b.removeChild(this);}"';

  function plateInner(it) {
    const glyph = it.s === 'f' ? '♀' : '♂';
    const art = artFor(it);
    if (!art) return glyph;
    /* A body render carries nx-art-body so the face-fit pass skips it (a
       creature has no skull to zoom onto) — it shows whole, contain-fit. */
    const cls = 'nx-art' + (art.body ? ' nx-art-body' : '');
    return glyph + '<img class="' + cls + '" src="' + esc(art.url) + '" alt="" draggable="false"' + ICO_ERR + '>';
  }

  /* ============================================================ lightbox == */

  /* Click the plate -> the big render (hd-lightbox.js). A FACE takes the
     hdSpin turntable (hold + drag turns the head — baked on first drag, never
     on open); a creature body stays the plain big view (its bake belongs to
     the Mounts pane, which resolves the body NIF). */
  function openLightbox(it) {
    const art = artFor(it);
    const url = art ? art.url : '';
    if (!url || !window.HDLightbox) return;
    const fp = !art.body ? faceParts(it.fc) : null;
    HDLightbox.open({
      host: $('nx-pane'),
      src: url,
      glyph: it.s === 'f' ? '♀' : '♂',
      title: it.n,
      sub: (it.r || (it.s === 'f' ? 'Woman' : 'Man')) + ' · ' + it.p +
        (it.u ? ' · ★ unique' : '') + (it.e ? ' · ⛨ essential' : ''),
      spin: fp ? { kind: 'face', formId: fp.formId, plugin: fp.plugin } : null,
    });
  }

  /* =========================================================== inspect == *
   *  THE INSPECT CARD — "look at any NPC and see what they actually are"
   *  (Rober, 2026-08-17, catching up with Skyrim Party Sheet's headline
   *  feature). The ⓘ detail block below reads the BASE RECORD — who this
   *  person is in the load order. This reads the LIVE ACTOR — what is
   *  standing in front of you: a levelled bandit whose record says level 1
   *  and 0/0/0 is, right now, level 48 with 700 health, a fortified axe and
   *  three poisons running.
   *
   *  Bridge: niInspect({}|{id}|{ref}, seq) -> niInspectData({ok,…}). Disjoint
   *  names, per the deck law. C++: src/npc_inspect.cpp.
   *
   *  It is a SHEET over the pane, not a row expansion: there is far too much
   *  of it for an inline block, and it must be reachable with no search at
   *  all (the crosshair path opens it straight from the header).
   *
   *  ENGINE LAWS THIS OBEYS — measured in PrismaUI's own Ultralight 1.4.1:
   *    * NO conic-gradient (it computes to `none` there, silently). Every
   *      meter in here is a linear track + a width-driven fill.
   *    * NO vh/vw anywhere. The sheet lives INSIDE #panel, which carries
   *      transform: scale(--ui-scale), so a bare viewport unit would render
   *      at size×scale and clip at Fill. Percentages of the pane and plain
   *      px scale correctly with it and need no calc() division.
   *    * No looping animations, no animated background-position.
   *    * Emoji rasterise monochrome at a 1.4em advance, so every glyph box is
   *      sized ≥ 1.5em or the mark gets shaved.
   * ====================================================================== */

  /* Effect piles, in the order the sheet shows them. `all` is a pseudo-pile. */
  const EFF_PILES = [
    ['all', 'Everything', ''],
    ['debuff', 'Debuffs', '▼'],
    ['poison', 'Poisons', '☠'],
    ['disease', 'Diseases', '☣'],
    ['buff', 'Buffs', '▲'],
    ['constant', 'Always on', '∞'],
  ];

  /* The nine equipment slots, in the fixed order C++ sends them. Kept here so
     a tile can carry a label + glyph even when the slot is EMPTY — the grid
     must not reflow as someone swaps gear mid-inspection. */
  const EQ_GLYPH = {
    head: '⌂', body: '⛨', hands: '✋', feet: '⇣', amulet: '◇', ring: '○',
    right: '⚔', left: '✦', ammo: '➤',
  };

  const insp = {
    open: false,
    seq: 0,          // bumped per request; a reply with an older seq is dropped
    data: null,      // the last good payload
    err: '',         // an honest refusal sentence
    why: '',         // its machine-readable reason
    loading: false,
    filter: '',      // ONE sheet-wide filter: effects + factions + skills
    pile: 'all',
    hidden: false,   // show the engine's kHideInUI plumbing effects too
    portrait: '',    // the row's face render, when opened from a row
    glyph: '♀',
    title: '',       // who we ASKED about, so the loading state has a name
    skillsOpen: false,
    chim: null,      // { npcName, loading, err, reply } — CHIM's own facets, fetched separately (see fetchChim)
  };

  /* --------------------------------------------------------------- bridge -- */

  window.niInspectData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ((d.seq | 0) !== insp.seq) return;      // a reply from an older click
    insp.loading = false;
    if (d.ok) {
      insp.data = d;
      insp.err = '';
      insp.why = '';
      if (d.who && d.who.name) insp.title = d.who.name;
      fetchChim(d.who && d.who.name);
    } else {
      insp.data = null;
      insp.err = d.msg || 'That could not be read.';
      insp.why = d.why || '';
    }
    renderInspect();
  };

  /* CHIM's own facets for the open NPC — a SEPARATE fetch from niInspect (that
     one reads the live RE::Actor; this one asks CHIM's Postgres via the same
     structured, instant, non-LLM channel the Home "Ask (CHIM)" overlay already
     uses). Gated on the same 'chim' detection flag every other CHIM surface
     reads. Keyed by name, not FormID/EditorID — CHIM's core_npc_master has no
     other identity (sharmat-wiring.md's "Name resolution"). */
  function fetchChim(name) {
    insp.chim = null;
    if (!name || window.__hdFlagAbsent('chim')) return;
    if (!window.HDOmni || typeof HDOmni.askStructured !== 'function') return;
    const target = name;
    insp.chim = { npcName: target, loading: true, err: '', reply: null };
    HDOmni.askStructured(target, 'tell me about them', function (env) {
      /* The sheet may have moved to someone else (or a fresh fetch already
         superseded this one) by the time CHIM answers — drop it silently,
         same law as niInspect's own insp.seq guard above. */
      if (!insp.chim || insp.chim.npcName !== target) return;
      if (!env || !env.ok) {
        insp.chim.loading = false;
        insp.chim.err = (env && env.chimDown)
          ? 'CHIM isn’t reachable — is the server up?'
          : ((env && env.error) || 'CHIM ask failed.');
        renderInspect();
        return;
      }
      let body = env.json;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || body.ok === false) {
        insp.chim.loading = false;
        insp.chim.err = (body && body.error) || 'CHIM had nothing to say.';
        renderInspect();
        return;
      }
      insp.chim.loading = false;
      insp.chim.reply = body;
      renderInspect();
    });
  }

  /* `id` null/'' = the crosshair target. `opts` carries the row's own face art
     and name so the sheet has a face and a title while C++ is still reading. */
  function openInspect(id, opts) {
    const o = opts || {};
    insp.open = true;
    insp.loading = true;
    insp.data = null;
    insp.err = '';
    insp.why = '';
    insp.filter = '';
    insp.pile = 'all';
    insp.hidden = false;
    insp.skillsOpen = false;
    insp.chim = null;
    insp.portrait = o.portrait || '';
    /* The caller's saved framing for that picture, when it has one. Only the
       caller knows WHICH art it handed us: a row lends a FaceGen head render
       (measured/overridden by HDFaceFit), while the Followers card lends a
       portrait PHOTO whose crop lives in that pane's own store. Passing the
       crop rather than reaching into another pane keeps each pane the
       authority on its own art — and npcs-pane can open with followers-pane
       not yet parsed (it is later in the boot manifest). */
    insp.crop = o.crop || null;
    /* …and WHICH KIND of picture it is, because that decides the fitter even
       when there is no crop yet. A photo with no crop must keep the
       stylesheet's framing; running the head-render MEASUREMENT over it would
       invent a framing from a heuristic calibrated for FaceGen heads on a plain
       background, which a screen grab is not. */
    insp.portraitKind = o.portraitKind === 'photo' ? 'photo' : 'render';
    insp.glyph = o.glyph || '♀';
    insp.title = o.name || '';
    insp.seq++;
    const req = { seq: insp.seq };
    /* A caller with a RUNTIME formId (the F7 quick card's Full stats button)
       passes opts.ref — C++ resolves the exact reference, so a spawned copy
       is never confused with her template. `id` stays the roster-row spelling
       (base plugin|formId), '' the crosshair. */
    if (o.ref) req.ref = String(o.ref);
    else if (id) req.id = id;
    toGame('niInspect', JSON.stringify(req));
    renderInspect();
  }

  function closeInspect() {
    if (!insp.open) return;
    insp.open = false;
    insp.data = null;
    insp.err = '';
    insp.chim = null;
    gearStopPoll();
    const host = document.getElementById('nxi-sheet');
    if (host) host.parentNode.removeChild(host);
    const s = $('nx-search');
    if (s) s.focus();
  }

  /* ------------------------------------------------------------ formatting -- */

  function fmt1(n) {
    const v = Number(n) || 0;
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  /* A duration a human reads: 8s · 2m 40s · 1h 12m. Anything past a day is a
     day count — an effect with a 30-day timer is "constant" in every way that
     matters and a six-digit second count says nothing. */
  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd';
  }

  function pct(v, max) {
    const m = Number(max) || 1;
    const p = (Number(v) || 0) / m * 100;
    return Math.max(0, Math.min(100, p));
  }

  function matchesFilter(text) {
    if (!insp.filter) return true;
    return String(text == null ? '' : text).toLowerCase().indexOf(insp.filter.toLowerCase()) !== -1;
  }

  /* ------------------------------------------------------------- sections -- */

  function meterHtml(cls, label, valueText, fillPct, capNote) {
    return '<div class="nxi-meter ' + cls + '">' +
      '<div class="nxi-meter-head">' +
      '<span class="nxi-meter-name">' + esc(label) + '</span>' +
      '<span class="nxi-meter-val">' + esc(valueText) +
      (capNote ? '<span class="nxi-meter-cap"> / ' + esc(capNote) + '</span>' : '') +
      '</span></div>' +
      '<div class="nxi-meter-track"><div class="nxi-meter-fill" style="width:' +
      Math.round(fillPct) + '%"></div></div></div>';
  }

  function vitalsHtml(d) {
    const pools = d.pools || {};
    const regen = d.regen || {};
    const rows = [
      ['hp', 'Health', pools.hp, regen.hp],
      ['mag', 'Magicka', pools.mag, regen.mag],
      ['sta', 'Stamina', pools.sta, regen.sta],
    ];
    let html = '<div class="nxi-vitals">';
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i][0], label = rows[i][1];
      const p = rows[i][2] || { cur: 0, max: 0 };
      const rate = rows[i][3];
      const cur = Math.round(Number(p.cur) || 0);
      const max = Math.round(Number(p.max) || 0);
      let rateHtml = '';
      if (regen.has && Number(rate)) {
        const up = Number(rate) > 0;
        rateHtml = '<span class="nxi-rate' + (up ? '' : ' nxi-rate-down') + '" title="' +
          (up ? 'Points regained' : 'Points lost') + ' every second' +
          (key === 'hp' && regen.inCombat
            ? ' — they are IN COMBAT, and the engine slows health regen further by an amount it never exposes'
            : '') + '">' + (up ? '+' : '') + fmt1(rate) + '/s' +
          (key === 'hp' && regen.inCombat ? ' <b class="nxi-rate-caveat">out of combat</b>' : '') +
          '</span>';
      }
      html += '<div class="nxi-vital nxi-v-' + key + '">' +
        '<div class="nxi-vital-head"><span class="nxi-vital-name">' + label + '</span>' +
        '<span class="nxi-vital-nums"><b>' + fmtN(cur) + '</b><span class="nxi-vital-max"> / ' +
        fmtN(max) + '</span></span></div>' +
        '<div class="nxi-vital-track"><div class="nxi-vital-fill" style="width:' +
        Math.round(pct(cur, max || 1)) + '%"></div></div>' +
        (rateHtml ? '<div class="nxi-vital-foot">' + rateHtml + '</div>' : '') +
        '</div>';
    }
    return html + '</div>';
  }

  /* Defences. A NEGATIVE resist is the interesting number — that is a real
     weakness, and it is exactly what a "know your enemy" style mod would tell
     you, read straight off the actor values so it is true for whatever put it
     there. It gets its own word and its own colour rather than a 0%-wide bar
     nobody can read. */
  function resistsHtml(d) {
    const r = d.resist || {};
    const capM = Number(r.capMagic) || 85;
    const capP = Number(r.capPhys) || 80;
    const defs = [
      ['fire', 'Fire', r.fire, capP],
      ['frost', 'Frost', r.frost, capP],
      ['shock', 'Shock', r.shock, capP],
      ['magic', 'Magic', r.magic, capM],
      ['poison', 'Poison', r.poison, capP],
      ['disease', 'Disease', r.disease, capP],
    ];
    let html = '<div class="nxi-armor">' +
      meterHtml('nxi-m-armor', 'Armour rating ' + fmtN(r.armor || 0),
        fmt1(r.phys || 0) + '%', pct(r.phys, capP), fmtN(capP) + '% cap') +
      '<div class="nxi-armor-note">' +
      esc('Rating × 0.12, plus 3% for each of the ' + (r.pieces | 0) +
        ' armour piece' + ((r.pieces | 0) === 1 ? '' : 's') + ' they are wearing — Skyrim’s own formula.') +
      '</div></div>';

    html += '<div class="nxi-resists">';
    for (let i = 0; i < defs.length; i++) {
      const key = defs[i][0], label = defs[i][1];
      const v = Number(defs[i][2]) || 0;
      const cap = defs[i][3];
      const weak = v < 0;
      const capped = v >= cap;
      html += '<div class="nxi-res nxi-res-' + key + (weak ? ' nxi-res-weak' : '') +
        (capped ? ' nxi-res-capped' : '') + '" title="' +
        esc(weak ? label + ' hurts them MORE than normal — ' + Math.abs(Math.round(v)) + '% extra damage taken'
          : capped ? label + ' resistance is at the engine’s ' + cap + '% ceiling'
            : label + ' resistance') + '">' +
        '<div class="nxi-res-head"><span class="nxi-res-name">' + label + '</span>' +
        '<span class="nxi-res-val">' + (v > 0 ? '+' : '') + Math.round(v) + '%</span></div>' +
        '<div class="nxi-res-track"><div class="nxi-res-fill" style="width:' +
        Math.round(pct(Math.abs(v), cap)) + '%"></div></div>' +
        (weak ? '<div class="nxi-res-tag">weak</div>'
          : capped ? '<div class="nxi-res-tag nxi-res-tag-cap">at the cap</div>' : '') +
        '</div>';
    }
    return html + '</div>';
  }

  function attackHtml(d) {
    const c = d.combat || {};
    const cells = [];
    cells.push(['Damage', fmt1(c.damage) + (c.unarmed ? '' : ''),
      c.unarmed ? 'Bare hands — this is their unarmed damage, which on a beast is the whole story.'
        : (c.estimated
          ? 'Their weapon, their skill, their fortify effects. An ESTIMATE: the engine’s own damage call only answers for the player, so this is the documented formula instead.'
          : '')]);
    if (c.weapon) cells.push(['Weapon', c.weapon, 'What is in their right hand.']);
    if (!c.unarmed) {
      cells.push(['Swing speed', fmt1(c.speed), 'Attacks per second, after whatever is fortifying it.']);
      cells.push(['Reach', fmt1(c.reach), 'How far the swing lands. 1.0 is a sword.']);
    }
    if (c.ranged && Number(c.arrow)) {
      cells.push(['Ammunition', (c.arrowName || 'Ammo') + ' · ' + fmt1(c.arrow),
        'The nocked round’s own damage, already folded into the figure above.']);
    }
    cells.push(['Move speed', Math.round(Number(c.move) || 0) + '%',
      '100% is a normal person. Below that you can outrun them.']);
    let html = '<div class="nxi-grid">';
    for (let i = 0; i < cells.length; i++) {
      html += '<div class="nxi-cell" title="' + esc(cells[i][2] || '') + '">' +
        '<div class="nxi-cell-l">' + esc(cells[i][0]) + '</div>' +
        '<div class="nxi-cell-v">' + esc(cells[i][1]) + '</div>' +
        (cells[i][2] ? '<div class="nxi-cell-n">' + esc(cells[i][2]) + '</div>' : '') +
        '</div>';
    }
    return html + '</div>';
  }

  /* The dispositions. Skyrim shows none of these anywhere, and they are what
     actually decides whether someone swings at you, runs, or joins in. Each
     row prints the engine's number AND the Creation Kit's own word for it. */
  function aiHtml(d) {
    const rows = Array.isArray(d.ai) ? d.ai : [];
    if (!rows.length) return '';
    let html = '<div class="nxi-ai">';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      /* ⚠ ALWAYS four cells. The row is a four-column grid, and an actor value
         with no Creation Kit word for it (Energy is a 0–100 scale, not an
         enum) used to drop its number cell — which slid the note into the
         44px column and printed it one word per line. A grid row that can
         lose a child is a layout bug waiting for the one payload that does. */
      const num = Math.round(Number(r.value) || 0);
      html += '<div class="nxi-ai-row nxi-ai-' + esc(r.key) + '" title="' + esc(r.note || '') + '">' +
        '<span class="nxi-ai-l">' + esc(r.label) + '</span>' +
        '<span class="nxi-ai-w">' + esc(r.word || String(num)) + '</span>' +
        '<span class="nxi-ai-v">' + (r.word ? num : '') + '</span>' +
        '<span class="nxi-ai-n">' + esc(r.note || '') + '</span>' +
        '</div>';
    }
    return html + '</div>';
  }

  function traitsHtml(d) {
    const t = Array.isArray(d.traits) ? d.traits : [];
    if (!t.length) return '';
    return '<div class="nxi-traits">' + t.map(function (x) {
      return '<span class="nxi-trait nxi-trait-' + esc(x.kind || 'type') + '">' + esc(x.text) + '</span>';
    }).join('') + '</div>';
  }

  function badgeHtml(b) {
    if (!b || !b.text) return '';
    return '<span class="nxi-badge" title="' + esc(b.av || 'Enchanted') + '">' +
      esc(b.text) + (b.av ? '<i>' + esc(b.av) + '</i>' : '') + '</span>';
  }

  /* Gear tiles v2 (Rober, 2026-08-17: "the equipped tab should be bigger like
     in those images … their version even has stat pills around the equipment").
     Each tile leads with a big ART PLATE — the item's real 3D render through
     the exact whIcons pipeline the Finder's item rows use — with the armour /
     damage value and the first enchant riding the plate's corners as PILLS,
     Skyrim Party Sheet style. The slot glyph stays underneath as the honest
     fallback while a render is queued (or on a rig without MRF), and every
     equip kind here — armour, weapons, ammo — HAS a world model, so no kind
     filter is needed. */
  function equipHtml(d) {
    const tiles = Array.isArray(d.equip) ? d.equip : [];
    if (!tiles.length) return '';
    let html = '<div class="nxi-gear">';
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const empty = !t.name;
      let num = '', numT = '', numK = '';
      if ((t.kind === 'weapon' || t.kind === 'ammo') && t.damage != null) {
        num = fmt1(t.damage); numT = 'Damage ' + num; numK = 'dmg';
      } else if (t.armor != null && Number(t.armor) > 0) {
        num = fmtN(t.armor); numT = 'Armour rating ' + num; numK = 'arm';
      }
      const badges = Array.isArray(t.badges) ? t.badges : [];
      const ench = (badges.length && badges[0] && badges[0].text) ? badges[0] : null;
      const art = empty ? '' : gearIconFor(t);
      html += '<div class="nxi-tile nxi-tile-' + esc(t.slot) + (empty ? ' nxi-tile-empty' : '') +
        (t.kind === 'weapon' ? ' nxi-tile-weapon' : '') + '" data-eq="' + i + '" title="' +
        esc(empty ? t.label + ' — nothing worn' : t.label + ': ' + t.name) + '">' +
        '<div class="nxi-tile-art">' +
        (art ? '<img class="nxi-tile-img" src="' + esc(art) + '" alt="">' : '') +
        '<div class="nxi-tile-glyph">' + (EQ_GLYPH[t.slot] || '◻') + '</div>' +
        (num ? '<b class="nxi-pill nxi-pill-' + numK + '" title="' + esc(numT) + '">' + esc(num) + '</b>' : '') +
        (ench ? '<b class="nxi-pill nxi-pill-ench" title="' + esc(ench.av || 'Enchanted') + '">' + esc(ench.text) + '</b>' : '') +
        '</div>' +
        '<div class="nxi-tile-body">' +
        '<div class="nxi-tile-l">' + esc(t.label) + '</div>' +
        '<div class="nxi-tile-n">' + (empty ? '<i>empty</i>' : esc(t.name)) + '</div>' +
        (badges.length > 1 ? '<div class="nxi-tile-badges">' + badges.map(badgeHtml).join('') + '</div>' : '') +
        '</div></div>';
    }
    return html + '</div>';
  }

  /* ---- gear art plumbing --------------------------------------------------
     Same three pieces as the Finder's item rows, scoped to the sheet's nine
     tiles: resolve through WardrobePane's ONE index, ask C++ once per item per
     session, and while drawn tiles still lack art nudge an EMPTY whIcons every
     couple of seconds (queues nothing, replies with the on-disk index; the
     wardrobe receiver raises 'hd-item-icons' only on change). Renders are
     render-once-keep-forever, so most sheets resolve instantly. */
  const gearReq = {};
  let gearPollT = null, gearPollN = 0;
  const GEAR_POLL_MS = 2500, GEAR_POLL_MAX = 24;

  function gearIconFor(t) {
    if (!t || !t.formId || !t.plugin) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      const path = WardrobePane.itemIconFor({ formId: t.formId, plugin: t.plugin }) || '';
      if (!path) return '';
      if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
      return path;
    } catch (e) { return ''; }
  }

  function gearMissing() {
    const d = insp.data;
    const tiles = d && Array.isArray(d.equip) ? d.equip : [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t && t.name && t.formId && t.plugin && !gearIconFor(t)) return true;
    }
    return false;
  }

  function gearStopPoll() {
    if (gearPollT) { clearInterval(gearPollT); gearPollT = null; }
  }

  /* Gear lightbox (Rober, 2026-08-17 wave 2.1: "6. sure"): click a rendered
     tile → the item large, with the Wardrobe turntable's -a090/-a180/-a270
     frames offered as a spin — the exact items-pane idiom. HDLightbox probes
     the frames itself; a piece nobody ever orbited just shows big. */
  function gearLightbox(t) {
    const url = gearIconFor(t);
    if (!url || !window.HDLightbox) return;
    const bits = [t.label];
    if (t.armor != null && Number(t.armor) > 0) bits.push(fmtN(t.armor) + ' armour');
    if ((t.kind === 'weapon' || t.kind === 'ammo') && t.damage != null) bits.push(fmt1(t.damage) + ' dmg');
    if (t.plugin) bits.push(t.plugin);
    HDLightbox.open({
      host: $('nx-pane'),
      src: url,
      glyph: EQ_GLYPH[t.slot] || '◻',
      title: t.name,
      sub: bits.join(' · '),
      frames: ['-a090', '-a180', '-a270'].map(function (s) {
        return url.replace(/\.png$/, s + '.png');
      }),
      spin: { kind: 'item', formId: t.formId, plugin: t.plugin },
    });
  }

  function gearAfterRender() {
    const host = document.getElementById('nxi-sheet');
    if (!host) return;
    /* A render that 404s must fall back to the glyph, never a broken box. */
    host.querySelectorAll('.nxi-tile-img').forEach(function (img) {
      if (img.dataset.wired) return;
      img.dataset.wired = '1';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
      });
    });
    /* Click-to-lightbox on every non-empty tile. The handler resolves art AT
       CLICK TIME, so a tile whose render lands after this wiring still opens;
       the affordance class rides gearUpgrade for the same reason. */
    if (insp.data) {
      const tiles0 = Array.isArray(insp.data.equip) ? insp.data.equip : [];
      host.querySelectorAll('.nxi-tile[data-eq]').forEach(function (el) {
        if (el.dataset.lb) return;
        el.dataset.lb = '1';
        const t0 = tiles0[Number(el.getAttribute('data-eq'))];
        if (!t0 || !t0.name) return;
        if (gearIconFor(t0)) el.classList.add('nxi-tile-click');
        el.addEventListener('click', function () {
          const tiles = insp.data && Array.isArray(insp.data.equip) ? insp.data.equip : [];
          const t = tiles[Number(el.getAttribute('data-eq'))];
          if (t && t.name) gearLightbox(t);
        });
      });
    }
    if (!insp.data) { gearStopPoll(); return; }
    const tiles = Array.isArray(insp.data.equip) ? insp.data.equip : [];
    const items = [], seen = {};
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t || !t.name || !t.formId || !t.plugin) continue;
      const key = t.formId + '|' + t.plugin;
      if (gearReq[key] || seen[key]) continue;
      if (gearIconFor(t)) continue;
      seen[key] = 1; gearReq[key] = 1;
      items.push({ formId: t.formId, plugin: t.plugin, name: t.name || '' });
    }
    if (items.length) toGame('whIcons', JSON.stringify({ items: items }));
    gearStopPoll();
    gearPollN = 0;
    if (gearMissing()) {
      gearPollT = setInterval(function () {
        if (!insp.open || !gearMissing() || ++gearPollN > GEAR_POLL_MAX) { gearStopPoll(); return; }
        toGame('whIcons', JSON.stringify({ items: [] }));
      }, GEAR_POLL_MS);
    }
  }

  /* Renders landing upgrade tiles IN PLACE — a full sheet re-render here would
     eat the filter caret and the scroll position for a picture. */
  function gearUpgrade() {
    if (!insp.open || !insp.data) return;
    const host = document.getElementById('nxi-sheet');
    if (!host) return;
    const tiles = Array.isArray(insp.data.equip) ? insp.data.equip : [];
    host.querySelectorAll('.nxi-tile[data-eq]').forEach(function (el) {
      const t = tiles[Number(el.getAttribute('data-eq'))];
      if (!t || !t.name) return;
      const box = el.querySelector('.nxi-tile-art');
      if (!box || box.querySelector('.nxi-tile-img')) return;
      const path = gearIconFor(t);
      if (!path) return;
      const img = document.createElement('img');
      img.className = 'nxi-tile-img';
      img.alt = '';
      img.dataset.wired = '1';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
      });
      img.src = path;
      box.insertBefore(img, box.firstChild);
      el.classList.add('nxi-tile-click');   // art landed — it opens large now
    });
    if (!gearMissing()) gearStopPoll();
  }
  document.addEventListener('hd-item-icons', gearUpgrade);

  function effectRows(d) {
    const all = Array.isArray(d.effects) ? d.effects : [];
    return all.filter(function (e) {
      if (!insp.hidden && e.hidden) return false;
      if (insp.pile !== 'all' && e.group !== insp.pile) return false;
      return matchesFilter((e.name || '') + ' ' + (e.source || '') + ' ' + (e.plugin || '') + ' ' + (e.av || ''));
    });
  }

  function effectsHtml(d) {
    const all = Array.isArray(d.effects) ? d.effects : [];
    const hiddenCount = all.filter(function (e) { return e.hidden; }).length;
    const counts = {};
    for (let i = 0; i < all.length; i++) {
      if (!insp.hidden && all[i].hidden) continue;
      counts[all[i].group] = (counts[all[i].group] || 0) + 1;
      counts.all = (counts.all || 0) + 1;
    }
    let html = '<div class="nxi-piles">';
    for (let i = 0; i < EFF_PILES.length; i++) {
      const k = EFF_PILES[i][0];
      const n = counts[k] || 0;
      if (k !== 'all' && !n) continue;      // never a pile that cannot have rows
      html += '<button class="nxi-pile' + (insp.pile === k ? ' nxi-pile-on' : '') +
        '" data-pile="' + k + '" title="Show only ' + esc(EFF_PILES[i][1].toLowerCase()) + '">' +
        (EFF_PILES[i][2] ? EFF_PILES[i][2] + ' ' : '') + esc(EFF_PILES[i][1]) +
        ' <b>' + n + '</b></button>';
    }
    if (hiddenCount) {
      html += '<button class="nxi-pile nxi-pile-ghost' + (insp.hidden ? ' nxi-pile-on' : '') +
        '" data-hidden="1" title="' + esc(hiddenCount + ' effect' + (hiddenCount === 1 ? '' : 's') +
          ' the game hides from its own magic menu — engine plumbing, mod controllers, framework glue') +
        '">◌ Hidden <b>' + hiddenCount + '</b></button>';
    }
    html += '</div>';

    const rows = effectRows(d);
    if (!rows.length) {
      html += '<div class="nxi-none">' +
        (all.length
          ? (insp.filter ? 'Nothing here matches “' + esc(insp.filter) + '”.'
            : 'Nothing in that pile right now.')
          : 'Nothing is running on them — no buffs, no poisons, no diseases.') +
        '</div>';
      return html;
    }
    html += '<div class="nxi-effs">';
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      const timed = Number(e.durSec) > 0;
      const left = timed ? pct(e.remainSec, e.durSec) : 100;
      html += '<div class="nxi-eff nxi-eff-' + esc(e.group || 'buff') + (e.hidden ? ' nxi-eff-ghost' : '') + '">' +
        '<div class="nxi-eff-main">' +
        '<span class="nxi-eff-n" title="' + esc(e.name) + '">' + highlight(e.name, insp.filter) + '</span>' +
        (e.av ? '<span class="nxi-eff-av">' + esc(e.av) + '</span>' : '') +
        (Number(e.magnitude) ? '<span class="nxi-eff-mag">' + fmt1(e.magnitude) + '</span>' : '') +
        '</div>' +
        '<div class="nxi-eff-sub">' +
        (e.source ? '<span class="nxi-eff-src" title="' + esc(e.source) + '">' + highlight(e.source, insp.filter) + '</span>' : '') +
        (e.sourceKind ? '<span class="nxi-eff-kind">' + esc(e.sourceKind) + '</span>' : '') +
        (e.plugin ? '<span class="nxi-eff-plug" title="' + esc(e.plugin) + '">' + esc(e.plugin) + '</span>' : '') +
        '</div>' +
        '<div class="nxi-eff-time">' +
        (timed
          ? '<span class="nxi-eff-left">' + fmtDur(e.remainSec) + '</span>' +
            '<span class="nxi-eff-of">of ' + fmtDur(e.durSec) + '</span>' +
            '<span class="nxi-eff-track"><span class="nxi-eff-fill" style="width:' +
            Math.round(left) + '%"></span></span>'
          : '<span class="nxi-eff-perm" title="No timer — it runs until something removes it">always on</span>') +
        '</div></div>';
    }
    return html + '</div>';
  }

  function socialHtml(d) {
    const s = d.social || {};
    const rank = s.rank || {};
    let html = '<div class="nxi-social">';
    html += '<div class="nxi-stand' + (rank.has ? '' : ' nxi-stand-none') + '" title="' +
      esc(rank.has
        ? 'Skyrim’s own relationship rank — vanilla dialogue, marriage and most follower frameworks branch on this number.'
        : 'No relationship record exists between you at all. That is not the same as rank 0: the game has simply never had an opinion.') + '">' +
      '<span class="nxi-stand-l">Toward you</span>' +
      '<span class="nxi-stand-v">' + esc(rank.has ? (rank.label || '—') : 'No record') + '</span>' +
      (rank.has ? '<span class="nxi-stand-n">' + (Number(rank.rank) > 0 ? '+' : '') + (rank.rank | 0) + '</span>' : '') +
      '</div>';
    const chips = [];
    if (s.hostile) chips.push('<span class="nxi-chip nxi-chip-bad" title="They will attack you on sight">⚔ Hostile</span>');
    if (s.teammate) chips.push('<span class="nxi-chip nxi-chip-good" title="They are following you right now">★ In your party</span>');
    if (s.maras && s.maras.on) {
      const m = s.maras;
      chips.push('<span class="nxi-chip nxi-chip-maras" title="' +
        esc('MARAS: ' + (m.statusText || '') + (m.mood ? ' · ' + m.mood : '') +
          (m.affection >= 0 ? ' · affection ' + m.affection : '')) + '">' +
        (m.spouse ? '💍 ' : '') + esc(m.statusText || 'Tracked') + '</span>');
    }
    if (chips.length) html += '<div class="nxi-chips">' + chips.join('') + '</div>';

    const facs = (Array.isArray(s.factions) ? s.factions : []).filter(function (f) {
      return f && f.n && matchesFilter(f.n);
    });
    if (facs.length) {
      html += '<div class="nxi-facs">' + facs.map(function (f) {
        const r = (f.rank != null && Number(f.rank) >= 0) ? 'rank ' + Number(f.rank) : '';
        return '<div class="nxi-fac" title="' + esc(f.n) + (r ? ' — ' + r : '') + '">' +
          '<span class="nxi-fac-n">' + highlight(f.n, insp.filter) + '</span>' +
          (r ? '<span class="nxi-fac-r">' + r + '</span>' : '') + '</div>';
      }).join('') + '</div>';
    } else if (insp.filter) {
      html += '<div class="nxi-none">No faction matches “' + esc(insp.filter) + '”.</div>';
    } else {
      html += '<div class="nxi-none">They belong to no named faction.</div>';
    }
    return html + '</div>';
  }

  function skillsHtml(d) {
    const all = (Array.isArray(d.skills) ? d.skills : []).filter(function (s) {
      return matchesFilter(s.name);
    });
    if (!all.length) {
      return '<div class="nxi-none">' +
        (insp.filter ? 'No skill matches “' + esc(insp.filter) + '”.' : 'No skills to read.') + '</div>';
    }
    const top = Math.max(100, all.reduce(function (m, s) { return Math.max(m, Number(s.level) || 0); }, 0));
    return '<div class="nxi-skills">' + all.map(function (s) {
      const v = Math.round(Number(s.level) || 0);
      return '<div class="nxi-skill" title="' + esc(s.name) + ' — ' + v + ', live (level scaling, ' +
        'fortifies and mod perks already in it)">' +
        '<span class="nxi-skill-n">' + highlight(s.name, insp.filter) + '</span>' +
        '<span class="nxi-skill-track"><span class="nxi-skill-fill" style="width:' +
        Math.round(pct(v, top)) + '%"></span></span>' +
        '<span class="nxi-skill-v">' + v + '</span></div>';
    }).join('') + '</div>';
  }

  /* CHIM section — renders whatever fetchChim landed, using the SAME
     facetCard the Home "Ask (CHIM)" overlay renders with (HDOmni.facetCard),
     so this can never drift into a second, competing presentation of the
     same data. 'profile' (which LLM is driving her dialogue) is skipped:
     its quick-changer button reads st.ask.reply internally in hd-omni.js, a
     coupling that only makes sense from the Ask overlay itself. */
  function chimHtml() {
    const c = insp.chim;
    if (!c) return '';
    if (c.loading) {
      return '<div class="nxi-chim-load"><span class="nxi-load-dot"></span>Asking CHIM…</div>';
    }
    if (c.err) {
      return '<div class="nxi-chim-err">' + esc(c.err) + '</div>';
    }
    const r = c.reply;
    if (!r) return '';
    const facets = r.facets || {};
    const focus = r.focus || [];
    const keys = Object.keys(facets).filter(function (k) { return k !== 'profile'; });
    if (!keys.length) {
      return '<div class="nxi-chim-empty">CHIM has nothing on ' + esc(c.npcName) +
        ' yet — talk to them once in-game to register them.</div>';
    }
    keys.sort(function (x, y) {
      return (focus.indexOf(x) !== -1 ? 0 : 1) - (focus.indexOf(y) !== -1 ? 0 : 1);
    });
    let html = r.answer ? '<div class="nxi-chim-answer">' + esc(r.answer) + '</div>' : '';
    for (let i = 0; i < keys.length; i++) {
      html += HDOmni.facetCard(keys[i], facets[keys[i]], focus.indexOf(keys[i]) !== -1);
    }
    return html;
  }

  function sectionHtml(id, title, body, sub) {
    if (!body) return '';
    return '<section class="nxi-sect nxi-sect-' + id + '">' +
      '<div class="nxi-sect-h"><span class="nxi-sect-t">' + esc(title) + '</span>' +
      (sub ? '<span class="nxi-sect-s">' + esc(sub) + '</span>' : '') + '</div>' +
      body + '</section>';
  }

  function headHtml() {
    const d = insp.data;
    const who = (d && d.who) || {};
    /* 'Reading…' is the LOADING placeholder. A refusal is a finished answer, so
       the crosshair route (which opens with no title) must stop claiming to be
       reading — the sheet said "Reading…" over a completed refusal. */
    const name = who.name || insp.title ||
      (insp.err ? (insp.why === 'nothing' ? 'No target' : 'Could not read them') : 'Reading…');
    const bits = [];
    if (who.level != null) bits.push('Level ' + fmtN(who.level));
    if (who.race) bits.push(who.race);
    if (who.cls) bits.push(who.cls);
    if (who.sex) bits.push(who.sex);
    const flags = [];
    if (who.dead) flags.push('<span class="nxi-flag nxi-flag-dead" title="They are dead">☠ Dead</span>');
    if (who.essential) flags.push('<span class="nxi-flag nxi-flag-ess" title="The game will not let them die">⛨ Essential</span>');
    else if (who['protected']) flags.push('<span class="nxi-flag nxi-flag-prot" title="Only you can land the killing blow">🛡 Protected</span>');
    if (who.unique) flags.push('<span class="nxi-flag nxi-flag-uniq" title="There is exactly one of them">★ Unique</span>');
    if (who.inCombat) flags.push('<span class="nxi-flag nxi-flag-fight" title="They are fighting right now">⚔ In combat</span>');
    if (who.summonable) flags.push('<span class="nxi-flag" title="A summon, not a resident of the world">✦ Summoned</span>');

    const art = insp.portrait
      ? '<img class="nxi-face-art" src="' + esc(insp.portrait) + '" alt="" draggable="false"' +
        ' onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;nxi-has-art&quot;);b.removeChild(this);}">'
      : '';
    /* The opening glyph is the CALLER's guess (a row lends its own ♀/♂); the
       crosshair route has none and defaults to ♀. Once C++ has answered, the
       payload's sex is the truth — otherwise Ulfric reads as ♀ Male. */
    const glyph = who.sex
      ? (String(who.sex).toLowerCase().charAt(0) === 'm' ? '♂' : '♀')
      /* A refusal identified nobody — ♀ there is a claim about someone who was
         never read, so the plate says "unknown" instead. */
      : (insp.err && !insp.title ? '?' : insp.glyph);
    return '<div class="nxi-head">' +
      '<div class="nxi-face' + (insp.portrait ? ' nxi-has-art' : '') + '">' + glyph + art + '</div>' +
      '<div class="nxi-head-mid">' +
      '<div class="nxi-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
      (bits.length ? '<div class="nxi-sub">' + esc(bits.join(' · ')) + '</div>' : '') +
      (flags.length ? '<div class="nxi-flags">' + flags.join('') + '</div>' : '') +
      (who.plugin ? '<div class="nxi-origin" title="The plugin this character is defined in">' +
        esc(who.plugin) + (who.formId ? ' · ' + esc(who.formId) : '') + '</div>' : '') +
      '</div>' +
      '<button class="nxi-x" id="nxi-close" title="Close (Esc)">✕</button>' +
      '</div>';
  }

  function bodyHtml() {
    if (insp.loading) {
      return '<div class="nxi-load"><span class="nxi-load-dot"></span>' +
        esc(insp.title ? 'Reading ' + insp.title + '…' : 'Reading whoever you were looking at…') +
        '</div>';
    }
    if (insp.err) {
      const hint = insp.why === 'unloaded'
        ? 'Use ⤝ Bring on their row, or ⤞ Go to, and inspect them there.'
        : insp.why === 'nothing'
          ? 'Or search for anyone below and inspect them from their row.'
          : '';
      return '<div class="nxi-refuse">' +
        '<div class="nxi-refuse-glyph">🔍</div>' +
        '<div class="nxi-refuse-msg">' + esc(insp.err) + '</div>' +
        (hint ? '<div class="nxi-refuse-hint">' + esc(hint) + '</div>' : '') +
        '</div>';
    }
    const d = insp.data;
    if (!d) return '';
    const effCount = (Array.isArray(d.effects) ? d.effects : []).filter(function (e) { return !e.hidden; }).length;
    const facCount = ((d.social || {}).factions || []).length;
    return traitsHtml(d) +
      sectionHtml('vitals', 'Vitals', vitalsHtml(d)) +
      sectionHtml('def', 'Defences', resistsHtml(d), 'what actually gets through') +
      sectionHtml('atk', 'Attack', attackHtml(d)) +
      sectionHtml('ai', 'Disposition', aiHtml(d), 'the numbers Skyrim never shows you') +
      sectionHtml('gear', 'Worn and held', equipHtml(d)) +
      sectionHtml('eff', 'Running on them', effectsHtml(d),
        effCount ? effCount + ' active' : 'nothing active') +
      sectionHtml('soc', 'Standing', socialHtml(d), facCount ? facCount + ' factions' : '') +
      sectionHtml('chim', 'CHIM', chimHtml(), 'what CHIM knows about them') +
      '<section class="nxi-sect nxi-sect-skill">' +
      '<div class="nxi-sect-h nxi-sect-toggle" id="nxi-skills-h" role="button" tabindex="0" ' +
      'aria-expanded="' + (insp.skillsOpen ? 'true' : 'false') + '" ' +
      'title="Their LIVE skill levels — level scaling, fortifies and mod perks already folded in">' +
      '<span class="nxi-sect-t">Skills</span>' +
      '<span class="nxi-sect-s">' + (insp.skillsOpen ? 'hide' : 'show all 18') + '</span></div>' +
      (insp.skillsOpen ? skillsHtml(d) : '') +
      '</section>';
  }

  function renderInspect() {
    const pane = $('nx-pane');
    if (!pane) return;
    let host = document.getElementById('nxi-sheet');
    if (!insp.open) {
      if (host) host.parentNode.removeChild(host);
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = 'nxi-sheet';
      host.className = 'nxi-sheet';
      /* Bound ONCE, on the host that survives every repaint — binding it per
         render would stack a listener per keystroke of the filter. */
      host.addEventListener('mousedown', function (e) {
        if (e.target === host) closeInspect();     // click the dim, not the card
      });
      pane.appendChild(host);
    }
    const showFilter = !!insp.data;
    host.innerHTML =
      '<div class="nxi-card" id="nxi-card" role="dialog" aria-label="Inspect" tabindex="-1">' +
      headHtml() +
      (showFilter
        ? '<div class="nxi-filter"><span class="nxi-filter-glyph">⌕</span>' +
          '<input id="nxi-filter-input" type="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="Filter effects, factions and skills — type anything" value="' +
          esc(insp.filter) + '">' +
          /* Always present, shown/hidden in place — see the input handler. */
          '<span class="nxi-filter-x' + (insp.filter ? '' : ' hidden') +
          '" id="nxi-filter-clear" title="Clear">✕</span>' +
          '</div>'
        : '') +
      '<div class="nxi-body" id="nxi-body">' + bodyHtml() + '</div>' +
      '</div>';

    /* ⛔ FIT THE PORTRAIT. `.nxi-face-art` is `object-fit: cover` in the sheet,
       which is a naive CENTRE crop of the source — it is not where the face is,
       and it silently threw away the framing the user had already set by hand
       (Rober, 2026-08-19: "full stats popout doesnt use cropped image
       correctly"). Every other surface routes through the ONE shared
       crop->CSS mapping; this one drew raw. Re-applied on EVERY render because
       the card rebuilds its innerHTML (typing in the filter re-creates this
       img); ensure() caches per url, so the repeats are free. */
    const faceImg = host.querySelector('.nxi-face-art');
    if (faceImg && insp.portrait && window.HDFaceFit) {
      if (insp.portraitKind === 'photo' && window.HDFaceFit.applyCrop) {
        /* A portrait photo: its framing is the one the user set. baseline '' so
           a crop-less photo keeps whatever bias the stylesheet gives it —
           applyCrop with a null crop clears the transform and nothing else. */
        window.HDFaceFit.applyCrop(faceImg, insp.crop, '');
      } else if (window.HDFaceFit.ensure) {
        /* A head render: measure it (or use a saved override — cssFor puts the
           human's framing ahead of the measurement). */
        window.HDFaceFit.ensure(faceImg, insp.portrait);
      }
    }

    const close = document.getElementById('nxi-close');
    if (close) close.addEventListener('click', closeInspect);

    /* Esc closes from anywhere inside the card. The filter input handles its
       own Esc first (clear, then close) and stops it there, so this never
       double-fires. While loading or refusing there is no input, so the card
       itself takes focus — Esc must work before there is anything to read. */
    const card = document.getElementById('nxi-card');
    if (card) {
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); closeInspect(); }
      });
      if (!insp.data) setTimeout(function () { try { card.focus(); } catch (err) {} }, 20);
    }

    const fi = document.getElementById('nxi-filter-input');
    if (fi) {
      fi.addEventListener('input', function () {
        insp.filter = fi.value.trim();
        /* Body only — rebuilding the whole card would drop the caret. */
        const b = document.getElementById('nxi-body');
        if (b) b.innerHTML = bodyHtml();
        wireBody();
        /* The ✕ toggles in place. Rebuilding the card to add it recreated this
           <input>, and the restored focus came back with the caret at 0 — so
           typing "frost" produced "rostf", and at speed the character typed
           inside the refocus window was lost outright. Same in-place idiom as
           syncPlugFilterActive(). */
        const x = document.getElementById('nxi-filter-clear');
        if (x) x.classList.toggle('hidden', !insp.filter);
      });
      fi.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (insp.filter) { insp.filter = ''; renderInspect(); document.getElementById('nxi-filter-input').focus(); }
          else closeInspect();
        } else if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();   // never leaks to the deck's global handler
        }
      });
      /* A rebuild only happens on open and on clear, where the end of the value
         is where the caret belongs — restore it explicitly so focus never
         re-enters the box at position 0. */
      if (!insp.loading) setTimeout(function () {
        try { fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); } catch (err) {}
      }, 20);
    }
    const fx = document.getElementById('nxi-filter-clear');
    if (fx) fx.addEventListener('click', function () {
      insp.filter = '';
      renderInspect();
      const i = document.getElementById('nxi-filter-input');
      if (i) i.focus();
    });
    wireBody();
  }

  /* Delegated wiring for everything the body redraws (piles, the skills fold).
     Re-run after every body-only repaint. */
  function wireBody() {
    const b = document.getElementById('nxi-body');
    if (!b) return;
    b.querySelectorAll('.nxi-pile').forEach(function (p) {
      p.addEventListener('click', function () {
        if (p.getAttribute('data-hidden')) insp.hidden = !insp.hidden;
        else insp.pile = p.getAttribute('data-pile') || 'all';
        b.innerHTML = bodyHtml();
        wireBody();
      });
    });
    const sh = document.getElementById('nxi-skills-h');
    if (sh) {
      const flip = function () {
        insp.skillsOpen = !insp.skillsOpen;
        b.innerHTML = bodyHtml();
        wireBody();
      };
      sh.addEventListener('click', flip);
      sh.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
      });
    }
    /* Gear art: wire error fallbacks, ask for missing renders, arm the poll.
       Runs on every body paint — deduped, so repeats are cheap. */
    gearAfterRender();
  }

  /* ============================================================ detail == */

  /* The rich per-NPC detail (Rober, 2026-08-15: "npc stats, factions, all sorts
     of info"). Lazy: C++ reads TESNPC on expand and replies through the shared
     nxResultData listener with a `detail` field. One row open at a time; cached
     so re-expand is instant. */

  function toggleDetail(id) {
    if (ui.expanded === id) { ui.expanded = ''; renderBodyPreservingScroll(); return; }
    ui.expanded = id;
    /* Only a SUCCESS is cached. A failure re-asks on the next expand: expanding
       is a deliberate act, the read is cheap, and the old negative cache made
       one transient miss break that NPC's Info for the rest of the session. */
    if (!ui.detail[id]) { delete ui.detailErr[id]; requestDetail(id); }
    renderBodyPreservingScroll();
  }

  function requestDetail(id) {
    toGame('nxQuery', JSON.stringify({ detail: id, seq: state.seq }));
  }

  function statHtml(label, value, cls) {
    return '<div class="nx-stat"><span class="nx-stat-l">' + esc(label) + '</span>' +
      '<span class="nx-stat-v' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</span></div>';
  }

  /* Faction rank -1 is the vanilla "no rank" sentinel — show it as a dash. */
  function factionRow(f) {
    if (!f || !f.n) return '';
    const rank = (f.rank != null && Number(f.rank) >= 0) ? ('rank ' + Number(f.rank)) : '';
    return '<div class="nx-fac"><span class="nx-fac-n" title="' + esc(f.n) + '">' + esc(f.n) + '</span>' +
      (rank ? '<span class="nx-fac-r">' + rank + '</span>' : '') + '</div>';
  }

  function skillChip(s) {
    if (!s || !s.n) return '';
    return '<span class="nx-skill" title="' + esc(s.n) + ' base ' + (s.v | 0) + '">' +
      esc(s.n) + ' <b>' + (s.v | 0) + '</b></span>';
  }

  function detailInnerHtml(id, info) {
    if (ui.detailErr[id] && !info)
      return '<div class="nx-detail-err">⚠ ' + esc(ui.detailErr[id]) + '</div>';
    if (!info)
      return '<div class="nx-detail-load"><span class="nx-detail-spin"></span> Reading…</div>';

    let html = '';

    /* identity + level line */
    let stats = '';
    if (info.lvl != null) stats += statHtml('Level', fmtN(info.lvl) + (info.pcMult ? ' (scales)' : ''));
    if (info.race) stats += statHtml('Race', info.race);
    if (info.cls) stats += statHtml('Class', info.cls);
    if (info.sex) stats += statHtml('Sex', info.sex);
    if (stats) html += '<div class="nx-stats">' + stats + '</div>';

    /* HMS attributes — the classic triple, colour-coded */
    let attrs = '';
    if (info.hp != null) attrs += statHtml('Health', fmtN(info.hp), 'nx-stat-hp');
    if (info.mp != null) attrs += statHtml('Magicka', fmtN(info.mp), 'nx-stat-mp');
    if (info.sp != null) attrs += statHtml('Stamina', fmtN(info.sp), 'nx-stat-sp');
    if (attrs) {
      html += '<div class="nx-stats nx-attrs">' + attrs + '</div>';
      if (info.autoCalc && !info.hp && !info.mp && !info.sp)
        html += '<div class="nx-detail-note">Auto-calculated — the engine derives HP/MP/SP at spawn from level and class, so the base record stores none.</div>';
    }

    /* flags row */
    const flags = [];
    if (info.uniq) flags.push('<span class="nx-flag nx-flag-uniq">★ Unique</span>');
    if (info.ess) flags.push('<span class="nx-flag nx-flag-ess">⛨ Essential</span>');
    else if (info.prot) flags.push('<span class="nx-flag nx-flag-prot">🛡 Protected</span>');
    if (info.summon) flags.push('<span class="nx-flag">Summonable</span>');
    if (flags.length) html += '<div class="nx-flags">' + flags.join('') + '</div>';

    /* top base skills */
    if (Array.isArray(info.skills) && info.skills.length) {
      html += '<div class="nx-detail-sect"><div class="nx-detail-h">Top skills</div>' +
        '<div class="nx-skills">' + info.skills.map(skillChip).join('') + '</div></div>';
    }

    /* combat style + voice */
    let cv = '';
    if (info.combat) cv += statHtml('Combat style', info.combat);
    if (info.voice) cv += statHtml('Voice', info.voice);
    if (cv) html += '<div class="nx-stats">' + cv + '</div>';

    /* factions */
    if (Array.isArray(info.factions) && info.factions.length) {
      html += '<div class="nx-detail-sect"><div class="nx-detail-h">Factions <b>' + info.factions.length + '</b></div>' +
        '<div class="nx-facs">' + info.factions.map(factionRow).join('') + '</div></div>';
    }

    if (!html) html = '<div class="nx-eff-none">No extra detail for this NPC.</div>';
    return html;
  }

  function patchDetailInPlace(id) {
    const box = document.querySelector('#nx-body .nx-detail[data-for="' + cssEsc(id) + '"]');
    if (!box) return;
    box.innerHTML = detailInnerHtml(id, ui.detail[id]);
  }

  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  /* "🔍 Inspect target" in the pane header — the crosshair route, and the one
     that needs NO search at all: look at someone, open the deck, press it.
     Built dynamically into .nx-head-right (the plug-filter idiom) so the
     shared index.html skeleton needs no edit. It never greys out: whether
     there IS anyone in the crosshair is a question only C++ can answer, and a
     button that refuses with a sentence beats one that is dead for a reason
     the player cannot see. */
  let inspectBtnEl = null;

  function inspectTargetBtn() {
    const right = document.querySelector('#nx-pane .nx-head-right');
    if (!right) return null;
    if (!inspectBtnEl || !inspectBtnEl.parentNode) {
      inspectBtnEl = document.createElement('button');
      inspectBtnEl.className = 'nxi-open';
      inspectBtnEl.id = 'nxi-open-target';
      inspectBtnEl.innerHTML = '🔍 Inspect target';
      inspectBtnEl.setAttribute('title',
        'Read whoever you were looking at when the deck opened — their real health, ' +
        'resistances, gear, what is running on them, and how they feel about you');
      inspectBtnEl.addEventListener('click', function () { openInspect('', {}); });
      right.insertBefore(inspectBtnEl, right.firstChild);
    }
    return inspectBtnEl;
  }

  function renderHeader() {
    inspectTargetBtn();
    const chip = $('nx-count-chip');
    if (chip) {
      chip.textContent = state.ready
        ? (fmtN(state.count) + ' people · ' + fmtN(state.plugins.length) + ' mods indexed')
        : 'reading the load order…';
    }
    const note = $('nx-mrf-note');
    if (note) note.classList.toggle('hidden', state.mrf);
  }

  function renderPills() {
    const box = $('nx-pills');
    if (!box) return;
    box.innerHTML = KINDS.map(function (k) {
      return '<button class="nx-pill' + (ui.type === k[0] ? ' nx-pill-on' : '') +
        '" data-type="' + k[0] + '" title="' +
        (k[0] === 'all' ? 'Search people and mods together'
          : k[0] === 'mods' ? 'Search plugin names only — esp, esm, esl'
            : k[0] === 'uniq' ? 'Only unique, named characters'
              : 'Only ' + esc(k[1].toLowerCase())) + '">' +
        (k[0] === 'all' || k[0] === 'mods' ? '' : k[2] + ' ') + esc(k[1]) + '</button>';
    }).join('');
    box.querySelectorAll('.nx-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.type = b.getAttribute('data-type');
        ui.sel = 0;
        runQuery(true);
        const s = $('nx-search');
        if (s) s.focus();
      });
    });
  }

  function renderPlugChip() {
    const chip = $('nx-plug-chip');
    if (!chip) return;
    if (!ui.plugin) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
    chip.classList.remove('hidden');
    chip.innerHTML = '📦 <b title="' + esc(ui.plugin) + '">' + esc(ui.plugin) + '</b>' +
      '<span class="nx-chip-x" title="Search everyone again">✕</span>';
    chip.querySelector('.nx-chip-x').addEventListener('click', clearPlugin);
  }

  /* ------------------------------------------------- secondary plugin filter --
     "⛃ Filter by mod" toggle + a revealed typeable input that fuzzy-narrows the
     current people by owning plugin. Built dynamically into .nx-barwrap after
     #nx-pills so no index.html edit is needed. Hidden while browsing INSIDE a
     mod (already scoped). The input keeps focus across repaints (rebuilt only on
     an open/close change), so typing is never interrupted. */
  let plugFilterEl = null;

  function plugFilterHost() {
    const wrap = document.querySelector('#nx-pane .nx-barwrap');
    if (!wrap) return null;
    if (!plugFilterEl) {
      plugFilterEl = document.createElement('div');
      plugFilterEl.className = 'nx-plugfilter';
      plugFilterEl.id = 'nx-plugfilter';
      const pills = $('nx-pills');
      if (pills && pills.nextSibling) wrap.insertBefore(plugFilterEl, pills.nextSibling);
      else wrap.appendChild(plugFilterEl);
    }
    return plugFilterEl;
  }

  function plugFilterVisible() {
    if (!state.ready) return false;
    if (ui.plugin) return false;                 // already inside one mod
    if (ui.type === 'mods') return false;        // mods-only view has no people rows
    return !!ui.q || ui.type !== 'all';          // a real search / pill is active
  }

  function renderPlugFilter() {
    const host = plugFilterHost();
    if (!host) return;
    if (!plugFilterVisible()) {
      host.classList.remove('nx-pf-on');
      host.innerHTML = '';
      return;
    }
    host.classList.add('nx-pf-on');

    const open = ui.plugFilterOpen || !!ui.plugFilter;
    const active = !!ui.plugFilter;
    const shape = open ? 'o' : 'c';   // rebuild only on open/close (keeps caret)
    if (host.getAttribute('data-shape') !== shape) {
      let html = '<button class="nx-pf-toggle' + (active ? ' nx-pf-toggle-on' : '') +
        '" id="nx-pf-toggle" title="Narrow these people to a mod — type part of an esp / esl / esm name">' +
        '⛃ Filter by mod</button>';
      if (open) {
        html += '<span class="nx-pf-box">' +
          '<span class="nx-pf-glyph">📦</span>' +
          '<input id="nx-pf-input" type="text" autocomplete="off" spellcheck="false" ' +
          'placeholder="plugin (esp / esl / esm)…" value="' + esc(ui.plugFilter) + '">' +
          '<span class="nx-pf-x' + (active ? '' : ' hidden') + '" id="nx-pf-clear" title="Clear the mod filter">✕</span>' +
          '</span>';
      }
      host.innerHTML = html;
      host.setAttribute('data-shape', shape);

      const toggle = $('nx-pf-toggle');
      if (toggle) toggle.addEventListener('click', function () {
        ui.plugFilterOpen = !ui.plugFilterOpen;
        if (!ui.plugFilterOpen) ui.plugFilter = '';
        ui.sel = 0;
        render();
        if (ui.plugFilterOpen) { const i = $('nx-pf-input'); if (i) i.focus(); }
      });
      const clear = $('nx-pf-clear');
      if (clear) clear.addEventListener('click', function () {
        ui.plugFilter = ''; ui.sel = 0;
        render();
        const i = $('nx-pf-input'); if (i) i.focus();
      });
      const input = $('nx-pf-input');
      if (input) {
        input.addEventListener('input', function () {
          ui.plugFilter = input.value.trim();
          ui.sel = 0;
          renderBody(); renderFooter();     // never a full render (would drop focus)
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
            else { ui.plugFilterOpen = false; render(); const s = $('nx-search'); if (s) s.focus(); }
          }
        });
      }
    } else {
      const input = $('nx-pf-input');
      if (input && input.value !== ui.plugFilter && document.activeElement !== input) input.value = ui.plugFilter;
    }
  }

  /* Flip the toggle tint + clear ✕ in place (no rebuild) so the caret survives. */
  function syncPlugFilterActive() {
    const active = !!ui.plugFilter;
    const toggle = $('nx-pf-toggle');
    if (toggle) toggle.classList.toggle('nx-pf-toggle-on', active);
    const x = $('nx-pf-clear');
    if (x) x.classList.toggle('hidden', !active);
  }

  function plugRowHtml(p, selIdx, idx) {
    const kindCls = p.k === 'esm' ? 'nx-kind-esm' : (p.k === 'esl' || p.l) ? 'nx-kind-esl' : 'nx-kind-esp';
    const kindLbl = String(p.k || 'esp').toUpperCase() + (p.l && p.k === 'esp' ? ' · light' : '');
    return '<div class="nx-plug-row' + (selIdx === idx ? ' nx-sel' : '') + '" data-plug="' + esc(p.n) +
      '" title="Browse everyone ' + esc(p.n) + ' ships">' +
      '<span class="nx-kindbadge ' + kindCls + '">' + esc(kindLbl) + '</span>' +
      '<span class="nx-plug-name">' + highlight(p.n, ui.q) + '</span>' +
      '<span class="nx-plug-count">' + fmtN(p.c) + ' people</span>' +
      '<span class="nx-plug-go">Browse →</span></div>';
  }

  /* Tail of a capped mod roster — a real row so Enter reaches it too. It must
     NOT carry .nx-plug-row: that class is the browse-a-plugin click target and
     counts as a mod in every measurement. */
  function moreModsRowHtml(left, selIdx, idx) {
    const next = Math.min(left, MODS_PAGE);
    return '<button class="nx-plug-more' + (selIdx === idx ? ' nx-sel' : '') +
      '" title="Draw the next ' + fmtN(next) + ' mods">' +
      '<span class="nx-plug-more-t">Show ' + fmtN(next) + ' more</span>' +
      '<span class="nx-plug-count">' + fmtN(left) + ' not shown</span>' +
      '<span class="nx-plug-go">▼</span></button>';
  }

  /* Fertility Mode by base record, through the Followers pane's whole-map
     read; null/undefined when it is not loaded, so a partial deploy shows no
     chip rather than a wrong one. */
  function fertOf(it) {
    const F = window.FolPane;
    if (!F || typeof F.fertFor !== 'function' || !it || !it.id) return null;
    try { return F.fertFor({ base: it.id }); } catch (e) { return null; }
  }
  function fertTitleOf(f) {
    const F = window.FolPane;
    if (F && typeof F.fertTitle === 'function') { try { return F.fertTitle(f); } catch (e) {} }
    return 'Fertility Mode: pregnant';
  }
  /* The two whole-map reads a drawn page needs. Throttled at the source, so a
     page flip costs at most one ask per few seconds each. */
  function askStatusMaps() {
    try { if (window.FolPane && typeof FolPane.ensureFertAll === 'function') FolPane.ensureFertAll(); } catch (e) {}
    try { if (window.ChimBtn && typeof ChimBtn.ensureAgents === 'function') ChimBtn.ensureAgents(); } catch (e) {}
  }
  /* …and when either answer lands, the drawn rows put their chips on. */
  function onStatusMaps() { if (ui.visible && state.ready) { try { renderBodyPreservingScroll(); } catch (e) {} } }
  window.addEventListener('hd-fert-all', onStatusMaps);
  window.addEventListener('hd-chim-agents', onStatusMaps);

  function npcRowHtml(it, selIdx, idx) {
    const art = artFor(it);
    const hasArt = !!art;
    const loading = !hasArt && rowLoading(it);   // face expected, not landed yet
    const plateCls = 'nx-plate' + (it.u ? ' nx-t-uniq' : it.s === 'f' ? ' nx-t-fem' : ' nx-t-male') +
      (hasArt ? ' nx-has-art nx-zoomable' : '') + (art && art.body ? ' nx-has-body' : '') +
      (loading ? ' nx-loading' : '');
    let chips = '';
    if (it.u) chips += '<span class="nx-chip nx-chip-uniq" title="Unique — there is exactly one of them">★ Unique</span>';
    if (it.e) chips += '<span class="nx-chip nx-chip-ess" title="Essential — cannot be killed">⛨</span>';
    /* Only call it "no portrait" when there really is none — a creature that
       got a body render is pictured, just not by a face. */
    if (it.t && !faceParts(it.fc) && !hasArt)
      chips += '<span class="nx-chip nx-chip-tmpl" title="Built from a template — no baked face exists, so no portrait">🜲 template</span>';
    /* ◍ expecting / 💬 CHIM (Rober, 2026-09-14: "pregnancy status as well?
       … yea search rows"). Both read the whole-map answers the Followers pane
       and chim-flyout keep (fmAllResult / chAgentsResult), matched by this
       row's BASE record — so only UNIQUE people get them: a base shared by
       twenty bandits cannot say which one is carrying. */
    if (it.u) {
      const f = fertOf(it);
      if (f && f.pregnant) {
        const pct = (typeof f.percent === 'number' && f.termDays) ? f.percent + '%' : 'expecting';
        chips += '<span class="nx-chip nx-chip-preg" title="' + esc(fertTitleOf(f)) + '">◍ ' + esc(pct) + '</span>';
      }
      if (window.ChimBtn && typeof ChimBtn.isAgent === 'function'
          && ChimBtn.isAgent({ name: it.n, base: it.n }) === true) {
        chips += '<span class="nx-chip nx-chip-chim" title="' +
          esc('CHIM AI is ON — ' + it.n + ' is a live CHIM agent. The 💬 on her F7 card turns it off.') +
          '">💬 CHIM</span>';
      }
    }
    const open = ui.expanded === it.id;
    return '<div class="nx-row' + (selIdx === idx ? ' nx-sel' : '') + (open ? ' nx-row-open' : '') +
      '" data-id="' + esc(it.id) + '">' +
      '<div class="' + plateCls + '" title="' + esc(hasArt ? it.n + ' — click for a bigger look' : it.n) + '">' +
      plateInner(it) + '</div>' +
      '<div class="nx-mid">' +
      '<div class="nx-name" title="' + esc(it.n) + '"><span class="nx-name-txt">' + highlight(it.n, ui.q) + '</span>' + chips + '</div>' +
      '<div class="nx-meta">' +
      '<span class="nx-meta-race">' + esc(it.r || (it.s === 'f' ? 'Woman' : 'Man')) + '</span>' +
      '<span class="nx-meta-plug" data-plug="' + esc(it.p) + '" title="Browse everyone ' + esc(it.p) + ' ships">' + esc(it.p) + '</span>' +
      '</div></div>' +
      '<div class="nx-act">' +
      '<button class="nx-btn nx-info' + (open ? ' nx-info-on' : '') + '" data-info="' + esc(it.id) +
      '" title="The RECORD — level, race, class, base stats and factions as the mod author wrote them" ' +
      'aria-expanded="' + (open ? 'true' : 'false') + '">ⓘ Info</button>' +
      '<button class="nx-btn nx-inspect" data-inspect="' + esc(it.id) +
      '" title="The LIVE person — real health, resistances, gear, active effects and how they feel ' +
      'about you. Only works while they are loaded in the world.">🔍 Inspect</button>' +
      '<button class="nx-btn nx-do nx-primary" data-act="bring" title="Teleport them to you (Enter does this too)">⤝ Bring</button>' +
      '<button class="nx-btn nx-do" data-act="goto" title="Teleport yourself to wherever they are">⤞ Go to</button>' +
      '<button class="nx-btn nx-do nx-spawn" data-act="spawn" title="Place a COPY of them at your feet — the original, if any, is untouched">＋ Spawn</button>' +
      '</div></div>' +
      (open ? '<div class="nx-detail" data-for="' + esc(it.id) + '">' +
        detailInnerHtml(it.id, ui.detail[it.id]) + '</div>' : '');
  }

  function renderBody() {
    const body = $('nx-body');
    const empty = $('nx-empty');
    if (!body || !empty) return;

    if (!state.ready) {
      body.innerHTML = new Array(7).fill(
        '<div class="nx-row nx-skel"><div class="nx-plate nx-skel-box"></div>' +
        '<div class="nx-mid"><span class="nx-skel-box nx-skel-w1"></span>' +
        '<span class="nx-skel-box nx-skel-w2"></span></div>' +
        '<span class="nx-skel-box nx-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = flatRows();

    /* hero — nothing asked yet */
    if (!rows.length && !ui.q && !ui.plugin && ui.type === 'all') {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="nx-hero-glyph">👤</div>' +
        '<div class="nx-empty-title">Everyone the load order ships</div>' +
        '<div class="nx-empty-sub"><b>' + fmtN(state.count) + ' people</b> across <b>' +
        fmtN(state.plugins.length) + ' mods</b>, one bar. Type a name, a race, or a mod to browse its whole roster — ' +
        'then bring them to you, go to them, or spawn a copy.' +
        (state.mrf ? '' : ' <b>Portraits are off</b> — Mesh Rendering Framework is not installed, so rows keep their glyphs.') +
        '</div>' +
        '<div class="nx-try">' +
        ['Lydia', 'Nazeem', 'bandit', 'Skyrim.esm'].map(function (t) {
          return '<button class="nx-pill" data-try="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-try]').forEach(function (b) {
        b.addEventListener('click', function () {
          const s = $('nx-search');
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
        empty.innerHTML = '<div class="nx-empty-title">Searching…</div>';
      } else if (ui.plugFilter && state.items.length > 0) {
        /* the search DID return people; the secondary mod filter hid them all on
           this page — say so and offer the escape hatch */
        empty.innerHTML = '<div class="nx-empty-title">Nobody on this page is from “' + esc(ui.plugFilter) + '”</div>' +
          '<div class="nx-empty-sub">The mod filter matched nothing on this page. Try a different mod name, ' +
          'page through the results, or clear the filter.</div>' +
          '<div class="nx-try"><button class="nx-pill" id="nx-pf-empty-clear">Clear mod filter</button></div>';
        const c = $('nx-pf-empty-clear');
        if (c) c.addEventListener('click', function () {
          ui.plugFilter = ''; ui.sel = 0; render();
          const i = $('nx-pf-input'); if (i) i.focus();
        });
        return;
      } else if (ui.type === 'mods') {
        empty.innerHTML = '<div class="nx-empty-title">No mod matches</div>' +
          '<div class="nx-empty-sub">No plugin name contains “' + esc(ui.q) + '”. Try fewer letters.</div>';
      } else {
        empty.innerHTML = '<div class="nx-empty-title">Nobody matches</div>' +
          '<div class="nx-empty-sub">No one called “' + esc(ui.q) + '”' +
          (ui.plugin ? ' in ' + esc(ui.plugin) : '') +
          (ui.type !== 'all' ? ' under that pill' : '') +
          '. Try fewer letters, another pill, or a race name.</div>';
      }
      return;
    }
    empty.classList.add('hidden');

    let html = '';
    let idx = 0;
    let inMods = false, inNpcs = false;
    /* first-open hint: a fresh search fired face renders — say they're coming,
       once, so the ♀/♂ placeholders don't read as final portraits */
    const showHint = firstOpenHint() && rows.some(function (r) { return r.kind === 'npc'; });
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        /* The count is the MATCH count, never the draw cap — say "N of M" when
           they differ so the header can't contradict the indexed-mods chip. */
        const modTotal = modMatches(0).length;
        const modDrawn = rows.filter(function (x) { return x.kind === 'plug'; }).length;
        html += '<div class="nx-sect">Mods <b>' + fmtN(modTotal) + '</b>' +
          (modDrawn < modTotal ? '<b>· showing ' + fmtN(modDrawn) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'npc' && !inNpcs) {
        inNpcs = true;
        /* With the secondary plugin filter on, "People N" is the whole (server)
           result count but only some of THIS page's rows match — say both. */
        const shownNpcs = rows.filter(function (x) { return x.kind === 'npc'; }).length;
        const pageNpcs = state.items.length;
        html += '<div class="nx-sect">People <b>' + fmtN(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') +
          (ui.plugFilter ? '<b class="nx-sect-filt">· ⛃ ' + fmtN(shownNpcs) + ' of ' +
            fmtN(pageNpcs) + ' on this page match “' + esc(ui.plugFilter) + '”</b>' : '') +
          '</div>';
        if (showHint)
          html += '<div class="nx-firsthint">✨ First time seeing these — rendering their faces in the ' +
            'background. Rows fill in as it lands.</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'more') html += moreModsRowHtml(r.left, ui.sel, idx);
      else if (r.kind === 'npc') html += npcRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    body.querySelectorAll('.nx-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
    const moreBtn = body.querySelector('.nx-plug-more');
    if (moreBtn) moreBtn.addEventListener('click', showMoreMods);
    body.querySelectorAll('.nx-row:not(.nx-skel)').forEach(function (row) {
      const id = row.getAttribute('data-id');
      function npc() {
        for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
      }
      row.querySelectorAll('.nx-do').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          const it = npc();
          if (it) act(b.getAttribute('data-act'), it);
        });
      });
      const infoBtn = row.querySelector('.nx-info');
      if (infoBtn) infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDetail(infoBtn.getAttribute('data-info'));
      });
      /* Inspect from a row: hand the sheet the face render and the name it
         already has, so the card has a portrait and a title the instant it
         opens rather than after the round trip. */
      const inspBtn = row.querySelector('.nx-inspect');
      if (inspBtn) inspBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const it = npc();
        if (!it) return;
        const art = artFor(it);
        openInspect(it.id, {
          portrait: art && !art.body ? art.url : '',
          glyph: it.s === 'f' ? '♀' : '♂',
          name: it.n,
        });
      });
      const zoom = row.querySelector('.nx-plate.nx-zoomable');
      if (zoom) zoom.addEventListener('click', function (e) {
        e.stopPropagation();
        const it = npc();
        if (it) openLightbox(it);
      });
      const plug = row.querySelector('.nx-meta-plug');
      if (plug) plug.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlugin(plug.getAttribute('data-plug'));
      });
      row.addEventListener('dblclick', function () {
        const it = npc();
        if (it) act('bring', it);
      });
    });

    chipLastLand = chipLastLand || Date.now();   // first paint arms the window
    updateRenderChip();

    /* Face-fit every rendered FACE: zoom the tile onto the face and let the
       hair bleed off the plate (hd-facefit.js measures each file once; the
       plate's overflow:hidden does the clipping). Creature BODY renders
       (nx-art-body) are excluded — there is no skull to hone in on, so they
       show whole (contain-fit via CSS). The lightbox deliberately keeps the
       whole render — this is a tile treatment, not a re-crop of the art.
       Absent module (standalone harness) = untouched tiles. */
    if (window.HDFaceFit)
      body.querySelectorAll('.nx-plate .nx-art:not(.nx-art-body)').forEach(function (img) {
        window.HDFaceFit.ensure(img, img.getAttribute('src'));
      });

    scheduleIconWork();
  }

  function renderBodyPreservingScroll() {
    const body = $('nx-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('nx-body');
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
     segmented control. Created dynamically and appended to #nx-pane (like the
     render chip) so no index.html edit is needed. Hidden whenever there is no
     paged list to show: index not ready, hero, empty results, or the Mods-only
     view (mods are matched locally, not paged). A SINGLE short page keeps the
     count + selector but hides Prev/Next. */
  let footEl = null;

  function footHost() {
    const pane = $('nx-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'nx-foot';
      footEl.id = 'nx-foot';
      /* after #nx-body, before the toast, so it sits at the pane's foot and
         never overlaps the scroll area or the toast/lightbox (both higher z). */
      const body = $('nx-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  /* Should the footer show at all? Only for an actual paged NPC list. */
  function footVisible() {
    if (!state.ready) return false;
    if (ui.type === 'mods') return false;         // mods are local, not paged
    if (!ui.q && !ui.plugin && ui.type === 'all') return false;  // hero
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('nx-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;          // keep the index sane after a shrink
    const first = total ? ui.page * ui.pageSize + 1 : 0;
    const last = Math.min(total, (ui.page + 1) * ui.pageSize);
    const multi = pc > 1;

    let html = '';
    /* Prev/Next only when there is more than one page; the count + selector stay
       for a single short page so the control is never a lonely orphan. */
    if (multi) {
      html += '<button class="nx-foot-nav nx-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="nx-foot-count">Showing <b>' + fmtN(first) + '–' + fmtN(last) +
      '</b> of <b>' + fmtN(total) + '</b>' + (multi ? ' · page ' + (ui.page + 1) + ' of ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="nx-foot-nav nx-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="nx-foot-per" title="How many to show per page — fewer means fewer face renders at once">' +
      '<span class="nx-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="nx-foot-size' + (n === ui.pageSize ? ' nx-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('nx-foot-on');

    const prev = foot.querySelector('.nx-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.nx-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.nx-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('nx-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('nx-toast-err', !!err);
    t.classList.add('nx-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('nx-toast-show'); }, 2600);
  }

  /* ======================================================= spawn guard == */
  /* Rober, 2026-08-18: "＋ Spawn a copy" on Argos gave him "a weird headless
     ghost". A sculpted NPC's face is BAKED into a facegen file keyed to the
     original record; a placed copy is a fresh actor that assembles its head at
     runtime and has nothing to read that sculpt from. C++ knows this before it
     places anything (NpcFinder::CopyLookOf) and refuses with warn:"faceless".

     This is the pane's half: state the reason in plain words and put the verb
     that DOES work — Bring / Go to — under the user's finger, with "Spawn
     anyway" still available because it is his game. Deliberately a card and not
     a toast: a refusal the user can't act on is just a flicker.

     It never appears for a generic actor. C++ only warns on a ★ Unique NPC
     whose baked face is really on disk, so bandits, guards and creatures reach
     the engine on the first press exactly as before. */

  const guard = { open: false, d: null };

  function guardEl() { return $('nx-guard'); }

  function closeSpawnGuard(refocus) {
    const g = guardEl();
    if (g && g.parentNode) g.parentNode.removeChild(g);
    guard.open = false;
    guard.d = null;
    if (refocus !== false) {
      const s = $('nx-search');
      if (s && s.focus) s.focus();
    }
  }

  function openSpawnGuard(d) {
    const pane = $('nx-pane');
    if (!pane) { toast(d.msg || 'A copy would come out faceless', true); return; }
    closeSpawnGuard(false);
    /* act() toasted "Placing X…" optimistically on the press. Nothing is being
       placed, so kill it the moment the card says otherwise — two statements
       that contradict each other read as a bug. */
    const tst = $('nx-toast');
    if (tst) tst.classList.remove('nx-toast-show');
    if (ui.toastT) { clearTimeout(ui.toastT); ui.toastT = null; }
    guard.open = true;
    guard.d = d;
    const name = String(d.name || 'They');
    /* Button labels name the person — but a 38-character mod name (think
       "Herika the Wandering Scholar of Winterhold") turns four verbs into
       four ragged rows.
       Clip the label, keep the whole name in the title and in the prose above,
       so nothing is hidden and the row still reads as a row. */
    const shortName = name.length > 22 ? name.slice(0, 20).trim() + '…' : name;
    const canBring = d.canBring !== false;
    const g = document.createElement('div');
    g.id = 'nx-guard';
    g.className = 'nx-guard';
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-modal', 'true');
    g.setAttribute('aria-labelledby', 'nx-guard-t');
    g.innerHTML =
      '<div class="nx-guard-card">' +
        '<div class="nx-guard-head">' +
          '<span class="nx-guard-glyph" aria-hidden="true">◍</span>' +
          '<span class="nx-guard-t" id="nx-guard-t">A copy of ' + esc(name) + ' comes out faceless</span>' +
        '</div>' +
        '<p class="nx-guard-msg">' + esc(d.msg || '') + '</p>' +
        '<p class="nx-guard-why">Their look is baked into a face file that belongs to the original ' +
          'record. A copy is built fresh, so there is nothing for it to read that face from — ' +
          'you get a blank, headless shape wearing their gear.</p>' +
        (canBring ? '' :
          '<p class="nx-guard-note">' + esc(name) + ' is not loaded in the world right now, so ' +
          'Bring and Go to cannot reach them. Travel to where they live first, or spawn the ' +
          'copy anyway knowing what it will look like.</p>') +
        '<div class="nx-guard-acts">' +
          '<button class="nx-gbtn nx-gbtn-primary" data-g="bring"' +
            (canBring ? '' : ' disabled') +
            ' title="' + (canBring
              ? 'Teleport the real ' + esc(name) + ' to you — the face comes with them'
              : esc(name) + ' is not loaded in the world right now') +
            '">⤝ Bring ' + esc(shortName) + ' here</button>' +
          '<button class="nx-gbtn" data-g="goto"' + (canBring ? '' : ' disabled') +
            ' title="' + (canBring
              ? 'Teleport yourself to wherever ' + esc(name) + ' is'
              : esc(name) + ' is not loaded in the world right now') +
            '">⤞ Go to ' + esc(shortName) + '</button>' +
          '<button class="nx-gbtn nx-gbtn-warn" data-g="force"' +
            ' title="Place the copy anyway — it will have no face">＋ Spawn anyway</button>' +
          '<button class="nx-gbtn nx-gbtn-ghost" data-g="cancel" title="Leave it (Esc)">Cancel</button>' +
        '</div>' +
      '</div>';
    pane.appendChild(g);

    const it = { id: d.id, n: name };
    g.querySelectorAll('[data-g]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (b.disabled) return;
        const what = b.getAttribute('data-g');
        closeSpawnGuard();
        if (what === 'bring') act('bring', it);
        else if (what === 'goto') act('goto', it);
        else if (what === 'force') act('spawn', it, { force: true });
      });
    });
    /* Click the dimmed surround (never the card) to dismiss — the deck's
       click-away idiom, and the same thing Cancel does. */
    g.addEventListener('click', function (e) {
      if (e.target === g) { e.stopPropagation(); closeSpawnGuard(); }
    });
    /* Esc closes the card and nothing else: without stopPropagation it would
       also clear the search box on its way to the palette. */
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpawnGuard(); }
    });
    /* Focus a SAFE button, never "Spawn anyway": the card exists to stop a
       reflex press, and putting the destructive verb under a waiting Enter
       would hand the ghost over anyway. Bring when it can work, Cancel when
       it can't. */
    const first = g.querySelector('[data-g="bring"]:not([disabled])') ||
                  g.querySelector('[data-g="cancel"]');
    if (first && first.focus) setTimeout(function () { first.focus(); }, 20);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('nxState');   // first call builds the C++ index; later calls are cheap
    askStatusMaps();     // ◍ / 💬 chips for the rows about to be drawn
    const s = $('nx-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready && (ui.q || ui.plugin || ui.type !== 'all')) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
    closeSpawnGuard(false);   // a decision card must never survive the tab it belongs to
    closeInspect();
    if (window.HDLightbox) HDLightbox.close();
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (renderChip) renderChip.classList.remove('nx-on');
    stopIconPoll();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the bar pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.plugin = '';
    ui.type = 'all';
    const s = $('nx-search');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  function init() {
    const s = $('nx-search');
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
             hotkey and close the palette). With no results, activate() no-ops
             — Enter on an empty roster does nothing, it does not close. */
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
            const el = document.querySelector('#nx-body .nx-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'PageDown' || e.key === 'PageUp') {
          /* Page nav — Arrows are already row-nav (above), so paging rides
             PgDn/PgUp. Only when a paged list is on screen; otherwise the key
             does nothing here and falls through. */
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
    /* Finder mode switch — the other half of the merged tab. The typed query
       rides along, so "lydia" over people becomes "lydia" over items. app.js
       owns the actual tab flip (__hdFinderGo); a harness without it no-ops. */
    document.querySelectorAll('#nx-pane .fx-sw').forEach(function (b) {
      b.addEventListener('click', function () {
        const go = b.getAttribute('data-go');
        if (go !== 'npcs' && typeof window.__hdFinderGo === 'function') window.__hdFinderGo(go, ui.q);
      });
    });

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_NPCS = [
    { id: 'Skyrim.esm|00A2C8', n: 'Lydia', p: 'Skyrim.esm', r: 'Nord', s: 'f', u: true, e: false, t: false, fc: 'Skyrim.esm|000A2C8E' },
    { id: 'Skyrim.esm|013480', n: 'Nazeem', p: 'Skyrim.esm', r: 'Redguard', s: 'm', u: true, e: false, t: false, fc: 'Skyrim.esm|00013480' },
    { id: 'Skyrim.esm|039CD1', n: 'Bandit Marauder', p: 'Skyrim.esm', r: 'Nord', s: 'm', u: false, e: false, t: true, fc: '' },
    { id: 'CoolFollowers.esl|000801', n: 'Sylvara', p: 'CoolFollowers.esl', r: 'Dunmer', s: 'f', u: true, e: true, t: false, fc: 'CoolFollowers.esl|00000801' },
  ];

  function devState() {
    window.nxStateResult({
      phase: 'ready', count: 28714, mrf: true,
      plugins: [
        { n: 'Skyrim.esm', c: 5211, k: 'esm', l: false },
        { n: 'Interesting NPCs.esp', c: 412, k: 'esp', l: false },
        { n: 'CoolFollowers.esl', c: 3, k: 'esl', l: true },
      ],
    });
  }

  const DEV_DETAIL = {
    'Skyrim.esm|00A2C8': { lvl: 6, pcMult: true, race: 'Nord', cls: 'Warrior1H', sex: 'Female',
      ess: true, prot: false, uniq: true, summon: false, hp: 150, mp: 50, sp: 120, autoCalc: false,
      skills: [{ n: 'One-Handed', v: 30 }, { n: 'Block', v: 25 }, { n: 'Heavy Armor', v: 22 }],
      combat: 'csHousecarl', voice: 'FemaleEvenToned',
      factions: [{ n: 'PotentialFollowerFaction', rank: 0 }, { n: 'WhiterunHousecarlFaction', rank: -1 }] },
    'Skyrim.esm|013480': { lvl: 1, pcMult: false, race: 'Redguard', cls: 'Citizen', sex: 'Male',
      ess: false, prot: false, uniq: true, hp: 50, mp: 50, sp: 50, autoCalc: false,
      skills: [{ n: 'Speech', v: 20 }], factions: [{ n: 'WhiterunFarmerFaction', rank: -1 }] },
    'CoolFollowers.esl|000801': { lvl: 10, race: 'Dunmer', cls: 'Sorcerer', sex: 'Female',
      ess: true, uniq: true, hp: 0, mp: 0, sp: 0, autoCalc: true,
      skills: [{ n: 'Destruction', v: 40 }, { n: 'Conjuration', v: 35 }], factions: [] },
  };

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.detail) {
      const info = DEV_DETAIL[req.detail];
      window.nxResultData(info
        ? { seq: req.seq | 0, detail: req.detail, info: info }
        : { seq: req.seq | 0, detail: req.detail, info: {}, err: 'No dev detail fixture' });
      return;
    }
    const q = String(req.q || '').toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    const rows = DEV_NPCS.filter(function (it) {
      if (req.plugin && it.p !== req.plugin) return false;
      if (req.type === 'uniq' && !it.u) return false;
      if (req.type === 'fem' && it.s !== 'f') return false;
      if (req.type === 'male' && it.s !== 'm') return false;
      for (let i = 0; i < toks.length; i++) {
        if (it.n.toLowerCase().indexOf(toks[i]) === -1 &&
            it.r.toLowerCase().indexOf(toks[i]) === -1 &&
            it.p.toLowerCase().indexOf(toks[i]) === -1) return false;
      }
      return true;
    });
    window.nxResultData({ seq: req.seq | 0, total: rows.length, offset: req.offset | 0,
      items: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || 60)) });
  }

  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.act === 'spawn') {
      /* Mirror of NpcFinder::CopyLookOf so ?dev=1 shows the real branch: a
         ★ Unique row with a baked face (fc) warns unless force was sent. */
      let row = null;
      for (let i = 0; i < DEV_NPCS.length; i++) if (DEV_NPCS[i].id === req.id) row = DEV_NPCS[i];
      if (row && row.u && row.fc && !req.force) {
        const them = row.s === 'f' ? 'her' : 'him';
        window.nxActResult({ ok: false, act: 'spawn', found: false, warn: 'faceless',
          id: row.id, name: row.n, canBring: true, face: row.fc,
          msg: row.n + ' has a sculpted face that only the real ' + them +
               ' carries — a copy comes out faceless. Bring ' + them + ' instead.' });
        return;
      }
      window.nxActResult({ ok: true, act: 'spawn', found: true, msg: '✦ someone appears' });
      return;
    }
    window.nxActResult({ ok: false, act: req.act, found: false,
      msg: "They aren't anywhere in the loaded world right now — Spawn a copy instead" });
  }

  /* A dense inspect subject for ?dev=1: every slot filled, long enchanted
     names, a negative resist, a capped one, and effects across all five piles
     plus the engine's hidden plumbing — the shape the layout has to survive. */
  function devInspect(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const piles = ['buff', 'debuff', 'disease', 'poison', 'constant'];
    const effects = [];
    for (let i = 0; i < 24; i++) {
      const g = piles[i % 5];
      effects.push({
        name: i === 3 ? 'Fortify Restoration and Regenerate Magicka of the Waning Moon'
          : ['Frost Damage', 'Fortify Smithing', 'Ataxia', 'Ravage Stamina', 'Blessing of Talos',
             'Vampiric Drain', 'Muffle', 'Highborn'][i % 8],
        source: ['Ice Spike', "Blacksmith's Elixir", 'Ataxia', 'Deathbell Poison', 'Shrine Blessing',
                 'Vampire Lord', 'Muffle', 'Racial'][i % 8],
        plugin: i % 3 === 0 ? 'Skyrim.esm' : (i % 3 === 1 ? 'Dawnguard.esm' : 'Apothecary.esp'),
        magnitude: (i * 7) % 60, durSec: i % 4 === 3 ? 0 : 30 + i * 137,
        remainSec: i % 4 === 3 ? 0 : 5 + i * 61,
        harmful: g === 'debuff' || g === 'poison' || g === 'disease',
        group: g, sourceKind: ['spell', 'potion', 'ability', 'shout', 'enchantment'][i % 5],
        av: ['Health', 'Magicka', 'Smithing', '', 'One-Handed'][i % 5], hidden: i % 11 === 0,
      });
    }
    window.niInspectData({
      ok: true, seq: req.seq | 0, src: req.id ? 'id' : 'crosshair',
      who: { name: 'Sylvara the Ashen', ref: '0xFF001A2C', formId: '0x000801',
             plugin: 'CoolFollowers.esl', level: 48, race: 'Dark Elf', raceEditorId: 'DarkElfRace',
             cls: 'Nightblade', sex: 'Female', voice: 'FemaleEvenToned', combatStyle: 'csMagicRanged',
             dead: false, essential: true, 'protected': false, unique: true, summonable: false,
             inCombat: true },
      pools: { hp: { cur: 512, max: 740 }, mag: { cur: 300, max: 300 }, sta: { cur: 87, max: 210 } },
      regen: { has: true, hp: 5.2, mag: 9.4, sta: -2.3, inCombat: true },
      resist: { armor: 567, phys: 80, fire: -25, frost: 75, shock: 55, magic: 85, poison: 0,
                disease: 100, pieces: 4, capMagic: 85, capPhys: 80 },
      combat: { damage: 124.5, speed: 0.75, reach: 1.3, move: 126, unarmed: false, estimated: true,
                weapon: 'Nightingale Blade of the Waning Moon', ranged: false, arrow: 0, arrowName: '' },
      ai: [
        { key: 'aggression', label: 'Aggression', value: 2, word: 'Very aggressive', note: 'Whether they pick the fight.' },
        { key: 'confidence', label: 'Confidence', value: 4, word: 'Foolhardy', note: 'Whether they finish it.' },
        { key: 'morality', label: 'Morality', value: 0, word: 'Any crime', note: 'What they will let you get away with.' },
        { key: 'assistance', label: 'Assistance', value: 2, word: 'Helps friends and allies', note: 'Whether they join in.' },
        { key: 'mood', label: 'Mood', value: 1, word: 'Angry', note: 'The idle expression.' },
        { key: 'energy', label: 'Energy', value: 70, word: '', note: 'How much they wander.' },
      ],
      traits: [{ text: 'Person', kind: 'type' }, { text: 'Vampire', kind: 'beast' }],
      equip: [
        { slot: 'head', label: 'Head', kind: 'armor', name: 'Nightingale Hood', armor: 18,
          badges: [{ text: '+20', av: 'Illusion' }] },
        { slot: 'body', label: 'Body', kind: 'armor', armor: 137,
          name: 'Ancient Shrouded Armour of Eminent Extreme Destruc',
          badges: [{ text: '25%', av: 'One-Handed' }, { text: '+60', av: 'Stamina' }] },
        { slot: 'hands', label: 'Hands', kind: 'armor', name: 'Gauntlets of Extreme Smithing', armor: 25,
          badges: [{ text: '+25', av: 'Smithing' }] },
        { slot: 'feet', label: 'Feet', kind: 'armor', name: 'Nightingale Boots', armor: 10, badges: [] },
        { slot: 'amulet', label: 'Amulet', kind: 'armor', name: 'Gauldur Amulet Fragment', armor: 0,
          badges: [{ text: '+50', av: 'Magicka' }] },
        { slot: 'ring', label: 'Ring', kind: 'armor', name: '', badges: [] },
        { slot: 'right', label: 'Right hand', kind: 'weapon', name: 'Nightingale Blade of the Waning Moon',
          damage: 124.5, speed: 0.75, reach: 1.3, damageEstimated: true,
          badges: [{ text: '+30', av: 'Fire resist' }] },
        { slot: 'left', label: 'Left hand', kind: 'spell', name: 'Sparks', badges: [] },
        { slot: 'ammo', label: 'Ammo', kind: 'ammo', name: '', badges: [] },
      ],
      skills: [['One-Handed', 100], ['Two-Handed', 42], ['Archery', 76], ['Block', 55],
        ['Smithing', 100], ['Heavy Armor', 88], ['Light Armor', 30], ['Pickpocket', 15],
        ['Lockpicking', 40], ['Sneak', 62], ['Alchemy', 90], ['Speech', 78], ['Alteration', 45],
        ['Conjuration', 66], ['Destruction', 80], ['Illusion', 33], ['Restoration', 72],
        ['Enchanting', 100]].map(function (s) { return { name: s[0], level: s[1] }; }),
      effects: effects,
      social: {
        rank: { has: true, rank: 3, label: 'Ally' }, teammate: true, hostile: false,
        maras: { on: true, spouse: true, status: 2, statusText: 'Married', hierarchy: 0,
                 affection: 80, mood: 'happy' },
        factions: [{ n: 'PotentialFollowerFaction', rank: 0 }, { n: 'WhiterunHousecarlFaction', rank: -1 },
          { n: 'PlayerFaction', rank: 1 }, { n: 'CrimeFactionWhiterun', rank: -1 }],
      },
    });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    ui.visible = true;
    devState();
    ok('state: ready', state.ready === true);
    ok('state: plugins landed', state.plugins.length === 3);

    ui.q = ''; ui.plugin = ''; ui.type = 'all';
    render();
    ok('hero: shown with stats', !$('nx-empty').classList.contains('hidden') &&
      $('nx-empty').textContent.indexOf('28,714') !== -1);

    ui.q = 'lydia';
    state.seq++; devQuery(JSON.stringify({ q: 'lydia', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('query: Lydia found', state.items.length === 1 && state.items[0].n === 'Lydia');
    ok('row: unique chip drawn', !!document.querySelector('#nx-body .nx-chip-uniq'));
    ok('row: three action buttons', document.querySelectorAll('#nx-body .nx-row .nx-do').length === 3);

    /* face key normalisation — the C++ KeyOf contract */
    ok('face key: uppercased hex, lowercased plugin',
      faceKey('Skyrim.esm|000a2c8e') === '0X000A2C8E|skyrim.esm');

    /* icon request payload */
    const sent = [];
    const realFn = window.nxIcons;
    window.nxIcons = function (a) { sent.push(JSON.parse(a)); };
    flushIconsForTest();
    window.nxIcons = realFn;
    ok('icons: asked for Lydia only (8-hex, 0x-prefixed)',
      sent.length === 1 && sent[0].items.length === 1 && sent[0].items[0].formId === '0x000A2C8E');

    /* icons land -> art appears */
    window.nxIconsData({ version: 1, icons: { '0X000A2C8E|skyrim.esm': 'icons/npcs/skyrim-esm-000a2c8e.png' } });
    ok('icons: row upgraded in place', !!document.querySelector('#nx-body .nx-plate.nx-has-art img'));

    /* templated row keeps glyph and says why */
    ui.q = 'bandit';
    state.seq++; devQuery(JSON.stringify({ q: 'bandit', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('template: chip explains the missing portrait', !!document.querySelector('#nx-body .nx-chip-tmpl'));
    const sent2 = [];
    window.nxIcons = function (a) { sent2.push(a); };
    flushIconsForTest();
    window.nxIcons = realFn;
    ok('template: no render ever requested', sent2.length === 0);

    /* stale replies dropped */
    const before = state.items.length;
    devQuery(JSON.stringify({ q: 'lydia', type: 'all', plugin: '', seq: state.seq - 1, limit: 60, offset: 0 }));
    ok('stale seq: dropped', state.items.length === before);

    /* mods section + plugin chip */
    ui.q = 'cool';
    state.seq++; devQuery(JSON.stringify({ q: 'cool', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('mods section: CoolFollowers listed', document.querySelectorAll('#nx-body .nx-plug-row').length >= 1);
    setPlugin('CoolFollowers.esl');
    devQuery(JSON.stringify({ q: '', type: 'all', plugin: 'CoolFollowers.esl', seq: state.seq, limit: 60, offset: 0 }));
    render();
    ok('plugin browse: only its people', state.items.length === 1 && state.items[0].p === 'CoolFollowers.esl');
    ok('plugin chip: visible', !$('nx-plug-chip').classList.contains('hidden'));
    clearPlugin();

    /* pills */
    ui.type = 'fem'; ui.q = '';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'fem', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    ok('pill: women only', state.items.length > 0 && state.items.every(function (it) { return it.s === 'f'; }));
    ui.type = 'all';

    /* honest refusal toast */
    devAct(JSON.stringify({ act: 'bring', id: 'x' }));
    ok('act: refusal reaches the toast', $('nx-toast').classList.contains('nx-toast-show') &&
      $('nx-toast').classList.contains('nx-toast-err'));

    /* flat rows: mods before people */
    ui.q = 'cool'; ui.plugin = ''; ui.type = 'all';
    state.seq++; devQuery(JSON.stringify({ q: 'cool', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    const rows = flatRows();
    ok('flat rows: mods before people', rows.length >= 2 && rows[0].kind === 'plug');

    /* secondary plugin filter — fuzzy match + composes with the name search */
    ok('plugfilter: whole-substring matches', pluginFuzzy('miranda.esp', 'mira'));
    ok('plugfilter: subsequence matches (mrnd)', pluginFuzzy('miranda.esp', 'mrnd'));
    ok('plugfilter: rejects a non-match', !pluginFuzzy('miranda.esp', 'daedra'));
    ok('plugfilter: empty keeps everyone', pluginFuzzy('anything.esp', ''));
    ui.q = ''; ui.plugin = ''; ui.type = 'all'; ui.plugFilter = '';
    state.seq++; devQuery(JSON.stringify({ q: '', type: 'all', plugin: '', seq: state.seq, limit: 60, offset: 0 }));
    /* query everyone (empty q, all pill only returns on a real query in prod; in
       dev devQuery returns all rows regardless) */
    state.items = DEV_NPCS.slice();
    const allPeople = flatRows().filter(function (x) { return x.kind === 'npc'; }).length;
    ui.plugFilter = 'cool';
    const coolPeople = flatRows().filter(function (x) { return x.kind === 'npc'; });
    ok('plugfilter: narrows the page to the matching plugin',
      allPeople > coolPeople.length && coolPeople.length >= 1 &&
      coolPeople.every(function (x) { return /cool/i.test(x.it.p); }));
    ui.plugFilter = '';
    ok('plugfilter: hidden while browsing inside one mod', (function () {
      ui.plugin = 'CoolFollowers.esl'; const v = plugFilterVisible(); ui.plugin = ''; return v === false;
    })());

    const fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
    window.__selftest = { out: out, fails: fails.length };
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'npcs', label: 'NPCs', tab: 'npcs',
    setFilter: setFilter,
    index: function () {
      return [{
        label: 'NPC Finder',
        detail: 'Find anyone any mod ships — go to them, bring them, or spawn a copy',
        kind: 'npcs',
        keywords: 'npc finder actor character person people find teleport summon bring goto spawn placeatme face',
      }];
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _flushIcons: flushIconsForTest, _iconPollTick: iconPollTick, _missingArt: missingArt,
    _state: state, _ui: ui, _flatRows: flatRows, _modMatches: modMatches,
    _faceKey: faceKey, _faceParts: faceParts, _openLightbox: openLightbox,
    _artFor: artFor, _bodyIconFor: bodyIconFor,
    _rowLoading: rowLoading, _renderWindowActive: renderWindowActive,
    _armWindow: function () { chipLastLand = Date.now(); },
    _closeWindow: function () { chipLastLand = 1; },
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _pluginFuzzy: pluginFuzzy, _plugFilterVisible: plugFilterVisible,
    _toggleDetail: toggleDetail, _detailInnerHtml: detailInnerHtml,
    _insp: insp, _openInspect: openInspect, _closeInspect: closeInspect,
    _renderInspect: renderInspect, _effectRows: effectRows, _fmtDur: fmtDur,
    _inspectTargetBtn: inspectTargetBtn,
    _openSpawnGuard: openSpawnGuard, _closeSpawnGuard: closeSpawnGuard, _guard: guard,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.NpcsPane.init(); });
} else {
  window.NpcsPane.init();
}
