'use strict';

/* ====================================================================== *
 *  Spell Deck — the magic-organizer view (second PrismaUI view inside the
 *  Hotkey Deck plugin). Vertical category rail + searchable spell list;
 *  each spell is tagged Cast (fires on click) or Equip (toggles into a
 *  hand / the voice slot). Mirrors the deck view's bridge + capture idioms.
 *
 *  Bridge — C++ registers these JS→C++ listeners:
 *    mdFire(id) · mdCastCombo(json) · mdKnown() · mdSave(json) · mdClose() ·
 *    mdLog(str) · mdCapture("1"|"0") · mdRemoveSpell(json) · mdRestoreSpell(json) ·
 *    mdGetDesc(json) · mdIconList()
 *  C++ calls into us:
 *    mdOpen(cfg) · mdEquipState(s) · mdClosed() · mdSaved(ok) · mdSpells(rows) ·
 *    mdToggled(res) · mdRemoved(res) · mdRestored(res) · mdDesc(res) ·
 *    mdIconIndex(idx) · mdIcons(list) ·
 *    hdExtKey(info) · hdNativeMouse(info)   (last two shared w/ deck)
 * ====================================================================== */

const DEV = location.search.indexOf('dev=1') !== -1;
const SELFTEST = location.search.indexOf('selftest=1') !== -1;

function toGame(fn, arg) {
  const f = window[fn];
  if (typeof f === 'function') {
    try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
  } else {
    console.log('[dev->game]', fn, arg);
  }
}
function glog(msg) { toGame('mdLog', msg); }

/* ========================================================== key maps ==== */

const MODIFIER_CODES = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

/* KeyboardEvent.code -> [DIK scancode, label] (same table the deck uses) */
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

/* mouse: e.button -> [skyrim idCode, label] (L/R reserved for the UI) */
const MOUSE = { 1: [2, 'Middle Mouse'], 3: [3, 'Mouse 4'], 4: [4, 'Mouse 5'] };

/* Ultralight may deliver keydown without e.code — reconstruct from legacy keyCode. */
function codeFromEvent(e) {
  if (e.code) return e.code;
  const k = e.keyCode || e.which || 0;
  if (k >= 65 && k <= 90) return 'Key' + String.fromCharCode(k);
  if (k >= 48 && k <= 57) return 'Digit' + (k - 48);
  if (k >= 96 && k <= 105) return 'Numpad' + (k - 96);
  if (k >= 112 && k <= 123) return 'F' + (k - 111);
  const misc = { 32: 'Space', 13: 'Enter', 9: 'Tab', 8: 'Backspace', 27: 'Escape',
    46: 'Delete', 45: 'Insert', 36: 'Home', 35: 'End', 33: 'PageUp', 34: 'PageDown',
    37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 188: 'Comma',
    190: 'Period', 191: 'Slash', 222: 'Quote', 186: 'Semicolon' };
  return misc[k] || '';
}

/* FormID numeric -> canonical "0x%08X" string, matching SpellActions::HexId. */
function hexId(n) { return '0x' + ((n >>> 0).toString(16).toUpperCase().padStart(8, '0')); }
/* hex STRING (any case / prefix) -> that same canonical form, '' if unparsable.
 * The old String().toUpperCase() normalization uppercased the "0x" prefix too
 * ("0X0002DD29"), which could never equal a hexId() ("0x0002DD29") — so the
 * equip badges silently never reconciled. Every engine-sent hex id must pass
 * through here before being stored or compared. */
function canonHex(s) {
  const n = parseInt(String(s || '').replace(/^0x/i, ''), 16);
  return isNaN(n) ? '' : hexId(n);
}

/* ============================================================= state ==== */

const state = {
  openKey: { device: 'keyboard', code: 105, label: 'F18' },
  addKey: { device: 'keyboard', code: 0x4E, label: 'Num +' },  // Magic Menu capture key
  removeOnAdd: false,             // capture also clears the spell from the spellbook
  uiScale: 1.0,
  iconPx: 0,                      // spell-row icon box in px (0 = the CSS default)
  panelW: 0,                      // user drag size, PRE-scale layout px (0 = auto)
  panelH: 0,
  categories: [],                 // rail order (strings)
  spells: [],                     // {id,plugin,localId,formId,name,mode,hand,category}
  combos: [],                     // drag-spells-together groups, cast all at once:
                                  // {id,name,spells:[{plugin,localId,formId,name,type,school,element,archetype}]}
  removed: [],                    // spells cleared from the spellbook, restorable
                                  // {plugin,localId,formId,name,type,school,element,archetype}
  catIcons: {},                   // rail glyphs, category NAME -> "icons/custom/x.png"
};

const ALL = '__all__';
const SMIN = 0.6, SMAX = 1.6, SSTEP = 0.1;
const COMBO_MAX = 12;             // sanity cap, mirrored in C++ (kComboMaxSpells)

const ui = {
  cat: ALL,                       // selected category (ALL or a name)
  editing: false,
  filter: '',
  sel: -1,                        // keyboard selection in the visible list
  equip: { left: '', right: '', voice: new Set() },  // hex strings from engine
  known: [],                      // last mdSpells payload
  knownById: new Map(),           // hex -> {slot,type,delivery,casting}
  knownLoading: false,
  addOpen: false,
  addCat: null,                   // category the add-modal writes into
  addFilter: '',
  capture: null,                  // 'open' while rebinding the open key
  armDelCat: null,                // category name armed for delete (two-click)
  armBookCat: null,               // category armed for remove-all-from-spellbook (two-click)
  removedOpen: false,             // is the "Removed from spellbook" section expanded
};

/* drag scratch. comboDragActive = a VIEW-mode spell drag is in flight, so the
 * combo strip shows its drop targets (edit-mode spell drags stay pure reorder). */
let dragKind = null, dragCatFrom = -1, dragSpellId = null, dragComboFrom = -1;
let comboDragActive = false;

/* ========================================================== helpers ==== */

const $ = (id) => document.getElementById(id);

function h(tag, attrs) {
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

/* name with the search term highlighted, returned as child nodes */
function nameNodes(name, q) {
  name = String(name || '');
  if (!q) return [document.createTextNode(name)];
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [document.createTextNode(name)];
  return [
    document.createTextNode(name.slice(0, i)),
    h('mark', null, name.slice(i, i + q.length)),
    document.createTextNode(name.slice(i + q.length)),
  ];
}

let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 1900);
}

function payload() {
  return {
    openKey: { device: state.openKey.device, code: state.openKey.code, label: state.openKey.label },
    addKey: { device: state.addKey.device, code: state.addKey.code, label: state.addKey.label },
    removeOnAdd: !!state.removeOnAdd,
    uiScale: state.uiScale,
    iconPx: state.iconPx | 0,
    panelW: state.panelW | 0,
    panelH: state.panelH | 0,
    categories: state.categories.slice(),
    spells: state.spells.map((s) => ({
      id: s.id, plugin: s.plugin, localId: s.localId, formId: s.formId,
      name: s.name, mode: s.mode, hand: s.hand, category: s.category,
      slot: s.slot || '', school: s.school || '', element: s.element || '', archetype: s.archetype || '',
      tier: s.tier || '', icon: s.icon || '',
    })),
    combos: state.combos.map((c) => ({
      id: c.id, name: c.name || '',
      spells: c.spells.map((m) => ({
        plugin: m.plugin, localId: m.localId, formId: m.formId, name: m.name,
        type: m.type || '', school: m.school || '', element: m.element || '', archetype: m.archetype || '',
        tier: m.tier || '', icon: m.icon || '',
      })),
    })),
    removed: state.removed.map((r) => ({
      plugin: r.plugin, localId: r.localId, formId: r.formId, name: r.name,
      type: r.type || '', school: r.school || '', element: r.element || '', archetype: r.archetype || '',
      tier: r.tier || '',
    })),
    catIcons: Object.assign({}, state.catIcons),
  };
}
function save() { toGame('mdSave', JSON.stringify(payload())); }
let saveT = null;
function saveSoon() { if (saveT) clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; save(); }, 350); }

function curScale() { return Math.min(SMAX, Math.max(SMIN, state.uiScale || 1)); }

function applyScale() {
  const v = curScale();
  document.documentElement.style.setProperty('--ui-scale', v);
  const el = $('scale-val'); if (el) el.textContent = Math.round(v * 100) + '%';
  applyPanelSize();   // the size ceiling is a function of the scale — re-clamp
}

/* ---- icon size: one variable drives the box, the art and the glyph ---- *
 * Independent of --ui-scale on purpose: the menu can stay at 100% while the
 * art gets big, which is what "larger images" actually means here.        */
const IMIN = 28, IMAX = 96, ISTEP = 4, IDEF = 44;
function clampIconPx(v) { return Math.max(IMIN, Math.min(IMAX, Math.round(Number(v) || 0))); }
function curIconPx() { return state.iconPx > 0 ? clampIconPx(state.iconPx) : IDEF; }
function applyIconSize() {
  const px = curIconPx();
  document.documentElement.style.setProperty('--icon-px', px + 'px');
  const el = $('icon-size-val');
  if (el) el.textContent = state.iconPx > 0 ? String(px) : (IDEF + ' (auto)');
  const dn = $('icon-size-down'), up = $('icon-size-up'), rs = $('icon-size-reset');
  if (dn) dn.disabled = px <= IMIN;
  if (up) up.disabled = px >= IMAX;
  if (rs) rs.disabled = state.iconPx === 0;
}
function setIconPx(px) {
  state.iconPx = clampIconPx(px);
  applyIconSize(); saveSoon();
}
function resetIconPx() {
  if (!state.iconPx) { applyIconSize(); return; }
  state.iconPx = 0;
  applyIconSize(); saveSoon();
  toast('Icon size reset');
}
function setScale(v) {
  state.uiScale = Math.min(SMAX, Math.max(SMIN, Math.round(v * 10) / 10));
  applyScale(); saveSoon();
}

/* ======================================================= panel size ==== *
 *  The panel has an auto default (CSS: min(1500px, 94vw / uiScale)) plus an
 *  optional user drag size in --panel-w / --panel-h, persisted as
 *  panelW/panelH.
 *
 *  SCALE vs RESIZE — the rule, in one line: a dragged size is PRE-scale
 *  LAYOUT size; --ui-scale still transform-scales the panel on top of it.
 *  So 1400x900 at scale 1.2 paints 1680x1080 on screen, which is why every
 *  clamp here divides the viewport budget by the scale — the ceiling is
 *  what still FITS once scaled, exactly like the CSS default formula.
 *  0 = auto: the var is removed and the CSS default wins again.           */

const PMIN_W = 720, PMIN_H = 560;      // floor, pre-scale layout px
const PMAX_VW = 0.96, PMAX_VH = 0.94;  // ceiling, share of the viewport

/* largest pre-scale size that still fits on screen at the current scale */
function panelMax() {
  const s = curScale();
  return {
    w: Math.floor((window.innerWidth * PMAX_VW) / s),
    h: Math.floor((window.innerHeight * PMAX_VH) / s),
  };
}
/* clamp into [floor, ceiling] — the floor collapses to the ceiling on a
 * viewport too small to hold it, so min can never out-rank max */
function clampPanelDim(v, min, max) { return Math.round(Math.max(Math.min(min, max), Math.min(v, max))); }
function clampPanelW(w) { return clampPanelDim(w, PMIN_W, panelMax().w); }
function clampPanelH(h) { return clampPanelDim(h, PMIN_H, panelMax().h); }

/* state -> CSS vars. Re-clamps on every call (scale change, resolution change,
 * a size saved on a bigger screen) but never edits state — so a size chosen on
 * a 4K rig survives being opened once at 1080p. */
function applyPanelSize() {
  const st = document.documentElement.style;
  const custom = state.panelW > 0 && state.panelH > 0;
  if (custom) {
    st.setProperty('--panel-w', clampPanelW(state.panelW) + 'px');
    st.setProperty('--panel-h', clampPanelH(state.panelH) + 'px');
  } else {
    st.removeProperty('--panel-w');
    st.removeProperty('--panel-h');
  }
  const val = $('panel-size-val');
  if (val) {
    val.textContent = custom ? (clampPanelW(state.panelW) + '×' + clampPanelH(state.panelH)) : 'Auto';
    val.classList.toggle('custom', custom);
  }
  const rst = $('panel-size-reset');
  if (rst) rst.disabled = !custom;
}

function setPanelSize(w, h) {
  state.panelW = clampPanelW(w);
  state.panelH = clampPanelH(h);
  applyPanelSize();
  saveSoon();
}
function resetPanelSize() {
  if (!state.panelW && !state.panelH) { applyPanelSize(); return; }
  state.panelW = 0; state.panelH = 0;
  applyPanelSize();
  saveSoon();
  toast('Panel size reset');
}

/* Grip drag. Mouse events, not Pointer — every other drag path in this view
 * uses them and Ultralight delivers them reliably.
 * The panel is CENTRED in the overlay, so half of any growth goes to each
 * side: moving the corner 1 screen-px out must grow the layout box by
 * 2px / uiScale. Tracking the corner absolutely (not summing deltas) keeps
 * the grip glued to the cursor with no drift across a long drag. */
let gripDrag = null;

function gripDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  closeCtx(); cancelDesc();
  const r = $('panel').getBoundingClientRect();   // on-screen (already scaled)
  gripDrag = {
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    offX: e.clientX - r.right, offY: e.clientY - r.bottom,   // grab point vs the corner
  };
  document.body.classList.add('resizing');
  document.addEventListener('mousemove', gripMove, true);
  document.addEventListener('mouseup', gripUp, true);
}
function gripMove(e) {
  if (!gripDrag) return;
  e.preventDefault();
  const s = curScale();
  setPanelSize(2 * ((e.clientX - gripDrag.offX) - gripDrag.cx) / s,
               2 * ((e.clientY - gripDrag.offY) - gripDrag.cy) / s);
}
function gripUp() {
  if (!gripDrag) return;
  gripDrag = null;
  document.body.classList.remove('resizing');
  document.removeEventListener('mousemove', gripMove, true);
  document.removeEventListener('mouseup', gripUp, true);
  // the last gripMove already queued the debounced save — nothing else to do
}

function countIn(cat) { return state.spells.filter((s) => s.category === cat).length; }
function slotOf(spell) {
  const k = ui.knownById.get(hexId(spell.formId));
  return k ? k.slot : 'hand';   // default to hand controls when the spell isn't currently known
}
function isShout(spell) {
  // Shouts are the ONE thing the spellbook-remove path refuses (a TESShout has
  // no spellbook entry). Unknown-id fallback is "not a shout" — the C++ side
  // answers honestly if a shout slips through.
  const k = ui.knownById.get(hexId(spell.formId));
  return !!k && k.type === 'shout';
}
function deliveryOf(spell) {
  const k = ui.knownById.get(hexId(spell.formId));
  return k ? k.delivery : '';
}

function uniqueCat(base, exceptIdx) {
  base = (base || '').trim() || 'New Category';
  let name = base, n = 2;
  const taken = (nm) => state.categories.some((c, i) => i !== exceptIdx && c.toLowerCase() === nm.toLowerCase());
  while (taken(name)) name = base + ' ' + (n++);
  return name;
}
function newSpellId(formId) {
  const base = hexId(formId);
  let id = base, n = 2;
  while (state.spells.some((s) => s.id === id)) id = base + '-' + (n++);
  return id;
}

/* ============================================================ icons ==== */
/* Reproduce the magic menu's visual language — school + element (+ a few
 * distinctive archetypes) -> a crisp inline SVG. Faithful to what the game
 * shows, but self-contained (no SWF extraction). Colour comes from CSS
 * (.glyph.ic-<key>); every path uses currentColor. */

