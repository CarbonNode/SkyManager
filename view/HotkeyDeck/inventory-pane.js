'use strict';

/* ====================================================================== *
 *  Inventory — the full inventory replacement, as a deck tab (iv- prefix).
 *
 *  Rober, 2026-10-10: "a full inventory replacement - focused on high UX /
 *  UI for modern game requirements, with sortability, speed, model
 *  previewing … can show after spells" (it sits on the nav right after the
 *  Spells launcher).
 *
 *  Three columns: a category rail (icon, name, live count), a ledger of
 *  every line you carry (sortable columns, filter-as-you-type, list or grid,
 *  only the rows on screen are ever drawn), and a preview stage — the item's
 *  own model rendered by the game, drag to turn it, its real numbers,
 *  a comparison with what you wear in that slot, its effects and the verbs.
 *
 *  ROWS ARE INSTANCES. The tempered, the enchanted and the stolen copy of
 *  one sword are three lines, as in the vanilla menu (src/inventory_pane.h).
 *  A row is addressed by {id, pl, gk}; gk is the C++ group hash.
 *
 *  Bridge (src/inventory_pane.cpp, main.cpp OnJsIv*):
 *    ivList({})              -> ivListData({gold, carry, prefs, seen, items})
 *    ivDetail({id,pl,gk})    -> ivDetailData({…})
 *    ivAct({op,id,pl,gk,n})  -> ivResult({ok,msg,op}) then a fresh ivListData
 *    ivSave({prefs}|{seen})     (no reply; sidecar inventory.json)
 *  Every reply is response-style (this pane always asks first), so the pane
 *  needs no hd-boot STUB_FNS entry. Art: HDArt (whIcons lane) for frame 0;
 *  the 3D turn rides the lightbox's inspector (hdInspect -> hdInspectData,
 *  heard here through the 'hd-inspect-data' document event).
 *
 *  Room (Rober, 2026-10-11: "drag out the columns in middle? hide chevron
 *  on left or right menus for more room?"): the four number columns resize
 *  from grips on their header edges (drag, double-click resets, arrow keys
 *  nudge; prefs.cols), and the ‹ › at the ends of the bar fold the rail to
 *  its icons and put the preview away ([ and ] do the same; prefs.rail,
 *  prefs.side). A put-away preview asks the game for no renders.
 *  The preview zooms ("make this zoomable too with mouse?"): the wheel zooms
 *  toward the pointer (1×–3×; frames are 1024 px), Shift+wheel turns, a
 *  right-drag pans, a double-click fits it back, + - 0 from the keyboard.
 *  Zoom resizes the <img>'s LAYOUT box, never a transform: Ultralight
 *  rasterises an image at its layout size, so a scaled one only magnifies
 *  that raster.
 *
 *  Host contract (mirrors WeatherPane): init() · onShow() · onHide() · onKey(e)
 *  Marker: window.InventoryPane = (inventory-pane module)
 * ====================================================================== */

