'use strict';

/* ====================================================================== *
 *  Loadouts — follower groups you switch between, and gear classes you
 *  stamp onto them (Rober, 2026-09-14: "setup a group of followers, and
 *  easily switch between them … highly polished UI show profile pictures …
 *  set unique sets of armor and apply to a Class … teleport them all to me
 *  and recruit all to party in one button go").
 *
 *  The raid-roster shape: a rail of GROUPS on the left (portrait stacks, a
 *  with-you meter), the chosen group as a hero band + an ORDER DECK + a grid
 *  of big portrait cards, each card carrying the CLASS she plays in this
 *  group (class-hued ring). A second mode of the same pane edits the classes
 *  themselves (kit strip, fighting style, wearers). C++ (loadouts.cpp) owns
 *  loadouts.json, the roster/party/style facts, the last-order summary and
 *  the serialised NFF job behind Deploy / Swap / Summon / Dismiss / Dress;
 *  this pane owns the picking, the editing and the polish.
 *
 *  Bridge — requests: loState() · loAct(json)
 *  Replies (disjoint, per the deck law): loStateResult({…}) · loActResult({ok,
 *  act,msg,id?,physical?}). A physical act (deploy/summon/dismiss/dress/
 *  dressOne/dressClass) that validates gets its loActResult and then C++
 *  CLOSES the palette and runs the job in the live world — the pane does not
 *  stay open over it (a paused palette would stall the very Papyrus updates
 *  the job waits on). The next open shows the job's summary as a banner
 *  (`last` / `lastAt` in loStateResult).
 *
 *  Faces: HDFace.for/paint (photo > facegen render > initials) with an
 *  HDFace.group so missing heads get rendered while you look. Gear art:
 *  HDArt (item lane). Item picking: HDItemPick (the Finder's index, lent).
 *
 *  Host contract (mirrors MountsPane): LoadoutsPane.init() · onShow() ·
 *  onHide() · toggleEdit() (no edit chrome) · wantsPause() -> true
 * ====================================================================== */

