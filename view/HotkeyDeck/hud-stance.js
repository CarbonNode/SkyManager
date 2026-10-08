'use strict';

/* ============================================================================
   Stance Wheel — a slow-time radial picker for Stances NG (Rober, 2026-10-03:
   "a popout ui button that slows time shows the stances with their icons as a
   selector wheel then you select and it closes").

   Lives in the HUD view (hud.html) as its own fixed layer #hud-stance — a
   sibling of #hud-td / #hud-align. C++ opens it (seeded action `stance-wheel`),
   slows the world with BSTimer's global time multiplier, and gives this view
   UNPAUSED focus (the alignment overlay's discipline). Picking a stance closes
   the wheel FIRST, restores time, and only then presses Stances NG's OWN key
   for that stance, read live from StancesNG.toml — so Stances NG Combat
   Expansion's hotkey rules (Revert Stance holding Neutral) still apply. The
   deck implements no stance mechanics of its own.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (listeners on the HUD view):
     swGet()            — "push me the state" (once on open)
     swPick(json)       — {stance: 0|1|2|3|4}; the view has ALREADY closed itself
     swClose()          — the view closed itself without a pick (Esc, right-
                          click, ✕); C++ restores time and releases Focus
   C++ -> view:
     window.swShow("1"|"0")  — open / close
     window.swState(json)    — {ok, current, stances:[{id,name,key}], tarnished,
                                cycling, expansion,
                                icons:{bear,wolf,hawk,tarnished}, hand, msg}
     window.swKey()          — the wheel's own key was pressed again while it
                                is up: choose the highlighted stance, or close

   ⚠ Keys are delivered to BOTH this view and the game (the 2026-09-22 lesson
   in hud-align.js), and the world is still running — slowly. So the wheel is
   MOUSE-first: no number keys (they are Skyrim's favorites hotkeys), no WASD
   (movement). Enter confirms, Esc cancels; every control is also a click.

   ⚠ Ultralight laws observed: everything is wrapped so an uncaught error can
   never take the shared renderer down; no looping animations (one-shot class
   flips only); wedge geometry is written as SVG ATTRIBUTES, never CSS
   transforms on SVG children; explicit rgba() colours, no color-mix().
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('sw bridge error', fn, e); }
      return true;
    }
    if (DEV) console.log('[sw->game]', fn, arg);
    return false;
  }
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
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---- the four stances --------------------------------------------------
     Ids are Stances NG's own (stance-manager.h available_stances, and the
     value of its CurrentStance global 0x917): 0 Neutral, 1 Bear, 2 Wolf,
     3 Hawk. Colours are Stances NG - Combat Expansion's own palette, so the
     wheel and its on-screen indicator agree. Traits are Combat Expansion's
     DEFAULT effects, worded from its description — only shown when it is
     installed, because without it a stance is purely an animation set. */
  const DEF = {
    1: { slug: 'bear',    name: 'Bear',    rgb: '214, 69, 56',
         trait: 'Hits the hardest — but slow, exposed and tiring.' },
    2: { slug: 'wolf',    name: 'Wolf',    rgb: '148, 179, 214',
         trait: 'Trades a little damage for safer blocks and steadier footing.' },
    3: { slug: 'hawk',    name: 'Hawk',    rgb: '230, 179, 77',
         trait: 'Light and quick: faster swings and steps, cheaper power attacks, weaker blows.' },
    0: { slug: 'neutral', name: 'Neutral', rgb: '161, 161, 170',
         trait: 'No bonuses, no drawbacks.' },
    /* The fourth stance (Rober, 2026-10-07): not one of Stances NG's three but
       its own plugin, TarnishedStance.esp, carrying the Elden Ring movesets.
       Ash-gold, so it never reads as Hawk's amber. It has no stat changes, so
       its trait is shown with or without Combat Expansion. */
    4: { slug: 'tarnished', name: 'Tarnished', rgb: '236, 222, 182',
         trait: 'Elden Ring movesets for every weapon that has one. No stat changes.',
         always: true, keyless: 'Wheel only' }
  };
  /* Clockwise from the top. Neutral only appears when Stances NG has a key
     for it — a wedge the mod cannot act on would be a dead button — and
     Tarnished only when its plugin is loaded (state.tarnished). */
  const ORDER = [1, 2, 3, 4, 0];
  function wheelIds(s) {
    return ORDER.filter(function (id) {
      if (id === 4) return !!(s && s.tarnished);
      if (id !== 0) return true;
      return !!(s && s.stances && s.stances.some(function (x) { return x.id === 0 && x.key; }));
    });
  }

  /* ---- geometry ---------------------------------------------------------- */
  const SIZE = 640, C = SIZE / 2;
  const R_OUT = 300, R_IN = 124;     // the wedge band
  const GAP_DEG = 3;                 // hairline between wedges
  const DEAD = 70;                   // centre dead zone: no highlight in here

  function pt(r, deg) {              // deg clockwise from the top
    const a = (deg - 90) * Math.PI / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  }
  function sectorPath(a0, a1) {
    const large = (a1 - a0) > 180 ? 1 : 0;
    const p0 = pt(R_OUT, a0), p1 = pt(R_OUT, a1), p2 = pt(R_IN, a1), p3 = pt(R_IN, a0);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + R_OUT + ' ' + R_OUT + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) +
      ' L' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2) +
      ' A' + R_IN + ' ' + R_IN + ' 0 ' + large + ' 0 ' + p3[0].toFixed(2) + ' ' + p3[1].toFixed(2) + ' Z';
  }

  /* ---- state ------------------------------------------------------------- */
  let open = false;
  let st = null;          // last swState
  let ids = [];           // stance ids on the wheel, in ORDER
  let hi = -1;            // highlighted stance id, -1 = none
  let busy = false;       // a pick is on its way — ignore further input
  let root = null, frame = null, svgEl = null, wedges = {}, faces = {};
  let builtIcons = '';    // the icon set the open wheel was built with
  let hubName = null, hubTrait = null, hubCur = null, hubKey = null, noteEl = null;

  function host() { return document.getElementById('hud-stance'); }

  /* ---- build ------------------------------------------------------------- */
  function build() {
    root = host();
    if (!root) return false;
    root.textContent = '';
    wedges = {}; faces = {};
    builtIcons = JSON.stringify((st && st.icons) || {});

    frame = el('section', 'sw-frame');
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', 'Choose a stance');

    const title = el('div', 'sw-title');
    /* stance-wheel-options (2026-10-08): the player's own time multiplier and
       wheel size ride the state (stance-wheel.json, set from Home -> UI
       Elements). At 1 the world is not slowed, and the title must not claim
       it is. */
    const slow = Number(st && st.slow);
    title.append(el('span', 'sw-title-k', 'Stance'),
      el('span', 'sw-title-s', (isFinite(slow) && slow >= 0.999) ? 'time running' : 'time slowed'));

    const wrap = el('div', 'sw-wrap');
    /* The sheet's 64vh / 860px pair is the default. Another size keeps the
       same proportion between the two, so "Huge" is bigger at 1440p too
       (64vh alone is already past the 860px cap there). */
    const vh = Number(st && st.size);
    if (isFinite(vh) && vh >= 40 && vh <= 80 && Math.round(vh) !== 64) {
      const cap = Math.round(860 * vh / 64) + 'px';
      wrap.style.width = wrap.style.height = vh + 'vh';
      wrap.style.maxWidth = wrap.style.maxHeight = cap;
    }
    svgEl = svg('svg', { class: 'sw-svg', viewBox: '0 0 ' + SIZE + ' ' + SIZE, width: SIZE, height: SIZE });
    svgEl.append(
      svg('circle', { class: 'sw-halo', cx: C, cy: C, r: R_OUT + 14 }),
      svg('circle', { class: 'sw-rim', cx: C, cy: C, r: R_OUT + 6 }),
      svg('circle', { class: 'sw-hubdisc', cx: C, cy: C, r: R_IN - 10 }),
      svg('circle', { class: 'sw-hubring', cx: C, cy: C, r: R_IN - 10 })
    );

    const n = ids.length;
    const span = 360 / n;
    ids.forEach(function (id, i) {
      /* the first wedge is centred on the top */
      const a0 = i * span - span / 2 + GAP_DEG / 2;
      const a1 = (i + 1) * span - span / 2 - GAP_DEG / 2;
      const d = DEF[id];
      const g = svg('g', { class: 'sw-wedge', 'data-id': String(id) });
      /* dark base + gold edge first, the stance-colour tint drawn over it */
      g.append(
        svg('path', { class: 'sw-edge', d: sectorPath(a0, a1) }),
        svg('path', { class: 'sw-fill', d: sectorPath(a0, a1), style: 'fill: rgba(' + d.rgb + ', 0)' })
      );
      svgEl.append(g);
      wedges[id] = g;

      /* the face — icon + name + key — is HTML laid over the wedge centre */
      const mid = i * span;
      const c = pt((R_OUT + R_IN) / 2, mid);
      const face = el('div', 'sw-face');
      face.style.left = (c[0] / SIZE * 100).toFixed(3) + '%';
      face.style.top = (c[1] / SIZE * 100).toFixed(3) + '%';
      face.style.setProperty('--sw-rgb', d.rgb);
      face.append(iconFor(id), el('div', 'sw-name', d.name), el('div', 'sw-key'));
      wrap.append(face);
      faces[id] = face;
    });

    /* centre hub: what the hovered stance does, and what you are in now */
    const hub = el('div', 'sw-hub');
    hubName = el('div', 'sw-hub-name');
    hubTrait = el('div', 'sw-hub-trait');
    hubCur = el('div', 'sw-hub-cur');
    hub.append(hubName, hubTrait, hubCur);
    wrap.prepend(svgEl);
    wrap.append(hub);

    noteEl = el('div', 'sw-note');

    const foot = el('div', 'sw-foot');
    hubKey = el('div', 'sw-hint',
      'Aim and click · or press the wheel key again · Enter chooses · right-click or Esc cancels');
    const x = el('button', 'sw-x', 'Cancel');
    x.type = 'button';
    x.addEventListener('click', function (e) { e.stopPropagation(); cancel(); });
    foot.append(hubKey, x);

    frame.append(title, wrap, noteEl, foot);
    root.append(frame);
    /* Faces and hub are drawn for a 640 px wheel; scale them to the real one
       (offsetWidth is the LAYOUT size, unaffected by the entrance scale). */
    const k = wrap.offsetWidth ? wrap.offsetWidth / SIZE : 1;
    wrap.style.setProperty('--sw-k', k.toFixed(4));
    ids.forEach(function (id) { paintGlyph(id); });

    /* Pointer: the highlight follows the cursor's ANGLE from the centre (a
       flick toward a stance is enough — no need to land on the wedge), and a
       click anywhere outside the hub chooses it. Registered on the whole
       layer so a cursor that overshoots the wheel still steers. */
    root.onmousemove = function (e) { steer(e.clientX, e.clientY); };
    root.onmousedown = function (e) {
      if (busy) return;
      if (e.button === 2) { e.preventDefault(); cancel(); return; }
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('.sw-x')) return;
      steer(e.clientX, e.clientY);
      if (hi >= 0) choose(hi);
    };
    root.oncontextmenu = function (e) { e.preventDefault(); };
    return true;
  }

  /* The badge is Stances NG - Combat Expansion's own look (its on-screen
     stance indicator): a diamond in the stance colour with a hairline inner
     diamond, the stance's glyph tinted inside, and for Neutral a hollow
     centre diamond. The mod draws that frame itself and ships only the white
     bear/wolf/hawk glyphs (512 px, transparent), so the frame is geometry
     here too and the glyph is the INSTALLED mod's own file: C++ mirrors it
     into icons/sh, which every release excludes, so the deck never
     redistributes it. No file (Combat Expansion absent, or a load error) ->
     the stance's initial in the same badge. */
  const BADGE = 120;                         // px at a 640 px wheel (k = 1)
  const GLYPH = 0.56;                        // glyph box, share of the badge

  function iconFor(id) {
    const box = el('div', 'sw-icon');
    const d = DEF[id];
    const f = svg('svg', { class: 'sw-badge', viewBox: '0 0 100 100' });
    f.append(
      svg('polygon', { class: 'sw-b-out', points: '50,3 97,50 50,97 3,50',
        style: 'stroke: rgb(' + d.rgb + ')' }),
      svg('polygon', { class: 'sw-b-in', points: '50,12 88,50 50,88 12,50',
        style: 'stroke: rgba(' + d.rgb + ', .42)' })
    );
    if (id === 0)
      f.append(svg('polygon', { class: 'sw-b-mark', points: '50,37 63,50 50,63 37,50',
        style: 'stroke: rgb(' + d.rgb + ')' }));
    box.append(f);
    if (id !== 0) {
      const cv = el('canvas', 'sw-glyph');
      cv.setAttribute('aria-hidden', 'true');
      box.append(cv);
    }
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', d.name + ' stance');
    return box;
  }

  /* Draw one face's glyph at its REAL layout size (Ultralight rasterises at
     layout size; a scaled raster only gets blurrier), tinted to the stance
     colour with source-in. Async when the file has to load. */
  function paintGlyph(id) {
    const face = faces[id];
    const cv = face && face.querySelector('.sw-glyph');
    if (!cv) return;
    const px = Math.max(24, Math.round(cv.offsetWidth || BADGE * GLYPH));
    cv.width = px; cv.height = px;
    const d = DEF[id];
    const src = st && st.icons && st.icons[d.slug];
    const letter = function () {
      try {
        const c = cv.getContext('2d');
        if (!c) return;
        c.clearRect(0, 0, px, px);
        c.fillStyle = 'rgb(' + d.rgb + ')';
        c.font = '600 ' + Math.round(px * 0.62) + 'px Georgia, serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(d.name.charAt(0), px / 2, px / 2 + px * 0.03);
      } catch (e) {}
    };
    if (!src) { letter(); return; }
    const img = new Image();
    img.onload = function () {
      try {
        const c = cv.getContext('2d');
        if (!c) { letter(); return; }
        c.clearRect(0, 0, px, px);
        c.globalCompositeOperation = 'source-over';
        c.drawImage(img, 0, 0, px, px);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = 'rgb(' + d.rgb + ')';
        c.fillRect(0, 0, px, px);
        c.globalCompositeOperation = 'source-over';
        cv.dataset.art = '1';
      } catch (e) { letter(); }
    };
    img.onerror = letter;
    img.src = src;
  }

  /* ---- steering ---------------------------------------------------------- */
  function steer(x, y) {
    if (!svgEl || busy) return;
    const r = svgEl.getBoundingClientRect();
    if (!r.width) return;
    const k = SIZE / r.width;
    const dx = (x - (r.left + r.width / 2)) * k, dy = (y - (r.top + r.height / 2)) * k;
    if (dx * dx + dy * dy < DEAD * DEAD) { setHi(-1); return; }
    let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;      // 0 = top, clockwise
    deg = ((deg % 360) + 360) % 360;
    const span = 360 / ids.length;
    const i = Math.floor(((deg + span / 2) % 360) / span);
    setHi(ids[i]);
  }

  function setHi(id) {
    if (id === hi) return;
    hi = id;
    paint();
  }

  /* ---- paint ------------------------------------------------------------- */
  function keyFor(id) {
    const list = (st && st.stances) || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i].key || '';
    return '';
  }
  function keyLabel(id) {
    const k = keyFor(id);
    return k || (DEF[id] && DEF[id].keyless) || '';
  }
  function paint() {
    if (!frame) return;
    const cur = st && typeof st.current === 'number' ? st.current : -1;
    ids.forEach(function (id) {
      const on = id === hi, isCur = id === cur;
      const d = DEF[id];
      const g = wedges[id];
      if (g) {
        g.setAttribute('class', 'sw-wedge' + (on ? ' is-hi' : '') + (isCur ? ' is-cur' : ''));
        const fill = g.lastChild;
        /* opacity lives in the inline rgba so the hover tint never depends on
           fill-opacity support */
        fill.setAttribute('style', 'fill: rgba(' + d.rgb + ', ' + (on ? 0.34 : isCur ? 0.14 : 0.0) + ')');
      }
      const f = faces[id];
      if (f) {
        f.className = 'sw-face' + (on ? ' is-hi' : '') + (isCur ? ' is-cur' : '');
        const k = f.querySelector('.sw-key');
        if (k) k.textContent = isCur ? 'Current' : keyLabel(id);
      }
    });
    const show = hi >= 0 ? hi : cur;
    const d = DEF[show];
    hubName.textContent = d ? d.name : 'Stance';
    hubName.style.color = d ? 'rgb(' + d.rgb + ')' : '';
    hubTrait.textContent = !d ? '' : (d.always || (st && st.expansion)) ? d.trait
      : (show === 0 ? 'Your normal animations.' : 'Its own animation set.');
    hubCur.textContent = cur < 0 ? 'No stance yet'
      : hi >= 0 && hi !== cur ? 'Now: ' + DEF[cur].name
      : hi === cur ? 'You are in this stance' : 'Current stance';
  }

  function note(msg) {
    if (!noteEl) return;
    noteEl.textContent = msg || '';
    noteEl.className = 'sw-note' + (msg ? ' show' : '');
  }

  /* ---- actions ----------------------------------------------------------- */
  function choose(id) {
    if (busy || !open) return;
    const cur = st && typeof st.current === 'number' ? st.current : -1;
    busy = true;
    /* The view closes FIRST and tells C++ in the same breath: C++ releases the
       focus and restores time before it presses any key, so the stance key
       lands in a world running at full speed with no menu in the way. */
    closeLocal();
    toGame('swPick', JSON.stringify({ stance: id, same: id === cur }));
  }
  function cancel() {
    if (!open) return;
    closeLocal();
    toGame('swClose');
  }

  function doOpen() {
    if (open) return;
    open = true; busy = false; hi = -1;
    ids = wheelIds(st);
    /* Visible BEFORE build: build() measures the wheel's layout width to size
       the faces and glyph canvases, and a display:none layer measures 0. */
    document.body.classList.add('sw-open');
    if (!build()) { open = false; document.body.classList.remove('sw-open'); toGame('swClose'); return; }
    paint();
    note(st && st.msg ? st.msg : '');
    /* one-shot entrance: the class lands a frame after the DOM */
    setTimeout(function () { if (frame) frame.classList.add('sw-in'); }, 16);
    toGame('swGet');
  }
  function closeLocal() {
    open = false;
    hi = -1;
    document.body.classList.remove('sw-open');
    if (root) { root.onmousemove = root.onmousedown = root.oncontextmenu = null; root.textContent = ''; }
    root = frame = svgEl = null;
    wedges = {}; faces = {};
  }

  /* ---- C++ -> view ------------------------------------------------------- */
  window.swShow = function (v) {
    try {
      if (String(v) === '1') doOpen();
      else if (open) closeLocal();
    } catch (e) { try { toGame('hudLog', 'stance wheel: ' + e.message); } catch (e2) {} closeLocal(); toGame('swClose'); }
  };
  window.swState = function (raw) {
    try {
      const j = parse(raw);
      if (!j || typeof j !== 'object') return;
      st = j;
      if (!open) return;
      const want = wheelIds(j);
      /* icons and the Neutral / Tarnished wedges depend on state: rebuild once
         if the shape changed, otherwise just repaint */
      if (want.join(',') !== ids.join(',') || JSON.stringify(j.icons || {}) !== builtIcons) {
        const keepHi = hi;
        ids = want;
        build();
        document.body.classList.add('sw-open');
        if (frame) frame.classList.add('sw-in');
        hi = ids.indexOf(keepHi) !== -1 ? keepHi : -1;
      }
      paint();
      note(j.msg || '');
    } catch (e) { try { toGame('hudLog', 'stance wheel state: ' + e.message); } catch (e2) {} }
  };
  window.swKey = function () {
    if (!open) return;
    if (hi >= 0) choose(hi); else cancel();
  };

  /* Keys: only Enter and Esc. Capture phase so nothing else in the HUD
     document acts on them while the wheel is up. */
  window.addEventListener('keydown', function (e) {
    if (!open) return;
    const k = e.key, c = e.code;
    if (k === 'Escape' || c === 'Escape' || e.keyCode === 27) {
      cancel(); e.preventDefault(); e.stopPropagation(); return;
    }
    if (k === 'Enter' || c === 'Enter' || c === 'NumpadEnter') {
      if (hi >= 0) choose(hi);
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  window.HudStance = {
    isOpen: function () { return open; },
    _debug: function () { return { open: open, hi: hi, ids: ids.slice(), st: st }; }
  };
})();
