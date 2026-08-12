'use strict';

/* ============================================================ bridge ==== */
/* C++ registers these listeners as global functions: hdFire, hdFireKey,
   hdSave, hdClose, hdLog. C++ calls into us via: hdOpen(cfg), hdClosed(),
   hdSaved(ok). */

const DEV = location.search.indexOf('dev=1') !== -1;

function toGame(fn, arg) {
  const f = window[fn];
  if (typeof f === 'function') {
    try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
  } else {
    console.log('[dev->game]', fn, arg);
  }
}

/* ========================================================== key maps ==== */

const MOD_DIK = { SHIFT: 42, CTRL: 29, ALT: 56 };
const MOD_LABEL = { 42: 'Shift', 29: 'Ctrl', 56: 'Alt' };

/* KeyboardEvent.code -> [DIK scancode, label] */
const DIK = {
  Digit1: [0x02, '1'], Digit2: [0x03, '2'], Digit3: [0x04, '3'], Digit4: [0x05, '4'],
  Digit5: [0x06, '5'], Digit6: [0x07, '6'], Digit7: [0x08, '7'], Digit8: [0x09, '8'],
  Digit9: [0x0A, '9'], Digit0: [0x0B, '0'],
  Minus: [0x0C, '-'], Equal: [0x0D, '='], Backspace: [0x0E, 'Bksp'], Tab: [0x0F, 'Tab'],
  KeyQ: [0x10, 'Q'], KeyW: [0x11, 'W'], KeyE: [0x12, 'E'], KeyR: [0x13, 'R'],
  KeyT: [0x14, 'T'], KeyY: [0x15, 'Y'], KeyU: [0x16, 'U'], KeyI: [0x17, 'I'],
  KeyO: [0x18, 'O'], KeyP: [0x19, 'P'],
  BracketLeft: [0x1A, '['], BracketRight: [0x1B, ']'], Enter: [0x1C, 'Enter'],
  KeyA: [0x1E, 'A'], KeyS: [0x1F, 'S'], KeyD: [0x20, 'D'], KeyF: [0x21, 'F'],
  KeyG: [0x22, 'G'], KeyH: [0x23, 'H'], KeyJ: [0x24, 'J'], KeyK: [0x25, 'K'],
  KeyL: [0x26, 'L'],
  Semicolon: [0x27, ';'], Quote: [0x28, "'"], Backquote: [0x29, '`'], Backslash: [0x2B, '\\'],
  KeyZ: [0x2C, 'Z'], KeyX: [0x2D, 'X'], KeyC: [0x2E, 'C'], KeyV: [0x2F, 'V'],
  KeyB: [0x30, 'B'], KeyN: [0x31, 'N'], KeyM: [0x32, 'M'],
  Comma: [0x33, ','], Period: [0x34, '.'], Slash: [0x35, '/'],
  NumpadMultiply: [0x37, 'Num *'], Space: [0x39, 'Space'], CapsLock: [0x3A, 'Caps'],
  F1: [0x3B, 'F1'], F2: [0x3C, 'F2'], F3: [0x3D, 'F3'], F4: [0x3E, 'F4'], F5: [0x3F, 'F5'],
  F6: [0x40, 'F6'], F7: [0x41, 'F7'], F8: [0x42, 'F8'], F9: [0x43, 'F9'], F10: [0x44, 'F10'],
  NumLock: [0x45, 'NumLock'], ScrollLock: [0x46, 'ScrLk'],
  Numpad7: [0x47, 'Num 7'], Numpad8: [0x48, 'Num 8'], Numpad9: [0x49, 'Num 9'],
  NumpadSubtract: [0x4A, 'Num -'],
  Numpad4: [0x4B, 'Num 4'], Numpad5: [0x4C, 'Num 5'], Numpad6: [0x4D, 'Num 6'],
  NumpadAdd: [0x4E, 'Num +'],
  Numpad1: [0x4F, 'Num 1'], Numpad2: [0x50, 'Num 2'], Numpad3: [0x51, 'Num 3'],
  Numpad0: [0x52, 'Num 0'], NumpadDecimal: [0x53, 'Num .'],
  F11: [0x57, 'F11'], F12: [0x58, 'F12'],
  F13: [0x64, 'F13'], F14: [0x65, 'F14'], F15: [0x66, 'F15'],
  NumpadEnter: [0x9C, 'Num Enter'], NumpadDivide: [0xB5, 'Num /'],
  PrintScreen: [0xB7, 'PrtSc'],
  Home: [0xC7, 'Home'], ArrowUp: [0xC8, 'Up'], PageUp: [0xC9, 'PgUp'],
  ArrowLeft: [0xCB, 'Left'], ArrowRight: [0xCD, 'Right'], End: [0xCF, 'End'],
  ArrowDown: [0xD0, 'Down'], PageDown: [0xD1, 'PgDn'],
  Insert: [0xD2, 'Ins'], Delete: [0xD3, 'Del'],
};

const MODIFIER_CODES = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'];

/* mouse: e.button -> [skyrim idCode, label] (left/right reserved for the UI) */
const MOUSE = { 1: [2, 'Middle Mouse'], 3: [3, 'Mouse 4'], 4: [4, 'Mouse 5'] };

/* ---- extended F13–F24 bridge (mirrors the C++ defaults in main.cpp) ---- */
const EXT_NAMES = ['F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24'];
const EXT_RAW = { F13: 100, F14: 101, F15: 102, F16: 103, F17: 104, F18: 105,
                  F19: 106, F20: 107, F21: 108, F22: 109, F23: 110, F24: 118 };
const EXT_DEFAULT_MAP = Object.assign({}, EXT_RAW, { F24: 73 }); // F24 (Brightness) -> Num 9

/* F13-F24 belong in DIK too, DERIVED from EXT_RAW so the two can never drift.
 *
 * The literal table above stops at F15 — the three "classic" extended keys —
 * and was never extended when the F13-F24 bridge shipped. The result was a
 * capture that resolved F13/F14/F15 and answered "Unsupported key: F22" for
 * everything above, which is what Rober hit trying to put Full Save on G12
 * (2026-08-02). DIK_LABEL already knew all twelve names, so the gap showed up
 * only on the code -> key lookup, and only for the nine keys nobody had bound
 * yet: exactly the shape of bug that hides until someone uses the feature.
 *
 * EXT_RAW's values ARE the DirectInput scancodes (F13 0x64 … F23 0x6E, F24
 * 0x76), which is why deriving is safe and hand-typing a second copy would
 * not be. Only fills gaps, so the F13/F14/F15 literals stay authoritative. */
EXT_NAMES.forEach((n) => { if (!DIK[n]) DIK[n] = [EXT_RAW[n], n]; });

const DIK_LABEL = (() => {
  const m = {};
  Object.keys(DIK).forEach((k) => { const e = DIK[k]; if (!(e[0] in m)) m[e[0]] = e[1]; });
  Object.keys(EXT_RAW).forEach((n) => { m[EXT_RAW[n]] = n; });
  return m;
})();

/* Shared with other view modules (e.g. the Formation modal's cast-key rebind):
   a DIK scancode -> its human label, and a KeyboardEvent.code -> DIK scancode.
   Kept here because DIK/DIK_LABEL are the single source of truth for both. */
window.hdKeyLabel = (code) => DIK_LABEL[code] || (code === -1 ? 'None' : 'code ' + code);
window.hdKeyScan = (evCode) => (DIK[evCode] ? DIK[evCode][0] : null);

/* normalize settings.extKeys in place (older configs lack it) and return it */
function extKeysState() {
  let ek = state.settings.extKeys;
  if (!ek || typeof ek !== 'object') ek = state.settings.extKeys = {};
  if (typeof ek.enabled !== 'boolean') ek.enabled = true;
  if (!ek.map || typeof ek.map !== 'object') ek.map = {};
  EXT_NAMES.forEach((n) => { if (typeof ek.map[n] !== 'number') ek.map[n] = EXT_DEFAULT_MAP[n]; });
  return ek;
}

/* Ultralight (in-game webview) may deliver key events without `e.code`. Fall back to
   legacy keyCode so every shortcut and capture still works in-game. */
const VK_MISC = {
  8: 'Backspace', 9: 'Tab', 20: 'CapsLock', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  45: 'Insert', 46: 'Delete',
  106: 'NumpadMultiply', 107: 'NumpadAdd', 109: 'NumpadSubtract',
  110: 'NumpadDecimal', 111: 'NumpadDivide', 144: 'NumLock', 145: 'ScrollLock',
  186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus', 190: 'Period',
  191: 'Slash', 192: 'Backquote', 219: 'BracketLeft', 220: 'Backslash',
  221: 'BracketRight', 222: 'Quote',
};

function normCode(e) {
  if (e.code) return e.code;
  const k = e.keyCode || 0;
  if (k === 13) return e.location === 3 ? 'NumpadEnter' : 'Enter';
  if (k === 16) return e.location === 2 ? 'ShiftRight' : 'ShiftLeft';
  if (k === 17) return e.location === 2 ? 'ControlRight' : 'ControlLeft';
  if (k === 18) return e.location === 2 ? 'AltRight' : 'AltLeft';
  if (k >= 65 && k <= 90) return 'Key' + String.fromCharCode(k);
  if (k >= 48 && k <= 57) return 'Digit' + String.fromCharCode(k);
  if (k >= 96 && k <= 105) return 'Numpad' + (k - 96);
  if (k >= 112 && k <= 123) return 'F' + (k - 111);
  if (VK_MISC[k]) return VK_MISC[k];
  return (e.key && e.key.length > 1) ? e.key : '';
}

const NUMPAD_LAYOUT = [
  { l: 'NumLock', c: 0x45, small: true }, { l: '/', c: 0xB5 }, { l: '*', c: 0x37 }, { l: '−', c: 0x4A, real: 'Num -' },
  { l: '7', c: 0x47 }, { l: '8', c: 0x48 }, { l: '9', c: 0x49 }, { l: '+', c: 0x4E, cls: 'tall' },
  { l: '4', c: 0x4B }, { l: '5', c: 0x4C }, { l: '6', c: 0x4D },
  { l: '1', c: 0x4F }, { l: '2', c: 0x50 }, { l: '3', c: 0x51 }, { l: 'Enter', c: 0x9C, cls: 'tall', small: true },
  { l: '0', c: 0x52, cls: 'wide' }, { l: '.', c: 0x53 },
];

/* ============================================================= state ==== */

let state = {
  settings: {
    pauseOnOpen: true,
    smoothPause: true,   // freeze time (sgtm 0) instead of a menu pause — snappy cursor
    closeAfterFire: true,
    stickyNpMods: false,
    targetOpensFollowers: true,
    uiScale: 1,
    scrollSpeed: 1,   // deck scroll-wheel speed multiplier (0.5-3.0), applied by applyScrollSpeed
    panelW: 0,   // drag-to-resize size, PRE-scale layout px (0 = auto)
    panelH: 0,
    /* Per-TAB size overrides, on top of uiScale above — { tab: {ui, img} },
       0/absent = the stylesheet's default. Owned by hd-scale.js; it lives in
       `settings` rather than in each pane's own slice because every slice is
       round-tripped whole by C++, so one map is one place to get that wrong
       instead of five. See hd-scale.js for the whole contract. */
    tabScales: {},
    openKey: { device: 'keyboard', code: 65, label: 'F7' },
    openMods: {
      shift: { device: 'keyboard', code: 211, label: 'Del' },
      ctrl: { device: 'keyboard', code: 0, label: '' },
      alt: { device: 'keyboard', code: 0, label: '' },
    },
  },
  categories: [],
  notes: '',
  entries: [],
  /* Favorites Shelf (hd-shelf.js owns the schema; C++ round-trips it as a raw
     blob on Config). Kept at the root so the existing hdSave/hdOpen whole-state
     round-trip carries it with zero extra plumbing. */
  shelf: { side: 'right', open: false, pins: [] },
  /* Wheel Menu (hd-wheel.js owns the schema; C++ round-trips it as a raw blob
     too). A SEPARATE slice from `shelf` on purpose — Rober asked for a second
     favourites system that shares nothing with the first. */
  wheel: { size: 1, active: 0, wheels: [] },
};

const SCALE_MIN = 0.6, SCALE_MAX = 1.6, SCALE_STEP = 0.1;
const SCROLL_MIN = 0.5, SCROLL_MAX = 3.0, SCROLL_STEP = 0.1;
function clampScroll(v) {
  v = Math.round((Number(v) || 1) / SCROLL_STEP) * SCROLL_STEP;
  return Math.max(SCROLL_MIN, Math.min(SCROLL_MAX, Number(v.toFixed(2))));
}
/* Deck scroll-wheel speed. Ultralight's own wheel step is fixed and felt slow to
   Rober; this takes over vertical wheel scrolling in the deck's scroll containers
   and scales it by the multiplier. Reads state.settings.scrollSpeed live, so the
   slider is felt as you drag. Edge-aware: at the top/bottom of a container it lets
   the event bubble so a parent scroller still works. Installed once. */
function installScrollSpeed() {
  if (window.__hdScrollInstalled) return;
  window.__hdScrollInstalled = true;
  document.addEventListener('wheel', function (e) {
    var mult = clampScroll(state.settings.scrollSpeed);
    if (!e.deltaY) return;
    var el = e.target;
    while (el && el !== document.body && el.nodeType === 1) {
      if (el.scrollHeight > el.clientHeight + 1) {
        var oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') break;
      }
      el = el.parentElement;
    }
    if (!el || el === document.body || el.nodeType !== 1) return;
    var atTop = el.scrollTop <= 0;
    var atBot = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBot)) return;   // let it bubble
    el.scrollTop += e.deltaY * mult;
    e.preventDefault();
  }, { passive: false });
}

function clampScale(v) {
  v = Math.round((Number(v) || 1) / SCALE_STEP) * SCALE_STEP;  // snap to step
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Number(v.toFixed(2))));
}

function applyScale() {
  const s = clampScale(state.settings.uiScale);
  state.settings.uiScale = s;
  document.documentElement.style.setProperty('--ui-scale', s);
  const val = $('scale-val');
  if (val) val.textContent = Math.round(s * 100) + '%';
  const dn = $('scale-down'), up = $('scale-up');
  if (dn) dn.disabled = s <= SCALE_MIN + 1e-6;
  if (up) up.disabled = s >= SCALE_MAX - 1e-6;
  if (typeof window.hdSyncScalePop === 'function') window.hdSyncScalePop();   // header ⤤ popover readout
}

function setScale(v, persist) {
  state.settings.uiScale = clampScale(v);
  applyScale();
  applyPanelSize();   // ceiling depends on scale — re-clamp the drag size
  if (persist) save();
}


/* ================================================ pointer drag engine ==== *
 * Ultralight (PrismaUI's renderer) has no HTML5 drag & drop — dragstart/
 * dragover/drop never fire in-game. The entry list already drags via raw
 * mouse events (onDragStart/Move/End below); this is the GENERIC engine the
 * Followers / Domains panes use for their drags: mousedown arms, 6 px of
 * travel activates, drop candidates are rectangle hit-tested per mousemove,
 * mouseup drops. A completed drag swallows the click its mouseup synthesizes
 * (so dropping never travels/opens the row you dropped onto).              */

const PDrag = (() => {
  const P = { suppressClick: false };
  let armed = null, active = false;
  const THRESHOLD = 6;

  P.arm = function (e, spec) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('button, input, select, textarea')) return;
    armed = Object.assign({ x0: e.clientX, y0: e.clientY, srcEl: e.currentTarget }, spec);
  };
  P.cancel = function () {
    if (!armed) return;
    const a = armed;
    armed = null; active = false;
    document.body.classList.remove('pdragging');
    if (a.srcEl && a.srcEl.classList) a.srcEl.classList.remove('dragging');
    pdTake();
    if (a.onCancel) a.onCancel();
  };
  function move(e) {
    if (!armed) return;
    if (!active) {
      if (Math.abs(e.clientX - armed.x0) + Math.abs(e.clientY - armed.y0) < THRESHOLD) return;
      active = true;
      document.body.classList.add('pdragging');
      if (armed.srcEl && armed.srcEl.isConnected) armed.srcEl.classList.add('dragging');
      if (armed.onStart) armed.onStart();
    }
    if (armed.onMove) armed.onMove(e);
  }
  function up(e) {
    if (!armed) return;
    const a = armed, wasDrag = active;
    armed = null; active = false;
    document.body.classList.remove('pdragging');
    if (a.srcEl && a.srcEl.classList) a.srcEl.classList.remove('dragging');
    if (!wasDrag) { pdTake(); return; }        // plain click — let it through
    P.suppressClick = true;
    setTimeout(() => { P.suppressClick = false; }, 0);
    if (a.onDrop) a.onDrop(e);
    else pdTake();
  }
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', up, true);
  document.addEventListener('click', (ev) => {
    if (P.suppressClick) { ev.stopPropagation(); ev.preventDefault(); }
  }, true);
  return P;
})();
window.PDrag = PDrag;

/* shared hit-scan for pane drags. zones = [{ sel, mode:'into'|'ba', eligible? }]
 * (null zone entries are skipped); first zone containing the cursor wins. */
let pdCur = null;   // { el, mode, after }
function pdScan(e, zones) {
  let found = null;
  for (let z = 0; z < zones.length && !found; z++) {
    const zone = zones[z];
    if (!zone) continue;
    const els = document.querySelectorAll(zone.sel);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (zone.eligible && !zone.eligible(el)) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        found = { el, zone };
        break;
      }
    }
  }
  if (pdCur && (!found || pdCur.el !== found.el)) {
    pdCur.el.classList.remove('drop-into', 'drop-before', 'drop-after');
    pdCur = null;
  }
  if (!found) return;
  if (found.zone.mode === 'into') {
    found.el.classList.add('drop-into');
    pdCur = { el: found.el, mode: 'into', after: false };
  } else {
    const r = found.el.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    found.el.classList.toggle('drop-after', after);
    found.el.classList.toggle('drop-before', !after);
    pdCur = { el: found.el, mode: 'ba', after };
  }
}
function pdTake() {
  const t = pdCur;
  if (t) t.el.classList.remove('drop-into', 'drop-before', 'drop-after');
  pdCur = null;
  return t;
}
window.pdScan = pdScan;
window.pdTake = pdTake;

/* ======================================================= panel size ==== *
 * Same contract as the Spell Deck: auto default (CSS min(1500px, 94vw / s))
 * plus an optional user drag size in --panel-w/--panel-h, persisted as
 * settings.panelW/panelH (0 = auto). Dragged sizes are PRE-scale layout px;
 * clamps divide the viewport budget by the scale so the SCALED result fits. */

const PMIN_W = 640, PMIN_H = 480;      // floor, pre-scale layout px
const PMAX_VW = 0.96, PMAX_VH = 0.94;  // ceiling, share of the viewport

function panelMax() {
  const s = clampScale(state.settings.uiScale);
  return {
    w: Math.floor((window.innerWidth * PMAX_VW) / s),
    h: Math.floor((window.innerHeight * PMAX_VH) / s),
  };
}
function clampPanelDim(v, min, max) { return Math.round(Math.max(Math.min(min, max), Math.min(v, max))); }
function clampPanelW(w) { return clampPanelDim(w, PMIN_W, panelMax().w); }
function clampPanelH(h) { return clampPanelDim(h, PMIN_H, panelMax().h); }

function applyPanelSize() {
  const st = document.documentElement.style;
  const custom = state.settings.panelW > 0 && state.settings.panelH > 0;
  if (custom) {
    st.setProperty('--panel-w', clampPanelW(state.settings.panelW) + 'px');
    st.setProperty('--panel-h', clampPanelH(state.settings.panelH) + 'px');
  } else {
    st.removeProperty('--panel-w');
    st.removeProperty('--panel-h');
  }
  syncNarrow();
  scheduleTabFit();   // the bar's tab budget follows the window width
}

/* Re-fit the tab bar shortly after a size change. Debounced: a grip drag
   calls applyPanelSize every mousemove, and the fit loop repaints the bar. */
let tabFitT = null;
function scheduleTabFit() {
  if (tabFitT) clearTimeout(tabFitT);
  tabFitT = setTimeout(() => { tabFitT = null; renderTabs(); }, 120);
}

/* `body.panel-narrow` = the DECK WINDOW is narrow, in layout px. In-game the
 * viewport is the whole screen, so `@media (max-width: …)` can never see a
 * grip-resized panel — panes that want a denser layout at small deck sizes
 * scope those rules under this class (and keep the media query for the
 * browser harnesses / phone). Measured on the panel's layout box, so uiScale
 * (a transform) doesn't distort it. Threshold sits just above the 640px
 * panel floor. */
function syncNarrow() {
  const p = $('panel');
  if (!p || !p.offsetWidth) return;   // closed deck measures 0 — keep the last truth
  document.body.classList.toggle('panel-narrow', p.offsetWidth <= 720);
}
window.hdSyncNarrow = syncNarrow;
window.addEventListener('resize', syncNarrow);
function setPanelSize(w, h) {
  state.settings.panelW = clampPanelW(w);
  state.settings.panelH = clampPanelH(h);
  applyPanelSize();
  saveSoon();
}
function resetPanelSize() {
  if (!state.settings.panelW && !state.settings.panelH) { applyPanelSize(); return; }
  state.settings.panelW = 0; state.settings.panelH = 0;
  applyPanelSize();
  saveSoon();
  toast('Panel size reset');
}

/* corner grip — the panel is centred, so half of any growth goes to each
 * side: 1 screen-px of corner travel grows the layout box 2px / uiScale. */
let gripDrag = null;
function gripDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const r = $('panel').getBoundingClientRect();   // on-screen (already scaled)
  gripDrag = {
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    offX: e.clientX - r.right, offY: e.clientY - r.bottom,
  };
  document.body.classList.add('resizing');
  document.addEventListener('mousemove', gripMove, true);
  document.addEventListener('mouseup', gripUp, true);
}
function gripMove(e) {
  if (!gripDrag) return;
  e.preventDefault();
  const s = clampScale(state.settings.uiScale);
  /* the Favorites wing widens #panel by its own width (hd-shelf.css); the
     DRAGGED size must stay the deck's, or every drag with the shelf out
     would bake the wing in and grow the saved width by 64/348px */
  const wing = (window.HDShelf && HDShelf.wingWidth) ? HDShelf.wingWidth() : 0;
  setPanelSize(2 * ((e.clientX - gripDrag.offX) - gripDrag.cx) / s - wing,
               2 * ((e.clientY - gripDrag.offY) - gripDrag.cy) / s);
}
function gripUp() {
  if (!gripDrag) return;
  gripDrag = null;
  document.body.classList.remove('resizing');
  document.removeEventListener('mousemove', gripMove, true);
  document.removeEventListener('mouseup', gripUp, true);
}

const ui = {
  visible: false,
  /* 'all' | 'cat:<name>' (both = the Hotkeys tab, one deck pane)
     | 'quests' | 'followers' | 'domains' | 'notes' | 'numpad' */
  tab: 'all',
  hkTab: 'all',          // last hotkey sub-tab — what the "Hotkeys" top button returns to
  edit: false,
  search: '',
  sel: 0,
  capture: null,       // { mode: 'entry'|'open'|'add', id }
  confirmDelete: null, // entry id pending delete confirmation
  npMods: [],          // active numpad modifier DIKs
  tabAdding: false,        // "+ Tab" inline input open
  tabRename: null,         // category currently being renamed
  confirmTabDelete: null,  // category pending delete confirmation
  moreOpen: false,         // the "More ▾" overflow menu is open
  moreFilter: '',          // its filter-as-you-type text
  moreStyleOpen: false,    // the "Tab style" section is expanded (collapsed by default)
  drag: null,              // { id, moved, over: {id, before} } while dragging a row
  justDragged: false,      // swallow the click that follows a drop
  /* ---- quests tab ---- */
  qMode: 'npc',            // 'npc' (crosshair NPC) | 'search' (all quests)
  qSearch: '',
  qList: null,             // last hdQuests payload
  qNpc: null,              // { name, formId, plugin } of the targeted NPC
  qDetail: null,           // open quest detail payload
  qLoading: false,
  qConfirmStage: null,     // stage index pending a "go backwards?" confirm
  qNote: '',               // last result message from C++
};

let saveTimer = null;
let toastTimer = null;

/* $ helpers */
const $ = (id) => document.getElementById(id);

/* Element builder for the icon picker's tile grid (the rest of this view emits
   HTML strings). Named hEl, NOT h: followers-pane.js and domains-pane.js each
   define their own IIFE-local `h`, and a top-level global of that name would
   sit confusingly alongside three different implementations. */
