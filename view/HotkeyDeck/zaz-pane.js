'use strict';

/* ====================================================================== *
 *  ZaZ — the deck's hook into ZaZ Animation Pack (ZAP 8.0+), living as the
 *  third segment ("ZaZ") of the Animations tab, beside Poses and OStim
 *  (Rober, 2026-08-15: "Animations tab has hook support for ostim with a
 *  tab — I want the same for my version of Zaz").
 *
 *  Two sub-views over one search bar:
 *    ⛓ Devices   — every zbf-keyword wearable in the load order (C++
 *                  enumerates at runtime, so it fits WHATEVER ZaZ variant is
 *                  installed), grouped by ZAP's own zbfWorn* taxonomy, with
 *                  live worn state on the target. Wear = ZAP's own equip
 *                  path (its zbf effect script rides the equip event; the
 *                  bound pose takes hold when the deck closes/unpauses).
 *    🪑 Furniture — ZaZ furniture loaded around you (crosses, pillories,
 *                  poles…), nearest first; "Use" walks the TARGET onto it
 *                  through the deck's alias engine and closes the palette
 *                  (the walk-over is Papyrus work — party-orders law).
 *
 *  Target = the Animations tab's own rule: the crosshair NPC snapshotted at
 *  palette open, else you.
 *
 *  C++ (zaz_deck.cpp) owns the enumeration + equip/seat verbs; this pane
 *  owns the UI. Bridge — JS->C++ requests:
 *    zzGet() · zzPoll() · zzAct({op,key}) · zzUse({ref}) · zzLog(str)
 *  C++->JS replies (names disjoint from the requests, per the deck law):
 *    zzOpen(state) · zzState(live) · zzResult({ok,msg,wornKeys,close})
 *  All replies are RESPONSE-style (the pane always asks first), so hd-boot
 *  needs no buffering stub for them.
 *
 *  It hangs off AnimPane's lifecycle exactly like OStimPane: onAnimShow()/
 *  onAnimHide(), with #an-seg-zaz flipping #an-pane into .mode-zaz.
 * ====================================================================== */