const ICON_SVG = {
  fire: '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M12 2c2 3.2 5 5.2 5 9.2A5 5 0 0 1 7 11.4c0-1.3.5-2.4 1.2-3.4.3.9.9 1.5 1.7 1.8C10.6 7.3 11 4.6 12 2zm0 10.6a1.9 1.9 0 0 0-1.9 1.9 1.9 1.9 0 1 0 3.8 0A1.9 1.9 0 0 0 12 12.6z"/></svg>',
  frost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M4 6.5 20 15.5M20 6.5 4 15.5M12 5.5l2.2-2.2M12 5.5 9.8 3.3M12 18.5l2.2 2.2M12 18.5l-2.2 2.2M5.6 8.1 2.8 7.5M5.6 8.1 5.2 5.2M18.4 13.9l2.8.6M18.4 13.9l.4 2.9M18.4 8.1l2.8-.6M18.4 8.1 18.8 5.2M5.6 13.9l-2.8.6M5.6 13.9 5.2 16.8"/></svg>',
  shock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 13.5h5.5L8 22l10-12.5h-6L13 2z"/></svg>',
  destruction: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 1.9 5.7L19 5.5l-2.3 5.2L22 12l-5.3 1.2L19 18.5l-5.1-2.2L12 22l-1.9-5.7L5 18.5l2.3-5.3L2 12l5.3-1.3L5 5.5l5.1 2.2z"/></svg>',
  restoration: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3.8"/><path d="M12 2.2v3M12 18.8v3M2.2 12h3M18.8 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/></svg>',
  alteration: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2.5 20 7v10l-8 4.5L4 17V7z"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>',
  conjuration: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M12 4.6 19.2 16H4.8z"/><circle cx="12" cy="4.6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.8" cy="16" r="1.3" fill="currentColor" stroke="none"/><circle cx="19.2" cy="16" r="1.3" fill="currentColor" stroke="none"/></svg>',
  illusion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="7.7" r="4"/><path d="M4.2 21c0-4.3 3.5-7 7.8-7s7.8 2.7 7.8 7z"/></svg>',
  shout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 5 14 12l-7.5 7"/><path d="M12 6l6 6-6 6" opacity=".55"/></svg>',
  bound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 14 4.2v8.6l-2 2-2-2V4.2z"/><path d="M8 14.8h8M12 16.8v5M9.6 21.8h4.8"/></svg>',
  summon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 12a2 2 0 0 1 2-2 4 4 0 0 1-4 4 6 6 0 0 1 6-6 8 8 0 0 1-8 8"/></svg>',
  reanimate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M6 15c-1.2-1-2-2.6-2-4.6C4 6 7.6 3 12 3s8 3 8 7.4c0 2-.8 3.6-2 4.6v3.4a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><circle cx="9" cy="11" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.4" fill="currentColor" stroke="none"/><path d="M10 18.2v1.8M12 18.2v1.8M14 18.2v1.8"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.5 4.2 1.6 5.3 5.8 5.8C13.6 8.3 12.5 9.4 12 13.6c-.5-4.2-1.6-5.3-5.8-5.8C10.4 7.3 11.5 6.2 12 2z"/><circle cx="18" cy="16.5" r="1.4"/><circle cx="6.5" cy="17.5" r="1"/></svg>',
  spell: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.6 4.9 2.3 6.6 7.2 7.2C14.3 9.8 12.6 11.5 12 16.4c-.6-4.9-2.3-6.6-7.2-7.2C9.7 8.6 11.4 6.9 12 2z"/></svg>',
};

/* name keyword -> icon key (fallback when engine metadata is absent) */
const NAME_ICON = [
  [/fire|flame|firebolt|fireball|incinerat|inferno|\bburn|scorch|magma|lava|ember|cinder|blaze|pyro|volcan|erupt|sear|immolat|smolder|brimstone|combust|kindle|charr/, 'fire'],
  [/frost|\bice\b|icy|freez|blizzard|glacial|icicle|winter|\bcold|\bchill|snow|hoarfrost/, 'frost'],
  [/shock|lightning|spark|thunder|\bstorm|volt|electr|arc\b/, 'shock'],
  [/heal|mend|restor|\bcure|regenerat|\bward\b|sunfire|sunlight|dawnbreak|guardian|repel|turn undead|hallow|stendarr|\blife\b|grand healing/, 'restoration'],
  [/^bound |summon|conjure|raise |reanimat|zombie|thrall|atronach|dremora|familiar|\bdead\b|corpse|banish|soul trap|command daedra/, 'conjuration'],
  [/oakflesh|stoneflesh|ironflesh|ebonyflesh|dragonhide|flesh\b|paralys|telekinesis|detect|magelight|candlelight|transmut|waterbreath|equilibrium|ash shell|ash rune/, 'alteration'],
  [/\bfear\b|\bfury\b|\bcalm\b|frenzy|courage|rally|muffle|invisib|clairvoyance|illusion|pacify|harmony|hysteria|\brout\b|call to arms|rage\b|mayhem/, 'illusion'],
];
function iconKeyFromName(name) {
  const n = String(name || '').toLowerCase();
  for (let i = 0; i < NAME_ICON.length; i++) if (NAME_ICON[i][0].test(n)) return NAME_ICON[i][1];
  return 'spell';
}

/* a handful of archetypes read clearer than a bare school glyph */
const ARCH_ICON = { bound: 'bound', summon: 'summon', reanimate: 'reanimate', light: 'light' };

function iconKeyFor(m) {
  m = m || {};
  if (m.type === 'voice') return 'shout';                 // shouts
  if (m.slot === 'voice' || m.type === 'power' || m.type === 'lesser') return 'power';
  if (m.element === 'fire') return 'fire';                // Destruction splits by element
  if (m.element === 'frost') return 'frost';
  if (m.element === 'shock') return 'shock';
  if (m.archetype && ARCH_ICON[m.archetype]) return ARCH_ICON[m.archetype];
  switch (m.school) {                                     // otherwise the school icon
    case 'destruction': return 'destruction';
    case 'restoration': return 'restoration';
    case 'alteration':  return 'alteration';
    case 'conjuration': return 'conjuration';
    case 'illusion':    return 'illusion';
  }
  return iconKeyFromName(m.name);                          // last resort: classify by name
}

function glyphEl(key, extra) {
  return h('span', { class: 'glyph ic-' + key + (extra ? ' ' + extra : ''), html: ICON_SVG[key] || ICON_SVG.spell });
}

/* merge live engine metadata (authoritative) over the entry's saved snapshot */
function metaFor(s) {
  const k = ui.knownById.get(hexId(s.formId));
  return {
    name: s.name,
    plugin: s.plugin || '',
    localId: s.localId,
    formId: s.formId,
    icon: s.icon || '',
    slot: (k && k.slot) || s.slot || 'hand',
    type: (k && k.type) || s.type || '',
    school: (k && k.school) || s.school || '',
    element: (k && k.element) || s.element || '',
    archetype: (k && k.archetype) || s.archetype || '',
    tier: (k && k.tier) || s.tier || '',
  };
}

/* ============================================== Spell Hotbar icon library ==
 * 1,900+ real spell icons, extracted at build time from Spell Hotbar 2's DDS
 * atlases into icons/sh/<atlas>/<key>.png + an index. C++ pushes the index
 * once per session (mdIconIndex) and the live listing of icons/custom/ on
 * every open (mdIcons) — drop a PNG in that folder mid-game, hit Refresh in
 * the picker, and it's usable. Resolution order per spell:
 *   entry.icon override → exact byForm[plugin|localIdHex] → school/tier
 *   generic → inline SVG glyph (the pre-0.7 look, and the no-library case). */

const ICONS = { byForm: null, generic: null, catalog: [], custom: [] };

function normPath(p) { return String(p || '').replace(/\\/g, '/'); }

/* exact-match key: lowercase plugin + "|" + lowercase local-formId hex, no
 * leading zeros — matches the extractor's byForm keys (GetLocalFormID() equals
 * the CSV FormID for ESM/ESP/ESL alike; proven against SH2's own sheets). */
function shKeyFor(m) {
  if (!m || !m.plugin || m.localId == null) return null;
  return String(m.plugin).toLowerCase() + '|' + ((m.localId >>> 0).toString(16));
}

const TIER_KEY = { novice: 'NOVICE', apprentice: 'APPRENTICE', adept: 'ADEPT', expert: 'EXPERT', master: 'MASTER' };

/* The SAME ladder the SVG glyph walks (element → archetype → name keywords),
 * but answering in the engine's own vocabulary so the REAL icon path can use
 * it too. Without this the two paths disagree: a spell with no `school` still
 * gets a flame GLYPH from its name while the PNG chain — which only ever
 * looked at `school` — gives up and drops to that flat glyph, even though
 * DESTRUCTION_FIRE_*.png is sitting right there in the library. That is the
 * whole "my mod spells went back to emojis" failure: an entry saved without
 * engine metadata (older build, or a spell the known-spells list doesn't
 * cover) has no school, forever. */
const ARCH_SCHOOL = {
  bound: 'conjuration', summon: 'conjuration', reanimate: 'conjuration',
  light: 'alteration', detect: 'alteration', paralysis: 'alteration', telekinesis: 'alteration',
  turnundead: 'restoration', banish: 'restoration',
  fear: 'illusion', frenzy: 'illusion', calm: 'illusion', rally: 'illusion', invisibility: 'illusion',
};
function schoolGuess(m) {
  m = m || {};
  if (m.element === 'fire' || m.element === 'frost' || m.element === 'shock')
    return { school: 'destruction', element: m.element };
  if (m.archetype && ARCH_SCHOOL[m.archetype])
    return { school: ARCH_SCHOOL[m.archetype], element: '' };
  const k = iconKeyFromName(m.name);   // 'fire'|'frost'|'shock'|a school|'spell'
  if (k === 'fire' || k === 'frost' || k === 'shock') return { school: 'destruction', element: k };
  if (k === 'destruction' || k === 'restoration' || k === 'alteration' ||
      k === 'conjuration' || k === 'illusion') return { school: k, element: '' };
  return { school: '', element: '' };
}

/* school/element/archetype/tier -> a default_icons generic name (or null) */
function genericKeyFor(m) {
  m = m || {};
  if (m.type === 'voice') return 'SHOUT_GENERIC';
  if (m.type === 'power') return 'GREATER_POWER';
  if (m.type === 'lesser') return 'LESSER_POWER';
  // no live `type`, but the saved snapshot knows it takes the voice slot
  if (!m.type && m.slot === 'voice') return 'GREATER_POWER';
  const t = TIER_KEY[m.tier] || 'ADEPT';
  let school = m.school, element = m.element;
  if (!school) {
    const g = schoolGuess(m);
    school = g.school;
    element = element || g.element;
  }
  switch (school) {
    case 'destruction':
      if (element === 'fire') return 'DESTRUCTION_FIRE_' + t;
      if (element === 'frost') return 'DESTRUCTION_FROST_' + t;
      if (element === 'shock') return 'DESTRUCTION_SHOCK_' + t;
      return 'DESTRUCTION_GENERIC_' + t;
    case 'alteration': return 'ALTERATION_' + t;
    case 'restoration':
      return ((m.archetype === 'turnundead' || m.archetype === 'banish')
        ? 'RESTORATION_HOSTILE_' : 'RESTORATION_FRIENDLY_') + t;
    case 'illusion':
      return ((m.archetype === 'fear' || m.archetype === 'frenzy' || m.archetype === 'calm')
        ? 'ILLUSION_HOSTILE_' : 'ILLUSION_FRIENDLY_') + t;
    case 'conjuration':
      return (m.archetype === 'bound' ? 'CONJURATION_BOUND_WEAPON_' : 'CONJURATION_SUMMON_') + t;
  }
  return null;
}

/* the resolve chain; null = use the SVG glyph */
function resolveIconPath(m) {
  if (m && m.icon) return normPath(m.icon);
  if (ICONS.byForm && m) {
    const k = shKeyFor(m);
    if (k && ICONS.byForm[k]) return ICONS.byForm[k];
  }
  if (ICONS.generic) {
    const g = genericKeyFor(m);
    if (g && ICONS.generic[g]) return ICONS.generic[g];
  }
  return null;
}

/* icon element: real <img> when the chain resolves, SVG glyph otherwise.
 * A broken src (deleted custom file, stale override) swaps itself for the
 * glyph via onerror, so rows never show a broken-image box. */
function iconEl(m, extra) {
  const p = resolveIconPath(m);
  if (!p) return glyphEl(iconKeyFor(m), extra);
  const img = h('img', { src: p, alt: '', draggable: 'false' });
  const el = h('span', { class: 'glyph img' + (extra ? ' ' + extra : '') }, img);
  img.addEventListener('error', () => {
    const fb = glyphEl(iconKeyFor(m), extra);
    if (el.parentNode) el.parentNode.replaceChild(fb, el);
  });
  return el;
}

window.mdIconIndex = function (idx) {
  idx = coerce(idx);
  if (!idx || typeof idx !== 'object') {
    ICONS.byForm = null; ICONS.generic = null; ICONS.catalog = [];
    render();
    return;
  }
  const byForm = {}, generic = {};
  const bf = idx.byForm || {};
  for (const k in bf) byForm[String(k).toLowerCase()] = normPath(bf[k]);
  const gn = idx.generic || {};
  for (const k in gn) generic[k] = normPath(gn[k]);
  ICONS.byForm = byForm;
  ICONS.generic = generic;
  ICONS.catalog = (Array.isArray(idx.catalog) ? idx.catalog : []).map((c) => ({
    file: normPath(c.file), atlas: c.atlas || '', label: c.label || '', kind: c.kind || '', key: c.key || '',
  })).filter((c) => c.file);
  render();
};

window.mdIcons = function (r) {
  r = coerce(r);
  ICONS.custom = (((r && r.custom) || [])).map((c) => ({
    file: normPath(c.file), label: c.label || '',
  })).filter((c) => c.file);
  if (iconPicker.open) { iconPicker.shown = ICON_PAGE; renderIconPicker(); }
};

/* =========================================================== render ==== */

function render() { renderRail(); renderCombos(); renderList(); renderRemoved(); syncChrome(); }

function syncChrome() {
  const ed = ui.editing;
  document.body.classList.toggle('editing', ed);
  $('edit-btn').classList.toggle('on', ed);
  $('edit-btn').textContent = ed ? 'Done' : 'Edit';
  $('edit-tools').classList.toggle('hidden', !ed);
  $('openkey-card').classList.toggle('hidden', !ed);
  $('add-cat-btn').classList.toggle('hidden', !ed);
  $('add-spell-btn').classList.remove('hidden');       // adding is the core action — always available
  applyIconSize();
  $('openkey-btn').textContent = state.openKey.label || 'F18';
  const akb = $('addkey-btn');
  if (akb) akb.textContent = state.addKey.label || 'Num +';
  const roa = $('remove-on-add');
  if (roa) roa.checked = !!state.removeOnAdd;
  applyScale();
}

/* Same defence as followers-pane's iconSrc: a stored value must stay a
 * view-relative icons/ path — a hand-edited hotkeys.json never hands the
 * webview a filesystem path or an escape out of the view root. */
function catIconSrc(p) {
  p = String(p == null ? '' : p).replace(/\\/g, '/');
  if (!p) return '';
  if (p.indexOf('..') !== -1) return '';
  if (p.charAt(0) === '/') return '';
  if (/^[A-Za-z]:/.test(p)) return '';
  if (/^(?:file|https?):/i.test(p)) return '';
  return p;
}

/* The rail slot: fixed square so names start on one vertical line whether or
 * not a category carries a glyph; only emitted when needed (icon set, edit
 * mode, or the rail is MIXED) — an undecorated rail keeps today's layout. */
function anyCatIcon() {
  for (const k in state.catIcons) if (state.catIcons[k]) return true;
  return false;
}
function railIconEl(cat, editable) {
  const src = cat === ALL ? '' : (state.catIcons[cat] || '');
  if (ui.editing && editable) {
    return h('button', {
      class: 'rail-ic pick' + (src ? '' : ' empty'),
      title: src ? 'Change category icon' : 'Set category icon',
      onClick: (e) => { e.stopPropagation(); openCatIconPicker(cat); },
    }, src ? h('img', { src, draggable: 'false' }) : null);
  }
  if (!anyCatIcon()) return null;             // no column reserved on an undecorated rail
  return h('span', { class: 'rail-ic' + (src ? '' : ' empty') },
    src ? h('img', { src, draggable: 'false' }) : null);
}

