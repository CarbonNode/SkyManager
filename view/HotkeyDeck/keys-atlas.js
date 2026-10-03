/* SkyManager Device map — hotkey-atlas-map.
 * Layouts adapted from Neutral9/HotkeyAtlas; see keys-atlas-layouts.js.
 * Read-only presentation of the Keys census. No input hooks or config writes.
 */
'use strict';
window.KeysAtlas = (function () {
  let root = null, source = null, previousFocus = null;
  let device = 'keyboard', query = '', selected = null, conflicts = false;
  let lastData = null;
  const padNames = ['D-pad Up', 'D-pad Down', 'D-pad Left', 'D-pad Right',
    'Start', 'Back', 'L3', 'R3', 'LB', 'RB', 'A', 'B', 'X', 'Y', 'LT', 'RT'];
  const verdict = { hard: 'Conflict', soft: 'Shares a game key', maybe: 'Possible overlap' };
  function el(tag, cls, text) {
    const n = document.createElement(tag); n.className = cls || '';
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function button(text, fn, cls) {
    const b = el('button', cls || 'kca-button', text); b.type = 'button';
    b.addEventListener('click', fn); return b;
  }
  function deviceFor(code) { return code >= 266 && code <= 281 ? 'gamepad' : code >= 256 ? 'mouse' : 'keyboard'; }
  function name(code) {
    if (code >= 266 && code <= 281) return 'Pad ' + padNames[code - 266];
    if (code === 219) return 'Left Windows';
    if (code === 220) return 'Right Windows';
    if (code === 221) return 'Menu';
    return '';
  }
  function label(code) {
    const g = lastData && lastData.all.find(g => g.code === code);
    if (g) return g.name;
    return (source && source.keyName && source.keyName(code)) || name(code) || ('Key ' + code);
  }
  function matches(g, text) {
    if (!text) return true;
    return [g.name].concat(g.owners.map(o => [o.mod, o.control, o.mods, o.detail].join(' ')))
      .join(' ').toLowerCase().indexOf(text.toLowerCase()) !== -1;
  }
  function data() {
    const d = source.getData();
    return { groups: d.groups || [], all: d.all || d.groups || [], phase: d.phase || 'idle',
      note: d.note || '', gamepad: !!d.gamepad, incomplete: !!d.incomplete };
  }
  function definitions() {
    const layouts = window.KeysAtlasLayouts;
    const defs = layouts && layouts[device] ? layouts[device].slice() : [];
    if (device === 'keyboard') {
      // Extended keys used by MMO mice and the deck. F24 has a discontinuous DIK.
      for (let i = 0; i < 12; i++) defs.push([i === 11 ? 118 : 100 + i, 'F' + (13 + i), i, 7, 1, 1]);
      const used = {}; defs.forEach(k => { used[k[0]] = true; });
      // Chord Keys' virtual pool and non-US keys stay inspectable.
      lastData.all.filter(g => deviceFor(g.code) === 'keyboard' && !used[g.code]).forEach((g, i) => {
        defs.push([g.code, g.name, i % 16, 8.3 + Math.floor(i / 16), 1, 1]);
      });
    }
    return defs;
  }
  function select(code) {
    selected = code;
    paintKeys(); paintDetail();
    const detail = root.querySelector('.kca-detail');
    // Narrow layouts put detail above the map. A tap reveals it without shrinking keys.
    if (window.innerWidth < 800 && detail && detail.scrollIntoView) detail.scrollIntoView({ block: 'nearest' });
  }
  function paintKeys() {
    const byCode = {}; lastData.groups.forEach(g => { byCode[g.code] = g; });
    let count = 0;
    root.querySelectorAll('.kca-key').forEach(b => {
      const code = +b.getAttribute('data-code');
      const g = byCode[code] || { code: code, name: label(code), owners: [], kind: '' };
      const hit = matches(g, query) && (!conflicts || !!g.kind);
      if (hit && g.owners.length) count++;
      b.className = 'kca-key' + (g.owners.length ? ' kca-bound' : '') +
        (g.kind ? ' kca-' + g.kind : '') + (!hit ? ' kca-muted' : '') +
        (code === selected ? ' kca-selected' : '');
      b.setAttribute('aria-pressed', code === selected ? 'true' : 'false');
      const state = g.kind ? verdict[g.kind] : g.owners.length ? 'Reported' : 'No reported binding';
      b.setAttribute('aria-label', label(code) + ', ' + g.owners.length + ' bindings, ' + state);
      b.title = label(code) + ' — ' + state + (g.owners.length ? '\n' +
        g.owners.map(o => (o.mods ? o.mods + ' + ' : '') + o.control + ' — ' + o.mod).join('\n') : '');
      b.querySelector('.kca-key-count').textContent = g.owners.length ? String(g.owners.length) : '';
    });
    const status = root.querySelector('.kca-status');
    const pending = lastData.phase === 'idle' || lastData.phase === 'scanning';
    status.textContent = pending ? 'Waiting for the Keys scan…' : lastData.phase === 'error'
      ? 'Scan failed. Close the map and choose Rescan all. ' + lastData.note
      : count + ' matching buttons with reported bindings' + (lastData.phase === 'refreshing' ? ' · Refreshing…' : '') +
        (lastData.incomplete ? ' · Some MCMs did not answer' : '');
  }
  function paintDetail() {
    const box = root.querySelector('.kca-detail'); box.textContent = '';
    if (selected === null) {
      box.appendChild(el('h3', '', 'Choose a key'));
      box.appendChild(el('p', 'kca-help', 'Select a button on the map to see every reported action and the mod that owns it.'));
      box.appendChild(el('p', 'kca-help', 'Search by key, mod or action. Enter selects the first matching binding.'));
      return;
    }
    const g = lastData.groups.find(g => g.code === selected);
    const all = lastData.all.find(g => g.code === selected);
    box.appendChild(el('div', 'kca-selected-name', label(selected)));
    const pending = lastData.phase === 'idle' || lastData.phase === 'scanning';
    if (!g || !g.owners.length) {
      box.appendChild(el('h3', '', all ? 'Hidden by source filters' : pending ? 'Scan pending' : 'No reported binding'));
      box.appendChild(el('p', 'kca-help', all ? 'Close the map and enable its source in the Keys list.'
        : 'The census cannot prove a button is unused. Mods may listen for input without reporting a binding.'));
      return;
    }
    box.appendChild(el('h3', 'kca-verdict' + (g.kind ? ' kca-text-' + g.kind : ''),
      (g.kind ? verdict[g.kind] : 'Reported bindings') + ' · ' + g.owners.length));
    if (g.kind) box.appendChild(el('p', 'kca-help',
      'Shared keys need a closer look: modifiers, input context and tap / hold gestures can keep actions separate.'));
    g.owners.forEach(o => {
      const row = el('div', 'kca-owner');
      row.appendChild(el('strong', '', o.mod || 'Unknown owner'));
      row.appendChild(el('div', 'kca-action', (o.mods ? o.mods + ' + ' : '') + (o.control || 'Unnamed action')));
      row.appendChild(el('span', 'kca-source', source.sourceName ? source.sourceName(o.src) : o.src));
      if (o.guess) row.appendChild(el('p', 'kca-assumed', 'Assumed key code — the config does not identify its code format.'));
      if (o.detail) row.appendChild(el('p', 'kca-provenance', o.detail));
      box.appendChild(row);
    });
  }
  function paintBoard() {
    const scroll = root.querySelector('.kca-map-scroll'); scroll.textContent = '';
    const board = el('div', 'kca-board kca-board-' + device);
    board.setAttribute('role', 'group'); board.setAttribute('aria-label', device + ' button map');
    const defs = definitions();
    const unit = device === 'keyboard' ? 62 : 64;
    const width = device === 'keyboard' ? 23 : device === 'mouse' ? 11 : 14;
    const height = Math.max.apply(null, defs.map(k => k[3] + k[5]).concat([device === 'keyboard' ? 8 : 9.4]));
    board.style.width = width * unit + 'px'; board.style.height = height * unit + 'px';
    if (device !== 'keyboard') {
      // These are the physical device bodies, not decorative icons.
      if (device === 'gamepad') {
        // Outline translated from HotkeyAtlas UI/DeviceView.cpp DrawXboxBody,
        // revision d8dd09c, GPL-3.0. Mirrored halves preserve the actual silhouette.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 14 9.4'); svg.setAttribute('class', 'kca-pad-outline');
        svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const path = 'M7 1.3H3.9C2.4 1.25 1.3 1.65 .95 2.8C.6 4 .1 6.6 .35 8.1C.55 9.2 2 9.4 2.8 8.6C3.5 7.9 4 7.05 5 7H7';
        [false,true].forEach(mirror => {
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          p.setAttribute('d', path); if (mirror) p.setAttribute('transform', 'translate(14 0) scale(-1 1)');
          svg.appendChild(p);
        }); board.appendChild(svg);
      } else {
        const shell = el('div', 'kca-device-body kca-device-body-mouse');
        shell.setAttribute('aria-hidden', 'true'); board.appendChild(shell);
      }
    }
    defs.forEach(k => {
      const b = button('', () => select(k[0]), 'kca-key');
      b.setAttribute('data-code', k[0]);
      b.style.left = k[2] * unit + 'px'; b.style.top = k[3] * unit + 'px';
      b.style.width = k[4] * unit - 5 + 'px'; b.style.height = k[5] * unit - 5 + 'px';
      if (device === 'gamepad' && (k[0] === 272 || k[0] === 273 || (k[0] >= 276 && k[0] <= 279))) b.style.borderRadius = '50%';
      b.appendChild(el('span', 'kca-key-label', k[1]));
      b.appendChild(el('span', 'kca-key-count', '')); board.appendChild(b);
    });
    scroll.appendChild(board);
    const caption = root.querySelector('.kca-caption');
    caption.textContent = device === 'gamepad'
      ? 'Xbox button names. Gameplay controls only; stick movement and mod-specific controller bindings are not scanned.' +
        (!lastData.gamepad ? ' This DLL has not reported controller scan support yet.' : '')
      : device === 'mouse' ? 'Mouse 4–8 are hardware buttons. MMO side buttons mapped to F-keys appear on Keyboard.'
        : 'Standard keyboard with F13–F24 below. On narrow screens, keys form a readable button grid.';
    root.querySelectorAll('[data-device]').forEach(b => b.setAttribute('aria-pressed', b.getAttribute('data-device') === device ? 'true' : 'false'));
    paintKeys(); paintDetail();
  }
  function refresh() {
    if (!root || !source) return;
    const before = lastData ? lastData.all.map(g => g.code).join(',') : '';
    lastData = data();
    if (before !== lastData.all.map(g => g.code).join(',')) paintBoard();
    else { paintKeys(); paintDetail(); }
  }
  function close() {
    if (!root) return;
    root.remove(); root = null; source = null; lastData = null;
    if (typeof window.hdCapture === 'function') window.hdCapture('0');
    if (previousFocus && document.body.contains(previousFocus)) previousFocus.focus();
    previousFocus = null;
  }
  function onKey(e) {
    if (!root) return false;
    const key = e.key || e.code;
    if (key === 'Escape') { close(); return true; }
    if (key === 'Tab') {
      const nodes = root.querySelectorAll('button:not(:disabled),input');
      const first = nodes[0], last = nodes[nodes.length - 1], current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) { last.focus(); return true; }
      if (!e.shiftKey && (current === last || !root.contains(current))) { first.focus(); return true; }
    }
    return false;
  }
  function open(options) {
    if (root) return;
    if (!window.KeysAtlasLayouts || !options || typeof options.getData !== 'function') return;
    source = options; lastData = data(); previousFocus = document.activeElement;
    selected = null; query = options.filter || ''; conflicts = !!options.conflicts;
    root = el('div', 'kca-back');
    const dialog = el('section', 'kca-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'kca-title');
    const head = el('div', 'kca-head');
    const heading = el('h2', '', 'Device map'); heading.id = 'kca-title';
    head.appendChild(heading); head.appendChild(button('Close', close)); dialog.appendChild(head);
    const tools = el('div', 'kca-tools');
    const devices = el('div', 'kca-devices'); devices.setAttribute('role', 'group'); devices.setAttribute('aria-label', 'Device');
    ['keyboard', 'mouse', 'gamepad'].forEach(d => {
      const b = button(d === 'gamepad' ? 'Controller' : d.charAt(0).toUpperCase() + d.slice(1), () => {
        device = d; selected = null; paintBoard();
      }); b.setAttribute('data-device', d); devices.appendChild(b);
    });
    tools.appendChild(devices);
    const filter = el('input', 'kca-search'); filter.type = 'search'; filter.placeholder = 'Search key, mod or action…';
    filter.setAttribute('aria-label', 'Search device bindings'); filter.autocomplete = 'off'; filter.spellcheck = false; filter.value = query;
    filter.addEventListener('input', () => { query = filter.value.trim(); paintKeys(); });
    filter.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const g = lastData.groups.find(g => deviceFor(g.code) === device && matches(g, query) && (!conflicts || g.kind));
      if (g) select(g.code); e.preventDefault();
    });
    tools.appendChild(filter);
    const conflictButton = button('Conflicts only', () => {
      conflicts = !conflicts; conflictButton.setAttribute('aria-pressed', String(conflicts)); paintKeys();
    }); conflictButton.setAttribute('aria-pressed', String(conflicts)); tools.appendChild(conflictButton); dialog.appendChild(tools);
    const legend = el('div', 'kca-legend');
    [['bound','Reported'],['hard','Conflict'],['soft','Shares game key'],['maybe','Possible overlap'],['none','No report']].forEach(v => {
      legend.appendChild(el('span', 'kca-legend-' + v[0], v[1]));
    }); dialog.appendChild(legend);
    const status = el('div', 'kca-status'); status.setAttribute('role', 'status'); dialog.appendChild(status);
    const body = el('div', 'kca-content');
    const visual = el('div', 'kca-visual');
    const map = el('div', 'kca-map-scroll'); visual.appendChild(map);
    visual.appendChild(el('p', 'kca-caption'));
    body.appendChild(visual); body.appendChild(el('aside', 'kca-detail')); dialog.appendChild(body);
    dialog.appendChild(el('p', 'kca-credit', 'Device layouts adapted from Neutral9’s HotkeyAtlas · Read-only census'));
    root.appendChild(dialog); document.body.appendChild(root);
    root.addEventListener('click', e => { if (e.target === root) close(); });
    if (typeof window.hdCapture === 'function') window.hdCapture('1');
    paintBoard(); filter.focus();
  }
  // Window capture precedes the host's document capture: Escape must close only
  // this modal. The host separately returns early for all ordinary typing.
  window.addEventListener('keydown', e => {
    if (root && onKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  return { open: open, close: close, refresh: refresh, isOpen: () => !!root, onKey: onKey, keyName: name };
})();
