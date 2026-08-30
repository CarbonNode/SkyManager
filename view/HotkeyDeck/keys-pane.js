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
    plugin:  ['Plugin config', 'kc-src-plugin'],
    papyrus: ['Papyrus script', 'kc-src-papyrus'],
    enb:     ['ENB', 'kc-src-enb'],
    reshade: ['ReShade', 'kc-src-reshade'],
    shaders: ['Community Shaders', 'kc-src-shaders'],
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
    dropGroupMemo();          // new bindings: the grouping and the count chip restate
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

  /* bindings -> [{code, name, owners:[binding..], kind:'hard'|'maybe'|'soft'|''}]
     hard  = two or more non-vanilla owners on one key, all of them certain
             about which key they mean (a real fight);
     maybe = the same collision, but at least one side is a row C++ marked
             `guess` — a plugin config that never said whether its number is a
             DirectInput scancode or a Windows virtual-key. Those two spaces
             disagree (68 is D in one and F10 in the other), so calling it a
             conflict would be a confident claim we cannot back;
     soft  = one certain non-vanilla owner sharing a key the game itself uses. */
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
      const distinctOf = (rows) => {
        const seen = {};
        rows.forEach((o) => { seen[o.mod || '?'] = true; });
        return Object.keys(seen).length;
      };
      const distinct = distinctOf(modded);
      const distinctSure = distinctOf(modded.filter((o) => !o.guess));
      const overGame = g.owners.length > modded.length;
      g.kind = distinctSure >= 2 ? 'hard'
        : (distinctSure === 1 && overGame) ? 'soft'
          : (distinct >= 2 || (distinct === 1 && overGame)) ? 'maybe' : '';
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

  /* The haystack is built ONCE per group and hung off it, not re-lowercased for
     every owner on every keystroke. A group object only ever comes out of
     groupKeys, and groupedNow() rebuilds those whenever the bindings change, so
     it cannot go stale. */
  function hayOf(g) {
    if (g.__hay === undefined) {
      let h = String(g.name || '').toLowerCase();
      for (let i = 0; i < g.owners.length; i++) {
        const o = g.owners[i];
        h += '\u0000' + String(o.mod || '').toLowerCase() +
             '\u0000' + String(o.control || '').toLowerCase() +
             '\u0000' + String(o.mods || '').toLowerCase();
      }
      g.__hay = h;
    }
    return g.__hay;
  }

  function matches(g, needle) {
    if (!needle) return true;
    return hayOf(g).indexOf(needle.toLowerCase()) !== -1;
  }

  /* Row identity for the keyed reconcile below. The owner chips ARE the row's
     content, so the signature has to hash WHO owns the key and what they call
     it — an owner count cannot. Hashing only the count is what let a background
     refresh that swapped one mod for another (iEquip -> TrueHUD, still one
     owner) leave the old mod and control on screen forever: the model moved on
     and the DOM never did. Memoised on the group exactly like __hay — a group
     object only ever comes out of groupKeys, which is rebuilt whenever the
     bindings change, so it cannot go stale. */
  function ownerSig(g) {
    if (g.__osig === undefined) {
      let s = '';
      for (let i = 0; i < g.owners.length; i++) {
        const o = g.owners[i];
        s += '\u0001' + String(o.src || '') + '\u0002' + String(o.mod || '') +
             '\u0002' + String(o.control || '') + '\u0002' + String(o.mods || '');
      }
      g.__osig = s;
    }
    return g.__osig;
  }

  /* Legend chips subtract whole SOURCES before grouping, so conflict kinds
     recompute honestly: hide "Game" and a soft over-vanilla row becomes a
     clean single-owner row, not a leftover badge. */
  function activeBindings() {
    return state.bindings.filter((b) => !ui.srcOff[b.src] && !isDeadRow(b));
  }

  /* groupKeys walks every binding and allocates a Map plus a group object per
     key. It depends on the BINDINGS and on which sources are switched off —
     never on the filter — so it is memoised on exactly those two. The old shape
     re-grouped 900 bindings on every letter typed for a result that could not
     have changed. */
  let groupMemo = null, groupMemoKey = '';
  function groupedNow() {
    const key = state.seq + '|' + state.bindings.length + '|' + Object.keys(ui.srcOff)
      .filter((k) => ui.srcOff[k]).sort().join(',');
    if (!groupMemo || groupMemoKey !== key) { groupMemo = groupKeys(activeBindings()); groupMemoKey = key; }
    return groupMemo;
  }
  /* The census as a whole, ignoring the legend's per-source hiding: the count
     chip and the omni provider both speak for the WHOLE load order, so neither
     may read groupedNow(). Memoised beside it and dropped by the same call. */
  let allGroupMemo = null;
  function allGroups() {
    if (!allGroupMemo) allGroupMemo = groupKeys(state.bindings);
    return allGroupMemo;
  }
  let omniMemo = null;
  function dropGroupMemo() { groupMemo = null; allGroupMemo = null; omniMemo = null; }

  function visibleGroups() {
    let groups = groupedNow();
    if (ui.conflictsOnly) groups = groups.filter((g) => g.kind);
    groups = groups.filter((g) => matches(g, ui.filter));
    const rank = { hard: 0, maybe: 1, soft: 2, '': 3 };
    /* filter() already handed back a fresh array in every path above except the
       unfiltered one, and sorting the memo in place would be a lie about what
       is cached — copy before sorting. */
    groups = groups.slice();
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
      /* The chip counts over ALL bindings (legend filters must not change the
         census), so it cannot share groupedNow()'s memo — see allGroups(). */
      const groups = allGroups();
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
    const order = ['mcm', 'helper', 'plugin', 'papyrus', 'vanilla', 'deck', 'chord',
      'enb', 'reshade', 'shaders'];
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

  /* A row's provenance, when C++ sent one: the file and setting it was read
     from. It is the answer to "says who?", so it rides the hover title of both
     the chip and the detail row. */
  function whereFrom(o) {
    return o.detail ? '\n' + o.detail : '';
  }

  function ownerChip(o) {
    const meta = SRC_META[o.src] || [o.src || '?', 'kc-src-mcm'];
    const modsPfx = o.mods ? esc(o.mods) + ' + ' : '';
    /* The MOD NAME leads the tooltip because it is the part that ellipsizes: a
       hover that omitted it left a truncated name with no way to read it. And
       `guess` = the code space was assumed (see groupKeys) — said on the chip
       itself, not only in the group badge, so the uncertainty travels with the
       mod that owns it. */
    const guessNote = o.guess
      ? '\nAssumed to be a DirectInput scancode \u2014 the file didn\u2019t say.' : '';
    return '<span class="kc-owner ' + meta[1] + (o.guess ? ' kc-owner-guess' : '') +
      '" title="' + esc(o.mod || '?') + ' \u2014 ' + esc(meta[0]) + ' \u00b7 ' +
      esc(o.control || '') + esc(guessNote) + esc(whereFrom(o)) + '">' +
      '<b>' + esc(o.mod || '?') + '</b>' +
      (o.control ? '<i>' + modsPfx + esc(o.control) + '</i>' : '') +
      (o.guess ? '<u title="Assumed key code">?</u>' : '') +
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
      body.classList.remove('kc-body-off');
      return;
    }

    const groups = visibleGroups();
    if (!groups.length) {
      body.innerHTML = '';
      empty.classList.remove('hidden');
      /* An emptied body is still flex:1 in the column, so it would hold half the
         pane open above the message and strand it in the lower third. Take it
         out of the flow entirely while the empty panel owns the space. */
      body.classList.add('kc-body-off');
      if (!realBindings().length && state.phase !== 'error') {
        /* "No scan yet" is only honest if we never got an answer. A sweep that
           finished and legitimately found nothing (SkyUI absent, every MCM timed
           out, an unreadable ControlMap) must say THAT \u2014 telling the user the
           census never ran when it did is the one lie this pane must not tell. */
        const swept = state.scannedOnce || state.lastLoadedSeq >= 0 || state.phase === 'done';
        empty.innerHTML = swept
          ? ('<div class="kc-empty-title">No hotkeys found</div>' +
             '<div class="kc-empty-sub">The sweep finished and came back empty \u2014 no MCM, MCM Helper, ' +
             'SKSE plugin config, Papyrus script, Chord Keys or game control reported a key. ' +
             'That usually means SkyUI didn\u2019t answer. ' +
             'Hit <b>\u27f3 Rescan all</b> to force a full re-census.</div>')
          : ('<div class="kc-empty-title">No scan yet</div>' +
             '<div class="kc-empty-sub">Hit <b>\u27f3 Rescan all</b> to census every hotkey in the load order \u2014 ' +
             'MCM mods, MCM Helper mods, SKSE plugin configs, compiled Papyrus scripts, ' +
             'the game\u2019s own controls, Chord Keys, the deck itself, and ' +
             'ENB / ReShade / Community Shaders.</div>');
      } else if (state.phase !== 'error') {
        empty.innerHTML = '<div class="kc-empty-title">' +
          (ui.conflictsOnly && !ui.filter ? 'No conflicts' : 'Nothing matches') + '</div>' +
          '<div class="kc-empty-sub">' +
          (ui.conflictsOnly && !ui.filter
            ? 'Every claimed key has a single owner. That’s a tidy load order.'
            : 'Try fewer letters, or clear the ⚠ filter.') + '</div>';
      }
      return;
    }
    empty.classList.add('hidden');
    body.classList.remove('kc-body-off');

    /* Keyed reconcile instead of one big innerHTML. Every row and every open
       detail block is cached by key code; a keystroke that only narrows the
       list re-uses the nodes it keeps and creates nothing. The old shape
       rebuilt all ~250 rows AND re-attached a click listener to each of them on
       every letter typed. */
    const want = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const open = !!ui.expanded[g.code];
      want.push({ k: 'r' + g.code, sig: g.kind + (open ? '1' : '0') + '|' + g.name + ownerSig(g),
        html: function () {
          const badge = g.kind === 'hard'
            ? '<span class="kc-badge kc-badge-hard">⚠ ' + 'conflict</span>'
            : g.kind === 'maybe'
              ? '<span class="kc-badge kc-badge-maybe" title="One of these came from a ' +
                'plugin config that never said whether its number is a DirectInput scancode ' +
                'or a Windows virtual-key — so this may or may not be the same key.">' +
                'possible — assumed key code</span>'
              : g.kind === 'soft'
                ? '<span class="kc-badge kc-badge-soft">over game key</span>' : '';
          return '<div class="kc-row' + (g.kind === 'hard' ? ' kc-row-hard' : '') +
            (open ? ' kc-row-open' : '') + '" data-code="' + g.code + '" tabindex="0" ' +
            'title="Click for the full breakdown">' +
            '<div class="kc-key' + (g.kind === 'hard' ? ' kc-key-hard' : '') + '">' + esc(g.name) + '</div>' +
            '<div class="kc-owners">' + g.owners.map(ownerChip).join('') + '</div>' +
            badge + '</div>';
        } });
      if (open) {
        want.push({ k: 'd' + g.code, sig: ownerSig(g), html: function () {
          return '<div class="kc-detail" data-code="' + g.code + '">' +
            g.owners.map((o) => {
              const meta = SRC_META[o.src] || [o.src || '?', 'kc-src-mcm'];
              return '<div class="kc-detail-row"' +
                (o.detail ? ' title="' + esc(o.detail) + '"' : '') + '>' +
                '<span class="kc-owner ' + meta[1] + '"><b>' + esc(meta[0]) + '</b></span>' +
                '<span class="kc-detail-mod">' + esc(o.mod || '?') + '</span>' +
                '<span class="kc-detail-ctl">' + (o.mods ? esc(o.mods) + ' + ' : '') +
                esc(o.control || '') + '</span>' +
                (o.guess
                  ? '<span class="kc-detail-guess" title="The config states a number but ' +
                    'not which code space it is in; the census assumed DirectInput.">' +
                    'assumed code</span>'
                  : '') +
                (o.detail ? '<span class="kc-detail-src">' + esc(o.detail) + '</span>' : '') +
                '</div>';
            }).join('') + '</div>';
        } });
      }
    }
    reconcile(body, want);
    wireBodyDelegate(body);
  }

  /* Keyed DOM reconcile — the same shape the other big-list panes use. A node
     whose key and signature both hold is reused verbatim and only MOVED. */
  const kcTmpl = document.createElement('div');
  const kcNodes = new Map();
  function reconcile(host, items) {
    let cur = host.firstChild;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let node = kcNodes.get(it.k);
      if (!node || node.__kcSig !== it.sig) {
        kcTmpl.innerHTML = it.html();
        node = kcTmpl.firstElementChild;
        if (!node) continue;
        kcTmpl.removeChild(node);
        node.__kcSig = it.sig;
        kcNodes.set(it.k, node);
      }
      if (cur === node) { cur = cur.nextSibling; continue; }
      host.insertBefore(node, cur);
    }
    while (cur) { const nx = cur.nextSibling; host.removeChild(cur); cur = nx; }
  }

  function rowOf(e, body) {
    const t = e.target;
    const row = t && t.closest ? t.closest('.kc-row') : null;
    if (!row || row.classList.contains('kc-skel') || !body.contains(row)) return null;
    return row;
  }

  function toggleRow(row, keepFocus) {
    const code = row.getAttribute('data-code');
    ui.expanded[code] = !ui.expanded[code];
    render();
    /* The reconcile replaces a row node whose open-state changed, so a keyboard
       user's focus would land on <body> and the next Enter would do nothing.
       Put it back on the row they just worked. (data-code is always a number,
       so the selector needs no escaping.) */
    if (keepFocus) {
      const again = document.querySelector('#kc-body .kc-row[data-code="' + code + '"]');
      if (again) again.focus();
    }
  }

  /* ONE listener for the whole grid, attached once. */
  let bodyWired = false;
  function wireBodyDelegate(body) {
    if (bodyWired) return;
    bodyWired = true;
    body.addEventListener('click', (e) => {
      const row = rowOf(e, body);
      if (row) toggleRow(row, false);
    });
    /* Rows ship tabindex="0" and a :focus-visible ring, so they ADVERTISE
       themselves as keyboard-operable — Enter and Space must actually expand
       them or the affordance is a lie. Space would otherwise scroll the list. */
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const row = rowOf(e, body);
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      toggleRow(row, true);
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
    disarmSpotlight();   // the tab can never open already-listening
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

  /* The spotlight is a MODE, and its chrome must never outlive it. Leaving the
     tab drops capture, so a button still reading "Press any key…" on return
     would send the next keypress into the search box as a literal letter while
     claiming it was listening. One function owns both halves. */
  function disarmSpotlight() {
    ui.capturing = false;
    const spot = $('kc-spotlight');
    if (spot) { spot.classList.remove('kc-toggle-on'); spot.textContent = '⌨ Find a key'; }
  }

  /* The other half, so the mode has exactly one owner either way: the header
     button and the omni row that opens the tab already listening both come
     through here rather than each writing the chrome themselves. */
  function armSpotlight() {
    ui.capturing = true;
    const spot = $('kc-spotlight');
    if (spot) { spot.classList.add('kc-toggle-on'); spot.textContent = 'Press any key…'; }
  }

  /* Same reason as armSpotlight: the ⚠ button and the omni row that turns the
     view on must not each keep their own idea of what the button reads. */
  function setConflictsOnly(on) {
    ui.conflictsOnly = !!on;
    const btn = $('kc-conflicts-btn');
    if (btn) btn.classList.toggle('kc-toggle-on', ui.conflictsOnly);
    render();
  }

  function onHide() {
    ui.visible = false;
    disarmSpotlight();
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
        /* Escape is NOT handled here — see the window-capture listener below. */
      });
      /* Escape while typing must clear the filter, not slam the whole deck shut.
         app.js owns Escape from a document-level CAPTURE listener, so a bubble
         handler on the input can never get there first — its stopPropagation
         runs long after requestClose(). Capture order is window BEFORE document,
         so this is the only seat from which the pane can win the key. Kept
         deliberately narrow: our tab, our box, and only when there is something
         to clear — every other Escape still closes the deck as it should. */
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !ui.visible) return;
        if (e.target !== filter || !filter.value) return;
        filter.value = ''; ui.filter = ''; render();
        e.preventDefault();
        e.stopPropagation();
      }, true);
    }
    const conflicts = $('kc-conflicts-btn');
    if (conflicts) {
      conflicts.addEventListener('click', () => setConflictsOnly(!ui.conflictsOnly));
    }
    const re = $('kc-rescan');
    if (re) re.addEventListener('click', () => rescan(true));

    const spot = $('kc-spotlight');
    if (spot) {
      spot.addEventListener('click', () => {
        if (ui.capturing) { disarmSpotlight(); return; }   // one owner for the "off" chrome
        armSpotlight();
      });
      document.addEventListener('keydown', (e) => {
        if (!ui.capturing || !ui.visible) return;
        const dik = BROWSER_TO_DIK[e.code];
        disarmSpotlight();
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

  /* This pane has no host object, so it reaches the deck the way every other
     provider's item-level jump does — through the setTab app.js publishes. */
  function goToTab() {
    if (typeof window.__omniSetTab === 'function') window.__omniSetTab('keys');
  }

  /* Land ON the key, not merely on the tab: the row is expanded to its
     breakdown first, then the pane's own filter is narrowed to that key's name
     (the spotlight's idiom — a key name is what this pane searches by), and the
     row is brought into view. */
  function showKey(g) {
    goToTab();
    ui.expanded[g.code] = true;
    setFilter(g.name);
    const row = document.querySelector('#kc-body .kc-row[data-code="' + g.code + '"]');
    /* Guarded the way every other pane guards it: an older webview without
       scrollIntoView still lands on the right tab with the right row open. */
    if (row && row.scrollIntoView) {
      try { row.scrollIntoView({ block: 'center' }); } catch (e) { /* not fatal */ }
    }
  }

  /* One row per KEY — the whole census, not just the fights. "Who owns F5",
     "Wildcat", "Cycle Left" are all questions this tab holds the answer to, and
     a key claimed by exactly ONE mod (the overwhelming majority) is the common
     case, so filtering to conflicts made the deck's biggest data set answer
     almost nothing.

     index() is called on every keystroke, so the rows are memoised exactly like
     the groupings they are built from, and dropped by the same
     dropGroupMemo() — a fresh census rebuilds them, a keystroke never does. */
  function omniRows() {
    if (omniMemo) return omniMemo;
    const rows = allGroups().map((g) => {
      const mods = [];
      g.owners.forEach((o) => {
        const m = o.mod || '?';
        if (mods.indexOf(m) === -1) mods.push(m);
      });
      const who = mods.slice(0, 3).join(', ') +
        (mods.length > 3 ? ' +' + (mods.length - 3) + ' more' : '');
      const what = g.owners.map((o) => o.control).filter(Boolean).slice(0, 3).join(' · ');
      const lead = g.kind === 'hard'
        ? '⚠ ' + mods.length + ' mods claim this key'
        : g.kind === 'soft'
          ? 'Over a game control'
          : (SRC_META[g.owners[0].src] || ['Bound', ''])[0];
      return {
        label: g.name + ' — ' + who,
        detail: lead + (what ? ' · ' + what : ''),
        kind: g.kind === 'hard' ? 'key conflict' : 'key',
        /* hayOf() is the pane's own search haystack (key name, every mod, every
           control, every chord prefix), already built and memoised — reusing it
           means omni and the tab can never disagree about what a key matches.
           The player's words for the thing go in front of it. */
        keywords: 'key hotkey bind binding keybind shortcut bound to who owns unbind ' +
          hayOf(g).split('\u0000').join(' '),
        jump: function () { showKey(g); },
      };
    });
    /* The tools sit with the keys because they are what a player wants when the
       census itself is the answer: find what a key does, see only the fights,
       or re-take the whole census. */
    rows.push({
      label: '⌨ Find a key', detail: 'Press a key and its row lights up',
      kind: 'keys',
      keywords: 'keys find key press any key spotlight identify what is this key bound to which mod',
      run: function () { goToTab(); armSpotlight(); },
    });
    rows.push({
      label: '⚠ Show only key conflicts', detail: 'Hide every key that has a single owner',
      kind: 'keys',
      keywords: 'keys conflicts only clashes fights double bound two mods same key show',
      run: function () { goToTab(); setConflictsOnly(true); },
    });
    rows.push({
      label: '⟳ Rescan all hotkeys',
      detail: 'Re-census the whole load order, retrying MCMs that didn’t answer',
      kind: 'keys',
      keywords: 'keys rescan re-scan refresh census again sweep update mcm bindings',
      run: function () { goToTab(); rescan(true); },
    });
    rows.push({
      label: 'Key Census', detail: 'Every hotkey in the load order, and what conflicts',
      kind: 'keys', keywords: 'keys census hotkey conflict mcm scan bindings' });
    omniMemo = rows;
    return omniMemo;
  }

  if (window.HDOmni) HDOmni.register({
    id: 'keys', label: 'Keys', tab: 'keys',
    setFilter: setFilter,
    /* Omni can be opened having never visited this tab, and index() may not talk
       to the bridge — so the one cheap ask happens here. kcState only: if C++
       already holds a census its reply's new seq pulls the rows in (see
       kcStateResult). It never starts a sweep — that costs a Papyrus pass over
       every MCM and stays the player's own choice. */
    warm: function () { if (!state.bindings.length) toGame('kcState', ''); },
    index: omniRows,
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