window.InventoryPane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const ROW_H = 72;             // list row height — a fixed height is what makes virtual scrolling exact
  const TILE_W = 216, TILE_H = 268;   // must match .iv-grid grid-auto-rows
  const OVERSCAN = 6;           // rows drawn beyond the viewport, each side

  const CAT_ICON = {
    all: 'icons/custom/inv-bag.png', fav: 'icons/custom/inv-favorite.png',
    weapon: 'icons/custom/inv-weapons.png', armor: 'icons/custom/hm-transmog.png',
    shield: 'icons/custom/hm-transmog.png', clothing: 'icons/custom/hm-wardrobe.png',
    jewelry: 'icons/custom/inv-jewelry.png', potion: 'icons/custom/hk-potion-health.png',
    poison: 'icons/custom/hk-potion-poison.png', food: 'icons/custom/hk-potion-food.png',
    ingredient: 'icons/custom/inv-ingredients.png', scroll: 'icons/custom/inv-scrolls.png',
    book: 'icons/custom/hk-read-books.png', tome: 'icons/custom/hk-read-books.png',
    soulgem: 'icons/custom/bx-soul.png', key: 'icons/custom/hm-keys.png',
    ammo: 'icons/custom/hk-quiver-arrows.png', light: 'icons/custom/inv-misc.png',
    misc: 'icons/custom/inv-misc.png',
  };
  /* The rail. `of` = the row categories a rail entry holds. Order is the
     vanilla menu's, with jewelry and clothing pulled out of Apparel. */
  const RAIL = [
    { id: 'all', label: 'All', of: null },
    { id: 'fav', label: 'Favorites', of: null },
    { id: 'weapon', label: 'Weapons', of: ['weapon'] },
    { id: 'armor', label: 'Armor', of: ['armor', 'shield'] },
    { id: 'clothing', label: 'Clothing', of: ['clothing'] },
    { id: 'jewelry', label: 'Jewelry', of: ['jewelry'] },
    { id: 'potion', label: 'Potions', of: ['potion'] },
    { id: 'poison', label: 'Poisons', of: ['poison'] },
    { id: 'food', label: 'Food & drink', of: ['food'] },
    { id: 'ingredient', label: 'Ingredients', of: ['ingredient'] },
    { id: 'scroll', label: 'Scrolls', of: ['scroll'] },
    { id: 'book', label: 'Books', of: ['book', 'tome'] },
    { id: 'soulgem', label: 'Soul gems', of: ['soulgem'] },
    { id: 'ammo', label: 'Ammo', of: ['ammo'] },
    { id: 'key', label: 'Keys', of: ['key'] },
    { id: 'misc', label: 'Misc', of: ['misc', 'light'] },
  ];
  const CAT_NAME = {
    weapon: 'Weapon', armor: 'Armor', shield: 'Shield', clothing: 'Clothing', jewelry: 'Jewelry',
    potion: 'Potion', poison: 'Poison', food: 'Food', ingredient: 'Ingredient', scroll: 'Scroll',
    book: 'Book', tome: 'Spell tome', soulgem: 'Soul gem', key: 'Key', ammo: 'Ammo',
    light: 'Torch', misc: 'Misc',
  };
  /* Sub-filters per rail entry: two independent groups may apply (armor:
     weight class AND slot). Each chip is a predicate over a row. */
  const SUBS = {
    weapon: [[
      { id: 'one', label: 'One-handed', fn: (r) => [1, 2, 3, 4].indexOf(r.wt) !== -1 },
      { id: 'two', label: 'Two-handed', fn: (r) => r.wt === 5 || r.wt === 6 },
      { id: 'bow', label: 'Bows', fn: (r) => r.wt === 7 || r.wt === 9 },
      { id: 'staff', label: 'Staffs', fn: (r) => r.wt === 8 },
    ]],
    armor: [[
      { id: 'heavy', label: 'Heavy', fn: (r) => /^Heavy/.test(r.s) },
      { id: 'light', label: 'Light', fn: (r) => /^Light/.test(r.s) },
      { id: 'shield', label: 'Shields', fn: (r) => r.c === 'shield' },
    ], [
      { id: 'head', label: 'Head', fn: (r) => / (Head|Circlet)$/.test(r.s) },
      { id: 'body', label: 'Body', fn: (r) => / Body$/.test(r.s) },
      { id: 'hands', label: 'Hands', fn: (r) => / Hands$/.test(r.s) },
      { id: 'feet', label: 'Feet', fn: (r) => / Feet$/.test(r.s) },
    ]],
    book: [[
      { id: 'unread', label: 'Unread', fn: (r) => !r.rd && r.c !== 'tome' },
      { id: 'tome', label: 'Spell tomes', fn: (r) => r.c === 'tome' },
      { id: 'skill', label: 'Skill books', fn: (r) => r.tb === 'skill' },
    ]],
    soulgem: [[
      { id: 'full', label: 'Filled', fn: (r) => r.soul > 0 },
      { id: 'empty', label: 'Empty', fn: (r) => !r.soul },
    ]],
  };
  /* Sortable columns. `dir` is the first-click direction. */
  const COLS = [
    { id: 'name', label: 'Name', dir: 1 },
    { id: 'pow', label: 'Rating', dir: -1, title: 'Damage for weapons and ammo, armor rating for things you wear — the numbers the game uses, perks and smithing included' },
    { id: 'w', label: 'Weight', dir: -1 },
    { id: 'v', label: 'Value', dir: -1 },
    { id: 'vw', label: 'Value / wt', dir: -1, title: 'Gold per unit of weight — what to keep when you are over-encumbered' },
  ];
  const FLAGS = [
    { id: 'wornFirst', label: 'Worn first', title: 'Keep what you have on at the top of every sort', pref: true },
    { id: 'eq', label: 'Equipped', title: 'Only what you have on' },
    { id: 'nw', label: 'New', title: 'Only what you picked up since you last looked' },
    { id: 'st', label: 'Stolen', title: 'Only stolen goods' },
  ];
  const SOUL = ['Empty', 'Petty', 'Lesser', 'Common', 'Greater', 'Grand'];
  /* Column resizing: a number column is never narrower than its numbers, never
     a lane; Name never drops below a readable line. Layout px (the deck's
     --ui-scale transform is divided out of pointer travel). */
  const COL_MIN = 64, COL_MAX = 360, NAME_MIN = 180, NUDGE = 8;
  const NUM_COLS = ['pow', 'w', 'v', 'vw'];
  const ZOOM_MAX = 3, ZOOM_STEP = 1.2;

  /* ------------------------------------------------------------ state -- */
  let items = [];               // every row C++ sent, decorated
  let view = [];                // filtered + sorted
  const byKey = Object.create(null);
  let sel = '';                 // selected row key
  let reselect = null;          // {base, name} after an act whose row may re-key
  let q = '';
  let cat = 'all';
  let subOn = Object.create(null);   // chip id -> true, for the current rail entry
  /* icons: 'art' (the game's own model renders) | 'game' (the SkyUI / I4 glyphs
     you see in the vanilla menu). stage: 'item' (the piece) | 'you' (the
     player figure, the person page's Mirror). Both persist in the sidecar. */
  let prefs = { sort: 'name', dir: 1, mode: 'list', wornFirst: true, icons: 'art', stage: 'item', rail: 'full', side: 'open', cols: {} };
  let gameIconsReady = null;    // C++: has the rig export run? (null = not told yet)
  let gameIconInfo = '';
  let armorTotal = null;
  const flags = { eq: false, nw: false, st: false };
  let seen = null;              // base key -> 1 (null until the first list lands)
  let seenFirst = false;        // the sidecar had no seen-set: nothing is "new" on a first run
  let gold = 0, carry = { cur: 0, max: 0 };
  let loaded = false, asked = false, wired = false, shown = false;
  const details = Object.create(null);
  let detailT = 0;
  let toastT = 0;
  let paintQueued = false;
  let pop = null;               // the open popout {el, kind, onKey}
  let art = null;               // HDArt group
  let lastClick = { k: '', t: 0 };
  let lastWindow = [];          // the rows the virtual window drew last (what HDArt asks renders for)
  /* the 3D turn for the selected row: {key, reply, angle, polls, timer, drag} */
  let insp = null;
  /* the player figure (On you): {tryKey: '' | row key, reply, angle, polls,
     timer, drag}. Built only when asked — the first build of a figure costs
     the game ~2 s of main thread (mesh load), so it is never automatic. */
  let fig = null;
  let deltaOfKey = Object.create(null);   // row key -> delta vs what you wear (precomputed per list)
  /* a column-grip drag: {id, prev, x, scale, w0, p0, n0, moved, el} */
  let colDrag = null;
  let lastGrip = { id: '', t: 0 };
  let noSortUntil = 0;
  let saveT = 0;
  let unfoldT = 0;
  /* the preview's zoom, for one line in one view: z = magnification, fx/fy =
     the picture's top-left as a fraction of the stage box (<= 0 when zoomed) */
  let zoom = { k: '', z: 1, fx: 0, fy: 0 };
  let pan = null;               // a right-drag pan: {x, y, fx, fy, w, h, scale}
  let lastStageDown = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function keyOf(r) { return (r.id + '|' + r.pl + '|' + r.gk).toLowerCase(); }
  function baseOf(r) { return (r.id + '|' + r.pl).toLowerCase(); }

  /* ------------------------------------------------------------ bridge -- */

  function toGame(fn, arg) {
    const f = window[fn];
    const payload = typeof arg === 'string' ? arg : JSON.stringify(arg || {});
    if (typeof f === 'function') {
      try { f(payload); } catch (e) { console.log('bridge error', fn, e); }
      return;
    }
    if (window.InventoryPaneDev) window.InventoryPaneDev(fn, payload);
    else if (DEV) console.log('[dev->game]', fn, payload);
  }
  function parse(j) {
    if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return null; } }
    return (j && typeof j === 'object') ? j : null;
  }
  function savePrefs() { if (saveT) { clearTimeout(saveT); saveT = 0; } toGame('ivSave', { prefs: prefs }); }
  /* key-repeat nudges coalesce into one sidecar write */
  function saveSoon() { if (saveT) clearTimeout(saveT); saveT = setTimeout(savePrefs, 400); }
  function stageShut() { return prefs.side === 'shut'; }
  function askList() { toGame('ivList', { icons: prefs.icons === 'game' }); }

  /* ---------------------------------------------------------- numbers -- */

  function num(v, digits) {
    if (v == null || !isFinite(v)) return '';
    const d = digits || 0;
    /* thousands by hand: toLocaleString is not something Ultralight has proven */
    const s = Math.abs(v) >= 1000 && d === 0
      ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : v.toFixed(d);
    return d && /\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
  }
  function wtTxt(w) { return w == null ? '' : (Math.round(w * 10) / 10).toFixed(1).replace(/\.0$/, ''); }
  function powOf(r) { return r.dmg != null ? r.dmg : (r.ar != null ? r.ar : null); }
  function powKind(r) { return r.dmg != null ? 'Damage' : (r.ar != null ? 'Armor' : ''); }
  function wearable(r) { return ['armor', 'shield', 'clothing', 'jewelry'].indexOf(r.c) !== -1; }

  /* --------------------------------------------------------- decorate -- */

  function decorate(r) {
    r.k = keyOf(r);
    r.b = baseOf(r);
    r.pow = powOf(r);
    /* armor 0 on a ring or a tunic is not a rating, it is noise */
    if ((r.c === 'clothing' || r.c === 'jewelry') && !r.ar) r.pow = null;
    r.w = Number(r.w) || 0;
    r.v = Number(r.v) || 0;
    r.q = Number(r.q) || 1;
    r.eq = Number(r.eq) || 0;
    r.vw = r.w > 0 ? r.v / r.w : (r.v > 0 ? Infinity : 0);
    r.lc = (r.n + ' ' + (r.s || '') + ' ' + (r.mt || '') + ' ' + (r.gd || '') + ' ' + (CAT_NAME[r.c] || '') + ' ' + (r.pl || '') +
      (r.en ? ' enchanted' : '') + (r.st ? ' stolen' : '') + (r.eq ? ' equipped worn' : '') +
      (r.fav ? ' favorite' : '')).toLowerCase();
    r.nw = !!(seen && !seenFirst && !seen[r.b]);
    return r;
  }

  /* The worn rows that a candidate would replace, for the delta chips. */
  function rivalsOf(r) {
    if (r.eq) return [];
    if (r.c === 'weapon') return items.filter((x) => x.c === 'weapon' && (x.eq === 1 || x.eq === 3));
    if (r.c === 'ammo') return items.filter((x) => x.c === 'ammo' && x.eq);
    if (wearable(r) && r.sl) return items.filter((x) => x.eq && wearable(x) && x.sl && (x.sl & r.sl));
    return [];
  }
  function computeDelta(r) {
    if (r.pow == null) return null;
    const riv = rivalsOf(r);
    if (!riv.length) return null;
    let sum = 0;
    riv.forEach((x) => { sum += x.pow || 0; });
    return r.pow - sum;
  }
  /* Deltas are a function of the whole list (what you wear), so they are
     worked out once per list read, never per painted row: a scroll repaints
     ~30 rows and must not walk the bag 30 times. */
  function precomputeDeltas() {
    deltaOfKey = Object.create(null);
    const worn = items.filter((x) => x.eq);
    if (!worn.length) return;
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      if (r.eq || r.pow == null) continue;
      const d = computeDelta(r);
      if (d != null) deltaOfKey[r.k] = d;
    }
  }
  function deltaOf(r) { return r.k in deltaOfKey ? deltaOfKey[r.k] : null; }

  /* ----------------------------------------------------------- filter -- */

  function inRail(r, id) {
    if (id === 'all') return true;
    if (id === 'fav') return !!r.fav;
    const ent = RAIL.filter((x) => x.id === id)[0];
    return !!(ent && ent.of && ent.of.indexOf(r.c) !== -1);
  }
  /* Materials present in the current kind, most common first — a dynamic
     third chip group for weapons, armor and ammo. */
  function materialChips() {
    if (cat !== 'weapon' && cat !== 'armor' && cat !== 'ammo') return [];
    const n = Object.create(null);
    items.forEach((r) => { if (r.mt && inRail(r, cat)) n[r.mt] = (n[r.mt] || 0) + 1; });
    const list = Object.keys(n).sort((a, b) => n[b] - n[a] || (a < b ? -1 : 1));
    return list.length >= 2 ? list.slice(0, 12).map((m) => ({ id: 'mat:' + m, label: m, fn: (r) => r.mt === m })) : [];
  }
  function chipGroups() {
    const g = (SUBS[cat] || []).slice();
    const m = materialChips();
    if (m.length) g.push(m);
    return g;
  }
  function passesSubs(r) {
    const groups = chipGroups();
    if (!groups.length) return true;
    for (let g = 0; g < groups.length; g++) {
      const on = groups[g].filter((c) => subOn[c.id]);
      if (on.length && !on.some((c) => c.fn(r))) return false;
    }
    return true;
  }
  function passesQuery(r, toks) {
    for (let i = 0; i < toks.length; i++) if (r.lc.indexOf(toks[i]) === -1) return false;
    return true;
  }
  function passesFlags(r) {
    if (flags.eq && !r.eq) return false;
    if (flags.nw && !r.nw) return false;
    if (flags.st && !r.st) return false;
    return true;
  }
  function tokens() { return q.toLowerCase().split(/\s+/).filter(Boolean); }

  function cmp(a, b) {
    if (prefs.wornFirst && !!a.eq !== !!b.eq) return a.eq ? -1 : 1;
    const d = prefs.dir;
    let x, y;
    switch (prefs.sort) {
      case 'pow': x = a.pow == null ? -1 : a.pow; y = b.pow == null ? -1 : b.pow; break;
      case 'w': x = a.w; y = b.w; break;
      case 'v': x = a.v; y = b.v; break;
      case 'vw': x = a.vw; y = b.vw; break;
      default: {
        const an = a.n.toLowerCase(), bn = b.n.toLowerCase();
        if (an !== bn) return an < bn ? -d : d;
        return a.k < b.k ? -1 : 1;
      }
    }
    if (x !== y) return (x < y ? -1 : 1) * d;
    const an = a.n.toLowerCase(), bn = b.n.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : (a.k < b.k ? -1 : 1);
  }

  function rebuild() {
    const toks = tokens();
    view = items.filter((r) => inRail(r, cat) && passesSubs(r) && passesFlags(r) && passesQuery(r, toks));
    view.sort(cmp);
    if (reselect) {
      const hit = view.filter((r) => r.b === reselect.base && r.n === reselect.name)[0] ||
        view.filter((r) => r.b === reselect.base)[0];
      if (hit) sel = hit.k;
      reselect = null;
    }
    if (!byKey[sel] || view.indexOf(byKey[sel]) === -1) sel = view.length ? view[0].k : '';
  }

  /* --------------------------------------------------------- painting -- */

  function selRow() { return byKey[sel] || null; }

  function artSpec(r) { return { kind: 'item', formId: r.id, plugin: r.pl, name: r.n }; }
  function artSrc(r) {
    if (!r || !r.pl || !window.HDArt) return '';
    try { const a = HDArt.for(artSpec(r)); return a && a.state === 'ready' ? a.src : ''; } catch (e) { return ''; }
  }
  /* The SkyUI / I4 glyph: a white PNG baked from the icon SWF, tinted by a CSS
     mask (proven in Ultralight 2026-10-10; filters do not paint there). */
  function gameIconHtml(r) {
    return '<span class="iv-gi" style="background-color:' + esc(r.gc || '#EDE7D9') +
      ';-webkit-mask-image:url(' + esc(r.gi) + ');mask-image:url(' + esc(r.gi) + ')"></span>';
  }
  function thumbHtml(r, cls) {
    if (prefs.icons === 'game' && r.gi)
      return '<div class="' + cls + ' iv-thumb-gi">' + gameIconHtml(r) + '</div>';
    const src = artSrc(r);
    const ic = CAT_ICON[r.c] || CAT_ICON.misc;
    return '<div class="' + cls + (src ? ' iv-has-art' : '') + '">' +
      '<img class="iv-cat-ic" src="' + ic + '" alt="" draggable="false">' +
      (src ? '<img class="iv-art" src="' + esc(src) + '" alt="" draggable="false"' +
        (window.HDArt ? HDArt.errFor('iv-has-art') : '') + '>' : '') +
      '</div>';
  }
  function tagsHtml(r) {
    let t = '';
    if (r.eq) t += '<span class="iv-tag iv-tag-eq">' + (r.eq === 2 ? 'Left hand' : r.eq === 3 ? 'Both hands' : (r.c === 'weapon' || r.c === 'light' || r.c === 'scroll' ? 'In hand' : 'Worn')) + '</span>';
    if (r.nw) t += '<span class="iv-tag iv-tag-nw">New</span>';
    if (r.en) t += '<span class="iv-tag iv-tag-en">Enchanted</span>';
    if (r.po) t += '<span class="iv-tag iv-tag-po">Poisoned</span>';
    if (r.st) t += '<span class="iv-tag iv-tag-st">Stolen</span>';
    if (r.qi) t += '<span class="iv-tag iv-tag-qi">Quest</span>';
    if (r.c === 'book' && !r.rd) t += '<span class="iv-tag iv-tag-nw">Unread</span>';
    if (r.c === 'soulgem' && r.soul != null) t += '<span class="iv-tag">' + (SOUL[r.soul] || '') + ' soul</span>';
    return t;
  }
  function deltaHtml(r, slot) {
    const d = deltaOf(r);
    if (d == null || Math.round(d) === 0) return slot ? '<span class="iv-delta-slot"></span>' : '';
    const up = d > 0;
    const chip = '<span class="iv-delta ' + (up ? 'iv-up' : 'iv-down') + '" title="Compared with what you have on there">' +
      (up ? '+' : '−') + Math.abs(Math.round(d)) + '</span>';
    return slot ? '<span class="iv-delta-slot">' + chip + '</span>' : chip;
  }
  /* "Ebony · Heavy · Body": material first (from the keywords SkyUI reads it
     from), then the kind; an I4 pack's own sub type ("Ore", "Coin") wins over
     our generic "Misc". */
  function subText(r) {
    let sub = r.s || CAT_NAME[r.c] || '';
    if (r.gd && (r.c === 'misc' || r.c === 'ingredient' || r.c === 'food' || r.c === 'potion' || r.c === 'book')) sub = r.gd;
    return (r.mt ? r.mt + ' · ' : '') + sub;
  }
  function vwTxt(r) { return r.vw === Infinity ? '—' : (r.vw > 0 ? num(r.vw, r.vw < 10 ? 1 : 0) : '0'); }

  function rowHtml(r) {
    return '<div class="iv-row' + (r.k === sel ? ' iv-sel' : '') + (r.eq ? ' iv-worn' : '') +
      '" data-k="' + esc(r.k) + '" title="' + esc(r.n) + '">' +
      thumbHtml(r, 'iv-thumb') +
      '<div class="iv-namecell">' +
        '<div class="iv-name">' + (r.fav ? '<img class="iv-star" src="' + CAT_ICON.fav + '" alt="Favorite">' : '') +
          '<span class="iv-name-t">' + esc(r.n) + '</span>' +
          (r.q > 1 ? '<span class="iv-qty">×' + num(r.q) + '</span>' : '') + '</div>' +
        '<div class="iv-meta"><span class="iv-sub">' + esc(subText(r)) + '</span>' + tagsHtml(r) + '</div>' +
      '</div>' +
      /* the delta rides a fixed-width slot so every rating lines up on the
         same right edge, chip or no chip */
      '<div class="iv-num iv-pow"><span class="iv-pow-v">' + (r.pow != null ? num(r.pow) : '<span class="iv-dim">—</span>') + '</span>' + deltaHtml(r, true) + '</div>' +
      '<div class="iv-num">' + wtTxt(r.w) + '</div>' +
      '<div class="iv-num iv-gold">' + num(r.v) + '</div>' +
      '<div class="iv-num">' + vwTxt(r) + '</div>' +
      '</div>';
  }
  function tileHtml(r) {
    const p = r.pow != null ? '<span class="iv-tile-pow" title="' + powKind(r) + '">' + num(r.pow) + deltaHtml(r) + '</span>' : '';
    return '<div class="iv-tile' + (r.k === sel ? ' iv-sel' : '') + (r.eq ? ' iv-worn' : '') + '" data-k="' + esc(r.k) + '" title="' + esc(r.n) + '">' +
      thumbHtml(r, 'iv-tile-art') +
      (r.q > 1 ? '<span class="iv-tile-q">×' + num(r.q) + '</span>' : '') +
      (r.fav ? '<img class="iv-tile-star" src="' + CAT_ICON.fav + '" alt="Favorite">' : '') +
      (r.eq ? '<span class="iv-tile-eq">' + (r.eq === 2 ? 'L' : 'E') + '</span>' : '') +
      '<div class="iv-tile-name">' + esc(r.n) + '</div>' +
      '<div class="iv-tile-stats">' + p + '<span class="iv-tile-wt">' + wtTxt(r.w) + ' wt</span>' +
        '<span class="iv-tile-v">' + num(r.v) + '</span></div>' +
      '</div>';
  }

  function gridCols(list) {
    const w = list.clientWidth || 800;
    return Math.max(1, Math.floor((w - 8) / TILE_W));
  }

  /* The virtual window. Only the rows (or tile rows) the list can show,
     plus OVERSCAN, ever exist in the DOM — a 1,200-line bag draws ~20. */
  function paintWindow() {
    paintQueued = false;
    const list = $('iv-list'), rows = $('iv-rows'), spacer = $('iv-spacer');
    if (!list || !rows || !spacer) return;
    const grid = prefs.mode === 'grid';
    list.classList.toggle('iv-grid', grid);
    const h = list.clientHeight || 600;
    let html = '', top = 0, total = 0;
    if (!grid) {
      total = view.length * ROW_H;
      const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
      const last = Math.min(view.length, Math.ceil((list.scrollTop + h) / ROW_H) + OVERSCAN);
      top = first * ROW_H;
      for (let i = first; i < last; i++) html += rowHtml(view[i]);
      lastWindow = view.slice(first, last);
    } else {
      const cols = gridCols(list);
      const nrows = Math.ceil(view.length / cols);
      total = nrows * TILE_H;
      const firstRow = Math.max(0, Math.floor(list.scrollTop / TILE_H) - 2);
      const lastRow = Math.min(nrows, Math.ceil((list.scrollTop + h) / TILE_H) + 2);
      top = firstRow * TILE_H;
      rows.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
      const from = firstRow * cols, to = Math.min(view.length, lastRow * cols);
      for (let i = from; i < to; i++) html += tileHtml(view[i]);
      lastWindow = view.slice(from, to);
    }
    spacer.style.height = Math.max(total, 1) + 'px';
    rows.style.top = top + 'px';
    if (rows._ivHtml !== html) { rows.innerHTML = html; rows._ivHtml = html; }
    if (window.HDArt) HDArt.arm(rows, 'iv-has-art');
    const empty = $('iv-empty');
    if (empty) {
      empty.classList.toggle('hidden', !!view.length || !loaded);
      if (!view.length && loaded) empty.innerHTML = emptyHtml();
    }
    if (art) art.schedule();
  }
  function queuePaint() {
    if (paintQueued) return;
    paintQueued = true;
    (window.requestAnimationFrame || setTimeout)(paintWindow, 0);
  }

  function emptyHtml() {
    const why = q ? 'Nothing you carry matches “' + esc(q) + '”.' :
      flags.eq ? 'Nothing equipped here.' : flags.nw ? 'Nothing new since you last looked.' :
      flags.st ? 'No stolen goods here — clean hands.' :
      cat === 'fav' ? 'No favorites yet. Press F on anything to star it.' : 'You carry nothing of this kind.';
    return '<img src="' + (CAT_ICON[cat] || CAT_ICON.all) + '" alt="" class="iv-empty-ic">' +
      '<div class="iv-empty-t">' + why + '</div>' +
      ((q || flags.eq || flags.nw || flags.st) ? '<button type="button" class="iv-btn" data-act="clear-all">Clear search and filters</button>' : '');
  }

  function paintRail() {
    const el = $('iv-rail');
    if (!el) return;
    const toks = tokens();
    const counts = Object.create(null);
    items.forEach((r) => {
      if (!passesFlags(r) || !passesQuery(r, toks)) return;
      counts.all = (counts.all || 0) + 1;
      if (r.fav) counts.fav = (counts.fav || 0) + 1;
      for (let i = 2; i < RAIL.length; i++) if (RAIL[i].of.indexOf(r.c) !== -1) { counts[RAIL[i].id] = (counts[RAIL[i].id] || 0) + 1; break; }
    });
    const haveAny = Object.create(null);
    items.forEach((r) => { for (let i = 2; i < RAIL.length; i++) if (RAIL[i].of.indexOf(r.c) !== -1) haveAny[RAIL[i].id] = 1; });
    let html = '';
    RAIL.forEach((c) => {
      /* a kind you carry none of at all is not a destination; a kind the
         SEARCH emptied stays, dimmed, so the rail does not jump around */
      if (c.id !== 'all' && c.id !== 'fav' && !haveAny[c.id]) return;
      const n = counts[c.id] || 0;
      html += '<button type="button" class="iv-cat' + (cat === c.id ? ' iv-on' : '') + (n ? '' : ' iv-zero') +
        '" data-cat="' + c.id + '" title="' + esc(c.label) + ' — ' + num(n) + '">' +
        '<img class="iv-cat-img" src="' + CAT_ICON[c.id] + '" alt="" draggable="false">' +
        '<span class="iv-cat-l">' + esc(c.label) + '</span><span class="iv-cat-n">' + num(n) + '</span></button>';
    });
    if (el._ivHtml !== html) { el.innerHTML = html; el._ivHtml = html; }
  }

  function paintSubs() {
    const el = $('iv-subs');
    if (!el) return;
    const groups = chipGroups();
    let html = '';
    FLAGS.forEach((f) => {
      const on = f.pref ? !!prefs[f.id] : !!flags[f.id];
      html += '<button type="button" class="iv-chip iv-flag' + (on ? ' iv-on' : '') + '" data-flag="' + f.id +
        '" title="' + esc(f.title) + '">' + esc(f.label) + '</button>';
    });
    if (groups.length) {
      groups.forEach((g) => {
        html += '<span class="iv-chip-sep" aria-hidden="true"></span>';
        g.forEach((c) => {
          html += '<button type="button" class="iv-chip' + (subOn[c.id] ? ' iv-on' : '') + '" data-sub="' + c.id + '">' + esc(c.label) + '</button>';
        });
      });
    }
    if (el._ivHtml !== html) { el.innerHTML = html; el._ivHtml = html; }
  }

  function glyph(on) {
    return '<span class="iv-sortglyph' + (on ? '' : ' iv-ghost') + (on && prefs.dir > 0 ? ' iv-asc' : '') + '" aria-hidden="true">▾</span>';
  }
  function paintCols() {
    const el = $('iv-cols');
    if (!el) return;
    let html = '<span class="iv-col iv-col-art" aria-hidden="true"></span>';
    COLS.forEach((c) => {
      const on = prefs.sort === c.id;
      html += '<button type="button" class="iv-col' + (c.id !== 'name' ? ' iv-col-num' : '') + (on ? ' iv-on' : '') +
        '" data-sort="' + c.id + '" title="' + esc(c.title || ('Sort by ' + c.label)) + '">' +
        /* numbers are right-aligned, so their glyph goes on the LEFT of the
           label: the label's right edge then sits on the column's */
        (c.id !== 'name' ? glyph(on) : '') + '<span>' + esc(c.label) + '</span>' + (c.id === 'name' ? glyph(on) : '') + '</button>';
    });
    /* grips are siblings of the header buttons (a focusable thing inside a
       button is not allowed), placed by positionGrips */
    COLS.forEach((c) => {
      if (c.id === 'name') return;
      html += '<span class="iv-grip" data-grip="' + c.id + '" role="separator" aria-orientation="vertical" tabindex="0"' +
        ' aria-label="Resize the ' + esc(c.label) + ' column"' +
        ' title="Drag to resize ' + esc(c.label) + ' · double-click to reset · arrow keys nudge"></span>';
    });
    if (el._ivHtml !== html) { el.innerHTML = html; el._ivHtml = html; }
    const mode = $('iv-mode');
    if (mode) mode.querySelectorAll('button').forEach((b) => b.classList.toggle('iv-on', b.getAttribute('data-mode') === prefs.mode));
    const icons = $('iv-icons');
    if (icons) {
      icons.querySelectorAll('button').forEach((b) => b.classList.toggle('iv-on', b.getAttribute('data-icons') === prefs.icons));
      const gb = icons.querySelector('[data-icons="game"]');
      if (gb) {
        gb.classList.toggle('iv-unready', gameIconsReady === false);
        gb.title = gameIconsReady === false
          ? 'The SkyUI icon pictures have not been exported on this PC yet (scripts/rig/game-icons) — renders are shown meanwhile'
          : ('The same icons your SkyUI inventory shows' + (gameIconInfo ? ' — ' + gameIconInfo : ''));
      }
    }
    el.classList.toggle('hidden', prefs.mode === 'grid');
    positionGrips();
    const sortSel = $('iv-sortbar');
    if (sortSel) sortSel.classList.toggle('hidden', prefs.mode !== 'grid');
    if (sortSel && prefs.mode === 'grid') {
      let s = '<span class="iv-sortbar-l">Sort</span>';
      COLS.forEach((c) => {
        const on = prefs.sort === c.id;
        s += '<button type="button" class="iv-chip' + (on ? ' iv-on' : '') + '" data-sort="' + c.id + '">' + esc(c.label) +
          (on ? ' <span class="iv-sortglyph' + (prefs.dir > 0 ? ' iv-asc' : '') + '">▾</span>' : '') + '</button>';
      });
      if (sortSel._ivHtml !== s) { sortSel.innerHTML = s; sortSel._ivHtml = s; }
    }
  }

  /* ------------------------------------------------- room: fold + resize -- */

  function applyColVars() {
    const pane = $('iv-pane');
    if (!pane) return;
    NUM_COLS.forEach((id) => {
      const v = prefs.cols && prefs.cols[id];
      if (v) pane.style.setProperty('--iv-cw-' + id, v + 'px');
      else pane.style.removeProperty('--iv-cw-' + id);
    });
  }
  /* Each grip is centred on the gap left of its column. Placed from the right
     edge: every column right of Name is a fixed width, so the distance holds
     while the pane (and Name) resizes. A column the narrow layout hides
     (Value / wt under 1500px) hides its grip. */
  function positionGrips() {
    const cols = $('iv-cols');
    if (!cols || cols.classList.contains('hidden')) return;
    const cw = cols.clientWidth;
    if (!cw) return;
    cols.querySelectorAll('.iv-grip').forEach((g) => {
      const id = g.getAttribute('data-grip');
      const b = cols.querySelector('[data-sort="' + id + '"]');
      const gone = !b || b.offsetWidth < 4 || getComputedStyle(b).visibility === 'hidden';
      g.classList.toggle('iv-gone', gone);
      if (gone) return;
      g.style.right = (cw - b.offsetLeft) + 'px';
      g.setAttribute('aria-valuenow', String(b.offsetWidth));
    });
  }
  function colWidth(id) {
    const b = $('iv-cols') && $('iv-cols').querySelector('[data-sort="' + id + '"]');
    return b ? b.offsetWidth : 0;
  }
  /* The column to the left of a grip's column: another number column (the two
     trade width) or Name (null — Name takes the difference). */
  function prevCol(id) {
    const i = COLS.findIndex((c) => c.id === id);
    return i > 1 ? COLS[i - 1].id : null;
  }
  function gripBase(id) {
    const prev = prevCol(id);
    return { id: id, prev: prev, w0: colWidth(id), p0: prev ? colWidth(prev) : 0, n0: colWidth('name') };
  }
  /* Move the boundary left of `id` by dx layout px (right = positive): `id`
     gives what its left neighbour takes. Clamped so neither side leaves
     [COL_MIN, COL_MAX] and Name keeps NAME_MIN. */
  function moveBoundary(b, dx) {
    if (!b.w0) return;
    let lo = b.prev ? COL_MIN - b.p0 : Math.min(0, NAME_MIN - b.n0);
    let hi = b.w0 - COL_MIN;
    lo = Math.max(lo, b.w0 - COL_MAX);
    if (b.prev) hi = Math.min(hi, COL_MAX - b.p0);
    const d = Math.max(lo, Math.min(hi, dx));
    if (!prefs.cols || typeof prefs.cols !== 'object') prefs.cols = {};
    prefs.cols[b.id] = Math.round(b.w0 - d);
    if (b.prev) prefs.cols[b.prev] = Math.round(b.p0 + d);
    applyColVars();
    positionGrips();
  }
  function resetCol(id) {
    if (prefs.cols) delete prefs.cols[id];
    applyColVars();
    positionGrips();
    savePrefs();
  }
  function onGripDown(e) {
    const g = e.target && e.target.closest ? e.target.closest('.iv-grip') : null;
    if (!g || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const id = g.getAttribute('data-grip');
    const now = Date.now();
    /* double-click resets — timed by hand, as the list's double-click is */
    if (lastGrip.id === id && now - lastGrip.t < 380) {
      lastGrip = { id: '', t: 0 };
      resetCol(id);
      return;
    }
    lastGrip = { id: id, t: now };
    const cols = $('iv-cols');
    const scale = (cols.getBoundingClientRect().width / (cols.offsetWidth || 1)) || 1;
    colDrag = Object.assign(gripBase(id), { x: e.clientX, scale: scale, moved: false, el: g });
    g.classList.add('iv-dragging');
    $('iv-pane').classList.add('iv-col-drag');
    try { g.focus(); } catch (err) {}
  }

  function applyLayout() {
    const pane = $('iv-pane');
    if (!pane) return;
    const mini = prefs.rail === 'mini', shut = stageShut();
    pane.classList.toggle('iv-rail-mini', mini);
    pane.classList.toggle('iv-side-shut', shut);
    const fr = $('iv-fold-rail'), fs = $('iv-fold-stage');
    if (fr) {
      fr.innerHTML = mini ? '&#8250;' : '&#8249;';
      fr.classList.toggle('iv-on', mini);
      fr.setAttribute('aria-expanded', mini ? 'false' : 'true');
      fr.setAttribute('aria-label', mini ? 'Show the kinds with their names' : 'Fold the kinds to icons');
      fr.title = (mini ? 'Show the kinds with their names' : 'Fold the kinds to icons for more room') + '  ( [ )';
    }
    if (fs) {
      fs.innerHTML = shut ? '&#8249;' : '&#8250;';
      fs.classList.toggle('iv-on', shut);
      fs.setAttribute('aria-expanded', shut ? 'false' : 'true');
      fs.setAttribute('aria-label', shut ? 'Bring the preview back' : 'Put the preview away');
      fs.title = (shut ? 'Bring the preview back' : 'Put the preview away for more room') + '  ( ] )';
    }
    applyColVars();
  }
  function unfoldAnim(cls) {
    const pane = $('iv-pane');
    if (!pane) return;
    pane.classList.remove('iv-unfold-rail', 'iv-unfold-stage');
    void pane.offsetWidth;
    pane.classList.add(cls);
    if (unfoldT) clearTimeout(unfoldT);
    unfoldT = setTimeout(function () { pane.classList.remove('iv-unfold-rail', 'iv-unfold-stage'); }, 320);
  }
  function relayout() {
    positionGrips();
    queuePaint();   // the grid's tile count follows the ledger's width
  }
  function foldRail() {
    prefs.rail = prefs.rail === 'mini' ? 'full' : 'mini';
    savePrefs();
    applyLayout();
    if (prefs.rail === 'full') unfoldAnim('iv-unfold-rail');
    relayout();
  }
  function foldStage() {
    prefs.side = stageShut() ? 'open' : 'shut';
    savePrefs();
    if (stageShut()) {
      /* nobody is looking: no turntable or figure renders queued for it */
      inspStop();
      stopFigPoll();
    }
    applyLayout();
    if (!stageShut()) {
      paintStage();
      if (prefs.stage === 'you' && shown) { if (fig) { fig.polls = 0; figAsk(); } else startFig(''); }
      unfoldAnim('iv-unfold-stage');
    }
    relayout();
  }

  function paintHead() {
    const g = $('iv-gold');
    if (g) g.textContent = num(gold);
    const ar = $('iv-armor');
    if (ar) ar.textContent = armorTotal == null ? '—' : num(armorTotal);
    const cw = $('iv-carry-t'), bar = $('iv-carry-fill'), box = $('iv-carry');
    if (cw) cw.textContent = wtTxt(carry.cur) + ' / ' + wtTxt(carry.max);
    const pct = carry.max > 0 ? Math.min(1, carry.cur / carry.max) : 0;
    if (bar) bar.style.width = Math.round(pct * 100) + '%';
    if (box) {
      box.classList.toggle('iv-over', carry.max > 0 && carry.cur > carry.max);
      box.classList.toggle('iv-near', carry.max > 0 && carry.cur <= carry.max && pct >= 0.9);
      box.title = carry.max > 0 && carry.cur > carry.max
        ? 'Over-encumbered by ' + wtTxt(carry.cur - carry.max) + ' — you cannot run or fast travel'
        : 'Carry weight — ' + wtTxt(Math.max(0, carry.max - carry.cur)) + ' to spare';
    }
    const sub = $('iv-sub');
    if (sub) {
      if (!loaded) sub.textContent = 'Reading your pack…';
      else {
        let kinds = 0, total = 0, newN = 0;
        items.forEach((r) => { kinds++; total += r.q; if (r.nw) newN++; });
        sub.innerHTML = '<b>' + num(total) + '</b> things in <b>' + num(kinds) + '</b> lines' +
          (newN ? ' · <span class="iv-sub-new">' + newN + ' new</span>' : '');
      }
    }
  }

  function paintFoot() {
    const el = $('iv-foot');
    if (!el) return;
    let wt = 0, val = 0;
    view.forEach((r) => { wt += r.w * r.q; val += r.v * r.q; });
    el.innerHTML = '<span class="iv-foot-n">' + num(view.length) + (view.length === items.length ? '' : ' of ' + num(items.length)) +
      ' shown</span><span>' + wtTxt(wt) + ' weight</span><span class="iv-gold">' + num(val) + ' gold worth</span>' +
      '<span class="iv-keys"><kbd>Enter</kbd> use · <kbd>Shift+Enter</kbd> left hand · <kbd>F</kbd> favorite · <kbd>Del</kbd> drop · <kbd>R</kbd> read</span>';
  }

  /* ------------------------------------------------------------ stage -- */

  function actionsFor(r) {
    const a = [];
    const one = r.c === 'weapon' && [1, 2, 3, 4].indexOf(r.wt) !== -1;
    switch (r.c) {
      case 'weapon': a.push({ op: 'use', label: r.eq ? 'Put away' : 'Equip', primary: true });
        if (one || r.eq === 2) a.push({ op: 'left', label: r.eq === 2 ? 'Put away (left)' : 'Left hand' }); break;
      case 'armor': case 'shield': case 'clothing': case 'jewelry':
        a.push({ op: 'use', label: r.eq ? 'Take off' : 'Wear', primary: true }); break;
      case 'ammo': a.push({ op: 'use', label: r.eq ? 'Unequip' : 'Equip', primary: true }); break;
      case 'light': a.push({ op: 'use', label: r.eq ? 'Put out' : 'Light it', primary: true }); a.push({ op: 'left', label: 'Left hand' }); break;
      case 'potion': a.push({ op: 'use', label: 'Drink', primary: true }); break;
      case 'food': a.push({ op: 'use', label: 'Eat', primary: true }); break;
      case 'ingredient': a.push({ op: 'use', label: 'Eat', primary: true }); break;
      case 'poison': a.push({ op: 'use', label: 'Coat weapon', primary: true }); break;
      case 'scroll': a.push({ op: 'use', label: 'Ready', primary: true }); a.push({ op: 'left', label: 'Left hand' }); break;
      case 'tome': a.push({ op: 'read', label: 'Learn', primary: true }); break;
      case 'book': a.push({ op: 'text', label: 'Open book', primary: true }); a.push({ op: 'read', label: r.tb === 'skill' && !r.rd ? 'Study' : 'Mark read' }); break;
      default: break;
    }
    a.push({ op: 'fav', label: r.fav ? 'Unfavorite' : 'Favorite', icon: CAT_ICON.fav });
    a.push({ op: 'drop', label: r.q > 1 ? 'Drop…' : 'Drop', danger: true, off: r.qi ? 'A quest item stays with you' : '' });
    return a;
  }

  function statCells(r, d) {
    const cells = [];
    const delta = deltaOf(r);
    if (r.dmg != null) cells.push({ l: r.c === 'ammo' ? 'Damage' : 'Damage', v: num(r.dmg), d: delta });
    if (r.ar != null && r.pow != null) cells.push({ l: 'Armor', v: num(r.ar), d: delta });
    cells.push({ l: 'Weight', v: wtTxt(r.w) });
    cells.push({ l: 'Value', v: num(r.v), gold: true });
    if (r.pow == null) cells.push({ l: 'Value / wt', v: vwTxt(r) });
    if (d && d.base && d.base.speed != null) cells.push({ l: 'Speed', v: num(d.base.speed, 2) });
    if (d && d.charge != null) cells.push({ l: 'Charge', v: num(d.charge) });
    if (r.q > 1) cells.push({ l: 'Carrying', v: num(r.q) });
    return cells;
  }

  function compareHtml(r) {
    const riv = rivalsOf(r);
    if (!riv.length || r.pow == null) return '';
    let sp = 0, sw = 0, sv = 0;
    riv.forEach((x) => { sp += x.pow || 0; sw += x.w; sv += x.v; });
    const part = function (label, dv, digits, invert) {
      if (Math.abs(dv) < (digits ? 0.05 : 0.5)) return '<span class="iv-cmp-p">' + label + ' <b>same</b></span>';
      const good = invert ? dv < 0 : dv > 0;
      return '<span class="iv-cmp-p">' + label + ' <b class="' + (good ? 'iv-up' : 'iv-down') + '">' +
        (dv > 0 ? '+' : '−') + (digits ? wtTxt(Math.abs(dv)) : num(Math.abs(Math.round(dv)))) + '</b></span>';
    };
    return '<div class="iv-cmp"><div class="iv-cmp-h">Against what you have on — <span>' +
      esc(riv.map((x) => x.n).join(', ')) + '</span></div><div class="iv-cmp-row">' +
      part(powKind(r), r.pow - sp, 0) + part('Weight', r.w - sw, 1, true) + part('Value', r.v - sv, 0) +
      '</div></div>';
  }

  function paintStage() {
    const el = $('iv-stage');
    if (!el || stageShut()) return;
    const r = selRow();
    if (!r) {
      el.innerHTML = '<div class="iv-stage-empty"><img src="' + CAT_ICON.all + '" alt="" class="iv-stage-empty-ic">' +
        '<div class="iv-stage-empty-t">' + (loaded ? 'Pick something to look at it' : 'Reading your pack…') + '</div></div>';
      return;
    }
    const d = details[r.k];
    const you = prefs.stage === 'you';
    const src = stageSrc(r);
    const turnable = you || !!(r.pl && window.HDLightbox);
    const ph = you ? 'icons/custom/hm-sheet.png' : (CAT_ICON[r.c] || CAT_ICON.misc);
    const tryable = wearable(r) || r.c === 'shield';
    let s = '<div class="iv-stage-top">' +
        '<div class="iv-seg iv-stage-seg" role="group" aria-label="Preview">' +
          '<button type="button" data-view="item"' + (you ? '' : ' class="iv-on"') + '>Item</button>' +
          '<button type="button" data-view="you"' + (you ? ' class="iv-on"' : '') + '>On you</button>' +
        '</div>' +
        (you && tryable && !r.eq
          ? '<button type="button" class="iv-btn iv-try' + (fig && fig.tryKey === r.k ? ' iv-on' : '') + '" data-act="try">' +
            (fig && fig.tryKey === r.k ? 'Trying it on' : 'Try it on') + '</button>'
          : (you && fig && fig.tryKey ? '<button type="button" class="iv-btn iv-try" data-act="untry">Back to what you wear</button>' : '')) +
      '</div>';
    s += '<div class="iv-stage-art' + (src ? ' iv-has-art' : '') + (turnable ? ' iv-turnable' : '') + (you ? ' iv-fig' : '') + '" id="iv-stage-art">' +
      '<img class="iv-cat-ic" src="' + ph + '" alt="" draggable="false">' +
      (src ? '<img class="iv-art" src="' + esc(src) + '" alt="' + esc(you ? 'You' : r.n) + '" draggable="false"' +
        (window.HDArt ? HDArt.errFor('iv-has-art') : '') + '>' : '') +
      (turnable ? '<div class="iv-turn-hint" id="iv-turn-hint">' + hintFor(r) + '</div>' : '') +
      (you ? '<div class="iv-fig-cap" id="iv-fig-cap">' + figCaption() + '</div>' : '') +
      '</div>';
    s += '<div class="iv-st-head"><div class="iv-st-name">' + esc(r.n) + '</div>' +
      '<div class="iv-st-sub">' + esc(subText(r)) + (d && d.plugin ? ' · <span class="iv-st-pl">' + esc(d.plugin) + '</span>' : '') + '</div>' +
      '<div class="iv-st-tags">' + tagsHtml(r) + '</div></div>';
    const cells = statCells(r, d);
    s += '<div class="iv-st-stats" style="grid-template-columns: repeat(' + Math.min(cells.length, 4) + ', minmax(0,1fr))">';
    /* congruent: the last cell spans whatever the final row has left, so
       the grid never ends on an empty slot */
    const cols = Math.min(cells.length, 4), rem = cells.length % cols;
    cells.forEach((c, i) => {
      const span = (rem && i === cells.length - 1) ? ' style="grid-column: span ' + (cols - rem + 1) + '"' : '';
      s += '<div class="iv-st-cell"' + span + '><div class="iv-st-l">' + c.l + '</div><div class="iv-st-v' + (c.gold ? ' iv-gold' : '') + '">' + c.v +
        (c.d != null && Math.round(c.d) !== 0 ? '<span class="iv-delta ' + (c.d > 0 ? 'iv-up' : 'iv-down') + '">' + (c.d > 0 ? '+' : '−') + Math.abs(Math.round(c.d)) + '</span>' : '') +
        '</div></div>';
    });
    s += '</div>';
    s += compareHtml(r);
    s += '<div class="iv-st-body">';
    if (!d) s += '<div class="iv-st-loading">Reading the item card…</div>';
    else {
      if (d.ench) s += '<div class="iv-st-sec-h">' + esc(d.ench) + '</div>';
      if (Array.isArray(d.effects) && d.effects.length) {
        if (!d.ench) s += '<div class="iv-st-sec-h">Effects</div>';
        s += '<ul class="iv-fx">';
        d.effects.forEach((e) => {
          s += '<li class="' + (e.unk ? 'iv-fx-unk' : '') + '"><span class="iv-fx-n">' + esc(e.n || 'Effect') + '</span>' +
            (e.d ? '<span class="iv-fx-d">' + esc(e.d) + '</span>' : '') + '</li>';
        });
        s += '</ul>';
      }
      if (d.teaches) {
        const t = d.teaches;
        s += '<div class="iv-st-note">' + (t.kind === 'spell'
          ? 'Teaches the spell <b>' + esc(t.name) + '</b>' + (t.known ? ' — you already know it' : '')
          : 'Raises <b>' + esc(t.name) + '</b> when first read' + (t.read ? ' — already read' : '')) + '</div>';
      }
      if (d.soul) s += '<div class="iv-st-note">Holds a <b>' + esc(d.soul.have) + '</b> soul' + (d.soul.cap ? ' · fits up to ' + esc(d.soul.cap) : '') + '</div>';
      if (d.desc) s += '<div class="iv-st-desc">' + esc(d.desc) + '</div>';
      if (d.stolen) s += '<div class="iv-st-note iv-st-warn">Stolen — a fence or a guard will notice.</div>';
      if (d.quest) s += '<div class="iv-st-note">A quest needs this. It cannot be dropped.</div>';
      if (Array.isArray(d.facts) && d.facts.length) {
        s += '<div class="iv-st-sec-h iv-st-sec-facts">Details</div><dl class="iv-facts">';
        d.facts.forEach((f) => {
          s += '<div class="iv-fact"><dt>' + esc(f.l) + '</dt><dd' + (f.t ? ' class="iv-fact-' + esc(f.t) + '"' : '') + '>' + esc(f.v) + '</dd></div>';
        });
        s += '</dl>';
      }
      if (you) s += '<div class="iv-st-note iv-st-figure-note">The figure is built from your worn gear, body and head parts. RaceMenu face sliders are not part of it.</div>';
    }
    s += '</div>';
    s += '<div class="iv-st-acts">';
    actionsFor(r).forEach((a) => {
      s += '<button type="button" class="iv-btn' + (a.primary ? ' iv-btn-primary' : '') + (a.danger ? ' iv-btn-danger' : '') + '"' +
        ' data-op="' + a.op + '"' + (a.off ? ' disabled title="' + esc(a.off) + '"' : '') + '>' +
        (a.icon ? '<img class="iv-btn-ic" src="' + a.icon + '" alt="">' : '') + esc(a.label) + '</button>';
    });
    s += '</div>';
    el.innerHTML = s;
    /* a repaint (the card's facts landing) keeps the zoom; a new line or
       view starts fitted */
    if (zoom.k !== zoomKey()) zoomReset();
    applyZoom();
    if (window.HDArt) HDArt.arm(el, 'iv-has-art');
    wireStageArt();
  }

  function askDetail(r) {
    if (!r || details[r.k]) return;
    if (detailT) clearTimeout(detailT);
    detailT = setTimeout(function () {
      detailT = 0;
      const cur = selRow();
      if (cur && !details[cur.k]) toGame('ivDetail', { id: cur.id, pl: cur.pl, gk: cur.gk });
    }, 110);
  }

  /* --------------------------------------------------------- 3D turn -- */

  function inspAngles() {
    const f = insp && insp.reply && insp.reply.frames;
    if (!f) return [];
    return Object.keys(f).map(Number).filter((n) => isFinite(n)).sort((a, b) => a - b);
  }
  function inspFrame(r) {
    if (!insp || insp.key !== r.k || !insp.reply || !insp.reply.frames) return '';
    const angles = inspAngles();
    if (!angles.length) return '';
    let best = angles[0], bd = 999;
    angles.forEach((a) => {
      const dd = Math.min(Math.abs(a - insp.angle), 360 - Math.abs(a - insp.angle));
      if (dd < bd) { bd = dd; best = a; }
    });
    return window.HDArt ? HDArt.path(insp.reply.frames[String(best)]) : insp.reply.frames[String(best)];
  }
  /* ------------------------------------------------------------ zoom -- */

  function zoomKey() { return sel + '|' + prefs.stage; }
  function zoomReset() { zoom = { k: zoomKey(), z: 1, fx: 0, fy: 0 }; }
  function applyZoom() {
    const box = $('iv-stage-art');
    const img = box && box.querySelector('img.iv-art');
    if (!box) return;
    const on = zoom.z > 1.001;
    box.classList.toggle('iv-zoomed', on);
    if (!img) return;
    img.style.width = on ? (zoom.z * 100) + '%' : '';
    img.style.height = on ? (zoom.z * 100) + '%' : '';
    img.style.left = on ? (zoom.fx * 100) + '%' : '';
    img.style.top = on ? (zoom.fy * 100) + '%' : '';
  }
  function clampZoom() {
    zoom.fx = Math.min(0, Math.max(1 - zoom.z, zoom.fx));
    zoom.fy = Math.min(0, Math.max(1 - zoom.z, zoom.fy));
  }
  /* Zoom to z2 keeping the picture point under (mx, my) — box layout px —
     where it is. */
  function zoomAt(mx, my, z2) {
    const box = $('iv-stage-art');
    if (!box) return;
    const W = box.clientWidth || 1, H = box.clientHeight || 1;
    if (zoom.k !== zoomKey()) zoomReset();
    z2 = Math.max(1, Math.min(ZOOM_MAX, z2));
    const u = (mx - zoom.fx * W) / (W * zoom.z), v = (my - zoom.fy * H) / (H * zoom.z);
    zoom.z = z2;
    zoom.fx = (mx - u * W * z2) / W;
    zoom.fy = (my - v * H * z2) / H;
    if (z2 <= 1.001) { zoom.z = 1; zoom.fx = 0; zoom.fy = 0; }
    clampZoom();
    applyZoom();
    const hint = $('iv-turn-hint'), r = selRow();
    if (hint && r) hint.innerHTML = hintFor(r);
  }
  function zoomBy(f) {
    const box = $('iv-stage-art');
    if (!box || !box.querySelector('img.iv-art')) return false;
    zoomAt(box.clientWidth / 2, box.clientHeight / 2, (zoom.k === zoomKey() ? zoom.z : 1) * f);
    return true;
  }
  /* client px -> the stage box's layout px (the deck's --ui-scale transform
     divided out) */
  function boxPoint(box, e) {
    const rc = box.getBoundingClientRect();
    const sc = (rc.width / (box.offsetWidth || 1)) || 1;
    return { x: (e.clientX - rc.left) / sc, y: (e.clientY - rc.top) / sc, sc: sc };
  }
  function zoomTail() {
    if (zoom.k === zoomKey() && zoom.z > 1.001) return ' · ' + zoom.z.toFixed(1) + '× · double-click to fit';
    return ' · scroll to zoom';
  }
  function hintFor(r) { return (prefs.stage === 'you' ? figHint() : turnHint(r)) + zoomTail(); }

  function turnHint(r) {
    if (!insp || insp.key !== r.k) return 'Drag to turn it';
    if (insp.off) return 'Turning is off — <button type="button" class="iv-link" data-act="insp-on">switch the 3D inspector on</button>';
    const rep = insp.reply;
    if (!rep) return 'Getting the turntable ready…';
    if (rep.ok === false) return esc(rep.why || 'This one cannot be turned');
    const have = inspAngles().length, total = Number(rep.total) || 24, refused = Number(rep.refused) || 0;
    if (have >= total) return 'Drag to turn · ' + Math.round(insp.angle) + '°';
    /* every angle is either drawn or refused: say so, never "Rendering…" forever */
    if (have + refused >= total) {
      if (!have) return esc(rep.failed || 'This one cannot be drawn from any side');
      return 'Drag to turn · ' + Math.round(insp.angle) + '° · ' + have + ' of ' + total + ' angles could be drawn';
    }
    return 'Rendering angles… ' + have + ' of ' + total;
  }
  function inspStart(r) {
    if (!r || !r.pl) return;
    if (insp && insp.key === r.k) return;
    inspStop();
    insp = { key: r.k, id: r.id, pl: r.pl, reply: null, angle: 0, polls: 0, timer: 0, drag: null, off: false };
    toGame('hdInspect', { formId: r.id, plugin: r.pl, queue: true });
  }
  function inspStop() {
    if (insp && insp.timer) clearTimeout(insp.timer);
    insp = null;
  }
  function onInspectData() {
    if (!insp || !window.HDLightbox || typeof HDLightbox._inspectState !== 'function') return;
    const d = HDLightbox._inspectState();
    if (!d || String(d.formId || '').toUpperCase() !== String(insp.id).toUpperCase()) return;
    if (String(d.plugin || '').toLowerCase() !== String(insp.pl).toLowerCase()) return;
    if (d.off) { insp.off = true; refreshStageArt(); return; }
    insp.reply = d;
    refreshStageArt();
    const have = inspAngles().length, total = Number(d.total) || 24;
    if (d.ok !== false && have + (Number(d.refused) || 0) < total && insp.polls < 200) {
      if (insp.timer) clearTimeout(insp.timer);
      const want = insp;
      insp.timer = setTimeout(function () {
        if (insp !== want || !shown || stageShut()) return;
        insp.polls++;
        toGame('hdInspect', { formId: insp.id, plugin: insp.pl, queue: true });
      }, 1500);
    }
  }
  /* Repaint only the picture + hint, never the whole card: a frame lands
     every second while the turntable renders, and the effects list below must
     not flicker or lose its scroll. */
  function refreshStageArt() {
    const r = selRow();
    const box = $('iv-stage-art');
    if (!r || !box) return;
    const you = prefs.stage === 'you';
    const src = stageSrc(r);
    let img = box.querySelector('img.iv-art');
    if (src) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'iv-art';
        img.setAttribute('draggable', 'false');
        img.alt = r.n;
        img.addEventListener('error', function () { if (img.parentNode) img.parentNode.removeChild(img); box.classList.remove('iv-has-art'); });
        box.insertBefore(img, box.querySelector('.iv-turn-hint'));
        applyZoom();
      }
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      box.classList.add('iv-has-art');
    }
    const hint = $('iv-turn-hint');
    if (hint) hint.innerHTML = hintFor(r);
    const cap = $('iv-fig-cap');
    if (cap) cap.innerHTML = figCaption();
  }
  function wireStageArt() {
    const box = $('iv-stage-art');
    if (!box || box._ivWired) return;
    box._ivWired = true;
    box.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    box.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.iv-link')) return;
      if ((e.button === 2 || e.button === 1) && zoom.k === zoomKey() && zoom.z > 1.001) {
        /* pan the zoomed picture */
        e.preventDefault();
        const pt = boxPoint(box, e);
        pan = { x: e.clientX, y: e.clientY, fx: zoom.fx, fy: zoom.fy, w: box.clientWidth || 1, h: box.clientHeight || 1, scale: pt.sc };
        box.classList.add('iv-panning');
        return;
      }
      if (e.button !== 0) return;
      const now = Date.now();
      if (now - lastStageDown < 380 && zoom.k === zoomKey() && zoom.z > 1.001) {
        /* double-click: fit it back (timed by hand, as the list's is) */
        lastStageDown = 0;
        e.preventDefault();
        zoomAt(0, 0, 1);
        return;
      }
      lastStageDown = now;
      const r = selRow();
      if (prefs.stage === 'you') {
        e.preventDefault();
        if (!fig) startFig('');
        fig.drag = { x: e.clientX, angle: fig.angle };
        box.classList.add('iv-dragging');
        return;
      }
      if (!r || !r.pl) return;
      e.preventDefault();
      inspStart(r);
      insp.drag = { x: e.clientX, angle: insp.angle };
      box.classList.add('iv-dragging');
      refreshStageArt();
    });
    box.addEventListener('wheel', function (e) {
      if (!e.shiftKey) {
        /* the wheel zooms toward the pointer; Shift+wheel turns */
        if (!box.querySelector('img.iv-art')) return;
        e.preventDefault();
        const pt = boxPoint(box, e);
        const z0 = zoom.k === zoomKey() ? zoom.z : 1;
        zoomAt(pt.x, pt.y, e.deltaY < 0 ? z0 * ZOOM_STEP : z0 / ZOOM_STEP);
        return;
      }
      if (prefs.stage === 'you') {
        if (!fig || !fig.reply) return;
        e.preventDefault();
        const st = Number(fig.reply.step) || 15;
        fig.angle = ((fig.angle + (e.deltaY > 0 ? st : -st)) % 360 + 360) % 360;
        refreshStageArt();
        return;
      }
      const r = selRow();
      if (!r || !insp || insp.key !== r.k || !insp.reply) return;
      e.preventDefault();
      insp.angle = ((insp.angle + (e.deltaY > 0 ? 15 : -15)) % 360 + 360) % 360;
      refreshStageArt();
    });
  }
  /* mouse-down to mouse-up, never MouseEvent.buttons (Ultralight reports 0
     while a button is held — the lightbox learned it first) */
  function onDocMove(e) {
    if (pan) {
      zoom.fx = pan.fx + (e.clientX - pan.x) / pan.scale / pan.w;
      zoom.fy = pan.fy + (e.clientY - pan.y) / pan.scale / pan.h;
      clampZoom();
      applyZoom();
      return;
    }
    if (colDrag) {
      const dx = (e.clientX - colDrag.x) / colDrag.scale;
      if (!colDrag.moved && Math.abs(dx) < 2) return;
      colDrag.moved = true;
      moveBoundary(colDrag, dx);
      return;
    }
    if (fig && fig.drag) {
      /* the figure follows the hand (the person page's mirror-drag-follows) */
      const st = (fig.reply && Number(fig.reply.step)) || 15;
      const steps = Math.round((e.clientX - fig.drag.x) / 18);
      const next = ((fig.drag.angle + steps * st) % 360 + 360) % 360;
      if (next !== fig.angle) { fig.angle = next; refreshStageArt(); }
      return;
    }
    if (!insp || !insp.drag) return;
    const steps = Math.round((e.clientX - insp.drag.x) / 18);
    const next = ((insp.drag.angle - steps * 15) % 360 + 360) % 360;
    if (next !== insp.angle) { insp.angle = next; refreshStageArt(); }
  }
  function onDocUp() {
    if (pan) {
      pan = null;
      const b = $('iv-stage-art');
      if (b) b.classList.remove('iv-panning');
      return;
    }
    if (colDrag) {
      const d = colDrag;
      colDrag = null;
      if (d.el) d.el.classList.remove('iv-dragging');
      const pane = $('iv-pane');
      if (pane) pane.classList.remove('iv-col-drag');
      if (d.moved) { noSortUntil = Date.now() + 250; lastGrip = { id: '', t: 0 }; savePrefs(); }
      return;
    }
    if (fig && fig.drag) {
      fig.drag = null;
      const b = $('iv-stage-art');
      if (b) b.classList.remove('iv-dragging');
      return;
    }
    if (!insp || !insp.drag) return;
    insp.drag = null;
    const box = $('iv-stage-art');
    if (box) box.classList.remove('iv-dragging');
  }


  /* ------------------------------------------------- the figure (On you) -- */

  function figAngles() {
    const f = fig && fig.reply && fig.reply.frames;
    if (!f) return [];
    return Object.keys(f).map(Number).filter((n) => isFinite(n)).sort((a, b) => a - b);
  }
  function figFrame() {
    const angles = figAngles();
    if (!angles.length) return '';
    let best = angles[0], bd = 999;
    angles.forEach((a) => {
      const dd = Math.min(Math.abs(a - fig.angle), 360 - Math.abs(a - fig.angle));
      if (dd < bd) { bd = dd; best = a; }
    });
    const p = fig.reply.frames[String(best)];
    return window.HDArt ? HDArt.path(p) : p;
  }
  function stageSrc(r) {
    if (prefs.stage === 'you') return figFrame();
    return inspFrame(r) || artSrc(r);
  }
  function figHint() {
    if (!fig) return 'Building your figure…';
    const rep = fig.reply;
    if (!rep) return 'Building your figure — the first one takes a moment…';
    if (rep.ok === false) return esc(rep.why || 'Your figure could not be built');
    const have = figAngles().length, total = Number(rep.total) || 24;
    if (rep.failed && !have) return esc(rep.failed);
    return have >= total ? 'Drag to turn · ' + Math.round(fig.angle) + '°' : 'Rendering your figure… ' + have + ' of ' + total;
  }
  function figCaption() {
    if (fig && fig.tryKey && byKey[fig.tryKey]) return 'Trying on <b>' + esc(byKey[fig.tryKey].n) + '</b>';
    return 'As you are now';
  }
  function figAsk() {
    if (!fig) return;
    const payload = { queue: true };
    const r = fig.tryKey ? byKey[fig.tryKey] : null;
    if (r) payload.try = { id: r.id, pl: r.pl };
    toGame('ivMirror', payload);
  }
  /* Build (or re-open) a figure. Asking is free once the frames exist: C++
     lists them off the disk and queues nothing it has rendered before. */
  function startFig(tryKey) {
    tryKey = tryKey || '';
    if (fig && fig.tryKey === tryKey && fig.reply) { refreshStageArt(); return; }
    if (fig && fig.timer) clearTimeout(fig.timer);
    fig = { tryKey: tryKey, reply: null, angle: 0, polls: 0, timer: 0, drag: null };
    figAsk();
    refreshStageArt();
  }
  function stopFigPoll() { if (fig && fig.timer) { clearTimeout(fig.timer); fig.timer = 0; } }
  function onMirrorData(d) {
    if (!fig || !d || typeof d !== 'object') return;
    const r = fig.tryKey ? byKey[fig.tryKey] : null;
    const t = d.try;
    const same = r ? !!(t && String(t.id).toUpperCase() === String(r.id).toUpperCase() &&
      String(t.pl).toLowerCase() === String(r.pl).toLowerCase()) : !t;
    if (!same) return;   // a reply for a figure we have since stopped asking for
    fig.reply = d;
    refreshStageArt();
    const have = figAngles().length, total = Number(d.total) || 24;
    stopFigPoll();
    if (d.ok !== false && !d.failed && have < total && fig.polls < 200 && shown && prefs.stage === 'you' && !stageShut()) {
      const want = fig;
      fig.timer = setTimeout(function () {
        if (fig !== want || !shown || prefs.stage !== 'you' || stageShut()) return;
        fig.polls++;
        figAsk();
      }, 1500);
    }
  }
  function setStage(v) {
    prefs.stage = v === 'you' ? 'you' : 'item';
    savePrefs();
    if (prefs.stage === 'you') { if (!fig) startFig(''); else if (fig.reply) onMirrorData(fig.reply); }
    else stopFigPoll();
    paintStage();
  }

  /* ------------------------------------------------------------ paint -- */

  function paintAll() {
    applyLayout();
    rebuild();
    paintHead();
    paintRail();
    paintSubs();
    paintCols();
    paintWindow();
    paintFoot();
    paintStage();
    const r = selRow();
    if (r) askDetail(r);
  }

  function select(k, scrollInto) {
    if (!byKey[k]) return;
    if (sel === k) return;
    sel = k;
    if (insp && insp.key !== k) inspStop();
    const rows = $('iv-rows');
    if (rows) {
      rows.querySelectorAll('.iv-sel').forEach((x) => x.classList.remove('iv-sel'));
      const hit = rows.querySelector('[data-k="' + cssEsc(k) + '"]');
      if (hit) hit.classList.add('iv-sel');
    }
    if (scrollInto) ensureVisible(k);
    paintStage();
    askDetail(byKey[k]);
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function ensureVisible(k) {
    const list = $('iv-list');
    const i = view.indexOf(byKey[k]);
    if (!list || i < 0) return;
    let top, bottom;
    if (prefs.mode === 'grid') {
      const cols = gridCols(list);
      top = Math.floor(i / cols) * TILE_H; bottom = top + TILE_H;
    } else { top = i * ROW_H; bottom = top + ROW_H; }
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    paintWindow();
  }

  function moveSel(delta) {
    if (!view.length) return;
    let i = view.indexOf(byKey[sel]);
    if (i < 0) i = 0;
    else i = Math.max(0, Math.min(view.length - 1, i + delta));
    select(view[i].k, true);
  }
  function stepRows(dir) {
    if (prefs.mode === 'grid') return gridCols($('iv-list')) * dir;
    return dir;
  }
  function pageRows() {
    const list = $('iv-list');
    const h = list ? list.clientHeight : 600;
    return prefs.mode === 'grid' ? Math.max(1, Math.floor(h / TILE_H)) * gridCols(list) : Math.max(1, Math.floor(h / ROW_H) - 1);
  }

  /* ------------------------------------------------------------- verbs -- */

  function act(op, r, extra) {
    if (!r) return;
    if (op === 'text') { openBook(r); return; }
    if (op === 'drop' && r.qi) { toast('A quest item stays with you', true); return; }
    if (op === 'drop' && r.q > 1 && !(extra && extra.n)) { openDrop(r); return; }
    const payload = { op: op, id: r.id, pl: r.pl, gk: r.gk };
    if (extra) for (const k in extra) payload[k] = extra[k];
    reselect = { base: r.b, name: r.n };
    if (op === 'drop' && (!extra || extra.n >= r.q)) {
      /* the line is going away: land on its neighbour, not the top */
      const i = view.indexOf(r);
      const nb = view[i + 1] || view[i - 1];
      reselect = nb ? { base: nb.b, name: nb.n } : null;
    }
    pending(true);
    toGame('ivAct', payload);
  }
  function pending(on) {
    const p = $('iv-pane');
    if (p) p.classList.toggle('iv-busy', !!on);
  }

  /* ---------------------------------------------------------- popouts -- */
  /* Body-anchored (the popout law): it fills the viewport, so its bare vw/vh
     are correct and it must not wear the deck's ui-scale. It owns Escape and
     Enter through onKey while it is up. */

  function closePop() {
    if (!pop) return;
    if (pop.el && pop.el.parentNode) pop.el.parentNode.removeChild(pop.el);
    pop = null;
  }
  function openPop(kind, inner, onKey) {
    closePop();
    const back = document.createElement('div');
    back.className = 'iv-pop-back';
    back.innerHTML = '<div class="iv-pop iv-pop-' + kind + '" role="dialog" aria-modal="true">' + inner + '</div>';
    back.addEventListener('mousedown', function (e) { if (e.target === back) closePop(); });
    document.body.appendChild(back);
    pop = { el: back, kind: kind, onKey: onKey };
    return back;
  }

  function openDrop(r) {
    let n = 1;
    const back = openPop('drop',
      '<div class="iv-pop-h"><img src="' + (CAT_ICON[r.c] || CAT_ICON.misc) + '" alt="" class="iv-pop-ic">' +
        '<div><div class="iv-pop-t">Drop ' + esc(r.n) + '</div><div class="iv-pop-s">You carry ' + num(r.q) + ' · ' + wtTxt(r.w) + ' weight each</div></div>' +
        '<button type="button" class="iv-pop-x" data-x="1" aria-label="Close">✕</button></div>' +
      '<div class="iv-drop-row">' +
        '<button type="button" class="iv-step" data-d="-1" aria-label="One fewer">−</button>' +
        '<input type="text" id="iv-drop-n" class="iv-drop-n" value="1" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="How many">' +
        '<button type="button" class="iv-step" data-d="1" aria-label="One more">+</button>' +
      '</div>' +
      '<div class="iv-drop-quick">' +
        '<button type="button" class="iv-chip" data-n="1">One</button>' +
        (r.q >= 4 ? '<button type="button" class="iv-chip" data-n="' + Math.floor(r.q / 2) + '">Half (' + Math.floor(r.q / 2) + ')</button>' : '') +
        '<button type="button" class="iv-chip" data-n="' + r.q + '">All ' + num(r.q) + '</button>' +
      '</div>' +
      '<div class="iv-pop-foot"><span class="iv-pop-sum" id="iv-drop-sum"></span>' +
        '<button type="button" class="iv-btn" data-x="1">Cancel</button>' +
        '<button type="button" class="iv-btn iv-btn-danger iv-btn-primary" data-go="1">Drop</button></div>',
      function (e) {
        if (e.key === 'Enter') { go(); return true; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(n + 1); return true; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(n - 1); return true; }
        return false;
      });
    const inp = back.querySelector('#iv-drop-n');
    function set(v) {
      n = Math.max(1, Math.min(r.q, Math.round(Number(v) || 1)));
      if (inp && inp.value !== String(n)) inp.value = String(n);
      const sum = back.querySelector('#iv-drop-sum');
      if (sum) sum.textContent = (r.w > 0 ? '−' + wtTxt(r.w * n) + ' weight' : 'Weightless') + ' · ' + num(r.v * n) + ' gold of goods';
    }
    function go() { closePop(); act('drop', r, { n: n }); }
    back.addEventListener('click', function (e) {
      const t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.getAttribute('data-x')) closePop();
      else if (t.getAttribute('data-go')) go();
      else if (t.getAttribute('data-d')) set(n + Number(t.getAttribute('data-d')));
      else if (t.getAttribute('data-n')) set(Number(t.getAttribute('data-n')));
    });
    if (inp) {
      inp.addEventListener('input', function () { const v = parseInt(inp.value, 10); if (isFinite(v)) set(v); });
      setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    }
    set(1);
  }

  function openBook(r) {
    const d = details[r.k];
    const text = d && d.text ? d.text : '';
    openPop('book',
      '<div class="iv-pop-h"><img src="' + CAT_ICON.book + '" alt="" class="iv-pop-ic">' +
        '<div><div class="iv-pop-t">' + esc(r.n) + '</div><div class="iv-pop-s">' + esc(r.s || 'Book') + '</div></div>' +
        '<button type="button" class="iv-pop-x" data-x="1" aria-label="Close">✕</button></div>' +
      '<div class="iv-book">' + (text
        ? text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('')
        : '<p class="iv-book-none">' + (d ? 'This book has no pages to show.' : 'Reading the pages…') + '</p>') + '</div>' +
      '<div class="iv-pop-foot"><span class="iv-pop-sum">' + (r.tb === 'skill' && !r.rd ? 'Studying it raises the skill once.' : '') + '</span>' +
        '<button type="button" class="iv-btn" data-x="1">Close</button>' +
        '<button type="button" class="iv-btn iv-btn-primary" data-read="1">' + (r.tb === 'skill' && !r.rd ? 'Study' : 'Mark read') + '</button></div>',
      function (e) {
        const box = pop && pop.el.querySelector('.iv-book');
        if (!box) return false;
        if (e.key === 'ArrowDown') { box.scrollTop += 60; return true; }
        if (e.key === 'ArrowUp') { box.scrollTop -= 60; return true; }
        if (e.key === 'PageDown' || e.key === ' ') { box.scrollTop += box.clientHeight - 40; return true; }
        if (e.key === 'PageUp') { box.scrollTop -= box.clientHeight - 40; return true; }
        return false;
      });
    pop.el.addEventListener('click', function (e) {
      const t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.getAttribute('data-x')) closePop();
      else if (t.getAttribute('data-read')) { closePop(); act('read', r); }
    });
    if (!d) toGame('ivDetail', { id: r.id, pl: r.pl, gk: r.gk });
  }

  /* ------------------------------------------------------------ toast -- */

  function toast(msg, bad) {
    const el = $('iv-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('iv-toast-bad', !!bad);
    el.classList.remove('hidden');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { el.classList.add('hidden'); }, 2600);
  }

  /* ---------------------------------------------------------- replies -- */

  function ingest(d) {
    if (!d || typeof d !== 'object') return;
    pending(false);
    if (d.ok === false) {
      loaded = true;
      toast(d.msg || 'Could not read your inventory', true);
      paintAll();
      return;
    }
    gold = Number(d.gold) || 0;
    if (typeof d.gameIcons === 'boolean') gameIconsReady = d.gameIcons;
    if (typeof d.gameIconInfo === 'string') gameIconInfo = d.gameIconInfo;
    armorTotal = (typeof d.armor === 'number') ? d.armor : null;
    carry = { cur: Number(d.carry && d.carry.cur) || 0, max: Number(d.carry && d.carry.max) || 0 };
    if (!loaded && d.prefs && typeof d.prefs === 'object') {
      ['sort', 'mode'].forEach((k) => { if (typeof d.prefs[k] === 'string') prefs[k] = d.prefs[k]; });
      if (d.prefs.dir === 1 || d.prefs.dir === -1) prefs.dir = d.prefs.dir;
      if (typeof d.prefs.wornFirst === 'boolean') prefs.wornFirst = d.prefs.wornFirst;
      if (d.prefs.icons === 'game' || d.prefs.icons === 'art') prefs.icons = d.prefs.icons;
      if (d.prefs.stage === 'you' || d.prefs.stage === 'item') prefs.stage = d.prefs.stage;
      if (d.prefs.rail === 'mini' || d.prefs.rail === 'full') prefs.rail = d.prefs.rail;
      if (d.prefs.side === 'shut' || d.prefs.side === 'open') prefs.side = d.prefs.side;
      if (d.prefs.cols && typeof d.prefs.cols === 'object') {
        prefs.cols = {};
        NUM_COLS.forEach((id) => {
          const v = Number(d.prefs.cols[id]);
          if (isFinite(v) && v >= COL_MIN && v <= COL_MAX) prefs.cols[id] = Math.round(v);
        });
      }
      /* the saved mode wants game icons but this read did not carry them
         (the first read always asks with the default): ask again */
      if (prefs.icons === 'game' && !(d.items || []).some((r) => r && r.gi)) setTimeout(askList, 0);
      if (typeof d.prefs.cat === 'string') cat = d.prefs.cat;
    }
    if (seen === null) {
      seen = Object.create(null);
      if (Array.isArray(d.seen) && d.seen.length) d.seen.forEach((k) => { seen[String(k).toLowerCase()] = 1; });
      else seenFirst = true;
    }
    items = Array.isArray(d.items) ? d.items.filter((r) => r && r.n) : [];
    for (const k in byKey) delete byKey[k];
    items.forEach((r) => { decorate(r); byKey[r.k] = r; });
    precomputeDeltas();
    if (!RAIL.some((c) => c.id === cat)) cat = 'all';
    loaded = true;
    /* a stale detail can name a sword that is now in your hand — keep only
       the cards whose line still exists */
    for (const k in details) if (!byKey[k]) delete details[k];
    paintAll();
    /* On you: an equip/unequip changed the outfit, so the figure is re-asked
       (C++ answers with the new composition's frames, or lists the old ones).
       A try-on whose line has since been worn or dropped ends. */
    if (fig && prefs.stage === 'you' && shown && !stageShut()) {
      if (fig.tryKey && !byKey[fig.tryKey]) startFig('');
      else { fig.polls = 0; figAsk(); }
    }
  }

  function markSeen() {
    if (!seen || !items.length) return;
    let added = 0;
    items.forEach((r) => { if (!seen[r.b]) { seen[r.b] = 1; added++; } });
    if (added || seenFirst) {
      seenFirst = false;
      toGame('ivSave', { seen: Object.keys(seen) });
    }
  }

  /* -------------------------------------------------------------- wire -- */

  function wire() {
    if (wired) return;
    const pane = $('iv-pane');
    if (!pane) return;
    wired = true;

    window.ivListData = function (j) { ingest(parse(j)); };
    window.ivDetailData = function (j) {
      const d = parse(j);
      if (!d || !d.ok) return;
      const k = (d.id + '|' + d.pl + '|' + d.gk).toLowerCase();
      details[k] = d;
      if (k === sel) paintStage();
      if (pop && pop.kind === 'book' && byKey[k]) {
        const r = byKey[k];
        if (r.c === 'book') openBook(r);
      }
    };
    window.ivMirrorData = function (j) { onMirrorData(parse(j)); };
    window.ivResult = function (j) {
      const d = parse(j);
      if (!d) return;
      if (d.ok === false) pending(false);
      toast(d.msg || (d.ok ? 'Done' : 'That did not work'), d.ok === false);
    };

    $('iv-rail').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('.iv-cat') : null;
      if (!b) return;
      setCat(b.getAttribute('data-cat'));
    });
    $('iv-subs').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const f = b.getAttribute('data-flag');
      if (f) {
        if (f === 'wornFirst') { prefs.wornFirst = !prefs.wornFirst; savePrefs(); }
        else flags[f] = !flags[f];
        paintAll();
        return;
      }
      const s = b.getAttribute('data-sub');
      if (s) { subOn[s] = !subOn[s]; paintAll(); }
    });
    function onSort(e) {
      const b = e.target.closest ? e.target.closest('[data-sort]') : null;
      if (!b) return;
      setSort(b.getAttribute('data-sort'));
    }
    $('iv-cols').addEventListener('click', function (e) {
      if (Date.now() < noSortUntil) return;   // the click a grip drag ends with
      onSort(e);
    });
    $('iv-cols').addEventListener('mousedown', onGripDown);
    $('iv-fold-rail').addEventListener('click', foldRail);
    $('iv-fold-stage').addEventListener('click', foldStage);
    $('iv-sortbar').addEventListener('click', onSort);
    $('iv-mode').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-mode]') : null;
      if (!b) return;
      prefs.mode = b.getAttribute('data-mode') === 'grid' ? 'grid' : 'list';
      savePrefs();
      $('iv-list').scrollTop = 0;
      paintCols();
      paintWindow();
      ensureVisible(sel);
    });
    $('iv-icons').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-icons]') : null;
      if (!b) return;
      const v = b.getAttribute('data-icons') === 'game' ? 'game' : 'art';
      if (v === prefs.icons) return;
      prefs.icons = v;
      savePrefs();
      paintCols();
      rows_force();
      paintWindow();
      if (v === 'game' && !items.some((r) => r.gi)) askList();   // the first look loads the I4 rules
    });
    const list = $('iv-list');
    list.addEventListener('scroll', queuePaint);
    list.addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('[data-act="clear-all"]') : null;
      if (b) { clearAll(); return; }
      const row = e.target.closest ? e.target.closest('[data-k]') : null;
      if (!row) return;
      const k = row.getAttribute('data-k');
      const now = Date.now();
      /* double-click = the primary verb. Timed by hand: Ultralight's dblclick
         is not something the deck has proven. */
      if (lastClick.k === k && now - lastClick.t < 380) {
        lastClick = { k: '', t: 0 };
        const r = byKey[k];
        const p = r && actionsFor(r).filter((a) => a.primary)[0];
        if (p) act(p.op, r);
        return;
      }
      lastClick = { k: k, t: now };
      const box = $('iv-search');
      if (box && document.activeElement === box) { try { box.blur(); } catch (err) {} }
      select(k, false);
    });
    $('iv-stage').addEventListener('click', function (e) {
      const b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      if (b.getAttribute('data-act') === 'insp-on') {
        toGame('ixSave', { inspect3d: true });
        if (insp) { insp.off = false; insp.reply = null; toGame('hdInspect', { formId: insp.id, plugin: insp.pl, queue: true }); }
        refreshStageArt();
        return;
      }
      const view = b.getAttribute('data-view');
      if (view) { setStage(view); return; }
      const sa = b.getAttribute('data-act');
      if (sa === 'try') { const r = selRow(); if (r) { startFig(r.k); paintStage(); } return; }
      if (sa === 'untry') { startFig(''); paintStage(); return; }
      const op = b.getAttribute('data-op');
      if (op && !b.disabled) act(op, selRow());
    });
    const inp = $('iv-search');
    /* typing coalesces into one repaint per frame: a fast typist on a
       1,000-line bag must not pay a full rebuild per keystroke */
    let typeQueued = false;
    inp.addEventListener('input', function () {
      q = inp.value;
      $('iv-search-x').classList.toggle('hidden', !q);
      if (typeQueued) return;
      typeQueued = true;
      setTimeout(function () {
        typeQueued = false;
        list.scrollTop = 0;
        paintAll();
      }, 16);
    });
    $('iv-search-x').addEventListener('click', function () {
      inp.value = ''; q = '';
      this.classList.add('hidden');
      paintAll();
      try { inp.focus(); } catch (e) {}
    });
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup', onDocUp);
    document.addEventListener('hd-inspect-data', onInspectData);
    window.addEventListener('resize', function () { if (shown) { queuePaint(); positionGrips(); } });

    if (window.HDArt) {
      art = HDArt.group('inventory', {
        visible: function () { return shown; },
        specs: function () {
          const out = lastWindow.filter((r) => r.pl).map(artSpec);
          const r = selRow();
          if (r && r.pl) out.push(artSpec(r));
          return out;
        },
        onLand: function () { if (shown) { rows_force(); paintWindow(); refreshStageArt(); } },
      });
    }
  }
  function rows_force() { const r = $('iv-rows'); if (r) r._ivHtml = null; }

  function setCat(id) {
    if (!RAIL.some((c) => c.id === id)) return;
    if (cat !== id) subOn = Object.create(null);
    cat = id;
    prefs.cat = id;
    savePrefs();
    const list = $('iv-list');
    if (list) list.scrollTop = 0;
    paintAll();
  }
  function setSort(id) {
    const col = COLS.filter((c) => c.id === id)[0];
    if (!col) return;
    if (prefs.sort === id) prefs.dir = -prefs.dir;
    else { prefs.sort = id; prefs.dir = col.dir; }
    savePrefs();
    paintAll();
    ensureVisible(sel);
  }
  function clearAll() {
    q = ''; flags.eq = flags.nw = flags.st = false; subOn = Object.create(null);
    const inp = $('iv-search');
    if (inp) inp.value = '';
    $('iv-search-x').classList.add('hidden');
    paintAll();
  }

  /* ------------------------------------------------------------- host -- */

  function init() { wire(); }

  function onShow() {
    wire();
    shown = true;
    if (!loaded) paintAll();
    asked = true;
    askList();
    /* gear may have changed while the deck was closed: re-ask the figure (a
       new outfit is a new figure; an unchanged one lists from disk) */
    if (prefs.stage === 'you' && !stageShut()) { if (fig) { fig.polls = 0; figAsk(); } else startFig(''); }
    applyLayout();
    setTimeout(function () {
      positionGrips();   // laid out only now that the pane is visible
      const inp = $('iv-search');
      if (shown && inp && document.activeElement !== inp) { try { inp.focus(); } catch (e) {} }
    }, 0);
  }

  function onHide() {
    shown = false;
    closePop();
    inspStop();
    stopFigPoll();
    markSeen();
    if (art) art.stop();
    /* a hidden pane keeps its data (the next show paints instantly from it
       while the fresh read is in flight) but drops the "new" marks it has
       now shown you */
  }

  /* Keys. Returns true when handled. The deck routes here while the tab is
     up (app.js); Tab and the palette-close Escape fall through. */
  function onKey(e) {
    const k = e.key;
    if (pop) {
      if (k === 'Escape') { closePop(); return true; }
      if (pop.onKey && pop.onKey(e)) return true;
      return k !== 'Tab' && !(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName));
    }
    const inp = $('iv-search');
    const inSearch = document.activeElement === inp;
    const grip = document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains('iv-grip') ? document.activeElement : null;
    if (grip && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      moveBoundary(gripBase(grip.getAttribute('data-grip')), k === 'ArrowRight' ? NUDGE : -NUDGE);
      saveSoon();
      return true;
    }
    if (grip && k === 'Home') { resetCol(grip.getAttribute('data-grip')); return true; }
    if (!inSearch && !e.ctrlKey && !e.altKey && !e.metaKey && (k === '[' || k === ']')) {
      if (k === '[') foldRail(); else foldStage();
      return true;
    }
    if (k === 'Escape') {
      if (q || flags.eq || flags.nw || flags.st) { clearAll(); return true; }
      return false;
    }
    if (k === 'ArrowDown') { moveSel(stepRows(1)); return true; }
    if (k === 'ArrowUp') { moveSel(stepRows(-1)); return true; }
    if (prefs.mode === 'grid' && !inSearch && k === 'ArrowRight') { moveSel(1); return true; }
    if (prefs.mode === 'grid' && !inSearch && k === 'ArrowLeft') { moveSel(-1); return true; }
    if (k === 'PageDown') { moveSel(pageRows()); return true; }
    if (k === 'PageUp') { moveSel(-pageRows()); return true; }
    if (!inSearch && k === 'Home') { if (view.length) select(view[0].k, true); return true; }
    if (!inSearch && k === 'End') { if (view.length) select(view[view.length - 1].k, true); return true; }
    if (k === 'Enter') {
      const r = selRow();
      if (!r) return true;
      const acts = actionsFor(r);
      const want = e.shiftKey ? acts.filter((a) => a.op === 'left')[0] : acts.filter((a) => a.primary)[0];
      if (want) act(want.op, r);
      return true;
    }
    if (k === 'Delete' && !inSearch) { act('drop', selRow()); return true; }
    if (!inSearch && !e.ctrlKey && !e.altKey && !e.metaKey && !stageShut()) {
      if (k === '+' || k === '=') { if (zoomBy(ZOOM_STEP)) return true; }
      if (k === '-' || k === '_') { if (zoomBy(1 / ZOOM_STEP)) return true; }
      if (k === '0') { if (zoomBy(0)) return true; }
    }
    /* single-letter verbs only while the search box does NOT have the caret —
       otherwise an F typed into "fur" would favorite the selection. Clicking a
       row takes the caret out of the box; any other letter puts it back. */
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (!inSearch) {
      if (k === 'f' || k === 'F') { act('fav', selRow()); return true; }
      if (k === 'r' || k === 'R') {
        const r = selRow();
        if (r && (r.c === 'book' || r.c === 'tome')) { act(r.c === 'book' ? 'text' : 'read', r); return true; }
      }
    }
    /* type-to-search: any printable key lands in the search box */
    if (!inSearch && k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && inp) {
      try { inp.focus(); } catch (err) {}
      return false;
    }
    return false;
  }

  /* ------------------------------------------------------------- omni -- */
  /* No provider of our own: hd-wheel.js already registers `inventory` ("What
     you are carrying") for the Ctrl+F palette, the wheel picker and the shelf
     pins. A second one would list every item twice. That provider's tab is
     this page, so Shift+Enter on any carried item lands here, filtered to it
     (setFilter below). */

  return {
    init: init, onShow: onShow, onHide: onHide, onKey: onKey,
    setFilter: function (s) { q = String(s || ''); const inp = $('iv-search'); if (inp) inp.value = q; paintAll(); },
    /* harness hooks */
    _state: function () { return { items: items, view: view, sel: sel, cat: cat, prefs: prefs, flags: flags, q: q, insp: insp, pop: pop && pop.kind, details: details }; },
    _select: select, _setCat: setCat, _setSort: setSort, _act: act, _foldRail: foldRail, _foldStage: foldStage, _zoom: function () { return zoom; },
  };
})();
