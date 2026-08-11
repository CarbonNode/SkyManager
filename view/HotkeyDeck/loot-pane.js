'use strict';

/* ====================================================================== *
 *  Loot — Loot Highlighter tab pane inside the Hotkey Deck view.
 *
 *  The ask (Rober, 2026-08-04, after seeing "Clairvoyance Shines Treasures"):
 *  glow the loot worth walking to — LOTD pieces the museum still wants,
 *  chests, unlooted corpses (glow dies when looted), coins/picks, potions,
 *  soul gems, skill books, gear over a value/weight bar — with per-category
 *  toggles and colours. C++ owns the scanner; this pane owns every setting.
 *
 *  Self-contained like the other panes: owns its DOM (lt- prefixed), never
 *  touches app.js state.
 *
 *  Bridge — C++ registers these JS→C++ listeners on the deck view:
 *    ltGet() · ltSave(json) · ltToggle() · ltState() · ltLog(str)
 *  C++ pushes back (names disjoint from the above, per the deck law):
 *    ltOpen(cfg+palette+lotd) · ltResult({ok,msg,enabled}) · ltSaved(ok) ·
 *    ltStateResult({active,cats})
 *
 *  Host contract (mirrors RoomsPane/TimePane): LootPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome of its own — the shared size card
 *  covers it) · wantsPause() -> true
 * ====================================================================== */

