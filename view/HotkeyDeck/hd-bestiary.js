/* hd-bestiary.js — the Bestiary (2026-10-08).
 *
 * Rober, 2026-10-08: "a really cool monster log, where you can hit a button when
 * hovering over a killed creature and you get a really cool visually stunning book
 * UI … image of the monster … stats and rating it … categorization of types (would
 * support all modded creatures) … our own openrouter api connection … fill out lore
 * … regional data". Then: "would want this to work without chim … add our own
 * openrouter key in UI".
 *
 * A body-anchored popout (the deck's popout law): it fills the viewport, owns the
 * keyboard while up, and is laid out in design px for 2560x1440 times --u, a
 * LAYOUT scale (Ultralight rasterises <img> at layout size, so never a transform).
 *
 * Two spreads:
 *   specimen  — left page: name, kin, the turntable figure, variants, lore.
 *               right page: threat seal + verdict, four ratings, vital statistics,
 *               resistances, traits, where you met it, your tally.
 *   contents  — a chapter's title page + the searchable, sortable roster.
 *
 * Bridge (view -> C++), all JSON strings through toGame():
 *   bxOpen    {}                          ask for state; C++ answers window.bxState
 *   bxLore    {id, rewrite}               ask the Scribe to write/rewrite one entry
 *   bxRender  {id}                        queue the portrait render for an entry
 *   bxSpin    {id}                        bake the 45-degree turntable frames;
 *                                         C++ answers window.bxSpinState
 *   bxScribe  {op:'save'|'test'|'remove', key?, model, voice, length, codex, chim, auto, spoilers}
 *   hdCapture '1M' / '0'                  the deck's keyboard capture, while up ('1M' = a modal: no 20 s watchdog)
 * The API key goes DOWN once on Save and never comes back up: the state only ever
 * carries a masked tail (scribe.key) and keyState.
 *
 * Three folios per creature: specimen → combat → field notes (← → walk them).
 *
 * Render discipline (2026-10-10, "its also laggy"): the book draws in
 * Ultralight's CPU renderer, so render() redraws the chrome (top bar + chapter
 * rail) only when the data or the chapter changed, writes just the two pages
 * on a folio turn, and patches the foot. bxEntry patches a row, a variant chip
 * or the lore section when that is all that changed; bxState with an unchanged
 * rev is skipped. Every innerHTML write goes through setHTML (window.__bxWrites
 * counts them for the harness), every timer through T (close() clears them
 * all), and motion is transform/opacity only. No drop-shadow filters, no
 * large blurred shadows: the book's shadow and the page vignettes are painted
 * gradients.
 *
 * Round-2 contract fields (all optional; an older DLL draws as before):
 *   rev, player.{resist,difficulty,dmg}, chapters[ch].byPlugin, and on an
 *   entry: family, unique, levelRange, flags[], attacks[], arsenal[],
 *   body.{mass,speed}, fights.power, style.{basis,offense}, vs.{difficulty,
 *   hardest}, records, affects as {s,cap,lvl,pct,dual,spell,plugin,known,perk,
 *   why} (or the old [state, note]), lore.{pending,lastError,errorKind,truncated}.
 *
 * Where every number comes from (the C++ capture contract — read at kill time
 * off the dying actor, never invented; a field the engine cannot answer is left
 * out and the page says so):
 *   level/health/stamina/magicka   GetLevel, GetBaseActorValue (permanent max)
 *   armor → physical %             DamageResist × fArmorScalingFactor (0.12%/pt),
 *                                  capped at fMaxArmorRating (80%)
 *   resist.{fire,frost,shock,magic,poison,disease}   FireResist, FrostResist,
 *                                  ElectricResist, MagicResist, PoisonResist,
 *                                  DiseaseResist (current, so racial abilities count)
 *   dmg                            unarmed damage (race) or the equipped weapon's
 *   body.height                    race height × actor scale × the 3D's bound
 *   body.mass                      the race's ragdoll mass, bucketed into words
 *   body.speed                     run speed vs the player's own, in words
 *   body.regen                     HealRate (% of max per second)
 *   body.soul                      the engine's soul thresholds by level
 *                                  (petty <4, lesser <16, common <28, greater <38,
 *                                  grand); NPC races are black souls; summons none
 *   affects.*                      each reference effect's OWN conditions
 *                                  evaluated against this actor (Calm/Fear/Frenzy
 *                                  level caps included), plus the actor-type
 *                                  keywords silver/sun/Turn Undead/Banish test
 *   style.*                        the actor's combat style (CSTY) score mults,
 *                                  normalised to 100
 *   fights.{temper,courage}        AI data: Aggression, Confidence
 *   fights.{reach,power}           race unarmed reach; attack data with the power flag
 *   vs.yourBlows / itsBlows        health ÷ per-hit damage after resistances, both
 *                                  ways, with the player's current weapon and armour
 *   records.*                      combat start/end and the player's lowest health
 *                                  between them, kept per kind in bestiary.json
 *   carries                        the NPC record's death-item leveled list
 *   spoils                         items moved from a corpse of that kind to you
 */
