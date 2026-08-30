'use strict';

/* ====================================================================== *
 *  HDItemPick — the shared "find one item in the whole load order" picker
 *  (Rober, 2026-08-16: "maybe a blacklist / whitelist where you can easily
 *  use same code as the finder to quickly find an item and add it").
 *
 *  WHY IT EXISTS. Two features needed to name ONE item and had no way to
 *  search for it. Auto-sort's pin picker said so in its own source comment
 *  — "we have no live item index in the view" — and could only filter
 *  whatever the last csStateResult happened to carry. Meanwhile the Finder
 *  (item_explorer.cpp) already indexes every named, obtainable item in the
 *  load order with search, type filters and plugin scoping. This module is
 *  that index, lent to anyone who needs to point at an item.
 *
 *  ITS OWN BRIDGE DOOR. It sends `ixPick` and listens on `ixPickData` —
 *  NOT ixQuery/ixResultData. Same C++ index and the same QueryJson, but a
 *  second consumer on ixResultData would clobber the Items tab's own
 *  listener the moment a picker was open behind it (one listener per name
 *  is the bridge law). C++ side: main.cpp OnJsItemsPick.
 *
 *  Replies are response-style — the picker always asks first — so it needs
 *  no hd-boot STUB_FNS entry. A reply whose seq is stale is dropped, which
 *  is what makes fast typing safe.
 *
 *  API
 *    HDItemPick.open({
 *      host,        // pane <section> to mount into (required — the ix-sheet
 *                   // idiom: absolute inset:0 INSIDE the panel, so it
 *                   // inherits the deck scale and clips to its corners)
 *      title,       // headline, e.g. 'Never pick this up'
 *      hint,        // one explanatory line under it ('' hides)
 *      confirm,     // verb on the row button (default 'Add')
 *      multi,       // true = stay open after a pick (build a list in one go)
 *      chosen,      // () => [{plugin, localId}] already on the list; those
 *                   // rows render ✓ added and refuse a second add
 *      onPick,      // fn({plugin, localId, name, type, value, weight})
 *      onClose,     // optional
 *    })
 *    HDItemPick.close() · HDItemPick.isOpen()
 * ====================================================================== */

