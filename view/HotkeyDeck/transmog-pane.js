'use strict';

/* ====================================================================== *
 *  Transmog — restyle a SPECIFIC piece of your gear to look like any
 *  armor the load order ships (Rober, 2026-08-15: "Fully featured
 *  transmog tab … Use mesh framework to show previews … Hook to items
 *  not base id so it's unique and specific").
 *
 *  C++ owns the pool, the restyle and the instance swap (transmog.cpp);
 *  this pane owns YOUR GEAR (worn first, per-instance rows, armor AND
 *  weapons), the donor picker sheet with real renders, the before/after
 *  confirm strip, and the ✎ STAT EDITOR (phase 2 — Rober: "item stat
 *  editor … must be unique to specific item and persistent, not the base
 *  id"; the Proteus fix: an edited instance becomes its own pool form).
 *
 *  Bridge — requests: tgState() · tgList() · tgDonors(json) ·
 *  tgApply(json) · tgRevert(json) · tgStats(json)
 *  Replies (disjoint, per the deck law): tgStateResult({esp,used,total,
 *  active}) · tgListData({ok,esp,items}) · tgDonorsData({seq,total,items})
 *  · tgApplyResult({ok,msg,slot}) · tgRevertResult({ok,msg,slot}) ·
 *  tgStatsResult({ok,kind,slot,name,origName,base,cur,ov})
 *
 *  Renders: the EXACT items-pane idiom — whIcons through the Wardrobe's
 *  resolver + the shared 'hd-item-icons' event, 650ms settle gate, 2.5s
 *  empty poll, 30s self-closing render window with shimmer.
 *
 *  Host contract (mirrors ItemsPane): TransmogPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.TransmogPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const DEBOUNCE_MS = 160;      // donor search keystroke -> C++ query
  const DONOR_LIMIT = 200;      // C++ caps replies here; total rides alongside

  /* The ✎ stat editor's field table, per kind. id = the override wire key
     (tgApply overrides / tgStats ov), sk = the readout key in base/cur/
     row.stats, step = the −/＋ increment (the deck's no-range-input law:
     steppers + a click-to-type exact-value input, never a slider). */
  const STAT_FIELDS = {
    armo: [
      { id: 'armorRating', sk: 'ar', label: 'Armor rating', step: 1, dp: 0 },
      { id: 'value', sk: 'val', label: 'Value', step: 1, dp: 0 },
      { id: 'weight', sk: 'wt', label: 'Weight', step: 0.5, dp: 1 },
    ],
    weap: [
      { id: 'damage', sk: 'dmg', label: 'Damage', step: 1, dp: 0 },
      { id: 'critDamage', sk: 'crit', label: 'Critical damage', step: 1, dp: 0 },
      { id: 'speed', sk: 'speed', label: 'Speed', step: 0.05, dp: 2 },
      { id: 'reach', sk: 'reach', label: 'Reach', step: 0.05, dp: 2 },
      { id: 'stagger', sk: 'stagger', label: 'Stagger', step: 0.05, dp: 2 },
      { id: 'value', sk: 'val', label: 'Value', step: 1, dp: 0 },
      { id: 'weight', sk: 'wt', label: 'Weight', step: 0.5, dp: 1 },
    ],
  };
  function fieldsFor(kind) { return STAT_FIELDS[kind === 'weap' ? 'weap' : 'armo']; }

  /* ============================================================== state == */

  const state = {
    espKnown: false,  // first tgStateResult not landed yet
    esp: true,
    used: 0,
    total: 128,
    active: [],       // [{index, statName, donorName, stat, donor, worn, donorMissing}]
    items: [],        // your gear, per-instance (worn first — C++ sorts)
    listAsked: false,
    donors: [],       // current donor page
    donorTotal: 0,
    donorSeq: 0,      // last donor query we SENT; stale replies dropped
    awaitingDonors: false,
  };

  /* One page of gear at a time (Rober, 2026-08-15: "it loads meshes really
     slowly. maybe paginate to show many like 10 at a time then show next
     page"). Every visible row asks the mesh framework for a REAL 3D render, so
     a 63-piece inventory queued 60-odd renders at once and they trickled in for
     a minute. Paging is the honest fix: the queue is bounded by what you can
     actually see, and the next page's renders only start when you ask for it.
     Worn pieces are pinned to page 1 — they are what you came to restyle. */
  const PAGE_SIZE = 10;

  const ui = {
    page: 0,          // 0-based page into filteredRows()
    q: '',            // gear filter (client-side — your armor list is small)
    sel: 0,           // keyboard row in the gear list
    visible: false,
    sheet: null,      // {row, q, sameSlot, sel, confirm:{donor}|null} while the picker is up
    debT: null,
    toastT: null,
    /* No icon timers or asked-set here any more: HDArt owns the settle gate, the
       dedupe and the poll for every surface (see the icons block below). */
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'tgState') setTimeout(devState, 30);
      if (DEV && fn === 'tgList') setTimeout(devList, 30);
      if (DEV && fn === 'tgDonors') setTimeout(function () { devDonors(arg); }, 30);
      if (DEV && fn === 'tgApply') setTimeout(function () { devApply(arg); }, 30);
      if (DEV && fn === 'tgRevert') setTimeout(function () { devRevert(arg); }, 30);
      if (DEV && fn === 'tgStats') setTimeout(function () { devStats(arg); }, 30);
    }
  }

  window.tgStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.espKnown = true;
    state.esp = d.esp !== false;
    state.used = d.used | 0;
    state.total = d.total > 0 ? d.total | 0 : 128;
    state.active = Array.isArray(d.active) ? d.active : [];
    if (ui.visible) render();
  };

  window.tgListData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ('esp' in d) { state.espKnown = true; state.esp = d.esp !== false; }
    state.items = Array.isArray(d.items) ? d.items : [];
    if (ui.sel >= filteredRows().length) ui.sel = 0;
    if (ui.visible) render();
  };

  window.tgDonorsData = function (d) {
    if (!d || typeof d !== 'object') return;
    if ((d.seq | 0) !== state.donorSeq) return;   // stale keystroke
    state.awaitingDonors = false;
    state.donorTotal = d.total | 0;
    state.donors = Array.isArray(d.items) ? d.items : [];
    if (ui.sheet) { ui.sheet.sel = 0; renderSheet(); }
  };

  window.tgApplyResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (d.ok) {
      closeSheet();
      refresh();      // list + state both moved
    }
  };

  window.tgRevertResult = function (d) {
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (d.ok) refresh();
  };

  window.tgStatsResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (!ui.sheet || ui.sheet.mode !== 'stats') return;   // sheet gone — stale reply
    if (!d.ok) { toast(d.msg || 'Failed', true); closeSheet(); return; }
    ui.sheet.data = d;
    const vals = {};
    fieldsFor(d.kind).forEach(function (f) {
      const cur = d.cur && d.cur[f.sk] != null ? d.cur[f.sk] : (d.base ? d.base[f.sk] : 0);
      vals[f.id] = fmtV(f, cur);
    });
    ui.sheet.edit = { name: String(d.name || d.origName || ''), vals: vals };
    renderSheet();
  };

  function refresh() {
    toGame('tgState');
    toGame('tgList');
  }

  /* ============================================================ helpers == */

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

  /* A row's durable key — base identity + instance ordinal. */
  function rowKey(r) { return r.plugin + '|' + r.formId + '|' + r.ix; }

  /* Exact-value formatting for the stat editor (dp digits, no trailing
     noise on integers). */
  function fmtV(f, v) {
    const n = Number(v);
    if (!isFinite(n)) return f.dp === 0 ? '0' : (0).toFixed(f.dp);
    return f.dp === 0 ? String(Math.round(n)) : n.toFixed(f.dp);
  }

  /* The row's one-line live readout under the name — base numbers, the
     same ones the ✎ editor edits. */
  function statReadout(r) {
    const s = r.stats;
    if (!s || typeof s !== 'object') return '';
    if (r.kind === 'weap') {
      return '<span class="tg-meta-stats">' +
        esc(fmtN(s.dmg)) + ' dmg · spd ' + esc(Number(s.speed || 0).toFixed(2)) +
        ' · 🜚 ' + fmtN(s.val) + ' · ' + esc(Number(s.wt || 0).toFixed(1)) + ' wt</span>';
    }
    return '<span class="tg-meta-stats">' +
      esc(Number(s.ar || 0).toFixed(0)) + ' AR · 🜚 ' + fmtN(s.val) +
      ' · ' + esc(Number(s.wt || 0).toFixed(1)) + ' wt</span>';
  }

  /* ============================================================== icons == */
  /* ALL art goes through HDArt (hd-art.js). It owns the one formId dialect, the
     one index, the precedence law (custom > render > interface > glyph), the
     settle gate, the dedupe, the poll and the glyph degrade — so this pane says
     only WHAT is on screen and WHEN it is visible, and never grows an icon
     timer of its own. A harness with no HDArt shows glyphs. */

  function artSpec(formId, plugin, name) {
    return { kind: 'item', formId: formId, plugin: plugin, name: name || '', glyph: '🛡' };
  }
  const NO_ART = { src: '', glyph: '🛡', state: 'none', source: 'glyph', why: '' };
  function artOf(formId, plugin) {
    if (!formId || !plugin || !window.HDArt) return NO_ART;
    return HDArt.for(artSpec(formId, plugin));
  }
  function iconFor(formId, plugin) { return artOf(formId, plugin).src; }

  const RENDER_IDLE_MS = 30000;
  let chipLastLand = 0;
  let renderChip = null;
  let chipT = null;

  /* Every id currently on screen that could want a render: the gear rows,
     plus the donor sheet's rows + confirm pair while it is up. */
  function visibleIconIds() {
    const out = [];
    pagedRows().forEach(function (r) { out.push({ formId: r.formId, plugin: r.plugin, name: r.name }); });
    if (ui.sheet) {
      state.donors.forEach(function (d) { out.push({ formId: d.formId, plugin: d.plugin, name: d.n }); });
      if (ui.sheet.confirm) {
        const c = ui.sheet.confirm.donor;
        out.push({ formId: c.formId, plugin: c.plugin, name: c.n });
      }
    }
    return out;
  }

  function missingArt() {
    const ids = visibleIconIds();
    for (let i = 0; i < ids.length; i++)
      if (!iconFor(ids[i].formId, ids[i].plugin)) return true;
    return false;
  }

  function renderWindowActive() {
    return chipLastLand > 0 && missingArt() && (Date.now() - chipLastLand) < RENDER_IDLE_MS;
  }

  function rowLoading(formId, plugin) {
    return renderWindowActive() && !iconFor(formId, plugin);
  }

  function updateRenderChip() {
    const pane = $('tg-pane');
    if (!pane) return;
    if (!renderChip) {
      renderChip = document.createElement('div');
      renderChip.className = 'tg-render-chip';
      renderChip.innerHTML = '<span class="tg-render-spin"></span><span class="tg-render-txt"></span>';
      pane.appendChild(renderChip);
    }
    let pending = 0;
    visibleIconIds().forEach(function (x) { if (!iconFor(x.formId, x.plugin)) pending++; });
    const active = pending > 0 && renderWindowActive();
    renderChip.classList.toggle('tg-on', !!active);
    if (active) {
      renderChip.querySelector('.tg-render-txt').textContent =
        'rendering ' + pending + ' piece' + (pending === 1 ? '' : 's') + '…';
    }
    armChipWatchdog(active);
  }

  function armChipWatchdog(active) {
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (!active) return;
    const left = Math.max(250, RENDER_IDLE_MS - (Date.now() - chipLastLand) + 60);
    chipT = setTimeout(function () {
      chipT = null;
      if (ui.visible) { renderBody(); if (ui.sheet) renderSheet(); updateRenderChip(); }
    }, left);
  }

  /* Every row on screen that could want a picture, as HDArt specs. This is the
     ONE thing the pane has to declare — the module derives the batch, the
     dedupe and the poll from it. */
  function visibleArtSpecs() {
    return visibleIconIds().map(function (x) { return artSpec(x.formId, x.plugin, x.name); });
  }

  /* A render landed. Re-paint in place (scroll preserved) and keep the loading
     window open — the module already decided the repaint was worth doing. */
  function onArtLanded() {
    if (!ui.visible) return;
    chipLastLand = Date.now();
    const body = $('tg-body');
    const top = body ? body.scrollTop : 0;
    renderBody();
    const b2 = $('tg-body');
    if (b2) b2.scrollTop = top;
    if (ui.sheet) renderSheet();
    updateRenderChip();
  }

  const artGroup = window.HDArt ? HDArt.group('transmog', {
    visible: function () { return ui.visible; },
    specs: visibleArtSpecs,
    onLand: onArtLanded,
  }) : null;

  function scheduleIconWork() {
    if (!visibleIconIds().length) { stopIconPoll(); updateRenderChip(); return; }
    if (missingArt()) chipLastLand = Date.now();
    if (artGroup) artGroup.schedule();
    updateRenderChip();
  }

  function stopIconPoll() { if (artGroup) artGroup.stop(); }

  function flushIconsForTest() { if (artGroup) artGroup.flush(); }

  /* Test hook only — HDArt owns the real interval. Kept so the harness can drive
     one nudge deterministically instead of waiting 2.5 s. */
  function iconPollTick() {
    if (!ui.visible || !missingArt()) return false;
    if (window.HDArt && HDArt._pollTick) HDArt._pollTick();
    return true;
  }

  function plateHtml(formId, plugin, glyph, extraCls, title) {
    const a = artOf(formId, plugin);
    const url = a.src;
    const loading = !url && a.state === 'rendering' && rowLoading(formId, plugin);
    let h = '<div class="tg-glyph' + (extraCls ? ' ' + extraCls : '') +
      (url ? ' tg-has-art tg-zoomable' : '') + (loading ? ' tg-loading' : '') +
      '" title="' + esc(title || (url ? 'Click for a bigger look'
        : (loading ? 'rendering…' : (a.why || '')))) + '">' + glyph;
    /* HDArt.ERR is the shared inline degrade: a missing file drops the <img> and
       the has-art class, so the glyph underneath shows — never a broken box. */
    if (url) h += '<img class="tg-art" src="' + esc(url) + '" alt="" draggable="false"' +
      (window.HDArt ? HDArt.errFor('tg-has-art') : '') + '>';
    h += '</div>';
    return h;
  }

  function openLightbox(formId, plugin, name, sub) {
    const url = iconFor(formId, plugin);
    if (!url || !window.HDLightbox) return;
    const frames = ['-a090', '-a180', '-a270'].map(function (s) {
      return url.replace(/\.png$/, s + '.png');
    });
    HDLightbox.open({
      host: $('tg-pane'), src: url, glyph: '🛡', title: name, sub: sub || plugin, frames: frames,
      spin: { kind: 'item', formId: formId, plugin: plugin },
    });
  }

  /* ======================================================== gear filter == */

  /* The slice actually drawn — and therefore the only rows whose renders are
     requested (visibleIconIds walks this, not the whole inventory). */
  function pagedRows() {
    const rows = filteredRows();
    const pages = pageCount(rows);
    if (ui.page >= pages) ui.page = Math.max(0, pages - 1);
    if (ui.page < 0) ui.page = 0;
    return rows.slice(ui.page * PAGE_SIZE, ui.page * PAGE_SIZE + PAGE_SIZE);
  }

  function pageCount(rows) {
    const n = (rows || filteredRows()).length;
    return Math.max(1, Math.ceil(n / PAGE_SIZE));
  }

  function filteredRows() {
    const q = ui.q.toLowerCase();
    if (!q) return state.items;
    return state.items.filter(function (r) {
      const hay = (r.name + ' ' + r.plugin + ' ' +
        (r.tmog ? (r.tmog.donorName + ' ' + r.tmog.statName) : '')).toLowerCase();
      return q.split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  /* ========================================================= donor sheet == */

  function openSheet(row) {
    if (!state.esp) { toast('SkyManagerTransmog.esp isn’t in your load order — tick it in MO2', true); return; }
    if (row.tmog) return;   // transmogged rows revert, they don't re-pick
    ui.sheet = { mode: 'donor', row: row, q: '', sameSlot: true, sel: 0, confirm: null };
    state.donors = [];
    state.donorTotal = 0;
    queryDonors();
    renderSheet();
    setTimeout(function () { const i = $('tg-d-search'); if (i) i.focus(); }, 30);
  }

  /* The ✎ stat editor — works on plain rows (allocates a stats-only slot,
     donor:none, look unchanged) AND on transmogged rows (adds overrides to
     the existing slot). */
  function openStats(row) {
    if (!state.esp) { toast('SkyManagerTransmog.esp isn’t in your load order — tick it in MO2', true); return; }
    ui.sheet = { mode: 'stats', row: row, data: null, edit: null };
    toGame('tgStats', JSON.stringify(row.tmog
      ? { slot: row.tmog.slot | 0 }
      : { plugin: row.plugin, formId: row.formId }));
    renderSheet();
  }

  function closeSheet() {
    ui.sheet = null;
    const sh = $('tg-sheet');
    if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; }
    const s = $('tg-search');
    if (s) s.focus();
    scheduleIconWork();
  }

  function queryDonors() {
    if (!ui.sheet || ui.sheet.mode !== 'donor') return;
    state.donorSeq++;
    state.awaitingDonors = true;
    const r = ui.sheet.row;
    const isW = r.kind === 'weap';
    const payload = { q: ui.sheet.q, limit: DONOR_LIMIT, seq: state.donorSeq };
    if (isW) {
      /* weapon donors: same-TYPE default (a bow look on a sword stat would
         swing like a sword but LOOK like a bow — nonsense unless asked) */
      payload.kind = 'weap';
      payload.wtype = ui.sheet.sameSlot ? (r.wtype == null ? -1 : r.wtype | 0) : -1;
    } else {
      payload.kind = 'armo';
      payload.slot = ui.sheet.sameSlot ? (r.slot | 0) : 0;
    }
    toGame('tgDonors', JSON.stringify(payload));
  }

  function donorsDebounced() {
    if (ui.debT) clearTimeout(ui.debT);
    ui.debT = setTimeout(function () { ui.debT = null; queryDonors(); }, DEBOUNCE_MS);
  }

  function pickDonor(d) {
    if (!ui.sheet || !d) return;
    ui.sheet.confirm = { donor: d };
    renderSheet();
    scheduleIconWork();   // the confirm pair may need renders
  }

  function applyConfirm() {
    if (!ui.sheet || !ui.sheet.confirm) return;
    const r = ui.sheet.row;
    const d = ui.sheet.confirm.donor;
    toGame('tgApply', JSON.stringify({
      plugin: r.plugin, formId: r.formId, ix: r.ix, name: r.name,
      donorPlugin: d.plugin, donorFormId: d.formId,
    }));
  }

  function revertRow(row) {
    if (!row || !row.tmog) return;
    toGame('tgRevert', JSON.stringify({ slot: row.tmog.slot | 0 }));
  }

  function renderSheet() {
    const sh = $('tg-sheet');
    if (!sh) return;
    if (!ui.sheet) { sh.classList.add('hidden'); sh.innerHTML = ''; return; }
    const row = ui.sheet.row;
    sh.classList.remove('hidden');

    if (ui.sheet.mode === 'stats') { renderStatsSheet(sh); return; }
    const isW = row.kind === 'weap';
    const ownGlyph = isW ? '⚔' : '🛡';
    const donorGlyph = isW ? '⚔' : '👗';

    /* ---- confirm strip: before / after + Apply ---- */
    if (ui.sheet.confirm) {
      const d = ui.sheet.confirm.donor;
      sh.innerHTML =
        '<div class="tg-sheet-card">' +
        '<div class="tg-sheet-title">Make it look like this?</div>' +
        '<div class="tg-confirm">' +
        '<div class="tg-confirm-side">' + plateHtml(row.formId, row.plugin, ownGlyph, 'tg-confirm-plate') +
        '<div class="tg-confirm-lbl">Now</div><div class="tg-confirm-name" title="' + esc(row.name) + '">' + esc(row.name) + '</div></div>' +
        '<div class="tg-confirm-arrow">→</div>' +
        '<div class="tg-confirm-side">' + plateHtml(d.formId, d.plugin, donorGlyph, 'tg-confirm-plate') +
        '<div class="tg-confirm-lbl">Will look like</div><div class="tg-confirm-name" title="' + esc(d.n) + '">' + esc(d.n) + '</div></div>' +
        '</div>' +
        '<div class="tg-sheet-note">Stats, name, enchantment and tempering all stay the original’s. ' +
        (isW ? 'The swing and skill follow the ORIGINAL weapon’s type — the donor only changes the mesh. ' : '') +
        'To temper it later the grindstone still keys on the ORIGINAL — temper first, then transmog ' +
        '(or revert, temper, re-apply).</div>' +
        '<div class="tg-sheet-actions">' +
        '<button id="tg-confirm-back" class="tg-btn">‹ Back</button>' +
        '<button id="tg-confirm-apply" class="tg-apply">✨ Transmog it</button>' +
        '</div></div>';
      $('tg-confirm-back').addEventListener('click', function () {
        ui.sheet.confirm = null;
        renderSheet();
        setTimeout(function () { const i = $('tg-d-search'); if (i) i.focus(); }, 30);
      });
      $('tg-confirm-apply').addEventListener('click', applyConfirm);
      sh.querySelectorAll('.tg-confirm-plate.tg-has-art').forEach(function (p, i) {
        p.addEventListener('click', function () {
          if (i === 0) openLightbox(row.formId, row.plugin, row.name, row.plugin);
          else openLightbox(d.formId, d.plugin, d.n, d.plugin);
        });
      });
      sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
      scheduleIconWork();
      return;
    }

    /* ---- picker: search + same-slot toggle + donor rows ---- */
    let rowsH = '';
    if (state.awaitingDonors && !state.donors.length) {
      rowsH = new Array(6).fill(
        '<div class="tg-d-row tg-skel"><div class="tg-glyph tg-skel-box"></div>' +
        '<div class="tg-mid"><span class="tg-skel-box tg-skel-w1"></span>' +
        '<span class="tg-skel-box tg-skel-w2"></span></div></div>').join('');
    } else if (!state.donors.length) {
      rowsH = '<div class="tg-d-empty">Nothing matches' +
        (ui.sheet.q ? ' “' + esc(ui.sheet.q) + '”' : '') +
        (ui.sheet.sameSlot
          ? (isW ? ' of the same weapon type — try turning the type filter off'
                 : ' on the same slot — try turning the slot filter off')
          : '') + '.</div>';
    } else {
      state.donors.forEach(function (d, i) {
        rowsH += '<div class="tg-d-row' + (i === ui.sheet.sel ? ' tg-sel' : '') + '" data-i="' + i + '">' +
          plateHtml(d.formId, d.plugin, donorGlyph) +
          '<div class="tg-mid">' +
          '<div class="tg-name" title="' + esc(d.n) + '">' + highlight(d.n, ui.sheet.q) + '</div>' +
          '<div class="tg-meta"><span>' + esc(d.plugin) + '</span>' +
          '<span class="tg-meta-vw">🜚 ' + fmtN(Math.max(0, d.v | 0)) + '</span></div>' +
          '</div>' +
          '<button class="tg-pick" data-i="' + i + '">Choose →</button></div>';
      });
    }
    const shown = state.donors.length;
    sh.innerHTML =
      '<div class="tg-sheet-card">' +
      '<div class="tg-sheet-title">New look for <b title="' + esc(row.name) + '">' + esc(row.name) + '</b></div>' +
      '<div class="tg-d-bar">' +
      '<span class="tg-d-glyph">⌕</span>' +
      '<input id="tg-d-search" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="' + (isW ? 'Search every weapon every mod ships… (Enter = top hit)'
                             : 'Search every armor every mod ships… (Enter = top hit)') +
      '" value="' + esc(ui.sheet.q) + '">' +
      '<button id="tg-d-slot" class="tg-toggle' + (ui.sheet.sameSlot ? ' tg-toggle-on' : '') +
      '" title="' + (isW ? 'Only show looks of the same weapon type — the swing follows the original, so a bow mesh on a sword reads as nonsense'
                         : 'Only show looks worn on the same body slot') + '">' +
      (ui.sheet.sameSlot ? '◉' : '○') + (isW ? ' Same type' : ' Same slot') + '</button>' +
      '</div>' +
      '<div class="tg-d-count">' + (state.donorTotal > shown
        ? fmtN(shown) + ' of ' + fmtN(state.donorTotal) + ' looks — type to narrow'
        : fmtN(state.donorTotal) + ' look' + (state.donorTotal === 1 ? '' : 's')) + '</div>' +
      '<div class="tg-d-body">' + rowsH + '</div>' +
      '<div class="tg-sheet-actions"><button id="tg-sheet-cancel" class="tg-btn">Cancel</button></div>' +
      '</div>';

    const inp = $('tg-d-search');
    inp.addEventListener('input', function () {
      ui.sheet.q = inp.value.trim();
      ui.sheet.sel = 0;
      donorsDebounced();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        pickDonor(state.donors[Math.min(ui.sheet.sel, state.donors.length - 1)] || state.donors[0]);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (state.donors.length) {
          ui.sheet.sel = e.key === 'ArrowDown'
            ? Math.min(state.donors.length - 1, ui.sheet.sel + 1)
            : Math.max(0, ui.sheet.sel - 1);
          renderSheet();
          const el = sh.querySelector('.tg-d-row.tg-sel');
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          const i2 = $('tg-d-search');
          if (i2) i2.focus();
        }
        e.preventDefault(); e.stopPropagation();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (inp.value) { inp.value = ''; ui.sheet.q = ''; ui.sheet.sel = 0; queryDonors(); }
        else closeSheet();
      }
    });
    $('tg-d-slot').addEventListener('click', function () {
      ui.sheet.sameSlot = !ui.sheet.sameSlot;
      ui.sheet.sel = 0;
      queryDonors();
      renderSheet();
      setTimeout(function () { const i = $('tg-d-search'); if (i) i.focus(); }, 30);
    });
    $('tg-sheet-cancel').addEventListener('click', closeSheet);
    sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
    sh.querySelectorAll('.tg-d-row:not(.tg-skel)').forEach(function (r) {
      const i = parseInt(r.getAttribute('data-i'), 10);
      r.addEventListener('click', function () { pickDonor(state.donors[i]); });
    });
    sh.querySelectorAll('.tg-pick').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        pickDonor(state.donors[parseInt(b.getAttribute('data-i'), 10)]);
      });
    });
    scheduleIconWork();
  }

  /* ========================================================= stat editor == */

  /* The override block to send: every field whose edited value differs from
     the ORIGINAL (base) — so resetting a field back to the original OMITS it,
     and C++'s wholesale-replace clears that override. Unreadable input =
     unchanged. */
  function statOverrides() {
    const sh = ui.sheet;
    if (!sh || sh.mode !== 'stats' || !sh.data || !sh.edit) return {};
    const d = sh.data;
    const ov = {};
    fieldsFor(d.kind).forEach(function (f) {
      const base = Number(d.base && d.base[f.sk] != null ? d.base[f.sk] : 0);
      let v = parseFloat(sh.edit.vals[f.id]);
      if (!isFinite(v)) return;
      if (v < 0) v = 0;
      if (Math.abs(v - base) > 1e-4) ov[f.id] = f.dp === 0 ? Math.round(v) : Number(v.toFixed(f.dp));
    });
    const nm = String(sh.edit.name || '').trim();
    if (nm && nm !== String(d.origName || '')) ov.name = nm;
    return ov;
  }

  function statSummaryText() {
    const sh = ui.sheet;
    if (!sh || !sh.data) return '';
    const d = sh.data;
    const ov = statOverrides();
    const parts = [];
    fieldsFor(d.kind).forEach(function (f) {
      if (!(f.id in ov)) return;
      const base = Number(d.base && d.base[f.sk] != null ? d.base[f.sk] : 0);
      parts.push(f.label + ' ' + fmtV(f, base) + '→' + fmtV(f, ov[f.id]));
    });
    if ('name' in ov) parts.push('Renamed “' + ov.name + '”');
    if (parts.length) return parts.join(' · ');
    const hadEdits = d.ov && Object.keys(d.ov).length;
    return hadEdits
      ? 'No changes vs the original — Apply clears every edit.'
      : 'No changes yet — the original’s numbers.';
  }

  function updateStatSummary() {
    const s = $('tg-st-sum');
    if (s) s.textContent = statSummaryText();
  }

  function applyStats() {
    const sh = ui.sheet;
    if (!sh || sh.mode !== 'stats' || !sh.data) return;
    const ov = statOverrides();
    if (sh.data.slot >= 0) {
      /* already pooled (transmog or earlier edit): overrides ride the slot */
      toGame('tgApply', JSON.stringify({ slot: sh.data.slot | 0, overrides: ov }));
      return;
    }
    if (!Object.keys(ov).length) { toast('Nothing changed', true); return; }
    /* not pooled yet: allocate a stats-only slot — donor NONE, look unchanged */
    const r = sh.row;
    toGame('tgApply', JSON.stringify({
      plugin: r.plugin, formId: r.formId, ix: r.ix, name: r.name, overrides: ov,
    }));
  }

  function renderStatsSheet(sh) {
    const row = ui.sheet.row;
    const d = ui.sheet.data;

    if (!d || !ui.sheet.edit) {
      sh.innerHTML =
        '<div class="tg-sheet-card tg-st-card">' +
        '<div class="tg-sheet-title">✎ Stats for <b title="' + esc(row.name) + '">' + esc(row.name) + '</b></div>' +
        '<div class="tg-st-rows">' + new Array(4).fill(
          '<div class="tg-st-row tg-skel"><span class="tg-skel-box tg-skel-w1"></span>' +
          '<span class="tg-skel-box tg-skel-w2"></span></div>').join('') + '</div>' +
        '<div class="tg-sheet-actions"><button id="tg-st-cancel" class="tg-btn">Cancel</button></div>' +
        '</div>';
      const c = $('tg-st-cancel');
      if (c) c.addEventListener('click', closeSheet);
      sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
      return;
    }

    const flds = fieldsFor(d.kind);
    let rowsH = '';
    flds.forEach(function (f) {
      const base = Number(d.base && d.base[f.sk] != null ? d.base[f.sk] : 0);
      rowsH +=
        '<div class="tg-st-row" data-f="' + f.id + '">' +
        '<div class="tg-st-lbl">' + esc(f.label) + '</div>' +
        '<div class="tg-st-orig" title="The original’s ' + esc(f.label.toLowerCase()) + '">' + fmtV(f, base) + '</div>' +
        '<div class="tg-st-ctrl">' +
        '<button class="tg-st-dec" data-f="' + f.id + '" title="−' + f.step + '">−</button>' +
        '<input class="tg-st-in" data-f="' + f.id + '" type="text" inputmode="decimal" ' +
        'autocomplete="off" spellcheck="false" value="' + esc(ui.sheet.edit.vals[f.id]) + '">' +
        '<button class="tg-st-inc" data-f="' + f.id + '" title="+' + f.step + '">＋</button>' +
        '<button class="tg-st-reset" data-f="' + f.id + '" title="Back to the original’s ' + fmtV(f, base) + '">↺</button>' +
        '</div></div>';
    });

    sh.innerHTML =
      '<div class="tg-sheet-card tg-st-card">' +
      '<div class="tg-sheet-title">✎ Stats for <b title="' + esc(row.name) + '">' + esc(row.name) + '</b></div>' +
      '<div class="tg-st-name-row"><label for="tg-st-name">Name</label>' +
      '<input id="tg-st-name" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="' + esc(d.origName || 'Its name') + '" value="' + esc(ui.sheet.edit.name) + '">' +
      '</div>' +
      '<div class="tg-st-head"><span></span><span>Original</span><span>Now</span></div>' +
      '<div class="tg-st-rows">' + rowsH + '</div>' +
      '<div class="tg-sheet-note">These are BASE numbers — skills, perks and smithing multiply ' +
      'on top' + (d.kind === 'weap' ? ' (shown damage is base damage, same as Proteus showed it)' : '') +
      ', and a tempered piece keeps its tempering. Edits ride THIS exact piece — the base record ' +
      'every other copy uses is untouched, and ↩ Revert brings the original numbers back.</div>' +
      '<div id="tg-st-sum" class="tg-st-sum"></div>' +
      '<div class="tg-sheet-actions">' +
      '<button id="tg-st-cancel" class="tg-btn">Cancel</button>' +
      '<button id="tg-st-apply" class="tg-apply">✔ Apply stats</button>' +
      '</div></div>';

    function fieldOf(id) {
      for (let i = 0; i < flds.length; i++) if (flds[i].id === id) return flds[i];
      return null;
    }
    function inputOf(id) {
      return sh.querySelector('.tg-st-in[data-f="' + id + '"]');
    }
    function setVal(f, v) {
      if (v < 0) v = 0;
      const txt = fmtV(f, v);
      ui.sheet.edit.vals[f.id] = txt;
      const inp = inputOf(f.id);
      if (inp) inp.value = txt;
      updateStatSummary();
    }

    const nameIn = $('tg-st-name');
    nameIn.addEventListener('input', function () {
      ui.sheet.edit.name = nameIn.value;
      updateStatSummary();
    });
    sh.querySelectorAll('.tg-st-in').forEach(function (inp) {
      inp.addEventListener('input', function () {
        ui.sheet.edit.vals[inp.getAttribute('data-f')] = inp.value;
        updateStatSummary();
      });
      inp.addEventListener('keydown', function (e) {
        const f = fieldOf(inp.getAttribute('data-f'));
        if (!f) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const cur = parseFloat(inp.value);
          setVal(f, (isFinite(cur) ? cur : 0) + (e.key === 'ArrowUp' ? f.step : -f.step));
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Enter') {
          applyStats();
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape') {
          closeSheet();
          e.stopPropagation();
        }
      });
    });
    sh.querySelectorAll('.tg-st-dec, .tg-st-inc').forEach(function (b) {
      b.addEventListener('click', function () {
        const f = fieldOf(b.getAttribute('data-f'));
        if (!f) return;
        const inp = inputOf(f.id);
        const cur = parseFloat(inp ? inp.value : '');
        const isInc = b.classList.contains('tg-st-inc');
        setVal(f, (isFinite(cur) ? cur : 0) + (isInc ? f.step : -f.step));
      });
    });
    sh.querySelectorAll('.tg-st-reset').forEach(function (b) {
      b.addEventListener('click', function () {
        const f = fieldOf(b.getAttribute('data-f'));
        if (!f) return;
        setVal(f, Number(d.base && d.base[f.sk] != null ? d.base[f.sk] : 0));
      });
    });
    $('tg-st-cancel').addEventListener('click', closeSheet);
    $('tg-st-apply').addEventListener('click', applyStats);
    sh.addEventListener('click', function (e) { if (e.target === sh) closeSheet(); });
    updateStatSummary();
    setTimeout(function () { if (nameIn) nameIn.focus(); }, 30);
  }

  /* ============================================================= render == */

  function renderHeader() {
    const chip = $('tg-count-chip');
    if (chip) {
      chip.textContent = state.espKnown
        ? (state.used + '/' + state.total + ' transmogs')
        : 'checking…';
      chip.classList.toggle('tg-chip-full', state.used >= state.total);
    }
  }

  function gearRowHtml(r, idx) {
    const isW = r.kind === 'weap';
    const chips = [];
    if (isW) chips.push('<span class="tg-chip tg-chip-kind" title="Weapon">⚔</span>');
    if (r.worn) chips.push('<span class="tg-chip tg-chip-worn">' + (isW ? 'equipped' : 'worn') + '</span>');
    if (r.ench) chips.push('<span class="tg-chip tg-chip-ench">✦ enchanted</span>');
    if ((r.count | 0) > 1) chips.push('<span class="tg-chip">×' + (r.count | 0) + '</span>');
    if (r.tmog && r.tmog.edited)
      chips.push('<span class="tg-chip tg-chip-edit" ' +
        'title="Stats edited — unique to this exact piece; ↩ Revert brings the original numbers back">✎ edited</span>');
    const readout = statReadout(r);
    let sub;
    let act;
    const statsBtn = '<button class="tg-stats-btn" data-k="' + esc(rowKey(r)) + '" ' +
      (state.esp ? '' : 'disabled ') +
      'title="' + (state.esp
        ? 'Edit this exact piece’s stats — damage, value, weight… the base record stays untouched'
        : 'SkyManagerTransmog.esp isn’t in your load order') + '">✎ Stats</button>';
    if (r.tmog) {
      sub = (r.tmog.own
        ? '<span class="tg-looks" title="Stats edited — it wears its own look">✎ its own look — stats edited</span>'
        : '<span class="tg-looks" title="Really ' + esc(r.tmog.statName) + ' — restyled">◇ looks like ' +
          esc(r.tmog.donorName) + '</span>') +
        (r.tmog.donorMissing
          ? '<span class="tg-chip tg-chip-warn" title="The donor’s mod left the load order — the piece shows its own real look until you revert or its mod returns">looks normal — ' +
            'donor mod is gone</span>'
          : '') +
        (readout ? ' ' + readout : '');
      act = statsBtn +
        '<button class="tg-revert" data-k="' + esc(rowKey(r)) + '" ' +
        'title="The original back — look AND stats; frees the slot">↩ Revert</button>';
    } else {
      sub = '<span class="tg-meta-plug">' + esc(r.plugin) + '</span>' +
        (readout ? ' ' + readout : '');
      act = statsBtn +
        '<button class="tg-restyle" data-k="' + esc(rowKey(r)) + '" ' +
        (state.esp ? '' : 'disabled ') +
        'title="' + (state.esp ? 'Pick a new look for this exact piece'
          : 'SkyManagerTransmog.esp isn’t in your load order') + '">✨ Restyle</button>';
    }
    return '<div class="tg-row' + (idx === ui.sel ? ' tg-sel' : '') + (r.tmog ? ' tg-row-tmog' : '') +
      '" data-k="' + esc(rowKey(r)) + '">' +
      plateHtml(r.formId, r.plugin, r.tmog ? '◇' : (isW ? '⚔' : '🛡')) +
      '<div class="tg-mid">' +
      '<div class="tg-name" title="' + esc(r.name) + '">' + highlight(r.name, ui.q) + ' ' + chips.join(' ') + '</div>' +
      '<div class="tg-meta">' + sub + '</div>' +
      '</div>' +
      '<div class="tg-act">' + act + '</div></div>';
  }

  function renderBody() {
    const body = $('tg-body');
    const empty = $('tg-empty');
    if (!body || !empty) return;

    /* the honest setup card — the whole tab is a no-op without the pool esp */
    if (state.espKnown && !state.esp) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<div class="tg-hero-glyph">◇</div>' +
        '<div class="tg-empty-title">SkyManagerTransmog.esp isn’t in your load order</div>' +
        '<div class="tg-empty-sub">The transmog pool lives in its own ESL-flagged plugin — ' +
        'tick <b>SkyManagerTransmog.esp</b> in MO2’s right pane and relaunch. ' +
        'Nothing else to configure; it costs no full plugin slot.</div>';
      return;
    }

    if (!state.listAsked && !state.items.length) {
      body.innerHTML = new Array(6).fill(
        '<div class="tg-row tg-skel"><div class="tg-glyph tg-skel-box"></div>' +
        '<div class="tg-mid"><span class="tg-skel-box tg-skel-w1"></span>' +
        '<span class="tg-skel-box tg-skel-w2"></span></div></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const rows = filteredRows();
    if (!rows.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = ui.q
        ? '<div class="tg-empty-title">Nothing matches “' + esc(ui.q) + '”</div>' +
          '<div class="tg-empty-sub">Try fewer letters — the list is your armor, worn and carried.</div>'
        : '<div class="tg-hero-glyph">◇</div>' +
          '<div class="tg-empty-title">No armor on you</div>' +
          '<div class="tg-empty-sub">Pick up or wear something first — then restyle the exact ' +
          'piece to look like any armor any mod ships. Player only for now: the follower systems ' +
          '(SOES-NG) own NPC outfits and would fight a transmog.</div>';
      return;
    }
    empty.classList.add('hidden');

    /* Section counts stay TRUE TOTALS (what you own), while the rows drawn are
       this page — a header that counted only the page would lie about your
       inventory. */
    const wornTotal = rows.filter(function (x) { return x.worn; }).length;
    const carriedTotal = rows.length - wornTotal;
    const page = pagedRows();
    const pages = pageCount(rows);
    let html = '';
    let inWorn = false, inCarried = false;
    page.forEach(function (r) {
      const idx = rows.indexOf(r);
      if (r.worn && !inWorn) {
        inWorn = true;
        html += '<div class="tg-sect">On you <b>' + wornTotal + '</b></div>';
      }
      if (!r.worn && !inCarried) {
        inCarried = true;
        html += '<div class="tg-sect">Carried <b>' + carriedTotal + '</b></div>';
      }
      html += gearRowHtml(r, idx);
    });
    if (pages > 1) {
      const first = ui.page * PAGE_SIZE + 1;
      const last = Math.min(rows.length, first + PAGE_SIZE - 1);
      html += '<div class="tg-pager">' +
        '<button class="tg-page-btn" data-page="prev"' + (ui.page === 0 ? ' disabled' : '') +
        ' title="Previous page">‹ Prev</button>' +
        '<span class="tg-page-at">' + first + '–' + last + ' of ' + rows.length +
        '<span class="tg-page-of">page ' + (ui.page + 1) + ' of ' + pages + '</span></span>' +
        '<button class="tg-page-btn" data-page="next"' + (ui.page >= pages - 1 ? ' disabled' : '') +
        ' title="Next page — its pieces start rendering when you land on it">Next ›</button>' +
        '</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll('.tg-page-btn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (b.disabled) return;
        ui.page += (b.getAttribute('data-page') === 'next' ? 1 : -1);
        ui.sel = ui.page * PAGE_SIZE;
        renderBody();
        const bd = $('tg-body');
        if (bd) bd.scrollTop = 0;   // a new page starts at its top, always
      });
    });

    body.querySelectorAll('.tg-row:not(.tg-skel)').forEach(function (el) {
      const k = el.getAttribute('data-k');
      function row() {
        const rs = filteredRows();
        for (let i = 0; i < rs.length; i++) if (rowKey(rs[i]) === k) return rs[i];
        return null;
      }
      el.addEventListener('click', function () {
        const r = row();
        if (!r) return;
        if (r.tmog) return;        // the Revert button is the verb there
        openSheet(r);
      });
      const rv = el.querySelector('.tg-revert');
      if (rv) rv.addEventListener('click', function (e) { e.stopPropagation(); revertRow(row()); });
      const rs = el.querySelector('.tg-restyle');
      if (rs) rs.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = row();
        if (r) openSheet(r);
      });
      const st = el.querySelector('.tg-stats-btn');
      if (st) st.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = row();
        if (r) openStats(r);
      });
      const zoom = el.querySelector('.tg-glyph.tg-zoomable');
      if (zoom) zoom.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = row();
        if (r) openLightbox(r.formId, r.plugin, r.name, r.plugin);
      });
    });

    scheduleIconWork();
    updateRenderChip();
  }

  function render() {
    renderHeader();
    renderBody();
    if (ui.sheet) renderSheet();
  }

  /* =============================================================== toast == */

  function toast(msg, err) {
    const t = $('tg-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('tg-toast-err', !!err);
    t.classList.add('tg-toast-show');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { t.classList.remove('tg-toast-show'); }, 3200);
  }

  /* ========================================================== lifecycle == */

  function onShow() {
    ui.visible = true;
    state.listAsked = true;
    refresh();
    const s = $('tg-search');
    if (s) { s.value = ui.q; setTimeout(function () { s.focus(); }, 30); }
    render();
  }

  function onHide() {
    ui.visible = false;
    closeSheet();
    if (window.HDLightbox) HDLightbox.close();
    if (ui.debT) { clearTimeout(ui.debT); ui.debT = null; }
    if (chipT) { clearTimeout(chipT); chipT = null; }
    if (renderChip) renderChip.classList.remove('tg-on');
    stopIconPoll();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* omni jump: land on the tab with the gear filter pre-filled */
  function setFilter(text) {
    ui.q = String(text || '');
    ui.page = 0;      // a new filter always starts at its first page
    const s = $('tg-search');
    if (s) s.value = ui.q;
    if (ui.visible) renderBody();
  }

  function init() {
    const s = $('tg-search');
    if (s) {
      s.addEventListener('input', function () {
        ui.q = s.value.trim();
        ui.sel = 0;
        ui.page = 0;
        renderBody();
      });
      s.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          /* Enter = open the donor picker for the selected row (top hit).
             preventDefault + stopPropagation so Enter never leaks to the
             deck's global handler. Transmogged top hit: Enter reverts —
             the row's one verb. */
          e.preventDefault(); e.stopPropagation();
          const rows = filteredRows();
          const r = rows[Math.min(ui.sel, rows.length - 1)] || rows[0];
          if (!r) return;
          if (r.tmog) revertRow(r);
          else openSheet(r);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const rows = filteredRows();
          if (rows.length) {
            /* selection may walk off this page — follow it there rather than
               stopping at the page edge, which would feel broken */
            ui.sel = e.key === 'ArrowDown'
              ? Math.min(rows.length - 1, ui.sel + 1)
              : Math.max(0, ui.sel - 1);
            ui.page = Math.floor(ui.sel / PAGE_SIZE);
            renderBody();
            const el = document.querySelector('#tg-body .tg-sel');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          }
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape') {
          if (ui.sheet) { closeSheet(); e.stopPropagation(); }
          else if (s.value) { s.value = ''; ui.q = ''; ui.page = 0; renderBody(); e.stopPropagation(); }
          /* bare Esc falls through to the palette's close, on purpose */
        }
      });
    }

    /* Renders land whenever the framework gets to them. The group's onLand is the
       upgrade path now (HDArt taps the reply itself), so the pane no longer
       listens for 'hd-item-icons' — one less thing a new surface must know. The
       listener is kept ONLY as a bridge for anything still dispatching it. */
    try {
      document.addEventListener('hd-item-icons', onArtLanded);
    } catch (e) { /* no DOM in some harnesses */ }

    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  const DEV_ITEMS = [
    { plugin: 'Skyrim.esm', formId: '0x012E49', ix: 0, name: 'Steel Plate Armor of Health', count: 1,
      worn: true, ench: true, kind: 'armo', slot: 4, wtype: -1,
      stats: { ar: 40, val: 700, wt: 38 }, tmog: null },
    { plugin: 'Skyrim.esm', formId: '0x013939', ix: -1, name: 'Iron Helmet', count: 2,
      worn: false, ench: false, kind: 'armo', slot: 1, wtype: -1,
      stats: { ar: 15, val: 60, wt: 5 }, tmog: null },
    { plugin: 'Skyrim.esm', formId: '0x01359D', ix: 0, name: 'Skyforge Steel Sword', count: 1,
      worn: true, ench: false, kind: 'weap', slot: 0, wtype: 1,
      stats: { dmg: 11, crit: 5, speed: 1, reach: 1, stagger: 0.75, val: 210, wt: 9 }, tmog: null },
    { plugin: 'SkyManagerTransmog.esp', formId: '0x000800', ix: 0, name: 'Ebony Mail', count: 1,
      worn: true, ench: true, kind: 'armo', slot: 4, wtype: -1,
      stats: { ar: 45, val: 5000, wt: 28 },
      tmog: { slot: 0, statName: 'Ebony Mail', donorName: 'Court Silks',
        donorMissing: false, edited: true, own: false } },
  ];
  const DEV_DONORS = [
    { plugin: 'Skyrim.esm', formId: '0x01396B', n: 'Ebony Armor', v: 1500, w: 38, slot: 4 },
    { plugin: 'Sexy Vanilla Armors.esp', formId: '0x000D64', n: 'Court Silks', v: 120, w: 2, slot: 4 },
    { plugin: 'Skyrim.esm', formId: '0x013952', n: 'Ebony Helmet', v: 750, w: 10, slot: 1 },
  ];
  const DEV_WEAP_DONORS = [
    { plugin: 'Skyrim.esm', formId: '0x014A69', n: 'Glass Sword', v: 410, w: 14, slot: 0, t: 1 },
    { plugin: 'Skyrim.esm', formId: '0x013989', n: 'Ebony Bow', v: 1440, w: 16, slot: 0, t: 7 },
  ];

  function devState() {
    window.tgStateResult({ esp: true, used: 1, total: 128,
      active: [{ index: 0, statName: 'Ebony Mail', donorName: 'Court Silks',
        stat: { plugin: 'Skyrim.esm', formId: '0x013961' },
        donor: { plugin: 'Sexy Vanilla Armors.esp', formId: '0x000D64' },
        worn: true, donorMissing: false }] });
  }
  function devList() { window.tgListData({ ok: true, esp: true, items: DEV_ITEMS }); }
  function devDonors(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    const q = String(req.q || '').toLowerCase();
    const pool = req.kind === 'weap' ? DEV_WEAP_DONORS : DEV_DONORS;
    let rows = pool.filter(function (d) {
      if (req.kind === 'weap') {
        if (req.wtype != null && req.wtype >= 0 && d.t !== req.wtype) return false;
      } else if (req.slot && !(d.slot & req.slot)) return false;
      return !q || (d.n + ' ' + d.plugin).toLowerCase().indexOf(q) !== -1;
    });
    window.tgDonorsData({ seq: req.seq | 0, total: rows.length, items: rows });
  }
  function devStats(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    if (req.slot != null && req.slot >= 0) {
      window.tgStatsResult({ ok: true, kind: 'armo', slot: req.slot | 0,
        name: 'Ebony Mail', origName: 'Ebony Mail',
        base: { ar: 45, val: 5000, wt: 28 },
        cur: { ar: 60, val: 5000, wt: 10 },
        ov: { armorRating: 60, weight: 10 } });
      return;
    }
    window.tgStatsResult({ ok: true, kind: 'weap', slot: -1,
      name: 'Skyforge Steel Sword', origName: 'Skyforge Steel Sword',
      base: { dmg: 11, crit: 5, speed: 1, reach: 1, stagger: 0.75, val: 210, wt: 9 },
      cur: { dmg: 11, crit: 5, speed: 1, reach: 1, stagger: 0.75, val: 210, wt: 9 },
      ov: {} });
  }
  function devApply(arg) {
    let req = {};
    try { req = JSON.parse(arg); } catch (e) {}
    window.tgApplyResult({ ok: true, msg: req.name + ' now looks like the donor', slot: 1 });
  }
  function devRevert(arg) {
    window.tgRevertResult({ ok: true, msg: 'It looks like itself again', slot: 0 });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }
    ui.visible = true;
    devState(); devList();
    ok('state: chip', state.used === 1 && state.total === 128);
    ok('list: rows', state.items.length === 3);
    render();
    ok('rows in DOM', document.querySelectorAll('#tg-body .tg-row').length === 3);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'transmog', label: 'Transmog', tab: 'transmog',
    setFilter: setFilter,
    index: function () {
      const out = [{
        label: 'Transmog',
        detail: 'Restyle a specific piece of your gear to look like any armor any mod ships',
        kind: 'transmog',
        keywords: 'transmog glamour restyle appearance look armor outfit skin cosmetic wardrobe donor',
      }];
      (state.active || []).forEach(function (a) {
        out.push({
          label: a.statName + ' → ' + a.donorName,
          detail: 'Active transmog' + (a.worn ? ' (worn)' : '') +
            (a.donorMissing ? ' — donor mod is gone' : ''),
          kind: 'transmog',
          keywords: 'transmog ' + a.statName + ' ' + a.donorName,
        });
      });
      return out;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _state: state, _ui: ui,
    _filteredRows: filteredRows, _pagedRows: pagedRows, _pageCount: pageCount,
    _pageSize: PAGE_SIZE, _rowKey: rowKey,
    _openSheet: openSheet, _closeSheet: closeSheet, _pickDonor: pickDonor,
    _queryDonors: queryDonors,
    _applyConfirm: applyConfirm, _revertRow: revertRow,
    _openStats: openStats, _applyStats: applyStats, _statOverrides: statOverrides,
    _statSummaryText: statSummaryText,
    _flushIcons: flushIconsForTest, _iconPollTick: iconPollTick, _missingArt: missingArt,
    _armWindow: function () { chipLastLand = Date.now(); },
    _closeWindow: function () { chipLastLand = 1; },
    _rowLoading: rowLoading, _renderWindowActive: renderWindowActive,
    _iconFor: iconFor,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.TransmogPane.init(); });
} else {
  window.TransmogPane.init();
}
