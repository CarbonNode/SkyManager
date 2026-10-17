/* md-combo.js — the Spell Deck's typeable dropdown (Rober, 2026-10-15: "drop downs
 * suck right now", with a screenshot of the native Type menu painting as a small
 * white OS list over the gilt panel).
 *
 * Ultralight draws a native <select> as the host OS widget: it ignores our
 * background, our font and our gold, and its popup is a grey system list. The
 * same engine note already forced drawn sliders (music-pane paintVol) for
 * <input type=range>. So this module keeps the <select> as the state of record —
 * every existing sync, listener and check still reads and writes it — and draws
 * a real control over it:
 *
 *   - a framed face carrying the control's label, the chosen option and its icon;
 *   - a body-anchored menu (position: fixed, so no overflow:hidden ancestor can
 *     clip it) with a filter field at the top: type to narrow, Enter takes the
 *     top hit — the deck's fd-ctx-menu idiom, which the UI rules ask for on every
 *     list that can be filtered;
 *   - arrow keys to walk, Home/End to jump, Escape to close.
 *
 * The <select> stays in the DOM, 1px and invisible, and every pick writes it and
 * dispatches a real 'change' event. That is what makes this swap cheap: nothing
 * downstream knows the control was replaced, and if this file ever fails to load
 * the page still has a working (ugly) control rather than no control.
 *
 * Engine facts this file is built on (tools/ultralight-probe/README.md):
 *   - a native keydown can arrive as key "Unidentified" with only keyCode, so
 *     every key test reads both (keyOf below);
 *   - MouseEvent.buttons is 0 even while a button is held, so nothing here
 *     branches on it — presses are tracked from mousedown;
 *   - the panel is painted through transform: scale(--ui-scale). getBoundingClientRect
 *     returns post-scale screen pixels, so the menu is placed from the rect and
 *     then given the SAME scale, with its own width/height in pre-scale pixels.
 *     That keeps the menu glued to its button and reading at the player's zoom.
 */
