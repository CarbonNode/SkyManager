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
  const PAGE = 60;

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
    sel: 0,
    visible: false,
    debT: null,
    toastT: null,
    iconReq: {},
    iconT: null,
    iconPollT: null,
    iconPollN: 0,
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
    if (ui.visible) {
      if (state.ready && (ui.q || ui.plugin || ui.type !== 'all') && !state.items.length && !state.awaiting)
        runQuery(true);
      render();
    }
  };

  window.nxResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    state.awaiting = false;
    state.total = d.total | 0;
    const rows = Array.isArray(d.items) ? d.items : [];
    if ((d.offset | 0) > 0) state.items = state.items.concat(rows);
    else state.items = rows;
    if (ui.visible) render();
  };

  window.nxActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
  };

  /* Face renders landed (a reply to our nxIcons, or the C++ batch-done push).
     Merge, and repaint in place only if something actually changed — the
     Items tab's own change-gate, so the 2.5s poll never causes churn. */
  window.nxIconsData = function (d) {
    if (!d || typeof d !== 'object' || typeof d.icons !== 'object' || !d.icons) return;
    let changed = false;
    for (const k in d.icons) {
      if (state.icons[k] !== d.icons[k]) { state.icons[k] = d.icons[k]; changed = true; }
    }
    if (changed && ui.visible) renderBodyPreservingScroll();
  };

  /* ============================================================ queries == */

  function runQuery(reset) {
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!ui.q && !ui.plugin && ui.type === 'all') {
      state.items = []; state.total = 0; state.awaiting = false;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    if (reset) { state.items = []; ui.sel = 0; }
    toGame('nxQuery', JSON.stringify({
      q: ui.q, type: ui.type === 'mods' ? 'all' : ui.type, plugin: ui.plugin,
      limit: PAGE, offset: reset ? 0 : state.items.length, seq: state.seq,
    }));
    render();
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
      state.items.forEach(function (it) { rows.push({ kind: 'npc', it: it }); });
      if (state.items.length < state.total) rows.push({ kind: 'more' });
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
    if (row.kind === 'more') { runQuery(false); return; }
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

  function iconFor(fc) {
    const key = faceKey(fc);
    if (!key) return '';
    const path = state.icons[key] || '';
    if (!path) return '';
    if (path.indexOf('..') !== -1 || path[0] === '/' || path.indexOf(':') !== -1) return '';
    return path;
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
    const url = iconFor(it.fc);
    if (!url) return glyph;
    return glyph + '<img class="nx-art" src="' + esc(url) + '" alt="" draggable="false"' + ICO_ERR + '>';
  }

  /* ============================================================ lightbox == */

  /* Click the face -> the 512px FaceGen render, big (hd-lightbox.js). Faces
     have no turntable siblings, so this is the plain big view. */
  function openLightbox(it) {
    const url = iconFor(it.fc);
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
    const hasArt = !!iconFor(it.fc);
    const plateCls = 'nx-plate' + (it.u ? ' nx-t-uniq' : it.s === 'f' ? ' nx-t-fem' : ' nx-t-male') +
      (hasArt ? ' nx-has-art nx-zoomable' : '');
    let chips = '';
    if (it.u) chips += '<span class="nx-chip nx-chip-uniq" title="Unique — there is exactly one of them">★ Unique</span>';
    if (it.e) chips += '<span class="nx-chip nx-chip-ess" title="Essential — cannot be killed">⛨</span>';
    if (it.t && !faceParts(it.fc))
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
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        html += '<div class="nx-sect">Mods <b>' +
          (ui.type === 'mods' ? modMatches(30).length : Math.min(5, modMatches(5).length)) + '</b></div>';
      }
      if (r.kind === 'npc' && !inNpcs) {
        inNpcs = true;
        html += '<div class="nx-sect">People <b>' + fmtN(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'npc') html += npcRowHtml(r.it, ui.sel, idx);
      else if (r.kind === 'more') {
        html += '<button class="nx-btn nx-more' + (ui.sel === idx ? ' nx-on' : '') + '" id="nx-more-btn">' +
          (state.awaiting ? 'Loading…' : 'Show ' + Math.min(PAGE, state.total - state.items.length) + ' more of ' +
            fmtN(state.total)) + '</button>';
      }
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
    const more = $('nx-more-btn');
    if (more) more.addEventListener('click', function () { runQuery(false); });

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
    renderBody();
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
          const rows = flatRows();
          activate(rows[Math.min(ui.sel, rows.length - 1)] || rows[0]);
          e.stopPropagation();
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
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.NpcsPane.init(); });
} else {
  window.NpcsPane.init();
}
