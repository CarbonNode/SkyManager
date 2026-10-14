'use strict';

/* ============================================================================
   Hotkey Pad — an on-screen, resizable button pad that fires your hotkeys
   (Rober, 2026-10-11: "basically its a configurable resizable calculator like
   popup - that lets you define buttons that fire that hotkey on press. you can
   resize the buttons in the UI, and the UI itself, this is useful for like
   short keyboards or when im not using my macro mouse").

   Lives in the HUD view (hud.html) as its own fixed layer #hud-pad, a sibling
   of #hud-td / #hud-stance. C++ opens it (seeded action `hotkey-pad`) and gives
   this view Focus — unpaused by default, paused when the player chose that in
   the settings window. A press is sent as the BUTTON id; C++ looks the button
   up in its own table, releases Focus so the hotkey lands in a running game,
   fires the deck entry through FireEntryById (the trigger-key verb), and takes
   Focus back a beat later — or closes the pad when the hotkey opened a menu.

   What is set HERE, by hand, on the pad itself ("Arrange"):
     · drag the title bar          — move the pad
     · drag the pad's corner       — size the whole pad (cells, icons, type)
     · drag a button's corner      — how many cells it covers (a tall "+",
                                      a wide "0")
     · drag a button               — reorder
     · × on a button               — remove it
     · − / + beside "columns"      — how wide the grid is
   Which hotkeys sit on the pad, labels, and the behaviour switches live in
   the deck's settings window (hd-padcfg.js, Home > UI Elements > Hotkey Pad):
   adding a button needs a search box, and typing into this view while the
   world runs would walk the character and open menus (keys reach BOTH this
   view and the game — the 2026-09-22 lesson in hud-align.js). So the pad's
   ＋ tile is a door to that window, not a picker of its own.

   ---------------------------------------------------------------- bridge ----
   view -> C++ (listeners on the HUD view):
     hpGet()             — push me the state (once on show)
     hpFire({id})        — a button was pressed (a PAD button id, never an
                           entry id: C++ validates it against its own table)
     hpClose()           — the view closed itself (Esc / ✕)
     hpCfg(json)         — {op:"set", x,y | scale | cols} · {op:"buttons",
                           buttons:[…]} · {op:"remove", id} · {op:"config"}
   C++ -> view:
     window.hpShow({open, edit} | false)
     window.hpState(json)  — {cols, scale, x, y, stayOpen, pause, showKeys,
                              buttons:[{id, entry, label, w, h, name, icon,
                              key, missing}], padKey, msg, limits}
     window.hpFiring(bool) — a press is landing; the pad is dimmed and deaf

   ⚠ Ultralight laws observed: every entry point is wrapped so an uncaught
   error can never take the shared renderer down; a held mouse may report
   MouseEvent.buttons === 0, so drags are tracked from mousedown to
   mouseup/blur and never cancelled from that field; sizes are real pixels
   computed from the scale (no transform: scale, which magnifies a raster and
   crushes nested text); explicit rgba(), no color-mix(); one-shot class flips,
   no looping animations.
   ============================================================================ */