function railRow(cat, label, count, editable, idx) {
  const selected = ui.cat === cat;
  if (ui.editing && editable) {
    const armed = ui.armDelCat === cat;
    const row = h('div', {
      class: 'rail-item edit' + (selected ? ' sel' : ''),
      data: { cat },
      onMousedown: (e) => pdArm(e, { kind: 'cat', cat, catIdx: idx }),
    },
      h('span', { class: 'drag-h', title: 'Drag to reorder' }, '⋮⋮'),
      railIconEl(cat, editable),
      h('input', {
        class: 'rail-rename', type: 'text', value: label, spellcheck: 'false',
        title: 'Rename category',
        onFocus: () => { if (ui.cat !== cat) { ui.cat = cat; ui.sel = -1; renderList(); } },
        onChange: (e) => renameCategory(idx, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      }),
      h('button', {
        class: 'icon-btn danger' + (armed ? ' confirm' : ''),
        title: armed ? 'Click again to remove category + its spells' : 'Remove category',
        onClick: (e) => { e.stopPropagation(); deleteCategory(cat); },
      }, armed ? '✓?' : '🗑'),
    );
    return row;
  }
  return h('div', {
    class: 'rail-item' + (cat === ALL ? ' all' : '') + (selected ? ' sel' : ''),
    data: { cat },
    onClick: () => {
      ui.cat = cat; ui.sel = -1; ui.armDelCat = null; ui.armBookCat = null; render();
      const l = $('list'); if (l) l.scrollTop = 0;   // fresh category starts at the top
    },
  },
    railIconEl(cat, false),
    h('span', { class: 'rail-name' }, label),
    h('span', { class: 'rail-count' }, String(count)),
  );
}

function renderRail() {
  const rl = $('rail-list');
  rl.textContent = '';
  rl.append(railRow(ALL, 'All spells', state.spells.length, false));
  state.categories.forEach((cat, i) => rl.append(railRow(cat, cat, countIn(cat), true, i)));
}

function visibleSpells() {
  const q = ui.filter.trim().toLowerCase();
  let arr = state.spells.filter((s) => ui.cat === ALL || s.category === ui.cat);
  if (q) arr = arr.filter((s) => String(s.name || '').toLowerCase().includes(q));
  return arr;
}

function spellRow(spell, i) {
  const q = ui.filter.trim();
  const isEquip = spell.mode === 'equip';
  const slot = slotOf(spell);
  const hx = hexId(spell.formId);
  const eqL = ui.equip.left === hx, eqR = ui.equip.right === hx, eqV = ui.equip.voice.has(hx);
  const equipped = isEquip && (slot === 'voice' ? eqV : (eqL || eqR));

  const meta = metaFor(spell);
  const glyph = iconEl(meta, ui.editing ? 'pickable' : '');
  if (ui.editing) {
    glyph.title = 'Change icon';
    glyph.addEventListener('click', (e) => { e.stopPropagation(); openIconPicker(spell); });
  }

  const body = h('div', { class: 'body' },
    h('div', { class: 'name' }, nameNodes(spell.name, q)),
    h('div', { class: 'sub' },
      h('span', { class: 'plugin', title: spell.plugin }, spell.plugin || 'unknown'),
      ui.cat === ALL && spell.category ? h('span', null, '· ' + spell.category) : null,
    ),
  );

  const right = h('div', { class: 'row-right', style: 'display:flex;align-items:center;gap:8px;flex-shrink:0;' });

  if (ui.editing) {
    // mode toggle
    right.append(h('div', { class: 'seg mode' },
      h('button', { class: 'cast' + (!isEquip ? ' on cast' : ''), title: slot === 'voice' ? 'Fires it through the voice slot (equip + shout key), engine-real' : '', onClick: (e) => { e.stopPropagation(); setMode(spell, 'cast'); } }, slot === 'voice' ? 'Use' : 'Cast'),
      h('button', { class: 'equip' + (isEquip ? ' on equip' : ''), onClick: (e) => { e.stopPropagation(); setMode(spell, 'equip'); } }, 'Equip'),
    ));
    // hand / voice — only meaningful for equip
    if (isEquip) {
      if (slot === 'voice') {
        right.append(h('span', { class: 'voice-chip', title: 'Power / shout — occupies the voice slot' }, 'Voice'));
      } else {
        right.append(h('div', { class: 'seg hand' },
          h('button', { class: spell.hand === 'left' ? 'on' : '', title: 'Left hand', onClick: (e) => { e.stopPropagation(); setHand(spell, 'left'); } }, 'L'),
          h('button', { class: spell.hand === 'right' ? 'on' : '', title: 'Right hand', onClick: (e) => { e.stopPropagation(); setHand(spell, 'right'); } }, 'R'),
          h('button', { class: spell.hand === 'both' ? 'on' : '', title: 'Both hands', onClick: (e) => { e.stopPropagation(); setHand(spell, 'both'); } }, 'Both'),
        ));
      }
    }
    // category reassign
    const sel = h('select', { class: 'cat-select', title: 'Move to category', onClick: (e) => e.stopPropagation(), onChange: (e) => setCategory(spell, e.target.value) });
    state.categories.forEach((c) => { const o = h('option', { value: c }, c); if (c === spell.category) o.selected = true; sel.append(o); });
    right.append(sel);
    right.append(h('button', { class: 'icon-btn danger', title: 'Remove spell', onClick: (e) => { e.stopPropagation(); removeSpell(spell); } }, '🗑'));

    const row = h('div', {
      class: 'spell edit' + (i === ui.sel ? ' sel' : '') + (equipped ? ' equipped' : ''),
      data: { id: spell.id },
      onMousedown: (e) => pdArm(e, { kind: 'spell-edit', spellId: spell.id }),
    },
      h('span', { class: 'drag-h', title: 'Drag to reorder' }, '⋮⋮'),
      glyph, body, right,
    );
    return row;
  }

  // view mode — badges + live equipped state
  right.append(h('span', { class: 'tag ' + (isEquip ? 'equip' : 'cast') }, isEquip ? 'Equip' : (slot === 'voice' ? 'Use' : 'Cast')));
  if (isEquip) {
    if (slot === 'voice') {
      right.append(h('span', { class: 'tag voice' + (eqV ? '' : ''), style: eqV ? '' : 'opacity:.55' }, eqV ? 'Voice ✓' : 'Voice'));
    } else {
      right.append(h('div', { class: 'hand-state' },
        h('span', { class: 'hand-pip' + (eqL ? ' on' : ''), title: 'Left hand' }, 'L'),
        h('span', { class: 'hand-pip' + (eqR ? ' on' : ''), title: 'Right hand' }, 'R'),
      ));
    }
  } else {
    const d = deliveryOf(spell);
    if (d && d !== 'other') right.append(h('span', { class: 'tag type', title: 'Delivery' }, d === 'self' ? 'self' : d));
  }

  // quick-fire keycap — the digit that fires this row RIGHT NOW. Positional
  // (1..9,0 map to the first ten VISIBLE rows), so it re-numbers live with
  // search/category, exactly like the key handler it mirrors. Click = fire.
  if (i < 10) {
    const digit = i === 9 ? '0' : String(i + 1);
    right.append(h('button', {
      class: 'qkey', title: 'Quick-fire — press ' + digit + ' (or click)',
      onClick: (e) => { e.stopPropagation(); fireEntry(spell.id); },
    }, digit));
  }

  // view-mode rows drag too — not to reorder (that's edit mode) but to COMBO:
  // drop a spell onto another spell (or onto a combo card / "＋ New combo").
  // Pointer-based (see the pointer-drag engine) — Ultralight has no HTML5 DnD.
  return h('div', {
    class: 'spell' + (i === ui.sel ? ' sel' : '') + (equipped ? ' equipped' : ''),
    role: 'option', data: { id: spell.id },
    onClick: () => fireEntry(spell.id),
    onContextmenu: (e) => { e.preventDefault(); openCtxMenu(spell, e.clientX, e.clientY); },
    onMousedown: (e) => pdArm(e, { kind: 'spell-view', spellId: spell.id }),
    onMouseenter: (e) => requestDesc(meta, e.currentTarget),
    onMouseleave: cancelDesc,
  }, glyph, body, right);
}

function renderList() {
  const list = $('list');
  const vis = visibleSpells();
  $('count-chip').textContent = String(vis.length);
  if (ui.sel >= vis.length) ui.sel = vis.length - 1;

  list.textContent = '';

  /* Bulk spellbook cleanup for THIS category — the per-spell "Remove from
     spellbook…" done N times in one armed click. Edit mode only, never on
     All (an armed button that could empty the whole spellbook is a trap,
     not a tool). Spells AND powers go; only shouts are skipped (nothing to
     pull), and race/perk-granted powers get the C++ side's honest refusal.
     Everything removed lands in the restorable Removed list. */
  if (ui.editing && ui.cat !== ALL) {
    const removable = state.spells.filter((s) => s.category === ui.cat && !isShout(s));
    if (removable.length) {
      const armed = ui.armBookCat === ui.cat;
      list.append(h('button', {
        class: 'ctx-item danger list-bulk' + (armed ? ' confirm' : ''),
        title: 'Clears every spell in this category from your spellbook — each restorable from the Removed list',
        onClick: (e) => {
          e.stopPropagation();
          if (!armed) { ui.armBookCat = ui.cat; renderList(); return; }
          ui.armBookCat = null;
          removable.forEach((s) => removeFromSpellbook(s));
          toast('Removing ' + removable.length + ' from the spellbook — restore any time below');
          renderList();
        },
      }, h('span', { class: 'ctx-check' }, '🗑'),
        h('span', { class: 'ctx-lbl' }, armed
          ? 'Delete ' + removable.length + ' from spellbook — click again'
          : 'Remove all ' + removable.length + ' in “' + ui.cat + '” from spellbook…')));
    }
  }
  const empty = $('empty-state');
  if (!vis.length) {
    list.classList.add('hidden');
    showEmpty(empty);
  } else {
    empty.classList.add('hidden');
    list.classList.remove('hidden');
    vis.forEach((s, i) => list.append(spellRow(s, i)));
    if (ui.sel >= 0) {
      const sel = list.children[ui.sel];
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }
}

function showEmpty(el) {
  el.classList.remove('hidden');
  el.textContent = '';
  const searching = !!ui.filter.trim();
  el.append(h('div', { class: 'em-ic' }, searching ? '⌕' : '✦'));
  if (searching) {
    el.append(h('div', { class: 'em-title' }, 'No spells match'));
    el.append(h('div', { class: 'em-sub' }, 'Nothing here matches “' + ui.filter.trim() + '”. Clear the search to see the rest.'));
  } else {
    el.append(h('div', { class: 'em-title' }, ui.cat === ALL ? 'No spells yet' : '“' + ui.cat + '” is empty'));
    el.append(h('div', { class: 'em-sub' }, 'Add spells from your spellbook below. Tag each as Cast (fires on click) or Equip (toggles into a hand or your voice).'));
  }
}

/* ============================================================ combos ==== *
 * Drag one spell onto another (view mode) → they merge into a combo card in
 * the strip above the list. Click the card → C++ casts every member in order
 * as one staggered barrage (mdCastCombo carries the FULL member list so a
 * brand-new combo fires correctly while its save is still debouncing).
 * Members are snapshots (identity + icon meta), not deck-entry references —
 * a combo survives its source entries being deleted or re-categorised.      */

function comboName(c) {
  if (c.name) return c.name;
  const n = c.spells.map((m) => m.name || 'spell');
  if (!n.length) return 'Combo';
  if (n.length === 1) return n[0];
  return n[0] + ' + ' + n[1] + (n.length > 2 ? ' +' + (n.length - 2) : '');
}
function comboTitle(c) {
  return 'Cast all, in order:\n' + c.spells.map((m, i) => (i + 1) + '. ' + (m.name || 'spell')).join('\n');
}
function comboMemberFrom(spell) {
  const m = metaFor(spell);   // live engine meta wins over the saved snapshot
  return {
    plugin: spell.plugin || '', localId: spell.localId >>> 0, formId: spell.formId >>> 0,
    name: spell.name || 'spell', type: m.type || '',
    school: m.school || '', element: m.element || '', archetype: m.archetype || '',
    tier: m.tier || '', icon: spell.icon || '',
  };
}
function newComboId() {
  let n = 1;
  while (state.combos.some((c) => c.id === 'combo-' + n)) n++;
  return 'combo-' + n;
}

function createCombo(targetSpell, draggedSpell) {
  if ((targetSpell.formId >>> 0) === (draggedSpell.formId >>> 0)) { toast('That is already the same spell'); return; }
  const c = { id: newComboId(), name: '', spells: [comboMemberFrom(targetSpell), comboMemberFrom(draggedSpell)] };
  state.combos.push(c);
  saveSoon(); renderCombos();
  toast('Combo created — click to cast both, right-click to edit');
}

function addSpellToCombo(combo, spellId) {
  const spell = state.spells.find((s) => s.id === spellId);
  if (!spell) return;
  if (combo.spells.some((m) => (m.formId >>> 0) === (spell.formId >>> 0))) { toast(spell.name + ' is already in this combo'); return; }
  if (combo.spells.length >= COMBO_MAX) { toast('Combo is full (' + COMBO_MAX + ' spells max)'); return; }
  combo.spells.push(comboMemberFrom(spell));
  saveSoon(); renderCombos();
  toast('Added ' + spell.name + ' → ' + comboName(combo));
}

function castCombo(c) {
  if (ui.editing || !c.spells.length) return;
  const card = $('combo-strip').querySelector('.combo-card[data-cid="' + cssEsc(c.id) + '"]');
  if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 400); }
  toGame('mdCastCombo', JSON.stringify({
    id: c.id,
    name: comboName(c),
    spells: c.spells.map((m) => ({ plugin: m.plugin || '', localId: m.localId >>> 0, formId: m.formId >>> 0 })),
  }));
}

function comboCard(c, i) {
  const glyphs = h('span', { class: 'cc-glyphs' },
    c.spells.slice(0, 4).map((m) => iconEl(m)));
  return h('div', {
    class: 'combo-card', data: { cid: c.id }, title: comboTitle(c),
    role: 'button',
    onClick: () => castCombo(c),
    onContextmenu: (e) => { e.preventDefault(); openComboMenu(c, e.clientX, e.clientY); },
    onMousedown: (e) => pdArm(e, { kind: 'combo', cid: c.id, comboIdx: i }),
  },
    glyphs,
    c.spells.length > 4 ? h('span', { class: 'cc-more' }, '+' + (c.spells.length - 4)) : null,
    h('span', { class: 'cc-name' }, comboName(c)),
    h('span', { class: 'cc-count', title: String(c.spells.length) + ' spells' }, String(c.spells.length)),
  );
}

function renderCombos() {
  const strip = $('combo-strip');
  if (!strip) return;
  strip.textContent = '';
  if (!state.combos.length && !comboDragActive) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  state.combos.forEach((c, i) => strip.append(comboCard(c, i)));
  if (comboDragActive) {
    // pure drop target — the pointer engine hit-tests and drops onto it
    strip.append(h('div', { class: 'combo-new' }, '＋ New combo'));
  }
}

/* horizontal midpoint — the strip flows left→right, unlike the vertical lists */
function dropAfterX(e, el) { const r = el.getBoundingClientRect(); return (e.clientX - r.left) > r.width / 2; }

/* ================================================ pointer drag engine ==== *
 * Ultralight — PrismaUI's web renderer — does NOT implement HTML5 drag &
 * drop: dragstart/dragover/drop never fire in-game (desktop browsers DO fire
 * them, which is exactly how dev-mode testing missed it — clicks worked
 * in-game, every drag silently did nothing). All dragging in this view now
 * runs on raw mouse events instead: mousedown arms a gesture, 6 px of travel
 * makes it a drag, drop candidates are rectangle hit-tested on every
 * mousemove, mouseup drops. The legacy globals (dragKind / dragSpellId /
 * comboDragActive / …) are still set during a drag so every existing guard —
 * hover suppression, the ghost strip, render checks — works unchanged.      */

const PD_THRESHOLD = 6;
const pdrag = { armed: null, active: false, target: null, suppressClick: false };

/* mousedown on a draggable element: remember the gesture, don't start yet */
function pdArm(e, spec) {
  if (e.button !== 0) return;
  if (e.target && e.target.closest && e.target.closest('button, input, select, textarea')) return;
  pdrag.armed = Object.assign({ x0: e.clientX, y0: e.clientY, srcEl: e.currentTarget }, spec);
}

function pdClearTarget() {
  const t = pdrag.target;
  if (t && t.el) t.el.classList.remove('combo-target', 'drop-into', 'drop-before', 'drop-after');
  pdrag.target = null;
}

function pdSetTarget(el, zone, info) {
  const cur = pdrag.target;
  if (cur && cur.el === el && cur.zone === zone) return;
  pdClearTarget();
  const cls = zone === 'combo-target' ? 'combo-target' :
    zone === 'into' ? 'drop-into' : zone === 'after' ? 'drop-after' : 'drop-before';
  el.classList.add(cls);
  pdrag.target = Object.assign({ el, zone }, info);
}

function pdHit(el, e) {
  const r = el.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function pdUpdateTarget(e) {
  const a = pdrag.armed;
  const strip = $('combo-strip');
  if (a.kind === 'spell-view') {
    // combo cards and the "new combo" ghost take priority over spell rows
    const cards = strip ? strip.querySelectorAll('.combo-card') : [];
    for (let i = 0; i < cards.length; i++)
      if (pdHit(cards[i], e)) { pdSetTarget(cards[i], 'into', { drop: 'combo-add', cid: cards[i].dataset.cid }); return; }
    const ghost = strip ? strip.querySelector('.combo-new') : null;
    if (ghost && pdHit(ghost, e)) { pdSetTarget(ghost, 'into', { drop: 'combo-new' }); return; }
    const rows = $('list').querySelectorAll('.spell');
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.id === a.spellId) continue;
      if (pdHit(rows[i], e)) { pdSetTarget(rows[i], 'combo-target', { drop: 'combo-create', id: rows[i].dataset.id }); return; }
    }
    pdClearTarget();
  } else if (a.kind === 'spell-edit') {
    const rows = $('list').querySelectorAll('.spell');
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.id === a.spellId) continue;
      if (pdHit(rows[i], e)) { pdSetTarget(rows[i], dropAfter(e, rows[i]) ? 'after' : 'before', { drop: 'spell-reorder', id: rows[i].dataset.id }); return; }
    }
    pdClearTarget();
  } else if (a.kind === 'cat') {
    const rows = $('rail-list').querySelectorAll('.rail-item.edit');
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.cat === a.cat) continue;
      if (pdHit(rows[i], e)) { pdSetTarget(rows[i], dropAfter(e, rows[i]) ? 'after' : 'before', { drop: 'cat-reorder', cat: rows[i].dataset.cat }); return; }
    }
    pdClearTarget();
  } else if (a.kind === 'combo') {
    const cards = strip ? strip.querySelectorAll('.combo-card') : [];
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].dataset.cid === a.cid) continue;
      if (pdHit(cards[i], e)) { pdSetTarget(cards[i], dropAfterX(e, cards[i]) ? 'after' : 'before', { drop: 'combo-reorder', cid: cards[i].dataset.cid }); return; }
    }
    pdClearTarget();
  }
}

