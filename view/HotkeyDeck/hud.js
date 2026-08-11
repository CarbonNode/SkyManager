'use strict';

/* ============================================================================
   Followers HUD — view logic for the always-on portrait strip.

   Bridge (C++ registers these as global listeners; we call them via toGame):
     toGame('hudReady')            — on load: "push me config + data"
     toGame('hudSave', json)       — {x,y,scale,orient,showNames} after any edit
     toGame('hudEditDone')         — leave reposition mode (C++ then Unfocuses)
     toGame('hudLog', msg)

   C++ calls INTO us (Invoke / InteropCall -> these globals):
     window.hudConfig(jsonStr)     — {x,y,scale,orient,visible,showNames}
     window.hudData(jsonStr)       — [{name, original, following, dead,
                                       file?, ext?, mtime?, crop?:{z,x,y}, hue?}]
     window.hudEdit("1"|"0")       — enter / leave reposition mode
   ============================================================================ */

(function () {
  const DEV = location.search.indexOf('dev=1') !== -1;

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[hud->game]', fn, arg);
    }
  }

  /* ---- placement config, owned by C++, mirrored here ------------------- */
  const cfg = { x: 40, y: 40, scale: 1, orient: 'horiz', anchorH: 'left', anchorV: 'top', visible: true, showNames: true };
  let followers = [];
  let editing = false;

  const SCALE_MIN = 0.5, SCALE_MAX = 2.6;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const el = {
    body: document.body,
    hud: document.getElementById('hud'),
    panel: document.getElementById('hud-panel'),
    strip: document.getElementById('hud-strip'),
    empty: document.getElementById('hud-empty'),
  };

  /* ---- small helpers ported verbatim from followers-pane.js ------------ */
  function slugOf(name) {
    let s = String(name == null ? '' : name);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* keep */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }
  function hueOf(i) { return (i * 47) % 360; }

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else if (k in node) { try { node[k] = attrs[k]; } catch (e) { node.setAttribute(k, attrs[k]); } }
      else node.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid != null) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    return node;
  }

  /* A source that is already a data:/http(s) URL (harness previews) is used
     verbatim; a bare filename resolves against this view's own portraits/ dir,
     exactly like the deck roster. */
  function srcFor(file) {
    const s = String(file || '');
    return /^(data:|https?:|blob:)/i.test(s) ? s : 'portraits/' + s;
  }

  function faceEl(m, hue) {
    const file = m.file;
    if (!file) {
      const medal = h('span', { class: 'hud-medal' }, initialsOf(m.name));
      medal.style.setProperty('--hud-hue', String(hue));
      return medal;
    }
    const wrap = h('span', { class: 'hud-face' });
    wrap.style.setProperty('--hud-hue', String(hue));
    const raw = srcFor(file);
    const bust = m.mtime && !/^(data:|blob:)/i.test(raw) ? raw + '?v=' + m.mtime : raw;
    const img = h('img', { class: 'hud-face-img', src: bust, alt: '', draggable: 'false' });
    // Crop transform — same math the deck applies so a framed face frames here.
    const c = m.crop;
    if (c && typeof c.z === 'number') {
      img.style.transformOrigin = '50% 50%';
      img.style.transform = 'translate(' + ((c.x || 0) * 100).toFixed(3) + '%,' +
        ((c.y || 0) * 100).toFixed(3) + '%) scale(' + Number(c.z).toFixed(4) + ')';
      img.style.objectPosition = '50% 50%';
    }
    // Query-hostile Ultralight loader: retry the raw path once, then initials.
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried && bust !== raw) { retried = true; img.src = raw; return; }
      toGame('hudLog', 'HUD portrait failed: ' + raw);
      const medal = h('span', { class: 'hud-medal' }, initialsOf(m.name));
      medal.style.setProperty('--hud-hue', String(hue));
      if (wrap.parentNode) wrap.parentNode.replaceChild(medal, wrap);
    });
    wrap.appendChild(img);
    return wrap;
  }

  function chipEl(m, i) {
    const hue = (typeof m.hue === 'number') ? m.hue : hueOf(i);
    const chip = h('div', { class: 'hud-chip' + (m.dead ? ' hud-dead' : '') });
    chip.appendChild(faceEl(m, hue));
    chip.appendChild(h('div', { class: 'hud-name', title: m.name || '' }, m.name || '—'));
    return chip;
  }

  function render() {
    el.strip.innerHTML = '';
    followers.forEach((m, i) => el.strip.appendChild(chipEl(m, i)));
    el.panel.classList.toggle('is-empty', followers.length === 0);
    applyOrient();
  }

  /* ---- placement ------------------------------------------------------- */
  // orient = row vs column; anchor = which corner it hangs off and therefore
  // which way it grows. A row anchored right grows leftward (row-reverse); a
  // column anchored bottom grows upward (column-reverse). Body carries a-right /
  // a-bottom so the CSS reverses the strip.
  function applyOrient() {
    el.strip.classList.toggle('horiz', cfg.orient !== 'vert');
    el.strip.classList.toggle('vert', cfg.orient === 'vert');
    el.body.classList.toggle('a-right', cfg.anchorH === 'right');
    el.body.classList.toggle('a-bottom', cfg.anchorV === 'bottom');
  }
  function applyPlacement() {
    const s = el.hud.style;
    if (cfg.anchorH === 'right') { s.right = cfg.x + 'px'; s.left = 'auto'; }
    else { s.left = cfg.x + 'px'; s.right = 'auto'; }
    if (cfg.anchorV === 'bottom') { s.bottom = cfg.y + 'px'; s.top = 'auto'; }
    else { s.top = cfg.y + 'px'; s.bottom = 'auto'; }
    s.setProperty('--hud-scale', String(cfg.scale));
    // Scale outward from the anchored corner so the anchor point stays fixed.
    s.transformOrigin = (cfg.anchorV === 'bottom' ? 'bottom' : 'top') + ' ' +
      (cfg.anchorH === 'right' ? 'right' : 'left');
  }

  // Cycle the anchor corner TL → TR → BR → BL, preserving the panel's on-screen
  // position across the flip so it doesn't jump when you change growth direction.
  function cycleAnchor() {
    const r = el.hud.getBoundingClientRect();
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    const right = cfg.anchorH === 'right', bottom = cfg.anchorV === 'bottom';
    if (!right && !bottom) cfg.anchorH = 'right';
    else if (right && !bottom) cfg.anchorV = 'bottom';
    else if (right && bottom) cfg.anchorH = 'left';
    else cfg.anchorV = 'top';
    cfg.x = (cfg.anchorH === 'right') ? Math.max(0, vw - r.right) : Math.max(0, r.left);
    cfg.y = (cfg.anchorV === 'bottom') ? Math.max(0, vh - r.bottom) : Math.max(0, r.top);
    applyOrient(); applyPlacement(); saveCfg();
  }
  function applyVisible() { el.body.classList.toggle('hud-hidden', !cfg.visible); }
  function applyNames() { el.body.classList.toggle('hud-names-off', !cfg.showNames); }

  function applyConfig() { applyPlacement(); applyOrient(); applyVisible(); applyNames(); }

  // x/y are distances from the anchored edges, so keep them non-negative and
  // short of the far edge — a corner of the assembly always stays on-screen.
  function clampToView() {
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    cfg.x = clamp(cfg.x, 0, Math.max(0, vw - 48));
    cfg.y = clamp(cfg.y, 0, Math.max(0, vh - 48));
  }

  function saveCfg() {
    clampToView();
    toGame('hudSave', JSON.stringify({
      x: Math.round(cfg.x), y: Math.round(cfg.y),
      scale: Number(cfg.scale.toFixed(3)), orient: cfg.orient,
      anchorH: cfg.anchorH, anchorV: cfg.anchorV, showNames: !!cfg.showNames,
    }));
  }

  /* ---- edit mode: drag / resize / flip / names ------------------------- */
  function setEditing(on) {
    editing = !!on;
    el.body.classList.toggle('hud-editing', editing);
    // While repositioning the HUD is always shown even if 'visible' is off, so
    // it can be placed before it is ever toggled on.
    if (editing) el.body.classList.remove('hud-hidden');
    else applyVisible();
  }

  let drag = null;   // {mode:'move'|'resize', sx,sy, ox,oy, oscale}
  function onPointerDown(e) {
    if (!editing) return;
    const role = e.target && e.target.getAttribute && e.target.getAttribute('data-role');
    if (role === 'flip') { cfg.orient = cfg.orient === 'vert' ? 'horiz' : 'vert'; applyOrient(); saveCfg(); return; }
    if (role === 'grow') { cycleAnchor(); return; }
    if (role === 'names') { cfg.showNames = !cfg.showNames; applyNames(); saveCfg(); return; }
    if (role === 'done') { setEditing(false); saveCfg(); toGame('hudEditDone'); return; }
    if (role === 'resize') {
      drag = { mode: 'resize', sx: e.clientX, sy: e.clientY, oscale: cfg.scale };
    } else {
      // Anywhere on the panel or the grip moves it.
      drag = { mode: 'move', sx: e.clientX, sy: e.clientY, ox: cfg.x, oy: cfg.y };
    }
    try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag) return;
    if (drag.mode === 'move') {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      // When anchored to the far edge the offset grows the opposite way, so the
      // panel always tracks the cursor regardless of which corner it hangs off.
      cfg.x = drag.ox + (cfg.anchorH === 'right' ? -dx : dx);
      cfg.y = drag.oy + (cfg.anchorV === 'bottom' ? -dy : dy);
      clampToView();
      applyPlacement();
    } else {
      // Drag the corner out to grow. Diagonal delta / a reference span -> scale.
      const d = ((e.clientX - drag.sx) + (e.clientY - drag.sy)) / 2;
      cfg.scale = clamp(drag.oscale + d / 220, SCALE_MIN, SCALE_MAX);
      applyPlacement();
    }
    e.preventDefault();
  }
  function onPointerUp() { if (drag) { drag = null; saveCfg(); } }

  el.hud.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  // Ultralight sometimes only emits mouse events — mirror the handlers.
  el.hud.addEventListener('mousedown', (e) => { e.pointerId = e.pointerId || 1; onPointerDown(e); });
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  /* ---- interop receivers (C++ -> view) --------------------------------- */
  function parse(s) { try { return JSON.parse(s); } catch (e) { toGame('hudLog', 'HUD parse: ' + e); return null; } }

  window.hudConfig = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    if (!j) return;
    if (typeof j.x === 'number') cfg.x = j.x;
    if (typeof j.y === 'number') cfg.y = j.y;
    if (typeof j.scale === 'number') cfg.scale = clamp(j.scale, SCALE_MIN, SCALE_MAX);
    if (j.orient === 'vert' || j.orient === 'horiz') cfg.orient = j.orient;
    if (j.anchorH === 'left' || j.anchorH === 'right') cfg.anchorH = j.anchorH;
    if (j.anchorV === 'top' || j.anchorV === 'bottom') cfg.anchorV = j.anchorV;
    if (typeof j.visible === 'boolean') cfg.visible = j.visible;
    if (typeof j.showNames === 'boolean') cfg.showNames = j.showNames;
    applyConfig();
  };
  window.hudData = function (s) {
    const j = (typeof s === 'string') ? parse(s) : s;
    followers = Array.isArray(j) ? j : (j && Array.isArray(j.followers) ? j.followers : []);
    render();
  };
  window.hudEdit = function (s) { setEditing(String(s) === '1' || s === true); };
  // Convenience single-flag setter C++ can use for the toggle key.
  window.hudSetVisible = function (s) { cfg.visible = (String(s) === '1' || s === true); applyVisible(); };

  // Expose a tiny surface for the harness / debugging.
  window.__hud = { cfg, get followers() { return followers; }, get editing() { return editing; }, render, setEditing, saveCfg };

  applyConfig();
  render();
  toGame('hudReady');
})();
