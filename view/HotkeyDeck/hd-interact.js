/* Interact — the F7 card's popout (Rober, 2026-10-14: "new interactions
   popout ... add to f7 on npc, hook to mod piggy back rides (hide power),
   hiding on same horse mod ... a button in f7 with a nice centered, spacious
   modal popout with icons", then "search through other mods for more
   injections", "a tab / category system", "a nice centered large modal for
   room").

   One large centred, body-anchored modal per person: a CATEGORY RAIL on the
   left (All · Carry · Affection · Travel · Looks · Hunting), the category's
   tiles on the right, a search over everything on top. Every tile drives a
   mod the player already runs, through that mod's own door
   (interact_actions.h): most cast the mod's own power at the person (the
   shape a survey of every enabled plugin turned up), Ride Along presses its
   own key, Hunterborn fires the deck's existing Hunterborn verbs.

   The C++ state reply says which doors are INSTALLED (a tile for a mod the
   player does not run is not drawn, nor is a category left empty) and, for
   each installed one, whether it can fire for THIS person and why not — a
   tile that cannot fire is dimmed WITH its reason, never hidden.

   Bridge: hdInteract({op:"state"|"cast"|"ride"|"power", ...})
           -> hdInteractState / hdInteractResult (response-style, so no
           hd-boot STUB_FNS entry). Firing closes the deck: the mods' Papyrus
           and input handlers only run unpaused.

   Keys: the popout owns the keyboard while up (window CAPTURE listener, the
   get-away.js idiom): typing goes to the search, Enter fires the top tile that
   can fire, arrows walk the rail or the tiles, Tab cycles, Esc clears the
   search and then closes. */
