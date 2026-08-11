'use strict';

/* ====================================================================== *
 *  Sharmat popout — CHIM's per-NPC intimacy profile, edited in-game.
 *
 *  Opened from the Followers tab's member menu (right-click a follower →
 *  "Sharmat profile…"). A floating, draggable panel rather than another
 *  tab: it belongs TO a person, the way the member menu does, and it is
 *  far too long to live inside that menu.
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
  var SPOUSAL = ['single', 'married', 'widowed'];
  var ORIENT = ['heterosexual', 'homosexual', 'bisexual', 'asexual'];
  var PREF = ['monogamous', 'polyamorous', 'uncommitted', 'not_interested'];
  var FLAGS = [
    ['is_slave', 'Slave', 'Servitude prompt + slave speech styles.'],
    ['is_prostitute', 'Sex worker', 'Unlocks pricing and paid-services talk.'],
    ['is_slut', 'Uninhibited', 'Drops the usual reluctance gating.'],
    ['slave_fiction_frame', 'Fiction frame', 'The "interactive fiction" framing. Leave on.'],
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
    /* { file, mtime, hue } handed in by the Followers pane at open — the deck
       already knows the winning portrait, and re-deriving it here would mean a
       second copy of the slug rule (there are three already). Null = initials. */
    face: null,
    /* CHIM's speak-style catalog, fetched once per session alongside the first
       profile. Until it lands the style control is a free-text box; after, it
       is a proper picker. Cached because it is the same list for everyone. */
    styles: null,
    /* Closing with unsaved edits is armed, not instant — PrismaUI has no
       confirm(), and prose typed into the prompt box is expensive to lose. */
    armedClose: false,
  };

  var el = null;              // the panel
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

  /* Only what differs from the loaded truth. JSON-compares because two of
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
    });
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
      var raw = j.styles || j.data || {};
      var out = [];
      Object.keys(raw).sort().forEach(function (k) {
        var d = raw[k] || {};
        out.push({ name: k, emoji: d.emoji || '', desc: d.description || '' });
      });
      if (!out.length) return;
      st.styles = out;
      if (st.open) render();
    });
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

  function addKink(which) {
    var key = which === 'secret' ? 'secret_kinks' : 'kinks';
    var raw = (st.kink[which] || '').trim();
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
        onClick: function (e) { e.stopPropagation(); onPick(o[0]); },
      }, o[1]);
    }));
  }

  function sect(title, note) {
    return h('div', { class: 'sm-sect' }, title, note ? h('span', { class: 'n' }, note) : null);
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

  function textRow(label, key, opts) {
    opts = opts || {};
    var inp = h(opts.area ? 'textarea' : 'input', {
      class: 'sm-in' + (opts.area ? ' area' : ''),
      type: opts.area ? null : (opts.num ? 'number' : 'text'),
      rows: opts.area ? '4' : null,
      spellcheck: 'false',
      placeholder: opts.hint || '',
      onClick: function (e) { e.stopPropagation(); },
      // `change` (not `input`): it fires on blur, so the repaint that follows
      // can never eat a caret mid-word. Same rule the member menu uses.
      onChange: function (e) { set(key, opts.num ? Math.trunc(Number(e.target.value) || 0) : e.target.value); },
      onKeydown: function (e) { if (e.key === 'Enter' && !opts.area) { e.preventDefault(); e.target.blur(); } },
    });
    inp.value = String(val(key, opts.num ? 0 : ''));
    /* Textareas (and anything explicitly flagged) span both grid columns so the
       prose fields get the full width; short inputs stay in the 2-col flow. */
    var wide = opts.area || opts.wide;
    return h('div', { class: 'sm-field' + (wide ? ' sm-wide' : '') }, h('label', null, label), inp);
  }

  function kinkBlock(which) {
    var key = which === 'secret' ? 'secret_kinks' : 'kinks';
    var list = val(key, []) || [];
    var wrap = h('div', { class: 'sm-wide' });   // kink lists span both columns

    if (list.length) {
      wrap.append(h('div', { class: 'sm-kinks' }, list.map(function (k, i) {
        return h('span', { class: 'sm-kink' + (which === 'secret' ? ' secret' : '') },
          h('span', { class: 'lbl' }, String(k)),
          h('button', {
            class: 'x', type: 'button', title: 'Remove',
            onClick: function (e) { e.stopPropagation(); delKink(which, i); },
          }, '✕'));
      })));
    } else {
      wrap.append(h('div', { class: 'sm-empty' }, 'None yet.'));
    }

    /* The add box deliberately does NOT repaint as you type — the Add button
       is its neighbour, and a re-render on blur would destroy it between
       mousedown and click. Track the text, commit on Add or Enter. */
    var box = h('input', {
      class: 'sm-in', type: 'text', spellcheck: 'false',
      placeholder: 'Add… (comma-separated)',
      onClick: function (e) { e.stopPropagation(); },
      onInput: function (e) { st.kink[which] = e.target.value; },
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

    var tierKey = which === 'secret' ? 'secret_kinks_unlock_tier' : 'kinks_unlock_tier';
    var selEl = h('select', {
      class: 'sm-in',
      onClick: function (e) { e.stopPropagation(); },
      onChange: function (e) { set(tierKey, Math.trunc(Number(e.target.value) || 0)); },
    }, TIERS.map(function (t) {
      var o = h('option', { value: String(t[0]) }, t[1] + ' (' + (t[0] > 0 ? '+' : '') + t[0] + ')');
      if (Number(val(tierKey, which === 'secret' ? 76 : 56)) === t[0]) o.selected = true;
      return o;
    }));
    wrap.append(h('div', { class: 'sm-field' }, h('label', null, 'Revealed at'), selEl));
    return wrap;
  }

  /* ------------------------------------------------------------ render --- */

  function render() {
    if (!st.open) return;
    if (!el) return;

    // Long panel, repainted on every control change — hold the reader's place.
    var bodyOld = el.querySelector('.sm-body');
    var keep = bodyOld ? bodyOld.scrollTop : 0;

    el.innerHTML = '';

    /* Her face, if the deck has one. Same two-step src fallback the roster row
       uses: Ultralight can treat the ?v= cache-bust as part of the FILENAME,
       so try the query form, retry plain once, then give up to initials. */
    var faceEl;
    if (st.face && st.face.file) {
      faceEl = h('img', { class: 'sm-face', src: 'portraits/' + st.face.file + '?v=' + (st.face.mtime || 0), alt: '', draggable: 'false' });
      /* The listener STAYS attached across the retry. Detaching it on the
         first error (as this did) meant the retry's own failure was never
         heard, so a genuinely missing file left an empty styled circle
         instead of falling back to initials. The `retried` flag — not
         listener removal — is what makes this fire at most twice. */
      faceEl.addEventListener('error', function () {
        if (faceEl.dataset.retried) { faceEl.replaceWith(initialsFace()); return; }
        faceEl.dataset.retried = '1';
        faceEl.src = 'portraits/' + st.face.file;   // plain, no ?v= query
      });
    } else {
      faceEl = initialsFace();
    }
    if (st.face && st.face.hue != null) faceEl.style.setProperty('--sm-hue', String(st.face.hue));

    /* mousedown-stopped: .sm-head is the DRAG handle, so a press on −/＋ would
       otherwise start dragging the panel out from under the cursor. */
    function scaleHost() {
      var box = h('span', { class: 'sm-scale' });
      box.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      if (window.HDScale) HDScale.mount(box, 'sharmat');
      return box;
    }

    var dirtyNow = dirty();
    var head = h('div', { class: 'sm-head' },
      faceEl,
      h('span', { class: 'sm-titles' },
        h('span', { class: 'sm-title', title: st.label }, st.label),
        h('span', { class: 'sm-sub', title: 'CHIM knows her as “' + st.name + '”' }, st.name)),
      /* Panel size. This popout is the one deck surface the Followers tab's
         --fd-ui-scale deliberately does not reach — it lives outside #fd-scale
         — so without this it is stuck at 100% while the tab that opened it is
         not. In the header rather than a settings row because there is no
         settings row: the panel is one long form and a size control buried in
         it would be under whatever you scrolled past. */
      scaleHost(),
      /* Closing on unsaved edits is ARMED, not instant. There is no confirm()
         in a PrismaUI view, and the prompt box holds hand-written prose. */
      h('button', {
        class: 'sm-x' + (st.armedClose ? ' armed' : ''), type: 'button',
        title: dirtyNow ? 'Unsaved changes — click again to discard them' : 'Close (Esc)',
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
      }, st.armedClose ? 'Discard?' : '✕'));
    el.append(head);
    makeDraggable(head);

    var body = h('div', { class: 'sm-body' });
    el.append(body);

    /* NO blocking screen. The form below is always drawn — on defaults until
       the read lands, on server truth after. These two banners only ANNOTATE
       it. (Editing before the read lands is safe; see load().) */
    if (st.loading) {
      body.append(h('div', { class: 'sm-note' },
        'Reading her profile from CHIM… you can start editing now.'));
    } else if (st.loadErr) {
      body.append(h('div', { class: 'sm-note ' + (st.chimDown ? 'warn' : 'bad') },
        h('div', null, st.chimDown
          ? 'CHIM isn’t answering, so this is a blank profile — it only runs while the CHIM server is up.'
          : ('Couldn’t read her profile: ' + st.loadErr)),
        h('div', { style: 'margin-top:6px;opacity:.85' },
          'You can still edit and Save — a Save re-reads first, so it only writes the fields you actually changed.'),
        h('button', {
          class: 'sm-btn', type: 'button', style: 'margin-top:8px',
          onClick: function (e) { e.stopPropagation(); load(); },
        }, '⟳ Try again')));
    }

    if (st.isNew) {
      body.append(h('div', { class: 'sm-note warn' },
        'No profile stored for her yet — fill anything in and Save to create one.'));
    }
    if (st.err) body.append(h('div', { class: 'sm-note bad' }, 'Save failed. ' + st.err));

    var src = val('source', '');
    if (src || val('race', '')) {
      body.append(h('div', { class: 'sm-badges' },
        src === 'ai' ? h('span', { class: 'sm-badge ai' }, 'AI generated') : null,
        src === 'manual' ? h('span', { class: 'sm-badge man' }, 'Hand-written') : null,
        val('race', '') ? h('span', { class: 'sm-badge' }, val('race', '')) : null));
    }

    body.append(sect('Voice'));
    /* A picker once CHIM's catalog has landed, a free-text box until then.
       The stored value is just a style NAME either way, so a style set before
       the catalog arrived stays valid — and a name the catalog doesn't know
       (hand-set, or from a newer CHIM) keeps its own option rather than being
       silently reset to the first entry in the list. */
    if (st.styles && st.styles.length) {
      var cur = String(val('speak_style', 'auto'));
      var known = cur === 'auto' || st.styles.some(function (s) { return s.name === cur; });
      var sel = h('select', {
        class: 'sm-in',
        onClick: function (e) { e.stopPropagation(); },
        onChange: function (e) { set('speak_style', e.target.value); },
      });
      var optAuto = h('option', { value: 'auto' }, '— Auto —');
      if (cur === 'auto') optAuto.selected = true;
      sel.append(optAuto);
      if (!known) {
        var keep = h('option', { value: cur }, cur + ' (not in CHIM’s list)');
        keep.selected = true;
        sel.append(keep);
      }
      st.styles.forEach(function (s) {
        var o = h('option', { value: s.name },
          (s.emoji ? s.emoji + ' ' : '') + s.name + (s.desc ? ' — ' + s.desc : ''));
        if (s.name === cur) o.selected = true;
        sel.append(o);
      });
      body.append(h('div', { class: 'sm-field' }, h('label', null, 'Speak style'), sel));
    } else {
      body.append(textRow('Speak style', 'speak_style', { hint: 'auto' }));
    }
    body.append(h('div', { class: 'sm-field' }, h('label', null, 'Profanity'),
      seg(PROFANITY, val('profanity_level', '2'), function (v) { set('profanity_level', v); })));

    body.append(sect('In-scene persona'));
    body.append(textRow('Prompt', 'sex_prompt', { area: true, hint: 'How she behaves during intimacy…' }));

    body.append(sect('Kinks', 'what she’ll ask for'));
    body.append(kinkBlock('normal'));
    body.append(sect('Secret kinks', 'only for someone she trusts'));
    body.append(kinkBlock('secret'));

    body.append(sect('Status'));
    FLAGS.forEach(function (f) {
      var on = !!val(f[0], f[0] === 'slave_fiction_frame');
      body.append(h('div', { class: 'sm-flag' },
        h('div', { class: 'b' }, h('div', { class: 't' }, f[1]), h('div', { class: 's' }, f[2])),
        h('button', {
          class: 'sm-sw' + (on ? ' on' : ''), type: 'button', role: 'switch',
          'aria-checked': on ? 'true' : 'false', title: f[1],
          onClick: function (e) { e.stopPropagation(); set(f[0], !on); },
        })));
    });
    if (val('is_prostitute', false)) {
      body.append(textRow('Session price', 'prostitute_price', { num: true }));
    }

    body.append(sect('Relationship'));
    body.append(h('div', { class: 'sm-field' }, h('label', null, 'Spousal'),
      seg(SPOUSAL.map(function (v) { return [v, v.charAt(0).toUpperCase() + v.slice(1)]; }),
        val('spousal_status', 'single'), function (v) { set('spousal_status', v); })));
    body.append(textRow('Spouse(s)', 'spouse_names', { hint: 'comma-separated' }));
    body.append(h('div', { class: 'sm-field' }, h('label', null, 'Orientation'),
      seg(ORIENT.map(function (v) { return [v, v.charAt(0).toUpperCase() + v.slice(1)]; }),
        val('sexual_orientation', 'heterosexual'), function (v) { set('sexual_orientation', v); })));
    body.append(h('div', { class: 'sm-field' }, h('label', null, 'Preference'),
      seg(PREF.map(function (v) {
        return [v, v === 'not_interested' ? 'Not interested' : v.charAt(0).toUpperCase() + v.slice(1)];
      }), val('relationship_preference', 'monogamous'), function (v) { set('relationship_preference', v); })));

    var n = Object.keys(patch()).length;
    var save = h('button', {
      class: 'sm-btn save', type: 'button',
      disabled: (!n || st.busy) ? true : null,
      onClick: function (e) { e.stopPropagation(); commit(); },
    }, st.busy ? '…' : 'Save');
    el.append(h('div', { class: 'sm-commit' },
      /* "Saved" would be a lie when the read never landed — nothing was ever
         loaded to save. Say what is actually true of each state. */
      h('span', { class: 'msg' + (n ? ' dirty' : '') },
        st.busy ? 'Saving…'
          : n ? (n + ' change' + (n === 1 ? '' : 's') + ' not saved')
          : st.loadErr ? 'Nothing loaded — edit a field and Save.'
          : st.loading ? 'Reading her profile…'
          : 'Saved — live from her next line.'),
      save));

    body.scrollTop = keep;
    clamp();
  }

  /* Pull the panel back on screen after it has been MEASURED.
   *
   * open() has to place it before it has any content, so it guesses a height;
   * the real one depends on how much profile there is (and changes again when
   * a flag reveals the price field). Guessing 560 against an actual 788 put it
   * 108px off the bottom of the overlay. So: never trust the guess — measure
   * the laid-out box and clamp. max-height keeps it ≤ the overlay, so a clamped
   * position always fits.
   *
   * Measured with offsetWidth/Height rather than getBoundingClientRect: the
   * panel opens under `animation: smIn` which includes scale(.98), and the
   * rect reports the TRANSFORMED box — clamping against that mid-animation
   * leaves it a few px out once it settles. The layout box is
   * transform-independent and already final. (Same trap the member menu's
   * clampCtx documents.)
   */
  /* The panel now also carries transform: scale(--hdts-sharmat) — its own size
     control (hd-scale.js). transform-origin is top left, so style.left/top
     still place the painted corner exactly; only the SIZE differs from the
     layout box, by exactly the scale. Every clamp below therefore measures the
     layout box and multiplies. Reading the computed variable rather than asking
     HDScale keeps this honest even in a harness that loads no hd-scale.js. */
  function popScale() {
    var v = 0;
    try {
      v = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--hdts-sharmat'));
    } catch (e) { v = 0; }
    return (isFinite(v) && v > 0) ? v : 1;
  }

  function clamp() {
    if (!el) return;
    var host = document.getElementById('overlay');
    var r = host ? host.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    if (!(r.width > 0 && r.height > 0)) return;      // hidden: nothing to clamp against
    var sc = popScale();
    var w = el.offsetWidth * sc, hh = el.offsetHeight * sc;
    var x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    if (x + w > r.width - 6) x = r.width - w - 6;
    if (y + hh > r.height - 6) y = r.height - hh - 6;
    el.style.left = Math.max(6, x) + 'px';
    el.style.top = Math.max(6, y) + 'px';
  }

  /* Drag by the header, exactly like the member menu: dragging from anywhere
     would fight the inputs, the buttons and the internal scroll. */
  function makeDraggable(head) {
    head.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !el) return;
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY;
      var bx = parseFloat(el.style.left) || 0, by = parseFloat(el.style.top) || 0;
      function move(ev) {
        var host = document.getElementById('overlay');
        var r = host ? host.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
        var sc = popScale();
        var w = el.offsetWidth * sc, hh = el.offsetHeight * sc;
        el.style.left = Math.min(Math.max(6, bx + ev.clientX - sx), Math.max(6, r.width - w - 6)) + 'px';
        el.style.top = Math.min(Math.max(6, by + ev.clientY - sy), Math.max(6, r.height - hh - 6)) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  /* --------------------------------------------------------- lifecycle --- */

  /* `face` is { file, mtime, hue } as already resolved by the Followers pane.
     Passed in rather than re-derived: the name->slug rule has three
     implementations already (pane, portal, README) and a fourth would be one
     more place for them to drift. Omit it and the header shows initials. */
  function open(chimName, label, face) {
    var keepStyles = st.styles;      // catalog is session-wide, not per-NPC
    close();
    st.open = true;
    st.styles = keepStyles;
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

    el = h('div', { class: 'sm-pop' });
    // Centre-ish in the overlay, then let the user drag it wherever.
    var host = document.getElementById('overlay') || document.body;
    host.appendChild(el);
    var r = host.getBoundingClientRect();
    /* 420x560 is the panel's PAINTED size at 100%; at any other size control
       setting it paints that times the scale, so centring has to use the same
       number the eye does. clamp() below still has the last word. */
    var sc0 = popScale();
    el.style.left = Math.max(6, Math.round((r.width - 420 * sc0) / 2)) + 'px';
    el.style.top = Math.max(6, Math.round((r.height - 560 * sc0) / 2)) + 'px';

    render();
    load();
  }

  function close() {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
    st.open = false;
    pending = {};        // abandon any in-flight reply
  }

  function isOpen() { return st.open; }

  /* Esc closes the popout BEFORE the deck acts on it, so the palette does not
     close out from under an open profile. */
  function onKey(e) {
    if (!st.open) return false;
    if (e.key === 'Escape') {
      /* Same rule as the ✕: Escape on unsaved edits ARMS, it does not
         discard. Esc is a reflex, and the prompt box holds typed prose. */
      if (dirty() && !st.armedClose) {
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
  };
})();