window.LoadoutsPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;

  const NO_CLASS = '';
  const GLYPHS = ['⚑', '⚔', '🏹', '✨', '🛡', '🐉', '🔥', '❄', '⚡', '☠', '👑', '🌙', '☀', '🗡', '🪓', '🧪', '📜', '🐺', '🦅', '⚒'];

  /* Chrome glyphs are stroked inline SVG, never emoji: emoji are a font, so
     they arrive in someone else's colour, weight and baseline and read as
     clip-art next to real type. Same helper shape as followers-pane.js,
     which is play-proven under Ultralight. Emoji survive in exactly one
     place — the emblem a person CHOSE for a group or class (content). */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(paths, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 18));
    s.setAttribute('height', String(size || 18));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (Array.isArray(paths) ? paths : [paths]).forEach(function (d) {
      const n = document.createElementNS(SVG_NS, 'path');
      n.setAttribute('d', d);
      s.appendChild(n);
    });
    return s;
  }
  const ICONS = {
    bolt:    ['M13 3 5 13.5h5.2L10 21l8-10.5h-5.2L13 3z'],
    swap:    ['M7 5 3.5 8.5 7 12', 'M3.5 8.5H16', 'M17 19l3.5-3.5L17 12', 'M20.5 15.5H8'],
    pin:     ['M12 21.5s7-6.6 7-11.5a7 7 0 1 0-14 0c0 4.9 7 11.5 7 11.5z', 'M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
    shield:  ['M12 3l7.5 3v5.4c0 4.6-3.2 7.9-7.5 9.1-4.3-1.2-7.5-4.5-7.5-9.1V6L12 3z'],
    exit:    ['M14 4h4.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H14', 'M9.5 16 5.5 12l4-4', 'M5.5 12H15'],
    search:  ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M20 20l-4.4-4.4'],
    x:       ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    plus:    ['M12 5.5v13', 'M5.5 12h13'],
    pencil:  ['M4.5 19.5h4L19 9a2.12 2.12 0 0 0-3-3L5.5 16.5v3z'],
    flag:    ['M5.5 21V3.8', 'M5.5 4.5h11l-2 3.2 2 3.3h-11'],
    sword:   ['M14.5 4.5H20V10', 'M20 4.5l-8 8', 'M9.5 15.5 5 20', 'M6 12.5l5.5 5.5'],
    users:   ['M9 11.5a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z', 'M2.5 20.5c0-3.4 3-5.6 6.5-5.6s6.5 2.2 6.5 5.6',
              'M16.5 5a3.6 3.6 0 0 1 0 6.6', 'M18.5 20.5c0-2.2-.6-3.7-1.7-4.8'],
    check:   ['M5 12.5 9.8 17.3 19 6.8'],
    megaphone: ['M4.5 10v4a1.5 1.5 0 0 0 1.5 1.5h2L14 20V4L8 8.5H6A1.5 1.5 0 0 0 4.5 10z', 'M17.5 9.2a4 4 0 0 1 0 5.6'],
    diamond: ['M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5z'],
    camera:  ['M3.5 8.5h3l1.5-2.5h8l1.5 2.5h3v10h-17v-10z', 'M12 15.8a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6z'],
    follow:  ['M4.5 6.5 10 12l-5.5 5.5', 'M12.5 6.5 18 12l-5.5 5.5'],
    hold:    ['M9 5v14', 'M15 5v14'],
    crosshair: ['M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4z', 'M12 1.5v4.2', 'M12 18.3v4.2',
                'M1.5 12h4.2', 'M18.3 12h4.2', 'M12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z'],
    moon:    ['M20.5 14.8A8.6 8.6 0 0 1 9.2 3.5a8.6 8.6 0 1 0 11.3 11.3z'],
    sun:     ['M12 7.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4z', 'M12 1.8v2.6', 'M12 19.6v2.6',
              'M1.8 12h2.6', 'M19.6 12h2.6', 'M4.8 4.8 6.6 6.6', 'M17.4 17.4l1.8 1.8',
              'M19.2 4.8 17.4 6.6', 'M6.6 17.4 4.8 19.2'],
    star:    ['M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9L12 3.2z'],
    shieldOff: ['M12 3l7.5 3v5.4c0 4.6-3.2 7.9-7.5 9.1-4.3-1.2-7.5-4.5-7.5-9.1V6L12 3z', 'M4 4l16 16'],
  };
  function ico(name, size) { return svgIcon(ICONS[name] || ICONS.diamond, size); }
  const ORDER_ICON = { deploy: 'bolt', swap: 'swap', summon: 'pin', dress: 'shield', dismiss: 'exit',
                       follow: 'follow', wait: 'hold', sic: 'crosshair',
                       disengage: 'shieldOff', relax: 'moon', unrelax: 'sun' };

  /* A button whose label is preceded by an icon. */
  function iconBtn(cls, name, label, attrs) {
    const b = h('button', Object.assign({ class: cls, type: 'button' }, attrs || {}));
    b.appendChild(ico(name, 17));
    b.appendChild(h('span', null, label));
    return b;
  }

  /* ============================================================== state == */

  const state = {
    ready: false,      // a save is loaded
    nff: true,
    busy: false,       // a deploy/dismiss chain is running
    last: '',          // the last finished order's summary line
    active: '',        // the ★ group a bound key commands
    relaxed: false,    // what the deck last told the party about sandboxing
    lastAt: 0,         // epoch seconds
    loadouts: [],
    classes: [],
    roster: [],        // FO roster rows with faces + live flags
    rosterByKey: {},
    party: {},         // key -> true (with you right now)
    styles: [],
  };

  const ui = {
    mode: 'groups',    // groups | classes
    q: '',
    sel: '',           // selected loadout id
    selCls: '',        // selected class id
    visible: false,
    editing: '',       // '' | 'rename' | 'note' | 'new'
    armed: '',         // 'delete' | 'swap' | 'remove:<key>' | 'gear:<key>' — second click confirms
    picker: null,      // { kind: 'members'|'snapshot'|'style'|'class', … } overlay
    pickerQ: '',
    pickerSel: 0,
    toastT: null,
    bannerHidden: '',  // the `last` line the player dismissed
    glyphMenu: false,
    drag: null,        // key of the member card being dragged
    railSel: -1,       // keyboard cursor in the rail (-1 = none)
  };

  /* ============================================================= bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
      if (DEV && fn === 'loState') setTimeout(devState, 30);
      if (DEV && fn === 'loAct') setTimeout(function () { devAct(arg); }, 30);
    }
  }

  window.loStateResult = function (d) {
    if (!d || typeof d !== 'object') return;
    state.ready = d.ready !== false;
    state.nff = d.nff !== false;
    state.busy = !!d.busy;
    state.active = String(d.active || '');
    state.relaxed = !!d.relaxed;
    state.last = String(d.last || '');
    state.lastAt = Number(d.lastAt) || 0;
    state.loadouts = Array.isArray(d.loadouts) ? d.loadouts : [];
    state.classes = Array.isArray(d.classes) ? d.classes : [];
    state.roster = Array.isArray(d.roster) ? d.roster : [];
    state.styles = Array.isArray(d.styles) ? d.styles : [];
    state.rosterByKey = {};
    state.roster.forEach(function (r) { if (r && r.key) state.rosterByKey[r.key] = r; });
    state.party = {};
    (Array.isArray(d.party) ? d.party : []).forEach(function (k) { state.party[k] = true; });
    if (ui.sel && !loById(ui.sel)) ui.sel = '';
    if (ui.selCls && !clsById(ui.selCls)) ui.selCls = '';
    if (!ui.sel && state.loadouts.length) ui.sel = state.loadouts[0].id;
    if (!ui.selCls && state.classes.length) ui.selCls = state.classes[0].id;
    if (ui.visible) { render(); scheduleFaces(); }
  };

  window.loActResult = function (d) {
    if (!d || typeof d !== 'object') return;
    if (d.physical) {
      /* The palette is about to close under us. The job's real summary
         arrives as `last` on the next loState; this is the opening line. */
      toast(d.msg || 'Working…');
      return;
    }
    toast(d.msg || (d.ok ? 'Done' : 'Failed'), !d.ok);
    if (d.ok) {
      if (d.id) {
        const a = String(d.act || '');
        if (a.indexOf('lo') === 0) ui.sel = d.id;
        else if (a.indexOf('cls') === 0) ui.selCls = d.id;
      }
      toGame('loState');
    }
  };

  function act(o) { toGame('loAct', JSON.stringify(o)); }

  /* ============================================================ helpers == */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function h(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n[k] = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function highlight(text, q) {
    const t = String(text == null ? '' : text);
    if (!q) return esc(t);
    const i = t.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(t);
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
  }
  function loById(id) { for (let i = 0; i < state.loadouts.length; i++) if (state.loadouts[i].id === id) return state.loadouts[i]; return null; }
  function clsById(id) { for (let i = 0; i < state.classes.length; i++) if (state.classes[i].id === id) return state.classes[i]; return null; }
  function clsName(id) { const c = clsById(id); return c ? c.name : ''; }
  function keyOf(m) {
    if (!m) return '';
    if (m.key) return m.key;
    return String(m.formId || '').toLowerCase() + '|' + String(m.plugin || '').toLowerCase();
  }
  function rosterFor(m) { return state.rosterByKey[keyOf(m)] || null; }
  function withYou(m) { return !!state.party[keyOf(m)]; }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return parts.slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || '?';
  }
  function hueOf(s) {
    let n = 0;
    const t = String(s || '');
    for (let i = 0; i < t.length; i++) n = (n * 31 + t.charCodeAt(i)) >>> 0;
    return n % 360;
  }
  /* A class gets a hue from its NAME (stable across renames of other things,
     and the same colour on the card ring, the chip and the picker dot). */
  function clsHue(c) { return c ? hueOf(c.name) : 38; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ago(epochS) {
    if (!epochS) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - epochS);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  /* A member's status line and dot class — one place decides. */
  function statusOf(m) {
    const r = rosterFor(m);
    if (!r) return { cls: 'lost', text: 'not in the roster' };
    if (r.dead) return { cls: 'dead', text: 'dead' };
    if (withYou(m) || r.following) return { cls: 'with', text: 'with you' };
    if (r.inWorld === false) return { cls: 'away', text: 'far away' };
    return { cls: 'away', text: 'waiting elsewhere' };
  }
  function tally(members) {
    const t = { here: 0, away: 0, dead: 0, lost: 0, total: members.length };
    members.forEach(function (m) { const s = statusOf(m); if (s.cls === 'with') t.here++; else if (s.cls === 'dead') t.dead++; else if (s.cls === 'lost') t.lost++; else t.away++; });
    return t;
  }
  /* Who Swap would send away: everyone with you, not in the group, not an
     own-mod companion (C++ skips those too — keep the two in step). */
  function swapVictims(l) {
    const keep = {};
    (l.members || []).forEach(function (m) { keep[keyOf(m)] = 1; });
    return state.roster.filter(function (r) { return withYou(r) && !keep[keyOf(r)] && !r.guarded && !r.dead; });
  }

  /* =============================================================== faces == */

  let faceGroup = null;
  function facePeople() {
    const out = [];
    const seen = {};
    function add(m) {
      const k = keyOf(m);
      if (!k || seen[k]) return;
      seen[k] = 1;
      const r = rosterFor(m) || m;
      out.push({ fc: r.fc, formId: r.formId || m.formId, plugin: r.plugin || m.plugin, name: r.name || m.name, original: r.original || m.original });
    }
    state.loadouts.forEach(function (l) { (l.members || []).forEach(add); });
    if (ui.picker && (ui.picker.kind === 'members' || ui.picker.kind === 'snapshot')) state.roster.forEach(add);
    return out;
  }
  function ensureFaceGroup() {
    if (window.HDFace && typeof HDFace.group === 'function') {
      faceGroup = HDFace.group('lo-faces', {
        visible: function () { return ui.visible; },
        people: facePeople,
        onLand: function () { if (ui.visible) paintFaces(); },
      });
    }
  }
  function scheduleFaces() { ensureFaceGroup(); if (faceGroup) { try { faceGroup.schedule(); } catch (e) {} } }
  function stopFaces() { if (faceGroup) { try { faceGroup.stop(); } catch (e) {} } }

  /* One portrait plate: a circle that holds the best available face, or
     initials on a name-hued disc. The img is inserted BEFORE painting (the
     facegen layout crop resolves against its parent — hd-face.js). */
  function facePlate(m, size) {
    const r = rosterFor(m) || m || {};
    const who = { fc: r.fc, formId: r.formId || m.formId, plugin: r.plugin || m.plugin, name: r.name || m.name, original: r.original || m.original };
    const el = h('span', { class: 'lo-face lo-face-' + (size || 'md') });
    el.style.setProperty('--lo-hue', String(hueOf(who.original || who.name)));
    el.__loWho = who;
    el.setAttribute('data-face', '1');
    el.textContent = initialsOf(who.name);
    paintFaceInto(el);
    return el;
  }
  function paintFaceInto(el) {
    if (!el || !window.HDFace || el.querySelector('img')) return;
    let info = null;
    try { info = HDFace.for(el.__loWho); } catch (e) { info = null; }
    if (!info || !info.src) { el.classList.toggle('rendering', !!(info && info.state === 'rendering')); return; }
    const img = document.createElement('img');
    img.className = 'lo-face-img';
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', function () {
      if (img.parentNode === el) el.removeChild(img);
      el.classList.remove('has-face');
      el.textContent = initialsOf(el.__loWho && el.__loWho.name);
    });
    img.src = info.src;
    el.textContent = '';
    el.appendChild(img);
    el.classList.add('has-face');
    el.classList.remove('rendering');
    try { HDFace.paint(img, info); } catch (e) {}
  }
  function paintFaces(scope) {
    const root = scope || $('lo-pane');
    if (!root || !root.querySelectorAll) return;
    const plates = root.querySelectorAll('.lo-face[data-face]');
    for (let i = 0; i < plates.length; i++) paintFaceInto(plates[i]);
  }

  /* ================================================================ toast == */

  function toast(msg, err) {
    const el = $('lo-toast');
    if (!el) return;
    el.textContent = (err ? '⚠ ' : '✓ ') + msg;
    el.classList.toggle('err', !!err);
    el.classList.add('show');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { el.classList.remove('show'); }, err ? 4200 : 2600);
  }

  /* =============================================================== render == */

  function render() {
    renderHead();
    renderList();
    renderDetail();
    renderPicker();
    paintFaces();
  }

  function renderHead() {
    const chip = $('lo-count-chip');
    if (chip) {
      if (ui.mode === 'groups') {
        const here = Object.keys(state.party).length;
        chip.textContent = (state.loadouts.length ? plural(state.loadouts.length, 'group') : 'no groups yet') +
          (state.ready ? ' · ' + here + ' with you now' : '');
      } else {
        chip.textContent = state.classes.length ? plural(state.classes.length, 'class', 'classes') : 'no classes yet';
      }
    }
    const seg = $('lo-seg');
    if (seg) seg.querySelectorAll('button').forEach(function (b) {
      const on = b.getAttribute('data-mode') === ui.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const nff = $('lo-nff-note');
    if (nff) nff.classList.toggle('hidden', state.nff);
    const busy = $('lo-busy');
    if (busy) {
      busy.classList.toggle('hidden', !state.busy);
      busy.textContent = '⏳ still working on the last order';
    }
    const bg = document.querySelector('#lo-pane .lo-bar .lo-bar-glyph');
    if (bg && !bg.querySelector('svg')) { bg.textContent = ''; bg.appendChild(ico('search', 18)); }
    const s = $('lo-search');
    if (s) {
      /* the rail is 380px wide — a placeholder long enough to explain Enter
         clipped mid-word there, so the hint moved to the tooltip. */
      s.placeholder = ui.mode === 'groups' ? 'Search groups or people' : 'Search classes, gear or styles';
      s.title = ui.mode === 'groups'
        ? 'Search your groups and the people in them — Enter opens the top hit'
        : 'Search your classes, their gear and their styles — Enter opens the top hit';
    }
    const nb = $('lo-new');
    if (nb) {
      nb.textContent = '';
      nb.appendChild(ico('plus', 17));
      nb.appendChild(h('span', null, ui.mode === 'groups' ? 'New group' : 'New class'));
    }
  }

  /* ---------------------------------------------------------- the rail -- */

  function loMatches(l, q) {
    if (!q) return true;
    if (String(l.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if (String(l.note || '').toLowerCase().indexOf(q) !== -1) return true;
    for (let i = 0; i < (l.members || []).length; i++) {
      const m = l.members[i];
      if (String(m.name || '').toLowerCase().indexOf(q) !== -1) return true;
      if (m.cls && clsName(m.cls).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }
  function clsMatches(c, q) {
    if (!q) return true;
    if (String(c.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if (String(c.note || '').toLowerCase().indexOf(q) !== -1) return true;
    if (c.style && String(c.style.name || '').toLowerCase().indexOf(q) !== -1) return true;
    for (let i = 0; i < (c.gear || []).length; i++)
      if (String(c.gear[i].name || '').toLowerCase().indexOf(q) !== -1) return true;
    return false;
  }
  function visibleList() {
    const q = ui.q.trim().toLowerCase();
    return ui.mode === 'groups'
      ? state.loadouts.filter(function (l) { return loMatches(l, q); })
      : state.classes.filter(function (c) { return clsMatches(c, q); });
  }
  function selectRow(row) {
    if (ui.mode === 'groups') ui.sel = row.id; else ui.selCls = row.id;
    ui.editing = ''; ui.armed = ''; ui.glyphMenu = false;
    render();
  }

  function renderList() {
    const box = $('lo-list');
    if (!box) return;
    box.textContent = '';
    const q = ui.q.trim();
    const rows = visibleList();
    const empty = $('lo-empty');
    if (!rows.length) {
      /* The rail only speaks when the SEARCH found nothing — that fact is
         rail-local. "You have no groups" is the detail pane's invitation, and
         printing it here too put the same headline on screen twice with the
         permanent "＋ New group" button sitting between the two copies. */
      if (empty) {
        empty.classList.toggle('hidden', !q);
        empty.textContent = '';
        if (q) {
          empty.appendChild(h('div', { class: 'lo-empty-glyph' }, ico('search', 30)));
          empty.appendChild(h('div', { class: 'lo-empty-big' }, 'Nothing matches “' + q + '”'));
          empty.appendChild(h('div', { class: 'lo-empty-sub' }, 'Names, notes, members' + (ui.mode === 'groups' ? ' and classes' : ', gear and styles') + ' are all searched.'));
        }
      }
      return;
    }
    if (empty) empty.classList.add('hidden');
    rows.forEach(function (row, i) {
      box.appendChild(ui.mode === 'groups' ? groupRow(row, q, i) : classRow(row, q, i));
    });
  }

  function railRowShell(row, q, i, selected) {
    const el = h('div', {
      class: 'lo-row' + (selected ? ' lo-sel' : '') + (i === ui.railSel ? ' lo-cursor' : ''),
      role: 'button', tabindex: '0',
      onclick: function () { ui.railSel = -1; selectRow(row); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } },
    });
    return el;
  }

  function groupRow(l, q, i) {
    const members = l.members || [];
    const t = tally(members);
    const row = railRowShell(l, q, i, l.id === ui.sel);
    row.appendChild(h('span', { class: 'lo-row-glyph' }, l.icon || '⚑'));
    const mid = h('div', { class: 'lo-row-mid' });
    const name = h('div', { class: 'lo-row-name' });
    name.innerHTML = highlight(l.name, q);
    mid.appendChild(name);
    const stack = h('div', { class: 'lo-stack' });
    members.slice(0, 6).forEach(function (m) {
      const f = facePlate(m, 'xs');
      const s = statusOf(m);
      f.classList.add(s.cls === 'with' ? 'with' : 'away');
      f.title = m.name + ' — ' + s.text;
      stack.appendChild(f);
    });
    if (members.length > 6) stack.appendChild(h('span', { class: 'lo-stack-more' }, '+' + (members.length - 6)));
    if (!members.length) stack.appendChild(h('span', { class: 'lo-stack-none' }, 'nobody yet'));
    mid.appendChild(stack);
    /* The with-you meter: one glance says whether the squad is assembled. */
    if (members.length) {
      const meter = h('div', { class: 'lo-meter' + (t.here === t.total ? ' full' : (t.here ? ' some' : '')), title: t.here + ' of ' + t.total + ' with you' });
      meter.appendChild(h('span', { class: 'lo-meter-fill', style: 'width:' + Math.round(100 * t.here / t.total) + '%' }));
      mid.appendChild(meter);
    }
    row.appendChild(mid);
    const side = h('div', { class: 'lo-row-side' });
    const pinned = state.active === l.id;
    const star = h('button', {
      class: 'lo-star' + (pinned ? ' on' : ''), type: 'button',
      title: pinned ? 'This is the group your Group: keys command. Click to unpin.'
                    : 'Make this the group your Group: Follow / Wait / Sic \'em keys command',
      onclick: function (e) { e.stopPropagation(); act({ act: 'loPin', id: l.id }); },
    });
    star.appendChild(ico('star', 16));
    side.appendChild(star);
    side.appendChild(h('span', { class: 'lo-chip' + (t.here && t.here === t.total ? ' lo-chip-all' : (t.here ? ' lo-chip-some' : '')) },
      members.length ? (t.here + '/' + t.total) : '—'));
    side.appendChild(h('span', { class: 'lo-row-sub' }, members.length ? 'with you' : 'empty'));
    row.appendChild(side);
    return row;
  }

  function classRow(c, q, i) {
    const row = railRowShell(c, q, i, c.id === ui.selCls);
    const g = h('span', { class: 'lo-row-glyph lo-row-glyph-cls' }, c.icon || '⚔');
    g.style.setProperty('--lo-hue', String(clsHue(c)));
    row.appendChild(g);
    const mid = h('div', { class: 'lo-row-mid' });
    const name = h('div', { class: 'lo-row-name' });
    name.innerHTML = highlight(c.name, q);
    mid.appendChild(name);
    const sub = h('div', { class: 'lo-row-sub' });
    const bits = [];
    bits.push(plural((c.gear || []).length, 'piece'));
    if (c.style && c.style.name) bits.push(c.style.name);
    sub.textContent = bits.join(' · ');
    mid.appendChild(sub);
    row.appendChild(mid);
    let users = 0;
    state.loadouts.forEach(function (l) { (l.members || []).forEach(function (m) { if (m.cls === c.id) users++; }); });
    const side = h('div', { class: 'lo-row-side' });
    side.appendChild(h('span', { class: 'lo-chip' + (users ? ' lo-chip-some' : '') }, String(users)));
    side.appendChild(h('span', { class: 'lo-row-sub' }, users === 1 ? 'wearer' : 'wearers'));
    row.appendChild(side);
    return row;
  }

  /* -------------------------------------------------------- the detail -- */

  function renderDetail() {
    const box = $('lo-detail');
    if (!box) return;
    box.textContent = '';
    if (ui.editing === 'new') { renderNew(box); return; }
    if (ui.mode === 'groups') {
      const l = loById(ui.sel);
      if (!l) { box.appendChild(detailEmpty()); return; }
      renderGroupDetail(box, l);
    } else {
      const c = clsById(ui.selCls);
      if (!c) { box.appendChild(detailEmpty()); return; }
      renderClassDetail(box, c);
    }
    box.classList.remove('lo-enter');
    void box.offsetWidth;   // restart the entrance
    box.classList.add('lo-enter');
  }

  function detailEmpty() {
    const d = h('div', { class: 'lo-detail-empty' });
    if (ui.mode === 'groups') {
      const none = !state.loadouts.length;
      d.appendChild(h('div', { class: 'lo-empty-glyph' }, ico('flag', 34)));
      d.appendChild(h('div', { class: 'lo-empty-big' }, none ? 'No groups yet' : 'Follower Loadouts'));
      d.appendChild(h('div', { class: 'lo-empty-sub' }, none
        ? 'A group is a squad you bring with one press — the escort, the hunting party, the honour guard. Deploy brings everyone to you and recruits them; Swap sends the rest off first.'
        : 'Pick a group on the left. Deploy brings everyone to you and recruits them; Swap sends the rest off first.'));
      if (none) d.appendChild(iconBtn('lo-btn lo-btn-primary', 'plus', 'Make your first group', { onclick: newThing }));
    } else {
      const none = !state.classes.length;
      d.appendChild(h('div', { class: 'lo-empty-glyph' }, ico('sword', 34)));
      d.appendChild(h('div', { class: 'lo-empty-big' }, none ? 'No classes yet' : 'Gear Classes'));
      d.appendChild(h('div', { class: 'lo-empty-sub' }, none
        ? 'A class is a kit: armour, weapons and a fighting style you put on any follower in any group.'
        : 'Pick a class on the left, or make one — a kit of armour, weapons and a fighting style.'));
      if (none) d.appendChild(iconBtn('lo-btn lo-btn-primary', 'plus', 'Make your first class', { onclick: newThing }));
    }
    const b = lastBanner();
    if (b) d.appendChild(b);
    return d;
  }

  /* The last order's summary — the palette was shut while it ran, so this
     is the only place the player can read what happened. Dismissible. */
  function lastBanner() {
    if (!state.last || ui.bannerHidden === state.last) return null;
    const b = h('div', { class: 'lo-banner' });
    b.appendChild(h('span', { class: 'lo-banner-glyph' }, ico('megaphone', 19)));
    const mid = h('span', { class: 'lo-banner-mid' });
    mid.appendChild(h('span', { class: 'lo-banner-text' }, state.last));
    const when = ago(state.lastAt);
    if (when) mid.appendChild(h('span', { class: 'lo-banner-when' }, 'last order · ' + when));
    b.appendChild(mid);
    b.appendChild(h('button', { class: 'lo-mini', type: 'button', title: 'Dismiss',
      onclick: function () { ui.bannerHidden = state.last; renderDetail(); } }, '✕'));
    return b;
  }

  function heroBlock(obj, kind, hue) {
    const wrap = h('div', { class: 'lo-hero' });
    const glyphBtn = h('button', {
      class: 'lo-glyph-btn', type: 'button', title: 'Change the icon',
      onclick: function (e) { e.stopPropagation(); ui.glyphMenu = !ui.glyphMenu; renderDetail(); },
    }, obj.icon || (kind === 'lo' ? '⚑' : '⚔'));
    if (hue != null) glyphBtn.style.setProperty('--lo-hue', String(hue));
    wrap.appendChild(glyphBtn);
    const text = h('div', { class: 'lo-hero-text' });
    if (ui.editing === 'rename') {
      text.appendChild(editRow(obj.name, 'New name — Enter saves, Esc cancels', 60, function (v) {
        if (v) act({ act: kind + 'Rename', id: obj.id, name: v });
      }));
    } else {
      const line = h('div', { class: 'lo-hero-line' });
      line.appendChild(h('div', { class: 'lo-title-big', title: 'Click to rename',
        onclick: function () { ui.editing = 'rename'; ui.armed = ''; renderDetail(); } }, obj.name));
      line.appendChild(h('button', { class: 'lo-mini lo-mini-ghost', type: 'button', title: 'Rename',
        onclick: function () { ui.editing = 'rename'; ui.armed = ''; renderDetail(); } }, '✎'));
      text.appendChild(line);
    }
    if (ui.editing === 'note') {
      text.appendChild(editRow(obj.note, 'A note to self — Enter saves, Esc cancels', 400, function (v) {
        act({ act: kind + 'Note', id: obj.id, note: v });
      }));
    } else {
      text.appendChild(h('div', { class: 'lo-note-text' + (obj.note ? '' : ' empty'), title: 'Click to edit the note',
        onclick: function () { ui.editing = 'note'; ui.armed = ''; renderDetail(); } },
        obj.note || 'Add a note — where this squad goes, what it is for…'));
    }
    wrap.appendChild(text);
    return wrap;
  }

  function glyphMenu(obj, kind) {
    const box = h('div', { class: 'lo-glyphs' });
    GLYPHS.forEach(function (g) {
      box.appendChild(h('button', { class: 'lo-glyph-pick' + (g === obj.icon ? ' on' : ''), type: 'button', title: g,
        onclick: function () { ui.glyphMenu = false; act({ act: kind + 'Icon', id: obj.id, icon: g }); } }, g));
    });
    return box;
  }

  function editRow(value, placeholder, max, commit) {
    const row = h('div', { class: 'lo-edit-row' });
    const inp = h('input', { id: 'lo-edit-input', type: 'text', maxlength: String(max), placeholder: placeholder, autocomplete: 'off', spellcheck: 'false' });
    inp.value = value || '';
    const save = h('button', { class: 'lo-btn lo-btn-primary', type: 'button' }, 'Save');
    const cancel = h('button', { class: 'lo-btn', type: 'button', title: 'Esc' }, 'Cancel');
    function done() { const v = inp.value.trim(); ui.editing = ''; commit(v); renderDetail(); }
    save.addEventListener('click', done);
    cancel.addEventListener('click', function () { ui.editing = ''; renderDetail(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { done(); e.stopPropagation(); }
      else if (e.key === 'Escape') { ui.editing = ''; renderDetail(); e.stopPropagation(); }
      else e.stopPropagation();   // typing must never fall through to the palette
    });
    row.appendChild(inp);
    row.appendChild(save);
    row.appendChild(cancel);
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
    return row;
  }

  function orderBtn(key, label, sub, title, opts, onClick) {
    const o = opts || {};
    const b = h('button', {
      class: 'lo-order lo-order-' + key + (o.primary ? ' lo-order-primary' : '') + (o.armed ? ' lo-order-armed' : ''),
      type: 'button', title: title, disabled: o.disabled ? 'disabled' : null,
      onclick: function (e) { e.stopPropagation(); onClick(); },
    });
    const og = h('span', { class: 'lo-order-glyph' });
    og.appendChild(ico(ORDER_ICON[key] || 'diamond', o.primary ? 26 : 22));
    b.appendChild(og);
    const txt = h('span', { class: 'lo-order-text' });
    txt.appendChild(h('span', { class: 'lo-order-label' }, label));
    if (sub) txt.appendChild(h('span', { class: 'lo-order-sub' }, sub));
    b.appendChild(txt);
    return b;
  }

  function sectionHead(label, extra) {
    const s = h('div', { class: 'lo-section' });
    s.appendChild(h('span', { class: 'lo-section-label' }, label));
    (extra || []).forEach(function (e) { if (e) s.appendChild(e); });
    return s;
  }

  /* ---- a group ---- */

  function renderGroupDetail(box, l) {
    const members = l.members || [];
    const t = tally(members);

    const b = lastBanner();
    if (b) box.appendChild(b);

    box.appendChild(heroBlock(l, 'lo'));
    if (ui.glyphMenu) box.appendChild(glyphMenu(l, 'lo'));
    if (state.active === l.id) {
      const k = h('div', { class: 'lo-keyed', title: 'Your Group: Deploy / Follow / Wait / Sic \'em / Disengage keys command this group' });
      k.appendChild(ico('star', 15));
      k.appendChild(h('span', null, 'Your Group: keys command this one'));
      box.appendChild(k);
    }

    const classed = members.filter(function (m) { return m.cls; }).length;

    /* The stat strip is ALWAYS exactly four cells, so the row divides evenly
       at every width. Dead and missing are exceptions, not statistics — they
       get their own line underneath rather than making this row ragged. */
    function stat(n, label, tone) {
      const c = h('div', { class: 'lo-stat' + (tone ? ' lo-stat-' + tone : '') });
      c.appendChild(h('div', { class: 'lo-stat-n' }, String(n)));
      c.appendChild(h('div', { class: 'lo-stat-k' }, label));
      return c;
    }
    const stats = h('div', { class: 'lo-stats' });
    stats.appendChild(stat(members.length, members.length === 1 ? 'Follower' : 'Followers'));
    stats.appendChild(stat(t.here, 'With you', members.length && t.here === t.total ? 'good' : ''));
    stats.appendChild(stat(t.away, 'Away'));
    stats.appendChild(stat(classed + '/' + members.length, 'Classed',
      members.length && classed < members.length ? 'warn' : ''));
    box.appendChild(stats);

    if (t.dead || t.lost) {
      const bits = [];
      if (t.dead) bits.push(plural(t.dead, 'member') + ' dead');
      if (t.lost) bits.push(t.lost + ' no longer in your Follower Organizer roster');
      const al = h('div', { class: 'lo-alert', title: 'Remove them, or re-add them from your roster' });
      al.appendChild(ico('x', 17));
      al.appendChild(h('span', null, bits.join(' · ')));
      box.appendChild(al);
    }

    /* The ORDER DECK. Deploy is the headline. Swap arms first and says who
       it would send away — dismissing people is the one thing here you
       cannot undo with another click. */
    const can = state.ready && !state.busy && members.length > 0;
    const victims = swapVictims(l);
    const swapArmed = ui.armed === 'swap';
    const deck = h('div', { class: 'lo-orders' });
    deck.appendChild(orderBtn('deploy', 'Deploy', t.here === t.total && members.length ? 'all here — re-gathers + dresses' : 'summon + recruit everyone',
      'Teleport every member to you and recruit the ones not already following (one at a time, through NFF), then dress them by class',
      { primary: true, disabled: !can }, function () { ui.armed = ''; act({ act: 'deploy', id: l.id, mode: 'add' }); }));
    deck.appendChild(orderBtn('swap', swapArmed ? 'Really swap?' : 'Swap',
      swapArmed ? ('sends off ' + plural(victims.length, 'other') + ' first') : (victims.length ? plural(victims.length, 'other') + ' would leave' : 'nobody else to send off'),
      'Dismiss everyone with you who is NOT in this group, then deploy it. Asks twice.',
      { disabled: !can, armed: swapArmed }, function () {
        if (!swapArmed) { ui.armed = 'swap'; renderDetail(); return; }
        ui.armed = ''; act({ act: 'deploy', id: l.id, mode: 'swap' });
      }));
    deck.appendChild(orderBtn('summon', 'Summon', 'bring them, no recruit', 'Teleport every member to you without changing who follows',
      { disabled: !can }, function () { ui.armed = ''; act({ act: 'summon', id: l.id }); }));
    deck.appendChild(orderBtn('dress', 'Dress', classed ? 'apply ' + plural(classed, 'class', 'classes') + ' now' : 'no classes set yet',
      'Put every member\'s class gear on and set her fighting style (loaded members only)',
      { disabled: !can || !classed }, function () { ui.armed = ''; act({ act: 'dress', id: l.id }); }));
    deck.appendChild(orderBtn('dismiss', 'Dismiss', t.here ? 'send ' + plural(t.here, 'member') + ' off' : 'nobody following',
      'Dismiss every member who is following you',
      { disabled: !can || !t.here }, function () { ui.armed = ''; act({ act: 'dismiss', id: l.id }); }));

    /* Mass orders, scoped to THIS group (Rober, 2026-09-14: "mass orders? All
       follow, all wait, all attack target"). They act on the members who are
       actually with you, so the escort can hold a doorway while the rest of
       your people keep walking. Relax is the exception and says so: NFF's
       sandbox state is group-wide by design, with no per-follower order. */
    const withYou = t.here;
    deck.appendChild(orderBtn('follow', 'Follow', withYou ? plural(withYou, 'member') + ' fall in' : 'nobody with you',
      'Every member of this group who is with you follows again (NFF\'s own order)',
      { disabled: !can || !withYou }, function () { ui.armed = ''; act({ act: 'groupFollow', id: l.id }); }));
    deck.appendChild(orderBtn('wait', 'Wait', withYou ? plural(withYou, 'member') + ' hold here' : 'nobody with you',
      'Every member of this group who is with you waits where they stand - the rest of your followers carry on',
      { disabled: !can || !withYou }, function () { ui.armed = ''; act({ act: 'groupWait', id: l.id }); }));
    deck.appendChild(orderBtn('sic', 'Sic \'em', withYou ? 'attack what you aim at' : 'nobody with you',
      'Send this group at whoever you are looking at - or a distant enemy along your aim - right now',
      { disabled: !can || !withYou }, function () { ui.armed = ''; act({ act: 'groupSic', id: l.id }); }));
    deck.appendChild(orderBtn('disengage', 'Disengage', withYou ? 'break off and fall back' : 'nobody with you',
      'This group stops fighting, sheathes and follows you again. If the enemy is still alive and still hostile they will re-engage - this is a disengage, not a shield.',
      { disabled: !can || !withYou }, function () { ui.armed = ''; act({ act: 'groupDisengage', id: l.id }); }));
    box.appendChild(deck);

    /* Relax is the one order NFF cannot scope to a group, so it sits OUTSIDE
       the deck rather than pretending to belong to it — its separation is the
       honest signal. A toggle, because a Relax you cannot undo from the same
       place is a trap; the state is the deck's memory of what it last sent,
       since NFF exposes no read for "are they sandboxing right now". */
    const relaxed = !!state.relaxed;
    const relaxRow = h('div', { class: 'lo-aside' });
    relaxRow.appendChild(h('span', { class: 'lo-aside-label' }, 'Whole party'));
    relaxRow.appendChild(iconBtn('lo-btn lo-btn-quiet', relaxed ? 'sun' : 'moon',
      relaxed ? 'Stop relaxing' : 'Relax', {
        title: relaxed
          ? 'Bring the whole party back to you and stop the sandboxing'
          : 'The whole party sits, eats and wanders here until you stop it. NFF\'s sandbox state is party-wide - there is no per-group relax.',
        disabled: (!state.ready || state.busy) ? 'disabled' : null,
        onclick: function () { ui.armed = ''; act({ act: relaxed ? 'partyUnrelax' : 'partyRelax', id: l.id }); },
      }));
    box.appendChild(relaxRow);
    if (!state.ready) box.appendChild(h('div', { class: 'lo-hint' }, 'Load a save to use the group orders.'));
    else if (state.busy) box.appendChild(h('div', { class: 'lo-hint' }, 'The last order is still running — close the deck and let it finish.'));

    /* Members grid. */
    box.appendChild(sectionHead('Members' + (members.length ? ' · ' + members.length : ''), [
      iconBtn('lo-btn lo-btn-primary', 'plus', 'Add follower', { title: 'Pick followers from your roster',
        onclick: function () { openPicker({ kind: 'members', lo: l.id }); } }),
      iconBtn('lo-btn', 'users', 'Everyone with me now', { title: 'Add everyone who is walking with you right now',
        onclick: function () { act({ act: 'loAddParty', id: l.id }); } }),
    ]));

    const grid = h('div', { class: 'lo-grid' });
    if (!members.length) {
      const e = h('div', { class: 'lo-grid-empty' });
      e.appendChild(h('div', { class: 'lo-empty-glyph' }, ico('users', 34)));
      e.appendChild(h('div', { class: 'lo-empty-big' }, 'Nobody in ' + l.name + ' yet'));
      e.appendChild(h('div', { class: 'lo-empty-sub' }, 'Add followers from your roster, or everyone with you now. Drag cards to set the order they are called in.'));
      grid.appendChild(e);
    }
    members.forEach(function (m) { grid.appendChild(memberCard(l, m)); });
    wireDrag(grid, l);
    box.appendChild(grid);

    /* Danger zone, at the bottom where a stray click does not land. */
    const foot = h('div', { class: 'lo-foot' });
    const armed = ui.armed === 'delete';
    foot.appendChild(h('span', { class: 'lo-foot-hint' }, 'Drag cards to reorder · click a face\'s class chip to change it'));
    foot.appendChild(h('button', { class: 'lo-btn lo-btn-quiet' + (armed ? ' lo-btn-danger-armed' : ''), type: 'button',
      title: armed ? 'Click again to delete this group' : 'Delete this group (asks twice; nobody is dismissed)',
      onclick: function () {
        if (!armed) { ui.armed = 'delete'; renderDetail(); return; }
        ui.armed = ''; act({ act: 'loDelete', id: l.id });
      } }, armed ? '✕ Really delete “' + l.name + '”?' : '✕ Delete group'));
    box.appendChild(foot);
  }

  function memberCard(l, m) {
    const s = statusOf(m);
    const r = rosterFor(m);
    const key = keyOf(m);
    const cls = clsById(m.cls);
    const card = h('div', { class: 'lo-card lo-card-' + s.cls + (cls ? ' lo-card-classed' : ''), draggable: 'true', 'data-key': key });
    if (cls) card.style.setProperty('--lo-cls-hue', String(clsHue(cls)));
    const faceWrap = h('div', { class: 'lo-card-facewrap' });
    const face = facePlate(m, 'lg');
    face.classList.add('lo-card-face');
    faceWrap.appendChild(face);
    faceWrap.appendChild(h('span', { class: 'lo-badge lo-badge-' + s.cls, title: s.text }, s.cls === 'with' ? '●' : (s.cls === 'dead' ? '☠' : (s.cls === 'lost' ? '?' : '…'))));
    if (cls) faceWrap.appendChild(h('span', { class: 'lo-card-clsglyph', title: cls.name }, cls.icon || '⚔'));
    card.appendChild(faceWrap);
    card.appendChild(h('div', { class: 'lo-card-name', title: m.name }, m.name || '?'));
    const st = h('div', { class: 'lo-card-status' });
    st.appendChild(document.createTextNode(s.text));
    if (r && r.guarded) st.appendChild(h('span', { class: 'lo-tag', title: 'She has her own follower system — Deploy brings her to you but will not recruit her into NFF; use her own dialogue' }, 'own mod'));
    card.appendChild(st);
    const chip = h('button', { class: 'lo-class-chip' + (cls ? '' : ' none'), type: 'button',
      title: cls ? ('Class: ' + cls.name + (cls.style && cls.style.name ? ' · ' + cls.style.name : '') + ' — click to change') : 'No class — click to pick one',
      onclick: function (e) { e.stopPropagation(); openPicker({ kind: 'class', lo: l.id, member: m }); } });
    if (cls) {
      chip.appendChild(h('span', { class: 'lo-class-chip-dot' }));
      chip.appendChild(document.createTextNode(cls.name));
    } else chip.textContent = '+ class';
    card.appendChild(chip);
    const tools = h('div', { class: 'lo-card-tools' });
    if (cls && s.cls === 'with' && state.ready && !state.busy) {
      tools.appendChild(h('button', { class: 'lo-mini', type: 'button', title: 'Dress just her now',
        onclick: function (e) { e.stopPropagation(); act({ act: 'dressOne', id: l.id, formId: m.formId, plugin: m.plugin }); } }, '🛡'));
    }
    const armed = ui.armed === 'remove:' + key;
    tools.appendChild(h('button', { class: 'lo-mini' + (armed ? ' armed' : ''), type: 'button',
      title: armed ? 'Click again to remove her from the group' : 'Remove from this group',
      onclick: function (e) {
        e.stopPropagation();
        if (!armed) { ui.armed = 'remove:' + key; renderDetail(); return; }
        ui.armed = ''; act({ act: 'loRemove', id: l.id, formId: m.formId, plugin: m.plugin });
      } }, armed ? 'sure?' : '✕'));
    card.appendChild(tools);
    return card;
  }

  /* HTML5 drag to reorder the cards; the order is the order they are called
     in. Commits ONE loMove with the full key order on drop. */
  function wireDrag(grid, l) {
    grid.addEventListener('dragstart', function (e) {
      const card = e.target && e.target.closest ? e.target.closest('.lo-card') : null;
      if (!card) return;
      ui.drag = card.getAttribute('data-key');
      card.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ui.drag); } catch (x) {}
    });
    grid.addEventListener('dragend', function () {
      ui.drag = null;
      grid.querySelectorAll('.lo-card').forEach(function (c) { c.classList.remove('dragging', 'drop-before', 'drop-after'); });
    });
    grid.addEventListener('dragover', function (e) {
      if (!ui.drag) return;
      const over = e.target && e.target.closest ? e.target.closest('.lo-card') : null;
      if (!over || over.getAttribute('data-key') === ui.drag) return;
      e.preventDefault();
      const r = over.getBoundingClientRect();
      const before = (e.clientX - r.left) < r.width / 2;
      grid.querySelectorAll('.lo-card').forEach(function (c) { c.classList.remove('drop-before', 'drop-after'); });
      over.classList.add(before ? 'drop-before' : 'drop-after');
    });
    grid.addEventListener('drop', function (e) {
      if (!ui.drag) return;
      const over = e.target && e.target.closest ? e.target.closest('.lo-card') : null;
      if (!over) return;
      e.preventDefault();
      const r = over.getBoundingClientRect();
      const before = (e.clientX - r.left) < r.width / 2;
      const keys = (l.members || []).map(keyOf).filter(function (k) { return k !== ui.drag; });
      let at = keys.indexOf(over.getAttribute('data-key'));
      if (at < 0) return;
      if (!before) at++;
      keys.splice(at, 0, ui.drag);
      /* Reflect locally so the drop does not flash back, then let C++ own it. */
      const byKey = {};
      (l.members || []).forEach(function (m) { byKey[keyOf(m)] = m; });
      l.members = keys.map(function (k) { return byKey[k]; }).filter(Boolean);
      ui.drag = null;
      renderDetail(); paintFaces();
      act({ act: 'loMove', id: l.id, keys: keys });
    });
  }

  /* ---- a class ---- */

  function renderClassDetail(box, c) {
    const hue = clsHue(c);
    box.appendChild(heroBlock(c, 'cls', hue));
    if (ui.glyphMenu) box.appendChild(glyphMenu(c, 'cls'));

    const gear = c.gear || [];
    const users = [];
    state.loadouts.forEach(function (l) { (l.members || []).forEach(function (m) { if (m.cls === c.id) users.push({ m: m, l: l }); }); });
    /* Same four-cell strip the Groups page opens with — one shape for both
       halves of the tab, and a row that always divides evenly. */
    function cstat(v, label, text, tone) {
      const cell = h('div', { class: 'lo-stat' + (tone ? ' lo-stat-' + tone : '') });
      cell.appendChild(h('div', { class: 'lo-stat-n' + (text ? ' text' : ''), title: text ? String(v) : null }, String(v)));
      cell.appendChild(h('div', { class: 'lo-stat-k' }, label));
      return cell;
    }
    const stats = h('div', { class: 'lo-stats' });
    stats.appendChild(cstat(gear.length, gear.length === 1 ? 'Piece' : 'Pieces'));
    stats.appendChild(cstat(c.style && c.style.name ? c.style.name : 'Her own', 'Fighting style', true));
    stats.appendChild(cstat(users.length, users.length === 1 ? 'Wearer' : 'Wearers', false, users.length ? 'good' : ''));
    stats.appendChild(cstat(c.replace ? 'Replaces' : 'Adds on top', 'Worn armour', true));
    box.appendChild(stats);

    /* The two halves of a kit, side by side: how she fights, what she wears. */
    const two = h('div', { class: 'lo-two' });

    const styleCard = h('div', { class: 'lo-panel' });
    styleCard.appendChild(sectionHead('Fighting style'));
    const cur = c.style && c.style.name ? c.style : null;
    const styleBtn = h('button', { class: 'lo-style-cur' + (cur ? '' : ' none'), type: 'button',
      title: cur ? 'Click to change the fighting style' : 'Pick how followers of this class fight',
      onclick: function () { openPicker({ kind: 'style', cls: c.id }); } });
    if (cur) {
      styleBtn.appendChild(h('span', { class: 'lo-style-glyph' }, ico(cur.nff >= 0 ? 'sword' : 'diamond', 18)));
      const t = h('span', { class: 'lo-style-text' });
      t.appendChild(h('span', { class: 'lo-style-name' }, cur.name));
      t.appendChild(h('span', { class: 'lo-style-sub' }, cur.nff >= 0 ? 'Nether\'s Follower Framework style' : (cur.plugin || 'load order')));
      styleBtn.appendChild(t);
    } else {
      styleBtn.appendChild(h('span', { class: 'lo-style-glyph' }, ico('plus', 18)));
      const t = h('span', { class: 'lo-style-text' });
      t.appendChild(h('span', { class: 'lo-style-name' }, 'Leave her own style'));
      t.appendChild(h('span', { class: 'lo-style-sub' }, 'click to pick one — Archer, Wizard, Berserker…'));
      styleBtn.appendChild(t);
    }
    styleCard.appendChild(styleBtn);
    if (cur) styleCard.appendChild(h('button', { class: 'lo-btn lo-btn-quiet', type: 'button', title: 'Stop setting a fighting style for this class',
      onclick: function () { act({ act: 'clsStyle', id: c.id }); } }, 'Clear style'));
    styleCard.appendChild(h('div', { class: 'lo-hint' }, state.nff
      ? 'NFF\'s twelve named styles come first, then every combat style in the load order. It applies to her base record — a non-unique template shares it with every copy.'
      : 'Nether\'s Follower Framework is not loaded, so only the load order\'s own combat styles are offered.'));
    two.appendChild(styleCard);

    const gearCard = h('div', { class: 'lo-panel' });
    gearCard.appendChild(sectionHead('Kit' + (gear.length ? ' · ' + gear.length : ''), [
      h('button', { class: 'lo-btn lo-btn-primary', type: 'button', title: 'Search every item the load order ships',
        onclick: function () { openGearPicker(c); } }, '+ Add gear'),
      iconBtn('lo-btn', 'camera', 'Copy an outfit', { title: 'Copy the armour, weapons and ammo a loaded follower is wearing right now into this class (replaces the kit)',
        onclick: function () { openPicker({ kind: 'snapshot', cls: c.id }); } }),
    ]));
    const tog = h('label', { class: 'lo-toggle', title: 'Off: the class adds on top of what she wears. On: her worn armour comes off first so only the kit shows.' });
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!c.replace;
    cb.addEventListener('change', function () { act({ act: 'clsReplace', id: c.id, on: cb.checked }); });
    tog.appendChild(cb);
    tog.appendChild(h('span', { class: 'lo-toggle-knob' }));
    tog.appendChild(h('span', { class: 'lo-toggle-text' }, 'Replace worn armour when dressing'));
    gearCard.appendChild(tog);
    const list = h('div', { class: 'lo-gear' });
    if (!gear.length) {
      const e = h('div', { class: 'lo-grid-empty' });
      e.appendChild(h('div', { class: 'lo-empty-big' }, 'The kit is empty'));
      e.appendChild(h('div', { class: 'lo-empty-sub' }, 'Add pieces from the Finder, or copy what a follower is wearing.'));
      list.appendChild(e);
    }
    gear.forEach(function (g) { list.appendChild(gearRow(c, g)); });
    gearCard.appendChild(list);
    two.appendChild(gearCard);
    box.appendChild(two);
    paintGearArt(list);

    /* Who plays it. */
    box.appendChild(sectionHead(users.length ? plural(users.length, 'wearer') : 'Nobody wears this class yet', [
      users.length ? h('button', { class: 'lo-btn lo-btn-primary', type: 'button', title: 'Put this kit and style on every wearer who is loaded right now, across all groups',
        disabled: (state.ready && !state.busy) ? null : 'disabled',
        onclick: function () { act({ act: 'dressClass', id: c.id }); } }, '🛡 Dress all wearers now') : null,
    ]));
    if (users.length) {
      const strip = h('div', { class: 'lo-wearers' });
      users.forEach(function (u) {
        const s = statusOf(u.m);
        const b = h('button', { class: 'lo-wearer', type: 'button', title: u.m.name + ' — ' + s.text + ' · in ' + u.l.name + '. Click to open that group.',
          onclick: function () { ui.mode = 'groups'; ui.sel = u.l.id; ui.q = ''; const sx = $('lo-search'); if (sx) sx.value = ''; render(); } });
        b.style.setProperty('--lo-cls-hue', String(hue));
        const f = facePlate(u.m, 'sm');
        f.classList.add('lo-ring');
        b.appendChild(f);
        const t = h('span', { class: 'lo-wearer-text' });
        t.appendChild(h('span', { class: 'lo-wearer-name' }, u.m.name));
        t.appendChild(h('span', { class: 'lo-wearer-group' }, u.l.name + ' · ' + s.text));
        b.appendChild(t);
        strip.appendChild(b);
      });
      box.appendChild(strip);
    } else {
      box.appendChild(h('div', { class: 'lo-hint' }, 'Open a group and click a face\'s class chip to give her this class.'));
    }

    const foot = h('div', { class: 'lo-foot' });
    const armed = ui.armed === 'delete';
    foot.appendChild(h('span', { class: 'lo-foot-hint' }, 'Wearers keep whatever they were given — deleting a class only forgets the recipe.'));
    foot.appendChild(h('button', { class: 'lo-btn lo-btn-quiet' + (armed ? ' lo-btn-danger-armed' : ''), type: 'button',
      title: armed ? 'Click again to delete this class' : 'Delete this class (asks twice)',
      onclick: function () {
        if (!armed) { ui.armed = 'delete'; renderDetail(); return; }
        ui.armed = ''; act({ act: 'clsDelete', id: c.id });
      } }, armed ? '✕ Really delete “' + c.name + '”?' : '✕ Delete class'));
    box.appendChild(foot);
  }

  const KIND_GLYPH = { armor: '🛡', weapon: '⚔', ammo: '➶', light: '🕯', potion: '🧪', other: '◆' };

  function gearRow(c, g) {
    const key = String(g.plugin || '').toLowerCase() + '|' + String(g.formId || '').toLowerCase();
    const row = h('div', { class: 'lo-gear-row' });
    const art = h('span', { class: 'lo-gear-art', 'data-art': String(g.plugin || '') + '|' + String(g.formId || '') }, KIND_GLYPH[g.kind] || '◆');
    row.appendChild(art);
    const mid = h('div', { class: 'lo-gear-mid' });
    mid.appendChild(h('div', { class: 'lo-gear-name' }, g.name || g.formId));
    mid.appendChild(h('div', { class: 'lo-gear-sub' }, (g.kind || 'item') + ' · ' + (g.plugin || '')));
    row.appendChild(mid);
    const cnt = h('div', { class: 'lo-count' });
    cnt.appendChild(h('button', { class: 'lo-mini', type: 'button', title: 'One fewer',
      disabled: (g.count || 1) <= 1 ? 'disabled' : null,
      onclick: function () { act({ act: 'clsGearCount', id: c.id, formId: g.formId, plugin: g.plugin, count: Math.max(1, (g.count || 1) - 1) }); } }, '−'));
    cnt.appendChild(h('span', { class: 'lo-count-n' }, '×' + (g.count || 1)));
    cnt.appendChild(h('button', { class: 'lo-mini', type: 'button', title: 'One more',
      onclick: function () { act({ act: 'clsGearCount', id: c.id, formId: g.formId, plugin: g.plugin, count: (g.count || 1) + 1 }); } }, ico('plus', 15)));
    row.appendChild(cnt);
    const armed = ui.armed === 'gear:' + key;
    row.appendChild(h('button', { class: 'lo-mini' + (armed ? ' armed' : ''), type: 'button',
      title: armed ? 'Click again to remove' : 'Remove from the kit',
      onclick: function () {
        if (!armed) { ui.armed = 'gear:' + key; renderDetail(); return; }
        ui.armed = ''; act({ act: 'clsGearRemove', id: c.id, formId: g.formId, plugin: g.plugin });
      } }, armed ? 'sure?' : '✕'));
    return row;
  }

  function paintGearArt(root) {
    if (!root || !window.HDArt) return;
    const slots = root.querySelectorAll('.lo-gear-art[data-art]');
    for (let i = 0; i < slots.length; i++) {
      const el = slots[i];
      if (el.querySelector('img')) continue;
      const parts = String(el.getAttribute('data-art') || '').split('|');
      let a = null;
      try { a = HDArt.for({ kind: 'item', plugin: parts[0], formId: parts[1] }); } catch (e) { a = null; }
      if (!a || !a.src) continue;
      const img = HDArt.img(a, { class: 'lo-gear-img' }, 'has-art');
      if (!img) continue;
      el.textContent = '';
      el.appendChild(img);
      el.classList.add('has-art');
    }
  }

  function openGearPicker(c) {
    if (!window.HDItemPick || typeof HDItemPick.open !== 'function') { toast('The item picker is not loaded', true); return; }
    HDItemPick.open({
      host: $('lo-pane'),
      title: 'Add gear to ' + c.name,
      hint: 'Armour, weapons, ammo — anything she should carry. Stay open and add several.',
      confirm: 'Add',
      multi: true,
      chosen: function () {
        return (clsById(c.id) || c).gear.map(function (g) { return { plugin: g.plugin, localId: parseInt(String(g.formId).replace(/^0x/i, ''), 16) >>> 0 }; });
      },
      onPick: function (it) {
        act({ act: 'clsGearAdd', id: c.id, plugin: it.plugin, formId: '0x' + ((it.localId >>> 0).toString(16).toUpperCase()), name: it.name || '', count: 1 });
      },
    });
  }

  /* ============================================================== picker == */
  /* One overlay, four jobs: pick MEMBERS for a group (multi, stays open), pick
     ONE follower to snapshot into a class, pick a CLASS for a member, pick a
     STYLE for a class. Always a typeable search; Enter takes the top hit. */

  function openPicker(p) {
    ui.picker = p;
    ui.pickerQ = '';
    ui.pickerSel = 0;
    ui.armed = '';
    renderPicker();
    scheduleFaces();
    setTimeout(function () { const s = $('lo-picker-search'); if (s) { s.value = ''; s.focus(); } }, 30);
  }
  function closePicker() {
    ui.picker = null;
    renderPicker();
    const s = $('lo-search');
    if (s) s.focus();
  }

  function pickerRows() {
    const p = ui.picker;
    if (!p) return [];
    const q = ui.pickerQ.trim().toLowerCase();
    if (p.kind === 'members' || p.kind === 'snapshot') {
      const l = p.kind === 'members' ? loById(p.lo) : null;
      const inGroup = {};
      if (l) (l.members || []).forEach(function (m) { inGroup[keyOf(m)] = 1; });
      return state.roster.filter(function (r) {
        if (p.kind === 'snapshot' && !(withYou(r) || r.following)) return false;   // must be loaded to read her
        if (!q) return true;
        return String(r.name || '').toLowerCase().indexOf(q) !== -1 ||
          String(r.original || '').toLowerCase().indexOf(q) !== -1 ||
          String(r.cat || '').toLowerCase().indexOf(q) !== -1;
      }).map(function (r) { return { r: r, added: !!inGroup[keyOf(r)] }; })
        .sort(function (a, b) {
          /* With you first, then the rest A–Z — the people you are about to
             deploy are usually the ones standing beside you. */
          const aw = withYou(a.r) ? 0 : 1, bw = withYou(b.r) ? 0 : 1;
          if (aw !== bw) return aw - bw;
          return String(a.r.name || '').localeCompare(String(b.r.name || ''));
        });
    }
    if (p.kind === 'class') {
      const rows = [{ id: NO_CLASS, name: 'No class', icon: '—', sub: 'leave her gear and style alone', hue: null }];
      state.classes.forEach(function (c) {
        rows.push({ id: c.id, name: c.name, icon: c.icon || '⚔', hue: clsHue(c),
          sub: [plural((c.gear || []).length, 'piece'), c.style && c.style.name].filter(Boolean).join(' · ') });
      });
      return rows.filter(function (x) { return !q || String(x.name).toLowerCase().indexOf(q) !== -1; });
    }
    if (p.kind === 'style') {
      return state.styles.filter(function (s) {
        if (!q) return true;
        return String(s.name || '').toLowerCase().indexOf(q) !== -1 || String(s.plugin || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    return [];
  }

  function renderPicker() {
    const ov = $('lo-picker');
    if (!ov) return;
    const p = ui.picker;
    ov.classList.toggle('hidden', !p);
    ov.textContent = '';
    if (!p) return;
    const card = h('div', { class: 'lo-picker-card' + (p.kind === 'class' ? ' lo-picker-narrow' : ''), role: 'dialog', 'aria-modal': 'true' });
    const titles = {
      members: ['Add followers to ' + (loById(p.lo) || {}).name, 'Click a face to add her. The picker stays open — add the whole squad in one go.'],
      snapshot: ['Copy an outfit into ' + (clsById(p.cls) || {}).name, 'Only people who are loaded right now can be read. Her worn armour, weapons and ammo REPLACE the kit.'],
      class: ['Class for ' + (p.member ? p.member.name : ''), 'In this group only — she can play a different class in another group.'],
      style: ['Fighting style for ' + (clsById(p.cls) || {}).name, 'NFF\'s named styles first, then every combat style the load order ships.'],
    };
    const t = titles[p.kind] || ['', ''];
    const head = h('div', { class: 'lo-picker-title' });
    head.appendChild(h('span', { class: 'lo-picker-h' }, t[0]));
    head.appendChild(h('small', null, t[1]));
    head.appendChild(h('button', { class: 'lo-mini lo-picker-x', type: 'button', title: 'Close (Esc)', onclick: closePicker }, ico('x', 17)));
    card.appendChild(head);
    const bar = h('div', { class: 'lo-bar' });
    bar.appendChild(h('span', { class: 'lo-bar-glyph' }, ico('search', 18)));
    const inp = h('input', { id: 'lo-picker-search', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: p.kind === 'style' ? 'Search styles — try "archer" or "mage" (Enter = top hit)'
        : p.kind === 'class' ? 'Search classes (Enter = top hit)'
        : 'Search your roster — name or category (Enter = top hit)' });
    inp.value = ui.pickerQ;
    inp.addEventListener('input', function () { ui.pickerQ = inp.value; ui.pickerSel = 0; renderPickerList(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closePicker(); e.stopPropagation(); return; }
      if (e.key === 'Enter') { pickerFire(ui.pickerSel); e.stopPropagation(); return; }
      if (e.key === 'ArrowDown') { ui.pickerSel = Math.min(pickerRows().length - 1, ui.pickerSel + 1); renderPickerList(); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'ArrowUp') { ui.pickerSel = Math.max(0, ui.pickerSel - 1); renderPickerList(); e.preventDefault(); e.stopPropagation(); return; }
      e.stopPropagation();
    });
    bar.appendChild(inp);
    card.appendChild(bar);
    card.appendChild(h('div', { id: 'lo-picker-list', class: 'lo-picker-list' + (p.kind === 'members' || p.kind === 'snapshot' ? ' lo-picker-grid' : '') }));
    if (p.kind === 'members') card.appendChild(h('div', { class: 'lo-picker-foot' }, 'Enter adds the top hit · Esc closes · people with you now are listed first'));
    ov.appendChild(card);
    ov.onclick = function (e) { if (e.target === ov) closePicker(); };
    renderPickerList();
  }

  function renderPickerList() {
    const list = $('lo-picker-list');
    const p = ui.picker;
    if (!list || !p) return;
    list.textContent = '';
    const rows = pickerRows();
    const q = ui.pickerQ.trim();
    if (!rows.length) {
      const e = h('div', { class: 'lo-grid-empty' });
      e.appendChild(h('div', { class: 'lo-empty-big' }, q ? 'Nothing matches “' + q + '”' :
        (p.kind === 'snapshot' ? 'Nobody is loaded near you' : p.kind === 'class' ? 'No classes yet' : 'Your roster is empty')));
      e.appendChild(h('div', { class: 'lo-empty-sub' }, q ? 'Try a shorter name.' :
        (p.kind === 'snapshot' ? 'Bring her to you first, then copy her outfit.' : p.kind === 'class' ? 'Make one in Classes mode (＋ New class).' : 'Follower Organizer has nobody filed yet.')));
      list.appendChild(e);
      return;
    }
    if (ui.pickerSel >= rows.length) ui.pickerSel = rows.length - 1;
    let lastGroup = '';
    rows.forEach(function (row, i) {
      const sel = i === ui.pickerSel;
      if (p.kind === 'members' || p.kind === 'snapshot') {
        const r = row.r;
        const s = statusOf(r);
        /* Group headers split "with you" from "elsewhere" — only when unfiltered,
           a search should read as one flat list of hits. */
        const grp = withYou(r) ? 'With you now' : 'Elsewhere';
        if (!q && grp !== lastGroup) { list.appendChild(h('div', { class: 'lo-picker-group' }, grp)); lastGroup = grp; }
        const tile = h('button', { class: 'lo-tile' + (sel ? ' sel' : '') + (row.added ? ' added' : ''), type: 'button',
          title: row.added ? r.name + ' is already in the group' : r.name + (r.cat ? ' · ' + r.cat : '') + ' — ' + s.text,
          onclick: function () { pickerFire(i); }, onmouseenter: function () { ui.pickerSel = i; markSel(list, i); } });
        const fw = h('span', { class: 'lo-tile-facewrap' });
        fw.appendChild(facePlate(r, 'md'));
        fw.appendChild(h('span', { class: 'lo-badge lo-badge-' + s.cls }, s.cls === 'with' ? '●' : (s.cls === 'dead' ? '☠' : '…')));
        if (row.added) fw.appendChild(h('span', { class: 'lo-tile-check' }, ico('check', 16)));
        tile.appendChild(fw);
        const nm = h('div', { class: 'lo-tile-name' });
        nm.innerHTML = highlight(r.name, q);
        tile.appendChild(nm);
        tile.appendChild(h('div', { class: 'lo-tile-sub' }, row.added ? 'in the group' : (r.cat || s.text)));
        list.appendChild(tile);
      } else if (p.kind === 'class') {
        const b = h('button', { class: 'lo-pick-row' + (sel ? ' sel' : ''), type: 'button',
          onclick: function () { pickerFire(i); }, onmouseenter: function () { ui.pickerSel = i; markSel(list, i); } });
        const g = h('span', { class: 'lo-row-glyph' + (row.hue != null ? ' lo-row-glyph-cls' : '') }, row.icon);
        if (row.hue != null) g.style.setProperty('--lo-hue', String(row.hue));
        b.appendChild(g);
        const mid = h('span', { class: 'lo-pick-mid' });
        const nm = h('span', { class: 'lo-pick-name' }); nm.innerHTML = highlight(row.name, q); mid.appendChild(nm);
        if (row.sub) mid.appendChild(h('span', { class: 'lo-pick-sub' }, row.sub));
        b.appendChild(mid);
        if (p.member && p.member.cls === row.id) b.appendChild(h('span', { class: 'lo-tag lo-tag-nff' }, 'current'));
        list.appendChild(b);
      } else {
        const grp = row.nff >= 0 ? 'Nether\'s Follower Framework' : 'Load order';
        if (!q && grp !== lastGroup) { list.appendChild(h('div', { class: 'lo-picker-group' }, grp)); lastGroup = grp; }
        const b = h('button', { class: 'lo-pick-row' + (sel ? ' sel' : ''), type: 'button',
          onclick: function () { pickerFire(i); }, onmouseenter: function () { ui.pickerSel = i; markSel(list, i); } });
        b.appendChild(h('span', { class: 'lo-tag' + (row.nff >= 0 ? ' lo-tag-nff' : '') }, row.nff >= 0 ? 'NFF' : 'mod'));
        const mid = h('span', { class: 'lo-pick-mid' });
        const nm = h('span', { class: 'lo-pick-name' }); nm.innerHTML = highlight(row.name, q); mid.appendChild(nm);
        mid.appendChild(h('span', { class: 'lo-pick-sub' }, row.plugin || ''));
        b.appendChild(mid);
        const c = clsById(p.cls);
        if (c && c.style && c.style.formId === row.formId && String(c.style.plugin || '').toLowerCase() === String(row.plugin || '').toLowerCase())
          b.appendChild(h('span', { class: 'lo-tag lo-tag-nff' }, 'current'));
        list.appendChild(b);
      }
    });
    paintFaces(list);
  }

  function markSel(list, i) {
    const kids = list.querySelectorAll('.lo-tile, .lo-pick-row');
    for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('sel', k === i);
  }

  function pickerFire(i) {
    const p = ui.picker;
    const rows = pickerRows();
    if (!p || !rows.length) return;
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (p.kind === 'members') {
      if (row.added) { toast(row.r.name + ' is already in the group'); return; }
      act({ act: 'loAdd', id: p.lo, formId: row.r.formId, plugin: row.r.plugin, name: row.r.name, original: row.r.original || '' });
      /* Stay open: mark her added locally so a double-tap cannot re-send
         before the state reply lands. */
      const l = loById(p.lo);
      if (l) l.members.push({ formId: row.r.formId, plugin: row.r.plugin, name: row.r.name, original: row.r.original || '', cls: '', key: row.r.key });
      renderPickerList();
      return;
    }
    if (p.kind === 'snapshot') {
      act({ act: 'clsSnapshot', id: p.cls, formId: row.r.formId, plugin: row.r.plugin });
      closePicker();
      return;
    }
    if (p.kind === 'class') {
      act({ act: 'loSetClass', id: p.lo, formId: p.member.formId, plugin: p.member.plugin, cls: row.id });
      closePicker();
      return;
    }
    if (p.kind === 'style') {
      act({ act: 'clsStyle', id: p.cls, plugin: row.plugin, formId: row.formId, name: row.name, nff: row.nff });
      closePicker();
    }
  }

  /* ================================================================ host == */

  function newThing() {
    ui.editing = 'new';
    ui.armed = '';
    ui.glyphMenu = false;
    renderDetail();
  }

  function renderNew(box) {
    const kind = ui.mode === 'groups' ? 'lo' : 'cls';
    const wrap = h('div', { class: 'lo-new' });
    wrap.appendChild(h('div', { class: 'lo-empty-glyph' }, ico(kind === 'lo' ? 'flag' : 'sword', 34)));
    wrap.appendChild(h('div', { class: 'lo-empty-big' }, kind === 'lo' ? 'Name the new group' : 'Name the new class'));
    wrap.appendChild(h('div', { class: 'lo-empty-sub' }, kind === 'lo'
      ? 'Something you would say out loud — "Dragon Guard", "Night escort", "Hunting party".'
      : 'A role — "Dragon Warrior", "Dragon Archer", "Court mage".'));
    wrap.appendChild(editRow('', 'Enter creates, Esc cancels', 60, function (v) {
      if (v) act({ act: kind + 'New', name: v, icon: kind === 'lo' ? '⚑' : '⚔' });
    }));
    box.appendChild(wrap);
  }

  function onShow() {
    ui.visible = true;
    toGame('loState');
    render();
    scheduleFaces();
    const s = $('lo-search');
    if (s) setTimeout(function () { s.focus(); }, 40);
  }

  function onHide() {
    ui.visible = false;
    ui.picker = null;
    ui.editing = '';
    ui.armed = '';
    ui.glyphMenu = false;
    ui.railSel = -1;
    stopFaces();
    if (window.HDItemPick && HDItemPick.isOpen && HDItemPick.isOpen()) { try { HDItemPick.close(); } catch (e) {} }
  }

  function toggleEdit() {}
  function wantsPause() { return true; }

  function init() {
    const s = $('lo-search');
    if (s) {
      s.addEventListener('input', function () { ui.q = s.value; ui.railSel = -1; renderList(); });
      s.addEventListener('keydown', function (e) {
        const rows = visibleList();
        if (e.key === 'Enter') {
          const pick = rows[ui.railSel >= 0 ? Math.min(ui.railSel, rows.length - 1) : 0];
          if (pick) { ui.railSel = -1; selectRow(pick); }
          e.stopPropagation();
        } else if (e.key === 'ArrowDown') {
          ui.railSel = Math.min(rows.length - 1, ui.railSel + 1); renderList(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'ArrowUp') {
          ui.railSel = Math.max(-1, ui.railSel - 1); renderList(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === 'Escape') {
          if (ui.q) { ui.q = ''; s.value = ''; ui.railSel = -1; renderList(); e.stopPropagation(); }
        } else e.stopPropagation();
      });
    }
    const seg = $('lo-seg');
    if (seg) seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.mode = b.getAttribute('data-mode') === 'classes' ? 'classes' : 'groups';
        ui.editing = ''; ui.armed = ''; ui.glyphMenu = false; ui.q = ''; ui.railSel = -1;
        if (s) s.value = '';
        render();
      });
    });
    const nb = $('lo-new');
    if (nb) nb.addEventListener('click', newThing);
    const pane = $('lo-pane');
    if (pane) pane.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.picker) { closePicker(); e.stopPropagation(); }
    }, true);
  }

  /* ========================================================= dev fixture == */

  function devState() {
    window.loStateResult({
      ready: true, nff: true, busy: false,
      last: 'Dragon Guard: 4 brought, 3 recruited, 2 dressed, 2 restyled', lastAt: Math.floor(Date.now() / 1000) - 240,
      roster: [
        { formId: '0x1A6A1', plugin: 'Skyrim.esm', key: '0x1a6a1|skyrim.esm', name: 'Lydia', original: 'Lydia', cat: 'Housecarls', fc: '', following: true, inWorld: true, dead: false, guarded: false, unique: true },
        { formId: '0x13BAB', plugin: 'Skyrim.esm', key: '0x13bab|skyrim.esm', name: 'Jenassa', original: 'Jenassa', cat: 'Mercenaries', fc: '', following: false, inWorld: true, dead: false, guarded: false, unique: true },
        { formId: '0x800', plugin: 'ExampleCompanion.esp', key: '0x800|examplecompanion.esp', name: 'Example Companion', original: 'Example Companion', cat: 'Companions', fc: '', following: true, inWorld: true, dead: false, guarded: true, unique: true },
        { formId: '0x1348A', plugin: 'Skyrim.esm', key: '0x1348a|skyrim.esm', name: 'Uthgerd the Unbroken', original: 'Uthgerd', cat: 'Warriors', fc: '', following: false, inWorld: false, dead: false, guarded: false, unique: true },
      ],
      party: ['0x1a6a1|skyrim.esm', '0x800|examplecompanion.esp'],
      styles: [
        { plugin: 'nwsFollowerFramework.esp', formId: '0x1000', name: 'Mercenary', nff: 0 },
        { plugin: 'nwsFollowerFramework.esp', formId: '0x1003', name: 'Archer', nff: 3 },
        { plugin: 'Skyrim.esm', formId: '0x1F8A', name: 'csHumanMagic', nff: -1 },
      ],
      classes: [
        { id: 'c1', name: 'Dragon Warrior', icon: '🐉', note: '', replace: true, style: { plugin: 'nwsFollowerFramework.esp', formId: '0x1000', name: 'Mercenary', nff: 0 },
          gear: [{ plugin: 'Skyrim.esm', formId: '0x13949', name: 'Dragonplate Armor', kind: 'armor', count: 1 }, { plugin: 'Skyrim.esm', formId: '0x139B9', name: 'Ebony Greatsword', kind: 'weapon', count: 1 }] },
        { id: 'c2', name: 'Dragon Archer', icon: '🏹', note: '', replace: false, style: { plugin: 'nwsFollowerFramework.esp', formId: '0x1003', name: 'Archer', nff: 3 },
          gear: [{ plugin: 'Skyrim.esm', formId: '0x13940', name: 'Dragonscale Armor', kind: 'armor', count: 1 }, { plugin: 'Skyrim.esm', formId: '0x139B7', name: 'Ebony Bow', kind: 'weapon', count: 1 }, { plugin: 'Skyrim.esm', formId: '0x139BE', name: 'Ebony Arrow', kind: 'ammo', count: 100 }] },
      ],
      loadouts: [
        { id: 'l1', name: 'Dragon Guard', icon: '🐉', note: 'The heavy escort for anything north of Whiterun.',
          members: [
            { formId: '0x1A6A1', plugin: 'Skyrim.esm', key: '0x1a6a1|skyrim.esm', name: 'Lydia', original: 'Lydia', cls: 'c1' },
            { formId: '0x13BAB', plugin: 'Skyrim.esm', key: '0x13bab|skyrim.esm', name: 'Jenassa', original: 'Jenassa', cls: 'c2' },
            { formId: '0x800', plugin: 'ExampleCompanion.esp', key: '0x800|examplecompanion.esp', name: 'Example Companion', original: 'Example Companion', cls: '' },
          ] },
        { id: 'l2', name: 'Night escort', icon: '🌙', note: '', members: [
          { formId: '0x1348A', plugin: 'Skyrim.esm', key: '0x1348a|skyrim.esm', name: 'Uthgerd the Unbroken', original: 'Uthgerd', cls: 'c1' },
        ] },
      ],
    });
  }
  function devAct(arg) {
    let o = {};
    try { o = JSON.parse(arg); } catch (e) {}
    window.loActResult({ ok: true, act: o.act, msg: 'dev: ' + o.act, physical: /^(deploy|summon|dismiss|dress|dressOne|dressClass)$/.test(o.act) });
  }

  /* ============================================================= omni == */
  /* Ctrl+F finds a GROUP, a PERSON by the group she is in, and a CLASS by its
     name, style or gear. Indexed LIVE at query time from `state`, the same way
     every other provider does it, so a group made this session is findable
     without an omni edit.

     Enter deliberately OPENS rather than fires. Every verb on this tab is
     physical — Deploy teleports people, Sic 'em starts a fight — and a search
     box whose top hit can start a brawl is a trap; the deck's own law is that
     a physical act is chosen on purpose. So a hit takes you to it, with the
     rail filtered, and you press the order yourself. */
  function omniGoto(mode, id, q) {
    ui.mode = mode;
    ui.sel = id || '';
    ui.q = String(q || '');
    ui.railSel = -1;
    if (window.__omniSetTab) window.__omniSetTab('loadouts');
    const s = $('lo-search');
    if (s) s.value = ui.q;
    render();
  }

  if (window.HDOmni) HDOmni.register({
    id: 'loadouts', label: 'Loadouts', tab: 'loadouts',
    setFilter: function (q) {
      ui.q = String(q || '');
      ui.railSel = -1;
      const s = $('lo-search');
      if (s) s.value = ui.q;
      try { render(); } catch (e) {}
    },
    index: function () {
      const out = [];
      const classOf = function (id) { return (state.classes || []).find(function (c) { return c.id === id; }); };

      (state.loadouts || []).forEach(function (l) {
        const members = l.members || [];
        const t = tally(members);
        out.push({
          label: l.name || '(unnamed group)',
          detail: [plural(members.length, 'follower'),
                   members.length ? (t.here + ' with you') : '',
                   l.note].filter(Boolean).join(' · '),
          kind: state.active === l.id ? 'group ★' : 'group',
          /* the people in it, so "Lydia" finds the squad she rides with */
          keywords: members.map(function (m) { return m.name; }).concat(
            members.map(function (m) { const c = classOf(m.cls); return c ? c.name : ''; })).filter(Boolean).join(' '),
          pin: 'lo:' + l.id,
          icon: '',
          run: function () { omniGoto('groups', l.id, ''); },
        });
      });

      (state.classes || []).forEach(function (c) {
        const gear = c.gear || [];
        let wearers = 0;
        (state.loadouts || []).forEach(function (l) {
          (l.members || []).forEach(function (m) { if (m.cls === c.id) wearers++; });
        });
        out.push({
          label: c.name || '(unnamed class)',
          detail: [plural(gear.length, 'piece'),
                   (c.style && c.style.name) ? c.style.name : 'her own style',
                   wearers ? plural(wearers, 'wearer') : 'nobody wears it'].filter(Boolean).join(' · '),
          kind: 'class',
          keywords: gear.map(function (g) { return g.name; }).filter(Boolean).join(' '),
          pin: 'cls:' + c.id,
          icon: '',
          run: function () { omniGoto('classes', c.id, ''); },
        });
      });

      return out;
    },
    /* A pin re-resolves by id against the live state, so a renamed group keeps
       working and a deleted one greys out instead of silently doing nothing. */
    pinRun: function (snap, item) {
      const key = String((item && item.pin) || '');
      if (key.indexOf('lo:') === 0) {
        const id = key.slice(3);
        if (!(state.loadouts || []).some(function (l) { return l.id === id; })) return false;
        omniGoto('groups', id, '');
        return true;
      }
      if (key.indexOf('cls:') === 0) {
        const id = key.slice(4);
        if (!(state.classes || []).some(function (c) { return c.id === id; })) return false;
        omniGoto('classes', id, '');
        return true;
      }
      return false;
    },
  });

  return {
    init, onShow, onHide, toggleEdit, wantsPause,
    /* harness hooks */
    _state: state, _ui: ui, _render: render, _openPicker: openPicker, _pickerRows: pickerRows,
  };
})();