window.HDInteract = (function () {
  'use strict';

  /* Categories. `icon` is a stated property (the nav-icon law). */
  var CATS = [
    { id: 'all', label: 'All', icon: 'int-interact' },
    { id: 'carry', label: 'Carry', icon: 'int-piggyback' },
    { id: 'affection', label: 'Affection', icon: 'cat-lovers' },
    { id: 'intimate', label: 'Intimate', icon: 'int-intimate' },
    { id: 'travel', label: 'Travel', icon: 'int-ride-along' },
    { id: 'looks', label: 'Looks', icon: 'gl-masks' },
    { id: 'hunting', label: 'Hunting', icon: 'cat-hunters' },
    { id: 'more', label: 'More', icon: 'int-stats' },
  ];

  /* Tiles. `door` is the C++ row (kDoors) or 'ride'; `style` only for Carry
     Me. `mod` keys the per-mod note + power switch below. */
  var TILES = [
    { id: 'piggyback', door: 'carry', style: 'piggyback', cat: 'carry', mod: 'carryme', icon: 'int-piggyback',
      label: 'Piggyback ride', detail: 'Climb onto their back', keywords: 'piggyback piggy back carry me ride pick-a-back' },
    { id: 'bridal', door: 'carry', style: 'bridal', cat: 'carry', mod: 'carryme', icon: 'int-bridal',
      label: 'Bridal carry', detail: 'Carried in their arms', keywords: 'bridal carry arms cradle princess lift' },
    { id: 'front', door: 'carry', style: 'front', cat: 'carry', mod: 'carryme', icon: 'pos-carry',
      label: 'Front carry', detail: 'Held facing them · your weapon comes out first', keywords: 'front carry hug hold koala facing' },
    { id: 'shoulder', door: 'carry', style: 'shoulder', cat: 'carry', mod: 'carryme', icon: 'int-shoulder',
      label: 'Shoulder ride', detail: 'Up on their shoulders · your weapon comes out first', keywords: 'shoulder ride shoulders sit on top' },

    { id: 'kiss', door: 'kiss', cat: 'affection', mod: 'kissany', icon: 'int-kiss',
      label: 'Kiss', detail: 'A kiss — one of three, picked at random', keywords: 'kiss smooch lips kiss any woman' },
    { id: 'romance', door: 'romance', cat: 'affection', mod: 'aceromance', icon: 'pos-embrace',
      label: 'Romance pose', detail: 'Cuddle, hold, lap pillow, spooning… pick from its list', keywords: 'romance cuddle hold lap pillow spooning lying sitting kneeling embrace ace' },
    { id: 'spoon', door: 'spoon', cat: 'affection', mod: 'spooning', icon: 'pos-spooning',
      label: 'Spooning partner', detail: 'Make them partner A, B or C at bedtime', keywords: 'spooning spoon bed sleep together partner cuddle night' },

    { id: 'seduce', door: 'seduce', cat: 'intimate', mod: 'irresistible', icon: 'int-seduce',
      label: 'Seduce', detail: 'Irresistible’s charm, on them', keywords: 'seduce charm irresistible flirt lover' },
    { id: 'loveropts', door: 'loveropts', cat: 'intimate', mod: 'irresistible', icon: 'cat-lovers',
      label: 'Lover options', detail: 'Irresistible’s options for this lover', keywords: 'lover options irresistible romance partner' },
    { id: 'shadowanim', door: 'shadowanim', cat: 'intimate', mod: 'shadowanim', icon: 'int-intimate',
      label: 'Animations', detail: 'Pick a paired animation from its list', keywords: 'animations shadowman paired pose intimate' },

    { id: 'ride', door: 'ride', cat: 'travel', mod: 'ridealong', icon: 'int-ride-along',
      label: 'Ride with me', detail: 'Seat them behind you on your horse — or let them off', keywords: 'ride along horse same horse passenger behind me saddle double let off' },
    { id: 'cart1', door: 'cart1', cat: 'travel', mod: 'wagonborn', icon: 'int-cart', seat: '1',
      label: 'Cart seat 1', detail: 'Sit them in your cart', keywords: 'cart wagon passenger seat one 1 wagonborn' },
    { id: 'cart2', door: 'cart2', cat: 'travel', mod: 'wagonborn', icon: 'int-cart', seat: '2',
      label: 'Cart seat 2', detail: 'Sit them in your cart', keywords: 'cart wagon passenger seat two 2 wagonborn' },
    { id: 'cart3', door: 'cart3', cat: 'travel', mod: 'wagonborn', icon: 'int-cart', seat: '3',
      label: 'Cart seat 3', detail: 'Sit them in your cart', keywords: 'cart wagon passenger seat three 3 wagonborn' },
    { id: 'cart4', door: 'cart4', cat: 'travel', mod: 'wagonborn', icon: 'int-cart', seat: '4',
      label: 'Cart seat 4', detail: 'Sit them in your cart', keywords: 'cart wagon passenger seat four 4 wagonborn' },
    { id: 'saddle', door: 'saddle', cat: 'travel', mod: 'wagonborn', icon: 'hud-mount',
      label: 'Saddle up', detail: 'Hitch or saddle this horse for your cart', keywords: 'saddle horse hitch harness cart wagonborn' },

    { id: 'cosmetics', door: 'cosmetics', cat: 'looks', mod: 'effcosmetic', icon: 'hm-faces',
      label: 'Makeup & paint', detail: 'Warpaint, makeup and overlays, on them', keywords: 'cosmetics makeup warpaint paint overlay tattoo face eff' },
    { id: 'expressions', door: 'expressions', cat: 'looks', mod: 'fep', icon: 'gl-masks',
      label: 'Expression', detail: 'Set the look on their face', keywords: 'expression face mood smile emotion fep facial' },
    { id: 'physics', door: 'physics', cat: 'looks', mod: '3bbb', icon: 'int-physics',
      label: 'Body physics', detail: 'Turn their body physics on or off', keywords: 'physics smp jiggle 3bbb body toggle' },

    { id: 'obody', door: 'obody', cat: 'looks', mod: 'obody', icon: 'int-body',
      label: 'Body preset', detail: 'OBody’s preset picker for them', keywords: 'body preset obody shape bodyslide figure' },

    { id: 'hb-taxonomy', door: 'hb-taxonomy', cat: 'hunting', mod: 'hunterborn', icon: 'hk-hb-taxonomy',
      label: 'Taxonomy', detail: 'What it is and what it yields', keywords: 'taxonomy study identify creature hunterborn' },
    { id: 'hb-fielddress', door: 'hb-fielddress', cat: 'hunting', mod: 'hunterborn', icon: 'int-fielddress',
      label: 'Field dress', detail: 'Dress the carcass', keywords: 'field dress gut carcass hunterborn' },
    { id: 'hb-skin', door: 'hb-skin', cat: 'hunting', mod: 'hunterborn', icon: 'hk-hb-skin',
      label: 'Skin', detail: 'Take the pelt', keywords: 'skin pelt hide fur hunterborn' },
    { id: 'hb-harvest', door: 'hb-harvest', cat: 'hunting', mod: 'hunterborn', icon: 'hk-hb-harvest',
      label: 'Harvest', detail: 'Bones, teeth, claws, organs', keywords: 'harvest bones claws teeth hunterborn' },
    { id: 'hb-butcher', door: 'hb-butcher', cat: 'hunting', mod: 'hunterborn', icon: 'hk-hb-butcher',
      label: 'Butcher', detail: 'Cut the meat', keywords: 'butcher meat carve hunterborn' },
    { id: 'hb-process', door: 'hb-process', cat: 'hunting', mod: 'hunterborn', icon: 'gl-meat',
      label: 'Process', detail: 'Everything at once', keywords: 'process all everything carcass hunterborn' },

    { id: 'rename', door: 'rename', cat: 'more', mod: 'jaxonz', icon: 'int-rename',
      label: 'Rename', detail: 'Give them a new name', keywords: 'rename name label jaxonz call' },
    { id: 'fstats', door: 'fstats', cat: 'more', mod: 'followerstats', icon: 'int-stats',
      label: 'Their stats', detail: 'Skills, level and resistances', keywords: 'stats skills level resist follower stats sheet' },
    { id: 'kick', door: 'kick', cat: 'more', mod: 'kickthemall', icon: 'int-kick',
      label: 'Kick', detail: 'Boot them — Kick Them All', keywords: 'kick push boot shove kick them all' },
  ];

  /* One line per mod, shown above its tiles. */
  var MODS = {
    carryme: { name: 'Carry Me', note: 'Jump to get down. Your movement keys nudge your seat while carried.' },
    kissany: { name: 'Kiss Any Woman', note: 'Space ends the kiss.' },
    aceromance: { name: 'Ace Romance Animations', note: 'Opens its pose list; pick Reset to end a pose.' },
    spooning: { name: 'Spooning of Skyrim', note: 'Asks which partner slot, then who sleeps beside you.' },
    ridealong: { name: 'Ride Along', note: 'Uses its own key (RideAlong.ini). It seats the follower nearest you.' },
    wagonborn: { name: 'WagonBorn', note: 'Your cart has four passenger seats; Saddle up works on your cart horse.' },
    effcosmetic: { name: 'EFF Cosmetic Menu', note: 'Opens the cosmetic menu on them, not on you.' },
    fep: { name: 'Facial Expressions Project', note: 'Opens its expression picker for them.' },
    '3bbb': { name: '3BBB', note: 'Toggles their SMP body physics.' },
    hunterborn: { name: 'Hunterborn', note: 'Works on the carcass under your crosshair, the same as its own hotkeys.' },
    irresistible: { name: 'Irresistible', note: 'Works on whoever is under your crosshair; keep looking at them.' },
    shadowanim: { name: 'Shadowman Animations', note: 'Opens its animation list for whoever is under your crosshair; RESET ends it.' },
    obody: { name: 'OBody NG', note: 'Presses its preset key (MCM Helper setting) with them under your crosshair.' },
    jaxonz: { name: 'Jaxonz Renamer', note: 'Presses its rename key (read live from the game) with them under your crosshair.' },
    followerstats: { name: 'Follower Stats', note: 'Presses its stats key — it ships unbound, so set one in its MCM first.' },
    kickthemall: { name: 'Kick Them All', note: 'Presses its kick key with them under your crosshair. Costs stamina.' },
  };

  var S = { open: false, ctx: null, model: null, q: '', cat: 'all', note: '', noteOk: true, busy: '', waitTimer: 0 };
  var layer = null, search = null, rail = null, panel = null, noteEl = null, whoEl = null, focusBefore = null;

  try { S.cat = localStorage.getItem('hdi-cat') || 'all'; } catch (e) {}

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function send(obj) {
    if (typeof window.toGame === 'function') window.toGame('hdInteract', JSON.stringify(obj));
    else if (typeof window.hdInteract === 'function') window.hdInteract(JSON.stringify(obj));
  }
  function capture(on) {
    if (typeof window.toGame === 'function') window.toGame('hdCapture', on ? '1' : '0');
    else if (typeof window.hdCapture === 'function') window.hdCapture(on ? '1' : '0');
  }
  function icon(name, cls) {
    var img = el('img', cls);
    img.src = 'icons/custom/' + name + '.png';
    img.alt = '';
    img.draggable = false;
    img.setAttribute('aria-hidden', 'true');
    return img;
  }
  function who() { return (S.ctx && S.ctx.who) || 'them'; }
  function subjectId() { return (S.ctx && S.ctx.hex) || ''; }

  /* --------------------------------------------------------------- model --- */
  function doorOf(t) {
    var m = S.model;
    if (!m) return null;
    if (t.door === 'ride') {
      var r = m.ride || {};
      return { installed: !!r.installed, ready: !!r.ready, why: String(r.why || '') };
    }
    var ds = m.doors || [];
    for (var i = 0; i < ds.length; i++) if (ds[i].id === t.door) return ds[i];
    return { installed: false, ready: false, why: '' };
  }
  // { shown, ready, why, pending }
  function stateOf(t) {
    var d = doorOf(t);
    if (!d) return { shown: true, ready: false, why: 'Checking…', pending: true };
    if (!d.installed) return { shown: false, ready: false, why: '' };
    return { shown: true, ready: !!d.ready, why: d.ready ? '' : String(d.why || 'Not available right now') };
  }
  function matches(t, q) {
    if (!q) return true;
    var m = MODS[t.mod] || { name: '' };
    var hay = (t.label + ' ' + t.detail + ' ' + t.keywords + ' ' + m.name + ' ' + t.cat).toLowerCase();
    return q.split(/\s+/).every(function (w) { return !w || hay.indexOf(w) !== -1; });
  }
  function shownTiles() { return TILES.filter(function (t) { return stateOf(t).shown; }); }
  function catTiles(cat) {
    return shownTiles().filter(function (t) { return cat === 'all' || t.cat === cat; });
  }
  function catsShown() {
    return CATS.filter(function (c) { return c.id === 'all' || catTiles(c.id).length; });
  }
  // What the panel shows now: the search wins over the category.
  function visible() {
    var q = S.q.trim().toLowerCase();
    if (q) return shownTiles().filter(function (t) { return matches(t, q); });
    return catTiles(S.cat);
  }
  function topReady() {
    return visible().find(function (t) { return stateOf(t).ready; });
  }

  /* -------------------------------------------------------------- render --- */
  function render() {
    if (!layer) return;
    var active = document.activeElement;
    var focusKey = active && active.dataset ? (active.dataset.tile || active.dataset.cat || '') : '';
    var focusKind = active && active.dataset ? (active.dataset.tile ? 'tile' : active.dataset.cat ? 'cat' : '') : '';
    if (whoEl) whoEl.textContent = 'with ' + who();
    if (!catsShown().some(function (c) { return c.id === S.cat; })) S.cat = 'all';
    renderRail();
    renderPanel();
    noteEl.textContent = S.note;
    noteEl.className = 'hdi-note' + (S.note ? (S.noteOk ? ' is-ok' : ' is-bad') : '');
    if (focusKey) {
      var sel = focusKind === 'tile' ? '[data-tile="' + focusKey + '"]' : '[data-cat="' + focusKey + '"]';
      var back = layer.querySelector(sel);
      if (back) back.focus();
    }
  }

  function renderRail() {
    rail.textContent = '';
    var searching = !!S.q.trim();
    var cats = catsShown();
    rail.className = 'hdi-rail hdi-rail-' + cats.length;
    /* Phone: the rail is a 12-track grid; every row is filled, the last one
       with wider cells — never a ragged 3 + 3 + 2. (Ignored by the desktop
       column, which is flex.) */
    var per = cats.length <= 4 ? cats.length : (cats.length <= 6 ? 3 : 4);
    var lastRow = cats.length % per || per;
    cats.forEach(function (c, i) {
      var n = catTiles(c.id).length;
      var on = !searching && c.id === S.cat;
      var b = el('button', 'hdi-cat' + (on ? ' is-on' : ''));
      b.type = 'button';
      b.dataset.cat = c.id;
      b.setAttribute('aria-pressed', String(on));
      var inLast = i >= cats.length - lastRow;
      b.style.setProperty('--hdi-span', String(12 / (inLast ? lastRow : per)));
      b.title = c.label + ' — ' + (S.model ? n + ' interaction' + (n === 1 ? '' : 's') : 'checking…');
      var plate = el('span', 'hdi-cat-plate');
      plate.appendChild(icon(c.icon, 'hdi-cat-ic'));
      b.appendChild(plate);
      b.appendChild(el('span', 'hdi-cat-lbl', c.label));
      b.appendChild(el('span', 'hdi-cat-n', S.model ? String(n) : '·'));
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        S.cat = c.id;
        try { localStorage.setItem('hdi-cat', c.id); } catch (er) {}
        if (search && search.value) { search.value = ''; S.q = ''; }
        render();
      });
      rail.appendChild(b);
    });
  }

  function renderPanel() {
    panel.textContent = '';
    var searching = !!S.q.trim();
    var cat = CATS.find(function (c) { return c.id === S.cat; }) || CATS[0];
    var tiles = visible();

    var head = el('div', 'hdi-panel-head');
    head.appendChild(el('h3', 'hdi-panel-title', searching ? 'Results for “' + S.q.trim() + '”' : cat.label));
    panel.appendChild(head);

    if (!tiles.length) {
      panel.appendChild(el('p', 'hdi-empty', searching
        ? 'Nothing here matches “' + S.q.trim() + '”.'
        : (S.model ? 'None of the mods this needs are installed.' : 'Checking what your mods can do…')));
      return;
    }

    var mixed = searching || S.cat === 'all';   // tiles from several categories: each names its mod
    var grid = el('div', 'hdi-tiles');
    var cols = tiles.length <= 4 ? tiles.length : (tiles.length % 3 === 0 ? 3 : 4);
    grid.className = 'hdi-tiles hdi-cols-' + cols;
    var rest = tiles.length % cols;   // a short last row stretches instead of leaving holes
    tiles.forEach(function (t, i) {
      var tile = tileEl(t, mixed);
      if (rest && i >= tiles.length - rest) tile.style.gridColumn = 'span ' + spanFor(cols, rest, i - (tiles.length - rest));
      grid.appendChild(tile);
    });
    panel.appendChild(grid);

    // Below the tiles: one line per mod in view — its name, how it behaves,
    // and its power switch. The tiles come first; this is the small print.
    var mods = [];
    tiles.forEach(function (t) { if (mods.indexOf(t.mod) === -1) mods.push(t.mod); });
    var notes = el('div', 'hdi-mods');
    notes.appendChild(el('h4', 'hdi-mods-title', mods.length === 1 ? 'About this mod' : 'About these mods'));
    mods.forEach(function (id) { notes.appendChild(modRow(id)); });
    panel.appendChild(notes);
  }

  // Spread `rest` tiles over `cols` columns: e.g. 4 cols, 2 left -> 2 + 2; 4 cols, 3 left -> 2 + 1 + 1.
  function spanFor(cols, rest, k) {
    var base = Math.floor(cols / rest), extra = cols % rest;
    return base + (k < extra ? 1 : 0);
  }

  function modRow(id) {
    var info = MODS[id] || { name: id, note: '' };
    var row = el('div', 'hdi-mod');
    row.appendChild(el('span', 'hdi-mod-name', info.name));
    row.appendChild(el('span', 'hdi-mod-note', info.note));
    var m = S.model && (S.model.mods || []).find(function (x) { return x.id === id; });
    if (m && m.hideable && (m.known || m.hidden)) {
      var b = el('button', 'hdi-btn hdi-power', m.hidden ? 'Show its power' : 'Hide its power');
      b.type = 'button';
      b.title = m.hidden
        ? info.name + '’s power is hidden from your Magic menu — these tiles cast it for you. Show it to keep it there.'
        : info.name + '’s power is in your Magic menu. Hide it: these tiles cast it for you.';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        send({ op: 'power', mod: id, hide: !m.hidden, formId: subjectId() });
      });
      row.appendChild(b);
    }
    return row;
  }

  function tileEl(t, mixed) {
    var st = stateOf(t);
    var b = el('button', 'hdi-tile' + (st.ready ? '' : ' is-off') + (S.busy === t.id ? ' is-busy' : ''));
    b.type = 'button';
    b.dataset.tile = t.id;
    b.setAttribute('aria-disabled', String(!st.ready));
    b.title = st.ready ? (t.label + ' — ' + t.detail) : st.why;
    var plate = el('span', 'hdi-plate');
    plate.appendChild(icon(t.icon, 'hdi-ic'));
    if (t.seat) plate.appendChild(el('span', 'hdi-seat', t.seat));
    b.appendChild(plate);
    var txt = el('span', 'hdi-text');
    if (mixed) txt.appendChild(el('span', 'hdi-src', (MODS[t.mod] || { name: '' }).name));
    txt.appendChild(el('span', 'hdi-label', t.label));
    txt.appendChild(el('span', 'hdi-detail', st.ready ? t.detail : st.why));
    b.appendChild(txt);
    b.addEventListener('click', function (e) { e.stopPropagation(); fire(t); });
    return b;
  }

  /* ---------------------------------------------------------------- fire --- */
  function fire(t) {
    if (!t || S.busy) return;
    var st = stateOf(t);
    if (!st.ready) {
      S.note = st.why;
      S.noteOk = false;
      render();
      return;
    }
    S.busy = t.id;
    S.note = t.door === 'ride' ? 'Pressing Ride Along’s key…' : t.label + ' — asking ' + who() + '…';
    S.noteOk = true;
    render();
    var req = t.door === 'ride'
      ? { op: 'ride', formId: subjectId() }
      : { op: 'cast', door: t.door, formId: subjectId() };
    if (t.style) req.style = t.style;
    send(req);
    clearTimeout(S.waitTimer);
    S.waitTimer = setTimeout(function () {
      if (!S.open || !S.busy) return;
      S.busy = '';
      S.note = 'The game did not answer. Try again in a moment.';
      S.noteOk = false;
      render();
    }, 5000);
  }

  /* ------------------------------------------------------------ replies --- */
  function parse(p) {
    if (typeof p !== 'string') return p;
    try { return JSON.parse(p); } catch (e) { return null; }
  }
  function takeState(payload) {
    var d = parse(payload);
    if (!S.open || !d || d.op !== 'state') return;
    S.model = d;
    if (d.name && S.ctx && !S.ctx.who && d.name !== 'They') S.ctx.who = d.name;
    // A corpse of an animal opens on Hunting; a horse on Travel — unless the
    // player picked a category for this open already.
    if (!S.pickedCat && d.subject) {
      if (d.subject.creature && d.subject.dead && catTiles('hunting').length) S.cat = 'hunting';
      else if (d.subject.horse && catTiles('travel').length) S.cat = 'travel';
    }
    render();
  }
  function takeResult(payload) {
    var d = parse(payload);
    if (!S.open || !d) return;
    clearTimeout(S.waitTimer);
    S.busy = '';
    S.note = String(d.msg || '');
    S.noteOk = !!d.ok;
    /* A cast or a ride that was sent has closed the deck already; the
       MutationObserver below closes the popout with it. A refusal stays up
       with its reason on the note line. */
    render();
  }

  /* --------------------------------------------------------- open/close --- */
  function open(anchorEl, c) {
    if (S.open) close(true);
    S.ctx = c || {};
    S.model = null;
    S.q = '';
    S.note = '';
    S.busy = '';
    S.pickedCat = false;
    if (S.ctx.cat) { S.cat = S.ctx.cat; S.pickedCat = true; }
    S.open = true;
    focusBefore = document.activeElement;
    if (window.HDOutfit && HDOutfit.isOpen && HDOutfit.isOpen()) HDOutfit.close();
    if (window.HDQuests && HDQuests.isOpen && HDQuests.isOpen()) HDQuests.close();

    layer = el('div', 'hdi-back');
    layer.id = 'hdi-layer';
    var card = el('section', 'hdi-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'hdi-title');

    var head = el('header', 'hdi-head');
    var face = el('span', 'hdi-face');
    if (S.ctx.portrait) {
      var img = el('img', '');
      img.src = S.ctx.portrait;
      img.alt = '';
      img.addEventListener('error', function () { face.textContent = initials(); });
      face.appendChild(img);
    } else {
      face.textContent = initials();
    }
    var titles = el('div', 'hdi-titles');
    var h = el('h2', 'hdi-title');
    h.id = 'hdi-title';
    h.appendChild(icon('int-interact', 'hdi-title-ic'));
    h.appendChild(el('span', '', 'Interact'));
    titles.appendChild(h);
    whoEl = el('span', 'hdi-who', 'with ' + who());
    titles.appendChild(whoEl);
    search = el('input', 'hdi-search');
    search.type = 'text';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.placeholder = 'Find an interaction…';
    search.title = 'Type to search every category. Enter does the top one that can go; arrows walk the tiles.';
    search.setAttribute('aria-label', 'Find an interaction');
    search.addEventListener('input', function () { S.q = search.value; render(); });
    var x = el('button', 'hdi-btn hdi-close', 'Close');
    x.type = 'button';
    x.addEventListener('click', function (e) { e.stopPropagation(); close(); });
    head.append(face, titles, search, x);

    var body = el('div', 'hdi-body');
    rail = el('nav', 'hdi-rail');
    rail.setAttribute('aria-label', 'Interaction categories');
    panel = el('div', 'hdi-panel');
    body.append(rail, panel);

    var foot = el('footer', 'hdi-foot');
    noteEl = el('p', 'hdi-note');
    noteEl.setAttribute('role', 'status');
    noteEl.setAttribute('aria-live', 'polite');
    foot.appendChild(noteEl);

    card.append(head, body, foot);
    layer.appendChild(card);
    layer.addEventListener('click', function (e) { if (e.target === layer) close(); });
    document.body.appendChild(layer);
    if (window.HDCss) HDCss.need('interact');
    capture(true);
    render();
    search.focus();
    send({ op: 'state', formId: subjectId() });
  }

  function initials() {
    return String(who()).trim().split(/\s+/).slice(0, 2)
      .map(function (n) { return n.charAt(0); }).join('').toUpperCase() || '?';
  }

  function close(quiet) {
    if (!S.open) return;
    S.open = false;
    clearTimeout(S.waitTimer);
    if (layer) layer.remove();
    layer = search = rail = panel = noteEl = whoEl = null;
    capture(false);
    var cb = S.ctx && S.ctx.onClose;
    S.ctx = null;
    S.model = null;
    if (focusBefore && document.body.contains(focusBefore)) focusBefore.focus();
    focusBefore = null;
    if (!quiet && typeof cb === 'function') { try { cb(); } catch (e) {} }
  }

  /* ---------------------------------------------------------------- keys --- */
  function all(sel) { return layer ? Array.prototype.slice.call(layer.querySelectorAll(sel)) : []; }
  function onKey(e) {
    if (!S.open) return;
    var k = e.key, code = e.keyCode, act = document.activeElement;
    if (k === 'Escape' || code === 27) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (search && search.value) { search.value = ''; S.q = ''; render(); search.focus(); }
      else close();
      return;
    }
    if ((k === 'Enter' || code === 13) && act === search) {
      e.preventDefault(); e.stopImmediatePropagation();
      var t = topReady();
      if (t) fire(t);
      else if (visible().length) fire(visible()[0]);   // says why it can't
      return;
    }
    if (k === 'Tab' || code === 9) {
      var f = all('input,button');
      var i = f.indexOf(act);
      i = (i + (e.shiftKey ? f.length - 1 : 1)) % f.length;
      e.preventDefault(); e.stopImmediatePropagation();
      if (f[i]) f[i].focus();
      return;
    }
    var fwd = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[k] || { 39: 1, 40: 1, 37: -1, 38: -1 }[code];
    if (fwd) {
      var inRail = act && act.dataset && act.dataset.cat;
      // Left from the first tile goes to the rail; Right from the rail goes to the tiles.
      var list = inRail ? all('.hdi-cat') : all('.hdi-tile');
      if (act === search && !(k === 'ArrowDown' || code === 40)) { /* caret moves in the box */ }
      else if (list.length) {
        var j = list.indexOf(act);
        if (inRail && (k === 'ArrowRight' || code === 39)) { var tl = all('.hdi-tile'); if (tl[0]) { e.preventDefault(); e.stopImmediatePropagation(); tl[0].focus(); return; } }
        if (!inRail && j === 0 && (k === 'ArrowLeft' || code === 37)) { var on = layer.querySelector('.hdi-cat.is-on') || all('.hdi-cat')[0]; if (on) { e.preventDefault(); e.stopImmediatePropagation(); on.focus(); return; } }
        j = j < 0 ? 0 : (j + fwd + list.length) % list.length;
        e.preventDefault(); e.stopImmediatePropagation();
        list[j].focus();
        if (inRail) list[j].click();   // the rail follows the focus
        return;
      }
    }
    // Typing anywhere goes to the search box.
    if (act !== search && search && k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && k !== ' ') {
      search.focus();
    }
    // Deck shortcuts and type-to-search must not see keys meant for the popout.
    e.stopPropagation();
    // Window capture: the button's own handler never sees Enter/Space.
    if ((k === 'Enter' || k === ' ' || code === 13 || code === 32) && e.target && e.target.tagName === 'BUTTON') {
      e.preventDefault();
      e.target.click();
    }
  }
  window.addEventListener('keydown', onKey, true);

  // The deck closing (a sent cast/ride, F7, Esc on the deck) takes the popout with it.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (S.open && !document.body.classList.contains('open')) close();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* Omni (Ctrl+F): the popout, and a row per tile that opens it on that
     tile's category, on whoever the deck was opened looking at (no formId:
     C++ uses the crosshair snapshot, and the state reply names them). */
  if (window.HDOmni) {
    HDOmni.register({ id: 'interact', label: 'Interact', index: function () {
      return [{ label: 'Interact', kind: 'action', icon: 'icons/custom/int-interact.png',
        detail: 'Carry, kiss, ride together, cart seats, makeup, body preset, Hunterborn, rename — for the person you are looking at',
        keywords: 'interact interactions carry kiss romance spooning seduce ride along cart wagon cosmetics expression obody hunterborn rename stats kick',
        jump: function () { open(null, {}); } },
        { label: 'Rename', kind: 'action', icon: 'icons/custom/int-rename.png',
          detail: 'Rename the person you are looking at — Follower Organizer for your roster, Jaxonz Renamer for anyone else',
          keywords: 'rename name call retitle nickname label person npc follower',
          jump: function () {
            var b = document.querySelector('#fq-card .fq-btn[aria-label="Rename"], #fd-quick .fq-btn[aria-label="Rename"]');
            if (b) b.click(); else rename({ who: 'them' });
          } }].concat(TILES.filter(function (t) { return t.id !== 'rename'; }).map(function (t) {
        var m = MODS[t.mod] || { name: '' };
        return { label: t.label, kind: 'action', icon: 'icons/custom/' + t.icon + '.png',
          detail: t.detail + ' — ' + m.name + ', opens Interact on the person you are looking at',
          keywords: t.keywords + ' interact ' + m.name, jump: function () { open(null, { cat: t.cat }); } };
      }));
    } });
  }

  /* ================================================================ RENAME ===
     The F7 card's Rename button (Rober, 2026-10-14: "rename would be a good
     searchable as well as button on f7"). Its own small centred popout:
       · in your Follower Organizer roster -> a name field, saved through FO's
         renameMember (the deck's one rename verb: FO applies it in the game
         too; blank restores the original) — ctx.onSave does the send;
       · anyone else -> Jaxonz Renamer's own name box (the "rename" door: the
         deck closes and presses its key), or the reason it can't.
     ctx: { who, portrait, hex, member:{ name, override, original } | null,
            onSave(name), onClose } */
  var R = { open: false, ctx: null, layer: null, input: null, btn: null, note: null };

  function renameClose(quiet) {
    if (!R.open) return;
    R.open = false;
    if (R.layer) R.layer.remove();
    capture(false);
    var cb = R.ctx && R.ctx.onClose;
    R.ctx = null; R.layer = R.input = R.btn = R.note = null;
    if (!quiet && typeof cb === 'function') { try { cb(); } catch (e) {} }
  }

  function renameSave() {
    if (!R.open || !R.ctx) return;
    var v = R.input ? R.input.value.replace(/\s+/g, ' ').trim() : '';
    if (typeof R.ctx.onSave === 'function') R.ctx.onSave(v);
    var m = R.ctx.member || {};
    var shown = v || m.original || m.name || 'their original name';
    var who = R.ctx.who;
    renameClose();
    if (typeof window.toast === 'function') window.toast(v ? who + ' is now ' + shown : who + ' has their original name back');
  }

  function renameJaxonz() {
    if (!R.open || !R.btn || R.btn.getAttribute('aria-disabled') === 'true') {
      if (R.note && R.btn) R.note.textContent = R.btn.title;
      return;
    }
    // Same door as the Interact tile: C++ refuses (wrong person, no key) or
    // closes the deck and presses Jaxonz Renamer's key.
    send({ op: 'cast', door: 'rename', formId: R.ctx.hex || '' });
    R.note.textContent = 'Opening Jaxonz Renamer…';
  }

  function rename(ctx) {
    if (R.open) renameClose(true);
    if (S.open) close(true);
    R.ctx = ctx || {};
    R.open = true;
    var m = R.ctx.member;
    var who = R.ctx.who || 'them';

    var layer = el('div', 'hdi-back');
    layer.id = 'hdi-rename';
    var card = el('section', 'hdi-card hdi-card-sm');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'hdi-rn-title');

    var head = el('header', 'hdi-head');
    var face = el('span', 'hdi-face');
    if (R.ctx.portrait) { var img = el('img', ''); img.src = R.ctx.portrait; img.alt = ''; face.appendChild(img); }
    else face.textContent = String(who).trim().charAt(0).toUpperCase() || '?';
    var titles = el('div', 'hdi-titles');
    var h = el('h2', 'hdi-title');
    h.id = 'hdi-rn-title';
    h.appendChild(icon('int-rename', 'hdi-title-ic'));
    h.appendChild(el('span', '', 'Rename'));
    titles.appendChild(h);
    titles.appendChild(el('span', 'hdi-who', who));
    var x = el('button', 'hdi-btn hdi-close', 'Close');
    x.type = 'button';
    x.addEventListener('click', function (e) { e.stopPropagation(); renameClose(); });
    head.append(face, titles, x);

    var body = el('div', 'hdi-rn-body');
    R.note = el('p', 'hdi-note');
    R.note.setAttribute('role', 'status');
    var foot = el('footer', 'hdi-rn-foot');

    if (m) {
      var lab = el('label', 'hdi-rn-label', 'New name');
      R.input = el('input', 'hdi-search hdi-rn-input');
      R.input.type = 'text';
      R.input.autocomplete = 'off';
      R.input.spellcheck = false;
      R.input.maxLength = 64;
      R.input.value = m.override || m.name || '';
      R.input.placeholder = m.original || m.name || who;
      R.input.setAttribute('aria-label', 'New name for ' + who);
      lab.appendChild(R.input);
      body.appendChild(lab);
      body.appendChild(el('p', 'hdi-rn-help', 'Saved through Follower Organizer — it renames them in the game too. '
        + 'Leave it empty to give them back “' + (m.original || m.name || who) + '”.'));
      if (m.original && m.override && m.override !== m.original) {
        var back = el('button', 'hdi-btn', 'Restore “' + m.original + '”');
        back.type = 'button';
        back.addEventListener('click', function (e) { e.stopPropagation(); R.input.value = ''; renameSave(); });
        foot.appendChild(back);
      }
      var save = el('button', 'hdi-btn hdi-primary', 'Save name');
      save.type = 'button';
      save.addEventListener('click', function (e) { e.stopPropagation(); renameSave(); });
      foot.appendChild(save);
    } else {
      body.appendChild(el('p', 'hdi-rn-help', who + ' isn’t in your Follower Organizer roster. Jaxonz Renamer can '
        + 'rename anyone: the deck closes and its own name box opens for them.'));
      R.btn = el('button', 'hdi-btn hdi-primary', 'Rename with Jaxonz Renamer');
      R.btn.type = 'button';
      R.btn.setAttribute('aria-disabled', 'true');
      R.btn.title = 'Checking Jaxonz Renamer…';
      R.btn.addEventListener('click', function (e) { e.stopPropagation(); renameJaxonz(); });
      foot.appendChild(R.btn);
      // Ask the same state the Interact popout uses; only the rename door matters here.
      S.renameAsk = true;
      send({ op: 'state', formId: R.ctx.hex || '' });
    }
    body.appendChild(R.note);
    card.append(head, body, foot);
    layer.appendChild(card);
    layer.addEventListener('click', function (e) { if (e.target === layer) renameClose(); });
    document.body.appendChild(layer);
    R.layer = layer;
    if (window.HDCss) HDCss.need('interact');
    capture(true);
    if (R.input) { R.input.focus(); R.input.select(); }
    else if (R.btn) R.btn.focus();
  }

  function renameState(d) {
    if (!R.open || !R.btn || !d) return;
    var door = (d.doors || []).find(function (x) { return x.id === 'rename'; });
    if (!door || !door.installed) {
      R.btn.title = 'Jaxonz Renamer isn’t installed. Add ' + R.ctx.who + ' to Follower Organizer to rename them here.';
    } else if (!door.ready) {
      R.btn.title = door.why || 'Jaxonz Renamer can’t rename them right now';
    } else {
      R.btn.setAttribute('aria-disabled', 'false');
      R.btn.title = 'Close the deck and open Jaxonz Renamer’s name box for ' + R.ctx.who;
      return;
    }
    R.note.textContent = R.btn.title;
  }

  function renameKey(e) {
    if (!R.open) return;
    var k = e.key, code = e.keyCode;
    if (k === 'Escape' || code === 27) { e.preventDefault(); e.stopImmediatePropagation(); renameClose(); return; }
    if ((k === 'Enter' || code === 13) && R.input && document.activeElement === R.input) {
      e.preventDefault(); e.stopImmediatePropagation(); renameSave(); return;
    }
    if (k === 'Tab' || code === 9) {
      var f = Array.prototype.slice.call(R.layer.querySelectorAll('input,button'));
      var i = f.indexOf(document.activeElement);
      i = (i + (e.shiftKey ? f.length - 1 : 1)) % f.length;
      e.preventDefault(); e.stopImmediatePropagation();
      if (f[i]) f[i].focus();
      return;
    }
    e.stopPropagation();
    if ((k === 'Enter' || k === ' ' || code === 13 || code === 32) && e.target && e.target.tagName === 'BUTTON') {
      e.preventDefault(); e.target.click();
    }
  }
  window.addEventListener('keydown', renameKey, true);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (R.open && !document.body.classList.contains('open')) renameClose(true);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  window.hdInteractState = function (payload) {
    var d = parse(payload);
    if (R.open && d && d.op === 'state') renameState(d);
    takeState(payload);
  };
  window.hdInteractResult = function (payload) {
    var d = parse(payload);
    if (R.open && d && R.note) R.note.textContent = String(d.msg || '');
    takeResult(payload);
  };

  return {
    open: open,
    close: function () { close(); },
    isOpen: function () { return S.open; },
    tiles: function () { return TILES.slice(); },
    rename: rename,
    renameOpen: function () { return R.open; },
    cats: function () { return CATS.slice(); },
  };
})();