function hEl(tag, attrs) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'data') { for (const d in v) e.dataset[d] = v[d]; }
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (let i = 2; i < arguments.length; i++) {
    const kid = arguments[i];
    if (kid == null || kid === false) continue;
    (Array.isArray(kid) ? kid : [kid]).forEach((c) => {
      if (c == null || c === false) return;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }
  return e;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function chordLabel(mods, keyLabel) {
  const parts = (mods || []).map((m) => MOD_LABEL[m] || '?');
  parts.push(keyLabel);
  return parts.join(' + ');
}

function newId() {
  return 'hk-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/* --- per-entry TRIGGER key -------------------------------------------------
 * A trigger fires the entry from anywhere with the palette CLOSED, so you can
 * click a row today and bind it to a key tomorrow without the two competing.
 * The chip is the whole UI: it shows the bound key in view mode (so you can
 * see what fires what without entering edit), and becomes a button plus a
 * clear-✕ in edit mode. C++ reads/writes it as entry.trigger; a malformed one
 * is dropped there rather than kept half-bound. */
function trigOf(e) {
  const t = e && e.trigger;
  if (!t || !t.code || (t.device !== 'keyboard' && t.device !== 'mouse')) return null;
  return t;
}

function trigChipLabel(t) {
  return chordLabel(t.device === 'keyboard' ? t.mods : [], t.label || ('#' + t.code));
}

function trigChipHtml(e, edit) {
  const t = trigOf(e);
  if (!edit) {
    // View mode: a quiet read-only badge, and only when there IS one.
    if (!t) return '';
    // A long chord ellipsizes, so the full text has to live in the tooltip too.
    return '<span class="trigchip" title="' +
      esc(trigChipLabel(t) + ' — fires this from anywhere with the deck closed') + '">⚡ ' +
      esc(trigChipLabel(t)) + '</span>';
  }
  const lbl = t ? '⚡ ' + trigChipLabel(t) : '⚡ Set…';
  const title = t
    ? 'Fires this from anywhere with the deck closed. Click to rebind.'
    : 'Click, then press a key to fire this from anywhere with the deck closed';
  return '<span class="trigwrap">' +
    '<button class="trigchip trig-btn' + (t ? '' : ' unset') + '" title="' + esc(title) + '">' +
    esc(lbl) + '</button>' +
    (t ? '<button class="mini-x trig-clear" title="Remove trigger key">✕</button>' : '') +
    '</span>';
}

/* ========================================================== rendering ==== */

/* ===================== the deck's own actions ========================== *
 *  Entries with device:"action" call C++ straight out instead of synthesizing
 *  a keystroke. The verbs MUST match the C++ IsAction() sets, which are the
 *  only authority: SaveActions::IsAction (save_actions.cpp),
 *  PortraitCapture::IsAction (portrait_capture.cpp) and NpcActions::IsAction
 *  (npc_actions.cpp). A verb listed here that C++ does not know simply does
 *  nothing when fired, so keep the two in step.
 * ======================================================================== */
const DECK_ACTIONS = [
  { action: 'full-save', name: 'Full Save', label: 'Save',
    desc: 'A real save file — not the quicksave slot' },
  { action: 'portrait', name: 'Capture Portrait', label: 'Portrait',
    desc: 'Photograph the NPC you are looking at' },
  { action: 'freeze', name: 'Freeze NPC', label: 'Freeze',
    desc: 'Hold the targeted NPC in place (toggle)' },
  { action: 'sit', name: 'Sit NPC', label: 'Sit',
    desc: 'Send them to the nearest chair, or the ground' },
  { action: 'bed', name: 'Bed NPC', label: 'Bed',
    desc: 'Send them to the nearest bed, or the ground' },
  { action: 'release-all', name: 'Release All NPCs', label: 'Release',
    desc: 'Free everyone being held' },
];

function activeCategory() {
  return ui.tab.indexOf('cat:') === 0 ? ui.tab.slice(4) : null;
}

/* 'all' and every 'cat:<name>' are the SAME pane (the hotkey deck) — the top
   nav shows one "Hotkeys" tab for the pair and moves the categories to row 2. */
function isHotkeyTab(t) {
  const x = String(t === undefined ? ui.tab : t);
  return x === 'all' || x.indexOf('cat:') === 0;
}

/* what the Hotkeys button points at, validated: a category can disappear
   underneath ui.hkTab (config reload, another session's rename). */
function hkTabToken() {
  const t = ui.hkTab;
  if (isHotkeyTab(t) && (t === 'all' || state.categories.indexOf(t.slice(4)) !== -1)) return t;
  return 'all';
}

function filteredEntries() {
  const cat = activeCategory();
  let items = state.entries.slice();
  if (cat !== null) items = items.filter((e) => (e.category || '') === cat);
  /* Hide integrations whose mod isn't installed — but only OUTSIDE edit mode, so
     the owner can still see/manage them (greyed, with the reason) in Edit. */
  if (!ui.edit) items = items.filter((e) => !hkNeeds(e));
  const q = ui.search.trim().toLowerCase();
  if (!q) return items;
  return items.filter((e) =>
    (e.name || '').toLowerCase().indexOf(q) !== -1 ||
    (e.desc || '').toLowerCase().indexOf(q) !== -1 ||
    (e.label || '').toLowerCase().indexOf(q) !== -1);
}

function tabOrder() {
  return ['all'].concat(state.categories.map((c) => 'cat:' + c), ['quests', 'followers', 'domains', 'containers', 'time', 'notes', 'numpad']);
}

function highlight(text, q) {
  const t = String(text == null ? '' : text);
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}

function render() {
  const pane = (ui.tab === 'home' || ui.tab === 'numpad' || ui.tab === 'notes' || ui.tab === 'quests' ||
                ui.tab === 'followers' || ui.tab === 'domains' || ui.tab === 'containers' || ui.tab === 'finances' ||
                ui.tab === 'rooms' || ui.tab === 'time' || ui.tab === 'loot' ||
                ui.tab === 'anim' || ui.tab === 'keys' ||
                ui.tab === 'wardrobe' || ui.tab === 'faces' || ui.tab === 'recent') ? ui.tab : 'deck';
  const deck = pane === 'deck';
  window.__hdActiveTab = pane;   // panes (followers/domains) key their re-renders off this
  $('deck-pane').classList.toggle('hidden', !deck);
  $('numpad-pane').classList.toggle('hidden', pane !== 'numpad');
  $('hm-pane').classList.toggle('hidden', pane !== 'home');
  $('recent-pane').classList.toggle('hidden', pane !== 'recent');
  $('notes-pane').classList.toggle('hidden', pane !== 'notes');
  $('quests-pane').classList.toggle('hidden', pane !== 'quests');
  $('fol-pane').classList.toggle('hidden', pane !== 'followers');
  $('dm-pane').classList.toggle('hidden', pane !== 'domains');
  $('ct-pane').classList.toggle('hidden', pane !== 'containers');
  $('rm-pane').classList.toggle('hidden', pane !== 'rooms');
  $('lt-pane').classList.toggle('hidden', pane !== 'loot');
  $('an-pane').classList.toggle('hidden', pane !== 'anim');
  $('kc-pane').classList.toggle('hidden', pane !== 'keys');
  $('fin-pane').classList.toggle('hidden', pane !== 'finances');
  $('wd-pane').classList.toggle('hidden', pane !== 'wardrobe');
  $('faces-pane').classList.toggle('hidden', pane !== 'faces');
  $('tm-pane').classList.toggle('hidden', pane !== 'time');
  renderTabs();

  $('count-chip').textContent = state.entries.length + ' hotkeys';
  /* Home owns its OWN edit mode (reorder the system cards) — it never flips
     ui.edit, so reflect ITS flag onto the Edit button so it lights up on Home
     too (home-card-reorder). */
  const homeEditing = pane === 'home' && window.HomePane && HomePane.isEditing && HomePane.isEditing();
  $('edit-btn').classList.toggle('on', ui.edit || !!homeEditing);
  document.body.classList.toggle('hd-editing', !!ui.edit);   // the #hints legend shows only in edit mode now
  $('edit-btn').textContent = 'Edit';
  $('settings-card').classList.toggle('hidden', !(deck && ui.edit));
  renderSettingsFold();
  $('add-row').classList.toggle('hidden', !(deck && ui.edit));
  renderTabScaleCard(pane);

  if (deck) renderList();
  syncQuickFollowerCard(deck);
  syncQuickLightCard(deck);
  if (pane === 'recent') renderRecent();
  if (pane === 'notes') renderNotes();
  if (pane === 'quests') renderQuests();
  if (pane === 'followers' && window.FolPane) FolPane.syncChrome();  // owns chip + Edit label while up
  renderHints(pane);
  renderSettings();
}

/* ============== the shared per-tab size card (edit mode) =============== *
 *  Quests, Notes, Numpad, Recent and Time have no settings UI of their own —
 *  toggleEdit() routes Followers/Domains/Rooms/Finances/Wardrobe into THEIR
 *  panes and otherwise just flips ui.edit, which until now lit up nothing at
 *  all on these five. So Edit/F2 on one of them now reveals this one card,
 *  repointed at whichever tab is up.
 *
 *  Deliberately not extended to the panes that own an edit strip: a size
 *  control belongs beside that tab's other settings, not in a second card
 *  floating above it, and those panes never flip ui.edit anyway.
 */
const TAB_SCALE_CARD_TABS = ['quests', 'notes', 'numpad', 'recent', 'time', 'loot', 'anim'];

function renderTabScaleCard(pane) {
  const card = $('tab-scale-card');
  if (!card) return;
  const show = !!ui.edit && TAB_SCALE_CARD_TABS.indexOf(pane) !== -1 &&
               !!window.HDScale && HDScale.has(pane);
  card.classList.toggle('hidden', !show);
  if (!show) { card.removeAttribute('data-for'); return; }
  /* Re-mount only when the tab actually changed. render() runs on every
     keystroke and re-writing the innerHTML each time would drop the focus
     ring off a button mid-press. */
  if (card.getAttribute('data-for') !== pane) {
    card.setAttribute('data-for', pane);
    const t = $('tsc-title');
    if (t) t.textContent = (HDScale.SPEC[pane] && HDScale.SPEC[pane].label ? HDScale.SPEC[pane].label : pane) + ' size';
    HDScale.mount($('tsc-body'), pane);
  } else {
    HDScale.sync(pane);
  }
}

/* ============ quick-follower card, above the hotkey list =============== *
 *  Recruit / Dismiss / Open-inventory for the crosshair NPC, shown only
 *  while the Hotkeys tab's **Followers CATEGORY** is selected — beside the
 *  follower hotkeys it belongs with (Follower Control (NFF), Teleport,
 *  Abduction-Add-Follower).
 *
 *  app.js decides only WHETHER to show it. The card itself is built by
 *  followers-pane.js, which already owns the fdNpc / fdEquipped bridge, the
 *  crosshair snapshot and the guarded-NPC confirm — so there is exactly one
 *  implementation and the Hotkeys card and the Followers tab can never
 *  disagree about who is targeted.
 *
 *  Category matched by NAME, case-insensitively: the category is Rober's own,
 *  editable, and hard-coding an index would break the moment it is reordered.
 *  Rename it to something without "follower" in it and the card simply stops
 *  appearing — no error, nothing else affected.
 */
function isFollowerCategory(cat) {
  return typeof cat === 'string' && /follower/i.test(cat);
}

/* ============ quick Quick-Light card, above the hotkey list =========== *
 *  A live On/Off control for Quick Light SE, shown only while the Hotkeys
 *  tab's **Utilities CATEGORY** is selected — beside the "Quick Light" action
 *  row (and any other utility hotkeys) it belongs with. Same deal as the
 *  quick-follower card: app.js decides only WHETHER to show it; light-pane.js
 *  owns the ql* bridge, the live state and the buttons, so there is one
 *  implementation. Rename the category away from "util" and it simply stops
 *  appearing — no error. */
function isUtilityCategory(cat) {
  return typeof cat === 'string' && /util/i.test(cat);
}

function syncQuickLightCard(deck) {
  const host = $('ql-card');
  if (!host) return;
  const show = !!deck && !ui.edit && isUtilityCategory(activeCategory());
  host.classList.toggle('hidden', !show);
  if (!window.LightPane) return;
  if (show) { LightPane.mountCard(host); return; }
  LightPane.unmountCard(host);
}

function syncQuickFollowerCard(deck) {
  const host = $('fq-card');
  if (!host) return;
  const show = !!deck && !ui.edit && isFollowerCategory(activeCategory());
  host.classList.toggle('hidden', !show);
  if (!window.FolPane) return;
  if (show) { FolPane.mountQuickCard(host); return; }
  /* Only tear down OUR copy. The Followers tab mounts the same single card
     into its own host, and this function runs on every deck render — including
     the ones that happen while that tab is up. Unconditionally unmounting here
     is how the card would vanish from the Followers tab on the next repaint. */
  if (!FolPane.quickHostIs || FolPane.quickHostIs(host)) {
    FolPane.unmountQuickCard();
    host.textContent = '';
  }
}

/* ============================ Recent ================================== *
 *  A plain reverse-chronological list of what has actually been fired: the
 *  deck's own rows, the Numpad tab's chords, and quick-fires — which are the
 *  interesting ones, because a quick-fire skips the palette entirely and
 *  otherwise leaves no trace anywhere in the UI.
 *
 *  Deliberately a LIST and nothing else. The value is answering "what did I
 *  just press" and "do I ever use this row" at a glance; a chart or a filter
 *  box would be more to build and less to read.
 * ====================================================================== */
let recent = { items: [], count: 0, max: 0, sinceLaunch: true, asked: false };

const RC_SOURCE = {
  entry:     { ic: '⌨', what: 'hotkey' },
  action:    { ic: '⚡', what: 'deck action' },
  numpad:    { ic: '⌗', what: 'numpad' },
  quickfire: { ic: '⚡', what: 'quick-fire — skipped the palette' },
};

function renderRecent() {
  const list = $('rc-list');
  const empty = $('rc-empty');
  const items = recent.items || [];

  $('rc-count').textContent = items.length
    ? items.length + (items.length === recent.max ? ' (oldest dropped)' : '')
    : '';
  empty.classList.toggle('hidden', items.length > 0);
  $('rc-clear').classList.toggle('hidden', items.length === 0);

  if (!items.length) { list.innerHTML = ''; return; }

  list.innerHTML = items.map((it) => {
    const src = RC_SOURCE[it.source] || RC_SOURCE.entry;
    return '<div class="rc-row" title="' + esc(src.what) + '">' +
      '<span class="rc-ic" aria-hidden="true">' + src.ic + '</span>' +
      '<div class="rc-main">' +
        '<div class="rc-name">' + esc(it.name || '(unnamed)') +
          (it.times > 1 ? '<span class="rc-times">×' + (it.times >>> 0) + '</span>' : '') +
        '</div>' +
        (it.category ? '<div class="rc-cat">' + esc(it.category) + '</div>' : '') +
      '</div>' +
      (it.label ? '<span class="keychip rc-key">' + esc(it.label) + '</span>' : '') +
      '<span class="rc-ago" title="' + esc(it.at || '') + '">' + esc(it.ago || '') + '</span>' +
    '</div>';
  }).join('');
}

/* C++ -> view. Listener-free: pushed at palette open and after every ask, so
   the tab is already populated the moment you switch to it. */
window.hdRecent = function (payload) {
  let d = payload;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
  if (!d || typeof d !== 'object') return;
  recent = {
    items: Array.isArray(d.items) ? d.items : [],
    count: d.count >>> 0,
    max: d.max >>> 0,
    sinceLaunch: d.sinceLaunch !== false,
    asked: true,
  };
  if (ui.tab === 'recent') renderRecent();
  /* Recent now also lives as a drawer on the Home page — feed it the same
     payload so the fold-out list and its count stay live without a 2nd bridge. */
  if (window.HomePane) HomePane.receiveRecent(d);
};

/* Pick one of the deck's own actions and drop it into the tab you are on. It
   lands unbound, exactly like +Add hotkey does, so the very next thing that
   happens is the key-capture dialog — which is the point: this is how the Mod
   Arch save key gets replaced by one of ours. */
let actionPickerEl = null;
function closeActionPicker() {
  if (!actionPickerEl) return;
  actionPickerEl.remove();
  actionPickerEl = null;
  document.removeEventListener('mousedown', actionPickerOutside, true);
}
function actionPickerOutside(e) {
  if (actionPickerEl && !actionPickerEl.contains(e.target)) closeActionPicker();
}
function openActionPicker(anchor) {
  closeActionPicker();
  const taken = {};
  state.entries.forEach((en) => { if (en.device === 'action' && en.action) taken[en.action] = true; });

  const box = document.createElement('div');
  box.id = 'action-picker';
  box.innerHTML = '<div class="ap-head">Deck actions</div>' +
    DECK_ACTIONS.map((a) =>
      '<button class="ap-item" data-action="' + esc(a.action) + '"' +
      (taken[a.action] ? ' data-dupe="1"' : '') + '>' +
        '<span class="ap-name">' + esc(a.name) + '</span>' +
        '<span class="ap-desc">' + esc(a.desc) + '</span>' +
        (taken[a.action] ? '<span class="ap-have">already added</span>' : '') +
      '</button>').join('');
  document.body.append(box);

  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, hgt = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  // above the button when there is no room below — the add row sits at the
  // bottom of the pane, so below is usually exactly where there is none
  box.style.top = (r.top - hgt - 6 >= 8 ? r.top - hgt - 6 : Math.min(r.bottom + 6, innerHeight - hgt - 8)) + 'px';

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.ap-item');
    if (!btn) return;
    const spec = DECK_ACTIONS.filter((a) => a.action === btn.dataset.action)[0];
    closeActionPicker();
    if (!spec) return;
    const id = newId();
    state.entries.push({ id: id, name: spec.name, desc: spec.desc,
      device: 'action', code: 0, label: spec.label, mods: [], action: spec.action,
      icon: '', category: activeCategory() || '' });
    save();
    render();
    /* Straight into key capture: an action you cannot fire is not much use,
       and binding it is the whole reason you added it. */
    startCapture('add', id);
  });
  setTimeout(() => document.addEventListener('mousedown', actionPickerOutside, true), 0);
  actionPickerEl = box;
}

/* ==================================== VirtualKey picker (Nexus 187350) ==== *
 * VirtualKey gives MCM hotkeys a virtual-key range (100000..9999999) so a mod's
 * KeyMap can be bound without eating a real key. A device:"vkey" deck entry then
 * fires that virtual key through the C++ side's native InputEvent dispatch
 * (VKey::Fire) — a virtual key has no scancode, so a normal keystroke entry could
 * never reach it. This picker lets you choose one of VirtualKey's discovered
 * bindings BY NAME (its Bindings.json catalog, served over the vkCatalog bridge),
 * or type a virtual key by hand, pick Tap/Down/Up, Test it, and drop it on the
 * deck. An absent/empty catalog is never a dead end — manual entry always works.
 */
let vkPickerEl = null;
let vkPickerCtx = null;               // { entry|null, verb }
ui.vkCatalog = ('vkCatalog' in ui) ? ui.vkCatalog : null;   // cached once the bridge replies

window.vkCatalogData = function (payload) {
  try { ui.vkCatalog = Array.isArray(payload) ? payload : JSON.parse(payload || '[]'); }
  catch (e) { ui.vkCatalog = []; }
  if (vkPickerEl) vkRenderList();
};

function closeVKeyPicker() {
  if (!vkPickerEl) return;
  vkPickerEl.remove();
  vkPickerEl = null;
  vkPickerCtx = null;
  document.removeEventListener('keydown', vkPickerKeydown, true);
}

function vkPickerKeydown(e) {
  if (!vkPickerEl) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeVKeyPicker(); return; }
  if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('vk-search')) {
    const top = vkPickerEl.querySelector('.vk-item');
    if (top) { e.preventDefault(); e.stopPropagation(); top.click(); }
  }
}

function vkCurrentKey() {
  const n = vkPickerEl && vkPickerEl.querySelector('.vk-num');
  const v = n ? parseInt(String(n.value).replace(/[^0-9]/g, ''), 10) : NaN;
  return isFinite(v) ? v : NaN;
}

function vkRenderList() {
  const listEl = vkPickerEl && vkPickerEl.querySelector('.vk-list');
  if (!listEl) return;
  const cat = ui.vkCatalog;
  if (cat === null) { listEl.innerHTML = '<div class="vk-empty">Loading your VirtualKey bindings…</div>'; return; }
  if (!cat.length) {
    listEl.innerHTML = '<div class="vk-empty">No VirtualKey bindings discovered yet. In-game: open VirtualKey (F10), bind a mod’s MCM hotkey to a [VKnnn], then reopen that MCM page — it shows up here. Or type a key by hand below.</div>';
    return;
  }
  const q = (vkPickerEl.querySelector('.vk-search').value || '').trim().toLowerCase();
  const rows = cat.filter((b) => !q ||
    (b.label + ' ' + b.mod + ' ' + b.page + ' vk' + b.key + ' ' + b.key).toLowerCase().indexOf(q) !== -1);
  if (!rows.length) { listEl.innerHTML = '<div class="vk-empty">No binding matches “' + esc(q) + '”. Type a virtual key by hand below.</div>'; return; }
  listEl.innerHTML = rows.map((b) => {
    const warn = b.verification && b.verification !== 'verified' && b.verification !== 'user_confirmed';
    return '<button class="vk-item" data-key="' + b.key + '" data-label="' + esc(b.label || '') + '">' +
      '<span class="vk-i-name">' + highlight(b.label || ('VK' + b.key), q) + '</span>' +
      '<span class="vk-i-sub">' + esc(b.mod || '—') + (b.page ? ' · ' + esc(b.page) : '') + ' · VK' + b.key + '</span>' +
      (warn ? '<span class="vk-i-warn" title="VirtualKey flagged this binding unconfirmed — Test it">⚠</span>' : '') +
      '</button>';
  }).join('');
}

function vkSetVerb(verb) {
  if (!vkPickerCtx) return;
  vkPickerCtx.verb = verb;
  vkPickerEl.querySelectorAll('.vk-verb button').forEach((b) => b.classList.toggle('on', b.dataset.verb === verb));
}

/* anchor is unused (the picker is a centered modal), kept for call-site symmetry
   with openActionPicker. editEntry non-null => editing an existing vkey entry. */
function openVKeyPicker(anchor, editEntry) {
  closeActionPicker();
  closeVKeyPicker();
  vkPickerCtx = { entry: editEntry || null, verb: (editEntry && editEntry.action) || 'tap' };

  const box = document.createElement('div');
  box.id = 'vkey-picker-backdrop';
  box.innerHTML =
    '<div id="vkey-picker" role="dialog">' +
      '<div class="vk-head">✦ VirtualKey' +
        '<span class="vk-sub">' + (editEntry ? 'change this button’s MCM binding' : 'fire an MCM hotkey with no physical key') + '</span>' +
        '<button class="vk-x" title="Close">✕</button></div>' +
      '<input class="vk-search" placeholder="Search your VirtualKey bindings…" spellcheck="false">' +
      '<div class="vk-list"></div>' +
      '<div class="vk-manual">' +
        '<div class="vk-manual-h">…or enter a virtual key by hand</div>' +
        '<div class="vk-manual-row">' +
          '<input class="vk-num" inputmode="numeric" placeholder="100003" value="' + (editEntry ? esc(String(editEntry.code)) : '') + '">' +
          '<input class="vk-name" placeholder="Button name (e.g. Target Lock)" value="' + (editEntry ? esc(editEntry.name) : '') + '">' +
        '</div>' +
      '</div>' +
      '<div class="vk-verb"><span class="vk-verb-l">When fired:</span>' +
        '<button data-verb="tap">Tap</button><button data-verb="down">Hold down</button><button data-verb="up">Release</button></div>' +
      '<div class="vk-foot">' +
        '<button class="vk-test">▶ Test</button>' +
        '<button class="vk-add">' + (editEntry ? 'Save' : '＋ Add to deck') + '</button>' +
      '</div>' +
    '</div>';
  document.body.append(box);
  vkPickerEl = box;
  vkSetVerb(vkPickerCtx.verb);
  vkRenderList();
  toGame('vkCatalog');   // always refresh — bindings change between visits

  const search = box.querySelector('.vk-search');
  search.addEventListener('input', vkRenderList);
  setTimeout(() => search.focus(), 0);

  box.querySelector('.vk-list').addEventListener('click', (e) => {
    const it = e.target.closest('.vk-item');
    if (!it) return;
    box.querySelector('.vk-num').value = it.dataset.key;
    const nameI = box.querySelector('.vk-name');
    if (!nameI.value.trim()) nameI.value = it.dataset.label || ('VK' + it.dataset.key);
    box.querySelectorAll('.vk-item').forEach((x) => x.classList.remove('sel'));
    it.classList.add('sel');
  });

  box.querySelector('.vk-verb').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-verb]');
    if (b) vkSetVerb(b.dataset.verb);
  });

  box.querySelector('.vk-test').addEventListener('click', () => {
    const key = vkCurrentKey();
    if (!(key >= 100000 && key <= 9999999)) { toast('Enter a virtual key 100000–9999999'); return; }
    toGame('vkTest', JSON.stringify({ code: key, verb: vkPickerCtx.verb }));
    toast('Tested VK' + key);
  });

  box.querySelector('.vk-add').addEventListener('click', () => {
    const key = vkCurrentKey();
    if (!(key >= 100000 && key <= 9999999)) { toast('Enter a virtual key 100000–9999999'); return; }
    const name = (box.querySelector('.vk-name').value || '').trim() || ('VirtualKey ' + key);
    const verb = vkPickerCtx.verb;
    const editing = !!vkPickerCtx.entry;
    if (editing) {
      const en = vkPickerCtx.entry;
      en.device = 'vkey'; en.code = key; en.action = verb; en.name = name; en.mods = [];
    } else {
      state.entries.push({ id: newId(), name: name, desc: '', device: 'vkey', code: key,
        action: verb, label: 'VK' + key, mods: [], icon: '', category: activeCategory() || '' });
    }
    closeVKeyPicker();
    save();
    render();
    toast((editing ? 'Saved ' : 'Added ') + name);
  });

  box.querySelector('.vk-x').addEventListener('click', closeVKeyPicker);
  box.addEventListener('mousedown', (e) => { if (e.target === box) closeVKeyPicker(); });
  document.addEventListener('keydown', vkPickerKeydown, true);
}

/* The footer legend is per-pane — "Enter fire / 1–9,0 quick-fire" is a lie on
   the Quests tab, where nothing is bound to those keys. */
let defaultHints = null;

function renderHints(pane) {
  const h = $('hints');
  if (!h) return;
  if (defaultHints === null) defaultHints = h.innerHTML;
  if (pane === 'followers') {
    h.innerHTML = '<span>Click a follower for actions</span><span>drag onto a category to move</span>' +
      '<span>F2 edit categories</span><span>F14 toggles this tab</span><span>F7 / Esc close</span>';
    return;
  }
  if (pane === 'domains') {
    h.innerHTML = '<span>↑↓ select</span><span>Enter menu</span><span>click a domain to travel</span>' +
      '<span>drag onto a category</span><span>F2 edit</span><span>F15 toggles this tab</span><span>F7 / Esc close</span>';
    return;
  }
  if (pane === 'wardrobe') {
    if (window.WardrobePane) WardrobePane.init();
    return;
  }
  if (pane === 'finances') {
    h.innerHTML = '<span>[ ] switch section</span><span>right-click a row to edit</span>' +
      '<span>Buy/Sell moves gold</span><span>Settle once a month</span><span>F2 edit</span><span>F7 / Esc close</span>';
    return;
  }
  if (pane === 'loot') {
    h.innerHTML = '<span>Big button toggles every glow</span><span>click a dot to recolour</span>' +
      '<span>bind “Loot Vision” (Misc) to a key</span><span>F7 / Esc close</span>';
    return;
  }
  if (pane === 'anim') {
    h.innerHTML = '<span>Search, then Apply (Enter = top hit)</span><span>plays on who you looked at, or you</span>' +
      '<span>Reset returns the pose</span><span>F7 / Esc close</span>';
    return;
  }
  if (pane !== 'quests') { h.innerHTML = defaultHints; return; }
  h.innerHTML = ui.qDetail
    ? '<span>Click a stage to fire it</span><span>Esc back to list</span><span>Tab switch pane</span><span>F7 close</span>'
    : '<span>Click a quest</span><span>Alias empty? try Search all quests</span><span>Tab switch pane</span><span>F7 / Esc close</span>';
}

function renderNotes() {
  const ta = $('notes-ta');
  if (document.activeElement !== ta) ta.value = state.notes || '';
}

/* Two rows.
   ROW 1 (#tabs)    — Home | Hotkeys | Spells ↗ ‖ Quests | Followers | More ▾
   ROW 2 (#hk-tabs) — All + the user's categories (+ edit tools), only while a
                      hotkey tab is active.
   "Hotkeys" carries a plain data-tab (= ui.hkTab), so onTabsClick's existing
   `.tab[data-tab]` branch routes it through setTab with no handler changes, and
   setTab's own `ui.tab === t` no-op makes re-clicking it free. "Spells" carries
   data-act instead of data-tab, so it can never take .active. */

/* The overflow systems, behind the "More ▾" button (Rober, 2026-08-05). A flat,
   ordered list — the menu filters it as you type and Enter takes the top hit
   (the deck's standing search idiom). Add a new system here and it appears in
   the menu with zero other edits. */
/* Every promotable SYSTEM tab, in canonical order. The fixed trio (Home ·
   Hotkeys · Spells↗) keeps its slots; everything here competes for the rest
   of the row by USAGE (Rober, 2026-08-07: "order them so the ones we use the
   most show as full text / others auto compact into a dropdown"). The `img`
   is the same gold glyph the Home card wears, for the icons-only tab style. */
const SYS_TABS = [
  { tab: 'quests',     label: 'Quests',     img: 'icons/custom/hm-quests.png',     title: 'Inspect & repair any quest' },
  { tab: 'followers',  label: 'Followers',  img: 'icons/custom/hm-followers.png',  title: 'Summon, order, dress' },
  { tab: 'domains',    label: 'Domains',    img: 'icons/custom/hm-domains.png',    title: 'Mark a place and travel back to it' },
  { tab: 'containers', label: 'Containers', img: 'icons/custom/hm-containers.png', title: 'Mark a container and open it from anywhere' },
  { tab: 'rooms',      label: 'Rooms',      img: 'icons/custom/hm-rooms.png',      title: 'Claim a room and keep strangers out of it' },
  { tab: 'loot',       label: 'Loot',       img: 'icons/custom/hm-loot.png',       title: 'Glow the loot worth walking to' },
  { tab: 'keys',       label: 'Keys',       img: 'icons/custom/hm-keys.png',       title: 'Every hotkey in the load order, and what conflicts' },
  { tab: 'anim',       label: 'Animations', img: 'icons/custom/hm-anim.png',       title: 'Apply a pose / animation to an NPC or yourself' },
  { tab: 'finances',   label: 'Finances',   img: 'icons/custom/hm-finances.png',   title: 'Your ledger, properties and market' },
  { tab: 'wardrobe',   label: 'Wardrobe',   img: 'icons/custom/hm-wardrobe.png',   title: 'Outfits, wardrobes and NPC dressing' },
  { tab: 'faces',      label: 'Faces',      img: 'icons/custom/hm-faces.png',      title: 'Browse RaceMenu presets and apply a face' },
];

/* ⚠ Tab-bar prefs PERSIST INSIDE THE SHELF BLOB (state.shelf.tabbar).
   C++ parses `settings` field-by-field (main.cpp SettingsToJson / the value()
   walk), so a brand-new settings key would be silently DROPPED on the next
   save round-trip — but the shelf slice travels as a RAW json object
   (main.cpp keeps keys it has never heard of, 256KB cap), and hd-shelf.js's
   sanitizer only touches its own keys. Promote these to real Settings fields
   at the next DLL bump; until then this is the one store that survives
   without a rebuild. Shape: { style:'text'|'icons', use:{tab:count} }. */
function tabbarPrefs() {
  if (!state.shelf || typeof state.shelf !== 'object' || Array.isArray(state.shelf)) state.shelf = {};
  let tb = state.shelf.tabbar;
  if (!tb || typeof tb !== 'object' || Array.isArray(tb)) tb = state.shelf.tabbar = {};
  if (tb.style !== 'icons') tb.style = 'text';
  if (!tb.use || typeof tb.use !== 'object' || Array.isArray(tb.use)) tb.use = {};
  return tb;
}

/* Home page prefs, in the SAME shelf blob and for the SAME reason as
   tabbarPrefs() (state.shelf.home). Shape: { order: string[] } — the system
   cards in the order the user dragged them. Sanitised on READ by home-pane.js
   (unknown ids dropped, missing systems appended), so this only guarantees the
   slot exists and `order` is an array. home-card-reorder */
function homePrefs() {
  if (!state.shelf || typeof state.shelf !== 'object' || Array.isArray(state.shelf)) state.shelf = {};
  let hm = state.shelf.home;
  if (!hm || typeof hm !== 'object' || Array.isArray(hm)) hm = state.shelf.home = {};
  if (!Array.isArray(hm.order)) hm.order = [];
  return hm;
}

function bumpTabUse(t) {
  if (!SYS_TABS.some((s) => s.tab === t)) return;   // fixed trio / hk cats don't compete
  const tb = tabbarPrefs();
  tb.use[t] = (Number(tb.use[t]) || 0) + 1;
  /* renormalize instead of capping: halving keeps the RATIOS, so an old
     favourite still outranks a new tab without counts growing forever */
  if (tb.use[t] > 900)
    Object.keys(tb.use).forEach((k) => { tb.use[k] = Math.max(1, Math.floor((Number(tb.use[k]) || 0) / 2)); });
  saveSoon();
}

/* usage order, canonical order breaking ties — an untouched deck reads
   exactly like the old fixed bar (Quests · Followers first). Counts rank in
   steps of 3 (floor(count/3)): without the hysteresis a single visit
   promoted a tab to the front of the bar, so the row reshuffled under the
   cursor on every click into the More menu. */
function sysOrder() {
  const use = tabbarPrefs().use;
  const eff = (t) => Math.floor((Number(use[t]) || 0) / 3);
  return SYS_TABS.slice().sort((a, b) =>
    eff(b.tab) - eff(a.tab) ||
    SYS_TABS.indexOf(a) - SYS_TABS.indexOf(b));
}

/* the systems that did NOT fit on the bar this paint — the More menu's list */
let tabOverflow = [];

function moreMenuMatches() {
  const f = (ui.moreFilter || '').trim().toLowerCase();
  if (!f) return tabOverflow.slice();
  return tabOverflow.filter((t) => t.label.toLowerCase().indexOf(f) !== -1);
}

function closeMoreMenu() {
  if (!ui.moreOpen) return;
  ui.moreOpen = false;
  ui.moreFilter = '';
  ui.moreStyleOpen = false;   // next open starts collapsed again
  const m = $('tab-more-menu');
  if (m) m.classList.add('hidden');
  renderTabs();   // drops the button's .open state
}

function onMoreMenuClick(e) {
  const tog = e.target.closest('[data-act="style-toggle"]');
  if (tog) {
    e.stopPropagation();
    ui.moreStyleOpen = !ui.moreStyleOpen;
    renderMoreMenu(true);   // keep the menu up; just reveal/hide the style body
    return;
  }
  const st = e.target.closest('.more-style-btn[data-style]');
  if (st) {
    e.stopPropagation();
    const tb = tabbarPrefs();
    if (tb.style !== st.dataset.style) {
      tb.style = st.dataset.style;
      saveSoon();
      renderTabs();              // repaint the bar in the new style (re-fits too)
      renderMoreMenu(true);      // keep the menu up so the switch is comparable
    }
    return;
  }
  const it = e.target.closest('.more-item[data-tab]');
  if (!it) return;
  e.stopPropagation();
  const t = it.dataset.tab;
  closeMoreMenu();
  setTab(t);
}
function onMoreMenuInput(e) {
  if (!e.target.classList || !e.target.classList.contains('more-search')) return;
  ui.moreFilter = e.target.value;
  renderMoreList();   // only the list — never re-create the input you're typing in
}

/* Rebuild ONLY the results, leaving the live search input (and its focus /
   caret) untouched. Called on every keystroke. */
function renderMoreList() {
  const menu = $('tab-more-menu');
  if (!menu) return;
  const list = menu.querySelector('.more-list');
  if (!list) return;
  const items = moreMenuMatches();
  const filtering = !!(ui.moreFilter || '').trim();
  let h = '';
  if (!items.length) h += '<div class="more-empty">No match</div>';
  items.forEach((t, i) => {
    h += '<button class="more-item' + (ui.tab === t.tab ? ' active' : '') +
      (filtering && i === 0 ? ' top' : '') + '" data-tab="' + t.tab + '" title="' + esc(t.title) + '">' +
      '<span class="more-item-label">' + esc(t.label) + '</span></button>';
  });
  list.innerHTML = h;
}
function onMoreMenuKey(e) {
  const code = normCode(e);
  if (code === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeMoreMenu();
    const b = $('tabs').querySelector('[data-act="more"]');
    if (b) b.focus();
  } else if (code === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    const items = moreMenuMatches();
    if (items.length) { const t = items[0].tab; closeMoreMenu(); setTab(t); }
  }
}

/* The body-anchored dropdown for the More button. Hung off <body> like the
   deck's other overlays so the header's own overflow can't clip it. */
function renderMoreMenu(keepFocus) {
  let menu = $('tab-more-menu');
  if (!ui.moreOpen) { if (menu) menu.classList.add('hidden'); return; }
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tab-more-menu';
    menu.className = 'more-menu hidden';
    document.body.appendChild(menu);
    menu.addEventListener('click', onMoreMenuClick);
    menu.addEventListener('input', onMoreMenuInput);
    menu.addEventListener('keydown', onMoreMenuKey);
  }
  const items = moreMenuMatches();
  const filtering = !!(ui.moreFilter || '').trim();
  const tb = tabbarPrefs();
  let h = '';
  if (tabOverflow.length) {
    h += '<input class="more-search" type="text" placeholder="Filter systems…" value="' + esc(ui.moreFilter || '') + '">';
    h += '<div class="more-list">';
    if (!items.length) h += '<div class="more-empty">No match</div>';
    items.forEach((t, i) => {
      h += '<button class="more-item' + (ui.tab === t.tab ? ' active' : '') +
        (filtering && i === 0 ? ' top' : '') + '" data-tab="' + t.tab + '" title="' + esc(t.title) + '">' +
        '<span class="more-item-label">' + esc(t.label) + '</span></button>';
    });
    h += '</div>';
  } else {
    h += '<div class="more-empty more-allfit">Everything fits — every system is on the bar.</div>';
  }
  /* tab style — collapsed behind a chevron by default; always reachable here
     even when nothing overflows. Click the header to reveal Names / Icons. */
  const curStyle = tb.style === 'icons' ? 'Icons' : 'Names';
  h += '<div class="more-style-wrap' + (ui.moreStyleOpen ? ' open' : '') + '">' +
    '<button class="more-style-toggle" data-act="style-toggle" ' +
      'title="Choose how the tab bar shows systems" aria-expanded="' + (ui.moreStyleOpen ? 'true' : 'false') + '">' +
      '<span class="more-style-toggle-lbl">Tab style</span>' +
      '<span class="more-style-cur">' + curStyle + '</span>' +
      '<span class="more-style-chev">▾</span>' +
    '</button>' +
    '<div class="more-style-body">' +
      '<div class="more-style-btns">' +
        '<button class="more-style-btn' + (tb.style !== 'icons' ? ' on' : '') + '" data-style="text" title="Full names — the most-used systems keep their words">Aa Names</button>' +
        '<button class="more-style-btn' + (tb.style === 'icons' ? ' on' : '') + '" data-style="icons" title="Icons only — hover shows the name; many more fit">▦ Icons</button>' +
      '</div>' +
      '<div class="more-style-hint">Most-used systems earn the bar; the rest live here.</div>' +
    '</div>' +
  '</div>';
  menu.innerHTML = h;
  menu.classList.remove('hidden');
  /* Anchor under the More button; clamp so a wide menu never leaves the panel. */
  const btn = $('tabs').querySelector('[data-act="more"]');
  if (btn) {
    const r = btn.getBoundingClientRect();
    const w = 240;
    menu.style.top = Math.round(r.bottom + 5) + 'px';
    menu.style.left = Math.round(Math.max(6, Math.min(r.left, window.innerWidth - w - 6))) + 'px';
  }
  const s = menu.querySelector('.more-search');
  if (s && !keepFocus) setTimeout(() => { s.focus(); }, 10);
}

