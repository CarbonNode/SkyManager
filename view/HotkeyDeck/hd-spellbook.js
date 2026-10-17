'use strict';

/* ============================================================================
   Spellbook — the full-screen personal spell sheet (deck view).

   Rober, 2026-10-14, first ask: "new full screen UI popout in UI elements on
   home for skymanager, a personal catalog of spells, you create nice
   categories … chevrons, draggable order, add or remove, auto cast, equip".
   Mid-build: "its gotta be really easy to reorder and drag stuff between
   things." Then, on the card-grid draft: "no im imagining a full simple list
   like an excel sheet, but with chevron headers you can make, where 95% of
   the screen is real estate for spells, with icons in their thin rows.
   draggable between categories. hover shows you information about damage,
   cost, etc. ability to add 2 spells to same row, they split with a vertical
   seperator in same horizontal row, rearranging which is in left or right …
   spells switch to left or right side depending what hand configuration you
   have … a button that appears on hover with a flyout … so you have full
   suite of how you want to equip the spell."

   And on the full-width sheet: "rows even here are way to long
   horizontally. we need to be able to have some really large amount + many
   rows".

   So this is a SHEET in NEWSPAPER COLUMNS:
     · one slim top bar (title, counts, search, fold/open, New category,
       Add spells, Options, Close) — everything else is lines;
     · as many compact columns as fit (Options › Columns); groups flow down
       one column and on into the next under a "continued" header;
     · chevron GROUP lines (your categories, plus Not filed at the end);
     · thin spell rows: icon, name, equipped badge, cost, on-click — the
       school, tier, delivery and every number live in the hover card;
     · a row holds ONE or TWO spells. Two split with a vertical separator;
       the left half is the left hand. Pair a spell on a side and its hand
       follows; set its hand in the flyout and it moves to that side (its
       partner takes the other hand). The separator's hover buttons swap
       the sides and equip the pair.
     · hover a spell for its card: cost, every effect's damage / healing /
       magnitude, per second, duration, area, the game's description;
     · hover shows the on-click button; its flyout is the whole suite:
       do it now (cast, left, right, both), what a click does (auto cast or
       equip left / right / both; use or select for powers and shouts),
       swap, own row, move to, also add to, remove. Right-click = same flyout.

   DRAGGING (the whole spell is the handle)
     · top / bottom of a row       → its own row, above / below
     · middle of a ONE-spell row   → share it (a resident that equips one
                                     hand keeps it; else the newcomer's own
                                     hand, else the half you are over)
     · the other half of its pair  → swap sides
     · a group header              → into that group (a folded one springs
                                     open after a moment's hover)
     · Not filed                   → out of the category
     · hold Ctrl on drop           → copy instead of move
     · a group header, dragged     → reorders groups (every group folds to
                                     its title while you drag, so they all fit)
     · the sheet scrolls at its top/bottom edge.

   CASTING / EQUIPPING implement nothing: sbAct {op:'cast'|'equip', hand}
   reaches SpellActions::Cast / EquipToggle in C++ after an IsKnown check.

   Bridge (src/spellbook.cpp + main.cpp OnJsSpellbook*):
     sbOpen -> sbState {known, equip, doc} · sbSave(doc) -> sbSaved
     sbAct {op,plugin,localId,formId,hand,key,reopen} -> sbActResult
     sbDesc {plugin,localId,formId,key} -> sbDescData {key, text, stats}
   Storage: its OWN sidecar spellbook-sheet.json (NOT spellbook.json — that
   is the Spell Deck's portal export); the VIEW owns the schema (v2:
   cats[].rows = [{l, r}]) and carries unknown keys through every save.
   In game Esc rides app.js's popout contract (hdPopoutCapture): C++ hands it
   to escape(), which closes the TOP layer first.
   ============================================================================ */

