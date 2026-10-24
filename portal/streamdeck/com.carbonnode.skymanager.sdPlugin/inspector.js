'use strict';
/* ======================================================================= *
 *  SkyManager — Stream Deck property inspector
 *
 *  Two jobs: pair with the Deck Portal once (host, port, pairing code, kept in
 *  GLOBAL settings so it is entered once for the whole Stream Deck), and pick
 *  which hotkey this key fires.
 *
 *  The picker is type-to-filter with Enter taking the top hit, because the
 *  deck it mirrors can hold hundreds of entries and a scroll-only list of
 *  hundreds is a defect, not a style choice. Every row wears the entry's own
 *  art, fetched from the portal, so the list reads the way the deck reads.
 * ======================================================================= */

const ACT_VIEW = 'com.carbonnode.skymanager.view';

let ws = null;
let uuid = '';
let action = '';
let settings = {};
let conf = { host: '127.0.0.1', port: 8090, token: '' };

let entries = [];
let query = '';
let cursor = 0;            // keyboard position in the filtered list
let loadState = 'idle';    // idle | loading | ok | unpaired | down | empty
let loadNote = '';

const app = document.getElementById('app');
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ----------------------------- Stream Deck ---------------------------- */

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const saveSettings = () => send({ event: 'setSettings', context: uuid, payload: settings });
const saveConf = () => {
  send({ event: 'setGlobalSettings', context: uuid, payload: conf });
  send({ event: 'sendToPlugin', context: uuid, action, payload: Object.assign({ event: 'saveConf' }, conf) });
};

/* ------------------------------- portal ------------------------------- */

const base = () => 'http://' + (conf.host || '127.0.0.1') + ':' + (conf.port || 8090);
const authHeaders = () => ({ 'X-SkyManager-Token': conf.token || '' });

async function loadEntries() {
  loadState = 'loading';
  loadNote = '';
  render();
  let r;
  try {
    r = await fetch(base() + '/api/streamdeck/entries', { headers: authHeaders() });
  } catch (_) {
    loadState = 'down';
    loadNote = 'Nothing is answering at ' + base() + '. Start Skyrim (the deck starts the portal ' +
               'for you), or run node server.js in the portal folder.';
    render();
    return;
  }
  if (r.status === 401) {
    loadState = 'unpaired';
    const b = await r.json().catch(() => ({}));
    loadNote = b.error || 'The portal is there, but that pairing code is wrong.';
    render();
    return;
  }
  const b = await r.json().catch(() => ({}));
  entries = Array.isArray(b.entries) ? b.entries : [];
  loadState = entries.length ? 'ok' : 'empty';
  loadNote = b.live === false
    ? 'Paired. Skyrim is not running, so presses will wait for it.'
    : 'Paired, and Skyrim is running.';
  if (!entries.length && b.ok === false && b.error) loadNote = b.error;
  render();
}

/* ------------------------------ filtering ----------------------------- */

/* The deck's own ranking: every word has to match somewhere, and an exact
   name beats a start beats a word-start beats a hit anywhere. Tab, key cap
   and verb are searchable too, so "travel", "f7" and "console" all find
   things the name alone would not. */
function rank(e, words) {
  const name = (e.name || '').toLowerCase();
  const hay = [name, (e.category || ''), (e.key || ''), (e.action || ''), (e.device || '')]
    .join(' ').toLowerCase();
  let score = 0;
  for (const w of words) {
    if (!hay.includes(w)) return -1;
    if (name === w) score += 100;
    else if (name.startsWith(w)) score += 50;
    else if (new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(name)) score += 25;
    else if (name.includes(w)) score += 10;
    else score += 2;
  }
  return score;
}