/* One system button, in the current tab style. Icons mode shows the Home
   card's gold glyph and leans on the title (the #hd-tip bubble) for the name. */
function sysBtnHtml(t, icons) {
  const active = ui.tab === t.tab;
  if (icons) {
    return '<button class="tab tab-ic' + (active ? ' active' : '') + '" data-tab="' + t.tab +
      '" title="' + esc(t.label) + ' — ' + esc(t.title) + '">' +
      '<img class="tab-icon" src="' + t.img + '" alt="' + esc(t.label) + '" draggable="false"></button>';
  }
  return '<button class="tab' + (active ? ' active' : '') + '" data-tab="' + t.tab +
    '" title="' + esc(t.title) + '">' + esc(t.label) + '</button>';
}

/* Paint the bar with the first `n` systems (usage order); the rest become
   the More menu's list. Returns nothing — reads/writes tabOverflow. */
function paintTabsRow(n, compactMore) {
  const tb = tabbarPrefs();
  const icons = tb.style === 'icons';
  const onHk = isHotkeyTab();
  const order = sysOrder();
  const shown = order.slice(0, n);
  tabOverflow = order.slice(n);

  const fixed = (dataAttr, label, title, img, active, extra) => icons
    ? '<button class="tab tab-ic' + (active ? ' active' : '') + '" ' + dataAttr +
      ' title="' + esc(label) + ' — ' + esc(title) + '">' +
      '<img class="tab-icon" src="' + img + '" alt="' + esc(label) + '" draggable="false">' + (extra || '') + '</button>'
    : '<button class="tab' + (active ? ' active' : '') + '" ' + dataAttr +
      ' title="' + esc(title) + '">' + esc(label) + (extra || '') + '</button>';

  let html = fixed('data-tab="home"', 'Home', 'Home — every system as a card + universal search',
    'icons/skymanager.png', ui.tab === 'home');
  html += fixed('data-tab="' + esc(hkTabToken()) + '"', 'Hotkeys', 'Your hotkey categories',
    'icons/custom/hm-hotkeys.png', onHk);
  html += icons
    ? '<button class="tab tab-ic launcher" data-act="spells" title="Spell Deck — opens in its own window (F18)">' +
      '<img class="tab-icon" src="icons/custom/hm-spells.png" alt="Spells" draggable="false"></button>'
    : '<button class="tab launcher" data-act="spells" title="Open the Spell Deck (F18)">Spells ' +
      '<span class="tab-launch" aria-hidden="true">↗</span></button>';
  html += '<span class="tab-sep" aria-hidden="true"></span>';
  shown.forEach((t) => { html += sysBtnHtml(t, icons); });

  /* The More button stays even when everything fits: it holds the tab-style
     toggle, and it is where an overflowed ACTIVE tab hoists its label so you
     always see where you are. */
  const activeMore = tabOverflow.filter((t) => t.tab === ui.tab)[0];
  const moreTitle = tabOverflow.length
    ? 'More systems — ' + esc(tabOverflow.map((t) => t.label).join(', '))
    : 'Tab style & options';
  /* icons mode keeps the More button icon-sized too: the hoisted active tab
     shows as its glyph, plain overflow as ⋯ — every px goes to real tabs */
  const moreFace = icons
    ? (activeMore
        ? '<img class="tab-icon" src="' + activeMore.img + '" alt="' + esc(activeMore.label) + '" draggable="false">'
        : '⋯')
    : (compactMore ? '⋯'
        : (activeMore ? esc(activeMore.label) : (tabOverflow.length ? 'More' : '⋯')));
  html += '<button class="tab tab-more' + (icons ? ' tab-ic' : '') + (activeMore ? ' active' : '') + (ui.moreOpen ? ' open' : '') +
    '" data-act="more" aria-haspopup="true" aria-expanded="' + (!!ui.moreOpen) +
    '" title="' + (activeMore ? esc(activeMore.label) + ' — ' + moreTitle : moreTitle) + '">' +
    moreFace +
    ' <span class="tab-launch tab-more-chev" aria-hidden="true">▾</span></button>';
  $('tabs').innerHTML = html;
}

function renderTabs() {
  /* Dynamic fit (Rober, 2026-08-07: "more dynamic to fit more tabs"): start
     with every system on the bar and shed the least-used, one at a time,
     until nothing scrolls. #tabs is overflow-x:auto, so scrollWidth vs
     clientWidth is the honest measure — label widths, icon mode and the menu
     scale all price themselves in. A closed deck measures 0 and keeps the
     previous split rather than guessing. */
  const order = sysOrder();
  const onHk = isHotkeyTab();
  let n = order.length;
  paintTabsRow(n);
  const el = $('tabs');
  if (el && el.clientWidth) {
    while (n > 0 && el.scrollWidth > el.clientWidth + 1) { n--; paintTabsRow(n); }
    // even the minimum row can pinch at the 640px floor — compact More to ⋯
    if (n === 0 && el.scrollWidth > el.clientWidth + 1) paintTabsRow(0, true);
  }
  renderMoreMenu();

  let sub = '<button class="tab' + (ui.tab === 'all' ? ' active' : '') + '" data-tab="all">All</button>';
  state.categories.forEach((c, idx) => {
    const id = 'cat:' + c;
    const active = ui.tab === id;
    if (ui.tabRename === c) {
      sub += '<span class="tab tab-editing"><input class="tab-input" data-mode="ren" data-cat="' + esc(c) + '" value="' + esc(c) + '"></span>';
      return;
    }
    sub += '<button class="tab' + (active ? ' active' : '') + '" data-tab="' + esc(id) + '">' + esc(c);
    if (ui.edit) {
      const dim = (off) => (off ? ' style="opacity:.25;pointer-events:none"' : '');
      sub += ' <span class="ticon mv" data-act="mvl" data-cat="' + esc(c) + '" title="Move tab left"' + dim(idx === 0) + '>◂</span>' +
             '<span class="ticon mv" data-act="mvr" data-cat="' + esc(c) + '" title="Move tab right"' + dim(idx === state.categories.length - 1) + '>▸</span>' +
             '<span class="ticon" data-act="ren" data-cat="' + esc(c) + '" title="Rename tab">✎</span>' +
             '<span class="ticon del' + (ui.confirmTabDelete === c ? ' confirm' : '') + '" data-act="del" data-cat="' + esc(c) + '" title="Remove tab (hotkeys move to All)">' +
             (ui.confirmTabDelete === c ? 'Sure?' : '✕') + '</span>';
    }
    sub += '</button>';
  });
  if (ui.edit) {
    sub += ui.tabAdding
      ? '<span class="tab tab-editing"><input class="tab-input" data-mode="add" placeholder="Tab name…"></span>'
      : '<button class="tab add-tab" data-act="add" title="Add a tab">＋ Tab</button>';
    if (!state.categories.length && !ui.tabAdding)
      sub += '<span class="hk-sub-hint">Tabs group your hotkeys — add one to start filing them.</span>';
  }
  const subRow = $('hk-tabs');
  /* A lone "All" chip is noise: the row only earns its 34px once there are
     categories to switch between, or you're in edit mode adding the first one.
     The `ui.tab !== 'all'` clause is insurance — if a category filter is somehow
     active with no categories left, the row must still be there to escape it. */
  const showSub = onHk && (ui.edit || state.categories.length > 0 || ui.tab !== 'all');
  if (subRow) {
    subRow.innerHTML = sub;
    subRow.classList.toggle('hidden', !showSub);
  }
  document.body.classList.toggle('hk-sub', showSub);

  const inp = document.querySelector('#tabs .tab-input, #hk-tabs .tab-input');
  if (inp) { inp.focus(); if (inp.dataset.mode === 'ren') inp.select(); }
}

/* ---- tab management ---- */

function commitAddTab(name) {
  ui.tabAdding = false;
  name = (name || '').trim();
  if (!name) { render(); return; }
  if (state.categories.indexOf(name) !== -1) { toast('Tab "' + name + '" already exists'); render(); return; }
  state.categories.push(name);
  save();
  setTab('cat:' + name);
  render();
}

function commitRenameTab(oldName, name) {
  ui.tabRename = null;
  name = (name || '').trim();
  const i = state.categories.indexOf(oldName);
  if (!name || name === oldName || i === -1) { render(); return; }
  if (state.categories.indexOf(name) !== -1) { toast('Tab "' + name + '" already exists'); render(); return; }
  state.categories[i] = name;
  state.entries.forEach((e) => { if ((e.category || '') === oldName) e.category = name; });
  if (ui.tab === 'cat:' + oldName) ui.tab = 'cat:' + name;
  if (ui.hkTab === 'cat:' + oldName) ui.hkTab = 'cat:' + name;
  save();
  render();
}

function deleteTab(name) {
  state.categories = state.categories.filter((c) => c !== name);
  state.entries.forEach((e) => { if ((e.category || '') === name) e.category = ''; });
  if (ui.tab === 'cat:' + name) ui.tab = 'all';
  if (ui.hkTab === 'cat:' + name) ui.hkTab = 'all';
  ui.confirmTabDelete = null;
  save();
  render();
  toast('Tab removed — its hotkeys are in All');
}

function onTabsClick(e) {
  const act = e.target.closest('[data-act]');
  if (act) {
    e.stopPropagation();
    const a = act.dataset.act;
    /* the Spell Deck launcher — an ACTION, not a pane. C++ owns the handoff:
       PrismaUI focus is single-view, so it must close this palette before the
       magic view can take focus (CanOpenNow() refuses otherwise). */
    if (a === 'spells') { toGame('hdOpenSpells'); return; }
    if (a === 'more') {
      ui.moreOpen = !ui.moreOpen;
      ui.moreFilter = '';
      renderTabs();   // repaints the button's .open state + (re)builds the menu
      return;
    }
    if (a === 'add') { ui.tabAdding = true; render(); return; }
    if (a === 'mvl' || a === 'mvr') {
      const i = state.categories.indexOf(act.dataset.cat);
      const j = a === 'mvl' ? i - 1 : i + 1;
      if (i === -1 || j < 0 || j >= state.categories.length) return;
      const t = state.categories.splice(i, 1)[0];
      state.categories.splice(j, 0, t);
      save();
      render();
      return;
    }
    if (a === 'ren') { ui.tabRename = act.dataset.cat; render(); return; }
    if (a === 'del') {
      const c = act.dataset.cat;
      if (ui.confirmTabDelete === c) { deleteTab(c); }
      else {
        ui.confirmTabDelete = c;
        render();
        setTimeout(() => { if (ui.confirmTabDelete === c) { ui.confirmTabDelete = null; render(); } }, 2500);
      }
      return;
    }
  }
  const tab = e.target.closest('.tab[data-tab]');
  if (tab) setTab(tab.dataset.tab);
}

function onTabsKey(e) {
  const inp = e.target;
  if (!inp.classList || !inp.classList.contains('tab-input')) return;
  const code = normCode(e);
  if (code === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    if (inp.dataset.mode === 'add') commitAddTab(inp.value); else commitRenameTab(inp.dataset.cat, inp.value);
  } else if (code === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    ui.tabAdding = false; ui.tabRename = null;
    render();
  }
}

function onTabsFocusOut(e) {
  const inp = e.target;
  if (!inp.classList || !inp.classList.contains('tab-input')) return;
  setTimeout(() => {  // let Enter/Esc handlers win first
    if (ui.tabAdding && inp.dataset.mode === 'add') commitAddTab(inp.value);
    else if (ui.tabRename && inp.dataset.mode === 'ren') commitRenameTab(inp.dataset.cat, inp.value);
  }, 120);
}

/* Which SEEDED keyboard entries are "shipped with the deck / an integration to
   another mod" rather than a plain key you'd have added yourself — so they earn
   the same gold highlight as the native ⚙ actions and the ✦ VirtualKey rows.
   Source of truth is the C++ DefaultConfig seed (src/main.cpp): these are the
   ones that OPEN or DRIVE another mod. The plain combat/utility keys it also
   seeds (stance-1/2/3, block) and the free-slot placeholders (shining-treasure,
   slot-12) are deliberately NOT here — they are "yours to use", not integrations.
   device:"action" and device:"vkey" are gold by kind and never need listing. */
const HK_SHIPPED_GOLD = new Set([
  'follower-organizer',   // opens Follower Organizer
  'followers-control',    // Follower Control (NFF) menu
  'followers-teleport',   // teleport followers to you
  'quick-follower',       // quick follower command menu
  'weapon-wheel',         // opens the weapon-wheel mod
  'tailor-open',          // opens Tailor (outfits & wigs)
  'omo-pick',             // Object Manipulation Overhaul pick
  'followers-loot',       // NPC Sandbox / Skinshift
]);
/* True when an entry ships with the deck or bridges another mod (gold), false
   for a plain keystroke you made. Exposed so the harness can assert it. */
function hkIsShipped(e) {
  return !!e && (e.device === 'action' || e.device === 'vkey' || HK_SHIPPED_GOLD.has(e.id));
}

/* Which seeded entries REQUIRE another mod, and the C++ detection flag (sent on
   open as cfg.detected) that says it's installed. An entry whose required mod is
   absent is HIDDEN in normal use and shown greyed ("needs X") in Edit — so a
   SHARED deck only surfaces the integrations the recipient actually has. Ungated
   entries (freeze/sit, Full Save, Loot Vision, Prisma MCM, Tailor, weapon wheel,
   quick-follower, and anything you add) always show. Mirrors the C++
   DetectedModsJson() flags. */
const HK_REQUIRES = {
  'npc-grab':               { flag: 'omo',               label: 'Object Manipulation Overhaul' },
  'omo-pick':               { flag: 'omo',               label: 'Object Manipulation Overhaul' },
  'hd-additem-menu':        { flag: 'additemmenu',       label: 'AddItemMenu' },
  'hd-additem-search':      { flag: 'additemmenu',       label: 'AddItemMenu' },
  'follower-organizer':     { flag: 'followerorganizer', label: 'Follower Organizer' },
  'followers-control':      { flag: 'nff',               label: "Nether's Follower Framework" },
  'followers-teleport':     { flag: 'nff',               label: "Nether's Follower Framework" },
  'open-smf':               { flag: 'smf',               label: 'SKSE Menu Framework' },
  'open-community-shaders': { flag: 'cs',                label: 'Community Shaders' },
};
/* The missing-mod label if this entry's required mod is NOT detected, else ''.
   device:"vkey" requires VirtualKey. A DLL that predates cfg.detected sends no
   flags, so an unknown flag reads as AVAILABLE — nothing vanishes on an older
   build. Exposed for the harness. */
function hkNeeds(e) {
  if (!e) return '';
  const det = (state.detected && typeof state.detected === 'object') ? state.detected : null;
  if (e.device === 'vkey') return (det && det.virtualkey === false) ? 'VirtualKey' : '';
  const req = HK_REQUIRES[e.id];
  if (!req) return '';
  if (!det || !(req.flag in det)) return '';   // older DLL / unknown → assume present
  return det[req.flag] ? '' : req.label;
}

function renderList() {
  const list = $('list');
  const q = ui.search.trim();
  const items = filteredEntries();
  if (ui.sel >= items.length) ui.sel = Math.max(0, items.length - 1);

  $('empty-state').classList.toggle('hidden', state.entries.length > 0);

  /* Reserve the icon slot on every visible row only once SOMETHING in view has
     an icon — names then line up, and an icon-less deck pays no dead space. */
  const anyIcon = items.some((e) => !!hkIconSrc(e.icon));

  let html = '';
  items.forEach((e, i) => {
    const slot = i < 9 ? String(i + 1) : (i === 9 ? '0' : '·');
    const isAction = e.device === 'action';
    /* Built-in vs yours, at a glance: device:"action" entries run hard-coded
       C++ (Freeze, Grab, AddItemMenu…) — you can rename or delete them but not
       rebind what they DO, and a deleted one re-seeds on the next launch. The
       gold edge + ⚙ chip is that fact made visible; a plain keypress hotkey
       you made yourself never gets it. */
    /* VirtualKey entry (device:"vkey"): fires an MCM hotkey you've offloaded onto
       VirtualKey's virtual-key range — no physical key, no scancode. The ✦ chip
       carries [VKnnn] + the verb; in edit mode it reopens the picker rather than
       press-to-rebind (there is no key to press). */
    const isVKey = e.device === 'vkey';
    /* Gold edge for anything shipped/integration (native action, VirtualKey, or a
       seeded mod-opener) — not a plain key you added. */
    const isShipped = hkIsShipped(e);
    /* Required mod not installed → greyed "needs X" (only ever rendered in edit
       mode; filteredEntries drops these outside it). */
    const needs = hkNeeds(e);
    const vkVerb = e.action || 'tap';
    const keyLbl = isAction ? ('⚙ ' + (e.label || 'Action'))
      : isVKey ? ('✦ VK' + e.code + (vkVerb !== 'tap' ? ' ·' + vkVerb : ''))
      : (e.code ? chordLabel(e.mods, e.label || '?') : 'Set key…');
    const chipCls = isAction ? 'keychip action' : isVKey ? 'keychip vkey' : (e.code ? 'keychip' : 'keychip unset');
    if (!ui.edit) {
      html +=
        '<div class="row' + (i === ui.sel ? ' selected' : '') + (isShipped ? ' hk-native' : '') + '" data-id="' + esc(e.id) + '">' +
        '<span class="slot">' + slot + '</span>' +
        hkIconHtml(e, anyIcon) +
        '<div class="row-main">' +
        '<div class="row-name">' + highlight(e.name, q) + '</div>' +
        (e.desc ? '<div class="row-desc" title="' + esc(e.desc) + '">' + highlight(e.desc, q) + '</div>' : '') +
        '</div>' +
        trigChipHtml(e, false) +
        '<span class="' + chipCls + '">' + esc(keyLbl) + '</span>' +
        '</div>';
    } else {
      const delConfirm = ui.confirmDelete === e.id;
      let catSel = '<select class="cat-select" title="Tab">' +
        '<option value=""' + (!(e.category) ? ' selected' : '') + '>— All only —</option>';
      state.categories.forEach((c) => {
        catSel += '<option value="' + esc(c) + '"' + ((e.category || '') === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      });
      catSel += '</select>';
      html +=
        '<div class="row edit' + (isShipped ? ' hk-native' : '') + (needs ? ' hk-unavail' : '') + '" data-id="' + esc(e.id) + '">' +
        '<span class="drag-h" title="Drag to reorder">⋮⋮</span>' +
        '<span class="slot">' + slot + '</span>' +
        hkIconHtml(e, true) +
        '<div class="row-main">' +
        '<input class="name-input" value="' + esc(e.name) + '" placeholder="Name…">' +
        '<input class="desc-input" value="' + esc(e.desc) + '" placeholder="Description…">' +
        '</div>' +
        (needs ? '<span class="hk-needs" title="Hidden unless this mod is installed">needs ' + esc(needs) + '</span>' : '') +
        catSel +
        trigChipHtml(e, true) +
        (isAction
          ? '<span class="' + chipCls + '" title="Built-in action — not rebindable">' + esc(keyLbl) + '</span>'
          : isVKey
          ? '<button class="' + chipCls + ' vkey-edit-btn" title="Change the MCM binding or verb">' + esc(keyLbl) + '</button>'
          : '<button class="' + chipCls + ' rebind-btn" title="Click, then press the new key">' + esc(keyLbl) + '</button>') +
        '<div class="row-tools">' +
        '<button class="tool-btn up" title="Move up"' + (state.entries.indexOf(e) === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="tool-btn down" title="Move down"' + (state.entries.indexOf(e) === state.entries.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button class="tool-btn del' + (delConfirm ? ' confirm' : '') + '" title="Remove">' + (delConfirm ? 'Sure?' : '✕') + '</button>' +
        '</div>' +
        '</div>';
    }
  });
  list.innerHTML = html;

  const selRow = list.children[ui.sel];
  if (selRow && !ui.edit) selRow.scrollIntoView({ block: 'nearest' });
}

function modSlot(m) {
  const s = state.settings;
  if (!s.openMods || typeof s.openMods !== 'object') s.openMods = {};
  if (!s.openMods[m]) s.openMods[m] = { device: 'keyboard', code: 0, label: '' };
  return s.openMods[m];
}

function renderModSlots() {
  /* Spell the whole chord out — "Alt + F7 fires" beats a bare "Alt +" next to
     a key nobody can connect back to the open key they actually press. */
  const ok = (state.settings && state.settings.openKey) || {};
  const okLbl = ok.label || (ok.code ? (ok.device + ' ' + ok.code) : 'open key');
  ['shift', 'ctrl', 'alt'].forEach((m) => {
    const sl = modSlot(m);
    const btn = $('mod' + m + '-btn');
    if (!btn) return;
    btn.textContent = sl.code ? (sl.label || (sl.device + ' ' + sl.code)) : '—';
    btn.classList.toggle('unset', !sl.code);
    const row = btn.closest('.modslot');
    const lab = row && row.querySelector('.set-label');
    if (lab) {
      const cap = m.charAt(0).toUpperCase() + m.slice(1);
      lab.textContent = cap + ' + ' + okLbl + (sl.code ? ' fires' : '');
    }
  });
}

function renderSettings() {
  const ok = state.settings.openKey || {};
  $('openkey-btn').textContent = ok.label || (ok.device + ' ' + ok.code);
  $('pause-cb').checked = !!state.settings.pauseOnOpen;
  if ($('smoothpause-cb')) {
    $('smoothpause-cb').checked = state.settings.smoothPause !== false;   // default on
    $('smoothpause-cb').disabled = !state.settings.pauseOnOpen;           // only meaningful when pausing
  }
  $('close-cb').checked = !!state.settings.closeAfterFire;
  $('sticky-cb').checked = !!state.settings.stickyNpMods;
  $('tgtfol-cb').checked = state.settings.targetOpensFollowers !== false;
  renderModSlots();
  applyScale();
  if (window.HDScale) HDScale.sync('deck');   // row-icon readout, beside Menu scale
  renderExt();
}

function extTargetLabel(name, code) {
  if (!code) return 'off';
  if (code === EXT_RAW[name]) return name + ' (raw)';
  return DIK_LABEL[code] || 'code ' + code;
}

/* The deck-settings card folds, and starts folded: in edit mode it is ~400px
   of keys, checkboxes and sliders sitting on top of the rows you pressed F2 to
   edit. The summary carries the two facts worth seeing while it is shut. */
function renderSettingsFold() {
  if (ui.setOpen === undefined) ui.setOpen = false;
  const body = $('settings-body');
  if (!body) return;
  body.classList.toggle('hidden', !ui.setOpen);
  $('settings-card').classList.toggle('open', !!ui.setOpen);
  const chev = $('settings-toggle').querySelector('.set-chevron');
  if (chev) chev.textContent = ui.setOpen ? '▾' : '▸';
  const sum = $('settings-summary');
  if (sum) {
    /* `state`, not `cfg` — this file's config lives in `state.settings`, and
       the wrong name here threw on every render (caught by the harness
       refusing to run at all rather than by a visibly broken card). */
    const st = state.settings || {};
    const key = (st.openKey && st.openKey.label) || '—';
    const pct = Math.round((st.uiScale || 1) * 100);
    sum.textContent = key + ' · ' + pct + '%';
  }
}

function renderExt() {
  if (ui.extOpen === undefined) ui.extOpen = false;
  const ek = extKeysState();
  $('ext-cb').checked = !!ek.enabled;
  $('ext-body').classList.toggle('hidden', !ui.extOpen);
  /* Scoped to its OWN button. A bare document query for this class was fine
     while there was one chevron on the page; the settings card now has one
     too, earlier in the DOM. */
  $('ext-toggle').querySelector('.ext-chevron').textContent = ui.extOpen ? '▾' : '▸';
  const mapped = EXT_NAMES.filter((n) => ek.map[n] > 0).length;
  $('ext-summary').textContent = ek.enabled
    ? 'F24 → ' + extTargetLabel('F24', ek.map.F24) + ' · ' + mapped + '/12 on'
    : 'bridge off';

  const g = $('ext-grid');
  g.classList.toggle('ext-disabled', !ek.enabled);
  let html = '';
  EXT_NAMES.forEach((n) => {
    const code = ek.map[n];
    html +=
      '<div class="ext-row' + (code === 0 ? ' off' : '') + '">' +
        '<span class="ext-name">' + n + '</span>' +
        '<button class="keychip ext-target' + (code === 0 ? ' unset' : '') + '" data-ext="' + n +
          '" title="Click, then press the key ' + n + ' should fire in-game">' +
          extTargetLabel(n, code) + '</button>' +
        '<button class="ghost-btn mini ext-raw' + (code === EXT_RAW[n] ? ' on' : '') + '" data-ext="' + n +
          '" title="Send the true extended code (SKSE listeners; blank key art in MCM lists)">raw</button>' +
        '<button class="ghost-btn mini ext-kill' + (code === 0 ? ' on' : '') + '" data-ext="' + n +
          '" title="Disable this key">off</button>' +
      '</div>';
  });
  g.innerHTML = html;
}

function buildNumpad() {
  let html = '';
  NUMPAD_LAYOUT.forEach((k, i) => {
    const lbl = k.small ? '<small>' + esc(k.l) + '</small>' : esc(k.l);
    html += '<button class="npkey ' + (k.cls || '') + '" data-i="' + i + '">' + lbl + '</button>';
  });
  $('numpad-grid').innerHTML = html;
}

/* ============================================================= toast ==== */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1900);
}

/* ================================================ item-source banner ==== */
/* Opened while the crosshair held a ground item (not an NPC): C++ pushes
   hdItemSource with the item's name and the plugin that owns it, and this
   banner names the mod. Persistent until dismissed or the deck closes —
   unlike #toast, because reading "Umbra_Reforged_Patch.esp" inside a 1.9 s
   fade is not a thing. Arrives once per open, right after hdOpen. */
window.hdItemSource = function (p) {
  try { if (typeof p === 'string') p = JSON.parse(p); } catch (err) { p = null; }
  ui.itemSource = (p && typeof p === 'object' && p.name) ? p : null;
  renderItemSource();
};

function renderItemSource() {
  const el = $('item-source');
  if (!el) return;
  const s = ui.itemSource;
  if (!s || !ui.visible) { el.classList.add('hidden'); return; }
  const from = s.basePlugin || 'this save — spawned/dynamic, no plugin';
  let html = '<span class="is-icon">🧩</span><div class="is-body">' +
    '<div class="is-name">' + esc(s.name) + '</div>' +
    '<div class="is-from">from <b>' + esc(from) + '</b>' +
    (s.baseId ? ' <span class="is-id">' + esc(s.baseId) + '</span>' : '') + '</div>';
  const extra = [];
  if (s.override) extra.push('last edited by ' + esc(s.override));
  if (s.refPlugin && s.refPlugin !== s.basePlugin) extra.push('placed by ' + esc(s.refPlugin));
  if (extra.length) html += '<div class="is-extra">' + extra.join(' · ') + '</div>';
  html += '</div><button class="is-close" title="Dismiss">✕</button>';
  el.innerHTML = html;
  el.classList.remove('hidden');
  el.querySelector('.is-close').onclick = function () {
    ui.itemSource = null;
    renderItemSource();
  };
}

/* ============================================================== save ==== */

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  toGame('hdSave', JSON.stringify(state));
}

/* Write NOW if a debounced save is still pending, else do nothing.
   Called on every route out of the palette — see requestClose/hdClosed. */
