/* Spell Library data rules. No DOM or game writes; shared by the view and tests. */
(function (root) {
  'use strict';
  var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  /* Card density ladder, roomiest first. `density` is the size the player PINNED
     from the select or the Cards stepper; `sizeAuto` (default on — Rober,
     2026-09-24: "fit to four rows without scrolling") lets the view walk the
     ladder after every render until the list no longer scrolls. A config saved
     before the flag existed carries no sizeAuto, so it gets the auto fit. */
  var DENSITIES = ['spacious', 'balanced', 'compact', 'dense'];
  function normalize(raw, categories) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var out = Object.assign({}, raw, { parents: Object.create(null) });
    out.layout = ['cards', 'columns', 'list', 'table', 'icons'].indexOf(raw.layout) >= 0 ? raw.layout : 'columns';
    out.table = normalizeTable(raw.table);
    out.sort = ['custom', 'name', 'kind', 'mode', 'school'].indexOf(raw.sort) >= 0 ? raw.sort : 'custom';
    out.density = DENSITIES.indexOf(raw.density) >= 0 ? raw.density : 'balanced';
    out.sizeAuto = raw.sizeAuto !== false;
    out.sidebarCollapsed = raw.sidebarCollapsed === true;
    // Expanded by default (2026-10-15). It defaulted to COLLAPSED while the fold
    // only took a filter row away; now the same chevron also takes the title
    // block and the quick groups, so that default opened a first run on bare
    // cards and hid the quick filters entirely. Folding stays one click away and
    // anyone who has folded it keeps their choice.
    out.controlsCollapsed = raw.controlsCollapsed === true;
    var p = raw.parents || {};
    categories.forEach(function (c) {
      if (own(p, c) && categories.indexOf(p[c]) >= 0 && p[c] !== c) out.parents[c] = p[c];
    });
    // Break malformed cycles deterministically; never hide a category or its spells.
    categories.forEach(function (c) {
      var seen = [c], at = c;
      while (own(out.parents, at)) {
        at = out.parents[at];
        if (seen.indexOf(at) >= 0) { delete out.parents[c]; break; }
        seen.push(at);
      }
    });
    return out;
  }
  /* Table view (2026-10-11): one row per spell under sortable column headers,
     the way the game's own magic list reads. Its sort is its own (a header
     click), kept apart from library.sort so the other views and the Portal,
     which only know the five legacy sorts, are untouched. 'custom' = my order.
     `hidden` lists the columns the player switched off; Name cannot be hidden. */
  var TABLE_FIELDS = ['name', 'school', 'tier', 'magnitude', 'duration', 'cost'];
  var TABLE_NUMERIC = ['tier', 'magnitude', 'duration', 'cost'];
  var TIERS = ['novice', 'apprentice', 'adept', 'expert', 'master'];
  function normalizeTable(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return Object.assign({}, raw, {
      sort: TABLE_FIELDS.indexOf(raw.sort) >= 0 ? raw.sort : 'custom', dir: raw.dir === -1 ? -1 : 1,
      hidden: (Array.isArray(raw.hidden) ? raw.hidden : []).filter(function (f, i, a) { return TABLE_FIELDS.indexOf(f) > 0 && a.indexOf(f) === i; }),
    });
  }
  /* A header click: a new column starts in its natural direction (numbers
     high to low, text A to Z), a second click reverses, a third returns to
     the player's own order. */
  function tableCycle(table, field) {
    var first = TABLE_NUMERIC.indexOf(field) >= 0 ? -1 : 1;
    if (TABLE_FIELDS.indexOf(field) < 0) return table;
    if (table.sort !== field) { table.sort = field; table.dir = first; }
    else if (table.dir === first) table.dir = -first;
    else { table.sort = 'custom'; table.dir = 1; }
    return table;
  }
  /* The three numbers a row shows, from the same description reply the cards
     and Details use. Magnitude and duration are the main effect's: direct
     damage first, then healing, then the first effect that has a number. */
  function tableStats(data) {
    var s = data && data.ok && data.stats, wait = data ? '—' : '…';
    if (!s) return { magnitude: null, duration: null, cost: null, text: { magnitude: wait, duration: wait, cost: wait } };
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
    var effects = (Array.isArray(s.effects) ? s.effects : []).filter(function (e) { return e && typeof e === 'object'; });
    var sized = effects.filter(function (e) { return num(e.magnitude) > 0; });
    var main = sized.filter(function (e) { return e.kind === 'damage'; })[0] || sized.filter(function (e) { return e.kind === 'healing'; })[0] || sized[0] || null;
    var dur = main && num(main.duration) > 0 ? main.duration : effects.reduce(function (m, e) { return Math.max(m, num(e.duration) || 0); }, 0);
    var cost = s.shout ? null : num(s.cost);
    return { magnitude: main ? main.magnitude : null, duration: dur > 0 ? dur : null, cost: cost, text: {
      magnitude: main ? spellStatNumber(main.magnitude) + (main.perSecond ? ' /s' : '') : '—',
      duration: dur > 0 ? spellStatNumber(dur) + ' sec' : '—',
      cost: s.shout ? 'Voice' : cost === null ? '—' : spellStatNumber(cost) + (s.costPerSecond ? ' /s' : '') } };
  }
  /* Stable; a row with nothing to compare (no tier, numbers not read yet) goes
     last whichever way the column runs. `stat(spell)` answers tableStats(). */
  function tableSort(rows, table, meta, stat) {
    var f = table && table.sort, dir = table && table.dir === -1 ? -1 : 1;
    if (TABLE_FIELDS.indexOf(f) < 0) return rows;
    function value(s) {
      var m = meta(s) || {};
      if (f === 'name') return String(s.name || '').toLowerCase();
      if (f === 'school') return String(m.school || (kind(m) === 'unknown' ? '' : kind(m))).toLowerCase();
      if (f === 'tier') { var t = TIERS.indexOf(String(m.tier || '').toLowerCase()); return t < 0 ? null : t; }
      var v = stat(s); return v && typeof v[f] === 'number' ? v[f] : null;
    }
    return rows.map(function (s, i) { return { s: s, v: value(s), i: i }; }).sort(function (a, b) {
      var an = a.v === null || a.v === '', bn = b.v === null || b.v === '';
      if (an !== bn) return an ? 1 : -1;
      var c = an ? 0 : typeof a.v === 'number' ? a.v - b.v : a.v.localeCompare(b.v);
      return c * dir || String(a.s.name || '').localeCompare(String(b.s.name || '')) || a.i - b.i;
    }).map(function (x) { return x.s; });
  }
  function inside(cat, parent, parents) {
    var seen = [];
    while (cat && seen.indexOf(cat) < 0) {
      if (cat === parent) return true;
      seen.push(cat); cat = own(parents, cat) ? parents[cat] : '';
    }
    return false;
  }
  function tree(categories, parents) {
    var out = [];
    function visit(parent, depth) {
      categories.forEach(function (c) {
        if ((own(parents, c) ? parents[c] : '') !== parent) return;
        out.push({ name: c, depth: depth }); visit(c, depth + 1);
      });
    }
    visit('', 0); return out;
  }
  function path(cat, parents) {
    var a = [], seen = [];
    while (cat && seen.indexOf(cat) < 0) {
      a.unshift(cat); seen.push(cat); cat = own(parents, cat) ? parents[cat] : '';
    }
    return a.join(' / ');
  }
  function kind(m) {
    var t = String(m.type || '').toLowerCase();
    if (t === 'shout') return 'shout';
    if (t.indexOf('power') >= 0 || t === 'lesser' || t === 'voice') return 'power';
    if (t === 'spell' || (m.slot === 'hand' && m.school)) return 'spell';
    return 'unknown'; // a voice slot alone does not distinguish powers from shouts
  }
  function visible(spells, library, filter, meta) {
    var q = String(filter.filter || '').trim().toLowerCase();
    var terms = q.split(/\s+/).filter(Boolean);
    var rows = spells.filter(function (s) {
      var m = meta(s);
      if (filter.cat !== '__all__' && !inside(s.category, filter.cat, library.parents)) return false;
      if (filter.kind && filter.kind !== 'all' && kind(m) !== filter.kind) return false;
      if (filter.mode && filter.mode !== 'all' && s.mode !== filter.mode) return false;
      if (!terms.length) return true;
      var hay = [s.name, path(s.category, library.parents), s.plugin, m.school, m.element, m.type].join(' ').toLowerCase();
      return terms.every(function (term) { return hay.indexOf(term) >= 0; });
    });
    if (library.sort !== 'custom') rows.sort(function (a, b) {
      var field = library.sort;
      var av = field === 'kind' ? kind(meta(a)) : field === 'school' ? meta(a).school : a[field];
      var bv = field === 'kind' ? kind(meta(b)) : field === 'school' ? meta(b).school : b[field];
      return String(av || '').localeCompare(String(bv || '')) || String(a.name).localeCompare(String(b.name));
    });
    return rows;
  }
  /* ui-surface-counts: one unsorted pass for all category and smart-filter
     badges. Fresh on every paint, so edits/live metadata never stale a cache. */
  function counts(spells, parents, meta) {
    var out = { all: spells.length, kinds: Object.create(null), modes: Object.create(null), categories: Object.create(null) };
    spells.forEach(function (s) {
      var k = kind(meta(s));
      out.kinds[k] = (out.kinds[k] || 0) + 1;
      out.modes[s.mode] = (out.modes[s.mode] || 0) + 1;
      var cat = s.category, seen = [];
      while (cat && seen.indexOf(cat) < 0) {
        out.categories[cat] = (out.categories[cat] || 0) + 1;
        seen.push(cat); cat = own(parents, cat) ? parents[cat] : '';
      }
    });
    return out;
  }
  /* The ladder itself, kept pure so the harness can feed it heights: `fits(d)`
     answers whether the list stops scrolling at density d (the view measures
     scrollHeight against clientHeight after setting data-density). The first
     density that fits wins; when nothing fits, dense — as tight as it goes. */
  function fitDensity(fits, start) {
    var i = Math.max(0, DENSITIES.indexOf(start || 'spacious'));
    for (; i < DENSITIES.length; i++) if (fits(DENSITIES[i])) return DENSITIES[i];
    return DENSITIES[DENSITIES.length - 1];
  }
  /* One step along the ladder: dir +1 = smaller cards, -1 = bigger. Clamped. */
  function stepDensity(cur, dir) {
    var i = DENSITIES.indexOf(cur); if (i < 0) i = 1;
    return DENSITIES[Math.max(0, Math.min(DENSITIES.length - 1, i + (dir > 0 ? 1 : -1)))];
  }
  // BEGIN SPELL DESCRIPTION FORMATTERS — mirrored in portal/index.html, checked by tests.
  function spellStatNumber(n) { return typeof n === 'number' && isFinite(n) ? String(Math.round(n * 10) / 10) : '—'; }
  function spellStatTiles(data) {
    var s = data && data.ok && data.stats;
    if (!s) return [{label:'Magicka cost',value:data ? '—' : '…',note:'Not returned by the game'}, {label:'Base damage',value:data ? '—' : '…',note:'Not returned by the game'}];
    var effects = Array.isArray(s.effects) ? s.effects : [];
    var damage = effects.filter(function (e) { return e.kind === 'damage' && typeof e.magnitude === 'number' && isFinite(e.magnitude); });
    var healing = effects.filter(function (e) { return e.kind === 'healing' && typeof e.magnitude === 'number' && isFinite(e.magnitude); });
    var chosen = damage.length ? damage : healing, label = damage.length ? 'Base damage' : healing.length ? 'Base healing' : 'Base damage';
    var tile = {label:label,value:'—',note:'No direct damage value'};
    if (chosen.length === 1 && !s.shout) tile = {label:label,value:spellStatNumber(chosen[0].magnitude) + (chosen[0].perSecond ? ' /s' : ''),note:'Before perks and resistance'};
    else if (chosen.length) tile = {label:label,value:String(chosen.length) + ' effects',note:s.shout ? 'By word below' : 'See each effect below'};
    return [{label:'Magicka cost',value:spellStatNumber(s.cost) + (s.costPerSecond && typeof s.cost === 'number' ? ' /s' : ''),note:s.shout ? 'Uses voice cooldown' : 'Your normal-cast cost'},tile];
  }
  function spellEffectRows(data) {
    var s = data && data.ok && data.stats;
    return ((s && Array.isArray(s.effects)) ? s.effects : []).map(function (e) {
      var parts = [], mag = typeof e.magnitude === 'number' && isFinite(e.magnitude);
      if (mag) parts.push(spellStatNumber(e.magnitude) + (e.perSecond ? ' /s' : '') + ' ' + (e.kind === 'damage' ? 'base damage' : e.kind === 'healing' ? 'base healing' : 'base magnitude'));
      if (typeof e.duration === 'number' && e.duration > 0) parts.push(spellStatNumber(e.duration) + ' sec');
      if (typeof e.area === 'number' && e.area > 0) parts.push(spellStatNumber(e.area) + ' ft area');
      return {name:(e.words ? e.words + (e.words === 1 ? ' word · ' : ' words · ') : '') + (e.name || 'Effect'),text:parts.join(' · ') || 'No numeric magnitude'};
    });
  }
  function spellCardStats(data) {
    var s = data && data.ok && data.stats;
    if (!s) return [{label:'Magicka',value:data ? '—' : '…',note:data ? 'Open Details to retry unavailable stats' : 'Reading from the game'},
      {label:'Base effect',value:'—',note:'Open Details for spell effects'}];
    var tiles = spellStatTiles(data), effect = tiles[1];
    return [s.shout ? {label:'Resource',value:'Voice',note:'Uses voice cooldown'} :
      {label:'Magicka',value:tiles[0].value,note:'Your normal-cast cost; direct-cast actions may differ'},
      effect.value === '—' ? {label:'Effects',value:'Details',note:'No direct damage or healing value returned'} :
      {label:effect.label,value:effect.value,note:effect.value.indexOf('effects') >= 0 ? 'Separate effects; open Details to read each' : effect.note}];
  }
  // END SPELL DESCRIPTION FORMATTERS
  var api = { normalize: normalize, inside: inside, tree: tree, path: path, kind: kind, visible: visible, counts: counts,
    stats: spellStatTiles, effectRows: spellEffectRows, cardStats: spellCardStats, densities: DENSITIES.slice(), fitDensity: fitDensity, stepDensity: stepDensity,
    tableFields: TABLE_FIELDS.slice(), tableNumeric: TABLE_NUMERIC.slice(), normalizeTable: normalizeTable, tableCycle: tableCycle, tableStats: tableStats, tableSort: tableSort };
  root.SpellLibrary = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