function filtered() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries.slice(0, 400);
  return entries
    .map((e) => ({ e, s: rank(e, words) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, 400)
    .map((x) => x.e);
}

/* -------------------------------- views ------------------------------- */

function connectionSection() {
  const s = el('section');
  s.appendChild(el('h2', null, 'Deck Portal'));

  const pair = el('div', 'pair');
  const hostWrap = el('div');
  hostWrap.appendChild(el('label', null, 'Address'));
  const host = el('input');
  host.type = 'text';
  host.value = conf.host;
  host.placeholder = '127.0.0.1';
  host.oninput = () => { conf.host = host.value.trim(); };
  host.onchange = () => { saveConf(); loadEntries(); };
  hostWrap.appendChild(host);

  const portWrap = el('div');
  portWrap.appendChild(el('label', null, 'Port'));
  const port = el('input');
  port.type = 'number';
  port.value = String(conf.port);
  port.min = '1';
  port.max = '65535';
  port.oninput = () => { conf.port = Number(port.value) || 8090; };
  port.onchange = () => { saveConf(); loadEntries(); };
  portWrap.appendChild(port);

  pair.appendChild(hostWrap);
  pair.appendChild(portWrap);
  s.appendChild(pair);

  const codeWrap = el('div');
  codeWrap.style.marginTop = 'var(--s3)';
  codeWrap.appendChild(el('label', null, 'Pairing code'));
  const code = el('input');
  code.type = 'text';
  code.value = conf.token;
  code.placeholder = 'XXXX-XXXX-XXXX-XXXX';
  code.spellcheck = false;
  code.autocapitalize = 'characters';
  code.oninput = () => { conf.token = code.value.trim().toUpperCase(); };
  code.onchange = () => { saveConf(); loadEntries(); };
  codeWrap.appendChild(code);
  s.appendChild(codeWrap);

  const hint = el('p', 'hint');
  hint.appendChild(document.createTextNode('The portal writes it to '));
  hint.appendChild(el('code', null, 'Data\\SKSE\\Plugins\\HotkeyDeck\\portal\\streamdeck-token.txt'));
  hint.appendChild(document.createTextNode(' the first time it runs.'));
  s.appendChild(hint);

  const retry = el('button', 'primary', 'Check the connection');
  retry.style.marginTop = 'var(--s3)';
  retry.onclick = () => { saveConf(); loadEntries(); };
  s.appendChild(retry);

  if (loadNote) {
    const st = el('div', 'status ' + (loadState === 'ok' || loadState === 'empty' ? 'ok'
      : (loadState === 'loading' ? '' : 'bad')));
    st.appendChild(el('span', 'bar'));
    st.appendChild(el('p', null, loadNote));
    s.appendChild(st);
  }
  return s;
}

function entryRow(e) {
  const row = el('button', 'row');
  row.type = 'button';
  row.setAttribute('aria-selected', String(settings.entryId === e.id));

  const artCell = el('span', 'art');
  if (e.icon) {
    const img = el('img');
    img.alt = '';
    img.src = base() + e.icon + (conf.token ? '&token=' + encodeURIComponent(conf.token) : '');
    img.onerror = () => { artCell.textContent = ''; artCell.appendChild(ring(e.name)); };
    artCell.appendChild(img);
  } else {
    artCell.appendChild(ring(e.name));
  }

  const cell = el('span', 'cell');
  cell.appendChild(el('span', 'name', e.name));
  const bits = [];
  if (e.category) bits.push(e.category);
  if (e.key) bits.push(e.key);
  else if (e.device === 'action') bits.push('action');
  else if (e.device === 'console') bits.push('console');
  cell.appendChild(el('span', 'meta', bits.join('  ·  ') || 'no key'));

  row.appendChild(artCell);
  row.appendChild(cell);
  row.onclick = () => choose(e);
  return row;
}

function ring(name) {
  const r = el('span', 'ring', (name || '?').trim().charAt(0).toUpperCase() || '?');
  return r;
}

function choose(e) {
  settings.entryId = e.id;
  settings.entryName = e.name;
  saveSettings();
  render();
}

function pickerSection() {
  const s = el('section');
  s.appendChild(el('h2', null, 'Which hotkey'));

  const search = el('div', 'search');
  const input = el('input');
  input.type = 'text';
  input.value = query;
  input.placeholder = 'Search your hotkeys…';
  input.setAttribute('aria-label', 'Search your hotkeys');
  input.oninput = () => { query = input.value; cursor = 0; renderList(); };
  input.onkeydown = (ev) => {
    const list = filtered();
    if (ev.key === 'Enter') { ev.preventDefault(); if (list[cursor]) choose(list[cursor]); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); cursor = Math.min(cursor + 1, list.length - 1); renderList(); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); cursor = Math.max(cursor - 1, 0); renderList(); return; }
    if (ev.key === 'Escape' && query) { ev.preventDefault(); query = ''; input.value = ''; cursor = 0; renderList(); }
  };
  const clear = el('button', 'clear', '×');
  clear.type = 'button';
  clear.title = 'Clear the search';
  clear.setAttribute('aria-label', 'Clear the search');
  clear.onclick = () => { query = ''; input.value = ''; cursor = 0; renderList(); input.focus(); };
  search.appendChild(input);
  search.appendChild(clear);
  s.appendChild(search);

  const list = el('div', 'list');
  list.id = 'sd-list';
  s.appendChild(list);

  const chosen = el('p', 'chosen');
  chosen.id = 'sd-chosen';
  s.appendChild(chosen);
  return s;
}