window.ZazPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const RENDER_CAP = 200;   // rows painted at once — keep typing to narrow

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV) devBridge(fn, arg);
    }
  }
  function glog(msg) { toGame('zzLog', msg); }

  /* --------------------------------------------------- dev / browser mock */

  const DEV_DEVICES = [
    { key: 'ZaZAnimationPack.esm|00A101', name: 'Leather Armbinder', cat: 'Wrist', worn: false },
    { key: 'ZaZAnimationPack.esm|00A102', name: 'Iron Shackles', cat: 'Wrist', worn: true },
    { key: 'ZaZAnimationPack.esm|00A103', name: 'Rope Wrist Ties', cat: 'Wrist', worn: false },
    { key: 'ZaZAnimationPack.esm|00A201', name: 'Panel Gag', cat: 'Gag', worn: false },
    { key: 'ZaZAnimationPack.esm|00A202', name: 'Ball Gag (black)', cat: 'Gag', worn: false },
    { key: 'ZaZAnimationPack.esm|00A301', name: 'Leather Collar', cat: 'Collar', worn: false },
    { key: 'ZaZAnimationPack.esm|00A401', name: 'Leather Blindfold', cat: 'Blindfold', worn: false },
    { key: 'ZaZAnimationPack.esm|00A501', name: 'Ankle Chains', cat: 'Ankles', worn: false },
  ];
  const DEV_FURN = [
    { ref: '0x00120001', name: 'X-Cross', m: 4 },
    { ref: '0x00120002', name: 'Pillory', m: 9 },
    { ref: '0x00120003', name: 'Wooden Pony', m: 15 },
  ];
  let devWorn = { 'ZaZAnimationPack.esm|00A102': true };
  function devStateJson() {
    return {
      zap: true,
      target: { player: false, name: 'Lydia', formId: 42, dead: false },
      devices: DEV_DEVICES.map((d) => ({ ...d, worn: !!devWorn[d.key] })),
      wornKeys: Object.keys(devWorn).filter((k) => devWorn[k]),
      furniture: DEV_FURN.slice(),
    };
  }
  function devBridge(fn, arg) {
    if (fn === 'zzGet') { setTimeout(() => window.zzOpen(JSON.stringify(devStateJson())), 20); return; }
    if (fn === 'zzPoll') { setTimeout(() => window.zzState(JSON.stringify(devStateJson())), 20); return; }
    if (fn === 'zzAct') {
      let j = {}; try { j = JSON.parse(arg); } catch (e) {}
      if (j.op === 'free') devWorn = {};
      else if (j.op === 'apply') devWorn[j.key] = true;
      else if (j.op === 'remove') delete devWorn[j.key];
      const msg = j.op === 'free' ? '🧹 Lydia is free — devices off'
        : (j.op === 'apply' ? '⛓ device on — takes hold when the deck closes' : '✓ device off');
      setTimeout(() => window.zzResult(JSON.stringify({
        ok: true, msg, wornKeys: Object.keys(devWorn).filter((k) => devWorn[k]),
      })), 20);
      return;
    }
    if (fn === 'zzUse') {
      setTimeout(() => window.zzResult(JSON.stringify({
        ok: true, msg: 'Lydia -> X-Cross (walking over)', close: true,
      })), 20);
      return;
    }
  }

  /* ============================================================= state == */

  const state = {
    zap: true,            // C++'s live probe (the ESM in the load order)
    target: { player: true, name: 'You', formId: 0, dead: false },
    devices: [],          // [{key,name,cat,worn}]
    furniture: [],        // [{ref,name,m}]
  };
  const ui = { inited: false, active: false, sub: 'dev', query: '', cat: 'All', gotOpen: false, toastT: 0 };

  const els = {};
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* ============================================================ render == */

  function cats() {
    const seen = {};
    const out = [];
    for (const d of state.devices) {
      if (!seen[d.cat]) { seen[d.cat] = 0; out.push(d.cat); }
      seen[d.cat]++;
    }
    out.sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
    return { names: out, counts: seen };
  }

  function deviceRows() {
    const q = ui.query.trim().toLowerCase();
    const out = [];
    for (const d of state.devices) {
      if (ui.cat !== 'All' && d.cat !== ui.cat) continue;
      if (q && (d.name + ' ' + d.cat).toLowerCase().indexOf(q) === -1) continue;
      out.push(d);
    }
    // worn first inside the current scope — what she wears is what you manage
    out.sort((a, b) => (b.worn ? 1 : 0) - (a.worn ? 1 : 0));
    return out;
  }

  function furnRows() {
    const q = ui.query.trim().toLowerCase();
    return state.furniture.filter((f) => !q || f.name.toLowerCase().indexOf(q) !== -1);
  }

  function herIs() { return state.target.player ? 'You are' : esc(state.target.name) + ' is'; }

  function renderStatus() {
    if (!els.target) return;
    els.body.classList.toggle('zz-nozap', !state.zap);
    if (!state.zap) {
      els.target.textContent = 'ZaZ Animation Pack not detected';
      els.targetHint.textContent = 'Is ZaZAnimationPack.esm enabled?';
      els.worn.textContent = '';
      return;
    }
    els.target.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'zz-tgt-dot' + (state.target.player ? ' me' : '');
    els.target.append(dot, document.createTextNode('Applying to '));
    const nm = document.createElement('span');
    nm.className = 'zz-tgt-name';
    nm.textContent = state.target.player ? 'You' : esc(state.target.name);
    els.target.append(nm);
    els.targetHint.textContent = state.target.dead
      ? '⚠ She is dead — devices still equip, furniture won’t work.'
      : 'Whoever you were looking at when the deck opened — or you, if nothing.';

    // worn chips — one per device on her, ✕ takes it off
    els.worn.textContent = '';
    const worn = state.devices.filter((d) => d.worn);
    if (!worn.length) {
      const none = document.createElement('span');
      none.className = 'zz-worn-none';
      none.textContent = herIs() + ' wearing no ZaZ gear.';
      els.worn.append(none);
    }
    for (const d of worn) {
      const chip = document.createElement('span');
      chip.className = 'zz-worn-chip';
      chip.title = d.cat + ' — click ✕ to take it off';
      const label = document.createElement('span');
      label.textContent = d.name;
      const x = document.createElement('button');
      x.className = 'zz-worn-x';
      x.textContent = '✕';
      x.title = 'Take ' + d.name + ' off';
      x.addEventListener('click', () => act('remove', d));
      chip.append(label, x);
      els.worn.append(chip);
    }
    if (els.free) els.free.disabled = !worn.length;
  }

  function renderPills() {
    if (!els.pills) return;
    els.pills.classList.toggle('hidden', ui.sub !== 'dev');
    els.pills.textContent = '';
    if (ui.sub !== 'dev') return;
    const { names, counts } = cats();
    const mk = (name, count) => {
      const b = document.createElement('button');
      b.className = 'zz-pill' + (ui.cat === name ? ' active' : '');
      b.textContent = name + (count ? ' (' + count + ')' : '');
      b.addEventListener('click', () => { ui.cat = name; renderPills(); renderList(); });
      els.pills.append(b);
    };
    mk('All', state.devices.length);
    for (const n of names) mk(n, counts[n]);
  }

  function renderList() {
    if (!els.list) return;
    els.list.textContent = '';
    if (!state.zap) {
      const empty = document.createElement('div');
      empty.className = 'zz-empty';
      empty.textContent = 'ZaZ Animation Pack isn’t in the load order.';
      els.list.append(empty);
      els.count.textContent = '—';
      return;
    }

    if (ui.sub === 'furn') {
      const rows = furnRows();
      els.count.textContent = rows.length + (rows.length === 1 ? ' piece' : ' pieces');
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'zz-empty';
        empty.textContent = ui.query.trim()
          ? 'No nearby ZaZ furniture matches “' + ui.query.trim() + '”.'
          : 'No ZaZ furniture loaded nearby — walk closer to a cross, pillory or pole, then ⟳.';
        els.list.append(empty);
        return;
      }
      for (const f of rows) {
        const row = document.createElement('div');
        row.className = 'zz-row';
        const main = document.createElement('div');
        main.className = 'zz-row-main';
        const name = document.createElement('div');
        name.className = 'zz-row-name';
        name.textContent = f.name;
        const meta = document.createElement('div');
        meta.className = 'zz-row-meta';
        meta.textContent = '~' + f.m + ' m away';
        main.append(name, meta);
        const btn = document.createElement('button');
        btn.className = 'zz-go';
        if (state.target.player) {
          btn.disabled = true;
          btn.textContent = 'Use';
          btn.title = 'Sends an NPC — walk up and activate it yourself. Look at someone before opening the deck.';
        } else {
          btn.textContent = 'Use';
          btn.title = 'Send ' + esc(state.target.name) + ' to ' + f.name + ' — she walks over; the deck closes so she can';
          btn.addEventListener('click', () => useFurn(f));
        }
        row.append(main, btn);
        if (!state.target.player) row.addEventListener('click', (ev) => { if (ev.target !== btn) useFurn(f); });
        els.list.append(row);
      }
      return;
    }

    const rows = deviceRows();
    els.count.textContent = rows.length + (rows.length === 1 ? ' device' : ' devices');
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'zz-empty';
      empty.textContent = ui.query.trim()
        ? 'No device matches “' + ui.query.trim() + '”' + (ui.cat !== 'All' ? ' in ' + ui.cat : '') + '.'
        : 'No zbf-keyword devices found in the load order.';
      els.list.append(empty);
      return;
    }
    const shown = Math.min(rows.length, RENDER_CAP);
    for (let i = 0; i < shown; i++) {
      const d = rows[i];
      const row = document.createElement('div');
      row.className = 'zz-row' + (d.worn ? ' worn' : '');
      const main = document.createElement('div');
      main.className = 'zz-row-main';
      const name = document.createElement('div');
      name.className = 'zz-row-name';
      name.textContent = d.name;
      name.title = d.key;
      const meta = document.createElement('div');
      meta.className = 'zz-row-meta';
      meta.textContent = d.cat + (d.worn ? ' · worn' : '');
      main.append(name, meta);
      const btn = document.createElement('button');
      btn.className = 'zz-go' + (d.worn ? ' off' : '');
      btn.textContent = d.worn ? 'Take off' : 'Wear';
      btn.title = d.worn
        ? 'Take ' + d.name + ' off ' + (state.target.player ? 'yourself' : esc(state.target.name))
        : 'Put ' + d.name + ' on ' + (state.target.player ? 'yourself' : esc(state.target.name));
      btn.addEventListener('click', () => act(d.worn ? 'remove' : 'apply', d));
      row.append(main, btn);
      row.addEventListener('click', (ev) => { if (ev.target !== btn) act(d.worn ? 'remove' : 'apply', d); });
      els.list.append(row);
    }
    if (rows.length > shown) {
      const more = document.createElement('div');
      more.className = 'zz-more';
      more.textContent = (rows.length - shown) + ' more — keep typing to narrow it down.';
      els.list.append(more);
    }
  }

  function renderAll() { renderStatus(); renderPills(); renderList(); }

  function toast(msg, ok) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = 'zz-toast show' + (ok === false ? ' bad' : '');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(() => { els.toast.className = 'zz-toast'; }, 2600);
  }

  /* Our toast shares its coordinates with #an-toast / #os-toast, so leaving the
     segment must clear it — see OStimPane.hideToast. */
  function hideToast() {
    if (!els.toast) return;
    clearTimeout(ui.toastT);
    els.toast.className = 'zz-toast';
  }

  /* =========================================================== actions == */

  function act(op, d) {
    if (!state.zap) return;
    toGame('zzAct', JSON.stringify(op === 'free' ? { op: 'free' } : { op, key: d.key }));
    glog(op + (d ? ' ' + d.key : ''));
  }

  function useFurn(f) {
    if (!state.zap || state.target.player) return;
    toGame('zzUse', JSON.stringify({ ref: f.ref }));
    glog('use ' + f.ref);
  }

  function setSub(sub) {
    ui.sub = (sub === 'furn') ? 'furn' : 'dev';
    if (els.subDev) els.subDev.classList.toggle('active', ui.sub === 'dev');
    if (els.subFurn) els.subFurn.classList.toggle('active', ui.sub === 'furn');
    if (els.search) {
      els.search.placeholder = ui.sub === 'furn'
        ? 'Filter nearby ZaZ furniture…'
        : 'Search devices… (Enter wears the top hit)';
    }
    renderPills();
    renderList();
  }

  /* =========================================================== receive == */

  function applyWornKeys(keys) {
    if (!Array.isArray(keys)) return;
    const set = {};
    for (const k of keys) set[k] = true;
    for (const d of state.devices) d.worn = !!set[d.key];
  }

  function receive(key, info) {
    let j = null;
    if (typeof info === 'string') { try { j = JSON.parse(info); } catch (e) { j = null; } }
    else if (info && typeof info === 'object') { j = info; }

    if (key === 'open') {
      if (!j || typeof j !== 'object') return true;
      ui.gotOpen = true;
      state.zap = j.zap !== false;
      if (j.target && typeof j.target === 'object') state.target = j.target;
      if (Array.isArray(j.devices)) state.devices = j.devices;
      if (Array.isArray(j.furniture)) state.furniture = j.furniture;
      renderAll();
      return true;
    }
    if (key === 'state') {
      if (j && typeof j === 'object') {
        state.zap = j.zap !== false;
        if (j.target && typeof j.target === 'object') state.target = j.target;
        applyWornKeys(j.wornKeys);
        if (Array.isArray(j.furniture)) state.furniture = j.furniture;
        renderAll();
      }
      return true;
    }
    if (key === 'result') {
      if (j && typeof j === 'object') {
        applyWornKeys(j.wornKeys);
        renderAll();
        if (j.msg) toast(esc(j.msg), j.ok !== false);
        // A furniture send only works unpaused (the walk-over is alias/Papyrus
        // work) — C++ says close:true and we close the palette, skins-precedent.
        if (j.ok !== false && j.close === true &&
            typeof window.requestClose === 'function') {
          setTimeout(() => { try { window.requestClose(); } catch (e) {} }, 350);
        }
      }
      return true;
    }
    return false;
  }

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
    window[name].__zzReceiver = true;
  }

  /* ========================================================= mode / show == */

  function active() {
    const pane = $('an-pane');
    return !!(pane && pane.classList.contains('mode-zaz'));
  }

  // Leave the ZaZ segment (called by OStimPane.setMode and AnimPane.setView so
  // the three-way seg row can never show two bodies at once).
  function leave() {
    ui.active = false;
    const pane = $('an-pane');
    if (pane) pane.classList.remove('mode-zaz');
    if (els.segZaz) els.segZaz.classList.remove('active');
    hideToast();
  }

  function setMode(mode) {
    if (mode !== 'zaz') { leave(); return; }
    init();
    // OStim's setMode('poses') clears its own mode + poll (and calls our
    // leave(), harmlessly); then we take the pane.
    if (window.OStimPane && typeof OStimPane.setMode === 'function') OStimPane.setMode('poses');
    // that cleared the OStim + ZaZ toasts; the Poses one is ours to take down
    if (window.AnimPane && AnimPane.hideToast) AnimPane.hideToast();
    ui.active = true;
    const pane = $('an-pane');
    if (pane) pane.classList.add('mode-zaz');
    // deactivate every other segment button; ours goes gold
    const seg = $('an-seg');
    if (seg) for (const b of seg.querySelectorAll('.an-seg-btn')) b.classList.remove('active');
    if (els.segZaz) els.segZaz.classList.add('active');
    toGame('zzGet');
    if (els.search) els.search.focus();
  }

  /* ZaZ detected-absent (explicit false only) off app.js's shared-scope
     detection — same install-time gate law as the OStim segment ("if someone
     doesn't have a supported mod it shouldn't show up"). */
  function zazGatedOut() {
    try {
      return (typeof window.__hdFlagAbsent === 'function') && window.__hdFlagAbsent('zap');
    } catch (e) { return false; }
  }
  function applyZazGate() {
    const gone = zazGatedOut();
    if (els.segZaz) els.segZaz.classList.toggle('hidden', gone);
    if (els.body && gone) els.body.classList.add('hidden');
    if (gone && active()) leave();
  }

  function init() {
    if (ui.inited) return true;
    if (!$('zz-body')) { console.log('[zaz] #zz-body missing — index.html not updated?'); return false; }
    ui.inited = true;

    els.body = $('zz-body');
    els.target = $('zz-target');
    els.targetHint = $('zz-target-hint');
    els.worn = $('zz-worn');
    els.subDev = $('zz-sub-dev');
    els.subFurn = $('zz-sub-furn');
    els.free = $('zz-free');
    els.refresh = $('zz-refresh');
    els.search = $('zz-search');
    els.count = $('zz-count');
    els.pills = $('zz-pills');
    els.list = $('zz-list');
    els.toast = $('zz-toast');
    els.segZaz = $('an-seg-zaz');

    els.subDev && els.subDev.addEventListener('click', () => setSub('dev'));
    els.subFurn && els.subFurn.addEventListener('click', () => setSub('furn'));
    els.free && els.free.addEventListener('click', () => act('free'));
    els.refresh && els.refresh.addEventListener('click', () => toGame('zzPoll'));

    els.search && els.search.addEventListener('input', () => {
      ui.query = els.search.value || '';
      renderList();
    });
    els.search && els.search.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      if (ui.sub === 'furn') {
        const rows = furnRows();
        if (rows.length && !state.target.player) useFurn(rows[0]);
      } else {
        const rows = deviceRows();
        if (rows.length) act(rows[0].worn ? 'remove' : 'apply', rows[0]);
      }
    });

    els.segZaz && els.segZaz.addEventListener('click', () => setMode('zaz'));

    chain('zzOpen', 'open');
    chain('zzState', 'state');
    chain('zzResult', 'result');

    if (SELFTEST) setTimeout(selftest, 80);
    return true;
  }

  // Called by AnimPane when the Animations tab opens / closes.
  function onAnimShow() {
    if (!init()) return;
    applyZazGate();
    if (els.search) els.search.value = ui.query;
    if (!zazGatedOut() && active()) toGame('zzGet');
  }
  function onAnimHide() {}

  /* Land ON this segment, in the sub-view the row belongs to (Omni rows). */
  function enter(sub) {
    if (!init()) return;
    if (zazGatedOut()) return;   // never land on a hidden segment
    if (window.__omniSetTab) window.__omniSetTab('anim');
    else if (window.setTab) window.setTab('anim');
    setMode('zaz');
    setSub(sub === 'furn' ? 'furn' : 'dev');
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'zaz', label: 'ZaZ devices', tab: 'anim',
    setFilter: function (q) {
      setMode('zaz'); setSub('dev');
      ui.query = q || ''; if (els.search) els.search.value = ui.query;
      renderList();
    },
    /* Devices arrive with zzOpen, which is asked in onAnimShow() — so until the
       player had opened the Animations tab this session, searching "armbinder"
       found nothing. Asked ONCE, when we hold nothing: C++ enumerates every
       zbf-keyword item and the refs around you for this reply, and paying that
       on every omni open would hitch the view; entering the segment refreshes
       it from then on. */
    warm: function () { if (!zazGatedOut() && !ui.gotOpen) toGame('zzGet'); },
    index: function () {
      if (zazGatedOut()) return [];
      const items = [];

      /* The segment has to answer to its own name even while we hold no data —
         cold, both loops below are empty and "zaz" matched nothing in the whole
         deck. */
      items.push({
        label: 'ZaZ devices & furniture',
        detail: 'Animations tab · restraints, gags and the ZaZ furniture near you',
        kind: 'zaz',
        keywords: 'zaz zap bondage restraint device gag furniture segment animation pack',
        run: function () { enter('dev'); },
      });

      /* Free completely — the undo for everything else in the segment. */
      const worn = state.devices.filter((d) => d.worn);
      if (worn.length) items.push({
        label: '🧹 Free completely',
        detail: 'ZaZ · take all ' + worn.length + ' device' + (worn.length === 1 ? '' : 's') +
          ' off ' + (state.target.player ? 'you' : esc(state.target.name)),
        kind: 'zaz',
        keywords: 'free unbind release remove strip restraints devices untie everything off',
        run: function () { act('free'); },
      });

      for (const d of state.devices) {
        items.push({
          label: d.name,
          detail: 'ZaZ device · ' + d.cat + (d.worn ? ' · worn' : ''),
          kind: 'zaz',
          keywords: 'zaz zap device restraint bondage ' + d.cat + ' ' + d.key,
          run: function () { act(d.worn ? 'remove' : 'apply', d); },
        });
      }

      for (const f of state.furniture) {
        const item = {
          label: f.name,
          detail: 'ZaZ furniture · ~' + f.m + ' m away',
          kind: 'zaz',
          keywords: 'zaz zap furniture cross pillory pole cage bench nearby use send',
          /* Jumping lands on the furniture sub-view with this piece already
             filtered for — the devices sub-view the provider's setFilter opens
             would not show it at all. */
          jump: function () {
            enter('furn');
            ui.query = f.name;
            if (els.search) els.search.value = ui.query;
            renderList();
          },
        };
        /* Sending someone needs someone to send: with no NPC target useFurn
           refuses in silence, so the row stays jump-only and the sub-view's own
           disabled Use button gives the reason. */
        if (!state.target.player) item.run = function () { useFurn(f); };
        items.push(item);
      }

      return items;
    },
  });

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);

    const pane = $('an-pane'); if (pane) pane.classList.remove('hidden');
    setMode('zaz');

    setTimeout(() => {
      ok('zz-body exists', !!$('zz-body'));
      ok('pane switched to mode-zaz', pane.classList.contains('mode-zaz'));
      ok('seg zaz active', els.segZaz && els.segZaz.classList.contains('active'));
      ok('got open payload', ui.gotOpen);
      ok('target shows Lydia', /Lydia/.test(els.target.textContent));
      ok('worn chip rendered', els.worn.querySelectorAll('.zz-worn-chip').length === 1);
      ok('device rows rendered', els.list.querySelectorAll('.zz-row').length >= 6);
      ok('worn row sorts first', els.list.querySelector('.zz-row').classList.contains('worn'));
      ok('category pills rendered', els.pills.querySelectorAll('.zz-pill').length >= 5);

      // narrow by category pill
      const gagPill = Array.from(els.pills.querySelectorAll('.zz-pill')).find((b) => /^Gag/.test(b.textContent));
      gagPill && gagPill.click();
      ok('Gag pill narrows to 2', els.list.querySelectorAll('.zz-row').length === 2);
      ui.cat = 'All'; renderPills(); renderList();

      // search narrows
      els.search.value = 'armbinder'; els.search.dispatchEvent(new Event('input'));
      ok('search narrows to Armbinder', els.list.querySelectorAll('.zz-row').length === 1);

      // apply the top hit via Enter, dev bridge marks it worn
      els.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      setTimeout(() => {
        ok('apply toasts', els.toast.classList.contains('show'));
        ok('armbinder now worn (2 chips)', els.worn.querySelectorAll('.zz-worn-chip').length === 2);

        // free strips everything
        els.search.value = ''; els.search.dispatchEvent(new Event('input'));
        els.free.click();
        setTimeout(() => {
          ok('free empties worn chips', els.worn.querySelectorAll('.zz-worn-chip').length === 0);
          ok('free button disables once bare', els.free.disabled === true);

          // furniture sub-view
          setSub('furn');
          ok('furniture rows rendered', els.list.querySelectorAll('.zz-row').length === 3);
          ok('distance shown', /m away/.test(els.list.textContent));

          // mutual exclusion with poses/ostim
          if (window.OStimPane) {
            OStimPane.setMode('ostim');
            ok('ostim entry clears mode-zaz', !pane.classList.contains('mode-zaz'));
            OStimPane.setMode('poses');
          } else {
            ok('ostim entry clears mode-zaz (skipped — no OStimPane)', true);
          }
          setMode('zaz');
          ok('receivers tagged', window.zzOpen.__zzReceiver === true && window.zzResult.__zzReceiver === true);
          ok('no receiver on a REQUEST name', typeof window.zzGet !== 'function' || window.zzGet.__zzReceiver !== true);

          const fails = out.filter((l) => l.indexOf('FAIL') === 0);
          window.__zzSelftest = window.__selftest = {
            pass: out.length - fails.length, total: out.length, results: out,
          };
          const box = document.createElement('pre');
          box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
            'background:#111;color:#ddd;padding:10px;border:1px solid ' +
            (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
          box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
          document.body.append(box);
          console.log(out.join('\n'));
        }, 60);
      }, 60);
    }, 120);
  }

  return {
    init, onAnimShow, onAnimHide, setMode, leave, active, hideToast,
    _state: state, _ui: ui   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.ZazPane.init());
} else {
  window.ZazPane.init();
}