window.HDSpellbook = (function () {
  /* ---- static tables ---------------------------------------------------- */

  var IC = 'icons/custom/';
  var EMBLEMS = [
    { f: 'sc-destruction', n: 'Destruction' }, { f: 'sc-fire', n: 'Fire' }, { f: 'sc-frost', n: 'Frost' },
    { f: 'sc-shock', n: 'Shock' }, { f: 'sc-restoration', n: 'Restoration' }, { f: 'sc-ward', n: 'Ward' },
    { f: 'gl-healing', n: 'Healing' }, { f: 'sc-conjuration', n: 'Conjuration' }, { f: 'sc-necromancy', n: 'Necromancy' },
    { f: 'sc-alteration', n: 'Alteration' }, { f: 'gl-shield', n: 'Shield' }, { f: 'sc-illusion', n: 'Illusion' },
    { f: 'gl-eye', n: 'Eye' }, { f: 'gl-moon', n: 'Moon' }, { f: 'gl-sun', n: 'Sun' },
    { f: 'sc-powers', n: 'Powers' }, { f: 'sc-shouts', n: 'Shouts' }, { f: 'sc-dragon', n: 'Dragon' },
    { f: 'sc-poison', n: 'Poison' }, { f: 'gl-skull', n: 'Skull' }, { f: 'gl-flame', n: 'Flame' },
    { f: 'gl-bolt', n: 'Bolt' }, { f: 'gl-hand', n: 'Hand' }, { f: 'sc-hero', n: 'Hero' },
    { f: 'gl-book', n: 'Book' }, { f: 'gl-book-open', n: 'Open book' }, { f: 'hm-spells', n: 'Spellbook' }
  ];
  /* category colours (right-click a header, or its Edit menu). Explicit rgba
     only — Ultralight has no color-mix. c = accent, t = header tint. */
  var COLORS = [
    { v: '', n: 'Gold (default)', c: '#d5b65c', t: 'rgba(38, 35, 30, 1)' },
    { v: 'ember', n: 'Ember', c: '#e07a4a', t: 'rgba(58, 32, 24, 1)' },
    { v: 'crimson', n: 'Crimson', c: '#d4535a', t: 'rgba(56, 24, 28, 1)' },
    { v: 'rose', n: 'Rose', c: '#d97aa6', t: 'rgba(54, 28, 42, 1)' },
    { v: 'violet', n: 'Violet', c: '#a487e0', t: 'rgba(38, 30, 58, 1)' },
    { v: 'azure', n: 'Azure', c: '#5f9fe0', t: 'rgba(24, 36, 58, 1)' },
    { v: 'frost', n: 'Frost', c: '#7fd0e6', t: 'rgba(22, 44, 52, 1)' },
    { v: 'teal', n: 'Teal', c: '#4fbf9f', t: 'rgba(20, 46, 40, 1)' },
    { v: 'moss', n: 'Moss', c: '#8fbf57', t: 'rgba(32, 44, 22, 1)' },
    { v: 'ash', n: 'Ash', c: '#b3aca0', t: 'rgba(40, 39, 38, 1)' }
  ];
  function colorOf(v) { for (var i = 0; i < COLORS.length; i++) if (COLORS[i].v === v) return COLORS[i]; return null; }
  function paintCat(node, c) {
    var col = c && c.color ? colorOf(c.color) : null;
    if (!col || !col.v) return;
    node.classList.add('has-color');
    node.style.setProperty('--cat-c', col.c);
    node.style.setProperty('--cat-t', col.t);
  }
  var SCHOOLS = ['destruction', 'restoration', 'alteration', 'conjuration', 'illusion'];
  var TIER_ORDER = { novice: 1, apprentice: 2, adept: 3, expert: 4, master: 5 };
  var SEED = [
    { id: 'fire', name: 'Fire, Frost & Storm', icon: 'sc-destruction', test: function (m) { return m.school === 'destruction'; } },
    { id: 'heal', name: 'Healing & Wards', icon: 'sc-restoration', test: function (m) { return m.school === 'restoration'; } },
    { id: 'summ', name: 'Summons & Bound Arms', icon: 'sc-conjuration', test: function (m) { return m.school === 'conjuration'; } },
    { id: 'mind', name: 'Minds & Shadows', icon: 'sc-illusion', test: function (m) { return m.school === 'illusion'; } },
    { id: 'alt', name: 'Armor & Utility', icon: 'sc-alteration', test: function (m) { return m.school === 'alteration'; } },
    { id: 'pow', name: 'Powers', icon: 'sc-powers', test: function (m) { return m.type === 'power' || m.type === 'lesser'; } },
    { id: 'shout', name: 'Shouts', icon: 'sc-shouts', test: function (m) { return m.type === 'shout' || m.type === 'voice'; } }
  ];
  var MODES = [
    { v: 'cast', n: 'Auto cast', short: 'Cast' }, { v: 'left', n: 'Equip left hand', short: 'Left' },
    { v: 'right', n: 'Equip right hand', short: 'Right' }, { v: 'both', n: 'Equip both hands', short: 'Both' }
  ];
  var VMODES = [{ v: 'cast', n: 'Use it', short: 'Use' }, { v: 'right', n: 'Select into the voice slot', short: 'Select' }];
  var DRAG_PX = 6, SPRING_MS = 550, EDGE_PX = 90, HOVER_MS = 280;

  /* ---- state ------------------------------------------------------------ */

  var st = { loaded: false, known: [], byKey: {}, equip: { left: '', right: '', voice: [] }, doc: null, msg: '' };
  var ui = {
    root: null, standalone: false, q: '', layer: null, renaming: '', confirmDel: '', saveT: 0, flashT: 0,
    desc: {}, tipKey: '', tipCell: null, tipT: 0, press: null, drag: null, justDragged: 0, tempFold: false,
    reopenAt: 0, reopenStandalone: false, wasOpen: false, focusBefore: null, newKeys: {}
  };
  var env = null;
  var $ = {};

  /* ---- helpers ---------------------------------------------------------- */

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} return true; }
    return false;
  }
  function coerce(x) {
    if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } }
    return x;
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function btn(label, title, run, cls) {
    var b = el('button', 'spbk-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); try { run(e); } catch (x) { logErr(x); } });
    return b;
  }
  function logErr(x) { var f = window.hdLog; if (typeof f === 'function') { try { f('spellbook: ' + (x && x.message || x)); } catch (e) {} } }
  function words(t) { return String(t || '').toLowerCase().replace(/[-_·/'’(),.:]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function hex(n) { return '0x' + ('00000000' + ((n >>> 0).toString(16).toUpperCase())).slice(-8); }
  function keyOf(m) {
    if (!m) return '';
    if (m.plugin) return String(m.plugin).toLowerCase() + '|' + ((m.localId >>> 0).toString(16));
    return 'id|' + ((m.formId >>> 0).toString(16));
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function isVoice(m) { return !!m && (m.slot === 'voice' || m.type === 'power' || m.type === 'lesser' || m.type === 'voice' || m.type === 'shout'); }
  function num(n) { var r = Math.round(n * 10) / 10; return (Math.abs(r - Math.round(r)) < 0.05 ? Math.round(r) : r).toString(); }

  function kindLine(m) {
    if (!m) return '';
    if (m.type === 'shout') return 'Shout';
    if (m.type === 'power') return 'Greater power';
    if (m.type === 'lesser') return 'Lesser power';
    if (m.type === 'voice') return 'Voice power';
    var parts = [];
    if (m.school) parts.push(cap(m.school));
    if (m.tier) parts.push(cap(m.tier));
    return parts.length ? parts.join(' · ') : 'Spell';
  }
  function fallbackIcon(m) {
    if (!m) return IC + 'hm-spells.png';
    if (m.type === 'shout' || m.type === 'voice') return IC + 'sc-shouts.png';
    if (m.type === 'power' || m.type === 'lesser') return IC + 'sc-powers.png';
    var e = String(m.element || '');
    if (e === 'fire' || e === 'frost' || e === 'shock') return IC + 'sc-' + e + '.png';
    if (SCHOOLS.indexOf(m.school) !== -1) return IC + 'sc-' + m.school + '.png';
    return IC + 'hm-spells.png';
  }
  function artSrc(m) {
    var p = '';
    if (typeof window.hdSpellIconPath === 'function') { try { p = window.hdSpellIconPath(m) || ''; } catch (e) { p = ''; } }
    return p || fallbackIcon(m);
  }
  function mono(text) {
    var ws = String(text || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/);
    return ((ws[0] ? ws[0][0] : '?') + (ws[1] ? ws[1][0] : '')).toUpperCase();
  }
  /* spell art that steps down to the school emblem, then to initials */
  function art(m, cls) {
    var w = el('span', 'spbk-art' + (cls ? ' ' + cls : ''));
    var im = el('img');
    im.alt = ''; im.setAttribute('draggable', 'false');
    var first = artSrc(m), second = fallbackIcon(m);
    im.onerror = function () {
      if (im.getAttribute('src') !== second) { im.src = second; return; }
      if (im.parentNode) im.parentNode.removeChild(im);
      w.classList.add('is-mono'); w.textContent = mono(m && m.name);
    };
    im.src = first;
    if (first.indexOf(IC) === 0) w.classList.add('is-emblem');
    w.appendChild(im);
    return w;
  }
  function emblem(file, cls) {
    var w = el('span', 'spbk-emb' + (cls ? ' ' + cls : ''));
    var im = el('img');
    im.alt = ''; im.setAttribute('draggable', 'false');
    im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); };
    im.src = IC + (file || 'hm-spells') + '.png';
    w.appendChild(im);
    return w;
  }

  /* ---- the document ----------------------------------------------------- */

  function settings() {
    if (!st.doc) return { click: 'cast', after: 'close' };
    var s = st.doc.settings || (st.doc.settings = {});
    if (['cast', 'right', 'left', 'both'].indexOf(s.click) === -1) s.click = 'cast';
    if (s.after !== 'reopen') s.after = 'close';
    return s;
  }
  function cats() { return st.doc && Array.isArray(st.doc.cats) ? st.doc.cats : []; }
  function catById(id) { var c = cats(); for (var i = 0; i < c.length; i++) if (c[i].id === id) return c[i]; return null; }
  function meta(key) { return st.byKey[key] || (st.doc && st.doc.meta && st.doc.meta[key]) || null; }
  function known(key) { return !!st.byKey[key]; }
  function rowKeys(r) { return r.r ? [r.l, r.r] : [r.l]; }
  function catKeys(c) { var out = []; c.rows.forEach(function (r) { out.push.apply(out, rowKeys(r)); }); return out; }
  /* what a click on this spell does; voice items only know cast (use) and right (select) */
  function modeOf(key) {
    var m = meta(key), c = st.doc && st.doc.click && st.doc.click[key];
    var v = (c === 'cast' || c === 'right' || c === 'left' || c === 'both') ? c : settings().click;
    if (isVoice(m)) return v === 'cast' ? 'cast' : 'right';
    return v;
  }
  function modeShort(key) {
    var m = meta(key), v = modeOf(key), list = isVoice(m) ? VMODES : MODES;
    for (var i = 0; i < list.length; i++) if (list[i].v === v) return list[i].short;
    return 'Cast';
  }
  function filedSet() {
    var f = {};
    cats().forEach(function (c) { catKeys(c).forEach(function (k) { (f[k] = f[k] || []).push(c); }); });
    return f;
  }

  /* normalise whatever was on disk (v1 cards -> v2 rows); keep unknown keys */
  function adopt(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = null;
    var fresh = !doc;
    doc = doc || {};
    if (!Array.isArray(doc.cats)) doc.cats = [];
    doc.cats = doc.cats.filter(function (c) { return c && typeof c === 'object'; }).map(function (c) {
      var seen = {};
      c.id = typeof c.id === 'string' && c.id ? c.id : uid();
      c.name = typeof c.name === 'string' && c.name.trim() ? c.name : 'Untitled';
      c.icon = typeof c.icon === 'string' && /^[a-z0-9-]+$/.test(c.icon) ? c.icon : 'gl-book';
      c.collapsed = c.collapsed === true;
      if (typeof c.color !== 'string' || !colorOf(c.color)) delete c.color;
      var rows = Array.isArray(c.rows) ? c.rows : (Array.isArray(c.keys) ? c.keys.map(function (k) { return { l: k }; }) : []);
      delete c.keys;
      c.rows = [];
      rows.forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        var l = typeof r.l === 'string' && r.l && !seen[r.l] ? r.l : null;
        if (l) seen[l] = 1;
        var rr = typeof r.r === 'string' && r.r && !seen[r.r] ? r.r : null;
        if (rr) seen[rr] = 1;
        if (!l && rr) { l = rr; rr = null; }
        if (l) c.rows.push({ l: l, r: rr });
      });
      return c;
    });
    doc.v = 2;
    if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};
    if (!doc.click || typeof doc.click !== 'object') doc.click = {};
    if (!doc.seen || typeof doc.seen !== 'object') doc.seen = {};
    st.doc = doc;
    settings();
    return fresh;
  }
  function sortSpells(a, b) {
    var ta = TIER_ORDER[a.tier] || 9, tb = TIER_ORDER[b.tier] || 9;
    return ta - tb || String(a.name).localeCompare(String(b.name));
  }
  function seedBook() {
    var sorted = st.known.slice().sort(sortSpells);
    st.doc.cats = SEED.map(function (s) {
      return { id: uid() + s.id, name: s.name, icon: s.icon, collapsed: false,
               rows: sorted.filter(s.test).map(function (m) { return { l: m.key, r: null }; }) };
    }).filter(function (c) { return c.rows.length; });
    if (!st.doc.cats.length)
      st.doc.cats = SEED.slice(0, 3).map(function (s) { return { id: uid() + s.id, name: s.name, icon: s.icon, collapsed: false, rows: [] }; });
    settings().note = 'seeded';
  }
  function refreshMeta() {
    var keep = {};
    cats().forEach(function (c) {
      catKeys(c).forEach(function (k) {
        var m = st.byKey[k] || st.doc.meta[k];
        if (!m) return;
        keep[k] = { plugin: m.plugin || '', localId: m.localId >>> 0, formId: m.formId >>> 0, name: m.name || '',
                    type: m.type || '', slot: m.slot || '', school: m.school || '', element: m.element || '',
                    tier: m.tier || '', archetype: m.archetype || '' };
      });
    });
    st.doc.meta = keep;
    for (var k in st.doc.click) if (!keep[k] && !st.byKey[k]) delete st.doc.click[k];
  }
  function save(now) {
    if (!st.doc) return;
    if (ui.saveT) clearTimeout(ui.saveT);
    var go = function () { ui.saveT = 0; refreshMeta(); toGame('sbSave', JSON.stringify(st.doc)); };
    if (now) go(); else ui.saveT = setTimeout(go, 300);
  }
  function flush() { if (ui.saveT) { clearTimeout(ui.saveT); save(true); } }

  /* ---- receivers -------------------------------------------------------- */

  function receiveState(d0) {
    var d = coerce(d0);
    if (!d || typeof d !== 'object') return;
    st.known = (Array.isArray(d.known) ? d.known : []).filter(function (m) { return m && m.name; });
    st.byKey = {};
    st.known.forEach(function (m) { m.key = keyOf(m); st.byKey[m.key] = m; });
    readEquip(d.equip);
    st.msg = typeof d.msg === 'string' ? d.msg : '';
    var fresh = adopt(d.doc);
    if (fresh) seedBook();
    var seen = {}, changed = false;
    st.known.forEach(function (m) { seen[m.key] = 1; if (!st.doc.seen[m.key]) changed = true; });
    ui.newKeys = {};
    if (!fresh && Object.keys(st.doc.seen).length) st.known.forEach(function (m) { if (!st.doc.seen[m.key]) ui.newKeys[m.key] = 1; });
    if (changed || fresh) st.doc.seen = seen;
    st.loaded = true;
    if (changed || fresh) save(fresh);
    if (ui.root) render();
  }
  function readEquip(e) {
    e = e && typeof e === 'object' ? e : {};
    st.equip = { left: String(e.left || '').toUpperCase(), right: String(e.right || '').toUpperCase(),
                 voice: (Array.isArray(e.voice) ? e.voice : []).map(function (v) { return String(v).toUpperCase(); }) };
  }
  function equipOf(m) {
    if (!m || !m.formId) return {};
    var h = hex(m.formId).toUpperCase();
    return { left: st.equip.left === h, right: st.equip.right === h, voice: st.equip.voice.indexOf(h) !== -1 };
  }
  function equipText(m) {
    var e = equipOf(m);
    if (e.left && e.right) return 'Both hands';
    if (e.left) return 'Left hand';
    if (e.right) return 'Right hand';
    if (e.voice) return 'Voice slot';
    return '';
  }
  function receiveAct(r0) {
    var r = coerce(r0);
    if (!r || typeof r !== 'object') return;
    if (r.ok === false) { flash(r.msg || 'That did not work.'); return; }
    if (r.op === 'equip' && r.formId) {
      var h = String(r.formId).toUpperCase();
      if (r.left === true) st.equip.left = h; else if (st.equip.left === h) st.equip.left = '';
      if (r.right === true) st.equip.right = h; else if (st.equip.right === h) st.equip.right = '';
      var vi = st.equip.voice.indexOf(h);
      if (r.voice === true && vi === -1) st.equip.voice = [h];
      else if (r.voice === false && vi !== -1) st.equip.voice.splice(vi, 1);
      if (r.msg) flash(r.msg);
      if (ui.root) paintEquip();
    }
  }
  function receiveDesc(r0) {
    var r = coerce(r0);
    if (!r || typeof r !== 'object' || typeof r.key !== 'string' || !r.key) return;
    ui.desc[r.key] = { text: r.ok === false ? '' : String(r.text || ''), stats: r.stats && typeof r.stats === 'object' ? r.stats : null };
    if (ui.tipKey === r.key) drawTip();
  }

  /* ---- actions ---------------------------------------------------------- */

  function act(key, op, hand) {
    var m = meta(key);
    if (!m) return;
    if (!known(key)) { flash('You no longer know ' + m.name + '.'); return; }
    var payload = { op: op, plugin: m.plugin || '', localId: m.localId >>> 0, formId: m.formId >>> 0, hand: hand || 'right', key: key };
    if (op === 'cast') {
      var back = settings().after === 'reopen';
      payload.reopen = back;
      ui.reopenAt = back ? Date.now() : 0;
      ui.reopenStandalone = ui.standalone;
      flush();
    }
    hideTip();
    toGame('sbAct', JSON.stringify(payload));
  }
  function primary(key) {
    var m = meta(key);
    if (!m) return;
    var v = modeOf(key);
    if (v === 'cast') act(key, 'cast');
    else act(key, 'equip', isVoice(m) ? 'right' : v);
  }
  /* both halves of a pair into their hands — only the hands not already holding them */
  function equipPair(row) {
    [['l', 'left'], ['r', 'right']].forEach(function (p) {
      var k = row[p[0]], m = k && meta(k);
      if (!m || isVoice(m) || !known(k)) return;
      if (!equipOf(m)[p[1]]) act(k, 'equip', p[1]);
    });
  }
  function flash(text) {
    if (!$.flash) return;
    $.flash.textContent = text;
    $.flash.classList.add('on');
    if (ui.flashT) clearTimeout(ui.flashT);
    ui.flashT = setTimeout(function () { if ($.flash) $.flash.classList.remove('on'); }, 2600);
  }

  /* ---- hands follow sides ------------------------------------------------ *
   * In a pair, a spell whose click EQUIPS one hand takes the hand of its side.
   * Cast / both / voice spells keep their own setting. */
  /* which half a newcomer takes when it shares a one-spell row: the
     resident keeps its hand if it equips one; else the newcomer's own hand
     decides; else the half the pointer is over */
  function shareSide(resKey, newKey, pointerLeft) {
    var rm = meta(resKey), nm = meta(newKey), rv = modeOf(resKey), nv = modeOf(newKey);
    if (rm && !isVoice(rm) && (rv === 'left' || rv === 'right')) return rv === 'left' ? 'r' : 'l';
    if (nm && !isVoice(nm) && (nv === 'left' || nv === 'right')) return nv === 'left' ? 'l' : 'r';
    return pointerLeft ? 'l' : 'r';
  }
  function couple(row) {
    if (!row || !row.r) return;
    [['l', 'left'], ['r', 'right']].forEach(function (p) {
      var k = row[p[0]], m = meta(k);
      if (!m || isVoice(m)) return;
      var v = modeOf(k);
      if ((v === 'left' || v === 'right') && v !== p[1]) st.doc.click[k] = p[1];
    });
  }
  function swapRow(row) {
    if (!row || !row.r) return;
    var t = row.l; row.l = row.r; row.r = t;
    couple(row);
  }
  function setMode(key, v, ctx) {
    if (v) st.doc.click[key] = v; else delete st.doc.click[key];
    var row = ctx && ctx.row;
    if (row && row.r && (modeOf(key) === 'left' || modeOf(key) === 'right')) {
      var want = modeOf(key) === 'left' ? 'l' : 'r';
      var side = row.l === key ? 'l' : 'r';
      if (side !== want) {
        swapRow(row);
        flash(meta(key).name + ' moved to the ' + (want === 'l' ? 'left' : 'right') + ' side.');
      } else couple(row);
    }
    save(); render();
  }

  /* ---- moves: the ONE place a spell changes place ------------------------ *
   * src {cat, row, side} (cat null = Not filed); dst {cat, row, where} with
   * where 'before'|'after'|'pairL'|'pairR'|'end'; dst null = take it out.   */
  function takeOut(c, key) {
    for (var i = c.rows.length - 1; i >= 0; i--) {
      var r = c.rows[i];
      if (r.l === key && r.r) { r.l = r.r; r.r = null; }
      else if (r.r === key) r.r = null;
      else if (r.l === key) c.rows.splice(i, 1);
    }
  }
  function moveSpell(key, src, dst, copy) {
    if (dst && dst.where === 'flip') { setMode(key, dst.hand, { row: dst.row }); return; }
    var from = src && src.cat ? catById(src.cat) : null;
    var to = dst && dst.cat ? catById(dst.cat) : null;
    var target = dst && dst.row ? dst.row : null;   // a row OBJECT survives the splices below
    /* the other half of its own pair = swap */
    if (from && to === from && target && src.row === target && target.r && (dst.where === 'pairL' || dst.where === 'pairR')) {
      var side = target.l === key ? 'l' : 'r';
      if ((dst.where === 'pairL') !== (side === 'l')) { swapRow(target); save(); render(); flash('Swapped sides.'); }
      return;
    }
    if (from && !(copy && to !== from)) takeOut(from, key);
    if (to && to !== from) takeOut(to, key);
    if (to) {
      var idx = target ? to.rows.indexOf(target) : -1;
      if ((dst.where === 'pairL' || dst.where === 'pairR') && idx !== -1 && !target.r && target.l !== key) {
        if (dst.where === 'pairL') { target.r = target.l; target.l = key; } else target.r = key;
        couple(target);
      } else {
        var row = { l: key, r: null };
        if (idx === -1 || dst.where === 'end') to.rows.push(row);
        else to.rows.splice(dst.where === 'after' || dst.where === 'pairR' ? idx + 1 : idx, 0, row);
      }
      if (to.collapsed && to !== from) to.collapsed = false;
    }
    save(); render();
    var m = meta(key);
    if (!m) return;
    if (!to && from) flash('Took ' + m.name + ' out of ' + from.name + '.');
    else if (to && to !== from) flash((copy && from ? 'Also filed ' + m.name + ' in ' : 'Moved ' + m.name + ' to ') + to.name + '.');
  }
  function unpair(c, row) {
    if (!row || !row.r) return;
    var i = c.rows.indexOf(row);
    c.rows.splice(i + 1, 0, { l: row.r, r: null });
    row.r = null;
    save(); render();
  }
  function moveCat(id, beforeId) {
    var c = cats(), i = -1;
    for (var n = 0; n < c.length; n++) if (c[n].id === id) i = n;
    if (i === -1) return;
    var cat = c.splice(i, 1)[0], at = -1;
    for (var m = 0; m < c.length; m++) if (c[m].id === beforeId) at = m;
    if (at === -1) c.push(cat); else c.splice(at, 0, cat);
    save(); render();
  }
  function newCategory() {
    var c = { id: uid(), name: 'New category', icon: 'gl-book', collapsed: false, rows: [] };
    st.doc.cats.push(c);
    ui.renaming = c.id;
    save(); render();
    scrollToCat(c.id);
  }
  function deleteCat(id) {
    var c = catById(id);
    if (!c) return;
    st.doc.cats = cats().filter(function (x) { return x.id !== id; });
    ui.confirmDel = '';
    save(); render();
    flash('Deleted ' + c.name + '. Its spells are still in your spellbook.');
  }
  function setCollapsed(id, v) { var c = catById(id); if (!c) return; c.collapsed = v; save(); render(); }
  function setAll(v) { cats().forEach(function (c) { c.collapsed = v; }); if (v) settings().unfiledOpen = false; save(); render(); }

  /* ---- render ----------------------------------------------------------- */

  function build() {
    var back = el('div', 'spbk-back');
    back.id = 'hd-spellbook';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Spellbook');
    var frame = el('div', 'spbk-frame');
    back.appendChild(frame);

    var bar = el('div', 'spbk-bar');
    var ht = el('div', 'spbk-title');
    ht.appendChild(emblem('hm-spells', 'spbk-title-emb'));
    var htt = el('div', 'spbk-title-t');
    htt.appendChild(el('h2', '', 'Spellbook'));
    $.sub = el('div', 'spbk-sub', '');
    htt.appendChild($.sub);
    ht.appendChild(htt);
    bar.appendChild(ht);

    var sw = el('div', 'spbk-search');
    var lab = el('label', 'spbk-vh', 'Search your spellbook');
    lab.setAttribute('for', 'spbk-q');
    sw.appendChild(lab);
    var q = el('input', 'spbk-search-in');
    q.id = 'spbk-q'; q.type = 'text'; q.autocomplete = 'off'; q.spellcheck = false;
    q.placeholder = 'Search spells, schools, categories…';
    q.addEventListener('input', function () { ui.q = q.value; renderSheet(); renderSub(); });
    sw.appendChild(q);
    $.qClear = btn('Clear', 'Clear the search', function () { q.value = ''; ui.q = ''; renderSheet(); renderSub(); q.focus(); }, 'spbk-quiet spbk-q-clear');
    sw.appendChild($.qClear);
    $.q = q;
    bar.appendChild(sw);

    /* Zoom (everything) and Text size (just the type), both remembered;
       click the number to reset; Ctrl + wheel over the sheet zooms too */
    function sizer(kind, label, title) {
      var g = el('div', 'spbk-size');
      g.appendChild(el('span', 'spbk-size-lab', label));
      g.appendChild(btn('−', 'Smaller ' + title, function () { setSize(kind, -1); }, 'spbk-quiet'));
      var v = el('button', 'spbk-size-v', '100%');
      v.type = 'button'; v.title = 'Back to 100 %';
      v.addEventListener('click', function (e) { e.stopPropagation(); setSize(kind, 0); });
      g.appendChild(v);
      g.appendChild(btn('+', 'Bigger ' + title, function () { setSize(kind, 1); }, 'spbk-quiet'));
      return { g: g, v: v };
    }
    var zs = sizer('zoom', 'Zoom', 'rows, icons and text (Ctrl + wheel)'), ts = sizer('text', 'Text', 'text');
    $.zoomV = zs.v; $.textV = ts.v;
    var ha = el('div', 'spbk-bar-acts');
    ha.appendChild(zs.g);
    ha.appendChild(ts.g);
    ha.appendChild(btn('Fold all', 'Fold every group to its title', function () { setAll(true); }, 'spbk-quiet'));
    ha.appendChild(btn('Open all', 'Open every group', function () { setAll(false); }, 'spbk-quiet'));
    ha.appendChild(btn('New category', 'Make a new category', newCategory));
    ha.appendChild(btn('Add spells', 'Pick spells to put in a category', function () { openPicker(null); }));
    ha.appendChild(btn('Options', 'What a click does by default, and what happens after a cast', function (e) { openOptions(e.currentTarget); }, 'spbk-caret'));
    ha.appendChild(btn('Close', 'Close the Spellbook (Esc)', function () { close(true); }, 'spbk-close'));
    bar.appendChild(ha);
    frame.appendChild(bar);
    $.hint = el('div', 'spbk-hint', '');
    frame.appendChild($.hint);

    $.sheet = el('div', 'spbk-sheet');
    $.sheet.addEventListener('scroll', function () { if (!ui.drag) hideTip(); });
    $.sheet.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setSize('zoom', e.deltaY < 0 ? 1 : -1);
    });
    frame.appendChild($.sheet);

    $.flash = el('div', 'spbk-flash');
    $.flash.setAttribute('role', 'status');
    frame.appendChild($.flash);

    $.tip = el('div', 'spbk-tip');
    $.tip.setAttribute('role', 'tooltip');
    back.appendChild($.tip);

    $.layer = el('div', 'spbk-layer');
    back.appendChild($.layer);

    back.addEventListener('mousedown', onDown, false);
    back.addEventListener('contextmenu', onContext, false);
    return back;
  }

  function render() {
    if (!ui.root) return;
    renderSub(); renderSize(); renderSheet();
  }
  function totals() {
    var f = filedSet(), filed = 0, unf = 0;
    st.known.forEach(function (m) { if (f[m.key]) filed++; else unf++; });
    return { filed: filed, unfiled: unf, cats: cats().length };
  }
  function renderSub() {
    if (!$.sub) return;
    if (!st.loaded) { $.sub.textContent = 'Opening your spellbook…'; $.hint.textContent = ''; return; }
    var t = totals();
    $.sub.textContent = st.known.length + ' spells · ' + t.cats + (t.cats === 1 ? ' category' : ' categories') + (t.unfiled ? ' · ' + t.unfiled + ' not filed' : '');
    $.qClear.hidden = !ui.q;
    var hits = ui.q ? searchHits() : [];
    $.hint.innerHTML = '';
    $.hint.classList.toggle('is-empty', !cats().length && !ui.q);
    if (!cats().length && !ui.q) {
      /* the empty state lives in this one line, so the sheet still starts
         top-left with your spells */
      $.hint.appendChild(el('b', '', 'No categories yet'));
      $.hint.appendChild(el('span', '', ' — make one, or file every spell you know by school:'));
      $.hint.appendChild(btn('New category', 'Make a new category', newCategory, 'spbk-mini'));
      $.hint.appendChild(btn('Start from my schools', 'File every spell you know by school', function () { seedBook(); save(); render(); }, 'spbk-mini'));
    } else if (!ui.q) $.hint.textContent = 'Drag a spell anywhere — drop it onto another spell to share a row · hover for details · right-click a spell or a category for options';
    else if (!hits.length) $.hint.textContent = 'No spell matches “' + ui.q + '”.';
    else {
      var top = meta(hits[0]);
      $.hint.textContent = hits.length + (hits.length === 1 ? ' spell' : ' spells') + ' · Enter: ' + verb(hits[0]) + ' ' + (top ? top.name : '');
    }
  }
  function verb(key) {
    var m = meta(key), v = modeOf(key);
    if (isVoice(m)) return v === 'cast' ? 'use' : 'select';
    return v === 'cast' ? 'cast' : v === 'left' ? 'equip left' : v === 'both' ? 'equip both' : 'equip right';
  }

  function matches(key, cat) {
    if (!ui.q) return true;
    var m = meta(key);
    if (!m) return false;
    var hay = words([m.name, m.school, m.tier, m.element, kindLine(m), m.plugin, m.archetype, cat ? cat.name : 'not filed'].join(' '));
    return words(ui.q).split(' ').every(function (t) { return hay.indexOf(t) !== -1; });
  }
  function nameScore(key) {
    var m = meta(key), n = words(m && m.name), q = words(ui.q);
    return n.indexOf(q) === 0 ? 3 : n.indexOf(' ' + q) !== -1 ? 2 : n.indexOf(q) !== -1 ? 1 : 0;
  }
  function searchHits() {
    var out = [], seen = {};
    cats().forEach(function (c) { catKeys(c).forEach(function (k) { if (!seen[k] && matches(k, c)) { seen[k] = 1; out.push(k); } }); });
    unfiledKeys().forEach(function (k) { if (!seen[k] && matches(k, null)) { seen[k] = 1; out.push(k); } });
    var idx = {};
    out.forEach(function (k, i) { idx[k] = i; });
    return out.sort(function (a, b) { return nameScore(b) - nameScore(a) || idx[a] - idx[b]; });
  }
  function unfiledKeys() {
    var f = filedSet();
    return st.known.filter(function (m) { return !f[m.key]; }).sort(function (a, b) {
      var na = ui.newKeys[a.key] ? 0 : 1, nb = ui.newKeys[b.key] ? 0 : 1;
      var sa = SCHOOLS.indexOf(a.school), sb = SCHOOLS.indexOf(b.school);
      return na - nb || (sa === -1 ? 9 : sa) - (sb === -1 ? 9 : sb) || sortSpells(a, b);
    }).map(function (m) { return m.key; });
  }

  /* ---- the sheet: newspaper columns ------------------------------------- *
   * Rober, on the full-width sheet: "rows even here are way to long
   * horizontally. we need to be able to have some really large amount +
   * many rows". So the sheet flows into as many compact columns as fit:
   * every line (group header, spell row, drop zone) has a FIXED height, the
   * lines are cut into columns of equal height, and a group that runs past a
   * column's foot carries on at the top of the next under a "continued"
   * header. When everything fits, the book fills the screen left to right
   * with no scrolling at all; when it does not, the columns are balanced and
   * scroll together. */
  /* LINE is recomputed by applyMetrics() from Zoom (everything) and Text
     size (type, and the row height it needs); the CSS reads the same numbers
     from the --lh-* variables it is handed, so the cut and the paint agree. */
  var LINE = { head: 48, cont: 38, row: 42, drop: 54 };
  var ZOOM = { min: 0.7, max: 1.8, step: 0.1 }, TEXT = { min: 0.8, max: 1.6, step: 0.1 };
  function clampStep(v, lim) { v = Math.round(v * 10) / 10; return v < lim.min ? lim.min : v > lim.max ? lim.max : v; }
  function zoomOf() { var z = +settings().zoom; return isFinite(z) && z ? clampStep(z, ZOOM) : 1; }
  function textOf() { var f = +settings().text; return isFinite(f) && f ? clampStep(f, TEXT) : 1; }
  function applyMetrics(sheet) {
    var z = zoomOf(), f = textOf();
    var grow = Math.max(1, 0.5 + 0.5 * f);          // rows grow once the type outgrows them
    var px = function (n) { return Math.round(n) + 'px'; };
    var fs = function (n, floor) { return Math.max(floor || 0, Math.round(n * z * f)) + 'px'; };
    LINE = { head: Math.round(48 * z * grow), cont: Math.round(38 * z * grow), row: Math.round(42 * z * grow), drop: Math.round(54 * z) };
    var v = {
      '--lh-head': px(LINE.head), '--lh-head0': px(LINE.head - 8), '--lh-cont': px(LINE.cont), '--lh-row': px(LINE.row), '--lh-drop': px(LINE.drop),
      '--gemb': px(30 * z), '--gemb-c': px(24 * z), '--art': px(32 * z * grow), '--art-p': px(30 * z * grow),
      '--fs-head': fs(21), '--fs-cont': fs(18), '--fs-name': fs(18, 15), '--fs-cost': fs(17, 15), '--fs-sm': fs(16, 14),
      '--mode-w': px(92 * z * Math.max(1, f)), '--mode-h': px(Math.min(LINE.row - 6, 34 * z * grow)), '--cost-w': px(48 * z * f),
      '--rename-h': px(Math.min(LINE.head - 10, 38 * z * grow)), '--fs-rename': fs(20)
    };
    for (var k in v) sheet.style.setProperty(k, v[k]);
    return { z: z, f: f };
  }
  function setSize(kind, dir) {
    var s0 = settings();
    if (kind === 'zoom') s0.zoom = dir === 0 ? 1 : clampStep(zoomOf() + dir * ZOOM.step, ZOOM);
    else s0.text = dir === 0 ? 1 : clampStep(textOf() + dir * TEXT.step, TEXT);
    save(); renderSize(); renderSheet();
  }
  function renderSize() {
    if (!$.zoomV) return;
    $.zoomV.textContent = Math.round(zoomOf() * 100) + '%';
    $.textV.textContent = Math.round(textOf() * 100) + '%';
  }
  var COLW = { more: 470, balanced: 570, fewer: 740 };
  var COL_GAP = 18;

  function renderSheet() {
    var s = $.sheet;
    if (!s) return;
    applyMetrics(s);
    var keepTop = s.scrollTop;
    s.innerHTML = '';
    if (!st.loaded) {
      var l = el('div', 'spbk-empty');
      l.appendChild(emblem('hm-spells', 'spbk-empty-emb'));
      l.appendChild(el('b', '', 'Opening your spellbook…'));
      s.appendChild(l);
      return;
    }
    if (st.msg) s.appendChild(el('div', 'spbk-note spbk-note-warn', st.msg));
    if (settings().note === 'seeded' && !ui.q) {
      var n = el('div', 'spbk-note');
      n.appendChild(el('span', 'spbk-note-t', 'Your book is started — the spells you know were filed by school. Rename, reorder or delete any category, drag spells anywhere, drop one onto another to put two on one row.'));
      n.appendChild(btn('Got it', 'Hide this note', function () { delete settings().note; save(); render(); }, 'spbk-mini'));
      s.appendChild(n);
    }
    /* the lines, in reading order */
    var lines = [], any = false;
    cats().forEach(function (c) {
      var rows = c.rows.filter(function (r) { return rowKeys(r).some(function (k) { return matches(k, c); }); });
      if (ui.q && !rows.length) return;
      any = true;
      var open = (!c.collapsed || !!ui.q) && !ui.tempFold;
      var g = { cat: c, name: c.name, icon: c.icon, unf: false };
      lines.push({ kind: 'head', h: LINE.head, g: g, el: groupHead(c, open, rows) });
      if (!open) return;
      rows.forEach(function (r) { lines.push({ kind: 'row', h: LINE.row, g: g, el: rowEl(r, c) }); });
      if (!rows.length) {
        var z = el('div', 'spbk-drop');
        z.setAttribute('data-cat', c.id);
        z.textContent = 'Empty — drag spells here, or Add spells';
        lines.push({ kind: 'drop', h: LINE.drop, g: g, el: z });
      }
    });
    var uk = unfiledKeys().filter(function (k) { return matches(k, null); });
    if (uk.length || !ui.q) {
      any = any || uk.length > 0;
      var su = settings();
      /* with no categories, Not filed IS the book: open unless you folded it */
      var uopen = (su.unfiledOpen === true || (!cats().length && su.unfiledOpen !== false) || !!ui.q) && !ui.tempFold;
      var gu = { cat: null, name: 'Not filed', icon: 'gl-book-open', unf: true };
      lines.push({ kind: 'head', h: LINE.head, g: gu, el: unfiledHead(uk, uopen) });
      if (uopen) {
        uk.forEach(function (k) { lines.push({ kind: 'row', h: LINE.row, g: gu, el: rowEl({ l: k, r: null }, null) }); });
        if (!uk.length) {
          var zu = el('div', 'spbk-drop');
          zu.setAttribute('data-unfiled', '1');
          zu.textContent = 'Every spell you know is filed';
          lines.push({ kind: 'drop', h: LINE.drop, g: gu, el: zu });
        }
      }
    }
    if (ui.q && !any) {
      var nr = el('div', 'spbk-empty');
      nr.appendChild(el('b', '', 'No spell matches “' + ui.q + '”'));
      nr.appendChild(el('span', '', 'Try a school (“restoration”), a tier (“adept”), a category, or fewer letters.'));
      s.appendChild(nr);
    } else layoutColumns(s, lines);
    s.scrollTop = keepTop;
    paintEquip();
  }

  function layoutColumns(s, lines) {
    var wrap = el('div', 'spbk-cols');
    s.appendChild(wrap);
    var width = Math.max(300, s.clientWidth - 4);
    var m = applyMetrics(s);
    var colW = (COLW[settings().density] || COLW.balanced) * m.z * (1 + (m.f - 1) * 0.5);
    var n = Math.max(1, Math.floor((width + COL_GAP) / (colW + COL_GAP)));
    var avail = Math.max(LINE.head + LINE.row, s.clientHeight - wrap.offsetTop - 12);
    var total = 0;
    lines.forEach(function (ln) { total += ln.h; });
    /* balanced: the shortest column height that fits everything in n
       columns, grown a line at a time until the fill fits */
    var target = Math.max(LINE.head + LINE.row, Math.ceil(total / n));
    var cols;
    for (var tries = 0; tries < 400; tries++) {
      cols = fill(lines, n, target);
      if (cols) break;
      target += LINE.row;
    }
    if (!cols) cols = fill(lines, n, 1e9);
    wrap.style.gridTemplateColumns = 'repeat(' + n + ', minmax(0, 1fr))';
    cols.forEach(function (list) {
      var col = el('div', 'spbk-col');
      list.forEach(function (node) { col.appendChild(node); });
      wrap.appendChild(col);
    });
    for (var k = cols.length; k < n; k++) wrap.appendChild(el('div', 'spbk-col is-empty'));
  }
  /* cut the lines into at most n columns no taller than `target`; null when
     they do not fit. A header never ends a column (it moves down with its
     first row), and a group cut by a column foot gets a "continued" header. */
  function fill(lines, n, target) {
    var cols = [], cur = [], h = 0, lastG = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      /* a group that fits a column whole starts a fresh column rather than
         being cut — only a group taller than a column is ever continued */
      if (ln.kind === 'head' && cur.length) {
        var gh = 0;
        for (var j = i; j < lines.length && (j === i || lines[j].g === ln.g); j++) gh += lines[j].h;
        if (h + gh > target && gh <= target) {
          cols.push(cur);
          if (cols.length >= n) return null;
          cur = []; h = 0;
        }
      }
      var need = ln.h;
      if (ln.kind === 'head' && lines[i + 1] && lines[i + 1].g === ln.g && lines[i + 1].kind !== 'head') need += lines[i + 1].h;
      var contNeed = (ln.kind !== 'head') ? LINE.cont : 0;
      if (cur.length && h + need > target) {
        cols.push(cur);
        if (cols.length >= n) return null;
        cur = []; h = 0;
        if (ln.kind !== 'head') { cur.push(contHead(ln.g)); h += contNeed; }
      }
      cur.push(ln.el);
      h += ln.h;
      lastG = ln.g;
    }
    if (cur.length) cols.push(cur);
    return cols.length <= n ? cols : null;
  }

  function chevron(open) { var c = el('span', 'spbk-chev' + (open ? ' is-open' : '')); c.setAttribute('aria-hidden', 'true'); return c; }

  function groupHead(c, open, rows) {
    var head = el('div', 'spbk-ghead' + (open ? '' : ' is-folded'));
    head.setAttribute('data-cat', c.id);
    head.setAttribute('data-cat-head', '1');
    paintCat(head, c);
    var renaming = ui.renaming === c.id;
    var tg = el(renaming ? 'div' : 'button', 'spbk-gtog');
    if (!renaming) {
      tg.type = 'button';
      tg.setAttribute('aria-expanded', open ? 'true' : 'false');
      tg.title = (open ? 'Fold ' : 'Open ') + c.name + ' · drag to reorder';
    }
    tg.appendChild(chevron(open));
    tg.appendChild(emblem(c.icon, 'spbk-gemb'));
    if (renaming) {
      var inp = el('input', 'spbk-rename');
      inp.type = 'text'; inp.value = c.name; inp.maxLength = 60;
      inp.setAttribute('aria-label', 'Category name');
      var done = false;
      var commit = function (keep) {
        if (done) return; done = true;
        var v = inp.value.trim();
        if (keep && v) c.name = v;
        ui.renaming = '';
        save(); render();
      };
      inp._spbkKey = function (e) { if (e.key === 'Enter') { commit(true); return true; } return false; };
      inp._spbkCancel = function () { commit(false); };
      inp.addEventListener('blur', function () { commit(true); });
      inp.addEventListener('click', function (e) { e.stopPropagation(); });
      inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      tg.appendChild(inp);
      setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    } else tg.appendChild(el('span', 'spbk-gname', c.name));
    var n = catKeys(c).length;
    tg.appendChild(el('span', 'spbk-count', ui.q ? String(rows.length) : String(n)));
    tg.addEventListener('click', function () {
      if (Date.now() - ui.justDragged < 250 || renaming || ui.q) return;
      setCollapsed(c.id, !c.collapsed);
    });
    head.appendChild(tg);
    var acts = el('div', 'spbk-gacts');
    if (ui.confirmDel === c.id) {
      acts.appendChild(el('span', 'spbk-confirm-t', 'Delete it?'));
      acts.appendChild(btn('Delete', 'Delete this category — the spells stay learned', function () { deleteCat(c.id); }, 'spbk-mini spbk-danger'));
      acts.appendChild(btn('Keep', 'Keep this category', function () { ui.confirmDel = ''; render(); }, 'spbk-mini'));
      acts.classList.add('is-on');
    } else {
      acts.appendChild(btn('Add', 'Pick spells to put in ' + c.name, function () { openPicker(c.id); }, 'spbk-mini'));
      acts.appendChild(btn('Edit', 'Rename, emblem or delete ' + c.name, function (e) { openCatMenu(c, e.currentTarget); }, 'spbk-mini spbk-caret'));
    }
    head.appendChild(acts);
    return head;
  }
  function unfiledHead(keys, open) {
    var s = settings();
    open = !!open;
    var head = el('div', 'spbk-ghead spbk-unf' + (open ? '' : ' is-folded'));
    head.setAttribute('data-unfiled', '1');
    var tg = el('button', 'spbk-gtog');
    tg.type = 'button';
    tg.setAttribute('aria-expanded', open ? 'true' : 'false');
    tg.title = 'Spells you know that are in no category — drag one into a category; drop a filed spell here to take it out';
    tg.appendChild(chevron(open));
    tg.appendChild(emblem('gl-book-open', 'spbk-gemb'));
    tg.appendChild(el('span', 'spbk-gname', 'Not filed'));
    tg.appendChild(el('span', 'spbk-count', String(keys.length)));
    var nNew = keys.filter(function (k) { return ui.newKeys[k]; }).length;
    if (nNew) tg.appendChild(el('span', 'spbk-new-pill', nNew + ' new'));
    tg.addEventListener('click', function () { if (Date.now() - ui.justDragged < 250 || ui.q) return; s.unfiledOpen = !open; save(); render(); });
    head.appendChild(tg);
    return head;
  }
  function contHead(g) {
    var h = el('div', 'spbk-ghead is-cont');
    if (g.unf) h.setAttribute('data-unfiled', '1'); else { h.setAttribute('data-cat', g.cat.id); paintCat(h, g.cat); }
    h.appendChild(emblem(g.icon, 'spbk-gemb'));
    h.appendChild(el('span', 'spbk-gname', g.name));
    h.appendChild(el('span', 'spbk-cont-t', 'continued'));
    return h;
  }
  function openCatMenu(c, anchor, x, y) {
    closeLayer(); hideTip();
    ui.layer = 'menu';
    var box = el('div', 'spbk-menu spbk-fly');
    box.appendChild(el('div', 'spbk-menu-t', c.name));
    var g = el('div', 'spbk-fly-grid');
    function opt(label, run, cls) {
      var b = el('button', 'spbk-fly-opt' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', function (e) { e.stopPropagation(); run(e); });
      g.appendChild(b);
    }
    opt('Rename', function () { closeLayer(); ui.renaming = c.id; render(); });
    opt('Emblem…', function () { openEmblems(c.id, anchor || box); });
    opt('Add spells…', function () { openPicker(c.id); });
    opt(c.collapsed ? 'Open it' : 'Fold it', function () { closeLayer(); setCollapsed(c.id, !c.collapsed); });
    opt('Delete category', function () { closeLayer(); if (!c.rows.length) deleteCat(c.id); else { ui.confirmDel = c.id; render(); } }, 'is-wide is-danger');
    box.appendChild(g);
    box.appendChild(el('div', 'spbk-fly-sec', 'Colour'));
    var sw = el('div', 'spbk-swatches');
    COLORS.forEach(function (col) {
      var b = el('button', 'spbk-swatch' + ((c.color || '') === col.v ? ' is-cur' : ''));
      b.type = 'button'; b.title = col.n;
      b.setAttribute('aria-pressed', (c.color || '') === col.v ? 'true' : 'false');
      var chip = el('span', 'spbk-swatch-chip');
      chip.style.background = col.c;
      b.appendChild(chip);
      b.appendChild(el('span', 'spbk-swatch-n', col.n.replace(' (default)', '')));
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (col.v) c.color = col.v; else delete c.color;
        closeLayer(); save(); render();
      });
      sw.appendChild(b);
    });
    box.appendChild(sw);
    $.layer.className = 'spbk-layer is-menu';
    $.layer.appendChild(box);
    if (anchor) { var r = anchor.getBoundingClientRect(); placeMenu(box, r.right - (box.offsetWidth || 470), r.bottom + 6); }
    else placeMenu(box, x, y);
  }

  /* A row is ONE line of its column. One spell uses the whole line; two
     share it, split by the separator — the left half is the left hand. */
  function rowEl(r, c) {
    var row = el('div', 'spbk-row' + (r.r ? ' is-pair' : ''));
    row._spbk = { row: r, cat: c };
    paintCat(row, c);
    if (c) row.setAttribute('data-cat', c.id); else row.setAttribute('data-unfiled', '1');
    row.appendChild(cellEl(r.l, r, c, 'l'));
    if (r.r) {
      var sep = el('div', 'spbk-sep');
      var sb = el('div', 'spbk-sep-acts');
      sb.appendChild(btn('Swap', 'Swap the two sides (hands follow the side)', function () { swapRow(r); save(); render(); }, 'spbk-mini'));
      var any = rowKeys(r).some(function (k) { var m = meta(k); return m && !isVoice(m) && known(k); });
      if (any) sb.appendChild(btn('Equip pair', 'Left spell in your left hand, right spell in your right', function () { equipPair(r); }, 'spbk-mini'));
      sep.appendChild(sb);
      row.appendChild(sep);
      row.appendChild(cellEl(r.r, r, c, 'r'));
    }
    return row;
  }
  function cellEl(key, r, c, side) {
    var m = meta(key) || { name: 'Unknown spell' };
    var gone = !known(key);
    var dim = ui.q && !matches(key, c);
    var cell = el('div', 'spbk-cell' + (gone ? ' is-gone' : '') + (dim ? ' is-dim' : '') + (ui.newKeys[key] && !c ? ' is-new' : ''));
    cell.setAttribute('data-key', key);
    cell.setAttribute('data-side', side);
    cell._spbk = { key: key, row: r, cat: c, side: side };
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', m.name + ', ' + kindLine(m) + (gone ? ', no longer known' : ', click: ' + verb(key)));
    cell.appendChild(art(m));
    var nm = el('span', 'spbk-name');
    nm.appendChild(el('span', 'spbk-name-t', m.name));
    if (ui.newKeys[key]) nm.appendChild(el('span', 'spbk-new-pill', 'New'));
    cell.appendChild(nm);
    cell.appendChild(el('span', 'spbk-eq', ''));
    cell.appendChild(el('span', 'spbk-cost', typeof m.cost === 'number' && !gone ? String(m.cost) : ''));
    var mb = el('button', 'spbk-mode spbk-caret', gone ? 'Remove' : modeShort(key));
    mb.type = 'button';
    mb.title = gone ? 'This spell is no longer learned — remove it' : 'A click does: ' + verb(key) + ' — open for every option';
    mb.addEventListener('click', function (e) {
      e.stopPropagation();
      if (gone && c) { moveSpell(key, { cat: c.id }, null); return; }
      var rc = mb.getBoundingClientRect();
      mb.classList.add('is-open');
      openFlyout(cell._spbk, rc.right - 470, rc.bottom + 6, rc);
      $.flyFor = mb;
    });
    cell.appendChild(mb);

    cell.addEventListener('click', function (e) {
      if (Date.now() - ui.justDragged < 250) return;
      if (e.target.closest && e.target.closest('button')) return;
      if (gone) { flash('You no longer know ' + m.name + '.'); return; }
      primary(key);
    });
    cell.addEventListener('mouseenter', function () { if (!ui.drag && !ui.layer) queueTip(key, cell); });
    cell.addEventListener('mouseleave', function () { if (ui.tipKey === key || ui.tipT) hideTip(); });
    /* a wheel scroll hides the card; the next nudge of the pointer brings it back */
    cell.addEventListener('mousemove', function () { if (!ui.tipKey && !ui.tipT && !ui.drag && !ui.layer && !ui.press) queueTip(key, cell); });
    return cell;
  }

  /* live equip state, without rebuilding the sheet */
  function paintEquip() {
    if (!$.sheet) return;
    var cells = $.sheet.querySelectorAll('.spbk-cell');
    for (var i = 0; i < cells.length; i++) {
      var m = meta(cells[i].getAttribute('data-key'));
      var e = equipOf(m), t = e.left && e.right ? 'Both' : e.left ? 'Left' : e.right ? 'Right' : e.voice ? 'Voice' : '';
      var eq = cells[i].querySelector('.spbk-eq');
      if (eq) { eq.textContent = t; eq.title = t ? 'Equipped: ' + equipText(m).toLowerCase() : ''; eq.classList.toggle('is-on', !!t); }
      cells[i].classList.toggle('is-eq', !!t);
    }
  }

  /* ---- hover card ---------------------------------------------------------- */

  function queueTip(key, cell) {
    if (ui.tipT) clearTimeout(ui.tipT);
    ui.tipT = setTimeout(function () {
      ui.tipT = 0;
      if (!ui.root || ui.drag || ui.layer || !cell.isConnected) return;
      ui.tipKey = key;
      ui.tipCell = cell;
      var m = meta(key);
      if (m && known(key) && !ui.desc[key]) {
        ui.desc[key] = { pending: true };
        toGame('sbDesc', JSON.stringify({ plugin: m.plugin || '', localId: m.localId >>> 0, formId: m.formId >>> 0, key: key }));
      }
      drawTip();
    }, HOVER_MS);
  }
  function hideTip() {
    if (ui.tipT) { clearTimeout(ui.tipT); ui.tipT = 0; }
    ui.tipKey = '';
    ui.tipCell = null;
    if ($.tip) $.tip.classList.remove('on');
  }
  function effLine(e) {
    var parts = [];
    if (typeof e.magnitude === 'number' && e.magnitude) {
      var mag = num(e.magnitude);
      var t = e.kind === 'damage' ? mag + ' damage' : e.kind === 'healing' ? mag + ' healed' : 'magnitude ' + mag;
      if (e.perSecond) t += ' per second';
      parts.push(t);
    }
    if (e.duration > 0) parts.push('for ' + e.duration + ' s');
    if (e.area > 0) parts.push(e.area + ' ft area');
    return parts.join(' · ');
  }
  function drawTip() {
    var t = $.tip, key = ui.tipKey, cell = ui.tipCell;
    if (!t || !key || !cell || !cell.isConnected) return;
    var m = meta(key);
    if (!m) return;
    t.innerHTML = '';
    var head = el('div', 'spbk-tip-head');
    head.appendChild(art(m, 'spbk-tip-art'));
    var ht = el('div', 'spbk-tip-ht');
    ht.appendChild(el('div', 'spbk-tip-name', m.name));
    ht.appendChild(el('div', 'spbk-tip-kind', kindLine(m) + (m.plugin && m.plugin !== 'Skyrim.esm' ? ' · ' + m.plugin : '')));
    head.appendChild(ht);
    t.appendChild(head);
    var d = ui.desc[key] || {};
    var stats = d.stats || null;
    var grid = el('div', 'spbk-tip-grid');
    function fact(k, v) { if (!v) return; grid.appendChild(el('span', 'spbk-tip-k', k)); grid.appendChild(el('span', 'spbk-tip-v', v)); }
    var cost = stats && typeof stats.cost === 'number' ? stats.cost : m.cost;
    if (typeof cost === 'number' && cost > 0) fact('Cost', num(cost) + ' magicka' + (stats && stats.costPerSecond ? ' per second' : ''));
    if (m.casting && m.casting !== 'other') fact('Casting', cap(String(m.casting).replace(/-/g, ' ')));
    if (m.delivery && m.delivery !== 'other') fact('Delivery', cap(String(m.delivery).replace(/-/g, ' ')));
    fact('A click', cap(verb(key)));
    fact('Equipped', equipText(m));
    t.appendChild(grid);
    if (stats && Array.isArray(stats.effects) && stats.effects.length) {
      var ef = el('div', 'spbk-tip-effs');
      stats.effects.slice(0, 8).forEach(function (e) {
        var r = el('div', 'spbk-tip-eff' + (e.kind === 'damage' ? ' is-dmg' : e.kind === 'healing' ? ' is-heal' : ''));
        r.appendChild(el('span', 'spbk-tip-en', e.name || 'Effect'));
        r.appendChild(el('span', 'spbk-tip-ev', effLine(e)));
        ef.appendChild(r);
      });
      t.appendChild(ef);
    }
    t.appendChild(el('p', 'spbk-tip-desc' + (d.text ? '' : ' is-quiet'),
      !known(key) ? 'You no longer know this spell.' : d.pending ? 'Reading the spell…' : (d.text || 'This spell has no description.')));
    t.classList.add('on');
    /* beside the cell's name, right of the pointer area; flips left / above at the edges */
    var rc = cell.getBoundingClientRect(), tw = t.offsetWidth || 560, th = t.offsetHeight || 320;
    var x = rc.left + Math.min(rc.width * 0.42, 560);
    if (x + tw > window.innerWidth - 16) x = Math.max(16, window.innerWidth - tw - 16);
    var y = rc.bottom + 8;
    if (y + th > window.innerHeight - 16) y = Math.max(16, rc.top - th - 8);
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }

  function scrollToCat(id) {
    requestAnimationFrame(function () {
      if (!$.sheet) return;
      var s = $.sheet.querySelector('.spbk-ghead[data-cat-head][data-cat="' + id + '"]');
      if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ---- layers ----------------------------------------------------------- */

  function closeLayer() {
    if (!ui.layer) return false;
    ui.layer = null;
    $.layer.innerHTML = '';
    $.layer.className = 'spbk-layer';
    if ($.flyFor) { $.flyFor.classList.remove('is-open'); $.flyFor = null; }
    return true;
  }
  function placeMenu(box, x, y) {
    var w = box.offsetWidth || 440, h = box.offsetHeight || 400;
    box.style.left = Math.max(16, Math.min(x, window.innerWidth - w - 16)) + 'px';
    box.style.top = Math.max(16, Math.min(y, window.innerHeight - h - 16)) + 'px';
  }
  function filterList(box, items, onPick, placeholder) {
    var q = el('input', 'spbk-search-in spbk-menu-q');
    q.type = 'text'; q.autocomplete = 'off'; q.placeholder = placeholder || 'Type to filter…';
    var list = el('div', 'spbk-menu-list');
    var shown = [], cur = 0;
    function draw() {
      list.innerHTML = '';
      var t = words(q.value);
      shown = items.filter(function (it) { return !t || words(it.label).indexOf(t) !== -1; });
      if (cur >= shown.length) cur = 0;
      shown.forEach(function (it, i) {
        var b = el('button', 'spbk-menu-it' + (i === cur ? ' is-cur' : ''));
        b.type = 'button';
        if (it.icon) b.appendChild(emblem(it.icon));
        b.appendChild(el('span', 'spbk-menu-l', it.label));
        if (it.note) b.appendChild(el('span', 'spbk-menu-note', it.note));
        b.addEventListener('click', function (e) { e.stopPropagation(); onPick(it); });
        list.appendChild(b);
      });
      if (!shown.length) list.appendChild(el('div', 'spbk-menu-empty', 'Nothing matches “' + q.value + '”.'));
    }
    q.addEventListener('input', function () { cur = 0; draw(); });
    q._spbkKey = function (e) {
      if (e.key === 'Enter') { if (shown[cur]) onPick(shown[cur]); return true; }
      if (e.key === 'ArrowDown') { cur = Math.min(shown.length - 1, cur + 1); draw(); return true; }
      if (e.key === 'ArrowUp') { cur = Math.max(0, cur - 1); draw(); return true; }
      return false;
    };
    box.appendChild(q);
    box.appendChild(list);
    draw();
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 0);
  }

  /* the flyout: the whole suite for one spell */
  function openFlyout(ctx, x, y, anchorRect) {
    closeLayer();
    hideTip();
    var key = ctx.key, m = meta(key);
    if (!m) return;
    ui.layer = 'menu';
    var voice = isVoice(m), gone = !known(key);
    var box = el('div', 'spbk-menu spbk-fly');
    var hd = el('div', 'spbk-fly-head');
    hd.appendChild(art(m, 'spbk-fly-art'));
    var ht = el('div', 'spbk-fly-ht');
    ht.appendChild(el('div', 'spbk-menu-t', m.name));
    ht.appendChild(el('div', 'spbk-fly-kind', kindLine(m)));
    hd.appendChild(ht);
    box.appendChild(hd);

    function section(title) { box.appendChild(el('div', 'spbk-fly-sec', title)); var g = el('div', 'spbk-fly-grid'); box.appendChild(g); return g; }
    function opt(g, label, title, on, run, wide) {
      var b = el('button', 'spbk-fly-opt' + (on ? ' on' : '') + (wide ? ' is-wide' : ''), label);
      b.type = 'button'; b.title = title || label;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function (e) { e.stopPropagation(); run(); });
      g.appendChild(b);
      return b;
    }
    if (!gone) {
      var eq = equipOf(m);
      var now = section('Do it now');
      if (voice) {
        opt(now, 'Use now', 'Use it now (the deck closes)', false, function () { closeLayer(); act(key, 'cast'); });
        opt(now, eq.voice ? 'In voice slot' : 'Select it', 'Put it in your power/shout slot', eq.voice, function () { closeLayer(); act(key, 'equip', 'right'); });
      } else {
        opt(now, 'Cast now', 'Cast it now (the deck closes)', false, function () { closeLayer(); act(key, 'cast'); });
        opt(now, 'Both hands', 'Equip in both hands', eq.left && eq.right, function () { closeLayer(); act(key, 'equip', 'both'); });
        opt(now, eq.left ? 'Unequip left' : 'Equip left', 'Left hand (again to unequip)', eq.left, function () { closeLayer(); act(key, 'equip', 'left'); });
        opt(now, eq.right ? 'Unequip right' : 'Equip right', 'Right hand (again to unequip)', eq.right, function () { closeLayer(); act(key, 'equip', 'right'); });
      }
      var cur = modeOf(key), own = st.doc.click[key];
      var clk = section('When you click it');
      (voice ? VMODES : MODES).forEach(function (o) {
        opt(clk, o.n, 'A click will: ' + o.n.toLowerCase(), cur === o.v && !!own, function () { closeLayer(); setMode(key, o.v, ctx); });
      });
      var def = MODES.filter(function (o) { return o.v === settings().click; })[0];
      opt(clk, 'Book default — ' + (voice ? (settings().click === 'cast' ? 'use it' : 'select it') : def.n.toLowerCase()),
        'Follow the book’s default (Options)', !own, function () { closeLayer(); setMode(key, '', ctx); }, true);
    }
    if (ctx.cat || cats().length) {
      var rowg = section(ctx.cat ? 'This row' : 'File it');
      var r = ctx.row;
      if (ctx.cat && r && r.r) {
        opt(rowg, 'Swap sides', 'Swap the two spells on this row (hands follow)', false, function () { closeLayer(); swapRow(r); save(); render(); });
        opt(rowg, 'Own row', 'Give each spell its own row', false, function () { closeLayer(); unpair(ctx.cat, r); });
      }
      if (cats().length) opt(rowg, ctx.cat ? 'Move to…' : 'File under…', 'Pick a category, type to filter', false, function () { subCats(box, ctx, false); });
      if (ctx.cat) opt(rowg, 'Also add to…', 'Keep it here and add it to another category', false, function () { subCats(box, ctx, true); });
      if (ctx.cat) opt(rowg, 'Remove from ' + ctx.cat.name, 'Take it out of this category (it stays learned)', false, function () { closeLayer(); moveSpell(key, { cat: ctx.cat.id }, null); }, true).classList.add('is-danger');
    }
    $.layer.className = 'spbk-layer is-menu';
    $.layer.appendChild(box);
    placeMenu(box, x, y);
    if (anchorRect && box.offsetTop < anchorRect.bottom && box.offsetTop + box.offsetHeight > anchorRect.top)
      placeMenu(box, x, anchorRect.top - box.offsetHeight - 6);
    var first = box.querySelector('button');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 0);
  }
  function subCats(box, ctx, copy) {
    var m = meta(ctx.key), fromId = ctx.cat ? ctx.cat.id : null;
    box.innerHTML = '';
    box.appendChild(el('div', 'spbk-menu-t', (copy ? 'Also add ' : (fromId ? 'Move ' : 'File ')) + (m ? m.name : '') + ' to…'));
    var items = cats().filter(function (c) { return c.id !== fromId; }).map(function (c) {
      return { label: c.name, icon: c.icon, id: c.id, note: catKeys(c).indexOf(ctx.key) !== -1 ? 'already there' : '' };
    });
    filterList(box, items, function (it) { closeLayer(); moveSpell(ctx.key, { cat: fromId }, { cat: it.id, where: 'end' }, copy); }, 'Type a category…');
  }
  function openOptions(anchor) {
    closeLayer();
    hideTip();
    ui.layer = 'menu';
    var s = settings();
    var box = el('div', 'spbk-menu spbk-fly');
    box.appendChild(el('div', 'spbk-menu-t', 'Spellbook options'));
    function grp(title, list, curV, set) {
      box.appendChild(el('div', 'spbk-fly-sec', title));
      var g = el('div', 'spbk-fly-grid');
      list.forEach(function (o) {
        var b = el('button', 'spbk-fly-opt' + (o.v === curV ? ' on' : ''), o.n);
        b.type = 'button';
        b.addEventListener('click', function (e) { e.stopPropagation(); set(o.v); closeLayer(); save(); render(); });
        g.appendChild(b);
      });
      box.appendChild(g);
    }
    grp('A click on a spell (unless it has its own)', MODES, s.click, function (v) { s.click = v; });
    grp('After a cast', [{ v: 'close', n: 'Back to the game' }, { v: 'reopen', n: 'Back to this book' }], s.after, function (v) { s.after = v; });
    grp('Columns', [{ v: 'more', n: 'More, narrower' }, { v: 'balanced', n: 'Balanced' }, { v: 'fewer', n: 'Fewer, wider' }], s.density || 'balanced', function (v) { s.density = v; });
    $.layer.className = 'spbk-layer is-menu';
    $.layer.appendChild(box);
    var r = anchor.getBoundingClientRect();
    placeMenu(box, r.right - (box.offsetWidth || 470), r.bottom + 8);
  }
  function openEmblems(catId, anchor) {
    closeLayer();
    hideTip();
    var c = catById(catId);
    if (!c) return;
    ui.layer = 'emblems';
    var box = el('div', 'spbk-menu spbk-emblems');
    box.appendChild(el('div', 'spbk-menu-t', 'Emblem for ' + c.name));
    var q = el('input', 'spbk-search-in spbk-menu-q');
    q.type = 'text'; q.placeholder = 'Type to filter emblems…';
    var grid = el('div', 'spbk-emb-grid');
    function draw() {
      grid.innerHTML = '';
      var t = words(q.value);
      var shown = EMBLEMS.filter(function (e) { return !t || words(e.n).indexOf(t) !== -1; });
      shown.forEach(function (e) {
        var b = el('button', 'spbk-emb-pick' + (c.icon === e.f ? ' is-cur' : ''));
        b.type = 'button'; b.title = e.n;
        b.appendChild(emblem(e.f));
        b.appendChild(el('span', '', e.n));
        b.addEventListener('click', function (ev) { ev.stopPropagation(); c.icon = e.f; closeLayer(); save(); render(); });
        grid.appendChild(b);
      });
      if (!shown.length) grid.appendChild(el('div', 'spbk-menu-empty', 'No emblem matches “' + q.value + '”.'));
      return shown;
    }
    q.addEventListener('input', draw);
    q._spbkKey = function (e) {
      if (e.key !== 'Enter') return false;
      var s = draw();
      if (s[0]) { c.icon = s[0].f; closeLayer(); save(); render(); }
      return true;
    };
    box.appendChild(q);
    box.appendChild(grid);
    draw();
    $.layer.className = 'spbk-layer is-menu';
    $.layer.appendChild(box);
    var r = anchor.getBoundingClientRect();
    placeMenu(box, r.left - 300, r.bottom + 8);
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 0);
  }

  /* Add spells: a centered popout over the sheet. Click toggles a spell in
     the target category; Enter adds the top hit not already there. */
  function openPicker(catId) {
    closeLayer();
    hideTip();
    if (!cats().length) { newCategory(); return; }
    var target = catById(catId) || cats()[0];
    ui.layer = 'picker';
    var pk = { q: '', filter: 'all', target: target.id };
    var box = el('div', 'spbk-pick');
    var head = el('div', 'spbk-pick-head');
    head.appendChild(el('h3', '', 'Add spells'));
    head.appendChild(btn('Done', 'Back to the book (Esc)', function () { closeLayer(); render(); }, 'spbk-close'));
    box.appendChild(head);
    var tsel = el('div', 'spbk-pick-target');
    box.appendChild(tsel);
    var bar = el('div', 'spbk-pick-bar');
    var q = el('input', 'spbk-search-in');
    q.type = 'text'; q.autocomplete = 'off'; q.placeholder = 'Search the spells you know…';
    bar.appendChild(q);
    box.appendChild(bar);
    var chips = el('div', 'spbk-segs spbk-pick-chips');
    box.appendChild(chips);
    var hint = el('div', 'spbk-pick-hint', '');
    box.appendChild(hint);
    var list = el('div', 'spbk-pick-list');
    box.appendChild(list);
    var all = el('div', 'spbk-pick-all');
    box.appendChild(all);
    var FILTERS = [{ v: 'all', n: 'Everything' }, { v: 'unfiled', n: 'Not filed' }]
      .concat(SCHOOLS.map(function (s) { return { v: s, n: cap(s) }; }))
      .concat([{ v: 'powers', n: 'Powers' }, { v: 'shouts', n: 'Shouts' }]);
    function drawTarget() {
      tsel.innerHTML = '';
      tsel.appendChild(el('span', 'spbk-pick-lab', 'Adding to'));
      var row = el('div', 'spbk-segs');
      cats().forEach(function (c) {
        var b = btn('', 'Add to ' + c.name, function () { pk.target = c.id; drawTarget(); draw(); }, 'spbk-seg spbk-seg-cat' + (c.id === pk.target ? ' on' : ''));
        b.appendChild(emblem(c.icon));
        b.appendChild(el('span', '', c.name));
        row.appendChild(b);
      });
      tsel.appendChild(row);
    }
    function drawChips() {
      chips.innerHTML = '';
      FILTERS.forEach(function (f) {
        chips.appendChild(btn(f.n, 'Show ' + f.n.toLowerCase(), function () { pk.filter = f.v; drawChips(); draw(); }, 'spbk-seg' + (pk.filter === f.v ? ' on' : '')));
      });
    }
    function hits() {
      var filed = filedSet(), t = words(pk.q).split(' ').filter(Boolean);
      var out = st.known.filter(function (m) {
        if (pk.filter === 'unfiled' && filed[m.key]) return false;
        if (SCHOOLS.indexOf(pk.filter) !== -1 && m.school !== pk.filter) return false;
        if (pk.filter === 'powers' && !(m.type === 'power' || m.type === 'lesser')) return false;
        if (pk.filter === 'shouts' && !(m.type === 'shout' || m.type === 'voice')) return false;
        if (!t.length) return true;
        var hay = words([m.name, m.school, m.tier, m.element, kindLine(m), m.plugin].join(' '));
        return t.every(function (w) { return hay.indexOf(w) !== -1; });
      });
      var q0 = words(pk.q);
      return out.sort(function (a, b) {
        if (q0) {
          var sa = words(a.name).indexOf(q0) === 0 ? 0 : 1, sb = words(b.name).indexOf(q0) === 0 ? 0 : 1;
          if (sa !== sb) return sa - sb;
        }
        return String(a.name).localeCompare(String(b.name));
      });
    }
    function inCat(c, k) { return !!c && catKeys(c).indexOf(k) !== -1; }
    function toggle(m) {
      var c = catById(pk.target);
      if (!c) return;
      if (inCat(c, m.key)) takeOut(c, m.key); else c.rows.push({ l: m.key, r: null });
      save(); draw();
    }
    function draw() {
      list.innerHTML = '';
      var c = catById(pk.target), filed = filedSet();
      var h = hits(), shownN = Math.min(h.length, 400);
      h.slice(0, shownN).forEach(function (m) {
        var inT = inCat(c, m.key);
        var row = el('button', 'spbk-prow' + (inT ? ' is-in' : ''));
        row.type = 'button';
        row.appendChild(art(m));
        var mid = el('span', 'spbk-prow-mid');
        mid.appendChild(el('span', 'spbk-name-t', m.name));
        var where = (filed[m.key] || []).map(function (x) { return x.name; }).join(', ');
        mid.appendChild(el('span', 'spbk-prow-sub', kindLine(m) + (where ? ' · in ' + where : ' · not filed')));
        row.appendChild(mid);
        row.appendChild(el('span', 'spbk-prow-add', inT ? 'Added ✓' : 'Add'));
        row.addEventListener('click', function (e) { e.stopPropagation(); toggle(m); });
        list.appendChild(row);
      });
      if (!h.length) list.appendChild(el('div', 'spbk-menu-empty', pk.q ? 'No spell you know matches “' + pk.q + '”.' : 'Nothing here.'));
      else if (h.length > shownN) list.appendChild(el('div', 'spbk-menu-empty', (h.length - shownN) + ' more — keep typing to narrow it down.'));
      var notIn = h.filter(function (m) { return !inCat(c, m.key); });
      hint.textContent = h.length + (h.length === 1 ? ' spell' : ' spells') + (notIn.length && pk.q ? ' · Enter adds ' + notIn[0].name : ' · click a spell to add or remove it');
      all.innerHTML = '';
      if (notIn.length > 1 && c) {
        all.appendChild(btn('Add all ' + notIn.length + ' shown to ' + c.name, 'Add every spell in this list', function () {
          notIn.forEach(function (m) { if (!inCat(c, m.key)) c.rows.push({ l: m.key, r: null }); });
          save(); draw();
        }));
      }
      ui.pickEnter = function () { if (notIn[0]) toggle(notIn[0]); };
    }
    q.addEventListener('input', function () { pk.q = q.value; draw(); });
    drawTarget(); drawChips(); draw();
    $.layer.className = 'spbk-layer is-picker';
    $.layer.appendChild(box);
    $.pickQ = q;
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 0);
  }

  /* ---- dragging --------------------------------------------------------- *
   * mouse-down → move → up on WINDOW, tracked start to finish (Ultralight can
   * report MouseEvent.buttons === 0 mid-drag, so nothing reads it). The chip
   * never takes pointer events, so elementFromPoint answers with what is
   * under the pointer.                                                        */

  function onDown(e) {
    if (e.button !== 0 || ui.layer) return;
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('input') || t.closest('.spbk-gacts') || t.closest('.spbk-sep-acts') || t.closest('.spbk-mode')) return;
    var cell = t.closest('.spbk-cell');
    var head = t.closest('.spbk-ghead[data-cat-head]');
    if (cell && cell._spbk) ui.press = { kind: 'spell', ctx: cell._spbk, el: cell, x: e.clientX, y: e.clientY };
    else if (head) ui.press = { kind: 'cat', id: head.getAttribute('data-cat'), el: head, x: e.clientX, y: e.clientY };
    else return;
    e.preventDefault();
  }
  function onMove(e) {
    var p = ui.press;
    if (!p) return;
    if (!ui.drag) {
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < DRAG_PX) return;
      startDrag(p, e);
    }
    var d = ui.drag;
    d.x = e.clientX; d.y = e.clientY;
    d.ghost.style.transform = 'translate(' + (e.clientX + 22) + 'px,' + (e.clientY + 18) + 'px)';
    d.copy = !!e.ctrlKey;
    findTarget(e.clientX, e.clientY);
    edgeScroll();
  }
  function startDrag(p, e) {
    hideTip();
    closeLayer();
    var g = el('div', 'spbk-ghost');
    if (p.kind === 'spell') {
      var m = meta(p.ctx.key);
      g.appendChild(art(m));
      g.appendChild(el('span', 'spbk-ghost-name', m ? m.name : ''));
    } else {
      var c = catById(p.id);
      g.appendChild(emblem(c ? c.icon : 'gl-book'));
      g.appendChild(el('span', 'spbk-ghost-name', c ? c.name : ''));
    }
    var tag = el('span', 'spbk-ghost-tag', p.kind === 'spell' ? 'Move' : 'Reorder');
    g.appendChild(tag);
    ui.drag = { kind: p.kind, ctx: p.ctx, id: p.id, src: p.el, ghost: g, tag: tag, x: e.clientX, y: e.clientY,
                target: null, mark: null, springT: 0, springId: '', copy: false, scrollT: 0 };
    if (p.kind === 'cat') {
      /* every group folds to its title while one is carried: they all fit */
      ui.tempFold = true;
      renderSheet();
      ui.drag.src = $.sheet.querySelector('.spbk-ghead[data-cat="' + p.id + '"]');
    }
    ui.root.appendChild(g);
    if (ui.drag.src) ui.drag.src.classList.add('is-src');
    ui.root.classList.add('is-dragging', p.kind === 'spell' ? 'is-drag-spell' : 'is-drag-cat');
  }
  function clearMark() {
    var d = ui.drag;
    if (!d || !d.mark) return;
    d.mark.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-out', 'drop-pairL', 'drop-pairR', 'drop-swap');
    d.mark = null;
  }
  function mark(node, cls) {
    var d = ui.drag;
    if (d.mark === node && node.classList.contains(cls)) return;
    clearMark();
    d.mark = node;
    node.classList.add(cls);
  }
  function spring(id, on) {
    var d = ui.drag;
    if (!on || !id) { if (d.springT) clearTimeout(d.springT); d.springT = 0; d.springId = ''; return; }
    if (d.springId === id) return;
    if (d.springT) clearTimeout(d.springT);
    d.springId = id;
    d.springT = setTimeout(function () {
      if (!ui.drag || ui.drag.springId !== id) return;
      var c = catById(id);
      if (c && c.collapsed) { c.collapsed = false; save(); redrawKeepDrag(); }
      else if (id === '__unfiled' && settings().unfiledOpen !== true) { settings().unfiledOpen = true; save(); redrawKeepDrag(); }
    }, SPRING_MS);
  }
  function redrawKeepDrag() {
    var d = ui.drag;
    renderSheet();
    if (!d) return;
    d.mark = null;
    if (d.kind === 'spell') {
      var cells = $.sheet.querySelectorAll('.spbk-cell');
      for (var i = 0; i < cells.length; i++) {
        var x = cells[i]._spbk;
        if (x && x.key === d.ctx.key && x.row === d.ctx.row) { cells[i].classList.add('is-src'); d.src = cells[i]; break; }
      }
    }
    findTarget(d.x, d.y);
  }
  function findTarget(x, y) {
    var d = ui.drag;
    var n = document.elementFromPoint(x, y);
    d.target = null;
    if (!n || !n.closest || !ui.root.contains(n)) { clearMark(); spring('', false); setTag(); return; }
    if (d.kind === 'spell') {
      var rowN = n.closest('.spbk-row');
      if (rowN && rowN._spbk) {
        var R = rowN._spbk;
        if (!R.cat) { d.target = { cat: null }; mark(rowN, 'drop-out'); spring('', false); setTag(); return; }
        var rr = rowN.getBoundingClientRect(), fy = (y - rr.top) / rr.height, left = x < rr.left + rr.width / 2;
        var own = R.row === d.ctx.row && d.ctx.cat === R.cat;
        var mid = fy > 0.25 && fy < 0.75;
        if (mid && own && R.row.r) {
          /* over its own pair: the other half swaps, its own half stays put */
          if ((d.ctx.side === 'l') !== left) { d.target = { cat: R.cat.id, row: R.row, where: left ? 'pairL' : 'pairR' }; mark(rowN, 'drop-swap'); spring('', false); setTag('Swap sides'); return; }
          clearMark(); spring('', false); setTag(); return;
        }
        if (mid && !R.row.r && !own) {
          var freeL = shareSide(R.row.l, d.ctx.key, left) === 'l';
          d.target = { cat: R.cat.id, row: R.row, where: freeL ? 'pairL' : 'pairR' };
          mark(rowN, freeL ? 'drop-pairL' : 'drop-pairR');
          spring('', false);
          setTag('Share the row — ' + (freeL ? 'left' : 'right') + ' side');
          return;
        }
        if (own && !R.row.r) {
          var mv = modeOf(d.ctx.key), cur = d.ctx.side;
          if (mid && (mv === 'left' || mv === 'right') && (cur === 'l') !== left) {
            d.target = { cat: R.cat.id, row: R.row, where: 'flip', hand: left ? 'left' : 'right' };
            mark(rowN, left ? 'drop-pairL' : 'drop-pairR');
            spring('', false); setTag('Equip in the ' + (left ? 'left' : 'right') + ' hand instead'); return;
          }
          clearMark(); spring('', false); setTag(); return;
        }
        var after = fy >= 0.5;
        d.target = { cat: R.cat.id, row: R.row, where: after ? 'after' : 'before' };
        mark(rowN, after ? 'drop-after' : 'drop-before');
        spring('', false); setTag(); return;
      }
      var unf = n.closest('[data-unfiled]');
      if (unf) {
        d.target = { cat: null };
        mark(unf, 'drop-out');
        spring('__unfiled', unf.classList.contains('spbk-ghead'));
        setTag(); return;
      }
      var host = n.closest('.spbk-ghead[data-cat]') || n.closest('.spbk-drop[data-cat]');
      if (host) {
        var id = host.getAttribute('data-cat');
        d.target = { cat: id, where: 'end' };
        mark(host, 'drop-into');
        spring(id, host.classList.contains('spbk-ghead') && !host.classList.contains('is-cont'));
        setTag(); return;
      }
    } else {
      var h = n.closest('.spbk-ghead[data-cat-head]');
      if (h) {
        var hid = h.getAttribute('data-cat');
        if (hid !== d.id) {
          var hr = h.getBoundingClientRect(), below = y > hr.top + hr.height / 2;
          var list = cats(), at = -1;
          for (var k = 0; k < list.length; k++) if (list[k].id === hid) at = k;
          d.target = { before: below ? (list[at + 1] ? list[at + 1].id : null) : hid };
          mark(h, below ? 'drop-after' : 'drop-before');
          setTag(); return;
        }
      }
    }
    clearMark(); spring('', false); setTag();
  }
  function setTag(txt) {
    var d = ui.drag;
    if (!d) return;
    var t = d.target;
    if (!txt) {
      if (d.kind === 'cat') txt = t ? 'Drop to reorder' : 'Reorder';
      else if (!t) txt = d.copy ? 'Copy' : 'Move';
      else if (t.cat === null) txt = d.ctx.cat ? 'Take out of ' + d.ctx.cat.name : 'Not filed';
      else {
        var c = catById(t.cat);
        txt = (d.ctx.cat && t.cat === d.ctx.cat.id) ? 'Reorder' : (d.copy && d.ctx.cat ? 'Copy to ' : 'Move to ') + (c ? c.name : '');
      }
    }
    d.tag.textContent = txt;
  }
  function edgeScroll() {
    var d = ui.drag;
    if (!d || d.scrollT || !$.sheet) return;
    var step = function () {
      d.scrollT = 0;
      if (ui.drag !== d || !$.sheet) return;
      var r = $.sheet.getBoundingClientRect(), v = 0;
      if (d.x >= r.left && d.x <= r.right) {
        if (d.y < r.top + EDGE_PX) v = -Math.ceil((r.top + EDGE_PX - d.y) / 4);
        else if (d.y > r.bottom - EDGE_PX) v = Math.ceil((d.y - (r.bottom - EDGE_PX)) / 4);
      }
      if (!v) return;
      $.sheet.scrollTop += v;
      findTarget(d.x, d.y);
      d.scrollT = setTimeout(step, 16);
    };
    step();
  }
  function onUp(e) {
    var d = ui.drag;
    ui.press = null;
    if (!d) return;
    if (e && typeof e.ctrlKey === 'boolean') d.copy = d.copy || e.ctrlKey;
    endDrag();
    ui.justDragged = Date.now();
    var t = d.target;
    if (!t) { render(); return; }
    if (d.kind === 'spell') {
      var src = { cat: d.ctx.cat ? d.ctx.cat.id : null, row: d.ctx.row, side: d.ctx.side };
      if (t.cat === null) { if (src.cat) moveSpell(d.ctx.key, src, null); else render(); }
      else moveSpell(d.ctx.key, src, t, d.copy && !!src.cat && t.cat !== src.cat);
    } else moveCat(d.id, t.before);
  }
  function endDrag() {
    var d = ui.drag;
    if (!d) return;
    clearMark();
    if (d.springT) clearTimeout(d.springT);
    if (d.scrollT) clearTimeout(d.scrollT);
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.src) d.src.classList.remove('is-src');
    if (ui.root) ui.root.classList.remove('is-dragging', 'is-drag-spell', 'is-drag-cat');
    ui.tempFold = false;
    ui.drag = null;
  }
  function cancelDrag() { ui.press = null; if (ui.drag) { endDrag(); ui.justDragged = Date.now(); render(); return true; } return false; }

  function onContext(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var gh = t.closest('.spbk-ghead[data-cat]');
    if (gh) {
      var gc = catById(gh.getAttribute('data-cat'));
      if (gc) { e.preventDefault(); e.stopPropagation(); openCatMenu(gc, null, e.clientX, e.clientY); }
      return;
    }
    var cell = t.closest('.spbk-cell');
    if (!cell || !cell._spbk) return;
    e.preventDefault(); e.stopPropagation();
    openFlyout(cell._spbk, e.clientX, e.clientY);
  }

  window.addEventListener('mousemove', function (e) { if (ui.root) onMove(e); }, true);
  window.addEventListener('mouseup', function (e) { if (ui.root) onUp(e); }, true);
  window.addEventListener('blur', function () { cancelDrag(); });
  document.addEventListener('mousedown', function (e) {
    if (ui.layer === 'menu' || ui.layer === 'emblems') {
      var box = $.layer && $.layer.firstChild;
      if (box && !box.contains(e.target)) { closeLayer(); e.stopPropagation(); e.preventDefault(); }
    }
  }, true);

  /* ---- open / close / keys --------------------------------------------- */

  function open(standalone) {
    ui.standalone = !!standalone || ui.standalone;
    if (ui.root) { if ($.q) $.q.focus(); return; }
    var go = function () {
      if (ui.root) return;
      ui.focusBefore = document.activeElement;
      ui.q = ''; ui.layer = null; ui.renaming = ''; ui.confirmDel = ''; ui.desc = {}; ui.tipKey = '';
      $ = {};
      ui.root = build();
      document.body.appendChild(ui.root);
      document.body.classList.add('spbk-open');
      render();
      if ($.q) $.q.focus();
      toGame('sbOpen', '');
      capture();
    };
    if (window.HDCss && typeof HDCss.need === 'function') HDCss.need('spellbook', go);
    else go();
  }
  function close(closeDeck) {
    if (!ui.root) return;
    cancelDrag();
    hideTip();
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains('spbk-rename')) active.blur();
    flush();
    ui.root.remove();
    ui.root = null;
    $ = {};
    ui.layer = null;
    document.body.classList.remove('spbk-open');
    capture();
    if (closeDeck && ui.standalone) {
      if (env && typeof env.closeDeck === 'function') env.closeDeck();
      else toGame('hdClose');
    }
    ui.standalone = false;
    try { if (ui.focusBefore && ui.focusBefore.focus) ui.focusBefore.focus(); } catch (e) {}
  }
  function capture() { if (typeof window.hdPopoutCapture === 'function') { try { window.hdPopoutCapture(); } catch (e) {} } }

  /* the top layer goes first: drag, flyout/picker, card, rename, confirm, search, book */
  function escape() {
    if (!ui.root) return;
    if (cancelDrag()) return;
    if (closeLayer()) { render(); return; }
    if (ui.tipKey) { hideTip(); return; }
    if (ui.renaming) { ui.renaming = ''; render(); return; }
    if (ui.confirmDel) { ui.confirmDel = ''; render(); return; }
    if (ui.q && $.q) { $.q.value = ''; ui.q = ''; renderSheet(); renderSub(); return; }
    close(true);
  }
  function onKey(e) {
    if (!ui.root) return;
    var t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (typeof window.hdPopoutNativeEsc === 'function') { try { window.hdPopoutNativeEsc(); } catch (x) {} }
      if (t && typeof t._spbkCancel === 'function') { t._spbkCancel(); return; }
      escape();
      return;
    }
    if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') && !ui.layer) {
      e.preventDefault(); e.stopImmediatePropagation();
      setSize('zoom', e.key === '0' ? 0 : e.key === '-' ? -1 : 1);
      return;
    }
    if (t && typeof t._spbkKey === 'function') {
      if (t._spbkKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && t === $.q) {
      e.preventDefault(); e.stopImmediatePropagation();
      var h = ui.q ? searchHits() : [];
      if (h[0]) primary(h[0]);
      return;
    }
    if (e.key === 'Enter' && $.pickQ && t === $.pickQ && ui.layer === 'picker') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (ui.pickEnter) ui.pickEnter();
      return;
    }
    if (e.key === 'ArrowDown' && t === $.q) {
      var first = $.sheet && $.sheet.querySelector('.spbk-cell');
      if (first) { e.preventDefault(); first.focus(); }
      e.stopPropagation();
      return;
    }
    if (t && t.classList && t.classList.contains('spbk-cell') && !ui.layer) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); t.click(); return; }
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault(); e.stopImmediatePropagation();
        var r = t.getBoundingClientRect();
        openFlyout(t._spbk, r.left + 40, r.bottom + 4, r);
        return;
      }
      if (/^Arrow/.test(e.key)) { e.preventDefault(); e.stopPropagation(); walk(t, e.key); return; }
    }
    if (e.key === 'Tab') {
      var scope = (ui.layer && $.layer.firstChild) || ui.root;
      var nodes = Array.prototype.filter.call(scope.querySelectorAll('button,input,.spbk-cell'), function (n) { return !n.disabled; });
      if (nodes.length) {
        var i = nodes.indexOf(document.activeElement);
        i = (i + (e.shiftKey ? nodes.length - 1 : 1)) % nodes.length;
        e.preventDefault(); e.stopImmediatePropagation();
        nodes[i].focus();
      }
      return;
    }
    e.stopPropagation();
    if ((e.key === 'Enter' || e.key === ' ') && t && t.tagName === 'BUTTON') { e.preventDefault(); t.click(); }
  }
  /* arrows: up/down walk rows, left/right cross a pair's separator */
  function walk(from, key) {
    var cells = Array.prototype.slice.call($.sheet.querySelectorAll('.spbk-cell'));
    var i = cells.indexOf(from), n = null;
    if (key === 'ArrowRight' && from._spbk.side === 'l' && from._spbk.row.r) n = cells[i + 1];
    else if (key === 'ArrowLeft' && from._spbk.side === 'r') n = cells[i - 1];
    else if (key === 'ArrowDown' || key === 'ArrowUp') {
      var r0 = from.getBoundingClientRect(), best = null, bd = 1e9;
      cells.forEach(function (c) {
        if (c === from) return;
        var r = c.getBoundingClientRect(), dy = r.top - r0.top;
        if (key === 'ArrowDown' ? dy < 4 : dy > -4) return;
        var dist = Math.abs(dy) * 4 + Math.abs(r.left - r0.left);
        if (dist < bd) { bd = dist; best = c; }
      });
      n = best;
    }
    if (n) { n.focus(); if (n.scrollIntoView) n.scrollIntoView({ block: 'nearest' }); }
  }
  window.addEventListener('keydown', onKey, true);
  /* the column count follows the screen */
  var resizeT = 0;
  window.addEventListener('resize', function () {
    if (!ui.root) return;
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(function () { resizeT = 0; if (ui.root && !ui.drag) renderSheet(); }, 120);
  });

  /* the deck closing takes the book with it; "After a cast: back to this
     book" reopens it on the deck open C++ makes once the cast has landed */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      var isOpen = document.body.classList.contains('open');
      if (ui.root && !isOpen) close(false);
      if (isOpen && !ui.wasOpen && ui.reopenAt && Date.now() - ui.reopenAt < 15000) {
        ui.reopenAt = 0;
        open(ui.reopenStandalone);
      }
      ui.wasOpen = isOpen;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  window.sbState = receiveState;
  window.sbSaved = function (r) { r = coerce(r); if (r && r.ok === false) flash(r.msg || 'The spellbook could not be saved.'); };
  window.sbActResult = receiveAct;
  window.sbDescData = receiveDesc;

  var api = {
    open: open,
    close: close,
    escape: escape,
    isOpen: function () { return !!ui.root; },
    hookInto: function (e) { env = e; },
    hooked: function () { return !!env; },
    summary: function () {
      if (!st.loaded || !st.doc) return '';
      var t = totals();
      return t.cats + (t.cats === 1 ? ' category · ' : ' categories · ') + t.filed + ' spells filed' + (t.unfiled ? ' · ' + t.unfiled + ' not filed' : '');
    },
    _state: function () { return st; },
    _ui: function () { return ui; }
  };

  if (window.__hdPendingSpellbook) { window.__hdPendingSpellbook = null; open(true); }

  return api;
})();