function renderList() {
  const list = document.getElementById('sd-list');
  const chosen = document.getElementById('sd-chosen');
  if (!list) return;
  list.textContent = '';

  if (loadState === 'loading') { list.appendChild(el('p', 'empty', 'Asking the portal…')); }
  else if (loadState === 'down' || loadState === 'unpaired') {
    list.appendChild(el('p', 'empty', 'Pair with the portal above and the list fills in.'));
  } else if (loadState === 'empty') {
    list.appendChild(el('p', 'empty', 'The deck has no hotkeys yet. Add one in SkyManager, then check the connection again.'));
  } else {
    const rows = filtered();
    if (!rows.length) {
      list.appendChild(el('p', 'empty', 'Nothing matches “' + query + '”.'));
    } else {
      rows.forEach((e, i) => {
        const row = entryRow(e);
        if (i === cursor) row.classList.add('cursor');
        list.appendChild(row);
      });
    }
  }

  if (chosen) {
    chosen.textContent = '';
    if (settings.entryId) {
      chosen.appendChild(document.createTextNode('This key fires '));
      const b = el('b', null, settings.entryName || settings.entryId);
      chosen.appendChild(b);
      chosen.appendChild(document.createTextNode('.'));
    } else {
      chosen.textContent = 'Pick one and this key fires it, with the deck closed.';
    }
  }
}

function viewSection() {
  const s = el('section');
  s.appendChild(el('h2', null, 'What the key does'));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'What the key does');
  [['toggle', 'Toggle'], ['open', 'Open'], ['close', 'Close']].forEach(([op, label]) => {
    const b = el('button', null, label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String((settings.op || 'toggle') === op));
    b.onclick = () => { settings.op = op; saveSettings(); render(); };
    seg.appendChild(b);
  });
  s.appendChild(seg);
  s.appendChild(el('p', 'hint', 'Toggle is the usual one: press to open the deck, press again to close it.'));
  return s;
}

function render() {
  app.textContent = '';
  if (action === ACT_VIEW) {
    app.appendChild(viewSection());
    app.appendChild(el('div', 'rule'));
    app.appendChild(connectionSection());
    return;
  }
  app.appendChild(pickerSection());
  renderList();
  app.appendChild(el('div', 'rule'));
  app.appendChild(connectionSection());
}

/* ------------------------------- wiring ------------------------------- */

function onMessage(msg) {
  if (msg.event === 'didReceiveGlobalSettings') {
    const g = (msg.payload && msg.payload.settings) || {};
    conf = { host: g.host || '127.0.0.1', port: Number(g.port) || 8090, token: g.token || '' };
    render();
    if (action !== ACT_VIEW) loadEntries();
    return;
  }
  if (msg.event === 'didReceiveSettings') {
    settings = (msg.payload && msg.payload.settings) || {};
    render();
    return;
  }
  if (msg.event === 'sendToPropertyInspector') {
    const p = msg.payload || {};
    if (p.event === 'pressResult') {
      loadNote = p.ok ? ('Pressed ' + (p.name || 'it') + '.') : (p.error || 'That press did not land.');
      loadState = p.ok ? 'ok' : 'down';
      render();
    }
  }
}

/* eslint-disable-next-line no-unused-vars -- Stream Deck calls this by name */
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  uuid = inUUID;
  let info = {};
  try { info = JSON.parse(inActionInfo) || {}; } catch (_) { info = {}; }
  action = info.action || '';
  settings = (info.payload && info.payload.settings) || {};

  ws = new WebSocket('ws://127.0.0.1:' + inPort);
  ws.onopen = () => {
    send({ event: inRegisterEvent, uuid: inUUID });
    send({ event: 'getGlobalSettings', context: inUUID });
    render();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    try { onMessage(msg); } catch (err) { console.error('SkyManager inspector: ' + (err && err.message)); }
  };
}

if (typeof window !== 'undefined') window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
