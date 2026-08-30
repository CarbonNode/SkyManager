'use strict';
/* ================================ HDArt — one art module for every surface ================================
 *
 *  WHY THIS EXISTS.  Every new pane in this view has had the same bad first day: it draws
 *  its rows, no pictures appear, and the author then re-discovers — from scratch — that
 *  there are THREE unrelated art sources, each with its own bridge verb, its own index,
 *  its own key spelling and its own failure mode. Twenty files now carry twenty
 *  near-copies of that knowledge, and they have drifted: four different spell-icon
 *  ladders, three different formId spellings, nine icon sites with no error handling at
 *  all. HDArt is the single place that knows all of it. A new surface asks one question
 *  and gets a drawable answer; it never learns any of the history.
 *
 *  ------------------------------------------------------------------ THE THREE SOURCES
 *
 *   1. CUSTOM UPLOADS — `icons/custom/*`. Pictures the OWNER chose: picked in a deck icon
 *      picker, or uploaded from the Deck Portal. Always an explicit act of intent.
 *      Arrives as a pool listing (`hdIcons` / `mdIcons` / `hbIcons`) and as a per-thing
 *      path stored in config (entry.icon, slot.icon, catIcons, …). Needs no request.
 *
 *   2. MRF RENDERS — `icons/items/*`, `icons/npcs/*`, `icons/mounts/*`. The item's actual
 *      3-D model, an NPC's actual face, a creature's actual body, rendered on demand by
 *      C++ through the Mesh Rendering Framework. This is the only source that has to be
 *      ASKED for, is slow, lands one file at a time, and can permanently fail (a record
 *      with no world model has nothing to render). Render-once-keep-forever.
 *
 *   3. INTERFACE ICONS — `icons/sh/*` + `sh_index.json`, ~1,900 PNGs extracted from Spell
 *      Hotbar 2. Stock art for spells, shouts and powers, matched first by exact form and
 *      then by school/tier. Pushed once per session; needs no request.
 *
 *  ------------------------------------------------------------------ THE PRECEDENCE LAW
 *
 *      custom upload  >  MRF render  >  interface icon  >  glyph
 *
 *  Read it as: an explicit choice beats a picture of the real thing, which beats stock
 *  art for its category, which beats a letter. The owner picking an icon is a statement
 *  of intent and must never be overruled by something automatic; a render of THIS form
 *  is more specific than a generic icon for its school; and a glyph is never a failure,
 *  it is the honest bottom of the ladder. THIS ORDER IS THE RULE THE PANES GOT WRONG —
 *  several consulted only one source, so a thing with a perfectly good icon in another
 *  drew a letter. Do not reorder it locally; if a surface needs a different order, say so
 *  here.
 *
 *  ------------------------------------------------------------------ THE ULTRALIGHT LAWS
 *
 *   · A VIEW CANNOT ESCAPE ITS OWN FOLDER. `../MagicDeck/icons/x.png` from HotkeyDeck
 *     loads as naturalWidth 0 — measured in the engine. C++ writes a full icons/ tree
 *     into BOTH view roots for exactly this reason, so every path here is view-relative
 *     and means "my own icons folder" in whichever view renders it. `path()` refuses any
 *     `..`, absolute path, drive letter or scheme.
 *   · NEVER A `?v=` CACHE-BUST ON AN ICON. Ultralight's loader can treat the query as part
 *     of the FILENAME (proven in-game 2026-07-28), so the load just fails. `path()` STRIPS
 *     any query string rather than rejecting the path — a caller who adds one still gets
 *     the picture. That is the "impossible to get wrong" half of the rule. (Portraits and
 *     other REWRITABLE art legitimately use ?v= with a plain-path retry; that is a
 *     different lane and deliberately not handled here — see portraitSrc in followers-pane.)
 *   · AN UNCAUGHT ERROR AT LOAD TAKES THE WHOLE RENDERER DOWN, and PrismaUI shares one
 *     renderer across the deck, the hotbar and the HUD. Every entry point here is
 *     total: it catches, it never dereferences a caller's object without a guard, and it
 *     returns a drawable answer for literally any input.
 *   · A MISSING FILE MUST DEGRADE TO THE GLYPH, never to a broken-image box. Two idioms
 *     are needed and both ship here: `HDArt.ERR` (an inline onerror attribute, for
 *     innerHTML builders — the <img> is live the instant innerHTML is assigned and the
 *     engine can fail a cached miss BEFORE a listener attaches) and `HDArt.arm(root)`
 *     (a post-paint sweep for DOM builders, which also catches the already-failed case).
 *
 *  ------------------------------------------------------------------ THE ONE FORMID KEY
 *
 *  C++'s index key is `KeyOf(fid, plugin)` = the fid string UPPERCASED + '|' + plugin
 *  lowercased — it does not normalise the number, so `0x013989`, `013989` and `0001396B`
 *  are three different keys for one form, and the panes between them use all three.
 *  HDArt folds every key, inbound and outbound, to ONE dialect: 8-digit zero-padded upper
 *  hex, no 0x. Replies are re-keyed on arrival rather than trusted.
 *
 *  ⚠ But a REQUEST goes out spelling the formId exactly as the caller gave it. C++ derives
 *  the PNG filename from that string, so canonicalising the wire format would make every
 *  already-rendered file un-findable and re-render the world — the exact burst that froze
 *  the game. Canonical inside, verbatim on the wire.
 *
 *  ------------------------------------------------------------------ ASKING FOR RENDERS
 *
 *  Requesting is HDArt's job, not the pane's — that is where the freezes came from. Use a
 *  GROUP: declare what should have art and when you are visible, and the module owns the
 *  settle gate, the dedupe, the batch, the poll, the stalled-tick budget and the re-ask.
 *
 *      const art = HDArt.group('transmog', {
 *        visible: () => ui.visible,
 *        specs:   () => state.rows.map(rowSpec),   // the rows on screen right now
 *        onLand:  () => repaint(),
 *      });
 *      art.schedule();     // after any state/filter change — idempotent, settle-gated
 *      art.stop();         // on hide
 *
 *  Nothing is asked until the list has sat still (650 ms), nothing is asked twice, and a
 *  repaint can never re-ask for something already in flight. Those three properties are
 *  the whole reason this file exists.
 *
 *  IT WIRES ITSELF.  HDArt taps every icon reply C++ can push (wdItemIcons, nxIconsData,
 *  fdFaceIconsData, mtIconsData, hdIconIndex/mdIconIndex/hbIconIndex, hdIcons/mdIcons/
 *  hbIcons) with an accessor that forwards to whatever the owning pane registers, in
 *  either order. So a new surface gets a populated index for free — no bridge wiring, no
 *  load-order rule, and no existing consumer changes behaviour.
 *
 *  IDENTICAL IN BOTH VIEW ROOTS. `view/HotkeyDeck/hd-art.js` and `view/MagicDeck/hd-art.js`
 *  are byte-for-byte the same file (the roots cannot see each other, so it must be
 *  copied, not shared). Edit one, copy it over the other, in the same commit.
 *
 *  Marker: hd-art module.
 * ========================================================================================== */
