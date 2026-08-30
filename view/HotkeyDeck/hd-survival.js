'use strict';

/* ====================================================================== *
 *  Survival — the camp-and-supplies popout (Rober, 2026-08-15: "a tent menu
 *  popup (tentapalooza) and campfire, maybe extended even more but some sort
 *  of like survival menu - with like submenus for tents, waterskins, other
 *  stuff from campfire / tentapalooza, searchable, nice").
 *
 *  The Potion Browser's structural twin: a paused, body-level overlay
 *  (body.sv-open hides #panel), routed through app.js's hdShowTab('survival'),
 *  opened by the seeded "Survival" action or its own key.
 *
 *  WHAT IT SHOWS: what you are CARRYING, not what the load order ships — the
 *  Settlement tab already browses the catalogue; this is your pack. Sections:
 *    Camp   — tents, bedrolls, fire, cooking, camp crafting (Campfire family),
 *             grouped into drawers by C++'s own keyword buckets
 *    Water  — waterskins and bottles (SunHelm's forms are classified in C++)
 *    Food   — solid meals
 *    Drink  — ale, mead, wine, tea… anything drinkable that isn't plain water
 *
 *  IT IMPLEMENTS NOTHING: "Pitch" hands over to Campfire's own equip flow
 *  (through the Settlement tab's campplace verb) and "Use" is the same
 *  EquipObject the wheel and smart buttons use, so SunHelm/CACO hooks run.
 *
 *  Bridge: svState -> svStateResult, svAct -> svActResult. Art comes from the
 *  shared item-render route (WardrobePane.itemIconFor), so a tent you have
 *  seen once in the Settlement tab already has its picture here.
 * ====================================================================== */

