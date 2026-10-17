/* Furniture + people picker logic (furn-pick.html).

   Bridge (C++ registers the listeners; we call them through toGame):
     toGame('fpPick', '{"key":"r0012AB34"|"none"|"default"}')   - a furniture choice
     toGame('fpPick', '{"keys":["a0001A2B3", ...]}')            - the people to add ([] = nobody)
     toGame('fpPoll', '')                                       - ask for renders / faces

   Called BY C++ (window.* injected via Invoke):
     window.fpShow(payload)    - {kind:'bed'|'select'|'actors', title, caption, noneLabel, items[], max?}
     window.fpRenders(payload) - {icons:{"<bid>":path},missing:n} or {faces:{"<key>":{portrait,face}},missing:n}
     window.fpHide()           - close without a round-trip

   Furniture: one tile shape; "No furniture" is the first tile, a peer of the others; beds,
   seats, other, each by distance. People: the same tile with a face (uploaded portrait first,
   else the deck's facegen render, else an initial), several can be ticked, Enter adds them.
   Keys are handled here because this view is the focused one while it is up. */
(function () {
  'use strict';
  var DEV = /[?&]dev=1/.test(location.search);

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { if (DEV) console.log('bridge error', fn, e); }
    } else if (DEV) {
      console.log('[fp->game]', fn, arg);
    }
  }
  function coerce(x) {
    if (x && typeof x === 'object') return x;
    try { return JSON.parse(String(x || '{}')); } catch (e) { return {}; }
  }
  function $(id) { return document.getElementById(id); }

  var ICON = {
    bed: 'hk-bed', singlebed: 'hk-bed', doublebed: 'hk-bed', bedroll: 'hk-bed',
    chair: 'hk-sit', bench: 'gl-chair',
    table: 'pos-bent-over-table', tableleanmarker: 'pos-bent-over-table', tableleanmarkerbbls: 'pos-bent-over-table',
    wall: 'pos-cowgirl-lean',
    wardrobe: 'hm-wardrobe', wardrobethick: 'hm-wardrobe', wardrobethin: 'hm-wardrobe',
    cookingpot: 'hk-hb-primcook', alchemytable: 'gl-potion', enchantingtable: 'hk-spellcraft',
    shelf: 'hm-rooms'
  };
  function fallbackFor(type) { return 'icons/custom/' + (ICON[type] || 'hm-rooms') + '.png'; }

  var GROUP_ORDER = { bed: 0, seat: 1, other: 2, near: 0, follow: 1, far: 2 };
  var GROUP_NAME = { all: 'All', bed: 'Beds', seat: 'Seats', other: 'Other', near: 'Nearby', follow: 'Followers', far: 'Elsewhere' };
  var GROUPS_FOR = { furniture: ['all', 'bed', 'seat', 'other'], actors: ['all', 'near', 'follow', 'far'] };

  var backdrop = $('fp-backdrop'), grid = $('fp-grid'), search = $('fp-search'), chips = $('fp-chips');
  var scroller = $('fp-scroll'), empty = $('fp-empty'), clearBtn = $('fp-clear'), goBtn = $('fp-go');

  var S = { open: false, payload: null, actors: false, items: [], group: 'all', query: '', sel: 0,
    tiles: [], visible: [], polls: 0, pollTimer: 0, picked: [], max: 3, privacy: '', consent: '', arrangement: '', hasTerms: false };

  function norm(s) { return String(s || '').toLowerCase(); }

  function visibleItems() {
    var q = norm(S.query).trim();
    var out = [];
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      if (S.group !== 'all' && it.group !== S.group) continue;
      if (q) {
        var hay = S.actors
          ? norm(it.name + ' ' + it.sub + ' ' + GROUP_NAME[it.group] + ' ' + (it.m < 0 ? 'elsewhere far away' : ''))
          : norm(it.name + ' ' + it.label + ' ' + it.type + ' ' + (it.owned ? 'owned' : '') + ' ' +
            (it.up ? 'upstairs' : '') + ' ' + (it.down ? 'downstairs below' : '') + ' ' + (it.nearest ? 'nearest' : ''));
        var parts = q.split(/\s+/), ok = true;
        for (var p = 0; p < parts.length; p++) if (hay.indexOf(parts[p]) < 0) { ok = false; break; }
        if (!ok) continue;
      }
      out.push(it);
    }
    return out;
  }

  function fmtDist(m) { return m < 10 ? m.toFixed(1) + ' m' : Math.round(m) + ' m'; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* Every choice carries the Public / Private answer, so C++ can tell CHIM before
     it answers OStim. The highlighted one is sent even if it was never touched. */
  function send(obj) {
    if (S.privacy) obj.privacy = S.privacy;
    if (S.hasTerms) obj.terms = { consent: S.consent, arrangement: S.arrangement };
    toGame('fpPick', JSON.stringify(obj));
  }
  /* One option row per group (privacy, consent, arrangement); exactly one is on. */
  function setOpt(group, val) {
    S[group] = val;
    [].forEach.call(document.querySelectorAll('.fp-priv[data-group="' + group + '"]'), function (b) {
      var on = b.getAttribute('data-mode') === val;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function setPrivacy(mode) { setOpt('privacy', mode); }
  function isPicked(key) { return S.picked.indexOf(key) >= 0; }

  /* the picture part of a person's tile: portrait, else render, else an initial */
  function fillPersonArt(art, it) {
    art.textContent = '';
    var src = it.portrait || it.face;
    if (src) {
      var img = el('img', 'fp-face');
      img.alt = '';
      img.src = src;
      art.appendChild(img);
      art.className = 'fp-art is-face';
    } else {
      art.appendChild(el('div', 'fp-initial', (it.name || '?').charAt(0).toUpperCase()));
      art.className = 'fp-art' + (it.pending ? ' is-waiting' : '');
    }
    if (it.m >= 0) art.appendChild(el('span', 'fp-badge-dist', fmtDist(it.m)));
    else art.appendChild(el('span', 'fp-badge-where', 'Elsewhere'));
    if (isPicked(it.key)) art.appendChild(el('span', 'fp-badge-pick', 'Added'));
  }

  function buildTile(it, index) {
    var b = el('button', 'fp-tile' + (it.none ? ' is-none' : '') + (isPicked(it.key) ? ' is-picked' : ''));
    b.type = 'button';
    b.setAttribute('data-key', it.key);
    var art = el('div', 'fp-art');
    if (S.actors) {
      fillPersonArt(art, it);
    } else {
      var img = el('img', it.icon && !it.none ? 'fp-render' : 'fp-fallback');
      img.alt = '';
      img.src = it.none ? 'icons/custom/sn-floor.png' : (it.icon || fallbackFor(it.type));
      img.setAttribute('data-bid', it.bid || '');
      art.appendChild(img);
      if (!it.none && !it.icon) art.className += ' is-waiting';
      if (!it.none) art.appendChild(el('span', 'fp-badge-dist', fmtDist(it.m)));
      if (it.nearest) art.appendChild(el('span', 'fp-badge-near', 'Nearest'));
    }
    b.appendChild(art);
    var info = el('div', 'fp-info');
    info.appendChild(el('div', 'fp-name', it.name));
    var sub = el('div', 'fp-sub');
    if (it.none) {
      sub.textContent = it.sub;
    } else if (S.actors) {
      var bits = [];
      if (it.sub) bits.push(it.sub);
      if (!it.now) bits.push('joins after the scene starts');
      sub.textContent = bits.join(' · ');
    } else {
      var f = [it.label];
      if (it.owned) f.push('Owned');
      if (it.up) f.push('Upstairs');
      if (it.down) f.push('Downstairs');
      sub.textContent = f.join(' · ');
    }
    info.appendChild(sub);
    b.appendChild(info);
    b.addEventListener('click', function () { if (S.actors) toggle(it.key); else pick(it.key); });
    b.addEventListener('mouseenter', function () { select(index, false); });
    return b;
  }

  function render() {
    var vis = visibleItems();
    var q = norm(S.query).trim();
    var showNone = false, none = null;
    if (!S.actors) {
      none = { none: true, key: 'none', name: (S.payload && S.payload.noneLabel) || 'No furniture',
        sub: S.payload && S.payload.kind === 'bed' ? 'Stay where you are, on the floor' : 'Start without furniture', type: '', group: 'none' };
      showNone = S.group === 'all' && (!q || norm(none.name + ' floor none no').indexOf(q) >= 0);
    }
    S.visible = (showNone ? [none] : []).concat(vis);
    grid.textContent = '';
    S.tiles = [];
    for (var i = 0; i < S.visible.length; i++) {
      var t = buildTile(S.visible[i], i);
      grid.appendChild(t);
      S.tiles.push(t);
    }
    empty.hidden = S.visible.length > 0;
    clearBtn.hidden = !S.query;
    if (S.sel >= S.visible.length) S.sel = Math.max(0, S.visible.length - 1);
    if (q && S.visible.length > 1 && S.visible[0].none) S.sel = 1;
    select(S.sel, false);
    syncGo();
    layoutTiles();
  }

  /* Columns are chosen so the last row is as full as it can be, and only that row
     stretches to fill the width: a grid never ends on empty cells. */
  var MINW = 340;
  function layoutTiles() {
    var n = S.tiles.length;
    if (!n) return;
    var phone = window.innerWidth <= 760, gap = phone ? 14 : 28;
    var w = grid.clientWidth || (window.innerWidth - 112);
    var maxC = phone ? 1 : Math.max(1, Math.floor((w + gap) / (MINW + gap)));
    var best = Math.min(maxC, n), bestFill = -1;
    for (var c = Math.min(maxC, n); c >= Math.max(1, Math.ceil(maxC * 0.6)); c--) {
      var rem = n % c, fill = rem === 0 ? 1 : rem / c;
      if (fill > bestFill + 0.001) { bestFill = fill; best = c; }
    }
    var basis = 'calc((100% - ' + ((best - 1) * gap) + 'px) / ' + best + ')';
    var rem2 = n % best, lastStart = rem2 ? n - rem2 : n;
    for (var i = 0; i < n; i++) {
      var last = i >= lastStart;
      S.tiles[i].style.flex = (last ? '1 1 ' : '0 0 ') + basis;
      S.tiles[i].style.maxWidth = last ? 'none' : '';
    }
  }
  var resizeT = 0;
  window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(layoutTiles, 80); });

  function select(i, scroll) {
    if (!S.tiles.length) return;
    i = Math.max(0, Math.min(S.tiles.length - 1, i));
    if (S.tiles[S.sel]) S.tiles[S.sel].classList.remove('is-sel');
    S.sel = i;
    var t = S.tiles[i];
    t.classList.add('is-sel');
    if (scroll) {
      var top = t.offsetTop, bot = top + t.offsetHeight;
      if (top < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - 8);
      else if (bot > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bot - scroller.clientHeight + 12;
    }
  }

  function moveVertical(dir) {
    var cur = S.tiles[S.sel];
    if (!cur) return;
    var cx = cur.offsetLeft + cur.offsetWidth / 2, cy = cur.offsetTop;
    var best = -1, bestScore = 1e9;
    for (var i = 0; i < S.tiles.length; i++) {
      var t = S.tiles[i], dy = t.offsetTop - cy;
      if (dir > 0 ? dy <= 4 : dy >= -4) continue;
      var score = Math.abs(dy) * 1000 + Math.abs(t.offsetLeft + t.offsetWidth / 2 - cx);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) select(best, true);
  }

  function buildChips() {
    var counts = { all: S.items.length };
    S.items.forEach(function (it) { counts[it.group] = (counts[it.group] || 0) + 1; });
    chips.textContent = '';
    var order = GROUPS_FOR[S.actors ? 'actors' : 'furniture'];
    var kinds = order.filter(function (g) { return g === 'all' || counts[g]; });
    if (kinds.length <= 2) return;   // one kind of thing: a filter would only repeat "All"
    kinds.forEach(function (g) {
      var b = el('button', 'fp-chip' + (S.group === g ? ' is-on' : ''));
      b.type = 'button';
      b.appendChild(document.createTextNode(GROUP_NAME[g] + ' '));
      b.appendChild(el('b', '', String(counts[g])));
      b.addEventListener('click', function () { S.group = g; S.sel = 0; buildChips(); render(); search.focus(); });
      chips.appendChild(b);
    });
  }

  /* ---- people: tick several, then add ---- */
  function syncGo() {
    if (!S.actors) { goBtn.hidden = true; return; }
    goBtn.hidden = false;
    $('fp-go-count').textContent = String(S.picked.length);
    goBtn.disabled = S.picked.length === 0;
    $('fp-note').textContent = S.note || (S.max ? 'Up to ' + S.max + ' more people fit in a scene.' : '');
  }
  function toggle(key) {
    var i = S.picked.indexOf(key);
    S.note = '';
    if (i >= 0) S.picked.splice(i, 1);
    else if (S.picked.length >= S.max) { S.note = 'A scene holds up to ' + S.max + ' more people - untick someone first.'; syncGo(); return; }
    else S.picked.push(key);
    render();
  }
  function confirmPeople() {
    if (!S.open || !S.actors) return;
    send({ keys: S.picked.slice() });
    hide();
  }

  function pick(key) {
    if (!S.open) return;
    send({ key: key });
    hide();
  }

  function show(payload) {
    var p = coerce(payload);
    S.payload = p;
    S.actors = p.kind === 'actors';
    S.max = p.max || 3;
    S.picked = []; S.note = '';
    S.items = (p.items || []).slice().sort(function (a, b) {
      var g = (GROUP_ORDER[a.group] || 0) - (GROUP_ORDER[b.group] || 0);
      if (g) return g;
      if (S.actors && (a.m < 0) !== (b.m < 0)) return a.m < 0 ? 1 : -1;
      if (S.actors && a.m < 0 && b.m < 0) return String(a.name).localeCompare(String(b.name));
      return a.m - b.m;
    });
    S.group = 'all'; S.query = ''; S.sel = 0; S.polls = 0;
    search.value = '';
    $('fp-title').textContent = p.title || 'Which furniture?';
    $('fp-caption').textContent = p.caption || '';
    $('fp-esc-text').textContent = S.actors ? (p.noneLabel || 'Nobody else') : (p.kind === 'bed' ? 'Use the nearest bed' : 'Use the nearest');
    $('fp-note').textContent = p.sceneRunning ? 'The running scene will move to the piece you pick.' : '';
    search.placeholder = S.actors ? 'Type a name - anyone loaded, a follower, someone elsewhere...'
      : 'Type to filter - bed, chair, owned, upstairs...';
    document.querySelector('.fp-hints-furn').style.display = S.actors ? 'none' : '';
    document.querySelector('.fp-hints-people').style.display = S.actors ? '' : 'none';
    var pv = p.privacy && typeof p.privacy === 'object' ? p.privacy : null;
    var tm = p.terms && typeof p.terms === 'object' ? p.terms : null;
    $('fp-privacy').hidden = !pv && !tm;
    $('fp-g-consent').hidden = !tm;
    $('fp-g-arrangement').hidden = !tm;
    S.privacy = ''; S.consent = ''; S.arrangement = ''; S.hasTerms = !!tm;
    var notes = [];
    if (pv) {
      setPrivacy(pv.current || pv['default'] || 'private');
      notes.push(pv.current ? 'Already told CHIM this scene is ' + pv.current + '.'
        : (pv.people >= 2 ? 'Other people are close by.' : 'Nobody else is close by.'));
    }
    if (tm) {
      var cur = String(tm.current || '').split('|');
      setOpt('consent', cur[0] || tm.consent || 'consensual');
      setOpt('arrangement', cur[1] || tm.arrangement || 'casual');
      if (tm.current) notes.push('CHIM already has the terms.');
    }
    $('fp-priv-note').textContent = notes.join(' ');
    buildChips();
    render();
    backdrop.classList.remove('fp-hidden');
    backdrop.setAttribute('aria-hidden', 'false');
    S.open = true;
    var near = -1;
    for (var i = 0; i < S.visible.length; i++) if (S.visible[i].nearest) { near = i; break; }
    if (near >= 0) select(near, true);
    try { search.focus(); } catch (e) {}
    schedulePoll();
  }

  function hide() {
    S.open = false;
    clearTimeout(S.pollTimer);
    backdrop.classList.add('fp-hidden');
    backdrop.setAttribute('aria-hidden', 'true');
  }

  function schedulePoll() {
    clearTimeout(S.pollTimer);
    if (!S.open || S.polls >= 40) return;
    S.pollTimer = setTimeout(function () { S.polls++; toGame('fpPoll', ''); schedulePoll(); }, 900);
  }

  function renders(payload) {
    var p = coerce(payload);
    if (!S.open) return;
    var icons = p.icons || {}, faces = p.faces || {};
    var changed = false;
    S.items.forEach(function (it) {
      if (S.actors) {
        var f = faces[it.key];
        if (f && ((f.portrait && f.portrait !== it.portrait) || (f.face && f.face !== it.face))) {
          it.portrait = f.portrait || it.portrait; it.face = f.face || it.face; it.pending = false; changed = true;
        }
      } else if (!it.icon && it.bid && icons[it.bid]) {
        it.icon = icons[it.bid]; changed = true;
      }
    });
    if (changed) {
      // Swap pictures in place: never rebuild the grid under the player's cursor.
      for (var i = 0; i < S.tiles.length; i++) {
        var item = S.visible[i];
        if (!item || item.none) continue;
        var art = S.tiles[i].querySelector('.fp-art');
        if (S.actors) {
          if ((item.portrait || item.face) && !art.querySelector('img.fp-face')) fillPersonArt(art, item);
        } else if (item.icon) {
          var img = art.querySelector('img');
          if (img && img.className !== 'fp-render') {
            img.className = 'fp-render';
            img.src = item.icon;
            art.className = art.className.replace(' is-waiting', '');
          }
        }
      }
    }
    if (!p.missing) clearTimeout(S.pollTimer);
  }

  search.addEventListener('input', function () { S.query = search.value; S.sel = 0; render(); });
  clearBtn.addEventListener('click', function () { search.value = ''; S.query = ''; S.sel = 0; render(); search.focus(); });
  $('fp-esc').addEventListener('click', function () { if (S.actors) { send({ keys: [] }); hide(); } else pick('default'); });
  [].forEach.call(document.querySelectorAll('.fp-priv'), function (b) {
    b.addEventListener('click', function () { setOpt(b.getAttribute('data-group'), b.getAttribute('data-mode')); });
  });
  goBtn.addEventListener('click', confirmPeople);

  document.addEventListener('keydown', function (e) {
    if (!S.open) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); if (S.actors) { send({ keys: [] }); hide(); } else pick('default'); return; }
    if (k === 'Enter') {
      e.preventDefault();
      var it = S.visible[S.sel];
      if (S.actors) {
        if (e.shiftKey && it) { toggle(it.key); return; }
        if (!S.picked.length && it) S.picked.push(it.key);   // a lone Enter takes the highlighted person
        confirmPeople();
        return;
      }
      if (it) pick(it.key);
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); moveVertical(1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); moveVertical(-1); return; }
    if (k === 'ArrowRight') { if (search.selectionStart === search.value.length) { e.preventDefault(); select(S.sel + 1, true); } return; }
    if (k === 'ArrowLeft') { if (search.selectionStart === 0 || !search.value) { e.preventDefault(); select(S.sel - 1, true); } return; }
    if (document.activeElement !== search && k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) search.focus();
  }, true);

  window.fpShow = show;
  window.fpHide = hide;
  window.fpRenders = renders;
})();
