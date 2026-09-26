'use strict';

/* ====================================================================== *
 *  Spells — the Finder's fourth roster (Rober, 2026-09-23, with the Cell
 *  Finder open on "talk to imp": "add spells as searchable tab?").
 *
 *  The Cells pane's structural twin: C++ owns the index, the matching and
 *  every verb (spell_finder.cpp); this pane owns the ONE bar, the pills and
 *  the rows. Every spell, power, ability and shout the load order ships is
 *  a row, whether you know it or not — "known" is a LIVE fact drawn as a
 *  chip, and the verbs follow it: an unknown row's obvious thing is Learn,
 *  a known row's is Cast, and Teach gives it to whoever you were looking at
 *  when the deck opened.
 *
 *  Bridge — requests: sfState() · sfQuery(json) · sfAct(json) · sfSave(json)
 *  Replies (disjoint, per the deck law): sfStateResult({phase,count,pageSize,
 *  plugins,target}) · sfResultData({seq,total,offset,items} | {seq,detail,
 *  info}) · sfActResult({ok,act,msg}) · sfSaved({ok,pageSize}). A cast gets
 *  its reply AFTER the palette closed and the spell fired — C++ owns that.
 *
 *  Host contract (mirrors CellsPane): SpellsPane.init() · onShow() · onHide()
 *  · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.SpellsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;

  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;

  const MODS_PAGE = 30;
  const MODS_PREVIEW = 5;

  /* ============================================================== pills == */

  /* pseudo-kinds; 'all' and 'mods' the C++ never sees, the rest map to the
     C++ `type` filter. Known/Unknown are LIVE filters (C++ asks the engine
     per hit), which is why Learn re-queries the page. */
  const KINDS = [
    ['all',     'Everything', '⌕', 'Search spells, powers, shouts, abilities and mods together'],
    ['mods',    'Mods',       '',  'Search plugin names only — esp, esm, esl'],
    ['spell',   'Spells',     '',  'Hand-cast spells only — Destruction, Restoration, Alteration, Illusion, Conjuration'],
    ['power',   'Powers',     '',  'Greater and lesser powers — the voice-slot things that are not shouts'],
    ['shout',   'Shouts',     '',  'The Thu’um — every shout, with its three words'],
    ['ability', 'Abilities',  '',  'Passive abilities (racial, perk, item) — learn one and it simply applies'],
    ['known',   'Known',      '★', 'Only what you know right now'],
    ['unknown', 'Unknown',    '',  'Only what you do not know yet'],
  ];

  const KIND_LABEL = {
    spell: 'Spell', power: 'Power', lesser: 'Lesser power', voice: 'Voice power',
    ability: 'Ability', shout: 'Shout',
  };
  const DELIVERY_LABEL = {
    self: 'on yourself', touch: 'touch', aimed: 'aimed', target: 'at a target', location: 'at a spot',
  };
  const CASTING_LABEL = {
    fire: 'fire and forget', concentration: 'concentration', constant: 'constant', scroll: 'scroll',
  };

  /* ============================================================== state == */

  const state = {
    ready: false,
    count: 0,
    plugins: [],
    target: null,       // {name, formId} — the crosshair actor at palette open, or null
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
    expanded: '',
    detail: {},
    detailErr: {},
    lastAct: null,      // {act, id} — so a reply can refresh what it changed
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'sfState') setTimeout(devState, 30);
      if (DEV && fn === 'sfQuery') setTimeout(function () { devQuery(arg); }, 30);
      if (DEV && fn === 'sfAct') setTimeout(function () { devAct(arg); }, 30);
    }
  }

  window.sfStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.phase === 'ready';
    state.count = d.count | 0;
    state.plugins = Array.isArray(d.plugins) ? d.plugins : [];
    state.target = (d.target && typeof d.target === 'object' && d.target.name) ? d.target : null;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) ui.pageSize = clampPageSize(d.pageSize);
    if (ui.visible) {
      if (state.ready && (ui.q || ui.plugin || ui.type !== 'all') && !state.items.length && !state.awaiting)
        runQuery(true);
      render();
    }
  };

  window.sfSaved = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.pageSize === 'number' && d.pageSize > 0) {
      const p = clampPageSize(d.pageSize);
      if (p !== ui.pageSize) { ui.pageSize = p; if (ui.visible) runQuery(true); }
    }
  };

  window.sfResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.detail === 'string' && d.detail) {
      if (d.info && typeof d.info === 'object' && Object.keys(d.info).length)
        { ui.detail[d.detail] = d.info; delete ui.detailErr[d.detail]; }
      else ui.detailErr[d.detail] = d.err || 'Could not read this spell';
      if (ui.visible && ui.expanded === d.detail) patchDetailInPlace(d.detail);
      return;
    }
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
    if (ui.visible) render();
  };

  /* Learn / forget / teach change what the rows say (the Known chip, the
     verb) and what a detail would read — so a success re-asks for the same
     page and drops the cached detail. The toast carries C++'s own words. */
  window.sfActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    const la = ui.lastAct;
    if (d.ok && la && (la.act === 'learn' || la.act === 'forget' || la.act === 'teach')) {
      delete ui.detail[la.id];
      if (ui.visible && (ui.q || ui.plugin || ui.type !== 'all')) runQuery(false);
    }
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

  function runQuery(reset) {
    if (reset) { ui.page = 0; ui.modsShown = MODS_PAGE; ui.sel = 0; }
    if (ui.type === 'mods') { state.awaiting = false; render(); return; }
    if (!ui.q && !ui.plugin && ui.type === 'all') {
      state.items = []; state.total = 0; state.awaiting = false; ui.page = 0;
      render();
      return;
    }
    state.seq++;
    state.awaiting = true;
    toGame('sfQuery', JSON.stringify({
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
    ui.sel = 0;
    runQuery(false);
    const body = $('sf-body');
    if (body) body.scrollTop = 0;
    const s = $('sf-search');
    if (s) s.focus();
  }

  function changePageSize(n) {
    n = clampPageSize(n);
    if (n === ui.pageSize) return;
    ui.pageSize = n;
    ui.page = 0;
    toGame('sfSave', JSON.stringify({ pageSize: ui.pageSize }));
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
      state.items.forEach(function (it) { rows.push({ kind: 'spell', it: it }); });
    return rows;
  }

  function showsModSection() {
    if (ui.plugin) return false;
    if (ui.type === 'mods') return true;
    return ui.type === 'all' && !!ui.q;
  }

  /* The verb Enter means for a row, and the one the primary button wears:
     an unknown row's obvious thing is Learn; a known, castable row's is Cast;
     a known ability has nothing obvious (it is already applying), so Enter
     opens its detail instead. */
  function primaryFor(it) {
    if (!it) return '';
    if (!it.kn) return 'learn';
    if (it.k === 'ability') return '';
    return 'cast';
  }

  function activate(row) {
    if (!row) return;
    if (row.kind === 'plug') { setPlugin(row.p.n); return; }
    if (row.kind === 'more') { showMoreMods(); return; }
    if (row.kind === 'spell') {
      const verb = primaryFor(row.it);
      if (verb) act(verb, row.it);
      else toggleDetail(row.it.id);
    }
  }

  function showMoreMods() {
    ui.modsShown += MODS_PAGE;
    renderBodyPreservingScroll();
  }

  /* ============================================================= actions == */

  function act(what, it) {
    if (!it) return;
    ui.lastAct = { act: what, id: it.id };
    toGame('sfAct', JSON.stringify({ act: what, id: it.id }));
    if (what === 'cast') toast('Casting ' + labelOf(it) + '…');
    else if (what === 'learn') toast('Learning ' + labelOf(it) + '…');
    else if (what === 'teach') toast('Teaching ' + labelOf(it) + '…');
    else if (what === 'forget') toast('Forgetting ' + labelOf(it) + '…');
  }

  function setPlugin(name) {
    ui.plugin = String(name || '');
    ui.q = '';
    const s = $('sf-search');
    if (s) { s.value = ''; s.focus(); }
    if (ui.type === 'mods') ui.type = 'all';
    runQuery(true);
  }

  function clearPlugin() {
    ui.plugin = '';
    runQuery(true);
    const s = $('sf-search');
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
  function cap(s) { s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(String(q).toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }

  /* The ONE place a row's title is chosen — every toast and title attribute
     names a spell the same way. */
  function labelOf(it) {
    if (!it) return '';
    return it.n || it.e || '(unnamed spell)';
  }

  function kindLabel(it) { return KIND_LABEL[it.k] || cap(it.k || 'spell'); }

  /* The chips: what it IS (kind), which school (coloured like the magic menu's
     tabs) and how far in, whether it is hostile, and whether you know it. */
  function chipsHtml(it) {
    let out = '';
    if (it.k === 'shout')
      out += '<span class="sf-chip sf-chip-shout" title="A shout — three words of the Thu’um">Shout</span>';
    else
      out += '<span class="sf-chip sf-chip-kind" title="' + esc(kindLabel(it)) + '">' + esc(kindLabel(it)) + '</span>';
    if (it.s) {
      out += '<span class="sf-chip sf-chip-school-' + esc(it.s) + '" title="School' + (it.t ? ' and tier' : '') + '">' +
        esc(cap(it.s)) + (it.t ? ' · ' + esc(cap(it.t)) : '') + '</span>';
    } else if (it.el) {
      out += '<span class="sf-chip sf-chip-kind" title="Element">' + esc(cap(it.el)) + '</span>';
    }
    if (it.hs)
      out += '<span class="sf-chip sf-chip-hostile" title="The game treats casting this at someone as an attack">Hostile</span>';
    if (it.kn)
      out += '<span class="sf-chip sf-chip-known" title="You know this right now">★ Known</span>';
    return out;
  }

  /* ============================================================== rows == */

  function plugRowHtml(p, selIdx, idx) {
    const kindCls = p.k === 'esm' ? 'sf-kind-esm' : (p.k === 'esl' || p.l) ? 'sf-kind-esl' : 'sf-kind-esp';
    const kindLbl = String(p.k || 'esp').toUpperCase() + (p.l && p.k === 'esp' ? ' · light' : '');
    return '<div class="sf-plug-row' + (selIdx === idx ? ' sf-sel' : '') + '" data-plug="' + esc(p.n) +
      '" title="Browse every spell ' + esc(p.n) + ' ships">' +
      '<span class="sf-kindbadge ' + kindCls + '">' + esc(kindLbl) + '</span>' +
      '<span class="sf-plug-name">' + highlight(p.n, ui.q) + '</span>' +
      '<span class="sf-plug-count">' + fmtN(p.c) + ' spells</span>' +
      '<span class="sf-plug-go">Browse →</span></div>';
  }

  function moreModsRowHtml(left, selIdx, idx) {
    const next = Math.min(left, MODS_PAGE);
    return '<button class="sf-plug-more' + (selIdx === idx ? ' sf-sel' : '') +
      '" title="Draw the next ' + fmtN(next) + ' mods">' +
      '<span class="sf-plug-more-t">Show ' + fmtN(next) + ' more</span>' +
      '<span class="sf-plug-count">' + fmtN(left) + ' not shown</span>' +
      '<span class="sf-plug-go">▼</span></button>';
  }

  function teachTitle(it) {
    if (!state.target) return 'Teach needs someone in your crosshair when the deck opens — nobody was';
    return 'Teach ' + labelOf(it) + ' to ' + state.target.name + ' — the person you were looking at when the deck opened';
  }

  function spellRowHtml(it, selIdx, idx) {
    const open = ui.expanded === it.id;
    const title = labelOf(it);
    const verb = primaryFor(it);
    let meta = '';
    const how = [];
    if (it.d && DELIVERY_LABEL[it.d]) how.push(DELIVERY_LABEL[it.d]);
    if (it.c && CASTING_LABEL[it.c] && it.c !== 'fire') how.push(CASTING_LABEL[it.c]);
    if (how.length)
      meta += '<span class="sf-meta-words" title="How it is cast">' + esc(how.join(' · ')) + '</span>';
    if (it.cost > 0)
      meta += '<span class="sf-meta-words sf-chip-cost" title="Magicka it costs you right now">' + fmtN(it.cost) + ' magicka</span>';
    if (it.e)
      meta += '<span class="sf-meta-edid sf-mono" title="Editor id">' + highlight(it.e, ui.q) + '</span>';
    meta += '<span class="sf-meta-plug" data-plug="' + esc(it.p) + '" title="Browse every spell ' +
      esc(it.p) + ' ships">' + esc(it.p) + '</span>';

    let acts = '<button class="sf-btn sf-info' + (open ? ' sf-info-on' : '') + '" data-info="' + esc(it.id) +
      '" title="Effects, description, cost, and who knows it" ' +
      'aria-expanded="' + (open ? 'true' : 'false') + '">ⓘ Info</button>';
    if (verb === 'learn')
      acts += '<button class="sf-btn sf-do sf-primary" data-act="learn" title="Add ' + esc(title) +
        ' to your spellbook now' + (it.k === 'shout' ? ' — the shout arrives with all three words unlocked' : '') +
        ' (Enter does this too)">＋ Learn</button>';
    if (verb === 'cast')
      acts += '<button class="sf-btn sf-do sf-primary" data-act="cast" title="Cast ' + esc(title) +
        ' now — the deck closes, the spell fires into the live world' +
        (it.d !== 'self' ? ', at whoever you were looking at' : '') + ' (Enter does this too)">⤞ Cast</button>';
    if (!it.kn && it.k === 'spell')
      acts += '<button class="sf-btn sf-do" data-act="cast" title="Cast ' + esc(title) +
        ' once without learning it — a hand spell can be fired straight from the load order">⤞ Cast once</button>';
    if (it.kn && it.k !== 'shout')
      acts += '<button class="sf-btn sf-do" data-act="forget" title="Remove ' + esc(title) +
        ' from your spellbook — the spell stays in the load order, so Learn brings it back">− Forget</button>';
    if (state.target)
      acts += '<button class="sf-btn sf-do" data-act="teach" title="' + esc(teachTitle(it)) + '">👤 Teach ' +
        esc(state.target.name) + '</button>';
    else
      acts += '<button class="sf-btn sf-do sf-cant" data-act="teach" disabled title="' + esc(teachTitle(it)) + '">👤 Teach</button>';

    return '<div class="sf-row' + (selIdx === idx ? ' sf-sel' : '') + (open ? ' sf-row-open' : '') +
      '" data-id="' + esc(it.id) + '">' +
      '<div class="sf-mid">' +
      '<div class="sf-name" title="' + esc(title) + '"><span class="sf-name-txt">' + highlight(it.n, ui.q) + '</span>' +
      chipsHtml(it) + '</div>' +
      '<div class="sf-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="sf-act">' + acts + '</div></div>' +
      (open ? '<div class="sf-detail" data-for="' + esc(it.id) + '">' +
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
    toGame('sfQuery', JSON.stringify({ detail: id, seq: state.seq }));
  }

  function statHtml(label, value, cls) {
    return '<div class="sf-stat' + (cls ? ' ' + cls : '') + '">' +
      '<span class="sf-stat-l">' + esc(label) + '</span>' +
      '<span class="sf-stat-v">' + esc(value) + '</span></div>';
  }

  function effectsHtml(effects) {
    if (!Array.isArray(effects) || !effects.length) return '';
    let html = '<div class="sf-eff">' +
      '<span class="sf-eff-h">Effect</span><span class="sf-eff-h">Magnitude</span>' +
      '<span class="sf-eff-h">Duration</span><span class="sf-eff-h">Area</span>';
    effects.forEach(function (e) {
      html += '<span class="sf-eff-n">' + esc(e.n || 'effect') + (e.hostile ? ' <span class="sf-chip sf-chip-hostile">hostile</span>' : '') + '</span>' +
        '<span class="sf-eff-v">' + esc(fmtN(Math.round(Number(e.mag) || 0))) + '</span>' +
        '<span class="sf-eff-v">' + esc((e.dur | 0) ? (e.dur | 0) + ' s' : '—') + '</span>' +
        '<span class="sf-eff-v">' + esc((e.area | 0) ? (e.area | 0) : '—') + '</span>';
    });
    return html + '</div>';
  }

  function wordsHtml(words) {
    if (!Array.isArray(words) || !words.length) return '';
    return '<div class="sf-words">' + words.map(function (w) {
      return '<div class="sf-word"><b>' + esc(w.word || '?') + '</b><span>' +
        esc(w.translation || '') + (w.recovery ? ' · ' + esc(Math.round(w.recovery)) + ' s' : '') + '</span></div>';
    }).join('') + '</div>';
  }

  function detailInnerHtml(id, info) {
    if (ui.detailErr[id])
      return '<div class="sf-detail-err">' + esc(ui.detailErr[id]) + '</div>';
    if (!info)
      return '<div class="sf-detail-wait">Reading the spell…</div>';
    let html = '';
    if (info.desc) html += '<div class="sf-desc">' + esc(info.desc) + '</div>';
    html += wordsHtml(info.words);
    html += effectsHtml(info.effects);
    let stats = '';
    /* Who knows it, first: it is the line that decides which verb applies. */
    stats += statHtml('You', info.known ? 'Know it' : 'Do not know it yet');
    if (info.target && info.target.name)
      stats += statHtml(info.target.name, info.target.known ? 'Knows it' : 'Does not know it — Teach gives it');
    else
      stats += statHtml('Teach', 'Look at someone when you open the deck to teach them');
    if (info.kind === 'shout') stats += statHtml('Kind', 'Shout');
    else stats += statHtml('Kind', KIND_LABEL[info.kind] || cap(info.kind));
    if (info.school) stats += statHtml('School', cap(info.school) + (info.tier ? ' · ' + cap(info.tier) : ''));
    if (info.delivery) stats += statHtml('Cast', (DELIVERY_LABEL[info.delivery] || info.delivery) +
      (info.casting && CASTING_LABEL[info.casting] ? ' · ' + CASTING_LABEL[info.casting] : ''));
    if (info.cost > 0) stats += statHtml('Cost', fmtN(info.cost) + ' magicka' +
      (info.chargeTime ? ' · ' + (Math.round(info.chargeTime * 10) / 10) + ' s charge' : ''));
    if (info.hostile) stats += statHtml('Hostile', 'Yes — casting it at someone counts as an attack');
    if (info.edid) stats += '<div class="sf-stat"><span class="sf-stat-l">Editor id</span>' +
      '<span class="sf-stat-v sf-mono">' + esc(info.edid) + '</span></div>';
    if (info.formId) stats += '<div class="sf-stat"><span class="sf-stat-l">Form id</span>' +
      '<span class="sf-stat-v sf-mono">' + esc(info.formId) + '</span></div>';
    if (info.plugin) stats += statHtml('From', info.plugin);
    return html + '<div class="sf-stats">' + stats + '</div>';
  }

  function cssEsc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }

  function patchDetailInPlace(id) {
    const el = document.querySelector('#sf-body .sf-detail[data-for="' + cssEsc(id) + '"]');
    if (!el) { renderBodyPreservingScroll(); return; }
    el.innerHTML = detailInnerHtml(id, ui.detail[id]);
  }

  /* ============================================================ header == */

  function renderHeader() {
    const chip = $('sf-count-chip');
    if (chip) {
      chip.textContent = state.ready
        ? (fmtN(state.count) + ' spells · ' + fmtN(state.plugins.length) + ' mods indexed')
        : 'reading the load order…';
    }
    const tgt = $('sf-target');
    if (tgt) {
      if (state.target)
        tgt.innerHTML = '<span class="sf-target-chip" title="The person in your crosshair when the deck opened — Teach gives them the spell">👤 Teach → <b>' +
          esc(state.target.name) + '</b></span>';
      else
        tgt.innerHTML = '<span class="sf-target-chip" title="Teach needs someone in your crosshair when you open the deck">👤 Look at someone to Teach</span>';
    }
  }

  function renderPills() {
    const box = $('sf-pills');
    if (!box) return;
    box.innerHTML = KINDS.map(function (k) {
      return '<button class="sf-pill' + (ui.type === k[0] ? ' sf-pill-on' : '') +
        '" data-type="' + k[0] + '" aria-pressed="' + (ui.type === k[0] ? 'true' : 'false') +
        '" title="' + esc(k[3]) + '">' +
        (k[2] ? k[2] + ' ' : '') + esc(k[1]) + '</button>';
    }).join('');
    box.querySelectorAll('.sf-pill').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.type = b.getAttribute('data-type');
        ui.sel = 0;
        runQuery(true);
        const s = $('sf-search');
        if (s) s.focus();
      });
    });
  }

  function renderPlugChip() {
    const chip = $('sf-plug-chip');
    if (!chip) return;
    if (!ui.plugin) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
    chip.classList.remove('hidden');
    chip.innerHTML = '<b title="' + esc(ui.plugin) + '">' + esc(ui.plugin) + '</b>' +
      '<span class="sf-chip-x" title="Search every mod again">✕</span>';
    const x = chip.querySelector('.sf-chip-x');
    if (x) x.addEventListener('click', clearPlugin);
  }

  /* ============================================================== body == */

  function sectionLabel() {
    switch (ui.type) {
    case 'spell': return 'Spells';
    case 'power': return 'Powers';
    case 'shout': return 'Shouts';
    case 'ability': return 'Abilities';
    case 'known': return 'Known';
    case 'unknown': return 'Unknown';
    default: return 'Spells, powers and shouts';
    }
  }

  function renderBody() {
    const body = $('sf-body');
    const empty = $('sf-empty');
    if (!body || !empty) return;

    if (!state.ready) {
      body.innerHTML = new Array(7).fill(
        '<div class="sf-row sf-skel"><div class="sf-mid">' +
        '<span class="sf-skel-box sf-skel-w1"></span>' +
        '<span class="sf-skel-box sf-skel-w2"></span></div>' +
        '<span class="sf-skel-box sf-skel-btn"></span></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = flatRows();

    /* hero — nothing asked yet */
    if (!rows.length && !ui.q && !ui.plugin && ui.type === 'all') {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="sf-empty-title">Every spell, power and shout the load order ships</div>' +
        '<div class="sf-empty-sub"><b>' + fmtN(state.count) + ' spells</b> across <b>' +
        fmtN(state.plugins.length) + ' mods</b>, one bar — known or not. Type a spell, a school, an element, ' +
        'or a mod to browse everything it adds. <b>Learn</b> it, <b>Cast</b> it, or <b>Teach</b> it to ' +
        'whoever you were looking at.<br>Spells · powers · shouts · abilities. ' +
        '<b>Known</b> and <b>Unknown</b> are live — a spell you just learned moves at once.</div>' +
        '<div class="sf-try">' +
        ['Flames', 'Healing', 'Unrelenting Force', 'Skyrim.esm'].map(function (t) {
          return '<button class="sf-pill" data-try="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-try]').forEach(function (b) {
        b.addEventListener('click', function () {
          const s = $('sf-search');
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
        empty.innerHTML = '<div class="sf-empty-title">Searching…</div>';
      } else if (ui.type === 'mods') {
        empty.innerHTML = '<div class="sf-empty-title">No mod matches</div>' +
          '<div class="sf-empty-sub">No plugin name contains “' + esc(ui.q) + '”. Try fewer letters.</div>';
      } else {
        const what = ui.type === 'all' ? 'spell' : sectionLabel().toLowerCase().replace(/s$/, '');
        empty.innerHTML = '<div class="sf-empty-title">No ' + esc(what) + ' matches</div>' +
          '<div class="sf-empty-sub">Nothing called “' + esc(ui.q) + '”' +
          (ui.plugin ? ' in ' + esc(ui.plugin) : '') +
          (ui.type === 'known' ? ' that you know' : ui.type === 'unknown' ? ' that you do not know' : '') +
          '. Try fewer letters, a school (“destruction”), an element (“fire”), or another pill.' +
          (ui.type === 'known' ? ' Everything you could learn is under <b>Unknown</b>.' : '') +
          '</div>';
      }
      return;
    }
    empty.classList.add('hidden');

    let html = '';
    let idx = 0;
    let inMods = false, inSpells = false;
    rows.forEach(function (r) {
      if (r.kind === 'plug' && !inMods) {
        inMods = true;
        const modTotal = modMatches(0).length;
        const modDrawn = rows.filter(function (x) { return x.kind === 'plug'; }).length;
        html += '<div class="sf-sect">Mods <b>' + fmtN(modTotal) + '</b>' +
          (modDrawn < modTotal ? '<b>· showing ' + fmtN(modDrawn) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'spell' && !inSpells) {
        inSpells = true;
        html += '<div class="sf-sect">' + esc(sectionLabel()) +
          ' <b>' + fmtN(state.total) + '</b>' +
          (ui.plugin ? '<b>· in ' + esc(ui.plugin) + '</b>' : '') + '</div>';
      }
      if (r.kind === 'plug') html += plugRowHtml(r.p, ui.sel, idx);
      else if (r.kind === 'more') html += moreModsRowHtml(r.left, ui.sel, idx);
      else if (r.kind === 'spell') html += spellRowHtml(r.it, ui.sel, idx);
      idx++;
    });
    body.innerHTML = html;

    body.querySelectorAll('.sf-plug-row').forEach(function (row) {
      row.addEventListener('click', function () { setPlugin(row.getAttribute('data-plug')); });
    });
    const moreBtn = body.querySelector('.sf-plug-more');
    if (moreBtn) moreBtn.addEventListener('click', showMoreMods);
    body.querySelectorAll('.sf-row').forEach(function (row) {
      const id = row.getAttribute('data-id');
      function spell() {
        for (let i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
      }
      row.querySelectorAll('.sf-do').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (b.disabled || b.getAttribute('disabled') !== null) return;
          const it = spell();
          if (it) act(b.getAttribute('data-act'), it);
        });
      });
      const infoBtn = row.querySelector('.sf-info');
      if (infoBtn) infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleDetail(infoBtn.getAttribute('data-info'));
      });
      const plug = row.querySelector('.sf-meta-plug');
      if (plug) plug.addEventListener('click', function (e) {
        e.stopPropagation();
        setPlugin(plug.getAttribute('data-plug'));
      });
    });
  }

  function renderBodyPreservingScroll() {
    const body = $('sf-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('sf-body');
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

  let footEl = null;

  function footHost() {
    const pane = $('sf-pane');
    if (!pane) return null;
    if (!footEl) {
      footEl = document.createElement('div');
      footEl.className = 'sf-foot';
      footEl.id = 'sf-foot';
      const body = $('sf-body');
      if (body && body.nextSibling) pane.insertBefore(footEl, body.nextSibling);
      else pane.appendChild(footEl);
    }
    return footEl;
  }

  function footVisible() {
    if (!state.ready) return false;
    if (ui.type === 'mods') return false;
    if (!ui.q && !ui.plugin && ui.type === 'all') return false;
    return state.total > 0;
  }

  function renderFooter() {
    const foot = footHost();
    if (!foot) return;
    if (!footVisible()) { foot.classList.remove('sf-foot-on'); foot.innerHTML = ''; return; }

    const total = state.total | 0;
    const pc = pageCount();
    if (ui.page >= pc) ui.page = pc - 1;
    const first = total ? ui.page * ui.pageSize + 1 : 0;
    const last = Math.min(total, (ui.page + 1) * ui.pageSize);
    const multi = pc > 1;

    let html = '';
    if (multi) {
      html += '<button class="sf-foot-nav sf-foot-prev" ' + (ui.page <= 0 ? 'disabled ' : '') +
        'title="Previous page (PgUp)">‹ Prev</button>';
    }
    html += '<div class="sf-foot-count">Showing <b>' + fmtN(first) + '–' + fmtN(last) +
      '</b> of <b>' + fmtN(total) + '</b>' + (multi ? ' · page ' + (ui.page + 1) + ' of ' + pc : '') + '</div>';
    if (multi) {
      html += '<button class="sf-foot-nav sf-foot-next" ' + (ui.page >= pc - 1 ? 'disabled ' : '') +
        'title="Next page (PgDn)">Next ›</button>';
    }
    html += '<div class="sf-foot-per" title="How many spells to show per page">' +
      '<span class="sf-foot-per-lbl">Per page</span>' +
      PAGE_SIZES.map(function (n) {
        return '<button class="sf-foot-size' + (n === ui.pageSize ? ' sf-foot-size-on' : '') +
          '" data-size="' + n + '"' + (n === ui.pageSize ? ' aria-pressed="true"' : '') + '>' + n + '</button>';
      }).join('') + '</div>';
    foot.innerHTML = html;
    foot.classList.add('sf-foot-on');

    const prev = foot.querySelector('.sf-foot-prev');
    if (prev) prev.addEventListener('click', function () { if (!prev.disabled) gotoPage(ui.page - 1); });
    const next = foot.querySelector('.sf-foot-next');
    if (next) next.addEventListener('click', function () { if (!next.disabled) gotoPage(ui.page + 1); });
    foot.querySelectorAll('.sf-foot-size').forEach(function (b) {
      b.addEventListener('click', function () { changePageSize(parseInt(b.getAttribute('data-size'), 10)); });
    });
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('sf-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('sf-toast-err', !!err);
    t.classList.add('sf-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('sf-toast-show'); }, 2600);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    toGame('sfState');   // first call builds the C++ index; later calls refresh the target
    const s = $('sf-search');
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
    const s = $('sf-search');
    if (s) s.value = ui.q;
    if (state.ready) runQuery(true);
  }

  function init() {
    const s = $('sf-search');
    if (s) {
      s.setAttribute('aria-label', 'Search spells, powers and shouts');
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
            const el = document.querySelector('#sf-body .sf-sel');
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
        } else if (e.key === 'Backspace' && !s.value && ui.plugin) {
          clearPlugin();
          e.stopPropagation();
        }
      });
    }
    document.querySelectorAll('#sf-pane .fx-sw').forEach(function (b) {
      b.addEventListener('click', function () {
        const go = b.getAttribute('data-go');
        if (go !== 'spells' && typeof window.__hdFinderGo === 'function') window.__hdFinderGo(go, ui.q);
      });
    });

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_SPELLS = [
    { id: 'Skyrim.esm|012FCD', n: 'Flames', e: 'Flames', k: 'spell', s: 'destruction', el: 'fire', ar: '',
      t: 'novice', d: 'aimed', c: 'concentration', cost: 14, hs: true, kn: true, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|012FCC', n: 'Healing', e: 'Healing', k: 'spell', s: 'restoration', el: '', ar: '',
      t: 'novice', d: 'self', c: 'concentration', cost: 12, hs: false, kn: true, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|01A4CC', n: 'Fireball', e: 'Fireball', k: 'spell', s: 'destruction', el: 'fire', ar: '',
      t: 'adept', d: 'aimed', c: 'fire', cost: 133, hs: true, kn: false, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|013E09', n: 'Unrelenting Force', e: 'UnrelentingForce', k: 'shout', s: '', el: '', ar: '',
      t: '', d: 'aimed', c: 'fire', cost: 0, hs: true, kn: false, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|0E40C3', n: 'Nord Battle Cry', e: 'RaceNordPower', k: 'power', s: '', el: '', ar: 'fear',
      t: '', d: 'self', c: 'fire', cost: 0, hs: false, kn: true, p: 'Skyrim.esm' },
    { id: 'Skyrim.esm|0AA01F', n: 'Waterbreathing', e: 'AbWaterbreathing', k: 'ability', s: '', el: '', ar: '',
      t: '', d: 'self', c: 'constant', cost: 0, hs: false, kn: false, p: 'Skyrim.esm' },
  ];

  const DEV_DETAIL = {
    'Skyrim.esm|012FCD': { name: 'Flames', kind: 'spell', known: true, target: { name: 'Lydia', known: false, formId: '0x000A2C94' },
      edid: 'Flames', formId: '0x00012FCD', plugin: 'Skyrim.esm', school: 'destruction', tier: 'novice',
      delivery: 'aimed', casting: 'concentration', hostile: true, cost: 14, chargeTime: 0,
      effects: [{ n: 'Fire Damage', mag: 8, dur: 1, area: 0, hostile: true }],
      desc: 'A gout of fire that does 8 points per second. Targets on fire take extra damage.' },
    'Skyrim.esm|013E09': { name: 'Unrelenting Force', kind: 'shout', known: false, target: null,
      edid: 'UnrelentingForce', formId: '0x00013E09', plugin: 'Skyrim.esm', school: '', tier: '',
      delivery: 'aimed', casting: 'fire', hostile: true, cost: 0,
      words: [{ word: 'Fus', translation: 'Force', spell: 'Unrelenting Force 1', recovery: 15 },
        { word: 'Ro', translation: 'Balance', spell: 'Unrelenting Force 2', recovery: 20 },
        { word: 'Dah', translation: 'Push', spell: 'Unrelenting Force 3', recovery: 45 }],
      effects: [{ n: 'Unrelenting Force', mag: 5, dur: 0, area: 0, hostile: true }], desc: '' },
  };

  function devState() {
    window.sfStateResult({
      phase: 'ready', count: 9174, pageSize: ui.pageSize,
      target: { name: 'Lydia', formId: '0x000A2C94' },
      plugins: [
        { n: 'Skyrim.esm', c: 2010, k: 'esm', l: false },
        { n: 'Apocalypse - Magic of Skyrim.esp', c: 155, k: 'esp', l: false },
        { n: 'Dawnguard.esm', c: 288, k: 'esm', l: false },
      ],
    });
  }

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.detail) {
      const info = DEV_DETAIL[req.detail];
      window.sfResultData(info
        ? { seq: req.seq | 0, detail: req.detail, info: info }
        : { seq: req.seq | 0, detail: req.detail, info: {}, err: 'No dev detail fixture' });
      return;
    }
    const q = String(req.q || '').toLowerCase();
    const toks = q.split(/\s+/).filter(Boolean);
    const rows = DEV_SPELLS.filter(function (it) {
      if (req.plugin && it.p !== req.plugin) return false;
      if (req.type === 'spell' && it.k !== 'spell') return false;
      if (req.type === 'power' && !(it.k === 'power' || it.k === 'lesser' || it.k === 'voice')) return false;
      if (req.type === 'shout' && it.k !== 'shout') return false;
      if (req.type === 'ability' && it.k !== 'ability') return false;
      if (req.type === 'known' && !it.kn) return false;
      if (req.type === 'unknown' && it.kn) return false;
      const words = (it.k + ' ' + it.s + ' ' + it.el + ' ' + it.t + ' ' + it.d).toLowerCase();
      for (let i = 0; i < toks.length; i++) {
        if (it.n.toLowerCase().indexOf(toks[i]) === -1 &&
            it.e.toLowerCase().indexOf(toks[i]) === -1 &&
            words.indexOf(toks[i]) === -1 &&
            it.p.toLowerCase().indexOf(toks[i]) === -1) return false;
      }
      return true;
    });
    window.sfResultData({ seq: req.seq | 0, total: rows.length, offset: req.offset | 0,
      items: rows.slice(req.offset | 0, (req.offset | 0) + (req.limit || 60)) });
  }

  function devAct(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    let row = null;
    for (let i = 0; i < DEV_SPELLS.length; i++) if (DEV_SPELLS[i].id === req.id) row = DEV_SPELLS[i];
    if (!row) { window.sfActResult({ ok: false, act: req.act, msg: 'That spell is not in the load order any more' }); return; }
    if (req.act === 'learn') { row.kn = true; window.sfActResult({ ok: true, act: 'learn', msg: '✦ Learned ' + row.n }); return; }
    if (req.act === 'forget') { row.kn = false; window.sfActResult({ ok: true, act: 'forget', msg: 'Forgot ' + row.n }); return; }
    if (req.act === 'teach') { window.sfActResult({ ok: true, act: 'teach', msg: '✦ Lydia now knows ' + row.n }); return; }
    window.sfActResult({ ok: true, act: req.act, msg: 'Casting ' + row.n });
  }

  function selftest() {
    const out = [];
    const t = function (name, ok) { out.push((ok ? 'PASS  ' : 'FAIL  ') + name); };
    t('labelOf prefers the name', labelOf({ n: 'Flames', e: 'X' }) === 'Flames');
    t('an unknown spell wants Learn', primaryFor({ kn: false, k: 'spell' }) === 'learn');
    t('a known spell wants Cast', primaryFor({ kn: true, k: 'spell' }) === 'cast');
    t('a known ability wants nothing', primaryFor({ kn: true, k: 'ability' }) === '');
    t('page size snaps to a legal choice', clampPageSize(33) === 25);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'spells', label: 'Spells', tab: 'spells',
    setFilter: setFilter,
    index: function () {
      return [{
        label: 'Spell Finder',
        detail: 'Every spell, power and shout in the load order — learn, cast, or teach it to someone',
        kind: 'spells',
        keywords: 'spell spells magic power powers shout shouts thuum ability abilities learn teach cast tome spellbook destruction restoration alteration illusion conjuration fire frost shock find',
      }];
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _state: state, _ui: ui, _flatRows: flatRows, _modMatches: modMatches,
    _labelOf: labelOf, _chipsHtml: chipsHtml, _primaryFor: primaryFor,
    _pageCount: pageCount, _gotoPage: gotoPage, _changePageSize: changePageSize,
    _clampPageSize: clampPageSize, _footVisible: footVisible,
    _toggleDetail: toggleDetail, _detailInnerHtml: detailInnerHtml,
    _showsModSection: showsModSection, _act: act, _render: render,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.SpellsPane.init(); });
} else {
  window.SpellsPane.init();
}