window.HDSurvival = (function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (DEV) console.log('[sv dev->game]', fn, arg);
  }
  function coerce(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' +
           esc(t.slice(i + q.length));
  }

  /* --------------------------------------------------------------- state */

  let env = null;                       // { closeDeck } — handed over by app.js
  const state = { loaded: false, sections: [], camp: {}, water: {}, needs: null, hero: null };
  const ui = {
    open: false, openedAt: 0, standalone: false,
    sec: 'do', q: '', cursor: 0,
    toastT: null, iconT: null, iconPollT: null, iconPollN: 0, iconReq: {},
    /* vitals: the built gauge rows, keyed by meter id, plus the highest value
       each meter has shown this session (the self-correcting soft scale). The
       rows are BUILT once and UPDATED after that, so a value change animates
       the track instead of replacing the node under the transition. */
    needSig: '', needEls: {}, needPeak: {},
  };

  const SECTION_GLYPH = { do: '✦', camp: '⛺', water: '💧', food: '🍖', drink: '🍺' };

  /* ------------------------------------------------------- the vitals -- *
   *  Rober, 2026-08-18: "the hunger, thirst, stuff could look a lot better
   *  graphically". So each need is a GAUGE ROW — glyph plate, label, a big
   *  number, a track that fills, and one word for what that means — instead
   *  of four numbers in a line.
   *
   *  WHICH WAY IS BAD.  A gauge cannot be drawn, and a colour cannot be
   *  chosen, without knowing which end of the scale is the emergency.
   *  SunHelm's three needs are RESERVES that drain: survival.cpp's own Rates
   *  group says "Higher rate = it drains faster", and _SHFatigueSleepRestore-
   *  Amount RESTORES fatigue — so 100 is fed/watered/rested and 0 is the
   *  emergency. Cold is the opposite: _SHCurrentColdLevel CLIMBS toward
   *  _SHColdLevelCap, which is why it is the one meter that ships a max.
   *  A meter this table does not know keeps its number and its track but gets
   *  NO severity colour and NO state word — guessing which end is bad and
   *  getting it backwards is worse than saying nothing.  marker: sv-vitals
   * ---------------------------------------------------------------------- */
  const NEED_DIR = { hunger: 'drains', thirst: 'drains', fatigue: 'drains', cold: 'climbs' };
  const NEED_GLYPH = { hunger: '🍖', thirst: '💧', fatigue: '🌙', cold: '❄' };
  /* worst-last, indexed by the severity band below */
  const NEED_WORDS = {
    hunger: ['fed', 'peckish', 'hungry', 'starving'],
    thirst: ['watered', 'dry', 'thirsty', 'parched'],
    fatigue: ['rested', 'tired', 'weary', 'exhausted'],
    cold: ['warm', 'chilly', 'cold', 'freezing'],
  };
  const SEV_CLASS = ['sv-sev-ok', 'sv-sev-warn', 'sv-sev-low', 'sv-sev-crit'];

  /* The scale a meter is drawn against. A published max is the truth; without
     one the track is drawn against 100 and SAYS SO (the ≈ mark and the title),
     and the assumed scale GROWS to the highest value seen this session — the
     hotbar's self-correcting shout-cooldown idiom — so a mod that counts past
     100 stops being misdrawn the moment it proves it. */
  function needScale(m) {
    const max = (typeof m.max === 'number' && m.max > 0) ? m.max : 0;
    if (max) return { max: max, assumed: false };
    const id = String(m.id || m.label || '');
    const seen = Math.max(100, ui.needPeak[id] || 0);
    return { max: seen, assumed: true };
  }

  /* 0 = fine, 1 = the emergency; null when we do not know which way is bad. */
  function needSeverity(m, scale) {
    const dir = NEED_DIR[String(m.id || '')];
    if (!dir || !scale.max) return null;
    const frac = Math.max(0, Math.min(1, (Number(m.value) || 0) / scale.max));
    return dir === 'climbs' ? frac : 1 - frac;
  }

  function sevBand(sev) {
    if (sev == null) return -1;
    if (sev < 0.35) return 0;
    if (sev < 0.60) return 1;
    if (sev < 0.85) return 2;
    return 3;
  }

  /* ----------------------------------------------------------- the rows */

  /* Every row the current section shows, in draw order, with its drawer head.
     Searching flattens the drawers — when you have typed a word you want hits,
     not headings. */
  function visibleRows() {
    const sec = allSections().filter((s) => s.id === ui.sec)[0];
    if (!sec) return { items: [], flat: [], hint: '' };
    const q = ui.q.toLowerCase().trim();
    const rows = (sec.rows || []).filter((r) => {
      if (!q) return true;
      return String(r.name || '').toLowerCase().indexOf(q) !== -1 ||
             String(r.sub || '').toLowerCase().indexOf(q) !== -1;
    });
    const items = [], flat = [];
    const push = (r) => { items.push({ row: r }); flat.push(r); };
    if (q || !(sec.subs || []).length) {
      rows.forEach(push);
      return { items, flat, hint: sec.hint || '' };
    }
    (sec.subs || []).forEach((sub) => {
      const inSub = rows.filter((r) => r.sub === sub.id);
      if (!inSub.length) return;
      items.push({ head: sub.label, count: inSub.length });
      inSub.forEach(push);
    });
    /* anything whose drawer C++ didn't name still shows — a row you own must
       never be invisible because a keyword bucket was missed */
    const named = {};
    (sec.subs || []).forEach((s) => { named[s.id] = true; });
    const orphans = rows.filter((r) => !named[r.sub]);
    if (orphans.length) { items.push({ head: 'Other', count: orphans.length }); orphans.forEach(push); }
    return { items, flat, hint: sec.hint || '' };
  }

  /* The popout is VERBS (Rober, 2026-08-15: "the popout is for quick actions
     … the stats thing … would be better suited in a tab"). The hero board and
     the deep stats live in the Survival TAB now; what stays here is what you
     open mid-blizzard: the actions, and the gear you carry. */
  function allSections() { return state.sections; }

  function sectionCount(id) {
    const s = allSections().filter((x) => x.id === id)[0];
    return s ? (s.rows || []).length : 0;
  }

  /* ----------------------------------------------------------- the art */

  /* An ACTION is one of the mods' lesser powers. A power ships no world model,
     so the item-render route can never draw one — every action row sat on the
     "generating" skeleton for ever and the log filled with "has no world model"
     (Rober, 2026-08-16: "Quick actions needs on theme app generated icons").
     So actions carry a stable `act` id from C++ and wear the deck's OWN
     gold-glyph art. A missing PNG degrades to the section glyph via the img
     onerror already in the row. marker: sv-act-icons */
  const ACT_ICON = {
    'camp-build': 'sv-camp-build', 'camp-craft': 'sv-camp-craft',
    'camp-wood': 'sv-camp-wood', 'camp-instincts': 'sv-camp-instincts',
    'camp-options': 'sv-camp-options',
    'wsn-pray': 'sv-pray', 'wsn-worship': 'sv-worship',
    'hb-forage': 'sv-forage', 'hb-taxonomy': 'sv-taxonomy',
    'hb-scrimshaw': 'sv-scrimshaw', 'hb-scavenge': 'sv-scavenge',
    'smart-water': 'sv-drink', 'smart-food': 'sv-eat',
    'sunhelm-fill': 'sv-fill'
  };

  function actIconFor(row) {
    const f = row && row.act ? ACT_ICON[row.act] : null;
    return f ? 'icons/custom/' + f + '.png' : '';
  }

  /* A row that can never be rendered must never be ASKED for: that is what kept
     the poll running and the skeleton spinning. */
  function rendersEver(row) {
    return !!(row && row.plugin && row.formId && !row.act);
  }

  function artFor(row) {
    const own = actIconFor(row);
    if (own) return own;
    if (!rendersEver(row)) return '';
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try { return WardrobePane.itemIconFor({ formId: row.formId, plugin: row.plugin }) || ''; }
    catch (e) { return ''; }
  }

  function failFor(row) {
    if (!row || !window.WardrobePane || typeof WardrobePane.itemIconFailed !== 'function') return '';
    try { return WardrobePane.itemIconFailed({ formId: row.formId, plugin: row.plugin }) || ''; }
    catch (e) { return ''; }
  }

  /* The items-pane settle gate, verbatim in spirit: ask for renders only once
     the list has sat still, so typing does not queue a page per keystroke. */
  function scheduleIconWork() {
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    ui.iconT = setTimeout(function () {
      ui.iconT = null;
      requestIcons();
    }, 650);
  }

  function requestIcons() {
    const want = [];
    visibleRows().flat.forEach(function (r) {
      if (!rendersEver(r)) return;   // stat rows, the key relay and every action
      const key = r.plugin + '|' + r.formId;
      if (ui.iconReq[key] || artFor(r) || failFor(r)) return;
      ui.iconReq[key] = 1;
      want.push({ formId: r.formId, plugin: r.plugin, name: r.name });
    });
    if (want.length) {
      toGame('whIcons', JSON.stringify({ items: want }));
      startIconPoll();
    }
  }

  /* While rows still lack art, nudge C++ with an EMPTY request: it queues
     nothing and answers with the on-disk index, so pictures appear as they
     land instead of only when the whole batch drains (items-icon-settle). */
  function startIconPoll() {
    stopIconPoll();
    ui.iconPollN = 0;
    ui.iconPollLast = -1;
    ui.iconPollT = setInterval(function () {
      if (!ui.open) { stopIconPoll(); return; }
      const pending = visibleRows().flat
        .filter((r) => rendersEver(r) && !artFor(r) && !failFor(r)).length;
      if (!pending) { stopIconPoll(); return; }
      /* The budget counts STALLED ticks, not elapsed ones: a long paced batch
         kept landing art well past a flat 24-tick cap, and giving up mid-batch
         left tiles spinning for ever (the wigs lesson, same day). */
      if (ui.iconPollLast < 0 || pending < ui.iconPollLast) ui.iconPollN = 0;
      ui.iconPollLast = pending;
      if (ui.iconPollN++ > 24) { stopIconPoll(); return; }
      toGame('whIcons', JSON.stringify({ items: [] }));
    }, 2500);
  }

  function stopIconPoll() {
    if (ui.iconPollT) { clearInterval(ui.iconPollT); ui.iconPollT = null; }
  }

  /* ----------------------------------------------------------- the DOM */

  let root = null, qEl = null, listEl = null, pillsEl = null, toastEl = null, needsEl = null;

  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'hd-survival';
    root.innerHTML =
      '<div class="sv-box" role="dialog" aria-label="Survival">' +
      '<div class="sv-head">' +
      '<div class="sv-title">⛺ Survival</div>' +
      '<div class="sv-sub" id="sv-sub"></div>' +
      '<button class="sv-x" id="sv-x" title="Close (Esc)">✕</button>' +
      '</div>' +
      '<div class="sv-bar"><span class="sv-bar-glyph">⌕</span>' +
      '<input id="sv-q" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Search your camp gear, water, food… (Enter = the top one)"></div>' +

      '<div class="sv-needs" id="sv-needs"></div>' +
      '<div class="sv-pills" id="sv-pills"></div>' +
      '<div class="sv-list" id="sv-list"></div>' +
      '<div class="sv-hints">' +
      '<span><b>↑↓</b> pick</span><span><b>Enter</b> do it</span>' +
      '<span><b>Tab</b> next section</span><span><b>double-click</b> a row does it too</span>' +
      '<span><b>Esc</b> clears the search, then closes</span></div>' +
      '<div class="sv-toast" id="sv-toast" role="status" aria-live="polite"></div>' +
      '</div>';
    document.body.appendChild(root);
    qEl = document.getElementById('sv-q');
    needsEl = document.getElementById('sv-needs');

    listEl = document.getElementById('sv-list');
    pillsEl = document.getElementById('sv-pills');
    toastEl = document.getElementById('sv-toast');

    document.getElementById('sv-x').addEventListener('click', function () { close(true); });
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(true); });
    qEl.addEventListener('input', function () {
      ui.q = qEl.value;
      ui.cursor = 0;
      renderList();
    });
    qEl.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!ui.open) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (ui.q) { ui.q = ''; qEl.value = ''; renderList(); return; }
      close(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const n = visibleRows().flat.length;
      if (!n) return;
      ui.cursor = e.key === 'ArrowDown'
        ? Math.min(n - 1, ui.cursor + 1)
        : Math.max(0, ui.cursor - 1);
      renderList();
      const sel = listEl && listEl.querySelector('.sv-row.is-sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Tab') {
      /* Tab walks the sections — the fastest way from tents to water without
         reaching for the mouse. */
      e.preventDefault(); e.stopPropagation();
      const ids = allSections().map((s) => s.id);
      if (!ids.length) return;
      const at = Math.max(0, ids.indexOf(ui.sec));
      setSection(ids[(at + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const rows = visibleRows().flat;
      const r = rows[Math.min(ui.cursor, rows.length - 1)];
      if (r) fire(r);
    }
  }

  function setSection(id) {
    ui.sec = id;
    ui.cursor = 0;
    renderPills();
    renderList();
  }

  /* The vitals board — SunHelm's own globals, read straight (see survival.cpp).
     One gauge row per need: glyph, label, the number big enough to read from
     the couch, a track that fills, and one word for what that means. The
     number is still the truth — the track and the colour are how it reads at
     a glance. A need switched off in SunHelm's MCM says so and gets NO gauge
     at all, because a bar for a need the mod is not tracking is a stale bar.
     The rows are built once per meter SET and updated in place after that, so
     a changed value slides the track (~180ms) instead of snapping. */
  function renderNeeds() {
    if (!needsEl) return;
    const n = state.needs;
    const meters = (n && n.present && Array.isArray(n.meters)) ? n.meters : [];
    if (!meters.length) {
      needsEl.innerHTML = '';
      needsEl.classList.remove('sv-needs-on');
      ui.needSig = '';
      ui.needEls = {};
      return;
    }
    needsEl.classList.add('sv-needs-on');

    const key = function (m, i) { return String(m.id || m.label || i); };
    const sig = meters.map(key).join('');
    if (sig !== ui.needSig) buildNeeds(meters, key);
    ui.needSig = sig;

    meters.forEach(function (m, i) { updateNeed(m, ui.needEls[key(m, i)], n); });
    renderNeedFlags(n);
  }

  function buildNeeds(meters, key) {
    ui.needEls = {};
    needsEl.innerHTML =
      '<div class="sv-vit-head"><span class="sv-vit-t">Vitals</span>' +
      '<span class="sv-vit-src" id="sv-vit-src"></span></div>' +
      '<div class="sv-vit-grid" id="sv-vit-grid"></div>' +
      '<div class="sv-need-flags" id="sv-need-flags"></div>';
    const grid = document.getElementById('sv-vit-grid');
    meters.forEach(function (m, i) {
      const id = key(m, i);
      const el = document.createElement('div');
      el.className = 'sv-need';
      el.setAttribute('data-need', id);
      el.innerHTML =
        '<div class="sv-need-top">' +
        '<span class="sv-need-ico" aria-hidden="true"></span>' +
        '<span class="sv-need-l"></span>' +
        '<span class="sv-need-v"></span>' +
        '</div>' +
        '<div class="sv-need-bar"><span style="width:0%"></span></div>' +
        '<div class="sv-need-foot"><span class="sv-need-state"></span>' +
        '<span class="sv-need-scale"></span></div>';
      grid.appendChild(el);
      ui.needEls[id] = {
        row: el,
        ico: el.querySelector('.sv-need-ico'),
        lbl: el.querySelector('.sv-need-l'),
        val: el.querySelector('.sv-need-v'),
        bar: el.querySelector('.sv-need-bar'),
        fill: el.querySelector('.sv-need-bar > span'),
        state: el.querySelector('.sv-need-state'),
        scale: el.querySelector('.sv-need-scale'),
      };
    });
  }

  function updateNeed(m, e, n) {
    if (!e) return;
    const id = String(m.id || '');
    const val = Math.round(Number(m.value) || 0);
    if (!m.off && val > (ui.needPeak[id] || 0)) ui.needPeak[id] = val;

    const scale = needScale(m);
    const sev = m.off ? null : needSeverity(m, scale);
    const band = sevBand(sev);
    const pct = (m.off || !scale.max) ? 0
      : Math.max(0, Math.min(100, (val / scale.max) * 100));

    e.ico.textContent = NEED_GLYPH[id] || '•';
    e.lbl.textContent = String(m.label || id);
    e.val.innerHTML = m.off ? '<i class="sv-need-offv">off</i>'
      : esc(String(val)) + (scale.assumed ? '' :
        '<i class="sv-need-max">/' + esc(String(Math.round(scale.max))) + '</i>');

    /* An OFF need keeps its row (you should see the mod is not tracking it)
       but loses the gauge — a bar for an untracked need is a stale bar. */
    e.bar.style.display = m.off ? 'none' : '';
    e.fill.style.width = pct.toFixed(1) + '%';

    const words = NEED_WORDS[id];
    e.state.textContent = m.off ? 'not tracked'
      : (words && band >= 0) ? words[band] : '';
    e.scale.textContent = (!m.off && scale.assumed) ? '≈ ' + Math.round(scale.max) : '';

    SEV_CLASS.forEach(function (c) { e.row.classList.remove(c); });
    if (band >= 0) e.row.classList.add(SEV_CLASS[band]);
    e.row.classList.toggle('sv-need-off', !!m.off);
    e.row.classList.toggle('sv-need-soft', !m.off && scale.assumed);
    e.row.setAttribute('data-scale', scale.assumed ? 'assumed' : 'published');

    e.row.title = String(m.label || id) +
      (m.off ? ' — turned off in ' + String((n && n.mod) || 'the mod')
        : ' — ' + val + (scale.assumed
          ? ', drawn against ' + Math.round(scale.max) + ' because ' +
            String((n && n.mod) || 'the mod') + ' publishes no maximum for it'
          : ' of ' + Math.round(scale.max)));
  }

  /* The context the numbers alone do not give, as deck chips with a glyph:
     standing at a fire, or in freezing water, changes what you do next. */
  function renderNeedFlags(n) {
    const box = document.getElementById('sv-need-flags');
    if (!box) return;
    const chips = [];
    if (n.enabled === false)
      chips.push('<span class="sv-need-flag sv-warn"><i>⏻</i>' +
        esc(n.mod || 'Needs') + ' is switched off</span>');
    if (n.nearHeat) chips.push('<span class="sv-need-flag sv-good"><i>🔥</i>by a heat source</span>');
    if (n.inFreezingWater)
      chips.push('<span class="sv-need-flag sv-bad"><i>🧊</i>in freezing water</span>');
    if (typeof n.ambient === 'number')
      chips.push('<span class="sv-need-flag"><i>🌡</i>ambient ' + Math.round(n.ambient) + '°</span>');
    box.innerHTML = chips.join('');
    box.style.display = chips.length ? '' : 'none';
    const src = document.getElementById('sv-vit-src');
    if (src) src.textContent = n.mod || '';
  }

  function renderPills() {
    if (!pillsEl) return;
    pillsEl.innerHTML = allSections().map(function (s) {
      const n = (s.rows || []).length;
      return '<button class="sv-pill' + (ui.sec === s.id ? ' sv-pill-on' : '') +
        '" data-sec="' + esc(s.id) + '" title="' + esc(s.hint || s.label) + '">' +
        (SECTION_GLYPH[s.id] || '•') + ' ' + esc(s.label) +
        (n ? ' <b class="sv-pill-n">' + n + '</b>' : '') + '</button>';
    }).join('');
    pillsEl.querySelectorAll('.sv-pill').forEach(function (b) {
      b.addEventListener('click', function () { setSection(b.getAttribute('data-sec')); });
    });
  }

  function rowHtml(r, idx, sel) {
    if (r.statValue !== undefined) {
      return '<div class="sv-row sv-statrow' + (idx === sel ? ' is-sel' : '') +
        '" data-idx="' + idx + '" tabindex="-1" role="option" ' +
        'title="' + esc(r.name) + (r.detail ? ' — ' + esc(r.detail) : '') + '">' +
        '<div class="sv-mid"><div class="sv-name">' + highlight(r.name, ui.q) + '</div>' +
        (r.detail ? '<div class="sv-detail">' + esc(r.detail) + '</div>' : '') + '</div>' +
        '<span class="sv-statv">' + esc(String(r.statValue)) + '</span>' +
        '</div>';
    }
    const art = artFor(r);
    const why = art ? '' : failFor(r);
    /* verb 'none' = there is nothing this menu can honestly do with it (an
       empty waterskin fills at water, on the mod's own key) — so it gets no
       button rather than one that does nothing. */
    const act = r.verb === 'camp' ? 'Pitch'
              : r.verb === 'cast' ? 'Do it'
              : r.verb === 'key' ? 'Fill'
              : r.verb === 'smart' ? 'Now'
              : r.verb === 'none' ? ''
              : 'Use';
    const title = r.verb === 'camp' ? 'Place it — Campfire takes over from here'
                : r.verb === 'cast' ? 'Runs the mod\'s own action — its menu takes over'
                : 'Use it now';
    return '<div class="sv-row' + (idx === sel ? ' is-sel' : '') + '" data-idx="' + idx + '" ' +
      'tabindex="-1" role="option" aria-selected="' + (idx === sel ? 'true' : 'false') + '" ' +
      'title="' + esc(r.name) + (r.detail ? ' — ' + esc(r.detail) : '') +
      (act ? ' (double-click to ' + esc(act.toLowerCase()) + ')' : '') + '">' +
      '<div class="sv-art' + (art ? ' has-art' : '') + '">' +
      '<span class="sv-glyph">' + (SECTION_GLYPH[ui.sec] || '•') + '</span>' +
      (art ? '<img src="' + esc(art) + '" alt="" draggable="false" ' +
             'onerror="var b=this.parentNode;if(b){b.classList.remove(&quot;has-art&quot;);b.removeChild(this);}">' : '') +
      (why ? '<span class="sv-fail" title="' + esc(why) + '">✕</span>' : '') +
      '</div>' +
      '<div class="sv-mid">' +
      '<div class="sv-name">' + highlight(r.name, ui.q) + '</div>' +
      '<div class="sv-detail">' + esc(r.detail || '') + '</div>' +
      '</div>' +
      (r.count > 1 ? '<span class="sv-count">×' + (r.count | 0) + '</span>' : '') +
      (act ? '<button class="sv-do" data-idx="' + idx + '" title="' + esc(title) + '">' + act + '</button>'
           : '') +
      '</div>';
  }

  function renderList() {
    if (!listEl) return;
    const sub = document.getElementById('sv-sub');
    if (!state.loaded) {
      listEl.innerHTML = new Array(6).fill(
        '<div class="sv-row sv-skel"><div class="sv-art sv-skel-box"></div>' +
        '<div class="sv-mid"><span class="sv-skel-box sv-w1"></span>' +
        '<span class="sv-skel-box sv-w2"></span></div>' +
        '<span class="sv-skel-box sv-skel-btn"></span></div>').join('');
      if (sub) sub.textContent = 'Reading your pack…';
      return;
    }
    const v = visibleRows();
    if (sub) {
      const total = state.sections.reduce(function (n, s) { return n + (s.rows || []).length; }, 0);
      sub.textContent = total + ' thing' + (total === 1 ? '' : 's') + ' in your pack' +
        (state.camp && state.camp.present === false ? ' · Campfire not installed' : '');
    }
    if (!v.flat.length) {
      listEl.innerHTML = '<div class="sv-empty">' +
        '<div class="sv-empty-t">' + (ui.q ? 'Nothing matches “' + esc(ui.q) + '”'
                                          : 'Nothing here yet') + '</div>' +
        '<div class="sv-empty-s">' + esc(v.hint || '') + '</div></div>';
      return;
    }
    const sel = Math.min(ui.cursor, v.flat.length - 1);
    let html = '';
    let idx = -1;
    v.items.forEach(function (it) {
      if (it.head) {
        html += '<div class="sv-drawer">' + esc(it.head) +
          ' <b>' + it.count + '</b></div>';
        return;
      }
      idx++;
      html += rowHtml(it.row, idx, sel);
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.sv-row[data-idx]').forEach(function (el) {
      const i = parseInt(el.getAttribute('data-idx'), 10);
      el.addEventListener('click', function (e) {
        if (e.target.closest('.sv-do')) return;
        ui.cursor = i;
        renderList();
      });
      /* Single click SELECTS (these verbs close the menu or hand over to
         another mod — an accidental brush must not fire one), double-click
         DOES it, which is what a list of actions should feel like. */
      el.addEventListener('dblclick', function (e) {
        if (e.target.closest('.sv-do')) return;
        const r = visibleRows().flat[i];
        if (r && r.verb !== 'none') fire(r);
      });
    });
    listEl.querySelectorAll('.sv-do').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        const r = visibleRows().flat[parseInt(b.getAttribute('data-idx'), 10)];
        if (r) fire(r);
      });
    });
    scheduleIconWork();
  }

  function fire(row) {
    if (!row) return;
    const msg = { id: row.id, verb: row.verb || 'use' };
    if (row.verb === 'key') msg.key = row.key;   // the mod's own hotkey, relayed
    toGame('svAct', JSON.stringify(msg));
  }

  function toast(msg, bad) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('sv-toast-bad', !!bad);
    toastEl.classList.add('sv-toast-on');
    if (ui.toastT) clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { toastEl.classList.remove('sv-toast-on'); }, 3000);
  }

  /* -------------------------------------------------------- open/close */

  function open(standalone) {
    ensureDom();
    ui.open = true;
    ui.openedAt = Date.now();
    ui.standalone = !!standalone;
    ui.q = '';
    ui.cursor = 0;
    if (qEl) qEl.value = '';
    document.body.classList.add('sv-open');
    state.loaded = false;
    renderNeeds();
    renderPills();
    renderList();
    toGame('svState');
    setTimeout(function () { if (ui.open && qEl) qEl.focus(); }, 30);
  }

  function close(closeDeck) {
    if (!ui.open) return;
    ui.open = false;
    stopIconPoll();
    if (ui.iconT) { clearTimeout(ui.iconT); ui.iconT = null; }
    document.body.classList.remove('sv-open');
    if (closeDeck && ui.standalone) {
      if (env && typeof env.closeDeck === 'function') env.closeDeck();
      else toGame('hdClose');
    }
    ui.standalone = false;
  }

  /* --------------------------------------------------------- receivers */

  /* svStateResult is SHARED with the Survival TAB (survival-pane.js): ONE read
     of the mods' state feeds both surfaces, so they can never disagree about
     your needs. Both receivers must therefore CHAIN — survival-pane.js loads
     first (hd-boot manifest) and chains whatever it finds, so a plain
     assignment here overwrote it and the tab sat on its four skeleton cards
     forever while the popout worked (Rober, 2026-08-16: "Survival Menu,
     Skeletons - never loads anything"). marker: sv-state-chain */
  const svPrevState = window.svStateResult;
  window.svStateResult = function (j) {
    if (typeof svPrevState === 'function') { try { svPrevState(j); } catch (e) {} }
    const d = coerce(j);
    if (!d || typeof d !== 'object') return;
    state.loaded = true;
    state.sections = Array.isArray(d.sections) ? d.sections : [];
    state.camp = d.camp || {};
    state.water = d.water || {};
    state.needs = d.needs || null;
    state.hero = d.hero || null;
    if (!allSections().some((s) => s.id === ui.sec) && state.sections.length)
      ui.sec = state.sections[0].id;
    if (ui.open) { renderNeeds(); renderPills(); renderList(); }
  };

  window.svActResult = function (j) {
    const d = coerce(j);
    if (!d || typeof d !== 'object') return;
    toast(d.msg || (d.ok ? 'Done' : 'That did not work'), !d.ok);
    /* C++ closes the palette itself when the act hands over to Campfire; the
       popout has to come down with it or it would sit over the world. */
    if (d.ok && d.close) close(false);
  };

  /* The shared render index landed — repaint so new art shows immediately. */
  try {
    document.addEventListener('hd-item-icons', function () {
      if (ui.open) renderList();
    });
  } catch (e) { /* no DOM in some harnesses */ }

  /* ------------------------------------------------------------- omni */

  /* Open already on a section — and, for a row this menu has no verb for,
     already filtered to it, because the row's own line is the explanation
     ("empty — refill at fresh water"). The Potion Browser's open-onto-a-sheet
     idiom: open() first, then place, so the fresh svState lands on the section
     you asked for. */
  function openAt(secId, q) {
    open(false);
    if (secId) ui.sec = secId;
    ui.q = String(q || '');
    ui.cursor = 0;
    if (qEl) qEl.value = ui.q;
    renderPills();
    renderList();
  }

  /* Firing a verb straight from search OPENS the popout first and then fires.
     svAct's only feedback path is this popout's toast — survival.cpp raises no
     notification of its own — so a refusal ("you aren't carrying any more")
     run with the menu shut would vanish and the result would look dead. */
  function runRow(secId, row) {
    const dumb = !row || row.verb === 'none';
    openAt(secId, dumb ? String((row && row.name) || '') : '');
    if (!dumb) fire(row);
  }

  const SECTION_WORDS = {
    do: 'actions do powers build craft pray worship forage instincts',
    camp: 'camp tent bedroll shelter fire firewood cooking pot tentapalooza campfire pitch',
    water: 'water waterskin skin bottle drink thirst fill refill',
    food: 'food eat meal cooked hunger hungry',
    drink: 'drink ale mead wine tea potion booze thirst',
  };
  const VERB_WORDS = {
    camp: 'pitch place set up camp tent shelter',
    cast: 'do run action power',
    key: 'fill refill',
    smart: 'best strongest quick now',
    none: '',
  };
  const VERB_TEXT = {
    camp: 'Pitch it — Campfire takes over from here',
    cast: "Runs the mod's own action",
    key: "Fills it — relays the mod's own key",
    smart: 'Uses the best one you are carrying',
    none: 'Nothing this menu can honestly do with it',
  };

  /* ---- Omni search provider: the popout, its sections, and your pack ---- *
     The Potion Browser is the precedent and the reason: the seeded deck action
     could open this menu, but nothing named what is INSIDE it, so "waterskin",
     "pitch a tent" and "camp gear" all came back empty while the row — and its
     verb — sat one keypress away. Rows come from the LIVE state.sections, so a
     tent picked up this morning is searchable this morning, and its Pitch is
     reachable without opening anything first.  marker: sv-omni */
  if (window.HDOmni) {
    HDOmni.register({
      id: 'survival-quick', label: 'Camp & supplies', tab: 'survival',
      /* No setFilter on purpose: the jump lands on the Survival TAB (the
         dashboard), whose filter searches numbers, not your pack — pre-filling
         it with "waterskin" would land on an empty board. */
      warm: function () {
        /* ONE read serves both surfaces: survival-pane.js's provider already
           asks for svState when the omni opens and svStateResult is chained
           into this module, so asking again would walk the whole pack twice
           per Ctrl+F. */
        if (window.SurvivalPane) return;
        toGame('svState');
      },
      index: function () {
        const rows = [{
          label: 'Survival: quick actions',
          detail: 'Your camp, water, food and drink — pitch a tent, fill a skin, eat, pray',
          kind: 'survival',
          keywords: 'survival camp tent bedroll tentapalooza campfire frostfall waterskin ' +
            'water drink food eat pitch pray hunterborn sunhelm wintersun supplies pack ' +
            'quick actions menu popout',
          run: function () { open(false); },
        }];
        allSections().forEach(function (s) {
          const n = (s.rows || []).length;
          rows.push({
            label: 'Survival: ' + s.label,
            detail: (n ? n + ' thing' + (n === 1 ? '' : 's') + ' · ' : '') +
              (s.hint || 'Opens the survival menu here'),
            kind: 'survival',
            keywords: 'survival ' + s.label + ' ' + (SECTION_WORDS[s.id] || ''),
            run: function () { openAt(s.id, ''); },
          });
          (s.rows || []).forEach(function (r) {
            /* A stat row is a number, and numbers are the Survival TAB's job —
               indexing them here would answer the same question twice. */
            if (r.statValue !== undefined) return;
            rows.push({
              label: r.name,
              detail: [VERB_TEXT[r.verb] || 'Use it', r.detail,
                r.count > 1 ? '×' + (r.count | 0) : ''].filter(Boolean).join(' · '),
              kind: 'survival',
              keywords: 'survival ' + s.label + ' ' + (SECTION_WORDS[s.id] || '') + ' ' +
                (VERB_WORDS[r.verb] || 'use consume'),
              /* C++'s own row id — stable across pick-ups and drops, which is
                 what lets the Favorites Shelf hold "pitch the Nordic tent" and
                 grey it honestly when the tent is gone. */
              pin: 'sv:' + r.id,
              run: function () { runRow(s.id, r); },
            });
          });
        });
        return rows;
      },
    });
  }

  const api = {
    hookInto: function (e) { env = e; },
    hooked: function () { return !!env; },
    open: open,
    close: close,
    isOpen: function () { return ui.open; },
    _state: state, _ui: ui, _visibleRows: visibleRows, _fire: fire,
    _setSection: setSection, _renderList: renderList,

    /* The vitals SEMANTICS, exported so the Survival TAB's needs card reads a
       meter the same way this popout does. One direction table, one set of
       bands, one set of words — two surfaces built on the same svStateResult
       must never disagree about whether you are starving. */
    needMeta: function (m) {
      if (!m || typeof m !== 'object') return null;
      const scale = needScale(m);
      const sev = m.off ? null : needSeverity(m, scale);
      const band = sevBand(sev);
      const id = String(m.id || '');
      const words = NEED_WORDS[id];
      return {
        max: scale.max, assumed: scale.assumed, severity: sev, band: band,
        sevClass: band >= 0 ? SEV_CLASS[band] : '',
        glyph: NEED_GLYPH[id] || '',
        word: m.off ? 'not tracked' : (words && band >= 0) ? words[band] : '',
      };
    },
  };

  /* A deep-open that raced this deferred script parked itself on the window
     (app.js's hdShowTab router) — consume it now, so the keypress that opened
     the deck is never silently dropped. */
  if (window.__hdPendingSurvival) {
    window.__hdPendingSurvival = null;
    open(true);
  }

  return api;
})();
