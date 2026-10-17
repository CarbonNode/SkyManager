/* Magic Workbench: runtime spellbook + saved organization. No engine writes. */
(function (root) {
  'use strict';
  function key(s) {
    var p = String(s.plugin || '').toLowerCase(), id = Number(s.localId) >>> 0;
    // Runtime forms may be browsed this session, but cannot become group members.
    return p && id ? p + '|' + id.toString(16) : '';
  }
  function entries(known) {
    return known.map(function (s) {
      return Object.assign({}, s, { id: 'learned:' + (key(s) || '#' + (s.formId >>> 0)),
        mode: 'equip', hand: 'right', category: '', _learned: true });
    });
  }
  function merge(saved, learned) {
    var seen = Object.create(null), out = saved.slice();
    saved.forEach(function (s) { seen[key(s) || '#' + (s.formId >>> 0)] = true; });
    learned.forEach(function (s) {
      var k = key(s) || '#' + (s.formId >>> 0);
      if (!seen[k]) { seen[k] = true; out.push(s); }
    });
    return out;
  }
  /* Side-pane widths the player dragged, in PRE-scale layout px (the same rule
     as the panel's own drag size). 0 = auto: the stylesheet's width wins. */
  var PANES = { rail: { key: 'railW', min: 220, max: 520 }, inspector: { key: 'inspectorW', min: 280, max: 720 } };
  function paneWidth(pane, value) {
    var spec = PANES[pane], v = Number(value);
    return spec && isFinite(v) && v > 0 ? Math.round(Math.min(spec.max, Math.max(spec.min, v))) : 0;
  }
  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var seen = Object.create(null);
    return Object.assign({}, raw, {
      inspector: raw.inspector !== false, artwork: raw.artwork !== false, dock: raw.dock !== false,
      railW: paneWidth('rail', raw.railW), inspectorW: paneWidth('inspector', raw.inspectorW),
      textSize: [100,115,130].indexOf(raw.textSize) >= 0 ? raw.textSize : 100,
      theme: ['gold','frost','contrast'].indexOf(raw.theme) >= 0 ? raw.theme : 'gold',
      motion: raw.motion !== false,
      groups: (Array.isArray(raw.groups) ? raw.groups : []).slice(0,128).filter(function (g) {
        if (!g || typeof g.id !== 'string' || !g.id || seen[g.id]) return false;
        seen[g.id] = true; return true;
      }).map(function (g) {
        return Object.assign({}, g, { name: String(g.name || 'Spell group').slice(0,100),
          icon: typeof g.icon === 'string' && /^icons\/[a-zA-Z0-9_./ -]+\.(png|webp|jpg)$/i.test(g.icon) && g.icon.indexOf('..') < 0 ? g.icon : '',
          pinned: g.pinned !== false, layout: g.layout === 'icons' ? 'icons' : 'list',
          members: (Array.isArray(g.members) ? g.members : []).filter(function (k, i, a) {
            return typeof k === 'string' && /^[^|]+\|[0-9a-f]+$/i.test(k) && a.indexOf(k) === i;
          }).slice(0,4096) });
      })
    });
  }
  function groupRows(rows, group) {
    var members = Object.create(null), seen = Object.create(null);
    group.members.forEach(function (k) { members[k] = true; });
    return rows.filter(function (s) { var k = key(s); if (!members[k] || seen[k]) return false; seen[k] = true; return true; });
  }
  function search(rows, q) {
    var terms = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows.filter(function (s) {
      var hay = [s.name,s.plugin,s.school,s.element,s.type,s.category].join(' ').toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
  }
  var api = { key:key, entries:entries, merge:merge, normalize:normalize, groupRows:groupRows, search:search, PANES:PANES, paneWidth:paneWidth };
  root.MagicWorkbenchModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