(function () {
  var DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('hp bridge error', fn, e); }
      return true;
    }
    if (DEV) console.log('[hp->game]', fn, arg);
    return false;
  }
  function parse(s) {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function guard(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { console.log('hud-pad error', e && e.message); }
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  var LIM = { minCols: 1, maxCols: 8, maxSpan: 4, minScale: 0.6, maxScale: 2.5 };

  var st = {
    open: false, edit: false, firing: false,
    cols: 4, scale: 1, x: 0.62, y: 0.30, stayOpen: true, pause: false, showKeys: true,
    buttons: [], padKey: '', msg: '',
    drag: null          // the one live drag: {kind, ...}
  };
  var root = null, frame = null, grid = null, colsVal = null, editBtn = null, hint = null;

  /* ---- geometry --------------------------------------------------------
     One cell = U px. U follows the screen height so the pad reads the same
     at 1080p and 1440p, times the player's scale. Every size below derives
     from U, so dragging the pad's corner grows the cells, the icons and the
     type together — a real resize, not a magnified raster. */
  function unit(scale) {
    var h = window.innerHeight || 1080;
    var base = clamp(Math.round(h * 0.07), 60, 124);
    return Math.round(base * (scale === undefined ? st.scale : scale));
  }
  function gapOf(u) { return Math.max(6, Math.round(u * 0.11)); }
  /* the real column width: at least one cell, more when the columns stretch */
  function colWidth() {
    var u = unit(), g = gapOf(u);
    var w = grid ? grid.getBoundingClientRect().width : 0;
    return Math.max(u, (w - (st.cols - 1) * g) / Math.max(1, st.cols));
  }
  function applyVars() {
    var u = unit();
    var g = gapOf(u);
    frame.style.setProperty('--hp-u', u + 'px');
    frame.style.setProperty('--hp-g', g + 'px');
    /* no small text: floors at couch-readable sizes, whatever the scale */
    frame.style.setProperty('--hp-fl', Math.max(15, Math.round(u * 0.19)) + 'px');
    frame.style.setProperty('--hp-fk', Math.max(13, Math.round(u * 0.15)) + 'px');
    frame.style.setProperty('--hp-fs', Math.max(14, Math.round(u * 0.16)) + 'px');   // a caption under a key
    frame.style.setProperty('--hp-fh', Math.max(16, Math.round(u * 0.21)) + 'px');
    frame.style.setProperty('--hp-ic', Math.round(u * 0.4) + 'px');
    /* columns never go below one cell, and stretch to the frame when the
       title bar is the wider thing — a pad with an empty strip down its
       right side is dead space (the congruence rule) */
    grid.style.gridTemplateColumns = 'repeat(' + st.cols + ', minmax(' + u + 'px, 1fr))';
    grid.style.gridAutoRows = u + 'px';
    /* The GRID decides the pad's width, so keys stay square; the title bar
       wraps its buttons onto a second row rather than stretching every key
       wide. A floor keeps a one- or two-column pad from crushing the bar. */
    var gridW = st.cols * u + (st.cols - 1) * g;
    var fh = Math.max(16, Math.round(u * 0.21));
    var minInner = Math.round(fh * 12.5);   // room for Arrange + Buttons… side by side
    frame.style.width = (Math.max(gridW, minInner) + 2 * g + 2) + 'px';
  }
  /* x/y are the top-left corner as a fraction of the screen. Clamp so the
     whole pad stays reachable after a resolution change or a big resize. */
  function place() {
    var vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    var w = frame.offsetWidth || 300, h = frame.offsetHeight || 200;
    var left = clamp(Math.round(st.x * vw), 0, Math.max(0, vw - w));
    var top = clamp(Math.round(st.y * vh), 0, Math.max(0, vh - h));
    frame.style.left = left + 'px';
    frame.style.top = top + 'px';
  }

  /* ---- build ------------------------------------------------------------- */
  function headBtn(label, title, cls, run) {
    var b = el('button', 'hp-hb' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', guard(function (e) { e.stopPropagation(); run(); }));
    return b;
  }
  function build() {
    root = document.getElementById('hud-pad');
    if (!root) { root = el('div'); root.id = 'hud-pad'; document.body.appendChild(root); }
    root.innerHTML = '';
    frame = el('section', 'hp-frame');
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', 'Hotkey Pad');

    var head = el('header', 'hp-head');
    var grip = el('div', 'hp-grip');
    grip.title = 'Drag to move the pad';
    var gi = el('img', 'hp-grip-ic');
    gi.src = 'icons/custom/hk-hotkey-pad.png'; gi.alt = ''; gi.setAttribute('draggable', 'false');
    gi.onerror = function () { gi.remove(); };
    grip.appendChild(gi);
    grip.appendChild(el('span', 'hp-title', 'Hotkey Pad'));
    head.appendChild(grip);

    head.appendChild(headBtn('✕', 'Close the pad', 'hp-close', closeSelf));
    frame.appendChild(head);

    /* second row: the two doors share the pad's width, and the column
       stepper joins them while arranging */
    var bar = el('div', 'hp-bar');
    editBtn = headBtn('Arrange', 'Resize, reorder and remove buttons right here', 'hp-edit', function () { setEdit(!st.edit); });
    bar.appendChild(editBtn);
    bar.appendChild(headBtn('Buttons…', 'Choose which hotkeys sit on the pad — opens its settings in the deck', 'hp-cfg', openConfig));
    var cols = el('div', 'hp-cols');
    cols.appendChild(el('span', 'hp-cols-lab', 'Columns'));
    cols.appendChild(headBtn('−', 'One column fewer', 'hp-step', function () { setCols(st.cols - 1); }));
    colsVal = el('span', 'hp-cols-val', '4');
    cols.appendChild(colsVal);
    cols.appendChild(headBtn('+', 'One column more', 'hp-step', function () { setCols(st.cols + 1); }));
    bar.appendChild(cols);
    frame.appendChild(bar);

    grid = el('div', 'hp-grid');
    frame.appendChild(grid);

    hint = el('p', 'hp-hint', 'Drag a button to move it · drag its corner to make it bigger · drag the pad’s corner to size the whole pad');
    frame.appendChild(hint);

    var rs = el('div', 'hp-resize');
    rs.title = 'Drag to make the whole pad bigger or smaller';
    frame.appendChild(rs);

    root.appendChild(frame);

    grip.addEventListener('mousedown', guard(function (e) { startMove(e); }));
    rs.addEventListener('mousedown', guard(function (e) { startScale(e); }));
  }

  /* ---- render ------------------------------------------------------------ */
  function monogram(text) {
    var words = String(text || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
    var m = (words[0] ? words[0][0] : '?') + (words[1] ? words[1][0] : '');
    return m.toUpperCase();
  }
  function labelOf(b) {
    if (b.label) return b.label;
    if (b.missing) return 'Missing hotkey';
    return b.name || b.entry;
  }
  function render() {
    if (!frame) return;
    applyVars();
    frame.classList.toggle('is-edit', st.edit);
    frame.classList.toggle('is-firing', st.firing);
    colsVal.textContent = String(st.cols);
    editBtn.textContent = st.edit ? 'Done' : 'Arrange';
    editBtn.classList.toggle('on', st.edit);
    editBtn.title = st.edit ? 'Lock the layout' : 'Resize, reorder and remove buttons right here';
    grid.innerHTML = '';

    if (!st.buttons.length) {
      var empty = el('div', 'hp-empty');
      empty.style.gridColumn = '1 / span ' + st.cols;
      empty.appendChild(el('b', '', 'No buttons yet'));
      empty.appendChild(el('span', '', 'Pick the hotkeys this pad should fire.'));
      var add = el('button', 'hp-empty-add', 'Choose buttons');
      add.type = 'button';
      add.addEventListener('click', guard(openConfig));
      empty.appendChild(add);
      grid.appendChild(empty);
    }

    st.buttons.forEach(function (b, i) {
      var w = clamp(b.w || 1, 1, Math.min(LIM.maxSpan, st.cols));
      var h = clamp(b.h || 1, 1, LIM.maxSpan);
      var n = el('button', 'hp-btn');
      n.type = 'button';
      n.setAttribute('data-id', b.id);
      n.setAttribute('data-i', String(i));
      n.style.gridColumn = 'span ' + w;
      n.style.gridRow = 'span ' + h;
      if (w >= 2 && h === 1) n.classList.add('is-wide');
      if (h >= 2) n.classList.add('is-tall');
      if (b.missing) n.classList.add('is-missing');
      if (b.isKey) n.classList.add('is-keycap');
      var lab = labelOf(b);
      n.title = b.missing
        ? 'This button’s hotkey is no longer in the deck — pick a new one in Buttons…'
        : (lab + (b.key ? ' — ' + b.key : '') + (b.label && b.name && b.label !== b.name ? '\n' + b.name : ''));
      n.setAttribute('aria-label', lab);

      if (b.isKey) {
        /* a plain key (Home, PgUp, Insert …) is drawn AS a key: its chord,
           big, in the middle of the cap — the label only when you gave one */
        /* a chord stacks like a real keycap legend: "Shift +" small on top,
           the key big underneath, so "Shift + PgUp" fits a one-cell key */
        var chord = String(b.key || b.name).split(/\s*\+\s*/);
        var capKey = chord.pop();
        var cap = el('span', 'hp-cap');
        if (chord.length) cap.appendChild(el('span', 'hp-cap-mod', chord.join(' + ') + ' +'));
        cap.appendChild(el('span', 'hp-cap-key', capKey));
        n.appendChild(cap);
        if (b.label) n.appendChild(el('span', 'hp-lab', b.label));
        if (st.edit) appendEditHandles(n, b);
        n.addEventListener('mousedown', guard(function (e) { onBtnDown(e, b, n); }));
        grid.appendChild(n);
        return;
      }
      var ic = el('span', 'hp-ic');
      if (b.icon && !b.missing) {
        var im = el('img');
        im.src = b.icon; im.alt = ''; im.setAttribute('draggable', 'false');
        im.onerror = function () { im.remove(); ic.classList.add('is-mono'); ic.textContent = monogram(lab); };
        ic.appendChild(im);
      } else {
        ic.classList.add('is-mono');
        ic.textContent = b.missing ? '?' : monogram(lab);
      }
      n.appendChild(ic);
      var t = el('span', 'hp-lab', lab);
      n.appendChild(t);
      if (st.showKeys && b.key && !b.missing) {
        var kc = el('span', 'hp-key', String(b.key).replace(/\s*\+\s*/g, '+'));
        kc.title = b.key;
        n.appendChild(kc);
      }

      if (st.edit) appendEditHandles(n, b);
      n.addEventListener('mousedown', guard(function (e) { onBtnDown(e, b, n); }));
      grid.appendChild(n);
    });

    if (st.edit) {
      var add2 = el('button', 'hp-btn hp-add');
      add2.type = 'button';
      add2.title = 'Add hotkeys to the pad — opens its settings in the deck';
      add2.appendChild(el('span', 'hp-add-plus', '+'));
      add2.appendChild(el('span', 'hp-lab', 'Add'));
      add2.addEventListener('click', guard(openConfig));
      grid.appendChild(add2);
    }
    fitLabels();
    place();
  }

  function appendEditHandles(n, b) {
    var x = el('span', 'hp-x', '✕');
    x.title = 'Remove this button';
    x.addEventListener('mousedown', guard(function (e) { e.stopPropagation(); e.preventDefault(); }));
    x.addEventListener('click', guard(function (e) { e.stopPropagation(); removeButton(b.id); }));
    n.appendChild(x);
    var rz = el('span', 'hp-rs');
    rz.title = 'Drag to change how many cells this button covers';
    rz.addEventListener('mousedown', guard(function (e) { startSpan(e, b.id, n); }));
    n.appendChild(rz);
  }

  /* A label with a word wider than its key steps down one size, then two
     (never under 13px), BEFORE anything breaks a word; the line clamp
     ellipsises whatever still overflows. Reads layout, once per render. */
  function fitLabels() {
    var labs = grid.querySelectorAll('.hp-btn[data-id] .hp-lab, .hp-btn[data-id] .hp-cap-key, .hp-btn[data-id] .hp-cap-mod');
    for (var i = 0; i < labs.length; i++) {
      var l = labs[i];
      for (var step = 1; step <= 2; step++) {
        /* only a WORD wider than the key shrinks the type; a label that is
           merely long wraps to two lines and the clamp ellipsises the rest */
        if (l.scrollWidth <= l.clientWidth + 1) break;
        l.classList.remove('fit-1', 'fit-2');
        l.classList.add('fit-' + step);
      }
    }
  }

  /* ---- actions ----------------------------------------------------------- */
  function send(obj) { toGame('hpCfg', JSON.stringify(obj)); }
  function sendButtons() {
    send({ op: 'buttons', buttons: st.buttons.map(function (b) {
      var o = { id: b.id, entry: b.entry, label: b.label || '', w: b.w || 1, h: b.h || 1 };
      if (b.press) o.press = b.press;   // a key button keeps its key through every save
      return o;
    }) });
  }
  function setCols(n) {
    n = clamp(n, LIM.minCols, LIM.maxCols);
    if (n === st.cols) return;
    st.cols = n;
    st.buttons.forEach(function (b) { b.w = clamp(b.w || 1, 1, Math.min(LIM.maxSpan, n)); });
    render();                       /* optimistic; hpState confirms */
    send({ op: 'set', cols: n });
  }
  function removeButton(id) {
    st.buttons = st.buttons.filter(function (b) { return b.id !== id; });
    render();
    send({ op: 'remove', id: id });
  }
  function setEdit(on) {
    st.edit = !!on;
    render();
  }
  function openConfig() { send({ op: 'config' }); }
  function closeSelf() {
    if (!st.open) return;
    hide();
    toGame('hpClose', '');
  }
  function press(b, n) {
    if (st.firing || st.edit) return;
    n.classList.remove('is-fired');
    void n.offsetWidth;
    n.classList.add('is-fired');
    toGame('hpFire', JSON.stringify({ id: b.id }));
  }

  /* ---- drags --------------------------------------------------------------
     One drag at a time, tracked on window from mousedown to mouseup / blur.
     Never cancelled from MouseEvent.buttons (Ultralight reports 0 while held). */
  function startMove(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    st.drag = { kind: 'move', sx: e.clientX, sy: e.clientY, l: frame.offsetLeft, t: frame.offsetTop };
    frame.classList.add('is-dragging');
  }
  function startScale(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    st.drag = { kind: 'scale', sx: e.clientX, sy: e.clientY, w: frame.offsetWidth, h: frame.offsetHeight, s: st.scale };
    frame.classList.add('is-dragging');
  }
  function startSpan(e, id, n) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var b = findBtn(id);
    if (!b) return;
    st.drag = { kind: 'span', id: id, sx: e.clientX, sy: e.clientY, w: b.w || 1, h: b.h || 1,
                pw: n.offsetWidth, ph: n.offsetHeight, cw: colWidth(), changed: false };
    frame.classList.add('is-dragging');
  }
  function onBtnDown(e, b, n) {
    if (e.button !== 0) return;
    if (!st.edit) {
      /* a press fires on mouseup over the SAME button, like a real key cap:
         sliding off cancels — the only safety net a mis-click has */
      st.drag = { kind: 'press', id: b.id, node: n };
      n.classList.add('is-down');
      return;
    }
    e.preventDefault();
    st.drag = { kind: 'reorder', id: b.id, node: n, sx: e.clientX, sy: e.clientY, live: false, target: null, after: false };
  }
  function findBtn(id) {
    for (var i = 0; i < st.buttons.length; i++) if (st.buttons[i].id === id) return st.buttons[i];
    return null;
  }
  function btnAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    while (hit && hit !== grid) {
      if (hit.classList && hit.classList.contains('hp-btn') && hit.getAttribute('data-id')) return hit;
      hit = hit.parentNode;
    }
    return null;
  }
  function clearDrop() {
    var olds = grid.querySelectorAll('.is-drop-before, .is-drop-after');
    for (var i = 0; i < olds.length; i++) olds[i].classList.remove('is-drop-before', 'is-drop-after');
  }
  var onMove = guard(function (e) {
    var d = st.drag;
    if (!d) return;
    if (d.kind === 'move') {
      var vw = window.innerWidth, vh = window.innerHeight;
      var l = clamp(d.l + e.clientX - d.sx, 0, Math.max(0, vw - frame.offsetWidth));
      var t = clamp(d.t + e.clientY - d.sy, 0, Math.max(0, vh - frame.offsetHeight));
      frame.style.left = l + 'px';
      frame.style.top = t + 'px';
    } else if (d.kind === 'scale') {
      /* whichever way the corner travels further decides, so a diagonal drag
         and a sideways one both feel like the pad follows the hand */
      var fx = (d.w + e.clientX - d.sx) / Math.max(1, d.w);
      var fy = (d.h + e.clientY - d.sy) / Math.max(1, d.h);
      var f = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
      var s = clamp(Math.round(d.s * f * 100) / 100, LIM.minScale, LIM.maxScale);
      if (s !== st.scale) { st.scale = s; applyVars(); place(); }
    } else if (d.kind === 'span') {
      var u = unit(), g = gapOf(u), cw = d.cw || colWidth();
      var w = clamp(Math.round((d.pw + e.clientX - d.sx + g) / (cw + g)), 1, Math.min(LIM.maxSpan, st.cols));
      var h = clamp(Math.round((d.ph + e.clientY - d.sy + g) / (u + g)), 1, LIM.maxSpan);
      var b = findBtn(d.id);
      if (b && (b.w !== w || b.h !== h)) { b.w = w; b.h = h; d.changed = true; render(); }
    } else if (d.kind === 'press') {
      var over = btnAt(e.clientX, e.clientY);
      d.node.classList.toggle('is-down', !!over && over.getAttribute('data-id') === d.id);
    } else if (d.kind === 'reorder') {
      if (!d.live && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 8) return;
      d.live = true;
      d.node.classList.add('is-lifted');
      clearDrop();
      var tgt = btnAt(e.clientX, e.clientY);
      if (tgt && tgt.getAttribute('data-id') !== d.id) {
        var r = tgt.getBoundingClientRect();
        d.after = e.clientX > r.left + r.width / 2;
        d.target = tgt.getAttribute('data-id');
        tgt.classList.add(d.after ? 'is-drop-after' : 'is-drop-before');
      } else {
        d.target = null;
      }
    }
  });
  var onUp = guard(function (e) {
    var d = st.drag;
    if (!d) return;
    st.drag = null;
    frame.classList.remove('is-dragging');
    if (d.kind === 'move') {
      var vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
      st.x = Math.round(frame.offsetLeft / vw * 1000) / 1000;
      st.y = Math.round(frame.offsetTop / vh * 1000) / 1000;
      send({ op: 'set', x: st.x, y: st.y });
    } else if (d.kind === 'scale') {
      if (st.scale !== d.s) {
        /* keep the top-left where it is after the size change */
        st.x = Math.round(frame.offsetLeft / (window.innerWidth || 1920) * 1000) / 1000;
        st.y = Math.round(frame.offsetTop / (window.innerHeight || 1080) * 1000) / 1000;
        send({ op: 'set', scale: st.scale, x: st.x, y: st.y });
      }
    } else if (d.kind === 'span') {
      if (d.changed) sendButtons();
    } else if (d.kind === 'press') {
      d.node.classList.remove('is-down');
      var over = e && typeof e.clientX === 'number' ? btnAt(e.clientX, e.clientY) : null;
      if (over && over.getAttribute('data-id') === d.id) {
        var b = findBtn(d.id);
        if (b) press(b, d.node);
      }
    } else if (d.kind === 'reorder') {
      d.node.classList.remove('is-lifted');
      clearDrop();
      if (d.live && d.target) {
        var from = -1, moving = null;
        for (var i = 0; i < st.buttons.length; i++) if (st.buttons[i].id === d.id) { from = i; moving = st.buttons[i]; }
        if (moving) {
          st.buttons.splice(from, 1);
          var to = -1;
          for (var k = 0; k < st.buttons.length; k++) if (st.buttons[k].id === d.target) to = k;
          if (to < 0) st.buttons.push(moving);
          else st.buttons.splice(d.after ? to + 1 : to, 0, moving);
          render();
          sendButtons();
        }
      }
    }
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('blur', guard(function () { if (st.drag) onUp({}); }));

  /* Keys reach the game too, so the pad answers only Escape (and Enter on a
     focused button, the browser's own). Escape leaves Arrange first, then
     closes. */
  window.addEventListener('keydown', guard(function (e) {
    if (!st.open) return;
    if (e.key === 'Escape') {
      if (st.drag) { st.drag = null; frame.classList.remove('is-dragging'); render(); return; }
      if (st.edit) { setEdit(false); return; }
      closeSelf();
    }
  }));
  /* a right-click anywhere on the pad closes it — the other HUD layers' idiom */
  document.addEventListener('contextmenu', guard(function (e) {
    if (!st.open || !frame || !frame.contains(e.target)) return;
    e.preventDefault();
    if (st.edit) setEdit(false); else closeSelf();
  }));

  /* ---- C++ -> view ------------------------------------------------------- */
  function show(edit) {
    if (!frame) build();
    st.open = true;
    st.edit = !!edit;
    st.firing = false;
    document.body.classList.add('hp-open');
    render();
    frame.classList.remove('hp-in');
    void frame.offsetWidth;
    frame.classList.add('hp-in');
    toGame('hpGet', '');
  }
  function hide() {
    st.open = false;
    st.edit = false;
    st.drag = null;
    document.body.classList.remove('hp-open');
    if (frame) frame.classList.remove('hp-in', 'is-firing');
  }
  window.hpShow = guard(function (arg) {
    var a = parse(arg);
    if (a === false || a === 'false' || a === '0' || a === 0 || (a && a.open === false)) { hide(); return; }
    show(!!(a && a.edit));
  });
  window.hpState = guard(function (arg) {
    var s = parse(arg);
    if (!s || typeof s !== 'object') return;
    if (s.limits && typeof s.limits === 'object') {
      LIM.minCols = num(s.limits.minCols, LIM.minCols); LIM.maxCols = num(s.limits.maxCols, LIM.maxCols);
      LIM.maxSpan = num(s.limits.maxSpan, LIM.maxSpan);
      LIM.minScale = num(s.limits.minScale, LIM.minScale); LIM.maxScale = num(s.limits.maxScale, LIM.maxScale);
    }
    /* a drag in flight owns its own numbers; the echo of an earlier save must
       not yank the pad or a button back under the cursor */
    if (st.drag && st.drag.kind !== 'press') return;
    st.cols = clamp(Math.round(num(s.cols, st.cols)), LIM.minCols, LIM.maxCols);
    st.scale = clamp(num(s.scale, st.scale), LIM.minScale, LIM.maxScale);
    st.x = clamp(num(s.x, st.x), 0, 0.98);
    st.y = clamp(num(s.y, st.y), 0, 0.98);
    st.stayOpen = s.stayOpen !== false;
    st.pause = s.pause === true;
    st.showKeys = s.showKeys !== false;
    st.padKey = typeof s.padKey === 'string' ? s.padKey : '';
    st.msg = typeof s.msg === 'string' ? s.msg : '';
    st.buttons = Array.isArray(s.buttons) ? s.buttons.filter(function (b) {
      return b && typeof b.id === 'string' && typeof b.entry === 'string';
    }).map(function (b) {
      var press = (b.press && typeof b.press === 'object' && typeof b.press.dik === 'number')
        ? { dik: b.press.dik, mods: Array.isArray(b.press.mods) ? b.press.mods.slice() : [], name: String(b.press.name || '') } : null;
      return { id: b.id, entry: b.entry, label: typeof b.label === 'string' ? b.label : '',
               press: press, isKey: !!press,
               w: Math.round(num(b.w, 1)), h: Math.round(num(b.h, 1)),
               name: typeof b.name === 'string' ? b.name : '', icon: typeof b.icon === 'string' ? b.icon : '',
               key: typeof b.key === 'string' ? b.key : '', missing: b.missing === true };
    }) : [];
    if (st.open) render();
  });
  window.hpFiring = guard(function (arg) {
    var on = parse(arg);
    st.firing = on === true || on === 'true' || on === 1 || on === '1';
    if (frame) frame.classList.toggle('is-firing', st.firing);
  });
  window.addEventListener('resize', guard(function () { if (st.open) { applyVars(); place(); } }));

  /* harness hook (hud-pad.test.html); inert in game */
  window.HudPad = { state: function () { return st; }, render: guard(render), unit: unit, colWidth: colWidth };
})();
