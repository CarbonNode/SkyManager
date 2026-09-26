'use strict';
/* ================================ HDPlaces — the searchable teleport ================================
 *
 *  Rober, 2026-09-14: "a quick teleport hotkeyable function, or i can add to favorites in
 *  skymanager, i type in name of area like crystaldrift and it says ok i think you mean
 *  coc ______ and then i can teleport to it, needs to work with all cells (and be fast)
 *  from mods etc. a searchable cells menu basically"
 *
 *  WHAT THIS IS. An Omni search PROVIDER (`places`), so every place in the load order is
 *  reachable from the three surfaces that already exist: Ctrl+F in the deck, the Super
 *  Searcher popup, and — the hotkeyable answer — the seeded "Teleport" action, which
 *  deep-opens the Super Searcher LOCKED to this one source (hd-super.js only-mode; the
 *  box says "Type a place…"). Enter teleports. ☆ on a row pins it to the Favorites Shelf
 *  (the pin key survives reloads; the shelf fires it through pinRun); the Omni's recents
 *  list the last places you went to.
 *
 *  WHERE THE ROWS COME FROM. C++ (src/places.cpp) indexes once per session every CELL
 *  that kept an editor ID (exactly what `coc` resolves against — interiors from every
 *  mod, ESL included) plus every MAP MARKER in every worldspace (the exterior answer:
 *  Whiterun, Bleak Falls Barrow, a mod's town). The view never holds that list: the
 *  provider is LAZY (the quests idiom) — each keystroke asks hdPlacesQuery and the top
 *  40 come back through hdPlacesData. Rows are then ABSORBED into a small session cache
 *  that index() returns, so (1) the Omni ranks/highlights them with its own scorer like
 *  any local provider, (2) a pinned or recent place re-resolves live once seen, and
 *  (3) lazyResults() is called with [] on purpose — the rows are already in index(),
 *  returning them twice would list each place twice.
 *
 *  THE ROW SAYS HOW. A cell row's detail reads `coc CrystaldriftCave01 · Skyrim.esm ·
 *  Enter teleports` — "I think you mean coc X" is literally what you read before
 *  pressing Enter. A marker row reads `Map marker · cave · Skyrim · undiscovered`.
 *  The teleport itself is the console's own road (coc / player.moveto) run by C++ after
 *  it closes the palette, so the jump lands in the live world.
 *
 *  Marker (hd-markers.json view): "id: 'places'".
 * ==================================================================================================== */