function flushSave() {
  if (saveTimer) save();          // save() clears the timer itself
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

/* ============================================================== fire ==== */

function fireEntry(id, rowEl) {
  const e = state.entries.find((x) => x.id === id);
  if (!e || (e.device !== 'action' && !e.code)) { toast('No key bound — set one in Edit mode'); return; }
  if (rowEl) rowEl.classList.add('flash');
  toGame('hdFire', id);
  if (DEV) toast('fired ' + e.name);
}

function quickFire(slotDigit) {
  const items = filteredEntries();
  const idx = slotDigit === 0 ? 9 : slotDigit - 1;
  if (idx >= items.length) return;
  const row = $('list').children[idx];
  fireEntry(items[idx].id, row);
}

/* =========================================================== capture ==== */

function startCapture(mode, id) {
  ui.capture = { mode: mode, id: id, picking: false };
  $('capture-picker').classList.add('hidden');   // always start on press-to-rebind
  toGame('hdCapture', '1');
  $('capture-title').textContent =
    mode === 'open' ? 'Press the new OPEN key or mouse button…' :
    mode === 'folopen' ? 'Press the new FOLLOWERS key or mouse button…' :
    mode === 'ext'  ? 'Press the key ' + id + ' should fire in-game…' :
    mode === 'trigger' ? 'Press the key that should fire this from anywhere…' :
                      'Press a key or mouse button…';
  $('capture-modal').classList.remove('hidden');
}

/* pane-facing hook (followers-pane.js binds its Open-key button to this) */
window.startFolCapture = function () { startCapture('folopen', null); };

function endCapture(applied) {
  const cap = ui.capture;
  ui.capture = null;
  closeKeyPicker();
  toGame('hdCapture', '0');
  $('capture-modal').classList.add('hidden');
  if (!applied && cap && cap.mode === 'add') {
    /* Drop the draft entry that never got a key — but NOT an action entry.
       A hotkey with no key does nothing and is just litter; an ACTION with no
       key is completely usable, you click it in the list. Deleting those on
       cancel would mean "Add action, change your mind about the binding, lose
       the action". */
    const i = state.entries.findIndex((e) => e.id === cap.id && !e.code && e.device !== 'action');
    if (i !== -1) state.entries.splice(i, 1);
  }
  render();
}

function applyCapture(binding) {
  const cap = ui.capture;
  if (!cap) return;
  if (cap.mode === 'ext') {
    extKeysState().map[cap.id] = binding.code;
    toast(cap.id + ' → ' + binding.keyLabel);
    endCapture(true);
    save();
    return;
  }
  if (cap.mode === 'modshift' || cap.mode === 'modctrl' || cap.mode === 'modalt') {
    const m = cap.mode.slice(3);
    const sl = modSlot(m);
    sl.device = binding.device; sl.code = binding.code; sl.label = binding.keyLabel;
    toast(m.charAt(0).toUpperCase() + m.slice(1) + ' + open → ' + binding.keyLabel);
    endCapture(true);
    save();
    return;
  }
  if (cap.mode === 'folopen') {   // Followers-tab deep-open key — saved via fdSave, not hdSave
    if (window.FolPane) FolPane.setOpenKey(binding.device, binding.code, binding.keyLabel);
    endCapture(true);
    return;
  }
  if (cap.mode === 'trigger') {
    const e = state.entries.find((x) => x.id === cap.id);
    if (e) {
      e.trigger = {
        device: binding.device,
        code: binding.code,
        label: binding.keyLabel,
        /* Mouse chords aren't supported by the C++ matcher — it only checks
           Shift/Ctrl/Alt for keyboard triggers — so never store mods we can't
           honour, or the key would silently refuse to fire. */
        mods: binding.device === 'keyboard' ? (binding.mods || []) : []
      };
      toast(e.name + ' ⚡ ' + binding.keyLabel);
    }
    endCapture(true);
    save();
    return;
  }
  if (cap.mode === 'open') {
    state.settings.openKey = { device: binding.device, code: binding.code, label: binding.keyLabel };
    toast('Open key: ' + binding.keyLabel);
  } else {
    const e = state.entries.find((x) => x.id === cap.id);
    if (e) {
      e.device = binding.device;
      e.code = binding.code;
      e.label = binding.keyLabel;
      e.mods = binding.device === 'keyboard' ? binding.mods : [];
    }
  }
  endCapture(true);
  save();
  if (cap.mode === 'add') {
    const row = $('list').querySelector('[data-id="' + cap.id + '"] .name-input');
    if (row) { row.focus(); row.select(); }
  }
}

/* ---- key PICKER: assign a key WITHOUT pressing it -------------------------
   Ultralight never forwards some keydowns to the deck — Home / End / PgUp /
   PgDn / Ins / Del, the arrows, F13–F24, the mouse — so press-to-rebind cannot
   catch them; and a key your keyboard doesn't physically have can't be pressed
   at all. This list lets you CLICK any key: it funnels through applyCapture()
   exactly like a real press, so every mode (entry / trigger / open / modifier /
   ext) is honoured with no special-casing. */
function keyPickItems() {
  const cap = ui.capture || {};
  const entryMode = cap.mode === 'entry' || cap.mode === 'add';
  const navFirst = ['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
                    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const pri = (ev) => navFirst.indexOf(ev) !== -1 ? 0
                    : /^F\d+$/.test(ev) ? 1
                    : ev.indexOf('Numpad') === 0 ? 3 : 2;
  const out = [];
  Object.keys(DIK).forEach((ev) => {
    if (MODIFIER_CODES.indexOf(ev) !== -1) return;
    /* Entries SEND their key; F13–F24 loop straight back into our own bridge, so
       they are trigger/open-only — the same refusal onKeyDown enforces for a
       real press (they stay pickable for triggers and the open key). */
    if (entryMode && EXT_NAMES.indexOf(ev) !== -1) return;
    out.push({ ev: ev, code: DIK[ev][0], label: DIK[ev][1] });
  });
  out.sort((a, b) => pri(a.ev) - pri(b.ev) || a.label.localeCompare(b.label));
  return out;
}
function openKeyPicker() {
  if (!ui.capture) return;
  ui.capture.picking = true;
  ui.keyPickFilter = '';
  const f = $('capture-pick-filter');
  if (f) f.value = '';
  $('capture-picker').classList.remove('hidden');
  $('capture-modal').classList.add('picking');   // pauses the box pulse (see app.css)
  renderKeyPick();
  setTimeout(function () { if (f) f.focus(); }, 0);
}
function closeKeyPicker() {
  if (ui.capture) ui.capture.picking = false;
  const p = $('capture-picker');
  if (p) p.classList.add('hidden');
  const m = $('capture-modal');
  if (m) m.classList.remove('picking');
}
function renderKeyPick() {
  const list = $('capture-pick-list');
  if (!list) return;
  const q = (ui.keyPickFilter || '').trim().toLowerCase();
  const all = keyPickItems();
  const items = q ? all.filter(function (k) {
    return k.label.toLowerCase().indexOf(q) !== -1 || k.ev.toLowerCase().indexOf(q) !== -1;
  }) : all;
  if (!items.length) { list.innerHTML = '<div class="cp-none">No key matches “' + esc(q) + '”.</div>'; return; }
  list.innerHTML = items.slice(0, 200).map(function (k, i) {
    return '<button type="button" class="cp-row' + (i === 0 ? ' top' : '') +
           '" data-code="' + k.code + '">' + esc(k.label) + '</button>';
  }).join('');
}
function selectPickedKey(code, label) {
  closeKeyPicker();
  applyCapture({ device: 'keyboard', code: code, mods: [], keyLabel: label });
}

/* ============================================================ events ==== */

function onKeyDown(e) {
  if (!ui.visible) return;
  const code = normCode(e);

  /* ---- capture mode swallows everything ---- */
  if (ui.capture) {
    /* ...EXCEPT while the "pick from a list" search owns the keyboard: bail
       early (no preventDefault) so the filter input gets the character. The
       input's own keydown handles Enter (pick top hit) and Esc (close picker,
       back to press mode). */
    if (ui.capture.picking) return;
    e.preventDefault();
    e.stopPropagation();
    if (code === 'Escape') { endCapture(false); return; }
    if (MODIFIER_CODES.indexOf(code) !== -1) return; // wait for the main key
    const hit = DIK[code];
    if (!hit) { toast('Unsupported key: ' + (code || e.keyCode)); return; }
    /* An entry's own key is what it SENDS. Sending F13-F24 would hand the
       press straight back to our own bridge, so those stay refused HERE even
       though DIK now resolves them — every other mode is an INPUT binding
       (what fires the thing) and wants the faithful extended code. Same
       sentence hdExtKey uses, so the refusal reads identically whichever
       route the press arrived by. */
    if ((ui.capture.mode === 'entry' || ui.capture.mode === 'add') && EXT_NAMES.indexOf(code) !== -1) {
      toast(code + ' can be a trigger or the open key — entries fire standard keys');
      return;
    }
    if (ui.capture.mode === 'ext') {  // ext targets are plain keys — no modifiers
      applyCapture({ device: 'keyboard', code: hit[0], mods: [], keyLabel: hit[1] });
      return;
    }
    const mods = [];
    if (e.shiftKey) mods.push(MOD_DIK.SHIFT);
    if (e.ctrlKey) mods.push(MOD_DIK.CTRL);
    if (e.altKey) mods.push(MOD_DIK.ALT);
    applyCapture({
      device: 'keyboard',
      code: hit[0],
      mods: mods,
      keyLabel: chordLabel(mods, hit[1]),
    });
    return;
  }

  /* ---- the Wheel Menu is modal ---- *
   * FIRST among the overlays: it is full-screen, it hides the panel entirely,
   * and its digits FIRE a wedge — so an unguarded 1-9 reaching the quick-fire
   * handler behind it would fire a hotkey the player cannot even see. It owns
   * Esc / arrows / digits / E / F / S; anything it does not claim falls
   * through to the picker's own input. */
  if (window.HDWheel && HDWheel.isOpen()) {
    if (HDWheel.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never let anything reach quick-fire behind the overlay
  }

  /* ---- the Omni overlay (Search + Ask) is modal ---- *
   * Ahead of everything below for the same structural reason as the icon
   * picker: while it is open the user is typing a query, and an unguarded
   * digit would reach the quick-fire handler and FIRE that hotkey. Omni owns
   * Esc / arrows / Enter / Tab; plain characters fall through into its input. */
  if (window.HDOmni && HDOmni.isOpen()) {
    if (HDOmni.onKey(e, code)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never let anything reach quick-fire behind the overlay
  }
  /* Ctrl+F opens it from ANY tab (F2's edit toggle and the panes never claim
     Ctrl chords, so this is collision-free) */
  if (code === 'KeyF' && e.ctrlKey && !e.shiftKey && !e.altKey && window.HDOmni) {
    e.preventDefault();
    e.stopPropagation();
    HDOmni.open('search');
    return;
  }

  /* ---- the Formation modal is modal ---- *
   * Same structural slot as Omni: while it is open the user is dragging
   * sliders and typing offsets, so nothing may fall through to quick-fire.
   * It owns Esc (close me, not the palette); plain characters stop here. */
  if (window.HDFormation && HDFormation.isOpen()) {
    if (HDFormation.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never quick-fire behind the modal
  }

  /* ---- the Door lock modal is modal ---- *
   * Same structural slot: while it is open the user is typing a lock level
   * into its number field, and an unguarded digit would reach quick-fire and
   * FIRE that hotkey. It owns Esc (close me, not the palette) and Enter
   * (lock at the picked level); everything else stays in its inputs. */
  if (window.HDDoor && HDDoor.isOpen()) {
    if (HDDoor.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never quick-fire behind the modal
  }

  /* ---- the Outfit dock (F7 ⛨) owns the keyboard while it is up ---- *
   * Quick apply is a typing box driven with ↑ ↓ and Enter, and Copy outfit
   * has a name field — an unguarded letter behind either would quick-fire
   * the hotkey it spells. Esc steps back to the dock, and closes from
   * there; the module says so by returning true. Sits ABOVE the SPID
   * block because the dock can be opened over an already-open manager. */
  if (window.HDOutfit && HDOutfit.isOpen()) {
    if (HDOutfit.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never quick-fire behind the dock
  }

  /* ---- the NPC Quests modal (F7 📜) owns the keyboard while it is up ---- *
   * Same structural reason as the dock above: its list is driven by a typing
   * box with ↑ ↓ and Enter, and its stage grid has a numeric jump field — an
   * unguarded letter or digit behind either would quick-fire the hotkey it
   * spells. Esc steps back from a quest to her list, and closes from there. */
  if (window.HDQuests && HDQuests.isOpen()) {
    if (HDQuests.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never quick-fire behind the modal
  }

  /* ---- the SPID Gear manager is modal for the same reason ---- *
   * While it is open the user is typing into its search box and dragging
   * chance sliders — nothing may fall through to quick-fire. */
  if (window.HDSpidGear && HDSpidGear.isOpen()) {
    if (HDSpidGear.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    return;   // never quick-fire behind the modal
  }

  /* ---- the Sharmat popout is modal-ish ---- *
   * Sits with the icon picker, ahead of the Followers delegation and the
   * global Escape below, for the same structural reason: while it is open the
   * user is typing prose and numbers into it, and an unguarded digit would
   * otherwise reach the quick-fire handler and FIRE that hotkey into the game.
   * It only claims Escape (close me, not the palette); everything else falls
   * through so its inputs keep typing normally. */
  if (window.SmPane && SmPane.isOpen()) {
    if (SmPane.onKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
    const ael = document.activeElement;
    if (ael && ael.closest && ael.closest('.sm-pop')) return;   // typing in it: let it through
    if (e.key && e.key.length === 1) return;                    // never quick-fire behind it
  }

  /* ---- the icon picker is modal ---- *
   * Sits after press-to-rebind (that wins) and BEFORE the Followers delegation
   * and everything below, so this early return is what structurally stops a
   * keystroke reaching the quick-fire digits: typing "5" into an unguarded icon
   * search would otherwise FIRE hotkey #5 into the game. Nothing is
   * preventDefault-ed except the keys we own, so the search input keeps typing
   * and native Tab traversal still reaches the tiles. */
  if (hkIcon.open) {
    if (code === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHkIconPicker(); render(); return; }
    if (code === 'F2') { e.preventDefault(); return; }
    const s = $('hk-icon-search');
    if (s && document.activeElement !== s && e.key && e.key.length === 1) s.focus();
    return;
  }

  /* while editing a name/desc/tab field, let the field keep Tab (field-to-field)
     and Esc (cancel/blur, don't close the whole palette) */
  const ae = document.activeElement;
  const isTabInput = ae && ae.classList && ae.classList.contains('tab-input');
  const inNotes = ae && ae.id === 'notes-ta';
  const inEditInput = (ae && ae.tagName === 'INPUT' &&
    (ae.classList.contains('name-input') || ae.classList.contains('desc-input'))) || isTabInput || inNotes;

  /* the Followers pane owns its keys first (its menus/search/F2); Tab-cycling
     and palette-close Escape fall through to the shell below */
  if (ui.tab === 'followers' && code !== 'Tab' && window.FolPane && FolPane.onKey(e)) return;

  /* ---- global keys ---- */
  if (code === 'Escape') {
    e.preventDefault();
    if (isTabInput) { ui.tabAdding = false; ui.tabRename = null; render(); return; }
    if (ui.tab === 'quests' && ui.qDetail) {   // Esc backs out of a quest first
      ui.qDetail = null; ui.qNote = ''; ui.qConfirmStage = null;
      renderQuests();
      return;
    }
    if (inEditInput) { ae.blur(); return; }
    requestClose();
    return;
  }
  if (code === 'Tab') {
    if (inEditInput) return; // native focus traversal between edit fields
    e.preventDefault();
    const order = tabOrder();
    setTab(order[(order.indexOf(ui.tab) + 1) % order.length]);
    return;
  }
  if (code === 'F2') { e.preventDefault(); toggleEdit(); return; }

  if (ui.tab === 'numpad' || ui.tab === 'notes' || ui.tab === 'quests' ||
      ui.tab === 'followers' || ui.tab === 'domains' || ui.tab === 'containers' || ui.tab === 'finances' ||
      ui.tab === 'wardrobe' || ui.tab === 'faces') return;  // hotkey-list keys below apply to deck tabs only

  const inTextInput = document.activeElement &&
    document.activeElement.tagName === 'INPUT' &&
    document.activeElement.type === 'text';
  const inSearch = document.activeElement === $('search');

  /* list navigation works from the search box too */
  if (!ui.edit) {
    if (code === 'ArrowDown') { e.preventDefault(); ui.sel++; renderList(); return; }
    if (code === 'ArrowUp') { e.preventDefault(); ui.sel = Math.max(0, ui.sel - 1); renderList(); return; }
    if (code === 'Enter') {
      e.preventDefault();
      const items = filteredEntries();
      if (items[ui.sel]) fireEntry(items[ui.sel].id, $('list').children[ui.sel]);
      return;
    }
    /* quick-fire on digits while the search box is empty */
    if (ui.search === '' && /^Digit\d$/.test(code)) {
      e.preventDefault();
      quickFire(Number(code.slice(5)));
      return;
    }
  }

  /* funnel typing into the search box */
  if (!ui.edit && !inSearch && !inTextInput && e.key && e.key.length === 1) {
    focusSearch();
  }
}

function onMouseDown(e) {
  if (!ui.visible || !ui.capture) return;
  // Let the capture-box's own controls work: Cancel, the "Pick from a list"
  // button, and every click inside the key picker (filter + rows). Without this
  // the mouse-bind path below would preventDefault them and toast "can't bind".
  if (e.target && e.target.closest &&
      e.target.closest('#capture-cancel, #capture-pick, #capture-picker')) return;
  const hit = MOUSE[e.button];
  e.preventDefault();
  e.stopPropagation();
  if (!hit) {
    if (e.button === 0 || e.button === 2) toast('Left/Right click can’t be bound');
    return;
  }
  if (ui.capture.mode === 'ext') {
    toast('Keyboard keys only — F-keys can’t fire mouse buttons');
    return;
  }
  applyCapture({ device: 'mouse', code: hit[0], mods: [], keyLabel: hit[1] });
}

function requestClose() {
  /* Rober asked whether an in-game hotkey change ALWAYS saves. It did not.
     Rebinds call save() outright, but four things debounce by 350ms —
     renaming a hotkey, editing its description, the Notes tab, and dragging
     the panel to a new size — and nothing on the way out flushed them. Close
     the deck within a third of a second of typing and the edit was gone, with
     no error and no way to tell. */
  flushSave();
  toGame('hdClose');
  if (DEV) hdClosed();
}

function setTab(t) {
  closeMoreMenu();   // any tab switch dismisses the overflow menu
  if (ui.tab === t) return;
  const prev = ui.tab;
  ui.tab = t;
  bumpTabUse(t);   // usage ranks the bar: most-used systems earn the visible slots
  if (isHotkeyTab(t)) ui.hkTab = t;   // Hotkeys returns to the last category
  ui.sel = 0;
  if (prev === 'followers' && window.FolPane) FolPane.onHide();
  if (prev === 'domains' && window.DomainsPane) DomainsPane.onHide();
  if (prev === 'containers' && window.ContainersPane) ContainersPane.onHide();
  if (prev === 'home' && window.HomePane) HomePane.onHide();
  if (prev === 'rooms' && window.RoomsPane) RoomsPane.onHide();
  if (prev === 'loot' && window.LootPane) LootPane.onHide();
  if (prev === 'keys' && window.KeysPane) KeysPane.onHide();
  if (prev === 'anim' && window.AnimPane) AnimPane.onHide();
  if (prev === 'finances' && window.FinancesPane) FinancesPane.onHide();
  if (prev === 'wardrobe' && window.WardrobePane) WardrobePane.onHide();
  if (prev === 'time' && window.TimePane) TimePane.onHide();
  if (prev === 'faces' && window.FacesPane) FacesPane.onHide();
  render();
  /* semantic pause signal: any hotkey/notes tab = paused (if configured), numpad = live */
  toGame('hdTab', t === 'numpad' ? 'numpad' : 'deck');
  /* Re-ask on show. The list carries a rendered "2m ago" rather than a raw
     timestamp — deliberately, so it cannot drift while the palette sits open —
     which means the moment to refresh it is when you look at it. */
  if (t === 'recent') toGame('hdHistory', '');
  if (t === 'quests') {
    ui.qDetail = null;
    ui.qNote = '';
    ui.qConfirmStage = null;
    requestQuests();   // re-query every time: the crosshair NPC may have changed
    return;
  }
  if (t === 'followers') {
    if (window.FolPane) {
      FolPane.onShow();   // re-query too: roster + crosshair target are per-open
      /* F7 NPC-focus: if this show is the tail of a brand-new open (C++ routes
         a plain F7-with-crosshair-target here, main.cpp:3145), dedicate the
         pane to that NPC. `fresh` gates it to the OPEN — a manual Followers-tab
         click is not fresh, so it lands on the normal roster. The 1.5s window
         covers the synchronous open sequence (hdOpen → fdTarget → hdShowTab). */
      if (FolPane.maybeAutoFocus)
        FolPane.maybeAutoFocus((Date.now() - (ui.openedAt || 0)) < 1500);
    }
    return;
  }
  if (t === 'domains') {
    if (window.DomainsPane) DomainsPane.onShow();   // re-pushes the location snapshot
    return;
  }
  if (t === 'containers') {
    if (window.ContainersPane) ContainersPane.onShow();   // re-snapshots the crosshair container
    return;
  }
  if (t === 'rooms') {
    if (window.RoomsPane) RoomsPane.onShow();   // re-polls occupancy; it is a live fact
    return;
  }
  if (t === 'loot') {
    if (window.LootPane) LootPane.onShow();   // re-pulls the slice + starts the glow-count poll
    return;
  }
  if (t === 'keys') {
    if (window.KeysPane) KeysPane.onShow();   // re-asks scan state; first look auto-starts the census
    return;
  }
  if (t === 'anim') {
    if (window.AnimPane) AnimPane.onShow();   // re-pulls the catalogue + the current crosshair target
    return;
  }
  if (t === 'finances') {
    if (window.FinancesPane) FinancesPane.onShow();   // pulls fresh gold/debt/ledger + the slice
    return;
  }
  if (t === 'wardrobe') {
    if (window.WardrobePane) WardrobePane.onShow();   // re-reads SOES + the armour list on every open
    return;
  }
  if (t === 'time') {
    if (window.TimePane) TimePane.onShow();   // re-reads the game clock on every open
    return;
  }
  if (t === 'faces') {
    if (window.FacesPane) FacesPane.onShow();   // re-asks the preset index + repaints
    return;
  }
  if (t === 'home') {
    if (window.HomePane) HomePane.onShow();   // re-reads live counts + warms the Recent drawer
    return;
  }
  if (t !== 'numpad' && t !== 'notes') focusSearch();
}

/* C++ deep-open: F14 lands the palette straight on a tab; pressing the same
   key while that tab is already up closes the palette (toggle parity with F7). */
window.hdShowTab = function (t) {
  t = String(t || '');
  if (!t) return;
  /* 'wheel' is not a tab — it is the full-screen radial overlay, deep-opened
     by Ctrl+F7 the same way F14 deep-opens Followers. Routed here rather than
     given its own C++ callback so it inherits the whole open sequence that
     already works: open-if-closed, and press-again-to-close (the wheel's own
     toggle honours the same 700 ms guard, or the very keystroke that opened
     the deck would close it again on arrival). */
  if (t === 'wheel') {
    if (!window.HDWheel) return;
    if (HDWheel.isOpen()) {
      if (Date.now() - (ui.openedAt || 0) > 700) requestClose();
      return;
    }
    HDWheel.open(true);
    return;
  }
  if (ui.tab === t) {
    /* Toggle parity: pressing the tab's own key while ON that tab closes the
       deck — but NOT when this hdShowTab is the tail of the very keystroke
       that just opened it (the last-closed-tab restore can land on the same
       tab first; without this window F14 would open-and-instantly-close). */
    if (Date.now() - (ui.openedAt || 0) > 700) requestClose();
    return;
  }
  setTab(t);
};

function toggleEdit() {
  if (ui.tab === 'home' && window.HomePane) {   // Home reorders its system cards
    HomePane.toggleEdit();
    render();   // repaint the Edit button's active state (Home never flips ui.edit)
    return;
  }
  if (ui.tab === 'followers' && window.FolPane) {   // the panes have their own edit modes
    FolPane.onKey({ key: 'F2', preventDefault() {}, target: null });
    return;
  }
  if (ui.tab === 'domains' && window.DomainsPane) { DomainsPane.toggleEdit(); return; }
  if (ui.tab === 'containers' && window.ContainersPane) { ContainersPane.toggleEdit(); return; }
  if (ui.tab === 'rooms' && window.RoomsPane) { RoomsPane.toggleEdit(); return; }
  if (ui.tab === 'finances' && window.FinancesPane) { FinancesPane.toggleEdit(); return; }
  if (ui.tab === 'wardrobe' && window.WardrobePane) { WardrobePane.toggleEdit(); return; }
  if (hkIcon.open) closeHkIconPicker();   // the picker only exists inside edit mode
  /* F2 from Numpad/Notes drops back onto the hotkey list — the category you
     left, not always All. Written directly (not via setTab), so keep hkTab
     authoritative here too. */
  if (ui.tab === 'numpad' || ui.tab === 'notes') { ui.tab = hkTabToken(); ui.hkTab = ui.tab; toGame('hdTab', 'deck'); }
  ui.edit = !ui.edit;
  ui.confirmDelete = null;
  ui.tabAdding = false;
  ui.tabRename = null;
  ui.confirmTabDelete = null;
  render();
  if (!ui.edit) focusSearch();
}

function focusSearch() {
  const s = $('search');
  if (s) s.focus();
}

/* ---- list interactions (event delegation) ---- */

/* ---- drag to reorder (edit mode) ---- */

function onDragStart(e) {
  if (!ui.edit || e.button !== 0) return;
  const h = e.target.closest('.drag-h');
  if (!h) return;
  const row = h.closest('.row');
  if (!row) return;
  ui.drag = { id: row.dataset.id, moved: false, over: null };
  row.classList.add('dragging');
  e.preventDefault();
}

function onDragMove(e) {
  if (!ui.drag) return;
  ui.drag.moved = true;
  const rows = Array.from(document.querySelectorAll('#list .row.edit'));
  let over = null, before = false;
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
      over = r;
      before = e.clientY < rect.top + rect.height / 2;
      break;
    }
  }
  rows.forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bot'));
  const valid = over && over.dataset.id !== ui.drag.id;
  if (valid) over.classList.add(before ? 'drag-over-top' : 'drag-over-bot');
  ui.drag.over = valid ? { id: over.dataset.id, before: before } : null;
}

function onDragEnd() {
  if (!ui.drag) return;
  const d = ui.drag;
  ui.drag = null;
  document.querySelectorAll('#list .row').forEach((r) =>
    r.classList.remove('dragging', 'drag-over-top', 'drag-over-bot'));
  if (d.over) {
    const from = state.entries.findIndex((x) => x.id === d.id);
    if (from !== -1) {
      const it = state.entries.splice(from, 1)[0];
      const to = state.entries.findIndex((x) => x.id === d.over.id);
      if (to !== -1) {
        state.entries.splice(d.over.before ? to : to + 1, 0, it);
        save();
      } else {
        state.entries.splice(from, 0, it);  // target vanished; restore
      }
      render();
    }
  }
  if (d.moved) {
    ui.justDragged = true;
    setTimeout(() => { ui.justDragged = false; }, 120);
  }
}

function onListClick(e) {
  if (ui.justDragged) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const id = row.dataset.id;

  if (!ui.edit) { fireEntry(id, row); return; }

  const entry = state.entries.find((x) => x.id === id);
  if (!entry) return;

  /* closest(), not classList: the click target may be the inner <img> */
  if (e.target.closest('.hk-ico')) { openHkIconPicker(entry); return; }
  if (e.target.classList.contains('trig-clear')) {
    delete entry.trigger;
    render();
    save();
    toast('Trigger removed');
    return;
  }
  if (e.target.classList.contains('trig-btn')) { startCapture('trigger', id); return; }
  if (e.target.classList.contains('rebind-btn')) { startCapture('entry', id); return; }
  if (e.target.classList.contains('vkey-edit-btn')) { openVKeyPicker(e.target, entry); return; }
  if (e.target.classList.contains('up') || e.target.classList.contains('down')) {
    const i = state.entries.indexOf(entry);
    const j = e.target.classList.contains('up') ? i - 1 : i + 1;
    if (j < 0 || j >= state.entries.length) return;
    state.entries.splice(i, 1);
    state.entries.splice(j, 0, entry);
    render();
    save();
    return;
  }
  if (e.target.classList.contains('del')) {
    if (ui.confirmDelete === id) {
      state.entries = state.entries.filter((x) => x.id !== id);
      ui.confirmDelete = null;
      render();
      save();
      toast('Removed');
    } else {
      ui.confirmDelete = id;
      render();
      setTimeout(() => { if (ui.confirmDelete === id) { ui.confirmDelete = null; render(); } }, 2500);
    }
  }
}

function onListInput(e) {
  if (!ui.edit) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const entry = state.entries.find((x) => x.id === row.dataset.id);
  if (!entry) return;
  if (e.target.classList.contains('name-input')) entry.name = e.target.value;
  if (e.target.classList.contains('desc-input')) entry.desc = e.target.value;
  saveSoon();
}

function onListChange(e) {
  if (!ui.edit || !e.target.classList.contains('cat-select')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const entry = state.entries.find((x) => x.id === row.dataset.id);
  if (!entry) return;
  entry.category = e.target.value;
  save();
  if (activeCategory() !== null) render();  // entry may have left the visible tab
}

/* ---- numpad ---- */

function onNumpadClick(e) {
  const btn = e.target.closest('.npkey');
  if (!btn) return;
  const k = NUMPAD_LAYOUT[Number(btn.dataset.i)];
  if (!k) return;
  const keyLabel = k.real || ('Num ' + k.l).replace('Num NumLock', 'NumLock').replace('Num Enter', 'Num Enter');
  const label = chordLabel(ui.npMods, k.small ? k.l : keyLabel);
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 280);
  toGame('hdFireKey', JSON.stringify({ device: 'keyboard', code: k.c, mods: ui.npMods.slice(), label: label }));
  if (DEV) toast('fired ' + label);
  if (!state.settings.stickyNpMods) {
    /* one-shot modifiers (default) — sticky mode keeps them lit until toggled off */
    ui.npMods = [];
    document.querySelectorAll('.modkey').forEach((m) => m.classList.remove('on'));
  }
}

function onModClick(e) {
  const dik = Number(e.currentTarget.dataset.mod);
  const i = ui.npMods.indexOf(dik);
  if (i === -1) ui.npMods.push(dik); else ui.npMods.splice(i, 1);
  e.currentTarget.classList.toggle('on', i === -1);
}

/* ============================================================ quests ==== */
/* Look at an NPC, open the deck, hit Quests: every quest that NPC is involved
   in, the quest's full stage list with the current stage marked, and a click
   to fire a stage. C++ side lives in quest_tools.cpp.

   Two things worth knowing while using it:
     * aliases only resolve while a quest is RUNNING, so a quest whose alias
       never filled cannot be found from the NPC — that's what "Search all
       quests" is for, and it's the usual shape of a broken quest.
     * an unfilled required alias is flagged loudly; it is more often the real
       fault than the stage number is. */

const OBJ_STATE = { 0: 'dormant', 1: 'displayed', 2: 'completed', 3: 'failed' };

let qSearchTimer = null;

function requestQuests() {
  ui.qLoading = true;
  renderQuests();
  if (ui.qMode === 'search') {
    const q = ui.qSearch.trim();
    if (q.length < 2) { ui.qLoading = false; ui.qList = null; renderQuests(); return; }
    toGame('hdQuestSearch', q);
  } else {
    toGame('hdQuestList');
  }
}

function requestQuestsSoon() {
  clearTimeout(qSearchTimer);
  qSearchTimer = setTimeout(requestQuests, 260);  // debounced search-as-you-type
}

function setQMode(mode) {
  if (ui.qMode === mode) return;
  ui.qMode = mode;
  ui.qDetail = null;
  ui.qList = null;
  ui.qNote = '';
  requestQuests();
  if (mode === 'search') setTimeout(() => { const s = $('q-search'); if (s) s.focus(); }, 30);
}

function statusChip(status) {
  const cls = status === 'running' ? 'run' : (status === 'completed' ? 'done' : 'idle');
  return '<span class="q-chip ' + cls + '">' + esc(status || '—') + '</span>';
}

function renderQuests() {
  renderHints('quests');   // detail vs list changes the legend
  document.querySelectorAll('.q-mode').forEach((b) =>
    b.classList.toggle('on', b.dataset.qmode === ui.qMode));
  $('q-search').classList.toggle('hidden', ui.qMode !== 'search');

  const tgt = $('q-target');
  if (ui.qMode === 'search') {
    tgt.innerHTML = ui.qList && ui.qList.truncated
      ? '<span class="q-dim">first 120 matches</span>' : '';
  } else if (ui.qNpc) {
    tgt.innerHTML = 'Target: <b>' + esc(ui.qNpc.name) + '</b> <span class="q-dim">' +
      esc(ui.qNpc.formId) + (ui.qNpc.plugin ? ' · ' + esc(ui.qNpc.plugin) : '') + '</span>';
  } else {
    tgt.textContent = '';
  }

  const detailOpen = !!ui.qDetail;
  $('q-detail').classList.toggle('hidden', !detailOpen);
  $('q-list').classList.toggle('hidden', detailOpen);
  if (detailOpen) {
    $('q-empty').classList.add('hidden');
    renderQuestDetail();
    return;
  }
  renderQuestList();
}

function showQEmpty() {
  const e = $('q-empty');
  e.classList.remove('hidden');
  if (ui.qMode === 'search') {
    e.innerHTML = ui.qSearch.trim().length < 2
      ? '<div class="empty-icon">🔍</div><div class="empty-title">Search every quest</div>' +
        '<div class="empty-sub">At least 2 characters — matches name, EditorID, FormID or plugin.</div>'
      : '<div class="empty-icon">∅</div><div class="empty-title">No quests match</div>' +
        '<div class="empty-sub">Try the EditorID or the plugin filename.</div>';
    return;
  }
  if (!ui.qList || ui.qList.hasTarget === false) {
    e.innerHTML = '<div class="empty-icon">◎</div><div class="empty-title">No NPC targeted</div>' +
      '<div class="empty-sub">Look at an NPC, then press the open key — the deck snapshots whoever is under your crosshair. Or use <b>Search all quests</b>.</div>';
    return;
  }
  e.innerHTML = '<div class="empty-icon">∅</div><div class="empty-title">Nothing found for this NPC</div>' +
    '<div class="empty-sub">Quest aliases only resolve while a quest is running. If a quest is stuck <i>because</i> its alias never filled, it cannot be found this way — look for it under <b>Search all quests</b>.</div>';
}

function renderQuestList() {
  const list = $('q-list');
  if (ui.qLoading) {
    list.innerHTML = '<div class="q-skel"></div><div class="q-skel"></div><div class="q-skel"></div>';
    $('q-empty').classList.add('hidden');
    return;
  }
  const payload = ui.qList;
  const quests = (payload && payload.quests) || [];
  if (!payload || !quests.length) { list.innerHTML = ''; showQEmpty(); return; }
  $('q-empty').classList.add('hidden');

  const q = ui.qMode === 'search' ? ui.qSearch.trim() : '';
  let html = '';
  quests.forEach((qu) => {
    const warn = qu.unfilledAliases > 0
      ? '<span class="q-warn" title="' + qu.unfilledAliases +
        ' required alias(es) are empty — a far more likely cause of a stuck quest than the stage number">⚠ ' +
        qu.unfilledAliases + ' unfilled</span>'
      : '';
    const via = qu.involvement === 'static'
      ? '<span class="q-via" title="Named in this quest&#39;s alias data, but not currently held by it — the quest has not started, or its alias never filled">not live</span>'
      : (qu.aliasName ? '<span class="q-via" title="This NPC currently fills that alias">' + esc(qu.aliasName) + '</span>' : '');
    html +=
      '<div class="q-row" data-qid="' + esc(qu.formId) + '">' +
        '<div class="q-row-main">' +
          '<div class="q-name">' + highlight(qu.name, q) + '</div>' +
          '<div class="q-meta">' + esc(qu.plugin || '?') +
            (qu.type ? ' · ' + esc(qu.type) : '') +
            ' · <span class="q-dim">' + esc(qu.formId) + '</span>' +
            (via ? ' · ' + via : '') + (warn ? ' · ' + warn : '') +
          '</div>' +
        '</div>' +
        '<div class="q-row-right">' + statusChip(qu.status) +
          '<span class="q-stage">stage ' + qu.currentStage + '<small>/' + qu.stageCount + '</small></span>' +
        '</div>' +
      '</div>';
  });
  list.innerHTML = html;
}

function renderQuestDetail() {
  const d = ui.qDetail;
  const el = $('q-detail');
  if (!d || d.ok === false) {
    el.innerHTML = '<div class="q-dhead"><button class="q-back" title="Back (Esc)">←</button></div>' +
      '<div class="q-err">' + esc((d && d.message) || 'Quest not found') + '</div>';
    return;
  }

  let html = '<div class="q-dhead">' +
    '<button class="q-back" title="Back to list (Esc)">←</button>' +
    '<div class="q-dtitle">' +
      '<div class="q-name">' + esc(d.name) + '</div>' +
      '<div class="q-meta">' + esc(d.plugin || '?') + (d.type ? ' · ' + esc(d.type) : '') +
        ' · <span class="q-dim">' + esc(d.formId) +
        (d.editorId ? ' · ' + esc(d.editorId) : '') + '</span></div>' +
    '</div>' + statusChip(d.status) + '</div>';

  if (ui.qNote) html += '<div class="q-note">' + esc(ui.qNote) + '</div>';

  const aliases = d.aliases || [];
  const bad = aliases.filter((a) => a.filled === false && !a.optional).length;
  html += '<div class="q-sec"><div class="q-sec-h">Aliases <span class="q-dim">' + aliases.length + '</span>' +
    (bad ? '<span class="q-warn">⚠ ' + bad + ' unfilled</span>' : '') + '</div>';
  if (!aliases.length) {
    html += '<div class="q-dim q-pad">This quest has no aliases.</div>';
  } else {
    html += '<div class="q-aliases">';
    aliases.forEach((a) => {
      const unfilled = a.filled === false;
      const cls = unfilled ? (a.optional ? ' opt' : ' bad') : '';
      html += '<div class="q-alias' + cls + '">' +
        '<span class="q-alias-n">' + esc(a.name || ('alias ' + a.id)) + '</span>' +
        '<span class="q-alias-f q-dim">' + esc(a.fill || a.kind || '') + (a.optional ? ' · optional' : '') + '</span>' +
        (unfilled
          ? '<span class="q-alias-v empty">' + (a.wants ? 'EMPTY — wants ' + esc(a.wants) : 'EMPTY') + '</span>'
          : '<span class="q-alias-v">' + esc(a.refName || a.refId || '—') + '</span>') +
        '</div>';
    });
    html += '</div>';
  }
  html += '</div>';

  const stages = d.stages || [];
  html += '<div class="q-sec"><div class="q-sec-h">Stages <span class="q-dim">' + stages.length +
    ' · current ' + d.currentStage + '</span></div>';
  if (!stages.length) {
    html += '<div class="q-dim q-pad">This quest defines no stages.</div>';
  } else {
    html += '<div class="q-stages">';
    stages.forEach((s) => {
      const back = s.index < d.currentStage;
      const pending = ui.qConfirmStage === s.index;
      html += '<button class="q-st' + (s.current ? ' cur' : '') + (back ? ' back' : '') +
        (pending ? ' confirm' : '') + '" data-stage="' + s.index + '" title="' +
        (s.current ? 'Current stage' : (back ? 'Earlier than current — replaying a stage can make things worse' : 'Fire this stage')) +
        '">' + (pending ? '?' : s.index) + '</button>';
    });
    html += '</div><div class="q-hint">Click a stage to fire it through Papyrus, so its script fragments actually run. ' +
      'Stages <b>before</b> the current one ask for a second click.</div>';
  }
  html += '</div>';

  const objs = d.objectives || [];
  if (objs.length) {
    html += '<div class="q-sec"><div class="q-sec-h">Objectives <span class="q-dim">' + objs.length + '</span></div><div class="q-objs">';
    objs.forEach((o) => {
      html += '<div class="q-obj s' + o.state + '">' +
        '<span class="q-obj-i">' + o.index + '</span>' +
        '<span class="q-obj-t">' + esc(o.text || '(no text)') + '</span>' +
        '<span class="q-dim">' + esc(OBJ_STATE[o.state] !== undefined ? OBJ_STATE[o.state] : o.state) + '</span>' +
        '</div>';
    });
    html += '</div></div>';
  }

  html += '<div class="q-actions">' +
    '<button class="q-act go" data-verb="movetoqt" title="Teleport to the current objective target (console movetoqt). Checks the target is live first, then closes the menu and jumps.">◎ Go to target</button>' +
    '<button class="q-act" data-verb="start" title="Start the quest (Quest.Start)">Start</button>' +
    '<button class="q-act" data-verb="stop" title="Stop the quest (Quest.Stop)">Stop</button>' +
    '<button class="q-act" data-verb="complete" title="Papyrus CompleteQuest">Complete</button>' +
    '<button class="q-act danger" data-verb="reset" title="ResetAndUpdate — wipes quest progress, like console resetquest">Reset</button>' +
    '</div>';

  el.innerHTML = html;
}

function onStageClick(stage) {
  const d = ui.qDetail;
  if (!d || !d.formId) return;
  if (stage < d.currentStage && ui.qConfirmStage !== stage) {
    ui.qConfirmStage = stage;   // going backwards is the dangerous direction
    renderQuests();
    setTimeout(() => {
      if (ui.qConfirmStage === stage) { ui.qConfirmStage = null; renderQuests(); }
    }, 2600);
    return;
  }
  ui.qConfirmStage = null;
  ui.qNote = 'firing stage ' + stage + '…';
  toGame('hdQuestSetStage', JSON.stringify({ formId: d.formId, stage: stage }));
  renderQuests();
}

function onQuestsClick(e) {
  const mode = e.target.closest('.q-mode');
  if (mode) { setQMode(mode.dataset.qmode); return; }

  if (e.target.closest('.q-back')) {
    ui.qDetail = null; ui.qNote = ''; ui.qConfirmStage = null;
    renderQuests();
    return;
  }

  const st = e.target.closest('.q-st');
  if (st) { onStageClick(Number(st.dataset.stage)); return; }

  const act = e.target.closest('.q-act');
  if (act) {
    if (!ui.qDetail || !ui.qDetail.formId) return;
    ui.qNote = act.dataset.verb + '…';
    toGame('hdQuestAction', JSON.stringify({ formId: ui.qDetail.formId, verb: act.dataset.verb }));
    renderQuests();
    return;
  }

  const row = e.target.closest('.q-row');
  if (row) {
    ui.qConfirmStage = null;
    ui.qNote = '';
    ui.qDetail = { ok: true, name: 'Loading…', formId: row.dataset.qid, status: '',
                   currentStage: 0, stages: [], aliases: [], objectives: [] };
    toGame('hdQuestGet', row.dataset.qid);
    renderQuests();
  }
}

/* ======================================================= hotkey icons ==== *
 * Each hotkey may carry an optional icon in its row's left slot, next to (not
 * instead of) the quick-fire digit chip. Storage is Config.entries[].icon and
 * it rides the EXISTING whole-config hdSave round-trip — there is no separate
 * save path.
 *
 * PATH CONTRACT (must match main.cpp and portal/server.js byte for byte):
 * the stored value is ALWAYS view-relative with forward slashes and is exactly
 * one of "" | "icons/custom/<file>" | "icons/sh/<atlas>/<key>.png". Ultralight
 * resolves a relative <img src> against the view's own directory, and C++ gives
 * each view its own icons/ tree (mirroring MagicDeck/icons/custom across), so
 * the same string means "my own icons folder" in whichever view renders it.
 * Never "../", never absolute, and never a ?v= cache-bust — Ultralight's loader
 * can treat the query as part of the FILENAME (proven in-game 2026-07-28, see
 * followers-pane.js medalEl). Use the picker's ⟳ Refresh (hdIconList) instead.
 *
 * The library itself arrives from C++: hdIconIndex(<icons/sh_index.json>) once
 * per session, hdIcons({custom:[…]}) on every open and on hdIconList.        */

/* catalog = the picker's flat list; byForm/generic = the two resolve maps the
   spell art needs (see hdSpellIconPath below). All three arrive in the one
   icons/sh_index.json C++ pushes as hdIconIndex. */
const ICONS = { catalog: [], custom: [], byForm: {}, generic: {} };
const hkIcon = { open: false, id: null, filter: '', shown: 0 };
const HK_ICON_PAGE = 96;

function normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

/* Defence in depth: entry.icon only ever comes from the picker (whose choices
   are C++-supplied) or from the portal sidecar (which C++ validates), but a
   hand-edited hotkeys.json must not be able to hand the webview a filesystem
   path or an escape out of the view root. */
function hkIconSrc(p) {
  p = normPath(p);
  if (!p) return '';
  if (p.indexOf('..') !== -1) return '';        // no escaping the view dir
  if (p.charAt(0) === '/') return '';           // no server-absolute
  if (/^[A-Za-z]:/.test(p)) return '';          // no drive letters
  if (/^(?:file|https?):/i.test(p)) return '';  // no schemes
  return p;
}

/* Row slot markup. `slotted` reserves an empty box so names stay aligned when
   SOME rows in view have an icon; edit mode always reserves it, because the box
   IS the affordance (it grows a ＋ from CSS). A broken src collapses to that
   same empty box via an inline onerror — inline, not a post-innerHTML
   addEventListener pass, because the <img> is live the instant `list.innerHTML`
   is assigned and Ultralight can fail a cached miss before a listener attaches.
   The parentNode guard is load-bearing: the failure arrives asynchronously, so
   any renderList() in between leaves this <img> detached, and an unguarded
   handler would throw an uncaught TypeError on every missing icon. */
const HK_ICO_ERR = ' onerror="var b=this.parentNode;if(b){b.classList.add(&quot;empty&quot;);' +
  'b.removeChild(this);}"';

function hkIconHtml(e, slotted) {
  const src = hkIconSrc(e.icon);
  const tag = ui.edit ? 'button' : 'span';
  const title = ui.edit ? (src ? ' title="Change icon"' : ' title="Set an icon"') : '';
  if (!src) {
    if (!ui.edit && !slotted) return '';
    return '<' + tag + ' class="hk-ico empty"' + title + '></' + tag + '>';
  }
  return '<' + tag + ' class="hk-ico"' + title + '><img src="' + esc(src) +
    '" alt="" draggable="false"' + HK_ICO_ERR + '></' + tag + '>';
}

/* ---- C++ -> view ---- */

/* The whole sh_index.json. Only `catalog` is kept: byForm/generic exist to feed
   the Spell Deck's automatic resolve chain, and a hotkey has no automatic
   icon — keeping them would be dead memory and an invitation to add one. */
window.hdIconIndex = function (idx) {
  idx = parsePayload(idx);
  ICONS.catalog = (idx && Array.isArray(idx.catalog) ? idx.catalog : []).map((c) => ({
    file: normPath(c.file), atlas: c.atlas || '', label: c.label || '', kind: c.kind || '', key: c.key || '',
  })).filter((c) => c.file);
  /* The other TWO maps in the same file, which this used to discard: byForm
     (1,713 exact spell→icon rows) and generic (205 school/tier fallbacks).
     The picker only ever needed the flat catalog, so nothing else read them —
     which is why a spell pinned to the shelf or the wheel drew a bare ✦ while
     its real Spell-Hotbar art sat in this view's own icons/sh tree. */
  ICONS.byForm = (idx && idx.byForm && typeof idx.byForm === 'object') ? idx.byForm : {};
  ICONS.generic = (idx && idx.generic && typeof idx.generic === 'object') ? idx.generic : {};
  if (hkIcon.open) { hkIcon.shown = HK_ICON_PAGE; renderHkIconPicker(); }
};

/* ---- spell art, for anything outside the Spell Deck ---------------------- *
 * The Spell Deck resolves its own icons in view/MagicDeck/app.js. This is the
 * DECK view's twin, and it exists because the icon library is mirrored into
 * BOTH view trees (C++ MirrorCustomIcons + the deployer's robocopy of
 * icons/sh), so "icons/sh/…" means the right file in whichever view renders it.
 *
 * Deliberately the exact-match half of that ladder, not a second copy of the
 * whole thing: byForm is keyed on the durable (plugin, localId) pair and
 * covers every spell the atlases know, and the omni spell index already
 * carries the ENGINE's own school/element/tier metadata (FillIconMeta, the
 * same C++ that feeds the Spell Deck), so the generic fallback lands without
 * needing the Spell Deck's name-keyword guessing ladder. A spell that reaches
 * neither map gets the glyph — the same answer it got before, so nothing
 * regresses. Returns '' rather than null: callers pass it straight into an
 * `icon` field that is documented as a string.
 */
const SPELL_TIER_KEY = {
  novice: 'NOVICE', apprentice: 'APPRENTICE', adept: 'ADEPT', expert: 'EXPERT', master: 'MASTER',
};
window.hdSpellIconPath = function (m) {
  if (!m) return '';
  if (m.icon) return normPath(m.icon);                    // an explicit override wins
  const byForm = ICONS.byForm || {};
  if (m.plugin && m.localId != null) {
    const k = String(m.plugin).toLowerCase() + '|' + ((m.localId >>> 0).toString(16));
    if (byForm[k]) return normPath(byForm[k]);
  }
  const gen = ICONS.generic || {};
  let g = '';
  if (m.type === 'voice') g = 'SHOUT_GENERIC';
  else if (m.type === 'power') g = 'GREATER_POWER';
  else if (m.type === 'lesser') g = 'LESSER_POWER';
  else if (!m.type && m.slot === 'voice') g = 'GREATER_POWER';
  else {
    const t = SPELL_TIER_KEY[m.tier] || 'ADEPT';
    const school = m.school || '';
    const el = m.element || '';
    if (school === 'destruction' && (el === 'fire' || el === 'frost' || el === 'shock'))
      g = 'DESTRUCTION_' + el.toUpperCase() + '_' + t;
    else if (school) g = school.toUpperCase() + '_' + t;
  }
  return (g && gen[g]) ? normPath(gen[g]) : '';
};

window.hdIcons = function (r) {
  r = parsePayload(r);
  ICONS.custom = ((r && r.custom) || []).map((c) => ({
    file: normPath(c.file), label: c.label || '',
  })).filter((c) => c.file);
  if (hkIcon.open) { hkIcon.shown = HK_ICON_PAGE; renderHkIconPicker(); }
};

/* ---- the picker ---- *
 * Ported from the Spell Deck (view/MagicDeck/app.js openIconPicker…
 * appendMoreIcons) minus the "Auto" tile — hotkeys have no automatic
 * resolution, so the clearing tile is an explicit "None". The library renders
 * in HK_ICON_PAGE chunks appended on scroll, so opening it never decodes ~1,900
 * images at once. */

function pickerEntry() { return state.entries.find((x) => x.id === hkIcon.id) || null; }

function openHkIconPicker(entry) {
  if (window.FolPane) FolPane.closeMenus();   // no 60-layer menu under the backdrop
  hkIcon.open = true;
  hkIcon.id = entry.id;
  hkIcon.filter = '';
  hkIcon.shown = HK_ICON_PAGE;
  $('hk-icon-name').textContent = entry.name || 'hotkey';
  $('hk-icon-search').value = '';
  $('hk-icon-modal').classList.remove('hidden');
  renderHkIconPicker();
  /* Claim the existing "a modal owns this view" channel. C++ sets g_capturing
     from hdCapture, and RefreshDeckIcons() (the Deck Portal's live sidecar push)
     already early-returns while that flag is up — so a phone edit landing
     mid-pick can no longer re-push hdOpen and yank this picker shut. It also
     routes Esc / the open key to the modal instead of the palette, which is the
     behaviour we want here anyway (✕ and a backdrop click are the other exits). */
  toGame('hdCapture', '1');
  setTimeout(() => { const s = $('hk-icon-search'); if (s) s.focus(); }, 30);
}

function closeHkIconPicker() {
  const wasOpen = hkIcon.open;
  hkIcon.open = false;
  hkIcon.id = null;
  hkIcon.filter = '';
  const m = $('hk-icon-modal');
  if (m) m.classList.add('hidden');
  /* release the flag — but never out from under a live press-to-rebind capture,
     which owns it for real */
  if (wasOpen && !ui.capture) toGame('hdCapture', '0');
}

function hkPickIcon(file) {
  const e = pickerEntry();
  closeHkIconPicker();
  if (!e) return;
  e.icon = file || '';
  save();          // the existing whole-config round-trip; C++ persists entries[].icon
  render();
  /* hand focus back to the slot that opened the picker (render() just rebuilt
     it) instead of dropping it on <body> or stealing it into the filter box */
  const box = $('list').querySelector('[data-id="' + e.id + '"] .hk-ico');
  if (box && box.focus) box.focus();
  toast(file ? 'Icon set for ' + e.name : 'Icon cleared');
}

function hkIconMatches(q) {
  return (c) => !q || (c.label || '').toLowerCase().indexOf(q) >= 0 ||
    (c.atlas || '').toLowerCase().indexOf(q) >= 0 || (c.key || '').toLowerCase().indexOf(q) >= 0;
}

function hkIconTile(entry, opts) {
  opts = opts || {};
  const wrap = hEl('span', { class: 'tile-img' });
  if (opts.none) wrap.append(hEl('span', { class: 'tile-none', 'aria-hidden': 'true' }, '∅'));
  else wrap.append(hEl('img', { src: hkIconSrc(entry.file), alt: '', draggable: 'false' }));
  return hEl('button', {
    class: 'hk-icon-tile' + (opts.sel ? ' sel' : '') + (opts.none ? ' none' : ''),
    title: opts.none ? 'No icon on this hotkey'
      : (entry.label || entry.file) + (entry.atlas ? '  ·  ' + entry.atlas : ''),
    onClick: () => hkPickIcon(opts.none ? '' : entry.file),
  }, wrap, hEl('span', { class: 'tile-lbl' }, opts.none ? 'None' : (entry.label || entry.file)));
}

function renderHkIconPicker() {
  const grid = $('hk-icon-grid');
  const e = pickerEntry();
  if (!grid || !e) return;
  grid.textContent = '';
  const q = hkIcon.filter.trim().toLowerCase();
  const cur = normPath(e.icon || '');

  /* "None" is unconditional — a filter must never make clearing unreachable */
  grid.append(hEl('div', { class: 'hk-icon-sect' }, 'None'));
  grid.append(hkIconTile(null, { none: true, sel: !cur }));

  const custom = ICONS.custom.filter(hkIconMatches(q));
  if (custom.length) {
    grid.append(hEl('div', { class: 'hk-icon-sect' }, 'Your icons (icons/custom)'));
    custom.forEach((c) => grid.append(hkIconTile(c, { sel: cur === c.file })));
  }

  const lib = ICONS.catalog.filter(hkIconMatches(q));
  grid.append(hEl('div', { class: 'hk-icon-sect' }, 'Icon library'));
  if (!lib.length) {
    grid.append(hEl('div', { class: 'hk-icon-more' }, ICONS.catalog.length
      ? 'No icon matches “' + hkIcon.filter.trim() + '”'
      : 'Icon library not installed — hotkeys can still use your own icons'));
  } else {
    lib.slice(0, hkIcon.shown).forEach((c) => grid.append(hkIconTile(c, { sel: cur === c.file })));
    if (lib.length > hkIcon.shown)
      grid.append(hEl('div', { class: 'hk-icon-more' },
        'Showing ' + hkIcon.shown + ' of ' + lib.length + ' — scroll for more'));
  }
  $('hk-icon-count').textContent =
    (ICONS.catalog.length ? lib.length + ' library' : 'no library') +
    (ICONS.custom.length ? ' · ' + ICONS.custom.length + ' custom' : '');
  grid.scrollTop = 0;
}

/* scroll-append the next chunk (no rebuild — keeps the scroll position) */
function appendMoreHkIcons() {
  const grid = $('hk-icon-grid');
  const e = pickerEntry();
  if (!grid || !e) return;
  const q = hkIcon.filter.trim().toLowerCase();
  const lib = ICONS.catalog.filter(hkIconMatches(q));
  if (hkIcon.shown >= lib.length) return;
  const more = grid.querySelector('.hk-icon-more');
  if (more) more.remove();
  const cur = normPath(e.icon || '');
  const next = lib.slice(hkIcon.shown, hkIcon.shown + HK_ICON_PAGE);
  hkIcon.shown += next.length;
  next.forEach((c) => grid.append(hkIconTile(c, { sel: cur === c.file })));
  if (lib.length > hkIcon.shown)
    grid.append(hEl('div', { class: 'hk-icon-more' },
      'Showing ' + hkIcon.shown + ' of ' + lib.length + ' — scroll for more'));
}

/* ================================================== game -> view API ==== */

window.hdOpen = function (cfg) {
  // C++ re-pushes this same payload for LIVE updates (a phone icon assignment via
  // the portal poller). When the deck is already up, treat it as a data refresh:
  // running the open-time resets below would blow away the user's tab, edit mode,
  // half-typed rename, selection and open icon picker — and would bypass setTab(),
  // leaving a pane's context menu painted over a different pane.
  const wasVisible = ui.visible;
  try {
    if (typeof cfg === 'string') cfg = JSON.parse(cfg);
    if (cfg && typeof cfg === 'object') {
      if (Array.isArray(cfg.entries)) state.entries = cfg.entries;
      /* Runtime mod-detection map (which integrations are installed). Only
         replaced when C++ sends one, so a live data-refresh that omits it keeps
         the last known detection. */
      if (cfg.detected && typeof cfg.detected === 'object') state.detected = cfg.detected;
      state.categories = Array.isArray(cfg.categories)
        ? cfg.categories.filter((c) => typeof c === 'string' && c)
        : [];
      state.notes = typeof cfg.notes === 'string' ? cfg.notes : '';
      if (cfg.settings) state.settings = Object.assign(state.settings, cfg.settings);
      /* shelf slice — replace wholesale like entries: the file is the truth
         on open (the portal or a hand-edit may have touched it while the
         deck was closed). HDShelf.onOpen() below normalises the shape. */
      if (cfg.shelf && typeof cfg.shelf === 'object' && !Array.isArray(cfg.shelf))
        state.shelf = cfg.shelf;
      /* wheel slice — same wholesale replace, same reason (the file is the
         truth on open). HDWheel's slice() normalises whatever shape arrives. */
      if (cfg.wheel && typeof cfg.wheel === 'object' && !Array.isArray(cfg.wheel))
        state.wheel = cfg.wheel;
    }
  } catch (err) { toGame('hdLog', 'hdOpen parse error: ' + err); }
  applyScale();  // apply saved menu scale immediately on open
  /* Same beat, for the per-tab sizes: hdOpen is also re-pushed as a LIVE
     refresh, and Object.assign above replaces settings.tabScales wholesale, so
     the CSS variables have to be re-derived from whatever just arrived or a
     refresh would silently paint every tab back at 100%. */
  if (window.HDScale) HDScale.load(state.settings.tabScales);
  applyPanelSize();
  ui.visible = true;
  if (!wasVisible) {
    ui.openedAt = Date.now();   // hdShowTab's toggle-close must not eat the opening keystroke
    /* Shared with the panes: followers-pane reads it so its F7 NPC-focus can
       tell a fresh open (fdTarget landing right after hdOpen) from a later
       crosshair change while the deck sits open. */
    window.__hdOpenedAt = ui.openedAt;
    ui.tab = 'home';      // Home (the card launcher) is the default landing tab…
    ui.hkTab = 'all';
    ui.edit = false;
    ui.search = '';
    ui.sel = 0;
    ui.capture = null;
    closeHkIconPicker();
    ui.confirmDelete = null;
    ui.tabAdding = false;
    ui.tabRename = null;
    ui.confirmTabDelete = null;
    ui.qMode = 'npc';       // you just looked at someone — start there
    ui.qSearch = '';
    ui.qList = null;
    ui.qNpc = null;
    ui.qDetail = null;
    ui.qNote = '';
    ui.qConfirmStage = null;
    ui.qLoading = false;
    const qs = $('q-search');
    if (qs) qs.value = '';
    $('search').value = '';

    /* …then land on the tab you CLOSED on — Home is only the DEFAULT, the
       last-tab memory still wins (Rober, 2026-08-05). Through setTab, so a pane
       tab runs its own onShow (fresh roster / occupancy / SOES read) instead of
       waking up stale. Unlike before, 'all' (Hotkeys) is restored too: it used
       to be excluded only because it WAS the default, and the default is now
       'home'. A hotkey category deleted while closed falls back to the reset. */
    const back = ui.lastClosedTab || '';
    if (back) {
      const isCat = back.indexOf('cat:') === 0;
      if (!isCat || state.categories.indexOf(back.slice(4)) !== -1)
        setTab(back);
    }
    /* Default-home open (nothing remembered, or you closed on Home): setTab is a
       no-op when ui.tab is already 'home', so fire its onShow directly. */
    if (ui.tab === 'home' && window.HomePane) HomePane.onShow();
  }
  document.body.classList.add('open');
  syncNarrow();   // the panel measures 0 while closed — re-measure now it's visible
  render();
  /* after body.open lands — the shelf is display:none until then, and its
     onOpen warms the providers its pins need (the spells slice is on-demand) */
  if (window.HDShelf) HDShelf.onOpen(!wasVisible);
  if (!wasVisible) setTimeout(focusSearch, 30);
};

window.hdClosed = function () {
  /* Also flushed HERE, not only in requestClose: C++ closes the palette on its
     own for the container ops (inventory / spare), for a quick-fire, and for a
     deep-open key — none of which come through requestClose. A pending edit
     must not depend on WHICH route closed the deck. */
  flushSave();
  /* the ⤢ menu-size popover is body-level and fixed — without this it would
     outlive the panel and float over the game */
  var usp = $('uiscale-pop');
  if (usp) usp.classList.add('hidden');
  /* F7 reopens where you LEFT — the tab you closed on is the one you were
     working in. Recorded here, restored in hdOpen; the deep-open keys
     (F14/F15…) still land on their own tab because they arrive as an
     hdShowTab AFTER the open and setTab overrides. */
  ui.lastClosedTab = ui.tab;
  ui.visible = false;
  ui.capture = null;
  ui.itemSource = null;      // open-time fact; a stale one must not greet the next open
  renderItemSource();
  closeHkIconPicker();
  /* Pane lightboxes hang off document.body, so `body.open` going away does NOT
     take them with it: the next open would greet you with a full-screen
     overlay from last time, eating every click. Narrow teardown calls, never
     onHide() — closing the deck must not also wipe a pane's filter or edits. */
  if (window.FolPane && FolPane._closeLightbox) FolPane._closeLightbox();
  if (window.FolPane && FolPane._closeHudModal) FolPane._closeHudModal();
  if (window.FolPane && FolPane._closeWornLightbox) FolPane._closeWornLightbox();
  if (window.DomainsPane && DomainsPane.closeOverlays) DomainsPane.closeOverlays();
  if (window.ContainersPane && ContainersPane.closeOverlays) ContainersPane.closeOverlays();
  if (window.HDShelf) HDShelf.closeOverlays();   // its context menu hangs off body too
  /* The wheel is a body-level full-screen overlay, so `body.open` going away
     does NOT hide it — without this the next open would greet you with last
     session's ring floating over the deck, eating every click. */
  if (window.HDWheel) HDWheel.onDeckClosed();
  /* The ⛨ Outfit dock draws INSIDE #panel, so closing the deck hides it — but
     hiding is not closing: it would still hold hdCapture (C++ keeps routing
     keys to the view), and the next F7 would greet you with a card whose ⛨ is
     lit and whose first click merely closes a popout you cannot see. */
  if (window.HDOutfit) HDOutfit.close();
  /* Same for the 📜 Quests modal — hiding is not closing, and a modal left
     "open" would keep hdCapture and light the card's 📜 on the next F7. */
  if (window.HDQuests) HDQuests.close();
  PDrag.cancel();
  gripUp();
  document.body.classList.remove('open');
  /* F7 NPC-focus hides the global tab bar via a body class; a close must never
     leave it set, or the next open (or another view) starts with no tabs. */
  document.body.classList.remove('hd-npcfocus', 'hd-focusroster');
  /* …and clear the FLAG behind that class, or the next open re-paints a stale
     focus over an empty card when there is no crosshair NPC. */
  if (window.FolPane && FolPane._resetFocus) FolPane._resetFocus();
  closeMoreMenu();
  $('capture-modal').classList.add('hidden');
};

window.hdSaved = function (ok) {
  const good = ok === true || ok === 'true';
  if (!good) toast('Save failed — see HotkeyDeck.log');
};

/* C++ forwards F13–F24 presses here while the capture modal is open (Ultralight
   never receives engine-injected keys). Open-key capture binds the faithful code;
   ext capture treats "the key pressed itself" as choosing its raw code. */
window.hdExtKey = function (info) {
  if (!ui.visible || !ui.capture) return;
  const mode = ui.capture.mode;
  /* Every mode here is an INPUT binding — "what press fires this" — so all of
     them take the faithful extended code. `trigger` and the mod* slots used to
     fall through to the refusal at the bottom, which is why binding Full Save
     to G12 (F22) was impossible by either route. The one mode still refused is
     an entry's own key, because that is what the entry SENDS. */
  if (mode === 'open' || mode === 'folopen' || mode === 'trigger' ||
      mode === 'modshift' || mode === 'modctrl' || mode === 'modalt') {
    applyCapture({ device: 'keyboard', code: info.raw, mods: [], keyLabel: info.name });
    return;
  }
  if (mode === 'ext') {
    if (info.name === ui.capture.id) {
      applyCapture({ device: 'keyboard', code: EXT_RAW[info.name], mods: [], keyLabel: info.name + ' (raw)' });
    } else {
      toast('That was ' + info.name + ' — press a standard key (or ' + ui.capture.id + ' itself for raw)');
    }
    return;
  }
  toast(info.name + ' can be a trigger or the open key — entries fire standard keys');
};

/* C++ forwards Mouse4/Mouse5 presses while capturing (Ultralight doesn't see
   X-button events in-game; middle-click arrives natively via onMouseDown). */
window.hdNativeMouse = function (info) {
  if (!ui.visible || !ui.capture) return;
  if (ui.capture.mode === 'ext') {
    toast('Keyboard keys only — F-keys can’t fire mouse buttons');
    return;
  }
  applyCapture({ device: 'mouse', code: info.code, mods: [], keyLabel: info.label });
};

/* ---- quests: C++ -> view ---- */

/* shared by the quest and icon receivers — C++ may hand us a JSON string or an
   already-parsed object depending on how PrismaUI marshals the Invoke */
function parsePayload(p) {
  try { return typeof p === 'string' ? JSON.parse(p) : p; } catch (err) {
    toGame('hdLog', 'payload parse error: ' + err);
    return null;
  }
}

window.hdQuests = function (payload) {
  /* Omni gets first refusal: when ITS lazy quest search asked, the reply is
     merged into the overlay and must not clobber the Quests tab's state. */
  if (window.HDOmni && HDOmni.takeQuestReply(payload)) return;
  /* Then the F7 card's 📜 modal, on the same terms: it claims a reply only
     when IT asked (hd-quests.js tracks that), so the tab's own list is never
     stolen — and the modal's list is never clobbered by the tab's. */
  if (window.HDQuests && HDQuests.takeList(payload)) return;
  const p = parsePayload(payload);
  ui.qLoading = false;
  ui.qList = p || { quests: [] };
  ui.qNpc = (p && p.npc) ? p.npc : null;
  if (ui.tab === 'quests') renderQuests();
};

/* NB: request names (hdQuestList/hdQuestSearch/hdQuestGet/hdQuestSetStage/
   hdQuestAction) and response names (hdQuests/hdQuestInfo/hdQuestResult) must
   stay disjoint — PrismaUI installs each JS listener as a global of that name,
   so a shared name would clobber the handler. */
window.hdQuestInfo = function (payload) {
  if (window.HDQuests && HDQuests.takeDetail(payload)) return;   // the F7 📜 modal asked
  const p = parsePayload(payload);
  ui.qDetail = p || { ok: false, message: 'Bad payload — see HotkeyDeck.log' };
  if (ui.tab === 'quests') renderQuests();
};

window.hdQuestResult = function (payload) {
  /* The modal keeps the verdict IN PLACE rather than as a toast: "the target
     alias is empty" is the sentence you actually wanted, and a toast lands
     behind a modal. */
  if (window.HDQuests && HDQuests.takeResult(payload)) return;
  const p = parsePayload(payload);
  ui.qNote = (p && p.message) || '';
  if (ui.qNote) toast(ui.qNote);
  if (ui.tab === 'quests') renderQuests();
};

/* ============================================================== init ==== */

function init() {
  buildNumpad();
  if (window.FolPane) FolPane.init();

  /* ---- per-tab size controls ----
     hd-scale.js owns the clamp, the CSS variables and the −/＋/reset rows; it
     needs only somewhere to keep the numbers and something to call when they
     change. saveSoon (not save) because holding ＋ is a burst of clicks and one
     write per press would be one hdSave per press. */
  if (window.HDScale) {
    HDScale.bind({
      store: function () { return state.settings; },
      save: saveSoon,
    });
    /* The deck's own row-icon size lives in the existing settings card, beside
       Menu scale, rather than in the shared card — that card is for tabs with
       no settings of their own. */
    HDScale.mount($('deck-img-row'), 'deck', 'img');
  }

  /* ---- Omni (universal Search + Ask) ---- *
   * app.js hands omni a small, explicit environment instead of letting it
   * grope around in our internals; everything else omni knows comes from the
   * provider registry (each pane registers its own). */
  if (window.HDOmni) {
    HDOmni.hookInto({
      state: state,
      setTab: setTab,
      setSearch: function (q) {
        ui.search = String(q || '');
        const s = $('search');
        if (s) s.value = ui.search;
        ui.sel = 0;
        if (isHotkeyTab()) renderList();
      },
      fireEntry: function (id) { fireEntry(id, null); },
      fireAction: function (action) {
        const en = state.entries.find((x) => x.device === 'action' && x.action === action);
        if (en) fireEntry(en.id, null);
        else toast('Not on the deck yet — Edit → ＋ Action to add it');
      },
      deckActions: DECK_ACTIONS,
      openSpells: function () { toGame('hdOpenSpells'); },
    });
    /* omni's quest results land here: the Quests tab in search mode, with the
       clicked quest's detail already loading */
    window.__omniOpenQuest = function (qu) {
      setTab('quests');
      ui.qMode = 'search';
      ui.qSearch = qu.name || '';
      const qs = $('q-search');
      if (qs) qs.value = ui.qSearch;
      ui.qDetail = { ok: true, name: qu.name || 'Loading…', formId: qu.formId, status: qu.status || '',
                     currentStage: qu.currentStage || 0, stages: [], aliases: [], objectives: [] };
      toGame('hdQuestGet', qu.formId);
      renderQuests();
    };
    const ob = $('omni-btn');
    if (ob) ob.addEventListener('click', function () { HDOmni.open('search'); });
  }

  /* ---- Favorites Shelf ---- *
   * Same explicit-environment contract as omni above. The shelf resolves its
   * pins through HDOmni's provider registry; from app.js it only needs the
   * state (for its slice), the debounced save, and the two doors it opens. */
  if (window.HDShelf) {
    HDShelf.hookInto({
      state: state,
      saveSoon: saveSoon,
      setTab: setTab,
      openOmni: function () { if (window.HDOmni) HDOmni.open('search'); },
    });
  }

  /* ---- Wheel Menu ---- *
   * Same explicit-environment contract. `closeDeck` is the one thing it needs
   * beyond the shelf's set: a wedge that FIRED (equip, cast, travel) ends the
   * errand, and a radial menu that leaves you staring at the deck afterwards
   * has missed its own point. */
  if (window.HDWheel) {
    HDWheel.hookInto({
      state: state,
      saveSoon: saveSoon,
      setTab: setTab,
      toGame: toGame,
      closeDeck: requestClose,
    });
  }

  /* Home page (the default landing tab). It reaches the deck through the same
     small host contract HDShelf/HDOmni use — setTab to open a system's tab,
     toGame for the Spell Deck launcher / hdHistory, openOmni for the universal
     search bar, and the live hotkey count for its Hotkeys card. */
  if (window.HomePane) {
    HomePane.hookInto({
      setTab: setTab,
      toGame: toGame,
      openOmni: function (mode) { if (window.HDOmni) HDOmni.open(mode || 'search'); },
      hotkeyCount: function () { return (state.entries || []).length; },
      /* Notes now lives as a Home drawer, off the tab strip — read/write the
         same state.notes the (now tab-less) notes-pane used, through saveSoon. */
      getNotes: function () { return state.notes || ''; },
      setNotes: function (v) { state.notes = typeof v === 'string' ? v : ''; saveSoon();
        var ta = $('notes-ta'); if (ta && document.activeElement !== ta) ta.value = state.notes; },
      /* Home-card order PERSISTS INSIDE THE SHELF BLOB (state.shelf.home.order)
         for exactly the reason tabbarPrefs() does — C++ parses `settings`
         field-by-field so a new settings key would be dropped on save, but the
         shelf slice round-trips as a raw json object. home-pane.js sanitizes on
         read (unknown ids dropped, new systems appended), so we just hand back
         the raw stored array. home-card-reorder */
      getHomeOrder: function () { return homePrefs().order; },
      setHomeOrder: function (ids) {
        homePrefs().order = Array.isArray(ids) ? ids.slice() : [];
        saveSoon();
      },
      /* the app's SYS_TABS ids, so Home's dev audit can flag a system tab it
         forgot to carry (Task 2 — single source of truth check) */
      sysTabs: function () { return SYS_TABS.map(function (s) { return s.tab; }); },
    });
  }

  $('close-btn').addEventListener('click', requestClose);
  $('edit-btn').addEventListener('click', toggleEdit);
  $('add-btn').addEventListener('click', () => {
    const id = newId();
    state.entries.push({ id: id, name: 'New Hotkey', desc: '', device: 'keyboard', code: 0, label: '', mods: [],
      icon: '', category: activeCategory() || '' });  // new entries join the tab you're on
    render();
    startCapture('add', id);
  });
  $('rc-clear').addEventListener('click', () => { toGame('hdHistoryClear', ''); });
  $('add-action-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openActionPicker(e.currentTarget);
  });
  $('add-vkey-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openVKeyPicker(e.currentTarget, null);
  });
  $('openkey-btn').addEventListener('click', () => startCapture('open', null));
  ['shift', 'ctrl', 'alt'].forEach((m) => {
    $('mod' + m + '-btn').addEventListener('click', () => startCapture('mod' + m, null));
    $('mod' + m + '-clear').addEventListener('click', () => { const sl = modSlot(m); sl.code = 0; sl.label = ''; save(); render(); });
  });
  $('ext-toggle').addEventListener('click', () => { ui.extOpen = !ui.extOpen; render(); });
  $('settings-toggle').addEventListener('click', () => { ui.setOpen = !ui.setOpen; render(); });
  $('ext-cb').addEventListener('change', (e) => { extKeysState().enabled = e.target.checked; save(); render(); });
  $('ext-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.ext) return;
    const name = btn.dataset.ext;
    const ek = extKeysState();
    if (btn.classList.contains('ext-target')) { startCapture('ext', name); return; }
    if (btn.classList.contains('ext-raw')) { ek.map[name] = EXT_RAW[name]; save(); render(); return; }
    if (btn.classList.contains('ext-kill')) { ek.map[name] = 0; save(); render(); return; }
  });
  $('capture-cancel').addEventListener('click', () => endCapture(false));
  /* Key picker — assign a key without pressing it (Home/End/PgUp/PgDn/arrows, or
     a key the keyboard lacks). Funnels through applyCapture like a real press. */
  $('capture-pick').addEventListener('click', () => {
    if (ui.capture && ui.capture.picking) closeKeyPicker(); else openKeyPicker();
  });
  $('capture-pick-filter').addEventListener('input', (e) => {
    ui.keyPickFilter = e.target.value; renderKeyPick();
  });
  $('capture-pick-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const top = $('capture-pick-list').querySelector('.cp-row');
      if (top) top.click();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closeKeyPicker();   // back to press-to-rebind, not a full cancel
    }
  });
  $('capture-pick-list').addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.cp-row');
    if (!row) return;
    selectPickedKey(parseInt(row.dataset.code, 10), row.textContent);
  });

  $('pause-cb').addEventListener('change', (e) => {
    state.settings.pauseOnOpen = e.target.checked;
    if ($('smoothpause-cb')) $('smoothpause-cb').disabled = !e.target.checked;
    save();
  });
  if ($('smoothpause-cb')) $('smoothpause-cb').addEventListener('change', (e) => {
    state.settings.smoothPause = e.target.checked; save();
  });
  $('close-cb').addEventListener('change', (e) => { state.settings.closeAfterFire = e.target.checked; save(); });
  $('sticky-cb').addEventListener('change', (e) => { state.settings.stickyNpMods = e.target.checked; save(); });
  /* C++ owns the DECISION (it has the crosshair snapshot at open); this
     only records the preference for it to read on the next open. */
  $('tgtfol-cb').addEventListener('change', (e) => { state.settings.targetOpensFollowers = e.target.checked; save(); });
  $('scale-down').addEventListener('click', () => setScale(state.settings.uiScale - SCALE_STEP, true));
  $('scale-up').addEventListener('click', () => setScale(state.settings.uiScale + SCALE_STEP, true));
  $('scale-reset').addEventListener('click', () => setScale(1, true));
  $('resize-grip').addEventListener('mousedown', gripDown);
  $('resize-grip').addEventListener('dblclick', resetPanelSize);

  $('list').addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);

  /* both nav rows share the same three handlers — they are container-agnostic
     (everything goes through e.target.closest). The category ◂/▸/✎/✕ tools and
     the inline add/rename input now live in row 2, so without the second
     binding renames would silently stop committing. */
  ['tabs', 'hk-tabs'].forEach((id) => {
    const n = $(id);
    if (!n) return;
    n.addEventListener('click', onTabsClick);
    n.addEventListener('keydown', onTabsKey);
    n.addEventListener('focusout', onTabsFocusOut);
  });
  /* Click anywhere that isn't the More menu or its button dismisses the menu.
     Capture phase so it fires ahead of pane handlers; the More button's own
     click is filtered out so it can still toggle. */
  document.addEventListener('mousedown', (e) => {
    if (!ui.moreOpen) return;
    const menu = $('tab-more-menu');
    if (menu && menu.contains(e.target)) return;
    if (e.target.closest && e.target.closest('[data-act="more"]')) return;
    closeMoreMenu();
  }, true);
  document.querySelectorAll('.modkey').forEach((m) => m.addEventListener('click', onModClick));

  /* icon picker */
  $('hk-icon-close').addEventListener('click', () => { closeHkIconPicker(); render(); });
  $('hk-icon-refresh').addEventListener('click', () => { toGame('hdIconList'); toast('Re-scanning custom icons…'); });
  $('hk-icon-search').addEventListener('input', (e) => {
    hkIcon.filter = e.target.value; hkIcon.shown = HK_ICON_PAGE; renderHkIconPicker();
  });
  $('hk-icon-grid').addEventListener('scroll', (e) => {
    const g = e.target;
    if (g.scrollTop + g.clientHeight > g.scrollHeight - 120) appendMoreHkIcons();
  });
  $('hk-icon-modal').addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.target === $('hk-icon-modal')) { closeHkIconPicker(); render(); }
  });

  $('list').addEventListener('click', onListClick);
  $('list').addEventListener('input', onListInput);
  $('list').addEventListener('change', onListChange);
  $('numpad-grid').addEventListener('click', onNumpadClick);
  $('quests-pane').addEventListener('click', onQuestsClick);
  $('q-search').addEventListener('input', (e) => { ui.qSearch = e.target.value; requestQuestsSoon(); });
  $('search').addEventListener('input', (e) => { ui.search = e.target.value; ui.sel = 0; renderList(); });
  $('notes-ta').addEventListener('input', (e) => { state.notes = e.target.value; saveSoon(); });

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  toGame('hdLog', 'HotkeyDeck view booted');

  if (DEV) {
    /* mocked fd* bridge so the Followers tab is browsable in the dev preview */
    const M = (name, extra) => Object.assign({
      name, override: '', original: name, desc: '', tracked: false,
      resolved: true, inWorld: true, following: false, dead: false, form: '', formId: '0x0',
    }, extra || {});
    const FOL_FAKE = { ok: true, state: { total: 9, categories: [
      { index: 1, name: 'Housecarls', override: 'Housecarls', original: 'Category 01', hotkey: -1, inMagicMenu: true,
        members: [M('Olfina Gray-Mane', { desc: 'Gray-Mane heir — nobody\'s trophy', following: true, formId: '0x0001A001' }), M('Hulda', { formId: '0x0001A002' }), M('Irileth', { desc: 'Still the Jarl\'s blade first', formId: '0x0001A003' })] },
      { index: 2, name: 'Mercenaries', override: 'Mercenaries', original: 'Category 02', hotkey: -1, inMagicMenu: true,
        members: [M('Jenassa', { desc: 'Dunmer sellsword — hired in Whiterun', following: true }), M('Marcurio', { desc: 'Imperial mage for hire' }), M('Belrand', { desc: 'Nord spellsword — Solitude' })] },
      { index: 3, name: 'Household', override: 'Household', original: 'Category 03', hotkey: -1, inMagicMenu: false,
        members: [M('Camilla Valerius', { following: true }), M('Sylgja', { resolved: false, inWorld: false }), M('Knight of Rot', { dead: true, desc: 'Reanimated — technically dead' })] },
      { index: 4, name: '', override: '', original: 'Category 04', hotkey: -1, inMagicMenu: false, members: [] },
    ] } };
    /* Read-only NFF / My Home is Your Home NG snapshot (src/nff_bridge.cpp).
       Deliberately covers all three shapes: NFF base only, MHiYH only, and
       both disagreeing (chip shows NFF, tooltip names the other). */
    const FOL_NFF = { ok: true, nff: true, mhiyh: true, members: {
      '0x0001a001': { nff: { managed: true, home: { i: 3, name: 'Riverwood' }, outfit: { has: true } } },
      '0x0001a002': { mhiyh: { home: { name: 'The Bannered Mare' }, flagged: true } },
      '0x0001a003': { nff: { managed: true, home: { i: 0, name: 'Dragonsreach' }, outfit: { has: false } },
                      mhiyh: { home: { name: 'Breezehome' }, flagged: true } },
    } };
    /* The crosshair NPC. In the real plugin this rides on the OPEN payload
       (OpenPalette pushes fdTarget), NOT on fdRefresh — the Hotkeys-tab
       quick-follower card needs it without the Followers pane ever being
       shown. Seed it the same way here or the sandbox reproduces the empty
       "look at an NPC first" state instead of the thing you want to look at. */
    const FOL_TARGET = { formId: 0x13495, name: 'Uthgerd the Unbroken',
                         following: false, dead: false };
    const FOL_WORN = { ok: true, formId: '', who: 'Uthgerd the Unbroken',
      following: false, dead: false, outfit: 'FarmClothes', items: [
      { formId: '0x013938', plugin: 'Skyrim.esm', name: 'Banded Iron Armor', kind: 'armor',  count: 1,  outfit: true  },
      { formId: '0x013948', plugin: 'Skyrim.esm', name: 'Iron Boots',        kind: 'armor',  count: 1,  outfit: true  },
      { formId: '0x0136d5', plugin: 'Skyrim.esm', name: 'Iron Gauntlets',    kind: 'armor',  count: 1,  outfit: false },
      { formId: '0x0139b9', plugin: 'Skyrim.esm', name: 'Steel Greatsword',  kind: 'weapon', count: 1,  outfit: false },
      { formId: '0x0139af', plugin: 'Skyrim.esm', name: 'Hunting Bow',       kind: 'weapon', count: 1,  outfit: false },
      { formId: '0x01397d', plugin: 'Skyrim.esm', name: 'Steel Arrow',       kind: 'ammo',   count: 43, outfit: false },
      { formId: '0x0001d4ec', plugin: 'Skyrim.esm', name: 'Torch',           kind: 'light',  count: 1,  outfit: false },
    ] };
    /* Mirror the real OPEN payload's order: roster, then NFF facts, then the
       crosshair. The plugin pushes fdState at open precisely so the quick card
       on the Hotkeys tab can say who the target is and offer the Move ops; seed
       it the same way or the sandbox calls every follower "unfiled" and shows
       none of them — which is exactly the bug this ordering was fixed for. */
    window.hdRecent({ ok: true, sinceLaunch: true, count: 5, max: 300, items: [
      { name: 'Weapon Wheel', label: 'Del', category: 'Combat', source: 'quickfire', times: 1, at: '14:02:11', ago: 'just now' },
      { name: 'Full Save',    label: 'Save', category: 'Misc',   source: 'action',    times: 1, at: '14:01:55', ago: '40s' },
      { name: 'Stance 2',     label: '7',    category: 'Combat', source: 'entry',     times: 4, at: '14:01:30', ago: '2m' },
      { name: 'Num /',        label: 'Num /', category: 'Numpad', source: 'numpad',   times: 1, at: '13:58:02', ago: '6m' },
      { name: 'Follower Control (NFF)', label: 'F9', category: 'Followers', source: 'entry', times: 2, at: '13:44:19', ago: '1h' },
    ] });
    window.fdState(FOL_FAKE);
    window.fdNff(FOL_NFF);
    window.fdTarget(FOL_TARGET);
    window.fdWorn(FOL_WORN);
    /* The quick card's two request bridges. Named apart from their replies
       (fdNpcResult / fdWorn) — reuse a name and toGame() calls the view's own
       receiver instead of the plugin, which is how this shipped dead once. */
    window.fdNpc = function (j) {
      const q = JSON.parse(j || '{}');
      window.fdNpcResult(JSON.stringify({ ok: true, phase: 'sent', op: q.op, via: 'nff',
        msg: '(dev) ' + q.op + ' ' + (q.name || 'the crosshair NPC') }));
      setTimeout(() => {
        if (q.op === 'recruit') window.fdTarget(Object.assign({}, FOL_TARGET, { following: true }));
        if (q.op === 'dismiss') window.fdTarget(Object.assign({}, FOL_TARGET, { following: false }));
        window.fdNpcResult(JSON.stringify({ ok: true, phase: 'done', op: q.op, via: 'nff',
          msg: '(dev) ' + q.op + ' done' }));
      }, 250);
    };
    window.fdEquipped = function () { setTimeout(() => window.fdWorn(FOL_WORN), 80); };

    window.fdRefresh = function () {
      setTimeout(() => {
        window.fdState(FOL_FAKE);
        window.fdNff(FOL_NFF);
        window.fdTarget(FOL_TARGET);
      }, 60);
    };
    window.fdApply = function (j) { toGame('hdLog', '[dev] fdApply ' + j); setTimeout(() => window.fdState(FOL_FAKE), 60); };
    window.fdWorld = function (j) { toast('(dev) world op ' + j); };
    window.fdSave = function (j) { toGame('hdLog', '[dev] fdSave ' + j); };

    /* mocked quest bridge so the Quests tab is browsable in the dev preview */
    const MQ = [
      { formId: '000A2C9E', name: 'Thane of Whiterun', editorId: 'FavorJarlWhiterun', plugin: 'Skyrim.esm',
        type: 'Side', status: 'running', currentStage: 200, stageCount: 5, unfilledAliases: 1,
        involvement: 'alias', aliasName: 'QuestGiver' },
      { formId: 'FEB2680B', name: 'Blood of the Ancients', editorId: 'AAX_BloodQuest', plugin: 'SomeMod.esl',
        type: 'Daedric', status: 'running', currentStage: 20, stageCount: 12, unfilledAliases: 0,
        involvement: 'alias', aliasName: 'RitualVictim' },
      { formId: '1712E107', name: 'Missing in Action', editorId: 'MS02', plugin: 'BigQuestMod.esp',
        type: 'Misc', status: 'inactive', currentStage: 0, stageCount: 8, unfilledAliases: 0,
        involvement: 'static', aliasName: '' },
    ];
    const MSTAGES = [0, 10, 20, 25, 200].map((i) => ({ index: i, current: i === 200 }));
    // VirtualKey catalog stub — mirrors the C++ vkCatalog -> vkCatalogData bridge.
    window.vkCatalog = () => setTimeout(() => window.vkCatalogData([
      { key: 100003, label: 'Target Lock', mod: 'True Directional Movement', page: 'Target Lock', option: 'Toggle Target Lock', verification: 'verified' },
      { key: 100004, label: '', mod: 'Precision', page: 'General', option: 'Debug Draw', verification: 'suspected_failure' },
      { key: 100007, label: 'Toggle POISE bars', mod: 'Loki POISE', page: 'Display', option: 'Show Meters', verification: 'user_confirmed' }
    ]), 120);
    window.vkTest = (p) => toGame('hdLog', 'vkTest ' + p);
    window.hdQuestList = () => setTimeout(() => window.hdQuests({
      hasTarget: true, npc: { name: 'Lydia', formId: '000A2C94', plugin: 'Skyrim.esm' }, quests: MQ }), 160);
    window.hdQuestSearch = (q) => setTimeout(() => window.hdQuests({ truncated: false,
      quests: MQ.filter((x) => (x.name + x.editorId + x.plugin).toLowerCase()
        .indexOf(String(q).toLowerCase()) !== -1) }), 160);
    window.hdQuestGet = (id) => setTimeout(() => {
      const q = MQ.find((x) => x.formId === String(id)) || MQ[0];
      window.hdQuestInfo(Object.assign({ ok: true }, q, {
        stages: MSTAGES,
        objectives: [{ index: 10, text: 'Purchase a house in Whiterun', state: 2 },
                     { index: 15, text: 'Return to <Alias.ShortName=QuestGiver>', state: 1 }],
        aliases: [
          { id: 0, name: 'QuestGiver', fill: 'unique actor', filled: true, refName: 'Jarl Balgruuf', refId: '0001A692', optional: false },
          { id: 1, name: 'Steward', fill: 'unique actor', filled: false, optional: false, wants: 'Proventus Avenicci' },
          { id: 2, name: 'HouseMarker', fill: 'conditions', filled: false, optional: true },
        ] }));
    }, 160);
    window.hdQuestSetStage = (p) => setTimeout(() =>
      window.hdQuestResult({ ok: true, message: 'Stage ' + JSON.parse(p).stage + ' fired' }), 120);
    window.hdQuestAction = (p) => setTimeout(() =>
      window.hdQuestResult({ ok: true, message: JSON.parse(p).verb + ' done' }), 120);

    /* the Spell Deck launcher — C++ closes this palette, then opens MagicDeck */
    window.hdOpenSpells = function () { toast('(dev) → Spell Deck'); };

    /* mocked icon library. The dev preview has no icons/ tree, so these paths
       404 and every tile/row falls back to the empty slot — which is exactly
       the broken-file path worth eyeballing. Serve a copy of this folder with
       real files under icons/ to see the art. */
    const DEV_ATLAS = ['destruction', 'restoration', 'illusion', 'conjuration', 'alteration', 'shouts'];
    const DEV_CATALOG = [];
    DEV_ATLAS.forEach((a) => {
      for (let i = 1; i <= 40; i++) {
        const key = a.toUpperCase() + '_' + String(i).padStart(2, '0');
        DEV_CATALOG.push({ file: 'icons/sh/' + a + '/' + key + '.png', atlas: a, label: key.toLowerCase(), kind: 'spell', key: key });
      }
    });
    const DEV_CUSTOM = { custom: [
      { file: 'icons/custom/dragonknight.png', label: 'dragonknight' },
      { file: 'icons/custom/dev-rune.png', label: 'dev-rune' },
      { file: 'icons/custom/wheel.png', label: 'wheel' },
    ] };
    window.hdIconList = function () { setTimeout(() => window.hdIcons(DEV_CUSTOM), 120); };
    window.hdIconIndex({ catalog: DEV_CATALOG, byForm: {}, generic: {} });
    window.hdIcons(DEV_CUSTOM);

    window.hdOpen({
      settings: { pauseOnOpen: true, smoothPause: true, closeAfterFire: true, openKey: { device: 'keyboard', code: 65, label: 'F7' } },
      categories: ['Combat', 'Followers', 'NPC', 'Misc'],
      notes: 'MOD MENUS\n  F7   Manager Deck (this menu)\n  F8   Teleport Followers\n\nSample notes — edit me.',
      entries: [
        { id: 'stance-2', name: 'Stance 2', desc: 'Combat stance two', device: 'keyboard', code: 8, label: '7', mods: [], category: 'Combat', icon: 'icons/sh/destruction/DESTRUCTION_01.png' },
        { id: 'stance-1', name: 'Stance 1', desc: 'Combat stance one', device: 'keyboard', code: 9, label: '8', mods: [], category: 'Combat' },
        { id: 'stance-3', name: 'Stance 3', desc: 'Combat stance three', device: 'keyboard', code: 10, label: '9', mods: [], category: 'Combat' },
        { id: 'weapon-wheel', name: 'Weapon Wheel', desc: 'Open the weapon wheel', device: 'keyboard', code: 211, label: 'Del', mods: [], category: 'Combat', icon: 'icons/custom/wheel.png' },
        { id: 'block', name: 'Block', desc: 'Block', device: 'keyboard', code: 22, label: 'U', mods: [], category: 'Combat' },
        { id: 'quick-follower', name: 'Quick Follower Command', desc: "' key — quick follower menu (separate from NFF)", device: 'keyboard', code: 40, label: "'", mods: [], category: 'Followers' },
        { id: 'followers-control', name: 'Follower Control', desc: 'Open follower control menu', device: 'keyboard', code: 67, label: 'F9', mods: [], category: 'Followers' },
        { id: 'followers-teleport', name: 'Followers: Teleport', desc: 'Teleport followers to you', device: 'keyboard', code: 66, label: 'F8', mods: [], category: 'Followers' },
        { id: 'follower-organizer', name: 'Follower Organizer', desc: 'Open Follower Organizer', device: 'keyboard', code: 13, label: '=', mods: [], category: 'Followers' },
        { id: 'npc-freeze', name: 'Freeze NPC', desc: 'Hold targeted NPC in place (toggle)', device: 'action', code: 0, label: 'Freeze', mods: [], category: 'NPC', action: 'freeze' },
        { id: 'npc-sit', name: 'Sit NPC', desc: 'Send to nearest chair / ground', device: 'action', code: 0, label: 'Sit', mods: [], category: 'NPC', action: 'sit' },
        { id: 'npc-bed', name: 'Bed NPC', desc: 'Send to nearest bed / ground', device: 'action', code: 0, label: 'Bed', mods: [], category: 'NPC', action: 'bed' },
        { id: 'npc-release-all', name: 'Release All NPCs', desc: 'Free everyone held', device: 'action', code: 0, label: 'Release', mods: [], category: 'NPC', action: 'release-all' },
        { id: 'followers-loot', name: 'NPC Sandbox / Skinshift', desc: 'Toggle NPC sandbox / Skinshift', device: 'keyboard', code: 12, label: '-', mods: [], category: 'Misc' },
        { id: 'shining-treasure', name: 'Free Slot (.)', desc: 'Free slot', device: 'keyboard', code: 52, label: '.', mods: [], category: 'Misc' },
        { id: 'slot-12', name: 'Slot 12', desc: "Free slot ('/')", device: 'keyboard', code: 53, label: '/', mods: [], category: 'Misc' },
      ],
    });
  }
}

