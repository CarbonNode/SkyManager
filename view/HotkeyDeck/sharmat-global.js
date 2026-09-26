'use strict';

/* ====================================================================== *
 *  SmGlobal — the CHIM-wide half of the Sharmat modal.
 *
 *  The Sharmat modal edits ONE person. Everything in here changes CHIM for
 *  EVERY person: its settings, its prompt library, its speak-style catalog,
 *  and the batch that writes profiles for a whole save. Rober, 2026-09-20:
 *  "i want it fully featured please." Its own file for the same reason
 *  sharmat-pane.css is its own sheet — several sessions edit this checkout
 *  at once and a 1500-line pane is enough.
 *
 *  ---- why this is DATA-DRIVEN, not a hand-written form ------------------
 *  CHIM's settings map is ~150 keys and its prompt library ~200, and both
 *  grow with every CHIM release. A hand-written control per key would be
 *  stale the week after it shipped. So: the editor renders WHATEVER the
 *  server answers with, picking a control from the VALUE's type and a group
 *  from the KEY's shape. A setting CHIM adds tomorrow shows up here with no
 *  edit at all — in "Everything else" if nothing claims it, which is the
 *  honest place for a key we know nothing about.
 *
 *  ---- ⛔ BOTH SAVE HANDLERS ARE DESTRUCTIVE ON A PARTIAL POST ⛔ ---------
 *  handleSaveSettings() and handleSavePromptSettings() do NOT merge with
 *  what is stored: each rebuilds the whole record out of
 *  `$_POST[key] ?? <default>`. Posting only what changed therefore RESETS
 *  every key you left out — the arousal tuning, every cooldown, the whole
 *  prompt library — to CHIM's defaults, globally, in one click.
 *
 *  So commit() re-reads first, lays the local edits over the fresh read, and
 *  posts the ENTIRE key set back, exactly like the per-NPC save. And it
 *  REFUSES to post at all if that read failed or came back implausibly small
 *  (see MIN_KEYS): a short read is how you would wipe the config with a
 *  well-formed request. Do not "optimise" either of those away.
 *
 *  The exception is saveAutoGenerate, which merges server-side — so the
 *  auto-generate pair is posted on its own and is safe.
 * ====================================================================== */

