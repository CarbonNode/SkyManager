'use strict';
/* ======================================================================= *
 *  SkyManager — Stream Deck plugin
 *
 *  A key press here becomes a press of one of your SkyManager hotkeys, with
 *  the deck CLOSED and the game running. The chain is:
 *
 *      Stream Deck key
 *        -> this plugin (HTTP)
 *        -> the Deck Portal on 127.0.0.1:8090  (node, ships with SkyManager)
 *        -> the named pipe \\.\pipe\HotkeyDeck
 *        -> SkyManager, which fires the entry exactly as its own key would.
 *
 *  Nothing here knows anything about Skyrim: the portal owns the game side,
 *  so this file only has to be a good Stream Deck citizen.
 *
 *  WHY THE PAIRING CODE. The portal answers these routes cross-origin (a
 *  Stream Deck plugin is a page loaded off the filesystem, so it has no
 *  usable origin of its own). A 16-character code, minted by the portal and
 *  pasted in once, is what stops any web page the player happens to have open
 *  from pressing their hotkeys mid-fight. It is stored in GLOBAL settings, so
 *  it is entered once for every key on every profile.
 * ======================================================================= */

const ACT_ENTRY = 'com.carbonnode.skymanager.entry';
const ACT_VIEW = 'com.carbonnode.skymanager.view';

/** How often to ask the portal whether Skyrim is there. Only ever runs while
 *  at least one of our keys is on screen, and only repaints when the answer
 *  CHANGES — a key that silently lies about the game being up is worse than
 *  no key at all, but repainting 15 keys every 10 s for nothing is rude. */
const LIVE_POLL_MS = 10000;

let ws = null;
let pluginUUID = '';
let conf = { host: '127.0.0.1', port: 8090, token: '' };

/** context -> { action, settings }. One entry per key on screen. */
const keys = new Map();
/** Decoded key art, by entry id, so a repaint costs no HTTP. */
const art = new Map();
/** null = not asked yet, so the first paint does not flash "offline". */
let live = null;
let pollTimer = null;

/* ------------------------------ transport ----------------------------- */

function send(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

const base = () => 'http://' + (conf.host || '127.0.0.1') + ':' + (conf.port || 8090);
const authHeaders = () => ({ 'Content-Type': 'application/json', 'X-SkyManager-Token': conf.token || '' });

async function post(path, body) {
  const r = await fetch(base() + path, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({ ok: false, error: 'The portal sent something unreadable.' }));
}

/* ------------------------------ key art ------------------------------- */

/* The key is drawn here rather than shipped as a PNG per state, because what
 * belongs on it is the icon the player chose for that hotkey inside the deck.
 * Stream Deck draws the TITLE itself (the manifest leaves titles on), so this
 * canvas deliberately carries no text: the player keeps the normal Stream Deck
 * font controls, and we only seed the title once, when they pick an entry. */
function drawKey(img, opts) {
  const S = 144;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');

  const plate = g.createLinearGradient(0, 0, 0, S);
  plate.addColorStop(0, '#1b1d19');
  plate.addColorStop(1, '#0d0e0c');
  g.fillStyle = plate;
  g.fillRect(0, 0, S, S);

  // A thin gold rule, the deck's own accent, so a SkyManager key reads as one
  // at a glance on a board full of other plugins' keys.
  g.strokeStyle = opts.accent || '#c8a763';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, S - 3, S - 3);

  if (img) {
    // Fit inside the rule with room under it for the Stream Deck title.
    const box = 84;
    const scale = Math.min(box / img.width, box / img.height);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    g.globalAlpha = opts.live === false ? 0.35 : 1;
    g.drawImage(img, Math.round((S - w) / 2), Math.round((S - h) / 2) - 10, w, h);
    g.globalAlpha = 1;
  } else {
    // No art on the entry: a gold ring, so the key still looks deliberate.
    g.globalAlpha = opts.live === false ? 0.35 : 1;
    g.strokeStyle = '#c8a763';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(S / 2, S / 2 - 10, 30, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
  }

  // Offline is stated, not implied by a dim icon alone.
  if (opts.live === false) {
    g.fillStyle = '#c0392b';
    g.beginPath();
    g.arc(S - 18, 18, 7, 0, Math.PI * 2);
    g.fill();
  }
  return c.toDataURL('image/png');
}

/** Fetch an entry's art once and keep the decoded image. A missing icon is
 *  cached as `false` so a key with no art does not re-ask on every repaint. */
function loadArt(entryId) {
  if (art.has(entryId)) return Promise.resolve(art.get(entryId));
  return fetch(base() + '/api/streamdeck/icon?id=' + encodeURIComponent(entryId), { headers: authHeaders() })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => new Promise((resolve) => {
      if (!b) { art.set(entryId, false); resolve(false); return; }
      const img = new Image();
      const url = URL.createObjectURL(b);
      img.onload = () => { URL.revokeObjectURL(url); art.set(entryId, img); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); art.set(entryId, false); resolve(false); };
      img.src = url;
    }))
    .catch(() => { art.set(entryId, false); return false; });
}

