'use strict';

/* ====================================================================== *
 *  Wardrobe — an outfit / wardrobe / NPC manager tab inside the Hotkey Deck.
 *
 *  A wardrobe layer over SOES-NG (Skyrim Outfit Equipment System NG), which
 *  owns the outfit definitions, the equip hook and the auto-switching but has
 *  no pools, no randomisation, no cadence and no per-outfit metadata. We add
 *  exactly those four things:
 *
 *    Outfits    - SOES's outfits, plus OUR metadata (image, categories, note,
 *                 favourite). Joined by outfit NAME, because that is SOES's
 *                 own key (SetSelectedOutfit(actor, name)).
 *    Wardrobes  - named pools of outfit names.
 *    NPCs       - assign an outfit OR a wardrobe, with a cadence slider
 *                 ("re-roll every N in-game hours") and optional per-location
 *                 overrides using SOES's own location-type ids.
 *
 *  Self-contained by design: the pane owns its own state, its own DOM (every
 *  id wd- prefixed), and its own document listeners. It never reads or writes
 *  app.js's `state` / `ui`.
 *
 *  Ownership split (important):
 *    - VIEW owns  categories / outfitMeta / wardrobes / assignments / settings
 *      -> mutated here, pushed whole via a debounced `wdSave`. C++ parses these
 *      into the "wardrobe" slice.
 *    - C++ owns   the SOES catalogue (outfit names + item counts + tracked
 *      actors), the roll bookkeeping (lastRollDay / lastOutfit) and what each
 *      NPC is CURRENTLY wearing -> pushed via `wdOpen` / `wdState`. The view
 *      never writes those, so the two can't race.
 *
 *  Bridge - C++ registers these JS->C++ listeners on the DECK view:
 *    wdGet() . wdSave(json) . wdDress(json) . wdRoll(json) . wdTrack(json) .
 *    wdLog(str)
 *  C++ calls into us (names disjoint from the above):
 *    wdOpen(cfg) . wdState(json) . wdResult(json) . wdSaved(ok) . wdShow()
 *  Request and response names stay disjoint - PrismaUI installs each JS
 *  listener as a global of that name, so a shared name clobbers the handler.
 *
 *  Host contract (see src/wardrobe-wiring.md):
 *    WardrobePane.init() . onShow() . onHide() . receive(fn, payload) .
 *    wantsPause() -> true
 * ====================================================================== */

window.WardrobePane = (function () {

  const DEV = location.search.indexOf('dev=1') !== -1;
  const SELFTEST = location.search.indexOf('selftest=1') !== -1;

  const SAVE_DEBOUNCE = 350;                 // same cadence as the other panes
  const SUBS = ['outfits', 'wardrobes', 'npcs', 'inventory'];
  const SUB_LABEL = { outfits: 'Outfits', wardrobes: 'Wardrobes', npcs: 'People', inventory: 'Inventory' };

  /* Sub-tabs contributed by another file. `wardrobe-nff.js` registers the NFF
   * outfit backend this way: it owns its own rows, its own overlays and its own
   * bridge, and everything above stays SOES-only. A plug-in supplies
   * { id, label, init, onEnter, count, render(ctx), setFilter(q) } and is added
   * to SUBS at parse time, before init() runs. */
  const PLUGINS = {};
  function registerSub(p) {
    if (!p || !p.id || PLUGINS[p.id]) return;
    PLUGINS[p.id] = p;
    /* `hidden` = a plug-in that provides data and section renderers but no tab
       of its own. The NFF module became one when its surface folded into the
       People tab (2026-08-03): two tabs answering "what does she wear" from
       two mods was the single most confusing thing in this pane. */
    if (!p.hidden) {
      SUBS.push(p.id);
      SUB_LABEL[p.id] = p.label || p.id;
    }
    if (ui.inited) { try { p.init(); } catch (e) { console.log('[wardrobe] sub init', p.id, e); } render(); }
  }
  function plugin() { return PLUGINS[ui.sub] || null; }

  /* Dressing order, so the inventory reads the way you'd put clothes on.
   * "Unknown" is real — modded jewellery uses slots the namer doesn't cover —
   * so it is kept and sorted last rather than hidden. */
  const SLOT_ORDER = ['Body', 'Head', 'Hair', 'Circlet', 'Hands', 'Forearms',
    'Feet', 'Calves', 'Shield', 'Amulet', 'Ring', 'Unknown'];
  const slotRank = (s) => { const i = SLOT_ORDER.indexOf(s); return i === -1 ? SLOT_ORDER.length : i; };

  /* Cadence slider stops, in in-game hours. 0 = never re-roll. Discrete stops
   * beat a raw 1..168 range: every position is a value you'd actually pick. */
  const CADENCE = [0, 1, 2, 3, 6, 8, 12, 24, 48, 72, 168];

  /* SOES-NG location types — the full set, from its own source review
   * (modding/guides/soes_ng_technical_analysis.md §3). Order = the priority
   * order SOES resolves them in, so the picker reads the way the engine thinks. */
  const LOCATIONS = [
    { v: 2000, n: 'Love scene' }, { v: 1900, n: 'Mounted' }, { v: 1800, n: 'Swimming' },
    { v: 1700, n: 'Sleeping' }, { v: 1600, n: 'In water' }, { v: 1500, n: 'Combat' },
    { v: 5600, n: 'Player home' }, { v: 6000, n: 'Castle' }, { v: 6100, n: 'Temple' },
    { v: 5900, n: 'Guild hall' }, { v: 6300, n: 'Jail' }, { v: 6200, n: 'Farm' },
    { v: 6400, n: 'Military' }, { v: 5700, n: 'Inn' }, { v: 5800, n: 'Store' },
    { v: 5500, n: 'Dungeon' },
    { v: 1400, n: 'City interior' }, { v: 900, n: 'Town interior' }, { v: 400, n: 'World interior' },
    { v: 1200, n: 'City snow' }, { v: 1300, n: 'City rain' },
    { v: 700, n: 'Town snow' }, { v: 800, n: 'Town rain' },
    { v: 200, n: 'World snow' }, { v: 300, n: 'World rain' },
    { v: 1100, n: 'City night' }, { v: 1000, n: 'City' },
    { v: 600, n: 'Town night' }, { v: 500, n: 'Town' },
    { v: 100, n: 'World night' }, { v: 0, n: 'World (base)' },
  ];
  const LOC_NAME = {};
  LOCATIONS.forEach((l) => { LOC_NAME[l.v] = l.n; });

  const HUES = [38, 12, 145, 200, 260, 320, 88, 0];

  /* Render this many rows at a time. A 300-outfit catalogue must not build 300
   * cards on tab-open; search narrows so hard that the button is rarely hit. */
  const PAGE = 60;

  /* ============================================================ bridge == */

  function toGame(fn, arg) {
    const f = window[fn];
    if (typeof f === 'function') {
      try { f(String(arg === undefined ? '' : arg)); } catch (e) { console.log('bridge error', fn, e); }
    } else {
      console.log('[dev->game]', fn, arg);
    }
  }
  function glog(msg) { toGame('wdLog', msg); }

  /* ============================================================= state == */
  /* view-owned */
  const state = {
    categories: [],   // {id,name,hue}
    outfitMeta: [],   // {name,image,categoryIds[],note,fav}
    itemIcons: {},    // "0XABCD|plugin.esp" -> "icons/items/<file>.png" (rendered armour)
    wardrobes: [],    // {id,name,hue,note,outfits:[name,...]}
    assignments: [],  // {formId,plugin,name,mode,wardrobeId,outfit,cadenceHours,locationOverrides[],lastRollDay,lastOutfit}
    /* `uiScale` is the whole-tab zoom (see "whole-tab scale" below). It rides
     * in `settings` because that object is already round-tripped whole through
     * C++ (Wardrobe::ToJson/FromJson -> hotkeys.json "wardrobe.settings"), so
     * persisting it costs one field there and no new bridge call here. */
    /* soesQuickslot / soesClimate are C++-OWNED mirrors of two SOES switches
     * (the quick-swap power, and whether weather outranks location). They ride
     * in `settings` because that is where C++ puts them, but wdSave never sends
     * them back — see the save() payload. */
    settings: { enabled: true, notify: true, uiScale: 1, soesQuickslot: false, soesClimate: false },
    /* C++-owned mirror (pushed via wdOpen / wdState — never sent back) */
    soes: { available: false, outfits: [], tracked: [] },  // outfits: {name,items,fav}
    /* The importer's two lists. C++-owned, engine-read (BGSOutfit forms), and
     * deliberately NOT persisted: they describe the load order, not the save. */
    outfitMods: [],    // [{plugin, count}]
    modOutfits: null,  // {ok, plugin, outfits:[{editorId, parts, formId}]}
    npcs: [],         // {formId,plugin,name,portrait,tracked,wearing,conflict}
    inventory: [],    // {formId,plugin,name,slot,armorRating,enchanted} — the player's armour
    armorMods: [],    // {plugin,count} — every armour-bearing plugin in the load order
    modArmors: null,  // {plugin,total,shown,capped,items[]} — one plugin's armour
    now: null,        // Calendar::GetDaysPassed(), for the "next change" readout
    /* The portraits/ listing, chained off the Followers pane's own fdPortraits
     * push (see the chain at the foot of this file). slug -> {file,ext,mtime}. */
    portraits: {},
    /* Outfit-photo display crops: image FILE NAME -> {z,x,y}. C++-owned (it is
     * the side that can prune against icons/custom/), delivered inside wdOpen
     * and again as `wdCrops` after every save. Keyed by the file and never by
     * the outfit — see the crop block below for why that is what makes
     * double-cropping structurally impossible. */
    imageCrops: {},
  };

  const ui = {
    sub: 'outfits',
    editing: false,
    filter: '',
    catFilter: '',     // category pill filter (Outfits sub-tab), '' = all
    shown: false,
    inited: false,
    loading: true,     // until the first wdOpen lands
    limit: PAGE,       // how many rows of the current section are rendered
    builderId: null,   // wardrobe id while the builder is open
    builderFilter: '',
    sheetKey: null,    // "formId|plugin" while the NPC sheet is open
    armed: null,       // key of a delete armed for confirm
    invSlot: '',       // inventory slot filter, '' = all
    invSource: 'carried',  // carried | all — where the builder draws armour from
    invMod: '',        // when browsing all armour: which plugin
    pieces: null,      // {name, items[]} while an outfit's contents are open
    settings: false,
    /* Warning banner detail revealed. Session-only, closed by default. */
    warnOpen: false,   // the SOES settings panel
    /* The outfit IMPORTER, inside that settings panel. SOES can turn any
     * OTFT record in the load order into one of its own outfits, and until
     * now the deck had the C++ for it and no way to press it — the exact dead
     * `wdImport` the parity audit found. {q, plugin, q2} — two search boxes
     * because a 4,780-mod load order has hundreds of outfit-bearing plugins
     * and some single plugins carry dozens of outfits. */
    renaming: null,    // outfit NAME while its inline rename box is open
    importer: null,
    imported: {},      // editorId -> true, so a row can say "done" without a re-export
    /* Multi-select. Keys are outfit NAMES on the Outfits tab and wardrobe IDs on
     * the Wardrobes tab — never mixed, because the tab owns the meaning. */
    sel: [],
    selAnchor: null,   // for shift-range
    picker: null,      // {kind:'wardrobe'|'category', q:'', idx:0} while choosing
    /* The one open inline typeahead (see "inline combobox"). {key,q,idx,fresh}
     * — one at a time, because they all live in the same sheet and a second
     * open list would just be two lists fighting for the arrow keys. Kept in
     * `ui` and not in the DOM: every edit re-renders the sheet, so a widget
     * holding its own open/query state would slam shut on the first keystroke. */
    combo: null,
    build: null,       // { name, picked: {key: item} } while building an outfit
    opener: null,      // element to hand focus back to when a dialog closes
  };

  /* =========================================================== helpers == */

  const $ = (id) => document.getElementById(id);
  const els = {};

  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'data') { for (const d in v) e.dataset[d] = v[d]; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach((c) => {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  /* Split `text` on the first case-insensitive hit of `q` and wrap it in <mark>.
   * Text nodes, never innerHTML — an outfit called "<Caenarvon>" must not inject. */
  function nameNodes(text, q) {
    text = String(text == null ? '' : text);
    if (!q) return [document.createTextNode(text)];
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return [document.createTextNode(text)];
    return [
      document.createTextNode(text.slice(0, i)),
      h('mark', null, text.slice(i, i + q.length)),
      document.createTextNode(text.slice(i + q.length)),
    ];
  }

  function newId(p) {
    return p + Math.random().toString(36).slice(2, 8) + (Date.now() % 100000).toString(36);
  }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /** Human label for a cadence in in-game hours. */
  function cadenceLabel(hours) {
    const n = Number(hours) || 0;
    if (n <= 0) return 'never';
    if (n < 24) return n + 'h';
    if (n % 24 === 0) { const d = n / 24; return d + (d === 1 ? ' day' : ' days'); }
    return n + 'h';
  }
  /** Nearest slider index for an arbitrary stored hour value. */
  function cadenceIndex(hours) {
    const n = Number(hours) || 0;
    let best = 0, bestd = Infinity;
    for (let i = 0; i < CADENCE.length; i++) {
      const d = Math.abs(CADENCE[i] - n);
      if (d < bestd) { bestd = d; best = i; }
    }
    return best;
  }

  function hueCss(hue, sat, light) {
    return 'hsl(' + (Number(hue) || 0) + ' ' + sat + '% ' + light + '%)';
  }

  /* Thumbnail placeholders are inline SVG, not glyphs: they're the biggest thing
   * on an un-photographed card, and a font without the codepoint would render a
   * tofu box. Small chrome marks (★ ◇ ✦ ⚠) stay as characters — those already
   * ship in the domains/followers panes. */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(paths, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(size || 34));
    s.setAttribute('height', String(size || 34));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.4');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    });
    return s;
  }
  /* a coat hanger — "an outfit with no photo yet" */
  function hangerIcon() {
    return svgIcon(['M12 6.5a2 2 0 1 1 2 2c-1.2 0-2 .8-2 1.8V11',
      'M12 11 3.6 16.3c-.9.6-.5 2 .6 2h15.6c1.1 0 1.5-1.4.6-2L12 11Z']);
  }
  /* stacked cards — "a wardrobe with nothing photographed yet" */
  function stackIcon() {
    return svgIcon(['M4 8.5 12 4.5l8 4-8 4-8-4Z', 'M4 12.5l8 4 8-4', 'M4 16.5l8 4 8-4']);
  }

  /* One person, ONE key. C++ sends every row's canonical identity as `key`
     (local id + defining plugin, lowered) precisely because the runtime
     formId the row also carries is a different SPELLING of the same person
     than the canonically-stored assignments — and the mismatch meant saving
     An NPC's assignment worked in C++ while the sheet could never find its own
     row again (2026-08-03). Case-folded fallback for anything an older DLL
     sends without `key`. */
  const keyOf = (n) => String(n.key || (String(n.formId || '') + '|' + String(n.plugin || ''))).toLowerCase();
  const npcByKey = (k) => state.npcs.find((n) => keyOf(n) === String(k || '').toLowerCase()) || null;

  /* One canonical spelling for a form id, so "0x0001A6A1", "1A6A1" and
   * "0x1a6a1" compare equal - the same rule as followers-pane.js canonFormId()
   * and wardrobe-nff.js's copy. '' means "no usable id" and must NEVER match,
   * or every idless row would answer to every lookup.
   * Used by ONE thing: the F7 quick card, which knows the crosshair actor only
   * as a bare runtime number and has no plugin to pair it with. */
  function canonId(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(t)) return '';
    return t.replace(/^0+/, '') || '0';
  }
  function npcByRuntimeId(idLike) {
    const want = canonId(idLike);
    if (!want) return null;
    return state.npcs.find((n) => canonId(n.formId) === want) || null;
  }

  /* ---------------------------------------------------------- portraits --
   * A face is not a field on the row — Follower Organizer carries none, and
   * `npc.portrait` (which src/wardrobe.cpp copies straight out of FO) is empty
   * on every rig here. It is RESOLVED: slugOf(original || name) looked up in
   * the portraits/ listing C++ pushes as fdPortraits.
   *
   * The Followers tab owns that rule (followers-pane.js slugOf/portraitFor), so
   * we CALL IT rather than fork it — a second copy would drift from
   * portal/server.js slugOf() and portraits/README.txt, which all of them have
   * to agree on. wardrobe-nff.js already does exactly this; keep the three in
   * step. The local path below is the standalone harness, where the Followers
   * pane is not loaded, and is a deliberate mirror of followers-pane.js.
   *
   * Why formId matters here: wardrobe.cpp drops FO's `original`, so a RENAMED
   * follower reaches us under her display name and slugging that would miss her
   * face. FolPane.portraitInfoFor() looks her up by form id and slugs the
   * original, so the same person shows the same face on both tabs. */
  function slugOf(name) {
    const F = window.FolPane;
    if (F && typeof F._slugOf === 'function') return F._slugOf(name);
    let s = String(name == null ? '' : name);
    // Ultralight's JS engine does have normalize(), but a missing normalize
    // must degrade to "no accent folding", never to a thrown render.
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* keep s */ }
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function portraitFor(npc) {
    if (!npc) return null;
    const F = window.FolPane;
    if (F && typeof F.portraitInfoFor === 'function') {
      const hit = F.portraitInfoFor({ formId: npc.formId, original: npc.original, name: npc.name });
      if (hit) return hit;
    } else if (F && typeof F._portraitFor === 'function') {
      /* Older Followers pane: name-only, exactly what wardrobe-nff.js does. */
      const hit = F._portraitFor({ original: npc.original, name: npc.name });
      if (hit) return hit;
    }
    const slug = slugOf(npc.original || npc.name);
    const p = slug ? state.portraits[slug] : null;
    return p ? { slug: slug, file: p.file, ext: p.ext, mtime: p.mtime } : null;
  }

  /* The generic person glyph — the fallback for "no portrait" AND for a
   * portrait that turns out to be unloadable. */
  function faceGlyph(cls) {
    return h('div', { class: cls, 'aria-hidden': 'true' },
      svgIcon(['M12 12a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z',
        'M4.8 20c0-3.4 3.2-5.6 7.2-5.6s7.2 2.2 7.2 5.6'], 22));
  }

  /* The row face, with the retry the Followers pane had to learn: Ultralight's
   * view loader can treat "?v=<mtime>" as part of the FILENAME (proven in-game
   * 2026-07-28 — C++ found the file and pushed it, and the img still errored),
   * so try the cache-busted URL, retry the plain path ONCE, and only then fall
   * back to the glyph. `file` is authoritative and is never rebuilt from
   * slug + ext: a re-capture of an already-drawn face lands as `<slug>~<n>.png`
   * because Ultralight memory-maps every image it has drawn. */
  function npcFace(npc, cls) {
    cls = cls || 'wd-npc-face';
    /* An explicit portrait on the row still wins — it is what C++ sent for this
     * exact actor, and it may be an absolute path we could not resolve. */
    if (npc.portrait) return h('img', { class: cls, src: npc.portrait, alt: '', title: npc.name || '' });
    const p = portraitFor(npc);
    if (!p) return faceGlyph(cls + ' ph');
    const plain = 'portraits/' + p.file;
    const img = h('img', {
      class: cls, src: plain + '?v=' + (p.mtime || 0), alt: '',
      title: npc.name || '', draggable: 'false',
    });
    let retried = false;
    img.addEventListener('error', function () {
      if (!retried) { retried = true; img.src = plain; return; }
      glog('portrait failed to load: ' + plain);
      if (img.parentNode) img.parentNode.replaceChild(faceGlyph(cls + ' ph'), img);
    });
    return img;
  }

  function metaFor(name) {
    return state.outfitMeta.find((m) => m.name === name) || null;
  }
  /** Metadata row for an outfit, created on demand (so editing never needs a pre-pass). */
  function ensureMeta(name) {
    let m = metaFor(name);
    if (!m) { m = { name: name, image: '', categoryIds: [], note: '', fav: false }; state.outfitMeta.push(m); }
    if (!Array.isArray(m.categoryIds)) m.categoryIds = [];
    return m;
  }
  function wardrobeById(id) { return state.wardrobes.find((w) => w.id === id) || null; }
  function catById(id) { return state.categories.find((c) => c.id === id) || null; }
  function assignFor(key) { return state.assignments.find((a) => keyOf(a) === key) || null; }
  function ensureAssign(npc) {
    let a = assignFor(keyOf(npc));
    if (!a) {
      /* Born CANONICAL: split the row's durable key rather than copying its
         runtime formId, so the fresh assignment matches itself on the very
         next lookup instead of waiting for a C++ round-trip to be re-spelled.
         The runtime id is what created today's duplicate in the first place. */
      const kp = String(npc.key || '').split('|');
      a = {
        formId: (kp.length === 2 && kp[0]) ? kp[0] : npc.formId,
        plugin: (kp.length === 2 && kp[1]) ? kp[1] : npc.plugin,
        name: npc.name,
        mode: 'off', wardrobeId: '', outfit: '', cadenceHours: 0,
        locationOverrides: [], lastRollDay: 0, lastOutfit: '',
      };
      state.assignments.push(a);
    }
    if (!Array.isArray(a.locationOverrides)) a.locationOverrides = [];
    return a;
  }

  /** Every outfit name SOES knows about. */
  function soesNames() { return state.soes.outfits.map((o) => o.name); }
  function soesOutfit(name) { return state.soes.outfits.find((o) => o.name === name) || null; }
  /** A wardrobe member SOES no longer has is "missing", not silently dropped. */
  /* "SOES has never heard of this" — which a JUST-MADE outfit is not. It is in
     the list already, flagged pending, and calling it missing would put a
     warning on the thing the player just successfully created. */
  function isMissing(name) {
    if (!state.soes.available) return false;
    const o = soesOutfit(name);
    return !o;
  }

  /** Escape a value for use inside an [attr="..."] selector. */
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* An input that reads as plain text until you touch it — the deck's rename
   * pattern (Domains' .dm-rail-rename). PrismaUI has no window.prompt, so this
   * is the ONLY way to take text in-game. `data-k` gives it a stable identity
   * so focus and caret survive the re-render that its own edit triggers. */
  function inlineInput(value, opts) {
    const o = opts || {};
    const initial = value == null ? '' : String(value);
    const inp = h('input', {
      class: 'wd-inline' + (o.class ? ' ' + o.class : ''),
      type: 'text', value: initial, spellcheck: 'false', autocomplete: 'off',
      placeholder: o.placeholder || '',
      title: o.title || null,
      'aria-label': o.label || o.placeholder || 'Rename',
      data: { k: o.key },
      onkeydown: (e) => {
        e.stopPropagation();                       // [ ] / F2 / Esc belong to the field now
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); inp.value = initial; inp.blur(); }
      },
      onmousedown: (e) => e.stopPropagation(),     // typing in a card must not open it
      onclick: (e) => e.stopPropagation(),
      onchange: () => {
        const v = inp.value.trim();
        if (v === initial) return;
        if (o.required && !v) { inp.value = initial; return; }
        o.commit(v);
      },
    });
    return inp;
  }

  /* ================================================= inline combobox ==== *
   *  Rober: "setting an outfit for an npc in wardrobe should be a typable
   *  search bar". Every picker in the NPC sheet used to be a bare <select>.
   *  Eight outfits today, and the catalogue only grows — past ~10 options a
   *  native dropdown is a wall you scroll, so all four are typeaheads now.
   *
   *  ONE search behaviour in this pane, in two containers. #wd-picker stays a
   *  MODAL, because it is a different job: it assigns MANY selected outfits at
   *  once, it toggles membership rather than setting a value, and it can CREATE
   *  what you typed. A field inside a form must do none of that and must not
   *  take over the screen. What the two share is the searching, and that is
   *  shared for real — the same case-insensitive substring filter, the same
   *  <mark> highlighter (nameNodes), the same clamped ↑/↓ + Enter + Esc
   *  contract, and the same .wd-pick row markup.
   *
   *  Two deliberate shapes:
   *   - CLOSED is a button, not a read-only input. The pane re-renders on every
   *     edit, and an input that has to swap between "shows the value" and
   *     "holds your query" loses a keystroke on the swap. A button can't. Type
   *     any character on it and it opens seeded with that character, so it is
   *     still one keypress to start searching.
   *   - The list opens IN FLOW under the field, not floating. #wd-sheet-body
   *     scrolls (overflow-y:auto), so an absolutely-positioned dropdown would
   *     be clipped by it exactly where it matters — the last field in the
   *     sheet. In flow it cannot be clipped and cannot overlap anything.
   */

  const COMBO_DEBOUNCE = 90;   // keystroke -> re-filter. Arrows/Enter flush it.
  const COMBO_MAX = 60;        // rows built per open; the rest says "keep typing"
  let comboTimer = 0;

  /** The one filter both the combobox and #wd-picker use. */
  function comboFilter(opts, q) {
    q = String(q == null ? '' : q).trim().toLowerCase();
    if (!q) return opts.slice();
    return opts.filter((o) => String(o.label).toLowerCase().indexOf(q) !== -1);
  }

  function focusKey(k) {
    if (!els.pane) return;
    const el = els.pane.querySelector('[data-k="' + cssEsc(k) + '"]');
    if (el) el.focus();
  }

  function comboOpen(key, opts, current, seed) {
    clearTimeout(comboTimer);
    let idx = 0;
    for (let i = 0; i < opts.length; i++) if (opts[i].v === current) { idx = i; break; }
    ui.combo = { key: key, q: seed || '', idx: seed ? 0 : idx, fresh: true };
    render();
    setTimeout(() => focusKey('comboq:' + key), 0);
  }

  function comboClose(refocus) {
    if (!ui.combo) return;
    const key = ui.combo.key;
    clearTimeout(comboTimer);
    ui.combo = null;
    render();
    if (refocus) setTimeout(() => focusKey('combo:' + key), 0);
  }

  function comboTake(key, value, onPick) {
    clearTimeout(comboTimer);
    ui.combo = null;
    onPick(value);          // the caller commits + touch()es, which re-renders
    render();               // …but never assume it did
    setTimeout(() => focusKey('combo:' + key), 0);
  }

  /** True when `node` sits inside any combobox — used to decide an outside click. */
  function inCombo(node) {
    while (node && node !== document) {
      if (node.classList && node.classList.contains('wd-combo')) return true;
      node = node.parentNode;
    }
    return false;
  }

  /* Keep the keyboard-highlighted row on screen, and — the first paint after
     opening — the whole open field, which may have been below the fold of the
     scrolling sheet. Runs after restoreUi so it wins the scroll. */
  function syncComboScroll() {
    if (!ui.combo || !els.pane) return;
    const root = els.pane.querySelector('.wd-combo.open');
    /* Its field is gone — the sheet closed, or the assignment mode moved on.
       Drop the open state rather than leaving it armed for the next sheet that
       happens to reuse the key. Nothing is on screen, so no re-render needed. */
    if (!root) { ui.combo = null; return; }
    const list = root.querySelector('.wd-combo-list');
    const kb = list ? list.querySelector('.wd-pick.kb') : null;
    if (list && kb) {
      const top = kb.offsetTop, bot = top + kb.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
    }
    if (ui.combo.fresh) {
      ui.combo.fresh = false;
      const box = els.sheetBody;
      if (box && box.contains(root)) {
        const r = root.getBoundingClientRect(), b = box.getBoundingClientRect();
        if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom) + 8;
        else if (r.top < b.top) box.scrollTop -= (b.top - r.top) + 8;
      }
    }
  }

  /**
   * A searchable field.
   *   key      stable per field, so focus/caret survive the re-render
   *   opts     [{ v, label, sub, hue, warn }] — `warn` also flags the row
   *   current  the stored value ('' = nothing assigned)
   *   onPick   receives the new value; '' when it is cleared
   *   o        { placeholder, blank, empty, clearable (default true), label }
   */
  function combo(key, opts, current, onPick, o) {
    o = o || {};
    const clearable = o.clearable !== false;
    const open = !!(ui.combo && ui.combo.key === key);
    const cur = opts.find((x) => x.v === current) || null;
    const root = h('div', {
      class: 'wd-combo' + (open ? ' open' : '') + (cur && cur.warn ? ' warn' : ''),
    });
    const field = h('div', { class: 'wd-combo-field' });
    root.append(field);

    const clearBtn = (clearable && current)
      ? h('button', {
        class: 'wd-combo-clear', type: 'button', title: 'Clear this — leave it unassigned',
        'aria-label': 'Clear',
        onmousedown: (e) => e.preventDefault(),
        onclick: (e) => { e.stopPropagation(); comboTake(key, '', onPick); },
      }, '✕')
      : null;

    if (!open) {
      field.append(h('button', {
        class: 'wd-combo-btn' + (cur ? '' : ' empty'), type: 'button',
        data: { k: 'combo:' + key },
        title: (cur ? cur.label : (o.blank || 'Nothing chosen')) + ' — click or type to search',
        'aria-label': o.label || o.placeholder || 'Choose',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        onclick: (e) => { e.stopPropagation(); comboOpen(key, opts, current, ''); },
        onkeydown: (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' ||
              e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault(); e.stopPropagation();
            comboOpen(key, opts, current, '');
            return;
          }
          /* type-to-search straight off the closed field — no extra keypress */
          if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault(); e.stopPropagation();
            comboOpen(key, opts, current, e.key);
          }
        },
      },
        cur && cur.hue !== undefined
          ? h('span', { class: 'wd-swatch', style: 'background:' + hueCss(cur.hue, 55, 55) })
          : null,
        h('span', { class: 'wd-combo-v' }, cur ? cur.label : (o.blank || '— none —')),
        /* the flag stays readable with the list SHUT, exactly as the old
           "(missing in SOES)" option text did */
        cur && cur.warn ? h('span', { class: 'wd-combo-warn' }, cur.warn) : null,
        h('span', { class: 'wd-combo-caret', 'aria-hidden': 'true' }, '▾')));
      if (clearBtn) field.append(clearBtn);
      return root;
    }

    /* ---- open ---- */
    const c = ui.combo;
    const typed = String(c.q || '').trim();
    const rows = comboFilter(opts, c.q);
    const shown = rows.slice(0, COMBO_MAX);
    if (c.idx >= shown.length) c.idx = Math.max(0, shown.length - 1);
    if (c.idx < 0) c.idx = 0;

    const inp = h('input', {
      class: 'wd-combo-input', type: 'text', value: c.q,
      data: { k: 'comboq:' + key },
      autocomplete: 'off', spellcheck: 'false',
      placeholder: o.placeholder || 'Type to search…',
      'aria-label': o.label || o.placeholder || 'Search',
      role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list',
      oninput: () => {
        if (!ui.combo || ui.combo.key !== key) return;
        ui.combo.q = inp.value;
        ui.combo.idx = 0;
        clearTimeout(comboTimer);
        comboTimer = setTimeout(render, COMBO_DEBOUNCE);   // debounced re-filter
      },
      onkeydown: (e) => {
        if (!ui.combo || ui.combo.key !== key) return;
        /* any non-typing key acts on what has been typed SO FAR, so flush the
           pending re-filter first — otherwise Enter could take a row from a
           list the eye has not been shown yet */
        clearTimeout(comboTimer);
        const live = comboFilter(opts, ui.combo.q).slice(0, COMBO_MAX);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); comboClose(true); return; }
        /* Tab shuts the list and hands focus back to the field. It must NOT
           fall through: app.js's own Tab handler cycles the whole DECK tab
           unless the focus is one of its named edit inputs, so a stray Tab
           here would throw you out of the Wardrobe tab mid-assignment. */
        if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); comboClose(true); return; }
        if (e.key === 'ArrowDown') {
          e.preventDefault(); e.stopPropagation();
          ui.combo.idx = Math.min(live.length - 1, ui.combo.idx + 1); render(); return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation();
          ui.combo.idx = Math.max(0, ui.combo.idx - 1); render(); return;
        }
        if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); ui.combo.idx = 0; render(); return; }
        if (e.key === 'End') {
          e.preventDefault(); e.stopPropagation();
          ui.combo.idx = Math.max(0, live.length - 1); render(); return;
        }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          const r = live[ui.combo.idx];
          if (r) comboTake(key, r.v, onPick);
          else if (clearable && !String(ui.combo.q).trim()) comboTake(key, '', onPick);
          return;
        }
        e.stopPropagation();     // [ ] / F2 / Ctrl-A belong to the field now
      },
    });
    field.append(inp);
    if (clearBtn) field.append(clearBtn);

    const list = h('div', { class: 'wd-combo-list', role: 'listbox' });
    shown.forEach((r, i) => {
      list.append(h('button', {
        class: 'wd-pick' + (r.v === current ? ' in' : '') + (i === c.idx ? ' kb' : ''),
        type: 'button', role: 'option',
        'aria-selected': i === c.idx ? 'true' : 'false',
        onmousedown: (e) => e.preventDefault(),      // keep the caret in the field
        onclick: (e) => { e.stopPropagation(); comboTake(key, r.v, onPick); },
      },
        r.hue !== undefined
          ? h('span', { class: 'wd-swatch', style: 'background:' + hueCss(r.hue, 55, 55) })
          : null,
        h('span', { class: 'wd-pick-n' }, nameNodes(r.label, typed)),
        r.warn ? h('span', { class: 'wd-combo-warn' }, r.warn) : null,
        r.sub ? h('span', { class: 'wd-combo-sub' }, r.sub) : null,
        h('span', { class: 'wd-pick-x' }, r.v === current ? '✓' : '')));
    });
    if (!shown.length) {
      list.append(h('div', { class: 'wd-col-empty' },
        typed ? (o.empty || 'Nothing matches') + ' “' + typed + '”'
          : (o.emptyAll || 'Nothing to choose from yet')));
    } else if (rows.length > shown.length) {
      list.append(h('div', { class: 'wd-combo-more' },
        (rows.length - shown.length) + ' more — keep typing to narrow it'));
    }
    root.append(list);
    return root;
  }

  /* ================================================ whole-tab scale ===== *
   *  Rober: "i have no way of upscaling or resizing font like other windows".
   *  Same control, same range and same step as the Followers tab and the
   *  deck's own menu scale — 60%..160% in tens — so the three never disagree.
   *
   *  It drives ONE custom property, --wd-ui-scale, which #wd-scale turns into
   *  transform: scale(). transform does not reflow, so #wd-scale's layout box
   *  is divided by the scale and the painted result lands back inside the
   *  pane's real box (the same contract #panel and #fol-pane already use).
   *  Every px in this pane's stylesheet therefore rides it without knowing.
   */
  const UI_MIN = 0.6, UI_MAX = 1.6, UI_STEP = 0.1, UI_DEF = 1;

  function clampUi(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return UI_DEF;
    // Rounded to the step so repeated +/- cannot drift into 0.7999999.
    v = Math.round(v * 10) / 10;
    return Math.max(UI_MIN, Math.min(UI_MAX, v));
  }
  function curUi() { return clampUi(state.settings.uiScale); }

  function applyUiScale() {
    const v = curUi();
    document.documentElement.style.setProperty('--wd-ui-scale', String(v));
    const out = $('wd-ui-val');
    if (out) out.textContent = Math.round(v * 100) + '%';
    /* At the end of the range the button is spent — say so rather than leaving
       it looking live and doing nothing (same treatment as the Followers row). */
    const set = (id, off) => {
      const b = $(id);
      if (!b) return;
      b.disabled = !!off;
      b.classList.toggle('is-off', !!off);
    };
    set('wd-ui-dec', v <= UI_MIN + 1e-9);
    set('wd-ui-inc', v >= UI_MAX - 1e-9);
    set('wd-ui-reset', Math.abs(v - UI_DEF) < 1e-9);
  }

  function nudgeUi(delta) {
    state.settings.uiScale = delta === 0 ? UI_DEF : clampUi(curUi() + delta);
    applyUiScale();
    touch();     // persists the settings slice AND re-renders at the new size
  }

  /* Two-click delete, matching Domains' armed Forget: the first click arms and
   * relabels, the second commits. Disarms on a 4s timeout, on Esc, or when
   * anything else arms. No window.confirm — PrismaUI has none. */
  let armTimer = 0;
  function armedBtn(label, armedLabel, opts) {
    const o = opts || {};
    const isArmed = ui.armed === o.key;
    const b = h('button', {
      class: (o.class || 'wd-danger') + (isArmed ? ' armed' : ''), type: 'button',
      title: isArmed ? 'Click again to confirm' : (o.title || null),
      'aria-label': o.label || label,
      onclick: (e) => {
        e.stopPropagation();
        clearTimeout(armTimer);
        if (ui.armed !== o.key) {
          ui.armed = o.key;
          armTimer = setTimeout(() => { if (ui.armed === o.key) { ui.armed = null; render(); } }, 4000);
          render();
          return;
        }
        ui.armed = null;
        o.go();
      },
    }, isArmed ? armedLabel : label);
    return b;
  }

  /* ---- state preservation across a full re-render ----
   * Every edit calls touch() -> render(), which rebuilds the lists. Without
   * this, scrolling to outfit 40 and clicking it would jump you back to the
   * top, and typing in an inline field would lose the caret on the first
   * keystroke that commits. */
  function snapshotUi() {
    const a = document.activeElement;
    const snap = { scroll: {}, focus: null, sel: null };
    ['wd-body', 'wd-members', 'wd-catalogue', 'wd-sheet-body', 'wd-builder-cols'].forEach((id) => {
      const el = $(id);
      if (el) snap.scroll[id] = el.scrollTop;
    });
    if (a && a.dataset && a.dataset.k) {
      snap.focus = a.dataset.k;
      /* Carry the IN-FLIGHT value, not just the caret. A field only commits on
       * change/blur, so a render triggered by anything else mid-typing would
       * otherwise rebuild the input from state and silently eat what you'd
       * typed. */
      if (a.tagName === 'INPUT' && typeof a.value === 'string') snap.value = a.value;
      if (a.selectionStart != null) snap.sel = [a.selectionStart, a.selectionEnd];
    }
    return snap;
  }
  function restoreUi(snap) {
    Object.keys(snap.scroll).forEach((id) => {
      const el = $(id);
      if (el) el.scrollTop = snap.scroll[id];
    });
    if (!snap.focus) return;
    const el = els.pane.querySelector('[data-k="' + cssEsc(snap.focus) + '"]');
    if (!el) return;
    if (snap.value != null && el.tagName === 'INPUT' && el.value !== snap.value) el.value = snap.value;
    el.focus();
    if (snap.sel && el.setSelectionRange) {
      try { el.setSelectionRange(snap.sel[0], snap.sel[1]); } catch (e) { /* not a text input */ }
    }
  }

  function toast(msg) {
    const t = $('toast');
    if (!t) { console.log('[toast]', msg); return; }
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  /* ============================================================== save == */

  let saveTimer = 0;
  function savePayload() {
    return JSON.stringify({
      categories: state.categories,
      outfitMeta: state.outfitMeta,
      wardrobes: state.wardrobes,
      assignments: state.assignments,
      settings: state.settings,
    });
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { toGame('wdSave', savePayload()); }, SAVE_DEBOUNCE);
  }
  /* Save THIS INSTANT, cancelling the debounce. For the one case where the very
     next op reads what we just wrote out of the C++ config rather than out of
     its own payload — quickWear's assign-then-dress (Wardrobe::Dress looks the
     assignment up in `cfg`, so a 350 ms debounce would dress her in the OLD
     outfit, or refuse outright with "Nothing assigned"). */
  function saveNow() {
    clearTimeout(saveTimer);
    toGame('wdSave', savePayload());
  }
  function touch() { save(); render(); }

  /* ============================================================ search == */

  /** Does this outfit match the current filter (name, category names, note)? */
  function outfitMatches(name, q) {
    if (!q) return true;
    q = q.toLowerCase();
    if (name.toLowerCase().indexOf(q) !== -1) return true;
    const m = metaFor(name);
    if (!m) return false;
    if (m.note && m.note.toLowerCase().indexOf(q) !== -1) return true;
    return (m.categoryIds || []).some((id) => {
      const c = catById(id);
      return c && c.name.toLowerCase().indexOf(q) !== -1;
    });
  }
  function wardrobeMatches(w, q) {
    if (!q) return true;
    q = q.toLowerCase();
    if (w.name.toLowerCase().indexOf(q) !== -1) return true;
    if (w.note && w.note.toLowerCase().indexOf(q) !== -1) return true;
    return (w.outfits || []).some((n) => n.toLowerCase().indexOf(q) !== -1);
  }
  function npcMatches(n, q) {
    if (!q) return true;
    q = q.toLowerCase();
    if (String(n.name || '').toLowerCase().indexOf(q) !== -1) return true;
    const a = assignFor(keyOf(n));
    if (!a) return false;
    if (a.outfit && a.outfit.toLowerCase().indexOf(q) !== -1) return true;
    const w = a.wardrobeId ? wardrobeById(a.wardrobeId) : null;
    return !!(w && w.name.toLowerCase().indexOf(q) !== -1);
  }

  /* ============================================================ render == */

  function render() {
    if (!ui.inited) return;
    const snap = snapshotUi();
    renderNav();
    renderBanner();
    renderCats();
    renderBody();
    renderBuilder();
    renderSheet();
    renderPieces();
    renderPicker();
    els.edit.classList.toggle('on', ui.editing);
    els.edit.textContent = ui.editing ? 'Done' : 'Edit';
    els.edit.setAttribute('aria-pressed', ui.editing ? 'true' : 'false');
    els.clear.classList.toggle('hidden', !ui.filter);
    els.add.textContent = ui.sub === 'wardrobes' ? '＋ Wardrobe' : '＋ Category';
    els.add.classList.toggle('hidden', ui.sub === 'npcs' || ui.sub === 'inventory' || !!plugin());
    /* The tab's own chrome — scale — lives in edit mode, same idiom as the
       Followers tab's open-key/Faces/Tab row. */
    if (els.editRow) els.editRow.classList.toggle('hidden', !ui.editing);
    restoreUi(snap);
    syncComboScroll();
  }

  /** Reset paging + any armed delete whenever the visible set changes. */
  function resetPaging() {
    ui.limit = PAGE;
    ui.armed = null;
  }

  function renderNav() {
    els.nav.textContent = '';
    const counts = {
      outfits: state.soes.outfits.length,
      wardrobes: state.wardrobes.length,
      npcs: state.npcs.length,
      inventory: state.inventory.length,
    };
    Object.keys(PLUGINS).forEach((id) => {
      try { counts[id] = PLUGINS[id].count(); } catch (e) { counts[id] = 0; }
    });
    SUBS.forEach((s) => {
      els.nav.append(h('button', {
        class: 'wd-subtab' + (ui.sub === s ? ' active' : ''),
        type: 'button',
        title: 'Show the ' + (SUB_LABEL[s] || s) + ' section',
        'aria-current': ui.sub === s ? 'true' : null,
        onclick: () => {
          ui.sub = s; ui.filter = ''; els.search.value = ''; resetPaging();
          const p = PLUGINS[s];
          if (p) { try { p.setFilter(''); p.onEnter(); } catch (e) { console.log('[wardrobe] sub enter', s, e); } }
          if (s === 'npcs') refreshNffData();   // People shows NFF facts now
          render(); els.body.scrollTop = 0;
        },
      }, SUB_LABEL[s], h('span', { class: 'wd-subtab-n' }, String(counts[s]))));
    });
  }

  function renderBanner() {
    const b = els.banner;
    b.textContent = '';
    b.className = '';
    /* Three different states, and conflating them was actively misleading:
     *   pending  — we asked SOES and Papyrus has not answered yet. Normal, and
     *              can genuinely take a minute or two on a busy save. The tab
     *              fills itself in when it lands; no need to reopen anything.
     *   empty    — SOES answered, it simply has no outfits yet.
     *   absent   — nothing came back at all. THIS is the one worth worrying at.
     */
    if (!state.soes.available && state.soes.pending) {
      b.className = 'ok';
      b.append('Asking the outfit system for its wardrobe… Papyrus can take a minute ' +
        'on a busy save. This fills in on its own — you don’t need to reopen the tab.');
      return;
    }
    if (!state.soes.available) {
      b.className = '';
      b.append('SOES-NG is not answering — outfits can’t be listed or applied. ' +
        'Check that both Skyrim Outfit Equipment System NG and Hotkey Deck - Wardrobe ' +
        'Executor are ticked in MO2.');
      return;
    }
    /* An actor tracked by SOES with nothing resolvable is the documented
     * strip-loop crash (troubleshooting/soes_ng_crash_issue.md). Say so loudly. */
    const naked = state.npcs.filter((n) => {
      if (!n.tracked) return false;
      const a = assignFor(keyOf(n));
      return !a || a.mode === 'off';
    });
    const clash = state.npcs.filter((n) => n.conflict);
    /* Warnings fold behind a chevron, CLOSED by default (Rober, 2026-08-03):
       the situations are real but standing — three deliberately-parked
       followers would otherwise shout the same paragraph at every tab open.
       The closed line still carries the COUNT and the danger word, so it is a
       visible flag, not a hidden one; the detail is one click away. Session
       state only — a new session re-collapses, which is the point. */
    const foldWarn = (headline, detail) => {
      b.append(h('button', {
        class: 'ghost-btn wd-warn-fold', type: 'button',
        'aria-expanded': ui.warnOpen ? 'true' : 'false',
        title: ui.warnOpen ? 'Collapse the warning detail' : 'Show who, and what to do about it',
        onclick: () => { ui.warnOpen = !ui.warnOpen; render(); },
      }, (ui.warnOpen ? '▾ ' : '▸ ') + headline));
      if (ui.warnOpen) b.append(h('div', { class: 'wd-warn-detail' }, detail));
    };
    if (naked.length) {
      foldWarn('⚠ ' + naked.length + ' tracked ' + (naked.length === 1 ? 'person has' : 'people have') +
        ' no outfit assigned',
        naked.slice(0, 6).map((n) => n.name).join(', ') + (naked.length > 6 ? '…' : '') +
        '. SOES strips a tracked actor it can’t dress — give them a wardrobe or untrack them.');
      return;
    }
    if (clash.length) {
      foldWarn('⚠ ' + clash.length + ' ' + (clash.length === 1 ? 'person is' : 'people are') +
        ' assigned in BOTH SOES and Tailor',
        clash.slice(0, 6).map((n) => n.name).join(', ') + (clash.length > 6 ? '…' : '') +
        ' — the two will fight over their clothes. Clear one of the two.');
      return;
    }
    b.className = 'hidden';
  }

  /** Categories double as filter pills and as the place you rename/delete them. */
  function renderCats() {
    els.cats.textContent = '';
    const show = ui.sub === 'outfits' && (state.categories.length > 0);
    els.cats.classList.toggle('hidden', !show);
    if (!show) return;

    els.cats.append(h('button', {
      class: 'wd-cat-pill' + (ui.catFilter ? '' : ' on'), type: 'button',
      onclick: () => { ui.catFilter = ''; resetPaging(); render(); },
    }, 'All'));

    state.categories.forEach((c) => {
      const on = ui.catFilter === c.id;
      const pill = h('button', {
        class: 'wd-cat-pill' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => { ui.catFilter = on ? '' : c.id; resetPaging(); render(); },
      }, h('span', { class: 'wd-swatch', style: 'background:' + hueCss(c.hue, 55, 55) }));

      if (ui.editing) {
        pill.append(inlineInput(c.name, {
          key: 'cat:' + c.id, required: true, label: 'Category name',
          commit: (v) => { c.name = v; touch(); },
        }));
        pill.append(armedBtn('✕', '✓?', {
          class: 'wd-cat-x', key: 'delcat:' + c.id,
          title: 'Delete this category (outfits keep their other tags)',
          label: 'Delete category ' + c.name,
          go: () => {
            state.outfitMeta.forEach((m) => {
              m.categoryIds = (m.categoryIds || []).filter((x) => x !== c.id);
            });
            state.categories = state.categories.filter((x) => x.id !== c.id);
            if (ui.catFilter === c.id) ui.catFilter = '';
            touch();
          },
        }));
      } else {
        const n = state.outfitMeta.filter((m) => (m.categoryIds || []).indexOf(c.id) !== -1).length;
        pill.append(c.name, h('span', { style: 'opacity:.6;font-size:11px' }, String(n)));
      }
      els.cats.append(pill);
    });
  }

  function renderBody() {
    els.selbar.textContent = '';
    /* selection is per-tab: outfit names and wardrobe ids must never mix */
    if (ui.sub !== 'outfits' && ui.sub !== 'wardrobes') selClear();
    els.list.textContent = '';
    els.empty.classList.add('hidden');
    const selBar = renderSelBar();
    if (selBar) els.selbar.append(selBar);
    els.list.classList.toggle('grid', ui.sub === 'outfits' || ui.sub === 'wardrobes');

    /* A plug-in sub-tab owns its whole body, including its own loading state —
     * ui.loading here is about SOES's catalogue, which is none of its business. */
    const p = plugin();
    if (p) {
      let n = 0;
      try {
        p.setFilter(ui.filter);
        /* `soes` is handed over READ-ONLY so a plug-in can offer the outfit
         * catalogue without opening a second path to SOES. wardrobe-nff.js uses
         * it for "copy this outfit's clothes into an NFF set". */
        n = p.render({ list: els.list, pane: els.pane, body: els.body,
          toast: toast, render: render, soes: state.soes });
      }
      catch (e) { console.log('[wardrobe] sub render', ui.sub, e); glog('sub render ' + ui.sub + ' ' + e); }
      els.count.textContent = n < 0 ? '—' : String(n);
      return;
    }

    /* First paint before any data has landed: skeletons sized like the real
     * thing, so nothing jumps when wdOpen arrives. */
    if (ui.loading) {
      const card = ui.sub === 'outfits' || ui.sub === 'wardrobes';
      for (let i = 0; i < (card ? 8 : 5); i++) {
        els.list.append(card
          ? h('div', { class: 'wd-skel card', 'aria-hidden': 'true' },
            h('div', { class: 'wd-skel-thumb' }), h('div', { class: 'wd-skel-body' }))
          : h('div', { class: 'wd-skel row', 'aria-hidden': 'true' }));
      }
      els.count.textContent = '—';
      return;
    }

    const q = ui.filter;
    let n = 0;
    if (ui.sub === 'outfits') n = renderOutfits(q);
    else if (ui.sub === 'wardrobes') n = renderWardrobes(q);
    else if (ui.sub === 'inventory') n = renderInventory(q);
    else n = renderNpcs(q);

    els.count.textContent = String(n);
    if (!n) showEmpty(q);
  }

  /** Render at most ui.limit of `items`, with a "show more" tail when clipped. */
  function paged(items, draw) {
    const total = items.length;
    const shown = Math.min(total, ui.limit);
    for (let i = 0; i < shown; i++) els.list.append(draw(items[i]));
    if (total > shown) {
      const rest = total - shown;
      els.list.append(h('button', {
        class: 'wd-more', type: 'button',
        title: 'Show more rows',
        onclick: () => { ui.limit += PAGE; render(); },
      }, 'Show ' + Math.min(rest, PAGE) + ' more — ' + rest + ' still hidden'));
    }
    return total;
  }

  function showEmpty(q) {
    els.empty.textContent = '';
    els.empty.classList.remove('hidden');
    if (q) {
      els.empty.append(
        h('span', { class: 'wd-empty-h' }, 'Nothing matches “' + q + '”'),
        'Try a shorter search, or clear it to see everything.'
      );
      return;
    }
    if (ui.sub === 'outfits') {
      els.empty.append(
        h('span', { class: 'wd-empty-h' }, 'No outfits yet'),
        'Outfits come from SOES-NG. Build one in its MCM (or ask Claude to make one from your ' +
        'inventory), then it shows up here to be photographed and pooled.'
      );
    } else if (ui.sub === 'wardrobes') {
      els.empty.append(
        h('span', { class: 'wd-empty-h' }, 'No wardrobes yet'),
        'A wardrobe is a pool of outfits someone rotates through. ',
        h('br'), 'Hit ',
        h('strong', null, '＋ Wardrobe'), ' to make your first one.'
      );
    } else if (ui.sub === 'inventory') {
      els.empty.append(
        h('span', { class: 'wd-empty-h' }, 'No armour in your inventory'),
        'Pick some up and reopen this tab — everything you are carrying shows here, ready to ' +
        'be assembled into an outfit.'
      );
    } else {
      els.empty.append(
        h('span', { class: 'wd-empty-h' }, 'Nobody here'),
        'Followers and tracked actors appear here once the game is running.'
      );
    }
  }

  /* =================================== outfit photo crop (WYSIWYG) ====== *
   *  The twin of the Followers tab's portrait crop (followers-pane.js), for
   *  the pictures photo mode takes of OUTFITS. Same model, same invariant,
   *  same reasons — read that block for the long form; what follows is what is
   *  DIFFERENT here, because those differences are the whole risk.
   *
   *  WHY A CROP AT ALL. Photo mode hands you the camera, but you are framing a
   *  live 3D scene through a free camera and the card is a 3:4 letterbox — a
   *  shot that looked right while flying reads as "head cut off / boots in the
   *  middle" once it is cover-fitted into a 178px tile. The plugin cannot
   *  re-cut the pixels (portrait_capture.cpp ships a hand-rolled PNG ENCODER
   *  and no decoder), so this pans/zooms the picture the deck already draws
   *  with a CSS transform and remembers the numbers. The preview is not a
   *  preview — it IS the result.
   *
   *  THE MODEL, { z, x, y }: z is the display zoom (1 = the whole cover-fitted
   *  frame); x/y are the pan as FRACTIONS of the frame's own width/height, so
   *  ONE crop is right on a 22px builder chip, a 26px wardrobe-strip tile, a
   *  178px card and the big editor alike. The invariant |x|,|y| <= (z-1)/2 is
   *  the slack the zoom creates, and it holds per-axis on a NON-SQUARE frame
   *  too: a percentage translate resolves against the element's own box, so
   *  the left edge lands at W*(0.5 - z/2 + x) and the maths is identical in
   *  both axes whatever the aspect. Enforced in clampCrop() here and in
   *  Wardrobe::ClampImageCrop() there, because either side can be the last to
   *  touch a value and hotkeys.json is hand-editable.
   *
   *  IDENTITY IS THE IMAGE FILE NAME, never the outfit. Two consequences we
   *  want: renaming an outfit keeps its framing, and a RE-SHOT photo (which
   *  lands as `<slug>~<unixtime>.png` whenever the old file is still mapped by
   *  the renderer — and the deck has invariably drawn the card, so it is)
   *  arrives under a name this map has never seen and is drawn as shot. The
   *  key is the bare file name: `icons/custom/wd-x.png?v=173…` -> `wd-x.png`,
   *  because the stored `image` carries both a folder and a cache-buster.
   *
   *  WHY A LAYER RATHER THAN THE TILE. The tile owns its size, its border and
   *  its rounded clip; transforming IT would scale the clip with the picture
   *  and shoulder the grid apart (the portrait work hit exactly this and had
   *  to grow a wrapper). So every draw site keeps its box and gets a `.wd-art`
   *  child that owns the background and the transform, clipped by the box's
   *  own overflow. That also keeps the ★/badge/⋯ chrome unscaled.
   * ====================================================================== */
  const CROP_ZMIN = 1, CROP_ZMAX = 4;
  const CROP_ZSTEP = 1.15;    // multiplicative: one click feels the same at 1.1x and at 3x
  const CROP_PAN_STEP = 0.03; // per nudge click, in frame fractions
  /* Mirrored in wardrobe.h kMaxImageCrops. C++ prunes against the real
     icons/custom/ folder on every save, so this only ever bites a hand-edited
     config — but a map the plugin re-reads at every load deserves a ceiling on
     both sides. */
  const CROP_MAX_ENTRIES = 400;

  function isIdentityCrop(c) { return !c || (c.z === 1 && c.x === 0 && c.y === 0); }

  /* The one place the invariant lives on this side. Returns a valid crop, or
     null for "nothing to apply" — an identity crop is deliberately NOT stored,
     so the map holds only pictures you actually re-framed. */
  function clampCrop(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : Number(v);
    let z = num(raw.z);
    if (!isFinite(z)) z = 1;
    z = Math.max(CROP_ZMIN, Math.min(CROP_ZMAX, z));
    const lim = (z - 1) / 2;
    let x = num(raw.x), y = num(raw.y);
    if (!isFinite(x)) x = 0;
    if (!isFinite(y)) y = 0;
    x = Math.max(-lim, Math.min(lim, x));
    y = Math.max(-lim, Math.min(lim, y));
    // Round to the precision the config stores, so a value that survives a
    // round trip through JSON compares equal to the one we sent.
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const c = { z: r4(z), x: r4(x), y: r4(y) };
    return isIdentityCrop(c) ? null : c;
  }

  /* `icons/custom/wd-sfancy-blue.png?v=1730…` -> `wd-sfancy-blue.png`. Anything
     that could name something other than a plain sibling inside icons/custom/
     yields '' and is therefore uncroppable rather than sanitised — the same
     rule C++ applies before it will store a key. */
  function cropKeyOf(image) {
    let s = String(image || '').trim();
    if (!s) return '';
    const cut = s.indexOf('?');
    if (cut !== -1) s = s.slice(0, cut);
    const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (slash !== -1) s = s.slice(slash + 1);
    if (!s || s === '.' || s === '..' || s.length > 160 || s.indexOf(':') !== -1) return '';
    return s;
  }

  function cropFor(image) {
    const k = cropKeyOf(image);
    return (k && state.imageCrops[k]) ? state.imageCrops[k] : null;
  }

  function cropTransform(c) {
    return 'translate(' + (c.x * 100).toFixed(3) + '%,' + (c.y * 100).toFixed(3) + '%) scale(' +
      c.z.toFixed(4) + ')';
  }

  /* THE one draw site. Every place the deck paints an outfit picture calls
     this, so a crop can never apply on the card and not on the builder chip.
     Appended FIRST so the absolutely-positioned chrome (★, piece count, ⋯)
     still paints over it — among positioned siblings with auto z-index, DOM
     order is paint order. */
  function setArt(host, image) {
    if (!host) return host;
    const url = String(image || '');
    if (!url) return host;
    const art = h('div', { class: 'wd-art', 'aria-hidden': 'true' });
    art.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
    const c = cropFor(url);
    if (c) {
      art.style.transformOrigin = '50% 50%';
      art.style.transform = cropTransform(c);
    }
    host.append(art);
    return host;
  }

  /* "180% · ↑12% ←4%" — the numbers as a human reads them, not as they are
     stored. Up/left are negative offsets; saying "y -0.12" out loud is how you
     end up nudging the wrong way twice. */
  function cropPhrase(c) {
    if (!c) return 'original framing';
    const parts = [Math.round(c.z * 100) + '%'];
    if (c.y) parts.push((c.y < 0 ? '↑' : '↓') + Math.round(Math.abs(c.y) * 100) + '%');
    if (c.x) parts.push((c.x < 0 ? '←' : '→') + Math.round(Math.abs(c.x) * 100) + '%');
    return parts.join(' · ');
  }

  /* ---- the large view + editor -----------------------------------------
     Built in JS and hung off document.body, not off #wd-pane. TWO reasons,
     both load-bearing: #wd-scale carries a CSS transform (the tab zoom), and
     the drag maths divides POINTER travel (screen px) by the frame's layout
     width — inside a scaled ancestor those two units differ and the pan gain
     would be silently wrong in game and right in the harness. And an overlay
     that outlives its pane is the classic way to end up with an unclickable
     deck, so every exit path goes through closeArt(). */
  let artBox = null;    // the overlay node, or null
  let artEdit = null;   // live edit state while editing, else null

  function closeArt() {
    if (!artBox) return;
    if (artEdit && artEdit.unwire) artEdit.unwire();
    if (artBox.parentNode) artBox.parentNode.removeChild(artBox);
    artBox = null;
    artEdit = null;
  }

  /* Sized in px by JS on purpose — see the drag comment above. 3:4 because
     that is `.wd-thumb`'s aspect: the editor's whole promise is that what you
     frame here is what the card draws, and that can only be true if the two
     surfaces letterbox the picture identically. */
  function artFrameSize() {
    const w = window.innerWidth || 1280, hgt = window.innerHeight || 720;
    const h2 = Math.max(240, Math.round(Math.min(560, hgt * 0.62, w * 0.62 * (4 / 3))));
    return { w: Math.round(h2 * 3 / 4), h: h2 };
  }

  /* `name` is the outfit the picture belongs to — shown as the caption and
     used in the toast, never as the crop key. */
  function openArt(name, image, startEditing) {
    closeArt();
    const url = String(image || '');
    if (!cropKeyOf(url)) return;                 // nothing addressable to crop
    const size = artFrameSize();
    const art = h('div', { class: 'wd-art' });
    art.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
    const frame = h('div', { class: 'wd-art-frame' }, art);
    frame.style.width = size.w + 'px';
    frame.style.height = size.h + 'px';
    applyArtCrop(art, cropFor(url));

    const foot = h('div', { class: 'wd-art-foot' });
    artBox = h('div', {
      class: 'wd-art-lb',
      /* Backdrop click closes — but ONLY while not editing. A pan that ends
         with the pointer outside the frame releases on the backdrop, and
         throwing the edit away for that would be indistinguishable from a bug. */
      onClick: function () { if (!artEdit) closeArt(); },
      title: 'Click anywhere to close',
    }, h('div', {
      class: 'wd-art-inner',
      onClick: function (e) { e.stopPropagation(); },
    }, frame, name ? h('div', { class: 'wd-art-cap' }, String(name)) : null, foot));
    document.body.append(artBox);

    artEdit = null;
    renderArtFoot(name, url, art, frame, foot);
    if (startEditing) beginCrop(name, url, art, frame, foot);
  }

  function applyArtCrop(art, c) {
    if (!art) return;
    if (c) {
      art.style.transformOrigin = '50% 50%';
      art.style.transform = cropTransform(c);
    } else {
      art.style.transform = '';
    }
  }

  /* Not editing: one button, and the current framing spelled out so you can
     see at a glance whether this picture carries a crop at all. */
  function renderArtFoot(name, url, art, frame, foot) {
    foot.textContent = '';
    const c = cropFor(url);
    foot.append(h('button', {
      class: 'wd-art-btn', type: 'button',
      title: 'Pan and zoom this photo. Nothing is re-saved to disk — the deck '
           + 'remembers the framing and draws it everywhere this picture appears.',
      onClick: function (e) { e.stopPropagation(); beginCrop(name, url, art, frame, foot); },
    }, '✎ Adjust this photo'));
    foot.append(h('span', { class: 'wd-art-val' }, c ? cropPhrase(c) : 'original framing'));
  }

  /* Everything is a BUTTON or a drag: no <input type=range> and no <select>,
     because in Ultralight the first is a poor target and the second renders
     but never opens. The wheel is a convenience only — every gesture it offers
     has a button beside it, so a click-only flow reaches every value. */
  function beginCrop(name, url, art, frame, foot) {
    const start = cropFor(url);
    artEdit = {
      url: url, z: start ? start.z : 1, x: start ? start.x : 0, y: start ? start.y : 0,
      /* Everything the keyboard path needs to finish the edit. artKey() sees
         only `artEdit`, and re-deriving these from the DOM would be a second,
         drift-prone way of naming the same nodes. */
      ctx: { name: name, url: url, art: art, frame: frame, foot: foot },
    };
    frame.classList.add('editing');
    renderCropFoot(name, url, art, frame, foot);
    wireCropGestures(art, frame, foot);
  }

  /* Apply artEdit to the on-screen picture WITHOUT re-rendering anything:
     rebuilding mid-gesture would replace the element the pointer is on and the
     drag would die on its first pixel. */
  function previewCrop(art, foot) {
    if (!artEdit) return;
    const c = clampCrop(artEdit);
    artEdit.z = c ? c.z : 1;
    artEdit.x = c ? c.x : 0;
    artEdit.y = c ? c.y : 0;
    applyArtCrop(art, c);
    const val = foot.querySelector('.wd-art-val');
    if (val) val.textContent = cropPhrase(c);
    const rst = foot.querySelector('.wd-art-reset');
    if (rst) rst.disabled = !c;
  }

  function nudgeCrop(art, foot, dz, dx, dy) {
    if (!artEdit) return;
    if (dz) artEdit.z = artEdit.z * dz;
    if (dx) artEdit.x = artEdit.x + dx;
    if (dy) artEdit.y = artEdit.y + dy;
    previewCrop(art, foot);
  }

  function renderCropFoot(name, url, art, frame, foot) {
    foot.textContent = '';
    const btn = (glyph, tip, fn, cls) => h('button', {
      class: 'wd-art-btn' + (cls ? ' ' + cls : ''), type: 'button', title: tip,
      onClick: function (e) { e.stopPropagation(); fn(); },
    }, glyph);

    const pad = h('div', { class: 'wd-art-pad' },
      btn('＋', 'Zoom in — closer on the outfit', () => nudgeCrop(art, foot, CROP_ZSTEP, 0, 0)),
      btn('－', 'Zoom out — more of the photo', () => nudgeCrop(art, foot, 1 / CROP_ZSTEP, 0, 0)),
      btn('◀', 'Move the photo left', () => nudgeCrop(art, foot, 0, -CROP_PAN_STEP, 0)),
      btn('▲', 'Move the photo up', () => nudgeCrop(art, foot, 0, 0, -CROP_PAN_STEP)),
      btn('▼', 'Move the photo down', () => nudgeCrop(art, foot, 0, 0, CROP_PAN_STEP)),
      btn('▶', 'Move the photo right', () => nudgeCrop(art, foot, 0, CROP_PAN_STEP, 0)),
    );

    const reset = btn('⟲ Reset', 'Back to the photo as it was taken',
      () => { artEdit.z = 1; artEdit.x = 0; artEdit.y = 0; previewCrop(art, foot); }, 'wd-art-reset');
    reset.disabled = !clampCrop(artEdit);

    foot.append(pad, reset,
      btn('✓ Save', 'Use this framing everywhere this picture is drawn',
        () => commitCrop(name, url, art, frame, foot), 'ok'),
      btn('✕ Cancel', 'Leave the framing as it was',
        () => cancelCrop(name, url, art, frame, foot)),
      h('span', { class: 'wd-art-val' }, cropPhrase(clampCrop(artEdit))),
      h('div', { class: 'wd-art-hint' },
        'Drag the photo to move it · wheel or ＋/－ to zoom · this changes how the '
        + 'deck DRAWS it, the file on disk is untouched'));
  }

  function wireCropGestures(art, frame, foot) {
    let dragging = false, lastX = 0, lastY = 0;
    /* Gain: one pixel of pointer travel moves the picture one pixel, the only
       mapping that feels like dragging a photo. x is a fraction of the frame's
       WIDTH and y of its HEIGHT, and this frame is 3:4 — so unlike the square
       portrait editor the two axes need their own divisor. */
    const fw = frame.offsetWidth || artFrameSize().w;
    const fh = frame.offsetHeight || artFrameSize().h;

    frame.addEventListener('mousedown', function (e) {
      if (!artEdit) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      frame.classList.add('dragging');
    });
    /* Listened on the DOCUMENT, not the frame: at high zoom the pointer leaves
       the frame long before the pan hits its limit, and a move handler bound
       to the frame would stop tracking exactly when the gesture gets
       interesting. */
    const onMove = function (e) {
      if (!dragging || !artEdit) return;
      artEdit.x += (e.clientX - lastX) / fw;
      artEdit.y += (e.clientY - lastY) / fh;
      lastX = e.clientX; lastY = e.clientY;
      previewCrop(art, foot);
    };
    const onUp = function () {
      if (!dragging) return;
      dragging = false;
      frame.classList.remove('dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    /* The listeners outlive the frame unless we take them off, and this
       overlay opens many times a session. Hang the teardown off artEdit so
       every exit path (Save, Cancel, Esc, tab change) runs it exactly once. */
    artEdit.unwire = function () {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    frame.addEventListener('wheel', function (e) {
      if (!artEdit) return;
      e.preventDefault(); e.stopPropagation();
      nudgeCrop(art, foot, e.deltaY < 0 ? CROP_ZSTEP : 1 / CROP_ZSTEP, 0, 0);
    });
  }

  function endCropMode(frame) {
    if (artEdit && artEdit.unwire) artEdit.unwire();
    artEdit = null;
    if (frame) frame.classList.remove('editing', 'dragging');
  }

  function cancelCrop(name, url, art, frame, foot) {
    endCropMode(frame);
    applyArtCrop(art, cropFor(url));       // back to whatever is stored
    renderArtFoot(name, url, art, frame, foot);
  }

  function commitCrop(name, url, art, frame, foot) {
    const c = clampCrop(artEdit);
    const key = cropKeyOf(url);
    endCropMode(frame);
    if (!key) return;
    /* Optimistic: the map is updated here and every drawn tile repaints now.
       C++ owns the file, so it will push the authoritative map back as
       `wdCrops` — including a prune we cannot compute here — and that wins. */
    if (c) state.imageCrops[key] = c;
    else delete state.imageCrops[key];
    /* `clear` rather than a z=1 crop, so C++ never has to decide whether an
       identity crop means "remove me" — the two are the same thing and saying
       it explicitly keeps the map free of rows that draw nothing. */
    toGame('wdCropSave', JSON.stringify(c
      ? { file: key, z: c.z, x: c.x, y: c.y }
      : { file: key, clear: true }));
    applyArtCrop(art, c);
    renderArtFoot(name, url, art, frame, foot);
    render();
    toast(c ? 'Framing saved' : 'Framing reset');
  }

  /* Swallow a whole map from C++. Every value goes through the same clamp the
     editor uses, and every key through the same file-name rule — the payload
     ultimately comes from hotkeys.json, which is hand-editable. The ceiling is
     applied on the way in so a bloated config cannot make every render walk a
     huge map. */
  function setCrops(src) {
    const map = {};
    let n = 0;
    Object.keys(src || {}).forEach((k) => {
      if (n >= CROP_MAX_ENTRIES) return;
      const key = cropKeyOf(k);
      if (!key || key !== k) return;      // keys are bare file names, not paths
      const c = clampCrop(src[k]);
      if (!c) return;
      map[key] = c;
      n++;
    });
    state.imageCrops = map;
  }

  /* Arrows/±/Enter/Esc while the editor is up. Returns true when it owned the
     key — the pane's own keydown asks this FIRST, because '+' and '-' would
     otherwise be swallowed by "any printable key jumps to search". */
  function artKey(e) {
    /* The item lightbox is topmost when open; it eats Escape ahead of the art
       overlay and everything below, same layering rule as the followers pane. */
    if (document.getElementById('wd-item-lightbox')) {
      if (e.key === 'Escape') { closeItemLightbox(); return true; }
    }
    if (!artBox) return false;
    if (!artEdit) {
      if (e.key === 'Escape') { closeArt(); return true; }
      return false;
    }
    const c = artEdit.ctx;
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (pan) { nudgeCrop(c.art, c.foot, 0, pan[0] * CROP_PAN_STEP, pan[1] * CROP_PAN_STEP); return true; }
    if (e.key === '+' || e.key === '=') { nudgeCrop(c.art, c.foot, CROP_ZSTEP, 0, 0); return true; }
    if (e.key === '-' || e.key === '_') { nudgeCrop(c.art, c.foot, 1 / CROP_ZSTEP, 0, 0); return true; }
    if (e.key === 'Enter') { commitCrop(c.name, c.url, c.art, c.frame, c.foot); return true; }
    if (e.key === 'Escape') { cancelCrop(c.name, c.url, c.art, c.frame, c.foot); return true; }
    return false;
  }

  /* ---------------------------------------------------------- outfits -- */

  function renderOutfits(q) {
    const names = soesNames().filter((nm) => {
      if (!outfitMatches(nm, q)) return false;
      if (!ui.catFilter) return true;
      const m = metaFor(nm);
      return !!(m && (m.categoryIds || []).indexOf(ui.catFilter) !== -1);
    });
    /* favourites first, then alphabetical — stable and predictable at 200 outfits */
    names.sort((a, b) => {
      const fa = (metaFor(a) || {}).fav ? 0 : 1, fb = (metaFor(b) || {}).fav ? 0 : 1;
      return fa !== fb ? fa - fb : a.localeCompare(b);
    });
    return paged(names, (nm) => outfitCard(nm, q));
  }

  function outfitCard(name, q) {
    const m = metaFor(name) || {};
    const o = soesOutfit(name);
    const thumb = h('div', { class: 'wd-thumb' });
    if (m.image) {
      setArt(thumb, m.image);
      /* The way in to the big view, on the one corner nothing else uses (⋯ is
         top-left, ★ top-right, the piece count bottom-left). Hover/focus
         revealed like ⋯, and a plain click rather than a drag target: the card
         itself is a select toggle, so the picture cannot BE the button. */
      thumb.append(h('span', {
        class: 'wd-crop', role: 'button', tabindex: '0',
        title: 'See this photo big — and pan/zoom how the card frames it',
        onClick: (e) => { e.stopPropagation(); openArt(name, m.image, false); },
        onKeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
          e.preventDefault(); e.stopPropagation(); openArt(name, m.image, false);
        },
      }, '⛶'));
    } else thumb.append(h('span', { class: 'wd-thumb-ph' }, hangerIcon()));
    if (m.fav) thumb.append(h('span', { class: 'wd-fav', title: 'Favourite' }, '★'));
    /* An outfit you just MADE is in the list before SOES has confirmed it (C++
       merges it in as `pending`), and its piece count is not knowable yet — so
       say "confirming…" rather than print "0 pcs", which reads as a failed
       build. It becomes a real count the moment SOES's export lands, which the
       plugin now watches for. */
    if (o && o.pending) {
      thumb.append(h('span', { class: 'wd-badge is-pending',
        title: 'Made — waiting for SOES to confirm it. This can take a minute.' },
        'confirming…'));
    } else if (o) {
      thumb.append(h('span', { class: 'wd-badge' }, o.items + (o.items === 1 ? ' pc' : ' pcs')));
    }

    const chips = h('div', { class: 'wd-chips' });
    (m.categoryIds || []).forEach((id) => {
      const c = catById(id);
      if (c) chips.append(h('span', { class: 'wd-chip', style: 'color:' + hueCss(c.hue, 45, 72) }, c.name));
    });
    /* which wardrobes hold this outfit — the answer to "why is she wearing this?" */
    const inW = state.wardrobes.filter((w) => (w.outfits || []).indexOf(name) !== -1);
    inW.slice(0, 2).forEach((w) => chips.append(h('span', { class: 'wd-chip gold' }, '◇ ' + w.name)));
    if (inW.length > 2) chips.append(h('span', { class: 'wd-chip' }, '+' + (inW.length - 2)));

    /* Renaming replaces the NAME with a field, in place. Enter commits, Esc
       backs out, and the field is the only thing on the card that takes the
       keyboard while it is open. */
    const nameNode = (ui.renaming === name)
      ? inlineInput(name, {
          key: 'orename:' + name, required: true,
          label: 'Rename ' + name, placeholder: 'Outfit name',
          title: 'Enter to rename in SOES too, Esc to leave it alone',
          commit: (v) => {
            ui.renaming = null;
            if (v === name) { render(); return; }
            if (v.indexOf('|') !== -1) { toast('Outfit names can\u2019t contain “|”'); render(); return; }
            if (state.soes.outfits.some((o) => o.name === v)) {
              toast('There is already an outfit called “' + v + '”'); render(); return;
            }
            /* Optimistic on OUR side so the card reads right at once; C++ does
               the same re-pointing authoritatively and pushes wdState back. */
            const mm = metaFor(name); if (mm) mm.name = v;
            state.wardrobes.forEach((w) => {
              w.outfits = (w.outfits || []).map((x) => (x === name ? v : x));
            });
            state.assignments.forEach((a) => {
              if (a.outfit === name) a.outfit = v;
              (a.locationOverrides || []).forEach((o2) => { if (o2.outfit === name) o2.outfit = v; });
            });
            toGame('wdRename', JSON.stringify({ name: name, to: v }));
            render();
            toast('Renaming to “' + v + '”…');
          },
        })
      : h('div', { class: 'wd-card-name' }, nameNodes(name, q));
    if (ui.renaming === name) {
      /* The menu that opened this is gone by now, so nothing else will focus it. */
      setTimeout(() => {
        const f = els.pane.querySelector('[data-k="orename:' + cssEsc(name) + '"]');
        if (f && document.activeElement !== f) { f.focus(); f.select(); }
      }, 0);
    }
    const body = h('div', { class: 'wd-card-body' },
      nameNode,
      chips.childNodes.length ? chips : null);
    /* In edit mode the note is typed straight on the card — the deck has no
     * prompt dialog, so in-place is the only way to take text. */
    if (ui.editing) {
      body.append(inlineInput(m.note || '', {
        key: 'onote:' + name, class: 'note', label: 'Note for ' + name,
        placeholder: 'Add a note…',
        commit: (v) => { ensureMeta(name).note = v; touch(); },
      }));
    }

    const card = h('button', {
      class: 'wd-card' + (selHas(name) ? ' sel' : ''), type: 'button',
      data: { k: 'ocard:' + name, sel: name },
      'aria-pressed': selHas(name) ? 'true' : 'false',
      title: name + (m.note ? ' — ' + m.note : '') +
        '\nClick to select · Ctrl/Shift for more · ⋯ for options',
      oncontextmenu: (e) => { e.preventDefault(); outfitMenu(e, name); },
      onclick: (e) => selToggle(name, e),
    }, thumb, body);
    /* Right-click is unreliable inside PrismaUI and undiscoverable anywhere, so
     * every card carries its own menu button. */
    card.append(h('span', {
      class: 'wd-dots', role: 'button', title: 'Options',
      onclick: (e) => { e.stopPropagation(); outfitMenu(e, name); },
    }, '⋯'));
    return card;
  }

  /* -------------------------------------------------------- wardrobes -- */

  function renderWardrobes(q) {
    return paged(state.wardrobes.filter((w) => wardrobeMatches(w, q)), (w) => wardrobeCard(w, q));
  }

  function wardrobeCard(w, q) {
    const members = (w.outfits || []);
    const thumb = h('div', { class: 'wd-thumb' });
    const lead = members.map(metaFor).find((m) => m && m.image);
    if (lead) setArt(thumb, lead.image);
    else thumb.append(h('span', { class: 'wd-thumb-ph' }, stackIcon()));
    thumb.append(h('span', { class: 'wd-badge' }, members.length + (members.length === 1 ? ' outfit' : ' outfits')));

    const strip = h('div', { class: 'wd-strip' });
    members.slice(0, 5).forEach((nm) => {
      const mm = metaFor(nm);
      const t = h('div', { class: 'wd-strip-i', title: nm });
      if (mm && mm.image) setArt(t, mm.image);
      strip.append(t);
    });
    if (members.length > 5) strip.append(h('span', { class: 'wd-strip-more' }, '+' + (members.length - 5)));

    const missing = members.filter(isMissing).length;
    const chips = h('div', { class: 'wd-chips' });
    const users = state.assignments.filter((a) => a.mode === 'wardrobe' && a.wardrobeId === w.id).length;
    if (users) chips.append(h('span', { class: 'wd-chip gold' }, users + (users === 1 ? ' wearer' : ' wearers')));
    if (missing) chips.append(h('span', { class: 'wd-chip warn' }, missing + ' missing'));

    const card = h('button', {
      class: 'wd-card' + (selHas(w.id) ? ' sel' : ''), type: 'button',
      data: { k: 'wcard:' + w.id, sel: w.id },
      title: (w.note || w.name) + '\nClick to fill it · Ctrl-click to select · ⋯ for options',
      oncontextmenu: (e) => { e.preventDefault(); wardrobeMenu(e, w); },
      onclick: (e) => {
        if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) { selToggle(w.id, e); return; }
        openBuilder(w.id);
      },
    }, thumb, h('div', { class: 'wd-card-body' },
      h('div', { class: 'wd-card-name' },
        h('span', { class: 'wd-swatch', style: 'background:' + hueCss(w.hue, 55, 55) + ';display:inline-block;margin-right:6px' }),
        nameNodes(w.name, q)),
      chips.childNodes.length ? chips : null),
      members.length ? strip : null);
    card.append(h('span', {
      class: 'wd-dots', role: 'button', title: 'Options',
      onclick: (e) => { e.stopPropagation(); wardrobeMenu(e, w); },
    }, '⋯'));
    return card;
  }

  /* ------------------------------------------------------------- npcs -- */

  function renderNpcs(q) {
    els.list.append(renderSoesBar());
    /* One person, one row. The list is fed by two exports (SOES's tracked
       actors and the deck's own assignment table) and the same actor can
       arrive from both with different key SPELLINGS — case, id width. One NPC
       showed twice because of exactly this. Dedupe on the case-folded key and
       keep the FIRST occurrence, which is the SOES-backed one. */
    const seen = Object.create(null);
    const rows = state.npcs.filter((n) => {
      const k = keyOf(n).toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return npcMatches(n, q);
    });
    return paged(rows, (n) => npcRow(n, q));
  }

  /* People needs NFF's facts (claimed / worn / clash) on its rows — the NFF
     module no longer has a tab of its own to fetch them from. */
  function refreshNffData() {
    const nf = PLUGINS.nff;
    if (nf && typeof nf.refreshData === 'function') {
      try { nf.refreshData(); } catch (e) { console.log('[wardrobe] nff refresh', e); }
    }
  }

  /* System-wide SOES controls. They live on the NPCs tab because that is where
   * "why is everyone dressed like this" gets asked. Collapsed by default —
   * these are settings, not daily actions. */
  function renderSoesBar() {
    const head = h('button', {
      class: 'ghost-btn', type: 'button', style: 'align-self:flex-start',
      'aria-expanded': ui.settings ? 'true' : 'false',
      title: 'System-wide SOES settings — how outfits are conjured, on/off, repairs',
      onclick: () => { ui.settings = !ui.settings; render(); },
    }, (ui.settings ? '▾' : '▸') + ' Outfit system settings');
    if (!ui.settings) return head;

    const row = (label, hint, kids) => h('div', { class: 'wd-field' },
      h('span', { class: 'wd-field-k' }, label),
      h('div', { class: 'wd-seg' }, kids),
      hint ? h('span', { style: 'font-size:12.5px;color:#6f6a5e' }, hint) : null);

    const seg = (opts, onPick) => opts.map(([v, label, on]) => h('button', {
      type: 'button', class: on ? 'on' : '', title: label, onclick: () => onPick(v),
    }, label));

    return h('div', { class: 'wd-basket', style: 'gap:11px' }, head,
      row('NPC outfits', 'Automatic conjures any piece they do not own. Immersive only uses what is already in their inventory — safer, but an outfit can come out incomplete.',
        seg([[1, 'Automatic', false], [2, 'Immersive', false]],
          (v) => toGame('wdInvMode', JSON.stringify({ who: 'npc', mode: v })))),
      row('Your outfits', null,
        seg([[1, 'Automatic', false], [2, 'Immersive', false]],
          (v) => toGame('wdInvMode', JSON.stringify({ who: 'player', mode: v })))),
      row('Whole system', 'Off stops SOES managing anyone — nothing is un-assigned, it simply stops acting.',
        [h('button', { type: 'button', title: 'Let SOES manage outfits again',
           onclick: () => toGame('wdEnable', '{"on":true}') }, 'On'),
         h('button', { type: 'button', title: 'Stop SOES acting — assignments stay, nothing is applied',
           onclick: () => toGame('wdEnable', '{"on":false}') }, 'Off')]),
      row('Fix things', 'Re-dress everyone if someone is wearing the wrong thing; reset if the auto-switcher has got stuck.',
        [h('button', { type: 'button', title: 'Re-apply everyone\u2019s assigned outfit right now',
           onclick: () => { toGame('wdRefreshAll', ''); toast('Re-dressing everyone…'); } }, '↻ Re-dress all'),
         h('button', { type: 'button', title: 'Reset SOES\u2019s auto-switcher if it has wedged',
           onclick: () => { toGame('wdResetAuto', ''); toast('Auto-switch reset'); } }, '⟲ Reset auto-switch')]),
      /* Two switches SOES has always had and only its own MCM could reach.
         The state shown is what the DECK last set — SOES exposes no way to read
         either back that does not go through Papyrus — so the hint says so
         rather than letting a stale pip look authoritative. */
      row('Quick-swap power', 'A lesser power that raises a menu of your ★ outfits. Starring an outfit here now puts it in that menu.',
        soesSwitch('quickslot', !!state.settings.soesQuickslot,
          'Grant the quick-swap power', 'Take the quick-swap power away')),
      row('Weather vs. place', 'On, a blizzard dresses her for the blizzard. Off, “she is in a city” wins and the snow outfit never fires.',
        soesSwitch('climate', !!state.settings.soesClimate,
          'Let weather outrank where she is', 'Let where she is outrank the weather')),
      renderImporter());
  }

  /* One SOES on/off pair. Its own function because both switches need the same
     "this is what the deck last set" honesty and the same pressed state. */
  function soesSwitch(key, on, onTitle, offTitle) {
    const mk = (want, label, title) => h('button', {
      type: 'button', class: on === want ? 'on' : '',
      'aria-pressed': on === want ? 'true' : 'false',
      title: title + (on === want ? ' — this is what the deck last set' : ''),
      onclick: () => {
        state.settings[key === 'quickslot' ? 'soesQuickslot' : 'soesClimate'] = want;
        toGame('wdSoesOpt', JSON.stringify({ key: key, on: want }));
        render();
      },
    }, label);
    return [mk(true, 'On', onTitle), mk(false, 'Off', offTitle)];
  }

  /* -------------------------------------------------- the outfit importer -- */
  /* SOES can turn any outfit RECORD in the load order into one of its own —
     hundreds of ready-made looks from mods already installed. The engine
     enumerates the plugins that define outfits (exact, instant); SOES does the
     import itself, because only it knows how to convert an OTFT. */

  function renderImporter() {
    const wrap = h('div', { class: 'wd-field' },
      h('span', { class: 'wd-field-k' }, 'Import outfits'));
    /* width:100% and min-width:0, not flex:1 — .wd-field is a COLUMN flex, so a
       flex-basis child shrinks to its content and the lists came out half-width. */
    const body = h('div', { style: 'display:flex;flex-direction:column;gap:9px;width:100%;min-width:0' });
    wrap.append(body);

    body.append(h('div', { class: 'wd-seg' }, h('button', {
      type: 'button', class: ui.importer ? 'on' : '',
      'aria-expanded': ui.importer ? 'true' : 'false',
      title: 'Bring outfits a mod already defines into SOES, ready to assign',
      onclick: () => {
        if (ui.importer) { ui.importer = null; render(); return; }
        ui.importer = { q: '', plugin: '', q2: '' };
        state.modOutfits = null;
        if (!state.outfitMods.length) toGame('wdOutfitMods', '');
        render();
      },
    }, (ui.importer ? '▾' : '▸') + ' Browse mods')));

    if (!ui.importer) {
      body.append(h('span', { style: 'font-size:12.5px;color:#6f6a5e' },
        'Mods you already have define outfits of their own — import one and it becomes assignable like any other.'));
      return wrap;
    }

    /* --- stage 1: which plugin --- */
    const mods = state.outfitMods || [];
    const q = (ui.importer.q || '').toLowerCase();
    const hits = q ? mods.filter((m) => m.plugin.toLowerCase().indexOf(q) !== -1) : mods;

    body.append(inlineSearch('wd-imp-q', ui.importer.q, 'Search plugins…',
      'Filter the plugins that define outfits', (v) => { ui.importer.q = v; render(); }));

    if (!mods.length) {
      body.append(h('div', { class: 'wd-col-empty' }, 'Reading the load order…'));
      return wrap;
    }
    body.append(h('span', { style: 'font-size:12.5px;color:#6f6a5e' },
      hits.length + ' of ' + mods.length + ' plugin' + (mods.length === 1 ? '' : 's') + ' define outfits'));

    const list = h('div', { class: 'wd-imp-list', role: 'listbox', 'aria-label': 'Plugins that define outfits' });
    hits.slice(0, 200).forEach((m) => {
      const on = ui.importer.plugin === m.plugin;
      list.append(h('button', {
        type: 'button', class: 'wd-imp-row' + (on ? ' on' : ''),
        role: 'option', 'aria-selected': on ? 'true' : 'false',
        title: m.plugin + ' — ' + m.count + ' outfit' + (m.count === 1 ? '' : 's'),
        onclick: () => {
          ui.importer.plugin = m.plugin;
          ui.importer.q2 = '';
          state.modOutfits = null;
          toGame('wdOutfitsFor', JSON.stringify({ plugin: m.plugin }));
          render();
        },
      }, h('span', { class: 'wd-imp-n' }, m.plugin),
         h('span', { class: 'wd-imp-c' }, String(m.count))));
    });
    if (hits.length > 200) {
      list.append(h('div', { class: 'wd-col-empty' },
        hits.length - 200 + ' more — keep typing to narrow it'));
    }
    if (!hits.length) list.append(h('div', { class: 'wd-col-empty' }, 'No plugin matches “' + ui.importer.q + '”'));
    body.append(list);

    /* --- stage 2: which outfit inside it --- */
    if (!ui.importer.plugin) return wrap;
    const got = state.modOutfits;
    if (!got || got.plugin !== ui.importer.plugin) {
      body.append(h('div', { class: 'wd-col-empty' }, 'Reading ' + ui.importer.plugin + '…'));
      return wrap;
    }
    const all = got.outfits || [];
    const q2 = (ui.importer.q2 || '').toLowerCase();
    const hits2 = q2 ? all.filter((o) => (o.editorId || '').toLowerCase().indexOf(q2) !== -1) : all;

    body.append(inlineSearch('wd-imp-q2', ui.importer.q2, 'Search outfits in this mod…',
      'Filter this mod\u2019s outfits by editor ID', (v) => { ui.importer.q2 = v; render(); }));

    body.append(h('div', { class: 'wd-seg' }, h('button', {
      type: 'button',
      title: 'Import every outfit ' + ui.importer.plugin + ' defines (' + all.length + ')',
      disabled: !all.length,
      onclick: () => {
        toGame('wdImport', JSON.stringify({ plugin: ui.importer.plugin }));
        all.forEach((o) => { if (o.editorId) ui.imported[o.editorId] = true; });
        render();
        toast('Importing ' + all.length + ' outfit' + (all.length === 1 ? '' : 's') + '…');
      },
    }, '⤓ Import all ' + all.length)));

    const list2 = h('div', { class: 'wd-imp-list', role: 'list' });
    hits2.slice(0, 200).forEach((o) => {
      /* An outfit with no editor ID cannot be named to SOES's importer, so it
         is shown as unimportable rather than quietly dropped — otherwise the
         count above would not match the rows below and nothing would say why. */
      const can = !!o.editorId;
      const done = can && ui.imported[o.editorId];
      list2.append(h('div', { class: 'wd-imp-row static', role: 'listitem' },
        h('span', { class: 'wd-imp-n' }, o.editorId || '(no editor ID — cannot import)'),
        h('span', { class: 'wd-imp-c' }, o.parts + ' pc'),
        h('button', {
          type: 'button', class: 'wd-imp-go', disabled: !can || done,
          title: can ? (done ? 'Already asked for — it appears once SOES re-exports'
                             : 'Import ' + o.editorId + ' into SOES')
                     : 'This outfit has no editor ID, so SOES cannot be told which one to take',
          onclick: () => {
            toGame('wdImport', JSON.stringify({ plugin: ui.importer.plugin, editorId: o.editorId }));
            ui.imported[o.editorId] = true;
            render();
            toast('Importing ' + o.editorId + '…');
          },
        }, done ? '✓' : '⤓')));
    });
    if (hits2.length > 200) {
      list2.append(h('div', { class: 'wd-col-empty' },
        hits2.length - 200 + ' more — keep typing to narrow it'));
    }
    if (!hits2.length) list2.append(h('div', { class: 'wd-col-empty' }, 'Nothing matches “' + ui.importer.q2 + '”'));
    body.append(list2);
    return wrap;
  }

  /* A plain search box that survives the re-render it causes. Every keystroke
     re-renders this panel, so the input has to be re-created with the caret put
     back — the same trap the inline combobox documents. */
  function inlineSearch(id, val, placeholder, title, onInput) {
    const inp = h('input', {
      type: 'text', id: id, class: 'wd-imp-search', value: val || '',
      placeholder: placeholder, title: title, 'aria-label': title,
      spellcheck: 'false', autocomplete: 'off',
      /* The claim is set BEFORE the render, never in a blur handler: typing
         destroys this node, and the blur that fires as it is removed would
         clear the very flag the re-focus below depends on. */
      oninput: (e) => { ui.searchFocus = id; onInput(e.currentTarget.value); },
      onfocus: () => { ui.searchFocus = id; },
    });
    /* Re-focus AFTER the render this input triggered, and put the caret back at
       the end — without this the box loses focus on the first character. */
    if (ui.searchFocus === id) {
      setTimeout(() => {
        const live = document.getElementById(id);
        if (live && document.activeElement !== live) {
          live.focus();
          try { live.setSelectionRange(live.value.length, live.value.length); } catch (e) { /* not text-like */ }
        }
      }, 0);
    }
    return inp;
  }

  /* Which system dresses this person — the ONE fact the redesign puts first.
     'nff' comes from the NFF module's claim flag; 'wardrobe' from the deck's
     own assignment; neither means nobody, said plainly. */
  function modeOf(npc) {
    const nf = PLUGINS.nff;
    const info = (nf && nf.infoFor) ? nf.infoFor(keyOf(npc)) : null;
    if (info && info.claimed) return { mode: 'nff', info: info };
    const a = assignFor(keyOf(npc));
    if (a && (a.mode === 'outfit' || a.mode === 'wardrobe')) return { mode: 'wardrobe', info: info, a: a };
    return { mode: 'off', info: info, a: a };
  }

  function npcRow(npc, q) {
    const a = assignFor(keyOf(npc));
    const face = npcFace(npc);
    const who = modeOf(npc);

    const sub = h('div', { class: 'wd-npc-sub' });
    /* The mode chip leads: it is the answer to "who dresses her", which is the
       question this tab exists for. Everything after it is detail. */
    if (who.mode === 'nff') {
      sub.append(h('span', { class: 'wd-chip nff', title: 'Handed to Nether\u2019s Follower Framework — the Wardrobe leaves her alone' },
        'NFF' + (who.info && who.info.wornLabel ? ' · ' + who.info.wornLabel : '')));
    } else if (a && a.mode === 'wardrobe') {
      const w = wardrobeById(a.wardrobeId);
      sub.append(h('span', { class: 'wd-chip gold' }, '◇ ' + (w ? w.name : 'missing wardrobe')));
      sub.append(h('span', { class: 'wd-chip' }, 'every ' + cadenceLabel(a.cadenceHours)));
    } else if (a && a.mode === 'outfit' && a.outfit) {
      sub.append(h('span', { class: 'wd-chip' + (isMissing(a.outfit) ? ' warn' : '') }, a.outfit));
    } else {
      sub.append(h('span', { class: 'wd-chip' }, 'not managed'));
    }
    if (npc.wearing) sub.append(h('span', { class: 'wd-chip' }, 'wearing: ' + npc.wearing));
    if (npc.tracked) sub.append(h('span', { class: 'wd-chip gold', title: 'Tracked by SOES-NG' }, 'tracked'));
    if (npc.conflict) sub.append(h('span', { class: 'wd-chip warn', title: 'Also assigned in Tailor' }, 'Tailor clash'));
    if (who.info && who.info.conflict) {
      sub.append(h('span', { class: 'wd-chip warn', title: 'The Wardrobe and NFF are BOTH dressing her — they fight. Pick one on her card.' }, '⚠ two systems'));
    }
    if (a && (a.locationOverrides || []).length) {
      sub.append(h('span', { class: 'wd-chip' }, a.locationOverrides.length + ' override' + (a.locationOverrides.length === 1 ? '' : 's')));
    }

    /* Dress works in EITHER mode: SOES's dress-now, or wearing her current NFF
       set again — same verb, whichever system owns her. */
    const dress = h('button', {
      class: 'wd-dress', type: 'button',
      title: who.mode === 'nff' ? 'Put her current NFF set on her now'
           : 'Pick from their wardrobe now and dress them',
      disabled: who.mode === 'off' || (who.mode === 'wardrobe' && !state.soes.available),
      onclick: (e) => {
        e.stopPropagation();
        if (who.mode === 'nff') { openInject(e.currentTarget, npc, true); return; }
        dressNow(npc);
      },
    }, '✦ Dress');

    /* Open her inventory — a one-off act, not a mode. The chevron beside it is
       the "inject an outfit" picker Rober asked for: search an outfit, pick
       which of her NFF sets it lands in, done. */
    const inv = h('span', { class: 'wd-invpair' },
      h('button', {
        class: 'wd-dress ghost', type: 'button',
        title: 'Open ' + npc.name + '\u2019s inventory',
        onclick: (e) => { e.stopPropagation(); openNpcInventory(npc); },
      }, '🎒'),
      h('button', {
        class: 'wd-dress ghost chev', type: 'button',
        title: 'Inject an outfit into her — searchable',
        onclick: (e) => { e.stopPropagation(); openInject(e.currentTarget, npc, false); },
      }, '▾'));

    return h('button', {
      class: 'wd-npc', type: 'button', data: { k: 'npc:' + keyOf(npc) },
      title: npc.name + ' — click to edit who dresses them',
      oncontextmenu: (e) => { e.preventDefault(); npcMenu(e, npc); },
      onclick: () => openSheet(npc),
    }, face,
      h('div', { class: 'wd-npc-main' },
        h('div', { class: 'wd-npc-name' }, nameNodes(npc.name, q)), sub),
      h('div', { class: 'wd-npc-right' }, inv, dress));
  }

  /* The inject picker: outfit first (filter-as-you-type), then which of her
     three NFF sets it lands in. Two steps because nfCopy genuinely needs the
     destination — NFF wears a different set in the wild, in town and at home,
     and guessing would put the clothes on somewhere she is not.
     `wearMode` = the Dress button on an NFF-claimed row: skip straight to
     re-wearing a set instead of copying an outfit in. */
  function openInject(anchorEl, npc, wearMode) {
    const nf = PLUGINS.nff;
    if (!nf || !nf.copyOutfit) { toast('NFF module missing'); return; }
    const key = keyOf(npc);
    const sets = nf.sets || [];

    if (wearMode) {
      /* Re-wear: one step, pick the set. Routed through the NFF module's own
         chip handler by simulating its pick — copyOutfit is not the verb here,
         so use setClaim's sibling: fire nfWear via the module's controls. The
         module has no bare wear export, so the smallest honest path is the
         sheet: open her card, which holds the set chips. */
      openSheet(npc);
      return;
    }

    const names = soesNames();
    const items = [h('div', { class: 'fd-ctx-head' }, 'Inject into ' + (npc.name || 'her') + '…')];
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    items.push(h('div', { class: 'fd-ctx-field' },
      h('input', {
        class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: 'Type to filter outfits…',
        oninput: (e) => paint(e.target.value),
        onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { closeInject(); return; }
          if (e.key === 'Enter') {
            e.preventDefault();
            const first = listBox.querySelector('.fd-ctx-item');
            if (first) first.click();
          }
        },
      })));
    items.push(listBox);

    function pickSet(outfit) {
      listBox.textContent = '';
      items[0].textContent = outfit + ' — into which set?';
      sets.forEach((sp) => {
        listBox.append(h('button', {
          class: 'fd-ctx-item', type: 'button',
          title: 'Put it in her ' + sp.name + ' set' + (sp.hint ? ' — ' + sp.hint : ''),
          onclick: (e) => {
            e.stopPropagation(); closeInject();
            if (nf.copyOutfit(key, sp.t, outfit))
              toast('Injecting \u201c' + outfit + '\u201d into her ' + sp.name + ' set…');
          },
        },
          h('span', { class: 'fd-ctx-check' }, '⛨'),
          h('span', { class: 'fd-ctx-lbl' }, sp.name),
          h('span', { class: 'fd-ctx-count' }, sp.hint || '')));
      });
    }

    function paint(qq) {
      const f = String(qq || '').trim().toLowerCase();
      listBox.textContent = '';
      let n = 0;
      names.forEach((nm) => {
        if (f && nm.toLowerCase().indexOf(f) === -1) return;
        listBox.append(h('button', {
          class: 'fd-ctx-item', type: 'button',
          title: 'Inject \u201c' + nm + '\u201d — next: pick which of her sets',
          onclick: (e) => { e.stopPropagation(); pickSet(nm); },
        },
          h('span', { class: 'fd-ctx-check' }, '⛨'),
          h('span', { class: 'fd-ctx-lbl' }, nm)));
        n++;
      });
      if (!n) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          names.length ? 'No outfit matches.' : 'No outfits yet — build one on the Inventory tab.'));
      }
    }
    paint('');

    closeInject();
    const menu = h('div', { id: 'wd-inject-menu', role: 'menu' }, items);
    /* On the deck-level OVERLAY, not inside the pane. The first clamp was
       arithmetically right and still cut off in game (Rober, 2026-08-03),
       because #wd-pane is overflow:hidden — a child positioned inside it is
       clipped at the pane's edge no matter how carefully it is placed. The
       overlay is where the followers pane's context menus already live for
       exactly this reason; coordinates below are VIEWPORT coordinates. */
    $('overlay').append(menu);
    const r = anchorEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const menuW = 340;
    menu.style.left = Math.max(8, Math.min(r.right - menuW, vw - menuW - 8)) + 'px';
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    if (below >= Math.min(320, vh * 0.45) || below >= above) {
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.maxHeight = Math.max(180, below) + 'px';
    } else {
      menu.style.bottom = (vh - r.top + 6) + 'px';
      menu.style.maxHeight = Math.max(180, above) + 'px';
    }
    /* The anchor scrolls with the list; a menu pinned to the viewport must not
       drift away from it. Scroll anywhere closes, same as the ctx menus. */
    els.list.addEventListener('scroll', closeInject, { once: true, capture: true });
    setTimeout(() => {
      const inp = menu.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', injectOutside, true);
    }, 0);
  }
  function closeInject() {
    const m = document.getElementById('wd-inject-menu');
    if (m) m.remove();
    document.removeEventListener('mousedown', injectOutside, true);
  }
  function injectOutside(e) {
    const m = document.getElementById('wd-inject-menu');
    if (m && !m.contains(e.target)) closeInject();
  }

  /* ------------------------------------------------- the searchable picker -- */
  /* ONE overlay picker, used by anything that needs "choose from a list that is
   * going to get long": the outfit card's categories, and the variant piece
   * chooser. Rober flagged the category case directly — the ⋯ menu listed every
   * category as its own row, so three categories today is thirty later and the
   * menu becomes a wall (2026-08-03).
   *
   * Three behaviours that are the whole point:
   *   - MULTI toggling does NOT close. Filing an outfit under three categories
   *     was three right-clicks; now it is one open and three clicks.
   *   - CREATE FROM THE FILTER. If what you typed matches nothing, the top row
   *     becomes ＋ Create "<text>". His categories are his words; making him
   *     leave for a management screen first is the friction he is complaining
   *     about.
   *   - It lives on $('overlay'), NOT in #wd-pane. #wd-pane is overflow:hidden,
   *     so a child positioned inside it is clipped at the pane edge however
   *     carefully it is placed — that exact bug shipped twice on 2026-08-03.
   *     Coordinates below are therefore VIEWPORT coordinates, and the flip-up +
   *     close-on-scroll are copied from openInject's proven final form.
   *
   * spec = { title, placeholder, rows(), multi, onCreate(text), createLabel(t),
   *          empty, footer(), rect }  — `rect` lets a caller that has already
   * lost its anchor (an async reply, e.g. the variant picker waiting on
   * wdPieceList) still place the menu where the click was.
   */
  function openCtxPicker(anchorEl, spec) {
    closeCtxPicker();
    const head = h('div', { class: 'fd-ctx-head' }, spec.title || '');
    const listBox = h('div', { class: 'fd-ctx-scroll' });
    const footBox = h('div', { class: 'wd-pick-foot' });
    let filter = '';

    function paint() {
      listBox.textContent = '';
      const f = filter.trim().toLowerCase();
      const rows = (spec.rows() || []).filter((r) =>
        !f || String(r.label || '').toLowerCase().indexOf(f) !== -1);

      /* Create sits ABOVE the matches so Enter takes it when nothing matched,
         and never steals Enter when something did — the exact-match test is
         what keeps "Armor" from offering to create a second "armor". */
      if (spec.onCreate && f) {
        const exact = (spec.rows() || []).some((r) =>
          String(r.label || '').trim().toLowerCase() === f);
        if (!exact) {
          const text = filter.trim();
          listBox.append(h('button', {
            class: 'fd-ctx-item wd-pick-new', type: 'button',
            title: 'Create a new category called “' + text + '” and file this outfit under it',
            onclick: (ev) => {
              ev.stopPropagation();
              spec.onCreate(text);
              filter = '';
              const inp = document.querySelector('#wd-catpick .fd-ctx-filter');
              if (inp) { inp.value = ''; inp.focus(); }
              paint();
            },
          },
            h('span', { class: 'fd-ctx-check' }, '＋'),
            h('span', { class: 'fd-ctx-lbl' }, 'Create “' + text + '”')));
        }
      }

      rows.forEach((r) => {
        listBox.append(h('button', {
          class: 'fd-ctx-item' + (r.checked ? ' on' : ''), type: 'button',
          disabled: r.disabled ? 'disabled' : null,
          title: r.title || r.label,
          onclick: (ev) => {
            ev.stopPropagation();
            if (r.disabled) return;
            r.go();
            /* Multi keeps the picker up and repaints the check states in place;
               single-pick closes, because there is nothing left to decide. */
            if (spec.multi) { paint(); renderFoot(); } else { closeCtxPicker(); }
          },
        },
          h('span', { class: 'fd-ctx-check' }, r.checked ? '✓' : ' '),
          h('span', { class: 'fd-ctx-lbl' }, r.label),
          r.count != null ? h('span', { class: 'fd-ctx-count' }, String(r.count)) : null));
      });

      if (!rows.length && !(spec.onCreate && f)) {
        listBox.append(h('div', { class: 'fd-ctx-empty' },
          spec.empty || 'Nothing matches.'));
      }
    }
    function renderFoot() {
      footBox.textContent = '';
      if (spec.footer) { const n = spec.footer(); if (n) footBox.append(n); }
    }

    const menu = h('div', { id: 'wd-catpick', role: 'menu' },
      head,
      h('div', { class: 'fd-ctx-field' },
        h('input', {
          class: 'fd-ctx-input fd-ctx-filter', type: 'text', autocomplete: 'off',
          spellcheck: 'false', placeholder: spec.placeholder || 'Type to filter…',
          oninput: (e) => { filter = e.target.value; paint(); },
          onkeydown: (e) => {
            /* stopPropagation or the deck's global key handling eats the typing */
            e.stopPropagation();
            if (e.key === 'Escape') { closeCtxPicker(); return; }
            if (e.key === 'Enter') {
              e.preventDefault();
              const first = listBox.querySelector('.fd-ctx-item:not(:disabled)');
              if (first) first.click();
            }
          },
        })),
      listBox, footBox);
    paint();
    renderFoot();
    $('overlay').append(menu);

    const r = spec.rect || (anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect() : { left: 40, right: 40, top: 40, bottom: 40 });
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const menuW = 340;
    menu.style.left = Math.max(8, Math.min(r.right - menuW, vw - menuW - 8)) + 'px';
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    if (below >= Math.min(320, vh * 0.45) || below >= above) {
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.maxHeight = Math.max(180, below) + 'px';
    } else {
      menu.style.bottom = (vh - r.top + 6) + 'px';
      menu.style.maxHeight = Math.max(180, above) + 'px';
    }
    /* The anchor scrolls with the list; a viewport-pinned menu must not drift
       away from it, so any scroll closes — same as the ctx menus. */
    if (els.list) els.list.addEventListener('scroll', closeCtxPicker, { once: true, capture: true });
    setTimeout(() => {
      const inp = menu.querySelector('.fd-ctx-filter');
      if (inp) inp.focus();
      document.addEventListener('mousedown', ctxPickerOutside, true);
    }, 0);
    return { repaint: () => { paint(); renderFoot(); } };
  }
  function closeCtxPicker() {
    const m = document.getElementById('wd-catpick');
    if (m) m.remove();
    document.removeEventListener('mousedown', ctxPickerOutside, true);
  }
  function ctxPickerOutside(e) {
    const m = document.getElementById('wd-catpick');
    if (m && !m.contains(e.target)) closeCtxPicker();
  }

  /* ------------------------------------------------- categories, searchable -- */
  function openCategoryPicker(rect, name) {
    const m = ensureMeta(name);
    openCtxPicker(null, {
      rect: rect,
      title: 'Categories for “' + name + '”',
      placeholder: 'Filter or type a new category…',
      multi: true,
      empty: 'No categories yet — type a name to make the first one.',
      rows: () => state.categories.map((c) => ({
        label: c.name,
        checked: (m.categoryIds || []).indexOf(c.id) !== -1,
        count: state.outfitMeta.filter((x) =>
          (x.categoryIds || []).indexOf(c.id) !== -1).length,
        title: ((m.categoryIds || []).indexOf(c.id) !== -1
          ? 'Take “' + name + '” out of ' : 'File “' + name + '” under ')
          + c.name + ' — the picker stays open so you can set several',
        go: () => {
          if (!m.categoryIds) m.categoryIds = [];
          const i = m.categoryIds.indexOf(c.id);
          if (i === -1) m.categoryIds.push(c.id); else m.categoryIds.splice(i, 1);
          touch();
        },
      })),
      onCreate: (text) => {
        const c = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          name: text };
        state.categories.push(c);
        if (!m.categoryIds) m.categoryIds = [];
        m.categoryIds.push(c.id);
        touch();
        toast('Created “' + text + '” and filed “' + name + '” under it');
      },
      footer: () => {
        const n = (m.categoryIds || []).length;
        return h('div', { class: 'wd-pick-note' },
          n ? 'In ' + n + ' categor' + (n === 1 ? 'y' : 'ies') + ' — shown as chips on the card'
            : 'Not in any category yet');
      },
    });
  }

  /* ------------------------------------------------ variants and duplicates -- */
  /* A variant is the same outfit with pieces left out — the canonical case being
   * "no helmet". Both this and Duplicate are ONE mechanism: read the source's
   * pieces, then build a real SOES outfit through the existing wdBuild path with
   * whatever subset survived. Nothing new C++-side; a variant is an ordinary
   * outfit the moment it exists, so it is assignable, location-overridable
   * ("helmet outdoors, bare head at home" is a Home override pointing at it),
   * photographable and croppable like any other. */

  var HEADGEAR = ['head', 'hair', 'circlet'];
  function isHeadgear(it) {
    return HEADGEAR.indexOf(String(it && it.slot || '').toLowerCase()) !== -1;
  }

  /* Case-insensitive, and against the list the DECK SHOWS rather than raw SOES:
     a just-deleted outfit can still be sitting in SOES's last export, and
     colliding with a tombstone would push everything to "copy 2" for no reason
     the player can see. */
  function uniqueOutfitName(base) {
    const taken = Object.create(null);
    soesNames().forEach((n) => { taken[String(n).toLowerCase()] = 1; });
    state.outfitMeta.forEach((m) => { taken[String(m.name).toLowerCase()] = 1; });
    if (!taken[base.toLowerCase()]) return base;
    for (let i = 2; i < 200; i++) {
      const t = base + ' ' + i;
      if (!taken[t.toLowerCase()]) return t;
    }
    return base + ' ' + Date.now().toString(36);
  }

  /* Categories and the note follow a copy, because they are what you wrote about
     the CLOTHES and the copy is the same clothes. The photo deliberately does
     NOT: crops are keyed by image FILE name (§8 of wardrobe-wiring.md), so
     sharing one image would make re-framing one silently re-frame the other. A
     duplicate starts unphotographed, and that is correct rather than a gap. */
  function carryMeta(fromName, toName) {
    const src = ensureMeta(fromName);
    const dst = ensureMeta(toName);
    dst.categoryIds = (src.categoryIds || []).slice();
    dst.note = src.note || '';
    dst.fav = false;
    return dst;
  }

  function buildFromPieces(newName, items, sourceName, what) {
    const usable = items.filter((i) => !i.missing);
    if (!usable.length) {
      toast('Nothing to copy — none of its pieces resolve any more');
      return false;
    }
    toGame('wdBuild', JSON.stringify({
      name: newName,
      items: usable.map((i) => ({ formId: i.formId, plugin: i.plugin, name: i.name })),
    }));
    carryMeta(sourceName, newName);
    touch();
    const lost = items.length - usable.length;
    toast(what + ' “' + newName + '” — ' + usable.length + ' piece' +
      (usable.length === 1 ? '' : 's') + (lost ? ', ' + lost + ' unresolved skipped' : ''));
    return true;
  }

  /* Both entry points ask C++ for the pieces and then take FIRST REFUSAL on the
     wdPieceList reply (see receive()), so the Pieces… sheet is never clobbered
     by a variant request and vice versa. */
  function requestPieces(name, mode, rect) {
    ui.variantReq = { name: name, mode: mode, rect: rect };
    toGame('wdPieces', JSON.stringify({ name: name }));
    toast(mode === 'dup' ? 'Duplicating “' + name + '”…'
      : 'Reading “' + name + '”…');
  }

  /* The variant chooser: every piece with a check, plus the two presets that
     cover the case this exists for. Headgear is called out by SLOT (Head / Hair
     / Circlet, exactly what SlotNameOf emits in src/wardrobe.cpp) rather than by
     guessing at names. */
  function openVariantPicker(req, items) {
    const keep = Object.create(null);
    items.forEach((i, n) => { keep[n] = !i.missing; });
    const headIdx = items.map((i, n) => (isHeadgear(i) ? n : -1)).filter((n) => n !== -1);

    function kept() { return items.filter((i, n) => keep[n]); }
    function droppedHeadOnly() {
      /* `missing` pieces are excluded: they could never go in, so counting them
         as "removed" made a helmet-only variant fall back to "(variant)" purely
         because the source happened to contain a piece whose plugin is gone. */
      const dropped = items.map((i, n) => n).filter((n) => !keep[n] && !items[n].missing);
      return dropped.length > 0 && dropped.every((n) => headIdx.indexOf(n) !== -1);
    }
    function suggestName() {
      return uniqueOutfitName(req.name + (droppedHeadOnly() ? ' (no helmet)' : ' (variant)'));
    }

    const picker = openCtxPicker(null, {
      rect: req.rect,
      title: 'Variant of “' + req.name + '”',
      placeholder: 'Filter its pieces…',
      multi: true,
      empty: 'No piece matches.',
      rows: () => {
        const rows = [];
        if (headIdx.length) {
          const allHeadOff = headIdx.every((n) => !keep[n]);
          rows.push({
            label: allHeadOff ? '↺ Put the headgear back' : '⛑ No helmet',
            checked: allHeadOff,
            title: allHeadOff
              ? 'Re-check the ' + headIdx.length + ' headgear piece(s)'
              : 'Uncheck every Head / Hair / Circlet piece — the usual variant',
            go: () => { headIdx.forEach((n) => { keep[n] = allHeadOff; }); },
          });
        }
        rows.push({
          label: '✓ Everything', checked: items.every((i, n) => keep[n]),
          title: 'Check every piece — this makes a straight duplicate',
          go: () => { items.forEach((i, n) => { keep[n] = !i.missing; }); },
        });
        items.forEach((i, n) => {
          rows.push({
            label: i.name + (i.missing ? '  · plugin gone' : ''),
            checked: !!keep[n], disabled: !!i.missing,
            count: i.slot,
            title: i.missing
              ? 'Its plugin is gone — it cannot go into a new outfit'
              : (keep[n] ? 'Leave ' : 'Include ') + i.name + ' (' + i.slot + ')',
            go: () => { keep[n] = !keep[n]; },
          });
        });
        return rows;
      },
      footer: () => {
        const n = kept().length;
        return h('div', { class: 'wd-pick-foot-row' },
          h('span', { class: 'wd-pick-note' },
            n + ' of ' + items.length + ' piece' + (items.length === 1 ? '' : 's')),
          h('button', {
            class: 'wd-pick-go', type: 'button', disabled: n ? null : 'disabled',
            title: n ? 'Create “' + suggestName() + '” as a real outfit'
              : 'Keep at least one piece',
            onclick: (e) => {
              e.stopPropagation();
              if (!kept().length) return;
              const nm = suggestName();
              closeCtxPicker();
              buildFromPieces(nm, kept(), req.name, 'Building');
            },
          }, 'Create variant'));
      },
    });
    return picker;
  }

  /* -------------------------------------------------------- inventory -- */
  /* The player's armour, pushed by C++. This is what makes "build an outfit"
   * possible from inside the game without opening SOES's MCM: pick pieces,
   * name it, and the plugin creates a REAL SOES outfit. */

  function invKey(i) { return i.formId + '|' + i.plugin; }
  function buildState() {
    if (!ui.build) ui.build = { name: '', picked: Object.create(null) };
    return ui.build;
  }
  function buildPicked() {
    const b = buildState();
    return Object.keys(b.picked).map((k) => b.picked[k]);
  }
  function invSlots() {
    const seen = [];
    state.inventory.forEach((i) => { if (seen.indexOf(i.slot) === -1) seen.push(i.slot); });
    return seen.sort((a, b) => slotRank(a) - slotRank(b));
  }

  /* The build basket: pinned above the list so a half-assembled outfit is never
   * lost to a stray scroll, and shared by both armour sources. */
  function renderBasket() {
    const b = buildState();
    const picked = buildPicked();
    const nameIn = h('input', {
      class: 'wd-inline', type: 'text', value: b.name, spellcheck: 'false',
      placeholder: 'Name this outfit…', maxlength: '64',
      'aria-label': 'Outfit name', data: { k: 'buildname' },
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); doBuild(); }
      },
      oninput: () => { b.name = nameIn.value; },
    });
    const go = h('button', {
      class: 'wd-dress', type: 'button', disabled: !picked.length,
      title: picked.length ? 'Create this as a real SOES outfit' : 'Pick some pieces first',
      onclick: doBuild,
    }, '✚ Build (' + picked.length + ')');

    els.list.append(h('div', { class: 'wd-basket' },
      h('div', { class: 'wd-basket-top' }, nameIn, go,
        picked.length ? h('button', {
          class: 'ghost-btn', type: 'button',
          title: 'Take all ' + picked.length + ' piece'
               + (picked.length === 1 ? '' : 's') + ' back out of the basket',
          onclick: () => { ui.build = null; render(); },
        }, 'Clear') : null),
      h('div', { class: 'wd-basket-sub' },
        picked.length
          ? picked.map((i) => i.name).join(' · ')
          : 'Tap pieces below to add them. ' + state.inventory.length + ' in your inventory.')));

  }

  function renderInventory(q) {
    if (ui.invSource === 'all') {
      renderBasket();
      return renderAllArmor(q);
    }

    renderBasket();
    els.list.append(renderArmorSource());

    /* Copy an existing look straight into the basket. Far and away the fastest
     * way to make an outfit: dress someone in game, then bottle it. */
    const from = h('div', { class: 'wd-fromrow' },
      h('span', { class: 'wd-from-k' }, 'Copy what'),
      h('button', {
        class: 'ghost-btn', type: 'button', title: 'Fill the basket with everything you have equipped',
        onclick: () => { toGame('wdWorn', '{}'); toast('Reading what you\u2019re wearing…'); },
      }, 'I\u2019m wearing'));
    state.npcs.filter((n) => n.wearing || n.tracked).slice(0, 3).forEach((n) => {
      from.append(h('button', {
        class: 'ghost-btn', type: 'button', title: 'Fill the basket with what ' + n.name + ' has on',
        onclick: () => {
          toGame('wdWorn', JSON.stringify({ formId: n.formId, plugin: n.plugin }));
          toast('Reading what ' + n.name + ' is wearing…');
        },
      }, n.name.split(' ')[0] + ' is'));
    });
    els.list.append(from);

    /* slot chips — the search box above already covers typing */
    const chips = h('div', { class: 'wd-slotbar' });
    chips.append(h('button', {
      class: 'wd-cat-pill' + (ui.invSlot ? '' : ' on'), type: 'button',
      'aria-pressed': ui.invSlot ? 'false' : 'true',
      title: 'Show every piece you are carrying — ' + state.inventory.length
           + ' in all. Type in the search box above to narrow it by name.',
      onclick: () => { ui.invSlot = ''; resetPaging(); render(); },
    }, 'All ', h('span', { class: 'wd-pill-n' }, String(state.inventory.length))));
    invSlots().forEach((sl) => {
      const n = state.inventory.filter((i) => i.slot === sl).length;
      chips.append(h('button', {
        class: 'wd-cat-pill' + (ui.invSlot === sl ? ' on' : ''), type: 'button',
        'aria-pressed': ui.invSlot === sl ? 'true' : 'false',
        title: (ui.invSlot === sl ? 'Showing only ' : 'Show only ') + sl + ' pieces — '
             + n + ' of them' + (ui.invSlot === sl ? '. Click to show everything again.' : '.'),
        onclick: () => { ui.invSlot = ui.invSlot === sl ? '' : sl; resetPaging(); render(); },
      }, sl, ' ', h('span', { class: 'wd-pill-n' }, String(n))));
    });
    els.list.append(chips);

    /* Sort here, not on receive: the order must hold however the list arrived
     * (wdOpen, wdState, or a dev fixture). */
    const list = state.inventory.slice().sort(
      (a, b) => (slotRank(a.slot) - slotRank(b.slot)) || a.name.localeCompare(b.name)
    ).filter((i) => {
      if (ui.invSlot && i.slot !== ui.invSlot) return false;
      if (!q) return true;
      const ql = q.toLowerCase();
      return i.name.toLowerCase().indexOf(ql) !== -1 ||
        i.slot.toLowerCase().indexOf(ql) !== -1 ||
        String(i.plugin || '').toLowerCase().indexOf(ql) !== -1;
    });
    return paged(list, (i) => invRow(i, q));
  }

  /* The rendered armour for an item, or '' — key normalisation matches the
   * C++ index exactly (UPPERCASE hex | lowercase plugin). */
  function itemIconFor(item) {
    if (!item || !item.formId || !item.plugin)
      return '';
    const key = String(item.formId).toUpperCase() + '|' + String(item.plugin).toLowerCase();
    return (state.itemIcons && state.itemIcons[key]) || '';
  }

  /* A big look at one rendered piece. The rows are 40-some pixels; the render
     is 512 — clicking the picture should show the picture. Esc or any click
     closes; the overlay is its own element so the pane underneath keeps its
     scroll and basket state untouched. */
  function openItemLightbox(url, name) {
    closeItemLightbox();
    const lb = h('div', {
      id: 'wd-item-lightbox', role: 'dialog', 'aria-label': name,
      title: 'Click anywhere to close',
      onclick: () => closeItemLightbox(),
    },
      h('img', { src: url, alt: name, draggable: 'false' }),
      h('div', { class: 'wd-lb-name' }, name),
      h('button', {
        class: 'ghost-btn wd-lb-x', type: 'button', title: 'Close',
        onclick: (e) => { e.stopPropagation(); closeItemLightbox(); },
      }, '✕'));
    els.pane.append(lb);
  }
  function closeItemLightbox() {
    const lb = document.getElementById('wd-item-lightbox');
    if (lb) lb.remove();
  }

  function invRow(item, q) {
    const b = buildState();
    const on = !!b.picked[invKey(item)];
    const bits = [item.slot];
    if (item.armorRating) bits.push('AR ' + item.armorRating);
    if (item.enchanted) bits.push('enchanted');
    if (item.plugin) bits.push(item.plugin);
    return h('div', { class: 'wd-invrow' },
      h('button', {
        class: 'wd-npc' + (on ? ' picked' : ''), type: 'button',
        data: { k: 'inv:' + invKey(item) },
        /* The name and the detail chip BOTH ellipsize on a narrow panel (and at
           160% tab zoom they ellipsize on a wide one), so the row's hover text
           has to be the place the whole truth lives - a truncated value with a
           tooltip that only says what the click does is a value you cannot
           read at all. Full name first, then the same facts the chip carries. */
        title: item.name + '\n' + bits.join(' \u00b7 ') + '\n'
             + (on ? 'In the basket \u2014 click to take it out'
                   : 'Click to add it to the outfit you are building'),
        onclick: () => {
          const k = invKey(item);
          if (b.picked[k]) delete b.picked[k];
          else b.picked[k] = item;
          render();
        },
      },
        (function () {
          /* the real armour, when the render exists — the tick still overlays
             a picked row so the basket state stays readable at a glance */
          const url = itemIconFor(item);
          if (!url)
            return h('div', { class: 'wd-npc-face ph' }, on
              ? svgIcon(['M4 12.5l5 5L20 6.5'], 20)
              : svgIcon(['M12 5v14', 'M5 12h14'], 18));
          const face = h('div', {
            class: 'wd-npc-face haslb' + (on ? ' picked' : ''),
            title: 'Click to see ' + item.name + ' large',
            /* The ICON opens the lightbox; the rest of the row still toggles
               the build basket. stopPropagation is what keeps one click from
               doing both — clicking a picture to LOOK at it must never also
               change what you are building. */
            onclick: (e) => { e.stopPropagation(); openItemLightbox(url, item.name); },
          },
            h('img', { class: 'wd-item-render', src: url, alt: '', draggable: 'false' }));
          if (on)
            face.append(h('div', { class: 'wd-face-tick' }, svgIcon(['M4 12.5l5 5L20 6.5'], 16)));
          return face;
        })(),
        h('div', { class: 'wd-npc-main' },
          h('div', { class: 'wd-npc-name' }, nameNodes(item.name, q)),
          h('div', { class: 'wd-npc-sub' },
            h('span', { class: 'wd-chip' + (on ? ' gold' : '') }, bits.join(' · '))))),
      /* wear just this one piece, no outfit machinery involved */
      h('button', {
        class: 'ghost-btn wd-equip', type: 'button',
        title: 'Equip ' + item.name + ' on YOU now',
        onclick: (e) => {
          e.stopPropagation();
          toGame('wdEquipPiece', JSON.stringify({ formId: item.formId, plugin: item.plugin, name: item.name }));
          toast('Equipping ' + item.name + '…');
        },
      }, 'Equip'));
  }

  /* Hand the pieces to C++, which resolves each armour form and drives SOES
   * through the Papyrus executor. Same payload shape as the portal's
   * POST /api/outfit, so the two paths can't drift. */
  function doBuild() {
    const b = buildState();
    const picked = buildPicked();
    const name = (b.name || '').trim();
    if (!name) {
      toast('Give the outfit a name first');
      const f = els.pane.querySelector('[data-k="buildname"]');
      if (f) f.focus();
      return;
    }
    if (!picked.length) { toast('Pick at least one piece'); return; }
    toGame('wdBuild', JSON.stringify({
      name: name,
      items: picked.map((i) => ({ formId: i.formId, plugin: i.plugin, name: i.name })),
    }));
    ui.build = null;
    toast('Building “' + name + '” — ' + picked.length + ' pieces');
    render();
  }

  /* ------------------------------------------------- an outfit's contents -- */
  /* "What is actually in this thing" — a piece count was never enough, and a
   * wardrobe full of outfits you cannot inspect is a wardrobe you cannot trust. */

  function renderPieces() {
    const open = !!ui.pieces;
    els.pieces.classList.toggle('hidden', !open);
    if (!open) return;
    const p = ui.pieces;
    els.piecesTitle.textContent = p.name;
    els.piecesBody.textContent = '';

    if (p.loading) {
      els.piecesSub.textContent = 'reading…';
      for (let i = 0; i < 4; i++) els.piecesBody.append(h('div', { class: 'wd-skel line' }));
      return;
    }
    if (p.error) {
      els.piecesSub.textContent = '';
      els.piecesBody.append(h('div', { class: 'wd-col-empty' }, p.error));
      return;
    }
    const missing = (p.items || []).filter((i) => i.missing).length;
    els.piecesSub.textContent = (p.items || []).length + ' piece' +
      ((p.items || []).length === 1 ? '' : 's') + (missing ? ' · ' + missing + ' unresolved' : '');

    if (!(p.items || []).length) {
      els.piecesBody.append(h('div', { class: 'wd-col-empty' },
        'Empty. Build it again from the Inventory tab to fill it.'));
      return;
    }
    p.items.forEach((it) => {
      els.piecesBody.append(h('div', { class: 'wd-pick' + (it.missing ? '' : ' in') },
        h('span', { class: 'wd-pick-n', style: it.missing ? 'color:#d98a8a' : null },
          it.name, h('span', { style: 'color:#6f6a5e;font-size:12px' },
            '  ' + it.slot + (it.plugin ? ' · ' + it.plugin : '') +
            (it.missing ? ' · plugin gone' : ''))),
        armedBtn('✕', '✓?', {
          key: 'delpc:' + p.name + ':' + it.formId,
          title: 'Remove this piece from the outfit',
          label: 'Remove ' + it.name,
          go: () => {
            toGame('wdRemovePiece', JSON.stringify({
              name: p.name, formId: it.formId, plugin: it.plugin,
            }));
            /* optimistic — C++ re-reads and pushes wdPieceList straight after */
            ui.pieces.items = ui.pieces.items.filter((x) => x.formId !== it.formId);
            render();
          },
        })));
    });
  }

  /* --------------------------------------------------- all-armour browsing -- */
  /* The Inventory tab draws from what you CARRY by default. Flip it to "All
   * armour" and it draws from the whole load order instead — thousands of
   * pieces you have never picked up, browsable by the mod that adds them. */

  function renderArmorSource() {
    const bar = h('div', { class: 'wd-fromrow wd-srcrow' },
      h('span', { class: 'wd-from-k' }, 'Show'));
    [['carried', 'What I carry'], ['all', 'All armour in the game']].forEach(([v, label]) => {
      bar.append(h('button', {
        class: 'wd-cat-pill' + (ui.invSource === v ? ' on' : ''), type: 'button',
        'aria-pressed': ui.invSource === v ? 'true' : 'false',
        title: v === 'carried'
          ? 'Build from the armour in your own inventory — what you can actually put on'
          : 'Browse every armour piece the load order defines, mod by mod. '
            + 'SOES conjures anything you pick that you do not own.',
        onclick: () => {
          ui.invSource = v;
          ui.invSlot = '';
          resetPaging();
          if (v === 'all' && !state.armorMods.length) toGame('wdArmorMods', '');
          render();
        },
      }, label));
    });
    return bar;
  }

  function renderAllArmor(q) {
    els.list.append(renderArmorSource());

    /* pick a mod first — a flat list of every armour in a 4,000-plugin load
     * order is not a list, it is a wall */
    const mods = state.armorMods.filter((m) => !q || m.plugin.toLowerCase().indexOf(q.toLowerCase()) !== -1);
    if (!ui.invMod) {
      if (!state.armorMods.length) {
        els.list.append(h('div', { class: 'wd-col-empty' }, 'Reading the load order…'));
        return 0;
      }
      els.list.append(h('div', { class: 'wd-col-empty' },
        'Pick a mod to see its armour. ' + state.armorMods.length
        + ' plugins add some — type in the search box above to find one.'));
      return paged(mods, (m) => h('button', {
        class: 'wd-npc', type: 'button', data: { k: 'mod:' + m.plugin },
        title: 'Show the ' + m.count + ' armour piece' + (m.count === 1 ? '' : 's')
             + ' in ' + m.plugin,
        onclick: () => {
          ui.invMod = m.plugin;
          state.modArmors = null;
          resetPaging();
          toGame('wdArmorsFor', JSON.stringify({ plugin: m.plugin }));
          render();
        },
      },
        h('div', { class: 'wd-npc-face ph' }, svgIcon(['M4 7h16v13H4z', 'M4 7l3-3h10l3 3'], 20)),
        h('div', { class: 'wd-npc-main' },
          h('div', { class: 'wd-npc-name' }, nameNodes(m.plugin, q)),
          h('div', { class: 'wd-npc-sub' },
            h('span', { class: 'wd-chip' }, m.count + ' armour piece' + (m.count === 1 ? '' : 's'))))));
    }

    /* inside one mod */
    els.list.append(h('div', { class: 'wd-fromrow wd-srcrow' },
      h('button', {
        class: 'ghost-btn', type: 'button',
        title: 'Back to the list of every mod that adds armour',
        onclick: () => { ui.invMod = ''; state.modArmors = null; resetPaging(); render(); },
      }, '‹ All mods'),
      h('span', { class: 'wd-from-k' }, ui.invMod)));

    const d = state.modArmors;
    if (!d || d.plugin !== ui.invMod) {
      for (let i = 0; i < 5; i++) els.list.append(h('div', { class: 'wd-skel row' }));
      return 0;
    }
    if (d.capped) {
      els.list.append(h('div', { class: 'wd-col-empty' },
        'Showing ' + d.shown + ' of ' + d.total + ' — search to narrow it.'));
    }
    const items = d.items.filter((i) => !q ||
      i.name.toLowerCase().indexOf(q.toLowerCase()) !== -1 ||
      i.slot.toLowerCase().indexOf(q.toLowerCase()) !== -1);
    return paged(items, (i) => invRow(i, q));
  }

  /* ==================================================== selection + bulk == */
  /* Right-click is not a thing you can rely on inside PrismaUI, and even where
   * it works it is undiscoverable. So every action is reachable by clicking:
   * click selects, a bar appears, the bar does the work. Ctrl/Shift extend the
   * selection; the ⋯ on each card opens the same menu right-click would. */

  function selKeyOf(row) { return ui.sub === 'wardrobes' ? row.id : row; }
  function selHas(k) { return ui.sel.indexOf(k) !== -1; }
  function selClear() { ui.sel = []; ui.selAnchor = null; }

  /** The keys currently on screen, in render order — shift-range needs it. */
  function selVisible() {
    return Array.prototype.map.call(
      els.list.querySelectorAll('[data-sel]'), (el) => el.dataset.sel);
  }

  function selToggle(k, e) {
    const vis = selVisible();
    if (e && e.shiftKey && ui.selAnchor && vis.indexOf(ui.selAnchor) !== -1) {
      const a = vis.indexOf(ui.selAnchor), b = vis.indexOf(k);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) if (!selHas(vis[i])) ui.sel.push(vis[i]);
    } else if (e && (e.ctrlKey || e.metaKey)) {
      const i = ui.sel.indexOf(k);
      if (i === -1) ui.sel.push(k); else ui.sel.splice(i, 1);
      ui.selAnchor = k;
    } else {
      /* plain click: select just this one, or drop the selection if it was the
         only thing selected — so a stray click always has an obvious undo */
      ui.sel = (ui.sel.length === 1 && selHas(k)) ? [] : [k];
      ui.selAnchor = k;
    }
    render();
  }

  function renderSelBar() {
    if (!ui.sel.length) return null;
    const n = ui.sel.length;
    const many = n > 1;
    const bar = h('div', { class: 'wd-selbar' },
      h('span', { class: 'wd-sel-n' }, n + ' selected'));

    if (ui.sub === 'outfits') {
      /* The two things you do with ONE outfit, front and centre — they were
         buried in the card's ⋯ menu and read as missing (Rober, 2026-08-02). */
      if (!many) {
        const one = ui.sel[0];
        bar.append(
          h('button', { class: 'wd-dress', type: 'button', title: 'Put this outfit on YOU, right now',
            onclick: () => {
              toGame('wdWear', JSON.stringify({ name: one }));
              toast('Changing into “' + one + '”…');
            } }, '👗 Wear'),
          h('button', { class: 'ghost-btn', type: 'button',
            title: 'Dress up, then E to shoot — the photo becomes this outfit’s card',
            onclick: () => {
              toGame('wdPortrait', JSON.stringify({ name: one }));
              toast('Dressing… then E to shoot, Esc to cancel');
            } }, '◉ Photo'));
      }
      bar.append(
        h('button', { class: many ? 'wd-dress' : 'ghost-btn', type: 'button', title: 'Put ' + (many ? 'these' : 'this') + ' in a wardrobe',
          onclick: () => openPicker('wardrobe') }, '◇ To wardrobe…'),
        h('button', { class: 'ghost-btn', type: 'button', title: 'Tag ' + (many ? 'them' : 'it'),
          onclick: () => openPicker('category') }, '⬢ Category…'),
        h('button', {
          class: 'ghost-btn', type: 'button',
          onclick: () => {
            /* if every one is already a favourite this un-favourites, so the
               button is a real toggle rather than a one-way trip */
            const allFav = ui.sel.every((nm) => (metaFor(nm) || {}).fav);
            ui.sel.forEach((nm) => { ensureMeta(nm).fav = !allFav; });
            touch();
          },
        }, '★ Favourite'),
        armedBtn('🗑 Delete', 'Delete ' + n + ' — click again', {
          key: 'bulkdel', title: 'Delete ' + (many ? 'these outfits' : 'this outfit') + ' from SOES',
          go: () => {
            const names = ui.sel.slice();
            names.forEach((nm) => toGame('wdOutfitDel', JSON.stringify({ name: nm })));
            selClear();
            touch();
            toast('Deleting ' + names.length + ' outfit' + (names.length === 1 ? '' : 's') + '…');
          },
        }));
    } else if (ui.sub === 'wardrobes') {
      bar.append(armedBtn('🗑 Delete', 'Delete ' + n + ' — click again', {
        key: 'bulkdelw', title: 'Delete ' + (many ? 'these wardrobes' : 'this wardrobe'),
        go: () => {
          ui.sel.slice().forEach((id) => {
            const w = wardrobeById(id);
            if (w) deleteWardrobe(w);
          });
          selClear();
          render();
        },
      }));
    }
    bar.append(h('button', { class: 'ghost-btn', type: 'button', onclick: () => { selClear(); render(); } }, 'Clear'));
    return bar;
  }

  /* ---------------------------------------------- the searchable picker -- */
  /* Type to narrow, arrows to move, Enter to take it — and if what you typed
   * does not exist yet, the top row CREATES it and assigns in one go. That last
   * part matters: with no categories yet there was previously nothing to pick,
   * so the feature looked missing entirely. */

  function openPicker(kind) {
    rememberOpener();
    ui.picker = { kind: kind, q: '', idx: 0 };
    render();
    setTimeout(() => { if (els.pickerInput) els.pickerInput.focus(); }, 30);
  }
  function closePicker() { ui.picker = null; render(); restoreOpener(); }

  function pickerRows() {
    const p = ui.picker;
    const q = (p.q || '').trim().toLowerCase();
    const src = p.kind === 'wardrobe'
      ? state.wardrobes.map((w) => ({ id: w.id, name: w.name,
          sub: (w.outfits || []).length + ' outfit' + ((w.outfits || []).length === 1 ? '' : 's'),
          on: ui.sel.every((nm) => (w.outfits || []).indexOf(nm) !== -1) }))
      : state.categories.map((c) => ({ id: c.id, name: c.name, hue: c.hue,
          on: ui.sel.every((nm) => ((metaFor(nm) || {}).categoryIds || []).indexOf(c.id) !== -1) }));
    return src.filter((r) => !q || r.name.toLowerCase().indexOf(q) !== -1);
  }

  function pickerApply(row) {
    const p = ui.picker;
    if (p.kind === 'wardrobe') {
      const w = wardrobeById(row.id);
      if (!w) return;
      w.outfits = w.outfits || [];
      /* if they are ALL in it already, this removes them — one control, both ways */
      if (row.on) ui.sel.forEach((nm) => { const i = w.outfits.indexOf(nm); if (i !== -1) w.outfits.splice(i, 1); });
      else ui.sel.forEach((nm) => { if (w.outfits.indexOf(nm) === -1) w.outfits.push(nm); });
      toast((row.on ? 'Removed from ' : 'Added to ') + w.name);
    } else {
      ui.sel.forEach((nm) => {
        const m = ensureMeta(nm);
        const i = m.categoryIds.indexOf(row.id);
        if (row.on) { if (i !== -1) m.categoryIds.splice(i, 1); }
        else if (i === -1) m.categoryIds.push(row.id);
      });
      toast((row.on ? 'Untagged ' : 'Tagged ') + row.name);
    }
    touch();
  }

  function pickerCreate(name) {
    const p = ui.picker;
    if (!name) return;
    if (p.kind === 'wardrobe') {
      const w = { id: newId('w'), name: name, hue: HUES[state.wardrobes.length % HUES.length],
        note: '', outfits: ui.sel.slice(), mode: 'bag', bag: [] };
      state.wardrobes.push(w);
      toast('Made “' + name + '” with ' + ui.sel.length + ' outfit' + (ui.sel.length === 1 ? '' : 's'));
    } else {
      const c = { id: newId('c'), name: name, hue: HUES[state.categories.length % HUES.length] };
      state.categories.push(c);
      ui.sel.forEach((nm) => ensureMeta(nm).categoryIds.push(c.id));
      toast('Tagged ' + ui.sel.length + ' as “' + name + '”');
    }
    ui.picker = null;
    touch();
  }

  function renderPicker() {
    const p = ui.picker;
    els.picker.classList.toggle('hidden', !p);
    if (!p) return;
    const what = p.kind === 'wardrobe' ? 'wardrobe' : 'category';
    els.pickerTitle.textContent = (p.kind === 'wardrobe' ? '◇ Add to wardrobe' : '⬢ Set category');
    els.pickerSub.textContent = ui.sel.length + ' outfit' + (ui.sel.length === 1 ? '' : 's') + ' selected';

    const rows = pickerRows();
    const typed = (p.q || '').trim();
    const exact = rows.some((r) => r.name.toLowerCase() === typed.toLowerCase());
    const canCreate = typed && !exact;
    const total = rows.length + (canCreate ? 1 : 0);
    if (p.idx >= total) p.idx = Math.max(0, total - 1);

    const inp = els.pickerInput;
    if (inp.value !== p.q) inp.value = p.q;
    inp.placeholder = 'Filter or type a new ' + what + '…';

    els.pickerList.textContent = '';
    let i = 0;
    if (canCreate) {
      const k = i++;
      els.pickerList.append(h('button', {
        class: 'wd-pick create' + (p.idx === k ? ' kb' : ''), type: 'button',
        onclick: () => pickerCreate(typed),
      }, h('span', { class: 'wd-pick-x' }, '＋'),
        h('span', { class: 'wd-pick-n' }, 'Create “' + typed + '”')));
    }
    rows.forEach((r) => {
      const k = i++;
      els.pickerList.append(h('button', {
        class: 'wd-pick' + (r.on ? ' in' : '') + (p.idx === k ? ' kb' : ''), type: 'button',
        onclick: () => pickerApply(r),
      },
        r.hue !== undefined
          ? h('span', { class: 'wd-swatch', style: 'background:' + hueCss(r.hue, 55, 55) })
          : null,
        h('span', { class: 'wd-pick-n' }, nameNodes(r.name, typed)),
        r.sub ? h('span', { style: 'font-size:12px;color:#6f6a5e' }, r.sub) : null,
        h('span', { class: 'wd-pick-x' }, r.on ? '✓' : '＋')));
    });
    if (!total) {
      els.pickerList.append(h('div', { class: 'wd-col-empty' },
        'No ' + what + ' yet — type a name to make one.'));
    }
  }

  /** Arrow/Enter/Esc inside the picker. Returns true when it handled the key. */
  function pickerKey(e) {
    const p = ui.picker;
    if (!p) return false;
    const rows = pickerRows();
    const typed = (p.q || '').trim();
    const canCreate = typed && !rows.some((r) => r.name.toLowerCase() === typed.toLowerCase());
    const total = rows.length + (canCreate ? 1 : 0);
    if (e.key === 'Escape') { closePicker(); return true; }
    if (e.key === 'ArrowDown') { p.idx = Math.min(total - 1, p.idx + 1); render(); return true; }
    if (e.key === 'ArrowUp') { p.idx = Math.max(0, p.idx - 1); render(); return true; }
    if (e.key === 'Enter') {
      if (canCreate && p.idx === 0) pickerCreate(typed);
      else {
        const r = rows[p.idx - (canCreate ? 1 : 0)];
        if (r) pickerApply(r);
      }
      return true;
    }
    return false;
  }

  /* ============================================================ builder = */

  /* Focus discipline for both dialogs: remember what opened it, trap Tab inside
   * while it's up, and hand focus back on close. Without the hand-back, closing
   * a dialog drops focus on <body> and the keyboard user loses their place. */
  /* Remember the opener by its STABLE KEY, not by the node: opening a dialog
   * re-renders, which detaches the very card you clicked, so a node reference
   * would always be stale by the time we hand focus back. */
  function rememberOpener() {
    const a = document.activeElement;
    ui.opener = (a && a.dataset && a.dataset.k && els.pane.contains(a)) ? a.dataset.k : null;
  }
  function restoreOpener() {
    const key = ui.opener;
    ui.opener = null;
    if (!key) return;
    const el = els.pane.querySelector('[data-k="' + cssEsc(key) + '"]');
    if (el) { try { el.focus(); } catch (e) { /* gone */ } }
  }
  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])'),
      (x) => !x.disabled && x.offsetParent !== null);
  }
  function trapTab(e, root) {
    if (e.key !== 'Tab') return false;
    const list = focusables(root);
    if (!list.length) return false;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); return true; }
    if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); return true; }
    return false;
  }

  function openBuilder(id) {
    rememberOpener();
    ui.builderId = id;
    ui.builderFilter = '';
    ui.armed = null;
    if (els.catSearch) els.catSearch.value = '';
    render();
    setTimeout(() => { if (els.catSearch) els.catSearch.focus(); }, 30);
  }
  function closeBuilder() {
    if (!ui.builderId) return;
    ui.builderId = null;
    ui.armed = null;
    render();
    restoreOpener();
  }

  function renderBuilder() {
    const w = ui.builderId ? wardrobeById(ui.builderId) : null;
    els.builder.classList.toggle('hidden', !w);
    if (!w) return;

    /* Rename in place — no prompt dialog exists in PrismaUI. */
    els.builderTitle.textContent = '';
    els.builderTitle.append(inlineInput(w.name, {
      key: 'wname:' + w.id, required: true, label: 'Wardrobe name',
      placeholder: 'Wardrobe name',
      commit: (v) => { w.name = v; touch(); },
    }));
    els.builderNote.textContent = '';
    els.builderNote.append(inlineInput(w.note || '', {
      key: 'wnote:' + w.id, class: 'note', label: 'Note',
      placeholder: 'Add a note…',
      commit: (v) => { w.note = v; touch(); },
    }));
    els.builderSwatch.style.background = hueCss(w.hue, 55, 55);
    els.builderSwatch.onclick = () => {
      w.hue = HUES[(HUES.indexOf(w.hue) + 1) % HUES.length];
      touch();
    };
    /* How this wardrobe picks. Bag = everything worn once before repeats; that
     * is what people mean by "vary her clothes". Random = independent rolls. */
    els.builderMode.textContent = '';
    const bag = (w.mode || 'bag') === 'bag';
    els.builderMode.append(h('button', {
      class: 'wd-cat-pill on', type: 'button',
      title: bag ? 'Every outfit is worn once before any repeats — click for true random'
        : 'Independent random rolls — click for a shuffle bag',
      onclick: () => { w.mode = bag ? 'random' : 'bag'; w.bag = []; touch(); },
    }, bag ? '⇄ Shuffle bag' : '⚄ Random'));

    els.builderDel.textContent = '';
    els.builderDel.append(armedBtn('✕ Delete', 'Delete — click again', {
      key: 'delw:' + w.id, label: 'Delete wardrobe ' + w.name,
      title: 'Delete this wardrobe (the outfits themselves are untouched)',
      go: () => deleteWardrobe(w),
    }));

    const missing = (w.outfits || []).filter(isMissing).length;
    els.builderSub.textContent = (w.outfits || []).length + ' outfit' +
      ((w.outfits || []).length === 1 ? '' : 's') + (missing ? ' · ' + missing + ' missing' : '');

    /* members */
    els.members.textContent = '';
    (w.outfits || []).forEach((nm, i) => els.members.append(memberRow(w, nm, i)));
    els.membersEmpty.classList.toggle('hidden', (w.outfits || []).length > 0);
    els.memCount.textContent = String((w.outfits || []).length);

    /* catalogue */
    els.catalogue.textContent = '';
    const q = ui.builderFilter;
    const names = soesNames().filter((nm) => !q || nm.toLowerCase().indexOf(q.toLowerCase()) !== -1);
    names.sort((a, b) => a.localeCompare(b));
    if (!names.length) {
      els.catalogue.append(h('div', { class: 'wd-col-empty' },
        state.soes.available ? 'No outfit matches that filter.' : 'SOES-NG isn’t answering.'));
    }
    names.forEach((nm) => {
      const inW = (w.outfits || []).indexOf(nm) !== -1;
      const m = metaFor(nm);
      const t = h('div', { class: 'wd-pick-t' });
      if (m && m.image) setArt(t, m.image);
      els.catalogue.append(h('button', {
        class: 'wd-pick' + (inW ? ' in' : ''), type: 'button',
        title: inW ? 'Remove from ' + w.name : 'Add to ' + w.name,
        onclick: () => { toggleMember(w, nm); },
      }, t, h('span', { class: 'wd-pick-n' }, nameNodes(nm, q)),
        h('span', { class: 'wd-pick-x' }, inW ? '✓' : '＋')));
    });
  }

  function memberRow(w, name, i) {
    const m = metaFor(name);
    const t = h('div', { class: 'wd-pick-t' });
    if (m && m.image) setArt(t, m.image);
    const miss = isMissing(name);
    return h('div', { class: 'wd-pick' + (miss ? '' : ' in'), role: 'listitem' },
      t,
      h('span', { class: 'wd-pick-n', style: miss ? 'color:#d98a8a' : null },
        name, miss ? ' — missing in SOES' : ''),
      h('button', {
        class: 'wd-pick-x', type: 'button', title: 'Remove from this wardrobe',
        style: 'background:transparent;border:none;cursor:pointer;font-family:inherit',
        onclick: () => { w.outfits.splice(i, 1); touch(); },
      }, '✕'));
  }

  function toggleMember(w, name) {
    const i = (w.outfits || []).indexOf(name);
    if (i === -1) w.outfits.push(name); else w.outfits.splice(i, 1);
    touch();
  }

  /* ============================================================== sheet = */

  function openSheet(npc) {
    rememberOpener();
    ui.sheetKey = keyOf(npc);
    ui.armed = null;
    ui.combo = null;      // field keys are shared across sheets — start shut
    render();
    setTimeout(() => {
      const f = focusables(els.sheetBody)[0];
      if (f) f.focus();
    }, 30);
  }
  function closePieces() { ui.pieces = null; ui.armed = null; render(); restoreOpener(); }

  function closeSheet() {
    if (!ui.sheetKey) return;
    ui.sheetKey = null;
    ui.armed = null;
    ui.combo = null;
    render();
    restoreOpener();
  }

  function renderSheet() {
    const npc = ui.sheetKey ? state.npcs.find((n) => keyOf(n) === ui.sheetKey) : null;
    els.sheet.classList.toggle('hidden', !npc);
    if (!npc) return;
    const a = ensureAssign(npc);

    els.sheetName.textContent = npc.name;
    els.sheetSub.textContent = (npc.tracked ? 'Tracked by SOES' : 'Not tracked') +
      (npc.wearing ? ' · wearing ' + npc.wearing : '');
    /* Same resolve + retry chain as the row (npcFace), but the sheet's face is a
     * STATIC <img> in the fragment, so drive it in place instead of building a
     * node. A face that cannot load hides rather than leaving a broken-image
     * box in the header. */
    setSheetFace(npc);

    const body = els.sheetBody;
    body.textContent = '';

    /* --- WHO DRESSES HER — the card's first question, answered before any
       detail. Three states, exactly one at a time:
         Wardrobe  = the deck/SOES assignment below
         NFF       = handed to Nether's Follower Framework (its claim flag —
                     claiming clears the Wardrobe assignment and untracks her
                     from SOES in the C++, so the two can never fight)
         Off       = nobody
       This rule always existed; it just lived in a refusal message you only
       met after trying the wrong thing. Now it is the control. */
    const nfp = PLUGINS.nff;
    const nfInfo = (nfp && nfp.infoFor) ? nfp.infoFor(keyOf(npc)) : null;
    const managed = (nfInfo && nfInfo.claimed) ? 'nff'
      : ((a.mode === 'outfit' || a.mode === 'wardrobe') ? 'wardrobe' : 'off');

    const mseg = h('div', { class: 'wd-seg' });
    [['wardrobe', 'Wardrobe'], ['nff', 'NFF'], ['off', 'Off']].forEach(([v, label]) => {
      mseg.append(h('button', {
        type: 'button', class: managed === v ? 'on' : '',
        title: v === 'wardrobe' ? 'The deck assigns her outfits (SOES)'
             : v === 'nff' ? 'Her follower framework dresses her (three sets)'
             : 'Nobody manages her clothes',
        /* The switch itself lives in setManagedFor() so the Followers tab's F7
           quick card can fire the SAME handover rather than growing a second
           path to nfClaim - see the quick* exports at the bottom of this file. */
        onclick: () => { const r = setManagedFor(keyOf(npc), v); if (r.msg) toast(r.msg); },
      }, label));
    });
    body.append(h('div', { class: 'wd-field' }, h('span', { class: 'wd-field-k' }, 'Managed by'), mseg));

    if (managed === 'nff') {
      /* Her three sets, the chest chooser and the satchel — NFF's own controls,
         rendered by the NFF module so the sheet and the (retired) tab cannot
         drift. Everything below this point is Wardrobe-mode machinery. */
      body.append(nfp && nfp.controlsFor ? nfp.controlsFor(keyOf(npc))
        : h('div', { class: 'nf-note dim' }, 'NFF module missing'));
      renderSheetTail(body, npc);
      return;
    }
    if (managed === 'off') {
      body.append(h('div', { class: 'wd-field' },
        h('span', { style: 'font-size:12.5px;color:#6f6a5e' },
          'Nobody manages her clothes. Pick Wardrobe or NFF above, or leave her be.')));
      renderSheetTail(body, npc);
      return;
    }

    /* --- Wardrobe mode: one outfit, or a pool --- */
    const seg = h('div', { class: 'wd-seg' });
    [['outfit', 'One outfit'], ['wardrobe', 'A wardrobe']].forEach(([v, label]) => {
      seg.append(h('button', {
        type: 'button', class: a.mode === v ? 'on' : '',
        title: v === 'outfit' ? 'She always wears one named outfit'
             : 'She draws from a wardrobe pool on a cadence',
        onclick: () => { a.mode = v; touch(); },
      }, label));
    });
    body.append(h('div', { class: 'wd-field' }, h('span', { class: 'wd-field-k' }, 'Assignment'), seg));

    /* --- the pick --- */
    if (a.mode === 'outfit') {
      body.append(h('div', { class: 'wd-field' },
        h('span', { class: 'wd-field-k' }, 'Outfit'),
        outfitCombo('assign-outfit', a.outfit, (v) => { a.outfit = v; touch(); })));
    } else if (a.mode === 'wardrobe') {
      const sel = combo('assign-wardrobe', wardrobeOptions(a.wardrobeId), a.wardrobeId,
        (v) => { a.wardrobeId = v; touch(); },
        { placeholder: 'Type to search wardrobes…', blank: '— pick a wardrobe —',
          label: 'Wardrobe', empty: 'No wardrobe matches',
          emptyAll: 'No wardrobes yet — make one on the Wardrobes tab.' });
      body.append(h('div', { class: 'wd-field' }, h('span', { class: 'wd-field-k' }, 'Wardrobe'), sel));

      /* --- cadence --- */
      const idx = cadenceIndex(a.cadenceHours);
      const val = h('span', { class: 'wd-cad-v' + (CADENCE[idx] ? '' : ' off') }, cadenceLabel(CADENCE[idx]));
      const range = h('input', {
        type: 'range', min: '0', max: String(CADENCE.length - 1), step: '1', value: String(idx),
        'aria-label': 'Re-roll cadence',
        oninput: (e) => {
          const hrs = CADENCE[clamp(Number(e.target.value) | 0, 0, CADENCE.length - 1)];
          val.textContent = cadenceLabel(hrs);
          val.className = 'wd-cad-v' + (hrs ? '' : ' off');
        },
        onchange: (e) => {
          a.cadenceHours = CADENCE[clamp(Number(e.target.value) | 0, 0, CADENCE.length - 1)];
          touch();
        },
      });
      const ticks = h('div', { class: 'wd-cad-ticks', 'aria-hidden': 'true' },
        h('span', null, 'never'), h('span', null, '6h'), h('span', null, '1d'), h('span', null, '7d'));
      body.append(h('div', { class: 'wd-field' },
        h('span', { class: 'wd-field-k' }, 'Change outfit'),
        h('div', { class: 'wd-cad' },
          h('span', { class: 'wd-cad-label' }, 'every'),
          h('div', { class: 'wd-cad-wrap' }, range, ticks),
          val),
        h('span', { class: 'wd-cad-next' },
          a.cadenceHours ? nextChangeNodes(a) : 'Only changes when you hit Dress, or on a location override.')));
    }

    /* --- location overrides --- */
    if (a.mode !== 'off') {
      const wrap = h('div', { class: 'wd-field' },
        h('span', { class: 'wd-field-k' }, 'Location overrides'));
      (a.locationOverrides || []).forEach((ov, i) => {
        /* 31 location types — the worst offender of the lot for a bare
           dropdown, and it sits in the same row as the wardrobe field, so it
           gets the same widget or the row reads as two different controls. */
        const locKey = 'ov-loc-' + i, wKey = 'ov-w-' + i;
        const locSel = combo(locKey, LOCATIONS.map((l) => ({ v: String(l.v), label: l.n })),
          String(Number(ov.loc) || 0), (v) => { ov.loc = Number(v); touch(); },
          { placeholder: 'Type to search places…', label: 'Where',
            empty: 'No place matches',
            /* never clearable: '' would coerce to 0, which is a REAL location
               type ("World (base)"), so a clear would silently re-target it */
            clearable: false });
        const wSel = combo(wKey, overrideOptions(ov),
          ov.outfit ? 'o:' + ov.outfit : ov.wardrobeId,
          (v) => {
            if (String(v).indexOf('o:') === 0) { ov.outfit = String(v).slice(2); ov.wardrobeId = ''; }
            else { ov.wardrobeId = v; ov.outfit = ''; }
            touch();
          },
          { placeholder: 'Type an outfit or wardrobe…', blank: '— outfit or wardrobe —',
            label: 'Worn in this place', empty: 'Nothing matches',
            emptyAll: 'No outfits or wardrobes yet — make one first.',
            /* No clear here: the row already ends in a ✕ that removes the whole
               override, and two ✕ six pixels apart meaning different things is
               a trap. An override with no target does nothing anyway, so the
               row's own ✕ IS the clear. */
            clearable: false });
        const rowOpen = !!(ui.combo && (ui.combo.key === locKey || ui.combo.key === wKey));
        wrap.append(h('div', { class: 'wd-loc-row' + (rowOpen ? ' open' : '') }, locSel, wSel,
          h('button', {
            class: 'wd-loc-del', type: 'button', title: 'Remove this override',
            onclick: () => { a.locationOverrides.splice(i, 1); touch(); },
          }, '✕')));
      });
      wrap.append(h('button', {
        class: 'ghost-btn', type: 'button', style: 'align-self:flex-start',
        onclick: () => { a.locationOverrides.push({ loc: 5600, wardrobeId: '' }); touch(); },
      }, '＋ Override'));
      body.append(wrap);
    }

    /* --- tracking + actions --- */
    const acts = h('div', { class: 'wd-seg' },
      h('button', {
        type: 'button', class: npc.tracked ? 'on' : '',
        title: 'Whether SOES-NG manages this actor’s equipment at all',
        /* Shared with the F7 quick card, same as the mode switch above. */
        onclick: () => { const r = setTrackedFor(keyOf(npc), !npc.tracked); if (r.msg) toast(r.msg); },
      }, npc.tracked ? '✓ Tracked by SOES' : 'Track in SOES'),
      h('button', {
        type: 'button',
        title: 'Apply her assigned outfit right now',
        disabled: !state.soes.available || a.mode === 'off',
        onclick: () => dressNow(npc),
      }, '✦ Dress now'));
    body.append(h('div', { class: 'wd-field' }, h('span', { class: 'wd-field-k' }, 'SOES'), acts));

    renderSheetTail(body, npc);
  }

  /* The part of the card every MODE shares: her inventory and the Tailor
     warning. Split out when the mode switch landed, so NFF and Off don't lose
     it by returning early. Deliberately in the SHEET and the right-click menu,
     not on the row: the row already carries a name, chips and buttons, and
     more there collides with the chip wrap at narrow panel widths. */
  function renderSheetTail(body, npc) {
    const quick = h('div', { class: 'wd-seg' },
      h('button', {
        type: 'button',
        title: 'Open the real container menu — give her something, or take it back. Closes the deck.',
        disabled: !npc.formId,
        onclick: () => openNpcInventory(npc),
      }, '☰ Trade / inventory'),
      /* NFF's EXTRA storage — a third container, separate from her inventory
         and her outfit chests. The op has existed on the Followers card for a
         while; the People card never offered it, which made "extra storage"
         unreachable from the one surface that is supposed to hold everything
         about her clothes (Rober's completeness list, 2026-08-03). */
      h('button', {
        type: 'button',
        title: 'Open her NFF spare storage — extra carrying space, not her own inventory. Closes the deck.',
        disabled: !npc.formId,
        onclick: () => {
          toGame('fdNpc', JSON.stringify({
            op: 'storage', formId: String(npc.formId), name: npc.name || '' }));
          toast('Opening ' + npc.name + '’s spare storage…');
        },
      }, '📦 Spare storage'));
    const sid = subFocusId();
    if (sid) {
      quick.append(h('button', {
        type: 'button',
        title: 'Jump to the ' + (SUB_LABEL[sid] || sid) + ' tab, focused on ' + npc.name,
        onclick: () => focusInSub(npc, sid),
      }, '◇ ' + (SUB_LABEL[sid] || sid) + ' outfits'));
    }
    body.append(h('div', { class: 'wd-field' },
      h('span', { class: 'wd-field-k' }, 'Quick actions'), quick));

    if (npc.conflict) {
      body.append(h('div', { style: 'font-size:12.5px;color:#e0b0b0;line-height:1.5' },
        '⚠ This person is also assigned an outfit in Tailor. Both mods will try to dress ' +
        'them and they will fight — clear one of the two.'));
    }
  }

  /* The sheet header's face. Kept out of renderSheet() so the retry handler is
   * installed exactly once per src change rather than once per repaint (the
   * sheet re-renders on every keystroke in it). */
  let sheetFaceSrc = null;      // what we last ASKED for, incl. the ?v= form
  function setSheetFace(npc) {
    const img = els.sheetFace;
    if (!img) return;
    const p = npc.portrait ? null : portraitFor(npc);
    const plain = npc.portrait || (p ? 'portraits/' + p.file : '');
    const want = plain ? (npc.portrait ? plain : plain + '?v=' + (p.mtime || 0)) : '';
    if (want === sheetFaceSrc) return;         // already showing this exact face
    sheetFaceSrc = want;
    if (!want) { img.classList.add('hidden'); img.removeAttribute('src'); return; }
    let retried = false;
    img.onerror = function () {
      if (!retried && plain !== want) { retried = true; img.src = plain; return; }
      glog('portrait failed to load: ' + plain);
      img.onerror = null;
      img.classList.add('hidden');
    };
    img.onload = function () { img.classList.remove('hidden'); };
    img.src = want;
    img.alt = '';
    img.title = npc.name || '';
    img.classList.remove('hidden');
  }

  /* "next change in ~5h" — only when C++ has told us the game clock, so the
   * line is never a guess. Falls back to describing the rule. */
  function nextChangeNodes(a) {
    const base = 'Re-rolls in game, never the same outfit twice in a row.';
    if (typeof state.now !== 'number' || !a.lastRollDay) return base;
    const dueDays = a.lastRollDay + (a.cadenceHours / 24);
    const leftH = Math.round((dueDays - state.now) * 24);
    if (leftH <= 0) return [document.createTextNode('Due now — '), h('b', null, 'changes on the next tick.')];
    return [
      document.createTextNode('Next change in '),
      h('b', null, leftH < 24 ? '~' + leftH + 'h' : '~' + Math.round(leftH / 24) + 'd'),
      document.createTextNode('. ' + (a.lastOutfit ? 'Currently ' + a.lastOutfit + '.' : '')),
    ];
  }

  /* The outfit field. A stored outfit SOES no longer has is still OFFERED and
   * still flagged — dropping it silently would lose an assignment the moment
   * a mod is toggled off, which is exactly when you need to see it. */
  function outfitCombo(key, current, onPick) {
    const names = soesNames().slice().sort((a, b) => a.localeCompare(b));
    const opts = names.map((nm) => {
      const o = soesOutfit(nm);
      const n = o ? Number(o.items) : 0;
      return { v: nm, label: nm, sub: n ? n + (n === 1 ? ' piece' : ' pieces') : null };
    });
    if (current && names.indexOf(current) === -1) {
      opts.unshift({ v: current, label: current, warn: 'missing in SOES' });
    }
    return combo(key, opts, current, onPick, {
      placeholder: 'Type to search outfits…', blank: '— pick an outfit —',
      label: 'Outfit', empty: 'No outfit matches',
      emptyAll: 'SOES has no outfits yet — build one on the Inventory tab.',
    });
  }

  /** Wardrobe options, with a dangling id kept and flagged rather than dropped. */
  function wardrobeOptions(current) {
    const opts = state.wardrobes.map((w) => {
      const n = (w.outfits || []).length;
      return { v: w.id, label: w.name, hue: w.hue, sub: n + (n === 1 ? ' outfit' : ' outfits') };
    });
    if (current && !wardrobeById(current)) {
      opts.unshift({ v: current, label: 'Deleted wardrobe', warn: 'no longer exists' });
    }
    return opts;
  }

  /* A location override can hold the full base logic: pin ONE outfit there
   * (SOES's own behaviour — value "o:<name>") or inject a wardrobe that rolls
   * fresh (value = the wardrobe id, unchanged so old configs read as-is). */
  function overrideOptions(ov) {
    const cur = ov.outfit ? 'o:' + ov.outfit : (ov.wardrobeId || '');
    const opts = wardrobeOptions(ov.outfit ? '' : ov.wardrobeId)
      .map((o) => (o.warn ? o : Object.assign({}, o, { sub: '◇ ' + (o.sub || 'wardrobe') })));
    soesNames().forEach((nm) => opts.push({ v: 'o:' + nm, label: nm, sub: '👗 always this outfit' }));
    if (ov.outfit && !soesOutfit(ov.outfit) && state.soes.available)
      opts.unshift({ v: cur, label: ov.outfit, warn: 'outfit no longer exists' });
    return opts;
  }

  /* ============================================================ actions = */

  /* ---- the two mode switches, as FUNCTIONS ----------------------------
   *
   * "Who dresses her" and "does SOES track her" are the People sheet's lead
   * controls, and the Followers tab's F7 quick card now offers both for
   * whoever is under the crosshair. They live here, once, and BOTH surfaces
   * call them: a second copy of the handover rule would drift the first time
   * either side changed, and the handover is the one place the two outfit
   * backends touch (claiming clears her Wardrobe assignment and untracks her
   * from SOES, in C++, so exactly one system ever holds her).
   *
   * They answer {ok,msg} rather than toasting, because the quick card puts its
   * verdicts on the card itself (a toast is gone before you have read it, and
   * the refusal is the useful sentence). The caller decides where the words go.
   */
  function setManagedFor(key, v) {
    const npc = npcByKey(key);
    if (!npc) return { ok: false, msg: 'The Wardrobe hasn\u2019t heard of her yet' };
    const a = ensureAssign(npc);
    const nfp = PLUGINS.nff;
    const info = (nfp && nfp.infoFor) ? nfp.infoFor(keyOf(npc)) : null;
    const managed = (info && info.claimed) ? 'nff'
      : ((a.mode === 'outfit' || a.mode === 'wardrobe') ? 'wardrobe' : 'off');
    if (managed === v) return { ok: true, msg: '' };
    if (v === 'nff') {
      /* One op does the whole handover in C++. The reply re-exports both
         sides, so every card repaints in the new mode on its own. */
      if (nfp && nfp.setClaim && nfp.setClaim(keyOf(npc), true))
        return { ok: true, msg: 'Handing ' + npc.name + ' to NFF\u2026' };
      return { ok: false, msg: 'NFF doesn\u2019t know her yet \u2014 recruit her first' };
    }
    if (managed === 'nff' && nfp && nfp.setClaim) nfp.setClaim(keyOf(npc), false);
    a.mode = (v === 'wardrobe') ? (a.outfit ? 'outfit' : (a.wardrobeId ? 'wardrobe' : 'outfit')) : 'off';
    touch();
    return { ok: true, msg: v === 'wardrobe'
      ? 'The Wardrobe dresses ' + npc.name + ' now \u2014 give her an outfit'
      : 'Nobody manages ' + npc.name + '\u2019s clothes now' };
  }

  function setTrackedFor(key, on) {
    const npc = npcByKey(key);
    if (!npc) return { ok: false, msg: 'The Wardrobe hasn\u2019t heard of her yet' };
    const a = assignFor(keyOf(npc));
    if (on && (!a || a.mode === 'off'))
      return { ok: false, msg: 'Give them an outfit first \u2014 SOES strips a tracked actor it can\u2019t dress.' };
    toGame('wdTrack', JSON.stringify({ formId: npc.formId, plugin: npc.plugin, track: !!on }));
    return { ok: true, msg: on ? 'Tracking ' + npc.name + ' in SOES\u2026'
                              : 'SOES leaves ' + npc.name + ' alone now' };
  }

  /* ---- what the F7 quick card asks this pane -------------------------
   *
   * The Followers tab's LOOKING-AT card reached parity with the People card on
   * 2026-08-03, and the only thing it does NOT own is the data: who dresses
   * this actor, whether SOES tracks her, what she is assigned. That lives here
   * and is READ from here, never copied - one source of truth, so a mode
   * changed on either surface is the mode both surfaces show.
   *
   * The crosshair snapshot carries a bare runtime form id and no plugin (see
   * fdTarget), so the lookup is by canonical id alone. null = "the Wardrobe has
   * never heard of her", which the card renders as an honest sentence rather
   * than as a set of dead controls. */
  function quickAbout(formIdLike) {
    const npc = npcByRuntimeId(formIdLike);
    if (!npc) return null;
    const key = keyOf(npc);
    const who = modeOf(npc);
    const a = who.a || assignFor(key);
    let label = '';
    if (who.mode === 'wardrobe' && a) {
      if (a.mode === 'outfit') label = a.outfit || '';
      else { const w = wardrobeById(a.wardrobeId); label = w ? w.name : ''; }
    }
    return {
      key: key, name: npc.name || '', mode: who.mode,
      tracked: !!npc.tracked, wearing: npc.wearing || '',
      conflict: !!npc.conflict,                       // Tailor also dresses her
      twoSystems: !!(who.info && who.info.conflict),  // Wardrobe AND NFF do
      label: label,
      cadence: (who.mode === 'wardrobe' && a && a.mode === 'wardrobe')
        ? cadenceLabel(a.cadenceHours) : '',
      canDress: !!(state.soes.available && a && a.mode !== 'off'),
      soes: !!state.soes.available,
    };
  }
  function quickSetManaged(key, v) { return setManagedFor(key, v); }
  function quickTrack(key, on) { return setTrackedFor(key, on); }
  function quickDress(key) {
    const npc = npcByKey(key);
    if (!npc) return { ok: false, msg: 'The Wardrobe hasn\u2019t heard of her yet' };
    const a = assignFor(key);
    if (!a || a.mode === 'off')
      return { ok: false, msg: 'Assign an outfit or a wardrobe to her first' };
    if (!state.soes.available)
      return { ok: false, msg: 'SOES-NG isn\u2019t answering \u2014 nothing to dress her with' };
    toGame('wdDress', JSON.stringify({ formId: npc.formId, plugin: npc.plugin }));
    return { ok: true, msg: 'Dressing ' + npc.name + '\u2026' };
  }
  /* ---- ⚡ Quick apply (the F7 card's outfit dock, 2026-08-11) -------------
   * Rober: "a typing box that i can search outfits and quickly apply — it
   * forces the equip then and there."  Two exports serve it: the CATALOGUE
   * (rich enough to draw a real row, not just a name) and the ACT.
   *
   * quickOutfits() dedupes by name with SOES first, because SOES's catalogue
   * is the identity every wear/dress op takes — but an outfit that so far
   * exists only as our metadata (built this session, SOES's export not cycled
   * yet) is still offered rather than silently missing, flagged `pending` so
   * the caller can say so. */
  /* Everyone this outfit belongs to: its own owner pills plus the owner pills
     of every wardrobe holding it, deduped by key. Inherited ones are flagged so
     the pill can say WHY it is there (and so the dock never offers to un-tag
     something that is not the outfit's to un-tag). */
  function ownersOf(outfitName) {
    const out = [], seen = Object.create(null);
    const add = (t, via) => {
      const k = String((t && t.key) || '').toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push({ key: t.key, name: t.name || '', via: via || '' });
    };
    const m = metaFor(outfitName);
    ((m && m.forNpcs) || []).forEach((t) => add(t, ''));
    (state.wardrobes || []).forEach((w) => {
      if (!(w.outfits || []).some((n) => n === outfitName)) return;
      (w.forNpcs || []).forEach((t) => add(t, w.name || 'a wardrobe'));
    });
    return out;
  }
  /* Free-text tags, same inheritance rule. */
  function tagsOf(outfitName) {
    const out = [], seen = Object.create(null);
    const add = (t) => { const k = String(t || '').toLowerCase(); if (!k || seen[k]) return; seen[k] = true; out.push(String(t)); };
    const m = metaFor(outfitName);
    ((m && m.tags) || []).forEach(add);
    (state.wardrobes || []).forEach((w) => {
      if (!(w.outfits || []).some((n) => n === outfitName)) return;
      (w.tags || []).forEach(add);
    });
    return out;
  }

  function quickOutfits() {
    const out = [], seen = Object.create(null);
    const add = (name, pieces, pending) => {
      const nm = String(name || '');
      if (!nm || seen[nm]) return;
      seen[nm] = true;
      const m = metaFor(nm);
      out.push({
        name: nm,
        pieces: (typeof pieces === 'number' && pieces >= 0) ? pieces : -1,
        note: (m && m.note) || '',
        image: (m && m.image) || '',
        fav: !!(m && m.fav),
        pending: !!pending,
        categories: ((m && m.categoryIds) || [])
          .map((id) => { const c = catById(id); return c ? c.name : ''; })
          .filter(Boolean),
        /* The pill row. `tags` is free text; `forNpcs` is "she owns this", the
           one the dock filters on. Both are carried on the outfit AND inherited
           from every wardrobe that contains it — tagging a whole wardrobe
           "Lydia's" is the point of tagging a wardrobe at all, and an outfit
           inside it that did not show her pill would make the tag look broken. */
        tags: tagsOf(nm),
        forNpcs: ownersOf(nm),
      });
    };
    ((state.soes && state.soes.outfits) || []).forEach((o) => {
      add(o.name, Array.isArray(o.items) ? o.items.length : (o.items >>> 0), false);
    });
    (state.outfitMeta || []).forEach((m) => add(m.name, -1, true));
    return out;
  }

  /* Assign an outfit AND put it on her, in one op. Deliberately not a second
     implementation of either half: it writes the same Assignment the People
     card writes and then fires the same wdDress "Dress now" fires — so what
     Quick apply does is exactly what her card would show a moment later.
     Ordering is the whole trick, and it is why saveNow() exists (see above).

     `andThen` is called once the dress has been sent, so a caller can repaint
     on the real timing rather than guess it. */
  function quickWear(key, outfitName, andThen) {
    const npc = npcByKey(key);
    const name = String(outfitName || '').trim();
    if (!npc) return { ok: false, msg: 'The Wardrobe hasn’t heard of her yet' };
    if (!name) return { ok: false, msg: 'No outfit named' };
    if (!state.soes.available)
      return { ok: false, msg: 'SOES-NG isn’t answering — nothing to dress her with' };

    const nfp = PLUGINS.nff;
    const info = (nfp && nfp.infoFor) ? nfp.infoFor(keyOf(npc)) : null;
    const claimed = !!(info && info.claimed);
    /* NFF holds her: the C++ one-actor-one-backend guard would refuse the
       dress, so hand her over FIRST and let that round-trip land before the
       assignment is written — nfClaim clears her Wardrobe assignment on its
       way through, and a save that raced it would be undone. */
    if (claimed && nfp && nfp.setClaim) nfp.setClaim(keyOf(npc), false);

    const go = () => {
      const a = ensureAssign(npc);
      a.mode = 'outfit';
      a.outfit = name;
      saveNow();
      render();
      setTimeout(() => {
        toGame('wdDress', JSON.stringify({ formId: npc.formId, plugin: npc.plugin }));
        if (typeof andThen === 'function') andThen();
      }, 160);
    };
    if (claimed) setTimeout(go, 420); else go();

    return { ok: true, msg: (claimed ? 'Taking her back from NFF, then dressing ' : 'Dressing ')
      + (npc.name || 'her') + ' in “' + name + '”…' };
  }

  /* "Just put it on her" — the dock's third destination (Rober, 2026-08-11:
     "what about option to just drop it into inventory and force equip?").
     Enrols her in NOTHING: no assignment for SOES to own, no NFF set. C++ adds
     the outfit's pieces to her inventory and force-equips them.

     REFUSED while SOES tracks her, in words rather than by letting it fail
     silently: SOES re-dresses a tracked actor within its 2 s poll, so the
     force-equip would visibly undo itself a moment later — the same hazard
     nff_outfits.cpp documents when NFF claims someone SOES still holds. NFF
     claiming her is fine; NFF only acts on its own wear/switch ops. */
  function quickGiveWear(key, outfitName) {
    const npc = npcByKey(key);
    const name = String(outfitName || '').trim();
    if (!npc) return { ok: false, msg: 'The Wardrobe hasn’t heard of her yet' };
    if (!name) return { ok: false, msg: 'No outfit named' };
    if (npc.tracked)
      return { ok: false, msg: 'SOES-NG is managing ' + (npc.name || 'her')
        + ' — it would put its own outfit back within seconds. Switch her to ○ Nobody first.' };
    toGame('wdGiveWear', JSON.stringify({
      formId: npc.formId, plugin: npc.plugin, outfit: name }));
    return { ok: true, msg: 'Putting “' + name + '” straight on ' + (npc.name || 'her') + '…' };
  }

  /* "This one is hers" — the owner pill, toggled from the F7 dock (Rober,
     2026-08-11). Writes to the OUTFIT's own metadata, never to a wardrobe: an
     inherited pill belongs to the wardrobe that carries it and un-tagging it
     from here would quietly edit a group the player did not open.

     `key` is the actor's durable identity (the same "0xABCD|Mod.esp" shape
     assignments use); `name` is cached alongside purely so the pill can be
     drawn with the game shut. Returns {ok,msg,on} so the caller can say what
     happened AND repaint from the truth rather than from its own assumption. */
  function quickTagOwner(outfitName, key, name, on) {
    const nm = String(outfitName || '').trim();
    const k = String(key || '').trim();
    if (!nm) return { ok: false, msg: 'No outfit named' };
    if (!k) return { ok: false, msg: 'No-one to tag it for' };
    const m = ensureMeta(nm);
    if (!Array.isArray(m.forNpcs)) m.forNpcs = [];
    const lower = k.toLowerCase();
    const had = m.forNpcs.some((t) => String(t.key || '').toLowerCase() === lower);
    const want = (typeof on === 'boolean') ? on : !had;
    if (want === had) return { ok: true, msg: '', on: had };
    if (want) {
      if (m.forNpcs.length >= 24)
        return { ok: false, msg: 'That outfit already has 24 owner tags' };
      m.forNpcs.push({ key: k, name: String(name || '') });
    } else {
      m.forNpcs = m.forNpcs.filter((t) => String(t.key || '').toLowerCase() !== lower);
    }
    touch();
    const who = String(name || 'her');
    return { ok: true, on: want,
      msg: want ? '“' + nm + '” is ' + who + '’s now' : '“' + nm + '” is no longer tagged for ' + who };
  }

  /* Free-text tags on an outfit or a wardrobe. `what` is 'outfit' | 'wardrobe'.
     Exposed for the Wardrobe tab's own editors and for the portal; the F7 dock
     only ever touches the OWNER pill above. */
  function setTags(what, id, tags) {
    const list = (Array.isArray(tags) ? tags : [])
      .map((t) => String(t || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 24);
    let target = null;
    if (what === 'wardrobe') target = wardrobeById(id);
    else target = ensureMeta(String(id || ''));
    if (!target) return { ok: false, msg: 'No such ' + what };
    target.tags = list;
    touch();
    return { ok: true, msg: list.length ? (list.length + ' tag' + (list.length === 1 ? '' : 's')) : 'Tags cleared' };
  }

  /* Open her People card. The caller switches to the Wardrobe TAB (app.js owns
     that); this only aims the pane, so a harness with no tab bar still works. */
  function quickFocus(key) {
    const npc = npcByKey(key);
    if (!npc) return false;
    ui.sub = 'npcs';             // the People sub-tab, so the sheet has a body
    openSheet(npc);
    return true;
  }
  /* Ask C++ for both slices. The receivers are installed at load time and are
     independent of which tab is showing, so this is safe from anywhere - and it
     is the ONLY way the quick card can have an answer before the Wardrobe tab
     has ever been opened this session. */
  /* The NFF module's data changed (a claim, a wear, a clear answered). Repaint
     whatever is currently drawn from it: the People rows and the open sheet on
     this pane, and the F7 quick card's clothes block on the Followers pane.
     This is the missing half of the mode switch — the C++ did the handover
     instantly, the view just never heard. */
  function nffDataChanged() {
    if (ui.inited && ui.sub === 'npcs') render();   // rows + sheet both re-read live state
    const fp = window.FolPane;
    if (fp && typeof fp.clothesChanged === 'function') fp.clothesChanged();
  }

  function quickRefresh() {
    toGame('wdGet', '');
    const nf = PLUGINS.nff;
    if (nf && nf.refreshData) nf.refreshData();
  }

  function dressNow(npc) {
    const a = assignFor(keyOf(npc));
    if (!a || a.mode === 'off') { toast('Assign an outfit or wardrobe first.'); return; }
    toGame('wdDress', JSON.stringify({ formId: npc.formId, plugin: npc.plugin }));
    toast('Dressing ' + npc.name + '…');
  }

  /* ---- trade / open their inventory ----
   * Straight onto the Followers tab's existing bridge (src/nff_control.cpp
   * `NffControl::Apply`, op "inventory"): C++ force-opens the real container
   * menu and CLOSES the palette first, because the container needs the focus
   * back. So there is nothing to render afterwards — the reply lands on
   * `fdNpcResult`, whose only receiver is the Followers pane, and C++ also puts
   * the outcome up as a game notification, which is the one you can still read
   * once the deck is gone.
   *
   * We send `plugin` alongside `formId` where the Followers tab sends only the
   * id: our rows come from Follower Organizer's own JSON, so the id is a LOCAL
   * form id and needs its plugin to resolve (C++ ParseHex accepts the "0x…"
   * spelling either way, and falls back to a global LookupByID without one). */
  function openNpcInventory(npc) {
    if (!npc || !npc.formId) { toast('No form id for them — can’t open their inventory.'); return; }
    toGame('fdNpc', JSON.stringify({
      op: 'inventory', formId: String(npc.formId), plugin: String(npc.plugin || ''),
    }));
    toast('Opening ' + npc.name + '’s inventory…');
  }

  /* ---- hand off to a sub-tab that knows this person ----
   * The NFF outfit backend is already a registered sub-tab (wardrobe-nff.js),
   * so "show me her NFF outfits" is a JUMP, never a second bridge. Any plug-in
   * that offers focusNpc(npc) gets the affordance; none is loaded in the
   * standalone harness, and then the button simply is not drawn. */
  function subFocusId() {
    const ids = Object.keys(PLUGINS);
    for (let i = 0; i < ids.length; i++) {
      // A hidden plug-in has no tab to jump TO — offering the jump would land
      // on a tab the bar no longer shows.
      if (PLUGINS[ids[i]].hidden) continue;
      if (typeof PLUGINS[ids[i]].focusNpc === 'function') return ids[i];
    }
    return null;
  }

  function focusInSub(npc, id) {
    id = id || subFocusId();
    const p = id ? PLUGINS[id] : null;
    if (!p) { toast('The NFF outfit tab isn’t loaded.'); return false; }
    /* Close the sheet by hand rather than via closeSheet(): that renders once
     * on the OLD sub-tab and hands focus back to a row we are about to remove,
     * which reads as a flicker. One render, at the end, on the new tab. */
    hideMenu();
    ui.sheetKey = null;
    ui.armed = null;
    ui.opener = null;
    ui.sub = id;
    ui.filter = '';
    if (els.search) els.search.value = '';
    resetPaging();
    try {
      p.setFilter('');
      p.onEnter();
      p.focusNpc({ formId: npc.formId, plugin: npc.plugin, name: npc.name });
    } catch (e) {
      console.log('[wardrobe] sub focus', id, e);
      glog('sub focus ' + id + ' ' + e);
    }
    render();
    if (els.body) els.body.scrollTop = 0;
    return true;
  }

  /* ============================================================== menus = */

  /* ---- arrow-key navigation ----
   * Cards and rows are real <button>s, so Tab already works. Arrows add
   * grid/list movement, which is what you actually reach for with 200 outfits
   * on screen. Column count is measured from the live layout, so it stays
   * right at any width or menu scale. */
  function navKeys(e) {
    const a = document.activeElement;
    const host = els.catalogue.contains(a) ? els.catalogue
      : els.members.contains(a) ? els.members
        : els.list.contains(a) ? els.list : null;
    if (!host) return false;

    const items = Array.prototype.filter.call(
      host.querySelectorAll('.wd-card, .wd-npc, .wd-pick, .wd-more'),
      (x) => !x.disabled && x.offsetParent !== null);
    const i = items.indexOf(a);
    if (i < 0) return false;

    const grid = host === els.list && els.list.classList.contains('grid');
    let cols = 1;
    if (grid && items.length) {
      const top = items[0].offsetTop;
      cols = items.filter((x) => x.offsetTop === top).length || 1;
    }

    let n = i;
    switch (e.key) {
      case 'ArrowRight': n = i + 1; break;
      case 'ArrowLeft': n = i - 1; break;
      case 'ArrowDown': n = grid ? i + cols : i + 1; break;
      case 'ArrowUp': n = grid ? i - cols : i - 1; break;
      case 'Home': n = 0; break;
      case 'End': n = items.length - 1; break;
      default: return false;
    }
    n = clamp(n, 0, items.length - 1);
    if (n !== i) {
      items[n].focus();
      if (items[n].scrollIntoView) items[n].scrollIntoView({ block: 'nearest' });
    }
    e.preventDefault();
    return true;
  }

  function showMenu(e, items) {
    const m = els.menu;
    m.textContent = '';
    items.forEach((it) => {
      /* A falsy entry is a conditional item that did not apply — building the
       * array with `cond ? {…} : null` reads far better at the call site than
       * a push-if chain, so skip it here rather than making every caller filter. */
      if (!it) return;
      if (it === '-') { m.append(h('div', { class: 'wd-menu-sep' })); return; }
      /* A destructive item arms on the first click and relabels in place —
       * there is no window.confirm to fall back on. */
      const btn = h('button', {
        class: 'wd-menu-i' + (it.danger ? ' danger' : ''), type: 'button',
        title: it.title || it.label,
        onclick: () => {
          if (it.arms && ui.armed !== it.arms) {
            ui.armed = it.arms;
            btn.textContent = 'Click again to confirm';
            btn.classList.add('armed');
            return;
          }
          ui.armed = null;
          hideMenu();
          it.go();
        },
      }, it.label);
      m.append(btn);
    });
    m.classList.remove('hidden');

    /* Place it inside the PANE, in the menu's OWN coordinate space.
     *
     * #wd-menu is position:fixed, but "fixed" here does not mean "the viewport":
     * an ancestor with a transform becomes the containing block AND the clip for
     * a fixed descendant, and this menu now has two of them — #panel (the deck's
     * menu scale) and #wd-scale (this tab's own scale). So a raw clientX/clientY
     * lands offset by those ancestors' origin and stretched by their scale; that
     * was already visibly wrong by the panel's offset before the tab scale
     * existed, and the tab scale would have made it worse.
     *
     * Rather than trying to name the ancestors, MEASURE: park the menu at its own
     * 0,0 and read where that lands on screen, and read the accumulated scale off
     * the ratio of its painted width to its laid-out width. Correct for any stack
     * of transforms, including none. */
    m.style.left = '0px';
    m.style.top = '0px';
    m.style.maxHeight = '';
    let zero = m.getBoundingClientRect();
    const scale = (m.offsetWidth > 0 && zero.width > 0) ? (zero.width / m.offsetWidth) : 1;
    /* A nine-item menu at 160% tab scale is 746px tall in a 600px pane, and the
       pane clips — the last items were simply gone. Cap it to what the pane can
       show (in the menu's OWN px, hence the divide) and let it scroll. */
    const room = els.pane.getBoundingClientRect().height - 12;
    if (zero.height > room) {
      m.style.maxHeight = (room / scale) + 'px';
      zero = m.getBoundingClientRect();
    }
    let x = e.clientX, y = e.clientY;
    if (x == null || y == null) {
      const t = (e.target && e.target.getBoundingClientRect) ? e.target.getBoundingClientRect() : { left: 40, bottom: 40 };
      x = t.left; y = t.bottom;
    }
    /* Clamp to the pane, not the window: #wd-pane clips this menu, so a menu
       "inside the viewport" but past the pane's edge is simply invisible. */
    const box = els.pane.getBoundingClientRect();
    x = Math.max(box.left + 6, Math.min(x, box.right - zero.width - 6));
    y = Math.max(box.top + 6, Math.min(y, box.bottom - zero.height - 6));
    m.style.left = ((x - zero.left) / scale) + 'px';
    m.style.top = ((y - zero.top) / scale) + 'px';
  }
  /* Guarded, like els.pane is on the very next line in onHide(). Unguarded it
     threw on EVERY palette close before this pane had ever rendered its menu:
     hdClosed -> onHide -> hideMenu, and els.menu is only cached once the pane
     builds. Worse than a stray error, the pane hdClosed handlers are chained,
     so a throw here stopped the panes after it from ever seeing onHide. */
  function hideMenu() { if (els.menu) els.menu.classList.add('hidden'); ui.armed = null; }

  /* A ctx-menu click has no anchor ELEMENT to hang a picker off, only a point.
     Hand openPicker a zero-height box 340px wide starting at the click so its
     right-align maths lands the picker's LEFT edge under the cursor; its own
     viewport clamp and flip-up then do the rest. 340 is #wd-catpick's width. */
  function menuRect(e) {
    const x = (e && e.clientX != null) ? e.clientX : 60;
    const y = (e && e.clientY != null) ? e.clientY : 60;
    return { left: x, right: x + 340, top: y, bottom: y };
  }


  /* MUST match PortraitCapture::SlugOfName() in src/portrait_capture.cpp, which
     is what named the file: lowercase, every run of non-alphanumerics becomes a
     single '-', no leading/trailing '-'. If these drift, a saved photo lands on
     no outfit at all. */
  function wdSlug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* wdPhotoSaved: photo mode wrote an image for an outfit. Pushed by C++ after a
     successful shot, so the card updates the moment you come out of the camera
     rather than on the next open. */
  window.wdPhotoSaved = function (payload) {
    const d = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!d || !d.slug || !d.image) return;
    /* The slug is "wd-<outfit slug>"; find the outfit it belongs to rather than
       trusting the name to round-trip through a filename. */
    const want = String(d.slug).replace(/^wd-/, '');
    const hit = soesNames().find((n) => wdSlug(n) === want);
    if (!hit) return;
    const m = ensureMeta(hit);
    /* Cache-bust: Ultralight keys images by URL, so replacing a photo under the
       same name would keep painting the old one. */
    m.image = d.image + '?v=' + Date.now();
    touch();
    toast('◉ Photo saved for ' + hit);
  };

  function outfitMenu(e, name) {
    const m = ensureMeta(name);
    const items = [
      {
        /* Put it on ME — the palette closes so the change is on screen. Same
           engine path as photo mode, minus the camera. */
        label: '👗 Wear this now', go: () => {
          toGame('wdWear', JSON.stringify({ name: name }));
          toast('Changing into “' + name + '”…');
        },
      },
      {
        /* The star is no longer decoration: it also sets SOES's OWN favourite
           flag, which is the list its quick-swap power reads. wdFav persists
           the mirror C++-side, so touch() would be a second, racing save. */
        label: (m.fav ? '★ Unfavourite' : '☆ Favourite'),
        go: () => {
          m.fav = !m.fav;
          toGame('wdFav', JSON.stringify({ name: name, on: m.fav }));
          render();
        },
      },
      {
        /* SOES keys an outfit by NAME alone, so a rename has to land there too
           — C++ re-points every pool, assignment, override and roll record in
           the same call. In place, because PrismaUI has no prompt dialog. */
        label: '✎ Rename…', go: () => { ui.renaming = name; render(); },
      },
      {
        /* Dress up and photograph it. The picture is of the CLOTHES, so unlike
           the follower portrait this hands you the camera instead of shooting a
           second later from wherever you were standing. */
        label: '◉ Photo this outfit', go: () => {
          toGame('wdPortrait', JSON.stringify({ name: name }));
          toast('Dressing… then E to shoot, Esc to cancel');
        },
      },
      /* Only when there IS a photo — an "adjust framing" that opens on nothing
         is worse than an absent row. Opens straight in edit mode, because
         reaching this from the menu is already a decision to re-frame. */
      m.image && cropKeyOf(m.image) ? {
        label: (cropFor(m.image) ? '⛶ Re-frame photo…' : '⛶ Adjust photo framing…'),
        go: () => { openArt(name, m.image, true); },
      } : null,
      {
        label: '◫ Pieces…', go: () => {
          ui.pieces = { name: name, items: [], loading: true };
          toGame('wdPieces', JSON.stringify({ name: name }));
          render();
        },
      },
      {
        label: '✎ Edit note', go: () => {
          /* notes are edited in place on the card — turn edit mode on and put
             the caret in this outfit's field */
          ui.editing = true;
          render();
          const f = els.pane.querySelector('[data-k="onote:' + cssEsc(name) + '"]');
          if (f) { f.focus(); f.select(); }
        },
      },
      '-',
      {
        /* One click, no chooser: the same clothes under a new name. What it
           shares with the original is deliberate — see carryMeta. */
        label: '⧉ Duplicate',
        title: 'Make a copy with the same pieces, named “' + uniqueOutfitName(name + ' copy')
          + '”. Categories and note come along; the photo does not — take a new one.',
        go: () => { requestPieces(name, 'dup', menuRect(e)); },
      },
      {
        /* The same outfit minus something — usually the helmet. Pin the result
           to Home in her location overrides and you have "helmet outdoors, bare
           head indoors" with no new machinery. */
        label: '◑ Make variant…',
        title: 'Pick which pieces to keep — headgear off in one click — and build it '
          + 'as a real outfit you can assign and pin to a location',
        go: () => { requestPieces(name, 'variant', menuRect(e)); },
      },
      '-',
      {
        /* Was: every category inline, one row each. Rober, 2026-08-03: "as soon
           as i get a lot of categories this is going to balloon". The chips on
           the CARD already show what it is in, so the menu only needs the verb. */
        label: '🗂 Categories…',
        title: 'File this outfit under categories — searchable, multi-select, and you '
          + 'can create one by typing its name',
        go: () => { openCategoryPicker(menuRect(e), name); },
      },
      '-',
    ];
    items.push({
      label: '🗑 Delete this outfit', danger: true, arms: 'delfit:' + name,
      go: () => {
        toGame('wdOutfitDel', JSON.stringify({ name: name }));
        state.outfitMeta = state.outfitMeta.filter((x) => x.name !== name);
        state.wardrobes.forEach((w) => { w.outfits = (w.outfits || []).filter((x) => x !== name); });
        touch();
        toast('Deleting “' + name + '”…');
      },
    });
    if (state.wardrobes.length) items.push('-');
    state.wardrobes.forEach((w) => {
      const on = (w.outfits || []).indexOf(name) !== -1;
      items.push({
        label: (on ? '✓ ' : ' ') + '◇ ' + w.name,
        go: () => toggleMember(w, name),
      });
    });
    showMenu(e, items);
  }

  /** Delete a wardrobe and unhook everyone wearing it. Outfits are untouched. */
  function deleteWardrobe(w) {
    const users = state.assignments.filter((a) => a.wardrobeId === w.id).length;
    state.assignments.forEach((a) => {
      if (a.wardrobeId === w.id) { a.wardrobeId = ''; if (a.mode === 'wardrobe') a.mode = 'off'; }
      a.locationOverrides = (a.locationOverrides || []).filter((o) => o.wardrobeId !== w.id);
    });
    state.wardrobes = state.wardrobes.filter((x) => x.id !== w.id);
    if (ui.builderId === w.id) { ui.builderId = null; restoreOpener(); }
    touch();
    toast('Deleted “' + w.name + '”' + (users ? ' — ' + users + ' now unassigned' : ''));
  }

  function wardrobeMenu(e, w) {
    showMenu(e, [
      { label: '✎ Open — rename, note, fill', go: () => openBuilder(w.id) },
      { label: '◑ Recolour', go: () => { w.hue = HUES[(HUES.indexOf(w.hue) + 1) % HUES.length]; touch(); } },
      '-',
      {
        label: '✕ Delete wardrobe', danger: true, arms: 'delw:' + w.id,
        go: () => deleteWardrobe(w),
      },
    ]);
  }

  function npcMenu(e, npc) {
    const a = ensureAssign(npc);
    const sid = subFocusId();
    showMenu(e, [
      { label: '✎ Assignment…', go: () => openSheet(npc) },
      { label: '✦ Dress now', go: () => dressNow(npc) },
      { label: '☰ Trade / inventory', go: () => openNpcInventory(npc) },
      sid ? { label: '◇ ' + (SUB_LABEL[sid] || sid) + ' outfits', go: () => focusInSub(npc, sid) } : null,
      '-',
      {
        label: '✕ Clear assignment', danger: true, arms: 'clr:' + keyOf(npc),
        go: () => {
          a.mode = 'off'; a.wardrobeId = ''; a.outfit = ''; a.locationOverrides = [];
          touch();
          toast('Cleared ' + npc.name + '’s assignment');
        },
      },
    ]);
  }

  /* ============================================================== add === */

  /* Create-then-name, never a prompt: the row appears immediately with a
   * default name and the caret already in it, so one flow covers both. */
  function addForSub() {
    if (ui.sub === 'wardrobes') {
      const w = {
        id: newId('w'), name: 'New wardrobe',
        hue: HUES[state.wardrobes.length % HUES.length], note: '', outfits: [],
      };
      state.wardrobes.push(w);
      ui.filter = ''; els.search.value = ''; resetPaging();
      save();
      openBuilder(w.id);
      setTimeout(() => {
        const f = els.pane.querySelector('[data-k="wname:' + cssEsc(w.id) + '"]');
        if (f) { f.focus(); f.select(); }
      }, 40);
    } else if (ui.sub === 'outfits') {
      const c = { id: newId('c'), name: 'New category', hue: HUES[state.categories.length % HUES.length] };
      state.categories.push(c);
      ui.editing = true;                 // the pills are only editable in edit mode
      touch();
      const f = els.pane.querySelector('[data-k="cat:' + cssEsc(c.id) + '"]');
      if (f) { f.focus(); f.select(); }
    }
  }

  /* ============================================================== host == */

  function init() {
    if (ui.inited) return;
    els.pane = $('wd-pane');
    if (!els.pane) return;
    els.nav = $('wd-nav');
    els.search = $('wd-search');
    els.clear = $('wd-search-clear');
    els.count = $('wd-count');
    els.edit = $('wd-edit');
    els.add = $('wd-add');
    els.banner = $('wd-banner');
    els.cats = $('wd-cats');
    els.list = $('wd-list');
    els.empty = $('wd-empty');
    els.builder = $('wd-builder');
    els.builderTitle = $('wd-builder-title');
    els.builderSub = $('wd-builder-sub');
    els.builderNote = $('wd-builder-note');
    els.builderDel = $('wd-builder-del');
    els.builderMode = $('wd-builder-mode');
    els.builderSwatch = $('wd-builder-swatch');
    els.members = $('wd-members');
    els.membersEmpty = $('wd-members-empty');
    els.memCount = $('wd-mem-count');
    els.catalogue = $('wd-catalogue');
    els.catSearch = $('wd-cat-search');
    els.sheet = $('wd-sheet');
    els.sheetName = $('wd-sheet-name');
    els.sheetSub = $('wd-sheet-sub');
    els.sheetFace = $('wd-sheet-face');
    els.sheetBody = $('wd-sheet-body');
    els.body = $('wd-body');
    els.pieces = $('wd-pieces');
    els.piecesTitle = $('wd-pieces-title');
    els.piecesSub = $('wd-pieces-sub');
    els.piecesBody = $('wd-pieces-body');
    els.selbar = $('wd-selbar');
    els.picker = $('wd-picker');
    els.pickerTitle = $('wd-picker-title');
    els.pickerSub = $('wd-picker-sub');
    els.pickerInput = $('wd-picker-input');
    els.pickerList = $('wd-picker-list');
    els.menu = $('wd-menu');

    els.search.addEventListener('input', () => {
      ui.filter = els.search.value.trim();
      resetPaging();
      render();
      els.list.scrollTop = 0;
    });
    els.clear.addEventListener('click', () => {
      els.search.value = ''; ui.filter = ''; resetPaging(); els.search.focus(); render();
    });
    els.edit.addEventListener('click', () => { ui.editing = !ui.editing; ui.armed = null; render(); });

    /* whole-tab scale — this pane's own, persisted in the wardrobe slice */
    els.editRow = $('wd-editrow');
    const uiDec = $('wd-ui-dec'), uiInc = $('wd-ui-inc'), uiRst = $('wd-ui-reset');
    if (uiDec) uiDec.addEventListener('click', () => nudgeUi(-UI_STEP));
    if (uiInc) uiInc.addEventListener('click', () => nudgeUi(+UI_STEP));
    if (uiRst) uiRst.addEventListener('click', () => nudgeUi(0));
    applyUiScale();

    /* TILE size, beside it — the art, not the text. Deliberately routed through
       hd-scale.js and the deck's `settings.tabScales` rather than added to the
       wardrobe slice: that slice is round-tripped whole by C++ and a payload
       that forgets a field resets it, which the crop map has already proved.
       The tab scale above stays where it is — it works and it is play-tested. */
    if (window.HDScale) HDScale.mount($('wd-img-row'), 'wardrobe', 'img');

    els.add.addEventListener('click', addForSub);
    els.catSearch.addEventListener('input', () => {
      ui.builderFilter = els.catSearch.value.trim();
      renderBuilder();
      els.catalogue.scrollTop = 0;          // a new filter starts at the top
    });
    $('wd-builder-close').addEventListener('click', closeBuilder);
    $('wd-sheet-close').addEventListener('click', closeSheet);
    $('wd-pieces-close').addEventListener('click', closePieces);
    $('wd-picker-close').addEventListener('click', closePicker);
    els.picker.addEventListener('mousedown', (e) => { if (e.target === els.picker) closePicker(); });
    els.pickerInput.addEventListener('input', () => {
      if (!ui.picker) return;
      ui.picker.q = els.pickerInput.value;
      ui.picker.idx = 0;
      renderPicker();          // list only — the field keeps focus and caret
    });
    els.pickerInput.addEventListener('keydown', (e) => {
      if (pickerKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
      e.stopPropagation();     // [ ] and friends belong to the field while it is open
    });
    els.pieces.addEventListener('mousedown', (e) => { if (e.target === els.pieces) closePieces(); });
    els.builder.addEventListener('mousedown', (e) => { if (e.target === els.builder) closeBuilder(); });
    els.sheet.addEventListener('mousedown', (e) => { if (e.target === els.sheet) closeSheet(); });

    document.addEventListener('mousedown', (e) => {
      if (!els.menu.classList.contains('hidden') && !els.menu.contains(e.target)) hideMenu();
      /* An open typeahead shuts on a click anywhere outside it. Capture phase,
         and by walking the DOM at event time rather than holding a node — the
         pane rebuilds itself constantly, so a remembered node is stale. */
      if (ui.combo && !inCombo(e.target)) comboClose(false);
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!ui.shown) return;

      /* FIRST, ahead of everything: the crop editor claims arrows, ± and
         Enter/Esc while it is up. Below this line "any printable key jumps to
         search" would eat '+' and '-', and the Escape cascade would close a
         dialog behind the overlay instead of the overlay. */
      if (artBox && artKey(e)) { e.preventDefault(); e.stopPropagation(); return; }

      if (e.key === 'Escape') {
        if (!els.menu.classList.contains('hidden')) { hideMenu(); e.stopPropagation(); return; }
        /* The open typeahead handles its own Esc while it holds focus; this is
           the fallback for when focus has drifted off it. Ahead of the sheet,
           so one Esc shuts the list and a second shuts the sheet. */
        if (ui.combo) { comboClose(true); e.stopPropagation(); return; }
        if (ui.armed) { ui.armed = null; render(); e.stopPropagation(); return; }
        if (ui.picker) { closePicker(); e.stopPropagation(); return; }
        if (ui.pieces) { closePieces(); e.stopPropagation(); return; }
        if (ui.sel.length) { selClear(); render(); e.stopPropagation(); return; }
        if (ui.builderId) { closeBuilder(); e.stopPropagation(); return; }
        if (ui.sheetKey) { closeSheet(); e.stopPropagation(); return; }
        if (ui.filter) { els.search.value = ''; ui.filter = ''; resetPaging(); render(); e.stopPropagation(); return; }
      }

      /* Keep Tab inside whichever dialog is up. */
      if (ui.builderId && trapTab(e, $('wd-builder-card'))) return;
      if (ui.sheetKey && trapTab(e, $('wd-sheet-card'))) return;

      const inField = document.activeElement && (
        document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');

      /* F2 is the HOST's to route (app.js -> WardrobePane.toggleEdit), exactly
       * like Finances. Handling it here as well would toggle twice and cancel
       * out. The standalone harness has no host, so it drives toggleEdit()
       * directly. */

      /* Ctrl+A over a selectable list selects everything on screen — the
       * natural partner to ctrl-click. */
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') &&
          (ui.sub === 'outfits' || ui.sub === 'wardrobes') && !inField) {
        ui.sel = selVisible();
        render(); e.preventDefault();
        return;
      }

      if (navKeys(e)) return;

      /* [ and ] cycle sub-tabs, matching Finances. Never while typing. */
      if ((e.key === '[' || e.key === ']') && !inField && !ui.builderId && !ui.sheetKey) {
        const i = SUBS.indexOf(ui.sub);
        ui.sub = SUBS[(i + (e.key === ']' ? 1 : SUBS.length - 1)) % SUBS.length];
        ui.filter = ''; els.search.value = ''; resetPaging();
        render(); e.preventDefault();
        return;
      }

      /* Any printable key jumps to the search box — the fastest way to find
       * someone in a long roster without reaching for the mouse. */
      if (!inField && !ui.builderId && !ui.sheetKey &&
          e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /\S/.test(e.key)) {
        els.search.focus();
      }
    }, true);

    ui.inited = true;
    Object.keys(PLUGINS).forEach((id) => {
      try { PLUGINS[id].init(); } catch (e) { console.log('[wardrobe] sub init', id, e); }
    });
    if (DEV) devBoot();
    render();
    if (SELFTEST) setTimeout(selftest, 60);
  }

  function toggleEdit() {
    ui.editing = !ui.editing;
    ui.armed = null;
    render();
  }

  function onShow() {
    ui.shown = true;
    if (!ui.inited) init();
    els.pane.classList.remove('hidden');
    toGame('wdGet', '');
    const p = plugin();
    if (p) { try { p.onEnter(); } catch (e) { console.log('[wardrobe] sub enter', ui.sub, e); } }
    render();
    setTimeout(() => { if (els.search) els.search.focus(); }, 30);
  }
  function onHide() {
    ui.shown = false;
    hideMenu();
    /* The crop overlay lives on document.body, so hiding the pane does NOT
       hide it — left behind it would sit over the deck swallowing every click,
       and its document-level drag listeners would outlive it. */
    closeArt();
    if (els.pane) els.pane.classList.add('hidden');
  }

  /* C++ -> view */
  function receive(fn, payload) {
    try {
      if (fn === 'wdOpen') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        state.categories = j.categories || [];
        state.outfitMeta = j.outfitMeta || [];
        state.wardrobes = (j.wardrobes || []).map((w) => (w.outfits ? w : Object.assign({ outfits: [] }, w)));
        state.assignments = j.assignments || [];
        state.settings = Object.assign(
          { enabled: true, notify: true, uiScale: 1, soesQuickslot: false, soesClimate: false },
          j.settings || {});
        /* The crop map rides IN the slice as well as on its own `wdCrops` rail:
           wdOpen is the only push that is guaranteed to precede the first draw,
           and a tile painted before its crop landed would visibly jump a frame
           later. Absent key = keep what we have, never wipe. */
        if (j.imageCrops && typeof j.imageCrops === 'object') setCrops(j.imageCrops);
        applyUiScale();     // the saved zoom, before anything is measured
        state.soes = Object.assign({ available: false, outfits: [], tracked: [] }, j.soes || {});
        state.npcs = j.npcs || [];
        state.inventory = (j.inventory || []).slice()
          .sort((a, b) => (slotRank(a.slot) - slotRank(b.slot)) || a.name.localeCompare(b.name));
        if (typeof j.now === 'number') state.now = j.now;   // Calendar days passed
        ui.loading = false;
        render();
      } else if (fn === 'wdState') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        if (j.soes) state.soes = Object.assign(state.soes, j.soes);
        if (j.npcs) state.npcs = j.npcs;
        if (j.inventory) {
          state.inventory = j.inventory.slice()
            .sort((a, b) => (slotRank(a.slot) - slotRank(b.slot)) || a.name.localeCompare(b.name));
        }
        if (Array.isArray(j.rolls)) {
          /* C++ tells us what it rolled so the row reads true without a full reopen */
          j.rolls.forEach((r) => {
            const a = state.assignments.find((x) => x.formId === r.formId && x.plugin === r.plugin);
            if (a) { a.lastOutfit = r.outfit; a.lastRollDay = r.day; }
          });
        }
        render();
      } else if (fn === 'wdCrops') {
        /* The authoritative map after a save — it carries a prune the view
           cannot compute (it only ever knows the images its own outfits point
           at, never the whole icons/custom/ folder). */
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        setCrops(j && j.crops && typeof j.crops === 'object' ? j.crops : j);
        render();
      } else if (fn === 'wdOutfitModList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        state.outfitMods = j.mods || [];
        render();
      } else if (fn === 'wdOutfitList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        state.modOutfits = j;
        render();
      } else if (fn === 'wdArmorModList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        state.armorMods = j.mods || [];
        render();
      } else if (fn === 'wdArmorList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        state.modArmors = j;
        render();
      } else if (fn === 'wdPieceList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        /* FIRST REFUSAL, exactly like omni takes it on hdQuests: a variant or a
           duplicate rides the SAME wdPieces request the Pieces… sheet uses, so
           whichever asked most recently consumes this reply and the other sheet
           is never clobbered. Matched on NAME too, so a stale reply for a
           different outfit falls through to the sheet where it belongs. */
        const vr = ui.variantReq;
        if (vr && vr.name === (j.name || '')) {
          ui.variantReq = null;
          if (!j.ok) { toast(j.msg || 'Could not read that outfit'); return; }
          const items = j.items || [];
          if (!items.length) { toast('“' + vr.name + '” is empty — nothing to copy'); return; }
          if (vr.mode === 'dup') {
            buildFromPieces(uniqueOutfitName(vr.name + ' copy'), items, vr.name, 'Duplicating');
          } else {
            openVariantPicker(vr, items);
          }
          return;
        }
        ui.pieces = j.ok ? j : { name: (j.name || ''), items: [], error: j.msg || 'Could not read it' };
        render();
      } else if (fn === 'wdWornList') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        if (!j.ok) { toast(j.msg || 'Could not read that'); return; }
        const items = j.items || [];
        if (!items.length) { toast((j.who || 'They') + ' are wearing nothing'); return; }
        /* ADD to the basket rather than replacing it, so two looks can be
         * combined — and so a mis-tap never wipes what you had. */
        const b = buildState();
        let added = 0;
        items.forEach((i) => {
          const k = invKey(i);
          if (!b.picked[k]) { b.picked[k] = i; added++; }
        });
        if (!b.name) b.name = (j.who === 'You' ? 'My outfit' : j.who + '\u2019s outfit');
        ui.sub = 'inventory';
        render();
        toast(added ? 'Added ' + added + ' piece' + (added === 1 ? '' : 's') + ' from ' + j.who
          : 'Already had everything ' + j.who + ' is wearing');
      } else if (fn === 'wdResult') {
        const j = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
        if (j.msg) toast(j.msg);
        /* The outfit dock is drawn OVER the deck, so a toast can land behind
           it. Put the same verdict on the surface you are actually looking at. */
        if (window.HDOutfit && HDOutfit.isOpen() && HDOutfit.report) HDOutfit.report(j);
      } else if (fn === 'wdSaved') {
        /* nothing to do — the view is already the source of truth for its slice */
      } else if (fn === 'wdShow') {
        onShow();
      }
    } catch (e) {
      console.log('[wardrobe] receive error', fn, e);
      glog('wardrobe receive error ' + fn + ' ' + e);
    }
  }

  function wantsPause() { return true; }

  /* PrismaUI installs each C++->JS listener as a global of that name. */
  window.wdOpen = (p) => receive('wdOpen', p);
  window.wdState = (p) => receive('wdState', p);
  window.wdResult = (p) => receive('wdResult', p);
  window.wdSaved = (p) => receive('wdSaved', p);
  window.wdShow = () => receive('wdShow', '');
  window.wdWornList = (p) => receive('wdWornList', p);
  /* The importer's two lists. Request names are wdOutfitMods / wdOutfitsFor;
     these are their REPLIES and must not share a name with them — a name used
     for both directions silently unplugs the control (wdArmorMods, 2026-08-02). */
  window.wdOutfitModList = (p) => receive('wdOutfitModList', p);
  window.wdOutfitList = (p) => receive('wdOutfitList', p);
  /* The crop map coming BACK. `wdCropSave` is the request name and the two must
     never be the same string — PrismaUI installs each listener as a global, so a
     shared name silently unplugs the control (five times and counting). */
  window.wdCrops = (p) => receive('wdCrops', p);
  /* The reply name MUST NOT be `wdArmorMods` — that is the C++ request bridge
     PrismaUI installs as a global, and assigning over it made toGame() call
     THIS function with the empty request payload instead of the plugin. The
     "All armour" mod list never arrived. See src/main.cpp OnJsWdArmorMods. */
  window.wdArmorModList = (p) => receive('wdArmorModList', p);
  window.wdArmorList = (p) => receive('wdArmorList', p);
  window.wdPieceList = (p) => receive('wdPieceList', p);

  /* Real armour renders (Mesh Rendering Framework via C++ ItemIcons): a map of
   * "0XABCD|plugin.esp" -> "icons/items/<file>.png". Pushed at tab open with
   * whatever exists, and again each time a render batch lands — rows upgrade
   * from the "+" glyph to the actual item as pictures arrive. Parse-time
   * global for the same reason as fdPortraits below. */
  window.wdItemIcons = function (p) {
    let changed = false;
    try {
      const j = typeof p === 'string' ? JSON.parse(p) : p;
      const next = (j && j.icons) || {};
      const prev = state.itemIcons || {};
      const nk = Object.keys(next);
      changed = nk.length !== Object.keys(prev).length || nk.some((k) => prev[k] !== next[k]);
      state.itemIcons = next;
    } catch (e) { state.itemIcons = state.itemIcons || {}; }
    try { render(); } catch (e) { /* pushed before first init — the open render shows them */ }
    /* The Followers quick card draws worn gear from this same index (C++ now
     * pushes it on every fdEquipped reply, not only at Wardrobe-tab open).
     * Tell that pane — but only when the index actually CHANGED, so the
     * every-open push can never repaint-loop the card. */
    if (changed) {
      try { document.dispatchEvent(new Event('hd-item-icons')); } catch (e) { /* no DOM yet */ }
    }
  };

  /* ---- the portraits listing, borrowed ----
   * `fdPortraits` is the Followers pane's feed: C++ pushes it at palette open
   * and again with every fdRefresh, so nobody asks for it. It is installed as a
   * plain global, and TWO panes assigning window.fdPortraits would gag whichever
   * one landed first — so CHAIN it, exactly like hdClosed below and like
   * wardrobe-nff.js's chainFollowerFeeds().
   *
   * Chained at PARSE time, not in init(): this pane is only init()ed the first
   * time the Wardrobe tab is opened, which is long after the open-time push. A
   * wrapper installed then would miss it and the faces would stay grey until
   * something else triggered an fdRefresh.
   *
   * We keep our own copy rather than reading FolPane's: the standalone harness
   * has no Followers pane at all, and this is the only feed that gives it faces. */
  const prevPortraits = window.fdPortraits;
  window.fdPortraits = function (list) {
    try {
      const raw = typeof list === 'string' ? JSON.parse(list) : list;
      const arr = Array.isArray(raw) ? raw
        : (raw && Array.isArray(raw.portraits) ? raw.portraits : []);
      const map = {};
      arr.forEach(function (e) {
        if (!e || !e.slug) return;
        const slug = String(e.slug).toLowerCase();
        const ext = String(e.ext || 'png').toLowerCase().replace(/^\./, '');
        /* `file` is authoritative and must not be rebuilt from slug + ext — a
           re-capture of a face the renderer already holds open lands as
           `<slug>~<n>.png`. Anything with a path separator is REFUSED rather
           than sanitised: it names a sibling in portraits/, and a value that
           walks out of there is a bug or an attack, never a portrait. */
        const rawFile = typeof e.file === 'string' ? e.file.trim() : '';
        const file = (rawFile && !/[\\/]/.test(rawFile) && rawFile !== '.' && rawFile !== '..')
          ? rawFile : (slug + '.' + ext);
        // Plain number, NOT `>>> 0`: the stamp can exceed 32 bits and a wrapped
        // value would collide across different files.
        const mt = typeof e.mtime === 'number' ? e.mtime : parseInt(e.mtime, 10);
        map[slug] = { file: file, ext: ext, mtime: (isFinite(mt) && mt > 0) ? mt : 0 };
      });
      state.portraits = map;
      sheetFaceSrc = null;               // a re-capture must be allowed to repaint
      if (ui.shown && ui.inited) render();
    } catch (e) { /* the Followers pane logs its own parse failures */ }
    if (typeof prevPortraits === 'function') return prevPortraits.apply(this, arguments);
    return undefined;
  };

  /* Chain the deck's close hook so Esc-out cleans us up too. */
  const prevClosed = window.hdClosed;
  window.hdClosed = function () {
    onHide();
    if (typeof prevClosed === 'function') { try { prevClosed.apply(this, arguments); } catch (e) { /* ignore */ } }
  };

  /* ============================================================== dev === */

  function devBoot() {
    ui.loading = false;
    ui.catFilter = '';
    ui.limit = PAGE;
    state.now = 120.5;                 // in-game days passed, for the next-change line
    const outfits = [
      'Sfancy Blue', 'Cosplay Gala', 'Hellene Gown', 'Riverwood Homespun', 'Nightingale Black',
      'Wedding White', 'Solitude Court', 'Travelling Leathers', 'Bath Robe', 'Snow Cloak',
    ];
    state.soes = {
      available: true,
      outfits: outfits.map((n, i) => ({ name: n, items: 3 + (i % 4), fav: i === 0 })),
      tracked: [],
    };
    state.categories = [
      { id: 'c1', name: 'Evening', hue: 38 },
      { id: 'c2', name: 'Practical', hue: 145 },
      { id: 'c3', name: 'Court', hue: 260 },
    ];
    state.outfitMeta = [
      /* Two photographed outfits, one cropped and one not — the harness needs
       * both to tell "the crop applied" from "everything got a transform". The
       * URLs point at nothing: a background-image that 404s paints the well and
       * is silent, which is exactly the shape of a photo whose file has gone. */
      { name: 'Sfancy Blue', image: 'icons/custom/wd-sfancy-blue.png?v=1730000001', categoryIds: ['c1'], note: 'her favourite', fav: true },
      { name: 'Cosplay Gala', image: 'icons/custom/wd-cosplay-gala.png', categoryIds: ['c1', 'c3'], note: '', fav: false },
      { name: 'Solitude Court', image: '', categoryIds: ['c3'], note: '', fav: false },
      { name: 'Travelling Leathers', image: '', categoryIds: ['c2'], note: '', fav: false },
    ];
    state.imageCrops = { 'wd-sfancy-blue.png': { z: 1.5, x: 0.1, y: -0.2 } };
    state.wardrobes = [
      { id: 'w1', name: 'Evening Wear', hue: 38, note: '', outfits: ['Sfancy Blue', 'Cosplay Gala', 'Hellene Gown'] },
      { id: 'w2', name: 'Homewear', hue: 145, note: '', outfits: ['Riverwood Homespun', 'Bath Robe'] },
      { id: 'w3', name: 'On the road', hue: 200, note: '', outfits: ['Travelling Leathers', 'Snow Cloak', 'Ghost Outfit'] },
    ];
    state.npcs = [
      { formId: '0x0001A6A1', plugin: 'Skyrim.esm', name: 'Camilla Valerius', portrait: '', tracked: true, wearing: 'Sfancy Blue', conflict: false },
      { formId: '0x000A2C8E', plugin: 'Skyrim.esm', name: 'Lydia', portrait: '', tracked: true, wearing: 'Travelling Leathers', conflict: true },
      { formId: '0x0003A1B2', plugin: 'Skyrim.esm', name: 'Ysolda', portrait: '', tracked: false, wearing: '', conflict: false },
      { formId: '0x00000874', plugin: 'CustomFollower.esp', name: 'Aelia Rivena', portrait: '', tracked: false, wearing: '', conflict: false },
    ];
    state.inventory = [
      { formId: '0x16CF9', plugin: 'RelicsofHyruleDragonborn.esp', name: 'Yeti Tunic', slot: 'Body', armorRating: 29, enchanted: false },
      { formId: '0x16D2F', plugin: 'RelicsofHyruleDragonborn.esp', name: 'Yeti Cap', slot: 'Hair', armorRating: 13, enchanted: false },
      { formId: '0x261C1', plugin: 'Skyrim.esm', name: 'Gloves', slot: 'Hands', armorRating: 0, enchanted: false },
      { formId: '0x3B97C', plugin: 'Skyrim.esm', name: 'Silver ring', slot: 'Unknown', armorRating: 0, enchanted: false },
      { formId: '0x3590AA', plugin: 'Immersive Jewelry.esp', name: 'Garnet Cushion Copper Link Tiara', slot: 'Circlet', armorRating: 0, enchanted: true },
      { formId: '0x1B3A4', plugin: 'Skyrim.esm', name: 'Fine Boots', slot: 'Feet', armorRating: 4, enchanted: false },
    ];
    state.assignments = [
      {
        formId: '0x0001A6A1', plugin: 'Skyrim.esm', name: 'Camilla Valerius',
        mode: 'wardrobe', wardrobeId: 'w1', outfit: '', cadenceHours: 12,
        locationOverrides: [{ loc: 5600, wardrobeId: 'w2' }], lastRollDay: 120.25, lastOutfit: 'Sfancy Blue',
      },
      {
        formId: '0x000A2C8E', plugin: 'Skyrim.esm', name: 'Lydia',
        mode: 'outfit', wardrobeId: '', outfit: 'Travelling Leathers', cadenceHours: 0,
        locationOverrides: [], lastRollDay: 0, lastOutfit: '',
      },
    ];
  }

  /* ---------------------------------------------------------- selftest -- */

  function selftest() {
    const results = [];
    const T = (name, fn) => {
      let pass = false, err = '';
      try { pass = !!fn(); } catch (e) { err = String(e); }
      results.push({ name: name, pass: pass, err: err });
    };
    const q = (sel) => document.querySelectorAll(sel);
    const setSub = (s) => { ui.sub = s; ui.filter = ''; els.search.value = ''; render(); };

    /* --- a just-made outfit, before SOES confirms it (2026-08-02) --- */
    /* SOES answers a refresh through Papyrus on its own schedule, ~90 s on this
       save. Building "Necromant" wrote it, logged it, and then showed the player
       nothing at all until the tab was reopened later than that — which reads
       exactly like the build failed. C++ now merges the meta name in as
       `pending`; these assert the view treats that honestly. */
    T('a pending outfit is still found in the list', () => {
      const was = state.soes;
      state.soes = { available: true, pending: false, tracked: [],
        outfits: [{ name: 'Necromant', items: 0, pending: true }] };
      const found = !!soesOutfit('Necromant');
      state.soes = was;
      return found;
    });
    T('a pending outfit is NOT flagged missing', () => {
      /* isMissing means "SOES has never heard of this". Putting that warning on
         the thing the player just successfully made is the worst possible
         moment for it. */
      const was = state.soes;
      state.soes = { available: true, pending: false, tracked: [],
        outfits: [{ name: 'Necromant', items: 0, pending: true }] };
      const missing = isMissing('Necromant');
      state.soes = was;
      return missing === false;
    });
    T('a real outfit SOES does not know is still flagged missing', () => {
      const was = state.soes;
      state.soes = { available: true, pending: false, tracked: [], outfits: [] };
      const missing = isMissing('Ghost Fit');
      state.soes = was;
      return missing === true;
    });

    /* --- structure --- */
    T('pane exists', () => !!$('wd-pane'));
    /* The four SOES sub-tabs, plus however many another file has registered
       (wardrobe-nff.js adds one). Asserting an exact total made a legitimate
       plug-in look like a regression, so assert OUR four are all there and that
       every tab — ours or a plug-in's — carries a count. */
    T('the four SOES sub-tabs render', () => q('#wd-nav .wd-subtab').length >= 4 &&
      ['Outfits', 'Wardrobes', 'People', 'Inventory'].every((label) =>
        Array.prototype.some.call(q('#wd-nav .wd-subtab'),
          (b) => b.firstChild && b.firstChild.textContent === label)));
    /* --- the People redesign (2026-08-03) --- */
    T('a HIDDEN plug-in never becomes a tab', () => {
      /* wardrobe-nff registers hidden:true since its surface folded into
         People — a fifth tab reappearing means the flag was dropped.
         nfftab=1 is the NFF harness deliberately re-showing it to drive its
         tab-based checks, so the assertion inverts there. */
      const shown = Array.prototype.some.call(q('#wd-nav .wd-subtab'),
        (b) => b.firstChild && b.firstChild.textContent === 'NFF');
      return location.search.indexOf('nfftab=1') !== -1 ? shown : !shown;
    });
    T('one person appears ONCE even when the feed lists her twice', () => {
      const was = state.npcs;
      state.npcs = was.concat([Object.assign({}, was[0],
        { formId: String(was[0].formId).toUpperCase() })]);   // same actor, different spelling
      setSub('npcs');
      const name = was[0].name;
      const n = Array.prototype.filter.call(q('#wd-list .wd-npc'),
        (r) => r.textContent.indexOf(name) !== -1).length;
      state.npcs = was;
      setSub('npcs');
      return n === 1;
    });
    T('every People row offers her inventory and the inject chevron', () => {
      setSub('npcs');
      const rows = q('#wd-list .wd-npc');
      return rows.length > 0 && Array.prototype.every.call(rows,
        (r) => r.querySelector('.wd-invpair') && r.querySelector('.wd-dress.ghost.chev'));
    });
    T('the inject chevron opens a searchable picker', () => {
      /* The picker routes through the NFF module's copyOutfit; this harness
         does not load wardrobe-nff.js, so stand in a minimal hidden plug-in —
         which doubles as coverage for the hidden-plug-in registration path. */
      const hadNff = !!PLUGINS.nff;
      if (!hadNff) {
        PLUGINS.nff = { id: 'nff', hidden: true, init: () => {},
          onEnter: () => {}, count: () => 0, render: () => 0, setFilter: () => {},
          sets: [{ t: 0, name: 'Adventure', hint: '' }],
          copyOutfit: () => true, infoFor: () => null, refreshData: () => {} };
      }
      setSub('npcs');
      const chev = q('#wd-list .wd-npc .wd-dress.ghost.chev')[0];
      let ok = false;
      if (chev) {
        chev.click();
        const menu = document.getElementById('wd-inject-menu');
        ok = !!(menu && menu.querySelector('.fd-ctx-filter'));
        if (menu) menu.remove();
      }
      if (!hadNff) delete PLUGINS.nff;
      return ok;
    });
    T('the sheet leads with Managed by, and Off needs no sub-choice', () => {
      setSub('npcs');
      const row = q('#wd-list .wd-npc')[0];
      row.click();
      const ks = Array.prototype.map.call(q('#wd-sheet .wd-field-k'), (k) => k.textContent);
      const ok = ks[0] === 'Managed by';
      closeSheet();
      return ok;
    });

    T('every button on the People surface explains itself on hover', () => {
      /* Rober's standing rule (2026-08-03): hover says what a button does,
         across all buttons. Buttons whose visible label IS the full meaning
         (sub-tabs carry titles anyway) still need one; anything untitled on
         this surface is a regression. */
      setSub('npcs');
      const bare = Array.prototype.filter.call(q('#wd-list button, #wd-nav .wd-subtab'),
        (b) => !(b.getAttribute('title') || '').trim() && b.offsetParent);
      return bare.length === 0
        || ('untitled: ' + bare.slice(0, 4).map((b) => (b.textContent || '?').trim().slice(0, 18)).join(' | '));
    });

    /* ---- the DENSE surfaces, 2026-08-03 -------------------------------
       The People card got the big-text/hover-text pass first; the Outfits
       grid, the Wardrobes cards and the whole Inventory flow did not. These
       hold that line. Every one of them measures the rendered thing rather
       than asserting a constant, so they fail when a stylesheet changes
       underneath them - which is the only way this kind of rule stays true. */

    T('every button on the Outfits, Wardrobes and Inventory surfaces explains itself', () => {
      const bad = [];
      ['outfits', 'wardrobes', 'inventory'].forEach((sub) => {
        setSub(sub); render();
        Array.prototype.forEach.call(q('#wd-list button'), (b) => {
          if (!b.offsetParent) return;
          if (!(b.getAttribute('title') || '').trim())
            bad.push(sub + ':' + ((b.textContent || '?').trim().slice(0, 16) || b.className));
        });
      });
      setSub('outfits');
      return bad.length === 0 || ('untitled: ' + bad.slice(0, 5).join(' | '));
    });

    T('the armour-source and slot filters both say what they filter TO', () => {
      setSub('inventory'); ui.invSource = 'carried'; render();
      const pills = Array.prototype.filter.call(q('#wd-list .wd-cat-pill'), (b) => b.offsetParent);
      if (pills.length < 3) return 'only ' + pills.length + ' pills';
      const vague = pills.filter((b) => (b.title || '').length < 12);
      return vague.length === 0
        || 'thin titles: ' + vague.map((b) => b.textContent.trim()).join(',');
    });

    T('a truncated inventory row still has its full name somewhere', () => {
      /* Both the name and the detail chip ellipsize on a narrow panel, so the
         ROW's hover text has to carry the whole truth - otherwise a long
         armour name is simply unreadable. */
      setSub('inventory'); ui.invSource = 'carried'; render();
      const row = q('#wd-list .wd-invrow .wd-npc')[0];
      if (!row) return 'no inventory row';
      const nm = row.querySelector('.wd-npc-name').textContent.trim();
      return (row.title.indexOf(nm) === 0) || 'row title is: ' + row.title.slice(0, 40);
    });

    T('nothing on these surfaces renders text under 12px', () => {
      /* "No small text" (Rober, 2026-08-03). 12 is the floor for a secondary
         numeral riding inside a bigger control; body text is 13+. */
      const bad = [];
      ['outfits', 'wardrobes', 'inventory'].forEach((sub) => {
        setSub(sub); render();
        Array.prototype.forEach.call(q('#wd-list *'), (n) => {
          if (!n.offsetParent) return;
          if (!n.firstChild || n.firstChild.nodeType !== 3) return;
          if (!(n.textContent || '').trim()) return;
          const fs = parseFloat(getComputedStyle(n).fontSize);
          if (fs && fs < 12) bad.push(sub + ':' + n.className + '@' + fs);
        });
      });
      setSub('outfits');
      return bad.length === 0 || bad.slice(0, 5).join(' | ');
    });

    T('a row skeleton is the height of the row that replaces it', () => {
      /* The list must not JUMP when the data lands. Measured against BOTH
         kinds of row this skeleton stands in for; it was 59px against an 83px
         row until 2026-08-03, which shifted five rows' worth on every load. */
      const heights = [];
      ['npcs', 'inventory'].forEach((sub) => {
        setSub(sub); ui.loading = false; render();
        const real = q('#wd-list .wd-npc')[0];
        heights.push(real ? real.getBoundingClientRect().height : 0);
      });
      setSub('npcs'); ui.loading = true; render();
      const sk = q('#wd-list .wd-skel.row')[0].getBoundingClientRect().height;
      ui.loading = false; setSub('outfits'); render();
      const worst = Math.max.apply(null, heights.map((hh) => Math.abs(hh - sk)));
      return worst <= 6 || 'skeleton ' + Math.round(sk) + 'px vs rows '
        + heights.map((hh) => Math.round(hh)).join('/');
    });

    T('the pieces drawer uses the SHORT skeleton, not the list one', () => {
      /* Its real rows are .wd-pick lines, about 30px shorter than a list row -
         one skeleton size cannot honestly stand in for both. */
      ui.pieces = { name: 'X', loading: false, items: [
        { name: 'Steel Cuirass', slot: 'Body', plugin: 'Skyrim.esm', missing: false }] };
      render();
      const real = q('#wd-pieces-body .wd-pick')[0].getBoundingClientRect().height;
      ui.pieces = { name: 'X', loading: true, items: [] };
      render();
      const sk = q('#wd-pieces-body .wd-skel.line')[0];
      const skh = sk ? sk.getBoundingClientRect().height : 0;
      ui.pieces = null; render();
      return (sk && Math.abs(real - skh) <= 6)
        || 'pieces skeleton ' + Math.round(skh) + 'px vs row ' + Math.round(real) + 'px';
    });

    T('clicking an inventory icon opens a lightbox, and does NOT toggle the pick', () => {
      setSub('inventory');
      state.itemIcons['0x1|Test.esp'] = 'icons/items/test.png';
      const was = state.inventory;
      state.inventory = [{ formId: '0x1', plugin: 'Test.esp', name: 'Lightbox Helm', slot: 'Head' }];
      render();
      const face = q('#wd-list .wd-npc-face.haslb')[0];
      let ok = false;
      if (face) {
        const pickedBefore = Object.keys(buildState().picked).length;
        face.click();
        const lb = document.getElementById('wd-item-lightbox');
        ok = !!lb && Object.keys(buildState().picked).length === pickedBefore
          && /Lightbox Helm/.test(lb.textContent);
        if (lb) lb.remove();
      }
      state.inventory = was; delete state.itemIcons['0x1|Test.esp']; render();
      return ok || 'no lightbox, or the click also picked the item';
    });

    T('every sub-tab shows a count', () =>
      q('#wd-nav .wd-subtab-n').length === q('#wd-nav .wd-subtab').length);

    /* --- outfits --- */
    setSub('outfits');
    T('outfits grid uses grid layout', () => els.list.classList.contains('grid'));
    T('all 10 dev outfits render', () => q('#wd-list .wd-card').length === 10);
    T('favourite sorts first', () => {
      const first = document.querySelector('#wd-list .wd-card .wd-card-name');
      return first && first.textContent.indexOf('Sfancy Blue') === 0;
    });
    T('item-count badge renders', () => q('#wd-list .wd-badge').length === 10);
    T('category chip renders on a tagged outfit', () => q('#wd-list .wd-chip').length > 0);
    T('count chip matches rendered cards', () => els.count.textContent === '10');

    /* --- search --- */
    els.search.value = 'gala'; ui.filter = 'gala'; render();
    T('search narrows outfits', () => q('#wd-list .wd-card').length === 1);
    T('search highlights the hit', () => {
      const m = document.querySelector('#wd-list .wd-card-name mark');
      return m && m.textContent.toLowerCase() === 'gala';
    });
    T('clear button appears while filtering', () => !els.clear.classList.contains('hidden'));
    els.search.value = 'Evening'; ui.filter = 'Evening'; render();
    T('search matches by CATEGORY name', () => q('#wd-list .wd-card').length === 2);
    els.search.value = 'favourite'; ui.filter = 'favourite'; render();
    T('search matches by NOTE', () => q('#wd-list .wd-card').length === 1);
    els.search.value = 'zzzz'; ui.filter = 'zzzz'; render();
    T('no-match shows the empty state', () => !els.empty.classList.contains('hidden'));
    T('empty state names the query', () => els.empty.textContent.indexOf('zzzz') !== -1);
    els.search.value = ''; ui.filter = ''; render();

    /* --- wardrobes --- */
    setSub('wardrobes');
    T('three dev wardrobes render', () => q('#wd-list .wd-card').length === 3);
    T('wearer chip shows on a used wardrobe', () => els.list.textContent.indexOf('1 wearer') !== -1);
    T('missing member is flagged on the card', () => els.list.textContent.indexOf('1 missing') !== -1);
    T('thumbnail strip renders for members', () => q('#wd-list .wd-strip').length === 3);
    els.search.value = 'snow'; ui.filter = 'snow'; render();
    T('wardrobe search matches by MEMBER outfit', () => q('#wd-list .wd-card').length === 1);
    els.search.value = ''; ui.filter = ''; render();

    /* --- builder --- */
    openBuilder('w1');
    T('builder opens', () => !els.builder.classList.contains('hidden'));
    T('builder lists the 3 members', () => q('#wd-members .wd-pick').length === 3);
    T('builder catalogue lists all outfits', () => q('#wd-catalogue .wd-pick').length === 10);
    T('member count chip is right', () => els.memCount.textContent === '3');
    T('members already in the pool are marked', () => q('#wd-catalogue .wd-pick.in').length === 3);
    const before = wardrobeById('w1').outfits.length;
    toggleMember(wardrobeById('w1'), 'Bath Robe');
    T('clicking a catalogue outfit adds it', () => wardrobeById('w1').outfits.length === before + 1);
    toggleMember(wardrobeById('w1'), 'Bath Robe');
    T('clicking it again removes it', () => wardrobeById('w1').outfits.length === before);
    ui.builderFilter = 'gown'; renderBuilder();
    T('catalogue filter narrows', () => q('#wd-catalogue .wd-pick').length === 1);
    ui.builderFilter = ''; renderBuilder();
    openBuilder('w3');
    T('missing member renders in the builder', () => els.members.textContent.indexOf('missing in SOES') !== -1);
    closeBuilder();
    T('builder closes', () => els.builder.classList.contains('hidden'));

    /* --- npcs --- */
    setSub('npcs');
    T('npc rows render as a list, not a grid', () => !els.list.classList.contains('grid'));
    T('four dev npcs render', () => q('#wd-list .wd-npc').length === 4);
    T('wardrobe assignment shows its wardrobe', () => els.list.textContent.indexOf('◇ Evening Wear') !== -1);
    T('cadence is shown on the row', () => els.list.textContent.indexOf('every 12h') !== -1);
    T('unmanaged npc says so', () => els.list.textContent.indexOf('not managed') !== -1);
    T('tracked badge renders', () => els.list.textContent.indexOf('tracked') !== -1);
    T('tailor clash is surfaced', () => els.list.textContent.indexOf('Tailor clash') !== -1);
    T('override count is shown', () => els.list.textContent.indexOf('1 override') !== -1);
    T('Dress is disabled for an unmanaged npc', () => {
      const rows = q('#wd-list .wd-npc');
      const ysolda = Array.prototype.find.call(rows, (r) => r.textContent.indexOf('Ysolda') !== -1);
      return ysolda && ysolda.querySelector('.wd-dress:not(.ghost)').disabled;
    });
    els.search.value = 'evening'; ui.filter = 'evening'; render();
    T('npc search matches by WARDROBE name', () => q('#wd-list .wd-npc').length === 1);
    els.search.value = ''; ui.filter = ''; render();

    /* --- sheet --- */
    openSheet(state.npcs[0]);
    T('sheet opens', () => !els.sheet.classList.contains('hidden'));
    T('sheet names the npc', () => els.sheetName.textContent === 'Camilla Valerius');
    T('mode segmented control renders 3 options', () => q('#wd-sheet-body .wd-seg button').length >= 3);
    T('cadence slider renders for a wardrobe assignment', () => !!document.querySelector('#wd-sheet-body input[type=range]'));
    T('cadence slider sits on the right stop', () => {
      const r = document.querySelector('#wd-sheet-body input[type=range]');
      return r && CADENCE[Number(r.value)] === 12;
    });
    T('location override row renders', () => q('#wd-sheet-body .wd-loc-row').length === 1);
    /* These two used to read a native <select>'s .value / .options. Same two
       facts, asked of the typeahead that replaced it: the field SHOWS the
       stored place while shut, and opening it offers every location type. */
    T('override defaults to Player home', () => {
      const f = document.querySelector('#wd-sheet-body .wd-loc-row .wd-combo');
      return f && f.textContent.indexOf('Player home') !== -1;
    });
    T('every SOES location type is offered', () => {
      const btn = document.querySelector('#wd-sheet-body .wd-loc-row .wd-combo-btn');
      btn.click();
      const n = q('#wd-sheet-body .wd-loc-row .wd-combo.open .wd-combo-list .wd-pick').length;
      comboClose(false);
      return n === LOCATIONS.length;
    });
    closeSheet();
    T('sheet closes', () => els.sheet.classList.contains('hidden'));

    /* a missing outfit must still be selectable, flagged, never silently dropped */
    const ly = state.npcs[1];
    ensureAssign(ly).outfit = 'Ghost Outfit';
    openSheet(ly);
    T('missing assigned outfit is kept and flagged', () => {
      const s = document.querySelector('#wd-sheet-body .wd-combo');
      return s && /missing in SOES/.test(s.textContent);
    });
    T('the missing outfit is still the value the field shows', () => {
      const v = document.querySelector('#wd-sheet-body .wd-combo .wd-combo-v');
      return v && v.textContent === 'Ghost Outfit';
    });
    T('a missing value marks the whole field, not just the chip',
      () => !!document.querySelector('#wd-sheet-body .wd-combo.warn'));
    ensureAssign(ly).outfit = 'Travelling Leathers';
    closeSheet();

    /* --- cadence maths --- */
    T('cadence 0 reads never', () => cadenceLabel(0) === 'never');
    T('cadence 12 reads 12h', () => cadenceLabel(12) === '12h');
    T('cadence 24 reads 1 day', () => cadenceLabel(24) === '1 day');
    T('cadence 168 reads 7 days', () => cadenceLabel(168) === '7 days');
    T('cadenceIndex snaps an odd value to a real stop', () => CADENCE[cadenceIndex(30)] === 24);
    T('cadenceIndex round-trips every stop', () => CADENCE.every((n, i) => cadenceIndex(n) === i));

    /* --- banner --- */
    const savedNpcs = state.npcs, savedAssign = state.assignments, savedSoes = state.soes;
    state.soes = { available: false, outfits: [], tracked: [], pending: false };
    render();
    T('banner warns when SOES is genuinely absent',
      () => els.banner.textContent.indexOf('SOES-NG is not answering') !== -1);
    state.soes = { available: false, outfits: [], tracked: [], pending: true };
    render();
    T('while WAITING it says so instead of crying wolf',
      () => els.banner.textContent.indexOf('Asking the outfit system') !== -1 &&
            els.banner.textContent.indexOf('not answering') === -1);
    T('the waiting banner is not styled as an error', () => els.banner.className === 'ok');
    state.soes = savedSoes;
    state.npcs = [{ formId: '0x1', plugin: 'a.esp', name: 'Naked Nord', portrait: '', tracked: true, wearing: '', conflict: false }];
    state.assignments = [];
    render();
    T('banner warns about a tracked npc with no outfit', () => els.banner.textContent.indexOf('no outfit assigned') !== -1);
    state.npcs = savedNpcs; state.assignments = savedAssign;
    render();

    /* --- injection safety --- */
    T('outfit names are text, never HTML', () => {
      const nodes = nameNodes('<img src=x onerror=1>', '');
      return nodes.length === 1 && nodes[0].nodeType === 3;
    });

    /* --- receive --- */
    receive('wdOpen', JSON.stringify({
      categories: [], outfitMeta: [], wardrobes: [{ id: 'x', name: 'From C++' }], assignments: [],
      settings: {}, soes: { available: true, outfits: [{ name: 'A', items: 1 }] }, npcs: [],
    }));
    T('wdOpen replaces state', () => state.wardrobes.length === 1 && state.wardrobes[0].name === 'From C++');
    T('wdOpen defaults a missing outfits[] to empty', () => Array.isArray(state.wardrobes[0].outfits));
    T('malformed payload does not throw', () => { receive('wdOpen', '{not json'); return true; });

    /* ---------------------------------------------- polish pass additions -- */
    devBoot(); setSub('outfits');

    /* --- no window.prompt / window.confirm anywhere (PrismaUI has neither) --- */
    T('pane source calls no window.prompt/confirm', () => {
      const src = WardrobePane.init.toString() + addForSub.toString() +
        wardrobeMenu.toString() + outfitMenu.toString() + npcMenu.toString() +
        deleteWardrobe.toString() + renderCats.toString() +
        /* the quick actions and the portrait chain, added later — a new
           affordance is exactly where a prompt() would slip back in */
        openNpcInventory.toString() + focusInSub.toString() +
        npcFace.toString() + setSheetFace.toString() + renderSheet.toString();
      return !/window\.(prompt|confirm)/.test(src);
    });

    /* --- inline rename --- */
    ui.editing = true; render();
    T('category pills expose an inline rename field in edit mode',
      () => q('#wd-cats .wd-inline').length === 3);
    T('outfit cards expose an inline note field in edit mode',
      () => q('#wd-list .wd-card .wd-inline.note').length === 10);
    const catInput = document.querySelector('[data-k="cat:c1"]');
    catInput.value = 'Eveningwear'; catInput.dispatchEvent(new Event('change'));
    T('inline rename commits to state', () => catById('c1').name === 'Eveningwear');
    T('inline rename is reflected on re-render',
      () => !!document.querySelector('[data-k="cat:c1"]') &&
        document.querySelector('[data-k="cat:c1"]').value === 'Eveningwear');
    const blank = document.querySelector('[data-k="cat:c1"]');
    blank.value = '   '; blank.dispatchEvent(new Event('change'));
    T('a required field refuses to be blanked', () => catById('c1').name === 'Eveningwear');
    catById('c1').name = 'Evening';
    ui.editing = false; render();

    /* --- category filter pills --- */
    T('category pills render outside edit mode', () => q('#wd-cats .wd-cat-pill').length === 4);
    ui.catFilter = 'c1'; resetPaging(); render();
    T('a category pill filters the grid', () => q('#wd-list .wd-card').length === 2);
    T('the active pill is marked pressed',
      () => document.querySelectorAll('#wd-cats .wd-cat-pill.on').length === 1);
    ui.catFilter = ''; render();
    T('clearing the pill restores everything', () => q('#wd-list .wd-card').length === 10);

    /* --- armed (two-click) delete --- */
    const wCount = state.wardrobes.length;
    setSub('wardrobes'); openBuilder('w2');
    const delBtn = document.querySelector('#wd-builder-del .wd-danger');
    delBtn.click();
    T('first delete click only arms', () => state.wardrobes.length === wCount);
    T('armed button relabels', () => {
      const b = document.querySelector('#wd-builder-del .wd-danger');
      return b && /click again/i.test(b.textContent);
    });
    document.querySelector('#wd-builder-del .wd-danger').click();
    T('second click deletes', () => state.wardrobes.length === wCount - 1);
    T('deleting a wardrobe unassigns its wearers',
      () => state.assignments.every((a) => a.wardrobeId !== 'w2'));
    T('deleting a wardrobe drops it from location overrides',
      () => state.assignments.every((a) => (a.locationOverrides || []).every((o) => o.wardrobeId !== 'w2')));
    devBoot();

    /* --- create-then-name --- */
    setSub('wardrobes');
    const before2 = state.wardrobes.length;
    addForSub();
    T('＋ Wardrobe creates immediately, no dialog', () => state.wardrobes.length === before2 + 1);
    T('the new wardrobe opens in the builder', () => ui.builderId === state.wardrobes[before2].id);
    closeBuilder();
    devBoot(); setSub('outfits');
    const cBefore = state.categories.length;
    addForSub();
    T('＋ Category creates immediately', () => state.categories.length === cBefore + 1);
    T('adding a category turns edit mode on so it can be named', () => ui.editing === true);
    ui.editing = false; devBoot(); setSub('outfits');

    /* --- paging (growth) --- */
    const many = [];
    for (let i = 0; i < 150; i++) many.push({ name: 'Outfit ' + (i < 10 ? '00' : i < 100 ? '0' : '') + i, items: 3 });
    state.soes = { available: true, outfits: many, tracked: [] };
    resetPaging(); render();
    T('a 150-outfit catalogue renders only one page', () => q('#wd-list .wd-card').length === PAGE);
    T('the count still reports the true total', () => els.count.textContent === '150');
    T('a show-more button appears', () => q('#wd-list .wd-more').length === 1);
    T('show-more names how many are hidden', () => /90 still hidden/.test(document.querySelector('.wd-more').textContent));
    document.querySelector('.wd-more').click();
    T('show-more reveals the next page', () => q('#wd-list .wd-card').length === PAGE * 2);
    els.search.value = 'Outfit 007'; ui.filter = 'Outfit 007'; resetPaging(); render();
    T('search re-pages from the top', () => q('#wd-list .wd-card').length === 1 && !q('#wd-list .wd-more').length);
    els.search.value = ''; ui.filter = ''; devBoot(); setSub('outfits');

    /* --- loading skeleton --- */
    ui.loading = true; render();
    T('loading shows skeletons, not an empty state', () => q('#wd-list .wd-skel').length === 8);
    T('loading hides the count', () => els.count.textContent === '—');
    T('loading does not show the empty state', () => els.empty.classList.contains('hidden'));
    /* The thumb matches to the pixel; the body can't, because a real card
     * stretches to the tallest in its grid row (an outfit with two rows of
     * chips). Half a chip row is the honest bar for "no visible jump". */
    T('a skeleton lands within half a chip-row of a real card (no jump on load)', () => {
      const sk = els.list.firstChild.getBoundingClientRect().height;
      const skThumb = els.list.firstChild.querySelector('.wd-skel-thumb').getBoundingClientRect().height;
      ui.loading = false; render();
      const card = document.querySelector('#wd-list .wd-card');
      const real = card.getBoundingClientRect().height;
      const realThumb = card.querySelector('.wd-thumb').getBoundingClientRect().height;
      ui.loading = true; render();
      return Math.abs(realThumb - skThumb) < 1 && Math.abs(real - sk) <= 12;
    });
    T('npc skeletons are rows, not cards', () => {
      setSub('npcs'); ui.loading = true; render();
      const ok = q('#wd-list .wd-skel.row').length === 5;
      setSub('outfits'); return ok;
    });
    ui.loading = false; render();

    /* --- scroll + focus survive a re-render --- */
    setSub('npcs');
    const firstRow = document.querySelector('#wd-list .wd-npc');
    els.body.scrollTop = 0;
    ui.editing = true; render(); ui.editing = false; render();
    T('re-render restores scroll position', () => els.body.scrollTop === 0);
    setSub('outfits'); ui.editing = true; render();
    const noteF = document.querySelector('[data-k="onote:Bath Robe"]');
    noteF.focus(); noteF.value = 'ab'; noteF.setSelectionRange(1, 1);
    render();
    T('re-render keeps focus in the inline field being typed in',
      () => document.activeElement === document.querySelector('[data-k="onote:Bath Robe"]'));
    T('re-render keeps UNCOMMITTED typed text', () => document.activeElement.value === 'ab');
    T('re-render keeps the caret position', () => document.activeElement.selectionStart === 1);
    ui.editing = false; render();

    /* --- keyboard navigation --- */
    setSub('outfits');
    const cards = q('#wd-list .wd-card');
    cards[0].focus();
    navKeys({ key: 'ArrowRight', preventDefault() {} });
    T('ArrowRight moves focus to the next card', () => document.activeElement === cards[1]);
    navKeys({ key: 'ArrowLeft', preventDefault() {} });
    T('ArrowLeft moves back', () => document.activeElement === cards[0]);
    navKeys({ key: 'End', preventDefault() {} });
    T('End jumps to the last card', () => document.activeElement === cards[cards.length - 1]);
    navKeys({ key: 'Home', preventDefault() {} });
    T('Home jumps to the first', () => document.activeElement === cards[0]);
    T('ArrowDown in a grid moves by a whole row', () => {
      cards[0].focus();
      navKeys({ key: 'ArrowDown', preventDefault() {} });
      return document.activeElement !== cards[0] && document.activeElement !== cards[1];
    });
    T('an unhandled key is left alone', () => navKeys({ key: 'q', preventDefault() {} }) === false);

    /* --- dialog focus discipline --- */
    setSub('wardrobes');
    const opener = document.querySelector('#wd-list .wd-card');
    const openerKey = opener.dataset.k;
    opener.focus();
    openBuilder('w1');
    /* the opener is tracked by key, because opening re-renders and detaches the node */
    T('opening a dialog remembers its opener', () => ui.opener === openerKey);
    closeBuilder();
    T('closing hands focus back to the opener',
      () => document.activeElement && document.activeElement.dataset.k === openerKey);
    T('the opener node was in fact replaced by the re-render', () => !opener.isConnected);
    T('a dialog card exposes focusable controls', () => {
      openBuilder('w1');
      const n = focusables($('wd-builder-card')).length;
      closeBuilder();
      return n > 2;
    });

    /* --- cadence next-change readout --- */
    T('next-change is computed from the game clock', () => {
      const a = state.assignments[0];             // lastRollDay 120.25, cadence 12h, now 120.5
      const nodes = nextChangeNodes(a);
      return Array.isArray(nodes) && nodes.some((n) => n.textContent === '~6h');
    });
    T('next-change degrades to a description with no clock', () => {
      const saved = state.now; state.now = null;
      const out = nextChangeNodes(state.assignments[0]);
      state.now = saved;
      return typeof out === 'string';
    });

    /* --- long values must not break the layout --- */
    T('a 90-character outfit name is clipped, not overflowing', () => {
      const long = 'Ceremonial Gown of the Everlasting Twilight Court, Third Pattern, Winter Variant Mk II';
      state.soes.outfits.push({ name: long, items: 4 });
      setSub('outfits'); els.search.value = long.slice(0, 20); ui.filter = long.slice(0, 20); render();
      const el = document.querySelector('#wd-list .wd-card-name');
      const fits = el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis';
      els.search.value = ''; ui.filter = '';
      state.soes.outfits.pop();
      render();
      return fits;
    });

    /* ---------------------------------------------- inventory + builder -- */
    setSub('inventory');
    T('inventory sub-tab renders every piece', () => q('#wd-list .wd-npc').length === 6);
    T('the build basket is pinned above the list', () => q('#wd-list .wd-basket').length === 1);
    T('slot chips render, All plus each of the 6 slots',
      () => q('#wd-list .wd-slotbar .wd-cat-pill').length === 7);
    T('Build starts disabled with nothing picked',
      () => document.querySelector('.wd-basket .wd-dress').disabled === true);
    T('inventory is sorted in dressing order (Body first, Unknown last)', () => {
      const names = Array.prototype.map.call(q('#wd-list .wd-npc-name'), (n) => n.textContent);
      return names[0] === 'Yeti Tunic' && names[names.length - 1] === 'Silver ring';
    });

    /* pick two pieces */
    q('#wd-list .wd-npc')[0].click();
    q('#wd-list .wd-npc')[1].click();
    T('picking marks the row', () => q('#wd-list .wd-npc.picked').length === 2);
    T('the basket lists what is picked',
      () => document.querySelector('.wd-basket-sub').textContent.indexOf('Yeti Tunic') !== -1);
    T('Build enables once something is picked',
      () => document.querySelector('.wd-basket .wd-dress').disabled === false);
    T('Build counts the pieces',
      () => /\(2\)/.test(document.querySelector('.wd-basket .wd-dress').textContent));
    q('#wd-list .wd-npc')[0].click();
    T('clicking a picked row unpicks it', () => q('#wd-list .wd-npc.picked').length === 1);

    /* slot filter + search */
    ui.invSlot = 'Body'; resetPaging(); render();
    T('a slot chip filters the list', () => q('#wd-list .wd-npc').length === 1);
    ui.invSlot = ''; render();
    els.search.value = 'yeti'; ui.filter = 'yeti'; resetPaging(); render();
    T('search narrows the inventory', () => q('#wd-list .wd-npc').length === 2);
    T('search highlights the hit in an inventory row',
      () => !!document.querySelector('#wd-list .wd-npc-name mark'));
    els.search.value = 'immersive'; ui.filter = 'immersive'; render();
    T('inventory search matches by PLUGIN', () => q('#wd-list .wd-npc').length === 1);
    els.search.value = ''; ui.filter = ''; render();

    /* build fires the bridge with the right shape */
    let sent = null;
    const realBuild = window.wdBuild;
    window.wdBuild = (p) => { sent = JSON.parse(p); };
    buildState().name = '';
    doBuild();
    T('Build refuses without a name', () => sent === null);
    buildState().name = '  Yeti Traveller  ';
    doBuild();
    T('Build sends wdBuild', () => !!sent);
    T('Build trims the name', () => sent && sent.name === 'Yeti Traveller');
    T('Build sends formId + plugin + name per piece', () => sent && sent.items.length === 1 &&
      sent.items[0].formId && sent.items[0].plugin && sent.items[0].name);
    T('Build clears the basket afterwards', () => buildPicked().length === 0);
    window.wdBuild = realBuild;

    T('inventory rows are a list, not a grid', () => {
      setSub('inventory');
      return !els.list.classList.contains('grid');
    });
    T('an empty inventory shows its own empty state', () => {
      const keep = state.inventory;
      state.inventory = []; render();
      const ok = !els.empty.classList.contains('hidden') &&
        els.empty.textContent.indexOf('No armour') !== -1;
      state.inventory = keep; render();
      return ok;
    });
    T('the ＋ button is hidden on Inventory', () => els.add.classList.contains('hidden'));

    /* --- copy what someone is wearing --- */
    setSub('inventory');
    T('a copy-worn row is offered',
      () => q('#wd-list .wd-fromrow:not(.wd-srcrow)').length === 1);
    T('it offers you plus anyone dressed',
      () => q('#wd-list .wd-fromrow:not(.wd-srcrow) .ghost-btn').length >= 2);
    T('an armour-source switch is offered', () => q('#wd-list .wd-srcrow').length === 1);
    ui.build = null; render();
    receive('wdWornList', JSON.stringify({ ok: true, who: 'Camilla Valerius', items: [
      { formId: '0x16CF9', plugin: 'RelicsofHyruleDragonborn.esp', name: 'Yeti Tunic', slot: 'Body' },
      { formId: '0x1B3A4', plugin: 'Skyrim.esm', name: 'Fine Boots', slot: 'Feet' },
    ] }));
    T('a worn list fills the basket', () => buildPicked().length === 2);
    T('it names the outfit after them', () => buildState().name.indexOf('Camilla') === 0);
    T('it jumps to the Inventory tab', () => ui.sub === 'inventory');
    /* ADD, never replace — two looks must be combinable and a mis-tap must not wipe picks */
    receive('wdWornList', JSON.stringify({ ok: true, who: 'You', items: [
      { formId: '0x16CF9', plugin: 'RelicsofHyruleDragonborn.esp', name: 'Yeti Tunic', slot: 'Body' },
      { formId: '0x261C1', plugin: 'Skyrim.esm', name: 'Gloves', slot: 'Hands' },
    ] }));
    T('a second worn list ADDS and de-dupes', () => buildPicked().length === 3);
    T('it does not rename an outfit you already named', () => buildState().name.indexOf('Camilla') === 0);
    const beforeEmpty = buildPicked().length;
    receive('wdWornList', JSON.stringify({ ok: true, who: 'Naked Nord', items: [] }));
    T('an empty worn list changes nothing', () => buildPicked().length === beforeEmpty);
    receive('wdWornList', JSON.stringify({ ok: false, msg: 'not loaded' }));
    T('a failed worn read changes nothing', () => buildPicked().length === beforeEmpty);
    T('a malformed worn payload does not throw',
      () => { receive('wdWornList', '{nope'); return true; });
    ui.build = null; render();

    /* ------------------------------------------ pieces / all-armour / modes -- */

    /* --- an outfit's pieces --- */
    ui.pieces = { name: 'Sfancy Blue', items: [], loading: true }; render();
    T('pieces overlay opens', () => !$('wd-pieces').classList.contains('hidden'));
    T('pieces shows a skeleton while loading', () => q('#wd-pieces-body .wd-skel').length === 4);
    receive('wdPieceList', JSON.stringify({ ok: true, name: 'Sfancy Blue', items: [
      { formId: '0x16CF9', plugin: 'A.esp', name: 'Blue Gown', slot: 'Body', missing: false },
      { formId: '0x999',   plugin: 'Gone.esp', name: '(unresolved)', slot: 'Unknown', missing: true },
    ] }));
    T('pieces list renders', () => q('#wd-pieces-body .wd-pick').length === 2);
    T('an unresolvable piece is flagged',
      () => $('wd-pieces-body').textContent.indexOf('plugin gone') !== -1);
    T('the header counts unresolved', () => $('wd-pieces-sub').textContent.indexOf('1 unresolved') !== -1);
    T('removing a piece is armed, not instant', () => {
      const b0 = document.querySelector('#wd-pieces-body .wd-danger');
      b0.click();
      return ui.pieces.items.length === 2;
    });
    document.querySelector('#wd-pieces-body .wd-danger').click();
    T('a second click removes it', () => ui.pieces.items.length === 1);
    receive('wdPieceList', JSON.stringify({ ok: false, name: 'X', msg: 'not in SOES' }));
    T('a failed pieces read explains itself',
      () => $('wd-pieces-body').textContent.indexOf('not in SOES') !== -1);
    closePieces();
    T('pieces overlay closes', () => $('wd-pieces').classList.contains('hidden'));

    /* --- browsing all armour in the load order --- */
    setSub('inventory');
    T('the source starts on what you carry', () => ui.invSource === 'carried');
    ui.invSource = 'all'; state.armorMods = []; resetPaging(); render();
    T('with no mod list yet it says it is reading',
      () => els.list.textContent.indexOf('Reading the load order') !== -1);
    receive('wdArmorModList', JSON.stringify({ ok: true, mods: [
      { plugin: 'Immersive Jewelry.esp', count: 1200 },
      { plugin: 'RelicsofHyruleDragonborn.esp', count: 40 },
    ] }));
    T('mods list renders', () => q('#wd-list .wd-npc').length === 2);
    T('busiest mod is first',
      () => document.querySelector('#wd-list .wd-npc-name').textContent.indexOf('Immersive') === 0);
    els.search.value = 'relics'; ui.filter = 'relics'; render();
    T('mods are searchable', () => q('#wd-list .wd-npc').length === 1);
    els.search.value = ''; ui.filter = ''; render();
    ui.invMod = 'Immersive Jewelry.esp'; state.modArmors = null; render();
    T('picking a mod shows a skeleton', () => q('#wd-list .wd-skel').length === 5);
    receive('wdArmorList', JSON.stringify({ ok: true, plugin: 'Immersive Jewelry.esp',
      total: 1200, shown: 2, capped: true, items: [
        { formId: '0x1', plugin: 'Immersive Jewelry.esp', name: 'Gold Ring', slot: 'Ring', armorRating: 0, enchanted: false },
        { formId: '0x2', plugin: 'Immersive Jewelry.esp', name: 'Silver Tiara', slot: 'Circlet', armorRating: 1, enchanted: true },
      ] }));
    T('that mod\u2019s armour renders', () => q('#wd-list .wd-npc').length === 2);
    T('a capped result says how many are hidden',
      () => els.list.textContent.indexOf('Showing 2 of 1200') !== -1);
    T('a back-to-all-mods control is offered', () => q('#wd-list .wd-srcrow .ghost-btn').length >= 1);
    T('armour from the load order is pickable like inventory', () => {
      q('#wd-list .wd-npc')[0].click();
      return buildPicked().length === 1 && buildPicked()[0].name === 'Gold Ring';
    });
    T('the basket is shown in all-armour mode too', () => q('#wd-list .wd-basket').length === 1);
    ui.build = null; ui.invMod = ''; ui.invSource = 'carried'; state.modArmors = null; render();

    /* --- randomisation mode --- */
    openBuilder('w1');
    T('a wardrobe defaults to the shuffle bag',
      () => $('wd-builder-mode').textContent.indexOf('Shuffle bag') !== -1);
    document.querySelector('#wd-builder-mode .wd-cat-pill').click();
    T('it can be switched to true random', () => wardrobeById('w1').mode === 'random');
    T('switching modes empties the bag', () => (wardrobeById('w1').bag || []).length === 0);
    document.querySelector('#wd-builder-mode .wd-cat-pill').click();
    T('and back to the bag', () => wardrobeById('w1').mode === 'bag');
    closeBuilder();

    /* --- system settings --- */
    setSub('npcs');
    T('settings are collapsed by default', () => ui.settings === false);
    T('a settings toggle is offered',
      () => els.list.textContent.indexOf('Outfit system settings') !== -1);
    ui.settings = true; render();
    /* four original rows + quick-swap + weather + the importer */
    T('expanding shows all seven control rows', () => q('#wd-list .wd-basket .wd-field').length === 7);
    T('it explains Automatic vs Immersive',
      () => els.list.textContent.indexOf('only uses what is already in their inventory') !== -1);

    /* --- the two SOES switches that had no route out of its MCM --- */
    T('the quick-swap power is offered',
      () => els.list.textContent.indexOf('Quick-swap power') !== -1);
    T('and says what starring an outfit now does',
      () => els.list.textContent.indexOf('puts it in that menu') !== -1);
    T('weather-vs-place is offered',
      () => els.list.textContent.indexOf('Weather vs. place') !== -1);
    (() => {
      const sent = [];
      const old = window.wdSoesOpt;
      window.wdSoesOpt = (a) => sent.push(JSON.parse(a));
      /* the pressed state is what the deck last set, so start from a known one */
      state.settings.soesQuickslot = false; render();
      const btns = [...q('#wd-list .wd-basket .wd-seg button')].filter(
        (b) => b.title.indexOf('quick-swap power') !== -1);
      T('the quick-swap switch renders an On and an Off', () => btns.length === 2);
      T('Off reads as pressed while it is off',
        () => btns[1].className.indexOf('on') !== -1 && btns[0].className.indexOf('on') === -1);
      btns[0].click();
      T('turning it on sends wdSoesOpt', () => sent.length === 1 && sent[0].key === 'quickslot' && sent[0].on === true);
      T('and the mirror flips so the UI reads true', () => state.settings.soesQuickslot === true);
      const cb = [...q('#wd-list .wd-basket .wd-seg button')].filter(
        (b) => b.title.indexOf('outrank') !== -1);
      T('the weather switch renders two buttons too', () => cb.length === 2);
      cb[0].click();
      T('it sends climate, not quickslot',
        () => sent.length === 2 && sent[1].key === 'climate' && sent[1].on === true);
      T('every switch button carries a hover title', () => btns.concat(cb).every((b) => !!b.title));
      window.wdSoesOpt = old;
      state.settings.soesQuickslot = false; state.settings.soesClimate = false;
    })();

    /* --- the outfit importer: the dead wdImport, finally reachable --- */
    (() => {
      const asked = [];
      const oldMods = window.wdOutfitMods, oldFor = window.wdOutfitsFor, oldImp = window.wdImport;
      window.wdOutfitMods = () => asked.push('mods');
      window.wdOutfitsFor = (a) => asked.push('for:' + JSON.parse(a).plugin);
      window.wdImport = (a) => asked.push('import:' + JSON.stringify(JSON.parse(a)));

      ui.importer = null; state.outfitMods = []; state.modOutfits = null; render();
      T('the importer is collapsed by default', () => ui.importer === null);
      const open = [...q('#wd-list .wd-basket button')].filter(
        (b) => b.textContent.indexOf('Browse mods') !== -1)[0];
      T('a Browse mods button is offered', () => !!open);
      open.click();
      T('opening it asks C++ for the plugin list', () => asked.indexOf('mods') !== -1);
      T('and says it is reading while it waits',
        () => els.list.textContent.indexOf('Reading the load order') !== -1);

      receive('wdOutfitModList', JSON.stringify({ ok: true, mods: [
        { plugin: 'Alpha.esp', count: 3 }, { plugin: 'Beta.esp', count: 12 },
        { plugin: 'Gamma.esl', count: 1 },
      ] }));
      T('the plugin list renders one row each', () => q('#wd-list .wd-imp-list .wd-imp-row').length === 3);
      T('each row shows how many outfits it defines',
        () => q('#wd-list .wd-imp-list .wd-imp-c')[1].textContent === '12');
      T('there is a typeable search over the plugins',
        () => !!document.getElementById('wd-imp-q'));
      T('the plugin search has a hover title and an aria-label', () => {
        const i = document.getElementById('wd-imp-q');
        return !!i.title && !!i.getAttribute('aria-label');
      });
      ui.importer.q = 'bet'; render();
      T('typing narrows the plugin list', () => q('#wd-list .wd-imp-list .wd-imp-row').length === 1);
      T('and says how many of how many matched',
        () => els.list.textContent.indexOf('1 of 3 plugin') !== -1);
      ui.importer.q = 'zzz'; render();
      T('no match is said, not left blank',
        () => els.list.textContent.indexOf('No plugin matches') !== -1);
      ui.importer.q = ''; render();

      q('#wd-list .wd-imp-list .wd-imp-row')[1].click();
      T('picking a plugin asks C++ for its outfits', () => asked.indexOf('for:Beta.esp') !== -1);
      T('and the picked row reads as selected',
        () => q('#wd-list .wd-imp-list .wd-imp-row')[1].getAttribute('aria-selected') === 'true');
      T('it says it is reading that plugin',
        () => els.list.textContent.indexOf('Reading Beta.esp') !== -1);

      receive('wdOutfitList', JSON.stringify({ ok: true, plugin: 'Beta.esp', outfits: [
        { editorId: 'BetaCourtDress', parts: 4, formId: '0x801' },
        { editorId: 'BetaTravelGear', parts: 6, formId: '0x802' },
        { editorId: '', parts: 2, formId: '0x803' },
      ] }));
      const rows = [...q('#wd-list .wd-imp-list .wd-imp-row.static')];
      T('the outfit list renders', () => rows.length === 3);
      T('an outfit with no editor ID is shown as unimportable, not hidden',
        () => rows[2].textContent.indexOf('no editor ID') !== -1 &&
              rows[2].querySelector('.wd-imp-go').disabled === true);
      T('an importable row is enabled', () => rows[0].querySelector('.wd-imp-go').disabled === false);
      T('every import button carries a hover title',
        () => rows.every((r) => !!r.querySelector('.wd-imp-go').title));
      T('there is a second search over this mod\u2019s outfits',
        () => !!document.getElementById('wd-imp-q2'));
      ui.importer.q2 = 'travel'; render();
      T('it narrows the outfit list',
        () => q('#wd-list .wd-imp-list .wd-imp-row.static').length === 1);
      ui.importer.q2 = ''; render();

      q('#wd-list .wd-imp-list .wd-imp-row.static')[0].querySelector('.wd-imp-go').click();
      T('importing one sends the plugin AND the editor id',
        () => asked.some((a) => a === 'import:{"plugin":"Beta.esp","editorId":"BetaCourtDress"}'));
      T('the imported row then reads as done',
        () => q('#wd-list .wd-imp-list .wd-imp-row.static')[0].querySelector('.wd-imp-go').disabled === true);
      const all = [...q('#wd-list .wd-basket button')].filter(
        (b) => b.textContent.indexOf('Import all') !== -1)[0];
      T('import-all names the count', () => all && all.textContent.indexOf('Import all 3') !== -1);
      all.click();
      T('import-all sends the plugin with no editor id',
        () => asked.some((a) => a === 'import:{"plugin":"Beta.esp"}'));

      window.wdOutfitMods = oldMods; window.wdOutfitsFor = oldFor; window.wdImport = oldImp;
      ui.importer = null; ui.imported = {}; state.modOutfits = null;
    })();
    ui.settings = false; render();

    /* ------------------------------------- selection, bulk, picker, delete -- */
    devBoot(); setSub('outfits'); selClear(); render();

    T('nothing is selected to begin with', () => q('#wd-selbar .wd-selbar').length === 0);
    const cards0 = q('#wd-list .wd-card');
    T('every outfit card carries a ⋯ menu button (right-click is unreliable)',
      () => q('#wd-list .wd-dots').length === cards0.length);

    /* --- the star is no longer decoration, and outfits can be renamed --- */
    (() => {
      const sent = [];
      const oldFav = window.wdFav, oldRen = window.wdRename;
      window.wdFav = (a) => sent.push(['fav', JSON.parse(a)]);
      window.wdRename = (a) => sent.push(['ren', JSON.parse(a)]);
      const target = state.soes.outfits[1].name;

      /* Drive the real context menu (els.menu, .wd-menu-i rows) rather than
         reaching past it — the point of these checks is that the ROW exists
         and is wired, which a direct call to the handler would not prove. */
      const menuItem = (label) => {
        outfitMenu({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} }, target);
        return [...els.menu.querySelectorAll('.wd-menu-i')]
          .filter((b) => b.textContent.indexOf(label) !== -1)[0];
      };

      const favBtn = menuItem('Favourite');
      T('the outfit menu offers a favourite row', () => !!favBtn);
      favBtn.click();
      T('starring sends wdFav so SOES\u2019s own flag is set',
        () => sent.some(([k, v]) => k === 'fav' && v.name === target && v.on === true));
      T('and the deck-side star flips too', () => (metaFor(target) || {}).fav === true);

      const renBtn = menuItem('Rename');
      T('the outfit menu offers a rename row', () => !!renBtn);
      renBtn.click();
      T('rename opens an in-place field, not a prompt',
        () => ui.renaming === target && !!els.pane.querySelector('[data-k="orename:' + cssEsc(target) + '"]'));
      const f = els.pane.querySelector('[data-k="orename:' + cssEsc(target) + '"]');
      /* a name that collides is refused rather than sent */
      f.value = state.soes.outfits[0].name;
      f.dispatchEvent(new Event('change', { bubbles: true }));
      T('renaming onto an existing name sends nothing',
        () => !sent.some(([k]) => k === 'ren'));
      renBtn.click ? null : null;
      ui.renaming = target; render();
      const f2 = els.pane.querySelector('[data-k="orename:' + cssEsc(target) + '"]');
      f2.value = 'A pipe | name';
      f2.dispatchEvent(new Event('change', { bubbles: true }));
      T('a name containing "|" is refused — it is the wire separator',
        () => !sent.some(([k]) => k === 'ren'));
      ui.renaming = target; render();
      const f3 = els.pane.querySelector('[data-k="orename:' + cssEsc(target) + '"]');
      f3.value = 'Renamed Look';
      f3.dispatchEvent(new Event('change', { bubbles: true }));
      T('a good rename sends wdRename with both names',
        () => sent.some(([k, v]) => k === 'ren' && v.name === target && v.to === 'Renamed Look'));
      T('and every pool that held it is re-pointed on our side',
        () => !state.wardrobes.some((w) => (w.outfits || []).indexOf(target) !== -1));
      T('the rename field closes after committing', () => ui.renaming === null);

      window.wdFav = oldFav; window.wdRename = oldRen;
      devBoot(); setSub('outfits'); selClear(); render();
    })();

    cards0[0].click();
    T('a plain click selects', () => ui.sel.length === 1);
    T('the bulk bar appears', () => q('#wd-selbar .wd-selbar').length === 1);
    T('the card shows as selected', () => q('#wd-list .wd-card.sel').length === 1);
    q('#wd-list .wd-card')[0].click();
    T('clicking the only selection again clears it', () => ui.sel.length === 0);

    q('#wd-list .wd-card')[0].click();
    q('#wd-list .wd-card')[2].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    T('ctrl-click adds to the selection', () => ui.sel.length === 2);
    q('#wd-list .wd-card')[4].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    T('shift-click extends a range', () => ui.sel.length >= 4);
    ui.sel = selVisible().slice(0, 3); render();
    T('the bar counts the selection', () => els.selbar.textContent.indexOf('3 selected') !== -1);

    /* --- the searchable picker --- */
    openPicker('category');
    T('picker opens', () => !$('wd-picker').classList.contains('hidden'));
    T('it says how many are selected', () => $('wd-picker-sub').textContent.indexOf('3 outfit') !== -1);
    T('it lists the existing categories', () => q('#wd-picker-list .wd-pick').length === 3);
    ui.picker.q = 'even'; renderPicker();
    /* "even" matches Evening AND offers to create "even" — both are .wd-pick,
       so count the real matches separately from the create row. */
    T('typing filters the real rows',
      () => q('#wd-picker-list .wd-pick:not(.create)').length === 1);
    T('a partial that is not an exact name still offers to create it',
      () => q('#wd-picker-list .wd-pick.create').length === 1);
    ui.picker.q = 'Evening'; renderPicker();
    T('an EXACT name offers no duplicate-create row',
      () => q('#wd-picker-list .wd-pick.create').length === 0);
    ui.picker.q = 'Galactic'; renderPicker();
    T('a name that does not exist offers to CREATE it',
      () => q('#wd-picker-list .wd-pick.create').length === 1);
    const catsBefore = state.categories.length;
    document.querySelector('#wd-picker-list .wd-pick.create').click();
    T('creating assigns it to everything selected in one go', () => {
      const c = state.categories[state.categories.length - 1];
      return state.categories.length === catsBefore + 1 &&
        ui.sel.every((nm) => (metaFor(nm) || {}).categoryIds.indexOf(c.id) !== -1);
    });
    T('the picker closes after creating', () => ui.picker === null);

    /* toggling an existing one both ways */
    openPicker('category');
    ui.picker.q = ''; renderPicker();
    const onRow = pickerRows().find((r) => r.on);
    T('a category everything already has reads as on', () => !!onRow);
    pickerApply(onRow);
    T('applying an already-on category REMOVES it',
      () => ui.sel.every((nm) => (metaFor(nm) || {}).categoryIds.indexOf(onRow.id) === -1));
    closePicker();

    /* --- wardrobe picker, same control --- */
    openPicker('wardrobe');
    T('wardrobe picker lists wardrobes', () => q('#wd-picker-list .wd-pick').length === state.wardrobes.length);
    const w1 = pickerRows()[0];
    pickerApply(w1);
    T('it adds every selected outfit to that wardrobe',
      () => ui.sel.every((nm) => wardrobeById(w1.id).outfits.indexOf(nm) !== -1));
    closePicker();

    /* --- keyboard --- */
    openPicker('category');
    ui.picker.q = ''; ui.picker.idx = 0; renderPicker();
    T('ArrowDown moves the highlight',
      () => { pickerKey({ key: 'ArrowDown', preventDefault() {} }); return ui.picker.idx === 1; });
    T('ArrowUp moves back',
      () => { pickerKey({ key: 'ArrowUp', preventDefault() {} }); return ui.picker.idx === 0; });
    T('the highlight is drawn', () => q('#wd-picker-list .wd-pick.kb').length === 1);
    T('Esc closes the picker',
      () => { pickerKey({ key: 'Escape', preventDefault() {} }); return ui.picker === null; });

    /* --- delete --- */
    let deleted = null;
    const realDel = window.wdOutfitDel;
    window.wdOutfitDel = (p) => { deleted = JSON.parse(p); };
    ui.sel = ['Bath Robe']; render();
    document.querySelector('#wd-selbar .wd-danger').click();
    T('bulk delete arms first', () => deleted === null);
    document.querySelector('#wd-selbar .wd-danger').click();
    T('a second click deletes', () => deleted && deleted.name === 'Bath Robe');
    T('deleting clears the selection', () => ui.sel.length === 0);
    window.wdOutfitDel = realDel;

    /* --- selection is per-tab --- */
    devBoot(); setSub('outfits');
    ui.sel = ['Sfancy Blue']; render();
    setSub('npcs');
    T('switching to a tab without selection clears it', () => ui.sel.length === 0);
    setSub('wardrobes');
    const wc = q('#wd-list .wd-card');
    wc[0].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    T('ctrl-click selects a wardrobe', () => ui.sel.length === 1);
    T('but a plain click still opens the builder', () => {
      selClear(); render();
      q('#wd-list .wd-card')[0].click();
      const open = !!ui.builderId;
      closeBuilder();
      return open;
    });
    selClear();

    /* ============================================ faces on the NPC rows == */
    /* The whole point of the feature: the Wardrobe's people must show the same
       photograph the Followers tab shows, resolved by the SAME slug rule, off
       the SAME fdPortraits feed. Everything below is about the three ways that
       silently degrades — a clobbered global, a drifted slug, and Ultralight
       refusing the cache-busted URL. */
    devBoot(); setSub('npcs');

    const prevCount = window.__fdPortraitsPrev;
    window.fdPortraits(JSON.stringify([
      { slug: 'camilla-valerius', file: 'camilla-valerius.png', ext: 'png', mtime: 1730000001 },
      /* a RE-CAPTURED face: Ultralight memory-maps every image it has drawn, so
         C++ writes the new one as <slug>~1.png. `file` is authoritative and must
         never be rebuilt from slug + ext, or the row paints the stale picture. */
      { slug: 'lydia', file: 'lydia~1.png', ext: 'png', mtime: 1730000002 },
      /* a value that walks out of portraits/ is REFUSED, not sanitised */
      { slug: 'aelia-rivena', file: '../../../evil.png', ext: 'png', mtime: 1730000003 },
    ]));
    render();

    /* Only THIS pane's harness installs a stand-in ahead of us; the NFF harness
       loads wardrobe-pane.js first, so there is legitimately nothing in front
       to chain. Assert whichever of the two is true here, so the check is
       meaningful where it can be and never a false alarm where it cannot. */
    T('fdPortraits CHAINS the Followers pane, it does not replace it', () =>
      typeof prevPortraits === 'function'
        ? window.__fdPortraitsPrev === prevCount + 1
        : prevPortraits === undefined);
    T('fdPortraits fills the slug -> file map', () =>
      !!state.portraits['camilla-valerius'] &&
      state.portraits['camilla-valerius'].file === 'camilla-valerius.png');
    T('the listing keeps the re-captured filename verbatim',
      () => state.portraits['lydia'].file === 'lydia~1.png');
    T('a file that escapes portraits/ is refused and falls back to slug.ext',
      () => state.portraits['aelia-rivena'].file === 'aelia-rivena.png');

    /* the slug rule — identical in followers-pane.js, portal/server.js and
       portraits/README.txt. A drift here is a picture that never shows. */
    T('slug lowercases and hyphenates runs of punctuation',
      () => slugOf("Aelia  Rivena's") === 'aelia-rivena-s');
    T('slug folds accents', () => slugOf('Ébonarm Ö') === 'ebonarm-o');
    T('slug trims leading/trailing separators', () => slugOf('  --Lydia--  ') === 'lydia');

    const rowFor = (nm) => Array.prototype.find.call(
      q('#wd-list .wd-npc'), (r) => r.textContent.indexOf(nm) !== -1);

    T('an npc row renders her real face, not the glyph', () => {
      const img = rowFor('Camilla').querySelector('img.wd-npc-face');
      return !!img && img.getAttribute('src').indexOf('portraits/camilla-valerius.png?v=') === 0;
    });
    T('the row face is cache-busted with the file mtime', () =>
      /\?v=1730000001$/.test(rowFor('Camilla').querySelector('img.wd-npc-face').getAttribute('src')));
    T('a renamed follower still gets her original photo (file, not slug+ext)', () =>
      rowFor('Lydia').querySelector('img.wd-npc-face').getAttribute('src').indexOf('lydia~1.png') === 0 + 'portraits/'.length);
    T('someone with no portrait falls back to the person glyph', () => {
      const r = rowFor('Ysolda');
      return !r.querySelector('img.wd-npc-face') && !!r.querySelector('.wd-npc-face.ph svg');
    });

    /* Ultralight's loader can treat "?v=<mtime>" as part of the FILENAME
       (proven in-game 2026-07-28), so the FIRST error retries the plain path
       and only a second one gives up. Synthetic events: a real 404 is async and
       would land after this synchronous run. */
    const face = rowFor('Camilla').querySelector('img.wd-npc-face');
    T('a failed portrait retries the plain path once', () => {
      face.dispatchEvent(new Event('error'));
      return face.getAttribute('src') === 'portraits/camilla-valerius.png';
    });
    T('a second failure falls back to the glyph rather than a broken image', () => {
      face.dispatchEvent(new Event('error'));
      return !!rowFor('Camilla').querySelector('.wd-npc-face.ph') &&
        !rowFor('Camilla').querySelector('img.wd-npc-face');
    });

    /* the sheet header wears the same face */
    render();
    openSheet(state.npcs[0]);
    T('the sheet header shows the same face as the row', () =>
      !els.sheetFace.classList.contains('hidden') &&
      els.sheetFace.getAttribute('src').indexOf('portraits/camilla-valerius.png?v=') === 0);
    closeSheet();
    openSheet(state.npcs[2]);              // Ysolda — no portrait
    T('the sheet hides the face for someone with no portrait',
      () => els.sheetFace.classList.contains('hidden'));
    closeSheet();

    /* ======================================== quick actions on an npc ==== */
    /* Trade and "her NFF outfits", reusing bridges that already exist. Both
       live in the SHEET and the right-click menu, never on the row — the row
       already carries a name, up to five chips and ✦ Dress. */

    /* fdNpc is a REQUEST name. PrismaUI installs every C++ listener as a JS
       global, so a receiver of the same name would make toGame('fdNpc', …)
       call US and the message would never leave the view. The reply is
       fdNpcResult and belongs to the Followers pane. */
    T('the pane installs no receiver that would shadow fdNpc',
      () => typeof window.fdNpc === 'undefined' && typeof window.fdNpcResult === 'undefined');

    let npcSent = null;
    window.fdNpc = (p) => { npcSent = JSON.parse(p); };

    openSheet(state.npcs[0]);
    const quickBtns = () => Array.prototype.slice.call(
      document.querySelectorAll('#wd-sheet-body .wd-field .wd-seg button'));
    const tradeBtn = () => quickBtns().find((b) => /Trade \/ inventory/.test(b.textContent));
    T('the sheet offers Trade / inventory', () => !!tradeBtn());
    T('it sends fdNpc with op "inventory"', () => {
      tradeBtn().click();
      return !!npcSent && npcSent.op === 'inventory';
    });
    T('it names the actor by form id AND plugin', () =>
      npcSent.formId === '0x0001A6A1' && npcSent.plugin === 'Skyrim.esm');
    /* NffControl::ParseHex reads a STRING with std::stoul(…,16); a JSON number
       would arrive as something else entirely and resolve to no actor at all. */
    T('the form id goes as hex TEXT, which is what NffControl::ParseHex reads',
      () => typeof npcSent.formId === 'string' && /^0x[0-9a-f]+$/i.test(npcSent.formId));
    closeSheet();

    npcSent = null;
    npcMenu({ preventDefault() {}, clientX: 40, clientY: 40 }, state.npcs[0]);
    const menuItem = (re) => Array.prototype.find.call(
      document.querySelectorAll('#wd-menu button'), (b) => re.test(b.textContent));
    T('the right-click menu carries Trade / inventory too', () => !!menuItem(/Trade \/ inventory/));
    T('the menu item sends the same fdNpc payload', () => {
      menuItem(/Trade \/ inventory/).click();
      return !!npcSent && npcSent.op === 'inventory' && npcSent.formId === '0x0001A6A1';
    });
    hideMenu();

    /* an actor with no form id must not send a message that resolves to nobody */
    npcSent = null;
    openNpcInventory({ name: 'Nobody', formId: '', plugin: '' });
    T('an npc with no form id is refused instead of sending a dud', () => npcSent === null);
    delete window.fdNpc;

    /* --- handing off to the NFF sub-tab --- */
    /* wardrobe-nff.js is not loaded in this harness, so with no plug-in there
       must be NO affordance — a button that toasts "not loaded" is worse than
       no button. Then register a stand-in that speaks the same optional
       focusNpc() contract and prove the jump lands on the right person. */
    T('with no outfit sub-tab loaded there is no phantom jump button', () => {
      if (subFocusId()) return true;                    // real nff present: n/a
      openSheet(state.npcs[0]);
      const none = !quickBtns().find((b) => /outfits/.test(b.textContent));
      closeSheet();
      return none;
    });

    const focused = [];
    const stub = {
      id: 'wdtest', label: 'Stub', init() {}, onEnter() {}, count: () => 0,
      render: (ctx) => { ctx.list.append(h('div', { class: 'wd-stub' }, 'stub')); return 0; },
      setFilter() {}, focusNpc: () => {},
    };
    /* Register the stand-in ONLY when nothing real offers the hook. In the NFF
       harness wardrobe-nff.js is loaded and IS the answer, and testing against
       a stub we invented instead of the real plug-in would be testing nothing. */
    const usedStub = !subFocusId();
    if (usedStub) registerSub(stub);
    T('a sub-tab that offers focusNpc is discovered', () => !!subFocusId());

    /* Spy on whichever plug-in the host actually picked — the real NFF tab when
       it is loaded, our stand-in otherwise — so these assertions exercise the
       genuine wiring rather than a fixture. Restored right after. */
    const spyId = subFocusId();
    const spyOwner = spyId ? PLUGINS[spyId] : null;
    const realFocusNpc = spyOwner ? spyOwner.focusNpc : null;
    if (spyOwner) spyOwner.focusNpc = (who) => { focused.push(who); };

    setSub('npcs');
    openSheet(state.npcs[0]);
    const jumpBtn = quickBtns().find((b) => /outfits/.test(b.textContent));
    T('the sheet grows an outfits jump for that sub-tab', () => !!jumpBtn);
    els.search.value = 'camilla'; ui.filter = 'camilla';
    T('the jump switches to that sub-tab', () => {
      jumpBtn.click();
      return ui.sub === subFocusId();
    });
    T('it closes the sheet on the way', () => ui.sheetKey === null);
    T('it clears the search, so she is not filtered off the tab she lands on',
      () => ui.filter === '' && els.search.value === '');
    T('it hands over the SAME identity the Wardrobe keys on', () => {
      const w = focused[focused.length - 1];
      return w && w.formId === '0x0001A6A1' && w.plugin === 'Skyrim.esm' &&
        w.name === 'Camilla Valerius';
    });
    T('the right-click menu offers the jump as well', () => {
      setSub('npcs');
      npcMenu({ preventDefault() {}, clientX: 40, clientY: 40 }, state.npcs[1]);
      const hit = menuItem(/outfits/);
      const ok = !!hit;
      if (hit) hit.click();
      hideMenu();
      return ok;
    });
    T('the menu jump focuses the person it was opened on', () => {
      const w = focused[focused.length - 1];
      return w && w.name === 'Lydia';
    });

    /* put the real hook back, and unregister the stand-in if we added one, so
       the harness page is left exactly as it was found */
    if (spyOwner) spyOwner.focusNpc = realFocusNpc;

    /* END TO END, and only where the real plug-in is loaded (the NFF harness —
       n/a in this pane's own, which has no NFF tab at all). The spy above
       proves we PASS the right identity; only this proves the far end can FIND
       her, which is where a jump like this fails SILENTLY, as a confident "she
       isn't on NFF's roster" about someone sitting right there.

       Aimed at whoever is actually on NFF's roster rather than a named fixture
       (its own suite rewrites that roster before ours runs), and deliberately
       RE-SPELT — 0x-prefixed, upper case, zero-padded to eight digits. Same
       actor, different characters: this rig writes a form id at least four ways
       (FO's JSON, wardrobe.cpp's HexOf, nff_outfits.cpp's row, a hand-edited
       config) and a raw string compare quietly misses. */
    T('the jump lands on her even when the form id is spelt differently', () => {
      if (usedStub || !window.WardrobeNff || !window.WardrobeNff._ui) return true;
      const N = window.WardrobeNff;
      const target = (N._state.npcs || [])[0];
      if (!target) return true;                  // nobody on the roster to aim at
      let hex = String(target.formId).replace(/^0x/i, '').toUpperCase();
      while (hex.length < 8) hex = '0' + hex;    // no padStart — keep it ES5-safe
      N._closeSheet();
      focusInSub({ formId: '0x' + hex, plugin: target.plugin, name: target.name }, spyId);
      // keyOf is case-folded (canonical) since the identity fix; compare in
      // the same spelling or this check punishes the fix it exists to protect.
      const landed = String(N._ui.sheetKey || '').toLowerCase()
        === (target.formId + '|' + target.plugin).toLowerCase();
      N._closeSheet();
      return landed;
    });
    if (usedStub) {
      delete PLUGINS[stub.id];
      delete SUB_LABEL[stub.id];
      SUBS.splice(SUBS.indexOf(stub.id), 1);
    }
    ui.sub = 'npcs';

    /* ============================================ typeable outfit picker == *
       Rober: "setting an outfit for an npc in wardrobe should be a typable
       search bar". Everything below is asked of the SHEET, because that is
       where the four pickers live and where a field that eats a keystroke or
       loses its caret would actually cost him an assignment. */
    devBoot(); setSub('npcs');
    ui.combo = null;
    const lyd = state.npcs[1];                      // Lydia — mode 'outfit'
    ensureAssign(lyd).mode = 'outfit';
    ensureAssign(lyd).outfit = 'Travelling Leathers';
    openSheet(lyd);

    const cField = () => document.querySelector('#wd-sheet-body .wd-combo');
    const cBtn = () => document.querySelector('#wd-sheet-body .wd-combo-btn');
    const cInput = () => document.querySelector('#wd-sheet-body .wd-combo-input');
    const cRows = () => document.querySelectorAll('#wd-sheet-body .wd-combo.open .wd-combo-list .wd-pick');
    const type = (s) => { const i = cInput(); i.value = s; i.dispatchEvent(new Event('input')); };
    const key = (k) => {
      const i = cInput() || cBtn();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    };

    T('no native <select> is left anywhere in the sheet',
      () => document.querySelectorAll('#wd-sheet-body select').length === 0);
    T('the outfit field is a combobox', () => !!cField());
    T('shut, it shows the assigned outfit',
      () => cField().querySelector('.wd-combo-v').textContent === 'Travelling Leathers');
    T('shut, it is a real button — reachable by Tab, not a div',
      () => cBtn().tagName === 'BUTTON' && cBtn().getAttribute('aria-haspopup') === 'listbox');
    T('an unassigned field says so instead of going blank', () => {
      ensureAssign(lyd).outfit = ''; render();
      const v = cField().querySelector('.wd-combo-v');
      const ok = v.textContent.indexOf('pick an outfit') !== -1 && cBtn().classList.contains('empty');
      ensureAssign(lyd).outfit = 'Travelling Leathers'; render();
      return ok;
    });

    cBtn().click();
    T('clicking opens the list', () => !!cInput() && cRows().length > 0);
    T('open, every outfit in the catalogue is offered',
      () => cRows().length === state.soes.outfits.length);
    T('the assigned one is ticked',
      () => document.querySelectorAll('#wd-sheet-body .wd-combo-list .wd-pick.in').length === 1);
    T('the keyboard cursor starts ON the assigned one', () => {
      const kb = document.querySelector('#wd-sheet-body .wd-combo-list .wd-pick.kb');
      return kb && kb.textContent.indexOf('Travelling Leathers') !== -1;
    });
    T('the list is IN FLOW, so the scrolling sheet cannot clip it', () => {
      const l = document.querySelector('#wd-sheet-body .wd-combo-list');
      const p = l ? getComputedStyle(l).position : '';
      /* relative is fine and is what it is (offsetTop of the ↑↓ row is read
         against it) — what must never be true is that it floats out of flow */
      return l && l.offsetParent !== null && p !== 'absolute' && p !== 'fixed';
    });

    /* --- live filtering --- */
    /* The real open focuses the field on a 0ms timer; a synchronous selftest
       never lets that fire, so stand in for it — the caret assertions below
       are the whole point of this widget keeping its state in `ui`. */
    cInput().focus();
    type('gown');
    T('a keystroke does NOT re-filter synchronously — it is debounced',
      () => cRows().length === state.soes.outfits.length);
    render();                                        // stand in for the timer
    T('typing narrows the list', () => cRows().length === 1);
    T('the typed text and the focus survive the re-render it triggers',
      () => cInput().value === 'gown' && document.activeElement === cInput());
    T('the match is highlighted, not just filtered', () => {
      const m = document.querySelector('#wd-sheet-body .wd-combo-list .wd-pick-n mark');
      return m && m.textContent === 'Gown';
    });
    type('GOWN'); render();
    T('filtering is case-insensitive', () => cRows().length === 1);
    type('zzzz'); render();
    T('no match says so rather than showing an empty box',
      () => cRows().length === 0 &&
        document.querySelector('#wd-sheet-body .wd-combo-list .wd-col-empty').textContent.indexOf('zzzz') !== -1);
    type(''); render();
    T('clearing the query brings the whole list back',
      () => cRows().length === state.soes.outfits.length);

    /* --- keys --- */
    ui.combo.idx = 0; render();
    key('ArrowDown');
    T('ArrowDown moves the cursor', () => ui.combo.idx === 1);
    key('ArrowUp'); key('ArrowUp');
    T('ArrowUp clamps at the top instead of wrapping', () => ui.combo.idx === 0);
    key('End');
    T('End jumps to the last row', () => ui.combo.idx === state.soes.outfits.length - 1);
    key('Home');
    T('Home jumps back to the first', () => ui.combo.idx === 0);
    type('bath'); render(); key('Enter');
    T('Enter takes the highlighted row', () => ensureAssign(lyd).outfit === 'Bath Robe');
    T('taking one closes the list', () => ui.combo === null && !cInput());
    T('and the field now shows it',
      () => cField().querySelector('.wd-combo-v').textContent === 'Bath Robe');

    cBtn().click(); type('snow'); render();
    key('Escape');
    T('Esc closes the list', () => ui.combo === null);
    T('Esc leaves the value alone', () => ensureAssign(lyd).outfit === 'Bath Robe');
    T('…and does NOT close the sheet underneath it', () => !!ui.sheetKey);

    /* --- type straight off the shut field --- */
    key('b');
    T('typing on the shut field opens it seeded with that character',
      () => !!ui.combo && ui.combo.q === 'b');
    comboClose(false);
    key('ArrowDown');
    T('ArrowDown on the shut field opens it', () => !!ui.combo && ui.combo.q === '');
    comboClose(false);

    /* --- clearing --- */
    T('a set field offers a clear', () => !!document.querySelector('#wd-sheet-body .wd-combo-clear'));
    document.querySelector('#wd-sheet-body .wd-combo-clear').click();
    T('clearing blanks the assignment', () => ensureAssign(lyd).outfit === '');
    T('a blank field offers no clear',
      () => !document.querySelector('#wd-sheet-body .wd-combo-clear'));
    ensureAssign(lyd).outfit = 'Travelling Leathers'; render();

    /* --- built for growth --- */
    T('a big catalogue is capped, and says how much is left', () => {
      const keep = state.soes.outfits, keepOutfit = ensureAssign(lyd).outfit;
      const many = [];
      for (let i = 0; i < 240; i++) many.push({ name: 'Outfit ' + i, items: 2 });
      state.soes.outfits = many;
      ensureAssign(lyd).outfit = 'Outfit 5';    // in the fake catalogue: exactly 240 options
      render();
      cBtn().click();
      const capped = cRows().length === COMBO_MAX;
      const more = document.querySelector('#wd-sheet-body .wd-combo-more');
      const said = !!more && more.textContent.indexOf(String(240 - COMBO_MAX)) !== -1;
      comboClose(false);
      state.soes.outfits = keep;
      ensureAssign(lyd).outfit = keepOutfit;
      render();
      return capped && said;
    });
    closeSheet();

    /* --- the wardrobe field gets the same treatment --- */
    const cam = state.npcs[0];                       // Camilla — mode 'wardrobe'
    openSheet(cam);
    T('the wardrobe field is a combobox too',
      () => !!cField() && document.querySelectorAll('#wd-sheet-body select').length === 0);
    T('it shows the assigned wardrobe',
      () => cField().querySelector('.wd-combo-v').textContent === 'Evening Wear');
    T('a wardrobe row carries its colour and its size', () => {
      cBtn().click();
      const row = document.querySelector('#wd-sheet-body .wd-combo-list .wd-pick');
      const ok = !!row.querySelector('.wd-swatch') &&
        row.textContent.indexOf('outfit') !== -1;
      comboClose(false);
      return ok;
    });
    T('a deleted wardrobe id is kept and flagged, never silently dropped', () => {
      const a = ensureAssign(cam), keep = a.wardrobeId;
      a.wardrobeId = 'gone'; render();
      const ok = /no longer exists/.test(cField().textContent);
      a.wardrobeId = keep; render();
      return ok;
    });
    T('the location field refuses to be cleared — "" would mean World (base)', () => {
      const row = document.querySelector('#wd-sheet-body .wd-loc-row');
      return row && !row.querySelector('.wd-combo:first-child .wd-combo-clear');
    });
    T('an override row carries exactly ONE ✕, the one that removes it', () => {
      const row = document.querySelector('#wd-sheet-body .wd-loc-row');
      return row && row.querySelectorAll('.wd-combo-clear').length === 0 &&
        row.querySelectorAll('.wd-loc-del').length === 1;
    });
    closeSheet();

    /* ============================================== whole-tab scale ======= *
       Rober: "i have no way of upscaling or resizing font like other windows". */
    const scaleVar = () => document.documentElement.style.getPropertyValue('--wd-ui-scale');
    state.settings.uiScale = 1; applyUiScale();
    T('the scale box exists and is what carries the transform', () => {
      const b = $('wd-scale');
      return !!b && getComputedStyle(b).transform !== undefined;
    });
    /* At 160% in a 640px panel the sub-tab row needs more width than the pane
       has, and #wd-pane CLIPS — the last two tabs became unreachable, not just
       ugly. Wrapping is what makes the scaler safe at the small end. */
    T('the sub-tab row wraps, so scaling up can never hide a tab',
      () => getComputedStyle($('wd-nav')).flexWrap === 'wrap');
    T('the scale control lives in edit mode, not in the way', () => {
      ui.editing = false; render();
      const hidden = $('wd-editrow').classList.contains('hidden');
      ui.editing = true; render();
      return hidden && !$('wd-editrow').classList.contains('hidden');
    });
    T('it starts at 100%', () => curUi() === 1 && $('wd-ui-val').textContent === '100%');
    nudgeUi(-UI_STEP);
    T('minus steps down by one step', () => curUi() === 0.9 && $('wd-ui-val').textContent === '90%');
    T('the step drives the custom property the CSS reads', () => scaleVar() === '0.9');
    for (let i = 0; i < 12; i++) nudgeUi(-UI_STEP);
    T('it clamps at the floor', () => curUi() === UI_MIN);
    T('the spent button says so rather than looking live',
      () => $('wd-ui-dec').disabled && $('wd-ui-dec').classList.contains('is-off'));
    for (let i = 0; i < 24; i++) nudgeUi(+UI_STEP);
    T('it clamps at the ceiling', () => curUi() === UI_MAX);
    T('repeated steps never drift off the step grid',
      () => Math.abs(curUi() * 10 - Math.round(curUi() * 10)) < 1e-9);
    nudgeUi(0);
    T('Reset returns to 100%', () => curUi() === 1 && scaleVar() === '1');
    T('Reset then disables itself', () => $('wd-ui-reset').disabled);
    T('the scale is stored where the slice is saved from', () => {
      nudgeUi(-UI_STEP);
      return state.settings.uiScale === 0.9;
    });
    T('a nonsense stored scale falls back to 100% instead of a 40x tab',
      () => clampUi('banana') === 1 && clampUi(0) === 1 && clampUi(99) === UI_MAX);
    T('a saved scale comes back from C++', () => {
      receive('wdOpen', JSON.stringify({
        categories: [], outfitMeta: [], wardrobes: [], assignments: [],
        settings: { enabled: true, notify: true, uiScale: 1.3 },
        soes: { available: true, outfits: [] }, npcs: [],
      }));
      return curUi() === 1.3 && scaleVar() === '1.3';
    });
    T('a payload with no scale at all reads as 100%', () => {
      receive('wdOpen', JSON.stringify({
        categories: [], outfitMeta: [], wardrobes: [], assignments: [],
        settings: {}, soes: { available: true, outfits: [] }, npcs: [],
      }));
      return curUi() === 1;
    });
    ui.editing = false;
    state.settings.uiScale = 1; applyUiScale();

    /* --- outfit photo crop (WYSIWYG framing) --- */
    devBoot(); setSub('outfits');
    const CROPPED = 'wd-sfancy-blue.png';       // devBoot gives this one a crop
    const artOf = (card) => card && card.querySelector('.wd-thumb .wd-art');
    /* [translateX%, translateY%, scale] off an element's inline transform. */
    const tfNums = (el) => (String((el && el.style.transform) || '').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const cardNamed = (nm) => Array.prototype.find.call(q('#wd-list .wd-card'),
      (c) => c.querySelector('.wd-card-name').textContent.indexOf(nm) === 0);

    T('the crop key is the bare file name — no folder, no cache-buster',
      () => WardrobePane._crop.keyOf('icons/custom/wd-x.png?v=17300') === 'wd-x.png' &&
            WardrobePane._crop.keyOf('wd-x.png') === 'wd-x.png');
    T('nothing that could name a non-sibling survives as a key',
      () => !WardrobePane._crop.keyOf('') && !WardrobePane._crop.keyOf('..') &&
            !WardrobePane._crop.keyOf('a/../..') && !WardrobePane._crop.keyOf('C:x.png'));

    T('a photographed outfit draws through an art LAYER, not the tile',
      () => !!artOf(cardNamed('Sfancy Blue')) &&
            artOf(cardNamed('Sfancy Blue')).style.backgroundImage.indexOf('wd-sfancy-blue') !== -1);
    T('the tile itself carries no transform — a scaled tile would grow the grid',
      () => !cardNamed('Sfancy Blue').querySelector('.wd-thumb').style.transform);
    T('the stored crop is painted on the card', () => {
      /* Read the NUMBERS, not the formatted string: every engine re-serialises
         a transform its own way (Chrome drops our trailing zeros, Ultralight
         need not), and a test that matches text would pass here and lie there. */
      const n = tfNums(artOf(cardNamed('Sfancy Blue')));
      return n.length === 3 && n[0] === 10 && n[1] === -20 && n[2] === 1.5;
    });
    T('a photo the map has never seen draws as shot — this is what makes double-cropping impossible',
      () => !artOf(cardNamed('Cosplay Gala')).style.transform);
    T('an un-photographed outfit still shows its placeholder, no empty layer',
      () => !artOf(cardNamed('Solitude Court')) &&
            !!cardNamed('Solitude Court').querySelector('.wd-thumb-ph'));
    T('the ⛶ way-in appears only on a card that HAS a photo',
      () => !!cardNamed('Sfancy Blue').querySelector('.wd-crop') &&
            !cardNamed('Solitude Court').querySelector('.wd-crop'));

    /* every OTHER draw site — the same crop, or the bug is "it works on the card only" */
    setSub('wardrobes');
    const anyCropped = (nodes) => Array.prototype.some.call(nodes,
      (a) => tfNums(a)[2] === 1.5);
    T('the wardrobe card lead thumb is cropped too',
      () => anyCropped(q('#wd-list .wd-card .wd-thumb .wd-art')));
    T('the wardrobe strip tiles are cropped too',
      () => anyCropped(q('#wd-list .wd-strip-i .wd-art')));
    openBuilder('w1');
    T('the builder member row is cropped',
      () => anyCropped(els.members.querySelectorAll('.wd-pick-t .wd-art')));
    T('the builder catalogue chip is cropped',
      () => anyCropped(els.catalogue.querySelectorAll('.wd-pick-t .wd-art')));
    closeBuilder();
    setSub('outfits');

    /* the clamp — the invariant that keeps the well behind the photo hidden */
    T('zoom 1 permits no pan at all', () => WardrobePane._crop.clamp({ z: 1, x: .4, y: -.4 }) === null);
    T('pan is clamped to the slack the zoom created', () => {
      const c = WardrobePane._crop.clamp({ z: 2, x: 9, y: -9 });
      return c.x === 0.5 && c.y === -0.5;
    });
    T('zoom is clamped to its ceiling', () => WardrobePane._crop.clamp({ z: 99, x: 0, y: 0 }).z === WardrobePane._crop.ZMAX);
    T('garbage in is an identity crop, never NaN on screen',
      () => WardrobePane._crop.clamp({ z: 'banana', x: null, y: undefined }) === null &&
            WardrobePane._crop.clamp(null) === null && WardrobePane._crop.clamp('x') === null);
    T('an identity crop is not stored — the map holds only real re-framings',
      () => WardrobePane._crop.clamp({ z: 1, x: 0, y: 0 }) === null);

    /* C++ -> view: the map replaces, and is scrubbed on the way in */
    T('a pushed map replaces the old one wholesale (a prune must be able to REMOVE)', () => {
      receive('wdCrops', JSON.stringify({ crops: { 'wd-cosplay-gala.png': { z: 2, x: 0, y: 0 } } }));
      return !state.imageCrops[CROPPED] && !!state.imageCrops['wd-cosplay-gala.png'];
    });
    T('a pushed path-shaped key is dropped rather than trusted', () => {
      receive('wdCrops', JSON.stringify({ crops: { 'icons/custom/wd-x.png': { z: 2, x: 0, y: 0 } } }));
      return Object.keys(state.imageCrops).length === 0;
    });
    T('a pushed crop is clamped by THIS side too — hotkeys.json is hand-editable', () => {
      receive('wdCrops', JSON.stringify({ crops: { 'wd-x.png': { z: 2, x: 4, y: -4 } } }));
      return state.imageCrops['wd-x.png'].x === 0.5 && state.imageCrops['wd-x.png'].y === -0.5;
    });
    T('wdOpen carries the map, and a payload without one keeps what we have', () => {
      const base = { categories: [], outfitMeta: [], wardrobes: [], assignments: [],
        settings: {}, soes: { available: true, outfits: [] }, npcs: [] };
      receive('wdOpen', JSON.stringify(Object.assign({ imageCrops: { 'wd-a.png': { z: 3, x: 0, y: 0 } } }, base)));
      const got = !!state.imageCrops['wd-a.png'];
      receive('wdOpen', JSON.stringify(base));
      return got && !!state.imageCrops['wd-a.png'];
    });

    /* the editor itself */
    devBoot(); setSub('outfits');
    let cropSent = null;
    const realCropSave = window.wdCropSave;
    window.wdCropSave = (p) => { cropSent = JSON.parse(p); };

    WardrobePane._crop.open('Sfancy Blue', 'icons/custom/' + CROPPED + '?v=1', false);
    T('the big view opens on document.body, outside the tab-scale transform',
      () => !!WardrobePane._crop.box() && WardrobePane._crop.box().parentNode === document.body);
    T('it opens NOT editing, with the current framing spelled out',
      () => !WardrobePane._crop.edit() &&
            WardrobePane._crop.box().querySelector('.wd-art-val').textContent.indexOf('150%') === 0);
    T('the frame is 3:4 — the same letterbox the card gives the photo', () => {
      const f = WardrobePane._crop.box().querySelector('.wd-art-frame');
      return Math.abs(parseFloat(f.style.width) / parseFloat(f.style.height) - 0.75) < 0.02;
    });
    T('the big view shows the SAME crop the card does',
      () => tfNums(WardrobePane._crop.box().querySelector('.wd-art'))[2] === 1.5);

    WardrobePane._crop.box().querySelector('.wd-art-btn').click();   // ✎ Adjust
    T('Adjust arms the editor and its six-key pad', () => !!WardrobePane._crop.edit() &&
      WardrobePane._crop.box().querySelectorAll('.wd-art-pad .wd-art-btn').length === 6);
    T('the frame says it is editable', () =>
      WardrobePane._crop.box().querySelector('.wd-art-frame').classList.contains('editing'));

    const zBefore = WardrobePane._crop.edit().z;
    WardrobePane._crop.key({ key: '+' });
    T('+ zooms in by exactly one step',
      () => Math.abs(WardrobePane._crop.edit().z - zBefore * WardrobePane._crop.ZSTEP) < 1e-9);
    WardrobePane._crop.key({ key: 'ArrowUp' });
    T('an arrow pans by one step', () => Math.abs(
      WardrobePane._crop.edit().y - (-0.2 - WardrobePane._crop.PAN_STEP)) < 1e-9);
    T('the readout tracks the edit live, without a re-render',
      () => WardrobePane._crop.box().querySelector('.wd-art-val').textContent.indexOf('%') !== -1);

    WardrobePane._crop.key({ key: 'Escape' });
    T('Esc leaves the stored framing untouched',
      () => !WardrobePane._crop.edit() && state.imageCrops[CROPPED].z === 1.5 && cropSent === null);
    T('and it leaves the big view up rather than tearing everything down',
      () => !!WardrobePane._crop.box());

    WardrobePane._crop.box().querySelector('.wd-art-btn').click();   // ✎ Adjust again
    WardrobePane._crop.key({ key: '+' });
    WardrobePane._crop.key({ key: 'Enter' });
    T('Enter saves, and the payload is keyed by the FILE, not the outfit',
      () => cropSent && cropSent.file === CROPPED && !cropSent.clear);
    T('the saved crop is what the card now draws', () => {
      setSub('outfits');
      return Math.abs(tfNums(artOf(cardNamed('Sfancy Blue')))[2] - 1.725) < 1e-9;
    });

    WardrobePane._crop.open('Sfancy Blue', 'icons/custom/' + CROPPED, true);
    T('the menu route opens straight in edit mode', () => !!WardrobePane._crop.edit());
    WardrobePane._crop.box().querySelector('.wd-art-reset').click();
    WardrobePane._crop.key({ key: 'Enter' });
    T('Reset + save sends an explicit clear, never a z=1 row',
      () => cropSent.clear === true && !state.imageCrops[CROPPED]);

    WardrobePane._crop.open('Sfancy Blue', 'icons/custom/' + CROPPED, false);
    onHide();
    T('leaving the tab takes the overlay with it — a stray overlay eats every click',
      () => WardrobePane._crop.box() === null);
    ui.shown = true;
    els.pane.classList.remove('hidden');   // onHide() above hid it
    window.wdCropSave = realCropSave;

    /* restore the dev fixture so the page stays clickable after a selftest */
    state.portraits = {};
    sheetFaceSrc = null;
    devBoot(); setSub('outfits');

    /* ---- tile size (hd-scale.js) ------------------------------------- *
     *  The Wardrobe already had a whole-tab scale; what it had no control
     *  over was the ART, which is the reason to look at this tab at all.
     *  "Tile size" is the grid COLUMN, because .wd-thumb is width:100% with a
     *  3/4 aspect inside the card — widen the column and the picture grows.
     *  The overflow guard is the part worth asserting: a 320px tile asked for
     *  inside a 240px list must fall back to one column, not push a
     *  horizontal scrollbar across the pane.                              */
    if (window.HDScale) {
      const cols = () => getComputedStyle(els.list).gridTemplateColumns.split(' ').length;
      T('tile size mounts beside the tab-size control, in the same edit strip', () => {
        const host = document.getElementById('wd-img-row');
        return !!host && host.parentElement.id === 'wd-editrow' &&
               !!host.querySelector('[data-hds-out="img"]');
      });
      T('the wardrobe row is image-only — its tab scale is its own control', () => {
        const host = document.getElementById('wd-img-row');
        return !!host && !host.querySelector('[data-hds-out="ui"]');
      });
      T('a bigger tile means fewer, wider columns', () => {
        setSub('outfits');
        HDScale.set('wardrobe', 'img', 110); const many = cols();
        HDScale.set('wardrobe', 'img', 320); const few = cols();
        HDScale.nudge('wardrobe', 'img', 0);
        return many > few;
      });
      T('a tile wider than the list falls back to one column, never overflows', () => {
        HDScale.set('wardrobe', 'img', HDScale.SPEC.wardrobe.img.max);
        const overflow = els.list.scrollWidth > els.list.clientWidth + 1;
        HDScale.nudge('wardrobe', 'img', 0);
        return !overflow;
      });
      T('reset returns the grid to the stylesheet default', () => {
        const before = getComputedStyle(els.list).gridTemplateColumns;
        HDScale.set('wardrobe', 'img', 260);
        const changed = getComputedStyle(els.list).gridTemplateColumns !== before;
        HDScale.nudge('wardrobe', 'img', 0);
        return changed &&
               document.documentElement.style.getPropertyValue('--hdti-wardrobe') === '' &&
               getComputedStyle(els.list).gridTemplateColumns === before;
      });
    }

    /* ---- variants, duplicates, and the searchable category picker ------- *
     *  Rober, 2026-08-03: "add ability to duplicate as well" and "the right
     *  click categories is going to need to be a searchable field ... as soon
     *  as i get a lot of categories this is going to balloon". The three verbs
     *  share ONE mechanism (read the pieces, build a subset) and ONE overlay
     *  picker, so these checks are as much about that as about the buttons.  */
    setSub('outfits');
    closeCtxPicker();
    const menuLabels = () => Array.prototype.map.call(
      document.querySelectorAll('#wd-menu .wd-menu-i'), (b) => b.textContent);
    const fakeEv = { clientX: 120, clientY: 120, preventDefault() {}, stopPropagation() {} };

    outfitMenu(fakeEv, 'Sfancy Blue');
    T('the ⋯ menu offers Duplicate and Make variant', () => {
      const L = menuLabels().join('|');
      return L.indexOf('Duplicate') !== -1 && L.indexOf('Make variant') !== -1;
    });
    T('categories collapsed to ONE searchable entry — no inline category rows', () => {
      const L = menuLabels();
      const hasEntry = L.some((x) => x.indexOf('Categories') !== -1);
      /* the seeded fixture has Evening / Practical / Court; none may be a row */
      const inline = L.filter((x) => state.categories.some(
        (c) => x.replace(/^[^A-Za-z0-9]+/, '').trim() === c.name)).length;
      return hasEntry && inline === 0;
    });
    T('every new menu row carries hover text', () => {
      const want = ['Duplicate', 'Make variant', 'Categories'];
      return want.every((w) => Array.prototype.some.call(
        document.querySelectorAll('#wd-menu .wd-menu-i'),
        (b) => b.textContent.indexOf(w) !== -1 && !!b.title));
    });
    hideMenu();

    /* --- the picker lives on the OVERLAY, not in the clipped pane --------- */
    openCategoryPicker({ left: 100, right: 440, top: 100, bottom: 100 }, 'Sfancy Blue');
    T('the picker mounts on #overlay, never inside overflow-hidden #wd-pane', () => {
      const m = document.getElementById('wd-catpick');
      return !!m && m.parentElement.id === 'overlay' && !els.pane.contains(m);
    });
    T('the picker is really painted, not a hidden pass', () => {
      /* offsetParent is null for ANY position:fixed element, so it cannot be the
         visibility test here — measure the box and ask the cascade instead. */
      const m = document.getElementById('wd-catpick');
      if (!m) return false;
      const cs = getComputedStyle(m);
      const r = m.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' &&
             parseFloat(cs.opacity) > 0 && r.width > 40 && r.height > 40;
    });
    T('the picker opens with a typeable filter focused-able at the top', () => {
      const f = document.querySelector('#wd-catpick .fd-ctx-filter');
      return !!f && f.tagName === 'INPUT';
    });
    T('nothing in the picker is under 13px', () => {
      const els2 = document.querySelectorAll('#wd-catpick .fd-ctx-item, #wd-catpick .fd-ctx-head,'
        + ' #wd-catpick .fd-ctx-filter, #wd-catpick .wd-pick-note, #wd-catpick .wd-pick-go');
      return els2.length > 0 && Array.prototype.every.call(els2,
        (n) => parseFloat(getComputedStyle(n).fontSize) >= 13 - 0.01);
    });
    T('every picker row has hover text', () => {
      const rows = document.querySelectorAll('#wd-catpick .fd-ctx-item');
      return rows.length > 0 && Array.prototype.every.call(rows, (b) => !!b.title);
    });

    const catsOf = (n) => (ensureMeta(n).categoryIds || []).slice();
    const pickCatsBefore = catsOf('Sfancy Blue');
    T('toggling a category does NOT close the picker (multi-select)', () => {
      const rows = document.querySelectorAll('#wd-catpick .fd-ctx-item');
      rows[rows.length - 1].click();
      return !!document.getElementById('wd-catpick');
    });
    T('…and the toggle actually landed on the outfit', () =>
      catsOf('Sfancy Blue').length !== pickCatsBefore.length);
    T('a second click on the same row toggles it back', () => {
      const rows = document.querySelectorAll('#wd-catpick .fd-ctx-item');
      rows[rows.length - 1].click();
      return catsOf('Sfancy Blue').length === pickCatsBefore.length;
    });

    T('typing an unknown name offers ＋ Create, and it creates + files', () => {
      const f = document.querySelector('#wd-catpick .fd-ctx-filter');
      f.value = 'Winterhold Formal';
      f.dispatchEvent(new Event('input'));
      const mk = document.querySelector('#wd-catpick .wd-pick-new');
      if (!mk) return false;
      const nCats = state.categories.length;
      mk.click();
      const made = state.categories[state.categories.length - 1];
      return state.categories.length === nCats + 1 &&
             made.name === 'Winterhold Formal' &&
             catsOf('Sfancy Blue').indexOf(made.id) !== -1;
    });
    T('an EXACT match offers no duplicate-create row', () => {
      const f = document.querySelector('#wd-catpick .fd-ctx-filter');
      f.value = 'Winterhold Formal';
      f.dispatchEvent(new Event('input'));
      return !document.querySelector('#wd-catpick .wd-pick-new');
    });
    T('Escape closes the picker', () => {
      const f = document.querySelector('#wd-catpick .fd-ctx-filter');
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return !document.getElementById('wd-catpick');
    });
    /* undo the fixture edits this block made */
    state.categories = state.categories.filter((c) => c.name !== 'Winterhold Formal');
    ensureMeta('Sfancy Blue').categoryIds = pickCatsBefore;

    /* --- name collisions -------------------------------------------------- */
    T('a free name is used as-is', () => uniqueOutfitName('Totally New Thing') === 'Totally New Thing');
    T('a taken name suffixes, case-insensitively', () => {
      const taken = soesNames()[0];
      return uniqueOutfitName(taken) === taken + ' 2' &&
             uniqueOutfitName(taken.toUpperCase()) === taken.toUpperCase() + ' 2';
    });
    T('collision checks the VISIBLE list, so a deck-only meta row also counts', () => {
      ensureMeta('Ghosty McGhost copy');
      const got = uniqueOutfitName('Ghosty McGhost copy');
      state.outfitMeta = state.outfitMeta.filter((m) => m.name !== 'Ghosty McGhost copy');
      return got === 'Ghosty McGhost copy 2';
    });

    /* --- Duplicate: full piece list, metadata carried, photo NOT ---------- */
    const PIECES = [
      { name: 'Steel Helmet', slot: 'Head', formId: '0x1301', plugin: 'Skyrim.esm' },
      { name: 'Circlet of Ice', slot: 'Circlet', formId: '0x1302', plugin: 'Skyrim.esm' },
      { name: 'Fine Cuirass', slot: 'Body', formId: '0x1303', plugin: 'Skyrim.esm' },
      { name: 'Boots', slot: 'Feet', formId: '0x1304', plugin: 'Skyrim.esm' },
      { name: 'Lost Thing', slot: 'Body', formId: '0x1305', plugin: 'Gone.esp', missing: true },
    ];
    const srcMeta = ensureMeta('Sfancy Blue');
    srcMeta.note = 'her favourite'; srcMeta.categoryIds = ['c1', 'c3'];
    srcMeta.image = 'icons/custom/wd-sfancy-blue.png';

    const realBuild2 = window.wdBuild;
    let built = null;
    window.wdBuild = (pl) => { built = JSON.parse(pl); };

    requestPieces('Sfancy Blue', 'dup', { left: 10, right: 350, top: 10, bottom: 10 });
    T('Duplicate asks C++ for the source pieces first', () =>
      !!ui.variantReq && ui.variantReq.mode === 'dup');
    receive('wdPieceList', JSON.stringify({ ok: true, name: 'Sfancy Blue', items: PIECES }));
    T('Duplicate builds a real outfit with the FULL usable piece list', () =>
      !!built && built.items.length === 4);
    T('…named "<name> copy", collide-safe', () => built.name === 'Sfancy Blue copy');
    T('…and it drops the piece whose plugin is gone rather than sending a dud', () =>
      built.items.every((i) => i.formId !== '0x1305'));
    T('Duplicate carries categories and the note', () => {
      const d = ensureMeta('Sfancy Blue copy');
      return d.note === 'her favourite' &&
             d.categoryIds.join(',') === 'c1,c3' &&
             d.categoryIds !== srcMeta.categoryIds;   // a COPY, not the same array
    });
    T('Duplicate does NOT carry the photo — crops are keyed by image file', () =>
      !ensureMeta('Sfancy Blue copy').image);
    T('Duplicate does not inherit the favourite star', () =>
      ensureMeta('Sfancy Blue copy').fav === false);
    T('the Pieces… sheet was NOT clobbered by the duplicate reply', () => !ui.pieces);

    /* --- Make variant: the picker, the preset, the default name ----------- */
    built = null;
    requestPieces('Sfancy Blue', 'variant', { left: 10, right: 350, top: 10, bottom: 10 });
    receive('wdPieceList', JSON.stringify({ ok: true, name: 'Sfancy Blue', items: PIECES }));
    T('Make variant opens the picker rather than building blind', () =>
      !!document.getElementById('wd-catpick') && built === null);
    T('the variant picker lists every piece plus the presets', () =>
      document.querySelectorAll('#wd-catpick .fd-ctx-item').length >= PIECES.length + 2);
    T('a piece whose plugin is gone is disabled, not silently checked', () => {
      const rows = document.querySelectorAll('#wd-catpick .fd-ctx-item');
      return Array.prototype.some.call(rows,
        (b) => b.textContent.indexOf('Lost Thing') !== -1 && b.disabled);
    });
    T('the "No helmet" preset unchecks Head/Hair/Circlet and nothing else', () => {
      const rows = Array.prototype.slice.call(document.querySelectorAll('#wd-catpick .fd-ctx-item'));
      const helm = rows.find((b) => b.textContent.indexOf('No helmet') !== -1);
      if (!helm) return false;
      helm.click();
      const after = Array.prototype.slice.call(document.querySelectorAll('#wd-catpick .fd-ctx-item'));
      const on = (nm) => {
        const r = after.find((b) => b.textContent.indexOf(nm) !== -1);
        return r && r.classList.contains('on');
      };
      return !on('Steel Helmet') && !on('Circlet of Ice') && on('Fine Cuirass') && on('Boots');
    });
    T('dropping only headgear names it "(no helmet)" by itself', () => {
      const go = document.querySelector('#wd-catpick .wd-pick-go');
      return !!go && go.title.indexOf('(no helmet)') !== -1;
    });
    T('the footer counts what survives', () => {
      const note = document.querySelector('#wd-catpick .wd-pick-note');
      return !!note && note.textContent.indexOf('2 of 5') !== -1;
    });
    T('Create variant builds it, headgear excluded', () => {
      document.querySelector('#wd-catpick .wd-pick-go').click();
      return !!built && built.name === 'Sfancy Blue (no helmet)' &&
             built.items.length === 2 &&
             built.items.every((i) => i.formId !== '0x1301' && i.formId !== '0x1302');
    });
    T('creating the variant closed the picker', () => !document.getElementById('wd-catpick'));
    T('the variant carries the source note and categories too', () => {
      const d = ensureMeta('Sfancy Blue (no helmet)');
      return d.note === 'her favourite' && d.categoryIds.join(',') === 'c1,c3' && !d.image;
    });
    T('an empty source is refused with a message, not an empty outfit', () => {
      built = null;
      requestPieces('Sfancy Blue', 'dup', { left: 10, right: 350, top: 10, bottom: 10 });
      receive('wdPieceList', JSON.stringify({ ok: true, name: 'Sfancy Blue', items: [] }));
      return built === null && !ui.variantReq;
    });
    T('a reply for a DIFFERENT outfit falls through to the Pieces sheet', () => {
      requestPieces('Sfancy Blue', 'variant', { left: 10, right: 350, top: 10, bottom: 10 });
      receive('wdPieceList', JSON.stringify({ ok: true, name: 'Wedding White', items: PIECES }));
      const wentToSheet = !!ui.pieces && ui.pieces.name === 'Wedding White';
      ui.variantReq = null; closePieces();
      return wentToSheet;
    });

    window.wdBuild = realBuild2;
    state.outfitMeta = state.outfitMeta.filter((m) =>
      m.name !== 'Sfancy Blue copy' && m.name !== 'Sfancy Blue (no helmet)');
    closeCtxPicker();
    devBoot(); setSub('outfits');

    const pass = results.filter((r) => r.pass).length;
    const out = { pass: pass, total: results.length, results: results };
    window.__wdSelftest = out;
    if (!window.__selftest) window.__selftest = out;
    console.log('[wardrobe selftest] ' + pass + '/' + results.length, results.filter((r) => !r.pass));
    return out;
  }

  /* ---- Omni search provider (universal search, v0.14.0) ---------------- *
   * Outfits (SOES + our metadata, deduped by name), wardrobes, and every
   * dressed NPC assignment. warm() pulls the slice on omni-open because
   * wardrobe data otherwise only arrives the first time the tab is shown.
   * setFilter guards on els.search: the pane lazily init()s on first show,
   * so a jump from omni may be the thing that initialises it. */
  if (window.HDOmni) HDOmni.register({
    id: 'wardrobe', label: 'Wardrobe', tab: 'wardrobe',
    warm: function () { toGame('wdGet', ''); },
    setFilter: function (q) {
      ui.filter = String(q || '').trim();
      if (els.search) els.search.value = ui.filter;
      try { resetPaging(); render(); } catch (e) {}
    },
    index: function () {
      const items = [];
      const seen = {};
      const outfit = (name, detail) => {
        if (!name || seen[name]) return;
        seen[name] = true;
        /* names are SOES's own identity for outfits — what wdWear takes */
        items.push({ label: name, detail: detail || '', kind: 'outfit', pin: 'wd:o:' + name });
      };
      ((state.soes && state.soes.outfits) || []).forEach((o) => {
        const n = Array.isArray(o.items) ? o.items.length : (o.items >>> 0);
        outfit(o.name, n ? n + ' pieces' : '');
      });
      (state.outfitMeta || []).forEach((o) => outfit(o.name, o.note || ''));
      (state.wardrobes || []).forEach((w) => {
        items.push({
          label: w.name || '(unnamed wardrobe)',
          detail: (w.outfits || []).slice(0, 4).join(', ') +
                  ((w.outfits || []).length > 4 ? ' …' : ''),
          kind: 'wardrobe',
          keywords: (w.outfits || []).join(' ') + ' ' + (w.note || ''),
          pin: 'wd:w:' + (w.name || ''),
        });
      });
      (state.assignments || []).forEach((a) => {
        items.push({
          label: a.name || '(npc)',
          detail: ['dressed', a.mode, a.outfit].filter(Boolean).join(' · '),
          kind: 'dressed npc',
          keywords: a.outfit || '',
          pin: 'wd:a:' + (a.name || ''),
        });
      });
      return items;
    },
  });

  /* Build a brand-new Wardrobe outfit from an arbitrary list of items — the
     F7 quick card's "Copy outfit" feature (Rober, 2026-08-05): read what an NPC
     is wearing, let the player tick which pieces to keep, then mint a Wardrobe
     outfit from the survivors. It reuses the SAME wdBuild path the Duplicate /
     Variant flows use (buildFromPieces), so a copied outfit is indistinguishable
     from one built any other way and the same SOES-NG executor consumes it.

     `items` is the worn set as fdEquipped delivers it — each entry carries
     `formId` (hex local id, the SAME HexOf(LocalIdOf) the wardrobe worn-list
     emits) and `plugin`, which is exactly what wdBuild resolves against; `name`
     rides along only for the toast. Non-armour worn items (a torch, a sword)
     will not resolve as a TESObjectARMO and C++ drops them, so the caller is
     free to pass the whole worn set — but the card pre-ticks armour only.

     Returns {ok, name, count} so the card can print its own verdict rather than
     rely on the toast alone. Creation needs the game running + SOES-NG present;
     with the Wardrobe pane loaded that is already the contract. */
  function createOutfitFromItems(rawName, items) {
    const usable = (items || []).filter(function (i) {
      return i && !i.missing && i.formId && i.plugin;
    });
    if (!usable.length) {
      toast('Copy outfit — nothing to copy (no wearable pieces ticked)');
      return { ok: false, msg: 'no pieces' };
    }
    var base = String(rawName || '').trim() || 'Copied outfit';
    var name = uniqueOutfitName(base);
    toGame('wdBuild', JSON.stringify({
      name: name,
      items: usable.map(function (i) {
        return { formId: i.formId, plugin: i.plugin, name: i.name || '' };
      }),
    }));
    /* A fresh meta row so the outfit shows up on the Wardrobe tab immediately —
       C++ seeds one too (BuildOutfit), but seeding it here means the deck does
       not have to wait for SOES's export cycle to know the outfit exists. */
    ensureMeta(name);
    touch();
    var n = usable.length;
    toast('Copied outfit “' + name + '” — ' + n + ' piece' + (n === 1 ? '' : 's'));
    return { ok: true, name: name, count: n };
  }

  /* ============================================================ exports = */

  return {
    init: init, onShow: onShow, onHide: onHide, receive: receive, wantsPause: wantsPause,
    toggleEdit: toggleEdit, registerSub: registerSub,
    /* Shared with the Followers tab's F7 quick card (see quickAbout above) so
       the two surfaces run ONE implementation of every op they both offer. */
    quickAbout: quickAbout, quickSetManaged: quickSetManaged, quickTrack: quickTrack,
    quickDress: quickDress, quickFocus: quickFocus, quickRefresh: quickRefresh,
    /* The F7 outfit dock's ⚡ Quick apply (hd-outfit.js). */
    quickOutfits: quickOutfits, quickWear: quickWear, quickGiveWear: quickGiveWear,
    quickTagOwner: quickTagOwner, setTags: setTags, _ownersOf: ownersOf, _tagsOf: tagsOf,
    /* The rendered-mesh lookup, shared with the Wheel Menu (hd-wheel.js): its
       wedges draw the same Mesh-Rendering-Framework pictures these rows do,
       and the key normalisation ("0XABCD|plugin.esp") must have exactly ONE
       implementation or the two surfaces disagree about the same item. */
    itemIconFor: itemIconFor,
    createOutfitFromItems: createOutfitFromItems,
    nffDataChanged: nffDataChanged,
    /* exposed for the harness + wiring */
    _state: state, _ui: ui, _selftest: selftest,
    _picker: { open: openCtxPicker, close: closeCtxPicker, categories: openCategoryPicker },
    _cadence: { list: CADENCE, label: cadenceLabel, index: cadenceIndex },
    _locations: LOCATIONS,
    /* the outfit-photo crop, for the harness */
    _crop: {
      clamp: clampCrop, keyOf: cropKeyOf, forImage: cropFor, phrase: cropPhrase,
      set: setCrops, open: openArt, close: closeArt, key: artKey,
      box: () => artBox, edit: () => artEdit,
      ZSTEP: CROP_ZSTEP, PAN_STEP: CROP_PAN_STEP, ZMAX: CROP_ZMAX, MAX: CROP_MAX_ENTRIES,
    },
  };
})();