function pdMove(e) {
  const a = pdrag.armed;
  if (!a) return;
  if (!pdrag.active) {
    if (Math.abs(e.clientX - a.x0) + Math.abs(e.clientY - a.y0) < PD_THRESHOLD) return;
    pdrag.active = true;
    dragKind = (a.kind === 'spell-view' || a.kind === 'spell-edit') ? 'spell' : a.kind;
    if (a.kind === 'spell-view') {
      dragSpellId = a.spellId;
      comboDragActive = true;
      cancelDesc();
      renderCombos();               // shows the "＋ New combo" ghost
    } else if (a.kind === 'spell-edit') {
      dragSpellId = a.spellId;
    } else if (a.kind === 'cat') {
      dragCatFrom = a.catIdx;
    } else if (a.kind === 'combo') {
      dragComboFrom = a.comboIdx;
    }
    if (a.srcEl && a.srcEl.isConnected) a.srcEl.classList.add('dragging');
    document.body.classList.add('pdragging');
  }
  pdUpdateTarget(e);
}

function pdFinish() {
  const a = pdrag.armed;
  if (!a) return;
  const wasDrag = pdrag.active;
  const t = pdrag.target;
  pdClearTarget();
  if (a.srcEl && a.srcEl.classList) a.srcEl.classList.remove('dragging');
  document.body.classList.remove('pdragging');
  pdrag.armed = null;
  pdrag.active = false;

  const sid = dragSpellId, cFrom = dragCatFrom, cbFrom = dragComboFrom;
  const ghostWasUp = comboDragActive;
  dragKind = null; dragSpellId = null; dragCatFrom = -1; dragComboFrom = -1;
  comboDragActive = false;

  if (!wasDrag) return;               // never crossed the threshold — plain click
  pdrag.suppressClick = true;         // swallow the click this mouseup synthesizes
  setTimeout(() => { pdrag.suppressClick = false; }, 0);
  if (ghostWasUp) renderCombos();     // drop the ghost

  if (!t) { renderList(); return; }   // released over nothing
  if (t.drop === 'combo-create') {
    const target = state.spells.find((s) => s.id === t.id);
    const dragged = state.spells.find((s) => s.id === sid);
    if (target && dragged && target !== dragged) createCombo(target, dragged);
    else renderList();
  } else if (t.drop === 'combo-add') {
    const combo = state.combos.find((c) => c.id === t.cid);
    if (combo) addSpellToCombo(combo, sid);
  } else if (t.drop === 'combo-new') {
    const spell = state.spells.find((s) => s.id === sid);
    if (spell) {
      const c = { id: newComboId(), name: '', spells: [comboMemberFrom(spell)] };
      state.combos.push(c);
      saveSoon(); renderCombos();
      toast('Combo started — drag more spells onto it');
    }
  } else if (t.drop === 'spell-reorder') {
    reorderSpell(sid, t.id, t.zone === 'after');
  } else if (t.drop === 'cat-reorder') {
    const toIdx = state.categories.indexOf(t.cat);
    if (toIdx >= 0) { moveInArray(state.categories, cFrom, t.zone === 'after' ? toIdx + 1 : toIdx); saveSoon(); render(); }
  } else if (t.drop === 'combo-reorder') {
    const toIdx = state.combos.findIndex((c) => c.id === t.cid);
    if (toIdx >= 0) { moveInArray(state.combos, cbFrom, t.zone === 'after' ? toIdx + 1 : toIdx); saveSoon(); renderCombos(); }
  }
}

/* right-click a combo card — rename, reorder / drop members, delete */
function openComboMenu(c, x, y) {
  closeCtx();
  cancelDesc();
  const rerender = () => { closeCtx(); openComboMenu(c, x, y); };   // rebuild in place

  const items = [];
  items.push(h('div', { class: 'ctx-head combo' },
    h('input', {
      class: 'ctx-rename', type: 'text', value: c.name || '', spellcheck: 'false',
      placeholder: comboName(c),
      title: 'Combo name — blank auto-names from its spells',
      onClick: (e) => e.stopPropagation(),
      onChange: (e) => { c.name = e.target.value.trim(); saveSoon(); renderCombos(); },
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    })));
  items.push(h('button', {
    class: 'ctx-item',
    onClick: (e) => { e.stopPropagation(); closeCtx(); castCombo(c); },
  }, h('span', { class: 'ctx-check' }, '⚡'), h('span', { class: 'ctx-lbl' }, 'Cast all (' + c.spells.length + ')')));
  items.push(h('div', { class: 'ctx-sep' }));

  c.spells.forEach((m, i) => {
    items.push(h('div', { class: 'ctx-member' },
      h('span', { class: 'cm-ord' }, String(i + 1)),
      iconEl(m),
      h('span', { class: 'cm-name', title: m.name }, m.name || 'spell'),
      h('button', {
        class: 'cm-btn', title: 'Cast earlier', disabled: i === 0 ? true : null,
        onClick: (e) => { e.stopPropagation(); if (!i) return; moveInArray(c.spells, i, i - 1); saveSoon(); renderCombos(); rerender(); },
      }, '↑'),
      h('button', {
        class: 'cm-btn danger', title: 'Remove from combo',
        onClick: (e) => {
          e.stopPropagation();
          c.spells.splice(i, 1);
          if (!c.spells.length) {
            state.combos = state.combos.filter((x) => x !== c);
            saveSoon(); renderCombos(); closeCtx();
            toast('Combo removed — no spells left');
            return;
          }
          saveSoon(); renderCombos(); rerender();
        },
      }, '✕'),
    ));
  });
  items.push(h('div', { class: 'ctx-hint' }, 'Drag spells from the list onto the card to add more.'));
  items.push(h('div', { class: 'ctx-sep' }));

  let armed = false;
  const delLbl = h('span', { class: 'ctx-lbl' }, 'Delete combo');
  const delBtn = h('button', {
    class: 'ctx-item danger',
    title: 'The spells themselves are untouched',
    onClick: (e) => {
      e.stopPropagation();
      if (!armed) { armed = true; delBtn.classList.add('confirm'); delLbl.textContent = 'Delete combo — click again'; return; }
      state.combos = state.combos.filter((x) => x !== c);
      saveSoon(); renderCombos(); closeCtx();
      toast('Deleted ' + comboName(c));
    },
  }, h('span', { class: 'ctx-check' }, '🗑'), delLbl);
  items.push(delBtn);

  ctxEl = h('div', { id: 'ctx-menu', role: 'menu' }, items);
  $('overlay').append(ctxEl);
  clampCtx(x, y);
  setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
}

/* =========================================================== actions ==== */

function fireEntry(id) {
  if (ui.editing) return;
  cancelDesc();
  const spell = state.spells.find((s) => s.id === id);
  if (!spell) return;
  const row = $('list').querySelector('.spell[data-id="' + cssEsc(id) + '"]');
  if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 400); }
  toGame('mdFire', id);
}
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

function setMode(spell, mode) { if (spell.mode === mode) return; spell.mode = mode; saveSoon(); renderList(); }
function setHand(spell, hand) { if (spell.hand === hand) return; spell.hand = hand; saveSoon(); renderList(); }
function setCategory(spell, cat) {
  if (!state.categories.includes(cat) || spell.category === cat) return;
  spell.category = cat; saveSoon(); render();
}
function removeSpell(spell) {
  const i = state.spells.indexOf(spell);
  if (i < 0) return;
  state.spells.splice(i, 1);
  saveSoon(); render();
  toast('Removed ' + spell.name);
}

/* ---- remove-from-spellbook (engine RemoveSpell) + restore (AddSpell) ---- */
/* We don't touch state optimistically: the engine confirms via mdRemoved/mdRestored
 * (below), which owns the state mutation. That way a rejected removal (a power, a
 * race-granted spell) leaves the deck untouched. */
function removeFromSpellbook(spell) {
  toGame('mdRemoveSpell', JSON.stringify({
    plugin: spell.plugin || '', localId: (spell.localId >>> 0), formId: (spell.formId >>> 0),
  }));
}
function restoreSpell(r) {
  toGame('mdRestoreSpell', JSON.stringify({
    plugin: r.plugin || '', localId: (r.localId >>> 0), formId: (r.formId >>> 0),
  }));
}

/* Collapsible "Removed from spellbook" list at the bottom of #main. Hidden when
 * empty; opens automatically the moment a spell is removed so the user sees where
 * it went and the one-click Restore. Body scrolls internally so it stays tidy at
 * scale. */
function renderRemoved() {
  const sec = $('removed-section');
  if (!sec) return;
  sec.textContent = '';
  const n = state.removed.length;
  if (!n) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');

  const open = ui.removedOpen;
  sec.append(h('button', {
    class: 'removed-head' + (open ? ' open' : ''),
    title: open ? 'Hide removed spells' : 'Show removed spells',
    onClick: () => { ui.removedOpen = !ui.removedOpen; renderRemoved(); },
  },
    h('span', { class: 'rh-caret' }, open ? '▾' : '▸'),
    h('span', { class: 'rh-title' }, 'Removed from spellbook'),
    h('span', { class: 'rh-count' }, String(n)),
  ));
  if (!open) return;

  const body = h('div', { class: 'removed-body' });
  body.append(h('div', { class: 'removed-note' },
    'Cleared from your spellbook — the spell itself is never lost. Restore adds it straight back.'));
  state.removed.forEach((r) => {
    body.append(h('div', { class: 'removed-row' },
      iconEl(r),
      h('div', { class: 'body' },
        h('div', { class: 'name', title: r.name }, r.name || 'spell'),
        h('div', { class: 'sub' }, h('span', { class: 'plugin', title: r.plugin }, r.plugin || 'unknown')),
      ),
      h('button', { class: 'restore-btn', title: 'Add it back to your spellbook', onClick: () => restoreSpell(r) }, '↩ Restore'),
    ));
  });
  sec.append(body);
}

/* set mode (and hand) in one shot — used by the right-click menu */
function setModeHand(spell, mode, hand) {
  let changed = false;
  if (spell.mode !== mode) { spell.mode = mode; changed = true; }
  if (hand && spell.hand !== hand) { spell.hand = hand; changed = true; }
  if (!changed) return;
  saveSoon(); renderList();
  toast((mode === 'equip' ? 'Equip' : 'Cast') + ' · ' + spell.name);
}

/* ---- right-click context menu (view mode) ---- */
let ctxEl = null;
function ctxOutside(e) { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }
function closeCtx() {
  if (!ctxEl) return;
  ctxEl.remove(); ctxEl = null;
  document.removeEventListener('mousedown', ctxOutside, true);
}
/* clamp the open menu inside the viewport (overlay is fixed inset:0,
 * untransformed -> left/top == clientX/Y even with #panel scale).
 * offsetWidth/Height, NOT getBoundingClientRect: the ctxIn keyframe starts at
 * scale(.98), so a rect measured on the opening frame under-reports the box
 * and a tall menu (a combo with several members) got placed hanging off the
 * bottom edge. A second pass on the next tick catches anything that settles
 * after the first layout (late font metrics, the animation). */
function clampCtx(x, y) {
  const place = () => {
    if (!ctxEl) return;
    const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let nx = x, ny = y;
    if (nx + w > vw - 6) nx = vw - w - 6;
    if (ny + h > vh - 6) ny = vh - h - 6;
    ctxEl.style.left = Math.max(6, nx) + 'px';
    ctxEl.style.top = Math.max(6, ny) + 'px';
  };
  place();
  setTimeout(place, 0);
}
function openCtxMenu(spell, x, y) {
  if (ui.editing) return;               // edit mode already has inline controls
  closeCtx();
  cancelDesc();
  const slot = slotOf(spell);
  const isEquip = spell.mode === 'equip';
  const item = (label, active, danger, on) => h('button', {
    class: 'ctx-item' + (active ? ' active' : '') + (danger ? ' danger' : ''),
    onClick: (e) => { e.stopPropagation(); closeCtx(); on(); },
  }, h('span', { class: 'ctx-check' }, active ? '✓' : ''), h('span', { class: 'ctx-lbl' }, label));

  const items = [h('div', { class: 'ctx-head', title: spell.name }, spell.name || 'Spell')];
  items.push(item('Cast on click', !isEquip, false, () => setModeHand(spell, 'cast', null)));
  if (slot === 'voice') {
    items.push(item('Equip · Voice slot', isEquip, false, () => setModeHand(spell, 'equip', null)));
  } else {
    items.push(item('Equip · Left hand',  isEquip && spell.hand === 'left',  false, () => setModeHand(spell, 'equip', 'left')));
    items.push(item('Equip · Right hand', isEquip && spell.hand === 'right', false, () => setModeHand(spell, 'equip', 'right')));
    items.push(item('Equip · Both hands', isEquip && spell.hand === 'both',  false, () => setModeHand(spell, 'equip', 'both')));
  }
  items.push(h('div', { class: 'ctx-sep' }));
  items.push(item('Change icon…', false, false, () => openIconPicker(spell)));
  items.push(h('div', { class: 'ctx-sep' }));
  items.push(item('Remove from deck', false, true, () => removeSpell(spell)));

  // Clear it from the spellbook entirely (engine RemoveSpell) — spells and powers
  // alike; only shouts are excluded (no spellbook entry to pull). Two-click armed so
  // a stray click can't wipe a spell; it lands in the restorable Removed list below.
  if (!isShout(spell)) {
    let armed = false;
    const rmLbl = h('span', { class: 'ctx-lbl' }, 'Remove from spellbook…');
    const rmBtn = h('button', {
      class: 'ctx-item danger',
      title: 'Clears it from your spellbook — restorable any time from the Removed list',
      onClick: (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; rmBtn.classList.add('confirm'); rmLbl.textContent = 'Delete from spellbook — click again'; return; }
        closeCtx();
        removeFromSpellbook(spell);
      },
    }, h('span', { class: 'ctx-check' }, '🗑'), rmLbl);
    items.push(rmBtn);
  }

  ctxEl = h('div', { id: 'ctx-menu', role: 'menu' }, items);
  $('overlay').append(ctxEl);
  clampCtx(x, y);
  // arm the outside-click dismiss on the *next* tick so this very event doesn't close it
  setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
}

function addCategory() {
  const name = uniqueCat('New Category', -1);
  state.categories.push(name);
  ui.cat = name; ui.sel = -1;
  saveSoon(); render();
  const inp = $('rail-list').querySelector('.rail-item[data-cat="' + cssEsc(name) + '"] .rail-rename');
  if (inp) { inp.focus(); inp.select(); }
}
function renameCategory(idx, raw) {
  const old = state.categories[idx];
  if (old === undefined) return;
  const name = uniqueCat(raw, idx);
  if (name === old) { renderRail(); return; }
  state.categories[idx] = name;
  state.spells.forEach((s) => { if (s.category === old) s.category = name; });
  if (state.catIcons[old]) {         // the glyph follows the rename — keys are names
    state.catIcons[name] = state.catIcons[old];
    delete state.catIcons[old];
  }
  if (ui.cat === old) ui.cat = name;
  if (ui.armDelCat === old) ui.armDelCat = null;
  saveSoon(); render();
}
function deleteCategory(cat) {
  if (ui.armDelCat !== cat) { ui.armDelCat = cat; renderRail(); return; }
  ui.armDelCat = null;
  const idx = state.categories.indexOf(cat);
  if (idx < 0) return;
  const removed = countIn(cat);
  state.categories.splice(idx, 1);
  state.spells = state.spells.filter((s) => s.category !== cat);
  delete state.catIcons[cat];
  if (ui.cat === cat) ui.cat = state.categories[0] || ALL;
  saveSoon(); render();
  toast('Removed “' + cat + '”' + (removed ? ' + ' + removed + ' spell' + (removed > 1 ? 's' : '') : ''));
}

/* vertical midpoint for before/after reorder drops */
function dropAfter(e, el) { const r = el.getBoundingClientRect(); return (e.clientY - r.top) > r.height / 2; }
function moveInArray(arr, from, to) {
  if (from < 0 || from >= arr.length) return;
  const [m] = arr.splice(from, 1);
  if (to > from) to--;
  to = Math.max(0, Math.min(arr.length, to));
  arr.splice(to, 0, m);
}
function reorderSpell(dragId, targetId, after) {
  if (dragId === targetId) return;
  const a = state.spells;
  const fi = a.findIndex((s) => s.id === dragId);
  if (fi < 0) return;
  const [m] = a.splice(fi, 1);
  let ti = a.findIndex((s) => s.id === targetId);
  if (ti < 0) { a.splice(fi, 0, m); return; }
  if (after) ti++;
  a.splice(ti, 0, m);
  saveSoon(); renderList();
}

/* ===================================================== add-spell modal == */

function openAdd() {
  closeCtx();
  ui.addCat = ui.cat === ALL ? (state.categories[0] || null) : ui.cat;
  if (!ui.addCat) { toast('Add a category first'); return; }
  ui.addOpen = true;
  ui.addFilter = '';
  $('add-cat-name').textContent = ui.addCat;
  $('add-search').value = '';
  $('add-modal').classList.remove('hidden');
  renderAddList();
  // (re)request known spells; enrichment on open usually populated this already
  if (!ui.known.length) { ui.knownLoading = true; toGame('mdKnown'); renderAddList(); }
  setTimeout(() => $('add-search').focus(), 30);
}
function closeAdd() {
  ui.addOpen = false;
  $('add-modal').classList.add('hidden');
  render();
}