window.SmGlobal = (function () {

  /* A read that comes back with fewer keys than this is not a CHIM config —
     it is a truncated or errored reply, and posting it back would blank the
     rest. Both real maps are an order of magnitude bigger; the floor only has
     to be above "a handful". */
  var MIN_KEYS = { settings: 20, prompts: 20 };

  /* ---- grouping ------------------------------------------------------- *
   *  FIRST match wins, and the last entry matches everything, so every key
   *  lands somewhere. The titles are the vocabulary Rober would search for,
   *  not CHIM's internal naming.                                           */
  var SET_GROUPS = [
    { id: 'gs-scene', title: 'Scenes & pacing', re: /^(NSFW_SCENE|NPC_SCENE|GROUP_SCENE|BLOCK_RECHAT|PLAYER_SCENE|LEGACY_SCENE|SCENE_|NSFW_ALLOW|NSFW_OSLA)/,
      terms: 'scene start join steering pace rechat commentary' },
    { id: 'gs-arousal', title: 'Arousal', re: /AROUSAL/, terms: 'arousal decay gain threshold horny' },
    { id: 'gs-gate', title: 'Gating & consent', re: /(AFFINITY|CONSENT|AFFAIR|CRUSH|COMBAT_BLOCK|OPEN_MODE|DEFEAT|DISPOSAL)/,
      terms: 'affinity consent affair cheating crush combat open mode defeat enslave' },
    { id: 'gs-cool', title: 'Cooldowns, limits & tokens', re: /(COOLDOWN|TOKEN_LIMIT|THROTTLE|_WINDOW_|_SECONDS|_HOURS|_MINUTES|STALE)/,
      terms: 'cooldown token limit window seconds hours timeout' },
    { id: 'gs-fert', title: 'Fertility, pregnancy & family', re: /FERTILITY|LINEAGE|TRAGEDY/,
      terms: 'fertility pregnancy pregnant children heir lineage miscarriage' },
    { id: 'gs-drunk', title: 'Drink, skooma & whiskey dick', re: /(DRUNK|WHISKEY|SKOOMA|ALCOHOL|SAP)/,
      terms: 'drunk drink alcohol skooma whiskey impotence' },
    { id: 'gs-trade', title: 'Prostitution & payment', re: /(PROSTITUTE|PAYMENT|price_template)/,
      terms: 'prostitute payment price template gold budget standard luxury' },
    { id: 'gs-vr', title: 'VR touch & physics', re: /^(NSFW_VR|PHYSICS_|vr_)/, terms: 'vr touch grab spank cbpc physics' },
    { id: 'gs-voice', title: 'Voice, moans & TTS', re: /^(XTTS_|ENABLE_RANDOM_MOANS|MOANS_|RANDOM_MOAN)/,
      terms: 'xtts voice moan tts speed' },
    { id: 'gs-text', title: 'Prose kept on the settings record', re: /^[a-z]/,
      terms: 'glossary frame text prompt prose gaze' },
    { id: 'gs-rest', title: 'Everything else', re: /./, terms: 'other misc unknown new' },
  ];

  var PR_GROUPS = [
    { id: 'gp-frame', title: 'Framework', re: /^(global_scene_overhead|scene_commentary|kinks_template|kink_)/,
      terms: 'overhead commentary kinks template satisfied' },
    { id: 'gp-prof', title: 'Profanity levels', re: /^profanity_/, terms: 'profanity soft moderate hard extreme language' },
    { id: 'gp-tier', title: 'Affinity tiers — ordinary NPCs', re: /^tier_/, terms: 'tier affinity hostile neutral fond devoted bonded' },
    { id: 'gp-marr', title: 'Marriage', re: /^marriage_/, terms: 'marriage spouse wife husband' },
    { id: 'gp-aff', title: 'Affairs', re: /^affair_/, terms: 'affair cheating infidelity' },
    { id: 'gp-pros', title: 'Sex-worker overhead', re: /prostitute/, terms: 'prostitute sex worker paid client' },
    { id: 'gp-slave', title: 'Servitude overhead', re: /^slave_|servitude/, terms: 'slave servitude master owner' },
    { id: 'gp-slut', title: 'Promiscuous overhead', re: /^slut_|promiscuous/, terms: 'slut promiscuous uninhibited' },
    { id: 'gp-drunk', title: 'Drink & skooma', re: /^(drunk_|skooma_|sleeping_tree|intoxicated|alcohol_|sap_)/,
      terms: 'drunk skooma sap intoxicated alcohol' },
    { id: 'gp-vr', title: 'VR touch, grab & spank', re: /^vr_/, terms: 'vr touch grab spank' },
    { id: 'gp-fert', title: 'Fertility & family lines', re: /^fertility_/, terms: 'fertility pregnancy family heir' },
    { id: 'gp-rest', title: 'Everything else', re: /./, terms: 'other misc unknown new' },
  ];

  /* The style fields, in the order CHIM's own editor lists them. `content` is
     the style itself; the other four are the moments it overrides. */
  var STYLE_FIELDS = [
    ['content', 'The style', 'How she speaks in a scene. #PRIMARY_PARTNER# is whoever she is addressing.', 'tall'],
    ['masturbation_prompt', 'Alone', 'Overrides the style when she is by herself.', 'short'],
    ['climax_prompt', 'Her climax', 'Overrides the style at her own finish.', 'short'],
    ['partner_climax_prompt', 'Partner’s climax', 'Overrides the style when the other one finishes.', 'short'],
    ['pillow_talk_prompt', 'Pillow talk', 'Overrides the style once the scene is over.', 'short'],
  ];

  var ui = null;          // the pane's widget helpers — see bind()
  var host = null;        // { call, toast, repaint }

  var st = {
    settings: { base: null, data: null, loading: false, err: '', busy: false, saved: false },
    prompts:  { base: null, data: null, loading: false, err: '', busy: false, saved: false },
    styles:   { list: null, loading: false, err: '', pick: '', draft: null, busy: false, armedDel: false, creating: false },
    /* The batch. `run` is a cursor the loop walks; a STOP flips `stop` and the
       loop notices between NPCs — nothing is cancelled mid-request, because a
       generate that is already in flight will write whether we listen or not. */
    batch: { list: null, all: null, missing: null, skipped: null, loading: false, err: '',
             running: false, stop: false, armed: false,
             i: 0, ok: 0, fail: 0, current: '', missingOnly: true, log: [] },
    auto: { on: null, connector: '', busy: false, err: '', armed: false },
    open: {},              // which group cards are expanded
  };

  function bind(helpers, hooks) { ui = helpers; host = hooks; }

  /* ------------------------------------------------------------ loading -- */

  function loadMap(kind) {
    var slot = st[kind];
    if (slot.loading) return;
    slot.loading = true; slot.err = ''; host.repaint();
    host.call(kind === 'settings' ? 'loadSettings' : 'loadPromptSettings', '', '', function (err, j) {
      slot.loading = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the read') : '');
      if (why) { slot.err = why; host.repaint(); return; }
      var map = (kind === 'settings' ? (j.data || j.settings) : (j.settings || j.data)) || {};
      /* Keep anything already edited, exactly as the per-NPC read does. */
      var mine = patch(kind);
      slot.base = map;
      slot.data = JSON.parse(JSON.stringify(map));
      Object.keys(mine).forEach(function (k) { slot.data[k] = mine[k]; });
      if (kind === 'settings') {
        st.auto.on = !!map.AUTO_GENERATE_NSFW_PROFILES;
        st.auto.connector = map.AUTO_GENERATE_CONNECTOR || '';
      }
      host.repaint();
    });
  }

  function loadStyles() {
    var s = st.styles;
    if (s.loading) return;
    s.loading = true; s.err = ''; host.repaint();
    host.call('loadGlobalStyles', '', '', function (err, j) {
      s.loading = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the read') : '');
      if (why) { s.err = why; host.repaint(); return; }
      /* Same array-or-map tolerance as the pane's picker — see parseStyles
         there for why the array shape is the one the live plugin sends. */
      var raw = j.styles || j.data || [];
      var out = [];
      if (Array.isArray(raw)) raw.forEach(function (d) { if (d && d.name) out.push(pickStyle(d)); });
      else Object.keys(raw).forEach(function (k) { out.push(pickStyle(raw[k] || {}, k)); });
      out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      s.list = out;
      host.repaint();
    });
  }
  function pickStyle(d, fallbackName) {
    return {
      name: String(d.name || fallbackName || ''),
      emoji: d.emoji || '',
      preview: String(d.preview || d.description || ''),
      /* Whether it came from speakStyles/*.txt rather than the database.
         It MATTERS: CHIM's delete only knows the database ones, and says
         "Style not found" for a file — so the UI must not offer it. */
      fromFile: !!d.file && !d.description && !d.content,
    };
  }

  /* One style, in full. The list reply carries only a preview, never the
     prompt text, so opening one for edit is a second request. */
  function openStyle(name) {
    var s = st.styles;
    s.pick = name; s.creating = false; s.armedDel = false; s.err = ''; s.draft = null;
    host.repaint();
    host.call('loadGlobalStyle', enc({ style: name }), '', function (err, j) {
      if (s.pick !== name) return;                 // moved on while it was in flight
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the read') : '');
      if (why) { s.err = why; host.repaint(); return; }
      s.draft = {
        name: j.name || name,
        emoji: j.emoji || '',
        description: j.description || '',
        content: j.content || '',
        masturbation_prompt: j.masturbation_prompt || '',
        climax_prompt: j.climax_prompt || '',
        partner_climax_prompt: j.partner_climax_prompt || '',
        pillow_talk_prompt: j.pillow_talk_prompt || '',
      };
      s.orig = JSON.stringify(s.draft);
      host.repaint();
    });
  }
  function newStyle() {
    var s = st.styles;
    s.pick = ''; s.creating = true; s.armedDel = false; s.err = '';
    s.draft = { name: '', emoji: '', description: '', content: '',
      masturbation_prompt: '', climax_prompt: '', partner_climax_prompt: '', pillow_talk_prompt: '' };
    s.orig = '';
    host.repaint();
  }
  function saveStyle() {
    var s = st.styles;
    if (!s.draft || s.busy) return;
    if (!String(s.draft.name || '').trim()) { s.err = 'A style needs a name.'; host.repaint(); return; }
    s.busy = true; s.err = ''; host.repaint();
    var form = {
      label: s.draft.name, description: s.draft.description, content: s.draft.content, emoji: s.draft.emoji,
      masturbation_prompt: s.draft.masturbation_prompt, climax_prompt: s.draft.climax_prompt,
      partner_climax_prompt: s.draft.partner_climax_prompt, pillow_talk_prompt: s.draft.pillow_talk_prompt,
    };
    host.call('saveGlobalStyle', '', enc(form), function (err, j) {
      s.busy = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the write') : '');
      if (why) { s.err = why; host.repaint(); return; }
      /* CHIM SANITISES the name — spaces to underscores, punctuation dropped,
         lower-cased — and answers with what it actually stored. Re-seat on
         that, or the editor would keep showing a name no style has. */
      var stored = (j && j.name) || s.draft.name;
      s.list = null; s.creating = false;
      host.toast('✓ Style saved: ' + stored);
      loadStyles();
      openStyle(stored);
    });
  }
  function deleteStyle() {
    var s = st.styles;
    if (!s.draft || s.busy) return;
    s.busy = true; s.err = ''; s.armedDel = false; host.repaint();
    host.call('deleteGlobalStyle', '', enc({ label: s.draft.name }), function (err, j) {
      s.busy = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the delete') : '');
      if (why) { s.err = why; host.repaint(); return; }
      s.draft = null; s.pick = ''; s.list = null;
      host.toast('✓ Style deleted');
      loadStyles();
    });
  }
  function styleDirty() {
    var s = st.styles;
    return !!s.draft && JSON.stringify(s.draft) !== (s.orig || '');
  }

  /* ------------------------------------------------------------ the map -- */

  function patch(kind) {
    var slot = st[kind];
    if (!slot.data || !slot.base) return {};
    var out = {};
    Object.keys(slot.data).forEach(function (k) {
      if (JSON.stringify(slot.data[k]) !== JSON.stringify(slot.base[k])) out[k] = slot.data[k];
    });
    return out;
  }
  function dirty(kind) { return Object.keys(patch(kind)).length; }
  function anyDirty() { return dirty('settings') + dirty('prompts') + (styleDirty() ? 1 : 0); }

  function setKey(kind, k, v) {
    var slot = st[kind];
    if (!slot.data) return;
    slot.data[k] = v;
    slot.saved = false;
    host.repaint();
  }

  /* CHIM takes a form body, so every value becomes a string. Booleans go as
     true/false (filter_var reads those), structures as JSON — matching how
     its own page posts them. */
  function formValue(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v == null ? '' : v);
  }

  /* Read-modify-write, and it REFUSES rather than risking the config — see
     the banner at the top of this file. */
  function commit(kind) {
    var slot = st[kind];
    if (!slot.data || slot.busy || !dirty(kind)) return;
    var mine = patch(kind);
    slot.busy = true; slot.err = ''; host.repaint();

    host.call(kind === 'settings' ? 'loadSettings' : 'loadPromptSettings', '', '', function (err, j) {
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the re-read') : '');
      if (why) {
        slot.busy = false;
        slot.err = 'Did not save: could not re-read CHIM first (' + why + '). ' +
          'Posting without that would reset every setting this panel did not send.';
        host.repaint();
        return;
      }
      var fresh = (kind === 'settings' ? (j.data || j.settings) : (j.settings || j.data)) || {};
      var n = Object.keys(fresh).length;
      if (n < MIN_KEYS[kind]) {
        slot.busy = false;
        slot.err = 'Did not save: CHIM answered with only ' + n + ' key(s), which is not a whole ' +
          kind + ' record. Posting that back would blank the rest.';
        host.repaint();
        return;
      }
      var merged = fresh;
      Object.keys(mine).forEach(function (k) { merged[k] = mine[k]; });

      var form = {};
      Object.keys(merged).forEach(function (k) { form[k] = formValue(merged[k]); });

      host.call(kind === 'settings' ? 'saveSettings' : 'savePromptSettings', '', enc(form), function (e2, j2) {
        var w2 = e2 || (j2 && j2.success !== true ? (j2.error || 'CHIM refused the write') : '');
        if (w2) { slot.busy = false; slot.err = w2; host.repaint(); return; }
        slot.busy = false;
        slot.base = null; slot.data = null;   // re-read: show what is actually stored
        slot.saved = true;
        host.toast('✓ Saved CHIM’s ' + kind + ' — every NPC');
        loadMap(kind);
      });
    });
  }

  /* Auto-generate is the ONE pair CHIM merges server-side (saveAutoGenerate
     loads the row and sets only these two), so it posts on its own and needs
     none of the read-modify-write ceremony above. */
  function saveAuto(on, connector) {
    if (st.auto.busy) return;
    st.auto.busy = true; st.auto.err = ''; host.repaint();
    var form = { AUTO_GENERATE_NSFW_PROFILES: on ? 'true' : 'false' };
    if (connector) form.AUTO_GENERATE_CONNECTOR = connector;
    host.call('saveAutoGenerate', '', enc(form), function (err, j) {
      st.auto.busy = false;
      var why = err || (j && j.success !== true ? (j.error || 'CHIM refused the write') : '');
      if (why) { st.auto.err = why; host.repaint(); return; }
      st.auto.on = on;
      if (connector) st.auto.connector = connector;
      host.toast(on ? '✓ CHIM will write profiles on its own' : '✓ Auto-generate off');
      host.repaint();
    });
  }

  /* --------------------------------------------------------- the batch -- */

  function names(list) {
    return (list || []).map(function (x) {
      return typeof x === 'string' ? x : String((x && (x.npc_name || x.name)) || '');
    }).filter(Boolean);
  }

  /* BOTH rosters, always — the missing-only one and the whole one.
     `getBatchNpcList` will not tell you who already HAS a profile, and that is
     exactly the number that matters: on "everyone", the generator OVERWRITES
     an existing profile and stamps it source='ai'. A hand-written profile is
     gone. Counting the difference is one extra cheap read and it is the only
     way this panel can say "N of these are hand-written and will be lost"
     instead of a cheerful "Write 214 profiles". */
  function loadBatch() {
    var b = st.batch;
    if (b.loading) return;
    b.loading = true; b.err = ''; b.all = null; b.missing = null; host.repaint();
    host.call('getBatchNpcList', enc({ missing_only: '1' }), '', function (e1, j1) {
      var w1 = e1 || (j1 && j1.success !== true ? (j1.error || 'CHIM refused the read') : '');
      if (w1) { b.loading = false; b.err = w1; host.repaint(); return; }
      b.missing = names(j1.npcs);
      b.skipped = (j1.skipped || []).map(function (x) {
        return typeof x === 'string' ? { name: x, reason: '' }
          : { name: String((x && (x.name || x.npc_name)) || ''), reason: String((x && x.reason) || '') };
      }).filter(function (x) { return x.name; });

      host.call('getBatchNpcList', enc({ missing_only: '0' }), '', function (e2, j2) {
        b.loading = false;
        var w2 = e2 || (j2 && j2.success !== true ? (j2.error || 'CHIM refused the read') : '');
        if (w2) { b.err = w2; host.repaint(); return; }
        b.all = names(j2.npcs);
        b.list = b.missingOnly ? b.missing : b.all;
        host.repaint();
      });
    });
  }
  /* How many of the ones about to be written ALREADY have a profile. Zero on
     missing-only by definition; on "everyone" it is the count of records the
     model is about to replace. */
  function overwrites() {
    var b = st.batch;
    if (b.missingOnly || !b.all || !b.missing) return 0;
    return Math.max(0, b.all.length - b.missing.length);
  }

  /* One NPC at a time, deliberately. CHIM serialises every request behind one
     semaphore and each generate is a real model round trip, so firing the
     whole roster at once would queue them anyway AND starve the game's own
     traffic for as long as it took. Sequential, stoppable, and it reports
     which ones failed rather than swallowing them. */
  function runBatch() {
    var b = st.batch;
    if (b.running || !b.list || !b.list.length) return;
    b.running = true; b.stop = false; b.i = 0; b.ok = 0; b.fail = 0; b.log = []; b.err = '';
    host.repaint();
    step();
  }
  function stopBatch() { st.batch.stop = true; host.repaint(); }
  function step() {
    var b = st.batch;
    if (b.stop || b.i >= b.list.length) {
      b.running = false; b.current = '';
      host.toast('Batch finished — ' + b.ok + ' written, ' + b.fail + ' failed' + (b.stop ? ' (stopped)' : ''));
      host.repaint();
      return;
    }
    var who = b.list[b.i];
    b.current = who;
    host.repaint();
    host.call('generateSexPrompt', '', enc({ npc: who, connector: host.connector() || '' }), function (err, j) {
      var why = err || (j && j.success !== true ? (j.error || 'refused') : '');
      if (why) { b.fail++; b.log.push({ name: who, err: why }); }
      else b.ok++;
      b.i++;
      step();
    });
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

  /* ----------------------------------------------------------- labels --- */

  /* CHIM's keys are SCREAMING_SNAKE or lower_snake. Neither is a label, and
     hand-writing 350 of them would be stale by the next release — so they are
     de-cased mechanically, with a small table for the ones where the mechanical
     result would actually mislead. */
  var LABEL_FIX = {
    XTTS_MODIFY_LEVEL1: 'XTTS pitch — level 1',
    XTTS_MODIFY_LEVEL2: 'XTTS pitch — level 2',
    XTTS_SPEED_LEVEL1: 'XTTS speed — level 1',
    XTTS_SPEED_LEVEL2: 'XTTS speed — level 2',
    NSFW_OPEN_MODE: 'Open mode (drops affinity gating entirely)',
    price_template_budget: 'Price template — budget',
    price_template_standard: 'Price template — standard',
    price_template_luxury: 'Price template — luxury',
  };
  function labelOf(k) {
    if (LABEL_FIX[k]) return LABEL_FIX[k];
    var s = String(k).replace(/_/g, ' ').trim();
    if (s === s.toUpperCase()) s = s.toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* --------------------------------------------------------- rendering -- */

  function groupsFor(kind) { return kind === 'settings' ? SET_GROUPS : PR_GROUPS; }
  function keysIn(kind, gid) {
    var slot = st[kind];
    if (!slot.data) return [];
    var groups = groupsFor(kind);
    return Object.keys(slot.data).filter(function (k) {
      for (var i = 0; i < groups.length; i++) if (groups[i].re.test(k)) return groups[i].id === gid;
      return false;
    }).sort();
  }

  /* One control, chosen from the VALUE. That is what keeps this honest when
     CHIM adds a key: a boolean gets a switch whether or not anyone here has
     heard of it. */
  function control(kind, k) {
    var h = ui.h, v = st[kind].data[k];

    if (typeof v === 'boolean') {
      return h('div', { class: 'sm-flag' },
        h('div', { class: 'b' }, h('div', { class: 't' }, labelOf(k)), h('div', { class: 's' }, k)),
        h('button', {
          class: 'sm-sw' + (v ? ' on' : ''), type: 'button', role: 'switch',
          'aria-checked': v ? 'true' : 'false', 'aria-label': labelOf(k),
          onClick: function (e) { e.stopPropagation(); setKey(kind, k, !v); },
        }));
    }

    if (typeof v === 'number') {
      return ui.field(labelOf(k), ui.textCtl({
        num: true, get: function () { return st[kind].data[k]; },
        set: function (x) { setKey(kind, k, x); },
      }), k);
    }

    /* A map of numbers is a price table: draw it as a table of numbers, not
       as JSON somebody has to hand-edit without a mistake. */
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length &&
        Object.keys(v).every(function (x) { return typeof v[x] === 'number'; })) {
      var grid = h('div', { class: 'sm-pair' });
      Object.keys(v).sort().forEach(function (sub) {
        grid.append(ui.field(labelOf(sub), ui.textCtl({
          num: true,
          get: function () { return st[kind].data[k][sub]; },
          set: function (x) {
            var next = JSON.parse(JSON.stringify(st[kind].data[k]));
            next[sub] = x;
            setKey(kind, k, next);
          },
        })));
      });
      return h('div', { class: 'sm-field' }, h('label', null, labelOf(k)), grid,
        h('div', { class: 'sm-hint' }, k + ' — gold per entry. 0 means CHIM falls back to the flat session price.'));
    }

    if (v && typeof v === 'object') {
      /* Anything else structured: JSON, and it REFUSES to accept text that
         does not parse rather than posting a string where an object goes. */
      return ui.field(labelOf(k), ui.textCtl({
        area: true, size: 'short',
        get: function () { return JSON.stringify(st[kind].data[k], null, 1); },
        set: function (x) {
          try { setKey(kind, k, JSON.parse(x)); }
          catch (e) { host.toast('⚠ ' + k + ': that is not valid JSON — not changed'); host.repaint(); }
        },
      }), k + ' — JSON. CHIM stores a structure here, so it must parse.');
    }

    var s = String(v == null ? '' : v);
    var long = s.length > 90 || s.indexOf('\n') >= 0;
    return ui.field(labelOf(k), ui.textCtl({
      area: long, size: s.length > 400 ? 'tall' : 'short',
      get: function () { return st[kind].data[k]; },
      set: function (x) { setKey(kind, k, x); },
    }), k);
  }

  /* A collapsed group. Law from 2026-09-14: anything that expands too far
     folds behind a chevron and is searchable. Here it is also what keeps the
     first paint cheap — 350 live controls at once is not something to ask
     Ultralight for. */
  function foldCard(kind, g, forceOpen) {
    var h = ui.h;
    var keys = keysIn(kind, g.id);
    if (!keys.length) return null;
    var p = patch(kind);
    var edited = keys.filter(function (k) { return Object.prototype.hasOwnProperty.call(p, k); }).length;
    var openKey = kind + ':' + g.id;
    var isOpen = forceOpen || !!st.open[openKey];

    var card = h('div', { class: 'sm-card' + (edited ? ' accent' : '') });
    card.setAttribute('data-sm-sec', openKey);
    card.append(h('button', {
      class: 'sm-fold' + (isOpen ? ' open' : ''), type: 'button',
      'aria-expanded': isOpen ? 'true' : 'false',
      onClick: function (e) { e.stopPropagation(); st.open[openKey] = !isOpen; host.repaint(); },
    },
      h('span', { class: 'chev' }, isOpen ? '⌄' : '›'),
      h('span', { class: 'sm-card-title' }, g.title),
      h('span', { class: 'sm-card-note' }, keys.length + (keys.length === 1 ? ' setting' : ' settings')),
      edited ? h('span', { class: 'edited' }, edited + ' edited') : null));

    if (isOpen) {
      var body = h('div', { class: 'sm-fold-body' });
      keys.forEach(function (k) { body.append(control(kind, k)); });
      card.append(body);
    }
    return card;
  }

  /* ---- the sections the modal's rail and grid ask for ---------------- */

  function sections() {
    var out = [
      { id: 'g-styles', title: 'Speak styles', note: 'the catalog every NPC picks from', wide: true,
        terms: 'style styles voice catalog create edit delete prompt climax pillow talk' },
      { id: 'g-batch', title: 'Write every profile', note: 'the whole save, one at a time', wide: true,
        terms: 'batch generate all every missing auto ai bulk' },
    ];
    SET_GROUPS.forEach(function (g) {
      out.push({ id: 'set:' + g.id, kind: 'settings', group: g, title: g.title, note: 'CHIM setting',
        terms: g.terms + ' setting settings global' });
    });
    PR_GROUPS.forEach(function (g) {
      out.push({ id: 'pr:' + g.id, kind: 'prompts', group: g, title: g.title, note: 'CHIM prompt',
        terms: g.terms + ' prompt prompts text wording global' });
    });
    return out;
  }

  function build(sec, filtered) {
    if (sec.id === 'g-styles') return buildStyles();
    if (sec.id === 'g-batch') return buildBatch();
    // A filtered view auto-expands, or a search would "find" a fold you then
    // have to open by hand to see what matched.
    return foldCard(sec.kind, sec.group, !!filtered) || ui.h('div', { class: 'sm-hint' }, 'Nothing here.');
  }

  /* Whether a section has anything to draw at all — the modal hides the rest
     rather than listing empty groups. */
  function has(sec) {
    if (sec.id === 'g-styles' || sec.id === 'g-batch') return true;
    return keysIn(sec.kind, sec.group.id).length > 0;
  }
  function secDirty(sec) {
    if (sec.id === 'g-styles') return styleDirty();
    if (sec.id === 'g-batch') return false;
    var p = patch(sec.kind);
    return keysIn(sec.kind, sec.group.id).some(function (k) {
      return Object.prototype.hasOwnProperty.call(p, k);
    });
  }

  function buildStyles() {
    var h = ui.h, s = st.styles, box = h('div');
    if (s.loading && !s.list) { box.append(h('div', { class: 'sm-note' }, 'Reading CHIM’s style catalog…')); return box; }
    if (s.err) box.append(h('div', { class: 'sm-note bad' }, s.err));
    if (!s.list) { loadStyles(); box.append(h('div', { class: 'sm-note' }, 'Reading CHIM’s style catalog…')); return box; }

    box.append(h('div', { class: 'sm-hint', style: 'margin-bottom:12px' },
      'These belong to CHIM, not to one person: editing a style changes how EVERY NPC set to it speaks. ' +
      s.list.length + ' in the catalog.'));

    var picker = h('div', { class: 'sm-sugg' });
    s.list.forEach(function (x) {
      picker.append(h('button', {
        class: 'sm-sugg-b' + (s.pick === x.name ? ' on' : ''), type: 'button',
        title: x.preview || x.name,
        onClick: function (e) { e.stopPropagation(); openStyle(x.name); },
      }, (x.emoji ? x.emoji + ' ' : '') + x.name));
    });
    picker.append(h('button', {
      class: 'sm-sugg-b new', type: 'button',
      onClick: function (e) { e.stopPropagation(); newStyle(); },
    }, '+ New style'));
    box.append(picker);

    if (!s.draft) return box;

    var d = s.draft;
    var editor = h('div', { class: 'sm-substack' });
    editor.append(h('div', { class: 'sm-pair' },
      ui.field('Name', ui.textCtl({
        get: function () { return d.name; }, set: function (v) { d.name = v; host.repaint(); },
        hint: 'lower_snake_case',
      }), s.creating ? 'CHIM lower-cases this and turns spaces into underscores.' : 'Renaming makes a NEW style; the old one stays.'),
      ui.field('Emoji', ui.textCtl({
        get: function () { return d.emoji; }, set: function (v) { d.emoji = v; host.repaint(); },
      }), 'Shown beside the name in CHIM’s own list.')));
    editor.append(ui.field('One-line description', ui.textCtl({
      get: function () { return d.description; }, set: function (v) { d.description = v; host.repaint(); },
    }), 'What the picker shows under the name.'));
    STYLE_FIELDS.forEach(function (f) {
      editor.append(ui.field(f[1], ui.textCtl({
        area: true, size: f[3],
        get: function () { return d[f[0]]; },
        set: function (v) { d[f[0]] = v; host.repaint(); },
      }), f[2]));
    });

    editor.append(h('div', { class: 'sm-note warn' },
      'Saving this changes how EVERY NPC set to “' + (d.name || 'this style') + '” speaks — not just the one ' +
      'whose profile you came in from. It is reversible: edit it back and save again.'));
    var row = h('div', { class: 'sm-gen' },
      h('button', {
        class: 'sm-btn save', type: 'button', disabled: (s.busy || !styleDirty()) ? true : null,
        onClick: function (e) { e.stopPropagation(); saveStyle(); },
      }, s.busy ? 'Saving…' : s.creating ? 'Create style' : 'Save style'));
    if (!s.creating) {
      var fromFile = (s.list || []).some(function (x) { return x.name === d.name && x.fromFile; });
      row.append(h('button', {
        class: 'sm-btn' + (s.armedDel ? ' danger' : ''), type: 'button',
        disabled: (s.busy || fromFile) ? true : null,
        onClick: function (e) {
          e.stopPropagation();
          if (!s.armedDel) {
            s.armedDel = true; host.repaint();
            setTimeout(function () { if (s.armedDel) { s.armedDel = false; host.repaint(); } }, 4000);
            return;
          }
          deleteStyle();
        },
      }, s.armedDel ? 'Delete it — sure?' : 'Delete style'));
      if (fromFile) {
        editor.append(h('div', { class: 'sm-hint' },
          'This one ships as a file in CHIM (speakStyles/' + d.name + '.txt), and its delete only knows the ' +
          'database ones — so Delete is off. Saving writes a database copy that overrides the file.'));
      }
    }
    editor.append(row);
    box.append(editor);
    return box;
  }

  function buildBatch() {
    var h = ui.h, b = st.batch, box = h('div');

    /* The standing toggle first: CHIM writing profiles on its own is a very
       different thing from a batch you watched run, and conflating them in
       one card would be a way to switch it on by accident. */
    box.append(h('div', { class: 'sm-flag' },
      h('div', { class: 'b' },
        h('div', { class: 't' }, 'Let CHIM write profiles on its own'),
        h('div', { class: 's' }, 'Anyone you talk to who has no profile gets one generated in the background. ' +
          'This is CHIM’s own setting, saved the moment you flip it.')),
      h('button', {
        class: 'sm-sw' + (st.auto.on ? ' on' : '') + (st.auto.armed ? ' armed' : ''), type: 'button', role: 'switch',
        'aria-checked': st.auto.on ? 'true' : 'false', 'aria-label': 'Auto-generate profiles',
        disabled: (st.auto.on === null || st.auto.busy) ? true : null,
        onClick: function (e) {
          e.stopPropagation();
          /* Turning it OFF is harmless and instant. Turning it ON is a
             standing instruction to spend model calls in the background on
             anyone you happen to speak to, so it arms first. */
          if (!st.auto.on && !st.auto.armed) {
            st.auto.armed = true; host.repaint();
            setTimeout(function () { if (st.auto.armed) { st.auto.armed = false; host.repaint(); } }, 5000);
            return;
          }
          st.auto.armed = false;
          saveAuto(!st.auto.on, host.connector());
        },
      })));
    if (st.auto.armed) {
      box.append(h('div', { class: 'sm-note bad' },
        '⚠ Flip it again to turn this on. It is a standing instruction: from then on, anyone you talk to ' +
        'who has no profile gets one written by ' + (host.connector() || 'CHIM’s configured model') +
        ' in the background — model calls you did not ask for, one per new NPC. It never overwrites an ' +
        'existing profile.'));
    }
    if (st.auto.err) box.append(h('div', { class: 'sm-note bad' }, st.auto.err));
    if (st.auto.on === null) {
      box.append(h('div', { class: 'sm-hint' }, 'Reading CHIM’s settings to find out…'));
    }

    box.append(h('div', { class: 'sm-hr' }));

    box.append(h('div', { class: 'sm-field' }, h('label', null, 'Who to write'),
      ui.seg([['missing', 'Only the ones with no profile'], ['all', 'Everyone CHIM knows']],
        b.missingOnly ? 'missing' : 'all', function (v) {
          b.missingOnly = (v === 'missing');
          b.armed = false;
          // Both rosters were fetched together, so switching is free.
          if (b.all && b.missing) b.list = b.missingOnly ? b.missing : b.all;
          host.repaint();
        }),
      h('div', { class: 'sm-hint' },
        'CHIM refuses children and animals itself; they come back on the skipped list with the reason.')));

    if (!b.list && !b.loading) {
      box.append(h('button', {
        class: 'sm-btn', type: 'button',
        onClick: function (e) { e.stopPropagation(); loadBatch(); },
      }, 'Count them'));
      if (b.err) box.append(h('div', { class: 'sm-note bad', style: 'margin-top:10px' }, b.err));
      return box;
    }
    if (b.loading) { box.append(h('div', { class: 'sm-note' }, 'Asking CHIM for the roster…')); return box; }

    var over = overwrites();
    box.append(h('div', { class: 'sm-note' + (b.list.length ? (over ? ' bad' : '') : ' warn') },
      b.list.length
        ? (b.list.length + ' NPC' + (b.list.length === 1 ? '' : 's') + ' to write' +
           (b.skipped && b.skipped.length ? ', ' + b.skipped.length + ' skipped by CHIM' : '') + '. ' +
           'One at a time, through ' + (host.connector() || 'no connector chosen') +
           ' — each is a real model call, so this takes minutes, not seconds.')
        : 'Nothing to do — every NPC CHIM knows already has a profile.'));

    /* ⛔ THE ONE THAT CANNOT BE UNDONE. On "everyone", the generator does not
       skip an NPC who already has a profile — it OVERWRITES the prompt, the
       style, both kink lists, the role flags and the relationship fields, and
       stamps the record source='ai'. A profile you wrote by hand is simply
       gone, and there is no undo anywhere in CHIM. So the count is named, in
       red, and the button is armed. */
    if (over) {
      box.append(h('div', { class: 'sm-note bad', style: 'margin-top:10px' },
        h('div', null, '⚠ ' + over + ' of these already have a profile — including every one you wrote by hand.'),
        h('div', { style: 'margin-top:6px' },
          'Writing everyone does not skip them: the model REPLACES the prompt, the speak style, both kink ' +
          'lists, the role flags and the relationship fields, and marks the record AI-generated. CHIM keeps ' +
          'no history, so there is nothing to undo it with.'),
        h('div', { style: 'margin-top:6px' },
          'Only the ones with no profile is the safe half of that switch — it touches nobody who already has one.')));
    }

    if (b.list.length) {
      var label = b.running ? 'Writing…'
        : b.armed ? (over ? 'Overwrite ' + over + ' hand-written — SURE?' : 'Write them — sure?')
        : 'Write ' + b.list.length + ' profile' + (b.list.length === 1 ? '' : 's');
      box.append(h('div', { class: 'sm-gen', style: 'margin-top:12px' },
        h('button', {
          class: 'sm-btn ' + (b.armed ? 'danger' : over ? '' : 'save'), type: 'button',
          disabled: (b.running || !host.connector()) ? true : null,
          onClick: function (e) {
            e.stopPropagation();
            if (!b.armed) {
              b.armed = true; host.repaint();
              setTimeout(function () { if (b.armed) { b.armed = false; host.repaint(); } }, 5000);
              return;
            }
            b.armed = false;
            runBatch();
          },
        }, label),
        b.running ? h('button', {
          class: 'sm-btn danger', type: 'button',
          onClick: function (e) { e.stopPropagation(); stopBatch(); },
        }, b.stop ? 'Stopping after this one…' : 'Stop') : null,
        h('button', {
          class: 'sm-btn', type: 'button', disabled: b.running ? true : null,
          onClick: function (e) {
            e.stopPropagation();
            b.list = null; b.all = null; b.missing = null; b.skipped = null; b.armed = false; host.repaint();
          },
        }, 'Recount')));
      if (!host.connector()) {
        box.append(h('div', { class: 'sm-hint' }, 'Pick a model on her profile first — the batch uses the same one.'));
      }
    }

    if (b.running || b.ok || b.fail) {
      box.append(h('div', { class: 'sm-field', style: 'margin-top:14px' },
        h('label', null, 'Progress'),
        h('div', { class: 'sm-bar' }, h('div', {
          class: 'fill',
          style: 'width:' + Math.round((b.i / Math.max(1, b.list.length)) * 100) + '%',
        })),
        h('div', { class: 'sm-hint' },
          b.i + ' of ' + b.list.length + ' · ' + b.ok + ' written · ' + b.fail + ' failed' +
          (b.current ? ' · now: ' + b.current : ''))));
    }
    if (b.log.length) {
      box.append(ui.fold('Failures (' + b.log.length + ')', b.log.map(function (x) {
        return h('div', { class: 'sm-hint' }, x.name + ' — ' + x.err);
      })));
    }
    if (b.skipped && b.skipped.length) {
      box.append(ui.fold('Skipped by CHIM (' + b.skipped.length + ')', b.skipped.map(function (x) {
        return h('div', { class: 'sm-hint' }, x.name + (x.reason ? ' — ' + x.reason : ''));
      })));
    }
    return box;
  }

  /* The modal's commit bar, in global mode: two independent saves, because
     they are two independent records with two independent endpoints. */
  function commitBar() {
    var h = ui.h, row = h('span', { class: 'sm-gen' });
    ['settings', 'prompts'].forEach(function (kind) {
      var n = dirty(kind), slot = st[kind];
      row.append(h('button', {
        class: 'sm-btn' + (n ? ' save' : ''), type: 'button',
        disabled: (!n || slot.busy) ? true : null,
        onClick: function (e) { e.stopPropagation(); commit(kind); },
      }, slot.busy ? 'Saving…' : n
          ? ('Save ' + n + ' ' + kind + ' change' + (n === 1 ? '' : 's') + ' \u2014 every NPC')
          : ('No ' + kind + ' changes')));
    });
    return row;
  }
  function message() {
    var a = dirty('settings'), b = dirty('prompts');
    if (st.settings.err) return st.settings.err;
    if (st.prompts.err) return st.prompts.err;
    if (st.settings.busy || st.prompts.busy) return 'Saving — CHIM is being re-read first, then the whole record is posted.';
    if (st.settings.loading || st.prompts.loading) return 'Reading CHIM’s global config…';
    if (a || b) return 'Unsaved: ' + a + ' setting' + (a === 1 ? '' : 's') + ', ' + b + ' prompt' + (b === 1 ? '' : 's') + '. These apply to EVERY NPC.';
    return 'CHIM-wide config. Everything here applies to every NPC.';
  }

  /* Called when the modal switches INTO global mode. Idempotent — the maps
     are only fetched once per open. */
  function wake() {
    if (!st.settings.data && !st.settings.loading) loadMap('settings');
    if (!st.prompts.data && !st.prompts.loading) loadMap('prompts');
    if (!st.styles.list && !st.styles.loading) loadStyles();
  }
  /* Called when the modal closes: the config is CHIM-wide, so it does not
     belong to the person who happened to be open. Dropping it also means the
     next open re-reads rather than showing a stale record. */
  function reset() {
    st.settings = { base: null, data: null, loading: false, err: '', busy: false, saved: false };
    st.prompts = { base: null, data: null, loading: false, err: '', busy: false, saved: false };
    st.styles = { list: null, loading: false, err: '', pick: '', draft: null, busy: false, armedDel: false, creating: false };
    st.batch = { list: null, all: null, missing: null, skipped: null, loading: false, err: '',
                 running: false, stop: false, armed: false,
                 i: 0, ok: 0, fail: 0, current: '', missingOnly: true, log: [] };
    st.auto = { on: null, connector: '', busy: false, err: '', armed: false };
    st.open = {};
  }

  return {
    bind: bind, wake: wake, reset: reset,
    sections: sections, build: build, has: has, secDirty: secDirty,
    commitBar: commitBar, message: message, anyDirty: anyDirty,
    /* exposed for the standalone harness */
    _st: st, _patch: patch, _labelOf: labelOf, _commit: commit, _formValue: formValue,
  };
})();