window.HDItemPick = (function () {

  /* kind key -> [label, glyph]. Mirrors items-pane.js KINDS deliberately
     rather than importing it: the Finder owns its pane's copy, and a picker
     that silently changed shape when that pane was refactored would be a
     worse bug than a duplicated 14-row table. 'all' is a pseudo-kind. */
  const KINDS = [
    ['all',  'Everything', '⌕'],
    ['weap', 'Weapons',    '⚔'],
    ['armo', 'Armor',      '🛡'],
    ['alch', 'Potions',    '🧪'],
    ['food', 'Food',       '🍖'],
    ['ingr', 'Ingredients','🌿'],
    ['book', 'Books',      '📕'],
    ['scrl', 'Scrolls',    '📜'],
    ['slgm', 'Soul Gems',  '🔮'],
    ['misc', 'Misc',       '💎'],
    ['ammo', 'Ammo',       '➶'],
    ['keym', 'Keys',       '🗝'],
    ['ligh', 'Torches',    '🕯'],
  ];

  const PAGE = 40;          // rows per request — one screenful plus scroll
  const DEBOUNCE_MS = 180;  // keystroke -> request

  let el = null;      // overlay root while open
  let opts = null;
  let seq = 0;        // request generation; a reply below this is stale
  let items = [];
  let total = 0;
  let sel = 0;
  let q = '';
  let kind = 'all';
  let plugin = '';    // plugin scope chip ('' = every plugin)
  let awaiting = false;
  let typeT = null;
  let keyFn = null;

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

  function kindMeta(t) {
    for (let i = 0; i < KINDS.length; i++) if (KINDS[i][0] === t) return KINDS[i];
    return ['all', 'Item', '◆'];
  }

  /* "Plugin.esp|0001A2" -> 0x0001A2. The id C++ sends is the durable identity;
     the hex half is the local FormID under that file's width, so it is already
     ESL-safe and must never be re-derived from a runtime FormID here. */
  function localIdOf(it) {
    const s = String((it && it.id) || '');
    const bar = s.indexOf('|');
    if (bar < 0) return 0;
    return parseInt(s.slice(bar + 1), 16) >>> 0;
  }

  function isChosen(it) {
    if (!opts || typeof opts.chosen !== 'function') return false;
    const list = opts.chosen() || [];
    const lid = localIdOf(it);
    const plug = String(it.p || '').toLowerCase();
    for (let i = 0; i < list.length; i++) {
      const e = list[i] || {};
      if ((e.localId >>> 0) === lid && String(e.plugin || '').toLowerCase() === plug) return true;
    }
    return false;
  }

  /* Existing rendered art only. The picker deliberately does NOT queue new
     renders: that pipeline belongs to the Finder, and a picker that spent a
     minute of framework time per search would be a tax on every use. A row
     with no art keeps its type glyph, which is honest and instant. */
  function artFor(it) {
    if (!window.WardrobePane || typeof WardrobePane.itemIconFor !== 'function') return '';
    try {
      return WardrobePane.itemIconFor({ formId: localIdOf(it), plugin: it.p, name: it.n }) || '';
    } catch (e) { return ''; }
  }

  function isOpen() { return !!el; }

  function close() {
    seq++;                       // in-flight replies become stale
    if (typeT) { clearTimeout(typeT); typeT = null; }
    if (keyFn) { document.removeEventListener('keydown', keyFn, true); keyFn = null; }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    items = []; total = 0; sel = 0; q = ''; kind = 'all'; plugin = ''; awaiting = false;
    const o = opts; opts = null;
    if (o && typeof o.onClose === 'function') o.onClose();
  }

  function request() {
    seq++;
    awaiting = true;
    window.toGame
      ? window.toGame('ixPick', JSON.stringify({ q: q, type: kind, plugin: plugin, limit: PAGE, offset: 0, seq: seq }))
      : (window.hdToGame && window.hdToGame('ixPick', JSON.stringify({ q: q, type: kind, plugin: plugin, limit: PAGE, offset: 0, seq: seq })));
    paint();
  }

  function requestSoon() {
    if (typeT) clearTimeout(typeT);
    typeT = setTimeout(function () { typeT = null; request(); }, DEBOUNCE_MS);
  }

  /* The one reply door. Stale seq = a request the user has already typed past;
     dropping it is what keeps fast typing from painting older results last. */
  window.ixPickData = function (d) {
    if (!el) return;
    const j = (typeof d === 'string') ? JSON.parse(d) : (d || {});
    if ((j.seq | 0) !== seq) return;
    awaiting = false;
    items = Array.isArray(j.items) ? j.items : [];
    total = j.total | 0;
    sel = 0;
    paint();
  };

  function pick(it) {
    if (!it || !opts) return;
    if (isChosen(it)) return;
    const payload = {
      plugin: String(it.p || ''),
      localId: localIdOf(it),
      name: String(it.n || ''),
      type: String(it.t || ''),
      value: it.v | 0,
      weight: +it.w || 0,
    };
    if (!payload.plugin || !payload.localId) return;   // no identity, no rule
    if (typeof opts.onPick === 'function') opts.onPick(payload);
    if (opts.multi) paint();                            // reflect the new ✓
    else close();
  }

  function move(d) {
    if (!items.length) return;
    sel = Math.max(0, Math.min(items.length - 1, sel + d));
    paint();
    const row = el && el.querySelector('.ip-row.sel');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function paint() {
    if (!el) return;
    const listEl = el.querySelector('.ip-list');
    const countEl = el.querySelector('.ip-count');
    if (!listEl) return;

    if (countEl) {
      countEl.textContent = awaiting ? 'searching…'
        : (total > items.length ? (items.length + ' of ' + total) : (total + (total === 1 ? ' match' : ' matches')));
    }

    listEl.innerHTML = '';

    if (awaiting) {
      /* Skeletons sized like the real rows so the list does not jump when the
         results land (the deck's standing rule for anything that loads). */
      for (let i = 0; i < 6; i++) listEl.appendChild(h('div', { class: 'ip-skel' }, null));
      return;
    }

    if (!items.length) {
      listEl.appendChild(h('div', { class: 'ip-empty' }, [
        h('div', { class: 'ip-empty-g' }, '⌕'),
        h('div', { class: 'ip-empty-t' }, q || plugin || kind !== 'all'
          ? 'Nothing in the load order matches that.'
          : 'Type to search every item in your load order.'),
        h('div', { class: 'ip-empty-s' }, q
          ? 'Try fewer letters, or widen the type filter.'
          : 'Item name, or a mod name to scope the list.'),
      ]));
      return;
    }

    items.forEach(function (it, i) {
      const meta = kindMeta(it.t);
      const already = isChosen(it);
      const art = artFor(it);
      const plate = h('div', { class: 'ip-plate' }, h('span', { class: 'ip-glyph' }, meta[2]));
      if (art) {
        const img = h('img', { class: 'ip-art', src: art, alt: '' });
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
        plate.appendChild(img);
      }
      const row = h('div', {
        class: 'ip-row' + (i === sel ? ' sel' : '') + (already ? ' added' : ''),
        title: already ? (it.n + ' — already on the list') : it.n,
        onclick: function () { sel = i; already ? paint() : pick(it); },
      }, [
        plate,
        h('div', { class: 'ip-txt' }, [
          h('div', { class: 'ip-name' }, String(it.n || '(unnamed)')),
          h('div', { class: 'ip-sub' }, [
            h('button', {
              class: 'ip-plug',
              title: 'Only show items from ' + (it.p || 'this mod'),
              onclick: function (e) { e.stopPropagation(); plugin = String(it.p || ''); request(); },
            }, String(it.p || '')),
            h('span', { class: 'ip-meta' }, (it.v | 0) + 'g · ' + (+it.w || 0) + ' wt · ' + meta[1]),
          ]),
        ]),
        h('button', {
          class: 'ip-add' + (already ? ' on' : ''),
          title: already ? 'Already on the list' : (opts.confirm || 'Add'),
          onclick: function (e) { e.stopPropagation(); if (!already) pick(it); },
        }, already ? '✓ added' : (opts.confirm || 'Add')),
      ]);
      listEl.appendChild(row);
    });
  }

  function open(o) {
    if (el) close();
    opts = o || {};
    const host = opts.host;
    if (!host) return;   // no host, no mount — never fall back to <body> (it
                         // would escape the deck's scale transform)

    q = ''; kind = 'all'; plugin = ''; items = []; total = 0; sel = 0;

    const search = h('input', {
      class: 'ip-search', type: 'text', spellcheck: 'false',
      placeholder: 'Search every item in the load order… (Enter takes the top hit)',
    });
    search.oninput = function () { q = search.value; requestSoon(); };

    const pills = h('div', { class: 'ip-pills' });
    KINDS.forEach(function (k) {
      pills.appendChild(h('button', {
        class: 'ip-pill' + (k[0] === kind ? ' on' : ''),
        title: k[1],
        onclick: function () {
          kind = k[0];
          Array.prototype.forEach.call(pills.children, function (b, i) {
            b.className = 'ip-pill' + (KINDS[i][0] === kind ? ' on' : '');
          });
          request();
        },
      }, k[2] + ' ' + k[1]));
    });

    const scope = h('div', { class: 'ip-scope' });
    function paintScope() {
      scope.innerHTML = '';
      if (!plugin) { scope.style.display = 'none'; return; }
      scope.style.display = '';
      scope.appendChild(h('span', { class: 'ip-scope-l' }, 'showing only'));
      scope.appendChild(h('button', {
        class: 'ip-scope-chip', title: 'Clear this mod filter',
        onclick: function () { plugin = ''; paintScope(); request(); },
      }, plugin + '  ✕'));
    }

    el = h('div', { class: 'ip-wrap' }, [
      h('div', { class: 'ip-card' }, [
        h('div', { class: 'ip-head' }, [
          h('div', { class: 'ip-head-txt' }, [
            h('div', { class: 'ip-title' }, String(opts.title || 'Find an item')),
            opts.hint ? h('div', { class: 'ip-hint' }, String(opts.hint)) : null,
          ]),
          h('span', { class: 'ip-count' }, ''),
          h('button', { class: 'ip-x', title: 'Close (Esc)', onclick: close }, '✕'),
        ]),
        search,
        pills,
        scope,
        h('div', { class: 'ip-list' }, null),
        h('div', { class: 'ip-foot' },
          opts.multi ? 'Add as many as you like — Esc when you are done.'
                     : 'Esc closes without adding.'),
      ]),
    ]);

    /* Click-out on the dimmed surround closes, but a click INSIDE the card
       must not — hence the target test rather than a stopPropagation on
       every child. */
    el.onclick = function (e) { if (e.target === el) close(); };

    host.appendChild(el);
    paintScope();

    keyFn = function (e) {
      if (!el) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); move(-1); return; }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (items.length) pick(items[Math.max(0, Math.min(items.length - 1, sel))]);
      }
    };
    document.addEventListener('keydown', keyFn, true);

    if (search.focus) search.focus();
    request();   // open on the unfiltered head of the index, never a blank box
  }

  return { open: open, close: close, isOpen: isOpen, _KINDS: KINDS, _localIdOf: localIdOf };
})();
