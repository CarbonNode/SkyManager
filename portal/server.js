'use strict';

/* ======================================================================= *
 *  Deck Portal — upload follower portraits, Spell Deck icons and Hotkey
 *  icons from a phone or any PC on the LAN, WHILE Skyrim is running.
 *
 *  Zero dependencies: node stdlib only (http / fs / path). The rig has Node;
 *  `npm install` there is friction we don't need. Run it with:
 *      node server.js
 *
 *  Why this works mid-game: both write targets live INSIDE an existing MO2
 *  mod folder, and MO2's VFS passes newly-created files in an already-mounted
 *  mod dir straight through to the game. The Hotkey Deck C++ re-scans both
 *  folders on every palette open, so an upload shows up on the next deck open
 *  — no game restart, no DLL swap. (Same proven path as the v0.7.0 Spell Deck
 *  icons/custom folder.)
 *
 *  TRUST MODEL — LOOPBACK BY DEFAULT; LAN COSTS A PASSWORD.
 *
 *  This used to bind 0.0.0.0 with no login at all, on the reasoning that a
 *  password prompt on a phone defeats the point. That is defensible on your
 *  own LAN and indefensible in a mod other people install: anyone who could
 *  reach the port could upload images, rewrite deck config and edit NPC
 *  profiles, with no credential.
 *
 *  So the default is now 127.0.0.1 — reachable only from the machine running
 *  the game, which is exactly what the deck's Portal button needs. Nothing
 *  off-machine can call it, so there is nothing to authenticate and no
 *  password to prompt for.
 *
 *  Wanting it on a PHONE means binding wider, and that path REFUSES TO START
 *  without DECK_PORTAL_PASSWORD set (see resolveBind). The insecure
 *  combination — reachable from the network, no credential — is therefore not
 *  reachable by accident or by a copied config; it has to be chosen, and
 *  choosing it forces a password.
 *
 *  Still true regardless of bind:
 *    - Writes are hard-confined to PORTRAIT_DIR and ICON_DIR: the filename
 *      is rebuilt from a validated charset (no dots, no separators), the
 *      extension comes from a fixed allow-list, and the resolved absolute
 *      path is re-checked against the base dir before any write. Path
 *      traversal is rejected with 400, never followed.
 *    - Nothing here executes uploaded content; files are only written and
 *      served back with an explicit image/* content type.
 * ======================================================================= */

const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
/* Still zero dependencies — all three are node stdlib. zlib + crypto are what
 * the Dragon Roost thumbnailer is built out of (see drThumb): a 1024×1024
 * render is decoded, box-filtered and re-encoded here rather than shipped
 * whole to a phone, and os only names a temp dir to cache the result in. */
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');

/* ============================== CONFIG ================================= *
 *  Edit these three for the rig. Each also accepts an env override, which
 *  is how the headless test harness points them at temp dirs.
 * ======================================================================= */

const PORT = Number(process.env.DECK_PORTAL_PORT || 8090);

/* Loopback unless the operator deliberately widens it. See the trust model at
 * the top of this file: a wider bind is allowed, but only with a password. */
const BIND_DEFAULT = '127.0.0.1';
const PORTAL_PASSWORD = String(process.env.DECK_PORTAL_PASSWORD || '');

/* An address only this machine can reach. IPv6 loopback and the "::ffff:"
 * IPv4-mapped form both count — node reports the mapped form for a v4 client
 * on a dual-stack socket, and treating that as remote would lock out the
 * deck's own button. */
function isLoopbackAddr(a) {
  const s = String(a || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return s === '127.0.0.1' || s === '::1' || s === 'localhost' || /^127\./.test(s);
}

/* The bind the process will actually use, plus whether that bind is exposed.
 *
 * REFUSES rather than silently downgrading. A user who set BIND=0.0.0.0 wants
 * the phone; quietly binding loopback instead would look like a broken portal
 * and they would go hunting in the wrong place. An explicit, loud exit names
 * the one thing missing. */
function resolveBind() {
  const raw = String(process.env.DECK_PORTAL_BIND || BIND_DEFAULT).trim();
  const exposed = !isLoopbackAddr(raw);
  if (exposed && !PORTAL_PASSWORD) {
    console.error(
      '\n[Deck Portal] REFUSING TO START.\n' +
      '  DECK_PORTAL_BIND=' + raw + ' makes the portal reachable from other\n' +
      '  machines, and no DECK_PORTAL_PASSWORD is set — that would let anyone\n' +
      '  on the network upload images, rewrite deck config and edit NPC\n' +
      '  profiles with no credential at all.\n\n' +
      '  Either:\n' +
      '    * set DECK_PORTAL_PASSWORD=<something> to allow it, or\n' +
      '    * drop DECK_PORTAL_BIND to use 127.0.0.1 (this machine only),\n' +
      '      which needs no password.\n');
    process.exit(2);
  }
  return { bind: raw, exposed: exposed };
}

const { bind: BIND, exposed: EXPOSED } = resolveBind();

// WHERE THINGS ARE, derived from where THIS FILE is rather than hardcoded.
// The portal installs to  <mod>\\SKSE\\Plugins\\HotkeyDeck\\portal\\server.js,
// so the mod root is three levels up and Follower Organizer's roster sits two
// levels up beside the other SKSE plugin data. That works on any install, MO2
// or not, without the player configuring anything — and every one of them is
// still overridable by environment variable for an unusual layout.
//
// (These used to default to one machine's absolute paths, which meant the
// portal read nothing at all on anybody else's install.)
const HERE = __dirname;
const MOD_HD = process.env.DECK_PORTAL_MOD_HD ||
  path.resolve(HERE, '..', '..', '..');

const FO_JSON = process.env.DECK_PORTAL_FO_JSON ||
  path.resolve(HERE, '..', '..', 'FollowerOrganizer.json');

/* MO2's overwrite tree, and why it matters: MO2 hooks the game's file API, so
 * a file the PLUGIN creates at a virtual path (a captured portrait, a mirrored
 * icon) is written into `overwrite`, not into the mod folder. A reader that
 * only looks at the mod folder cannot see anything the game made — which is
 * why a portrait captured in-game would never appear on the phone.
 *
 * There is no way to derive this path: it belongs to the mod manager, not to
 * the game. Unset, the portal simply does without — it reads the mod folder
 * and says so. Set DECK_PORTAL_MO_OVERWRITE to your profile's overwrite folder
 * if you want in-game captures to show up. */
const MO_OVERWRITE_CANDIDATES = process.env.DECK_PORTAL_MO_OVERWRITE
  ? [process.env.DECK_PORTAL_MO_OVERWRITE]
  : [];
const MO_OVERWRITE = MO_OVERWRITE_CANDIDATES.find((d) => {
  try { return fs.existsSync(d); } catch (_) { return false; }
}) || MO_OVERWRITE_CANDIDATES[0];

/* ======================================================================= */

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;          // decoded image bytes
const MAX_BODY_BYTES = 14 * 1024 * 1024;           // raw request body (base64 inflates ~4/3)
const PORTRAIT_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];

const MAGIC_VIEW_DIR = path.join(MOD_HD, 'PrismaUI', 'views', 'MagicDeck');
const DECK_VIEW_DIR = path.join(MOD_HD, 'PrismaUI', 'views', 'HotkeyDeck');
const PORTRAIT_DIR = path.join(DECK_VIEW_DIR, 'portraits');

/* Portraits are written by TWO different authors into two different places:
 *   - the portal (us) writes into the mod folder,          PORTRAIT_DIR
 *   - the game/plugin writes into MO2's overwrite tree,    OVERWRITE_PORTRAIT_DIR
 * MO2 gives overwrite the higher priority, so it wins on a stem collision here
 * too — what the phone shows then matches what the deck draws in-game. */
const OVERWRITE_PORTRAIT_DIR = path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'portraits');
const PORTRAIT_READ_DIRS = [OVERWRITE_PORTRAIT_DIR, PORTRAIT_DIR];

/* Portrait file stem -> follower slug. MUST stay identical to
 * PortraitCapture::SlugFromFileStem() in src/portrait_capture.cpp, which is what
 * the deck itself uses.
 *
 * WHY VERSIONS EXIST: PrismaUI/Ultralight memory-maps every image it draws and
 * holds it for the whole session, so a portrait the deck has already SHOWN
 * cannot be overwritten in place by anyone — not the plugin, not us. Both
 * writers therefore fall back to `<slug>~<unix seconds>.<ext>` beside it, and
 * the newest file for a slug is the portrait. '~' is safe as the separator
 * because a slug is only ever [a-z0-9-]. */
function slugOfStem(stem) {
  const s = String(stem).toLowerCase();
  const cut = s.indexOf('~');
  return cut === -1 ? s : s.slice(0, cut);
}

/* Every portrait FILE across both authors, in the order the game would see
 * them. Row shape is listImages() plus `dir` and `slug`.
 *
 * Deduped by FILENAME, not by slug: that is precisely MO2's rule — overwrite
 * shadows the mod folder when the two hold the same name, and when the names
 * differ the game sees BOTH. Collapsing to one row per slug happens afterwards,
 * in listPortraits(), so this stays a faithful picture of the merged folder. */
function listPortraitFiles() {
  const seen = Object.create(null);
  const out = [];
  for (const dir of PORTRAIT_READ_DIRS) {
    for (const r of listImages(dir, PORTRAIT_EXTS)) {
      const key = r.file.toLowerCase();
      if (seen[key]) continue;   // first dir wins = overwrite shadows the mod folder
      seen[key] = true;
      out.push(Object.assign({}, r, { dir, slug: slugOfStem(r.stem) }));
    }
  }
  return out;
}

/* One row per FOLLOWER — the file the deck actually draws. `extras` carries the
 * superseded files for that slug so the caller can report or prune them.
 *
 * THE WINNER RULE, and it must match FolPortraitsJson() in src/main.cpp exactly
 * or the phone shows one face and the deck draws another: newest mtime wins;
 * on a tie the greater FILENAME wins. The tie-break is not decoration — file
 * timestamps here are whole seconds, so a re-capture landing in the same second
 * as the file it supersedes is entirely possible. It resolves that the useful
 * way for free: '~' (0x7E) sorts above '.' (0x2E), so `x~1753900000.png` beats
 * `x.png`, and between two versions the later stamp beats the earlier. */
function betterPortrait(a, b) {   // true if a beats b
  if (a.mtime !== b.mtime) return a.mtime > b.mtime;
  return a.file.toLowerCase() > b.file.toLowerCase();
}

function listPortraits() {
  const best = Object.create(null);
  for (const r of listPortraitFiles()) {
    const cur = best[r.slug];
    if (!cur) { best[r.slug] = Object.assign({}, r, { extras: [] }); continue; }
    if (betterPortrait(r, cur)) {
      const demoted = { file: cur.file, dir: cur.dir, ext: cur.ext, mtime: cur.mtime, size: cur.size };
      best[r.slug] = Object.assign({}, r, { extras: cur.extras.concat([demoted]) });
    } else {
      cur.extras.push({ file: r.file, dir: r.dir, ext: r.ext, mtime: r.mtime, size: r.size });
    }
  }
  const out = Object.keys(best).map((k) => best[k]);
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function findPortrait(slug) {
  const want = String(slug).toLowerCase();
  return listPortraits().find((r) => r.slug === want) || null;
}

/** Delete every file for a slug across both authors, versions included. Returns
 *  how many actually went; a file the running game holds open simply stays. */
function removeSlug(slug) {
  const want = String(slug).toLowerCase();
  let n = 0;
  for (const r of listPortraitFiles()) {
    if (r.slug !== want) continue;
    const abs = confine(r.dir, r.file);
    if (!abs) continue;
    try { fs.unlinkSync(abs); n++; } catch (_) { /* held open by the game — leave it */ }
  }
  return n;
}

/* ========================= the custom icon POOL ======================== *
 *  ONE pool, TWO trees. Each PrismaUI view resolves "icons/custom/x.png"
 *  relative to ITS OWN folder, so a file the deck must draw has to exist
 *  under HotkeyDeck\icons\custom, and a file the Spell Deck must draw has to
 *  exist under MagicDeck\icons\custom.
 *
 *  ICON_DIR (the MagicDeck one) is the CANONICAL pool: it is what the Spell
 *  Deck's own picker scans, what main.cpp's CustomIconsJson() enumerates, and
 *  where the Desktop\Spell Deck Icons sweep lands. main.cpp mirrors
 *  Magic → Deck during its icon scan — but that only runs when the plugin
 *  looks, and a hotkey icon queued from the phone a second earlier would then
 *  paint a row whose <img> 404s (and the deck renders a missing icon as
 *  nothing, so it would look like the assignment silently failed).
 *
 *  So every write here lands in BOTH trees and every delete removes from both
 *  (writePoolIcon / removePoolIcon). The C++ mirror's size-compare turns the
 *  duplicate into a no-op, and the listing/assign side still speaks only of
 *  the canonical pool — "icons/custom/<file>", valid in either view.
 * ======================================================================= */

const ICON_DIR = path.join(MAGIC_VIEW_DIR, 'icons', 'custom');
const DECK_ICON_DIR = path.join(DECK_VIEW_DIR, 'icons', 'custom');

/* Faces tab (RaceMenu presets, via Preset Director). preset-icons/ holds the
 * per-preset images and assign.json (preset -> file); faces-catalogue.json is
 * the preset LIST the in-game Faces tab mirrors to disk (the .jslot files are
 * scattered across mod folders, so the portal can only enumerate them all via
 * PD's live API or this catalogue). PD's own HTTP API answers when the game is
 * running. */
const PRESET_ICONS_DIR = path.join(DECK_VIEW_DIR, 'preset-icons');
const PRESET_ASSIGN_FILE = path.join(PRESET_ICONS_DIR, 'assign.json');
const FACES_CATALOGUE_FILE = path.join(DECK_VIEW_DIR, 'faces-catalogue.json');
const PD_BASE = process.env.DECK_PORTAL_PD_BASE || 'http://127.0.0.1:8712';

function readPresetAssign() {
  try {
    const j = JSON.parse(fs.readFileSync(PRESET_ASSIGN_FILE, 'utf8').replace(/^﻿/, ''));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}
function writePresetAssign(map) {
  ensureDir(PRESET_ICONS_DIR);
  const tmp = PRESET_ASSIGN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, PRESET_ASSIGN_FILE);
}
function listPresetImages() {
  return listImages(PRESET_ICONS_DIR, ['png', 'jpg', 'jpeg', 'webp']).map((r) => r.file);
}
function readFacesCatalogue() {
  try {
    const j = JSON.parse(fs.readFileSync(FACES_CATALOGUE_FILE, 'utf8').replace(/^﻿/, ''));
    return (j && typeof j === 'object') ? j : null;
  } catch (_) { return null; }
}
function dedupePresetNames(arr) {
  const seen = Object.create(null), out = [];
  (arr || []).forEach((n) => {
    const s = String(n || '').trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (!seen[k]) { seen[k] = true; out.push(s); }
  });
  out.sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1);
  return out;
}
/* One short-timeout call to Preset Director's in-process HTTP API. Returns the
 * parsed JSON, or null when PD is unreachable (game closed / mod off). */
function pdReq(method, pathname, bodyObj) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let payload = '';
    if (bodyObj !== undefined) payload = JSON.stringify(bodyObj);
    let u;
    try { u = new URL(PD_BASE + pathname); } catch (_) { return finish(null); }
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: bodyObj !== undefined
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout: 4000,
    }, (r) => {
      let data = '';
      r.on('data', (c) => { data += c; });
      r.on('end', () => { try { finish(JSON.parse(data)); } catch (_) { finish(null); } });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ===================== hotkeys.json — READ ONLY ======================== *
 *  ⛔ THE PORTAL NEVER WRITES hotkeys.json. ⛔
 *  The running plugin holds the whole config in memory and rewrites the
 *  ENTIRE file on every PersistAll() — rename a tab in-game and our write
 *  is gone, silently. So a spell-icon assignment (ASSIGN_FILE) or a
 *  hotkey-icon assignment (HKICON_FILE) made here is handed over as a
 *  SIDECAR the plugin consumes on its own terms: the game stays the sole
 *  author of its own config file.
 *  Read fresh on every request — the game rewrites it constantly.
 * ======================================================================= */

const HK_JSON_CANDIDATES = process.env.DECK_PORTAL_HK_JSON
  ? [process.env.DECK_PORTAL_HK_JSON]
  : [
    path.join(MO_OVERWRITE, 'SKSE', 'Plugins', 'HotkeyDeck', 'hotkeys.json'),
    path.join(MOD_HD, 'SKSE', 'Plugins', 'HotkeyDeck', 'hotkeys.json'),
  ];

/* ======================= the assignment sidecar ======================== *
 *  Lives INSIDE icons/custom/ on purpose: that folder is already scanned by
 *  the plugin on every palette open and on the picker's ⟳ Refresh, it is
 *  already proven to pass through MO2's VFS mid-game, and the scan only
 *  looks at image extensions — so a .json parked there is invisible to it
 *  until the code we're adding goes looking for it by name.
 *
 *  Shape:  { "version": 1, "assign": [ { "spellId": "..", "icon": ".." } ] }
 *  `icon`  = a view-relative override path exactly as the deck stores it in
 *            magic.spells[].icon — "icons/custom/foo.png" — or "" for Auto.
 *  Deduped by spellId, last write wins. Written via a temp file + rename so
 *  the plugin can never read a half-written one.
 * ======================================================================= */

const ASSIGN_BASENAME = 'portal-assignments.json';
const ASSIGN_FILE = path.join(ICON_DIR, ASSIGN_BASENAME);
const ASSIGN_MAX = 500;                  // absurd-input guard; a deck holds dozens

/* ====================== the NPC-field sidecar ========================== *
 *  ⛔ THE PORTAL NEVER WRITES FollowerOrganizer.json. ⛔
 *  Exactly the same law as hotkeys.json, for exactly the same reason: while
 *  the game runs, Follower Organizer holds the whole roster in memory and
 *  rewrites that file wholesale on every SaveSettings() (with rotating
 *  backups). A write from here would be clobbered by the next in-game rename
 *  — silently, and possibly after eating a backup slot.
 *
 *  So an NPC-field edit made on the phone is HANDED OVER instead: it lands in
 *  a sidecar the Hotkey Deck plugin consumes on its own terms (it replays each
 *  entry through the FO Deck API's setFieldByOriginal op, so FO itself does
 *  the write). One path, always safe, whether or not the game is running.
 *
 *  Lives in the deck's own view folder — the plugin already reads that folder
 *  every palette open, MO2's VFS is proven to pass new files there through
 *  mid-game, and nothing existing looks at a .json parked in it.
 *
 *  Shape: { "version": 1,
 *           "set": [ { "original": "<Member.OriginalName>", "key": "relationship",
 *                      "value": "wife" } ] }
 *
 *  Keyed by ORIGINAL name, never by category+index: those shift the instant
 *  anyone reorders or re-files someone in-game, and the portal's snapshot of
 *  them can be minutes stale. "" as a value erases the field.
 *  Deduped by original+key, last write wins. Temp file + rename, so the plugin
 *  can never read a half-written one.
 * ======================================================================= */

const NPCF_BASENAME = 'portal-npc-fields.json';
const NPCF_FILE = path.join(DECK_VIEW_DIR, NPCF_BASENAME);
const NPCF_MAX = 800;                    // ~70 followers x a handful of fields

/* ==================== the Follower-Organizer-ops sidecar ============== *
 *  ⛔ THE PORTAL NEVER WRITES FollowerOrganizer.json. ⛔ (same law as the
 *  NPC-fields sidecar above, same reason: FO holds the whole roster in memory
 *  while the game runs and rewrites its file wholesale on every SaveSettings.)
 *
 *  Two category operations the phone can queue on top of the roster:
 *    · MOVE a follower into another category, and
 *    · RENAME a category slot.
 *  Both are HANDED OVER, never applied here — they land in this sidecar and the
 *  deck's C++ poller replays each op through the FO Deck API's `moveMember` /
 *  `renameCategory` op on its next Followers-tab open (or ~1 s via the pipe).
 *  That C++ pickup is DEFERRED until the deck DLL can be rebuilt — see
 *  src/portal-fo-ops-wiring.md. Until then these ops sit queued and the UI
 *  marks them PENDING; nothing is applied in-game.
 *
 *  Shape: { "version": 1, "ops": [
 *    { "type": "move", "original": "<Member.OriginalName>",
 *      "toCat": <slotIndex int>, "toCatName": "<name>" },
 *    { "type": "renameCategory", "cat": <slotIndex int>, "name": "<new name>" }
 *  ] }
 *
 *  A MOVE is keyed by ORIGINAL name, never by the follower's current cat+index:
 *  those shift the instant anyone reorders or re-files someone in-game (exactly
 *  the reason the NPC-fields sidecar uses the name too). The C++ consumer
 *  resolves the name to the live cat/idx at apply time. `toCatName` is carried
 *  only so the UI/log can name the destination; the int `toCat` is authoritative.
 *
 *  De-dupe, last write wins: a newer MOVE for the same `original`
 *  (case-insensitive) replaces the older; a newer RENAME for the same `cat`
 *  replaces the older. Temp file + rename, so the plugin never reads half a file.
 * ===================================================================== */
const FO_OPS_BASENAME = 'portal-fo-ops.json';
const FO_OPS_FILE = path.join(DECK_VIEW_DIR, FO_OPS_BASENAME);
const FO_OPS_MAX = 400;                  // absurd-input guard; a roster holds dozens
const FO_CAT_NAME_MAX = 300;             // == FIELD_VALUE_MAX; FO's TrimField cap
const FO_CAT_MAX = 255;                  // sane integer bound; the REAL check is
                                         // "is this an existing category" (readRoster)

/* ================= the category-ICON sidecar (followers rail) ========= *
 *  The phone's half of the deck's per-category glyphs (v0.14, main.cpp
 *  FollowerConfig::catIcons). Shape:
 *
 *      { "version": 1, "set": [ { "cat": 3, "icon": "icons/custom/x.png" } ] }
 *
 *  Keyed by the FO category SLOT INDEX, never by name — the label is renameable
 *  in the very same header row (from this portal, even), and a name key would
 *  orphan the glyph the moment "Housecarls" became "Housecarls (Whiterun)".
 *  "" clears one. Last write per slot wins.
 *
 *  It is a CONFIG slice, not an FO op, so it lives in its own file rather than
 *  in portal-fo-ops.json: fo-ops are replayed through the FO Deck API on the
 *  MAIN thread and only once a save is loaded, while an icon is pure config the
 *  plugin can apply on its worker thread at the main menu.
 *
 *  ⚠ SEEDED + TRUNCATED, never created/deleted (the portrait-bridge law). The
 *  plugin writes an empty queue at startup so the file EXISTS before MO2 fixes
 *  the visible file list, and empties rather than deletes it after each batch.
 *  Consequently the live copy is the one in OVERWRITE once the game has run
 *  once — hence catIconBridgeFile() probes there first, exactly like
 *  portraitBridgeFile(). Writing the mod-folder copy when overwrite exists is
 *  writing a file the game is not reading.
 * ===================================================================== */
const CATICON_BASENAME = 'portal-cat-icons.json';
const CATICON_FILE = path.join(DECK_VIEW_DIR, CATICON_BASENAME);
const CATICON_MAX = 60;                  // absurd-input guard; there are 25 slots
const CATICON_SLOT_MAX = 25;             // == kFolCatMax in main.cpp. Deliberately
                                         // TIGHTER than FO_CAT_MAX: the C++ refuses
                                         // an index past 25, so accepting one here
                                         // would queue something silently skipped.

function catIconSlotOk(n) { return Number.isInteger(n) && n >= 0 && n <= CATICON_SLOT_MAX; }

/** WHICH COPY IS LIVE — see the banner above (and portraitBridgeFile()). */
function catIconBridgeFile() {
  const ow = path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', CATICON_BASENAME);
  try { if (fs.existsSync(ow)) return ow; } catch (_) {}
  return CATICON_FILE;
}

/* ===================== the finances sidecar =========================== *
 *  Phone edits to the Finances tab (recurring income/expense/tax lines +
 *  market buy/sell items). Queued as ops the plugin replays through
 *  Finance::ApplyPortalFinances on the next Finances-tab open (and ~1 s via the
 *  live pipe). NEVER writes hotkeys.json. gold/debt/ledger stay C++-owned; the
 *  portal only queues edits to the VIEW-owned lines/market.
 *  Shape: { version:1, ops:[ {op:"set"|"add"|"del", target:"line"|"market",
 *    id, key?, value?, ...fields } ] }. "set" ops deduped by target+id+key.
 * ===================================================================== */
const FINANCE_BASENAME = 'portal-finances.json';
const FINANCE_FILE = path.join(DECK_VIEW_DIR, FINANCE_BASENAME);
const FINANCE_MAX = 400;
const FIN_LINE_KEYS = ['name', 'kind', 'category', 'amount', 'domainId', 'note', 'icon'];
const FIN_MARKET_KEYS = ['name', 'side', 'price', 'note', 'icon'];

/* ===================== the wardrobe sidecar ============================ *
 *  Same law as finances: the portal NEVER writes hotkeys.json (the plugin
 *  rewrites that file wholesale on every PersistAll, so a portal write would
 *  be clobbered by the next in-game edit). Edits are queued here and replayed
 *  by src/wardrobe.cpp ApplyPortalWardrobe() on the next Wardrobe tab open.
 *  Shape: { version:1, ops:[
 *    {op:"image", outfit:"<name>", value:"icons/custom/x.png"},
 *    {op:"set", target:"outfit", name:"<n>", key:"note"|"fav", value:"..."},
 *    {op:"set", target:"assign", formId, plugin, key:"mode"|"wardrobeId"|
 *               "outfit"|"cadenceHours", value:"..."},
 *    {op:"pool", id:"<wardrobeId>", add?:"<outfit>", remove?:"<outfit>"} ] }
 *  "set" ops are deduped by target+identity+key; "image" by outfit.
 * ===================================================================== */
const WARDROBE_BASENAME = 'portal-wardrobe.json';
const WARDROBE_FILE = path.join(DECK_VIEW_DIR, WARDROBE_BASENAME);
const WARDROBE_MAX = 400;
const WD_OUTFIT_KEYS = ['note', 'fav'];
const WD_ASSIGN_KEYS = ['mode', 'wardrobeId', 'outfit', 'cadenceHours'];
const WD_MODES = ['off', 'outfit', 'wardrobe'];
const WD_CADENCE_MAX = 24 * 30;          // matches the clamp in wardrobe.cpp
/* Wardrobe (pool) management from the phone: create / delete / rename /
 * reorder, consumed by the pool-new / pool-del / pool-set / pool-order /
 * pools-order branches in wardrobe.cpp ApplyPortalWardrobe. */
const WD_POOL_KEYS = ['name', 'note', 'mode', 'hue'];
const WD_POOL_MODES = ['bag', 'random'];
const WD_POOL_NAME_MAX = 64;
const WD_POOL_OUTFITS_MAX = 200;         // one order op carries the whole member list
/* Same palette + id shape the deck's own "＋ Wardrobe" uses (wardrobe-pane.js
 * HUES / newId), so a phone-made wardrobe is indistinguishable in-game. */
const WD_HUES = [38, 12, 145, 200, 260, 320, 88, 0];
function wdNewId() {
  return 'w' + Math.random().toString(36).slice(2, 8) + (Date.now() % 100000).toString(36);
}
/* SOES-NG location-type ids run 0..6400 (soes_ng_technical_analysis.md §3);
 * the picker list itself lives in index.html (WD_LOCATIONS) and the deck's
 * wardrobe-pane.js (LOCATIONS) — three places, one meaning. */
const WD_LOC_MAX = 6400;

/* SOES-NG's OWN state export — the catalogue of real outfits, the same file
 * wardrobe.cpp LoadCatalogue() reads. Without it the phone only knows outfits
 * that carry deck metadata, which is why a fresh portal showed none of the
 * in-game outfits. The game rewrites it on every SOES save and on the deck's
 * catalogue refresh; under MO2 the write lands in Overwrite. */
const SOES_CANDIDATES = process.env.DECK_PORTAL_SOES
  ? [process.env.DECK_PORTAL_SOES]
  : [
    path.join(MO_OVERWRITE, 'SKSE', 'Plugins', 'OutfitEquipmentSystemNGData.json'),
    path.resolve(HERE, '..', '..', 'OutfitEquipmentSystemNGData.json'),
  ];

/* Items the phone must never sweep into an outfit — utility gear that is
 * technically "worn" (CORE Carrier, quivers, lanterns). Portal-OWNED prefs:
 * the game never reads this file; it only shapes what the phone copies and
 * lets you pick. Keyed by the same formId|plugin pair as everything else. */
const WD_BL_BASENAME = 'portal-wardrobe-blacklist.json';
const WD_BL_FILE = path.join(DECK_VIEW_DIR, WD_BL_BASENAME);
function wdBlKey(formId, plugin) {
  return String(formId || '').toUpperCase() + '|' + String(plugin || '').toLowerCase();
}
function readWdBlacklist() {
  try {
    const j = JSON.parse(fs.readFileSync(WD_BL_FILE, 'utf8').replace(/^﻿/, ''));
    if (j && Array.isArray(j.items))
      return j.items.filter((i) => i && typeof i.formId === 'string' && i.formId);
  } catch (_) { /* absent = empty */ }
  return [];
}
function writeWdBlacklist(items) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const tmp = WD_BL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
  fs.renameSync(tmp, WD_BL_FILE);
}
/** blacklisted-flag a list of {formId,plugin} items in place; returns the map. */
function wdBlFlag(items) {
  const on = Object.create(null);
  readWdBlacklist().forEach((b) => { on[wdBlKey(b.formId, b.plugin)] = true; });
  (items || []).forEach((i) => { if (on[wdBlKey(i.formId, i.plugin)]) i.blacklisted = true; });
  return on;
}

/* Rendered armour icons: the plugin's index maps "0XABCD|plugin.esp" to
 * "icons/items/<file>.png". Newest copy wins (overwrite vs mod folder). */
const ITEMICON_INDEX_CANDIDATES = [
  path.join(DECK_VIEW_DIR, 'item-icons.json'),
  path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'item-icons.json'),
];
const ITEMICON_DIRS = [
  path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'icons', 'items'),
  path.join(DECK_VIEW_DIR, 'icons', 'items'),
];
function readItemIconIndex() {
  let best = null;
  for (const f of ITEMICON_INDEX_CANDIDATES) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
  }
  if (!best) return {};
  try {
    const j = JSON.parse(fs.readFileSync(best.file, 'utf8').replace(/^﻿/, ''));
    return (j && j.icons && typeof j.icons === 'object') ? j.icons : {};
  } catch (_) { return {}; }
}
/** iconFile-flag a list of {formId,plugin} items in place. */
function wdIconFlag(items) {
  const idx = readItemIconIndex();
  (items || []).forEach((i) => {
    const v = idx[wdBlKey(i.formId, i.plugin)];
    if (typeof v === 'string' && v.indexOf('icons/items/') === 0) i.iconFile = v.slice(12);
  });
}

/* The plugin's OWN catalogue export — same outfits, but with piece NAMES and
 * slots resolved in-game (a phone cannot resolve a FormID). Written by
 * Wardrobe::WriteCatalogueJson every time the catalogue cache refreshes. */
const SOES_NAMED_CANDIDATES = process.env.DECK_PORTAL_SOES_NAMED
  ? [process.env.DECK_PORTAL_SOES_NAMED]
  : [
    path.join(DECK_VIEW_DIR, 'wardrobe-catalogue.json'),
    path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'wardrobe-catalogue.json'),
  ];

/** The SOES outfit catalogue: [{name, fav, items:[{formId,plugin,name?,slot?}]}].
 *  Prefers the plugin's named export; falls back to SOES's raw file, whose
 *  armors come as "0x724ce8|SomeMod.esm" strings — split once here. */
function readSoesCatalogue() {
  for (const f of SOES_NAMED_CANDIDATES) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { continue; }
    if (!j || !Array.isArray(j.outfits)) continue;
    const outfits = [];
    for (const o of j.outfits) {
      if (!o || typeof o.name !== 'string' || !o.name) continue;
      const items = Array.isArray(o.items) ? o.items.filter((x) => x && x.formId).map((x) => ({
        formId: x.formId, plugin: x.plugin || '',
        name: typeof x.name === 'string' ? x.name : '',
        slot: typeof x.slot === 'string' ? x.slot : '',
        missing: !!x.missing,
      })) : [];
      outfits.push({ name: o.name, fav: !!o.fav, items });
    }
    return { ok: true, named: true, file: f, outfits };
  }
  for (const f of SOES_CANDIDATES) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let j;
    try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) { continue; }
    if (!j || !Array.isArray(j.outfits)) continue;
    const outfits = [];
    for (const o of j.outfits) {
      if (!o || typeof o.name !== 'string' || !o.name) continue;
      const items = Array.isArray(o.armors) ? o.armors.map((s) => {
        const m = typeof s === 'string' ? s.split('|') : [];
        return { formId: m[0] || '', plugin: m[1] || '' };
      }).filter((x) => x.formId) : [];
      outfits.push({ name: o.name, fav: !!o.isFavorite, items });
    }
    return { ok: true, file: f, outfits };
  }
  return { ok: false, file: null, outfits: [] };
}

/* ===================== the NFF-outfits sidecar ========================= *
 *  Nether's Follower Framework's own outfit system is the deck's SECOND
 *  dressing backend (src/nff_outfits.h). The phone edits only its METADATA —
 *  what you call each of a follower's three outfits, its icon, your notes.
 *
 *  It never queues a gameplay write, and that is deliberate: only the game can
 *  see whether SOES is also tracking her, and dressing someone both systems
 *  hold is exactly the thrash the whole feature exists to prevent. Wear / fill
 *  / clear stay in-game where the guard lives.
 *
 *  Same law as every other sidecar: the portal NEVER writes hotkeys.json while
 *  the game owns it. Ops are queued here and replayed by the plugin on the next
 *  tab open (NffOutfits::ApplyPortal), exactly like portal-npc-fields.json.
 *  "set" ops are deduped by follower+type+key, "note" by follower.
 * ===================================================================== */
/* ================= the My Home is Your Home (day) sidecar ============== *
 *  MHiYH NG owns where a follower lives and what she does at each hour. The
 *  deck can already change that in game (src/mhiyh_control.cpp calls the mod's
 *  OWN global script, never the linked ref); this is the same four ops from
 *  the phone.
 *
 *  Same law as every other sidecar — ⛔ the portal performs NO game action and
 *  writes no file the game owns. Ops are queued here and replayed by
 *  MhiyhControl::ApplyPortal through the identical entry point the in-deck
 *  buttons use, so the phone can reach MHiYH by no path the deck itself
 *  doesn't.
 *
 *  Shape: { version:1, ops:[ { op, original, formId, name, kind?, at } ] }
 *    op        setHome · forgetHome · setSpot · clearSpot
 *    original  FO's OriginalName — THE join key (see below)
 *    formId    the runtime ref id from the last export; a FALLBACK only, since
 *              the C++ side re-resolves the name against the live roster
 *    kind      1..6 for setSpot / clearSpot; NEVER sent with setHome (MarkHome
 *              /MoveHome take an actor and nothing else, and a stray kind:0
 *              would read as if the home were the zeroth stop)
 *    at        Date.now() when it was queued — the positional guard below
 *
 *  ⚠ WHY `at` EXISTS, and why two of these four ops are special.
 *  setHome and setSpot mark THE PLAYER'S FEET at the moment the game applies
 *  the op — not the moment the phone tapped it. A queued one that waits for the
 *  next Followers-tab open would move her home to wherever the player happens to be
 *  standing then: silent, wrong, and destructive (it deletes the old marker).
 *  So the portal refuses to queue a positional op unless the live pipe ANSWERS
 *  — i.e. the game is up and will apply it within about a second — and stamps
 *  it with `at`, which the C++ consumer re-checks against MHIYH_TTL_MS and
 *  drops if stale. forgetHome and clearSpot carry no position at all and are
 *  always queueable, game running or not.
 *
 *  Keyed by ORIGINAL NAME, not formId, for the same reason as the NPC-field
 *  sidecar: it is the only handle FollowerOrganizer.json actually gives the
 *  phone, and it survives a reload that renumbers reference FormIDs.
 *  De-dupe, last write wins: home ops (setHome/forgetHome) collapse per person,
 *  stop ops (setSpot/clearSpot) per person+kind.
 * ===================================================================== */
const MHIYH_BASENAME = 'portal-mhiyh.json';
const MHIYH_FILE = path.join(DECK_VIEW_DIR, MHIYH_BASENAME);
const MHIYH_MAX = 200;
const MHIYH_OPS = ['setHome', 'forgetHome', 'setSpot', 'clearSpot'];
// The two that mean "here, where I am standing". Everything about them is
// different: they need the game live, they expire, and the UI has to say so.
const MHIYH_POSITIONAL = ['setHome', 'setSpot'];
// Mirrors kPositionalTtlMs in src/mhiyh_control.h. If you change one, change both.
const MHIYH_TTL_MS = 120000;
/* MHiYH's own kind numbers, in the order the day is READ (not its numbering) —
 * a mirror of ACTS in view/HotkeyDeck/followers-pane.js, which is the canonical
 * list. Kind 7 (Watch) is deliberately absent from the settable set: it has no
 * marker of its own, it shares the guard post's. */
/* `pri` breaks the "several at once" tie the same way the deck does: MHiYH
 * legitimately has Home in force underneath almost everything, so the headline
 * names the most SPECIFIC activity (Sleep beats Home) instead of the first. */
const MHIYH_KINDS = [
  { k: 1, label: 'Sleep', verb: 'Sleeping', ic: '☾', pri: 7 },
  { k: 4, label: 'Breakfast', verb: 'At breakfast', ic: '☀', pri: 6 },
  { k: 2, label: 'Work', verb: 'Working', ic: '⚒', pri: 4 },
  { k: 5, label: 'Lunch', verb: 'At lunch', ic: '◑', pri: 6 },
  { k: 6, label: 'Dinner', verb: 'At dinner', ic: '✦', pri: 6 },
  { k: 3, label: 'Guard', verb: 'On guard', ic: '⚔', pri: 3 },
  { k: 7, label: 'Watch', verb: 'Keeping watch', ic: '⚐', pri: 2 },
  { k: 0, label: 'Home', verb: 'At home', ic: '⌂', pri: 1 },
];
const MHIYH_SETTABLE = [1, 2, 3, 4, 5, 6];       // 0 = its own action, 7 = shares Guard

/* The GAME-side truth about the day — who MHiYH holds, her home, every stop and
 * which one is in force — exported by MhiyhControl::WriteStatusJson whenever the
 * deck pushes the Followers state. A SIBLING of nff-status.json, not part of it:
 * that one is the NFF *outfit* export and is written only when the NFF sub-tab
 * opens, so folding the day into it would tie a schedule to an unrelated tab. */
const MHIYH_STATUS_CANDIDATES = process.env.DECK_PORTAL_MHIYH_STATUS
  ? [process.env.DECK_PORTAL_MHIYH_STATUS]
  : [
    path.join(DECK_VIEW_DIR, 'mhiyh-status.json'),
    path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'mhiyh-status.json'),
  ];

/* ===================== NFF HOME BASES (the Bases tab) ================== *
 *  Deck -> phone: the deck writes portal-bases.json (the exact nbOpen model)
 *  whenever its Bases surface builds state — nff_bases.cpp StateJson().
 *  Phone -> deck: we queue edits into portal-bases-ops.json, which the DLL's
 *  1 s portal poller drains through NffBases::ApplyPortalOps() (same Apply()
 *  the in-game controls use). Two files, one per direction — no read/write race.
 *
 *  The phone deliberately queues only the ops that make sense without the
 *  player's body: rename a base, rename a location label, move/assign/unassign
 *  residents, the shared owner switch and the daily hours. Registering a spot
 *  (setLoc) or travelling to one (visit) needs where the player is STANDING, so
 *  those stay in-game only. Every queued op is still validated by Apply() at
 *  replay, so this endpoint stays a thin, honest queue. */
const BASES_SNAP_BASENAME = 'portal-bases.json';
const BASES_SNAP_FILE = path.join(DECK_VIEW_DIR, BASES_SNAP_BASENAME);
const BASES_OPS_BASENAME = 'portal-bases-ops.json';
const BASES_OPS_FILE = path.join(DECK_VIEW_DIR, BASES_OPS_BASENAME);
const BASES_OPS_MAX = 200;               // the poller drains within a second; this is the absurd-input guard
const BASES_NAME_MAX = 48;               // matches the deck view's maxlength
const BASES_PHONE_OPS = ['rename', 'label', 'assign', 'unassign', 'owner', 'time'];

const NFF_BASENAME = 'portal-nff.json';
const NFF_FILE = path.join(DECK_VIEW_DIR, NFF_BASENAME);
const NFF_MAX = 400;
const NFF_SET_KEYS = ['label', 'icon', 'note'];
const NFF_TYPE_COUNT = 3;                // adventure / town / home — NFF's own numbering
const NFF_TYPE_NAME = ['Adventure', 'Town', 'Home'];
const NFF_LABEL_MAX = 60;                // matches the Cap() in nff_outfits.cpp
const WD_OUTFIT_NAME_MAX = 64;           // SOES keys outfits by name; keep them sane
const WD_OUTFIT_PIECES_MAX = 24;         // a full outfit is ~10; 24 is generous

/* The player's armour, as exported by TailorHelper (our own SKSE plugin) into
 * Tailor's view dir. It rewrites whenever armour enters/leaves the player's
 * inventory, so it is the freshest list of "things the player can actually build an
 * outfit out of". `formId` there is the LOCAL id in DECIMAL; we normalise to
 * the hex+plugin pair the rest of the wardrobe system uses. Our own plugin also
 * drops a copy at wardrobe-inventory.json — read whichever is newer. */
const INVENTORY_CANDIDATES = process.env.DECK_PORTAL_INVENTORY
  ? [process.env.DECK_PORTAL_INVENTORY]
  : [
    path.join(DECK_VIEW_DIR, 'wardrobe-inventory.json'),
    path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'wardrobe-inventory.json'),
    path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'Tailor', 'inventory.json'),
    path.join(MOD_HD, '..', 'Tailor - An Outfit and Wig Manager', 'PrismaUI', 'views', 'Tailor', 'inventory.json'),
  ];

/* ===================== the hotkey-icon sidecar ========================= *
 *  Same law, same shape, different tree. A hotkey icon is drawn by the DECK
 *  view, so its sidecar lives in the DECK view's own icons/custom — the
 *  folder main.cpp scans for hdIcons on every deck open — while the spell
 *  sidecar lives in the MagicDeck one. One pool, one upload endpoint, two
 *  sidecars; nobody writes hotkeys.json.
 *
 *  Shape: { "version": 1,
 *           "assign": [ { "entryId": "<entries[].id>",
 *                         "icon": "icons/custom/foo.png" } ] }
 *
 *  Keyed by entries[].id — the deck mints it once (newId() in app.js) and
 *  never reassigns it across rename / re-key / category move / drag-reorder,
 *  which is exactly why it is the addressable handle here. "" clears the
 *  icon (there is no "auto" for a hotkey — it simply has none).
 *  Deduped by entryId, last write wins. Temp file + rename, so the plugin
 *  can never read a half-written one.
 * ======================================================================= */

const HKICON_BASENAME = 'portal-hotkey-icons.json';
const HKICON_FILE = path.join(DECK_ICON_DIR, HKICON_BASENAME);
const HKICON_MAX = 500;                  // mirrors ASSIGN_MAX; a deck holds dozens

/* ===================== the hotkey-EDIT sidecar ========================= *
 *  The fourth handoff, and the only one that changes a hotkey itself rather
 *  than its art: rename / re-describe / re-file / REBIND / delete. Same law as
 *  the other three — ⛔ THE PORTAL NEVER WRITES hotkeys.json ⛔ — for the same
 *  reason: the running plugin holds the whole config in memory and rewrites
 *  that file wholesale on every PersistAll().
 *
 *  Lives beside portal-npc-fields.json in the deck's own view folder (NOT in
 *  icons/custom — this is not about art, and the icon scan has no business
 *  seeing it).
 *
 *  Shape: { "version": 1,
 *           "ops": [ { "op": "update", "entryId": "<entries[].id>",
 *                      "name": "…", "desc": "…", "category": "…",
 *                      "device": "keyboard"|"mouse", "code": 65,
 *                      "label": "F7", "mods": [42, 29] },
 *                    { "op": "delete", "entryId": "…" } ] }
 *
 *  PARTIAL by design: only the keys PRESENT in an op are changed, and an
 *  absent key means "leave it alone". An empty-string desc/category IS a real
 *  value (it clears the field), which is why nothing here may test a value for
 *  truthiness to decide whether it was sent.
 *
 *  ONE op per entryId, always. The consumer dedupes last-write-wins, so two
 *  half-ops for the same id would silently lose the first one's fields —
 *  mergeHotkeyEdit() therefore folds a new patch INTO the queued op instead of
 *  appending a second one. A delete replaces whatever was queued (and the
 *  consumer's "delete beats update" rule is the belt to that braces).
 *  Temp file + rename, so the plugin can never read a half-written one.
 * ======================================================================= */

const HKEDIT_BASENAME = 'portal-hotkey-edits.json';
const HKEDIT_FILE = path.join(DECK_VIEW_DIR, HKEDIT_BASENAME);
const HKEDIT_MAX = 400;                  // one op per entry; a deck holds dozens

// Mirrored in the C++ consumer's validation (see the CONTRACT in
// src/portal-hotkey-edit-wiring.md) and in index.html's edit sheet.
const HK_NAME_MAX = 64;
const HK_DESC_MAX = 200;
const HK_LABEL_MAX = 24;
const HK_MODS_MAX = 3;
// Every field an update op may carry, in the order they are written out.
const HK_EDIT_KEYS = ['name', 'desc', 'category', 'device', 'code', 'label', 'mods'];
// The four that describe WHICH key the entry fires; touching any of them is a
// rebind, and a rebind is refused outright on a device:"action" entry.
const HK_KEY_FIELDS = ['device', 'code', 'label', 'mods'];

// Mirrored in followers-pane.js FIELD_KEY_RE and DeckAPI.cpp ValidFieldKey().
const FIELD_KEY_RE = /^[a-z0-9_-]{1,32}$/;
const FIELD_VALUE_MAX = 300;             // DeckAPI.cpp kFieldValueMax

// The prefix the deck itself writes for a custom icon: CustomIconsJson() in
// main.cpp emits "icons/custom/" + filename, the picker stores that verbatim
// in spells[].icon, and resolveIconPath() uses it as-is (forward slashes).
const ICON_PREFIX = 'icons/custom/';
// ...and the prefix of the extracted Spell Hotbar 2 library, the OTHER thing a
// row's icon may point at. Both views ship the same tree (icons/sh/<atlas>/*.png
// + icons/sh_index.json); the in-game picker has always browsed it, and
// /api/sh-icons + checkAssignIcon() now let the phone do the same.
const LIB_PREFIX = 'icons/sh/';
const UNCATEGORIZED = 'Uncategorized';

const SPA_FILE = path.join(__dirname, 'index.html');

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

/* ============================ slug rule ================================ *
 *  THE contract, mirrored byte-for-byte in followers-pane.js's slugOf():
 *    lowercase → strip diacritics → every run of non [a-z0-9] becomes one
 *    '-' → trim leading/trailing '-'.
 *  "Olfina Gray-Mane" → "olfina-gray-mane"   ·  "Su-yeon" → "su-yeon"
 *  "Thane Hroa Hearth-Healer" → "thane-hroa-hearth-healer"
 *  Computed from the member's ORIGINAL name, never the display name:
 *  overrides get renamed all the time, originals don't.
 * ======================================================================= */

function slugOf(name) {
  let s = String(name == null ? '' : name);
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* older engines */ }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Icon stems are user-facing labels in the Spell Deck picker, so spaces and
// underscores are allowed — but never a dot or a separator, which is what
// makes "..", "a/b" and "C:\x" structurally impossible rather than filtered.
const ICON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;

function validSlug(s) { return typeof s === 'string' && s.length <= 80 && SLUG_RE.test(s); }
function validIconName(s) { return typeof s === 'string' && ICON_NAME_RE.test(s); }

function normExt(e) {
  const x = String(e == null ? '' : e).toLowerCase().replace(/^\./, '');
  return x === 'jpeg' ? 'jpg' : x;
}

/* ========================== path confinement =========================== */

/** Resolve `base/name` and refuse anything that escapes `base`. */
function confine(base, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const abs = path.resolve(base, name);
  const root = path.resolve(base) + path.sep;
  if (abs !== path.resolve(base) && !abs.startsWith(root)) return null;
  if (path.dirname(abs) !== path.resolve(base)) return null; // no subdirectories either
  return abs;
}

/* A single path segment inside the view dir. Must START with an alphanumeric,
   which is what makes "..", "." and "" structurally impossible rather than
   filtered — the same trick ICON_NAME_RE plays for icon stems. */
const VIEW_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/* Which view a view-relative icon path belongs to. Both views have their own
   icons/ tree (sh/** library + custom/), and the SAME relative path is legal in
   both — so the tree is never guessed from the path, it is always named by the
   caller. 'magic' stays the default so every URL minted before hotkey icons
   existed keeps resolving. */
const VIEW_DIRS = { magic: MAGIC_VIEW_DIR, hotkey: DECK_VIEW_DIR };
function viewName(v) { return v === 'hotkey' ? 'hotkey' : 'magic'; }

/** Resolve a VIEW-RELATIVE icon path ("icons/sh/atlas/key.png") inside a
 *  PrismaUI view dir, read-only. Unlike confine() this must allow
 *  subdirectories — the Spell Hotbar library is three levels deep — so the
 *  guard is per-segment instead, plus the usual resolved-prefix re-check.
 *  Returns null for anything that is not a plain image under that dir. */
function confineView(rel, view) {
  const base = VIEW_DIRS[viewName(view)];
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  if (segs.length > 5) return null;
  for (const s of segs) if (!VIEW_SEG_RE.test(s)) return null;
  if (!ICON_EXTS.includes(normExt(path.extname(rel)))) return null;
  const abs = path.resolve(base, segs.join(path.sep));
  const root = path.resolve(base) + path.sep;
  if (!abs.startsWith(root)) return null;
  return abs;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; }
}

/* ============================== listings =============================== */

/** [{ slug|name, ext, mtime, size }] for every image in `dir`. */
function listImages(dir, exts) {
  ensureDir(dir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    const ext = normExt(path.extname(f));
    if (!exts.includes(ext) && !(ext === 'jpg' && exts.includes('jpg'))) continue;
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch (_) { continue; }
    if (!st.isFile()) continue;
    out.push({
      stem: path.basename(f, path.extname(f)),
      file: f,
      ext,
      mtime: Math.floor(st.mtimeMs / 1000),
      size: st.size,
    });
  }
  out.sort((a, b) => a.stem.toLowerCase().localeCompare(b.stem.toLowerCase()));
  return out;
}



/* ===================== CHIM core profile (read-only) ==================== *
 *  Voice and the personality fields you actually fill out, surfaced next to
 *  the portrait so the popout is the whole person rather than just a face.
 *
 *  GOES THROUGH npc.php, NOT psql. This used to shell
 *  `psql` with credentials from the environment with the SQL built here, which meant CHIM's
 *  database credentials sat in the portal's own source and every query was
 *  hand-escaped string concatenation. For a mod other people install, neither
 *  is defensible (2026-08-11 release pass).
 *
 *  npc.php is this project's documented CHIM pipeline. It already lives inside
 *  the WSL box, already owns the connection, and — the part that matters —
 *  already uses pg_query_params, so the NPC name and the value are BOUND, not
 *  interpolated. A follower called "Bob'); drop table" is just a name that
 *  matches nothing, and that is now guaranteed by the tool rather than by this
 *  file remembering to double its quotes.
 *
 *  Still zero dependencies here: it is one `wsl -- php` call, no pg client.
 *
 *  Writes go through the same tool, which LOCKS the profile as it writes —
 *  without that, CHIM's dynamic profiler silently regenerates the field later
 *  and the edit appears to work and then vanishes. */
const CHIM_DISTRO = process.env.DECK_PORTAL_CHIM_DISTRO || 'DwemerAI4Skyrim3';
const CHIM_DB_TIMEOUT_MS = Number(process.env.DECK_PORTAL_CHIM_DB_TIMEOUT || 8000);

const CHIM_FIELDS = [
  'npc_name', 'voiceid', 'speechstyle', 'personality', 'relationships',
  'occupation', 'appearance', 'skills', 'goals', 'npc_static_bio',
  'race', 'gender', 'refid', 'lock_profile', 'npc_favorite', 'prompt_head',
];

/* The one place that reaches CHIM. Every argument is a separate argv element,
 * so nothing this file produces is ever parsed as shell or as SQL.
 *
 * ⚠ Do NOT "simplify" this into `bash -c "php npc.php …"`. Passing the pieces
 * through a shell string is what the old psql version did, and it is also what
 * WSL mangles: `bash -c script _ arg` silently dropped the argument (empty
 * stdout, exit 0), which read as "no rows" and made every follower look
 * unregistered for three rounds of guessing. Straight argv has neither problem.
 *
 * CHIM is only up while the game is running; "down" is a normal answer here,
 * not a fault, and is reported as such rather than logged as an error. */
const NPC_TOOL = process.env.DECK_PORTAL_NPC_TOOL || '/opt/npctool/npc.php';

function npcTool(args, stdin, done) {
  const child = execFile('wsl',
    ['-d', CHIM_DISTRO, '--', 'php', NPC_TOOL].concat(args),
    { timeout: CHIM_DB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (err) {
        const first = String(stderr || err.message).split('\n')[0] || 'CHIM unreachable';
        done({ ok: false, error: first.replace(/^npc:\s*/, '').slice(0, 200) });
        return;
      }
      done({ ok: true, out: String(stdout).trim() });
    });
  if (stdin != null) {
    // --stdin is how a long or quote-heavy value reaches npc.php without ever
    // touching a command line.
    try { child.stdin.end(String(stdin)); } catch (_) {}
  }
}

function chimProfile(name) {
  return new Promise((resolve) => {
    const want = String(name || '').trim();
    if (!want) { resolve({ ok: false, error: 'No name' }); return; }
    // The name is a separate argv element all the way down to pg_query_params
    // inside npc.php — nothing here builds SQL.
    npcTool(['show', want, '--json'], null, (r) => {
      if (!r.ok) { resolve({ ok: false, error: r.error }); return; }
      let j = null;
      try { j = JSON.parse(r.out || ''); } catch (_) { j = null; }
      if (!j || typeof j !== 'object') {
        resolve({ ok: false, error: 'CHIM returned something unreadable (' + (r.out || '').length + ' bytes)' });
        return;
      }
      if (!j.found) { resolve({ ok: true, found: false, profile: null }); return; }
      // Hand back only the fields the popout renders. npc.php does SELECT *,
      // and echoing every column would put whatever CHIM adds next straight on
      // a web page without anyone deciding to.
      const p = {};
      CHIM_FIELDS.forEach((k) => { if (k in j.profile) p[k] = j.profile[k]; });
      resolve({ ok: true, found: true, profile: p });
    });
  });
}


/* Fields the portal may write. A whitelist, not a filter: the column name goes
 * straight into SQL, so anything not on this list must be impossible, not just
 * discouraged. Identity columns (npc_name, refid, race, gender) are absent on
 * purpose — those are how CHIM finds the row. */
const CHIM_EDITABLE = ['voiceid', 'speechstyle', 'personality', 'relationships',
  'occupation', 'appearance', 'skills', 'goals', 'npc_static_bio', 'prompt_head'];

/* Set one field through npc.php.
 *
 *  The value goes in on STDIN (--stdin) and the name as its own argv element,
 *  so neither is ever concatenated into SQL or a shell line — npc.php binds
 *  both with pg_query_params. The old version built the UPDATE here by hand,
 *  doubling quotes, which is exactly the class of thing that only has to be
 *  wrong once.
 *
 *  npc.php auto-locks the row as it writes. Without the lock CHIM's dynamic
 *  profiler regenerates the field later and the edit silently disappears. */
async function chimSetField(name, field, value) {
  if (CHIM_EDITABLE.indexOf(field) < 0) return { ok: false, error: 'That field is not editable' };
  return new Promise((resolve) => {
    npcTool(['set', String(name), String(field), '--stdin', '--json'], String(value == null ? '' : value), (r) => {
      if (!r.ok) { resolve({ ok: false, error: r.error }); return; }
      let j = null;
      try { j = JSON.parse(r.out || ''); } catch (_) { j = null; }
      if (!j) { resolve({ ok: false, error: 'CHIM returned something unreadable' }); return; }
      if (!j.ok) { resolve({ ok: false, error: j.error || 'CHIM refused the edit' }); return; }
      resolve({ ok: true, locked: !!j.locked });
    });
  });
}


/* ============ live portrait bridge (portal -> plugin -> disk) ============ *
 *  A portrait the PORTAL writes is invisible to a running game: MO2 snapshots
 *  the directory LISTING at launch, so the deck's scanner — which iterates the
 *  folder — never sees a file that did not exist then. That is why cropping on
 *  the phone appeared to do nothing until the next launch.
 *
 *  So hand the plugin the BYTES instead and let IT write. Its write goes
 *  through the VFS from inside the game, exactly like an in-game capture, and
 *  the very next scan finds it. Same trick the icon/NPC-field sidecars use: the
 *  plugin opens this file by exact path (direct opens DO resolve; only listings
 *  are frozen), applies it, and deletes it.
 *
 *  We still write the real file too. The sidecar only reaches a RUNNING game;
 *  with Skyrim closed nothing would ever consume it, and the portrait has to
 *  exist on disk either way. Writing both means it works in both states, and a
 *  duplicate is harmless — the newest-wins scan collapses them. */
const PORTRAIT_BRIDGE = 'portal-portraits.json';

/* WHICH COPY IS LIVE — the same rule as capture.ini, and getting it wrong is
 * what made phone uploads invisible in game (2026-08-02: ysolda.jpg queued at
 * 15:53 into the MOD folder, game launched 15:43, plugin never logged a thing).
 *
 * Two MO2 facts compound here:
 *   1. The plugin writes through the VFS, so ITS copy lands in `overwrite`, and
 *      overwrite SHADOWS the mod folder. Writing the mod-folder copy therefore
 *      edits a file the game is not reading.
 *   2. MO2 fixes the visible file LIST at launch, so a file created mid-session
 *      is invisible to the running game however we write it.
 * The plugin now seeds this file at startup and empties rather than deletes it,
 * which satisfies (2); this function satisfies (1) by editing the copy that
 * actually exists. Mod folder only as a fallback for a game that has never run.
 */
function portraitBridgeFile() {
  const ow = path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', PORTRAIT_BRIDGE);
  try { if (fs.existsSync(ow)) return ow; } catch (_) {}
  return path.join(DECK_VIEW_DIR, PORTRAIT_BRIDGE);
}

function queuePortraitForPlugin(slug, ext, dataBase64) {
  const file = portraitBridgeFile();
  let shots = [];
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur && Array.isArray(cur.shots)) shots = cur.shots;
  } catch (_) { shots = []; }          // absent or mid-write: start clean
  // One entry per slug — a second crop of the same person supersedes the first
  // rather than making the plugin write twice.
  shots = shots.filter((x) => x && x.slug !== slug);
  shots.push({ slug, ext, dataBase64 });
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ shots }));
    return true;
  } catch (e) {
    log('portrait bridge: could not queue ' + slug + ' — ' + e.message);
    return false;
  }
}

/* ===================== capture framing (capture.ini) ==================== *
 *  The plugin frames every in-game capture from this file, so writing it is
 *  how "make all my future portraits look like THIS one" works: frame one
 *  portrait in the editor, save it as the default, and the next capture comes
 *  out already framed that way.
 *
 *  WHICH COPY IS LIVE: the plugin writes through MO2's VFS, so its capture.ini
 *  lands in OVERWRITE, and overwrite is what the game reads. Write there when
 *  it exists; otherwise seed the mod folder (a file that does not exist yet
 *  cannot be shadowing anything). Editing an EXISTING file is picked up by a
 *  running game; a brand new one only appears at the next launch, because MO2
 *  snapshots the file LIST at startup. */
const CAPTURE_INI = 'capture.ini';
const CAPTURE_DEFAULTS = { zoom: 0.60, offsetX: 0.00, offsetY: -0.06 };

function captureIniPath() {
  const ow = path.join(OVERWRITE_PORTRAIT_DIR, CAPTURE_INI);
  try { if (fs.existsSync(ow)) return ow; } catch (_) {}
  return path.join(PORTRAIT_DIR, CAPTURE_INI);
}

function readCaptureIni() {
  const file = captureIniPath();
  const out = Object.assign({}, CAPTURE_DEFAULTS);
  let exists = false;
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); exists = true; } catch (_) { return { ...out, file, exists }; }
  for (let line of txt.split(/\r?\n/)) {
    const cut = line.search(/[;#]/);
    if (cut >= 0) line = line.slice(0, cut);
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    const v = parseFloat(line.slice(eq + 1).trim());
    if (!isFinite(v)) continue;
    if (k === 'zoom') out.zoom = v;
    else if (k === 'offsetx') out.offsetX = v;
    else if (k === 'offsety') out.offsetY = v;
  }
  return { ...clampCapture(out), file, exists };
}

/** Same bounds the plugin enforces, so the portal can never write a value the
 *  game will silently ignore or clamp differently. */
function clampCapture(v) {
  const c = (x, lo, hi, d) => (isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    zoom: c(v.zoom, 0.15, 1.0, CAPTURE_DEFAULTS.zoom),
    offsetX: c(v.offsetX, -0.5, 0.5, CAPTURE_DEFAULTS.offsetX),
    offsetY: c(v.offsetY, -0.5, 0.5, CAPTURE_DEFAULTS.offsetY),
  };
}

function writeCaptureIni(v) {
  const t = clampCapture(v);
  const file = captureIniPath();
  const body =
    '; Portrait framing. Edit and take another portrait - no restart needed.\r\n' +
    ';\r\n' +
    '; zoom    = how much of the screen to keep, 0.2 (very tight) .. 1.0 (whole frame).\r\n' +
    ';           Smaller = more zoomed in. 0.60 keeps the middle 60%.\r\n' +
    '; offsetx = shift the crop sideways. Negative = LEFT, positive = RIGHT.\r\n' +
    '; offsety = shift the crop up/down.  Negative = UP,   positive = DOWN.\r\n' +
    ';           Both are fractions of the screen height, so 0.05 is a small nudge.\r\n' +
    ';\r\n' +
    '; Last written by the Deck Portal from a framed portrait.\r\n' +
    '\r\n' +
    'zoom=' + t.zoom.toFixed(3) + '\r\n' +
    'offsetx=' + t.offsetX.toFixed(3) + '\r\n' +
    'offsety=' + t.offsetY.toFixed(3) + '\r\n';
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, body);
  return { ...t, file };
}

function portraitIndex() {
  const map = Object.create(null);
  for (const r of listPortraits()) map[r.slug] = r;
  return map;
}

/** Existing file for a stem in dir, whatever its extension. */
function findByStem(dir, stem, exts) {
  for (const r of listImages(dir, exts)) {
    if (r.stem.toLowerCase() === String(stem).toLowerCase()) return r;
  }
  return null;
}

/* ====================== FollowerOrganizer.json ========================= *
 *  Shape-tolerant on purpose. This file is written by MaskedRPGFan's
 *  Follower Organizer, and we cannot read the live one from here — so the
 *  parser accepts every plausible key spelling and locates the category
 *  array structurally instead of assuming a path. Whatever it decided is
 *  reported back in `shape` so a human can confirm it in one request.
 * ======================================================================= */

const K_CATS = ['categories', 'Categories', 'cats', 'categoryList'];
const K_MEMBERS = ['members', 'Members', 'followers', 'Followers', 'entries'];
const K_NAME = ['name', 'Name', 'display_name', 'displayName'];
const K_ORIGINAL = ['original_name', 'originalName', 'original', 'Original', 'OriginalName'];
const K_DESC = ['description', 'Description', 'desc', 'note', 'Note'];
const K_FORM = ['base_form_string', 'baseFormString', 'form_string', 'formString', 'form', 'formId', 'FormID', 'formID'];
const K_INDEX = ['index', 'Index', 'slot', 'id'];
const K_FIELDS = ['Fields', 'fields'];

function pick(obj, keys, dflt) {
  if (!obj || typeof obj !== 'object') return dflt;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return dflt;
}

function str(v) { return v == null ? '' : String(v); }

function membersOf(o) {
  const m = pick(o, K_MEMBERS, null);
  return Array.isArray(m) ? m : null;
}

/** Anything -> { key: "non-empty string" }. Same tolerance as the deck pane's
 *  normalizeFields(): an FO build without the field ships no "Fields" at all,
 *  and a hand-edited JSON can hold anything, so unusable keys, non-string
 *  values and blanks are dropped rather than propagated. */
function fieldsOf(o) {
  const raw = pick(o, K_FIELDS, null);
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw)) {
    if (!FIELD_KEY_RE.test(k)) continue;
    const v = raw[k];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[k] = t.length > FIELD_VALUE_MAX ? t.slice(0, FIELD_VALUE_MAX) : t;
  }
  return out;
}

/** Depth-bounded hunt for "an array of objects that each hold a member array". */
function findCategoryArray(root, maxDepth) {
  const seen = new Set();
  const queue = [{ node: root, depth: 0, where: '$' }];
  while (queue.length) {
    const { node, depth, where } = queue.shift();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some((e) => e && typeof e === 'object' && membersOf(e))) return { arr: node, where };
      node.slice(0, 64).forEach((e, i) => queue.push({ node: e, depth: depth + 1, where: where + '[' + i + ']' }));
      continue;
    }
    for (const k of Object.keys(node)) {
      queue.push({ node: node[k], depth: depth + 1, where: where + '.' + k });
    }
  }
  return null;
}

/* The roster has TWO possible sources and the fresher one wins.
 *
 *  FollowerOrganizer.json is FO's own file — authoritative when the game is
 *  shut, and STALE while it runs, because FO keeps the roster in memory and
 *  rewrites the file on its own schedule. That is why "deleting in game didnt
 *  delete them from the web-app": the phone was reading a snapshot from
 *  whenever FO last saved, with no way to know.
 *
 *  fo-roster.json is the deck DLL's export of FO's LIVE state (main.cpp
 *  WriteRosterExport), rewritten on every Followers refresh. It only exists
 *  while the deck has run this session, so it is a preference, never a
 *  requirement — with no export, or an older one, this falls straight back.
 *
 *  Both parse through the same reader below: K_CATS / K_MEMBERS / K_ORIGINAL
 *  already accept the Deck API's lowercase spellings alongside FO's own.
 */
const FO_LIVE_FILE = path.join(DECK_VIEW_DIR, 'fo-roster.json');

function pickRosterSource() {
  let liveAt = 0, diskAt = 0;
  try { liveAt = fs.statSync(FO_LIVE_FILE).mtimeMs; } catch (_) {}
  try { diskAt = fs.statSync(FO_JSON).mtimeMs; } catch (_) {}
  if (liveAt && liveAt >= diskAt) return { file: FO_LIVE_FILE, live: true };
  return { file: FO_JSON, live: false };
}

function readRoster(_forceDisk) {
  const warnings = [];
  /* _forceDisk is the self-retry below: if the LIVE export is unreadable,
     unparseable or shaped wrong, fall back to FO's own file rather than
     blanking the phone. A bad export must never be worse than no export. */
  const src = _forceDisk ? { file: FO_JSON, live: false } : pickRosterSource();
  const backToDisk = () => src.live && !_forceDisk;
  let raw;
  try {
    raw = fs.readFileSync(src.file, 'utf8');
  } catch (e) {
    if (backToDisk()) return readRoster(true);
    return {
      ok: false,
      error: 'Could not read FollowerOrganizer.json (' + e.code + ') at ' + FO_JSON,
      source: FO_JSON, categories: [], total: 0, warnings,
      npcFieldsFile: NPCF_FILE, pendingNpcFields: 0, pendingNpcUnknown: [],
      foOpsFile: FO_OPS_FILE, pendingFoOps: 0, pendingFoMove: 0, pendingFoRename: 0, pendingFoUnknown: [],
      catIconsFile: CATICON_FILE, pendingCatIcons: 0, pendingCatIconUnknown: [],
      shape: { root: 'missing' },
    };
  }
  let root;
  try {
    root = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    if (backToDisk()) return readRoster(true);
    return {
      ok: false,
      error: 'FollowerOrganizer.json is not valid JSON: ' + e.message,
      source: FO_JSON, categories: [], total: 0, warnings,
      npcFieldsFile: NPCF_FILE, pendingNpcFields: 0, pendingNpcUnknown: [],
      foOpsFile: FO_OPS_FILE, pendingFoOps: 0, pendingFoMove: 0, pendingFoRename: 0, pendingFoUnknown: [],
      catIconsFile: CATICON_FILE, pendingCatIcons: 0, pendingCatIconUnknown: [],
      shape: { root: 'invalid-json', bytes: raw.length },
    };
  }

  let arr = null, where = null;
  const direct = pick(root, K_CATS, null);
  if (Array.isArray(direct)) { arr = direct; where = '$.' + K_CATS.find((k) => Array.isArray(root && root[k])); }
  else if (Array.isArray(root) && root.some((e) => membersOf(e))) { arr = root; where = '$'; }
  if (!arr) {
    const hit = findCategoryArray(root, 4);
    if (hit) { arr = hit.arr; where = hit.where; warnings.push('Category array found by structural scan at ' + hit.where + ' — key names differ from the expected "categories".'); }
  }
  if (!arr) {
    if (backToDisk()) return readRoster(true);
    return {
      ok: false,
      error: 'No category array found in FollowerOrganizer.json — nothing in it looks like [{ members: [...] }].',
      source: FO_JSON, categories: [], total: 0, warnings,
      npcFieldsFile: NPCF_FILE, pendingNpcFields: 0, pendingNpcUnknown: [],
      foOpsFile: FO_OPS_FILE, pendingFoOps: 0, pendingFoMove: 0, pendingFoRename: 0, pendingFoUnknown: [],
      catIconsFile: CATICON_FILE, pendingCatIcons: 0, pendingCatIconUnknown: [],
      shape: { root: Array.isArray(root) ? 'array' : typeof root, keys: root && typeof root === 'object' ? Object.keys(root).slice(0, 20) : [] },
    };
  }

  const portraits = portraitIndex();
  // Queued field edits, folded in per member so the phone shows what the deck
  // WILL have, not just what is on disk. Matched case-insensitively on the
  // original name — the same rule the C++ consumer's setFieldByOriginal uses.
  const pendF = readNpcFields();
  const pendByName = Object.create(null);
  for (const e of pendF.list) {
    const k = e.original.toLowerCase();
    if (!pendByName[k]) pendByName[k] = {};
    pendByName[k][e.key] = e.value;
  }
  const matchedNames = Object.create(null);

  // Queued category MOVE / RENAME ops, folded in the same way so a card shows a
  // "queued" badge and a header shows its queued new name. Move is keyed by the
  // follower's original name; rename by the category slot index.
  const pendFo = readFoOps();
  const pendMoveByName = Object.create(null);   // name.toLowerCase() -> {toCat,toCatName}
  const pendDeleteByName = Object.create(null); // name.toLowerCase() -> true (queued removal)
  const pendDescByName = Object.create(null);   // name.toLowerCase() -> queued note text
  const pendRenameByCat = Object.create(null);  // slotIndex -> queued name ("" = reset)
  for (const o of pendFo.list) {
    if (o.type === 'move') pendMoveByName[o.original.toLowerCase()] = { toCat: o.toCat, toCatName: o.toCatName };
    else if (o.type === 'delete') pendDeleteByName[o.original.toLowerCase()] = true;
    else if (o.type === 'setDesc') pendDescByName[o.original.toLowerCase()] = o.desc;
    else if (o.type === 'renameCategory') pendRenameByCat[o.cat] = o.name;
  }
  const matchedMoveNames = Object.create(null);
  const matchedRenameCats = Object.create(null);

  /* Category glyphs, folded in the same way as the rename: what the deck has on
     disk now (hotkeys.json `followers.catIcons`) plus whatever the phone has
     queued on top of it, so a header shows the icon the deck WILL have. */
  const liveCatIcons = readCatIconsLive().icons;
  const pendCatIcons = readCatIcons();
  const pendIconByCat = Object.create(null);
  for (const e of pendCatIcons.list) pendIconByCat[e.cat] = e.icon;
  const matchedIconCats = Object.create(null);

  const cats = [];
  let total = 0;
  arr.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    // NB: Number(null) === 0, so an absent index must be caught explicitly or
    // every category collapses onto the reserved slot 0 and vanishes.
    const idxRaw = pick(c, K_INDEX, null);
    const index = (idxRaw !== null && idxRaw !== '' && Number.isFinite(Number(idxRaw)))
      ? Number(idxRaw)
      : i;
    // FO reserves slot 0 (the "no category" bucket); the deck's own Deck API
    // starts its walk at 1, so we match it.
    if (index === 0) return;
    const cOriginal = str(pick(c, K_ORIGINAL, '')) || str(pick(c, K_NAME, ''));
    const cOverride = str(pick(c, K_NAME, ''));
    const catName = (cOverride && cOverride !== cOriginal ? cOverride : cOriginal) || ('Category ' + index);

    const members = [];
    (membersOf(c) || []).forEach((mRaw) => {
      const m = (typeof mRaw === 'string') ? { name: mRaw } : mRaw;
      if (!m || typeof m !== 'object') return;
      const original = str(pick(m, K_ORIGINAL, '')) || str(pick(m, K_NAME, ''));
      const override = str(pick(m, K_NAME, ''));
      const name = (override && override !== original ? override : original) || '(unnamed)';
      const slug = slugOf(original || name);
      const p = slug ? portraits[slug] : null;
      // Not an error any more — the newest file wins, in the portal and in the
      // deck alike. Worth saying only because the spares are ~780 KB each and
      // are usually re-captures the running game would not let us overwrite.
      if (p && p.extras && p.extras.length) {
        warnings.push('"' + slug + '" has ' + p.extras.length + ' superseded portrait file(s) — the newest (' +
          p.file + ') is the one shown; the rest are ignored and can be deleted.');
      }
      const originalName = original || name;
      const pending = pendByName[originalName.toLowerCase()] || null;
      if (pending) matchedNames[originalName.toLowerCase()] = true;
      // A queued category move for this person, if any. Kept even when it targets
      // the category she is already in — the UI just won't badge that as a move.
      const move = pendMoveByName[originalName.toLowerCase()] || null;
      if (move) matchedMoveNames[originalName.toLowerCase()] = true;
      // A queued REMOVAL. She stays in the list until the deck applies it —
      // dropping her here would make the phone disagree with the game, and the
      // next poll would put her back.
      const pendingDelete = !!pendDeleteByName[originalName.toLowerCase()];
      const pendingDesc = Object.prototype.hasOwnProperty.call(
        pendDescByName, originalName.toLowerCase()) ? pendDescByName[originalName.toLowerCase()] : null;
      if (pendingDesc !== null) matchedMoveNames[originalName.toLowerCase()] = true;
      if (pendingDelete) matchedMoveNames[originalName.toLowerCase()] = true;
      members.push({
        pendingDelete,
        pendingDesc,
        name,
        original: originalName,
        desc: str(pick(m, K_DESC, '')),
        form: str(pick(m, K_FORM, '')),
        slug,
        catIndex: index,
        // What FO has on disk right now …
        fields: fieldsOf(m),
        // … and what is queued on top of it ("" = queued erase). Absent keys
        // simply aren't here, so the UI can show a per-field pending mark.
        pendingFields: pending || {},
        // A queued category move ({toCat,toCatName}) or null. The follower stays
        // listed where she is now — the portal never fake-moves her; the badge
        // says where she is HEADED once the deck applies it.
        pendingMove: move,
        hasPortrait: !!p,
        ext: p ? p.ext : null,
        mtime: p ? p.mtime : 0,
      });
      total++;
    });

    // A queued rename for this slot (the value can be "" = reset to FO's own
    // name). undefined means nothing is queued.
    let pendingRename = null;
    if (Object.prototype.hasOwnProperty.call(pendRenameByCat, index)) {
      pendingRename = pendRenameByCat[index];
      matchedRenameCats[index] = true;
    }
    /* The glyph on this header. `icon`/`iconUrl` = what the deck draws now;
       `pendingIcon` = what the phone queued ("" is a queued CLEAR, null means
       nothing is queued — the same three-state convention a spell or hotkey row
       uses, so the client's effectiveIcon() works on a category unchanged). */
    const curIcon = liveCatIcons[index] || '';
    const curShown = curIcon ? iconUrlFor(curIcon, 'hotkey') : null;
    let pendIcon = null, pendIconUrl = null;
    if (Object.prototype.hasOwnProperty.call(pendIconByCat, index)) {
      pendIcon = pendIconByCat[index];
      matchedIconCats[index] = true;
      const pendShown = pendIcon ? iconUrlFor(pendIcon, 'hotkey') : null;
      pendIconUrl = pendShown ? pendShown.url : null;
    }

    cats.push({ index, name: catName, original: cOriginal, members, pendingRename,
      icon: curIcon, iconUrl: curShown ? curShown.url : null,
      // Same two descriptors a spell/hotkey row carries, so the client's shared
      // currentLabel() can describe a category without a special case.
      iconKind: curShown ? curShown.kind : 'none',
      iconMissing: !!(curShown && curShown.missing),
      pendingIcon: pendIcon, pendingIconUrl: pendIconUrl });
  });

  // Queued edits for a name that is no longer in the roster. The C++ consumer
  // skips and clears those; surfacing them here is what makes that debuggable.
  const unknownNames = [];
  for (const n of Object.keys(pendByName)) {
    if (!matchedNames[n]) unknownNames.push(n);
  }

  // The same idea for the FO ops: a queued MOVE for a name that is no longer in
  // the roster, or a RENAME for a slot that no longer exists.
  const foUnknown = [];
  for (const o of pendFo.list) {
    if (o.type === 'move' && !matchedMoveNames[o.original.toLowerCase()]) foUnknown.push('move: ' + o.original);
    else if (o.type === 'renameCategory' && !matchedRenameCats[o.cat]) foUnknown.push('rename: slot ' + o.cat);
  }
  const pendMoveN = pendFo.list.filter((o) => o.type === 'move').length;
  const pendRenameN = pendFo.list.filter((o) => o.type === 'renameCategory').length;

  // A queued glyph for a slot that is no longer a category. The C++ consumer
  // skips those; surfacing them is what makes that debuggable rather than eerie.
  const catIconUnknown = pendCatIcons.list
    .filter((e) => !matchedIconCats[e.cat])
    .map((e) => 'slot ' + e.cat);

  return {
    ok: true, source: src.file, live: src.live, categories: cats, total, warnings,
    /* Which file this came from, and therefore whether a delete made in
       game is visible yet. live=false while the game runs means FO has
       not saved since, and the deck has not exported either. */
    npcFieldsFile: NPCF_FILE,
    pendingNpcFields: pendF.list.length,
    pendingNpcFieldsMalformed: pendF.malformed,
    pendingNpcUnknown: unknownNames,
    // The category MOVE / RENAME queue (portal-fo-ops.json). Separate from the
    // NPC-field queue above — a different file, applied through different FO
    // Deck API ops (moveMember / renameCategory), and its C++ pickup is deferred.
    foOpsFile: FO_OPS_FILE,
    pendingFoOps: pendFo.list.length,
    pendingFoMove: pendMoveN,
    pendingFoRename: pendRenameN,
    pendingFoOpsMalformed: pendFo.malformed,
    pendingFoUnknown: foUnknown,
    // The category-GLYPH queue (portal-cat-icons.json). A third file again,
    // because it is a config slice rather than an FO op — see its banner.
    catIconsFile: pendCatIcons.file,
    pendingCatIcons: pendCatIcons.list.length,
    pendingCatIconsMalformed: pendCatIcons.malformed,
    pendingCatIconUnknown: catIconUnknown,
    shape: { root: Array.isArray(root) ? 'array' : typeof root, categoriesAt: where, categoryCount: cats.length },
  };
}

/* ======================= Spell Deck (hotkeys.json) ===================== *
 *  READ ONLY, and re-read on every request: the game rewrites this whole
 *  file on every PersistAll(), so anything we cached would be a lie within
 *  seconds of the player renaming a tab.
 *
 *  Shape we care about (from MagicConfigToJson in src/main.cpp):
 *    magic.categories : ["Destruction", …]          — rail order
 *    magic.spells[]   : { id, name, category, icon, mode, hand,
 *                         school, element, tier, slot, … }
 *  `icon` is the per-spell override — FIRST link in the view's resolve chain
 *  (resolveIconPath() in view/MagicDeck/app.js: `if (m.icon) return …`), so
 *  setting it wins over the exact-form match and the school/tier generic.
 *  "" means Auto.
 * ======================================================================= */

/** First candidate that exists, or null. Overwrite beats the mod folder. */
function resolveHkJson() {
  for (const c of HK_JSON_CANDIDATES) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next */ }
  }
  return null;
}

/** The whole config file, once. Every slice below is a projection over this, so
 *  ONE request can build the spell payload AND the hotkey payload from ONE
 *  snapshot instead of two reads that might straddle a game save. Still no
 *  caching ACROSS requests — the plugin rewrites this file constantly. */
function readHkRoot() {
  const file = resolveHkJson();
  if (!file) {
    return {
      ok: false, file: null, root: null,
      error: 'hotkeys.json not found. Looked in: ' + HK_JSON_CANDIDATES.join('  |  '),
    };
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, file, root: null, error: 'Could not read hotkeys.json (' + e.code + ') at ' + file };
  }
  let root;
  try { root = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) {
    // A torn read while the game rewrites the file looks exactly like this.
    // It is transient — say so, instead of implying the config is corrupt.
    return {
      ok: false, file, root: null,
      error: 'hotkeys.json is not valid JSON right now (' + e.message + ') — if the game just saved, hit ⟳ and it will parse.',
    };
  }
  return { ok: true, file, root };
}

/** The `magic` slice. Pass a readHkRoot() result in to share one snapshot. */
function readMagic(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, magic: null };
  const root = s.root;
  const magic = (root && typeof root === 'object' && root.magic && typeof root.magic === 'object' && !Array.isArray(root.magic))
    ? root.magic : null;
  return { ok: true, file: s.file, magic, hasMagic: !!magic };
}

/** The hotkey slice: `entries[]` (the palette rows) and `categories[]` (the tab
 *  order). Same tolerance as ConfigFromJson(): anything that is not an array
 *  reads as empty rather than throwing. */
function readHotkeys(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, entries: [], categories: [] };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const entries = Array.isArray(root.entries) ? root.entries : [];
  const categories = Array.isArray(root.categories)
    ? root.categories.filter((c) => typeof c === 'string' && c) : [];
  return { ok: true, file: s.file, entries, categories };
}

/* --------------------------- the sidecar ---------------------------- */

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged. */
function readAssignments() {
  let raw;
  try { raw = fs.readFileSync(ASSIGN_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.assign)) {
    return { list: [], exists: true, malformed: true };
  }
  // Dedupe by spellId, last write wins — same rule the C++ consumer applies,
  // so what the portal shows as pending is what the game will do.
  const out = [];
  const at = Object.create(null);
  for (const e of j.assign) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.spellId === 'string' ? e.spellId : '';
    if (!id) continue;
    const icon = typeof e.icon === 'string' ? e.icon : '';
    if (at[id] !== undefined) out[at[id]] = { spellId: id, icon };
    else { at[id] = out.length; out.push({ spellId: id, icon }); }
  }
  return { list: out, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin can never observe a half-written file. */
/* ============================ live push (named pipe) ====================== *
 *  The plugin (>= 0.12.0) listens on \\.\pipe\HotkeyDeck. We still write the
 *  sidecar first — it is the durable queue and the ONLY path when the game is
 *  closed — and then nudge the game to consume it right now instead of on its
 *  next 1 s poll. The plugin re-writes that same sidecar from our payload,
 *  applies it, and deletes it, so this is a pure latency shortcut: nothing here
 *  changes what lands, and every failure silently falls back to the poll.
 *  Fire-and-forget by design: the phone's reply must never wait on the game. */
/** A sidecar rename can hit the same Windows lock if the plugin is reading the
 *  file that instant. That one IS worth retrying: the plugin's read is
 *  microseconds, not a session-long handle. */
function renameWithRetry(tmp, dest, tries) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, dest); return; }
    catch (e) {
      const busy = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!busy || i >= (tries || 10)) throw e;
      const until = Date.now() + 20;
      while (Date.now() < until) { /* 20 ms, sync — these routes are already sync */ }
    }
  }
}

const LIVE_PIPE = '\\\\.\\pipe\\HotkeyDeck';
const LIVE_TIMEOUT_MS = 700;
let liveLastOk = 0;

function liveSend(payload) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let sock;
    try {
      sock = net.connect({ path: LIVE_PIPE });
    } catch (_) { finish(null); return; }
    let buf = '';
    const bail = () => { try { sock.destroy(); } catch (_) {} finish(null); };
    sock.setTimeout(LIVE_TIMEOUT_MS, bail);
    sock.on('error', bail);                 // game closed / older plugin: expected
    sock.on('connect', () => { try { sock.write(JSON.stringify(payload) + '\n'); } catch (_) { bail(); } });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) { if (buf.length > 64 * 1024) bail(); return; }
      try { sock.end(); } catch (_) {}
      try { finish(JSON.parse(buf.slice(0, nl))); } catch (_) { finish(null); }
    });
    sock.on('close', () => finish(null));
  });
}

/** Push the sidecar we just wrote at the running game. Never throws, never
 *  awaited by a route — the pending counters tell the truth either way. */
function liveFlush(kind, file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return; }            // already consumed, or mid-write: the poll has it
  payload.kind = kind;
  liveSend(payload).then((r) => {
    if (r && r.ok) {
      liveLastOk = Date.now();
      if (!r.queued) log('live: ' + kind + ' -> ' + (r.msg || 'applied'));
    }
  }).catch(() => {});
}

function writeAssignments(list) {
  if (!ensureDir(ICON_DIR)) throw Object.assign(new Error('Cannot create ' + ICON_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, assign: list }, null, 2);
  const tmp = ASSIGN_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, ASSIGN_FILE);  // MoveFileEx(REPLACE_EXISTING) — atomic, retried past a transient lock
  liveFlush('spell-icons', ASSIGN_FILE);
}

function mergeAssignment(spellId, icon) {
  const cur = readAssignments();
  const list = cur.list.filter((e) => e.spellId !== spellId);
  list.push({ spellId, icon });
  if (list.length > ASSIGN_MAX) list.splice(0, list.length - ASSIGN_MAX);
  writeAssignments(list);
  return list;
}

/* ------------------------ the NPC-field sidecar ---------------------- */

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged. */
function readNpcFields() {
  let raw;
  try { raw = fs.readFileSync(NPCF_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.set)) {
    return { list: [], exists: true, malformed: true };
  }
  // Dedupe by original+key (case-insensitive on the name, exactly like the C++
  // consumer's match), last write wins — so what the portal reports as pending
  // is precisely what the game will do.
  const out = [];
  const at = Object.create(null);
  for (const e of j.set) {
    if (!e || typeof e !== 'object') continue;
    const original = typeof e.original === 'string' ? e.original.trim() : '';
    const key = typeof e.key === 'string' ? e.key : '';
    if (!original || !FIELD_KEY_RE.test(key)) continue;
    const value = typeof e.value === 'string' ? e.value.trim().slice(0, FIELD_VALUE_MAX) : '';
    const id = original.toLowerCase() + '\n' + key;
    if (at[id] !== undefined) out[at[id]] = { original, key, value };
    else { at[id] = out.length; out.push({ original, key, value }); }
  }
  return { list: out, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin can never observe a half-written file. */
function writeNpcFields(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, set: list }, null, 2);
  const tmp = NPCF_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, NPCF_FILE);  // MoveFileEx(REPLACE_EXISTING) — atomic, retried past a transient lock
  liveFlush('npc-fields', NPCF_FILE);
}

function mergeNpcField(original, key, value) {
  const cur = readNpcFields();
  const lower = original.toLowerCase();
  const list = cur.list.filter((e) => !(e.original.toLowerCase() === lower && e.key === key));
  list.push({ original, key, value });
  if (list.length > NPCF_MAX) list.splice(0, list.length - NPCF_MAX);
  writeNpcFields(list);
  return list;
}

/* -------------------- the Follower-Organizer-ops sidecar ------------- */

/** A category slot index the sidecar is willing to store. NOT a "does this
 *  category exist" check — that needs the roster and is done in the route; this
 *  is only the absurd-input guard the tolerant parser applies. */
function foCatOk(n) { return Number.isInteger(n) && n >= 1 && n <= FO_CAT_MAX; }

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged.
 *  Deduped exactly like the C++ consumer will apply it — a later MOVE for the
 *  same person (case-insensitive) wins, a later RENAME for the same slot wins —
 *  so what the portal reports as pending is precisely what the game will do. */
function readFoOps() {
  let raw;
  try { raw = fs.readFileSync(FO_OPS_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  const at = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    let rec = null, dedupeKey = null;
    if (e.type === 'move') {
      const original = typeof e.original === 'string' ? e.original.trim() : '';
      const toCat = Number(e.toCat);
      if (!original || !foCatOk(toCat)) continue;
      const toCatName = typeof e.toCatName === 'string' ? e.toCatName.slice(0, FO_CAT_NAME_MAX) : '';
      rec = { type: 'move', original, toCat, toCatName };
      dedupeKey = 'move\n' + original.toLowerCase();
    } else if (e.type === 'setDesc') {
      const original = typeof e.original === 'string' ? e.original.trim() : '';
      if (!original) continue;
      // "" is legal — it clears the note, same as typing it empty in the deck.
      const desc = typeof e.desc === 'string' ? e.desc.slice(0, FO_CAT_NAME_MAX) : '';
      rec = { type: 'setDesc', original, desc };
      dedupeKey = 'desc\n' + original.toLowerCase();
    } else if (e.type === 'delete') {
      const original = typeof e.original === 'string' ? e.original.trim() : '';
      if (!original) continue;
      rec = { type: 'delete', original };
      dedupeKey = 'delete\n' + original.toLowerCase();
    } else if (e.type === 'renameCategory') {
      const cat = Number(e.cat);
      if (!foCatOk(cat)) continue;
      // "" is a legal value — it resets the slot to its original FO name.
      const name = typeof e.name === 'string' ? e.name.trim().slice(0, FO_CAT_NAME_MAX) : '';
      rec = { type: 'renameCategory', cat, name };
      dedupeKey = 'rename\n' + cat;
    } else {
      continue;
    }
    if (at[dedupeKey] !== undefined) out[at[dedupeKey]] = rec;
    else { at[dedupeKey] = out.length; out.push(rec); }
  }
  return { list: out, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin can never observe a half-written file. */
function writeFoOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = FO_OPS_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, FO_OPS_FILE);  // atomic; retried past a transient lock
  liveFlush('fo-ops', FO_OPS_FILE);   // no-op until the DLL maps this kind (see wiring doc)
}

/** Queue one op, replacing any older op it supersedes (see readFoOps dedupe). */
function mergeFoOp(op) {
  const cur = readFoOps();
  let list;
  if (op.type === 'setDesc') {
    const lower = op.original.toLowerCase();
    list = cur.list.filter((e) => !(e.type === 'setDesc' && e.original.toLowerCase() === lower));
  } else if (op.type === 'move' || op.type === 'delete') {
    /* A move and a delete for the SAME person are contradictory — there is no
       sensible order to apply both in — so either one clears the other. Last
       write wins, which is the same rule the rest of this sidecar uses. */
    const lower = op.original.toLowerCase();
    list = cur.list.filter((e) =>
      !((e.type === 'move' || e.type === 'delete') && e.original.toLowerCase() === lower));
  } else { // renameCategory
    list = cur.list.filter((e) => !(e.type === 'renameCategory' && e.cat === op.cat));
  }
  list.push(op);
  if (list.length > FO_OPS_MAX) list.splice(0, list.length - FO_OPS_MAX);
  writeFoOps(list);
  return list;
}

/** Drop queued ops. `sel` null/undefined = clear ALL; otherwise a predicate
 *  removes the ops it matches. Returns { list, removed }. */
function removeFoOps(pred) {
  const cur = readFoOps();
  if (!pred) {
    const removed = cur.list.length;
    if (removed) writeFoOps([]);
    return { list: [], removed };
  }
  const list = cur.list.filter((e) => !pred(e));
  const removed = cur.list.length - list.length;
  if (removed) writeFoOps(list);
  return { list, removed };
}

/* -------------------- the NFF home-bases sidecars -------------------- */

/** The deck's Bases snapshot, always usable: absent/malformed reads as a
 *  friendly "not ready" the phone can render instead of guessing. Its shape is
 *  the very nbOpen model (maxBases, bases[], residents, candidates, times…). */
function readBasesSnapshot() {
  let raw;
  try { raw = fs.readFileSync(BASES_SNAP_FILE, 'utf8'); } catch (_) {
    return { ok: true, nff: false, ready: false, bases: [], candidates: [],
      msg: 'Open the deck’s Bases tab in-game once so it can share your bases here.' };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { ok: true, nff: false, ready: false, bases: [], candidates: [],
      msg: 'The bases snapshot is unreadable — reopen the deck’s Bases tab in-game.' };
  }
  if (!j || typeof j !== 'object') j = {};
  j.ready = j.nff === true;                 // the deck only writes nff:true once NFF answered
  return j;
}

function readBasesOps() {
  let raw;
  try { raw = fs.readFileSync(BASES_OPS_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  return { list: j.ops.filter((e) => e && typeof e === 'object' && typeof e.op === 'string'),
    exists: true, malformed: false };
}

function writeBasesOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = BASES_OPS_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, BASES_OPS_FILE);
  liveFlush('bases-ops', BASES_OPS_FILE);   // no-op unless the DLL live-API maps this kind; the 1s poller applies it either way
}

/** Append one op. Bases ops are discrete actions replayed in order and the deck
 *  drains the whole file each second, so the queue is short-lived — we append
 *  rather than dedupe, only collapsing a repeated toggle of the same (op,base,
 *  kind,formId) target so a fat-fingered double tap doesn't stack. */
function queueBasesOp(op) {
  const cur = readBasesOps();
  const key = (e) => [e.op, e.base, e.kind, e.formId, e.which].join('\n');
  const k = key(op);
  const list = cur.list.filter((e) => key(e) !== k);
  list.push(op);
  if (list.length > BASES_OPS_MAX) list.splice(0, list.length - BASES_OPS_MAX);
  writeBasesOps(list);
  return list;
}

/* -------------------- the category-icon sidecar --------------------- */

/** Parsed queue, always usable: a malformed file reads as empty + flagged.
 *  Deduped exactly like the C++ consumer applies it — a later entry for the
 *  same SLOT wins — so what the portal reports as pending is what the game
 *  will do. Path separators are normalised the way ValidViewIconPath() does,
 *  so a hand-written "icons\custom\x.png" is not silently dropped. */
function readCatIcons() {
  const file = catIconBridgeFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {
    return { list: [], file, exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], file, exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.set)) {
    return { list: [], file, exists: true, malformed: true };
  }
  const out = [];
  const at = Object.create(null);
  for (const e of j.set) {
    if (!e || typeof e !== 'object') continue;
    const cat = Number(e.cat);
    if (!catIconSlotOk(cat)) continue;
    // "" is legal and means CLEAR — the same value the in-game Auto/None tile
    // writes — so it is kept, not filtered out.
    const icon = typeof e.icon === 'string' ? e.icon.replace(/\\/g, '/') : '';
    const rec = { cat, icon };
    if (at[cat] !== undefined) out[at[cat]] = rec;
    else { at[cat] = out.length; out.push(rec); }
  }
  return { list: out, file, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin's reader DISCARDS a queue it cannot
 *  parse, so a half-written file would not merely be retried — it would throw
 *  the phone's change away. Atomic replace makes that unobservable. */
function writeCatIcons(list) {
  const file = catIconBridgeFile();
  if (!ensureDir(path.dirname(file))) throw Object.assign(new Error('Cannot create ' + path.dirname(file)), { code: 500 });
  const body = JSON.stringify({ version: 1, set: list }, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, file);
  liveFlush('cat-icons', file);   // ~1 s poller is the fallback; this is the fast path
}

/** Queue one slot's glyph, replacing anything queued for that slot. */
function mergeCatIcon(cat, icon) {
  const cur = readCatIcons();
  const list = cur.list.filter((e) => e.cat !== cat);
  list.push({ cat, icon });
  if (list.length > CATICON_MAX) list.splice(0, list.length - CATICON_MAX);
  writeCatIcons(list);
  return list;
}

/** Drop queued glyphs. `pred` null = clear ALL. Returns { list, removed }. */
function removeCatIcons(pred) {
  const cur = readCatIcons();
  if (!pred) {
    const removed = cur.list.length;
    if (removed) writeCatIcons([]);
    return { list: [], removed };
  }
  const list = cur.list.filter((e) => !pred(e));
  const removed = cur.list.length - list.length;
  if (removed) writeCatIcons(list);
  return { list, removed };
}

/* ============== the SPELL DECK's category-glyph sidecar ================ *
 *  Twin of portal-cat-icons.json above, for the Spell Deck's rail
 *  (main.cpp MagicConfig::catIcons, ApplyPortalSpellCatIcons). Two deliberate
 *  differences: it lives in the MAGIC view's folder, and entries are keyed by
 *  category NAME — the spell rail has no stable slot index (categories are a
 *  reorderable string array), and the in-game rename migrates the key.
 *  Same seeded+truncated bridge law, so overwrite is probed first.
 * ===================================================================== */
const SPELLCATICON_BASENAME = 'portal-spell-cat-icons.json';
const SPELLCATICON_FILE = path.join(MAGIC_VIEW_DIR, SPELLCATICON_BASENAME);
const SPELLCATICON_MAX = 80;             // absurd-input guard; kMaxSpellCatIcons=64 in C++
const SPELLCAT_NAME_MAX = 64;            // == the C++ apply's name length gate

function spellCatNameOk(s) { return typeof s === 'string' && s.length > 0 && s.length <= SPELLCAT_NAME_MAX; }

function spellCatIconBridgeFile() {
  const ow = path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'MagicDeck', SPELLCATICON_BASENAME);
  try { if (fs.existsSync(ow)) return ow; } catch (_) {}
  return SPELLCATICON_FILE;
}

function readSpellCatIcons() {
  const file = spellCatIconBridgeFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {
    return { list: [], file, exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], file, exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.set)) {
    return { list: [], file, exists: true, malformed: true };
  }
  const out = [];
  const at = Object.create(null);
  for (const e of j.set) {
    if (!e || typeof e !== 'object') continue;
    if (!spellCatNameOk(e.cat)) continue;
    const icon = typeof e.icon === 'string' ? e.icon.replace(/\\/g, '/') : '';
    const rec = { cat: e.cat, icon };
    if (at[e.cat] !== undefined) out[at[e.cat]] = rec;   // later entry per NAME wins
    else { at[e.cat] = out.length; out.push(rec); }
  }
  return { list: out, file, exists: true, malformed: false };
}

function writeSpellCatIcons(list) {
  const file = spellCatIconBridgeFile();
  if (!ensureDir(path.dirname(file))) throw Object.assign(new Error('Cannot create ' + path.dirname(file)), { code: 500 });
  const body = JSON.stringify({ version: 1, set: list }, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, file);
  liveFlush('spell-cat-icons', file);
}

function mergeSpellCatIcon(cat, icon) {
  const cur = readSpellCatIcons();
  const list = cur.list.filter((e) => e.cat !== cat);
  list.push({ cat, icon });
  if (list.length > SPELLCATICON_MAX) list.splice(0, list.length - SPELLCATICON_MAX);
  writeSpellCatIcons(list);
  return list;
}

function removeSpellCatIcons(pred) {
  const cur = readSpellCatIcons();
  if (!pred) {
    const removed = cur.list.length;
    if (removed) writeSpellCatIcons([]);
    return { list: [], removed };
  }
  const list = cur.list.filter((e) => !pred(e));
  const removed = cur.list.length - list.length;
  if (removed) writeSpellCatIcons(list);
  return { list, removed };
}

/** One slot's CURRENT glyph (what the game has on disk), or "". */
function liveCatIcon(cat) { return readCatIconsLive().icons[cat] || ''; }

/** What the deck has RIGHT NOW: the `followers.catIcons` map out of one
 *  hotkeys.json snapshot, read-only and tolerant (a hand-edited key that is not
 *  a slot number, or a value that is not a string, simply is not there). */
/** The Spell Deck rail's CURRENT glyphs (magic.catIcons on disk), by NAME. */
function readSpellCatIconsLive(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, icons: {} };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const magic = (root.magic && typeof root.magic === 'object' && !Array.isArray(root.magic)) ? root.magic : {};
  const raw = (magic.catIcons && typeof magic.catIcons === 'object' && !Array.isArray(magic.catIcons))
    ? magic.catIcons : {};
  const icons = {};
  for (const k of Object.keys(raw)) {
    if (!spellCatNameOk(k)) continue;
    const v = typeof raw[k] === 'string' ? raw[k].replace(/\\/g, '/') : '';
    if (v) icons[k] = v;
  }
  return { ok: true, file: s.file, icons };
}

function readCatIconsLive(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, icons: {} };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const fol = (root.followers && typeof root.followers === 'object' && !Array.isArray(root.followers))
    ? root.followers : {};
  const raw = (fol.catIcons && typeof fol.catIcons === 'object' && !Array.isArray(fol.catIcons))
    ? fol.catIcons : {};
  const icons = {};
  for (const k of Object.keys(raw)) {
    if (!/^\d{1,3}$/.test(k)) continue;
    const idx = Number(k);
    if (!catIconSlotOk(idx)) continue;
    if (typeof raw[k] !== 'string' || !raw[k]) continue;
    icons[idx] = raw[k].replace(/\\/g, '/');
  }
  return { ok: true, file: s.file, icons };
}

/* ----------------------- the finances slice + sidecar --------------- */

/** The `finances` slice out of one hotkeys.json snapshot (read-only). Same
 *  tolerance as ConfigFromJson(): anything not an array/object reads as empty. */
function readFinancesSlice(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, lines: [], market: [], debt: 0, ledger: [] };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const fin = (root.finances && typeof root.finances === 'object' && !Array.isArray(root.finances)) ? root.finances : {};
  return {
    ok: true, file: s.file,
    lines: Array.isArray(fin.lines) ? fin.lines : [],
    market: Array.isArray(fin.market) ? fin.market : [],
    debt: typeof fin.debt === 'number' ? fin.debt : 0,
    ledger: Array.isArray(fin.ledger) ? fin.ledger : [],
  };
}

function finKeyOk(target, key) {
  return target === 'line' ? FIN_LINE_KEYS.includes(key)
    : target === 'market' ? FIN_MARKET_KEYS.includes(key) : false;
}

/* ---------------------------- wardrobe slice --------------------------- */

function readWardrobeSlice(src) {
  const s = src || readHkRoot();
  if (!s.ok) {
    return { ok: false, file: s.file, error: s.error, categories: [], outfitMeta: [], wardrobes: [], assignments: [] };
  }
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const wd = (root.wardrobe && typeof root.wardrobe === 'object' && !Array.isArray(root.wardrobe)) ? root.wardrobe : {};
  return {
    ok: true, file: s.file,
    categories: Array.isArray(wd.categories) ? wd.categories : [],
    outfitMeta: Array.isArray(wd.outfitMeta) ? wd.outfitMeta : [],
    wardrobes: Array.isArray(wd.wardrobes) ? wd.wardrobes : [],
    assignments: Array.isArray(wd.assignments) ? wd.assignments : [],
    settings: (wd.settings && typeof wd.settings === 'object') ? wd.settings : {},
  };
}

/** The persisted NFF slice out of hotkeys.json. Shape mirrors
 *  NffOutfits::ToJson — one row per follower who carries metadata. */
function readNffSlice(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, enabled: true, npcs: [] };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const nf = (root.nffOutfits && typeof root.nffOutfits === 'object' && !Array.isArray(root.nffOutfits))
    ? root.nffOutfits : {};
  return {
    ok: true, file: s.file,
    enabled: nf.enabled !== false,
    npcs: Array.isArray(nf.npcs) ? nf.npcs : [],
  };
}

/** A person, the way both ends key her: the durable formId+plugin pair. */
function nffIdentity(o) {
  return String(o.formId || '') + '|' + String(o.plugin || '');
}

function nffTypeOk(t) {
  return Number.isInteger(t) && t >= 0 && t < NFF_TYPE_COUNT;
}

/** Three blank sets, so a row written by an older build is still indexable. */
function nffBlankSets() {
  return [0, 1, 2].map(() => ({ label: '', icon: '', note: '' }));
}

function readNffOps() {
  let raw;
  try { raw = fs.readFileSync(NFF_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\ufeff/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  const at = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    const id = nffIdentity(e);
    if (id === '|') continue;
    if (e.op === 'set') {
      const key = typeof e.key === 'string' ? e.key : '';
      const type = Number(e.type);
      if (!NFF_SET_KEYS.includes(key) || !nffTypeOk(type)) continue;
      const cap = key === 'label' ? NFF_LABEL_MAX : FIELD_VALUE_MAX;
      const rec = {
        op: 'set', formId: e.formId, plugin: e.plugin, type, key,
        value: typeof e.value === 'string' ? e.value.slice(0, cap) : '',
      };
      if (typeof e.name === 'string' && e.name) rec.name = e.name.slice(0, 120);
      const k = 'set\n' + id + '\n' + type + '\n' + key;
      if (at[k] !== undefined) out[at[k]] = rec; else { at[k] = out.length; out.push(rec); }
    } else if (e.op === 'note') {
      const rec = {
        op: 'note', formId: e.formId, plugin: e.plugin,
        value: typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '',
      };
      if (typeof e.name === 'string' && e.name) rec.name = e.name.slice(0, 120);
      const k = 'note\n' + id;
      if (at[k] !== undefined) out[at[k]] = rec; else { at[k] = out.length; out.push(rec); }
    }
  }
  return { list: out, exists: true, malformed: false };
}

function writeNffOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = NFF_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, NFF_FILE, 10);   // atomic; the plugin never sees a half file
  liveFlush('nff', NFF_FILE);
}

function mergeNffOp(op) {
  const cur = readNffOps();
  const id = nffIdentity(op);
  let list = cur.list;
  if (op.op === 'set') {
    list = list.filter((e) => !(e.op === 'set' && nffIdentity(e) === id && e.type === op.type && e.key === op.key));
  } else if (op.op === 'note') {
    list = list.filter((e) => !(e.op === 'note' && nffIdentity(e) === id));
  }
  list.push(op);
  if (list.length > NFF_MAX) list.splice(0, list.length - NFF_MAX);
  writeNffOps(list);
  return list;
}

/** What the phone should SEE: the persisted slice with pending edits folded on,
 *  so a change shows immediately instead of waiting for the game to replay it.
 *  Rows touched by a pending op are flagged so the UI can say "queued".
 *
 *  WHO IS LISTED, and why it is not the whole roster. The portal identifies a
 *  follower by her ORIGINAL NAME (that is what FollowerOrganizer.json gives us,
 *  and why the fields sidecar needs setFieldByOriginal); the NFF slice
 *  identifies her by the durable formId+plugin pair the game wrote. Joining the
 *  two on a name would be a guess, and a mis-join here would put your notes on
 *  the wrong person. So this lists exactly who the SLICE knows about — the same
 *  rule the Wardrobe view already follows for assignments. A follower appears
 *  the moment the deck has stored anything for her. */
/* The GAME-side truth about NFF sets — which exist, piece counts, who wears
 * what — exported by the plugin (PushNffOpen) whenever the deck's NFF sub-tab
 * opens. Without it the phone sheet is names-and-photos only. */
const NFF_STATUS_CANDIDATES = process.env.DECK_PORTAL_NFF_STATUS
  ? [process.env.DECK_PORTAL_NFF_STATUS]
  : [
    path.join(DECK_VIEW_DIR, 'nff-status.json'),
    path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'HotkeyDeck', 'nff-status.json'),
  ];
function readNffStatus() {
  let best = null;
  for (const f of NFF_STATUS_CANDIDATES) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
  }
  if (!best) return { ok: false, npcs: [] };
  try {
    const j = JSON.parse(fs.readFileSync(best.file, 'utf8').replace(/^﻿/, ''));
    if (j && Array.isArray(j.npcs)) {
      return { ok: true, file: best.file, ageHours: (Date.now() - best.mtimeMs) / 36e5,
        slotsUsed: j.slotsUsed, slotsMax: j.slotsMax, npcs: j.npcs };
    }
  } catch (_) { /* torn write mid-export: next read gets it */ }
  return { ok: false, npcs: [] };
}
function nffStatusKey(formId, plugin) {
  return String(formId || '').toUpperCase() + '|' + String(plugin || '').toLowerCase();
}

function nffView() {
  const slice = readNffSlice();
  const pend = readNffOps();

  const byId = Object.create(null);
  const rows = [];
  const rowFor = (formId, plugin, name) => {
    const id = String(formId || '') + '|' + String(plugin || '');
    if (byId[id]) {
      if (name && !byId[id].name) byId[id].name = name;
      return byId[id];
    }
    const r = { formId: formId || '', plugin: plugin || '', name: name || '',
      sets: nffBlankSets(), note: '', claimed: false, pending: false };
    byId[id] = r;
    rows.push(r);
    return r;
  };

  for (const n of slice.npcs) {
    if (!n || !n.formId) continue;
    const r = rowFor(n.formId, n.plugin, n.name);
    r.note = typeof n.note === 'string' ? n.note : '';
    r.claimed = !!n.claimed;
    const sets = Array.isArray(n.sets) ? n.sets : [];
    for (let t = 0; t < NFF_TYPE_COUNT; t++) {
      const src = sets[t] && typeof sets[t] === 'object' ? sets[t] : {};
      r.sets[t] = { label: src.label || '', icon: src.icon || '', note: src.note || '' };
    }
  }
  // A queued edit for someone the slice has not caught up with yet still shows,
  // rather than vanishing until the game next writes.
  for (const o of pend.list) {
    const r = rowFor(o.formId, o.plugin, o.name);
    r.pending = true;
    if (o.op === 'note') r.note = o.value;
    else r.sets[o.type][o.key] = o.value;
  }

  /* Join the game-side status on: set existence, piece counts, worn-now.
     People NFF holds who have no metadata yet still get a row, so the list
     matches what the game shows instead of only who was annotated. */
  const status = readNffStatus();
  if (status.ok) {
    const sBy = Object.create(null);
    status.npcs.forEach((n) => { if (n && n.formId) sBy[nffStatusKey(n.formId, n.plugin)] = n; });
    status.npcs.forEach((n) => {
      if (!n || !n.formId) return;
      if (typeof n.slot === 'number' && n.slot < 0) return;   // NFF holds nothing for her
      rowFor(n.formId, n.plugin, n.name);
    });
    rows.forEach((r) => {
      const s = sBy[nffStatusKey(r.formId, r.plugin)];
      if (!s) return;
      if (Array.isArray(s.have)) r.have = s.have;
      if (Array.isArray(s.counts)) r.counts = s.counts;
      if (typeof s.worn === 'number') r.worn = s.worn;
      if (typeof s.slot === 'number') r.slot = s.slot;
    });
  }

  rows.forEach((r) => {
    r.label = NFF_TYPE_NAME.map((n, t) => r.sets[t].label || n);
  });
  rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  return {
    file: slice.file, ok: slice.ok, error: slice.error,
    enabled: slice.enabled,
    types: NFF_TYPE_NAME,
    npcs: rows,
    statusOk: status.ok,
    statusAgeHours: status.ok ? Math.round(status.ageHours * 10) / 10 : null,
    slotsUsed: status.ok ? status.slotsUsed : undefined,
    slotsMax: status.ok ? status.slotsMax : undefined,
    pending: pend.list.length, pendingFile: NFF_FILE, malformed: pend.malformed,
  };
}

/* ============ My Home is Your Home: the day, read and queued ============ */

/** The plugin's export, or an honest empty. Newest candidate wins (the same
 *  rule readNffStatus uses: under MO2 the game's write may land in Overwrite). */
function readMhiyhStatus() {
  let best = null;
  for (const f of MHIYH_STATUS_CANDIDATES) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
  }
  if (!best) return { ok: false, installed: false, npcs: [] };
  try {
    const j = JSON.parse(fs.readFileSync(best.file, 'utf8').replace(/^﻿/, ''));
    if (j && Array.isArray(j.npcs)) {
      return {
        ok: true, file: best.file, installed: !!j.mhiyh,
        ageHours: (Date.now() - best.mtimeMs) / 36e5,
        npcs: j.npcs,
      };
    }
  } catch (_) { /* torn write mid-export: the next read gets it */ }
  return { ok: false, installed: false, npcs: [] };
}

/** The op's de-dupe identity: one HOME decision per person, one decision per
 *  person+stop. setHome and forgetHome are contradictory answers to the same
 *  question, so they must collapse onto each other rather than both surviving. */
function mhiyhIdentity(o) {
  const who = String(o.original || '').toLowerCase();
  return (o.op === 'setHome' || o.op === 'forgetHome')
    ? 'home\n' + who
    : 'spot\n' + who + '\n' + o.kind;
}

function mhiyhKindOk(k) { return Number.isInteger(k) && MHIYH_SETTABLE.includes(k); }

/** A kind number as words, for a message. A kind this build has never heard of
 *  is named honestly rather than dropped — same rule as the deck pane's
 *  actSpec(). */
function mhiyhKindLabel(k) {
  const spec = MHIYH_KINDS.find((a) => a.k === k);
  return spec ? spec.label : ('Activity ' + k);
}

function readMhiyhOps() {
  let raw;
  try { raw = fs.readFileSync(MHIYH_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  const at = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    if (!MHIYH_OPS.includes(e.op)) continue;
    const original = typeof e.original === 'string' ? e.original.trim() : '';
    if (!original) continue;
    const spot = e.op === 'setSpot' || e.op === 'clearSpot';
    const kind = Number(e.kind);
    if (spot && !mhiyhKindOk(kind)) continue;
    const rec = {
      op: e.op, original,
      formId: typeof e.formId === 'string' ? e.formId.trim() : '',
      name: typeof e.name === 'string' ? e.name.slice(0, 120) : '',
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0,
    };
    // NEVER carried on a home op: MarkHome/MoveHome take an actor and nothing
    // else, and a stray kind:0 on the wire reads as "the zeroth stop".
    if (spot) rec.kind = kind;
    const k = mhiyhIdentity(rec);
    if (at[k] !== undefined) out[at[k]] = rec; else { at[k] = out.length; out.push(rec); }
  }
  return { list: out, exists: true, malformed: false };
}

function writeMhiyhOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = MHIYH_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, MHIYH_FILE, 10);   // atomic; the plugin never sees half a file
  liveFlush('mhiyh', MHIYH_FILE);
}

function mergeMhiyhOp(op) {
  const cur = readMhiyhOps();
  const id = mhiyhIdentity(op);
  const list = cur.list.filter((e) => mhiyhIdentity(e) !== id);
  list.push(op);
  if (list.length > MHIYH_MAX) list.splice(0, list.length - MHIYH_MAX);
  writeMhiyhOps(list);
  return list;
}

/** Drop every queued op for one person (the undo), or one stop of hers. */
function dropMhiyhOps(original, kind) {
  const who = String(original || '').toLowerCase();
  const cur = readMhiyhOps();
  const list = cur.list.filter((e) => {
    if (String(e.original || '').toLowerCase() !== who) return true;
    if (kind === undefined || kind === null || kind === '') return false;   // all of hers
    return e.kind !== Number(kind);
  });
  const dropped = cur.list.length - list.length;
  if (dropped) writeMhiyhOps(list);
  return { dropped, list };
}

/** What the phone should SEE: the game's export with the queue folded on.
 *
 *  WHO IS LISTED is the export's own list — every follower the deck's roster
 *  knew about at the last push, whether or not MHiYH holds anything for her,
 *  because "she has no home yet" is exactly the state you open the sheet to
 *  fix. With no export at all this is honestly empty rather than a guess: a
 *  phone cannot see whether the mod is installed, who is following, or where
 *  anybody is standing. */
function mhiyhView() {
  const status = readMhiyhStatus();
  const pend = readMhiyhOps();

  const pendByName = Object.create(null);
  for (const o of pend.list) {
    const k = o.original.toLowerCase();
    (pendByName[k] = pendByName[k] || []).push(o);
  }
  const matched = Object.create(null);

  const npcs = (status.npcs || []).map((n) => {
    const original = String((n && n.original) || '');
    const acts = Array.isArray(n && n.acts) ? n.acts.filter((a) => a && Number.isInteger(a.k)) : [];
    const queued = pendByName[original.toLowerCase()] || [];
    if (queued.length) matched[original.toLowerCase()] = true;
    const now = acts.filter((a) => a.now).map((a) => a.k);
    return {
      original,
      name: String((n && n.name) || original),
      formId: String((n && n.formId) || ''),
      following: !!(n && n.following),
      inWorld: !!(n && n.inWorld),
      dead: !!(n && n.dead),
      home: String((n && n.home) || ''),
      flagged: !!(n && n.flagged),
      acts: acts.map((a) => ({ k: a.k, place: String(a.place || ''), now: !!a.now })),
      now,
      // The queue, verbatim, so the sheet can badge the exact row it touches
      // instead of showing one "pending" blob per person.
      pending: queued.map((o) => ({ op: o.op, kind: o.kind, at: o.at })),
    };
  });

  // A queued op for somebody the export no longer lists (renamed in game,
  // dropped from FO). The C++ side skips and clears those; surfacing them is
  // what makes that visible rather than mysterious.
  const unknown = [];
  for (const k of Object.keys(pendByName)) {
    if (!matched[k]) unknown.push(pendByName[k][0].original);
  }

  return {
    // `installed` is the mod, `statusOk` is our knowledge of it. They differ
    // in the case that matters: no export yet (game never run since the deck
    // gained this feature) is NOT "MHiYH is missing".
    installed: !!status.installed,
    statusOk: !!status.ok,
    statusFile: status.file || null,
    statusAgeHours: status.ok ? Math.round(status.ageHours * 10) / 10 : null,
    kinds: MHIYH_KINDS,
    settable: MHIYH_SETTABLE,
    positional: MHIYH_POSITIONAL,
    ttlMs: MHIYH_TTL_MS,
    npcs,
    pending: pend.list.length,
    pendingUnknown: unknown,
    pendingFile: MHIYH_FILE,
    malformed: pend.malformed,
  };
}

function wdKeyOk(target, key) {
  return target === 'outfit' ? WD_OUTFIT_KEYS.includes(key)
    : target === 'assign' ? WD_ASSIGN_KEYS.includes(key) : false;
}

/** The identity a "set" dedupes on: an outfit is keyed by name, a person by
 *  formId+plugin — the same durable pair wardrobe.cpp persists. */
function wdIdentity(o) {
  return o.target === 'outfit' ? String(o.name || '') : String(o.formId || '') + '|' + String(o.plugin || '');
}

/** Validate + normalise a value for a given assign key, or null if unusable. */
function wdAssignValue(key, raw) {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (key === 'mode') return WD_MODES.includes(v) ? v : null;
  if (key === 'cadenceHours') {
    const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(n)) return null;
    return String(Math.max(0, Math.min(WD_CADENCE_MAX, n)));
  }
  return v.slice(0, FIELD_VALUE_MAX);   // wardrobeId / outfit — "" clears
}


/* ---------------------------- inventory feed --------------------------- */

/* Slot names TailorHelper reports, in the order a person is dressed. "Unknown"
   is real — jewellery from mods like Immersive Jewelry uses slots its switch
   doesn't name — so it is kept and sorted last rather than hidden. */
const INV_SLOT_ORDER = ['Body', 'Head', 'Hair', 'Circlet', 'Hands', 'Forearms',
  'Feet', 'Calves', 'Shield', 'Amulet', 'Ring', 'Unknown'];

function invSlotRank(slot) {
  const i = INV_SLOT_ORDER.indexOf(slot);
  return i === -1 ? INV_SLOT_ORDER.length : i;
}

/** Newest readable inventory export wins, so a stale copy never shadows a fresh one. */
function readInventory() {
  let best = null;
  for (const file of INVENTORY_CANDIDATES) {
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
  }
  if (!best) return { ok: false, error: 'No inventory export found — TailorHelper writes it when armour moves in or out of your inventory.', items: [], files: INVENTORY_CANDIDATES };
  let j;
  try { j = JSON.parse(fs.readFileSync(best.file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    return { ok: false, error: 'Inventory export did not parse: ' + e.message, items: [], file: best.file };
  }
  const raw = Array.isArray(j && j.items) ? j.items : [];
  const seen = Object.create(null);
  const items = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) continue;                       // unnamed / FakeItem rows
    const plugin = typeof it.plugin === 'string' ? it.plugin : '';
    // TailorHelper writes the LOCAL id in decimal; everything else in the
    // wardrobe system speaks hex. Normalise here, once.
    const num = Number(it.formId);
    if (!Number.isFinite(num) || num <= 0) continue;
    const formId = '0x' + (num >>> 0).toString(16).toUpperCase();
    const key = formId + '|' + plugin;
    if (seen[key]) continue;
    seen[key] = 1;
    items.push({
      formId, plugin, name,
      slot: typeof it.slot === 'string' && it.slot ? it.slot : 'Unknown',
      type: typeof it.type === 'string' ? it.type : '',
      armorRating: Number(it.armorRating) || 0,
      enchanted: !!it.enchanted,
    });
  }
  items.sort((a, b) => (invSlotRank(a.slot) - invSlotRank(b.slot)) || a.name.localeCompare(b.name));
  const bySlot = {};
  items.forEach((i) => { (bySlot[i.slot] = bySlot[i.slot] || []).push(i); });
  return {
    ok: true, file: best.file, mtime: Math.round(best.mtimeMs),
    ageHours: Math.round((Date.now() - best.mtimeMs) / 36000) / 100,
    total: items.length, items, bySlot,
    slots: Object.keys(bySlot).sort((a, b) => invSlotRank(a) - invSlotRank(b)),
  };
}

/** Validate an outfit-build request from the phone (or from Claude over the API). */
function wdBuildRequest(body) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, WD_OUTFIT_NAME_MAX) : '';
  if (!name) throw Object.assign(new Error('name is required'), { code: 400 });
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw Object.assign(new Error('items must be a non-empty array of {formId, plugin}'), { code: 400 });
  if (raw.length > WD_OUTFIT_PIECES_MAX) {
    throw Object.assign(new Error('That is ' + raw.length + ' pieces; the cap is ' + WD_OUTFIT_PIECES_MAX), { code: 400 });
  }
  const items = [];
  const seen = Object.create(null);
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    let fid = typeof it.formId === 'string' ? it.formId.trim()
      : (typeof it.formId === 'number' ? '0x' + (it.formId >>> 0).toString(16).toUpperCase() : '');
    if (/^[0-9]+$/.test(fid)) fid = '0x' + (Number(fid) >>> 0).toString(16).toUpperCase();
    if (!/^0x[0-9a-fA-F]{1,8}$/.test(fid)) continue;
    const plugin = typeof it.plugin === 'string' ? it.plugin.trim().slice(0, 128) : '';
    const key = fid.toUpperCase() + '|' + plugin.toLowerCase();
    if (seen[key]) continue;                    // the same piece twice is a no-op
    seen[key] = 1;
    items.push({ formId: fid, plugin, name: typeof it.name === 'string' ? it.name.slice(0, FIELD_VALUE_MAX) : '' });
  }
  if (!items.length) throw Object.assign(new Error('No usable pieces — each needs a formId (hex or decimal) and a plugin'), { code: 400 });
  return { name, items };
}

function readWardrobeOps() {
  let raw;
  try { raw = fs.readFileSync(WARDROBE_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  const setAt = Object.create(null);
  const imgAt = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    if (e.op === 'image') {
      const outfit = typeof e.outfit === 'string' ? e.outfit : '';
      if (!outfit) continue;
      const rec = { op: 'image', outfit, value: typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '' };
      if (imgAt[outfit] !== undefined) out[imgAt[outfit]] = rec;
      else { imgAt[outfit] = out.length; out.push(rec); }
    } else if (e.op === 'set') {
      const target = e.target;
      const key = typeof e.key === 'string' ? e.key : '';
      if (!wdKeyOk(target, key)) continue;
      const id = wdIdentity(e);
      if (!id || id === '|') continue;
      const value = typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '';
      const rec = target === 'outfit'
        ? { op: 'set', target, name: e.name, key, value }
        : { op: 'set', target, formId: e.formId, plugin: e.plugin, key, value };
      const k = target + '\n' + id + '\n' + key;
      if (setAt[k] !== undefined) out[setAt[k]] = rec;
      else { setAt[k] = out.length; out.push(rec); }
    } else if (e.op === 'outfit-new') {
      // Build a REAL SOES outfit out of inventory pieces. Deduped by name: the
      // last build wins, so re-sending after a typo doesn't make two outfits.
      const nm = typeof e.name === 'string' ? e.name.slice(0, WD_OUTFIT_NAME_MAX) : '';
      if (!nm || !Array.isArray(e.items) || !e.items.length) continue;
      const rec = { op: 'outfit-new', name: nm, items: e.items.slice(0, WD_OUTFIT_PIECES_MAX) };
      const bk = 'new\n' + nm;
      if (setAt[bk] !== undefined) out[setAt[bk]] = rec;
      else { setAt[bk] = out.length; out.push(rec); }
    } else if (e.op === 'outfit-del') {
      const nm = typeof e.name === 'string' ? e.name.slice(0, WD_OUTFIT_NAME_MAX) : '';
      if (nm) out.push({ op: 'outfit-del', name: nm });
    } else if (e.op === 'pool') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (!id) continue;
      const rec = { op: 'pool', id };
      // add and remove are kept as separate ops on purpose — dropping the older
      // one would lose an add/remove/add sequence the phone made deliberately.
      if (typeof e.add === 'string' && e.add) rec.add = e.add.slice(0, FIELD_VALUE_MAX);
      if (typeof e.remove === 'string' && e.remove) rec.remove = e.remove.slice(0, FIELD_VALUE_MAX);
      if (rec.add || rec.remove) out.push(rec);
    } else if (e.op === 'pool-new') {
      // Deduped by id (the plugin is idempotent by id too) — re-sending after
      // a rename in the same batch just updates the queued creation.
      const id = typeof e.id === 'string' ? e.id : '';
      const nm = typeof e.name === 'string' ? e.name.slice(0, WD_POOL_NAME_MAX) : '';
      if (!id || !nm) continue;
      const rec = { op: 'pool-new', id, name: nm };
      if (typeof e.hue === 'number' && isFinite(e.hue)) rec.hue = Math.max(0, Math.min(359, Math.round(e.hue)));
      if (WD_POOL_MODES.includes(e.mode)) rec.mode = e.mode;
      if (Array.isArray(e.outfits)) {
        rec.outfits = e.outfits.filter((x) => typeof x === 'string' && x)
          .map((x) => x.slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX);
      }
      const nk = 'pnew\n' + id;
      if (setAt[nk] !== undefined) out[setAt[nk]] = rec;
      else { setAt[nk] = out.length; out.push(rec); }
    } else if (e.op === 'pool-del') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (id) out.push({ op: 'pool-del', id });
    } else if (e.op === 'pool-set') {
      const id = typeof e.id === 'string' ? e.id : '';
      const key = typeof e.key === 'string' ? e.key : '';
      if (!id || !WD_POOL_KEYS.includes(key)) continue;
      const rec = { op: 'pool-set', id, key, value: typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '' };
      const sk = 'pset\n' + id + '\n' + key;
      if (setAt[sk] !== undefined) out[setAt[sk]] = rec;
      else { setAt[sk] = out.length; out.push(rec); }
    } else if (e.op === 'pool-order') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (!id || !Array.isArray(e.outfits)) continue;
      const rec = { op: 'pool-order', id,
        outfits: e.outfits.filter((x) => typeof x === 'string' && x)
          .map((x) => x.slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX) };
      const ok2 = 'pord\n' + id;
      if (setAt[ok2] !== undefined) out[setAt[ok2]] = rec;
      else { setAt[ok2] = out.length; out.push(rec); }
    } else if (e.op === 'pools-order') {
      if (!Array.isArray(e.ids)) continue;
      const rec = { op: 'pools-order',
        ids: e.ids.filter((x) => typeof x === 'string' && x)
          .map((x) => x.slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX) };
      const wk = 'wsord';   // singleton: the last full ordering wins
      if (setAt[wk] !== undefined) out[setAt[wk]] = rec;
      else { setAt[wk] = out.length; out.push(rec); }
    } else if (e.op === 'cat-new') {
      const id = typeof e.id === 'string' ? e.id : '';
      const nm = typeof e.name === 'string' ? e.name.slice(0, WD_POOL_NAME_MAX) : '';
      if (!id || !nm) continue;
      const rec = { op: 'cat-new', id, name: nm };
      if (typeof e.hue === 'number' && isFinite(e.hue)) rec.hue = Math.max(0, Math.min(359, Math.round(e.hue)));
      const ck = 'cnew\n' + id;
      if (setAt[ck] !== undefined) out[setAt[ck]] = rec;
      else { setAt[ck] = out.length; out.push(rec); }
    } else if (e.op === 'cat-del') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (id) out.push({ op: 'cat-del', id });
    } else if (e.op === 'cat-set') {
      const id = typeof e.id === 'string' ? e.id : '';
      const key = typeof e.key === 'string' ? e.key : '';
      if (!id || !['name', 'hue'].includes(key)) continue;
      const rec = { op: 'cat-set', id, key, value: typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '' };
      const sk = 'cset\n' + id + '\n' + key;
      if (setAt[sk] !== undefined) out[setAt[sk]] = rec;
      else { setAt[sk] = out.length; out.push(rec); }
    } else if (e.op === 'outfit-cats') {
      // the outfit's WHOLE tag list, replace-not-merge; deduped by outfit
      const nm = typeof e.name === 'string' ? e.name.slice(0, WD_OUTFIT_NAME_MAX) : '';
      if (!nm || !Array.isArray(e.categoryIds)) continue;
      const rec = { op: 'outfit-cats', name: nm,
        categoryIds: e.categoryIds.filter((x) => typeof x === 'string' && x).slice(0, 50) };
      const ok3 = 'ocats\n' + nm;
      if (setAt[ok3] !== undefined) out[setAt[ok3]] = rec;
      else { setAt[ok3] = out.length; out.push(rec); }
    } else if (e.op === 'loc-set') {
      // One override per person+location type; the last write wins. loc stays
      // a NUMBER — the C++ reads it with op.value("loc", -1). The target is a
      // wardrobe (rolls fresh) OR a pinned outfit (base-SOES: always that one).
      const fid = typeof e.formId === 'string' ? e.formId : '';
      const loc = (typeof e.loc === 'number' && isFinite(e.loc)) ? Math.round(e.loc) : -1;
      if (!fid || loc < 0 || loc > WD_LOC_MAX) continue;
      const rec = { op: 'loc-set', formId: fid,
        plugin: typeof e.plugin === 'string' ? e.plugin : '', loc,
        wardrobeId: typeof e.wardrobeId === 'string' ? e.wardrobeId.slice(0, FIELD_VALUE_MAX) : '',
        outfit: typeof e.outfit === 'string' ? e.outfit.slice(0, FIELD_VALUE_MAX) : '' };
      const lk = 'loc\n' + rec.formId + '|' + rec.plugin + '\n' + loc;
      if (setAt[lk] !== undefined) out[setAt[lk]] = rec;
      else { setAt[lk] = out.length; out.push(rec); }
    }
  }
  return { list: out, exists: true, malformed: false };
}

function writeWardrobeOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = WARDROBE_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, WARDROBE_FILE);  // atomic
  liveFlush('wardrobe', WARDROBE_FILE);
}

function mergeWardrobeOp(op) {
  const cur = readWardrobeOps();
  let list = cur.list;
  if (op.op === 'set') {
    const id = wdIdentity(op);
    list = list.filter((e) => !(e.op === 'set' && e.target === op.target && wdIdentity(e) === id && e.key === op.key));
  } else if (op.op === 'image') {
    list = list.filter((e) => !(e.op === 'image' && e.outfit === op.outfit));
  } else if (op.op === 'outfit-new') {
    list = list.filter((e) => !(e.op === 'outfit-new' && e.name === op.name));
  } else if (op.op === 'pool-new') {
    list = list.filter((e) => !(e.op === 'pool-new' && e.id === op.id));
  } else if (op.op === 'pool-set') {
    list = list.filter((e) => !(e.op === 'pool-set' && e.id === op.id && e.key === op.key));
  } else if (op.op === 'pool-order') {
    list = list.filter((e) => !(e.op === 'pool-order' && e.id === op.id));
  } else if (op.op === 'pools-order') {
    list = list.filter((e) => e.op !== 'pools-order');
  } else if (op.op === 'loc-set') {
    list = list.filter((e) => !(e.op === 'loc-set' && e.formId === op.formId &&
      e.plugin === op.plugin && e.loc === op.loc));
  } else if (op.op === 'cat-new') {
    list = list.filter((e) => !(e.op === 'cat-new' && e.id === op.id));
  } else if (op.op === 'cat-set') {
    list = list.filter((e) => !(e.op === 'cat-set' && e.id === op.id && e.key === op.key));
  } else if (op.op === 'outfit-cats') {
    list = list.filter((e) => !(e.op === 'outfit-cats' && e.name === op.name));
  } else if (op.op === 'cat-del') {
    // deleting a queued-but-not-yet-created category cancels the creation
    const wasQueuedCat = list.some((e) => e.op === 'cat-new' && e.id === op.id);
    list = list.filter((e) => !((e.op === 'cat-new' || e.op === 'cat-set') && e.id === op.id));
    if (wasQueuedCat) { writeWardrobeOps(list); return list; }
  } else if (op.op === 'pool-del') {
    // Deleting a queued-but-not-yet-created wardrobe cancels the creation and
    // everything queued against it — the game never needs to see either.
    const wasQueued = list.some((e) => e.op === 'pool-new' && e.id === op.id);
    list = list.filter((e) => !(
      (e.op === 'pool-new' || e.op === 'pool-set' || e.op === 'pool-order' || e.op === 'pool') && e.id === op.id));
    if (wasQueued) { writeWardrobeOps(list); return list; }
  }
  list.push(op);
  if (list.length > WARDROBE_MAX) list.splice(0, list.length - WARDROBE_MAX);
  writeWardrobeOps(list);
  return list;
}

/** What the phone should SEE: the persisted wardrobe slice with pending edits
 *  folded on, so a change shows immediately instead of waiting for the game to
 *  replay it. Rows touched by a pending op are flagged `pending` so the UI can
 *  say "queued — lands next time you open the tab". */
function wardrobeView() {
  const slice = readWardrobeSlice();
  const pend = readWardrobeOps();
  const imgBy = Object.create(null);
  const setOutfit = Object.create(null);
  const setAssign = Object.create(null);
  const poolOps = [];
  const builds = [];                       // queued outfit-new
  const deletes = Object.create(null);     // queued outfit-del
  const poolNews = [];                     // queued pool-new (provisional wardrobes)
  const poolDels = Object.create(null);    // queued pool-del
  const poolSets = Object.create(null);    // id\nkey -> value
  const poolOrders = Object.create(null);  // id -> [outfit names]
  let poolsOrder = null;                   // queued pools-order ids
  const locSets = [];                      // queued loc-set (per-location overrides)
  const catNews = [];                      // queued cat-new (provisional categories)
  const catDels = Object.create(null);
  const catSets = Object.create(null);     // id\nkey -> value
  const outfitCats = Object.create(null);  // outfit name -> categoryIds
  for (const o of pend.list) {
    if (o.op === 'image') imgBy[o.outfit] = o.value;
    else if (o.op === 'pool') poolOps.push(o);
    else if (o.op === 'outfit-new') builds.push(o);
    else if (o.op === 'outfit-del') deletes[o.name] = true;
    else if (o.op === 'pool-new') poolNews.push(o);
    else if (o.op === 'pool-del') poolDels[o.id] = true;
    else if (o.op === 'pool-set') poolSets[o.id + '\n' + o.key] = o.value;
    else if (o.op === 'pool-order') poolOrders[o.id] = o.outfits;
    else if (o.op === 'pools-order') poolsOrder = o.ids;
    else if (o.op === 'loc-set') locSets.push(o);
    else if (o.op === 'cat-new') catNews.push(o);
    else if (o.op === 'cat-del') catDels[o.id] = true;
    else if (o.op === 'cat-set') catSets[o.id + '\n' + o.key] = o.value;
    else if (o.op === 'outfit-cats') outfitCats[o.name] = o.categoryIds;
    else if (o.target === 'outfit') setOutfit[o.name + '\n' + o.key] = o.value;
    else setAssign[wdIdentity(o) + '\n' + o.key] = o.value;
  }

  const outfitMeta = slice.outfitMeta.map((m) => {
    const out = Object.assign({}, m);
    let pending = false;
    if (imgBy[m.name] !== undefined) { out.image = imgBy[m.name]; pending = true; }
    for (const key of WD_OUTFIT_KEYS) {
      const v = setOutfit[m.name + '\n' + key];
      if (v === undefined) continue;
      out[key] = key === 'fav' ? (v === '1' || v === 'true') : v;
      pending = true;
    }
    if (pending) out.pending = true;
    return out;
  });
  // an image or note queued for an outfit we hold no metadata row for yet
  const known = Object.create(null);
  outfitMeta.forEach((m) => { known[m.name] = true; });
  Object.keys(imgBy).forEach((name) => {
    if (known[name]) return;
    known[name] = true;
    outfitMeta.push({ name, image: imgBy[name], note: '', categoryIds: [], fav: false, pending: true, provisional: true });
  });
  /* An outfit you just BUILT does not exist in the game yet, but you must be able
     to photograph it and drop it into a wardrobe straight away — so it shows as
     provisional, carrying its piece list, until the game replays it. */
  builds.forEach((b) => {
    const row = outfitMeta.find((m) => m.name === b.name);
    if (row) { row.pending = true; row.pieces = b.items.length; row.items = b.items; return; }
    known[b.name] = true;
    outfitMeta.push({
      name: b.name, image: imgBy[b.name] || '', note: '', categoryIds: [], fav: false,
      pending: true, provisional: true, building: true, pieces: b.items.length, items: b.items,
    });
  });
  /* Fold in SOES-NG's OWN catalogue, so every real outfit shows up whether or
     not the deck holds metadata for it — this is what makes the outfit lists
     and the "One outfit" dropdown match what the game shows. Piece names are
     filled from the inventory export where the piece is one the player holds. */
  const soes = readSoesCatalogue();
  if (soes.ok) {
    const inv2 = readInventory();
    const nameBy = Object.create(null);
    if (inv2.ok) inv2.items.forEach((i) => {
      nameBy[String(i.formId).toUpperCase() + '|' + String(i.plugin).toLowerCase()] = i.name;
    });
    soes.outfits.forEach((o) => {
      const items = o.items.map((it) => ({
        formId: it.formId, plugin: it.plugin,
        name: it.name || nameBy[String(it.formId).toUpperCase() + '|' + String(it.plugin).toLowerCase()] || '',
        slot: it.slot || '', missing: !!it.missing,
      }));
      wdIconFlag(items);
      const row = outfitMeta.find((m) => m.name === o.name);
      if (row) {
        row.soes = true;
        if (row.pieces === undefined) { row.pieces = items.length; row.items = items; }
        return;
      }
      known[o.name] = true;
      outfitMeta.push({ name: o.name, image: imgBy[o.name] || '', note: '', categoryIds: [],
        fav: o.fav, soes: true, pieces: items.length, items });
    });
  }
  /* Categories, with pending folds — same treatment as wardrobes. */
  let categories = slice.categories.map((c) => {
    const out = Object.assign({}, c);
    let pending = false;
    for (const key of ['name', 'hue']) {
      const v = catSets[c.id + '\n' + key];
      if (v === undefined) continue;
      out[key] = key === 'hue' ? (parseInt(v, 10) || 0) : v;
      pending = true;
    }
    if (catDels[c.id]) { out.deleting = true; pending = true; }
    if (pending) out.pending = true;
    return out;
  });
  catNews.forEach((o) => {
    if (categories.some((c) => c.id === o.id) || catDels[o.id]) return;
    const row = { id: o.id, name: o.name, hue: typeof o.hue === 'number' ? o.hue : 38,
      pending: true, provisional: true };
    for (const key of ['name', 'hue']) {   // a rename queued on a still-provisional category
      const v = catSets[o.id + '\n' + key];
      if (v !== undefined) row[key] = key === 'hue' ? (parseInt(v, 10) || 0) : v;
    }
    categories.push(row);
  });

  /* Queued tag lists land on the rows (which by now include catalogue rows). */
  Object.keys(outfitCats).forEach((nm) => {
    const row = outfitMeta.find((m) => m.name === nm);
    if (row) { row.categoryIds = outfitCats[nm]; row.pending = true; return; }
    outfitMeta.push({ name: nm, image: imgBy[nm] || '', note: '', fav: false,
      categoryIds: outfitCats[nm], pending: true, provisional: true });
  });

  // one queued for deletion should read as going, not gone
  outfitMeta.forEach((m) => { if (deletes[m.name]) { m.pending = true; m.deleting = true; } });

  let wardrobes = slice.wardrobes.map((w) => {
    const out = Object.assign({}, w, { outfits: Array.isArray(w.outfits) ? w.outfits.slice() : [] });
    let pending = false;
    for (const o of poolOps) {
      if (o.id !== w.id) continue;
      if (o.add && out.outfits.indexOf(o.add) === -1) { out.outfits.push(o.add); pending = true; }
      if (o.remove) {
        const i = out.outfits.indexOf(o.remove);
        if (i !== -1) { out.outfits.splice(i, 1); pending = true; }
      }
    }
    for (const key of WD_POOL_KEYS) {
      const v = poolSets[w.id + '\n' + key];
      if (v === undefined) continue;
      out[key] = key === 'hue' ? (parseInt(v, 10) || 0) : v;
      pending = true;
    }
    if (poolOrders[w.id]) {
      // Mirror the plugin's rule: listed members first in the given order,
      // unlisted members keep their relative order behind them.
      const want = poolOrders[w.id];
      const next = want.filter((nm) => out.outfits.indexOf(nm) !== -1);
      out.outfits.forEach((nm) => { if (next.indexOf(nm) === -1) next.push(nm); });
      if (next.join('\n') !== out.outfits.join('\n')) { out.outfits = next; pending = true; }
    }
    if (poolDels[w.id]) { out.deleting = true; pending = true; }
    if (pending) out.pending = true;
    return out;
  });
  // A wardrobe you just made does not exist in the game yet, but you must be
  // able to fill it and assign it straight away — same rule as a built outfit.
  poolNews.forEach((o) => {
    if (wardrobes.some((w) => w.id === o.id) || poolDels[o.id]) return;
    const w = { id: o.id, name: o.name, hue: typeof o.hue === 'number' ? o.hue : 38,
      note: '', mode: o.mode || 'bag', outfits: Array.isArray(o.outfits) ? o.outfits.slice() : [],
      pending: true, provisional: true };
    for (const o2 of poolOps) {
      if (o2.id !== w.id) continue;
      if (o2.add && w.outfits.indexOf(o2.add) === -1) w.outfits.push(o2.add);
      if (o2.remove) {
        const i = w.outfits.indexOf(o2.remove);
        if (i !== -1) w.outfits.splice(i, 1);
      }
    }
    for (const key of WD_POOL_KEYS) {
      const v = poolSets[w.id + '\n' + key];
      if (v !== undefined) w[key] = key === 'hue' ? (parseInt(v, 10) || 0) : v;
    }
    wardrobes.push(w);
  });
  if (poolsOrder) {
    const rank = (w) => {
      const i = poolsOrder.indexOf(w.id);
      return i === -1 ? poolsOrder.length : i;
    };
    wardrobes = wardrobes.map((w, i) => [w, i])
      .sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1]))
      .map((p) => p[0]);
  }

  const assignments = slice.assignments.map((a) => {
    const out = Object.assign({}, a);
    const id = wdIdentity({ target: 'assign', formId: a.formId, plugin: a.plugin });
    let pending = false;
    for (const key of WD_ASSIGN_KEYS) {
      const v = setAssign[id + '\n' + key];
      if (v === undefined) continue;
      out[key] = key === 'cadenceHours' ? (parseInt(v, 10) || 0) : v;
      pending = true;
    }
    // queued per-location overrides, mirrored the way the plugin will apply
    // them: replace-by-loc, empty wardrobeId removes
    const myLocs = locSets.filter((l) => (l.formId + '|' + l.plugin) === id);
    if (myLocs.length) {
      const ovs = Array.isArray(a.locationOverrides)
        ? a.locationOverrides.map((o) => Object.assign({}, o)) : [];
      for (const l of myLocs) {
        const i = ovs.findIndex((o) => Number(o.loc) === l.loc);
        if (i !== -1) ovs.splice(i, 1);
        if (l.outfit) ovs.push({ loc: l.loc, wardrobeId: '', outfit: l.outfit });
        else if (l.wardrobeId) ovs.push({ loc: l.loc, wardrobeId: l.wardrobeId, outfit: '' });
      }
      out.locationOverrides = ovs;
      pending = true;
    }
    if (pending) out.pending = true;
    return out;
  });

  return {
    file: slice.file, sliceOk: slice.ok, error: slice.error,
    categories, outfitMeta, wardrobes, assignments,
    settings: slice.settings, soesOk: soes.ok, soesFile: soes.file,
    pending: pend.list.length, pendingFile: WARDROBE_FILE, malformed: pend.malformed,
  };
}

/* amount/price on an ADD op MUST be a JSON number: the C++ LineFrom/MarketFrom
 * read them with an integer default (j.value(k, 0u)), which throws type_error on
 * a string — and there is no try/catch around the plugin's op loop. (SET ops are
 * safe: they run the value through ParseAmount, which accepts a string.) */
function finAddNum(v) {
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return (isFinite(n) && n > 0) ? n : 0;
}

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged.
 *  "set" ops deduped by target+id+key (last wins); add/del kept in order. */
function readFinanceOps() {
  let raw;
  try { raw = fs.readFileSync(FINANCE_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  const setAt = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    const op = e.op, target = e.target;
    if ((op !== 'set' && op !== 'add' && op !== 'del') || (target !== 'line' && target !== 'market')) continue;
    if (op === 'set') {
      const id = typeof e.id === 'string' ? e.id : '';
      const key = typeof e.key === 'string' ? e.key : '';
      if (!id || !finKeyOk(target, key)) continue;
      const value = typeof e.value === 'string' ? e.value.slice(0, FIELD_VALUE_MAX) : '';
      const k = target + '\n' + id + '\n' + key;
      const rec = { op, target, id, key, value };
      if (setAt[k] !== undefined) out[setAt[k]] = rec;
      else { setAt[k] = out.length; out.push(rec); }
    } else if (op === 'del') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (id) out.push({ op, target, id });
    } else { // add — amount/price MUST survive as a NUMBER (see finAddNum)
      const rec = { op, target };
      // id is NOT in FIN_*_KEYS but MUST survive the round trip: mergeFinanceOp
      // re-reads and rewrites the whole file on the next edit, and a phone-minted
      // add that lost its id here would (a) stop the follow-up set folding onto
      // it and (b) make the plugin mint a fresh id, orphaning that queued set.
      if (typeof e.id === 'string' && e.id) rec.id = e.id.slice(0, 64);
      const numKey = target === 'line' ? 'amount' : 'price';
      for (const key of (target === 'line' ? FIN_LINE_KEYS : FIN_MARKET_KEYS)) {
        if (e[key] === undefined || e[key] === null) continue;
        if (key === numKey) rec[key] = finAddNum(e[key]);
        else if (typeof e[key] === 'string') rec[key] = e[key].slice(0, FIELD_VALUE_MAX);
      }
      out.push(rec);
    }
  }
  return { list: out, exists: true, malformed: false };
}

function writeFinanceOps(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, ops: list }, null, 2);
  const tmp = FINANCE_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, FINANCE_FILE);  // atomic
  liveFlush('finances', FINANCE_FILE);
}

function mergeFinanceOp(op) {
  const cur = readFinanceOps();
  let list = cur.list;
  if (op.op === 'set')
    list = list.filter((e) => !(e.op === 'set' && e.target === op.target && e.id === op.id && e.key === op.key));
  list.push(op);
  if (list.length > FINANCE_MAX) list.splice(0, list.length - FINANCE_MAX);
  writeFinanceOps(list);
  return list;
}

/** What the phone should SEE: the persisted lines/market with pending SETs folded
 *  on (so an edit shows before the game replays it), rows flagged with a pending
 *  delete, and pending ADDs surfaced as provisional rows — deduped by id, so once
 *  the game replays an add into the real slice the provisional copy drops. */
function financeView() {
  const slice = readFinancesSlice();
  const pend = readFinanceOps();
  const setBy = { line: Object.create(null), market: Object.create(null) };
  const delBy = { line: Object.create(null), market: Object.create(null) };
  const adds = { line: [], market: [] };
  for (const o of pend.list) {
    if (o.op === 'set') setBy[o.target][o.id + '\n' + o.key] = o.value;
    else if (o.op === 'del') delBy[o.target][o.id] = true;
    else if (o.op === 'add') adds[o.target].push(o);
  }
  const keysFor = (t) => (t === 'line' ? FIN_LINE_KEYS : FIN_MARKET_KEYS);
  const numFor = (t) => (t === 'line' ? 'amount' : 'price');
  const apply = (rec, target) => {
    const out = Object.assign({}, rec);
    let pending = !!out.provisional;
    for (const key of keysFor(target)) {
      const v = setBy[target][rec.id + '\n' + key];
      if (v !== undefined) { out[key] = (key === numFor(target)) ? (parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0) : v; pending = true; }
    }
    out.pending = pending || !!delBy[target][rec.id];
    out.pendingDelete = !!delBy[target][rec.id];
    return out;
  };
  const merge = (target) => {
    const sliceRows = target === 'line' ? slice.lines : slice.market;
    const have = Object.create(null);
    sliceRows.forEach((r) => { if (r && r.id) have[r.id] = true; });
    const rows = sliceRows.map((r) => apply(r, target));
    adds[target].forEach((o) => {
      if (o.id && have[o.id]) return;            // already replayed into the slice
      const base = { id: o.id || '', provisional: true };
      keysFor(target).forEach((k) => { if (o[k] !== undefined) base[k] = o[k]; });
      rows.unshift(apply(base, target));
    });
    return rows;
  };
  return {
    ok: slice.ok, file: slice.file, error: slice.error,
    lines: merge('line'),
    market: merge('market'),
    debt: slice.debt,
    pendingFinance: pend.list.length,
    pendingFinanceMalformed: pend.malformed,
  };
}

/* ----------------------- the hotkey-icon sidecar --------------------- */

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged. */
function readHotkeyIcons() {
  let raw;
  try { raw = fs.readFileSync(HKICON_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.assign)) {
    return { list: [], exists: true, malformed: true };
  }
  // Dedupe by entryId, last write wins — same rule the C++ consumer applies, so
  // what the portal shows as pending is exactly what the game will do. NB an
  // icon of "" is legitimate (it CLEARS the icon), so nothing here may treat a
  // blank string as "absent".
  const out = [];
  const at = Object.create(null);
  for (const e of j.assign) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.entryId === 'string' ? e.entryId : '';
    if (!id) continue;
    const icon = typeof e.icon === 'string' ? e.icon : '';
    if (at[id] !== undefined) out[at[id]] = { entryId: id, icon };
    else { at[id] = out.length; out.push({ entryId: id, icon }); }
  }
  return { list: out, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin can never observe a half-written file.
 *  The temp name is derived from the TARGET, so two sidecar writers (and two
 *  concurrent requests) can never scribble over each other's staging file. */
function writeHotkeyIcons(list) {
  if (!ensureDir(DECK_ICON_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_ICON_DIR), { code: 500 });
  const body = JSON.stringify({ version: 1, assign: list }, null, 2);
  const tmp = HKICON_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, HKICON_FILE);  // MoveFileEx(REPLACE_EXISTING) — atomic, retried past a transient lock
  liveFlush('hotkey-icons', HKICON_FILE);
}

function mergeHotkeyIcon(entryId, icon) {
  const cur = readHotkeyIcons();
  const list = cur.list.filter((e) => e.entryId !== entryId);
  list.push({ entryId, icon });
  if (list.length > HKICON_MAX) list.splice(0, list.length - HKICON_MAX);
  writeHotkeyIcons(list);
  return list;
}

/* ----------------------- the hotkey-edit sidecar --------------------- */

/** Shape-level filter for ONE update op's fields. Deliberately NOT the full
 *  validation (that lives in checkHotkeyEdit, on the way IN): a file we did not
 *  write — hand-edited, or from a newer portal — must still be reportable as
 *  "this is what the game will do", so anything of the right TYPE is carried
 *  through and only structural nonsense is dropped. hasOwnProperty throughout:
 *  "" is a real value on desc/category/label. */
function editFieldsOf(src, dst) {
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined && src[k] !== null;
  if (has('name') && typeof src.name === 'string') dst.name = src.name;
  if (has('desc') && typeof src.desc === 'string') dst.desc = src.desc;
  if (has('category') && typeof src.category === 'string') dst.category = src.category;
  if (has('device') && typeof src.device === 'string') dst.device = src.device;
  if (has('code') && Number.isFinite(Number(src.code))) dst.code = Number(src.code);
  if (has('label') && typeof src.label === 'string') dst.label = src.label;
  if (has('mods') && Array.isArray(src.mods)) {
    dst.mods = src.mods.filter((m) => Number.isFinite(Number(m))).map(Number);
  }
  return dst;
}

/** Parsed sidecar, always usable: a malformed file reads as empty + flagged. */
function readHotkeyEdits() {
  let raw;
  try { raw = fs.readFileSync(HKEDIT_FILE, 'utf8'); } catch (_) {
    return { list: [], exists: false, malformed: false };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) {
    return { list: [], exists: true, malformed: true };
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  // Dedupe by entryId, last write wins — EXCEPT that a delete always beats an
  // update for the same id, whichever came first. Same rule the C++ consumer
  // applies, so what the portal reports as pending is exactly what will happen.
  const out = [];
  const at = Object.create(null);
  for (const e of j.ops) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.entryId === 'string' ? e.entryId : '';
    if (!id) continue;
    let rec;
    if (e.op === 'delete') {
      rec = { entryId: id, op: 'delete' };
    } else {
      rec = editFieldsOf(e, { entryId: id, op: 'update' });
      // An update that changes nothing is not a pending change; reporting it as
      // one would leave a badge the game can never clear.
      if (!HK_EDIT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(rec, k))) continue;
    }
    const prev = at[id];
    if (prev === undefined) { at[id] = out.length; out.push(rec); continue; }
    if (out[prev].op === 'delete') continue;   // delete wins, no matter the order
    out[prev] = rec;
  }
  return { list: out, exists: true, malformed: false };
}

/** Write via temp + rename: the plugin can never observe a half-written file.
 *  Keys are emitted in a fixed order so a diff of two queues is readable. */
function writeHotkeyEdits(list) {
  if (!ensureDir(DECK_VIEW_DIR)) throw Object.assign(new Error('Cannot create ' + DECK_VIEW_DIR), { code: 500 });
  const ops = list.map((e) => {
    const o = { op: e.op, entryId: e.entryId };
    if (e.op !== 'delete') {
      for (const k of HK_EDIT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      }
    }
    return o;
  });
  const body = JSON.stringify({ version: 1, ops }, null, 2);
  const tmp = HKEDIT_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, HKEDIT_FILE);  // MoveFileEx(REPLACE_EXISTING) — atomic, retried past a transient lock
  liveFlush('hotkey-edits', HKEDIT_FILE);
}

/** Fold `patch` into whatever is already queued for this entry, so the file
 *  holds exactly ONE op per id (see the banner: two partial ops for one id
 *  would lose the older one's fields to the consumer's dedupe).
 *  `patch` is { op:'delete' } or { op:'update', …fields }. */
function mergeHotkeyEdit(entryId, patch) {
  const cur = readHotkeyEdits();
  const list = [];
  let queued = null;
  for (const e of cur.list) {
    if (e.entryId === entryId) { queued = e; continue; }
    list.push(e);
  }
  let rec;
  if (patch.op === 'delete') {
    rec = { entryId, op: 'delete' };
  } else if (queued && queued.op === 'update') {
    rec = Object.assign({}, queued, patch, { entryId, op: 'update' });
  } else {
    rec = Object.assign({ entryId, op: 'update' }, patch);
  }
  list.push(rec);
  if (list.length > HKEDIT_MAX) list.splice(0, list.length - HKEDIT_MAX);
  writeHotkeyEdits(list);
  return { list, op: rec };
}

/** Drop the queued op for an entry ("undo"). Works for an id that is no longer
 *  in the deck too — that is the only way to clear a stale op from the phone. */
function removeHotkeyEdit(entryId) {
  const cur = readHotkeyEdits();
  const list = cur.list.filter((e) => e.entryId !== entryId);
  if (list.length === cur.list.length) return null;      // nothing was queued
  writeHotkeyEdits(list);
  return list;
}

/** Every queue's file + depth + malformed flag, in one place. Health and the
 *  page header both need the WHOLE picture: a hotkey-only queue used to show
 *  nothing in the header because that number came from the spell payload alone. */
function pendingSummary() {
  const a = readAssignments();
  const f = readNpcFields();
  const h = readHotkeyIcons();
  const e = readHotkeyEdits();
  const fin = readFinanceOps();
  const nf = readNffOps();
  const fo = readFoOps();
  return {
    nffFile: NFF_FILE,
    pendingNff: nf.list.length,
    pendingNffMalformed: nf.malformed,
    foOpsFile: FO_OPS_FILE,
    pendingFoOps: fo.list.length,
    pendingFoOpsMalformed: fo.malformed,
    financeFile: FINANCE_FILE,
    pendingFinance: fin.list.length,
    pendingFinanceMalformed: fin.malformed,
    assignFile: ASSIGN_FILE,
    pendingAssignments: a.list.length,
    pendingMalformed: a.malformed,
    npcFieldsFile: NPCF_FILE,
    pendingNpcFields: f.list.length,
    pendingNpcFieldsMalformed: f.malformed,
    hkIconFile: HKICON_FILE,
    pendingHotkeyIcons: h.list.length,
    pendingHotkeyIconsMalformed: h.malformed,
    hkEditFile: HKEDIT_FILE,
    pendingHotkeyEdits: e.list.length,
    pendingHotkeyEditsMalformed: e.malformed,
    // Split out because they read very differently on a phone: a queued rename
    // is routine, a queued DELETE is the one that deserves a second look.
    pendingHotkeyDeletes: e.list.filter((o) => o.op === 'delete').length,
  };
}

/** Locate one roster member by original name (or by slug, for convenience).
 *  Case-insensitive on the name — same rule the C++ consumer applies. */
function findMemberByName(original, slug) {
  const r = readRoster();
  if (!r.ok) return { ok: false, code: 503, error: r.error };
  const want = String(original || '').trim().toLowerCase();
  const wantSlug = String(slug || '').trim().toLowerCase();
  const hits = [];
  for (const c of r.categories) {
    for (const m of c.members) {
      const byName = want && m.original.toLowerCase() === want;
      const bySlug = !want && wantSlug && m.slug === wantSlug;
      if (byName || bySlug) hits.push({ member: m, category: c.name });
    }
  }
  if (!hits.length) {
    return {
      ok: false, code: 404,
      error: 'No follower called "' + String(original || slug).slice(0, 60) +
        '" is in Follower Organizer — hit ⟳ and try again',
    };
  }
  // The same person can be filed in several categories; the field applies to
  // every one of those entries, so any hit is a fine representative.
  return { ok: true, member: hits[0].member, category: hits[0].category, entries: hits.length };
}

/** Locate one roster category by its slot index — the real "does this category
 *  exist" check behind a queued move/rename (foCatOk is only the shape guard). */
function foCategoryByIndex(index) {
  const r = readRoster();
  if (!r.ok) return { ok: false, code: 503, error: r.error };
  const c = r.categories.find((cc) => cc.index === index);
  if (!c) {
    return {
      ok: false, code: 404,
      error: 'No category is in slot ' + index + ' — hit ⟳ and try again',
    };
  }
  return { ok: true, category: c };
}

/* ----------------------- icon path <-> URL -------------------------- */

/** How the browser should draw a stored override path.
 *  { url, kind: 'custom'|'library', missing } — null means "no override".
 *
 *  `view` names the tree a LIBRARY path is resolved in ('magic' default,
 *  'hotkey' for a deck row): both views own an icons/sh/** tree and the same
 *  relative path can be valid in one and absent from the other, so guessing
 *  from the path would hand back a false "missing art". A CUSTOM path is always
 *  described from the shared pool — that is where uploads land and what
 *  /api/icon-file serves, whichever view is asking. */
function iconUrlFor(icon, view) {
  if (typeof icon !== 'string' || !icon) return null;
  const v = viewName(view);
  const p = icon.replace(/\\/g, '/');            // the view normalises the same way
  const custom = p.startsWith(ICON_PREFIX);
  const abs = custom ? confine(ICON_DIR, p.slice(ICON_PREFIX.length)) : confineView(p, v);
  if (!abs || !fs.existsSync(abs)) {
    return { url: null, kind: custom ? 'custom' : 'library', missing: true };
  }
  let mt = 0;
  try { mt = Math.floor(fs.statSync(abs).mtimeMs / 1000); } catch (_) { /* fine */ }
  if (custom) {
    // Prefer the existing by-stem endpoint for the custom pool, so one icon has
    // one URL whether it is reached from a spell row, a hotkey row, or the
    // library grid.
    const stem = path.basename(p, path.extname(p));
    if (validIconName(stem)) {
      return { url: '/api/icon-file/' + encodeURIComponent(stem) + '?v=' + mt, kind: 'custom' };
    }
    // A pool file whose stem we can't address by name (a dot in the middle, say)
    // still renders — through the pool's own tree, never the asking view's.
    return { url: '/api/view-icon?p=' + encodeURIComponent(p) + '&v=' + mt, kind: 'custom' };
  }
  // `view` is omitted for the default tree so every library URL the spell flow
  // has ever minted keeps its exact shape (and its browser cache entry).
  return {
    url: '/api/view-icon?p=' + encodeURIComponent(p) +
      (v === 'magic' ? '' : '&view=' + v) + '&v=' + mt,
    kind: 'library',
  };
}

/* ------------------- the Spell Hotbar icon library ------------------- *
 *  icons/sh_index.json is the index the extractor writes beside the PNGs and
 *  the game hands the view once per session: { byForm, generic, named, catalog }.
 *  `catalog` is the browsable half — one row per extracted icon, already
 *  carrying the label and the atlas it came from.
 *
 *  Parsed ONCE per view and re-read only when the file's mtime moves (a
 *  re-extract, or a fresh deploy), because it is ~450 KB of JSON and the phone
 *  scrolls it a page at a time. Each row gets a precomputed lowercase `hay`
 *  string so filtering is a substring test, not a per-keystroke rebuild.
 *  A missing/invalid index is reported, never thrown: the picker then says so
 *  instead of the sheet dying on a fetch. */
const SH_CACHE = { magic: null, hotkey: null };
function shLibrary(view) {
  const v = viewName(view);
  const file = path.join(VIEW_DIRS[v], 'icons', 'sh_index.json');
  let stamp = 0;
  try { stamp = Math.floor(fs.statSync(file).mtimeMs / 1000); } catch (_) {
    return { ok: false, error: 'No icon library index at ' + file + ' — the Spell Hotbar icons are not deployed in the ' + v + ' view' };
  }
  const hit = SH_CACHE[v];
  if (hit && hit.stamp === stamp) return hit;
  let idx;
  try { idx = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    return { ok: false, error: 'Icon library index is unreadable: ' + e.message };
  }
  const rows = Array.isArray(idx && idx.catalog) ? idx.catalog : [];
  const items = [];
  const atlases = new Map();
  for (const r of rows) {
    if (!r || typeof r.file !== 'string') continue;
    const p = r.file.replace(/\\/g, '/');
    if (!p.startsWith(LIB_PREFIX)) continue;         // never offer what we can't assign
    const label = String(r.label || path.basename(p, path.extname(p)));
    const atlas = String(r.atlas || '');
    items.push({
      path: p, label, atlas, kind: String(r.kind || ''),
      hay: (label + ' ' + atlas + ' ' + String(r.key || '')).toLowerCase().replace(/[_|]/g, ' '),
    });
    if (atlas) atlases.set(atlas, (atlases.get(atlas) || 0) + 1);
  }
  items.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
  const out = {
    ok: true, stamp, items,
    atlases: [...atlases.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  };
  SH_CACHE[v] = out;
  log('icon library (' + v + '): ' + items.length + ' icons across ' + out.atlases.length + ' packs');
  return out;
}

/** The pool file this row may overwrite in place: its OWN current art, queued
 *  edit included. Without the queued half, uploading twice for the same row
 *  before the game consumes the sidecar derives "X" then "X 2" and orphans the
 *  first file in the pool — the live config still says "no icon", because the
 *  portal never writes it. Returns "" when the row's icon is not a pool file. */
function ownPoolFile(liveIcon, queuedIcon) {
  const eff = typeof queuedIcon === 'string' ? queuedIcon : String(liveIcon || '');
  const p = eff.replace(/\\/g, '/');
  return p.startsWith(ICON_PREFIX) ? p.slice(ICON_PREFIX.length) : '';
}

/** "" (clear it: Auto for a spell, no icon for a hotkey), an existing CUSTOM
 *  icon, or an existing LIBRARY icon (icons/sh/**, the 1,913 PNGs extracted
 *  from Spell Hotbar 2 — browsable from the phone since /api/sh-icons).
 *  Nothing else may enter either sidecar: refusing unknown paths keeps
 *  anything unresolvable out of the game's config.
 *  Custom paths are checked against the canonical pool, which writePoolIcon()
 *  keeps mirrored into the deck's tree, so they resolve in BOTH views. A
 *  library path is checked in the ASKING view's own tree — both views ship the
 *  full library, but the same relative path can exist in one and not the other,
 *  and assigning art the row can't paint is exactly the failure this guards. */
function checkAssignIcon(icon, view) {
  if (icon === '' || icon === null || icon === undefined) return { ok: true, icon: '' };
  if (typeof icon !== 'string') return { ok: false, error: 'icon must be a string ("" clears the icon)' };
  const p = icon.replace(/\\/g, '/');
  if (p.startsWith(LIB_PREFIX)) {
    const v = viewName(view);
    const abs = confineView(p, v);       // per-segment guard + resolved-prefix re-check
    if (!abs) return { ok: false, error: 'Bad library icon path "' + p.slice(0, 60) + '"' };
    if (!fs.existsSync(abs)) {
      return { ok: false, error: 'No library icon at "' + p.slice(0, 60) + '" in the ' + v + ' view' };
    }
    return { ok: true, icon: p };
  }
  if (!p.startsWith(ICON_PREFIX)) {
    return { ok: false, error: 'icon must be "", a "' + ICON_PREFIX + '" upload, or a "' + LIB_PREFIX + '" library icon (got "' + p.slice(0, 60) + '")' };
  }
  const file = p.slice(ICON_PREFIX.length);
  const abs = confine(ICON_DIR, file);   // rejects traversal, separators, subdirs
  if (!abs || !ICON_EXTS.includes(normExt(path.extname(file)))) {
    return { ok: false, error: 'Bad icon path "' + p.slice(0, 60) + '"' };
  }
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'No custom icon file named "' + file + '" — upload it first' };
  }
  return { ok: true, icon: ICON_PREFIX + file };
}

/* --------------------------- the payload ---------------------------- */

/** An icon stem derived from a spell or hotkey name, valid against
 *  ICON_NAME_RE. `fallback` is what an unusable name degrades to —
 *  parameterised rather than forked, so the two flows can't drift. */
function iconNameFrom(name, fallback) {
  let s = String(name == null ? '' : name);
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* older engines */ }
  s = s.replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^A-Za-z0-9]+/, '').slice(0, 80).trim();
  if (validIconName(s)) return s;
  return (typeof fallback === 'string' && validIconName(fallback)) ? fallback : 'spell icon';
}

/** First free "<stem>", "<stem> 2", "<stem> 3" … — used ONLY for the name we
 *  derive ourselves, so uploading art for two same-named spells can't have the
 *  second silently repaint the first. An explicit iconName always replaces. */
function freeIconName(stem, keepFile) {
  for (let i = 1; i < 100; i++) {
    const cand = i === 1 ? stem : (stem + ' ' + i).slice(0, 80).trim();
    if (!validIconName(cand)) break;
    const hit = findByStem(ICON_DIR, cand, ICON_EXTS);
    if (!hit || (keepFile && hit.file.toLowerCase() === String(keepFile).toLowerCase())) return cand;
  }
  return stem;
}

/* --------------------------- pool writes ---------------------------- *
 *  ONE pool, TWO trees (see the ICON_DIR / DECK_ICON_DIR banner up top).
 *  Every icon the portal adds or removes has to happen in both, or a hotkey
 *  icon assigned from the phone draws nothing until main.cpp's Magic → Deck
 *  mirror next runs. The canonical copy is still the MagicDeck one: that is
 *  what /api/icons lists, what freeIconName() probes and what
 *  checkAssignIcon() verifies.
 * --------------------------------------------------------------------- */

/** Write to the pool (both trees). Returns the canonical write's info. */
function writePoolIcon(stem, ext, buf) {
  const info = writeImage(ICON_DIR, stem, ext, buf);
  try {
    // Mirror under the name that ACTUALLY landed (writeImage may have had to
    // sidestep a locked file), or the deck would draw the stale bytes.
    const landed = path.parse(info.file).name;
    removeStem(DECK_ICON_DIR, landed, ICON_EXTS);   // replace, never stack extensions
    writeImage(DECK_ICON_DIR, landed, ext, buf);
  } catch (e) {
    // Not fatal: the canonical copy landed, and the in-game Magic → Deck mirror
    // is the backstop. Say so in the log rather than failing the upload.
    log('warning: could not mirror icon "' + stem + '" into the deck view (' + e.message + ')');
  }
  /* ...and hand it to the RUNNING game, which cannot see it otherwise.
     MO2 composes its virtual file system when the game LAUNCHES: a file an
     outside process drops into a mod folder afterwards does not exist as far
     as the running Skyrim is concerned. The plugin therefore re-writes the
     bytes through its own VFS-mapped path, where they land in Overwrite and
     the view can load them immediately.

     THIS LIVES HERE, not at the call sites. /api/wardrobe-image did it by hand
     and the other four uploaders never did — so a hotkey icon sent from the
     phone was written, assigned, logged as applied, and then invisible until
     the next launch (reported 2026-08-03: an uploaded image did not appear until
     it in game"). One writer, one place that remembers.

     Fire-and-forget: the game being closed is not an error, it just means the
     next launch picks the file up the ordinary way. */
  liveSend({ kind: 'import-icon', name: info.file,
    src: path.join(DECK_ICON_DIR, info.file) }).catch(() => {});
  return info;
}

/** Remove from the pool (both trees). Returns the canonical removal count. */
function removePoolIcon(stem) {
  const n = removeStem(ICON_DIR, stem, ICON_EXTS);
  try { removeStem(DECK_ICON_DIR, stem, ICON_EXTS); } catch (_) { /* see above */ }
  return n;
}

/** Make sure a pool file the DECK will draw also exists in the deck's tree.
 *  Covers icons that arrived some other way — hand-dropped into icons/custom,
 *  swept in from Desktop\Spell Deck Icons, written before this version — and are
 *  only now being assigned to a hotkey. Size-compared, so it is a no-op once the
 *  bytes match; same rule the C++ mirror uses. */
function ensureDeckCopy(file) {
  const from = confine(ICON_DIR, file);
  const to = confine(DECK_ICON_DIR, file);
  if (!from || !to) return false;
  try {
    const a = fs.statSync(from);
    let b = null;
    try { b = fs.statSync(to); } catch (_) { /* missing — copy below */ }
    if (b && b.isFile() && b.size === a.size) return true;
    if (!ensureDir(DECK_ICON_DIR)) return false;
    fs.copyFileSync(from, to);
    log('icon mirrored into the deck view: ' + file);
    return true;
  } catch (e) {
    log('warning: could not mirror "' + file + '" into the deck view (' + e.message + ')');
    return false;
  }
}

function spellsPayload(cfg) {
  const src = readMagic(cfg);
  const pend = readAssignments();
  const pendBy = Object.create(null);
  pend.list.forEach((e) => { pendBy[e.spellId] = e.icon; });

  const base = {
    hkJson: src.file,
    candidates: HK_JSON_CANDIDATES,
    assignFile: ASSIGN_FILE,
    pendingAssignments: pend.list.length,
    pendingMalformed: pend.malformed,
  };

  if (!src.ok) {
    return Object.assign({ ok: false, error: src.error, categories: [], total: 0, pendingUnknown: [] }, base);
  }

  const magic = src.magic;
  const order = (magic && Array.isArray(magic.categories))
    ? magic.categories.filter((c) => typeof c === 'string' && c) : [];
  const rows = (magic && Array.isArray(magic.spells)) ? magic.spells : [];

  // Seed the rail order first so groups come back in the order the deck shows
  // them; a spell filed under a category that no longer exists lands in its own
  // trailing group rather than vanishing (the deck itself re-homes those to
  // categories[0] on its next save, but we report what is on disk NOW).
  const buckets = new Map();
  order.forEach((c) => buckets.set(c, []));

  const seenId = Object.create(null);
  let total = 0;
  rows.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    const id = typeof s.id === 'string' ? s.id : '';
    if (!id || seenId[id]) return;                 // unaddressable / duplicate
    seenId[id] = true;
    const rawCat = str(pick(s, ['category'], ''));
    const cat = buckets.has(rawCat) ? rawCat : (rawCat || UNCATEGORIZED);
    if (!buckets.has(cat)) buckets.set(cat, []);

    const icon = typeof s.icon === 'string' ? s.icon : '';
    const cur = iconUrlFor(icon);
    const row = {
      id,
      name: str(s.name) || 'spell',
      category: cat,
      mode: str(s.mode),
      hand: str(s.hand),
      school: str(s.school),
      element: str(s.element),
      tier: str(s.tier),
      slot: str(s.slot),
      icon,
      iconUrl: cur ? cur.url : null,
      iconKind: cur ? cur.kind : 'auto',
      iconMissing: !!(cur && cur.missing),
      pendingIcon: null,
      pendingIconUrl: null,
      pendingIconKind: null,
    };
    if (Object.prototype.hasOwnProperty.call(pendBy, id)) {
      const pi = pendBy[id];
      const pu = iconUrlFor(pi);
      row.pendingIcon = pi;
      row.pendingIconUrl = pu ? pu.url : null;
      row.pendingIconKind = pu ? pu.kind : 'auto';
    }
    buckets.get(cat).push(row);
    total++;
  });

  const categories = [];
  buckets.forEach((spells, name) => { if (spells.length) categories.push({ name, spells }); });

  // Assignments for spells that are no longer in the deck. The C++ consumer
  // skips and logs these; surfacing them here is what makes that debuggable.
  const unknown = pend.list.map((e) => e.spellId).filter((id) => !seenId[id]);

  return Object.assign({
    ok: true,
    hasMagic: !!magic,
    categories,
    total,
    pendingUnknown: unknown,
  }, base);
}

/** Locate one spell by id in the live config (nothing is assignable without it). */
function findSpell(spellId) {
  const src = readMagic();
  if (!src.ok) return { ok: false, code: 503, error: src.error };
  const rows = (src.magic && Array.isArray(src.magic.spells)) ? src.magic.spells : [];
  for (const s of rows) {
    if (s && typeof s === 'object' && s.id === spellId) return { ok: true, spell: s, file: src.file };
  }
  return {
    ok: false, code: 404,
    error: 'No spell with id "' + String(spellId).slice(0, 60) + '" is in the Spell Deck — reload (⟳) and try again',
  };
}

/* ==================== hotkeys (entries[]) + their icons ================ *
 *  The deck's own rows: `entries[]` in hotkeys.json, grouped by `categories[]`.
 *  Everything here is READ-ONLY on that file; an icon change is queued into
 *  HKICON_FILE exactly like a spell icon is queued into ASSIGN_FILE.
 * ======================================================================= */

// The three modifier DIKs the deck can hold with a tap, and the join it renders
// them with. Mirrored from MOD_LABEL / chordLabel() in view/HotkeyDeck/app.js —
// deliberately NOT a full DIK table: `entries[].label` already carries the human
// key name the deck itself shows, so there is nothing to decode.
const MOD_LABEL = { 42: 'Shift', 29: 'Ctrl', 56: 'Alt' };
const HK_ALL_ONLY = 'All only';   // the deck's own wording for category: ""

function chordLabelOf(mods, label) {
  const parts = (Array.isArray(mods) ? mods : []).map((m) => MOD_LABEL[Number(m)] || '?');
  parts.push(String(label == null ? '' : label));
  return parts.join(' + ');
}

/** How a queued op reads to the client:
 *    pendingEdit      the op minus its entryId, or null   ("" values intact)
 *    pendingDelete    true when the whole entry is queued for removal
 *    pendingKeyLabel  the chord the deck WILL show, or null when the op does
 *                     not touch the key — precomputed here for the same reason
 *                     keyLabel is: the client never needs a scancode table to
 *                     RENDER one (its picker has a table to CHOOSE one).
 *  `entry` supplies whatever the op leaves alone. */
function editViewOf(rec, entry) {
  if (!rec) return { pendingEdit: null, pendingDelete: false, pendingKeyLabel: null };
  if (rec.op === 'delete') return { pendingEdit: { op: 'delete' }, pendingDelete: true, pendingKeyLabel: null };
  const op = { op: 'update' };
  for (const k of HK_EDIT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) op[k] = rec[k];
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(op, k);
  let keyLabel = null;
  if (HK_KEY_FIELDS.some(has)) {
    const dv = has('device') ? op.device : (str(entry && entry.device) || 'keyboard');
    const lb = has('label') ? op.label : str(entry && entry.label);
    const md = has('mods') ? op.mods
      : (entry && Array.isArray(entry.mods) ? entry.mods.filter((m) => Number.isFinite(Number(m))).map(Number) : []);
    keyLabel = dv === 'action' ? (lb || 'Action') : (lb ? chordLabelOf(md, lb) : '');
  }
  return { pendingEdit: op, pendingDelete: false, pendingKeyLabel: keyLabel };
}

/** One hotkey row, shaped for the phone. `keyLabel` is precomputed server-side
 *  so the client never needs a scancode table. */
function hotkeyRow(e, pendBy, editBy) {
  const id = typeof e.id === 'string' ? e.id : '';
  const device = str(e.device) || 'keyboard';
  const label = str(e.label);
  const mods = Array.isArray(e.mods) ? e.mods.filter((m) => Number.isFinite(Number(m))).map(Number) : [];
  const icon = typeof e.icon === 'string' ? e.icon : '';
  const cur = iconUrlFor(icon, 'hotkey');
  const row = {
    id,
    name: str(e.name) || 'Unnamed',
    desc: str(e.desc),
    category: str(e.category),
    device,
    code: Number.isFinite(Number(e.code)) ? Number(e.code) : 0,
    label,
    mods,
    // An action entry fires a native C++ verb instead of a keystroke, so its
    // "key" is the verb name the deck shows in that slot.
    keyLabel: device === 'action' ? (label || 'Action') : (label ? chordLabelOf(mods, label) : ''),
    action: str(e.action),
    icon,
    iconUrl: cur ? cur.url : null,
    iconKind: cur ? cur.kind : 'none',
    iconMissing: !!(cur && cur.missing),
    pendingIcon: null,
    pendingIconUrl: null,
    pendingIconKind: null,
  };
  // hasOwnProperty, not truthiness: "" is a queued CLEAR, not "nothing queued".
  if (pendBy && Object.prototype.hasOwnProperty.call(pendBy, id)) {
    const pi = pendBy[id];
    const pu = iconUrlFor(pi, 'hotkey');
    row.pendingIcon = pi;
    row.pendingIconUrl = pu ? pu.url : null;
    row.pendingIconKind = pu ? pu.kind : 'none';
  }
  Object.assign(row, editViewOf(editBy ? editBy[id] : null, e));
  return row;
}

function hotkeysPayload(src) {
  const hk = readHotkeys(src);
  const pend = readHotkeyIcons();
  const pendBy = Object.create(null);
  pend.list.forEach((e) => { pendBy[e.entryId] = e.icon; });
  const edits = readHotkeyEdits();
  const editBy = Object.create(null);
  edits.list.forEach((e) => { editBy[e.entryId] = e; });

  const base = {
    hkJson: hk.file,
    candidates: HK_JSON_CANDIDATES,
    hkIconFile: HKICON_FILE,
    hkIconDir: DECK_ICON_DIR,
    pendingHotkeyIcons: pend.list.length,
    pendingHotkeyIconsMalformed: pend.malformed,
    hkEditFile: HKEDIT_FILE,
    pendingHotkeyEdits: edits.list.length,
    // Counted from the QUEUE, not from the visible rows: a delete aimed at an
    // entry the deck no longer has is still a queued delete.
    pendingHotkeyDeletes: edits.list.filter((o) => o.op === 'delete').length,
    pendingHotkeyEditsMalformed: edits.malformed,
    // The deck's REAL tab order (categories[] as written), which is the only
    // legal set of values for an entry's category — the grouped `categories`
    // below can also carry two synthetic buckets, so it must not be used to
    // populate a category picker.
    deckCategories: hk.categories,
    allOnlyLabel: HK_ALL_ONLY,
    limits: {
      nameMax: HK_NAME_MAX, descMax: HK_DESC_MAX, labelMax: HK_LABEL_MAX, modsMax: HK_MODS_MAX,
    },
  };

  if (!hk.ok) {
    return Object.assign({
      ok: false, error: hk.error, categories: [], total: 0,
      pendingUnknown: [], pendingEditUnknown: [],
    }, base);
  }

  // Seed the tab order first so groups come back in the order the deck shows
  // them. Two special buckets, both TRAILING: an entry filed under a category
  // that no longer exists (reported as it is on disk, not re-homed), and
  // category "" — legal and common, the deck labels it "— All only —".
  const buckets = new Map();
  hk.categories.forEach((c) => buckets.set(c, []));
  const allOnly = [];

  const seenId = Object.create(null);
  let total = 0;
  hk.entries.forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id || seenId[id]) return;                 // unaddressable / duplicate
    seenId[id] = true;
    const row = hotkeyRow(e, pendBy, editBy);
    if (!row.category) { allOnly.push(row); total++; return; }
    if (!buckets.has(row.category)) buckets.set(row.category, []);
    buckets.get(row.category).push(row);
    total++;
  });

  const categories = [];
  buckets.forEach((entries, name) => { if (entries.length) categories.push({ name, entries }); });
  if (allOnly.length) categories.push({ name: HK_ALL_ONLY, entries: allOnly, allOnly: true });

  // Queued icons for entries that are no longer in the deck. Hotkey ids die more
  // often than spell ids — "＋ Add" mints one and cancelling the key capture
  // deletes it again — so surfacing this is what stops a silent "I queued it and
  // nothing happened".
  const unknown = pend.list.map((e) => e.entryId).filter((id) => !seenId[id]);
  // Same story for queued edits, and more likely: an entry deleted in-game
  // between a phone edit and the game eating the queue leaves one behind.
  const unknownEdits = edits.list.map((e) => e.entryId).filter((id) => !seenId[id]);

  return Object.assign({
    ok: true,
    categories,
    total,
    pendingUnknown: unknown,
    pendingEditUnknown: unknownEdits,
  }, base);
}

/** Locate one hotkey entry by id in the live config. A hand-edited file can hold
 *  the same id twice; report how many so the caller can say so (the C++ consumer
 *  applies a queued icon to EVERY entry with that id, so a duplicate can't
 *  produce a "queued but nothing changed" ghost). */
function findHotkeyEntry(entryId) {
  const src = readHotkeys();
  if (!src.ok) return { ok: false, code: 503, error: src.error };
  const hits = src.entries.filter((e) => e && typeof e === 'object' && e.id === entryId);
  if (!hits.length) {
    return {
      ok: false, code: 404,
      error: 'No hotkey with id "' + String(entryId).slice(0, 60) + '" is in the deck — reload (⟳) and try again',
    };
  }
  // `categories` rides along so an edit can be validated against the deck's real
  // tab list without a second read of a file the game rewrites constantly.
  return { ok: true, entry: hits[0], entries: hits.length, file: src.file, categories: src.categories };
}

/* ------------------------- validating an edit ------------------------ *
 *  The portal is the UI, so it is STRICT where the C++ consumer is lenient: a
 *  bad field here comes back as a 400 the phone can render, instead of being
 *  silently dropped on the floor three minutes later inside the game. The
 *  consumer's field-by-field leniency stays the backstop for a hand-edited
 *  sidecar; the two are not in competition.
 *
 *  Returns { ok:true, patch } — patch holds ONLY the keys that were sent, so
 *  the op stays partial — or { ok:false, error }.
 * --------------------------------------------------------------------- */
function checkHotkeyEdit(body, hit) {
  const entry = hit.entry;
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined && body[k] !== null;
  const entryName = str(entry.name) || 'That hotkey';

  if (has('name')) {
    if (typeof body.name !== 'string') return { ok: false, error: 'name must be a string' };
    const v = body.name.trim();
    // Deliberately an ERROR, not a silent skip: on a phone, a name box you
    // emptied and a name box that refused to save look identical otherwise.
    if (!v) return { ok: false, error: 'A hotkey has to keep a name — type one, or press Esc to put the old one back.' };
    if (Buffer.byteLength(v, 'utf8') > HK_NAME_MAX) {
      // bytes, not UTF-16 units — the plugin's cap is on std::string, so an
      // accented or emoji name must be measured the way IT will measure it
      return { ok: false, error: 'That name is ' + Buffer.byteLength(v, 'utf8') + ' bytes — the limit is ' + HK_NAME_MAX + '.' };
    }
    patch.name = v;
  }

  if (has('desc')) {
    if (typeof body.desc !== 'string') return { ok: false, error: 'desc must be a string ("" clears it)' };
    const v = body.desc.trim();
    if (Buffer.byteLength(v, 'utf8') > HK_DESC_MAX) {
      return { ok: false, error: 'That description is ' + Buffer.byteLength(v, 'utf8') + ' bytes — the limit is ' + HK_DESC_MAX + '.' };
    }
    patch.desc = v;
  }

  if (has('category')) {
    if (typeof body.category !== 'string') return { ok: false, error: 'category must be a string ("" = ' + HK_ALL_ONLY + ')' };
    const v = body.category.trim();
    // Case-sensitive on purpose: the deck matches its tabs by exact string, so
    // "combat" would file the entry into a tab that does not exist and the row
    // would vanish into a trailing bucket.
    if (v && (hit.categories || []).indexOf(v) < 0) {
      return {
        ok: false,
        error: 'No deck tab called "' + v.slice(0, 40) + '". Tabs right now: ' +
          ((hit.categories || []).join(', ') || '(none)') + ' — or "" for ' + HK_ALL_ONLY + '.',
      };
    }
    patch.category = v;
  }

  /* ---- the key itself ---- */
  const curDevice = str(entry.device) || 'keyboard';
  const touchesKey = HK_KEY_FIELDS.some(has);
  if (touchesKey && curDevice === 'action') {
    // The action verb is C++-owned (npc_actions.cpp); repointing one of these at
    // a keystroke from the phone would quietly break the entry.
    return {
      ok: false,
      error: entryName + ' fires a built-in deck action (' + (str(entry.action) || 'action') +
        '), not a keystroke — that one is owned by the plugin and cannot be rebound from here.',
    };
  }
  let dev = curDevice;
  if (has('device')) {
    if (body.device !== 'keyboard' && body.device !== 'mouse') {
      return { ok: false, error: 'device must be "keyboard" or "mouse" — "action" entries are owned by the plugin.' };
    }
    if (!has('code')) {
      // A device without a code leaves the entry pointing at a scancode that
      // means something else entirely on the new device (mouse code 65?).
      return { ok: false, error: 'device and code go together — send the new key, not just the device.' };
    }
    dev = body.device;
    patch.device = dev;
  }
  if (has('code')) {
    const c = Number(body.code);
    if (!Number.isFinite(c) || Math.floor(c) !== c) {
      return { ok: false, error: 'code must be a whole number (a DIK scancode)' };
    }
    const lo = dev === 'mouse' ? 2 : 1;
    const hi = dev === 'mouse' ? 4 : 255;
    if (c < lo || c > hi) {
      return {
        ok: false,
        error: dev === 'mouse'
          ? 'Mouse codes are 2 (middle), 3 (Mouse 4) and 4 (Mouse 5) — got ' + c + '.'
          : 'A keyboard scancode is 1–255 — got ' + c + '.',
      };
    }
    patch.code = c;
  }
  if (has('label')) {
    if (typeof body.label !== 'string') return { ok: false, error: 'label must be a string' };
    const v = body.label.trim();
    if (Buffer.byteLength(v, 'utf8') > HK_LABEL_MAX) {
      return { ok: false, error: 'That key label is ' + Buffer.byteLength(v, 'utf8') + ' bytes — the limit is ' + HK_LABEL_MAX + '.' };
    }
    patch.label = v;
  }
  if (has('mods')) {
    if (!Array.isArray(body.mods)) {
      return { ok: false, error: 'mods must be an array of scancodes ([] clears every modifier)' };
    }
    if (body.mods.length > HK_MODS_MAX) {
      return { ok: false, error: 'At most ' + HK_MODS_MAX + ' modifiers on one chord — got ' + body.mods.length + '.' };
    }
    const out = [];
    for (const raw of body.mods) {
      const c = Number(raw);
      if (!Number.isFinite(c) || Math.floor(c) !== c || c < 1 || c > 255) {
        return { ok: false, error: 'Modifier scancodes are 1–255 — got "' + String(raw).slice(0, 20) + '".' };
      }
      if (out.indexOf(c) < 0) out.push(c);     // deduped, order kept
    }
    patch.mods = out;
  }

  return { ok: true, patch };
}

/* =========================== http plumbing ============================= */

function sendJson(res, code, obj, closeConn) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  };
  // When we bail out before draining the request body, keep-alive would leave
  // the unread bytes framing the NEXT request on this socket. Close instead.
  if (closeConn) headers['Connection'] = 'close';
  res.writeHead(code, headers);
  res.end(body);
}

/** Node throws "Invalid status code: EBUSY" if you hand res.writeHead an errno
 *  string, which is exactly what `e.code || 500` does for ANY fs failure — the
 *  user then sees a framework error instead of the real problem. Coerce here so
 *  no call site can leak an errno into the wire status. */
function httpCode(code, fallback) {
  const n = Number(code);
  return (Number.isInteger(n) && n >= 400 && n <= 599) ? n : (fallback || 500);
}

function sendErr(res, code, message, extra) {
  const c = httpCode(code, 500);
  sendJson(res, c, Object.assign({ ok: false, error: message }, extra || {}), c === 413);
}

function sendFile(res, file, ext) {
  fs.readFile(file, (err, buf) => {
    if (err) { sendErr(res, 404, 'Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      // Content is cache-busted with ?v=<mtime>, so a long cache is safe and
      // keeps a 60-follower grid from re-downloading on every render.
      'Cache-Control': 'public, max-age=31536000',
    });
    res.end(buf);
  });
}

/** Same headers as sendFile, for bytes we made rather than read (a thumbnail).
 *  The long cache is safe for the same reason: every URL that reaches here is
 *  named by a file the game writes ONCE — a re-render lands under a new name. */
function sendBuf(res, buf, ext) {
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000',
  });
  res.end(buf);
}

function tooBig(bytes, limit) {
  return Object.assign(
    new Error('Request body is ' + Math.round(bytes / 1048576) + ' MB — the limit is ' +
      Math.round(limit / 1048576) + ' MB. Shrink the image before uploading.'),
    { code: 413 });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // Reject on the DECLARED length first. A client that announces 23 MB gets a
    // real 413 it can render; if we only caught it mid-stream and killed the
    // socket, curl/fetch would surface the 100-continue or a network error
    // instead of our message.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { reject(tooBig(declared, limit)); return; }

    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; reject(tooBig(size, limit)); return; }  // chunked/undeclared
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, MAX_BODY_BYTES);
  if (!buf.length) throw Object.assign(new Error('Empty body'), { code: 400 });
  try { return JSON.parse(buf.toString('utf8')); } catch (e) {
    throw Object.assign(new Error('Body is not valid JSON'), { code: 400 });
  }
}

/** base64 → Buffer, with the size + shape checks an upload endpoint owes you. */
function decodeImage(dataBase64) {
  if (typeof dataBase64 !== 'string' || !dataBase64) {
    throw Object.assign(new Error('dataBase64 is required'), { code: 400 });
  }
  // Tolerate a whole data: URL — phones paste them, and it costs one regex.
  const b64 = dataBase64.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw Object.assign(new Error('dataBase64 is not valid base64'), { code: 400 });
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw Object.assign(new Error('Decoded image is empty'), { code: 400 });
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Image is ' + Math.round(buf.length / 1024) + ' KB — the limit is ' +
      (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB'), { code: 413 });
  }
  return buf;
}

/** Cheap magic-byte sniff: refuse anything that is not actually an image. */
function sniffExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 256)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

/** Delete every existing file for a stem — an upload REPLACES, never stacks. */
function removeStem(dir, stem, exts) {
  let n = 0;
  for (const r of listImages(dir, exts)) {
    if (r.stem.toLowerCase() !== String(stem).toLowerCase()) continue;
    const abs = confine(dir, r.file);
    if (!abs) continue;
    try { fs.unlinkSync(abs); n++; } catch (_) { /* held open by the game? report below */ }
  }
  return n;
}

/** Windows locks a file the game is DRAWING: Ultralight keeps a rendered icon
 *  open for the session, so replacing e.g. Dragonknight.png mid-game fails with
 *  EBUSY (proven on the rig 2026-07-30 — the same file is writable once Skyrim
 *  exits). Retrying can't win against a session-long handle, so land the bytes
 *  under a free name instead and let the caller assign THAT. The stale file is
 *  left alone; it is unreferenced the moment the assignment points elsewhere.
 *
 *  `altStem(attempt)` names those retries. It is a parameter because the two
 *  callers need OPPOSITE things from the fallback name. An icon is referenced by
 *  filename from the config, so "Dragonknight-2.png" is fine — something records
 *  it. A PORTRAIT is looked up BY ITS NAME: the stem is the follower's slug, so
 *  the default would have written "lydia-2.png", whose slug is "lydia-2" —
 *  a portrait belonging to nobody, silently. Portraits pass the `~` version form
 *  instead, which both the portal and the deck resolve back to the slug. */
function writeImage(dir, stem, ext, buf, altStem) {
  const nameFor = (typeof altStem === 'function') ? altStem : ((n) => stem + '-' + (n + 2));
  if (!ensureDir(dir)) throw Object.assign(new Error('Cannot create ' + dir), { code: 500 });
  const first = confine(dir, stem + '.' + ext);
  if (!first) throw Object.assign(new Error('Refusing to write outside ' + dir), { code: 400 });

  let abs = first;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(abs, buf);
      break;
    } catch (e) {
      const locked = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!locked || attempt >= 20) {
        if (locked) {
          throw Object.assign(
            new Error('That file is open in the running game and 20 alternative names were taken too — close Skyrim and retry.'),
            { code: 503 });
        }
        throw e;
      }
      // Never a second extension, never a clobber.
      const next = confine(dir, nameFor(attempt) + '.' + ext);
      if (!next) throw Object.assign(new Error('Refusing to write outside ' + dir), { code: 400 });
      abs = next;
    }
  }

  const st = fs.statSync(abs);
  if (abs !== first) {
    log('"' + path.basename(first) + '" is locked by the running game — saved as "' + path.basename(abs) + '"');
  }
  return { file: path.basename(abs), ext, mtime: Math.floor(st.mtimeMs / 1000), size: st.size, renamed: abs !== first };
}

/* ===================================================================== *
 *  SHARMAT (CHIM aiagent_nsfw) — per-NPC intimacy profile, proxied
 *
 *  The ONLY slice of the portal that talks to something off-box: CHIM's
 *  admin API, `ext/aiagent_nsfw/config_manager.php`, living in the
 *  DwemerAI4Skyrim3 WSL distro. Three things make that safe
 *  enough to do from here, and they are worth stating because none of
 *  them is obvious:
 *
 *    1. It is UNAUTHENTICATED and LAN-only by construction (Apache binds
 *       0.0.0.0:8081 inside the distro). We add no credentials because
 *       there are none to add — do not expose the portal to the WAN.
 *    2. CHIM is only UP while the game is running. "Down" is the normal
 *       resting state, not an error, so every read answers 200 with
 *       ok:false + a human reason (same contract as /api/roster) and the
 *       SPA renders it inline instead of collapsing.
 *    3. Nothing here is queued through a sidecar the way FO edits are.
 *       Sharmat's store is Postgres, which the GAME does not hold open
 *       the way FO holds its JSON — so a write from the phone lands
 *       immediately and correctly, mid-session. This is the one deck
 *       surface where the phone is fully live.
 *
 *  ⛔ THE SAVE ENDPOINT IS DESTRUCTIVE ON A PARTIAL POST. ⛔
 *  handleSaveNpcNsfwSettings() reads most fields as `$_POST[x] ?? default`
 *  and `unset()`s prostitute_pricing / slave_speak_styles outright unless
 *  they are re-posted. Post only the field you changed and you WIPE
 *  sex_prompt, both kink lists, the unlock tiers and the pricing table.
 *  Hence saveNpc() below is strict read-modify-write and there is no
 *  "patch one field" path — see the comment on it.
 * ===================================================================== */

/* Where CHIM lives. Ordered candidates, first one that answers wins:
   the env override, then Windows→WSL2 localhost forwarding (the stable
   answer — WSL2 forwards a distro's listening ports onto the Windows
   loopback, so this survives the reboots that change the distro's IP),
   then the distro IP as it stood when this was written. */
const CHIM_BASE_ENV = process.env.DECK_PORTAL_CHIM_URL || '';
const CHIM_CANDIDATES = CHIM_BASE_ENV
  ? [CHIM_BASE_ENV.replace(/\/+$/, '')]
  : ['http://127.0.0.1:8081'];   // WSL projects the distro's ports onto loopback
const CHIM_PATH = '/HerikaServer/ext/aiagent_nsfw/config_manager.php';
const CHIM_TIMEOUT_MS = Number(process.env.DECK_PORTAL_CHIM_TIMEOUT || 6000);

/* Which candidate answered last, and when we last proved it. Re-probing on
   every request would add a round trip to each call; never re-probing would
   pin us to a dead base for the rest of the process. So: sticky, with the
   pin dropped the moment a call through it fails. */
let chimBase = null;

function chimUrl(base, action, query) {
  const qs = Object.keys(query || {})
    .filter((k) => query[k] !== undefined && query[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])))
    .join('&');
  return base + CHIM_PATH + '?action=' + encodeURIComponent(action) + (qs ? '&' + qs : '');
}

/* One HTTP round trip. Resolves { ok, status, json, text } — it never
   rejects for a protocol-level answer, only for a transport failure, so
   callers can tell "CHIM said no" from "CHIM isn't there". */
function chimRequest(urlStr, postBody) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('bad CHIM url: ' + urlStr)); return; }

    const payload = postBody === undefined ? null : Buffer.from(postBody, 'utf8');
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: payload ? 'POST' : 'GET',
      headers: payload
        ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length }
        : {},
    }, (r) => {
      const chunks = [];
      let size = 0;
      r.on('data', (c) => {
        size += c.length;
        // A misconfigured CHIM can answer with the whole HTML config page
        // (12k lines). Cap it rather than buffering that per request.
        if (size <= 2 * 1024 * 1024) chunks.push(c);
      });
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON — reported below */ }
        resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, json, text });
      });
    });

    /* A TIMEOUT and a REFUSED CONNECTION mean different things and must not be
       reported the same way. Refused = CHIM is not running (the normal resting
       state). Timed out = CHIM is up but did not answer in time — it serialises
       work behind a semaphore it has been measured holding for 8.5-12.4 s, so a
       busy server is a real possibility and "isn't running" would be a lie that
       sends you looking in the wrong place. */
    req.setTimeout(CHIM_TIMEOUT_MS, () => {
      req.destroy(Object.assign(
        new Error('did not answer within ' + CHIM_TIMEOUT_MS + ' ms (it may be busy)'),
        { chimBusy: true }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Call `action`, discovering/repairing the base URL as needed. Throws an
   Error carrying .chimDown when no candidate answered, so the routes can
   turn that into the friendly "CHIM isn't running" state rather than a 500. */
async function chimCall(action, query, postBody) {
  const tried = [];
  let busy = false;      // at least one candidate timed out rather than refusing
  const bases = chimBase ? [chimBase].concat(CHIM_CANDIDATES.filter((b) => b !== chimBase)) : CHIM_CANDIDATES.slice();

  for (const base of bases) {
    try {
      const r = await chimRequest(chimUrl(base, action, query), postBody);
      if (!r.ok) { tried.push(base + ' → HTTP ' + r.status); continue; }
      if (!r.json) {
        // Answered, but not with JSON: almost always a PHP fatal printed as
        // HTML. Surface the first line — it is the actual diagnosis.
        const first = r.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
        tried.push(base + ' → non-JSON reply (' + (first || 'empty') + ')');
        continue;
      }
      chimBase = base;   // pin the winner
      return r.json;
    } catch (e) {
      if (e && e.chimBusy) busy = true;
      tried.push(base + ' → ' + e.message);
    }
  }

  chimBase = null;       // drop the pin so the next call re-probes everything
  throw Object.assign(
    new Error(busy
      ? 'CHIM is up but did not answer in time — it may be busy. Tried: ' + tried.join('; ')
      : 'CHIM did not answer. Is the CHIM server running? Tried: ' + tried.join('; ')),
    { chimDown: !busy, chimBusy: busy, tried });
}

function chimForm(obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])))
    .join('&');
}

/* The field set the editor owns, in the shape the SPA speaks. Kept as ONE
   list so the round trip (load → merge → save) can be written once and
   cannot drift between the two directions. `post` is the POST key
   config_manager.php reads; `load` is the key it answers with. */
const SHARMAT_FIELDS = [
  { key: 'speak_style',              post: 'speak_style',              kind: 'str' },
  { key: 'profanity_level',          post: 'profanity_level',          kind: 'str' },
  { key: 'sex_prompt',               post: 'sex_prompt',               kind: 'str' },
  { key: 'kinks',                    post: 'kinks',                    kind: 'json' },
  { key: 'secret_kinks',             post: 'secret_kinks',             kind: 'json' },
  { key: 'kinks_unlock_tier',        post: 'kinks_unlock_tier',        kind: 'int' },
  { key: 'secret_kinks_unlock_tier', post: 'secret_kinks_unlock_tier', kind: 'int' },
  { key: 'is_slave',                 post: 'is_slave',                 kind: 'bool' },
  { key: 'is_prostitute',            post: 'is_prostitute',            kind: 'bool' },
  { key: 'is_slut',                  post: 'is_slut',                  kind: 'bool' },
  { key: 'slave_fiction_frame',      post: 'slave_fiction_frame',      kind: 'bool' },
  { key: 'spousal_status',           post: 'spousal_status',           kind: 'str' },
  { key: 'spouse_names',             post: 'spouse_names',             kind: 'str' },
  { key: 'sexual_orientation',       post: 'sexual_orientation',       kind: 'str' },
  { key: 'relationship_preference',  post: 'relationship_preference',  kind: 'str' },
  { key: 'pricing',                  post: 'pricing',                  kind: 'json' },
  { key: 'prostitute_price',         post: 'prostitute_price',         kind: 'int' },
  { key: 'slave_speak_styles',       post: 'slave_speak_styles',       kind: 'json' },
];

async function loadNpc(name) {
  const r = await chimCall('loadNpcNsfwSettings', { npc: name });
  if (!r || r.success !== true) throw new Error((r && r.error) || 'CHIM refused the read');
  return { data: r.data || {}, isNew: !!r.is_new };
}

/* Read-modify-write, always. See the destructive-save warning at the top of
   this section: there is deliberately NO way to post a single field from
   here, because doing so silently erases every field you did not send. The
   caller hands us a sparse `patch`; we load the CURRENT profile, lay the
   patch over it, and post the whole set back. */
async function saveNpc(name, patch) {
  const cur = (await loadNpc(name)).data;
  const merged = Object.assign({}, cur, patch || {});

  const form = { npc: name, source: 'manual' };
  for (const f of SHARMAT_FIELDS) {
    const v = merged[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === 'json') form[f.post] = JSON.stringify(v);
    else if (f.kind === 'bool') form[f.post] = v ? 'true' : 'false';
    else if (f.kind === 'int') form[f.post] = String(Math.trunc(Number(v) || 0));
    else form[f.post] = String(v);
  }
  // Both are conditional on their flag server-side and are unset() when the
  // flag is off — so only send them when they can survive, and never
  // resurrect a stale pricing table onto someone no longer flagged.
  if (!merged.is_prostitute) { delete form.pricing; delete form.prostitute_price; }
  if (!merged.is_slave) { delete form.slave_speak_styles; }

  const r = await chimCall('saveNpcNsfwSettings', {}, chimForm(form));
  if (!r || r.success !== true) throw new Error((r && r.error) || 'CHIM refused the write');
  return r;
}

/* =============================== routes ================================ */

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  /* ---- SPA ---- */
  /* The SPA can sit open for days on a phone; this is how it notices a deploy.
     v = index.html's mtime — the client compares on tab-focus and reloads
     itself when it changes (unless mid-edit). */
  if (m === 'GET' && p === '/api/page-version') {
    let v = 0;
    try { v = Math.floor(fs.statSync(SPA_FILE).mtimeMs); } catch (_) {}
    sendJson(res, 200, { ok: v > 0, v });
    return;
  }

  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    fs.readFile(SPA_FILE, (err, buf) => {
      if (err) { sendErr(res, 500, 'index.html is missing next to server.js (' + SPA_FILE + ')'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  /* ---- diagnostics ---- */
  if (m === 'GET' && p === '/api/health') {
    const r = readRoster();
    // ONE snapshot of hotkeys.json for both slices, so the spell count and the
    // hotkey count reported here can never come from different saves.
    const cfg = readHkRoot();
    const mg = readMagic(cfg);
    const hk = readHotkeys(cfg);
    sendJson(res, 200, Object.assign({
      ok: true,
      port: PORT,
      modHd: MOD_HD,
      foJson: FO_JSON,
      portraitDir: PORTRAIT_DIR,
      iconDir: ICON_DIR,
      deckIconDir: DECK_ICON_DIR,
      portraitDirExists: fs.existsSync(PORTRAIT_DIR),
      overwriteDir: MO_OVERWRITE,
      overwritePortraitDir: OVERWRITE_PORTRAIT_DIR,
      overwritePortraitDirExists: fs.existsSync(OVERWRITE_PORTRAIT_DIR),
      iconDirExists: fs.existsSync(ICON_DIR),
      // The deck view's icons/ tree is NEW in v0.11.0 — if this is false, hotkey
      // icons resolve to nothing in-game until the deployer robocopies it over.
      hkIconDirExists: fs.existsSync(DECK_ICON_DIR),
      roster: { ok: r.ok, error: r.error || null, shape: r.shape, total: r.total },
      // Which hotkeys.json candidate won, and why — the first question to ask
      // when the spell or hotkey list looks stale or empty.
      hkJson: cfg.file,
      hkJsonCandidates: HK_JSON_CANDIDATES.map((c) => ({ path: c, exists: fs.existsSync(c) })),
      magic: {
        ok: mg.ok,
        error: mg.error || null,
        hasMagicSlice: !!mg.magic,
        spells: (mg.magic && Array.isArray(mg.magic.spells)) ? mg.magic.spells.length : 0,
        categories: (mg.magic && Array.isArray(mg.magic.categories)) ? mg.magic.categories.length : 0,
      },
      hotkeys: {
        ok: hk.ok,
        error: hk.error || null,
        entries: hk.entries.length,
        categories: hk.categories.length,
      },
      // Both sidecars that live in the deck's view folder (NPC fields + hotkey
      // edits) need this dir; if it is false, neither can be handed over.
      npcFieldsDirExists: fs.existsSync(DECK_VIEW_DIR),
      hkEditDirExists: fs.existsSync(DECK_VIEW_DIR),
      /* Category glyphs. `seeded:false` means the plugin has never run with a
         build that owns this bridge — the queue still works (it is applied at
         the next launch), but nothing chosen now can reach a RUNNING game,
         because MO2 fixed the visible file list at launch. */
      catIcons: (() => {
        const cur = readCatIcons();
        const live = readCatIconsLive(cfg);
        return {
          file: cur.file, seeded: cur.exists, malformed: cur.malformed,
          pending: cur.list.length, set: Object.keys(live.icons).length,
          slotMax: CATICON_SLOT_MAX,
        };
      })(),
      /* My Home is Your Home NG — the day. `statusOk:false` with every
         candidate `exists:false` is the expected answer before the deck has
         pushed a Followers state, and is the FIRST thing to check when a
         follower sheet shows no day at all. `installed:false` with
         `statusOk:true` is the different, honest answer: the export ran and
         the mod is not in the load order. */
      mhiyh: (() => {
        const v = mhiyhView();
        return {
          installed: v.installed, statusOk: v.statusOk,
          statusFile: v.statusFile, statusAgeHours: v.statusAgeHours,
          statusCandidates: MHIYH_STATUS_CANDIDATES.map((c) => ({ path: c, exists: fs.existsSync(c) })),
          npcs: v.npcs.length,
          withHome: v.npcs.filter((n) => n.home).length,
          pending: v.pending, pendingUnknown: v.pendingUnknown, malformed: v.malformed,
          pendingFile: v.pendingFile,
          ttlMs: v.ttlMs, settable: v.settable, positional: v.positional,
        };
      })(),
      /* Dragon Roost — a different mod, so it is reported as its own block.
         `waiting:true` with every candidate `exists:false` is the expected
         answer before the DLL has ever run, and is the FIRST thing to check
         when the Dragons tab looks empty. */
      roost: (() => {
        const dr = readRoost();
        return {
          modDir: MOD_DR,
          waiting: dr.waiting, error: dr.error || null,
          statusFile: dr.statusFile,
          statusCandidates: DR_STATUS_CANDIDATES.map((c) => ({ path: c, exists: fs.existsSync(c) })),
          queueFile: drQueueFile(),
          queueCandidates: DR_QUEUE_CANDIDATES.map((c) => ({ path: c, exists: fs.existsSync(c) })),
          queueDirExists: fs.existsSync(path.dirname(drQueueFile())),
          pending: dr.pending, pendingMalformed: dr.pendingMalformed,
          species: dr.species.length, skins: dr.skins.length,
          dragons: dr.dragons.length, eggs: dr.eggs.length, pairs: dr.pairs.length,
          collection: dr.collection,
          ops: Object.keys(DR_OPS),
          /* WHICH KEY NAMES A PICTURE. The C++ half chose its spelling after
             this reader was written, so `accepts` is the closed set we will
             answer to and `found` is what the live document actually used —
             `{}` with a non-zero `withPortrait` of 0 is the whole diagnosis
             when the pane shows glyphs although the renders exist. */
          portraitKeys: {
            accepts: DR_PORTRAIT_KEYS,
            found: Object.assign({}, drPortraitKeysSeen),
            withPortrait: {
              species: dr.species.filter((s) => s.portraitUrl).length,
              skins: dr.skins.filter((s) => s.portraitUrl).length,
              dragons: dr.dragons.filter((d) => d.portraitUrl).length,
              eggs: dr.eggs.filter((e) => e.portraitUrl).length,
            },
            thumbCache: DR_THUMB_DIR,
            thumbWidths: DR_THUMB_WIDTHS,
          },
        };
      })(),
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES, portraitExts: PORTRAIT_EXTS, iconExts: ICON_EXTS,
        fieldKeyPattern: FIELD_KEY_RE.source, fieldValueMax: FIELD_VALUE_MAX,
        hotkeyNameMax: HK_NAME_MAX, hotkeyDescMax: HK_DESC_MAX,
        hotkeyLabelMax: HK_LABEL_MAX, hotkeyModsMax: HK_MODS_MAX,
      },
    }, pendingSummary()));
    return;
  }

  /* ---- roster ---- */
  if (m === 'GET' && p === '/api/roster') {
    // 200 even when ok:false — the SPA renders the diagnostic inline instead
    // of collapsing into a generic "fetch failed".
    sendJson(res, 200, readRoster());
    return;
  }

  /* ---- NPC fields (relationship, home, …) ----
     Queues ONE field edit for ONE person. Never writes FollowerOrganizer.json;
     the deck replays the sidecar through the FO Deck API on its next open.
     Body: { original | slug, key, value }  ·  value "" erases the field. */
  if (m === 'POST' && p === '/api/npc-field') {
    const body = await readJsonBody(req);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!FIELD_KEY_RE.test(key)) {
      sendErr(res, 400, 'Bad field key — lowercase a–z, 0–9, _ and - only, max 32 (got "' +
        String(body.key).slice(0, 60) + '")');
      return;
    }
    if (body.value !== undefined && body.value !== null && typeof body.value !== 'string') {
      sendErr(res, 400, 'value must be a string ("" clears the field)');
      return;
    }
    const rawValue = typeof body.value === 'string' ? body.value.trim() : '';
    if (rawValue.length > FIELD_VALUE_MAX) {
      sendErr(res, 400, 'That value is ' + rawValue.length + ' characters — the limit is ' +
        FIELD_VALUE_MAX + '. Put the long version in the note instead.');
      return;
    }
    const original = typeof body.original === 'string' ? body.original.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!original && !slug) { sendErr(res, 400, 'original (or slug) is required'); return; }
    if (slug && !original && !validSlug(slug.toLowerCase())) { sendErr(res, 400, 'Bad slug'); return; }

    const hit = findMemberByName(original, slug);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }

    let list;
    try { list = mergeNpcField(hit.member.original, key, rawValue); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('npc field: "' + hit.member.original + '" ' + key + ' -> ' +
      (rawValue ? '"' + rawValue + '"' : '(cleared)') +
      (hit.entries > 1 ? ' [' + hit.entries + ' category entries]' : ''));
    sendJson(res, 200, {
      ok: true,
      original: hit.member.original,
      slug: hit.member.slug,
      key,
      value: rawValue,
      entries: hit.entries,
      pendingNpcFields: list.length,
      file: NPCF_FILE,
    });
    return;
  }

  /* ---- Follower-Organizer category ops (move + rename) ----
     Queues ONE category op. Never writes FollowerOrganizer.json; the deck
     replays the sidecar through the FO Deck API's moveMember / renameCategory
     on its next Followers open (that C++ pickup is DEFERRED — see
     src/portal-fo-ops-wiring.md). Two shapes:
       { type:'move', original|slug, toCat, toCatName? }
       { type:'renameCategory', cat, name }   ·  name "" resets the slot. */
  if (m === 'POST' && p === '/api/fo-op') {
    const body = await readJsonBody(req);
    const type = typeof body.type === 'string' ? body.type : '';

    if (type === 'move') {
      const toCat = Number(body.toCat);
      if (!foCatOk(toCat)) { sendErr(res, 400, 'toCat must be a category slot index (integer ≥ 1)'); return; }
      const original = typeof body.original === 'string' ? body.original.trim() : '';
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!original && !slug) { sendErr(res, 400, 'original (or slug) is required'); return; }
      if (slug && !original && !validSlug(slug.toLowerCase())) { sendErr(res, 400, 'Bad slug'); return; }
      // The person must exist, and the destination must be a real category —
      // same rule as findMemberByName, so a stale phone can't queue a ghost move.
      const hit = findMemberByName(original, slug);
      if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }
      const dest = foCategoryByIndex(toCat);
      if (!dest.ok) { sendErr(res, dest.code, dest.error); return; }
      const toCatName = typeof body.toCatName === 'string' && body.toCatName.trim()
        ? body.toCatName.trim().slice(0, FO_CAT_NAME_MAX) : dest.category.name;
      let list;
      try { list = mergeFoOp({ type: 'move', original: hit.member.original, toCat, toCatName }); }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
      log('fo move queued: "' + hit.member.original + '" -> slot ' + toCat + ' (' + toCatName + ')');
      sendJson(res, 200, {
        ok: true, type: 'move', original: hit.member.original, slug: hit.member.slug,
        toCat, toCatName, pendingFoOps: list.length, file: FO_OPS_FILE,
      });
      return;
    }

    if (type === 'setDesc') {
      /* The note under her name — FO's Description. Queued like everything
         else; the deck applies it through the FO Deck API's setDesc. */
      const original = typeof body.original === 'string' ? body.original.trim() : '';
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!original && !slug) { sendErr(res, 400, 'original (or slug) is required'); return; }
      if (body.desc !== undefined && body.desc !== null && typeof body.desc !== 'string') {
        sendErr(res, 400, 'desc must be a string ("" clears the note)'); return;
      }
      const desc = typeof body.desc === 'string' ? body.desc.trim() : '';
      if (desc.length > FO_CAT_NAME_MAX) {
        sendErr(res, 400, 'That note is ' + desc.length + ' characters — the limit is ' + FO_CAT_NAME_MAX);
        return;
      }
      const hit = findMemberByName(original, slug);
      if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }
      let list;
      try { list = mergeFoOp({ type: 'setDesc', original: hit.member.original, desc }); }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
      log('fo note queued: "' + hit.member.original + '" -> ' + (desc ? '"' + desc + '"' : '(cleared)'));
      sendJson(res, 200, {
        ok: true, type: 'setDesc', original: hit.member.original, slug: hit.member.slug,
        desc, pendingFoOps: list.length, file: FO_OPS_FILE,
      });
      return;
    }

    if (type === 'delete') {
      /* Take her off Follower Organizer's roster entirely. Requires an explicit
         confirm:true on the wire — the phone arms it with a second tap, and the
         server refuses a bare request so a stray POST (a replayed request, a
         fat-fingered curl) cannot un-file someone.

         This un-FILES her. It does not dismiss, disable or touch the actor in
         any way: FO is a filing cabinet, and the wording everywhere says so. */
      const original = typeof body.original === 'string' ? body.original.trim() : '';
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      if (!original && !slug) { sendErr(res, 400, 'original (or slug) is required'); return; }
      if (slug && !original && !validSlug(slug.toLowerCase())) { sendErr(res, 400, 'Bad slug'); return; }
      if (body.confirm !== true) {
        sendErr(res, 400, 'Removing someone from the roster needs confirm:true'); return;
      }
      const hit = findMemberByName(original, slug);
      if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }
      let list;
      try { list = mergeFoOp({ type: 'delete', original: hit.member.original }); }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
      log('fo delete queued: "' + hit.member.original + '"');
      sendJson(res, 200, {
        ok: true, type: 'delete', original: hit.member.original, slug: hit.member.slug,
        pendingFoOps: list.length, file: FO_OPS_FILE,
      });
      return;
    }

    if (type === 'renameCategory') {
      const cat = Number(body.cat);
      if (!foCatOk(cat)) { sendErr(res, 400, 'cat must be a category slot index (integer ≥ 1)'); return; }
      if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
        sendErr(res, 400, 'name must be a string ("" resets the category to its FO name)'); return;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length > FO_CAT_NAME_MAX) {
        sendErr(res, 400, 'That name is ' + name.length + ' characters — the limit is ' + FO_CAT_NAME_MAX); return;
      }
      const dest = foCategoryByIndex(cat);
      if (!dest.ok) { sendErr(res, dest.code, dest.error); return; }
      let list;
      try { list = mergeFoOp({ type: 'renameCategory', cat, name }); }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
      log('fo rename queued: slot ' + cat + ' -> ' + (name ? '"' + name + '"' : '(reset)'));
      sendJson(res, 200, {
        ok: true, type: 'renameCategory', cat, name, pendingFoOps: list.length, file: FO_OPS_FILE,
      });
      return;
    }

    sendErr(res, 400, 'type must be "move", "delete", "setDesc" or "renameCategory" (got "' + String(body.type).slice(0, 40) + '")');
    return;
  }

  /* ---------------- NFF home BASES: snapshot + op queue ---------------- */

  /* The deck's Bases model (whatever the last in-game Bases open shared), plus
     how many phone ops are still waiting to be picked up. */
  if (m === 'GET' && p === '/api/bases') {
    const snap = readBasesSnapshot();
    const ops = readBasesOps();
    sendJson(res, 200, Object.assign({}, snap, { pendingOps: ops.list.length, opsMalformed: ops.malformed }));
    return;
  }

  /* Queue one base edit for the deck to replay. Only the ops that make sense
     without the player's body (see BASES_PHONE_OPS). */
  if (m === 'POST' && p === '/api/bases-op') {
    const body = await readJsonBody(req);
    const op = typeof body.op === 'string' ? body.op : '';
    if (!BASES_PHONE_OPS.includes(op)) {
      sendErr(res, 400, 'That base action can’t be done from the phone (setting a spot needs you to be standing there)');
      return;
    }
    const rec = { op };
    const baseOk = (b) => Number.isInteger(b) && b >= 0;
    if (op === 'rename') {
      const base = Number(body.base);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, BASES_NAME_MAX) : '';
      if (!baseOk(base)) { sendErr(res, 400, 'base index required'); return; }
      if (!name) { sendErr(res, 400, 'A base name is required'); return; }
      rec.base = base; rec.name = name;
    } else if (op === 'label') {
      const base = Number(body.base); const kind = Number(body.kind);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, BASES_NAME_MAX) : '';
      if (!baseOk(base) || ![0, 1, 2].includes(kind)) { sendErr(res, 400, 'base and kind (0/1/2) required'); return; }
      if (!name) { sendErr(res, 400, 'A label is required'); return; }
      rec.base = base; rec.kind = kind; rec.name = name;
    } else if (op === 'assign') {
      const base = Number(body.base);
      const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
      if (!baseOk(base) || !formId) { sendErr(res, 400, 'base and formId required'); return; }
      rec.base = base; rec.formId = formId;
    } else if (op === 'unassign') {
      const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
      if (!formId) { sendErr(res, 400, 'formId required'); return; }
      rec.formId = formId;
    } else if (op === 'owner') {
      rec.on = !!body.on;
    } else if (op === 'time') {
      const which = typeof body.which === 'string' ? body.which : '';
      const value = Number(body.value);
      const TW = ['workStart', 'workEnd', 'relaxStart', 'relaxEnd', 'sleepStart', 'sleepEnd'];
      if (!TW.includes(which) || !Number.isInteger(value) || value < 0 || value > 23) {
        sendErr(res, 400, 'which and value (0–23) required'); return;
      }
      rec.which = which; rec.value = value;
    }
    let list;
    try { list = queueBasesOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('bases op queued: ' + op + (rec.base != null ? ' base ' + (rec.base + 1) : '') + (rec.formId ? ' ' + rec.formId : ''));
    sendJson(res, 200, { ok: true, op, pendingOps: list.length, file: BASES_OPS_FILE });
    return;
  }

  /* GET the queued category ops, so the phone can list and clear what is waiting. */
  if (m === 'GET' && p === '/api/fo-ops') {
    const fo = readFoOps();
    sendJson(res, 200, {
      ok: true, file: FO_OPS_FILE,
      ops: fo.list, pending: fo.list.length,
      pendingMove: fo.list.filter((o) => o.type === 'move').length,
      pendingRename: fo.list.filter((o) => o.type === 'renameCategory').length,
      malformed: fo.malformed,
    });
    return;
  }

  /* Clear queued category ops. `?all=1` drops everything; otherwise the body
     names one to drop: { type:'move', original } or { type:'renameCategory', cat }. */
  if (m === 'DELETE' && p === '/api/fo-op') {
    if (url.searchParams.get('all') === '1') {
      const out = removeFoOps(null);
      log('fo ops cleared: ' + out.removed + ' dropped');
      sendJson(res, 200, { ok: true, cleared: out.removed, pendingFoOps: out.list.length, file: FO_OPS_FILE });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch (_) { body = {}; }
    const type = typeof body.type === 'string' ? body.type : '';
    let pred = null;
    if (type === 'move') {
      const original = typeof body.original === 'string' ? body.original.trim().toLowerCase() : '';
      if (!original) { sendErr(res, 400, 'original is required to clear one move (or pass ?all=1)'); return; }
      pred = (e) => e.type === 'move' && e.original.toLowerCase() === original;
    } else if (type === 'renameCategory') {
      const cat = Number(body.cat);
      if (!foCatOk(cat)) { sendErr(res, 400, 'cat is required to clear one rename (or pass ?all=1)'); return; }
      pred = (e) => e.type === 'renameCategory' && e.cat === cat;
    } else {
      sendErr(res, 400, 'Pass ?all=1, or a body { type:"move", original } / { type:"renameCategory", cat }');
      return;
    }
    const out = removeFoOps(pred);
    if (!out.removed) {
      sendErr(res, 404, 'Nothing matching was queued — reload (⟳); the game may already have applied it.');
      return;
    }
    log('fo op cleared: ' + type + (type === 'move' ? ' ' + body.original : ' slot ' + body.cat));
    sendJson(res, 200, { ok: true, cleared: out.removed, pendingFoOps: out.list.length, file: FO_OPS_FILE });
    return;
  }

  /* ---- category glyphs (the Followers rail's icons) ----
     Queues ONE category's icon. Never writes hotkeys.json: the plugin merges
     the queue into `followers.catIcons` and persists it itself.
     Body: { cat, icon }  ·  icon "" removes the glyph.
     `icon` obeys the SAME rule as a hotkey icon — "" , an "icons/custom/…"
     upload, or an "icons/sh/…" library path that exists IN THE DECK'S tree —
     because the deck view is what has to paint it. */
  if (m === 'POST' && p === '/api/cat-icon') {
    const body = await readJsonBody(req);
    const cat = Number(body.cat);
    if (!catIconSlotOk(cat)) {
      sendErr(res, 400, 'cat must be a category slot index (0–' + CATICON_SLOT_MAX +
        ') — the deck stores glyphs by slot, not by name');
      return;
    }
    const dest = foCategoryByIndex(cat);
    if (!dest.ok) { sendErr(res, dest.code, dest.error); return; }
    const chk = checkAssignIcon(body.icon, 'hotkey');
    if (!chk.ok) { sendErr(res, 400, chk.error); return; }
    // Same reason as /api/hotkey-assign: the DECK resolves the path against its
    // own folder, so the bytes must be there before the change can be applied,
    // or the header paints nothing and it reads as a failed assignment.
    if (chk.icon && chk.icon.startsWith(ICON_PREFIX)) ensureDeckCopy(chk.icon.slice(ICON_PREFIX.length));
    let list;
    try { list = mergeCatIcon(cat, chk.icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('cat icon queued: slot ' + cat + ' (' + dest.category.name + ') -> ' + (chk.icon || '(none)'));
    const shown = iconUrlFor(chk.icon, 'hotkey');
    sendJson(res, 200, {
      ok: true, cat, catName: dest.category.name, icon: chk.icon,
      iconUrl: shown ? shown.url : null,          // lets the SPA repaint without a reload
      pendingCatIcons: list.length, file: catIconBridgeFile(),
    });
    return;
  }

  /* Upload art FOR A CATEGORY: writes the file into the shared pool (both
     trees), then queues the assignment. Two effects, one tap — the same shape
     as /api/hotkey-icon, which this is a deliberate twin of. */
  if (m === 'POST' && p === '/api/cat-icon-image') {
    const body = await readJsonBody(req);
    const cat = Number(body.cat);
    if (!catIconSlotOk(cat)) { sendErr(res, 400, 'cat must be a category slot index (0–' + CATICON_SLOT_MAX + ')'); return; }
    const dest = foCategoryByIndex(cat);
    if (!dest.ok) { sendErr(res, dest.code, dest.error); return; }

    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;   // trust the bytes over the label

    const explicit = typeof body.iconName === 'string' && body.iconName.trim();
    let name;
    if (explicit) {
      name = body.iconName.trim();
      if (!validIconName(name)) {
        sendErr(res, 400, 'Bad icon name — letters, digits, space, _ and - only, no dots (got "' +
          String(body.iconName).slice(0, 60) + '")'); return;
      }
    } else {
      // Uniquified against the pool, so art for a second category called
      // something similar cannot silently repaint the first one's glyph.
      const queued = readCatIcons().list.filter((e) => e.cat === cat)[0];
      const curFile = ownPoolFile(liveCatIcon(cat), queued ? queued.icon : undefined);
      name = freeIconName(iconNameFrom(dest.category.name, 'category icon'), curFile);
    }

    const replaced = !!findByStem(ICON_DIR, name, ICON_EXTS);
    removeStem(ICON_DIR, name, ICON_EXTS);
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }

    const icon = ICON_PREFIX + info.file;
    let list;
    try { list = mergeCatIcon(cat, icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), 'Icon saved as ' + info.file + ' but the assignment could not be queued: ' + e.message);
      return;
    }
    const landed = path.parse(info.file).name;
    log('cat icon: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB) queued for slot ' +
      cat + ' (' + dest.category.name + ')');
    sendJson(res, 200, {
      ok: true, cat, catName: dest.category.name, icon,
      name: landed, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size, replaced,
      url: '/api/icon-file/' + encodeURIComponent(landed) + '?v=' + info.mtime,
      pendingCatIcons: list.length,
    });
    return;
  }

  /* GET the queued glyphs, so the phone can list and clear what is waiting. */
  if (m === 'GET' && p === '/api/cat-icons') {
    const cur = readCatIcons();
    const live = readCatIconsLive();
    sendJson(res, 200, {
      ok: true, file: cur.file, set: cur.list, pending: cur.list.length,
      malformed: cur.malformed, live: live.icons, hkJson: live.file,
      slotMax: CATICON_SLOT_MAX,
    });
    return;
  }

  /* Clear queued glyphs. `?all=1` drops everything; otherwise { cat }. */
  if (m === 'DELETE' && p === '/api/cat-icon') {
    if (url.searchParams.get('all') === '1') {
      const out = removeCatIcons(null);
      log('cat icons cleared: ' + out.removed + ' dropped');
      sendJson(res, 200, { ok: true, cleared: out.removed, pendingCatIcons: out.list.length, file: catIconBridgeFile() });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch (_) { body = {}; }
    const cat = Number(body.cat);
    if (!catIconSlotOk(cat)) { sendErr(res, 400, 'cat is required to clear one glyph (or pass ?all=1)'); return; }
    const out = removeCatIcons((e) => e.cat === cat);
    if (!out.removed) {
      sendErr(res, 404, 'Nothing was queued for slot ' + cat + ' — reload (⟳); the game may already have applied it.');
      return;
    }
    log('cat icon cleared: slot ' + cat);
    sendJson(res, 200, { ok: true, cleared: out.removed, pendingCatIcons: out.list.length, file: catIconBridgeFile() });
    return;
  }

  /* ---- Spell Deck rail glyphs (portal-spell-cat-icons.json) ---- *
   *  Twin of the follower cat-icon trio above, keyed by category NAME. */
  if (m === 'POST' && p === '/api/spell-cat-icon') {
    const body = await readJsonBody(req);
    const cat = typeof body.cat === 'string' ? body.cat : '';
    if (!spellCatNameOk(cat)) {
      sendErr(res, 400, 'cat must be the spell category NAME (1–' + SPELLCAT_NAME_MAX +
        ' chars) — the Spell Deck rail has no slot indexes');
      return;
    }
    const mg = readMagic();
    if (!mg.ok) { sendErr(res, 503, mg.error); return; }
    const cats = (mg.magic && Array.isArray(mg.magic.categories)) ? mg.magic.categories : [];
    if (!cats.includes(cat)) {
      sendErr(res, 404, 'No spell category named "' + cat + '" — rail holds: ' +
        (cats.length ? cats.join(' · ') : '(none yet)'));
      return;
    }
    const chk = checkAssignIcon(body.icon, 'magic');
    if (!chk.ok) { sendErr(res, 400, chk.error); return; }
    let list;
    try { list = mergeSpellCatIcon(cat, chk.icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('spell cat icon queued: "' + cat + '" -> ' + (chk.icon || '(none)'));
    const shown = iconUrlFor(chk.icon, 'magic');
    sendJson(res, 200, {
      ok: true, cat, icon: chk.icon,
      iconUrl: shown ? shown.url : null,
      pendingSpellCatIcons: list.length, file: spellCatIconBridgeFile(),
    });
    return;
  }

  /* Upload art FOR A SPELL CATEGORY: pool write + queued assignment, one tap —
     the same twin-shape as /api/cat-icon-image above. */
  if (m === 'POST' && p === '/api/spell-cat-icon-image') {
    const body = await readJsonBody(req);
    const cat = typeof body.cat === 'string' ? body.cat : '';
    if (!spellCatNameOk(cat)) { sendErr(res, 400, 'cat must be the spell category NAME'); return; }
    const mg = readMagic();
    if (!mg.ok) { sendErr(res, 503, mg.error); return; }
    const cats = (mg.magic && Array.isArray(mg.magic.categories)) ? mg.magic.categories : [];
    if (!cats.includes(cat)) { sendErr(res, 404, 'No spell category named "' + cat + '"'); return; }

    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;

    const explicit = typeof body.iconName === 'string' && body.iconName.trim();
    let name;
    if (explicit) {
      name = body.iconName.trim();
      if (!validIconName(name)) {
        sendErr(res, 400, 'Bad icon name — letters, digits, space, _ and - only, no dots (got "' +
          String(body.iconName).slice(0, 60) + '")'); return;
      }
    } else {
      const queued = readSpellCatIcons().list.filter((e) => e.cat === cat)[0];
      const liveIcons = readSpellCatIconsLive().icons;
      const curFile = ownPoolFile(liveIcons[cat] || '', queued ? queued.icon : undefined);
      name = freeIconName(iconNameFrom(cat, 'spell category icon'), curFile);
    }

    const replaced = !!findByStem(ICON_DIR, name, ICON_EXTS);
    removeStem(ICON_DIR, name, ICON_EXTS);
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }

    const icon = ICON_PREFIX + info.file;
    let list;
    try { list = mergeSpellCatIcon(cat, icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), 'Icon saved as ' + info.file + ' but the assignment could not be queued: ' + e.message);
      return;
    }
    const landed = path.parse(info.file).name;
    log('spell cat icon: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB) queued for "' + cat + '"');
    sendJson(res, 200, {
      ok: true, cat, icon,
      name: landed, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size, replaced,
      url: '/api/icon-file/' + encodeURIComponent(landed) + '?v=' + info.mtime,
      pendingSpellCatIcons: list.length,
    });
    return;
  }

  if (m === 'GET' && p === '/api/spell-cat-icons') {
    const cur = readSpellCatIcons();
    const live = readSpellCatIconsLive();
    const mg = readMagic();
    const names = (mg.ok && mg.magic && Array.isArray(mg.magic.categories))
      ? mg.magic.categories.filter((c) => typeof c === 'string' && c) : [];
    // Folded per-category rows in the roster's wire shape (icon / iconUrl /
    // iconKind / iconMissing / pendingIcon / pendingIconUrl) so the SPA's
    // effectiveIcon()/effectiveUrl()/icon sheet work on them unchanged.
    const queuedAt = Object.create(null);
    for (const e of cur.list) queuedAt[e.cat] = e;
    const cats = names.map((name) => {
      const icon = live.icons[name] || '';
      const shown = icon ? iconUrlFor(icon, 'magic') : null;
      const row = {
        name, icon,
        iconUrl: shown ? shown.url : null,
        iconKind: icon ? 'custom' : 'none',
        iconMissing: !!(shown && shown.missing),
        pendingIcon: null, pendingIconUrl: null, pendingIconKind: null,
      };
      const qd = queuedAt[name];
      if (qd) {
        row.pendingIcon = qd.icon;
        const pu = qd.icon ? iconUrlFor(qd.icon, 'magic') : null;
        row.pendingIconUrl = pu ? pu.url : null;
        row.pendingIconKind = qd.icon ? 'custom' : 'none';
      }
      return row;
    });
    sendJson(res, 200, {
      ok: true, file: cur.file, set: cur.list, pending: cur.list.length,
      malformed: cur.malformed, live: live.icons, hkJson: live.file,
      categories: names, cats,
    });
    return;
  }

  if (m === 'DELETE' && p === '/api/spell-cat-icon') {
    if (url.searchParams.get('all') === '1') {
      const out = removeSpellCatIcons(null);
      log('spell cat icons cleared: ' + out.removed + ' dropped');
      sendJson(res, 200, { ok: true, cleared: out.removed, pendingSpellCatIcons: out.list.length, file: spellCatIconBridgeFile() });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch (_) { body = {}; }
    const cat = typeof body.cat === 'string' ? body.cat : '';
    if (!spellCatNameOk(cat)) { sendErr(res, 400, 'cat (the category name) is required to clear one glyph (or pass ?all=1)'); return; }
    const out = removeSpellCatIcons((e) => e.cat === cat);
    if (!out.removed) {
      sendErr(res, 404, 'Nothing was queued for "' + cat + '" — reload (⟳); the game may already have applied it.');
      return;
    }
    log('spell cat icon cleared: "' + cat + '"');
    sendJson(res, 200, { ok: true, cleared: out.removed, pendingSpellCatIcons: out.list.length, file: spellCatIconBridgeFile() });
    return;
  }

  /* ---- Sharmat (CHIM intimacy profiles) ---- *
   *  Unlike every other write in this file, these are LIVE: they go straight
   *  into CHIM's Postgres, not into a sidecar the game replays later. See the
   *  section banner above for why that is safe here and nowhere else.
   *
   *  All three answer 200 with ok:false when CHIM is down (the normal resting
   *  state — it only runs while the game is running), so the SPA can say so
   *  inline instead of showing a dead fetch. */

  /* ===================== Faces tab (RaceMenu presets) ================== *
   *  Browse presets, set their images from a phone photo, and apply. The
   *  preset LIST comes live from Preset Director's HTTP API when the game is
   *  running, else from faces-catalogue.json (written by the in-game Faces tab
   *  the last time it opened). Images + assign.json are plain files this
   *  process owns — assign.json is NOT rewritten by the game on exit (unlike
   *  hotkeys.json), so writing it here is safe. Applying needs the running
   *  game (PD is in-process), so it relays to PD and 503s when it is closed. */

  if (m === 'GET' && p === '/api/faces') {
    const assign = readPresetAssign();
    const images = listPresetImages();
    // Prefer PD live (full VFS view); fall back to the on-disk catalogue.
    const live = await pdReq('GET', '/presets');
    const reg = live ? await pdReq('GET', '/registry') : null;
    let presets = [], registry = { entries: [] }, source = 'none', available = false;
    if (live && live.ok) {
      const ex = (live.exported || []), pr = (live.presets || []);
      presets = dedupePresetNames(ex.concat(pr));
      registry = (reg && reg.entries) ? reg : { entries: [] };
      source = 'live'; available = true;
    } else {
      const cat = readFacesCatalogue();
      if (cat) {
        const ps = cat.presets || {};
        presets = dedupePresetNames((ps.exported || []).concat(ps.presets || []));
        registry = cat.registry || { entries: [] };
        source = 'catalogue'; available = !!cat.available;
      }
    }
    sendJson(res, 200, {
      ok: true, source, available,
      gameRunning: !!(live && live.ok),
      presets, registry, assign,
      images: images.map((f) => ({ file: f, url: '/api/face-image-file?f=' + encodeURIComponent(f) })),
    });
    return;
  }

  if (m === 'GET' && p === '/api/face-image-file') {
    const f = String((url.searchParams.get('f') || '')).trim();
    const abs = confine(PRESET_ICONS_DIR, f);
    if (!abs || !fs.existsSync(abs)) { sendErr(res, 404, 'no such image'); return; }
    sendFile(res, abs, path.extname(abs).slice(1).toLowerCase());
    return;
  }

  /* Set (or replace) a preset's image from an uploaded photo, and assign it. */
  if (m === 'POST' && p === '/api/face-image') {
    const body = await readJsonBody(req);
    const preset = typeof body.preset === 'string' ? body.preset.trim() : '';
    if (!preset) { sendErr(res, 400, 'preset name is required'); return; }
    let ext = normExt(body.ext);
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) { sendErr(res, 400, 'That file is not an image the deck can load'); return; }
    ext = sniff;
    // A filesystem-safe stem derived from the preset name (unique-ish; the
    // assign map is the real key, the filename is just storage).
    const stem = 'face-' + preset.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || ('face-' + Date.now());
    ensureDir(PRESET_ICONS_DIR);
    removeStem(PRESET_ICONS_DIR, stem, ICON_EXTS);
    let info;
    try { info = writeImage(PRESET_ICONS_DIR, stem, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    // Assign in assign.json (the deck reads it on Faces-tab open).
    const assign = readPresetAssign();
    assign[preset] = info.file;
    writePresetAssign(assign);
    // Hand the bytes to the running game's VFS so it shows without a relaunch.
    liveSend({ kind: 'import-icon', name: info.file, src: path.join(PRESET_ICONS_DIR, info.file), dir: 'preset-icons' }).catch(() => {});
    log('face image: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB) assigned to preset "' + preset + '"');
    sendJson(res, 200, { ok: true, preset, file: info.file, url: '/api/face-image-file?f=' + encodeURIComponent(info.file) + '&v=' + info.mtime });
    return;
  }

  if (m === 'DELETE' && p === '/api/face-image') {
    const body = await readJsonBody(req);
    const preset = typeof body.preset === 'string' ? body.preset.trim() : '';
    if (!preset) { sendErr(res, 400, 'preset name is required'); return; }
    const assign = readPresetAssign();
    if (assign[preset]) { delete assign[preset]; writePresetAssign(assign); }
    sendJson(res, 200, { ok: true, preset });
    return;
  }

  /* Apply a preset to a ref (a follower's form id, or a hex like FF0043F5, or
     "14" for the player). Needs the running game — relays to PD. */
  if (m === 'POST' && p === '/api/face-apply') {
    const body = await readJsonBody(req);
    const ref = String(body.ref || '').trim();
    const preset = String(body.preset || '').trim();
    if (!ref || !preset) { sendErr(res, 400, "'ref' and 'preset' are required"); return; }
    const flags = Number.isFinite(body.flags) ? body.flags : 3;
    const r = await pdReq('POST', '/apply', { ref, preset, flags });
    if (!r) { sendErr(res, 503, 'Preset Director isn’t answering — is the game running?'); return; }
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  /* Everyone who HAS a profile, plus the speak-style catalog. One round trip,
     used to badge the roster — not N calls for N followers. */
  if (m === 'GET' && p === '/api/sharmat') {
    try {
      const [npcs, styles] = await Promise.all([
        chimCall('loadConfiguredNpcs', {}),
        chimCall('loadGlobalStyles', {}).catch(() => null),   // catalog is a nicety, not a blocker
      ]);
      sendJson(res, 200, {
        ok: true,
        base: chimBase,
        npcs: (npcs && (npcs.npcs || npcs.data)) || [],
        styles: (styles && (styles.styles || styles.data)) || null,
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, chimDown: !!e.chimDown, error: e.message, tried: e.tried || [] });
    }
    return;
  }

  /* One person's full profile. `name` must be the CHIM name — which is the
     roster's `original` (OriginalName || Name), NOT the deck display name:
     renaming someone in the deck must not silently retarget the write. */
  if (m === 'GET' && p === '/api/sharmat/npc') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!name) { sendErr(res, 400, 'name is required'); return; }
    try {
      const r = await loadNpc(name);
      sendJson(res, 200, { ok: true, name, data: r.data, isNew: r.isNew });
    } catch (e) {
      sendJson(res, 200, { ok: false, chimDown: !!e.chimDown, name, error: e.message });
    }
    return;
  }

  /* Body: { name, patch:{ …only what changed… } }
     The patch is merged over a fresh read before posting the FULL field set —
     never post a bare patch at CHIM, it wipes everything you omit. */
  if (m === 'POST' && p === '/api/sharmat/npc') {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { sendErr(res, 400, 'name is required'); return; }
    if (!body.patch || typeof body.patch !== 'object') { sendErr(res, 400, 'patch object is required'); return; }
    try {
      await saveNpc(name, body.patch);
      const fresh = await loadNpc(name);      // answer with the truth, not with the request
      sendJson(res, 200, { ok: true, name, data: fresh.data });
    } catch (e) {
      sendJson(res, 200, { ok: false, chimDown: !!e.chimDown, name, error: e.message });
    }
    return;
  }

  /* ---- finances (recurring lines + market buy/sell items) ---- *
   *  The portal only queues edits to the VIEW-owned lines/market; gold, debt,
   *  the ledger and Settle/Buy/Sell stay in the game. GET folds pending SETs on
   *  so an edit shows before the plugin replays it. NEVER writes hotkeys.json. */
  if (m === 'GET' && p === '/api/finance') {
    sendJson(res, 200, Object.assign({ ok: true }, financeView()));
    return;
  }
  if (m === 'POST' && p === '/api/finance') {
    const body = await readJsonBody(req);
    const op = typeof body.op === 'string' ? body.op : '';
    const target = typeof body.target === 'string' ? body.target : '';
    if (op !== 'set' && op !== 'add' && op !== 'del') { sendErr(res, 400, 'op must be set, add or del'); return; }
    if (target !== 'line' && target !== 'market') { sendErr(res, 400, 'target must be line or market'); return; }
    let rec;
    if (op === 'set') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!id) { sendErr(res, 400, 'id is required for a set'); return; }
      if (!finKeyOk(target, key)) {
        sendErr(res, 400, 'Bad key "' + key + '" for a ' + target + ' — allowed: ' +
          (target === 'line' ? FIN_LINE_KEYS : FIN_MARKET_KEYS).join(', ')); return;
      }
      if (body.value !== undefined && body.value !== null && typeof body.value !== 'string') {
        sendErr(res, 400, 'value must be a string ("" clears it)'); return;
      }
      const value = typeof body.value === 'string' ? body.value.slice(0, FIELD_VALUE_MAX) : '';
      rec = { op, target, id, key, value };
    } else if (op === 'del') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { sendErr(res, 400, 'id is required for a delete'); return; }
      rec = { op, target, id };
    } else { // add — a brand-new line/market row. The phone may mint its own id
      // (so it can immediately edit the row it just added); the plugin mints one
      // only if we don't. amount/price go as NUMBERS (finAddNum) — see its note.
      rec = { op, target };
      const numKey = target === 'line' ? 'amount' : 'price';
      for (const key of (target === 'line' ? FIN_LINE_KEYS : FIN_MARKET_KEYS)) {
        if (body[key] === undefined || body[key] === null) continue;
        if (key === numKey) rec[key] = finAddNum(body[key]);
        else if (typeof body[key] === 'string') rec[key] = body[key].slice(0, FIELD_VALUE_MAX);
      }
      if (typeof body.id === 'string' && body.id.trim()) rec.id = body.id.trim().slice(0, 64);
    }
    let list;
    try { list = mergeFinanceOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('finance ' + op + ' ' + target + (rec.id ? ' #' + rec.id : '') +
      (rec.key ? ' ' + rec.key + '=' + (rec.value || '(clear)') : ''));
    sendJson(res, 200, { ok: true, op, target, pendingFinance: list.length, file: FINANCE_FILE });
    return;
  }

  // A photo for a line/market row. Lands in the shared icon pool (both view
  // trees) and returns "icons/custom/<file>"; the phone then queues that path
  // as a set … key:"icon" op so the deck draws it.
  if (m === 'POST' && p === '/api/finance-image') {
    const body = await readJsonBody(req);
    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff; // trust the bytes over the label
    const base = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : 'finance';
    const name = freeIconName(iconNameFrom(base, 'finance icon'));
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    const icon = ICON_PREFIX + info.file;
    log('finance image: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)');
    sendJson(res, 200, {
      ok: true, icon, name: path.parse(info.file).name, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size,
      url: '/api/icon-file/' + encodeURIComponent(path.parse(info.file).name) + '?v=' + info.mtime,
    });
    return;
  }

  /* ---- inventory (also Claude's read surface: curl it straight) ---- */
  if (m === 'GET' && p === '/api/inventory') {
    const inv = readInventory();
    if (inv.ok) { wdBlFlag(inv.items); wdIconFlag(inv.items); }
    sendJson(res, inv.ok ? 200 : 200, Object.assign({ ok: inv.ok }, inv));
    return;
  }

  /* Exclude / re-allow an item for outfit building ("CORE Carrier problem":
     utility gear that is worn but is not CLOTHES). Portal-owned, instant. */
  if (m === 'POST' && p === '/api/inventory-blacklist') {
    const body = await readJsonBody(req);
    const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
    const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
    if (!formId) { sendErr(res, 400, 'formId is required'); return; }
    const on = body.on === true || body.on === '1' || body.on === 'true';
    let items = readWdBlacklist().filter((x) => wdBlKey(x.formId, x.plugin) !== wdBlKey(formId, plugin));
    if (on) items.push({ formId, plugin,
      name: typeof body.name === 'string' ? body.name.slice(0, FIELD_VALUE_MAX) : '' });
    if (items.length > 400) items = items.slice(-400);
    try { writeWdBlacklist(items); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('outfit blacklist ' + (on ? '+ ' : '- ') + (body.name || formId));
    sendJson(res, 200, { ok: true, on, total: items.length });
    return;
  }

  /* What the player is wearing right now — the fastest way to bottle a look.
     The plugin writes it beside the inventory export on every Wardrobe tab open;
     with the game closed this is simply the last one it wrote. Read-only. */
  if (m === 'GET' && p === '/api/worn') {
    const inv = readInventory();
    let worn = null;
    for (const file of INVENTORY_CANDIDATES) {
      const wf = file.replace(/wardrobe-inventory\.json$|inventory\.json$/, 'wardrobe-worn.json');
      if (wf === file) continue;
      try {
        const j = JSON.parse(fs.readFileSync(wf, 'utf8').replace(/^\ufeff/, ''));
        if (j && Array.isArray(j.items)) { worn = { file: wf, who: j.who || 'You', items: j.items }; break; }
      } catch (_) { /* not there yet */ }
    }
    if (!worn) {
      sendJson(res, 200, { ok: false, items: [],
        error: 'No worn-armour export yet — open the deck\'s Wardrobe tab in game once.' });
      return;
    }
    wdBlFlag(worn.items);   // so "copy what I'm wearing" can skip excluded gear
    sendJson(res, 200, { ok: true, who: worn.who, total: worn.items.length, items: worn.items,
      file: worn.file, inventoryTotal: inv.ok ? inv.total : 0 });
    return;
  }

  /* Build a real SOES outfit out of inventory pieces. This is the endpoint that
     lets an outfit be created WITHOUT touching the game's menus — from the phone
     or from Claude. It only queues; the plugin resolves each armour form and
     drives SOES through the Papyrus executor on the next Wardrobe tab open.
       POST /api/outfit  { name, items:[{formId, plugin, name?}, ...] }
     formId may be hex ("0x261C1") or the decimal the inventory export uses. */
  if (m === 'POST' && p === '/api/outfit') {
    const body = await readJsonBody(req);
    let build;
    try { build = wdBuildRequest(body); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    // Fill in missing names from the live inventory so the queued op is readable
    // in the log and in the phone's pending list.
    const inv = readInventory();
    if (inv.ok) {
      const byKey = Object.create(null);
      inv.items.forEach((i) => { byKey[i.formId.toUpperCase() + '|' + i.plugin.toLowerCase()] = i.name; });
      build.items.forEach((i) => {
        if (!i.name) i.name = byKey[i.formId.toUpperCase() + '|' + i.plugin.toLowerCase()] || '';
      });
    }
    let list;
    try { list = mergeWardrobeOp({ op: 'outfit-new', name: build.name, items: build.items }); }
    catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('outfit build queued: "' + build.name + '" (' + build.items.length + ' pieces)');
    sendJson(res, 200, {
      ok: true, name: build.name, pieces: build.items.length, items: build.items,
      pendingWardrobe: list.length, file: WARDROBE_FILE,
      note: 'Queued. It becomes a real SOES outfit the next time the deck\'s Wardrobe tab opens in game.',
    });
    return;
  }

  if (m === 'POST' && p === '/api/outfit-delete') {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, WD_OUTFIT_NAME_MAX) : '';
    if (!name) { sendErr(res, 400, 'name is required'); return; }
    let list;
    try { list = mergeWardrobeOp({ op: 'outfit-del', name: name }); }
    catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('outfit delete queued: "' + name + '"');
    sendJson(res, 200, { ok: true, name, pendingWardrobe: list.length });
    return;
  }

  /* ---- wardrobe ---- */
  if (m === 'GET' && p === '/api/wardrobe') {
    sendJson(res, 200, Object.assign({ ok: true }, wardrobeView()));
    return;
  }
  if (m === 'POST' && p === '/api/wardrobe') {
    const body = await readJsonBody(req);
    const op = typeof body.op === 'string' ? body.op : '';
    const WD_OPS = ['set', 'pool', 'image', 'pool-new', 'pool-del', 'pool-set', 'pool-order', 'pools-order',
      'loc-set', 'cat-new', 'cat-del', 'cat-set', 'outfit-cats'];
    if (!WD_OPS.includes(op)) {
      sendErr(res, 400, 'op must be one of: ' + WD_OPS.join(', ')); return;
    }
    let rec;
    if (op === 'loc-set') {
      const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
      const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
      if (!formId) { sendErr(res, 400, 'formId is required'); return; }
      const loc = Number(body.loc);
      if (!isFinite(loc) || loc < 0 || loc > WD_LOC_MAX) {
        sendErr(res, 400, 'loc must be a SOES location-type id (0–' + WD_LOC_MAX + ')'); return;
      }
      rec = { op, formId, plugin, loc: Math.round(loc),
        wardrobeId: typeof body.wardrobeId === 'string' ? body.wardrobeId.trim().slice(0, FIELD_VALUE_MAX) : '',
        outfit: typeof body.outfit === 'string' ? body.outfit.trim().slice(0, FIELD_VALUE_MAX) : '' };
      if (rec.wardrobeId && rec.outfit) {
        sendErr(res, 400, 'Pass wardrobeId OR outfit, not both — one target per place'); return;
      }
    } else if (op === 'cat-new') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, WD_POOL_NAME_MAX) : '';
      if (!name) { sendErr(res, 400, 'name is required'); return; }
      const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim().slice(0, 40)
        : 'c' + wdNewId().slice(1);
      rec = { op, id, name };
      rec.hue = (typeof body.hue === 'number' && isFinite(body.hue))
        ? Math.max(0, Math.min(359, Math.round(body.hue)))
        : WD_HUES[(readWardrobeSlice().categories.length) % WD_HUES.length];
    } else if (op === 'cat-del') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the category) is required'); return; }
      rec = { op, id };
    } else if (op === 'cat-set') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the category) is required'); return; }
      if (!['name', 'hue'].includes(key)) { sendErr(res, 400, 'key must be name or hue'); return; }
      let value = typeof body.value === 'string' ? body.value : String(body.value == null ? '' : body.value);
      if (key === 'name') {
        value = value.trim().slice(0, WD_POOL_NAME_MAX);
        if (!value) { sendErr(res, 400, 'A category needs a name'); return; }
      } else {
        const n = parseInt(value, 10);
        if (!isFinite(n) || n < 0 || n > 359) { sendErr(res, 400, 'hue must be 0–359'); return; }
        value = String(n);
      }
      rec = { op, id, key, value };
    } else if (op === 'outfit-cats') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, WD_OUTFIT_NAME_MAX) : '';
      if (!name) { sendErr(res, 400, 'name (the outfit) is required'); return; }
      if (!Array.isArray(body.categoryIds)) { sendErr(res, 400, 'categoryIds must be an array (the whole tag list)'); return; }
      rec = { op, name,
        categoryIds: body.categoryIds.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().slice(0, 40)).slice(0, 50) };
    } else if (op === 'pool-new') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, WD_POOL_NAME_MAX) : '';
      if (!name) { sendErr(res, 400, 'name is required'); return; }
      const id = (typeof body.id === 'string' && body.id.trim()) ? body.id.trim().slice(0, 40) : wdNewId();
      rec = { op, id, name };
      rec.hue = (typeof body.hue === 'number' && isFinite(body.hue))
        ? Math.max(0, Math.min(359, Math.round(body.hue)))
        : WD_HUES[(readWardrobeSlice().wardrobes.length) % WD_HUES.length];
      if (WD_POOL_MODES.includes(body.mode)) rec.mode = body.mode;
      if (Array.isArray(body.outfits)) {
        rec.outfits = body.outfits.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim().slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX);
      }
    } else if (op === 'pool-del') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the wardrobe) is required'); return; }
      rec = { op, id };
    } else if (op === 'pool-set') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the wardrobe) is required'); return; }
      if (!WD_POOL_KEYS.includes(key)) {
        sendErr(res, 400, 'Bad key "' + key + '" for a wardrobe — allowed: ' + WD_POOL_KEYS.join(', ')); return;
      }
      let value = typeof body.value === 'string' ? body.value : String(body.value == null ? '' : body.value);
      if (key === 'name') {
        value = value.trim().slice(0, WD_POOL_NAME_MAX);
        if (!value) { sendErr(res, 400, 'A wardrobe needs a name'); return; }
      } else if (key === 'mode') {
        if (!WD_POOL_MODES.includes(value)) { sendErr(res, 400, 'mode must be bag or random'); return; }
      } else if (key === 'hue') {
        const n = parseInt(value, 10);
        if (!isFinite(n) || n < 0 || n > 359) { sendErr(res, 400, 'hue must be 0–359'); return; }
        value = String(n);
      } else value = value.slice(0, FIELD_VALUE_MAX);
      rec = { op, id, key, value };
    } else if (op === 'pool-order') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the wardrobe) is required'); return; }
      if (!Array.isArray(body.outfits)) { sendErr(res, 400, 'outfits must be an array of outfit names'); return; }
      rec = { op, id,
        outfits: body.outfits.filter((x) => typeof x === 'string' && x)
          .map((x) => x.slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX) };
    } else if (op === 'pools-order') {
      if (!Array.isArray(body.ids) || !body.ids.length) { sendErr(res, 400, 'ids must be an array of wardrobe ids'); return; }
      rec = { op,
        ids: body.ids.filter((x) => typeof x === 'string' && x)
          .map((x) => x.slice(0, FIELD_VALUE_MAX)).slice(0, WD_POOL_OUTFITS_MAX) };
    } else if (op === 'set') {
      const target = typeof body.target === 'string' ? body.target : '';
      if (target !== 'outfit' && target !== 'assign') { sendErr(res, 400, 'target must be outfit or assign'); return; }
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!wdKeyOk(target, key)) {
        sendErr(res, 400, 'Bad key "' + key + '" for ' + target + ' — allowed: ' +
          (target === 'outfit' ? WD_OUTFIT_KEYS : WD_ASSIGN_KEYS).join(', ')); return;
      }
      if (target === 'outfit') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) { sendErr(res, 400, 'name is required for an outfit set'); return; }
        const value = key === 'fav'
          ? (body.value === true || body.value === '1' || body.value === 'true' ? '1' : '0')
          : (typeof body.value === 'string' ? body.value.slice(0, FIELD_VALUE_MAX) : '');
        rec = { op, target, name, key, value };
      } else {
        const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
        const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
        if (!formId) { sendErr(res, 400, 'formId is required for an assign set'); return; }
        const value = wdAssignValue(key, body.value);
        if (value === null) {
          sendErr(res, 400, key === 'mode'
            ? 'mode must be one of: ' + WD_MODES.join(', ')
            : 'cadenceHours must be a number of hours (0–' + WD_CADENCE_MAX + ')'); return;
        }
        rec = { op, target, formId, plugin, key, value };
      }
    } else if (op === 'pool') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) { sendErr(res, 400, 'id (the wardrobe) is required'); return; }
      const add = typeof body.add === 'string' ? body.add.trim() : '';
      const remove = typeof body.remove === 'string' ? body.remove.trim() : '';
      if (!add && !remove) { sendErr(res, 400, 'pass add or remove (an outfit name)'); return; }
      rec = { op, id };
      if (add) rec.add = add.slice(0, FIELD_VALUE_MAX);
      if (remove) rec.remove = remove.slice(0, FIELD_VALUE_MAX);
    } else {  // image — queue an already-uploaded pool icon onto an outfit
      const outfit = typeof body.outfit === 'string' ? body.outfit.trim() : '';
      if (!outfit) { sendErr(res, 400, 'outfit is required'); return; }
      rec = { op, outfit, value: typeof body.value === 'string' ? body.value.slice(0, FIELD_VALUE_MAX) : '' };
    }
    let list;
    try { list = mergeWardrobeOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('wardrobe ' + op + ' ' + (rec.target || '') + ' ' + (rec.name || rec.outfit || rec.formId || rec.id || '') +
      (rec.key ? ' ' + rec.key + '=' + (rec.value || '(clear)') : '') +
      (rec.add ? ' +' + rec.add : '') + (rec.remove ? ' -' + rec.remove : ''));
    const reply = { ok: true, op, pendingWardrobe: list.length, file: WARDROBE_FILE };
    if (rec.id) reply.id = rec.id;   // pool-new callers need the minted id
    sendJson(res, 200, reply);
    return;
  }

  /* Wear an outfit on the PLAYER, live. No queue on purpose — a "wear" that
     replays hours later mid-fight is a jump-scare, so with the game closed
     this simply says no. */
  if (m === 'POST' && p === '/api/wear') {
    const body = await readJsonBody(req);
    const outfit = typeof body.outfit === 'string' ? body.outfit.trim().slice(0, WD_OUTFIT_NAME_MAX) : '';
    if (!outfit) { sendErr(res, 400, 'outfit is required'); return; }
    const r = await liveSend({ kind: 'wear-outfit', outfit });
    if (r && r.ok) {
      liveLastOk = Date.now();
      log('live: wear-outfit "' + outfit + '"');
      sendJson(res, 200, { ok: true, live: true, outfit });
    } else {
      sendJson(res, 200, { ok: false, live: false,
        error: 'Wearing needs the game running — start Skyrim and try again.' });
    }
    return;
  }

  /* Poke the running game to re-export the player's armour + worn list NOW —
     the "hook to my live inventory" half of the wardrobe page. With the game
     closed this answers live:false and the last export stands. The client
     re-fetches /api/inventory after a beat; the export itself is async. */
  if (m === 'POST' && p === '/api/inventory-refresh') {
    const r = await liveSend({ kind: 'inventory-refresh' });
    if (r && r.ok) {
      liveLastOk = Date.now();
      log('live: inventory-refresh -> ' + (r.msg || 'queued'));
      sendJson(res, 200, { ok: true, live: true, msg: r.msg || 'exporting' });
    } else {
      sendJson(res, 200, { ok: false, live: false,
        error: 'Game not running (or live pipe down) — showing the last export.' });
    }
    return;
  }

  // A photo of an outfit. Lands in the shared icon pool (both view trees, the
  // folder the plugin re-scans on every open) and returns "icons/custom/<file>";
  // the phone then queues that path as an image op so the deck draws it.
  if (m === 'POST' && p === '/api/wardrobe-image') {
    const body = await readJsonBody(req);
    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;   // trust the bytes over the label
    const outfit = typeof body.outfit === 'string' ? body.outfit.trim() : '';
    const base = outfit || 'outfit';
    const name = freeIconName(iconNameFrom(base, 'outfit photo'));
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    const icon = ICON_PREFIX + info.file;
    // One call does both when an outfit is named: upload AND queue it, so the
    // phone can't end up with an orphan image nobody references.
    let queued = 0;
    if (outfit) {
      try { queued = mergeWardrobeOp({ op: 'image', outfit, value: icon }).length; }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    }
    log('wardrobe image: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)' +
      (outfit ? ' -> ' + outfit : ' (unassigned)'));
    /* (The live hand-off to the running game now lives in writePoolIcon, so
       every uploader gets it — this endpoint used to be the only one that
       did.) */
    sendJson(res, 200, {
      ok: true, icon, outfit: outfit || null, queued: !!outfit, pendingWardrobe: queued,
      name: path.parse(info.file).name, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size,
      url: '/api/icon-file/' + encodeURIComponent(path.parse(info.file).name) + '?v=' + info.mtime,
    });
    return;
  }

  /* ---- My Home is Your Home NG: her day ---- */
  if (m === 'GET' && p === '/api/mhiyh') {
    sendJson(res, 200, Object.assign({ ok: true }, mhiyhView()));
    return;
  }

  /* Queue ONE day change. Every gate MHiYH itself enforces is reproduced here
     (from src/mhiyh_control.h, which reproduces them from MHiYHController.psc),
     so the phone refuses in a sentence instead of queueing something the game
     will silently turn down two layers down:

       setHome     needs her FOLLOWING when she has no home yet (MarkHome's own
                   first gate); with a home it is a MoveHome and needs nothing
       forgetHome  needs a home, and needs confirm:true — it wipes every stop
                   and unregisters her from the mod entirely
       setSpot     kind 1..6, and needs the home to exist first
       clearSpot   kind 1..6, and needs that stop to exist

     …plus the one gate that is OURS, not the mod's: a POSITIONAL op (setHome /
     setSpot) marks the player's feet WHEN THE GAME APPLIES IT. Queueing one
     against a game that isn't running would mark wherever the player happens to be
     standing whenever he next opens the Followers tab. So we ping the live pipe
     first and refuse if it does not answer. */
  if (m === 'POST' && p === '/api/mhiyh') {
    const body = await readJsonBody(req);
    const op = typeof body.op === 'string' ? body.op : '';
    if (!MHIYH_OPS.includes(op)) {
      sendErr(res, 400, 'op must be one of: ' + MHIYH_OPS.join(', ')); return;
    }
    const original = typeof body.original === 'string' ? body.original.trim() : '';
    if (!original) { sendErr(res, 400, 'original (the follower\'s original name) is required'); return; }

    const view = mhiyhView();
    if (!view.statusOk) {
      sendErr(res, 409, 'The deck has never exported a day for this game — open the Followers tab in ' +
        'game once (F14) and the phone can see it from then on.'); return;
    }
    if (!view.installed) {
      sendErr(res, 409, 'My Home is Your Home NG is not in this load order.'); return;
    }
    const row = view.npcs.find((n) => n.original.toLowerCase() === original.toLowerCase());
    if (!row) { sendErr(res, 404, '"' + original + '" is not in the deck\'s roster.'); return; }

    const spot = op === 'setSpot' || op === 'clearSpot';
    const kind = Number(body.kind);
    if (spot && !mhiyhKindOk(kind)) {
      // Say WHICH rule was hit — 0 and 7 are the two a person actually tries.
      const why = kind === 0 ? 'The home is set with its own action, not as a stop.'
        : kind === 7 ? 'Watch has no place of its own — it shares the guard post. Set Guard instead.'
          : 'kind must be one of: ' + MHIYH_SETTABLE.join(', ');
      sendErr(res, 400, why); return;
    }
    if (op === 'setHome' && !row.home && !row.following) {
      sendErr(res, 409, row.name + ' has to be following you before My Home is Your Home will take a ' +
        'home from you — that is the mod\'s own rule, not the deck\'s.'); return;
    }
    if (op === 'forgetHome') {
      if (!row.home) { sendErr(res, 409, row.name + ' has no home to forget.'); return; }
      if (body.confirm !== true) {
        sendErr(res, 400, 'forgetHome wipes every stop and takes her out of the mod — send confirm:true.'); return;
      }
    }
    if (op === 'setSpot' && !row.home) {
      sendErr(res, 409, 'Give ' + row.name + ' a home first — every other stop in her day hangs off it.'); return;
    }
    if (op === 'clearSpot') {
      const has = row.acts.some((a) => a.k === kind && a.place);
      if (!has) { sendErr(res, 409, 'She has no ' + mhiyhKindLabel(kind).toLowerCase() + ' spot to clear.'); return; }
    }

    const positional = MHIYH_POSITIONAL.includes(op);
    if (positional) {
      const ping = await liveSend({ kind: 'ping' });
      if (!ping || !ping.ok) {
        sendErr(res, 409, 'Skyrim is not answering, and this marks the spot you are STANDING ON when it ' +
          'lands. Queued now it would drop her ' +
          (op === 'setHome' ? 'home' : mhiyhKindLabel(kind).toLowerCase() + ' spot') +
          ' wherever you happen to be later — so it is not queued. Start the game and try again.');
        return;
      }
      liveLastOk = Date.now();
    }

    const rec = {
      op, original,
      formId: typeof body.formId === 'string' ? body.formId.trim() : row.formId,
      name: row.name.slice(0, 120),
      at: Date.now(),
    };
    if (spot) rec.kind = kind;

    let list;
    try { list = mergeMhiyhOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('mhiyh ' + op + ' ' + original + (spot ? ' (' + mhiyhKindLabel(kind) + ')' : ''));
    sendJson(res, 200, {
      ok: true, op, kind: spot ? kind : undefined,
      positional, ttlMs: positional ? MHIYH_TTL_MS : undefined,
      pendingMhiyh: list.length, file: MHIYH_FILE,
    });
    return;
  }

  /* The undo: drop what is queued for one person (or one stop of hers) before
     the game eats it. Same idiom as /api/hotkey-revert, and the only way to
     take back a positional op you fired from the wrong room. */
  if (m === 'POST' && p === '/api/mhiyh-revert') {
    const body = await readJsonBody(req);
    const original = typeof body.original === 'string' ? body.original.trim() : '';
    if (!original) { sendErr(res, 400, 'original is required'); return; }
    const kind = (body.kind === undefined || body.kind === null || body.kind === '')
      ? undefined : Number(body.kind);
    if (kind !== undefined && !mhiyhKindOk(kind)) { sendErr(res, 400, 'kind must be one of: ' + MHIYH_SETTABLE.join(', ')); return; }
    let r;
    try { r = dropMhiyhOps(original, kind); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('mhiyh revert ' + original + (kind === undefined ? '' : ' (' + mhiyhKindLabel(kind) + ')') +
      ' — dropped ' + r.dropped);
    sendJson(res, 200, { ok: true, dropped: r.dropped, pendingMhiyh: r.list.length, file: MHIYH_FILE });
    return;
  }

  /* ---- NFF outfits (the second dressing backend) ---- */
  if (m === 'GET' && p === '/api/nff') {
    sendJson(res, 200, Object.assign({ ok: true }, nffView()));
    return;
  }
  // METADATA ONLY, on purpose. Wear / fill / clear are NOT here: only the game
  // can see whether SOES is tracking her too, and dressing someone both systems
  // hold is precisely the thrash this feature exists to prevent. See
  // src/nff_outfits.h, "ONE ACTOR, ONE BACKEND".
  if (m === 'POST' && p === '/api/nff') {
    const body = await readJsonBody(req);
    const op = typeof body.op === 'string' ? body.op : '';
    if (op !== 'set' && op !== 'note') { sendErr(res, 400, 'op must be set or note'); return; }
    const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
    if (!formId) { sendErr(res, 400, 'formId is required'); return; }
    const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';

    let rec;
    if (op === 'set') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!NFF_SET_KEYS.includes(key)) {
        sendErr(res, 400, 'Bad key "' + key + '" — allowed: ' + NFF_SET_KEYS.join(', ')); return;
      }
      const type = Number(body.type);
      if (!nffTypeOk(type)) {
        sendErr(res, 400, 'type must be 0 (Adventure), 1 (Town) or 2 (Home)'); return;
      }
      const cap = key === 'label' ? NFF_LABEL_MAX : FIELD_VALUE_MAX;
      // An icon must be a pool path, a library path, or empty — the same
      // contract the deck view and main.cpp enforce, checked here so a bad path
      // never reaches the game. These rows live in the DECK view.
      let value = typeof body.value === 'string' ? body.value.slice(0, cap) : '';
      if (key === 'icon' && value) {
        const chk = checkAssignIcon(value, 'hotkey');
        if (!chk.ok) { sendErr(res, 400, chk.error); return; }
        value = chk.icon;
      }
      rec = { op, formId, plugin, type, key, value };
    } else {
      rec = { op, formId, plugin, value: typeof body.value === 'string' ? body.value.slice(0, FIELD_VALUE_MAX) : '' };
    }
    if (name) rec.name = name;

    let list;
    try { list = mergeNffOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('nff ' + op + ' ' + formId + (rec.key ? ' ' + NFF_TYPE_NAME[rec.type] + '.' + rec.key : '') +
      ' = ' + (rec.value || '(clear)'));
    sendJson(res, 200, { ok: true, op, pendingNff: list.length, file: NFF_FILE });
    return;
  }

  // A photo for one of a follower's three NFF outfits. Lands in the SHARED icon
  // pool (both view trees, the folder the plugin re-scans on every open) exactly
  // like a spell or hotkey icon — one pool, not a fourth one — and is queued onto
  // that outfit in the same call, so the phone cannot leave an orphan image.
  if (m === 'POST' && p === '/api/nff-image') {
    const body = await readJsonBody(req);
    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;   // trust the bytes over the label

    const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
    const plugin = typeof body.plugin === 'string' ? body.plugin.trim() : '';
    const type = Number(body.type);
    const who = typeof body.name === 'string' ? body.name.trim() : '';
    if (formId && !nffTypeOk(type)) {
      sendErr(res, 400, 'type must be 0 (Adventure), 1 (Town) or 2 (Home)'); return;
    }
    const base = (who || 'outfit') + (formId ? '-' + NFF_TYPE_NAME[type] : '');
    const iconName = freeIconName(iconNameFrom(base, 'nff outfit photo'));
    let info;
    try { info = writePoolIcon(iconName, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    const icon = ICON_PREFIX + info.file;

    let queued = 0;
    if (formId) {
      const rec = { op: 'set', formId, plugin, type, key: 'icon', value: icon };
      if (who) rec.name = who.slice(0, 120);
      try { queued = mergeNffOp(rec).length; }
      catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    }
    log('nff image: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)' +
      (formId ? ' -> ' + (who || formId) + ' ' + NFF_TYPE_NAME[type] : ' (unassigned)'));
    sendJson(res, 200, {
      ok: true, icon, queued: !!formId, pendingNff: queued,
      name: path.parse(info.file).name, requested: iconName, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size,
      url: '/api/icon-file/' + encodeURIComponent(path.parse(info.file).name) + '?v=' + info.mtime,
    });
    return;
  }



  /* ---- CHIM core profile ---- */
  if (m === 'GET' && p === '/api/chim') {
    const name = url.searchParams.get('name') || '';
    const r = await chimProfile(name);
    sendJson(res, 200, r.ok ? { ok: true, found: !!r.found, profile: r.profile, fields: CHIM_FIELDS }
                            : { ok: false, error: r.error });
    return;
  }


  if (m === 'POST' && p === '/api/chim-set') {
    const body = await readJsonBody(req);
    const r = await chimSetField(String(body.name || ''), String(body.field || ''), body.value);
    if (!r.ok) { sendErr(res, 400, r.error); return; }
    log('CHIM: ' + body.field + ' updated for "' + body.name + '" (profile locked)');
    const fresh = await chimProfile(String(body.name || ''));
    sendJson(res, 200, { ok: true, locked: true, profile: fresh.profile || null });
    return;
  }

  /* Ask CHIM to (re)generate a profile with its own AI. Unlocks first, because a
   * locked row is precisely the thing that stops CHIM writing — leaving it
   * locked would make the button do nothing and look broken. */
  if (m === 'POST' && p === '/api/chim-generate') {
    const body = await readJsonBody(req);
    const nm = String(body.name || '');
    // npc.php owns the connection and the escaping; `lock --off` is its own
    // verb for exactly this.
    const unlock = await new Promise((res) => npcTool(['lock', String(nm), '--off'], null, res));
    // npc.php EXITS NON-ZERO when nobody matches, so `ok` is the whole answer.
    // This used to grep the output for a line reading "1" — psql's `returning
    // 1` — which npc.php does not print, so keeping that test would have
    // turned every successful unlock into a 404.
    if (!unlock.ok) {
      const missing = /no NPC matches/i.test(unlock.error || '');
      sendErr(res, missing ? 404 : 502, missing ? 'No CHIM row for "' + nm + '"' : unlock.error);
      return;
    }
    // chimCall() is hardwired to the aiagent_nsfw config_manager path, so this
    // walks the same candidate bases itself and pins the winner the same way.
    const bases = chimBase ? [chimBase].concat(CHIM_CANDIDATES.filter((b) => b !== chimBase)) : CHIM_CANDIDATES.slice();
    let done = null, lastErr = 'no candidate answered';
    for (const base of bases) {
      try {
        const rr = await chimRequest(base + '/HerikaServer/ui/cmd/action_ai_regen_profile.php?name=' + encodeURIComponent(nm));
        if (rr && rr.ok) { chimBase = base; done = rr; break; }
        lastErr = 'HTTP ' + (rr && rr.status);
      } catch (e) { lastErr = e.message || String(e); }
    }
    if (!done) { sendErr(res, 503, 'CHIM is not answering (' + lastErr + ') — it only runs while the game is up.'); return; }
    log('CHIM: AI profile regeneration requested for "' + nm + '"');
    sendJson(res, 200, { ok: true, unlocked: true, reply: String(done.body || done.text || '').slice(0, 400) });
    return;
  }

  /* ---- Ask (deck_ask relay) --------------------------------------------
   *  The phone's Ask tab. Same endpoint the in-game overlay uses
   *  (ext/deck_ask/ask.php), reached through the same base-walk the other
   *  CHIM calls do — so questions, rosters, the chronicle, and ⚡ Direct all
   *  work from the couch, game running or not (CHIM only needs the WSL box).
   *  GET passthrough of q / npc / mode, JSON straight back. */
  if (m === 'GET' && p === '/api/ask') {
    const pass = new URLSearchParams();
    for (const k of ['q', 'npc', 'mode']) {
      const v = url.searchParams.get(k);
      if (v) pass.set(k, v);
    }
    if (!pass.get('q')) { sendErr(res, 400, 'q required'); return; }
    const bases = chimBase
      ? [chimBase].concat(CHIM_CANDIDATES.filter((b) => b !== chimBase))
      : CHIM_CANDIDATES.slice();
    let done = null, lastErr = 'no candidate answered';
    for (const base of bases) {
      try {
        const rr = await chimRequest(base + '/HerikaServer/ext/deck_ask/ask.php?' + pass.toString());
        if (rr && rr.ok && rr.json) { chimBase = base; done = rr; break; }
        lastErr = rr && !rr.json ? 'non-JSON reply' : 'HTTP ' + (rr && rr.status);
      } catch (e) { lastErr = e.message || String(e); }
    }
    if (!done) { sendErr(res, 503, 'CHIM is not answering (' + lastErr + ')'); return; }
    sendJson(res, 200, done.json);
    return;
  }

  /* ---- capture framing defaults ---- */
  if (m === 'GET' && p === '/api/portrait-defaults') {
    sendJson(res, 200, { ok: true, ...readCaptureIni() });
    return;
  }

  if (m === 'POST' && p === '/api/portrait-defaults') {
    const body = await readJsonBody(req);
    const want = {
      zoom: Number(body.zoom),
      offsetX: Number(body.offsetX),
      offsetY: Number(body.offsetY),
    };
    if (!isFinite(want.zoom) || !isFinite(want.offsetX) || !isFinite(want.offsetY)) {
      sendErr(res, 400, 'zoom, offsetX and offsetY must all be numbers');
      return;
    }
    const before = readCaptureIni();
    let saved;
    try { saved = writeCaptureIni(want); }
    catch (e) { sendErr(res, 500, 'Could not write ' + captureIniPath() + ': ' + e.message); return; }
    log('capture framing default: zoom ' + before.zoom.toFixed(3) + ' -> ' + saved.zoom.toFixed(3) +
        ', offset ' + before.offsetX.toFixed(3) + ',' + before.offsetY.toFixed(3) +
        ' -> ' + saved.offsetX.toFixed(3) + ',' + saved.offsetY.toFixed(3) + '  (' + saved.file + ')');
    sendJson(res, 200, { ok: true, ...saved, existedBefore: before.exists });
    return;
  }

  /* ---- portraits ---- */
  if (m === 'GET' && p === '/api/portraits') {
    const list = listPortraits()
      .map((r) => ({ slug: r.slug, file: r.file, ext: r.ext, mtime: r.mtime, size: r.size, superseded: r.extras.length }));
    sendJson(res, 200, { ok: true, dir: PORTRAIT_DIR, dirs: PORTRAIT_READ_DIRS, portraits: list });
    return;
  }

  if (m === 'POST' && p === '/api/portrait') {
    const body = await readJsonBody(req);
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    if (!validSlug(slug)) { sendErr(res, 400, 'Bad slug — lowercase a–z, 0–9 and single hyphens only (got "' + String(body.slug).slice(0, 60) + '")'); return; }
    let ext = normExt(body.ext);
    if (!PORTRAIT_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + PORTRAIT_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !PORTRAIT_EXTS.includes(sniff === 'jpg' ? 'jpg' : sniff)) {
      sendErr(res, 400, 'That file is not a PNG/JPEG/WebP image (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff; // trust the bytes over the label
    // Clear BOTH authors, every version. MO2 gives overwrite priority and the
    // newest file wins within a slug, so an in-game capture left sitting there
    // would shadow this upload — "replace the portrait from my phone" has to
    // actually replace it. Anything the running game holds open survives this;
    // that is what the versioned name below is for.
    const cleared = removeSlug(slug);
    if (cleared) log('portrait: cleared ' + cleared + ' existing file(s) for "' + slug + '"');

    /* Anything still standing is held open by the running game. That matters
     * beyond the write: a survivor in OVERWRITE shadows a mod-folder file of the
     * same name outright (MO2's rule), so landing this upload as `<slug>.<ext>`
     * would put it somewhere the deck can never see — the upload would look like
     * it worked and change nothing. Writing a version instead gives it a name
     * the survivor cannot shadow, and being newer is what makes it win. */
    const survivors = listPortraitFiles().filter((r) => r.slug === slug);
    const stamp = Math.floor(Date.now() / 1000);
    const versionName = (n) => slug + '~' + (stamp + n);
    let info;
    try {
      info = survivors.length
        ? writeImage(PORTRAIT_DIR, versionName(0), ext, buf, (n) => versionName(n + 1))
        : writeImage(PORTRAIT_DIR, slug, ext, buf, versionName);
    } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    if (survivors.length) {
      log('portrait: ' + survivors.length + ' file(s) for "' + slug + '" are open in the running game — saved as "' +
        info.file + '", which supersedes them');
    }

    /* Hand the same bytes to the plugin so a RUNNING game picks them up within
       a second, instead of at the next launch. */
    // buf is the DECODED image in this scope; the request's base64 field is not
    // in scope here. Re-encode from the bytes we actually wrote, so the plugin
    // is guaranteed to receive exactly what landed on disk.
    if (queuePortraitForPlugin(slug, info.ext || ext, buf.toString('base64'))) {
      log('portrait bridge: queued "' + slug + '" for the plugin (live if the game is up)');
    }
    log('portrait saved: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)');
    sendJson(res, 200, { ok: true, slug, ext: info.ext, mtime: info.mtime, size: info.size, url: '/api/portrait-file/' + slug + '?v=' + info.mtime });
    return;
  }

  if (m === 'DELETE' && p.startsWith('/api/portrait/')) {
    const slug = decodeURIComponent(p.slice('/api/portrait/'.length)).toLowerCase();
    if (!validSlug(slug)) { sendErr(res, 400, 'Bad slug'); return; }
    // Both authors and every version, or a "deleted" portrait comes straight
    // back from the other folder or from a superseded file.
    const had = !!findPortrait(slug);
    if (!had) { sendErr(res, 404, 'No portrait for "' + slug + '"'); return; }
    const n = removeSlug(slug);
    // A file the running game holds open cannot be deleted, and it is still a
    // portrait — so it comes straight back. Say so instead of reporting a
    // success the phone would then contradict on its next refresh.
    if (findPortrait(slug)) {
      sendErr(res, 423, 'That portrait is open in the running game and cannot be deleted' +
        (n ? ' (' + n + ' other file(s) for it were removed)' : '') + ' — close Skyrim and retry.');
      return;
    }
    log('portrait deleted: ' + slug);
    sendJson(res, 200, { ok: true, slug, removed: n });
    return;
  }

  if (m === 'GET' && p.startsWith('/api/portrait-file/')) {
    const slug = decodeURIComponent(p.slice('/api/portrait-file/'.length)).toLowerCase();
    if (!validSlug(slug)) { sendErr(res, 400, 'Bad slug'); return; }
    const r = findPortrait(slug);
    if (!r) { sendErr(res, 404, 'No portrait for "' + slug + '"'); return; }
    const abs = confine(r.dir, r.file);
    if (!abs) { sendErr(res, 400, 'Refusing to serve outside the portraits folder'); return; }
    sendFile(res, abs, r.ext);
    return;
  }

  /* ---- the custom icon pool (shared by spells AND hotkeys) ---- */
  /* ---- the Spell Hotbar library, browsable from the phone ----
     1,913 PNGs is far too many to hand a phone in one payload, and far too many
     to scroll blind, so the search and the paging both happen HERE: the client
     sends q/offset/limit and gets back only what it is about to paint, plus the
     honest total so it can say "43 of 1,913". The index is parsed once and
     re-read only when sh_index.json's mtime changes (a re-extract), so a scroll
     costs a filter over an array already in memory, not a 450 KB JSON parse. */
  if (m === 'GET' && p === '/api/sh-icons') {
    const view = viewName(url.searchParams.get('view'));
    const lib = shLibrary(view);
    if (!lib.ok) { sendJson(res, 200, { ok: false, error: lib.error, view, total: 0, matched: 0, icons: [] }); return; }
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean).slice(0, 6) : [];
    // `pack` is the BROWSE half: pick a source atlas (Odin, Apocalypse, vanilla…)
    // and page through it without typing anything. Composes with the search.
    const pack = String(url.searchParams.get('pack') || '').trim();
    let hits = lib.items;
    if (pack) hits = hits.filter((it) => it.atlas === pack);
    if (terms.length) hits = hits.filter((it) => terms.every((t) => it.hay.includes(t)));
    const limit = Math.max(1, Math.min(240, Number(url.searchParams.get('limit')) || 60));
    const offset = Math.max(0, Math.min(hits.length, Number(url.searchParams.get('offset')) || 0));
    const page = hits.slice(offset, offset + limit).map((it) => ({
      path: it.path, label: it.label, atlas: it.atlas, kind: it.kind,
      url: '/api/view-icon?p=' + encodeURIComponent(it.path) + (view === 'magic' ? '' : '&view=' + view) + '&v=' + lib.stamp,
    }));
    sendJson(res, 200, {
      ok: true, view, q, pack, total: lib.items.length, matched: hits.length,
      offset, limit, more: offset + page.length < hits.length,
      atlases: lib.atlases, icons: page,
    });
    return;
  }

  if (m === 'GET' && p === '/api/icons') {
    // `file` is the REAL on-disk filename. The client builds override paths as
    // ICON_PREFIX + file, so a hand-dropped "foo.jpeg" (whose ext normalises to
    // "jpg") still assigns a path that actually exists.
    const list = listImages(ICON_DIR, ICON_EXTS)
      .map((r) => ({ name: r.stem, file: r.file, ext: r.ext, mtime: r.mtime, size: r.size }));
    sendJson(res, 200, { ok: true, dir: ICON_DIR, deckDir: DECK_ICON_DIR, icons: list });
    return;
  }

  if (m === 'POST' && p === '/api/icon') {
    const body = await readJsonBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!validIconName(name)) { sendErr(res, 400, 'Bad icon name — letters, digits, space, _ and - only, no dots (got "' + String(body.name).slice(0, 60) + '")'); return; }
    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the Spell Deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;
    removeStem(ICON_DIR, name, ICON_EXTS);
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    const landed = path.parse(info.file).name;   // may differ: the game had the old file open
    log('icon saved: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)');
    sendJson(res, 200, { ok: true, name: landed, requested: name, renamed: !!info.renamed, ext: info.ext, mtime: info.mtime, size: info.size, url: '/api/icon-file/' + encodeURIComponent(landed) + '?v=' + info.mtime });
    return;
  }

  if (m === 'DELETE' && p.startsWith('/api/icon/')) {
    const name = decodeURIComponent(p.slice('/api/icon/'.length));
    if (!validIconName(name)) { sendErr(res, 400, 'Bad icon name'); return; }
    const n = removePoolIcon(name);
    if (!n) { sendErr(res, 404, 'No icon named "' + name + '"'); return; }
    log('icon deleted: ' + name);
    sendJson(res, 200, { ok: true, name, removed: n });
    return;
  }

  if (m === 'GET' && p.startsWith('/api/icon-file/')) {
    const name = decodeURIComponent(p.slice('/api/icon-file/'.length));
    if (!validIconName(name)) { sendErr(res, 400, 'Bad icon name'); return; }
    const r = findByStem(ICON_DIR, name, ICON_EXTS);
    if (!r) { sendErr(res, 404, 'No icon named "' + name + '"'); return; }
    const abs = confine(ICON_DIR, r.file);
    if (!abs) { sendErr(res, 400, 'Refusing to serve outside the icons folder'); return; }
    sendFile(res, abs, r.ext);
    return;
  }

  /* ---- spell deck: the real spells, and icon assignment ---- */

  if (m === 'GET' && p === '/api/spells') {
    // 200 even when ok:false — same contract as /api/roster: the SPA renders
    // the diagnostic inline instead of collapsing into "fetch failed".
    sendJson(res, 200, spellsPayload());
    return;
  }

  // Serve any icon either view can reference, read-only, straight out of that
  // view dir — this is what lets a row show the Spell Hotbar library icon a spell
  // is actually using, not a grey placeholder. confineView() is the only guard
  // that matters here; the outer traversal check never sees the query string.
  // `view=hotkey` reads the deck's own icons tree; omitted/anything else = the
  // MagicDeck one, so every URL minted before hotkey icons existed still works.
  /* Rendered armour icons (Mesh Rendering Framework via the plugin). The PNGs
     land in MO2 OVERWRITE through the VFS, which /api/view-icon cannot see —
     so this route is overwrite-aware, like portraits. Filename only, no path. */
  if (m === 'GET' && p === '/api/item-icon') {
    const f = String(url.searchParams.get('f') || '');
    if (!f || !/^[a-z0-9._-]+\.png$/i.test(f)) { sendErr(res, 400, 'Bad icon name'); return; }
    for (const dir of ITEMICON_DIRS) {
      const abs = path.join(dir, f);
      if (fs.existsSync(abs)) { sendFile(res, abs, 'png'); return; }
    }
    sendErr(res, 404, 'No render for "' + f.slice(0, 60) + '" yet');
    return;
  }

  if (m === 'GET' && p === '/api/view-icon') {
    const rel = url.searchParams.get('p') || '';
    const view = viewName(url.searchParams.get('view'));
    const abs = confineView(rel, view);
    if (!abs) { sendErr(res, 400, 'Bad icon path'); return; }
    if (!fs.existsSync(abs)) {
      /* An image WRITTEN BY THE RUNNING GAME (outfit photos, anything the
         plugin drops mid-session) lands in MO2 OVERWRITE via the VFS, not in
         the mod folder — the exact reason a taken photo 404'd here. Same
         segment-guarded rel, different root. */
      const viewDir = view === 'hotkey' ? 'HotkeyDeck' : 'MagicDeck';
      const ovAbs = path.resolve(path.join(MO_OVERWRITE, 'PrismaUI', 'views', viewDir), rel.split('/').join(path.sep));
      const ovRoot = path.resolve(path.join(MO_OVERWRITE, 'PrismaUI', 'views', viewDir)) + path.sep;
      if (ovAbs.startsWith(ovRoot) && fs.existsSync(ovAbs)) {
        sendFile(res, ovAbs, normExt(path.extname(ovAbs)));
        return;
      }
      sendErr(res, 404, 'No icon at "' + rel.slice(0, 80) + '" in the ' + view + ' view');
      return;
    }
    sendFile(res, abs, normExt(path.extname(abs)));
    return;
  }

  // Upload art FOR A SPELL: writes the file into the custom pool, then queues
  // the assignment in the sidecar. Two effects, one tap on the phone.
  if (m === 'POST' && p === '/api/spell-icon') {
    const body = await readJsonBody(req);
    const spellId = typeof body.spellId === 'string' ? body.spellId : '';
    if (!spellId) { sendErr(res, 400, 'spellId is required'); return; }
    const hit = findSpell(spellId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }

    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the Spell Deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;  // trust the bytes over the label

    // An explicit name is authoritative (replaces). A name we derived from the
    // spell gets uniquified, so art for a second same-named spell can't
    // silently repaint the first one's icon.
    const explicit = typeof body.iconName === 'string' && body.iconName.trim();
    let name;
    if (explicit) {
      name = body.iconName.trim();
      if (!validIconName(name)) {
        sendErr(res, 400, 'Bad icon name — letters, digits, space, _ and - only, no dots (got "' + String(body.iconName).slice(0, 60) + '")'); return;
      }
    } else {
      const queued = readAssignments().list.filter((e) => e.spellId === spellId)[0];
      const curFile = ownPoolFile(hit.spell.icon, queued ? queued.icon : undefined);
      name = freeIconName(iconNameFrom(hit.spell.name, 'spell icon'), curFile);
    }

    const replaced = !!findByStem(ICON_DIR, name, ICON_EXTS);
    removeStem(ICON_DIR, name, ICON_EXTS);
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }

    const icon = ICON_PREFIX + info.file;
    let list;
    try { list = mergeAssignment(spellId, icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), 'Icon saved as ' + info.file + ' but the assignment could not be queued: ' + e.message); return;
    }
    log('spell icon: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB) queued for "' + str(hit.spell.name) + '" [' + spellId + ']');
    sendJson(res, 200, {
      ok: true, spellId, spellName: str(hit.spell.name), icon,
      name: path.parse(info.file).name, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size, replaced,
      url: '/api/icon-file/' + encodeURIComponent(path.parse(info.file).name) + '?v=' + info.mtime,
      pendingAssignments: list.length,
    });
    return;
  }

  // Assign an icon that already exists in the pool (or "" = back to Auto).
  // Sidecar only — nothing here ever opens hotkeys.json for writing.
  if (m === 'POST' && p === '/api/spell-assign') {
    const body = await readJsonBody(req);
    const spellId = typeof body.spellId === 'string' ? body.spellId : '';
    if (!spellId) { sendErr(res, 400, 'spellId is required'); return; }
    const hit = findSpell(spellId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }
    const chk = checkAssignIcon(body.icon);
    if (!chk.ok) { sendErr(res, 400, chk.error); return; }
    let list;
    try { list = mergeAssignment(spellId, chk.icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('spell assign: "' + str(hit.spell.name) + '" [' + spellId + '] -> ' + (chk.icon || '(auto)'));
    const shown = iconUrlFor(chk.icon);
    sendJson(res, 200, {
      ok: true, spellId, spellName: str(hit.spell.name), icon: chk.icon,
      iconUrl: shown ? shown.url : null,     // lets the SPA repaint without a reload
      pendingAssignments: list.length,
    });
    return;
  }

  /* ---- the deck itself: the real hotkeys, and icon assignment ---- *
     Exactly the spell flow one folder over: read entries[] from hotkeys.json,
     upload/assign an icon from the SHARED pool, queue it in the deck view's own
     sidecar. Nothing here writes hotkeys.json. The icon POOL routes above
     (/api/icons, /api/icon, /api/icon-file, /api/view-icon) are reused verbatim
     — there is deliberately no second pool CRUD set. */

  if (m === 'GET' && p === '/api/hotkeys') {
    // 200 even when ok:false — same contract as /api/roster and /api/spells:
    // the SPA renders the diagnostic inline instead of "fetch failed".
    sendJson(res, 200, hotkeysPayload());
    return;
  }

  // Upload art FOR A HOTKEY: writes the file into the shared pool (both view
  // trees), then queues the assignment in the sidecar. Two effects, one tap.
  if (m === 'POST' && p === '/api/hotkey-icon') {
    const body = await readJsonBody(req);
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!entryId) { sendErr(res, 400, 'entryId is required'); return; }
    const hit = findHotkeyEntry(entryId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }

    let ext = normExt(body.ext);
    if (!ICON_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + ICON_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !ICON_EXTS.includes(sniff)) {
      sendErr(res, 400, 'That file is not an image the deck can load (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff;  // trust the bytes over the label

    // An explicit name is authoritative (replaces). A name we derived from the
    // hotkey gets uniquified, so art for a second same-named entry can't
    // silently repaint the first one's icon.
    const explicit = typeof body.iconName === 'string' && body.iconName.trim();
    let name;
    if (explicit) {
      name = body.iconName.trim();
      if (!validIconName(name)) {
        sendErr(res, 400, 'Bad icon name — letters, digits, space, _ and - only, no dots (got "' + String(body.iconName).slice(0, 60) + '")'); return;
      }
    } else {
      const queued = readHotkeyIcons().list.filter((e) => e.entryId === entryId)[0];
      const curFile = ownPoolFile(hit.entry.icon, queued ? queued.icon : undefined);
      name = freeIconName(iconNameFrom(hit.entry.name, 'hotkey icon'), curFile);
    }

    const replaced = !!findByStem(ICON_DIR, name, ICON_EXTS);
    removeStem(ICON_DIR, name, ICON_EXTS);
    let info;
    try { info = writePoolIcon(name, ext, buf); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }

    const icon = ICON_PREFIX + info.file;
    let list;
    try { list = mergeHotkeyIcon(entryId, icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), 'Icon saved as ' + info.file + ' but the assignment could not be queued: ' + e.message); return;
    }
    // The bytes may have landed under a DIFFERENT stem than we asked for: a file
    // the running game has already drawn stays locked for its whole session, so
    // writePoolIcon() falls forward to the next free name. The assignment above
    // already uses info.file; `name`/`url` must agree with it or the phone shows
    // the OLD art (or a 404) as the new icon's preview.
    const landed = path.parse(info.file).name;
    log('hotkey icon: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB) queued for "' +
      str(hit.entry.name) + '" [' + entryId + ']' + (hit.entries > 1 ? ' [' + hit.entries + ' entries share that id]' : ''));
    sendJson(res, 200, {
      ok: true, entryId, entryName: str(hit.entry.name), icon,
      name: landed, requested: name, renamed: !!info.renamed,
      ext: info.ext, mtime: info.mtime, size: info.size, replaced,
      entries: hit.entries,
      url: '/api/icon-file/' + encodeURIComponent(landed) + '?v=' + info.mtime,
      pendingHotkeyIcons: list.length,
    });
    return;
  }

  // Assign an icon that already exists in the pool (or "" = no icon).
  // Sidecar only — nothing here ever opens hotkeys.json for writing.
  if (m === 'POST' && p === '/api/hotkey-assign') {
    const body = await readJsonBody(req);
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!entryId) { sendErr(res, 400, 'entryId is required'); return; }
    const hit = findHotkeyEntry(entryId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }
    const chk = checkAssignIcon(body.icon, 'hotkey');
    if (!chk.ok) { sendErr(res, 400, chk.error); return; }
    // The deck resolves the path against ITS OWN folder, so make sure the bytes
    // are there before the change can be applied — otherwise the row paints
    // nothing and it looks like the assignment failed. A library path needs no
    // mirroring: checkAssignIcon() already proved it exists in THIS view.
    if (chk.icon && chk.icon.startsWith(ICON_PREFIX)) ensureDeckCopy(chk.icon.slice(ICON_PREFIX.length));
    let list;
    try { list = mergeHotkeyIcon(entryId, chk.icon); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('hotkey assign: "' + str(hit.entry.name) + '" [' + entryId + '] -> ' + (chk.icon || '(none)'));
    const shown = iconUrlFor(chk.icon, 'hotkey');
    sendJson(res, 200, {
      ok: true, entryId, entryName: str(hit.entry.name), icon: chk.icon,
      iconUrl: shown ? shown.url : null,     // lets the SPA repaint without a reload
      entries: hit.entries,
      pendingHotkeyIcons: list.length,
    });
    return;
  }

  /* ---- editing a hotkey: rename / re-describe / re-file / rebind ---- *
     Sidecar only. Everything here is a PARTIAL update — the body carries only
     the fields that changed, and an absent field is left alone by the consumer.
     Nothing in this block opens hotkeys.json for writing. */
  if (m === 'POST' && p === '/api/hotkey-edit') {
    const body = await readJsonBody(req);
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!entryId) { sendErr(res, 400, 'entryId is required'); return; }
    const hit = findHotkeyEntry(entryId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }

    // A queued delete owns the id until it is undone. Silently folding an edit
    // on top would either resurrect the entry or lose the edit, depending on
    // which rule you read first — so say so instead of guessing.
    const queued = readHotkeyEdits().list.filter((e) => e.entryId === entryId)[0];
    if (queued && queued.op === 'delete') {
      sendErr(res, 409, '"' + (str(hit.entry.name) || entryId) + '" is queued for deletion — undo that first, then edit it.');
      return;
    }

    const chk = checkHotkeyEdit(body, hit);
    if (!chk.ok) { sendErr(res, 400, chk.error); return; }
    if (!Object.keys(chk.patch).length) {
      sendErr(res, 400, 'Nothing to change — send at least one of: ' + HK_EDIT_KEYS.join(', ') + '.');
      return;
    }

    let merged;
    try { merged = mergeHotkeyEdit(entryId, Object.assign({ op: 'update' }, chk.patch)); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    const view = editViewOf(merged.op, hit.entry);
    log('hotkey edit: "' + str(hit.entry.name) + '" [' + entryId + '] ' +
      Object.keys(chk.patch).map((k) => k + '=' + JSON.stringify(chk.patch[k])).join(' ') +
      (hit.entries > 1 ? ' [' + hit.entries + ' entries share that id]' : ''));
    sendJson(res, 200, Object.assign({
      ok: true, entryId, entryName: str(hit.entry.name),
      applied: chk.patch,                 // exactly what this call changed
      entries: hit.entries,
      pendingHotkeyEdits: merged.list.length,
      file: HKEDIT_FILE,
    }, view));                            // pendingEdit / pendingDelete / pendingKeyLabel
    return;
  }

  // Queue the removal of a hotkey. Deleting the LAST entry is allowed — the deck
  // renders an empty state, and re-adding one in-game takes two taps.
  if (m === 'POST' && p === '/api/hotkey-delete') {
    const body = await readJsonBody(req);
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!entryId) { sendErr(res, 400, 'entryId is required'); return; }
    const hit = findHotkeyEntry(entryId);
    if (!hit.ok) { sendErr(res, hit.code, hit.error); return; }

    let merged;
    try { merged = mergeHotkeyEdit(entryId, { op: 'delete' }); } catch (e) {
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('hotkey delete queued: "' + str(hit.entry.name) + '" [' + entryId + ']' +
      (hit.entries > 1 ? ' [' + hit.entries + ' entries share that id]' : ''));
    sendJson(res, 200, Object.assign({
      ok: true, entryId, entryName: str(hit.entry.name),
      entries: hit.entries,
      pendingHotkeyEdits: merged.list.length,
      file: HKEDIT_FILE,
    }, editViewOf(merged.op, hit.entry)));
    return;
  }

  // Undo: drop whatever is queued for this entry. Deliberately does NOT require
  // the entry to still exist — clearing a stale op (the entry was deleted
  // in-game after the edit was queued) is exactly what this is for.
  if (m === 'POST' && p === '/api/hotkey-revert') {
    const body = await readJsonBody(req);
    const entryId = typeof body.entryId === 'string' ? body.entryId : '';
    if (!entryId) { sendErr(res, 400, 'entryId is required'); return; }
    let list;
    try { list = removeHotkeyEdit(entryId); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    if (list === null) {
      sendErr(res, 404, 'Nothing is queued for "' + entryId.slice(0, 60) + '" — reload (⟳); the game may already have applied it.');
      return;
    }
    log('hotkey edit dropped: [' + entryId + ']');
    sendJson(res, 200, {
      ok: true, entryId,
      pendingEdit: null, pendingDelete: false, pendingKeyLabel: null,
      pendingHotkeyEdits: list.length,
      file: HKEDIT_FILE,
    });
    return;
  }

  /* ---- domains (the Domains tab: one optional image per marked place) ---- *
   *  Reads hotkeys.json -> domains.marks[] and lets the phone upload/replace/
   *  clear ONE image per domain, filename EXACTLY <id>.<ext> so the in-game
   *  Domains view can load it by convention (domain-images/<id>.png|jpg|jpeg|webp
   *  with an onerror fallback). Uploads land in DOMAIN_IMG_DIR inside the deck's
   *  own view folder, which MO2's VFS passes through mid-game. */
  if (m === 'GET' && p === '/api/domains') {
    // 200 even when ok:false — same contract as /api/roster and /api/spells:
    // the SPA renders the diagnostic inline instead of collapsing.
    sendJson(res, 200, readDomains());
    return;
  }

  if (m === 'POST' && p === '/api/domain-image') {
    const body = await readJsonBody(req);
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!validDomainId(id)) { sendErr(res, 400, 'Bad domain id — letters, digits, _ and - only (got "' + String(body.id).slice(0, 60) + '")'); return; }
    let ext = normExt(body.ext);
    if (!DOMAIN_EXTS.includes(ext)) { sendErr(res, 400, 'Bad extension "' + ext + '" — allowed: ' + DOMAIN_EXTS.join(', ')); return; }
    let buf;
    try { buf = decodeImage(body.dataBase64); } catch (e) { sendErr(res, httpCode(e.code, 400), e.message); return; }
    const sniff = sniffExt(buf);
    if (!sniff || !DOMAIN_EXTS.includes(sniff === 'jpg' ? 'jpg' : sniff)) {
      sendErr(res, 400, 'That file is not a PNG/JPEG/WebP image (magic bytes say "' + (sniff || 'unknown') + '")'); return;
    }
    if (sniff !== ext) ext = sniff; // trust the bytes over the label
    let info;
    try { info = writeDomainImage(id, ext, buf); }
    catch (e) {
      // A locked file (the running game is drawing it) is not a server fault —
      // answer 200 with a clear, non-fatal message the phone can show instead
      // of a 500 crash.
      if (e && e.locked) { sendJson(res, 200, { ok: false, locked: true, id, error: e.message }); return; }
      sendErr(res, httpCode(e.code, 500), e.message); return;
    }
    log('domain image saved: ' + info.file + ' (' + Math.round(info.size / 1024) + ' KB)');
    sendJson(res, 200, {
      ok: true, id, ext: info.ext, mtime: info.mtime, size: info.size,
      url: '/api/domain-image-file/' + encodeURIComponent(id) + '?v=' + info.mtime,
    });
    return;
  }

  if (m === 'DELETE' && p.startsWith('/api/domain-image/')) {
    const id = decodeURIComponent(p.slice('/api/domain-image/'.length));
    if (!validDomainId(id)) { sendErr(res, 400, 'Bad domain id'); return; }
    if (!findDomainImage(id)) { sendErr(res, 404, 'No image for domain "' + id + '"'); return; }
    const n = removeDomainImage(id);
    // A file the running game holds open cannot be deleted and comes straight
    // back — say so rather than reporting a success the next refresh contradicts.
    if (findDomainImage(id)) {
      sendErr(res, 423, 'That image is open in the running game and cannot be deleted — close Skyrim and retry.');
      return;
    }
    log('domain image deleted: ' + id);
    sendJson(res, 200, { ok: true, id, removed: n });
    return;
  }

  if (m === 'GET' && p.startsWith('/api/domain-image-file/')) {
    const id = decodeURIComponent(p.slice('/api/domain-image-file/'.length));
    if (!validDomainId(id)) { sendErr(res, 400, 'Bad domain id'); return; }
    const r = findDomainImage(id);
    if (!r) { sendErr(res, 404, 'No image for domain "' + id + '"'); return; }
    const abs = confine(DOMAIN_IMG_DIR, r.file);
    if (!abs) { sendErr(res, 400, 'Refusing to serve outside the domain-images folder'); return; }
    sendFile(res, abs, r.ext);
    return;
  }

  /* ---- Dragon Roost (its own mod, its own status + queue files) ---- *
   *  GET  /api/roost        the whole published state + what is queued
   *  POST /api/roost        queue ONE command for the game's next tick
   *  POST /api/roost-clear  drop one queued command, or all of them
   *  GET  /api/dragon-image the game-written per-dragon / per-egg PNGs
   *
   *  200 even when nothing is published — same contract as /api/domains and
   *  /api/spells: the SPA renders "waiting for Dragon Roost" inline instead of
   *  collapsing, because that is the NORMAL state until the DLL ships. */
  if (m === 'GET' && p === '/api/roost') {
    sendJson(res, 200, readRoost());
    return;
  }

  if (m === 'POST' && p === '/api/roost') {
    const body = await readJsonBody(req);
    /* A BATCH — {ops:[…]} — is one intention that happens to name many
       subjects ("render every skin this filter shows"). Accepted here rather
       than as N requests so the queue file is written once and the phone can
       never leave a half-queued batch behind. Rows that do not validate are
       counted and reported, never silently dropped. */
    if (Array.isArray(body.ops)) {
      if (!body.ops.length) { sendErr(res, 400, 'ops[] is empty — nothing to queue'); return; }
      if (body.ops.length > DR_QUEUE_MAX) {
        sendErr(res, 400, 'That is ' + body.ops.length + ' commands — the queue holds ' + DR_QUEUE_MAX + '.');
        return;
      }
      const recs = [], bad = [];
      for (const raw of body.ops) {
        const rec = drCheckOp(raw);
        if (rec) recs.push(rec); else bad.push(String((raw && (raw.kind || raw.op)) || '?').slice(0, 40));
      }
      if (!recs.length) {
        sendErr(res, 400, 'None of those ' + body.ops.length + ' commands is one the game understands' +
          (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
        return;
      }
      let blist;
      try { blist = drQueueOps(recs); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
      log('roost queue batch ×' + recs.length + (bad.length ? ' (' + bad.length + ' rejected)' : ''));
      sendJson(res, 200, {
        ok: true, op: 'batch', queued: recs.length, rejected: bad.length,
        pending: blist.length, ops: blist, file: drQueueFile(),
      });
      return;
    }
    // The phone names the KIND (so hatch-an-egg and hatch-a-species are two
    // buttons); drKindOf resolves the DLL's ambiguous wire verbs to one of ours
    // — the SAME function drCheckOp uses, so the gate and the parser agree.
    const kind = drKindOf(body);
    if (!DR_OPS[kind]) {
      sendErr(res, 400, 'Unknown op "' + String(kind).slice(0, 40) + '" — allowed: ' + Object.keys(DR_OPS).join(', '));
      return;
    }
    const rec = drCheckOp(body);
    if (!rec) {
      const spec = DR_OPS[kind];
      sendErr(res, 400, 'Bad "' + kind + '" — needs ' +
        ((spec.needs || []).concat(spec.text
          ? [spec.text + (spec.enum ? ' (one of: ' + spec.enum.join(', ') + ')'
            : ' (string' + (spec.emptyOk ? ', "" clears it' : ', not empty') + ')')] : [])
          .concat(spec.keyed ? [spec.keyed + ' (the subject: "Plugin.esp|0xABCDEF", or a dragon id)'] : [])
          .concat(spec.bool ? [spec.bool + ' (boolean)'] : []).join(', ') || 'nothing') +
        (kind === 'breed' ? ' — and a dragon cannot be paired with itself' : '') +
        (kind === 'rename' ? ' — the game refuses an empty name, so the portal does too' : '') +
        (spec.text === 'skin' || spec.text === 'species'
          ? ' — that key looks like "Plugin.esp|0xABCDEF"' : ''));
      return;
    }
    const op = rec.kind || rec.op;
    let list;
    try { list = drQueueOp(rec); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('roost queue ' + op + ' ' + JSON.stringify(rec));
    sendJson(res, 200, { ok: true, op, queued: rec, pending: list.length, ops: list, file: drQueueFile() });
    return;
  }

  if (m === 'POST' && p === '/api/roost-clear') {
    const body = await readJsonBody(req);
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    let list;
    try { list = drClearQueue(id); } catch (e) { sendErr(res, httpCode(e.code, 500), e.message); return; }
    log('roost queue cleared' + (id ? ' #' + id : ' (all)') + ' — ' + list.length + ' left');
    sendJson(res, 200, { ok: true, pending: list.length, ops: list, file: drQueueFile() });
    return;
  }

  if (m === 'GET' && p === '/api/dragon-image') {
    const rel = url.searchParams.get('p') || '';
    const abs = drConfineImage(rel);
    if (!abs) { sendErr(res, 404, 'No Dragon Roost image at "' + rel.slice(0, 80) + '"'); return; }
    /* `?w=` asks for a THUMBNAIL. The confine above has already decided what
       may be read; the width only decides how much of it comes back. A width
       we cannot honour — an odd number, a format we cannot decode, a picture
       already smaller — falls through to the original file, so this can only
       ever make a response cheaper, never absent. */
    const want = drThumbWidth(url.searchParams.get('w'));
    if (want) {
      const thumb = await drThumb(abs, want);
      if (thumb) { sendBuf(res, thumb, 'png'); return; }
    }
    sendFile(res, abs, normExt(path.extname(abs)));
    return;
  }

  sendErr(res, 404, 'No route for ' + m + ' ' + p);
}

/* ========================= domain images ============================== *
 *  The Domains tab (hotkeys.json -> domains.marks[]) gets ONE optional image
 *  per marked place — uploaded from the phone, drawn as a thumbnail here AND,
 *  by filename convention, in the in-game Domains view.
 *
 *  Unlike the icon pool and portraits, the filename is NOT free. The in-game
 *  view loads `domain-images/<id>.png|jpg|jpeg|webp` directly (onerror fallback
 *  across those four extensions), so the file MUST be exactly `<id>.<ext>`, with
 *  NO version suffix and exactly one per id. The id is a domain mark's `id`.
 *  That is why there is no `~<stamp>` fallback the way portraits/icons have — a
 *  locked replace has nowhere to land, so it is reported, not renamed.
 *
 *  A sidecar `domain-images.json` ({ [id]: { file, ext, mtime } }) is kept as a
 *  plain index, rebuilt from disk on every upload/delete. The on-disk files are
 *  authoritative; the sidecar is a convenience map.
 * ======================================================================= */

const DOMAIN_IMG_DIR = path.join(DECK_VIEW_DIR, 'domain-images');
const DOMAIN_IMG_SIDECAR = path.join(DOMAIN_IMG_DIR, 'domain-images.json');
const DOMAIN_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
// A domain id is minted by the deck (newId() in app.js). Accept the charset the
// contract fixes and nothing else, so a stray id can never address a path — the
// per-segment confine() below is the belt to this brace.
const DOMAIN_ID_RE = /^[A-Za-z0-9_-]+$/;

function validDomainId(s) { return typeof s === 'string' && s.length > 0 && s.length <= 80 && DOMAIN_ID_RE.test(s); }

/** The one image file for a domain id, whatever its extension, or null. */
function findDomainImage(id) { return validDomainId(id) ? findByStem(DOMAIN_IMG_DIR, id, DOMAIN_EXTS) : null; }

/** Rebuild domain-images.json from what is actually on disk. Best-effort: it is
 *  only an index, so a failure here never fails the upload/delete that called
 *  it. Temp file + rename, so nothing ever reads a half-written one. */
function refreshDomainSidecar() {
  const map = {};
  for (const r of listImages(DOMAIN_IMG_DIR, DOMAIN_EXTS)) {
    map[r.stem] = { file: r.file, ext: r.ext, mtime: r.mtime };
  }
  if (!ensureDir(DOMAIN_IMG_DIR)) return map;
  const tmp = DOMAIN_IMG_SIDECAR + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(map, null, 2)); renameWithRetry(tmp, DOMAIN_IMG_SIDECAR); }
  catch (_) { try { fs.unlinkSync(tmp); } catch (_) {} }
  return map;
}

/** Write <id>.<ext>, deleting any other-extension file for the same id first so
 *  there is EXACTLY one image per domain. tmp-write + rename, dir-confined.
 *
 *  The running game memory-maps every image it has drawn (Ultralight), so
 *  REPLACING one the deck is already showing fails with EBUSY/EPERM/EACCES.
 *  There is no version fallback here — the filename is fixed by the in-game
 *  view's convention — so that case is thrown with `.locked` set, and the route
 *  turns it into a clear, non-fatal message instead of a 500. A brand-new image
 *  (nothing drawn yet) writes fine even mid-game and shows on the next open. */
function writeDomainImage(id, ext, buf) {
  if (!ensureDir(DOMAIN_IMG_DIR)) throw Object.assign(new Error('Cannot create ' + DOMAIN_IMG_DIR), { code: 500 });
  const dest = confine(DOMAIN_IMG_DIR, id + '.' + ext);
  if (!dest) throw Object.assign(new Error('Refusing to write outside ' + DOMAIN_IMG_DIR), { code: 400 });
  // Exactly one per id — drop every other-extension file for it. A file the
  // running game holds open simply stays; the write below then reports the lock.
  removeStem(DOMAIN_IMG_DIR, id, DOMAIN_EXTS);
  const tmp = dest + '.tmp';
  try {
    fs.writeFileSync(tmp, buf);
    renameWithRetry(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    const locked = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
    if (locked) {
      throw Object.assign(
        new Error('That domain image is open in the running game and can\'t be replaced right now — ' +
          'close Skyrim and retry. (A brand-new image still lands and shows on the deck\'s next open.)'),
        { code: 423, locked: true });
    }
    throw e;
  }
  const st = fs.statSync(dest);
  refreshDomainSidecar();
  return { file: id + '.' + ext, ext, mtime: Math.floor(st.mtimeMs / 1000), size: st.size };
}

/** Delete a domain's image (every extension). Returns how many files went; a
 *  file the running game holds open simply stays. */
function removeDomainImage(id) {
  const n = removeStem(DOMAIN_IMG_DIR, id, DOMAIN_EXTS);
  refreshDomainSidecar();
  return n;
}

/** The Domains tab, read straight out of hotkeys.json -> domains.marks[]. Same
 *  READ-ONLY, re-read-every-request contract as the spell and hotkey slices: the
 *  game rewrites this file constantly. `place` mirrors the in-game view's
 *  placeOf(): cellName, else worldspaceName, else cellEdid. */
function readDomains(src) {
  const s = src || readHkRoot();
  if (!s.ok) return { ok: false, file: s.file, error: s.error, dir: DOMAIN_IMG_DIR, domains: [] };
  const root = (s.root && typeof s.root === 'object' && !Array.isArray(s.root)) ? s.root : {};
  const dom = (root.domains && typeof root.domains === 'object' && !Array.isArray(root.domains)) ? root.domains : {};
  const marks = Array.isArray(dom.marks) ? dom.marks : [];
  const out = [];
  for (const mk of marks) {
    if (!mk || typeof mk !== 'object') continue;
    const id = typeof mk.id === 'string' ? mk.id : '';
    if (!id) continue;
    const img = findDomainImage(id);
    out.push({
      id,
      name: str(mk.name) || 'Unnamed domain',
      category: str(mk.category),
      // '' = a top-level domain; else the id of the PARENT mark this is a
      // sub-area of. Mirrors the in-game view's one-level tree (domains-pane.js).
      parentId: str(mk.parentId),
      place: str(mk.cellName) || str(mk.worldspaceName) || str(mk.cellEdid),
      interior: !!mk.interior,
      hasImage: !!img,
      imageUrl: img ? '/api/domain-image-file/' + encodeURIComponent(id) + '?v=' + img.mtime : null,
    });
  }
  return { ok: true, file: s.file, dir: DOMAIN_IMG_DIR, domains: out };
}

/* ======================================================================= *
 *                            DRAGON ROOST
 *
 *  Dragon Roost is its OWN mod (its own DLL, its own PrismaUI view, its own
 *  MO2 folder) — nothing here reads or writes hotkeys.json, and none of the
 *  Hotkey Deck's sidecars are involved. What it shares with the rest of the
 *  portal is the LAW, and the law is the whole reason this file exists:
 *
 *      ⛔ THE PORTAL NEVER WRITES A FILE THE RUNNING GAME OWNS. ⛔
 *
 *  MO2 snapshots its VFS at launch and the game rewrites its own state files
 *  wholesale, so an edit made underneath one is discarded without a sound. So
 *  the split is the same as every other tab's:
 *
 *      the GAME publishes  →  ONE status file  →  the phone READS it
 *      the phone queues    →  ONE queue file   →  the GAME applies it, on its
 *                                                 own 5-second tick
 *
 *  Consequence the UI must never blur: a queued command has NOT happened. It
 *  is shown as pending, with the tick named, until the game says otherwise by
 *  republishing its status. Showing a queued action as done is the one bug
 *  that would make the whole tab untrustworthy.
 *
 *  ── WAITING IS THE NORMAL STATE ──────────────────────────────────────────
 *  Until the DLL that writes the status file ships, there is no status file.
 *  That is not an error and must not read as one: readRoost() answers
 *  { ok:true, waiting:true } with an empty everything, and the view says
 *  "waiting for Dragon Roost — launch the game once".
 * ======================================================================= */

const MOD_DR = process.env.DECK_PORTAL_MOD_DR ||
  '';   // set DECK_PORTAL_ROOST to a Dragon Roost mod folder to enable that panel

const DR_VIEW_DIR = path.join(MOD_DR, 'PrismaUI', 'views', 'DragonRoost');
const DR_CFG_DIR = path.join(MOD_DR, 'SKSE', 'Plugins', 'DragonRoost');

/* ONE place, several candidates — deliberately, and for a reason that has
 * already bitten this portal once (the captured portrait nobody could see):
 * a file the GAME writes lands in MO2's `overwrite`, not in the mod folder, so
 * a reader that only looks at the mod folder is structurally blind to it. And
 * the DLL half of this feature is being written concurrently, so which of the
 * two plausible homes it picks — beside roost.json in SKSE\Plugins\DragonRoost,
 * or beside the view in PrismaUI\views\DragonRoost — is not yet settled.
 *
 * Rather than guess once and be wrong, the resolver tries the cross product of
 * (overwrite, mod folder) x (both dirs) x (three plausible basenames) and takes
 * the NEWEST file that parses. Newest rather than first because a stale seed
 * shipped in the mod folder must never shadow what the game just published.
 * DECK_PORTAL_DR_STATUS pins it outright when the DLL settles. */
const DR_STATUS_BASENAMES = ['portal-status.json', 'roost-status.json', 'status.json'];
const DR_STATUS_DIRS = [
  path.join(MO_OVERWRITE, 'SKSE', 'Plugins', 'DragonRoost'),
  path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'DragonRoost'),
  DR_CFG_DIR,
  DR_VIEW_DIR,
];
const DR_STATUS_CANDIDATES = process.env.DECK_PORTAL_DR_STATUS
  ? [process.env.DECK_PORTAL_DR_STATUS]
  : DR_STATUS_DIRS.reduce((acc, d) => acc.concat(DR_STATUS_BASENAMES.map((b) => path.join(d, b))), []);

/* The queue the phone writes and the game drains — PortalLink::QueuePath(),
 * `Data\SKSE\Plugins\DragonRoost\portal-dragonroost.json`.
 *
 * It lives in MO2's OVERWRITE tree, and that is not the usual "portal writes into
 * the mod folder" rule being broken — it is that rule's own reasoning followed to
 * its conclusion. The GAME creates this file (PortalLink::Init writes an empty one
 * if it is missing) and CLEARS it rather than deleting it, precisely so the VFS
 * mapping survives; deleting it would take it out of the tree and make the
 * portal's re-creation invisible until the next launch. So the file the running
 * game reads is the overwrite copy, and that is the copy we must write.
 *
 * Same resolver as the status file: try the real locations, take the one that
 * EXISTS. When none does — before the DLL has ever run — we fall back to the
 * overwrite path and create it there, which is the location the game will adopt
 * on its next launch.
 *
 * ⚠ The MO2 VFS is a launch-time snapshot: a file we CREATE here mid-session is
 * invisible to the already-running game. Once the game has made it, our writes
 * into it are seen. That is why the UI never promises "now". */
const DR_QUEUE_BASENAME = 'portal-dragonroost.json';
const DR_QUEUE_CANDIDATES = process.env.DECK_PORTAL_DR_QUEUE
  ? [process.env.DECK_PORTAL_DR_QUEUE]
  : [
    path.join(MO_OVERWRITE, 'SKSE', 'Plugins', 'DragonRoost', DR_QUEUE_BASENAME),
    path.join(DR_CFG_DIR, DR_QUEUE_BASENAME),
    path.join(DR_VIEW_DIR, DR_QUEUE_BASENAME),
  ];
/** The queue file to write. An existing one always wins (that is the one the game
 *  mapped); otherwise the first candidate, which is where the game will make it. */
function drQueueFile() {
  for (const f of DR_QUEUE_CANDIDATES) {
    try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* next */ }
  }
  return DR_QUEUE_CANDIDATES[0];
}
const DR_QUEUE_MAX = 200;                // one tab, one player; 200 is already absurd

/* Portraits. The roster's `portrait` is a path relative to the VIEW folder
 * ("portraits/drg_3.png") because that is the only kind Ultralight will load —
 * and the PNGs are written by the game, so they land in overwrite first. Both
 * roots are searched, overwrite first, exactly as MO2 would resolve it. */
const DR_PORTRAIT_ROOTS = [
  path.join(MO_OVERWRITE, 'PrismaUI', 'views', 'DragonRoost'),
  DR_VIEW_DIR,
];
const DR_IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

/* Every op the phone may queue, and what identifies it for dedupe.
 *   dedupe 'dragon'  — keyed by dragonId. Two renames of one dragon are one
 *                      rename; a summon after a store replaces it (they are
 *                      opposites, and queueing both would make the tick's
 *                      order decide the outcome).
 *   dedupe 'egg'     — keyed by eggId.
 *   dedupe 'pair'    — keyed by pairId.
 *   dedupe 'breed'   — keyed by the ordered pair (sire, dam); ORDER MATTERS,
 *                      the clutch takes the dam's species (see roost.h Breed).
 *   dedupe 'single'  — one of these at a time, full stop: the toggles.
 * `state` ops carry a boolean; everything else carries ids and strings. */
/* ⚠ THE WIRE NAMES ARE THE DLL'S, NOT OURS. PortalLink::ParseOp reads `id` for a
 * dragon, `egg` for an egg, `pair` for a pairing — and it disambiguates `hatch`
 * by whether an `egg` key is PRESENT (else it reads the op as "hatch a species
 * from the Bestiary"). Sending `dragonId`/`eggId`/`pairId` would parse as a
 * different command or as none at all, so the names below are copied from that
 * parser rather than chosen. `emptyOk` marks the two text fields where "" is a
 * real instruction (back to the automatic look / clear the breath) as opposed to
 * `rename`, where the DLL refuses an empty name outright. */
const DR_OPS = {
  hatch: { dedupe: 'egg', needs: ['egg'], numeric: false },
  hatchSpecies: { wire: 'hatch', dedupe: 'species', text: 'species', also: 'name' },
  summon: { dedupe: 'dragon', needs: ['id'], group: 'place' },
  store: { dedupe: 'dragon', needs: ['id'], group: 'place' },
  rename: { dedupe: 'dragon', needs: ['id'], text: 'name' },
  skin: { dedupe: 'dragon', needs: ['id'], text: 'skin', emptyOk: true },
  breath: { dedupe: 'dragon', needs: ['id'], text: 'family', emptyOk: true },
  breed: { dedupe: 'breed', needs: ['sire', 'dam'] },
  cancelPair: { dedupe: 'pair', needs: ['pair'] },
  admin: { dedupe: 'single', bool: 'value' },
  /* Ask the game to RENDER a 3D portrait. Same `hatch`/`hatchSpecies` shape as
     above and for the same reason: one wire verb (`render`), two commands,
     told apart by whether a `skin` or a `species` key is present. Rendering
     happens in-game through the Mesh Rendering Framework, so this is the one
     family of ops that does literally nothing until Skyrim is up — which is
     why the pane says so beside every button that queues one. */
  renderSkin: { wire: 'render', dedupe: 'renderSkin', text: 'skin' },
  renderSpecies: { wire: 'render', dedupe: 'renderSpecies', text: 'species' },
  /* The whole catalogue in one op, so "render all 393" is one queue row rather
     than 393 — the game paces them itself. `what` is a closed vocabulary, not
     free text: an unknown value would be silently ignored at the far end. */
  renderAll: { dedupe: 'renderAll', text: 'what', enum: ['skins', 'species', 'dragons'] },
  /* EIGHT frames of one subject, 45° apart, so the phone's lightbox can be
     dragged around the animal. Deliberately shaped like `renderAll` — same
     closed `what` vocabulary — plus a `key` naming the ONE row inside that
     family, because a turntable is a per-subject job and there is no useful
     "spin everything" (393 skins × 7 extra frames is not a button anybody
     should be able to press by accident).

     Frame 0 IS the portrait that already exists and is never re-rendered; the
     game writes the other seven beside it as `…-a045.png` … `…-a315.png`, which
     is the whole contract the phone needs in order to find them (it just asks
     /api/dragon-image for those names and treats a 404 as "not yet").

     Deduped per SUBJECT, not per tap: dragging a one-frame picture is exactly
     how you discover the other seven are missing, so the request has to survive
     being triggered repeatedly and still be one queued job. */
  spin: { dedupe: 'spin', text: 'what', enum: ['skins', 'species', 'dragons'], keyed: 'key' },
};
/* There is deliberately NO `gate` op: PortalLink has no verb for the egg gate, so
 * queueing one would only ever be logged as a rejection. The gate is published,
 * so the phone SHOWS it — as a fact, not as a switch that does nothing. */
const DR_NAME_MAX = 64;                  // ClampUtf8 budget in roost.cpp Rename
const DR_KEY_MAX = 160;                  // "SomeVeryLongPlugin.esp|0xABCDEF"

/* A durable form key — "Plugin.esp|0xABCDEF". Deliberately permissive about
 * the plugin half (third-party filenames contain spaces, apostrophes, CJK) and
 * strict about the shape, because this string is only ever compared, never
 * turned into a path. */
const DR_KEY_RE = /^[^|\\/\0]{1,120}\|0[xX][0-9a-fA-F]{1,8}$/;

/* CanonKey() from roost.cpp, character for character: lower-case, then strike
 * the zeros immediately after the FIRST "|0x". One species genuinely arrives
 * spelled three ways in that codebase (unpadded uppercase from eggs.cpp, padded
 * from main.cpp's registry join, lower-cased from the view), and two spellings
 * of one dragon would split the collection in half. */
function drCanonKey(key) {
  let s = String(key == null ? '' : key).toLowerCase();
  const i = s.indexOf('|0x');
  if (i >= 0) {
    let j = i + 3;
    while (j < s.length && s[j] === '0') j++;
    // "|0x000000" must not canonicalise to "|0x" with nothing after it.
    if (j >= s.length || !/[0-9a-f]/.test(s[j])) j--;
    s = s.slice(0, i + 3) + s.slice(j);
  }
  return s;
}

/** "plugin.esp|0x1a2b3c" from a row that has plugin + numeric formId. Returns
 *  '' when either half is missing — an invented key is worse than none. */
function drKeyOf(row) {
  const plugin = str(row && row.plugin);
  const id = row && row.formId;
  if (!plugin || typeof id !== 'number' || !isFinite(id)) return '';
  return plugin + '|0x' + (id >>> 0).toString(16).toUpperCase();
}

function drNum(v, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
}
function drInt(v) {
  const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10);
  return isFinite(n) ? n : 0;
}
/** A list that may have arrived as a bare array, or wrapped under its own name
 *  ({"species":[…]}), or under `items`/`list`. The DLL's own JSON emitters do
 *  BOTH today — Skins::Json() is a bare array, Species::RegistryJson() wraps —
 *  so tolerating the two is not defensive padding, it is the actual contract. */
function drList(v, key) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const k of [key, 'items', 'list', 'rows']) {
      if (k && Array.isArray(v[k])) return v[k];
    }
  }
  return [];
}

/* ---------------------------- the status file -------------------------- */

/** The newest candidate that exists AND parses. Returns null when there is
 *  none — the normal state before the DLL ships. */
function drFindStatus() {
  let best = null;
  for (const f of DR_STATUS_CANDIDATES) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (best && st.mtimeMs <= best.mtimeMs) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { if (!best) best = { file: f, mtimeMs: st.mtimeMs, json: null, error: 'malformed JSON: ' + e.message }; continue; }
    best = { file: f, mtimeMs: st.mtimeMs, json: j, error: null };
  }
  return best;
}

/** Normalise whatever the DLL published into the shape the view consumes.
 *
 *  EVERY field is optional and an absent one is never faked — that is the same
 *  contract roost.cpp states for its own optional keys, and it has to hold in
 *  both directions or the phone renders the word "undefined" at the player. A
 *  row that carries only a name still draws; a slice that is missing entirely
 *  reads as empty, not as an error. */
function drNormalise(root) {
  const j = (root && typeof root === 'object' && !Array.isArray(root)) ? root : {};
  // Rebuilt from scratch every read, so /api/health always describes the
  // document on disk NOW rather than the union of everything ever seen.
  drPortraitKeysSeen = Object.create(null);
  // The whole document may be nested one level down — a publisher that wraps
  // its payload under `roost`/`state`/`data` is a plausible choice the DLL has
  // not made yet, and unwrapping costs one line.
  let body = j;
  for (const k of ['roost', 'state', 'data']) {
    if (j[k] && typeof j[k] === 'object' && !Array.isArray(j[k]) &&
        (j[k].species || j[k].dragons || j[k].eggs || j[k].skins)) { body = j[k]; break; }
  }

  const species = drList(body.species, 'species').map((s) => {
    const row = (s && typeof s === 'object') ? s : {};
    const key = str(row.key) || drKeyOf(row);
    return {
      key,
      canon: key ? drCanonKey(key) : '',
      name: str(row.name),
      variant: str(row.variant),
      plugin: str(row.plugin),
      race: str(row.race),
      tier: str(row.tier),
      element: str(row.element),
      bases: drInt(row.bases),
      formId: drInt(row.formId),
      rarity: Math.max(0, Math.min(5, drInt(row.rarity))),
      rarityLabel: str(row.rarityLabel),
      // The publisher may already have answered "have I ever owned one" per
      // row; if it has, that answer wins over our own join below.
      owned: row.owned === true || row.everOwned === true ? true : undefined,
      // …and, when the game has rendered one, the 3D portrait. Absent for most
      // of 251 species — that is the normal state, not a gap to paper over.
      ...drPortraitFields(row),
    };
  }).filter((s) => s.name || s.key);

  const skins = drList(body.skins, 'skins').map((s) => {
    const row = (s && typeof s === 'object') ? s : {};
    const key = str(row.key) || drKeyOf(row);
    return {
      key,
      name: str(row.name),
      edid: str(row.edid),
      plugin: str(row.plugin),
      model: str(row.model),
      formId: drInt(row.formId),
      ...drPortraitFields(row),
    };
  }).filter((s) => s.name || s.edid || s.key);

  const dragons = drList(body.dragons, 'dragons').map((d) => {
    const row = (d && typeof d === 'object') ? d : {};
    const out = {
      id: drInt(row.id),
      name: str(row.name),
      species: str(row.species),
      speciesName: str(row.speciesName),
      state: str(row.state),                       // "following" | "roosting"
      alive: row.alive === undefined ? undefined : !!row.alive,
      portrait: drPortraitOf(row),
      stage: str(row.stage),
      nextStage: str(row.nextStage),
      scale: drNum(row.scale, 0),
      ageDays: drNum(row.ageDays, 0),
      healthPct: drInt(row.healthPct),
      damagePct: drInt(row.damagePct),
      growthPct: drInt(row.growthPct),
      nextInDays: row.nextInDays === undefined ? -1 : drNum(row.nextInDays, -1),
      bond: drInt(row.bond),
      bondLabel: str(row.bondLabel),
      bondPct: drInt(row.bondPct),
      adult: !!row.adult,
      canBreed: row.canBreed === undefined ? undefined : !!row.canBreed,
      breedBlock: str(row.breedBlock),
    };
    // Deeds and lineage are OPTIONAL in the roster JSON by design (roost.cpp
    // says so at length): a Bestiary-made dragon has no parent and a pre-v7 one
    // has no lineage. Copy what is there, invent nothing.
    const deeds = (row.deeds && typeof row.deeds === 'object') ? row.deeds : null;
    if (deeds) {
      out.deeds = {
        kills: drInt(deeds.kills), summons: drInt(deeds.summons),
        daysOut: drNum(deeds.daysOut, 0), daysLived: drNum(deeds.daysLived, 0),
      };
    }
    for (const k of ['fromName', 'sireName', 'damName', 'skinName']) {
      if (str(row[k])) out[k] = str(row[k]);
    }
    for (const k of ['from', 'skin']) { if (str(row[k])) out[k] = str(row[k]); }
    for (const k of ['sire', 'dam', 'pair']) { if (row[k]) out[k] = drInt(row[k]); }
    for (const k of ['bornGameTime', 'eggFoundGameTime', 'shellDays']) {
      if (typeof row[k] === 'number') out[k] = row[k];
    }
    if (out.portrait) out.portraitUrl = drPortraitUrl(out.portrait);
    return out;
  }).filter((d) => d.id || d.name);

  // The clock every countdown is measured against. Absolute game DAYS.
  const gameNow = typeof body.gameTime === 'number' ? body.gameTime
    : (typeof body.now === 'number' ? body.now
      : (body.header && typeof body.header.gameTime === 'number' ? body.header.gameTime : 0));

  const eggs = drList(body.eggs, 'eggs').map((e) => {
    const row = (e && typeof e === 'object') ? e : {};
    const out = {
      id: drInt(row.id),
      species: str(row.species),
      speciesName: str(row.speciesName),
      tier: str(row.tier),
      element: str(row.element),
      portrait: drPortraitOf(row),
      swatch: str(row.swatch),
      found: str(row.found),
      foundGameTime: drNum(row.foundGameTime, 0),
      hatchGameTime: drNum(row.hatchGameTime, row.hatchAt),
      // PortalLink STRIPS `remaining` on purpose: it is hatchGameTime - gameTime
      // evaluated at the instant of the write, so leaving it in would change on
      // every tick (defeating its write-on-change rule) and be stale the moment
      // the phone read it. So it is derived here from the two numbers that ARE
      // published — exactly what the in-game view does to run its countdown live
      // between pushes — and a sent value is still honoured when there is one.
      remaining: Math.max(0, row.remaining !== undefined
        ? drNum(row.remaining, 0)
        : (drNum(row.hatchGameTime, drNum(row.hatchAt, 0)) - drNum(gameNow, 0))),
      fromName: str(row.fromName),
      bred: !!row.bred,
    };
    for (const k of ['sireName', 'damName']) { if (str(row[k])) out[k] = str(row[k]); }
    if (out.portrait) out.portraitUrl = drPortraitUrl(out.portrait);
    return out;
  }).filter((e) => e.id || e.species || e.speciesName);

  const pairs = drList(body.pairs, 'pairs').map((p) => {
    const row = (p && typeof p === 'object') ? p : {};
    return {
      id: drInt(row.id),
      sire: drInt(row.sire), dam: drInt(row.dam),
      sireName: str(row.sireName), damName: str(row.damName),
      species: str(row.species),
      started: drNum(row.started, 0),
      dueGameTime: drNum(row.dueGameTime, 0),
      dueInDays: Math.max(0, drNum(row.dueInDays, 0)),
    };
  }).filter((p) => p.id || p.sire || p.dam);

  /* ── the collection ────────────────────────────────────────────────────
   * "How many do I own" is an inventory question the roster answers. "Have I
   * EVER had one" is the collection question, and only the ever-owned SET can
   * answer it — a dragon that died took the fact that you had it with it.
   *
   * The fraction's two halves must describe the same list, which is exactly the
   * trap roost.cpp CollectionJson() calls out: its own `collected` counts species
   * whose plugin has since left the load order, and the panel's M comes from the
   * LIVE registry. So `collected` here is counted against `species` — the two
   * halves agree by construction — and `collectedAll` reports the raw set size
   * beside it rather than silently disagreeing with the headline. */
  const collSrc = (body.collection && typeof body.collection === 'object') ? body.collection : body;
  const everRaw = drList(collSrc.everOwned, 'everOwned');
  const ever = Object.create(null);
  for (const k of everRaw) { const c = drCanonKey(k); if (c) ever[c] = true; }
  let collected = 0;
  for (const s of species) {
    if (s.owned === undefined) s.owned = !!(s.canon && ever[s.canon]);
    if (s.owned) collected++;
  }
  // A publisher that shipped no everOwned[] at all, but per-row owned flags,
  // still gets a correct headline — and one that shipped neither reads 0 of N,
  // which is the truth about a save where nothing has hatched.
  const collectedAll = Object.keys(ever).length;

  const hdr = (body.header && typeof body.header === 'object') ? body.header : body;
  /* PortalLink spells the debug switch `admin` and the write stamp `writtenAt`;
     the first draft of this reader guessed `adminMode` / `written`. Both are
     accepted, and an absent one stays ABSENT — a switch drawn from a fact nobody
     published would be a switch that lies about the game's state. */
  const boolOf = function () {
    for (const k of arguments) if (typeof hdr[k] === 'boolean') return hdr[k];
    return undefined;
  };
  const numOf = function () {
    for (const k of arguments) if (typeof hdr[k] === 'number') return hdr[k];
    return undefined;
  };
  const when = numOf('gameTime', 'now');
  return {
    header: {
      schema: drInt(hdr.schema !== undefined ? hdr.schema : hdr.version),
      mod: str(hdr.mod) || 'Dragon Roost',
      modVersion: str(hdr.modVersion) || str(hdr.version_str),
      gameTime: when,
      // PortalLink publishes absolute game DAYS as `gameTime` and no separate day
      // number, so the one the header chip shows is derived here rather than
      // making the view do arithmetic to render a label.
      gameDay: numOf('gameDay') !== undefined ? numOf('gameDay')
        : (when !== undefined ? Math.floor(when) : undefined),
      timescale: numOf('timescale'),
      // Whether a save is actually loaded. `false` is the resting answer at the
      // main menu, and it is the honest reason a queued command has not applied.
      inGame: boolOf('inGame'),
      paused: boolOf('paused'),
      gateOpen: boolOf('gateOpen'),
      adminMode: boolOf('admin', 'adminMode', 'debug', 'testMode'),
      written: numOf('writtenAt', 'written'),
      writes: numOf('writes'),
      stateHash: str(hdr.stateHash) || undefined,
      /* What the game has actually DONE with the queue. This is the only evidence
         the phone has that the other end is alive and eating, so it is carried
         through verbatim rather than summarised away. */
      commands: (body.commands && typeof body.commands === 'object') ? {
        applied: drInt(body.commands.applied),
        rejected: drInt(body.commands.rejected),
        lastBatch: drInt(body.commands.lastBatch),
        lastAppliedAt: drInt(body.commands.lastAppliedAt),
      } : undefined,
    },
    /* Breath families, when the publisher ships them (PortalLink does:
       Breath::Json() → { families:[{key,label,minTier,maxTier,count}], breaths:[] }).
       Absent = the phone simply does not draw a breath picker. */
    breaths: (function () {
      const b = body.breaths;
      const fams = drList(b && b.families !== undefined ? b.families : b, 'families');
      return fams.map((f) => ({
        key: str(f && f.key), label: str(f && f.label) || str(f && f.key),
        minTier: drInt(f && f.minTier), maxTier: drInt(f && f.maxTier), count: drInt(f && f.count),
      })).filter((f) => f.key);
    })(),
    species, skins, dragons, eggs, pairs,
    collection: { collected, total: species.length, collectedAll },
  };
}

/** The URL the phone loads a game-written PNG through. View-relative in, and
 *  a query-string route out — never a path segment, so the confine below is the
 *  only thing that decides what may be read. */
function drPortraitUrl(rel) {
  return '/api/dragon-image?p=' + encodeURIComponent(rel);
}

/* ------------------- which key names the picture ---------------------- *
 *  The C++ that writes a portrait file name into each species / skin / dragon
 *  row was being written at the same hour as this reader, so the KEY it uses
 *  was not settled when this shipped. Guessing one and being wrong is the
 *  exact seam that has broken three times in this project (`admin` vs
 *  `adminMode`, `writtenAt` vs `written`, `dragonId` vs `id`), and each time
 *  the symptom was a silently empty pane rather than an error anyone could
 *  read.
 *
 *  So a SMALL, closed set of plausible spellings is accepted, first one that
 *  carries a value wins, and /api/health reports which one was actually found
 *  — so the answer to "why are there no pictures" is one curl away instead of
 *  a C++ read. The set is deliberately not open-ended: an unknown key stays
 *  unknown, it does not become a path. */
const DR_PORTRAIT_KEYS = ['portrait', 'image', 'png', 'portraitFile', 'render'];
/** {key: rows that used it} for the LAST document normalised. Rebuilt on every
 *  read so it always describes what is on disk now, never what once was. */
let drPortraitKeysSeen = Object.create(null);

/** The portrait file a row names, under whichever key it chose. '' when none. */
function drPortraitOf(row) {
  for (const k of DR_PORTRAIT_KEYS) {
    const v = str(row && row[k]);
    if (v) { drPortraitKeysSeen[k] = (drPortraitKeysSeen[k] || 0) + 1; return v; }
  }
  return '';
}
/** The two fields a row gains when it names a picture — and NOTHING when it
 *  does not, because "not rendered yet" is the honest majority state here and
 *  an empty string would render as a broken <img>. */
function drPortraitFields(row) {
  const rel = drPortraitOf(row);
  return rel ? { portrait: rel, portraitUrl: drPortraitUrl(rel) } : {};
}

/* Same trick as confineView(): each segment must START with an alphanumeric,
 * which makes "..", "." and "" structurally impossible rather than filtered.
 * Both roots are tried, overwrite first — MO2's own precedence. */
const DR_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
function drConfineImage(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  if (segs.length > 4) return null;
  for (const s of segs) if (!DR_SEG_RE.test(s)) return null;
  if (!DR_IMG_EXTS.includes(normExt(path.extname(rel)))) return null;
  /* A row may name its picture either way round — "portraits/skin_12.png" (a
   * path relative to the view, which is the only kind Ultralight will load) or
   * the BARE "skin_12.png" (which is what a writer thinking in terms of "the
   * portraits folder" naturally emits). Both are tried, as-given first, so the
   * publisher gets to be right either way. The segments were already validated
   * above, and "portraits" is a literal here — neither candidate can be
   * steered by the request. */
  const tries = segs.length === 1 ? [segs, ['portraits'].concat(segs)] : [segs];
  for (const base of DR_PORTRAIT_ROOTS) {
    for (const parts of tries) {
      const abs = path.resolve(base, parts.join(path.sep));
      const root = path.resolve(base) + path.sep;
      if (!abs.startsWith(root)) continue;
      try { if (fs.statSync(abs).isFile()) return abs; } catch (_) { /* next candidate */ }
    }
  }
  return null;
}

/* ========================= thumbnails ================================= *
 *  393 skins and 251 species, each a 1024×1024 render, is several hundred MB
 *  of PNG. A phone asked to load even the 80 rows one page shows would spend
 *  its afternoon on it — so every grid asks for `&w=160` and gets a real,
 *  small PNG back, and a hero view asks for `&w=640`.
 *
 *  Done with zlib alone. This server has no dependencies and is not growing
 *  one for a box filter: decode the PNG, average pixels down, re-encode.
 *  ANYTHING it cannot decode — interlaced, 16-bit, 1/2/4-bit, a JPEG, a file
 *  over the size cap, a corrupt chunk — makes drThumb return null and the
 *  route serves the ORIGINAL bytes. A slow picture is a far better failure
 *  than a broken one, and there is no case where a thumbnail failure hides
 *  an image that exists.
 *
 *  Results are cached on disk under the OS temp dir, keyed by
 *  (path, mtime, size, width) — so a re-render under a new name is a new key
 *  and can never serve the old picture, and clearing the cache is `rm -rf`.
 * ======================================================================= */

const DR_THUMB_DIR = path.join(os.tmpdir(), 'deck-portal-dragon-thumbs');
/* A closed ladder of widths, not a free number: an open ?w= would let one
   request mint an unbounded number of cache entries and CPU-bound decodes. */
const DR_THUMB_WIDTHS = [96, 160, 256, 400, 640];
const DR_THUMB_MAX_SRC = 32 * 1024 * 1024;   // bigger than this, don't even decode
const DR_THUMB_MAX_PX = 40 * 1024 * 1024;    // 40 MP guard on a declared IHDR

/** The width we will actually mint for a request, or 0 for "serve original". */
function drThumbWidth(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) return 0;
  for (const w of DR_THUMB_WIDTHS) if (n <= w) return w;
  return 0;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Parse the chunks we care about. null = "not a PNG we can handle", which is
 *  a normal answer and never an error. */
function pngRead(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47 || buf.readUInt32BE(4) !== 0x0D0A1A0A) return null;
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > buf.length || off + 12 + len > buf.length) return null;
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) return null;
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], comp: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || !idat.length) return null;
  if (ihdr.interlace !== 0 || ihdr.comp !== 0 || ihdr.filter !== 0) return null;
  if (ihdr.depth !== 8) return null;                      // 16-bit / sub-byte: rare from a renderer
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!ch) return null;
  if (ihdr.color === 3 && !plte) return null;
  if (!(ihdr.w > 0 && ihdr.h > 0) || ihdr.w * ihdr.h > DR_THUMB_MAX_PX) return null;
  return { ihdr, ch, plte, trns, idat: Buffer.concat(idat) };
}

/** Undo the per-scanline filters. Returns the packed sample rows, or null if
 *  the stream is short or names a filter type PNG does not have. */
function pngUnfilter(px, ihdr, ch) {
  const stride = ihdr.w * ch;
  if (px.length < (stride + 1) * ihdr.h) return null;
  const out = Buffer.allocUnsafe(stride * ihdr.h);
  let p = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const ft = px[p++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    px.copy(row, 0, p, p + stride);
    p += stride;
    if (ft === 0) continue;
    if (ft === 1) { for (let i = ch; i < stride; i++) row[i] = (row[i] + row[i - ch]) & 255; continue; }
    if (ft === 2) { if (prev) for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 255; continue; }
    if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0, b = prev ? prev[i] : 0;
        row[i] = (row[i] + ((a + b) >> 1)) & 255;
      }
      continue;
    }
    if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0;
        const b = prev ? prev[i] : 0;
        const c = (prev && i >= ch) ? prev[i - ch] : 0;
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
      continue;
    }
    return null;
  }
  return out;
}

/** Every colour type flattened to straight RGBA, so the box filter below has
 *  exactly one layout to think about. */
function pngToRgba(raw, ihdr, ch, plte, trns) {
  const n = ihdr.w * ihdr.h;
  const out = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * ch, o = i * 4;
    let r, g, b, a = 255;
    if (ihdr.color === 6) { r = raw[s]; g = raw[s + 1]; b = raw[s + 2]; a = raw[s + 3]; }
    else if (ihdr.color === 2) { r = raw[s]; g = raw[s + 1]; b = raw[s + 2]; }
    else if (ihdr.color === 0) { r = g = b = raw[s]; }
    else if (ihdr.color === 4) { r = g = b = raw[s]; a = raw[s + 1]; }
    else {
      const ix = raw[s] * 3;
      r = plte[ix]; g = plte[ix + 1]; b = plte[ix + 2];
      if (trns && raw[s] < trns.length) a = trns[raw[s]];
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return out;
}

/** Box average — every source pixel contributes to exactly one destination
 *  pixel, which is what keeps a 6× reduction from aliasing into noise. */
function rgbaBox(src, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sh / dh);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sw / dw);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++) { r += src[p]; g += src[p + 1]; b += src[p + 2]; a += src[p + 3]; p += 4; n++; }
      }
      const o = (y * dw + x) * 4;
      out[o] = (r / n) | 0; out[o + 1] = (g / n) | 0; out[o + 2] = (b / n) | 0; out[o + 3] = (a / n) | 0;
    }
  }
  return out;
}

/** RGBA → the raw pre-deflate scanlines. Filter 1 (Sub) throughout: a render
 *  is mostly smooth horizontal gradient, which is precisely what Sub flattens,
 *  and picking per row would cost more time than the bytes are worth here. */
function pngScanlines(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 1;
    const s = y * stride;
    for (let i = 0; i < stride; i++) raw[p + i] = (rgba[s + i] - (i >= 4 ? rgba[s + i - 4] : 0)) & 255;
    p += stride;
  }
  return raw;
}

function pngChunk(type, data) {
  const b = Buffer.allocUnsafe(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

function pngAssemble(deflated, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                    // 8-bit RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflated), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const inflateAsync = (b) => new Promise((ok, no) => zlib.inflate(b, (e, r) => (e ? no(e) : ok(r))));
const deflateAsync = (b) => new Promise((ok, no) => zlib.deflate(b, { level: 6 }, (e, r) => (e ? no(e) : ok(r))));

/* Two cards scrolling into view at once must not decode the same 1024×1024
   twice; the second one waits on the first. */
const drThumbInFlight = Object.create(null);

/** A `want`-px-wide PNG of `abs`, or null to mean "serve the original". */
function drThumb(abs, want) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return Promise.resolve(null); }
  if (!st.isFile() || st.size > DR_THUMB_MAX_SRC) return Promise.resolve(null);
  const tag = crypto.createHash('sha1')
    .update(abs + '|' + st.mtimeMs + '|' + st.size + '|' + want).digest('hex').slice(0, 24);
  const cached = path.join(DR_THUMB_DIR, tag + '.png');
  try { if (fs.statSync(cached).isFile()) return Promise.resolve(fs.readFileSync(cached)); } catch (_) { /* mint it */ }
  if (drThumbInFlight[tag]) return drThumbInFlight[tag];

  const job = (async () => {
    const src = fs.readFileSync(abs);
    const png = pngRead(src);
    if (!png) return null;
    // Already at or under the size asked for: re-encoding it would only cost
    // quality and time. The original IS the thumbnail.
    if (png.ihdr.w <= want) return null;
    const raw = pngUnfilter(await inflateAsync(png.idat), png.ihdr, png.ch);
    if (!raw) return null;
    const rgba = pngToRgba(raw, png.ihdr, png.ch, png.plte, png.trns);
    const dw = want;
    const dh = Math.max(1, Math.round(png.ihdr.h * want / png.ihdr.w));
    const out = pngAssemble(await deflateAsync(pngScanlines(rgbaBox(rgba, png.ihdr.w, png.ihdr.h, dw, dh), dw, dh)), dw, dh);
    // Cache best-effort: a temp dir we cannot write to costs us the cache, not
    // the picture.
    try {
      if (ensureDir(DR_THUMB_DIR)) {
        const tmp = cached + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, out);
        renameWithRetry(tmp, cached);
      }
    } catch (_) { /* the bytes are already made; serving them is what matters */ }
    return out;
  })().catch((e) => { log('thumbnail failed (' + path.basename(abs) + ' @' + want + '): ' + e.message); return null; });

  drThumbInFlight[tag] = job;
  job.then(() => { delete drThumbInFlight[tag]; }, () => { delete drThumbInFlight[tag]; });
  return job;
}

/* ---------------------------- the queue file --------------------------- */

/** Parsed queue, always usable: a malformed file reads as empty + flagged,
 *  exactly like every other sidecar here. Unknown ops are DROPPED on read
 *  rather than kept — a queue this file cannot describe is one the phone
 *  cannot show or clear, and an op the game will not understand is worse
 *  than no op. */
function drReadQueue() {
  let raw;
  try { raw = fs.readFileSync(drQueueFile(), 'utf8'); }
  catch (_) { return { list: [], exists: false, malformed: false }; }
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (_) { return { list: [], exists: true, malformed: true }; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.ops)) {
    return { list: [], exists: true, malformed: true };
  }
  const out = [];
  for (const e of j.ops) {
    const rec = drCheckOp(e);
    /* `qid` — NOT `id`. `id` on the wire is the DRAGON's id (PortalLink::ParseOp
       reads it for summon / store / rename / skin / breath), so the portal's own
       handle for a queued row has to live under a different key or it silently
       overwrites the dragon it was about. It did, exactly once, before this. */
    if (rec) { if (typeof e.qid === 'string' && e.qid) rec.qid = e.qid.slice(0, 40); out.push(rec); }
  }
  return { list: out, exists: true, malformed: false };
}

/** Which of OUR kinds a payload names.
 *
 *  `kind` is ours — it names the row in the pending list and picks the spec.
 *  `op` is the DLL's wire verb, and TWO wire verbs are ambiguous: `hatch` is
 *  an egg or a species depending on which key is present (exactly as ParseOp
 *  decides it), and `render` is a skin or a species the same way. A queue file
 *  written by an older portal carries only `op`, so the kind is re-derived
 *  from the payload. Shared by drCheckOp AND the POST route — they used to
 *  each decide this, and the route's copy did not know about `render`, so a
 *  perfectly good single render was rejected while a batch of them went
 *  through. One function now, one answer. */
function drKindOf(e) {
  if (!e || typeof e !== 'object') return '';
  if (typeof e.kind === 'string' && DR_OPS[e.kind]) return e.kind;
  const wire = typeof e.op === 'string' ? e.op : '';
  if (wire === 'hatch') return (e.egg === undefined && e.species !== undefined) ? 'hatchSpecies' : 'hatch';
  if (wire === 'render') return (e.skin !== undefined) ? 'renderSkin' : 'renderSpecies';
  return wire;
}

/** Validate + normalise one op. Returns null when it is not something the game
 *  was ever going to understand. Shared by the read path and the POST route, so
 *  a queued op and an accepted op can never disagree about what is legal. */
function drCheckOp(e) {
  if (!e || typeof e !== 'object') return null;
  // `kind` is OURS — it names the row in the pending list and picks the spec.
  // `op` is the DLL's wire verb, and two of our kinds share one ("hatch" is an
  // egg or a species depending on which key is present, exactly as ParseOp
  // decides it). A queue file written by an older portal carries only `op`, so
  // fall back to it and re-derive the kind from the payload.
  const kind = drKindOf(e);
  const spec = DR_OPS[kind];
  if (!spec) return null;
  const rec = { op: spec.wire || kind };
  if (rec.op !== kind) rec.kind = kind;
  for (const k of (spec.needs || [])) {
    const n = drInt(e[k]);
    if (!n) return null;                 // 0 is not a dragon/egg/pair id
    // An egg id is OPAQUE to the DLL — Eggs matches the string, never a number —
    // so it goes on the wire as text even though we validated it as a number.
    rec[k] = (spec.numeric === false) ? String(n) : n;
  }
  if (spec.text) {
    const raw = typeof e[spec.text] === 'string' ? e[spec.text].trim() : '';
    // "" is a real INSTRUCTION for skin and breath (back to automatic), so it is
    // never tested for truthiness to decide whether it was sent. `rename` is the
    // opposite: the DLL refuses an empty name, so we refuse it here too rather
    // than queueing a command that is only ever going to be rejected.
    if (!raw && !spec.emptyOk) return null;
    rec[spec.text] = raw.slice(0, (spec.text === 'skin' || spec.text === 'species') ? DR_KEY_MAX : DR_NAME_MAX);
    if (spec.text === 'skin' && rec.skin && !DR_KEY_RE.test(rec.skin)) return null;
    if (spec.text === 'species' && !DR_KEY_RE.test(rec.species)) return null;
    // A closed vocabulary field (renderAll's `what`) must be one of the words
    // the game knows; anything else would queue a row that can only be ignored.
    if (spec.enum && spec.enum.indexOf(rec[spec.text]) < 0) return null;
  }
  /* A subject key that is NOT itself the thing being made — it names one row
     inside `what`. TWO shapes are legal because the three families spell a
     subject differently: a species and a skin are durable form keys
     ("Plugin.esp|0xABCDEF"), a dragon is the numeric id the roster hands out.
     Anything else addresses nothing, so it is refused here rather than queued
     as a row the game can only ignore. Required — an op that names a family
     but no member is not a command. */
  if (spec.keyed) {
    const v = e[spec.keyed];
    const raw = typeof v === 'string' ? v.trim()
      : (typeof v === 'number' && isFinite(v) ? String(Math.round(v)) : '');
    if (!raw) return null;
    const k = raw.slice(0, DR_KEY_MAX);
    // A dragon id is small and positive; roost.cpp mints them from 1 upward.
    if (!DR_KEY_RE.test(k) && !/^[1-9][0-9]{0,9}$/.test(k)) return null;
    rec[spec.keyed] = k;
  }
  if (spec.also && typeof e[spec.also] === 'string' && e[spec.also].trim()) {
    rec[spec.also] = e[spec.also].trim().slice(0, DR_NAME_MAX);
  }
  if (spec.bool) rec[spec.bool] = !!e[spec.bool];
  if (rec.op === 'breed' && rec.sire === rec.dam) return null;   // roost.cpp refuses it too
  if (typeof e.queuedAt === 'number' && isFinite(e.queuedAt)) rec.queuedAt = Math.round(e.queuedAt);
  // Labels are for the PHONE's pending list only — the game ignores them. They
  // exist so a queued op can say "Summon Ysgramor's Bane" after a reload,
  // without the phone having to re-join it against a roster that may since have
  // changed underneath it.
  if (typeof e.label === 'string' && e.label) rec.label = e.label.slice(0, 120);
  return rec;
}

/** What makes two ops "the same command" for dedupe. See DR_OPS. */
function drDedupeKey(rec) {
  const kind = rec.kind || rec.op;
  const spec = DR_OPS[kind];
  if (!spec) return null;
  switch (spec.dedupe) {
    // `group` folds opposites together: summon and store are one decision about
    // one dragon, and queueing both would let the tick's ordering pick a winner.
    // Everything else on a dragon is per-verb — a rename and a skin are two
    // independent facts about the same animal and must both survive.
    case 'dragon': return (spec.group || kind) + '\n' + rec.id;
    case 'egg': return 'hatch\n' + rec.egg;
    case 'species': return 'hatchSpecies\n' + rec.species;
    case 'pair': return 'pair\n' + rec.pair;
    case 'breed': return 'breed\n' + rec.sire + '\n' + rec.dam;
    // One render request per subject — tapping ⟳ twice is one job, not two.
    case 'renderSkin': return 'render\nskin\n' + rec.skin;
    case 'renderSpecies': return 'render\nspecies\n' + rec.species;
    case 'renderAll': return 'renderAll\n' + rec.what;
    /* One turntable per SUBJECT — eight frames is one job however many times
       the picture is dragged. Canonicalised for the same reason drCanonKey
       exists at all: one species genuinely arrives spelled three ways, and two
       spellings would queue the same render twice. */
    case 'spin': return 'spin\n' + rec.what + '\n' + drCanonKey(rec.key);
    case 'single': return kind;
    default: return null;
  }
}

function drWriteQueue(list) {
  const file = drQueueFile();
  if (!ensureDir(path.dirname(file))) {
    throw Object.assign(new Error('Cannot create ' + path.dirname(file)), { code: 500 });
  }
  /* `kind` is stripped on the way out: it is the portal's own label for a row and
     the DLL's parser has no key for it. `label`/`id`/`queuedAt` it explicitly
     ignores, so those stay — they are what lets the phone show and drop one
     command after a reload. */
  const wire = list.map((o) => { const c = Object.assign({}, o); delete c.kind; return c; });
  // `qid` and `label` are ours and the DLL ignores both; `kind` above is stripped
  // because it would read as a stray key in a file whose whole point is a contract.
  const body = JSON.stringify({ version: 1, ops: wire }, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  renameWithRetry(tmp, file);            // atomic — the game can never read a half-written queue
}

/** Queue one op, replacing any op it supersedes. Returns the new list. */
function drQueueOp(rec) {
  const cur = drReadQueue();
  const key = drDedupeKey(rec);
  let list = key ? cur.list.filter((e) => drDedupeKey(e) !== key) : cur.list.slice();
  rec.qid = 'q' + Math.random().toString(36).slice(2, 8) + (Date.now() % 100000).toString(36);
  if (!rec.queuedAt) rec.queuedAt = Math.floor(Date.now() / 1000);
  list.push(rec);
  if (list.length > DR_QUEUE_MAX) list.splice(0, list.length - DR_QUEUE_MAX);
  drWriteQueue(list);
  return list;
}

/** Queue SEVERAL ops in one write. "Render the 40 skins this filter shows" is
 *  one intention, and it must be one file write: forty POSTs would be forty
 *  read-modify-writes of a file the game is polling, and a half-applied batch
 *  if the phone lost Wi-Fi in the middle. Dedupe still applies within the batch
 *  and against what is already queued, so a repeat tap is idempotent. */
function drQueueOps(recs) {
  const cur = drReadQueue();
  let list = cur.list.slice();
  const stamp = Math.floor(Date.now() / 1000);
  for (const rec of recs) {
    const key = drDedupeKey(rec);
    if (key) list = list.filter((e) => drDedupeKey(e) !== key);
    rec.qid = 'q' + Math.random().toString(36).slice(2, 8) + (Date.now() % 100000).toString(36) + list.length.toString(36);
    if (!rec.queuedAt) rec.queuedAt = stamp;
    list.push(rec);
  }
  if (list.length > DR_QUEUE_MAX) list.splice(0, list.length - DR_QUEUE_MAX);
  drWriteQueue(list);
  return list;
}

/** Drop one queued op by its portal-minted id, or every one of them. */
function drClearQueue(id) {
  const cur = drReadQueue();
  const list = id ? cur.list.filter((e) => e.qid !== id) : [];
  drWriteQueue(list);
  return list;
}

/* ------------------------------- the view ------------------------------ */

/** Everything the Dragon Roost tab needs, in one request.
 *
 *  ok is TRUE even with nothing published — see the header. `waiting` is the
 *  flag the view renders its "launch the game once" state from, and it is a
 *  first-class answer rather than an error, because it is what the player will see
 *  first and for as long as the DLL half is unfinished. */
function readRoost() {
  const found = drFindStatus();
  const pend = drReadQueue();
  const base = {
    ok: true,
    statusFile: found ? found.file : null,
    statusMtime: found ? Math.floor(found.mtimeMs / 1000) : 0,
    queueFile: drQueueFile(),
    queueExists: DR_QUEUE_CANDIDATES.some((f) => { try { return fs.statSync(f).isFile(); } catch (_) { return false; } }),
    candidates: DR_STATUS_CANDIDATES,
    pending: pend.list.length,
    pendingMalformed: pend.malformed,
    ops: pend.list,
  };
  if (!found || !found.json) {
    return Object.assign(base, {
      waiting: true,
      // A file that EXISTS and will not parse is a different problem from one
      // that was never written, and saying so is the difference between "launch
      // the game" and "the publisher is broken".
      error: found ? found.error : null,
      header: {}, species: [], skins: [], dragons: [], eggs: [], pairs: [], breaths: [],
      collection: { collected: 0, total: 0, collectedAll: 0 },
    });
  }
  return Object.assign(base, { waiting: false, error: null }, drNormalise(found.json));
}

function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + t + '] ' + msg);
}

/* ============================ AUTHENTICATION ============================ *
 *  Only ever engaged when the bind is EXPOSED (see resolveBind). On the
 *  default loopback bind none of this runs: the only thing that can reach the
 *  socket is the machine the game is on, so there is nobody to authenticate.
 *
 *  When it IS engaged:
 *    * A request from loopback is still allowed without a password. The deck's
 *      own Portal button opens 127.0.0.1 on the same machine, and anything
 *      that can make a loopback connection already has local access — a
 *      password there would buy nothing and cost the button.
 *    * Anything else needs a session cookie, obtained by posting the password
 *      once. The cookie is HMAC-signed with a key DERIVED FROM THE PASSWORD,
 *      so there is no key to store and changing the password instantly
 *      invalidates every device that was signed in. Nothing is written to disk.
 *
 *  Deliberately a plain password form, not a QR code or a token in the URL: a
 *  URL token lives forever in browser history and in any screenshot of the
 *  address bar, and this path is the advanced opt-in anyway — typed once per
 *  device, then remembered for a year.
 * ======================================================================= */

const SESSION_COOKIE = 'deckportal';
const SESSION_DAYS = 365;

function sessionKey() {
  return crypto.createHash('sha256').update('deck-portal|v1|' + PORTAL_PASSWORD).digest();
}

function signSession(expMs) {
  const mac = crypto.createHmac('sha256', sessionKey()).update(String(expMs)).digest('hex');
  return String(expMs) + '.' + mac;
}

function verifySession(value) {
  const s = String(value || '');
  const dot = s.indexOf('.');
  if (dot < 1) return false;
  const exp = s.slice(0, dot);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = Buffer.from(signSession(Number(exp)));
  const got = Buffer.from(s);
  // Length check first: timingSafeEqual THROWS on a length mismatch, and an
  // exception here would be a 500 instead of a clean "not signed in".
  if (want.length !== got.length) return false;
  try { return crypto.timingSafeEqual(want, got); } catch (_) { return false; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  String(raw).split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

/* Constant-time password compare. Hash both sides first so the comparison is
 * over fixed-length digests — otherwise the length of the attempt leaks the
 * length of the password through timingSafeEqual's own length rule. */
function passwordMatches(attempt) {
  if (!PORTAL_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(attempt || '')).digest();
  const b = crypto.createHash('sha256').update(PORTAL_PASSWORD).digest();
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deck Portal</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#101015;color:#e8e4da;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
 form{background:#16161d;border:1px solid #2e2e36;border-radius:12px;padding:28px 26px;
      width:min(360px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.4)}
 h1{margin:0 0 6px;font-size:20px;color:#c9a24b}
 p{margin:0 0 20px;font-size:14px;color:#8b8678}
 input{width:100%;box-sizing:border-box;font:inherit;font-size:17px;color:#e8e4da;
       background:#0c0c10;border:1px solid #2e2e36;border-radius:9px;padding:13px 14px}
 input:focus{outline:none;border-color:#c9a24b;box-shadow:0 0 0 2px rgba(201,162,75,.16)}
 button{width:100%;margin-top:14px;font:inherit;font-size:17px;font-weight:600;
        color:#1a1a21;background:#c9a24b;border:0;border-radius:9px;padding:13px;cursor:pointer}
 button:active{transform:translateY(1px)}
 .err{margin-top:14px;font-size:14px;color:#d4756a}
</style>
<form method="POST" action="/api/login">
  <h1>Deck Portal</h1>
  <p>This portal is reachable over the network, so it needs the password from your
     <code>DECK_PORTAL_PASSWORD</code> setting. You only do this once per device.</p>
  <input type="password" name="password" autocomplete="current-password" autofocus
         placeholder="Password" aria-label="Password">
  <button type="submit">Unlock</button>
  __ERR__
</form>`;

function sendLogin(res, code, err) {
  const body = LOGIN_HTML.replace('__ERR__', err ? '<div class="err">' + err + '</div>' : '');
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Read a urlencoded or JSON body, capped — the login route runs BEFORE auth,
 *  so it must never be a way to make the process eat memory. */
function readSmallBody(req, cap) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > cap) { try { req.destroy(); } catch (_) {} resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** true = the request may proceed. Otherwise this function has already
 *  answered (login page, redirect, or 401) and the caller must stop. */
async function gateRequest(req, res, url) {
  if (!EXPOSED) return true;                              // loopback bind: nothing to gate
  if (isLoopbackAddr(req.socket && req.socket.remoteAddress)) return true;

  const path = url.pathname;

  if (path === '/api/login') {
    if (req.method !== 'POST') { sendLogin(res, 405, null); return false; }
    const body = await readSmallBody(req, 4096);
    let attempt = '';
    try {
      attempt = body.trim().startsWith('{')
        ? String(JSON.parse(body).password || '')
        : String(new URLSearchParams(body).get('password') || '');
    } catch (_) { attempt = ''; }
    if (!passwordMatches(attempt)) {
      log('login FAILED from ' + (req.socket && req.socket.remoteAddress));
      sendLogin(res, 401, 'That password is not right.');
      return false;
    }
    const exp = Date.now() + SESSION_DAYS * 86400000;
    log('login ok from ' + (req.socket && req.socket.remoteAddress));
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': SESSION_COOKIE + '=' + signSession(exp) +
        '; Path=/; Max-Age=' + (SESSION_DAYS * 86400) + '; HttpOnly; SameSite=Lax',
    });
    res.end();
    return false;
  }

  if (verifySession(parseCookies(req)[SESSION_COOKIE])) return true;

  // An unauthenticated API call gets JSON, not a login PAGE — the phone UI
  // fetches these and a chunk of HTML in a JSON parser is a confusing crash
  // rather than a clear "sign in again".
  if (path.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'Not signed in', login: '/' }));
    return false;
  }
  sendLogin(res, 401, null);
  return false;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (_) { sendErr(res, 400, 'Bad request URL'); return; }

  // Traversal guard on the RAW request target, not url.pathname.
  // Node's WHATWG URL parser silently resolves "/api/portrait/../../x" to
  // "/x" — safe, but it would turn a deliberate attack into a bland 404 and
  // hide it from the log. Inspect what the client actually sent, and decode
  // once so "%2e%2e%2f" is caught by the same test.
  const rawPath = String(req.url || '').split('?')[0];
  let rawDecoded = rawPath;
  try { rawDecoded = decodeURIComponent(rawPath); } catch (_) { sendErr(res, 400, 'Bad percent-encoding in path'); return; }
  if (rawDecoded.includes('..') || rawDecoded.includes('\\') || rawDecoded.includes('\0')) {
    log('rejected traversal attempt: ' + req.method + ' ' + req.url);
    sendErr(res, 400, 'Path traversal is not allowed');
    return;
  }

  Promise.resolve()
    // Auth runs BEFORE the router, so a new endpoint is protected the day it
    // is added rather than the day somebody remembers to protect it.
    .then(() => gateRequest(req, res, url))
    .then((allowed) => { if (allowed) return route(req, res, url); })
    .catch((e) => {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      const code = e && e.code === 413 ? 413 : (typeof e?.code === 'number' ? e.code : 500);
      log('ERROR ' + req.method + ' ' + req.url + ' → ' + (e && e.message));
      sendErr(res, code, (e && e.message) || 'Internal error');
    });
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
});

ensureDir(PORTRAIT_DIR);
ensureDir(ICON_DIR);
ensureDir(DECK_ICON_DIR);   // the deck view's half of the pool + its sidecar
ensureDir(DOMAIN_IMG_DIR);  // one image per marked domain, drawn by the Domains tab

server.listen(PORT, BIND, () => {
  log('Deck Portal listening on http://' + BIND + ':' + PORT + '/');
  log(EXPOSED
    ? '  REACHABLE FROM THE NETWORK — password required (loopback exempt)'
    : '  this machine only (127.0.0.1) — no password needed, nothing exposed');
  log('  portraits → ' + PORTRAIT_DIR);
  log('  icons     → ' + ICON_DIR);
  log('  hk icons  → ' + DECK_ICON_DIR + (fs.existsSync(DECK_ICON_DIR) ? '' : '  (MISSING)'));
  log('  roster    → ' + FO_JSON);
  const r = readRoster();
  log(r.ok
    ? '  roster parsed: ' + r.categories.length + ' categories, ' + r.total + ' followers'
    : '  roster UNAVAILABLE: ' + r.error);
  r.warnings.forEach((w) => log('  warning: ' + w));
  log('  npc fields → ' + NPCF_FILE);
  if (r.pendingNpcFields)
    log('  ' + r.pendingNpcFields + ' NPC field edit(s) still pending — they apply the next time the Followers tab opens');
  if (r.pendingNpcFieldsMalformed)
    log('  warning: ' + NPCF_BASENAME + ' is malformed and is being treated as empty');
  if (r.pendingNpcUnknown && r.pendingNpcUnknown.length)
    log('  warning: ' + r.pendingNpcUnknown.length + ' pending field edit(s) name someone not in the roster: ' +
      r.pendingNpcUnknown.slice(0, 5).join(', '));
  const cfg = readHkRoot();          // one snapshot for both slices below
  const sp = spellsPayload(cfg);
  log('  deck cfg  → ' + (sp.hkJson || 'NOT FOUND (' + HK_JSON_CANDIDATES.join(' | ') + ')'));
  log(sp.ok
    ? '  spell deck: ' + sp.total + ' spells in ' + sp.categories.length + ' categories'
    : '  spell deck UNAVAILABLE: ' + sp.error);
  if (sp.pendingAssignments)
    log('  ' + sp.pendingAssignments + ' spell icon change(s) still pending — they apply within a second while the game runs, else on its next Spell Deck open');
  if (sp.pendingMalformed)
    log('  warning: ' + ASSIGN_BASENAME + ' is malformed and is being treated as empty');
  const hk = hotkeysPayload(cfg);
  log(hk.ok
    ? '  hotkeys:    ' + hk.total + ' entries in ' + hk.categories.length + ' categories'
    : '  hotkeys UNAVAILABLE: ' + hk.error);
  if (hk.pendingHotkeyIcons)
    log('  ' + hk.pendingHotkeyIcons + ' hotkey icon change(s) still pending — they apply within a second while the game runs, else on its next deck open');
  if (hk.pendingHotkeyIconsMalformed)
    log('  warning: ' + HKICON_BASENAME + ' is malformed and is being treated as empty');
  if (hk.pendingUnknown && hk.pendingUnknown.length)
    log('  warning: ' + hk.pendingUnknown.length + ' pending hotkey icon(s) name an entry that is no longer in the deck: ' +
      hk.pendingUnknown.slice(0, 5).join(', '));
  log('  hk edits  → ' + HKEDIT_FILE);
  if (hk.pendingHotkeyEdits) {
    const dels = readHotkeyEdits().list.filter((o) => o.op === 'delete').length;
    log('  ' + hk.pendingHotkeyEdits + ' hotkey edit(s) still pending' +
      (dels ? ' (' + dels + ' of them DELETE)' : '') +
      ' — they apply within a second while the game runs, else on its next deck open');
  }
  if (hk.pendingHotkeyEditsMalformed)
    log('  warning: ' + HKEDIT_BASENAME + ' is malformed and is being treated as empty');
  if (hk.pendingEditUnknown && hk.pendingEditUnknown.length)
    log('  warning: ' + hk.pendingEditUnknown.length + ' pending hotkey edit(s) name an entry that is no longer in the deck: ' +
      hk.pendingEditUnknown.slice(0, 5).join(', '));
  /* Dragon Roost — a different mod, so it gets its own two lines. "waiting" is
     printed as a plain fact, not a warning: until the DLL publishes its status
     file there is nothing to read, and that is the expected resting state. */
  const dr = readRoost();
  log('  roost     → ' + (dr.statusFile || 'waiting (no status file yet; tried ' + DR_STATUS_CANDIDATES.length + ' locations)'));
  log(dr.waiting
    ? '  dragon roost: waiting for the game to publish — launch Skyrim once with Dragon Roost enabled' +
      (dr.error ? ' (last candidate: ' + dr.error + ')' : '')
    : '  dragon roost: ' + dr.collection.collected + '/' + dr.collection.total + ' species collected · ' +
      dr.dragons.length + ' dragons · ' + dr.eggs.length + ' eggs · ' + dr.skins.length + ' skins');
  log('  roost queue → ' + drQueueFile() + (dr.queueExists ? '' : '  (not created yet — the game makes it on its next launch)'));
  if (dr.pending)
    log('  ' + dr.pending + ' dragon command(s) still queued — they apply on the game\'s next tick');
  if (dr.pendingMalformed)
    log('  warning: ' + DR_QUEUE_BASENAME + ' is malformed and is being treated as empty');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('Port ' + PORT + ' is already in use — is the portal already running? (set DECK_PORTAL_PORT to move it)');
    process.exit(1);
  }
  log('server error: ' + e.message);
  process.exit(1);
});
