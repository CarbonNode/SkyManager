'use strict';

/* ====================================================================== *
 *  Home — the deck's landing page (Rober, 2026-08-05).
 *
 *  Instead of hunting the tab strip: a card per system + a universal search
 *  that opens Omni over everything. It is the DEFAULT tab the deck opens to
 *  (but the "land on the tab you closed on" memory still wins over it), and
 *  the old Recent tab is folded into a collapsed drawer below the cards.
 *
 *  Self-contained like the other panes: owns its DOM (hm- prefixed), never
 *  touches app.js `state`. It reaches the deck through a small host contract
 *  (setTab / toGame / openOmni / hotkeyCount), handed in via hookInto — the
 *  same pattern HDOmni and HDShelf use. Counts come from the LIVE Omni
 *  provider registry, so a card's number is whatever that system holds right
 *  now, with zero new bridges.
 *
 *  Host contract (mirrors the other panes): HomePane.init() · onShow() ·
 *  onHide() · hookInto(host) · receiveRecent(payload) · toggleEdit()
 * ====================================================================== */

window.HomePane = (function () {

  var DEV = location.search.indexOf('dev=1') !== -1;
  var SELFTEST = location.search.indexOf('selftest=1') !== -1;

  /* Every system, in grid order. `act`: how a click navigates —
       'tab'    setTab(id) (the default)
       'spells' the Spell Deck is a separate PrismaUI view, opened via a launcher
       'ask'    open Omni straight in Ask mode
     `prov` (optional): an Omni provider id whose live index length becomes the
     card's count. `hk` marks the Hotkeys card, counted from the host. */
  /* `img` is the gold-glyph icon (icons/custom/hm-*.png, generated from the
     skyrim-deck-gold-glyph Forge prompt + icon_knockout). PLAIN path, no ?v=
     query — Ultralight drops the query and fails the load. `icon` is the emoji
     fallback if the PNG ever 404s (remove-on-error in renderCards). */
  var SYSTEMS = [
    { id: 'all',       name: 'Hotkeys',    icon: '⌨',  img: 'icons/custom/hm-hotkeys.png',   hue: '#c9a24b', sub: 'Your keybind palette',        act: 'tab', hk: true },
    { id: 'spells',    name: 'Spell Deck', icon: '✦',  img: 'icons/custom/hm-spells.png',    hue: '#8fb8ff', sub: 'Cast, equip & combos',        act: 'spells' },
    { id: 'followers', name: 'Followers',  icon: '👥', img: 'icons/custom/hm-followers.png', hue: '#e0a86a', sub: 'Summon, order, dress',        act: 'tab', prov: 'followers' },
    { id: 'quests',    name: 'Quests',     icon: '❈',  img: 'icons/custom/hm-quests.png',    hue: '#c9a24b', sub: 'Inspect & repair any quest',  act: 'tab' },
    { id: 'domains',   name: 'Domains',    icon: '📍', img: 'icons/custom/hm-domains.png',   hue: '#8fd8a0', sub: 'Mark a spot, click to travel',act: 'tab', prov: 'domains' },
    { id: 'containers',name: 'Containers', icon: '📦', img: 'icons/custom/hm-containers.png',hue: '#c9a24b', sub: 'Mark a chest, open it anywhere',act: 'tab', prov: 'containers' },
    { id: 'rooms',     name: 'Rooms',      icon: '🚪', img: 'icons/custom/hm-rooms.png',     hue: '#b79bff', sub: 'Claim a room, keep it yours', act: 'tab', prov: 'rooms' },
    { id: 'loot',      name: 'Loot',       icon: '✨', img: 'icons/custom/hm-loot.png',      hue: '#ffd36a', sub: 'Glow the loot worth grabbing',act: 'tab' },
    { id: 'anim',      name: 'Animations', icon: '🩰', img: 'icons/custom/hm-anim.png',      hue: '#e58fb0', sub: 'Apply a ZaZ animation',        act: 'tab' },
    { id: 'finances',  name: 'Finances',   icon: '⚖',  img: 'icons/custom/hm-finances.png',  hue: '#d0c07a', sub: 'Ledger, market & settle',     act: 'tab', prov: 'finances' },
    { id: 'wardrobe',  name: 'Wardrobe',   icon: '👗', img: 'icons/custom/hm-wardrobe.png',  hue: '#e58fb0', sub: 'Outfits & who dresses whom',  act: 'tab', prov: 'wardrobe' },
    { id: 'faces',     name: 'Faces',      icon: '🙂', img: 'icons/custom/hm-faces.png',     hue: '#8fd8ff', sub: 'Browse & apply RaceMenu presets', act: 'tab' },
    { id: 'numpad',    name: 'Numpad',     icon: '⌗',  img: 'icons/custom/hm-numpad.png',    hue: '#a49d8c', sub: 'Live on-screen keypad',        act: 'tab' },
    { id: 'ask',       name: 'Ask (CHIM)', icon: '🧠', img: 'icons/custom/hm-ask.png',       hue: '#b79bff', sub: 'Ask anything about anyone',    act: 'ask' },
  ];

  /* recent source glyphs (mirrors app.js RC_SOURCE, kept local so the drawer
     is self-contained) */
  var RC_IC = { entry: '⌨', action: '⚙', spell: '✦', ask: '🧠', quest: '❈', follower: '👥' };

  /* Time drawer — the compact wait control (Time is off the tab strip now).
     Same tm bridge TimePane uses: tmGet -> tmInfo, tmWait(hours) -> tmResult. */
  var MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed',
    'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];

  var host = { setTab: null, toGame: null, openOmni: null, hotkeyCount: null,
               getNotes: null, setNotes: null };
  var recent = { items: [], count: 0, max: 0 };
  var timeCur = null;   // last tmInfo {hour,day,month,year}
  var ui = { inited: false, recentOpen: false, notesOpen: false, timeOpen: false,
             tmChained: false, notesT: null };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* -------------------------------------------------------- live counts -- */
  function countFor(sys) {
    if (sys.hk && typeof host.hotkeyCount === 'function') {
      try { var n = host.hotkeyCount(); return n > 0 ? String(n) : ''; } catch (e) {}
    }
    if (sys.prov && window.HDOmni && HDOmni.providerById) {
      try {
        var p = HDOmni.providerById(sys.prov);
        if (p && typeof p.index === 'function') {
          var len = (p.index() || []).length;
          return len > 0 ? String(len) : '';
        }
      } catch (e) {}
    }
    return '';
  }

  /* ------------------------------------------------------------- cards -- */
  function navigate(sys) {
    if (sys.act === 'spells') { host.toGame && host.toGame('hdOpenSpells', ''); return; }
    if (sys.act === 'ask') { host.openOmni && host.openOmni('ask'); return; }
    host.setTab && host.setTab(sys.id);
  }

  function renderCards() {
    var grid = $('hm-grid');
    if (!grid) return;
    grid.innerHTML = '';
    SYSTEMS.forEach(function (sys) {
      var card = document.createElement('div');
      card.className = 'hm-card';
      card.setAttribute('role', 'listitem');
      card.tabIndex = 0;
      card.title = sys.name + ' — ' + sys.sub;
      card.style.setProperty('--hmc', sys.hue + '22');
      card.style.setProperty('--hmb', sys.hue + '55');

      var count = countFor(sys);
      if (count) {
        var cc = document.createElement('div');
        cc.className = 'hm-count';
        cc.textContent = count;
        card.appendChild(cc);
      }
      var plate = document.createElement('div');
      plate.className = 'hm-plate';
      plate.style.color = sys.hue;
      if (sys.img) {
        var im = document.createElement('img');
        im.src = sys.img;      // plain path — Ultralight eats a ?v= query
        im.alt = '';
        /* a stale/missing PNG must never leave a broken-image box — drop to the
           emoji glyph, the same remove-on-error the Favorites Shelf uses */
        im.onerror = function () { im.remove(); plate.textContent = sys.icon; };
        plate.appendChild(im);
      } else {
        plate.textContent = sys.icon;
      }
      var h = document.createElement('h3'); h.textContent = sys.name;
      var p = document.createElement('p'); p.textContent = sys.sub;
      card.appendChild(plate); card.appendChild(h); card.appendChild(p);

      card.addEventListener('click', function () { navigate(sys); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(sys); }
      });
      grid.appendChild(card);
    });
  }

  /* ------------------------------------------------------- recent drawer -- */
  function renderRecent() {
    var body = $('hm-recent-body');
    var cnt = $('hm-recent-count');
    if (!body) return;
    var items = recent.items || [];
    if (cnt) cnt.textContent = items.length ? String(items.length) : '';
    if (!ui.recentOpen) return;
    if (!items.length) {
      body.innerHTML = '<div class="hm-rc-empty">Nothing fired yet this session.</div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      var ic = RC_IC[it.source] || RC_IC.entry;
      return '<div class="hm-rc-row">' +
        '<span class="hm-rc-ic">' + ic + '</span>' +
        '<div class="hm-rc-t"><b>' + esc(it.name || '(unnamed)') +
          (it.times > 1 ? ' ×' + (it.times >>> 0) : '') + '</b>' +
          (it.category ? '<span>' + esc(it.category) + '</span>' : '') + '</div>' +
        '<span class="hm-rc-when">' + esc(it.ago || '') + '</span>' +
      '</div>';
    }).join('');
  }

  /* generic drawer open/close — flips the chevron + body, calls onOpen once */
  function setDrawer(id, open, onOpen) {
    var drawer = $('hm-' + id);
    var toggle = $('hm-' + id + '-toggle');
    var body = $('hm-' + id + '-body');
    if (drawer) drawer.classList.toggle('open', open);
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (body) body.classList.toggle('hidden', !open);
    if (open && onOpen) onOpen();
  }

  function toggleRecent() {
    ui.recentOpen = !ui.recentOpen;
    setDrawer('recent', ui.recentOpen, function () {
      /* the rendered "2m ago" cannot drift while folded, so refresh on open */
      if (host.toGame) host.toGame('hdHistory', '');
      renderRecent();
    });
  }

  /* ------------------------------------------------------- Notes drawer -- */
  function toggleNotes() {
    ui.notesOpen = !ui.notesOpen;
    setDrawer('notes', ui.notesOpen, function () {
      var ta = $('hm-notes-ta');
      if (ta && host.getNotes) {
        var v = host.getNotes();
        if (document.activeElement !== ta) ta.value = (v == null ? '' : v);
      }
      if (ta) ta.focus();
    });
  }
  function bindNotes() {
    var ta = $('hm-notes-ta');
    if (!ta) return;
    ta.addEventListener('input', function () {
      /* debounce the host save the same way the panes do */
      clearTimeout(ui.notesT);
      var v = ta.value;
      ui.notesT = setTimeout(function () { if (host.setNotes) host.setNotes(v); }, 250);
    });
  }

  /* -------------------------------------------------------- Time drawer -- */
  function fmtClock(hour) {
    var h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    var am = h < 12, disp = h % 12; if (disp === 0) disp = 12;
    return disp + ':' + (m < 10 ? '0' : '') + m + ' ' + (am ? 'AM' : 'PM');
  }
  function ordinal(n) {
    if (n % 10 === 1 && n !== 11) return n + 'st';
    if (n % 10 === 2 && n !== 12) return n + 'nd';
    if (n % 10 === 3 && n !== 13) return n + 'rd';
    return n + 'th';
  }
  function renderTime() {
    var clk = $('hm-time-clock'), dt = $('hm-time-date'), now = $('hm-time-now');
    if (!clk) return;
    if (!timeCur) { clk.textContent = '—:—'; if (dt) dt.textContent = 'reading the sky…'; return; }
    clk.textContent = fmtClock(timeCur.hour);
    var mon = MONTHS[((timeCur.month | 0) % 12 + 12) % 12] || '';
    if (dt) dt.textContent = ordinal(timeCur.day | 0) + ' of ' + mon + ' · 4E ' + (timeCur.year | 0);
    if (now) now.textContent = fmtClock(timeCur.hour);
    /* fill the "wait until" chips with the hours-away subtitle */
    var untils = $('hm-time-until');
    if (untils) Array.prototype.forEach.call(untils.querySelectorAll('.hm-time-chip'), function (b) {
      var target = parseFloat(b.getAttribute('data-until'));
      var h = target - timeCur.hour; if (h <= 0) h += 24;
      var sub = b.querySelector('.hm-time-sub');
      if (!sub) { sub = document.createElement('span'); sub.className = 'hm-time-sub'; b.appendChild(sub); }
      sub.textContent = 'in ' + h.toFixed(1) + ' h';
    });
  }
  function receiveTime(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    timeCur = d;
    renderTime();
  }
  function waitHours(h) { if (host.toGame && h) host.toGame('tmWait', String(h)); }
  function toggleTime() {
    ui.timeOpen = !ui.timeOpen;
    setDrawer('time', ui.timeOpen, function () {
      /* chain the tm receivers lazily — time-pane.js has loaded by the time a
         user opens this, so wrapping here (not at parse) is safe and keeps both
         TimePane and our drawer live off the one bridge name. */
      if (!ui.tmChained) {
        ui.tmChained = true;
        var pi = window.tmInfo;
        window.tmInfo = function (p) { receiveTime(p); if (typeof pi === 'function') return pi.apply(this, arguments); };
        var pr = window.tmResult;
        window.tmResult = function (p) { if (host.toGame) host.toGame('tmGet', ''); if (typeof pr === 'function') return pr.apply(this, arguments); };
      }
      if (host.toGame) host.toGame('tmGet', '');   // fresh clock on open
      renderTime();
    });
  }
  function bindTime() {
    var wire = function (wrapId, attr, fn) {
      var w = $(wrapId); if (!w) return;
      w.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.hm-time-chip') : null;
        if (!b) return;
        var v = parseFloat(b.getAttribute(attr));
        if (!isNaN(v)) fn(v);
      });
    };
    /* "wait until" target hour -> hours-from-now; "wait for" is the hours directly */
    wire('hm-time-until', 'data-until', function (target) {
      if (!timeCur) return;
      var h = target - timeCur.hour; if (h <= 0) h += 24;
      waitHours(h.toFixed(3));
    });
    wire('hm-time-for', 'data-hours', function (h) { waitHours(h); });
  }

  /* C++ pushes hdRecent; app.js owns the primary handler and forwards here so
     the drawer stays live without a second bridge name. */
  function receiveRecent(payload) {
    var d = payload;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d || typeof d !== 'object') return;
    recent = {
      items: Array.isArray(d.items) ? d.items : [],
      count: d.count >>> 0,
      max: d.max >>> 0,
    };
    renderRecent();
  }

  /* --------------------------------------------------------------- host -- */
  function hookInto(h) {
    host.setTab = h && h.setTab;
    host.toGame = h && h.toGame;
    host.openOmni = h && h.openOmni;
    host.hotkeyCount = h && h.hotkeyCount;
    host.getNotes = h && h.getNotes;
    host.setNotes = h && h.setNotes;
  }

  function bindSearch() {
    var box = $('hm-search');
    if (!box) return;
    var openSearch = function () { if (host.openOmni) host.openOmni('search'); };
    box.addEventListener('click', openSearch);
    box.addEventListener('focus', openSearch);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSearch(); }
    });
  }

  function init() {
    if (ui.inited) return true;
    if (!$('hm-pane')) { console.log('[home] #hm-pane missing — fragment not pasted?'); return false; }
    ui.inited = true;
    bindSearch();
    bindNotes();
    bindTime();
    var rt = $('hm-recent-toggle'); if (rt) rt.addEventListener('click', toggleRecent);
    var nt = $('hm-notes-toggle');  if (nt) nt.addEventListener('click', toggleNotes);
    var tt = $('hm-time-toggle');   if (tt) tt.addEventListener('click', toggleTime);
    if (SELFTEST) setTimeout(selftest, 60);
    return true;
  }

  function onShow() {
    if (!init()) return;
    renderCards();       // counts are live — re-read every show
    renderRecent();
    if (host.toGame) host.toGame('hdHistory', '');  // warm the drawer count
  }
  function onHide() {}
  function toggleEdit() { /* no edit chrome */ }
  function wantsPause() { return true; }

  /* ------------------------------------------------------------ selftest -- */
  function selftest() {
    var out = [];
    var ok = function (n, c) { out.push((c ? 'PASS ' : 'FAIL ') + n); };
    $('hm-pane').classList.remove('hidden');

    var nav = [];
    var notesStore = 'hello';
    hookInto({
      setTab: function (t) { nav.push('tab:' + t); },
      toGame: function (fn) { nav.push('game:' + fn); },
      openOmni: function (m) { nav.push('omni:' + m); },
      hotkeyCount: function () { return 34; },
      getNotes: function () { return notesStore; },
      setNotes: function (v) { notesStore = v; },
    });
    onShow();

    ok('pane mounted', !!$('hm-pane'));
    ok('14 cards render (time+notes moved to drawers)', $('hm-grid').children.length === 14);
    ok('no Time/Notes card', $('hm-grid').textContent.indexOf('Skip the slow wait') === -1 &&
      $('hm-grid').textContent.indexOf('scratchpad') === -1);
    ok('Hotkeys count from host', /34/.test($('hm-grid').children[0].textContent));
    var cards = $('hm-grid').children;
    cards[0].click();
    ok('hotkeys card -> setTab(all)', nav.indexOf('tab:all') !== -1);
    cards[1].click();
    ok('spells card -> launcher', nav.indexOf('game:hdOpenSpells') !== -1);
    cards[13].click();
    ok('ask card -> omni ask', nav.indexOf('omni:ask') !== -1);
    $('hm-search').click();
    ok('search launcher -> omni search', nav.indexOf('omni:search') !== -1);

    ok('recent drawer starts closed', !$('hm-recent').classList.contains('open'));
    toggleRecent();
    ok('recent opens', $('hm-recent').classList.contains('open'));
    ok('recent asked hdHistory', nav.indexOf('game:hdHistory') !== -1);
    receiveRecent({ items: [{ name: 'Full Save', category: 'Misc', ago: '2m ago', source: 'action' }], count: 1, max: 300 });
    ok('recent row renders', /Full Save/.test($('hm-recent-body').textContent));
    ok('recent count chip', $('hm-recent-count').textContent === '1');
    toggleRecent();
    ok('recent folds again', !$('hm-recent').classList.contains('open'));

    /* Notes drawer */
    toggleNotes();
    ok('notes opens', $('hm-notes').classList.contains('open'));
    ok('notes loads host value', $('hm-notes-ta').value === 'hello');
    var ta = $('hm-notes-ta'); ta.value = 'edited'; ta.dispatchEvent(new Event('input'));

    /* Time drawer */
    toggleTime();
    ok('time opens', $('hm-time').classList.contains('open'));
    ok('time asked tmGet', nav.indexOf('game:tmGet') !== -1);
    receiveTime({ hour: 21.78, day: 17, month: 7, year: 204 });
    ok('time clock renders', $('hm-time-clock').textContent === '9:46 PM');
    ok('time date names Last Seed', /Last Seed/.test($('hm-time-date').textContent));
    $('hm-time-for').querySelector('[data-hours="6"]').click();
    ok('wait chip fires tmWait', nav.indexOf('game:tmWait') !== -1);

    var fails = out.filter(function (l) { return l.indexOf('FAIL') === 0; });
    var box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;top:8px;z-index:99999;max-height:90vh;overflow:auto;' +
      'background:#111;color:#ddd;padding:10px;border:1px solid ' + (fails.length ? '#c85046' : '#4c8') +
      ';font:11px Consolas,monospace';
    box.textContent = out.join('\n') + '\n\n' + (out.length - fails.length) + '/' + out.length + ' passed';
    document.body.append(box);
    console.log(out.join('\n'));
  }

  return {
    init: init, onShow: onShow, onHide: onHide, hookInto: hookInto,
    receiveRecent: receiveRecent, toggleEdit: toggleEdit, wantsPause: wantsPause,
    _systems: SYSTEMS, _ui: ui
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.HomePane.init(); });
} else {
  window.HomePane.init();
}