function renderAddList() {
  const box = $('add-list');
  const empty = $('add-empty');
  box.textContent = '';
  if (ui.knownLoading) {
    empty.classList.add('hidden');
    for (let i = 0; i < 6; i++) box.append(h('div', { class: 'skel' }));
    return;
  }
  const q = ui.addFilter.trim().toLowerCase();
  const rows = ui.known.filter((k) => !q || String(k.name || '').toLowerCase().includes(q));
  if (!rows.length) {
    empty.classList.remove('hidden');
    empty.textContent = '';
    empty.append(h('div', { class: 'em-ic' }, '✦'));
    empty.append(h('div', { class: 'em-sub' },
      ui.known.length ? 'No known spell matches “' + ui.addFilter.trim() + '”.'
        : 'No castable spells found in your spellbook.'));
    return;
  }
  empty.classList.add('hidden');
  rows.forEach((k) => box.append(knownRow(k)));
}

function knownRow(k) {
  const inCat = state.spells.some((s) => hexId(s.formId) === hexId(k.formId) && s.category === ui.addCat);
  const sub = [k.plugin || 'unknown'];
  if (k.type === 'shout') sub.push('shout');
  else if (k.slot === 'voice') sub.push('voice'); else if (k.type && k.type !== 'spell') sub.push(k.type);
  else if (k.delivery && k.delivery !== 'other') sub.push(k.delivery);

  const adds = inCat
    ? [h('span', { class: 'done-mark', title: 'Already in ' + ui.addCat }, '✓ Added')]
    : [
      h('button', { class: 'add-btn2 cast', title: k.slot === 'voice' ? 'Add as Use (fires via the voice slot + shout key)' : 'Add as Cast (fires on click)', onClick: () => addKnown(k, 'cast') }, k.slot === 'voice' ? 'Use' : 'Cast'),
      h('button', { class: 'add-btn2 equip', title: 'Add as Equip (toggles in / out)', onClick: () => addKnown(k, 'equip') }, 'Equip'),
    ];

  return h('div', {
    class: 'known' + (inCat ? ' added' : ''),
    onMouseenter: (e) => requestDesc(k, e.currentTarget),
    onMouseleave: cancelDesc,
  },
    iconEl(k),
    h('div', { class: 'body' },
      h('div', { class: 'name' }, nameNodes(k.name, ui.addFilter.trim())),
      h('div', { class: 'sub' }, sub.map((t) => h('span', null, t))),
    ),
    h('div', { class: 'adds' }, adds),
  );
}

function addKnown(k, mode) {
  const entry = {
    id: newSpellId(k.formId),
    plugin: k.plugin || '',
    localId: k.localId >>> 0,
    formId: k.formId >>> 0,
    name: k.name || 'spell',
    mode: mode === 'equip' ? 'equip' : 'cast',
    hand: 'right',
    category: ui.addCat,
    slot: k.slot || 'hand',
    school: k.school || '', element: k.element || '', archetype: k.archetype || '',
    tier: k.tier || '', icon: '',
  };
  state.spells.push(entry);
  saveSoon();
  renderAddList();   // flip the row to "Added"
  renderRail();      // bump the category count
  toast('Added ' + entry.name + ' → ' + ui.addCat);
}

/* ====================================================== icon picker ====== *
 * Per-spell icon override. Sections: Auto (follow the resolve chain), the
 * live icons/custom folder (Refresh re-scans it mid-game), and the whole
 * Spell Hotbar library. The library renders in ICON_PAGE chunks appended on
 * scroll, so opening the picker never decodes ~1,900 images at once.        */

const iconPicker = { open: false, spellId: null, cat: null, filter: '', shown: 0 };
const ICON_PAGE = 96;

function pickerSpell() { return state.spells.find((s) => s.id === iconPicker.spellId) || null; }

function openIconPicker(spell) {
  closeCtx();
  cancelDesc();
  iconPicker.open = true;
  iconPicker.spellId = spell.id;
  iconPicker.cat = null;
  iconPicker.filter = '';
  iconPicker.shown = ICON_PAGE;
  $('icon-spell-name').textContent = spell.name || 'spell';
  $('icon-search').value = '';
  $('icon-modal').classList.remove('hidden');
  renderIconPicker();
  setTimeout(() => { const s = $('icon-search'); if (s) s.focus(); }, 30);
}
/* Same modal, different target: the picked file lands on a rail CATEGORY
 * instead of a spell. cat set = category mode everywhere downstream. */
function openCatIconPicker(cat) {
  closeCtx();
  cancelDesc();
  iconPicker.open = true;
  iconPicker.spellId = null;
  iconPicker.cat = cat;
  iconPicker.filter = '';
  iconPicker.shown = ICON_PAGE;
  $('icon-spell-name').textContent = cat + ' (category)';
  $('icon-search').value = '';
  $('icon-modal').classList.remove('hidden');
  renderIconPicker();
  setTimeout(() => { const s = $('icon-search'); if (s) s.focus(); }, 30);
}
function closeIconPicker() {
  iconPicker.open = false;
  iconPicker.cat = null;
  $('icon-modal').classList.add('hidden');
}
function pickIcon(file) {
  if (iconPicker.cat != null) {
    const cat = iconPicker.cat;
    closeIconPicker();
    if (!state.categories.includes(cat)) return;   // renamed/deleted under the modal
    if (file) state.catIcons[cat] = file;
    else delete state.catIcons[cat];
    saveSoon();
    render();
    toast(file ? 'Icon set for ' + cat : cat + ' icon cleared');
    return;
  }
  const s = pickerSpell();
  closeIconPicker();
  if (!s) return;
  s.icon = file || '';
  saveSoon();
  render();
  toast(file ? 'Icon set for ' + s.name : s.name + ' back to automatic icon');
}

function iconMatches(q) {
  return (c) => !q || (c.label || '').toLowerCase().indexOf(q) >= 0 ||
    (c.atlas || '').toLowerCase().indexOf(q) >= 0 || (c.key || '').toLowerCase().indexOf(q) >= 0;
}

function iconTile(entry, opts) {
  opts = opts || {};
  const wrap = h('span', { class: 'tile-img' });
  if (opts.auto) {
    const m = Object.assign({}, opts.meta || {}, { icon: '' });
    const auto = resolveIconPath(m);
    if (auto) wrap.append(h('img', { src: auto, draggable: 'false' }));
    else wrap.append(glyphEl(iconKeyFor(m)));
  } else {
    wrap.append(h('img', { src: entry.file, draggable: 'false' }));
  }
  return h('button', {
    class: 'icon-tile' + (opts.sel ? ' sel' : '') + (opts.auto ? ' auto' : ''),
    title: opts.auto ? 'Follow the automatic icon (exact match → school generic → glyph)'
      : (entry.label || entry.file) + (entry.atlas ? '  ·  ' + entry.atlas : ''),
    onClick: () => pickIcon(opts.auto ? '' : entry.file),
  }, wrap, h('span', { class: 'tile-lbl' }, opts.auto ? 'Auto' : (entry.label || entry.file)));
}

function renderIconPicker() {
  const grid = $('icon-grid');
  const catMode = iconPicker.cat != null;
  const s = pickerSpell();
  if (!grid || (!s && !catMode)) return;
  grid.textContent = '';
  const q = iconPicker.filter.trim().toLowerCase();
  const cur = catMode ? normPath(state.catIcons[iconPicker.cat] || '') : normPath(s.icon || '');

  if (!q && catMode) {
    // No "Automatic" for a category — the equivalents are a glyph or nothing.
    grid.append(h('div', { class: 'icon-sect' }, 'None'));
    grid.append(h('button', {
      class: 'icon-tile' + (cur ? '' : ' sel') + ' auto',
      title: 'No category icon',
      onClick: () => pickIcon(''),
    }, h('span', { class: 'tile-img' }), h('span', { class: 'tile-lbl' }, 'None')));
  } else if (!q) {
    grid.append(h('div', { class: 'icon-sect' }, 'Automatic'));
    grid.append(iconTile(null, { auto: true, sel: !cur, meta: metaFor(s) }));
  }
  const custom = ICONS.custom.filter(iconMatches(q));
  if (custom.length) {
    grid.append(h('div', { class: 'icon-sect' }, 'Your icons (icons/custom)'));
    custom.forEach((c) => grid.append(iconTile(c, { sel: cur === c.file })));
  }
  const lib = ICONS.catalog.filter(iconMatches(q));
  grid.append(h('div', { class: 'icon-sect' }, 'Spell Hotbar library'));
  if (!lib.length) {
    grid.append(h('div', { class: 'icon-more' }, ICONS.catalog.length
      ? 'No icon matches “' + iconPicker.filter.trim() + '”'
      : 'Icon library not installed — using built-in glyphs'));
  } else {
    lib.slice(0, iconPicker.shown).forEach((c) => grid.append(iconTile(c, { sel: cur === c.file })));
    if (lib.length > iconPicker.shown)
      grid.append(h('div', { class: 'icon-more' }, 'Showing ' + iconPicker.shown + ' of ' + lib.length + ' — scroll for more'));
  }
  $('icon-count').textContent =
    (ICONS.catalog.length ? lib.length + ' library' : 'no library') +
    (ICONS.custom.length ? ' · ' + ICONS.custom.length + ' custom' : '');
  grid.scrollTop = 0;
}

/* scroll-append the next chunk (no rebuild — keeps scroll position) */
function appendMoreIcons() {
  const grid = $('icon-grid');
  const catMode = iconPicker.cat != null;
  const s = pickerSpell();
  if (!grid || (!s && !catMode)) return;
  const q = iconPicker.filter.trim().toLowerCase();
  const lib = ICONS.catalog.filter(iconMatches(q));
  if (iconPicker.shown >= lib.length) return;
  const more = grid.querySelector('.icon-more');
  if (more) more.remove();
  const cur = catMode ? normPath(state.catIcons[iconPicker.cat] || '') : normPath(s.icon || '');
  const next = lib.slice(iconPicker.shown, iconPicker.shown + ICON_PAGE);
  iconPicker.shown += next.length;
  next.forEach((c) => grid.append(iconTile(c, { sel: cur === c.file })));
  if (lib.length > iconPicker.shown)
    grid.append(h('div', { class: 'icon-more' }, 'Showing ' + iconPicker.shown + ' of ' + lib.length + ' — scroll for more'));
}

/* ================================================= hover description ===== *
 * Hovering a spell row (or an add-picker row) ~0.4s asks C++ for the spell's
 * auto-generated description (mdGetDesc → mdDesc), cached per formId. The
 * tooltip is display-only and clamped to the viewport like #ctx-menu.       */

const desc = { cache: new Map(), timer: null, key: '', meta: null, anchor: null };

function hideDescTip() {
  const t = $('desc-tip');
  if (t) { t.classList.add('hidden'); t.textContent = ''; }
}
function cancelDesc() {
  if (desc.timer) { clearTimeout(desc.timer); desc.timer = null; }
  desc.key = '';
  desc.anchor = null;
  hideDescTip();
}
function requestDesc(m, anchor) {
  if (ui.editing || dragKind || ctxEl || ui.capture || iconPicker.open) return;
  if (!m || !m.formId) return;
  const key = hexId(m.formId);
  if (desc.anchor === anchor && desc.key === key) return;   // already pending / shown
  if (desc.timer) clearTimeout(desc.timer);
  desc.key = key;
  desc.meta = m;
  desc.anchor = anchor;
  desc.timer = setTimeout(() => {
    desc.timer = null;
    const hit = desc.cache.get(key);
    if (hit) { showDescTip(hit); return; }
    showDescTip(null);   // loading state; mdDesc fills it in
    toGame('mdGetDesc', JSON.stringify({
      plugin: m.plugin || '', localId: (m.localId >>> 0) || 0, formId: (m.formId >>> 0) || 0,
    }));
  }, 380);
}
function showDescTip(data) {
  const tip = $('desc-tip'), a = desc.anchor;
  if (!tip || !a || !a.isConnected) return;
  tip.textContent = '';
  const m = desc.meta || {};
  tip.append(h('div', { class: 'dt-name' }, m.name || (data && data.name) || 'Spell'));
  const bits = [];
  if (m.school) bits.push(m.school);
  if (m.tier) bits.push(m.tier);
  if (m.type && m.type !== 'spell') bits.push(m.type);
  if (bits.length) tip.append(h('div', { class: 'dt-meta' }, bits.join(' · ')));
  if (!data) tip.append(h('div', { class: 'dt-loading' }, h('span', { class: 'spinner' }), 'Reading description…'));
  else if (data.text) tip.append(h('div', { class: 'dt-text' }, data.text));
  else tip.append(h('div', { class: 'dt-text empty' }, 'No description.'));
  tip.classList.remove('hidden');
  placeDescTip(a);
}
/* Park the tip DIRECTLY UNDER the hovered row, left edges aligned, flipping
 * above when the bottom edge is in the way — never over the row it describes
 * (the old "to the right, vertically centred" pass fell through to its last
 * resort and covered the row, because a near-full-width panel leaves no room
 * on either side).
 *
 * TWO COORDINATE SPACES MEET HERE, and mixing them is what put the tip in the
 * wrong place at 130% scale: the anchor rect is post-transform SCREEN px,
 * while offsetWidth/Height are the tip's own PRE-scale layout px (#desc-tip
 * carries transform: scale(--ui-scale) so it matches the panel's type size).
 * Multiply before comparing. offsetWidth rather than getBoundingClientRect
 * for the same reason clampCtx does: the open animation starts translated, so
 * a rect read on the opening frame reports a shifted box.                   */
function placeDescTip(a) {
  const tip = $('desc-tip');
  if (!tip || !a || !a.isConnected) return;
  const r = a.getBoundingClientRect();
  const s = curScale();
  const tw = tip.offsetWidth * s, th = tip.offsetHeight * s;
  const vw = window.innerWidth, vh = window.innerHeight, gap = 8;
  let x = r.left;
  if (x + tw > vw - gap) x = vw - tw - gap;
  x = Math.max(gap, x);
  let y = r.bottom + gap;                                  // under the row
  if (y + th > vh - gap) {                                 // no room below…
    const above = r.top - th - gap;
    y = above >= gap ? above                               // …flip above it
      : Math.max(gap, vh - th - gap);                      // …neither fits: clamp
  }
  tip.style.left = Math.round(x) + 'px';
  tip.style.top = Math.round(y) + 'px';
}
window.mdDesc = function (r) {
  r = coerce(r);
  if (!r) return;
  const key = hexId((r.formId >>> 0) || 0);
  const data = { name: r.name || '', text: r.text || '', ok: !!r.ok };
  desc.cache.set(key, data);
  if (desc.key === key && desc.anchor) showDescTip(data);
};

/* ===================================================== open-key capture == */

function startCapture(kind) {
  ui.capture = kind === 'add' ? 'add' : 'open';
  $('capture-title').textContent = ui.capture === 'add'
    ? 'Press the new capture key…' : 'Press the new open key…';
  $('capture-modal').classList.remove('hidden');
  $(ui.capture === 'add' ? 'addkey-btn' : 'openkey-btn').classList.add('capturing');
  toGame('mdCapture', '1');
}
function endCapture() {
  ui.capture = null;
  $('capture-modal').classList.add('hidden');
  $('openkey-btn').classList.remove('capturing');
  const ab = $('addkey-btn');
  if (ab) ab.classList.remove('capturing');
  toGame('mdCapture', '0');
}
function applyCapture(device, code, label) {
  if (ui.capture === 'add') {
    state.addKey = { device, code: code >>> 0, label };
    $('addkey-btn').textContent = label;
    endCapture();
    save();
    toast('Capture key set to ' + label);
    return;
  }
  state.openKey = { device, code: code >>> 0, label };
  $('openkey-btn').textContent = label;
  endCapture();
  save();
  toast('Open key set to ' + label);
}

/* ============================================================ input ===== */

function isTextTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}

