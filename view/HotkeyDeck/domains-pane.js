'use strict';

/* ====================================================================== *
 *  Domains — Mark & Recall, a tab pane inside the Hotkey Deck view.
 *
 *  Mark where you are standing; click it later to travel back. Categories
 *  (Estates / Cities / Dungeons / …) are freeform and user-editable.
 *
 *  Self-contained by design: the pane owns its own state, its own DOM
 *  (every id dm- prefixed), its own capture modal and its own document
 *  listeners. It never reads or writes app.js's `state` / `ui`, so the two
 *  can be edited independently.
 *
 *  Data is VIEW-OWNED (like the Spell Deck's spells, unlike the Follower
 *  Deck's roster): the pane mutates its model and pushes the whole slice
 *  back through a debounced pdSave; C++ parses it into the "domains" config
 *  slice and PersistAll()s. The only things C++ owns are the location
 *  snapshot and the teleport itself.
 *
 *  Bridge — C++ registers these JS→C++ listeners on the DECK view:
 *    pdMark(json) · pdRecall(json) · pdSave(json) · pdRefresh() ·
 *    pdClose() · pdLog(str) · pdCapture("1"|"0")
 *  C++ calls into us:
 *    pdOpen(cfg) · pdHere(loc) · pdMarked(mark) · pdSaved(ok) · pdShow()
 *  Request and response names stay disjoint — PrismaUI installs each JS
 *  listener as a global of that name, so a shared name clobbers the handler.
 *
 *  Host contract (see src/domains-wiring.md):
 *    DomainsPane.init() · onShow() · onHide() · receive(fn, payload) ·
 *    wantsPause() -> true
 * ====================================================================== */