(function () {
  'use strict';

  var BASE_CH = [
    { id: 'all',     name: 'All Kinds',          icon: 'bx-all',     blurb: 'Every kind you have met, slain or studied, in one place.' },
    { id: 'beast',   name: 'Beasts',             icon: 'bx-beast',   blurb: 'Wolves, cats, bears, and everything else with fur that bites.' },
    { id: 'monster', name: 'Monsters',           icon: 'bx-monster', blurb: 'Trolls, chaurus, spriggans: the things that ought not to be.' },
    { id: 'undead',  name: 'Undead',             icon: 'bx-undead',  blurb: 'The draugr in their barrows, the skeletons, the restless and the raised.' },
    { id: 'daedra',  name: 'Daedra',             icon: 'bx-daedra',  blurb: 'Atronachs, dremora and worse, called up out of Oblivion.' },
    { id: 'dragon',  name: 'Dragons',            icon: 'bx-dragon',  blurb: 'The dov, returned. Each one you fell is a soul you keep.' },
    { id: 'dwarven', name: 'Dwemer Works',       icon: 'bx-dwarven', blurb: 'Spiders, spheres and centurions that outlived the people who built them.' },
    { id: 'giant',   name: 'Giants',             icon: 'bx-giant',   blurb: 'The herds of the tundra and the giants who keep them.' },
    { id: 'falmer',  name: 'Falmer',             icon: 'bx-falmer',  blurb: 'The Betrayed, and the chaurus they breed in the dark.' },
    { id: 'folk',    name: 'Folk & Outlaws',     icon: 'bx-folk',    blurb: 'Bandits, Forsworn, necromancers: men and mer who chose the wrong road.' },
    { id: 'unknown', name: 'Unclassified',       icon: 'bx-unknown', blurb: 'Kinds no tag explains — usually from mods. Filed by their race until you name them.' }
  ];
  /* The reader's own chapters (Rober, 2026-10-12: "create your own categories and
     upload your own images"). C++ keeps them in the book as "shelves" (bxShelf);
     they sit after the built-ins, Unclassified stays last, and a page joins one
     through the editor's Chapter row (bxEdit set.chapter). Their icon is a
     picture PATH (icons/custom/… or icons/sh/…), which icon() passes through. */
  var CH = BASE_CH.slice();
  function setShelves(list) {
    var mine = arr(list).filter(function (x) { return x && x.id && x.name; }).map(function (x) {
      var pic = safePic(x.icon);
      return { id: String(x.id), name: String(x.name), icon: pic || 'bx-quill', iconPath: pic, rawBlurb: String(x.blurb || ''),
        blurb: String(x.blurb || '') || 'A chapter of your own. File any creature here from its page: Edit this page, Chapter.', mine: true };
    });
    CH = BASE_CH.slice(0, -1).concat(mine, BASE_CH.slice(-1));
  }
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  function roman(n) {
    var out = '', v = [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    n = n | 0;
    for (var i = 0; i < v.length; i++) while (n >= v[i][0]) { out += v[i][1]; n -= v[i][0]; }
    return out;
  }
  var TIER = ['', 'Trivial', 'Fair', 'Fierce', 'Deadly', 'Dire'];
  var RATE = [
    { k: 'tough',  name: 'Toughness', icon: 'rt-tough' },
    { k: 'fero',   name: 'Ferocity',  icon: 'rt-ferocity' },
    { k: 'arcane', name: 'Arcane',    icon: 'rt-arcane' },
    { k: 'rarity', name: 'Rarity',    icon: 'rt-rarity' }
  ];
  var RES = [
    { k: 'fire', name: 'Fire' }, { k: 'frost', name: 'Frost' }, { k: 'shock', name: 'Shock' },
    { k: 'magic', name: 'Magic' }, { k: 'poison', name: 'Poison' }, { k: 'disease', name: 'Disease' }
  ];
  var FOLIOS = [{ k: 'specimen', name: 'Specimen' }, { k: 'combat', name: 'Combat' }, { k: 'notes', name: 'Field notes' }];
  function folioIx(k) { for (var i = 0; i < FOLIOS.length; i++) if (FOLIOS[i].k === k) return i; return 0; }
  var SORTS = [{ k: 'kills', name: 'Most slain' }, { k: 'threat', name: 'Deadliest' }, { k: 'name', name: 'A to Z' }, { k: 'plugin', name: 'By mod' }];
  var VOICES = [
    { k: 'scholar', name: 'College scholar', eg: '“The College notes the beast hunts by the shoulders of the High Hrothgar road…”' },
    { k: 'hunter',  name: 'Hunter’s notes', eg: '“Tracks wide as a shield. Burn it before it stands back up.”' },
    { k: 'tavern',  name: 'Tavern tale',     eg: '“My uncle swore he saw one eat a whole cart. Horse and all, mind.”' }
  ];
  var MODELS = [
    { id: 'deepseek/deepseek-v3.1-terminus', name: 'DeepSeek V3.1 Terminus', cost: '≈ $0.0006 / entry', tag: 'Default' },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', cost: '≈ $0.0009 / entry', tag: 'Fast' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', cost: '≈ $0.011 / entry', tag: 'Best prose' },
    { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini', cost: '≈ $0.0014 / entry', tag: '' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', cost: '≈ $0.0005 / entry', tag: '' },
    { id: 'mistralai/mistral-small-3.2-24b-instruct', name: 'Mistral Small 3.2', cost: '≈ $0.0002 / entry', tag: 'Cheapest' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', cost: '≈ $0.0004 / entry', tag: '' },
    { id: 'x-ai/grok-3-mini', name: 'Grok 3 mini', cost: '≈ $0.0007 / entry', tag: '' }
  ];
  var ICON = 'icons/custom/';

  var root = null, ui = {};
  var st = {
    data: null, open: false, view: 'entry', folio: 'specimen', chapter: 'all', id: null, sort: 'kills', angle: 0,
    q: '', hot: 0, resultsOpen: false, scribe: null, edit: null, modelQ: '', lessonQ: '', turn: '',
    pendingGo: null, freshId: '', animLore: '', writeWatch: {}, justOpened: false,
    /* book lane: render bookkeeping */
    fresh: null, lastRev: null, gen: 0, chromeKey: '', u: 0, sel: null, loreAnim: null, pendSince: {}, foldQ: '', anim: false, listGen: 0, list: null
  };

  /* --------------------------------------------------------- helpers -- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toGame(fn, arg) {
    var f = window[fn];
    if (typeof f === 'function') { try { f(String(arg === undefined ? '' : arg)); } catch (e) {} }
    else if (window.console) console.log('[bestiary dev->game]', fn, arg);
  }
  function icon(name) {
    name = String(name == null ? '' : name);
    if (name.indexOf('/') >= 0) return safePic(name) || ICON + 'bx-unknown.png';
    return ICON + name + '.png';
  }
  /* a picture the reader chose: view-relative, inside icons/, nothing that can
     leave the view root (the C++ SafePicture rule; app.js hkIconSrc) */
  function safePic(p) {
    p = String(p == null ? '' : p).replace(/\\/g, '/');
    if (!/^icons\//.test(p) || p.indexOf('..') >= 0 || /[:?"<>]/.test(p)) return '';
    return p;
  }
  function chOf(id) { for (var i = 0; i < CH.length; i++) if (CH[i].id === id) return CH[i]; return CH[CH.length - 1]; }
  function chIndex(id) { for (var i = 0; i < CH.length; i++) if (CH[i].id === id) return i; return 0; }
  function entries() { return (st.data && st.data.entries) || []; }
  function byId(id) { var a = entries(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
  function slain(e) { return (e && e.tally && e.tally.slain) || 0; }
  function tier(e) { return (e && e.threat && e.threat.tier) || 0; }
  /* a medal / row / chip: the 512 (thumb) when the page's figure is the 1024 */
  function artOf(e) {
    if (!e) return '';
    if (e.thumb || e.img) return e.thumb || e.img;
    var t = e.thumbOf && byId(e.thumbOf);
    return (t && (t.thumb || t.img)) || '';
  }
  function fmt(n) { return n == null ? '' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function inChapter(e, ch) { return ch === 'all' || e.chapter === ch; }
  function sorted(list, how) {
    var a = list.slice();
    a.sort(function (x, y) {
      if (how === 'name') return x.name.localeCompare(y.name);
      if (how === 'threat') return (tier(y) - tier(x)) || (slain(y) - slain(x)) || x.name.localeCompare(y.name);
      if (how === 'plugin') return String(x.plugin || '~').localeCompare(String(y.plugin || '~')) || (slain(y) - slain(x)) || x.name.localeCompare(y.name);
      return (slain(y) - slain(x)) || x.name.localeCompare(y.name);
    });
    return a;
  }
  function chapterList(ch) { return sorted(entries().filter(function (e) { return inChapter(e, ch); }), st.sort); }

  /* the layout unit; written only when it changes (a --u write restyles the
     whole book), from open() and on resize */
  function setU() {
    if (!root) return;
    var u = +Math.min(window.innerHeight / 1440, window.innerWidth / 2560).toFixed(4);
    if (u === st.u) return;
    st.u = u;
    root.style.setProperty('--u', u + 'px');
  }
  function U() { return st.u || 1; }
  /* Five threat skulls as TWO nodes, not five <img>s (contents rows draw dozens):
     a track tiling the unlit rt-danger-off socket, and a fill on top tiling the
     lit rt-danger, cut to n fifths of the track. Sized by --bx-sk in the CSS. */
  /* The 64px mip (tools/make_icon_mips.py): the socket tiles at 26-40u, and the 256px
     original breaks up there under Ultralight's no-mipmap sampling. The CSS lit layer
     uses the same tier. */
  var SKULL_OFF = icon('mip/64/rt-danger-off');
  function skulls(n, label) {
    n = Math.max(0, Math.min(5, n | 0));
    return '<div class="bx-skulls" title="' + (n ? n + ' of 5' : 'Not yet weighed') + '"><span class="bx-skulls-track" style="background-image:url(' + SKULL_OFF + ')"><span class="bx-skulls-fill" style="width:' + (n * 20) +
      '%"></span></span>' + (label ? '<span class="bx-skulls-label">' + esc(label) + '</span>' : '') + '</div>';
  }
  /* row/result thumbs crop to the head the way the medals do (bx-crop): a full
     body shrunk into a 76px circle read as a dark sliver for anything tall */
  function thumb(e) {
    var src = artOf(e);
    if (src) return '<span class="bx-res-thumb"><img class="bx-crop" src="' + esc(src) + '" alt=""></span>';
    return '<span class="bx-res-thumb"><img class="bx-glyph" src="' + icon(chOf(e.chapter).icon) + '" alt=""></span>';
  }
  /* A mod creature with no race name files under its race EditorID
     ("GloomWraithRace"); say it as words ("Gloom Wraith"). */
  function humanKin(s) {
    s = String(s || '');
    if (!s || /\s/.test(s) || !/^[A-Za-z0-9_]+$/.test(s)) return s;
    var t = s.replace(/_/g, ' ').replace(/Race$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
    return t || s;
  }
  /* "Family · race · from plugin", saying the race only when it adds something */
  function kinLine(e) {
    var fam = humanKin(e.family || e.race || ''), race = humanKin(e.race || '');
    var parts = [];
    if (fam) parts.push('<b>' + esc(fam) + '</b>');
    if (race && race.toLowerCase() !== fam.toLowerCase()) parts.push(esc(race));
    parts.push('from ' + esc(e.plugin || 'an unknown plugin'));
    return parts.join(' · ');
  }
  function kinText(e) { return kinLine(e).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
  /* a long name steps down so it fits two lines instead of being cut off */
  function nameScale(name) {
    var n = String(name || '').length;
    return n <= 18 ? 1 : n <= 26 ? 0.86 : n <= 38 ? 0.74 : 0.64;
  }
  /* affects: the old DLL sends [state, note]; the round-2 DLL sends
     {s, cap?, dual?, lvl?, pct?, spell?, plugin?, known?, perk?, why?}.
     Both come out as one shape; a missing key is null ("Not read yet"). */
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function numOr(v) { if (v == null || v === '') return null; var n = +v; return isNaN(n) ? null : n; }
  /* silver and sunlight are BANES: "no" there means normal damage, not immunity */
  function isBane(k) { return k === 'silver' || k === 'sun'; }
  /* -> {s, word, cls, cap, lvl, pct, dual, spell, plugin, known, perk, why};
     k (the affects key) only changes what "no" means for a bane */
  function normAff(v, k) {
    var o;
    if (v == null) return null;
    if (isArr(v)) o = { s: String(v[0] || 'unknown'), why: v[1] || '' };
    else if (typeof v === 'object') {
      o = {};
      for (var p in v) if (Object.prototype.hasOwnProperty.call(v, p)) o[p] = v[p];
      o.s = String(o.s || 'unknown');
    } else if (typeof v === 'string') o = { s: v, why: '' };
    else return null;
    o.cap = numOr(o.cap); o.lvl = numOr(o.lvl); o.dual = numOr(o.dual); o.pct = numOr(o.pct);
    o.why = o.why ? String(o.why) : '';
    var s = o.s, cap = o.cap;
    if (s === 'yes') { o.word = cap != null ? 'Up to level ' + cap : 'Works'; o.cls = cap != null ? 'bx-upto' : 'bx-ok'; }
    else if (s === 'no') {
      if (isBane(k)) { o.word = 'Normal'; o.cls = 'bx-plain'; }
      else { o.word = cap != null ? 'Too strong · cap ' + cap : 'No effect'; o.cls = 'bx-no'; }
    }
    else if (s === 'part') { o.word = o.pct != null ? 'Resists ' + o.pct + '%' : 'Partly'; o.cls = 'bx-part'; }
    else if (s === 'perk') { o.word = o.perk ? 'Needs ' + o.perk : 'Needs a perk'; o.cls = 'bx-perk'; }
    else if (s === 'weak') { o.word = 'Extra harm'; o.cls = 'bx-hurts'; }
    else if (s === 'normal') { o.word = 'Normal'; o.cls = 'bx-plain'; }
    else if (s === 'na') { o.word = 'Does not apply'; o.cls = 'bx-na'; }
    else { o.word = 'Not read yet'; o.cls = 'bx-unread-t'; }
    return o;
  }

  /* Every timer the book starts lives here under a name, so close() can clear
     them all at once and a re-arm under the same name replaces the old one. */
  var T = (function () {
    var m = {};
    function clear(k) { var t = m[k]; if (!t) return; if (t.iv) clearInterval(t.id); else clearTimeout(t.id); delete m[k]; }
    return {
      set: function (k, fn, ms) { clear(k); m[k] = { iv: false, id: setTimeout(function () { delete m[k]; fn(); }, ms) }; },
      every: function (k, fn, ms) { clear(k); m[k] = { iv: true, id: setInterval(fn, ms) }; },
      clear: clear,
      has: function (k) { return !!m[k]; },
      all: function () { for (var k in m) clear(k); }
    };
  })();
  /* every innerHTML write goes through here; window.__bxWrites lets the
     harness count how many each action costs */
  function setHTML(el, html) {
    if (!el) return;
    window.__bxWrites = (window.__bxWrites || 0) + 1;
    el.innerHTML = html;
  }
  function arr(v) { return isArr(v) ? v : []; }
  /* one place that makes an entry safe to draw: an older DLL, a hand-edited
     bestiary.json or a half-written page must never throw in a renderer */
  function normEntry(e) {
    if (!e || typeof e !== 'object') return null;
    e.id = e.id == null ? '' : String(e.id);
    e.name = String(e.name || e.race || e.id || 'Unnamed kind');
    if (e.lore && typeof e.lore === 'object') { e.lore.text = arr(e.lore.text); e.lore.state = e.lore.state || 'none'; }
    else e.lore = { state: 'none', text: [] };
    e.traits = arr(e.traits); e.flags = arr(e.flags);
    /* every reader of these lists touches a.name / a.kind / a.element: a null or
       a bare string (hand-edited bestiary.json, a C++ slip) is dropped here */
    var isObj = function (a) { return !!a && typeof a === 'object' && !isArr(a); };
    e.attacks = arr(e.attacks).filter(isObj); e.arsenal = arr(e.arsenal).filter(isObj);
    if (e.affects && (typeof e.affects !== 'object' || isArr(e.affects))) e.affects = null;
    /* the reader's own picture (editor: Picture) stands in for the render; no turntable */
    var pic = safePic(e.art);
    if (pic) { e.renderImg = e.img || ''; e.img = e.thumb = pic; e.custArt = true; } else e.custArt = false;
    e._facets = facetsOf(e);
    return e;
  }
  var EL5 = ['fire', 'frost', 'shock', 'poison', 'magic'];
  /* the words a search can filter by: "weak:fire immune:frost flees unique" */
  function facetsOf(e) {
    var f = [], r = e.resist || {};
    EL5.forEach(function (k) {
      var v = r[k];
      if (v == null) return;
      if (v < 0) f.push('weak:' + k); else if (v >= 100) f.push('immune:' + k); else if (v > 0) f.push('resists:' + k);
    });
    if (e.physical != null) { if (e.physical >= 100) f.push('immune:physical'); else if (e.physical > 0) f.push('resists:physical'); else if (e.physical < 0) f.push('weak:physical'); }
    if (e.chapter) f.push('chapter:' + e.chapter);
    if (e.plugin) f.push('plugin:' + String(e.plugin).toLowerCase().replace(/\s+/g, '_'));   // one token: "plugin:bestiary_of_tamriel.esp"
    e.flags.forEach(function (x) { if (x === 'flies' || x === 'swims' || x === 'immobile') f.push(x); });
    var cour = String((e.fights || {}).courage || '').toLowerCase();
    if (/flee/.test(cour) && !/never/.test(cour)) f.push('flees');
    if (e.unique) f.push('unique');
    return f.join(' ');
  }
  function isFacet(tok) { return /^(weak|immune|resists|chapter|plugin):\S+$/.test(tok) || /^(flies|swims|immobile|flees|unique)$/.test(tok); }
  /* an icon with a fallback: a contract icon the art lane has not landed yet
     swaps to the old one (the capture-phase error listener in build()) */
  function img(name, fb, cls) {
    return '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + icon(name) + '"' + (fb && fb !== name ? ' data-fb="' + icon(fb) + '"' : '') + ' alt="">';
  }
  /* Skyrim dates ("3 Sun's Dawn 4E 202") as one sortable number */
  var MONTHS = ['morning star', 'sun’s dawn', 'first seed', 'rain’s hand', 'second seed', 'midyear', 'sun’s height', 'last seed', 'hearthfire', 'frostfall', 'sun’s dusk', 'evening star'];
  function dateKey(s) {
    var m = /(\d+)\s+(.+?)\s+(\d)E\s+(\d+)/.exec(String(s || '').replace(/'/g, '’'));
    if (!m) return 0;
    var mo = MONTHS.indexOf(m[2].toLowerCase());
    return (+m[3]) * 1e6 + (+m[4]) * 1000 + Math.max(0, mo) * 40 + (+m[1]);
  }

  /* ------------------------------------------------------------ build -- */
  function build() {
    root = document.createElement('div');
    root.className = 'bx-back bx-hidden';
    root.id = 'bx-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Bestiary');
    root.innerHTML =
      '<header class="bx-top">' +
        '<div class="bx-brand"><img src="' + icon('bx-all') + '" alt="">' +
          '<div><div class="bx-brand-name">The Bestiary</div><div class="bx-brand-sub" id="bx-sub"></div></div></div>' +
        '<div class="bx-top-gap"><button class="bx-latest bx-hidden" id="bx-latest" data-act="goto"></button></div>' +
        '<div class="bx-search" id="bx-search">' +
          '<div class="bx-search-box" id="bx-search-box"><img src="' + icon('sn-search') + '" alt="">' +
            '<input id="bx-q" type="text" placeholder="Search every creature, kin or plugin…" autocomplete="off" spellcheck="false">' +
            '<button class="bx-search-clear bx-hidden" id="bx-clear" title="Clear">×</button>' +
            '<span class="bx-search-kbd">/</span></div>' +
          '<div class="bx-results bx-hidden" id="bx-results"></div>' +
        '</div>' +
        '<button class="bx-tool" id="bx-scribe-btn"><img src="' + icon('bx-quill') + '" alt=""><span>The Scribe</span><span class="bx-tool-flag" id="bx-scribe-flag"></span></button>' +
        '<button class="bx-tool bx-close" id="bx-close" title="Close (Esc)">×</button>' +
      '</header>' +
      '<div class="bx-body">' +
        '<nav class="bx-index" id="bx-index"></nav>' +
        '<main class="bx-bookwrap"><div class="bx-book-shadow"></div><div class="bx-book" id="bx-book">' +
          '<section class="bx-page bx-left" id="bx-left"></section><div class="bx-spine"></div>' +
          '<section class="bx-page bx-right" id="bx-right"></section>' +
        '</div></main>' +
      '</div>' +
      '<footer class="bx-foot" id="bx-foot"></footer>' +
      '<div class="bx-ribbon bx-hidden" id="bx-ribbon"></div>' +
      '<div class="bx-modal-back bx-hidden" id="bx-modal-back"></div>';
    document.body.appendChild(root);
    root.addEventListener('scroll', function (ev) { var b = ev.target; if (b && b._bxRail) syncRail(b); }, true);
    ['sub', 'latest', 'search-box', 'q', 'clear', 'results', 'scribe-btn', 'scribe-flag', 'close', 'index', 'book', 'left', 'right', 'foot', 'ribbon', 'modal-back']
      .forEach(function (k) { ui[k.replace(/-(\w)/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById('bx-' + k); });

    ui.close.addEventListener('click', close);
    ui.scribeBtn.addEventListener('click', openScribe);
    /* typing is debounced: one results draw per pause, not one per key */
    ui.q.addEventListener('input', function () {
      st.q = ui.q.value; st.hot = 0; st.resultsOpen = true;
      ui.clear.classList.toggle('bx-hidden', !st.q);
      T.set('search', renderResults, 100);
    });
    ui.q.addEventListener('focus', function () { T.clear('search-blur'); ui.searchBox.classList.add('bx-focus'); st.resultsOpen = true; renderResults(); });
    ui.q.addEventListener('blur', function () { ui.searchBox.classList.remove('bx-focus'); T.set('search-blur', function () { st.resultsOpen = false; renderResults(); }, 150); });
    ui.clear.addEventListener('click', function () { ui.q.value = ''; st.q = ''; renderResults(); ui.q.focus(); });
    /* hover picks the hot result by classes alone; the list is not redrawn */
    ui.results.addEventListener('mouseover', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.bx-res') : null;
      if (!b) return;
      var i = +b.getAttribute('data-i');
      if (i === st.hot) return;
      st.hot = i;
      var rs = ui.results.querySelectorAll('.bx-res');
      for (var k = 0; k < rs.length; k++) rs[k].classList.toggle('bx-on', k === i);
    });
    /* a facet chip under the search box is pressed with mousedown so the
       input never loses focus (and the results never blink shut) */
    ui.results.addEventListener('mousedown', function (ev) {
      var c = ev.target.closest ? ev.target.closest('[data-facet]') : null;
      if (!c) return;
      ev.preventDefault();
      var f = c.getAttribute('data-facet'), toks = st.q.trim() ? st.q.trim().split(/\s+/) : [];
      var at = toks.indexOf(f);
      if (at >= 0) toks.splice(at, 1); else toks.unshift(f);
      ui.q.value = st.q = toks.join(' ') + (toks.length ? ' ' : '');
      st.hot = 0; ui.clear.classList.toggle('bx-hidden', !st.q); renderResults();
    });
    root.addEventListener('click', onClick);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('dblclick', onDbl);
    /* a contract icon not yet on disk swaps to its older stand-in, once */
    root.addEventListener('error', function (ev) {
      var t = ev.target, fb = t && t.getAttribute && t.getAttribute('data-fb');
      if (fb && t.tagName === 'IMG') { t.removeAttribute('data-fb'); t.setAttribute('src', fb); }
    }, true);
    /* the Edit popout's fields: ONE delegated listener for the life of the book */
    ui.modalBack.addEventListener('input', function (ev) {
      var tg = ev.target;
      if (st.edit && tg.getAttribute('data-ed')) { edInput(ev); return; }
      if (tg.id === 'bx-pk-q') { var p = curPick(); if (p) { p.q = tg.value; p.shown = PICK_PAGE; T.set('pk-q', refreshPicker, 90); } return; }
      var f = tg.getAttribute('data-sh');
      if (st.shelf && f) {
        st.shelf[f] = tg.value;
        var sv = document.getElementById('bx-sh-save'); if (sv) sv.disabled = !st.shelf.name.trim();
      }
    });
    ui.book.addEventListener('animationend', function (ev) {
      if (ev.target.classList && ev.target.classList.contains('bx-page-in')) endTurn();
    });
    /* a new --u re-lays every page: the folds and the "More below" cue were
       measured at the old size, so the open folio is drawn again (once the
       resize settles; a study in progress keeps its emblem) */
    window.addEventListener('resize', function () {
      if (!st.open) return;
      var was = st.u;
      setU();
      if (st.u !== was && st.view === 'entry') T.set('resize-redraw', function () { if (st.open && st.view === 'entry' && !st.list && !st.edit && !st.scribe) render(); }, 150);
    });
    document.addEventListener('keydown', onKey, true);
  }

  /* -------------------------------------------------------------- top -- */
  function renderTop() {
    var a = entries(), kills = 0;
    for (var i = 0; i < a.length; i++) kills += slain(a[i]);
    var p = (st.data && st.data.player) || {};
    ui.sub.textContent = 'of ' + (p.name || 'the Dragonborn') + ' · ' + a.length + ' kinds recorded · ' + fmt(kills) + ' slain';
    var lt = st.data && st.data.latest, le = lt && byId(lt.id);
    if (le) {
      var la = artOf(le);
      ui.latest.setAttribute('data-id', le.id);
      setHTML(ui.latest, '<span class="bx-medal bx-medal-xxs">' + (la ? '<img src="' + esc(la) + '" alt="">' : '<img class="bx-glyph" src="' + icon(chOf(le.chapter).icon) + '" alt="">') +
        '</span><span class="bx-latest-text"><span class="bx-latest-k">Latest kill</span><span class="bx-latest-v">' + esc(le.name) + ' · ' + esc(lt.when || '') + '</span></span>');
      ui.latest.classList.remove('bx-hidden');
    } else ui.latest.classList.add('bx-hidden');
    var s = (st.data && st.data.scribe) || {};
    var ok = s.keyState === 'saved';
    ui.scribeFlag.textContent = ok ? 'ready' : 'no key';
    ui.scribeFlag.className = 'bx-tool-flag' + (ok ? '' : ' bx-warn');
  }

  /* The query is words and facets. A facet ("weak:fire", "flees",
     "plugin:dawnguard.esm") is a whole token and filters; the rest of the
     words match names, kin, chapter and plugin as before. */
  function parseQ(q) {
    var out = { facets: [], text: '' }, rest = [];
    String(q || '').trim().toLowerCase().split(/\s+/).forEach(function (t) { if (!t) return; if (isFacet(t)) out.facets.push(t); else rest.push(t); });
    out.text = rest.join(' ');
    return out;
  }
  function hasFacets(e, fs) {
    if (!fs.length) return true;
    var have = ' ' + (e._facets || '') + ' ';
    for (var i = 0; i < fs.length; i++) if (have.indexOf(' ' + fs[i] + ' ') < 0) return false;
    return true;
  }
  function matches() {
    var pq = parseQ(st.q), q = pq.text;
    if (!q && !pq.facets.length) return [];
    var out = [];
    entries().forEach(function (e) {
      if (!hasFacets(e, pq.facets)) return;
      var name = e.name.toLowerCase(), i = q ? name.indexOf(q) : -1, score = -1;
      if (!q) score = 0;
      else if (i === 0) score = 0; else if (i > 0) score = 1;
      else if ((e.family || '').toLowerCase().indexOf(q) >= 0 || humanKin(e.family || e.race || '').toLowerCase().indexOf(q) >= 0) score = 2;
      else if (chOf(e.chapter).name.toLowerCase().indexOf(q) >= 0) score = 3;
      else if ((e.plugin || '').toLowerCase().indexOf(q) >= 0) score = 4;
      if (score >= 0) out.push({ e: e, s: score, at: q ? i : -1, len: q.length });
    });
    out.sort(function (x, y) { return (x.s - y.s) || (slain(y.e) - slain(x.e)) || x.e.name.localeCompare(y.e.name); });
    return out.slice(0, 8);
  }
  function hl(name, at, len) {
    if (at < 0) return esc(name);
    return esc(name.slice(0, at)) + '<mark>' + esc(name.slice(at, at + len)) + '</mark>' + esc(name.slice(at + len));
  }
  /* the facet chips worth offering: the ones at least one kind in the book has */
  var FACET_LABEL = { flees: 'Flees', flies: 'Flies', swims: 'Swims', unique: 'Unique', immobile: 'Immobile' };
  function facetChips(active) {
    var count = {};
    entries().forEach(function (e) { String(e._facets || '').split(' ').forEach(function (f) { if (f && !/^(plugin|chapter):/.test(f)) count[f] = (count[f] || 0) + 1; }); });
    var keys = Object.keys(count).sort(function (a, b) { return (count[b] - count[a]) || a.localeCompare(b); }).slice(0, 10);
    active.forEach(function (f) { if (keys.indexOf(f) < 0) keys.unshift(f); });
    if (!keys.length) return '';
    return '<div class="bx-facets"><span class="bx-facets-k">Filter</span>' + keys.map(function (f) {
      var on = active.indexOf(f) >= 0, m = /^(\w+):(.+)$/.exec(f);
      var label = m ? (m[1] === 'weak' ? 'Weak to ' : m[1] === 'immune' ? 'Immune to ' : m[1] === 'resists' ? 'Resists ' : m[1] + ' ') + m[2] : (FACET_LABEL[f] || f);
      return '<button class="bx-facet' + (on ? ' bx-on' : '') + '" data-facet="' + esc(f) + '" tabindex="-1">' + esc(label) + (count[f] ? '<i>' + count[f] + '</i>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function renderResults() {
    ui.clear.classList.toggle('bx-hidden', !st.q);
    if (!st.resultsOpen) { ui.results.classList.add('bx-hidden'); return; }
    var pq = parseQ(st.q), m = matches(), q = st.q.trim();
    if (st.hot >= m.length) st.hot = Math.max(0, m.length - 1);
    var h = facetChips(pq.facets);
    if (!q) { if (!h) { ui.results.classList.add('bx-hidden'); return; } h += '<div class="bx-res-hint">Type a name, a kin or a plugin · Enter opens the top hit</div>'; }
    else if (!m.length) h += '<div class="bx-res-none">Nothing in the book answers to “' + esc(q) + '”. A creature is written in the first time you kill or study one.</div>';
    m.forEach(function (r, i) {
      var e = r.e;
      h += '<button class="bx-res' + (i === st.hot ? ' bx-on' : '') + '" data-i="' + i + '" data-act="goto" data-id="' + esc(e.id) + '" title="' + esc(e.name) + '">' + thumb(e) +
        '<span class="bx-res-text"><div class="bx-res-name">' + hl(e.name, r.at, r.len) + '</div>' +
        '<div class="bx-res-meta">' + slain(e) + ' slain · ' + esc(humanKin(e.family || e.race || '')) + ' · ' + esc(chOf(e.chapter).name) + '</div></span>' +
        '<span class="bx-res-side"><span class="bx-res-enter">Enter</span><span class="bx-res-sk">' + skulls(tier(e)) + '</span></span></button>';
    });
    setHTML(ui.results, h);
    ui.results.classList.remove('bx-hidden'); railsSoon();
  }

  /* ------------------------------------------------------------ index -- */
  /* "known" per chapter = kinds the LOAD ORDER defines (races carrying the
     chapter's keyword); "all" sums them */
  function knownOf(ch) {
    var cs = (st.data && st.data.chapters) || {}, n = 0;
    if (ch === 'all') { for (var k in cs) n += (cs[k] && cs[k].known) || 0; return n; }
    return (cs[ch] && cs[ch].known) || 0;
  }
  function activeChapter() {
    if (st.view === 'contents') return st.chapter;
    if (st.view === 'entry') return (byId(st.id) || {}).chapter || '';
    return '';
  }
  /* the last few kills, newest first: the "latest" kill, then each kind's
     newest encounter by its Skyrim date */
  function lately(n) {
    var out = [], seen = {}, lt = st.data && st.data.latest;
    if (lt && byId(lt.id)) { out.push({ e: byId(lt.id), when: lt.when || '' }); seen[lt.id] = 1; }
    var rest = [];
    entries().forEach(function (e) {
      if (seen[e.id] || !slain(e)) return;
      var l = arr(e.log)[0];
      if (l && l.when) rest.push({ e: e, when: l.when, k: dateKey(l.when) });
    });
    rest.sort(function (a, b) { return b.k - a.k; });
    return out.concat(rest).slice(0, n);
  }
  function renderIndex() {
    var h = '', act = activeChapter(), counts = { all: 0 };
    entries().forEach(function (e) { counts.all++; counts[e.chapter] = (counts[e.chapter] || 0) + 1; });
    CH.forEach(function (c) {
      var n = counts[c.id] || 0, kn = knownOf(c.id), pct = kn ? Math.min(100, Math.round(100 * n / kn)) : 0;
      h += '<button class="bx-ch' + (act === c.id ? ' bx-on' : '') + (n ? '' : ' bx-empty') + '" data-act="chapter" data-ch="' + c.id + '"' +
        (kn ? ' title="' + n + ' of ' + kn + ' kinds recorded"' : '') + '>' +
        '<img src="' + icon(c.icon) + '" alt=""><span class="bx-ch-name">' + esc(c.name) + '</span><span class="bx-ch-n">' + n + '</span>' +
        (kn ? '<span class="bx-ch-bar"><span style="transform:scaleX(' + (pct / 100).toFixed(3) + ')"></span></span>' : '') + '</button>';
    });
    h += '<button class="bx-ch bx-ch-new" data-act="shelf-new" title="Start a chapter of your own, with your own picture"><img src="' + icon('bx-quill') +
      '" alt=""><span class="bx-ch-name">New chapter</span><span class="bx-ch-n"></span></button>';
    /* below the tabs: the whole book's completion, and the last few kills */
    var all = counts.all, known = knownOf('all'), late = lately(3);
    h += '<div class="bx-rail-foot">';
    if (known) {
      var pc = Math.min(100, Math.round(100 * all / known));
      h += '<div class="bx-rf-book"><div class="bx-rf-top"><span class="bx-rf-k">The Book</span><span class="bx-rf-v"><b>' + all + '</b> of ' + known + '</span></div>' +
        '<div class="bx-rf-bar"><span style="transform:scaleX(' + (pc / 100).toFixed(3) + ')"></span></div></div>';
    }
    if (late.length) {
      h += '<div class="bx-rf-k bx-rf-lately">Lately</div>' + late.map(function (x) {
        var a = artOf(x.e);
        return '<button class="bx-rf-row" data-act="goto" data-id="' + esc(x.e.id) + '" title="' + esc(x.e.name) + '"><span class="bx-medal bx-medal-rf">' +
          (a ? '<img src="' + esc(a) + '" alt="">' : '<img class="bx-glyph" src="' + icon(chOf(x.e.chapter).icon) + '" alt="">') +
          '</span><span class="bx-rf-text"><span class="bx-rf-name">' + esc(x.e.name) + '</span><span class="bx-rf-when">' + esc(String(x.when).replace(/\s*4E\s*\d+$/, '')) + '</span></span></button>';
      }).join('');
    }
    h += '</div>';
    setHTML(ui.index, h);
  }
  /* the active tab moves without a redraw (a folio turn inside one chapter) */
  function markIndex() {
    var act = activeChapter(), tabs = ui.index.querySelectorAll('.bx-ch');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('bx-on', tabs[i].getAttribute('data-ch') === act);
  }

  /* --------------------------------------------------------- specimen -- */
  /* Each creature has two folios, as a real bestiary would:
       specimen    — the figure, and how dangerous it is (threat, ratings,
                     statistics, resistances, habits)
       field notes — what it is (the Scribe's lore, the Codex facts) and your
                     history with it (where you met it, your tally, encounters)
     One spread could not hold both at a readable size; ← → walk the folios. */
  /* ONE header for every folio, so it stands still while the body turns under
     it: the running head (CHAPTER II · MONSTERS · COMBAT), the name in full
     (two lines at most, one size smaller past NAME_LONG characters; the
     ellipsis is a last resort after two lines), the kin line, and on
     the Combat and Field-notes folios a medallion in the top-right slot. It is
     written OUTSIDE .bx-page-in: header(...) + '<div class="bx-page-in">…'. */
  var FOLIO_NAME = { specimen: 'Specimen', combat: 'Combat', notes: 'Field notes' };
  /* past this many characters the name steps down a size (it may take two lines) */
  var NAME_LONG = 28;
  /* the new-page flourish (ink wipe, seal stamp) plays once: render() hands the
     renderers st.fresh; before that lane lands, st.freshId still answers */
  function isFresh(e) { return !!e && (st.fresh !== undefined ? st.fresh === e.id : st.freshId === e.id); }
  function header(e, c, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var folio = opts.folio || st.folio || 'specimen', art = artOf(e);
    var lvl = e.levelRange ? ' · <span class="bx-kin-lvl">' + esc(e.levelRange) + '</span>' : '';
    return '<div class="bx-head' + (opts.medal ? ' bx-head-medal' : '') + '">' +
      '<div class="bx-eyebrow"><img src="' + icon(c.icon) + '" alt=""><span class="bx-eyebrow-t">' + chapterLabel(c) + ' · ' + (FOLIO_NAME[folio] || FOLIO_NAME.specimen) +
        '</span><span class="bx-eyebrow-rule"></span></div>' +
      '<h1 class="bx-name' + (String(e.name).length > NAME_LONG ? ' bx-name-long' : '') + (isFresh(e) ? ' bx-name-ink' : '') + '" title="' + esc(e.name) + '">' + esc(e.name) + '</h1>' +
      '<div class="bx-kin" title="' + esc(kinText(e) + (e.levelRange ? ' · ' + e.levelRange : '')) + '">' +
        (e.unique ? '<span class="bx-kin-uniq">Unique</span>' : '') + kinLine(e) + lvl +
        (e.edited && e.edited.length ? '<span class="bx-kin-ed">edited by you</span>' : '') + '</div>' +
      (opts.medal ? '<span class="bx-medal bx-head-m">' + (art ? '<img src="' + esc(art) + '" alt="">' : '<img class="bx-glyph" src="' + icon(c.icon) + '" alt="">') + '</span>' : '') +
      '</div>';
  }
  function chapterLabel(c) { return c.id === 'all' ? 'The Bestiary' : 'Chapter ' + roman(chIndex(c.id)) + ' · ' + esc(c.name); }

  function renderSpecimen(e) {
    var c = chOf(e.chapter), fresh = isFresh(e), anim = !!st.turn;
    var vars = (e.variants || []).map(byId).filter(Boolean);
    /* the header stays still; only the page body under it turns */
    var L = header(e, c, { folio: 'specimen' }) + '<div class="bx-page-in bx-spec-l">';
    if (e.img) {
      spinFor(e);
      /* the lantern behind it, the chapter mark at 5%, a STATIC floor glow
         (no drop-shadow on a 512px image: the CPU renderer pays for that on
         every frame the page moves), eight dots round the floor for the eight
         turntable views, and the figure sized by layout once it is measured */
      L += '<div class="bx-stage bx-tier-' + tier(e) + '" id="bx-stage" title="Drag to turn · wheel to zoom · middle-drag to move · double-click to reset">' +
          '<img class="bx-stage-mark" src="' + icon(c.icon) + '" alt=""><div class="bx-floor"></div>' +
          (e.custArt ? '' : '<div class="bx-dots" id="bx-dots">' + dotsInner(e) + '</div>') +
          '<div class="bx-figure bx-figs-wait" id="bx-figs">' + figStack(e) + '</div>' +
        '</div>' +
        '<div class="bx-turn" id="bx-turn">' + turnInner(e) + '</div>';
    } else {
      /* no render yet: ONE emblem (the "Not yet drawn" card's), no watermark and
         no floor glow under nothing - two emblems at two sizes read as a glitch */
      L += '<div class="bx-stage bx-stage-empty" id="bx-stage"><div class="bx-figure"><div class="bx-figure-none"><img src="' + icon(c.icon) +
        '" alt=""><b>Not yet drawn</b>The portrait is painted the next time one is near you, from the creature’s own model.</div></div></div>';
    }
    if (vars.length > 1) {
      L += '<div class="bx-variants">' + vars.map(function (v) {
        var a = artOf(v);
        return '<button class="bx-var' + (v.id === e.id ? ' bx-on' : '') + '" data-act="goto" data-id="' + esc(v.id) + '" title="' + esc(v.name + ' · ' + slain(v) + ' slain') + '"><span class="bx-var-thumb">' +
          (a ? '<img class="bx-crop" src="' + esc(a) + '" alt="">' : '<img class="bx-glyph" src="' + icon(c.icon) + '" alt="">') + '</span><span class="bx-var-name">' + esc(v.name) +
          '</span><span class="bx-var-n">' + slain(v) + '</span></button>';
      }).join('') + '</div>';
    }
    L += '</div>';
    ui.left.className = 'bx-page bx-left';
    ui.left.innerHTML = L;
    sp.base = null;   // this stage's fit, measured afresh (sp.lastBase keeps a zoomed view in place)
    if (e.img) { fitFigure(e); if (!e.custArt) askSpin(e); }

    var t = e.threat || {}, tn = t.tier || 0, pl = (st.data && st.data.player) || {};
    var R = '<div class="bx-page-in bx-spec-r">';
    /* the seal art carries its own shadow (no filter); tier I is the pale wax */
    var seal = tn === 1 ? '<img src="' + icon('bx-seal-pale') + '" alt="" onerror="this.onerror=null;this.src=\'' + icon('bx-seal') + '\'">' : '<img src="' + icon('bx-seal') + '" alt="">';
    var late = fresh && sp.lateStamp === e.id;
    if (late) sp.lateStamp = '';
    R += '<section><div class="bx-sect-h">Threat to you</div><div class="bx-threat">' +
      '<div class="bx-seal bx-t' + tn + (fresh ? ' bx-stamp' + (late ? ' bx-stamp-late' : '') : '') + '">' + seal + '<div class="bx-seal-in"><div class="bx-seal-word">' + esc(t.word || TIER[tn] || 'Unknown') +
      '</div><div class="bx-seal-tier">Tier ' + (ROMAN[tn] || '—') + '</div></div></div>' +
      '<div class="bx-verdict">' + skulls(tn, tn ? TIER[tn] + ' at level ' + (pl.level || '?') : 'Not yet weighed') +
      '<div class="bx-verdict-text">' + (t.note || (tn ? 'Weighed from its tier alone. Meet one again and the book will say how to fight it.' : 'Kill or study one and the book will weigh it against you.')) + '</div></div></div></section>';
    if (e.ratings) {
      /* the descriptor sits under its name so the bar runs the cell's full width;
         ONE fill per bar, which scales in from the left on a page turn only */
      R += '<section class="bx-ratings">' + RATE.map(function (r, i) {
        var v = e.ratings[r.k] || [0, ''], n = Math.max(0, Math.min(5, v[0] | 0)), pips = '', lit = '';
        for (var k = 0; k < 5; k++) pips += '<span class="bx-pip"></span>';
        for (k = 0; k < n; k++) lit += '<span class="bx-pip"></span>';
        return '<div class="bx-rate" title="' + esc(r.name + ': ' + n + ' of 5' + (v[1] ? ' · ' + v[1] : '')) + '"><img class="bx-rate-icon" src="' + icon(r.icon) + '" alt="">' +
          '<div class="bx-rate-text"><div class="bx-rate-name">' + r.name + '</div><div class="bx-rate-word">' + (v[1] ? esc(v[1]) : '&nbsp;') + '</div></div>' +
          '<div class="bx-pips">' + pips + (n ? '<span class="bx-pip-fill bx-pf' + n + (anim ? ' bx-pf-anim" style="animation-delay:' + (i * 40) + 'ms' : '') + '">' + lit + '</span>' : '') + '</div></div>';
      }).join('') + '</section>';
    }
    if (e.level == null && !e.resist) {
      R += '<section class="bx-unread"><img src="' + icon(c.icon) + '" alt=""><b>Only the count is written</b><span>The book has your ' + slain(e) +
        ' kill' + (slain(e) === 1 ? '' : 's') + ' of this kind, but none of its measure. The next one you meet is read in full: its strength, resistances, habits and a portrait.</span></section>';
      R += '</div>';
      ui.right.className = 'bx-page bx-right';
      ui.right.innerHTML = R;
      return;
    }
    var si = 0;
    var stat = function (v, k, unit) {
      var known = v != null && v !== '', a = anim && si < 8 ? ' bx-cell-anim" style="animation-delay:' + (si * 30) + 'ms' : '';
      si++;
      return '<div class="bx-stat' + a + '"><div class="bx-stat-v' + (known ? '' : ' bx-unknown') + '">' + (known ? esc(typeof v === 'number' ? fmt(v) : v) + (unit ? '<small>' + unit + '</small>' : '') : 'unknown') +
        '</div><div class="bx-stat-k">' + k + '</div></div>';
    };
    R += '<section><div class="bx-sect-h">Vital statistics' + measuredNote(e) + '</div><div class="bx-stats">' +
      stat(e.level, 'Level') + stat(e.health, 'Health') + stat(e.armor, 'Armour') +
      stat(e.stamina, 'Stamina') + stat(e.magicka, 'Magicka') + stat(e.dmg, 'Strikes for') + '</div></section>';
    var bd = e.body;
    if (bd) {
      var bodyItems = [
        ['bx-height', 'Stands', bd.height, bd.heightFt], ['bx-mass', 'Weight', bd.mass, ''], ['bx-speed', 'Speed', bd.speed, ''],
        ['bx-regen', 'Heals', bd.regen, ''], ['bx-soul', 'Soul', bd.soul, '']
      ].filter(function (x) { return x[2]; });
      if (bodyItems.length) {
        R += '<section><div class="bx-sect-h">Body &amp; soul</div><div class="bx-body5" style="grid-template-columns:repeat(' + bodyItems.length + ',1fr)">' + bodyItems.map(function (x) {
          return '<div class="bx-bodyi"><img src="' + icon(x[0]) + '" alt=""><div class="bx-bodyi-v">' + esc(x[2]) + (x[3] ? '<small>' + esc(x[3]) + '</small>' : '') + '</div><div class="bx-bodyi-k">' + x[1] + '</div></div>';
        }).join('') + '</div></section>';
      }
    }
    /* never an empty box: chips for what it does, or one line saying it has nothing */
    var chips = habitChips(e);
    R += '<section class="bx-spec-habits"><div class="bx-sect-h">Habits &amp; abilities</div>' +
      (chips ? '<div class="bx-traits">' + chips + '</div>' : '<div class="bx-spec-none">No spells or powers of its own: tooth and claw.</div>') +
      '<img class="bx-spec-mark" src="' + icon(c.icon) + '" alt=""></section>';
    R += '</div>';
    ui.right.className = 'bx-page bx-right';
    ui.right.innerHTML = R;
  }

  /* ------------------------------------------- specimen: the new parts -- */
  /* how the measure was taken, and whether it can be trusted (round-2 DLL):
     rides at the end of the Vital statistics rule, so it costs no line */
  function measuredNote(e) {
    var m = e.measured;
    if (!m || typeof m !== 'object') return '';
    var under = m.under | 0, h = m.how === 'study' ? 'read when you studied one' : 'read off one you killed';
    var tip = under > 0 ? under + ' spell' + (under === 1 ? ' was' : 's were') + ' on it at the time, so these may read high or low' : '';
    return '<span class="bx-stat-how' + (under > 0 ? ' bx-warn' : '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + h +
      (under > 0 ? ' \u00B7 ' + under + ' spell' + (under === 1 ? '' : 's') + ' on it, may be skewed' : '') + '</span>';
  }

  /* Habits & abilities: what it uses on you (arsenal), what its body does
     (flags), then the C++ traits, deduplicated by name. */
  var FLAGS = {
    noKnockdown: ['Never knocked down', 'rt-tough'], immobile: ['Rooted: it cannot move', 'bx-speed'], flies: ['Flies', 'bx-speed'],
    swims: ['Swims', 'bx-speed'], cantOpenDoors: ['Cannot open doors', ''], notPushable: ['Cannot be pushed', 'bx-mass'],
    regenInCombat: ['Heals mid-fight', 'bx-regen'], noCombatInWater: ['Will not fight in water', '']
  };
  var ELEM_ICON = { fire: 'res-fire', frost: 'res-frost', shock: 'res-shock', poison: 'res-poison', magic: 'res-magic', disease: 'res-disease' };
  var KIND = { spell: ['Spell', 'sc-destruction'], shout: ['Shout', 'sc-shouts'], power: ['Power', 'sc-powers'], attack: ['Attack', 'bx-combat'] };
  function habitChips(e) {
    var seen = {}, h = '';
    function add(text, ic, kind, tip, cls) {
      var key = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen[key]) return;
      seen[key] = 1;
      h += '<span class="bx-trait' + (cls || '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
        (ic ? '<img src="' + icon(ic) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '<span class="bx-trait-t">' + esc(text) + '</span>' +
        (kind ? '<span class="bx-trait-k">' + kind + '</span>' : '') + '</span>';
    }
    (e.arsenal || []).forEach(function (a) {
      if (!a || !a.name) return;
      var k = KIND[a.kind] || ['', ''];
      add(a.name, ELEM_ICON[a.element] || k[1], k[0], [a.name, k[0], a.plugin].filter(Boolean).join(' · '), ' bx-trait-arm');
    });
    (e.flags || []).forEach(function (f) { var d = FLAGS[f]; if (d) add(d[0], d[1], '', '', ' bx-trait-flag'); });
    (e.traits || []).forEach(function (x) { if (typeof x === 'string') add(x, '', '', '', ''); });
    return h;
  }

  /* rt-danger-off is new art: an install without it marks the empty skull
     slots with the lit skull, faint (.bx-no-skull-off in the CSS) */
  (function () {
    var im = new Image();
    im.onerror = function () { try { document.documentElement.classList.add('bx-no-skull-off'); } catch (x) {} };
    im.src = icon('rt-danger-off');
  })();

  /* ---- figure auto-fit ---------------------------------------------------
     An MRF render is a full body on a transparent 512px square, often small in
     it. Measure the creature's alpha box once per render (a 128px canvas read,
     cached by path), then size the <img> by LAYOUT - never a transform, which
     Ultralight would only magnify - so the creature fills ~88% of the stage and
     its feet stand on the floor glow. Frame 000's box serves every angle (no
     jump on a turn) until all eight are baked, then their union does. When the
     canvas cannot be read (tainted, or no 2D canvas), it falls back to height
     100% of the stage. */
  var BB = {};
  function unitPx() { return (root && parseFloat(root.style.getPropertyValue('--u'))) || 1; }
  function alphaBox(im) {
    var nw = im.naturalWidth, nh = im.naturalHeight;
    if (!nw || !nh) return false;
    try {
      var k = Math.min(1, 128 / Math.max(nw, nh)), cw = Math.max(1, Math.round(nw * k)), ch = Math.max(1, Math.round(nh * k));
      var cv = alphaBox.cv || (alphaBox.cv = document.createElement('canvas'));
      cv.width = cw; cv.height = ch;
      var cx = cv.getContext('2d');
      cx.clearRect(0, 0, cw, ch);
      cx.drawImage(im, 0, 0, cw, ch);
      var d = cx.getImageData(0, 0, cw, ch).data, x0 = cw, y0 = ch, x1 = -1, y1 = -1, x, y, i = 3;
      for (y = 0; y < ch; y++) for (x = 0; x < cw; x++, i += 4) {
        if (d[i] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) return false;
      return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k, nw: nw, nh: nh };
    } catch (err) { return false; }
  }
  /* THE STACK (2026-10-11, marker bestiary-figure-stack; Rober: "sloth is
     extremely laggy to rotate"). Every baked frame is its own <img> in
     #bx-figs, all laid out on ONE rect; a turn toggles which is visible. A src
     swap made Ultralight decode and rasterise a new picture at the figure's
     full layout size on every step; a decoded sibling only repaints. The rect
     is the alpha-box fit (base) under the viewer's zoom and pan, in stage px:
     a point p of the base lands at (p - c) * z + c + pan, c the stage centre. */
  function figWrap() { return document.getElementById('bx-figs'); }
  function figStage() { return document.getElementById('bx-stage'); }
  function vzFor(id) {
    if (!sp.vz || sp.vz.id !== id) sp.vz = { id: id, z: 1, px: 0, py: 0 };
    return sp.vz;
  }
  function placeFigs() {
    var w = figWrap(), st0 = figStage(), b = sp.base;
    if (!w || !st0 || !b) return;
    var v = vzFor(st.id), W = st0.clientWidth, H = st0.clientHeight, cx = W / 2, cy = H / 2;
    var l = Math.round((b.l - cx) * v.z + cx + v.px), t = Math.round((b.t - cy) * v.z + cy + v.py);
    var ww = Math.round(b.w * v.z), hh = Math.round(b.h * v.z);
    var list = w.children;
    for (var i = 0; i < list.length; i++) {
      var s2 = list[i].style;
      s2.width = ww + 'px'; s2.height = hh + 'px'; s2.left = l + 'px'; s2.top = t + 'px';
    }
    w.classList.remove('bx-figs-wait');
    w.classList.toggle('bx-zoomed', v.z > 1.001);
    if (st0) st0.classList.toggle('bx-zoomed', v.z > 1.001);
  }
  function applyFit(b) {
    var w = figWrap(), stage = figStage();
    if (!w || !stage) return;
    if (!b) { sp.base = null; w.classList.remove('bx-figs-wait'); w.classList.add('bx-figs-fallback'); return; }
    var W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) {   // laid out yet? (the book can render while it is still hidden)
      if ((w._fitTries = (w._fitTries || 0) + 1) <= 10) setTimeout(function () { applyFit(b); }, 60);
      return;
    }
    var u = unitPx(), floorY = H - 40 * u;
    var s = Math.min(0.88 * H / b.h, 0.88 * W / b.w, (floorY - 6 * u) / b.h);
    var nb = { id: st.id, l: W / 2 - (b.x + b.w / 2) * s, t: floorY - (b.y + b.h) * s, w: b.nw * s, h: b.nh * s,
      bx: b.x * s, by: b.y * s, bw: b.w * s, bh: b.h * s };
    /* a re-fit under a zoomed view (the eight-view union landing mid-turn, a
       state push redrawing the page) keeps the figure the size and place it
       had on screen; Rober, 2026-10-11: "then it snapped back like it zoomed
       out". Unzoomed, the new fit simply applies. */
    var ob = sp.base || sp.lastBase, v = vzFor(st.id);
    if (ob && ob.id === st.id && v.z > 1.001 && ob.w > 0 && nb.w > 0) {
      var cx = W / 2, cy = H / 2, z2 = v.z * ob.w / nb.w;
      var L0 = (ob.l - cx) * v.z + cx + v.px, T0 = (ob.t - cy) * v.z + cy + v.py;
      if (z2 <= 1.001) { v.z = 1; v.px = 0; v.py = 0; }
      else { v.z = Math.min(ZOOM_MAX, z2); v.px = L0 - (nb.l - cx) * v.z - cx; v.py = T0 - (nb.t - cy) * v.z - cy; }
    }
    sp.base = sp.lastBase = nb;
    clampPan();
    placeFigs();
  }
  function fitFigure(e) {
    if (!e || !e.img) return;
    var key = e.img;
    if (BB[key] !== undefined) { applyFit(BB[key]); return; }
    /* measured off frame 000 itself, whichever angle the stack is showing */
    var im0 = new Image();
    im0.onload = function () {
      if (BB[key] === undefined) BB[key] = alphaBox(im0);
      var cur = byId(st.id);
      if (cur && cur.img === key) applyFit(BB[key]);
    };
    im0.onerror = function () { applyFit(false); };
    im0.src = key;
  }
  /* all eight frames are in: their union box, so no view pokes out of the stage */
  function widenFit(img) {
    var b0 = BB[img], f = sp.bb[img];
    if (!b0 || b0.union || !f) return;
    var x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
    for (var a = SPIN; a < 360; a += SPIN) {
      var b = f[a];
      if (!b) return;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    BB[img] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, nw: b0.nw, nh: b0.nh, union: true };
    var e = byId(st.id);
    if (e && e.img === img) applyFit(BB[img]);
  }
  /* zoom by LAYOUT (Ultralight rasterises an <img> at its layout size, so the
     1024 render reads sharp up close; a transform would only magnify the
     raster), anchored on the point under the cursor */
  var ZOOM_MAX = 4;
  function zoomAt(f, mx, my) {
    var stage = figStage();
    if (!stage || !sp.base) return;
    var v = vzFor(st.id), W = stage.clientWidth, H = stage.clientHeight, cx = W / 2, cy = H / 2;
    if (mx == null) { mx = cx; my = cy; }
    var z2 = Math.max(1, Math.min(ZOOM_MAX, v.z * f));
    if (z2 === v.z) return;
    v.px = mx - cx - (mx - cx - v.px) * z2 / v.z;
    v.py = my - cy - (my - cy - v.py) * z2 / v.z;
    v.z = z2;
    if (v.z <= 1.001) { v.z = 1; v.px = 0; v.py = 0; }
    clampPan();
    placeFigs();
  }
  /* the CREATURE (its alpha box, never the transparent canvas round it) stays
     framed: one that fits the stage stays wholly inside it, one bigger than the
     stage can be moved but never off an edge with blank stage showing on that
     side while the other side is cut (Rober, 2026-10-11: "zoomed in to be cut
     off"). Unzoomed and unmoved, the fit already satisfies this. */
  function clampAxis(p, lo0, size, room) {
    /* lo0 = the box's near edge at pan 0; size = its extent; room = the stage */
    var a = -lo0, b = room - size - lo0;   // the box flush with the near / far edge
    return size <= room ? Math.max(a, Math.min(b, p)) : Math.max(b, Math.min(a, p));
  }
  function clampPan() {
    var stage = figStage(), v = sp.vz, b = sp.base;
    if (!stage || !v || !b || b.bw == null) return;
    var W = stage.clientWidth, H = stage.clientHeight, cx = W / 2, cy = H / 2;
    v.px = clampAxis(v.px, (b.l - cx) * v.z + cx + b.bx * v.z, b.bw * v.z, W);
    v.py = clampAxis(v.py, (b.t - cy) * v.z + cy + b.by * v.z, b.bh * v.z, H);
  }
  function resetZoom() { var v = vzFor(st.id); v.z = 1; v.px = 0; v.py = 0; placeFigs(); }
  function onWheel(ev) {
    var stage = ev.target && ev.target.closest ? ev.target.closest('#bx-stage') : null;
    if (!stage || !sp.base || stage.classList.contains('bx-stage-empty')) return;
    var d = ev.deltaY || 0;
    if (!d) return;
    var r = stage.getBoundingClientRect();
    zoomAt(d < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top);
    ev.preventDefault(); ev.stopPropagation();   // the deck's page-scroller must not take it
  }
  window.addEventListener('resize', function () {
    setTimeout(function () {
      var e = byId(st.id);
      if (st.open && e && e.img && figWrap() && BB[e.img] !== undefined) { figWrap()._fitTries = 0; applyFit(BB[e.img]); }
      syncRails();
    }, 0);
  });

  /* ---- the study ceremony -------------------------------------------------
     The study key opens the book at once on an emblem - the book, the arcane
     ring turning behind it (the ONLY infinite animation in the book) and the
     quill - laid over the whole spread so no stale page shows under it. The
     page lands under it and the emblem fades; the seal stamps last. */
  function studyText(t) {
    var n = String(t.name || '').trim();
    return n ? (/^(the|a|an) /i.test(n) ? n : 'the ' + n) : 'the creature';
  }
  function renderStudying() {
    if (!root || !ui.book) return;
    ui.left.className = 'bx-page bx-left'; ui.left.innerHTML = '<div class="bx-page-in"></div>';
    ui.right.className = 'bx-page bx-right'; ui.right.innerHTML = '<div class="bx-page-in"></div>';
    drawStudy();
  }
  function drawStudy() {
    var t = sp.tok;
    if (!t || !ui.book) return;
    var n = document.getElementById('bx-studying');
    var state = t.seq + (t.failed ? 'f' : '');
    if (n && n.getAttribute('data-s') === state) return;   // drawn: never restart its motion
    if (!n) { n = document.createElement('div'); n.id = 'bx-studying'; ui.book.appendChild(n); }
    n.setAttribute('data-s', state);
    n.className = 'bx-studying' + (t.failed ? ' bx-studying-fail' : '');
    n.innerHTML = '<div class="bx-studying-in"><div class="bx-studying-emb">' +
        '<img class="bx-studying-ring" src="' + icon('rt-arcane') + '" alt=""><img class="bx-studying-book" src="' + icon('bx-all') + '" alt="">' +
        '<img class="bx-studying-quill" src="' + icon('bx-quill') + '" alt=""></div>' +
      (t.failed
        ? '<div class="bx-studying-t">The book could not read that one</div><div class="bx-studying-s">' + esc(t.why || 'Aim at a creature close by, and try again.') + '</div>'
        : '<div class="bx-studying-t">Studying ' + esc(studyText(t)) + '…</div><div class="bx-studying-s">The book measures what it sees</div>') +
      '</div>';
  }
  function studyDone(fade) {
    var n = document.getElementById('bx-studying');
    if (!n) return;
    n.removeAttribute('id');
    if (!fade) { if (n.parentNode) n.parentNode.removeChild(n); return; }
    n.className += ' bx-out';
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 200);
  }
  function stopWatch() { if (sp.watchT) { clearInterval(sp.watchT); sp.watchT = 0; } }
  /* the page has landed when the book stands on the studied entry */
  function watchLanding() {
    var t = sp.tok;
    if (!t) { stopWatch(); return; }
    if (!st.open) return;
    if (t.id && !st.pendingGo && st.view === 'entry' && st.id === t.id) {
      sp.tok = null; stopWatch();
      if (sp.failT) { clearTimeout(sp.failT); sp.failT = 0; }
      studyDone(true);
    }
  }
  function studyFail(why) {
    var t = sp.tok;
    if (!t || t.failed) return;
    t.failed = true; t.why = why || '';
    if (sp.failT) { clearTimeout(sp.failT); sp.failT = 0; }
    if (st.open) { drawStudy(); if (st.view === 'studying') renderFoot(); }
    sp.holdT = setTimeout(function () {
      sp.holdT = 0;
      if (sp.tok !== t) return;
      sp.tok = null; stopWatch();
      var p = t.prev;
      if (!p.open) { studyDone(false); close(); return; }   // it was opened for this: back to the game
      studyDone(true);
      st.view = p.view; st.id = p.id; st.folio = p.folio; st.chapter = p.chapter; st.turn = 'prev';
      render();
    }, 2400);
  }

  /* HDBestiary.peek(nameOrId): what the book already holds on a kind, for the
     F7 card's door. From the last state the book saw; with none yet it asks
     once, so the next F7 draw has it. */
  function peek(q) {
    if (!st.data) {
      if (!sp.peekAsked) { sp.peekAsked = true; toGame('bxOpen', '{}'); }
      return null;
    }
    if (q == null || q === '') return null;
    var e = byId(String(q));
    if (!e) {
      var k = String(q).toLowerCase().trim(), a = entries();
      for (var i = 0; i < a.length; i++) if (String(a[i].name || '').toLowerCase() === k) { e = a[i]; break; }
    }
    if (!e) return null;
    return { id: e.id, name: e.name, slain: slain(e), studied: (e.tally && e.tally.studied) || 0, tier: tier(e), img: artOf(e) };
  }

  /* ------------------------------------------------------ field notes -- */
  /* The contract header (specimen lane) sits OUTSIDE .bx-page-in, so a page
     turn moves only the body. Until that header lands this wraps the older
     compact one the same way, so both builds lay out alike. */
  function folioHead(e, c, folio) {
    var h = '';
    try { if (typeof header === 'function') h = header(e, c, { medal: true, folio: folio }); } catch (x) { h = ''; }
    if (/^\s*<div class="bx-head/.test(h || '')) return h;
    var inner = '';
    try { inner = typeof compactHeader === 'function' ? compactHeader(e, c, kinLine(e)) : h; } catch (x) { inner = h; }
    return '<div class="bx-head bx-head-shim">' + inner + '</div>';
  }
  function scribeState() { return (st.data && st.data.scribe) || {}; }
  function modelName(id) { for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i]; return { name: id || 'your model', cost: '' }; }

  function renderNotes(e) {
    var c = chOf(e.chapter);
    var L = folioHead(e, c, 'notes') + '<div class="bx-page-in bx-notes-left">' + loreBlock(e);
    var cx = e.codex, grid = function (rows) {
      return '<div class="bx-codex-grid">' + rows.filter(function (r) { return r[1]; })
        .map(function (r) { return '<span class="bx-tl-k">' + r[0] + '</span><span class="bx-codex-v">' + esc(r[1]) + '</span>'; }).join('') + '</div>';
    };
    /* the Codex follows the lore directly; no gap that grows */
    if (cx) {
      L += '<section class="bx-codex"><div class="bx-sect-h">From the Codex</div>' +
        grid([['Habitat', cx.habitat], ['Diet', cx.diet], ['Also called', cx.also], ['Hunters say', cx.saying]]) + '</section>';
    } else if (e.race || e.plugin) {
      /* no Codex text for this kind: what the book itself measured instead */
      L += '<section class="bx-codex"><div class="bx-sect-h">On record</div>' + grid([
        ['Race', humanKin(e.race)], ['Added by', e.plugin], ['Seen at', e.levelRange], ['Soul', e.body && e.body.soul],
        ['Carries', arr(e.carries).map(function (x) { return x.name; }).join(', ')]
      ]) + '</section>';
    }
    if (e.notes) L += '<section class="bx-yours"><div class="bx-sect-h">Your notes</div><div class="bx-yours-t">' + esc(e.notes).replace(/\n/g, '<br>') + '</div></section>';
    /* art that yields: it takes whatever the page leaves, and nothing when it is full */
    if (arr(e.lore.text).length) L += '<div class="bx-lore-fill"><img src="' + icon(c.icon) + '" alt=""></div>';
    L += '</div>';
    ui.left.className = 'bx-page bx-left';
    setHTML(ui.left, L);

    var ty = e.tally || {}, regs = arr(e.regions), top = 0;
    regs.forEach(function (g) { top = Math.max(top, g.n || 0); });
    var R = '<div class="bx-page-in bx-notes-right">';
    R += '<section><div class="bx-sect-h">Where you met it</div>' + (regs.length ? '<div class="bx-regions">' + regs.map(function (g, i) {
        return '<div class="bx-region' + (i === 0 ? ' bx-top1' : '') + '">' + img('rg-' + (g.id || 'other'), 'rg-other') + '<div class="bx-region-text"><div class="bx-region-top"><span class="bx-region-name">' +
          esc(g.name) + '</span><span class="bx-region-n">' + (g.n || 0) + ' slain</span></div><div class="bx-region-bar"><span style="transform:scaleX(' + ((g.n || 0) / (top || 1)).toFixed(3) + ')"></span></div></div></div>';
      }).join('') + '</div>' : '<div class="bx-quiet">Places are written down from your next kill on. Older kills kept only their count.</div>') + '</section>';
    R += '<section><div class="bx-sect-h">Your tally</div><div class="bx-tally"><div class="bx-tally-big"><div class="bx-tally-n">' + slain(e) +
      '</div><div class="bx-tally-k">Slain by you</div>' + (ty.companions ? '<div class="bx-tally-sub">+' + ty.companions + ' by followers</div>' : '') +
      (ty.studied ? '<div class="bx-tally-sub">studied ' + ty.studied + (ty.studied === 1 ? ' time' : ' times') + '</div>' : '') + '</div><div class="bx-tally-lines">' +
      (ty.first ? '<span class="bx-tl-k">First</span><span class="bx-tl-v">' + esc(ty.first) + '</span>' : '') +
      (ty.last ? '<span class="bx-tl-k">Latest</span><span class="bx-tl-v">' + esc(ty.last) + '</span>' : '') +
      (ty.biggest ? '<span class="bx-tl-k">Greatest</span><span class="bx-tl-v">' + esc(ty.biggest) + '</span>' : '') +
      (ty.weapon ? '<span class="bx-tl-k">Felled by</span><span class="bx-tl-v">' + esc(ty.weapon) + '</span>' : '') +
      (e.levelRange ? '<span class="bx-tl-k bx-tl-lvl">Levels seen</span><span class="bx-tl-v bx-tl-lvl">' + esc(e.levelRange) + '</span>' : '') +
      (!ty.first ? '<span class="bx-tl-k">Record</span><span class="bx-tl-v"><i>Only the count is kept until you meet one again.</i></span>' : '') +
      '</div></div></section>';
    /* your fights with it: kept with the tally, the rest of your history with it */
    R += recordsSection(e);
    if (arr(e.spoils).length || arr(e.carries).length) {
      R += '<section><div class="bx-sect-h">Spoils</div>' +
        (arr(e.spoils).length ? '<div class="bx-spoil-row"><span class="bx-spoil-k">You took</span><div class="bx-spoils">' + e.spoils.map(function (x) {
          return '<span class="bx-spoil"><span class="bx-spoil-name">' + esc(x.name) + '</span><span class="bx-spoil-n">×' + x.n + '</span></span>';
        }).join('') + '</div></div>' : '') +
        (arr(e.carries).length ? '<div class="bx-spoil-row bx-spoil-may"><span class="bx-spoil-k">May carry</span><div class="bx-spoils">' + e.carries.map(function (x) {
          return '<span class="bx-spoil bx-carry"><span class="bx-spoil-name">' + esc(x.name) + '</span><span class="bx-spoil-chance">' + esc(x.chance) + '</span></span>';
        }).join('') + '</div></div>' : '') + '</section>';
    }
    /* Encounters takes the rest of the page; a short log says it is short */
    var log = arr(e.log);
    /* a short log says so in its heading line, where a tight page cannot squeeze it out */
    /* the log keeps room for up to three rows however full the page is (--bx-logn) */
    R += '<section class="bx-log-sect" style="--bx-logn:' + Math.max(1, Math.min(3, log.length)) + '"><div class="bx-sect-h">Encounters' + (log.length ? ' \u00B7 ' + log.length : '') +
      (log.length && log.length < 3 ? '<span class="bx-log-few-h">Only ' + (log.length === 1 ? 'one meeting' : log.length + ' meetings') + ' recorded so far</span>' : '') + '</div>' +
      (log.length ? '<div class="bx-log">' + log.map(function (l) {
        return '<div class="bx-log-row"><span class="bx-log-when">' + esc(l.when) + '</span><span class="bx-log-what">' + esc(l.what) + '</span><span class="bx-log-where">' + esc(l.where) + '</span></div>';
      }).join('') + '</div>' : '<div class="bx-log-few">Each kill from now on is written here: when, where, and with what.</div>') + '</section>';
    R += '</div>';
    ui.right.className = 'bx-page bx-right';
    setHTML(ui.right, R);
    fitPage(ui.right.querySelector('.bx-notes-right'), FOLDS.notesR, 'fitN');
    fitPage(ui.right.querySelector('.bx-log'), [], 'fitLog');
  }

  /* The lore section, as one replaceable node (bxEntry swaps only this when
     only the lore changed). States, from the contract:
       text + no pending      the page, or the quill writing it in (st.loreAnim)
       text + pending         the old text faded, "Rewriting…" and a clock
       no text, writing       an unwritten page whose lines shimmer
       no text, none/error    an unwritten page: ghost initial, ruled lines,
                              Write this page / Set up the Scribe / the error */
  function loreBusy(l) { return !!(l && (l.state === 'writing' || l.pending)); }
  function errKind(l) {
    if (l.errorKind) return l.errorKind;
    var m = String(l.lastError || l.error || '');
    return /\b401\b|key/i.test(m) ? 'key' : /\b402\b|credit/i.test(m) ? 'credit' : /\b429\b|rate/i.test(m) ? 'rate' : /network|timed out|resolve|connect/i.test(m) ? 'net' : 'other';
  }
  function errBox(e, l) {
    var k = errKind(l), msg = l.lastError || l.error || 'The Scribe could not write this page.';
    var acts = k === 'key' ? '<button class="bx-mini bx-primary" data-act="scribe-key">Replace key</button>'
      : k === 'credit' ? '<button class="bx-mini bx-primary" data-act="scribe">Open the Scribe</button><span class="bx-lore-hint">Add credit at openrouter.ai/credits</span>'
      : k === 'rate' ? '<span class="bx-lore-hint">OpenRouter is busy. Retrying shortly.</span>'
      : '<button class="bx-mini bx-primary" data-act="lore" data-id="' + esc(e.id) + '"' + (arr(l.text).length ? ' data-rewrite="1"' : '') + '>Try again</button>';
    return '<div class="bx-lore-err"><b>The Scribe could not write ' + (arr(l.text).length ? 'the new page' : 'this page') + '</b><span>' + esc(msg) + '</span><div class="bx-lore-err-acts">' + acts + '</div></div>';
  }
  function elapsedFor(id) {
    if (!st.pendSince[id]) st.pendSince[id] = Date.now();
    return Math.max(0, Math.round((Date.now() - st.pendSince[id]) / 1000));
  }
  /* the lore split into phrases (6-10 words, broken at punctuation) for the quill */
  function phrases(p) {
    var bits = String(p).match(/[^,.;:!?—]+[,.;:!?—]*\s*/g) || [String(p)], out = [], cur = '';
    bits.forEach(function (b) {
      var n = (cur + b).trim().split(/\s+/).length;
      if (cur && n > 10) { out.push(cur); cur = b; }
      else { cur += b; if (n >= 6) { out.push(cur); cur = ''; } }
    });
    if (cur.trim()) out.push(cur);
    return out;
  }
  function loreBlock(e) {
    var l = e.lore || { state: 'none', text: [] }, s = scribeState(), txt = arr(l.text), busy = loreBusy(l);
    if (!busy) delete st.pendSince[e.id];
    if (txt.length) {
      var la = st.loreAnim, anim = !busy && la && la.id === e.id && !reducedMotion(), k = 0;
      var body = txt.map(function (p) {
        if (!anim) return '<p>' + esc(p) + '</p>';
        return '<p>' + phrases(p).map(function (ph) { return '<span class="bx-ph' + (k++ < la.i ? ' bx-on' : '') + '">' + esc(ph) + '</span>'; }).join('') + '</p>';
      }).join('');
      var by = esc(l.by || '') + (l.truncated ? '<i class="bx-lore-cut"> · cut short; Rewrite for the rest</i>' : '');
      return '<section class="bx-lore' + (busy ? ' bx-lore-busy' : '') + '"><div class="bx-sect-h">Of its nature' +
        (busy ? '<span class="bx-lore-tag">Rewriting… <span class="bx-lore-elapsed" data-id="' + esc(e.id) + '">' + elapsedFor(e.id) + ' s</span></span>' : '') + '</div>' +
        '<div class="bx-lore-text' + (anim ? ' bx-writing' : '') + '">' + body + (anim ? img('bx-pen', 'bx-quill', 'bx-pen') : '') + '</div>' +
        '<div class="bx-lore-by">' + img('bx-quill') + '<span>' + by + '</span><span class="bx-lore-acts">' +
        '<button class="bx-mini" data-act="edit">Edit</button><button class="bx-mini" data-act="lore" data-id="' + esc(e.id) + '" data-rewrite="1"' + (busy ? ' disabled' : '') + '>Rewrite</button></span></div>' +
        (l.lastError && !busy ? errBox(e, l) : '') + '</section>';
    }
    /* the unwritten page */
    var initial = esc((e.name || '?').replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase());
    var lines = busy ? '<div class="bx-ink-line" style="width:96%"></div><div class="bx-ink-line" style="width:88%"></div><div class="bx-ink-line" style="width:92%"></div><div class="bx-ink-line" style="width:54%"></div>'
                     : '<div class="bx-rule"></div><div class="bx-rule"></div><div class="bx-rule" style="width:62%"></div>';
    var mid;
    if (busy) mid = '<div class="bx-unw-say">The Scribe is writing… <span class="bx-lore-elapsed" data-id="' + esc(e.id) + '">' + elapsedFor(e.id) + ' s</span></div><div class="bx-unw-cost">Usually a few seconds. The page fills in as it lands.</div>';
    else if (l.state === 'error' || l.lastError) mid = errBox(e, l);
    else if (s.keyState !== 'saved') mid = '<button class="bx-mini bx-primary bx-unw-btn" data-act="scribe">Set up the Scribe</button>' +
      '<div class="bx-unw-cost">Give the Scribe an OpenRouter key and it writes every page from what the book measured and Tamriel’s lore. CHIM is not needed.</div>';
    else {
      var m = modelName(s.model);
      mid = '<button class="bx-mini bx-primary bx-unw-btn" data-act="lore" data-id="' + esc(e.id) + '">Write this page</button>' +
        '<div class="bx-unw-cost">One request to ' + esc(m.name) + (m.cost ? ' · ' + esc(m.cost) : '') + ', from what the book measured.</div>';
    }
    return '<section class="bx-lore bx-unwritten' + (busy ? ' bx-lore-busy' : '') + '"><div class="bx-sect-h">Of its nature</div>' +
      '<div class="bx-unw"><span class="bx-unw-cap">' + initial + '</span><div class="bx-unw-lines">' + lines + '</div><div class="bx-unw-mid">' + mid + '</div></div></section>';
  }
  /* one 1 s clock for every "Rewriting… N s" on the page, only while one shows */
  function loreClock() {
    if (!ui.left || !ui.left.querySelector('.bx-lore-elapsed')) { T.clear('lore-elapsed'); return; }
    if (T.has('lore-elapsed')) return;
    T.every('lore-elapsed', function () {
      var els = ui.left.querySelectorAll('.bx-lore-elapsed');
      if (!els.length || !st.open) { T.clear('lore-elapsed'); return; }
      for (var i = 0; i < els.length; i++) els[i].textContent = elapsedFor(els[i].getAttribute('data-id')) + ' s';
    }, 1000);
  }

  /* ----------------------------------------------------------- combat -- */
  /* What works on it, grouped the way a hunter thinks about it. Each row's
     icon is the contract's own (bx-calm…), falling back to the older sc-*
     glyph until the art lands. `more` rows are read by the round-2 DLL only:
     drawn when the key is present, never as "Not read yet" against an older one. */
  var AFF = [
    { k: 'calm', name: 'Calm', icon: 'bx-calm', fb: 'sc-illusion', g: 'mind' },
    { k: 'fear', name: 'Fear', icon: 'bx-fear', fb: 'sc-illusion', g: 'mind' },
    { k: 'frenzy', name: 'Frenzy', icon: 'bx-frenzy', fb: 'sc-illusion', g: 'mind' },
    { k: 'paralysis', name: 'Paralysis', icon: 'bx-paralysis', fb: 'sc-alteration', g: 'body' },
    { k: 'force', name: 'Unrelenting Force', icon: 'bx-stagger', fb: 'sc-shouts', g: 'body' },
    { k: 'disarm', name: 'Disarm', icon: 'bx-disarm', fb: 'sc-shouts', g: 'body', more: true },
    { k: 'soultrap', name: 'Soul Trap', icon: 'bx-soul', g: 'soul' },
    { k: 'banish', name: 'Banish', icon: 'sc-conjuration', g: 'soul' },
    { k: 'command', name: 'Command', icon: 'bx-command', fb: 'sc-illusion', g: 'soul', more: true },
    { k: 'reanimate', name: 'Reanimate', icon: 'bx-reanimate', fb: 'sc-conjuration', g: 'soul', more: true },
    { k: 'turn', name: 'Turn Undead', icon: 'sc-restoration', g: 'soul' },
    { k: 'silver', name: 'Silver', icon: 'bx-silver', g: 'banes' },
    { k: 'sun', name: 'Sunlight', icon: 'bx-sun', g: 'banes' }
  ];
  var AFF_GROUPS = [{ g: 'mind', name: 'Mind' }, { g: 'body', name: 'Body' }, { g: 'soul', name: 'Soul' }, { g: 'banes', name: 'Banes' }];
  var ELEMENTS = { fire: 'fire', frost: 'frost', shock: 'shock', poison: 'poison' };
  var EL_NAME = { fire: 'Fire', frost: 'Frost', shock: 'Shock', poison: 'Poison', magic: 'Magic', disease: 'Disease' };

  /* kept as an alias: the one header, with its medallion (sub is no longer drawn) */
  function compactHeader(e, c, sub) { return header(e, c, { medal: true }); }

  /* bars fill (transform:scaleX) only on a page turn, 30 ms apart */
  function gcls() { return st.anim ? ' bx-grow' : ''; }
  function gsty(i) { return st.anim ? 'animation-delay:' + Math.min(i * 30, 300) + 'ms;' : ''; }
  function resistRows(e) {
    return [{ k: 'physical', name: 'Physical', icon: 'res-armor', v: e.physical || 0, note: 'from its armour' }]
      .concat(RES.map(function (r) { return { k: r.k, name: r.name, icon: 'res-' + r.k, v: (e.resist || {})[r.k] || 0 }; }));
  }
  /* weak to / resists / immune, as chips: the profile above, read at a glance */
  function resistChips(e) {
    var g = { weak: [], res: [], imm: [] };
    resistRows(e).forEach(function (r) { if (r.v < 0) g.weak.push(r); else if (r.v >= 100) g.imm.push(r); else if (r.v > 0) g.res.push(r); });
    var chip = function (r, cls, t) { return '<span class="bx-chip ' + cls + '">' + img(r.icon) + '<span>' + r.name + '</span>' + (t ? '<b>' + t + '</b>' : '') + '</span>'; };
    return '<div class="bx-chips">' +
      '<div class="bx-chips-g"><span class="bx-chips-k">Weak to</span>' + (g.weak.length ? g.weak.map(function (r) { return chip(r, 'bx-cw', '+' + Math.abs(r.v) + '%'); }).join('') : '<span class="bx-chips-none">nothing</span>') + '</div>' +
      (g.res.length ? '<div class="bx-chips-g"><span class="bx-chips-k">Resists</span>' + g.res.map(function (r) { return chip(r, 'bx-cr', r.v + '%'); }).join('') + '</div>' : '') +
      (g.imm.length ? '<div class="bx-chips-g"><span class="bx-chips-k">Immune to</span>' + g.imm.map(function (r) { return chip(r, 'bx-ci', ''); }).join('') + '</div>' : '') +
      '</div>';
  }

  /* one row: icon, name and verdict; under it ONE detail line (the level
     gauge, or the reason) and, when a spell answered, its source */
  function affRow(e, x, v) {
    if (!v) v = { s: 'unread', word: 'Not read yet', cls: 'bx-unread-t', why: '' };
    var lvl = v.lvl != null ? v.lvl : (typeof e.level === 'number' ? e.level : null), h = '';
    var pill = v.cls === 'bx-part' && v.pct != null
      ? '<span class="bx-pill bx-part" style="background:linear-gradient(90deg, rgba(212,174,98,.34) ' + v.pct + '%, rgba(212,174,98,.08) ' + v.pct + '%)">' + esc(v.word) + '</span>'
      : '<span class="bx-pill ' + v.cls + '">' + esc(v.word) + '</span>';
    var tip = [x.name + ': ' + v.word, v.why, v.dual != null ? 'Dual-cast: up to level ' + v.dual : '', v.spell ? v.spell + (v.plugin ? ' (' + v.plugin + ')' : '') + (v.known ? ', you know it' : '') : ''].filter(Boolean).join(' · ');
    h += '<div class="bx-affr ' + v.cls + '" title="' + esc(tip) + '">' + img(x.icon, x.fb, 'bx-affr-i') + '<div class="bx-affr-b"><div class="bx-affr-top"><span class="bx-affr-name">' + esc(x.name) + '</span>' + pill + '</div>';
    if (v.cap != null) {
      var max = Math.max(v.cap, lvl || 0, v.dual || 0) + 5, at = function (n) { return (100 * n / max).toFixed(1) + '%'; };
      h += '<div class="bx-gline"><span class="bx-gauge"><span class="bx-gauge-fill" style="width:' + at(v.cap) + '"></span>' +
        (v.dual != null && v.dual > v.cap ? '<i class="bx-gauge-dual" style="left:' + at(v.dual) + '"></i>' : '') +
        '<i class="bx-gauge-cap" style="left:' + at(v.cap) + '"></i>' + (lvl != null ? '<i class="bx-gauge-it" style="left:' + at(lvl) + '"></i>' : '') + '</span>' +
        '<span class="bx-gauge-k">' + (lvl != null ? 'this one <b class="bx-it">' + lvl + '</b>' : 'cap <b>' + v.cap + '</b>') +
        (v.dual != null && v.dual !== v.cap ? ' \u00B7 dual <b>' + v.dual + '</b>' : '') + '</span></div>';
    } else if (v.why) h += '<div class="bx-affr-why">' + esc(v.why) + '</div>';
    else if (v.dual != null) h += '<div class="bx-affr-why">Dual-cast: up to ' + v.dual + '</div>';
    if (v.spell) h += '<div class="bx-affr-src">' + esc(v.spell) + (v.plugin ? ' · ' + esc(v.plugin) : '') + (v.known ? ' · you know it' : '') + '</div>';
    return h + '</div></div>';
  }
  /* The rows a hunter acts on. The flat answers fold into footer lines, one
     each: "Does not apply" (not undead, not summoned), "No effect" (a plain
     no with no level in it) and "Normal harm" (a bane that is not one here). */
  function affSection(e) {
    var a = e.affects;
    if (!a) return '<section><div class="bx-sect-h">What works on it</div><div class="bx-quiet">Read the next time one is near: which spells, shouts and banes take hold of it.</div></section>';
    var groups = {}, fold = { na: [], no: [], plain: [] };
    var why = function (v) { return v.why ? '<i class="bx-why"> (' + esc(v.why.charAt(0).toLowerCase() + v.why.slice(1)) + ')</i>' : ''; };
    AFF.forEach(function (x) {
      if (x.more && a[x.k] == null) return;
      var v = normAff(a[x.k], x.k);
      if (v && v.s === 'na') { fold.na.push(esc(x.name) + why(v)); return; }
      if (v && v.cls === 'bx-plain') { fold.plain.push(esc(x.name)); return; }
      if (v && v.s === 'no' && v.cap == null) { fold.no.push(esc(x.name) + why(v)); return; }
      (groups[x.g] = groups[x.g] || []).push(affRow(e, x, v));
    });
    /* a ledger: the group's name stands in its own column beside its rows
       (placed explicitly, two rows to a line), so the heads cost no height.
       No ledger line is ever left half empty (Rober, 2026-10-10: "not a huge
       fan of blank inline space"): the last odd group's hole takes the folded
       answers (no effect / normal harm / does not apply) as a tile of their
       own, and any other odd group's last row runs the full width. */
    var parts = [['No effect', fold.no], ['Normal harm', fold.plain], ['Does not apply', fold.na]].filter(function (p) { return p[1].length; });
    var odd = AFF_GROUPS.filter(function (g) { return groups[g.g] && groups[g.g].length % 2; });
    var fillG = parts.length && odd.length ? odd[odd.length - 1].g : null;
    var h = '', r = 1;
    AFF_GROUPS.forEach(function (g) {
      var rows = groups[g.g]; if (!rows) return;
      var n = Math.ceil(rows.length / 2);
      h += '<div class="bx-aff-g" style="grid-column:1;grid-row:' + r + ' / span ' + n + '"><span>' + g.name + '</span></div>';
      rows.forEach(function (x, i) {
        var wide = i === rows.length - 1 && rows.length % 2 && g.g !== fillG;
        h += x.replace('<div class="bx-affr ', '<div style="grid-column:' + (wide ? '2 / span 2' : 2 + i % 2) + ';grid-row:' + (r + Math.floor(i / 2)) + '" class="bx-affr ' + (wide ? 'bx-affr-wide ' : ''));
      });
      if (g.g === fillG)
        h += '<div class="bx-aff-fold" style="grid-column:3;grid-row:' + (r + n - 1) + '">' + parts.map(function (p) {
          return '<div class="bx-aff-fold-g"><span class="bx-aff-na-k">' + p[0] + '</span><span>' + p[1].join(' \u00B7 ') + '</span></div>';
        }).join('') + '</div>';
      r += n;
    });
    var line = function (k, list) { return list.length ? '<span class="bx-aff-na-g"><span class="bx-aff-na-k">' + k + '</span>' + list.join(' \u00B7 ') + '</span>' : ''; };
    var folded = fillG ? '' : line('No effect', fold.no) + line('Normal harm', fold.plain) + line('Does not apply', fold.na);
    return '<section class="bx-aff-sect"><div class="bx-sect-h">What works on it</div>' + (h ? '<div class="bx-aff">' + h + '</div>' : '') +
      (folded ? '<div class="bx-aff-na">' + folded + '</div>' : '') + '</section>';
  }

  /* its spells, shouts, powers and attacks: four of each on the page, the rest in a popout */
  var KIND_ICON = { shout: 'sc-shouts', spell: 'sc-destruction', power: 'sc-powers', attack: 'bx-combat' };
  function armRow(a) {
    var el = a.element && EL_NAME[a.element] ? 'res-' + a.element : KIND_ICON[a.kind] || 'bx-combat';
    return '<span class="bx-arm" data-q="' + esc((a.name + ' ' + (a.kind || '') + ' ' + (a.element || '') + ' ' + (a.plugin || '')).toLowerCase()) + '" title="' +
      esc([a.name, a.kind, a.element && EL_NAME[a.element], a.plugin].filter(Boolean).join(' · ')) + '">' + img(el, 'bx-combat') +
      '<span class="bx-arm-name">' + esc(a.name || 'Unnamed') + '</span><span class="bx-arm-meta">' + esc(a.kind || '') + '</span></span>';
  }
  function atkRow(a) {
    var chips = [a.power && 'power', a.bash && 'bash', a.charge && 'charge'].filter(Boolean);
    return '<span class="bx-arm bx-atk' + (a.knock ? ' bx-knock' : '') + '" data-q="' + esc((a.name + ' ' + chips.join(' ') + (a.knock ? ' knocks you down' : '')).toLowerCase()) + '" title="' +
      esc([a.name, a.mult ? '×' + (+a.mult).toFixed(1) + ' damage' : '', chips.join(', '), a.knock ? 'knocks you down' : '', a.spell].filter(Boolean).join(' · ')) + '">' +
      img(a.knock ? 'bx-stagger' : a.power ? 'rt-ferocity' : 'bx-combat', a.knock ? 'sc-shouts' : '') +
      '<span class="bx-arm-name">' + esc(a.name || 'Strike') + '</span>' + (a.mult ? '<span class="bx-mult">×' + (+a.mult).toFixed(1) + '</span>' : '') +
      (a.knock ? '<span class="bx-arm-meta bx-red">knocks you down</span>' : chips.length ? '<span class="bx-arm-meta">' + chips.join(' · ') + '</span>' : '') + '</span>';
  }
  /* How it fights: its style, its temper, and what it carries into the fight
     (its arsenal: the spells, shouts and powers it was seen to use, then its
     attacks). The chips that do not fit open the arsenal popout. */
  var ARM_ON_PAGE = 3;
  function fightsSection(e) {
    var sy = e.style, f = e.fights, all = e.arsenal.map(armRow).concat(e.attacks.map(atkRow));
    if (!sy && !f && !all.length) return '';
    /* the button is always there when it has chips: with three or fewer it shows
       only once fold 4 has taken the chips off the page (.bx-more-fold) */
    var h = '<section><div class="bx-sect-h">How it fights' + (all.length ? '<button class="bx-more' + (all.length > ARM_ON_PAGE ? '' : ' bx-more-fold') +
      '" data-act="arsenal">Its whole arsenal · ' + all.length + ' ›</button>' : '') + '</div>';
    if (sy) {
      var parts = [['Melee', sy.melee, 'bx-s1'], ['Ranged', sy.ranged, 'bx-s2'], ['Magic', sy.magic, 'bx-s3'], ['Shouts', sy.shout, 'bx-s4'], [sy.otherName || 'Other', sy.other, 'bx-s5']]
        .filter(function (x) { return x[1] > 0; });
      if (parts.length) {
        h += '<div class="bx-style' + gcls() + '" style="' + gsty(1) + '">' + parts.map(function (x) { return '<span class="bx-style-seg ' + x[2] + '" style="width:' + x[1] + '%"></span>'; }).join('') + '</div>' +
          '<div class="bx-style-key">' + parts.map(function (x) { return '<span><i class="bx-style-chip ' + x[2] + '"></i>' + esc(x[0]) + ' ' + x[1] + '%</span>'; }).join('') +
          (sy.offense === 'presses' ? '<span class="bx-tag">Presses the attack</span>' : sy.offense === 'holds' ? '<span class="bx-tag">Holds back</span>' : '') + '</div>';
      }
      if (sy.basis === 'default') h += '<div class="bx-style-note">Fights like any beast: tooth and claw. It carries no combat style of its own.</div>';
    }
    if (f) {
      var facts = [['bx-reach', 'Reach', f.reach], ['rt-ferocity', 'Temper', f.temper], ['rt-tough', 'Courage', f.courage]].filter(function (x) { return x[2]; });
      if (facts.length) h += '<div class="bx-facts">' + facts.map(function (x) {
        return '<div class="bx-fact">' + img(x[0]) + '<div><div class="bx-fact-v">' + esc(x[2]) + '</div><div class="bx-fact-k">' + x[1] + '</div></div></div>';
      }).join('') + '</div>';
      if (f.power) h += '<div class="bx-power">' + img('bx-combat') + '<span class="bx-power-k">Power attacks</span><span class="bx-power-v">' + esc(f.power) + '</span></div>';
    }
    if (all.length) h += '<div class="bx-arsenal">' + all.slice(0, ARM_ON_PAGE).join('') + '</div>';
    return h + '</section>';
  }
  function recordsSection(e) {
    var rc = e.records;
    if (!rc || typeof rc !== 'object') return '';
    var cells = [
      ['bx-hourglass', 'Fastest kill', rc.fastest], ['bx-hourglass', 'Longest fight', rc.longest], ['bx-close', 'Closest call', rc.closest],
      ['bx-combat', 'Most in a day', rc.bestDay], ['bx-grave', 'It killed you', rc.deaths ? rc.deaths + (rc.deaths === 1 ? ' time' : ' times') : 'Never'], ['rt-ferocity', 'It struck first', rc.ambushed]
    ].filter(function (x) { return x[2]; });
    return '<section><div class="bx-sect-h">Your fights with it</div><div class="bx-recs">' + cells.map(function (x) {
      return '<div class="bx-rec">' + img(x[0]) + '<div style="min-width:0"><div class="bx-rec-v">' + esc(x[2]) + '</div><div class="bx-rec-k">' + x[1] + '</div></div></div>';
    }).join('') + '</div></section>';
  }

  /* HUNTER'S COUNSEL: read off the page's own numbers, never the Scribe's.
     Offence: the element to use, whether to stagger-lock, whether its soul is
     worth a gem, whether it runs, its banes. Defence (round-2 DLL: its arsenal
     and your resists): what each of its elements will do to you. */
  function counsel(e, p) {
    var off = [], def = [], r = e.resist || {}, af = e.affects || {}, flags = e.flags || [];
    var A = function (k) { return normAff(af[k], k); };
    var best = null;
    ['fire', 'frost', 'shock'].forEach(function (k) { var v = r[k]; if (v != null && (!best || v < best.v)) best = { k: k, v: v }; });
    if (best) {
      if (best.v < 0) off.push(['res-' + best.k, 'Use <b>' + best.k + '</b>: it takes ' + (-best.v) + '% more.']);
      else if (best.v >= 100) off.push(['res-magic', 'No element touches it: use <b>steel</b>.']);
      else off.push(['res-' + best.k, 'No weakness. Its thinnest guard is <b>' + best.k + '</b>.']);
    }
    if (e.physical != null && e.physical >= 60) off.push(['res-armor', 'Armour turns <b>' + e.physical + '%</b> of a blade: use spells.']);
    var fz = A('force'), nk = flags.indexOf('noKnockdown') >= 0 || flags.indexOf('immobile') >= 0;
    if (!nk && fz && (fz.s === 'yes' || fz.s === 'weak')) off.push(['bx-stagger', 'It can be thrown: <b>stagger-lock</b> it.', 'sc-shouts']);
    else if (nk || (fz && fz.s === 'no')) off.push(['bx-stagger', 'It <b>will not go down</b>: skip the stagger.', 'sc-shouts']);
    var soul = String((e.body || {}).soul || ''), stp = A('soultrap');
    if (stp && stp.s === 'no') off.push(['bx-soul', '<b>No soul</b> to take: keep your gems.']);
    else if (/grand|greater|black/i.test(soul)) off.push(['bx-soul', '<b>Soul Trap</b> it first: a ' + soul.toLowerCase() + ' soul.']);
    else if (soul && !/none/i.test(soul)) off.push(['bx-soul', 'A ' + soul.toLowerCase() + ' soul: a small gem will do.']);
    var cour = String((e.fights || {}).courage || '');
    if (/never/i.test(cour)) off.push(['rt-tough', 'It <b>never flees</b>: it fights to the death.']);
    else if (/flee/i.test(cour)) off.push(['bx-speed', 'It <b>flees</b> ' + cour.replace(/^\s*flees\s*/i, '') + ': keep a bow ready.']);
    if ((A('silver') || {}).s === 'weak') off.push(['bx-silver', '<b>Silver</b> bites deeper than steel.']);
    if ((A('sun') || {}).s === 'weak') off.push(['bx-sun', '<b>Sunlight</b> burns it: hunt by day.']);
    var tu = A('turn');
    if (tu && tu.s === 'yes') off.push(['sc-restoration', '<b>Turn Undead</b> works' + (tu.cap != null ? ', up to level ' + tu.cap : '') + '.']);
    var cm = A('calm');
    if (cm && cm.s === 'yes' && cm.cap != null) off.push(['bx-calm', '<b>Calm</b> holds it, up to level ' + cm.cap + '.', 'sc-illusion']);
    var regen = String((e.body || {}).regen || '');
    if (flags.indexOf('regenInCombat') >= 0 || /[1-9]/.test(regen)) off.push(['bx-regen', 'It <b>heals mid-fight</b>: do not let it rest.']);

    var pr = p && p.resist;
    if (pr && (e.arsenal.length || e.attacks.length)) {
      var seen = {};
      e.arsenal.forEach(function (a) {
        var el = a.element;
        if (!el || seen[el]) return;
        seen[el] = 1;
        if (el === 'disease') { def.push(['res-disease', '<b>' + esc(a.name) + '</b> carries disease: cure it after.']); return; }
        var v = pr[el];
        if (v == null) return;
        def.push(['res-' + el, 'Its <b>' + esc(a.name) + '</b> meets your ' + v + '% ' + el + ' resist: ' +
          (v >= 80 ? 'you can stand in it.' : v >= 40 ? 'it stings, no more.' : 'drink <b>Resist ' + EL_NAME[el] + '</b>.')]);
      });
      if (e.arsenal.some(function (a) { return a.kind === 'shout'; })) def.push(['sc-shouts', 'It <b>uses the Voice</b>: break line of sight.']);
      if (e.attacks.some(function (a) { return a.knock; })) def.push(['bx-stagger', 'It can <b>knock you down</b>: mind the ledges.', 'sc-shouts']);
      var hd = (e.vs || {}).hardest;
      if (hd != null && hd >= 35) def.push(['bx-close', 'Its hardest blow takes <b>' + hd + '%</b> of you: block it.']);
    }
    /* the defence a page can always read: how fast, how far, how hard */
    var spd = String((e.body || {}).speed || ''), reach = parseFloat((e.fights || {}).reach), sty = e.style || {};
    if (/outruns|faster/i.test(spd)) def.push(['bx-speed', 'It <b>outruns you</b>: stand your ground, do not run.']);
    else if (/outrun it/i.test(spd)) def.push(['bx-speed', 'You can <b>outrun it</b> if the fight turns.']);
    if (reach >= 2) def.push(['bx-reach', 'It reaches <b>' + reach.toFixed(1) + ' m</b>: stand further off than you think.']);
    if ((sty.ranged || 0) + (sty.magic || 0) >= 40) def.push(['res-magic', 'It fights <b>at range</b>: close in or take cover.']);
    var hb = (e.vs || {}).hardest;
    if (hb != null && hb < 35 && !def.some(function (d) { return d[0] === 'bx-close'; })) def.push(['bx-close', 'Its hardest blow takes <b>' + hb + '%</b> of you.']);
    /* two even columns or one even flow, never a column that stops short
       (Rober, 2026-10-10: "not a huge fan of blank inline space") */
    if (off.length >= 2 && def.length >= 2) {
      var n = Math.min(3, Math.max(off.length, def.length));
      if (off.length < n || def.length < n) n = Math.min(off.length, def.length);
      return { off: off.slice(0, n), def: def.slice(0, n) };
    }
    return { off: off.concat(def).slice(0, 6), def: [] };
  }
  function counselSection(e) {
    var c = counsel(e, (st.data && st.data.player) || {});
    if (!c.off.length && !c.def.length) return '';
    var line = function (x) { return '<div class="bx-cl">' + img(x[0], x[2]) + '<span>' + x[1] + '</span></div>'; };
    var col = function (k, list) { return '<div class="bx-cl-col"><div class="bx-cl-k">' + k + '</div>' + list.map(line).join('') + '</div>'; };
    return '<section class="bx-counsel"><div class="bx-sect-h">Hunter’s counsel</div><div class="bx-counsel-in' + (c.def.length ? '' : ' bx-one') + '">' +
      (c.def.length ? col('Offence', c.off) + col('Defence', c.def) : '<div class="bx-cl-flow">' + c.off.map(line).join('') + '</div>') + '</div></section>';
  }

  function renderCombat(e) {
    var c = chOf(e.chapter), head = folioHead(e, c, 'combat');
    if (!e.resist) {
      ui.left.className = 'bx-page bx-left';
      setHTML(ui.left, head + '<div class="bx-page-in"><section class="bx-unread">' + img('bx-combat') +
        '<b>Not yet measured in battle</b><span>Its resistances, what works on it and how it fights are read from the creature itself, the next time one is near.</span></section></div>');
      ui.right.className = 'bx-page bx-right';
      setHTML(ui.right, '<div class="bx-page-in"><section class="bx-unread">' + img('bx-hourglass') + '<b>No fights recorded</b><span>Your fastest kill, longest fight and closest call are kept from your next fight with one.</span></section></div>');
      return;
    }
    /* ---- left: resistance profile, then the duel takes the rest ---- */
    var L = head + '<div class="bx-page-in bx-combat-l">';
    L += '<section><div class="bx-sect-h">Resistance profile</div><div class="bx-rp-scale"><span>Weak</span><span>Even</span><span>Resists</span></div><div class="bx-rp">' + resistRows(e).map(function (r, i) {
      var v = Math.max(-100, Math.min(100, r.v)), cls = r.v >= 100 ? 'bx-immune' : r.v < 0 ? 'bx-weak' : r.v > 0 ? 'bx-strong' : 'bx-none';
      var txt = r.v >= 100 ? 'Immune' : r.v === 0 ? '—' : (r.v > 0 ? '+' : '−') + Math.abs(r.v) + '%';
      var bar = v === 0 ? '' : '<span class="bx-rp-fill ' + (v > 0 ? 'bx-pos' : 'bx-neg') + gcls() + '" style="' + gsty(i) + (v > 0 ? 'left:50%;width:' + (v / 2) + '%' : 'right:50%;width:' + (-v / 2) + '%') + '"></span>';
      return '<div class="bx-rp-row ' + cls + '">' + img(r.icon) + '<span class="bx-rp-name">' + r.name + (r.note ? '<i>' + r.note + '</i>' : '') +
        '</span><span class="bx-rp-track"><span class="bx-rp-mid"></span>' + bar + '</span><span class="bx-rp-v">' + txt + '</span></div>';
    }).join('') + '</div>' + resistChips(e) + '</section>';
    var vs = e.vs, p = (st.data && st.data.player) || {};
    var diff = (vs && vs.difficulty) || p.difficulty;
    L += '<section class="bx-against"><div class="bx-sect-h">Against you' + (diff ? '<span class="bx-diff">on ' + esc(diff) + '</span>' : '') + '</div>';
    if (vs && vs.yourBlows != null && vs.itsBlows != null) {
      var ratio = vs.itsBlows / Math.max(1, vs.yourBlows), max = Math.max(vs.yourBlows, vs.itsBlows, 1);
      var call = ratio >= 1.5 ? 'You outlast it about <b>' + Math.round(ratio) + ' to 1</b>.' : ratio > 0.67 ? '<b>An even fight.</b> Do not trade blows carelessly.' : 'It outlasts you about <b>' + Math.round(1 / ratio) + ' to 1</b>. Do not stand in front of it.';
      L += '<div class="bx-against-in"><div class="bx-duel">' +
        '<div class="bx-duel-row bx-you"><span class="bx-duel-who">You</span><span class="bx-duel-bar"><span class="' + gcls() + '" style="' + gsty(7) + 'width:' + Math.max(4, 100 * vs.yourBlows / max) + '%"></span></span>' +
          '<span class="bx-duel-n">' + vs.yourBlows + '</span><span class="bx-duel-k">blows of ' + esc(p.weapon || 'your weapon') + (p.dmg ? ' (' + esc(p.dmg) + ' a hit)' : '') + ' to fell it</span></div>' +
        '<div class="bx-duel-row bx-it"><span class="bx-duel-who">It</span><span class="bx-duel-bar"><span class="' + gcls() + '" style="' + gsty(8) + 'width:' + Math.max(4, 100 * vs.itsBlows / max) + '%"></span></span>' +
          '<span class="bx-duel-n">' + vs.itsBlows + '</span><span class="bx-duel-k">strikes to fell you, after your armour</span></div>' +
        '</div><div class="bx-rp-verdict">' + call + '</div>';
      var hard = vs.hardest != null ? vs.hardest : vs.strike;
      if (hard != null) {
        L += '<div class="bx-hard"><div class="bx-hard-top"><span class="bx-hard-k">Its hardest blow</span><span class="bx-hard-v"><b>' + hard + '%</b> of your health' +
          (vs.hardest != null ? (hard >= 100 ? ', a killing blow' : ', power attack included') : ', before armour') + '</span></div>' +
          '<div class="bx-hard-bar"><span class="bx-hard-fill' + gcls() + '" style="' + gsty(9) + 'width:' + Math.min(100, hard) + '%"></span></div></div>';
      }
      L += '</div>';
    } else {
      L += '<div class="bx-against-in bx-against-none">' + img('bx-combat') + '<span>The duel is weighed the next time one is near: how many blows each of you needs, and what its hardest strike takes.</span></div>';
    }
    L += '</section></div>';
    ui.left.className = 'bx-page bx-left';
    setHTML(ui.left, L);

    /* ---- right: what works, its arsenal, how it fights, your fights, the counsel ---- */
    var R = '<div class="bx-page-in bx-combat-r">' + affSection(e) + fightsSection(e) + counselSection(e) + '</div>';
    ui.right.className = 'bx-page bx-right';
    setHTML(ui.right, R);
    fitPage(ui.left.querySelector('.bx-combat-l'), FOLDS.combatL, 'fitL');
    fitPage(ui.right.querySelector('.bx-combat-r'), FOLDS.combatR, 'fitR');
  }
  /* A rich creature (every effect read, a full arsenal, both counsel columns)
     can outgrow the page. Fold, never shrink the type: each step hides the
     least useful detail that is still in a tooltip, a popout or said elsewhere,
     and is taken only while the page still overflows (one layout read per step).
     Combat, right page:
       1 the reasons in the "does not apply" line    (they ride as tooltips)
       2 the reach / temper / courage facts           (courage is in the counsel)
       3 the third line of each counsel column
       4 the arsenal chips                            ("Its whole arsenal" popout)
       5 the level gauge under each effect            (the pill keeps the cap)
       6 the spell-source line back to one line       (the tile's tooltip has it)
       7 the power-attack line                        (the arsenal popout lists them)
     Combat, left page: tighter resistance rows, then the weak/resists/immune
     chips (the profile above says the same), then the "you outlast it" line.
     Field notes, right page: the "May carry" spoils row, the tally's "Levels
     seen" line (the kin line under the name carries it), then tighter gaps
     between the sections, so the Encounters log keeps its three rows.
     Whatever still does not fit scrolls, and says so: belowCue() puts a
     "More below" fade and button on the page edge until it is scrolled to. */
  var FOLDS = {
    combatR: ['bx-fit1', 'bx-fit2', 'bx-fit3', 'bx-fit4', 'bx-fit5', 'bx-fit6', 'bx-fit7'],
    combatL: ['bx-fitl1', 'bx-fitl2', 'bx-fitl3'],
    notesR: ['bx-fitn1', 'bx-fitn2', 'bx-fitn3']
  };
  function overflows(box) { return box.scrollHeight > box.clientHeight + 2; }
  function fitPage(box, steps, key) {
    if (!box) return;
    steps = steps || [];
    for (var k = 0; k < steps.length && overflows(box); k++) box.classList.add(steps[k]);
    belowCue(box);
    syncRail(box);
    /* the first measure can run before the book's fonts (or a late icon) have
       laid out: look again a beat later, and once the fonts are in. A fold is
       only ever added, so a second pass never undoes the first. */
    if (!key) return;
    var again = function () { if (document.body.contains(box)) fitPage(box, steps); };
    T.set(key + '-a', again, 150);
    T.set(key + '-b', again, 800);
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(again); } catch (x) {}
  }
  /* "More below": a fade along the bottom of a box that still overflows, with a
     button that scrolls it a page. Hidden once the box is scrolled to its end.
     It hangs off the box's positioned parent (the page, or the log's section),
     so a page write (setHTML) takes it away with everything else. */
  function belowCue(box) {
    var host = box && box.parentNode;
    if (!host) return;
    for (var i = host.children.length - 1; i >= 0; i--) if (host.children[i].className.indexOf('bx-below') === 0) host.removeChild(host.children[i]);
    if (!overflows(box)) return;
    var cue = document.createElement('div');
    cue.className = 'bx-below';
    cue.innerHTML = '<button type="button" class="bx-below-btn"><span>More below</span><b>›</b></button>';
    host.appendChild(cue);
    var place = function () {
      cue.style.left = box.offsetLeft + 'px';
      cue.style.width = box.clientWidth + 'px';
      cue.style.top = (box.offsetTop + box.clientHeight - cue.offsetHeight) + 'px';
    };
    var sync = function () { cue.classList.toggle('bx-below-done', box.scrollTop + box.clientHeight >= box.scrollHeight - 4); };
    place(); sync();
    box.addEventListener('scroll', sync);
    cue.querySelector('button').addEventListener('click', function (ev) {
      ev.stopPropagation();
      box.scrollTop = Math.min(box.scrollHeight, box.scrollTop + Math.round(box.clientHeight * 0.8));
      sync();
    });
  }

  /* THE BOOK'S OWN SCROLL RAILS (Rober, 2026-10-12, a grey bar down the middle of
     the right page: "weird line"). Ultralight paints its native scrollbar where
     IT thinks the box is, and in game that was a page-width short of the page's
     edge, drawn over the stats; the offline engine (device scale 1) put it right,
     so it cannot be trusted. The native bar is hidden (hd-bestiary.css) and each
     scroller gets a plain element instead, placed from the box's measured rect -
     the same coordinates the content itself is laid out in. */
  var SCROLLERS = '.bx-index, .bx-results, .bx-page-in, .bx-log, .bx-list, .bx-modal-body, .bx-combo-list';
  function railFor(box) {
    var host = box.parentNode;
    if (!host || !host.getBoundingClientRect) return null;
    var r = box._bxRail;
    if (!r || r.parentNode !== host) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      r = document.createElement('div');
      r.className = 'bx-rail';
      r.innerHTML = '<div class="bx-rail-thumb"></div>';
      host.appendChild(r);
      box._bxRail = r;
    }
    return r;
  }
  function syncRail(box) {
    var over = box.scrollHeight > box.clientHeight + 2;
    var r = over ? railFor(box) : box._bxRail;
    if (!r) return;
    if (!over || !box.offsetParent) { r.style.display = 'none'; return; }
    var hr = box.parentNode.getBoundingClientRect(), br = box.getBoundingClientRect();
    var hs = getComputedStyle(box.parentNode), bl = parseFloat(hs.borderLeftWidth) || 0, bt = parseFloat(hs.borderTopWidth) || 0;
    var w = Math.max(4, Math.round(6 * U())), pad = Math.round(4 * U()), track = Math.max(0, br.height - 2 * pad);
    var th = Math.max(Math.round(40 * U()), Math.round(track * box.clientHeight / box.scrollHeight));
    var span = Math.max(1, box.scrollHeight - box.clientHeight), top = Math.round((track - th) * Math.min(1, box.scrollTop / span));
    r.style.display = '';
    r.style.left = Math.round(br.right - hr.left - bl - w - Math.round(2 * U())) + 'px';
    r.style.top = Math.round(br.top - hr.top - bt + pad) + 'px';
    r.style.width = w + 'px';
    r.style.height = track + 'px';
    var t = r.firstChild;
    t.style.height = th + 'px';
    t.style.transform = 'translateY(' + top + 'px)';
  }
  function syncRails() {
    if (!root || !st.open) return;
    var list = root.querySelectorAll(SCROLLERS);
    for (var i = 0; i < list.length; i++) syncRail(list[i]);
  }
  /* after a draw, and again once late images and fonts have laid out */
  function railsSoon() {
    syncRails();
    T.set('rails-a', syncRails, 120);
    T.set('rails-b', syncRails, 700);
  }

  /* --------------------------------------------------------- contents -- */
  /* chapters[ch].byPlugin -> [{plugin, known, met}], summed over every
     chapter for "All Kinds"; null from an older DLL (the unseen[] list then) */
  function pluginGroups(ch) {
    var cs = (st.data && st.data.chapters) || {}, agg = {}, any = false;
    var add = function (bp) {
      if (!bp || typeof bp !== 'object') return;
      any = true;
      for (var p in bp) {
        var g = agg[p] = agg[p] || { plugin: p, known: 0, met: 0 }, v = bp[p] || {};
        g.known += +v.known || 0; g.met += +v.met || 0;
      }
    };
    if (ch === 'all') { for (var k in cs) add(cs[k] && cs[k].byPlugin); } else add((cs[ch] || {}).byPlugin);
    if (!any) return null;
    return Object.keys(agg).map(function (k) { return agg[k]; })
      .sort(function (a, b) { return ((b.known - b.met) - (a.known - a.met)) || a.plugin.localeCompare(b.plugin); });
  }
  var SLOT_FOLD = 12, GROUPS_ON_PAGE = 6;
  function slots(n, ch) {
    var g = icon(chOf(ch).icon), h = '';
    for (var i = 0; i < n; i++) h += '<span class="bx-slot"><img src="' + g + '" alt=""></span>';
    return h;
  }
  function silGroup(g, ch, cap) {
    var un = Math.max(0, g.known - g.met), pct = g.known ? Math.round(100 * g.met / g.known) : 0, shown = cap ? Math.min(un, SLOT_FOLD) : un;
    return '<div class="bx-sil-g" data-q="' + esc(g.plugin.toLowerCase()) + '"><div class="bx-sil-h"><span class="bx-sil-name">' + esc(g.plugin) + '</span><span class="bx-sil-n"><b>' + g.met + '</b> of ' + g.known + ' met</span>' +
      '<span class="bx-sil-bar"><span style="transform:scaleX(' + (pct / 100).toFixed(3) + ')"></span></span></div>' +
      '<div class="bx-sil">' + slots(shown, ch) + (cap && un > shown ? '<button class="bx-slot bx-slot-more" data-act="unseen" data-plugin="' + esc(g.plugin) + '" title="Every kind not yet met, by mod">+' + (un - shown) + ' ›</button>' : '') + '</div></div>';
  }
  function rowHTML(e, i) {
    var rise = st.anim && i < 10;
    return '<button class="bx-row' + (rise ? ' bx-rise' : '') + (st.sel === e.id ? ' bx-on' : '') + '"' + (rise ? ' style="animation-delay:' + (i * 30) + 'ms"' : '') +
      ' data-act="goto" data-id="' + esc(e.id) + '" title="' + esc(e.name) + '">' + thumb(e) +
      '<span class="bx-row-text"><div class="bx-row-name"><span class="bx-row-nm">' + esc(e.name) + '</span>' + (e.unique ? '<span class="bx-uniq">Unique</span>' : '') + '</div><div class="bx-row-meta">' + esc(humanKin(e.family || e.race || '')) + ' · ' +
      esc(st.chapter === 'all' ? chOf(e.chapter).name : (e.plugin || '')) + (e.levelRange ? ' · ' + esc(e.levelRange) : '') + '</div></span>' +
      '<span class="bx-row-side"><span class="bx-row-threat">' + skulls(tier(e)) + '<span class="bx-tierword bx-tw' + tier(e) + '">' + (TIER[tier(e)] || 'Unweighed') + '</span></span>' +
      '<span class="bx-row-kills"><b>' + slain(e) + '</b><span>slain</span></span></span></button>';
  }
  function renderContents() {
    var c = chOf(st.chapter), list = chapterList(c.id), kills = 0, worst = null, most = null;
    list.forEach(function (e) {
      kills += slain(e);
      if (!worst || tier(e) > tier(worst)) worst = e;
      if (!most || slain(e) > slain(most)) most = e;
    });
    var known = knownOf(c.id), pct = known ? Math.min(100, Math.round(100 * list.length / known)) : 0;
    var card = function (e, k, v) {
      if (!e) return '';
      var a = artOf(e);
      return '<button class="bx-feat" data-act="goto" data-id="' + esc(e.id) + '" title="' + esc(e.name) + '"><span class="bx-medal bx-medal-xs">' +
        (a ? '<img src="' + esc(a) + '" alt="">' : '<img class="bx-glyph" src="' + icon(chOf(e.chapter).icon) + '" alt="">') +
        '</span><span class="bx-feat-text"><span class="bx-feat-k">' + k + '</span><span class="bx-feat-name">' + esc(e.name) + '</span><span class="bx-feat-v">' + v + '</span></span></button>';
    };
    var tot = st.data.totals || {};
    ui.left.className = 'bx-page bx-left bx-chapter-page';
    setHTML(ui.left, '<div class="bx-page-in"><img class="bx-chapter-art" src="' + icon(c.icon) + '" alt="">' +
      '<div class="bx-chapter-no">' + (c.id === 'all' ? 'The Bestiary entire' : 'Chapter ' + roman(chIndex(c.id))) + '</div><h1 class="bx-chapter-title">' + esc(c.name) + '</h1>' +
      '<div class="bx-chapter-blurb">' + esc(c.blurb) + '</div>' +
      (c.mine ? '<div class="bx-chapter-tools"><button class="bx-mini" data-act="shelf-edit" data-ch="' + esc(c.id) + '">' + img('bx-quill') + '<span>Edit this chapter</span></button></div>' : '') +
      (known ? '<div class="bx-done"><div class="bx-done-top"><span class="bx-done-k">Recorded</span><span class="bx-done-v"><b>' + list.length + '</b> of ' + known +
        ' kinds your load order knows</span><span class="bx-done-pct">' + pct + '%</span></div><div class="bx-done-bar"><span class="' + gcls() + '" style="' + gsty(2) + 'width:' + pct + '%"></span></div></div>' : '') +
      '<div class="bx-chapter-facts"><div class="bx-cf"><div class="bx-cf-v">' + list.length + '</div><div class="bx-cf-k">Kinds</div></div>' +
      '<div class="bx-cf"><div class="bx-cf-v">' + fmt(kills) + '</div><div class="bx-cf-k">Slain</div></div>' +
      (c.id === 'all' && tot.weapon ? '<div class="bx-cf"><div class="bx-cf-v bx-small">' + esc(tot.weapon) + '</div><div class="bx-cf-k">Your blade</div></div>' : '') +
      (c.id === 'all' && tot.hold ? '<div class="bx-cf"><div class="bx-cf-v bx-small">' + esc(tot.hold) + '</div><div class="bx-cf-k">Bloodiest hold</div></div>' : '') +
      '</div>' +
      (list.length ? '<div class="bx-feats">' + card(worst, 'Deadliest', TIER[tier(worst)] || '') + (most && most !== worst ? card(most, 'Most slain', slain(most) + ' slain') : '') + '</div>' : '') +
      '</div>');

    /* the roster: "By mod" groups it under a header per plugin with its progress */
    var groups = pluginGroups(c.id), byP = {};
    (groups || []).forEach(function (g) { byP[g.plugin] = g; });
    var items = [], lastP = null, n = 0;
    list.forEach(function (e) {
      if (st.sort === 'plugin' && e.plugin !== lastP) {
        lastP = e.plugin;
        var g = byP[e.plugin], met = g ? g.met : list.filter(function (x) { return x.plugin === e.plugin; }).length, kn = g ? g.known : 0;
        items.push('<div class="bx-mod-h"><span class="bx-mod-name">' + esc(e.plugin || 'Unknown plugin') + '</span><span class="bx-mod-n"><b>' + met + '</b>' + (kn ? ' of ' + kn : '') + ' met</span>' +
          (kn ? '<span class="bx-sil-bar"><span style="transform:scaleX(' + Math.min(1, met / kn).toFixed(3) + ')"></span></span>' : '') + '</div>');
      }
      items.push(rowHTML(e, n++));
    });
    /* the kinds the load order has that you have not met, as dim medallions
       under the mod that adds them (no names: no spoilers) */
    var un = '', missing = Math.max(0, known - list.length);
    if (groups) {
      var open = groups.filter(function (g) { return g.known > g.met; });
      if (open.length) {
        un += '<div class="bx-unseen-h"><span>Not yet met</span><b>' + missing + '</b></div>' +
          open.slice(0, GROUPS_ON_PAGE).map(function (g) { return silGroup(g, c.id, true); }).join('');
        if (open.length > GROUPS_ON_PAGE) un += '<button class="bx-unseen-more bx-more-btn" data-act="unseen">and ' + (open.length - GROUPS_ON_PAGE) + ' more mods ›</button>';
      }
    } else if (missing) {
      var cs = st.data.chapters || {}, unseen = [];
      if (c.id === 'all') { for (var uk in cs) arr((cs[uk] || {}).unseen).forEach(function (p) { unseen.push({ ch: uk, plugin: p }); }); }
      else arr((cs[c.id] || {}).unseen).forEach(function (p) { unseen.push({ ch: c.id, plugin: p }); });
      var show = unseen.slice(0, 12);
      un += '<div class="bx-unseen-h"><span>Not yet met</span><b>' + missing + '</b></div>';
      show.forEach(function (u) {
        un += '<div class="bx-row bx-locked"><span class="bx-res-thumb"><img class="bx-glyph" src="' +
          icon(chOf(u.ch).icon) + '" alt=""></span><span class="bx-row-text"><div class="bx-row-name">An unknown ' + esc(singular(u.ch)) +
          '</div><div class="bx-row-meta">from ' + esc(u.plugin) + '</div></span><span class="bx-row-side"><span class="bx-locked-k">Unmet</span></span></div>';
      });
      if (missing > show.length) un += '<div class="bx-unseen-more">and ' + (missing - show.length) + ' more, waiting somewhere in Skyrim</div>';
    }
    /* the first 30 rows now, the rest one frame later: a 300-kind chapter
       paints its first screen without waiting for the whole roster */
    var FIRST = 30, rest = items.length > FIRST ? items.slice(FIRST).join('') : '';
    var R = '<div class="bx-page-in"><div class="bx-sect-h">Contents</div><div class="bx-sorts"><span class="bx-sorts-k">Order</span>' +
      SORTS.map(function (s) { return '<button class="bx-sort' + (st.sort === s.k ? ' bx-on' : '') + '" data-act="sort" data-k="' + s.k + '">' + s.name + '</button>'; }).join('') +
      '</div><div class="bx-list" id="bx-list">' +
      (list.length ? '' : '<div class="bx-res-none">' + (c.mine ? 'Nothing filed here yet. Open any creature’s page, then Edit page, Chapter, and choose ' + esc(c.name) + '.' :
        'Nothing in this chapter yet. Its first page is written the first time you kill or study one.') + '</div>') +
      items.slice(0, FIRST).join('') + '<div class="bx-unseen">' + un + '</div></div></div>';
    ui.right.className = 'bx-page bx-right';
    setHTML(ui.right, R);
    if (rest) {
      var gen = ++st.listGen;
      requestAnimationFrame(function () {
        var tail = gen === st.listGen && ui.right.querySelector('.bx-unseen');
        if (!tail) return;
        window.__bxWrites = (window.__bxWrites || 0) + 1;
        tail.insertAdjacentHTML('beforebegin', rest);
      });
    }
  }
  function singular(ch) {
    return { all: 'kind', beast: 'beast', monster: 'monster', undead: 'undead thing', daedra: 'daedra', dragon: 'dragon', dwarven: 'Dwemer construct',
             giant: 'giant beast', falmer: 'Falmer kind', folk: 'outlaw', unknown: 'creature' }[ch] || 'creature';
  }
  /* contents keyboard: a selected row (.bx-on) walked by the arrows */
  function moveSel(d) {
    var rows = ui.right.querySelectorAll('.bx-row[data-id]');
    if (!rows.length) return;
    var at = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-id') === st.sel) at = i;
    var nx = at < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + d));
    if (at >= 0) rows[at].classList.remove('bx-on');
    rows[nx].classList.add('bx-on');
    st.sel = rows[nx].getAttribute('data-id');
    try { rows[nx].scrollIntoView({ block: 'nearest' }); } catch (x) { rows[nx].scrollIntoView(false); }
  }

  /* ------------------------------------------------- the list popout --- */
  /* The deck's long-list idiom: anything longer than the page holds opens in
     a body-anchored popout with a filter box (every unmet kind by mod; a
     creature's whole arsenal). It owns the keyboard while up. */
  function openList(title, sub, bodyHTML, focusQ) {
    st.list = { title: title };
    st.foldQ = '';
    setHTML(ui.modalBack, '<div class="bx-modal bx-modal-list bx-modal-in" role="dialog" aria-label="' + esc(title) + '">' +
      '<div class="bx-modal-head">' + img('bx-all') + '<div><div class="bx-modal-title">' + esc(title) + '</div><div class="bx-modal-sub">' + esc(sub) + '</div></div>' +
      '<button class="bx-tool bx-close" data-act="list-close" title="Close (Esc)">×</button></div>' +
      '<div class="bx-modal-body"><div class="bx-input bx-focus" id="bx-list-box">' + img('sn-search') + '<input id="bx-list-q" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false"></div>' +
      '<div class="bx-list-body" id="bx-list-body">' + bodyHTML + '</div><div class="bx-res-none bx-hidden" id="bx-list-none">Nothing matches.</div></div></div>');
    ui.modalBack.classList.remove('bx-hidden'); railsSoon();
    var q = document.getElementById('bx-list-q');
    q.addEventListener('input', function () { st.foldQ = q.value; T.set('list-q', filterList, 80); });
    q.focus();
    if (focusQ) { q.value = st.foldQ = focusQ; filterList(); }
  }
  function filterList() {
    var q = st.foldQ.trim().toLowerCase(), body = document.getElementById('bx-list-body'), shown = 0;
    if (!body) return;
    var items = body.querySelectorAll('[data-q]');
    for (var i = 0; i < items.length; i++) { var on = !q || items[i].getAttribute('data-q').indexOf(q) >= 0; items[i].classList.toggle('bx-hidden', !on); if (on) shown++; }
    var none = document.getElementById('bx-list-none'); if (none) none.classList.toggle('bx-hidden', shown > 0);
  }
  function closeList() { st.list = null; ui.modalBack.classList.add('bx-hidden'); setHTML(ui.modalBack, ''); }
  function openUnseen(plugin) {
    var groups = (pluginGroups(st.chapter) || []).filter(function (g) { return g.known > g.met; });
    var miss = 0; groups.forEach(function (g) { miss += g.known - g.met; });
    openList('Not yet met', miss + ' kinds in ' + groups.length + ' mods, still out there. Filter by mod.', groups.map(function (g) { return silGroup(g, st.chapter, false); }).join(''), plugin || '');
  }
  function openArsenal() {
    var e = byId(st.id); if (!e) return;
    /* the popout has room for the whole line: kind, element, plugin, damage */
    var row = function (icn, fb, name, meta, q, red) {
      return '<div class="bx-armx" data-q="' + esc(q.toLowerCase()) + '">' + img(icn, fb) + '<div class="bx-armx-t"><div class="bx-armx-name">' + name + '</div>' +
        '<div class="bx-armx-meta' + (red ? ' bx-red' : '') + '">' + meta + '</div></div></div>';
    };
    var ars = e.arsenal.map(function (a) {
      var el = a.element && EL_NAME[a.element] ? 'res-' + a.element : KIND_ICON[a.kind] || 'bx-combat';
      var meta = [a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : '', a.element ? EL_NAME[a.element] || a.element : '', a.plugin].filter(Boolean).map(esc).join(' \u00B7 ');
      return row(el, 'bx-combat', esc(a.name || 'Unnamed'), meta, [a.name, a.kind, a.element, a.plugin].join(' '));
    });
    var atk = e.attacks.map(function (a) {
      var bits = [a.mult ? '\u00D7' + (+a.mult).toFixed(1) + ' damage' : '', a.power && 'power attack', a.bash && 'bash', a.charge && 'charge', a.knock && 'knocks you down', a.spell].filter(Boolean);
      return row(a.knock ? 'bx-stagger' : a.power ? 'rt-ferocity' : 'bx-combat', a.knock ? 'sc-shouts' : '', esc(a.name || 'Strike'), esc(bits.join(' \u00B7 ')), [a.name].concat(bits).join(' '), a.knock);
    });
    openList('Its arsenal', e.name + ' \u00B7 every spell, shout, power and attack it was seen to use',
      (ars.length ? '<div class="bx-armx-h">Spells, shouts and powers \u00B7 ' + ars.length + '</div><div class="bx-armx-grid">' + ars.join('') + '</div>' : '') +
      (atk.length ? '<div class="bx-armx-h">Attacks \u00B7 ' + atk.length + '</div><div class="bx-armx-grid">' + atk.join('') + '</div>' : ''));
  }

  /* ------------------------------------------------------------- foot -- */
  /* The page order is: specimen(A), notes(A), specimen(B), notes(B), … */
  function neighbours() {
    var e = byId(st.id); if (!e) return {};
    var list = chapterList(st.chapter === 'all' ? 'all' : e.chapter);
    var i = -1; for (var k = 0; k < list.length; k++) if (list[k].id === e.id) i = k;
    return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null, i: i, n: list.length };
  }
  var KEYS = {
    entry: [['← →', 'turn'], ['Tab', 'folio'], ['Q E', 'rotate'], ['Bksp', 'contents'], ['/', 'search'], ['Esc', 'close']],
    contents: [['↑ ↓', 'choose'], ['Enter', 'open'], ['[ ]', 'chapter'], ['A–Z', 'search'], ['Esc', 'close']],
    studying: [['Esc', 'close']]   // nothing else answers while the measure is taken
  };
  /* built once per kind of view, then only patched: a folio turn rewrites two
     labels and moves one .bx-on, never the whole bar */
  function renderFoot() {
    var kind = st.view === 'entry' ? 'entry' : st.view === 'studying' ? 'studying' : 'contents';
    if (ui.foot.getAttribute('data-kind') !== kind) {
      var keys = '<div class="bx-keys">' + KEYS[kind].map(function (k) { return '<span><kbd>' + k[0] + '</kbd>' + k[1] + '</span>'; }).join('') + '</div>';
      setHTML(ui.foot, kind === 'entry'
        ? '<button class="bx-nav" data-act="prev"><b>‹</b><span class="bx-nav-l"></span></button>' +
          '<div class="bx-foot-mid"><div class="bx-seg bx-folios">' + FOLIOS.map(function (f) { return '<button data-act="folio" data-k="' + f.k + '">' + f.name + '</button>'; }).join('') + '</div>' +
          '<span class="bx-folio"></span></div>' +
          '<button class="bx-nav bx-nav-r" data-act="next"><span class="bx-nav-l"></span><b>›</b></button>' +
          '<button class="bx-nav bx-edit-btn" data-act="edit">' + img('bx-quill') + '<span>Edit page</span></button>' + keys
        : '<div class="bx-foot-mid"><span class="bx-folio"></span></div>' + keys);
      ui.foot.setAttribute('data-kind', kind);
    }
    var folio = ui.foot.querySelector('.bx-folio');
    if (kind === 'entry') {
      var e = byId(st.id), nb = neighbours(), fi = folioIx(st.folio), last = fi === FOLIOS.length - 1;
      var labels = ui.foot.querySelectorAll('.bx-nav-l');
      labels[0].textContent = fi > 0 ? FOLIOS[fi - 1].name : (nb.prev ? nb.prev.name : 'Contents');
      labels[1].textContent = !last ? FOLIOS[fi + 1].name : (nb.next ? nb.next.name : 'End of chapter');
      ui.foot.querySelector('[data-act=next]').disabled = !!(last && !nb.next);
      var fb = ui.foot.querySelectorAll('.bx-folios button');
      for (var i = 0; i < fb.length; i++) fb[i].classList.toggle('bx-on', fb[i].getAttribute('data-k') === st.folio);
      folio.textContent = 'Folio ' + (nb.i + 1) + ' of ' + nb.n + ' · ' + (st.chapter === 'all' ? 'All Kinds' : chOf(e ? e.chapter : '').name);
    } else if (kind === 'studying') {
      /* a failed study holds its emblem for 2.4 s: the foot says the same thing */
      var failed = typeof sp !== 'undefined' && sp.tok && sp.tok.failed;
      folio.textContent = failed ? 'Nothing was measured · returning…' : 'Studying… the page opens when the measure is taken';
      folio.classList.toggle('bx-folio-bad', !!failed);
    } else {
      folio.textContent = chOf(st.chapter).name + ' · ↑ ↓ to choose, Enter to open, or start typing to search';
    }
  }

  /* ------------------------------------------------------------ render -- */
  /* render() = chrome (top bar + chapter rail: only when the data or the
     chapter changed) + the two pages + the foot (patched). A page turn's class
     goes on BEFORE the writes, so nothing is read back to restart it. */
  function render() {
    if (!root || !st.data) return;
    try {
      st.fresh = st.freshId; st.freshId = null;
      st.anim = !!st.turn && !reducedMotion();
      if (st.view === 'entry' && !byId(st.id)) st.view = 'contents';
      if (st.view === 'studying' && typeof renderStudying !== 'function') st.view = byId(st.id) ? 'entry' : 'contents';
      turnStart();
      renderChrome();
      renderPages();
      renderFoot();
    } catch (x) { drawError(x); }
    st.turn = ''; st.justOpened = false; st.anim = false;
    railsSoon();
  }
  function renderChrome(force) {
    var key = (st.data.rev != null ? 'r' + st.data.rev : '') + 'g' + st.gen + '|' + st.chapter;
    if (force || key !== st.chromeKey) { st.chromeKey = key; renderTop(); renderIndex(); }
    else markIndex();
  }
  function renderPages() {
    var e = byId(st.id);
    if (st.view === 'studying') renderStudying();
    else if (st.view === 'entry' && e) { if (st.folio === 'notes') renderNotes(e); else if (st.folio === 'combat') renderCombat(e); else renderSpecimen(e); }
    else { st.view = 'contents'; renderContents(); }
    spreadGaps(ui.left); spreadGaps(ui.right);
    loreClock();
    if (st.loreAnim && st.loreAnim.id === st.id && st.view === 'entry' && st.folio === 'notes') startLoreAnim(); else stopLoreAnim();
  }
  /* a renderer that throws draws this instead: an uncaught error in a view
     takes the whole Ultralight renderer down with it */
  function drawError(x) {
    if (window.console) console.error('[bestiary] render failed', x);
    try {
      ui.right.className = 'bx-page bx-right';
      setHTML(ui.right, '<div class="bx-page-in"><section class="bx-unread">' + img('bx-close') + '<b>This page could not be drawn</b><span>' +
        esc(x && x.message || String(x)) + '. The rest of the book still works; turn the page or pick another kind.</span></section></div>');
    } catch (y) {}
  }
  function turnStart() {
    if (!st.turn || !ui.book) return;
    var b = ui.book;
    b.classList.remove('bx-turn-next', 'bx-turn-prev');
    b.classList.add('bx-turn-' + st.turn);
    var old = b.querySelector('.bx-leaf'); if (old) b.removeChild(old);
    if (!st.justOpened) {
      /* the leaf: a fresh node per turn so its sweep always starts from the edge */
      var lf = document.createElement('div');
      lf.className = 'bx-leaf bx-leaf-' + st.turn;
      b.appendChild(lf);
      sound(st.turn === 'prev' ? 'pageback' : 'page');
    }
    T.set('turn', endTurn, 400);
  }
  function endTurn() {
    T.clear('turn');
    if (!ui.book) return;
    ui.book.classList.remove('bx-turn-next', 'bx-turn-prev');
    var lf = ui.book.querySelector('.bx-leaf'); if (lf) ui.book.removeChild(lf);
  }

  /* A spread page's sections sit at a fixed gap from the top; a spacer between
     each pair takes a capped share of any room left (.bx-flexgap), so a full
     page breathes and a sparse one never opens 300px voids between sections. */
  function spreadGaps(page) {
    var boxes = page ? page.querySelectorAll('.bx-spread-even') : [];
    for (var i = 0; i < boxes.length; i++) {
      var kids = [], c = boxes[i].children;
      for (var j = 0; j < c.length; j++) if (c[j].className !== 'bx-flexgap') kids.push(c[j]);
      for (var k = 1; k < kids.length; k++) {
        var g = document.createElement('div');
        g.className = 'bx-flexgap';
        boxes[i].insertBefore(g, kids[k]);
      }
    }
  }

  /* ---------------------------------------------- sound + the quill --- */
  /* The game plays these (bxSound -> RE::PlaySound): vanilla descriptors only. */
  function sound(name) { toGame('bxSound', name); }
  function reducedMotion() {
    try { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  var quill = { lastSound: 0 };
  function stopLoreAnim() { T.clear('quill'); }
  /* The quill writes the page in, a phrase at a time, the pen riding to the
     end of each. The line boxes are measured ONCE, in one frame, before the
     first phrase shows; after that only opacity and the pen's transform move.
     The whole page lands in about 2.6 s. Progress lives in st.loreAnim, so a
     redraw mid-write resumes where it was instead of starting again. */
  function startLoreAnim() {
    var la = st.loreAnim, box = ui.left.querySelector('.bx-lore-text.bx-writing');
    if (!la || !box) return;
    var phs = box.querySelectorAll('.bx-ph'), pen = box.querySelector('.bx-pen');
    T.clear('quill');
    requestAnimationFrame(function () {
      if (st.loreAnim !== la || !box.parentNode) return;
      var br = box.getBoundingClientRect(), pos = [], lift = Math.round(44 * U());
      for (var i = 0; i < phs.length; i++) {
        var rs = phs[i].getClientRects(), r = rs.length ? rs[rs.length - 1] : null;
        pos.push(r ? [Math.round(r.right - br.left), Math.round(r.top - br.top) - lift] : [0, 0]);
      }
      var per = Math.max(110, Math.min(420, Math.round(2600 / Math.max(1, phs.length - la.i))));
      var tick = function () {
        if (st.loreAnim !== la || !box.parentNode) { T.clear('quill'); return; }
        if (la.i >= phs.length) { T.clear('quill'); finishLore(box, pen); return; }
        var k = la.i++;
        phs[k].classList.add('bx-on');
        if (pen) pen.style.transform = 'translate(' + pos[k][0] + 'px,' + pos[k][1] + 'px)';
        var now = Date.now();
        if (now - quill.lastSound >= 1800) { quill.lastSound = now; sound('write'); }
      };
      tick();
      T.every('quill', tick, per);
    });
  }
  function finishLore(box, pen) {
    st.loreAnim = null;
    box.classList.remove('bx-writing');
    var all = box.querySelectorAll('.bx-ph');
    for (var i = 0; i < all.length; i++) all[i].classList.add('bx-on');
    if (pen) { pen.classList.add('bx-pen-done'); T.set('pen-gone', function () { if (pen.parentNode) pen.parentNode.removeChild(pen); }, 400); }
  }

  /* ------------------------------------------------------- navigation -- */
  function go(id, dir, folio) {
    if (!byId(id)) return;
    st.turn = dir || 'next'; st.view = 'entry'; st.id = id; st.angle = 0; st.folio = folio || 'specimen'; st.sel = id;
    st.q = ''; if (ui.q) ui.q.value = ''; st.resultsOpen = false; renderResults();
    if (!byId(id).img) toGame('bxRender', JSON.stringify({ id: id }));
    render();
  }
  function chapter(ch) { st.turn = 'next'; st.view = 'contents'; st.chapter = ch; render(); }
  function stepChapter(d) {
    var i = (chIndex(st.view === 'contents' ? st.chapter : activeChapter() || st.chapter) + d + CH.length) % CH.length;
    st.turn = d > 0 ? 'next' : 'prev'; st.view = 'contents'; st.chapter = CH[i].id; render();
  }
  /* back to the contents, with the page you came from selected */
  function toContents() {
    if (st.view !== 'entry') return;
    var e = byId(st.id);
    st.sel = st.id;
    if (e && st.chapter !== 'all' && st.chapter !== e.chapter) st.chapter = e.chapter;
    st.turn = 'prev'; st.view = 'contents'; render();
    var row = ui.right.querySelector('.bx-row.bx-on');
    if (row) { try { row.scrollIntoView({ block: 'nearest' }); } catch (x) {} }
  }
  function step(d) {
    if (st.view !== 'entry') return;
    var nb = neighbours(), fi = folioIx(st.folio);
    if (d > 0) {
      if (fi < FOLIOS.length - 1) { st.folio = FOLIOS[fi + 1].k; st.turn = 'next'; render(); }
      else if (nb.next) go(nb.next.id, 'next', FOLIOS[0].k);
    } else {
      if (fi > 0) { st.folio = FOLIOS[fi - 1].k; st.turn = 'prev'; render(); }
      else if (nb.prev) go(nb.prev.id, 'prev', FOLIOS[FOLIOS.length - 1].k);
      else toContents();
    }
  }
  /* ---- the turntable (specimen lane) ----------------------------------
     Eight REAL frames at 45 degrees, the Mounts contract: frame 0 is e.img,
     the others <stem>-aNNN.png baked by bxSpin. The first turn of an entry asks
     C++ to bake (bxSpin -> bxSpinState {id, frames:[angles on disk], total,
     baking}) and probes the seven missing frames with Image(); a probe poll
     every 1.5 s for up to 40 s is the fallback for an older DLL that never
     pushes bxSpinState. st.angle steps 45 at a time; until the frame for it is
     baked AND loaded the figure keeps the nearest angle that is, so a turn never
     flickers to a blank. sp.frames[id] = {angle: 'ok'|'bad'|'probing'}. */
  var SPIN = 45, SPIN_N = 8, SPIN_POLL_MS = 1500, SPIN_POLL_FOR = 40000;
  var sp = {
    frames: {}, src: {}, asked: {}, baking: {}, gaveUp: {}, shown: {}, t0: {}, listed: {}, retry: {}, bb: {},
    pollT: 0, pollId: null,
    tok: null, seq: 0, holdT: 0, failT: 0, watchT: 0, peekAsked: false, lateStamp: ''
  };
  /* THE TURNTABLE FILENAME CONTRACT, verbatim from mounts-pane.js (item_icons.cpp AngleFile) */
  function angleFile(file, angle) {
    angle = ((angle | 0) % 360 + 360) % 360;
    if (!file || angle === 0) return file || '';
    var stem = /\.png$/i.test(file) ? file.slice(0, -4) : file;
    return stem + '-a' + ('00' + angle).slice(-3) + '.png';
  }
  function framesOf(e) {
    if (sp.src[e.id] !== e.img) {   // a new render replaces the old frames
      sp.src[e.id] = e.img; sp.frames[e.id] = { 0: 'ok' }; sp.asked[e.id] = false; sp.baking[e.id] = false;
      sp.gaveUp[e.id] = false; sp.shown[e.id] = 0; sp.listed[e.id] = {};
    }
    return sp.frames[e.id];
  }
  function okCount(f) { var n = 0; for (var a = 0; a < 360; a += SPIN) if (f[a] === 'ok') n++; return n; }
  /* frames on disk still loading (the page now asks for them as it opens) */
  function loading(f) { for (var a = SPIN; a < 360; a += SPIN) if (f[a] === 'probing') return true; return false; }
  function circ(x, y) { var d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; }
  /* a specimen draw: a poll left running for another entry stops; one for this
     entry that a page change interrupted picks up again */
  function spinFor(e) {
    var f = framesOf(e);
    if (sp.pollId && sp.pollId !== e.id) stopSpinPoll();
    if (sp.asked[e.id] && sp.baking[e.id] && !sp.gaveUp[e.id] && !sp.pollT && okCount(f) < SPIN_N) startSpinPoll(e);
    return f;
  }
  function shownAngle(e) {
    var f = framesOf(e), a = st.angle;
    if (f[a] === 'ok') return a;
    var best = f[sp.shown[e.id]] === 'ok' ? sp.shown[e.id] : 0, bd = circ(best, a);
    for (var x = 0; x < 360; x += SPIN) if (f[x] === 'ok' && circ(x, a) < bd) { best = x; bd = circ(x, a); }
    return best;
  }
  function frameSrc(e) { var a = shownAngle(e); sp.shown[e.id] = a; return angleFile(e.img, a); }
  /* every frame already LOADED, one <img> each; only the shown one is visible */
  function figStack(e) {
    var f = framesOf(e), on = shownAngle(e), h = '';
    sp.shown[e.id] = on;
    for (var a = 0; a < 360; a += SPIN)
      if (f[a] === 'ok') h += '<img class="bx-fr' + (a === on ? ' bx-on' : '') + '" data-a="' + a + '" src="' + esc(angleFile(e.img, a)) + '" alt="' + (a ? '' : esc(e.name)) + '">';
    return h;
  }
  function syncStack(e) {
    var w = figWrap();
    if (!w) return;
    var f = framesOf(e), on = shownAngle(e), have = {}, list = w.children, i, added = false;
    sp.shown[e.id] = on;
    for (i = 0; i < list.length; i++) have[list[i].getAttribute('data-a')] = list[i];
    for (var a = 0; a < 360; a += SPIN) {
      if (f[a] !== 'ok' || have[a]) continue;
      var im = document.createElement('img');
      im.className = 'bx-fr'; im.setAttribute('data-a', String(a)); im.alt = '';
      im.src = angleFile(e.img, a);
      w.appendChild(im); have[a] = im; added = true;
    }
    for (i = 0; i < list.length; i++) {
      var want = +list[i].getAttribute('data-a') === on;
      if (list[i].classList.contains('bx-on') !== want) list[i].classList.toggle('bx-on', want);
    }
    if (added) placeFigs();
  }
  /* the eight dots, placed round the floor ellipse (0 degrees = facing you) */
  var DOT_AT = (function () {
    var out = [];
    for (var i = 0; i < 8; i++) { var r = i * Math.PI / 4; out.push([(50 + 47 * Math.sin(r)).toFixed(1), (50 + 42 * Math.cos(r)).toFixed(1)]); }
    return out;
  })();
  function dotCls(f, a) { return 'bx-dot' + (a === st.angle ? ' bx-on' : f[a] === 'ok' ? ' bx-ok' : ''); }
  function dotsInner(e) {
    var f = framesOf(e), h = '';
    for (var i = 0; i < SPIN_N; i++) h += '<span class="' + dotCls(f, i * SPIN) + '" style="left:' + DOT_AT[i][0] + '%;top:' + DOT_AT[i][1] + '%"></span>';
    return h;
  }
  function spinCaption(e) {
    var f = framesOf(e), n = okCount(f);
    if (n >= SPIN_N) return 'Drag or Q E to turn · wheel to zoom';
    if (!sp.asked[e.id]) return 'Drag it, or press ‹ ›, to turn it';
    if (sp.baking[e.id] && !sp.gaveUp[e.id]) return 'Baking turntable <b>' + n + '/' + SPIN_N + '</b>';
    if (loading(f)) return 'Drag or Q E to turn · wheel to zoom';
    return n > 1 ? n + ' of ' + SPIN_N + ' views drawn' : 'Only this view could be drawn';
  }
  function canTurn(e) {
    var f = framesOf(e);
    return !(sp.asked[e.id] && (!sp.baking[e.id] || sp.gaveUp[e.id]) && okCount(f) <= 1 && !loading(f));
  }
  function turnInner(e) {
    if (e.custArt) return '<div class="bx-turn-cap">Your own picture · wheel to zoom · Edit this page to change it</div>';
    var dis = canTurn(e) ? '' : ' disabled', baking = sp.asked[e.id] && sp.baking[e.id] && !sp.gaveUp[e.id] && okCount(framesOf(e)) < SPIN_N;
    return '<button class="bx-turn-btn" data-act="turn" data-d="-45" title="Turn left (Q)"' + dis + '>‹</button>' +
      '<div class="bx-turn-cap' + (baking ? ' bx-baking' : '') + '">' + spinCaption(e) + '</div>' +
      '<button class="bx-turn-btn" data-act="turn" data-d="45" title="Turn right (E)"' + dis + '>›</button>';
  }
  /* redraw ONLY the stage: dot classes, the caption row, the frame */
  function refreshStage() {
    var e = byId(st.id);
    if (!st.open || st.view !== 'entry' || st.folio !== 'specimen' || !e || !e.img) return;
    var f = framesOf(e), dots = document.getElementById('bx-dots');
    if (dots) for (var i = 0; i < dots.children.length && i < SPIN_N; i++) dots.children[i].className = dotCls(f, i * SPIN);
    var tr = document.getElementById('bx-turn'), th = turnInner(e);
    if (tr && tr._h !== th) { tr.innerHTML = th; tr._h = th; }
    syncStack(e);   // a visibility toggle, never a src swap
  }
  /* one Image() per frame; 'ok' only once it has LOADED, so a swap never flickers */
  function probe(id, img, a) {
    var f = sp.frames[id];
    if (!f || sp.src[id] !== img || f[a] === 'ok' || f[a] === 'probing') return;
    f[a] = 'probing';
    var im = new Image();
    im.onload = function () {
      if (sp.src[id] !== img) return;
      f[a] = 'ok';
      (sp.bb[img] = sp.bb[img] || {})[a] = alphaBox(im);
      if (okCount(f) >= SPIN_N) { sp.baking[id] = false; if (sp.pollId === id) stopSpinPoll(); widenFit(img); }
      if (st.id === id) refreshStage();
    };
    im.onerror = function () {
      if (sp.src[id] !== img || f[a] !== 'probing') return;
      f[a] = 'bad';
      /* C++ said it is on disk: it may still be being written, so look again */
      var rk = id + '@' + a;
      if (sp.listed[id] && sp.listed[id][a] && (sp.retry[rk] = (sp.retry[rk] || 0) + 1) <= 3) setTimeout(function () { probe(id, img, a); }, 400);
    };
    im.src = angleFile(img, a);
  }
  function probeAll(e) { for (var a = SPIN; a < 360; a += SPIN) probe(e.id, e.img, a); }
  function stopSpinPoll() { if (sp.pollT) { clearInterval(sp.pollT); sp.pollT = 0; } sp.pollId = null; }
  function startSpinPoll(e) {
    stopSpinPoll();
    sp.pollId = e.id;
    sp.pollT = setInterval(function () {
      var cur = byId(sp.pollId);
      if (!st.open || !cur || !cur.img || st.id !== cur.id) { stopSpinPoll(); return; }
      var f = framesOf(cur);
      if (okCount(f) >= SPIN_N || !sp.baking[cur.id]) { stopSpinPoll(); refreshStage(); return; }
      if (Date.now() - (sp.t0[cur.id] || 0) > SPIN_POLL_FOR) { sp.gaveUp[cur.id] = true; stopSpinPoll(); refreshStage(); return; }
      probeAll(cur);
    }, SPIN_POLL_MS);
  }
  function askSpin(e) {
    if (sp.asked[e.id]) return;
    sp.asked[e.id] = true; sp.baking[e.id] = true; sp.gaveUp[e.id] = false; sp.t0[e.id] = Date.now();
    toGame('bxSpin', JSON.stringify({ id: e.id }));
    probeAll(e);
    startSpinPoll(e);
  }
  /* C++ -> view: which frames are on disk, and whether more are coming */
  window.bxSpinState = function (json) {
    var r; try { r = typeof json === 'string' ? JSON.parse(json) : json; } catch (x) { return; }
    var e = r && r.id && byId(r.id);
    if (!e || !e.img) return;
    var f = framesOf(e), fr = r.frames || [];
    sp.asked[e.id] = true;
    if (!sp.t0[e.id]) sp.t0[e.id] = Date.now();
    fr.forEach(function (a) {
      a = ((a | 0) % 360 + 360) % 360;
      if (a % SPIN || !a) return;
      sp.listed[e.id][a] = true;
      if (f[a] !== 'ok') { if (f[a] === 'bad') delete f[a]; probe(e.id, e.img, a); }
    });
    sp.baking[e.id] = !!r.baking && fr.length < SPIN_N;
    if (!sp.baking[e.id] && sp.pollId === e.id) stopSpinPoll();
    if (st.id === e.id) refreshStage();
  };
  /* one 45-degree step; the first one of an entry asks for the bake */
  function turnFigure(d) {
    var e = byId(st.id);
    if (!e || !e.img || e.custArt || st.view !== 'entry' || st.folio !== 'specimen') return;
    framesOf(e);
    if (!sp.asked[e.id]) askSpin(e);
    else if (!canTurn(e)) return;
    st.angle = ((st.angle + (d < 0 ? -SPIN : SPIN)) % 360 + 360) % 360;
    refreshStage();
  }

  function onClick(ev) {
    var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t || !root.contains(t) || t.disabled) return;
    var a = t.getAttribute('data-act');
    if (a === 'goto') { if (st.list) closeList(); go(t.getAttribute('data-id')); }
    else if (a === 'chapter') chapter(t.getAttribute('data-ch'));
    else if (a === 'sort') { var sk = t.getAttribute('data-k'); if (sk !== st.sort) { st.sort = sk; renderPages(); } }
    else if (a === 'prev') step(-1);
    else if (a === 'next') step(1);
    else if (a === 'folio') { var f = t.getAttribute('data-k'); if (f !== st.folio) { st.turn = folioIx(f) > folioIx(st.folio) ? 'next' : 'prev'; st.folio = f; render(); } }
    else if (a === 'turn') turnFigure(+t.getAttribute('data-d'));
    else if (a === 'scribe') openScribe();
    else if (a === 'scribe-key') { openScribe(); if (st.scribe) { st.scribe.editing = true; renderScribe(); var k = document.getElementById('bx-key'); if (k) k.focus(); } }
    else if (a === 'edit') openEdit();
    else if (a === 'unseen') openUnseen(t.getAttribute('data-plugin') || '');
    else if (a === 'arsenal') openArsenal();
    else if (a === 'list-close') closeList();
    else if (a === 'shelf-new') openShelf('');
    else if (a === 'shelf-edit') openShelf(t.getAttribute('data-ch'));
    else if (a.indexOf('sh-') === 0 || a.indexOf('pk-') === 0) shelfClick(a, t);
    else if (a.indexOf('ed-') === 0) editClick(a, t);
    else if (a === 'lore') {
      var e = byId(t.getAttribute('data-id'));
      if (!e) return;
      var rw = t.getAttribute('data-rewrite') === '1' && arr(e.lore && e.lore.text).length > 0;
      /* a rewrite keeps the old page up (faded) until the new one lands */
      if (rw) { e.lore.pending = { model: scribeState().model || '', at: Date.now() }; delete e.lore.lastError; }
      else e.lore = { state: 'writing', text: [] };
      st.pendSince[e.id] = Date.now();
      st.writeWatch[e.id] = true;
      toGame('bxLore', JSON.stringify({ id: e.id, rewrite: t.getAttribute('data-rewrite') === '1' }));
      replaceLore(e);
    }
    else scribeClick(a, t);
  }
  /* only the lore section of the shown Field notes page, nothing else */
  function replaceLore(e) {
    if (!st.open || st.view !== 'entry' || st.folio !== 'notes' || st.id !== e.id) return false;
    var sec = ui.left.querySelector('.bx-lore');
    if (!sec) return false;
    var tmp = document.createElement('div');
    setHTML(tmp, loreBlock(e));
    sec.parentNode.replaceChild(tmp.firstChild, sec);
    /* the yielding art only belongs under a written page */
    var fill = ui.left.querySelector('.bx-lore-fill');
    if (fill && !arr(e.lore.text).length) fill.parentNode.removeChild(fill);
    loreClock();
    if (st.loreAnim && st.loreAnim.id === e.id) startLoreAnim();
    return true;
  }

  /* turntable drag: tracked from mouse-down to mouse-up on window (Ultralight can
     report buttons===0 mid-drag, so the held state is ours, never the event's).
     Left drag turns the figure - the figure follows the hand, a step every 40u -
     or, zoomed in, moves it; the middle button always moves it (Rober,
     2026-10-11: "middle mouse stopped zooming him around"). Mouse moves are
     folded into ONE update per animation frame. */
  var raf = window.requestAnimationFrame ? function (f) { return window.requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); };
  function onDown(ev) {
    var stage = ev.target.closest ? ev.target.closest('#bx-stage') : null;
    var e = byId(st.id);
    if (!stage || !e || !e.img || ev.button > 1) return;
    var pan = ev.button === 1 || (sp.vz && sp.vz.id === e.id && sp.vz.z > 1.001);
    if (pan && !sp.base) return;
    var x0 = ev.clientX, y0 = ev.clientY, acc = 0, dx = 0, dy = 0, queued = false, step = 40 * unitPx();
    stage.classList.add(pan ? 'bx-panning' : 'bx-drag');
    function flush() {
      queued = false;
      if (pan) {
        var v = vzFor(st.id);
        if (v.z <= 1.001 && ev.button !== 1) return;
        v.px += dx; v.py += dy; dx = 0; dy = 0;
        clampPan(); placeFigs();
        return;
      }
      while (Math.abs(acc) >= step) { turnFigure(acc > 0 ? 45 : -45); acc += acc > 0 ? -step : step; }
    }
    function mv(m) {
      if (pan) { dx += m.clientX - x0; dy += m.clientY - y0; }
      else acc += m.clientX - x0;
      x0 = m.clientX; y0 = m.clientY;
      if (!queued) { queued = true; raf(flush); }
    }
    function up() {
      stage.classList.remove('bx-drag'); stage.classList.remove('bx-panning');
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); window.removeEventListener('blur', up);
    }
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); window.addEventListener('blur', up);
    ev.preventDefault();
  }
  function onDbl(ev) {
    var stage = ev.target.closest ? ev.target.closest('#bx-stage') : null;
    if (stage && sp.vz && sp.vz.z > 1.001) { resetZoom(); ev.preventDefault(); }
  }

  /* a popout keeps Tab inside itself */
  function trapTab(ev) {
    var f = ui.modalBack.querySelectorAll('button:not([disabled]), input, textarea'), list = [];
    for (var i = 0; i < f.length; i++) if (f[i].offsetParent !== null) list.push(f[i]);
    if (!list.length) return;
    var at = list.indexOf(document.activeElement);
    var nx = at < 0 ? 0 : (at + (ev.shiftKey ? list.length - 1 : 1)) % list.length;
    list[nx].focus();
  }
  function hotResult(i) {
    st.hot = i;
    var rs = ui.results.querySelectorAll('.bx-res');
    for (var k = 0; k < rs.length; k++) rs[k].classList.toggle('bx-on', k === i);
    if (rs[i]) { try { rs[i].scrollIntoView({ block: 'nearest' }); } catch (x) {} }
  }
  /* Ultralight's native keydown can carry key "Unidentified" with only the legacy
     keyCode (ul-scenario measured it, 2026-10-11: Escape arrives as Unidentified/27),
     so a book that compared ev.key alone never heard Escape, Enter or the arrows.
     Same fallback as app.js normCode. */
  var VK_KEY = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: ' ', 37: 'ArrowLeft', 38: 'ArrowUp',
    39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete', 187: '+', 189: '-', 107: '+', 109: '-', 191: '/', 219: '[', 221: ']' };
  function keyOf(ev) {
    var k = ev && ev.key;
    if (k && k !== 'Unidentified') return k;
    var c = (ev && ev.keyCode) || 0;
    if (VK_KEY[c]) return VK_KEY[c];
    if (c >= 65 && c <= 90) { var ch = String.fromCharCode(c); return ev.shiftKey ? ch : ch.toLowerCase(); }
    if (c >= 48 && c <= 57) return String.fromCharCode(c);
    if (c >= 96 && c <= 105) return String(c - 96);
    return k || '';
  }
  function onKey(ev) {
    if (!st.open) return;
    var k = keyOf(ev), inQ = document.activeElement === ui.q, plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    var handled = true;
    if ((st.edit || st.scribe || st.list || st.shelf) && k === 'Tab') trapTab(ev);
    else if (st.shelf) {
      if (k === 'Escape') { if (st.shelf.confirm) { st.shelf.confirm = false; renderShelf(false); } else closeShelf(); }
      else if (k === 'Enter' && document.activeElement && document.activeElement.getAttribute('data-sh') === 'name') saveShelf();
      else return;
    }
    else if (st.edit && st.edit.picking) { if (k === 'Escape') { st.edit.picking = null; renderEdit(false); } else return; }
    else if (st.list) {
      if (k === 'Escape') closeList();
      else if (k === 'Enter') { var first = ui.modalBack.querySelector('[data-act=goto]:not(.bx-hidden)'); if (first) first.click(); }
      else return;
    }
    else if (st.edit) { if (k === 'Escape') editEscape(); else return; }
    else if (st.scribe) { if (!scribeKey(ev)) return; }
    else if (inQ && (k === 'ArrowDown' || k === 'ArrowUp')) {
      if (T.has('search')) { T.clear('search'); renderResults(); }
      var n = ui.results.querySelectorAll('.bx-res').length; if (n) hotResult((st.hot + (k === 'ArrowDown' ? 1 : n - 1)) % n);
    }
    else if (inQ && k === 'Enter') { T.clear('search'); var m = matches(); if (m.length) go(m[Math.min(st.hot, m.length - 1)].e.id); }
    else if (inQ && k === 'Escape') { if (st.q) { ui.q.value = ''; st.q = ''; renderResults(); } else ui.q.blur(); }
    else if (inQ) handled = false;
    else if (k === 'Escape') close();
    else if (k === '/' || (k === 'f' && ev.ctrlKey)) ui.q.focus();
    else if (st.view === 'contents' && (k === 'ArrowDown' || k === 'ArrowUp')) moveSel(k === 'ArrowDown' ? 1 : -1);
    else if (st.view === 'contents' && k === 'Enter') { if (st.sel && byId(st.sel)) go(st.sel); else moveSel(1); }
    else if (k === 'PageUp' || (k === '[' && plain)) stepChapter(-1);
    else if (k === 'PageDown' || (k === ']' && plain)) stepChapter(1);
    else if (k === 'ArrowLeft') step(-1);
    else if (k === 'ArrowRight') step(1);
    else if (k === 'Backspace' && st.view === 'entry') toContents();
    else if ((k === 'q' || k === 'e') && plain && st.folio === 'specimen' && st.view === 'entry') turnFigure(k === 'q' ? -45 : 45);
    else if ((k === '+' || k === '=' || k === '-' || k === '0') && plain && st.folio === 'specimen' && st.view === 'entry' && sp.base) {
      if (k === '0') resetZoom(); else zoomAt(k === '-' ? 1 / 1.25 : 1.25);
    }
    else if (k === 'Tab' && st.view === 'entry') { var ni = (folioIx(st.folio) + (ev.shiftKey ? FOLIOS.length - 1 : 1)) % FOLIOS.length; st.turn = ev.shiftKey ? 'prev' : 'next'; st.folio = FOLIOS[ni].k; render(); }
    /* type anywhere: a printable key goes straight into the search */
    else if (k && k.length === 1 && plain && /\S/.test(k)) {
      ui.q.focus();
      ui.q.value = st.q = st.q + k; st.hot = 0; st.resultsOpen = true;
      ui.clear.classList.toggle('bx-hidden', !st.q);
      T.set('search', renderResults, 100);
    }
    else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  /* ------------------------------------------------------- Edit page --- */
  /* Rober, 2026-10-08: "do make sure to allow editing of anything - in case
     something goes wrong (and the LLM learns from it)". Every field the page
     draws can be overridden; an override sits BESIDE the measurement in
     bestiary.json, so each one reverts (↺). A correction typed in "Teach the
     Scribe" becomes a lesson fed into every page it writes from then on. */
  var EDIT_FIELDS = ['art', 'name', 'chapter', 'family', 'race', 'plugin', 'level', 'health', 'stamina', 'magicka', 'armor', 'dmg',
    'physical', 'resist', 'threat', 'ratings', 'body', 'traits', 'lore'];
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function loreText(e) { return (e.lore && e.lore.text || []).join('\n\n'); }

  function openEdit() {
    var e = byId(st.id); if (!e) return;
    var d = {};
    EDIT_FIELDS.forEach(function (f) { d[f] = clone(e[f]); });
    d.resist = d.resist || { fire: 0, frost: 0, shock: 0, magic: 0, poison: 0, disease: 0 };
    d.threat = d.threat || { tier: 0 };
    d.ratings = d.ratings || {};
    RATE.forEach(function (r) { d.ratings[r.k] = d.ratings[r.k] || [0, '']; });
    d.body = d.body || {};
    d.traitsText = (e.traits || []).join('\n');
    d.loreText = loreText(e);
    st.edit = { id: e.id, d: d, init: clone(d), notes: e.notes || '', initNotes: e.notes || '', lesson: '', everywhere: false, saved: '', confirm: false };
    st.edit.base = JSON.stringify(editPayload());
    renderEdit(true);
  }
  /* the book under the popout did not change, so nothing is redrawn; a Save
     comes back as bxEntry and redraws the page then */
  function closeEdit() { st.edit = null; ui.modalBack.classList.add('bx-hidden'); setHTML(ui.modalBack, ''); }
  function editDirty() { return !!st.edit && JSON.stringify(editPayload()) !== st.edit.base; }
  /* Esc with unsaved edits asks first; a second Esc discards */
  function editEscape() {
    var ed = st.edit; if (!ed) return;
    if (ed.confirm || !editDirty()) { closeEdit(); return; }
    ed.confirm = true;
    var c = document.getElementById('bx-ed-confirm'); if (c) c.classList.remove('bx-hidden');
  }
  function isEdited(f) { var e = byId(st.id); return !!(e && e.edited && e.edited.indexOf(f) >= 0); }
  function edHead(label, fields) {
    var on = fields.some(isEdited);
    return '<div class="bx-field-h bx-ed-h"><span>' + label + '</span>' + (on ? '<span class="bx-ed-mark">Edited by you</span><button class="bx-ed-revert" data-act="ed-revert" data-f="' +
      fields.join(',') + '" title="Back to what the book measured">↺ Revert</button>' : '') + '</div>';
  }
  function inp(path, val, ph, wide) {
    return '<label class="bx-ed-in' + (wide ? ' bx-wide' : '') + '"><input data-ed="' + path + '" type="text" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph || '') +
      '" autocomplete="off" spellcheck="false"></label>';
  }
  function labelled(label, path, val, ph) {
    return '<div class="bx-ed-cell"><span class="bx-ed-k">' + label + '</span>' + inp(path, val, ph) + '</div>';
  }
  /* built once per open; a click on a chapter, tier, pip or the switch
     moves its own .bx-on and the one field it feeds (editClick) */
  function renderEdit(entrance) {
    var ed = st.edit; if (!ed) return;
    var d = ed.d, e = byId(ed.id) || {};
    var h = '<div class="bx-modal bx-modal-wide' + (entrance ? ' bx-modal-in' : '') + '" role="dialog" aria-label="Edit this page">' +
      '<div class="bx-modal-head"><img src="' + icon('bx-quill') + '" alt=""><div><div class="bx-modal-title">Edit this page</div><div class="bx-modal-sub">' + esc(e.name || '') +
      ' · anything here can be changed, and every change can be reverted. What you teach the Scribe, it remembers.</div></div>' +
      '<button class="bx-tool bx-close" data-act="ed-close" title="Close (Esc)">×</button></div><div class="bx-modal-body">';

    h += '<section>' + edHead('Who it is', ['name', 'family', 'race', 'plugin']) + '<div class="bx-ed-grid bx-g2">' +
      labelled('Name', 'name', d.name) + labelled('Family', 'family', d.family) + labelled('Race', 'race', d.race) + labelled('Added by', 'plugin', d.plugin) + '</div></section>';

    h += '<section>' + edHead('Chapter', ['chapter']) + '<div class="bx-ed-chs">' + CH.filter(function (c) { return c.id !== 'all'; }).map(function (c) {
      return '<button class="bx-ed-ch' + (d.chapter === c.id ? ' bx-on' : '') + '" data-act="ed-ch" data-ch="' + c.id + '"><img src="' + icon(c.icon) + '" alt=""><span>' + esc(c.name) + '</span></button>';
    }).join('') + '<button class="bx-ed-ch bx-ed-ch-new" data-act="shelf-new"><img src="' + icon('bx-quill') + '" alt=""><span>New chapter…</span></button></div></section>';

    var own = safePic(d.art), drawn = e.renderImg || (e.custArt ? '' : e.img) || '';
    h += '<section>' + edHead('Picture', ['art']) + '<div class="bx-ed-art"><span class="bx-medal bx-ed-art-m">' +
      (own ? '<img src="' + esc(own) + '" alt="">' : drawn ? '<img src="' + esc(drawn) + '" alt="">' : '<img class="bx-glyph" src="' + icon(chOf(d.chapter).icon) + '" alt="">') +
      '</span><div class="bx-ed-art-t"><b>' + (own ? 'Your picture' : 'The book’s own drawing') + '</b><span>Any icon, game icon, or a picture you uploaded from the Deck Portal (Icons tab).</span></div>' +
      '<button class="bx-mini bx-primary" data-act="ed-art">Choose a picture…</button>' + (own ? '<button class="bx-mini" data-act="ed-art-clear">Use the book’s drawing</button>' : '') + '</div></section>';

    var t = d.threat || {};
    h += '<section>' + edHead('Threat to you', ['threat']) + '<div class="bx-ed-tiers">' + [1, 2, 3, 4, 5].map(function (n) {
      return '<button class="bx-ed-tier' + (t.tier === n ? ' bx-on' : '') + '" data-act="ed-tier" data-n="' + n + '">' + skulls(n) + '<span>' + TIER[n] + '</span></button>';
    }).join('') + '</div><div class="bx-ed-grid bx-g1">' + labelled('Seal word', 'threat.word', t.word, TIER[t.tier] || '') +
      '<div class="bx-ed-cell"><span class="bx-ed-k">Verdict</span><textarea data-ed="threat.note" rows="3">' + esc((t.note || '').replace(/<\/?b>/g, '')) + '</textarea></div></div></section>';

    h += '<section>' + edHead('Ratings', ['ratings']) + '<div class="bx-ed-rates">' + RATE.map(function (r) {
      var v = d.ratings[r.k] || [0, ''];
      return '<div class="bx-ed-rate"><img src="' + icon(r.icon) + '" alt=""><span class="bx-ed-rname">' + r.name + '</span><span class="bx-ed-pips">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<button class="bx-ed-pip' + (n <= v[0] ? ' bx-on' : '') + '" data-act="ed-pip" data-k="' + r.k + '" data-n="' + n + '" title="' + n + ' of 5"></button>';
      }).join('') + '</span>' + inp('ratings.' + r.k + '.1', v[1], 'a word for it') + '</div>';
    }).join('') + '</div></section>';

    h += '<section>' + edHead('Vital statistics', ['level', 'health', 'stamina', 'magicka', 'armor', 'dmg']) + '<div class="bx-ed-grid bx-g3">' +
      labelled('Level', 'level', d.level) + labelled('Health', 'health', d.health) + labelled('Armour', 'armor', d.armor) +
      labelled('Stamina', 'stamina', d.stamina) + labelled('Magicka', 'magicka', d.magicka) + labelled('Strikes for', 'dmg', d.dmg) + '</div></section>';

    h += '<section>' + edHead('Resistances (%)', ['physical', 'resist']) + '<div class="bx-ed-grid bx-g7">' +
      '<div class="bx-ed-cell bx-ed-res"><img src="' + icon('res-armor') + '" alt=""><span class="bx-ed-k">Physical</span>' + inp('physical', d.physical) + '</div>' +
      RES.map(function (r) { return '<div class="bx-ed-cell bx-ed-res"><img src="' + icon('res-' + r.k) + '" alt=""><span class="bx-ed-k">' + r.name + '</span>' + inp('resist.' + r.k, d.resist[r.k]) + '</div>'; }).join('') +
      '</div><div class="bx-field-help">Negative is a weakness, 100 or more is immunity.</div></section>';

    h += '<section>' + edHead('Body & soul', ['body']) + '<div class="bx-ed-grid bx-g5">' +
      labelled('Stands', 'body.height', d.body.height, '3.1 m') + labelled('Weight', 'body.mass', d.body.mass, 'Very heavy') + labelled('Speed', 'body.speed', d.body.speed, 'Runs as fast as you') +
      labelled('Heals', 'body.regen', d.body.regen, '4% health/s') + labelled('Soul', 'body.soul', d.body.soul, 'Greater') + '</div></section>';

    h += '<section>' + edHead('Habits & abilities', ['traits']) + '<textarea data-ed="traitsText" rows="4" placeholder="One per line">' + esc(d.traitsText) + '</textarea></section>';
    h += '<section>' + edHead('Of its nature (the lore)', ['lore']) + '<textarea data-ed="loreText" rows="8" placeholder="Paragraphs separated by a blank line">' + esc(d.loreText) +
      '</textarea><div class="bx-field-help">Your text replaces the Scribe’s page. Asking the Scribe to rewrite later uses your version as its facts.</div></section>';
    h += '<section><div class="bx-field-h">Your notes</div><textarea data-ed="@notes" rows="3" placeholder="Anything you want to remember about this one">' + esc(ed.notes) + '</textarea></section>';
    h += '<section class="bx-ed-teach"><div class="bx-field-h">Teach the Scribe</div>' +
      '<textarea data-ed="@lesson" rows="3" placeholder="What did it get wrong? e.g. “Frost trolls do not live in Falkreath” or “Never call the Dragonborn ‘the player’”">' + esc(ed.lesson) + '</textarea>' +
      '<button class="bx-toggle' + (ed.everywhere ? ' bx-on' : '') + '" data-act="ed-every"><span class="bx-toggle-text"><div class="bx-toggle-name">Remember this for every creature</div>' +
      '<div class="bx-toggle-help">Off: only this page’s rewrites use it. On: it joins the Scribe’s lessons, shown and editable on the Scribe page.</div></span><span class="bx-switch"></span></button></section>';
    h += '</div><div class="bx-confirm bx-hidden" id="bx-ed-confirm"><b>Discard your changes?</b><span>Press Esc again to discard them, or save.</span>' +
      '<button class="bx-mini" data-act="ed-close">Discard</button><button class="bx-mini bx-primary" data-act="ed-save">Save</button></div>' +
      '<div class="bx-modal-foot"><span class="bx-grow">' + (ed.saved ? esc(ed.saved) : 'Saved into bestiary.json beside what the book measured.') + '</span>' +
      ((e.edited && e.edited.length) ? '<button class="bx-mini" data-act="ed-revert-all">Revert every edit</button>' : '') +
      '<button class="bx-mini" data-act="ed-close">Cancel</button><button class="bx-mini bx-primary" data-act="ed-save">Save</button></div></div>';
    setHTML(ui.modalBack, h);
    ui.modalBack.classList.remove('bx-hidden'); railsSoon();
  }
  function setPath(obj, path, val) {
    var ks = path.split('.'), o = obj;
    for (var i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = val;
  }
  function edInput(ev) {
    var ed = st.edit, path = ev.target.getAttribute('data-ed'), val = ev.target.value;
    if (path === '@notes') ed.notes = val;
    else if (path === '@lesson') ed.lesson = val;
    else setPath(ed.d, path, val);
  }
  function num(v) { var n = parseFloat(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? v : Math.round(n); }
  function editPayload() {
    var ed = st.edit, d = ed.d, i0 = ed.init, set = {};
    var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
    ['name', 'chapter', 'family', 'race', 'plugin', 'body'].forEach(function (f) { if (!same(d[f], i0[f])) set[f] = d[f]; });
    var unset = [];
    if (!same(d.art || '', i0.art || '')) { if (safePic(d.art)) set.art = safePic(d.art); else unset.push('art'); }
    ['level', 'health', 'stamina', 'magicka', 'armor', 'physical'].forEach(function (f) { if (!same(d[f], i0[f])) set[f] = num(d[f]); });
    if (!same(d.dmg, i0.dmg)) set.dmg = String(d.dmg);
    if (!same(d.resist, i0.resist)) { set.resist = {}; for (var k in d.resist) set.resist[k] = num(d.resist[k]); }
    if (!same(d.threat, i0.threat)) set.threat = { tier: d.threat.tier || 0, word: d.threat.word || TIER[d.threat.tier] || '', note: d.threat.note || '' };
    if (!same(d.ratings, i0.ratings)) set.ratings = d.ratings;
    if (d.traitsText !== i0.traitsText) set.traits = d.traitsText.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (d.loreText !== i0.loreText) set.lore = { state: 'done', by: 'Written by you', text: d.loreText.split(/\n\s*\n/).map(function (x) { return x.replace(/\s+/g, ' ').trim(); }).filter(Boolean) };
    var p = { id: ed.id, set: set };
    if (unset.length) p.unset = unset;
    if (ed.notes !== ed.initNotes) p.notes = ed.notes;
    if (ed.lesson.trim()) { p.lesson = ed.lesson.trim(); p.everywhere = ed.everywhere; }
    return p;
  }
  function editClick(a, t) {
    var ed = st.edit; if (!ed) return false;
    if (a === 'ed-close') { closeEdit(); return true; }
    var only = function (sel, on) { var b = ui.modalBack.querySelectorAll(sel); for (var i = 0; i < b.length; i++) b[i].classList.toggle('bx-on', on(b[i])); };
    if (a === 'ed-ch') { var ch = t.getAttribute('data-ch'); ed.d.chapter = ch; only('.bx-ed-ch', function (b) { return b === t; }); return true; }
    if (a === 'ed-tier') {
      var n = +t.getAttribute('data-n'); ed.d.threat = ed.d.threat || {}; ed.d.threat.tier = n; ed.d.threat.word = TIER[n];
      only('.bx-ed-tier', function (b) { return b === t; });
      var wi = ui.modalBack.querySelector('[data-ed="threat.word"]'); if (wi) wi.value = TIER[n];
      return true;
    }
    if (a === 'ed-pip') {
      var k = t.getAttribute('data-k'), m = +t.getAttribute('data-n'); ed.d.ratings[k] = [m, (ed.d.ratings[k] || [0, ''])[1]];
      only('.bx-ed-pip[data-k="' + k + '"]', function (b) { return +b.getAttribute('data-n') <= m; });
      return true;
    }
    if (a === 'ed-art') { ed.picking = { q: '', tab: safePic(ed.d.art) ? kindOfPic(ed.d.art) : 'yours', shown: PICK_PAGE, sel: safePic(ed.d.art) }; renderPicking(); askUploads(); return true; }
    if (a === 'ed-art-clear') { ed.d.art = ''; renderEdit(false); return true; }
    if (a === 'ed-every') { ed.everywhere = !ed.everywhere; t.classList.toggle('bx-on', ed.everywhere); return true; }
    if (a === 'ed-revert' || a === 'ed-revert-all') {
      var fields = a === 'ed-revert-all' ? (byId(ed.id).edited || []) : t.getAttribute('data-f').split(',');
      toGame('bxEdit', JSON.stringify({ id: ed.id, unset: fields }));
      ed.saved = 'Reverted — the page shows what the book measured again.';
      ed.pendingReopen = true;
      return true;
    }
    if (a === 'ed-save') {
      var p = editPayload();
      if (!Object.keys(p.set).length && !p.unset && p.notes === undefined && !p.lesson) { closeEdit(); return true; }
      toGame('bxEdit', JSON.stringify(p));
      closeEdit();
      return true;
    }
    return false;
  }


  /* ------------------------------------------- your own chapters + pictures --- */
  /* One picker for both: a chapter's icon and a page's own picture. Three shelves
     of pictures, all C++-supplied paths: the book's painted set, everything in
     icons/custom (where the Deck Portal's Icons tab uploads land: app.js ICONS.custom,
     re-scanned by hdIconList), and the game's ~1,900 icons (ICONS.catalog). The
     grid pages PICK_PAGE at a time so opening it never decodes them all. */
  var BOOK_ICONS = ['bx-all', 'bx-beast', 'bx-monster', 'bx-undead', 'bx-daedra', 'bx-dragon', 'bx-dwarven', 'bx-giant', 'bx-falmer', 'bx-folk', 'bx-unknown',
    'rt-tough', 'rt-ferocity', 'rt-arcane', 'rt-rarity', 'bx-height', 'bx-mass', 'bx-speed', 'bx-regen', 'bx-soul'];
  var PICK_PAGE = 120;
  function picLabel(path) { return String(path).split('/').pop().replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' '); }
  function pickSources() {
    var custom = typeof window.hdWardrobeIconChoices === 'function' ? window.hdWardrobeIconChoices() : [];
    var cat = typeof window.hdIconCatalog === 'function' ? window.hdIconCatalog() : [];
    var book = BOOK_ICONS.map(function (n) { return { src: icon(n), label: picLabel(n) }; });
    var bookSet = {};
    book.forEach(function (b) { bookSet[b.src] = 1; });
    return {
      book: book,
      yours: arr(custom).map(function (c) { var p = safePic(c.file); return p && !bookSet[p] ? { src: p, label: c.label || picLabel(p) } : null; }).filter(Boolean),
      game: arr(cat).map(function (c) { var p = safePic(c.file); return p ? { src: p, label: (c.label || c.key || picLabel(p)) + (c.atlas ? ' ' + c.atlas : '') } : null; }).filter(Boolean)
    };
  }
  function kindOfPic(p) { return /^icons\/sh\//.test(p) ? 'game' : BOOK_ICONS.some(function (n) { return icon(n) === p; }) ? 'book' : 'yours'; }
  function curPick() { return st.shelf ? st.shelf.pick : st.edit && st.edit.picking; }
  function askUploads() { toGame('hdIconList'); T.set('pk-refresh-a', refreshPicker, 700); T.set('pk-refresh-b', refreshPicker, 1800); }
  function pickerTabs(p, all) {
    return [['book', 'The book', all.book.length], ['yours', 'Yours & uploads', all.yours.length], ['game', 'Game icons', all.game.length]].map(function (t) {
      return '<button class="bx-pk-tab' + (p.tab === t[0] ? ' bx-on' : '') + '" data-act="pk-tab" data-tab="' + t[0] + '">' + t[1] + '<b>' + t[2] + '</b></button>';
    }).join('');
  }
  function pickerList(p, all) {
    var list = all[p.tab] || [], q = String(p.q || '').trim().toLowerCase();
    if (q) list = list.filter(function (x) { return (x.label + ' ' + x.src).toLowerCase().indexOf(q) >= 0; });
    var more = list.length > p.shown, h = '<div class="bx-pk-grid">';
    list.slice(0, p.shown).forEach(function (x) {
      h += '<button class="bx-pk-tile' + (x.src === p.sel ? ' bx-on' : '') + '" data-act="pk-tile" data-src="' + esc(x.src) + '" title="' + esc(x.label) + '">' +
        '<img src="' + esc(x.src) + '" alt="" onerror="this.style.visibility=\'hidden\'"></button>';
    });
    h += '</div>';
    if (more) h += '<button class="bx-more-btn bx-pk-more" data-act="pk-more">Show ' + Math.min(PICK_PAGE, list.length - p.shown) + ' more of ' + list.length + '</button>';
    if (!list.length) h += '<div class="bx-res-none">' + (q ? 'Nothing matches “' + esc(p.q) + '”.' : p.tab === 'yours' ? 'No pictures of your own yet: upload them on the Deck Portal’s Icons tab, then press Refresh below.' : 'Nothing here.') + '</div>';
    return h;
  }
  function pickerHTML(p) {
    var all = pickSources();
    return '<div class="bx-pk"><div class="bx-pk-top"><div class="bx-pk-tabs" id="bx-pk-tabs">' + pickerTabs(p, all) + '</div>' +
      '<div class="bx-input" id="bx-pk-box">' + img('sn-search') + '<input id="bx-pk-q" type="text" placeholder="Search pictures…" value="' + esc(p.q) + '" autocomplete="off" spellcheck="false"></div></div>' +
      '<div class="bx-pk-list" id="bx-pk-list">' + pickerList(p, all) + '</div>' +
      '<div class="bx-pk-hint">Your own pictures: upload them from the <b>Deck Portal</b> (phone or PC browser), <b>Icons</b> tab — they land here. ' +
      '<button class="bx-mini" data-act="pk-refresh">Refresh</button></div></div>';
  }
  /* only the tabs and the grid: the search box keeps its focus and caret */
  function refreshPicker() {
    var p = curPick(), tabs = document.getElementById('bx-pk-tabs'), list = document.getElementById('bx-pk-list');
    if (!p || !tabs || !list) return;
    var all = pickSources();
    setHTML(tabs, pickerTabs(p, all));
    setHTML(list, pickerList(p, all));
    railsSoon();
  }
  function markPicked(p) {
    var ts = ui.modalBack.querySelectorAll('.bx-pk-tile');
    for (var i = 0; i < ts.length; i++) ts[i].classList.toggle('bx-on', ts[i].getAttribute('data-src') === p.sel);
  }

  function openShelf(id) {
    var c = id ? CH.filter(function (x) { return x.id === id && x.mine; })[0] : null;
    if (st.list) closeList();
    if (st.edit) closeEdit();
    st.shelf = { id: c ? c.id : '', name: c ? c.name : '', blurb: c ? c.rawBlurb : '', confirm: false,
      pick: { q: '', tab: c && c.iconPath ? kindOfPic(c.iconPath) : 'book', shown: PICK_PAGE, sel: c ? c.iconPath : '' } };
    renderShelf(true);
    askUploads();
  }
  function closeShelf() { st.shelf = null; ui.modalBack.classList.add('bx-hidden'); setHTML(ui.modalBack, ''); }
  function renderShelf(entrance) {
    var sh = st.shelf; if (!sh) return;
    var h = '<div class="bx-modal bx-modal-wide' + (entrance ? ' bx-modal-in' : '') + '" role="dialog" aria-label="' + (sh.id ? 'Edit chapter' : 'New chapter') + '">' +
      '<div class="bx-modal-head"><img id="bx-sh-ic" src="' + icon(sh.pick.sel || 'bx-quill') + '" alt=""><div><div class="bx-modal-title">' + (sh.id ? 'Edit your chapter' : 'A chapter of your own') +
      '</div><div class="bx-modal-sub">Name it and give it a picture. File any creature into it from its page: Edit this page, Chapter.</div></div>' +
      '<button class="bx-tool bx-close" data-act="sh-cancel" title="Close (Esc)">×</button></div><div class="bx-modal-body">' +
      '<section><div class="bx-field-h">Name</div><label class="bx-ed-in bx-wide"><input data-sh="name" type="text" maxlength="60" value="' + esc(sh.name) +
      '" placeholder="e.g. My enemies, The hunt list, Things that ate my horse" autocomplete="off" spellcheck="false"></label></section>' +
      '<section><div class="bx-field-h">A line under the title</div><textarea data-sh="blurb" rows="2" maxlength="300" placeholder="What belongs in this chapter">' + esc(sh.blurb) + '</textarea></section>' +
      '<section><div class="bx-field-h">Picture</div>' + pickerHTML(sh.pick) + '</section></div>' +
      '<div class="bx-modal-foot"><span class="bx-grow">' + (sh.confirm ? 'Delete it? Its pages go back to the chapter the book gave them.' : 'Kept in bestiary.json with the rest of the book.') + '</span>' +
      (sh.id ? '<button class="bx-mini bx-danger" data-act="sh-delete">' + (sh.confirm ? 'Yes, delete it' : 'Delete chapter') + '</button>' : '') +
      '<button class="bx-mini" data-act="sh-cancel">Cancel</button><button class="bx-mini bx-primary" data-act="sh-save" id="bx-sh-save"' + (sh.name.trim() ? '' : ' disabled') + '>' +
      (sh.id ? 'Save chapter' : 'Add chapter') + '</button></div></div>';
    setHTML(ui.modalBack, h);
    ui.modalBack.classList.remove('bx-hidden'); railsSoon();
    if (entrance) { var n = ui.modalBack.querySelector('[data-sh="name"]'); if (n) n.focus(); }
  }
  function saveShelf() {
    var sh = st.shelf; if (!sh || !sh.name.trim()) return;
    if (!sh.id) st.pendingShelf = sh.name.trim();
    toGame('bxShelf', JSON.stringify({ op: 'save', chapter: { id: sh.id, name: sh.name.trim(), blurb: sh.blurb.trim(), icon: safePic(sh.pick.sel) } }));
    closeShelf();
  }
  /* the editor's picture: the same picker, in the editor's own popout */
  function renderPicking() {
    var ed = st.edit, p = ed && ed.picking; if (!p) return;
    var e = byId(ed.id) || {};
    setHTML(ui.modalBack, '<div class="bx-modal bx-modal-wide" role="dialog" aria-label="Choose a picture">' +
      '<div class="bx-modal-head"><img id="bx-sh-ic" src="' + icon(p.sel || 'bx-quill') + '" alt=""><div><div class="bx-modal-title">A picture for ' + esc(e.name || 'this page') +
      '</div><div class="bx-modal-sub">It stands in for the book’s drawing everywhere: the page, the medals, the lists.</div></div>' +
      '<button class="bx-tool bx-close" data-act="pk-back" title="Back (Esc)">×</button></div><div class="bx-modal-body">' + pickerHTML(p) + '</div>' +
      '<div class="bx-modal-foot"><span class="bx-grow">Saved with the page when you press Save.</span><button class="bx-mini" data-act="pk-back">Back</button>' +
      '<button class="bx-mini bx-primary" data-act="pk-use"' + (p.sel ? '' : ' disabled') + '>Use this picture</button></div></div>');
    ui.modalBack.classList.remove('bx-hidden'); railsSoon();
    var q = document.getElementById('bx-pk-q'); if (q) q.focus();
  }
  function shelfClick(a, t) {
    var p = curPick();
    if (a === 'pk-tab' && p) { p.tab = t.getAttribute('data-tab'); p.shown = PICK_PAGE; refreshPicker(); return; }
    if (a === 'pk-more' && p) { p.shown += PICK_PAGE; refreshPicker(); return; }
    if (a === 'pk-refresh') { askUploads(); return; }
    if (a === 'pk-tile' && p) {
      p.sel = t.getAttribute('data-src') || '';
      markPicked(p);
      var hi = document.getElementById('bx-sh-ic'); if (hi) hi.src = icon(p.sel || 'bx-quill');
      var use = ui.modalBack.querySelector('[data-act="pk-use"]'); if (use) use.disabled = !p.sel;
      return;
    }
    if (a === 'pk-use' && st.edit && st.edit.picking) { st.edit.d.art = st.edit.picking.sel; st.edit.picking = null; renderEdit(false); return; }
    if (a === 'pk-back' && st.edit) { st.edit.picking = null; renderEdit(false); return; }
    if (!st.shelf) return;
    if (a === 'sh-cancel') closeShelf();
    else if (a === 'sh-save') saveShelf();
    else if (a === 'sh-delete') {
      if (!st.shelf.confirm) { st.shelf.confirm = true; renderShelf(false); return; }
      var id = st.shelf.id;
      if (st.chapter === id) st.chapter = 'all';
      toGame('bxShelf', JSON.stringify({ op: 'delete', id: id }));
      closeShelf();
    }
  }

  /* ---------------------------------------------------------- Scribe --- */
  function openScribe() {
    var s = (st.data && st.data.scribe) || {};
    st.scribe = { model: s.model || MODELS[0].id, voice: s.voice || 'scholar', length: s.length || 'standard', codex: s.codex !== false,
      chim: !!s.chim, auto: s.auto !== false, spoilers: !!s.spoilers, draft: '', show: false, editing: s.keyState !== 'saved', test: null };
    st.modelQ = '';
    renderScribe(true);
    var inp = document.getElementById('bx-key');
    if (inp) inp.focus();
  }
  /* the key or the model may have changed what the pages offer ("Set up the
     Scribe" -> "Write this page"), so the book redraws once on close */
  function closeScribe(quiet) {
    st.scribe = null; ui.modalBack.classList.add('bx-hidden'); setHTML(ui.modalBack, '');
    if (!quiet) { st.chromeKey = ''; render(); }
  }
  /* the model list alone: filtering rewrites this and keeps the input mounted */
  function modelListHTML(d) {
    var q = st.modelQ.trim().toLowerCase();
    var models = MODELS.filter(function (m) { return !q || m.name.toLowerCase().indexOf(q) >= 0 || m.id.indexOf(q) >= 0; });
    return models.map(function (m, i) {
      return '<button class="bx-model' + (m.id === d.model ? ' bx-on' : '') + (q && i === 0 ? ' bx-hot' : '') + '" data-act="sc-model" data-id="' + esc(m.id) + '"><span style="flex:1 1 auto;min-width:0"><div class="bx-model-name">' + esc(m.name) +
        '</div><div class="bx-model-id">' + esc(m.id) + '</div></span>' + (m.tag ? '<span class="bx-model-tag">' + esc(m.tag) + '</span>' : '') + '<span class="bx-model-cost">' + esc(m.cost) + '</span></button>';
    }).join('') || '<div class="bx-res-none">No model matches “' + esc(st.modelQ) + '”. Any OpenRouter model id typed in full is accepted; press Enter to use it.</div>';
  }

  function renderScribe(entrance) {
    var d = st.scribe, s = (st.data && st.data.scribe) || {};
    if (!d) return;
    var keyRow = d.editing
      ? '<div class="bx-keyrow"><div class="bx-input" id="bx-key-box"><input id="bx-key" type="' + (d.show ? 'text' : 'password') + '" placeholder="sk-or-v1-…  paste your OpenRouter key" value="' + esc(d.draft) + '" autocomplete="off" spellcheck="false">' +
        '<button class="bx-mini" data-act="sc-show">' + (d.show ? 'Hide' : 'Show') + '</button></div>' +
        (s.keyState === 'saved' ? '<button class="bx-mini" data-act="sc-cancel-key">Keep saved key</button>' : '') + '</div>'
      : '<div class="bx-keyrow"><div class="bx-saved"><span class="bx-saved-key">' + esc(s.key || '') + '</span><span class="bx-saved-state">Saved on this PC' + (s.credit ? ' · ' + esc(s.credit) + ' credit left' : '') + '</span></div>' +
        '<button class="bx-mini" data-act="sc-test">Test</button><button class="bx-mini" data-act="sc-replace">Replace</button><button class="bx-mini" data-act="sc-remove">Remove</button></div>';
    var tog = function (k, name, help) {
      return '<button class="bx-toggle' + (d[k] ? ' bx-on' : '') + '" data-act="sc-tog" data-k="' + k + '"><span class="bx-toggle-text"><div class="bx-toggle-name">' + name + '</div><div class="bx-toggle-help">' + help + '</div></span><span class="bx-switch"></span></button>';
    };
    setHTML(ui.modalBack, '<div class="bx-modal' + (entrance ? ' bx-modal-in' : '') + '" role="dialog" aria-label="The Scribe">' +
      '<div class="bx-modal-head"><img src="' + icon('bx-quill') + '" alt=""><div><div class="bx-modal-title">The Scribe</div><div class="bx-modal-sub">Writes the lore on every page with your own AI key. Works without CHIM.</div></div>' +
        '<button class="bx-tool bx-close" data-act="sc-close" title="Close (Esc)">×</button></div>' +
      '<div class="bx-modal-body">' +
        '<div><div class="bx-field-h">OpenRouter key</div>' + keyRow +
          '<div class="bx-test' + (d.test ? (d.test.ok ? ' bx-ok' : ' bx-bad') : '') + '">' + (d.test ? esc(d.test.msg) : '') + '</div>' +
          '<div class="bx-field-help">Kept in SkyManager.ini on this PC and sent only to openrouter.ai. The page never shows it again after you save; it holds the last four characters. Get a key at openrouter.ai/keys.</div></div>' +
        lessonsBlock() +
        '<div class="bx-combo"><div class="bx-field-h">Model</div><div class="bx-input" id="bx-model-box"><img src="' + icon('sn-search') + '" alt="" style="width:calc(30 * var(--u));height:calc(30 * var(--u))">' +
          '<input id="bx-model-q" type="text" placeholder="Filter models, or type any OpenRouter model id" value="' + esc(st.modelQ) + '" autocomplete="off" spellcheck="false"></div>' +
          '<div class="bx-combo-list" id="bx-combo-list">' + modelListHTML(d) + '</div></div>' +
        '<div><div class="bx-field-h">The Scribe’s voice</div><div class="bx-voices">' + VOICES.map(function (v) {
          return '<button class="bx-voice' + (d.voice === v.k ? ' bx-on' : '') + '" data-act="sc-voice" data-k="' + v.k + '"><span class="bx-voice-name">' + esc(v.name) + '</span><span class="bx-voice-eg">' + esc(v.eg) + '</span></button>';
        }).join('') + '</div></div>' +
        '<div class="bx-two"><div><div class="bx-field-h">Length</div><div class="bx-seg">' + ['short', 'standard', 'long'].map(function (k) {
          return '<button class="' + (d.length === k ? 'bx-on' : '') + '" data-act="sc-len" data-k="' + k + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</button>';
        }).join('') + '</div><div class="bx-field-help">Short is one paragraph; Long is three, with habitat and hunting advice.</div></div>' +
        '<div><div class="bx-field-h">Spend</div><div class="bx-field-help" style="margin-top:0">One request per creature, written once and kept in the book. Rewrite asks again. With the default model, a hundred pages cost about six cents.</div></div></div>' +
        '<div><div class="bx-field-h">Grounding</div><div class="bx-toggles">' +
          tog('auto', 'Write new pages by themselves', 'The first kill of a new kind asks the Scribe straight away, in the background.') +
          tog('spoilers', 'Allow quest spoilers', 'Off: the Scribe stays silent about named quest creatures until you have met them.') +
        '</div></div>' +
      '</div>' +
      '<div class="bx-modal-foot"><span class="bx-grow">Changes apply to the next page the Scribe writes.</span><button class="bx-mini" data-act="sc-close">Cancel</button><button class="bx-mini bx-primary" data-act="sc-save">Save</button></div>' +
    '</div>');
    ui.modalBack.classList.remove('bx-hidden'); railsSoon();
    var nl = document.getElementById('bx-lesson-new');
    if (nl) nl.addEventListener('input', function () { st.lessonQ = nl.value; });
    var key = document.getElementById('bx-key'), mq = document.getElementById('bx-model-q');
    if (key) {
      key.addEventListener('input', function () { d.draft = key.value; });
      key.addEventListener('focus', function () { document.getElementById('bx-key-box').classList.add('bx-focus'); });
      key.addEventListener('blur', function () { var b = document.getElementById('bx-key-box'); if (b) b.classList.remove('bx-focus'); });
    }
    if (mq) {
      mq.addEventListener('input', function () {
        st.modelQ = mq.value;
        T.set('model-q', function () { if (st.scribe) setHTML(document.getElementById('bx-combo-list'), modelListHTML(st.scribe)); }, 60);
      });
    }
  }
  /* What the Scribe has learned: every lesson is the reader's own correction,
     sent with every page it writes. Each one edits in place or goes. */
  function lessonsBlock() {
    var ls = ((st.data && st.data.scribe) || {}).lessons || [];
    var h = '<div><div class="bx-field-h">What the Scribe has learned' + (ls.length ? ' \u00B7 ' + ls.length : '') + '</div>';
    if (!ls.length) h += '<div class="bx-field-help" style="margin:0 0 14px">Nothing yet. Correct a page with Edit page \u2192 Teach the Scribe, or add a rule here. Every page it writes follows them.</div>';
    h += '<div class="bx-lessons">' + ls.map(function (l, i) {
      return '<div class="bx-lesson"><span class="bx-lesson-n">' + (i + 1) + '</span><label class="bx-ed-in bx-wide"><input data-lesson="' + i + '" type="text" value="' + esc(l.text || '') +
        '" autocomplete="off" spellcheck="false"></label><span class="bx-lesson-at">' + esc(l.at || '') + '</span>' +
        '<button class="bx-mini" data-act="sc-lesson-save" data-i="' + i + '">Save</button><button class="bx-mini" data-act="sc-lesson-del" data-i="' + i + '">Remove</button></div>';
    }).join('') + '</div><div class="bx-lesson bx-lesson-add"><span class="bx-lesson-n">+</span><label class="bx-ed-in bx-wide"><input id="bx-lesson-new" type="text" value="' + esc(st.lessonQ) +
      '" placeholder="A rule for every page, e.g. \u201CWrite of Skyrim as it was in 4E 201\u201D" autocomplete="off" spellcheck="false"></label>' +
      '<button class="bx-mini bx-primary" data-act="sc-lesson-add">Add</button></div></div>';
    return h;
  }

  function scribeClick(a, t) {
    var d = st.scribe; if (!d) return;
    var s = st.data.scribe = st.data.scribe || {};
    if (a === 'sc-close') return closeScribe();
    if (a === 'sc-lesson-add') {
      var nv = (document.getElementById('bx-lesson-new') || {}).value || '';
      if (nv.trim()) { toGame('bxLesson', JSON.stringify({ op: 'add', text: nv.trim() })); st.lessonQ = ''; }
      return;
    }
    if (a === 'sc-lesson-save' || a === 'sc-lesson-del') {
      var li = +t.getAttribute('data-i'), field = ui.modalBack.querySelector('[data-lesson="' + li + '"]');
      toGame('bxLesson', JSON.stringify(a === 'sc-lesson-del' ? { op: 'remove', index: li } : { op: 'edit', index: li, text: field ? field.value : '' }));
      return;
    }
    if (a === 'sc-show') d.show = !d.show;
    else if (a === 'sc-replace') { d.editing = true; d.draft = ''; d.test = null; }
    else if (a === 'sc-cancel-key') { d.editing = false; d.draft = ''; }
    else if (a === 'sc-remove') { toGame('bxScribe', JSON.stringify({ op: 'remove' })); s.keyState = 'none'; s.key = ''; s.credit = ''; d.editing = true; d.test = { ok: false, msg: 'Key removed from this PC.' }; }
    else if (a === 'sc-test') { toGame('bxScribe', JSON.stringify({ op: 'test', model: d.model })); d.test = { ok: true, msg: 'Asking OpenRouter…' }; }
    /* choices move their own .bx-on; the popout is not rebuilt */
    else if (a === 'sc-model' || a === 'sc-voice' || a === 'sc-len') {
      var field = a === 'sc-model' ? 'model' : a === 'sc-voice' ? 'voice' : 'length', val = t.getAttribute(a === 'sc-model' ? 'data-id' : 'data-k');
      d[field] = val;
      var sib = ui.modalBack.querySelectorAll('[data-act="' + a + '"]');
      for (var i = 0; i < sib.length; i++) sib[i].classList.toggle('bx-on', sib[i] === t);
      return;
    }
    else if (a === 'sc-tog') { var k = t.getAttribute('data-k'); d[k] = !d[k]; t.classList.toggle('bx-on', d[k]); return; }
    else if (a === 'sc-save') {
      var payload = { op: 'save', model: d.model, voice: d.voice, length: d.length, codex: d.codex, chim: d.chim, auto: d.auto, spoilers: d.spoilers };
      if (d.editing && d.draft.trim()) payload.key = d.draft.trim();
      if (d.editing && !d.draft.trim() && s.keyState !== 'saved') { d.test = { ok: false, msg: 'Paste a key first — it starts with sk-or-.' }; renderScribe(); return; }
      toGame('bxScribe', JSON.stringify(payload));
      if (payload.key) { s.key = payload.key.slice(0, 9) + '…' + payload.key.slice(-4); s.keyState = 'saved'; }
      s.model = d.model; s.voice = d.voice; s.length = d.length; s.codex = d.codex; s.chim = d.chim; s.auto = d.auto; s.spoilers = d.spoilers;
      d.draft = '';
      return closeScribe();
    }
    renderScribe();
  }
  function scribeKey(ev) {
    var k = keyOf(ev), a = document.activeElement;
    if (k === 'Escape') { closeScribe(); return true; }
    if (a && a.id === 'bx-model-q' && k === 'Enter') {
      var first = ui.modalBack.querySelector('.bx-model');
      if (first) { st.scribe.model = first.getAttribute('data-id'); st.modelQ = ''; renderScribe(); }
      else if (st.modelQ.indexOf('/') > 0) { st.scribe.model = st.modelQ.trim(); st.modelQ = ''; renderScribe(); }
      return true;
    }
    return false;   // typing in the modal's fields is theirs; the book ignores it
  }

  /* ---------------------------------------------------------- public --- */
  /* every state that enters the book is made safe to draw first */
  function takeData(d) {
    if (!d || typeof d !== 'object') return false;
    d.entries = arr(d.entries).map(normEntry).filter(Boolean);
    st.data = d; st.lastRev = d.rev != null ? d.rev : null; st.gen++;
    setShelves(d.shelves);
    /* a chapter just added: open it once it has an id */
    if (st.pendingShelf) {
      var made = CH.filter(function (c) { return c.mine && c.name === st.pendingShelf; }).pop();
      if (made) { st.view = 'contents'; st.chapter = made.id; st.turn = 'next'; }
      st.pendingShelf = '';
    }
    return true;
  }
  function open(opts) {
    opts = opts || {};
    if (!root) build();
    if (opts.data) takeData(opts.data);
    if (opts.chapter) { st.chapter = opts.chapter; st.view = 'contents'; }
    if (opts.entry && byId(opts.entry)) { st.id = opts.entry; st.view = 'entry'; st.folio = 'specimen'; }
    if (!st.id && entries().length) st.id = sorted(entries(), 'kills')[0].id;
    if (!st.open) {
      sound('open'); st.justOpened = true;
      /* the book rises in (transform + opacity, 200 ms) and the first tabs follow it */
      root.classList.add('bx-opening');
      T.set('opening', function () { root.classList.remove('bx-opening'); }, 420);
    }
    st.open = true;
    setU();
    root.classList.remove('bx-hidden');
    /* "1M": a modal capture. The book is read for minutes; a plain "1" is
       stamped, and C++ force-closes a capture older than 20 s on the next key
       (or on a quick second Esc), which shut the palette under the book. */
    toGame('hdCapture', '1M');
    if (!opts.data) toGame('bxOpen', '{}');
    st.turn = 'next';
    render();
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    T.all();
    if (typeof specStop === 'function') specStop();
    ribbon('');
    if (st.scribe) closeScribe(true);
    if (st.edit) closeEdit();
    if (st.list) closeList();
    if (st.shelf) closeShelf();
    st.writeWatch = {}; st.pendingGo = null; st.edit = null; st.loreAnim = null;
    root.classList.remove('bx-opening');
    root.classList.add('bx-hidden');
    if (document.activeElement && root.contains(document.activeElement)) { try { document.activeElement.blur(); } catch (x) {} }
    toGame('hdCapture', '0');
    sound('close');
    /* the deck flushes the pane redraws it held back while the book was up */
    try { window.dispatchEvent(new Event('hd-bestiary-close')); } catch (x) {}
  }
  /* C++ -> view: the whole state (entries + scribe, never the raw key) */
  window.bxState = function (json) {
    var d; try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
    if (!d || typeof d !== 'object' || isArr(d)) return;
    /* nothing written since the last state this book drew: skip the redraw */
    if (d.rev != null && d.rev === st.lastRev && st.data && !st.pendingGo) return;
    takeData(d);
    var pg = st.pendingGo;
    if (pg && byId(pg.id)) {
      st.pendingGo = null;
      if (st.open) { if (pg.fresh) st.freshId = pg.id; go(pg.id, 'next', pg.folio); return; }
      /* answered after the book was closed: the next open lands on the page
         just studied (and plays its new-page flourish there, nowhere else) */
      st.id = pg.id; st.view = 'entry'; st.folio = pg.folio || 'specimen'; st.angle = 0;
      st.freshId = pg.fresh ? pg.id : '';
    }
    if (st.open) render();
  };

  /* ---- Study from the F7 card ------------------------------------------
     HDBestiary.study({formId, name}): open the book at once on the Studying
     emblem, measure that actor (bxStudy), then land on its page. With a Scribe
     key and no page yet the lore is written while you watch: the book opens on
     Field notes, the ink lines shimmer while the request is out, and the quill
     writes the text in as it lands (bxEntry -> st.loreAnim). */
  function ribbon(text, ms) {
    if (!ui.ribbon) return;
    T.clear('ribbon');
    if (!text && ui.ribbon.classList.contains('bx-hidden')) return;
    setHTML(ui.ribbon, text ? '<img src="' + icon('bx-quill') + '" alt=""><span>' + text + '</span>' : '');
    ui.ribbon.classList.toggle('bx-hidden', !text);
    if (text && ms) T.set('ribbon', function () { ribbon(''); }, ms);
  }
  /* clears every specimen timer and poll; close() calls it */
  function specStop() {
    stopSpinPoll();
    stopWatch();
    if (sp.holdT) { clearTimeout(sp.holdT); sp.holdT = 0; }
    if (sp.failT) { clearTimeout(sp.failT); sp.failT = 0; }
    /* closed mid-study: the next open must not land on an empty 'studying' spread */
    if (st.view === 'studying') st.view = (sp.tok && sp.tok.prev.view) || 'entry';
    sp.tok = null;
    studyDone(false);
    ribbon('');
  }
  function study(o) {
    o = o || {};
    if (sp.tok) return;   // one study at a time: a second press while the book reads is ignored
    var t = sp.tok = {
      seq: ++sp.seq, t: Date.now(), name: String(o.name || ''), id: null, failed: false, why: '',
      prev: { open: st.open, view: st.view === 'studying' ? 'entry' : st.view, id: st.id, folio: st.folio, chapter: st.chapter }
    };
    ribbon('');
    st.view = 'studying';
    /* through window.HDBestiary: hd-css wraps open (and this study) so the sheet
       is live before the book lays itself out */
    var api = window.HDBestiary;
    if (api && typeof api.open === 'function') api.open({}); else open({});
    if (sp.tok !== t) return;
    if (st.open) { st.view = 'studying'; renderStudying(); }
    toGame('bxStudy', JSON.stringify({ formId: o.formId || 0 }));
    stopWatch();
    sp.watchT = setInterval(watchLanding, 90);
    sp.failT = setTimeout(function () { sp.failT = 0; if (sp.tok === t && !t.id) studyFail(''); }, 8000);
  }
  window.bxStudied = function (json) {
    var r; try { r = typeof json === 'string' ? JSON.parse(json) : json; } catch (x) { return; }
    var t = sp.tok;
    if (!r || !r.ok) {
      if (t) studyFail((r && r.why) || '');
      else ribbon(esc((r && r.why) || 'The book could not measure that one.'), 4200);
      return;
    }
    if (r.writing) st.writeWatch[r.id] = true;
    function land() {
      sp.holdT = 0;
      if (t && sp.tok !== t) return;   // the book was closed meanwhile; its open lands there instead
      if (t) t.id = r.id;
      ribbon(r.writing ? 'Measured. The Scribe is writing its page…' : (r.fresh ? 'A new page in the Bestiary.' : ''), r.writing ? 0 : 2600);
      if (r.fresh) { sound('new'); sp.lateStamp = r.id; }
      st.pendingGo = { id: r.id, folio: r.writing ? 'notes' : 'specimen', fresh: !!r.fresh };
      toGame('bxOpen', '{}');
    }
    if (!t) { land(); return; }
    /* the emblem holds for at least 700 ms, so a fast answer still reads as a ceremony */
    var wait = Math.max(0, 700 - (Date.now() - t.t));
    if (sp.failT) { clearTimeout(sp.failT); sp.failT = 0; }
    if (sp.holdT) clearTimeout(sp.holdT);
    sp.holdT = setTimeout(land, wait);
    /* the page never came: let go of the emblem rather than hold the book */
    sp.failT = setTimeout(function () { sp.failT = 0; if (sp.tok === t) { sp.tok = null; stopWatch(); studyDone(true); if (st.view === 'studying') st.view = t.prev.view; if (st.open) render(); } }, wait + 6000);
  };
  /* C++ -> view: the answer to bxScribe {op:'test'|'save'|'remove'} */
  window.bxScribeResult = function (json) {
    var r; try { r = typeof json === 'string' ? JSON.parse(json) : json; } catch (x) { return; }
    if (r.scribe && st.data) st.data.scribe = r.scribe;
    if (st.scribe) { if (r.msg) st.scribe.test = { ok: !!r.ok, msg: r.msg }; renderScribe(); }
    else if (st.open) render();
  };
  /* C++ -> view: one entry changed (a lore page landed, a render finished).
     Redraws as little as it can: an entry not on screen patches only its row
     (or its variant chip); the shown entry whose lore alone changed swaps only
     the lore section; anything else redraws the pages. */
  function sameBut(a, b) {
    var skip = function (k, v) { return (k === 'lore' || k === '_facets') ? undefined : v; };
    try { return JSON.stringify(a, skip) === JSON.stringify(b, skip); } catch (x) { return false; }
  }
  function patchElsewhere(e, old) {
    if (st.view === 'contents') {
      var row = ui.right.querySelector('.bx-row[data-id="' + e.id.replace(/"/g, '') + '"]');
      if (row) {
        var tmp = document.createElement('div');
        setHTML(tmp, rowHTML(e, 99));
        row.parentNode.replaceChild(tmp.firstChild, row);
      } else if (!old && inChapter(e, st.chapter)) render();
      return;
    }
    var v = ui.left.querySelector('.bx-var[data-id="' + e.id.replace(/"/g, '') + '"] .bx-var-thumb');
    var a = artOf(e), im = v && v.querySelector('img');
    if (v && a && (!im || im.getAttribute('src') !== a)) setHTML(v, '<img class="bx-crop" src="' + esc(a) + '" alt="">');
  }
  window.bxEntry = function (json) {
    var e; try { e = typeof json === 'string' ? JSON.parse(json) : json; } catch (x) { return; }
    e = normEntry(e);
    if (!e || !st.data) return;
    var a = entries(), old = null;
    for (var i = 0; i < a.length; i++) if (a[i].id === e.id) { old = a[i]; a[i] = e; break; }
    if (!old) a.push(e);
    st.gen++;
    /* a page that was being written (Write, Rewrite, the Scribe's own first
       page after a study) has landed: the quill writes it in */
    var watched = !!st.writeWatch[e.id], wasBusy = watched || !!(old && loreBusy(old.lore)), nl = e.lore;
    if (wasBusy && !loreBusy(nl)) {
      delete st.writeWatch[e.id];
      delete st.pendSince[e.id];
      if (arr(nl.text).length && nl.state !== 'error' && !nl.lastError) { st.loreAnim = { id: e.id, i: 0 }; if (watched) ribbon(''); }
      else if (watched || st.id === e.id) ribbon(esc(nl.lastError || nl.error || 'The Scribe could not write this page.'), 5200);
    }
    if (st.edit && st.edit.pendingReopen && st.edit.id === e.id) { var sv = st.edit.saved; openEdit(); st.edit.saved = sv; renderEdit(); return; }
    if (!st.open || st.scribe || st.edit || st.list) return;
    if (!(st.view === 'entry' && st.id === e.id)) { patchElsewhere(e, old); return; }
    if (old && sameBut(old, e)) {
      if (st.folio !== 'notes') return;          // the lore is not on this folio
      if (replaceLore(e)) return;
    }
    render();
  };

  /* stats(): the Home tile's live line ("12 kinds · 87 slain"); null until the
     book has seen a state */
  function stats() {
    if (!st.data) return null;
    var a = entries(), k = 0;
    for (var i = 0; i < a.length; i++) k += +slain(a[i]) || 0;
    return { kinds: a.length, slain: k };
  }
  /* C++ hands the book an Esc it may never have seen (hdModalEscape in
     hd-omni.js): run it exactly as the keydown would */
  function escape() {
    onKey({ key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {} });
  }
  window.HDBestiary = { open: open, close: close, study: study, isOpen: function () { return st.open; }, peek: peek, stats: stats, escape: escape };

  /* C++ -> view: a deck action asked for the book ({entry?}) — "The Bestiary",
     or "Study Creature" after it measured the creature under the crosshair. */
  window.hdBestiaryOpen = function (json) {
    var o = {}; try { o = typeof json === 'string' ? JSON.parse(json || '{}') : (json || {}); } catch (x) {}
    /* through window.HDBestiary, never the closures: hd-css wraps open AND
       study so a cold sheet is in place before the book lays itself out */
    var api = window.HDBestiary || {};
    if (o.study && o.study.formId) { if (api.study) api.study(o.study); else study(o.study); }
    else if (api.open) api.open(o.entry ? { entry: o.entry } : {});
    else open(o.entry ? { entry: o.entry } : {});
  };

  /* ---- Omni (the deck's command palette) --------------------------------
     The book itself, every chapter, and every creature the book holds. A
     creature row opens the book on its page; it is pinnable to the Favorites
     Shelf as bx:<id>. Rows come from the last state C++ pushed (bxState); until
     then only the book and its chapters are offered, and warm() asks for it. */
  if (window.HDOmni) HDOmni.register({
    id: 'bestiary', label: 'Bestiary', tab: '',
    warm: function () { if (!st.data) toGame('bxOpen', '{}'); },
    pinRun: function (snap) { if (snap && snap.id) open({ entry: snap.id }); },
    index: function () {
      var rows = [{
        label: 'The Bestiary', detail: 'Every creature you have met: threat, resistances, lore, where you met it',
        kind: 'bestiary', icon: icon('bx-all'), pin: 'bx:book',
        keywords: 'bestiary monster log monsters creatures beasts kills slain hunting journal codex lore resist resistance weakness',
        run: function () { open({}); }
      }];
      CH.forEach(function (c) {
        if (c.id === 'all') return;
        rows.push({ label: 'Bestiary \u203A ' + c.name, detail: c.blurb, kind: 'bestiary', icon: icon(c.icon), pin: 'bx:ch:' + c.id,
          keywords: 'bestiary chapter ' + c.id, run: function () { open({ chapter: c.id }); } });
      });
      entries().forEach(function (e) {
        rows.push({ label: e.name, detail: humanKin(e.family || e.race || '') + ' \u00B7 ' + chOf(e.chapter).name + ' \u00B7 ' + slain(e) + ' slain',
          kind: 'creature', icon: artOf(e) || icon(chOf(e.chapter).icon), pin: 'bx:' + e.id, snap: { id: e.id },
          keywords: ['bestiary creature', e.family, humanKin(e.family || ''), e.race, e.plugin, chOf(e.chapter).name, e._facets].filter(Boolean).join(' '),
          run: function () { open({ entry: e.id }); } });
      });
      return rows;
    }
  });
})();