(function () {
  if (window.HDArt) return;                    // one instance per view, whoever loads first

  /* ------------------------------------------------------------------ logging (never throws) */
  function log(line) {
    try {
      if (typeof window.hdLog === 'function') { window.hdLog('[hd-art] ' + line); return; }
      if (window.console && console.log) console.log('[hd-art] ' + line);
    } catch (e) { /* logging must never be the thing that breaks a view */ }
  }
  function toGame(verb, payload) {
    try {
      if (typeof window.toGame === 'function') return window.toGame(verb, payload);
      if (typeof window[verb] === 'function') return window[verb](payload);   // harness stub
    } catch (e) { log('bridge ' + verb + ' threw: ' + e); }
    return undefined;
  }

  /* =============================================================== paths ===================== */

  /* The ONE sanitiser. A path is usable only if it stays inside this view's own folder.
     A query string is STRIPPED, not rejected: Ultralight can fold "?v=1" into the
     filename, so a caller who adds a cache-bust would silently lose the picture — this
     makes that mistake impossible rather than merely illegal. */
  function safePath(p) {
    if (typeof p !== 'string') return '';   // a path is a string; anything else is a bug
    let s = p.replace(/\\/g, '/');
    if (!s) return '';
    const q = s.search(/[?#]/);
    if (q >= 0) s = s.slice(0, q);                 // ?v= / #frag can never reach the loader
    if (!s) return '';
    if (s.indexOf('..') !== -1) return '';         // no escaping the view dir
    if (s.charAt(0) === '/') return '';            // no server-absolute
    if (/^[A-Za-z]:/.test(s)) return '';           // no drive letters
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return '';   // no file:/http:/data: schemes
    while (s.slice(0, 2) === './') s = s.slice(2);
    return s;
  }

  /* =============================================================== keys ====================== */

  /* A form id arrives as either a hex STRING ("0x013989", "013989" — the item lanes) or a
     NUMBER whose value is the id (spell payloads carry `localId` numerically). Reading a
     number through parseInt(…, 16) reads its DECIMAL digits as hex and lands on a
     different form entirely — that is the whole interface lane missing, silently. */
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? (v >>> 0) : NaN;
    const n = parseInt(String(v == null ? '' : v).replace(/^0x/i, ''), 16);
    return isFinite(n) ? (n >>> 0) : NaN;
  }
  /* One formId dialect for every lane: 8 hex digits, zero-padded, UPPER, no 0x. */
  function canonHex8(v) {
    const n = toNum(v);
    if (!isFinite(n)) return '';
    return ('00000000' + n.toString(16).toUpperCase()).slice(-8);
  }
  /* Identity of a form, canonically. '' when the caller has not got one. */
  function keyOf(spec) {
    if (!spec) return '';
    const raw = (spec.formId != null && spec.formId !== '') ? spec.formId : spec.localId;
    if (raw == null || raw === '' || !spec.plugin) return '';
    const hex = canonHex8(raw);
    return hex ? hex + '|' + String(spec.plugin).toLowerCase() : '';
  }
  /* Re-key a reply. C++ uppercases the whole string including the 0x, so a key is
     normalised on arrival rather than trusted — that asymmetry is why lookups silently
     missed for months. */
  function normKey(k) {
    const s = String(k == null ? '' : k);
    const i = s.indexOf('|');
    if (i < 0) return s.toUpperCase();
    const hex = canonHex8(s.slice(0, i));
    return (hex || s.slice(0, i).toUpperCase()) + '|' + s.slice(i + 1).toLowerCase();
  }

  /* =============================================================== the stores ================ */

  const render = Object.create(null);   // canonical key -> 'icons/items/x.png'   (MRF, all lanes)
  const failed = Object.create(null);   // canonical key -> why it will never render
  const asked = Object.create(null);    // canonical key -> the VERBATIM formId we asked with
  const byForm = Object.create(null);   // 'plugin|hex-no-pad' -> interface icon    (source 3)
  const generic = Object.create(null);  // 'ALTERATION_ADEPT'  -> interface icon
  const overrides = Object.create(null);// 'plugin|hex-no-pad' -> a chosen spell icon (source 1)
  let pool = [];                        // [{file,label}] the custom pool, for pickers
  let catalog = [];                     // [{file,label,atlas,key,kind}] the interface catalogue
  const poolSubs = [];                  // repaint callbacks for open pickers

  /* WHICH VIEW AM I IN. The custom pool is re-scanned with a different verb per
     view (hdIconList / mdIconList), and every pane used to guess with
     `typeof window.mdIcons === 'function'`. That guess is no longer usable — the
     taps below make EVERY tapped name a function in every view — so the module
     answers it from the name C++ actually pushed on, which is ground truth, and
     falls back to the view's own open function (never tapped). */
  let sawPush = '';                     // 'hd' | 'md' | 'hb' | ''

  /* The interface index keys spell forms as plugin-lower|bare-lower-hex (no padding, no
     0x) — a THIRD dialect, and the one that must be reproduced exactly to hit byForm. */
  function shKey(spec) {
    if (!spec || !spec.plugin) return '';
    const raw = (spec.localId != null && spec.localId !== '') ? spec.localId : spec.formId;
    if (raw == null || raw === '') return '';
    const n = toNum(raw);
    if (!isFinite(n)) return '';
    return String(spec.plugin).toLowerCase() + '|' + n.toString(16);
  }

  /* =============================================================== ingest ==================== */

  function ingestRenderMap(map, lane) {
    if (!map || typeof map !== 'object') return 0;
    let n = 0;
    for (const k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      const key = normKey(k);
      const p = safePath(map[k]);
      /* A key with no '|' is not a form identity (the followers face lane echoes the
         caller's own runtime-formId string back). It could never be produced by key(),
         so storing it would only add unreachable entries. */
      if (!key || !p || key.indexOf('|') < 0) continue;
      if (render[key] !== p) { render[key] = p; n++; }
      delete failed[key];                    // it rendered after all
    }
    if (n) log(n + ' render path(s) from ' + lane);
    return n;
  }
  function ingestFailMap(map) {
    if (!map || typeof map !== 'object') return;
    for (const k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      const key = normKey(k);
      if (key && !render[key]) failed[key] = String(map[k] || 'this record has nothing to render');
    }
  }
  /* The item lane's reply: {version, icons, failed}. Also accepts the shapes the other
     lanes use, so one reader covers every push. */
  function ingestIndex(payload, lane) {
    let j = payload;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return 0; } }
    if (!j || typeof j !== 'object') return 0;
    const n = ingestRenderMap(j.icons || j.map || (j.failed ? null : j), lane);
    ingestFailMap(j.fails || j.failed);
    return n;
  }
  /* The interface index: {byForm, generic, catalog} — plus the HUD's extra {overrides}. */
  function ingestInterface(payload) {
    let j = payload;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return; } }
    if (!j || typeof j !== 'object') return;
    let n = 0;
    if (j.byForm && typeof j.byForm === 'object') {
      for (const k in j.byForm) {
        if (!Object.prototype.hasOwnProperty.call(j.byForm, k)) continue;
        const p = safePath(j.byForm[k]);
        if (p) { byForm[String(k).toLowerCase()] = p; n++; }
      }
    }
    if (j.generic && typeof j.generic === 'object') {
      for (const k in j.generic) {
        if (!Object.prototype.hasOwnProperty.call(j.generic, k)) continue;
        const p = safePath(j.generic[k]);
        if (p) generic[String(k).toUpperCase()] = p;
      }
    }
    if (j.overrides && typeof j.overrides === 'object') {
      for (const k in j.overrides) {
        if (!Object.prototype.hasOwnProperty.call(j.overrides, k)) continue;
        const p = safePath(j.overrides[k]);
        if (p) overrides[String(k).toLowerCase()] = p;
      }
    }
    if (Array.isArray(j.catalog)) catalog = j.catalog;
    if (n) log(n + ' interface icon(s) indexed');
  }
  /* The custom pool listing: {custom:[{file,label}]}. Tolerates the flat array of path
     strings some callers still hand out. */
  function ingestPool(payload) {
    let j = payload;
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { return; } }
    let rows = null;
    if (Array.isArray(j)) rows = j;
    else if (j && Array.isArray(j.custom)) rows = j.custom;
    if (!rows) return;
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const file = safePath(typeof r === 'string' ? r : (r && r.file));
      if (!file) continue;
      const label = (r && r.label) ? String(r.label)
        : file.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '');
      out.push({ file: file, label: label });
    }
    pool = out;
    for (let i = 0; i < poolSubs.length; i++) {
      try { poolSubs[i](pool.slice()); } catch (e) { log('pool subscriber threw: ' + e); }
    }
  }

  /* Which re-scan verb this view answers to. */
  function iconListVerb() {
    if (sawPush === 'md' || sawPush === 'hb') return 'mdIconList';
    if (sawPush === 'hd') return 'hdIconList';
    /* Nothing pushed yet: mdOpen / hdOpen are the views' own entry points and are
       never tapped, so they remain honest signals. */
    if (typeof window.mdOpen === 'function' || typeof window.hbOpen === 'function') return 'mdIconList';
    return 'hdIconList';
  }

  /* =============================================================== the taps ================== */

  /* Tap a global C++ pushes into, without caring whether the owning pane registers before
     or after us: an accessor keeps OUR function as the visible value and forwards to
     whatever anyone assigns.

     ⚠ THE CHAINING TRAP, and why this keeps a STACK rather than one downstream slot.
     Several panes do not REPLACE these globals, they CHAIN them (app.js, followers-pane
     and wardrobe-nff all do it to hdIcons / hdIconIndex):

         const prev = window.hdIcons;                    // <- reads our tap
         window.hdIcons = function (r) { …mine…; prev(r); };

     With a single downstream slot, `prev` IS the tap and the tap calls the newest
     handler — so the handler calls the tap calls the handler, for ever. In Ultralight
     that is not a stack trace, it is the shared renderer going down. Keeping every
     assignment in order and dispatching by DEPTH reproduces the original chain exactly:
     the tap entered at depth 0 runs the newest handler, the tap re-entered from inside
     it runs the one before, and so on to the bottom. Both chainers still run, in their
     original order, and a handler that deliberately does not call prev still shadows
     everything under it — exactly as before.

     The downstream call is caught too: an uncaught error inside a pushed reply is an
     access violation here, so swallowing it with a log is strictly safer than today. */
  function tap(name, take) {
    const chain = [];
    if (typeof window[name] === 'function') chain.push(window[name]);
    let depth = 0;
    function tapped() {
      if (depth === 0) {
        try { take.apply(null, arguments); }
        catch (e) { log(name + ' ingest threw: ' + e); }
      }
      const idx = chain.length - 1 - depth;
      if (idx < 0) return undefined;
      const fn = chain[idx];
      depth++;
      try { return fn.apply(this, arguments); }
      catch (e) { log(name + ' consumer threw: ' + e); return undefined; }
      finally { depth--; }
    }
    tapped.__hdArtTap = true;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: function () { return tapped; },
        set: function (v) { if (typeof v === 'function' && !v.__hdArtTap) chain.push(v); },
      });
    } catch (e) {
      /* No accessor support: fall back to a plain chain. Order-dependent, but a missed
         tap costs a lookup, never a crash. */
      window[name] = tapped;
      log('accessor tap unavailable for ' + name + '; chained instead');
    }
  }

  tap('wdItemIcons', function (j) { if (ingestIndex(j, 'items')) landed(); });
  tap('nxIconsData', function (j) { if (ingestIndex(j, 'npcs')) landed(); });
  tap('mtIconsData', function (j) { if (ingestIndex(j, 'mounts')) landed(); });
  /* NOT tapped: fdFaceIconsData. Its map is keyed by the RUNTIME formId string the
     caller sent, not by a plugin|form identity, so nothing key() can build would ever
     match it — ingesting it would add only unreachable rows. The followers roster owns
     that lane; a surface that wants a face by identity asks the npc lane instead. */
  tap('hdIconIndex', function (j) { sawPush = sawPush || 'hd'; ingestInterface(j); });
  tap('mdIconIndex', function (j) { sawPush = sawPush || 'md'; ingestInterface(j); });
  tap('hbIconIndex', function (j) { sawPush = sawPush || 'hb'; ingestInterface(j); });
  tap('hudIconIndex', ingestInterface);   // the HUD rides the deck's own tree
  tap('hdIcons', function (j) { sawPush = sawPush || 'hd'; ingestPool(j); });
  tap('mdIcons', function (j) { sawPush = sawPush || 'md'; ingestPool(j); });
  tap('hbIcons', function (j) { sawPush = sawPush || 'hb'; ingestPool(j); });

  /* =============================================================== the ladder ================ */

  const TIER = { 0: 'NOVICE', 1: 'APPRENTICE', 2: 'ADEPT', 3: 'EXPERT', 4: 'MASTER',
    novice: 'NOVICE', apprentice: 'APPRENTICE', adept: 'ADEPT', expert: 'EXPERT', master: 'MASTER' };
  const SCHOOL_WORDS = [
    ['destruction', /fire|flame|frost|ice|shock|lightning|burn|blast|thunder/i],
    ['restoration', /heal|ward|turn undead|cure|restor|sun|vampire's bane/i],
    ['illusion', /fury|calm|fear|frenzy|muffle|invisib|clairvoy|courage|rout|pacify/i],
    ['conjuration', /conjure|summon|bound |raise |reanimat|soul trap|dread|command daedra/i],
    ['alteration', /oakflesh|stoneflesh|ironflesh|ebonyflesh|dragonhide|candlelight|magelight|detect|paralyz|telekinesis|waterbreathing|transmute/i],
  ];
  function tierKey(t) {
    if (t == null || t === '') return 'ADEPT';
    const k = TIER[t] || TIER[String(t).toLowerCase()];
    return k || 'ADEPT';
  }
  /* Nothing on a record names its school when the payload omits it — sniff the name. This
     rung exists only in the Spell Deck's copy today, which is why the same spell can wear
     art in one surface and a glyph in another. */
  function schoolOf(spec) {
    const s = String(spec.school || '').toLowerCase();
    if (s) return s;
    const hay = String(spec.name || '');
    if (!hay) return '';
    for (let i = 0; i < SCHOOL_WORDS.length; i++) if (SCHOOL_WORDS[i][1].test(hay)) return SCHOOL_WORDS[i][0];
    return '';
  }
  /* Every generic key worth trying, best first. The UNION of the four ladders that had
     drifted apart: archetype-aware Restoration/Illusion/Conjuration (Spell Deck only),
     the element split and GENERIC rung for Destruction, and the plain SCHOOL_TIER rung. */
  function genericKeys(spec) {
    const out = [];
    const type = String(spec.type || spec.kind || '').toLowerCase();
    const slot = String(spec.slot || '').toLowerCase();
    if (type === 'voice' || type === 'shout' || spec.voice) { out.push('SHOUT_GENERIC'); return out; }
    if (type === 'power') { out.push('GREATER_POWER'); return out; }
    if (type === 'lesser') { out.push('LESSER_POWER'); return out; }
    if (!type && slot === 'voice') { out.push('GREATER_POWER'); return out; }
    const t = tierKey(spec.tier);
    const school = schoolOf(spec);
    const arch = String(spec.archetype || '').toLowerCase();
    const el = String(spec.element || '').toLowerCase();
    switch (school) {
      case 'destruction':
        if (el === 'fire' || el === 'frost' || el === 'shock') out.push('DESTRUCTION_' + el.toUpperCase() + '_' + t);
        out.push('DESTRUCTION_GENERIC_' + t);
        break;
      case 'restoration':
        out.push((arch === 'turnundead' || arch === 'banish' ? 'RESTORATION_HOSTILE_' : 'RESTORATION_FRIENDLY_') + t);
        out.push('RESTORATION_FRIENDLY_' + t);
        break;
      case 'illusion':
        out.push((arch === 'fear' || arch === 'frenzy' || arch === 'calm' ? 'ILLUSION_HOSTILE_' : 'ILLUSION_FRIENDLY_') + t);
        out.push('ILLUSION_FRIENDLY_' + t);
        break;
      case 'conjuration':
        out.push((arch === 'bound' ? 'CONJURATION_BOUND_WEAPON_' : 'CONJURATION_SUMMON_') + t);
        out.push('CONJURATION_SUMMON_' + t);
        break;
      default:
        if (school) out.push(school.toUpperCase() + '_' + t);
        break;
    }
    return out;
  }
  function interfaceIcon(spec) {
    const k = shKey(spec);
    if (k) {
      if (overrides[k]) return overrides[k];
      if (byForm[k]) return byForm[k];
    }
    const cand = genericKeys(spec);
    for (let i = 0; i < cand.length; i++) if (generic[cand[i]]) return generic[cand[i]];
    return '';
  }

  /* =============================================================== for() ===================== */

  /* Kinds whose art the mesh renderer can produce. Anything else skips the render rung
     entirely — queueing a shout at the render framework is work that can only fail. */
  const RENDERABLE = { item: 1, npc: 1, face: 1, body: 1, mount: 1 };

  const DEFAULT_GLYPH = { item: '◆', npc: '☻', face: '☻', body: '☻', mount: '☻', spell: '✦', plain: '◆' };

  /* THE ONE ENTRY POINT.
     Give it whatever you know about a thing; get back what to draw and what state it is
     in. Never throws, never returns undefined, never returns an unsafe path.

       spec  { kind, formId|localId, plugin, name, icon, glyph, renderable,
               school, tier, element, type, slot, archetype, size }
       ->    { src, glyph, state, source, why, key }

       state 'ready'      src is a real path — draw it (and arm the fallback).
             'rendering'  no picture yet, but one may still land — draw the glyph and a
                          shimmer. A group() will be asking for it.
             'none'       nothing more is coming — the glyph is the final answer; `why`
                          says so in words when C++ gave a reason.                       */
  function artFor(spec) {
    const out = { src: '', glyph: '', state: 'none', source: 'glyph', why: '', key: '' };
    try {
      if (!spec || typeof spec !== 'object') { out.glyph = DEFAULT_GLYPH.plain; return out; }
      const kind = String(spec.kind || 'item').toLowerCase();
      out.glyph = (spec.glyph != null && spec.glyph !== '') ? String(spec.glyph)
        : (DEFAULT_GLYPH[kind] || DEFAULT_GLYPH.plain);
      const key = keyOf(spec);
      out.key = key;

      /* 1 — the owner's own picture. An explicit choice outranks everything. */
      const chosen = safePath(spec.icon);
      if (chosen) { out.src = chosen; out.state = 'ready'; out.source = 'custom'; return out; }

      /* 2 — a render of the real thing. */
      const renderable = (spec.renderable !== false) && !!RENDERABLE[kind];
      if (key && renderable) {
        const p = render[key];
        if (p) { out.src = p; out.state = 'ready'; out.source = 'render'; return out; }
      }

      /* 3 — stock art for its category. Spell-family rows live here; an item may also
             carry a chosen-by-category picture, so the rung is tried for everything. */
      const iface = interfaceIcon(spec);
      if (iface) { out.src = iface; out.state = 'ready'; out.source = 'interface'; return out; }

      /* 4 — the glyph, and an honest account of whether to keep waiting. */
      if (key && renderable) {
        if (failed[key]) { out.state = 'none'; out.why = failed[key]; return out; }
        out.state = 'rendering';
        return out;
      }
      return out;
    } catch (e) {
      log('for() threw: ' + e);
      out.src = '';
      if (!out.glyph) out.glyph = DEFAULT_GLYPH.plain;
      out.state = 'none';
      return out;
    }
  }

  /* =============================================================== groups =================== */

  const SETTLE_MS = 650;      // the list must sit still this long before anything is asked
  const POLL_MS = 2500;
  const POLL_MAX = 24;        // STALLED ticks, not elapsed ones
  const REASK_EVERY = 4;      // every 4th tick, re-ask for what is still missing
  const MAX_BATCH = 240;      // one ask never queues more than a screenful's worth

  const groups = Object.create(null);
  let pollT = null, pollN = 0, pollLast = -1;

  const LANE_VERB = { item: 'whIcons', npc: 'nxIcons' };

  function specsOf(g) {
    let list = null;
    try { list = g.opts.specs ? g.opts.specs() : null; } catch (e) { log(g.id + ' specs() threw: ' + e); }
    return Array.isArray(list) ? list : [];
  }
  function isVisible(g) {
    try { return g.opts.visible ? !!g.opts.visible() : true; } catch (e) { return false; }
  }
  /* Everything this group still wants a picture for. */
  function pendingOf(g) {
    const out = [];
    const list = specsOf(g);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const a = artFor(s);
      if (a.state === 'rendering') out.push(s);
    }
    return out;
  }
  function laneOf(spec) {
    return String((spec && spec.kind) || 'item').toLowerCase() === 'item' ? 'item' : 'npc';
  }
  /* How much is outstanding, split by lane, so a poll only nudges the lanes that have
     work — an npc-lane pane must not make the item lane chatter. */
  function pendingByLane() {
    const n = { item: 0, npc: 0, total: 0 };
    for (const id in groups) {
      const g = groups[id];
      if (!g.active || !isVisible(g)) continue;
      const list = pendingOf(g);
      for (let i = 0; i < list.length; i++) { n[laneOf(list[i])]++; n.total++; }
    }
    return n;
  }
  function anyPending() { return pendingByLane().total; }

  /* The batch. Deduped against the GLOBAL asked set, so two panes showing the same item
     queue it once between them, and a repaint can never re-ask for something in flight. */
  function ask(g) {
    const want = { item: [], npc: [] };
    const seen = Object.create(null);
    const list = pendingOf(g);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const key = keyOf(s);
      if (!key || seen[key] || asked[key]) continue;
      const kind = String(s.kind || 'item').toLowerCase();
      const lane = (kind === 'item') ? 'item' : 'npc';
      if (want[lane].length >= MAX_BATCH) continue;
      seen[key] = 1;
      /* VERBATIM on the wire — C++ builds the PNG filename from this string, so a
         canonicalised spelling would orphan every file already on disk. The one thing
         that is NOT passed through is a numeric id: C++ reads the field as hex, so a
         number has to be spelled as hex or it names a different form. */
      const wire = (s.formId != null && s.formId !== '')
        ? (typeof s.formId === 'number' ? '0x' + (s.formId >>> 0).toString(16) : String(s.formId))
        : (typeof s.localId === 'number' ? '0x' + (s.localId >>> 0).toString(16) : String(s.localId));
      asked[key] = wire;
      want[lane].push({ formId: wire, plugin: String(s.plugin), name: String(s.name || '') });
    }
    let sent = 0;
    for (const lane in want) {
      if (!want[lane].length) continue;
      toGame(LANE_VERB[lane], JSON.stringify({ items: want[lane] }));
      sent += want[lane].length;
    }
    if (sent) log(g.id + ': asked for ' + sent + ' render(s)');
    return sent;
  }

  /* Drop the asked marks for things that still have nothing, then ask again. The only way
     a key C++ dropped (queue full, batch cut short) is ever queued a second time — an
     empty poll queues nothing, and `asked` would otherwise bury it for the session. */
  function reask(g) {
    const list = pendingOf(g);
    for (let i = 0; i < list.length; i++) {
      const key = keyOf(list[i]);
      if (key) delete asked[key];
    }
    ask(g);
  }

  function stopPoll() { if (pollT) { clearInterval(pollT); pollT = null; } }
  function startPoll() {
    if (pollT) return;
    pollN = 0; pollLast = -1;
    pollT = setInterval(pollTick, POLL_MS);
  }
  /* C++ pushes the index only when the WHOLE queue drains, which behind a long queue is
     minutes away — an EMPTY request queues nothing and answers with the on-disk index, so
     pictures appear as they land. The budget counts STALLED ticks: a long paced batch
     keeps landing art well past 60 s, and giving up mid-batch leaves tiles spinning
     for ever. */
  function pollTick() {
    let lanes = { item: 0, npc: 0, total: 0 };
    try { lanes = pendingByLane(); } catch (e) { lanes = { item: 0, npc: 0, total: 0 }; }
    if (!lanes.total) { stopPoll(); return; }
    if (pollLast < 0 || lanes.total < pollLast) pollN = 0;   // art is landing — keep watching
    pollLast = lanes.total;
    if (++pollN > POLL_MAX) { stopPoll(); return; }
    if (pollN % REASK_EVERY === 0) {
      for (const id in groups) {
        const g = groups[id];
        if (g.active && isVisible(g)) reask(g);
      }
      return;
    }
    if (lanes.item) toGame('whIcons', JSON.stringify({ items: [] }));
    if (lanes.npc) toGame('nxIcons', JSON.stringify({ items: [] }));
  }

  /* Something landed: let every visible group repaint, and re-open the poll's budget. */
  function landed() {
    pollN = 0;
    for (const id in groups) {
      const g = groups[id];
      if (!g.active || !isVisible(g) || !g.opts.onLand) continue;
      try { g.opts.onLand(); } catch (e) { log(id + ' onLand threw: ' + e); }
    }
  }

  function group(id, opts) {
    id = String(id || ('g' + Math.random()));
    const g = groups[id] || (groups[id] = { id: id, opts: {}, t: null, active: false });
    g.opts = opts || {};
    g.active = true;
    const api = {
      /* Call after ANY change to what is on screen. Idempotent, settle-gated: only the
         list you stopped on ever queues work. */
      schedule: function () {
        if (g.t) { clearTimeout(g.t); g.t = null; }
        if (!g.active) return api;
        g.t = setTimeout(function () {
          g.t = null;
          if (!g.active || !isVisible(g)) return;
          ask(g);
          if (anyPending()) startPoll();
        }, (g.opts.settleMs != null) ? g.opts.settleMs : SETTLE_MS);
        return api;
      },
      /* Test hook / deliberate event (a page turn, an opened pane): skip the wait. */
      flush: function () {
        if (g.t) { clearTimeout(g.t); g.t = null; }
        if (!g.active) return api;
        ask(g);
        if (anyPending()) startPoll();
        return api;
      },
      stop: function () {
        if (g.t) { clearTimeout(g.t); g.t = null; }
        g.active = false;
        if (!anyPending()) stopPoll();
        return api;
      },
      pending: function () { return pendingOf(g).length; },
    };
    return api;
  }

  /* =============================================================== painting ================= */

  /* Inline onerror, for innerHTML builders. Inline and not a post-paint listener because
     the <img> is live the instant innerHTML is assigned and Ultralight can fail a cached
     miss before a listener attaches. The parentNode guard is load-bearing: the failure is
     asynchronous, so a repaint in between leaves this <img> detached and an unguarded
     handler throws on every missing icon — which, in this engine, is not a lost picture.
     Drops the has-art class so the container's own glyph shows through.

     Use exactly as: '<img class="…" src="' + HDArt.esc(a.src) + '"' + HDArt.ERR + '>' */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Every pane names its own "this plate has art" class (tg-has-art, sc-has-art,
     ca-has-art …) and its CSS hides the glyph while that class is on. So the
     shared handler has to be told which one to clear, or a failed load would
     leave a styled-but-empty box — which is the very failure this replaces.
     errFor('tg-has-art') is the normal call; ERR is the bare default. */
  function errFor(cls) {
    const extra = (typeof cls === 'string' && /^[A-Za-z][\w-]*$/.test(cls))
      ? 'b.classList.remove(&quot;' + cls + '&quot;);' : '';
    return ' onerror="var b=this.parentNode;if(b){' + extra +
      'b.classList.remove(&quot;hda-on&quot;);b.classList.remove(&quot;has-art&quot;);' +
      'b.classList.add(&quot;hda-off&quot;);b.removeChild(this);}"';
  }
  const ERR = errFor('');

  function dropImg(img, cls) {
    const b = img.parentNode;
    if (!b) return;
    if (b.classList) {
      if (cls) b.classList.remove(cls);
      b.classList.remove('hda-on');
      b.classList.remove('has-art');
      b.classList.add('hda-off');
    }
    if (img.parentNode === b) b.removeChild(img);
  }

  /* Post-paint sweep, for DOM builders — and the one that also catches the ALREADY-failed
     case (a cached miss can complete before this runs, and then no error event is ever
     fired again). Safe to call repeatedly; each <img> is armed once. */
  function arm(root, cls) {
    try {
      const scope = root || document;
      if (!scope || !scope.querySelectorAll) return;
      const imgs = scope.querySelectorAll('img[src]');
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        if (img.__hdArtArmed) continue;
        img.__hdArtArmed = true;
        const drop = (function (el) { return function () { dropImg(el, cls); }; })(img);
        img.addEventListener('error', drop);
        /* A cached miss can complete BEFORE this runs, and then no error event is
           ever fired again — so the already-failed case is swept explicitly. */
        if (img.complete && img.naturalWidth === 0) drop();
      }
    } catch (e) { log('arm threw: ' + e); }
  }

  /* Build a guarded <img> for a resolved art answer, or null when there is nothing to
     draw. `null` is deliberate — Element.append() stringifies a null child, but the h()
     helper the panes use skips it, and a caller who tests the return value cannot get a
     broken box. */
  function imgFor(a, attrs, cls) {
    try {
      if (!a || !a.src) return null;
      const img = document.createElement('img');
      img.setAttribute('src', a.src);
      img.setAttribute('alt', '');
      img.setAttribute('draggable', 'false');
      if (attrs) for (const k in attrs) if (attrs[k] != null) img.setAttribute(k, String(attrs[k]));
      img.__hdArtArmed = true;
      img.addEventListener('error', function () { dropImg(img, cls); });
      return img;
    } catch (e) { log('img threw: ' + e); return null; }
  }

  /* =============================================================== exports ================== */

  window.HDArt = {
    /* the one question */
    for: artFor,
    /* asking for renders */
    group: group,
    /* painting */
    ERR: ERR, errFor: errFor, arm: arm, img: imgFor, esc: esc,
    /* paths and keys — exported so a pane never hand-rolls them again */
    path: safePath, key: keyOf, normKey: normKey, canonHex8: canonHex8, shKey: shKey,
    /* the pools, for pickers. onPool() fires whenever a fresh listing lands, so a
       picker that is open repaints itself; refreshPool() asks for a re-scan with
       whichever verb THIS view answers to — a caller never has to know. */
    pool: function () { return pool.slice(); },
    catalog: function () { return catalog.slice(); },
    onPool: function (cb) { if (typeof cb === 'function') poolSubs.push(cb); },
    refreshPool: function () { toGame(iconListVerb(), ''); },
    iconListVerb: iconListVerb,
    /* ingest, for harnesses and for any surface with its own bridge verb */
    ingest: ingestIndex, ingestInterface: ingestInterface, ingestPool: ingestPool,
    /* diagnostics / tests */
    _pollTick: pollTick,
    _stores: { render: render, failed: failed, asked: asked, byForm: byForm,
      generic: generic, overrides: overrides },
    _reset: function () {
      for (const k in render) delete render[k];
      for (const k in failed) delete failed[k];
      for (const k in asked) delete asked[k];
      for (const k in byForm) delete byForm[k];
      for (const k in generic) delete generic[k];
      for (const k in overrides) delete overrides[k];
      pool = []; catalog = []; sawPush = '';
      for (const id in groups) { if (groups[id].t) clearTimeout(groups[id].t); delete groups[id]; }
      stopPoll();
    },
  };
})();
