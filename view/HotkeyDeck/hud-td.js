'use strict';

/* ============================================================================
   Time Dial — the hotkey-openable circular wait dial (Rober, 2026-08-18:
   "new hotkeyable (openable) time widget that should look really nice like
   this [vanilla wait-dial screenshot] … using our in app time system.
   scalable, draggable, remembers where it was when hotkey triggers").

   Lives in the HUD view (hud.html) as its own fixed layer #hud-td — a sibling
   of the assembly and the free widgets, so none of their visibility classes
   touch it. C++ opens it (seeded action `time-dial`), Focuses the view while
   it is up, and jumps the clock through TimeActions::Jump — the SAME one-step
   GameHour mechanism the Time tab uses, so the dial can never disagree with
   the pane about how waiting works.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (listeners registered on the HUD view):
     tdGet()            — "push me the clock" (polled ~1 Hz while open)
     tdWait(hoursStr)   — jump the clock this many hours
     tdClose()          — the view closed itself (Esc / ✕ / after confirm);
                          C++ Unfocuses and re-evaluates view visibility
   C++ -> view (one name per direction):
     window.tdShow("1"|"0")  — open / close the dial
     window.tdState(json)    — placement {x,y,anchorH,anchorV,scale} (the
                               Widget shape from src/widgets.cpp)
     window.tdInfo(json)     — {hour,day,month,year,daysPassed} (TimeActions)
     window.tdResult(json)   — {ok,msg,hours} after a tdWait

   Placement persists through the widgets sidecar: on drag/scale end this
   module sends a PARTIAL wgSave — {"widgets":{"timeDial":{…}}} — which
   ConfigFromLocked merges without touching any other key (the documented
   partial-write contract). That is what "remembers where it was" means here.

   ⚠ Ultralight laws observed: everything is wrapped so an uncaught load error
   can never take the shared renderer down (the 0xC0000005 class); there are
   no looping animations (every transition is a one-shot class flip); and the
   dial geometry is written as SVG ATTRIBUTES, never CSS transforms on SVG
   children (unproven in this renderer).
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('td bridge error', fn, e); }
      return true;
    }
    if (DEV) console.log('[td->game]', fn, arg);
    return false;
  }
  function toGameAny(names, arg) {
    for (let i = 0; i < names.length; i++)
      if (typeof window[names[i]] === 'function') return toGame(names[i], arg);
    if (DEV) console.log('[td->game?]', names.join('/'), arg);
    return false;
  }
  function parse(s) {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /* ---- state ------------------------------------------------------------ */
  const cfg = { x: 0, y: 140, anchorH: 'center', anchorV: 'top', scale: 1 };
  let open = false;
  let cur = null;          // last tdInfo {hour,day,month,year,daysPassed}
  let sel = 1;             // selected span: hours (1-24) or days (1-7)
  let mode = 'hours';      // 'hours' | 'days'
  let busy = false;        // one jump in flight
  let pollT = 0;
  let noteT = 0;

  /* ---- calendar formatting (the Time pane's own tables) ----------------- */
  const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand",
    'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire',
    'Frostfall', "Sun's Dusk", 'Evening Star'];
  const MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const WEEKDAYS = ['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas'];

  function fmt24(hour) {
    const h = Math.floor(((hour % 24) + 24) % 24), m = Math.floor((hour - Math.floor(hour)) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function ordinal(n) {
    if (n % 10 === 1 && n !== 11) return n + 'st';
    if (n % 10 === 2 && n !== 12) return n + 'nd';
    if (n % 10 === 3 && n !== 13) return n + 'rd';
    return n + 'th';
  }
  function weekday(daysPassed) {
    const d = Math.floor(Number(daysPassed) || 0) % 7;
    return WEEKDAYS[(d + 7) % 7];
  }
  function fmtDate(info) {
    const mon = MONTHS[Math.max(0, Math.min(11, (info.month | 0)))] || '?';
    return weekday(info.daysPassed) + ', ' + ordinal(info.day | 0) + ' of ' + mon + ', 4E ' + (info.year | 0);
  }
  /* the landing calendar after +h hours — the Time pane's forecast walk */
  function landAfter(info, h) {
    const n = { hour: info.hour + h, day: info.day | 0, month: info.month | 0,
      year: info.year | 0, daysPassed: Number(info.daysPassed) || 0 };
    while (n.hour >= 24) {
      n.hour -= 24; n.day += 1; n.daysPassed += 1;
      const len = MONTH_LEN[n.month] || 31;
      if (n.day > len) { n.day = 1; n.month += 1; if (n.month > 11) { n.month = 0; n.year += 1; } }
    }
    return n;
  }

  /* ---- dial geometry ----------------------------------------------------
     Hour -> degrees measured clockwise from the TOP of the dial, with
     midnight at the BOTTOM (the Time pane's own convention, and the
     reference image's: sun up top, moon down bottom, dawn left, dusk right).
       deg(h) = h/24*360 + 180   (mod 360)
     Screen point at radius R: x = cx + R*sin(deg), y = cy - R*cos(deg). */
  const SIZE = 560, CX = SIZE / 2, CY = SIZE / 2;
  const R_RING = 252;      // outer gold ring
  const R_TRACK = 224;     // the arc / handle track
  const R_CARD = 252;      // cardinal medallion centers ride the ring
  const BAND = 46;         // half-width of the grabbable ring band
  const CIRC = 2 * Math.PI * R_TRACK;   // arc track circumference, px

  function degOfHour(h) { return (((h / 24) * 360 + 180) % 360 + 360) % 360; }
  function ptAt(deg, r) {
    const a = deg * Math.PI / 180;
    return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
  }
  /* pointer position (dial-local px) -> hour on the dial face */
  function hourFromPoint(x, y) {
    const dx = x - CX, dy = y - CY;
    let deg = Math.atan2(dx, -dy) * 180 / Math.PI;   // 0 = top, CW positive
    deg = ((deg % 360) + 360) % 360;
    return (((deg - 180) % 360 + 360) % 360) / 360 * 24;
  }
  /* span (in the active mode's units) from the current hour to a dial hour */
  function spanFromHour(h) {
    if (!cur) return sel;
    let d = (h - cur.hour) % 24; if (d < 0) d += 24;
    if (mode === 'days') {
      const dd = Math.round((d / 24) * 7);
      return clamp(dd === 0 ? 7 : dd, 1, 7);
    }
    const hh = Math.round(d);
    return clamp(hh === 0 ? 24 : hh, 1, 24);
  }
  function selHours() { return mode === 'days' ? sel * 24 : sel; }
  /* hours until a target o'clock; already there = the full day around */
  function hoursUntil(target) {
    if (!cur) return 24;
    let h = Math.round(((target - (cur.hour % 24) + 24) % 24));
    if (h < 1) h = 24;
    return h;
  }

  /* ---- inline SVG glyphs (drawn here, the deck's own gold) --------------- */
  const NS = 'http://www.w3.org/2000/svg';
  const GLYPH = {
    sun: '<circle cx="12" cy="12" r="4.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.4v3.2M12 18.4v3.2M2.4 12h3.2M18.4 12h3.2M5.2 5.2l2.3 2.3M16.5 16.5l2.3 2.3M18.8 5.2l-2.3 2.3M7.5 16.5l-2.3 2.3"/></g>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/>',
    dawn: '<path d="M4 16.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 16.5a4.5 4.5 0 0 1 9 0z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 6.5v2.6M6.2 9l1.8 1.8M17.8 9 16 10.8"/></g><path d="M9.6 4.6 12 2.2l2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    dusk: '<path d="M4 16.5h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 16.5a4.5 4.5 0 0 1 9 0z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 6.5v2.6M6.2 9l1.8 1.8M17.8 9 16 10.8"/></g><path d="M9.6 3.4 12 5.8l2.4-2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  function glyphSvg(name, px) {
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" aria-hidden="true">' + (GLYPH[name] || GLYPH.sun) + '</svg>';
  }
  function glyphForHour(h) {
    const t = ((h % 24) + 24) % 24;
    if (t >= 5 && t < 8) return 'dawn';
    if (t >= 8 && t < 17) return 'sun';
    if (t >= 17 && t < 20) return 'dusk';
    return 'moon';
  }

  /* ---- DOM -------------------------------------------------------------- */
  const root = document.getElementById('hud-td');
  const el = {};   // frame, head, headN, headUnit, svg, arc, handleO, handleI,
                   // center, glyph, from, to, date, note, confirm, modeBtn, dialwrap

  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    return n;
  }
  function h(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function build() {
    if (!root || el.frame) return;

    const frame = h('div', { class: 'td-frame' });
    el.frame = frame;

    /* move / size chips */
    const tools = h('div', { class: 'td-tools' });
    el.grip = h('button', { class: 'td-tool td-grip', type: 'button', title: 'Drag to move the dial — arrow keys nudge (Shift = 10 px)' }, '✥ Move');
    el.smaller = h('button', { class: 'td-tool', type: 'button', title: 'Smaller' }, '−');
    el.bigger = h('button', { class: 'td-tool', type: 'button', title: 'Bigger' }, '＋');
    tools.appendChild(el.grip); tools.appendChild(el.smaller); tools.appendChild(el.bigger);
    frame.appendChild(tools);

    /* WAIT n HOURS */
    el.headN = h('b', {}, '1');
    el.headUnit = h('span', {}, ' HOUR');
    el.head = h('div', { class: 'td-head' }, 'WAIT ', el.headN, el.headUnit);
    frame.appendChild(el.head);

    /* dial */
    const wrap = h('div', { class: 'td-dialwrap' });
    el.dialwrap = wrap;
    const svg = svgEl('svg', { class: 'td-svg', viewBox: '0 0 ' + SIZE + ' ' + SIZE });
    svg.appendChild(svgEl('circle', { class: 'td-disc', cx: CX, cy: CY, r: R_TRACK + 14 }));
    svg.appendChild(svgEl('circle', { class: 'td-ring', cx: CX, cy: CY, r: R_RING }));
    svg.appendChild(svgEl('circle', { class: 'td-ring2', cx: CX, cy: CY, r: R_TRACK + 14 }));
    /* 24 tick dots on the gold ring, skipping the cardinal medallion spots */
    for (let i = 0; i < 24; i++) {
      if (i % 6 === 0) continue;
      const p = ptAt(i * 15, R_RING);
      svg.appendChild(svgEl('circle', { class: 'td-tick', cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3 }));
    }
    svg.appendChild(svgEl('circle', { class: 'td-track', cx: CX, cy: CY, r: R_TRACK }));
    /* the sweep arc: a dashed circle rotated so the dash starts at "now".
       Real circumference units, NOT pathLength (SVG2, unproven in this
       renderer) — and an SVG ATTRIBUTE transform, never a CSS transform on
       an SVG child (same reason). */
    el.arc = svgEl('circle', { class: 'td-arc', cx: CX, cy: CY, r: R_TRACK, 'stroke-dasharray': '10 ' + CIRC.toFixed(1), transform: 'rotate(-90 ' + CX + ' ' + CY + ')' });
    svg.appendChild(el.arc);
    el.handleO = svgEl('circle', { class: 'td-handle-o', cx: CX, cy: CY - R_TRACK, r: 13 });
    el.handleI = svgEl('circle', { class: 'td-handle-i', cx: CX, cy: CY - R_TRACK, r: 5.5 });
    svg.appendChild(el.handleO); svg.appendChild(el.handleI);
    wrap.appendChild(svg);

    /* cardinal medallions: noon up, midnight down, dawn left, dusk right */
    const CARDS = [
      { name: 'sun', hour: 12, title: 'Wait until noon (12:00)' },
      { name: 'dusk', hour: 18, title: 'Wait until evening (18:00)' },
      { name: 'moon', hour: 24, title: 'Wait until midnight (0:00)' },
      { name: 'dawn', hour: 6, title: 'Wait until dawn (6:00)' },
    ];
    CARDS.forEach((c) => {
      const p = ptAt(degOfHour(c.hour), R_CARD);
      const b = h('button', { class: 'td-card', type: 'button', title: c.title, html: glyphSvg(c.name, 30) });
      b.style.left = p.x + 'px'; b.style.top = p.y + 'px';
      b.addEventListener('click', () => {
        mode = 'hours';
        sel = hoursUntil(c.hour % 24);
        render();
      });
      wrap.appendChild(b);
    });

    /* centre readout */
    el.glyph = h('div', { class: 'td-glyph', html: glyphSvg('sun', 46) });
    el.from = h('span', {}, '—:—');
    el.to = h('span', {}, '—:—');
    el.trans = h('div', { class: 'td-trans' }, el.from, h('span', { class: 'td-arrow' }, '▶'), el.to);
    el.date = h('div', { class: 'td-date' }, '…');
    el.note = h('div', { class: 'td-note' }, '');
    el.center = h('div', { class: 'td-center' }, el.glyph, el.trans, el.date, el.note);
    wrap.appendChild(el.center);
    frame.appendChild(wrap);

    /* footer */
    el.confirm = h('button', { class: 'td-btn td-confirm', type: 'button', title: 'Pass the time — instant, no ticking' }, '⏳ Pass the time');
    el.modeBtn = h('button', { class: 'td-btn td-mode', type: 'button', title: 'Switch the ring between hours (1–24) and days (1–7)' }, '☾ Days');
    el.closeBtn = h('button', { class: 'td-btn td-x', type: 'button', title: 'Close (Esc, or the dial’s hotkey again)' }, '✕');
    frame.appendChild(h('div', { class: 'td-foot' }, el.confirm, el.modeBtn, el.closeBtn));
    frame.appendChild(h('div', { class: 'td-hint' },
      'Drag the ring to choose · click a medallion to wait until then · Enter confirms'));

    root.appendChild(frame);
    wire();
    placeFrame();
  }

  /* ---- placement (the free-widget placeFree idiom) ----------------------- */
  function placeFrame() {
    if (!el.frame) return;
    const s = el.frame.style;
    s.left = s.right = '';
    let tx = '';
    if (cfg.anchorH === 'right') { s.right = Math.round(num(cfg.x, 0)) + 'px'; }
    else if (cfg.anchorH === 'center') { s.left = 'calc(50% + ' + Math.round(num(cfg.x, 0)) + 'px)'; tx = 'translateX(-50%) '; }
    else { s.left = Math.round(num(cfg.x, 0)) + 'px'; }
    if (cfg.anchorV === 'bottom') { s.bottom = Math.round(num(cfg.y, 0)) + 'px'; s.top = 'auto'; }
    else { s.top = Math.round(num(cfg.y, 0)) + 'px'; s.bottom = 'auto'; }
    s.transform = tx + 'scale(' + num(cfg.scale, 1) + ')';
    s.transformOrigin = (cfg.anchorV === 'bottom' ? 'bottom' : 'top') + ' ' +
      (cfg.anchorH === 'right' ? 'right' : cfg.anchorH === 'center' ? 'center' : 'left');
  }
  function moveBy(dx, dy) {
    cfg.x = num(cfg.x, 0) + (cfg.anchorH === 'right' ? -dx : dx);
    cfg.y = num(cfg.y, 0) + (cfg.anchorV === 'bottom' ? -dy : dy);
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    if (cfg.anchorH === 'center') cfg.x = clamp(cfg.x, -vw / 2 + 40, vw / 2 - 40);
    else cfg.x = clamp(cfg.x, 0, Math.max(0, vw - 80));
    cfg.y = clamp(cfg.y, 0, Math.max(0, vh - 80));
    placeFrame();
  }
  function savePlacement() {
    toGameAny(['hudWidgetSave', 'wgSave'], JSON.stringify({ widgets: { timeDial: {
      x: Math.round(num(cfg.x, 0)), y: Math.round(num(cfg.y, 0)),
      anchorH: cfg.anchorH, anchorV: cfg.anchorV,
      scale: +Number(cfg.scale || 1).toFixed(2),
    } } }));
  }

  /* ---- render ------------------------------------------------------------ */
  function render() {
    if (!el.frame) return;
    const isDays = mode === 'days';
    sel = clamp(Math.round(sel) || 1, 1, isDays ? 7 : 24);

    el.headN.textContent = String(sel);
    el.headUnit.textContent = isDays ? (sel === 1 ? ' DAY' : ' DAYS') : (sel === 1 ? ' HOUR' : ' HOURS');
    el.modeBtn.textContent = isDays ? '☀ Hours' : '☾ Days';
    el.modeBtn.classList.toggle('is-days', isDays);

    const frac = isDays ? sel / 7 : sel / 24;
    if (cur) {
      const startDeg = degOfHour(cur.hour);
      /* SVG circle stroke begins at the +x axis (3 o'clock) = our 90° mark,
         so the rotation that parks the dash start on "now" is startDeg-90. */
      el.arc.setAttribute('transform', 'rotate(' + (startDeg - 90).toFixed(2) + ' ' + CX + ' ' + CY + ')');
      el.arc.setAttribute('stroke-dasharray', (frac * CIRC).toFixed(1) + ' ' + CIRC.toFixed(1));
      /* handle rides the SAME fraction as the arc — in days mode the ring is
         "a week around the dial", so whole days must NOT collapse back onto
         the now-angle the way real clock hours would */
      const hDeg = startDeg + frac * 360;
      const p = ptAt(hDeg, R_TRACK);
      el.handleO.setAttribute('cx', p.x.toFixed(1)); el.handleO.setAttribute('cy', p.y.toFixed(1));
      el.handleI.setAttribute('cx', p.x.toFixed(1)); el.handleI.setAttribute('cy', p.y.toFixed(1));

      const land = landAfter(cur, selHours());
      el.from.textContent = fmt24(cur.hour);
      el.to.textContent = fmt24(land.hour);
      el.date.textContent = fmtDate(land);
      el.glyph.innerHTML = glyphSvg(glyphForHour(land.hour), 46);
    } else {
      el.from.textContent = '—:—'; el.to.textContent = '—:—';
      el.date.textContent = 'Reading the sky…';
    }
    el.confirm.disabled = busy || !cur;
  }

  function note(msg, ok) {
    if (!el.note) return;
    el.note.textContent = msg || '';
    el.note.classList.toggle('ok', !!ok);
    el.note.classList.add('show');
    clearTimeout(noteT);
    noteT = setTimeout(() => { if (el.note) el.note.classList.remove('show'); }, 3200);
  }

  /* ---- interaction ------------------------------------------------------- */
  let ringDrag = false;
  let moveDrag = null;   // {sx, sy}

  /* pointer (screen px) -> dial-local px, undoing the frame scale */
  function localPoint(e) {
    const r = el.dialwrap.getBoundingClientRect();
    const k = r.width > 0 ? SIZE / r.width : 1;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }
  function onRing(p) {
    const dx = p.x - CX, dy = p.y - CY;
    const d = Math.sqrt(dx * dx + dy * dy);
    return d >= R_TRACK - BAND && d <= R_RING + 24;
  }

  function wire() {
    /* Pointer AND mouse double-wire with a double-fire guard — the exact
       idiom hud.js uses: this renderer is not guaranteed to deliver pointer
       events, and a view that only listens for them plays as dead. */
    let sawPointer = 0;
    const guard = (fn) => function (e) {
      if (e.type.indexOf('pointer') === 0) sawPointer = Date.now();
      else if (Date.now() - sawPointer < 500) return;
      fn(e);
    };

    const dialDown = guard((e) => {
      if (e.target && e.target.closest && e.target.closest('.td-card')) return;
      const p = localPoint(e);
      if (!onRing(p)) return;
      ringDrag = true;
      el.dialwrap.classList.add('td-dragging');
      sel = spanFromHour(hourFromPoint(p.x, p.y));
      render();
      e.preventDefault(); e.stopPropagation();
    });
    el.dialwrap.addEventListener('pointerdown', dialDown);
    el.dialwrap.addEventListener('mousedown', dialDown);
    el.dialwrap.addEventListener('mousemove', (e) => {
      if (ringDrag) return;   // the window handler owns it during a drag
      el.dialwrap.classList.toggle('td-on-ring', onRing(localPoint(e)));
    });
    const anyMove = (e) => {
      if (ringDrag) {
        const p = localPoint(e);
        sel = spanFromHour(hourFromPoint(p.x, p.y));
        render();
        e.preventDefault();
      } else if (moveDrag) {
        moveBy(e.clientX - moveDrag.sx, e.clientY - moveDrag.sy);
        moveDrag.sx = e.clientX; moveDrag.sy = e.clientY;
        e.preventDefault();
      }
    };
    const anyUp = () => {
      if (ringDrag) { ringDrag = false; el.dialwrap.classList.remove('td-dragging'); }
      if (moveDrag) { moveDrag = null; el.frame.classList.remove('td-moving'); savePlacement(); }
    };
    window.addEventListener('pointermove', anyMove);
    window.addEventListener('mousemove', anyMove);
    window.addEventListener('pointerup', anyUp);
    window.addEventListener('mouseup', anyUp);

    const gripDown = guard((e) => {
      moveDrag = { sx: e.clientX, sy: e.clientY };
      el.frame.classList.add('td-moving');
      e.preventDefault(); e.stopPropagation();
    });
    el.grip.addEventListener('pointerdown', gripDown);
    el.grip.addEventListener('mousedown', gripDown);
    el.smaller.addEventListener('click', () => { cfg.scale = clamp(num(cfg.scale, 1) - 0.1, 0.5, 2.5); placeFrame(); savePlacement(); });
    el.bigger.addEventListener('click', () => { cfg.scale = clamp(num(cfg.scale, 1) + 0.1, 0.5, 2.5); placeFrame(); savePlacement(); });
    /* Ctrl+wheel over the dial also scales — couch-friendly */
    el.dialwrap.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      cfg.scale = clamp(num(cfg.scale, 1) + (e.deltaY < 0 ? 0.1 : -0.1), 0.5, 2.5);
      placeFrame(); savePlacement();
      e.preventDefault();
    }, { passive: false });

    el.confirm.addEventListener('click', confirm);
    el.modeBtn.addEventListener('click', () => {
      mode = mode === 'days' ? 'hours' : 'days';
      sel = mode === 'days' ? 1 : clamp(sel, 1, 24);
      render();
    });
    el.closeBtn.addEventListener('click', () => close(true));

    window.addEventListener('keydown', (e) => {
      if (!open) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
        close(true); e.preventDefault(); return;
      }
      if (e.key === 'Enter') { confirm(); e.preventDefault(); return; }
      const step = e.shiftKey ? 6 : 1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        sel = sel + step; render(); e.preventDefault();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        sel = sel - step; render(); e.preventDefault();
      }
    });
  }

  function confirm() {
    if (busy || !cur) return;
    busy = true;
    render();
    const sent = toGame('tdWait', String(selHours()));
    if (DEV && !sent) {
      /* harness: simulate the jump locally */
      const land = landAfter(cur, selHours());
      window.tdResult(JSON.stringify({ ok: true, hours: selHours() }));
      window.tdInfo(JSON.stringify(land));
    }
    /* belt for a dropped bridge — the reply un-busies us */
    setTimeout(() => { if (busy) { busy = false; render(); } }, 2500);
  }

  /* ---- open / close ------------------------------------------------------ */
  function show() {
    build();
    if (!el.frame) return;
    open = true;
    document.body.classList.add('td-open');
    /* one-shot entrance */
    el.frame.classList.remove('td-in');
    void el.frame.offsetWidth;
    el.frame.classList.add('td-in');
    sel = 1; mode = 'hours'; busy = false;
    placeFrame();
    render();
    toGame('tdGet', '');
    clearInterval(pollT);
    pollT = setInterval(() => { if (open) toGame('tdGet', ''); }, 1000);
  }
  function close(tellGame) {
    open = false;
    clearInterval(pollT); pollT = 0;
    document.body.classList.remove('td-open');
    if (tellGame) toGame('tdClose', '');
  }

  /* ---- C++ -> view ------------------------------------------------------- */
  window.tdShow = function (v) {
    try {
      if (String(v) === '1') show(); else close(false);
    } catch (e) { toGame('hudLog', 'tdShow threw: ' + (e && e.message)); }
  };
  window.tdState = function (s) {
    const j = parse(s);
    if (!j || typeof j !== 'object') return;
    for (const f of ['x', 'y', 'scale']) if (typeof j[f] === 'number' && isFinite(j[f])) cfg[f] = j[f];
    if (j.anchorH === 'left' || j.anchorH === 'center' || j.anchorH === 'right') cfg.anchorH = j.anchorH;
    if (j.anchorV === 'top' || j.anchorV === 'bottom') cfg.anchorV = j.anchorV;
    cfg.scale = clamp(num(cfg.scale, 1), 0.5, 2.5);
    placeFrame();
  };
  window.tdInfo = function (s) {
    const j = parse(s);
    if (!j || typeof j !== 'object' || typeof j.hour !== 'number') return;
    cur = j;
    render();
  };
  window.tdResult = function (s) {
    const j = parse(s);
    busy = false;
    if (!j || typeof j !== 'object') { render(); return; }
    if (j.ok) {
      sel = 1;
      note('⏩ ' + j.hours + ' hour' + (j.hours === 1 ? '' : 's') + ' passed', true);
      if (el.center) {
        el.center.classList.remove('td-jumped');
        void el.center.offsetWidth;
        el.center.classList.add('td-jumped');
        setTimeout(() => { if (el.center) el.center.classList.remove('td-jumped'); }, 900);
      }
    } else {
      note(j.msg || 'Could not wait here.', false);
    }
    render();
  };

  /* harness / dev surface */
  window.__hudTd = {
    cfg, degOfHour, hourFromPoint, spanFromHour, hoursUntil, fmt24, fmtDate,
    landAfter, glyphForHour, build, show, close, render,
    state: function () { return { open, sel, mode, busy, cur }; },
    setCur: function (c) { cur = c; },
    setMode: function (m) { mode = m; },
    setSel: function (v) { sel = v; },
    el,
  };
})();
