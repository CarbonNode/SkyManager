'use strict';

/* ====================================================================== *
 *  Keys — the load-order hotkey census tab (Rober relay, 2026-08-12:
 *  "grab all the current hotkeys across all MCM mods — and then show where
 *  and what keys conflict — highly polished UI").
 *
 *  C++ owns the scan (keys_scan.cpp): live ControlMap + MCM Helper configs +
 *  Chord Keys + the deck's own triggers + a LIVE sweep of every classic MCM
 *  through SkyUI's own GetCustomControl — the same API MCM itself uses for
 *  its "already used by X" prompt. This pane owns grouping, conflict math,
 *  search and presentation.
 *
 *  Bridge — requests: kcScan() · kcState() · kcResult()
 *  Replies (disjoint, per the deck law): kcStateResult({phase,note,modsDone,
 *  modsTotal,count,seq}) · kcResultData(same + bindings:[{src,mod,control,
 *  code,mods?}])
 *
 *  Host contract (mirrors LootPane): KeysPane.init() · onShow() · onHide() ·
 *  toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.KeysPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const POLL_MS = 700;   // scan progress cadence while the tab is up

  /* ============================================================= names == */

  /* DXScanCode -> display name. Keyboard mirrors chords.cpp's table; 256+ is
     the SkyUI mouse convention. Unknown codes render as their hex, never
     blank — a row you can't name is still a row you can act on. */
  const KC_NAMES = (function () {
    const n = {
      1: 'Esc', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8',
      10: '9', 11: '0', 12: '-', 13: '=', 14: 'Backspace', 15: 'Tab',
      16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I',
      24: 'O', 25: 'P', 26: '[', 27: ']', 28: 'Enter', 29: 'LCtrl',
      30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K',
      38: 'L', 39: ';', 40: "'", 41: '`', 42: 'LShift', 43: '\\',
      44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M',
      51: ',', 52: '.', 53: '/', 54: 'RShift', 55: 'Num *', 56: 'LAlt',
      57: 'Space', 58: 'CapsLock',
      69: 'NumLock', 70: 'ScrollLock',
      71: 'Num 7', 72: 'Num 8', 73: 'Num 9', 74: 'Num -',
      75: 'Num 4', 76: 'Num 5', 77: 'Num 6', 78: 'Num +',
      79: 'Num 1', 80: 'Num 2', 81: 'Num 3', 82: 'Num 0', 83: 'Num .',
      87: 'F11', 88: 'F12',
      156: 'Num Enter', 157: 'RCtrl', 181: 'Num /', 184: 'RAlt',
      183: 'PrtScr', 197: 'Pause',
      199: 'Home', 200: 'Up', 201: 'PgUp', 203: 'Left', 205: 'Right',
      207: 'End', 208: 'Down', 209: 'PgDn', 210: 'Insert', 211: 'Delete',
    };
    for (let i = 0; i < 10; i++) n[59 + i] = 'F' + (i + 1);            // F1..F10
    for (let i = 0; i < 11; i++) n[100 + i] = 'F' + (13 + i);          // F13..F23 (ext codes)
    n[118] = 'F24';
    for (let i = 0; i < 11; i++) n[89 + i] = 'C' + (i + 1);            // Chord Keys pool
    const mouse = ['Left Click', 'Right Click', 'Middle Click', 'Mouse 4',
      'Mouse 5', 'Mouse 6', 'Mouse 7', 'Mouse 8'];
    mouse.forEach((m, i) => { n[256 + i] = m; });
    n[264] = 'Wheel Up'; n[265] = 'Wheel Down';
    return n;
  })();

  function keyName(code) {
    return KC_NAMES[code] || ('Key 0x' + Number(code).toString(16).toUpperCase());
  }

  /* Browser KeyboardEvent.code -> DXScanCode, for the press-to-find
     spotlight. Common keys only; an unmapped press just does nothing. */
  const BROWSER_TO_DIK = (function () {
    const m = {
      Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
      BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
      Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
      Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, AltLeft: 56,
      Space: 57, CapsLock: 58, NumLock: 69, ScrollLock: 70,
      NumpadEnter: 156, ControlRight: 157, NumpadDivide: 181, AltRight: 184,
      Home: 199, ArrowUp: 200, PageUp: 201, ArrowLeft: 203, ArrowRight: 205,
      End: 207, ArrowDown: 208, PageDown: 209, Insert: 210, Delete: 211,
      NumpadMultiply: 55, NumpadSubtract: 74, NumpadAdd: 78,
      Numpad7: 71, Numpad8: 72, Numpad9: 73, Numpad4: 75, Numpad5: 76,
      Numpad6: 77, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
      NumpadDecimal: 83,
    };
    'QWERTYUIOP'.split('').forEach((c, i) => { m['Key' + c] = 16 + i; });
    'ASDFGHJKL'.split('').forEach((c, i) => { m['Key' + c] = 30 + i; });
    'ZXCVBNM'.split('').forEach((c, i) => { m['Key' + c] = 44 + i; });
    '1234567890'.split('').forEach((c, i) => { m['Digit' + c] = 2 + i; });
    for (let i = 1; i <= 12; i++) m['F' + i] = i <= 10 ? 58 + i : 76 + i;   // F11=87 F12=88
    m.F11 = 87; m.F12 = 88;
    return m;
  })();

  /* Source -> chip label + hue class. Unknown sources still render. */
  const SRC_META = {
    vanilla: ['Game', 'kc-src-vanilla'],
    deck:    ['SkyManager', 'kc-src-deck'],
    chord:   ['Chord Keys', 'kc-src-chord'],
    helper:  ['MCM Helper', 'kc-src-helper'],
    mcm:     ['MCM', 'kc-src-mcm'],
  };

  /* ============================================================= state == */

  const state = {
    phase: 'idle',      // idle | scanning | refreshing | done | error
    note: '',
    modsDone: 0,
    modsTotal: 0,
    count: 0,
    seq: 0,
    lastLoadedSeq: -1,  // which seq's bindings we hold
    bindings: [],
    scannedOnce: false,
  };

  /* Phases where real rows are on screen and useful — 'refreshing' means the
     cache is already shown and a background re-sweep is catching up (an in-game
     rebind self-heals within a pass), so we must NOT blank the body or block. */
  function isUsablePhase(p) { return p === 'done' || p === 'refreshing'; }
  function isBusyPhase(p) { return p === 'scanning' || p === 'refreshing'; }

  const ui = {
    filter: '',
    conflictsOnly: false,
    srcOff: {},         // source key -> true when hidden by its legend chip
    expanded: {},       // code -> true
    capturing: false,   // press-to-find armed
    pollT: null,
    visible: false,
  };

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && (fn === 'kcScan' || fn === 'kcState')) setTimeout(devState, 30);
      if (DEV && fn === 'kcResult') setTimeout(devResult, 30);
    }
  }

  window.kcStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.phase = d.phase || 'idle';
    state.note = d.note || '';
    state.modsDone = d.modsDone | 0;
    state.modsTotal = d.modsTotal | 0;
    state.count = d.count | 0;
    state.seq = d.seq | 0;
    /* Any new seq while rows are usable means the C++ side republished (cache
       seed, or a config whose answer changed during the background refresh) —
       pull it. The seq bumps per change, so 'refreshing' streams rows in the
       same way 'done' delivers the final set. */
    if (isUsablePhase(state.phase) && state.seq !== state.lastLoadedSeq) {
      toGame('kcResult', '');
    }
    /* Opening the tab while a scan/refresh (started on an earlier open) is still
       running: the reply is what tells us it's live, so the poll starts HERE,
       not only in rescan() — otherwise the progress freezes. */
    if (isBusyPhase(state.phase) && ui.visible && !ui.pollT) startPoll();
    if (ui.visible) renderStatus();
  };

  window.kcResultData = function (d) {
    if (!d || typeof d !== 'object') return;
    state.phase = d.phase || state.phase;
    state.bindings = Array.isArray(d.bindings) ? d.bindings : [];
    state.count = state.bindings.length;
    state.seq = d.seq | 0;
    state.lastLoadedSeq = state.seq;
    /* A background refresh republishes as it goes — rows that change under the
       user must not jump the scroll position out from under them. Preserve and
       restore #kc-body's scrollTop across the re-render. */
    if (ui.visible) renderPreservingScroll();
  };

  function renderPreservingScroll() {
    const body = $('kc-body');
    const top = body ? body.scrollTop : 0;
    render();
    const b2 = $('kc-body');
    if (b2) b2.scrollTop = top;
  }

  /* ========================================================== grouping == */

  /* bindings -> [{code, name, owners:[binding..], kind:'hard'|'soft'|''}]
     hard = two or more non-vanilla owners on one key (a real fight);
     soft = one non-vanilla owner sharing a key the game itself uses. */
  function groupKeys(bindings) {
    const byCode = new Map();
    bindings.forEach((b) => {
      if (!b || !b.code) return;
      let g = byCode.get(b.code);
      if (!g) { g = { code: b.code, name: keyName(b.code), owners: [] }; byCode.set(b.code, g); }
      g.owners.push(b);
    });
    const out = [];
    byCode.forEach((g) => {
      const modded = g.owners.filter((o) => o.src !== 'vanilla');
      /* Distinct owners, not raw rows: one mod claiming a key twice (two MCM
         controls on one key) is that mod's own business, not a conflict. */
      const mods = {};
      modded.forEach((o) => { mods[o.mod || '?'] = true; });
      const distinct = Object.keys(mods).length;
      g.kind = distinct >= 2 ? 'hard'
        : (distinct === 1 && g.owners.length > modded.length) ? 'soft' : '';
      out.push(g);
    });
    return out;
  }

  /* C++ emits a code-0 sentinel row per MCM that timed out ("didn't answer") so
     a dead config is never silently missing. It isn't a real key bind, so it's
     kept out of the key grid and surfaced as an honest note instead. */
  function isDeadRow(b) { return b && b.src === 'mcm' && !b.code; }
  function realBindings() { return state.bindings.filter((b) => !isDeadRow(b)); }
  function deadConfigs() {
    return state.bindings.filter(isDeadRow).map((b) => b.mod || '?');
  }

  function matches(g, needle) {
    if (!needle) return true;
    const n = needle.toLowerCase();
    if (g.name.toLowerCase().indexOf(n) !== -1) return true;
    return g.owners.some((o) =>
      (o.mod || '').toLowerCase().indexOf(n) !== -1 ||
      (o.control || '').toLowerCase().indexOf(n) !== -1 ||
      (o.mods || '').toLowerCase().indexOf(n) !== -1);
  }

  /* Legend chips subtract whole SOURCES before grouping, so conflict kinds
     recompute honestly: hide "Game" and a soft over-vanilla row becomes a
     clean single-owner row, not a leftover badge. */
  function activeBindings() {
    return state.bindings.filter((b) => !ui.srcOff[b.src] && !isDeadRow(b));
  }

  function visibleGroups() {
    let groups = groupKeys(activeBindings());
    if (ui.conflictsOnly) groups = groups.filter((g) => g.kind);
    groups = groups.filter((g) => matches(g, ui.filter));
    const rank = { hard: 0, soft: 1, '': 2 };
    groups.sort((a, b) =>
      (rank[a.kind] - rank[b.kind]) ||
      (b.owners.length - a.owners.length) ||
      (a.code - b.code));
    return groups;
  }

  /* ============================================================ render == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderStatus() {
    const bar = $('kc-progress');
    if (!bar) return;
    /* Two shapes: a blocking progress bar for a COLD/forced scan (no usable rows
       yet), and a lightweight "refreshing N of M in the background" chip when the
       cache is already on screen — never a blocking bar over live rows. */
    const cold = state.phase === 'scanning';
    const refreshing = state.phase === 'refreshing';
    if (cold || refreshing) {
      bar.classList.remove('hidden');
      bar.classList.toggle('kc-progress-bg', refreshing);
      const total = state.modsTotal;
      const pct = total ? Math.round((state.modsDone / total) * 100) : 5;
      $('kc-progress-fill').style.width = Math.max(5, pct) + '%';
      $('kc-progress-text').textContent = refreshing
        ? ('Refreshing from cache — ' + state.modsDone + ' of ' + total + ' in the background' +
           (state.note && state.note !== 'catching up' ? ' · ' + state.note : ''))
        : (total
          ? ('Asking each MCM what it owns — ' + state.modsDone + '/' + total +
             (state.note ? ' · ' + state.note : ''))
          : ('Scanning…' + (state.note ? ' ' + state.note : '')));
    } else {
      bar.classList.add('hidden');
      bar.classList.remove('kc-progress-bg');
    }
    const chip = $('kc-count-chip');
    if (chip) {
      const groups = groupKeys(state.bindings);
      const hard = groups.filter((g) => g.kind === 'hard').length;
      const real = realBindings().length;
      chip.textContent = real
        ? (groups.length + ' keys · ' + real + ' bindings' +
           (hard ? ' · ' + hard + ' conflicts' : ''))
        : '';
      chip.classList.toggle('kc-chip-warn', hard > 0);
    }
    const re = $('kc-rescan');
    if (re) {
      /* Rescan = the FULL forced sweep (ignores the cache, re-tries dead
         configs). Disabled while any scan/refresh is in flight since C++ refuses
         a second concurrent scan. */
      const busy = isBusyPhase(state.phase);
      re.disabled = busy;
      re.textContent = state.phase === 'refreshing' ? '⟳ Refreshing…'
        : busy ? '⟳ Scanning…' : '⟳ Rescan all';
    }
    renderDeadNote();
    renderLegend();
    if (state.phase === 'error') {
      const empty = $('kc-empty');
      if (empty) {
        empty.classList.remove('hidden');
        empty.innerHTML = '<div class="kc-empty-title">Scan failed</div>' +
          '<div class="kc-empty-sub">' + esc(state.note || 'Unknown error') +
          ' — hit ⟳ Rescan to try again.</div>';
      }
    }
  }

  /* The legend doubles as a per-source filter: each chip shows its live
     binding count, click hides/shows that source everywhere (rows regroup,
     conflict badges recompute). Chips render only for sources present. */
  function renderLegend() {
    const box = $('kc-legend');
    if (!box) return;
    const counts = {};
    realBindings().forEach((b) => { counts[b.src] = (counts[b.src] || 0) + 1; });
    const order = ['mcm', 'helper', 'vanilla', 'deck', 'chord'];
    const srcs = order.filter((s) => counts[s]).concat(
      Object.keys(counts).filter((s) => order.indexOf(s) === -1));
    if (!srcs.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<span class="kc-legend-label">Sources</span>' + srcs.map((s) => {
      const meta = SRC_META[s] || [s, 'kc-src-mcm'];
      const off = !!ui.srcOff[s];
      return '<button class="kc-legend-chip ' + meta[1] + (off ? ' kc-legend-off' : '') +
        '" data-src="' + esc(s) + '" title="' + (off ? 'Show ' : 'Hide ') + esc(meta[0]) +
        ' bindings">' + esc(meta[0]) + ' <b>' + counts[s] + '</b></button>';
    }).join('');
    box.querySelectorAll('.kc-legend-chip').forEach((b) => {
      b.addEventListener('click', () => {
        const s = b.getAttribute('data-src');
        if (ui.srcOff[s]) delete ui.srcOff[s]; else ui.srcOff[s] = true;
        render();
      });
    });
  }

  /* Honest note for MCMs that timed out: they were asked but their script never
     answered (usually broken), so their keys couldn't be read. They're skipped
     until a forced Rescan all, and named here so the census never silently omits
     them. */
  function renderDeadNote() {
    let box = $('kc-dead');
    if (!box) {
      /* Created lazily so no shared index.html edit is required: it slots right
         after the legend, above the key body. */
      const legend = $('kc-legend');
      const pane = document.getElementById('kc-pane');
      if (!pane) return;
      box = document.createElement('div');
      box.id = 'kc-dead';
      box.className = 'hidden';
      if (legend && legend.parentNode) legend.parentNode.insertBefore(box, legend.nextSibling);
      else pane.appendChild(box);
    }
    const dead = deadConfigs();
    if (!dead.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const names = dead.slice(0, 6).map(esc).join(', ') +
      (dead.length > 6 ? ' +' + (dead.length - 6) + ' more' : '');
    box.innerHTML = '<span class="kc-dead-icon">⚠</span>' +
      '<span>' + dead.length + ' MCM' + (dead.length > 1 ? 's' : '') +
      ' didn’t answer (' + names + ') — their keys couldn’t be read. ' +
      '<b>⟳ Rescan all</b> to retry.</span>';
  }

  function ownerChip(o) {
    const meta = SRC_META[o.src] || [o.src || '?', 'kc-src-mcm'];
    const modsPfx = o.mods ? esc(o.mods) + ' + ' : '';
    return '<span class="kc-owner ' + meta[1] + '" title="' + esc(meta[0]) + ' · ' +
      esc(o.control || '') + '">' +
      '<b>' + esc(o.mod || '?') + '</b>' +
      (o.control ? '<i>' + modsPfx + esc(o.control) + '</i>' : '') +
      '</span>';
  }

  function render() {
    renderStatus();
    const body = $('kc-body');
    const empty = $('kc-empty');
    if (!body || !empty) return;

    if (state.phase === 'scanning' && !state.bindings.length) {
      // skeletons sized like real rows, so the page doesn't jump when data lands
      body.innerHTML = new Array(8).fill(
        '<div class="kc-row kc-skel"><div class="kc-key kc-skel-box"></div>' +
        '<div class="kc-owners"><span class="kc-skel-box kc-skel-w1"></span>' +
        '<span class="kc-skel-box kc-skel-w2"></span></div></div>').join('');
      empty.classList.add('hidden');
      return;
    }

    const groups = visibleGroups();
    if (!groups.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      if (!realBindings().length && state.phase !== 'error') {
        empty.innerHTML = '<div class="kc-empty-title">No scan yet</div>' +
          '<div class="kc-empty-sub">Hit <b>⟳ Rescan all</b> to census every hotkey in the load order — ' +
          'MCM mods, MCM Helper mods, the game’s own controls, Chord Keys and the deck itself.</div>';
      } else if (state.phase !== 'error') {
        empty.innerHTML = '<div class="kc-empty-title">' +
          (ui.conflictsOnly && !ui.filter ? 'No conflicts 🎉' : 'Nothing matches') + '</div>' +
          '<div class="kc-empty-sub">' +
          (ui.conflictsOnly && !ui.filter
            ? 'Every claimed key has a single owner. That’s a tidy load order.'
            : 'Try fewer letters, or clear the ⚠ filter.') + '</div>';
      }
      return;
    }
    empty.classList.add('hidden');

    let html = '';
    groups.forEach((g) => {
      const open = !!ui.expanded[g.code];
      const badge = g.kind === 'hard'
        ? '<span class="kc-badge kc-badge-hard">⚠ ' + 'conflict</span>'
        : g.kind === 'soft'
          ? '<span class="kc-badge kc-badge-soft">over game key</span>' : '';
      html += '<div class="kc-row' + (g.kind === 'hard' ? ' kc-row-hard' : '') +
        (open ? ' kc-row-open' : '') + '" data-code="' + g.code + '" tabindex="0" ' +
        'title="Click for the full breakdown">' +
        '<div class="kc-key' + (g.kind === 'hard' ? ' kc-key-hard' : '') + '">' + esc(g.name) + '</div>' +
        '<div class="kc-owners">' + g.owners.map(ownerChip).join('') + '</div>' +
        badge + '</div>';
      if (open) {
        html += '<div class="kc-detail" data-code="' + g.code + '">' +
          g.owners.map((o) => {
            const meta = SRC_META[o.src] || [o.src || '?', 'kc-src-mcm'];
            return '<div class="kc-detail-row">' +
              '<span class="kc-owner ' + meta[1] + '"><b>' + esc(meta[0]) + '</b></span>' +
              '<span class="kc-detail-mod">' + esc(o.mod || '?') + '</span>' +
              '<span class="kc-detail-ctl">' + (o.mods ? esc(o.mods) + ' + ' : '') +
              esc(o.control || '') + '</span></div>';
          }).join('') + '</div>';
      }
    });
    body.innerHTML = html;

    body.querySelectorAll('.kc-row:not(.kc-skel)').forEach((row) => {
      row.addEventListener('click', () => {
        const code = row.getAttribute('data-code');
        ui.expanded[code] = !ui.expanded[code];
        render();
      });
    });
  }

  /* ========================================================= lifecycle == */

  function startPoll() {
    stopPoll();
    ui.pollT = setInterval(() => {
      if (isBusyPhase(state.phase)) toGame('kcState', '');
      else stopPoll();
    }, POLL_MS);
  }

  function stopPoll() {
    if (ui.pollT) { clearInterval(ui.pollT); ui.pollT = null; }
  }

  /* force=true is the "Rescan all" button: a full sweep that ignores the cache
     and re-tries dead configs. The auto-scan on first open (force=false) is
     cache-first — instant cached rows, then a background refresh. */
  function rescan(force) {
    state.scannedOnce = true;
    ui.expanded = {};
    toGame('kcScan', force ? 'force' : '');
    state.phase = 'scanning';
    startPoll();
    render();
  }

  function onShow() {
    ui.visible = true;
    const filter = $('kc-filter');
    if (filter) { filter.value = ui.filter; setTimeout(() => filter.focus(), 30); }
    toGame('kcState', '');
    /* First look of the session starts the census on its own — an empty tab
       that waits for a button press reads as broken, not as patient. */
    if (!state.scannedOnce && !state.bindings.length) {
      setTimeout(() => {
        if (ui.visible && state.phase === 'idle' && !state.bindings.length) rescan(false);
      }, 250);
    } else if (isBusyPhase(state.phase)) {
      startPoll();
    }
    render();
  }

  function onHide() {
    ui.visible = false;
    ui.capturing = false;
    stopPoll();
  }

  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* Focus-jump used by the omni provider: land on the tab with a key row
     spotlighted. */
  function setFilter(text) {
    ui.filter = String(text || '');
    const f = $('kc-filter');
    if (f) f.value = ui.filter;
    render();
  }

  function init() {
    const filter = $('kc-filter');
    if (filter) {
      filter.addEventListener('input', () => { ui.filter = filter.value.trim(); render(); });
      filter.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          /* Enter = expand the top hit — the deck's standing search idiom. */
          const top = visibleGroups()[0];
          if (top) { ui.expanded[top.code] = true; render(); }
          e.stopPropagation();
        }
        if (e.key === 'Escape' && filter.value) {
          filter.value = ''; ui.filter = ''; render();
          e.stopPropagation();
        }
      });
    }
    const conflicts = $('kc-conflicts-btn');
    if (conflicts) {
      conflicts.addEventListener('click', () => {
        ui.conflictsOnly = !ui.conflictsOnly;
        conflicts.classList.toggle('kc-toggle-on', ui.conflictsOnly);
        render();
      });
    }
    const re = $('kc-rescan');
    if (re) re.addEventListener('click', () => rescan(true));

    const spot = $('kc-spotlight');
    if (spot) {
      spot.addEventListener('click', () => {
        ui.capturing = !ui.capturing;
        spot.classList.toggle('kc-toggle-on', ui.capturing);
        spot.textContent = ui.capturing ? 'Press any key…' : '⌨ Find a key';
      });
      document.addEventListener('keydown', (e) => {
        if (!ui.capturing || !ui.visible) return;
        const dik = BROWSER_TO_DIK[e.code];
        ui.capturing = false;
        spot.classList.remove('kc-toggle-on');
        spot.textContent = '⌨ Find a key';
        if (dik) {
          setFilter(keyName(dik));
          const f = $('kc-filter');
          if (f) f.focus();
        }
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }
    if (SELFTEST) setTimeout(selftest, 60);
  }

  /* =============================================================== dev == */

  function devState() {
    window.kcStateResult({ phase: 'done', note: '', modsDone: 3, modsTotal: 3, count: 8, seq: 1 });
  }

  function devResult() {
    window.kcResultData({ phase: 'done', seq: 1, bindings: [
      { src: 'vanilla', mod: 'Skyrim', control: 'Sprint', code: 56 },
      { src: 'mcm', mod: 'iEquip', control: 'Cycle Left', code: 34 },
      { src: 'mcm', mod: 'Wildcat', control: 'Toggle injuries', code: 34 },
      { src: 'helper', mod: 'Precision', control: 'Debug toggle', code: 34 },
      { src: 'deck', mod: 'SkyManager', control: 'Open deck (F7)', code: 65 },
      { src: 'chord', mod: 'Chord Keys', control: 'chord -> output 0x64', code: 8, mods: 'Shift+Alt' },
      { src: 'mcm', mod: 'TrueHUD', control: 'Widget toggle', code: 87 },
      { src: 'vanilla', mod: 'Skyrim', control: 'Shout', code: 44 },
    ] });
  }

  /* ========================================================== selftest == */

  function selftest() {
    const out = [];
    function ok(name, cond) { out.push((cond ? 'ok   ' : 'FAIL ') + name); }

    devState(); devResult();

    ok('name table: G', keyName(34) === 'G');
    ok('name table: mouse', keyName(258) === 'Middle Click');
    ok('name table: chord pool', keyName(89) === 'C1');
    ok('name table: unknown hex', keyName(254) === 'Key 0xFE');

    const groups = groupKeys(state.bindings);
    const g34 = groups.find((g) => g.code === 34);
    ok('grouping: G has 3 owners', g34 && g34.owners.length === 3);
    ok('conflict: G is hard', g34 && g34.kind === 'hard');
    const g56 = groups.find((g) => g.code === 56);
    ok('conflict: vanilla-only is none', g56 && g56.kind === '');

    ui.filter = 'iequip';
    ok('filter: mod name matches', visibleGroups().length === 1 && visibleGroups()[0].code === 34);
    ui.filter = '';
    ui.conflictsOnly = true;
    ok('conflicts-only: 1 group', visibleGroups().length === 1);
    ui.conflictsOnly = false;

    const ranked = visibleGroups();
    ok('sort: hard conflict first', ranked.length && ranked[0].code === 34);

    ok('browser map: KeyG', BROWSER_TO_DIK.KeyG === 34);
    ok('browser map: F11', BROWSER_TO_DIK.F11 === 87);

    ui.visible = true;
    render();
    ok('render: rows in DOM', document.querySelectorAll('#kc-body .kc-row').length === ranked.length);
    ok('render: hard row flagged', !!document.querySelector('#kc-body .kc-row-hard'));
    ui.expanded[34] = true;
    render();
    ok('render: detail expands', !!document.querySelector('#kc-body .kc-detail'));
    ui.expanded = {};

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
    id: 'keys', label: 'Keys', tab: 'keys',
    setFilter: setFilter,
    index: function () {
      const items = groupKeys(state.bindings)
        .filter((g) => g.kind === 'hard')
        .map((g) => ({
          label: g.name + ' — ' + g.owners.length + ' owners',
          detail: 'Key conflict · ' + g.owners.map((o) => o.mod).join(' vs '),
          kind: 'keys',
          keywords: 'key conflict hotkey bind ' + g.name + ' ' + g.owners.map((o) => o.mod).join(' '),
          filter: g.name,
        }));
      items.push({ label: 'Key Census', detail: 'Every hotkey in the load order, and what conflicts',
        kind: 'keys', keywords: 'keys census hotkey conflict mcm scan bindings' });
      return items;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause, setFilter,
    _state: state, _ui: ui, _groupKeys: groupKeys, _visibleGroups: visibleGroups,
    _keyName: keyName
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.KeysPane.init());
} else {
  window.KeysPane.init();
}
