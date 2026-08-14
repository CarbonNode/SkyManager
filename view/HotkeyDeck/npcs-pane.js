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
    visible: false,
    debT: null,
    toastT: null,
    iconReq: {},
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
    hintSeen: false,   // the first-open "faces render in the background" hint
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
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
    /* A page REPLACES — state.items is exactly the current page, never the
       accumulation the old "Show more" foot built up. This is what shrinks the
       face-render burst with page size: requestIcons() only ever sees one page. */
    state.items = Array.isArray(d.items) ? d.items : [];
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
    if (reset) { ui.page = 0; chipLastLand = Date.now(); }   // a new search re-arms the render chip
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
    return out.slice(0, limit);
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
      modMatches(ui.type === 'mods' ? 30 : 5).forEach(function (p) { rows.push({ kind: 'plug', p: p }); });
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
    if (row.kind === 'npc') act('bring', row.it);
  }

  /* ============================================================= actions == */

  function act(what, it) {
    toGame('nxAct', JSON.stringify({ act: what, id: it.id }));
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

  /* Click the plate -> the big render (hd-lightbox.js). A face or a creature
     body; neither has turntable siblings here, so this is the plain big view. */
  function openLightbox(it) {
    const art = artFor(it);
    const url = art ? art.url : '';
    if (!url || !window.HDLightbox) return;
    HDLightbox.open({
      host: $('nx-pane'),
      src: url,
      glyph: it.s === 'f' ? '♀' : '♂',
      title: it.n,
      sub: (it.r || (it.s === 'f' ? 'Woman' : 'Man')) + ' · ' + it.p +
        (it.u ? ' · ★ unique' : '') + (it.e ? ' · ⛨ essential' : ''),
    });
  }

  function renderHeader() {
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
    return '<div class="nx-row' + (selIdx === idx ? ' nx-sel' : '') + '" data-id="' + esc(it.id) + '">' +
      '<div class="' + plateCls + '" title="' + esc(hasArt ? it.n + ' — click for a bigger look' : it.n) + '">' +
      plateInner(it) + '</div>' +
      '<div class="nx-mid">' +
      '<div class="nx-name" title="' + esc(it.n) + '"><span class="nx-name-txt">' + highlight(it.n, ui.q) + '</span>' + chips + '</div>' +
      '<div class="nx-meta">' +
      '<span class="nx-meta-race">' + esc(it.r || (it.s === 'f' ? 'Woman' : 'Man')) + '</span>' +
      '<span class="nx-meta-plug" data-plug="' + esc(it.p) + '" title="Browse everyone ' + esc(it.p) + ' ships">' + esc(it.p) + '</span>' +
      '</div></div>' +
      '<div class="nx-act">' +
      '<button class="nx-btn nx-do nx-primary" data-act="bring" title="Teleport them to you (Enter does this too)">⤝ Bring</button>' +
      '<button class="nx-btn nx-do" data-act="goto" title="Teleport yourself to wherever they are">⤞ Go to</button>' +
      '<button class="nx-btn nx-do nx-spawn" data-act="spawn" title="Place a COPY of them at your feet — the original, if any, is untouched">＋ Spawn</button>' +
      '</div></div>';
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
        html += '<div class="nx-sect">Mods <b>' +
          (ui.type === 'mods' ? modMatches(30).length : Math.min(5, modMatches(5).length)) + '</b></div>';
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
      else if (r.kind === 'npc') html += npcRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    body.querySelectorAll('.nx-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
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

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('nxState');   // first call builds the C++ index; later calls are cheap
    const s = $('nx-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    if (state.ready && (ui.q || ui.plugin || ui.type !== 'all')) runQuery(true);
    render();
  }

  function onHide() {
    ui.visible = false;
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

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
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
    if (req.act === 'spawn') { window.nxActResult({ ok: true, act: 'spawn', found: true, msg: '✦ someone appears' }); return; }
    window.nxActResult({ ok: false, act: req.act, found: false,
      msg: "They aren't anywhere in the loaded world right now — Spawn a copy instead" });
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
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.NpcsPane.init(); });
} else {
  window.NpcsPane.init();
}