function onKeyDown(e) {
  // an open right-click menu is dismissed by the first keypress; Esc just closes
  // it (and is swallowed so it doesn't also clear search / close the view)
  if (ctxEl) {
    closeCtx();
    if (e.key === 'Escape') { e.preventDefault(); return; }
  }

  // capture takes precedence over everything
  if (ui.capture) {
    e.preventDefault();
    if (e.key === 'Escape') { endCapture(); return; }
    if (MODIFIER_CODES.includes(e.code) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const code = codeFromEvent(e);
    if (code && DIK[code]) applyCapture('keyboard', DIK[code][0], DIK[code][1]);
    return;
  }

  // icon picker is modal like the add dialog
  if (iconPicker.open) {
    if (e.key === 'Escape') { e.preventDefault(); closeIconPicker(); }
    return;
  }

  // add-spell modal is its own little world
  if (ui.addOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
    return;
  }

  // rail rename / category select — let text editing happen, only Escape leaves
  const t = e.target;
  if (isTextTarget(t) && t.id !== 'search') {
    if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    if (ui.filter) { ui.filter = ''; $('search').value = ''; ui.sel = -1; renderList(); }
    else toGame('mdClose');
    return;
  }

  const vis = visibleSpells();
  if (e.key === 'ArrowDown') { e.preventDefault(); ui.sel = Math.min(vis.length - 1, ui.sel + 1); renderList(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); ui.sel = Math.max(0, (ui.sel < 0 ? 0 : ui.sel - 1)); renderList(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    const pick = ui.sel >= 0 ? vis[ui.sel] : vis[0];
    if (pick) fireEntry(pick.id);
    return;
  }
  // quick-fire digits: 1..9 -> 0..8, 0 -> 10th. Intercept even inside search
  // (spell names practically never need a typed digit to be found).
  if (/^[0-9]$/.test(e.key)) {
    const idx = e.key === '0' ? 9 : (parseInt(e.key, 10) - 1);
    if (vis[idx]) { e.preventDefault(); fireEntry(vis[idx].id); }
    return;
  }
  if (e.key === 'F2') { e.preventDefault(); toggleEdit(); return; }
}

function onMouseDown(e) {
  // middle-click reaches the webview natively; use it to bind the open key
  if (ui.capture && e.button === 1) {
    e.preventDefault();
    applyCapture('mouse', MOUSE[1][0], MOUSE[1][1]);
    return;
  }
  // right-click a spell -> context menu. `contextmenu` is the primary path
  // (see spellRow); this is the fallback for renderers that deliver mousedown
  // but not a synthesized contextmenu event.
  if (e.button === 2 && !ui.editing && !ui.capture && !ui.addOpen) {
    const row = e.target && e.target.closest ? e.target.closest('.spell') : null;
    const id = row && row.dataset ? row.dataset.id : '';
    const spell = id ? state.spells.find((s) => s.id === id) : null;
    if (spell) { e.preventDefault(); openCtxMenu(spell, e.clientX, e.clientY); }
  }
}

function toggleEdit() {
  closeCtx();
  ui.editing = !ui.editing;
  ui.armDelCat = null;
  if (!ui.editing && ui.addOpen) closeAdd();
  render();
}

/* ============================================================ wiring ==== */

function wire() {
  $('close-btn').addEventListener('click', () => toGame('mdClose'));
  $('edit-btn').addEventListener('click', toggleEdit);
  $('add-spell-btn').addEventListener('click', openAdd);
  $('add-cat-btn').addEventListener('click', addCategory);
  $('add-close').addEventListener('click', closeAdd);
  $('capture-cancel').addEventListener('click', endCapture);
  $('openkey-btn').addEventListener('click', () => startCapture('open'));
  $('addkey-btn').addEventListener('click', () => startCapture('add'));
  $('remove-on-add').addEventListener('change', (e) => { state.removeOnAdd = !!e.target.checked; saveSoon(); });

  $('icon-close').addEventListener('click', closeIconPicker);
  $('icon-refresh').addEventListener('click', () => { toGame('mdIconList'); toast('Re-scanning custom icons…'); });
  $('icon-search').addEventListener('input', (e) => { iconPicker.filter = e.target.value; iconPicker.shown = ICON_PAGE; renderIconPicker(); });
  $('icon-grid').addEventListener('scroll', (e) => {
    const g = e.target;
    if (g.scrollTop + g.clientHeight > g.scrollHeight - 120) appendMoreIcons();
  });
  $('icon-modal').addEventListener('mousedown', (e) => { if (e.button === 0 && e.target === $('icon-modal')) closeIconPicker(); });

  $('scale-down').addEventListener('click', () => setScale(state.uiScale - SSTEP));
  $('scale-up').addEventListener('click', () => setScale(state.uiScale + SSTEP));
  $('scale-reset').addEventListener('click', () => setScale(1.0));
  $('icon-size-down').addEventListener('click', () => setIconPx(curIconPx() - ISTEP));
  $('icon-size-up').addEventListener('click', () => setIconPx(curIconPx() + ISTEP));
  $('icon-size-reset').addEventListener('click', resetIconPx);

  $('resize-grip').addEventListener('mousedown', gripDown);
  $('resize-grip').addEventListener('dblclick', resetPanelSize);
  $('panel-size-reset').addEventListener('click', resetPanelSize);

  $('search').addEventListener('input', (e) => { ui.filter = e.target.value; ui.sel = -1; renderList(); });
  $('add-search').addEventListener('input', (e) => { ui.addFilter = e.target.value; renderAddList(); });

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouseDown, true);

  // pointer-drag engine (Ultralight has no HTML5 DnD — see engine header)
  document.addEventListener('mousemove', pdMove, true);
  document.addEventListener('mouseup', pdFinish, true);
  // a completed drag's mouseup synthesizes a click on whatever it dropped on —
  // swallow exactly that one so dropping a spell never CASTS the target
  document.addEventListener('click', (e) => {
    if (pdrag.suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // our spell rows own right-click; suppress the renderer's default menu everywhere
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  // the menu is anchored to a point — scrolling the list or resizing invalidates it
  $('list').addEventListener('scroll', closeCtx, true);
  $('list').addEventListener('scroll', cancelDesc, true);
  $('add-list').addEventListener('scroll', cancelDesc, true);
  window.addEventListener('resize', closeCtx);
  window.addEventListener('resize', cancelDesc);
  // a resolution change shrinks the size ceiling — re-clamp the drag size to it
  window.addEventListener('resize', applyPanelSize);

  // left-clicking the backdrop (outside the panel) closes; right-click must not
  $('overlay').addEventListener('mousedown', (e) => { if (e.button === 0 && e.target === $('overlay')) toGame('mdClose'); });
  $('add-modal').addEventListener('mousedown', (e) => { if (e.button === 0 && e.target === $('add-modal')) closeAdd(); });
}

/* ===================================================== bridge receivers == */

function coerce(x) {
  if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
  return x;
}

function normalizeConfig(cfg) {
  cfg = cfg || {};
  const ok = cfg.openKey || {};
  state.openKey = {
    device: ok.device || 'keyboard',
    code: (ok.code >>> 0) || 105,
    label: ok.label || 'F18',
  };
  const ak = cfg.addKey || {};
  state.addKey = {
    device: ak.device || 'keyboard',
    code: (ak.code >>> 0) || 0x4E,
    label: ak.label || 'Num +',
  };
  state.removeOnAdd = !!cfg.removeOnAdd;
  state.uiScale = typeof cfg.uiScale === 'number' ? cfg.uiScale : 1.0;
  state.iconPx = (cfg.iconPx >>> 0) || 0;   // 0 = the CSS default
  /* drag size: pre-scale layout px, 0 = auto. Both or neither — a half-set
   * pair (an old config, a hand-edit) falls back to auto rather than a
   * default-width / custom-height hybrid. Kept RAW here; applyPanelSize()
   * clamps to this screen without destroying a size saved on a bigger one. */
  const pnum = (v) => { const n = Math.round(Number(v) || 0); return (n > 0 && n < 20000) ? n : 0; };
  const pw = pnum(cfg.panelW), ph = pnum(cfg.panelH);
  state.panelW = (pw && ph) ? pw : 0;
  state.panelH = (pw && ph) ? ph : 0;
  state.categories = Array.isArray(cfg.categories) ? cfg.categories.filter((c) => typeof c === 'string' && c) : [];
  if (!state.categories.length) state.categories = ['Destruction', 'Restoration', 'Alteration', 'Conjuration', 'Illusion'];
  state.catIcons = {};
  if (cfg.catIcons && typeof cfg.catIcons === 'object') {
    for (const k in cfg.catIcons) {
      const v = catIconSrc(cfg.catIcons[k]);
      if (k && v) state.catIcons[k] = v;
    }
  }
  state.spells = (Array.isArray(cfg.spells) ? cfg.spells : []).map((s) => ({
    id: String(s.id || ''),
    plugin: s.plugin || '',
    localId: (s.localId >>> 0) || 0,
    formId: (s.formId >>> 0) || 0,
    name: s.name || 'spell',
    mode: s.mode === 'equip' ? 'equip' : 'cast',
    hand: (s.hand === 'left' || s.hand === 'both') ? s.hand : 'right',
    category: state.categories.includes(s.category) ? s.category : state.categories[0],
    slot: s.slot || '', school: s.school || '', element: s.element || '', archetype: s.archetype || '',
    tier: s.tier || '', icon: s.icon || '',
  })).filter((s) => s.id && (s.plugin || s.formId));
  state.combos = (Array.isArray(cfg.combos) ? cfg.combos : []).map((c) => ({
    id: String(c.id || ''),
    name: typeof c.name === 'string' ? c.name : '',
    spells: (Array.isArray(c.spells) ? c.spells : []).map((m) => ({
      plugin: m.plugin || '',
      localId: (m.localId >>> 0) || 0,
      formId: (m.formId >>> 0) || 0,
      name: m.name || 'spell',
      type: m.type || '', school: m.school || '', element: m.element || '', archetype: m.archetype || '',
      tier: m.tier || '', icon: m.icon || '',
    })).filter((m) => m.plugin || m.formId).slice(0, COMBO_MAX),
  })).filter((c) => c.id && c.spells.length);
  state.removed = (Array.isArray(cfg.removed) ? cfg.removed : []).map((r) => ({
    plugin: r.plugin || '',
    localId: (r.localId >>> 0) || 0,
    formId: (r.formId >>> 0) || 0,
    name: r.name || 'spell',
    type: r.type || '', school: r.school || '', element: r.element || '', archetype: r.archetype || '',
    tier: r.tier || '',
  })).filter((r) => r.plugin || r.formId);
}

window.mdOpen = function (cfg) {
  // C++ re-pushes this payload for LIVE updates (a phone icon assignment landing
  // through the portal poller). Already open = data refresh only: the resets below
  // would close the icon picker, drop the search text and steal focus mid-keystroke.
  const wasOpen = document.body.classList.contains('open');
  if (!wasOpen) { closeCtx(); cancelDesc(); }
  cfg = coerce(cfg);
  normalizeConfig(cfg);
  if (ui.cat !== ALL && !state.categories.includes(ui.cat)) ui.cat = ALL;
  if (!wasOpen) {
    ui.editing = false;
    ui.filter = '';
    ui.sel = -1;
    ui.armDelCat = null;
    if ($('search')) $('search').value = '';
  }
  applyScale();
  applyIconSize();
  applyPanelSize();     // restore the saved drag size (applyScale re-clamps it too)
  document.body.classList.add('open');
  render();
  // enrich slot/type so equip hand/voice controls are correct without opening the picker
  ui.knownLoading = false;
  toGame('mdKnown');
  if (!wasOpen) setTimeout(() => { const s = $('search'); if (s) s.focus(); }, 40);
};

window.mdEquipState = function (s) {
  s = coerce(s);
  if (!s) return;
  ui.equip.left = canonHex(s.left);
  ui.equip.right = canonHex(s.right);
  ui.equip.voice = new Set((Array.isArray(s.voice) ? s.voice : []).map(canonHex).filter(Boolean));
  renderList();
};

window.mdSpells = function (rows) {
  rows = coerce(rows);
  if (!Array.isArray(rows)) rows = [];
  ui.known = rows;
  ui.knownLoading = false;
  ui.knownById = new Map();
  rows.forEach((k) => ui.knownById.set(hexId(k.formId), {
    slot: k.slot || 'hand', type: k.type, delivery: k.delivery, casting: k.casting,
    school: k.school || '', element: k.element || '', archetype: k.archetype || '',
    tier: k.tier || '',
  }));
  enrichFromKnown();
  if (ui.addOpen) renderAddList();
  renderList();   // equip controls now know hand vs voice
};

/* Write the live engine metadata BACK into the saved entries. metaFor() merges
 * it at render time, but only for as long as the spell is in the known list —
 * an entry written by an older build (or one whose spell later leaves the
 * spellbook) otherwise keeps resolving to a glyph forever, because nothing
 * ever re-enriched it. Only fills BLANKS, so it can't fight the engine or
 * clobber a user's choice; saves only when it actually changed something.
 * Also logs what it could NOT fill: a deck entry with no live row AND no saved
 * school is exactly the case that falls through to a name-guessed glyph, and
 * naming it in HotkeyDeck.log is how we tell "stale snapshot" apart from
 * "engine reports no school for this modded spell". */
const META_FIELDS = ['slot', 'school', 'element', 'archetype', 'tier'];
function enrichFromKnown() {
  let filled = 0;
  const orphans = [];
  const fill = (o) => {
    const k = ui.knownById.get(hexId(o.formId));
    if (!k) return false;
    let any = false;
    META_FIELDS.forEach((f) => { if (!o[f] && k[f]) { o[f] = k[f]; any = true; } });
    return any;
  };
  state.spells.forEach((s) => {
    if (fill(s)) filled++;
    if (!ui.knownById.has(hexId(s.formId)) && !s.school) orphans.push(s.name || s.id);
  });
  state.combos.forEach((c) => c.spells.forEach((m) => { if (fill(m)) filled++; }));
  if (filled) saveSoon();
  glog('spell deck: ' + state.spells.length + ' entries, ' + ui.known.length + ' known spells, ' +
    filled + ' enriched from engine' +
    (orphans.length ? ', ' + orphans.length + ' with no engine metadata: ' + orphans.slice(0, 12).join(', ')
                    : ', none missing metadata'));
  return filled;
}

window.mdToggled = function (r) {
  r = coerce(r);
  if (!r) return;
  const hx = canonHex(r.formId);
  if (hx) {
    if (r.left) ui.equip.left = hx; else if (ui.equip.left === hx) ui.equip.left = '';
    if (r.right) ui.equip.right = hx; else if (ui.equip.right === hx) ui.equip.right = '';
    if (r.voice) ui.equip.voice.add(hx); else ui.equip.voice.delete(hx);
  }
  if (r.msg) toast(r.msg);
  renderList();
};

window.mdSaved = function (ok) {
  if (ok === false || ok === 'false') toast('⚠ Save failed — check HotkeyDeck.log');
};

/* engine confirmed a spellbook removal — the engine result is authoritative and
 * carries the icon metadata (a removed spell is gone from the known-spells list).
 * formId is a NUMBER here, same as state.spells, not a hex string. */
window.mdRemoved = function (res) {
  res = coerce(res);
  if (!res) return;
  if (!res.ok) { if (res.msg) toast(res.msg); return; }
  const fid = res.formId >>> 0;
  // deck entries pointing at this spell are now dead (can't cast/equip an unknown
  // spell) — drop every copy across categories, and prune it out of every combo
  // (a combo that empties out goes with it)
  state.spells = state.spells.filter((s) => (s.formId >>> 0) !== fid);
  state.combos.forEach((c) => { c.spells = c.spells.filter((m) => (m.formId >>> 0) !== fid); });
  state.combos = state.combos.filter((c) => c.spells.length);
  // record it in the restorable list (newest first, deduped by formId)
  const entry = {
    plugin: res.plugin || '', localId: res.localId >>> 0, formId: fid,
    name: res.name || 'spell', type: res.type || '',
    school: res.school || '', element: res.element || '', archetype: res.archetype || '',
    tier: res.tier || '',
  };
  state.removed = state.removed.filter((x) => (x.formId >>> 0) !== fid);
  state.removed.unshift(entry);
  ui.removedOpen = true;          // reveal so the user sees where it went
  save();                         // persist immediately (full round-trip)
  render();
  toGame('mdKnown');              // it drops out of the add-picker's known list
  toast(res.msg || ('Removed ' + entry.name));
};

/* engine confirmed a restore — drop it from the Removed list */
window.mdRestored = function (res) {
  res = coerce(res);
  if (!res) return;
  if (!res.ok) { if (res.msg) toast(res.msg); return; }
  const fid = res.formId >>> 0;
  const e = state.removed.find((x) => (x.formId >>> 0) === fid);
  state.removed = state.removed.filter((x) => (x.formId >>> 0) !== fid);
  save();
  render();
  toGame('mdKnown');              // back in the spellbook -> back in the add-picker
  toast(res.msg || ('Restored ' + (e ? e.name : 'spell')));
};

window.mdClosed = function () {
  closeCtx();
  cancelDesc();
  closeIconPicker();
  document.body.classList.remove('open');
  pdrag.armed = null; pdrag.active = false; pdClearTarget();
  document.body.classList.remove('pdragging');
  dragKind = null; comboDragActive = false;
  ui.capture = null;
  $('capture-modal').classList.add('hidden');
  $('openkey-btn').classList.remove('capturing');
  if (ui.addOpen) { ui.addOpen = false; $('add-modal').classList.add('hidden'); }
  ui.editing = false;
  ui.filter = '';
  ui.sel = -1;
  ui.removedOpen = false;
};

/* extended F13–F24 bridge + native mouse — only used here during open-key capture */
window.hdExtKey = function (info) {
  info = coerce(info);
  if (!info || !ui.capture) return;
  applyCapture('keyboard', info.raw >>> 0, info.name || ('F' + info.raw));
};
window.hdNativeMouse = function (info) {
  info = coerce(info);
  if (!info || !ui.capture) return;
  applyCapture('mouse', info.code >>> 0, info.label || ('Mouse ' + info.code));
};

/* ============================================================== boot ==== */

function init() {
  wire();
  applyScale();
  render();
  if (DEV) devBoot();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

/* ============================================================== dev ===== */

const SAMPLE_KNOWN = [
  { plugin: 'Skyrim.esm', localId: 0x0002dd29, formId: 0x0002dd29, name: 'Flames', type: 'spell', delivery: 'aimed', casting: 'concentration', slot: 'hand', school: 'destruction', element: 'fire', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0002dd2a, formId: 0x0002dd2a, name: 'Firebolt', type: 'spell', delivery: 'aimed', casting: 'fire', slot: 'hand', school: 'destruction', element: 'fire', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0005db90, formId: 0x0005db90, name: 'Healing', type: 'spell', delivery: 'self', casting: 'concentration', slot: 'hand', school: 'restoration', element: '', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0005ad5c, formId: 0x0005ad5c, name: 'Lesser Ward', type: 'spell', delivery: 'self', casting: 'concentration', slot: 'hand', school: 'restoration', element: '', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0004deb9, formId: 0x0004deb9, name: 'Oakflesh', type: 'spell', delivery: 'self', casting: 'fire', slot: 'hand', school: 'alteration', element: '', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x000211f2, formId: 0x000211f2, name: 'Beast Form', type: 'power', delivery: 'self', casting: 'fire', slot: 'voice', school: '', element: '', archetype: '' },
  { plugin: 'Dawnguard.esm', localId: 0x00016e2b, formId: 0x02016e2b, name: 'Vampiric Drain', type: 'spell', delivery: 'aimed', casting: 'concentration', slot: 'hand', school: 'destruction', element: '', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0002dd28, formId: 0x0002dd28, name: 'Frostbite', type: 'spell', delivery: 'aimed', casting: 'concentration', slot: 'hand', school: 'destruction', element: 'frost', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x0002dd23, formId: 0x0002dd23, name: 'Sparks', type: 'spell', delivery: 'aimed', casting: 'concentration', slot: 'hand', school: 'destruction', element: 'shock', archetype: '' },
  { plugin: 'Skyrim.esm', localId: 0x000640b6, formId: 0x000640b6, name: 'Conjure Familiar', type: 'spell', delivery: 'self', casting: 'fire', slot: 'hand', school: 'conjuration', element: '', archetype: 'summon' },
  { plugin: 'Skyrim.esm', localId: 0x000211ed, formId: 0x000211ed, name: 'Bound Sword', type: 'spell', delivery: 'self', casting: 'fire', slot: 'hand', school: 'conjuration', element: '', archetype: 'bound' },
  { plugin: 'Skyrim.esm', localId: 0x00043324, formId: 0x00043324, name: 'Candlelight', type: 'spell', delivery: 'self', casting: 'fire', slot: 'hand', school: 'alteration', element: '', archetype: 'light' },
];
const SAMPLE_CFG = {
  openKey: { device: 'keyboard', code: 105, label: 'F18' },
  uiScale: 1.0,
  categories: ['Destruction', 'Restoration', 'Alteration', 'Powers'],
  spells: [
    { id: '0x0002DD29', plugin: 'Skyrim.esm', localId: 0x0002dd29, formId: 0x0002dd29, name: 'Flames', mode: 'equip', hand: 'left', category: 'Destruction' },
    { id: '0x0002DD2A', plugin: 'Skyrim.esm', localId: 0x0002dd2a, formId: 0x0002dd2a, name: 'Firebolt', mode: 'cast', hand: 'right', category: 'Destruction' },
    { id: '0x0005DB90', plugin: 'Skyrim.esm', localId: 0x0005db90, formId: 0x0005db90, name: 'Healing', mode: 'equip', hand: 'both', category: 'Restoration' },
    { id: '0x000211F2', plugin: 'Skyrim.esm', localId: 0x000211f2, formId: 0x000211f2, name: 'Beast Form', mode: 'equip', hand: 'right', category: 'Powers' },
  ],
};

const DEV_ICON_INDEX = {
  byForm: { 'skyrim.esm|2dd29': 'icons/sh/icons_vanilla/skyrim.esm_2dd29.png' },
  generic: {
    DESTRUCTION_FIRE_ADEPT: 'icons/sh/default_icons/DESTRUCTION_FIRE_ADEPT.png',
    SHOUT_GENERIC: 'icons/sh/default_icons/SHOUT_GENERIC.png',
  },
  catalog: [
    { file: 'icons/sh/icons_vanilla/skyrim.esm_2dd29.png', atlas: 'icons_vanilla', label: 'Flames', kind: 'form', key: 'skyrim.esm|2dd29' },
    { file: 'icons/sh/default_icons/DESTRUCTION_FIRE_ADEPT.png', atlas: 'default_icons', label: 'DESTRUCTION_FIRE_ADEPT', kind: 'name', key: 'default_icons|DESTRUCTION_FIRE_ADEPT' },
  ],
};

function devBoot() {
  // stand in for the C++ listeners so the view is fully clickable in a browser
  const devRemoved = new Set();   // formIds "removed" from the fake spellbook
  window.mdKnown = function () {
    setTimeout(() => window.mdSpells(SAMPLE_KNOWN.filter((k) => !devRemoved.has(k.formId >>> 0))), 180);
  };
  window.mdFire = function (id) {
    const s = state.spells.find((x) => x.id === id);
    if (!s) return;
    if (s.mode === 'equip') {
      const hx = hexId(s.formId);
      const slot = slotOf(s);
      let left = ui.equip.left === hx, right = ui.equip.right === hx, voice = ui.equip.voice.has(hx);
      if (slot === 'voice') voice = !voice;
      else if (s.hand === 'left') left = !left;
      else if (s.hand === 'right') right = !right;
      else { const on = !(left && right); left = right = on; }
      window.mdToggled({ ok: true, msg: (left || right || voice ? 'Equipped ' : 'Unequipped ') + s.name, formId: hx, left, right, voice });
    } else {
      toast('Cast ' + s.name + ' (dev)');
    }
  };
  window.mdCastCombo = function (j) {
    const p = JSON.parse(j);
    window.__lastComboCast = p;
    toast('⚡ ' + (p.name || 'Combo') + ' — cast ' + p.spells.length + ' spells (dev)');
  };
  window.mdSave = function (j) { console.log('[dev] save', j); };
  window.mdClose = function () { window.mdClosed(); };
  window.mdCapture = function (x) { console.log('[dev] capture', x); };
  window.mdLog = function (s) { console.log('[dev] log', s); };
  window.mdRemoveSpell = function (j) {
    const p = JSON.parse(j); const fid = p.formId >>> 0;
    const k = SAMPLE_KNOWN.find((x) => (x.formId >>> 0) === fid) || {};
    if ((k.slot || 'hand') === 'voice') { setTimeout(() => window.mdRemoved({ ok: false, msg: 'Only spells can be removed (dev)' }), 100); return; }
    devRemoved.add(fid);
    setTimeout(() => window.mdRemoved({
      ok: true, msg: 'Removed ' + (k.name || 'spell') + ' (dev)', formId: fid,
      plugin: p.plugin, localId: p.localId, name: k.name || 'spell', type: k.type || 'spell',
      school: k.school || '', element: k.element || '', archetype: k.archetype || '',
    }), 120);
  };
  window.mdRestoreSpell = function (j) {
    const p = JSON.parse(j); const fid = p.formId >>> 0;
    devRemoved.delete(fid);
    setTimeout(() => window.mdRestored({ ok: true, msg: 'Restored (dev)', formId: fid }), 120);
  };
  window.mdGetDesc = function (j) {
    const q = JSON.parse(j);
    setTimeout(() => window.mdDesc({
      ok: true, formId: q.formId, name: 'Dev spell',
      text: 'Target takes 25 points of dev damage for 3 seconds.',
    }), 160);
  };
  window.mdIconList = function () {
    setTimeout(() => window.mdIcons({ custom: [{ file: 'icons/custom/dev-rune.png', label: 'dev-rune' }] }), 120);
  };
  window.mdOpen(SAMPLE_CFG);
  window.mdIconIndex(DEV_ICON_INDEX);
  window.mdIcons({ custom: [{ file: 'icons/custom/dev-rune.png', label: 'dev-rune' }] });
  setTimeout(() => window.mdEquipState({ left: '0x0002DD29', right: '', voice: [] }), 220);
  if (SELFTEST) setTimeout(runSelfTest, 500);
}

/* ---------------------------------------------------------- self-test --- */

function runSelfTest() {
  const results = [];
  const ok = (name, cond) => { results.push({ name, pass: !!cond }); };

  ok('hexId pads to 0x00000001', hexId(1) === '0x00000001');
  ok('hexId uppercases 8 digits', hexId(0x02016e2b) === '0x02016E2B');
  ok('canonHex normalizes any case', canonHex('0X0002DD29') === '0x0002DD29' &&
    canonHex('0x0002dd29') === '0x0002DD29' && canonHex('2DD29') === '0x0002DD29' && canonHex('junk') === '');
  ok('config loaded categories', state.categories.length >= 4);
  ok('config loaded spells', state.spells.length >= 4);
  ok('rail rendered All + categories', $('rail-list').children.length === state.categories.length + 1);

  ui.cat = ALL; ui.filter = ''; renderList();
  const totalRows = $('list').children.length;
  ok('All shows every spell', totalRows === state.spells.length);

  ui.filter = 'fire'; renderList();
  ok('search filters live', $('list').children.length >= 1 && $('list').children.length < totalRows);
  ui.filter = ''; renderList();

  const vis = visibleSpells();
  ok('quick-fire index maps digit→row', vis.length >= 1);
  const q1 = $('list').children[0] && $('list').children[0].querySelector('.qkey');
  ok('quick-fire keycap on first row', !!q1 && q1.textContent === '1');

  // equip reconcile: Flames equipped-left from mdEquipState
  const flames = state.spells.find((s) => s.name === 'Flames');
  ok('equip badge reconciles hex', flames && ui.equip.left === hexId(flames.formId));

  // add flow
  const before = state.spells.length;
  ui.addCat = 'Restoration';
  addKnown(SAMPLE_KNOWN[2], 'cast');   // Healing as cast
  ok('add appends a spell', state.spells.length === before + 1);
  ok('added spell lands in target category', state.spells[state.spells.length - 1].category === 'Restoration');

  // capture apply
  startCapture();
  applyCapture('keyboard', 0x42, 'F8');
  ok('capture sets open key', state.openKey.code === 0x42 && state.openKey.label === 'F8');
  ok('capture closes modal', $('capture-modal').classList.contains('hidden'));

  // icon classification — element beats school, archetype beats school, voice/power
  ok('icon: fire by element', iconKeyFor({ school: 'destruction', element: 'fire' }) === 'fire');
  ok('icon: frost by element', iconKeyFor({ school: 'destruction', element: 'frost' }) === 'frost');
  ok('icon: shock by element', iconKeyFor({ school: 'destruction', element: 'shock' }) === 'shock');
  ok('icon: school fallback', iconKeyFor({ school: 'restoration' }) === 'restoration');
  ok('icon: summon archetype', iconKeyFor({ school: 'conjuration', archetype: 'summon' }) === 'summon');
  ok('icon: bound beats school', iconKeyFor({ school: 'conjuration', archetype: 'bound' }) === 'bound');
  ok('icon: voice type -> shout', iconKeyFor({ type: 'voice' }) === 'shout');
  ok('icon: power slot -> power', iconKeyFor({ slot: 'voice', type: 'power' }) === 'power');
  ok('icon: name fallback fire', iconKeyFromName(' Great Fireball') === 'fire');
  ok('icon: name fallback default', iconKeyFromName('Zzz Nonsense') === 'spell');
  ok('glyph builds an svg', !!glyphEl('fire').querySelector('svg'));
  ok('every icon key has svg', Object.keys(ICON_SVG).every((k) => /<svg/.test(ICON_SVG[k])));

  // right-click context menu open/clamp/close
  const ctxSpell = state.spells[0];
  openCtxMenu(ctxSpell, 100, 100);
  ok('ctx menu opens', !!$('ctx-menu') && $('ctx-menu').querySelectorAll('.ctx-item').length >= 2);
  ok('ctx menu inside viewport', (() => { const r = $('ctx-menu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0; })());
  closeCtx();
  // corner case: opened at the bottom-right, the WHOLE menu must still fit
  openCtxMenu(ctxSpell, window.innerWidth - 20, window.innerHeight - 20);
  ok('ctx menu clamps off the bottom-right corner', (() => {
    const m = $('ctx-menu');
    return m.offsetLeft >= 0 && m.offsetTop >= 0 &&
      m.offsetLeft + m.offsetWidth <= window.innerWidth &&
      m.offsetTop + m.offsetHeight <= window.innerHeight;
  })());
  closeCtx();
  ok('ctx menu closes', !$('ctx-menu'));

  // remove / restore from spellbook — drive the engine-confirmed receivers directly
  // (the authoritative path; the live round-trip is async, the state logic is not)
  const rmTarget = state.spells[0];
  const rmFid = rmTarget.formId >>> 0;
  const removedBefore = state.removed.length;
  window.mdRemoved({
    ok: true, formId: rmFid, plugin: rmTarget.plugin, localId: rmTarget.localId,
    name: rmTarget.name, type: rmTarget.type, school: 'destruction', element: 'fire', archetype: '',
  });
  ok('remove drops spell from deck', state.spells.every((s) => (s.formId >>> 0) !== rmFid));
  ok('remove adds to Removed list', state.removed.length === removedBefore + 1 && (state.removed[0].formId >>> 0) === rmFid);
  ok('remove opens Removed drawer', ui.removedOpen === true);
  ok('Removed section renders a row', !$('removed-section').classList.contains('hidden') && !!$('removed-section').querySelector('.removed-row'));
  window.mdRemoved({ ok: true, formId: rmFid, plugin: rmTarget.plugin, localId: rmTarget.localId, name: rmTarget.name, type: rmTarget.type });
  ok('remove dedupes by formId', state.removed.filter((x) => (x.formId >>> 0) === rmFid).length === 1);
  const removedNow = state.removed.length;
  window.mdRemoved({ ok: false, msg: 'granted by race' });
  ok('remove ok:false is a no-op', state.removed.length === removedNow);
  window.mdRestored({ ok: true, formId: rmFid });
  ok('restore drops from Removed list', state.removed.every((x) => (x.formId >>> 0) !== rmFid));

  // ---- combos: drag together, add, dedupe, cast payload, menu ops, prune ----
  ui.editing = false;
  const cA = state.spells[0], cB = state.spells[1], cC = state.spells[2];
  const combosBefore = state.combos.length;
  createCombo(cA, cB);
  const combo = state.combos[state.combos.length - 1];
  ok('combo: drop creates a 2-spell combo', state.combos.length === combosBefore + 1 && combo.spells.length === 2);
  ok('combo: strip shows the card', !$('combo-strip').classList.contains('hidden') &&
    !!$('combo-strip').querySelector('.combo-card[data-cid="' + cssEsc(combo.id) + '"]'));
  ok('combo: card stacks member glyphs', $('combo-strip').querySelectorAll('.combo-card .glyph').length >= 2);
  ok('combo: auto-name starts with first member', comboName(combo).indexOf(cA.name) === 0);
  createCombo(cA, cA);
  ok('combo: same-spell drop refused', state.combos.length === combosBefore + 1);
  addSpellToCombo(combo, cB.id);
  ok('combo: add dedupes by formId', combo.spells.length === 2);
  addSpellToCombo(combo, cC.id);
  ok('combo: drop on card adds 3rd spell', combo.spells.length === 3);
  window.__lastComboCast = null;
  castCombo(combo);
  ok('combo: cast sends full member list + name', !!window.__lastComboCast &&
    window.__lastComboCast.spells.length === 3 && !!window.__lastComboCast.name &&
    window.__lastComboCast.spells.every((m) => m.plugin || m.formId));
  ok('combo: payload persists combos', (payload().combos || []).some((c) => c.id === combo.id && c.spells.length === 3));

  // (ghost strip behavior is exercised by the pointer-drag suite at the end)

  // menu: member rows render; reorder + spellbook-prune keep state coherent
  openComboMenu(combo, 80, 80);
  ok('combo: menu lists members in order', !!$('ctx-menu') && $('ctx-menu').querySelectorAll('.ctx-member').length === 3);
  ok('combo: menu has rename input', !!$('ctx-menu').querySelector('.ctx-rename'));
  closeCtx();
  const wasSecond = combo.spells[1].name;
  moveInArray(combo.spells, 1, 0);
  ok('combo: member reorder', combo.spells[0].name === wasSecond);
  const pruneFid = combo.spells[0].formId >>> 0;
  window.mdRemoved({ ok: true, formId: pruneFid, plugin: 'Skyrim.esm', localId: pruneFid, name: wasSecond, type: 'spell' });
  ok('combo: spellbook removal prunes member', combo.spells.length === 2 &&
    combo.spells.every((m) => (m.formId >>> 0) !== pruneFid));

  // delete through the menu's armed two-click
  openComboMenu(combo, 80, 80);
  const delBtn2 = $('ctx-menu').querySelector('.ctx-item.danger:last-of-type');
  delBtn2.click(); delBtn2.click();
  ok('combo: armed delete removes combo', state.combos.length === combosBefore);
  renderCombos();
  ok('combo: strip hides when empty', $('combo-strip').classList.contains('hidden'));

  // ---- SH icon library: resolver chain, tiers, overrides ----
  ok('sh: byForm key format', shKeyFor({ plugin: 'Skyrim.esm', localId: 0x2dd29 }) === 'skyrim.esm|2dd29');
  ok('sh: exact resolve', resolveIconPath({ plugin: 'Skyrim.esm', localId: 0x2dd29 }) === 'icons/sh/icons_vanilla/skyrim.esm_2dd29.png');
  ok('sh: override wins', resolveIconPath({ icon: 'icons/custom/x.png', plugin: 'Skyrim.esm', localId: 0x2dd29 }) === 'icons/custom/x.png');
  ok('sh: generic fallback', resolveIconPath({ plugin: 'nope.esp', localId: 1, type: 'spell', school: 'destruction', element: 'fire', tier: 'adept' }) === 'icons/sh/default_icons/DESTRUCTION_FIRE_ADEPT.png');
  ok('sh: unresolvable -> null (svg)', resolveIconPath({ plugin: 'nope.esp', localId: 1, type: 'spell', school: 'alteration' }) === null);
  ok('sh: tier defaults to adept', genericKeyFor({ type: 'spell', school: 'alteration' }) === 'ALTERATION_ADEPT');
  ok('sh: master tier', genericKeyFor({ type: 'spell', school: 'destruction', element: 'frost', tier: 'master' }) === 'DESTRUCTION_FROST_MASTER');
  ok('sh: voice -> SHOUT_GENERIC', genericKeyFor({ type: 'voice' }) === 'SHOUT_GENERIC');
  ok('sh: bound conjuration', genericKeyFor({ type: 'spell', school: 'conjuration', archetype: 'bound', tier: 'novice' }) === 'CONJURATION_BOUND_WEAPON_NOVICE');
  ok('sh: hostile illusion', genericKeyFor({ type: 'spell', school: 'illusion', archetype: 'fear', tier: 'expert' }) === 'ILLUSION_HOSTIL' + 'E_EXPERT');
  ok('sh: iconEl builds an img', !!iconEl({ plugin: 'Skyrim.esm', localId: 0x2dd29 }).querySelector('img'));
  ok('sh: iconEl falls back to svg', !!iconEl({ plugin: 'nope.esp', localId: 1, school: 'restoration' }).querySelector('svg'));

  // ---- metadata-less entries still get a REAL icon (the "back to emojis" bug) ----
  // No school (an entry saved by an older build, or a spell the known list
  // doesn't cover) used to kill the PNG chain outright while the glyph path
  // happily guessed from the name. Both ladders must now agree.
  ok('meta: no school, fiery name -> destruction fire art',
    genericKeyFor({ name: 'Chains of Flame', tier: 'apprentice' }) === 'DESTRUCTION_FIRE_APPRENTICE');
  ok('meta: no school, element alone -> destruction art',
    genericKeyFor({ name: 'Whatever', element: 'frost' }) === 'DESTRUCTION_FROST_ADEPT');
  ok('meta: no school, archetype alone -> its school',
    genericKeyFor({ name: 'Whatever', archetype: 'summon' }) === 'CONJURATION_SUMMON_ADEPT');
  ok('meta: voice slot with no type -> power art',
    genericKeyFor({ name: 'Whatever', slot: 'voice' }) === 'GREATER_POWER');
  ok('meta: genuinely unclassifiable stays null (glyph)',
    genericKeyFor({ name: 'Ouroboros' }) === null);
  ok('meta: engine school always beats the guess',
    genericKeyFor({ name: 'Chains of Flame', school: 'illusion', tier: 'adept' }) === 'ILLUSION_FRIENDL' + 'Y_ADEPT');

  // ---- enrichFromKnown: the saved snapshot is repaired from live rows ----
  {
    const bare = { id: '0xDEADBEEF', plugin: 'x.esp', localId: 1, formId: 0xdeadbeef, name: 'Bare',
      mode: 'cast', hand: 'right', category: state.categories[0],
      slot: '', school: '', element: '', archetype: '', tier: '', icon: '' };
    state.spells.push(bare);
    window.mdSpells([{ formId: 0xdeadbeef, name: 'Bare', slot: 'hand', type: 'spell',
      school: 'destruction', element: 'shock', archetype: '', tier: 'expert' }]);
    ok('meta: live rows backfill a bare entry', bare.school === 'destruction' && bare.tier === 'expert');
    ok('meta: repaired entry resolves real art',
      genericKeyFor(metaFor(bare)) === 'DESTRUCTION_SHOCK_EXPERT');
    ok('meta: the repair persists in the payload',
      payload().spells.some((s) => s.id === bare.id && s.school === 'destruction'));
    bare.icon = 'icons/custom/mine.png';
    window.mdSpells([{ formId: 0xdeadbeef, name: 'Bare', slot: 'hand', type: 'spell',
      school: 'illusion', element: '', archetype: '', tier: 'novice' }]);
    ok('meta: enrich only fills blanks, never overwrites',
      bare.school === 'destruction' && bare.icon === 'icons/custom/mine.png');
    state.spells = state.spells.filter((s) => s.id !== bare.id);
    window.mdSpells([]);
  }

  // ---- icon picker: open, search, pick, auto ----
  ui.editing = false; ui.cat = ALL; ui.filter = ''; renderList();
  const pkSpell = state.spells[0];
  openIconPicker(pkSpell);
  ok('picker: opens with tiles', iconPicker.open && $('icon-grid').querySelectorAll('.icon-tile').length >= 2);
  iconPicker.filter = 'flames'; iconPicker.shown = ICON_PAGE; renderIconPicker();
  ok('picker: search narrows to the match', $('icon-grid').querySelectorAll('.icon-tile:not(.auto)').length === 1);
  pickIcon('icons/sh/icons_vanilla/skyrim.esm_2dd29.png');
  ok('picker: pick sets override + closes', pkSpell.icon === 'icons/sh/icons_vanilla/skyrim.esm_2dd29.png' && !iconPicker.open);
  ok('picker: override persists in payload', payload().spells.some((s) => s.id === pkSpell.id && s.icon === pkSpell.icon));
  openIconPicker(pkSpell);
  pickIcon('');
  ok('picker: Auto clears override', pkSpell.icon === '' && !iconPicker.open);

  // ---- capture routing + settings persistence ----
  startCapture('add');
  applyCapture('keyboard', 0x4F, 'Num 1');
  ok('capture: add kind sets capture key', state.addKey.label === 'Num 1' && state.addKey.code === 0x4F);
  ok('capture: open key untouched by add-capture', state.openKey.label !== 'Num 1');
  ok('settings: addKey in payload', !!payload().addKey && payload().addKey.code === 0x4F);
  state.removeOnAdd = true;
  ok('settings: removeOnAdd in payload', payload().removeOnAdd === true);
  state.removeOnAdd = false;

  // ---- hover description: cache + tip render + cancel ----
  const dSpell = state.spells[0];
  desc.key = hexId(dSpell.formId); desc.meta = metaFor(dSpell);
  desc.anchor = $('list').querySelector('.spell') || document.body;
  window.mdDesc({ ok: true, formId: dSpell.formId, name: dSpell.name, text: 'Deals 42 points of test damage.' });
  ok('desc: cached + tip rendered', desc.cache.has(hexId(dSpell.formId)) &&
    !$('desc-tip').classList.contains('hidden') && $('desc-tip').textContent.indexOf('42 points') >= 0);
  // The tip must hang off #overlay, never #panel: the panel is transform-scaled,
  // so it would become the containing block and re-read screen px as local px.
  ok('desc: tip hangs off #overlay, clear of the panel transform',
    $('desc-tip').parentElement === $('overlay'));
  // …and it must land clear of the row it describes, at a scale != 1 (the case
  // that was visibly broken: 130% put it ~176px below the wrong row).
  {
    const keepScale = state.uiScale, s = 1.3;
    state.uiScale = s; applyScale();            // not setScale(): no config write
    placeDescTip(desc.anchor);
    const tip = $('desc-tip'), ar = desc.anchor.getBoundingClientRect();
    // the PLACED values, not getBoundingClientRect: tipIn opens from
    // translateY(-5px), so a rect sampled on this frame reads 5px * scale high
    // (the same trap clampCtx documents). Screen px either way — the tip lives
    // in the untransformed overlay; only its own scale has to be multiplied in.
    const x = parseFloat(tip.style.left), y = parseFloat(tip.style.top);
    const tw = tip.offsetWidth * s, th = tip.offsetHeight * s;
    const under = Math.abs(y - (ar.bottom + 8)) <= 1;
    const above = Math.abs((y + th) - (ar.top - 8)) <= 1;
    ok('desc: tip parks under the row (else above), never over it', under || above);
    ok('desc: tip left edge tracks the row, clamped to the viewport',
      Math.abs(x - ar.left) <= 1 || Math.abs((x + tw) - (window.innerWidth - 8)) <= 1 || x === 8);
    ok('desc: tip scales with the panel', Math.abs(tip.getBoundingClientRect().width - tw) <= 1.5);
    state.uiScale = keepScale; applyScale();
  }
  cancelDesc();
  ok('desc: cancel hides tip', $('desc-tip').classList.contains('hidden'));

  // ---- pointer-drag engine (Ultralight has no HTML5 DnD) ----
  ui.editing = false; ui.cat = ALL; ui.filter = ''; ui.sel = -1;
  closeIconPicker(); renderList(); renderCombos();
  const fm = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  const pdRows = $('list').querySelectorAll('.spell');
  const pdCombosBefore = state.combos.length;
  if (pdRows.length >= 2) {
    const r0 = pdRows[0].getBoundingClientRect();
    fm(pdRows[0], 'mousedown', r0.left + 20, r0.top + 8);
    ok('pdrag: mousedown arms, not active', !!pdrag.armed && !pdrag.active);
    fm(document.body, 'mousemove', r0.left + 40, r0.top + 28);
    ok('pdrag: travel activates + ghost shows', pdrag.active && dragKind === 'spell' &&
      !!$('combo-strip').querySelector('.combo-new'));
    // the ghost strip appearing shifts the list — re-measure the target row
    // (the engine hit-tests LIVE rects every move; only the test cached one)
    const r1b = pdRows[1].getBoundingClientRect();
    fm(document.body, 'mousemove', r1b.left + 30, Math.floor(r1b.top + r1b.height / 2));
    ok('pdrag: hovered row highlighted', !!$('list').querySelector('.spell.combo-target'));
    fm(document.body, 'mouseup', r1b.left + 30, Math.floor(r1b.top + r1b.height / 2));
    ok('pdrag: drop merged a combo', state.combos.length === pdCombosBefore + 1);
    ok('pdrag: click suppression armed', pdrag.suppressClick === true);
    ok('pdrag: state cleared after drop', !pdrag.active && !pdrag.armed && dragKind === null &&
      !$('combo-strip').querySelector('.combo-new'));
    // sub-threshold press-release = plain click path (no drag, no suppression)
    fm(pdRows[0], 'mousedown', r0.left + 20, r0.top + 8);
    fm(document.body, 'mousemove', r0.left + 22, r0.top + 9);
    const stayedIdle = !pdrag.active;
    fm(document.body, 'mouseup', r0.left + 22, r0.top + 9);
    ok('pdrag: sub-threshold stays a click', stayedIdle && state.combos.length === pdCombosBefore + 1);
    state.combos.pop();               // leave state as the earlier suites expect
    renderCombos();
  } else {
    ok('pdrag: needs 2 rows to test', false);
  }

  // ---- extractor paths with backslashes / mixed case normalize on ingest ----
  window.mdIconIndex({ byForm: { 'A.esp|1': 'icons\\sh\\x\\y.png' }, generic: {}, catalog: [] });
  ok('sh: backslash + case normalized', resolveIconPath({ plugin: 'a.ESP', localId: 1 }) === 'icons/sh/x/y.png');
  window.mdIconIndex(DEV_ICON_INDEX);   // restore

  /* ---- panel size: XL defaults, drag-to-resize, clamps, reset, restore ----
   * Everything is asserted in PRE-scale layout px (getBoundingClientRect is
   * post-transform, so divide by the scale) — the same space the CSS vars,
   * the clamps and the saved config all live in. */
  const cssVar = (n) => document.documentElement.style.getPropertyValue(n);
  const cssPx = (n) => Math.round(parseFloat(cssVar(n)));
  const layoutW = () => $('panel').getBoundingClientRect().width / curScale();
  const layoutH = () => $('panel').getBoundingClientRect().height / curScale();
  const defW = () => Math.min(1500, (window.innerWidth * 0.94) / curScale());

  setScale(1.0); resetPanelSize();
  ok('panel: XL default is min(1500px, 94vw/scale)', Math.abs(layoutW() - defW()) <= 1);
  ok('panel: auto leaves the size vars unset', !cssVar('--panel-w') && !cssVar('--panel-h') &&
    state.panelW === 0 && state.panelH === 0 && payload().panelW === 0 && payload().panelH === 0);
  // the 1500px cap only bites when there is room for it: scale 0.6 buys
  // 94vw/0.6 of layout width, so the cap must win over the viewport there
  setScale(0.6);
  ok('panel: 1500px cap wins over 94vw at small scale', Math.abs(layoutW() - 1500) <= 1);
  setScale(1.0);

  // drag the grip: real mousedown -> mousemove -> mouseup, pulled INWARD so
  // the assertion isn't swallowed by the ceiling clamp on a small viewport
  const fire = (el, type, x, y) => el.dispatchEvent(new MouseEvent(type,
    { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  const s0 = curScale(), pr0 = $('panel').getBoundingClientRect();
  const w0 = pr0.width / s0, h0 = pr0.height / s0;
  fire($('resize-grip'), 'mousedown', pr0.right - 3, pr0.bottom - 3);
  ok('panel: grip mousedown arms the drag', document.body.classList.contains('resizing'));
  fire(document, 'mousemove', pr0.right - 60, pr0.bottom - 40);
  ok('panel: drag resizes by 2 × cursor delta ÷ scale',
    Math.abs(state.panelW - (w0 - 114 / s0)) <= 1 && Math.abs(state.panelH - (h0 - 74 / s0)) <= 1);
  ok('panel: drag writes --panel-w / --panel-h',
    cssPx('--panel-w') === state.panelW && cssPx('--panel-h') === state.panelH &&
    Math.abs(layoutW() - state.panelW) <= 1);
  fire(document, 'mouseup', pr0.right - 60, pr0.bottom - 40);
  ok('panel: drag ends clean and lands in the payload', !document.body.classList.contains('resizing') &&
    payload().panelW === state.panelW && payload().panelH === state.panelH && state.panelW > 0);

  setPanelSize(10, 10);
  ok('panel: clamp floor 720×560 (or the viewport, if smaller)',
    state.panelW === Math.min(PMIN_W, panelMax().w) && state.panelH === Math.min(PMIN_H, panelMax().h));
  setPanelSize(99999, 99999);
  const mx1 = panelMax();
  ok('panel: clamp ceiling 96vw/94vh ÷ scale', state.panelW === mx1.w && state.panelH === mx1.h);
  // scale x resize interplay: state keeps the big number, the VAR re-clamps
  setScale(1.4);
  ok('panel: growing the scale re-clamps the var, not the saved size',
    panelMax().w < mx1.w && cssPx('--panel-w') === panelMax().w && state.panelW === mx1.w);
  setScale(1.0);
  ok('panel: shrinking the scale restores the full saved size', cssPx('--panel-w') === mx1.w);

  resetPanelSize();
  ok('panel: reset returns to 0/0 and clears the vars',
    state.panelW === 0 && state.panelH === 0 && !cssVar('--panel-w') && !cssVar('--panel-h') &&
    payload().panelW === 0 && Math.abs(layoutW() - defW()) <= 1);

  // mdOpen restore: an in-range width comes back verbatim, an oversized height
  // is clamped for THIS screen while the saved value survives in state
  const restW = Math.max(PMIN_W, panelMax().w - 120), restH = panelMax().h + 200;
  window.mdOpen(Object.assign({}, SAMPLE_CFG, { panelW: restW, panelH: restH }));
  ok('panel: mdOpen restores a saved size', state.panelW === restW && cssPx('--panel-w') === restW &&
    Math.abs(layoutW() - restW) <= 1);
  ok('panel: an oversized saved size clamps on screen but survives in state',
    state.panelH === restH && cssPx('--panel-h') === panelMax().h);
  ok('panel: half-set size falls back to auto',
    (normalizeConfig({ panelW: 1200 }), state.panelW === 0 && state.panelH === 0));
  window.mdOpen(SAMPLE_CFG);   // leave the view at its default size

  const pass = results.filter((r) => r.pass).length;
  window.__selftest = { pass, total: results.length, results };
  console.log('[selftest] ' + pass + '/' + results.length, results.filter((r) => !r.pass));
  toast('Self-test ' + pass + '/' + results.length);
}
