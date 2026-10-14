'use strict';

/* ============================================================================
   Hotkey Pad — the settings window (deck view). Opened from Home > UI
   Elements > Hotkey Pad (Config →), from the pad's own "Buttons…" / ＋ tile
   (C++ reopens the deck and calls hpCfgOpen), and from the Omni through the
   UI Elements provider. The pad itself is hud-pad.js on the HUD view.

   Rober, 2026-10-11: "new ui element, must be shown in ui elements - and
   configurable there. basically its a configurable resizable calculator like
   popup - that lets you define buttons that fire that hotkey on press. you can
   resize the buttons in the UI, and the UI itself".

   A body-anchored popout, never an inline expander (the 2026-09-21 law): it
   holds a growing list of buttons and a picker over every deck hotkey, which
   is the "detail that grows" rung. It owns the keyboard while up — a window
   CAPTURE listener, the get-away.js idiom, so deck shortcuts and the type-to-
   search funnel behind it never see the keys typed here.

   Three columns:
     The pad    — a live preview drawn with the pad's own grid rules, and the
                  layout/behaviour switches (columns, size, after a press,
                  pause, key hints, reset).
     On the pad — every button: its own label, its shape (cells across × down),
                  move up/down, remove. Filterable.
     Add        — every deck entry (hotkeys, actions, console rows) from the
                  catalog C++ sends; filter as you type, Enter adds the top hit.

   Bridge: request hpCfg {op:"get", catalog:true} · {op:"set", …} ·
           {op:"buttons", buttons} · {op:"add", entry} · {op:"remove", id} ·
           {op:"reset-layout"} · {op:"open", edit}
           reply hpCfgState(json) (C++ HpStateJson) · hpCfgOpen() opens this.
   ============================================================================ */

