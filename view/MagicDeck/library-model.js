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
    out.layout = ['cards', 'columns', 'list', 'icons'].indexOf(raw.layout) >= 0 ? raw.layout : 'cards';
    out.sort = ['custom', 'name', 'kind', 'mode', 'school'].indexOf(raw.sort) >= 0 ? raw.sort : 'custom';
    out.density = DENSITIES.indexOf(raw.density) >= 0 ? raw.density : 'balanced';
    out.sizeAuto = raw.sizeAuto !== false;
    out.sidebarCollapsed = raw.sidebarCollapsed === true;
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
  var api = { normalize: normalize, inside: inside, tree: tree, path: path, kind: kind, visible: visible,
    stats: spellStatTiles, effectRows: spellEffectRows, cardStats: spellCardStats, densities: DENSITIES.slice(), fitDensity: fitDensity, stepDensity: stepDensity };
  root.SpellLibrary = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