async function paint(context) {
  const k = keys.get(context);
  if (!k) return;
  const isView = k.action === ACT_VIEW;
  const id = k.settings && k.settings.entryId;
  const img = (!isView && id) ? await loadArt(id) : null;
  send({ event: 'setImage', context,
    payload: { image: drawKey(img || null, { live, accent: isView ? '#8fb2c8' : '#c8a763' }), target: 0 } });
}

const paintAll = () => keys.forEach((_v, context) => paint(context));

/* ---------------------------- liveness -------------------------------- */

async function pollLive() {
  let now = false;
  try {
    const r = await fetch(base() + '/api/streamdeck', { headers: authHeaders() });
    const b = await r.json();
    now = !!(b && b.live);
  } catch (_) { now = false; }      // no portal at all reads the same as no game
  if (now !== live) { live = now; paintAll(); }
}

function schedulePoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!keys.size) return;
  pollLive();
  pollTimer = setInterval(pollLive, LIVE_POLL_MS);
}

/* ------------------------------ presses ------------------------------- */

async function press(context) {
  const k = keys.get(context);
  if (!k) return;
  const s = k.settings || {};
  let r;
  try {
    r = k.action === ACT_VIEW
      ? await post('/api/streamdeck/view', { op: s.op || 'toggle' })
      : await post('/api/streamdeck/run', { id: s.entryId || '' });
  } catch (_) {
    r = { ok: false, live: false, error: 'The Deck Portal is not answering on ' + base() + '.' };
  }
  if (r && r.ok) {
    send({ event: 'showOk', context });
    if (live !== true) { live = true; paintAll(); }
  } else {
    send({ event: 'showAlert', context });
    if (r && r.live === false && live !== false) { live = false; paintAll(); }
  }
  // The inspector, if it is open, shows what happened in words — showAlert is
  // only ever a red X and the player deserves the reason.
  send({ event: 'sendToPropertyInspector', context, action: k.action,
    payload: { event: 'pressResult', ok: !!(r && r.ok), error: (r && r.error) || '', name: (r && r.name) || '' } });
}

/* ------------------------------ events -------------------------------- */

function onMessage(msg) {
  const { event, context, action, payload } = msg;

  if (event === 'didReceiveGlobalSettings') {
    const g = (payload && payload.settings) || {};
    conf = {
      host: g.host || '127.0.0.1',
      port: Number(g.port) || 8090,
      token: g.token || '',
    };
    art.clear();                       // a new host or code means new art
    live = null;
    schedulePoll();
    paintAll();
    return;
  }

  if (event === 'willAppear') {
    keys.set(context, { action, settings: (payload && payload.settings) || {} });
    paint(context);
    schedulePoll();
    return;
  }

  if (event === 'willDisappear') {
    keys.delete(context);
    schedulePoll();
    return;
  }

  if (event === 'didReceiveSettings') {
    const k = keys.get(context) || { action };
    const before = (k.settings && k.settings.entryId) || '';
    k.settings = (payload && payload.settings) || {};
    k.action = action;
    keys.set(context, k);
    // Seed the Stream Deck title the first time an entry is chosen, then never
    // again: from that moment the title is the player's to edit in the normal
    // place, and a plugin that keeps overwriting it is a plugin people fight.
    if (k.settings.entryId && k.settings.entryId !== before && k.settings.entryName) {
      send({ event: 'setTitle', context, payload: { title: String(k.settings.entryName).slice(0, 28), target: 0 } });
    }
    paint(context);
    return;
  }

  if (event === 'keyUp') { press(context); return; }

  if (event === 'propertyInspectorDidAppear') {
    // Hand the inspector the connection up front so it can list entries
    // without waiting for its own global-settings round trip.
    send({ event: 'sendToPropertyInspector', context, action, payload: { event: 'conf', conf } });
    return;
  }

  if (event === 'sendToPlugin') {
    const p = payload || {};
    if (p.event === 'saveConf') {
      conf = { host: p.host || '127.0.0.1', port: Number(p.port) || 8090, token: p.token || '' };
      send({ event: 'setGlobalSettings', context: pluginUUID, payload: conf });
      art.clear();
      live = null;
      schedulePoll();
      paintAll();
    }
  }
}

/* eslint-disable-next-line no-unused-vars -- Stream Deck calls this by name */
function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent) {
  pluginUUID = inUUID;
  ws = new WebSocket('ws://127.0.0.1:' + inPort);
  ws.onopen = () => {
    send({ event: inRegisterEvent, uuid: inUUID });
    send({ event: 'getGlobalSettings', context: inUUID });
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    try { onMessage(msg); } catch (err) {
      // One bad event must never take the whole plugin down with it.
      console.error('SkyManager plugin: ' + (err && err.message));
    }
  };
}

if (typeof window !== 'undefined') window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