window.HDPadCfg = (function () {
  var SIZES = [
    { v: 0.8, name: 'Small' }, { v: 1, name: 'Medium' }, { v: 1.25, name: 'Large' }, { v: 1.6, name: 'Huge' }
  ];
  var SHAPES = [
    { w: 1, h: 1, name: '1 × 1', hint: 'One cell' },
    { w: 2, h: 1, name: '2 × 1', hint: 'Two cells wide' },
    { w: 1, h: 2, name: '1 × 2', hint: 'Two cells tall' },
    { w: 2, h: 2, name: '2 × 2', hint: 'Two by two' }
  ];
  var RESULT_CAP = 80;

  var s = { cols: 4, scale: 1, stayOpen: true, pause: false, showKeys: true, buttons: [], padKey: '',
            msg: '', catalog: null, limits: { minCols: 1, maxCols: 8, maxSpan: 4, maxButtons: 60 } };
  var ui = { modal: null, qButtons: '', qAdd: '', focusBefore: null, flashT: 0, keyMods: [] };
  var MODS = [{ dik: 42, name: 'Shift' }, { dik: 29, name: 'Ctrl' }, { dik: 56, name: 'Alt' }];
  /* what the Keys strip offers before anything is typed: the keys a short
     keyboard is missing (Rober: "plain keys like home, page up, insert") */
  var QUICK_KEYS = ['Insert', 'Home', 'PgUp', 'Delete', 'End', 'PgDn', 'Up', 'Down', 'Left', 'Right', 'PrtScr', 'Pause'];
  var KEY_CAP = 16;
  var $c = {};

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} return true; }
    return false;
  }
  function send(obj) { toGame('hpCfg', JSON.stringify(obj)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function btn(label, title, run, cls) {
    var b = el('button', 'hpc-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); try { run(); } catch (x) {} });
    return b;
  }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function words(t) { return String(t || '').toLowerCase().replace(/[-_·/'’()]+/g, ' ').trim(); }
  function icon(src, fallbackText, cls, missing) {
    var w = el('span', 'hpc-ic' + (cls ? ' ' + cls : ''));
    if (missing) { w.classList.add('is-mono', 'is-missing'); w.textContent = '?'; return w; }
    if (src) {
      var im = el('img');
      im.src = src; im.alt = ''; im.setAttribute('draggable', 'false');
      im.onerror = function () { im.remove(); w.classList.add('is-mono'); w.textContent = mono(fallbackText); };
      w.appendChild(im);
    } else {
      w.classList.add('is-mono');
      w.textContent = mono(fallbackText);
    }
    return w;
  }
  function mono(text) {
    var ws = String(text || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
    return ((ws[0] ? ws[0][0] : '?') + (ws[1] ? ws[1][0] : '')).toUpperCase();
  }
  function labelOf(b) { return b.label || (b.isKey ? (b.key || b.name) : (b.missing ? 'Missing hotkey' : (b.name || b.entry))); }

  /* ---- plain keys --------------------------------------------------------
     The pad presses exactly the keys the Numpad tab already fires (app.js
     NUMPAD_LAYOUT, exported as window.hdKeypadKeys), found with the Key
     strip's own matcher and aliases (KeyStrip.match: "page up", "ins",
     "del", "tilde" …). Nothing here invents a scancode. */
  function deckKeys() { return Array.isArray(window.hdKeypadKeys) ? window.hdKeypadKeys.filter(function (k) { return k && k.c; }) : []; }
  function capName(k) {
    var n = String(k.name || k.l || '');
    return (n === 'Up' || n === 'Down' || n === 'Left' || n === 'Right') ? (k.l || n) : n;
  }
  function keyMatches(q) {
    var t = words(q).replace(/\s+/g, '');
    if (!t) {
      var all = deckKeys();
      return QUICK_KEYS.map(function (n) { return all.filter(function (k) { return k.name === n; })[0]; }).filter(Boolean);
    }
    if (window.KeyStrip && typeof KeyStrip.match === 'function') {
      try { return (KeyStrip.match(q) || []).map(function (c) { return c && c.k ? c.k : c; }).filter(function (k) { return k && k.c; }); } catch (e) {}
    }
    return deckKeys().filter(function (k) { return words(k.name + ' ' + k.l).replace(/\s+/g, '').indexOf(t) !== -1; });
  }
  function chordText(k) {
    var parts = MODS.filter(function (m) { return ui.keyMods.indexOf(m.dik) !== -1; }).map(function (m) { return m.name; });
    parts.push(capName(k));
    return parts.join(' + ');
  }
  function addKey(k) {
    if (!k) return;
    if (s.buttons.length >= s.limits.maxButtons) { flash('The pad is full (' + s.limits.maxButtons + ' buttons).'); return; }
    send({ op: 'add', press: { dik: k.c, mods: ui.keyMods.slice(), name: capName(k) } });
    flash('Added the ' + chordText(k) + ' key.');
  }
  function seg(label, title, on, run) {
    var b = btn(label, title, run, 'hpc-seg' + (on ? ' on' : ''));
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    return b;
  }
  function group(title, sub) {
    var g = el('div', 'hpc-group');
    g.appendChild(el('div', 'hpc-group-t', title));
    if (sub) g.appendChild(el('div', 'hpc-group-s', sub));
    var row = el('div', 'hpc-segs');
    g.appendChild(row);
    g.row = row;
    return g;
  }

  /* ---- state ------------------------------------------------------------- */
  function receive(env) {
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || typeof env !== 'object') return;
    if (env.limits && typeof env.limits === 'object') {
      s.limits.minCols = num(env.limits.minCols, 1); s.limits.maxCols = num(env.limits.maxCols, 8);
      s.limits.maxSpan = num(env.limits.maxSpan, 4); s.limits.maxButtons = num(env.limits.maxButtons, 60);
    }
    s.cols = clamp(Math.round(num(env.cols, s.cols)), s.limits.minCols, s.limits.maxCols);
    s.scale = num(env.scale, s.scale);
    s.stayOpen = env.stayOpen !== false;
    s.pause = env.pause === true;
    s.showKeys = env.showKeys !== false;
    s.padKey = typeof env.padKey === 'string' ? env.padKey : '';
    s.msg = typeof env.msg === 'string' ? env.msg : '';
    if (Array.isArray(env.buttons)) {
      s.buttons = env.buttons.filter(function (b) { return b && typeof b.id === 'string' && typeof b.entry === 'string'; })
        .map(function (b) {
          var press = (b.press && typeof b.press === 'object' && typeof b.press.dik === 'number')
            ? { dik: b.press.dik, mods: Array.isArray(b.press.mods) ? b.press.mods.slice() : [], name: String(b.press.name || '') } : null;
          return { id: b.id, entry: b.entry, label: typeof b.label === 'string' ? b.label : '',
                   press: press, isKey: !!press,
                   w: Math.round(num(b.w, 1)), h: Math.round(num(b.h, 1)),
                   name: typeof b.name === 'string' ? b.name : '', icon: typeof b.icon === 'string' ? b.icon : '',
                   key: typeof b.key === 'string' ? b.key : '', missing: b.missing === true };
        });
    }
    if (Array.isArray(env.catalog)) {
      s.catalog = env.catalog.filter(function (c) { return c && typeof c.id === 'string'; }).map(function (c) {
        var o = { id: c.id, name: String(c.name || c.id), icon: typeof c.icon === 'string' ? c.icon : '',
                  key: typeof c.key === 'string' ? c.key : '', cat: typeof c.cat === 'string' ? c.cat : '',
                  dev: typeof c.dev === 'string' ? c.dev : '', desc: typeof c.desc === 'string' ? c.desc : '' };
        o.hay = words(o.name + ' ' + o.key + ' ' + o.cat + ' ' + o.desc);
        o.nameHay = words(o.name);
        return o;
      });
    }
    if (window.HomePane && typeof HomePane.padState === 'function') {
      try { HomePane.padState({ key: s.padKey, count: s.buttons.length }); } catch (e) {}
    }
    if (ui.modal) render();
  }

  /* ---- edits -------------------------------------------------------------
     Optimistic: the local list changes and repaints at once; hpCfgState is
     the truth and lands a moment later with the same shape. */
  function sendButtons() {
    send({ op: 'buttons', buttons: s.buttons.map(function (b) {
      var o = { id: b.id, entry: b.entry, label: b.label || '', w: b.w || 1, h: b.h || 1 };
      if (b.press) o.press = b.press;   // a key button keeps its key through every save
      return o;
    }) });
  }
  function setOpt(patch) {
    for (var k in patch) s[k] = patch[k];
    render();
    send(Object.assign({ op: 'set' }, patch));
  }
  function addEntry(c) {
    if (!c) return;
    if (s.buttons.length >= s.limits.maxButtons) { flash('The pad is full (' + s.limits.maxButtons + ' buttons).'); return; }
    send({ op: 'add', entry: c.id });
    flash('Added “' + c.name + '”.');
  }
  function moveBtn(i, d) {
    var j = i + d;
    if (j < 0 || j >= s.buttons.length) return;
    var t = s.buttons[i]; s.buttons[i] = s.buttons[j]; s.buttons[j] = t;
    render();
    sendButtons();
  }
  function removeBtn(i) {
    var b = s.buttons[i];
    if (!b) return;
    s.buttons.splice(i, 1);
    render();
    send({ op: 'remove', id: b.id });
  }
  function flash(text) {
    if (!$c.status) return;
    $c.status.textContent = text;
    clearTimeout(ui.flashT);
    ui.flashT = setTimeout(function () { if ($c.status) $c.status.textContent = ''; }, 4000);
  }

  /* ---- build -------------------------------------------------------------- */
  function build() {
    var back = el('div', 'hpc-back');
    back.id = 'hp-cfg';
    var card = el('section', 'hpc-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'hpc-title');

    var head = el('header', 'hpc-head');
    var hl = el('div', 'hpc-heading');
    hl.appendChild(icon('icons/custom/hk-hotkey-pad.png', 'Hotkey Pad', 'hpc-head-ic'));
    var ht = el('div', 'hpc-heading-t');
    var h2 = el('h2', '', 'Hotkey Pad');
    h2.id = 'hpc-title';
    ht.appendChild(h2);
    $c.how = el('p', 'hpc-how');
    ht.appendChild($c.how);
    hl.appendChild(ht);
    head.appendChild(hl);
    var ha = el('div', 'hpc-head-acts');
    ha.appendChild(btn('Open the pad', 'Close the deck and show the pad', function () { send({ op: 'open', edit: false }); close(); }));
    ha.appendChild(btn('Arrange on screen', 'Close the deck and open the pad ready to move, resize and reorder', function () { send({ op: 'open', edit: true }); close(); }));
    ha.appendChild(btn('Close', 'Close this window (Esc)', close, 'hpc-close'));
    head.appendChild(ha);
    card.appendChild(head);

    var body = el('div', 'hpc-body');

    /* --- column 1: the pad --- */
    var c1 = el('section', 'hpc-col hpc-col-pad');
    c1.appendChild(el('h3', 'hpc-col-t', 'The pad'));
    $c.preview = el('div', 'hpc-preview');
    c1.appendChild($c.preview);
    $c.settings = el('div', 'hpc-settings');
    c1.appendChild($c.settings);
    body.appendChild(c1);

    /* --- column 2: on the pad --- */
    var c2 = el('section', 'hpc-col hpc-col-btns');
    var c2h = el('div', 'hpc-col-head');
    $c.btnsTitle = el('h3', 'hpc-col-t', 'On the pad');
    c2h.appendChild($c.btnsTitle);
    c2.appendChild(c2h);
    $c.qButtons = searchBox('Filter the pad’s buttons…', 'Filter the buttons on the pad', function (v) { ui.qButtons = v; renderButtons(); });
    c2.appendChild($c.qButtons.wrap);
    $c.btnList = el('div', 'hpc-list hpc-btnlist');
    c2.appendChild($c.btnList);
    body.appendChild(c2);

    /* --- column 3: add --- */
    var c3 = el('section', 'hpc-col hpc-col-add');
    c3.appendChild(el('h3', 'hpc-col-t', 'Add a hotkey or a key'));
    $c.qAdd = searchBox('Search hotkeys, actions or keys…', 'Search hotkeys, deck actions or keys to add', function (v) { ui.qAdd = v; renderAdd(); });
    c3.appendChild($c.qAdd.wrap);
    $c.addHint = el('p', 'hpc-hint');
    c3.appendChild($c.addHint);
    $c.keys = el('div', 'hpc-keys');
    c3.appendChild($c.keys);
    $c.addList = el('div', 'hpc-list hpc-addlist');
    c3.appendChild($c.addList);
    body.appendChild(c3);

    card.appendChild(body);
    $c.status = el('p', 'hpc-status');
    $c.status.setAttribute('role', 'status');
    $c.status.setAttribute('aria-live', 'polite');
    card.appendChild($c.status);

    back.appendChild(card);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    return back;
  }
  function searchBox(placeholder, aria, onInput) {
    var wrap = el('div', 'hpc-search');
    var input = el('input', 'hpc-search-in');
    input.type = 'search'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', aria);
    var clear = btn('Clear', 'Clear the search', function () { input.value = ''; onInput(''); input.focus(); }, 'hpc-search-clear');
    input.addEventListener('input', function () { clear.disabled = !input.value; onInput(input.value); });
    clear.disabled = true;
    wrap.appendChild(input);
    wrap.appendChild(clear);
    return { wrap: wrap, input: input, clear: clear };
  }

  /* ---- render ------------------------------------------------------------- */
  function render() {
    if (!ui.modal) return;
    $c.how.textContent = s.padKey
      ? ('Opens during play on ' + s.padKey + '. Click a button and its hotkey fires.')
      : 'No key yet — give “Hotkey Pad” a trigger key in Hotkeys (Misc), or open it from here.';
    if (s.msg) flash(s.msg);
    renderPreview();
    renderSettings();
    renderButtons();
    renderAdd();
  }

  /* The preview uses the pad's own rules (cols, w × h spans, dense flow) so
     what you arrange here is what appears on screen — at a cell size that fits
     the column, not the pad's real size. */
  function renderPreview() {
    var p = $c.preview;
    p.innerHTML = '';
    var avail = Math.max(240, (p.clientWidth || 420) - 32);
    var gapR = 0.11;
    var cell = Math.floor(avail / (s.cols + (s.cols - 1) * gapR));
    cell = clamp(cell, 34, 96);
    var gap = Math.max(4, Math.round(cell * gapR));
    var g = el('div', 'hpc-pv-grid');
    g.style.gridTemplateColumns = 'repeat(' + s.cols + ', ' + cell + 'px)';
    g.style.gridAutoRows = cell + 'px';
    g.style.gap = gap + 'px';
    g.style.setProperty('--pv-u', cell + 'px');
    if (!s.buttons.length) {
      var e = el('div', 'hpc-pv-empty', 'Add a hotkey from the right and it appears here.');
      e.style.gridColumn = '1 / span ' + s.cols;
      g.appendChild(e);
    }
    s.buttons.forEach(function (b) {
      var w = clamp(b.w || 1, 1, Math.min(s.limits.maxSpan, s.cols));
      var h = clamp(b.h || 1, 1, s.limits.maxSpan);
      var c = el('div', 'hpc-pv-btn' + (b.missing ? ' is-missing' : '') + (w >= 2 && h === 1 ? ' is-wide' : ''));
      c.style.gridColumn = 'span ' + w;
      c.style.gridRow = 'span ' + h;
      c.title = labelOf(b);
      if (b.isKey) {
        c.classList.add('is-keycap');
        c.appendChild(el('span', 'hpc-pv-cap', b.key || b.name));
      } else {
        c.appendChild(icon(b.icon, labelOf(b), 'hpc-pv-ic', b.missing));
        if (cell >= 52 || w >= 2) c.appendChild(el('span', 'hpc-pv-lab', labelOf(b)));
      }
      g.appendChild(c);
    });
    p.appendChild(g);
    var cap = el('p', 'hpc-pv-cap', s.buttons.length + (s.buttons.length === 1 ? ' button' : ' buttons') + ' · ' +
      s.cols + (s.cols === 1 ? ' column' : ' columns') + ' · ' + Math.round(s.scale * 100) + '% size');
    p.appendChild(cap);
  }

  function renderSettings() {
    var w = $c.settings;
    w.innerHTML = '';

    var cg = group('Columns', 'How many cells across. Drag a button’s corner on the pad to make it span more.');
    var minus = btn('−', 'One column fewer', function () { setOpt({ cols: clamp(s.cols - 1, s.limits.minCols, s.limits.maxCols) }); }, 'hpc-step');
    minus.disabled = s.cols <= s.limits.minCols;
    cg.row.appendChild(minus);
    cg.row.appendChild(el('span', 'hpc-val', String(s.cols)));
    var plus = btn('+', 'One column more', function () { setOpt({ cols: clamp(s.cols + 1, s.limits.minCols, s.limits.maxCols) }); }, 'hpc-step');
    plus.disabled = s.cols >= s.limits.maxCols;
    cg.row.appendChild(plus);
    w.appendChild(cg);

    var sg = group('Size', 'Cells, icons and labels together. Drag the pad’s corner on screen for any size in between.');
    var near = 0, d = Infinity;
    SIZES.forEach(function (o, i) { var di = Math.abs(o.v - s.scale); if (di < d) { d = di; near = i; } });
    var exact = d < 0.03;
    SIZES.forEach(function (o, i) {
      sg.row.appendChild(seg(o.name, o.name + ' — ' + Math.round(o.v * 100) + '%', exact && i === near, function () { setOpt({ scale: o.v }); }));
    });
    if (!exact) sg.row.appendChild(el('span', 'hpc-val hpc-val-note', Math.round(s.scale * 100) + '% (dragged)'));
    w.appendChild(sg);

    var pg = group('After a press', 'Staying open lets you tap several in a row. If a hotkey opens a menu, the pad steps aside either way.');
    pg.row.appendChild(seg('Stay open', 'Keep the pad up after a press', s.stayOpen, function () { setOpt({ stayOpen: true }); }));
    pg.row.appendChild(seg('Close the pad', 'Close the pad after each press', !s.stayOpen, function () { setOpt({ stayOpen: false }); }));
    w.appendChild(pg);

    var wg = group('While the pad is up');
    wg.row.appendChild(seg('Game keeps running', 'The world carries on — like a real keyboard', !s.pause, function () { setOpt({ pause: false }); }));
    wg.row.appendChild(seg('Pause the game', 'Freeze the world while you choose', s.pause, function () { setOpt({ pause: true }); }));
    w.appendChild(wg);

    var kg = group('Key hints', 'The key each button answers to, in its corner.');
    kg.row.appendChild(seg('Show', 'Show key hints on the buttons', s.showKeys, function () { setOpt({ showKeys: true }); }));
    kg.row.appendChild(seg('Hide', 'Hide key hints', !s.showKeys, function () { setOpt({ showKeys: false }); }));
    w.appendChild(kg);

    var rg = el('div', 'hpc-reset');
    rg.appendChild(btn('Reset layout', 'Columns, size, position and switches back to the defaults — your buttons stay', function () {
      send({ op: 'reset-layout' });
      flash('Layout reset. Your buttons are unchanged.');
    }, 'hpc-quiet'));
    w.appendChild(rg);
  }

  function shapeName(b) {
    for (var i = 0; i < SHAPES.length; i++) if (SHAPES[i].w === b.w && SHAPES[i].h === b.h) return null;
    return b.w + ' × ' + b.h;
  }
  function renderButtons() {
    var list = $c.btnList;
    list.innerHTML = '';
    $c.btnsTitle.textContent = 'On the pad · ' + s.buttons.length;
    var terms = words(ui.qButtons).split(/\s+/).filter(Boolean);
    var shown = 0;
    s.buttons.forEach(function (b, i) {
      var hay = words(labelOf(b) + ' ' + b.name + ' ' + b.key);
      if (!terms.every(function (t) { return hay.indexOf(t) !== -1; })) return;
      shown++;
      var row = el('div', 'hpc-brow' + (b.missing ? ' is-missing' : ''));
      if (b.isKey) row.appendChild(el('span', 'hpc-ic hpc-keyic', b.key || b.name));
      else row.appendChild(icon(b.icon, labelOf(b), '', b.missing));
      var mid = el('div', 'hpc-brow-mid');
      var inp = el('input', 'hpc-label-in');
      inp.type = 'text';
      inp.maxLength = 40;
      inp.value = b.label || '';
      inp.placeholder = b.isKey ? 'Optional caption under the key' : (b.missing ? 'Missing hotkey' : (b.name || b.entry));
      inp.setAttribute('aria-label', 'Label for ' + (b.isKey ? (b.key || b.name) + ' key' : (b.name || b.entry)));
      inp.title = b.isKey ? 'Shown under the key. Leave empty to show just the key.'
                          : 'The text on the button. Leave empty to use the hotkey’s own name.';
      var commit = function () {
        var v = inp.value.replace(/\s+/g, ' ').trim();
        if (v === (b.label || '')) return;
        b.label = v;
        sendButtons();
        renderPreview();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('blur', commit);
      mid.appendChild(inp);
      var sub = el('div', 'hpc-brow-sub');
      sub.appendChild(el('span', 'hpc-brow-name', b.isKey ? 'Presses the key' : (b.missing ? 'This hotkey is no longer in the deck — remove it or add a new one' : (b.name || b.entry))));
      if (b.key && !b.missing) sub.appendChild(el('span', 'hpc-kcap', b.key));
      mid.appendChild(sub);
      var shapes = el('div', 'hpc-shapes');
      SHAPES.forEach(function (sh) {
        var tooWide = sh.w > Math.min(s.limits.maxSpan, s.cols);
        var on = b.w === sh.w && b.h === sh.h;
        var sb = seg(sh.name, sh.hint + (tooWide ? ' — needs more columns' : ''), on, function () {
          b.w = sh.w; b.h = sh.h;
          render();
          sendButtons();
        });
        sb.classList.add('hpc-shape');
        sb.disabled = tooWide;
        shapes.appendChild(sb);
      });
      var custom = shapeName(b);
      if (custom) {
        var cs = el('span', 'hpc-seg hpc-shape on hpc-shape-custom', custom);
        cs.title = 'Sized on the pad itself';
        shapes.appendChild(cs);
      }
      mid.appendChild(shapes);
      row.appendChild(mid);
      var acts = el('div', 'hpc-brow-acts');
      var up = btn('‹ Up', 'Move earlier on the pad', function () { moveBtn(i, -1); }, 'hpc-mini');
      up.disabled = i === 0;
      var dn = btn('Down ›', 'Move later on the pad', function () { moveBtn(i, 1); }, 'hpc-mini');
      dn.disabled = i === s.buttons.length - 1;
      acts.appendChild(up);
      acts.appendChild(dn);
      acts.appendChild(btn('Remove', 'Take this button off the pad', function () { removeBtn(i); }, 'hpc-mini hpc-danger'));
      row.appendChild(acts);
      list.appendChild(row);
    });
    if (!s.buttons.length) {
      var e = el('div', 'hpc-empty');
      e.appendChild(el('b', '', 'The pad is empty'));
      e.appendChild(el('span', '', 'Search on the right and click a hotkey to put it on the pad.'));
      list.appendChild(e);
    } else if (!shown) {
      list.appendChild(el('div', 'hpc-empty', 'No buttons match “' + ui.qButtons + '”.'));
    }
  }

  function addMatches() {
    var cat = s.catalog || [];
    var terms = words(ui.qAdd).split(/\s+/).filter(Boolean);
    if (!terms.length) return cat.slice();
    var out = [];
    cat.forEach(function (c) {
      if (!terms.every(function (t) { return c.hay.indexOf(t) !== -1; })) return;
      var score = 0;
      terms.forEach(function (t) {
        if (c.nameHay.indexOf(t) === 0) score += 4;
        else if (c.nameHay.indexOf(' ' + t) !== -1) score += 3;
        else if (c.nameHay.indexOf(t) !== -1) score += 2;
        else score += 1;
      });
      out.push({ c: c, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score || a.c.name.localeCompare(b.c.name); });
    return out.map(function (o) { return o.c; });
  }
  /* Keys strip: caps you click to put that key on the pad, the three
     modifiers as toggles in front of them. */
  function renderKeys(keys) {
    var box = $c.keys;
    box.innerHTML = '';
    if (!keys.length) { box.hidden = true; return; }
    box.hidden = false;
    var head = el('div', 'hpc-keys-head');
    head.appendChild(el('span', 'hpc-keys-t', ui.qAdd ? 'Keys' : 'Keys your keyboard may not have'));
    var mods = el('div', 'hpc-keys-mods');
    mods.appendChild(el('span', 'hpc-keys-with', 'with'));
    MODS.forEach(function (m) {
      var on = ui.keyMods.indexOf(m.dik) !== -1;
      mods.appendChild(seg(m.name, (on ? 'Stop holding ' : 'Hold ') + m.name + ' with the key', on, function () {
        if (on) ui.keyMods = ui.keyMods.filter(function (d) { return d !== m.dik; });
        else ui.keyMods.push(m.dik);
        renderAdd();
      }));
    });
    head.appendChild(mods);
    box.appendChild(head);
    var caps = el('div', 'hpc-keys-caps');
    keys.slice(0, KEY_CAP).forEach(function (k) {
      var b = btn(capName(k), 'Put the ' + chordText(k) + ' key on the pad', function () { addKey(k); }, 'hpc-keycap');
      caps.appendChild(b);
    });
    box.appendChild(caps);
  }
  /* What Enter adds: a key when the search names one and no hotkey's name
     starts with it ("home", "pg up", "ins"), otherwise the top hotkey. */
  function enterPick() {
    var keys = keyMatches(ui.qAdd), all = addMatches();
    var q = words(ui.qAdd);
    if (keys.length && ui.qAdd && (!all.length || all[0].nameHay.indexOf(q) !== 0)) return { key: keys[0] };
    return all.length ? { entry: all[0] } : (keys.length && ui.qAdd ? { key: keys[0] } : null);
  }
  function renderAdd() {
    var list = $c.addList;
    list.innerHTML = '';
    renderKeys(keyMatches(ui.qAdd));
    if (!s.catalog) {
      $c.addHint.textContent = 'Reading your hotkeys…';
      return;
    }
    var all = addMatches();
    var onPad = {};
    s.buttons.forEach(function (b) { onPad[b.entry] = true; });
    var pick = enterPick();
    $c.addHint.textContent = ui.qAdd
      ? (pick ? (all.length + ' hotkey' + (all.length === 1 ? '' : 's') + ' · Enter adds ' +
          (pick.key ? 'the ' + chordText(pick.key) + ' key' : '“' + pick.entry.name + '”')) : '')
      : s.catalog.length + ' hotkeys and deck actions · click one to add it';
    all.slice(0, RESULT_CAP).forEach(function (c) {
      var row = el('button', 'hpc-arow');
      row.type = 'button';
      row.title = c.desc ? (c.name + ' — ' + c.desc) : c.name;
      row.appendChild(icon(c.icon, c.name));
      var mid = el('span', 'hpc-arow-mid');
      mid.appendChild(el('span', 'hpc-arow-name', c.name));
      var sub = el('span', 'hpc-arow-sub');
      if (c.cat) sub.appendChild(el('span', 'hpc-arow-cat', c.cat));
      if (c.key) sub.appendChild(el('span', 'hpc-kcap', c.key));
      mid.appendChild(sub);
      row.appendChild(mid);
      row.appendChild(el('span', 'hpc-arow-add' + (onPad[c.id] ? ' is-on' : ''), onPad[c.id] ? 'On pad · add again' : 'Add'));
      row.addEventListener('click', function () { addEntry(c); });
      list.appendChild(row);
    });
    if (!all.length) list.appendChild(el('div', 'hpc-empty', ui.qAdd ? 'No hotkey matches “' + ui.qAdd + '”' + (keyMatches(ui.qAdd).length ? ' — the key above will.' : '.') : 'The deck has no hotkeys yet.'));
    else if (all.length > RESULT_CAP)
      list.appendChild(el('div', 'hpc-more', (all.length - RESULT_CAP) + ' more — keep typing to narrow it down'));
  }

  /* ---- open / close / keys --------------------------------------------- */
  function open() {
    if (ui.modal) { if ($c.qAdd) $c.qAdd.input.focus(); return; }
    var go = function () {
      if (ui.modal) return;
      ui.focusBefore = document.activeElement;
      ui.qButtons = ''; ui.qAdd = '';
      ui.modal = build();
      document.body.appendChild(ui.modal);
      render();
      if ($c.qAdd) $c.qAdd.input.focus();   // type straight away: the picker is why you came
      send({ op: 'get', catalog: true });
      /* the preview sizes its cells from the column's laid-out width */
      requestAnimationFrame(function () { if (ui.modal) renderPreview(); });
    };
    if (window.HDCss && typeof HDCss.need === 'function') HDCss.need('padcfg', go);
    else go();
  }
  function close() {
    if (!ui.modal) return;
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains('hpc-label-in')) active.blur();   // commits a half-typed label
    ui.modal.remove();
    ui.modal = null;
    $c = {};
    try { if (ui.focusBefore && ui.focusBefore.focus) ui.focusBefore.focus(); } catch (e) {}
  }
  function onKey(e) {
    if (!ui.modal) return;
    var t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (t && t.classList && t.classList.contains('hpc-search-in') && t.value) {
        t.value = ''; t.dispatchEvent(new Event('input'));
        return;
      }
      close();
      return;
    }
    if (e.key === 'Enter' && $c.qAdd && t === $c.qAdd.input) {
      e.preventDefault(); e.stopImmediatePropagation();
      var pick = enterPick();
      if (pick && pick.key) addKey(pick.key);
      else if (pick && pick.entry) addEntry(pick.entry);
      return;
    }
    if (e.key === 'Enter' && t && t.classList && t.classList.contains('hpc-label-in')) {
      e.preventDefault(); e.stopImmediatePropagation();
      t.blur();
      return;
    }
    if (e.key === 'Tab') {
      var nodes = Array.prototype.filter.call(ui.modal.querySelectorAll('button,input'), function (n) { return !n.disabled; });
      var i = nodes.indexOf(document.activeElement);
      i = (i + (e.shiftKey ? nodes.length - 1 : 1)) % nodes.length;
      e.preventDefault(); e.stopImmediatePropagation();
      if (nodes[i]) nodes[i].focus();
      return;
    }
    /* keep deck shortcuts and the type-to-search funnel behind us away from
       what is typed here; window capture means target listeners never see
       Enter/Space, so press focused buttons by hand */
    e.stopPropagation();
    if ((e.key === 'Enter' || e.key === ' ') && t && t.tagName === 'BUTTON') { e.preventDefault(); t.click(); }
  }
  window.addEventListener('keydown', onKey, true);
  /* the deck closing takes this window with it */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () { if (ui.modal && !document.body.classList.contains('open')) close(); })
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  window.hpCfgState = receive;
  window.hpCfgOpen = function () { open(); };

  return { open: open, close: close, isOpen: function () { return !!ui.modal; }, state: function () { return s; } };
})();
