/* ====================================================================== *
 *  Deck Portal — endpoint suite.
 *
 *      node portal/tests/endpoints.test.js          (exits 0 pass / 1 fail)
 *
 *  Runs the REAL server.js against a throwaway MO2-shaped tree in the OS
 *  temp dir, so it needs no game, no rig, and no network. Every path the
 *  server touches is redirected through DECK_PORTAL_* env vars.
 *
 *  Two invariants it exists to defend, asserted at the very end by md5:
 *  the portal must NEVER write `hotkeys.json` and must NEVER write
 *  `FollowerOrganizer.json` — the game owns both while it runs, and a write
 *  underneath it is silently discarded (or worse, clobbers the roster).
 *  Everything the phone changes goes into a sidecar the deck replays.
 *
 *  ⚠ This suite lived in /tmp for its whole first life and was rewritten
 *  from scratch more than once because it died with its container. It is in
 *  the repo now. Keep it here, and extend it when you add an endpoint.
 *
 *  PORT: ephemeral by default — this workspace routinely has 20+ concurrent
 *  Claude sessions and a hardcoded port makes the suite fail for reasons
 *  that have nothing to do with the code. Override with PORT=nnnn only when
 *  you need to poke the fixture server by hand.
 * ====================================================================== */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'),
      crypto = require('crypto'), net = require('net');

/* Ask the OS for a free port, then hand it straight over. listen() is
   ASYNC — address() is null until the 'listening' event, so this cannot be
   a plain sync helper and the server spawn has to wait on it. There is a
   benign race in the gap between close and re-bind; acceptable, versus a
   fixed port that collides with a sibling session every single run. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
let PORT = Number(process.env.PORT) || 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-'));
const mod = path.join(root, 'mods', 'SkyManager Source');
const deckView = path.join(mod, 'PrismaUI', 'views', 'HotkeyDeck');
const skse = path.join(mod, 'SKSE', 'Plugins', 'HotkeyDeck');
fs.mkdirSync(path.join(deckView, 'icons', 'custom'), { recursive: true });
fs.mkdirSync(path.join(mod, 'PrismaUI', 'views', 'MagicDeck', 'icons', 'custom'), { recursive: true });
fs.mkdirSync(skse, { recursive: true });
fs.mkdirSync(path.join(root, 'overwrite'), { recursive: true });

const HK = path.join(skse, 'hotkeys.json');
fs.writeFileSync(HK, JSON.stringify({
  entries: [], wardrobe: {
    categories: [{ id: 'c1', name: 'Evening', hue: 38 }],
    outfitMeta: [{ name: 'Sfancy Blue', image: '', note: '', categoryIds: ['c1'], fav: false }],
    wardrobes: [{ id: 'w1', name: 'Evening Wear', hue: 38, note: '', outfits: ['Sfancy Blue'] }],
    assignments: [{ formId: '0x1A6A1', plugin: 'Skyrim.esm', name: 'Camilla', mode: 'wardrobe',
      wardrobeId: 'w1', outfit: '', cadenceHours: 12, locationOverrides: [], lastRollDay: 0, lastOutfit: '' }],
    settings: { enabled: true, notify: true } },
}, null, 2));

// FollowerOrganizer.json — the roster the portal reads (never writes).
const FO = path.join(root, 'FollowerOrganizer.json');
fs.writeFileSync(FO, JSON.stringify({
  categories: [
    { index: 0, name: 'None', members: [] },
    { index: 1, name: 'Wives', members: [
      { Name: 'Camilla', OriginalName: 'Camilla Valerius', Description: '', Form: 'Skyrim.esm|0x1A6A1' },
      { Name: '', OriginalName: 'Lydia', Description: '', Form: 'Skyrim.esm|0xA2C94' },
      { Name: '', OriginalName: 'Ysolda', Description: '', Form: 'Skyrim.esm|0x1A69A' },
    ] },
  ],
}, null, 2));

// What the plugin exports (MhiyhControl::WriteStatusJson).
const STATUS = path.join(deckView, 'mhiyh-status.json');
const STATUS_BODY = {
  version: 1, mhiyh: true, at: Date.now(), ttlMs: 120000,
  npcs: [
    { original: 'Camilla Valerius', name: 'Camilla', formId: '0x0001A6A1', following: true, inWorld: true,
      dead: false, home: 'Riverwood Trader', flagged: true,
      acts: [
        { k: 0, place: 'Riverwood Trader', now: true },
        { k: 1, place: 'Riverwood Trader', now: false },
        { k: 2, place: 'Riverwood Lumber Mill', now: true },
        { k: 7, place: '', now: false },
      ] },
    { original: 'Lydia', name: 'Lydia', formId: '0x000A2C94', following: true, inWorld: true,
      dead: false, home: '', flagged: false, acts: [] },
    { original: 'Ysolda', name: 'Ysolda', formId: '0x0001A69A', following: false, inWorld: true,
      dead: false, home: '', flagged: false, acts: [] },
  ],
};
fs.writeFileSync(STATUS, JSON.stringify(STATUS_BODY, null, 2));

const SIDECAR = path.join(deckView, 'portal-mhiyh.json');
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const hkMd5 = md5(HK), foMd5 = md5(FO);
/* The exact bytes, so the one block that SIMULATES the game writing this file
   (the category-glyph checks) can put it back and leave the md5 invariant at
   the end meaning what it says. */
const hkOriginal = fs.readFileSync(HK);

/* Resolved from THIS file, never an absolute path: the repo lives at a
   different place on the rig than in a Conduit container, and an absolute
   path is how this suite silently tests nothing. */