window.DomainsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const ALL = '\u0000all';          // rail sentinel: "every category"
  const DEFAULT_CATS = ['Estates', 'Cities', 'Dungeons', 'Wilderness'];
  const SAVE_DEBOUNCE = 350;        // same cadence as the Spell Deck's mdSave

  /* Edit-mode size sliders (see buildScaleControls). Both persist through the
     uiScale / thumbSize round-trip and drive a CSS var, mirroring the Followers
     tab's --fd-ui-scale. */
  const UI_MIN = 0.7, UI_MAX = 1.6;    // whole-pane scale bounds
  const TH_MIN = 0.7, TH_MAX = 2.0;    // row-image scale bounds
  const SCALE_STEP = 0.05;

  /* Tags (see the tag block below). Both caps are mirrored in main.cpp
     kMaxTagsPerMark / kMaxTagLen — a hand-edited hotkeys.json is the one input
     this pane never sees, and an unbounded list would be re-rendered on every
     keystroke of the filter. */
  const TAG_MAX = 12;        // per domain
  const TAG_MAX_LEN = 28;    // characters, after normalisation

  /* Place-photo display crop (see the crop block below). Same numbers as
     followers-pane.js / wardrobe-pane.js, deliberately: the three editors feel
     identical because they ARE the same model. */
  const CROP_ZMIN = 1, CROP_ZMAX = 4;
  const CROP_ZSTEP = 1.15;    // multiplicative: one click feels the same at 1.1x and at 3x
  const CROP_PAN_STEP = 0.03; // per nudge click, in frame fractions
  const CROP_MAX_ENTRIES = 400;   // mirrored in wardrobe.h kMaxImageCrops

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }
  function glog(msg) { toGame('pdLog', msg); }

  /* ========================================================== key maps == */
  /* KeyboardEvent.code -> [DIK scancode, label]. Kept local: app.js's table is
     module-scope, and the pane must stand alone in the test harness. */

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
  const MOUSE = { 1: [2, 'Middle Mouse'], 3: [3, 'Mouse 4'], 4: [4, 'Mouse 5'] };
  const MODIFIER_CODES = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

  /* Ultralight may deliver key events without e.code — fall back to keyCode. */
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

  /* ============================================================= state == */

  const state = {
    openKey: { device: 'keyboard', code: 102, label: 'F15' },  // 102 = faithful F15 (extended F-key bridge)
    uiScale: 1.0,   // whole-pane scale (edit-mode "UI size" slider) -> --dm-ui-scale
    thumbSize: 1.0, // row-image / medallion scale (edit-mode "Image size" slider) -> --dm-thumb
    categories: [],
    marks: [],
    here: null,     // last pdHere snapshot: {ok,interior,cellName,…,suggested}
    npcs: [],       // last pdNpcs roster for the "Summon NPC here" picker
    /* Place-photo display crops: image FILE NAME -> {z,x,y}. C++-owned (it is
       the one that can see the domain-images/ folder and prune against it); it
       arrives inside the config and again as `pdCrops` after every save. Keyed
       by the FILE and never by the domain — see the crop block for why that is
       what makes double-cropping structurally impossible. */
    imageCrops: {},
  };

  const ui = {
    cat: ALL,
    editing: false,
    filter: '',
    sel: -1,
    capture: false,
    armDelCat: null,
    shown: false,
    inited: false,
    expanded: new Set(),   // parent ids whose sub-areas are open (NOT persisted)
    /* Click-to-filter by tag. Held FOLDED (lower case) because that is the
       matching form; the chip shows the spelling the matching domain carries.
       Separate from the search box on purpose — typing "inn" should still find
       a domain called "Inn of the Four Shields", while clicking the chip means
       exactly "tagged inn". */
    tagFilter: '',
    npcMark: null,         // mark the NPC picker will summon to
    npcFilter: '',
    npcLoading: false,
  };

  let dragKind = null, dragMarkId = null, dragCatFrom = -1;

  /* =========================================================== helpers == */

  const $ = (id) => document.getElementById(id);
  const els = {};

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

  /* text with the search term highlighted, as child nodes */
  function nameNodes(text, q) {
    text = String(text == null ? '' : text);
    if (!q) return [document.createTextNode(text)];
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [document.createTextNode(text)];
    return [
      document.createTextNode(text.slice(0, i)),
      h('mark', null, text.slice(i, i + q.length)),
      document.createTextNode(text.slice(i + q.length)),
    ];
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* Use the host page's toast when there is one (the deck has #toast); the
     standalone harness gets an identical fallback instead of a silent no-op. */
  let toastT = null;
  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = $('dm-toast');
      if (!t) { t = h('div', { id: 'dm-toast', class: 'hidden' }); document.body.append(t); }
    }
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.add('hidden'), 2100);
  }

  function coerce(x) {
    if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
    return x;
  }

  /* ------------------------------------------------- size scales (sliders) -- */

  function clampScale(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return 1;
    v = Math.round(v / SCALE_STEP) * SCALE_STEP;   // snap to the step
    v = Math.round(v * 100) / 100;                 // kill 1.05000000001 fuzz
    return Math.max(lo, Math.min(hi, v));
  }
  function clampUi(v) { return clampScale(v, UI_MIN, UI_MAX); }
  function clampThumb(v) { return clampScale(v, TH_MIN, TH_MAX); }

  /* Whole-pane scale: same contract as the Followers tab's --fd-ui-scale — a
     CSS var read by #dm-pane's transform + width/height compensation. */
  function applyDmUiScale() {
    const v = clampUi(state.uiScale);
    state.uiScale = v;
    document.documentElement.style.setProperty('--dm-ui-scale', String(v));
    if (els.uiVal) els.uiVal.textContent = Math.round(v * 100) + '%';
    if (els.uiRange && Number(els.uiRange.value) !== v) els.uiRange.value = String(v);
  }
  /* Row-image / medallion scale: drives --dm-thumb on the same root. */
  function applyDmThumb() {
    const v = clampThumb(state.thumbSize);
    state.thumbSize = v;
    document.documentElement.style.setProperty('--dm-thumb', String(v));
    if (els.thVal) els.thVal.textContent = Math.round(v * 100) + '%';
    if (els.thRange && Number(els.thRange.value) !== v) els.thRange.value = String(v);
  }

  /* ------------------------------------------------------------ saving -- */

  function payload() {
    return {
      openKey: { device: state.openKey.device, code: state.openKey.code >>> 0, label: state.openKey.label },
      uiScale: state.uiScale,
      thumbSize: state.thumbSize,
      categories: state.categories.slice(),
      marks: state.marks.map((m) => ({
        id: m.id, name: m.name, category: m.category, parentId: String(m.parentId || ''), note: m.note,
        /* ALWAYS sent, even when empty: C++ carries the previous value over for
           a mark object that OMITS the key (that is what protects a photo from
           an older view build), so omitting them here would make removing the
           last tag — or clearing a photo — impossible. */
        tags: (m.tags || []).slice(), image: String(m.image || ''),
        cellName: m.cellName, cellId: m.cellId >>> 0, cellEdid: m.cellEdid,
        worldspaceId: m.worldspaceId >>> 0, worldspaceName: m.worldspaceName,
        interior: !!m.interior, x: m.x, y: m.y, z: m.z, angleZ: m.angleZ,
      })),
    };
  }
  function save() { toGame('pdSave', JSON.stringify(payload())); }
  let saveT = null;
  function saveSoon() { if (saveT) clearTimeout(saveT); saveT = setTimeout(() => { saveT = null; save(); }, SAVE_DEBOUNCE); }
  function flushSave() { if (saveT) { clearTimeout(saveT); saveT = null; save(); } }

  /* ------------------------------------------------------ model helpers -- */

  function markById(id) { return state.marks.find((m) => m.id === id) || null; }

  /* ---- sub-area hierarchy (one level deep) ---------------------------- *
   * A mark's parentId is either '' (top-level domain) or the id of a
   * top-level mark. parentOf resolves it, so a child whose parent was
   * deleted degrades to a top-level stray rather than vanishing. */
  function parentOf(m) {
    if (!m || !m.parentId) return null;
    return state.marks.find((x) => x.id === m.parentId) || null;
  }
  function isChildMark(m) { return !!parentOf(m); }
  function childrenOf(id) { return state.marks.filter((m) => m.parentId === id); }
  function hasChildren(m) { return !!m && childrenOf(m.id).length > 0; }
  function topLevelMarks() { return state.marks.filter((m) => !isChildMark(m)); }

  /* Rail groups by TOP-LEVEL only — a sub-area lives under its parent, never
     as its own rail row, and never inflates a category's count. */
  function countIn(cat) { return state.marks.filter((m) => !isChildMark(m) && m.category === cat).length; }

  /* Break any 2-level nesting / dangling / self parent on load: a child whose
     "parent" is itself a child (or missing, or itself) is promoted to top level
     so the tree is always exactly one deep. */
  function sanitizeParents() {
    const byId = {};
    state.marks.forEach((m) => { byId[m.id] = m; });
    state.marks.forEach((m) => {
      if (!m.parentId) return;
      const p = byId[m.parentId];
      if (!p || p.id === m.id || p.parentId) m.parentId = '';
    });
  }

  function uniqueCat(base, exceptIdx) {
    base = (base || '').trim() || 'New Category';
    let name = base, n = 2;
    const taken = (nm) => state.categories.some((c, i) => i !== exceptIdx && c.toLowerCase() === nm.toLowerCase());
    while (taken(name)) name = base + ' ' + (n++);
    return name;
  }

  function initialsOf(name) {
    const parts = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '★';
    const a = [...parts[0]][0] || '?';
    const b = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : '';
    return (a + b).toUpperCase();
  }

  /* stable per-category hue so a category's domains read as a group */
  function hueOf(cat) {
    const s = String(cat || '');
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return s ? n : 45;
  }

  /* ============================================================== tags == *
   *  Free-form, his words — anything he types becomes a tag, so there is no
   *  fixed vocabulary to maintain and nothing to "manage". The whole feature
   *  is: chips on the row, a chip filters the list when clicked, and the
   *  search box already matches them (haystack() folds tags in).
   *
   *  NORMALISATION IS THE LOAD-BEARING PART. Without it "Inn", "inn " and
   *  "inn" are three different tags that render identically and filter
   *  differently, which reads as the feature being broken. So: trim, collapse
   *  inner whitespace, cap the length, and de-duplicate CASE-INSENSITIVELY
   *  while keeping the capitalisation he typed (the first spelling wins). The
   *  fold is for MATCHING only and is never stored.
   *
   *  Same rules in main.cpp NormalizeTag/NormalizeTags, because hotkeys.json is
   *  hand-editable and either side can be the last to touch the list. */

  function normTag(raw) {
    /* \s catches tab/newline as well as space; a control byte would draw as
       nothing and silently make two chips look identical. */
    let t = String(raw === undefined || raw === null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > TAG_MAX_LEN) t = t.slice(0, TAG_MAX_LEN).trim();
    return t;
  }
  function foldTag(t) { return normTag(t).toLowerCase(); }

  /* Fold `extra` into `base`, normalising and de-duplicating across BOTH, and
     stop at the cap. `base` is never mutated. Accepts a single string, an
     array, or junk — a hand-edited config with an object, a number or a nested
     array degrades to "no tags", never to a broken pane. */
  function mergeTags(base, extra) {
    const out = [], seen = Object.create(null);
    const push = (v) => {
      if (out.length >= TAG_MAX) return;
      if (typeof v !== 'string') return;
      const t = normTag(v);
      if (!t) return;
      const k = t.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(t);
    };
    (Array.isArray(base) ? base : []).forEach(push);
    if (typeof extra === 'string') push(extra);
    else if (Array.isArray(extra)) extra.forEach(push);
    return out;
  }

  function hasTag(m, folded) {
    if (!folded) return true;
    return (m.tags || []).some((t) => t.toLowerCase() === folded);
  }

  /* The display spelling of the currently filtered tag — taken from a domain
     that actually carries it, so the chip reads the way he typed it rather than
     folded. Falls back to the folded form if nothing carries it any more. */
  function tagFilterLabel() {
    const f = ui.tagFilter;
    if (!f) return '';
    for (let i = 0; i < state.marks.length; i++) {
      const hit = (state.marks[i].tags || []).find((t) => t.toLowerCase() === f);
      if (hit) return hit;
    }
    return f;
  }

  function setTagFilter(folded) {
    ui.tagFilter = folded || '';
    ui.sel = -1;
    render();
    if (ui.tagFilter) toast('Showing domains tagged “' + tagFilterLabel() + '”');
  }

  function addTagTo(m, raw) {
    const before = (m.tags || []).length;
    const next = mergeTags(m.tags, raw);
    if (next.length === before) {
      // Either it normalised to nothing, it is already there, or the cap is
      // full — say which, because silence reads as a broken input.
      const t = normTag(raw);
      if (t && before >= TAG_MAX) toast('That domain already has ' + TAG_MAX + ' tags');
      else if (t) toast('Already tagged “' + t + '”');
      return false;
    }
    m.tags = next;
    saveSoon(); renderList();
    return true;
  }

  function removeTagFrom(m, tag) {
    const f = foldTag(tag);
    const next = (m.tags || []).filter((t) => t.toLowerCase() !== f);
    if (next.length === (m.tags || []).length) return;
    m.tags = next;
    /* A filter pinned to a tag nothing carries any more would show an empty
       list with no obvious way back, so drop it the moment it goes stale. */
    if (ui.tagFilter === f && !state.marks.some((x) => hasTag(x, f))) ui.tagFilter = '';
    saveSoon(); render();
  }

  function placeOf(m) { return m.cellName || m.worldspaceName || m.cellEdid || 'Unknown place'; }
  function placeGlyph(m) { return m.interior ? '⌂' : '▲'; }
  function placeTitle(m) {
    const bits = [m.interior ? 'Interior' : 'Exterior', placeOf(m)];
    if (!m.interior && m.worldspaceName && m.worldspaceName !== placeOf(m)) bits.push(m.worldspaceName);
    bits.push(Math.round(m.x) + ' / ' + Math.round(m.y) + ' / ' + Math.round(m.z));
    return bits.join(' · ');
  }

  function haystack(m) {
    return (m.name + '\n' + m.note + '\n' + m.cellName + '\n' + m.worldspaceName + '\n' +
      m.cellEdid + '\n' + m.category + '\n' + (m.tags || []).join('\n')).toLowerCase();
  }

  /* The flattened list of rows actually rendered, in order: a top-level
     domain, optionally followed by its (visible) sub-areas. Each entry is a
     descriptor { m, child, hasKids, expanded } so keyboard nav, the count chip
     and the DOM all index the same sequence.

     Category filter is decided by the TOP-LEVEL parent (children inherit it for
     grouping). Search matches parent OR any child: a matched child forces its
     parent visible and expanded; a parent-only match shows the parent collapsed. */
  function visibleRows() {
    const q = ui.filter.trim().toLowerCase();
    /* The tag chip is a SECOND, independent narrowing — it ANDs with the search
       box and with the category rail rather than replacing either, so "tagged
       inn, in Cities, matching 'sol'" is expressible and no control silently
       cancels another. */
    const tf = ui.tagFilter;
    const hit = (m) => (!q || haystack(m).includes(q)) && hasTag(m, tf);
    const out = [];
    state.marks.forEach((p) => {
      if (isChildMark(p)) return;                          // rendered under its parent, not here
      if (ui.cat !== ALL && p.category !== ui.cat) return; // family filtered by the parent's category
      const kids = childrenOf(p.id);
      const pMatch = hit(p);
      let shownKids;
      if (q || tf) {
        shownKids = kids.filter(hit);
        if (!pMatch && shownKids.length === 0) return;     // neither the parent nor any child matches
      } else {
        shownKids = ui.expanded.has(p.id) ? kids : [];
      }
      const expanded = (q || tf) ? shownKids.length > 0 : ui.expanded.has(p.id);
      out.push({ m: p, child: false, hasKids: kids.length > 0, expanded: expanded });
      shownKids.forEach((c) => out.push({ m: c, child: true, hasKids: false, expanded: false }));
    });
    return out;
  }

  /* ==================================================== follower faces == *
   * Each top-level domain row shows the followers who LIVE there — and three
   * homes count, automatically: the Home field typed in the Followers tab,
   * NFF's assigned base, and My Home is Your Home's house (the last two are
   * read-only facts C++ pushes to the Followers pane with the roster, so a
   * follower you homed entirely in-game gets her face here with nothing
   * typed). The data is READ-ONLY and borrowed live from the Followers pane
   * (window.FolPane.rosterForDomains); we never own or write it. Everything
   * degrades to "no faces" if that pane is absent (the standalone harness) or
   * the roster is empty (Followers never opened), and never throws. */

  const FACE_CAP = 5;              // faces shown before the +N pill
  let facesRoster = [];            // this render's roster, refreshed once per renderList

  /* The homes ONE follower can be claimed by, in the order the face should
     credit them: what you typed beats what the mods say, and NFF's explicit
     base beats MHiYH's linked ref (the same rule the Followers home chip
     applies). `src` is the label the tooltip shows; the typed field gets none
     because it is your own words, not a mod's claim. */
  function homesOf(f) {
    const out = [];
    const push = (v, src) => {
      const s = (typeof v === 'string') ? v.trim() : '';
      if (s) out.push({ home: s, src: src });
    };
    push(f.home, '');
    push(f.nffHome, 'NFF');
    push(f.mhHome, 'MHiYH');
    return out;
  }

  /* Pull the roster once per list render (cheap, but rebuilding it per row is
     wasteful) and keep only people with at least one home to match against. */
  function refreshFacesRoster() {
    const fp = window.FolPane;
    if (!fp || typeof fp.rosterForDomains !== 'function') { facesRoster = []; return; }
    let r;
    try { r = fp.rosterForDomains(); } catch (e) { facesRoster = []; return; }
    facesRoster = Array.isArray(r)
      ? r.filter((f) => f && homesOf(f).length)
      : [];
  }

  /* Followers whose home matches this domain. Case-insensitive; a follower
     belongs if ANY of her homes equals the domain NAME or its PLACE, or if
     the name/place contains the home string (so Home "Proudspire Manor" matches
     a domain named "Proudspire Manor — throne room"). De-duped by formId (then
     name+home) so someone filed in two FO categories — or matched by two
     homes at once — only shows once, credited to the winning source. The
     match is attached as `hit` on a per-row copy, because the same person can
     legitimately live over two different domains (typed home here, MHiYH
     house there) and each face should say why SHE is on THIS row. */
  function followersForDomain(m) {
    if (!facesRoster.length) return [];
    const dn = String(m.name || '').trim().toLowerCase();
    const pl = String(m.cellName || m.worldspaceName || m.cellEdid || '').trim().toLowerCase();
    const out = [], seen = {};
    facesRoster.forEach((f) => {
      const hit = homesOf(f).find(({ home }) => {
        const hm = home.toLowerCase();
        return hm === dn || hm === pl ||
          (dn && dn.indexOf(hm) !== -1) || (pl && pl.indexOf(hm) !== -1);
      });
      if (!hit) return;
      const key = f.formId || (f.name + '|' + hit.home);
      if (seen[key]) return;
      seen[key] = true;
      out.push(Object.assign({}, f, { hit: hit }));
    });
    return out;
  }

  function faceInitials(f) {
    const el = h('span', { class: 'dm-face-medal' }, initialsOf(f.name));
    el.style.setProperty('--dm-hue', String(hueOf(f.name)));   // stable per-person hue
    return el;
  }

  function faceEl(f) {
    const name = String(f.name || '');
    // Why she is on this row: the matched home, credited to its source. The
    // typed field carries no label (your words need no attribution); the mods'
    // claims say which mod, so "wrong house" is debuggable from the hover.
    const homeLine = f.hit
      ? '⌂ ' + f.hit.home + (f.hit.src ? ' · ' + f.hit.src : '')
      : '';
    const face = h('span', {
      class: 'dm-face' + (f.portraitUrl ? ' zoom' : ''),
      title: name + (homeLine ? ' — ' + homeLine : '') +
             (f.portraitUrl ? ' — click to enlarge' : ''),
      // A face is not the row: never travel, never arm a row-drag from it.
      // With a photo behind it, the click opens that photo full size instead.
      onClick: (e) => { e.stopPropagation(); if (f.portraitUrl) openFaceLightbox(f); },
      onMousedown: (e) => e.stopPropagation(),
    });
    if (f.portraitUrl) {
      const img = h('img', { class: 'dm-face-img', src: f.portraitUrl, alt: '', draggable: 'false' });
      // Same query-hostile-loader dance the Followers medallion needs: retry the
      // plain path once, then fall back to the initials medal.
      let retried = false;
      img.addEventListener('error', function () {
        const q = f.portraitUrl.indexOf('?');
        if (!retried && q !== -1) { retried = true; img.src = f.portraitUrl.slice(0, q); return; }
        if (img.parentNode) img.parentNode.replaceChild(faceInitials(f), img);
      });
      face.append(img);
    } else {
      face.append(faceInitials(f));
    }
    // Hover text rides the title attribute alone: app.js's deck-wide #hd-tip
    // bubble draws it, clamped inside the screen. This pane used to hand-build
    // its own absolutely-positioned label here (it PREDATES #hd-tip — that
    // generalisation was copied from this very element), but on the card
    // layout the row clips its children (overflow:hidden for the rounded
    // hero), so the old label rendered as a cut-off fragment while #hd-tip
    // drew the same words anyway. One mechanism, no clipping.
    return face;
  }

  /* The cluster for one top-level row, or null when nobody matches. */
  function faceCluster(m) {
    const people = followersForDomain(m);
    if (!people.length) return null;
    const wrap = h('div', { class: 'dm-faces' });
    people.slice(0, FACE_CAP).forEach((f) => wrap.append(faceEl(f)));
    const extra = people.length - FACE_CAP;
    if (extra > 0) {
      wrap.append(h('span', {
        class: 'dm-face-more',
        title: extra + ' more assigned here',
      }, '+' + extra));
    }
    return wrap;
  }

  /* ---- clicking a face opens the FOLLOWERS pane's portrait lightbox -------
   * "on domains if i click the image can it do a lightbox of the image."
   *
   * We deliberately do NOT grow a second portrait viewer here. The Followers
   * tab already owns one, and — more importantly — it owns the CROP that
   * decides how every face is framed. A private copy on this tab would be a
   * second source of truth for the same photo, so a framing adjusted here and
   * the same face over there would disagree. Borrow theirs through the two
   * seams it already exports; when that pane is absent (the standalone
   * domains harness) the click simply does nothing rather than throwing
   * inside a row handler.
   *
   * Whatever we open, we are responsible for closing: the overlay hangs off
   * document.body, so hiding this tab does not hide it — the same law that
   * gave closeArt() its comment. */
  function folLbEl() { return document.querySelector('.fd-lb'); }

  function closeFolLb() {
    const fp = window.FolPane;
    if (fp && typeof fp._closeLightbox === 'function') {
      try { fp._closeLightbox(); } catch (e) { /* fall through to the removal */ }
    }
    /* Belt and braces. If FolPane vanished between open and close its node is
       still on the page, still full-screen, and still eating every click. */
    const el = folLbEl();
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /* "portraits/lydia~2.png?v=1712" -> { slug, file, ext, mtime }. The fallback
     for a face portraitInfoFor cannot resolve; the lightbox needs `slug` only
     to be non-empty, and `file` to be exactly right (it keys the crop). */
  function lbInfoFromUrl(url) {
    const s = String(url || '');
    if (!s) return null;
    const q = s.indexOf('?');
    const path = q === -1 ? s : s.slice(0, q);
    const mt = q === -1 ? null : /(?:^|&)v=(\d+)/.exec(s.slice(q + 1));
    const file = path.slice(path.lastIndexOf('/') + 1);
    /* The lightbox rebuilds the src as 'portraits/' + file, so anything that
       is not a plain sibling file name — a data: URI, an absolute URL — cannot
       be turned into one. Refusing here is what makes the caller fall back to
       "the click does nothing" instead of opening a broken image. Same rule,
       and the same reason, as cropKeyOf. */
    if (!file || file.indexOf(':') !== -1 || file.indexOf('.') === -1) return null;
    const dot = file.lastIndexOf('.');
    const ext = dot === -1 ? 'png' : file.slice(dot + 1);
    const stem = dot === -1 ? file : file.slice(0, dot);
    return {
      slug: stem.split('~')[0] || stem,   // a re-capture lands as <slug>~2.png
      file: file, ext: ext, mtime: mt ? Number(mt[1]) : 0,
    };
  }

  /* Open the big view of ONE follower's portrait. `who` is whatever the caller
     already holds — { name, formId?, original?, portraitUrl? } — and either
     seam alone is enough. Returns true only when a lightbox really opened, so
     a caller never reports success for a click that did nothing. */
  function openFaceLightbox(who) {
    const fp = window.FolPane;
    if (!fp || typeof fp._openLightbox !== 'function' || !who) return false;
    let info = null;
    if (typeof fp.portraitInfoFor === 'function') {
      try {
        info = fp.portraitInfoFor({ formId: who.formId, name: who.name, original: who.original });
      } catch (e) { info = null; }
    }
    if (!info || !info.slug) info = lbInfoFromUrl(who.portraitUrl);
    if (!info || !info.slug) return false;
    closeArt();                       // never stack two full-screen overlays
    try {
      fp._openLightbox({
        slug: info.slug, file: info.file, ext: info.ext, mtime: info.mtime,
        name: String(who.name || ''),
      });
    } catch (e) { return false; }
    return !!folLbEl();
  }

  /* ==================================================== row thumbnails == *
   * A domain may ship an image at domain-images/<id>.<ext>; markRow renders it
   * in place of the initials medallion, same round footprint, obeying
   * --dm-thumb (the edit-mode "Image size" slider). Convention-based: a bare
   * <img> that tries the extensions in turn and falls back to the medal on the
   * last error — NO index, NO bridge, NO C++. The harness has no domain-images
   * dir, so every row falls back cleanly.
   *
   * `noImage` is an in-session negative cache of ids whose every extension
   * 404'd, so a re-render of an imageless domain never re-attempts 4 loads. It
   * is cleared on onCfg / onShow so a file added mid-session is retried. */

  const IMG_DIR = 'domain-images/';
  const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
  const noImage = new Set();
  const TEST_IMG = Object.create(null);   // selftest seam: id -> loadable data URI

  /* A photographed domain carries its file on the MARK (`m.image`, written by
     C++ when photo mode lands — the palette is closed while the camera is in
     your hands, so the view can never be the one to attach it). That candidate
     comes FIRST; the old `domain-images/<id>.<ext>` convention stays behind it
     so a picture hand-dropped into the folder still works. */
  function imgCandidates(m) {
    const out = [];
    if (TEST_IMG[m.id]) out.push(TEST_IMG[m.id]);
    if (m.image) out.push(String(m.image));
    IMG_EXTS.forEach((ext) => out.push(IMG_DIR + encodeURIComponent(m.id) + '.' + ext));
    return out;
  }

  function medalFor(m) {
    const medal = h('span', {
      class: 'dm-medal ' + (m.interior ? 'interior' : 'exterior'),
      title: m.interior ? 'Interior' : 'Exterior',
    }, initialsOf(m.name));
    medal.style.setProperty('--dm-hue', String(hueOf(m.category)));
    return medal;
  }

  /* The row's leading avatar.
   *
   * A BOX plus an inner layer, not a bare <img>: the box owns the size, the
   * round mask and the hue border, and the `.dm-art` child owns the picture and
   * the CROP TRANSFORM. Transforming the image itself would scale its own clip
   * and border with it and shoulder the row apart — the portrait and wardrobe
   * work both hit exactly that and both had to grow a wrapper.
   *
   * The extension walk survives as a hidden 1px probe <img>, because a
   * background-image cannot report a 404 and the negative cache is what stops
   * an imageless domain re-attempting four loads on every render. */
  function thumbFor(m, isChild) {
    if (noImage.has(m.id) && !m.image) return medalFor(m);
    const srcs = imgCandidates(m);
    /* Two shapes, one function. A CHILD row keeps the small circle, and the
       circle keeps being its own click target: clicking it enlarges. A
       TOP-LEVEL card's hero is most of the card, and the card is a TRAVEL
       button — so the hero click falls through to the row, and the enlarge
       affordance moves to a ⛶ button in the hero's corner. Right-click ▸
       View photo still works everywhere, and is still the only route for the
       initials medal, which has no photo to show.
       ⚠ Affordances are added by the probe's LOAD handler, never here. A box
       is built for every row before anything is known to exist — an imageless
       domain renders one until the extension walk fails — so promising "click
       to enlarge" at construction would promise it on rows that have nothing
       to show, and the click would answer with "No photo yet". */
    const place = m.interior ? 'Interior' : 'Exterior';
    let loadedSrc = '';
    const box = h('span', {
      class: 'dm-thumb-box ' + (m.interior ? 'interior' : 'exterior'),
      title: place,
    });
    if (isChild) {
      box.addEventListener('click', (e) => {
        if (!loadedSrc) return;        // nothing drawn yet: the row keeps the click
        e.stopPropagation();
        openArt(m, false, m.image || loadedSrc);
      });
      box.addEventListener('mousedown', (e) => e.stopPropagation());   // never arm a row-drag from the circle
    }
    box.style.setProperty('--dm-hue', String(hueOf(m.category)));
    const art = h('div', { class: 'dm-art', 'aria-hidden': 'true' });
    box.append(art);

    /* Opacity 0 rather than display:none — a display:none image is not
       guaranteed to be fetched, and the whole point of this element is that it
       fetches and then tells us whether it worked. */
    const probe = h('img', { class: 'dm-probe', alt: '', 'aria-hidden': 'true', draggable: 'false' });
    let i = 0, current = '';
    const tryNext = () => {
      if (i >= srcs.length) {                       // every candidate failed
        noImage.add(m.id);
        if (box.parentNode) box.parentNode.replaceChild(medalFor(m), box);
        return;
      }
      current = srcs[i++];
      probe.src = current;
    };
    probe.addEventListener('error', tryNext);
    probe.addEventListener('load', function () {
      /* The crop is keyed by the PHOTO's file name. When a photo is attached
         that file IS m.image and it is the candidate that just loaded; the
         `<id>.<ext>` convention only ever wins when no photo is attached, and
         then the loaded candidate names itself. Passing both makes the harness
         able to feed a data URI as the pixels while still keying the crop by a
         real file name. */
      loadedSrc = probe.getAttribute('src') || current;
      /* There really is a picture here now — only now does the enlarge
         affordance appear ('zoom' on the element that owns the click). */
      box.classList.add('zoom');
      if (isChild) {
        box.title = place + ' — click to enlarge';
      } else {
        box.append(h('button', {
          class: 'dm-zoomer', title: 'View photo — click to enlarge',
          onClick: (e) => { e.stopPropagation(); openArt(m, false, m.image || loadedSrc); },
          // left only: a right-mousedown must still reach the row (that is how
          // the in-game context menu opens — Ultralight drops `contextmenu`)
          onMousedown: (e) => { if (e.button === 0) e.stopPropagation(); },
        }, '⛶'));
      }
      setArt(art, loadedSrc, m.image || current);
      if (probe.parentNode) probe.parentNode.removeChild(probe);   // its job is done
    });
    box.append(probe);
    tryNext();                                       // kick off with the first candidate
    return box;
  }

  /* ============================== place photo crop (WYSIWYG) =========== *
   *  The third of these in the deck — followers-pane.js crops a FACE and
   *  wardrobe-pane.js crops an OUTFIT; this crops a PLACE. Same model, same
   *  invariant, same reasons; what follows is only what is different here.
   *
   *  WHY A CROP AT ALL. Photo mode hands you a free camera over a live 3D
   *  scene, and the row draws the result in a ~30px CIRCLE. A landscape that
   *  read beautifully while flying becomes "a wall and some sky" once it is
   *  cover-fitted into that medallion. The plugin cannot re-cut the pixels
   *  (portrait_capture.cpp ships a hand-rolled PNG ENCODER and no decoder), so
   *  this pans/zooms the picture the deck already draws and remembers the
   *  numbers. The preview is not a preview — it IS the result.
   *
   *  THE MODEL, { z, x, y }: z is the display zoom (1 = the whole cover-fitted
   *  frame); x/y are the pan as FRACTIONS of the frame's own width/height, so
   *  ONE crop is right on a 23px child medallion, a 60px enlarged row and the
   *  big editor alike. The invariant |x|,|y| <= (z-1)/2 is the slack the zoom
   *  creates; it holds per-axis whatever the aspect, because a percentage
   *  translate resolves against the element's OWN box. Enforced in clampCrop()
   *  here and in Wardrobe::ClampImageCrop() there (the Domains slice reuses
   *  that type deliberately — a second copy of the clamp is how the two would
   *  drift).
   *
   *  THE EDITOR FRAME IS SQUARE because the row medallion is. The whole promise
   *  is that what you frame here is what the row draws, and that can only be
   *  true if both surfaces letterbox the picture identically; the circle is
   *  just a mask over the same square cover-fit.
   *
   *  IDENTITY IS THE IMAGE FILE NAME, never the domain id. Renaming or re-filing
   *  a domain keeps its framing, and a RE-SHOT photo — which lands as
   *  `<slug>~<unixtime>.png` whenever the renderer still has the old file mapped,
   *  and it does the moment the deck has drawn that row once — arrives under a
   *  name this map has never seen and is drawn AS SHOT. That is what makes
   *  double-cropping structurally impossible rather than merely unlikely.
   * ==================================================================== */

  function isIdentityCrop(c) { return !c || (c.z === 1 && c.x === 0 && c.y === 0); }

  /* The one place the invariant lives on this side. Returns a valid crop, or
     null for "nothing to apply" — an identity crop is deliberately NOT stored,
     so the map holds only pictures you actually re-framed. */
  function clampCrop(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
    let z = num(raw.z);
    if (!isFinite(z)) z = 1;
    z = Math.max(CROP_ZMIN, Math.min(CROP_ZMAX, z));
    const lim = (z - 1) / 2;
    let x = num(raw.x), y = num(raw.y);
    if (!isFinite(x)) x = 0;
    if (!isFinite(y)) y = 0;
    x = Math.max(-lim, Math.min(lim, x));
    y = Math.max(-lim, Math.min(lim, y));
    // Round to the precision the config stores, so a value that survives a
    // round trip through JSON compares equal to the one we sent.
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const c = { z: r4(z), x: r4(x), y: r4(y) };
    return isIdentityCrop(c) ? null : c;
  }

  /* `domain-images/pd-riverwood-m1.png?v=173…` -> `pd-riverwood-m1.png`.
     Anything that could name something other than a plain sibling inside
     domain-images/ yields '' and is therefore uncroppable rather than
     sanitised — the same rule C++ applies before it will store a key. */
  function cropKeyOf(image) {
    let s2 = String(image || '').trim();
    if (!s2) return '';
    const cut = s2.indexOf('?');
    if (cut !== -1) s2 = s2.slice(0, cut);
    const slash = Math.max(s2.lastIndexOf('/'), s2.lastIndexOf('\\'));
    if (slash !== -1) s2 = s2.slice(slash + 1);
    if (!s2 || s2 === '.' || s2 === '..' || s2.length > 160 || s2.indexOf(':') !== -1) return '';
    return s2;
  }

  function cropFor(image) {
    const k = cropKeyOf(image);
    return (k && state.imageCrops[k]) ? state.imageCrops[k] : null;
  }

  function cropTransform(c) {
    return 'translate(' + (c.x * 100).toFixed(3) + '%,' + (c.y * 100).toFixed(3) + '%) scale(' +
      c.z.toFixed(4) + ')';
  }

  /* THE one draw site. Every place the deck paints a domain photo goes through
     this, so a crop can never apply in the big view and not on the row. */
  function setArt(art, image, keyUrl) {
    if (!art) return art;
    const url = String(image || '');
    if (!url) return art;
    art.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
    applyArtCrop(art, cropFor(keyUrl === undefined ? url : keyUrl));
    return art;
  }

  function applyArtCrop(art, c) {
    if (!art) return;
    if (c) {
      art.style.transformOrigin = '50% 50%';
      art.style.transform = cropTransform(c);
    } else {
      art.style.transform = '';
    }
  }

  /* "180% · ↑12% ←4%" — the numbers as a human reads them, not as they are
     stored. Up/left are negative offsets; saying "y -0.12" out loud is how you
     end up nudging the wrong way twice. */
  function cropPhrase(c) {
    if (!c) return 'original framing';
    const parts = [Math.round(c.z * 100) + '%'];
    if (c.y) parts.push((c.y < 0 ? '↑' : '↓') + Math.round(Math.abs(c.y) * 100) + '%');
    if (c.x) parts.push((c.x < 0 ? '←' : '→') + Math.round(Math.abs(c.x) * 100) + '%');
    return parts.join(' · ');
  }

  /* Swallow a whole map from C++. Every value goes through the same clamp the
     editor uses and every key through the same file-name rule — the payload
     ultimately comes from hotkeys.json, which is hand-editable. The ceiling is
     applied on the way in so a bloated config cannot make every render walk a
     huge map. */
  function setCrops(src) {
    const map = {};
    let n = 0;
    Object.keys(src || {}).forEach((k) => {
      if (n >= CROP_MAX_ENTRIES) return;
      const key = cropKeyOf(k);
      if (!key || key !== k) return;      // keys are bare file names, not paths
      const c = clampCrop(src[k]);
      if (!c) return;
      map[key] = c;
      n++;
    });
    state.imageCrops = map;
  }

  /* ---- the large view + editor -----------------------------------------
     Built in JS and hung off document.body, not off #dm-pane. TWO reasons,
     both load-bearing: #dm-pane carries a CSS transform (the tab zoom), and the
     drag maths divides POINTER travel (screen px) by the frame's layout width —
     inside a scaled ancestor those two units differ and the pan gain would be
     silently wrong in game and right in the harness. And an overlay that
     outlives its pane is the classic way to end up with an unclickable deck, so
     every exit path goes through closeArt(). */
  let artBox = null;    // the overlay node, or null
  let artEdit = null;   // live edit state while editing, else null

  function closeArt() {
    if (!artBox) return;
    if (artEdit && artEdit.unwire) artEdit.unwire();
    if (artBox.parentNode) artBox.parentNode.removeChild(artBox);
    artBox = null;
    artEdit = null;
  }

  /* Sized in px by JS on purpose — see the drag comment above. Square, because
     the row medallion is. */
  function artFrameSize() {
    const w = window.innerWidth || 1280, hgt = window.innerHeight || 720;
    return Math.max(220, Math.round(Math.min(520, w * 0.72, hgt * 0.6)));
  }

  /* `m` is the domain the picture belongs to — its name is the caption, never
     the crop key. Opens showing; `startEditing` goes straight into the crop. */
  /* `url` overrides where the pixels come from, for the one case where the row
     is showing a picture the MARK does not name: the old
     `domain-images/<id>.<ext>` convention, whose file only the thumbnail's
     extension walk knows. Without it, clicking such a thumbnail would insist
     there is no photo while one is plainly on screen. The crop still keys off
     the file NAME either way (cropKeyOf strips the directory). */
  function openArt(m, startEditing, url0) {
    closeArt();
    closeFolLb();          // a face lightbox and a place lightbox must not stack
    if (!m) return;
    const url = String(url0 || m.image || '');
    if (!cropKeyOf(url)) { toast('No photo yet — right-click ▸ Photograph this place'); return; }
    const size = artFrameSize();
    const art = h('div', { class: 'dm-art' });
    const frame = h('div', { class: 'dm-art-frame' }, art);
    frame.style.width = size + 'px';
    frame.style.height = size + 'px';
    setArt(art, url);

    const foot = h('div', { class: 'dm-art-foot' });
    artBox = h('div', {
      class: 'dm-art-lb',
      /* Backdrop click closes — but ONLY while not editing. A pan that ends
         with the pointer outside the frame releases on the backdrop, and
         throwing the edit away for that would be indistinguishable from a bug. */
      onClick: function () { if (!artEdit) closeArt(); },
      title: 'Click anywhere to close',
    }, h('div', {
      class: 'dm-art-inner',
      onClick: function (e) { e.stopPropagation(); },
    }, frame, h('div', { class: 'dm-art-cap' }, String(m.name || '')), foot));
    document.body.append(artBox);

    artEdit = null;
    renderArtFoot(m, url, art, frame, foot);
    if (startEditing) beginCrop(m, url, art, frame, foot);
  }

  /* Not editing: one button, and the current framing spelled out so you can see
     at a glance whether this picture carries a crop at all. */
  function renderArtFoot(m, url, art, frame, foot) {
    foot.textContent = '';
    const c = cropFor(url);
    foot.append(h('button', {
      class: 'dm-art-btn', type: 'button',
      title: 'Pan and zoom this photo. Nothing is re-saved to disk — the deck '
           + 'remembers the framing and draws it everywhere this picture appears.',
      onClick: function (e) { e.stopPropagation(); beginCrop(m, url, art, frame, foot); },
    }, '✎ Adjust this photo'));
    foot.append(h('span', { class: 'dm-art-val' }, c ? cropPhrase(c) : 'original framing'));
  }

  /* Everything is a BUTTON or a drag: no <input type=range>, because in
     Ultralight it is a poor target. The wheel is a convenience only — every
     gesture it offers has a button beside it, so a click-only flow reaches
     every value. */
  function beginCrop(m, url, art, frame, foot) {
    const start = cropFor(url);
    artEdit = {
      url: url, z: start ? start.z : 1, x: start ? start.x : 0, y: start ? start.y : 0,
      /* Everything the keyboard path needs to finish the edit. artKey() sees
         only `artEdit`, and re-deriving these from the DOM would be a second,
         drift-prone way of naming the same nodes. */
      ctx: { m: m, url: url, art: art, frame: frame, foot: foot },
    };
    frame.classList.add('editing');
    renderCropFoot(m, url, art, frame, foot);
    wireCropGestures(art, frame, foot);
  }

  /* Apply artEdit to the on-screen picture WITHOUT re-rendering anything:
     rebuilding mid-gesture would replace the element the pointer is on and the
     drag would die on its first pixel. */
  function previewCrop(art, foot) {
    if (!artEdit) return;
    const c = clampCrop(artEdit);
    artEdit.z = c ? c.z : 1;
    artEdit.x = c ? c.x : 0;
    artEdit.y = c ? c.y : 0;
    applyArtCrop(art, c);
    const val = foot.querySelector('.dm-art-val');
    if (val) val.textContent = cropPhrase(c);
    const rst = foot.querySelector('.dm-art-reset');
    if (rst) rst.disabled = !c;
  }

  function nudgeCrop(art, foot, dz, dx, dy) {
    if (!artEdit) return;
    if (dz) artEdit.z = artEdit.z * dz;
    if (dx) artEdit.x = artEdit.x + dx;
    if (dy) artEdit.y = artEdit.y + dy;
    previewCrop(art, foot);
  }

  function renderCropFoot(m, url, art, frame, foot) {
    foot.textContent = '';
    const btn = (glyph, tip, fn, cls) => h('button', {
      class: 'dm-art-btn' + (cls ? ' ' + cls : ''), type: 'button', title: tip,
      onClick: function (e) { e.stopPropagation(); fn(); },
    }, glyph);

    const pad = h('div', { class: 'dm-art-pad' },
      btn('＋', 'Zoom in — closer on the place', () => nudgeCrop(art, foot, CROP_ZSTEP, 0, 0)),
      btn('－', 'Zoom out — more of the photo', () => nudgeCrop(art, foot, 1 / CROP_ZSTEP, 0, 0)),
      btn('◀', 'Move the photo left', () => nudgeCrop(art, foot, 0, -CROP_PAN_STEP, 0)),
      btn('▲', 'Move the photo up', () => nudgeCrop(art, foot, 0, 0, -CROP_PAN_STEP)),
      btn('▼', 'Move the photo down', () => nudgeCrop(art, foot, 0, 0, CROP_PAN_STEP)),
      btn('▶', 'Move the photo right', () => nudgeCrop(art, foot, 0, CROP_PAN_STEP, 0)),
    );

    const reset = btn('⟲ Reset', 'Back to the photo as it was taken',
      () => { artEdit.z = 1; artEdit.x = 0; artEdit.y = 0; previewCrop(art, foot); }, 'dm-art-reset');
    reset.disabled = !clampCrop(artEdit);

    foot.append(pad, reset,
      btn('✓ Save', 'Use this framing everywhere this picture is drawn',
        () => commitCrop(m, url, art, frame, foot), 'ok'),
      btn('✕ Cancel', 'Leave the framing as it was',
        () => cancelCrop(m, url, art, frame, foot)),
      h('span', { class: 'dm-art-val' }, cropPhrase(clampCrop(artEdit))),
      h('div', { class: 'dm-art-hint' },
        'Drag the photo to move it · wheel or ＋/－ to zoom · the row shows this '
        + 'square as a circle · the file on disk is untouched'));
  }

  function wireCropGestures(art, frame, foot) {
    let dragging = false, lastX = 0, lastY = 0;
    /* Gain: one pixel of pointer travel moves the picture one pixel, the only
       mapping that feels like dragging a photo. The frame is square, so both
       axes share a divisor — but they are read separately anyway, so a future
       non-square frame stays correct. */
    const fw = frame.offsetWidth || artFrameSize();
    const fh = frame.offsetHeight || artFrameSize();

    frame.addEventListener('mousedown', function (e) {
      if (!artEdit) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      frame.classList.add('dragging');
    });
    /* Listened on the DOCUMENT, not the frame: at high zoom the pointer leaves
       the frame long before the pan hits its limit, and a move handler bound to
       the frame would stop tracking exactly when the gesture gets interesting. */
    const onMove = function (e) {
      if (!dragging || !artEdit) return;
      artEdit.x += (e.clientX - lastX) / fw;
      artEdit.y += (e.clientY - lastY) / fh;
      lastX = e.clientX; lastY = e.clientY;
      previewCrop(art, foot);
    };
    const onUp = function () {
      if (!dragging) return;
      dragging = false;
      frame.classList.remove('dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    /* The listeners outlive the frame unless we take them off, and this overlay
       opens many times a session. Hang the teardown off artEdit so every exit
       path (Save, Cancel, Esc, tab change) runs it exactly once. */
    artEdit.unwire = function () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    frame.addEventListener('wheel', function (e) {
      if (!artEdit) return;
      e.preventDefault(); e.stopPropagation();
      nudgeCrop(art, foot, e.deltaY < 0 ? CROP_ZSTEP : 1 / CROP_ZSTEP, 0, 0);
    });
  }

  function endCropMode(frame) {
    if (artEdit && artEdit.unwire) artEdit.unwire();
    artEdit = null;
    if (frame) frame.classList.remove('editing', 'dragging');
  }

  function cancelCrop(m, url, art, frame, foot) {
    endCropMode(frame);
    applyArtCrop(art, cropFor(url));       // back to whatever is stored
    renderArtFoot(m, url, art, frame, foot);
  }

  function commitCrop(m, url, art, frame, foot) {
    const c = clampCrop(artEdit);
    const key = cropKeyOf(url);
    endCropMode(frame);
    if (!key) return;
    /* Optimistic: the map is updated here and every drawn row repaints now.
       C++ owns the file, so it will push the authoritative map back as
       `pdCrops` — including a prune we cannot compute here — and that wins. */
    if (c) state.imageCrops[key] = c;
    else delete state.imageCrops[key];
    /* `clear` rather than a z=1 crop, so C++ never has to decide whether an
       identity crop means "remove me" — the two are the same thing and saying
       it explicitly keeps the map free of rows that draw nothing. */
    toGame('pdCropSave', JSON.stringify(c
      ? { file: key, z: c.z, x: c.x, y: c.y }
      : { file: key, clear: true }));
    applyArtCrop(art, c);
    renderArtFoot(m, url, art, frame, foot);
    renderList();
    toast(c ? 'Framing saved' : 'Framing reset');
  }

  /* Arrows/±/Enter/Esc while the editor is up. Returns true when it owned the
     key — the pane's own keydown asks this FIRST, because '+' and '-' would
     otherwise be swallowed by "any printable key jumps to search". */
  function artKey(e) {
    if (!artBox) return false;
    if (!artEdit) {
      if (e.key === 'Escape') { closeArt(); return true; }
      return false;
    }
    const c = artEdit.ctx;
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (pan) { nudgeCrop(c.art, c.foot, 0, pan[0] * CROP_PAN_STEP, pan[1] * CROP_PAN_STEP); return true; }
    if (e.key === '+' || e.key === '=') { nudgeCrop(c.art, c.foot, CROP_ZSTEP, 0, 0); return true; }
    if (e.key === '-' || e.key === '_') { nudgeCrop(c.art, c.foot, 1 / CROP_ZSTEP, 0, 0); return true; }
    if (e.key === 'Enter') { commitCrop(c.m, c.url, c.art, c.frame, c.foot); return true; }
    if (e.key === 'Escape') { cancelCrop(c.m, c.url, c.art, c.frame, c.foot); return true; }
    return false;
  }

  /* Hand the player the camera. C++ closes the palette, waits for the HUD to
     redraw, then starts photo mode on THIS domain; the file it writes is
     attached to the mark C++-side, because the palette is gone by then and a
     push to a closed view is dropped. */
  function photographPlace(m) {
    closeCtx(); closeArt();
    /* The staged hour and sky ride WITH the request. C++ applies them just
       before it hands over the camera and puts them back when photo mode ends
       — however it ends — so a cancelled shot leaves the world as it found it.
       Both are omitted when nothing is chosen, which is exactly what every
       photo taken before this build did. */
    const req = { id: m.id };
    if (scene.hour >= 0) req.hour = scene.hour;
    if (scene.weather) req.weather = scene.weather;
    toGame('pdPhoto', JSON.stringify(req));
    toast(scene.hour >= 0 || scene.weather
      ? 'Setting the scene — E shoots, Esc cancels'
      : 'Pick your angle — E shoots, Esc cancels');
  }

  /* ======================================================= scene staging ==
   * "domain picture taking settings end up kinda dark or weather issues etc.
   *  maybe a button to set like weather or brightness / time of day?"
   *  — Rober, 2026-08-03.
   *
   * Three knobs, and they are three because they fix three DIFFERENT problems:
   *
   *   TIME     the sun is somewhere else. Changes the whole look of an
   *            exterior, and is the one that actually makes a keep at 3am
   *            photographable.
   *   SKY      it is raining on your castle. Forced for the length of the shot.
   *   EXPOSURE the place is dark because it IS dark — a cave, an interior with
   *            three candles. No hour and no sky fixes that, so this lifts the
   *            captured pixels instead, in camera stops.
   *
   * Time and sky are per-shot and self-restoring (C++ owns that). Exposure is
   * a persisted capture setting, so it lives in capture.ini beside the framing
   * and is written through pdSceneSet — one place for it, hand-editable, and
   * it survives a restart.
   *
   * Bridge: pdScene (ask) · pdSceneSet (write exposure) -> pdSceneInfo (both
   * answers). Two request names, ONE reply name — a reply sharing a request's
   * name silently unplugs the control.
   * ===================================================================== */

  const HOURS = [
    { h: 6,  label: 'Dawn',    glyph: '☀' },
    { h: 9,  label: 'Morning', glyph: '☀' },
    { h: 12, label: 'Noon',    glyph: '☀' },
    { h: 17, label: 'Golden',  glyph: '☀' },
    { h: 20, label: 'Dusk',    glyph: '☽' },
    { h: 0,  label: 'Night',   glyph: '☽' },
  ];
  /* Kind -> chip, in the order the engine's own flags are worth offering. The
     ids come from C++ (first weather of each kind in the load order), so a
     weather overhaul's skies are what these actually select. */
  const SKY_KINDS = [
    { key: 'clear',  label: 'Clear',  glyph: '☀' },
    { key: 'cloudy', label: 'Cloudy', glyph: '☁' },
    { key: 'rain',   label: 'Rain',   glyph: '☂' },
    { key: 'snow',   label: 'Snow',   glyph: '❄' },
  ];
  const EXP_STEP = 0.25;

  /* hour < 0 and weather 0 both mean "leave it alone" — the same convention
     C++ reads, so there is one definition of "unset". */
  const scene = { hour: -1, weather: 0, info: null };

  /* Asked on every menu open, not cached: the whole block is about what the
     world looks like RIGHT NOW, and an hour that went stale while you played
     would be worse than no reading at all. The last reply stays on screen
     until the new one lands, so the row never flickers back to "reading". */
  function askScene() { toGame('pdScene'); }

  function sceneExposure() {
    const v = scene.info && scene.info.exposure;
    return typeof v === 'number' ? v : 0;
  }

  function sceneExpMax() {
    const v = scene.info && scene.info.exposureMax;
    return typeof v === 'number' && v > 0 ? v : 3;
  }

  function setExposure(stops) {
    const max = sceneExpMax();
    const v = Math.max(-max, Math.min(max, Math.round(stops / EXP_STEP) * EXP_STEP));
    /* Optimistic: the row redraws now and C++ answers with the clamped truth
       from disk a beat later. Waiting for the round trip would make a stepper
       feel broken on a frame the game is busy. */
    if (scene.info) scene.info.exposure = v;
    toGame('pdSceneSet', JSON.stringify({ exposure: v }));
    return v;
  }

  function hourPhrase(h) {
    if (h < 0) return 'as it is';
    const whole = Math.floor(h), mins = Math.round((h - whole) * 60);
    const ampm = whole < 12 ? 'am' : 'pm';
    let hh = whole % 12; if (!hh) hh = 12;
    return hh + (mins ? ':' + (mins < 10 ? '0' : '') + mins : '') + ampm;
  }

  function expPhrase(v) {
    if (!v) return 'as rendered';
    return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace(/0$/, '') +
      ' stop' + (Math.abs(v) === 1 ? '' : 's');
  }

  /* The block that goes in a domain's right-click menu, right under the photo
     rows. Rebuilt in place on every change so the chips, the phrases and the
     stepper can never disagree with `scene`. */
  function sceneBlock() {
    const box = h('div', { class: 'dm-scene' });
    paintScene(box);
    return box;
  }

  function paintScene(box) {
    box.textContent = '';
    const info = scene.info;
    const presets = (info && info.presets) || {};

    box.append(h('div', { class: 'dm-scene-head' },
      h('span', { class: 'dm-scene-title' }, '✦ Scene for the photo'),
      h('span', {
        class: 'dm-scene-now',
        title: info ? 'What the world looks like right now' : 'Asking the game…',
      }, info
        ? hourPhrase(info.hour) + ' · ' + (info.weatherName || 'unknown sky')
        : 'reading the sky…')));

    // ---- time of day
    const timeRow = h('div', { class: 'dm-scene-row' },
      h('span', { class: 'dm-scene-lbl' }, 'Time'));
    timeRow.append(sceneChip('As-is', '○', scene.hour < 0,
      'Photograph at whatever time it is now', () => { scene.hour = -1; paintScene(box); }));
    HOURS.forEach((t) => timeRow.append(sceneChip(t.label, t.glyph, scene.hour === t.h,
      'Set the clock to ' + hourPhrase(t.h) + ' for the shot, then put it back',
      () => { scene.hour = t.h; paintScene(box); })));
    box.append(timeRow);

    // ---- sky
    const skyRow = h('div', { class: 'dm-scene-row' },
      h('span', { class: 'dm-scene-lbl' }, 'Sky'));
    skyRow.append(sceneChip('As-is', '○', !scene.weather,
      'Photograph in whatever weather is out there', () => { scene.weather = 0; paintScene(box); }));
    SKY_KINDS.forEach((k) => {
      const p = presets[k.key];
      skyRow.append(sceneChip(k.label, k.glyph, !!p && scene.weather === p.id,
        p ? 'Force ' + p.name + ' for the shot, then hand the sky back to the game'
          : 'This load order has no ' + k.label.toLowerCase() + ' weather',
        p ? () => { scene.weather = p.id; paintScene(box); } : null));
    });
    box.append(skyRow);

    // ---- exposure
    const v = sceneExposure();
    const expRow = h('div', { class: 'dm-scene-row' },
      h('span', { class: 'dm-scene-lbl' }, 'Bright'));
    expRow.append(sceneStep('−', 'Half a stop darker', () => {
      setExposure(sceneExposure() - EXP_STEP); paintScene(box);
    }));
    expRow.append(h('span', {
      class: 'dm-scene-val' + (v ? ' on' : ''),
      title: 'Exposure compensation applied to the captured picture, in camera '
           + 'stops. This is the one for a place that is dark because it IS '
           + 'dark — a cave will not brighten because you moved the sun.',
    }, expPhrase(v)));
    expRow.append(sceneStep('+', 'Half a stop brighter', () => {
      setExposure(sceneExposure() + EXP_STEP); paintScene(box);
    }));
    if (v) {
      expRow.append(sceneChip('Reset', '↺', false, 'Back to the frame as rendered',
        () => { setExposure(0); paintScene(box); }));
    }
    box.append(expRow);
  }

  function sceneChip(label, glyph, on, tip, onPick) {
    return h('button', {
      class: 'dm-scene-chip' + (on ? ' on' : '') + (onPick ? '' : ' off'),
      type: 'button', title: tip, disabled: onPick ? null : 'disabled',
      onClick: (e) => { e.stopPropagation(); if (onPick) onPick(); },
    }, h('span', { class: 'dm-scene-glyph' }, glyph), label);
  }

  function sceneStep(sym, tip, onPress) {
    return h('button', {
      class: 'dm-scene-step', type: 'button', title: tip,
      onClick: (e) => { e.stopPropagation(); onPress(); },
    }, sym);
  }

  function removePhoto(m) {
    if (!m.image) return;
    m.image = '';
    noImage.delete(m.id);   // the <id>.<ext> convention may still have one
    saveSoon(); renderList();
    toast('Photo removed from this domain');
  }

  /* ============================================================ render == */

  function render() { renderRail(); renderTagBar(); renderList(); renderFoot(); syncChrome(); }

  /* The active tag filter, as one dismissible pill above the list. Created
     lazily in JS rather than in domains-pane.html.frag, because the frag has to
     be pasted into index.html by hand and a bar that only exists while a tag is
     active is not worth a second file to keep in step. */
  function renderTagBar() {
    let bar = $('dm-tagbar');
    if (!bar) {
      if (!ui.tagFilter) return;                 // nothing to show, nothing to build
      bar = h('div', { id: 'dm-tagbar' });
      if (els.list && els.list.parentNode) els.list.parentNode.insertBefore(bar, els.list);
      else return;
    }
    bar.textContent = '';
    if (!ui.tagFilter) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.append(h('span', { class: 'dm-tagbar-lbl' }, 'Tagged'),
      h('button', {
        class: 'dm-tag on', type: 'button', title: 'Stop filtering by this tag',
        onClick: () => setTagFilter(''),
      }, tagFilterLabel(), h('span', { class: 'dm-tag-x' }, '✕')));
  }

  function syncChrome() {
    els.openkey.classList.toggle('hidden', !ui.editing);
    els.addCat.classList.toggle('hidden', !ui.editing);
    if (els.scaleBox) els.scaleBox.classList.toggle('hidden', !ui.editing);
    els.openkeyBtn.textContent = state.openKey.label || 'F15';
  }

  function railRow(cat, label, count, idx) {
    const isAll = cat === ALL;
    const selected = ui.cat === cat;

    if (ui.editing && !isAll) {
      const armed = ui.armDelCat === cat;
      return h('div', {
        class: 'dm-rail-item edit' + (selected ? ' sel' : ''),
        data: { cat: cat },
        // pointer-drag (Ultralight has no HTML5 DnD — engine lives in app.js)
        onMousedown: (e) => PDrag.arm(e, {
          onStart: () => { dragKind = 'cat'; dragCatFrom = idx; closeCtx(); },
          onMove: (ev) => pdScan(ev, [{ sel: '.dm-rail-item.edit', mode: 'ba', eligible: (el) => el.dataset.cat !== cat }]),
          onDrop: () => {
            const t = pdTake();
            dragKind = null;
            if (!t) { render(); return; }
            const toIdx = state.categories.indexOf(t.el.dataset.cat);
            if (toIdx < 0) { render(); return; }
            moveInArray(state.categories, dragCatFrom, t.after ? toIdx + 1 : toIdx);
            saveSoon(); render();
          },
          onCancel: () => { dragKind = null; render(); },
        }),
      },
        h('span', { class: 'dm-drag-h', title: 'Drag to reorder' }, '⋮⋮'),
        h('input', {
          class: 'dm-rail-rename', type: 'text', value: label, spellcheck: 'false',
          title: 'Rename this category',
          onFocus: () => { if (ui.cat !== cat) { ui.cat = cat; ui.sel = -1; renderList(); } },
          onChange: (e) => renameCategory(idx, e.target.value),
          onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
        }),
        h('button', {
          class: 'dm-icon-btn' + (armed ? ' confirm' : ''),
          title: armed ? 'Click again — its domains move to the first category'
                       : 'Remove this category (its domains are kept)',
          onClick: (e) => { e.stopPropagation(); deleteCategory(cat); },
        }, armed ? '✓?' : '🗑'),
      );
    }

    return h('div', {
      class: 'dm-rail-item' + (isAll ? ' all' : '') + (selected ? ' sel' : ''),
      data: { cat: cat }, tabindex: '0', role: 'button',
      onClick: () => { ui.cat = cat; ui.sel = -1; ui.armDelCat = null; render(); },
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.cat = cat; ui.sel = -1; render(); } },
      // (mark drops onto this row are hit-scanned by the mark row's PDrag.arm)
    },
      h('span', { class: 'dm-rail-name' }, isAll ? 'All domains' : label),
      h('span', { class: 'dm-rail-count' }, String(count)),
    );
  }

  function renderRail() {
    const rl = els.railList;
    rl.textContent = '';
    rl.append(railRow(ALL, 'All domains', topLevelMarks().length, -1));
    state.categories.forEach((c, i) => rl.append(railRow(c, c, countIn(c), i)));
    if (ui.cat !== ALL && state.categories.indexOf(ui.cat) === -1) ui.cat = ALL;
  }

  /* Tag chips for one row. Capped and then summarised as a +N pill — the same
     idiom the follower-face cluster uses — because .dm-sub is a single
     non-wrapping flex line and eight chips would either shove the note and the
     place chip out of the row or start a horizontal scrollbar. The pill's title
     names the ones it stands for, so nothing is unreachable. */
  const TAG_ROW_CAP = 4;

  function rowTags(m, q) {
    const tags = m.tags || [];
    if (!tags.length) return null;
    const wrap = h('span', { class: 'dm-tags' });
    tags.slice(0, TAG_ROW_CAP).forEach((t) => {
      const f = t.toLowerCase();
      const on = ui.tagFilter === f;
      wrap.append(h('span', {
        class: 'dm-tag' + (on ? ' on' : ''), role: 'button', tabindex: '-1',
        title: on ? 'Showing only domains tagged “' + t + '” — click to clear'
                  : 'Show only domains tagged “' + t + '”',
        // The row itself travels on click, so a tag must swallow both events —
        // and the mousedown as well, or PDrag arms a row-drag from the chip.
        onClick: (e) => { e.stopPropagation(); setTagFilter(on ? '' : f); },
        onMousedown: (e) => e.stopPropagation(),
      }, nameNodes(t, q)));
    });
    const extra = tags.length - TAG_ROW_CAP;
    if (extra > 0) {
      wrap.append(h('span', {
        class: 'dm-tag more', title: tags.slice(TAG_ROW_CAP).join(' · '),
        onClick: (e) => e.stopPropagation(),
        onMousedown: (e) => e.stopPropagation(),
      }, '+' + extra));
    }
    return wrap;
  }

  /* pdScan's before/after split is VERTICAL (shared with the vertical rails).
     Cards flow left→right, so re-cut the card it just marked by horizontal
     thirds: left = before, right = after, middle = nest-under (drop-into).
     Runs right after pdScan on every drag move; pdScan/pdTake still own the
     class cleanup, because they remove all three classes on leave/drop. */
  function cardBA(ev) {
    const el = els.list.querySelector('.dm-row.drop-before, .dm-row.drop-after, .dm-row.drop-into');
    if (!el || el.classList.contains('dm-child')) return;
    const r = el.getBoundingClientRect();
    const rel = r.width ? (ev.clientX - r.left) / r.width : 0.5;
    const before = rel <= 1 / 3, after = rel >= 2 / 3;
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-into', !before && !after);
  }

  function markRow(m, i, meta) {
    const q = ui.filter.trim();
    const isChild = !!(meta && meta.child);

    const sub = [];
    // The placeholder keeps its slot when hidden, so it stays short: a long one
    // would indent every noteless row's chips away from the ones above it.
    if (m.note) sub.push(h('span', { class: 'dm-note', title: m.note }, nameNodes(m.note, q)));
    else sub.push(h('span', { class: 'dm-note empty', title: 'Right-click to add a note' }, '＋ note'));
    sub.push(h('span', {
      class: 'dm-chip' + (m.interior ? '' : ' exterior'), title: placeTitle(m),
    }, placeGlyph(m) + ' ', nameNodes(placeOf(m), q)));
    if (ui.cat === ALL && m.category)
      sub.push(h('span', { class: 'dm-chip cat', title: 'Category' }, nameNodes(m.category, q)));
    const tagWrap = rowTags(m, q);
    if (tagWrap) sub.push(tagWrap);
    // Who is standing there right now, as faces. Nothing when nobody is.
    const whoEl = whoStrip(m);
    if (whoEl) sub.push(whoEl);

    // uploaded image when domain-images/<id>.<ext> exists, else the initials medal
    const thumb = thumbFor(m, isChild);

    // chevron column: a toggle when this top-level row has sub-areas, an
    // invisible spacer when it doesn't (so every parent medal stays aligned).
    let chevron = null;
    if (!isChild) {
      if (meta && meta.hasKids) {
        const open = !!meta.expanded;
        chevron = h('button', {
          class: 'dm-chev' + (open ? ' open' : ''),
          title: open ? 'Hide sub-areas' : 'Show sub-areas',
          'aria-expanded': open ? 'true' : 'false',
          onClick: (e) => { e.stopPropagation(); toggleExpand(m.id); },
          onMousedown: (e) => e.stopPropagation(),   // don't arm a row-drag from the chevron
        }, open ? '▾' : '▸');
      } else {
        chevron = h('span', { class: 'dm-chev spacer', 'aria-hidden': 'true' });
      }
    }

    return h('div', {
      class: 'dm-row' + (isChild ? ' dm-child' : '') + (i === ui.sel ? ' sel' : ''),
      role: 'option', data: { id: m.id },
      title: 'Travel to ' + m.name,
      onClick: () => recall(m),
      onContextmenu: (e) => { e.preventDefault(); (isChild ? openChildMenu : openMarkMenu)(m, e.clientX, e.clientY); },
      onMousedown: (e) => {
        // Ultralight does not reliably fire the DOM `contextmenu` event in-game,
        // so open the row menu from the right MOUSEDOWN too (that DOES reach the
        // view). Left button falls through to the pointer-drag arm below.
        if (e.button === 2) { e.preventDefault(); (isChild ? openChildMenu : openMarkMenu)(m, e.clientX, e.clientY); return; }
        return PDrag.arm(e, isChild ? {
        // a sub-area can only be dragged OUT: drop it on a category to move it
        // back to the top level, filed there.
        onStart: () => { dragKind = 'mark'; dragMarkId = m.id; closeCtx(); },
        onMove: (ev) => pdScan(ev, [
          { sel: '.dm-rail-item:not(.all):not(.edit)', mode: 'into', eligible: (el) => !!el.dataset.cat },
        ]),
        onDrop: () => {
          const t = pdTake();
          const id = dragMarkId;
          dragKind = null; dragMarkId = null;
          if (!t) { renderList(); return; }
          const cat = t.el.dataset.cat;
          const mk = markById(id);
          if (!mk) { render(); return; }
          mk.parentId = '';
          if (state.categories.indexOf(cat) !== -1) mk.category = cat;
          saveSoon(); render();
          toast('Moved out to ' + cat);
        },
        onCancel: () => { dragKind = null; dragMarkId = null; renderList(); },
      } : {
        // a top-level mark: drop on a category to re-file, on another top-level
        // row to nest (dropped over its middle) or reorder (dropped over an
        // edge). A completed drag swallows its click, so it never recalls.
        onStart: () => { dragKind = 'mark'; dragMarkId = m.id; closeCtx(); },
        onMove: (ev) => { pdScan(ev, [
          { sel: '.dm-rail-item:not(.all):not(.edit)', mode: 'into', eligible: (el) => !!el.dataset.cat },
          { sel: '.dm-row:not(.dm-child)', mode: 'ba', eligible: (el) => el.dataset.id !== m.id },
        ]); cardBA(ev); },
        onDrop: (e) => {
          const t = pdTake();
          const id = dragMarkId;
          dragKind = null; dragMarkId = null;
          if (!t) { renderList(); return; }
          if (t.mode === 'into') {              // dropped on the category rail
            const cat = t.el.dataset.cat;
            const mk = markById(id);
            if (!mk || (mk.category === cat && !mk.parentId)) { render(); return; }
            mk.category = cat; mk.parentId = '';
            saveSoon(); render();
            toast('Moved to ' + cat);
            return;
          }
          /* dropped on another top-level CARD — the grid flows left→right, so
             the split is horizontal: middle third nests under it, the side
             thirds reorder before/after (pdScan's own t.after is vertical and
             deliberately ignored here). */
          const target = markById(t.el.dataset.id);
          const r = t.el.getBoundingClientRect();
          const rel = r.width ? (e.clientX - r.left) / r.width : 0.5;
          if (target && !isChildMark(target) && rel > 1 / 3 && rel < 2 / 3) {
            setParent(id, target.id);          // over the middle → nest under it
          } else {
            reorderMark(id, t.el.dataset.id, rel >= 0.5);   // over a side edge → reorder
          }
        },
        onCancel: () => { dragKind = null; dragMarkId = null; renderList(); },
      }); },
    },
      chevron,
      thumb,
      h('div', { class: 'dm-body' },
        h('div', { class: 'dm-name' }, nameNodes(m.name, q)),
        h('div', { class: 'dm-sub' }, sub),
      ),
      // followers assigned here (Home field match) — top-level rows only
      isChild ? null : faceCluster(m),
      h('span', { class: 'dm-go', 'aria-hidden': 'true' }, '➤'),
    );
  }

  function renderList() {
    refreshFacesRoster();          // one roster pull for every row's face cluster
    const rows = visibleRows();
    els.count.textContent = String(rows.length);
    if (ui.sel >= rows.length) ui.sel = rows.length - 1;

    els.list.textContent = '';
    if (!rows.length) {
      els.list.classList.add('hidden');
      renderEmpty();
      return;
    }
    els.empty.classList.add('hidden');
    els.list.classList.remove('hidden');
    rows.forEach((r, i) => els.list.append(markRow(r.m, i, r)));
    if (ui.sel >= 0 && els.list.children[ui.sel]) els.list.children[ui.sel].scrollIntoView({ block: 'nearest' });
  }

  function renderEmpty() {
    const el = els.empty;
    el.classList.remove('hidden');
    el.textContent = '';
    const searching = !!ui.filter.trim();
    el.append(h('div', { class: 'empty-icon' }, searching ? '⌕' : '★'));
    if (searching) {
      el.append(h('div', { class: 'empty-title' }, 'No domain matches'));
      el.append(h('div', { class: 'empty-sub' },
        'Nothing matches “' + ui.filter.trim() + '” — names, notes, places and categories are all searched.'));
    } else if (ui.cat !== ALL) {
      el.append(h('div', { class: 'empty-title' }, '“' + ui.cat + '” is empty'));
      el.append(h('div', { class: 'empty-sub' },
        'Drag a domain onto it, pick it in a domain\'s Category menu, or stand somewhere and mark it below.'));
    } else {
      el.append(h('div', { class: 'empty-title' }, 'No domains marked yet'));
      el.append(h('div', { class: 'empty-sub' },
        'Walk somewhere worth keeping and press ★ Mark this spot. Estates, cities, dungeons — click one later to travel back.'));
    }
  }

  function renderFoot() {
    const btn = els.markBtn;
    const here = state.here;
    const hint = els.hereHint;
    if (here && here.ok) {
      btn.disabled = false;
      btn.textContent = '★ Mark “' + (here.suggested || 'this spot') + '”';
      btn.title = 'Save this spot as a domain — ' + (here.interior ? 'interior' : 'exterior');
      hint.textContent = (here.interior ? '⌂ ' : '▲ ') +
        (here.cellName || here.worldspaceName || here.cellEdid || 'unnamed cell');
      hint.classList.remove('hidden');
    } else {
      btn.disabled = true;
      btn.textContent = '★ Mark this spot';
      btn.title = (here && here.msg) || 'Waiting for your position…';
      hint.textContent = (here && here.msg) || 'Your position hasn\'t arrived yet — reopen the deck.';
      hint.classList.remove('hidden');
    }
  }

  /* ======================================================== mutations === */

  function recall(m) {
    closeCtx();
    const row = els.list.querySelector('.dm-row[data-id="' + cssEsc(m.id) + '"]');
    if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 400); }
    // Send the whole mark, not just its id: a domain marked seconds ago may
    // still be inside the save debounce, so C++ must not have to look it up.
    toGame('pdRecall', JSON.stringify({
      id: m.id, name: m.name, category: m.category,
      cellId: m.cellId >>> 0, cellEdid: m.cellEdid,
      worldspaceId: m.worldspaceId >>> 0, interior: !!m.interior,
      x: m.x, y: m.y, z: m.z, angleZ: m.angleZ,
      label: '➤ ' + m.name,
    }));
  }

  function renameMark(m, raw) {
    const name = (raw || '').trim();
    if (!name || name === m.name) { renderList(); return; }
    m.name = name;
    saveSoon(); renderList();
  }

  function setNote(m, raw) {
    const note = (raw || '').trim();
    if (note === m.note) return;
    m.note = note;
    saveSoon(); renderList();
  }

  function setCategory(m, cat) {
    if (state.categories.indexOf(cat) === -1 || m.category === cat) return;
    m.category = cat;
    saveSoon(); render();
  }

  function deleteMark(m) {
    const i = state.marks.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    // never silently destroy a marked spot: a parent's sub-areas are addresses
    // in their own right, so promote them to the top level rather than delete.
    const kids = childrenOf(m.id);
    kids.forEach((c) => { c.parentId = ''; });
    state.marks.splice(i, 1);
    ui.expanded.delete(m.id);
    saveSoon(); render();
    toast(kids.length
      ? 'Removed “' + m.name + '” — ' + kids.length + ' area' + (kids.length > 1 ? 's' : '') + ' kept at top level'
      : 'Removed “' + m.name + '”');
  }

  function toggleExpand(id) {
    if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id);
    renderList();
  }

  /* Nest a mark under a top-level parent ('' un-nests it). Guarded so the tree
     stays exactly one level deep and never forms a cycle. */
  function setParent(mOrId, parentId) {
    const m = typeof mOrId === 'string' ? markById(mOrId) : mOrId;
    if (!m) return;
    parentId = String(parentId || '');
    if (parentId) {
      if (parentId === m.id) return;
      if (hasChildren(m)) { toast('“' + m.name + '” has sub-areas — move those out first'); return; }
      const p = markById(parentId);
      if (!p || p.parentId) { toast('Can only nest under a top-level domain'); return; }
    }
    if (m.parentId === parentId) return;
    m.parentId = parentId;
    if (parentId) ui.expanded.add(parentId);   // reveal where it just went
    saveSoon(); render();
  }

  function moveInArray(arr, from, to) {
    if (from < 0 || from >= arr.length) return;
    const [m] = arr.splice(from, 1);
    if (to > from) to--;
    to = Math.max(0, Math.min(arr.length, to));
    arr.splice(to, 0, m);
  }

  function reorderMark(dragId, targetId, after) {
    if (!dragId || dragId === targetId) { renderList(); return; }
    const a = state.marks;
    const fi = a.findIndex((m) => m.id === dragId);
    if (fi < 0) { renderList(); return; }
    const [m] = a.splice(fi, 1);
    let ti = a.findIndex((x) => x.id === targetId);
    if (ti < 0) { a.splice(fi, 0, m); renderList(); return; }
    if (after) ti++;
    a.splice(ti, 0, m);
    saveSoon(); renderList();
  }

  function addCategory() {
    const name = uniqueCat('New Category', -1);
    state.categories.push(name);
    ui.cat = name; ui.sel = -1;
    saveSoon(); render();
    const inp = els.railList.querySelector('.dm-rail-item[data-cat="' + cssEsc(name) + '"] .dm-rail-rename');
    if (inp) { inp.focus(); inp.select(); }
  }

  function renameCategory(idx, raw) {
    const old = state.categories[idx];
    if (old === undefined) return;
    const name = uniqueCat(raw, idx);
    if (name === old) { renderRail(); return; }
    state.categories[idx] = name;
    state.marks.forEach((m) => { if (m.category === old) m.category = name; });
    if (ui.cat === old) ui.cat = name;
    if (ui.armDelCat === old) ui.armDelCat = null;
    saveSoon(); render();
  }

  /* A domain can't be re-marked without walking back there, so removing a
     category re-files its domains instead of deleting them. */
  function deleteCategory(cat) {
    if (ui.armDelCat !== cat) { ui.armDelCat = cat; renderRail(); return; }
    ui.armDelCat = null;
    const idx = state.categories.indexOf(cat);
    if (idx < 0) return;
    const moved = countIn(cat);
    state.categories.splice(idx, 1);
    const fallback = state.categories[0] || '';
    state.marks.forEach((m) => { if (m.category === cat) m.category = fallback; });
    if (ui.cat === cat) ui.cat = fallback || ALL;
    saveSoon(); render();
    toast(moved
      ? 'Removed “' + cat + '” — ' + moved + ' domain' + (moved > 1 ? 's' : '') + ' moved to ' + (fallback || 'no category')
      : 'Removed “' + cat + '”');
  }

  function markHere(category) {
    if (!state.here || !state.here.ok) { toast('No position to mark yet'); return; }
    toGame('pdMark', JSON.stringify({ name: state.here.suggested || 'New domain', category: category }));
  }

  /* ========================================================= ctx menu === */

  let ctxEl = null;
  function ctxHost() { return $('overlay') || document.body; }
  function ctxOutside(e) { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }
  function closeCtx() {
    if (!ctxEl) return;
    // Commit before removal. A focused input that leaves the DOM never fires
    // 'change', so closing the menu by click-away / Escape / scroll silently
    // DISCARDED a typed rename (2026-08-02, Rober: "seems to not save or
    // change when i type in name" — the config still held the auto names).
    // blur() while the input is still attached fires blur→change→commit.
    const ae = document.activeElement;
    if (ae && ctxEl.contains(ae) && ae.tagName === 'INPUT') ae.blur();
    if (!ctxEl) return;   // the blur handler chain may have closed us already
    ctxEl.remove(); ctxEl = null;
    document.removeEventListener('mousedown', ctxOutside, true);
  }
  function closeAllMenus() { closeCtx(); closeNpc(); }
  function clampEl(el, x, y) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let nx = x, ny = y;
    if (nx + r.width > vw - 6) nx = vw - r.width - 6;
    if (ny + r.height > vh - 6) ny = vh - r.height - 6;
    el.style.left = Math.max(6, nx) + 'px';
    el.style.top = Math.max(6, ny) + 'px';
  }
  function clampCtx(x, y) { clampEl(ctxEl, x, y); }
  /* A domain's own menu is a small FORM — name, note, tags, two pickers — not
     a three-item popup, so it is CENTRED on the screen rather than dropped at
     the pointer (Rober, 2026-08-03). At the pointer it landed half over the
     row it was editing, jumped position on every right-click, and near the
     bottom of the list it was shoved up against the footer. Centred it is
     always in the same place, always fully on screen, and the click that
     opened it is not underneath it. */
  function centerCtx() {
    const r = ctxEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    ctxEl.style.left = Math.max(6, Math.round((vw - r.width) / 2)) + 'px';
    ctxEl.style.top = Math.max(6, Math.round((vh - r.height) / 2)) + 'px';
  }
  function mountCtx(items, x, y, opts) {
    ctxEl = h('div', {
      id: 'dm-ctx', role: 'menu',
      class: (opts && opts.wide) ? 'wide' : null,
    }, items);
    ctxHost().append(ctxEl);
    if (opts && opts.center) centerCtx(); else clampCtx(x, y);
    setTimeout(() => document.addEventListener('mousedown', ctxOutside, true), 0);
  }

  function ctxItem(icon, label, on, opts) {
    return h('button', {
      class: 'dm-ctx-item' + ((opts && opts.danger) ? ' danger' : ''),
      title: (opts && opts.title) || null,
      onClick: (e) => { e.stopPropagation(); on(e); },
    }, h('span', { class: 'dm-ctx-check' }, icon), h('span', { class: 'dm-ctx-lbl' }, label));
  }

  /* Photo rows for a domain's menu — identical for a top-level domain and a
     sub-area, so both menus call this rather than growing two copies that
     drift. A domain with no photo offers only "Photograph", so the menu never
     shows an action that cannot do anything. */
  function photoItems(m) {
    const out = [ctxItem('\ud83d\udcf7', m.image ? 'Re-photograph this place' : 'Photograph this place',
      () => photographPlace(m),
      { title: 'Closes the deck and hands you a free camera \u2014 E shoots, Esc cancels' })];
    if (m.image) {
      out.push(ctxItem('\ud83d\uddbc', 'View photo', () => { closeCtx(); openArt(m, false); },
        { title: 'The full picture, big' }));
      out.push(ctxItem('\u26f6', cropFor(m.image) ? 'Re-frame photo\u2026' : 'Adjust photo framing\u2026',
        () => { closeCtx(); openArt(m, true); },
        { title: 'Pan and zoom how the row draws it \u2014 the file on disk is untouched' }));
      out.push(ctxItem('\ud83d\udeab', 'Remove photo', () => { closeCtx(); removePhoto(m); },
        { title: 'Back to the initials medallion. The file itself is left alone.' }));
    }
    /* Directly under "Photograph", because it is what you set BEFORE pressing
       it \u2014 the palette is gone the moment the camera is in your hands, so
       there is no adjusting the light once photo mode has started. */
    askScene();
    out.push(sceneBlock());
    return out;
  }

  /* The tag editor: chips with a \u2715, and one input that turns what you type
     into a tag on Enter or comma. No <select>, no prompt() \u2014 neither works in
     Ultralight. The chips repaint in place after each add, so they appear
     immediately without closing the menu. */
  /* Repaint one menu's tag chips in place. A free function, not a closure,
     because the window-capture Enter branch has the NODE but not the closure —
     and two copies of this loop would drift the moment a chip gains anything. */
  function repaintCtxTags(m, chips) {
    chips.textContent = '';
    (m.tags || []).forEach((t) => {
      chips.append(h('span', { class: 'dm-tag edit', title: t }, t,
        h('button', {
          class: 'dm-tag-x', type: 'button', title: 'Remove “' + t + '”',
          onClick: (e) => { e.stopPropagation(); removeTagFrom(m, t); repaintCtxTags(m, chips); },
        }, '✕')));
    });
    if (!(m.tags || []).length)
      chips.append(h('span', { class: 'dm-ctx-hint' }, 'No tags yet — type one below'));
  }

  /* ---- typable picker (the deck's combobox) -----------------------------
   * What replaced the three <select>s this menu used to carry: Category,
   * Nest under, and the sub-area's Reparent.
   *
   * TWO reasons, the first fatal. In Ultralight a <select> RENDERS but never
   * OPENS — the little arrow was a lie and all three controls were dead in
   * game, only ever usable in the browser harness. And the standing rule for
   * this deck is that anything you pick from is TYPABLE: filter as you type,
   * Enter takes the top hit (Rober, 2026-08-03: "category and nest under
   * should be typable"). With 20+ domains, "nest under" was unusable as a
   * list even if it had opened.
   *
   * The list is ABSOLUTELY positioned, so opening it lays over the rows below
   * instead of resizing the menu — the menu is centred and must not jump
   * under the pointer. It flips upward when the field sits low in the menu.
   *
   * ⚠ Enter / Escape / arrows arrive at the pane's WINDOW-CAPTURE keydown and
   * never reach the input (see the comment on onKey). The handlers are hung on
   * the input as `__pick` so that branch can drive this without knowing what
   * it is picking. */
  const PICK_LIST_MAX = 210;      // px; keep in step with .dm-pick-list max-height

  function pickerField(labelText, spec) {
    /* spec: { title, value, options: [{ value, label, hint }], onPick,
               placeholder, emptyText } */
    const opts = spec.options || [];
    const labelOf = (v) => {
      for (let i = 0; i < opts.length; i++) if (opts[i].value === v) return opts[i].label;
      return '';
    };
    const list = h('div', { class: 'dm-pick-list hidden', role: 'listbox' });
    let rows = [], hi = 0, isOpen = false;

    const input = h('input', {
      class: 'dm-ctx-input dm-pick-input', type: 'text', spellcheck: 'false',
      value: labelOf(spec.value), title: spec.title || null,
      onClick: (e) => { e.stopPropagation(); open(); },
      onFocus: () => open(),
      onInput: () => { if (!isOpen) open(); else paint(input.value); },
      /* Safety net only — a row click cannot blur us (its mousedown is
         prevented), and the menu's own close commits nothing here. */
      onBlur: () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120),
    });
    const caret = h('span', { class: 'dm-pick-caret', 'aria-hidden': 'true' }, '▾');
    const wrap = h('div', { class: 'dm-pick' }, input, caret, list);

    function paint(q) {
      const needle = String(q || '').trim().toLowerCase();
      rows = opts.filter((o) => !needle ||
        String(o.label).toLowerCase().indexOf(needle) !== -1 ||
        String(o.hint || '').toLowerCase().indexOf(needle) !== -1);
      hi = 0;
      /* Nothing typed: start on what is already chosen, so Enter is a no-op
         rather than a silent re-file to whatever sorts first. */
      if (!needle) {
        for (let i = 0; i < rows.length; i++) if (rows[i].value === spec.value) { hi = i; break; }
      }
      list.textContent = '';
      if (!rows.length) {
        list.append(h('div', { class: 'dm-pick-empty' },
          spec.emptyText || ('No match for “' + q + '”')));
        return;
      }
      rows.forEach((o, i) => {
        const row = h('button', {
          class: 'dm-pick-row' + (i === hi ? ' hi' : '') +
                 (o.value === spec.value ? ' cur' : ''),
          type: 'button', role: 'option', title: o.hint || o.label,
          // Prevent the mousedown so the input never loses focus and the list
          // never closes out from under the click that is choosing a row.
          onMousedown: (e) => { e.preventDefault(); e.stopPropagation(); },
          onClick: (e) => { e.stopPropagation(); choose(o); },
          onMouseenter: () => { hi = i; mark(); },
        },
          h('span', { class: 'dm-pick-tick' }, o.value === spec.value ? '✓' : ''),
          h('span', { class: 'dm-pick-lbl' }, nameNodes(o.label, needle)),
          o.hint ? h('span', { class: 'dm-pick-hint' }, o.hint) : null);
        list.append(row);
      });
      mark();
    }

    function mark() {
      const kids = list.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('hi', i === hi);
      const el = kids[hi];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      input.value = '';
      input.placeholder = labelOf(spec.value) || spec.placeholder || 'Type to filter…';
      /* Up or down: decided at open time against the MENU, because #dm-ctx
         scrolls and a list hanging past its bottom edge would be clipped. */
      const mr = ctxEl ? ctxEl.getBoundingClientRect() : null;
      const ir = input.getBoundingClientRect();
      wrap.classList.toggle('up', !!mr && (ir.bottom + PICK_LIST_MAX > mr.bottom) &&
        (ir.top - mr.top > mr.bottom - ir.bottom));
      list.classList.remove('hidden');
      paint('');
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      list.classList.add('hidden');
      input.value = labelOf(spec.value);
      input.placeholder = spec.placeholder || '';
    }

    function choose(o) {
      close();
      input.blur();
      spec.onPick(o.value);
    }

    /* The window-capture keydown drives these; see onKey. */
    input.__pick = {
      isOpen: () => isOpen,
      esc: () => { close(); input.blur(); },
      enter: () => { const o = rows[hi] || rows[0]; if (o) choose(o); else close(); },
      move: (d) => {
        if (!rows.length) return;
        hi = (hi + d + rows.length) % rows.length;
        mark();
      },
    };

    return h('div', { class: 'dm-ctx-field picker' }, h('label', null, labelText), wrap);
  }

  function tagField(m) {
    const box = h('div', { class: 'dm-ctx-field tags' }, h('label', null, 'Tags'));
    const chips = h('div', { class: 'dm-ctx-tags' });
    const paint = () => repaintCtxTags(m, chips);
    paint();
    const input = h('input', {
      class: 'dm-ctx-input tag', type: 'text', spellcheck: 'false',
      placeholder: 'add a tag, Enter to keep',
      onClick: (e) => e.stopPropagation(),
      /* A comma commits too: typing "inn, warm," is how people write lists, and
         waiting for Enter each time makes it feel broken. */
      onInput: (e) => {
        const v = e.target.value;
        if (v.indexOf(',') === -1) return;
        const parts = v.split(',');
        for (let i = 0; i < parts.length - 1; i++) if (normTag(parts[i])) addTagTo(m, parts[i]);
        e.target.value = parts[parts.length - 1];
        paint();
      },
      /* DEAD in-game \u2014 the pane's window-capture keydown owns Enter and blurs
         the field, which is why commitTagInput() is called from THERE too. Kept
         for the standalone harness, where nothing shields it. */
      onKeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (commitTagInput(m, e.target)) paint();
      },
    });
    /* Tagged with the domain id so the window-capture Enter branch can commit
       this field without knowing anything about this closure. */
    input.dataset.tagFor = m.id;
    box.append(chips, input);
    return box;
  }

  /* Turn whatever is in a tag input into a tag. Returns true if it changed
     anything. Shared by the field's own Enter (harness) and the pane's
     window-capture Enter (in game). */
  function commitTagInput(m, input) {
    if (!m || !input) return false;
    const raw = input.value;
    input.value = '';
    if (!normTag(raw)) return false;
    return addTagTo(m, raw);
  }

  function openMarkMenu(m, x, y) {
    closeCtx();
    const items = [];

    items.push(h('div', { class: 'dm-ctx-head', title: m.name }, m.name,
      h('span', { class: 'dm-ctx-where' }, placeGlyph(m) + ' ' + placeOf(m))));

    items.push(ctxItem('➤', 'Travel here', () => { closeCtx(); recall(m); },
      { title: 'Closes the deck and moves you there' }));
    items.push(ctxItem('☄', 'Summon NPC here…', (e) => {
      const r = ctxEl.getBoundingClientRect();
      openNpcPicker(m, r.left, r.top);
    }, { title: 'Move a nearby NPC or follower to this spot' }));
    photoItems(m).forEach((it) => items.push(it));

    items.push(h('div', { class: 'dm-ctx-sep' }));

    items.push(h('div', { class: 'dm-ctx-field' },
      h('label', null, 'Name'),
      h('input', {
        class: 'dm-ctx-input', type: 'text', value: m.name, spellcheck: 'false',
        placeholder: placeOf(m),
        onClick: (e) => e.stopPropagation(),
        // Live-commit each keystroke: the model always holds the typed text,
        // so no way of leaving the menu can lose it. onChange stays as the
        // trim/no-op gate on blur. (The field's own onKeydown is DEAD in-game
        // -- the pane's window-capture handler owns Enter; kept for the
        // standalone harness where no capture handler shields it.)
        onInput: (e) => renameMark(m, e.target.value),
        onChange: (e) => renameMark(m, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));
    items.push(h('div', { class: 'dm-ctx-field' },
      h('label', null, 'Note'),
      h('input', {
        class: 'dm-ctx-input note', type: 'text', value: m.note || '', spellcheck: 'false',
        placeholder: 'Why this place matters…',
        onClick: (e) => e.stopPropagation(),
        onInput: (e) => setNote(m, e.target.value),
        onChange: (e) => setNote(m, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));
    items.push(tagField(m));

    items.push(pickerField('Category', {
      title: 'Move to another category — type to filter, Enter takes the top hit',
      value: m.category,
      options: state.categories.map((c) => ({
        value: c, label: c, hint: countIn(c) ? String(countIn(c)) : '',
      })),
      placeholder: 'Type a category…',
      onPick: (v) => { closeCtx(); setCategory(m, v); },
    }));

    // Nest under… — file this domain as a sub-area of another top-level one.
    items.push(pickerField('Nest under', {
      title: 'Nest this domain under another as a sub-area',
      value: m.parentId || '',
      options: [{ value: '', label: '— Top level —', hint: '' }].concat(
        topLevelMarks().filter((p) => p.id !== m.id)
          .map((p) => ({ value: p.id, label: p.name, hint: p.category || '' }))),
      placeholder: 'Type a domain…',
      onPick: (v) => { closeCtx(); setParent(m, v); },
    }));

    let armed = false;
    const delLbl = h('span', { class: 'dm-ctx-lbl' }, 'Forget this domain');
    const delBtn = h('button', {
      class: 'dm-ctx-item danger',
      title: 'Only removes the entry — the place itself is untouched',
      onClick: (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; delBtn.classList.add('confirm'); delLbl.textContent = 'Forget — click again'; return; }
        closeCtx(); deleteMark(m);
      },
    }, h('span', { class: 'dm-ctx-check' }, '🗑'), delLbl);
    items.push(delBtn);

    /* Centred and wide: this is a form, not a three-item popup. */
    mountCtx(items, x, y, { center: true, wide: true });
  }

  /* Sub-area (child) menu: like the parent menu but no Category picker — a
     child is grouped under its parent's category. It gains "Move out to top
     level" and "Move to another domain…" in its place. */
  function openChildMenu(m, x, y) {
    closeCtx();
    const items = [];
    const parent = parentOf(m);

    items.push(h('div', { class: 'dm-ctx-head', title: m.name }, m.name,
      h('span', { class: 'dm-ctx-where' },
        (parent ? 'under ' + parent.name + ' · ' : '') + placeGlyph(m) + ' ' + placeOf(m))));

    items.push(ctxItem('➤', 'Travel here', () => { closeCtx(); recall(m); },
      { title: 'Closes the deck and moves you there' }));
    items.push(ctxItem('☄', 'Summon NPC here…', () => {
      const r = ctxEl.getBoundingClientRect();
      openNpcPicker(m, r.left, r.top);
    }, { title: 'Move a nearby NPC or follower to this spot' }));
    photoItems(m).forEach((it) => items.push(it));

    items.push(h('div', { class: 'dm-ctx-sep' }));

    items.push(h('div', { class: 'dm-ctx-field' },
      h('label', null, 'Name'),
      h('input', {
        class: 'dm-ctx-input', type: 'text', value: m.name, spellcheck: 'false',
        placeholder: placeOf(m),
        onClick: (e) => e.stopPropagation(),
        // Live-commit each keystroke: the model always holds the typed text,
        // so no way of leaving the menu can lose it. onChange stays as the
        // trim/no-op gate on blur. (The field's own onKeydown is DEAD in-game
        // -- the pane's window-capture handler owns Enter; kept for the
        // standalone harness where no capture handler shields it.)
        onInput: (e) => renameMark(m, e.target.value),
        onChange: (e) => renameMark(m, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));
    items.push(h('div', { class: 'dm-ctx-field' },
      h('label', null, 'Note'),
      h('input', {
        class: 'dm-ctx-input note', type: 'text', value: m.note || '', spellcheck: 'false',
        placeholder: 'Why this place matters…',
        onClick: (e) => e.stopPropagation(),
        onInput: (e) => setNote(m, e.target.value),
        onChange: (e) => setNote(m, e.target.value),
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      })));
    items.push(tagField(m));

    items.push(h('div', { class: 'dm-ctx-sep' }));

    items.push(ctxItem('⤴', 'Move out to top level', () => {
      closeCtx(); setParent(m, ''); toast('“' + m.name + '” moved to top level');
    }, { title: 'Un-nest this sub-area — it becomes its own domain' }));

    items.push(pickerField('Reparent', {
      title: 'Re-parent this sub-area under a different domain',
      value: m.parentId || '',
      options: topLevelMarks().filter((p) => p.id !== m.id)
        .map((p) => ({ value: p.id, label: p.name, hint: p.category || '' })),
      placeholder: 'Move to another domain…',
      onPick: (v) => { if (v) { closeCtx(); setParent(m, v); } },
    }));

    let armed = false;
    const delLbl = h('span', { class: 'dm-ctx-lbl' }, 'Forget this sub-area');
    const delBtn = h('button', {
      class: 'dm-ctx-item danger',
      title: 'Only removes the entry — the place itself is untouched',
      onClick: (e) => {
        e.stopPropagation();
        if (!armed) { armed = true; delBtn.classList.add('confirm'); delLbl.textContent = 'Forget — click again'; return; }
        closeCtx(); deleteMark(m);
      },
    }, h('span', { class: 'dm-ctx-check' }, '🗑'), delLbl);
    items.push(delBtn);

    /* Centred and wide: this is a form, not a three-item popup. */
    mountCtx(items, x, y, { center: true, wide: true });
  }

  /* ==================================================== summon-npc picker */
  /* A small searchable roster popup (its own #dm-npc, sibling of #dm-ctx). It
     asks C++ for the roster on open (pdNpcList → window.pdNpcs), and on a pick
     sends pdNpcTo with the target mark's location. */

  let npcEl = null;
  function npcOutside(e) { if (npcEl && !npcEl.contains(e.target)) closeNpc(); }
  function closeNpc() {
    if (!npcEl) return;
    npcEl.remove(); npcEl = null;
    ui.npcMark = null; ui.npcLoading = false; ui.npcFilter = '';
    document.removeEventListener('mousedown', npcOutside, true);
  }

  function distLabel(d) {
    d = Math.max(0, Math.round(Number(d) || 0));
    return d >= 1000 ? (Math.round(d / 100) / 10) + 'k' : String(d);
  }

  function firstNpc() {
    const q = (ui.npcFilter || '').trim().toLowerCase();
    return state.npcs.find((n) => !q || String(n.name).toLowerCase().includes(q)) || null;
  }

  function npcRow(n, q) {
    return h('button', {
      class: 'dm-npc-item', title: 'Summon ' + n.name + ' here',
      onClick: (e) => { e.stopPropagation(); pickNpc(n); },
    },
      h('span', { class: 'dm-npc-name' }, nameNodes(n.name, q)),
      h('span', { class: 'dm-npc-tag' + (n.follower ? ' follower' : '') }, n.follower ? 'follower' : 'nearby'),
      h('span', { class: 'dm-npc-dist', title: 'Distance (game units)' }, distLabel(n.dist)),
    );
  }

  function renderNpcList() {
    if (!npcEl) return;
    const box = npcEl.querySelector('.dm-npc-list');
    if (!box) return;
    box.textContent = '';
    if (ui.npcLoading) { box.append(h('div', { class: 'dm-npc-empty' }, 'Looking for nearby NPCs…')); return; }
    const q = (ui.npcFilter || '').trim().toLowerCase();
    const rows = state.npcs.filter((n) => !q || String(n.name).toLowerCase().includes(q));
    if (!rows.length) {
      box.append(h('div', { class: 'dm-npc-empty' },
        state.npcs.length ? 'No NPC matches “' + ui.npcFilter.trim() + '”' : 'No NPCs nearby'));
      return;
    }
    rows.forEach((n) => box.append(npcRow(n, q)));
  }

  function openNpcPicker(m, x, y) {
    closeCtx();
    closeNpc();
    ui.npcMark = m;
    ui.npcFilter = '';
    ui.npcLoading = true;
    state.npcs = [];

    const list = h('div', { class: 'dm-npc-list' });
    npcEl = h('div', { id: 'dm-npc', role: 'menu' },
      h('div', { class: 'dm-ctx-head', title: m.name }, 'Summon to “' + m.name + '”',
        h('span', { class: 'dm-ctx-where' }, placeGlyph(m) + ' ' + placeOf(m))),
      h('div', { class: 'dm-npc-searchwrap' },
        h('span', { class: 'dm-search-ic', 'aria-hidden': 'true' }, '⌕'),
        h('input', {
          class: 'dm-npc-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
          placeholder: 'Search NPCs…',
          onClick: (e) => e.stopPropagation(),
          onInput: (e) => { ui.npcFilter = e.target.value; renderNpcList(); },
          onKeydown: (e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeNpc(); }
            else if (e.key === 'Enter') { e.preventDefault(); const f = firstNpc(); if (f) pickNpc(f); }
          },
        })),
      list,
    );
    ctxHost().append(npcEl);
    clampEl(npcEl, x, y);
    setTimeout(() => document.addEventListener('mousedown', npcOutside, true), 0);
    renderNpcList();
    setTimeout(() => { const s = npcEl && npcEl.querySelector('.dm-npc-search'); if (s) s.focus(); }, 20);
    toGame('pdNpcList');
  }

  function pickNpc(n) {
    const m = ui.npcMark;
    if (!m || !n) { closeNpc(); return; }
    toGame('pdNpcTo', JSON.stringify({
      npcKey: n.key,
      mark: {
        cellId: m.cellId >>> 0, cellEdid: m.cellEdid, worldspaceId: m.worldspaceId >>> 0,
        interior: !!m.interior, x: m.x, y: m.y, z: m.z, angleZ: m.angleZ, name: m.name,
      },
    }));
    toast('Summoning ' + n.name + ' → ' + m.name + '…');
    closeNpc();
  }

  function onNpcs(p) {
    p = p || {};
    const arr = Array.isArray(p.npcs) ? p.npcs : [];
    state.npcs = arr.map((n) => ({
      key: String((n && n.key) || ''),
      name: String((n && n.name) || 'Unknown'),
      follower: !!(n && n.follower),
      dist: Number(n && n.dist) || 0,
    })).filter((n) => n.key);
    ui.npcLoading = false;
    renderNpcList();
  }

  function onNpcDone(p) {
    p = p || {};
    if (p.ok === false || p.ok === 'false') {
      toast('⚠ ' + (p.msg || ('Could not summon' + (p.name ? ' ' + p.name : ''))));
    } else if (p.name) {
      toast('Summoned ' + p.name);
    }
  }

  /* category chooser for ★ Mark, anchored above the button */
  function openMarkMenuChooser() {
    if (!state.here || !state.here.ok) { toast('No position to mark yet'); return; }
    closeCtx();
    const items = [h('div', { class: 'dm-ctx-head' }, 'Mark “' + (state.here.suggested || 'this spot') + '” as…')];
    const box = h('div', { class: 'dm-ctx-scroll' });
    state.categories.forEach((c) => {
      box.append(h('button', {
        class: 'dm-ctx-item',
        onClick: (e) => { e.stopPropagation(); closeCtx(); markHere(c); },
      },
        h('span', { class: 'dm-ctx-check' }, '★'),
        h('span', { class: 'dm-ctx-lbl' }, c),
        h('span', { class: 'dm-ctx-count' }, String(countIn(c)))));
    });
    items.push(box);
    mountCtx(items, 0, 0);
    const r = els.markBtn.getBoundingClientRect();
    const mh = ctxEl.getBoundingClientRect().height;
    clampCtx(r.left, r.top - mh - 8);
  }

  function dropAfter(e, el) { const r = el.getBoundingClientRect(); return (e.clientY - r.top) > r.height / 2; }

  /* ==================================================== key rebinding === */

  function startCapture() {
    ui.capture = true;
    els.capture.classList.remove('hidden');
    els.openkeyBtn.classList.add('capturing');
    toGame('pdCapture', '1');
  }
  function endCapture() {
    ui.capture = false;
    els.capture.classList.add('hidden');
    els.openkeyBtn.classList.remove('capturing');
    toGame('pdCapture', '0');
  }
  function applyCapture(device, code, label) {
    state.openKey = { device: device, code: code >>> 0, label: label };
    els.openkeyBtn.textContent = label;
    endCapture();
    save();
    toast('Domains key set to ' + label);
  }

  /* ========================================================== input ===== */
  /* Registered on WINDOW in the capture phase: window capture always runs
     before app.js's document-capture handler, whatever order the scripts
     loaded in, so the pane can consume a key before the deck reacts to it. */

  function ours(el) {
    if (!el) return false;
    const pane = $('dm-pane');
    return !!((pane && pane.contains(el)) || (ctxEl && ctxEl.contains(el)));
  }
  function eat(e) { e.preventDefault(); e.stopPropagation(); }

  function onKey(e) {
    if (!ui.shown) return;
    const key = e.key;

    /* FIRST, ahead of everything: the photo editor claims arrows, ± and
       Enter/Esc while it is up. It has to come before the "any printable key
       jumps to the search box" funnel at the bottom, which would otherwise eat
       '+' and '-'. */
    if (artKey(e)) { eat(e); return; }

    /* A borrowed portrait lightbox (clicking a face on a row) is topmost, and
       it belongs to the Followers pane — so its keys do too. DELEGATE rather
       than re-implement: that keeps the crop editor's arrows / ± / Enter /
       Escape identical whichever tab opened the photo. Nothing behind an
       overlay may act on a keypress, hence the unconditional eat + return. */
    if (folLbEl()) {
      eat(e);
      const fp = window.FolPane;
      if (fp && typeof fp.onKey === 'function') {
        try { fp.onKey(e); return; } catch (err) { /* fall through and just close */ }
      }
      if (key === 'Escape') closeFolLb();
      return;
    }

    if (ui.capture) {
      eat(e);
      if (key === 'Escape') { endCapture(); return; }
      if (MODIFIER_CODES.indexOf(e.code) !== -1 || ['Shift', 'Control', 'Alt', 'Meta'].indexOf(key) !== -1) return;
      const code = codeFromEvent(e);
      if (code && DIK[code]) applyCapture('keyboard', DIK[code][0], DIK[code][1]);
      else toast('Unsupported key: ' + (code || e.keyCode));
      return;
    }

    /* ⚠ This is a WINDOW-CAPTURE handler, so any e.stopPropagation() here
       also stops the event reaching the TARGET — an input's own onKeydown
       never runs behind it. Every "Enter does something in a field" must
       therefore be implemented HERE, not on the field. Learned the hard way:
       the ctx menu's Name field carried its own Enter-to-blur handler, this
       branch ate the keydown, and in-game renames looked committed but never
       were (the harness called the model directly and stayed green). */

    if (npcEl) {
      if (key === 'Escape') { eat(e); closeNpc(); return; }
      if (key === 'Enter') { eat(e); const f = firstNpc(); if (f) pickNpc(f); return; }
      e.stopPropagation();   // typing lands via the input's oninput; shield the deck
      return;
    }

    if (ctxEl) {
      /* An OPEN picker list owns the navigation keys first: Escape closes the
         list and keeps the menu (one Escape backs out of the picker, a second
         leaves the menu — the order you actually want), Enter takes the
         highlighted row, arrows move it. The input can't do this itself: this
         handler is window-CAPTURE and the keydown never reaches it. */
      const pk = e.target && e.target.__pick;
      if (pk && pk.isOpen()) {
        if (key === 'Escape') { eat(e); pk.esc(); return; }
        if (key === 'Enter') { eat(e); pk.enter(); return; }
        if (key === 'ArrowDown') { eat(e); pk.move(1); return; }
        if (key === 'ArrowUp') { eat(e); pk.move(-1); return; }
      }
      if (key === 'Escape') { eat(e); closeCtx(); return; }   // closeCtx commits first
      if (key === 'Enter' && ctxEl.contains(e.target) && e.target.tagName === 'INPUT') {
        eat(e);
        /* The tag field is the one input where Enter MEANS something other than
           "commit and leave": it turns the text into a chip and stays put so the
           next tag can be typed. It carries no onChange, so blurring it — what
           every other field here wants — would silently drop the word. (Its own
           onKeydown never runs: this handler is window-CAPTURE.) */
        const forId = e.target.dataset ? e.target.dataset.tagFor : '';
        if (forId) {
          const tm = markById(forId);
          if (tm && commitTagInput(tm, e.target)) {
            const chips = e.target.parentNode
              ? e.target.parentNode.querySelector('.dm-ctx-tags') : null;
            if (chips) repaintCtxTags(tm, chips);
          }
          return;
        }
        e.target.blur();   // blur fires change → commit
        return;
      }
      e.stopPropagation();
      return;
    }

    const ae = document.activeElement;
    const inOurInput = ours(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT');

    if (key === 'Escape') {
      if (inOurInput && ae !== els.search) { eat(e); ae.blur(); return; }
      if (ui.filter) { eat(e); setFilter(''); return; }
      return;   // nothing of ours left to dismiss — let the deck close itself
    }
    if (key === 'F2') { eat(e); toggleEdit(); return; }
    if (key === 'Tab') return;   // the deck cycles panes

    /* A field other than the search box owns its keys outright: without this,
       Enter while renaming a category in F2 fell through to the list handler
       below and opened a mark menu instead of committing the rename, and the
       arrows hijacked list selection mid-typing. (The search box is exempt on
       purpose — arrows/Enter FROM the search are the list-navigation feature.) */
    if (inOurInput && ae !== els.search) {
      if (key === 'Enter') { eat(e); ae.blur(); return; }   // commit the field
      e.stopPropagation();
      return;
    }

    const rows = visibleRows();
    /* the cards flow in grid rows: ↓/↑ move a visual ROW (nearest card in the
       next/previous one), ←/→ step through the flow order. Left/Right are left
       alone while the search box has focus — there they move the caret. */
    if (key === 'ArrowDown') { eat(e); selStep(rows, 1); return; }
    if (key === 'ArrowUp') { eat(e); selStep(rows, -1); return; }
    if ((key === 'ArrowRight' || key === 'ArrowLeft') && ae !== els.search) {
      eat(e);
      ui.sel = key === 'ArrowRight'
        ? Math.min(rows.length - 1, ui.sel + 1)
        : Math.max(0, ui.sel < 0 ? 0 : ui.sel - 1);
      renderList(); return;
    }
    if (key === 'Enter') {
      eat(e);
      const pick = ui.sel >= 0 ? rows[ui.sel] : rows[0];
      if (!pick) return;
      const el = els.list.querySelector('.dm-row[data-id="' + cssEsc(pick.m.id) + '"]');
      const r = el ? el.getBoundingClientRect() : { left: 200, top: 160 };
      (pick.child ? openChildMenu : openMarkMenu)(pick.m, r.left + 60, r.top + 18);
      return;
    }

    if (inOurInput) { e.stopPropagation(); return; }   // let the field keep the keystroke

    // funnel typing into the pane's search box, like the deck does with its own
    if (key && key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.stopPropagation();
      if (els.search) els.search.focus();
    }
  }

  function onMouse(e) {
    if (!ui.shown || !ui.capture) return;
    if (e.target && e.target.id === 'dm-capture-cancel') return;
    eat(e);
    const hit = MOUSE[e.button];
    if (!hit) { toast('Left / right click can’t be bound'); return; }
    applyCapture('mouse', hit[0], hit[1]);
  }

  /* Grid-aware vertical selection step. Picks the element whose centre is in
     the nearest visual row below/above the current one, closest horizontally —
     so ↓ from a card lands on the card under it, not its right-hand neighbour.
     Falls back to ±1 in DOM order when geometry can't answer (no selection
     yet, or a layout-less harness). */
  function selStep(rows, dir) {
    if (!rows.length) return;
    if (ui.sel < 0) { ui.sel = 0; renderList(); return; }
    const kids = els.list.children;
    const cur = kids[ui.sel];
    let next = -1, measured = false;
    if (cur && cur.getBoundingClientRect) {
      const cr = cur.getBoundingClientRect();
      if (cr.width || cr.height) {
        measured = true;
        const cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2;
        let bestKey = Infinity;
        for (let i = 0; i < kids.length; i++) {
          if (i === ui.sel) continue;
          const r = kids[i].getBoundingClientRect();
          const yc = (r.top + r.bottom) / 2;
          if (dir > 0 ? yc <= cy + 2 : yc >= cy - 2) continue;   // wrong direction / same row
          const k = Math.abs(yc - cy) * 4096 + Math.abs((r.left + r.right) / 2 - cx);
          if (k < bestKey) { bestKey = k; next = i; }
        }
      }
    }
    if (next !== -1) ui.sel = next;
    else if (!measured) ui.sel = Math.max(0, Math.min(rows.length - 1, ui.sel + dir));
    // measured but nothing that way: first/last visual row — stay put
    renderList();
  }

  function setFilter(v) {
    ui.filter = v;
    if (els.search && els.search.value !== v) els.search.value = v;
    ui.sel = -1;
    renderList();
  }

  function toggleEdit() {
    closeAllMenus();
    ui.editing = !ui.editing;
    ui.armDelCat = null;
    render();
  }

  /* =========================================================== receive == */

  function onCfg(cfg) {
    cfg = cfg || {};
    const ok = cfg.openKey || {};
    state.openKey = {
      device: ok.device === 'mouse' ? 'mouse' : 'keyboard',
      code: (ok.code >>> 0) || 102,
      label: ok.label || 'F15',
    };
    state.uiScale = typeof cfg.uiScale === 'number' ? cfg.uiScale : 1.0;
    state.thumbSize = typeof cfg.thumbSize === 'number' ? cfg.thumbSize : 1.0;
    state.categories = (Array.isArray(cfg.categories) ? cfg.categories : [])
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim());
    if (!state.categories.length) state.categories = DEFAULT_CATS.slice();
    state.marks = (Array.isArray(cfg.marks) ? cfg.marks : []).map(normalizeMark)
      .filter((m) => m.id && (m.cellId || m.cellEdid));
    sanitizeParents();
    /* The crop map rides IN the config as well as on its own `pdCrops` rail:
       both are C++-owned, the config is the one that exists at first paint, and
       a row painted before its crop landed would visibly jump a frame later.
       A config that does NOT mention imageCrops KEEPS what we already hold —
       the same contract DomainsConfigFromJson honours on the C++ side, and the
       reason a partial payload (the pane's own pdSave shape, replayed) cannot
       wipe every crop. */
    if (cfg.imageCrops && typeof cfg.imageCrops === 'object') setCrops(cfg.imageCrops);
    closeArt();             // an overlay from the previous config is stale
    closeFolLb();
    /* A tag filter pinned to a tag the new config has no domain for would show
       an empty list with no obvious way back. */
    if (ui.tagFilter && !state.marks.some((m) => hasTag(m, ui.tagFilter))) ui.tagFilter = '';
    noImage.clear();        // a fresh config may have gained/lost image files
    applyDmUiScale();
    applyDmThumb();
    ui.editing = false;
    ui.armDelCat = null;
    ui.expanded = new Set();
    ui.sel = -1;
    setFilter('');
    render();
  }

  function normalizeMark(m) {
    m = m || {};
    const cats = state.categories;
    const cat = (typeof m.category === 'string' && cats.indexOf(m.category) !== -1) ? m.category : (cats[0] || '');
    return {
      id: String(m.id || ''),
      name: String(m.name || 'Unnamed domain'),
      category: cat,
      parentId: String(m.parentId || ''),
      note: String(m.note || ''),
      tags: mergeTags([], m.tags),      // hand-edited configs land here too
      image: String(m.image || ''),
      cellName: String(m.cellName || ''),
      cellId: (m.cellId >>> 0) || 0,
      cellEdid: String(m.cellEdid || ''),
      worldspaceId: (m.worldspaceId >>> 0) || 0,
      worldspaceName: String(m.worldspaceName || ''),
      interior: !!m.interior,
      x: Number(m.x) || 0, y: Number(m.y) || 0, z: Number(m.z) || 0,
      angleZ: Number(m.angleZ) || 0,
    };
  }

  function onHere(loc) {
    state.here = loc && typeof loc === 'object' ? loc : null;
    renderFoot();
  }

  function onMarked(mk) {
    if (!mk || !mk.id) { toast('⚠ Mark failed — see HotkeyDeck.log'); return; }
    const m = normalizeMark(mk);
    state.marks = state.marks.filter((x) => x.id !== m.id);
    state.marks.unshift(m);           // newest first, at the top of its category
    if (ui.cat !== ALL && ui.cat !== m.category) ui.cat = m.category;
    setFilter('');
    render();
    toast('★ Marked “' + m.name + '” — right-click to rename');
  }

  function onSaved(ok) {
    if (ok === false || ok === 'false') toast('⚠ Save failed — see HotkeyDeck.log');
  }

  function onClosed() {
    flushSave();
    closeAllMenus();
    if (ui.capture) endCapture();
    ui.shown = false;
    ui.editing = false;
    ui.armDelCat = null;
    ui.sel = -1;
    setFilter('');
  }

  /* Only consumed while THIS pane is rebinding; otherwise the deck's own
     capture flow keeps them. Returning false lets the chained handler run. */
  function onExtKey(info) {
    if (!ui.shown || !ui.capture || !info) return false;
    applyCapture('keyboard', info.raw >>> 0, info.name || ('F' + info.raw));
    return true;
  }
  function onNativeMouse(info) {
    if (!ui.shown || !ui.capture || !info) return false;
    applyCapture('mouse', info.code >>> 0, info.label || ('Mouse ' + info.code));
    return true;
  }

  function receive(fn, p) {
    switch (fn) {
      case 'pdOpen': onCfg(coerce(p)); return true;
      case 'pdHere': onHere(coerce(p)); return true;
      case 'pdMarked': onMarked(coerce(p)); return true;
      case 'pdSaved': onSaved(p); return true;
      case 'pdNpcs': onNpcs(coerce(p)); return true;
      case 'pdCrops': {
        const j = coerce(p);
        setCrops(j && j.crops && typeof j.crops === 'object' ? j.crops : j);
        renderList();
        return true;
      }
      case 'pdPhotoSaved': {
        /* Usually never arrives — the palette is closed while the camera is in
           your hands, so C++ attaches the file itself and this push is dropped.
           Honoured anyway for the case where the deck is somehow already back. */
        const j = coerce(p) || {};
        const m = markById(String(j.id || ''));
        if (m && j.image) { m.image = String(j.image); noImage.delete(m.id); renderList(); }
        return true;
      }
      case 'pdNpcDone': onNpcDone(coerce(p)); return true;
      case 'pdSceneInfo': {
        const j = coerce(p);
        scene.info = (j && typeof j === 'object') ? j : null;
        /* Repaint the block IN PLACE if a menu is showing one — the reply
           usually lands a beat after the menu opened, and a block that never
           repainted would sit on "reading the sky…" forever. */
        if (ctxEl) {
          const box = ctxEl.querySelector('.dm-scene');
          if (box) paintScene(box);
        }
        return true;
      }
      // Palette close is OBSERVED, never consumed: it is chained onto app.js's
      // own hdClosed, which still has to hide the overlay. Returning true here
      // would swallow it and leave the palette on screen.
      case 'pdClosed': onClosed(); return false;
      case 'hdExtKey': return onExtKey(coerce(p));
      case 'hdNativeMouse': return onNativeMouse(coerce(p));
      default: return false;
    }
  }

  /* ============================================================ tab ===== */

  /* Deep-open: C++ Invokes pdShow() when the palette was opened with the
     Domains key. Clicking the tab button keeps app.js the single owner of
     tab state; the direct fallback only matters before the tab button has
     been added to index.html. */
  function showTab() {
    const btn = document.querySelector('#tabs .tab[data-tab="domains"]');
    if (btn) { btn.click(); return true; }
    if (typeof window.hdSetTab === 'function') { window.hdSetTab('domains'); return true; }
    const pane = $('dm-pane');
    if (!pane) return false;
    ['deck-pane', 'notes-pane', 'quests-pane', 'numpad-pane'].forEach((id) => {
      const el = $(id); if (el) el.classList.add('hidden');
    });
    pane.classList.remove('hidden');
    onShow();
    return true;
  }

  function onShow() {
    ui.shown = true;
    const pane = $('dm-pane');
    if (pane) pane.classList.remove('hidden');
    noImage.clear();   // re-probe images each open — a file may have been added
    ui.sel = -1;
    setFilter('');
    render();
    toGame('pdRefresh');   // the position snapshot is cheap and always fresh
    setTimeout(() => { if (els.search) els.search.focus(); }, 30);
  }

  function onHide() {
    ui.shown = false;
    closeAllMenus();
    /* The overlays live on document.body, so hiding the pane does NOT hide
       them — leaving one up would put an invisible-tab lightbox over the deck. */
    closeArt();
    closeFolLb();
    if (ui.capture) endCapture();
    flushSave();
    const pane = $('dm-pane');
    if (pane) pane.classList.add('hidden');
  }

  function wantsPause() { return true; }

  /* =========================================================== wiring === */

  /* ============================== who is HERE ========================== *
   *  "domains tab i want it to show little profile pictures of what npcs are
   *  there (hook to portraits from followers) and hover to show names."
   *
   *  Three feeds, all of which already fly past this pane on their way to the
   *  Followers tab, so nothing new is asked of C++:
   *    fdState      the roster (names, formIds, categories)
   *    fdNff        per-follower facts — including `whereId`, the FormID of
   *                 the CELL she is standing in
   *    fdPortraits  the portrait file listing
   *
   *  Matching is on whereId vs the domain's cellId, never on the place NAME:
   *  a load order this size has several "Riverwood Trader"s and name-matching
   *  would put everybody in all of them.
   *
   *  CHAINED AT PARSE TIME, like wardrobe-pane.js does for the same feed, and
   *  for the same reason: they are pushed at palette open, which is long
   *  before this pane's init() runs on first Domains open. A wrapper installed
   *  in init() would miss every one of them and the rows would stay bare until
   *  something else happened to re-push.
   * ===================================================================== */
  const who = { members: [], byCell: null, portraits: {} };

  function slugOfName(n) {
    /* Byte-identical to followers-pane.js slugOf — portraits are stored under
       it, and a second spelling here means silently missing faces. */
    return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function rebuildWho() {
    const byCell = Object.create(null);
    who.members.forEach((m) => {
      const cid = m.whereId >>> 0;
      if (!cid) return;
      (byCell[cid] || (byCell[cid] = [])).push(m);
    });
    who.byCell = byCell;
  }

  function whoIsAt(mark) {
    if (!who.byCell) rebuildWho();
    const cid = (mark && mark.cellId) >>> 0;
    if (!cid) return [];
    return who.byCell[cid] || [];
  }

  /* The cluster of faces on a row. Capped, because a domain can hold the whole
     retinue and a row is not a gallery — the overflow says how many more. */
  const WHO_MAX = 5;
  function whoStrip(mark) {
    const list = whoIsAt(mark);
    if (!list.length) return null;
    const wrap = h('span', {
      class: 'dm-who',
      title: list.map((x) => x.name).join(', '),   // hover the cluster: everyone
    });
    list.slice(0, WHO_MAX).forEach((x) => {
      const p = who.portraits[slugOfName(x.original || x.name)];
      const face = h('span', {
        class: 'dm-who-face' + (p ? ' zoom' : ' initials'),
        // hover ONE face: that name. A face with a photo says so.
        title: p ? x.name + ' — click to enlarge' : x.name,
        // Same rule as the assigned-here cluster: a face is not the row.
        onClick: (e) => {
          e.stopPropagation();
          if (!p) return;
          /* Pass the file we are ALREADY drawing as the fallback: this strip
             resolved the portrait itself, so it must not depend on the
             Followers pane resolving it a second time. */
          openFaceLightbox({
            name: x.name, original: x.original, formId: x.formId,
            portraitUrl: 'portraits/' + p.file + (p.mtime ? '?v=' + p.mtime : ''),
          });
        },
        onMousedown: (e) => e.stopPropagation(),
      }, p ? null : String(x.name || '?').trim().charAt(0).toUpperCase());
      if (p) face.style.backgroundImage = 'url("portraits/' + p.file +
        (p.mtime ? '?v=' + p.mtime : '') + '")';
      wrap.append(face);
    });
    if (list.length > WHO_MAX)
      wrap.append(h('span', { class: 'dm-who-more' }, '+' + (list.length - WHO_MAX)));
    return wrap;
  }

  /* Borrow the three feeds without consuming them — every one of these has a
     real owner downstream (the Followers tab), so always call through. */
  function borrow(name, take) {
    const prev = window[name];
    window[name] = function (payload) {
      try { take(payload); } catch (e) { /* a borrower must never break the owner */ }
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
  }

  borrow('fdState', function (env) {
    const j = typeof env === 'string' ? JSON.parse(env) : env;
    const cats = (j && j.categories) || [];
    const out = [];
    cats.forEach((c) => (c.members || []).forEach((m) => out.push({
      name: m.name || m.original || '', original: m.original || m.name || '',
      formId: String(m.formId || ''), whereId: 0,
    })));
    who.members = out;
    who.byCell = null;
    if (ui.inited && ui.shown) renderList();
  });

  borrow('fdNff', function (env) {
    const j = typeof env === 'string' ? JSON.parse(env) : env;
    const mem = (j && j.members) || {};
    const byId = Object.create(null);
    Object.keys(mem).forEach((k) => { byId[String(k).toLowerCase()] = mem[k]; });
    who.members.forEach((m) => {
      const e = byId[String(m.formId).toLowerCase()];
      m.whereId = (e && e.whereId) >>> 0 || 0;
    });
    who.byCell = null;
    if (ui.inited && ui.shown) renderList();
  });

  borrow('fdPortraits', function (list) {
    const raw = typeof list === 'string' ? JSON.parse(list) : list;
    const arr = Array.isArray(raw) ? raw : (raw && raw.portraits) || [];
    const map = Object.create(null);
    arr.forEach((p) => { if (p && p.slug) map[p.slug] = p; });
    who.portraits = map;
    if (ui.inited && ui.shown) renderList();
  });

  function chain(name, key) {
    const prev = window[name];
    window[name] = function (info) {
      if (receive(key, info)) return;
      if (typeof prev === 'function') return prev.apply(this, arguments);
    };
  }

  /* ------------------------------------------------ edit-mode size sliders -- *
   * #dm-openkey lives in the html.frag; the two size sliders don't, so they are
   * built here and inserted right after it, shown only in edit mode (syncChrome).
   * View-only: each slider just drives a CSS var + persists via the debounced save. */
  function scaleRow(label, range, val, onReset) {
    return h('div', { class: 'dm-scale-row' },
      h('span', { class: 'dm-scale-lbl' }, label),
      range, val,
      h('button', { class: 'dm-scale-reset', title: 'Reset to 100%', onClick: onReset }, 'Reset'));
  }

  function buildScaleControls() {
    const uiRange = h('input', {
      class: 'dm-range', type: 'range', min: String(UI_MIN), max: String(UI_MAX), step: String(SCALE_STEP),
      value: String(clampUi(state.uiScale)), title: 'Scale the whole Domains tab', 'aria-label': 'UI size',
      onInput: (e) => { state.uiScale = clampUi(e.target.value); applyDmUiScale(); saveSoon(); },
    });
    const uiVal = h('span', { class: 'dm-scale-val' }, '100%');
    const thRange = h('input', {
      class: 'dm-range', type: 'range', min: String(TH_MIN), max: String(TH_MAX), step: String(SCALE_STEP),
      value: String(clampThumb(state.thumbSize)), title: 'Scale the domain cards', 'aria-label': 'Card size',
      onInput: (e) => { state.thumbSize = clampThumb(e.target.value); applyDmThumb(); saveSoon(); },
    });
    const thVal = h('span', { class: 'dm-scale-val' }, '100%');

    els.uiRange = uiRange; els.uiVal = uiVal;
    els.thRange = thRange; els.thVal = thVal;

    els.scaleBox = h('div', { id: 'dm-scale', class: 'hidden' },
      scaleRow('UI size', uiRange, uiVal, () => { state.uiScale = 1.0; applyDmUiScale(); saveSoon(); }),
      scaleRow('Card size', thRange, thVal, () => { state.thumbSize = 1.0; applyDmThumb(); saveSoon(); }));

    if (els.openkey && els.openkey.parentNode) {
      els.openkey.insertAdjacentElement('afterend', els.scaleBox);
    } else {
      const main = $('dm-main'); if (main) main.insertBefore(els.scaleBox, main.firstChild);
    }
  }

  function init() {
    if (ui.inited) return true;
    if (!$('dm-pane')) { console.log('[domains] #dm-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;

    els.pane = $('dm-pane');
    els.rail = $('dm-rail');
    els.railList = $('dm-rail-list');
    els.addCat = $('dm-add-cat');
    els.search = $('dm-search');
    els.count = $('dm-count');
    els.openkey = $('dm-openkey');
    els.openkeyBtn = $('dm-openkey-btn');
    els.list = $('dm-list');
    els.empty = $('dm-empty');
    els.foot = $('dm-foot');
    els.markBtn = $('dm-mark-btn');
    els.hereHint = $('dm-here');
    els.capture = $('dm-capture');

    buildScaleControls();   // inserts #dm-scale after #dm-openkey
    applyDmUiScale();       // paint the saved scales before the first render
    applyDmThumb();

    els.search.addEventListener('input', (e) => setFilter(e.target.value));
    els.addCat.addEventListener('click', addCategory);
    els.openkeyBtn.addEventListener('click', startCapture);
    $('dm-capture-cancel').addEventListener('click', endCapture);
    els.markBtn.addEventListener('click', openMarkMenuChooser);
    els.list.addEventListener('scroll', closeAllMenus, true);
    window.addEventListener('resize', closeAllMenus);

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);

    // C++ -> view entry points (PrismaUI Invokes these as plain globals)
    window.pdOpen = function (cfg) { receive('pdOpen', cfg); };
    window.pdHere = function (loc) { receive('pdHere', loc); };
    window.pdMarked = function (mk) { receive('pdMarked', mk); };
    window.pdSaved = function (ok) { receive('pdSaved', ok); };
    window.pdNpcs = function (list) { receive('pdNpcs', list); };
    /* `pdCrops` is the map coming BACK; `pdCropSave` goes the other way, and the
       two must never be the same name — PrismaUI installs each listener as a
       global of that name, so one name used for both directions silently
       unplugs the control (five times and counting across this codebase). */
    window.pdCrops = function (obj) { receive('pdCrops', obj); };
    window.pdPhotoSaved = function (obj) { receive('pdPhotoSaved', obj); };
    window.pdNpcDone = function (res) { receive('pdNpcDone', res); };
    /* `pdSceneInfo` is the answer to BOTH pdScene and pdSceneSet; neither
       request name may ever be reused for it (see pdCrops above). */
    window.pdSceneInfo = function (obj) { receive('pdSceneInfo', obj); };
    window.pdShow = function () { showTab(); };

    // shared receivers: consume only while this pane is rebinding, else defer
    chain('hdExtKey', 'hdExtKey');
    chain('hdNativeMouse', 'hdNativeMouse');
    chain('hdClosed', 'pdClosed');

    if (!state.categories.length) state.categories = DEFAULT_CATS.slice();
    render();
    if (DEV) devBoot();
    return true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);

  /* ============================================================== dev === *
   * ?dev=1 stands in for the C++ bridge with a live fake world, so every
   * flow is clickable in a browser. ?selftest=1 runs the assertions.       */

  const STANDALONE = !$('deck-pane');

  function devMarks() {
    const M = (id, name, category, note, place, interior, x, y, parentId) => ({
      id: id, name: name, category: category, parentId: parentId || '', note: note,
      cellName: interior ? place : '', cellId: 0x00010000 + parseInt(id.slice(1), 10),
      cellEdid: interior ? place.replace(/\s+/g, '') + '01' : '',
      worldspaceId: interior ? 0 : 0x0000003C, worldspaceName: interior ? '' : place,
      interior: interior, x: x, y: y, z: 128, angleZ: 1.2,
    });
    return [
      M('m1', 'Proudspire Manor — throne room', 'Estates', 'The Solitude townhouse', 'Proudspire Manor', true, 120, -40),
      M('m2', 'Mistveil Keep — the throne stair', 'Estates', 'Side stair, behind the throne', 'Mistveil Keep', true, 8, 900),
      M('m3', 'Vlindrel Hall — the solar', 'Estates', 'Household ledgers live here', 'Vlindrel Hall', true, -300, 55),
      M('m4', 'Breezehome cellar', 'Estates', '', 'Breezehome', true, 40, 12),
      M('m5', 'Whiterun — market steps', 'Cities', 'Ysolda trades here at dawn', 'Whiterun', false, 22150, -12030),
      M('m6', 'Solitude — Blue Palace gate', 'Cities', '', 'Skyrim', false, 20100, 60050),
      M('m7', 'Riften — canal under the Flagon', 'Cities', 'Quiet way in', 'Skyrim', false, 60110, -34200),
      M('m8', 'Markarth — Understone entrance', 'Cities', '', 'Skyrim', false, -60600, -25000),
      M('m9', 'Windhelm — Grey Quarter well', 'Cities', '', 'Skyrim', false, 32200, 22400),
      M('m10', 'Bleak Falls Barrow — word wall', 'Dungeons', 'Draugr respawn; come armed', 'Bleak Falls Sanctum', true, 900, -220),
      M('m11', 'Labyrinthian — the lich vault', 'Dungeons', 'Where the lich fell', 'Labyrinthian Tribune', true, -1400, 60),
      M('m12', 'Shriekwind Bastion — the sealed vault', 'Dungeons', 'Do not touch the seal again', 'Shriekwind Bastion', true, 210, 480),
      M('m13', 'Blackreach — glowing pool', 'Dungeons', '', 'Blackreach', false, 8400, 12800),
      M('m14', 'Throat of the World — the very summit itself, high above the clouds, where the greybeards keep their long and unhurried centuries-old silence and the wind never truly stops',
        'Wilderness', 'Absurdly long name kept on purpose: this row must ellipsize, never wrap or overlap the chips beside it.',
        'Skyrim', false, 4800, -9400),
      M('m15', 'Eldergleam sanctuary', 'Wilderness', '', 'Eldergleam Sanctuary', true, 60, 60),
      M('m16', 'Lake Ilinalta — the sunken tower', 'Wilderness', 'Good fishing, bad memories', 'Skyrim', false, -4200, -22000),
      M('m17', 'Kynesgrove — the barrow ridge', 'Wilderness', '', 'Skyrim', false, 30200, 18000),
      M('m18', 'Hidden pass above Helgen', 'Wilderness', '', 'Skyrim', false, 6400, -30100),
      // sub-areas of m1 (Proudspire Manor) — the chevron tree
      M('m19', 'Proudspire Manor — the great hall', 'Estates', 'Feasts and petitioners', 'Proudspire Manor', true, 118, -36, 'm1'),
      M('m20', 'Proudspire Manor — the deep undercroft where the old estate ledgers, the sealed writs and the colder vintages are all kept far from daylight behind the second locked iron door',
        'Estates', 'Long sub-area name on purpose: a child row must ellipsize too, never wrap or overflow.',
        'Proudspire Manor', true, 116, -44, 'm1'),
      M('m21', 'Proudspire Manor — the watchtower', 'Estates', '', 'Proudspire Manor', true, 130, -20, 'm1'),
    ];
  }

  function devCfg() {
    const marks = devMarks();
    /* Two photographed domains, one cropped and one not — the harness needs
       BOTH to tell "the crop applied" from "everything got a transform". And a
       domain with eight tags, because the row's tag line has to survive that. */
    const byId = (id) => marks.find((m) => m.id === id);
    if (byId('m7')) { byId('m7').image = 'domain-images/pd-cropped-m7.png'; }
    if (byId('m9')) { byId('m9').image = 'domain-images/pd-plain-m9.png'; }
    /* m6 on purpose: m1/m3/m5 are all deleted by earlier assertions in the
       suite, and a fixture that evaporates halfway through reads as a bug in
       the feature rather than in the fixture. */
    if (byId('m6')) byId('m6').tags = ['Estate', 'Home', 'Vault'];
    if (byId('m2')) byId('m2').tags = ['Inn', 'Warm bed', 'Drink', 'Rumours', 'Riverwood', 'Cheap', 'Loud', 'Fire'];
    if (byId('m3')) byId('m3').tags = ['inn'];   // deliberately a different SPELLING of m2's
    return {
      openKey: { device: 'keyboard', code: 102, label: 'F15' },
      uiScale: 1.0,
      categories: DEFAULT_CATS.slice(),
      imageCrops: { 'pd-cropped-m7.png': { z: 1.8, x: 0.12, y: -0.2 } },
      marks: marks,
    };
  }

  function devHere() {
    return {
      ok: true, interior: true,
      cellId: 0x0001A26F, cellEdid: 'RiverwoodSleepingGiantsInn', cellName: 'Sleeping Giant Inn',
      worldspaceId: 0, worldspaceName: '',
      x: 145.5, y: -60.25, z: 32.0, angleZ: 2.4,
      suggested: 'Sleeping Giant Inn',
    };
  }

  function devBoot() {
    let seq = state.marks.length + 100;
    window.__dmSent = { mark: null, recall: null, save: null, refresh: 0, npcList: 0, npcTo: null,
      photo: null, crop: null, lightbox: null, lbKeys: 0, scene: 0, sceneSet: null };

    // a small fake roster for the Summon NPC picker — followers pre-sorted first,
    // exactly as C++ NpcListJson() promises (followers, then nearest).
    const devNpcs = [
      { key: '0xFF001001', name: 'Lydia', follower: true, dist: 84 },
      { key: '0xFF001002', name: 'Jenassa', follower: true, dist: 121 },
      { key: '0x0001A66C', name: 'Carlotta Valentia', follower: false, dist: 155 },
      { key: '0x0001A696', name: 'Ysolda', follower: false, dist: 210 },
      { key: '0x0001A6A0', name: 'Farengar Secret-Fire', follower: false, dist: 340 },
      { key: '0x0001B07B', name: 'Nazeem', follower: false, dist: 512 },
    ];
    window.pdNpcList = function () {
      window.__dmSent.npcList++;
      setTimeout(() => window.pdNpcs({ npcs: devNpcs }), 12);
    };
    window.pdNpcTo = function (j) {
      window.__dmSent.npcTo = JSON.parse(j);
      setTimeout(() => window.pdNpcDone({ ok: true, name: 'NPC', msg: '' }), 10);
    };

    window.pdMark = function (j) {
      const p = JSON.parse(j);
      window.__dmSent.mark = p;
      const here = state.here || devHere();
      setTimeout(() => window.pdMarked({
        id: 'm' + (++seq), name: p.name, category: p.category, note: '',
        cellName: here.cellName, cellId: here.cellId, cellEdid: here.cellEdid,
        worldspaceId: here.worldspaceId, worldspaceName: here.worldspaceName,
        interior: here.interior, x: here.x, y: here.y, z: here.z, angleZ: here.angleZ,
      }), 20);
    };
    window.pdRecall = function (j) {
      const p = JSON.parse(j);
      window.__dmSent.recall = p;
      toast('(dev) travel → ' + p.name);
    };
    window.pdSave = function (j) { window.__dmSent.save = JSON.parse(j); };
    window.pdPhoto = function (j) { window.__dmSent.photo = JSON.parse(j); };
    /* Echoes the authoritative map back exactly as C++ does, so the harness
       exercises the real two-name round trip rather than only the optimistic
       local update. */
    window.pdCropSave = function (j) {
      const p = JSON.parse(j);
      window.__dmSent.crop = p;
      const map = {};
      Object.keys(state.imageCrops).forEach((k) => { map[k] = state.imageCrops[k]; });
      if (p.clear) delete map[p.file];
      else map[p.file] = { z: p.z, x: p.x, y: p.y };
      setTimeout(() => window.pdCrops({ crops: map }), 8);
    };
    window.pdRefresh = function () { window.__dmSent.refresh++; setTimeout(() => window.pdHere(devHere()), 10); };
    window.pdClose = function () { receive('pdClosed'); };
    window.pdLog = function (s) { console.log('[dev] domains', s); };
    window.pdCapture = function (x) { console.log('[dev] domains capture', x); };

    /* Scene staging: a fake sky. Two vanilla-ish weathers per kind so the
       "first of each kind wins the chip" rule is actually exercised, and one
       kind (snow) deliberately ABSENT so the disabled chip has a case. */
    window.__dmScene = {
      hour: 21.78, staged: false,
      weatherId: 0x000302B4, weatherName: 'SkyrimOvercast', weatherKind: 'cloudy',
      exposure: 0, exposureMax: 3,
      presets: {
        clear:  { id: 0x00010E1F, name: 'SkyrimClear' },
        cloudy: { id: 0x000302B4, name: 'SkyrimOvercast' },
        rain:   { id: 0x000C8220, name: 'SkyrimStormRain' },
      },
      list: [
        { id: 0x00010E1F, name: 'SkyrimClear', kind: 'clear' },
        { id: 0x000302B4, name: 'SkyrimOvercast', kind: 'cloudy' },
        { id: 0x000C8220, name: 'SkyrimStormRain', kind: 'rain' },
      ],
    };
    window.pdScene = function () {
      window.__dmSent.scene++;
      setTimeout(() => window.pdSceneInfo(JSON.stringify(window.__dmScene)), 5);
    };
    window.pdSceneSet = function (arg) {
      const j = JSON.parse(arg || '{}');
      if (typeof j.exposure === 'number') {
        // Clamped on the C++ side; the stub clamps too, so the harness proves
        // the view takes the ANSWER rather than what it asked for.
        const m = window.__dmScene.exposureMax;
        window.__dmScene.exposure = Math.max(-m, Math.min(m, j.exposure));
      }
      window.__dmSent.sceneSet = j;
      setTimeout(() => window.pdSceneInfo(JSON.stringify(window.__dmScene)), 5);
    };

    // Stand in for the Followers pane when it isn't loaded (the standalone
    // domains harness). A tiny 1x1 gif data-URI gives the "has a portrait"
    // faces something that actually decodes; the rest fall back to initials.
    if (!window.FolPane) {
      const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      window.FolPane = {
        rosterForDomains: function () {
          return [
            // seven whose Home lands on Proudspire Manor (m1) — mixed casing and
            // exact-vs-substring, mixed portrait vs initials — so the cluster
            // caps at five and shows a +2 pill
            { name: 'Lydia',   home: 'Proudspire Manor — throne room', portraitUrl: PX,   formId: '0x000A2C8E' },
            { name: 'Jordis',  home: 'Proudspire Manor',               portraitUrl: PX,   formId: '0x0001A2B1' },
            { name: 'Uthgerd', home: 'Proudspire Manor',               portraitUrl: null, formId: '0x0001A2B2' },
            { name: 'Iona', home: 'proudspire manor',               portraitUrl: null, formId: '0x0001A2B3' },
            { name: 'Rayya',    home: 'Proudspire Manor',               portraitUrl: PX,   formId: '0x0001A2B4' },
            { name: 'Argis',    home: 'Proudspire Manor',               portraitUrl: null, formId: '0x0001A2B5' },
            { name: 'Gerdur',  home: 'Proudspire Manor',               portraitUrl: null, formId: '0x0001A2B6' },
            // one on Whiterun (m5), no portrait → exercises the initials fallback
            { name: 'Ysolda',  home: 'Whiterun',                     portraitUrl: null, formId: '0x0001A696' },
            // homes the MODS assert, nothing typed — the automatic path.
            // Annekke via NFF, Ingjard via MHiYH, both onto Breezehome (m4).
            { name: 'Annekke', home: '', nffHome: 'Breezehome', mhHome: '',
              portraitUrl: null, formId: '0x0001A2C1' },
            { name: 'Ingjard',  home: '', nffHome: '',           mhHome: 'Breezehome',
              portraitUrl: PX,   formId: '0x0001A2C2' },
            // typed + NFF agree (ONE face, credited to the typed field) while
            // MHiYH points somewhere ELSE — so she also lives over m2.
            { name: 'Borgakh',   home: 'Breezehome', nffHome: 'Breezehome', mhHome: 'Mistveil Keep',
              portraitUrl: null, formId: '0x0001A2C3' },
            // empty everything → must never match anything
            { name: 'Nobody',  home: '',                             portraitUrl: null, formId: '0x0001A6FF' },
          ];
        },
        /* The three seams "click a face" borrows. These names MUST match the
           export block at the bottom of followers-pane.js — a rename there
           with no rename here is exactly the silent no-op this stub exists to
           make visible. The fake overlay carries the real class (.fd-lb) so
           the pane's own teardown and key delegation are tested for real. */
        portraitInfoFor: function (w) {
          const nm = String((w && w.name) || '').toLowerCase();
          if (nm !== 'lydia') return null;             // one resolvable person
          return { slug: 'lydia', file: 'lydia~2.png', ext: 'png', mtime: 1712 };
        },
        _openLightbox: function (d) {
          this._closeLightbox();
          window.__dmSent.lightbox = d;
          const el = document.createElement('div');
          el.className = 'fd-lb';
          el.textContent = String((d && d.name) || '');
          document.body.appendChild(el);
        },
        _closeLightbox: function () {
          const el = document.querySelector('.fd-lb');
          if (el && el.parentNode) el.parentNode.removeChild(el);
        },
        onKey: function (e) {
          window.__dmSent.lbKeys = (window.__dmSent.lbKeys || 0) + 1;
          if (e.key === 'Escape') this._closeLightbox();
          return true;   // an overlay swallows every key, like the real one
        },
      };
    }

    window.pdOpen(devCfg());
    window.pdHere(devHere());

    if (STANDALONE || location.search.indexOf('dm=1') !== -1) {
      document.body.classList.add('open');
      showTab();
      if (SELFTEST) setTimeout(runSelfTest, 320);
    }
  }

  /* ---------------------------------------------------------- selftest -- */

  function runSelfTest() {
    const results = [];
    // a valid 1x1 gif — a "domain image" that actually decodes, for the thumb tests
    const SELFTEST_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const T = (name, fn) => {
      let pass = false;
      try { pass = !!fn(); } catch (e) { pass = false; results.push({ name: name, pass: false, err: String(e) }); return; }
      results.push({ name: name, pass: pass });
    };
    const rowCount = () => els.list.children.length;

    /* ---- load + render ---- */
    T('config load: categories seeded', () => state.categories.length === 4 && state.categories[0] === 'Estates');
    T('config load: marks normalized', () => state.marks.length === 21 && !!markById('m1'));
    T('config load: sub-areas nest under their parent', () =>
      childrenOf('m1').length === 3 && topLevelMarks().length === 18 && markById('m19').parentId === 'm1');
    T('rail lists All + every category', () => els.railList.children.length === 5);
    T('rail count is top-level only (sub-areas don\'t inflate it)', () => {
      const row = els.railList.querySelector('.dm-rail-item.all .dm-rail-count');
      return row && row.textContent === '18';
    });
    T('All shows every top-level domain (children collapsed)', () => {
      ui.cat = ALL; setFilter('');
      return rowCount() === topLevelMarks().length && rowCount() === 18;
    });
    T('count chip matches the list', () => els.count.textContent === String(rowCount()));
    T('interior + exterior chips both render', () =>
      els.list.textContent.indexOf('⌂') !== -1 && els.list.textContent.indexOf('▲') !== -1);
    T('medallion carries a per-category hue', () =>
      !!els.list.querySelector('.dm-medal').style.getPropertyValue('--dm-hue'));

    /* ---- follower faces (Followers-tab Home field → domain) ---- */
    ui.cat = ALL; setFilter(''); ui.expanded.clear(); render();
    T('faces: a domain shows a cluster for followers whose Home matches', () => {
      const cl = els.list.querySelector('.dm-row[data-id="m5"] .dm-faces');
      return !!cl && cl.querySelectorAll('.dm-face').length === 1;
    });
    T('faces: matching picks only the right followers (Whiterun → Ysolda)', () => {
      const who = followersForDomain(markById('m5'));
      return who.length === 1 && who[0].name === 'Ysolda';
    });
    T('faces: substring/exact Home both match (Proudspire Manor → 7 people)', () =>
      followersForDomain(markById('m1')).length === 7);
    T('faces: cluster caps at five and shows a +N pill past the cap', () => {
      const cl = els.list.querySelector('.dm-row[data-id="m1"] .dm-faces');
      if (!cl) return false;
      const more = cl.querySelector('.dm-face-more');
      return cl.querySelectorAll('.dm-face').length === 5 && !!more && more.textContent === '+2';
    });
    T('faces: a portrait follower renders an <img> face', () =>
      !!els.list.querySelector('.dm-row[data-id="m1"] .dm-faces img.dm-face-img'));
    T('faces: a no-portrait follower falls back to an initials medal', () => {
      const cl = els.list.querySelector('.dm-row[data-id="m5"] .dm-faces');
      return !!cl && !!cl.querySelector('.dm-face-medal');
    });
    T('faces: each face carries the follower name in its title (#hd-tip draws it)', () => {
      // No hand-built .dm-face-tip anymore: the card clips its children, so
      // the hover text lives in the title attr for app.js's clamped bubble.
      const face = els.list.querySelector('.dm-row[data-id="m5"] .dm-face');
      return !!face && (face.getAttribute('title') || '').indexOf('Ysolda') === 0 &&
             !face.querySelector('.dm-face-tip');
    });
    T('faces: an NFF base matches with nothing typed (Breezehome → Annekke)', () => {
      const who = followersForDomain(markById('m4'));
      return who.some((f) => f.name === 'Annekke' && f.hit && f.hit.src === 'NFF');
    });
    T('faces: an MHiYH home matches with nothing typed (Breezehome → Ingjard)', () => {
      const who = followersForDomain(markById('m4'));
      return who.some((f) => f.name === 'Ingjard' && f.hit && f.hit.src === 'MHiYH');
    });
    T('faces: typed + NFF agreeing is ONE face, credited to the typed field', () => {
      const who = followersForDomain(markById('m4'));
      const borgakh = who.filter((f) => f.name === 'Borgakh');
      return who.length === 3 && borgakh.length === 1 && borgakh[0].hit.src === '';
    });
    T('faces: the same person lives over every domain her homes match', () => {
      const who = followersForDomain(markById('m2'));
      return who.length === 1 && who[0].name === 'Borgakh' && who[0].hit.src === 'MHiYH';
    });
    T('faces: the hover title names the matched home and its source', () => {
      render();
      const cl = els.list.querySelector('.dm-row[data-id="m4"] .dm-faces');
      const titles = cl ? [].map.call(cl.querySelectorAll('.dm-face'),
        (f) => f.getAttribute('title') || '') : [];
      return titles.some((t) => t.indexOf('Breezehome') !== -1 && t.indexOf('NFF') !== -1) &&
             titles.some((t) => t.indexOf('MHiYH') !== -1);
    });
    T('faces: clicking a face does not fire the row travel', () => {
      const face = els.list.querySelector('.dm-row[data-id="m5"] .dm-face');
      if (!face) return false;
      const before = window.__dmSent.recall;
      face.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return window.__dmSent.recall === before;   // recall unchanged → didn't travel
    });
    T('faces: sub-area (child) rows never get a cluster', () => {
      ui.cat = 'Estates'; setFilter(''); ui.expanded.clear(); toggleExpand('m1');
      const child = els.list.querySelector('.dm-row.dm-child[data-id="m19"]');
      const ok = !!child && !child.querySelector('.dm-faces');
      ui.cat = ALL; setFilter(''); ui.expanded.clear(); render();
      return ok;
    });
    T('faces: none render when the follower roster is empty', () => {
      const orig = window.FolPane.rosterForDomains;
      window.FolPane.rosterForDomains = () => [];
      render();
      const any = els.list.querySelector('.dm-faces');
      window.FolPane.rosterForDomains = orig;
      render();
      return !any;
    });
    T('faces: absent FolPane renders no faces and does not throw', () => {
      const orig = window.FolPane;
      window.FolPane = undefined;
      render();
      const any = els.list.querySelector('.dm-faces');
      window.FolPane = orig;
      render();
      return !any;
    });
    T('faces: the row still fits — long name ellipsizes beside a cluster', () => {
      // m5 (Whiterun — market steps) carries a face; its name must still clip.
      ui.cat = ALL; setFilter(''); render();
      const row = els.list.querySelector('.dm-row[data-id="m5"]');
      const lb = els.list.getBoundingClientRect();
      return !!row && row.getBoundingClientRect().right <= lb.right + 1;
    });

    /* ---- edit-mode size sliders (UI size + image size) ---- */
    ui.editing = false; render();
    T('size sliders: the controls block is built and hidden outside edit mode', () =>
      !!els.scaleBox && els.scaleBox.classList.contains('hidden') &&
      els.scaleBox.querySelectorAll('input[type="range"]').length === 2);
    T('size sliders: F2 edit reveals them', () => {
      toggleEdit();   // -> editing
      return ui.editing && !els.scaleBox.classList.contains('hidden');
    });
    T('UI-size slider drives --dm-ui-scale and state.uiScale', () => {
      els.uiRange.value = '1.3';
      els.uiRange.dispatchEvent(new Event('input', { bubbles: true }));
      const v = parseFloat(document.documentElement.style.getPropertyValue('--dm-ui-scale'));
      return Math.abs(v - 1.3) < 1e-6 && Math.abs(state.uiScale - 1.3) < 1e-6;
    });
    T('UI-size slider clamps into 0.7–1.6', () => {
      els.uiRange.value = '9';
      els.uiRange.dispatchEvent(new Event('input', { bubbles: true }));
      return state.uiScale <= UI_MAX + 1e-9 && state.uiScale >= UI_MIN - 1e-9;
    });
    T('Card-size slider drives --dm-thumb and state.thumbSize', () => {
      els.thRange.value = '1.5';
      els.thRange.dispatchEvent(new Event('input', { bubbles: true }));
      const v = parseFloat(document.documentElement.style.getPropertyValue('--dm-thumb'));
      return Math.abs(v - 1.5) < 1e-6 && Math.abs(state.thumbSize - 1.5) < 1e-6;
    });
    T('Card-size scales the cards (grid min column tracks --dm-thumb)', () => {
      // a wider minimum column means fewer, wider cards at the same pane width
      state.thumbSize = 1.0; applyDmThumb();
      noImage.add('m5'); render();   // force the medal path for a clean measure
      const card = () => els.list.querySelector('.dm-row[data-id="m5"]');
      const w1 = card() ? card().getBoundingClientRect().width : 0;
      state.thumbSize = 2.0; applyDmThumb(); render();
      const w2 = card() ? card().getBoundingClientRect().width : 0;
      state.thumbSize = 1.0; applyDmThumb(); noImage.clear(); render();
      return w1 > 0 && w2 > w1;
    });
    T('reset buttons return each slider to 100%', () => {
      const rst = els.scaleBox.querySelectorAll('.dm-scale-reset');
      rst[0].click(); rst[1].click();
      return state.uiScale === 1.0 && state.thumbSize === 1.0;
    });
    /* ---- who is HERE (Rober, 2026-08-03) ---------------------------- */
    T('faces appear for followers whose CELL matches the domain', () => {
      const m = state.marks[0];
      if (!m || !m.cellId) return false;
      who.members = [
        { name: 'Camilla', original: 'Camilla Valerius', formId: '0x1', whereId: m.cellId },
        { name: 'Lydia',   original: 'Lydia',            formId: '0x2', whereId: m.cellId },
        { name: 'Ysolda',  original: 'Ysolda',           formId: '0x3', whereId: m.cellId + 999 },
      ];
      who.byCell = null;
      who.portraits = {};
      const strip = whoStrip(m);
      if (!strip) return false;
      const faces = strip.querySelectorAll('.dm-who-face');
      // Ysolda is in a DIFFERENT cell and must not appear.
      return faces.length === 2 && strip.title === 'Camilla, Lydia';
    });
    T('a domain with nobody in it renders no cluster at all', () => {
      const m = state.marks[0];
      who.members = [{ name: 'Ysolda', original: 'Ysolda', formId: '0x3', whereId: 424242 }];
      who.byCell = null;
      return whoStrip(m) === null;
    });
    T('matching is by cell ID, never by place NAME', () => {
      /* Several cells in this load order share a display name; matching on the
         string would put the whole retinue in every one of them. */
      const m = state.marks[0];
      who.members = [{ name: 'Camilla', original: 'Camilla Valerius', formId: '0x1',
                       whereId: 0, where: m.cellName || placeOf(m) }];
      who.byCell = null;
      return whoStrip(m) === null;
    });
    T('a crowd is capped and says how many more', () => {
      const m = state.marks[0];
      who.members = [];
      for (let i = 0; i < 9; i++) who.members.push(
        { name: 'Filler ' + i, original: 'Filler ' + i, formId: '0x' + i, whereId: m.cellId });
      who.byCell = null;
      const strip = whoStrip(m);
      const faces = strip.querySelectorAll('.dm-who-face').length;
      const more = strip.querySelector('.dm-who-more');
      who.members = []; who.byCell = null;
      return faces === WHO_MAX && !!more && more.textContent === '+' + (9 - WHO_MAX);
    });
    T('each face carries its OWN name for hover, cluster carries all', () => {
      const m = state.marks[0];
      who.members = [
        { name: 'Camilla', original: 'Camilla Valerius', formId: '0x1', whereId: m.cellId },
        { name: 'Lydia',   original: 'Lydia',            formId: '0x2', whereId: m.cellId },
      ];
      who.byCell = null;
      const strip = whoStrip(m);
      const titles = Array.prototype.map.call(strip.querySelectorAll('.dm-who-face'), (f) => f.title);
      who.members = []; who.byCell = null;
      return titles.join('|') === 'Camilla|Lydia' && strip.title === 'Camilla, Lydia';
    });

    T('uiScale + thumbSize survive the pdSave → onCfg round-trip', () => {
      state.uiScale = 1.25; state.thumbSize = 1.4; applyDmUiScale(); applyDmThumb();
      flushSave();
      const p = window.__dmSent.save;
      if (!p || typeof p.uiScale !== 'number' || typeof p.thumbSize !== 'number') return false;
      onCfg(p);
      return Math.abs(state.uiScale - 1.25) < 1e-6 && Math.abs(state.thumbSize - 1.4) < 1e-6;
    });
    ui.editing = false; ui.cat = ALL; setFilter(''); render();

    /* ---- search ---- */
    T('search matches a name', () => { setFilter('bleak falls'); return rowCount() === 1; });
    T('search matches a note', () => { setFilter('do not touch'); return rowCount() === 1; });
    T('search matches a place/cell', () => { setFilter('breezehome'); return rowCount() === 1; });
    T('search matches a category', () => { setFilter('dungeons'); return rowCount() === 4; });
    T('search highlights the hit', () => { setFilter('riften'); return !!els.list.querySelector('mark'); });
    T('search highlights inside the place + category chips', () => {
      setFilter('estat');
      const cat = !!els.list.querySelector('.dm-chip.cat mark');
      setFilter('breezehome');
      return cat && !!els.list.querySelector('.dm-chip mark');
    });
    T('no match shows the empty state', () => {
      setFilter('zzznope');
      return !els.empty.classList.contains('hidden') && els.empty.textContent.indexOf('No domain matches') !== -1;
    });
    setFilter('');

    /* ---- rail filtering ---- */
    T('category filter narrows the list', () => { ui.cat = 'Cities'; renderList(); return rowCount() === 5; });
    T('empty category shows its own empty state', () => {
      state.categories.push('Ruins'); ui.cat = 'Ruins'; render();
      return !els.empty.classList.contains('hidden') && els.empty.textContent.indexOf('“Ruins” is empty') !== -1;
    });
    T('add category appends and selects it', () => {
      const before = state.categories.length;
      addCategory();
      return state.categories.length === before + 1 && ui.cat === state.categories[state.categories.length - 1];
    });

    /* ---- mark flow ---- */
    ui.cat = ALL; render();
    T('mark button shows the suggested name', () =>
      els.markBtn.textContent.indexOf('Sleeping Giant Inn') !== -1 && !els.markBtn.disabled);
    T('mark chooser lists every category', () => {
      openMarkMenuChooser();
      const n = ctxEl.querySelectorAll('.dm-ctx-item').length;
      closeCtx();
      return n === state.categories.length;
    });
    const beforeMark = state.marks.length;
    markHere('Estates');
    T('pdMark carries name + category', () =>
      window.__dmSent.mark && window.__dmSent.mark.category === 'Estates' &&
      window.__dmSent.mark.name === 'Sleeping Giant Inn');

    setTimeout(() => {
      T('pdMarked appends the new domain at the top', () =>
        state.marks.length === beforeMark + 1 && state.marks[0].name === 'Sleeping Giant Inn');
      T('a new domain inherits the chosen category', () => state.marks[0].category === 'Estates');

      /* ---- recall ---- */
      ui.cat = ALL; setFilter(''); render();
      recall(markById('m10'));
      T('pdRecall carries cell + coordinates + label', () => {
        const r = window.__dmSent.recall;
        return r && r.cellId === markById('m10').cellId && r.x === 900 && r.angleZ === 1.2 &&
          r.label === '➤ ' + markById('m10').name;
      });

      /* ---- context menu ---- */
      const m = markById('m5');
      openMarkMenu(m, 120, 140);
      T('menu opens with name + note + tag inputs', () => !!$('dm-ctx') &&
        ctxEl.querySelectorAll('.dm-ctx-input:not(.dm-pick-input)').length === 3 &&
        !!ctxEl.querySelector('.dm-ctx-input.note') && !!ctxEl.querySelector('.dm-ctx-input.tag'));
      T('menu offers travel + category + forget', () =>
        ctxEl.querySelectorAll('.dm-ctx-item').length >= 2 &&
        ctxEl.querySelectorAll('.dm-pick').length === 2);
      T('menu carries NO <select> — Ultralight renders one but never opens it', () =>
        ctxEl.querySelectorAll('select').length === 0);
      T('menu stays inside the viewport', () => {
        closeCtx();
        openMarkMenu(m, window.innerWidth - 4, window.innerHeight - 4);
        const b = ctxEl.getBoundingClientRect();
        return b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight;
      });
      T('menu is CENTRED, not dropped at the pointer', () => {
        // opened at the far corner above; it must still sit in the middle
        const b = ctxEl.getBoundingClientRect();
        return Math.abs((b.left + b.right) / 2 - window.innerWidth / 2) <= 2 &&
          Math.abs((b.top + b.bottom) / 2 - window.innerHeight / 2) <= 2;
      });
      T('menu is wide enough to be a form, not a popup', () => {
        const b = ctxEl.getBoundingClientRect();
        return ctxEl.classList.contains('wide') &&
          b.width >= Math.min(470, window.innerWidth * 0.9);
      });
      /* ---- ⛶ Fill scaling: the SpudmanWP bug (2026-08-13) ----
         #dm-ctx is an #overlay child, OUTSIDE #panel's transform, so it must
         wear --ui-scale itself. It does via app.css (transform:
         scale(var(--ui-scale))). Prove the rule reaches the element AND that
         the post-scale clamp keeps it on screen at a big Fill scale. */
      T('menu carries the deck scale transform (⛶ Fill readable)', () => {
        const cs = getComputedStyle(ctxEl).transform;
        // real browser -> a matrix that is not identity; a CSSOM-less env ->
        // the declared string. Either way it must not be a bare "none".
        return !!cs && cs !== 'none' && cs !== 'matrix(1, 0, 0, 1, 0, 0)';
      });
      T('menu stays on screen at ⛶ Fill (--ui-scale 2.4)', () => {
        // GEO guard: needs real layout (offset boxes). Skip cleanly headless.
        if (!ctxEl.offsetWidth) return true;
        const root = document.documentElement.style;
        const prev = root.getPropertyValue('--ui-scale');
        root.setProperty('--ui-scale', '2.4');
        closeCtx();
        openMarkMenu(m, window.innerWidth - 4, window.innerHeight - 4);
        const b = ctxEl.getBoundingClientRect();
        const onScreen = b.left >= -1 && b.top >= -1 &&
          b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1;
        if (prev) root.setProperty('--ui-scale', prev); else root.removeProperty('--ui-scale');
        return onScreen;
      });
      T('armed forget needs two clicks', () => {
        closeCtx(); openMarkMenu(m, 120, 140);
        const btn = ctxEl.querySelectorAll('.dm-ctx-item.danger')[0];
        const n = state.marks.length;
        btn.click();
        const stillThere = state.marks.length === n && btn.classList.contains('confirm');
        btn.click();
        return stillThere && state.marks.length === n - 1;
      });
      T('menu closes', () => { closeCtx(); return !$('dm-ctx'); });

      /* ---- typable pickers (Category / Nest under / Reparent) ----
         These replaced three <select>s that COULD NOT OPEN in Ultralight, so
         everything here is new ground: the list, the filter, and the fact that
         Enter/Escape/arrows arrive at the pane's capture handler rather than
         at the input. */
      {
        const pm = markById('m7');
        const wasCat = pm.category, wasParent = pm.parentId;
        const K = (k, t) => onKey({ key: k, code: k, target: t,
          preventDefault() {}, stopPropagation() {} });
        const catPick = () => ctxEl.querySelectorAll('.dm-pick')[0];
        const nestPick = () => ctxEl.querySelectorAll('.dm-pick')[1];

        openMarkMenu(pm, 40, 40);
        T('picker: the list is shut until you touch the field', () =>
          catPick().querySelector('.dm-pick-list').classList.contains('hidden'));
        T('picker: clicking opens it with every category, the current one ticked', () => {
          catPick().querySelector('.dm-pick-input').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }));
          const list = catPick().querySelector('.dm-pick-list');
          const cur = list.querySelector('.dm-pick-row.cur');
          return !list.classList.contains('hidden') &&
            list.querySelectorAll('.dm-pick-row').length === state.categories.length &&
            !!cur && cur.textContent.indexOf(wasCat) !== -1;
        });
        T('picker: the current value starts highlighted, so Enter changes nothing', () => {
          const list = catPick().querySelector('.dm-pick-list');
          const hi = list.querySelector('.dm-pick-row.hi');
          return !!hi && hi.classList.contains('cur');
        });
        T('picker: typing filters as you type', () => {
          const inp = catPick().querySelector('.dm-pick-input');
          const other = state.categories.filter((c) => c !== wasCat)[0];
          inp.value = other.slice(0, 3);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          const rows = catPick().querySelectorAll('.dm-pick-row');
          return rows.length >= 1 && rows.length < state.categories.length &&
            rows[0].classList.contains('hi') &&
            rows[0].textContent.indexOf(other) !== -1;
        });
        T('picker: a filter that matches nothing says so, and Enter is a no-op', () => {
          const inp = catPick().querySelector('.dm-pick-input');
          inp.value = 'zzzz-no-such-category';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          const empty = !!catPick().querySelector('.dm-pick-empty');
          const cat0 = pm.category;
          K('Enter', inp);
          return empty && pm.category === cat0;
        });
        T('picker: Escape shuts the list and KEEPS the menu (a second one leaves)', () => {
          const inp = catPick().querySelector('.dm-pick-input');
          inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          K('Escape', inp);
          const shut = catPick().querySelector('.dm-pick-list').classList.contains('hidden');
          const stillOpen = !!$('dm-ctx');
          K('Escape', ctxEl);
          return shut && stillOpen && !$('dm-ctx');
        });
        T('picker: ArrowDown moves the highlight', () => {
          openMarkMenu(pm, 40, 40);
          const inp = catPick().querySelector('.dm-pick-input');
          inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const rows = () => catPick().querySelectorAll('.dm-pick-row');
          const first = Array.prototype.indexOf.call(rows(),
            catPick().querySelector('.dm-pick-row.hi'));
          K('ArrowDown', inp);
          const now = Array.prototype.indexOf.call(rows(),
            catPick().querySelector('.dm-pick-row.hi'));
          return now === (first + 1) % rows().length;
        });
        T('picker: Enter takes the highlighted row and re-files the domain', () => {
          const inp = catPick().querySelector('.dm-pick-input');
          const want = state.categories.filter((c) => c !== wasCat)[0];
          inp.value = want;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          K('Enter', inp);
          return pm.category === want && !$('dm-ctx');   // picking closes the menu
        });
        T('picker: clicking a row picks it too', () => {
          openMarkMenu(pm, 40, 40);
          const inp = catPick().querySelector('.dm-pick-input');
          inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const row = Array.prototype.filter.call(
            catPick().querySelectorAll('.dm-pick-row'),
            (r) => r.textContent.indexOf(wasCat) !== -1)[0];
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return pm.category === wasCat;
        });
        T('picker: "Nest under" offers Top level + every other domain, never itself', () => {
          openMarkMenu(pm, 40, 40);
          nestPick().querySelector('.dm-pick-input').dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }));
          const rows = nestPick().querySelectorAll('.dm-pick-row');
          const txt = Array.prototype.map.call(rows, (r) => r.textContent);
          return rows.length === topLevelMarks().length &&   // (others + Top level) - itself
            txt.some((t) => t.indexOf('Top level') !== -1) &&
            !txt.some((t) => t.indexOf(pm.name) !== -1);
        });
        T('picker: nesting through it actually re-parents', () => {
          const host = topLevelMarks().filter((p) => p.id !== pm.id)[0];
          const inp = nestPick().querySelector('.dm-pick-input');
          inp.value = host.name;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          K('Enter', inp);
          const ok = markById(pm.id).parentId === host.id;
          setParent(pm, wasParent || '');           // put the fixture back
          pm.category = wasCat;
          closeCtx(); render();
          return ok;
        });
      }

      /* ---- edits ---- */
      T('rename retargets a domain', () => {
        const t = markById('m6');
        renameMark(t, 'Solitude — the docks');
        return markById('m6').name === 'Solitude — the docks';
      });
      T('note edits land in the model', () => {
        const t = markById('m7');
        setNote(t, 'Guild business only');
        return markById('m7').note === 'Guild business only';
      });

      /* ---- renames must COMMIT through the real event path ----
         2026-08-02 regression: the model-level tests above stayed green while
         every in-game commit path was dead — the pane's window-capture
         stopPropagation killed the input's own Enter handler, and closeCtx
         removed a focused input before 'change' could fire. These three drive
         real dispatched events instead of calling the model. */
      T('typing in the menu Name field live-commits', () => {
        openMarkMenu(markById('m7'), 120, 140);
        const inp = ctxEl.querySelector('.dm-ctx-input');
        inp.value = 'Honeyside';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return markById('m7').name === 'Honeyside';
      });
      T('Enter in the Name field blurs via the capture handler, opens no menu', () => {
        const inp = ctxEl.querySelector('.dm-ctx-input');
        inp.focus();
        inp.value = 'Honeyside Manor';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        const menus = document.querySelectorAll('#dm-ctx').length;
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return markById('m7').name === 'Honeyside Manor' && document.activeElement !== inp &&
          document.querySelectorAll('#dm-ctx').length === menus;
      });
      T('closing the menu commits a still-focused field', () => {
        closeCtx();
        openMarkMenu(markById('m7'), 120, 140);
        const inp = ctxEl.querySelector('.dm-ctx-input');
        inp.focus();
        inp.value = 'Riften Honeyside';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        closeCtx();
        return markById('m7').name === 'Riften Honeyside' && !$('dm-ctx');
      });
      T('Enter in a rail rename commits instead of opening a mark menu', () => {
        ui.editing = true; render();
        const inp = els.railList.querySelector('.dm-rail-rename');
        if (!inp) { ui.editing = false; render(); return 'no rail rename input'; }
        inp.focus();
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const ok = !$('dm-ctx') && document.activeElement !== inp;
        ui.editing = false; render();
        return ok || 'a menu opened or the field kept focus';
      });
      T('reorder moves a domain in the list', () => {
        const first = state.marks[0].id, second = state.marks[1].id;
        reorderMark(first, second, true);
        return state.marks[0].id === second && state.marks[1].id === first;
      });
      T('drag onto a category re-files a domain', () => {
        const t = markById('m13');
        setCategory(t, 'Estates');
        return markById('m13').category === 'Estates';
      });
      T('renaming a category retargets its domains', () => {
        const idx = state.categories.indexOf('Dungeons');
        renameCategory(idx, 'Delves');
        return state.categories.indexOf('Delves') === idx && countIn('Delves') >= 3 && countIn('Dungeons') === 0;
      });
      T('deleting a category keeps its domains', () => {
        const n = state.marks.length, moved = countIn('Delves');
        deleteCategory('Delves'); deleteCategory('Delves');   // armed two-click
        return moved > 0 && state.marks.length === n && state.categories.indexOf('Delves') === -1 &&
          countIn(state.categories[0]) >= moved;
      });

      /* ---- persistence ---- */
      T('pdSave payload round-trips through the parser', () => {
        flushSave();
        const p = window.__dmSent.save;
        if (!p || !Array.isArray(p.marks) || p.marks.length !== state.marks.length) return false;
        const n = state.marks.length;
        onCfg(p);
        return state.marks.length === n && state.categories.length === p.categories.length;
      });
      T('parentId survives the pdSave → onCfg round-trip', () =>
        childrenOf('m1').length === 3 && markById('m19').parentId === 'm1' && !isChildMark(markById('m1')));

      /* ---- sub-areas (chevron tree) ---- */
      ui.cat = 'Estates'; setFilter(''); ui.expanded.clear(); render();
      T('a parent with sub-areas renders a chevron', () => {
        const row = els.list.querySelector('.dm-row[data-id="m1"]');
        return !!row && !!row.querySelector('.dm-chev:not(.spacer)');
      });
      T('a childless top-level row gets a spacer, not a chevron', () => {
        const row = els.list.querySelector('.dm-row[data-id="m4"]');
        return !!row && !!row.querySelector('.dm-chev.spacer') && !row.querySelector('.dm-chev:not(.spacer)');
      });
      T('sub-areas are hidden until the chevron is expanded', () =>
        !els.list.querySelector('.dm-row[data-id="m19"]'));
      T('toggling the chevron reveals the indented child rows', () => {
        toggleExpand('m1');
        const c = els.list.querySelector('.dm-row.dm-child[data-id="m19"]');
        return !!c;
      });
      T('collapsing the chevron hides them again', () => {
        toggleExpand('m1');
        return !els.list.querySelector('.dm-row[data-id="m19"]');
      });
      T('parent context menu adds Nest-under + Summon NPC', () => {
        openMarkMenu(markById('m4'), 120, 140);
        const labels = Array.prototype.map.call(ctxEl.querySelectorAll('.dm-ctx-field label'), (l) => l.textContent);
        const ok = labels.indexOf('Nest under') !== -1 && /Summon NPC/i.test(ctxEl.textContent);
        closeCtx();
        return ok;
      });
      T('nesting a top-level mark files it under a parent (indented)', () => {
        setParent('m4', 'm1');   // m4 = Breezehome cellar (Estates)
        return markById('m4').parentId === 'm1' && childrenOf('m1').length === 4 &&
          !!els.list.querySelector('.dm-row.dm-child[data-id="m4"]');   // parent auto-expanded
      });
      T('a mark that has sub-areas cannot itself be nested', () => {
        setParent('m1', 'm2');   // m1 has children → refused, stays top level
        return markById('m1').parentId === '';
      });
      T('child menu: move-out + move-to + summon, no Category picker', () => {
        openChildMenu(markById('m4'), 120, 140);
        const labels = Array.prototype.map.call(ctxEl.querySelectorAll('.dm-ctx-field label'), (l) => l.textContent);
        const hasReparent = labels.indexOf('Reparent') !== -1;
        const noCat = labels.indexOf('Category') === -1;
        const hasMoveOut = /top level/i.test(ctxEl.textContent);
        const hasSummon = /Summon NPC/i.test(ctxEl.textContent);
        closeCtx();
        return hasReparent && noCat && hasMoveOut && hasSummon;
      });
      T('move-out returns a sub-area to the top level', () => {
        setParent('m4', '');
        return markById('m4').parentId === '' && childrenOf('m1').length === 3 &&
          !!els.list.querySelector('.dm-row[data-id="m4"]:not(.dm-child)');
      });
      T('deleting a parent promotes its sub-areas to top level', () => {
        const kids = childrenOf('m1').map((c) => c.id);
        const n = state.marks.length;
        deleteMark(markById('m1'));
        return kids.length === 3 && state.marks.length === n - 1 && !markById('m1') &&
          kids.every((id) => markById(id) && markById(id).parentId === '');
      });
      T('search on a sub-area auto-expands its (collapsed) parent', () => {
        setParent('m20', 'm19');   // m19/m20 are top-level after the promotion above
        ui.expanded.clear(); ui.cat = ALL;
        setFilter('undercroft');   // matches only m20's long name
        const parentShown = !!els.list.querySelector('.dm-row[data-id="m19"]');
        const childShown = !!els.list.querySelector('.dm-row.dm-child[data-id="m20"]');
        setFilter(''); ui.cat = ALL; render();
        return parentShown && childShown;
      });

      /* ---- open key capture ---- */
      ui.shown = true;
      T('capture binds a keyboard key', () => {
        startCapture();
        onKey({ key: 'F8', code: 'F8', preventDefault() {}, stopPropagation() {} });
        return state.openKey.code === 0x42 && state.openKey.label === 'F8';
      });
      T('capture binds a bridged F-key via hdExtKey', () => {
        startCapture();
        const consumed = receive('hdExtKey', { name: 'F15', raw: 102, mapped: 102 });
        return consumed && state.openKey.code === 102 && state.openKey.label === 'F15';
      });
      T('capture modal closes after binding', () => els.capture.classList.contains('hidden') && !ui.capture);
      T('hdExtKey is ignored when not capturing', () => receive('hdExtKey', { name: 'F13', raw: 100 }) === false);
      T('hdClosed is observed, not swallowed', () => {
        // must stay false, or the chained app.js hdClosed never hides the overlay
        const consumed = receive('pdClosed');
        ui.shown = true;
        return consumed === false;
      });
      T('chained hdClosed still reaches the host handler', () => {
        let reached = false;
        const prev = window.hdClosed;
        window.hdClosed = function () { reached = true; };
        chain('hdClosed', 'pdClosed');
        window.hdClosed();
        window.hdClosed = prev;
        ui.shown = true;
        return reached;
      });

      /* ---- layout guards ---- */
      ui.cat = ALL; setFilter(''); render();
      T('pane never scrolls horizontally', () => els.pane.scrollWidth <= els.pane.clientWidth + 1);
      T('rows stay inside the list box', () => {
        const lb = els.list.getBoundingClientRect();
        return Array.prototype.every.call(els.list.children,
          (r) => r.getBoundingClientRect().right <= lb.right + 1);
      });
      T('the mark button stays inside the pane', () => {
        const pb = els.pane.getBoundingClientRect(), fb = els.foot.getBoundingClientRect();
        return fb.bottom <= pb.bottom + 1 && fb.top >= pb.top;
      });
      T('long names ellipsize instead of wrapping', () => {
        const row = els.list.querySelector('.dm-row[data-id="m14"] .dm-name');
        return !!row && row.scrollWidth > row.clientWidth && row.getBoundingClientRect().height < 30;
      });
      T('an expanded sub-area ellipsizes its long name and stays in the box', () => {
        ui.cat = ALL; setFilter(''); ui.expanded.clear(); toggleExpand('m19'); // reveal m20 (long-named child)
        const row = els.list.querySelector('.dm-row.dm-child[data-id="m20"]');
        if (!row) return false;
        const name = row.querySelector('.dm-name');
        const lb = els.list.getBoundingClientRect();
        return name.scrollWidth > name.clientWidth && name.getBoundingClientRect().height < 30 &&
          row.getBoundingClientRect().right <= lb.right + 1;
      });

      /* ---- per-domain row image (convention: domain-images/<id>.<ext>) ---- */
      ui.cat = ALL; setFilter(''); ui.expanded.clear();
      T('image thumb: a loadable image renders the art layer in place of the medal', () => {
        // m7 survives the earlier ctx-menu forget (which removed m5)
        noImage.clear(); TEST_IMG.m7 = SELFTEST_PX; render();
        const row = els.list.querySelector('.dm-row[data-id="m7"]');
        return !!row && !!row.querySelector('.dm-thumb-box .dm-art') && !row.querySelector('.dm-medal');
      });
      T('image thumb: a broken image falls back to the initials medal', () => {
        noImage.clear(); delete TEST_IMG.m8; render();
        const row = els.list.querySelector('.dm-row[data-id="m8"]');
        const probe = row && row.querySelector('img.dm-probe');
        if (!probe) return false;
        // drive the onerror chain through every candidate, synchronously
        for (let k = 0; k < IMG_EXTS.length + 2; k++) probe.dispatchEvent(new Event('error'));
        return noImage.has('m8') && !!row.querySelector('.dm-medal') && !row.querySelector('.dm-thumb-box');
      });
      T('image thumb: negative cache stops re-probing an imageless domain', () => {
        // with every id known-imageless, a render must build medals directly
        Object.keys(TEST_IMG).forEach((k) => delete TEST_IMG[k]); noImage.clear();
        const hadImages = state.marks.filter((m) => m.image);
        hadImages.forEach((m) => { m.__img = m.image; m.image = ''; });
        state.marks.forEach((m) => noImage.add(m.id));
        render();
        const ok = els.list.querySelectorAll('.dm-thumb-box').length === 0 &&
          els.list.querySelectorAll('.dm-medal').length === rowCount();
        hadImages.forEach((m) => { m.image = m.__img; delete m.__img; });
        return ok;
      });
      // leave the caches clean for the tabs after this
      Object.keys(TEST_IMG).forEach((k) => delete TEST_IMG[k]);
      noImage.clear(); render();

      /* ---- Summon NPC picker (async: dev pdNpcList replies after ~12ms) ---- */
      ui.cat = ALL; setFilter(''); ui.expanded.clear(); render();
      const npcTarget = markById('m14');
      openNpcPicker(npcTarget, 120, 120);
      T('NPC picker requests the roster (pdNpcList) and opens', () =>
        window.__dmSent.npcList >= 1 && !!npcEl);
      T('NPC picker shows a loading state until pdNpcs arrives', () =>
        !!npcEl.querySelector('.dm-npc-empty') && /looking/i.test(npcEl.textContent));

      setTimeout(() => {
        T('NPC picker renders the pdNpcs roster', () =>
          npcEl.querySelectorAll('.dm-npc-item').length === 6);
        T('followers are listed first', () => {
          const tag = npcEl.querySelector('.dm-npc-item .dm-npc-tag');
          return !!tag && tag.classList.contains('follower');
        });
        T('NPC search filters by name and highlights the hit', () => {
          ui.npcFilter = 'ysolda';
          const inp = npcEl.querySelector('.dm-npc-search'); if (inp) inp.value = 'ysolda';
          renderNpcList();
          return npcEl.querySelectorAll('.dm-npc-item').length === 1 && !!npcEl.querySelector('.dm-npc-item mark');
        });
        T('clicking an NPC sends pdNpcTo with the key + target mark', () => {
          npcEl.querySelector('.dm-npc-item').click();
          const p = window.__dmSent.npcTo;
          return !!p && p.npcKey === '0x0001A696' && !!p.mark &&
            p.mark.name === npcTarget.name && p.mark.cellId === (npcTarget.cellId >>> 0);
        });
        T('clicking an NPC closes the picker', () => !npcEl && !$('dm-npc'));


      /* ---- place photos: crop model, draw sites, bridge ---- */
      ui.cat = ALL; setFilter(''); ui.tagFilter = ''; ui.expanded.clear();
      Object.keys(TEST_IMG).forEach((k) => delete TEST_IMG[k]);
      noImage.clear(); render();
      const CROPPED_FILE = 'pd-cropped-m7.png';

      T('crop: the key is the bare file name — no folder, no cache-buster', () =>
        DomainsPane._crop.keyOf('domain-images/pd-x.png?v=17300') === 'pd-x.png' &&
        DomainsPane._crop.keyOf('pd-x.png') === 'pd-x.png');
      T('crop: anything that is not a plain sibling is uncroppable, not sanitised', () =>
        !DomainsPane._crop.keyOf('') && !DomainsPane._crop.keyOf('..') &&
        !DomainsPane._crop.keyOf('a/../..') && !DomainsPane._crop.keyOf('C:x.png'));
      T('crop: zoom 1 permits no pan at all', () =>
        DomainsPane._crop.clamp({ z: 1, x: 0.4, y: -0.4 }) === null);
      T('crop: pan is clamped to (z-1)/2 on BOTH axes', () => {
        const c = DomainsPane._crop.clamp({ z: 2, x: 9, y: -9 });
        return c && Math.abs(c.x - 0.5) < 1e-9 && Math.abs(c.y + 0.5) < 1e-9;
      });
      T('crop: zoom is clamped to its ceiling', () =>
        DomainsPane._crop.clamp({ z: 99, x: 0, y: 0 }).z === DomainsPane._crop.ZMAX);
      T('crop: garbage in is an identity crop, never NaN on screen', () =>
        DomainsPane._crop.clamp({ z: 'banana', x: null, y: undefined }) === null &&
        DomainsPane._crop.clamp(null) === null && DomainsPane._crop.clamp('x') === null);
      T('crop: the config carried the map in, keyed by file', () =>
        !!state.imageCrops[CROPPED_FILE] && state.imageCrops[CROPPED_FILE].z === 1.8);

      T('photo: a photographed domain draws its picture, not the medallion', () => {
        const row = els.list.querySelector('.dm-row[data-id="m7"]');
        return !!row && !!row.querySelector('.dm-thumb-box .dm-art') && !row.querySelector('.dm-medal');
      });
      T('photo: the stored crop is painted on the row', () => {
        const row = els.list.querySelector('.dm-row[data-id="m7"]');
        const art = row && row.querySelector('.dm-art');
        if (!art) return false;
        /* The probe load is async in a real browser, so drive it: the art layer
           only gets its background + transform once a candidate reports load. */
        const probe = row.querySelector('img.dm-probe');
        if (probe) probe.dispatchEvent(new Event('load'));
        return /scale\(1\.8/.test(art.style.transform) && /translate\(12/.test(art.style.transform);
      });
      T('photo: a picture the map has never seen draws AS SHOT — this is what makes '
        + 'double-cropping impossible', () => {
        const row = els.list.querySelector('.dm-row[data-id="m9"]');
        const art = row && row.querySelector('.dm-art');
        if (!art) return false;
        const probe = row.querySelector('img.dm-probe');
        if (probe) probe.dispatchEvent(new Event('load'));
        return !art.style.transform;
      });
      T('photo: a domain with no picture falls back to its hue medallion, deliberately', () => {
        const row = els.list.querySelector('.dm-row[data-id="m4"]');
        const probe = row && row.querySelector('img.dm-probe');
        if (!probe) return false;
        // every candidate 404s — in a browser that is async, so drive it
        for (let k = 0; k < IMG_EXTS.length + 2; k++) probe.dispatchEvent(new Event('error'));
        const medal = row.querySelector('.dm-medal');
        return !!medal && !!medal.style.getPropertyValue('--dm-hue') && noImage.has('m4');
      });
      T('photo: the crop layer is a CHILD of the box, never the box itself — the '
        + 'clip and border must not scale with the picture', () => {
        const row = els.list.querySelector('.dm-row[data-id="m7"]');
        const box = row && row.querySelector('.dm-thumb-box');
        return !!box && !box.style.transform && !!box.querySelector('.dm-art');
      });

      T('photo: the menu offers Photograph, and View/Adjust/Remove only once there is one', () => {
        openMarkMenu(markById('m7'), 120, 140);
        const withPhoto = ctxEl.textContent;
        closeCtx();
        openMarkMenu(markById('m4'), 120, 140);
        const without = ctxEl.textContent;
        closeCtx();
        return withPhoto.indexOf('Re-photograph') !== -1 && withPhoto.indexOf('View photo') !== -1 &&
          withPhoto.indexOf('Remove photo') !== -1 &&
          without.indexOf('Photograph this place') !== -1 && without.indexOf('View photo') === -1;
      });
      T('photo: "Photograph this place" sends pdPhoto with the domain id', () => {
        window.__dmSent.photo = null;
        photographPlace(markById('m4'));
        return !!window.__dmSent.photo && window.__dmSent.photo.id === 'm4';
      });
      T('photo: pdPhotoSaved hangs the file on the right domain', () => {
        receive('pdPhotoSaved', { id: 'm4', image: 'domain-images/pd-fresh-m4.png' });
        const ok = markById('m4').image === 'domain-images/pd-fresh-m4.png';
        markById('m4').image = '';   // leave the fixture as it was
        noImage.clear(); render();
        return ok;
      });

      T('crop editor: opens on the photographed domain and shows the current framing', () => {
        openArt(markById('m7'), false);
        const lb = document.querySelector('.dm-art-lb');
        return !!lb && lb.textContent.indexOf('180%') !== -1;
      });
      T('crop editor: the frame is SQUARE, because the row medallion is', () => {
        const fr = document.querySelector('.dm-art-frame');
        return !!fr && fr.style.width === fr.style.height;
      });
      T('crop editor: ✎ enters edit mode and ± nudges the zoom', () => {
        const before = document.querySelector('.dm-art-frame').classList.contains('editing');
        document.querySelector('.dm-art-btn').click();     // ✎ Adjust this photo
        const now = document.querySelector('.dm-art-frame').classList.contains('editing');
        const val0 = document.querySelector('.dm-art-val').textContent;
        artKey({ key: '+', preventDefault: function () {}, stopPropagation: function () {} });
        const val1 = document.querySelector('.dm-art-val').textContent;
        return !before && now && val0 !== val1;
      });
      T('crop editor: Save sends pdCropSave with the FILE as the key', () => {
        window.__dmSent.crop = null;
        artKey({ key: 'Enter', preventDefault: function () {}, stopPropagation: function () {} });
        const p = window.__dmSent.crop;
        return !!p && p.file === CROPPED_FILE && p.z > 1.8;
      });
      T('crop editor: Esc closes the overlay and leaves nothing on the body', () => {
        artKey({ key: 'Escape', preventDefault: function () {}, stopPropagation: function () {} });
        return !document.querySelector('.dm-art-lb');
      });
      T('crop: a cleared crop is sent as an explicit clear, never as z=1', () => {
        openArt(markById('m7'), true);
        window.__dmSent.crop = null;
        document.querySelector('.dm-art-reset').click();
        artKey({ key: 'Enter', preventDefault: function () {}, stopPropagation: function () {} });
        const p = window.__dmSent.crop;
        closeArt();
        return !!p && p.clear === true && p.file === CROPPED_FILE;
      });
      T('crop: hiding the tab takes the overlay with it', () => {
        openArt(markById('m7'), false);
        onHide(); ui.shown = true;
        const gone = !document.querySelector('.dm-art-lb');
        const pane = $('dm-pane'); if (pane) pane.classList.remove('hidden');
        return gone;
      });
      T('crop: a whole map from C++ is clamped and file-name-checked on the way in', () => {
        setCrops({ 'ok.png': { z: 2, x: 9, y: 0 }, 'a/b.png': { z: 2, x: 0, y: 0 },
                   'flat.png': { z: 1, x: 0, y: 0 } });
        const ok = state.imageCrops['ok.png'] && Math.abs(state.imageCrops['ok.png'].x - 0.5) < 1e-9 &&
          !state.imageCrops['a/b.png'] && !state.imageCrops['flat.png'];
        setCrops({ 'pd-cropped-m7.png': { z: 1.8, x: 0.12, y: -0.2 } });   // restore the fixture
        return ok;
      });
      T('crop: a pdSave payload carries the photo, and NOT the crop map (C++ owns it)', () => {
        const pay = payload();
        const m7 = pay.marks.find((m) => m.id === 'm7');
        return !!m7 && m7.image === 'domain-images/pd-cropped-m7.png' && pay.imageCrops === undefined;
      });
      noImage.clear(); render();

      /* ---- click a picture to enlarge it ----
         "on domains if i click the image can it do a lightbox of the image."
         Two different lightboxes reachable from one row: the PLACE photo is
         ours, a FACE is the Followers pane's. Both must open on click, neither
         may travel, and neither may outlive the tab. */
      const clickIt = (el) => el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }));

      T('enlarge: only a picture that actually DREW grows the ⛶ view button', () => {
        // The box exists before anything is known to load; the affordance may
        // not, or an imageless domain would advertise a photo it hasn't got.
        noImage.clear(); TEST_IMG.m7 = SELFTEST_PX; render();
        const box = els.list.querySelector('.dm-row[data-id="m7"] .dm-thumb-box');
        if (!box) return false;
        const beforeLoad = box.classList.contains('zoom') || !!box.querySelector('.dm-zoomer');
        box.querySelector('img.dm-probe').dispatchEvent(new Event('load'));
        const z = box.querySelector('.dm-zoomer');
        return !beforeLoad && box.classList.contains('zoom') &&
          !!z && z.title.indexOf('enlarge') !== -1 &&
          !medalFor(markById('m8')).classList.contains('zoom');
      });
      T('enlarge: the ⛶ opens the place lightbox, and does NOT travel', () => {
        closeArt();
        const z = els.list.querySelector('.dm-row[data-id="m7"] .dm-zoomer');
        const before = window.__dmSent.recall;
        clickIt(z);
        const ok = !!document.querySelector('.dm-art-lb') && window.__dmSent.recall === before;
        closeArt();
        return ok;
      });
      T('enlarge: the hero image itself is part of the card — clicking it TRAVELS', () => {
        closeArt();
        const box = els.list.querySelector('.dm-row[data-id="m7"] .dm-thumb-box');
        const before = window.__dmSent.recall;
        clickIt(box);                                  // must bubble to the card
        return window.__dmSent.recall !== before && !document.querySelector('.dm-art-lb');
      });
      T('enlarge: an imageless hero keeps the card click — no dead "enlarge" target', () => {
        noImage.clear(); delete TEST_IMG.m8; render();
        const box = els.list.querySelector('.dm-row[data-id="m8"] .dm-thumb-box');
        if (!box || box.classList.contains('zoom') || box.querySelector('.dm-zoomer')) return false;
        const before = window.__dmSent.recall;
        clickIt(box);                                  // must bubble to the row
        return window.__dmSent.recall !== before && !document.querySelector('.dm-art-lb');
      });
      T('enlarge: a picture the MARK does not name still opens (convention file)', () => {
        // The `domain-images/<id>.<ext>` walk is the thumbnail's private
        // knowledge; without the url override openArt would deny a photo that
        // is plainly on screen.
        openArt(markById('m4'), false, 'domain-images/pd-conv-m4.png');
        const ok = !!document.querySelector('.dm-art-lb');
        closeArt();
        return ok;
      });
      /* The face tests own their roster. The shared fixture's Lydia lives on a
         domain earlier tests may have un-nested or renamed, and "whichever
         face happens to be first" is how a green suite ends up asserting
         nothing. Two people: one the Followers pane can resolve by NAME, one it
         cannot — which is exactly the url-fallback path. */
      const origRoster = window.FolPane.rosterForDomains;
      const host = topLevelMarks()[0];
      window.FolPane.rosterForDomains = () => [
        { name: 'Lydia',  home: host.name, formId: '0x000A2C8E',
          portraitUrl: 'portraits/lydia~2.png?v=1712' },
        { name: 'Jordis', home: host.name, formId: '0x0001A2B1',
          portraitUrl: 'portraits/jordis~1.png?v=7' },
        { name: 'Uthgerd', home: host.name, formId: '0x0001A2B2', portraitUrl: null },
      ];
      render();
      const hostFaces = () => els.list.querySelectorAll(
        '.dm-row[data-id="' + host.id + '"] .dm-face');
      const zoomFace = () => els.list.querySelector(
        '.dm-row[data-id="' + host.id + '"] .dm-face.zoom');
      T('enlarge: a face with a photo is a zoom target, an initials face is not', () => {
        const all = hostFaces();
        return all.length === 3 && all[0].classList.contains('zoom') &&
          !all[2].classList.contains('zoom') && !!all[2].querySelector('.dm-face-medal') &&
          all[0].title.indexOf('enlarge') !== -1 &&
          all[2].title.indexOf('Uthgerd') === 0 && all[2].title.indexOf('enlarge') === -1;
      });
      T('enlarge: clicking a face opens the FOLLOWERS lightbox on that photo', () => {
        window.__dmSent.lightbox = null;
        clickIt(zoomFace());
        const d = window.__dmSent.lightbox;
        return !!document.querySelector('.fd-lb') && !!d &&
          d.file === 'lydia~2.png' && d.slug === 'lydia' && d.name === 'Lydia';
      });
      T('enlarge: a face that pane cannot resolve still opens, via the url', () => {
        window.__dmSent.lightbox = null;
        clickIt(hostFaces()[1]);                       // Jordis: portraitInfoFor → null
        const d = window.__dmSent.lightbox;
        return !!d && d.file === 'jordis~1.png' && d.slug === 'jordis' && d.mtime === 7;
      });
      T('enlarge: an initials face opens nothing and does not travel', () => {
        DomainsPane.closeOverlays();
        window.__dmSent.lightbox = null;
        const before = window.__dmSent.recall;
        clickIt(hostFaces()[2]);                       // Uthgerd: no photo at all
        return !document.querySelector('.fd-lb') && !window.__dmSent.lightbox &&
          window.__dmSent.recall === before;
      });
      T('enlarge: Escape is handed to the pane that owns the overlay, and closes it', () => {
        clickIt(zoomFace());
        if (!document.querySelector('.fd-lb')) return false;
        const before = window.__dmSent.lbKeys;
        onKey({ key: 'Escape', code: 'Escape', keyCode: 27,
                preventDefault() {}, stopPropagation() {} });
        return window.__dmSent.lbKeys === before + 1 && !document.querySelector('.fd-lb');
      });
      T('enlarge: a borrowed lightbox never outlives the tab', () => {
        clickIt(zoomFace());
        const opened = !!document.querySelector('.fd-lb');
        onHide(); ui.shown = true;
        const pane = $('dm-pane'); if (pane) pane.classList.remove('hidden');
        return opened && !document.querySelector('.fd-lb');
      });
      T('enlarge: closeOverlays() drops BOTH lightboxes (hdClosed calls it)', () => {
        openArt(markById('m7'), false);
        clickIt(zoomFace());
        const both = !!document.querySelector('.fd-lb');
        DomainsPane.closeOverlays();
        return both && !document.querySelector('.fd-lb') && !document.querySelector('.dm-art-lb');
      });
      T('enlarge: the two overlays never stack — a face closes the place photo', () => {
        openArt(markById('m7'), false);
        clickIt(zoomFace());
        const ok = !!document.querySelector('.fd-lb') && !document.querySelector('.dm-art-lb');
        DomainsPane.closeOverlays();
        return ok;
      });
      T('enlarge: a "who is here" face opens on the file the strip is drawing', () => {
        const m = { cellId: 0x1234, name: 'Test' };
        who.members = [{ name: 'Jordis', original: 'Jordis', formId: '0x1', whereId: 0x1234 }];
        who.byCell = null;
        who.portraits = { jordis: { slug: 'jordis', file: 'jordis.png', mtime: 42 } };
        const strip = whoStrip(m);
        const face = strip.querySelector('.dm-who-face');
        window.__dmSent.lightbox = null;
        const ok0 = face.classList.contains('zoom');
        clickIt(face);
        const d = window.__dmSent.lightbox;
        DomainsPane.closeOverlays();
        who.members = []; who.byCell = null; who.portraits = {};
        // portraitInfoFor only knows Lydia, so this one resolved through the
        // url fallback — which is the point: the strip already knows the file.
        return ok0 && !!d && d.file === 'jordis.png' && d.mtime === 42;
      });
      T('enlarge: url parsing survives a re-capture suffix and a cache-buster', () => {
        const i = lbInfoFromUrl('portraits/aela-huntress~3.png?v=1712');
        const j = lbInfoFromUrl('portraits/plain.jpg');
        return i.slug === 'aela-huntress' && i.file === 'aela-huntress~3.png' && i.mtime === 1712 &&
          i.ext === 'png' && j.mtime === 0 && j.ext === 'jpg' &&
          lbInfoFromUrl('') === null && lbInfoFromUrl(null) === null;
      });
      /* ---- scene staging (time / sky / exposure) ----
         The photo is of a PLACE; a place at 3am in a blizzard is a black
         rectangle. These prove the three knobs reach the payload and the ini,
         and that "as-is" really means "send nothing". */
      {
        const sceneBox = () => ctxEl && ctxEl.querySelector('.dm-scene');
        const chips = (label) => {
          const rows = ctxEl.querySelectorAll('.dm-scene-row');
          for (let i = 0; i < rows.length; i++) {
            const l = rows[i].querySelector('.dm-scene-lbl');
            if (l && l.textContent === label) return rows[i].querySelectorAll('.dm-scene-chip');
          }
          return [];
        };
        const chipNamed = (label, text) => Array.prototype.filter.call(
          chips(label), (c) => c.textContent.indexOf(text) !== -1)[0];
        const pm = markById('m7');

        scene.hour = -1; scene.weather = 0; scene.info = null;
        openMarkMenu(pm, 40, 40);
        T('scene: the block is in the menu, with Time / Sky / Bright rows', () => {
          const box = sceneBox();
          if (!box) return false;
          const labels = Array.prototype.map.call(
            box.querySelectorAll('.dm-scene-lbl'), (l) => l.textContent);
          return labels.join(',') === 'Time,Sky,Bright';
        });
        T('scene: opening the menu ASKS the game (the hour must not be stale)', () =>
          window.__dmSent.scene > 0);
        T('scene: it says it is reading until the answer lands', () =>
          sceneBox().querySelector('.dm-scene-now').textContent.indexOf('reading') !== -1);
        T('scene: the answer names the hour and the sky that are out there now', () => {
          window.pdSceneInfo(JSON.stringify(window.__dmScene));
          const now = sceneBox().querySelector('.dm-scene-now').textContent;
          return now.indexOf('9:47pm') !== -1 && now.indexOf('SkyrimOvercast') !== -1;
        });
        T('scene: nothing is staged by default — As-is is the chosen chip', () =>
          chipNamed('Time', 'As-is').classList.contains('on') &&
          chipNamed('Sky', 'As-is').classList.contains('on'));
        T('scene: a kind this load order has no weather for is shown, disabled', () => {
          const snow = chipNamed('Sky', 'Snow');
          return !!snow && snow.disabled && snow.title.indexOf('no snow weather') !== -1;
        });
        T('scene: picking Noon marks it and unmarks As-is', () => {
          chipNamed('Time', 'Noon').click();
          return scene.hour === 12 && chipNamed('Time', 'Noon').classList.contains('on') &&
            !chipNamed('Time', 'As-is').classList.contains('on');
        });
        T('scene: picking Clear stages that weather\'s real FormID', () => {
          chipNamed('Sky', 'Clear').click();
          return scene.weather === 0x00010E1F;
        });
        T('scene: the photo request carries the staged hour and sky', () => {
          window.__dmSent.photo = null;
          photographPlace(pm);
          const p = window.__dmSent.photo;
          return !!p && p.id === pm.id && p.hour === 12 && p.weather === 0x00010E1F;
        });
        T('scene: "as-is" sends NOTHING, so a photo behaves exactly as before', () => {
          scene.hour = -1; scene.weather = 0;
          window.__dmSent.photo = null;
          photographPlace(pm);
          const p = window.__dmSent.photo;
          return !!p && p.hour === undefined && p.weather === undefined;
        });

        openMarkMenu(pm, 40, 40);
        window.pdSceneInfo(JSON.stringify(window.__dmScene));
        const expVal = () => ctxEl.querySelector('.dm-scene-val').textContent;
        const expStep = (i) => ctxEl.querySelectorAll('.dm-scene-step')[i];
        T('scene: exposure starts at "as rendered" — no silent tone mapping', () =>
          expVal() === 'as rendered' && sceneExposure() === 0);
        T('scene: + writes one step through pdSceneSet and shows it in stops', () => {
          expStep(1).click();
          const sent = window.__dmSent.sceneSet;
          return !!sent && Math.abs(sent.exposure - 0.25) < 1e-6 &&
            expVal().indexOf('+0.25 stop') === 0;
        });
        T('scene: a Reset appears once it is non-zero, and clears it', () => {
          const reset = chipNamed('Bright', 'Reset');
          if (!reset) return false;
          reset.click();
          return window.__dmSent.sceneSet.exposure === 0 && expVal() === 'as rendered' &&
            !chipNamed('Bright', 'Reset');
        });
        T('scene: the stepper cannot walk past the limit the game reported', () => {
          for (let i = 0; i < 40; i++) expStep(1).click();
          const v = sceneExposure();
          const ok = v === window.__dmScene.exposureMax;
          // and the view believes the ANSWER, not what it asked for
          window.__dmScene.exposure = 1.5;
          window.pdSceneInfo(JSON.stringify(window.__dmScene));
          const took = sceneExposure() === 1.5;
          setExposure(0);
          return ok && took;
        });
        T('scene: negative stops read as darker, not as a minus sign glitch', () => {
          expStep(0).click();
          return expVal().indexOf('\u2212') === 0 && sceneExposure() < 0;
        });
        setExposure(0);
        closeCtx();
        scene.hour = -1; scene.weather = 0;
      }

      T('enlarge: a Followers pane without the seam is a no-op, never a throw', () => {
        const orig = window.FolPane;
        window.FolPane = { rosterForDomains: orig.rosterForDomains };   // no lightbox
        render();
        let threw = false;
        try { clickIt(els.list.querySelector('.dm-face')); }
        catch (e) { threw = true; }
        const none = !document.querySelector('.fd-lb');
        window.FolPane = orig;
        render();
        return !threw && none;
      });
      noImage.clear(); render();

      /* ---- tags ---- */
      T('tags: normalisation folds "Inn", "inn " and " INN" into ONE tag', () => {
        const merged = DomainsPane._tags.merge([], ['Inn', 'inn ', ' INN', '\tinn\n']);
        return merged.length === 1 && merged[0] === 'Inn';   // first spelling wins
      });
      T('tags: inner whitespace is collapsed, not just trimmed', () =>
        DomainsPane._tags.norm('  warm   bed \t ') === 'warm bed');
      T('tags: an over-long tag is capped', () =>
        DomainsPane._tags.norm('x'.repeat(200)).length === DomainsPane._tags.MAX_LEN);
      T('tags: junk in a hand-edited config degrades to no tags, never to a throw', () =>
        DomainsPane._tags.merge([], { a: 1 }).length === 0 &&
        DomainsPane._tags.merge([], [null, 3, {}, [], '   ']).length === 0 &&
        DomainsPane._tags.merge(null, undefined).length === 0);
      T('tags: the per-domain cap holds', () => {
        const many = []; for (let k = 0; k < 40; k++) many.push('tag' + k);
        return DomainsPane._tags.merge([], many).length === DomainsPane._tags.MAX;
      });
      T('tags: they render on the row, capped, with a +N pill for the rest', () => {
        const row = els.list.querySelector('.dm-row[data-id="m2"]');
        const chips = row ? row.querySelectorAll('.dm-tag') : [];
        const more = row ? row.querySelector('.dm-tag.more') : null;
        return chips.length === TAG_ROW_CAP + 1 && !!more && more.textContent === '+4';
      });
      T('tags: eight tags do not shove the row wider than the list', () => {
        const row = els.list.querySelector('.dm-row[data-id="m2"]');
        const lb = els.list.getBoundingClientRect();
        return row.getBoundingClientRect().right <= lb.right + 1 &&
          els.list.scrollWidth <= els.list.clientWidth + 1;
      });
      T('tags: the search box matches a tag', () => {
        setFilter('rumours');
        const hit = visibleRows().length === 1 && visibleRows()[0].m.id === 'm2';
        setFilter('');
        return hit;
      });
      T('tags: clicking a tag chip filters by it, case-insensitively across spellings', () => {
        const row = els.list.querySelector('.dm-row[data-id="m2"]');
        row.querySelector('.dm-tag').click();        // "Inn"
        /* m3 carries "inn" in lower case — a filter that misses it is exactly
           the bug normalisation exists to prevent. */
        const ids = visibleRows().map((r) => r.m.id);
        return ui.tagFilter === 'inn' && ids.indexOf('m2') !== -1 && ids.indexOf('m3') !== -1 &&
          ids.indexOf('m1') === -1;
      });
      T('tags: the filter bar says which tag, and clears on click', () => {
        const bar = $('dm-tagbar');
        const shown = !!bar && !bar.classList.contains('hidden') && bar.textContent.indexOf('Inn') !== -1;
        bar.querySelector('.dm-tag').click();
        return shown && !ui.tagFilter && visibleRows().length > 2;
      });
      T('tags: the tag filter ANDs with the search box rather than replacing it', () => {
        setTagFilter('inn'); setFilter('mistveil');
        const ids = visibleRows().map((r) => r.m.id);
        setFilter(''); setTagFilter('');
        return ids.length === 1 && ids[0] === 'm2';
      });
      T('tags: the menu edits them — add normalises, ✕ removes', () => {
        const m = markById('m4');
        m.tags = [];
        openMarkMenu(m, 120, 140);
        const inp = ctxEl.querySelector('.dm-ctx-input.tag');
        inp.value = '  Deep  Cave ';
        commitTagInput(m, inp);
        const added = m.tags.length === 1 && m.tags[0] === 'Deep Cave' && inp.value === '';
        removeTagFrom(m, 'DEEP cave');            // fold applies to removal too
        closeCtx();
        return added && m.tags.length === 0;
      });
      T('tags: a comma in the field commits the part before it', () => {
        const m = markById('m4');
        m.tags = [];
        openMarkMenu(m, 120, 140);
        const inp = ctxEl.querySelector('.dm-ctx-input.tag');
        inp.value = 'cold,';
        inp.dispatchEvent(new Event('input'));
        const ok = m.tags.length === 1 && m.tags[0] === 'cold' && inp.value === '';
        m.tags = []; closeCtx();
        return ok;
      });
      T('tags: forgetting a domain takes its tags with it — no orphan bookkeeping', () => {
        const before = state.marks.length;
        const doomed = markById('m3');
        setTagFilter('inn');
        deleteMark(doomed);
        /* the filter drops itself the moment nothing carries the tag it names */
        return state.marks.length === before - 1 && !markById('m3') &&
          (ui.tagFilter === 'inn' ? state.marks.some((m) => hasTag(m, 'inn')) : true);
      });
      T('tags: they ride in the pdSave payload every time, so removing the last one sticks', () => {
        setTagFilter('');
        const pay = payload();
        const m6 = pay.marks.find((m) => m.id === 'm6');
        const m4 = pay.marks.find((m) => m.id === 'm4');
        return !!m6 && m6.tags.length === 3 && !!m4 && Array.isArray(m4.tags) && m4.tags.length === 0;
      });
      T('tags + crops: a config round trip preserves both — a payload that omits '
        + 'imageCrops must not wipe the map', () => {
        const pay = payload();          // the pane's own save shape: no imageCrops key
        onCfg(pay);
        const m6 = markById('m6');
        return !!m6 && m6.tags.length === 3 && m6.tags[0] === 'Estate' &&
          !!state.imageCrops['pd-cropped-m7.png'];
      });
      T('tags: Omni indexes them, so Ctrl+F finds a domain by tag', () => {
        /* the provider is registered against the live state, so re-derive the
           same index it builds rather than reaching into HDOmni's internals */
        const idx = (state.marks || []).map((m) => ({
          label: m.name,
          keywords: [m.cellEdid, m.worldspaceName].concat(m.tags || []).filter(Boolean).join(' '),
        }));
        return idx.some((r) => r.keywords.toLowerCase().indexOf('vault') !== -1);
      });
      ui.tagFilter = ''; setFilter(''); noImage.clear(); render();

        const pass = results.filter((r) => r.pass).length;
        const out = { pass: pass, total: results.length, results: results };
        window.__dmSelftest = out;
        if (!window.__selftest) window.__selftest = out;
        console.log('[domains selftest] ' + pass + '/' + results.length, results.filter((r) => !r.pass));
        toast('Domains self-test ' + pass + '/' + results.length);
      }, 45);
    }, 120);
  }

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- *
   * Every mark is searchable by name / note / place / category, and the
   * DEFAULT action is the load-bearing one: travel, through the same
   * recall() the row click uses (C++ closes the palette and does the jump). */
  if (window.HDOmni) HDOmni.register({
    id: 'domains', label: 'Domains', tab: 'domains',
    setFilter: function (q) { try { setFilter(String(q || '')); } catch (e) {} },
    index: function () {
      return (state.marks || []).map((m) => ({
        label: m.name || '(unnamed)',
        detail: [m.category, m.cellName || m.worldspaceName, m.note].filter(Boolean).join(' · '),
        kind: m.interior ? 'domain ⌂' : 'domain ▲',
        /* Tags are part of what a domain IS, so Ctrl+F finds one by tag exactly
           as the tab's own search box does. Riding the existing provider rather
           than registering a second one keeps ONE index. */
        keywords: [m.cellEdid, m.worldspaceName].concat(m.tags || []).filter(Boolean).join(' '),
        /* mark id — the identity that keeps two domains with the same name
           apart (it also names their photo files); survives rename/re-file */
        pin: 'dom:' + m.id,
        /* the photographed file when the mark carries one (pdPhoto writes
           m.image); the old <id>.<ext> convention is a guess the shelf's
           error-fallback absorbs, so only the authoritative path is sent */
        icon: m.image ? String(m.image) : '',
        run: function () { recall(m); },
      }));
    },
  });

  /* =========================================================== exports == */

  return {
    init: init,
    onShow: onShow,
    onHide: onHide,
    receive: receive,
    wantsPause: wantsPause,
    /* Jump to the Domains tab with a filter pre-filled — the Followers card's
       HOME pill links here so the follower's assigned home is the top hit
       (Rober, 2026-08-05). */
    openWithFilter: function (q) {
      if (window.__omniSetTab) window.__omniSetTab('domains');
      try { setFilter(String(q || '')); } catch (e) {}
      const s = document.getElementById('dm-search');
      if (s) { s.value = String(q || ''); setTimeout(function () { s.focus(); }, 30); }
    },
    /* Drop every full-screen overlay this tab may have put on document.body,
       and NOTHING else. app.js calls it from hdClosed, where onHide() would be
       wrong: C++ can close the palette out from under us (a container op, a
       quick-fire, F7 again) and that must not also wipe the tab's filter or
       edit state — but an overlay left behind is invisible and still swallows
       every click on the next open. */
    closeOverlays: function () { closeArt(); closeFolLb(); },
    /* Read-only, for other panes that need somewhere to send someone — the
       Followers tab's "send her to a domain" picker is the first borrower.
       Returns COPIES: a borrower must not be able to reorder or mutate the
       roster, and normalizeMark also guarantees every coordinate field is a
       real number, which is what the C++ side is about to MoveTo.

       Safe to call before the Domains tab has ever been opened: init() runs
       on DOMContentLoaded, so window.pdOpen is installed well before the
       first palette-open push and state.marks is already filled. */
    listMarks: function () { return state.marks.map((m) => normalizeMark(m)); },
    show: showTab,
    toggleEdit: toggleEdit,
    isShown: function () { return ui.shown; },
    isCapturing: function () { return ui.capture; },
    /* Test seams. The crop invariant and the tag normalisation are the two
       things that MUST agree with their C++ twins, so the harness asserts them
       directly rather than through the DOM. */
    _crop: {
      clamp: clampCrop, keyOf: cropKeyOf, forImage: cropFor, phrase: cropPhrase,
      ZMAX: CROP_ZMAX, ZSTEP: CROP_ZSTEP, PAN: CROP_PAN_STEP, MAX_ENTRIES: CROP_MAX_ENTRIES,
    },
    _tags: { norm: normTag, merge: mergeTags, MAX: TAG_MAX, MAX_LEN: TAG_MAX_LEN },
  };
})();
