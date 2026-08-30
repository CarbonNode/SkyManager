'use strict';

/* ====================================================================== *
 *  Distributions — the SPID / SkyPatcher inspector (Rober, 2026-08-18:
 *  "hit f7 on an npc and inspect them for any SPID/SkyPatcher's that
 *  effect them (possible, equipment, outfits) and then show the items it
 *  could add in a searchable UI (like the finder tab)").
 *
 *  C++ (spid_inspect.cpp) owns the ini index (every enabled *_DISTR.ini +
 *  SkyPatcher/npc ini, read through the game's own VFS) and the filter
 *  evaluation against the crosshair NPC's base record. This pane owns the
 *  Finder-style bar, the group pills, the rows and the expansion detail.
 *
 *  HONESTY (the C++ contract, kept on screen): rows are the CANDIDATE POOL
 *  — lines whose filters this NPC passes. Chance is a per-NPC roll SPID
 *  made at load and of many matched outfits at most one is worn; filters
 *  we could not evaluate are badged on the row, never silently guessed.
 *
 *  Bridge — requests: dxState(json) · dxQuery(json)
 *  Replies (disjoint, per the deck law): dxStateResult({index,target|refuse})
 *  · dxResultData({seq,total,counts,rows}|{building:true}). Both are
 *  response-style (this pane always asks first), so no boot stub.
 *
 *  Host contract (mirrors ItemsPane): DistrPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.DistrPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  const DEBOUNCE_MS = 160;
  const POLL_MS = 700;          // while the C++ index is still parsing files
  const ROW_LIMIT = 300;
  /* Rober, 2026-08-19: "we definetly want to add pagination, so not everything
     trys to do a mesh render storm for the thumbnails."
     ONE page is on screen, and visibleArtSpecs() asks for art for THAT PAGE
     ONLY — which is the whole point. Before this, 190 matched rows meant 190
     mesh-render requests queued at once and the thumbnail you were looking at
     sat behind 150 you were not. */
  const PAGE_SIZE = 40;

  /* group pills — ids are the C++ `group` field; counts ride each reply.
     Plain typographic marks only (no colour emoji — the deck law). */
  const GROUPS = [
    ['all',     'All',      '⌕'],
    ['outfit',  'Outfits',  '▥'],
    ['item',    'Items',    '⚒'],
    ['spell',   'Spells',   '✦'],
    ['perk',    'Perks',    '★'],
    ['keyword', 'Keywords', '◈'],
    ['other',   'Other',    '≡'],
  ];

  /* ============================================================== state == */

  const state = {
    blocked: Object.create(null),   // 'plugin|hex' -> true, for the target NPC
    rules: [],                      // every block for this NPC, liftable even when unmatched
    index: { state: 'idle' },
    target: null,
    refuse: null,
    seq: 0,
    rows: [],
    counts: {},
    total: 0,
    shown: 0,
    unevaluated: 0,
    undecided: 0,
    awaiting: false,
    building: false,
  };

  const ui = {
    q: '',
    group: 'all',
    visible: false,
    debT: null,
    pollT: null,
    expanded: -1,     // index into state.rows; one open detail at a time
    page: 0,          // current page of the sorted sequence
    byMod: true,      // group the list under its source ini (Rober, 2026-08-19)
    closed: {},       // ini file name -> true when its group is collapsed
    lvlQ: {},         // leveled-list key -> its own filter text
    sort: 'match',    // match | name | chance | source
    showRules: false, // the blocks manager panel
    /* Pinned target — set by the F7 NPC card's Distr button (openFor), so the
       pane inspects THAT person rather than the crosshair snapshot. One visit
       only: cleared on hide, so a later direct tab click is crosshair again. */
    pinRef: '',
    pinName: '',
  };

  /* ============================================================ helpers == */

  function $(id) { return document.getElementById(id); }

  /* The hud.js law: never null-deref a getElementById — a skeleton older than
     this script draws nothing instead of killing the shared renderer. */
  function need(id) { return $(id) || document.createElement('div'); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'dxState') setTimeout(devState, 30);
      if (DEV && fn === 'dxQuery') setTimeout(function () { devQuery(arg); }, 30);
    }
  }

  window.dxStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.index = (d.index && typeof d.index === 'object') ? d.index : { state: 'idle' };
    state.target = (d.target && typeof d.target === 'object') ? d.target : null;
    askBlocks();   // badge the rows with what is already blocked for this person
    state.refuse = (d.refuse && typeof d.refuse === 'object') ? d.refuse : null;
    if (state.index.state === 'building') armPoll();
    if (ui.visible) render();
  };

  /* dxLeveledData — the expansion of ONE leveled list, keyed by the durable
     pair we asked with. Cached for the session: a leveled list cannot change
     mid-game, and re-walking it on every re-render would put a main-thread form
     walk behind a UI repaint. */
  const lvlCache = Object.create(null);
  const lvlPending = Object.create(null);

  function lvlKey(formId, plugin) {
    return String(plugin || '').toLowerCase() + '|' + String(formId || '').toLowerCase();
  }

  window.dxLeveledData = function (d) {
    let o = d;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    if (!o) return;
    const root = o.root || {};
    const k = lvlKey(root.formId, root.plugin);
    delete lvlPending[k];
    lvlCache[k] = o.ok ? root : { failed: true, why: o.why || 'could not expand that list' };
    renderBody();
    if (artGroup) artGroup.schedule();
  };

  /* Open one distribution ini on the PC. C++ resolves the REAL path (the path we
     scanned is a VFS one and means nothing to the shell) and reports back. */
  function openIni(file) {
    if (!file) return;
    toGame('dxOpenFile', JSON.stringify({ file: file }));
  }
  window.dxReportResult = function (d) {
    let j = d;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = null; } }
    /* Re-render restores the button from its "Writing…" state whatever happened,
       so a failure never leaves a dead control. */
    if (ui.visible) renderHead();
    if (!j) return;
    if (typeof toast === 'function') {
      toast(j.ok
        ? ('Report on your Desktop — ' + (j.matched | 0) + ' matched, ' +
           (j.undecided | 0) + ' unjudged')
        : ('Could not write the report — ' + (j.why || 'unknown reason')));
    }
  };

  window.dxOpenResult = function (d) {
    let j = d;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = null; } }
    if (!j) return;
    if (typeof toast === 'function') {
      toast(j.ok ? ('Opened ' + (j.path || 'the file'))
                 : ('Could not open it — ' + (j.why || 'unknown reason')));
    }
  };

  function askLeveled(formId, plugin) {
    const k = lvlKey(formId, plugin);
    if (lvlCache[k] || lvlPending[k]) return;
    lvlPending[k] = true;
    toGame('dxLeveled', JSON.stringify({ formId: formId, plugin: plugin }));
  }

  /* ---------------------------------------------------------- blocks ----
     "blacklist entire npc from all spid … or a specific outfit from this npc".

     SPID distributes once, at load, and nothing un-distributes — so the only
     honest lever is to take the specific thing back off the specific person on
     every sweep. That is what No Auto-Gear already does for a whole plugin, so
     a block is the same machine given an exact form instead of a mod name,
     rather than a second system that could disagree with the first.

     ⚠ It cannot cover KEYWORDS: a keyword added to a base form has nowhere to
     be taken back from. The pane says so on those rows rather than offering a
     button that would quietly do nothing. */
  const BLOCKABLE = { item: 1, outfit: 1, spell: 1, perk: 1 };

  window.dxBlocksData = function (d) {
    let o = d;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    if (!o || !o.ok) return;
    state.blocked = Object.create(null);
    const list = Array.isArray(o.blocked) ? o.blocked : [];
    for (let i = 0; i < list.length; i++) state.blocked[String(list[i]).toLowerCase()] = true;
    state.rules = Array.isArray(o.rules) ? o.rules : [];
    render();          // the head carries the count and the manager
  };

  window.dxBlockResult = function (d) {
    let o = d;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    if (o && o.msg && window.hdToast) window.hdToast(o.msg, o.ok === false);
  };

  /* The config spells an identity "plugin|hex-no-padding", lowercased — the same
     shape KeyOf() builds in C++. Getting this wrong would badge nothing and look
     like the block never saved. */
  function blockKey(plugin, formId) {
    let hex = String(formId || '').toLowerCase();
    if (hex.indexOf('0x') === 0) hex = hex.slice(2);
    hex = hex.replace(/^0+/, '') || '0';
    return String(plugin || '').toLowerCase() + '|' + hex;
  }

  function isBlocked(plugin, formId) {
    return !!state.blocked[blockKey(plugin, formId)];
  }

  function askBlocks() {
    const t = state.target;
    if (!t || !t.formId || !t.plugin) return;
    toGame('dxBlocks', JSON.stringify({ npc: { formId: t.formId, plugin: t.plugin } }));
  }

  function sendBlock(forms, on) {
    const t = state.target;
    if (!t || !t.formId || !t.plugin || !forms.length) return;
    toGame('dxBlock', JSON.stringify({
      npc: { formId: t.formId, plugin: t.plugin, name: t.name || '' },
      forms: forms,
      on: !!on,
    }));
  }

  /* Every form a row would actually hand over: the row's own form, or an
     outfit's pieces — blocking the OUTFIT record would do nothing, because what
     lands in her inventory is the pieces. */
  function formsOfRow(r) {
    const out = [];
    if (r.group === 'outfit') {
      const its = Array.isArray(r.items) ? r.items : [];
      for (let i = 0; i < its.length; i++)
        if (its[i].formId && its[i].plugin)
          out.push({ formId: its[i].formId, plugin: its[i].plugin, name: its[i].name || '' });
      return out;
    }
    if (r.formId && r.plugin)
      out.push({ formId: r.formId, plugin: r.plugin, name: r.label || '' });
    return out;
  }

  function rowBlocked(r) {
    const fs = formsOfRow(r);
    if (!fs.length) return false;
    for (let i = 0; i < fs.length; i++) if (!isBlocked(fs[i].plugin, fs[i].formId)) return false;
    return true;
  }

  window.dxResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ((d.seq | 0) !== state.seq) return;   // stale reply from an older keystroke
    if (d.building) { state.building = true; armPoll(); if (ui.visible) render(); return; }
    state.building = false;
    state.awaiting = false;
    if (d.refuse && typeof d.refuse === 'object') {
      state.refuse = d.refuse;
      state.rows = []; state.total = 0; state.shown = 0;
      if (ui.visible) render();
      return;
    }
    state.refuse = null;
    state.total = d.total | 0;
    state.shown = d.shown | 0;
    state.unevaluated = d.unevaluated | 0;
    state.undecided = d.undecided | 0;
    state.counts = (d.counts && typeof d.counts === 'object') ? d.counts : {};
    state.rows = Array.isArray(d.rows) ? d.rows : [];
    ui.expanded = -1;
    if (ui.visible) render();
  };

  /* every request carries the pin when one is set — state and query must agree
     on who is being inspected or the header names one person and the rows
     another. */
  function reqBase(extra) {
    const r = extra || {};
    r.seq = state.seq;
    if (ui.pinRef) r.ref = ui.pinRef;
    return r;
  }

  function armPoll() {
    if (ui.pollT || !ui.visible) return;
    ui.pollT = setTimeout(function () {
      ui.pollT = null;
      if (!ui.visible) return;
      toGame('dxState', JSON.stringify(reqBase()));
      runQuery(false);
    }, POLL_MS);
  }

  function runQuery(bump) {
    ui.page = 0;   // a new result set always starts at its first page
    if (bump !== false) state.seq++;
    state.awaiting = true;
    toGame('dxQuery', JSON.stringify(reqBase({
      q: ui.q, group: ui.group, limit: ROW_LIMIT,
    })));
  }

  function queryDebounced() {
    if (ui.debT) clearTimeout(ui.debT);
    ui.debT = setTimeout(function () { ui.debT = null; state.seq++; runQuery(false); }, DEBOUNCE_MS);
  }

  /* =============================================================== icons == */
  /* ALL art goes through HDArt (the deck law): item/outfit rows show the real
     mesh render of the distributed thing (or its first piece); everything else
     keeps a glyph. A harness with no HDArt shows glyphs. */

  /* proven-in-game marks only (the ◂▸⊘-rendered-as-specks law). '·' was the
     first choice for other/Patch and read as an EMPTY plate in the audit
     screenshots — '≡' (proven in followers/quests) reads as "a patch line". */
  const GLYPH = { outfit: '▥', item: '⚒', spell: '✦', perk: '★', keyword: '◈', other: '≡' };

  /* Which HDArt lane a row's art comes from. Spells, perks and shouts are the
     SPELL family — stock art matched by form, then by category — while items and
     outfit pieces are rendered meshes. Getting this wrong is not a downgrade, it
     is a miss: HDArt looks in a different index per kind.

     ⚠ This returned null for everything except item/outfit until 2026-08-19, so
     a spell row never ASKED for art and every one of them wore the ✦ fallback
     glyph. Rober: "show what the spell icon would be? not just an emoji". The
     art was always there — nothing was requesting it. */
  const ART_KIND = { item: 'item', outfit: 'item', spell: 'spell', perk: 'spell', keyword: 'spell' };

  function rowArtId(r) {
    if (!r) return null;
    const kind = ART_KIND[r.group];
    if (!kind) return null;
    if (r.formId && r.plugin && r.group !== 'outfit')
      return { formId: r.formId, plugin: r.plugin, name: r.label, kind: kind };
    if (r.group === 'outfit') {
      const its = Array.isArray(r.items) ? r.items : [];
      for (let i = 0; i < its.length; i++)
        if (its[i].formId && its[i].plugin)
          return { formId: its[i].formId, plugin: its[i].plugin, name: its[i].name, kind: 'item' };
    }
    return null;
  }

  function artSpec(x) {
    const kind = x.kind || 'item';
    return { kind: kind, formId: x.formId, plugin: x.plugin, name: x.name || '',
             glyph: kind === 'spell' ? '✦' : '⚒' };
  }

  function artOf(x) {
    if (!x || !window.HDArt) return null;
    const a = HDArt.for(artSpec(x));
    return (a && a.src) ? a : null;
  }

  /* ⛔ THE PAGE, never the whole result set. This walked all of state.rows
     until 2026-08-19, so opening the tab on a well-distributed NPC queued a
     mesh render for every match at once — the "render storm" Rober named. A
     render is minutes of work per item; asking for 190 to fill 40 rows is how
     the thumbnail you are looking at ends up behind 150 you are not. */
  /* Rober, 2026-08-19: "a lot of the thumbnails seem to never populate or have
     nothing to populate as not sure how to best handle this."
     HDArt already answers this — `state` is 'ready' | 'rendering' | 'none', and
     'none' names a record that can NEVER produce a picture. artOf() threw all of
     that away and returned null for both cases, so a permanently un-renderable
     row wore "Render queued…" forever. Three states, three different things to
     say. */
  function artState(x) {
    if (!x || !window.HDArt) return 'none';
    try {
      const a = HDArt.for(artSpec(x));
      if (a && a.src) return 'ready';
      return (a && a.state === 'rendering') ? 'rendering' : 'none';
    } catch (e) { return 'none'; }
  }

  function visibleArtSpecs() {
    const out = [];
    const seq = pageIdx();
    for (let n2 = 0; n2 < seq.length; n2++) {
      const i = seq[n2];
      const id = rowArtId(state.rows[i]);
      if (id) out.push(artSpec(id));
      if (ui.expanded === i) {
        const its = Array.isArray(state.rows[i].items) ? state.rows[i].items : [];
        for (let k = 0; k < its.length; k++)
          if (its[k].formId && its[k].plugin) out.push(artSpec(its[k]));
      }
    }
    return out;
  }

  /* Art landing used to call renderBody(), which rebuilt every row's innerHTML,
     re-attached a listener per row and then restored scrollTop to hide the
     damage. That was affordable when the list was flat; grouping made the DOM
     bigger and the renders arrive in batches, so the pane was rebuilding itself
     several times a second while the queue drained.

     Now each art slot carries data-art="plugin|formId|kind" and landing only
     fills the slots that just became available — no rebuild, no scroll restore,
     no listener churn. */
  function artKeyOf(x) {
    return String(x.plugin || '') + '|' + String(x.formId || '') + '|' + (x.kind || 'item');
  }

  function paintArt(scope) {
    const root = scope || $('dx-body');
    if (!root) return;
    const slots = root.querySelectorAll('[data-art]');
    for (let i = 0; i < slots.length; i++) {
      const el = slots[i];
      if (el.querySelector('img')) continue;          // already painted
      const parts = String(el.getAttribute('data-art') || '').split('|');
      const a = artOf({ plugin: parts[0], formId: parts[1], kind: parts[2] });
      if (!a || !a.src) continue;
      const img = document.createElement('img');
      img.className = el.classList.contains('dx-plate') ? 'dx-art' : 'dx-item-art';
      img.alt = '';
      img.draggable = false;
      /* Same degrade law as the markup path: a file that 404s drops the img and
         the plate's has-art class, revealing the glyph underneath. */
      img.onerror = function () {
        img.remove();
        el.classList.remove('dx-has-art');
        el.classList.add('dx-pending');
      };
      img.src = a.src;
      if (el.classList.contains('dx-plate')) {
        el.classList.add('dx-has-art');
        el.classList.remove('dx-pending');
        el.removeAttribute('title');
      }
      el.insertBefore(img, el.firstChild);
    }
  }

  function onArtLanded() {
    if (!ui.visible) return;
    paintArt();
  }

  const artGroup = window.HDArt ? HDArt.group('distr', {
    visible: function () { return ui.visible; },
    specs: visibleArtSpecs,
    onLand: onArtLanded,
  }) : null;

  /* ============================================================== render == */

  function render() {
    renderHead();
    renderPills();
    renderBody();
    renderFoot();
    if (artGroup) artGroup.schedule();
  }

  function chipHtml(text, cls) {
    return '<span class="dx-chip ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function renderHead() {
    const t = state.target;
    const chip = need('dx-count-chip');
    chip.textContent = state.total > 0
      ? (state.total + ' match' + (state.total === 1 ? '' : 'es'))
      : '';
    const el = need('dx-target');
    if (!t) { el.innerHTML = ''; return; }
    let h = '<span class="dx-t-name">' + esc(t.name || 'Someone') + '</span>';
    if (t.formId && t.plugin) {
      h += '<button class="dx-blockall" data-blockall="1" ' +
        'title="Block everything currently listed — every item, outfit piece, spell and perk ' +
        'shown below is taken back off her on each sweep. Keywords cannot be blocked.">' +
        'Block all shown</button>';
      /* Counted from the RULES, not from matched rows: a block on something that
         no longer matches is still in force, and hiding it was the one way this
         feature could trap you — a rule you cannot see is a rule you cannot
         lift. Clicking opens the manager, which lists every one of them. */
      const n = (state.rules || []).length;
      if (n) h += '<button class="dx-rules-btn' + (ui.showRules ? ' dx-rules-on' : '') + '" ' +
        'data-rules="1" title="Every block in force for this person — lift any of them here, ' +
        'including ones nothing below currently matches">' + n + ' blocked</button>';
    }
    /* Rober, 2026-08-20: "drop a spid report to desktop". Lives beside the
       target because the report is ABOUT this person — and it carries the
       things this list cannot: the raw ini lines, the leveled-list contents,
       and the lines we rejected without understanding. */
    h += '<button class="dx-report-btn" data-report="1" ' +
      'title="Write a full diagnostic report for this NPC to your Desktop — every matched ' +
      'line with the raw ini text, what each leveled list can actually roll, her resolved ' +
      'race/class/keywords/factions, and the lines that could not be judged">Report →</button>';
    const bits = [];
    if (t.race) bits.push(esc(t.race));
    if (t.sex) bits.push(esc(t.sex));
    if (typeof t.level === 'number') bits.push('L' + t.level);
    if (t.plugin) bits.push(esc(t.plugin));
    if (bits.length) h += '<span class="dx-t-meta">' + bits.join(' · ') + '</span>';
    if (t.outfitNow) h += chipHtml('wearing: ' + t.outfitNow, 'dx-chip-now');
    el.innerHTML = h;
    /* Bound after every head render because renderHead replaces this subtree —
       cheap (one button), unlike the row list which is delegated. */
    const rb = el.querySelector('[data-rules]');
    if (rb) rb.addEventListener('click', function () {
      ui.showRules = !ui.showRules;
      render();
    });
    const rep = el.querySelector('[data-report]');
    if (rep) rep.addEventListener('click', function () {
      if (rep.disabled) return;
      rep.disabled = true;
      rep.textContent = 'Writing…';
      toGame('dxReport', JSON.stringify(reqBase({})));
    });
    const ba = el.querySelector('[data-blockall]');
    if (ba) ba.addEventListener('click', function () {
      const forms = [];
      const seen = Object.create(null);
      for (let i = 0; i < state.rows.length; i++) {
        const r = state.rows[i];
        if (!BLOCKABLE[r.group]) continue;
        const fs = formsOfRow(r);
        for (let k = 0; k < fs.length; k++) {
          const key = blockKey(fs[k].plugin, fs[k].formId);
          if (seen[key]) continue;
          seen[key] = 1;
          forms.push(fs[k]);
        }
      }
      if (forms.length) sendBlock(forms, true);
    });
  }

  /* The pager. Always drawn when there is more than one page, and it states the
     row range rather than only a page number — "41-80 of 190" answers "how much
     is left" without arithmetic. */
  function pagerHtml() {
    const n = pageCount();
    if (n <= 1) return '';
    clampPage();
    const from = ui.page * PAGE_SIZE + 1;
    const to = Math.min(state.rows.length, (ui.page + 1) * PAGE_SIZE);
    let h = '<div class="dx-pager">';
    h += '<button class="dx-pg" data-pg="prev" type="button"' +
      (ui.page === 0 ? ' disabled' : '') + '>\u2039 Prev</button>';
    h += '<span class="dx-pg-at">' + from + '\u2013' + to + ' of ' + state.rows.length +
      '<span class="dx-pg-sub">page ' + (ui.page + 1) + ' of ' + n + '</span></span>';
    h += '<button class="dx-pg" data-pg="next" type="button"' +
      (ui.page >= n - 1 ? ' disabled' : '') + '>Next \u203a</button>';
    h += '</div>';
    return h;
  }

  function renderPills() {
    const el = need('dx-pills');
    const c = state.counts || {};
    let h = '';
    for (let i = 0; i < GROUPS.length; i++) {
      const [id, label, glyph] = GROUPS[i];
      const n = c[id] | 0;
      /* an empty group's pill stays, dimmed — a vanished control reads as broken */
      h += '<button class="dx-pill' + (ui.group === id ? ' dx-pill-on' : '') +
        (n === 0 && id !== 'all' ? ' dx-pill-dim' : '') + '" data-group="' + id + '">' +
        '<span class="dx-pill-glyph">' + glyph + '</span>' + esc(label) +
        (id === 'all' ? (c.all ? ' <span class="dx-pill-n">' + (c.all | 0) + '</span>' : '')
                      : (n ? ' <span class="dx-pill-n">' + n + '</span>' : '')) +
        '</button>';
    }
    /* Grouping is a VIEW choice, not a filter, so it sits apart from the group
       pills behind a divider and carries its own handler — a shared one would
       read data-group off it and reset the filter to 'all'. */
    h += '<span class="dx-pill-sep"></span>' +
      '<button class="dx-pill dx-pill-tog' + (ui.byMod ? ' dx-pill-on' : '') + '" data-tog="bymod" ' +
      'title="Group the matched lines under the ini that carries them">' +
      '<span class="dx-pill-glyph">≡</span>By mod</button>';
    /* Collapse-all earns its place the moment grouping does: a dozen inis is a
       lot of scrolling to reach the one you came for. Only offered while
       grouped, because it means nothing to a flat list. */
    if (ui.byMod) {
      const anyOpen = groupsOf(state.rows).some(function (g) { return !ui.closed[g.file]; });
      h += '<button class="dx-pill dx-pill-tog" data-tog="foldall" ' +
        'title="' + (anyOpen ? 'Collapse every group' : 'Expand every group') + '">' +
        '<span class="dx-pill-glyph">' + (anyOpen ? '▲' : '▼') + '</span>' +
        (anyOpen ? 'Fold all' : 'Unfold all') + '</button>';
    }
    const SORTS = [['match', 'Best match'], ['name', 'Name'], ['chance', 'Likeliest'], ['source', 'By file']];
    h += '<span class="dx-pill-sep"></span>';
    for (let si = 0; si < SORTS.length; si++)
      h += '<button class="dx-pill dx-pill-sort' + (ui.sort === SORTS[si][0] ? ' dx-pill-on' : '') +
        '" data-sort="' + SORTS[si][0] + '" title="Sort the list">' + SORTS[si][1] + '</button>';
    el.innerHTML = h;
    el.querySelectorAll('.dx-pill[data-group]').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.group = b.getAttribute('data-group') || 'all';
        ui.expanded = -1;
        runQuery();
        render();
      });
    });
    el.querySelectorAll('.dx-pill[data-tog]').forEach(function (b) {
      b.addEventListener('click', function () {
        const what = b.getAttribute('data-tog');
        if (what === 'bymod') {
          ui.byMod = !ui.byMod;
        } else if (what === 'foldall') {
          const groups = groupsOf(state.rows);
          const anyOpen = groups.some(function (g) { return !ui.closed[g.file]; });
          ui.closed = Object.create(null);
          if (anyOpen) for (let i = 0; i < groups.length; i++) ui.closed[groups[i].file] = true;
        }
        ui.expanded = -1;
        ui.page = 0;
        render();
        if (artGroup) artGroup.schedule();
      });
    });
    el.querySelectorAll('.dx-pill[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.sort = b.getAttribute('data-sort') || 'match';
        ui.expanded = -1;
        ui.page = 0;
        render();
        if (artGroup) artGroup.schedule();
      });
    });
  }

  function srcBadge(r) {
    return r.src === 'sky'
      ? '<span class="dx-src dx-src-sky" title="A SkyPatcher npc patch line">SkyPatcher</span>'
      : '<span class="dx-src dx-src-spid" title="A SPID _DISTR.ini line">SPID</span>';
  }

  function itemsHtml(r, full) {
    const its = Array.isArray(r.items) ? r.items : [];
    if (!its.length) return '';
    const cap = full ? its.length : 4;
    let h = '<div class="dx-items">';
    for (let i = 0; i < Math.min(cap, its.length); i++) {
      const it = its[i];
      const art = (full && it.formId && it.plugin) ? artOf(it) : null;
      /* bare ERR: on a missing file the img just drops and the chip stays
         text-only — the chip has no has-art class to clear. The data-art slot
         lets a later render land here without rebuilding the row. */
      const slot = (full && it.formId && it.plugin)
        ? ' data-art="' + esc(artKeyOf({ plugin: it.plugin, formId: it.formId, kind: 'item' })) + '"' : '';
      h += '<span class="dx-item"' + slot + ' title="' + esc(it.name) + '">' +
        (art ? '<img class="dx-item-art" src="' + esc(art.src) + '" alt="" draggable="false"' +
               (window.HDArt ? HDArt.ERR : '') + '>' : '') +
        esc(it.name) + (it.count > 1 ? ' ×' + it.count : '') + '</span>';
    }
    const more = (r.itemsMore | 0) + Math.max(0, its.length - cap);
    if (more > 0) h += '<span class="dx-item dx-item-more">+' + more + ' more</span>';
    h += '</div>';
    return h;
  }

  function opsHtml(r) {
    const ops = Array.isArray(r.ops) ? r.ops : [];
    if (!ops.length) return '';
    let h = '<div class="dx-ops">';
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let v = '';
      if (Array.isArray(op.items) && op.items.length) {
        v = op.items.map(function (it) {
          return esc(it.name) + (it.count > 1 ? ' ×' + it.count : '');
        }).join(', ');
      } else {
        v = esc(op.v);
      }
      h += '<span class="dx-op" title="' + esc(op.k) + '=' + esc(op.v) + '">' +
        '<span class="dx-op-k">' + esc(op.label || op.k) + '</span> ' + v + '</span>';
    }
    h += '</div>';
    return h;
  }

  function rowHtml(r, i) {
    const artId = rowArtId(r);
    const art = artId ? artOf(artId) : null;
    const open = ui.expanded === i;
    let h = '<div class="dx-row' + (open ? ' dx-open' : '') + '" data-i="' + i + '">';
    h += '<div class="dx-row-line">';
    /* The glyph ALWAYS renders under the art, so errFor('dx-has-art') — which
       drops the img and the plate's has-art class on a missing file — reveals
       it instead of leaving an empty plate (the HDArt degrade law; the class
       handed to errFor is the PARENT plate's, never the img's own). */
    /* No art + a resolvable form = the render queue simply has not reached it
       yet (renders are paced while the game is unpaused, then kept forever).
       Saying so is the difference between "loading" and "broken" — Rober asked
       "why did only 1 render?" of a row where nothing had failed at all. */
    /* 'rendering' = the queue has not reached it yet (temporary, say so);
       'none' = this record has nothing to render, EVER — say that instead, so
       the glyph reads as the final answer rather than a stuck spinner. */
    const aState = artId ? artState(artId) : 'none';
    const pending = !art && aState === 'rendering';
    const noArt = !art && aState === 'none';
    h += '<span class="dx-plate' + (art ? ' dx-has-art' : '') + (pending ? ' dx-pending' : '') +
      (noArt ? ' dx-noart' : '') + '"' +
      (artId ? ' data-art="' + esc(artKeyOf(artId)) + '"' : '') +
      (pending ? ' title="Render queued — it appears once the renderer reaches it, then stays"' :
       noArt ? ' title="No preview — this record has no mesh to render"' : '') + '>' +
      '<span class="dx-glyph">' + (GLYPH[r.group] || '·') + '</span>' +
      (art ? '<img class="dx-art" src="' + esc(art.src) + '" alt="" draggable="false"' +
             (window.HDArt ? HDArt.errFor('dx-has-art') : '') + '>' : '') + '</span>';
    h += '<span class="dx-main"><span class="dx-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
      '<span class="dx-sub" title="' + esc(r.file) + ' · line ' + (r.line | 0) + '">' +
      esc(r.type) + ' · ' + esc(r.file) + ':' + (r.line | 0) + '</span></span>';
    h += '<span class="dx-right">';
    if (r.unresolvedForm) h += chipHtml('not in load order', 'dx-chip-warn');
    if (Array.isArray(r.uncertain) && r.uncertain.length)
      h += chipHtml('~' + r.uncertain.length + ' unchecked', 'dx-chip-unc');
    if (r.src === 'spid' && typeof r.chance === 'number' && r.chance < 100)
      h += chipHtml(r.chance + '% chance', 'dx-chip-chance');
    /* A keyword has nowhere to be taken back FROM, so there is no honest button
       to offer — say why instead of shipping one that does nothing. */
    if (BLOCKABLE[r.group] && formsOfRow(r).length) {
      const on = rowBlocked(r);
      h += '<button class="dx-block' + (on ? ' dx-block-on' : '') + '" data-block="' + i + '" ' +
        'title="' + (on
          ? 'Blocked for this person — taken back off her on every sweep. Click to lift.'
          : 'Never let this person keep this. SPID still hands it over at load; it is removed after.') +
        '">' + (on ? 'Blocked' : 'Block') + '</button>';
    } else if (r.group === 'keyword') {
      h += '<span class="dx-chip dx-chip-unc" title="A keyword is written onto the base form at load. ' +
        'There is nothing to take back off her, so this cannot be blocked.">keyword</span>';
    }
    h += srcBadge(r);
    h += '<span class="dx-caret">' + (open ? '▲' : '▼') + '</span>';
    h += '</span></div>';
    if (!open) {
      h += itemsHtml(r, false);
    } else {
      h += '<div class="dx-detail">';
      h += itemsHtml(r, true);
      /* Only asked for on EXPAND: walking a leveled list touches live forms on
         the main thread, so 57 collapsed rows must not each trigger one. */
      h += leveledHtml(r);
      h += opsHtml(r);
      const fl = Array.isArray(r.filters) ? r.filters : [];
      if (fl.length) {
        h += '<div class="dx-filters">';
        for (let k = 0; k < fl.length; k++)
          h += '<span class="dx-filter" title="' + esc(fl[k].k) + ': ' + esc(fl[k].v) + '">' +
            '<span class="dx-filter-k">' + esc(fl[k].k) + '</span> ' + esc(fl[k].v) + '</span>';
        h += '</div>';
      }
      if (Array.isArray(r.uncertain) && r.uncertain.length) {
        h += '<div class="dx-unc-list">';
        for (let k = 0; k < r.uncertain.length; k++)
          h += '<div class="dx-unc-line">~ ' + esc(r.uncertain[k]) + '</div>';
        h += '</div>';
      }
      h += '<div class="dx-fileline">' + esc(r.file) + ' · line ' + (r.line | 0) + '</div>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  /* ===================================================== group by source ==
     Rober, 2026-08-19: "can the distributions page be a little easier to
     navigate, like group or sort by mod?" — and then "like source mod that is
     … this specific spid adds items from these 3 esps".

     A SPID ini IS the mod for this purpose: the file name is what a user
     recognises and what they would go and disable. So rows collect under their
     ini, and each header states what that file is DOING to this NPC — how many
     lines matched and which plugins the forms it hands out actually come from.
     That second part is the question "who is doing this to my follower?", and
     it is free: every resolved row already carries the plugin of the form it
     distributes.

     Row indices stay the ORIGINAL positions in state.rows, because the click
     handler and ui.expanded are keyed on them; grouping only reorders the HTML. */
  /* Sorting reorders a list of INDICES, never state.rows itself — ui.expanded
     and every click handler are keyed on the original position, so mutating the
     array would silently open the wrong row. Same discipline as the grouping. */
  function sortedIdx() {
    const idx = [];
    for (let i = 0; i < state.rows.length; i++) idx.push(i);
    const R = state.rows;
    const by = ui.sort;
    if (by === 'match') return idx;      // the order C++ ranked them in
    const cmp = {
      name: function (a, b) {
        return String(R[a].label || '').toLowerCase() < String(R[b].label || '').toLowerCase() ? -1 : 1;
      },
      // Likeliest first: what she is most going to end up with.
      chance: function (a, b) {
        const ca = typeof R[a].chance === 'number' ? R[a].chance : 100;
        const cb = typeof R[b].chance === 'number' ? R[b].chance : 100;
        return cb - ca;
      },
      source: function (a, b) {
        const fa = String(R[a].file || '').toLowerCase(), fb = String(R[b].file || '').toLowerCase();
        if (fa !== fb) return fa < fb ? -1 : 1;
        return (R[a].line | 0) - (R[b].line | 0);
      },
    }[by];
    return cmp ? idx.sort(cmp) : idx;
  }

  /* The ordered indices for the CURRENT PAGE. One source of truth: the flat
     list, the grouped list and the art request all read this, so what is asked
     for can never drift from what is on screen. */
  function pageIdx() {
    const seq = sortedIdx();
    const from = ui.page * PAGE_SIZE;
    return seq.slice(from, from + PAGE_SIZE);
  }
  function pageCount() {
    return Math.max(1, Math.ceil(state.rows.length / PAGE_SIZE));
  }
  function clampPage() {
    const n = pageCount();
    if (ui.page >= n) ui.page = n - 1;
    if (ui.page < 0) ui.page = 0;
  }
  function gotoPage(n) {
    ui.page = n;
    clampPage();
    ui.expanded = -1;
    render();
    const b = $('dx-body');
    if (b) b.scrollTop = 0;
    if (artGroup) artGroup.schedule();
  }

  function groupsOf(rows) {
    const order = [];
    const by = Object.create(null);
    const seq = sortedIdx();
    for (let n = 0; n < seq.length; n++) {
      const i = seq[n];
      const r = rows[i];
      const f = r.file || '(unknown file)';
      if (!by[f]) { by[f] = { file: f, idx: [], plugins: Object.create(null), src: r.src }; order.push(f); }
      const g = by[f];
      g.idx.push(i);
      if (r.plugin) g.plugins[r.plugin] = true;
      const its = Array.isArray(r.items) ? r.items : [];
      for (let k = 0; k < its.length; k++) if (its[k].plugin) g.plugins[its[k].plugin] = true;
    }
    return order.map(function (f) { return by[f]; });
  }

  function pluginLine(g) {
    const names = Object.keys(g.plugins).sort(function (a, b) {
      return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
    });
    if (!names.length) return '';
    const show = names.slice(0, 3).join(' · ');
    return '<span class="dx-g-plugins" title="' + esc(names.join('\n')) + '">from ' + esc(show) +
      (names.length > 3 ? ' <span class="dx-g-more">+' + (names.length - 3) + '</span>' : '') + '</span>';
  }

  function groupedHtml() {
    const groups = groupsOf(state.rows);
    /* Grouping is a VIEW of the same paged sequence, not an escape from it —
       otherwise "By mod" would quietly re-introduce the render storm pagination
       exists to stop. A group with nothing on this page is skipped entirely;
       its header would be a lie about what is below it. */
    const onPage = Object.create(null);
    const seq = pageIdx();
    for (let n = 0; n < seq.length; n++) onPage[seq[n]] = 1;
    let h = '';
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const pageIds = g.idx.filter(function (i) { return onPage[i]; });
      if (!pageIds.length) continue;
      const shut = !!ui.closed[g.file];
      h += '<div class="dx-group' + (shut ? ' dx-g-shut' : '') + '">';
      h += '<div class="dx-g-head" data-file="' + esc(g.file) + '">' +
        '<span class="dx-g-caret">▼</span>' +
        '<span class="dx-g-name" title="' + esc(g.file) + '">' + esc(g.file) + '</span>' +
        '<span class="dx-g-n" title="' +
          (pageIds.length === g.idx.length
            ? esc(g.idx.length + ' matched line(s) in this file')
            : esc(pageIds.length + ' of this file\u2019s ' + g.idx.length + ' matched lines are on this page')) +
          '">' + pageIds.length +
          (pageIds.length === g.idx.length ? '' : '<span class="dx-g-of">/' + g.idx.length + '</span>') +
        '</span>' +
        pluginLine(g) +
        /* Rober, 2026-08-19: "i want to be able to open the spid doc on the pc
           with a button in the UI." Per FILE, because the file IS the thing you
           would go and read or edit. Resolving it to a real on-disk path is
           C++'s job (the VFS makes the scanned path meaningless to the shell). */
        '<button class="dx-g-open" data-open="' + esc(g.file) + '" type="button" ' +
        'title="Open this file on your PC">Open</button>' +
        '</div>';
      if (!shut) {
        h += '<div class="dx-g-rows">';
        for (let k = 0; k < pageIds.length; k++) h += rowHtml(state.rows[pageIds[k]], pageIds[k]);
        h += '</div>';
      }
      h += '</div>';
    }
    return h;
  }

  /* ================================================ leveled list viewer ==
     Rober, 2026-08-19: "maybe a leveled list viewer if possible? … could search
     what items are in the leveled list if i click one".

     A leveled list has no name, so the row above it can only ever show a form
     spec — the contents ARE the answer to "what would this give her". The tree
     is drawn from what the engine holds, and it says the two things that decide
     whether an entry is a maybe or a certainty: the list's chance to roll
     nothing, and whether it hands out every entry instead of picking one.
     Levels are shown only where they gate (level > 1), because "Lv1" on every
     line is noise. */
  function lvlNodeHtml(n, depth, q) {
    if (!n) return '';
    if (q && !lvlMatches(n, q)) return '';
    const kids = Array.isArray(n.entries) ? n.entries : [];
    const isList = n.kind === 'lvli' || n.kind === 'lvln';
    let h = '<div class="dx-lv-node" style="margin-left:' + (depth * 16) + 'px">';
    h += '<span class="dx-lv-name' + (isList ? ' dx-lv-islist' : '') + '">' + esc(n.name || '(unnamed)') + '</span>';
    if (n.count > 1) h += '<span class="dx-lv-x">×' + (n.count | 0) + '</span>';
    if (n.level > 1) h += '<span class="dx-lv-tag">Lv ' + (n.level | 0) + '+</span>';
    if (isList) {
      h += '<span class="dx-lv-tag dx-lv-kind">' + (n.kind === 'lvln' ? 'leveled npc' : 'leveled list') +
        ' · ' + (n.entryCount | 0) + '</span>';
      if (n.useAll) h += '<span class="dx-lv-tag dx-lv-all">all of them</span>';
      if (n.chanceNone > 0) h += '<span class="dx-lv-tag dx-lv-none">' + (n.chanceNone | 0) + '% nothing</span>';
    } else if (n.type) {
      h += '<span class="dx-lv-type">' + esc(String(n.type).toLowerCase()) + '</span>';
    }
    if (n.cycle) h += '<span class="dx-lv-tag dx-lv-warn">points back at itself</span>';
    if (n.truncated) h += '<span class="dx-lv-tag dx-lv-warn">too deep to finish</span>';
    h += '</div>';
    for (let i = 0; i < kids.length; i++) h += lvlNodeHtml(kids[i], depth + 1, q);
    return h;
  }

  /* Filtering the tree, which is the other half of what Rober asked for:
     "could search what items are in the leveled list". A match keeps its
     ANCESTORS — a hit five levels down is meaningless without the branch that
     leads to it — and the deck's standing rule is that any list past ~10 items
     gets a typeable filter, which a food list comfortably is. */
  function lvlMatches(n, q) {
    if (!q) return true;
    if (String(n.name || '').toLowerCase().indexOf(q) !== -1) return true;
    const kids = Array.isArray(n.entries) ? n.entries : [];
    for (let i = 0; i < kids.length; i++) if (lvlMatches(kids[i], q)) return true;
    return false;
  }

  function lvlCountLeaves(n, q, acc) {
    const kids = Array.isArray(n.entries) ? n.entries : [];
    if (!kids.length) {
      if (!q || String(n.name || '').toLowerCase().indexOf(q) !== -1) acc.n++;
      return;
    }
    for (let i = 0; i < kids.length; i++) lvlCountLeaves(kids[i], q, acc);
  }

  function leveledHtml(r) {
    if (!r || !r.formId || !r.plugin) return '';
    const k = lvlKey(r.formId, r.plugin);
    const got = lvlCache[k];
    if (!got) {
      askLeveled(r.formId, r.plugin);
      return '<div class="dx-lv"><div class="dx-lv-head">Contents</div>' +
        '<div class="dx-lv-wait">reading the list…</div></div>';
    }
    if (got.failed) return '';   // not a leveled list: nothing to say, say nothing
    const q = String(ui.lvlQ[k] || '').trim().toLowerCase();
    const acc = { n: 0 };
    lvlCountLeaves(got, q, acc);
    const body = lvlNodeHtml(got, 0, q);
    return '<div class="dx-lv">' +
      '<div class="dx-lv-bar">' +
        '<span class="dx-lv-head">Contents — what this can actually give</span>' +
        '<span class="dx-lv-n">' + acc.n + (q ? ' matching' : '') + '</span>' +
        '<input class="dx-lv-find" type="text" spellcheck="false" data-lvk="' + esc(k) + '" ' +
          'placeholder="Filter these contents…" value="' + esc(ui.lvlQ[k] || '') + '">' +
      '</div>' +
      (body || '<div class="dx-lv-wait">nothing in this list matches that</div>') +
      '</div>';
  }

  function heroHtml(title, msg) {
    return '<div class="dx-hero"><div class="dx-hero-title">' + esc(title) + '</div>' +
      '<div class="dx-hero-msg">' + esc(msg) + '</div></div>';
  }

  /* The blocks manager. Deliberately independent of the match list: it is the
     ONLY place a rule on an unmatched form can be seen or lifted. */
  function rulesHtml() {
    const rules = state.rules || [];
    if (!ui.showRules || !rules.length) return '';
    let h = '<div class="dx-rules"><div class="dx-rules-head">' +
      '<span class="dx-rules-title">Blocked for ' +
      esc((state.target && state.target.name) || 'this person') + '</span>' +
      '<span class="dx-rules-note">taken back off her on every sweep</span>' +
      '<button class="dx-rules-clear" data-liftall="1" ' +
      'title="Lift every block for this person">Lift all</button></div>';
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      h += '<div class="dx-rule">' +
        '<span class="dx-rule-name" title="' + esc(r.name || '') + '">' + esc(r.name || '(unnamed)') + '</span>' +
        '<span class="dx-rule-src" title="' + esc(r.plugin || '') + '">' + esc(r.plugin || '') + '</span>' +
        '<button class="dx-rule-lift" data-lift="' + i + '" title="Stop blocking this">Lift</button>' +
        '</div>';
    }
    return h + '</div>';
  }

  function renderBody() {
    const body = need('dx-body');
    const empty = need('dx-empty');
    empty.classList.add('hidden');
    empty.innerHTML = '';

    if (state.refuse) {
      body.innerHTML = heroHtml('Nobody to inspect', state.refuse.msg ||
        'Look at someone, press the deck key again, and open Distributions.');
      return;
    }
    if (state.index.state === 'building' || state.building) {
      body.innerHTML = heroHtml('Reading the load order’s distribution files…',
        'Every enabled _DISTR.ini and SkyPatcher npc ini is being parsed. This happens once per game session.');
      return;
    }
    if (state.index.state === 'ready' &&
        (state.index.spidLines | 0) === 0 && (state.index.skyLines | 0) === 0) {
      body.innerHTML = heroHtml('No distribution files found',
        'No enabled mod ships a *_DISTR.ini or a SkyPatcher npc ini — there is nothing SPID or SkyPatcher could give anyone.');
      return;
    }
    if (state.awaiting && !state.rows.length) {
      body.innerHTML = '<div class="dx-skel"></div><div class="dx-skel"></div><div class="dx-skel"></div>';
      return;
    }
    if (!state.rows.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = heroHtml(
        ui.q || ui.group !== 'all' ? 'Nothing matches that search' : 'Nothing targets this NPC',
        ui.q || ui.group !== 'all'
          ? 'No matched distribution line fits the search or the selected group.'
          : 'No enabled SPID or SkyPatcher npc line passes its filters for this character.');
      return;
    }
    let h = rulesHtml();
    if (ui.byMod) {
      h += groupedHtml() + pagerHtml();
    } else {
      const seq = pageIdx();
      for (let n = 0; n < seq.length; n++) h += rowHtml(state.rows[seq[n]], seq[n]);
    }
    h += pagerHtml();
    if (state.total > state.shown)
      h += '<div class="dx-truncated">Showing ' + state.shown + ' of ' + state.total +
        ' — type to narrow the list.</div>';
    body.innerHTML = h;
    if (window.HDArt && HDArt.arm) HDArt.arm(body);
    paintArt(body);
    /* ONE delegated listener for the whole list instead of one per row and one
       per group header — with 2,170 matches that was thousands of listeners
       re-attached on every single render. Bound once, on the element that
       survives re-renders. */
    if (!body._dxBound) {
      body._dxBound = true;
      body.addEventListener('click', function (ev) {
        /* Pager and the per-file Open button, before anything that walks up to a
           row — both live inside the list and would otherwise toggle whatever
           row they happen to sit in. */
        const pg = ev.target && ev.target.closest ? ev.target.closest('.dx-pg') : null;
        if (pg) {
          ev.stopPropagation();
          if (!pg.disabled) gotoPage(ui.page + (pg.getAttribute('data-pg') === 'next' ? 1 : -1));
          return;
        }
        const op = ev.target && ev.target.closest ? ev.target.closest('.dx-g-open') : null;
        if (op) {
          ev.stopPropagation();
          openIni(op.getAttribute('data-open') || '');
          return;
        }
        /* The contents filter lives INSIDE an expanded row, so a click on it
           would otherwise bubble to the row handler and collapse the very thing
           being searched. */
        if (ev.target && ev.target.classList && ev.target.classList.contains('dx-lv-find')) {
          ev.stopPropagation();
          return;
        }
        const lift = ev.target.closest ? ev.target.closest('[data-lift]') : null;
        if (lift && body.contains(lift)) {
          ev.stopPropagation();
          const r = (state.rules || [])[parseInt(lift.getAttribute('data-lift'), 10)];
          if (r) sendBlock([{ formId: r.formId, plugin: r.plugin, name: r.name || '' }], false);
          return;
        }
        const liftAll = ev.target.closest ? ev.target.closest('[data-liftall]') : null;
        if (liftAll && body.contains(liftAll)) {
          ev.stopPropagation();
          const all = (state.rules || []).map(function (r) {
            return { formId: r.formId, plugin: r.plugin, name: r.name || '' };
          });
          if (all.length) sendBlock(all, false);
          return;
        }
        const bb = ev.target.closest ? ev.target.closest('.dx-block') : null;
        if (bb && body.contains(bb)) {
          ev.stopPropagation();          // never toggle the row open underneath
          const i = parseInt(bb.getAttribute('data-block'), 10);
          const r = state.rows[i];
          if (r) sendBlock(formsOfRow(r), !rowBlocked(r));
          return;
        }
        const head = ev.target.closest ? ev.target.closest('.dx-g-head') : null;
        if (head && body.contains(head)) {
          const f = head.getAttribute('data-file');
          if (ui.closed[f]) delete ui.closed[f]; else ui.closed[f] = true;
          renderBody();
          if (artGroup) artGroup.schedule();
          return;
        }
        const row = ev.target.closest ? ev.target.closest('.dx-row') : null;
        if (row && body.contains(row)) {
          const i = parseInt(row.getAttribute('data-i'), 10);
          ui.expanded = ui.expanded === i ? -1 : i;
          renderBody();
          if (artGroup) artGroup.schedule();
        }
      });
      /* Typing in a contents filter re-renders the tree, which destroys the
         input — so the focus and caret are put back on the box with the same
         key. Delegated for the same reason as the click handler. */
      body.addEventListener('input', function (ev) {
        const el = ev.target;
        if (!el || !el.classList || !el.classList.contains('dx-lv-find')) return;
        const k = el.getAttribute('data-lvk');
        const v = el.value;
        ui.lvlQ[k] = v;
        /* Repaint ONLY this tree. A full renderBody() per keystroke rebuilds
           every group and every row to filter one list — the pane would stutter
           on a fast typist, which is precisely the thing the deck's search-bar
           rule is supposed to make pleasant. */
        const rowEl = el.closest ? el.closest('.dx-row') : null;
        const lv = el.closest ? el.closest('.dx-lv') : null;
        const idx = rowEl ? parseInt(rowEl.getAttribute('data-i'), 10) : -1;
        const r = (idx >= 0 && state.rows[idx]) ? state.rows[idx] : null;
        if (lv && r) {
          const wrap = document.createElement('div');
          wrap.innerHTML = leveledHtml(r);
          const fresh = wrap.firstChild;
          if (fresh) {
            lv.parentNode.replaceChild(fresh, lv);
            const again = fresh.querySelector('.dx-lv-find');
            if (again) {
              again.focus();
              try { again.setSelectionRange(v.length, v.length); } catch (e) {}
            }
            return;
          }
        }
        renderBody();
        const again = body.querySelector('.dx-lv-find[data-lvk="' + k + '"]');
        if (again) {
          again.focus();
          try { again.setSelectionRange(v.length, v.length); } catch (e) {}
        }
      });
    }
  }

  function renderFoot() {
    const el = need('dx-foot');
    const ix = state.index || {};
    if (ix.state !== 'ready') { el.innerHTML = ''; return; }
    let h = 'Scanned ' + (ix.spidLines | 0) + ' SPID lines in ' + (ix.spidFiles | 0) +
      ' files + ' + (ix.skyLines | 0) + ' SkyPatcher npc lines in ' + (ix.skyFiles | 0) + ' files';
    /* The non-npc SkyPatcher count is the ONE number that distinguishes "that
       tree was never found" from "found it, but nothing in it targets NPCs".
       Both used to print an identical, silent 0 — which is how a scan that was
       seeing none of SkyPatcher looked exactly like a load order with no
       SkyPatcher in it (measured and fixed 2026-08-19). */
    if (ix.skyOtherFiles | 0)
      h += ' (' + (ix.skyOtherFiles | 0) + ' more SkyPatcher file(s) target things other than NPCs)';
    h += '.';
    /* ONE honesty sentence covering both kinds of "we could not judge it":
         unevaluated — SkyPatcher lines where NOTHING was judgeable, so listing
                       them would claim a match we never made;
         undecided   — SPID lines we REJECTED while at least one filter could not
                       be resolved, which until 2026-08-19 vanished uncounted.
       Split in the tooltip because they lean opposite ways: the first may be a
       match we are hiding, the second may be a rejection we got wrong. */
    const und = (state.undecided | 0) + (state.unevaluated | 0);
    if (und)
      h += ' <span class="dx-foot-warn" title="' +
        esc((state.undecided | 0) + ' SPID line(s) were rejected while a filter could not be resolved; ' +
            (state.unevaluated | 0) + ' SkyPatcher line(s) used only filters this inspector cannot judge.') +
        '">' + und + ' line' + (und === 1 ? '' : 's') +
        ' could not be fully judged and ' + (und === 1 ? 'is' : 'are') + ' not listed.</span>';
    h += ' These are the lines whose filters this NPC passes — chance is a dice roll SPID made at load, and of many matched outfits at most one is actually worn.';
    el.innerHTML = h;
  }

  /* ================================================================ dev == */

  function devState() {
    window.dxStateResult({
      index: { state: 'ready', spidFiles: 429, spidLines: 25525, skyFiles: 57, skyLines: 3200, ms: 240 },
      target: { name: 'Lydia', race: 'Nord', sex: 'Female', level: 24, plugin: 'Skyrim.esm', formId: '0xA2C8E', outfitNow: 'Steel Outfit' },
    });
  }

  function devQuery(arg) {
    let req = {};
    try { req = JSON.parse(arg || '{}'); } catch (e) {}
    window.dxResultData({
      seq: req.seq | 0, total: 3, shown: 3, unevaluated: 2,
      counts: { all: 3, outfit: 2, item: 1, spell: 0, perk: 0, keyword: 0, other: 0, spid: 2, sky: 1 },
      rows: [
        { src: 'spid', group: 'outfit', type: 'Outfit', label: 'Kimono Warrior Outfit', file: 'Beggars Female - FDOSS_DISTR.ini', line: 12, chance: 3,
          items: [{ name: 'Kimono Wrap' }, { name: 'Warrior Sandals' }],
          filters: [{ k: 'strings', v: 'ActorTypeNPC' }, { k: 'forms', v: 'Beggar' }, { k: 'traits', v: 'F' }] },
        { src: 'spid', group: 'item', type: 'Item', label: 'Healing Draught', file: 'Potions_DISTR.ini', line: 4, chance: 100, count: '2',
          filters: [{ k: 'forms', v: 'JobInnkeeperFaction' }] },
        { src: 'sky', group: 'other', type: 'Patch', label: 'Confidence', file: 'AI Overhaul SkyPatcher.ini', line: 88,
          ops: [{ k: 'setconfidence', label: 'Confidence', v: 'cautious' }],
          filters: [{ k: 'filterByNpcs', v: 'Skyrim.esm|A2C8E' }] },
      ],
    });
  }

  /* =============================================================== omni ==
     Without a provider this tab reached universal search only through omni's
     tab fallback, which indexes the nav button's rendered LABEL and nothing
     else. The button says "Distributions", so SPID and SkyPatcher — the two mod
     names the whole feature is built around — returned zero results, and so did
     the blocks, which are the only rules here that persist and go on acting on
     their own after you walk away.

     Deliberately NO warm(): the first dxState of a session makes C++ parse every
     enabled _DISTR.ini and SkyPatcher ini in the load order (25,000+ lines). That
     is a fair price for opening this tab and a rude one for opening the search
     box, so these rows describe whatever state a previous visit already left
     behind and stay silent otherwise. */

  /* Landing here from a search result. app.js's setTab() returns early when its
     tab is already open, so an in-place refresh has to be done from this side;
     when it is not open, setTab runs onShow() for us and a second one would
     re-ask the bridge twice. Either way onShow re-resolves the target, which is
     what makes the landing about whoever is in your crosshair NOW. */
  function omniLand(q, showRules) {
    ui.q = String(q == null ? '' : q);
    ui.showRules = !!showRules;
    ui.expanded = -1;
    ui.page = 0;
    const s = $('dx-search');
    if (s) s.value = ui.q;
    const wasOpen = ui.visible;
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('distr');
    if (wasOpen) onShow();
    else if (!ui.visible) render();
  }

  if (window.HDOmni && typeof window.HDOmni.register === 'function') {
    window.HDOmni.register({
      id: 'distr', label: 'Distributions', tab: 'distr',
      /* Reached by a jump on the landing row (which has no jump() of its own):
         setTab has already run onShow by now, so the typed query has to be
         re-queried against the fresh target rather than waiting for a keystroke
         that may never come. */
      setFilter: function (q) {
        ui.q = String(q || '');
        const s = $('dx-search');
        if (s) s.value = ui.q;
        runQuery();
      },
      index: function () {
        const t = state.target;
        const who = (t && t.name) ? t.name : '';
        const rules = (state.rules || []).length;
        return [{
          label: 'Distributions — what SPID and SkyPatcher give an NPC',
          detail: who
            ? 'Last inspected ' + who + ' · ' + (state.total | 0) + ' matched line(s)'
            : 'Look at someone and open this to see every line whose filters she passes',
          kind: 'distributions',
          keywords: 'spid skypatcher distr ini distribution distributed outfit outfits ' +
            'item items spell spells perk perks keyword keywords grant chance inspect ' +
            'npc leveled list what could she get',
          pin: 'distr:tab',
          run: function () { omniLand('', false); },
        }, {
          /* The blocks manager. A block keeps taking an item back off her on
             every sweep, and this panel is the only place one can be seen or
             lifted — a rule you cannot find is a rule you cannot undo. */
          label: 'Blocked items — lift a block',
          detail: rules
            ? rules + ' block' + (rules === 1 ? '' : 's') + ' in force for ' + (who || 'this person')
            : 'Every block in force for the NPC you inspect — the only place to lift one',
          kind: 'distributions',
          keywords: 'block blocked blocking unblock lift rule rules stop taking off ' +
            'spid skypatcher distribution never wears keep',
          run: function () { omniLand('', true); },
          /* Both paths open the manager. Letting the generic jump run instead
             would push the typed word into the pane's search box and filter the
             list out from under the panel. */
          jump: function () { omniLand('', true); },
        }, {
          label: 'Block all shown',
          /* Named so it can be FOUND, and honest about what pressing it here
             does: it opens the tab rather than firing. The button acts on the
             rows currently matched for the current target, and a search result
             cannot see those — from omni it would either hit a list you have
             never looked at or, on a first visit, an empty one and silently do
             nothing. */
          detail: 'Takes every listed item, outfit, spell and perk back off her on each ' +
            'sweep — opens Distributions so you see the list first',
          kind: 'distributions',
          keywords: 'block all everything shown spid skypatcher stop distributing ' +
            'take back off her outfit item spell perk',
          run: function () { omniLand('', false); },
          jump: function () { omniLand('', false); },
        }];
      },
    });
  }

  /* ================================================================ api == */

  function init() {
    const s = need('dx-search');
    s.addEventListener('input', function () {
      ui.q = s.value || '';
      ui.expanded = -1;
      queryDebounced();
    });
    s.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        /* Enter opens the top hit's detail — the Finder idiom, aimed at a
           read-only pane: the most useful "fire" here is "show me more". */
        if (state.rows.length) {
          ui.expanded = ui.expanded === 0 ? -1 : 0;
          renderBody();
          if (artGroup) artGroup.schedule();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  function onShow() {
    ui.visible = true;
    /* Re-ask both on every look: the target (crosshair or pin) is per-open,
       and the index may have finished parsing since the last visit. */
    toGame('dxState', JSON.stringify(reqBase()));
    runQuery();
    render();
    const s = $('dx-search');
    if (s) { try { s.focus(); } catch (e) {} }
  }

  function onHide() {
    ui.visible = false;
    ui.pinRef = '';   // the pin lives for one visit; next direct open is crosshair
    ui.pinName = '';
    if (ui.pollT) { clearTimeout(ui.pollT); ui.pollT = null; }
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (artGroup) artGroup.stop();
  }

  /* Deep-open aimed at ONE person — the F7 NPC card's Distr button (the
     FacesPane.aimAt idiom: self-contained, sets its state then navigates).
     ref is the runtime formId as "0xHEX"; C++ ResolveTarget prefers it over
     the crosshair snapshot. */
  function openFor(opts) {
    const o = opts || {};
    ui.pinRef = String(o.ref || '');
    ui.pinName = String(o.name || '');
    state.target = null;   // stale card would name the previous person
    state.rows = [];
    state.refuse = null;
    ui.expanded = -1;
    if (window.__omniSetTab) window.__omniSetTab('distr');
    /* already on the tab (no setTab fires): refresh in place */
    if (ui.visible) onShow();
  }

  return {
    init: init,
    onShow: onShow,
    onHide: onHide,
    openFor: openFor,
    toggleEdit: function () {},
    wantsPause: function () { return true; },
  };
})();

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', function () { window.DistrPane.init(); });
else
  window.DistrPane.init();