const SERVER = path.resolve(__dirname, '..', 'server.js');
if (!fs.existsSync(SERVER)) { console.log('no server.js at ' + SERVER); process.exit(1); }

let srv = null;
let out = '';
function startServer() {
  srv = cp.spawn(process.execPath, [SERVER], {
    env: { ...process.env, DECK_PORTAL_MOD_HD: mod, DECK_PORTAL_MO_OVERWRITE: path.join(root, 'overwrite'),
      DECK_PORTAL_PORT: String(PORT), DECK_PORTAL_BIND: '127.0.0.1', DECK_PORTAL_HK_JSON: HK,
      DECK_PORTAL_FO_JSON: FO },
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
}

/* ONE exit path, so no route out of this file leaves an orphan node process
   listening or a fixture tree behind. The original leaked both on every
   failure branch, which is how a container ends up with stray `node
   server.js` processes nobody can account for. */
let dead = false;
function die(code) {
  if (dead) return;
  dead = true;
  try { if (srv) srv.kill(); } catch (_) {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
}
process.on('SIGINT', () => die(1));
process.on('SIGTERM', () => die(1));
process.on('uncaughtException', (e) => { console.log('UNCAUGHT: ' + (e && e.stack || e)); die(1); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const j = async (m, p, b) => {
  const r = await fetch('http://127.0.0.1:' + PORT + p, { method: m,
    headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};

(async () => {
  if (!PORT) PORT = await freePort();
  startServer();

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch('http://127.0.0.1:' + PORT + '/api/health'); up = true; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!up) { console.log('SERVER NEVER CAME UP on port ' + PORT + ':\n' + out); die(1); }
  const R = []; const T = (n, c) => R.push({ n, pass: !!c });
  let r;

  /* ================= existing wardrobe endpoint checks (18) ============ */
  r = await j('GET', '/api/wardrobe');
  T('GET /api/wardrobe 200', r.s === 200 && r.b.ok);
  T('reads the persisted slice', r.b.wardrobes.length === 1 && r.b.wardrobes[0].name === 'Evening Wear');
  T('reads assignments', r.b.assignments.length === 1 && r.b.assignments[0].cadenceHours === 12);
  r = await j('POST', '/api/wardrobe', { op: 'set', target: 'assign', formId: '0x1A6A1', plugin: 'Skyrim.esm', key: 'cadenceHours', value: '24' });
  T('queue cadence set', r.s === 200 && r.b.pendingWardrobe === 1);
  r = await j('GET', '/api/wardrobe');
  T('pending cadence folds into the view', r.b.assignments[0].cadenceHours === 24 && r.b.assignments[0].pending === true);
  r = await j('POST', '/api/wardrobe', { op: 'set', target: 'assign', formId: '0x1A6A1', plugin: 'Skyrim.esm', key: 'cadenceHours', value: '48' });
  T('re-setting the same key dedupes', r.b.pendingWardrobe === 1);
  await j('POST', '/api/wardrobe', { op: 'set', target: 'assign', formId: '0x1A6A1', plugin: 'Skyrim.esm', key: 'cadenceHours', value: '99999' });
  r = await j('GET', '/api/wardrobe');
  T('cadence is clamped to the C++ max', r.b.assignments[0].cadenceHours === 720);
  r = await j('POST', '/api/wardrobe', { op: 'set', target: 'assign', formId: '0x1A6A1', plugin: 'Skyrim.esm', key: 'mode', value: 'banana' });
  T('bad mode rejected', r.s === 400);
  r = await j('POST', '/api/wardrobe', { op: 'set', target: 'outfit', name: 'Sfancy Blue', key: 'evil', value: 'x' });
  T('unknown key rejected', r.s === 400);
  await j('POST', '/api/wardrobe', { op: 'pool', id: 'w1', add: 'Cosplay Gala' });
  r = await j('GET', '/api/wardrobe');
  T('pool add folds in', r.b.wardrobes[0].outfits.length === 2 && r.b.wardrobes[0].pending === true);
  await j('POST', '/api/wardrobe', { op: 'pool', id: 'w1', remove: 'Sfancy Blue' });
  r = await j('GET', '/api/wardrobe');
  T('pool remove folds in', r.b.wardrobes[0].outfits.join() === 'Cosplay Gala');
  r = await j('POST', '/api/wardrobe', { op: 'pool', id: 'w1' });
  T('pool with neither add nor remove rejected', r.s === 400);
  r = await j('POST', '/api/wardrobe-image', { outfit: 'Sfancy Blue', ext: 'png', dataBase64: PNG.toString('base64') });
  T('image upload 200', r.s === 200 && r.b.ok);
  T('image auto-queues onto the outfit', r.b.queued === true && /^icons\/custom\//.test(r.b.icon));
  const iconPath = r.b.icon;
  r = await j('GET', '/api/wardrobe');
  const meta = r.b.outfitMeta.find((x) => x.name === 'Sfancy Blue');
  T('image folds into outfit metadata', meta && meta.image === iconPath && meta.pending === true);
  r = await j('POST', '/api/wardrobe-image', { outfit: 'X', ext: 'png', dataBase64: Buffer.from('not an image').toString('base64') });
  T('non-image bytes rejected', r.s === 400);
  r = await j('POST', '/api/wardrobe-image', { outfit: 'Y', ext: 'exe', dataBase64: PNG.toString('base64') });
  T('bad extension rejected', r.s === 400);
  const wdSide = JSON.parse(fs.readFileSync(path.join(deckView, 'portal-wardrobe.json'), 'utf8'));
  T('wardrobe sidecar has version 1 + ops array', wdSide.version === 1 && Array.isArray(wdSide.ops));

  /* ===================== NEW: My Home is Your Home ===================== */
  r = await j('GET', '/api/mhiyh');
  T('GET /api/mhiyh 200 + ok', r.s === 200 && r.b.ok === true);
  T('reads the plugin export', r.b.statusOk === true && r.b.installed === true && r.b.npcs.length === 3);
  T('carries the kind spec + ttl', Array.isArray(r.b.kinds) && r.b.kinds.length === 8 &&
    r.b.ttlMs === 120000 && r.b.settable.join() === '1,2,3,4,5,6');
  const cam = r.b.npcs.find((n) => n.original === 'Camilla Valerius');
  T('a day comes through whole', cam && cam.home === 'Riverwood Trader' && cam.acts.length === 4 &&
    cam.now.join() === '0,2' && cam.following === true);

  /* --- the gates (each is a rule of MHiYH's own, reproduced) --- */
  r = await j('POST', '/api/mhiyh', { op: 'banana', original: 'Lydia' });
  T('unknown op rejected', r.s === 400);
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Nobody At All', kind: 2 });
  T('unknown follower 404s', r.s === 404);
  r = await j('POST', '/api/mhiyh', { op: 'setSpot', original: 'Lydia', kind: 2 });
  T('a stop is refused until she has a home', r.s === 409 && /home first/i.test(r.b.error || ''));
  r = await j('POST', '/api/mhiyh', { op: 'setHome', original: 'Ysolda' });
  T('setHome refused when she is not following', r.s === 409 && /following/i.test(r.b.error || ''));
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 0 });
  T('kind 0 refused — the home is its own action', r.s === 400 && /own action/i.test(r.b.error || ''));
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 7 });
  T('kind 7 refused — Watch shares the guard post', r.s === 400 && /guard post/i.test(r.b.error || ''));
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 3 });
  T('clearing a stop she has not got is refused', r.s === 409);
  r = await j('POST', '/api/mhiyh', { op: 'forgetHome', original: 'Camilla Valerius' });
  T('forgetHome without confirm is refused', r.s === 400 && /confirm/i.test(r.b.error || ''));
  r = await j('POST', '/api/mhiyh', { op: 'forgetHome', original: 'Lydia', confirm: true });
  T('forgetHome refused when she has no home', r.s === 409);

  /* --- THE positional guard: no live game, no marking the player's feet --- */
  r = await j('POST', '/api/mhiyh', { op: 'setHome', original: 'Lydia' });
  T('positional setHome refused while the game is down', r.s === 409 && /standing/i.test(r.b.error || ''));
  T('…and nothing was queued by it', !fs.existsSync(SIDECAR));
  r = await j('POST', '/api/mhiyh', { op: 'setSpot', original: 'Camilla Valerius', kind: 1 });
  T('positional setSpot refused too', r.s === 409 && /answering/i.test(r.b.error || ''));

  /* --- the two ops a phone may always queue --- */
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 2 });
  T('clearSpot queues', r.s === 200 && r.b.pendingMhiyh === 1 && r.b.positional === false);
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 2 });
  T('the same stop twice dedupes', r.s === 200 && r.b.pendingMhiyh === 1);
  r = await j('POST', '/api/mhiyh', { op: 'forgetHome', original: 'Camilla Valerius', confirm: true });
  T('forgetHome queues alongside it', r.s === 200 && r.b.pendingMhiyh === 2);

  let side = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
  T('sidecar is version 1 + ops array', side.version === 1 && Array.isArray(side.ops));
  const home = side.ops.find((o) => o.op === 'forgetHome');
  T('a home op carries NO kind', home && !('kind' in home));
  T('every op is stamped with `at`', side.ops.every((o) => typeof o.at === 'number' && o.at > 0));
  T('ops are keyed by ORIGINAL name', side.ops.every((o) => o.original === 'Camilla Valerius'));

  r = await j('GET', '/api/mhiyh');
  const cam2 = r.b.npcs.find((n) => n.original === 'Camilla Valerius');
  T('the queue folds onto her row', cam2 && cam2.pending.length === 2 && r.b.pending === 2);

  /* --- the undo --- */
  r = await j('POST', '/api/mhiyh-revert', { original: 'Camilla Valerius', kind: 2 });
  T('revert drops one stop', r.s === 200 && r.b.dropped === 1 && r.b.pendingMhiyh === 1);
  r = await j('POST', '/api/mhiyh-revert', { original: 'Camilla Valerius' });
  T('revert with no kind drops the rest', r.s === 200 && r.b.dropped === 1 && r.b.pendingMhiyh === 0);
  r = await j('POST', '/api/mhiyh-revert', { kind: 2 });
  T('revert needs a name', r.s === 400);

  /* --- home ops collapse onto each other (they answer one question) --- */
  await j('POST', '/api/mhiyh', { op: 'forgetHome', original: 'Camilla Valerius', confirm: true });
  await j('POST', '/api/mhiyh', { op: 'forgetHome', original: 'Camilla Valerius', confirm: true });
  side = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'));
  T('two home decisions collapse to one op', side.ops.filter((o) => o.op === 'forgetHome').length === 1);

  /* --- an op for someone the export forgot surfaces rather than vanishing --- */
  fs.writeFileSync(SIDECAR, JSON.stringify({ version: 1, ops: [
    { op: 'clearSpot', original: 'Ghost Person', kind: 2, at: Date.now() },
  ] }, null, 2));
  r = await j('GET', '/api/mhiyh');
  T('a queued op for an unknown name is surfaced', r.b.pendingUnknown.join() === 'Ghost Person');

  /* --- a hand-written sidecar is sanitised, not trusted --- */
  fs.writeFileSync(SIDECAR, JSON.stringify({ version: 1, ops: [
    { op: 'clearSpot', original: 'Camilla Valerius', kind: 0, at: 1 },     // kind 0 is not settable
    { op: 'clearSpot', original: 'Camilla Valerius', kind: 7, at: 1 },     // nor is Watch
    { op: 'nonsense', original: 'Camilla Valerius', at: 1 },
    { op: 'setHome', original: '', at: 1 },
    { op: 'setSpot', original: 'Camilla Valerius', kind: 4, at: 1 },
  ] }, null, 2));
  r = await j('GET', '/api/mhiyh');
  T('unusable hand-written ops are dropped on read', r.b.pending === 1 && !r.b.malformed);
  fs.writeFileSync(SIDECAR, '{ not json');
  r = await j('GET', '/api/mhiyh');
  T('a malformed sidecar reads as empty + flagged', r.b.pending === 0 && r.b.malformed === true);
  fs.unlinkSync(SIDECAR);

  /* --- health reports the whole pipe --- */
  r = await j('GET', '/api/health');
  T('health carries the mhiyh block', r.s === 200 && r.b.mhiyh && r.b.mhiyh.installed === true &&
    r.b.mhiyh.npcs === 3 && r.b.mhiyh.withHome === 1 && Array.isArray(r.b.mhiyh.statusCandidates));

  /* --- no export at all: honest, and nothing queueable --- */
  fs.renameSync(STATUS, STATUS + '.bak');
  r = await j('GET', '/api/mhiyh');
  T('no export = statusOk false, empty list', r.b.statusOk === false && r.b.npcs.length === 0);
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 2 });
  T('nothing can be queued without an export', r.s === 409 && /Followers tab/i.test(r.b.error || ''));
  fs.renameSync(STATUS + '.bak', STATUS);

  /* --- mod absent is NOT the same as no export --- */
  fs.writeFileSync(STATUS, JSON.stringify(Object.assign({}, STATUS_BODY, { mhiyh: false, npcs: [] })));
  r = await j('GET', '/api/mhiyh');
  T('mod absent reads installed:false, statusOk:true', r.b.installed === false && r.b.statusOk === true);
  r = await j('POST', '/api/mhiyh', { op: 'clearSpot', original: 'Camilla Valerius', kind: 2 });
  T('nothing queueable when the mod is missing', r.s === 409 && /load order/i.test(r.b.error || ''));
  fs.writeFileSync(STATUS, JSON.stringify(STATUS_BODY, null, 2));

  /* ================= Dragon Roost: the `spin` op =================== *
   *  Eight frames of one subject, 45° apart, so the phone's lightbox can be
   *  dragged around the animal. It is the only op that names a FAMILY and a
   *  MEMBER at once, and the only one whose key may be either a durable form
   *  key or a bare dragon id — so both halves get asserted, along with the
   *  dedupe rule that makes eight frames one queued job however many times
   *  somebody drags the picture.
   *
   *  No status file is needed: queueing writes the queue, and the queue is
   *  the whole contract with the game. */
  r = await j('POST', '/api/roost', { op: 'spin', what: 'species', key: 'DragonRoost.esp|0x00080A' });
  T('spin: species + form key is accepted', r.s === 200 && r.b.ok === true &&
    r.b.queued.op === 'spin' && r.b.queued.what === 'species' && r.b.queued.key === 'DragonRoost.esp|0x00080A');
  r = await j('POST', '/api/roost', { op: 'spin', what: 'dragons', key: 12 });
  T('spin: a dragon id arrives as a NUMBER and is kept as text', r.s === 200 && r.b.queued.key === '12');
  const spinN = r.b.pending;
  r = await j('POST', '/api/roost', { op: 'spin', what: 'dragons', key: '12' });
  T('spin: the same subject twice is ONE job', r.b.pending === spinN);
  r = await j('POST', '/api/roost', { op: 'spin', what: 'species', key: 'dragonroost.esp|0x80A' });
  T('spin: a second SPELLING of one species key folds together (CanonKey)', r.b.pending === spinN);
  r = await j('POST', '/api/roost', { op: 'spin', what: 'skins', key: 'DragonRoost.esp|0x00080A' });
  T('spin: the same key under a different `what` is its own job', r.b.pending === spinN + 1);
  r = await j('POST', '/api/roost', { op: 'render', species: 'DragonRoost.esp|0x00080A' });
  T('spin never displaces the plain render of the same subject', r.b.pending === spinN + 2);
  for (const bad of [
    { op: 'spin', what: 'species' },                          // no subject
    { op: 'spin', key: 'A.esp|0x1' },                         // no family
    { op: 'spin', what: 'eggs', key: 'A.esp|0x1' },           // outside the vocabulary
    { op: 'spin', what: 'species', key: 'not a key' },
    { op: 'spin', what: 'species', key: '../../etc/passwd|0x1' },
    { op: 'spin', what: 'dragons', key: '0' },
    { op: 'spin', what: 'dragons', key: { id: 4 } },
  ]) {
    r = await j('POST', '/api/roost', bad);
    T('spin refuses ' + JSON.stringify(bad).slice(0, 58), r.s === 400);
  }
  r = await j('POST', '/api/roost', { op: 'spin', what: 'species' });
  T('the refusal names both fields', /what/.test(r.b.error || '') && /key/.test(r.b.error || ''));
  r = await j('GET', '/api/roost');
  const spins = r.b.ops.filter((o) => (o.kind || o.op) === 'spin');
  T('spins survive a re-read of the queue file', spins.length === spinN + 1 &&
    spins.every((o) => o.op === 'spin' && o.what && o.key && o.kind === undefined));
  r = await j('GET', '/api/health');
  T('health advertises spin among the roost ops', JSON.stringify(r.b).indexOf('"spin"') >= 0);
  await j('POST', '/api/roost-clear', {});

  /* ================= follower delete from the phone ==================== */
  r = await j('POST', '/api/fo-op', { type: 'delete', original: 'Camilla Valerius' });
  T('a delete without confirm is refused', r.s === 400 && /confirm/i.test(r.b.error || ''));
  r = await j('POST', '/api/fo-op', { type: 'delete', original: 'Nobody At All', confirm: true });
  T('a delete for someone not on the roster is refused', r.s >= 400);
  r = await j('POST', '/api/fo-op', { type: 'delete', original: 'Camilla Valerius', confirm: true });
  T('a confirmed delete queues', r.s === 200 && r.b.ok === true && r.b.type === 'delete');
  r = await j('GET', '/api/fo-ops');
  T('the queued op is a delete keyed by ORIGINAL name',
    (r.b.ops || []).some((o) => o.type === 'delete' && o.original === 'Camilla Valerius'));
  r = await j('GET', '/api/roster');
  (function () {
    let hit = null;
    for (const c of (r.b.categories || [])) for (const m of (c.members || []))
      if (m.original === 'Camilla Valerius') hit = m;
    T('she is STILL listed, flagged pendingDelete (not hidden early)', !!hit && hit.pendingDelete === true);
  })();
  // a move and a delete for one person are contradictory: last write wins
  r = await j('POST', '/api/fo-op', { type: 'move', original: 'Camilla Valerius', toCat: 1 });
  r = await j('GET', '/api/fo-ops');
  T('a later move supersedes the queued delete for the same person',
    !(r.b.ops || []).some((o) => o.type === 'delete' && o.original === 'Camilla Valerius') &&
     (r.b.ops || []).some((o) => o.type === 'move' && o.original === 'Camilla Valerius'));
  r = await j('POST', '/api/fo-op', { type: 'delete', original: 'Camilla Valerius', confirm: true });
  r = await j('GET', '/api/fo-ops');
  T('…and a later delete supersedes the queued move',
    !(r.b.ops || []).some((o) => o.type === 'move' && o.original === 'Camilla Valerius') &&
     (r.b.ops || []).some((o) => o.type === 'delete' && o.original === 'Camilla Valerius'));
  await j('DELETE', '/api/fo-op', { type: 'move', original: 'Camilla Valerius' });

  /* ================= the note (FO Description) from the phone =========== */
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Nobody At All', desc: 'x' });
  T('a note for someone not on the roster is refused', r.s >= 400);
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Lydia', desc: 'Housecarl, loyal' });
  T('a note queues', r.s === 200 && r.b.ok === true && r.b.desc === 'Housecarl, loyal');
  r = await j('GET', '/api/roster');
  (function () {
    let hit = null;
    for (const c of (r.b.categories || [])) for (const m of (c.members || []))
      if (m.original === 'Lydia') hit = m;
    T('the queued note comes back on the member, so the sheet shows what you typed',
      !!hit && hit.pendingDesc === 'Housecarl, loyal');
  })();
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Lydia', desc: 'Changed my mind' });
  r = await j('GET', '/api/fo-ops');
  T('a second note for the same person REPLACES the first, never stacks',
    (r.b.ops || []).filter((o) => o.type === 'setDesc' && o.original === 'Lydia').length === 1 &&
    (r.b.ops || []).some((o) => o.type === 'setDesc' && o.desc === 'Changed my mind'));
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Lydia', desc: '' });
  T('an empty note is legal — it clears it', r.s === 200 && r.b.ok === true && r.b.desc === '');
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Lydia', desc: 'x'.repeat(400) });
  T('an over-long note is refused with the limit named',
    r.s === 400 && /300/.test(r.b.error || ''));
  r = await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Lydia', desc: 42 });
  T('a non-string note is refused', r.s === 400);
  // a note and a delete are INDEPENDENT — queuing one must not drop the other
  await j('POST', '/api/fo-op', { type: 'setDesc', original: 'Ysolda', desc: 'Merchant' });
  await j('POST', '/api/fo-op', { type: 'delete', original: 'Ysolda', confirm: true });
  r = await j('GET', '/api/fo-ops');
  T('a delete does not clobber a queued note for the same person',
    (r.b.ops || []).some((o) => o.type === 'setDesc' && o.original === 'Ysolda') &&
    (r.b.ops || []).some((o) => o.type === 'delete' && o.original === 'Ysolda'));

  /* ============ category GLYPHS (portal-cat-icons.json) ================ *
   *  The phone's half of the deck's per-category rail icons. A CONFIG slice,
   *  not an FO op — so its own file, its own queue, and (unlike moves and
   *  renames) nothing here ever goes near FollowerOrganizer.json either.
   *
   *  The rules asserted are the ones the C++ consumer enforces, because a
   *  queued entry the game will silently skip is worse than a refusal: the
   *  slot must be a REAL category, the index must be inside FO's 0..25, and
   *  the path must be one the deck view can actually paint. */
  const CATSIDE = path.join(deckView, 'portal-cat-icons.json');
  // Art to assign: one pool upload gives us a real "icons/custom/…" path.
  r = await j('POST', '/api/icon', { name: 'cat glyph', ext: 'png', dataBase64: PNG.toString('base64') });
  T('cat: a pool icon exists to assign', r.s === 200 && r.b.ok === true);
  const catArt = 'icons/custom/' + r.b.name + '.' + r.b.ext;

  r = await j('POST', '/api/cat-icon', { cat: 1, icon: catArt });
  T('a glyph queues for a real slot', r.s === 200 && r.b.ok === true && r.b.cat === 1 &&
    r.b.catName === 'Wives' && r.b.icon === catArt && r.b.pendingCatIcons === 1);
  let cside = JSON.parse(fs.readFileSync(CATSIDE, 'utf8'));
  T('sidecar is version 1 + a `set` array keyed by SLOT', cside.version === 1 &&
    Array.isArray(cside.set) && cside.set.length === 1 && cside.set[0].cat === 1 &&
    cside.set[0].icon === catArt && !('name' in cside.set[0]));
  T('the art is mirrored into the DECK tree (it is what paints the rail)',
    fs.existsSync(path.join(deckView, 'icons', 'custom', path.basename(catArt))));

  r = await j('GET', '/api/roster');
  (function () {
    const c = (r.b.categories || []).find((x) => x.index === 1);
    T('the queue folds onto the category header', !!c && c.pendingIcon === catArt &&
      !!c.pendingIconUrl && r.b.pendingCatIcons === 1);
    T('…and nothing is invented for a category with no glyph',
      (r.b.categories || []).every((x) => x.index === 1 || x.pendingIcon === null));
  })();

  r = await j('POST', '/api/cat-icon', { cat: 1, icon: '' });
  T('a second glyph for the same slot REPLACES the first, never stacks',
    r.s === 200 && r.b.pendingCatIcons === 1);
  cside = JSON.parse(fs.readFileSync(CATSIDE, 'utf8'));
  T('"" is legal and means CLEAR', cside.set.length === 1 && cside.set[0].icon === '');

  r = await j('POST', '/api/cat-icon', { cat: 99, icon: catArt });
  T('a slot outside FO\'s 0–25 is refused with the range named',
    r.s === 400 && /25/.test(r.b.error || ''));
  r = await j('POST', '/api/cat-icon', { cat: 7, icon: catArt });
  T('a slot no category occupies is refused', r.s === 404);
  r = await j('POST', '/api/cat-icon', { cat: 1, icon: '../../../evil.png' });
  T('a path that could escape the view is refused', r.s === 400);
  r = await j('POST', '/api/cat-icon', { cat: 1, icon: 'icons/custom/never-uploaded.png' });
  T('art that is not on disk is refused (the rail would paint nothing)', r.s === 400);
  r = await j('POST', '/api/cat-icon', { cat: 1, icon: 42 });
  T('a non-string icon is refused', r.s === 400);

  r = await j('GET', '/api/cat-icons');
  T('GET lists the queue AND what the game has now',
    r.s === 200 && r.b.ok === true && r.b.pending === 1 && r.b.slotMax === 25 &&
    typeof r.b.live === 'object');

  // upload art FOR a category: one hop, file + assignment. (This fixture's
  // roster has exactly one real category, slot 1, so everything below uses it —
  // an upload for slot 2 would be refused for the right reason and prove
  // nothing about the upload path.)
  r = await j('POST', '/api/cat-icon-image', { cat: 1, ext: 'png', dataBase64: PNG.toString('base64') });
  T('uploading art for a category lands the file AND queues it',
    r.s === 200 && r.b.ok === true && r.b.cat === 1 && /^icons\/custom\//.test(r.b.icon) &&
    r.b.pendingCatIcons === 1);
  T('…named after the category, in both icon trees',
    /wives/i.test(r.b.name) &&
    fs.existsSync(path.join(deckView, 'icons', 'custom', path.basename(r.b.icon))) &&
    fs.existsSync(path.join(mod, 'PrismaUI', 'views', 'MagicDeck', 'icons', 'custom', path.basename(r.b.icon))));
  r = await j('POST', '/api/cat-icon-image', { cat: 1, ext: 'png', dataBase64: Buffer.from('not an image').toString('base64') });
  T('non-image bytes are refused', r.s === 400);
  r = await j('POST', '/api/cat-icon-image', { cat: 7, ext: 'png', dataBase64: PNG.toString('base64') });
  T('an upload for a slot no category occupies is refused BEFORE it writes', r.s === 404);

  r = await j('DELETE', '/api/cat-icon', { cat: 1 });
  T('one queued glyph can be dropped', r.s === 200 && r.b.cleared === 1 && r.b.pendingCatIcons === 0);
  r = await j('DELETE', '/api/cat-icon', { cat: 1 });
  T('dropping nothing says so rather than pretending', r.s === 404);

  // a hand-written queue is sanitised, not trusted
  fs.writeFileSync(CATSIDE, JSON.stringify({ version: 1, set: [
    { cat: 1, icon: catArt },
    { cat: 99, icon: catArt },          // outside FO's slots
    { cat: 'one', icon: catArt },       // not an index
    { icon: catArt },                   // no slot at all
    { cat: 1, icon: 'icons/custom/second.png' },   // later write for slot 1 wins
  ] }, null, 2));
  r = await j('GET', '/api/cat-icons');
  T('unusable hand-written entries are dropped on read, last per slot wins',
    r.b.pending === 1 && r.b.set[0].cat === 1 && r.b.set[0].icon === 'icons/custom/second.png');
  fs.writeFileSync(CATSIDE, '{ not json');
  r = await j('GET', '/api/cat-icons');
  T('a malformed queue reads as empty + flagged', r.b.pending === 0 && r.b.malformed === true);
  r = await j('GET', '/api/roster');
  T('…and a malformed queue never blanks the roster', r.b.ok === true && r.b.total >= 3);
  fs.writeFileSync(CATSIDE, JSON.stringify({ version: 1, set: [] }, null, 2));

  // what the GAME has set comes through, from hotkeys.json's followers slice
  (function () {
    const hkNow = JSON.parse(fs.readFileSync(HK, 'utf8'));
    hkNow.followers = { catIcons: { 1: catArt, 3: 'icons/custom/gone.png', 99: catArt, x: catArt } };
    fs.writeFileSync(HK, JSON.stringify(hkNow, null, 2));
  })();
  r = await j('GET', '/api/roster');
  (function () {
    const c = (r.b.categories || []).find((x) => x.index === 1);
    T('a glyph the deck already has is shown on the header',
      !!c && c.icon === catArt && !!c.iconUrl && c.iconKind === 'custom' && c.iconMissing === false);
  })();
  r = await j('GET', '/api/cat-icons');
  T('a bad slot / non-numeric key in the live map is ignored, not shown',
    Object.keys(r.b.live).join() === '1,3');
  r = await j('GET', '/api/health');
  T('health reports the glyph bridge', r.b.catIcons && r.b.catIcons.set === 2 &&
    r.b.catIcons.slotMax === 25 && r.b.catIcons.seeded === true);
  // Put hotkeys.json back byte-for-byte: the md5 invariant below is the point
  // of this whole suite, and this block is the only one that edits the file
  // (standing in for the GAME writing it, which is the only writer allowed).
  fs.writeFileSync(HK, hkOriginal);

  /* ============ the LIVE roster export beats FO's stale file ============ */
  (function () {
    const live = path.join(deckView, 'fo-roster.json');
    fs.writeFileSync(live, JSON.stringify({
      ok: true, at: Date.now(), source: 'live',
      categories: [{ index: 1, name: 'Wives', members: [
        { name: 'Lydia', original: 'Lydia', description: '', formId: '0x000A2C94' } ] }],
    }));
    // make it unambiguously newer than FollowerOrganizer.json
    const t = Date.now() / 1000 + 60;
    fs.utimesSync(live, t, t);
  })();
  r = await j('GET', '/api/roster');
  T('a FRESHER live export is preferred over FollowerOrganizer.json',
    r.b.live === true && (r.b.categories || []).some((c) =>
      (c.members || []).some((m) => m.original === 'Lydia')));
  T('…and the stale disk roster is not mixed in',
    !(r.b.categories || []).some((c) => (c.members || []).some((m) => m.original === 'Ysolda')));
  // a MALFORMED export must fall back, never blank the phone
  fs.writeFileSync(path.join(deckView, 'fo-roster.json'), '{ not json');
  r = await j('GET', '/api/roster');
  T('a malformed live export falls back to the disk roster', r.b.ok === true && r.b.total >= 3);
  fs.rmSync(path.join(deckView, 'fo-roster.json'), { force: true });
  r = await j('GET', '/api/roster');
  T('with no export at all it reads the disk roster as before',
    r.b.ok === true && r.b.live === false && r.b.total >= 3);

  /* ==================== NPC icon packs (export / inspect / import) =====
     The round-trip contract: what export produces, inspect must read back;
     what inspect stashes, import must land through the SAME portrait write
     path as a single upload (clear both authors, version-dodge, bridge). */
  const rawGet = async (pp) => {
    const rr = await fetch('http://127.0.0.1:' + PORT + pp);
    return { s: rr.status, ct: rr.headers.get('content-type') || '', cd: rr.headers.get('content-disposition') || '',
      buf: Buffer.from(await rr.arrayBuffer()) };
  };
  const rawPost = async (pp, buf) => {
    const rr = await fetch('http://127.0.0.1:' + PORT + pp, { method: 'POST',
      headers: { 'content-type': 'application/zip' }, body: buf });
    return { s: rr.status, b: await rr.json().catch(() => ({})) };
  };
  /* A minimal STORED-method zip builder — hand-made packs are first-class
     citizens of the format, so the suite makes one by hand too. */
  const crcT = (() => { const t = []; for (let n2 = 0; n2 < 256; n2++) { let c = n2;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n2] = c >>> 0; } return t; })();
  const crc = (b) => { let c = -1; for (let i2 = 0; i2 < b.length; i2++) c = crcT[(c ^ b[i2]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  function storeZip(files) {
    const locals = [], cens = []; let off = 0;
    for (const f of files) {
      const nm = Buffer.from(f.name, 'utf8'), c = crc(f.data);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
      lh.writeUInt32LE(c, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22);
      lh.writeUInt16LE(nm.length, 26);
      locals.push(lh, nm, f.data);
      const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt32LE(c, 16);
      ce.writeUInt32LE(f.data.length, 20); ce.writeUInt32LE(f.data.length, 24);
      ce.writeUInt16LE(nm.length, 28); ce.writeUInt32LE(off, 42);
      cens.push(Buffer.concat([ce, nm]));
      off += 30 + nm.length + f.data.length;
    }
    const cd = Buffer.concat(cens), eo = Buffer.alloc(22);
    eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10);
    eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
    return Buffer.concat(locals.concat([cd, eo]));
  }
  const PNG2 = Buffer.concat([PNG, Buffer.from([0x00])]);   // still sniffs as PNG, distinguishable bytes

  // Two portraits on disk to export.
  await j('POST', '/api/portrait', { slug: 'camilla', ext: 'png', dataBase64: PNG.toString('base64') });
  await j('POST', '/api/portrait', { slug: 'lydia', ext: 'png', dataBase64: PNG.toString('base64') });

  r = await rawGet('/api/npc-pack/export?name=Suite%20Pack');
  T('pack export answers a zip download', r.s === 200 && /application\/zip/.test(r.ct) &&
    /suite-pack/.test(r.cd) && r.buf.readUInt32LE(0) === 0x04034b50);
  const exported = r.buf;
  T('exported zip carries the manifest and both slugs',
    exported.includes('manifest.json') && exported.includes('camilla.png') && exported.includes('lydia.png'));
  r = await rawGet('/api/npc-pack/export?slugs=camilla&name=One');
  T('slugs= narrows the pack', r.s === 200 && r.buf.includes('camilla.png') && !r.buf.includes('lydia.png'));
  r = await rawGet('/api/npc-pack/export?slugs=nobody-here');
  T('export with no matching portrait is a 404, not an empty zip', r.s === 404);

  // Round-trip: our own export inspects as all-replacements.
  r = await rawPost('/api/npc-pack/inspect', exported);
  T('inspecting our own export works', r.s === 200 && r.b.ok && !!r.b.packId);
  T('…manifest read back', r.b.manifest && r.b.manifest.name === 'Suite Pack');
  T('…both faces listed as replacements (they exist here)',
    r.b.counts.total === 2 && r.b.counts.replace === 2 && r.b.counts.add === 0 &&
    r.b.entries.every((e2) => e2.status === 'replace' && e2.existingMtime > 0));
  // ("camilla" deliberately matches nobody — the fixture's Camilla slugs as
  //  camilla-valerius — so this also proves an unknown slug stays undecorated.)
  T('…roster names decorate known slugs', (r.b.entries.find((e2) => e2.slug === 'lydia') || {}).name === 'Lydia' &&
    (r.b.entries.find((e2) => e2.slug === 'camilla') || {}).name === '');

  // A hand-made pack: no manifest, display-name filename, a stray readme.
  const handZip = storeZip([
    { name: 'icons/Olfina Gray-Mane.PNG', data: PNG },
    { name: 'camilla.png', data: PNG2 },
    { name: 'readme.txt', data: Buffer.from('hello') },
    { name: 'broken.png', data: Buffer.from('not a png at all') },
  ]);
  r = await rawPost('/api/npc-pack/inspect', handZip);
  T('a manifest-less hand-made zip inspects fine', r.s === 200 && r.b.ok && r.b.counts.total === 2);
  const hand = r.b;
  const olf = hand.entries.find((e2) => e2.slug === 'olfina-gray-mane');
  T('display-name filename reduces to the slug, pathed + upper-case ext and all',
    !!olf && olf.status === 'add' && olf.inRoster === false);
  T('a non-image that was MEANT to be a picture is named in skipped',
    hand.skipped.some((s2) => s2.file === 'broken.png') && !hand.skipped.some((s2) => s2.file === 'readme.txt'));
  r = await rawGet('/api/npc-pack/file/' + hand.packId + '/olfina-gray-mane');
  T('stashed pack image previews before import', r.s === 200 && r.buf.equals(PNG));

  // Import only the new face — the replacement stays untouched.
  r = await j('POST', '/api/npc-pack/import', { packId: hand.packId, slugs: ['olfina-gray-mane'] });
  T('importing the toggled-on subset applies it', r.s === 200 && r.b.ok && r.b.applied === 1 &&
    r.b.results[0].slug === 'olfina-gray-mane' && r.b.queuedLive === 1);
  r = await rawGet('/api/portrait-file/olfina-gray-mane');
  T('…and the portrait is really on disk', r.s === 200 && r.buf.equals(PNG));
  r = await rawGet('/api/portrait-file/camilla');
  T('…while the unticked replacement kept the ORIGINAL bytes', r.s === 200 && r.buf.equals(PNG));

  // Flip the replacement on: same pack, second import call.
  r = await j('POST', '/api/npc-pack/import', { packId: hand.packId, slugs: ['camilla'] });
  T('a replacement imports when explicitly chosen', r.s === 200 && r.b.ok && r.b.applied === 1);
  r = await rawGet('/api/portrait-file/camilla');
  T('…and the bytes actually changed to the pack\'s', r.s === 200 && r.buf.equals(PNG2));
  const bridge = JSON.parse(fs.readFileSync(path.join(deckView, 'portal-portraits.json'), 'utf8'));
  T('imported faces ride the live plugin bridge like any upload',
    bridge.shots.some((s2) => s2.slug === 'camilla') && bridge.shots.some((s2) => s2.slug === 'olfina-gray-mane'));

  // Refusals that must be human sentences, not stack traces.
  r = await j('POST', '/api/npc-pack/import', { packId: 'deadbeef', slugs: ['x'] });
  T('an unknown/expired packId is a 410 with advice', r.s === 410);
  r = await j('POST', '/api/npc-pack/import', { packId: hand.packId, slugs: [] });
  T('an empty selection is refused', r.s === 400);
  r = await rawPost('/api/npc-pack/inspect', Buffer.from('this is not a zip file at all, sorry'));
  T('a non-zip upload is a 400 naming the problem', r.s === 400 && /ZIP/i.test(r.b.error || ''));
  r = await rawPost('/api/npc-pack/inspect', storeZip([{ name: 'readme.txt', data: Buffer.from('x') }]));
  T('a zip with no usable images says so', r.s === 400 && /usable images/i.test(r.b.error || ''));

  // Leave the portraits folder as the earlier sections expect nothing of it —
  // but do drop the extra face so a re-run starts clean.
  await j('DELETE', '/api/portrait/olfina-gray-mane');

  /* --- the invariant that matters most --- */
  T('hotkeys.json was never written', md5(HK) === hkMd5);
  T('FollowerOrganizer.json was never written', md5(FO) === foMd5);

  const p = R.filter((x) => x.pass).length;
  console.log('\nPORTAL ' + p + '/' + R.length);
  R.filter((x) => !x.pass).forEach((x) => console.log('  FAIL: ' + x.n));
  if (p !== R.length) console.log('\n--- server log ---\n' + out.slice(-2000));
  die(p === R.length ? 0 : 1);
})().catch((e) => { console.log('SUITE THREW: ' + (e && e.stack || e)); die(1); });