/* ================================= dev self-test (?dev=1&selftest=1) ==== */
/* Repeatable smoke test of the capture/bridge flows — the same checks run by
   hand during v0.3.x development. Dev-preview only; never runs in-game.
   Results land in console + window.__selftest = { pass, total, results }. */

function runSelfTest() {
  const results = [];
  const T = (name, fn) => {
    try { const v = fn(); results.push([v === true, name, v === true ? '' : String(v)]); }
    catch (err) { results.push([false, name, String(err)]); }
  };
  const key = (code) => document.dispatchEvent(
    new KeyboardEvent('keydown', { code: code, bubbles: true, cancelable: true }));

  ui.tab = 'all'; ui.hkTab = 'all'; ui.edit = true; ui.extOpen = true; render();

  T('built-in action entry renders gold: .hk-native row + ⚙ action chip', () => {
    state.entries.push({ id: 'st-native', name: 'ST Native', desc: '', device: 'action',
                         code: 0, label: 'Freeze', mods: [], category: '', action: 'freeze' });
    render();
    const row  = document.querySelector('.row.hk-native[data-id="st-native"]');
    const chip = row && row.querySelector('.keychip.action');
    const good = !!row && !!chip && chip.textContent.indexOf('⚙') !== -1 &&
                 chip.textContent.indexOf('Freeze') !== -1;
    state.entries = state.entries.filter((x) => x.id !== 'st-native');
    render();
    return good || ('row=' + !!row + ' chip=' + (chip ? chip.textContent : 'none'));
  });

  T('shipped keyboard integration golds; a plain keystroke does NOT', () => {
    state.entries.push({ id: 'follower-organizer', name: 'FO', desc: '', device: 'keyboard', code: 0x0D, label: '=', mods: [], category: '' });
    state.entries.push({ id: 'my-own-key', name: 'Mine', desc: '', device: 'keyboard', code: 0x10, label: 'Q', mods: [], category: '' });
    render();
    const shipped = document.querySelector('.row.hk-native[data-id="follower-organizer"]');
    const mineRow = document.querySelector('.row[data-id="my-own-key"]');
    const mineGold = mineRow && mineRow.classList.contains('hk-native');
    state.entries = state.entries.filter((x) => x.id !== 'follower-organizer' && x.id !== 'my-own-key');
    render();
    return (!!shipped && !mineGold) || ('shipped=' + !!shipped + ' mineGold=' + !!mineGold);
  });

  T('VirtualKey entry golds (.hk-native row + gold ✦ vkey chip)', () => {
    state.entries.push({ id: 'st-vkey', name: 'VK', desc: '', device: 'vkey', code: 3, label: '', mods: [], action: 'tap', category: '' });
    render();
    const row = document.querySelector('.row.hk-native[data-id="st-vkey"]');
    const chip = row && row.querySelector('.keychip.vkey');
    const good = !!row && !!chip && chip.textContent.indexOf('✦') !== -1 &&
                 !document.querySelector('.row.hk-vkey[data-id="st-vkey"]');
    state.entries = state.entries.filter((x) => x.id !== 'st-vkey');
    render();
    return good || ('row=' + !!row + ' chip=' + (chip ? chip.textContent : 'none'));
  });

  T('integration is HIDDEN when its mod is undetected; shown greyed in Edit', () => {
    const savedDet = state.detected, savedEdit = ui.edit;
    state.detected = { omo: false, additemmenu: true };
    state.entries.push({ id: 'npc-grab', name: 'Grab NPC', desc: '', device: 'action', code: 0, label: 'Grab', mods: [], category: '', action: 'grab' });
    // normal mode: dropped from the list
    ui.edit = false; render();
    const hiddenNormal = !document.querySelector('.row[data-id="npc-grab"]');
    // edit mode: present, dimmed, with a needs tag naming the mod
    ui.edit = true; render();
    const row = document.querySelector('.row.hk-unavail[data-id="npc-grab"]');
    const tag = row && row.querySelector('.hk-needs');
    const good = hiddenNormal && !!row && !!tag && /Object Manipulation/.test(tag.textContent);
    state.entries = state.entries.filter((x) => x.id !== 'npc-grab');
    state.detected = savedDet; ui.edit = savedEdit; render();
    return good || ('hidden=' + hiddenNormal + ' row=' + !!row + ' tag=' + (tag ? tag.textContent : 'none'));
  });

  T('integration SHOWS when its mod is detected present', () => {
    const savedDet = state.detected, savedEdit = ui.edit;
    state.detected = { omo: true };
    state.entries.push({ id: 'npc-grab', name: 'Grab NPC', desc: '', device: 'action', code: 0, label: 'Grab', mods: [], category: '', action: 'grab' });
    ui.edit = false; render();
    const shown = document.querySelector('.row[data-id="npc-grab"]');
    const notDimmed = shown && !shown.classList.contains('hk-unavail');
    state.entries = state.entries.filter((x) => x.id !== 'npc-grab');
    state.detected = savedDet; ui.edit = savedEdit; render();
    return (!!shown && notDimmed) || ('shown=' + !!shown + ' notDimmed=' + !!notDimmed);
  });

  T('older DLL (no detected map) shows everything — nothing vanishes', () => {
    const savedDet = state.detected, savedEdit = ui.edit;
    state.detected = undefined;
    state.entries.push({ id: 'hd-additem-menu', name: 'AddItemMenu', desc: '', device: 'action', code: 0, label: 'AddItemMenu', mods: [], category: '', action: 'additem-menu' });
    ui.edit = false; render();
    const shown = !!document.querySelector('.row[data-id="hd-additem-menu"]') && hkNeeds({ id: 'hd-additem-menu' }) === '';
    state.entries = state.entries.filter((x) => x.id !== 'hd-additem-menu');
    state.detected = savedDet; ui.edit = savedEdit; render();
    return shown || 'hidden on an older DLL — regression';
  });

  T('ext defaults match C++ (F24→73, rest raw, enabled)', () => {
    const ek = extKeysState();
    return ek.enabled === true &&
      EXT_NAMES.every((n) => ek.map[n] === EXT_DEFAULT_MAP[n]) || 'map=' + JSON.stringify(ek.map);
  });
  T('open-key capture via hdExtKey binds faithful F24', () => {
    startCapture('open', null);
    window.hdExtKey({ name: 'F24', raw: 118, mapped: 73 });
    const ok = state.settings.openKey;
    const good = ok.device === 'keyboard' && ok.code === 118 && ok.label === 'F24' && ui.capture === null;
    state.settings.openKey = { device: 'keyboard', code: 65, label: 'F7' };
    return good || JSON.stringify(ok);
  });
  T('ext capture accepts a standard key (F16 → Num 5)', () => {
    startCapture('ext', 'F16');
    key('Numpad5');
    const good = extKeysState().map.F16 === 76 && ui.capture === null;
    extKeysState().map.F16 = EXT_RAW.F16;
    return good;
  });
  T('ext capture: own physical key = raw; other F-key stays armed', () => {
    startCapture('ext', 'F24');
    window.hdExtKey({ name: 'F13', raw: 100, mapped: 100 });   // mismatch — must not apply
    const armed = ui.capture !== null;
    window.hdExtKey({ name: 'F24', raw: 118, mapped: 73 });    // own key — applies raw
    const good = armed && extKeysState().map.F24 === 118 && ui.capture === null;
    extKeysState().map.F24 = EXT_DEFAULT_MAP.F24;
    return good;
  });
  T('ext capture rejects mouse and stays armed', () => {
    startCapture('ext', 'F20');
    window.hdNativeMouse({ code: 3, label: 'Mouse 4' });
    const good = ui.capture !== null && extKeysState().map.F20 === EXT_RAW.F20;
    endCapture(false);
    return good;
  });
  T('Esc cancels ext capture without changes', () => {
    startCapture('ext', 'F18');
    key('Escape');
    return ui.capture === null && extKeysState().map.F18 === EXT_RAW.F18;
  });
  T('hdNativeMouse binds open key (Mouse 4)', () => {
    startCapture('open', null);
    window.hdNativeMouse({ code: 3, label: 'Mouse 4' });
    const ok = state.settings.openKey;
    const good = ok.device === 'mouse' && ok.code === 3;
    state.settings.openKey = { device: 'keyboard', code: 65, label: 'F7' };
    return good || JSON.stringify(ok);
  });
  T('hdNativeMouse binds an entry (Mouse 5)', () => {
    if (!state.entries.length) return 'no entries';
    const e = state.entries[0], saved = { device: e.device, code: e.code, label: e.label };
    startCapture('entry', e.id);
    window.hdNativeMouse({ code: 4, label: 'Mouse 5' });
    const good = e.device === 'mouse' && e.code === 4 && e.label === 'Mouse 5';
    Object.assign(e, saved);
    return good;
  });
  T('bridge handlers no-op without a capture', () => {
    const before = JSON.stringify(state.settings);
    window.hdExtKey({ name: 'F13', raw: 100, mapped: 100 });
    window.hdNativeMouse({ code: 3, label: 'Mouse 4' });
    return JSON.stringify(state.settings) === before;
  });
  T('disable toggle dims the grid + summary reads off', () => {
    extKeysState().enabled = false; renderExt();
    const good = $('ext-grid').classList.contains('ext-disabled') &&
      $('ext-summary').textContent === 'bridge off';
    extKeysState().enabled = true; renderExt();
    return good;
  });
  T('extKeys JSON round-trip shape (enabled + 12 numeric keys)', () => {
    const ek = JSON.parse(JSON.stringify(state)).settings.extKeys;
    return typeof ek.enabled === 'boolean' &&
      EXT_NAMES.every((n) => typeof ek.map[n] === 'number');
  });
  T('layout: edit mode with F-keys open never paints past the footer', () => {
    render();
    const ft = document.getElementById('hints').getBoundingClientRect().top;
    const b = (id) => document.getElementById(id).getBoundingClientRect().bottom;
    return b('settings-card') <= ft + 1 && b('add-btn') <= ft + 1 ||
      'card=' + b('settings-card') + ' add=' + b('add-btn') + ' footer=' + ft;
  });

  /* ---- quests tab ---- */
  const Q1 = { formId: '000A2C9E', name: 'Thane of Whiterun', editorId: 'FavorJarlWhiterun',
    plugin: 'Skyrim.esm', type: 'Side', status: 'running', currentStage: 200, stageCount: 5,
    unfilledAliases: 1, involvement: 'alias', aliasName: 'QuestGiver' };
  const DETAIL = Object.assign({ ok: true }, Q1, {
    stages: [0, 10, 20, 25, 200].map((i) => ({ index: i, current: i === 200 })),
    objectives: [{ index: 10, text: 'Purchase a house', state: 2 }],
    aliases: [
      { id: 0, name: 'QuestGiver', fill: 'unique actor', filled: true, refName: 'Jarl Balgruuf', optional: false },
      { id: 1, name: 'Steward', fill: 'unique actor', filled: false, optional: false, wants: 'Proventus' },
      { id: 2, name: 'Marker', fill: 'conditions', filled: false, optional: true },
    ] });

  T('quests: tab is in the Tab cycle', () => tabOrder().indexOf('quests') !== -1);
  T('quests: hdQuests renders rows and names the target NPC', () => {
    ui.tab = 'quests'; ui.qMode = 'npc'; ui.qDetail = null; ui.qList = null;
    window.hdQuests({ hasTarget: true, npc: { name: 'Lydia', formId: '000A2C94', plugin: 'Skyrim.esm' }, quests: [Q1] });
    return document.querySelectorAll('#q-list .q-row').length === 1 &&
      $('q-target').textContent.indexOf('Lydia') !== -1;
  });
  T('quests: no-target empty state points at the crosshair', () => {
    window.hdQuests({ hasTarget: false, quests: [] });
    const shown = !$('q-empty').classList.contains('hidden');
    const txt = $('q-empty').textContent;
    window.hdQuests({ hasTarget: true, npc: { name: 'Lydia', formId: '000A2C94' }, quests: [Q1] });
    return (shown && txt.indexOf('No NPC targeted') !== -1) || txt;
  });
  T('quests: detail marks the current stage and flags the unfilled required alias', () => {
    window.hdQuestInfo(DETAIL);
    const cur = document.querySelectorAll('#q-detail .q-st.cur');
    return document.querySelectorAll('#q-detail .q-st').length === 5 &&
      cur.length === 1 && cur[0].textContent === '200' &&
      document.querySelectorAll('#q-detail .q-alias.bad').length === 1 &&   // Steward, required
      document.querySelectorAll('#q-detail .q-alias.opt').length === 1;     // Marker, optional
  });
  T('quests: a backwards stage arms a confirm before firing', () => {
    ui.qConfirmStage = null;
    onStageClick(20);                       // 20 < current 200 -> must only arm
    const armed = ui.qConfirmStage === 20;
    onStageClick(20);                       // second click fires and disarms
    return armed && ui.qConfirmStage === null;
  });
  T('quests: a forward stage fires immediately (no confirm)', () => {
    ui.qConfirmStage = null;
    window.hdQuestInfo(Object.assign({}, DETAIL, { currentStage: 10 }));
    onStageClick(200);
    return ui.qConfirmStage === null;
  });
  T('quests: Esc backs out of detail instead of closing the palette', () => {
    ui.visible = true; ui.tab = 'quests';
    window.hdQuestInfo(DETAIL);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true, cancelable: true }));
    return ui.qDetail === null;
  });
  T('quests: layout — detail actions never paint past the footer', () => {
    const many = []; for (let i = 1; i <= 124; i++) many.push({ index: i * 8, current: i === 124 });
    window.hdQuestInfo(Object.assign({}, DETAIL, { stages: many, currentStage: 992 }));
    const act = document.querySelector('#q-detail .q-actions').getBoundingClientRect();
    const ft = $('hints').getBoundingClientRect().top;
    return act.bottom <= ft + 1 || 'actions=' + act.bottom + ' footer=' + ft;
  });
  T('quests: Go to target renders and fires the movetoqt verb', () => {
    window.hdQuestInfo(DETAIL);
    const go = document.querySelector('#q-detail .q-act.go');
    if (!go) return 'button missing';
    let sent = null;
    const prev = window.hdQuestAction;
    window.hdQuestAction = (p) => { sent = JSON.parse(p); };
    go.click();
    window.hdQuestAction = prev;
    return !!sent && sent.verb === 'movetoqt' && sent.formId === DETAIL.formId;
  });

  /* ---- two-row nav (v0.11.0) ---- */
  const topLabels = () => Array.prototype.map.call(
    $('tabs').querySelectorAll('.tab'), (b) => b.textContent.replace(/[↗▾\s]+$/, '').trim());

  T('nav: fixed trio in order, systems by usage, the More button last', () => {
    /* The bar is DYNAMIC now (Rober, 2026-08-07): systems fill the row in
       usage order until the width runs out; the rest live behind More. What
       must always hold: Home · Hotkeys · Spells lead, the untouched default
       order starts Quests · Followers, the More/⋯ button is last. */
    ui.tab = 'all'; ui.edit = false; render();
    const got = topLabels();
    const want = ['Home', 'Hotkeys', 'Spells'];
    for (let i = 0; i < want.length; i++)
      if (got[i] !== want[i]) return 'fixed trio wrong — got ' + JSON.stringify(got);
    const shown = sysOrder().slice(0, got.length);   // usage order prefix
    if (got.indexOf('Quests') !== -1 && got.indexOf('Followers') !== -1 &&
        got.indexOf('Quests') > got.indexOf('Followers'))
      return 'default order broken — got ' + JSON.stringify(got);
    const btns = $('tabs').querySelectorAll('.tab');
    return !!btns[btns.length - 1].dataset && btns[btns.length - 1].dataset.act === 'more' ||
      'More is not last — got ' + JSON.stringify(got);
  });
  T('nav: a narrow bar sheds least-used systems into More; filter + Enter works', () => {
    ui.tab = 'all'; ui.edit = false; ui.moreOpen = false;
    const tabs = $('tabs');
    tabs.style.maxWidth = '430px';   // force a squeeze so overflow is deterministic
    render();
    const btn = tabs.querySelector('[data-act="more"]');
    if (!btn) { tabs.style.maxWidth = ''; return 'More button missing'; }
    if (!tabOverflow.length) { tabs.style.maxWidth = ''; return 'nothing overflowed at 430px'; }
    btn.click();                                   // open
    const menu = $('tab-more-menu');
    if (!menu || menu.classList.contains('hidden')) { tabs.style.maxWidth = ''; return 'menu did not open'; }
    if (menu.querySelectorAll('.more-item').length !== tabOverflow.length) { tabs.style.maxWidth = ''; return 'menu missing items'; }
    const s = menu.querySelector('.more-search');
    s.value = 'ward'; s.dispatchEvent(new Event('input', { bubbles: true }));
    const items = menu.querySelectorAll('.more-item');
    if (items.length !== 1 || items[0].dataset.tab !== 'wardrobe') { tabs.style.maxWidth = ''; return 'filter did not narrow to Wardrobe'; }
    /* the input survives the keystroke re-render (only the list rebuilds) */
    if (menu.querySelector('.more-search') !== s) { tabs.style.maxWidth = ''; return 'search input was re-created mid-type'; }
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    const good = ui.tab === 'wardrobe' && !ui.moreOpen && $('tab-more-menu').classList.contains('hidden');
    tabs.style.maxWidth = '';
    setTab('all');
    return good || ('tab=' + ui.tab + ' open=' + ui.moreOpen);
  });
  T('nav: the active overflow tab is hoisted onto the More button', () => {
    const tabs = $('tabs');
    tabs.style.maxWidth = '430px';   // rooms (1 visit < 3-use hysteresis) stays overflowed
    setTab('rooms');
    const btn = tabs.querySelector('[data-act="more"]');
    const good = !!btn && btn.classList.contains('active') && btn.textContent.indexOf('Rooms') !== -1;
    tabs.style.maxWidth = '';
    setTab('all');
    return good || 'More button did not reflect the active Rooms tab';
  });
  T('nav: icons style renders glyph tabs with hover names, and persists a toggle', () => {
    const tb = tabbarPrefs();
    tb.style = 'icons'; render();
    const ic = $('tabs').querySelector('.tab-ic[data-tab="quests"] img.tab-icon');
    const titled = ic && (ic.parentNode.getAttribute('title') || '').indexOf('Quests') === 0;
    tb.style = 'text'; render();
    const back = !$('tabs').querySelector('.tab-ic');
    return (!!ic && !!titled && back) || 'icon mode did not render/revert';
  });
  T('nav: hotkey categories + their edit tools live in #hk-tabs, never in #tabs', () => {
    ui.edit = true; render();
    const top = $('tabs');
    const sub = $('hk-tabs');
    /* NB the Hotkeys button DOES carry a data-tab (= hkTabToken()) — that is how
       it routes through setTab. What must never appear in row 1 is a category
       chip, the ＋ Tab affordance, or a category's ◂ ▸ ✎ ✕ tools. */
    /* Count the top row against what is actually rendered rather than a frozen
       7: the point of this check is that no CATEGORY chip or tab tool leaks
       into row 1, and that is exactly what the clauses below assert. Hard-coding
       the tab count made it fail whenever anyone added a legitimate tab. */
    const good = top.querySelectorAll('.tab').length === topLabels().length &&
      !top.querySelector('[data-tab^="cat:"]') && !top.querySelector('[data-act="add"]') &&
      !top.querySelector('.ticon') && !top.querySelector('.tab-input') &&
      !!sub.querySelector('[data-tab="all"]') &&
      sub.querySelectorAll('[data-tab^="cat:"]').length === state.categories.length &&
      !!sub.querySelector('[data-act="add"]') &&
      sub.querySelectorAll('.ticon').length === state.categories.length * 4;
    ui.edit = false; render();
    return good || ('top=' + top.querySelectorAll('.tab').length +
      ' subCats=' + sub.querySelectorAll('[data-tab^="cat:"]').length + '/' + state.categories.length +
      ' ticons=' + sub.querySelectorAll('.ticon').length);
  });
  T('nav: #hk-tabs is up on a hotkey tab and hidden on Quests / Numpad', () => {
    ui.edit = false; setTab('all');
    const onAll = !$('hk-tabs').classList.contains('hidden') && document.body.classList.contains('hk-sub');
    setTab('quests');
    const onQ = $('hk-tabs').classList.contains('hidden') && !document.body.classList.contains('hk-sub');
    setTab('numpad');
    const onN = $('hk-tabs').classList.contains('hidden');
    setTab('all');
    return (onAll && onQ && onN) || ('all=' + onAll + ' quests=' + onQ + ' numpad=' + onN);
  });
  T('nav: Hotkeys reads active for both "all" and a "cat:" tab', () => {
    /* The Hotkeys button carries data-tab = hkTabToken() ('all' | 'cat:…'); Home
       (data-tab="home") now precedes it, so target Hotkeys specifically. */
    const hkBtn = () => $('tabs').querySelector('.tab[data-tab="all"], .tab[data-tab^="cat:"]');
    const act = () => hkBtn().classList.contains('active');
    setTab('all');
    const a = act();
    setTab('cat:' + state.categories[0]);
    const b = act();
    setTab('notes');
    const c = act();
    setTab('all');
    return (a && b && !c) || ('all=' + a + ' cat=' + b + ' notes=' + c);
  });
  T('nav: Hotkeys returns to the last category (ui.hkTab)', () => {
    setTab('cat:' + state.categories[1]);
    setTab('numpad');
    const btn = $('tabs').querySelector('.tab[data-tab="all"], .tab[data-tab^="cat:"]');
    const points = btn.dataset.tab === 'cat:' + state.categories[1];
    btn.click();
    const back = ui.tab === 'cat:' + state.categories[1];
    setTab('all');
    return (points && back) || ('pointed=' + btn.dataset.tab + ' landed=' + ui.tab);
  });
  T('nav: deleting the active category resets ui.hkTab to all', () => {
    state.categories.push('ZZTemp');
    setTab('cat:ZZTemp');
    deleteTab('ZZTemp');
    return ui.hkTab === 'all' && ui.tab === 'all' &&
      $('tabs').querySelector('.tab[data-tab="all"], .tab[data-tab^="cat:"]').dataset.tab === 'all';
  });
  T('nav: renaming the active category rewrites ui.hkTab', () => {
    state.categories.push('ZZOld');
    setTab('cat:ZZOld');
    commitRenameTab('ZZOld', 'ZZNew');
    const good = ui.hkTab === 'cat:ZZNew' && ui.tab === 'cat:ZZNew';
    state.categories = state.categories.filter((c) => c !== 'ZZNew');
    ui.tab = 'all'; ui.hkTab = 'all'; render();
    return good;
  });
  T('nav: hkTabToken falls back to all when the category vanished', () => {
    ui.hkTab = 'cat:GoneForever';
    const t = hkTabToken();
    ui.hkTab = 'all';
    return t === 'all' || t;
  });

  /* ---- Spells launcher ---- */
  T('spells: launcher fires hdOpenSpells and never becomes the active tab', () => {
    ui.tab = 'all'; render();
    const btn = $('tabs').querySelector('[data-act="spells"]');
    if (!btn) return 'launcher missing';
    let sent = false;
    const prev = window.hdOpenSpells;
    window.hdOpenSpells = () => { sent = true; };
    btn.click();
    window.hdOpenSpells = prev;
    const still = $('tabs').querySelector('[data-act="spells"]');
    return (sent && ui.tab === 'all' && !still.classList.contains('active') &&
      !still.hasAttribute('data-tab')) || ('sent=' + sent + ' tab=' + ui.tab);
  });
  T('spells: launcher carries the ↗ marker', () =>
    !!$('tabs').querySelector('[data-act="spells"] .tab-launch') &&
    $('tabs').querySelector('[data-act="spells"]').textContent.indexOf('↗') !== -1);
  T('spells: Tab cycling never lands on the launcher', () =>
    tabOrder().indexOf('spells') === -1 && tabOrder()[0] === 'all');

  /* ---- keyboard paths the nav restructure must not break ---- */
  T('keys: quick-fire digits still fire on a category tab', () => {
    ui.edit = false; setTab('cat:' + state.categories[0]);
    ui.search = ''; $('search').value = ''; renderList();
    const want = filteredEntries()[0];
    if (!want) return 'category is empty';
    let fired = null;
    const prev = window.hdFire;
    window.hdFire = (id) => { fired = id; };
    key('Digit1');
    window.hdFire = prev;
    setTab('all');
    return fired === want.id || ('fired=' + fired + ' want=' + want.id);
  });
  T('keys: arrows + Enter still fire the selected row', () => {
    ui.edit = false; setTab('cat:' + state.categories[0]); ui.sel = 0; renderList();
    key('ArrowDown');
    const moved = ui.sel === 1;
    const want = filteredEntries()[1];
    let fired = null;
    const prev = window.hdFire;
    window.hdFire = (id) => { fired = id; };
    key('Enter');
    window.hdFire = prev;
    setTab('all');
    return (moved && want && fired === want.id) || ('sel=' + ui.sel + ' fired=' + fired);
  });
  T('keys: Tab from Numpad still cycles back into the hotkey tabs', () => {
    setTab('numpad');
    key('Tab');
    const back = ui.tab === 'all' && !$('hk-tabs').classList.contains('hidden');
    return back || ('tab=' + ui.tab);
  });
  T('keys: F2 on a category tab toggles the deck edit mode', () => {
    ui.edit = false; setTab('cat:' + state.categories[0]);
    key('F2');
    const on = ui.edit === true && !$('settings-card').classList.contains('hidden');
    key('F2');
    setTab('all');
    return (on && ui.edit === false) || ('on=' + on + ' now=' + ui.edit);
  });

  /* ---- per-hotkey icons ---- */
  const ICON_A = 'icons/custom/wheel.png';
  const ICON_B = 'icons/sh/destruction/DESTRUCTION_01.png';
  const iconEntry = () => state.entries.find((x) => x.id === 'weapon-wheel') || state.entries[0];

  T('icons: hdIconIndex normalises \\ to / and drops file-less rows', () => {
    const keep = ICONS.catalog.slice();
    window.hdIconIndex({ catalog: [
      { file: 'icons\\sh\\alt\\A.png', atlas: 'alt', label: 'a', key: 'A' },
      { file: '', atlas: 'alt', label: 'nope' },
    ] });
    const good = ICONS.catalog.length === 1 && ICONS.catalog[0].file === 'icons/sh/alt/A.png';
    ICONS.catalog = keep;
    return good || JSON.stringify(ICONS.catalog);
  });
  T('icons: hkIconSrc refuses ../, absolute and scheme paths', () =>
    hkIconSrc('icons/custom/a.png') === 'icons/custom/a.png' &&
    hkIconSrc('../MagicDeck/icons/custom/a.png') === '' &&
    hkIconSrc('C:\\Games\\a.png') === '' &&
    hkIconSrc('/etc/passwd') === '' &&
    hkIconSrc('file:///a.png') === '' && hkIconSrc('') === '');
  T('icons: a row renders <img src> for entry.icon, view-relative', () => {
    ui.edit = false; setTab('all');
    const e = iconEntry();
    e.icon = ICON_A; renderList();
    const img = $('list').querySelector('[data-id="' + e.id + '"] .hk-ico img');
    return (!!img && img.getAttribute('src') === ICON_A) || ('src=' + (img && img.getAttribute('src')));
  });
  T('icons: an icon-less row keeps a reserved (empty) slot for alignment', () => {
    const rows = $('list').querySelectorAll('.row');
    let boxes = 0;
    rows.forEach((r) => { if (r.querySelector('.hk-ico')) boxes++; });
    return boxes === rows.length || (boxes + '/' + rows.length);
  });
  T('icons: a broken src collapses to an empty slot, never a broken image', () => {
    const e = iconEntry();
    e.icon = 'icons/custom/deleted-since-the-scan.png'; renderList();
    const img = $('list').querySelector('[data-id="' + e.id + '"] .hk-ico img');
    if (!img) return 'no img rendered';
    const box = img.parentNode;
    img.dispatchEvent(new Event('error'));
    return (box.classList.contains('empty') && !box.querySelector('img')) ||
      ('cls=' + box.className + ' imgs=' + box.querySelectorAll('img').length);
  });
  T('icons: view-mode click on the icon still fires the entry', () => {
    const e = iconEntry();
    e.icon = ICON_A; ui.edit = false; renderList();
    let fired = null;
    const prev = window.hdFire;
    window.hdFire = (id) => { fired = id; };
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    window.hdFire = prev;
    return (fired === e.id && !hkIcon.open) || ('fired=' + fired + ' picker=' + hkIcon.open);
  });
  T('icons: edit-mode click on the icon opens the picker, not the rebind capture', () => {
    ui.edit = true; render();
    const e = iconEntry();
    const box = $('list').querySelector('[data-id="' + e.id + '"] .hk-ico');
    if (!box || box.tagName !== 'BUTTON') return 'edit slot is not a button: ' + (box && box.tagName);
    box.click();
    return (hkIcon.open === true && hkIcon.id === e.id && ui.capture === null &&
      !$('hk-icon-modal').classList.contains('hidden') &&
      $('hk-icon-name').textContent === e.name) || ('open=' + hkIcon.open + ' cap=' + JSON.stringify(ui.capture));
  });
  T('icons: picker sections are None + Your icons + Icon library, with NO Auto tile', () => {
    const sects = Array.prototype.map.call($('hk-icon-grid').querySelectorAll('.hk-icon-sect'), (s) => s.textContent);
    return (JSON.stringify(sects) === JSON.stringify(['None', 'Your icons (icons/custom)', 'Icon library']) &&
      !$('hk-icon-grid').querySelector('.hk-icon-tile.auto') &&
      $('hk-icon-grid').querySelectorAll('.hk-icon-tile.none').length === 1) || JSON.stringify(sects);
  });
  T('icons: the current icon is marked selected in the picker', () => {
    const sel = $('hk-icon-grid').querySelectorAll('.hk-icon-tile.sel');
    return (sel.length === 1 && sel[0].title.indexOf('wheel') !== -1) ||
      (sel.length + ' selected: ' + (sel[0] && sel[0].title));
  });
  T('icons: search narrows the library and scroll appends the next chunk', () => {
    $('hk-icon-search').value = 'destruction';
    $('hk-icon-search').dispatchEvent(new Event('input'));
    const lib = ICONS.catalog.filter((c) => (c.atlas || '').indexOf('destruction') >= 0).length;
    const narrowed = lib > 0 && lib < ICONS.catalog.length &&
      $('hk-icon-count').textContent.indexOf(lib + ' library') === 0;
    $('hk-icon-search').value = '';
    $('hk-icon-search').dispatchEvent(new Event('input'));
    const first = $('hk-icon-grid').querySelectorAll('.hk-icon-tile').length;
    appendMoreHkIcons();
    const grew = $('hk-icon-grid').querySelectorAll('.hk-icon-tile').length > first;
    return (narrowed && first <= HK_ICON_PAGE + ICONS.custom.length + 1 && grew) ||
      ('narrowed=' + narrowed + ' first=' + first + ' grew=' + grew);
  });
  T('icons: hdIcons re-renders the custom section while the picker is open', () => {
    const keep = ICONS.custom.slice();
    window.hdIcons({ custom: [{ file: 'icons/custom/zz-fresh.png', label: 'zz-fresh' }] });
    const shown = Array.prototype.some.call($('hk-icon-grid').querySelectorAll('.hk-icon-tile'),
      (t) => t.title.indexOf('zz-fresh') !== -1);
    window.hdIcons({ custom: keep });
    return shown === true;
  });
  T('icons: the picker claims/releases hdCapture so a live portal push cannot yank it shut', () => {
    const seen = [];
    const prev = window.hdCapture;
    window.hdCapture = (v) => { seen.push(String(v)); };
    const e = iconEntry();
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    const claimed = seen.length === 1 && seen[0] === '1';
    closeHkIconPicker();
    window.hdCapture = prev;
    return (claimed && seen.length === 2 && seen[1] === '0') || JSON.stringify(seen);
  });
  T('icons: Escape closes the picker without changing entry.icon', () => {
    const e = iconEntry();
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    if (!hkIcon.open) return 'picker did not open';
    const before = e.icon;
    ui.visible = true;
    key('Escape');
    return (!hkIcon.open && $('hk-icon-modal').classList.contains('hidden') && e.icon === before) ||
      ('open=' + hkIcon.open + ' icon=' + e.icon);
  });
  T('icons: a keystroke in the picker never quick-fires a hotkey', () => {
    const e = iconEntry();
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    ui.edit = false; ui.search = '';   // the dangerous shape: quick-fire live behind the modal
    let fired = null;
    const prev = window.hdFire;
    window.hdFire = (id) => { fired = id; };
    key('Digit1'); key('Digit5'); key('Enter');
    window.hdFire = prev;
    const good = fired === null && hkIcon.open === true;
    closeHkIconPicker();
    return good || ('fired=' + fired);
  });
  T('icons: picking a tile sets entry.icon; the None tile clears it', () => {
    const e = iconEntry();
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    const tile = Array.prototype.find.call($('hk-icon-grid').querySelectorAll('.hk-icon-tile'),
      (t) => t.title.indexOf(ICON_B) !== -1 || t.title.indexOf('destruction_01') !== -1);
    if (!tile) return 'library tile not found';
    tile.click();
    const set = e.icon === ICON_B && !hkIcon.open;
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    $('hk-icon-grid').querySelector('.hk-icon-tile.none').click();
    return (set && e.icon === '' && !hkIcon.open) || ('set=' + set + ' after=' + JSON.stringify(e.icon));
  });
  T('icons: entry.icon survives the hdSave payload round-trip', () => {
    const e = iconEntry();
    e.icon = ICON_A;
    const back = JSON.parse(JSON.stringify(state)).entries.find((x) => x.id === e.id);
    e.icon = '';
    return (back && back.icon === ICON_A) || ('round-tripped=' + (back && JSON.stringify(back.icon)));
  });
  /* --- per-entry trigger keys --- */
  const trigEntry = () => state.entries.find((e) => e.device !== 'action') || state.entries[0];

  T('trigger: unset entry shows a Set… button in edit and NOTHING in view', () => {
    const e = trigEntry();
    delete e.trigger;
    ui.edit = true; setTab('all'); render();
    const editHas = !!$('list').querySelector('[data-id="' + e.id + '"] .trig-btn');
    ui.edit = false; render();
    const viewHas = !!$('list').querySelector('[data-id="' + e.id + '"] .trigchip');
    return (editHas && !viewHas) || ('edit=' + editHas + ' view=' + viewHas);
  });

  T('trigger: capturing a key writes entry.trigger and shows it in VIEW mode', () => {
    const e = trigEntry();
    delete e.trigger;
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .trig-btn').click();
    const inCapture = ui.capture && ui.capture.mode === 'trigger' && ui.capture.id === e.id;
    applyCapture({ device: 'keyboard', code: 88, mods: [42], keyLabel: 'X' });
    const t = e.trigger;
    ui.edit = false; render();
    const chip = $('list').querySelector('[data-id="' + e.id + '"] .trigchip');
    const good = inCapture && t && t.code === 88 && t.device === 'keyboard' &&
      t.mods.length === 1 && chip && /X/.test(chip.textContent);
    return good || ('cap=' + inCapture + ' t=' + JSON.stringify(t) + ' chip=' + (chip && chip.textContent));
  });

  T('trigger: a MOUSE trigger never stores modifiers the C++ matcher ignores', () => {
    const e = trigEntry();
    delete e.trigger;
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .trig-btn').click();
    applyCapture({ device: 'mouse', code: 3, mods: [42, 29], keyLabel: 'Mouse4' });
    const t = e.trigger;
    ui.edit = false; render();
    return (t && t.device === 'mouse' && t.mods.length === 0) ||
      ('stored=' + JSON.stringify(t));
  });

  T('trigger: the ✕ clears it and the row falls back to Set…', () => {
    const e = trigEntry();
    e.trigger = { device: 'keyboard', code: 88, label: 'X', mods: [] };
    ui.edit = true; render();
    $('list').querySelector('[data-id="' + e.id + '"] .trig-clear').click();
    const gone = !e.trigger;
    const btn = $('list').querySelector('[data-id="' + e.id + '"] .trig-btn');
    const back = btn && btn.classList.contains('unset');
    ui.edit = false; render();
    return (gone && back) || ('gone=' + gone + ' unset=' + back);
  });

  T('trigger: a malformed trigger renders as unset, never half-bound', () => {
    const e = trigEntry();
    e.trigger = { device: 'keyboard', code: 0, label: 'nope', mods: [] };
    ui.edit = true; render();
    const btn = $('list').querySelector('[data-id="' + e.id + '"] .trig-btn');
    const good = btn && btn.classList.contains('unset') &&
      !$('list').querySelector('[data-id="' + e.id + '"] .trig-clear');
    delete e.trigger;
    ui.edit = false; render();
    return good || ('classes=' + (btn && btn.className));
  });

  /* --- extended F-keys as triggers (the "Unsupported key: F22" bug) ---
     Gaming mice/keyboards commonly send F14-F23 on their extra buttons, so a
     trigger that cannot take one is a trigger nobody can reach. DIK stopped at F15 and
     hdExtKey refused `trigger` outright, so BOTH routes failed. Test both. */
  T('ext: DIK resolves every one of F13-F24 to its DirectInput scancode', () => {
    const missing = EXT_NAMES.filter((n) => !DIK[n]);
    if (missing.length) return 'not in DIK: ' + missing.join(', ');
    const wrong = EXT_NAMES.filter((n) => DIK[n][0] !== EXT_RAW[n]);
    return !wrong.length || ('code disagrees with EXT_RAW: ' + wrong.join(', '));
  });

  T('trigger: a native F22 press binds instead of "Unsupported key"', () => {
    const e = trigEntry();
    delete e.trigger;
    startCapture('trigger', e.id);
    onKeyDown({ code: 'F22', keyCode: 0, preventDefault() {}, stopPropagation() {} });
    const t = e.trigger;
    delete e.trigger;
    endCapture(false);
    return (t && t.code === EXT_RAW.F22 && t.label === 'F22' && t.device === 'keyboard') ||
      ('trigger=' + JSON.stringify(t));
  });

  T('trigger: the C++-forwarded F22 (hdExtKey) binds it too', () => {
    const e = trigEntry();
    delete e.trigger;
    startCapture('trigger', e.id);
    window.hdExtKey({ name: 'F22', raw: EXT_RAW.F22, mapped: EXT_RAW.F22 });
    const t = e.trigger;
    delete e.trigger;
    endCapture(false);
    return (t && t.code === EXT_RAW.F22 && t.label === 'F22') || ('trigger=' + JSON.stringify(t));
  });

  T('entry keys still REFUSE F22 — sending it would re-enter our own bridge', () => {
    const e = trigEntry();
    const before = { device: e.device, code: e.code, label: e.label };
    startCapture('entry', e.id);
    onKeyDown({ code: 'F22', keyCode: 0, preventDefault() {}, stopPropagation() {} });
    const unchanged = e.device === before.device && e.code === before.code;
    const stillCapturing = !!ui.capture;   // refused, so the modal stays up
    endCapture(false);
    return (unchanged && stillCapturing) ||
      ('changed=' + (!unchanged) + ' capture=' + stillCapturing);
  });

  T('trigger: entry.trigger survives the hdSave payload round-trip', () => {
    const e = trigEntry();
    e.trigger = { device: 'keyboard', code: 88, label: 'X', mods: [42] };
    const back = JSON.parse(JSON.stringify(state)).entries.find((x) => x.id === e.id);
    delete e.trigger;
    return (back && back.trigger && back.trigger.code === 88 && back.trigger.mods[0] === 42) ||
      ('round-tripped=' + (back && JSON.stringify(back.trigger)));
  });

  T('trigger: the chip never overflows its row, even with a long chord', () => {
    const e = trigEntry();
    e.trigger = { device: 'keyboard', code: 88, label: 'NumpadDecimal', mods: [42, 29, 56] };
    ui.edit = true; setTab('all'); render();
    const row = $('list').querySelector('[data-id="' + e.id + '"]');
    const chip = row.querySelector('.trigchip');
    const rb = row.getBoundingClientRect(), cb = chip.getBoundingClientRect();
    const good = cb.right <= rb.right + 1 && cb.left >= rb.left - 1 && row.scrollWidth <= row.clientWidth + 1;
    delete e.trigger;
    ui.edit = false; render();
    return good || ('chip=' + Math.round(cb.left) + '..' + Math.round(cb.right) +
      ' row=' + Math.round(rb.left) + '..' + Math.round(rb.right) + ' scroll=' + row.scrollWidth + '/' + row.clientWidth);
  });

  T('quick-fire: the slot label spells out the whole chord, not a bare "Alt +"', () => {
    ui.edit = true; render();
    const lab = $('modalt-btn').closest('.modslot').querySelector('.set-label').textContent;
    const ok = state.settings.openKey || {};
    ui.edit = false; render();
    return (lab.indexOf('Alt + ') === 0 && lab.indexOf(ok.label || 'open key') > 0) ||
      ('label="' + lab + '" openKey=' + JSON.stringify(ok.label));
  });

  T('layout: two-row nav in edit mode still never paints past the footer', () => {
    ui.edit = true; ui.extOpen = true; setTab('all'); render();
    const ft = $('hints').getBoundingClientRect().top;
    const b = (id) => $(id).getBoundingClientRect().bottom;
    const good = b('settings-card') <= ft + 1 && b('add-btn') <= ft + 1 &&
      b('hk-tabs') <= $('deck-pane').getBoundingClientRect().top + 1;
    ui.extOpen = false; ui.edit = false; render();
    return good || ('card=' + b('settings-card') + ' add=' + b('add-btn') + ' footer=' + ft);
  });
  T('layout: the icon picker stays inside the panel', () => {
    ui.edit = true; render();
    const e = iconEntry();
    $('list').querySelector('[data-id="' + e.id + '"] .hk-ico').click();
    const box = document.querySelector('.hk-icon-box').getBoundingClientRect();
    const p = $('panel').getBoundingClientRect();
    const good = box.top >= p.top - 1 && box.bottom <= p.bottom + 1 &&
      box.left >= p.left - 1 && box.right <= p.right + 1;
    closeHkIconPicker();
    ui.edit = false; render();
    return good || ('box=' + JSON.stringify(box) + ' panel=' + JSON.stringify(p));
  });

  /* ---- Followers tab (merged pane) ---- */
  T('followers: tab button renders after the group divider', () => {
    renderTabs();
    /* Domains moved into the More overflow menu (2026-08-05); Followers stays a
       primary tab after the divider, and More carries the rest. */
    return !!$('tabs').querySelector('.tab-sep') &&
      !!$('tabs').querySelector('[data-tab="followers"]') &&
      !!$('tabs').querySelector('[data-act="more"]');
  });
  T('followers: setTab shows the pane and requests a refresh', () => {
    let asked = false;
    const prev = window.fdRefresh;
    window.fdRefresh = () => { asked = true; };
    setTab('followers');
    window.fdRefresh = prev;
    return asked && !$('fol-pane').classList.contains('hidden') && $('deck-pane').classList.contains('hidden');
  });
  T('followers: state envelope renders rows + badges', () => {
    window.fdState({ ok: true, state: { total: 2, categories: [
      { index: 1, name: 'Household', override: '', original: 'Category 01', hotkey: -1, inMagicMenu: true,
        members: [
          { name: 'Camilla', override: '', original: 'Camilla', desc: 'note here', tracked: false, resolved: true, inWorld: true, following: true, dead: false, form: '', formId: '0x1' },
          { name: 'Knight of Rot', override: '', original: 'Knight of Rot', desc: '', tracked: false, resolved: true, inWorld: true, following: false, dead: true, form: '', formId: '0x2' },
        ] } ] } });
    return $('fd-list').children.length === 2 &&
      !!$('fd-list').querySelector('.fd-tag.following') && !!$('fd-list').querySelector('.fd-tag.dead');
  });
  T('followers: search filters and highlights', () => {
    $('fd-search').value = 'note';
    $('fd-search').dispatchEvent(new Event('input'));
    const one = $('fd-list').children.length === 1 && !!$('fd-list').querySelector('.fd-note mark');
    $('fd-search').value = '';
    $('fd-search').dispatchEvent(new Event('input'));
    return one;
  });
  T('followers: click opens the action menu with name+note+field editors', () => {
    const row = $('fd-list').querySelector('.fd-member');
    row.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 200, bubbles: true }));
    const menu = document.getElementById('fd-ctx-menu');
    // 2 = Name + Note; v0.10.0 adds the field spec rows (Relationship, Home, …)
    const good = !!menu && menu.querySelectorAll('.fd-ctx-input').length >= 6 &&
      menu.querySelectorAll('.fd-ctx-item').length >= 5 &&
      !!menu.querySelector('[data-fkey="relationship"] input');
    if (window.FolPane) FolPane.closeMenus();
    return good;
  });
  T('followers: fdTarget shows the add button', () => {
    window.fdTarget({ formId: 42, name: 'Uthgerd' });
    const shown = !$('fd-add-btn').classList.contains('hidden') &&
      $('fd-add-btn').textContent.indexOf('Uthgerd') !== -1;
    window.fdTarget(null);
    return shown;
  });
  /* ---------------- Recent ---------------- */
  T('recent: renders newest-first with counts, keys and source icons', () => {
    const prevTab = ui.tab;
    setTab('recent');
    const rows = $('rc-list').querySelectorAll('.rc-row');
    if (rows.length !== 5) { ui.tab = prevTab; render(); return 'rendered ' + rows.length + ' rows'; }
    const first = rows[0].textContent;
    const times = $('rc-list').querySelector('.rc-times');
    const empty = !$('rc-empty').classList.contains('hidden');
    ui.tab = prevTab; render();
    if (empty) return 'empty state shown with items present';
    if (first.indexOf('Weapon Wheel') < 0) return 'not newest-first: ' + first;
    return (times && times.textContent === '×4') || 'repeat count missing';
  });

  T('recent: switching to the tab re-asks, so "ago" cannot go stale', () => {
    /* toGame(fn) resolves window[fn]; in the preview the C++ listener does not
       exist, so stubbing it IS the recorder. */
    const prevTab = ui.tab;
    let asked = 0;
    const prev = window.hdHistory;
    window.hdHistory = () => { asked++; };
    setTab('all');
    setTab('recent');
    window.hdHistory = prev;
    ui.tab = prevTab; render();
    return asked === 1 || 'hdHistory asked ' + asked + ' times on show';
  });

  T('recent: an empty list gives the designed empty state, and hides Clear', () => {
    const prevTab = ui.tab;
    const keep = { ok: true, count: 1, max: 300, items: [
      { name: 'Stance 2', label: '7', category: 'Combat', source: 'entry', times: 1, at: '14:01:30', ago: '2m' } ] };
    window.hdRecent({ ok: true, count: 0, max: 300, items: [] });
    setTab('recent');
    const shown = !$('rc-empty').classList.contains('hidden');
    const clearHidden = $('rc-clear').classList.contains('hidden');
    const rows = $('rc-list').querySelectorAll('.rc-row').length;
    window.hdRecent(keep);            // put the seed back for anything after
    ui.tab = prevTab; render();
    if (!shown) return 'no empty state';
    if (!clearHidden) return 'Clear offered with nothing to clear';
    return rows === 0 || 'rows rendered while empty';
  });

  /* ---------------- deck actions (full save et al) ---------------- */
  /* These drive edit mode and switch tabs, so they save and restore what they
     found: the very next check needs the Followers tab still selected, and
     leaving 'all' behind made it fail for a reason that had nothing to do with
     it. Test pollution is a real bug in a suite, not a nuisance. */
  const _actPrevTab = ui.tab, _actPrevEdit = ui.edit;
  T('a debounced edit is FLUSHED when the deck closes, not lost', () => {
    /* Renaming a hotkey debounces 350ms. Closing inside that window used to
       drop it silently — no error, no way to tell. Both close routes flush:
       requestClose (Esc / the ✕) and hdClosed (C++ closing it for a container
       op, a quick-fire or a deep-open key). */
    const e = state.entries[0];
    if (!e) return 'no entry to rename';
    const keep = e.name;
    /* Both close routes flip ui.visible (and record lastClosedTab). Restore
       them: a later check asserts hdShowTab closes an OPEN palette, and it
       failed the first time this test ran precisely because this one had left
       it shut. */
    const keepVis = ui.visible, keepLast = ui.lastClosedTab;
    let sent = 0;
    const realToGame = window.toGame;
    window.toGame = function (fn) { if (fn === 'hdSave') sent++; };
    try {
      e.name = 'renamed-but-not-yet-saved';
      saveSoon();                       // pending, NOT written
      if (sent !== 0) return 'saveSoon wrote immediately — the debounce is gone';
      requestClose();                   // must flush on the way out
      if (sent !== 1) return 'closing did not flush the pending save (' + sent + ' writes)';
      saveSoon();                       // arm again, and close the OTHER way
      window.hdClosed();
      if (sent !== 2) return 'hdClosed did not flush (' + sent + ' writes)';
      return true;
    } finally {
      window.toGame = realToGame; e.name = keep;
      ui.visible = keepVis; ui.lastClosedTab = keepLast;
      document.body.classList.toggle('open', !!keepVis);
    }
  });
  T('actions: the picker offers Full Save and marks what is already added', () => {
    ui.edit = true; ui.tab = 'all'; render();
    const before = state.entries.length;
    openActionPicker($('add-action-btn'));
    const box = $('action-picker');
    if (!box) { closeActionPicker(); return 'picker did not open'; }
    const names = [].slice.call(box.querySelectorAll('.ap-name')).map((n) => n.textContent);
    const dupes = [].slice.call(box.querySelectorAll('.ap-item[data-dupe] .ap-name')).map((n) => n.textContent);
    closeActionPicker();
    if (names.indexOf('Full Save') < 0) return 'no Full Save: ' + names.join(',');
    // the dev seed has freeze/sit/bed/release already, so they must be flagged
    if (dupes.indexOf('Freeze NPC') < 0) return 'existing action not marked: ' + dupes.join(',');
    if (dupes.indexOf('Full Save') >= 0) return 'Full Save wrongly marked as already added';
    return state.entries.length === before || 'opening the picker changed the entries';
  });

  T('actions: picking Full Save adds an action entry on the current tab', () => {
    ui.edit = true; ui.tab = 'cat:Misc'; render();
    const before = state.entries.length;
    openActionPicker($('add-action-btn'));
    $('action-picker').querySelector('.ap-item[data-action="full-save"]').click();
    endCapture(false);                    // decline the key binding
    const added = state.entries.filter((e) => e.action === 'full-save');
    const ok = added.length === 1 && added[0].device === 'action' &&
               added[0].category === 'Misc' && state.entries.length === before + 1;
    const keptUnbound = added.length === 1;   // must survive a cancelled capture
    state.entries = state.entries.filter((e) => e.action !== 'full-save');
    ui.tab = 'all'; ui.edit = false; render();
    if (!keptUnbound) return 'cancelling the key capture deleted the action';
    return ok || 'added ' + JSON.stringify(added);
  });

  T('actions: an unbound ACTION survives a cancelled capture; a hotkey does not', () => {
    /* An action with no key is usable — you click it. A hotkey with no key is
       litter. The cleanup must tell them apart. */
    ui.edit = true; render();
    const id = newId();
    state.entries.push({ id: id, name: 'x', desc: '', device: 'keyboard', code: 0,
      label: '', mods: [], icon: '', category: '' });
    startCapture('add', id); endCapture(false);
    const hotkeyGone = !state.entries.some((e) => e.id === id);

    const aid = newId();
    state.entries.push({ id: aid, name: 'y', desc: '', device: 'action', code: 0,
      label: 'Save', mods: [], action: 'full-save', icon: '', category: '' });
    startCapture('add', aid); endCapture(false);
    const actionKept = state.entries.some((e) => e.id === aid);
    state.entries = state.entries.filter((e) => e.id !== aid);
    ui.edit = false; render();
    if (!hotkeyGone) return 'an unbound hotkey draft was kept';
    return actionKept || 'the unbound action was deleted';
  });

  T('actions: the picker sits inside the window, above the button if need be', () => {
    ui.edit = true; render();
    openActionPicker($('add-action-btn'));
    const r = $('action-picker').getBoundingClientRect();
    const inside = r.top >= 0 && r.left >= 0 &&
                   r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
    closeActionPicker(); ui.edit = false; render();
    return inside || 'picker at ' + JSON.stringify(r);
  });

  ui.tab = _actPrevTab; ui.edit = _actPrevEdit; render();

  T('followers: hdShowTab on the active tab closes the palette', () => {
    /* Establish the premise instead of inheriting it. This assumed the suite
       had left ui.tab on 'followers'; once the tab list grew that stopped
       being true, so hdShowTab took the SWITCH path rather than the close
       path and the check failed for a reason unrelated to what it tests. */
    setTab('followers');
    /* …and the OTHER inherited premise, which is a wall clock. hdShowTab only
       takes the close path when the palette opened more than 700ms ago (so the
       key that OPENS the deck cannot immediately shut it again). This check
       therefore passed or failed depending on how long the suite above it
       happened to take — it started failing the moment one more test was added
       in front of it, which is a flake, not a regression. Pin the premise. */
    const keepOpenedAt = ui.openedAt;
    ui.openedAt = Date.now() - 5000;
    let closed = false;
    const prev = window.hdClose;
    window.hdClose = () => { closed = true; };
    window.hdShowTab('followers');   // already on followers -> close
    window.hdClose = prev;
    ui.openedAt = keepOpenedAt;
    return closed || 'hdShowTab on the active tab did not close';
  });

  /* ==== per-tab size: the shared edit card + the deck's own icon size ====
     Five tabs (Quests / Notes / Numpad / Recent / Time) have no settings UI of
     their own — toggleEdit() routes the panes that DO into their own code and
     otherwise just flips ui.edit, which used to light up nothing at all on
     those five. So the card IS their edit mode; if it fails to appear the
     feature is invisible, with no error anywhere. */
  T('size card: it appears in edit mode on a tab that owns no settings', () => {
    ui.tab = 'quests'; ui.edit = true; render();
    return !$('tab-scale-card').classList.contains('hidden') || 'card stayed hidden on Quests';
  });
  T('size card: and never outside edit mode', () => {
    ui.edit = false; render();
    return $('tab-scale-card').classList.contains('hidden') || 'card shown with edit off';
  });
  T('size card: not on the Hotkeys tab — that one has its own settings card', () => {
    ui.tab = 'all'; ui.edit = true; render();
    const dup = !$('tab-scale-card').classList.contains('hidden');
    return !dup || 'two settings cards on the deck tab';
  });
  T('size card: it re-points at whichever tab is up', () => {
    ui.tab = 'notes'; ui.edit = true; render();
    const notes = $('tab-scale-card').getAttribute('data-for') === 'notes' &&
                  !!$('tsc-body').querySelector('.hds-row[data-hds="notes"]');
    ui.tab = 'numpad'; render();
    const numpad = $('tab-scale-card').getAttribute('data-for') === 'numpad' &&
                   !!$('tsc-body').querySelector('.hds-row[data-hds="numpad"]');
    return (notes && numpad) || 'card did not follow the tab';
  });
  T('size card: a repaint does not re-mount it (that would drop focus mid-press)', () => {
    ui.tab = 'notes'; ui.edit = true; render();
    const before = $('tsc-body').firstElementChild;
    render(); render();
    return $('tsc-body').firstElementChild === before || 'controls were rebuilt on every render';
  });
  T('size: the value round-trips in the hdSave payload', () => {
    /* settings.tabScales rides the existing whole-config save; C++ replaces
       the map wholesale, so anything missing from here is reset on reload. */
    HDScale.set('notes', 'ui', 1.2);
    const sent = JSON.parse(JSON.stringify(state));
    const rec = sent.settings && sent.settings.tabScales && sent.settings.tabScales.notes;
    HDScale.nudge('notes', 'ui', 0);
    return (rec && rec.ui === 1.2 && typeof rec.img === 'number') ||
           'tabScales missing or partial in the payload';
  });
  T('size: hdOpen re-applies what C++ sent, so a live refresh does not reset it', () => {
    window.hdOpen(JSON.stringify(Object.assign({}, state, {
      settings: Object.assign({}, state.settings, { tabScales: { recent: { ui: 1.5, img: 0 } } }),
    })));
    const applied = document.documentElement.style.getPropertyValue('--hdts-recent').trim() === '1.5';
    HDScale.reset();
    return applied || 'hdOpen did not re-apply tabScales';
  });
  T('deck icon size: the control lives with Menu scale, not in the shared card', () => {
    const row = $('deck-img-row');
    return (!!row && !!row.querySelector('.hds-row[data-hds="deck"]') &&
            row.closest('#settings-card') !== null) || 'deck icon row is not in the settings card';
  });
  T('deck icon size: it drives .hk-ico, and reset returns it to the CSS default', () => {
    /* Probed with a FRESH element: .hk-ico carries a width transition, so
       re-measuring a live row in the same tick returns the width the
       animation is starting from, not the one that lands. */
    const probe = () => {
      const el = document.createElement('span');
      el.className = 'hk-ico';
      $('list').append(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    ui.tab = 'all'; ui.edit = false; render();
    const dflt = probe();
    HDScale.set('deck', 'img', 56);
    const grew = Math.abs(probe() - 56) < 1;
    HDScale.nudge('deck', 'img', 0);
    return (dflt === 30 && grew && Math.abs(probe() - dflt) < 1) ||
           ('hk-ico did not follow --hdti-deck (default read ' + dflt + ')');
  });
  T('size: every tab in the bar can be sized', () => {
    /* The ask was "every single tab". A tab is covered either by the shared
       card, by its own pane control, or by a pre-existing one; the ONE thing
       that must never happen is a tab with no route to a size at all. */
    const OWN = { followers: 1, domains: 1, containers: 1, wardrobe: 1 };   // shipped their own scale earlier
    /* 'home' is a launcher, not a content pane — nothing to size, same as the
       Hotkeys ('all') button. The overflow systems live behind More now, not in
       #tabs, so this only sees the primary buttons. */
    const missing = [...document.querySelectorAll('#tabs .tab[data-tab]')]
      .map((b) => b.getAttribute('data-tab'))
      .filter((t) => t && t.indexOf('cat:') !== 0 && t !== 'all' && t !== 'home')
      .filter((t) => !OWN[t] && !(window.HDScale && HDScale.has(t)));
    return missing.length === 0 || ('tabs with no size control: ' + missing.join(', '));
  });

  ui.qDetail = null; ui.qList = null; ui.qNpc = null; ui.qNote = ''; ui.qConfirmStage = null;
  ui.tab = 'all'; ui.hkTab = 'all';
  ui.edit = false; ui.extOpen = false; ui.capture = null;
  ui.search = ''; $('search').value = '';
  closeHkIconPicker();   // else every later geometry check measures a covered panel
  ui.visible = true; document.body.classList.add('open');   // the hdShowTab-close check "closed" the dev page
  $('capture-modal').classList.add('hidden');
  render();

  const pass = results.filter((r) => r[0]).length;
  results.forEach((r) => console.log('[selftest] ' + (r[0] ? 'PASS' : 'FAIL') + ' ' + r[1] + (r[0] ? '' : ' — ' + r[2])));
  console.log('[selftest] ' + pass + '/' + results.length + ' passed');
  window.__selftest = { pass: pass, total: results.length, results: results };
  toast('Self-test: ' + pass + '/' + results.length + ' passed');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

if (DEV && location.search.indexOf('selftest=1') !== -1) {
  setTimeout(runSelfTest, 150);  // after the mocked hdOpen settles
}

/* ===================================================================== *
 *  Deck-wide hover tooltips.
 *
 *  Every control in every pane already carries title="…" hover text — and
 *  none of it has ever been visible in-game, because Ultralight does not
 *  render native title bubbles (the Domains face-tip discovered this and
 *  hand-built one tooltip; this generalises it). One delegated listener
 *  turns EVERY existing title, in every pane, into a drawn bubble — new
 *  panes get tooltips for free by doing the normal thing.
 *
 *  Self-contained and fail-safe: everything in one IIFE, wrapped so a
 *  tooltip bug can never take the deck down with it.
 * ===================================================================== */
(function () {
  try {
    var SHOW_DELAY = 350;   // long enough to not flicker while mousing across
    var tip = null, showTimer = null, current = null;

    function ensureTip() {
      if (!tip) {
        tip = document.createElement('div');
        tip.id = 'hd-tip';
        document.body.appendChild(tip);
      }
      return tip;
    }

    /* Nearest ancestor with a non-empty title. The title attribute stays in
       place (harmless in Ultralight; in a dev browser you may see both). */
    function titled(node) {
      while (node && node !== document.body && node.getAttribute) {
        var t = node.getAttribute('title');
        if (t) return node;
        node = node.parentNode;
      }
      return null;
    }

    function hide() {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
      if (tip) tip.classList.remove('show');
      current = null;
    }

    function showFor(el) {
      var text = el.getAttribute('title');
      if (!text) return;
      var t = ensureTip();
      t.textContent = text;
      t.classList.add('show');
      /* measure, then clamp inside the viewport; below the control by
         default, flipped above when there is no room */
      var r = el.getBoundingClientRect();
      t.style.left = '0px'; t.style.top = '0px';
      var w = t.offsetWidth, h = t.offsetHeight;
      var x = r.left + r.width / 2 - w / 2;
      var y = r.bottom + 8;
      if (x < 6) x = 6;
      if (x + w > window.innerWidth - 6) x = window.innerWidth - 6 - w;
      if (y + h > window.innerHeight - 6) y = r.top - h - 8;
      if (y < 6) y = 6;
      t.style.left = Math.round(x) + 'px';
      t.style.top = Math.round(y) + 'px';
    }

    document.addEventListener('mouseover', function (e) {
      var el = titled(e.target);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      showTimer = setTimeout(function () {
        /* the element may have been re-rendered out of the DOM meanwhile */
        if (current === el && document.body.contains(el)) showFor(el);
      }, SHOW_DELAY);
    });
    /* any click/scroll means the user acted — get out of the way */
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('wheel', hide, true);
    window.hdTipHide = hide;   // panes may force-hide around re-renders
  } catch (err) {
    console.log('tooltip layer failed to start', err);
  }
})();

/* ===================================================================== *
 *  Universal menu-size popover (#uiscale-pop) — Rober, 2026-08-07.
 *
 *  The Menu-scale control has always existed, buried in Edit ▸ settings.
 *  On a 4K screen (or a small one) resizing the whole deck is the FIRST
 *  thing a player wants, so the header's ⤢ button opens a popover with the
 *  same slider on EVERY tab, no edit mode needed. It drives the exact same
 *  state (settings.uiScale via setScale), so the Edit card, the popover
 *  and the persisted config can never disagree.
 * ===================================================================== */
(function () {
  try {
    var btn = $('uiscale-btn');
    if (!btn) return;
    var pop = null;
    installScrollSpeed();   // scroll-speed applies from load, even if the popover is never opened

    function build() {
      if (pop) return pop;
      pop = document.createElement('div');
      pop.id = 'uiscale-pop';
      pop.className = 'hidden';   // born hidden; the click's toggle reveals it
      pop.innerHTML =
        '<div class="usp-title">Display</div>' +
        '<div class="usp-row"><span class="usp-lbl">Menu size</span>' +
        '<span id="uiscale-val" class="usp-val">100%</span></div>' +
        '<input id="uiscale-range" type="range" min="' + SCALE_MIN + '" max="' + SCALE_MAX +
          '" step="' + SCALE_STEP + '" aria-label="Menu size">' +
        '<div class="usp-row"><span class="usp-lbl">Scroll speed</span>' +
        '<span id="scrollspeed-val" class="usp-val">100%</span></div>' +
        '<input id="scrollspeed-range" type="range" min="' + SCROLL_MIN + '" max="' + SCROLL_MAX +
          '" step="' + SCROLL_STEP + '" aria-label="Scroll speed">' +
        '<div class="usp-row usp-foot"><button id="uiscale-reset" class="ghost-btn">Reset</button>' +
        '<span class="usp-hint">Scales the whole deck and the scroll-wheel speed</span></div>';
      document.body.appendChild(pop);
      var range = pop.querySelector('#uiscale-range');
      var srange = pop.querySelector('#scrollspeed-range');
      /* native range drag is broken in Ultralight; every deck slider rides
         hdSmoothRange (registered by rooms-pane.js, loaded by now) */
      if (typeof window.hdSmoothRange === 'function') {
        window.hdSmoothRange(range);
        window.hdSmoothRange(srange);
      }
      installScrollSpeed();
      range.addEventListener('input', function () {
        setScale(Number(range.value), false);
        saveSoon();
      });
      srange.addEventListener('input', function () {
        state.settings.scrollSpeed = clampScroll(Number(srange.value));
        var v = pop.querySelector('#scrollspeed-val');
        if (v) v.textContent = Math.round(state.settings.scrollSpeed * 100) + '%';
        saveSoon();
      });
      pop.querySelector('#uiscale-reset').addEventListener('click', function () {
        setScale(1, false);
        state.settings.scrollSpeed = 1;
        saveSoon();
        syncPop();
      });
      /* outside click closes — capture, so a click that re-renders a pane
         cannot strand an open popover */
      document.addEventListener('mousedown', function (e) {
        if (!pop || pop.classList.contains('hidden')) return;
        if (pop.contains(e.target) || e.target === btn || btn.contains(e.target)) return;
        pop.classList.add('hidden');
      }, true);
      return pop;
    }

    function syncPop() {
      if (!pop) return;
      var s = clampScale(state.settings.uiScale);
      var range = pop.querySelector('#uiscale-range');
      var val = pop.querySelector('#uiscale-val');
      if (range && Number(range.value) !== s) range.value = String(s);
      if (val) val.textContent = Math.round(s * 100) + '%';
      var sp = clampScroll(state.settings.scrollSpeed);
      var srange = pop.querySelector('#scrollspeed-range');
      var sval = pop.querySelector('#scrollspeed-val');
      if (srange && Number(srange.value) !== sp) srange.value = String(sp);
      if (sval) sval.textContent = Math.round(sp * 100) + '%';
    }
    window.hdSyncScalePop = syncPop;   // applyScale calls this when loaded

    btn.addEventListener('click', function () {
      build();
      var hidden = pop.classList.toggle('hidden');
      if (hidden) return;
      syncPop();
      /* ⚠ FIXED and body-level, deliberately OUTSIDE the scaled panel. The
         first version sat inside #panel "so it scales with the deck" — but
         the slider then rode the very surface it was scaling: every drag
         tick rescaled the panel, moved the slider's rect under the cursor,
         and the value chased itself (Rober: "dragging causes all sorts of
         chaos"). Anchored to the button's SCREEN rect at open, it stays put
         while the deck resizes live behind it. */
      var r = btn.getBoundingClientRect();
      pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
      pop.style.top = Math.round(Math.min(r.bottom + 8, window.innerHeight - 40)) + 'px';
    });
  } catch (err) {
    console.log('uiscale popover failed to start', err);
  }
})();
