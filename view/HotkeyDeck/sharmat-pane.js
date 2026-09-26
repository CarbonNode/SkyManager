'use strict';

/* ====================================================================== *
 *  Sharmat modal — CHIM's per-NPC intimacy profile, edited in-game.
 *
 *  Opened from the Followers tab's member menu (right-click a follower →
 *  "Sharmat profile…") and from the CHIM flyout. A FULL-SCREEN modal over
 *  the deck's overlay: it belongs TO a person the way the member menu does,
 *  but it holds ~40 controls in eight groups and a 660px floating popout
 *  could only ever render that as a ribbon of 12px labels.
 *
 *  ---- what talks to what ------------------------------------------------
 *    JS  → C++ : smCall({ id, action, query, form })   — one HTTP request
 *    C++ → JS  : smReply({ id, ok, status, json | error, chimDown })
 *  The C++ side (src/sharmat.cpp) is a DUMB PIPE: it knows how to reach
 *  CHIM and nothing else. Everything about what the fields mean lives
 *  here, so adding one is a view edit — no DLL rebuild.
 *
 *  ⛔ WHY EVERY SAVE IS A READ-MODIFY-WRITE ⛔
 *  CHIM's saveNpcNsfwSettings reads most fields as `$_POST[x] ?? default`
 *  and unset()s prostitute_pricing / slave_speak_styles unless they are
 *  re-posted. Posting only what changed therefore WIPES the rest — proven
 *  against the real handler: a bare {npc, sex_prompt} post cleared both
 *  kink lists, the pricing table, the speak style and the profanity level.
 *  So commit() always re-reads the profile, lays the local edits over it,
 *  and posts the WHOLE field set back. Do not "optimise" that away.
 *
 *  The panel is draft-then-commit for the same reason: one Save = one
 *  read-modify-write, instead of one per control.
 *
 *  ---- 2026-09-20: everything CHIM stores is now on screen ---------------
 *  Two of the load payload's richest fields were being carried through
 *  untouched and never DRAWN — so the deck was silently the lesser editor:
 *    · `pricing`            → her trade: type, motivation, payment kind and
 *                             the four prostitution scene prompts.
 *    · `slave_speak_styles` → her servitude voice: speak style, scene cues,
 *                             three affinity-tiered climax lines, the owner
 *                             climax line and the aftermath line.
 *  Both are free-form objects server-side. Every editor below therefore
 *  MERGES into whatever is already there (subSet) rather than replacing it,
 *  so a key CHIM grows tomorrow — or one its own web page writes — survives
 *  a save from here. Verified against the live plugin on the rig
 *  (ext/aiagent_nsfw/config_manager.php + background_profile_worker.php,
 *  build dated 2026-09-17).
 * ====================================================================== */