var HDPlaces = (function () {
  var seq = 0;          // query sequence; a reply carrying an older seq is stale and dropped
  var cache = [];       // rows seen this session, newest first — the provider's index()
  var byPin = {};       // pin -> item, for dedupe
  var CACHE_MAX = 400;
  var count = 0;        // places the engine indexed (from the last reply), for the log line

  /* `coc bannermist` typed into the Omni (Rober, 2026-09-21: "can command k be smarter …
     find actual cell id and run that?"). The verb is stripped before the engine is
     asked, so the Places rows under the query are the cells the name matches, and
     bestCell() names the one the console row's Go button will jump to. */
  var COC_RX = /^coc\s+(.+)$/i;
  function cocArg(q) {
    var m = String(q || '').trim().match(COC_RX);
    return m ? m[1].trim() : '';
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s'\-_]/g, ''); }
  /* the cell in the session cache that best matches a typed name — exact editor ID or
     name first, then prefix, then substring; null when nothing lands at all */
  function bestCell(arg) {
    var a = norm(arg);
    if (!a) return null;
    var best = null, bestScore = 0;
    for (var i = 0; i < cache.length; i++) {
      var it = cache[i];
      if (!it || !it.snap || it.snap.kind !== 'cell') continue;
      var e = norm(it.snap.edid), n = norm(it.label);
      var sc = 0;
      if (e === a) sc = 100;
      else if (n === a) sc = 95;
      else if (e.indexOf(a) === 0) sc = 80;
      else if (n.indexOf(a) === 0) sc = 75;
      else if (e.indexOf(a) !== -1) sc = 50;
      else if (n.indexOf(a) !== -1) sc = 45;
      if (sc > bestScore) { bestScore = sc; best = it; }
    }
    return best;
  }
  /* {arg, item|null} for a `coc …` query, null for anything else */
  function resolveCoc(q) {
    var arg = cocArg(q);
    if (!arg) return null;
    return { arg: arg, item: bestCell(arg) };
  }

  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
  }
  function parsePayload(p) {
    if (p && typeof p === 'object') return p;
    try { return JSON.parse(p); } catch (e) { return null; }
  }

  /* fire the teleport: C++ closes the palette, runs coc / player.moveto, notifies */
  function go(snap) {
    if (!snap || !snap.kind) return;
    toGame('hdPlacesGo', JSON.stringify(snap));
  }

  function itemOf(r) {
    if (!r || typeof r !== 'object') return null;
    var isMarker = r.k === 'm';
    var name = String(r.n || r.e || r.id || '');
    if (!name) return null;
    var snap, detail, pin;
    if (isMarker) {
      if (!r.id) return null;
      snap = { kind: 'marker', id: String(r.id), label: name };
      pin = 'pl:m:' + String(r.id);
      detail = 'Map marker · ' + [r.t, r.w].filter(Boolean).join(' · ') +
               (r.v ? '' : ' · undiscovered') + (r.d ? ' · not placed yet' : '') +
               ' · Enter teleports';
    } else {
      if (!r.e) return null;
      snap = { kind: 'cell', edid: String(r.e), label: name };
      pin = 'pl:c:' + String(r.e);
      detail = 'coc ' + String(r.e) + (r.p ? ' · ' + r.p : '') + ' · Enter teleports';
    }
    var nospace = String(r.n || '').replace(/[\s'\-]/g, '');
    return {
      label: name,
      detail: detail,
      kind: isMarker ? 'map marker' : 'cell',
      plugin: isMarker ? '' : String(r.p || ''),
      /* 'coc' on a cell: the query "coc bannermist" still lands every word on the row */
      keywords: [r.e, r.p, r.w, r.t, nospace, isMarker ? '' : 'coc'].filter(Boolean).join(' '),
      pin: pin,
      snap: snap,
      run: function () { go(snap); },
    };
  }

  /* absorb a reply's rows into the session cache (newest first, deduped, capped) */
  function absorb(rows) {
    var added = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      var it = itemOf(rows[i]);
      if (!it) continue;
      if (byPin[it.pin]) {
        var at = cache.indexOf(byPin[it.pin]);
        if (at !== -1) cache.splice(at, 1);
      }
      byPin[it.pin] = it;
      cache.unshift(it);
      added++;
    }
    while (cache.length > CACHE_MAX) {
      var old = cache.pop();
      if (old && byPin[old.pin] === old) delete byPin[old.pin];
    }
    return added;
  }

  function ask(q) {
    seq++;
    toGame('hdPlacesQuery', JSON.stringify({ q: String(q || ''), seq: seq, limit: 40 }));
  }

  /* C++ reply: {seq, q, total, count, rows:[{k,n,e,p}|{k,n,id,w,t,v,d}]} */
  window.hdPlacesData = function (payload) {
    var p = parsePayload(payload);
    if (!p) return;
    if (typeof p.count === 'number') count = p.count;
    if (p.seq !== seq) return;              // an older keystroke's answer
    absorb(Array.isArray(p.rows) ? p.rows : []);
    /* rows live in index() now — hand the omni an EMPTY lazy set so it
       re-collects (and clears its pending mark) without listing them twice */
    if (window.HDOmni && typeof HDOmni.lazyResults === 'function') HDOmni.lazyResults('places', []);
  };

  var provider = {
    id: 'places', label: 'Places', tab: '',
    /* build the engine index as the omni opens, so the first keystroke is answered
       from a warm list (the build is a few hundred ms once per session) */
    warm: function () { ask(''); },
    lazy: function (q) { ask(cocArg(q) || q); },   // "coc x" asks the engine for x
    index: function () { return cache; },
    /* Favorites Shelf / recents: fire from the stored identity even when the
       live row has not been seen this session */
    pinRun: function (snap, item) { go(item && item.snap ? item.snap : snap); },
  };

  if (window.HDOmni && typeof HDOmni.register === 'function') HDOmni.register(provider);

  return {
    go: go,
    provider: provider,
    count: function () { return count; },
    cocArg: cocArg,
    bestCell: bestCell,
    resolveCoc: resolveCoc,
    /* test seams */
    _itemOf: itemOf,
    _cache: function () { return cache; },
    _seq: function () { return seq; },
    _reset: function () { seq = 0; cache = []; byPin = {}; count = 0; },
  };
})();
window.HDPlaces = HDPlaces;
