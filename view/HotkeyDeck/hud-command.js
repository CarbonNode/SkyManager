'use strict';

/* ============================================================================
   Command Ring (2026-10-12) — Warband's eight-slot order ring on SkyManager's
   backends. Rober, with Warband's HOMES ring on screen: "id like to integrate
   the commands system and camp system but with skymanager type UI ... hooks
   to our skymanager supported mods NFF and My home is your home - we also use
   this now Fight With Me".

   Four pages — ORDERS · CAMP · HOMES · BATTLE — of up to eight slots each, in
   Warband's places: 0-3 down the left, 4-7 down the right, a hub in the middle
   that names the page and says, for the slot under the cursor, what it does
   (or, dimmed, why it cannot right now).

   Lives in the HUD view (hud.html) as #hud-cmd, beside #hud-stance. C++ opens
   it (seeded action `command-ring`), slows the world and gives this view
   UNPAUSED focus — the Combat Wheel's discipline exactly. A pick closes the
   ring FIRST; C++ restores time and only then runs the command. The ring
   runs nothing itself: every command is a verb the deck already ships
   (NffControl, MhiyhControl, Campfire's spells, Domains' marker and travel,
   Fight With Me's own keys and export). See src/command_ring.{h,cpp}.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (HUD view listeners):
     crGet()           — push me the state
     crPick(json)      — {id} run that command (the view has ALREADY closed
                         itself); {page} only remembers the page for next open
     crClose()         — closed without a pick (Esc, right-click, the hint)
   C++ -> view:
     window.crShow("1"|"0")
     window.crState(json)   — {ok, page, size, slow, openKey,
                               pages:[{id,name,full,slots:[{slot,id,label,full,
                                        ok,why,confirm,key}]}],
                               band:{count,waiting,loaded,names},
                               camp:{up,name,dist,here}, fwm:{ok,roles,line}}
     window.crKey()         — the ring's own key again: pick the highlighted
                               command, or close when nothing is highlighted
     window.crCfgState(json)— {slow,size,…} (the deck's Home row reads it too)

   Keys (a focused view consumes them — browse mode's proven "the player stops
   moving"; the Combat Wheel ships the same set at Rober's ask): W A S D or the
   arrows walk the ring, E or Enter picks, Tab / Shift+Tab (or Page Down / Up,
   or the mouse wheel) turn the page, Esc closes. The cursor steers by ANGLE
   from the centre, anywhere on screen; a left click picks, a right click
   closes. Every control is also a click.

   ⚠ Ultralight laws: everything wrapped so an uncaught error can never take
   the shared renderer down (it would take the whole HUD with it); one-shot
   class flips only, no looping animation; sizes are px computed from --cr-k,
   never a transform: scale() of the ring.
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { try { console.log('cr bridge error', fn, e); } catch (e2) {} }
      return true;
    }
    if (DEV) { try { console.log('[cr->game]', fn, arg); } catch (e) {} }
    return false;
  }
  function log(msg) { try { toGame('hudLog', 'command ring: ' + msg); } catch (e) {} }
  function parse(s) {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* Warband's geometry: degrees clockwise from straight up, radius 232 on a
     1600x900 stage. 0-3 down the left, 4-7 down the right. */
  const ANG = [324, 288, 252, 216, 36, 72, 108, 144];
  const R = 232;
  /* the order WASD / arrows walk: down the left, then up the right (round the
     ring), exactly Warband's [0,1,2,3,7,6,5,4] */
  const WALK = [0, 1, 2, 3, 7, 6, 5, 4];
  const PAGE_ICON = {
    orders: 'icons/custom/hk-follower-command.png',
    camp: 'icons/custom/hk-camp-build.png',
    homes: 'icons/custom/hm-home.png',
    battle: 'icons/custom/hk-battle-plan.png'
  };
  const ARM_MS = 4000;

  let st = null;          /* the last crState */
  let open = false;
  let pageIdx = 0;
  let hi = -1;            /* highlighted SLOT number (0-7), -1 none */
  let armed = null;       /* {id, at} awaiting its second pick */
  let armTimer = 0;
  let busy = false;       /* a pick is on its way: ignore input */
  let root = null, anchor = null, hubIcon = null, titleEl = null, fullEl = null, statusEl = null, noteEl = null;
  let slotEls = {};       /* slot -> element */
  let pageEls = [];
  let keySeen = false;

  function pages() { return st && Array.isArray(st.pages) ? st.pages : []; }
  function page() { return pages()[pageIdx] || null; }
  function slotsOf(p) {
    const out = {};
    if (p && Array.isArray(p.slots))
      for (const s of p.slots)
        if (s && typeof s.slot === 'number' && s.slot >= 0 && s.slot < 8 && typeof s.id === 'string') out[s.slot] = s;
    return out;
  }

  /* --cr-k: Warband's stage scale times the player's size, clamped so the
     whole ring (about 1100 x 800 units) always fits the screen. */
  function scaleK() {
    const w = window.innerWidth || 1920, h = window.innerHeight || 1080;
    const base = Math.min(w / 1600, h / 900);
    const size = st && typeof st.size === 'number' && isFinite(st.size) ? Math.max(70, Math.min(140, st.size)) : 100;
    const fit = Math.min(w / 1180, h / 800);
    return Math.max(0.45, Math.min(base * size / 100, fit));
  }

  /* ---- build ---------------------------------------------------------------- */
  function build() {
    root = document.getElementById('hud-cmd');
    if (!root) return false;
    root.textContent = '';
    root.style.setProperty('--cr-k', String(scaleK()));
    anchor = el('div', 'cr-anchor');

    const hub = el('div', 'cr-hub');
    anchor.appendChild(hub);
    hubIcon = el('img', 'cr-hub-icon');
    hubIcon.alt = '';
    hubIcon.draggable = false;
    anchor.appendChild(hubIcon);
    titleEl = el('div', 'cr-title');
    anchor.appendChild(titleEl);
    const rule = el('div', 'cr-rule');
    rule.appendChild(el('i'));
    rule.appendChild(el('b'));
    rule.appendChild(el('i'));
    anchor.appendChild(rule);
    fullEl = el('div', 'cr-full');
    anchor.appendChild(fullEl);
    statusEl = el('div', 'cr-status');
    anchor.appendChild(statusEl);

    /* page strip */
    const strip = el('div', 'cr-pages');
    pageEls = [];
    pages().forEach(function (p, i) {
      if (i > 0) strip.appendChild(el('div', 'cr-page-sep'));
      const b = el('div', 'cr-page');
      b.appendChild(el('span', '', p.name || p.id));
      b.appendChild(el('i'));
      b.setAttribute('data-page', String(i));
      strip.appendChild(b);
      pageEls.push(b);
    });
    anchor.appendChild(strip);

    /* key hints */
    const keys = el('div', 'cr-keys');
    function hint(cap, text, act) {
      const h = el('div', 'cr-hint');
      h.appendChild(el('span', 'cr-cap', cap));
      h.appendChild(el('span', '', text));
      h.setAttribute('data-act', act);
      keys.appendChild(h);
    }
    hint('Esc', 'Close', 'close');
    hint('E', 'Choose', 'choose');
    hint('Tab', 'Next page', 'page');
    if (st && st.openKey) hint(st.openKey, 'Command ring', 'choose');
    anchor.appendChild(keys);

    noteEl = el('div', 'cr-note');
    anchor.appendChild(noteEl);

    root.appendChild(anchor);
    buildSlots();
    wire();
    return true;
  }

  function buildSlots() {
    for (const k in slotEls) { try { slotEls[k].remove(); } catch (e) {} }
    slotEls = {};
    const p = page();
    const slots = slotsOf(p);
    const k = scaleK();
    for (let s = 0; s < 8; ++s) {
      const d = slots[s];
      if (!d) continue;
      const a = ANG[s] * Math.PI / 180;
      const x = Math.sin(a) * R, y = -Math.cos(a) * R;
      const left = s < 4;
      const n = el('div', 'cr-slot ' + (left ? 'cr-left' : 'cr-right'));
      /* DOM order tick, chevron, label, key: row-reverse on the left puts the
         diamond on the hub side of both columns */
      n.appendChild(el('span', 'cr-tick'));
      n.appendChild(el('span', 'cr-chev', left ? '\u2039' : '\u203A'));
      n.appendChild(el('span', 'cr-label', d.label || d.id));
      if (d.key) n.appendChild(el('span', 'cr-key', d.key));
      if (left) n.style.right = (-x * k) + 'px';
      else n.style.left = (x * k) + 'px';
      n.style.top = (y * k) + 'px';
      /* a short stagger round the ring, so the page arrives rather than pops */
      n.style.transitionDelay = (WALK.indexOf(s) * 18) + 'ms';
      n.setAttribute('data-slot', String(s));
      if (!d.ok) n.classList.add('cr-off');
      anchor.appendChild(n);
      slotEls[s] = n;
    }
  }

  /* ---- paint ------------------------------------------------------------------ */
  function statusLine(p) {
    const band = st && st.band ? st.band : null;
    const camp = st && st.camp ? st.camp : null;
    const id = p ? p.id : '';
    if (id === 'camp') {
      if (!camp || !camp.up) return 'No camp yet';
      if (camp.here) return 'At camp';
      if (typeof camp.dist === 'number' && camp.dist >= 0) {
        const m = Math.round(camp.dist * 0.01428);
        return 'Camp ' + (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m') + ' away';
      }
      return 'Camp far away';
    }
    if (!band) return '';
    const n = band.count || 0;
    if (!n) return 'Nobody with you';
    if (band.waiting) return (n - band.waiting) + ' following \u00B7 ' + band.waiting + ' waiting';
    return n + (n === 1 ? ' follower' : ' followers');
  }

  function paint() {
    const p = page();
    if (!p || !anchor) return;
    titleEl.textContent = p.name || p.id;
    const icon = PAGE_ICON[p.id] || PAGE_ICON.orders;
    if (hubIcon.getAttribute('src') !== icon) hubIcon.setAttribute('src', icon);
    statusEl.textContent = statusLine(p);
    pageEls.forEach(function (b, i) { b.classList.toggle('cr-on', i === pageIdx); });
    const slots = slotsOf(p);
    let full = p.full || '', why = false, arm = false;
    for (const s in slotEls) {
      const n = slotEls[s], d = slots[s];
      const isHi = Number(s) === hi;
      n.classList.toggle('cr-hi', isHi);
      n.classList.toggle('cr-armed', !!(armed && d && armed.id === d.id));
      if (isHi && d) {
        if (!d.ok) { full = d.why || 'Not available right now'; why = true; }
        else if (armed && armed.id === d.id) { full = armLine(d); arm = true; }
        else full = d.full || d.label;
      }
    }
    fullEl.textContent = balance(full);
    fullEl.classList.toggle('cr-why', why);
    fullEl.classList.toggle('cr-armed', arm);
  }

  /* The second-pick line: short, so it stays clear of the status line. */
  function armLine(d) {
    const n = st && st.band ? st.band.count || 0 : 0;
    if (d.id === 'cr-home-here' && n) return 'Pick again to move\n' + (n === 1 ? 'her home here' : 'all ' + n + ' homes here');
    return 'Pick again to ' + (d.label || 'confirm').toLowerCase();
  }

  /* A long " · " list (Fight With Me's roles) breaks at the separator nearest
     its middle, into two even lines, instead of leaving one word alone on the
     last line. The hub draws it with white-space: pre-line. */
  function balance(text) {
    const SEP = ' \u00B7 ';
    if (typeof text !== 'string' || text.length < 26 || text.indexOf(SEP) < 0) return text;
    const parts = text.split(SEP);
    let best = 1, bestD = 1e9, run = 0;
    const total = text.length;
    for (let i = 1; i < parts.length; ++i) {
      run += parts[i - 1].length + (i > 1 ? SEP.length : 0);
      const d = Math.abs(total / 2 - run);
      if (d < bestD) { bestD = d; best = i; }
    }
    return parts.slice(0, best).join(SEP) + '\n' + parts.slice(best).join(SEP);
  }

  function note(msg) { if (noteEl) noteEl.textContent = msg || ''; }

  /* ---- input -------------------------------------------------------------------- */
  function setHi(s) {
    if (s === hi) return;
    hi = s;
    paint();
  }

  /* Highlight the slot nearest the cursor's angle from the centre. Inside a
     small dead zone round the centre, nothing (a click there picks nothing). */
  function steer(cx, cy) {
    const k = scaleK();
    const ox = (window.innerWidth || 1920) / 2, oy = (window.innerHeight || 1080) / 2;
    const dx = cx - ox, dy = cy - oy;
    if (Math.sqrt(dx * dx + dy * dy) < 60 * k) { setHi(-1); return; }
    let deg = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    let best = -1, bestD = 999;
    for (const s in slotEls) {
      let d = Math.abs(ANG[s] - deg);
      if (d > 180) d = 360 - d;
      if (d < bestD) { bestD = d; best = Number(s); }
    }
    setHi(best);
  }

  function step(dir) {
    const have = WALK.filter(function (s) { return slotEls[s]; });
    if (!have.length) return;
    let i = have.indexOf(hi);
    if (i < 0) i = dir > 0 ? -1 : 0;
    setHi(have[(i + dir + have.length) % have.length]);
  }

  function turnPage(dir) {
    const n = pages().length;
    if (!n) return;
    goPage((pageIdx + dir + n) % n);
  }

  function goPage(i) {
    if (i === pageIdx || i < 0 || i >= pages().length) return;
    pageIdx = i;
    hi = -1;
    disarm();
    note('');
    /* out, swap, in: the slots fade back out of the anchor's cr-in, are
       rebuilt, and arrive staggered again */
    buildSlots();
    paint();
    const fresh = [];
    for (const s in slotEls) { slotEls[s].style.opacity = '0'; fresh.push(slotEls[s]); }
    setTimeout(function () { fresh.forEach(function (n) { n.style.opacity = ''; }); }, 16);
    toGame('crPick', JSON.stringify({ page: page() ? page().id : 'orders' }));
  }

  function disarm() {
    armed = null;
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
  }

  function nope(s) {
    const n = slotEls[s];
    if (!n) return;
    n.classList.add('cr-nope');
    setTimeout(function () { if (n) n.classList.remove('cr-nope'); }, 90);
  }

  function choose(s) {
    if (busy) return;
    const d = slotsOf(page())[s];
    if (!d) return;
    if (!d.ok) { setHi(s); nope(s); return; }
    if (d.confirm && !(armed && armed.id === d.id && Date.now() - armed.at < ARM_MS)) {
      disarm();
      armed = { id: d.id, at: Date.now() };
      armTimer = setTimeout(function () { armed = null; armTimer = 0; try { paint(); } catch (e) {} }, ARM_MS);
      setHi(s);
      paint();
      return;
    }
    busy = true;
    disarm();
    const id = d.id, pg = page() ? page().id : 'orders';
    closeLocal();
    toGame('crPick', JSON.stringify({ id: id, page: pg }));
  }

  function cancel() {
    if (!open) return;
    closeLocal();
    toGame('crClose');
  }

  function wire() {
    root.onmousemove = function (e) {
      try { if (!busy) steer(e.clientX, e.clientY); } catch (x) {}
    };
    /* Right MOUSEDOWN closes (Ultralight does not reliably fire contextmenu in
       game — domains-pane.js); a left press on a page tab or a hint does that
       thing; anywhere else it picks the highlighted slot. */
    root.onmousedown = function (e) {
      try {
        if (busy) return;
        if (e.button === 2) { e.preventDefault(); cancel(); return; }
        if (e.button !== 0) return;
        const t = e.target && e.target.closest ? e.target : null;
        const pg = t && t.closest('.cr-page');
        if (pg) { goPage(Number(pg.getAttribute('data-page'))); return; }
        const h = t && t.closest('.cr-hint');
        if (h) {
          const act = h.getAttribute('data-act');
          if (act === 'close') cancel();
          else if (act === 'page') turnPage(1);
          else if (hi >= 0) choose(hi);
          return;
        }
        steer(e.clientX, e.clientY);
        if (hi >= 0) choose(hi);
      } catch (x) { log('mouse: ' + x.message); }
    };
    root.oncontextmenu = function (e) { try { e.preventDefault(); } catch (x) {} };
    root.onwheel = function (e) {
      try {
        if (busy) return;
        e.preventDefault();
        turnPage(e.deltaY > 0 ? 1 : -1);
      } catch (x) {}
    };
  }

  /* ---- open / close ------------------------------------------------------------ */
  function pageIndexOf(id) {
    const ps = pages();
    for (let i = 0; i < ps.length; ++i) if (ps[i] && ps[i].id === id) return i;
    return 0;
  }

  function doOpen() {
    if (open) return;
    if (!pages().length) { toGame('crClose'); return; }
    open = true; busy = false; hi = -1; keySeen = false;
    disarm();
    pageIdx = pageIndexOf(st.page);
    document.body.classList.add('cr-open');
    if (!build()) { open = false; document.body.classList.remove('cr-open'); toGame('crClose'); return; }
    paint();
    note(st && st.msg ? st.msg : '');
    setTimeout(function () { if (anchor) anchor.classList.add('cr-in'); }, 16);   /* one-shot entrance */
    toGame('crGet');
  }

  function closeLocal() {
    open = false;
    hi = -1;
    disarm();
    document.body.classList.remove('cr-open');
    if (root) { root.onmousemove = root.onmousedown = root.oncontextmenu = root.onwheel = null; root.textContent = ''; }
    root = anchor = hubIcon = titleEl = fullEl = statusEl = noteEl = null;
    slotEls = {};
    pageEls = [];
  }

  /* A state that arrives while the ring is up redraws in place, keeping the
     page and the highlight (the FWM key read lands a beat after the open). */
  function restate() {
    if (!open || !anchor) return;
    const keepHi = hi;
    const pid = page() ? page().id : null;
    root.style.setProperty('--cr-k', String(scaleK()));
    pageIdx = pid ? pageIndexOf(pid) : pageIdx;
    build();
    anchor.classList.add('cr-in');
    hi = slotEls[keepHi] ? keepHi : -1;
    paint();
  }

  /* ---- C++ -> view ----------------------------------------------------------- */
  window.crShow = function (v) {
    try {
      if (String(v) === '1') doOpen();
      else if (open) closeLocal();
    } catch (e) { log(e.message); try { closeLocal(); } catch (e2) {} toGame('crClose'); }
  };
  window.crState = function (raw) {
    try {
      const j = parse(raw);
      if (!j || typeof j !== 'object') return;
      st = j;
      if (open) restate();
    } catch (e) { log('state: ' + e.message); }
  };
  (function () {
    const prev = typeof window.crCfgState === 'function' ? window.crCfgState : null;
    window.crCfgState = function (raw) {
      if (prev) { try { prev(raw); } catch (e) {} }
      try {
        const j = parse(raw);
        if (j && typeof j === 'object' && st) {
          if (typeof j.size === 'number') st.size = j.size;
          if (typeof j.slow === 'number') st.slow = j.slow;
          if (open) restate();
        }
      } catch (e) {}
    };
  })();
  window.crKey = function () {
    try {
      if (!open) return;
      if (hi >= 0) choose(hi); else cancel();
    } catch (e) { log('key: ' + e.message); }
  };

  window.addEventListener('keydown', function (e) {
    if (!open) return;
    try {
      const k = e.key, c = e.code, kc = e.keyCode;
      if (!keySeen) {
        keySeen = true;
        /* marker: command-ring-first-key — proof in HotkeyDeck.log that keys
           reach the ring at all */
        log('first key ' + (k || c || kc));
      }
      const lk = typeof k === 'string' ? k.toLowerCase() : '';
      let handled = true;
      if (k === 'Escape' || kc === 27) cancel();
      else if (k === 'Enter' || c === 'NumpadEnter' || kc === 13 || lk === 'e' || kc === 69) { if (hi >= 0) choose(hi); }
      else if (k === 'Tab' || kc === 9) turnPage(e.shiftKey ? -1 : 1);
      else if (k === 'PageDown' || kc === 34) turnPage(1);
      else if (k === 'PageUp' || kc === 33) turnPage(-1);
      else if (k === 'ArrowDown' || k === 'ArrowRight' || lk === 's' || lk === 'd' || kc === 40 || kc === 39 || kc === 83 || kc === 68) step(1);
      else if (k === 'ArrowUp' || k === 'ArrowLeft' || lk === 'w' || lk === 'a' || kc === 38 || kc === 37 || kc === 87 || kc === 65) step(-1);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    } catch (x) { log('keys: ' + x.message); }
  }, true);

  window.HudCommand = {
    isOpen: function () { return open; },
    _debug: function () { return { open: open, hi: hi, page: page() ? page().id : null, armed: armed ? armed.id : null, slots: Object.keys(slotEls).map(Number) }; },
    _step: step,
    _page: goPage,
    _choose: choose,
    _steer: steer
  };
})();