(function () {
  'use strict';

  /* app.js owns the real h(); this file is also loaded by harnesses on its own,
     so fall back to an equivalent. Looked up per call, never bound at load. */
  function H() { return (window.h || localH).apply(null, arguments); }

  function localH(tag, attrs) {
    var e = document.createElement(tag), k, i;
    if (attrs) for (k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    for (i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach(function (c) {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  var combos = [];     // every attached control, in creation order
  var live = null;     // the open one: { combo, menu, input, list, rows, hi }

  function keyOf(e) {
    var k = e && e.key;
    if (k && k !== 'Unidentified') return k;
    switch (e && e.keyCode) {           // Ultralight hands some keys only the legacy code
      case 27: return 'Escape';
      case 13: return 'Enter';
      case 9:  return 'Tab';
      case 38: return 'ArrowUp';
      case 40: return 'ArrowDown';
      case 36: return 'Home';
      case 35: return 'End';
      default: return k || '';
    }
  }

  /* The panel's painted scale. Same derivation workbench.js uses for its pane
     drags: a rect measured on screen over the untransformed layout width. */
  function panelScale() {
    var p = document.getElementById('panel');
    if (!p || !p.offsetWidth) return 1;
    var w = p.getBoundingClientRect().width;
    return w > 0 ? (w / p.offsetWidth) || 1 : 1;
  }

  function iconNode(icon, size) {
    if (!icon) return null;
    if (typeof icon === 'function') { try { return icon(); } catch (e) { return null; } }
    return H('img', { src: icon, width: size || 26, height: size || 26, alt: '', draggable: 'false' });
  }

  function optionsOf(combo) {
    return Array.prototype.map.call(combo.sel.options, function (o) {
      return { value: o.value, label: o.textContent, hint: o.getAttribute('data-hint') || '',
        icon: combo.icons ? combo.icons[o.value] : null, disabled: !!o.disabled };
    });
  }

  function chosen(combo) {
    var opts = optionsOf(combo), v = combo.sel.value, i;
    for (i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i];
    return opts[0] || { value: '', label: '', icon: null };
  }

  /* Repaint one face from the <select>'s current value. Cheap enough to call on
     every sync; it rebuilds only the value side, never the label. */
  function paint(combo) {
    var o = chosen(combo), art = iconNode(o.icon, 26);
    combo.art.textContent = '';
    combo.art.hidden = !art;
    if (art) combo.art.append(art);
    combo.value.textContent = o.label;
    combo.btn.setAttribute('aria-label', combo.label + ': ' + o.label);
    combo.btn.title = combo.hint ? combo.hint + ' — now ' + o.label : combo.label + ': ' + o.label;
    combo.btn.classList.toggle('mdc-set', !!combo.active && combo.active(o.value));
  }

  function paintAll() { combos.forEach(paint); }

  function close(restoreFocus) {
    if (!live) return;
    var combo = live.combo;
    if (live.menu.parentNode) live.menu.parentNode.removeChild(live.menu);
    combo.btn.setAttribute('aria-expanded', 'false');
    live = null;
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('blur', onReflow);
    if (restoreFocus && combo.btn.isConnected) combo.btn.focus();
  }

  function onDocDown(e) {
    if (!live) return;
    if (live.menu.contains(e.target) || live.combo.btn.contains(e.target)) return;
    close(false);
  }

  function onReflow() { close(false); }

  /* Place the menu under (or over) its button. Coordinates come off the button's
     screen rect; the menu then wears the panel's scale so its type matches. */
  function place() {
    if (!live) return;
    var r = live.combo.btn.getBoundingClientRect(), s = panelScale(), menu = live.menu;
    var room = Math.max(160, (window.innerHeight - 24) / s);
    menu.style.maxHeight = Math.round(room) + 'px';
    menu.style.width = Math.round(Math.max(290, r.width / s)) + 'px';
    menu.style.transform = 'scale(' + s + ')';
    var hPx = menu.offsetHeight * s, below = window.innerHeight - r.bottom - 8;
    var up = hPx > below && r.top - 8 > below;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth * s - 8))) + 'px';
    menu.style.top = Math.round(up ? Math.max(8, r.top - 6 - hPx) : r.bottom + 6) + 'px';
    menu.classList.toggle('mdc-up', up);
  }

  function matches(opt, q) {
    if (!q) return true;
    var hay = (opt.label + ' ' + opt.hint).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0; });
  }

  function highlight(i) {
    if (!live) return;
    var rows = live.rows;
    if (!rows.length) { live.hi = -1; return; }
    live.hi = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach(function (r, n) {
      r.el.classList.toggle('on', n === live.hi);
      r.el.setAttribute('aria-selected', String(n === live.hi));
    });
    var el = rows[live.hi].el, box = live.list;
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }

  function pick(opt) {
    if (!live || !opt || opt.disabled) return;
    var combo = live.combo;
    close(true);
    if (combo.sel.value === opt.value) return;      // no spurious change event
    combo.sel.value = opt.value;
    combo.sel.dispatchEvent(new Event('change', { bubbles: true }));
    paint(combo);
  }

  function draw() {
    if (!live) return;
    var combo = live.combo, q = live.input.value.trim(), cur = combo.sel.value;
    var opts = optionsOf(combo).filter(function (o) { return matches(o, q); });
    live.list.textContent = '';
    live.rows = [];
    if (!opts.length) {
      live.list.append(H('p', { class: 'mdc-none' }, 'Nothing matches “' + q + '”.'));
      live.hi = -1;
      live.count.textContent = '0 of ' + combo.sel.options.length;
      place();
      return;
    }
    opts.forEach(function (o) {
      var row = H('button', { type: 'button', class: 'mdc-opt' + (o.value === cur ? ' is-current' : ''), role: 'option' });
      var art = iconNode(o.icon, 30);
      if (art) row.append(H('span', { class: 'mdc-opt-art' }, art));
      else if (combo.hasIcons) row.append(H('span', { class: 'mdc-opt-art mdc-opt-art-empty', 'aria-hidden': 'true' }));
      row.append(H('span', { class: 'mdc-opt-text' },
        H('span', { class: 'mdc-opt-label' }, o.label),
        o.hint ? H('small', null, o.hint) : null));
      row.append(H('span', { class: 'mdc-opt-mark', 'aria-hidden': 'true' }, o.value === cur ? '✓' : ''));
      if (o.disabled) row.disabled = true;
      row.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus in the filter
      row.addEventListener('click', function () { pick(o); });
      row.addEventListener('mousemove', function () {
        var n = live && live.rows.findIndex(function (r) { return r.el === row; });
        if (live && n >= 0 && n !== live.hi) highlight(n);
      });
      live.list.append(row);
      live.rows.push({ el: row, opt: o });
    });
    live.count.textContent = opts.length === combo.sel.options.length
      ? opts.length + (opts.length === 1 ? ' choice' : ' choices')
      : opts.length + ' of ' + combo.sel.options.length;
    var at = live.rows.findIndex(function (r) { return r.opt.value === cur; });
    highlight(q ? 0 : (at < 0 ? 0 : at));
    place();
  }

  function openFor(combo) {
    if (live && live.combo === combo) { close(true); return; }
    close(false);
    var input = H('input', { type: 'search', class: 'mdc-find', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Filter ' + combo.label.toLowerCase() + '…', 'aria-label': 'Filter ' + combo.label });
    var count = H('span', { class: 'mdc-count', role: 'status' });
    var list = H('div', { class: 'mdc-list', role: 'listbox', 'aria-label': combo.label });
    var menu = H('div', { class: 'mdc-menu', 'data-mdc-for': combo.sel.id || '' },
      H('div', { class: 'mdc-head' }, H('span', { class: 'mdc-title' }, combo.label), count),
      H('div', { class: 'mdc-find-wrap' }, H('span', { class: 'mdc-find-ic', 'aria-hidden': 'true' }, '⌕'), input),
      list);
    // The theme lives on :root as well as #panel, so a body-anchored menu keeps
    // the player's accent (the 2026-10-11 palette note).
    document.body.append(menu);
    combo.btn.setAttribute('aria-expanded', 'true');
    live = { combo: combo, menu: menu, input: input, list: list, count: count, rows: [], hi: -1 };
    input.addEventListener('input', draw);
    draw();
    place();
    input.focus();
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('blur', onReflow);
  }

  /* Owned keys while a menu is up. app.js's onKeyDown is a document CAPTURE
     listener registered at startup, so a listener added here would run after it
     and Escape would close the whole Spell Deck. MagicWorkbench.onKey is called
     first inside onKeyDown and forwards to this — that is the supported hook. */
  function onKey(e) {
    if (!live) return false;
    var k = keyOf(e);
    if (k === 'Escape') { e.preventDefault(); close(true); return true; }
    if (k === 'Tab') { close(true); return true; }
    if (k === 'ArrowDown') { e.preventDefault(); highlight(live.hi + 1); return true; }
    if (k === 'ArrowUp') { e.preventDefault(); highlight(live.hi - 1); return true; }
    if (k === 'Home') { e.preventDefault(); highlight(0); return true; }
    if (k === 'End') { e.preventDefault(); highlight(live.rows.length - 1); return true; }
    if (k === 'Enter') {
      e.preventDefault();
      if (live.rows.length) pick(live.rows[live.hi >= 0 ? live.hi : 0].opt);
      else close(true);
      return true;
    }
    return false;    // every other key belongs to the filter field
  }

  /* Draw a control over an existing <select>, which stays as the state of record.
     spec: { label, hint, icons: {value: path|factory}, active: fn(value)->bool } */
  function attach(sel, spec) {
    if (!sel || sel.dataset.mdc === '1') return null;
    spec = spec || {};
    sel.dataset.mdc = '1';
    var combo = {
      sel: sel,
      label: spec.label || sel.getAttribute('aria-label') || 'Choose',
      hint: spec.hint || sel.getAttribute('title') || '',
      icons: spec.icons || null,
      active: spec.active || null,
      hasIcons: !!spec.icons,
    };
    combo.art = H('span', { class: 'mdc-art', 'aria-hidden': 'true' });
    combo.value = H('span', { class: 'mdc-value' });
    combo.btn = H('button', { type: 'button', class: 'mdc' + (spec.className ? ' ' + spec.className : ''),
      'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      H('span', { class: 'mdc-label' }, combo.label),
      combo.art, combo.value,
      H('span', { class: 'mdc-caret', 'aria-hidden': 'true' }, '▾'));
    // Lets a stylesheet reach one control by the select it stands for (Table view
    // hides Sort, because its column header IS the sort).
    combo.btn.setAttribute('data-mdc-sel', sel.id || '');
    combo.btn.addEventListener('click', function () { openFor(combo); });
    sel.parentNode.insertBefore(combo.btn, sel);
    sel.classList.add('mdc-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');
    // A programmatic write (library-ui's sync, or a check driving the select)
    // must move the face too.
    sel.addEventListener('change', function () { paint(combo); });
    combos.push(combo);
    paint(combo);
    return combo;
  }

  window.MdCombo = {
    attach: attach,
    sync: paintAll,
    onKey: onKey,
    close: function () { close(false); },
    isOpen: function () { return !!live; },
    openFor: function (sel) {
      var c = combos.find(function (x) { return x.sel === sel; });
      if (c) openFor(c);
    },
    _combos: combos,
  };
})();