window.LootPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const SAVE_DEBOUNCE = 350;   // same cadence as the other panes
  const STATE_POLL = 2000;     // live glow counts while the tab is up

  /* What each category key means, for humans. C++ owns the key list; a key
     with no entry here still renders (raw key as its name), so a category
     added C++-side is usable before this map learns its copy. */
  const CAT_TEXT = {
    lotd:     ['Museum pieces', 'Items Legacy of the Dragonborn still wants — TCC’s own tracking, so what you’ve found or displayed stays dark'],
    chests:   ['Chests & containers', 'Anything with a lid. Opening one puts its glow out (toggle below)'],
    safe:     ['Safe containers', 'Storage that never resets — barrels, chests and cupboards you can stash loot in without a cell reset eating it. Reads apart from the plain chest colour. Adopted from Highlight Safe Containers'],
    corpses:  ['Unlooted corpses', 'The fallen you haven’t searched yet — the glow dies the moment you open one'],
    coins:    ['Coins, lockpicks & keys', 'The quick grabs: loose gold, picks, keys'],
    valuables: ['Valuables & gems', 'Gems, claws, jeweled oddments, rare ingredients, pricey books — anything pocketable over the value bar below'],
    potions:  ['Potions & poisons', 'Bottles worth bending down for. Food stays dark'],
    soulgems: ['Soul gems', 'Empty or filled, they glow'],
    books:    ['Unread skill books', 'Skill books you haven’t read — a free level-up on a shelf'],
    gear:     ['Valuable gear', 'Weapons, armour and ammo over the worth-carrying bar (tune it below)'],
  };

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'ltGet') setTimeout(devOpen, 30);
      if (DEV && fn === 'ltToggle') {
        state.enabled = !state.enabled;
        window.ltResult(JSON.stringify({ ok: true, msg: 'dev toggle', enabled: state.enabled }));
      }
      if (DEV && fn === 'ltState') {
        window.ltStateResult(JSON.stringify({ ok: true, active: state.enabled ? 7 : 0,
          cats: state.enabled ? { chests: 3, corpses: 2, coins: 2 } : {} }));
      }
    }
  }
  function glog(msg) { toGame('ltLog', msg); }

  function devOpen() {
    window.ltOpen(JSON.stringify({
      enabled: false, notify: true, safeVision: false, tickMs: 1200, radius: 2200, maxGlows: 40,
      hideOpened: true, labelSafe: true, gearRatio: 10, gearMinValue: 250, valuableMinValue: 100,
      cats: [
        { key: 'lotd', on: true, color: 'violet' },
        { key: 'chests', on: true, color: 'gold' },
        { key: 'corpses', on: true, color: 'xray-blue' },
        { key: 'coins', on: true, color: 'gold' },
        { key: 'valuables', on: true, color: 'violet' },
        { key: 'potions', on: true, color: 'green' },
        { key: 'soulgems', on: true, color: 'blue' },
        { key: 'books', on: false, color: 'xray-red' },
        { key: 'gear', on: true, color: 'red' },
        { key: 'safe', on: true, color: 'green' },
      ],
      palette: [
        { id: 'gold', label: 'Gold', css: '#e8c55b', ok: true },
        { id: 'xray-blue', label: 'X-ray Blue', css: '#8fd8ff', ok: true },
        { id: 'xray-red', label: 'X-ray Red', css: '#ff6a5e', ok: true },
        { id: 'blue', label: 'Blue', css: '#6aa8ff', ok: true },
        { id: 'green', label: 'Green', css: '#7fe08a', ok: true },
        { id: 'violet', label: 'Violet', css: '#c08bff', ok: true },
        { id: 'red', label: 'Red', css: '#ff7b7b', ok: false },
      ],
      lotd: { ok: true, wanted: 2481, found: 903, displayed: 651 },
      active: 0,
    }));
  }

  /* ============================================================= state == */

  const state = {
    enabled: false, notify: true, safeVision: false,
    tickMs: 1200, radius: 2200, maxGlows: 40,
    hideOpened: true, labelSafe: false, gearRatio: 10, gearMinValue: 250, valuableMinValue: 100,
    cats: [],                      // [{key,on,color}] — order is C++'s
    lotdNew: 'dbmNew', lotdFound: 'dbmFound', lotdDisp: 'dbmDisp',
    palette: [],                   // [{id,label,css,ok}]
    lotd: { ok: false, wanted: 0, found: 0, displayed: 0 },
    counts: {},                    // live per-category glow counts
    active: 0,
  };

  const ui = { inited: false, shown: false, pollT: null, saveT: null, gotOpen: false };

  const els = {};
  const $ = (id) => document.getElementById(id);

  function esc(s) { return String(s === undefined || s === null ? '' : s); }

  /* ============================================================== save == */

  function slice() {
    return {
      enabled: state.enabled, notify: state.notify, safeVision: state.safeVision,
      tickMs: state.tickMs, radius: state.radius, maxGlows: state.maxGlows,
      hideOpened: state.hideOpened, labelSafe: state.labelSafe,
      gearRatio: state.gearRatio, gearMinValue: state.gearMinValue,
      valuableMinValue: state.valuableMinValue,
      cats: state.cats,
      lotdNew: state.lotdNew, lotdFound: state.lotdFound, lotdDisp: state.lotdDisp,
    };
  }

  function save() {
    clearTimeout(ui.saveT);
    ui.saveT = setTimeout(() => { toGame('ltSave', JSON.stringify(slice())); }, SAVE_DEBOUNCE);
  }

  /* ============================================================ render == */

  function meters(units) { return Math.round(units * 0.0143) + ' m'; }

  function renderMaster() {
    if (!els.master) return;
    els.master.classList.toggle('off', !state.enabled);
    els.masterState.textContent = state.enabled ? 'ON' : 'OFF';
    els.masterState.classList.toggle('on', state.enabled);
    const n = Number(state.active) || 0;
    els.active.textContent = !state.enabled
      ? 'Nothing is glowing.'
      : (n === 0 ? 'On — nothing in reach yet.' : n + ' thing' + (n === 1 ? '' : 's') + ' glowing near you.');
    renderSafe();
  }

  function renderSafe() {
    if (!els.safe) return;
    const on = !!state.safeVision;
    els.safe.classList.toggle('off', !on);
    els.safe.style.background = on ? 'rgba(120,210,140,.32)' : 'rgba(120,210,140,.12)';
    els.safe.style.borderColor = on ? 'rgba(150,235,170,.85)' : 'rgba(120,210,140,.45)';
    els.safe.style.color = on ? '#eafff0' : '#cfe6d5';
    els.safe.style.boxShadow = on ? '0 0 0 1px rgba(150,235,170,.35) inset' : 'none';
    els.safeState.textContent = on
      ? 'On — safe storage glows on its own.'
      : (state.enabled
        ? 'Off here — Loot Vision is on, so safe chests glow via the list.'
        : 'Off — safe storage not glowing on its own.');
  }

  function renderLotd() {
    if (!els.lotd) return;
    if (state.lotd.ok) {
      els.lotd.className = 'lt-hint ok';
      els.lotd.textContent = 'The Curator’s Companion is tracking ' + state.lotd.wanted +
        ' wanted item' + (state.lotd.wanted === 1 ? '' : 's') +
        ' (' + state.lotd.found + ' found, ' + state.lotd.displayed + ' displayed).';
    } else {
      els.lotd.className = 'lt-hint miss';
      els.lotd.textContent = 'TCC’s tracking lists (dbmNew) were not found — the Museum ' +
        'pieces category will stay dark. Everything else works.';
    }
  }

  function renderCats() {
    if (!els.cats) return;
    els.cats.textContent = '';
    for (const cat of state.cats) {
      const txt = CAT_TEXT[cat.key] || [cat.key, ''];
      const row = document.createElement('div');
      row.className = 'lt-cat' + (cat.on ? '' : ' offrow');
      row.setAttribute('role', 'listitem');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!cat.on;
      cb.title = (cat.on ? 'Stop' : 'Start') + ' highlighting ' + txt[0].toLowerCase();
      cb.addEventListener('change', () => {
        cat.on = cb.checked;
        row.classList.toggle('offrow', !cat.on);
        save();
        glog('cat ' + cat.key + ' -> ' + (cat.on ? 'on' : 'off'));
      });
      row.append(cb);

      const text = document.createElement('div');
      text.className = 'lt-cat-text';
      const name = document.createElement('div');
      name.className = 'lt-cat-name';
      name.textContent = txt[0];
      const desc = document.createElement('div');
      desc.className = 'lt-cat-desc';
      desc.textContent = txt[1];
      text.append(name, desc);
      row.append(text);

      /* count + swatches share a wrapper so a narrow deck wraps them to a
         second line as ONE unit instead of crushing the name column */
      const side = document.createElement('div');
      side.className = 'lt-cat-side';

      const n = Number(state.counts[cat.key]) || 0;
      const count = document.createElement('span');
      count.className = 'lt-cat-count' + (n ? '' : ' zero');
      count.textContent = String(n);
      count.title = n + ' glowing right now';
      side.append(count);

      const sw = document.createElement('div');
      sw.className = 'lt-swatches';
      for (const p of state.palette) {
        const b = document.createElement('button');
        b.className = 'lt-sw' + (cat.color === p.id ? ' sel' : '') + (p.ok ? '' : ' dead');
        b.style.background = p.css;
        b.title = p.ok ? (p.label + (cat.color === p.id ? ' (current)' : ''))
                       : p.label + ' — no shader resolved on this load order';
        b.addEventListener('click', () => {
          if (!p.ok) return;
          cat.color = p.id;
          renderCats();
          save();
        });
        sw.append(b);
      }
      side.append(sw);
      row.append(side);

      els.cats.append(row);
    }
  }

  /* Settings inputs are synced from config ONLY when a fresh ltOpen lands —
     never on the state poll — so a slider mid-drag is never yanked back. */
  function renderSettings() {
    els.radius.value = String(state.radius);
    els.radiusVal.textContent = meters(state.radius);
    els.max.value = String(state.maxGlows);
    els.maxVal.textContent = String(state.maxGlows);
    els.valmin.value = String(state.valuableMinValue);
    els.valminVal.textContent = String(state.valuableMinValue);
    els.ratio.value = String(state.gearRatio);
    els.ratioVal.textContent = String(state.gearRatio);
    els.minval.value = String(state.gearMinValue);
    els.minvalVal.textContent = String(state.gearMinValue);
    els.hideopened.checked = !!state.hideOpened;
    els.labelsafe.checked = !!state.labelSafe;
    els.notify.checked = !!state.notify;
  }

  /* =========================================================== receive == */

  function receive(key, info) {
    let j = null;
    if (typeof info === 'string') {
      try { j = JSON.parse(info); } catch (e) { j = null; }
    } else if (info && typeof info === 'object') {
      j = info;
    }
    if (key === 'open') {
      if (!j || typeof j !== 'object') return true;
      ui.gotOpen = true;
      state.enabled = !!j.enabled;
      state.notify = j.notify !== false;
      state.safeVision = !!j.safeVision;
      state.tickMs = Number(j.tickMs) || 1200;
      state.radius = Number(j.radius) || 2200;
      state.maxGlows = Number(j.maxGlows) || 40;
      state.hideOpened = j.hideOpened !== false;
      state.labelSafe = !!j.labelSafe;
      state.gearRatio = Number(j.gearRatio) || 0;
      state.gearMinValue = Number(j.gearMinValue) || 0;
      state.valuableMinValue = Number(j.valuableMinValue) || 0;
      state.cats = Array.isArray(j.cats) ? j.cats : [];
      state.lotdNew = esc(j.lotdNew || 'dbmNew');
      state.lotdFound = esc(j.lotdFound || 'dbmFound');
      state.lotdDisp = esc(j.lotdDisp || 'dbmDisp');
      state.palette = Array.isArray(j.palette) ? j.palette : [];
      state.lotd = (j.lotd && typeof j.lotd === 'object') ? j.lotd : { ok: false };
      state.active = Number(j.active) || 0;
      renderMaster();
      renderLotd();
      renderCats();
      renderSettings();
      return true;
    }
    if (key === 'result') {
      if (j && typeof j.enabled === 'boolean') state.enabled = j.enabled;
      renderMaster();
      return true;
    }
    if (key === 'state') {
      if (!j || !j.ok) return true;
      state.active = Number(j.active) || 0;
      state.counts = (j.cats && typeof j.cats === 'object') ? j.cats : {};
      renderMaster();
      /* counts live on the rows — update chips in place, no full rebuild
         (a rebuild would eat a swatch click mid-poll) */
      const rows = els.cats ? els.cats.children : [];
      for (let i = 0; i < rows.length && i < state.cats.length; i++) {
        const chip = rows[i].querySelector('.lt-cat-count');
        if (!chip) continue;
        const n = Number(state.counts[state.cats[i].key]) || 0;
        chip.textContent = String(n);
        chip.classList.toggle('zero', !n);
      }
      return true;
    }
    if (key === 'saved') {
      if (String(info) === 'false') glog('save FAILED');
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
    window[name].__ltReceiver = true;
  }

  /* ============================================================= init  == */

  function init() {
    if (ui.inited) return true;
    if (!$('lt-pane')) { console.log('[loot] #lt-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.pane = $('lt-pane');
    els.master = $('lt-master');
    els.masterState = $('lt-master-state');
    els.active = $('lt-active');
    els.safe = $('lt-safe');
    els.safeState = $('lt-safe-state');
    els.lotd = $('lt-lotd-status');
    els.cats = $('lt-cats');
    els.radius = $('lt-radius');
    els.radiusVal = $('lt-radius-val');
    els.max = $('lt-max');
    els.maxVal = $('lt-max-val');
    els.valmin = $('lt-valmin');
    els.valminVal = $('lt-valmin-val');
    els.ratio = $('lt-ratio');
    els.ratioVal = $('lt-ratio-val');
    els.minval = $('lt-minval');
    els.minvalVal = $('lt-minval-val');
    els.hideopened = $('lt-hideopened');
    els.labelsafe = $('lt-labelsafe');
    els.notify = $('lt-notify');

    els.master.addEventListener('click', () => { toGame('ltToggle'); });

    // Dedicated safe-storage glow. Rides the config slice (no bridge of its own)
    // — the C++ tick reconciles the glow within a scan cadence; the button
    // updates optimistically so it feels instant.
    els.safe.addEventListener('click', () => {
      state.safeVision = !state.safeVision;
      renderSafe();
      save();
      glog('safeVision -> ' + state.safeVision);
    });
    els.safe.addEventListener('mouseenter', () => {
      els.safe.style.background = state.safeVision ? 'rgba(130,222,152,.4)' : 'rgba(120,210,140,.2)';
    });
    els.safe.addEventListener('mouseleave', renderSafe);
    els.safe.addEventListener('mousedown', () => { els.safe.style.transform = 'scale(.985)'; });
    els.safe.addEventListener('mouseup', () => { els.safe.style.transform = 'scale(1)'; });

    const range = (input, apply) => {
      if (window.hdSmoothRange) window.hdSmoothRange(input);
      input.addEventListener('input', () => { apply(Number(input.value) || 0); save(); });
    };
    range(els.radius, (v) => { state.radius = v; els.radiusVal.textContent = meters(v); });
    range(els.max, (v) => { state.maxGlows = v; els.maxVal.textContent = String(v); });
    range(els.valmin, (v) => { state.valuableMinValue = v; els.valminVal.textContent = String(v); });
    range(els.ratio, (v) => { state.gearRatio = v; els.ratioVal.textContent = String(v); });
    range(els.minval, (v) => { state.gearMinValue = v; els.minvalVal.textContent = String(v); });

    els.hideopened.addEventListener('change', () => { state.hideOpened = els.hideopened.checked; save(); });
    els.labelsafe.addEventListener('change', () => { state.labelSafe = els.labelsafe.checked; save(); glog('labelSafe -> ' + state.labelSafe); });
    els.notify.addEventListener('change', () => { state.notify = els.notify.checked; save(); });

    chain('ltOpen', 'open');
    chain('ltResult', 'result');
    chain('ltStateResult', 'state');
    chain('ltSaved', 'saved');

    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  function onShow() {
    if (!init()) return;
    ui.shown = true;
    toGame('ltGet');
    clearInterval(ui.pollT);
    ui.pollT = setInterval(() => { if (ui.shown) toGame('ltState'); }, STATE_POLL);
  }

  function onHide() {
    ui.shown = false;
    clearInterval(ui.pollT);
    ui.pollT = null;
    /* flush a pending debounce so a slider tweak right before Esc lands */
    if (ui.saveT) { clearTimeout(ui.saveT); toGame('ltSave', JSON.stringify(slice())); ui.saveT = null; }
  }

  function toggleEdit() { /* no edit chrome — the shared size card handles F2 */ }
  function wantsPause() { return true; }

  /* ============================================================ selftest == */

  function selftest() {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);

    els.pane.classList.remove('hidden');
    devOpen();

    ok('pane exists', !!$('lt-pane'));
    ok('got dev config', ui.gotOpen);
    ok('10 category rows', els.cats.children.length === 10);
    ok('safe container row present', els.cats.children[9].querySelector('.lt-cat-name').textContent === 'Safe containers');
    ok('7 swatches per row', els.cats.children[0].querySelectorAll('.lt-sw').length === 7);
    ok('dead swatch marked', !!els.cats.children[0].querySelector('.lt-sw.dead'));
    ok('selected swatch marked', !!els.cats.children[0].querySelector('.lt-sw.sel'));
    ok('books row rendered off', els.cats.children[7].classList.contains('offrow'));
    ok('lotd status ok-class', els.lotd.classList.contains('ok'));
    ok('master reads OFF', els.masterState.textContent === 'OFF');
    ok('radius label in meters', /m$/.test(els.radiusVal.textContent));
    ok('receivers tagged', window.ltOpen.__ltReceiver === true &&
      window.ltStateResult.__ltReceiver === true);
    ok('no receiver on a REQUEST name', typeof window.ltGet !== 'function' ||
      window.ltGet.__ltReceiver !== true);

    window.ltStateResult(JSON.stringify({ ok: true, active: 5, cats: { chests: 3, coins: 2 } }));
    ok('state poll updates chips', els.cats.children[1].querySelector('.lt-cat-count').textContent === '3');
    ok('master line counts', state.active === 5);

    window.ltResult(JSON.stringify({ ok: true, msg: 'x', enabled: true }));
    ok('toggle result flips master', els.masterState.textContent === 'ON');

    /* slice round-trip: everything the view owns survives */
    const s = slice();
    ok('slice carries cats', Array.isArray(s.cats) && s.cats.length === 9);
    ok('slice carries thresholds', s.gearRatio === 10 && s.gearMinValue === 250 && s.valuableMinValue === 100);
    ok('slice keeps list names', s.lotdNew === 'dbmNew' && s.lotdDisp === 'dbmDisp');

    const fails = out.filter((l) => l.indexOf('FAIL') === 0);
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' +
      (fails.length ? '#c85046' : '#4c8') + ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  /* ---- Omni search provider (universal search) ------------------------- */
  if (window.HDOmni) HDOmni.register({
    id: 'loot', label: 'Loot', tab: 'loot',
    setFilter: function () { /* no filterable list — landing on the tab is the jump */ },
    index: function () {
      const items = (state.cats || []).map((c) => ({
        label: (CAT_TEXT[c.key] || [c.key])[0],
        detail: 'Loot glow · ' + (c.on ? 'on' : 'off'),
        kind: 'loot',
        keywords: 'loot vision glow highlight ' + c.key,
      }));
      items.push({ label: 'Loot Vision', detail: state.enabled ? 'glowing — jump to turn off' : 'off — jump to turn on',
        kind: 'loot', keywords: 'loot vision toggle glow highlight treasure' });
      return items;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause,
    _state: state, _ui: ui   // test hooks only
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.LootPane.init());
} else {
  window.LootPane.init();
}