var SmPane = (function () {
  /* ---- the field set, in the shape CHIM's two endpoints speak ---------- *
   *  `load` is the key loadNpcNsfwSettings answers with; `post` is the key
   *  saveNpcNsfwSettings reads. They differ for enough fields that keeping
   *  ONE table is what stops the two directions drifting apart.            */
  var FIELDS = [
    { k: 'speak_style',              post: 'speak_style',              t: 'str' },
    { k: 'profanity_level',          post: 'profanity_level',          t: 'str' },
    { k: 'sex_prompt',               post: 'sex_prompt',               t: 'str' },
    { k: 'kinks',                    post: 'kinks',                    t: 'json' },
    { k: 'secret_kinks',             post: 'secret_kinks',             t: 'json' },
    { k: 'kinks_unlock_tier',        post: 'kinks_unlock_tier',        t: 'int' },
    { k: 'secret_kinks_unlock_tier', post: 'secret_kinks_unlock_tier', t: 'int' },
    { k: 'is_slave',                 post: 'is_slave',                 t: 'bool' },
    { k: 'is_prostitute',            post: 'is_prostitute',            t: 'bool' },
    { k: 'is_slut',                  post: 'is_slut',                  t: 'bool' },
    { k: 'slave_fiction_frame',      post: 'slave_fiction_frame',      t: 'bool' },
    { k: 'spousal_status',           post: 'spousal_status',           t: 'str' },
    { k: 'spouse_names',             post: 'spouse_names',             t: 'str' },
    { k: 'sexual_orientation',       post: 'sexual_orientation',       t: 'str' },
    { k: 'relationship_preference',  post: 'relationship_preference',  t: 'str' },
    { k: 'pricing',                  post: 'pricing',                  t: 'json' },
    { k: 'prostitute_price',         post: 'prostitute_price',         t: 'int' },
    { k: 'slave_speak_styles',       post: 'slave_speak_styles',       t: 'json' },
  ];

  /* Affinity bands, mirrored from config_section_npc_settings.php. The number
     is the LOWER bound CHIM stores for that band. */
  var TIERS = [
    [-100, 'Hostile'], [-90, 'Hateful'], [-75, 'Resentful'], [-55, 'Cold'],
    [-30, 'Wary'], [-5, 'Neutral'], [6, 'Acquaintance'], [31, 'Friendly'],
    [56, 'Fond'], [76, 'Devoted'], [91, 'Bonded'],
  ];
  var PROFANITY = [['1', 'Soft'], ['2', 'Moderate'], ['3', 'Hard'], ['4', 'Extreme']];
  var SPOUSAL = [['single', 'Single'], ['married', 'Married'], ['widowed', 'Widowed']];
  var ORIENT = [
    ['heterosexual', 'Heterosexual'], ['homosexual', 'Homosexual'],
    ['bisexual', 'Bisexual'], ['asexual', 'Asexual'],
  ];
  var PREF = [
    ['monogamous', 'Monogamous'], ['polyamorous', 'Polyamorous'],
    ['uncommitted', 'Uncommitted'], ['not_interested', 'Not interested'],
  ];

  /* CHIM's own default for an NPC it has never been told about is the legacy
     spelling "straight" (handleLoadNpcNsfwSettings), while its generator and
     its web form both write "heterosexual". Matching on the RAW value left
     every unconfigured NPC with no orientation lit at all, which reads as
     "not set" when it is in fact set. Fold the synonyms for the comparison
     ONLY — st.data keeps whatever CHIM actually holds, so an untouched field
     still diffs clean and is never rewritten behind her back. */
  var ORIENT_SYNONYM = { straight: 'heterosexual', gay: 'homosexual', lesbian: 'homosexual' };
  function normOrient(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return ORIENT_SYNONYM[s] || s;
  }

  /* The three role marks. MUTUALLY EXCLUSIVE, exactly as CHIM's own config
     page enforces them (each checkbox unchecks the other two) and as the
     background generator re-derives them: is_slut only survives when neither
     slave nor prostitute is set. Letting the deck set two at once produced a
     profile the server would silently re-interpret. */
  var ROLES = [
    ['is_slave', 'Enslaved', 'Servitude prompt, and her servitude voice below.'],
    ['is_prostitute', 'Sex worker', 'Unlocks her trade: pricing and paid-service talk.'],
    ['is_slut', 'Promiscuous', 'Available from Acquaintance (+6) up, no relationship gate. Never charges.'],
  ];

  /* Her trade. Values verified against config_section_npc_settings.php. */
  var PTYPE = [
    ['streetwalker', 'Streetwalker', 'Works the streets. Quick, straightforward.'],
    ['tavern_worker', 'Tavern worker', 'Entertains patrons where she drinks.'],
    ['courtesan', 'Courtesan', 'Refined, expensive, selective.'],
    ['escort', 'Escort', 'Professional and discreet.'],
    ['temple_prostitute', 'Temple prostitute', 'Sacred rites rather than trade.'],
    ['camp_follower', 'Camp follower', 'Travels with soldiers.'],
  ];
  var PMOTIVE = [
    ['professional', 'Professional', 'Business-like, experienced.'],
    ['survival', 'Survival', 'Desperate; she needs the coin.'],
    ['pleasure', 'Pleasure', 'She enjoys the work.'],
    ['forced', 'Forced', 'Unwilling, controlled by someone else.'],
    ['sacred', 'Sacred', 'Religious observance.'],
  ];
  var PPAY = [
    ['gold', 'Gold / septims'], ['favors', 'Favours / services'],
    ['goods', 'Goods / items'], ['mixed', 'Mixed (flexible)'],
  ];
  /* The four per-NPC prostitution scene prompts, stored INSIDE `pricing`. */
  var PPROMPTS = [
    ['personality_prompt', 'Personality override', 'How she approaches the work. Overrides her profile persona for paid scenes.'],
    ['during_prompt', 'During the service', 'Her behaviour while it is happening.'],
    ['orgasm_prompt', 'Her climax', 'How she reacts when SHE finishes during a paid scene. #NPC_NAME# / #PLAYER_NAME# substitute.'],
    ['after_prompt', 'Afterwards', 'Post-service / pillow talk.'],
  ];
  /* Her servitude voice, stored inside `slave_speak_styles`. Keys are the
     ones background_profile_worker.php writes and nsfw_ostim_handler reads;
     every one of them is "blank = use the global default". */
  var SLAVE_FIELDS = [
    ['speak_style', 'Speak style', 'How she speaks and addresses her owner during a scene.', 'short'],
    ['scene_cues', 'Scene cues', 'How she behaves and what she says while it happens.', 'short'],
    ['slave_climax_positive', 'Climax — eager', 'High affinity. Really into it; cries out for him.', 'short'],
    ['slave_climax_neutral', 'Climax — neutral', 'Goes along with it.', 'short'],
    ['slave_climax_negative', 'Climax — reluctant', 'Low affinity. Dutiful and detached.', 'short'],
    ['owner_climax', 'When HE finishes', 'Her reaction to her owner’s climax.', 'short'],
    ['aftermath', 'Aftermath', 'How she reflects once the scene ends.', 'short'],
  ];

  /* CHIM's own quick-add vocabulary (config_manager.php defaultKinkTags /
     defaultSecretKinkTags). Suggestions only — anything may be typed. */
  var KINK_SUGG = [
    'rough sex', 'doggy style', 'riding', 'oral', 'outdoors', 'public',
    'hair pulling', 'biting', 'spanking', 'dirty talk', 'praise kink',
    'exhibition', 'voyeur', 'gentle', 'passionate', 'roleplay',
  ];
  var SECRET_SUGG = [
    'breeding', 'creampie', 'facials', 'deepthroat', 'choking', 'bondage',
    'degradation', 'humiliation', 'anal', 'titfucking', 'domination',
    'submission', 'rough', 'gangbang', 'cuckolding',
  ];

  /* What an unconfigured NPC looks like — copied from the not-found branch of
     handleLoadNpcNsfwSettings(), so the optimistic form we paint before CHIM
     answers is the same form CHIM would have given us for someone new. */
  function defaults() {
    return {
      speak_style: 'auto', profanity_level: '2',
      kinks: [], secret_kinks: [],
      kinks_unlock_tier: 56, secret_kinks_unlock_tier: 76,
      sex_prompt: '',
      is_slave: false, is_prostitute: false, is_slut: false, slave_fiction_frame: true,
      prostitute_price: 100,
      spousal_status: 'single', spouse_names: '',
      sexual_orientation: 'heterosexual', relationship_preference: 'monogamous',
    };
  }

  var st = {
    open: false,
    name: '',        // the CHIM name (OriginalName || Name)
    label: '',       // what to show in the header
    base: null,      // server truth as last read (optimistic defaults until it lands)
    data: null,      // the local draft
    isNew: false,
    busy: false,     // a COMMIT is in flight
    loading: false,  // the opening read is in flight — the form is already usable
    loaded: false,   // the opening read has landed at least once
    loadErr: '',     // the opening read failed; the form stays usable
    err: '',
    chimDown: false,
    kink: { normal: '', secret: '' },
    /* 'npc' = her profile, 'global' = CHIM-wide config (sharmat-global.js).
       Two very different blast radii, so they are two MODES with their own
       rails and their own commit bars rather than one long page with a Save
       that means different things depending where you scrolled. */
    mode: 'npc',
    /* The rail's filter box. Filters the CARDS, not just the rail: on a
       profile this long "where is her pricing" is a real question, and a
       rail that jumps to a card the body is still hiding is worse than no
       rail. Empty = everything shows. */
    filter: '',
    /* One open searchable picker at a time: { id, q } or null. Held out here
       rather than on the element because render() rebuilds the DOM whole. */
    combo: null,
    /* { file, mtime, hue } handed in by the Followers pane at open — the deck
       already knows the winning portrait, and re-deriving it here would mean a
       second copy of the slug rule (there are three already). Null = initials. */
    face: null,
    /* CHIM's speak-style catalog, fetched once per session alongside the first
       profile. Until it lands the style control is a free-text box; after, it
       is a filter-as-you-type picker. Cached — it is the same list for all. */
    styles: null,
    /* CHIM's LLM connectors (core_llm_connector), for the generator. Same
       once-per-session cache as `styles`, and the same graceful absence: no
       catalog, no Generate button, rather than a button that cannot work. */
    connectors: null,
    connector: '',
    /* The generator WRITES TO THE DATABASE ITSELF (see generate()). Both of
       these are therefore armed-then-fired, never one click. */
    armedGen: false,
    armedDel: false,
    gen: '',            // '' | 'busy' | an error string
    del: '',            // '' | 'busy' | an error string
    /* Spouse-name lookup: { q, busy, hits } against CHIM's own roster search. */
    spouse: { q: '', busy: false, hits: null },
    /* Closing with unsaved edits is armed, not instant — PrismaUI has no
       confirm(), and prose typed into the prompt box is expensive to lose. */
    armedClose: false,
  };

  var el = null;              // the modal root (.sm-pop)
  var pending = {};           // request id -> callback
  var seq = 0;

  /* ---------------------------------------------------------- transport -- */

  /* One request. Resolves through `cb(err, json)`. In the browser test
     harness window.smCall is replaced by a fake, which is why everything
     below goes through this one door. */
  function call(action, query, form, cb) {
    var id = 'sm' + (++seq);
    pending[id] = cb;
    var payload = JSON.stringify({ id: id, action: action, query: query || '', form: form || '' });
    if (typeof window.smCall === 'function') window.smCall(payload);
    else setTimeout(function () { deliver({ id: id, ok: false, error: 'no bridge (smCall missing)' }); }, 0);
  }

  /* Called by C++ (and by the harness). Kept tolerant of a string OR an
     object because PrismaUI has passed both shapes to view callbacks. */
  function deliver(env) {
    if (typeof env === 'string') { try { env = JSON.parse(env); } catch (e) { return; } }
    if (!env || !env.id) return;
    var cb = pending[env.id];
    if (!cb) return;                     // a reply to a request we abandoned
    delete pending[env.id];
    cb(env.ok ? null : (env.error || 'failed'), env.json, env);
  }

  function enc(o) {
    var out = [];
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (o[k] === undefined || o[k] === null) continue;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(o[k])));
    }
    return out.join('&');
  }

  /* ------------------------------------------------------------- model --- */

  function val(k, d) {
    if (!st.data) return d;
    return (st.data[k] === undefined || st.data[k] === null) ? d : st.data[k];
  }
  function set(k, v) { if (st.data) { st.data[k] = v; render(); } }

  /* A field inside one of the two free-form objects (`pricing`,
     `slave_speak_styles`). MERGE, never replace: CHIM's own web page and its
     background generator both write keys this editor does not know about
     (individual_acts, time_bookings, style_addons, group_premiums …), and
     replacing the object would delete every one of them on the next save. */
  function subVal(key, sub, d) {
    var o = val(key, null);
    if (!o || typeof o !== 'object') return d;
    return (o[sub] === undefined || o[sub] === null) ? d : o[sub];
  }
  function subSet(key, sub, v) {
    var cur = val(key, null);
    var o = (cur && typeof cur === 'object' && !Array.isArray(cur))
      ? JSON.parse(JSON.stringify(cur)) : {};
    o[sub] = v;
    set(key, o);
  }

  /* Only what differs from the loaded truth. JSON-compares because several of
     the fields are structures, and === would call every one of them changed
     on every single render. */
  function patch() {
    if (!st.data || !st.base) return {};
    var out = {};
    Object.keys(st.data).forEach(function (k) {
      if (JSON.stringify(st.data[k]) !== JSON.stringify(st.base[k])) out[k] = st.data[k];
    });
    return out;
  }
  function dirty() { return Object.keys(patch()).length > 0; }

  /* Optimistic open: the form is already on screen, filled with an
     unconfigured NPC's defaults, and this fills it in underneath.
     CHIM takes a moment on a good day and is simply DOWN whenever the server
     isn't up, so making the editor wait on it meant staring at a spinner for
     the common case. Nothing here blocks the UI.

     Editing before this lands is SAFE, and that is not an accident: commit()
     re-reads the profile and sends only the DIFF against `base`. A field the
     user never touched has a zero diff, is not posted, and therefore keeps
     whatever CHIM actually holds — the optimistic default can never be
     written over her real value. */
  function load() {
    st.loading = true; st.loadErr = ''; render();
    call('loadNpcNsfwSettings', enc({ npc: st.name }), '', function (err, j, env) {
      st.loading = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the read') : '');
      if (why) {
        st.loadErr = why;
        st.chimDown = !!(env && env.chimDown);
        render();
        if (typeof window.hdToast === 'function') {
          window.hdToast(st.chimDown ? '⚠ CHIM isn’t answering — profile not loaded'
                                     : '⚠ Sharmat: ' + why);
        }
        return;
      }
      st.chimDown = false;

      /* Keep anything typed while the read was in flight. Whatever differs
         from the OLD base is the user's, and it wins; everything else is
         replaced by server truth. Re-seating both sides blindly would throw
         away edits made in the first second the panel was open. */
      var mine = patch();
      st.base = j.data || {};
      st.data = JSON.parse(JSON.stringify(st.base));
      Object.keys(mine).forEach(function (k) { st.data[k] = mine[k]; });

      st.isNew = !!j.is_new;
      st.loaded = true;
      render();
      loadStyles();
      loadConnectors();
    });
  }

  /* ⚠ handleLoadGlobalStyles answers with an ARRAY of
       { name, preview, emoji, file }
     — NOT a map keyed by style name, and NOT a `description` field. This code
     used to do Object.keys(raw).sort() and take the KEY as the name, which on
     an array yields "0", "1", "2" …: the picker listed index numbers instead
     of styles, and the description was always blank. (The harness had faked a
     map, so it passed while the real thing was broken — which is why the fake
     now returns both shapes.) Read against the live plugin 2026-09-20.
     Both shapes are accepted because an older CHIM may still answer the map. */
  function parseStyles(j) {
    var raw = j.styles || j.data || [];
    var out = [];
    function push(name, d) {
      name = String(name || '').trim();
      if (!name) return;
      d = d || {};
      out.push({
        name: name,
        emoji: d.emoji || '',
        // `preview` is the array shape's field; `description` the map's.
        desc: String(d.preview || d.description || '').trim(),
      });
    }
    if (Array.isArray(raw)) raw.forEach(function (d) { push(d && d.name, d); });
    else Object.keys(raw).forEach(function (k) { push((raw[k] && raw[k].name) || k, raw[k]); });
    out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return out;
  }

  /* The speak-style catalog. Fetched AFTER the profile, never alongside it:
     the profile is what the user is waiting for, and CHIM serialises requests,
     so racing the two would make the thing that matters arrive second. Failure
     is silent by design — the control degrades to the free-text box it was,
     which still works because the field is just a style name. */
  function loadStyles() {
    if (st.styles) return;
    call('loadGlobalStyles', '', '', function (err, j) {
      if (err || !j || j.success !== true) return;
      st.styles = parseStyles(j);
      if (!st.styles.length) { st.styles = null; return; }
      if (st.open) render();
    });
  }

  /* CHIM's LLM connector list, for the generator. Same shape of cache as the
     style catalog, fetched beside it, and silent on failure: no list means no
     Generate button, which is better than a button that cannot work. */
  function loadConnectors() {
    if (st.connectors) return;
    call('loadConnectors', '', '', function (err, j) {
      if (err || !j || j.success !== true) return;
      var rows = (j.data || []).filter(function (r) { return r && r.label; });
      if (!rows.length) return;
      st.connectors = rows.map(function (r) { return { id: r.id, label: String(r.label) }; });
      /* Default to a Grok connector when there is one — that is what CHIM's
         own page pre-selects, and matching it means the deck's Generate and
         the web page's Generate produce comparable output. */
      var grok = st.connectors.filter(function (c) { return c.label.toLowerCase().indexOf('grok') >= 0; })[0];
      st.connector = (grok || st.connectors[0]).label;
      if (st.open) render();
    });
  }

  /* ⛔ THE GENERATOR WRITES TO CHIM'S DATABASE ITSELF. ⛔
     handleGenerateSexPrompt() does not hand back a draft for approval: it
     overwrites sex_prompt, the speak style, the profanity level, BOTH kink
     lists, the role flags and every relationship field on her record, stamps
     nsfw_source='ai', and only then answers. So:
       · it is ARMED, never one click;
       · it is refused while the draft is dirty — those edits would be
         written over by the server before we could post them;
       · and on success we RE-READ rather than merging the reply, because the
         reply is a subset of what the server actually stored.
     It can take the better part of a minute (it is a real LLM round trip
     behind CHIM's request semaphore), which is what the busy state is for. */
  function generate() {
    if (!st.name || st.gen === 'busy' || dirty()) return;
    if (!st.connector) return;
    st.armedGen = false; st.gen = 'busy'; st.err = ''; render();
    call('generateSexPrompt', '', enc({ npc: st.name, connector: st.connector }), function (err, j) {
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused to generate') : '');
      if (why) { st.gen = why; render(); return; }
      st.gen = '';
      if (typeof window.hdToast === 'function') window.hdToast('✓ CHIM wrote her profile — reloading');
      load();      // the server already saved; read back what it actually stored
    });
  }

  /* Clears the profile CHIM stores for her. Deliberately describes what the
     handler ACTUALLY does — it unsets the prompt, the style, the profanity
     level, both kink lists, is_prostitute/is_slut, the price, the source and
     the cached race/gender, and LEAVES the unlock tiers, is_slave, the
     servitude voice, the pricing table and every relationship field in place.
     Calling that "delete the profile" would be a lie the next session pays
     for. */
  function destroy() {
    if (!st.name || st.del === 'busy') return;
    st.armedDel = false; st.del = 'busy'; render();
    call('deleteNpcNsfwSettings', '', enc({ npc: st.name }), function (err, j) {
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the delete') : '');
      if (why) { st.del = why; render(); return; }
      st.del = '';
      if (typeof window.hdToast === 'function') window.hdToast('✓ Cleared her stored profile');
      load();
    });
  }

  /* Spouse names are free text in CHIM, but they only MEAN anything when they
     match a name it knows — so the field gets its own lookup against CHIM's
     own roster search (the same endpoint its web page's autocomplete uses),
     and the player is flagged, because "married to the player" is the case
     that actually comes up. */
  function searchSpouse(q) {
    q = String(q || '').trim();
    st.spouse.q = q;
    if (q.length < 2) { st.spouse.hits = null; st.spouse.busy = false; render(); return; }
    st.spouse.busy = true; render();
    call('searchNpcsForSpouse', enc({ q: q, limit: 12 }), '', function (err, j) {
      // A stale reply for a query the user has since changed is dropped: CHIM
      // serialises requests, so out-of-order answers are normal here.
      if (st.spouse.q !== q) return;
      st.spouse.busy = false;
      if (err || !j || j.success !== true) { st.spouse.hits = []; render(); return; }
      st.spouse.hits = (j.data || j.results || []).map(function (r) {
        return { name: String(r.name || ''), player: !!r.is_player };
      }).filter(function (r) { return r.name; });
      render();
    });
  }
  function addSpouse(name) {
    var cur = String(val('spouse_names', '') || '');
    var list = cur.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!list.some(function (s) { return s.toLowerCase() === name.toLowerCase(); })) list.push(name);
    st.spouse = { q: '', busy: false, hits: null };
    set('spouse_names', list.join(', '));
  }

  /* Read-modify-write — see the banner at the top of this file. Two round
     trips on purpose: re-read (so a change made on the phone or by CHIM's own
     generator since we opened is not clobbered), merge our edits over it,
     post the WHOLE set. */
  function commit() {
    if (!st.data || st.busy || !dirty()) return;
    var mine = patch();
    st.busy = true; st.err = ''; render();

    call('loadNpcNsfwSettings', enc({ npc: st.name }), '', function (err, j, env) {
      if (err || !j || j.success !== true) {
        st.busy = false;
        st.err = err || (j && j.error) || 'could not re-read before saving';
        st.chimDown = !!(env && env.chimDown);
        render();
        return;
      }
      var merged = j.data || {};
      Object.keys(mine).forEach(function (k) { merged[k] = mine[k]; });

      var form = { npc: st.name, source: 'manual' };
      FIELDS.forEach(function (f) {
        var v = merged[f.k];
        if (v === undefined || v === null) return;
        if (f.t === 'json') form[f.post] = JSON.stringify(v);
        else if (f.t === 'bool') form[f.post] = v ? 'true' : 'false';
        else if (f.t === 'int') form[f.post] = String(Math.trunc(Number(v) || 0));
        else form[f.post] = String(v);
      });
      // Both are conditional on their flag server-side and are unset() when it
      // is off — only send them where they can survive, and never resurrect a
      // stale pricing table onto someone no longer flagged.
      if (!merged.is_prostitute) { delete form.pricing; delete form.prostitute_price; }
      if (!merged.is_slave) { delete form.slave_speak_styles; }

      call('saveNpcNsfwSettings', '', enc(form), function (err2, j2) {
        if (err2 || !j2 || j2.success !== true) {
          st.busy = false;
          st.err = err2 || (j2 && j2.error) || 'CHIM refused the write';
          render();
          return;
        }
        /* Re-READ rather than re-seating on `merged`. What we posted and what
           CHIM now holds are NOT the same object, and assuming they were left
           the panel lying about two things:
             · `source`, which the server rewrites to "manual" on every save
               (so the badge kept saying "AI generated" after a hand edit); and
             · pricing / slave_speak_styles, which the server unset()s when
               their flag is off — `merged` still carried them, so the next
               dirty-diff compared against fields that no longer exist.
           One extra round trip; the panel now shows what is actually stored. */
        call('loadNpcNsfwSettings', enc({ npc: st.name }), '', function (err3, j3) {
          st.busy = false;
          if (err3 || !j3 || j3.success !== true) {
            // The write LANDED; only the confirming read failed. Say so
            // precisely — "save failed" here would be a lie that invites a
            // second write.
            st.err = 'Saved, but could not re-read the profile: ' + (err3 || (j3 && j3.error) || 'unknown');
            st.base = merged;
            st.data = JSON.parse(JSON.stringify(merged));
            render();
            return;
          }
          st.base = j3.data || {};
          st.data = JSON.parse(JSON.stringify(st.base));
          st.isNew = false;
          render();
          if (typeof window.hdToast === 'function') window.hdToast('✓ Saved to CHIM — live from her next line');
        });
      });
    });
  }

  function addKink(which, text) {
    var key = which === 'secret' ? 'secret_kinks' : 'kinks';
    var raw = String(text === undefined ? (st.kink[which] || '') : text).trim();
    if (!raw) return;
    var list = (val(key, []) || []).slice();
    raw.split(',').forEach(function (part) {
      var v = part.trim();
      if (!v) return;
      var dup = list.some(function (x) { return String(x).trim().toLowerCase() === v.toLowerCase(); });
      if (!dup) list.push(v);
    });
    st.kink[which] = '';
    set(key, list);
  }
  function delKink(which, i) {
    var key = which === 'secret' ? 'secret_kinks' : 'kinks';
    var list = (val(key, []) || []).slice();
    list.splice(i, 1);
    set(key, list);
  }

  /* Exactly one role at a time — see ROLES. Turning one ON turns the other
     two off in the SAME draft edit, so what the panel shows is what the
     server would have derived anyway.

     ⚠ Turning one OFF clears only ITSELF. The symmetric version (set all
     three false) reads tidier and is wrong: unticking "sex worker" on a
     record that also carried is_slave would silently un-enslave her, and
     commit() would then drop her whole servitude voice — a destructive edit
     nobody asked for, from a switch that named one thing. */
  function setRole(key, on) {
    if (!st.data) return;
    if (on) ROLES.forEach(function (r) { st.data[r[0]] = (r[0] === key); });
    else st.data[key] = false;
    render();
  }

  /* --------------------------------------------------------------- DOM --- */

  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      (Array.isArray(kid) ? kid : [kid]).forEach(function (c) {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  function seg(opts, cur, onPick) {
    return h('div', { class: 'sm-seg' }, opts.map(function (o) {
      return h('button', {
        class: 'sm-seg-b' + (String(o[0]) === String(cur) ? ' on' : ''),
        type: 'button',
        'aria-pressed': String(o[0]) === String(cur) ? 'true' : 'false',
        onClick: function (e) { e.stopPropagation(); onPick(o[0]); },
      }, o[1]);
    }));
  }

  function field(label, control, hint) {
    return h('div', { class: 'sm-field' },
      h('label', null, label), control,
      hint ? h('div', { class: 'sm-hint' }, hint) : null);
  }

  /* A plain text / number / textarea control bound to a getter+setter, so the
     same helper serves top-level fields and the two nested objects. */
  function textCtl(opts) {
    var inp = h(opts.area ? 'textarea' : 'input', {
      class: 'sm-in' + (opts.area ? ' area' + (opts.size ? ' ' + opts.size : '') : ''),
      type: opts.area ? null : (opts.num ? 'number' : 'text'),
      min: opts.num ? '0' : null,
      spellcheck: 'false',
      placeholder: opts.hint || '',
      onClick: function (e) { e.stopPropagation(); },
      // `change` (not `input`): it fires on blur, so the repaint that follows
      // can never eat a caret mid-word. Same rule the member menu uses.
      onChange: function (e) {
        opts.set(opts.num ? Math.trunc(Number(e.target.value) || 0) : e.target.value);
      },
      onKeydown: function (e) { if (e.key === 'Enter' && !opts.area) { e.preventDefault(); e.target.blur(); } },
    });
    inp.value = String(opts.get());
    return inp;
  }
  function textRow(label, key, opts) {
    opts = opts || {};
    return field(label, textCtl({
      area: opts.area, size: opts.size, num: opts.num, hint: opts.hint,
      get: function () { return val(key, opts.num ? 0 : ''); },
      set: function (v) { set(key, v); },
    }), opts.note);
  }
  function subRow(key, sub, label, note, opts) {
    opts = opts || {};
    return field(label, textCtl({
      area: opts.area !== false, size: opts.size || 'short', hint: opts.hint || 'Blank = CHIM’s global default',
      get: function () { return subVal(key, sub, ''); },
      set: function (v) { subSet(key, sub, v); },
    }), note);
  }

  /* A collapsible block. Law from 2026-09-14: anything that expands too far
     folds behind a chevron. ‹ › ⌄ are the glyphs proven to render in-game —
     ◂ ▸ came out as specks. */
  function fold(title, kids, openNow) {
    var body = h('div', { class: 'sm-fold-body' }, kids);
    body.hidden = !openNow;
    var btn = h('button', {
      class: 'sm-fold' + (openNow ? ' open' : ''), type: 'button',
      'aria-expanded': openNow ? 'true' : 'false',
      onClick: function (e) {
        e.stopPropagation();
        body.hidden = !body.hidden;
        btn.classList.toggle('open', !body.hidden);
        btn.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
        btn.querySelector('.chev').textContent = body.hidden ? '\u203A' : '\u2304';
      },
    }, h('span', { class: 'chev' }, openNow ? '\u2304' : '\u203A'),
       h('span', { class: 'sm-card-title' }, title));
    return h('div', { class: 'sm-foldwrap' }, btn, body);
  }

  /* ---- the searchable picker ------------------------------------------- *
   *  Rober's standing rule: any list that can be filtered gets
   *  filter-as-you-type, with Enter taking the top hit. CHIM ships a
   *  catalog of speak styles that grows every time he writes one, so the
   *  <select> this used to be was a defect at that length.
   *
   *  ⚠ It deliberately does NOT call render() while you type. The pane
   *  repaints wholesale on every model change, and a repaint between
   *  keystrokes destroys the input the caret is in — the same trap the
   *  kink add box documents. So typing rebuilds ONLY this dropdown; only
   *  PICKING touches the model.                                            */
  function combo(id, cfg) {
    var wrap = h('div', { class: 'sm-combo' });
    var pop = h('div', { class: 'sm-combo-pop' });
    pop.hidden = true;

    var inp = h('input', {
      class: 'sm-in', type: 'text', spellcheck: 'false',
      placeholder: cfg.placeholder || 'Type to filter…',
      role: 'combobox', 'aria-expanded': 'false',
      onClick: function (e) { e.stopPropagation(); },
    });
    inp.value = cfg.text || '';

    function matches() {
      var q = String(st.combo && st.combo.id === id ? st.combo.q : '').trim().toLowerCase();
      if (!q) return cfg.options.slice();
      return cfg.options.filter(function (o) {
        return (o.label + ' ' + (o.desc || '') + ' ' + o.v).toLowerCase().indexOf(q) >= 0;
      });
    }
    function paint() {
      pop.innerHTML = '';
      var list = matches();
      if (!list.length) {
        pop.append(h('div', { class: 'sm-combo-none' },
          cfg.freeText ? 'No match — press Enter to use what you typed.' : 'Nothing matches.'));
        return;
      }
      list.forEach(function (o, i) {
        var b = h('button', {
          class: 'sm-opt' + (i === 0 ? ' top' : '') + (String(o.v) === String(cfg.value) ? ' on' : ''),
          type: 'button',
          // mousedown, not click: the input's blur would close the popup out
          // from under the press and the click would never land.
          onMousedown: function (e) { e.preventDefault(); e.stopPropagation(); pick(o.v); },
        }, h('span', { class: 'n' }, o.label), o.desc ? h('span', { class: 'd' }, o.desc) : null);
        pop.append(b);
      });
    }
    function openPop() {
      st.combo = { id: id, q: '' };
      pop.hidden = false; inp.setAttribute('aria-expanded', 'true');
      paint();
    }
    function closePop() {
      if (st.combo && st.combo.id === id) st.combo = null;
      pop.hidden = true; inp.setAttribute('aria-expanded', 'false');
    }
    function pick(v) { closePop(); cfg.onPick(v); }

    inp.addEventListener('focus', function () { openPop(); inp.select(); });
    inp.addEventListener('input', function (e) {
      if (!st.combo || st.combo.id !== id) st.combo = { id: id, q: '' };
      st.combo.q = e.target.value;
      pop.hidden = false;
      paint();
    });
    inp.addEventListener('blur', function () {
      // Late enough for an option's mousedown to have fired, short enough
      // that the popup never outlives the field visually.
      setTimeout(function () {
        if (!el || !el.contains(inp)) return;
        closePop();
        inp.value = cfg.text || '';        // abandon a half-typed filter
      }, 120);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var list = matches();
        if (list.length) pick(list[0].v);
        else if (cfg.freeText) pick(inp.value.trim());
        inp.blur();
      } else if (e.key === 'Escape') {
        // Consumed here so Escape closes the PICKER, not the whole modal.
        e.preventDefault(); e.stopPropagation();
        closePop(); inp.value = cfg.text || ''; inp.blur();
      }
    });

    wrap.append(inp, pop);
    if (st.combo && st.combo.id === id) {
      // survive the repaint that a sibling control's change triggered
      pop.hidden = false;
      inp.value = st.combo.q;
      paint();
    }
    return wrap;
  }

  /* Fallback for "no portrait" and for a portrait that refused to load —
     the same initials medallion the roster row falls back to. */
  function initialsFace() {
    var parts = String(st.label || '?').trim().split(/\s+/).filter(Boolean);
    var a = parts.length ? ([].concat(Array.from(parts[0]))[0] || '?') : '?';
    var b = parts.length > 1 ? ([].concat(Array.from(parts[parts.length - 1]))[0] || '') : '';
    var e = h('span', { class: 'sm-face initials' }, (a + b).toUpperCase());
    if (st.face && st.face.hue != null) e.style.setProperty('--sm-hue', String(st.face.hue));
    return e;
  }

  function kinkBlock(which) {
    var key = which === 'secret' ? 'secret_kinks' : 'kinks';
    var list = val(key, []) || [];
    var wrap = h('div');

    if (list.length) {
      wrap.append(h('div', { class: 'sm-kinks' }, list.map(function (k, i) {
        return h('span', { class: 'sm-kink' + (which === 'secret' ? ' secret' : '') },
          h('span', { class: 'lbl' }, String(k)),
          h('button', {
            class: 'x', type: 'button', title: 'Remove ' + String(k),
            'aria-label': 'Remove ' + String(k),
            onClick: function (e) { e.stopPropagation(); delKink(which, i); },
          }, '✕'));
      })));
    } else {
      wrap.append(h('div', { class: 'sm-empty' }, 'None yet.'));
    }

    /* The add box deliberately does NOT repaint as you type — the Add button
       and the suggestion rail are its neighbours, and a re-render on blur
       would destroy them between mousedown and click. Track the text, commit
       on Add or Enter, and refresh only the suggestions. */
    var sugg = h('div', { class: 'sm-sugg' });
    function paintSugg() {
      sugg.innerHTML = '';
      var have = (val(key, []) || []).map(function (x) { return String(x).trim().toLowerCase(); });
      var q = String(st.kink[which] || '').trim().toLowerCase();
      var pool = (which === 'secret' ? SECRET_SUGG : KINK_SUGG).filter(function (s) {
        return have.indexOf(s) < 0 && (!q || s.indexOf(q) >= 0);
      });
      if (!pool.length) return;
      pool.slice(0, 14).forEach(function (s) {
        sugg.append(h('button', {
          class: 'sm-sugg-b', type: 'button', title: 'Add “' + s + '”',
          onClick: function (e) { e.stopPropagation(); addKink(which, s); },
        }, '+ ' + s));
      });
    }

    var box = h('input', {
      class: 'sm-in', type: 'text', spellcheck: 'false',
      placeholder: 'Add one, or several separated by commas…',
      onClick: function (e) { e.stopPropagation(); },
      onInput: function (e) { st.kink[which] = e.target.value; paintSugg(); },
      onKeydown: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); st.kink[which] = e.target.value; addKink(which); }
      },
    });
    box.value = st.kink[which] || '';
    wrap.append(h('div', { class: 'sm-add' }, box,
      h('button', {
        class: 'sm-btn', type: 'button',
        onClick: function (e) { e.stopPropagation(); addKink(which); },
      }, 'Add')));
    paintSugg();
    wrap.append(sugg);

    var tierKey = which === 'secret' ? 'secret_kinks_unlock_tier' : 'kinks_unlock_tier';
    var cur = Number(val(tierKey, which === 'secret' ? 76 : 56));
    var curTier = TIERS.filter(function (t) { return t[0] === cur; })[0];
    wrap.append(h('div', { style: 'margin-top:14px' }, field('Revealed at',
      combo('tier-' + which, {
        value: String(cur),
        text: curTier ? tierLabel(curTier) : String(cur),
        placeholder: 'Affinity band…',
        options: TIERS.map(function (t) {
          return { v: String(t[0]), label: tierLabel(t), desc: '' };
        }),
        onPick: function (v) { set(tierKey, Math.trunc(Number(v) || 0)); },
      }),
      which === 'secret'
        ? 'She keeps these back until her affinity toward him reaches this band.'
        : 'Below this band she will not bring these up at all.')));
    return wrap;
  }
  function tierLabel(t) { return t[1] + ' (' + (t[0] > 0 ? '+' : '') + t[0] + ')'; }

  /* ------------------------------------------------------------ render --- */

  /* Every group of the profile, in one table — the rail, the cards and the
     filter all read from HERE, so a group added tomorrow appears in all
     three by adding a line. `keys` is what marks the rail entry "edited";
     `terms` is the extra vocabulary the filter should match on beyond the
     title (nobody searches for "In-scene persona", they search "prompt"). */
  /* ⚠ The ORDER is load-bearing, not editorial taste. The grid is two columns
     wide and the three `wide` cards span both, so a wide card sitting at an
     odd position ends its row early and leaves a hole beside it. Laid out as
     below — wide, then a PAIR, then wide, wide, then pairs — every row fills
     at two columns AND at one, including when the two conditional cards are
     absent. Insert a new section as a PAIR or as a `wide`, never singly. */
  var SECTIONS = [
    { id: 'persona', title: 'In-scene persona', note: 'her own words for what she is like',
      keys: ['sex_prompt'], wide: true,
      terms: 'prompt behaviour behavior personality intimacy description generate ai write connector model llm grok' },
    { id: 'voice', title: 'Voice', note: 'how she sounds',
      keys: ['speak_style', 'profanity_level'],
      terms: 'speak style tone profanity language swearing catalog' },
    { id: 'role', title: 'Role', note: 'pick at most one',
      keys: ['is_slave', 'is_prostitute', 'is_slut'],
      terms: 'slave enslaved prostitute sex worker whore promiscuous slut status flags' },
    { id: 'work', title: 'Her trade', note: 'sex workers only',
      keys: ['pricing', 'prostitute_price'], when: function () { return !!val('is_prostitute', false); },
      wide: true, terms: 'price pricing gold septims payment courtesan escort motivation scene prompts' },
    { id: 'servitude', title: 'Servitude voice', note: 'enslaved only',
      keys: ['slave_speak_styles'], when: function () { return !!val('is_slave', false); },
      wide: true, terms: 'slave master owner climax aftermath cues speak style' },
    { id: 'kinks', title: 'Kinks', note: 'what she will ask for',
      keys: ['kinks', 'kinks_unlock_tier'], terms: 'likes wants tags unlock affinity' },
    { id: 'secret', title: 'Secret kinks', note: 'only for someone she trusts',
      keys: ['secret_kinks', 'secret_kinks_unlock_tier'], terms: 'hidden dark desires unlock affinity' },
    { id: 'relationship', title: 'Relationship', note: null,
      keys: ['spousal_status', 'spouse_names', 'sexual_orientation', 'relationship_preference'],
      terms: 'married spouse wife husband widow orientation monogamous polyamorous search lookup' },
    { id: 'advanced', title: 'Advanced', note: 'rarely touched',
      keys: ['slave_fiction_frame'], terms: 'fiction frame legacy raw source race delete clear wipe remove reset profile' },
  ];

  function sectionDirty(sec) {
    var p = patch();
    return sec.keys.some(function (k) { return Object.prototype.hasOwnProperty.call(p, k); });
  }
  function sectionMatches(sec) {
    var q = String(st.filter || '').trim().toLowerCase();
    if (!q) return true;
    return (sec.title + ' ' + (sec.note || '') + ' ' + (sec.terms || '')).toLowerCase().indexOf(q) >= 0;
  }

  function buildSection(sec) {
    var body = h('div');

    if (sec.id === 'voice') {
      /* A filter-as-you-type picker once CHIM's catalog has landed, a plain
         text box until then. The stored value is just a style NAME either
         way, so a style set before the catalog arrived stays valid — and a
         name the catalog doesn't know (hand-set, or from a newer CHIM) keeps
         its own entry rather than being silently reset to the first in the
         list. */
      var cur = String(val('speak_style', 'auto'));
      if (st.styles && st.styles.length) {
        var opts = [{ v: 'auto', label: 'Auto', desc: 'Let CHIM choose from her profile.' }];
        var known = cur === 'auto';
        st.styles.forEach(function (s) {
          if (s.name === cur) known = true;
          opts.push({ v: s.name, label: s.name, desc: s.desc || '' });
        });
        if (!known) opts.splice(1, 0, { v: cur, label: cur, desc: 'Not in CHIM’s list — kept as typed.' });
        var curOpt = opts.filter(function (o) { return o.v === cur; })[0];
        body.append(field('Speak style',
          combo('style', {
            value: cur, text: curOpt ? curOpt.label : cur, freeText: true,
            placeholder: 'Type to filter CHIM’s styles…',
            options: opts,
            onPick: function (v) { set('speak_style', v || 'auto'); },
          }),
          st.styles.length + ' styles in CHIM’s catalog. Type a name it does not have and it is kept as typed.'));
      } else {
        body.append(textRow('Speak style', 'speak_style', {
          hint: 'auto',
          note: 'CHIM’s style catalog has not answered yet — this is the raw style name.',
        }));
      }
      body.append(field('Profanity',
        seg(PROFANITY, val('profanity_level', '2'), function (v) { set('profanity_level', v); })));

    } else if (sec.id === 'persona') {
      body.append(field('Prompt', textCtl({
        area: true, size: 'tall',
        hint: 'How she behaves during intimacy — written as if describing her to someone who has to play her…',
        get: function () { return val('sex_prompt', ''); },
        set: function (v) { set('sex_prompt', v); },
      }), 'This is the one field CHIM’s own generator writes for her. Rewriting it here marks the profile hand-written.'));

      /* The generator. Armed, because it OVERWRITES her record server-side —
         see generate(). Drawn only when CHIM has told us which connectors
         exist; a Generate button with nothing to generate through is worse
         than no button. */
      if (st.connectors && st.connectors.length) {
        var blocked = dirty();
        var genRow = h('div', { class: 'sm-gen' },
          h('div', { class: 'sm-gen-pick' },
            combo('conn', {
              value: st.connector, text: st.connector,
              placeholder: 'Which model…',
              options: st.connectors.map(function (c) { return { v: c.label, label: c.label, desc: '' }; }),
              onPick: function (v) { st.connector = v; render(); },
            })),
          h('button', {
            class: 'sm-btn' + (st.armedGen ? ' danger' : ''), type: 'button',
            disabled: (blocked || st.gen === 'busy') ? true : null,
            onClick: function (e) {
              e.stopPropagation();
              if (!st.armedGen) {
                st.armedGen = true; render();
                setTimeout(function () { if (st.armedGen) { st.armedGen = false; render(); } }, 4000);
                return;
              }
              generate();
            },
          }, st.gen === 'busy' ? 'Writing her profile…'
             : st.armedGen ? 'Overwrite her profile — sure?'
             : 'Write it with AI'));
        body.append(h('div', { class: 'sm-field' }, h('label', null, 'CHIM’s generator'), genRow,
          h('div', { class: 'sm-hint' },
            blocked
              ? 'Save or discard your edits first — the generator writes straight to CHIM, so anything unsaved here would be written over before it could be sent.'
              : 'Writes the WHOLE profile from her bio: this prompt, her style, her profanity level, both kink lists, her role and her relationship fields. It saves to CHIM itself — there is no draft to approve — and can take the better part of a minute.')));
        if (st.gen && st.gen !== 'busy') {
          body.append(h('div', { class: 'sm-note bad', style: 'margin-top:10px' }, 'Generate failed. ' + st.gen));
        }
      }

    } else if (sec.id === 'kinks') {
      body.append(kinkBlock('normal'));
    } else if (sec.id === 'secret') {
      body.append(kinkBlock('secret'));

    } else if (sec.id === 'role') {
      ROLES.forEach(function (r) {
        var on = !!val(r[0], false);
        body.append(h('div', { class: 'sm-flag' },
          h('div', { class: 'b' }, h('div', { class: 't' }, r[1]), h('div', { class: 's' }, r[2])),
          h('button', {
            class: 'sm-sw' + (on ? ' on' : ''), type: 'button', role: 'switch',
            'aria-checked': on ? 'true' : 'false', 'aria-label': r[1],
            onClick: function (e) { e.stopPropagation(); setRole(r[0], !on); },
          })));
      });
      body.append(h('div', { class: 'sm-hint', style: 'margin-top:12px' },
        'CHIM treats these three as exclusive — its own page unchecks the others, and its generator drops "promiscuous" on anyone already enslaved or working. Turning one on here turns the other two off, so what you see is what the server would have derived anyway. All three off is a perfectly ordinary NPC.'));

    } else if (sec.id === 'work') {
      var typeCur = String(subVal('pricing', 'prostitute_type', 'streetwalker'));
      var motCur = String(subVal('pricing', 'motivation', 'professional'));
      body.append(h('div', { class: 'sm-pair' },
        field('Type', combo('ptype', {
          value: typeCur,
          text: (PTYPE.filter(function (o) { return o[0] === typeCur; })[0] || [typeCur, typeCur])[1],
          options: PTYPE.map(function (o) { return { v: o[0], label: o[1], desc: o[2] }; }),
          onPick: function (v) { subSet('pricing', 'prostitute_type', v); },
        })),
        field('Motivation', combo('pmot', {
          value: motCur,
          text: (PMOTIVE.filter(function (o) { return o[0] === motCur; })[0] || [motCur, motCur])[1],
          options: PMOTIVE.map(function (o) { return { v: o[0], label: o[1], desc: o[2] }; }),
          onPick: function (v) { subSet('pricing', 'motivation', v); },
        }))));
      body.append(h('div', { class: 'sm-pair' },
        field('Payment taken in',
          seg(PPAY, subVal('pricing', 'payment_type', 'gold'),
            function (v) { subSet('pricing', 'payment_type', v); })),
        textRow('Session price', 'prostitute_price', {
          num: true, note: 'One flat price for the whole scene, agreed up front and fixed start to finish.',
        })));
      PPROMPTS.forEach(function (p) {
        body.append(subRow('pricing', p[0], p[1], p[2], { size: 'short', hint: 'Blank = her ordinary persona' }));
      });
      body.append(h('div', { class: 'sm-hint', style: 'margin-top:4px' },
        'CHIM also keeps per-act, per-hour and group price tables inside this record. Its web page moved those to global templates per prostitute type, so they are not edited here — but they are carried through a save untouched.'));

    } else if (sec.id === 'servitude') {
      SLAVE_FIELDS.forEach(function (f) {
        body.append(subRow('slave_speak_styles', f[0], f[1], f[2], { size: f[3] }));
      });
      body.append(h('div', { class: 'sm-hint', style: 'margin-top:4px' },
        'Every line here is optional. Left blank she uses the global slave prompts from CHIM’s Prompts tab; the three climax tiers are picked by her affinity toward her owner, not chosen by hand.'));

    } else if (sec.id === 'relationship') {
      body.append(field('Spousal status',
        seg(SPOUSAL, val('spousal_status', 'single'), function (v) { set('spousal_status', v); })));
      body.append(textRow('Spouse(s)', 'spouse_names', {
        hint: 'comma-separated', note: 'Names as CHIM knows them — the player counts, and so do other NPCs.',
      }));
      /* A name only MEANS anything to CHIM when it matches one it holds, so
         the field gets the same roster lookup its own web page uses. Its own
         box, not a rewrite of the field: the stored value is a comma-separated
         list and typing into it directly has to stay possible. */
      var spBox = h('input', {
        class: 'sm-in', type: 'text', spellcheck: 'false',
        placeholder: 'Look a name up in CHIM…',
        onClick: function (e) { e.stopPropagation(); },
        onInput: function (e) {
          var q = e.target.value;
          st.spouse.q = q;
          clearTimeout(spBox._t);
          // Debounced: CHIM serialises every request behind one semaphore, so
          // a query per keystroke would queue behind itself and answer late.
          spBox._t = setTimeout(function () { searchSpouse(q); }, 320);
        },
        onKeydown: function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var first = (st.spouse.hits || [])[0];
            if (first) addSpouse(first.name);
          }
        },
      });
      spBox.value = st.spouse.q || '';
      var spWrap = h('div', { class: 'sm-field' }, spBox);
      if (st.spouse.busy) {
        spWrap.append(h('div', { class: 'sm-hint' }, 'Asking CHIM…'));
      } else if (st.spouse.hits) {
        if (!st.spouse.hits.length) {
          spWrap.append(h('div', { class: 'sm-hint' }, 'CHIM knows nobody by that name — you can still type it into the field above.'));
        } else {
          spWrap.append(h('div', { class: 'sm-sugg' }, st.spouse.hits.map(function (r) {
            return h('button', {
              class: 'sm-sugg-b' + (r.player ? ' you' : ''), type: 'button',
              onClick: function (e) { e.stopPropagation(); addSpouse(r.name); },
            }, '+ ' + r.name + (r.player ? ' (you)' : ''));
          })));
        }
      }
      body.append(spWrap);
      body.append(field('Orientation',
        seg(ORIENT, normOrient(val('sexual_orientation', 'heterosexual')),
          function (v) { set('sexual_orientation', v); })));
      body.append(field('Preference',
        seg(PREF, val('relationship_preference', 'monogamous'),
          function (v) { set('relationship_preference', v); })));

    } else if (sec.id === 'advanced') {
      var ff = !!val('slave_fiction_frame', true);
      body.append(h('div', { class: 'sm-flag' },
        h('div', { class: 'b' },
          h('div', { class: 't' }, 'Fiction frame (legacy, per-NPC)'),
          h('div', { class: 's' }, 'CHIM moved this to a single GLOBAL toggle on its Prompts tab, and its own page stopped posting the per-NPC copy. Nothing reads this value any more; it is shown because it is still stored, and still saved, on her record.')),
        h('button', {
          class: 'sm-sw' + (ff ? ' on' : ''), type: 'button', role: 'switch',
          'aria-checked': ff ? 'true' : 'false', 'aria-label': 'Fiction frame',
          onClick: function (e) { e.stopPropagation(); set('slave_fiction_frame', !ff); },
        })));
      var src = val('source', ''), race = val('race', '');
      body.append(h('div', { class: 'sm-field', style: 'margin-top:14px' },
        h('label', null, 'Read-only, from CHIM'),
        h('div', { class: 'sm-hint' },
          'Written by: ' + (src === 'ai' ? 'CHIM’s generator' : src === 'manual' ? 'a person, by hand'
            : src ? src : 'not recorded') +
          ' · Race: ' + (race || 'not recorded') +
          '. Saving from here always stamps the profile hand-written.')));

      /* Clear. Armed, and described by what the handler ACTUALLY unsets —
         which is NOT everything. Saying "delete her profile" when four groups
         of fields survive is the kind of half-truth the next session pays
         for, so the list is spelled out. */
      body.append(h('div', { class: 'sm-field', style: 'margin-top:18px' },
        h('label', null, 'Clear her stored profile'),
        h('button', {
          class: 'sm-btn' + (st.armedDel ? ' danger' : ''), type: 'button',
          disabled: st.del === 'busy' ? true : null,
          onClick: function (e) {
            e.stopPropagation();
            if (!st.armedDel) {
              st.armedDel = true; render();
              setTimeout(function () { if (st.armedDel) { st.armedDel = false; render(); } }, 4000);
              return;
            }
            destroy();
          },
        }, st.del === 'busy' ? 'Clearing…' : st.armedDel ? 'Clear it — sure?' : 'Clear profile'),
        h('div', { class: 'sm-hint' },
          'CHIM’s own delete unsets the prompt, the speak style, the profanity level, both kink lists, ' +
          'sex-worker/promiscuous, the session price, the source stamp and the cached race. It LEAVES ' +
          'the unlock tiers, enslaved, her servitude voice, the pricing table and every relationship ' +
          'field exactly where they are — so this is a clear, not a delete, and the row stays.')));
      if (st.del && st.del !== 'busy') {
        body.append(h('div', { class: 'sm-note bad' }, 'Clear failed. ' + st.del));
      }
    }

    return body;
  }

  function profileFace() {
    var fp = window.FolPane;
    var face = fp && fp.portraitInfoFor ? fp.portraitInfoFor({original: st.name, name: st.label}) : null;
    face = face || st.face;
    var plain = face ? (face.abs ? face.file : 'portraits/' + face.file) : '';
    var faceEl;
    if (face && face.file) {
      var faceImg = h('img', { src: plain + (face.abs ? '' : '?v=' + (face.mtime || 0)), alt: '', draggable: 'false' });
      faceEl = h('span', { class: 'sm-face' }, faceImg);
      /* the user's saved framing — one shared lane, or this centre-crops (2026-08-19) */
      if (window.HDFaceFit) HDFaceFit.paintPortrait(faceImg, plain);
      /* The listener STAYS attached across the retry. Detaching it on the
         first error (as this did) meant the retry's own failure was never
         heard, so a genuinely missing file left an empty styled circle
         instead of falling back to initials. The `retried` flag — not
         listener removal — is what makes this fire at most twice. */
      faceImg.addEventListener('error', function () {
        if (faceImg.dataset.retried) { faceEl.replaceWith(initialsFace()); return; }
        faceImg.dataset.retried = '1';
        faceImg.src = plain;   // plain, no ?v= query
      });
    } else {
      faceEl = initialsFace();
    }
    if (st.face && st.face.hue != null) faceEl.style.setProperty('--sm-hue', String(st.face.hue));
    return faceEl;
  }

  if (window.addEventListener) window.addEventListener('hd-portraits-changed', function () {
    if (!st.open || !el) return;
    var old = el.querySelector('.sm-face');
    if (old && old.parentNode) old.parentNode.replaceChild(profileFace(), old);
  });

  function render() {
    if (!st.open) return;
    if (!el) return;

    // Long form, repainted on every control change — hold the reader's place.
    var bodyOld = el.querySelector('.sm-body');
    var keep = bodyOld ? bodyOld.scrollTop : 0;
    var focusWasFilter = document.activeElement
      && document.activeElement.classList
      && document.activeElement.classList.contains('sm-filter');

    el.innerHTML = '';

    var sheet = h('div', { class: 'sm-sheet' });
    var zoom = h('div', { class: 'sm-zoom' });
    sheet.append(zoom);
    el.append(sheet);

    /* ---- header ---- */

    /* Her face, if the deck has one. Same two-step src fallback the roster row
       uses: Ultralight can treat the ?v= cache-bust as part of the FILENAME,
       so try the query form, retry plain once, then give up to initials. */
    var faceEl = profileFace();

    /* The switch. Disabled outright when sharmat-global.js has not loaded —
       a tab that leads to an empty panel is worse than no tab. */
    function modeTabs() {
      var box = h('div', { class: 'sm-modes' });
      if (!window.SmGlobal) return box;
      [['npc', st.label || 'Her profile', dirty()],
       ['global', 'CHIM \u00b7 global', SmGlobal.anyDirty() > 0]].forEach(function (t) {
        box.append(h('button', {
          class: 'sm-mode' + (st.mode === t[0] ? ' on' : ''), type: 'button',
          title: t[0] === 'global'
            ? 'CHIM\u2019s own settings, prompts and speak styles \u2014 these apply to EVERY NPC'
            : 'This person\u2019s profile',
          onClick: function (e) {
            e.stopPropagation();
            if (st.mode === t[0]) return;
            st.mode = t[0];
            st.filter = '';
            if (t[0] === 'global') SmGlobal.wake();
            render();
          },
        }, h('span', { class: 'lbl' }, t[1]),
           t[2] ? h('span', { class: 'edited' }, 'edited') : null));
      });
      return box;
    }

    function scaleHost() {
      var box = h('span', { class: 'sm-scale' });
      if (window.HDScale) HDScale.mount(box, 'sharmat');
      return box;
    }

    var src = val('source', '');
    var badges = h('span', { class: 'sm-badges' },
      src === 'ai' ? h('span', { class: 'sm-badge ai' }, 'AI generated') : null,
      src === 'manual' ? h('span', { class: 'sm-badge man' }, 'Hand-written') : null,
      val('race', '') ? h('span', { class: 'sm-badge' }, val('race', '')) : null);

    var dirtyNow = dirty() || !!(window.SmGlobal && SmGlobal.anyDirty());
    var head = h('div', { class: 'sm-head' },
      faceEl,
      h('span', { class: 'sm-titles' },
        h('span', { class: 'sm-title', title: st.label }, st.label),
        h('span', { class: 'sm-subline' },
          h('span', { class: 'sm-sub', title: 'CHIM knows her as “' + st.name + '”' }, st.name),
          badges)),
      /* Her profile ‖ CHIM. Two modes, not two panels: everything a person
         needs is one click from everything CHIM-wide, but the two never share
         a Save — one writes to her record, the other to every NPC's. */
      modeTabs(),
      /* Panel size. This modal is the one deck surface the Followers tab's
         --fd-ui-scale deliberately does not reach — it lives outside
         #fd-scale — so without this it is stuck at 100% while the tab that
         opened it is not. */
      scaleHost(),
      /* Closing on unsaved edits is ARMED, not instant. There is no confirm()
         in a PrismaUI view, and the prompt box holds hand-written prose. */
      h('button', {
        class: 'sm-x' + (st.armedClose ? ' armed' : ''), type: 'button',
        title: dirtyNow ? 'Unsaved changes — click again to discard them' : 'Close (Esc)',
        'aria-label': st.armedClose ? 'Discard unsaved changes and close' : 'Close',
        onClick: function (e) {
          e.stopPropagation();
          if (dirtyNow && !st.armedClose) {
            st.armedClose = true;
            render();
            setTimeout(function () { if (st.armedClose) { st.armedClose = false; render(); } }, 3200);
            return;
          }
          close();
        },
      }, st.armedClose ? 'Discard changes' : '✕'));
    zoom.append(head);

    /* ---- rail + body ---- */

    var main = h('div', { class: 'sm-main' });
    zoom.append(main);

    /* Which sections exist at all is the MODE's business; the filter then
       narrows them the same way in both. */
    var all = (st.mode === 'global' && window.SmGlobal)
      ? SmGlobal.sections().filter(function (x) { return SmGlobal.has(x); })
      : SECTIONS.filter(function (x) { return !x.when || x.when(); });
    var shown = all.filter(sectionMatches);

    var body = h('div', { class: 'sm-body' });

    /* The rail. Jump-to + a filter over the whole form, because a profile
       this long is the exact case Rober's "always a typeable search bar"
       rule was written for. */
    var filterBox = h('input', {
      class: 'sm-filter', type: 'text', spellcheck: 'false',
      placeholder: 'Filter this profile…', 'aria-label': 'Filter profile sections',
      onClick: function (e) { e.stopPropagation(); },
      onInput: function (e) { st.filter = e.target.value; render(); },
      onKeydown: function (e) {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (st.filter) { st.filter = ''; render(); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          var first = body.querySelector('.sm-card');
          if (first) first.scrollIntoView({ block: 'start' });
        }
      },
    });
    filterBox.value = st.filter || '';

    var railList = h('div', { class: 'sm-rail-list' });
    if (!shown.length) {
      railList.append(h('div', { class: 'sm-rail-empty' }, 'Nothing matches “' + st.filter + '”.'));
    }
    var rail = h('div', { class: 'sm-rail' }, filterBox, railList);
    main.append(rail, body);

    /* ---- banners ---- */

    /* NO blocking screen. The form below is always drawn — on defaults until
       the read lands, on server truth after. These only ANNOTATE it. */
    var notes = h('div', { class: 'sm-notes' });
    var anyNote = false;
    if (st.mode === 'global') {
      anyNote = true;
      notes.append(h('div', { class: 'sm-note warn' },
        'This is CHIM itself, not ' + st.label + '. Everything below changes how EVERY NPC behaves.'));
    } else if (st.loading) {
      anyNote = true;
      notes.append(h('div', { class: 'sm-note' },
        'Reading her profile from CHIM… you can start editing now.'));
    } else if (st.loadErr) {
      anyNote = true;
      notes.append(h('div', { class: 'sm-note ' + (st.chimDown ? 'warn' : 'bad') },
        h('div', null, st.chimDown
          ? 'CHIM isn’t answering, so this is a blank profile — it only runs while the CHIM server is up.'
          : ('Couldn’t read her profile: ' + st.loadErr)),
        h('div', { style: 'margin-top:6px;opacity:.85' },
          'You can still edit and Save — a Save re-reads first, so it only writes the fields you actually changed.'),
        h('button', {
          class: 'sm-btn', type: 'button',
          onClick: function (e) { e.stopPropagation(); load(); },
        }, '⟳ Try again')));
    }
    if (st.isNew && st.mode !== 'global') {
      anyNote = true;
      notes.append(h('div', { class: 'sm-note warn' },
        'No profile stored for her yet — fill anything in and Save to create one.'));
    }
    if (st.err && st.mode !== 'global') {
      anyNote = true;
      notes.append(h('div', { class: 'sm-note bad' }, 'Save failed. ' + st.err));
    }
    if (anyNote) body.append(notes);

    /* ---- the cards ---- */

    var grid = h('div', { class: 'sm-grid' });
    body.append(grid);

    var filtering = !!String(st.filter || '').trim();
    shown.forEach(function (sec) {
      var isGlobal = st.mode === 'global';
      var edited = isGlobal ? SmGlobal.secDirty(sec) : sectionDirty(sec);
      var card;
      if (isGlobal) {
        /* SmGlobal returns its OWN card for the folding groups (it owns the
           open/closed state), and a plain body for the two bespoke ones. */
        var built = SmGlobal.build(sec, filtering);
        if (built && built.classList && built.classList.contains('sm-card')) {
          card = built;
          if (sec.wide) card.classList.add('full');
        } else {
          card = h('div', { class: 'sm-card' + (sec.wide ? ' full' : '') + (edited ? ' accent' : '') });
          card.setAttribute('data-sm-sec', sec.id);
          card.append(h('div', { class: 'sm-card-head' },
            h('span', { class: 'sm-card-title' }, sec.title),
            sec.note ? h('span', { class: 'sm-card-note' }, sec.note) : null));
          card.append(built);
        }
      } else {
        card = h('div', { class: 'sm-card' + (sec.wide ? ' full' : '') + (edited ? ' accent' : '') });
        card.setAttribute('data-sm-sec', sec.id);
        card.append(h('div', { class: 'sm-card-head' },
          h('span', { class: 'sm-card-title' }, sec.title),
          sec.note ? h('span', { class: 'sm-card-note' }, sec.note) : null));
        card.append(buildSection(sec));
      }
      grid.append(card);

      var target = card.getAttribute('data-sm-sec') || sec.id;
      railList.append(h('button', {
        class: 'sm-jump', type: 'button',
        onClick: function (e) {
          e.stopPropagation();
          var t = body.querySelector('[data-sm-sec="' + target + '"]');
          if (t) t.scrollIntoView({ block: 'start' });
        },
      }, h('span', { class: 'lbl' }, sec.title),
         edited ? h('span', { class: 'edited' }, 'edited') : null));
    });

    /* ---- commit bar ---- */

    if (st.mode === 'global' && window.SmGlobal) {
      /* The global half saves TWO independent records through two endpoints,
         so it brings its own bar rather than pretending one Save covers both. */
      var gDirty = SmGlobal.anyDirty();
      zoom.append(h('div', { class: 'sm-commit global' },
        h('span', { class: 'msg' + (gDirty ? ' dirty' : '') }, SmGlobal.message()),
        SmGlobal.commitBar()));
    } else {
      var n = Object.keys(patch()).length;
      var save = h('button', {
        class: 'sm-btn save', type: 'button',
        disabled: (!n || st.busy) ? true : null,
        onClick: function (e) { e.stopPropagation(); commit(); },
      }, st.busy ? 'Saving…' : 'Save to CHIM');
      zoom.append(h('div', { class: 'sm-commit' },
        /* "Saved" would be a lie when the read never landed — nothing was ever
           loaded to save. Say what is actually true of each state. */
        h('span', { class: 'msg' + (n ? ' dirty' : '') },
          st.busy ? 'Saving…'
            : n ? (n + ' change' + (n === 1 ? '' : 's') + ' not saved')
            : st.loadErr ? 'Nothing loaded — edit a field and Save.'
            : st.loading ? 'Reading her profile…'
            : 'Saved — live from her next line.'),
        save));
    }

    body.scrollTop = keep;
    if (focusWasFilter) {
      // Typing in the filter re-renders the whole form; without this the
      // caret is thrown out of the box on the first keystroke.
      filterBox.focus();
      var at = String(st.filter || '').length;
      try { filterBox.setSelectionRange(at, at); } catch (e) { /* not a text input in some hosts */ }
    }
  }

  /* --------------------------------------------------------- lifecycle --- */

  /* `face` is { file, mtime, hue } as already resolved by the Followers pane.
     Passed in rather than re-derived: the name->slug rule has three
     implementations already (pane, portal, README) and a fourth would be one
     more place for them to drift. Omit it and the header shows initials. */
  function open(chimName, label, face) {
    var keepStyles = st.styles;      // catalogs are session-wide, not per-NPC
    var keepConn = st.connectors, keepPick = st.connector;
    close();
    st.open = true;
    st.styles = keepStyles;
    st.connectors = keepConn; st.connector = keepPick;
    st.face = face || null;
    st.armedClose = false;
    st.name = String(chimName || '').trim();
    st.label = String(label || chimName || '');
    /* Seed the draft with an unconfigured NPC's defaults so the FULL editor
       paints on the first frame. The read that follows fills it in. */
    st.base = defaults();
    st.data = defaults();
    st.err = ''; st.loadErr = ''; st.isNew = false; st.chimDown = false;
    st.loading = false; st.loaded = false;
    st.kink = { normal: '', secret: '' };
    st.filter = '';
    st.combo = null;
    /* Per-NPC, all of it: an armed Generate left over from the LAST person
       would fire on THIS one, and a spouse search is about whoever was open
       when it was typed. The two CATALOGS (styles, connectors) are the only
       session-wide state here, and they are carried across by open(). */
    st.armedGen = false; st.armedDel = false;
    st.gen = ''; st.del = '';
    st.spouse = { q: '', busy: false, hits: null };
    /* Always open ON HER. The global half is a deliberate trip, never where
       a right-click on a follower lands you. */
    st.mode = 'npc';
    if (window.SmGlobal) {
      SmGlobal.reset();
      /* One implementation of every widget, borrowed rather than copied —
         a second set would drift the moment either was touched. */
      SmGlobal.bind(
        { h: h, field: field, textCtl: textCtl, seg: seg, combo: combo, fold: fold },
        {
          call: call,
          repaint: render,
          toast: function (m) { if (typeof window.hdToast === 'function') window.hdToast(m); },
          connector: function () { return st.connector; },
        });
    }

    /* Full-screen: no placement, no drag, no clamp. The modal IS the overlay,
       so there is nothing left to push off an edge — which is why ~90 lines
       of measuring and clamping went with the float on 2026-09-20. */
    el = h('div', { class: 'sm-pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sharmat profile' });
    var host = document.getElementById('overlay') || document.body;
    host.appendChild(el);

    render();
    load();
  }

  function close() {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    st.open = false;
    st.combo = null;
    st.mode = 'npc';
    if (window.SmGlobal) SmGlobal.reset();
    pending = {};        // abandon any in-flight reply
  }

  function isOpen() { return st.open; }

  /* Esc closes the modal BEFORE the deck acts on it, so the palette does not
     close out from under an open profile. */
  function onKey(e) {
    if (!st.open) return false;
    if (e.key === 'Escape') {
      /* An open picker eats the first Escape — closing the whole profile
         because someone dismissed a dropdown would be a nasty surprise.
         (The picker's own handler also stops it; this is the belt for a
         host that routes keys to us before the focused element.) */
      if (st.combo) { st.combo = null; render(); return true; }
      /* Same rule as the ✕: Escape on unsaved edits ARMS, it does not
         discard. Esc is a reflex, and the prompt box holds typed prose —
         and in global mode it may hold a rewritten CHIM prompt library. */
      if ((dirty() || (window.SmGlobal && SmGlobal.anyDirty())) && !st.armedClose) {
        st.armedClose = true;
        render();
        setTimeout(function () { if (st.armedClose) { st.armedClose = false; render(); } }, 3200);
        return true;
      }
      close();
      return true;
    }
    return false;
  }

  window.smReply = deliver;

  return {
    open: open, close: close, isOpen: isOpen, onKey: onKey,
    /* exposed for the standalone harness */
    _st: st, _patch: patch, _deliver: deliver, _render: render,
    _sections: SECTIONS,
  };
})();
